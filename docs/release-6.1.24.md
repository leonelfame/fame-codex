# Fame Codex 6.1.24

- Add **Settings → Trusted Codex homes**. Choose other Codex homes, such as an Orca account, so ChatGPT chats can recover their working folder (`cwd`) from sessions stored there. Each folder must contain a `sessions` folder, at most seven can be added, and the change applies the next time the launcher-owned runtime starts.
- TH AI Pass: retry a malformed tool call up to twice before reporting an error, enforce single-call turns when parallel tool calls are disabled, and give clearer messages when the browser extension is disconnected, timed out, or its tab is sleeping.
- TH AI Pass: the extension prefers a tab that is not frozen and reports a sleeping tab instead of waiting for it.
- TH AI Pass prompts now tell the model that the supplied tools act on the real workspace and not to claim work a tool result does not confirm.

After updating, reload the TH AI Pass browser extension. To use an Orca account's history, add its Codex home under Trusted Codex homes, then restart Fame Codex.
