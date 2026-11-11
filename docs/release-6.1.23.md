# Fame Codex 6.1.23

- Read the completed TH AI Pass loader record without waiting for the HTTP stream to close. This restores model discovery and temporary chat creation when the site keeps its stream open.
- Prefer the active or most recently used TH AI Pass chat tab, instead of an older retained tab that may be unresponsive.

Live tests on the installed bridge completed a text reply and a read-only file tool call with both Gemini 3.5 Flash Lite and Claude Opus 5.5. TH AI Pass remains experimental, and sleeping browser tabs can interrupt requests. Keep a signed-in TH AI Pass tab open and exclude the site from browser sleeping tabs.

After updating, reload the TH AI Pass browser extension and open a new Codex session. On Windows, exit Orca and Fame Codex before installing if Orca is holding the old application files open.
