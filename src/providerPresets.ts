import { AuthStyle } from "./types";

/**
 * Built-in provider presets.
 *
 * Every base URL and model name below was read from the provider's own Claude Code
 * documentation (verified 2026-09-16), not from memory. Providers rename models often — all of
 * these are editable in the wizard, and `custom` covers anything not listed (including a local
 * Ollama or any self-hosted Anthropic-compatible gateway).
 */
export interface ProviderPreset {
  id: string;
  label: string;
  /** Default ANTHROPIC_BASE_URL. */
  baseUrl: string;
  /** Other official endpoints (e.g. mainland-China vs global), offered in the wizard. */
  altBaseUrls?: string[];
  authStyle: AuthStyle;
  /** Model suggestions; the first is used as the default ANTHROPIC_MODEL. */
  models: string[];
  /**
   * Per-model note shown in the picker. Useful for recording things that are invisible until you
   * hit them — most importantly whether a model actually returns extended thinking, since a
   * gateway that silently drops it looks identical to one that never had it.
   */
  modelNotes?: Record<string, string>;
  /** Model used for cheap/background work, when the vendor recommends a different one. */
  haikuModel?: string;
  subagentModel?: string;
  /** Vendor-recommended extra env vars. */
  extraEnv?: Record<string, string>;
  /** Where the user gets a key. */
  keyUrl?: string;
  docsUrl?: string;
  hint?: string;
}

export const CUSTOM_PRESET_ID = "custom";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authStyle: "authToken",
    models: ["deepseek-flash[1m]", "deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    haikuModel: "deepseek-flash",
    subagentModel: "deepseek-flash",
    extraEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432" },
    keyUrl: "https://platform.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/",
    hint: "The [1m] suffix selects the 1M-context variant.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    authStyle: "authToken",
    models: [
      "~anthropic/claude-opus-latest[1m]",
      "~anthropic/claude-sonnet-latest[1m]",
      "~anthropic/claude-haiku-latest",
      "deepseek/deepseek-chat",
    ],
    haikuModel: "~anthropic/claude-haiku-latest",
    // OpenRouter requires ANTHROPIC_API_KEY to be explicitly blank so it does not conflict
    // with the bearer token. An empty value is meaningful here — it must be written, not omitted.
    extraEnv: { ANTHROPIC_API_KEY: "" },
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration",
    hint: "OpenRouter routes to many vendors. Claude Code is only guaranteed against the Anthropic first-party provider — prefer ~anthropic/* models.",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/anthropic",
    altBaseUrls: ["https://api.moonshot.ai/anthropic"],
    authStyle: "authToken",
    models: ["kimi-k3[1m]", "kimi-k3", "kimi-k2.7-code"],
    haikuModel: "kimi-k2.7-code",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    docsUrl: "https://platform.kimi.ai/docs/guide/claude-code-kimi",
    hint: "The base URL must match the platform the key was created on (.cn vs .ai).",
  },
  {
    id: "glm",
    label: "GLM (Zhipu / 智谱)",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    altBaseUrls: ["https://api.z.ai/api/anthropic"],
    authStyle: "authToken",
    models: ["glm-5.2[1m]", "glm-5.2", "glm-4.7"],
    haikuModel: "glm-4.7",
    extraEnv: {
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/claude",
    hint: "GLM-5.2 needs the [1m] suffix to enable the million-token context.",
  },
  {
    id: "qwen",
    label: "Qwen (通义千问 / DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    authStyle: "authToken",
    models: ["qwen3-coder-plus", "qwen3-max", "qwen3.5-plus"],
    keyUrl: "https://bailian.console.aliyun.com",
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/claude-code",
    hint: "Use the model name exactly as shown in the Bailian console.",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.cn/anthropic",
    altBaseUrls: ["https://api.minimax.io/anthropic"],
    authStyle: "authToken",
    models: ["MiniMax-M2"],
    extraEnv: {
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    keyUrl: "https://platform.minimax.io",
    docsUrl: "https://platform.minimax.io/docs/token-plan/claude-code",
    hint: "Use .cn inside mainland China, .io elsewhere.",
  },
  {
    id: "relay",
    label: "Anthropic-format relay / gateway (enter your own URL)",
    // Intentionally blank: relays are usually personal endpoints, so the URL is entered in the
    // wizard and stored with the profile rather than committed to this repo.
    baseUrl: "",
    authStyle: "authToken",
    models: [
      "gpt-6-astra",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-fable-5",
      "deepseek-v4-pro-max",
      "deepseek-v4-pro",
      "deepseek-v4-flash-max",
      "deepseek-v4-flash",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
    // Measured on one such relay (2026-09-16) by inspecting what Claude Code actually wrote into
    // its transcripts, which is the only trustworthy signal. Your gateway may differ - unlisted
    // models were not tested.
    modelNotes: {
      "gpt-6-astra": "measured: no extended thinking at all, at any budget",
      "claude-opus-5": "measured: signed thinking, but the thinking BUDGET is ignored",
      "deepseek-v4-pro-max": "measured: signed thinking (reports as deepseek-v4-pro)",
      "gpt-5.6-terra": "measured: no extended thinking",
    },
    hint:
      "Any Anthropic-format gateway. Thinking support varies per model, and a gateway may ignore " +
      "thinking-budget requests entirely — effort controls then appear to work but change nothing.",
  },
  {
    id: CUSTOM_PRESET_ID,
    label: "Custom / self-hosted (Ollama, LiteLLM, any gateway…)",
    baseUrl: "",
    authStyle: "authToken",
    models: [],
    hint: "Any Anthropic-compatible endpoint. For a local gateway the base URL often looks like http://localhost:4000.",
  },
];

export function getPreset(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined;
}
