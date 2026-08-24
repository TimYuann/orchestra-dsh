import { test } from "node:test";
import assert from "node:assert/strict";
import { createActiveTeamStateStore } from "../lib/orchestra-state.js";
import {
  appendDriverDecision,
  initializeOrchestrationDocument,
  inspectMarkdownProjection,
  isRuntimeProjectionStale,
  readOrchestrationDocument,
  reconcileOrchestrationDocument,
  renderOrchestrationMarkdown,
  writeMarkdownProjection,
} from "../lib/orchestration-document.js";

const cwd = "/tmp/orchestra-document-interface-test";

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
    this.failWrites = false;
    this.beforeWrite = undefined;
  }

  async resolve(path, options = {}) {
    const root = options.cwd ?? "";
    return { key: `${root}:${path}`, displayPath: `${root}/${path}` };
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
    if (file === undefined) throw new FsTestError("FS_NOT_FOUND", "missing test file");
    return file.content;
  }

  async writeText(target, content, expected) {
    if (this.failWrites) throw new FsTestError("FS_IO_ERROR", "projection write failed");
    if (this.beforeWrite !== undefined) {
      const hook = this.beforeWrite;
      this.beforeWrite = undefined;
      hook(target, expected);
    }
    const existing = this.files.get(target.key);
    if (expected?.kind === "createIfAbsent" && existing !== undefined) throw new FsTestError("FS_NOT_OBSERVED", "create race");
    if (expected?.kind === "replaceIfVersion" && (existing === undefined || existing.version !== expected.version)) throw new FsTestError("FS_STALE_VERSION", "stale projection");
    const version = `v${++this.clock}`;
    this.files.set(target.key, { content, version });
    return { operation: existing === undefined ? "create" : "update", version, before: existing?.content ?? null, after: content };
  }

  seed(path, value, version = `seed-${++this.clock}`) {
    const key = `${cwd}:${path}`;
    this.files.set(key, { content: typeof value === "string" ? value : JSON.stringify(value), version });
  }

  mutate(path, value) {
    const key = `${cwd}:${path}`;
    const current = this.files.get(key);
    this.files.set(key, { content: typeof value === "string" ? value : JSON.stringify(value), version: `external-${++this.clock}` });
    return current;
  }

  content(path) {
    return this.files.get(`${cwd}:${path}`)?.content;
  }
}

function team(overrides = {}) {
  return {
    schemaVersion: 1,
    teamId: "team-document",
    status: "active",
    rootCwd: cwd,
    controllerSessionId: "driver-session",
    controllerHistory: [],
    topologyRef: { id: "duo", source: "bundled" },
    mission: { objective: "document objective", scope: ["src"], constraints: ["CAS"], acceptanceCriteria: ["tests"], nonGoals: ["4B"], context: "test" },
    createdAt: 100,
    activatedFromArchiveId: null,
    roles: [{ id: "reviewer", name: "Reviewer", sessionId: "role-session", phase: "active", sessionHistory: [], preset: "orchestra-reviewer", sandbox: "read-only", reportCount: 1, lastReport: "orchestra/reports/review.md" }],
    reports: [{ reportId: "report-1", roleId: "reviewer", sessionId: "role-session", path: "orchestra/reports/review.md", createdAt: 101 }],
    ...overrides,
  };
}

test("document initializes as a draft with deterministic runtime projection", () => {
  const source = team();
  const first = initializeOrchestrationDocument(source, 200);
  const second = initializeOrchestrationDocument(source, 200);
  assert.deepEqual(first, second);
  assert.equal(first.charterStatus, "draft_required");
  assert.equal(first.documentRevision, 0);
  assert.equal(first.semanticWriterSessionId, source.controllerSessionId);
  assert.deepEqual(first.charterRevisions, []);
  assert.equal(first.runtimeProjection.roles[0].sessionId, "role-session");
  assert.equal(isRuntimeProjectionStale(first, source), false);
  assert.equal(isRuntimeProjectionStale(first, { ...source, roles: [{ ...source.roles[0], reportCount: 2 }] }), true);
  const legacyProjection = initializeOrchestrationDocument({ ...source, mission: { ...source.mission, objective: "" } }, 200);
  assert.equal(readOrchestrationDocument(legacyProjection, source.teamId).kind, "ready");
});

test("journal append is append-only, idempotent by decisionId, and conflicts on changed payload", () => {
  const source = team();
  const document = initializeOrchestrationDocument(source, 200);
  const input = {
    decisionId: "decision-1",
    kind: "scope",
    summary: "keep the checkpoint narrow",
    rationale: "4B is deferred",
    actorSessionId: source.controllerSessionId,
    createdAt: 201,
    evidence: [{ kind: "test", ref: "scripts/test-orchestration-document.mjs", label: "domain test" }],
    affects: ["reviewer"],
  };
  const appended = appendDriverDecision(document, source, input);
  assert.equal(appended.kind, "changed");
  assert.equal(appended.document.documentRevision, 1);
  assert.equal(appended.document.decisions.length, 1);
  const retry = appendDriverDecision(appended.document, source, input);
  assert.equal(retry.kind, "noop");
  assert.strictEqual(retry.document, appended.document);
  assert.throws(() => appendDriverDecision(appended.document, source, { ...input, summary: "changed" }), /already exists/);
  assert.throws(() => appendDriverDecision(appended.document, source, { ...input, actorSessionId: "reviewer-session" }), (error) => error?.code === "permission_denied");
});

