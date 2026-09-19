import { test } from "node:test";
import assert from "node:assert/strict";
import { createActiveTeamStateStore, transferOrchestrationControl } from "../lib/orchestra-state.js";
import { createArchiveStore } from "../lib/orchestra-archive.js";
import { charterRecordStoreFor } from "../lib/charter-store.js";
import {
  createGovernedTeam,
  addLanesToTeam,
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
      if (name === "tools") return {
        schemas: () => [
          { name: "read", description: "read", parameters: {} },
          { name: "orchestra_report", description: "escrow report", parameters: {} },
          { name: "fs_read", description: "read a file", parameters: {} },
          { name: "fs_search", description: "search files", parameters: {} },
          { name: "bash", description: "shell", parameters: {} },
          { name: "fs_write", description: "write a file", parameters: {} },
        ],
      };
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


function realRoleHarness() {
  const harness = makeHarness();
  const roles = [{ id: "worker", name: "Worker", preset: "preset-worker", sandbox: "workspace-write" }];
  const catalog = {
    find() { return { kind: "ready", topology: { id: "fleet-topo", title: "Fleet Topology", roles } }; },
  };
  return { harness, roles, catalog };
}

test("add lanes: the first call PLANS and changes nothing; confirm applies it as reserved roles", async () => {
  const { harness, roles, catalog } = realRoleHarness();
  const frozenRef = await prepareApprovedFrozenRef(harness, roles, "draft-lanes");
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef }, { agent: harness.controller });

  const before = await harness.store.read(cwd);
  assert.equal(before.kind, "ready");
  const rolesBefore = before.team.roles.length;

  // 1. No confirm: a plan, and the roster is untouched.
  const planned = await addLanesToTeam(harness.context, harness.store, { agent: harness.controller }, {
    roles: [{ roleId: "planner", preset: "orchestra-v04-planner-v1", sandbox: "read-only", phase: "planning", lane: "architecture", purpose: "decompose objective B" }],
    reason: "objective B",
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.plan.length, 1);
  assert.equal(planned.plan[0].roleId, "planner");
  assert.equal(planned.plan[0].sandbox, "read-only");
  assert.equal(planned.plan[0].phase, "planning");
  assert.equal(planned.plan[0].model, "default-p/default-m", "an added lane with no model override uses the deployment default");
  const untouched = await harness.store.read(cwd);
  assert.equal(untouched.kind, "ready");
  assert.equal(untouched.team.roles.length, rolesBefore, "planning a lane must not change the roster");
  assert.equal(untouched.team.addedLanes, undefined, "planning a lane must not record an amendment");

  // 2. confirm: the lane joins the SAME team, reserved, with the audit trail.
  const applied = await addLanesToTeam(harness.context, harness.store, { agent: harness.controller }, {
    roles: [{ roleId: "planner", preset: "orchestra-v04-planner-v1", sandbox: "read-only", phase: "planning", lane: "architecture", purpose: "decompose objective B" }],
    reason: "objective B",
    confirm: true,
  });
  assert.equal(applied.status, "added");
  assert.equal(applied.added.length, 1);
  assert.equal(applied.added[0].phase, "reserved");

  const after = await harness.store.read(cwd);
  assert.equal(after.kind, "ready");
  assert.equal(after.team.teamId, before.team.teamId, "an added lane joins the existing team; it never starts a second one");
  assert.equal(after.team.roles.length, rolesBefore + 1);
  const planner = after.team.roles.find((role) => role.id === "planner");
  assert.ok(planner);
  assert.equal(planner.phase, "reserved", "an added lane costs nothing until it is dispatched");
  assert.equal(planner.sandbox, "read-only");
  assert.equal(after.team.addedLanes.length, 1);
  assert.equal(after.team.addedLanes[0].roleId, "planner");
  assert.equal(after.team.addedLanes[0].lane, "architecture");
  assert.equal(after.team.addedLanes[0].reason, "objective B");

  // 3. The new lane is a real lane: dispatching it materializes it like any other.
  const dispatched = await dispatchRoleTask(harness.context, harness.store, { agent: harness.controller }, {
    roleId: "planner",
    task: "decompose objective B into a task card",
  });
  assert.equal(dispatched.status, "dispatched");
  assert.equal(dispatched.created_new_session, true);
  const final = await harness.store.read(cwd);
  assert.equal(final.team.roles.find((role) => role.id === "planner").phase, "active");
});

