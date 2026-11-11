# Fame Codex 6.1.22

- Accept the `text.verbosity` preference sent by Codex. TH AI Pass now expresses low, medium, or high verbosity as a final-answer instruction instead of rejecting the request before contacting the model.
- Replace HTML-like tool-call delimiters with nonce-bound line markers. This avoids the extra closing angle bracket observed in live Gemini 3.5 Flash Lite tool responses. Tool names, arguments, nonce, and complete frames remain strictly validated before any call is exposed to Codex.

Live validation with Codex and TH AI Pass Gemini 3.5 Flash Lite completed both an exact `TEST_OK` reply and a real read-only terminal command (`Get-Content package.json -TotalCount 1`), followed by the model's `READ_OK` response using the command result. This verifies one model and these flows; it does not guarantee every listed model or tool.

TH AI Pass remains experimental. Upstream policy refusals, the local 256K prompt budget, text-only input, and unsupported remote compaction still apply.

After installing, open a new Codex session. If the Windows installer reports that it cannot uninstall the old application, close applications holding Fame Codex's installation files, including Orca when it has loaded `resources/app.asar`. Finish active work before quitting either application.
