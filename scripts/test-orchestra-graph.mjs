import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTopology } from "../lib/orchestra-topology.js";
import {
  GraphRuntimeError,
  appendHandoffPending,
  appendHandoffResult,
  applyGateFallback,
  graphClosure,
  graphGates,
  graphHandoffs,
  graphLoops,
  graphSummary,
  initializeGraphRuntime,
  openGate,
  recordClosure,
  readGraphRuntime,
  recordVerdict,
  resolveGate,
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
  const malformedHandoff = { schemaVersion: 1, runtimeRevision: 1, teamId: currentTeam.teamId, charterRevision: 1, charterDigest: "digest", updatedAt: 7, events: [{ eventId: "handoff:bad", seq: 1, type: "handoff_pending", actorSessionId: "implementer-session", nodeId: "handoff:bad", parents: [], createdAt: 7, payload: {}, evidence: [] }] };
  assert.equal(readGraphRuntime(malformedHandoff, currentTeam.teamId, 1, "digest").kind, "blocked");
  const malformedClosure = { schemaVersion: 1, runtimeRevision: 1, teamId: currentTeam.teamId, charterRevision: 1, charterDigest: "digest", updatedAt: 7, events: [{ eventId: "closure", seq: 1, type: "closure_recorded", actorSessionId: "driver", nodeId: "closure", parents: [], createdAt: 7, payload: {}, evidence: [] }] };
  assert.equal(readGraphRuntime(malformedClosure, currentTeam.teamId, 1, "digest").kind, "blocked");
  assert.equal(graphSummary(runtime).pendingHandoffs.length, 0);
});

test("Human Gate blocks only its declared scope, supports direct decision/fallback, and Closure is owner-only terminal", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  const blockedContract = { ...loopContract(1), loopId: "blocked" };
  const independentContract = { ...loopContract(1), loopId: "independent" };
  const gate = { gateId: "human-review", decisionScope: ["loop:blocked"], blockingScope: ["loop:blocked"], options: ["approve", "reject"], required: true, onUnavailable: "fallback", fallbackOption: "reject", expiresAt: 10 };
  runtime = openGate(runtime, currentTeam, gate, { gateInstanceId: "gate-1", actorSessionId: "driver", now: 2, humanMode: "checkpointed", evidence: [{ kind: "message", ref: "question" }] }).runtime;
  assert.deepEqual(graphGates(runtime)[0].status, "open");
  assert.throws(() => startLoop(runtime, currentTeam, blockedContract, { actorSessionId: "driver", loopInstanceId: "blocked-1", now: 3, evidence: [{ kind: "report", ref: "start.md" }] }), (error) => error?.code === "handoff_invalid");
  runtime = startLoop(runtime, currentTeam, independentContract, { actorSessionId: "driver", loopInstanceId: "independent-1", now: 3, evidence: [{ kind: "report", ref: "start.md" }] }).runtime;
  const resolved = resolveGate(runtime, currentTeam, gate, { gateInstanceId: "gate-1", option: "approve", approvingSessionId: "driver", commandId: "cmd-gate", source: "user-command", now: 4 });
  runtime = resolved.runtime;
  assert.equal(graphGates(runtime)[0].status, "resolved");
  assert.throws(() => resolveGate(runtime, currentTeam, gate, { gateInstanceId: "gate-1", option: "reject", approvingSessionId: "driver", commandId: "cmd-conflict", source: "user-command", now: 5 }), (error) => error?.code === "duplicate_event");
  const fallbackGate = { ...gate, gateId: "human-fallback", decisionScope: ["loop:independent"], blockingScope: ["loop:independent"], options: ["continue", "stop"], fallbackOption: "stop", expiresAt: 100 };
  runtime = openGate(runtime, currentTeam, fallbackGate, { gateInstanceId: "gate-2", actorSessionId: "driver", now: 6, humanMode: "checkpointed" }).runtime;
  assert.throws(() => applyGateFallback(runtime, currentTeam, fallbackGate, { gateInstanceId: "gate-2", actorSessionId: "driver", now: 7, unavailableConfirmed: false, reason: "early", evidence: [] }), (error) => error?.code === "handoff_invalid");
  runtime = applyGateFallback(runtime, currentTeam, fallbackGate, { gateInstanceId: "gate-2", actorSessionId: "driver", now: 7, unavailableConfirmed: true, reason: "user unavailable", evidence: [{ kind: "message", ref: "unavailable" }] }).runtime;
  assert.equal(graphGates(runtime).find((gateState) => gateState.gateInstanceId === "gate-2").status, "fallback_applied");
  const globalGate = { ...gate, gateId: "global-gate", decisionScope: ["global"], blockingScope: ["global"], expiresAt: 100 };
  runtime = openGate(runtime, currentTeam, globalGate, { gateInstanceId: "gate-global", actorSessionId: "driver", now: 7, humanMode: "checkpointed" }).runtime;
  assert.throws(() => appendHandoffPending(runtime, currentTeam, { kind: "candidate", from: "implementer", to: ["reviewer"] }, { handoffId: "handoff-blocked", kind: "candidate", fromRole: "implementer", toRole: "reviewer", summary: "blocked", payload: { summary: "blocked" }, actorSessionId: "implementer-session", now: 8, evidence: [{ kind: "report", ref: "blocked.md" }] }), (error) => error?.code === "handoff_invalid");
  runtime = resolveGate(runtime, currentTeam, globalGate, { gateInstanceId: "gate-global", option: "approve", approvingSessionId: "driver", commandId: "global-decision", source: "user-command", now: 8 }).runtime;

  runtime = startAttempt(runtime, currentTeam, independentContract, { loopInstanceId: "independent-1", actorSessionId: "driver", participantRoleId: "implementer", now: 8, evidence: [{ kind: "report", ref: "candidate.md" }] }).runtime;
  runtime = recordVerdict(runtime, currentTeam, independentContract, { loopInstanceId: "independent-1", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: 9, evidence: [{ kind: "report", ref: "review.md" }] }).runtime;
  const closure = { owner: "driver", requiredLoopOutcomes: ["independent:passed"], requiredEvidenceKinds: ["report"], openGatePolicy: "reject", allowedOutcomes: ["completed", "failed", "abandoned"] };
  runtime = recordClosure(runtime, currentTeam, closure, { outcome: "completed", actorSessionId: "driver", now: 10, evidence: [{ kind: "report", ref: "closure.md" }] }).runtime;
  assert.equal(graphClosure(runtime).status, "recorded");
  assert.throws(() => startLoop(runtime, currentTeam, independentContract, { actorSessionId: "driver", loopInstanceId: "after-close", now: 11, evidence: [{ kind: "report", ref: "late.md" }] }), (error) => error?.code === "loop_terminal");
});

