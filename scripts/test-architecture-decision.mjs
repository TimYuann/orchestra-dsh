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

const adTopology = BUILTIN_TOPOLOGIES.find((entry) => entry.id === "architecture-decision");
assert.ok(adTopology, "architecture-decision must be a bundled topology");
const adProtocol = adTopology.protocol;
const loopContract = adProtocol.loops[0];
const handoffContract = (kind) => adProtocol.handoffs.find((entry) => entry.kind === kind);
const gateDefinition = adProtocol.gates[0];
const closureDefinition = adProtocol.closure;

const ALL_LOOP_EVIDENCE = [
  { kind: "report", ref: "start.md" },
  { kind: "file", ref: "constraints.md" },
  { kind: "url", ref: "https://example.com/spec" },
  { kind: "message", ref: "m1" },
];
const RESEARCH_BRIEF_EVIDENCE = [
  { kind: "url", ref: "https://example.com/spec" },
  { kind: "file", ref: "constraints.md" },
  { kind: "report", ref: "research.md" },
];
const DECISION_BRIEF_EVIDENCE = [
  { kind: "report", ref: "decision.md" },
  { kind: "file", ref: "alternatives.md" },
  { kind: "url", ref: "https://example.com/spec" },
];
const FINDINGS_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "message", ref: "findings-msg" },
  { kind: "url", ref: "https://example.com/evidence" },
];
const RECOMMENDATION_EVIDENCE = [
  { kind: "report", ref: "decision.md" },
  { kind: "file", ref: "migration.md" },
  { kind: "url", ref: "https://example.com/spec" },
];
const VERDICT_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "message", ref: "verdict-msg" },
  { kind: "url", ref: "https://example.com/evidence" },
  { kind: "file", ref: "decision.md" },
];
const CLOSURE_EVIDENCE = [
  { kind: "report", ref: "closure.md" },
  { kind: "file", ref: "decision.md" },
  { kind: "url", ref: "https://example.com/spec" },
];

