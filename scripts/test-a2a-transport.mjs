import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverMessage, queryMessageStatus } from "../lib/a2a-transport.js";
import { listThreads, sendRawA2A } from "../lib/a2a.js";
import { createGovernedRoleAddressResolver, GovernedAddressError } from "../lib/orchestra-address.js";
import { sendGovernedRole } from "../lib/orchestra.js";
import { createMemoryReceiptStore } from "../lib/receipt-store.js";

// Doubles model the DSH 0.1.5-rc.2 Session surface: `snapshotEvents()` replaces
// the removed `.events` property, and `inheritedEventCount` replaces
// `header.seedLength` as the fork-inherited prefix length.
function session(id, cwd = "/caller") {
  return {
    id,
    header: { id, cwd, agentPreset: "preset" },
    inheritedEventCount: 0,
    events: [],
    snapshotEvents() {
      return this.events;
    },
    append(type, data) {
      this.events.push({ type, data, seq: this.events.length, time: Date.now() });
    },
  };
}

function runtime(options = {}) {
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
      if (name === "subagents") return options.subagents;
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

test("cold resume takes the composition marker from its store, not from the session log", async () => {
  // The marker is a plugin record now. It is deliberately NOT in `events`: a
  // custom event type in a persisted log makes DSH refuse the whole log.
  const markers = new Map([
    ["cold-file", { schemaVersion: 1, mode: "lightweight", agentPreset: "project-preset", presetSource: "file", presetPath: "/project/.orchestra/presets/project-preset/agent.cordis.yml", presetTrust: "user", permissionPreset: "workspace", provider: "p", model: "m", createdBySessionId: "caller", createdAt: 1 }],
  ]);
  const markerStore = {
    async read(sessionId) { return markers.get(sessionId); },
    async write(sessionId, marker) { markers.set(sessionId, marker); },
  };
  const fileSnapshot = {
    session: { id: "cold-file", cwd: "/project", agentPreset: "project-preset" },
    events: [],
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
      // Every cold snapshot has an EMPTY log: nothing about the composition is
      // readable from it any more, which is the point of the store.
      if (name === "sessionQuery") return { async readSession(id) { return { session: { ...fileSnapshot.session, id: String(id) }, events: [] }; } };
      if (name === "agentPresets") return { async resolve() { resolveCalls += 1; throw new Error("unknown preset"); }, async mount() {} };
      return undefined;
    },
  };
  const receipt = await deliverMessage(ctx, "caller", "cold-file", [{ type: "text", text: "file resume" }], { resolveBlueprintStore: () => markerStore });
  assert.equal(receipt.delivery_mode, "resumed_inbox");
  // The file-path marker needs no roster lookup: prove it by the resolver still
  // being untouched while the log the marker supposedly came from is EMPTY.
  assert.equal(resolveCalls, 0);
  assert.ok(resumeOptions?.setup, "resume received a public setup path");

  // A marker with no file path still resolves through the roster — that path is
  // unchanged, it just gets its marker from the same store.
  live = undefined;
  resolveCalls = 0;
  markers.set("cold-legacy", { schemaVersion: 1, mode: "lightweight", agentPreset: "legacy-preset", permissionPreset: "workspace", provider: "p", model: "m", createdBySessionId: "caller", createdAt: 1 });
  await assert.rejects(
    () => deliverMessage(ctx, "caller", "cold-legacy", [{ type: "text", text: "legacy" }], { resolveBlueprintStore: () => markerStore }),
    /unknown preset/,
  );
  assert.equal(resolveCalls, 1);

  // No store at all: the resume still works off the header's preset projection,
  // which is the documented degradation rather than a crash.
  live = undefined;
  let headerResolves = 0;
  const headerCtx = {
    ...ctx,
    agents: { get() { return live; }, async resume(options) { resumeOptions = options; live = { id: "cold-file", followup() {}, inject() {}, steer() {} }; } },
    get(name) {
      if (name === "sessionQuery") return { async readSession(id) { return { session: { id: String(id), cwd: "/project", agentPreset: "header-preset" }, events: [] }; } };
      if (name === "agentPresets") return { async resolve(id) { headerResolves += 1; return { id }; }, async mount() {} };
      return undefined;
    },
  };
  const headerReceipt = await deliverMessage(headerCtx, "caller", "cold-file", [{ type: "text", text: "no store" }]);
  assert.equal(headerReceipt.delivery_mode, "resumed_inbox");
  assert.equal(headerResolves, 1, "without a store the header projection is the fallback");
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
  const outOfOrder = session("out-of-order");
  const outOfOrderMessage = { id: "out-of-order-message", role: "user", content: [], source: { kind: "a2a", form: "relay" } };
  outOfOrder.events.push({ type: "assistant/message", data: { message: { id: "answer", role: "assistant", content: [], source: { kind: "model", replyTo: outOfOrderMessage.id } } } });
  outOfOrder.events.push({ type: "agent/inbox/spliced", data: { inserted: [outOfOrderMessage] } });
  env.sessions.set(outOfOrder.id, outOfOrder);
  assert.equal((await queryMessageStatus(env.context, outOfOrderMessage.id, outOfOrder.id)).state, "unknown", "a response before acceptance is not answered");
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
      roles: [{ id: "reviewer", name: "Reviewer", sessionId: roleSession, phase: rolePhase, execution: "session", sessionHistory: [], preset: "preset", sandbox: "workspace-write", reportCount: 0, lastReport: null }],
      reports: [],
    },
  };
}