test("Gate timeoutPolicy and blocked/safe-stop outcomes keep required scope blocked", () => {
  const currentTeam = team();
  const contract = { ...loopContract(1), loopId: "timeout-lane" };
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  const timeoutGate = { gateId: "timeout-gate", decisionScope: ["loop:timeout-lane"], blockingScope: ["loop:timeout-lane"], options: ["continue", "stop"], required: true, onUnavailable: "fallback", fallbackOption: "continue", timeoutPolicy: "blocked", expiresAt: 5 };
  runtime = openGate(runtime, currentTeam, timeoutGate, { gateInstanceId: "timeout-1", actorSessionId: "driver", now: 2, humanMode: "checkpointed" }).runtime;
  runtime = applyGateFallback(runtime, currentTeam, timeoutGate, { gateInstanceId: "timeout-1", actorSessionId: "driver", now: 5, unavailableConfirmed: false, reason: "expired", evidence: [{ kind: "message", ref: "timeout" }] }).runtime;
  assert.equal(graphGates(runtime).find((gateState) => gateState.gateInstanceId === "timeout-1").status, "expired");
  assert.throws(() => startLoop(runtime, currentTeam, contract, { actorSessionId: "driver", loopInstanceId: "timeout-loop", now: 6, evidence: [{ kind: "report", ref: "start.md" }] }), (error) => error?.code === "handoff_invalid");
  const blockedGate = { ...timeoutGate, gateId: "blocked-gate", blockingScope: ["loop:blocked-lane"], decisionScope: ["loop:blocked-lane"], onUnavailable: "safe_stop", timeoutPolicy: "safe_stop", expiresAt: 100 };
  const blockedContract = { ...loopContract(1), loopId: "blocked-lane" };
  runtime = openGate(runtime, currentTeam, blockedGate, { gateInstanceId: "blocked-1", actorSessionId: "driver", now: 7, humanMode: "checkpointed" }).runtime;
  runtime = applyGateFallback(runtime, currentTeam, blockedGate, { gateInstanceId: "blocked-1", actorSessionId: "driver", now: 8, unavailableConfirmed: true, reason: "safe stop", evidence: [{ kind: "message", ref: "stop" }] }).runtime;
  assert.throws(() => startLoop(runtime, currentTeam, blockedContract, { actorSessionId: "driver", loopInstanceId: "blocked-loop", now: 9, evidence: [{ kind: "report", ref: "start.md" }] }), (error) => error?.code === "handoff_invalid");
});

test("allow_failed closure policy never lets completed bypass an open required Gate", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  const gate = { gateId: "approval-gate", decisionScope: ["global"], blockingScope: ["global"], options: ["approve", "reject"], required: true, onUnavailable: "blocked" };
  runtime = openGate(runtime, currentTeam, gate, { gateInstanceId: "approval-1", actorSessionId: "driver", now: 2, humanMode: "checkpointed" }).runtime;
  const closure = { owner: "driver", openGatePolicy: "allow_failed", allowedOutcomes: ["completed", "failed", "abandoned"] };
  const completed = recordClosure(runtime, currentTeam, closure, { outcome: "completed", actorSessionId: "driver", now: 3, evidence: [{ kind: "report", ref: "close.md" }] });
  assert.equal(completed.accepted, false);
  runtime = completed.runtime;
  const failed = recordClosure(runtime, currentTeam, closure, { outcome: "failed", actorSessionId: "driver", reason: "required user decision unavailable", now: 4, evidence: [{ kind: "report", ref: "failed.md" }] });
  assert.equal(failed.accepted, true);
  assert.equal(graphClosure(failed.runtime).outcome, "failed");
});
