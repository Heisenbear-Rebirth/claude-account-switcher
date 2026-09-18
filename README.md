# Claude Multi-Provider Switcher

Switch **Claude Code** between your Claude subscription accounts *and* third-party API providers —
DeepSeek, OpenRouter, Kimi, GLM, Qwen, MiniMax, a local Ollama gateway, anything that speaks the
Anthropic Messages API — each with its own API key and models, from one panel in VS Code.

> A fork of [KrzysztofZander/claude-account-switcher](https://github.com/KrzysztofZander/claude-account-switcher)
> (MIT), which does the subscription-account half of this and does it well. This fork adds
> API-provider profiles on top. All upstream behaviour is preserved.
>
> It uses a different extension id from upstream, so the two can be installed side by side. Profiles
> are stored per extension id, so saved accounts do not carry over — save them once here.

## Why

Two problems, one panel:

- **You have several Claude subscriptions.** When one hits its 5-hour or weekly limit, switch to
  another with a click instead of logging out and back in.
- **You want to fall back to a cheaper or different model.** Point Claude Code at DeepSeek or
  OpenRouter with its own key and model, then come back to your subscription — without ever
  hand-editing `settings.json` or juggling shell environment variables.

## Features

**Subscription accounts** (from upstream)

- Save the logged-in account as a profile; tokens live in VS Code's encrypted secret storage
- Fast switching from the panel, status bar, or command palette
- Live usage limits (5-hour and weekly windows) with time until reset
- "Say Hi" warmups, independent account windows, browser authorization, isolated reauthorization

**API providers** (new)

- Add a provider in a five-step wizard; the key is typed into a real password field
- Built-in presets for DeepSeek, OpenRouter, Kimi, GLM, Qwen and MiniMax, plus a blank *Custom*
  entry for self-hosted gateways. Every field stays editable
- **Test connection** — runs one throwaway turn against the endpoint in an isolated config
  directory, so a wrong key or a misspelled model name surfaces immediately instead of at your
  next real prompt
- Independent windows work for providers too: a DeepSeek window and a Claude subscription window
  can run side by side on the same folder
- **Conversation-compatibility guard** — warns before a switch that would make this folder's
  existing conversations unresumable (see below)

## Built-in presets

Base URLs and model names below were taken from each vendor's own Claude Code documentation
(checked 2026-09-16). Vendors rename models often — everything is editable, and the wizard always
lets you type your own.

| Provider | Base URL | Example models |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-flash[1m]`, `deepseek-v4-pro` |
| OpenRouter | `https://openrouter.ai/api` | `~anthropic/claude-opus-latest[1m]` |
| Kimi (Moonshot) | `https://api.moonshot.cn/anthropic` (or `.ai`) | `kimi-k3[1m]`, `kimi-k2.7-code` |
| GLM (Zhipu) | `https://open.bigmodel.cn/api/anthropic` (or `api.z.ai`) | `glm-5.2[1m]`, `glm-4.7` |
| Qwen (DashScope) | `https://dashscope.aliyuncs.com/apps/anthropic` | `qwen3-coder-plus`, `qwen3-max` |
| MiniMax | `https://api.minimax.cn/anthropic` (or `.io`) | `MiniMax-M2` |
| Relay / gateway | you provide it | carries measured thinking notes for common relay models |
| Custom | you provide it | anything Anthropic-compatible |

Pick the base URL matching the console where the key was created — several vendors run separate
mainland-China and global endpoints, and keys are not interchangeable between them.

### Not every model behind a gateway returns thinking

A gateway that speaks the Anthropic protocol does not necessarily carry extended thinking through
to the model behind it, and **a gateway that silently drops it looks exactly like one that never
had it** — same HTTP 200, same text answer, no warning anywhere.

The only reliable check is what Claude Code actually persists. Run a prompt, then look for
`thinking` blocks in the transcript under `~/.claude/projects/<folder>/*.jsonl`. No blocks means
no reasoning is carried into the next turn, no matter what `thinking` or `MAX_THINKING_TOKENS`
you set.

Measured on one Anthropic-format relay (2026-09-16), same prompt, same client:

| Model | `thinking` blocks persisted | Signed |
|---|---|---|
| `gpt-6-astra` | 0 (at budgets 8 000 and 31 999 alike) | — |
| `gpt-5.6-terra` | 0 | — |
| `claude-opus-5` | 2 | yes |
| `deepseek-v4-pro-max` | 1 | yes |

Where a preset records this, the model picker shows it inline. Models that return no thinking are
still perfectly usable — you simply lose reasoning continuity across turns, and raising the
thinking budget does nothing.

### Nor is the thinking budget necessarily honoured

Returning thinking and *respecting how much of it you asked for* are separate questions. On the
same gateway, `claude-opus-5` does return properly signed thinking that survives into the next turn —
but the requested budget is ignored outright. Three streamed runs at each extreme:

| Requested `budget_tokens` | Actual `thinking_tokens` | Mean |
|---|---|---|
| 1 024 | 698, 2 278, 2 849 | 1 942 |
| 24 000 | 333, 640, — | 487 |

The low-budget runs overshot their stated ceiling by up to 2.8×, the high-budget runs came in far
below it, and omitting the `thinking` parameter entirely still produced 2 274 thinking tokens. The
give-away is validation: a real Anthropic endpoint returns `400` when `budget_tokens` ≥ `max_tokens`
or is below the 1 024 minimum, and this gateway answered `200` to both — it is not forwarding the
parameter at all.

Practical consequence: on such a gateway, `/effort`, `effortLevel` and `MAX_THINKING_TOKENS` appear
to work and change nothing. To check your own endpoint, send the same prompt at two very different
budgets and compare `usage.output_tokens_details.thinking_tokens`; if the numbers do not track the
request, the budget is being dropped.


## OpenAI-format endpoints

Not every gateway speaks Anthropic. A Codex relay typically answers only on `/v1/responses`, and
asking it for `/v1/messages` returns a flat refusal — no amount of configuration helps, because the
endpoint simply is not there.

Those endpoints still work here. Choose the **OpenAI-format relay / Codex gateway** preset and the
extension routes Claude Code through a loopback bridge:

```
Claude Code ──Anthropic──► 127.0.0.1:<port> ──OpenAI Responses──► your gateway
```

The bridge runs inside the extension host — no child process, no extra dependency — and binds a port
only once you switch to a profile that needs it.

### Reasoning has to be carried by hand

A reasoning model's chain of thought comes back in an opaque `encrypted_content` blob, and it is
only useful if the *exact* bytes are replayed on the next turn. Claude Code cannot help here: it
round-trips Anthropic `thinking` blocks, whose signatures mean nothing to an OpenAI upstream. So the
bridge keeps the real reasoning on the side and re-injects it next turn, beside the assistant turn
that produced it.

Two details matter enough to spell out, because both are invisible when they go wrong:

- **Blobs are stored byte-for-byte.** Nothing trims, re-encodes or summarises them. A truncated blob
  is not a degraded blob — it is a discarded one, and the only symptom is that answers quietly get
  worse.
- **Reasoning is addressed by the conversation prefix that produced it.** The obvious shortcut —
  hashing the first user message — breaks badly here, because Claude Code's first turn carries the
  CLAUDE.md and memory preamble. Two unrelated conversations in the same project can share that
  preamble for thousands of characters, land in the same slot, and feed each other's chain of
  thought. A full-prefix fingerprint cannot collide, and it also lets every assistant turn in the
  history keep its own reasoning rather than only the newest.

### Your key stays out of settings.json

For these profiles the bridge holds the upstream URL and key, so the `env` block contains a loopback
address and a token that is worthless anywhere else. Conversation compatibility still keys on the
real upstream, so two different relays behind the same local port are never treated as
interchangeable mid-conversation.

### Transient failures are retried

A gateway sharing one account pool between users fails intermittently in ways a direct API does not
— one relay tested here returns 503 from its prompt-audit service often enough to look broken. The
bridge retries up to three times, but only while nothing has been generated yet: re-sending is free
in that window because the request is stateless and the pool did no work, whereas replaying a stream
that died mid-reply would charge twice for an answer you have already partly seen. A 4xx is never
retried; that is your configuration, not the weather.

### Requests are always streamed upstream

Whatever Claude Code asks for, the bridge streams. A non-streaming request would hold a pooled
account open with no bytes flowing — which is exactly what gateway operators block, since it wrecks
the first-token latency of the account pool they share between users. A client that wants a single
JSON body gets one, aggregated locally from the same stream.

## How switching works

Two mechanisms, one for each kind of profile:

- **Subscription profiles** swap the contents of `~/.claude/.credentials.json`, exactly as upstream
  does. A `.bak` copy is kept so the switch can be undone.
- **API-provider profiles** rewrite the `env` block of `~/.claude/settings.json` — the officially
  supported place to set environment variables for Claude Code sessions. Switching back to a
  subscription strips those variables again.

Only the variables this extension owns are ever touched:
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
`ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`,
`CLAUDE_CODE_SUBAGENT_MODEL`, plus any extra variables a preset declares. Your own entries in
`env`, and every other setting in the file (`permissions`, `hooks`, `model`, `statusLine`, …), are
preserved untouched. A `settings.json` that is not valid JSON aborts the switch rather than being
overwritten.

The key is sent as `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY` by default, because
Claude Code gates `ANTHROPIC_API_KEY` behind an interactive "Use custom API key" approval prompt
while `ANTHROPIC_AUTH_TOKEN` is used directly. The `apiKey` style is available for endpoints that
require the `x-api-key` header.

**After switching you must reload the VS Code window** — environment variables are read when a
Claude Code session starts, so a running session keeps the provider it launched with. The extension
offers to reload, and auto-reload can be enabled in settings.

Because settings live in the config directory, everything above also works inside a per-profile
`CLAUDE_CONFIG_DIR`, which is what independent windows use.

## Conversation compatibility

**A conversation cannot be continued across a provider change.** This is the one sharp edge, and
the extension guards it.

Claude Code transcripts store every assistant turn, including `thinking` blocks carrying a
cryptographic `signature`, and they are replayed in full on `--continue` / `--resume`. Claude Code
does not strip them when the endpoint changes. Replaying Anthropic-signed thinking blocks at a
third-party endpoint gets them either rejected or — worse, because it is invisible — silently
dropped, which quietly destroys the reasoning context. The reverse direction fails outright:
the CLI has named error classes for exactly this (`invalid_thinking_signature`,
`thinking_blocks_modified`).

Two profiles are treated as interchangeable only when they address the **same base URL with the
same model** and differ solely by API key. That is exactly the situation upstream's
subscription-account switching has always been in, which is why it is safe. Model granularity
matters as much as the provider: one OpenRouter key can route to entirely different model families,
and `deepseek-chat` vs `deepseek-reasoner` differ in whether they emit reasoning at all.

In the panel each card carries a coloured dot. **Same colour = safe to switch mid-conversation.**
Switching across colours shows a confirmation naming how many conversations this folder already has
and what produced the newest one. Click the dot to put profiles into a shared group manually when
you know two of them are interchangeable.

Nothing about your conversations is ever modified: the check only reads the transcript directory to
count files and to look up the newest model name. Control it with
`claudeProviderSwitcher.warnOnIncompatibleSwitch` (`always` / `whenSessionsExist` / `never`).

## A note on where your API key ends up

Switching to a provider writes the key **in plain text** into `~/.claude/settings.json`. This is
unavoidable: the Claude Code CLI has to read it, and it is what every provider's own setup guide
tells you to do. The file is written with `0600` permissions.

The extension's own copy of the key is held in VS Code's encrypted `SecretStorage`; the plaintext
copy exists only in the file Claude Code reads. If that trade-off is not acceptable, use an
`apiKeyHelper` in `settings.json` instead of this extension's provider profiles.

## Requirements

- **Claude Code CLI** is required for connection tests, "Say Hi" warmups and CLI identity checks,
  and of course for using Claude Code itself. Account switching and usage checks work without it.
- The `claude` command must be on VS Code's PATH, or `claudeProviderSwitcher.claudeCommand` must
  point at `claude`, `claude.exe`, or `claude.cmd`.
- On Windows PowerShell, Claude Code can be installed with:

```powershell
irm https://claude.ai/install.ps1 | iex
```

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudeProviderSwitcher.warnOnIncompatibleSwitch` | `whenSessionsExist` | Confirm before a switch that breaks conversation continuity |
| `claudeProviderSwitcher.autoReloadAfterSwitch` | `false` | Reload the window automatically after switching |
| `claudeProviderSwitcher.pollIntervalSeconds` | `240` | Usage refresh interval (subscriptions only; min 180s) |
| `claudeProviderSwitcher.warnThresholdPercent` | `80` | Usage % above which the bar turns red |
| `claudeProviderSwitcher.credentialsPath` | `""` | Override the path to `.credentials.json` |
| `claudeProviderSwitcher.claudeCommand` | `claude` | Path to the Claude Code CLI |
| `claudeProviderSwitcher.sayHiModel` | `haiku` | Model for subscription warmups |
| `claudeProviderSwitcher.sayHiPrompt` | `Hi` | Prompt for warmups and connection tests |
| `claudeProviderSwitcher.sayHiTimeoutSeconds` | `120` | Timeout for warmups and connection tests |

## Building

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run test:smoke    # headless logic tests
npm run package       # bundle to dist/
npm run build:vsix    # produce an installable .vsix
```

Install the resulting `.vsix` with **Extensions → … → Install from VSIX**, or:

```bash
code --install-extension claude-code-multi-provider-switcher-0.3.0.vsix
```

## License

MIT. Original work © Krzysztof Zander; see [LICENSE](LICENSE).
