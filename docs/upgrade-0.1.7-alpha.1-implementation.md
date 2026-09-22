# DSH 0.1.7-alpha.1 implementation report

Package remains `0.5.1`. Commits: `6a0f0d8` (declaration migration, roles, lanes, playbook) and `2386304` (governed lazy lifecycle completion/regressions).

## Implemented first-part scope

- Replaced removed `dsh-agent-presets` and client runtime imports with 0.1.7 registry/client APIs. Orchestra's twelve ids ship as declaration-owned bundle rows; legacy file-root/file-mount behavior rejects loudly.
- Added V4 `plugin:orchestra` notices, client slot augmentation, target catalog behavior, bundled native preset-authoring skill and declaration example. The playbook directs authors to the native composition/plugin/reference skills.
- Reworked thin role personas and driver guidance; direct work, native children, independent Sessions, and Teams remain distinct choices. Existing topology defaults remain Session.
- Added lane-first incremental mission records (objective, scope, constraints, acceptance, relationship, participants, new roles) and existing-role reuse without seat creation. Team render exposes lanes and notice failures.
- Persisted native child persona/toolFilter, uses them on materialization, routes subsequent child dispatch through native `sendMessage`, and assigns a fresh child identity on takeover.
- Governed lazy Session creation/retry reconstructs the reserved governed blueprint and uses it for creation. A disk-existing ordinary Session restores through public `sessionController.resolveAgent`, not a private resume seam. Registered turn-stopping now returns the awaited Promise.
- Formal dismiss now requires child drain or Session cancel followed by `whenIdle()` before archive publication. Successful `orchestra_dismiss` output declares `reason` and `summary`.
- Updated old source-count/file-root/V3/catalog fixture assertions into target-native checks, plus harnesses that model target unpublished setup and `whenIdle` behavior.

## Validation

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm test` — **282 pass / 0 fail / 0 cancelled**.
- `npm pack --ignore-scripts --cache /tmp/dsh-npm-cache --json` — passed; package includes `presets/orchestra-roles.patch.yml` and `skills/orchestra-preset-authoring/SKILL.md`.

## Parent-only runtime validation

Pack/install only into `dev-orchestra:4600`, remove the obsolete profile preset-root override, and do not add a registry override. In a new Session validate browser slot registration, registry composition, create→persist→dispatch (including child persona/filter), Session Controller restore, strict stop, and cross-restart identity. Do not touch web, old shared dev, global settings, historical sessions, processes, or ports.

## Residuals

- Runtime/browser/cross-restart validation remains parent-owned and is not claimed by unit tests.
- Existing file-only custom presets and children created before persona/filter persistence cannot be repaired in place; use declared/new-instance handoff.
- Archive CAS-after-snapshot retry still needs a persisted dismissal-attempt identity to prove snapshot reuse under that interruption; this is not covered by the current strict-stop path.

Audit provenance: `/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/222843dd-e1bf-46a4-8835-7c4ddf53a589/upgrade/audit-017.md`.
