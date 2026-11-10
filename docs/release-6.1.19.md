# Fame Codex 6.1.19

- Add **Sleep / Wake** in Settings. Sleep restores the previous Codex routing configuration without removing the launcher, tunnel credentials, or ChatGPT session. It remains asleep across launcher restarts. Wake reconnects the bridge. Restart Codex after either action.
- Fix model detection for the current ChatGPT model picker. A missing retired button attribute no longer causes Sol-capable accounts to be recorded as Luna-only. Run **Setup → Reinstall**, then restart Codex to refresh the model list.
- Recheck saved tunnel credentials when opening MCP setup and before reconnecting. Show the credential fields when saved credentials are missing, and report a specific recovery message.
- Keep the patched minimatch version for current build tools while preserving the older API required by legacy packaging dependencies.

Sleep restores only settings managed by Fame Codex; it does not delete the entire Codex configuration. The ChatGPT plugin and tunnel remain installed.
