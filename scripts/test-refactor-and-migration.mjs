import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_TOPOLOGIES, validateTopology } from "../lib/orchestra-topology.js";
import {
  GraphRuntimeError,
  appendHandoffPending,
  appendHandoffResult,
  graphClosure,
  graphGates,
  graphHandoffs,
  graphLoops,
  graphSummary,
  initializeGraphRuntime,
  openGate,
  recordClosure,
  recordVerdict,
  resolveGate,
  startAttempt,
  startLoop,
  validateHandoffPayload,
} from "../lib/orchestra-graph.js";

const rmTopology = BUILTIN_TOPOLOGIES.find((entry) => entry.id === "refactor-and-migration");
assert.ok(rmTopology, "refactor-and-migration must be a bundled topology");
const rmProtocol = rmTopology.protocol;
const loopContract = rmProtocol.loops[0];
const handoffContract = (kind) => rmProtocol.handoffs.find((entry) => entry.kind === kind);
const gateDefinition = rmProtocol.gates[0];
const closureDefinition = rmProtocol.closure;

const ALL_LOOP_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
  { kind: "report", ref: "start.md" },
  { kind: "file", ref: "compat-fixture.md" },
];
const MIGRATION_PLAN_EVIDENCE = [
  { kind: "report", ref: "migration-plan.md" },
  { kind: "file", ref: "baseline.md" },
  { kind: "commit", ref: "c0" },
];
const SLICE_CANDIDATE_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];
const COMPAT_EVIDENCE = [
  { kind: "test", ref: "t1" },
  { kind: "diff", ref: "d1" },
  { kind: "report", ref: "compat.md" },
];
const FINDINGS_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "message", ref: "findings-msg" },
];
const VERDICT_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
  { kind: "file", ref: "compat-fixture.md" },
];
const CLOSURE_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
  { kind: "report", ref: "closure.md" },
];

