# orchestra — DSH Multi-Agent Orchestration

> Turn your DSH instance into an orchestra: roles use **first-class sessions by default**, with native continuable subagents available for compatible tasks.
> 把 DSH 变成一支乐队：角色默认使用**平级完整会话**，适合的任务也可显式选择原生 continuable 子代理。

`orchestra-dsh` is a multi-agent orchestration plugin for the DeepSeek Harness (DSH). One driver session starts a team toward a goal, roles have separate contexts (peer sessions by default, native subagents when explicitly selected), and the run — from onboarding to review to archiving — is coordinated through conversation. It ships two layers: an **A2A transport** for peer-to-peer messaging between any sessions, and an **orchestration layer** for project-scoped teams, roles, and topologies.

## Why — the idea（设计理念）

An **orchestration is a collaboration charter**（编排 = 协作宪章）, not a fixed pipeline. Before any team is created, the charter must answer seven questions:

1. Who does what;
2. Who owns each decision (one final owner per decision);
3. Where work goes when done;
4. What handoffs must carry;
5. Where disputes go;
6. When loops end;
7. Who declares the team complete.

The driver proposes a charter for your goal, you approve it, and only then are roles created. The plugin validates what it can prove (roles exist, ownership references resolve, one team per directory) and leaves the rest to role discipline — no brittle text parsing, no workflow engine.

Traditional agents use *plan mode*: a mode switch inside one context — planning and execution tangle, context bloats. Orchestra replaces it with A2A:

- **Discussion is the plan（讨论即计划）** — talk a hard problem through with a thinking role (e.g. `oracle`) in an interactive a2a conversation. Every message is observable and replayable.
- **The plan is the task（计划即任务）** — when the discussion converges, the conclusion ships *verbatim* as a self-contained task to an executor.
- **Plan and execution contexts stay separate（计划与执行彻底分离）**.

## Quick start（快速开始）

Requirements: DSH (DeepSeek Harness) with Node ≥ 22. The current source targets **DSH 0.1.7-alpha.1**; package version remains **0.5.1**. These local migration changes are **not an npm release**, and the optional host delivery layer is still [a v2 implementation plan](docs/plan-0.8.0-execution.md), not shipped functionality.

**Continuation checkpoint (2026-09-22):** start with [the handoff](docs/handoff-2026-09-22-upgrade.md). Last green source `f479b23` passed **292 tests**. The newer **`f54383c` is WIP and currently fails TypeScript compilation** in three model/lane tool-contract locations; do not install it as a completed upgrade. Governed recovery/replacement and live browser/role/restart validation also remain unfinished. The delivery-layer v2 documents are drafts with nine recorded blockers, not implementation-ready approval. Graph loops/gates remain declarations. See [migration evidence](docs/upgrade-0.1.7-alpha.1-implementation.md); [initial review](docs/review-2026-09-22-plugin-and-delivery.md) is historical defect evidence.

1. **Install from npm** in your DSH profile directory (`cd ~/.dsh/profiles/<your-profile>` first):

   | Manager | Command | Notes |
   |---|---|---|
   | **npm** (recommended) | `npm install orchestra-dsh` | npm ≥7 auto-installs peer dependencies — use `npm install --legacy-peer-deps orchestra-dsh`; do not rely on pnpm's `auto-install-peers` setting to configure npm. |
   | **pnpm** | `pnpm add orchestra-dsh` | When installing right after a release (24h `minimumReleaseAge` policy), add `orchestra-dsh@<version>` to `pnpm-workspace.yaml` → `minimumReleaseAgeExclude`. |
   | **yarn** | `yarn add orchestra-dsh` | Yarn auto-installs peer dependencies — run the safety check below after installing. |
   | **bun** | `bun add orchestra-dsh` | Bun auto-installs peer dependencies — run the safety check below after installing. |

   **Safety check (all managers)** — this plugin's `@deepseek-ai/*` are `peerDependencies` provided by the DSH host. If your package manager materialized its own copies, the plugin double-loads and every tool call breaks:

   ```bash
   ls node_modules | grep '^@deepseek-ai'   # expect no output (a *.dup-bak leftover is fine)
   ```

   If core copies are present, stop and inspect their resolution before changing anything; do not delete the entire scope, which may contain unrelated packages. The key check is that the plugin and host resolve DSH core services to the same installation. Installing the npm dependency alone does not select the bundle: enable it through DSH's bundle/plugin manager and verify activation.

2. **Restart DSH** and open a new session.

### Use it（用法）

Just say it — natural language or the `/team` slash command:

```
/team 在当前工作目录实现一个 TypeScript 工具库 + 单测 + README
```

