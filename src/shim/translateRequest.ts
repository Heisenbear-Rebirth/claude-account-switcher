import { ReasoningStore } from "./reasoningStore";
import {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  ReasoningEffort,
  ReasoningItem,
  ResponseItem,
  ResponseMessageContent,
  ResponsesTool,
} from "./wire";

/**
 * Anthropic Messages request -> OpenAI Responses request.
 *
 * The item-shaping rules follow aryan877/claude-proxy (MIT), which mirrors what the real Codex CLI
 * puts on the wire; the reasoning placement is ours (see `ReasoningStore`).
 */

export interface TranslateOptions {
  /** Upstream model id, after any `provider:model@effort` decoration has been stripped. */
  model: string;
  store: ReasoningStore;
  /**
   * Explicit pin from a `model@effort` suffix. Overrides the client, because it is the only way to
   * ask for a level the client cannot express — `max`, which Claude Code's own ladder stops short of.
   */
  effortOverride?: ReasoningEffort;
  /** Used only when neither a pin nor the client says anything. */
  defaultEffort?: ReasoningEffort;
  /** Set when the caller wants reasoning summaries surfaced as Anthropic thinking blocks. */
  reasoningSummary?: "auto" | "detailed" | "concise";
}

export interface ResponsesRequest {
  model: string;
  input: ResponseItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: unknown;
  parallel_tool_calls: boolean;
  reasoning: { effort: ReasoningEffort; summary?: string };
  store: false;
  stream: true;
  include: string[];
  max_output_tokens?: number;
}

export function buildResponsesRequest(
  body: AnthropicRequest,
  opts: TranslateOptions
): ResponsesRequest {
  const injections = opts.store.injectionsFor(body.messages);
  const request: ResponsesRequest = {
    model: opts.model,
    input: toResponsesInput(body.messages, injections),
    instructions: systemText(body.system),
    tools: toResponsesTools(body.tools),
    tool_choice: toResponsesToolChoice(body.tool_choice),
    parallel_tool_calls: false,
    reasoning: {
      effort: effortFor(body, opts.defaultEffort, opts.effortOverride),
      ...(opts.reasoningSummary ? { summary: opts.reasoningSummary } : {}),
    },
    // `store: false` keeps the upstream stateless, which is what makes `encrypted_content` the
    // carrier of reasoning state — and `include` is what makes the upstream emit it at all.
    store: false,
    // Always stream upstream, whatever the client asked for. A non-streaming request holds a
    // pooled upstream account open with no bytes flowing, which relay operators reject outright;
    // a client that wants one JSON body gets it by aggregating this stream locally instead.
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) {
    request.max_output_tokens = body.max_tokens;
  }
  if (!request.tools?.length) {
    delete request.tools;
    delete request.tool_choice;
  }
  if (!request.instructions) {
    delete request.instructions;
  }
  return request;
}

/**
 * Flattens the Anthropic history into Responses items, placing each turn's cached reasoning
 * immediately before the assistant message it produced.
 */
export function toResponsesInput(
  messages: AnthropicMessage[],
  injections: Map<number, ReasoningItem[]> = new Map()
): ResponseItem[] {
  const out: ResponseItem[] = [];

  for (let i = 0; i < messages.length; i++) {
    for (const item of injections.get(i) ?? []) {
      // Replayed verbatim. `id` is dropped because it belongs to the response that created it.
      out.push({
        type: "reasoning",
        summary: item.summary,
        encrypted_content: item.encrypted_content,
      });
    }

    const m = messages[i];
    if (typeof m.content === "string") {
      out.push({
        type: "message",
        role: toInputRole(m.role),
        content: [
          m.role === "assistant"
            ? { type: "output_text", text: m.content }
            : { type: "input_text", text: m.content },
        ],
      });
      continue;
    }

    const inline: ResponseMessageContent[] = [];
    const trailing: ResponseItem[] = [];
    for (const block of m.content) {
      appendBlock(block, m.role, inline, trailing);
    }
    if (inline.length) {
      out.push({ type: "message", role: toInputRole(m.role), content: inline });
    }
    out.push(...trailing);
  }

  return out;
}

