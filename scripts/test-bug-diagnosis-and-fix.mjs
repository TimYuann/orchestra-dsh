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
} from "../lib/orchestra-graph.js";

const bdTopology = BUILTIN_TOPOLOGIES.find((entry) => entry.id === "bug-diagnosis-and-fix");
assert.ok(bdTopology, "bug-diagnosis-and-fix must be a bundled topology");
const bdProtocol = bdTopology.protocol;
const loopContract = bdProtocol.loops[0];
const handoffContract = (kind) => bdProtocol.handoffs.find((entry) => entry.kind === kind);
const gateDefinition = bdProtocol.gates[0];
const closureDefinition = bdProtocol.closure;

const ALL_LOOP_EVIDENCE = [
  { kind: "report", ref: "start.md" },
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
  { kind: "message", ref: "m1" },
];
const DIAGNOSIS_EVIDENCE = [
  { kind: "report", ref: "diagnosis.md" },
  { kind: "test", ref: "t1" },
  { kind: "message", ref: "repro-msg" },
  { kind: "file", ref: "logs/crash.log" },
];
const CANDIDATE_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];
const VERIFICATION_EVIDENCE = [
  { kind: "test", ref: "t1" },
  { kind: "diff", ref: "d1" },
  { kind: "report", ref: "verify.md" },
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
  { kind: "message", ref: "verdict-msg" },
];
const CLOSURE_EVIDENCE = [
  { kind: "report", ref: "closure.md" },
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];

