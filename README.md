# orchestra — DSH Multi-Role Topology Collaboration

> Turn your DSH instance into an orchestra: roles are **first-class, visible sessions** — not hidden subagents.
> 把 DSH 变成一支乐队：角色是**平级可见的会话**，不是藏起来的子代理。

`orchestra-dsh` is a lightweight multi-agent orchestration plugin for the DeepSeek Harness (DSH). One driver session starts a team, each role is a full peer session with its own context, and the whole run — from onboarding to review to archiving — is driven by conversation. Template topologies (`duo` / `trio` / `oracle`) are optional presets; the real power is dynamic orchestration via `/team`.

## Why — the idea (<a id="why"></a>设计理念)

Traditional agents use *plan mode*: a mode switch inside one context — planning and execution tangle, context bloats, playback is lost. Orchestra kills plan mode entirely with A2A:

- **Discussion is the plan（讨论即计划）** — you (or the driver) talk through a hard problem with a thinking role (e.g. `oracle`) in an interactive a2a conversation. Every message is observable and replayable.
- **The plan is the task（计划即任务）** — when the discussion converges, the conclusion ships *verbatim* as a self-contained task to an executor. No mode switch.
- **Plan and execution contexts are separated（计划与执行彻底分离）** — the thinking session and the working session each keep clean, independent context.

This is the core story of the project — the pitch and the demo start here.

## Philosophy at a glance（设计哲理速览）

| Principle | Meaning |
|---|---|
| **Roles are first-class sessions（角色是一等公民）** | Each role is a full peer session you can read, resume, and observe — suitable for serious/long tasks without single-context compression. |
| **A2A kills plan mode** | Discussion is the plan; the plan is the task; contexts never mix. |
| **Driver decides, never relays（driver 只决策不中转）** | Deterministic routing: messages inside a fixed flow go directly between roles; the driver only receives decision points (advances, blockers, new directions). No mindless forwarding. |
| **6-step onboarding, approval-gated（6 步启动协议）** | Goal → constraints → context → topology proposal → **explicit user approval** → execute. No role is ever created before the user says go. |
| **Two-round review ceiling（两轮评审上限）** | R1 full review → fix loop → R2 re-checks R1 findings only; new issues go to a backlog for the driver to decide. Reviewers never spiral. |
| **Read-only reviewer + escrow write channel（只读沙箱 + 托管写通道）** | Reviewer roles run read-only; the only write path is `orchestra_report` under `orchestra/reports/`. Least privilege, safe handoff. |
| **Role discipline（角色纪律）** | `wait for dispatch` (a welcome is not a task) and `spec scope` (implement exactly what the spec asks — no feature-creep). |
| **Restart recovery & model fidelity（重启恢复与模型保真）** | `orchestra_activate` resumes roles after a restart and replays their provider/model/reasoningEffort from the team snapshot. |
| **Templates are user assets（模板是用户资产）** | Topologies are editable user JSON; the plugin only ships defaults (bundled) and falls back to them. |
| **Don't break the host（防崩纪律）** | `@deepseek-ai/*` stays in `peerDependencies` only — the plugin never ships its own copy of host packages. |

## Quick start（快速开始）

Requirements: DSH (DeepSeek Harness) with Node ≥ 22.

1. **Install from npm** — one line per DSH profile:

   ```bash
   cd ~/.dsh/profiles/<your-profile>
   pnpm add orchestra-dsh
   ```

   A just-published version is held back by pnpm's `minimumReleaseAge` policy for 24h — if you install right after a release, add `orchestra-dsh@<version>` to your profile's `pnpm-workspace.yaml` → `minimumReleaseAgeExclude`.

   Safety rule of this plugin: **never** let `@deepseek-ai/*` land in `dependencies` — a duplicated host package breaks every tool call.

