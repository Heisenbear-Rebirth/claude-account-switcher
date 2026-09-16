import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { OAuthCreds } from "./types";

/**
 * One-way import of saved profiles from the upstream `claude-account-switcher` extension.
 *
 * globalState and SecretStorage are keyed by extension id, so a fork starts empty and cannot read
 * upstream's secrets through any API. What it *can* read is the per-profile credential files that
 * upstream writes to its own global storage for isolated logins, warmups and independent windows —
 * those are plain JSON on disk. Profile names come from a read-only scan of VS Code's state
 * database.
 *
 * Nothing belonging to upstream is modified: every path here is opened for reading only, so the
 * original extension keeps working exactly as before and the import can be re-run safely.
 */

const UPSTREAM_STORAGE_DIRS = [
  "krzysztofzander.claude-code-account-switcher",
  "KrzysztofZander.claude-code-account-switcher",
];

/** Key upstream uses inside its globalState blob. */
const UPSTREAM_PROFILES_KEY = "claudeSwitcher.profiles";

export interface UpstreamProfile {
  id: string;
  label?: string;
  subscriptionType?: string;
  authEmail?: string;
  authOrgId?: string;
  authOrgName?: string;
  order?: number;
}

export interface ImportedAccount {
  id: string;
  label: string;
  creds: OAuthCreds;
  /** True when the tokens came from a reauth backup rather than the live profile file. */
  fromBackup: boolean;
  /** Verified account identity upstream had recorded, when it had one. */
  identity?: { email?: string; orgId?: string; orgName?: string };
}

export interface ImportSummary {
  imported: string[];
  skipped: string[];
  unavailable: string[];
  fromBackup: string[];
  activeLabel?: string;
}

/** `<...>/globalStorage/<our id>` -> `<...>/globalStorage`. */
function globalStorageRoot(context: vscode.ExtensionContext): string {
  return path.dirname(context.globalStorageUri.fsPath);
}

/** Upstream's storage directory, if the extension has ever run on this machine. */
export function findUpstreamDir(context: vscode.ExtensionContext): string | undefined {
  const root = globalStorageRoot(context);
  for (const name of UPSTREAM_STORAGE_DIRS) {
    const candidate = path.join(root, name);
    if (isDirectory(path.join(candidate, "account-configs"))) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Profile names, read straight out of VS Code's state database.
 *
 * Deliberately a read-only byte scan rather than a SQLite dependency: the value is stored as a
 * JSON string, so locating the key and bracket-matching the array is enough, works regardless of
 * the Node build shipped with VS Code, and cannot disturb a database VS Code has open. The
 * write-ahead log is scanned too, since a recent rename may not be checkpointed yet.
 */
export function readUpstreamProfiles(context: vscode.ExtensionContext): UpstreamProfile[] {
  const root = globalStorageRoot(context);
  let best: UpstreamProfile[] = [];

  for (const file of ["state.vscdb", "state.vscdb-wal"]) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, file), "latin1");
    } catch {
      continue;
    }
    for (const candidate of extractProfileArrays(raw)) {
      if (candidate.length > best.length) {
        best = candidate;
      }
    }
  }
  return best;
}

function extractProfileArrays(raw: string): UpstreamProfile[][] {
  const marker = `"${UPSTREAM_PROFILES_KEY}":`;
  const found: UpstreamProfile[][] = [];
  let from = 0;

  for (;;) {
    const at = raw.indexOf(marker, from);
    if (at < 0) {
      break;
    }
    from = at + marker.length;
    const start = raw.indexOf("[", from);
    if (start < 0) {
      break;
    }
    const end = matchBracket(raw, start);
    if (end < 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        const profiles = parsed.filter(
          (p): p is UpstreamProfile =>
            Boolean(p) && typeof (p as UpstreamProfile).id === "string"
        );
        if (profiles.length > 0) {
          found.push(profiles);
        }
      }
    } catch {
      /* a torn page or an older generation - try the next occurrence */
    }
  }
  return found;
}

