// Minimal "vscode" module stub so pure-logic modules can be tested under plain Node.
const cfg = {
  get: (key, def) => {
    if (key === "credentialsPath") {
      return process.env.TEST_CRED_PATH || "";
    }
    // Tests exercise switch logic headlessly; never pop a modal.
    if (key === "warnOnIncompatibleSwitch") {
      return process.env.TEST_WARN_MODE || "never";
    }
    return def;
  },
};

// Records the last message so tests can assert what the user would have been shown.
const shown = { info: [], warning: [], commands: [] };

module.exports = {
  workspace: {
    getConfiguration: () => cfg,
    workspaceFolders: undefined,
  },
  window: {
    showInformationMessage: async (msg) => {
      shown.info.push(msg);
      return undefined;
    },
    showWarningMessage: async (msg) => {
      shown.warning.push(msg);
      return undefined;
    },
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
  },
  commands: {
    executeCommand: async (id) => {
      shown.commands.push(id);
      return undefined;
    },
  },
  __shown: shown,
};
