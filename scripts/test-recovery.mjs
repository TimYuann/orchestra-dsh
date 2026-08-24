import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createActiveTeamStateStore } from "../lib/orchestra-state.js";
import { createArchiveStore } from "../lib/orchestra-archive.js";
import { activateArchivedTeam } from "../lib/orchestra.js";
import { initializeFrozenOrchestrationDocument } from "../lib/orchestration-document.js";
import { prepareApprovalEvent, prepareDraftEvent, prepareFreezeEvent } from "../lib/orchestration-charter.js";
import { initializeGraphRuntime, recordVerdict, startAttempt, startLoop } from "../lib/orchestra-graph.js";

const cwd = "/recovery-test-workspace";

class FsTestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class TemporaryFs {
  constructor(root) {
    this.root = root;
    this.lastExpected = undefined;
  }

  absolute(path) {
    return join(this.root, path);
  }

  async resolve(path) {
    const displayPath = this.absolute(path);
    return { targetKey: displayPath, displayPath };
  }

  processPath(target) {
    return target.displayPath;
  }

  version(info) {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs?.toString() ?? info.mtimeMs}`;
  }

  async stat(target) {
    try {
      const info = await stat(target.displayPath);
      const type = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
      return { type, size: info.size, version: this.version(info) };
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
      const type = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
      const displayPath = join(target.displayPath, entry.name);
      return { name: entry.name, type, target: { targetKey: displayPath, displayPath } };
    });
  }

  async readText(target) {
    return readFile(target.displayPath, "utf8");
  }

  async writeText(target, content, expected) {
    this.lastExpected = expected;
    await mkdir(dirname(target.displayPath), { recursive: true });
    const current = await this.stat(target);
    if (expected?.kind === "createIfAbsent" && current !== undefined) {
      throw new FsTestError("FS_NOT_OBSERVED", "target already exists");
    }
    if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
      throw new FsTestError("FS_STALE_VERSION", "target version is stale");
    }
    try {
      await writeFile(target.displayPath, content, { encoding: "utf8", flag: expected?.kind === "createIfAbsent" ? "wx" : "w" });
    } catch (error) {
      if (error?.code === "EEXIST") throw new FsTestError("FS_NOT_OBSERVED", "create lost the race");
      throw error;
    }
    const afterInfo = await stat(target.displayPath);
    return {
      operation: current === undefined ? "create" : "update",
      version: this.version(afterInfo),
      before: current === undefined ? null : await this.readText(target),
      after: content,
    };
  }

  async seed(relativePath, value) {
    const path = this.absolute(relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  }

  async bytes(relativePath) {
    return readFile(this.absolute(relativePath), "utf8");
  }
}

async function withTempFs(callback) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-recovery-"));
  try {
    return await callback(new TemporaryFs(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Build a real FrozenCharterRevision through the charter event machinery. */
function frozenCharter() {
  const config = {
    schemaVersion: 1,
    id: "trio",
    name: "Trio",
    controller: { id: "driver", source: "caller" },
    roles: [{ id: "reviewer", name: "Reviewer", preset: "orchestra-reviewer", sandbox: "read-only" }],
    protocol: { ownership: { closure: "driver" }, routes: [], completion: { owner: "driver", rule: "done" } },
  };
  const mission = { objective: "recovery round trip", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" };
  const draft = prepareDraftEvent([], {
    draftId: "draft-recovery",
    mission,
    topology: { source: "catalog", id: "trio", catalogSource: "bundled", config },
    humanParticipationPolicy: { mode: "checkpointed", onUnavailable: "block" },
    authorSessionId: "driver-session",
    now: 1,
  });
  const approval = prepareApprovalEvent([draft.event], {
    draftId: "draft-recovery",
    revision: 1,
    commandId: "cmd-1",
    approvingSessionId: "driver-session",
    approvedAt: 2,
  });
  const frozen = prepareFreezeEvent([draft.event, approval.event], {
    draftId: "draft-recovery",
    revision: 1,
    digest: draft.value.digest,
    frozenBySessionId: "driver-session",
    frozenAt: 3,
  });
  return frozen.value;
}

/** A valid active Team bound to a frozen charter with a live graph runtime. */
function recoveryTeam(frozen, overrides = {}) {
  const team = {
    schemaVersion: 1,
    teamId: "team-recovery",
    status: "active",
    rootCwd: cwd,
    controllerSessionId: "driver-session",
    controllerHistory: [],
    topologyRef: { id: "trio", source: "bundled" },
    mission: frozen.mission,
    createdAt: 4,
    activatedFromArchiveId: null,
    roles: [
      { id: "implementer", name: "Implementer", sessionId: "session-implementer", phase: "active", sessionHistory: [], preset: "orchestra-implementer", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "session-reviewer", phase: "active", sessionHistory: [], preset: "orchestra-reviewer", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
  team.document = initializeFrozenOrchestrationDocument(team, frozen, 4);
  team.graphRuntime = initializeGraphRuntime(team.teamId, frozen.charterRevision, frozen.digest, 4);
  return { ...team, ...overrides };
}

function loopContract(maxAttempts = 2) {
  return { loopId: "review-loop", entry: { role: "implementer", event: "candidate" }, participants: ["implementer"], evaluatorRole: "reviewer", candidateKind: "candidate", verdictKind: "verdict", maxAttempts, passRoute: "pass", retryRoute: "retry", capExhaustedRoute: "driver", requiredEvidenceKinds: ["report"] };
}

function markerFor(archived, teamId, archivedAt) {
  return {
    schemaVersion: 1,
    archived: true,
    status: "dismissed",
    archiveId: archived.summary.archiveId,
    archivePath: archived.summary.archivePath,
    archivedAt,
    teamId,
  };
}

test("graph runtime survives archive and resumes appending after restore (CP7 round-trip)", async () => {
  await withTempFs(async (fs) => {
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "roundtrip" });
    const frozen = frozenCharter();
    const team = recoveryTeam(frozen);
    const contract = loopContract();
    let graph = team.graphRuntime;
    graph = startLoop(graph, team, contract, { actorSessionId: "driver-session", loopInstanceId: "loop-r1", now: 5, evidence: [{ kind: "report", ref: "start.md" }] }).runtime;
    graph = startAttempt(graph, team, contract, { loopInstanceId: "loop-r1", actorSessionId: "driver-session", participantRoleId: "implementer", now: 6, evidence: [{ kind: "report", ref: "c.md" }] }).runtime;
    const withGraph = { ...team, graphRuntime: graph };
    await activeStore.create(cwd, withGraph, { policy: {} });

    // dismiss: publish immutable archive, then CAS the active state to an archived marker
    const archived = await archiveStore.create(cwd, withGraph, { dismissedAt: 100, policy: {} });
    const observed = await activeStore.read(cwd);
    assert.equal(observed.kind, "ready");
    await activeStore.archive(observed, markerFor(archived, withGraph.teamId, 100), { policy: {} });

    // the archive snapshot keeps the complete graph runtime (revision + all events)
    const loaded = await archiveStore.read(cwd, archived.summary.archiveId);
    assert.equal(loaded.kind, "ready");
    assert.equal(loaded.snapshot.graphRuntime.runtimeRevision, graph.runtimeRevision);
    assert.equal(loaded.snapshot.graphRuntime.events.length, graph.events.length);

    // restore an active team from the snapshot; the state seam re-validates the
    // graph binding (charterRevision/charterDigest) and returns ready
    const restored = { ...loaded.snapshot, status: "active", activatedFromArchiveId: loaded.snapshot.archiveId };
    await activeStore.create(cwd, restored, { policy: {} });
    const revivedObservation = await activeStore.read(cwd);
    assert.equal(revivedObservation.kind, "ready");
    const revived = revivedObservation.team;
    assert.equal(revived.graphRuntime.runtimeRevision, graph.runtimeRevision);
    assert.equal(revived.graphRuntime.charterDigest, frozen.digest);

    // the graph continues after recovery: new events append, revision increments,
    // and the pre-archive events stay readable
    const next = recordVerdict(revived.graphRuntime, revived, contract, {
      loopInstanceId: "loop-r1",
      actorSessionId: "session-reviewer",
      evaluatorRole: "reviewer",
      verdict: "FAIL",
      findings: ["recheck after recovery"],
      now: 7,
      evidence: [{ kind: "report", ref: "v.md" }],
    });
    assert.equal(next.kind, "changed");
    assert.equal(next.runtime.runtimeRevision, graph.runtimeRevision + 2); // verdict + attempt_completed
    assert.equal(next.runtime.events[0].eventId, graph.events[0].eventId);
    assert.equal(next.runtime.events[0].type, graph.events[0].type);
    assert.equal(next.runtime.events.filter((event) => event.type === "verdict_recorded").length, 1);
  });
});

function activateSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "dismissed",
    archiveId: "team-recovery-100-restore",
    teamId: "team-recovery",
    rootCwd: cwd,
    controllerSessionId: "old-driver",
    controllerHistory: [],
    topologyRef: { id: "trio", source: "bundled" },
    mission: { objective: "recovery", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    roles: [
      { id: "reviewer", name: "Reviewer", sessionId: "session-reviewer", sessionHistory: [], preset: "orchestra-reviewer", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "implementer", name: "Implementer", sessionId: "session-implementer", sessionHistory: [], preset: "orchestra-implementer", sandbox: "workspace-write", reportCount: 0, lastReport: null },
    ],
    reports: [],
    dismissedAt: 100,
    ...overrides,
  };
}

function activateContext(fs, options = {}) {
  const agents = new Map();
  const sessions = new Map();
  const query = {
    async readSession(id) {
      const key = String(id);
      if (options.missingSessions?.includes(key)) throw Object.assign(new Error("missing"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      const persisted = options.persistedSessions?.[key];
      if (persisted === undefined) throw Object.assign(new Error("missing"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      return persisted;
    },
  };
  const ctx = {
    fs,
    get(name) {
      if (name === "sessionQuery") return query;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      if (name === "agentPresets") return { async resolve(id) { return { id, trust: "system", path: "" }; } };
      return undefined;
    },
    agents: {
      get(id) {
        return agents.get(String(id));
      },
    },
    sessions: {
      get(id) {
        return sessions.get(String(id));
      },
    },
    sandboxPolicy: { resolve: () => ({}) },
  };
  return { ctx, agents, sessions };
}

function activateDeps(events) {
  return {
    createSession: async (agentCtx, options) => {
      const roleId = typeof options.title === "string" ? options.title.split(" · ")[0] : "role";
      const sessionId = `replacement-${roleId}`;
      events.push(`create:${roleId}`);
      return { sessionId, handle: { dispose: async () => {} } };
    },
    resumeAgent: async (agentCtx, options) => {
      events.push(`resume:${options.resumeSessionId}`);
      return {};
    },
    sendRoleWelcome: async (agentCtx, from, to, roleName, extra) => {
      events.push(`welcome:${roleName}`);
      return { messageId: `w-${to}`, sessionId: to, acceptedAt: Date.now() };
    },
  };
}

const exec = { agent: { id: "driver", session: { header: { cwd } } }, signal: undefined };

test("activate three branches: live reused, missing replaced with history, persisted resumed; controller takeover", async () => {
  await withTempFs(async (fs) => {
    await fs.seed("orchestra/archive/team-recovery-100-restore.json", activateSnapshot());
    const archiveBytes = await fs.bytes("orchestra/archive/team-recovery-100-restore.json");
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs);
    const { ctx, agents } = activateContext(fs, {
      missingSessions: ["session-implementer"],
      persistedSessions: { "session-reviewer": { id: "session-reviewer" } },
    });
    const events = [];
    const deps = activateDeps(events);

    const result = await activateArchivedTeam(ctx, activeStore, archiveStore, { archiveId: "team-recovery-100-restore" }, exec, deps);
    assert.equal(result.teamId, "team-recovery");
    assert.equal(result.status, "active");
    const byRole = Object.fromEntries(result.roles.map((role) => [role.role_id, role]));
    // persisted session resumed with the same session id
    assert.equal(byRole.reviewer.action, "resumed");
    assert.equal(byRole.reviewer.sessionId, "session-reviewer");
    // authoritatively missing session replaced with a new session id + history
    assert.equal(byRole.implementer.action, "replaced");
    assert.equal(byRole.implementer.replacedSessionId, "session-implementer");
    assert.equal(byRole.implementer.sessionId, "replacement-implementer");
    assert.ok(events.includes("create:implementer"));
    assert.ok(events.includes("resume:session-reviewer"));
    // recovery packet was delivered for the replacement
    assert.ok(events.filter((entry) => entry === "welcome:Implementer").length >= 1);

    // controller takeover: caller "driver" replaces archived "old-driver" and is recorded
    const observed = await activeStore.read(cwd);
    assert.equal(observed.kind, "ready");
    assert.equal(observed.team.controllerSessionId, "driver");
    assert.deepEqual(observed.team.controllerHistory, [{ sessionId: "old-driver", replacedAt: observed.team.controllerHistory[0].replacedAt, reason: "controller-takeover" }]);
    // replace addressing: teamId+roleId maps to the new session id
    assert.equal(observed.team.roles.find((role) => role.id === "implementer").sessionId, "replacement-implementer");
    assert.deepEqual(observed.team.roles.find((role) => role.id === "implementer").sessionHistory, [
      { sessionId: "session-implementer", replacedAt: observed.team.roles.find((role) => role.id === "implementer").sessionHistory[0].replacedAt, reason: "session-not-found" },
    ]);
    // the archive file is untouched by activation
    assert.equal(await fs.bytes("orchestra/archive/team-recovery-100-restore.json"), archiveBytes);
  });
});

test("activate live branch reuses the existing session and keeps its mapping", async () => {
  await withTempFs(async (fs) => {
    await fs.seed("orchestra/archive/team-recovery-100-restore.json", activateSnapshot());
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs);
    const { ctx, agents } = activateContext(fs, { missingSessions: ["session-implementer"] });
    agents.set("session-reviewer", { id: "session-reviewer" });
    const events = [];
    const result = await activateArchivedTeam(ctx, activeStore, archiveStore, { archiveId: "team-recovery-100-restore" }, exec, activateDeps(events));
    const reviewer = result.roles.find((role) => role.role_id === "reviewer");
    assert.equal(reviewer.action, "reused");
    assert.equal(reviewer.sessionId, "session-reviewer");
    assert.ok(events.includes("welcome:Reviewer"));
    // the live reviewer is neither resumed nor re-created
    assert.ok(!events.some((entry) => entry === "create:reviewer" || entry === "resume:session-reviewer"));
    // the missing implementer still gets a replacement
    assert.ok(events.some((entry) => entry === "create:implementer"));
  });
});

test("activate partial failure degrades the team instead of pretending active", async () => {
  await withTempFs(async (fs) => {
    await fs.seed("orchestra/archive/team-recovery-100-restore.json", activateSnapshot());
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs);
    const { ctx } = activateContext(fs, { missingSessions: ["session-reviewer", "session-implementer"] });
    const deps = activateDeps([]);
    deps.createSession = async () => {
      throw new Error("replacement failed");
    };
    const result = await activateArchivedTeam(ctx, activeStore, archiveStore, { archiveId: "team-recovery-100-restore" }, exec, deps);
    assert.equal(result.status, "degraded");
    assert.ok(result.roles.every((role) => role.action === "failed"));
    const observed = await activeStore.read(cwd);
    assert.equal(observed.kind, "ready");
    assert.equal(observed.team.status, "degraded");
  });
});

test("activate rejects a corrupt archived graph runtime instead of pretending active", async () => {
  await withTempFs(async (fs) => {
    const corruptGraph = {
      schemaVersion: 1,
      runtimeRevision: 1,
      teamId: "team-recovery",
      charterRevision: 1,
      charterDigest: "digest",
      updatedAt: 1,
      events: [{ eventId: "x", seq: 1, type: "bogus-type", actorSessionId: "s", parents: [], createdAt: 1, payload: {}, evidence: [] }],
    };
    await fs.seed("orchestra/archive/team-corrupt-100.json", activateSnapshot({ archiveId: "team-corrupt-100", graphRuntime: corruptGraph }));
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs);
    const { ctx } = activateContext(fs);
    await assert.rejects(
      () => activateArchivedTeam(ctx, activeStore, archiveStore, { archiveId: "team-corrupt-100" }, exec, activateDeps([])),
      /archived graph runtime is blocked/,
    );
    // no active team was published
    const observed = await activeStore.read(cwd);
    assert.equal(observed.kind, "missing");
  });
});

test("activate rejects a stale archived graph runtime bound to an older charter", async () => {
  await withTempFs(async (fs) => {
    const frozen = frozenCharter();
    const team = recoveryTeam(frozen);
    const staleGraph = { ...team.graphRuntime, charterDigest: "older-digest" };
    const snapshot = {
      ...team,
      status: "dismissed",
      archiveId: "team-stale-100",
      dismissedAt: 100,
      graphRuntime: staleGraph,
    };
    await fs.seed("orchestra/archive/team-stale-100.json", snapshot);
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs);
    const { ctx } = activateContext(fs);
    await assert.rejects(
      () => activateArchivedTeam(ctx, activeStore, archiveStore, { archiveId: "team-stale-100" }, exec, activateDeps([])),
      /bound to an older Frozen Charter/,
    );
    assert.equal((await activeStore.read(cwd)).kind, "missing");
  });
});
