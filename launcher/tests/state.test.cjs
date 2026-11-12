const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("../electron/state.cjs");

test("Beta update preference defaults off, persists, and rejects corrupt saved values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-update-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().includePrereleaseUpdates, false);
    store.update({ includePrereleaseUpdates: true });
    assert.equal(createStateStore(file).read().includePrereleaseUpdates, true);
    fs.writeFileSync(file, JSON.stringify({ version: 1, includePrereleaseUpdates: "true" }));
    assert.equal(createStateStore(file).read().includePrereleaseUpdates, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("predictions and Temporary Chat start on and preserve an explicit opt-out after reopening", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prediction-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().composerPredictionsEnabled, true);
    assert.equal(store.read().useTemporaryChats, true);
    store.update({ composerPredictionsEnabled: false, useTemporaryChats: false });
    assert.equal(createStateStore(file).read().composerPredictionsEnabled, false);
    assert.equal(createStateStore(file).read().useTemporaryChats, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy saved-chat booleans migrate inversely while canonical values win", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-chat-preference-"));
  const file = path.join(root, "state.json");
  try {
    for (const useSavedChats of [undefined, false, true, "retired-value"]) {
      for (const useTemporaryChats of [undefined, false, true, "invalid"]) {
        const stored = { version: 1, language: "ja", composerPredictionsEnabled: false,
          experimentalFreshConversationPerTurn: true, autoStart: false, useSavedChats, useTemporaryChats };
        fs.writeFileSync(file, JSON.stringify(stored));
        const store = createStateStore(file);
        const expected = typeof useTemporaryChats === "boolean" ? useTemporaryChats
          : useTemporaryChats === undefined && typeof useSavedChats === "boolean" ? !useSavedChats : true;
        assert.equal(store.read().useTemporaryChats, expected);
        assert.equal(Object.hasOwn(store.read(), "useSavedChats"), false);
        assert.equal(store.read().language, "ja");
        assert.equal(store.read().composerPredictionsEnabled, false);
        assert.equal(store.read().experimentalFreshConversationPerTurn, true);
        assert.equal(store.read().autoStart, false);
        assert.deepEqual(createStateStore(file).read(), store.read());
        store.update({});
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), store.read());
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("UTF-8 settings keep explicit choices with or without a byte order mark", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-utf8-state-"));
  const file = path.join(root, "state.json");
  try {
    const expected = createStateStore(file).update({
      coreSetupComplete: true,
      autoStart: false,
      useTemporaryChats: false,
      browserInteractionMode: "manual",
      browserSmokeVersion: "6.1.14\uFEFF-test",
    });
    for (const prefix of ["", "\uFEFF"]) {
      const contents = prefix + JSON.stringify(expected);
      fs.writeFileSync(file, contents);
      assert.deepEqual(createStateStore(file).read(), expected);
      assert.equal(fs.readFileSync(file, "utf8"), contents);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("launcher state persists onboarding, language, and autostart atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-codex-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), {
      version: 1,
      language: null,
      onboardingComplete: false,
      githubOpened: false,
      autoStart: true,
      keepRunningOnClose: true,
      includePrereleaseUpdates: false,
      showBrowserDuringTurns: true,
      autoApproveToolCalls: false,
      trustedCodexHomes: [],
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      composerPredictionsEnabled: true,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useTemporaryChats: true,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
    store.update({
      language: "zh-CN",
      onboardingComplete: true,
      keepRunningOnClose: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
    });
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: true,
      githubOpened: false,
      autoStart: true,
      keepRunningOnClose: false,
      includePrereleaseUpdates: false,
      showBrowserDuringTurns: true,
      autoApproveToolCalls: false,
      trustedCodexHomes: [],
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      composerPredictionsEnabled: true,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useTemporaryChats: true,
      zeroRiskProEnabled: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});

test("every supported launcher language survives a state update and reload", () => {
  const languages = require("../electron/languages.json");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-codex-locale-state-"));
  const file = path.join(root, "state.json");
  try {
    for (const language of Object.keys(languages)) {
      const store = createStateStore(file);
      store.update({ language, onboardingComplete: true });
      assert.equal(createStateStore(file).read().language, language);
      assert.equal(createStateStore(file).read().onboardingComplete, true);
    }
    for (const language of ["__proto__", "constructor", "unknown", [], {}]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, language, onboardingComplete: true }));
      const state = createStateStore(file).read();
      assert.equal(state.language, null);
      assert.equal(state.onboardingComplete, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persisted sidebar corruption is repaired without changing the rest of launcher state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-codex-sidebar-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "zh-CN",
      onboardingComplete: "yes",
      autoStart: "yes",
      experimentalFreshConversationPerTurn: "true",
      bridgeEnabled: false,
      browserSmokePassed: "yes",
      browserSmokeVersion: { invalid: true },
      sidebarOpen: "yes",
      sidebarWidth: 900,
      mcpGuideStep: 99,
      sessionRefreshReminderAt: "not-a-date",
      coreSetupComplete: "yes",
    }));
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: false,
      githubOpened: false,
      autoStart: true,
      keepRunningOnClose: true,
      includePrereleaseUpdates: false,
      showBrowserDuringTurns: true,
      trustedCodexHomes: [],
      autoApproveToolCalls: false,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      composerPredictionsEnabled: true,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      useTemporaryChats: true,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser interaction defaults to Automatic and preserves a completed onboarding choice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-codex-interaction-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().browserInteractionMode, "automatic");
    store.update({ browserInteractionMode: "manual", onboardingComplete: true });
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    store.update({ coreSetupComplete: true, zeroRiskProEnabled: true, experimentalFreshConversationPerTurn: true });
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, true);
    assert.equal(createStateStore(file).read().experimentalFreshConversationPerTurn, true);
    store.update({ browserInteractionMode: "automatic" });
    assert.equal(createStateStore(file).read().experimentalFreshConversationPerTurn, true);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      browserInteractionMode: "manual",
      zeroRiskProEnabled: true,
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      onboardingComplete: true,
      browserInteractionMode: "manual",
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    fs.writeFileSync(file, JSON.stringify({ version: 1, browserInteractionMode: "unsafe" }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session refresh reminders are deferred by exactly 48 hours", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  assert.equal(SESSION_REFRESH_REMINDER_INTERVAL_MS, 48 * 60 * 60 * 1000);
  assert.equal(nextSessionRefreshReminderAt(now), "2026-08-07T12:00:00.000Z");
  assert.throws(() => nextSessionRefreshReminderAt(Number.NaN), /must be finite/);
});