test("dispatch is idempotent on a reserved seat whose session already exists", async () => {
  const harness = makeHarness();
  const roles = [{ id: "worker", name: "Worker", preset: "preset-worker", sandbox: "workspace-write" }];
  const catalog = { find() { return { kind: "ready", topology: { id: "fleet-topo", title: "Fleet Topology", roles } }; } };
  const frozenRef = await prepareApprovedFrozenRef(harness, roles, "draft-idempotent");
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef }, { agent: harness.controller });
  await addLanesToTeam(harness.context, harness.store, { agent: harness.controller }, {
    roles: [{ roleId: "wordsmith", preset: "orchestra-v04-implementer-v1", sandbox: "workspace-write" }],
    confirm: true,
  });

  const before = await harness.store.read(cwd);
  const seat = before.team.roles.find((role) => role.id === "wordsmith");
  assert.equal(seat.phase, "reserved");

  // A session already sits on the reserved id: an earlier attempt created it and
  // a later step failed, or a reactivation rebuilt it. Creating it again fails
  // with "session ... already exists", which stranded a real lane in testing.
  harness.agents.set(seat.sessionId, {
    id: seat.sessionId,
    session: { header: { cwd }, snapshotEvents() { return []; }, append() {} },
    status: "idle",
    inbox: { hasPending: false },
    followup() { harness.events.push(`reused:${seat.sessionId}`); },
  });

  const dispatched = await dispatchRoleTask(harness.context, harness.store, { agent: harness.controller }, {
    roleId: "wordsmith",
    task: "finish the word list",
  });
  assert.equal(dispatched.status, "dispatched");
  assert.equal(dispatched.created_new_session, true);

  const after = await harness.store.read(cwd);
  const role = after.team.roles.find((entry) => entry.id === "wordsmith");
  assert.equal(role.phase, "active", "an existing session means the role is up, not failed");
  assert.equal(role.diagnostic, undefined, "the previous failure diagnostic must be cleared");
});

test("add lanes: refuses the cases that would corrupt the roster or the plan", async () => {
  const { harness, roles, catalog } = realRoleHarness();
  const frozenRef = await prepareApprovedFrozenRef(harness, roles, "draft-lanes-2");
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef }, { agent: harness.controller });
  const call = (args, agent = harness.controller) => addLanesToTeam(harness.context, harness.store, { agent }, args);

  // A role that is already on the roster is dispatched, not added.
  await assert.rejects(
    () => call({ roles: [{ roleId: "worker", preset: "orchestra-v04-planner-v1" }] }),
    /already exists in this team/,
  );
  // An unknown preset means a lane with no persona.
  await assert.rejects(
    () => call({ roles: [{ roleId: "auditor", preset: "orchestra-does-not-exist" }] }),
    /is not a known role preset/,
  );
  // Two roles with one id is a collision, not a feature.
  await assert.rejects(
    () => call({ roles: [{ roleId: "twin", preset: "orchestra-v04-planner-v1" }, { roleId: "twin", preset: "orchestra-v04-oracle-v1" }] }),
    /listed twice/,
  );
  await assert.rejects(() => call({ roles: [] }), /at least one role/);
  await assert.rejects(() => call({ roles: [{ roleId: "Bad_Id", preset: "orchestra-v04-planner-v1" }] }), /kebab-case/);
  await assert.rejects(() => call({ roles: [{ roleId: "x1", preset: "orchestra-v04-planner-v1", sandbox: "danger-full-access" }] }), /read-only. or .workspace-write/);

  // Only the controller may change the roster: a teammate cannot expand its own team.
  const intruder = { id: "worker-1", session: { header: { cwd }, snapshotEvents() { return []; }, append() {} } };
  await assert.rejects(
    () => call({ roles: [{ roleId: "helper", preset: "orchestra-v04-planner-v1" }], confirm: true }, intruder),
    /only the controller session/,
  );

  const observation = await harness.store.read(cwd);
  assert.equal(observation.team.roles.length, roles.length, "no refused call may leave a partially added roster");
});
