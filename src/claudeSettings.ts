import * as fs from "fs";
import * as path from "path";
import { CredentialsManager } from "./credentials";

const BACKUP_SUFFIX = ".mps-bak";

/**
 * Reads and writes the `env` block of Claude Code's settings.json.
 *
 * Switching to an API provider = rewriting that block. The file also holds the user's
 * permissions/hooks/model/statusLine, so every write is a merge onto freshly re-read content and
 * a parse failure aborts rather than clobbering. The file lives next to `.credentials.json`, so
 * the same config dir the rest of the extension already resolves (including the
 * `credentialsPath` override and per-profile `CLAUDE_CONFIG_DIR` isolation) applies unchanged.
 */
export class ClaudeSettingsManager {
  constructor(private readonly credentials: CredentialsManager) {}

  getSettingsPath(configDir?: string): string {
    const dir = configDir ?? this.credentials.getConfigDir();
    return path.join(dir, "settings.json");
  }

  /** Full parsed settings, `null` when the file is absent. Throws on malformed JSON. */
  readSettings(configDir?: string): Record<string, unknown> | null {
    const p = this.getSettingsPath(configDir);
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("settings.json does not contain a JSON object.");
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `Refusing to modify ${p}: it is not valid JSON (${(e as Error).message}). ` +
          "Fix the file by hand, then switch again."
      );
    }
  }

  readEnv(configDir?: string): Record<string, string> {
    const settings = this.readSettings(configDir);
    const env = settings?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * Sets `set` and deletes `remove` inside the `env` block, leaving every other entry — and every
   * other top-level setting — exactly as it was. The block is dropped entirely when it ends up
   * empty, so switching back to a subscription leaves no trace behind.
   */
  applyEnv(
    set: Record<string, string>,
    remove: readonly string[],
    configDir?: string
  ): void {
    const p = this.getSettingsPath(configDir);
    const settings = this.readSettings(configDir) ?? {};

    const existing = settings.env;
    const env: Record<string, string> = {};
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }
    }

    for (const key of remove) {
      delete env[key];
    }
    for (const [k, v] of Object.entries(set)) {
      env[k] = v;
    }

    if (Object.keys(env).length > 0) {
      settings.env = env;
    } else {
      delete settings.env;
    }

    this.writeAtomic(p, settings);
  }

  private writeAtomic(p: string, settings: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const json = JSON.stringify(settings, null, 2) + "\n";
    const tmp = `${p}.tmp-${process.pid}`;
    // 0600: the env block holds the provider API key in plain text, which is unavoidable —
    // the Claude Code CLI has to be able to read it.
    fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* best-effort on Windows */
    }
  }

  private backupPath(configDir?: string): string {
    return this.getSettingsPath(configDir) + BACKUP_SUFFIX;
  }

  /** Copies settings.json aside so a switch can be undone. Safe when the file does not exist. */
  backup(configDir?: string): boolean {
    const p = this.getSettingsPath(configDir);
    try {
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, this.backupPath(configDir));
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  hasBackup(configDir?: string): boolean {
    try {
      return fs.existsSync(this.backupPath(configDir));
    } catch {
      return false;
    }
  }

  restoreBackup(configDir?: string): boolean {
    const bak = this.backupPath(configDir);
    try {
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, this.getSettingsPath(configDir));
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
}
