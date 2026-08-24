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

const ahTopology = BUILTIN_TOPOLOGIES.find((entry) => entry.id === "audit-and-hardening");
assert.ok(ahTopology, "audit-and-hardening must be a bundled topology");
const ahProtocol = ahTopology.protocol;
const loopContract = ahProtocol.loops[0];
const handoffContract = (kind) => ahProtocol.handoffs.find((entry) => entry.kind === kind);
const gateDefinition = ahProtocol.gates[0];
const closureDefinition = ahProtocol.closure;

const ALL_LOOP_EVIDENCE = [
  { kind: "report", ref: "start.md" },
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];
const FINDING_EVIDENCE = [
  { kind: "report", ref: "finding.md" },
  { kind: "file", ref: "src/auth.ts" },
  { kind: "message", ref: "finding-msg" },
];
const REMEDIATION_BRIEF_EVIDENCE = [
  { kind: "report", ref: "remediation-brief.md" },
  { kind: "test", ref: "t0" },
  { kind: "file", ref: "repro.md" },
];
const HARDENING_CANDIDATE_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];
const RESCAN_EVIDENCE = [
  { kind: "test", ref: "t1" },
  { kind: "diff", ref: "d1" },
  { kind: "report", ref: "rescan.md" },
];
const VERDICT_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
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
    teamId: "team-audit",
    status: "active",
    rootCwd: "/tmp/audit-and-hardening",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "audit-and-hardening", source: "bundled" },
    mission: { objective: "harden auth boundary", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    document: { currentCharterRevision: 1, charterRevisions: [{ charterRevision: 1, digest: "digest" }] },
    roles: [
      { id: "hardening-auditor", name: "Hardening Auditor", sessionId: "auditor-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-hardening-auditor-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "investigator", name: "Investigator", sessionId: "investigator-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-investigator-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "implementer", name: "Implementer", sessionId: "implementer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-implementer-v1", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "verifier", name: "Verifier", sessionId: "verifier-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-verifier-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

test("audit-and-hardening topology validates and carries the frozen D.5 contract", () => {
  assert.deepEqual(validateTopology(ahTopology), []);
  const loop = loopContract;
  assert.equal(loop.loopId, "hardening-remediation");
  assert.equal(loop.maxAttempts, 2);
  assert.equal(loop.evaluatorRole, "reviewer");
  assert.equal(loop.candidateKind, "hardening-candidate");
  assert.deepEqual(loop.entry, { role: "investigator", event: "remediation_ready" });
  assert.deepEqual(loop.participants, ["investigator", "implementer", "verifier", "reviewer"]);
  assert.deepEqual(loop.requiredEvidenceKinds, ["report", "commit", "diff", "test"]);
  assert.deepEqual(ahProtocol.handoffs.map((entry) => entry.kind), ["finding", "remediation-brief", "hardening-candidate", "rescan-evidence", "verdict"]);
  assert.deepEqual(ahProtocol.handoffs.map((entry) => [entry.from, entry.to]), [
    ["hardening-auditor", ["investigator"]],
    ["investigator", ["implementer"]],
    ["implementer", ["verifier"]],
    ["verifier", ["reviewer"]],
    ["reviewer", ["driver"]],
  ]);
  // the initial finding contract carries NO rescan/residualRisk fields: future results cannot be prefilled
  assert.deepEqual(handoffContract("finding").requiredPayloadFields, ["fingerprint", "asset", "location", "impact", "severity", "fix", "reproductionOrWhyNot"]);
  assert.ok(!handoffContract("finding").requiredPayloadFields.includes("rescan"));
  assert.ok(!handoffContract("finding").requiredPayloadFields.includes("residualRisk"));
  assert.deepEqual(handoffContract("finding").requiredEvidenceKinds, ["report", "file", "message"]);
  assert.deepEqual(handoffContract("remediation-brief").requiredPayloadFields, ["reproduction", "rootCause", "repairScope", "risk"]);
  assert.deepEqual(handoffContract("hardening-candidate").requiredPayloadFields, ["changedFiles", "controlAdded", "knownRisks"]);
  assert.deepEqual(handoffContract("rescan-evidence").requiredPayloadFields, ["originalFinding", "rescan", "regression", "residualRisk"]);
  assert.deepEqual(handoffContract("verdict").requiredPayloadFields, ["verdict", "openFindings", "residualRisk"]);
  assert.deepEqual(handoffContract("verdict").requiredEvidenceKinds, ["report", "commit", "diff", "test"]);
  assert.equal(gateDefinition.gateId, "security-risk-acceptance");
  assert.deepEqual(gateDefinition.decisionScope, ["loop:hardening-remediation"]);
  assert.deepEqual(gateDefinition.blockingScope, ["closure"]);
  assert.deepEqual(gateDefinition.options, ["approve", "remediate", "stop"]);
  assert.equal(gateDefinition.required, true);
  assert.equal(gateDefinition.onUnavailable, "blocked");
  assert.equal(closureDefinition.owner, "driver");
  assert.deepEqual(closureDefinition.requiredLoopOutcomes, ["hardening-remediation:passed"]);
  assert.deepEqual(closureDefinition.requiredVerdicts, ["PASS"]);
  assert.deepEqual(closureDefinition.requiredEvidenceKinds, ["report", "commit", "diff", "test"]);
  assert.equal(closureDefinition.openGatePolicy, "reject");
  assert.deepEqual(closureDefinition.allowedOutcomes, ["completed", "failed", "abandoned"]);
  assert.equal(closureDefinition.userOverride, false);
  assert.deepEqual(
    ahTopology.roles.map((role) => role.preset),
    ["orchestra-v04-hardening-auditor-v1", "orchestra-v04-investigator-v1", "orchestra-v04-implementer-v1", "orchestra-v04-verifier-v1", "orchestra-v04-reviewer-v1"],
  );
  assert.deepEqual(ahTopology.roles.map((role) => role.sandbox), ["read-only", "read-only", "workspace-write", "read-only", "read-only"]);
});

test("audit-and-hardening happy path: finding → remediation-brief → FAIL missing rescan → rescan → PASS → gate → closure", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-audit", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // finding handoff hardening-auditor -> investigator (immutable pre-loop evidence, no attempt binding)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("finding"), {
    handoffId: "audit-finding-1",
    kind: "finding",
    fromRole: "hardening-auditor",
    toRole: "investigator",
    loopInstanceId: "loop-audit",
    summary: "auth boundary finding",
    payload: { fingerprint: "FP-001", asset: "auth boundary", location: "src/auth.ts:42", impact: "privilege escalation", severity: "high", fix: "add ownership check", reproductionOrWhyNot: "repro steps in report" },
    actorSessionId: "auditor-session",
    now: now++,
    evidence: FINDING_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "audit-finding-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "fp1", state: "accepted" }, now: now++ }).runtime;
  const findingHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "audit-finding-1");
  assert.equal(findingHandoff.status, "accepted");
  assert.deepEqual(findingHandoff.evidence.map((ref) => ref.kind), ["report", "file", "message"]);

  // remediation-brief handoff investigator -> implementer
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("remediation-brief"), {
    handoffId: "audit-brief-1",
    kind: "remediation-brief",
    fromRole: "investigator",
    toRole: "implementer",
    loopInstanceId: "loop-audit",
    summary: "remediation brief",
    payload: { reproduction: "repro in report", rootCause: "missing ownership check", repairScope: ["src/auth.ts"], risk: "high" },
    actorSessionId: "investigator-session",
    now: now++,
    evidence: REMEDIATION_BRIEF_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "audit-brief-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "b1", state: "accepted" }, now: now++ }).runtime;

  // attempt 1: implementer hardening-candidate
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-audit",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { changedFiles: ["src/auth.ts"], controlAdded: "ownership check", knownRisks: "none" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;

  // hardening-candidate handoff implementer -> verifier
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("hardening-candidate"), {
    handoffId: "audit-candidate-1",
    kind: "hardening-candidate",
    fromRole: "implementer",
    toRole: "verifier",
    loopInstanceId: "loop-audit",
    attempt: 1,
    summary: "hardening candidate v1",
    payload: { changedFiles: ["src/auth.ts"], controlAdded: "ownership check", knownRisks: "none" },
    actorSessionId: "implementer-session",
    now: now++,
    evidence: HARDENING_CANDIDATE_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "audit-candidate-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "c1", state: "accepted" }, now: now++ }).runtime;

  // attempt 1 FAIL: rescan missing (first round must not PASS)
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-audit", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["missing rescan: exploit retest not provided"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");

  // attempt 2 is a distinct DAG node; finding fingerprint and attempt 1 facts stay re-readable
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-audit",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { changedFiles: ["src/auth.ts", "test/auth.test.ts"], controlAdded: "ownership check + rescan", knownRisks: "low" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;
  const attemptEvents = runtime.events.filter((event) => event.type === "attempt_started");
  assert.equal(attemptEvents.length, 2);
  assert.notEqual(attemptEvents[0].eventId, attemptEvents[1].eventId);
  const attempts = graphLoops(runtime)[0].attempts;
  assert.deepEqual(attempts.map((entry) => entry.attempt), [1, 2]);
  assert.equal(attempts[0].candidate.controlAdded, "ownership check");
  assert.equal(attempts[1].candidate.changedFiles.length, 2);
  assert.equal(attempts[0].verdict, "FAIL");
  assert.deepEqual(attempts[0].findings, ["missing rescan: exploit retest not provided"]);

  // rescan-evidence handoff verifier -> reviewer (attempt 2)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("rescan-evidence"), {
    handoffId: "audit-rescan-1",
    kind: "rescan-evidence",
    fromRole: "verifier",
    toRole: "reviewer",
    loopInstanceId: "loop-audit",
    attempt: 2,
    summary: "exploit/regression rescan ran",
    payload: { originalFinding: "FP-001", rescan: "exploit retest blocked", regression: "no regression", residualRisk: "low" },
    actorSessionId: "verifier-session",
    now: now++,
    evidence: RESCAN_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "audit-rescan-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "r1", state: "accepted" }, now: now++ }).runtime;
  const rescanHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "audit-rescan-1");
  assert.equal(rescanHandoff.status, "accepted");
  assert.equal(rescanHandoff.attempt, 2);
  assert.deepEqual(rescanHandoff.evidence.map((ref) => ref.kind), ["test", "diff", "report"]);

  // attempt 2 PASS
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-audit", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");

  // verdict handoff reviewer -> driver full pending -> accepted (controller target, bound to attempt 2)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("verdict"), {
    handoffId: "audit-verdict-1",
    kind: "verdict",
    fromRole: "reviewer",
    toRole: "driver",
    loopInstanceId: "loop-audit",
    attempt: 2,
    summary: "security review passed",
    payload: { verdict: "PASS", openFindings: [], residualRisk: "low" },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: VERDICT_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "audit-verdict-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "v1", state: "accepted" }, now: now++ }).runtime;
  const verdictHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "audit-verdict-1");
  assert.equal(verdictHandoff.status, "accepted");
  assert.equal(verdictHandoff.toRole, "driver");
  assert.equal(verdictHandoff.targetSessionId, "driver"); // team.controllerSessionId
  assert.equal(verdictHandoff.attempt, 2);
  assert.deepEqual(verdictHandoff.receipt, { message_id: "v1", state: "accepted" });
  assert.deepEqual(verdictHandoff.evidence.map((ref) => ref.kind), ["report", "commit", "diff", "test"]);

  // gate blocks closure until the user decides the residual risk
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-audit-1", actorSessionId: "driver", now: now++, humanMode: "checkpointed" }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-audit-1").status, "open");
  const rejected = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.diagnostic ?? "", /Gate|Human/i);
  runtime = rejected.runtime;
  assert.equal(graphClosure(runtime).status, "rejected");

  // user approves -> closure recorded -> terminal; old finding evidence stays readable
  runtime = resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-audit-1", option: "approve", approvingSessionId: "driver", commandId: "cmd-approve-audit", source: "user-command", now: now++ }).runtime;
  const accepted = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(accepted.accepted, true);
  runtime = accepted.runtime;
  assert.equal(graphClosure(runtime).status, "recorded");
  assert.equal(graphClosure(runtime).outcome, "completed");
  assert.equal(graphHandoffs(runtime).find((handoff) => handoff.handoffId === "audit-finding-1").status, "accepted");
  assert.deepEqual(graphHandoffs(runtime).find((handoff) => handoff.handoffId === "audit-finding-1").evidence.map((ref) => ref.kind), ["report", "file", "message"]);
  assert.throws(() => startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "after-close", now: now++, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "loop_terminal");
});

