import * as http from "http";
import { ReasoningStore, prefixFingerprints } from "../src/shim/reasoningStore";
import {
  buildResponsesRequest,
  effortFor,
  toResponsesInput,
  toResponsesTools,
  toResponsesToolChoice,
} from "../src/shim/translateRequest";
import {
  MessageSink,
  ResponsesTranslator,
  SseSink,
  splitInputTokenUsage,
} from "../src/shim/translateStream";
import { OpenAiShim, normalizeBase, splitModel, sseData } from "../src/shim/server";
import { compatKey, findProfileForEnv } from "../src/compat";
import { AccountProfile } from "../src/types";
import { AnthropicMessage, ReasoningItem } from "../src/shim/wire";

type Check = (name: string, cond: boolean) => void;

const blob = (tag: string, n: number) =>
  `ENC-${tag}-START|` + tag.repeat(Math.ceil(n / tag.length)).slice(0, n) + `|ENC-${tag}-END`;

const reasoning = (tag: string, n = 2000): ReasoningItem => ({
  type: "reasoning",
  summary: [{ type: "summary_text", text: `summary ${tag}` }],
  encrypted_content: blob(tag, n),
});

const user = (text: string): AnthropicMessage => ({ role: "user", content: text });
const assistant = (text: string): AnthropicMessage => ({ role: "assistant", content: text });

export async function runShimTests(check: Check): Promise<void> {
  reasoningStoreTests(check);
  activeResolutionTests(check);
  requestTranslationTests(check);
  streamTranslationTests(check);
  serverUnitTests(check);
  await endToEndTests(check);
}

// ── ReasoningStore ─────────────────────────────────────────────────────────

function reasoningStoreTests(check: Check): void {
  console.log("Shim / reasoning store:");

  {
    const store = new ReasoningStore();
    const turn1 = [user("Q1")];
    const item = reasoning("T1", 4000);
    store.remember(turn1, [item]);

    const history = [user("Q1"), assistant("A1"), user("Q2")];
    const injections = store.injectionsFor(history);
    const got = injections.get(1)?.[0];

    check("reasoning is recovered on the next turn", Boolean(got));
    check(
      "encrypted blob survives byte-for-byte",
      got?.encrypted_content === item.encrypted_content
    );
    check(
      "blob is not truncated at either end",
      (got?.encrypted_content ?? "").startsWith("ENC-T1-START|") &&
        (got?.encrypted_content ?? "").endsWith("|ENC-T1-END")
    );
    check(
      "reasoning is keyed to the assistant turn it produced, not index 0",
      injections.has(1) && !injections.has(0) && !injections.has(2)
    );
  }

  {
    // Two assistant turns must each keep their own reasoning; the older one must not be discarded.
    const store = new ReasoningStore();
    store.remember([user("Q1")], [reasoning("T1")]);
    store.remember([user("Q1"), assistant("A1"), user("Q2")], [reasoning("T2")]);

    const history = [user("Q1"), assistant("A1"), user("Q2"), assistant("A2"), user("Q3")];
    const injections = store.injectionsFor(history);
    check(
      "reasoning accumulates across turns instead of being replaced",
      injections.get(1)?.[0].encrypted_content === blob("T1", 2000) &&
        injections.get(3)?.[0].encrypted_content === blob("T2", 2000)
    );
  }

  {
    // The exact failure reproduced against the reference implementation: two conversations whose
    // first user turn shares a long identical preamble (Claude Code's CLAUDE.md / memory block).
    const preamble = "PREAMBLE-LINE ".repeat(400); // ~5600 chars, well past a 4096-char slice
    const store = new ReasoningStore();
    store.remember([user(preamble + "conversation A")], [reasoning("AAA")]);

    const conversationB = [
      user(preamble + "conversation B"),
      assistant("B reply"),
      user("B second turn"),
    ];
    const leaked = store.injectionsFor(conversationB).get(1);
    check(
      "a shared 4096-char preamble does not leak reasoning between conversations",
      leaked === undefined
    );

    const conversationA = [
      user(preamble + "conversation A"),
      assistant("A reply"),
      user("A second turn"),
    ];
    check(
      "the conversation that produced the reasoning still finds it",
      store.injectionsFor(conversationA).get(1)?.[0].encrypted_content === blob("AAA", 2000)
    );
  }

  {
    // Claude Code replays thinking blocks whose signatures vary; that must not move the fingerprint.
    const store = new ReasoningStore();
    store.remember([user("Q1")], [reasoning("T1")]);
    const withThinking: AnthropicMessage[] = [
      user("Q1"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "visible summary", signature: "whatever-signature" },
          { type: "text", text: "A1" },
        ],
      },
      user("Q2"),
    ];
    check(
      "a replayed thinking block does not change the fingerprint",
      store.injectionsFor(withThinking).get(1)?.[0].encrypted_content === blob("T1", 2000)
    );
  }

  {
    const store = new ReasoningStore();
    store.remember([user("Q1")], [{ type: "reasoning", summary: [], encrypted_content: null }]);
    check("an item with no encrypted blob is not stored", store.size() === 0);
  }

  {
    let clock = 1_000_000;
    const store = new ReasoningStore(512, 1000, () => clock);
    store.remember([user("Q1")], [reasoning("T1")]);
    check("entry is present before the TTL elapses", store.size() === 1);
    clock += 5000;
    check("entry is reaped after the TTL elapses", store.size() === 0);
  }

  {
    const store = new ReasoningStore(2, 60_000);
    store.remember([user("Q1")], [reasoning("A")]);
    store.remember([user("Q2")], [reasoning("B")]);
    store.remember([user("Q3")], [reasoning("C")]);
    check("the entry cap evicts the oldest", store.size() === 2);
    check(
      "the oldest conversation is the one dropped",
      store.injectionsFor([user("Q1"), assistant("x"), user("y")]).size === 0 &&
        store.injectionsFor([user("Q3"), assistant("x"), user("y")]).size === 1
    );
  }

  {
    const a = prefixFingerprints([user("one"), assistant("two")]);
    const b = prefixFingerprints([user("one"), assistant("two"), user("three")]);
    check("prefix fingerprints are stable as the conversation grows", a[0] === b[0] && a[1] === b[1]);
    check(
      "different histories fingerprint differently",
      prefixFingerprints([user("x")])[0] !== prefixFingerprints([user("y")])[0]
    );
  }
}

