/**
 * Shared harness for the first-batch dispatch/handoff contract tests.
 *
 * It is deliberately a plain in-memory double of exactly the ports the
 * production paths read: the active-Team CAS store, the archive store, the
 * charter record store, the A2A transport's `agents`/`sessions` surface, the
 * receipt store's `fs`, and a capturable timer. Everything the contract records
 * as an "actual subject" therefore comes from the runtime (agent ids, session
 * ids, cwd), never from a field a test could have written itself.
 *
 * The delivery fault hooks (`failNextWrite`, `faultyFollowup`) exist so the
 * failure windows the plan names — "enqueued but the receipt write failed",
 * "the delivery attempt left no trace" — are reachable without waiting for a
 * crash.
 */

import { createActiveTeamStateStore } from "../lib/orchestra-state.js";
import { createArchiveStore } from "../lib/orchestra-archive.js";
import { charterRecordStoreFor } from "../lib/charter-store.js";
import { createGovernedTeam } from "../lib/orchestra.js";
import { initializeFrozenOrchestrationDocument } from "../lib/orchestration-document.js";
import { prepareApprovalEvent, prepareDraftEvent, prepareFreezeEvent } from "../lib/orchestration-charter.js";

export const CWD = "/tmp/orchestra-dispatch-contract";

export class MemoryFs {
  constructor(events = []) {
    this.events = events;
    this.files = new Map();
    this.clock = 0;
    /** `(displayPath) => boolean`; a matching write fails once and clears. */
    this.failNextWrite = undefined;
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
    if (this.failNextWrite !== undefined && this.failNextWrite(target.displayPath)) {
      this.failNextWrite = undefined;
      throw Object.assign(new Error("injected write failure"), { code: "FS_WRITE_FAILED" });
    }
    const existing = this.files.get(target.key);
    if (expected?.kind === "createIfAbsent" && existing !== undefined) {
      throw Object.assign(new Error("race"), { code: "FS_NOT_OBSERVED" });
    }
    if (expected?.kind === "replaceIfVersion" && (existing === undefined || existing.version !== expected.version)) {
      throw Object.assign(new Error("stale"), { code: "FS_STALE_VERSION" });
    }
    const version = `v${++this.clock}`;
    this.files.set(target.key, { content, version });
    return { operation: existing === undefined ? "create" : "update", version, before: existing?.content ?? null, after: content };
  }
}

/**
 * Build one harness instance. A "restart" is `makeHarness({ fs: previous.fs })`:
 * the durable bytes survive, every live object (agents, sessions, timer) does
 * not — which is exactly the difference a restart makes.
 */