test("audit-and-hardening fail-loud negative paths", () => {
  const currentTeam = team();

  // rescan-evidence missing the residualRisk payload field -> rejected
  assert.throws(
    () => validateHandoffPayload(handoffContract("rescan-evidence"), "verifier", "reviewer", "rescan-evidence", { originalFinding: "FP-001", rescan: "blocked", regression: "none" }, RESCAN_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // finding missing the stable fingerprint -> rejected
  assert.throws(
    () => validateHandoffPayload(handoffContract("finding"), "hardening-auditor", "investigator", "finding", { asset: "auth", location: "src", impact: "x", severity: "high", fix: "y", reproductionOrWhyNot: "why-not" }, FINDING_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // verdict missing openFindings/residualRisk -> rejected
  assert.throws(
    () => validateHandoffPayload(handoffContract("verdict"), "reviewer", "driver", "verdict", { verdict: "PASS" }, VERDICT_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-neg", now: 2, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // missing evidence kinds fail loud on a real pending handoff
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("hardening-candidate"), {
      handoffId: "audit-bad-candidate",
      kind: "hardening-candidate",
      fromRole: "implementer",
      toRole: "verifier",
      loopInstanceId: "loop-neg",
      attempt: 1,
      summary: "missing diff",
      payload: { changedFiles: ["src/auth.ts"], controlAdded: "check", knownRisks: "none" },
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

  // missing rescan can only be rejected, never PASSed: FAIL keeps the loop running for retry
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["missing rescan: cannot verify remediation"], now: 6, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");
  assert.equal(graphLoops(runtime)[0].attempts[0].findings[0], "missing rescan: cannot verify remediation");

  // a BLOCKED verdict (missing rescan cannot be masked) terminates the loop: no hidden retry
  let blockedRuntime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  blockedRuntime = startLoop(blockedRuntime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-blocked", now: 2, evidence: ALL_LOOP_EVIDENCE }).runtime;
  blockedRuntime = startAttempt(blockedRuntime, currentTeam, loopContract, { loopInstanceId: "loop-blocked", actorSessionId: "driver", participantRoleId: "implementer", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;
  blockedRuntime = recordVerdict(blockedRuntime, currentTeam, loopContract, { loopInstanceId: "loop-blocked", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "BLOCKED", findings: ["rescan unavailable; do not mask"], now: 4, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(blockedRuntime)[0].status, "blocked");
  assert.throws(() => startAttempt(blockedRuntime, currentTeam, loopContract, { loopInstanceId: "loop-blocked", actorSessionId: "driver", participantRoleId: "implementer", now: 5, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "loop_terminal");
  const blockedClosure = recordClosure(blockedRuntime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: 6, evidence: CLOSURE_EVIDENCE });
  assert.equal(blockedClosure.accepted, false);
  assert.equal(graphClosure(blockedClosure.runtime).status, "rejected");

  // cap exhaustion: attempt 2 FAIL -> cap_exhausted, no hidden third round
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 7, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1", "F2"], now: 8, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(runtime.events.at(-1).type, "cap_exhausted");
  assert.equal(graphSummary(runtime).status, "cap_exhausted");
  assert.deepEqual(runtime.events.filter((event) => event.type === "attempt_started").map((event) => event.payload.attempt), [1, 2]);
  assert.throws(() => startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "implementer", now: 9, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "cap_exhausted");

  // a non-controller Agent cannot forge the user risk decision
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-neg-1", actorSessionId: "driver", now: 10, humanMode: "checkpointed" }).runtime;
  assert.throws(
    () => resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-neg-1", option: "approve", approvingSessionId: "hardening-auditor-session", commandId: "cmd-forged-risk", source: "user-command", now: 11 }),
    (error) => error?.code === "permission_denied",
  );
});

test("audit-and-hardening audit roles are read-only: no direct code or risk-state writes", () => {
  const byId = (id) => ahTopology.roles.find((role) => role.id === id);
  // hardening-auditor / investigator / verifier / reviewer: read-only sandbox, report/handoff-only write channel
  for (const id of ["hardening-auditor", "investigator", "verifier", "reviewer"]) {
    assert.equal(byId(id).sandbox, "read-only", `${id} must be read-only`);
    assert.ok(!byId(id).orchestraTools.includes("orchestra_verdict") || id === "reviewer", `${id} must not hold verdict authority`);
  }
  assert.deepEqual(byId("hardening-auditor").orchestraTools, ["orchestra_report", "orchestra_handoff"]);
  assert.deepEqual(byId("investigator").orchestraTools, ["orchestra_report", "orchestra_handoff"]);
  assert.deepEqual(byId("verifier").orchestraTools, ["orchestra_report", "orchestra_handoff"]);
  // reviewer is the only evaluator
  assert.deepEqual(byId("reviewer").orchestraTools, ["orchestra_report", "orchestra_verdict", "orchestra_handoff"]);
  // implementer is the only workspace-write role
  assert.equal(byId("implementer").sandbox, "workspace-write");
});
