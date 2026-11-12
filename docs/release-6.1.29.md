# Fame Codex 6.1.29

- Include the selected TH AI Pass model ID when creating an isolated temporary chat. Previously, only the subsequent send-message request carried that model selection, which could let the new chat start with the upstream default.
- Add regression coverage for temporary-chat creation and switching between Gemini, DeepSeek, and Claude models across consecutive isolated turns.

The bridge now carries the selected model through both conversation creation and message submission. The upstream service's actual model selection remains unverified: live requests returned HTTP 502 during diagnosis. A model's self-reported identity alone is not reliable verification.

After updating Fame Codex, reload the TH AI Pass browser extension, keep a signed-in TH AI Pass tab open, then start a new Codex session.
