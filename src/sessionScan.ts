import * as fs from "fs";
import * as path from "path";

/**
 * Read-only probe for existing Claude Code conversation transcripts.
 *
 * Nothing here ever writes, moves or deletes: it only answers "does this folder already have
 * conversations that a provider switch would make unresumable?" so the user can be warned.
 *
 * Layout mirrors the CLI: transcripts live in `<configDir>/projects/<sanitised cwd>/*.jsonl`,
 * where the directory name is the cwd with every non-alphanumeric character replaced by `-`.
 * Very long paths are truncated and suffixed with a hash, so an exact miss falls back to a
 * prefix scan, the same way the CLI itself resolves them.
 */
export interface SessionScanResult {
  /** Number of transcript files found for this folder. */
  count: number;
  /** Most recent transcript mtime (epoch ms), if any. */
  newestMtime?: number;
  /** Model recorded on the newest transcript's last assistant turn, when cheaply readable. */
  newestModel?: string;
  /** Directories inspected (for diagnostics). */
  dirs: string[];
}

const TAIL_BYTES = 64 * 1024;
const MIN_PREFIX_MATCH = 20;

export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectsDir(configDir: string): string {
  return path.join(configDir, "projects");
}

/** Every transcript directory belonging to `cwd` (exact match plus truncated-with-hash forms). */
export function resolveTranscriptDirs(configDir: string, cwd: string): string[] {
  const root = projectsDir(configDir);
  const sanitized = sanitizeCwd(cwd);
  const exact = path.join(root, sanitized);
  const dirs: string[] = [];

  if (isDirectory(exact)) {
    dirs.push(exact);
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === sanitized) {
      continue;
    }
    // Truncated form: "<prefix>-<hash>" where the prefix is a leading slice of the full name.
    const cut = entry.name.lastIndexOf("-");
    if (cut < MIN_PREFIX_MATCH) {
      continue;
    }
    const prefix = entry.name.slice(0, cut);
    if (sanitized.startsWith(prefix)) {
      dirs.push(path.join(root, entry.name));
    }
  }

  return dirs;
}

export function scanSessions(configDir: string, cwd: string): SessionScanResult {
  const dirs = resolveTranscriptDirs(configDir, cwd);
  let count = 0;
  let newestMtime: number | undefined;
  let newestFile: string | undefined;

  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size === 0) {
          continue;
        }
        count++;
        const mtime = stat.mtime.getTime();
        if (newestMtime === undefined || mtime > newestMtime) {
          newestMtime = mtime;
          newestFile = file;
        }
      } catch {
        /* unreadable entry — ignore */
      }
    }
  }

  return {
    count,
    newestMtime,
    newestModel: newestFile ? readLastModel(newestFile) : undefined,
    dirs,
  };
}

/**
 * Best-effort: reads only the tail of the transcript and walks backwards for the last assistant
 * turn that names a real model. Returns undefined rather than throwing — this only enriches a
 * warning message.
 */
export function readLastModel(file: string): string | undefined {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) {
      return undefined;
    }
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, length, start);

    const lines = buf.toString("utf8").split("\n");
    // A partial first line is expected whenever the tail starts mid-record.
    for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) {
        continue;
      }
      let parsed: { message?: { model?: unknown } };
      try {
        parsed = JSON.parse(line) as { message?: { model?: unknown } };
      } catch {
        continue;
      }
      const model = parsed.message?.model;
      if (typeof model === "string" && model && !model.startsWith("<")) {
        return model;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
