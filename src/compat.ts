import { AccountProfile } from "./types";

export const OAUTH_COMPAT_KEY = "anthropic-oauth";

/**
 * Conversation compatibility.
 *
 * A Claude Code transcript replays every prior assistant turn, including `thinking` blocks that
 * carry a cryptographic `signature`, and Claude Code does not strip them when the endpoint
 * changes. Replaying them against a different endpoint therefore either trips
 * `invalid_thinking_signature` / `thinking_blocks_modified` (both are named error classes inside
 * the CLI) or gets them silently dropped, which quietly destroys the reasoning context.
 *
 * Two profiles are safe to swap mid-conversation only when they address the same endpoint with
 * the same model and differ solely by credential — which is exactly what upstream's
 * subscription-account switching has always done, and why it is safe.
 *
 * Model granularity matters, not just the provider: one OpenRouter account can route to
 * completely different model families, and `deepseek-chat` vs `deepseek-reasoner` differ in
 * whether they emit reasoning at all.
 */
export function compatKey(profile: AccountProfile): string {
  const manual = profile.compatGroup?.trim();
  if (manual) {
    return `manual:${manual}`;
  }
  if (profile.kind !== "api" || !profile.provider) {
    // Every Claude subscription talks to the same first-party endpoint with Anthropic-signed
    // thinking blocks, so all OAuth profiles are interchangeable.
    return OAUTH_COMPAT_KEY;
  }
  const url = normalizeBaseUrl(profile.provider.baseUrl);
  const model = normalizeModel(profile.provider.model);
  return `${url}|${model}`;
}

export function isCompatible(a: AccountProfile, b: AccountProfile): boolean {
  return compatKey(a) === compatKey(b);
}

/** Lowercases the host, drops a default port and any trailing slashes. Path is significant. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    const u = new URL(trimmed);
    const port =
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80")
        ? ""
        : u.port;
    const host = port ? `${u.hostname}:${port}` : u.hostname;
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${pathname}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * A `[1m]` suffix selects a different context window, so it is kept as part of the identity —
 * continuing a long conversation after dropping from 1M to the standard window would overflow.
 */
export function normalizeModel(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().toLowerCase();
  return trimmed || "(default)";
}

/** Short human-readable name for a compatibility group, used for badges and warnings. */
export function compatLabel(profile: AccountProfile): string {
  const manual = profile.compatGroup?.trim();
  if (manual) {
    return manual;
  }
  if (profile.kind !== "api" || !profile.provider) {
    return "Claude subscription";
  }
  let host: string;
  try {
    host = new URL(profile.provider.baseUrl).hostname;
  } catch {
    host = profile.provider.baseUrl || "unknown";
  }
  const model = profile.provider.model?.trim();
  return model ? `${host} · ${model}` : host;
}

/**
 * Finds the provider profile that a pinned `env` block corresponds to.
 *
 * When settings.json pins a base URL, that — not `.credentials.json` — is what Claude Code will
 * actually use, so it is the authority on which profile is active. Subscription credentials are
 * deliberately left in place when switching to a provider, so the credentials file alone would
 * otherwise point at the wrong profile.
 */
export function findProfileForEnv(
  profiles: readonly AccountProfile[],
  baseUrl: string | undefined,
  model: string | undefined,
  activeId?: string
): AccountProfile | undefined {
  if (!baseUrl?.trim()) {
    return undefined;
  }
  const wantedUrl = normalizeBaseUrl(baseUrl);

  // A profile routed through the loopback shim pins the shim's own address, not the provider's, so
  // settings.json alone cannot say *which* shim profile is live. The recorded active id is the only
  // thing that can, and it is still cross-checked against what the pin implies.
  if (isLoopback(wantedUrl)) {
    const shimProfiles = profiles.filter(
      (p) => p.kind === "api" && p.provider?.wireFormat === "openaiResponses"
    );
    if (shimProfiles.length === 0) {
      return undefined;
    }
    const recorded = shimProfiles.find((p) => p.id === activeId);
    if (recorded) {
      return recorded;
    }
    const wantedModel = normalizeModel(model);
    return (
      shimProfiles.find((p) => normalizeModel(p.provider?.model) === wantedModel) ?? shimProfiles[0]
    );
  }

  const candidates = profiles.filter(
    (p) =>
      p.kind === "api" &&
      p.provider?.wireFormat !== "openaiResponses" &&
      normalizeBaseUrl(p.provider?.baseUrl ?? "") === wantedUrl
  );
  if (candidates.length <= 1) {
    return candidates[0];
  }
  const wantedModel = normalizeModel(model);
  return candidates.find((p) => normalizeModel(p.provider?.model) === wantedModel) ?? candidates[0];
}

/**
 * Assigns each distinct compatibility key a stable small index, so the panel can colour-code
 * which cards are interchangeable.
 */
export function compatGroupIndexes(profiles: readonly AccountProfile[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of profiles) {
    const key = compatKey(p);
    if (!out.has(key)) {
      out.set(key, out.size);
    }
  }
  return out;
}

/** True for the addresses the bundled shim can bind to. */
function isLoopback(normalizedUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(normalizedUrl);
}
