import { createHash } from "crypto";
import { AnthropicContentBlock, AnthropicMessage, ReasoningItem } from "./wire";

/**
 * Stores the Responses API's encrypted reasoning blobs so they can be replayed on later turns.
 *
 * Claude Code knows nothing about these blobs: it round-trips Anthropic `thinking` blocks, whose
 * signatures are meaningless upstream. So the shim keeps the real reasoning state on the side and
 * re-injects it, which is the only way a multi-step task keeps its chain of thought.
 *
 * Entries are **content-addressed by the conversation prefix that produced them**. After answering
 * a request whose messages were `M`, the reasoning is filed under `fingerprint(M)`. On the next
 * turn the history contains that same `M` followed by the assistant reply, so looking up the prefix
 * ending just before each assistant message recovers exactly the reasoning that produced it — at
 * the right position, for every assistant turn in the history, not just the newest one.
 *
 * This addressing is what avoids three failure modes seen in the reference implementation
 * (aryan877/claude-proxy, MIT), all reproduced with a fake upstream before being designed out:
 *
 *  1. Keying on a hash of only the *first* user turn truncated to 4096 characters. Claude Code's
 *     first turn carries the CLAUDE.md / memory preamble, which alone can exceed that, so two
 *     unrelated conversations in one project collided and one received the other's chain of
 *     thought. A full-prefix fingerprint cannot collide across different histories.
 *  2. Replacing the stored items on every turn, which discarded all reasoning older than the last
 *     response. Keying per prefix accumulates naturally.
 *  3. Injecting every blob at index 0, ahead of the first user message, instead of adjacent to the
 *     assistant turn it belongs to.
 */

interface Entry {
  items: ReasoningItem[];
  lastAccess: number;
}

/** Bounded so a long-lived window cannot grow without limit; reasoning blobs are ~1-3KB each. */
const MAX_ENTRIES = 512;
const TTL_MS = 2 * 60 * 60 * 1000;

export class ReasoningStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries: number = MAX_ENTRIES,
    private readonly ttlMs: number = TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Files the reasoning produced in response to `messages`. */
  remember(messages: AnthropicMessage[], items: ReasoningItem[]): void {
    const usable = items.filter((i) => typeof i.encrypted_content === "string" && i.encrypted_content);
    if (usable.length === 0) {
      return;
    }
    const hashes = prefixFingerprints(messages);
    const key = hashes[hashes.length - 1];
    if (!key) {
      return;
    }
    this.reap();
    this.entries.delete(key); // re-insert so Map iteration order tracks recency
    this.entries.set(key, { items: usable, lastAccess: this.now() });
    this.evict();
  }

  /**
   * Reasoning to replay, keyed by the index of the assistant message it produced.
   *
   * A miss is normal and harmless — a compacted or edited history simply loses continuity rather
   * than sending a blob that belongs to a different exchange.
   */
  injectionsFor(messages: AnthropicMessage[]): Map<number, ReasoningItem[]> {
    this.reap();
    const hashes = prefixFingerprints(messages);
    const out = new Map<number, ReasoningItem[]>();

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== "assistant") {
        continue;
      }
      // The reasoning for assistant message `i` was produced from everything before it.
      const key = i === 0 ? emptyFingerprint() : hashes[i - 1];
      const entry = this.entries.get(key);
      if (entry) {
        entry.lastAccess = this.now();
        out.set(i, entry.items);
      }
    }
    return out;
  }

  /** Test/diagnostic helper. */
  size(): number {
    this.reap();
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private reap(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.lastAccess < cutoff) {
        this.entries.delete(k);
      }
    }
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * `out[i]` = fingerprint of `messages[0..i]`, chained so the whole list costs one pass.
 *
 * Chaining (rather than hashing each prefix from scratch) also means a prefix fingerprint is
 * identical no matter how long the conversation later becomes, which is what lets a turn recorded
 * earlier be found again.
 */
export function prefixFingerprints(messages: AnthropicMessage[]): string[] {
  const out: string[] = [];
  let running = emptyFingerprint();
  for (const m of messages) {
    // NUL separator, written as an escape so the source stays plain text: it cannot occur in
    // the canonicalised message, so no two messages can be split to the same digest.
    running = createHash("sha256")
      .update(running)
      .update("\u0000")
      .update(canonicalize(m))
      .digest("hex");
    out.push(running);
  }
  return out;
}

function emptyFingerprint(): string {
  return createHash("sha256").update("claude-mps/reasoning/v1").digest("hex");
}

/**
 * Stable serialisation of one message.
 *
 * Fields are joined with \u0001, a character that cannot appear in message text, so no two
 * different messages can be serialised to the same string by shifting a boundary.
 *
 * `thinking` and `redacted_thinking` are deliberately excluded: Claude Code replays them with
 * signatures that vary independently of the conversation, and a thinking block that is dropped
 * (for instance after a context trim) must not change the fingerprint of the turn it sat in.
 */
function canonicalize(m: AnthropicMessage): string {
  if (typeof m.content === "string") {
    return `${m.role}\u0001text:${m.content}`;
  }
  const parts: string[] = [m.role];
  for (const b of m.content) {
    parts.push(canonicalizeBlock(b));
  }
  return parts.join("\u0001");
}

function canonicalizeBlock(b: AnthropicContentBlock): string {
  switch (b.type) {
    case "text":
      return `text:${b.text}`;
    case "tool_use":
      return `tool_use:${b.name}:${b.id}:${stableJson(b.input)}`;
    case "tool_result":
      return `tool_result:${b.tool_use_id}:${stableJson(b.content)}`;
    case "image": {
      // Hash image bytes rather than carrying them through the fingerprint chain.
      const src = b.source;
      const material = src.type === "base64" ? `${src.media_type}:${src.data}` : src.url;
      return `image:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
    }
    case "thinking":
    case "redacted_thinking":
      return "";
    default:
      return "";
  }
}

/** Key-sorted JSON so object property order cannot change a fingerprint. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
