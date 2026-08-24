import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_TOPOLOGIES, validateTopology } from "../lib/orchestra-topology.js";
import { preparseDraftRoleFacts } from "../lib/orchestra.js";
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

const fdTopology = BUILTIN_TOPOLOGIES.find((entry) => entry.id === "feature-development");
assert.ok(fdTopology, "feature-development must be a bundled topology");
const fdProtocol = fdTopology.protocol;
const loopContract = fdProtocol.loops[0];
const handoffContract = (kind) => fdProtocol.handoffs.find((entry) => entry.kind === kind);
const gateDefinition = fdProtocol.gates[0];
const closureDefinition = fdProtocol.closure;

const ALL_LOOP_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
  { kind: "report", ref: "start.md" },
];
const CANDIDATE_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];
const VERIFICATION_EVIDENCE = [
  { kind: "test", ref: "t1" },
  { kind: "diff", ref: "d1" },
  { kind: "file", ref: "src/a.ts" },
];
const FINDINGS_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "diff", ref: "d1" },
  { kind: "message", ref: "findings-msg" },
];
const VERDICT_EVIDENCE = [
  { kind: "report", ref: "review-R1.md" },
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];
const CLOSURE_EVIDENCE = [
  { kind: "commit", ref: "c1" },
  { kind: "diff", ref: "d1" },
  { kind: "test", ref: "t1" },
];