test("durable document reads are total and never reset malformed facts", () => {
  const source = team();
  const valid = initializeOrchestrationDocument(source, 200);
  const malformed = [
    null,
    [],
    { ...valid, documentRevision: -1 },
    { ...valid, runtimeProjection: null },
    { ...valid, decisions: [null] },
    { ...valid, decisions: [{ decisionId: "d", kind: "test", summary: "bad", actorSessionId: "driver", createdAt: 1, evidence: [{ kind: "unknown", ref: "x" }] }] },
    { ...valid, markdown: { path: "" } },
  ];
  for (const value of malformed) {
    assert.doesNotThrow(() => readOrchestrationDocument(value, source.teamId));
    assert.equal(readOrchestrationDocument(value, source.teamId).kind, "blocked");
  }
  assert.equal(readOrchestrationDocument(undefined, source.teamId).kind, "legacy_missing");
  assert.equal(readOrchestrationDocument(valid, "other-team").kind, "blocked");
});

test("Markdown is deterministic, derived, and guarded by create/replace versions", async () => {
  const fs = new MemoryFs();
  const source = team();
  const document = appendDriverDecision(
    initializeOrchestrationDocument(source, 200),
    source,
    { decisionId: "decision-1", kind: "scope", summary: "keep it bounded", actorSessionId: source.controllerSessionId, createdAt: 201, evidence: [{ kind: "commit", ref: "abc123" }] },
  ).document;
  const markdown = renderOrchestrationMarkdown(document, false);
  assert.equal(markdown, renderOrchestrationMarkdown(document, false));
  assert.match(markdown, /team-document/);
  assert.match(markdown, /Driver Decision Journal/);
  assert.match(markdown, /abc123/);

  const first = await writeMarkdownProjection(fs, cwd, document, { policy: {} });
  assert.equal(first.status, "rendered");
  assert.equal((await inspectMarkdownProjection(fs, cwd, document)).status, "rendered");
  fs.mutate("orchestra/orchestration.md", "user edit");
  const stale = await writeMarkdownProjection(fs, cwd, document, { policy: {} });
  assert.equal(stale.status, "rendered", "the writer observes the current version before replacing a user edit");
  assert.equal((await inspectMarkdownProjection(fs, cwd, document)).status, "rendered");
  fs.beforeWrite = (target) => {
    const current = fs.files.get(target.key);
    fs.files.set(target.key, { content: current.content, version: `concurrent-${++fs.clock}` });
  };
  const concurrent = await writeMarkdownProjection(fs, cwd, document, { policy: {} });
  assert.equal(concurrent.status, "stale");
  fs.failWrites = true;
  const failed = await writeMarkdownProjection(fs, cwd, document, { policy: {} });
  assert.equal(failed.status, "projection_failed");
});

test("ActiveTeam CAS keeps canonical document transitions guarded and legacy reads do not write back", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  const source = team();
  const created = await store.create(cwd, { ...source, document: initializeOrchestrationDocument(source, 200) }, { policy: {} });
  assert.equal(created.operation, "created");
  const observed = await store.read(cwd);
  assert.equal(observed.kind, "ready");
  const next = reconcileOrchestrationDocument(observed.team.document, observed.team, source.controllerSessionId, 202).document;
  await store.replace(observed, { ...observed.team, document: next }, { policy: {} });
  await assert.rejects(
    () => store.replace(observed, { ...observed.team, document: next }, { policy: {} }),
    (error) => error?.code === "stale_write",
  );

  const legacyFs = new MemoryFs();
  const legacyStore = createActiveTeamStateStore(legacyFs);
  const legacy = { ...source, document: undefined };
  delete legacy.document;
  legacyFs.seed("orchestra/state/team.json", legacy);
  const before = legacyFs.content("orchestra/state/team.json");
  const read = await legacyStore.read(cwd);
  assert.equal(read.kind, "ready");
  assert.equal(read.team.document, undefined);
  assert.equal(legacyFs.content("orchestra/state/team.json"), before);
});

test("ActiveTeam treats a malformed canonical document as blocked rather than an empty Team", async () => {
  const fs = new MemoryFs();
  const store = createActiveTeamStateStore(fs);
  const source = team();
  const malformed = { ...source, document: { schemaVersion: 1, teamId: source.teamId, decisions: "not-an-array" } };
  fs.seed("orchestra/state/team.json", malformed);
  const before = fs.content("orchestra/state/team.json");
  const observed = await store.read(cwd);
  assert.equal(observed.kind, "blocked");
  assert.match(observed.diagnostic.message, /document/);
  await assert.rejects(() => store.create(cwd, source, { policy: {} }), /cannot create active team state/);
  assert.equal(fs.content("orchestra/state/team.json"), before);
});
