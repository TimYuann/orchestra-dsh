# DSH 0.1.7-alpha.1 implementation report

> **Latest checkpoint: `f54383c` is WIP, with three TypeScript failures; last green commit is `f479b23` (292/292).** Full continuation, pending source defects and v2 design blockers: [handoff-2026-09-22-upgrade.md](handoff-2026-09-22-upgrade.md). Earlier results below belong to their named snapshots, not to current HEAD.

Package remains `0.5.1`. Commits: `6a0f0d8` (declaration migration, roles/lanes), `2386304` (lazy lifecycle), `ecd9db7` (C8 retry), **`3bd275b`** (parent's actual right-sizing guidance, full runtime playbook, catalog-generated declarations). Reports before the last commit overstated driver-guidance delivery and installed composition parity; these were found and corrected during parent takeover. Follow-up investigation completed and found remaining production defects; this is not a final acceptance report.

## Migration and intermediate implementation (not full scope acceptance)

- Replaced removed `dsh-agent-presets` and client runtime imports with 0.1.7 registry/client APIs. Orchestra's twelve ids ship as declaration-owned bundle rows; legacy file-root/file-mount behavior rejects loudly.
- Added V4 `plugin:orchestra` notices, client slot augmentation, target catalog behavior, bundled native preset-authoring skill and declaration example. The playbook directs authors to the native composition/plugin/reference skills.
- Reworked thin role personas and driver guidance; direct work, native children, independent Sessions, and Teams remain distinct choices. Existing topology defaults remain Session.
- Added lane-first incremental mission records (objective, scope, constraints, acceptance, relationship, participants, new roles) and existing-role reuse without seat creation. Team render exposes lanes and notice failures.
- Persisted native child persona/toolFilter, uses them on materialization, routes subsequent child dispatch through native `sendMessage`, and assigns a fresh child identity on takeover. Per-node model remains explicit when supplied; unspecified routes inherit the driver/default selection seam.
- Lazy Session reconstruction exists, but expected tool requirements are still confused with empty observed readiness; governed cold restore/replacement remains unfinished. Use public `ctx.agents.resume({setup: preparedBlueprint.setup})` with both setup parameters and returned commit, not SessionController's private resume helpers or post-publication-only checks. Registered turn-stopping returns the awaited Promise.
- Formal dismiss requires child drain or Session cancel followed by `whenIdle()` before archive publication. Successful `orchestra_dismiss` output declares `reason` and `summary`.
- C8: a dismissal now persists `{archiveId,dismissedAt}` on the active Team before snapshot write. A marker-CAS interruption retries that exact archive id, reconciles only the matching Team/timestamp snapshot, and never selects an unrelated newest archive. A later lifecycle receives a distinct attempt/archive id.

## Validation

- `npm run typecheck` — passed.
- `npm run build` — passed.
- Sol medium isolated checkpoint at `ecd9db7`: **283/283 pass**. Candidate patch then tested: **285/285 pass**, typecheck/build also passed.
- Tested patch SHA-256 `2ea67f375c5cbed047d6549f50146e48b526e52e965d36b43248d7c04442fe7b` exactly matched the staged diff committed as `3bd275b`.
- `npm pack --cache /tmp/dsh-npm-cache` and extracted package import passed. Tarball `/tmp/orchestra-ecd9db7-checkpoint.yC635u/orchestra-dsh-0.5.1.tgz`, SHA-256 `00a2788f5103ff3fd717fcd5461681540cfdc53c58b48275f46b50ff70cf9a96`.
- Native target registry accepted all 12 generated declarations with no import/config errors. Full host services were absent in that probe; waiting fibers do **not** prove live persona/tools activation.
- Runtime-loaded playbook equals the packed SKILL.md; generated declaration equals the complete catalog composition (skills/planning/compaction included). These were missing from the earlier handoff.
- Evidence: `/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/14914f7b-24f3-4c0a-95ed-fb14ad389ffc/evidence/checkpoint-tests.md`.

The previous baseline's 284 tests became 282 because two obsolete standalone S3 tests (file-root ID mount and missing-roster behavior) were consolidated into the one target-native declaration-mount test while file overrides became explicitly unsupported. That consolidated test now asserts all three required behaviors: reject file presets, mount a declared ID, and typed failure without registry. The C8 injected-failure test raised that checkpoint to 283. Parent added declaration parity and truthful right-sizing checks, giving **285** in the tested candidate.

## Later verified fixes and current blocker

- `f479b23`: child persona/filter normalization and takeover identity, strict native drain and shared /team dismissal, snapshot supersession after late reports. Sol verified the exact patch in a fresh snapshot: **292/292**, typecheck passed; seven new regressions integrated.
- `f54383c`: model inheritance and registered lane mission fields, owner/responsibilities and reuse render; old tier module removed. **Typecheck and npm test both exit 2 before tests run**: generic JSON lane renderer, generic role input vs typed handler, and absent owner in team projection. Fixed snapshot `/tmp/orchestra-f479b23-model-lane.KpX6TB`; probes are ready there, not yet executed.
- No current completed runtime test or release artifact exists. The previously packed file corresponds only to `3bd275b`.

## PENDING-RUNTIME

Parent integrates; Sol medium/xhigh test agents may execute against a specifically handed-off instance and new test sessions. Install only into `dev-orchestra:4600`. It was newly initialized from the official web template, so do not assume an obsolete root override exists or edit another profile looking for one; no registry override is needed. In a new Session validate browser slot registration, registry composition, create→persist→dispatch (including child persona/filter), Session Controller restore, strict stop, and cross-restart identity. Do not touch web, old shared dev, global settings, historical sessions, processes, or ports.

Existing file-only custom presets and children created before persona/filter persistence cannot be repaired in place; use declared/new-instance handoff.

Audit provenance: `/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/222843dd-e1bf-46a4-8835-7c4ddf53a589/upgrade/audit-017.md`.
