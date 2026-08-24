import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTopology } from "../lib/orchestra-topology.js";
import {
  GraphRuntimeError,
  appendHandoffPending,
  appendHandoffResult,
  graphHandoffs,
  graphLoops,
  graphSummary,
  initializeGraphRuntime,
  readGraphRuntime,
  recordVerdict,
  startAttempt,
  startLoop,
} from "../lib/orchestra-graph.js";

function team(charterDigest = "digest") {
  return {
    schemaVersion: 1,
    teamId: "team-graph",
    status: "active",
    rootCwd: "/tmp/graph",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "graph-topology", source: "bundled" },
    mission: { objective: "graph", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    document: { currentCharterRevision: 1, charterRevisions: [{ charterRevision: 1, digest: charterDigest }] },
    roles: [
      { id: "implementer", name: "Implementer", sessionId: "implementer-session", phase: "active", sessionHistory: [], preset: "preset", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "preset", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

function loopContract(maxAttempts = 1) {
  return { loopId: "review-loop", entry: { role: "implementer", event: "candidate" }, participants: ["implementer"], evaluatorRole: "reviewer", candidateKind: "candidate", verdictKind: "verdict", maxAttempts, passRoute: "pass", retryRoute: "retry", capExhaustedRoute: "driver", requiredEvidenceKinds: ["report"] };
}

test("Topology protocol validates bounded loops and typed handoffs total", () => {
  const config = { schemaVersion: 1, id: "graph-topology", roles: [{ id: "implementer", name: "Implementer" }, { id: "reviewer", name: "Reviewer" }], protocol: { loops: [loopContract()], handoffs: [{ kind: "candidate", from: "implementer", to: ["reviewer"], requiredPayloadFields: ["summary"], requiredEvidenceKinds: ["report"] }] } };
  assert.deepEqual(validateTopology(config), []);
  assert.ok(validateTopology({ ...config, protocol: { loops: [{ ...loopContract(), maxAttempts: 0 }] } }).some((problem) => /maxAttempts/.test(problem)));
  assert.ok(validateTopology({ ...config, protocol: { loops: [{ ...loopContract(), evaluatorRole: "missing" }] } }).some((problem) => /evaluatorRole/.test(problem)));
  assert.ok(validateTopology({ ...config, protocol: { handoffs: [{ kind: "bad", from: "missing", to: ["reviewer"] }] } }).some((problem) => /unknown role/.test(problem)));
  assert.ok(validateTopology({ ...config, protocol: { loops: [{ ...loopContract(), entry: null }] } }).some((problem) => /entry/.test(problem)));
  assert.deepEqual(validateTopology({ schemaVersion: 1, id: "legacy", roles: [{ id: "reviewer", name: "Reviewer" }] }), []);
});

test("bounded Loop reaches PASS and rejects later retry or driver verdict", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  const contract = loopContract(2);
  runtime = startLoop(runtime, currentTeam, contract, { actorSessionId: "driver", loopInstanceId: "loop-pass", now: 2, evidence: [{ kind: "report", ref: "start.md" }] }).runtime;
  runtime = startAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-pass", actorSessionId: "driver", participantRoleId: "implementer", candidate: { summary: "candidate" }, now: 3, evidence: [{ kind: "report", ref: "candidate.md" }] }).runtime;
  runtime = recordVerdict(runtime, currentTeam, contract, { loopInstanceId: "loop-pass", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: 4, evidence: [{ kind: "report", ref: "review.md" }] }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");
  assert.throws(() => startAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-pass", actorSessionId: "driver", participantRoleId: "implementer", now: 5, evidence: [{ kind: "report", ref: "again.md" }] }), (error) => error?.code === "loop_terminal");
  assert.throws(() => recordVerdict(runtime, currentTeam, contract, { loopInstanceId: "loop-pass", actorSessionId: "driver", evaluatorRole: "reviewer", verdict: "PASS", now: 5, evidence: [{ kind: "report", ref: "bad.md" }] }), (error) => error?.code === "evaluator_required" || error?.code === "loop_terminal");
});

test("FAIL at hard cap appends cap_exhausted and forbids a next attempt", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  const contract = loopContract(1);
  runtime = startLoop(runtime, currentTeam, contract, { actorSessionId: "driver", loopInstanceId: "loop-cap", now: 2, evidence: [{ kind: "report", ref: "start.md" }] }).runtime;
  runtime = startAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-cap", actorSessionId: "driver", participantRoleId: "implementer", now: 3, evidence: [{ kind: "report", ref: "candidate.md" }] }).runtime;
  runtime = recordVerdict(runtime, currentTeam, contract, { loopInstanceId: "loop-cap", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["unresolved"], now: 4, evidence: [{ kind: "report", ref: "review.md" }] }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "cap_exhausted");
  assert.equal(runtime.events.at(-1).type, "cap_exhausted");
  assert.throws(() => startAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-cap", actorSessionId: "driver", participantRoleId: "implementer", now: 5, evidence: [{ kind: "report", ref: "retry.md" }] }), (error) => error?.code === "cap_exhausted");
});

test("Graph runtime rejects stale charter, malformed parents, and keeps handoff pending/accepted idempotent", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  const contract = { kind: "candidate", from: "implementer", to: ["reviewer"], requiredPayloadFields: ["summary"], requiredEvidenceKinds: ["report"] };
  const pending = appendHandoffPending(runtime, currentTeam, contract, { handoffId: "handoff-1", kind: "candidate", fromRole: "implementer", toRole: "reviewer", summary: "candidate", payload: { summary: "candidate" }, actorSessionId: "implementer-session", now: 2, evidence: [{ kind: "report", ref: "candidate.md" }] });
  assert.equal(pending.kind, "changed");
  runtime = pending.runtime;
  const retry = appendHandoffPending(runtime, currentTeam, contract, { handoffId: "handoff-1", kind: "candidate", fromRole: "implementer", toRole: "reviewer", summary: "candidate", payload: { summary: "candidate" }, actorSessionId: "implementer-session", now: 3, evidence: [{ kind: "report", ref: "candidate.md" }] });
  assert.equal(retry.kind, "noop");
  assert.throws(() => appendHandoffPending(runtime, currentTeam, contract, { handoffId: "handoff-1", kind: "candidate", fromRole: "implementer", toRole: "reviewer", summary: "changed", payload: { summary: "changed" }, actorSessionId: "implementer-session", now: 3, evidence: [{ kind: "report", ref: "candidate.md" }] }), (error) => error?.code === "duplicate_event");
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "handoff-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "m1", state: "accepted" }, now: 4 }).runtime;
  assert.equal(graphHandoffs(runtime)[0].status, "accepted");
  assert.equal(appendHandoffResult(runtime, currentTeam, { handoffId: "handoff-1", actorSessionId: "driver", accepted: true, now: 5 }).kind, "noop");
  assert.throws(() => startLoop(runtime, { ...currentTeam, document: { currentCharterRevision: 2, charterRevisions: [{ charterRevision: 2, digest: "new" }] } }, loopContract(), { actorSessionId: "driver", now: 6 }), (error) => error instanceof GraphRuntimeError && error.code === "stale_charter");
  assert.equal(readGraphRuntime({ ...runtime, events: [{ ...runtime.events[0], parents: ["future"] }] }, currentTeam.teamId, 1, "digest").kind, "blocked");
  assert.equal(graphSummary(runtime).pendingHandoffs.length, 0);
});
