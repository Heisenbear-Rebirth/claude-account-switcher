import { ReasoningItem } from "./wire";

/**
 * OpenAI Responses SSE -> Anthropic Messages SSE.
 *
 * The event-by-event state machine is ported from aryan877/claude-proxy (MIT) — notably the
 * tool-call block bookkeeping, which is the fiddly part of this translation and was already
 * debugged there. Two things are ours: output goes to an abstract sink, so the non-streaming case
 * assembles the reply object directly instead of serialising to SSE and parsing it back; and the
 * collected reasoning items are handed to the caller rather than written to a global cache.
 */

/** Where translated Anthropic events go. */
export interface AnthropicSink {
  event(name: string, data: Record<string, unknown>): void;
}

export interface StreamOutcome {
  /** Reasoning items the upstream produced, in arrival order, with blobs untouched. */
  reasoning: ReasoningItem[];
  textChars: number;
  thinkingChars: number;
  toolCalls: number;
}

interface State {
  msgId: string;
  model: string;
  messageStarted: boolean;
  thinkingOpen: boolean;
  textOpen: boolean;
  blockIndex: number;
  funcCallByItemId: Map<string, { blockIndex: number }>;
  reasoning: ReasoningItem[];
  textChars: number;
  thinkingChars: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
}

export class ResponsesTranslator {
  private readonly s: State;

  constructor(
    private readonly sink: AnthropicSink,
    model: string,
    msgId = `msg_${Date.now().toString(36)}`
  ) {
    this.s = {
      msgId,
      model,
      messageStarted: false,
      thinkingOpen: false,
      textOpen: false,
      blockIndex: 0,
      funcCallByItemId: new Map(),
      reasoning: [],
      textChars: 0,
      thinkingChars: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      stopReason: "end_turn",
    };
  }

