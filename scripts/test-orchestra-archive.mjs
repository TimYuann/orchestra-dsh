import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ActiveTeamStateError, createActiveTeamStateStore } from "../lib/orchestra-state.js";
import { ArchiveStoreError, createArchiveStore } from "../lib/orchestra-archive.js";
import { archiveListForTeamTool } from "../lib/orchestra.js";

const cwd = "/archive-test-workspace";

class FsTestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class TemporaryArchiveFs {
  constructor(root) {
    this.root = root;
    this.lastExpected = undefined;
    this.failList = undefined;
    this.failEntry = undefined;
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