// ── request translation ────────────────────────────────────────────────────

function requestTranslationTests(check: Check): void {
  console.log("Shim / request translation:");

  {
    const injections = new Map([[1, [reasoning("T1", 100)]]]);
    const input = toResponsesInput([user("Q1"), assistant("A1"), user("Q2")], injections);
    const order = input.map((i) => (i.type === "message" ? `message:${i.role}` : i.type));
    check(
      "item order is user, reasoning, assistant, user",
      order.join(",") === "message:user,reasoning,message:assistant,message:user"
    );
  }

  {
    const input = toResponsesInput([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "s" },
          { type: "redacted_thinking", data: "d" },
          { type: "text", text: "hello" },
        ],
      },
    ]);
    check(
      "thinking and redacted_thinking are dropped from the upstream input",
      input.length === 1 &&
        input[0].type === "message" &&
        JSON.stringify(input[0]).includes("hello") &&
        !JSON.stringify(input).includes("redacted")
    );
  }

  {
    const input = toResponsesInput([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body" }],
      },
    ]);
    check(
      "tool_use becomes function_call with the same call id",
      input[0].type === "function_call" && (input[0] as { call_id: string }).call_id === "call_1"
    );
    check(
      "tool_result becomes function_call_output",
      input[1].type === "function_call_output" &&
        (input[1] as { output: string }).output === "file body"
    );
  }

  {
    const store = new ReasoningStore();
    const req = buildResponsesRequest(
      { model: "gpt-6-astra", messages: [user("hi")], max_tokens: 4096 },
      { model: "gpt-6-astra", store }
    );
    check("upstream request is always streamed", req.stream === true);
    check("upstream request is always stateless", req.store === false);
    check(
      "encrypted reasoning is always requested",
      req.include.includes("reasoning.encrypted_content")
    );
    check("tools are omitted when the client sent none", req.tools === undefined);
    check("max_tokens maps to max_output_tokens", req.max_output_tokens === 4096);
  }

  {
    check("thinking disabled floors effort at low", effortFor({ model: "m", messages: [], thinking: { type: "disabled" } }) === "low");
    check("4k budget maps to low", effortFor({ model: "m", messages: [], thinking: { type: "enabled", budget_tokens: 4096 } }) === "low");
    check("12k budget maps to medium", effortFor({ model: "m", messages: [], thinking: { type: "enabled", budget_tokens: 12000 } }) === "medium");
    check("32k budget maps to high", effortFor({ model: "m", messages: [], thinking: { type: "enabled", budget_tokens: 32000 } }) === "high");
    check("a missing budget uses the fallback", effortFor({ model: "m", messages: [] }, "high") === "high");
  }

  {
    const tools = toResponsesTools([{ name: "Ping", description: "d" }]);
    check(
      "a tool with no schema still gets an object schema",
      tools?.[0].parameters.type === "object" && Boolean(tools?.[0].parameters.properties)
    );
    check("tool_choice any becomes required", toResponsesToolChoice({ type: "any" }) === "required");
    check(
      "tool_choice tool names the function",
      JSON.stringify(toResponsesToolChoice({ type: "tool", name: "Read" })) ===
        JSON.stringify({ type: "function", name: "Read" })
    );
  }
}

