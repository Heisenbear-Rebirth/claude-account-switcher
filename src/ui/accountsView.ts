import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { compatGroupIndexes, compatKey, compatLabel } from "../compat";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { requiresProfileReauthorization } from "../oauth";

interface ViewAccount {
  id: string;
  label: string;
  /** "oauth" for Claude subscriptions, "api" for third-party endpoints. */
  kind: "oauth" | "api";
  subscriptionType?: string;
  /** API profiles: the endpoint host and the pinned model, shown instead of usage meters. */
  endpoint?: string;
  model?: string;
  /** API profiles with no stored key cannot be switched to. */
  needsApiKey?: boolean;
  /** Index of this profile's conversation-compatibility group, for colour coding. */
  compatIndex: number;
  compatName: string;
  isActive: boolean;
  windows: { label: string; percent: number; severity: string; resetsAt: string | null }[];
  error?: string;
  fetchedAt?: number;
  retryAfter?: number;
  needsReauthorization: boolean;
}

/** Activity bar panel: list of accounts with usage limits and actions. */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claudeProviderSwitcher.accountsView";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string; id?: string }) => {
      switch (msg.type) {
        case "ready":
          this.refresh();
          break;
        case "switch":
          if (msg.id) void vscode.commands.executeCommand("claudeProviderSwitcher.switchAccount", msg.id);
          break;
        case "openWindow":
          if (msg.id) {
            void vscode.commands.executeCommand("claudeProviderSwitcher.openIndependentWindow", msg.id);
          }
          break;
        case "refresh":
          void vscode.commands.executeCommand("claudeProviderSwitcher.refreshUsage", msg.id);
          break;
        case "refreshAll":
          void vscode.commands.executeCommand("claudeProviderSwitcher.refreshUsage");
          break;
        case "sayHi":
          if (msg.id) void vscode.commands.executeCommand("claudeProviderSwitcher.sayHi", msg.id);
          break;
        case "sayHiAll":
          void vscode.commands.executeCommand("claudeProviderSwitcher.sayHi");
          break;
        case "add":
          void vscode.commands.executeCommand("claudeProviderSwitcher.addCurrentAccount");
          break;
        case "addProvider":
          void vscode.commands.executeCommand("claudeProviderSwitcher.addProviderProfile");
          break;
        case "editProvider":
          if (msg.id) {
            void vscode.commands.executeCommand(
              "claudeProviderSwitcher.editProviderProfile",
              msg.id
            );
          }
          break;
        case "setCompat":
          if (msg.id) {
            void vscode.commands.executeCommand("claudeProviderSwitcher.setCompatGroup", msg.id);
          }
          break;
        case "login":
          void vscode.commands.executeCommand("claudeProviderSwitcher.login");
          break;
        case "reauthorize":
          if (msg.id) {
            void vscode.commands.executeCommand("claudeProviderSwitcher.reauthorizeProfile", msg.id);
          }
          break;
        case "remove":
          if (msg.id) void vscode.commands.executeCommand("claudeProviderSwitcher.removeAccount", msg.id);
          break;
        case "rename":
          if (msg.id) void vscode.commands.executeCommand("claudeProviderSwitcher.renameAccount", msg.id);
          break;
        case "undo":
          void vscode.commands.executeCommand("claudeProviderSwitcher.undoSwitch");
          break;
      }
    });

    this.refresh();
  }

  /** Sends the current state to the webview. */
  refresh(): void {
    if (!this.view) {
      return;
    }
    const activeId = this.store.getActiveId();
    const profiles = this.store.list();
    const warnThreshold = vscode.workspace
      .getConfiguration("claudeProviderSwitcher")
      .get<number>("warnThresholdPercent", 80);

    const compatIndexes = compatGroupIndexes(profiles);

    void Promise.all(
      profiles.map(async (p): Promise<ViewAccount> => {
        const compatIndex = compatIndexes.get(compatKey(p)) ?? 0;
        const compatName = compatLabel(p);

        if (p.kind === "api") {
          const hasKey = Boolean(await this.store.getApiKey(p.id));
          return {
            id: p.id,
            label: p.label,
            kind: "api",
            endpoint: endpointHost(p.provider?.baseUrl),
            model: p.provider?.model,
            needsApiKey: !hasKey,
            compatIndex,
            compatName,
            isActive: p.id === activeId,
            windows: [],
            error: hasKey ? undefined : "No API key stored. Use Edit to add one.",
            needsReauthorization: false,
          };
        }

        const creds = await this.store.getCreds(p.id);
        const error = p.lastUsage?.error;
        const needsReauthorization = !hasUsableOAuthCreds(creds) || isAuthProblem(error);
        return {
          id: p.id,
          label: p.label,
          kind: "oauth",
          subscriptionType: p.subscriptionType,
          compatIndex,
          compatName,
          isActive: p.id === activeId,
          windows: p.lastUsage?.windows ?? [],
          error: displayUsageError(error, needsReauthorization),
          fetchedAt: p.lastUsage?.fetchedAt,
          retryAfter: p.lastUsage?.retryAfter,
          needsReauthorization,
        };
      })
    ).then((accounts) => {
      void this.view?.webview.postMessage({ type: "state", accounts, warnThreshold });
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude Accounts</title>
</head>
<body>
  <div id="toolbar">
    <button id="addBtn" class="primary">+ Account</button>
    <button id="addProviderBtn" class="primary" title="Add a third-party API provider (DeepSeek, OpenRouter, ...)">+ Provider</button>
    <button id="loginBtn" title="Open Claude login">Login</button>
    <button id="sayHiBtn" title="Say Hi on inactive accounts">Hi</button>
    <button id="refreshBtn" title="Refresh usage limits">⟳</button>
  </div>
  <div id="list"></div>
  <div id="empty" class="hidden">
    <p>No saved profiles.</p>
    <p>Log in to Claude Code, then click <b>"+ Account"</b> to save a subscription.</p>
    <p>Or click <b>"+ Provider"</b> to add an API endpoint such as DeepSeek or OpenRouter.</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Hostname only — the full base URL is too long for a card. */
function endpointHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function isAuthProblem(error: string | undefined): boolean {
  if (requiresProfileReauthorization(error)) {
    return true;
  }

  const text = error?.toLowerCase() ?? "";
  return (
    text.includes("failed to refresh token") ||
    text.includes("refresh token") ||
    text.includes("reauthoriz") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("invalid_request_error") ||
    text.includes("invalid_grant") ||
    text.includes("http 401") ||
    text.includes("http 403")
  );
}

function displayUsageError(
  error: string | undefined,
  needsReauthorization: boolean
): string | undefined {
  if (needsReauthorization) {
    return "Needs reauthorization. Use Auth to refresh this profile.";
  }
  return error;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