  /** Feeds one decoded `data:` payload from the upstream stream. */
  handle(json: Record<string, unknown>): void {
    const type = json.type as string | undefined;
    if (!type) {
      return;
    }
    const s = this.s;

    switch (type) {
      case "response.created":
        return;

      case "response.output_text.delta": {
        this.emitText(json.delta as string | undefined);
        return;
      }

      case "response.output_text.done": {
        // Some upstreams only expose the full text in the done event; use it only as a fallback so
        // a normal delta stream is not duplicated.
        const text = json.text as string | undefined;
        if (text && s.textChars === 0) {
          this.emitText(text);
        }
        return;
      }

      case "response.content_part.done": {
        const part = json.part as { type?: string; text?: string } | undefined;
        const text = part?.type === "output_text" || part?.type === "text" ? part.text : "";
        if (text && s.textChars === 0) {
          this.emitText(text);
        }
        return;
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = json.delta as string | undefined;
        if (!delta) {
          return;
        }
        this.openThinking();
        s.thinkingChars += delta.length;
        this.sink.event("content_block_delta", {
          type: "content_block_delta",
          index: s.blockIndex,
          delta: { type: "thinking_delta", thinking: delta },
        });
        return;
      }

      case "response.reasoning_summary_part.added":
        // Paragraph break between summary parts so they stay readable in one thinking block.
        if (s.thinkingOpen) {
          this.sink.event("content_block_delta", {
            type: "content_block_delta",
            index: s.blockIndex,
            delta: { type: "thinking_delta", thinking: "\n\n" },
          });
        }
        return;

      case "response.output_item.added": {
        const item = json.item as
          | { type?: string; id?: string; call_id?: string; name?: string }
          | undefined;
        if (item?.type !== "function_call") {
          return;
        }
        this.ensureStarted();
        this.closeText();
        this.closeThinking();
        const callId = item.call_id || item.id || `call_${Date.now().toString(36)}`;
        s.funcCallByItemId.set(item.id || callId, { blockIndex: s.blockIndex });
        s.toolCalls += 1;
        this.sink.event("content_block_start", {
          type: "content_block_start",
          index: s.blockIndex,
          content_block: { type: "tool_use", id: callId, name: item.name || "", input: {} },
        });
        s.blockIndex += 1;
        s.stopReason = "tool_use";
        return;
      }

      case "response.function_call_arguments.delta": {
        const itemId = (json.item_id || json.id) as string | undefined;
        const delta = json.delta as string | undefined;
        if (!itemId || !delta) {
          return;
        }
        const entry = s.funcCallByItemId.get(itemId);
        if (!entry) {
          return;
        }
        this.sink.event("content_block_delta", {
          type: "content_block_delta",
          index: entry.blockIndex,
          delta: { type: "input_json_delta", partial_json: delta },
        });
        return;
      }

      case "response.function_call_arguments.done":
        // Arguments already arrived as deltas; output_item.done closes the block.
        return;

      case "response.output_item.done": {
        const item = json.item as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              summary?: Array<{ type: string; text: string }>;
              encrypted_content?: string | null;
              content?: Array<{ type?: string; text?: string }>;
            }
          | undefined;
        if (!item) {
          return;
        }
        if (item.type === "function_call") {
          const itemId = item.id || item.call_id || "";
          const entry = s.funcCallByItemId.get(itemId);
          if (entry) {
            this.sink.event("content_block_stop", {
              type: "content_block_stop",
              index: entry.blockIndex,
            });
            s.funcCallByItemId.delete(itemId);
          }
          return;
        }
        if (item.type === "reasoning") {
          // The blob is stored exactly as received. Anything that rewrites, trims or re-encodes it
          // destroys the reasoning state it carries.
          s.reasoning.push({
            type: "reasoning",
            summary: (item.summary ?? []).map((p) => ({
              type: "summary_text" as const,
              text: p.text,
            })),
            encrypted_content: item.encrypted_content ?? null,
          });
          return;
        }
        if (item.type === "message" && s.textChars === 0) {
          const text = (item.content ?? [])
            .map((c) => (c.type === "output_text" || c.type === "text" ? c.text ?? "" : ""))
            .join("");
          this.emitText(text);
        }
        return;
      }

      case "response.completed": {
        const usage = (json.response as { usage?: ResponsesUsage } | undefined)?.usage;
        if (usage) {
          const split = splitInputTokenUsage(
            usage.input_tokens ?? 0,
            usage.input_tokens_details?.cached_tokens ?? 0
          );
          s.inputTokens = split.inputTokens;
          s.cacheReadInputTokens = split.cacheReadInputTokens;
          s.outputTokens = usage.output_tokens ?? 0;
        }
        return;
      }

      case "response.failed":
      case "response.incomplete": {
        const resp = json.response as
          | { error?: { message?: string }; incomplete_details?: { reason?: string } }
          | undefined;
        const reason = resp?.incomplete_details?.reason;
        if (type === "response.incomplete" && reason === "max_output_tokens") {
          s.stopReason = "max_tokens";
          return;
        }
        throw new Error(resp?.error?.message || reason || `upstream returned ${type}`);
      }

      default:
        return;
    }
  }

  /** Emits an error as visible assistant text when the stream dies mid-reply. */
  fail(message: string): void {
    if (this.s.funcCallByItemId.size === 0) {
      this.emitText(message);
    }
  }

  finish(): StreamOutcome {
    const s = this.s;
    this.ensureStarted();
    this.closeThinking();
    this.closeText();
    for (const { blockIndex } of s.funcCallByItemId.values()) {
      this.sink.event("content_block_stop", { type: "content_block_stop", index: blockIndex });
    }
    s.funcCallByItemId.clear();

    this.sink.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: s.stopReason, stop_sequence: null },
      usage: {
        input_tokens: s.inputTokens,
        output_tokens: s.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: s.cacheReadInputTokens,
      },
    });
    this.sink.event("message_stop", { type: "message_stop" });

    return {
      reasoning: s.reasoning,
      textChars: s.textChars,
      thinkingChars: s.thinkingChars,
      toolCalls: s.toolCalls,
    };
  }

  // ── block bookkeeping ────────────────────────────────────────────────────

  private ensureStarted(): void {
    const s = this.s;
    if (s.messageStarted) {
      return;
    }
    s.messageStarted = true;
    this.sink.event("message_start", {
      type: "message_start",
      message: {
        id: s.msgId,
        type: "message",
        role: "assistant",
        model: s.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private openThinking(): void {
    const s = this.s;
    if (s.thinkingOpen) {
      return;
    }
    this.ensureStarted();
    this.closeText();
    s.thinkingOpen = true;
    this.sink.event("content_block_start", {
      type: "content_block_start",
      index: s.blockIndex,
      content_block: { type: "thinking", thinking: "" },
    });
  }

  private closeThinking(): void {
    const s = this.s;
    if (!s.thinkingOpen) {
      return;
    }
    this.sink.event("content_block_stop", { type: "content_block_stop", index: s.blockIndex });
    s.thinkingOpen = false;
    s.blockIndex += 1;
  }

  private openText(): void {
    const s = this.s;
    if (s.textOpen) {
      return;
    }
    this.ensureStarted();
    this.closeThinking();
    s.textOpen = true;
    this.sink.event("content_block_start", {
      type: "content_block_start",
      index: s.blockIndex,
      content_block: { type: "text", text: "" },
    });
  }

  private closeText(): void {
    const s = this.s;
    if (!s.textOpen) {
      return;
    }
    this.sink.event("content_block_stop", { type: "content_block_stop", index: s.blockIndex });
    s.textOpen = false;
    s.blockIndex += 1;
  }

  private emitText(text: string | undefined): void {
    if (!text) {
      return;
    }
    this.openText();
    this.s.textChars += text.length;
    this.sink.event("content_block_delta", {
      type: "content_block_delta",
      index: this.s.blockIndex,
      delta: { type: "text_delta", text },
    });
  }
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/**
 * OpenAI counts cached input tokens *inside* `input_tokens`, while Anthropic's usage schema treats
 * input and cache-read as separate additive buckets. Splitting them stops a client from counting
 * the cached portion twice when it estimates context use.
 */
export function splitInputTokenUsage(
  totalInputTokens: number,
  cachedInputTokens: number
): { inputTokens: number; cacheReadInputTokens: number } {
  const total = Math.max(0, totalInputTokens);
  const cached = Math.min(total, Math.max(0, cachedInputTokens));
  return { inputTokens: total - cached, cacheReadInputTokens: cached };
}

/** Sink that serialises to Anthropic SSE frames. */
export class SseSink implements AnthropicSink {
  constructor(private readonly write: (chunk: string) => void) {}

  event(name: string, data: Record<string, unknown>): void {
    this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * Sink that rebuilds the non-streaming Anthropic reply.
 *
 * Assembling from the event stream directly keeps one source of truth for the translation: a
 * non-streaming client and a streaming one cannot disagree about what the reply was.
 */
export class MessageSink implements AnthropicSink {
  private readonly blocks: Array<Record<string, unknown>> = [];
  private message: Record<string, unknown> = {};
  private stopReason: string | null = null;
  private usage: Record<string, unknown> = {};

  event(name: string, data: Record<string, unknown>): void {
    switch (name) {
      case "message_start":
        this.message = { ...(data.message as Record<string, unknown>) };
        return;
      case "content_block_start": {
        const index = data.index as number;
        this.blocks[index] = { ...(data.content_block as Record<string, unknown>) };
        return;
      }
      case "content_block_delta": {
        const index = data.index as number;
        const delta = data.delta as Record<string, unknown>;
        const block = this.blocks[index];
        if (!block) {
          return;
        }
        if (delta.type === "text_delta") {
          block.text = String(block.text ?? "") + String(delta.text ?? "");
        } else if (delta.type === "thinking_delta") {
          block.thinking = String(block.thinking ?? "") + String(delta.thinking ?? "");
        } else if (delta.type === "input_json_delta") {
          block.__json = String(block.__json ?? "") + String(delta.partial_json ?? "");
        }
        return;
      }
      case "message_delta":
        this.stopReason = ((data.delta as Record<string, unknown>)?.stop_reason as string) ?? null;
        this.usage = (data.usage as Record<string, unknown>) ?? {};
        return;
      default:
        return;
    }
  }

  toMessage(): Record<string, unknown> {
    const content = this.blocks.filter(Boolean).map((b) => {
      if (b.type !== "tool_use") {
        return b;
      }
      const raw = String(b.__json ?? "");
      delete b.__json;
      let input: unknown = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        // A truncated argument stream would otherwise make the whole reply unparseable; surface the
        // fragment instead of throwing so the client sees a tool call it can reject.
        input = { __unparsed_arguments: raw };
      }
      return { ...b, input };
    });

    return {
      ...this.message,
      type: "message",
      role: "assistant",
      content,
      stop_reason: this.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: this.usage,
    };
  }
}