// ── stream translation ─────────────────────────────────────────────────────

function streamTranslationTests(check: Check): void {
  console.log("Shim / stream translation:");

  {
    const sink = new MessageSink();
    const t = new ResponsesTranslator(sink, "gpt-6-astra");
    t.handle({ type: "response.created" });
    t.handle({ type: "response.reasoning_summary_text.delta", delta: "thinking hard" });
    t.handle({ type: "response.output_text.delta", delta: "Hel" });
    t.handle({ type: "response.output_text.delta", delta: "lo" });
    t.handle({
      type: "response.output_item.done",
      item: { type: "reasoning", id: "rs1", summary: [], encrypted_content: blob("Z", 500) },
    });
    t.handle({
      type: "response.completed",
      response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } },
    });
    const outcome = t.finish();
    const msg = sink.toMessage();
    const content = msg.content as Array<Record<string, unknown>>;

    check("thinking deltas become a thinking block", content[0]?.type === "thinking" && content[0].thinking === "thinking hard");
    check("text deltas are concatenated", content[1]?.type === "text" && content[1].text === "Hello");
    check("the reasoning blob is captured intact", outcome.reasoning[0]?.encrypted_content === blob("Z", 500));
    check(
      "cached input tokens are split out of input_tokens",
      JSON.stringify(msg.usage) ===
        JSON.stringify({ input_tokens: 60, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 })
    );
  }

  {
    const sink = new MessageSink();
    const t = new ResponsesTranslator(sink, "m");
    t.handle({ type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "call_9", name: "Read" } });
    t.handle({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"pa' });
    t.handle({ type: "response.function_call_arguments.delta", item_id: "i1", delta: 'th":"a.ts"}' });
    t.handle({ type: "response.output_item.done", item: { type: "function_call", id: "i1", call_id: "call_9" } });
    t.finish();
    const content = sink.toMessage().content as Array<Record<string, unknown>>;
    check("a streamed tool call reassembles its arguments", JSON.stringify(content[0]?.input) === JSON.stringify({ path: "a.ts" }));
    check("tool_use keeps the upstream call id", content[0]?.id === "call_9");
    check("a tool call sets stop_reason to tool_use", sink.toMessage().stop_reason === "tool_use");
  }

  {
    const sink = new MessageSink();
    const t = new ResponsesTranslator(sink, "m");
    t.handle({ type: "response.output_item.added", item: { type: "function_call", id: "i1", call_id: "c1", name: "X" } });
    t.handle({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"broken' });
    t.finish();
    const content = sink.toMessage().content as Array<Record<string, unknown>>;
    check(
      "truncated tool arguments surface rather than throwing",
      Boolean((content[0]?.input as Record<string, unknown>)?.__unparsed_arguments)
    );
  }

  {
    const frames: string[] = [];
    const t = new ResponsesTranslator(new SseSink((c) => frames.push(c)), "m");
    t.handle({ type: "response.output_text.delta", delta: "hi" });
    t.finish();
    const joined = frames.join("");
    check("the SSE sink emits named Anthropic events", joined.includes("event: message_start") && joined.includes("event: content_block_delta"));
    check("the SSE stream is terminated with message_stop", joined.includes("event: message_stop"));
  }

  {
    let threw = false;
    const t = new ResponsesTranslator(new MessageSink(), "m");
    try {
      t.handle({ type: "response.failed", response: { error: { message: "upstream exploded" } } });
    } catch (e) {
      threw = (e as Error).message === "upstream exploded";
    }
    check("response.failed raises the upstream message", threw);
  }

  {
    const sink = new MessageSink();
    const t = new ResponsesTranslator(sink, "m");
    t.handle({ type: "response.output_text.delta", delta: "partial" });
    t.handle({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } });
    t.finish();
    check("hitting the output cap maps to max_tokens", sink.toMessage().stop_reason === "max_tokens");
  }

  check("splitInputTokenUsage never reports negative input", JSON.stringify(splitInputTokenUsage(10, 50)) === JSON.stringify({ inputTokens: 0, cacheReadInputTokens: 10 }));
}

// ── server units ───────────────────────────────────────────────────────────

function serverUnitTests(check: Check): void {
  console.log("Shim / server units:");

  check("an effort suffix is split off the model", JSON.stringify(splitModel("gpt-6-astra@high")) === JSON.stringify({ model: "gpt-6-astra", effort: "high" }));
  check("an unknown suffix stays part of the model name", splitModel("gpt-4o@weird").model === "gpt-4o@weird");
  check("a Claude model name falls back to the configured model", splitModel("claude-sonnet-5", "gpt-6").model === "gpt-6");
  check("an empty model falls back", splitModel("", "gpt-6").model === "gpt-6");
  check("a non-Claude name is passed through", splitModel("deepseek-v4", "gpt-6").model === "deepseek-v4");

  check("a base without /v1 gets one", normalizeBase("https://x.test") === "https://x.test/v1");
  check("a base with /v1 is left alone", normalizeBase("https://x.test/v1") === "https://x.test/v1");
  check("a trailing slash is trimmed", normalizeBase("https://x.test/v1/") === "https://x.test/v1");
}

// ── end to end, against a fake Responses upstream ──────────────────────────

async function endToEndTests(check: Check): Promise<void> {
  console.log("Shim / end to end:");

  const BLOB1 = blob("E2E1", 4000);
  const BLOB2 = blob("E2E2", 3000);
  const seen: Array<Record<string, unknown>> = [];
  let turn = 0;

  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        seen.push({});
      }
      turn += 1;
      const encrypted = turn === 1 ? BLOB1 : BLOB2;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: "response.created" });
      send({ type: "response.reasoning_summary_text.delta", delta: "pondering" });
      send({
        type: "response.output_item.done",
        item: { type: "reasoning", id: `rs${turn}`, summary: [{ type: "summary_text", text: "pondering" }], encrypted_content: encrypted },
      });
      send({ type: "response.output_text.delta", delta: `ANSWER-${turn}` });
      send({ type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } });
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const shim = new OpenAiShim();
  const endpoint = await shim.start();
  shim.setTarget({ baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "fake", fallbackModel: "gpt-6-astra" });

  const ask = async (messages: AnthropicMessage[], token = endpoint.token) => {
    const r = await fetch(`${endpoint.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "gpt-6-astra", max_tokens: 1024, thinking: { type: "enabled", budget_tokens: 8000 }, messages }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  try {
    const t1 = await ask([user("first question")]);
    const c1 = t1.body.content as Array<Record<string, unknown>>;
    check("a turn through the shim returns an Anthropic message", t1.status === 200 && t1.body.type === "message");
    check("the reply carries a thinking block", c1.some((b) => b.type === "thinking" && b.thinking === "pondering"));
    check("the reply carries the answer text", c1.some((b) => b.type === "text" && b.text === "ANSWER-1"));

    seen.length = 0;
    await ask([user("first question"), assistant("ANSWER-1"), user("second question")]);
    const input = (seen[0]?.input ?? []) as Array<Record<string, unknown>>;
    const items = input.filter((i) => i.type === "reasoning");

    check("turn two replays exactly one reasoning item", items.length === 1);
    check("the replayed blob is byte-identical to what the upstream sent", items[0]?.encrypted_content === BLOB1);
    check(
      "the replayed blob sits before the assistant message, not at index 0",
      input.findIndex((i) => i.type === "reasoning") === 1
    );
    check("the upstream request is stateless and streamed", seen[0]?.store === false && seen[0]?.stream === true);

    const bad = await ask([user("x")], "wrong-token");
    check("a wrong shim token is rejected", bad.status === 401);

    // Switching upstream must not carry reasoning across accounts that cannot decrypt it.
    shim.setTarget({ baseUrl: `http://127.0.0.1:${upstreamPort}/v2`, apiKey: "other", fallbackModel: "gpt-6-astra" });
    shim.setTarget({ baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "fake", fallbackModel: "gpt-6-astra" });
    seen.length = 0;
    await ask([user("first question"), assistant("ANSWER-1"), user("second question")]);
    check(
      "changing the upstream clears cached reasoning",
      ((seen[0]?.input ?? []) as Array<Record<string, unknown>>).filter((i) => i.type === "reasoning").length === 0
    );
  } finally {
    await shim.stop();
    // Force-close keep-alive sockets: a lingering one races with the suite's process.exit and
    // trips a libuv assertion on Windows.
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  }

  // SSE framing, independent of the network.
  const framed = async (chunks: string[]) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(new TextEncoder().encode(c));
        }
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const p of sseData(stream)) {
      out.push(p);
    }
    return out;
  };

  check("a frame split across chunks is reassembled", (await framed(['data: {"a":', '1}\n\n'])).join("") === '{"a":1}');
  check("\\r\\n framing is accepted", (await framed(['data: {"a":1}\r\n\r\n'])).join("") === '{"a":1}');
  check("[DONE] is not yielded", (await framed(["data: [DONE]\n\n"])).length === 0);
  check("multiple data lines in one frame are joined", (await framed(["data: a\ndata: b\n\n"])).join("") === "a\nb");
  check("a trailing frame without a blank line is still yielded", (await framed(['data: {"z":1}'])).join("") === '{"z":1}');
}

