/**
 * Raw structure stored in ~/.claude/.credentials.json
 * { "claudeAiOauth": { ... } }
 */
export interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the accessToken expires */
  expiresAt: number;
  /** epoch ms when the refreshToken expires */
  refreshTokenExpiresAt?: number;
  scopes: string[];
  clientId?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface ClaudeAuthIdentity {
  email?: string;
  orgId?: string;
  orgName?: string;
}

export interface CredentialsFile {
  claudeAiOauth: OAuthCreds;
  [key: string]: unknown;
}

/**
 * How a profile authenticates Claude Code.
 * - `oauth`  — a Claude subscription; switching swaps `.credentials.json` (upstream behaviour).
 * - `api`    — a third-party (or direct) API endpoint; switching rewrites the `env` block of
 *              `settings.json`.
 * Absent means `oauth`, so profiles saved by upstream keep working untouched.
 */
export type ProfileKind = "oauth" | "api";

/** Which header the key is sent in. */
export type AuthStyle = "authToken" | "apiKey";

/** Everything needed to point Claude Code at one API endpoint. No secrets here. */
export interface ProviderConfig {
  /** Id of the built-in preset this was created from, or "custom". */
  presetId?: string;
  /** ANTHROPIC_BASE_URL */
  baseUrl: string;
  /**
   * `authToken` -> ANTHROPIC_AUTH_TOKEN (Authorization: Bearer). Default, and the only style that
   * avoids Claude Code's interactive "Use custom API key" approval prompt.
   * `apiKey` -> ANTHROPIC_API_KEY (x-api-key), for endpoints that require it.
   */
  authStyle: AuthStyle;
  /** ANTHROPIC_MODEL — the main model. */
  model?: string;
  /** ANTHROPIC_SMALL_FAST_MODEL — background/cheap work. */
  smallFastModel?: string;
  /** What `/model opus|sonnet|haiku` map to on this endpoint. */
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  /** CLAUDE_CODE_SUBAGENT_MODEL */
  subagentModel?: string;
  /** Escape hatch: any other env var this provider wants (timeouts, custom headers, ...). */
  extraEnv?: Record<string, string>;
  /**
   * Protocol the endpoint actually speaks.
   *
   * Absent or `anthropic` means Claude Code talks to `baseUrl` directly. `openaiResponses` routes
   * through the extension's built-in loopback shim instead, so an OpenAI-only endpoint — a Codex
   * relay, for instance — can still back a profile. With the shim in the path, `baseUrl` and the
   * key are consumed by the shim and never written into settings.json.
   */
  wireFormat?: "anthropic" | "openaiResponses";
  /**
   * Reasoning effort to request when the client implies none (`openaiResponses` only). Claude
   * Code's own thinking budget takes precedence whenever it sends one.
   */
  defaultEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

/** Profile metadata (no secrets) — kept in globalState. */
export interface AccountProfile {
  id: string;
  label: string;
  /** Absent = "oauth", so upstream profiles load unchanged. */
  kind?: ProfileKind;
  /** Set when kind === "api". */
  provider?: ProviderConfig;
  /**
   * Optional manual override for conversation compatibility. Profiles sharing a non-empty
   * compatGroup are treated as interchangeable mid-conversation even if their baseUrl/model differ.
   */
  compatGroup?: string;
  subscriptionType?: string;
  authEmail?: string;
  authOrgId?: string;
  authOrgName?: string;
  addedAt: number;
  order: number;
  /** last read usage snapshot (cached for fast rendering) */
  lastUsage?: UsageSnapshot;
}

/** A single usage window (5h / weekly / opus, etc.) normalized for the UI. */
export interface UsageWindow {
  kind: string;
  label: string;
  /** 0-100 */
  percent: number;
  severity: string;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fetchedAt: number;
  windows: UsageWindow[];
  /** convenience shortcuts for the UI */
  sessionPercent: number | null;
  weeklyPercent: number | null;
  /** set when the request failed */
  error?: string;
  /** earliest time a retry is allowed (epoch ms) — backoff on 429 */
  retryAfter?: number;
}

/** A profile together with its decrypted secrets (for internal operations). */
export interface AccountWithCreds {
  profile: AccountProfile;
  creds: OAuthCreds;
  isActive: boolean;
}
