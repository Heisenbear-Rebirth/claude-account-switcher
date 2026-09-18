# Changelog

## 0.4.0

- **OpenAI-format endpoints.** Some gateways never expose Anthropic's `/v1/messages` at all — a
  Codex relay, for instance, answers only on `/v1/responses`. Such an endpoint can now back a
  profile: pick the "OpenAI-format relay / Codex gateway" preset and requests are bridged by a
  loopback shim that runs inside the extension host. No child process and no new runtime
  dependency; the shim binds a port only once a profile that needs it is switched to.
- **Encrypted reasoning survives the bridge.** The Responses API carries a reasoning model's chain
  of thought in an opaque `encrypted_content` blob that has to be replayed verbatim on the next
  turn. Claude Code knows nothing about it — it round-trips Anthropic `thinking` blocks, whose
  signatures mean nothing upstream — so the shim keeps the real state on the side and re-injects it
  beside the assistant turn that produced it. Blobs are stored byte-for-byte; a 4 KB blob was
  verified to arrive back unchanged, markers at both ends intact.
- **Reasoning is addressed by conversation prefix**, not by a hash of the first user turn. The
  reference implementation this was adapted from keyed on the first turn truncated to 4096
  characters; because Claude Code's first turn carries the CLAUDE.md / memory preamble, two
  unrelated conversations in one project could collide and one would receive the other's chain of
  thought. Reproduced, then designed out. Reasoning also accumulates across turns instead of only
  the newest one surviving.
- **Your provider key no longer reaches `settings.json`** for these profiles. The shim holds the
  upstream URL and key; the `env` block gets a loopback address and a token that is useless off this
  machine. Conversation compatibility still keys on the real upstream, so two relays behind the same
  local port are never treated as interchangeable.
- **Transient upstream failures are retried**, up to three attempts, and only while nothing has
  been generated yet. Gateways fronting a shared account pool fail intermittently — a flaky
  prompt-audit service returning 503 is the case this was written for, and against one such relay
  it turned a mostly-failing endpoint into a reliable one. Re-POSTing is safe because the request
  is `store: false`; a 4xx is never retried, and a stream that dies mid-reply is surfaced rather
  than replayed.
- Upstream requests are always streamed, whatever the client asked for. A non-streaming request
  holds a pooled account open with no bytes flowing, which relay operators reject; a client wanting
  one JSON body gets it by aggregating locally instead.

## 0.3.0

Forked from `KrzysztofZander/claude-account-switcher` 0.2.5, with a new extension id so both can be
installed side by side. All upstream behaviour is preserved.

- **API-provider profiles.** Point Claude Code at any Anthropic-compatible endpoint with its own
  API key and models, alongside your existing Claude subscription profiles. Switching rewrites the
  `env` block of `settings.json`; switching back to a subscription strips it again.
- **Built-in presets** for DeepSeek, OpenRouter, Kimi, GLM, Qwen and MiniMax, plus a blank Custom
  entry for self-hosted gateways such as a local Ollama. Base URLs and model names were taken from
  each vendor's own Claude Code documentation.
- **Connection test.** "Say Hi" on a provider profile runs one throwaway turn against the endpoint
  inside an isolated config directory, so a wrong key or model name is caught immediately without
  disturbing the active configuration.
- **Conversation-compatibility guard.** Warns before a switch that would make the current folder's
  conversations unresumable, because transcripts replay signed `thinking` blocks that a different
  endpoint cannot validate. Profiles that differ only by API key are considered compatible and
  never prompt. Coloured dots in the panel show which cards are interchangeable, and a manual
  group can override the automatic (base URL, model) rule. Session files are only ever read.
- Keys are sent as `ANTHROPIC_AUTH_TOKEN` by default, avoiding Claude Code's interactive approval
  prompt for `ANTHROPIC_API_KEY`; the `x-api-key` style remains available.
- Only this extension's own environment variables are written or removed. Other `env` entries and
  every other setting in `settings.json` are preserved, and a malformed file aborts the switch
  instead of being overwritten.
- Independent windows and usage polling understand provider profiles: providers get their own
  `CLAUDE_CONFIG_DIR`, and are never polled against the subscription-only usage endpoint.
- Added a generic Anthropic-format relay/gateway preset, and a per-model note shown in the model
  picker recording whether a model actually returns extended thinking. Measured by inspecting what
  Claude Code persists: through one such gateway, `gpt-6-astra` and `gpt-5.6-terra` yield no
  thinking blocks at any budget, `claude-opus-5` and `deepseek-v4-pro-max` return signed ones, and
  the requested thinking budget is ignored outright.