/** Index of the `]` closing the `[` at `start`, ignoring brackets inside strings. */
function matchBracket(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Credentials for one upstream profile: the live per-profile file when present, otherwise the
 * newest reauth backup whose refresh token has not expired. A backup was set aside during a
 * re-login, so its token may since have been rotated away — it is offered as a last resort and
 * reported as such rather than silently trusted.
 */
export function readUpstreamCreds(
  upstreamDir: string,
  id: string
): { creds: OAuthCreds; fromBackup: boolean } | undefined {
  const dir = path.join(upstreamDir, "account-configs", id);

  const live = readCredsFile(path.join(dir, ".credentials.json"));
  if (live) {
    return { creds: live, fromBackup: false };
  }

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(".credentials.json."));
  } catch {
    return undefined;
  }

  const now = Date.now();
  const candidates = names
    .sort()
    .reverse()
    .map((n) => readCredsFile(path.join(dir, n)))
    .filter((c): c is OAuthCreds => Boolean(c))
    .filter((c) => (c.refreshTokenExpiresAt ?? Infinity) > now);

  return candidates[0] ? { creds: candidates[0], fromBackup: true } : undefined;
}

function readCredsFile(file: string): OAuthCreds | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      claudeAiOauth?: OAuthCreds;
    };
    const creds = parsed.claudeAiOauth;
    return creds && hasUsableOAuthCreds(creds) ? creds : null;
  } catch {
    return null;
  }
}

/** Everything importable, newest-credential-first within each profile. */
export function collectUpstreamAccounts(
  context: vscode.ExtensionContext
): { accounts: ImportedAccount[]; unavailable: string[] } | undefined {
  const upstreamDir = findUpstreamDir(context);
  if (!upstreamDir) {
    return undefined;
  }

  const meta = new Map(readUpstreamProfiles(context).map((p) => [p.id, p]));
  let ids: string[];
  try {
    ids = fs
      .readdirSync(path.join(upstreamDir, "account-configs"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { accounts: [], unavailable: [] };
  }

  // Keep upstream's ordering when it is known; unknown ids go last.
  ids.sort((a, b) => (meta.get(a)?.order ?? 1e9) - (meta.get(b)?.order ?? 1e9));

  const accounts: ImportedAccount[] = [];
  const unavailable: string[] = [];
  for (const id of ids) {
    const upstream = meta.get(id);
    const label = upstream?.label ?? `Imported ${id.slice(0, 8)}`;
    const found = readUpstreamCreds(upstreamDir, id);
    if (!found) {
      unavailable.push(label);
      continue;
    }
    const identity =
      upstream?.authEmail || upstream?.authOrgId
        ? {
            email: upstream.authEmail,
            orgId: upstream.authOrgId,
            orgName: upstream.authOrgName,
          }
        : undefined;
    accounts.push({ id, label, creds: found.creds, fromBackup: found.fromBackup, identity });
  }
  return { accounts, unavailable };
}

/**
 * Creates a profile per upstream account that is not already present. Matching is by token, so
 * re-running the import adds nothing and never produces duplicates.
 */
export async function importFromUpstream(
  context: vscode.ExtensionContext,
  store: AccountStore,
  credentials: CredentialsManager
): Promise<ImportSummary | undefined> {
  const collected = collectUpstreamAccounts(context);
  if (!collected) {
    return undefined;
  }

  const summary: ImportSummary = {
    imported: [],
    skipped: [],
    unavailable: collected.unavailable,
    fromBackup: [],
  };

  // The live credentials file always holds the freshest tokens for whichever account is logged in.
  const liveCreds = credentials.readCurrent();
  let activeId: string | undefined;

  for (const account of collected.accounts) {
    const existing = await store.findByTokens(account.creds);
    if (existing) {
      summary.skipped.push(account.label);
      continue;
    }

    const isActive = isSameAccount(liveCreds, account.creds);
    const profile = await store.addFromCreds(account.label, isActive ? liveCreds! : account.creds);
    if (account.identity) {
      await store.updateIdentity(profile.id, account.identity);
    }
    summary.imported.push(account.label);
    if (account.fromBackup) {
      summary.fromBackup.push(account.label);
    }
    if (isActive) {
      summary.activeLabel = account.label;
      activeId = profile.id;
    }
  }

  // addFromCreds marks whichever profile it just created as active, so the marker must be settled
  // once at the end — otherwise the last account imported would win regardless of who is logged in.
  await store.setActiveId(activeId ?? (liveCreds ? await store.findByTokens(liveCreds) : undefined));

  return summary;
}

/** Same account if either token matches - upstream may hold an older generation of the other. */
function isSameAccount(a: OAuthCreds | null, b: OAuthCreds): boolean {
  if (!a) {
    return false;
  }
  return (
    (Boolean(a.accessToken) && a.accessToken === b.accessToken) ||
    (Boolean(a.refreshToken) && a.refreshToken === b.refreshToken)
  );
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