function team() {
  return {
    schemaVersion: 1,
    teamId: "team-bug",
    status: "active",
    rootCwd: "/tmp/bug-diagnosis-and-fix",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "bug-diagnosis-and-fix", source: "bundled" },
    mission: { objective: "fix the crash", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    document: { currentCharterRevision: 1, charterRevisions: [{ charterRevision: 1, digest: "digest" }] },
    roles: [
      { id: "investigator", name: "Investigator", sessionId: "investigator-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-investigator-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "implementer", name: "Implementer", sessionId: "implementer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-implementer-v1", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "verifier", name: "Verifier", sessionId: "verifier-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-verifier-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

test("bug-diagnosis-and-fix topology validates and carries the frozen D.2 contract", () => {
  assert.deepEqual(validateTopology(bdTopology), []);
  const loop = loopContract;
  assert.equal(loop.loopId, "diagnosis-fix-review");
  assert.equal(loop.maxAttempts, 2);
  assert.equal(loop.evaluatorRole, "reviewer");
  assert.equal(loop.candidateKind, "candidate");
  assert.deepEqual(loop.entry, { role: "investigator", event: "diagnosis_ready" });
  assert.deepEqual(loop.participants, ["investigator", "implementer", "verifier", "reviewer"]);
  assert.deepEqual(loop.requiredEvidenceKinds, ["report", "commit", "diff", "test", "message"]);
  assert.deepEqual(bdProtocol.handoffs.map((entry) => entry.kind), ["diagnosis", "candidate", "verification", "findings", "verdict"]);
  assert.deepEqual(bdProtocol.handoffs.map((entry) => [entry.from, entry.to]), [
    ["investigator", ["implementer"]],
    ["implementer", ["verifier"]],
    ["verifier", ["reviewer"]],
    ["reviewer", ["investigator", "implementer"]],
    ["reviewer", ["driver"]],
  ]);
  assert.deepEqual(handoffContract("diagnosis").requiredPayloadFields, ["symptom", "reproduction", "rootCause", "repairScope"]);
  assert.deepEqual(handoffContract("diagnosis").requiredEvidenceKinds, ["report", "test", "message", "file"]);
  assert.deepEqual(handoffContract("verification").requiredPayloadFields, ["regressionSummary", "remainingRisks"]);
  assert.deepEqual(handoffContract("findings").requiredPayloadFields, ["findings", "nextEvidence", "repairScope"]);
  assert.deepEqual(handoffContract("findings").requiredEvidenceKinds, ["report", "message"]);
  assert.deepEqual(handoffContract("verdict").requiredPayloadFields, ["verdict", "unresolvedFindings"]);
  assert.deepEqual(handoffContract("verdict").requiredEvidenceKinds, ["report", "commit", "diff", "test"]);
  assert.equal(gateDefinition.gateId, "bug-fix-acceptance");
  assert.deepEqual(gateDefinition.decisionScope, ["loop:diagnosis-fix-review"]);
  assert.deepEqual(gateDefinition.blockingScope, ["closure"]);
  assert.deepEqual(gateDefinition.options, ["approve", "request-changes", "stop"]);
  assert.equal(gateDefinition.required, true);
  assert.equal(gateDefinition.onUnavailable, "blocked");
  assert.equal(closureDefinition.owner, "driver");
  assert.deepEqual(closureDefinition.requiredLoopOutcomes, ["diagnosis-fix-review:passed"]);
  assert.deepEqual(closureDefinition.requiredVerdicts, ["PASS"]);
  assert.deepEqual(closureDefinition.requiredEvidenceKinds, ["report", "commit", "diff", "test"]);
  assert.equal(closureDefinition.openGatePolicy, "reject");
  assert.deepEqual(closureDefinition.allowedOutcomes, ["completed", "failed", "abandoned"]);
  assert.equal(closureDefinition.userOverride, false);
  assert.deepEqual(
    bdTopology.roles.map((role) => role.preset),
    ["orchestra-v04-investigator-v1", "orchestra-v04-implementer-v1", "orchestra-v04-verifier-v1", "orchestra-v04-reviewer-v1"],
  );
  assert.deepEqual(bdTopology.roles.map((role) => role.sandbox), ["read-only", "workspace-write", "read-only", "read-only"]);
});

test("bug-diagnosis-and-fix happy path: diagnosis → candidate → FAIL findings → repair → PASS → gate → closure", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-bug", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // diagnosis handoff investigator -> implementer (before the first attempt, no attempt binding)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("diagnosis"), {
    handoffId: "bug-diagnosis-1",
    kind: "diagnosis",
    fromRole: "investigator",
    toRole: "implementer",
    loopInstanceId: "loop-bug",
    summary: "root cause located",
    payload: { symptom: "login crashes", reproduction: "repro steps in log", rootCause: "null deref in auth", repairScope: ["src/auth.ts"] },
    actorSessionId: "investigator-session",
    now: now++,
    evidence: DIAGNOSIS_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "bug-diagnosis-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "d1", state: "accepted" }, now: now++ }).runtime;
  const diagnosisHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "bug-diagnosis-1");
  assert.equal(diagnosisHandoff.status, "accepted");
  assert.deepEqual(diagnosisHandoff.evidence.map((ref) => ref.kind), ["report", "test", "message", "file"]);

  // attempt 1: implementer candidate
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-bug",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { summary: "candidate v1", changedFiles: ["src/auth.ts"], knownRisks: "regression risk" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;

  // candidate handoff implementer -> verifier
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("candidate"), {
    handoffId: "bug-candidate-1",
    kind: "candidate",
    fromRole: "implementer",
    toRole: "verifier",
    loopInstanceId: "loop-bug",
    attempt: 1,
    summary: "candidate v1 ready",
    payload: { summary: "candidate v1 ready", changedFiles: ["src/auth.ts"], knownRisks: "regression risk" },
    actorSessionId: "implementer-session",
    now: now++,
    evidence: CANDIDATE_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "bug-candidate-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "c1", state: "accepted" }, now: now++ }).runtime;

  // verification handoff verifier -> reviewer
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("verification"), {
    handoffId: "bug-verification-1",
    kind: "verification",
    fromRole: "verifier",
    toRole: "reviewer",
    loopInstanceId: "loop-bug",
    attempt: 1,
    summary: "original failure and regression ran",
    payload: { regressionSummary: "original failure gone, one flaky test", remainingRisks: "flaky test needs retry" },
    actorSessionId: "verifier-session",
    now: now++,
    evidence: VERIFICATION_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "bug-verification-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "v1", state: "accepted" }, now: now++ }).runtime;

  // attempt 1 FAIL: diagnosis evidence insufficient for a PASS (first round must return findings)
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-bug", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1: regression coverage missing for the auth path"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");

  // findings handoff reviewer -> investigator (dual target: investigator is allowed)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
    handoffId: "bug-findings-1",
    kind: "findings",
    fromRole: "reviewer",
    toRole: "investigator",
    loopInstanceId: "loop-bug",
    attempt: 1,
    summary: "R1 findings",
    payload: { findings: ["F1: regression coverage missing"], nextEvidence: ["test/auth.test.ts"], repairScope: ["src/auth.ts", "test/auth.test.ts"] },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: FINDINGS_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "bug-findings-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "f1", state: "accepted" }, now: now++ }).runtime;

  // attempt 2 is a distinct DAG node; old attempt facts preserved
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-bug",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { summary: "candidate v2 (repaired)", changedFiles: ["src/auth.ts", "test/auth.test.ts"], knownRisks: "low" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;
  const attemptEvents = runtime.events.filter((event) => event.type === "attempt_started");
  assert.equal(attemptEvents.length, 2);
  assert.notEqual(attemptEvents[0].eventId, attemptEvents[1].eventId);
  const attempts = graphLoops(runtime)[0].attempts;
  assert.deepEqual(attempts.map((entry) => entry.attempt), [1, 2]);
  assert.equal(attempts[0].verdict, "FAIL");
  assert.deepEqual(attempts[0].findings, ["F1: regression coverage missing for the auth path"]);

  // attempt 2 PASS
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-bug", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");

  // verdict handoff reviewer -> driver full pending -> accepted (controller target)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("verdict"), {
    handoffId: "bug-verdict-1",
    kind: "verdict",
    fromRole: "reviewer",
    toRole: "driver",
    loopInstanceId: "loop-bug",
    attempt: 2,
    summary: "R1 passed",
    payload: { verdict: "PASS", unresolvedFindings: [] },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: VERDICT_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "bug-verdict-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "vd1", state: "accepted" }, now: now++ }).runtime;
  const verdictHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "bug-verdict-1");
  assert.equal(verdictHandoff.status, "accepted");
  assert.equal(verdictHandoff.toRole, "driver");
  assert.equal(verdictHandoff.targetSessionId, "driver"); // team.controllerSessionId
  assert.equal(verdictHandoff.attempt, 2);
  assert.deepEqual(verdictHandoff.receipt, { message_id: "vd1", state: "accepted" });
  assert.deepEqual(verdictHandoff.evidence.map((ref) => ref.kind), ["report", "commit", "diff", "test", "message"]);

  // gate blocks closure until approval
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-bug-1", actorSessionId: "driver", now: now++, humanMode: "checkpointed" }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-bug-1").status, "open");
  const rejected = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(rejected.accepted, false);
  runtime = rejected.runtime;
  assert.equal(graphClosure(runtime).status, "rejected");

  // approve the gate -> closure recorded -> terminal
  runtime = resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-bug-1", option: "approve", approvingSessionId: "driver", commandId: "cmd-approve-bug", source: "user-command", now: now++ }).runtime;
  const accepted = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(accepted.accepted, true);
  runtime = accepted.runtime;
  assert.equal(graphClosure(runtime).status, "recorded");
  assert.equal(graphClosure(runtime).outcome, "completed");
  assert.throws(() => startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "after-close", now: now++, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "loop_terminal");
});

