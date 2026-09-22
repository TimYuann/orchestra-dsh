# DSH 0.1.7-alpha.1 implementation report

Package remains `0.5.1`. Commits: `6a0f0d8` (declaration migration, roles, lanes, playbook), `2386304` (governed lazy lifecycle/regressions), `5547404` (prior report), and the final C8 retry commit below.

## Implemented first-part scope

- Replaced removed `dsh-agent-presets` and client runtime imports with 0.1.7 registry/client APIs. Orchestra's twelve ids ship as declaration-owned bundle rows; legacy file-root/file-mount behavior rejects loudly.
- Added V4 `plugin:orchestra` notices, client slot augmentation, target catalog behavior, bundled native preset-authoring skill and declaration example. The playbook directs authors to the native composition/plugin/reference skills.
- Reworked thin role personas and driver guidance; direct work, native children, independent Sessions, and Teams remain distinct choices. Existing topology defaults remain Session.
- Added lane-first incremental mission records (objective, scope, constraints, acceptance, relationship, participants, new roles) and existing-role reuse without seat creation. Team render exposes lanes and notice failures.
- Persisted native child persona/toolFilter, uses them on materialization, routes subsequent child dispatch through native `sendMessage`, and assigns a fresh child identity on takeover. Per-node model remains explicit when supplied; unspecified routes inherit the driver/default selection seam.
- Governed lazy Session creation/retry reconstructs the reserved governed blueprint and uses public `sessionController.resolveAgent` for persisted ordinary Sessions. Registered turn-stopping returns the awaited Promise.
- Formal dismiss requires child drain or Session cancel followed by `whenIdle()` before archive publication. Successful `orchestra_dismiss` output declares `reason` and `summary`.
- C8: a dismissal now persists `{archiveId,dismissedAt}` on the active Team before snapshot write. A marker-CAS interruption retries that exact archive id, reconciles only the matching Team/timestamp snapshot, and never selects an unrelated newest archive. A later lifecycle receives a distinct attempt/archive id.

## Validation

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm test` — **283 pass / 0 fail / 0 cancelled**.
- `npm pack --ignore-scripts --cache /tmp/dsh-npm-cache --json` — passed; package includes `presets/orchestra-roles.patch.yml` and `skills/orchestra-preset-authoring/SKILL.md`.

The previous baseline's 284 tests became 282 because two obsolete standalone S3 tests (file-root ID mount and missing-roster behavior) were consolidated into the one target-native declaration-mount test while file overrides became explicitly unsupported. That consolidated test now asserts all three required behaviors: reject file presets, mount a declared ID, and typed failure without registry. The final C8 injected-failure test raises the current total to 283.

## PENDING-RUNTIME (parent-only)

Pack/install only into `dev-orchestra:4600`, remove the obsolete profile preset-root override, and do not add a registry override. In a new Session validate browser slot registration, registry composition, create→persist→dispatch (including child persona/filter), Session Controller restore, strict stop, and cross-restart identity. Do not touch web, old shared dev, global settings, historical sessions, processes, or ports.

Existing file-only custom presets and children created before persona/filter persistence cannot be repaired in place; use declared/new-instance handoff.

Audit provenance: `/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/222843dd-e1bf-46a4-8835-7c4ddf53a589/upgrade/audit-017.md`.
