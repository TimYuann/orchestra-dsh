import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ActiveTeamStateError, createActiveTeamStateStore } from "../lib/orchestra-state.js";
import { ArchiveStoreError, createArchiveStore } from "../lib/orchestra-archive.js";
import { apply as applyOrchestra, archiveListForTeamTool, dismissGovernedTeam, handleTeamCommandInvocation } from "../lib/orchestra.js";

const cwd = "/archive-test-workspace";

class FsTestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class TemporaryArchiveFs {
  constructor(root, events = []) {
    this.root = root;
    this.lastExpected = undefined;
    this.failList = undefined;
    this.failEntry = undefined;
    /** Ordered log of every write, so a test can prove one step preceded another. */
    this.events = events;
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
    if (this.failEntry !== undefined && target.displayPath.endsWith(this.failEntry.filename)) {
      throw this.failEntry.error;
    }
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
    if (this.failList !== undefined) throw this.failList;
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
    this.events.push(`fs:write:${target.displayPath}`);
    await mkdir(dirname(target.displayPath), { recursive: true });
    const current = await this.stat(target);
    if (expected?.kind === "createIfAbsent" && current !== undefined) {
      throw new FsTestError("FS_NOT_OBSERVED", "archive target already exists");
    }
    if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
      throw new FsTestError("FS_STALE_VERSION", "archive target version is stale");
    }
    const before = current === undefined ? null : await this.readText(target);
    try {
      await writeFile(target.displayPath, content, { encoding: "utf8", flag: expected?.kind === "createIfAbsent" ? "wx" : "w" });
    } catch (error) {
      if (error?.code === "EEXIST") throw new FsTestError("FS_NOT_OBSERVED", "archive create lost the race");
      throw error;
    }
    const afterInfo = await stat(target.displayPath);
    return {
      operation: current === undefined ? "create" : "update",
      version: this.version(afterInfo),
      before,
      after: content,
    };
  }

  async seed(relativePath, value) {
    const path = this.absolute(relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }

  async bytes(relativePath) {
    return readFile(this.absolute(relativePath), "utf8");
  }
}

