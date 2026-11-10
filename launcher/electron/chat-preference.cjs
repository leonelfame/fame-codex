// Normalize legacy Fame preferences at the persisted-data boundary. Canonical values win.
function migrateChatPreference(value) {
  if (!Object.hasOwn(value, "useSavedChats")) return value;
  const result = { ...value };
  if (result.useTemporaryChats === undefined && typeof result.useSavedChats === "boolean") {
    result.useTemporaryChats = !result.useSavedChats;
  }
  delete result.useSavedChats;
  return result;
}

module.exports = { migrateChatPreference };
