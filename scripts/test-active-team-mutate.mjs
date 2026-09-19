import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ActiveTeamStateError,
  createActiveTeamStateStore,
  transferOrchestrationControl,
} from "../lib/orchestra-state.js";
import { createTeamChangeBus, withChangeSignal } from "../lib/team-change-bus.js";
import { initializeOrchestrationDocument } from "../lib/orchestration-document.js";

const cwd = "/tmp/orchestra-mutate-test";

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
    this.writeCount = 0;
    this.staleAttempts = 0;
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
    this.writeCount++;
    const existing = this.files.get(target.targetKey);
    if (expected?.kind === "createIfAbsent" && existing !== undefined) {
      throw new FsTestError("FS_NOT_OBSERVED", "test creator lost the race");
    }
    if (expected?.kind === "replaceIfVersion" && (existing === undefined || existing.version !== expected.version)) {
      this.staleAttempts++;
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

  content() {
    return this.files.get(`${cwd}:orchestra/state/team.json`)?.content;
  }
}

function sampleTeam(roleCount = 8) {
  const roles = Array.from({ length: roleCount }, (_, i) => ({
    id: `role-${i + 1}`,
    name: `Worker ${i + 1}`,
    sessionId: `session-worker-${i + 1}`,
    phase: "active",
    execution: i % 2 === 0 ? "session" : "subagent",
    parentSessionId: i % 2 === 0 ? undefined : "session-controller-1",
    sessionHistory: [],
    preset: "test-preset",
    sandbox: "workspace-write",
    reportCount: 0,
    lastReport: null,
  }));

  const baseTeam = {
    schemaVersion: 1,
    teamId: "team-mutate-concurrency",
    status: "active",
    rootCwd: cwd,
    controllerSessionId: "session-controller-1",
    controllerHistory: [],
    topologyRef: { id: "test-topology", source: "bundled" },
    mission: {
      objective: "Verify mutate CAS concurrency",
      scope: [],
      constraints: [],
      acceptanceCriteria: [],
      nonGoals: [],
      context: "",
    },
    createdAt: 1000,
    activatedFromArchiveId: null,
    roles,
    reports: [],
  };

  const doc = initializeOrchestrationDocument(baseTeam, 1000);
  return {
    ...baseTeam,
    document: doc,
  };
}

test("ActiveTeamStateStore.mutate: 8 concurrent lanes reporting simultaneously all succeed without lost updates", async () => {
  const fs = new MemoryFs();
  fs.seed(sampleTeam(8));
  const store = createActiveTeamStateStore(fs);

  // 8 concurrent workers filing reports
  const workers = Array.from({ length: 8 }, (_, i) => async () => {
    const roleId = `role-${i + 1}`;
    const sessionId = `session-worker-${i + 1}`;
    const reportPath = `/tmp/reports/${roleId}.md`;
    const content = `Content from ${roleId}`;
    const contentHash = createHash("sha256").update(content).digest("hex");

    return store.mutate(
      cwd,
      (team) => {
        const role = team.roles.find((r) => r.sessionId === sessionId);
        if (!role) return team;
        const reportId = createHash("sha256")
          .update(`${team.teamId}:${role.id}:${reportPath}:${contentHash}`)
          .digest("hex");
        if (team.reports.some((r) => r.reportId === reportId)) return team;

        const nextRoles = team.roles.map((r) =>
          r.sessionId === sessionId
            ? { ...r, reportCount: (r.reportCount ?? 0) + 1, lastReport: reportPath }
            : r,
        );
        const nextReports = [
          ...team.reports,
          {
            reportId,
            roleId: role.id,
            sessionId,
            path: reportPath,
            createdAt: Date.now(),
          },
        ];
        return {
          ...team,
          roles: nextRoles,
          reports: nextReports,
        };
      },
      { policy: { mode: "workspace-write" }, maxRetries: 35, baseBackoffMs: 2, maxBackoffMs: 64 },
    );
  });

  const results = await Promise.all(workers.map((w) => w()));
  assert.equal(results.length, 8);

  const finalRead = await store.read(cwd);
  assert.equal(finalRead.kind, "ready");
  assert.equal(finalRead.team.reports.length, 8, "all 8 reports must be committed");
  for (let i = 1; i <= 8; i++) {
    const role = finalRead.team.roles.find((r) => r.id === `role-${i}`);
    assert.equal(role?.reportCount, 1, `role-${i} must have reportCount = 1`);
    assert.equal(role?.lastReport, `/tmp/reports/role-${i}.md`);
  }
  assert.ok(fs.staleAttempts > 0, "concurrent writes must have encountered and recovered from stale CAS versions");
});

