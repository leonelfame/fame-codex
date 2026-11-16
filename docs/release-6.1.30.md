# Fame Codex 6.1.30

- Reject TH AI Pass responses when the upstream service switches away from an explicitly selected model. Errors identify the requested model, reported replacement, and insufficient-credit reason. Auto mode reports requested and upstream identities separately in Responses metadata.
- Preserve complete compaction source history and recover readable Native Codex checkpoints when switching to ChatGPT Web, including paginated native forks and runtime restarts. Large source instructions no longer get duplicated verbatim into checkpoints.
- Fix exact connector selection in the current ChatGPT mention menu, including the launcher maintenance viewport.
- Discover usable Orca account homes at launcher startup.
- Update the pinned Hono and Node server dependencies to versions that pass the release vulnerability audit.
- Accept stable Bun versions >=1.4.0 for local builds while keeping the exact CI/release pin.

Live local verification covered Native-to-Web continuity, automatic Web compaction, runtime restart, and real tool-created file proof. TH AI Pass verification covered named-model rejection on upstream credit fallback and Auto metadata in JSON and streaming responses. These checks do not guarantee that an upstream service can serve a model when its credits or availability are insufficient.

Keep a signed-in TH AI Pass browser tab open. Switching to another tab is supported; browser sleeping or discarded tabs can interrupt the extension connection.
