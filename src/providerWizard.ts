import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CUSTOM_PRESET_ID, ProviderPreset, PROVIDER_PRESETS } from "./providerPresets";
import { AccountProfile, AuthStyle, ProviderConfig } from "./types";

/**
 * Multi-step native wizard for creating and editing API-provider profiles.
 *
 * Native QuickPick/InputBox rather than a webview form: the API key is typed into a real password
 * field, and there is no secret-bearing HTML to keep in sync.
 */

const CUSTOM_MODEL_ITEM = "$(edit) Enter a model name…";

export async function runAddProviderWizard(
  store: AccountStore
): Promise<AccountProfile | undefined> {
  const preset = await pickPreset();
  if (!preset) {
    return undefined;
  }

  const baseUrl = await pickBaseUrl(preset);
  if (!baseUrl) {
    return undefined;
  }

  const apiKey = await promptApiKey(preset);
  if (apiKey === undefined) {
    return undefined;
  }

  const model = await pickModel(preset);
  if (model === undefined) {
    return undefined;
  }

  const label = await promptLabel(suggestLabel(preset, model));
  if (!label) {
    return undefined;
  }

  return store.addProviderProfile(label, buildConfig(preset, baseUrl, model), apiKey);
}

/** Re-runs the same steps against an existing profile, leaving the key alone unless retyped. */
export async function runEditProviderWizard(
  store: AccountStore,
  id: string
): Promise<boolean> {
  const profile = store.get(id);
  if (!profile || profile.kind !== "api" || !profile.provider) {
    void vscode.window.showWarningMessage("That profile is not an API provider profile.");
    return false;
  }
  const current = profile.provider;
  const preset =
    PROVIDER_PRESETS.find((p) => p.id === current.presetId) ??
    PROVIDER_PRESETS.find((p) => p.id === CUSTOM_PRESET_ID)!;

  const baseUrl = await vscode.window.showInputBox({
    title: `Edit "${profile.label}" — base URL`,
    prompt: "ANTHROPIC_BASE_URL",
    value: current.baseUrl,
    ignoreFocusOut: true,
    validateInput: validateBaseUrl,
  });
  if (!baseUrl) {
    return false;
  }

  const model = await vscode.window.showInputBox({
    title: `Edit "${profile.label}" — model`,
    prompt: "ANTHROPIC_MODEL (leave empty to use the endpoint's default)",
    value: current.model ?? "",
    ignoreFocusOut: true,
  });
  if (model === undefined) {
    return false;
  }

  const next: ProviderConfig = {
    ...current,
    baseUrl: baseUrl.trim(),
    model: model.trim() || undefined,
    // Keep the tier aliases pointing at the main model unless they were customised away from it.
    opusModel: realignAlias(current.opusModel, current.model, model.trim()),
    sonnetModel: realignAlias(current.sonnetModel, current.model, model.trim()),
  };
  await store.updateProvider(id, next);

  const replaceKey = await vscode.window.showQuickPick(
    [
      { label: "$(check) Keep the stored API key", replace: false },
      { label: "$(key) Enter a new API key", replace: true },
    ],
    { title: `Edit "${profile.label}" — API key`, ignoreFocusOut: true }
  );
  if (replaceKey?.replace) {
    const apiKey = await promptApiKey(preset);
    if (apiKey) {
      await store.setApiKey(id, apiKey);
    }
  }

  return true;
}