function appendBlock(
  block: AnthropicContentBlock,
  role: "user" | "assistant",
  inline: ResponseMessageContent[],
  trailing: ResponseItem[]
): void {
  switch (block.type) {
    case "text":
      if (block.text) {
        inline.push(
          role === "assistant"
            ? { type: "output_text", text: block.text }
            : { type: "input_text", text: block.text }
        );
      }
      return;
    case "image":
      inline.push({ type: "input_image", image_url: imageUrlFor(block) });
      return;
    case "tool_use":
      trailing.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
      });
      return;
    case "tool_result":
      trailing.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: stringifyToolResult(block.content),
      });
      return;
    case "thinking":
    case "redacted_thinking":
      // Dropped on purpose. Claude Code replays these every turn, but an Anthropic signature is
      // not reusable Codex reasoning state; the real state comes from the ReasoningStore. Echoing
      // them would also inflate a long session's prompt for no benefit.
      return;
  }
}

function imageUrlFor(block: Extract<AnthropicContentBlock, { type: "image" }>): string {
  const src = block.source;
  return src.type === "base64" ? `data:${src.media_type};base64,${src.data}` : src.url;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((c) =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: string }).text ?? "")
          : null
      )
      .filter((t): t is string => t !== null);
    if (texts.length) {
      return texts.join("\n");
    }
  }
  return JSON.stringify(content ?? "");
}

function toInputRole(role: "user" | "assistant"): "user" | "assistant" {
  return role;
}

export function toResponsesTools(tools?: AnthropicTool[]): ResponsesTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    // The Responses API requires an object schema; a tool with no inputs still needs one.
    parameters: normalizeSchema(t.input_schema),
    strict: false,
  }));
}

function normalizeSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const out = { ...schema };
  if (!out.type) {
    out.type = "object";
  }
  if (out.type === "object" && !out.properties) {
    out.properties = {};
  }
  return out;
}

export function toResponsesToolChoice(choice?: { type: string; name?: string }): unknown {
  if (!choice) {
    return undefined;
  }
  switch (choice.type) {
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return choice.name ? { type: "function", name: choice.name } : "required";
    case "auto":
    default:
      return "auto";
  }
}

export function systemText(system: AnthropicRequest["system"]): string | undefined {
  if (!system) {
    return undefined;
  }
  if (typeof system === "string") {
    return system || undefined;
  }
  const joined = system
    .map((s) => (s.type === "text" ? s.text ?? "" : ""))
    .filter(Boolean)
    .join("\n\n");
  return joined || undefined;
}

/**
 * Resolves the reasoning effort to request upstream.
 *
 * Precedence: an explicit `model@effort` pin, then whatever the client asked for, then the profile's
 * default. Claude Code 2.1.x states its level in `output_config.effort` and sends a *constant*
 * `thinking: {type:"adaptive"}` regardless — verified by capturing real requests across every
 * setting — so reading the budget alone would silently pin one level for every conversation.
 * `budget_tokens` is still honoured for clients that send it (SDK callers, older versions).
 */
export function effortFor(
  body: AnthropicRequest,
  fallback: ReasoningEffort = "medium",
  override?: ReasoningEffort
): ReasoningEffort {
  if (override) {
    return override;
  }

  const stated = normalizeEffort(body.output_config?.effort);
  if (stated) {
    return stated;
  }

  if (body.thinking?.type === "disabled") {
    return "low";
  }

  // Thresholds follow Claude Code's documented budgets for its own ladder.
  const budget = body.thinking?.budget_tokens;
  if (typeof budget === "number" && budget > 0) {
    if (budget <= 4096) {
      return "low";
    }
    if (budget <= 16000) {
      return "medium";
    }
    if (budget <= 40000) {
      return "high";
    }
    return "xhigh";
  }

  return fallback;
}

const EFFORT_LEVELS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Accepts a level only if the upstream ladder has it; an unknown word must not reach the API. */
export function normalizeEffort(value: string | undefined): ReasoningEffort | undefined {
  const v = value?.trim().toLowerCase();
  return v && (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined;
}
