function validateModelCapabilities(value) {
  if (!value || typeof value.solAvailable !== "boolean"
    || typeof value.extraHighAvailable !== "boolean" || typeof value.proAvailable !== "boolean"
    || (!value.solAvailable && (value.extraHighAvailable || value.proAvailable))) {
    throw new Error("ChatGPT returned incomplete or contradictory model capabilities. Previous settings were kept.");
  }
  return {
    solAvailable: value.solAvailable,
    extraHighAvailable: value.extraHighAvailable,
    proAvailable: value.proAvailable,
  };
}

function createModelRefresh({ browserHost, runtimeHost, supervisor }) {
  let checking = false;
  return async () => {
    if (checking) throw new Error("Model detection is already running");
    if (browserHost.activeTraceId || browserHost.currentOperation() || runtimeHost.currentOperation()) {
      throw new Error("Finish the active browser task before detecting models again");
    }
    const current = runtimeHost.runtimeConfigSnapshot();
    if (!current.configured) throw new Error("Initialize Fame Codex before detecting models");
    if (current.config.browserInteractionMode === "manual") {
      throw new Error("Switch to With Automation to detect ChatGPT models");
    }
    checking = true;
    try {
      const capabilities = validateModelCapabilities(await browserHost.inspectSession(true));
      await supervisor.refreshModelCapabilities(capabilities);
      return capabilities;
    } finally {
      checking = false;
    }
  };
}

module.exports = { createModelRefresh, validateModelCapabilities };
