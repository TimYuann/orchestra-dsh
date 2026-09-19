import { test } from "node:test";
import assert from "node:assert/strict";
import { createActiveTeamStateStore, transferOrchestrationControl } from "../lib/orchestra-state.js";
import { createArchiveStore } from "../lib/orchestra-archive.js";
import { charterRecordStoreFor } from "../lib/charter-store.js";
import {
  createGovernedTeam,
  dispatchRoleTask,
  orchestra_dismiss,
  handleTeamCommandInvocation,
} from "../lib/orchestra.js";
import { prepareApprovalEvent, prepareDraftEvent, prepareFreezeEvent } from "../lib/orchestration-charter.js";

const cwd = "/tmp/orchestra-fleet-test";

class MemoryFs {
  constructor(events = []) {
    this.events = events;
    this.files = new Map();
    this.clock = 0;
  }

  async resolve(path, options = {}) {
    return { key: `${options.cwd ?? ""}:${path}`, displayPath: `${options.cwd ?? ""}/${path}` };
  }

  processPath(target) {
    return target.displayPath;
  }

  async stat(target) {
    const file = this.files.get(target.key);
    return file === undefined ? undefined : { type: "file", size: file.content.length, version: file.version };
  }

  async readText(target) {
    const file = this.files.get(target.key);
    if (file === undefined) throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
    return file.content;
  }

  async writeText(target, content, expected) {
    this.events.push(`fs:write:${target.displayPath}`);
    const existing = this.files.get(target.key);
    if (expected?.kind === "createIfAbsent" && existing !== undefined) throw Object.assign(new Error("race"), { code: "FS_NOT_OBSERVED" });
    if (expected?.kind === "replaceIfVersion" && (existing === undefined || existing.version !== expected.version)) throw Object.assign(new Error("stale"), { code: "FS_STALE_VERSION" });
    const version = `v${++this.clock}`;
    this.files.set(target.key, { content, version });
    return { operation: existing === undefined ? "create" : "update", version, before: existing?.content ?? null, after: content };
  }
}

function makeHarness() {
  const events = [];
  const fs = new MemoryFs(events);
  const sessions = new Map();
  const agents = new Map();
  const sessionFor = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        events: [],
        header: { cwd },
        snapshotEvents() { return this.events; },
        append(type, data) { this.events.push({ type, data, seq: this.events.length, time: Date.now() }); },
      };
      sessions.set(id, s);
    }
    return s;
  };

  const presets = {
    defaultId: "default",
    async resolve(id) { return { id }; },
    async mount(ctx, id) { events.push(`mount:${id}`); ctx.composedPreset = id; },
    composeFrom(ctx, parent) { ctx.composedPreset = parent.composedPreset; return parent.composedPreset; },
  };

  const permissionSpecs = {
    workspace: { sandbox: "workspace-write", approval: "ask" },
  };

  const permissions = {
    defaultPreset: "workspace",
    resolve(name) { return permissionSpecs[name] ?? permissionSpecs.workspace; },
    set(session, name) { session.append("permission/preset", { preset: name }); },
    current(session) { return "workspace"; },
  };

  const controllerSession = sessionFor("driver-1");
  const controller = {
    id: "driver-1",
    session: controllerSession,
    status: "idle",
    options: {},
    followup(msg) { events.push(`followup:${JSON.stringify(msg)}`); },
  };
  agents.set("driver-1", controller);

  const context = {
    fs,
    get(name) {
      if (name === "fs") return fs;
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      if (name === "tools") return { schemas: () => [{ name: "read", description: "read", parameters: {} }] };
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "default-p", model: "default-m" }) };
      return undefined;
    },
    sessions: {
      get(id) { return sessions.get(String(id)); },
      async flush() { return true; },
    },
    agents: {
      get(id) { return agents.get(String(id)); },
      async create(createOptions) {
        const id = String(createOptions.sessionId);
        events.push(`agent:create:${id}`);
        const session = sessionFor(id);
        const childCtx = {
          ...context,
          agentId: id,
          on() { return () => {}; },
        };
        await createOptions.setup?.(childCtx);
        const agent = {
          id,
          session,
          status: "idle",
          options: createOptions.agentOptions ?? {},
          cancel() { events.push(`agent:cancel:${id}`); },
          inbox: { clear() {} },
          followup(msg) { session.append("user/message", msg); },
        };
        agents.set(id, agent);
        return agent;
      },
    },
    sandboxPolicy: {
      resolve() { return { kind: "policy" }; },
    },
  };

  const store = createActiveTeamStateStore(fs);
  const archiveStore = createArchiveStore(fs);
  const charterStore = charterRecordStoreFor(context, cwd);

  return { events, fs, context, controller, store, archiveStore, charterStore, agents };
}