The driver runs the onboarding protocol (goal → constraints → context → **topology proposal** → **your approval** → execute), proposes a collaboration plan, and only after you approve does it provision the role sessions and dispatch self-contained tasks. There is no shortcut around that gate: `orchestra_create` requires a `frozenRef`, and only your approval of a draft produces one — calling it with just a goal and a template returns `approval_required` by design. You approve by replying in plain words (`启动` / `可以` / `ok`); `/team approve <draftId>@<revision>` also works but is never required.

**Right-size first**: the driver can work directly, delegate a bounded native child, or use independent Sessions before introducing a shared team. New missions can become lanes of the current team using existing suitable members. A new role composition is guided by the discoverable `orchestra-preset-authoring` playbook; no preset-root setup is needed on DSH 0.1.7.

**Lightweight mode**: you never need a team for one-off collaboration — the A2A tools (`a2a_list` / `a2a_create` / `a2a_send` / `a2a_reply` / `a2a_read` / `a2a_stop` / `a2a_status`) work standalone between any sessions on the host.

## Core concepts（核心概念）

Four kinds of objects stay separate; each owns its facts and the others only reference them:

| Concept | What it is | Where it lives |
|---|---|---|
| **Topology**（拓扑） | How a *kind* of team collaborates: roles, ownership, routes, completion. A template you can instantiate. | `.orchestra/topologies/<id>.json` (project) · `~/.dsh/orchestra/topologies/` (global) · built-in |
| **Preset**（预设） | How a *role* behaves: persona, tools, discipline. Referenced by topology via `preset` id. | `.orchestra/presets/<id>/` (project) · `~/.dsh/orchestra/presets/` (global) · built-in |
| **Mission**（任务） | What *this* team does: goal, scope, constraints, acceptance criteria. | passed to `orchestra_create` |
| **Runtime State**（运行时状态） | What *this* team has done: sessions, reports, lifecycle. | `orchestra/state/team.json` + `orchestra/archive/` |

Directory conventions: **project-level `.orchestra/` wins over global `~/.dsh/orchestra/`**, which wins over built-ins. The plugin writes its built-in presets and topologies into the global root on first run (user edits are never overwritten). Runtime state lives under `<cwd>/orchestra/` (state / reports / archive) and is per-working-directory.

## Built-in topologies（内置模板）

**v0.3 legacy templates**（继续可读，不静默替换）:

| Template | Spawned roles | Purpose |
|---|---|---|
| `duo` | reviewer (read-only) | Minimal loop: driver + targeted two-round review. |
| `trio` | implementer + reviewer (read-only) | Implement–review closed loop for serious dev tasks. |
| `oracle` | oracle (read-only) | Deep-discussion partner: dialogue → conclusions as tasks. |
| `four-role-dev` | implementer + reviewer + oracle (reviewer/oracle read-only) | Implement ⇄ review main loop with an on-demand oracle escalation channel. |

**v0.4 task topologies**（schemaVersion 1；`protocol` 里的 typed handoffs / bounded Loop / Human Gate / single Closure owner 在 v0.5 中保留为**声明式资产**——校验器仍然检查、角色 welcome 仍然携带，但运行时不再用状态机工具去驱动它们）:

| Template | Spawned roles | Purpose |
|---|---|---|
| `feature-development` | implementer + verifier + reviewer (verifier/reviewer read-only) | Approved mission → bounded, tested, reviewed code delivery. Loop `implementation-review` (max 2 attempts), gate `feature-closure-approval`. |
| `bug-diagnosis-and-fix` | investigator + implementer + verifier + reviewer (read-only except implementer) | Reproduction + root cause first, then minimal repair with regression evidence. Loop `diagnosis-fix-review`, gate `bug-fix-acceptance`. |
| `architecture-decision` | researcher + architect + reviewer (all read-only) | Evidence-backed decision brief with a direct user choice. Loop `decision-validation`, gate `architecture-decision-approval` (reviewer PASS ≠ user approval). |
| `refactor-and-migration` | architect + implementer + verifier + reviewer | Behavior-baseline migration in declared slices with rollback evidence. Loop `migration-validation`, gate `migration-compatibility-approval`. |
| `audit-and-hardening` | hardening-auditor + investigator + implementer + verifier + reviewer | Bounded security audit → minimal remediation → rescan evidence. Loop `hardening-remediation`, gate `security-risk-acceptance` (missing rescan cannot PASS). |

Each template carries a `protocol` block: `ownership` (who owns each decision), `routes` (default message flows), `completion` (who declares the team complete), plus v0.4 `loops` / `gates` / `handoffs` / `closure` declarations. The validator checks references, but the current lazy-dispatch path does not carry the complete protocol opening message. These declarations do not prove runtime enforcement of payloads, attempt limits, gates or closure. The nine v0.4 role presets (`orchestra-v04-*-v1`, including `planner` and `oracle`) are complete mountable compositions (persona + tools + agent-instructions), not persona-only text.