function team() {
  return {
    schemaVersion: 1,
    teamId: "team-fd",
    status: "active",
    rootCwd: "/tmp/feature-development",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "feature-development", source: "bundled" },
    mission: { objective: "feature", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    document: { currentCharterRevision: 1, charterRevisions: [{ charterRevision: 1, digest: "digest" }] },
    roles: [
      { id: "implementer", name: "Implementer", sessionId: "implementer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-implementer-v1", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "verifier", name: "Verifier", sessionId: "verifier-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-verifier-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

test("feature-development topology validates and carries the frozen D.1 contract", () => {
  assert.deepEqual(validateTopology(fdTopology), []);
  const loop = loopContract;
  assert.equal(loop.loopId, "implementation-review");
  assert.equal(loop.maxAttempts, 2);
  assert.equal(loop.evaluatorRole, "reviewer");
  assert.equal(loop.candidateKind, "candidate");
  assert.deepEqual(loop.entry, { role: "implementer", event: "candidate_ready" });
  assert.deepEqual(loop.participants, ["implementer", "verifier", "reviewer"]);
  assert.deepEqual(loop.requiredEvidenceKinds, ["commit", "diff", "test", "report"]);
  assert.deepEqual(fdProtocol.handoffs.map((entry) => entry.kind), ["candidate", "verification", "findings", "verdict"]);
  assert.deepEqual(fdProtocol.handoffs.map((entry) => [entry.from, entry.to]), [["implementer", ["verifier"]], ["verifier", ["reviewer"]], ["reviewer", ["implementer"]], ["reviewer", ["driver"]]]);
  assert.equal(gateDefinition.gateId, "feature-closure-approval");
  assert.deepEqual(gateDefinition.options, ["approve", "request-changes", "stop"]);
  assert.equal(gateDefinition.required, true);
  assert.equal(gateDefinition.onUnavailable, "blocked");
  assert.deepEqual(gateDefinition.blockingScope, ["closure"]);
  assert.equal(closureDefinition.owner, "driver");
  assert.deepEqual(closureDefinition.requiredLoopOutcomes, ["implementation-review:passed"]);
  assert.deepEqual(closureDefinition.requiredVerdicts, ["PASS"]);
  assert.deepEqual(closureDefinition.requiredEvidenceKinds, ["commit", "diff", "test"]);
  assert.equal(closureDefinition.openGatePolicy, "reject");
  assert.deepEqual(closureDefinition.allowedOutcomes, ["completed", "failed", "abandoned"]);
  assert.equal(closureDefinition.userOverride, false);
  assert.deepEqual(
    fdTopology.roles.map((role) => role.preset),
    ["orchestra-v04-implementer-v1", "orchestra-v04-verifier-v1", "orchestra-v04-reviewer-v1"],
  );
  assert.deepEqual(fdTopology.roles.map((role) => role.sandbox), ["workspace-write", "read-only", "read-only"]);
});

test("feature-development happy path: FAIL→repair→PASS, gate blocks closure until approval, then terminal completed", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;

  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-fd", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;

  // attempt 1: implementer candidate
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-fd",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { summary: "candidate v1", changedFiles: ["src/a.ts"], knownRisks: "none" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;

  // typed handoff candidate: implementer -> verifier; receipt/evidence re-readable
  let result = appendHandoffPending(runtime, currentTeam, handoffContract("candidate"), {
    handoffId: "fd-candidate-1",
    kind: "candidate",
    fromRole: "implementer",
    toRole: "verifier",
    loopInstanceId: "loop-fd",
    attempt: 1,
    summary: "candidate v1 ready",
    payload: { summary: "candidate v1 ready", changedFiles: ["src/a.ts"], knownRisks: "none" },
    actorSessionId: "implementer-session",
    now: now++,
    evidence: CANDIDATE_EVIDENCE,
  });
  runtime = result.runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "fd-candidate-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "m1", state: "accepted" }, now: now++ }).runtime;
  const candidateHandoff = graphHandoffs(runtime).find((handoff) => handoff.handoffId === "fd-candidate-1");
  assert.equal(candidateHandoff.status, "accepted");
  assert.deepEqual(candidateHandoff.receipt, { message_id: "m1", state: "accepted" });
  assert.deepEqual(candidateHandoff.evidence.map((ref) => ref.kind), ["commit", "diff", "test"]);
  assert.equal(candidateHandoff.attempt, 1);

  // typed handoff verification: verifier -> reviewer
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("verification"), {
    handoffId: "fd-verification-1",
    kind: "verification",
    fromRole: "verifier",
    toRole: "reviewer",
    loopInstanceId: "loop-fd",
    attempt: 1,
    summary: "checks ran",
    payload: { summary: "checks ran", checks: ["npm test", "tsc"], notes: "green" },
    actorSessionId: "verifier-session",
    now: now++,
    evidence: VERIFICATION_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "fd-verification-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "m2", state: "accepted" }, now: now++ }).runtime;

  // attempt 1 FAIL with findings (below the hard cap: Loop stays running)
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-fd", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1: missing coverage for edge case"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");

  // typed handoff findings: reviewer -> implementer
  runtime = appendHandoffPending(runtime, currentTeam, handoffContract("findings"), {
    handoffId: "fd-findings-1",
    kind: "findings",
    fromRole: "reviewer",
    toRole: "implementer",
    loopInstanceId: "loop-fd",
    attempt: 1,
    summary: "R1 findings",
    payload: { summary: "R1 findings", findings: ["F1: missing coverage"], repairScope: ["src/a.ts", "test/a.test.ts"] },
    actorSessionId: "reviewer-session",
    now: now++,
    evidence: FINDINGS_EVIDENCE,
  }).runtime;
  runtime = appendHandoffResult(runtime, currentTeam, { handoffId: "fd-findings-1", actorSessionId: "driver", accepted: true, receipt: { message_id: "m3", state: "accepted" }, now: now++ }).runtime;

  // attempt 2 is a distinct DAG node; the old attempt is never overwritten
  runtime = startAttempt(runtime, currentTeam, loopContract, {
    loopInstanceId: "loop-fd",
    actorSessionId: "driver",
    participantRoleId: "implementer",
    candidate: { summary: "candidate v2 (repaired)", changedFiles: ["src/a.ts", "test/a.test.ts"], knownRisks: "low" },
    now: now++,
    evidence: ALL_LOOP_EVIDENCE,
  }).runtime;
  const attemptEvents = runtime.events.filter((event) => event.type === "attempt_started");
  assert.equal(attemptEvents.length, 2);
  assert.notEqual(attemptEvents[0].eventId, attemptEvents[1].eventId, "attempts must be distinct DAG nodes");
  assert.equal(attemptEvents[0].seq < attemptEvents[1].seq, true);
  // the old attempt is never overwritten: the first attempt event keeps its original candidate
  assert.equal(attemptEvents[0].payload.candidate.summary, "candidate v1");
  assert.equal(attemptEvents[1].payload.candidate.summary, "candidate v2 (repaired)");
  const attempts = graphLoops(runtime)[0].attempts;
  assert.deepEqual(attempts.map((entry) => entry.attempt), [1, 2]);
  assert.equal(attempts[0].candidate.summary, "candidate v1");
  assert.equal(attempts[1].candidate.summary, "candidate v2 (repaired)");
  assert.equal(attempts[0].verdict, "FAIL");
  assert.deepEqual(attempts[0].findings, ["F1: missing coverage for edge case"]);

  // attempt 2 PASS -> Loop passed
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-fd", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "passed");

  // verdict handoff contract reviewer -> driver is enforced at the contract level
  // (the driver is the controller, not a TeamRole; durable verdict facts live in the graph)
  validateHandoffPayload(handoffContract("verdict"), "reviewer", "driver", "verdict", { summary: "R1 passed", verdict: "PASS", unresolvedFindings: [] }, VERDICT_EVIDENCE);

  // closure gate: open but unapproved -> closure is rejected
  runtime = openGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-fd-1", actorSessionId: "driver", now: now++, humanMode: "checkpointed" }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-fd-1").status, "open");
  const rejected = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.diagnostic ?? "", /Gate|Human/i);
  runtime = rejected.runtime;
  assert.equal(graphClosure(runtime).status, "rejected");

  // user approves the gate -> closure recorded -> terminal
  runtime = resolveGate(runtime, currentTeam, gateDefinition, { gateInstanceId: "gate-fd-1", option: "approve", approvingSessionId: "driver", commandId: "cmd-approve-fd", source: "user-command", now: now++ }).runtime;
  assert.equal(graphGates(runtime).find((gate) => gate.gateInstanceId === "gate-fd-1").status, "resolved");
  const accepted = recordClosure(runtime, currentTeam, closureDefinition, { outcome: "completed", actorSessionId: "driver", now: now++, evidence: CLOSURE_EVIDENCE });
  assert.equal(accepted.accepted, true);
  runtime = accepted.runtime;
  assert.equal(graphClosure(runtime).status, "recorded");
  assert.equal(graphClosure(runtime).outcome, "completed");
  assert.throws(() => startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "after-close", now: now++, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "loop_terminal");
});

test("cap exhaustion: second FAIL appends cap_exhausted and forbids a third attempt", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  let now = 2;
  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-cap", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-cap", actorSessionId: "driver", participantRoleId: "implementer", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-cap", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(graphLoops(runtime)[0].status, "running");
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-cap", actorSessionId: "driver", participantRoleId: "implementer", now: now++, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-cap", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["F1", "F2"], now: now++, evidence: VERDICT_EVIDENCE }).runtime;
  assert.equal(runtime.events.at(-1).type, "cap_exhausted");
  assert.deepEqual(runtime.events.at(-1).payload.unresolvedFindings, ["F1", "F2"]);
  const loop = graphLoops(runtime)[0];
  assert.equal(loop.status, "cap_exhausted");
  assert.equal(loop.capExhausted, true);
  assert.equal(graphSummary(runtime).status, "cap_exhausted");
  assert.deepEqual(runtime.events.filter((event) => event.type === "attempt_started").map((event) => event.payload.attempt), [1, 2]);
  assert.throws(() => startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-cap", actorSessionId: "driver", participantRoleId: "implementer", now: now++, evidence: ALL_LOOP_EVIDENCE }), (error) => error?.code === "cap_exhausted");
});