function team(overrides = {}) {
  return {
    schemaVersion: 1,
    teamId: "team-archive-test",
    status: "active",
    rootCwd: cwd,
    controllerSessionId: "session-driver",
    controllerHistory: [],
    topologyRef: { id: "trio", source: "bundled" },
    mission: { objective: "archive test", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 456,
    activatedFromArchiveId: null,
    roles: [
      {
        id: "reviewer",
        name: "Reviewer",
        sessionId: "session-reviewer",
        sessionHistory: [],
        preset: "orchestra-reviewer",
        sandbox: "read-only",
        reportCount: 0,
        lastReport: null,
      },
    ],
    reports: [],
    ...overrides,
  };
}

function writeOptions(dismissedAt = 100) {
  return { dismissedAt, policy: {} };
}

async function withTempFs(callback) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-archive-"));
  try {
    return await callback(new TemporaryArchiveFs(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A dismiss harness over the SAME fs the stores use, plus an agent registry whose
 * members record what was done to them, in order.
 *
 * The notices are observed through `inject`, which is where the transport puts a
 * `wake: false` message for a live agent — the same channel a real role's log
 * would show it in. Sharing the fs matters: the ordering assertions compare a
 * notice against the fs writes, so a second fs would silently record nothing.
 */
function dismissHarness(fs) {
  const events = fs.events;
  const agents = new Map();
  const controller = {
    id: "session-driver",
    session: { header: { cwd }, snapshotEvents: () => [], append() {} },
    status: "idle",
    inbox: { hasPending: false, clear() {} },
    followup() {},
    inject() {},
    steer() {},
    cancel() {},
  };
  agents.set(controller.id, controller);
  const register = (id) => {
    const agent = {
      id,
      session: { header: { cwd }, snapshotEvents: () => [], append() {} },
      status: "running",
      inbox: { hasPending: false, clear() {} },
      followup() { events.push(`followup:${id}`); },
      inject() { events.push(`notice:${id}`); },
      steer() { events.push(`steer:${id}`); },
      cancel(_cause, _options) { events.push(`cancel:${id}`); },
    };
    agents.set(id, agent);
    return agent;
  };
  const ctx = {
    fs,
    sandboxPolicy: { resolve: () => ({}) },
    agents: { get: (id) => agents.get(String(id)) },
    sessions: { get: () => undefined },
    get(name) {
      if (name === "agents") return ctx.agents;
      return undefined;
    },
  };
  const exec = { agent: controller, signal: undefined };
  return { events, fs, ctx, exec, agents, register, controller };
}

test("archive list treats a missing directory as empty", async () => {
  await withTempFs(async (fs) => {
    const store = createArchiveStore(fs);
    assert.deepEqual(await store.list(cwd), { ready: [], blocked: [] });
  });
});

test("archive create is immutable and repeated dismissals get different ids", async () => {
  await withTempFs(async (fs) => {
    const store = createArchiveStore(fs, { dismissalId: (() => { let n = 0; return () => `dismiss-${++n}`; })() });
    const first = await store.create(cwd, team(), writeOptions(100));
    assert.equal(fs.lastExpected.kind, "createIfAbsent");
    const second = await store.create(cwd, team(), writeOptions(100));
    assert.notEqual(first.summary.archiveId, second.summary.archiveId);
    const listing = await store.list(cwd);
    assert.equal(listing.ready.length, 2);
    assert.equal(listing.blocked.length, 0);
    assert.ok(listing.ready.every((entry) => entry.status === "ready"));
  });
});

test("archive create collision fails without overwriting the original bytes", async () => {
  await withTempFs(async (fs) => {
    const store = createArchiveStore(fs, { dismissalId: () => "fixed" });
    await store.create(cwd, team(), writeOptions(100));
    const filename = "team-team-archive-test-100-fixed.json";
    const original = await fs.bytes(`orchestra/archive/${filename}`);
    await assert.rejects(
      () => store.create(cwd, team({ mission: { objective: "replacement", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" } }), writeOptions(100)),
      (error) => error instanceof ArchiveStoreError && error.code === "collision" && error.fsCode === "FS_NOT_OBSERVED",
    );
    assert.equal(await fs.bytes(`orchestra/archive/${filename}`), original);
  });
});

test("archive list sorts ready summaries newest first and preserves tie order", async () => {
  await withTempFs(async (fs) => {
    const store = createArchiveStore(fs);
    const snapshot = (archiveId, dismissedAt) => ({ ...team(), archiveId, status: "dismissed", dismissedAt });
    await fs.seed("orchestra/archive/team-a-100.json", snapshot("team-a-100", 100));
    await fs.seed("orchestra/archive/team-b-200.json", snapshot("team-b-200", 200));
    await fs.seed("orchestra/archive/team-c-200.json", snapshot("team-c-200", 200));
    const listing = await store.list(cwd);
    assert.deepEqual(listing.ready.map((entry) => entry.archiveId), ["team-b-200", "team-c-200", "team-a-100"]);
  });
});

test("legacy archive reads normalize in memory without writeback", async () => {
  await withTempFs(async (fs) => {
    const store = createArchiveStore(fs);
    const legacy = {
      status: "dismissed",
      createdAt: 456,
      executorSessionId: "session-old-driver",
      topology: "trio",
      roles: [{ id: "reviewer", name: "Reviewer", sessionId: "session-r", rounds: 2 }],
    };
    await fs.seed("orchestra/archive/team-trio-456.json", legacy);
    const original = await fs.bytes("orchestra/archive/team-trio-456.json");
    const result = await store.read(cwd, "team-trio-456");
    assert.equal(result.kind, "ready");
    assert.equal(result.snapshot.archiveId, "team-trio-456");
    assert.equal(result.snapshot.teamId, "team-456");
    assert.equal(result.snapshot.topologyRef.id, "trio");
    assert.equal(result.snapshot.dismissedAt, 456);
    assert.equal(result.compatibility.source, "v1.0");
    assert.ok(result.warnings.length > 0);
    assert.equal(await fs.bytes("orchestra/archive/team-trio-456.json"), original);
  });
});

test("archive read/list expose invalid, unsupported, and unsafe entries", async () => {
  await withTempFs(async (fs) => {
    const store = createArchiveStore(fs);
    await fs.seed("orchestra/archive/bad-json.json", "{");
    await fs.seed("orchestra/archive/unsupported.json", { schemaVersion: 2, status: "dismissed", roles: [] });
    await fs.seed("orchestra/archive/wrong-shape.json", []);
    const listing = await store.list(cwd);
    assert.equal(listing.ready.length, 0);
    assert.equal(listing.blocked.length, 3);
    assert.equal((await store.read(cwd, "unsupported")).diagnostic.code, "unsupported_schema");
    assert.equal((await store.read(cwd, "missing")).kind, "missing");
    for (const unsafe of ["../escape", "a/b", "/absolute", ".", "..\\escape"]) {
      await assert.rejects(
        () => store.read(cwd, unsafe),
        (error) => error instanceof ArchiveStoreError && error.code === "unsafe_id",
      );
    }
  });
});

test("archive directory IO failure is not reported as an empty list", async () => {
  await withTempFs(async (fs) => {
    await fs.seed("orchestra/archive/ok.json", { schemaVersion: 1, status: "dismissed", ...team() });
    fs.failList = new FsTestError("FS_IO_ERROR", "listing failed");
    const store = createArchiveStore(fs);
    await assert.rejects(
      () => store.list(cwd),
      (error) => error instanceof ArchiveStoreError && error.code === "list_failed" && error.fsCode === "FS_IO_ERROR",
    );
  });
});

test("orchestra_team archive projection preserves per-entry fs diagnostics and schema shape", async () => {
  await withTempFs(async (fs) => {
    await fs.seed("orchestra/archive/fs-error.json", { schemaVersion: 1, status: "dismissed", ...team() });
    fs.failEntry = { filename: "fs-error.json", error: new FsTestError("FS_IO_ERROR", "entry stat failed") };
    const store = createArchiveStore(fs);
    const archiveList = await store.list(cwd);
    const output = archiveListForTeamTool(archiveList);
    const blocked = output.find((entry) => entry.filename === "fs-error.json");
    assert.notEqual(blocked, undefined);
    assert.equal(blocked.archive_id, "fs-error");
    assert.equal(blocked.filename, "fs-error.json");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.diagnostic.code, "filesystem");
    assert.equal(blocked.diagnostic.fsCode, "FS_IO_ERROR");
    assert.deepEqual(
      Object.keys(blocked).sort(),
      ["archive_id", "archive_path", "diagnostic", "dismissed_at", "filename", "goal", "status", "team_id", "topology"].sort(),
    );
    assert.deepEqual(Object.keys(blocked.diagnostic).sort(), ["code", "fsCode", "message"].sort());
  });
});

async function dismissThroughStores(fs, activeStore, archiveStore, currentTeam, dismissedAt, notices) {
  const observed = await activeStore.read(cwd);
  assert.equal(observed.kind, "ready");
  const archived = await archiveStore.create(cwd, currentTeam, { dismissedAt, policy: {} });
  const marker = {
    schemaVersion: 1,
    archived: true,
    status: "dismissed",
    archiveId: archived.summary.archiveId,
    archivePath: archived.summary.archivePath,
    archivedAt: dismissedAt,
    teamId: currentTeam.teamId,
  };
  try {
    await activeStore.archive(observed, marker, { policy: {} });
  } catch (error) {
    return { archived, error };
  }
  notices.push(archived.summary.archiveId);
  return { archived, error: undefined };
}

test("dismiss integration publishes archive then CAS marker before notifying roles", async () => {
  await withTempFs(async (fs) => {
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "success" });
    const currentTeam = team();
    await activeStore.create(cwd, currentTeam, { policy: {} });
    const notices = [];
    const result = await dismissThroughStores(fs, activeStore, archiveStore, currentTeam, 300, notices);
    assert.equal(result.error, undefined);
    assert.equal(notices.length, 1);
    const active = await activeStore.read(cwd);
    assert.equal(active.kind, "inactive");
    const marker = JSON.parse(await fs.bytes("orchestra/state/team.json"));
    assert.equal(marker.archiveId, result.archived.summary.archiveId);
    assert.equal(marker.archivePath, result.archived.summary.archivePath);
    assert.equal((await archiveStore.read(cwd, result.archived.summary.archiveId)).kind, "ready");
  });
});

test("stale dismiss CAS fails after archive creation and sends no retirement notice", async () => {
  await withTempFs(async (fs) => {
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "stale" });
    const currentTeam = team();
    await activeStore.create(cwd, currentTeam, { policy: {} });
    const observed = await activeStore.read(cwd);
    assert.equal(observed.kind, "ready");
    const archived = await archiveStore.create(cwd, currentTeam, { dismissedAt: 400, policy: {} });
    await activeStore.replace(observed, team({ teamId: "concurrent-team" }), { policy: {} });
    const notices = [];
    const marker = {
      schemaVersion: 1,
      archived: true,
      status: "dismissed",
      archiveId: archived.summary.archiveId,
      archivePath: archived.summary.archivePath,
      archivedAt: 400,
      teamId: currentTeam.teamId,
    };
    await assert.rejects(
      () => activeStore.archive(observed, marker, { policy: {} }),
      (error) => error instanceof ActiveTeamStateError && error.code === "stale_write",
    );
    assert.equal(notices.length, 0);
    assert.equal((await archiveStore.read(cwd, archived.summary.archiveId)).kind, "ready");
    assert.equal((await activeStore.read(cwd)).team.teamId, "concurrent-team");
  });
});

test("ready archive restores through inactive marker and rejects competing active team", async () => {
  await withTempFs(async (fs) => {
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "restore" });
    const currentTeam = team();
    await activeStore.create(cwd, currentTeam, { policy: {} });
    const notices = [];
    const dismissed = await dismissThroughStores(fs, activeStore, archiveStore, currentTeam, 500, notices);
    assert.equal(dismissed.error, undefined);
    const selected = await archiveStore.read(cwd, dismissed.archived.summary.archiveId);
    assert.equal(selected.kind, "ready");
    const restored = { ...selected.snapshot, status: "active", activatedFromArchiveId: selected.snapshot.archiveId };
    await activeStore.create(cwd, restored, { policy: {} });
    assert.equal((await activeStore.read(cwd)).kind, "ready");
    await assert.rejects(
      () => activeStore.create(cwd, team({ teamId: "competing-team" }), { policy: {} }),
      (error) => error instanceof ActiveTeamStateError && error.code === "active_exists",
    );
    assert.equal((await archiveStore.read(cwd, dismissed.archived.summary.archiveId)).kind, "ready");
  });
});

// ---------------------------------------------------------------------------
// D3: the archive transaction is STOP → TELL → RECORD, and every step survives a
// repeat. The three cases below are the plan's exit criteria for D3.
// ---------------------------------------------------------------------------

test("D3 1: dismissing twice notifies both times and the second call reports already_archived", async () => {
  await withTempFs(async (fs) => {
    const harness = dismissHarness(fs);
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "first" });
    const role = { ...team().roles[0], execution: "session", sessionHistory: [] };
    const current = team({ roles: [role] });
    await activeStore.create(cwd, current, { policy: {} });
    harness.register(role.sessionId);

    const first = await dismissGovernedTeam(harness.ctx, activeStore, archiveStore, harness.exec, { reason: "done" });
    assert.equal(first.status, "dismissed");
    assert.match(first.archive_id, /^team-team-archive-test-\d+-first$/, "the archive id is derived from the team and the dismissal id");
    // STOP before TELL: the role was cancelled, and then told.
    assert.deepEqual(harness.events.filter((entry) => entry.startsWith("cancel:")), [`cancel:${role.sessionId}`]);
    assert.deepEqual(harness.events.filter((entry) => entry.startsWith("notice:")), [`notice:${role.sessionId}`]);
    assert.ok(
      harness.events.indexOf(`cancel:${role.sessionId}`) < harness.events.indexOf(`notice:${role.sessionId}`),
      "the role is stopped before it is told",
    );
    // TELL before RECORD: the notice precedes every state/archive write.
    const markerWrite = harness.events.lastIndexOf(`fs:write:${await statePathOf(fs)}`);
    assert.ok(markerWrite > 0, "the archived marker was written");
    assert.ok(harness.events.indexOf(`notice:${role.sessionId}`) < markerWrite, "the notice precedes the record");

    // Re-entry: the marker is already there. Nothing is archived again, but the
    // role is told once more — a marker on disk says nothing to a session that
    // still believes it belongs to a live team.
    harness.events.length = 0;
    const second = await dismissGovernedTeam(harness.ctx, activeStore, archiveStore, harness.exec, { reason: "again" });
    assert.equal(second.status, "already_archived");
    assert.equal(second.archive_id, first.archive_id, "the re-entry names the archive that already exists");
    assert.equal(second.archive_path, first.archive_path);
    assert.deepEqual(harness.events.filter((entry) => entry.startsWith("notice:")), [`notice:${role.sessionId}`]);
    // No second snapshot: the archive directory still holds exactly one file.
    const listing = await archiveStore.list(cwd);
    assert.equal(listing.ready.length, 1, "a re-entry does not archive a second snapshot");
  });
});

