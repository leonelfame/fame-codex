# Fame Codex 6.1.28

- Fix TH AI Pass reasoning-effort selection: expose each available chat model's advertised thinking levels in Codex, and forward the selected effort to the browser bridge. Upstream `max` maps to Codex Extra High.
- Preserve per-model thinking metadata across extension discovery, launcher state, and the Codex model catalog. Models without advertised thinking controls continue using the website default.
- Model refresh now reports loader failures and empty results instead of treating a fallback or stale model list as fresh. The extension refresh button reports HTTP failures.
- Show advertised thinking levels in TH AI Pass settings and document how account eligibility and text-only filtering affect the visible model list.

After upgrading, reload the TH AI Pass Chrome/Edge extension, open a signed-in TH AI Pass chat tab, refresh models in Fame Codex Settings, then restart Codex and open a new session. Model and effort availability may differ by TH AI Pass account.