- Command and configuration namespace moved from `claudeSwitcher.*` to `claudeProviderSwitcher.*`.

## 0.2.5

- Added browser-based OAuth authorization that works without Claude Code CLI.
- Automatically offer browser authorization when the CLI cannot be found.
- Added a dedicated command for browser authorization even when the CLI is available.

## 0.2.4

- Improved authorization reliability for saved accounts by consistently preserving and selecting
  the newest valid access and refresh token generation.
- Added cross-window active-profile leases so background usage polling never spends a rotating
  refresh token currently owned by Claude Code in another VS Code window.
- Propagate successful inactive-profile token rotations to matching credential files with an
  atomic compare-and-swap, preventing stale files from restoring already spent refresh tokens.
- Recover profiles previously marked `invalid_grant` when Claude Code has already persisted a
  newer valid token generation for the same saved profile.
- Reconcile fully rotated active credentials using the verified Claude account identity.

## 0.2.3

- Treat OAuth `invalid_grant` / invalid refresh-token responses as a reauthorization-needed
  state instead of a retryable usage-refresh failure.
- Stop automatic and manual usage refreshes from repeatedly retrying profiles that are already
  known to need reauthorization, reducing repeated "Failed to refresh token" noise.
- Clear stale usage errors and retry backoff automatically when a profile receives fresh
  credentials after reauthorization or a successful token update.
- Use the same per-account lock for Say Hi warmups and usage token refreshes, reducing refresh
  token races between background polling, warmups, and independent VS Code windows.
- Show a short "Needs reauthorization" message in the panel and status tooltip instead of the raw
  token endpoint error payload.

## 0.2.2

- Added independent account windows, Say Hi warmups, and safer cross-window token-refresh locking.
- Added isolated profile reauthorization for broken accounts. The fallback login runs in that
  profile's own `CLAUDE_CONFIG_DIR`, so another active account cannot overwrite it.
- Added account identity checks through `claude auth status --json`; reauthorization is rejected if
  the completed login belongs to a different known profile.
- Hardened credential handling so empty or incomplete OAuth credentials are ignored and never
  written to Claude Code.
- Updated Claude OAuth refresh requests with the current beta header, default Claude Code scopes,
  and clearer local validation before hitting the token endpoint.
- Show the panel's `Auth` action only for profiles that actually need reauthorization.
- Improved CLI discovery, Windows command quoting, and troubleshooting for login and warmup flows.

## 0.2.1

- Fixed token refresh to use the current Claude Code OAuth token endpoint and include saved scopes
  in the refresh request.

## 0.2.0

- Added independent account windows. Each account can now open the current project in a separate
  VS Code window with its own isolated `CLAUDE_CONFIG_DIR` and `.credentials.json`.
- Added "Say Hi" warmups for inactive saved accounts using `claude -p "Hi"` with `haiku` by default,
  without switching the active account.
- Added a login helper command that opens `claude auth login` in an integrated terminal.
- Documented that Claude Code CLI is required for correct operation.
- Documented the privacy and security model: no telemetry, no data collection, no custom backend,
  and credentials are used only locally or with Anthropic/Claude Code endpoints required for the
  selected feature.
- Added Claude Code CLI auto-detection and clearer Say Hi troubleshooting when `claude` is not in
  the VS Code extension host PATH.
- Fixed Windows Say Hi launcher quoting for full `claude.exe` paths.
- Made the active account marker workspace-scoped, so separate VS Code windows can track different
  active accounts independently.
- Added cross-window locking around token refreshes to reduce intermittent login failures from
  rotating refresh tokens.
- Avoided overwriting saved profiles when an unknown account is detected in the credentials file.
- Added settings for the Claude CLI command, Say Hi model, Say Hi prompt, and Say Hi timeout.

## 0.1.0

- Initial release.
- Save the currently logged-in Claude account as a profile (tokens stored in SecretStorage).
- Fast account switching (panel, status bar, QuickPick) by swapping `~/.claude/.credentials.json`,
  with a `.bak` backup and an undo command.
- Live usage limits (5-hour and weekly windows) from the `/api/oauth/usage` endpoint,
  with auto-refresh, backoff on 429, and manual refresh.
- Automatic refresh of expired tokens (refresh token flow).
