import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseUsage } from "../src/usage";
import { CredentialsManager } from "../src/credentials";
import { requiresProfileReauthorization, TokenRefresher } from "../src/oauth";
import { AccountStore } from "../src/accountStore";
import { buildBrowserAuthorizationUrl, parseBrowserTokenResponse } from "../src/browserOAuth";
import { ProfileActivityRegistry } from "../src/profileActivity";
import { SwitchService } from "../src/switchService";
import { ClaudeSettingsManager } from "../src/claudeSettings";
import { buildProviderEnv, keysToClear, managedKeysFor } from "../src/providerEnv";
import { compatKey, findProfileForEnv, isCompatible, normalizeBaseUrl, OAUTH_COMPAT_KEY } from "../src/compat";
import { readLastModel, sanitizeCwd, scanSessions } from "../src/sessionScan";
import { shouldWarnOnSwitch } from "../src/sessionGuard";
import { getPreset } from "../src/providerPresets";
import { AccountProfile, ProviderConfig } from "../src/types";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? "  PASS" : "  FAIL") + " - " + name);
  if (!cond) failures++;
}

console.log("parseUsage:");
// Real captured /api/oauth/usage response shape
const real = {
  five_hour: { utilization: 12.0, resets_at: "2026-06-25T11:00:00+00:00" },
  seven_day: { utilization: 8.0, resets_at: "2026-06-29T12:00:00+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-06-25T11:00:00+00:00", is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 8, severity: "normal", resets_at: "2026-06-29T12:00:00+00:00", is_active: false },
  ],
};
const snap = parseUsage(real as never);
check("2 windows from limits[]", snap.windows.length === 2);
check("sessionPercent = 12", snap.sessionPercent === 12);
check("weeklyPercent = 8", snap.weeklyPercent === 8);
check("session label", snap.windows[0].label === "Session (5h)");

const fb = parseUsage({ five_hour: { utilization: 50, resets_at: null }, seven_day: { utilization: 90, resets_at: null } } as never);
check("fallback sessionPercent = 50", fb.sessionPercent === 50);
check("fallback weeklyPercent = 90", fb.weeklyPercent === 90);

const em = parseUsage({} as never);
check("empty -> 0 windows, null percents", em.windows.length === 0 && em.sessionPercent === null);

console.log("CredentialsManager (temp file):");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-test-"));
const credPath = path.join(tmpDir, ".credentials.json");
process.env.TEST_CRED_PATH = credPath;
const mgr = new CredentialsManager();

const credsA = { accessToken: "AAA", refreshToken: "ra", expiresAt: 111, scopes: ["x"], subscriptionType: "pro" };
const credsB = { accessToken: "BBB", refreshToken: "rb", expiresAt: 222, scopes: ["y"], subscriptionType: "max" };

check("path resolves to override", mgr.getCredentialsPath() === credPath);
mgr.writeCreds(credsA as never);
check("write + read account A", mgr.readCurrent()?.accessToken === "AAA");

mgr.backupCurrent();
check("hasBackup after backup", mgr.hasBackup() === true);

mgr.writeCreds(credsB as never);
check("switch to account B", mgr.readCurrent()?.accessToken === "BBB");

mgr.restoreBackup();
check("undo restores account A", mgr.readCurrent()?.accessToken === "AAA");

fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: credsA, otherField: 123 }));
mgr.writeCreds(credsB as never);
const rawAfter = JSON.parse(fs.readFileSync(credPath, "utf8"));
check("preserves extra fields on write", rawAfter.otherField === 123 && rawAfter.claudeAiOauth.accessToken === "BBB");

check(
  "does not overwrite a credential file that Claude already rotated",
  mgr.writeCredsIfCurrent(credsA as never, credsB as never) === false &&
    mgr.readCurrent()?.refreshToken === "rb"
);
check(
  "compare-and-swap persists a rotation from the current generation",
  mgr.writeCredsIfCurrent(credsB as never, credsA as never) === true &&
    mgr.readCurrent()?.refreshToken === "ra"
);

fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } }));
check("empty tokens are not a current login", mgr.readCurrent() === null);

mgr.writeCreds(credsA as never);
let refusedIncompleteWrite = false;
try {
  mgr.writeCreds({ accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } as never);
} catch {
  refusedIncompleteWrite = true;
}
check("refuses to write incomplete credentials", refusedIncompleteWrite);
check("incomplete write does not overwrite existing credentials", mgr.readCurrent()?.accessToken === "AAA");

fs.rmSync(tmpDir, { recursive: true, force: true });

function createStore(): AccountStore {
  const globalState = new Map<string, unknown>();
  const workspaceState = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento = (values: Map<string, unknown>) => ({
    get: <T>(key: string, defaultValue?: T): T => (values.has(key) ? values.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  });

  return new AccountStore({
    globalState: memento(globalState),
    workspaceState: memento(workspaceState),
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as never);
}

function runBrowserOAuthTests(): void {
  console.log("Browser OAuth:");
  const url = new URL(buildBrowserAuthorizationUrl(43123, "expected-state", "pkce-challenge"));
  check(
    "uses the Claude subscription authorization endpoint",
    url.origin === "https://claude.com" && url.pathname === "/cai/oauth/authorize"
  );
  check(
    "uses loopback callback and PKCE",
    url.searchParams.get("redirect_uri") === "http://127.0.0.1:43123/callback" &&
      url.searchParams.get("code_challenge") === "pkce-challenge" &&
      url.searchParams.get("code_challenge_method") === "S256"
  );
  check(
    "binds the authorization response to a random state",
    url.searchParams.get("state") === "expected-state"
  );

  const parsed = parseBrowserTokenResponse({
    access_token: "browser-access",
    refresh_token: "browser-refresh",
    expires_in: 3600,
    refresh_token_expires_in: 7200,
    scope: "user:profile user:inference",
    account: { email_address: "browser@example.com" },
    organization: { uuid: "org-browser", name: "Browser Org" },
  });
  check(
    "maps a browser token response to credentials",
    parsed.creds?.accessToken === "browser-access" &&
      parsed.creds.refreshToken === "browser-refresh" &&
      parsed.creds.scopes.join(" ") === "user:profile user:inference"
  );
  check(
    "maps account identity without the CLI",
    parsed.identity?.email === "browser@example.com" && parsed.identity.orgId === "org-browser"
  );
}

function runProfileActivityTests(): void {
  console.log("ProfileActivityRegistry:");
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-activity-test-"));
  const context = { globalStorageUri: { fsPath: storageDir } } as never;
  const owner = new ProfileActivityRegistry(context);
  const observer = new ProfileActivityRegistry(context);
  owner.setActiveProfile("profile-a");
  check("shares active-profile ownership across extension hosts", observer.isActive("profile-a"));
  owner.dispose();
  check("removes the window lease on disposal", !observer.isActive("profile-a"));
  observer.dispose();
  fs.rmSync(storageDir, { recursive: true, force: true });
}

async function runAccountStoreTests(): Promise<void> {
  console.log("AccountStore:");

  const store = createStore();
  const profile = await store.addFromCreds("Broken", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  await store.syncActiveFromFile({
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresAt: 222,
    scopes: ["user:profile"],
  });
  check(
    "does not repair incomplete profile from unmatched current file",
    (await store.getCreds(profile.id))?.refreshToken === ""
  );
  check("keeps remembered active marker when an unmatched file cannot be identified", store.getActiveId() === profile.id);

  await store.updateIdentity(profile.id, { email: "owner@example.com", orgId: "org-1" });
  await store.syncActiveFromFile(
    {
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresAt: 333,
      scopes: ["user:profile"],
    },
    { email: "owner@example.com", orgId: "org-1" }
  );
  check(
    "imports a fully rotated active file by verified account identity",
    (await store.getCreds(profile.id))?.refreshToken === "rotated-refresh"
  );

  const noRefreshStore = createStore();
  await noRefreshStore.addFromCreds("A", {
    accessToken: "a",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  const matched = await noRefreshStore.findByTokens({
    accessToken: "b",
    refreshToken: "",
    expiresAt: 222,
    scopes: [],
  });
  check("does not match accounts by empty refresh token", matched === undefined);

  await store.updateUsage(profile.id, {
    fetchedAt: 333,
    windows: [],
    sessionPercent: null,
    weeklyPercent: null,
    error: "Failed to refresh token: HTTP 400 invalid_grant",
    retryAfter: 444,
  });
  await store.clearUsageError(profile.id);
  const clearedUsage = store.get(profile.id)?.lastUsage;
  check("clearUsageError removes auth error", clearedUsage?.error === undefined);
  check("clearUsageError removes retry backoff", clearedUsage?.retryAfter === undefined);
  check("clearUsageError preserves usage timestamp", clearedUsage?.fetchedAt === 333);

  await store.updateUsage(profile.id, {
    fetchedAt: 555,
    windows: [],
    sessionPercent: null,
    weeklyPercent: null,
    error: "Failed to refresh token: HTTP 400 invalid_grant",
    retryAfter: 666,
  });
  await store.updateCreds(profile.id, {
    accessToken: "reauth-access",
    refreshToken: "reauth-refresh",
    expiresAt: 777,
    scopes: ["user:profile"],
  });
  const reauthedUsage = store.get(profile.id)?.lastUsage;
  check("new credentials clear auth error", reauthedUsage?.error === undefined);
  check("new credentials clear retry backoff", reauthedUsage?.retryAfter === undefined);
}

async function runUsagePollerTests(): Promise<void> {
  console.log("UsagePoller:");
  const { UsagePoller } = await import("../src/usage");
  const store = createStore();
  const profile = await store.addFromCreds("Good", {
    accessToken: "stored-access",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["user:profile"],
  });
  const poller = new UsagePoller(
    store,
    new TokenRefresher(),
    new CredentialsManager(),
    () => 240,
    () => undefined,
    {
      readProfileCreds: () => ({
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        refreshTokenExpiresAt: Date.now() + 7_200_000,
        scopes: ["user:profile"],
      }),
    }
  );
  await (poller as never as { syncProfileConfigCreds(id: string, stored: unknown): Promise<unknown> })
    .syncProfileConfigCreds(profile.id, await store.getCreds(profile.id));
  check(
    "ignores incomplete isolated profile credentials",
    (await store.getCreds(profile.id))?.refreshToken === "stored-refresh"
  );

  const brokenStore = createStore();
  const brokenProfile = await brokenStore.addFromCreds("Broken", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 0,
    scopes: [],
  });
  const brokenPoller = new UsagePoller(
    brokenStore,
    new TokenRefresher(),
    new CredentialsManager(),
    () => 240,
    () => undefined,
    {
      readProfileCreds: () => ({
        accessToken: "other-access",
        refreshToken: "other-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:profile"],
      }),
    }
  );
  await (brokenPoller as never as { syncProfileConfigCreds(id: string, stored: unknown): Promise<unknown> })
    .syncProfileConfigCreds(brokenProfile.id, await brokenStore.getCreds(brokenProfile.id));
  check(
    "does not import isolated credentials over incomplete stored profile",
    (await brokenStore.getCreds(brokenProfile.id))?.refreshToken === ""
  );

  const restartStore = createStore();
  const refreshExpiry = Date.now() + 30 * 24 * 3_600_000;
  const restartProfile = await restartStore.addFromCreds("Restarted", {
    accessToken: "before-restart-access",
    refreshToken: "before-restart-refresh",
    expiresAt: Date.now() - 3_600_000,
    refreshTokenExpiresAt: refreshExpiry,
    scopes: ["user:profile"],
  });
  const afterRestart = {
    accessToken: "after-restart-access",
    refreshToken: "after-restart-refresh",
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: refreshExpiry,
    scopes: ["user:profile"],
  };
  const restartPoller = new UsagePoller(
    restartStore,
    new TokenRefresher(),
    new CredentialsManager(),
    () => 240,
    () => undefined,
    { readProfileCreds: () => afterRestart }
  );
  await (restartPoller as never as { syncProfileConfigCreds(id: string, stored: unknown): Promise<unknown> })
    .syncProfileConfigCreds(restartProfile.id, await restartStore.getCreds(restartProfile.id));
  check(
    "restart imports Claude's rotated tokens when refresh-token expiry is unchanged",
    (await restartStore.getCreds(restartProfile.id))?.refreshToken === "after-restart-refresh"
  );

  const staleReplica = {
    ...afterRestart,
    refreshToken: "stale-refresh",
  };
  const stalePoller = new UsagePoller(
    restartStore,
    new TokenRefresher(),
    new CredentialsManager(),
    () => 240,
    () => undefined,
    { readProfileCreds: () => staleReplica }
  );
  await (stalePoller as never as { syncProfileConfigCreds(id: string, stored: unknown): Promise<unknown> })
    .syncProfileConfigCreds(restartProfile.id, await restartStore.getCreds(restartProfile.id));
  check(
    "equal-age replica cannot restore an already spent refresh token",
    (await restartStore.getCreds(restartProfile.id))?.refreshToken === "after-restart-refresh"
  );

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const recoveredStore = createStore();
    const recoveredProfile = await recoveredStore.addFromCreds("Recoverable", {
      accessToken: "spent-access",
      refreshToken: "spent-refresh",
      expiresAt: Date.now() - 3_600_000,
      refreshTokenExpiresAt: refreshExpiry,
      scopes: ["user:profile"],
    });
    await recoveredStore.updateUsage(recoveredProfile.id, {
      fetchedAt: Date.now(),
      windows: [],
      sessionPercent: null,
      weeklyPercent: null,
      error: "Failed to refresh token: HTTP 400 invalid_grant",
    });
    const recoveredPoller = new UsagePoller(
      recoveredStore,
      new TokenRefresher(),
      new CredentialsManager(),
      () => 240,
      () => undefined,
      { readProfileCreds: () => afterRestart }
    );
    await recoveredPoller.pollOne(recoveredProfile.id, false);
    check(
      "recovers a profile marked invalid when Claude persisted a newer generation",
      (await recoveredStore.getCreds(recoveredProfile.id))?.refreshToken ===
        "after-restart-refresh" && fetchCalls === 1
    );
    fetchCalls = 0;

    const skippedStore = createStore();
    const skippedProfile = await skippedStore.addFromCreds("Needs auth", {
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: 0,
      scopes: ["user:profile"],
    });
    await skippedStore.updateUsage(skippedProfile.id, {
      fetchedAt: Date.now(),
      windows: [],
      sessionPercent: null,
      weeklyPercent: null,
      error:
        "Failed to refresh token: HTTP 400 from token endpoint: {\"error\":\"invalid_grant\"}",
    });
    const skippedPoller = new UsagePoller(
      skippedStore,
      new TokenRefresher(),
      new CredentialsManager(),
      () => 240,
      () => undefined
    );
    await skippedPoller.pollOne(skippedProfile.id, false);
    check("skips automatic retry after invalid_grant", fetchCalls === 0);
    await skippedPoller.pollOne(skippedProfile.id, true);
    check("skips forced retry after invalid_grant", fetchCalls === 0);

    const activeStore = createStore();
    const activeProfile = await activeStore.addFromCreds("Active", {
      accessToken: "expired-access",
      refreshToken: "must-not-be-spent",
      expiresAt: Date.now() - 1,
      scopes: ["user:profile"],
    });
    const activePoller = new UsagePoller(
      activeStore,
      new TokenRefresher(),
      new CredentialsManager(),
      () => 240,
      () => undefined,
      { isProfileActive: () => true }
    );
    await activePoller.pollOne(activeProfile.id, true);
    check("never refreshes a token owned by an active Claude window", fetchCalls === 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runSwitchServiceTests(): Promise<void> {
  console.log("SwitchService:");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-switch-test-"));
  const credPath = path.join(tmpDir, ".credentials.json");
  process.env.TEST_CRED_PATH = credPath;

  const store = createStore();
  const manager = new CredentialsManager();
  const profile = await store.addFromCreds("Newater2", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  manager.writeCreds({
    accessToken: "current-access",
    refreshToken: "current-refresh",
    expiresAt: 222,
    scopes: ["user:profile"],
  });

  const service = new SwitchService(store, manager, new ClaudeSettingsManager(manager));
  const switchResult = await service.switchTo(profile.id);
  check(
    "incomplete profile switch requests reauthorization",
    !switchResult.ok && switchResult.reauthProfileId === profile.id
  );
  check(
    "switch does not store current login into incomplete profile",
    (await store.getCreds(profile.id))?.refreshToken === ""
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}


// --- API provider support -------------------------------------------------

function providerProfile(
  over: Partial<ProviderConfig> = {},
  extra: Partial<AccountProfile> = {}
): AccountProfile {
  return {
    id: "p" + Math.random().toString(36).slice(2),
    label: "test",
    kind: "api",
    addedAt: 0,
    order: 0,
    provider: {
      baseUrl: "https://api.deepseek.com/anthropic",
      authStyle: "authToken",
      ...over,
    },
    ...extra,
  };
}

function runProviderEnvTests(): void {
  console.log("providerEnv:");

  const authTokenEnv = buildProviderEnv(
    {
      baseUrl: "https://api.deepseek.com/anthropic",
      authStyle: "authToken",
      model: "deepseek-flash",
    },
    "sk-secret"
  );
  check("authToken style sets ANTHROPIC_AUTH_TOKEN", authTokenEnv.ANTHROPIC_AUTH_TOKEN === "sk-secret");
  check("authToken style leaves ANTHROPIC_API_KEY unset", !("ANTHROPIC_API_KEY" in authTokenEnv));
  check("base url is written", authTokenEnv.ANTHROPIC_BASE_URL === "https://api.deepseek.com/anthropic");
  check("model is written", authTokenEnv.ANTHROPIC_MODEL === "deepseek-flash");

  const apiKeyEnv = buildProviderEnv({ baseUrl: "https://example.com", authStyle: "apiKey" }, "sk-secret");
  check("apiKey style sets ANTHROPIC_API_KEY", apiKeyEnv.ANTHROPIC_API_KEY === "sk-secret");
  check("apiKey style leaves ANTHROPIC_AUTH_TOKEN unset", !("ANTHROPIC_AUTH_TOKEN" in apiKeyEnv));

  // OpenRouter documents that ANTHROPIC_API_KEY must be present but empty.
  const openrouter = getPreset("openrouter")!;
  const orEnv = buildProviderEnv(
    { baseUrl: openrouter.baseUrl, authStyle: "authToken", extraEnv: openrouter.extraEnv },
    "sk-or-key"
  );
  check("preset extraEnv can pin an empty ANTHROPIC_API_KEY", orEnv.ANTHROPIC_API_KEY === "");
  check("empty api key does not clobber the bearer token", orEnv.ANTHROPIC_AUTH_TOKEN === "sk-or-key");

  // extraEnv must never be able to overwrite the credential we authenticate with.
  const hostile = buildProviderEnv(
    {
      baseUrl: "https://example.com",
      authStyle: "authToken",
      extraEnv: { ANTHROPIC_AUTH_TOKEN: "hijacked", API_TIMEOUT_MS: "1000" },
    },
    "real-key"
  );
  check("core vars win over extraEnv", hostile.ANTHROPIC_AUTH_TOKEN === "real-key");
  check("unrelated extraEnv survives", hostile.API_TIMEOUT_MS === "1000");

  const cleared = keysToClear(["ANTHROPIC_BASE_URL", "API_TIMEOUT_MS"], { ANTHROPIC_BASE_URL: "x" });
  check("keysToClear keeps keys the new env sets", !cleared.includes("ANTHROPIC_BASE_URL"));
  check("keysToClear drops a previously managed extra key", cleared.includes("API_TIMEOUT_MS"));
  check("keysToClear always covers the core set", cleared.includes("ANTHROPIC_AUTH_TOKEN"));

  const keys = managedKeysFor(providerProfile({ extraEnv: { API_TIMEOUT_MS: "1" } }));
  check("managedKeysFor includes profile extraEnv", keys.includes("API_TIMEOUT_MS"));
}

function runClaudeSettingsTests(): void {
  console.log("ClaudeSettingsManager:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-settings-"));
  process.env.TEST_CRED_PATH = path.join(dir, ".credentials.json");
  const settings = new ClaudeSettingsManager(new CredentialsManager());
  const file = path.join(dir, "settings.json");

  // A realistic pre-existing file: user hooks/permissions plus a hand-written env entry.
  fs.writeFileSync(
    file,
    JSON.stringify({
      permissions: { allow: ["Bash"] },
      hooks: { Stop: [] },
      model: "opus",
      env: { MY_OWN_VAR: "keep-me" },
    })
  );

  settings.applyEnv({ ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" }, []);
  let after = JSON.parse(fs.readFileSync(file, "utf8"));
  check("unrelated top-level settings survive", after.model === "opus" && after.hooks !== undefined);
  check("permissions survive", after.permissions.allow[0] === "Bash");
  check("hand-written env entries survive", after.env.MY_OWN_VAR === "keep-me");
  check("provider var is written", after.env.ANTHROPIC_BASE_URL === "https://api.deepseek.com/anthropic");

  // Switching back to a subscription must strip only what we own.
  settings.applyEnv({}, keysToClear(["ANTHROPIC_BASE_URL"], {}));
  after = JSON.parse(fs.readFileSync(file, "utf8"));
  check("managed vars are removed on switch back", after.env.ANTHROPIC_BASE_URL === undefined);
  check("hand-written env still survives the cleanup", after.env.MY_OWN_VAR === "keep-me");
  check("other settings still intact after cleanup", after.model === "opus");

  // With nothing left of ours, an env block that becomes empty is dropped entirely.
  fs.writeFileSync(file, JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: "x" } }));
  settings.applyEnv({}, ["ANTHROPIC_BASE_URL"]);
  after = JSON.parse(fs.readFileSync(file, "utf8"));
  check("empty env block is removed", !("env" in after));

  settings.applyEnv({ ANTHROPIC_MODEL: "deepseek-flash" }, []);
  check("readEnv reads back written values", settings.readEnv().ANTHROPIC_MODEL === "deepseek-flash");

  // Never destroy a file we cannot parse.
  fs.writeFileSync(file, "{ this is not json");
  let refused = false;
  try {
    settings.applyEnv({ ANTHROPIC_BASE_URL: "y" }, []);
  } catch {
    refused = true;
  }
  check("malformed settings.json is refused, not overwritten", refused);
  check("malformed file left untouched", fs.readFileSync(file, "utf8") === "{ this is not json");

  // Creating from scratch when no settings.json exists yet.
  fs.rmSync(file);
  settings.applyEnv({ ANTHROPIC_BASE_URL: "https://z" }, []);
  check(
    "creates settings.json when absent",
    JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL === "https://z"
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

function runCompatTests(): void {
  console.log("Conversation compatibility:");

  check(
    "trailing slash ignored",
    normalizeBaseUrl("https://API.deepseek.com/anthropic/") === "https://api.deepseek.com/anthropic"
  );
  check("default https port ignored", normalizeBaseUrl("https://x.com:443/a") === normalizeBaseUrl("https://x.com/a"));
  check("path is significant", normalizeBaseUrl("https://x.com/a") !== normalizeBaseUrl("https://x.com/b"));

  const oauthOld: AccountProfile = { id: "a", label: "Max #1", addedAt: 0, order: 0 };
  const oauthNew: AccountProfile = { id: "b", label: "Max #2", kind: "oauth", addedAt: 0, order: 1 };
  check("profile without kind is treated as a subscription", compatKey(oauthOld) === OAUTH_COMPAT_KEY);
  check("all subscriptions are interchangeable", isCompatible(oauthOld, oauthNew));

  const ds1 = providerProfile({ model: "deepseek-flash" });
  const ds2 = providerProfile({ model: "deepseek-flash" });
  const dsReasoner = providerProfile({ model: "deepseek-reasoner" });
  check("same endpoint + model, different key is safe", isCompatible(ds1, ds2));
  check("same provider, different model is not safe", !isCompatible(ds1, dsReasoner));
  check("subscription vs provider is not safe", !isCompatible(oauthOld, ds1));

  // One OpenRouter account can route to different model families.
  const orClaude = providerProfile({
    baseUrl: "https://openrouter.ai/api",
    model: "~anthropic/claude-opus-latest",
  });
  const orDeepseek = providerProfile({
    baseUrl: "https://openrouter.ai/api",
    model: "deepseek/deepseek-chat",
  });
  check("same gateway, different model family is not safe", !isCompatible(orClaude, orDeepseek));

  // A [1m] variant changes the context window, so it is a different identity.
  const glm = providerProfile({ baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "glm-5.2" });
  const glm1m = providerProfile({ baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "glm-5.2[1m]" });
  check("[1m] variant is a distinct identity", !isCompatible(glm, glm1m));

  // Manual override wins over the automatic key.
  const manualA = providerProfile({ model: "deepseek-flash" }, { compatGroup: "mine" });
  const manualB = providerProfile({ baseUrl: "https://other.example/anthropic", model: "x" }, { compatGroup: "mine" });
  check("manual compat group overrides base url and model", isCompatible(manualA, manualB));
  check("manual group does not leak into automatic profiles", !isCompatible(manualA, ds1));
}

function runActiveResolutionTests(): void {
  console.log("Active profile resolution:");

  // A pinned env block, not .credentials.json, decides which profile is really active - the
  // subscription tokens are deliberately left on disk when a provider is in use.
  const sub: AccountProfile = { id: "sub", label: "Max #1", addedAt: 0, order: 0 };
  const flash = providerProfile({ model: "deepseek-flash" }, { id: "flash", label: "DS flash" });
  const reasoner = providerProfile({ model: "deepseek-reasoner" }, { id: "reason", label: "DS reasoner" });
  const profiles = [sub, flash, reasoner];

  check(
    "pinned base url + model selects the right provider profile",
    findProfileForEnv(profiles, "https://api.deepseek.com/anthropic", "deepseek-reasoner")?.id === "reason"
  );
  check(
    "url normalisation applies when resolving",
    findProfileForEnv(profiles, "https://API.deepseek.com/anthropic/", "deepseek-flash")?.id === "flash"
  );
  check(
    "an unpinned env resolves to nothing, leaving credentials in charge",
    findProfileForEnv(profiles, undefined, undefined) === undefined
  );
  check(
    "an unknown endpoint never claims a profile",
    findProfileForEnv(profiles, "https://unknown.example/anthropic", "x") === undefined
  );
  check(
    "a subscription profile is never matched by an env pin",
    findProfileForEnv([sub], "https://api.anthropic.com", undefined) === undefined
  );
  check(
    "ambiguous model falls back to the first profile on that endpoint",
    findProfileForEnv(profiles, "https://api.deepseek.com/anthropic", "who-knows")?.id === "flash"
  );
}

function runSessionScanTests(): void {
  console.log("Session scan:");

  check(
    "cwd is sanitised the same way Claude Code does",
    sanitizeCwd("e:\\Projects\\AI-Trading") === "e--Projects-AI-Trading"
  );

  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sessions-"));
  const cwd = "e:\\Demo\\Proj";
  const dir = path.join(cfg, "projects", sanitizeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "thinking", signature: "sig" }],
      },
    }),
    JSON.stringify({ type: "summary", leafUuid: "x" }),
  ];
  fs.writeFileSync(path.join(dir, "s1.jsonl"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "s2.jsonl"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");

  const scan = scanSessions(cfg, cwd);
  check("counts transcripts for the folder", scan.count === 2);
  check("reports the newest model", scan.newestModel === "claude-opus-5");
  check("reports a newest timestamp", typeof scan.newestMtime === "number");

  const synthetic = path.join(dir, "s3.jsonl");
  fs.writeFileSync(synthetic, JSON.stringify({ message: { model: "<synthetic>" } }) + "\n");
  check("synthetic model names are skipped", readLastModel(synthetic) === undefined);

  check("unknown folder scans clean", scanSessions(cfg, "e:\\Nope").count === 0);
  fs.rmSync(cfg, { recursive: true, force: true });

  const empty = { count: 0, dirs: [] };
  const some = { count: 3, dirs: ["d"] };
  check("never mode stays silent", !shouldWarnOnSwitch("never", some));
  check("always mode warns with no sessions", shouldWarnOnSwitch("always", empty));
  check("default mode is quiet in a fresh folder", !shouldWarnOnSwitch("whenSessionsExist", empty));
  check("default mode warns when sessions exist", shouldWarnOnSwitch("whenSessionsExist", some));
}

async function runTokenRefresherTests(): Promise<void> {
  console.log("TokenRefresher:");
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: "user:profile user:inference",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const before = Date.now();
    const refreshed = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 111,
      refreshTokenExpiresAt: 222,
      scopes: ["user:profile", "user:inference"],
      clientId: "custom-client",
    });
    const body = JSON.parse(String(capturedInit?.body));
    const headers = capturedInit?.headers as Record<string, string>;

    check("uses current Claude Code token endpoint", capturedUrl === "https://platform.claude.com/v1/oauth/token");
    check("sends JSON token refresh body", headers["Content-Type"] === "application/json");
    check("sends oauth beta header", headers["anthropic-beta"] === "oauth-2025-04-20");
    check("sends user agent", headers["User-Agent"] === "claude-code-account-switcher");
    check("includes grant type", body.grant_type === "refresh_token");
    check("includes refresh token", body.refresh_token === "old-refresh");
    check("uses credential clientId when present", body.client_id === "custom-client");
    check("includes credential scopes", body.scope === "user:profile user:inference");
    check("stores rotated access token", refreshed.creds?.accessToken === "next-access");
    check("stores rotated refresh token", refreshed.creds?.refreshToken === "next-refresh");
    check("stores refresh token expiry", (refreshed.creds?.refreshTokenExpiresAt ?? 0) >= before + 7_199_000);
    check("updates response scopes", refreshed.creds?.scopes.join(" ") === "user:profile user:inference");

    capturedInit = undefined;
    await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 111,
      scopes: [],
    });
    const defaultScopeBody = JSON.parse(String(capturedInit?.body));
    check(
      "uses default Claude Code scopes when missing",
      defaultScopeBody.scope === "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
    );

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const missingRefresh = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "",
      expiresAt: 111,
      scopes: [],
    });
    check("does not request without refresh token", !missingRefresh.ok && fetchCalls === 0);
    check("missing refresh token requires reauthorization", missingRefresh.requiresReauthorization === true);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token not found or invalid",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;
    const invalidGrant = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "dead-refresh",
      expiresAt: 111,
      scopes: ["user:profile"],
    });
    check("invalid_grant requires reauthorization", invalidGrant.requiresReauthorization === true);
    check("invalid_grant error stays recognizable", requiresProfileReauthorization(invalidGrant.error));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runProfileActivityTests();
runBrowserOAuthTests();
runAccountStoreTests()
  .then(runUsagePollerTests)
  .then(runSwitchServiceTests)
  .then(runProviderEnvTests)
  .then(runClaudeSettingsTests)
  .then(runCompatTests)
  .then(runActiveResolutionTests)
  .then(runSessionScanTests)
  .then(runTokenRefresherTests)
  .then(() => {
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