export function makeHarness({ fs = new MemoryFs(), cwd = CWD, events = fs.events } = {}) {
  const sessions = new Map();
  const agents = new Map();
  const timers = [];

  const sessionFor = (id) => {
    let session = sessions.get(id);
    if (!session) {
      session = {
        id,
        events: [],
        inheritedEventCount: 0,
        header: { id, cwd },
        snapshotEvents() {
          return this.events;
        },
        append(type, data) {
          this.events.push({ type, data, seq: this.events.length, time: Date.now() });
        },
      };
      sessions.set(id, session);
    }
    return session;
  };

  const agentFor = (id) => {
    const session = sessionFor(id);
    const agent = {
      id,
      session,
      status: "idle",
      options: {},
      inbox: { nextTurn: [], nextStep: [], hasPending: false, clear() {} },
      followup(message) {
        if (agent.faultyFollowup === true) throw new Error("injected followup failure");
        session.append("user/message", message);
      },
      inject(message) {
        session.append("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [message] });
      },
      steer(message) {
        session.append("user/message", message);
      },
      cancel() {
        events.push(`agent:cancel:${id}`);
      },
      async whenIdle() {},
    };
    agents.set(id, agent);
    return agent;
  };

  const presets = {
    defaultId: "default",
    async resolve(id) {
      return { id };
    },
    async mount(ctx, id) {
      events.push(`mount:${id}`);
      ctx.composedPreset = id;
    },
    composeFrom(ctx, parent) {
      ctx.composedPreset = parent.composedPreset;
      return parent.composedPreset;
    },
  };

  const permissionSpecs = { workspace: { sandbox: "workspace-write", approval: "ask" } };
  const permissions = {
    defaultPreset: "workspace",
    resolve(name) {
      return permissionSpecs[name] ?? permissionSpecs.workspace;
    },
    set(session, name) {
      session.append("permission/preset", { preset: name });
    },
    current() {
      return "workspace";
    },
  };

  const context = {
    fs,
    get(name) {
      // Production resolves these the same way `ctx.get(name)` does; a missing
      // entry here would make a real code path fail on `undefined.get` and look
      // like a product defect.
      if (name === "fs") return fs;
      if (name === "agents") return context.agents;
      if (name === "sessions") return context.sessions;
      if (name === "sandboxPolicy") return context.sandboxPolicy;
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      if (name === "tools") {
        return {
          schemas: () => [
            { name: "read", description: "read", parameters: {} },
            { name: "orchestra_report", description: "report", parameters: {} },
          ],
        };
      }
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "default-p", model: "default-m" }) };
      if (name === "skills") return { register: () => () => {} };
      if (name === "subagents") return { listChildren: () => [], drainContinuableChildren: async () => {} };
      // Persisted-session reads, as the activation path performs them: a session
      // that exists in the harness's store reads back, one that does not is
      // authoritatively missing.
      if (name === "sessionQuery") {
        return {
          async readSession(id) {
            const session = sessions.get(String(id));
            if (session === undefined) throw Object.assign(new Error("session not found"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
            return { session: session.header, events: session.snapshotEvents() };
          },
          async listSessions() {
            return [...sessions.values()].map((session) => ({
              header: { id: session.id, cwd: session.header.cwd, createdAt: 0, agentPreset: "preset" },
              live: agents.has(session.id),
            }));
          },
    async readTitleSnapshots() {
            return [];
          },
        };
      }
      return undefined;
    },
    sessions: {
      get(id) {
        return sessions.get(String(id));
      },
      async flush() {
        return true;
      },
    },
    agents: {
      get(id) {
        return agents.get(String(id));
      },
      async create(createOptions) {
        const id = String(createOptions.sessionId);
        events.push(`agent:create:${id}`);
        const agent = agentFor(id);
        const childCtx = { ...context, agentId: id, on: () => () => {} };
        await createOptions.setup?.(childCtx, agent);
        return agent;
      },
    },
    sandboxPolicy: {
      resolve() {
        return { kind: "policy" };
      },
    },
    timer: {
      timeout(fn) {
        timers.push(fn);
        return () => {};
      },
    },
  };

  // Tool registration surface: `apply()` is the only place the real tool
  // definitions exist, so a test that must check a REAL returned value against
  // its REAL declared schema registers the plugin here and drives the handlers.
  const registered = [];
  context.tools = { register: (definition) => registered.push(definition) };
  context.effect = (fn) => {
    fn();
    return () => {};
  };
  context.on = () => () => {};

  const controller = agentFor("driver-1");
  const store = createActiveTeamStateStore(fs);
  const archiveStore = createArchiveStore(fs);
  const charterStore = charterRecordStoreFor(context, cwd);

  return {
    cwd,
    fs,
    registered,
    /** Look a registered tool up LAZILY: `apply()` populates `registered` later. */
    toolNamed(name) {
      return registered.find((definition) => definition.name === name);
    },
    events,
    sessions,
    agents,
    context,
    controller,
    store,
    archiveStore,
    charterStore,
    timers,
    sessionFor,
    agentFor,
    runTimers() {
      const due = timers.splice(0, timers.length);
      return Promise.all(due.map((fn) => fn()));
    },
    /** Every A2A message that reached one session's log, oldest first. */
    a2aMessages(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return [];
      return session
        .snapshotEvents()
        .filter((event) => event.type === "user/message" && event.data?.source?.kind === "a2a")
        .map((event) => event.data);
    },
    /** Every message text delivered to one session, flattened. */
    textsFor(sessionId) {
      return this.a2aMessages(sessionId).map((message) =>
        (message.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => String(block.text))
          .join("\n"),
      );
    },
  };
}

