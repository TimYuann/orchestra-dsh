import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ActiveTeamStateError, createActiveTeamStateStore } from "../lib/orchestra-state.js";

const cwd = "/tmp/orchestra-state-interface-test";

class FsTestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class MemoryFs {
  constructor() {
    this.files = new Map();
    this.clock = 0;
    this.beforeWrite = undefined;
    this.lastExpected = undefined;
  }

  async resolve(path, options = {}) {
    const root = options.cwd ?? "";
    return {
      targetKey: `${root}:${path}`,
      displayPath: `${root}/${path}`,
    };
  }

  processPath(target) {
    return target.displayPath;
  }

  async stat(target) {
    const file = this.files.get(target.targetKey);
    if (file === undefined) return undefined;
    return { type: "file", size: file.content.length, version: file.version };
  }

  async readText(target) {
    const file = this.files.get(target.targetKey);
    if (file === undefined) throw new FsTestError("FS_NOT_FOUND", "missing test file");
    return file.content;
  }

  async writeText(target, content, expected) {
    this.lastExpected = expected;
    if (this.beforeWrite !== undefined) {
      const hook = this.beforeWrite;
      this.beforeWrite = undefined;
      hook(target, expected);
    }
    const existing = this.files.get(target.targetKey);
    if (expected?.kind === "createIfAbsent" && existing !== undefined) {
      throw new FsTestError("FS_NOT_OBSERVED", "test creator lost the race");
    }
    if (expected?.kind === "replaceIfVersion" && (existing === undefined || existing.version !== expected.version)) {
      throw new FsTestError("FS_STALE_VERSION", "test replacement is stale");
    }
    const version = `v${++this.clock}`;
    this.files.set(target.targetKey, { content, version });
    return {
      operation: existing === undefined ? "create" : "update",
      version,
      before: existing?.content ?? null,
      after: content,
    };
  }

  seed(raw, version = `seed-${++this.clock}`) {
    const targetKey = `${cwd}:orchestra/state/team.json`;
    this.files.set(targetKey, { content: typeof raw === "string" ? raw : JSON.stringify(raw), version });
  }

  seedTarget(target, raw) {
    this.files.set(target.targetKey, { content: JSON.stringify(raw), version: `race-${++this.clock}` });
  }

  content() {
    return this.files.get(`${cwd}:orchestra/state/team.json`)?.content;
  }
}

class TemporaryDirectoryFs {
  constructor(root) {
    this.root = root;
  }

  async resolve(path) {
    const displayPath = join(this.root, path);
    return { targetKey: displayPath, displayPath };
  }

  processPath(target) {
    return target.displayPath;
  }

