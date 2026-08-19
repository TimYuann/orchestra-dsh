# orchestra — DSH Multi-Agent Orchestration

> Turn your DSH instance into an orchestra: roles are **first-class, visible sessions** — not hidden subagents.
> 把 DSH 变成一支乐队：角色是**平级可见的会话**，不是藏起来的子代理。

`orchestra-dsh` is a multi-agent orchestration plugin for the DeepSeek Harness (DSH). One driver session starts a team toward a goal, each role is a full peer session with its own context, and the whole run — from onboarding to review to archiving — is coordinated through conversation. It ships two layers: an **A2A transport** for peer-to-peer messaging between any sessions, and an **orchestration layer** for project-scoped teams, roles, and topologies.

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

Requirements: DSH (DeepSeek Harness) with Node ≥ 22.

1. **Install from npm** in your DSH profile directory (`cd ~/.dsh/profiles/<your-profile>` first):

   | Manager | Command | Notes |
   |---|---|---|
   | **npm** (recommended) | `npm install orchestra-dsh` | npm ≥7 auto-installs peer dependencies — set `auto-install-peers=false` in the profile's `.npmrc` first, or add `--legacy-peer-deps`. |
   | **pnpm** | `pnpm add orchestra-dsh` | When installing right after a release (24h `minimumReleaseAge` policy), add `orchestra-dsh@<version>` to `pnpm-workspace.yaml` → `minimumReleaseAgeExclude`. |
   | **yarn** | `yarn add orchestra-dsh` | Yarn auto-installs peer dependencies — run the safety check below after installing. |
   | **bun** | `bun add orchestra-dsh` | Bun auto-installs peer dependencies — run the safety check below after installing. |

   **Safety check (all managers)** — this plugin's `@deepseek-ai/*` are `peerDependencies` provided by the DSH host. If your package manager materialized its own copies, the plugin double-loads and every tool call breaks:

   ```bash
   ls node_modules | grep '^@deepseek-ai'   # expect no output (a *.dup-bak leftover is fine)
   ```

   If copies are present, remove `node_modules/@deepseek-ai` and re-run your install command with peer auto-install disabled.

2. **Restart DSH** and open a new session.

### Use it（用法）

Just say it — natural language or the `/team` slash command:

```
/team 在当前工作目录实现一个 TypeScript 工具库 + 单测 + README
```

The driver runs the onboarding protocol (goal → constraints → context → **topology proposal** → **your approval** → execute), proposes a collaboration charter, and only after you approve creates the roles and dispatches self-contained tasks. Or start from a template: `orchestra_create(topology="trio", goal="...")`.

**Lightweight mode**: you never need a team for one-off collaboration — the A2A tools (`a2a_list` / `a2a_send` / `a2a_reply` / `a2a_read` / `a2a_create`) work standalone between any sessions on the host.

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

| Template | Spawned roles | Purpose |
|---|---|---|
| `duo` | reviewer (read-only) | Minimal loop: driver + targeted two-round review. |
| `trio` | implementer + reviewer (read-only) | Implement–review closed loop for serious dev tasks. |
| `oracle` | oracle (read-only) | Deep-discussion partner: dialogue → conclusions as tasks. |
| `four-role-dev` | implementer + reviewer + oracle (reviewer/oracle read-only) | Implement ⇄ review main loop with an on-demand oracle escalation channel. |

Each template carries a `protocol` block: `ownership` (who owns each decision), `routes` (default message flows), and `completion` (who declares the team complete). The plugin validates that ownership/routes reference real roles and injects the protocol into every role's opening message.

**Orchestration is flexible by design**: the driver may pick any number of roles (3 or 10) — it must define routes and ownership, but the cast is up to the task. A role named like a template role inherits that template's sandbox/preset by default; explicitly spawned roles default to `workspace-write` unless you pass `sandbox: "read-only"`.

## Tools（工具一览）

**Orchestration:** `orchestra_create` (template + mission) · `orchestra_spawn` (add a role, with preset/sandbox/model overrides) · `orchestra_team` (team state + archive list) · `orchestra_dismiss` (archive & free the directory; roles stay alive and get an archive notice) · `orchestra_activate` (restore an archived team; requires `archive_id`, handles replaced sessions and controller takeover) · `orchestra_report` (the only write channel for read-only roles) · `orchestra_topologies` (list project/global/built-in templates).

**A2A transport:** `a2a_list` (progressive disclosure: your cwd first, archived folded, `current_cwd_team` annotation) · `a2a_create` · `a2a_send` / `a2a_reply` (delivery receipts: `live_inbox` / `durable_inbox` / `resumed_inbox` — accepted ≠ processed) · `a2a_read`.

**Settings tab:** the "orchestra" page in the DSH settings panel shows templates (with protocol) and team instances (with mission/status/archives).

## Team lifecycle（团队生命周期）

```
none ─[orchestra_create]→ active ─[orchestra_dismiss]→ archived ─[orchestra_activate]→ active
```

- `dismiss` archives an immutable snapshot under `orchestra/archive/`, deletes the active state, and notifies live roles — **role sessions are independent assets and stay alive**.
- `activate` restores a team from an archive id: live sessions are reused, persisted ones resumed, authoritatively-missing ones replaced (recorded in `sessionHistory`, handed a recovery packet); partial failures put the team in `degraded` instead of pretending success.
- One active team per working directory.

## Development（开发）

```bash
npm run typecheck && npm run build   # host tsc + client tsc + tsdown → lib/
scripts/dev-instance.sh              # standalone dev instance on :4600 (independent profile)
```

The dev instance restarts in seconds and never touches the main instance. Internal development documents (AGENTS/STATE/DSH-INTEGRATION/TESTING, session logs, runtime state, review reports) are **not published** in this repository.

## Roadmap（路线图）

- **v0.4** — orchestration assetization (save a team's charter as a reusable topology/preset at wrap-up, project- and global-level), preset engineering (curated base prompts, review methodologies as presets), advisory/observer role.
- GUI steering — buttons to create roles/templates, visual template editing (currently display-only panes).

## License

[MIT](LICENSE) © 2026 TimYuann. The DeepSeek Harness (DSH) is a separate project; see its own license.
