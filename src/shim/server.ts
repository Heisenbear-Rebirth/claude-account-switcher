import * as crypto from "crypto";
import * as http from "http";
import { ReasoningStore } from "./reasoningStore";
import { buildResponsesRequest } from "./translateRequest";
import { MessageSink, ResponsesTranslator, SseSink } from "./translateStream";
import { AnthropicRequest, ReasoningEffort } from "./wire";

/**
 * Loopback Anthropic Messages endpoint backed by an OpenAI Responses upstream.
 *
 * Runs inside the extension host — no child process, no extra runtime dependency — and exists so a
 * relay that only speaks OpenAI can still be used as a Claude Code provider. Claude Code is pointed
 * at `http://127.0.0.1:<port>`; the upstream URL and key stay here, which also means the real
 * provider credential never has to be written into `settings.json`.
 */

export interface ShimTarget {
  /** Upstream base, with or without a trailing `/v1`. */
  baseUrl: string;
  apiKey: string;
  /** Sent upstream when the client's model name is empty or a Claude placeholder. */
  fallbackModel?: string;
  defaultEffort?: ReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise";
}

export interface ShimEndpoint {
  baseUrl: string;
  /** Bearer token the client must present. Rejects anything else on the loopback port. */
  token: string;
}

/** The part of a published endpoint that can be re-adopted after a restart. */
export interface ShimEndpointParts {
  port: number;
  token: string;
}

const EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export class OpenAiShim {
  private server?: http.Server;
  private target?: ShimTarget;
  private readonly store = new ReasoningStore();
  private token = crypto.randomBytes(24).toString("base64url");
  private port = 0;

  constructor(private readonly log: (msg: string) => void = () => undefined) {}

  get endpoint(): ShimEndpoint | undefined {
    return this.port ? { baseUrl: `http://127.0.0.1:${this.port}`, token: this.token } : undefined;
  }

  setTarget(target: ShimTarget): void {
    const changed =
      this.target?.baseUrl !== target.baseUrl || this.target?.apiKey !== target.apiKey;
    this.target = target;
    if (changed) {
      // Reasoning blobs are only decryptable by the account that produced them, so they must not
      // survive a change of upstream.
      this.store.clear();
    }
  }

  /** Starts if needed and points at `target`. The one call a switch needs. */
  async ensure(target: ShimTarget, adopt?: Partial<ShimEndpointParts>): Promise<ShimEndpoint> {
    const endpoint = await this.start(adopt);
    this.setTarget(target);
    return endpoint;
  }

  /**
   * Starts listening on loopback. Idempotent.
   *
   * `adopt` asks for a specific port and token — the pair already written into settings.json by an
   * earlier switch. Reusing them is what lets a window reload keep working: Claude Code reads that
   * file at launch, and a reload is exactly what a switch asks the user to do, so coming back on a
   * fresh random port would strand the endpoint it had just published. If the port is taken by
   * something else the caller is told the real one and has to republish.
   */
  async start(adopt?: Partial<ShimEndpointParts>): Promise<ShimEndpoint> {
    if (this.server && this.port) {
      return this.endpoint!;
    }
    if (adopt?.token) {
      this.token = adopt.token;
    }
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.fail(res, 500, describe(err));
      });
    });

    // Loopback only: this port accepts requests carrying a provider credential.
    const wanted = adopt?.port && adopt.port > 0 ? adopt.port : 0;
    let bound = await listen(server, wanted);
    if (!bound && wanted !== 0) {
      this.log(`port ${wanted} unavailable, falling back to an ephemeral port`);
      bound = await listen(server, 0);
    }
    if (!bound) {
      throw new Error("could not bind a loopback port for the shim");
    }

    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server = server;
    this.log(`shim listening on 127.0.0.1:${this.port}`);
    return this.endpoint!;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    this.store.clear();
    if (!server) {
      return;
    }
    // `close` alone only stops accepting: an idle keep-alive socket would hold the server open,
    // which on shutdown means blocking VS Code's deactivation on a client that may never return.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, target: this.target?.baseUrl ?? null }));
      return;
    }
    if (req.method !== "POST") {
      this.fail(res, 405, "method not allowed");
      return;
    }
    if (!this.authorized(req)) {
      this.fail(res, 401, "bad shim token", "authentication_error");
      return;
    }
    if (!this.target) {
      this.fail(res, 503, "no upstream configured for the local shim");
      return;
    }

    const body = await readJson(req).catch(() => undefined);
    if (!body) {
      this.fail(res, 400, "request body is not JSON");
      return;
    }

    if (path === "/v1/messages/count_tokens") {
      // Claude Code probes this before long requests. An estimate keeps it working; it is only used
      // to decide when to compact, never for billing.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: estimateTokens(body as AnthropicRequest) }));
      return;
    }
    if (path !== "/v1/messages") {
      this.fail(res, 404, `no shim route for ${path}`);
      return;
    }

    await this.messages(body as AnthropicRequest, res);
  }

  private async messages(body: AnthropicRequest, res: http.ServerResponse): Promise<void> {
    const target = this.target!;
    const { model, effort } = splitModel(body.model, target.fallbackModel);
    const request = buildResponsesRequest(body, {
      model,
      store: this.store,
      defaultEffort: effort ?? target.defaultEffort,
      reasoningSummary: target.reasoningSummary ?? "auto",
    });

    let upstream: Response;
    try {
      upstream = await this.fetchUpstream(target, JSON.stringify(request));
    } catch (err) {
      this.fail(res, 502, `upstream unreachable: ${describe(err)}`, "api_error");
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "<no body>");
      this.fail(res, upstream.status, `upstream ${upstream.status}: ${trim(detail)}`, "api_error");
      return;
    }

    const wantsStream = body.stream === true;
    const sink = wantsStream
      ? new SseSink((chunk) => res.write(chunk))
      : new MessageSink();
    const translator = new ResponsesTranslator(sink, body.model || model);

    if (wantsStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
    }

    let streamError: string | undefined;
    try {
      for await (const payload of sseData(upstream.body)) {
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        translator.handle(json);
      }
    } catch (err) {
      streamError = describe(err);
      translator.fail(`[shim] upstream stream failed: ${streamError}`);
    }

    const outcome = translator.finish();
    if (outcome.reasoning.length) {
      // Filed against the history as sent, so the next turn finds it at the right position.
      this.store.remember(body.messages, outcome.reasoning);
    }
    this.log(
      `shim ${model} text=${outcome.textChars} thinking=${outcome.thinkingChars} ` +
        `tools=${outcome.toolCalls} reasoning=${outcome.reasoning.length}` +
        (streamError ? ` error=${streamError}` : "")
    );

    if (wantsStream) {
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify((sink as MessageSink).toMessage()));
    }
  }

  /**
   * POSTs the upstream request, retrying only while nothing has been generated yet.
   *
   * Gateways in front of a shared account pool fail transiently — a flaky prompt-audit service
   * returning 503 is the case this was written for. Re-POSTing the identical body is safe because
   * the request is `store: false`, so it left no state behind, and a request rejected before
   * generation started cost the pool nothing. Retries stop as soon as bytes are flowing: a stream
   * that dies mid-reply is surfaced to the client instead, since replaying it would double the
   * upstream work for a reply the client has already partly seen.
   */
  private async fetchUpstream(target: ShimTarget, payload: string): Promise<Response> {
    const url = `${normalizeBase(target.baseUrl)}/responses`;
    const attempts = 3;
    let lastStatus = 0;
    let lastBody = "";

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${target.apiKey}`,
            accept: "text/event-stream",
          },
          body: payload,
        });
      } catch (err) {
        if (attempt === attempts) {
          throw err;
        }
        this.log(`upstream connect failed (${attempt}/${attempts}): ${describe(err)}`);
        await delay(attempt * 400);
        continue;
      }

      if (res.ok || !isTransient(res.status) || attempt === attempts) {
        return res;
      }
      lastStatus = res.status;
      lastBody = await res.text().catch(() => "");
      this.log(`upstream ${res.status} (${attempt}/${attempts}), retrying: ${trim(lastBody)}`);
      await delay(attempt * 400);
    }

    // Unreachable in practice; keeps the signature honest.
    return new Response(lastBody, { status: lastStatus || 502 });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const supplied = bearer || (req.headers["x-api-key"] as string | undefined) || "";
    return safeEqual(supplied, this.token);
  }

  private fail(
    res: http.ServerResponse,
    status: number,
    message: string,
    type = "invalid_request_error"
  ): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  }
}

/** Yields each `data:` payload from an SSE byte stream, tolerating any chunk boundary. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; \r\n is tolerated for proxies that rewrite newlines.
    let cut = findFrameEnd(buffer);
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + frameEndLength(buffer, cut));
      const payload = dataOf(frame);
      if (payload && payload !== "[DONE]") {
        yield payload;
      }
      cut = findFrameEnd(buffer);
    }
  }
  const tail = dataOf(buffer);
  if (tail && tail !== "[DONE]") {
    yield tail;
  }
}

function findFrameEnd(buffer: string): number {
  const a = buffer.indexOf("\n\n");
  const b = buffer.indexOf("\r\n\r\n");
  if (a < 0) {
    return b;
  }
  if (b < 0) {
    return a;
  }
  return Math.min(a, b);
}

function frameEndLength(buffer: string, at: number): number {
  return buffer.startsWith("\r\n\r\n", at) ? 4 : 2;
}

/** Concatenates the `data:` lines of one frame, per the SSE spec. */
function dataOf(frame: string): string {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      parts.push(line.slice(5).trimStart());
    }
  }
  return parts.join("\n");
}

/**
 * Splits `model@effort` and falls back when Claude Code sends a Claude model name.
 *
 * A Claude name reaching an OpenAI upstream is always a misconfiguration (an alias the profile did
 * not remap), and forwarding it produces a confusing upstream 404, so the configured model wins.
 */
export function splitModel(
  requested: string | undefined,
  fallback?: string
): { model: string; effort?: ReasoningEffort } {
  const raw = (requested ?? "").trim();
  const at = raw.lastIndexOf("@");
  let name = raw;
  let effort: ReasoningEffort | undefined;

  if (at > 0) {
    const candidate = raw.slice(at + 1).toLowerCase() as ReasoningEffort;
    if (EFFORTS.includes(candidate)) {
      effort = candidate;
      name = raw.slice(0, at);
    }
  }
  if (!name || /^claude[-.]/i.test(name)) {
    name = fallback || name;
  }
  return { model: name, effort };
}

export function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Deliberately crude: ~4 characters per token, enough for compaction decisions. */
function estimateTokens(body: AnthropicRequest): number {
  let chars = JSON.stringify(body.system ?? "").length;
  for (const m of body.messages ?? []) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  chars += JSON.stringify(body.tools ?? []).length;
  return Math.max(1, Math.round(chars / 4));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function trim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** Upstream statuses worth one more attempt: congestion or a flaky dependency, not a bad request. */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Binds one port, resolving false rather than throwing so a fallback can be tried. */
function listen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener("listening", onListening);
      resolve(false);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** Pulls the port out of a loopback base URL this shim previously published. */
export function portFromLoopback(baseUrl: string | undefined): number | undefined {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/i.exec((baseUrl ?? "").trim());
  const port = m ? Number(m[1]) : 0;
  return port > 0 && port < 65536 ? port : undefined;
}