async function prepareApprovedFrozenRef(harness, roles, draftId = "draft-fleet") {
  const config = {
    schemaVersion: 1,
    id: "fleet-topo",
    name: "fleet",
    controller: { id: "driver-1", source: "caller" },
    roles,
    protocol: {
      ownership: { closure: "driver-1" },
      routes: [{ kind: "dispatch", from: "driver-1", to: roles.map((r) => r.id) }],
      completion: { owner: "driver-1", rule: "done" },
    },
  };
  const draft = prepareDraftEvent([], {
    draftId,
    mission: { objective: "fleet lifecycle test", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "test" },
    topology: { source: "inline", id: config.id, config },
    humanParticipationPolicy: { mode: "interactive", onUnavailable: "block" },
    authorSessionId: harness.controller.id,
    now: 1,
  });
  assert.equal(draft.kind, "changed");

  const records = [draft.event];
  const approval = prepareApprovalEvent(records, {
    draftId,
    revision: 1,
    commandId: `command-${draftId}`,
    approvingSessionId: harness.controller.id,
    approvedAt: 2,
  });
  assert.equal(approval.kind, "changed");
  records.push(approval.event);

  const freeze = prepareFreezeEvent(records, {
    draftId,
    revision: 1,
    digest: draft.value.digest,
    frozenBySessionId: harness.controller.id,
    frozenAt: 3,
  });
  assert.equal(freeze.kind, "changed");
  records.push(freeze.event);

  for (const event of records) {
    await harness.charterStore.append(event);
  }
  return freeze.value.frozenRef;
}

test("Sealed backdoor: dispatchRoleTask rejects when no active team exists", async () => {
  const harness = makeHarness();
  await assert.rejects(
    async () => {
      await dispatchRoleTask(
        harness.context,
        harness.store,
        { agent: harness.controller },
        { roleId: "dev", task: "code something" },
      );
    },
    /no active team found in this workspace/,
  );
});

test("Reserve-only creation: createGovernedTeam leaves roles reserved and zero agents spawned", async () => {
  const harness = makeHarness();
  const roles = [
    { id: "planner", name: "Planner", preset: "preset-planner", sandbox: "workspace-write" },
    { id: "worker", name: "Worker", preset: "preset-worker", sandbox: "workspace-write" },
  ];
  const catalog = {
    find() { return { kind: "ready", topology: { id: "fleet-topo", title: "Fleet Topology", roles } }; },
  };
  const frozenRef = await prepareApprovedFrozenRef(harness, roles);

  const result = await createGovernedTeam(
    harness.context,
    harness.store,
    catalog,
    { frozenRef },
    { agent: harness.controller },
  );

  assert.equal(result.roles.length, 2);
  assert.deepEqual(result.roles.map((r) => r.phase), ["reserved", "reserved"]);
  assert.deepEqual(result.roles.map((r) => r.live), [false, false]);

  // Ensure NO agent sessions were spawned in context.agents during createGovernedTeam
  assert.equal(harness.events.filter((e) => e.startsWith("agent:create:")).length, 0);

  // Read team state from store
  const observation = await harness.store.read(cwd);
  assert.equal(observation.kind, "ready");
  assert.equal(observation.team.roles.every((r) => r.phase === "reserved"), true);

  // Sealed backdoor: dispatching an undeclared role fails
  await assert.rejects(
    async () => {
      await dispatchRoleTask(
        harness.context,
        harness.store,
        { agent: harness.controller },
        { roleId: "unknown-role", task: "do something" },
      );
    },
    /cannot dispatch: role "unknown-role" is not declared in the team roster/,
  );

  // Lazy Fleet Materialization: dispatching "planner" triggers materialization: reserved -> provisioning -> active
  const dispatchRes = await dispatchRoleTask(
    harness.context,
    harness.store,
    { agent: harness.controller },
    { roleId: "planner", task: "plan the sprint" },
  );
  assert.equal(dispatchRes.status, "dispatched");
  assert.equal(dispatchRes.created_new_session, true);
  assert.equal(harness.events.filter((e) => e.startsWith("agent:create:")).length, 1);

  const postDispatchObs = await harness.store.read(cwd);
  assert.equal(postDispatchObs.kind, "ready");
  const plannerRole = postDispatchObs.team.roles.find((r) => r.id === "planner");
  const workerRole = postDispatchObs.team.roles.find((r) => r.id === "worker");
  assert.equal(plannerRole.phase, "active");
  assert.equal(workerRole.phase, "reserved"); // worker remains reserved until dispatched!
});