test("bug-diagnosis-and-fix fail-loud negative paths", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);

  // diagnosis handoff missing required "file" evidence -> rejected before implementer sees it
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("diagnosis"), {
      handoffId: "bug-bad-diagnosis",
      kind: "diagnosis",
      fromRole: "investigator",
      toRole: "implementer",
      summary: "missing file evidence",
      payload: { symptom: "crash", reproduction: "repro", rootCause: "guess", repairScope: ["src"] },
      actorSessionId: "investigator-session",
      now: 2,
      evidence: [{ kind: "report", ref: "r.md" }, { kind: "test", ref: "t" }, { kind: "message", ref: "m" }],
    }),
    (error) => error instanceof GraphRuntimeError && error.code === "handoff_invalid",
  );

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-neg", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 4, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // candidate handoff missing diff -> rejected
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("candidate"), {
      handoffId: "bug-bad-candidate",
      kind: "candidate",
      fromRole: "implementer",
      toRole: "verifier",
      loopInstanceId: "loop-neg",
      attempt: 1,
      summary: "no diff",
      payload: { summary: "no diff", changedFiles: ["src/auth.ts"], knownRisks: "x" },
      actorSessionId: "implementer-session",
      now: 5,
      evidence: [{ kind: "commit", ref: "c1" }, { kind: "test", ref: "t1" }],
    }),
    (error) => error?.code === "handoff_invalid",
  );

  // verification handoff missing report -> rejected
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("verification"), {
      handoffId: "bug-bad-verification",
      kind: "verification",
      fromRole: "verifier",
      toRole: "reviewer",
      loopInstanceId: "loop-neg",
      attempt: 1,
      summary: "no report",
      payload: { regressionSummary: "ok", remainingRisks: "none" },
      actorSessionId: "verifier-session",
      now: 6,
      evidence: [{ kind: "test", ref: "t1" }, { kind: "diff", ref: "d1" }],
    }),
    (error) => error?.code === "handoff_invalid",
  );

  // non-evaluator forging PASS -> rejected
  assert.throws(
    () => recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "implementer-session", evaluatorRole: "reviewer", verdict: "PASS", now: 7, evidence: VERDICT_EVIDENCE }),
    (error) => error?.code === "evaluator_required",
  );

  // candidate without proven root cause cannot reach the success path: the reviewer must return findings (FAIL)
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F0: root cause not proven; diagnosis evidence missing"], now: 8, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");
  assert.equal(graphLoops(runtime)[0].attempts[0].findings[0], "F0: root cause not proven; diagnosis evidence missing");

  // cap exhaustion: attempt 2 FAIL -> cap_exhausted, no hidden third attempt
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 9, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1", "F2"], now: 10, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(runtime.events.at(-1).type, "cap_exhausted");
  assert.equal(graphSummary(runtime).status, "cap_exhausted");
  assert.deepEqual(runtime.events.filter((event) => event.type === "attempt_started").map((event) => event.payload.attempt), [1, 2]);
  assert.throws(() => startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 11, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "cap_exhausted");

  // closure never treats a BLOCKED loop as success
  let blockedRuntime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  blockedRuntime = startLoop(blockedRuntime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-blocked", now: 2, evidence: ALL_LOOP_EVIDENCE }).runtime;
  blockedRuntime = startAttempt(blockedRuntime, currentTeam, loopContract, { loopInstanceId: "loop-blocked", actorSessionId: "driver", participantRoleId: "implementer", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;
  blockedRuntime = recordVerdict(blockedRuntime, currentTeam, loopContract, { loopInstanceId: "loop-blocked", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "BLOCKED", findings: ["needs user decision"], now: 4, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(blockedRuntime)[0].status, "blocked");
  const blockedClosure = recordClosure(blockedRuntime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: 5, evidence: CLOSURE_EVIDENCE });
  assert.equal(blockedClosure.accepted, false);
  assert.match(blockedClosure.diagnostic ?? "", /Loop|verdict/i);
  assert.equal(graphClosure(blockedClosure.runtime).status, "rejected");
});

test("findings handoff accepts either dual target and rejects targets outside the contract", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-dual", now: 2, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-dual", actorSessionId: "driver", participantRoleId: "implementer", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // toRole "investigator" is inside contract.to -> accepted
  let result = appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
    handoffId: "dual-investigator",
    kind: "findings",
    fromRole: "reviewer",
    toRole: "investigator",
    loopInstanceId: "loop-dual",
    attempt: 1,
    summary: "findings",
    payload: { findings: ["F1"], nextEvidence: ["t"], repairScope: ["src"] },
    actorSessionId: "reviewer-session",
    now: 4,
    evidence: FINDINGS_EVIDENCE,
  });
  assert.equal(result.kind, "changed");
  runtime = result.runtime;

  // toRole "implementer" is inside contract.to -> accepted
  result = appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
    handoffId: "dual-implementer",
    kind: "findings",
    fromRole: "reviewer",
    toRole: "implementer",
    loopInstanceId: "loop-dual",
    attempt: 1,
    summary: "findings",
    payload: { findings: ["F2"], nextEvidence: ["t"], repairScope: ["src"] },
    actorSessionId: "reviewer-session",
    now: 5,
    evidence: FINDINGS_EVIDENCE,
  });
  assert.equal(result.kind, "changed");
  runtime = result.runtime;
  assert.deepEqual(graphHandoffs(runtime).map((handoff) => handoff.toRole).sort(), ["implementer", "investigator"]);

  // toRole "verifier" is outside the allowed target set -> rejected
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
      handoffId: "dual-verifier",
      kind: "findings",
      fromRole: "reviewer",
      toRole: "verifier",
      loopInstanceId: "loop-dual",
      attempt: 1,
      summary: "findings",
      payload: { findings: ["F3"], nextEvidence: ["t"], repairScope: ["src"] },
      actorSessionId: "reviewer-session",
      now: 6,
      evidence: FINDINGS_EVIDENCE,
    }),
    (error) => error?.code === "handoff_invalid",
  );
});
