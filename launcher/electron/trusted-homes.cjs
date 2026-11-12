const fs = require("node:fs");
const path = require("node:path");

const MAX_TRUSTED_HOMES = 7;
const MAX_ENVIRONMENT_LENGTH = 4096;

function validateTrustedHomes(homes) {
  if (!Array.isArray(homes) || homes.length > MAX_TRUSTED_HOMES) throw new Error("Select at most seven Codex homes.");
  const seen = new Set();
  return homes.map((home) => {
    if (typeof home !== "string" || !path.isAbsolute(home) || /^(?:\\\\|\/\/)/.test(home)) {
      throw new Error("Codex homes must be absolute local directories.");
    }
    const resolved = fs.realpathSync(home);
    if (!fs.statSync(resolved).isDirectory() || !fs.statSync(path.join(resolved, "sessions")).isDirectory()) {
      throw new Error("Select a Codex home containing a sessions directory.");
    }
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) throw new Error("This Codex home is already selected.");
    seen.add(key);
    return resolved;
  });
}

// Saved homes can disappear between launches (removed account, unplugged drive). The runtime
// rejects a missing trusted home outright, so drop stale entries instead of blocking startup.
function usableTrustedHomes(homes) {
  const usable = [];
  for (const home of Array.isArray(homes) ? homes : []) {
    try { usable.push(...validateTrustedHomes([home])); } catch { /* skip */ }
  }
  return validateTrustedHomes([...new Map(usable.map(home => [process.platform === "win32" ? home.toLowerCase() : home, home])).values()]);
}

// Returns the CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES value, or null when nothing is registered.
function trustedHomesEnvironment(homes) {
  const usable = usableTrustedHomes(homes);
  if (usable.length === 0) return null;
  const value = JSON.stringify(usable);
  if (value.length > MAX_ENVIRONMENT_LENGTH) throw new Error("Selected Codex home paths are too long.");
  return value;
}

module.exports = { validateTrustedHomes, usableTrustedHomes, trustedHomesEnvironment };
