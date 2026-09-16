import { compatLabel } from "./compat";
import { SessionScanResult } from "./sessionScan";
import { AccountProfile } from "./types";

export type WarnMode = "always" | "whenSessionsExist" | "never";

export function shouldWarnOnSwitch(mode: WarnMode, scan: SessionScanResult): boolean {
  switch (mode) {
    case "never":
      return false;
    case "always":
      return true;
    default:
      return scan.count > 0;
  }
}

/**
 * Explains why an incompatible switch means "start a new conversation".
 *
 * Deliberately concrete: it names the endpoints, how many transcripts this folder already has and
 * what produced the newest one, because the failure it prevents is otherwise invisible — a
 * third-party endpoint usually drops replayed thinking blocks silently rather than erroring.
 */
export function buildIncompatibleSwitchWarning(
  from: AccountProfile,
  to: AccountProfile,
  scan: SessionScanResult
): string {
  const lines: string[] = [
    `Switching from "${from.label}" (${compatLabel(from)}) to "${to.label}" (${compatLabel(to)}).`,
    "",
    "These use different endpoints or models, so existing conversations cannot be continued.",
  ];

  if (scan.count > 0) {
    lines.push("", describeSessions(scan));
  }

  lines.push(
    "",
    "After switching, start a NEW conversation — do not use --continue or --resume.",
    "Old transcripts replay signed thinking blocks, which the new endpoint will reject or silently drop."
  );

  return lines.join("\n");
}

function describeSessions(scan: SessionScanResult): string {
  const plural = scan.count === 1 ? "conversation" : "conversations";
  const parts = [`This folder has ${scan.count} existing ${plural}`];
  const detail: string[] = [];
  if (scan.newestMtime !== undefined) {
    detail.push(`newest ${formatAgo(scan.newestMtime)}`);
  }
  if (scan.newestModel) {
    detail.push(scan.newestModel);
  }
  return detail.length > 0 ? `${parts[0]} (${detail.join(", ")}).` : `${parts[0]}.`;
}

export function formatAgo(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const mins = Math.round(diff / 60000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins} min ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