/** The same team, with its single role carried by a native sub-agent node. */
function nativeTeamState(parentSessionId = "driver") {
  const state = teamState();
  state.team.roles = [
    {
      id: "reviewer",
      name: "Reviewer",
      sessionId: "child-native",
      phase: "active",
      execution: "subagent",
      parentSessionId,
      sessionHistory: [],
      preset: null,
      sandbox: "inherited",
      reportCount: 0,
      lastReport: null,
    },
  ];
  return state;
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

test("durable idempotency replay returns the original receipt facts without writing a Session event", async () => {
  const env = runtime();
  const target = session("fresh-durable");
  env.sessions.set(target.id, target);
  // Durability now comes from the injected receipt store, not from the target's
  // own log: recording a receipt in the log is what made every delivered-to
  // session unreadable after a restart (docs/adr/0002).
  const receipts = createMemoryReceiptStore();
  const first = await deliverMessage(env.context, "sender", target.id, [{ type: "text", text: "retry" }], { idempotencyKey: "fresh-key", replyTo: "original", receiptStore: receipts });
  const freshContext = {
    agents: { get() { return undefined; } },
    sessions: { get() { return target; } },
    get() { return undefined; },
  };
  const replay = await deliverMessage(freshContext, "sender", target.id, [{ type: "text", text: "retry" }], { idempotencyKey: "fresh-key", replyTo: "original", receiptStore: receipts });
  assert.deepEqual(replay, first);
  assert.equal(target.events.filter((event) => event.type === "agent/inbox/spliced").length, 1);
});

test("a delivery writes no plugin-private event type into the target session", async () => {
  // Regression guard for the P0 blocker: any `orchestra/*` event in a persisted
  // log makes DSH refuse the whole log on reread, and an out-of-repo plugin
  // cannot mark its own events ignorable. Delivery is the path that poisoned
  // sessions the plugin does not even own, so it is the one that must stay clean.
  const env = runtime();
  const live = session("clean-live", "/caller");
  env.sessions.set(live.id, live);
  env.agents.set(live.id, { id: live.id, session: live, status: "idle", followup() {}, inject() {}, steer() {} });
  const durable = session("clean-durable", "/caller");
  env.sessions.set(durable.id, durable);
  const receipts = createMemoryReceiptStore();

  await deliverMessage(env.context, "sender", live.id, [{ type: "text", text: "a" }], { idempotencyKey: "clean-1", receiptStore: receipts });
  await deliverMessage(env.context, "sender", live.id, [{ type: "text", text: "b" }], { interrupt: true, idempotencyKey: "clean-2", receiptStore: receipts });
  await deliverMessage(env.context, "sender", durable.id, [{ type: "text", text: "c" }], { wake: false, idempotencyKey: "clean-3", receiptStore: receipts });

  for (const target of [live, durable]) {
    const foreign = target.events.filter((event) => typeof event.type === "string" && event.type.startsWith("orchestra/"));
    assert.deepEqual(foreign, [], `${target.id} must contain no orchestra/* session event`);
  }
  assert.equal(await receipts.read(live.id, "clean-1") !== undefined, true, "the receipt is durable in the store instead");
});

test("orchestra_send reaches a native node only through its recorded direct parent", async () => {
  const sent = [];
  const env = runtime({
    subagents: {
      async sendMessage(sender, targetId, content, options) {
        sent.push({ sender, targetId, content, options });
        return "native-message";
      },
    },
  });
  const caller = session("driver", "/caller");
  env.sessions.set(caller.id, caller);
  env.agents.set(caller.id, { id: caller.id, session: caller, status: "idle" });
  const resolver = createGovernedRoleAddressResolver({ async read() { return nativeTeamState(); } });
  const exec = { agent: env.agents.get(caller.id), signal: new AbortController().signal };

  const result = await sendGovernedRole(env.context, resolver, { teamId: "team-address", roleId: "reviewer", message: "dispatch" }, exec);
  assert.equal(result.resolved_session_id, "child-native");
  assert.deepEqual(result.receipt, {
    message_id: "native-message",
    target_session_id: "child-native",
    accepted_at_ms: result.receipt.accepted_at_ms,
    delivery_mode: "native_steer",
    state: "accepted",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sender, exec.agent, "the caller's own Agent is the only authorized sender");
  assert.equal(sent[0].targetId, "child-native");
  assert.equal(sent[0].content[1].text, "dispatch");
  assert.ok(sent[0].options.signal instanceof AbortSignal);

  // A caller that is not the recorded parent is refused rather than misrouted.
  const stranger = session("other-driver", "/caller");
  env.sessions.set(stranger.id, stranger);
  env.agents.set(stranger.id, { id: stranger.id, session: stranger, status: "idle" });
  await assert.rejects(
    () => sendGovernedRole(env.context, resolver, { teamId: "team-address", roleId: "reviewer", message: "x" }, { agent: env.agents.get(stranger.id), signal: new AbortController().signal }),
    /only that exact parent may deliver/,
  );

  // The three raw-transport guarantees have no native counterpart.
  for (const [args, pattern] of [
    [{ wake: false }, /cannot honor wake=false/],
    [{ interrupt: true }, /cannot honor interrupt=true/],
    [{ idempotencyKey: "k" }, /cannot honor idempotencyKey/],
  ]) {
    await assert.rejects(
      () => sendGovernedRole(env.context, resolver, { teamId: "team-address", roleId: "reviewer", message: "x", ...args }, exec),
      pattern,
    );
  }
  assert.equal(sent.length, 1, "no refused call reached the native seam");
});

test("a sub-agent child is reachable only by its direct parent", async () => {
  // The native seam authorizes on the adjacency edge alone, so this transport —
  // which writes into an inbox by bare session id — must refuse a foreign
  // sender. Without the guard any session could hand work to a child it did not
  // create, invisibly, because the write looks like an ordinary inbox splice.
  const ctx = {
    agents: {
      get(id) {
        return String(id) === "child" ? { session: { header: { origin: "subagent", parentSession: "owner" } } } : undefined;
      },
    },
    sessions: { get: () => undefined },
  };
  await assert.rejects(
    () => deliverMessage(ctx, "intruder", "child", [{ type: "text", text: "do my work" }]),
    /sub-agent child of owner/,
    "a non-parent must be refused, and told why",
  );
  await assert.rejects(
    () => deliverMessage(ctx, undefined, "child", [{ type: "text", text: "anonymous" }]),
    /sub-agent child of owner/,
    "a sender that cannot demonstrate the parent edge is not adjacent",
  );
});

test("a2a_list reports a real creation time, never a fake last-activity one", async () => {
  const env = runtime();
  const live = session("live-one", "/caller");
  live.header.createdAt = 1700000000000;
  env.sessions.set(live.id, live);
  env.agents.set(live.id, { id: live.id, session: live, status: "idle" });
  env.queryRecords.push({ header: { id: "cold-one", cwd: "/caller", createdAt: 1690000000000 }, live: false, persisted: true });
  const listed = await listThreads(env.context, { driverCwd: "/caller" });
  const byId = new Map(listed.threads.map((t) => [t.sessionId, t]));
  assert.equal(byId.get("live-one").createdAt, 1700000000000);
  assert.equal(byId.get("cold-one").createdAt, 1690000000000);
  // The field must be named for what it is: the host exposes no last-activity
  // timestamp, so no such key may appear anywhere in the projection.
  for (const thread of listed.threads) {
    assert.equal("lastActivityAt" in thread || "lastActivatedAt" in thread, false);
  }
});

test("a discovery record without a usable timestamp simply omits it", async () => {
  const env = runtime();
  const live = session("no-time", "/caller");
  live.header.createdAt = "not a number";
  env.sessions.set(live.id, live);
  env.agents.set(live.id, { id: live.id, session: live, status: "idle" });
  const listed = await listThreads(env.context, { driverCwd: "/caller" });
  assert.equal(listed.threads[0].createdAt, undefined);
  assert.equal("createdAt" in listed.threads[0], false);
});

test("the discovery cap cannot starve the caller's own working directory", async () => {
  const env = runtime();
  const mine = session("mine-live", "/my-cwd");
  env.sessions.set(mine.id, mine);
  env.agents.set(mine.id, { id: mine.id, session: mine, status: "idle" });
  // A host whose newest 200 persisted sessions all belong to OTHER cwds, plus one
  // older session in the caller's own cwd. Before the fix that one was invisible
  // at every offset, because it never entered the list at all.
  for (let i = 0; i < 210; i++) {
    env.queryRecords.push({ header: { id: `other-${String(i).padStart(3, "0")}`, cwd: "/elsewhere", createdAt: 1700000000000 - i }, live: false, persisted: true });
  }
  env.queryRecords.push({ header: { id: "my-old-session", cwd: "/my-cwd", createdAt: 1600000000000 }, live: false, persisted: true });

  const listed = await listThreads(env.context, { driverCwd: "/my-cwd", limit: 100 });
  const ids = listed.threads.map((t) => t.sessionId);
  assert.equal(ids.includes("my-old-session"), true, "a session in the caller's own cwd must survive the cap");
  assert.equal(ids.includes("mine-live"), true);
  assert.match(listed.discovery_note ?? "", /discovery cap 200/);
  assert.match(listed.discovery_note ?? "", /other working directories/);
});
