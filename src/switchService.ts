import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { ClaudeSettingsManager } from "./claudeSettings";
import { findProfileForEnv, isCompatible } from "./compat";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { buildProviderEnv, keysToClear, managedKeysFor } from "./providerEnv";
import { scanSessions } from "./sessionScan";
import {
  buildIncompatibleSwitchWarning,
  shouldWarnOnSwitch,
  WarnMode,
} from "./sessionGuard";
import { ShimEndpoint, ShimTarget } from "./shim/server";
import { AccountProfile } from "./types";

/**
 * The bit of the loopback shim a switch needs. Narrow on purpose: the service never has to know
 * whether a real socket is listening, which keeps it testable.
 */
export interface ShimController {
  ensure(target: ShimTarget): Promise<ShimEndpoint>;
}

export interface SwitchResult {
  ok: boolean;
  message: string;
  reauthProfileId?: string;
}

/**
 * Orchestration: capturing the current account, switching, reloading the window, and undoing.
 *
 * Two kinds of switch:
 * - subscription profiles swap `.credentials.json` (upstream behaviour, unchanged);
 * - API-provider profiles rewrite the managed keys of the `env` block in settings.json.
 *
 * Both directions clean up after the other, so a provider is never left half-pinned.
 */
export class SwitchService {
  constructor(
    private readonly store: AccountStore,
    private readonly credentials: CredentialsManager,
    private readonly settings: ClaudeSettingsManager,
    private readonly shim?: ShimController
  ) {}

  /** Saves the currently logged-in account (from the file) as a new profile. */
  async captureCurrent(): Promise<{ ok: boolean; message: string }> {
    const creds = this.credentials.readCurrent();
    if (!creds) {
      return {
        ok: false,
        message:
          "No logged-in account found in .credentials.json. Log in to Claude Code and try again.",
      };
    }
    if (!hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message:
          "Current Claude credentials are incomplete. Run Claude: Log in from terminal, finish login, then save the account again.",
      };
    }

    const existingId = await this.store.findByTokens(creds);
    if (existingId) {
      const existing = this.store.get(existingId);
      await this.store.setActiveId(existingId);
      await this.store.updateCreds(existingId, creds);
      return {
        ok: true,
        message: `Updated saved profile "${existing?.label ?? existingId}".`,
      };
    }

    const suggested = creds.subscriptionType
      ? `${creds.subscriptionType} account`
      : "New account";
    const label = await vscode.window.showInputBox({
      title: "Save current Claude account",
      prompt: "Profile name (e.g. Work, Personal, Max #1)",
      value: suggested,
      validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
    });
    if (label === undefined) {
      return { ok: false, message: "Cancelled." };
    }

