# DSH 0.1.7-alpha.1 implementation report

Package remains 0.5.1. The migration replaces removed `dsh-agent-presets` and client runtime imports with declaration registry/client renderer APIs, ships the Orchestra declaration patch and the preset-authoring skill, emits V4 `plugin:orchestra` notices, and adapts the durable child catalog. Role state now preserves native child persona/tool filters and later child dispatch uses the native continuation seam. Turn-stopping registration returns its Promise. Incremental lanes are lane-first mission records and may reuse existing roles without reserving seats.

Validation run locally: `npm run typecheck` and `npm run build` passed. The legacy full suite was run during migration; 275 passed and 9 stale assertions failed because they freeze removed file-root/mount APIs, V3 sources, and obsolete child activity facts. These tests require target-native rewrites before release; no runtime claim follows from this report.

Parent-only next steps: pack with `npm pack --cache /tmp/dsh-npm-cache`, install only into `dev-orchestra:4600`, remove obsolete profile preset-root overrides, then validate browser slot registration, registry composition, create→persist→dispatch, strict stop, and cross-restart recovery in a new Session. Do not touch web, the old shared dev profile, historical sessions, or global settings. Existing file-only custom presets and children created before persona/filter persistence require a declared replacement/new handoff.

Audit provenance: `/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/222843dd-e1bf-46a4-8835-7c4ddf53a589/upgrade/audit-017.md`.