test("/team re-entry arbitration: an active team is always surfaced with one two-way choice, and force-archive does not exist", async () => {
  const harness = makeHarness();
  const roles = [{ id: "worker", name: "Worker", preset: "preset-worker", sandbox: "workspace-write" }];
  const catalog = {
    find() { return { kind: "ready", topology: { id: "fleet-topo", title: "Fleet Topology", roles } }; },
  };
  const frozenRef = await prepareApprovedFrozenRef(harness, roles, "draft-reentry");
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef }, { agent: harness.controller });

  const otherAgent = {
    id: "driver-2",
    session: { header: { cwd }, snapshotEvents() { return []; }, append() {} },
    followup(msg) { harness.events.push(`driver-2:followup:${JSON.stringify(msg)}`); },
  };
  const call = (rawInput) =>
    handleTeamCommandInvocation(harness.context, harness.store, harness.archiveStore, {
      rawInput,
      commandId: `team-cmd-${rawInput}`,
      agent: otherAgent,
    });

  // 1. Neutral input inside an active team: state the situation, offer the choice,
  //    and do NOT change any state.
  const promptRes = await call("/team hello");
  assert.equal(promptRes.kind, "success");
  assert.ok(promptRes.text.includes("没归档的团队"), "arbitration notice should explain the situation");
  assert.ok(promptRes.text.includes("继续"), "notice should offer the continue choice");
  assert.ok(promptRes.text.includes("新目标"), "notice should offer the new-objective choice");
  // The card is written for a PERSON who may not remember this work from days ago:
  // it leads with what the team is trying to do, not with an opaque id, and it
  // says how far the work actually got.
  assert.ok(promptRes.text.includes("它要做的事："), "the card must lead with the goal in words");
  assert.ok(promptRes.text.includes("做到哪一步了："), "the card must say how far the work got");
  assert.equal(
    promptRes.text.includes((await harness.store.read(cwd)).team.teamId),
    false,
    "the decision card must not paste the team id at the user",
  );
  assert.equal(/\(reserved\)|\(active\)/.test(promptRes.text), false, "the decision card must not paste phase codes at the user");
  // The notice is delivered BOTH ways on purpose: as the command's own result
  // text (guaranteed user-visible) and as a plugin followup the driver reads.
  // The followup is what lets the agent explain the choice in its own words.
  const arbitrationNotice = harness.events.find(
    (e) => e.startsWith("driver-2:followup:") && e.includes("没归档的团队"),
  );
  assert.ok(arbitrationNotice, "the driver should receive the arbitration notice");
  assert.ok(arbitrationNotice.includes("继续") && arbitrationNotice.includes("新目标"));
  assert.ok(
    arbitrationNotice.includes("Do NOT archive or take over on your own initiative"),
    "the notice must forbid the driver from deciding unilaterally",
  );
  const untouched = await harness.store.read(cwd);
  assert.equal(untouched.kind, "ready");

  // 2. `force-archive` is GONE: it must behave as neutral input, never as an
  //    archive. (It used to be the escape hatch; the design decision is that
  //    whether an old team still matters is the user's call, made in one sentence.)
  const forced = await call("/team force-archive");
  assert.equal(forced.kind, "success");
  assert.ok(forced.text.includes("没归档的团队"), "force-archive must not archive anything");
  const stillThere = await harness.store.read(cwd);
  assert.equal(stillThere.kind, "ready");

  // 3. Continue: takeover, controller handover recorded.
  const continueRes = await call("/team 继续");
  assert.equal(continueRes.kind, "success");
  assert.ok(continueRes.text.includes("Continuing team"));
  const takenOver = await harness.store.read(cwd);
  assert.equal(takenOver.kind, "ready");
  assert.equal(takenOver.team.controllerSessionId, "driver-2");
  assert.equal(takenOver.team.controllerHistory.length, 1);
  assert.equal(takenOver.team.controllerHistory[0].sessionId, "driver-1");

  // 4. Continue is refused while a role is still running: interleaving a new
  //    objective underneath a running role is exactly what must not happen.
  harness.agents.set(roles[0].id === "worker" ? (await harness.store.read(cwd)).team.roles[0].sessionId : "unused", {
    status: "running",
  });
  const busyContinue = await call("/team 继续");
  assert.equal(busyContinue.kind, "error");
  assert.ok(busyContinue.text.includes("still has running roles"));
  harness.agents.clear();

  // 5. New objective: stop roles, publish the archive, clear the active state.
  const archiveRes = await call("/team 新目标");
  assert.equal(archiveRes.kind, "success");
  // The caller was NOT the controller (driver-2 took the team over on the
  // "continue" step, but a real restart leaves the controller gone), so the
  // archive path has to take authority itself — otherwise the user can never
  // get out of an abandoned team.
  assert.ok(archiveRes.text.includes("Archived"), `archive must succeed even when the controller is gone: ${JSON.stringify(archiveRes.text)}`);
  assert.ok(archiveRes.text.includes("can be found and resumed later"), "the archive message must say the team can be resumed later");
  // The archive id is the handle a later session needs, so it stays; the raw
  // TEAM id is what must never be pasted at a person. (An archive id is built
  // ON the team id, which is why this checks the team id itself.)
  // An archive id is literally built ON the team id, so the message cannot avoid
  // containing it — what matters is that the id is not how the team is NAMED.
  // The message leads with the goal, which is the whole point of the fix.
  assert.ok(
    archiveRes.text.startsWith('Archived "'),
    `the archive message must lead with the goal, not an id: ${JSON.stringify(archiveRes.text)}`,
  );
  const afterArchive = await harness.store.read(cwd);
  assert.equal(afterArchive.kind, "inactive");

  // 6. A TERMINAL team is not a conflict: entering /team archives it silently.
  const frozenRef2 = await prepareApprovedFrozenRef(harness, roles, "draft-terminal");
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef: frozenRef2 }, { agent: harness.controller });
  await harness.store.mutate(cwd, (t) => ({ ...t, status: "completed" }), { policy: { kind: "policy" } });
  const terminalRes = await call("/team start fresh");
  assert.equal(terminalRes.kind, "success");
  const afterTerminal = await harness.store.read(cwd);
  assert.equal(afterTerminal.kind, "inactive");
});