function team() {
  return {
    schemaVersion: 1,
    teamId: "team-migrate",
    status: "active",
    rootCwd: "/tmp/refactor-and-migration",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "refactor-and-migration", source: "bundled" },
    mission: { objective: "migrate api v1 to v2", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    document: { currentCharterRevision: 1, charterRevisions: [{ charterRevision: 1, digest: "digest" }] },
    roles: [
      { id: "architect", name: "Architect", sessionId: "architect-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-architect-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "implementer", name: "Implementer", sessionId: "implementer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-implementer-v1", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "verifier", name: "Verifier", sessionId: "verifier-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-verifier-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

test("refactor-and-migration topology validates and carries the frozen D.4 contract", () => {
  assert.deepEqual(validateTopology(rmTopology), []);
  const loop = loopContract;
  assert.equal(loop.loopId, "migration-validation");
  assert.equal(loop.maxAttempts, 2);
  assert.equal(loop.evaluatorRole, "reviewer");
  assert.equal(loop.candidateKind, "slice-candidate");
  assert.deepEqual(loop.entry, { role: "architect", event: "migration_plan_ready" });
  assert.deepEqual(loop.participants, ["architect", "implementer", "verifier", "reviewer"]);
  assert.deepEqual(loop.requiredEvidenceKinds, ["commit", "diff", "test", "report", "file"]);
  assert.deepEqual(rmProtocol.handoffs.map((entry) => entry.kind), ["migration-plan", "slice-candidate", "compatibility-evidence", "findings", "verdict"]);
  assert.deepEqual(rmProtocol.handoffs.map((entry) => [entry.from, entry.to]), [
    ["architect", ["implementer"]],
    ["implementer", ["verifier"]],
    ["verifier", ["reviewer"]],
    ["reviewer", ["architect", "implementer"]],
    ["reviewer", ["driver"]],
  ]);
  assert.deepEqual(handoffContract("migration-plan").requiredPayloadFields, ["baseline", "target", "slice", "compatWindow", "rollback"]);
  assert.deepEqual(handoffContract("migration-plan").requiredEvidenceKinds, ["report", "file", "commit"]);
  assert.deepEqual(handoffContract("slice-candidate").requiredPayloadFields, ["changedFiles", "compatImpact", "rollbackStep"]);
  assert.deepEqual(handoffContract("compatibility-evidence").requiredPayloadFields, ["oldPath", "newPath", "comparison", "rollbackResult"]);
  assert.deepEqual(handoffContract("findings").requiredPayloadFields, ["findings", "requiredCompatCheck", "scope"]);
  assert.deepEqual(handoffContract("verdict").requiredPayloadFields, ["verdict", "remainingRisk", "cutoverRecommendation"]);
  assert.deepEqual(handoffContract("verdict").requiredEvidenceKinds, ["report", "commit", "diff", "test"]);
  assert.equal(gateDefinition.gateId, "migration-compatibility-approval");
  assert.deepEqual(gateDefinition.decisionScope, ["loop:migration-validation"]);
  assert.deepEqual(gateDefinition.blockingScope, ["closure"]);
  assert.deepEqual(gateDefinition.options, ["approve", "revise", "stop"]);
  assert.equal(gateDefinition.required, true);
  assert.equal(gateDefinition.onUnavailable, "blocked");
  assert.equal(closureDefinition.owner, "driver");
  assert.deepEqual(closureDefinition.requiredLoopOutcomes, ["migration-validation:passed"]);
  assert.deepEqual(closureDefinition.requiredVerdicts, ["PASS"]);
  assert.deepEqual(closureDefinition.requiredEvidenceKinds, ["commit", "diff", "test", "report"]);
  assert.equal(closureDefinition.openGatePolicy, "reject");
  assert.deepEqual(closureDefinition.allowedOutcomes, ["completed", "failed", "abandoned"]);
  assert.equal(closureDefinition.userOverride, false);
  assert.deepEqual(
    rmTopology.roles.map((role) => role.preset),
    ["orchestra-v04-architect-v1", "orchestra-v04-implementer-v1", "orchestra-v04-verifier-v1", "orchestra-v04-reviewer-v1"],
  );
  assert.deepEqual(rmTopology.roles.map((role) => role.sandbox), ["read-only", "workspace-write", "read-only", "read-only"]);
});

test("refactor-and-migration happy path: migration-plan → slice FAIL → repair → PASS → gate → closure", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-migrate", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // migration-plan handoff architect -> implementer (before the first attempt)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("migration-plan"), {
    handoffId: "rm-plan-1",
    kind: "migration-plan",
    fromRole: "architect",
    toRole: "implementer",
    loopInstanceId: "loop-migrate",
    summary: "migration plan v1",
    payload: { baseline: "c0", target: "api v2", slice: "endpoint rewrite", compatWindow: "two releases", rollback: "revert to c0" },
    actorSessionId: "architect-session",
    now: now++,
    evidence: MIGRATION_PLAN_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "rm-plan-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "p1", state: "accepted" }, now: now++ }).runtime;
  const planHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "rm-plan-1");
  assert.equal(planHandoff.status, "accepted");
  // baseline commit ref is re-readable from the typed handoff evidence
  assert.deepEqual(planHandoff.evidence.map((ref) => ref.kind), ["report", "file", "commit"]);
  assert.ok(planHandoff.evidence.some((ref) => ref.kind === "commit" && ref.ref === "c0"));

  // attempt 1: implementer slice-candidate
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-migrate",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { changedFiles: ["src/api.ts"], compatImpact: "low", rollbackStep: "revert commit c1" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;

  // slice-candidate handoff implementer -> verifier
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("slice-candidate"), {
    handoffId: "rm-slice-1",
    kind: "slice-candidate",
    fromRole: "implementer",
    toRole: "verifier",
    loopInstanceId: "loop-migrate",
    attempt: 1,
    summary: "slice candidate v1",
    payload: { changedFiles: ["src/api.ts"], compatImpact: "low", rollbackStep: "revert commit c1" },
    actorSessionId: "implementer-session",
    now: now++,
    evidence: SLICE_CANDIDATE_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "rm-slice-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "s1", state: "accepted" }, now: now++ }).runtime;

  // compatibility-evidence handoff verifier -> reviewer
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("compatibility-evidence"), {
    handoffId: "rm-compat-1",
    kind: "compatibility-evidence",
    fromRole: "verifier",
    toRole: "reviewer",
    loopInstanceId: "loop-migrate",
    attempt: 1,
    summary: "old/new contract tests ran",
    payload: { oldPath: "api/v1", newPath: "api/v2", comparison: "behavior preserved", rollbackResult: "rollback smoke passed" },
    actorSessionId: "verifier-session",
    now: now++,
    evidence: COMPAT_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "rm-compat-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "c1", state: "accepted" }, now: now++ }).runtime;

  // attempt 1 FAIL: missing old-path evidence (first round must return findings)
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-migrate", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["missingEvidence: old-path contract test absent"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");

  // findings handoff reviewer -> architect (dual target: architect allowed)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
    handoffId: "rm-findings-1",
    kind: "findings",
    fromRole: "reviewer",
    toRole: "architect",
    loopInstanceId: "loop-migrate",
    attempt: 1,
    summary: "R1 findings",
    payload: { findings: ["missing old-path test"], requiredCompatCheck: ["api/v1 contract suite"], scope: ["src/api.ts", "test/compat.test.ts"] },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: FINDINGS_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "rm-findings-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "f1", state: "accepted" }, now: now++ }).runtime;

  // attempt 2 is a distinct DAG node; baseline/attempt 1 facts are never overwritten
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-migrate",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { changedFiles: ["src/api.ts", "test/compat.test.ts"], compatImpact: "low", rollbackStep: "revert commit c2" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;
  const attemptEvents = runtime.events.filter((event) => event.type === "attempt_started");
  assert.equal(attemptEvents.length, 2);
  assert.notEqual(attemptEvents[0].eventId, attemptEvents[1].eventId);
  const attempts = graphLoops(runtime)[0].attempts;
  assert.deepEqual(attempts.map((entry) => entry.attempt), [1, 2]);
  assert.equal(attempts[0].candidate.changedFiles[0], "src/api.ts");
  assert.equal(attempts[1].candidate.changedFiles.length, 2);
  assert.equal(attempts[0].verdict, "FAIL");
  assert.deepEqual(attempts[0].findings, ["missingEvidence: old-path contract test absent"]);

  // attempt 2 PASS
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-migrate", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");

  // verdict handoff reviewer -> driver full pending -> accepted (controller target, bound to attempt 2)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("verdict"), {
    handoffId: "rm-verdict-1",
    kind: "verdict",
    fromRole: "reviewer",
    toRole: "driver",
    loopInstanceId: "loop-migrate",
    attempt: 2,
    summary: "R1 passed",
    payload: { verdict: "PASS", remainingRisk: "one flaky old-path test", cutoverRecommendation: "approve cutover next release" },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: VERDICT_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "rm-verdict-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "v1", state: "accepted" }, now: now++ }).runtime;
  const verdictHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "rm-verdict-1");
  assert.equal(verdictHandoff.status, "accepted");
  assert.equal(verdictHandoff.toRole, "driver");
  assert.equal(verdictHandoff.targetSessionId, "driver"); // team.controllerSessionId
  assert.equal(verdictHandoff.attempt, 2);
  assert.deepEqual(verdictHandoff.receipt, { message_id: "v1", state: "accepted" });
  assert.deepEqual(verdictHandoff.evidence.map((ref) => ref.kind), ["report", "commit", "diff", "test", "file"]);

  // gate blocks closure until approval
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-migrate-1", actorSessionId: "driver", now: now++, humanMode: "checkpointed" }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-migrate-1").status, "open");
  const rejected = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.diagnostic ?? "", /Gate|Human/i);
  runtime = rejected.runtime;
  assert.equal(graphClosure(runtime).status, "rejected");

  // approve the gate -> closure recorded -> terminal
  runtime = resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-migrate-1", option: "approve", approvingSessionId: "driver", commandId: "cmd-approve-migrate", source: "user-command", now: now++ }).runtime;
  const accepted = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(accepted.accepted, true);
  runtime = accepted.runtime;
  assert.equal(graphClosure(runtime).status, "recorded");
  assert.equal(graphClosure(runtime).outcome, "completed");
  assert.throws(() => startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "after-close", now: now++, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "loop_terminal");
});