/** Approve and freeze a charter, returning the frozen revision itself. */
export function buildFrozenRevision(harness, roles, draftId = "draft-dispatch") {
  const config = {
    schemaVersion: 1,
    id: "dispatch-topo",
    name: "dispatch",
    controller: { id: harness.controller.id, source: "caller" },
    roles,
    protocol: {
      ownership: { closure: harness.controller.id },
      routes: [{ kind: "dispatch", from: harness.controller.id, to: roles.map((r) => r.id) }],
      completion: { owner: harness.controller.id, rule: "done" },
    },
  };
  const draft = prepareDraftEvent([], {
    draftId,
    mission: { objective: "dispatch contract test", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "test" },
    topology: { source: "inline", id: config.id, config },
    humanParticipationPolicy: { mode: "interactive", onUnavailable: "block" },
    authorSessionId: harness.controller.id,
    now: 1,
  });
  if (draft.kind !== "changed") throw new Error("draft was not produced");

  const records = [draft.event];
  const approval = prepareApprovalEvent(records, {
    draftId,
    revision: 1,
    commandId: `command-${draftId}`,
    approvingSessionId: harness.controller.id,
    approvedAt: 2,
  });
  if (approval.kind !== "changed") throw new Error("approval was not produced");
  records.push(approval.event);

  const freeze = prepareFreezeEvent(records, {
    draftId,
    revision: 1,
    digest: draft.value.digest,
    frozenBySessionId: harness.controller.id,
    frozenAt: 3,
  });
  if (freeze.kind !== "changed") throw new Error("freeze was not produced");
  records.push(freeze.event);

  return { frozen: freeze.value, records };
}

/** Approve, freeze and record a charter so the Team has a real authority source. */
export async function prepareApprovedFrozenRef(harness, roles, draftId = "draft-dispatch") {
  const { frozen, records } = buildFrozenRevision(harness, roles, draftId);
  for (const event of records) await harness.charterStore.append(event);
  return frozen.frozenRef;
}

/**
 * Give a HAND-BUILT team record the same authority source a governed Team has:
 * one frozen charter revision in its orchestration document. Tests that seed
 * their own team.json use this instead of bypassing the delegation check.
 */
export async function withFrozenCharter(harness, team, roles, draftId = "draft-seeded") {
  const { frozen, records } = buildFrozenRevision(harness, roles, draftId);
  for (const event of records) await harness.charterStore.append(event);
  const document = initializeFrozenOrchestrationDocument(team, frozen, 4);
  return { team: { ...team, document }, frozenRef: frozen.frozenRef, authorityRef: frozen.approval.approvalRef };
}

/** Create one approved governed team and return its frozen reference. */
export async function newGovernedTeam(harness, roles, draftId = "draft-dispatch") {
  const catalog = {
    find() {
      return { kind: "ready", topology: { id: "dispatch-topo", title: "Dispatch Topology", roles } };
    },
  };
  const frozenRef = await prepareApprovedFrozenRef(harness, roles, draftId);
  await createGovernedTeam(harness.context, harness.store, catalog, { frozenRef }, { agent: harness.controller });
  return frozenRef;
}

let sequence = 0;

/**
 * A minimal valid *guaranteed* dispatch: every field the contract validates is
 * present, so a test only has to state the field it is actually about.
 */
export function dispatchArgs(frozenRef, overrides = {}) {
  const roleId = overrides.roleId ?? "worker";
  sequence += 1;
  return {
    roleId,
    task: overrides.task ?? `do ${roleId} work`,
    dispatchId: overrides.dispatchId ?? `dispatch-${roleId}-${sequence}`,
    charterRef: frozenRef,
    authorityRef: frozenRef,
    responsibility: overrides.responsibility ?? `${roleId} delivers this lane's result`,
    scope: overrides.scope ?? ["bounded local change"],
    brief:
      overrides.brief ??
      "Goal: complete the dispatched task. Non-goals: nothing outside the named write surface. " +
        "Known facts: none asserted. Must not change: the pinned method text. " +
        "Fixed inputs: the commit named in the method bindings. " +
        "Observation and closure: a reproducible failing observation must become passing. " +
        "Write surface: the named target files only.",
    ...overrides,
  };
}