**Orchestration is flexible by design**: the driver may pick any number of roles (3 or 10) — it must define routes and ownership, but the cast is up to the task. A role named like a template role inherits that template's sandbox and preset. Additional roles can be proposed and added to the running team through `orchestra_add_lanes` (plan → user agreement → `confirm:true`). Added seats are recorded in `team.addedLanes`, not as a revision of the original charter. `orchestra_spawn` no longer exists.

## Tools（工具一览）

**A2A transport** (standalone; no team required): `a2a_list` (your cwd first, sorted by recent activity, `query` keyword filter, archived folded, `role` + relative `lastActivity`) · `a2a_create` (open a lightweight collaborator; `execution: "session" | "subagent"`) · `a2a_send` / `a2a_reply` (delivery receipts: `live_inbox` / `durable_inbox` / `resumed_inbox` — accepted ≠ processed) · `a2a_read` (reverse progressive disclosure: last 1–2 turns by default, widen on demand) · `a2a_stop` (cancel the target's running turn and clear its pending inbox — the Composer Stop button) · `a2a_status` (only lifecycle facts a correlated Session event actually proves).

**Orchestra lanes:** `orchestra_draft` (append-only plan draft; per-role blueprint preview rendered as a Markdown table; `inlineTopology` lets the driver COMPOSE the graph from role presets instead of borrowing one) · **your approval** (a plain yes — 启动 / 可以 / ok — recorded against the exact draft revision last shown to you; only a genuine user turn counts, `/team approve <draftId>@<revision>` also works) · `orchestra_create` (reserve the approved plan; requires the `frozenRef` that approval produced, and creates NO sessions) · `orchestra_dispatch` (dispatch a task to a lane; the role's session is materialized on its FIRST dispatch, and a failed materialization reports the role and its pinned model and falls back to reserved so the next dispatch retries) · `orchestra_add_lanes` (graft a new objective onto the RUNNING team as another lane — plan first, then `confirm: true` after the user agrees; one team per directory stays true) · `orchestra_report` (escrow write channel — the only durable write a read-only role has) · `orchestra_send` (dispatch to a governed role by teamId+roleId) · `orchestra_team` (objective board: role sessions, liveness, report counts, last report path, lanes added after approval) · `orchestra_dismiss` / `orchestra_activate` (archive & revive) · `orchestra_topologies` (project/global/built-in catalog, with the role library) · `orchestra_wait` (headless/scripted loops only — an interactive driver concludes its turn instead and is woken by the role's reply).

**Removed in v0.5 — the micro state-machine surface:** `orchestra_loop_start`, `orchestra_attempt_start`, `orchestra_verdict`, `orchestra_handoff`, `orchestra_gate_open`, `orchestra_gate_fallback`, `orchestra_graph`, `orchestra_graph_reconcile`, `orchestra_reconcile`, `orchestra_decision`, `orchestra_document`, `orchestra_charters`, `orchestra_close`, `orchestra_apply_amendment`, `orchestra_freeze`, `orchestra_spawn` — 16 tools, plus the one-shot full-roster validation inside `orchestra_create` that the spec's 17-item slimming list also called out. The driver stops being a graph clerk: nodes hand hard facts to each other directly over A2A, the two-round limit is role discipline rather than a host-enforced cap, and reports attempt to wake the driver instead of requiring polling. `orchestra_create` refuses any call without the approval-produced `frozenRef`, so the control point is unchanged.

**Settings tab:** the "orchestra" page in the DSH settings panel shows templates (with protocol) and team instances (with mission/status/archives).

## Team lifecycle（团队生命周期）

```
none ─[orchestra_create]→ active ─[orchestra_dismiss]→ archived ─[orchestra_activate]→ active
```

- `dismiss` requests cancellation/drain, attempts retirement notices, writes an immutable snapshot under `orchestra/archive/`, and replaces active state with an archived marker. **Durable role sessions are retained**; this does not mean their turns keep running. Stop failures and the successful-result schema mismatch remain known defects.
- `activate` restores a team from an archive id: live sessions are reused, persisted ones resumed, authoritatively-missing ones replaced (recorded in `sessionHistory`, handed a recovery packet); partial failures put the team in `degraded` instead of pretending success.
- One active team per working directory.

## Development（开发）

```bash
npm run typecheck && npm run build   # host tsc + client tsc + tsdown → lib/
scripts/dev-instance.sh              # dev instance on :4600
```

The dev instance restarts in seconds and never touches the main instance. Port **4600** and the `dev` profile are shared with another project's setup: the profile carries that project's bundles alongside this plugin, so **never prune its bundle list or dependencies** when syncing a new build. Local handoff files (`AGENTS.md`, `STATE.md`, `DSH-INTEGRATION.md`), session logs and runtime state remain outside Git according to the repository ignore rules. Selected design and review documents under `docs/` are tracked; they are not included in the npm package.

## Roadmap（路线图）

- **v0.5.0 ✅（2026-09-16）** — lean-lane refactor. The 16 micro state-machine tools are gone: the driver no longer plays graph clerk, nodes hand hard facts to each other directly, a loop is bounded to 2 rounds on the front line, and the driver is woken by the role's own reply (reactive inbox) instead of polling — `orchestra_wait` is now a headless-only utility, because blocking the driver's turn for a heartbeat is what made role replies queue up as "pending messages". Plugin records moved out of Session logs into `<cwd>/orchestra/` files (ADR-0002) — a custom Session event type made the whole log unreadable on reread, so this is what makes every session the plugin touches natively replayable again. A2A gained `a2a_stop` (real `agent.cancel()`), activity-sorted `a2a_list` with keyword search, and reverse-windowed `a2a_read`. Approval is a plain user reply (ADR-0006). 222/222 tests green; a full lifecycle (draft → approval → team → implement → review FAIL → targeted fix → review PASS → dismiss) was exercised on a real dev instance at :4600.
- **v0.4.1 ✅（2026-09-12）** — DSH `0.1.5-rc.2` compatibility. Dependency upgrade from `0.1.0-rc.6` (20 host type errors, all mechanical), plus one runtime regression the typechecker cannot see: DSH 0.1.5 made slot registration declaration-gated, so a client plugin must use `ctx.slots.inject("settings.section", () => ctx.slots.register(...))` — a bare `register()` failed the whole plugin load. 142/142 tests green; verified end-to-end on a real dev instance (settings panel renders the topology catalog; a live session calls `orchestra_topologies` successfully).
- **v0.4.0 ✅（2026-08-25 主线闭环）** — living orchestration document (charter draft → `/team approve` → freeze → amendment), bounded graph runtime (loop/attempt/verdict/gate/closure, typed handoffs, cap exhaustion), transactional provisioning, seven v0.4 role presets, five task topologies, session title three-part scheme, driver node-milestone notices, proposal blueprint table, recovery hardening (archive validation, three-branch activate, controller takeover). Local verification: 18 test files / 142 tests green. Real full-session E2E is **not** run by the dev team — see `UPDATE-v0.4.0.md` for the external validation checklist.
- **v0.5.1 ✅（2026-09-19）** — adaptive teams and honest failure paths. A team is now dynamic: `orchestra_add_lanes` grafts a new objective onto the running graph as another lane (plan → one user confirmation → applied), so one directory keeps exactly one team and one closure owner without capping how much work it can hold. `/team` on a directory with an active team always states the situation and offers ONE two-way choice (continue the old objective, or archive it and start a new one) — the `force-archive` escape hatch is gone by design. `orchestra_create` became reserve-only: roles are seats until their first dispatch, and a materialization failure now reports the role, the failure and the model the charter pinned, then returns the role to `reserved` so the next dispatch rebuilds it instead of delivering into a session that never existed. Model routing no longer falls back to a built-in ladder: a preference file is consulted only when it exists, otherwise the deployment's own default model applies. Two roles joined the library (`planner`, `orchestra-v04-oracle-v1`) and phase/lane references are cross-validated. Docs and tool descriptions were re-synced with the code (the v0.5.0 review's "text teaches a tool that no longer exists" class of defect had reappeared).
- **0.8.0 — planned, not shipped**: batch 2 adds host-collected evidence, frozen candidates, worktrees/leases, merge CAS and decision records; batch 3 adds recovery capsules, governance and observability. The [2026-09-22 review](docs/review-2026-09-22-plugin-and-delivery.md) identifies prerequisite lifecycle and design corrections. Repository-wide team identity across worktrees is a target, not current behavior.
- **UI candidates (not a current delivery commitment)** — sidebar live topology graph and GUI steering; the current settings page is display-only.
- **Later** — product-or-ui-design / frontend-designer / documenter topologies (catalog Deferred).

## Coexistence（与官方 Agent Teams 共存）

DSH ships an opt-in experimental Agent Teams group (`@deepseek-ai/dsh-experimental-agent-team` and its siblings). Orchestra **does not use it and does not depend on it** (experimental packages are not installable dependencies outside that group), and it occupies **none** of that group's tool names — `send_message`, `list_agents`, `interrupt_agent`, `spawn_teammate`, `wait_agent`, `team_task_*`. Orchestra's own tools are namespaced `orchestra_*` / `a2a_*`, so both can be mounted together.

## License

[MIT](LICENSE) © 2026 TimYuann. The DeepSeek Harness (DSH) is a separate project; see its own license.