/** Lets the user mark profiles as interchangeable mid-conversation, overriding (baseUrl, model). */
export async function promptCompatGroup(
  store: AccountStore,
  id: string
): Promise<boolean> {
  const profile = store.get(id);
  if (!profile) {
    return false;
  }
  const existing = [
    ...new Set(
      store
        .list()
        .map((p) => p.compatGroup?.trim())
        .filter((g): g is string => Boolean(g))
    ),
  ];

  const items: Array<vscode.QuickPickItem & { value?: string; clear?: boolean }> = [
    { label: "$(circle-slash) Automatic (base URL + model)", clear: true },
    ...existing.map((g) => ({ label: `$(link) ${g}`, value: g })),
    { label: "$(add) New group…", value: undefined },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Conversation compatibility for "${profile.label}"`,
    placeHolder:
      "Profiles in the same group are treated as safe to swap mid-conversation",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return false;
  }
  if (picked.clear) {
    await store.setCompatGroup(id, undefined);
    return true;
  }
  let group = picked.value;
  if (!group) {
    group = await vscode.window.showInputBox({
      title: "New compatibility group name",
      prompt: "Profiles sharing this name may continue each other's conversations",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    });
    if (!group) {
      return false;
    }
  }
  await store.setCompatGroup(id, group);
  return true;
}

// --- steps ---

async function pickPreset(): Promise<ProviderPreset | undefined> {
  const picked = await vscode.window.showQuickPick(
    PROVIDER_PRESETS.map((p) => ({
      label: p.label,
      description: p.baseUrl || "you provide the URL",
      detail: p.hint,
      preset: p,
    })),
    {
      title: "Add API provider — 1/5: provider",
      placeHolder: "Pick a provider (all values stay editable)",
      ignoreFocusOut: true,
      matchOnDescription: true,
    }
  );
  return picked?.preset;
}

async function pickBaseUrl(preset: ProviderPreset): Promise<string | undefined> {
  const options = [preset.baseUrl, ...(preset.altBaseUrls ?? [])].filter(Boolean);
  let value = options[0] ?? "";

  if (options.length > 1) {
    const picked = await vscode.window.showQuickPick(
      [
        ...options.map((url) => ({ label: url, url })),
        { label: CUSTOM_MODEL_ITEM.replace("model name", "different URL"), url: "" },
      ],
      {
        title: "Add API provider — 2/5: endpoint",
        placeHolder: "Pick the endpoint matching where your key was created",
        ignoreFocusOut: true,
      }
    );
    if (!picked) {
      return undefined;
    }
    value = picked.url;
  }

  return vscode.window.showInputBox({
    title: "Add API provider — 2/5: base URL",
    prompt: "ANTHROPIC_BASE_URL",
    value,
    ignoreFocusOut: true,
    validateInput: validateBaseUrl,
  });
}

async function promptApiKey(preset: ProviderPreset): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "Add API provider — 3/5: API key",
    prompt: preset.keyUrl ? `Get one at ${preset.keyUrl}` : "Provider API key",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Enter the API key"),
  });
}

async function pickModel(preset: ProviderPreset): Promise<string | undefined> {
  if (preset.models.length === 0) {
    return vscode.window.showInputBox({
      title: "Add API provider — 4/5: model",
      prompt: "ANTHROPIC_MODEL (leave empty to use the endpoint's default)",
      ignoreFocusOut: true,
    });
  }

  const picked = await vscode.window.showQuickPick(
    [
      ...preset.models.map((m, i) => ({
        label: m,
        description: preset.modelNotes?.[m] ?? (i === 0 ? "recommended" : undefined),
        model: m as string | undefined,
      })),
      { label: CUSTOM_MODEL_ITEM, description: undefined, model: undefined },
    ],
    {
      title: "Add API provider — 4/5: model",
      placeHolder: "Which model should this profile use?",
      ignoreFocusOut: true,
    }
  );
  if (!picked) {
    return undefined;
  }
  if (picked.model) {
    return picked.model;
  }
  return vscode.window.showInputBox({
    title: "Add API provider — 4/5: model",
    prompt: "ANTHROPIC_MODEL",
    ignoreFocusOut: true,
  });
}

async function promptLabel(suggested: string): Promise<string | undefined> {
  const label = await vscode.window.showInputBox({
    title: "Add API provider — 5/5: profile name",
    prompt: "Shown on the card and in the status bar",
    value: suggested,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
  });
  return label?.trim();
}

// --- helpers ---

function buildConfig(
  preset: ProviderPreset,
  baseUrl: string,
  model: string
): ProviderConfig {
  const main = model.trim() || undefined;
  return {
    presetId: preset.id,
    baseUrl: baseUrl.trim(),
    authStyle: preset.authStyle as AuthStyle,
    model: main,
    // Point every tier alias at a real model on this endpoint. Without this, `/model sonnet`
    // would send a literal `claude-sonnet-*` name that most third-party endpoints reject.
    opusModel: main,
    sonnetModel: main,
    haikuModel: preset.haikuModel ?? main,
    subagentModel: preset.subagentModel ?? preset.haikuModel ?? main,
    extraEnv: preset.extraEnv ? { ...preset.extraEnv } : undefined,
    wireFormat: preset.wireFormat,
  };
}

function suggestLabel(preset: ProviderPreset, model: string): string {
  const base = preset.id === CUSTOM_PRESET_ID ? "Custom provider" : preset.label;
  return model ? `${base} · ${model}` : base;
}

function realignAlias(
  alias: string | undefined,
  previousMain: string | undefined,
  nextMain: string
): string | undefined {
  // Only follow the main model if the alias was tracking it in the first place.
  if (!alias || alias === previousMain) {
    return nextMain || undefined;
  }
  return alias;
}

function validateBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Enter the base URL";
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Base URL must start with http:// or https://";
    }
  } catch {
    return "Not a valid URL";
  }
  return undefined;
}
