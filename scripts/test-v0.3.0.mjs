/**
 * v0.3.0 unit tests — pure-function coverage for the new spec:
 *  1. validateTopology  (spec §4.4 hard validation)
 *  2. normalizeTeam     (spec §7.1 v1.0 → v1.1 normalization, marker semantics)
 *  3. projectSlugFromCwd (title disambiguation)
 *
 * Runs against the built lib/ output. E2E (create → report → dismiss →
 * activate) is covered by the dev-headless smoke run; the receipts and
 * progressive disclosure need a live host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTopology, normalizeTeam, projectSlugFromCwd } from "../lib/orchestra.js";

const validTopology = {
  schemaVersion: 1,
  id: "four-role-dev",
  name: "Four-role development team",
  controller: { id: "driver", source: "caller" },
  roles: [
    { id: "impl", name: "Implementer", preset: "orchestra-implementer", sandbox: "workspace-write" },
    { id: "review", name: "Reviewer", preset: "orchestra-reviewer", sandbox: "read-only", maxRounds: 2 },
    { id: "oracle", name: "Oracle", preset: "orchestra-oracle", sandbox: "read-only" },
  ],
  protocol: {
    ownership: { scope: "driver", implementation: "impl", review_verdict: "review", closure: "driver", advice: "oracle" },
    routes: [
      { kind: "mission", from: "driver", to: ["impl", "review"] },
      { kind: "candidate", from: "impl", to: ["review"] },
      { kind: "verdict", from: "review", to: ["driver"] },
      { kind: "escalation", from: ["driver", "impl", "review"], to: ["oracle"] },
    ],
    completion: { owner: "driver", rule: "Review PASS or explicit user override" },
  },
};

test("validateTopology: accepts a fully-valid v1 topology", () => {
  assert.deepEqual(validateTopology(validTopology), []);
});

test("validateTopology: rejects unsupported schemaVersion", () => {
  const problems = validateTopology({ ...validTopology, schemaVersion: 2 });
  assert.ok(problems.some((p) => p.includes("schemaVersion 2")));
});

test("validateTopology: rejects empty roles", () => {
  const problems = validateTopology({ ...validTopology, roles: [] });
  assert.ok(problems.some((p) => p.includes("at least one role")));
});

test("validateTopology: rejects duplicate role ids (case-insensitive)", () => {
  const dup = {
    ...validTopology,
    roles: [
      { id: "review", name: "Reviewer" },
      { id: "Review", name: "Reviewer 2" },
    ],
  };
  const problems = validateTopology(dup);
  assert.ok(problems.some((p) => p.includes("duplicated")));
});

test("validateTopology: rejects invalid sandbox", () => {
  const problems = validateTopology({
    ...validTopology,
    roles: [{ id: "x", name: "X", sandbox: "danger" }],
  });
  assert.ok(problems.some((p) => p.includes("sandbox")));
});

test("validateTopology: rejects runtime provider without model", () => {
  const problems = validateTopology({
    ...validTopology,
    roles: [{ id: "x", name: "X", runtime: { provider: "p" } }],
  });
  assert.ok(problems.some((p) => p.includes("runtime")));
});

test("validateTopology: rejects ownership/routes referencing unknown roles", () => {
  const problems = validateTopology({
    ...validTopology,
    protocol: {
      ownership: { scope: "driver", review_verdict: "ghost" },
      routes: [{ kind: "mission", from: "ghost2", to: ["impl"] }],
      completion: { owner: "ghost3", rule: "x" },
    },
  });
  assert.ok(problems.some((p) => p.includes("review_verdict") && p.includes("ghost")));
  assert.ok(problems.some((p) => p.includes("routes") && p.includes("ghost2")));
  assert.ok(problems.some((p) => p.includes("completion") && p.includes("ghost3")));
});

test("validateTopology: legacy topology without protocol still validates", () => {
  assert.deepEqual(validateTopology({ id: "legacy", roles: [{ id: "reviewer" }] }), []);
});

test("normalizeTeam: v1.1 snapshot round-trips", () => {
  const raw = {
    schemaVersion: 1,
    teamId: "team-abc",
    status: "active",
    rootCwd: "/w",
    controllerSessionId: "s-driver",
    controllerHistory: [],
    topologyRef: { id: "duo", source: "bundled" },
    mission: { objective: "goal", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 123,
    activatedFromArchiveId: null,
    roles: [
      { id: "reviewer", name: "Reviewer", sessionId: "s-r", sessionHistory: [], preset: "orchestra-reviewer", sandbox: "read-only", reportCount: 2, lastReport: "/w/orchestra/reports/r1.md" },
    ],
    reports: [{ reportId: "r1", roleId: "reviewer", sessionId: "s-r", path: "/w/orchestra/reports/r1.md", createdAt: 1 }],
  };
  const team = normalizeTeam(raw, "/w");
  assert.ok(team !== undefined);
  assert.equal(team.teamId, "team-abc");
  assert.equal(team.status, "active");
  assert.equal(team.roles[0].reportCount, 2);
});

test("normalizeTeam: v1.0 legacy snapshot upgrades (rounds → reportCount, executorSessionId → controllerSessionId)", () => {
  const raw = {
    topology: "trio",
    createdAt: 456,
    executorSessionId: "s-old-driver",
    roles: [
      { id: "reviewer", name: "Reviewer", sessionId: "s-r", preset: "orchestra-reviewer", sandbox: "read-only", rounds: 3, lastReport: "/w/r.md" },
    ],
  };
  const team = normalizeTeam(raw, "/w");
  assert.ok(team !== undefined);
  assert.equal(team.controllerSessionId, "s-old-driver");
  assert.equal(team.topologyRef.id, "trio");
  assert.equal(team.roles[0].reportCount, 3);
  assert.equal(team.status, "active");
});

test("normalizeTeam: v1.0 dismissed marker yields undefined (no active team)", () => {
  assert.equal(normalizeTeam({ archived: true, archivedAt: 1, archivePath: "/w/a.json" }, "/w"), undefined);
});

test("normalizeTeam: v1.1 dismissed status yields undefined", () => {
  assert.equal(normalizeTeam({ schemaVersion: 1, status: "dismissed", roles: [] }, "/w"), undefined);
});

test("normalizeTeam: dismissed archive snapshot parses with allowDismissed (activate regression)", () => {
  const raw = {
    schemaVersion: 1,
    status: "dismissed",
    archiveId: "team-duo-123",
    dismissedAt: 9,
    teamId: "team-abc",
    roles: [{ id: "reviewer", name: "Reviewer", sessionId: "s-r", reportCount: 1 }],
  };
  assert.equal(normalizeTeam(raw, "/w"), undefined, "default must treat dismissed as inactive");
  const team = normalizeTeam(raw, "/w", { allowDismissed: true });
  assert.ok(team !== undefined, "activate path must parse the dismissed snapshot");
  assert.equal(team.roles[0].reportCount, 1);
});

test("normalizeTeam: non-object / no roles yields undefined", () => {
  assert.equal(normalizeTeam(null, "/w"), undefined);
  assert.equal(normalizeTeam({}, "/w"), undefined);
  assert.equal(normalizeTeam({ roles: "nope" }, "/w"), undefined);
});

test("normalizeTeam: degraded status preserved", () => {
  const team = normalizeTeam({ status: "degraded", roles: [{ sessionId: "s-1" }] }, "/w");
  assert.ok(team !== undefined);
  assert.equal(team.status, "degraded");
});

test("projectSlugFromCwd: boundary cases", () => {
  assert.equal(projectSlugFromCwd("/Users/x/my-project"), "my-project");
  assert.equal(projectSlugFromCwd("/Users/x/my project!"), "my-project");
  assert.equal(projectSlugFromCwd("/"), "unknown");
  assert.equal(projectSlugFromCwd(""), "unknown");
  assert.equal(projectSlugFromCwd(undefined), "unknown");
  assert.equal(projectSlugFromCwd("/a/b/---"), "unknown");
  assert.equal(projectSlugFromCwd("/a/b/my_project-x"), "my_project-x");
});