test("fail-loud negative paths: missing evidence, forged verdict, out-of-bounds roles", () => {
  const currentTeam = team();
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);

  // candidate handoff missing the required test evidence
  assert.throws(
    () => appendHandoffPending(runtime, currentTeam, handoffContract("candidate"), {
      handoffId: "fd-bad-evidence",
      kind: "candidate",
      fromRole: "implementer",
      toRole: "verifier",
      summary: "missing test evidence",
      payload: { summary: "missing test evidence", changedFiles: ["src/a.ts"], knownRisks: "none" },
      actorSessionId: "implementer-session",
      now: 2,
      evidence: [{ kind: "commit", ref: "c1" }, { kind: "diff", ref: "d1" }],
    }),
    (error) => error instanceof GraphRuntimeError && error.code === "handoff_invalid",
  );

  // non-evaluator forging PASS (wrong actor, then wrong evaluator role)
  runtime = startLoop(runtime, currentTeam, loopContract, { actorSessionId: "driver", loopInstanceId: "loop-forge", now: 3, evidence: ALL_LOOP_EVIDENCE }).runtime;
  runtime = startAttempt(runtime, currentTeam, loopContract, { loopInstanceId: "loop-forge", actorSessionId: "driver", participantRoleId: "implementer", now: 4, evidence: ALL_LOOP_EVIDENCE }).runtime;
  assert.throws(
    () => recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-forge", actorSessionId: "implementer-session", evaluatorRole: "reviewer", verdict: "PASS", now: 5, evidence: VERDICT_EVIDENCE }),
    (error) => error?.code === "evaluator_required",
  );
  assert.throws(
    () => recordVerdict(runtime, currentTeam, loopContract, { loopInstanceId: "loop-forge", actorSessionId: "reviewer-session", evaluatorRole: "implementer", verdict: "PASS", now: 5, evidence: VERDICT_EVIDENCE }),
    (error) => error?.code === "evaluator_required",
  );

  // handoff route mismatch and missing payload field fail loud at the contract level
  assert.throws(
    () => validateHandoffPayload(handoffContract("candidate"), "reviewer", "verifier", "candidate", { summary: "x", changedFiles: [], knownRisks: "" }, CANDIDATE_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );
  assert.throws(
    () => validateHandoffPayload(handoffContract("candidate"), "implementer", "verifier", "candidate", { summary: "x" }, CANDIDATE_EVIDENCE),
    (error) => error?.code === "handoff_invalid",
  );

  // out-of-bounds role references are rejected by the topology validator
  assert.ok(validateTopology({ ...fdTopology, protocol: { ...fdProtocol, handoffs: [{ ...handoffContract("candidate"), from: "ghost" }] } }).some((problem) => /unknown role/.test(problem)));
  assert.ok(validateTopology({ ...fdTopology, protocol: { ...fdProtocol, loops: [{ ...loopContract, participants: ["implementer", "ghost"] }] } }).some((problem) => /unknown role/.test(problem)));
  assert.ok(validateTopology({ ...fdTopology, protocol: { ...fdProtocol, gates: [{ ...gateDefinition, decisionScope: ["role:ghost"] }] } }).some((problem) => /unknown role/.test(problem)));
});