    const profile = await this.store.addFromCreds(label.trim(), creds);
    return { ok: true, message: `Saved profile "${profile.label}".` };
  }

  /**
   * Switches to the given profile.
   *
   * Order matters: a profile whose credentials are unusable reports that it needs
   * reauthorization before anything else, even when it is already the active one — callers rely
   * on that to offer a repair flow.
   */
  async switchTo(id: string): Promise<SwitchResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const problem =
      profile.kind === "api"
        ? await this.validateProvider(profile)
        : await this.validateSubscription(profile);
    if (problem) {
      return problem;
    }

    if (this.store.getActiveId() === id) {
      return { ok: false, message: `"${profile.label}" is already active.` };
    }

    const confirmed = await this.confirmConversationImpact(profile);
    if (!confirmed) {
      return { ok: false, message: "Cancelled." };
    }

    return profile.kind === "api"
      ? this.switchToProvider(profile)
      : this.switchToSubscription(profile);
  }

  /** Returns a failure result when the provider profile cannot be applied, otherwise undefined. */
  private async validateProvider(profile: AccountProfile): Promise<SwitchResult | undefined> {
    if (!profile.provider) {
      return { ok: false, message: `"${profile.label}" has no provider configuration.` };
    }
    if (!profile.provider.baseUrl.trim()) {
      return { ok: false, message: `"${profile.label}" has no base URL. Edit the profile first.` };
    }
    if (!(await this.store.getApiKey(profile.id))) {
      return {
        ok: false,
        message: `No API key stored for "${profile.label}". Edit the profile to enter one.`,
      };
    }
    return undefined;
  }

  private async validateSubscription(
    profile: AccountProfile
  ): Promise<SwitchResult | undefined> {
    const creds = await this.store.getCreds(profile.id);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message:
          `"${profile.label}" needs reauthorization. Its stored credentials are incomplete, so it was not written to Claude Code.`,
        reauthProfileId: profile.id,
      };
    }
    return undefined;
  }

  /**
   * Warns before a switch that makes this folder's conversations unresumable. Never touches any
   * session file - it only reads the transcript directory to make the warning concrete.
   */
  private async confirmConversationImpact(target: AccountProfile): Promise<boolean> {
    const activeId = this.store.getActiveId();
    const current = activeId ? this.store.get(activeId) : undefined;
    if (!current || isCompatible(current, target)) {
      return true;
    }

    const mode = vscode.workspace
      .getConfiguration("claudeProviderSwitcher")
      .get<WarnMode>("warnOnIncompatibleSwitch", "whenSessionsExist");

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const scan = cwd
      ? scanSessions(this.credentials.getConfigDir(), cwd)
      : { count: 0, dirs: [] };

    if (!shouldWarnOnSwitch(mode, scan)) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      buildIncompatibleSwitchWarning(current, target, scan),
      { modal: true },
      "Switch anyway"
    );
    return choice === "Switch anyway";
  }

  /** Pins a third-party endpoint by rewriting the managed env keys in settings.json. */
  private async switchToProvider(profile: AccountProfile): Promise<SwitchResult> {
    if (!profile.provider) {
      return { ok: false, message: `"${profile.label}" has no provider configuration.` };
    }
    if (!profile.provider.baseUrl.trim()) {
      return { ok: false, message: `"${profile.label}" has no base URL. Edit the profile first.` };
    }

    const apiKey = await this.store.getApiKey(profile.id);
    if (!apiKey) {
      return {
        ok: false,
        message: `No API key stored for "${profile.label}". Edit the profile to enter one.`,
      };
    }

    // An OpenAI-format endpoint is reached through the loopback shim, which has to be listening
    // before the env block can name it. Failing here is better than pinning a dead URL.
    let endpoint: ShimEndpoint | undefined;
    if (profile.provider.wireFormat === "openaiResponses") {
      if (!this.shim) {
        return {
          ok: false,
          message: `"${profile.label}" needs the local OpenAI shim, which is unavailable in this window.`,
        };
      }
      try {
        endpoint = await this.shim.ensure({
          baseUrl: profile.provider.baseUrl,
          apiKey,
          fallbackModel: profile.provider.model,
          defaultEffort: profile.provider.defaultEffort,
        });
      } catch (e) {
        return { ok: false, message: `Could not start the local shim: ${(e as Error).message}` };
      }
    }

    let env: Record<string, string>;
    try {
      env = buildProviderEnv(profile.provider, apiKey, endpoint);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const clear = keysToClear(this.store.getManagedEnvKeys(), env);

    this.settings.backup();
    try {
      this.settings.applyEnv(env, clear);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    await this.store.setManagedEnvKeys(managedKeysFor(profile));
    await this.store.setActiveId(profile.id);

    await this.maybeReload(`Switched to "${profile.label}".`);
    return { ok: true, message: `Switched to "${profile.label}".` };
  }

  /** Restores subscription auth: strips the managed env keys, then swaps the credentials file. */
  private async switchToSubscription(profile: AccountProfile): Promise<SwitchResult> {
    const creds = await this.store.getCreds(profile.id);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message:
          `"${profile.label}" needs reauthorization. Its stored credentials are incomplete, so it was not written to Claude Code.`,
        reauthProfileId: profile.id,
      };
    }

    try {
      await this.clearManagedEnv();
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }

    this.credentials.backupCurrent();
    try {
      this.credentials.writeCreds(creds);
    } catch (e) {
      return { ok: false, message: "Failed to write credentials file: " + (e as Error).message };
    }
    await this.store.setActiveId(profile.id);

    await this.maybeReload(`Switched to "${profile.label}".`);
    return { ok: true, message: `Switched to "${profile.label}".` };
  }

  /** Removes every env key this extension owns, leaving hand-written entries untouched. */
  private async clearManagedEnv(): Promise<void> {
    const managed = keysToClear(this.store.getManagedEnvKeys(), {});
    if (managed.length === 0) {
      return;
    }
    this.settings.backup();
    this.settings.applyEnv({}, managed);
    await this.store.setManagedEnvKeys([]);
  }

  /** Undoes the last switch by restoring both backed-up files. */
  async undoSwitch(): Promise<{ ok: boolean; message: string }> {
    const hasCreds = this.credentials.hasBackup();
    const hasSettings = this.settings.hasBackup();
    if (!hasCreds && !hasSettings) {
      return { ok: false, message: "No backup to restore." };
    }

    const restoredSettings = hasSettings ? this.settings.restoreBackup() : false;
    const restoredCreds = hasCreds ? this.credentials.restoreBackup() : false;
    if (!restoredSettings && !restoredCreds) {
      return { ok: false, message: "Failed to restore the backup." };
    }

    // Re-derive which profile the restored state corresponds to.
    const env = this.settings.readEnv();
    const baseUrl = env.ANTHROPIC_BASE_URL;
    let matched: string | undefined;
    if (baseUrl) {
      matched = findProfileForEnv(this.store.list(), baseUrl, env.ANTHROPIC_MODEL)?.id;
      await this.store.setManagedEnvKeys(Object.keys(env));
    } else {
      const restored = this.credentials.readCurrent();
      matched = restored ? await this.store.findByTokens(restored) : undefined;
      await this.store.setManagedEnvKeys([]);
    }
    await this.store.setActiveId(matched);

    await this.maybeReload("Restored the previous account.");
    return { ok: true, message: "Restored the previous account." };
  }

  /** Reload the window automatically or after confirmation (per setting). */
  private async maybeReload(context: string): Promise<void> {
    const auto = vscode.workspace
      .getConfiguration("claudeProviderSwitcher")
      .get<boolean>("autoReloadAfterSwitch", false);

    if (auto) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `${context} Reload the VS Code window so Claude Code uses the new account.`,
      "Reload now",
      "Later"
    );
    if (choice === "Reload now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}