function team() {
  return {
    schemaVersion: 1,
    teamId: "team-arch",
    status: "active",
    rootCwd: "/tmp/architecture-decision",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "architecture-decision", source: "bundled" },
    mission: { objective: "choose a migration path", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    document: { currentCharterRevision: 1, charterRevisions: [{ charterRevision: 1, digest: "digest" }] },
    roles: [
      { id: "researcher", name: "Researcher", sessionId: "researcher-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-researcher-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "architect", name: "Architect", sessionId: "architect-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-architect-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

test("architecture-decision topology validates and carries the frozen D.3 contract", () => {
  assert.deepEqual(validateTopology(adTopology), []);
  const loop = loopContract;
  assert.equal(loop.loopId, "decision-validation");
  assert.equal(loop.maxAttempts, 2);
  assert.equal(loop.evaluatorRole, "reviewer");
  assert.equal(loop.candidateKind, "decision-brief");
  assert.deepEqual(loop.entry, { role: "researcher", event: "research_ready" });
  assert.deepEqual(loop.participants, ["researcher", "architect", "reviewer"]);
  assert.deepEqual(loop.requiredEvidenceKinds, ["report", "file", "url", "message"]);
  assert.deepEqual(adProtocol.handoffs.map((entry) => entry.kind), ["research-brief", "decision-brief", "findings", "recommendation", "verdict"]);
  assert.deepEqual(adProtocol.handoffs.map((entry) => [entry.from, entry.to]), [
    ["researcher", ["architect"]],
    ["architect", ["reviewer"]],
    ["reviewer", ["researcher", "architect"]],
    ["architect", ["driver"]],
    ["reviewer", ["driver"]],
  ]);
  assert.deepEqual(handoffContract("research-brief").requiredPayloadFields, ["question", "options", "facts", "unknowns"]);
  assert.deepEqual(handoffContract("research-brief").requiredEvidenceKinds, ["url", "file", "report"]);
  assert.deepEqual(handoffContract("decision-brief").requiredPayloadFields, ["decision", "alternatives", "tradeoffs", "impact"]);
  assert.deepEqual(handoffContract("findings").requiredPayloadFields, ["missingEvidence", "risks", "requiredRevision"]);
  assert.deepEqual(handoffContract("recommendation").requiredPayloadFields, ["recommendedOption", "reasons", "migrationImpact"]);
  assert.deepEqual(handoffContract("recommendation").requiredEvidenceKinds, ["report", "file", "url"]);
  assert.deepEqual(handoffContract("verdict").requiredPayloadFields, ["verdict", "unresolvedFindings"]);
  assert.deepEqual(handoffContract("verdict").requiredEvidenceKinds, ["report", "message", "url"]);
  assert.equal(gateDefinition.gateId, "architecture-decision-approval");
  assert.deepEqual(gateDefinition.decisionScope, ["loop:decision-validation"]);
  assert.deepEqual(gateDefinition.blockingScope, ["closure"]);
  assert.deepEqual(gateDefinition.options, ["accept", "revise", "stop"]);
  assert.equal(gateDefinition.required, true);
  assert.equal(gateDefinition.onUnavailable, "blocked");
  assert.equal(closureDefinition.owner, "driver");
  assert.deepEqual(closureDefinition.requiredLoopOutcomes, ["decision-validation:passed"]);
  assert.deepEqual(closureDefinition.requiredVerdicts, ["PASS"]);
  assert.deepEqual(closureDefinition.requiredEvidenceKinds, ["report", "file", "url"]);
  assert.equal(closureDefinition.openGatePolicy, "reject");
  assert.deepEqual(closureDefinition.allowedOutcomes, ["completed", "failed", "abandoned"]);
  assert.equal(closureDefinition.userOverride, false);
  assert.deepEqual(
    adTopology.roles.map((role) => role.preset),
    ["orchestra-v04-researcher-v1", "orchestra-v04-architect-v1", "orchestra-v04-reviewer-v1"],
  );
  assert.deepEqual(adTopology.roles.map((role) => role.sandbox), ["read-only", "read-only", "read-only"]);
});

test("architecture-decision happy path: research-brief → FAIL missingEvidence → repair → PASS, closure stays rejected until user accept", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-arch", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // research-brief handoff researcher -> architect (before the first attempt)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("research-brief"), {
    handoffId: "arch-research-1",
    kind: "research-brief",
    fromRole: "researcher",
    toRole: "architect",
    loopInstanceId: "loop-arch",
    summary: "research brief ready",
    payload: { question: "which migration path", options: ["A", "B"], facts: ["A proven in spec"], unknowns: ["B load profile"] },
    actorSessionId: "researcher-session",
    now: now++,
    evidence: RESEARCH_BRIEF_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "arch-research-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "r1", state: "accepted" }, now: now++ }).runtime;
  const researchHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "arch-research-1");
  assert.equal(researchHandoff.status, "accepted");
  assert.deepEqual(researchHandoff.evidence.map((ref) => ref.kind), ["url", "file", "report"]);

  // attempt 1: architect decision brief
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-arch",
    actorSessionId: "driver",
    participantRoleId: "architect",
    candidate: { decision: "option A", alternatives: ["A", "B"], tradeoffs: ["cost"], impact: ["migration"] },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;

  // decision-brief handoff architect -> reviewer
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("decision-brief"), {
    handoffId: "arch-decision-1",
    kind: "decision-brief",
    fromRole: "architect",
    toRole: "reviewer",
    loopInstanceId: "loop-arch",
    attempt: 1,
    summary: "decision brief v1",
    payload: { decision: "option A", alternatives: ["A", "B"], tradeoffs: ["cost vs speed"], impact: ["migration window"] },
    actorSessionId: "architect-session",
    now: now++,
    evidence: DECISION_BRIEF_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "arch-decision-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "d1", state: "accepted" }, now: now++ }).runtime;

  // attempt 1 FAIL: missing evidence (first round must return findings)
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-arch", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["missingEvidence: no migration impact quantification"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");

  // findings handoff reviewer -> researcher (dual target: researcher allowed)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
    handoffId: "arch-findings-1",
    kind: "findings",
    fromRole: "reviewer",
    toRole: "researcher",
    loopInstanceId: "loop-arch",
    attempt: 1,
    summary: "R1 findings",
    payload: { missingEvidence: ["migration impact"], risks: ["unknown load"], requiredRevision: "quantify impact" },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: FINDINGS_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "arch-findings-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "f1", state: "accepted" }, now: now++ }).runtime;

  // attempt 2 is a distinct DAG node; old attempt facts preserved
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-arch",
    actorSessionId: "driver",
    participantRoleId: "architect",
    candidate: { decision: "option A", alternatives: ["A", "B"], tradeoffs: ["cost vs speed"], impact: ["migration window quantified"] },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;
  const attemptEvents = runtime.events.filter((event) => event.type === "attempt_started");
  assert.equal(attemptEvents.length, 2);
  assert.notEqual(attemptEvents[0].eventId, attemptEvents[1].eventId);
  const attempts = graphLoops(runtime)[0].attempts;
  assert.deepEqual(attempts.map((entry) => entry.attempt), [1, 2]);
  assert.equal(attempts[0].verdict, "FAIL");
  assert.deepEqual(attempts[0].findings, ["missingEvidence: no migration impact quantification"]);

  // attempt 2 PASS
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-arch", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");

  // verdict handoff reviewer -> driver full pending -> accepted (controller target)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("verdict"), {
    handoffId: "arch-verdict-1",
    kind: "verdict",
    fromRole: "reviewer",
    toRole: "driver",
    loopInstanceId: "loop-arch",
    attempt: 2,
    summary: "R1 passed",
    payload: { verdict: "PASS", unresolvedFindings: [] },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: VERDICT_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "arch-verdict-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "v1", state: "accepted" }, now: now++ }).runtime;
  const verdictHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "arch-verdict-1");
  assert.equal(verdictHandoff.status, "accepted");
  assert.equal(verdictHandoff.toRole, "driver");
  assert.equal(verdictHandoff.targetSessionId, "driver"); // team.controllerSessionId
  assert.equal(verdictHandoff.attempt, 2);
  assert.deepEqual(verdictHandoff.receipt, { message_id: "v1", state: "accepted" });

  // recommendation handoff architect -> driver full pending -> accepted (controller target)
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("recommendation"), {
    handoffId: "arch-recommendation-1",
    kind: "recommendation",
    fromRole: "architect",
    toRole: "driver",
    loopInstanceId: "loop-arch",
    attempt: 2,
    summary: "recommend option A",
    payload: { recommendedOption: "A", reasons: ["lower migration risk"], migrationImpact: "one release window" },
    actorSessionId: "architect-session",
    now: now++,
    evidence: RECOMMENDATION_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "arch-recommendation-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "r2", state: "accepted" }, now: now++ }).runtime;
  const recommendationHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "arch-recommendation-1");
  assert.equal(recommendationHandoff.status, "accepted");
  assert.equal(recommendationHandoff.toRole, "driver");
  assert.equal(recommendationHandoff.targetSessionId, "driver");
  assert.deepEqual(recommendationHandoff.evidence.map((ref) => ref.kind), ["report", "file", "url"]);

  // D.3 acceptance 2: reviewer PASS alone is NOT user approval — with the approval gate
  // open, closure stays rejected until the user accepts
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-arch-1", actorSessionId: "driver", now: now++, humanMode: "checkpointed" }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-arch-1").status, "open");
  const rejected = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.diagnostic ?? "", /Gate|Human/i);
  runtime = rejected.runtime;
  assert.equal(graphClosure(runtime).status, "rejected");

  // user accepts via the gate -> closure recorded -> terminal
  runtime = resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-arch-1", option: "accept", approvingSessionId: "driver", commandId: "cmd-accept-arch", source: "user-command", now: now++ }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-arch-1").status, "resolved");
  const accepted = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(accepted.accepted, true);
  runtime = accepted.runtime;
  assert.equal(graphClosure(runtime).status, "recorded");
  assert.equal(graphClosure(runtime).outcome, "completed");
  assert.throws(() => startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "after-close", now: now++, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "loop_terminal");
});