function draftRuntimeContext(options = {}) {
  const known = new Set(["orchestra-v04-implementer-v1", "orchestra-v04-reviewer-v1", "orchestra-v04-verifier-v1", "custom-native"]);
  const fs = {
    async resolve(path, opts = {}) {
      return { key: `${opts.cwd ?? ""}:${path}`, displayPath: `${opts.cwd ?? ""}/${path}` };
    },
    async stat() {
      return undefined;
    },
    async readText() {
      throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
    },
  };
  const permissionSpecs = {
    workspace: { sandbox: "workspace-write", approval: "ask" },
    safe: { sandbox: "read-only", approval: "ask" },
  };
  const permissions = {
    defaultPreset: options.defaultPreset ?? "workspace",
    resolve(name) {
      if (permissionSpecs[name] === undefined) throw new Error(`unknown permission ${name}`);
      return permissionSpecs[name];
    },
  };
  const presets = {
    async resolve(id) {
      if (options.brokenPreset === id) throw new Error(`preset mount failed for ${id}`);
      if (!known.has(id)) throw new Error(`unknown preset ${id}`);
      return { id, trust: "system", path: "" };
    },
  };
  const ctx = {
    fs,
    get(name) {
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      if (name === "agentDefaultModel") return { currentSelection: () => options.model ?? { provider: "default-provider", model: "default-model", reasoningEffort: "medium" } };
      return undefined;
    },
  };
  return ctx;
}