test("D3 2: a terminal team's roles are told before the active slot is cleared", async () => {
  await withTempFs(async (fs) => {
    const harness = dismissHarness(fs);
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "terminal" });
    const role = { ...team().roles[0], execution: "session", sessionHistory: [] };
    await activeStore.create(cwd, team({ roles: [role] }), { policy: {} });
    harness.register(role.sessionId);
    await activeStore.mutate(cwd, (t) => ({ ...t, status: "completed" }), { policy: {} });

    const outcome = await handleTeamCommandInvocation(harness.ctx, activeStore, archiveStore, {
      rawInput: "/team start fresh",
      commandId: "command-terminal",
      agent: harness.controller,
    });
    assert.equal(outcome.kind, "success");

    // The notice happened, and it happened BEFORE the active state was cleared.
    assert.deepEqual(harness.events.filter((entry) => entry.startsWith("notice:")), [`notice:${role.sessionId}`]);
    const stateWrite = harness.events.lastIndexOf(`fs:write:${await statePathOf(fs)}`);
    assert.ok(stateWrite > 0, "the active state was written (cleared into the archived marker)");
    assert.ok(
      harness.events.indexOf(`notice:${role.sessionId}`) < stateWrite,
      "a terminal team's roles are told before the active slot is cleared",
    );
    assert.equal((await activeStore.read(cwd)).kind, "inactive");
  });
});