test("orchestra_dismiss authorization check and handoffSummary with bifurcated cleanup", async () => {
  const harness = makeHarness();
  const roles = [
    { id: "live-role", name: "Live Role", preset: "preset-worker", sandbox: "workspace-write" },
    { id: "reserved-role", name: "Reserved Role", preset: "preset-worker", sandbox: "workspace-write" },
  ];
  const catalog = {
    find() { return { kind: "ready", topology: { id: "fleet-topo", title: "Fleet Topology", roles } }; },
  };
  const frozenRef = await prepareApprovedFrozenRef(harness, roles, "draft-dismiss");
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef }, { agent: harness.controller });

  // Materialize only live-role
  await dispatchRoleTask(
    harness.context,
    harness.store,
    { agent: harness.controller },
    { roleId: "live-role", task: "run tests" },
  );

  const unauthorizedAgent = { id: "unauthorized-session", session: { header: { cwd } } };
  // Non-controller cannot dismiss
  await assert.rejects(
    async () => {
      await orchestra_dismiss(
        harness.context,
        harness.store,
        harness.archiveStore,
        { agent: unauthorizedAgent },
        { reason: "unauthorized" },
      );
    },
    /orchestra_dismiss: only controller session "driver-1" can dismiss the team/,
  );

  // Controller dismisses with reason and summary
  const dismissResult = await orchestra_dismiss(
    harness.context,
    harness.store,
    harness.archiveStore,
    { agent: harness.controller },
    { reason: "mission accomplished", summary: "all tasks completed" },
  );

  assert.equal(dismissResult.status, "dismissed");
  assert.equal(dismissResult.reason, "mission accomplished");
  assert.equal(dismissResult.summary, "all tasks completed");

  // Verify handoffSummary written to archive
  const archived = await harness.archiveStore.read(cwd, dismissResult.archive_id);
  assert.equal(archived.kind, "ready");
  assert.equal(archived.snapshot.handoffSummary?.reason, "mission accomplished");
  assert.equal(archived.snapshot.handoffSummary?.summary, "all tasks completed");

  // Verify bifurcated cleanup: live agent was cancelled
  const liveSessionId = archived.snapshot.roles.find((r) => r.id === "live-role").sessionId;
  assert.ok(harness.events.includes(`agent:cancel:${liveSessionId}`));
});