test("draft per-role blueprint pre-parsing mirrors create-time resolution facts and fails loud", async () => {
  const ctx = draftRuntimeContext();

  // catalog preset + explicit topology tools: card shows the effective facts
  const implementer = await preparseDraftRoleFacts(ctx, "/tmp/fd", {
    id: "implementer",
    name: "Implementer",
    preset: "orchestra-v04-implementer-v1",
    sandbox: "workspace-write",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
  });
  assert.equal(implementer.preset, "orchestra-v04-implementer-v1");
  assert.equal(implementer.presetSource, "dsh");
  assert.equal(implementer.sandbox, "workspace-write");
  assert.equal(implementer.permissionPreset, "workspace");
  assert.equal(implementer.effectivePermissionPreset, "workspace");
  assert.equal(implementer.provider, "default-provider");
  assert.equal(implementer.model, "default-model");
  assert.equal(implementer.reasoningEffort, "medium");
  assert.deepEqual(implementer.compositionTools, ["tool-bash", "tool-fs", "tool-fs-search"]);
  assert.deepEqual(implementer.orchestraTools, ["orchestra_report", "orchestra_handoff"]);

  // catalog preset without topology tool lists: falls back to the catalog spec
  const reviewer = await preparseDraftRoleFacts(ctx, "/tmp/fd", { id: "reviewer", name: "Reviewer", preset: "orchestra-v04-reviewer-v1", sandbox: "read-only" });
  assert.equal(reviewer.sandbox, "read-only");
  assert.equal(reviewer.effectivePermissionPreset, "custom");
  assert.deepEqual(reviewer.compositionTools, ["tool-bash", "tool-fs", "tool-fs-search"]);
  assert.deepEqual(reviewer.orchestraTools, ["orchestra_report", "orchestra_verdict", "orchestra_handoff"]);

  // topology runtime override pins provider/model/reasoningEffort through the same seam
  const overridden = await preparseDraftRoleFacts(ctx, "/tmp/fd", { id: "verifier", name: "Verifier", preset: "orchestra-v04-verifier-v1", sandbox: "read-only", runtime: { provider: "p", model: "m", reasoningEffort: "low" } });
  assert.equal(overridden.provider, "p");
  assert.equal(overridden.model, "m");
  assert.equal(overridden.reasoningEffort, "low");

  // DSH-native preset with no static tool proof: accepted with empty lists (same as create)
  const native = await preparseDraftRoleFacts(ctx, "/tmp/fd", { id: "custom", name: "Custom", preset: "custom-native" });
  assert.deepEqual(native.compositionTools, []);
  assert.deepEqual(native.orchestraTools, []);

  // fail loud: role without a preset
  await assert.rejects(preparseDraftRoleFacts(ctx, "/tmp/fd", { id: "x", name: "X" }), /requires an explicit complete Agent Preset/);
  // fail loud: unresolvable preset
  await assert.rejects(preparseDraftRoleFacts(ctx, "/tmp/fd", { id: "x", name: "X", preset: "no-such-preset" }), /not found|preset/i);
  // fail loud: broken preset resolution
  const brokenCtx = draftRuntimeContext({ brokenPreset: "broken-preset" });
  await assert.rejects(preparseDraftRoleFacts(brokenCtx, "/tmp/fd", { id: "x", name: "X", preset: "broken-preset" }), /could not be resolved|unavailable/i);
});
