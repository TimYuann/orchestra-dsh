import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverMessage, queryMessageStatus } from "../lib/a2a-transport.js";
import { listThreads, sendRawA2A } from "../lib/a2a.js";
import { createGovernedRoleAddressResolver, GovernedAddressError } from "../lib/orchestra-address.js";
import { sendGovernedRole } from "../lib/orchestra.js";

function session(id, cwd = "/caller") {
  return {
    id,
    header: { id, cwd, seedLength: 0, agentPreset: "preset" },
    events: [],
    append(type, data) {
      this.events.push({ type, data, seq: this.events.length, time: Date.now() });
    },
  };
}

function runtime() {
  const sessions = new Map();
  const agents = new Map();
  const coldSnapshots = new Map();
  const queryRecords = [];
  const query = {
    async readSession(id) {
      const value = sessions.get(String(id));
      if (value === undefined) {
        const cold = coldSnapshots.get(String(id));
        if (cold !== undefined) return cold;
        throw Object.assign(new Error("not found"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      }
      return { session: value.header, events: value.events };
    },
    async listSessions() {
      return queryRecords;
    },
    async readTitleSnapshots() {
      return [];
    },
  };
  const presets = {
    async resolve(id) {
      return { id, path: `/tmp/${id}.yml`, trust: "user" };
    },
    async mount() {},
  };
  const context = {
    agents: {
      get(id) {
        return agents.get(String(id));
      },
      list() {
        return [...agents.values()];
      },
      async resume(options) {
        await options.setup({ on() { return () => {}; } });
        const target = sessions.get(String(options.resumeSessionId)) ?? session(String(options.resumeSessionId), "/cold");
        const agent = {
          id: target.id,
          session: target,
          status: "idle",
          followup(message) { target.append("user/message", message); },
          inject(message) { target.append("user/message", message); },
          steer(message) { target.append("user/message", message); },
        };
        sessions.set(target.id, target);
        agents.set(target.id, agent);
        return { agent, async dispose() { agents.delete(target.id); } };
      },
    },
    sessions: {
      get(id) {
        return sessions.get(String(id));
      },
    },
    get(name) {
      if (name === "sessionQuery") return query;
      if (name === "agentPresets") return presets;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      return undefined;
    },
  };
  return { context, sessions, agents, coldSnapshots, queryRecords, query };
}

test("raw transport accepts live, durable, and cold-resumed delivery without fs/team services", async () => {
  const env = runtime();
  const sender = session("sender", "/caller");
  const target = session("target", "/other");
  env.sessions.set(sender.id, sender);
  env.sessions.set(target.id, target);
  env.agents.set(sender.id, { id: sender.id, session: sender, status: "idle" });
  env.agents.set(target.id, { id: target.id, session: target, status: "idle", followup() {}, inject() {}, steer() {} });
  const live = await deliverMessage(env.context, sender.id, target.id, [{ type: "text", text: "live" }]);
  assert.equal(live.state, "accepted");
  assert.equal(live.delivery_mode, "live_inbox");

  env.agents.delete(target.id);
  const durable = await deliverMessage(env.context, sender.id, target.id, [{ type: "text", text: "durable" }]);
  assert.equal(durable.state, "accepted");
  assert.equal(durable.delivery_mode, "durable_inbox");

  env.coldSnapshots.set(target.id, { session: target.header, events: target.events });
  env.sessions.delete(target.id);
  const resumed = await deliverMessage(env.context, sender.id, target.id, [{ type: "text", text: "cold" }]);
  assert.equal(resumed.state, "accepted");
  assert.equal(resumed.delivery_mode, "resumed_inbox");
});

test("raw transport remains cross-cwd reachable when discovery/fs is unavailable", async () => {
  const env = runtime();
  const sender = session("sender", "/caller");
  const target = session("target", "/other");
  env.sessions.set(sender.id, sender);
  env.sessions.set(target.id, target);
  env.agents.set(sender.id, { id: sender.id, session: sender, status: "idle" });
  env.agents.set(target.id, { id: target.id, session: target, status: "idle", followup() {}, inject() {}, steer() {} });
  const originalGet = env.context.get;
  env.context.get = (name) => {
    if (name === "fs" || name === "sessionQuery") throw new Error("discovery unavailable");
    return originalGet(name);
  };
  const receipt = await sendRawA2A(env.context, { to: target.id, message: "cross cwd" }, { agent: env.agents.get(sender.id) });
  assert.equal(receipt.target_session_id, target.id);
  assert.equal(receipt.state, "accepted");
});

test("cold resume uses persisted file-backed Blueprint source without DSH resolver, while legacy falls back", async () => {
  const snapshot = {
    session: { id: "cold-file", agentPreset: "project-preset" },
    events: [{ type: "orchestra/blueprint", data: { schemaVersion: 1, mode: "lightweight", agentPreset: "project-preset", presetSource: "file", presetPath: "/project/.orchestra/presets/project-preset/agent.cordis.yml", presetTrust: "user", permissionPreset: "workspace", provider: "p", model: "m", createdBySessionId: "caller", createdAt: 1 } }],
  };
  let live;
  let resumeOptions;
  let resolveCalls = 0;
  const ctx = {
    agents: {
      get() { return live; },
      async resume(options) {
        resumeOptions = options;
        live = { id: "cold-file", followup() {}, inject() {}, steer() {} };
      },
    },
    sessions: { get() { return undefined; } },
    get(name) {
      if (name === "sessionQuery") return { async readSession() { return snapshot; } };
      if (name === "agentPresets") return { async resolve() { resolveCalls += 1; throw new Error("unknown preset"); }, async mount() {} };
      return undefined;
    },
  };
  const receipt = await deliverMessage(ctx, "caller", "cold-file", [{ type: "text", text: "file resume" }]);
  assert.equal(receipt.delivery_mode, "resumed_inbox");
  assert.equal(resolveCalls, 0);
  assert.ok(resumeOptions?.setup, "resume received a public setup path");

  live = undefined;
  resolveCalls = 0;
  const legacy = { ...snapshot, session: { id: "cold-legacy", agentPreset: "legacy-preset" }, events: [{ type: "orchestra/blueprint", data: { schemaVersion: 1, mode: "lightweight", agentPreset: "legacy-preset", permissionPreset: "workspace", provider: "p", model: "m", createdBySessionId: "caller", createdAt: 1 } }] };
  const legacyCtx = { ...ctx, agents: { get() { return live; }, async resume() { throw new Error("resume should not happen"); } }, get(name) { if (name === "sessionQuery") return { async readSession() { return legacy; } }; if (name === "agentPresets") return { async resolve() { resolveCalls += 1; throw new Error("unknown legacy preset"); } }; return undefined; } };
  await assert.rejects(() => deliverMessage(legacyCtx, "caller", "cold-legacy", [{ type: "text", text: "legacy" }]), /unknown legacy preset/);
  assert.equal(resolveCalls, 1);
});

test("explicit idempotency key deduplicates live, durable, and cold retries", async () => {
  const liveEnv = runtime();
  const liveTarget = session("live-target");
  let liveCalls = 0;
  const liveAgent = { id: liveTarget.id, session: liveTarget, inbox: { nextTurn: [], nextStep: [] }, followup(message) { liveCalls += 1; this.inbox.nextTurn.push(message); }, inject() {}, steer() {} };
  liveEnv.sessions.set(liveTarget.id, liveTarget);
  liveEnv.agents.set(liveTarget.id, liveAgent);
  const liveA = await deliverMessage(liveEnv.context, "sender", liveTarget.id, [{ type: "text", text: "x" }], { idempotencyKey: "retry-live" });
  const liveB = await deliverMessage(liveEnv.context, "sender", liveTarget.id, [{ type: "text", text: "x" }], { idempotencyKey: "retry-live" });
  assert.equal(liveA.message_id, liveB.message_id);
  assert.equal(liveCalls, 1);

  const durableEnv = runtime();
  const durableTarget = session("durable-target");
  durableEnv.sessions.set(durableTarget.id, durableTarget);
  const durableA = await deliverMessage(durableEnv.context, "sender", durableTarget.id, [{ type: "text", text: "x" }], { idempotencyKey: "retry-durable" });
  const durableB = await deliverMessage(durableEnv.context, "sender", durableTarget.id, [{ type: "text", text: "x" }], { idempotencyKey: "retry-durable" });
  assert.equal(durableA.message_id, durableB.message_id);
  assert.equal(durableTarget.events.filter((event) => event.type === "agent/inbox/spliced").length, 1);

  const coldEnv = runtime();
  let resumeCount = 0;
  const coldTarget = session("cold-target");
  coldEnv.coldSnapshots.set(coldTarget.id, { session: coldTarget.header, events: coldTarget.events });
  coldEnv.context.agents.resume = async () => {
    resumeCount += 1;
    const inbox = { nextTurn: [], nextStep: [] };
    const agent = { id: coldTarget.id, session: coldTarget, inbox, followup(message) { inbox.nextTurn.push(message); }, inject() {}, steer() {} };
    coldEnv.sessions.set(coldTarget.id, coldTarget);
    coldEnv.agents.set(coldTarget.id, agent);
  };
  const coldA = await deliverMessage(coldEnv.context, "sender", coldTarget.id, [{ type: "text", text: "x" }], { idempotencyKey: "retry-cold" });
  const coldB = await deliverMessage(coldEnv.context, "sender", coldTarget.id, [{ type: "text", text: "x" }], { idempotencyKey: "retry-cold" });
  assert.equal(coldA.message_id, coldB.message_id);
  assert.equal(resumeCount, 1);
});

test("message lifecycle reports only correlated accepted/claimed/answered facts", async () => {
  const env = runtime();
  const target = session("target");
  env.sessions.set(target.id, target);
  const message = { id: "message-1", role: "user", content: [], source: { kind: "a2a", form: "relay" } };
  target.append("agent/inbox/spliced", { target: "next-turn", inserted: [message] });
  assert.equal((await queryMessageStatus(env.context, message.id, target.id)).state, "accepted");
  target.append("user/message", message);
  assert.equal((await queryMessageStatus(env.context, message.id, target.id)).state, "claimed");
  target.append("assistant/message", { message: { id: "answer", role: "assistant", content: [], source: { kind: "model", replyTo: message.id } } });
  assert.equal((await queryMessageStatus(env.context, message.id, target.id)).state, "answered");
  target.events.push({ type: "assistant/message", data: null });
  assert.equal((await queryMessageStatus(env.context, "unknown", target.id)).state, "unknown");
  const unrelated = session("unrelated");
  unrelated.events.push({ type: "assistant/message", data: { message: { id: "answer", role: "assistant", content: [], source: { kind: "model", replyTo: "ghost-message" } } } });
  env.sessions.set(unrelated.id, unrelated);
  assert.equal((await queryMessageStatus(env.context, "ghost-message", unrelated.id)).state, "unknown");
  unrelated.events.unshift({ type: "user/message", data: { id: "non-a2a", role: "user", content: [], source: { kind: "user" } } });
  unrelated.events.push({ type: "assistant/message", data: { message: { id: "answer-2", role: "assistant", content: [], source: { kind: "model", replyTo: "non-a2a" } } } });
  assert.equal((await queryMessageStatus(env.context, "non-a2a", unrelated.id)).state, "unknown");
});

test("discovery stays progressive and host-visible when annotations fail", async () => {
  const env = runtime();
  const caller = session("caller", "/caller");
  const other = session("other", "/other");
  env.agents.set(caller.id, { id: caller.id, session: caller, status: "idle" });
  env.agents.set(other.id, { id: other.id, session: other, status: "idle" });
  env.queryRecords.push({ header: { id: "cold-wild", cwd: undefined }, live: false });
  env.context.get = (name) => {
    if (name === "fs") throw new Error("annotation fs unavailable");
    if (name === "sessionQuery") return { ...env.query, async readTitleSnapshots() { throw new Error("title adapter unavailable"); } };
    return runtime().context.get(name);
  };
  const listed = await listThreads(env.context, { driverCwd: "/caller", includeOtherCwds: false });
  assert.deepEqual(listed.threads.map((entry) => entry.sessionId), ["caller", "other", "cold-wild"]);
});

function teamState(status = "active", rolePhase = "active", roleSession = "role-current") {
  return {
    kind: "ready",
    cwd: "/caller",
    compatibility: { source: "v1.1", legacy: false, migratedFields: [] },
    warnings: [],
    diagnostic: { code: "filesystem", message: "ready" },
    version: {},
    team: {
      schemaVersion: 1,
      teamId: "team-address",
      status,
      rootCwd: "/caller",
      controllerSessionId: "driver",
      controllerHistory: [],
      topologyRef: { id: "trio", source: "bundled" },
      mission: { objective: "test", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
      createdAt: 1,
      activatedFromArchiveId: null,
      roles: [{ id: "reviewer", name: "Reviewer", sessionId: roleSession, phase: rolePhase, sessionHistory: [], preset: "preset", sandbox: "workspace-write", reportCount: 0, lastReport: null }],
      reports: [],
    },
  };
}

test("Governed address resolves exact team/role current mapping and tracks replacement", async () => {
  let state = teamState();
  const store = { async read() { return state; } };
  const resolver = createGovernedRoleAddressResolver(store);
  let address = await resolver.resolve("/caller", "team-address", "REVIEWER");
  assert.equal(address.resolved_session_id, "role-current");
  state = teamState("active", "active", "role-replacement");
  address = await resolver.resolve("/caller", "team-address", "reviewer");
  assert.equal(address.resolved_session_id, "role-replacement");
  await assert.rejects(() => resolver.resolve("/caller", "wrong-team", "reviewer"), (error) => error instanceof GovernedAddressError && error.code === "team_mismatch");
  state = teamState("provisioning", "active");
  await assert.rejects(() => resolver.resolve("/caller", "team-address", "reviewer"), (error) => error instanceof GovernedAddressError && error.code === "team_unavailable");
  state = teamState("active", "failed");
  await assert.rejects(() => resolver.resolve("/caller", "team-address", "reviewer"), (error) => error instanceof GovernedAddressError && error.code === "role_not_active");
});

test("orchestra_send resolves role address and reuses raw transport receipt", async () => {
  const env = runtime();
  const caller = session("driver", "/caller");
  const target = session("role-current", "/caller");
  env.sessions.set(caller.id, caller);
  env.sessions.set(target.id, target);
  env.agents.set(caller.id, { id: caller.id, session: caller, status: "idle" });
  env.agents.set(target.id, { id: target.id, session: target, status: "idle", followup() {}, inject() {}, steer() {} });
  const resolver = createGovernedRoleAddressResolver({ async read() { return teamState(); } });
  const result = await sendGovernedRole(env.context, resolver, { teamId: "team-address", roleId: "reviewer", message: "dispatch" }, { agent: env.agents.get(caller.id) });
  assert.equal(result.role_id, "reviewer");
  assert.equal(result.resolved_session_id, "role-current");
  assert.equal(result.receipt.state, "accepted");
  await assert.rejects(() => sendGovernedRole(env.context, createGovernedRoleAddressResolver({ async read() { return teamState("active", "active", "driver"); } }), { teamId: "team-address", roleId: "reviewer", message: "self" }, { agent: env.agents.get(caller.id) }), /own Governed role/);
});