  async stat(target) {
    try {
      const info = await stat(target.displayPath);
      if (!info.isFile()) return { type: "other", version: this.version(info), size: info.size };
      return { type: "file", version: this.version(info), size: info.size };
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  version(info) {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs?.toString() ?? info.mtimeMs}`;
  }

  async readText(target) {
    return readFile(target.displayPath, "utf8");
  }

  async writeText(target, content, expected) {
    await mkdir(dirname(target.displayPath), { recursive: true });
    const current = await this.stat(target);
    if (expected?.kind === "createIfAbsent" && current !== undefined) {
      throw new FsTestError("FS_NOT_OBSERVED", "temporary target already exists");
    }
    if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
      throw new FsTestError("FS_STALE_VERSION", "temporary target version is stale");
    }
    const before = current === undefined ? null : await this.readText(target);
    try {
      await writeFile(target.displayPath, content, { encoding: "utf8", flag: expected?.kind === "createIfAbsent" ? "wx" : "w" });
    } catch (error) {
      if (error?.code === "EEXIST") throw new FsTestError("FS_NOT_OBSERVED", "temporary create lost the race");
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
}

function team(overrides = {}) {
  return {
    schemaVersion: 1,
    teamId: "team-test",
    status: "active",
    rootCwd: cwd,
    controllerSessionId: "session-driver",
    controllerHistory: [],
    topologyRef: { id: "duo", source: "bundled" },
    mission: { objective: "test", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 123,
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

function writeOptions() {
  return { policy: {} };
}

test("active state interface classifies missing and ready current state", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  const missing = await store.read(cwd);
  assert.equal(missing.kind, "missing");
  assert.equal(missing.diagnostic.code, "missing");

  const created = await store.create(cwd, team(), writeOptions());
  assert.equal(created.operation, "created");
  assert.equal(created.statePath, `${cwd}/orchestra/state/team.json`);
  const ready = await store.read(cwd);
  assert.equal(ready.kind, "ready");
  assert.equal(ready.team.teamId, "team-test");
  assert.equal(ready.compatibility.source, "v1.1");
  assert.ok(ready.compatibility.migratedFields.includes("roles.phase→active"));
  assert.match(ready.warnings[0], /roles\.phase→active/);
  assert.notEqual(ready.version, undefined);
});

test("active state interface preserves legacy upgrades without writeback", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  const legacy = {
    topology: "trio",
    createdAt: 456,
    executorSessionId: "session-old-driver",
    roles: [{ id: "reviewer", name: "Reviewer", sessionId: "session-r", rounds: 3 }],
  };
  fs.seed(legacy);
  const result = await store.read(cwd);
  assert.equal(result.kind, "ready");
  assert.equal(result.compatibility.source, "v1.0");
  assert.equal(result.team.controllerSessionId, "session-old-driver");
  assert.equal(result.team.topologyRef.id, "trio");
  assert.equal(result.team.roles[0].reportCount, 3);
  assert.ok(result.compatibility.migratedFields.includes("executorSessionId→controllerSessionId"));
  assert.match(result.warnings[0], /not rewritten/);
  assert.deepEqual(JSON.parse(fs.content()), legacy);
});

test("active state interface classifies inactive markers and preserves degraded status", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  fs.seed({ archived: true, archivedAt: 1 });
  const archived = await store.read(cwd);
  assert.equal(archived.kind, "inactive");
  assert.equal(archived.reason, "archived");

  fs.seed({ schemaVersion: 1, status: "dismissed", roles: [] });
  const dismissed = await store.read(cwd);
  assert.equal(dismissed.kind, "inactive");
  assert.equal(dismissed.reason, "dismissed");

  fs.seed(team({ status: "degraded" }));
  const degraded = await store.read(cwd);
  assert.equal(degraded.kind, "ready");
  assert.equal(degraded.team.status, "degraded");
});

test("unsupported schema markers are blocked and cannot be replaced", async () => {
  const cases = [
    { schemaVersion: 2, archived: true },
    { schemaVersion: 2, status: "dismissed", roles: [] },
  ];
  for (const raw of cases) {
    const fs = new MemoryFs();
    const store = createActiveTeamStateStore(fs);
    fs.seed(raw);
    const original = fs.content();
    const observed = await store.read(cwd);
    assert.equal(observed.kind, "blocked");
    assert.equal(observed.diagnostic.code, "unsupported_schema");
    await assert.rejects(
      () => store.create(cwd, team(), writeOptions()),
      (error) => error instanceof ActiveTeamStateError && error.code === "write_failed" && /schemaVersion 2/.test(error.message),
    );
    assert.equal(fs.content(), original);
  }
});

test("create replaces an observed inactive marker without overwriting a concurrent change", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  fs.seed({ archived: true, archivedAt: 1 });
  const created = await store.create(cwd, team(), writeOptions());
  assert.equal(created.operation, "replaced");
  assert.equal(fs.lastExpected.kind, "replaceIfVersion");
  const ready = await store.read(cwd);
  assert.equal(ready.kind, "ready");
  assert.equal(ready.team.teamId, "team-test");
});

test("active state interface blocks invalid JSON, invalid shape, and unsupported schema", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);

  fs.seed("{");
  let result = await store.read(cwd);
  assert.equal(result.kind, "blocked");
  assert.equal(result.diagnostic.code, "invalid_json");

  fs.seed([]);
  result = await store.read(cwd);
  assert.equal(result.kind, "blocked");
  assert.equal(result.diagnostic.code, "invalid_shape");

  fs.seed({ ...team(), schemaVersion: 2 });
  result = await store.read(cwd);
  assert.equal(result.kind, "blocked");
  assert.equal(result.diagnostic.code, "unsupported_schema");

  fs.seed({ ...team(), roles: [{ id: "broken" }] });
  result = await store.read(cwd);
  assert.equal(result.kind, "blocked");
  assert.equal(result.diagnostic.code, "unrecoverable_identity");
});

test("create uses createIfAbsent and rejects a creator race", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  fs.beforeWrite = (target) => fs.seedTarget(target, team({ teamId: "other-team" }));
  await assert.rejects(
    () => store.create(cwd, team(), writeOptions()),
    (error) => error instanceof ActiveTeamStateError && error.code === "create_race" && error.fsCode === "FS_NOT_OBSERVED",
  );
  assert.equal(fs.lastExpected.kind, "createIfAbsent");
  assert.equal(JSON.parse(fs.content()).teamId, "other-team");
});

test("replace advances the opaque version and rejects stale writers", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  const created = await store.create(cwd, team(), writeOptions());
  const snapshot = await store.read(cwd);
  assert.equal(snapshot.kind, "ready");
  const updated = team({ status: "degraded", teamId: "team-updated" });
  const replaced = await store.replace(snapshot, updated, writeOptions());
  assert.equal(replaced.operation, "replaced");
  assert.notEqual(replaced.version, created.version);
  assert.equal(JSON.parse(fs.content()).teamId, "team-updated");

  await assert.rejects(
    () => store.replace(snapshot, team({ teamId: "stale-writer" }), writeOptions()),
    (error) => error instanceof ActiveTeamStateError && error.code === "stale_write" && error.fsCode === "FS_STALE_VERSION",
  );
  assert.equal(JSON.parse(fs.content()).teamId, "team-updated");
});

test("replace guard rejects an external stale writer on a temporary directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-state-"));
  try {
    const fs = new TemporaryDirectoryFs(root);
    const store = createActiveTeamStateStore(fs);
    await store.create(cwd, team(), writeOptions());
    const snapshot = await store.read(cwd);
    assert.equal(snapshot.kind, "ready");

    const target = join(root, "orchestra/state/team.json");
    await writeFile(target, JSON.stringify(team({ teamId: "external-writer-team" })), "utf8");
    await assert.rejects(
      () => store.replace(snapshot, team({ teamId: "stale-writer" }), writeOptions()),
      (error) => error instanceof ActiveTeamStateError && error.code === "stale_write" && error.fsCode === "FS_STALE_VERSION",
    );
    assert.equal(JSON.parse(await readFile(target, "utf8")).teamId, "external-writer-team");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocked state cannot be mistaken for an available create target", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  fs.seed("not-json");
  await assert.rejects(
    () => store.create(cwd, team(), writeOptions()),
    (error) => error instanceof ActiveTeamStateError && error.code === "write_failed" && /invalid JSON/.test(error.message),
  );
  assert.equal(fs.content(), "not-json");
});