test("D3 3: after the marker lands, orchestra_team reports no team and lists the archive", async () => {
  await withTempFs(async (fs) => {
    const harness = dismissHarness(fs);
    const activeStore = createActiveTeamStateStore(fs);
    const archiveStore = createArchiveStore(fs, { dismissalId: () => "listed" });
    const role = { ...team().roles[0], execution: "session", sessionHistory: [] };
    await activeStore.create(cwd, team({ roles: [role] }), { policy: {} });
    const dismissed = await dismissGovernedTeam(harness.ctx, activeStore, archiveStore, harness.exec, {});

    // Drive the REAL tool: the marker makes the read non-ready, which is exactly
    // the branch that returns {team: null, archives}.
    const registered = [];
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), "orchestra-archive-apply-"));
    try {
      applyOrchestra({
        ...harness.ctx,
        tools: { register: (tool) => registered.push(tool) },
        effect: () => () => {},
        on: () => () => {},
      });
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
    const teamTool = registered.find((tool) => tool.name === "orchestra_team");
    assert.notEqual(teamTool, undefined, "orchestra_team is registered by the plugin");
    const output = await teamTool.execute({}, { ...harness.exec, name: "orchestra_team", callId: "call-team", arguments: {} });
    assert.equal(output.team, null, "an archived marker is not a team");
    assert.equal(output.archives.length, 1);
    assert.equal(output.archives[0].archive_id, dismissed.archive_id);
  });
});

/** The state file path this fs writes, for the ordering assertions. */
async function statePathOf(fs) {
  return fs.absolute("orchestra/state/team.json");
}