2. **Or from source (development)** — build the tarball from this repo:

   ```bash
   npm run typecheck && npm run build     # host tsc + client tsc + tsdown bundle
   npm pack --cache /tmp/dsh-npm-cache    # produces orchestra-dsh-0.2.0.tgz
   ```

   then add the tarball to your profile's `package.json` (pnpm profiles require forcing the reinstall):

   ```bash
   cd ~/.dsh/profiles/<your-profile>
   rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json
   pnpm install
   ```

3. **Restart DSH** and open a new session.

### Use it（用法）

Just say it — natural language or the `/team` slash command:

```
/team 在当前工作目录实现一个 TypeScript 工具库 + 单测 + README
```

The driver runs the 6-step onboarding (goal → constraints → context → topology proposal → **your approval** → execute), creates roles, dispatches self-contained tasks, and the team runs your task. Or start from a template: `orchestra_create(topology="trio")`.

## Built-in topologies（内置模板）

| Template | Roles | Purpose |
|---|---|---|
| `duo` | reviewer (read-only) | Minimal loop: execute → targeted two-round review → handoff. |
| `trio` | implementer + reviewer (read-only) | Implement–review closed loop for serious dev tasks. |
| `oracle` | oracle (read-only) | Deep-discussion partner that replaces plan mode: dialogue → conclusions as tasks. |

Template JSON format + notes live in [`examples/topologies/`](examples/topologies/). At runtime the plugin reads user templates from `<cwd>/orchestra/topologies/*.json` (user files override bundled defaults by id).

## Tools（工具一览）

**Orchestration:** `orchestra_create` (template start) · `orchestra_spawn` (dynamic role, with templateId+roleId or provider/model/reasoningEffort overrides) · `orchestra_team` (progress) · `orchestra_activate` (restart recovery) · `orchestra_dismiss` (archive & close) · `orchestra_report` (escrow write + bookkeeping) · `orchestra_topologies` (list templates).

**A2A transport:** `a2a_list` · `a2a_create` · `a2a_send` · `a2a_reply` · `a2a_read` — peer-to-peer messaging across agent threads with cold-session auto-resume.

**Settings tab:** the "orchestra" page in the DSH settings panel shows two scrollable panes — orchestrations (built-in templates + team instances) and roles — with built-ins always visible after install.

## Architecture（架构）

```
src/a2a.ts           → A2A transport layer (P2P messaging, cold resume, model selection)
src/orchestra.ts     → orchestration layer (tools, /team command, role protocol, web surface)
src/client/index.tsx → settings panel (two display-only panes, built-ins always shown)
src/relay-types.ts   → a2a message-source type augmentation

Data (per working directory):
<cwd>/orchestra/topologies/*.json   user templates (bundled fallback embedded in code)
<cwd>/orchestra/state/team.json     instance snapshot (create/spawn writes; archived on dismiss)
<cwd>/orchestra/reports/            role handoff channel (orchestra_report)
<cwd>/orchestra/archive/            closed-instance archives
```

Key mechanics: tool results are the *rendered text* the model sees (render must carry the data); roles are first-class sessions (no subagent origin); the client bundle follows DSH's `__ModuleLoader__` closure protocol.

## Development（开发）

```bash
npm run typecheck && npm run build   # host tsc + client tsc + tsdown → lib/
scripts/dev-instance.sh              # standalone dev instance on :4600 (independent profile)
```

The dev instance restarts in seconds and never touches the main instance. Note: internal dev docs (AGENTS/STATE/DSH-INTEGRATION/TESTING, session logs, runtime state) are **not published** in this repository — see [`REQUIREMENTS.md`](REQUIREMENTS.md) for the public design document.

## Roadmap（路线图）

- **v0.3** — mission board (task announcement board: open/claimed/done lifecycle) — design only.
- GUI steering — buttons to create roles/templates, visual template editing (currently display-only panes).
- Custom mode binding / tool allow-lists; template file distribution.

## License

[MIT](LICENSE) © 2026 TimYuann. The DeepSeek Harness (DSH) is a separate project; see its own license.