test("refactor-and-migration fail-loud negative paths", () => {
  const currentTeam = team();

  // compatibility-evidence missing the rollbackResult payload field -> rejected
  assert.throws(
    () => validateHandoffPayload(handoffContract("compatibility-evidence"), "verifier", "reviewer", "compatibility-evidence", { oldPath: "api/v1", newPath: "api/v2", comparison: "ok" }, COMPAT_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // migration-plan missing the slice declaration -> rejected (hidden slices cannot be smuggled)
  assert.throws(
    () => validateHandoffPayload(handoffContract("migration-plan"), "architect", "implementer", "migration-plan", { baseline: "c0", target: "v2", compatWindow: "two", rollback: "revert" }, MIGRATION_PLAN_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // verdict missing the cutoverRecommendation payload field -> rejected
  assert.throws(
    () => validateHandoffPayload(handoffContract("verdict"), "reviewer", "driver", "verdict", { verdict: "PASS", remainingRisk: "none" }, VERDICT_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // findings target outside the allowed set -> rejected
  assert.throws(
    () => validateHandoffPayload(handoffContract("findings"), "reviewer", "verifier", "findings", { findings: ["f"], requiredCompatCheck: ["c"], scope: ["s"] }, FINDINGS_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // missing evidence kinds fail loud on a real pending handoff
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-neg", now: 2, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("slice-candidate"), {
      handoffId: "rm-bad-slice",
      kind: "slice-candidate",
      fromRole: "implementer",
      toRole: "verifier",
      loopInstanceId: "loop-neg",
      attempt: 1,
      summary: "missing diff",
      payload: { changedFiles: ["src/api.ts"], compatImpact: "low", rollbackStep: "revert" },
      actorSessionId: "implementer-session",
      now: 4,
      evidence: [{ kind: "commit", ref: "c1" }, { kind: "test", ref: "t1" }],
    }),
    (error) => error?.code === "handoff_invalid",
  );

  // non-evaluator forging PASS -> rejected
  assert.throws(
    () => recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "verifier-session", evaluatorRole: "reviewer", verdict: "PASS", now: 5, evidence: VERDICT_EVIDENCE }),
    (error) => error?.code === "evaluator_required",
  );

  // cap exhaustion: attempt 2 FAIL -> cap_exhausted, no hidden third migration
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1"], now: 6, evidence: VERDICT_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 7, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1", "F2"], now: 8, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(runtime.events.at(-1).type, "cap_exhausted");
  assert.equal(graphSummary(runtime).status, "cap_exhausted");
  assert.deepEqual(runtime.events.filter((event) => event.type === "attempt_started").map((event) => event.payload.attempt), [1, 2]);
  assert.throws(() => startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 9, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "cap_exhausted");
});

test("pending handoff blocks closure even after a PASS verdict (rollback evidence must be reconciled)", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;
  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-pending", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-pending", actorSessionId: "driver", participantRoleId: "implementer", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-pending", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");

  // a compatibility-evidence handoff is left pending (rollback evidence not yet reconciled)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("compatibility-evidence"), {
    handoffId: "rm-pending-compat",
    kind: "compatibility-evidence",
    fromRole: "verifier",
    toRole: "reviewer",
    loopInstanceId: "loop-pending",
    attempt: 1,
    summary: "rollback smoke pending",
    payload: { oldPath: "api/v1", newPath: "api/v2", comparison: "ok", rollbackResult: "not yet run" },
    actorSessionId: "verifier-session",
    now: now++,
    evidence: COMPAT_EVIDENCE,
  }).runtime;
  assert.equal(graphSummary(runtime).pendingHandoffs.length, 1);

  // closure is blocked by the pending handoff regardless of the PASS verdict
  const rejected = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.diagnostic ?? "", /pending handoff/i);
  assert.equal(graphClosure(rejected.runtime).status, "rejected");
});