test("architecture-decision fail-loud negative paths", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);

  // research-brief handoff missing required url evidence -> rejected
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("research-brief"), {
      handoffId: "arch-bad-research",
      kind: "research-brief",
      fromRole: "researcher",
      toRole: "architect",
      summary: "missing url",
      payload: { question: "q", options: ["A"], facts: ["f"], unknowns: ["u"] },
      actorSessionId: "researcher-session",
      now: 2,
      evidence: [{ kind: "file", ref: "f.md" }, { kind: "report", ref: "r.md" }],
    }),
    (error) => error instanceof GraphRuntimeError && error.code === "handoff_invalid",
  );

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-neg", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "architect", now: 4, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // decision-brief handoff missing report -> rejected
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("decision-brief"), {
      handoffId: "arch-bad-decision",
      kind: "decision-brief",
      fromRole: "architect",
      toRole: "reviewer",
      loopInstanceId: "loop-neg",
      attempt: 1,
      summary: "missing report",
      payload: { decision: "A", alternatives: ["A"], tradeoffs: ["t"], impact: ["i"] },
      actorSessionId: "architect-session",
      now: 5,
      evidence: [{ kind: "file", ref: "f.md" }, { kind: "url", ref: "https://example.com" }],
    }),
    (error) => error?.code === "handoff_invalid",
  );

  // findings target outside the allowed set -> rejected
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
      handoffId: "arch-bad-findings",
      kind: "findings",
      fromRole: "reviewer",
      toRole: "reviewer",
      loopInstanceId: "loop-neg",
      attempt: 1,
      summary: "self findings",
      payload: { missingEvidence: ["x"], risks: ["y"], requiredRevision: "z" },
      actorSessionId: "reviewer-session",
      now: 6,
      evidence: FINDINGS_EVIDENCE,
    }),
    (error) => error?.code === "handoff_invalid",
  );

  // non-evaluator forging PASS -> rejected
  assert.throws(
    () => recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "architect-session", evaluatorRole: "reviewer", verdict: "PASS", now: 7, evidence: VERDICT_EVIDENCE }),
    (error) => error?.code === "evaluator_required",
  );

  // cap exhaustion: attempt 2 FAIL -> cap_exhausted, no hidden third attempt
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1"], now: 8, evidence: VERDICT_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "architect", now: 9, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1", "F2"], now: 10, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(runtime.events.at(-1).type, "cap_exhausted");
  assert.equal(graphSummary(runtime).status, "cap_exhausted");
  assert.deepEqual(runtime.events.filter((event) => event.type === "attempt_started").map((event) => event.payload.attempt), [1, 2]);
  assert.throws(() => startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-neg", actorSessionId: "driver", participantRoleId: "architect", now: 11, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "cap_exhausted");

  // a non-controller Agent cannot forge the user gate decision or the closure
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-neg-1", actorSessionId: "driver", now: 12, humanMode: "checkpointed" }).runtime;
  assert.throws(
    () => resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-neg-1", option: "accept", approvingSessionId: "architect-session", commandId: "cmd-forged", source: "user-command", now: 13 }),
    (error) => error?.code === "permission_denied",
  );
  assert.throws(
    () => recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "architect-session", now: 13, evidence: CLOSURE_EVIDENCE }),
    (error) => error?.code === "permission_denied",
  );
});

