# Fame Codex 6.1.21

- Add **Settings → ChatGPT models → Detect models again**. Detect available models from the signed-in account, save the result, and refresh the running bridge without restarting it. Failed detection preserves the previous settings. Open a new Codex session to load the refreshed model catalog.
- Increase the experimental TH AI Pass local prompt budget from 16K to 256K tokens. Count the complete outbound prompt with a tokenizer instead of estimating from raw request characters. Preserve instructions, tool schemas, and conversation history; existing 16K settings migrate automatically.
- Report TH AI Pass policy refusals explicitly without exposing the private prompt echoed in upstream errors.

**Known limitation:** TH AI Pass can still reject a Codex context with HTTP 422, `CHAT_RAI_VIOLATION` (Content Policy Violation). This release fixes the local budget rejection; it does not resolve upstream policy refusals or guarantee coding-agent compatibility. The 256K budget is a local limit, not a claim about any upstream model's capacity. Remote compaction remains unsupported.

Install through **Update** when you are ready to interrupt active work. Updating restarts Fame Codex and temporarily disconnects its bridge. After the app reopens, start a new Codex session. Do not remove your plugin or delete account data to refresh models.
