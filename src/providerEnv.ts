import { AccountProfile, ProviderConfig } from "./types";

/**
 * Env vars this extension owns. Anything in this list is rewritten on every switch and stripped
 * when switching back to a subscription profile. Nothing outside this list (plus a profile's own
 * `extraEnv` keys) is ever touched, so hand-written entries in settings.json survive.
 *
 * Names verified against the Claude Code 2.1.x binary.
 */
export const CORE_MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * Builds the env block for an API profile.
 *
 * `extraEnv` is applied first so the core variables always win; that ordering is what lets a
 * preset carry `ANTHROPIC_API_KEY: ""` (OpenRouter requires the key to be explicitly blank)
 * without any risk of blanking the credential we are actually authenticating with.
 *
 * Empty string values are preserved deliberately — for Claude Code, "set to empty" and "not set"
 * are different states.
 */
export function buildProviderEnv(
  provider: ProviderConfig,
  apiKey: string
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [k, v] of Object.entries(provider.extraEnv ?? {})) {
    const key = k.trim();
    if (key) {
      env[key] = v;
    }
  }

  env.ANTHROPIC_BASE_URL = provider.baseUrl.trim();

  if (provider.authStyle === "apiKey") {
    env.ANTHROPIC_API_KEY = apiKey;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  }

  setIfPresent(env, "ANTHROPIC_MODEL", provider.model);
  setIfPresent(env, "ANTHROPIC_SMALL_FAST_MODEL", provider.smallFastModel);
  setIfPresent(env, "ANTHROPIC_DEFAULT_OPUS_MODEL", provider.opusModel);
  setIfPresent(env, "ANTHROPIC_DEFAULT_SONNET_MODEL", provider.sonnetModel);
  setIfPresent(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL", provider.haikuModel);
  setIfPresent(env, "CLAUDE_CODE_SUBAGENT_MODEL", provider.subagentModel);

  return env;
}

/** Every key a given profile would write, so a later switch can clear exactly those. */
export function managedKeysFor(profile: AccountProfile): string[] {
  const extra = Object.keys(profile.provider?.extraEnv ?? {})
    .map((k) => k.trim())
    .filter(Boolean);
  return unique([...CORE_MANAGED_ENV_KEYS, ...extra]);
}

/**
 * Keys to delete when applying `next`: everything we are known to have written before, plus the
 * core set (so a lost bookkeeping state still cannot leave a stale provider pinned), minus
 * whatever the new env actually sets.
 */
export function keysToClear(
  previouslyApplied: readonly string[],
  next: Record<string, string>
): string[] {
  const keep = new Set(Object.keys(next));
  return unique([...CORE_MANAGED_ENV_KEYS, ...previouslyApplied]).filter((k) => !keep.has(k));
}

/** Masks credential-bearing values so an env map can be shown or logged safely. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const secret = new Set(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = secret.has(k) && v ? maskSecret(v) : v;
  }
  return out;
}

export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function setIfPresent(
  env: Record<string, string>,
  key: string,
  value: string | undefined
): void {
  const trimmed = value?.trim();
  if (trimmed) {
    env[key] = trimmed;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
