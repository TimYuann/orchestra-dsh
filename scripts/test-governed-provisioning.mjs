import { test } from "node:test";
import assert from "node:assert/strict";
import { createActiveTeamStateStore, normalizeTeam } from "../lib/orchestra-state.js";
import { prepareGovernedBlueprint, readGovernedBlueprint } from "../lib/session-blueprint.js";
import { assertUniqueGovernedSessionIds, prepareGovernedRolePlan, provisionGovernedPlans } from "../lib/orchestra.js";
import { preflightGovernedRequiredTools } from "../lib/session-blueprint.js";

const cwd = "/tmp/orchestra-governed-test";

class MemoryFs {
  constructor(events) {
    this.events = events;
    this.files = new Map();
    this.clock = 0;
    this.beforeWrite = undefined;
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
    this.events.push(`state:${expected?.kind ?? "none"}`);
    if (this.beforeWrite !== undefined) {
      const hook = this.beforeWrite;
      this.beforeWrite = undefined;
      hook(target, expected);
    }
    const existing = this.files.get(target.key);
    if (expected?.kind === "createIfAbsent" && existing !== undefined) throw Object.assign(new Error("race"), { code: "FS_NOT_OBSERVED" });
    if (expected?.kind === "replaceIfVersion" && (existing === undefined || existing.version !== expected.version)) throw Object.assign(new Error("stale"), { code: "FS_STALE_VERSION" });
    const version = `v${++this.clock}`;
    this.files.set(target.key, { content, version });
    return { operation: existing === undefined ? "create" : "update", version, before: existing?.content ?? null, after: content };
  }
}