test("ActiveTeamStateStore.mutate: report filing is idempotent with deterministic reportId", async () => {
  const fs = new MemoryFs();
  fs.seed(sampleTeam(2));
  const store = createActiveTeamStateStore(fs);

  const fileReport = (sessionId, reportPath, content) => {
    const contentHash = createHash("sha256").update(content).digest("hex");
    return store.mutate(
      cwd,
      (team) => {
        const role = team.roles.find((r) => r.sessionId === sessionId);
        if (!role) return team;
        const reportId = createHash("sha256")
          .update(`${team.teamId}:${role.id}:${reportPath}:${contentHash}`)
          .digest("hex");
        if (team.reports.some((r) => r.reportId === reportId)) return team;

        return {
          ...team,
          roles: team.roles.map((r) =>
            r.sessionId === sessionId
              ? { ...r, reportCount: (r.reportCount ?? 0) + 1, lastReport: reportPath }
              : r,
          ),
          reports: [
            ...team.reports,
            { reportId, roleId: role.id, sessionId, path: reportPath, createdAt: Date.now() },
          ],
        };
      },
      { policy: { mode: "workspace-write" } },
    );
  };

  await fileReport("session-worker-1", "/tmp/r1.md", "hello");
  await fileReport("session-worker-1", "/tmp/r1.md", "hello"); // Idempotent call

  const read = await store.read(cwd);
  assert.equal(read.kind, "ready");
  assert.equal(read.team.reports.length, 1);
  const role1 = read.team.roles.find((r) => r.id === "role-1");
  assert.equal(role1?.reportCount, 1);
});

test("ActiveTeamStateStore.mutate: enforces pure function contract and rejects in-place mutation", async () => {
  const fs = new MemoryFs();
  fs.seed(sampleTeam(2));
  const store = createActiveTeamStateStore(fs);

  await assert.rejects(
    () =>
      store.mutate(
        cwd,
        (team) => {
          // Mutating the input argument directly violates the pure function contract
          team.status = "abandoned";
          return team;
        },
        { policy: { mode: "workspace-write" } },
      ),
    (err) => {
      assert.ok(err instanceof ActiveTeamStateError);
      assert.equal(err.code, "invalid_snapshot");
      assert.match(err.message, /pure function contract/);
      return true;
    },
  );
});

test("withChangeSignal: debounces mutate so listeners only receive single committed event", async () => {
  const fs = new MemoryFs();
  fs.seed(sampleTeam(2));
  const rawStore = createActiveTeamStateStore(fs);
  const bus = createTeamChangeBus();
  const store = withChangeSignal(rawStore, bus);

  const notifications = [];
  bus.notify = ((originalNotify) => (obs) => {
    notifications.push(obs);
    originalNotify(obs);
  })(bus.notify.bind(bus));

  await store.mutate(
    cwd,
    (team) => ({
      ...team,
      status: "degraded",
    }),
    { policy: { mode: "workspace-write" } },
  );

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].changed, true);
  assert.equal(notifications[0].cwd, cwd);
});

test("transferOrchestrationControl: updates controller, document, and resets subagent roles", () => {
  const team = sampleTeam(4);
  // role-1: session, role-2: subagent, role-3: session, role-4: subagent
  team.roles[1].welcome = { messageId: "m1", sessionId: "session-worker-2", acceptedAt: 12345 };
  team.roles[3].welcome = { messageId: "m2", sessionId: "session-worker-4", acceptedAt: 12346 };

  const transferred = transferOrchestrationControl(team, "session-controller-2", {
    reason: "takeover-by-user",
    timestamp: 99999,
  });

  assert.equal(transferred.controllerSessionId, "session-controller-2");
  assert.equal(transferred.controllerHistory.length, 1);
  assert.equal(transferred.controllerHistory[0].sessionId, "session-controller-1");
  assert.equal(transferred.controllerHistory[0].reason, "takeover-by-user");
  assert.equal(transferred.controllerHistory[0].replacedAt, 99999);

  assert.equal(transferred.document?.semanticWriterSessionId, "session-controller-2");

  // Subagents reset to reserved and bound to new controller
  assert.equal(transferred.roles[1].phase, "reserved");
  assert.equal(transferred.roles[1].parentSessionId, "session-controller-2");
  assert.equal(transferred.roles[1].welcome, undefined);

  assert.equal(transferred.roles[3].phase, "reserved");
  assert.equal(transferred.roles[3].parentSessionId, "session-controller-2");
  assert.equal(transferred.roles[3].welcome, undefined);

  // Regular sessions unchanged
  assert.equal(transferred.roles[0].phase, "active");
  assert.equal(transferred.roles[0].sessionId, "session-worker-1");
  assert.equal(transferred.roles[2].phase, "active");
  assert.equal(transferred.roles[2].sessionId, "session-worker-3");
});
