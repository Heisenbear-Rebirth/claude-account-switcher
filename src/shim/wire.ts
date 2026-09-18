/**
 * Minimal wire types for the two protocols the shim bridges.
 *
 * Only the fields the shim actually reads are modelled; everything else is passed through or
 * ignored. Kept separate from `../types.ts`, which describes this extension's own stored state.
 */

// ── Anthropic Messages API (what Claude Code speaks) ────────────────────────

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text?: string }>;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
  stream?: boolean;
  thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };
  metadata?: Record<string, unknown>;
}

// ── OpenAI Responses API (what the upstream speaks) ─────────────────────────

export interface ReasoningItem {
  type: "reasoning";
  /** Present on items we received; omitted on items we replay. */
  id?: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  /**
   * Opaque blob carrying the model's chain of thought. Must be echoed back verbatim — never
   * trimmed, re-encoded or summarised — or the upstream silently loses the reasoning state.
   */
  encrypted_content?: string | null;
}

export type ResponseMessageContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export type ResponseItem =
  | ReasoningItem
  | { type: "message"; role: "user" | "assistant" | "developer"; content: ResponseMessageContent[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

/** Effort levels the Responses API accepts. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
