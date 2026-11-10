# Orchestra A2A for DSH

Create independent agent Sessions and exchange messages without setting up a team. Governed Orchestra teams remain available as an optional advanced workflow.

## Compatibility and installation

The current source targets **DSH `>=0.2.2-rc.1 <0.3.0`**, Node 22 or newer. Development dependencies pin DSH 0.2.2-rc.1; this does not claim every future host version has been tested.

Install or update through DSH's plugin manager (`install_bundle`, target `orchestra-dsh` or the local package directory). Read its activation result: updating an already loaded JavaScript package may require a host restart. The change affects the selected profile's sessions. Open a new test Session after activation.

DSH runtime packages are **peer dependencies**, provided by the host. Do not install private copies of core DSH/Cordis packages into a profile or manually rewrite its package/patch files. Duplicate core instances can break tool execution. Workspace development dependencies are not included in the distributed bundle.

## A2A quick start

Ask the agent to create a collaborator, give it a bounded task, and send the result back. No charter approval or `/team` is needed.

For example, create a read-only peer using this model route:

```json
{
  "execution": "session",
  "cwd": "/absolute/project/path",
  "permissionPreset": "read-only",
  "provider": "commandcode",
  "model": "deepseek/deepseek-v4.1-flash",
  "reasoningEffort": "max",
  "title": "Investigate message delivery"
}
```

Use `a2a_send` with the returned Session ID to deliver its task. Model/provider IDs are deployment-specific; this example requires that configured provider and its supported Max effort. Unsupported routes or explicit effort values are checked before publishing the Session when the host's LLM service is available.

### Tools

| Tool | Purpose |
|---|---|
| `a2a_create` | Create an independent peer Session, or explicitly choose native subagent activation. |
| `a2a_send` | Send to a Session ID, including peers outside the caller's directory. |
| `a2a_reply` | Reply to the original sender with an exact `reply_to` message ID. |
| `a2a_read` | Read a bounded recent conversation window. |
| `a2a_list` | Discover Sessions, prioritizing the caller's directory, with search and team/archive annotations. |
| `a2a_status` | Inspect proven acceptance, claim and correlated answer facts. |
| `a2a_stop` | Cancel a Session's current work and clear its pending inbox. |

### Busy recipients and delivery

- **Default:** `a2a_send` and `a2a_reply` steer into the recipient's nearest step boundary. They wake idle recipients. This does **not** cancel a running model request or tool.
- **Separate turn:** set `interrupt:false` to wait for the current turn to finish.
- **Context only:** `a2a_send(wake:false)` adds context without waking the recipient, even if `interrupt:true` was also supplied.
- A waking delivery to an attached Session with no Agent attempts native resume. If the host cannot acquire its writer (including an already-owned Session), delivery fails loudly instead of reporting an unwakeable splice as accepted. A non-waking delivery can remain parked until another input wakes it.
- Steering is not an absolute latency guarantee: a long-running request/tool, cancellation, rejected steps or disposal can delay or discard pending steering. Use explicit queueing when a separate-turn boundary is required.

A receipt's `state: accepted` is **not** proof the recipient read the message or completed the task. Retries may use the same idempotency key to recover the existing receipt instead of sending another copy. A new intent needs a new key. Reusing a queued receipt does not promote its original message to steering.

`a2a_status` reports `answered` only with correlated evidence: a successful `a2a_reply` to the original sender using that exact message ID, or a historical correlated assistant response. Merely calling a reply tool, replying to someone else, or ending a turn does not prove an answer.

### Permissions and reasoning effort

For independent Sessions, `a2a_create` accepts a native `permissionPreset` and explicit model/effort selection. **Filesystem sandbox and approval policy are different knobs.** Collaborators start with approval `never` so unattended work cannot park on a permission prompt; this does not grant full filesystem access. A requested stock preset such as `workspace-write` may consequently display as **custom** in DSH because its stock approval setting was `ask`.

Creation results distinguish the requested preset, effective preset, sandbox, approval policy and reasoning effort. Model choices are recorded through DSH's native `model/selection` event, which supplies both execution and GUI state. After creation, use the native GUI controls to change the Session's permissions or model selection; `a2a_create` is not an update tool. Lightweight cold recovery respects subsequent recorded model selections instead of overwriting them with the birth blueprint. Governed roles retain their separately approved fixed contract.

Native `execution: "subagent"` is parent-owned and requires `prompt`; generic peer-to-peer addressing is not a substitute for the host's parent/child messaging contract. This plugin exposes local activation and model routing, not independent native-child permission control. DSH 0.2.2 removed the old native `persona/toolFilter` request fields: legacy requests using them fail explicitly before publication. Use a declared peer Session preset for those capabilities.

## Optional: governed teams

Use `/team` or explicitly request a Governed Orchestra team when you need user-approved roles, shared mission lanes, handoff records and archives. Ordinary collaboration or delegation does not automatically enter this workflow.

The `orchestra-teams` skill contains the detailed procedure. The short lifecycle is:

1. Discuss the goal, boundaries and completion check.
2. Compose a proposal with `orchestra_draft`; show its exact revision, digest and role/model/permission choices.
3. The **user** approves that proposal. Only the resulting `frozenRef` authorizes `orchestra_create`.
4. Dispatch bounded tasks with `orchestra_dispatch`, retaining dispatch identity for safe retries. Role Sessions materialize on first use.
5. Check handoff reports and objective team state; close with `orchestra_dismiss` when done.

One active team per working directory. `orchestra_add_lanes` previews a new mission/lane and applies it only after user agreement. `orchestra_team` lists current state and archives; `orchestra_activate` restores an archive. `orchestra_report` supplies a bounded report channel for read-only roles. `orchestra_send` addresses a role by team and role ID. Interactive drivers end their turn when only replies remain; `orchestra_wait` is a headless/scripted utility.

Team tools and stored data have not been removed. The settings page leads with A2A and keeps team information in a collapsed advanced section; its polling runs only while that section is open. Detailed team instructions are loaded on demand instead of imposing the driver protocol on every Session.

Runtime records live under `<cwd>/orchestra/`. Role capabilities use DSH's declared preset registry, not legacy preset-directory roots. Graph declarations do not enforce review deadlines, professional acceptance or release authority. Planned deterministic delivery-layer documents are not a claim of shipped functionality.

## Development

```bash
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
npm pack --cache /tmp/dsh-npm-cache
```

The suite includes deterministic unit tests and a real DSH AgentLoop integration check. The integration check simulates only model output; it exercises the native Agent, Inbox, Session, projections and driver. It does not replace live provider, browser or cross-process restart acceptance. Keep test storage isolated and avoid running a test driver against a Session another host process owns.

Use the DSH plugin manager for installation, rather than running a package manager in a live profile. Client changes require browser verification against the installed artifact. No publishing or pushing is implied by local checks.

## License

[MIT](LICENSE) © 2026 TimYuann. The icon is original artwork distributed under the same license. DSH is a separate project with its own license.