function makeRuntime(options = {}) {
  const events = [];
  const fs = new MemoryFs(events);
  const sessions = new Map();
  const agents = new Map();
  const presets = {
    defaultId: "default",
    composedPreset(context) {
      return context.composedPreset;
    },
    async resolve(id) {
      if (options.brokenPreset === id) throw new Error(`broken preset ${id}`);
      return { id };
    },
    async mount(context, id) {
      events.push(`mount:${id}`);
      context.composedPreset = id;
    },
    composeFrom(context, parent) {
      context.composedPreset = parent.composedPreset;
      return parent.composedPreset;
    },
  };
  const permissionSpecs = {
    workspace: { sandbox: "workspace-write", approval: "ask" },
    safe: { sandbox: "read-only", approval: "ask" },
  };
  const permissions = {
    defaultPreset: "workspace",
    resolve(name) {
      if (permissionSpecs[name] === undefined) throw new Error(`unknown permission ${name}`);
      return permissionSpecs[name];
    },
    set(session, name) {
      session.append("permission/preset", { preset: name });
    },
    current(log) {
      const preset = [...log].reverse().find((entry) => entry.type === "permission/preset")?.data.preset;
      const sandbox = [...log].reverse().find((entry) => entry.type === "sandbox/mode")?.data.mode;
      if (preset === undefined) return "custom";
      return sandbox !== undefined && sandbox !== permissionSpecs[preset]?.sandbox ? "custom" : preset;
    },
  };
  const tools = {
    schemas() {
      return (options.tools ?? ["read", "write"]).map((name) => ({ name, description: name, parameters: {} }));
    },
  };
  const sessionFor = (id) => {
    const existing = sessions.get(id);
    if (existing !== undefined) return existing;
    const session = {
      id,
      events: [],
      header: { cwd },
      append(type, data) {
        this.events.push({ type, data, seq: this.events.length, time: Date.now() });
      },
    };
    sessions.set(id, session);
    return session;
  };
  const childContext = (id) => ({
    ...context,
    composedPreset: undefined,
    get(name) {
      if (name === "sessions") return { get: (sessionId) => sessions.get(String(sessionId)) };
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      return context.get(name);
    },
    agentId: id,
  });
  const controllerSession = sessionFor("driver");
  const controller = { id: "driver", session: controllerSession, options: {}, ctx: { composedPreset: "controller" } };
  const serviceMap = { agentPresets: presets, permissionPresets: permissions, tools, agentDefaultModel: { currentSelection: () => options.model ?? { provider: "default-provider", model: "default-model" } }, sessions };
  const context = {
    get(name) {
      return serviceMap[name];
    },
    sessions: {
      get(id) {
        return sessions.get(String(id));
      },
      async flush(session) {
        events.push(`flush:${session.id}`);
        if (options.flushFailure) throw new Error("flush failed");
        return true;
      },
    },
    agents: {
      get(id) {
        return agents.get(String(id));
      },
      async create(createOptions) {
        const id = String(createOptions.sessionId);
        events.push(`create:${id}`);
        if (options.failSession === id) throw new Error(`create failed ${id}`);
        const session = sessionFor(id);
        const child = childContext(id);
        try {
          const commit = await createOptions.setup(child);
          commit?.commit();
        } catch (error) {
          sessions.delete(id);
          throw error;
        }
        const agent = {
          id,
          session,
          ctx: child,
          options: createOptions.agentOptions ?? {},
          status: "idle",
          followup(message) {
            events.push(`welcome:${id}`);
            session.append("user/message", message);
          },
        };
        agents.set(id, agent);
        return {
          agent,
          async dispose() {
            events.push(`dispose:${id}`);
            agents.delete(id);
            sessions.delete(id);
          },
        };
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
    on() {
      return () => {};
    },
  };
  return { context, fs, store: createActiveTeamStateStore(fs), events, sessions, agents, presets, permissions, controller };
}

function planTeam(teamId, roles) {
  return {
    schemaVersion: 1,
    teamId,
    status: "provisioning",
    rootCwd: cwd,
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "trio", source: "bundled" },
    mission: { objective: "test", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    roles,
    reports: [],
  };
}

async function prepared(runtime, roleId, overrides = {}) {
  return prepareGovernedBlueprint(runtime.context, {
    sessionId: `orchestra-team-test-${roleId}`,
    teamId: "team-test",
    roleId,
    roleName: roleId,
    topologyId: "trio",
    topologySource: "bundled",
    controllerSessionId: "driver",
    cwd,
    presetId: `preset-${roleId}`,
    sandbox: "read-only",
    runtime: { provider: "runtime-provider", model: "runtime-model", reasoningEffort: "medium" },
    requiredTools: ["read"],
    ...overrides,
  });
}

test("Governed marker read is total and requires mode-specific identity", () => {
  const valid = {
    schemaVersion: 1,
    mode: "governed",
    teamId: "team",
    roleId: "reviewer",
    topologyId: "trio",
    topologySource: "bundled",
    controllerSessionId: "driver",
    agentPreset: "preset",
    permissionPreset: "workspace",
    effectivePermissionPreset: "custom",
    approval: "ask",
    sandbox: "read-only",
    provider: "provider",
    model: "model",
    cwd,
    createdAt: 1,
  };
  assert.deepEqual(readGovernedBlueprint([{ type: "orchestra/governed-blueprint", data: valid }]), valid);
  for (const data of [null, [], { ...valid, teamId: "" }, { ...valid, roleId: "" }, { ...valid, topologyId: "" }, { ...valid, mode: "lightweight" }, { ...valid, createdAt: Infinity }, { ...valid, createdBySessionId: "driver" }]) {
    assert.doesNotThrow(() => readGovernedBlueprint([{ type: "orchestra/governed-blueprint", data }]));
    assert.equal(readGovernedBlueprint([{ type: "orchestra/governed-blueprint", data }]), undefined);
  }
  assert.equal(readGovernedBlueprint([{ type: "orchestra/blueprint", data: {} }]), undefined);
});

test("team state preserves provisioning phases and reads legacy roles as active with a warning", async () => {
  const legacy = normalizeTeam({ roles: [{ id: "reviewer", sessionId: "legacy-session" }] }, cwd);
  assert.equal(legacy.roles[0].phase, "active");
  const runtime = makeRuntime();
  const team = planTeam("team-provisioning", [{ id: "reviewer", name: "reviewer", sessionId: "reserved-session", phase: "reserved", sessionHistory: [], preset: "preset-reviewer", sandbox: "read-only", reportCount: 0, lastReport: null }]);
  team.status = "provisioning";
  const written = await runtime.store.create(cwd, team, { policy: {} });
  assert.equal(written.snapshot.team.status, "provisioning");
  const observed = await runtime.store.read(cwd);
  assert.equal(observed.kind, "ready");
  assert.equal(observed.team.roles[0].phase, "reserved");
  assert.equal(observed.team.status, "provisioning");
});

test("Governed Blueprint preflight failure has no state or session side effects", async () => {
  const runtime = makeRuntime({ brokenPreset: "broken" });
  await assert.rejects(
    () => prepareGovernedBlueprint(runtime.context, {
      sessionId: "orchestra-team-test-broken",
      teamId: "team-test",
      roleId: "broken",
      roleName: "broken",
      topologyId: "trio",
      topologySource: "bundled",
      controllerSessionId: "driver",
      cwd,
      presetId: "broken",
    }),
    /broken preset/,
  );
  assert.equal(runtime.fs.files.size, 0);
  assert.equal(runtime.agents.size, 0);
});

test("successful transaction activates every reserved role only after welcome durability", async () => {
  const runtime = makeRuntime();
  const first = await prepared(runtime, "reviewer");
  const second = await prepared(runtime, "reviewer-2");
  const plans = [first, second].map((blueprint, index) => ({
    roleId: index === 0 ? "reviewer" : "reviewer-2",
    roleName: index === 0 ? "reviewer" : "reviewer-2",
    sessionId: blueprint.receipt.sessionId,
    presetId: blueprint.receipt.agentPreset,
    sandbox: blueprint.receipt.sandbox,
    blueprint,
  }));
  const roles = plans.map((plan) => ({ id: plan.roleId, name: plan.roleName, sessionId: plan.sessionId, phase: "reserved", sessionHistory: [], preset: plan.presetId, sandbox: plan.sandbox, reportCount: 0, lastReport: null }));
  const reservation = await runtime.store.create(cwd, planTeam("team-test", roles), { policy: {} });
  const result = await provisionGovernedPlans(runtime.context, runtime.store, { agent: runtime.controller }, cwd, reservation.snapshot, plans, "active", "failed");
  assert.equal(result.team.status, "active");
  assert.deepEqual(result.team.roles.map((role) => role.phase), ["active", "active"]);
  assert.equal(runtime.agents.size, 2);
  const flushIndex = runtime.events.indexOf("flush:orchestra-team-test-reviewer");
  const activeCasIndex = runtime.events.lastIndexOf("state:replaceIfVersion");
  assert.ok(flushIndex > runtime.events.indexOf("create:orchestra-team-test-reviewer"));
  assert.ok(activeCasIndex > flushIndex, "welcome flush precedes the role active CAS");
  assert.ok(result.team.roles.every((role) => role.welcome?.acceptedAt > 0));
});

test("Governed Blueprint applies explicit model over topology runtime and records permission/sandbox/tools", async () => {
  const runtime = makeRuntime();
  const runtimeDefault = await prepared(runtime, "runtime-default");
  assert.equal(runtimeDefault.receipt.provider, "runtime-provider");
  assert.equal(runtimeDefault.receipt.model, "runtime-model");
  const blueprint = await prepared(runtime, "reviewer", { provider: "explicit-provider", model: "explicit-model", reasoningEffort: "high" });
  assert.equal(blueprint.receipt.provider, "explicit-provider");
  assert.equal(blueprint.receipt.model, "explicit-model");
  assert.equal(blueprint.receipt.sandbox, "read-only");
  runtime.sessions.set("orchestra-team-test-reviewer", { id: "orchestra-team-test-reviewer", events: [], header: { cwd }, append(type, data) { this.events.push({ type, data }); } });
  const commit = await blueprint.setup({ ...runtime.context, composedPreset: undefined, get: (name) => name === "agentPresets" ? runtime.presets : name === "permissionPresets" ? runtime.permissions : runtime.context.get(name) });
  commit.commit();
  assert.equal(blueprint.receipt.effectivePermissionPreset, "custom");
  assert.deepEqual(blueprint.receipt.tools, { names: ["read", "write"], count: 2 });
  assert.equal(readGovernedBlueprint(runtime.sessions.get("orchestra-team-test-reviewer").events).teamId, "team-test");
});

test("Governed required tool failure rolls setup back before publication", async () => {
  const runtime = makeRuntime({ tools: ["write"] });
  const blueprint = await prepared(runtime, "missing-tool");
  runtime.sessions.set(blueprint.receipt.sessionId, { id: blueprint.receipt.sessionId, events: [], header: { cwd }, append(type, data) { this.events.push({ type, data }); } });
  await assert.rejects(
    async () => {
      const commit = await blueprint.setup({ ...runtime.context, composedPreset: undefined, get: (name) => name === "agentPresets" ? runtime.presets : name === "permissionPresets" ? runtime.permissions : runtime.context.get(name), on: () => () => {} });
      commit.commit();
    },
    (error) => error?.code === "required_tools_missing",
  );
});

test("Governed create preflights required capabilities before reservation and fails closed for preset files", async () => {
  const runtime = makeRuntime();
  await assert.rejects(
    () => prepareGovernedRolePlan(runtime.context, {
      cwd,
      teamId: "team-preflight",
      controllerSessionId: "driver",
      topologyId: "trio",
      topologySource: "bundled",
      role: { id: "reviewer", name: "reviewer", preset: "preset-reviewer", sandbox: "read-only", requiredTools: ["missing-tool"] },
    }),
    (error) => error?.code === "required_tools_unproven" && /reservation was not attempted/.test(error.message),
  );
  assert.equal(runtime.fs.files.size, 0, "preflight failure does not write active Team state");
  assert.equal(runtime.agents.size, 0, "preflight failure does not create an Agent");
  assert.throws(
    () => preflightGovernedRequiredTools({ presetFile: { id: "preset-reviewer", trust: "user", path: "/tmp/preset.yml" }, requiredTools: ["missing-tool"] }),
    (error) => error?.code === "required_tools_unproven",
  );
});

test("role ids that normalize alike receive independent reserved SessionIds", async () => {
  const runtime = makeRuntime();
  const plans = [];
  for (const roleId of ["a/b", "a-b"]) {
    plans.push(await prepareGovernedRolePlan(runtime.context, {
      cwd,
      teamId: "team-collision",
      controllerSessionId: "driver",
      topologyId: "custom",
      topologySource: "bundled",
      role: { id: roleId, name: roleId, preset: "preset-reviewer", sandbox: "workspace-write" },
    }));
  }
  assert.notEqual(plans[0].sessionId, plans[1].sessionId);
  assert.doesNotThrow(() => assertUniqueGovernedSessionIds(plans));
});

test("transaction reserves all mappings before create, flushes before active CAS, and cleans failed roles", async () => {
  const runtime = makeRuntime({ failSession: "orchestra-team-test-reviewer-2" });
  const first = await prepared(runtime, "reviewer");
  const second = await prepared(runtime, "reviewer-2");
  const roles = [first, second].map((blueprint, index) => ({
    id: index === 0 ? "reviewer" : "reviewer-2",
    name: index === 0 ? "reviewer" : "reviewer-2",
    sessionId: blueprint.receipt.sessionId,
    phase: "reserved",
    sessionHistory: [],
    preset: blueprint.receipt.agentPreset,
    sandbox: blueprint.receipt.sandbox,
    reportCount: 0,
    lastReport: null,
  }));
  const reservation = await runtime.store.create(cwd, planTeam("team-test", roles), { policy: {} });
  let failure;
  try {
    await provisionGovernedPlans(runtime.context, runtime.store, { agent: runtime.controller }, cwd, reservation.snapshot, [
      { roleId: "reviewer", roleName: "reviewer", sessionId: first.receipt.sessionId, presetId: first.receipt.agentPreset, sandbox: first.receipt.sandbox, blueprint: first },
      { roleId: "reviewer-2", roleName: "reviewer-2", sessionId: second.receipt.sessionId, presetId: second.receipt.agentPreset, sandbox: second.receipt.sandbox, blueprint: second },
    ], "active", "failed");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /create failed/);
  assert.equal(runtime.events[0], "state:createIfAbsent");
  assert.ok(runtime.events.indexOf("create:orchestra-team-test-reviewer") > 0);
  assert.equal(runtime.agents.size, 0, "failed transaction disposes the live handle it created");
  const state = await runtime.store.read(cwd);
  assert.equal(state.kind, "ready");
  assert.equal(state.team.status, "failed");
  assert.equal(state.team.roles.find((role) => role.id === "reviewer-2").phase, "failed");
  assert.equal(state.team.roles.length, 2, "reserved mappings remain diagnosable after failure");
});

test("welcome flush failure never promotes a role active", async () => {
  const runtime = makeRuntime({ flushFailure: true });
  const blueprint = await prepared(runtime, "reviewer");
  const role = { id: "reviewer", name: "reviewer", sessionId: blueprint.receipt.sessionId, phase: "reserved", sessionHistory: [], preset: blueprint.receipt.agentPreset, sandbox: blueprint.receipt.sandbox, reportCount: 0, lastReport: null };
  const reservation = await runtime.store.create(cwd, planTeam("team-test", [role]), { policy: {} });
  await assert.rejects(
    () => provisionGovernedPlans(runtime.context, runtime.store, { agent: runtime.controller }, cwd, reservation.snapshot, [{ roleId: "reviewer", roleName: "reviewer", sessionId: blueprint.receipt.sessionId, presetId: blueprint.receipt.agentPreset, sandbox: blueprint.receipt.sandbox, blueprint }], "active", "failed"),
    /flush failed/,
  );
  const state = await runtime.store.read(cwd);
  assert.equal(state.kind, "ready");
  assert.equal(state.team.roles[0].phase, "failed");
  assert.equal(runtime.agents.size, 0);
});

test("stale state CAS stops provisioning without reread-overwrite", async () => {
  const runtime = makeRuntime();
  const blueprint = await prepared(runtime, "reviewer");
  const role = { id: "reviewer", name: "reviewer", sessionId: blueprint.receipt.sessionId, phase: "reserved", sessionHistory: [], preset: blueprint.receipt.agentPreset, sandbox: blueprint.receipt.sandbox, reportCount: 0, lastReport: null };
  const reservation = await runtime.store.create(cwd, planTeam("team-test", [role]), { policy: {} });
  let replaceCount = 0;
  const staleHook = (target, expected) => {
    if (expected?.kind !== "replaceIfVersion") return;
    replaceCount += 1;
    if (replaceCount !== 2) {
      runtime.fs.beforeWrite = staleHook;
      return;
    }
    const current = runtime.fs.files.get(target.key);
    runtime.fs.files.set(target.key, { content: current.content, version: "external-writer" });
  };
  runtime.fs.beforeWrite = staleHook;
  await assert.rejects(
    () => provisionGovernedPlans(runtime.context, runtime.store, { agent: runtime.controller }, cwd, reservation.snapshot, [{ roleId: "reviewer", roleName: "reviewer", sessionId: blueprint.receipt.sessionId, presetId: blueprint.receipt.agentPreset, sandbox: blueprint.receipt.sandbox, blueprint }], "active", "failed"),
    /stale state CAS/,
  );
  assert.equal(runtime.agents.size, 0);
  assert.equal(replaceCount, 2);
});