test("architecture-decision is a read-only graph: researcher/architect have no code-write tools", () => {
  const researcher = adTopology.roles.find((role) => role.id === "researcher");
  const architect = adTopology.roles.find((role) => role.id === "architect");
  const reviewer = adTopology.roles.find((role) => role.id === "reviewer");
  // no tool-bash in the synthesis/source lanes: decision briefs cannot mutate runtime code
  assert.deepEqual(researcher.compositionTools, ["tool-fs-search", "tool-fs"]);
  assert.deepEqual(architect.compositionTools, ["tool-fs-search", "tool-fs"]);
  assert.ok(!architect.compositionTools.includes("tool-bash"));
  assert.ok(!researcher.compositionTools.includes("tool-bash"));
  // all three roles are read-only; their only write channel is the report/handoff contract
  assert.equal(researcher.sandbox, "read-only");
  assert.equal(architect.sandbox, "read-only");
  assert.equal(reviewer.sandbox, "read-only");
  assert.deepEqual(architect.orchestraTools, ["orchestra_report", "orchestra_handoff"]);
  assert.deepEqual(researcher.orchestraTools, ["orchestra_report", "orchestra_handoff"]);
  // reviewer keeps the evaluator verdict tool but stays read-only
  assert.deepEqual(reviewer.orchestraTools, ["orchestra_report", "orchestra_verdict", "orchestra_handoff"]);
});