// ── active-profile resolution with the shim in the path ────────────────────

function activeResolutionTests(check: Check): void {
  console.log("Shim / active profile resolution:");

  const shimProfile = (id: string, model: string, baseUrl: string): AccountProfile => ({
    id,
    label: id,
    kind: "api",
    provider: { baseUrl, authStyle: "authToken", model, wireFormat: "openaiResponses" },
    addedAt: 0,
    order: 0,
  });
  const directProfile: AccountProfile = {
    id: "direct",
    label: "direct",
    kind: "api",
    provider: { baseUrl: "https://api.deepseek.com/anthropic", authStyle: "authToken", model: "deepseek-chat" },
    addedAt: 0,
    order: 1,
  };

  const a = shimProfile("shim-a", "gpt-6-astra", "https://relay-a.invalid/v1");
  const b = shimProfile("shim-b", "gpt-6", "https://relay-b.invalid/v1");
  const all = [a, b, directProfile];

  // settings.json pins the loopback address, which is identical for every shim profile.
  check(
    "a loopback pin resolves to the recorded active shim profile",
    findProfileForEnv(all, "http://127.0.0.1:41234", "gpt-6-astra", "shim-b")?.id === "shim-b"
  );
  check(
    "without a recorded id it falls back to the pinned model",
    findProfileForEnv(all, "http://127.0.0.1:41234", "gpt-6", undefined)?.id === "shim-b"
  );
  check(
    "a loopback pin never resolves to a direct profile",
    findProfileForEnv([directProfile], "http://127.0.0.1:41234", "deepseek-chat", "direct") === undefined
  );
  check(
    "localhost is recognised as loopback too",
    findProfileForEnv(all, "http://localhost:41234", "gpt-6-astra", "shim-a")?.id === "shim-a"
  );
  check(
    "a direct endpoint still resolves by its real URL",
    findProfileForEnv(all, "https://api.deepseek.com/anthropic", "deepseek-chat")?.id === "direct"
  );
  check(
    "a shim profile is not matched by its upstream URL, which Claude Code never sees",
    findProfileForEnv(all, "https://relay-a.invalid/v1", "gpt-6-astra") === undefined
  );

  // Conversation compatibility must key on the real upstream, or two unrelated relays would look
  // interchangeable just because both sit behind the same loopback port.
  check(
    "compatibility keys on the upstream endpoint, not the shim address",
    compatKey(a) !== compatKey(b)
  );
  check(
    "the same upstream and model stay compatible",
    compatKey(a) === compatKey(shimProfile("shim-a-copy", "gpt-6-astra", "https://relay-a.invalid/v1"))
  );
}
