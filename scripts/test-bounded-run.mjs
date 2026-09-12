/**
 * Bounded-run semantics: Attempt deadlines, deadline closure, and Loop/Team
 * wall-clock budgets.
 *
 * The point of these tests is that an unattended run can never be stranded by a
 * node that simply stopped, and never be stranded by its own ceiling either: a
 * deadline always leaves the Loop through one of the three exits the frozen
 * charter already declares, and an exhausted Team budget still permits closure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_TOPOLOGIES, validateTopology } from "../lib/orchestra-topology.js";
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  GraphRuntimeError,
  effectiveAttemptTimeoutMs,
  effectiveMaxAttempts,
  expireAttempt,
  graphLoops,
  graphSummary,
  initializeGraphRuntime,
  readGraphRuntime,
  recordClosure,
  recordVerdict,
  startAttempt,
  startLoop,
  sweepBoundedRun,
  teamBudgetExhausted,
} from "../lib/orchestra-graph.js";

/** A Team fixture whose frozen charter carries the given protocol (or none). */
function team(protocol) {
  const topology = protocol === undefined ? undefined : { id: "bounded-topology", source: "bundled", config: { id: "bounded-topology", roles: [], protocol } };
  return {
    schemaVersion: 1,
    teamId: "team-bounded",
    status: "active",
    rootCwd: "/tmp/bounded",
    controllerSessionId: "driver",
    controllerHistory: [],
    topologyRef: { id: "bounded-topology", source: "bundled" },
    mission: { objective: "bounded", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1_000,
    activatedFromArchiveId: null,
    document: {
      currentCharterRevision: 1,
      charterRevisions: [{ charterRevision: 1, digest: "digest", ...(topology === undefined ? {} : { topology }) }],
    },
    roles: [
      { id: "implementer", name: "Implementer", sessionId: "implementer-session", phase: "active", sessionHistory: [], preset: "preset", sandbox: "workspace-write", reportCount: 0, lastReport: null },
      { id: "reviewer", name: "Reviewer", sessionId: "reviewer-session", phase: "active", sessionHistory: [], preset: "preset", sandbox: "read-only", reportCount: 0, lastReport: null },
    ],
    reports: [],
  };
}

function loopContract(overrides = {}) {
  return {
    loopId: "review-loop",
    entry: { role: "implementer", event: "candidate" },
    participants: ["implementer"],
    evaluatorRole: "reviewer",
    candidateKind: "candidate",
    verdictKind: "verdict",
    maxAttempts: 1,
    passRoute: "pass",
    retryRoute: "retry",
    capExhaustedRoute: "driver",
    requiredEvidenceKinds: [],
    ...overrides,
  };
}

/**
 * Open a Loop and (optionally) its first Attempt, with explicit times.
 *
 * `attemptAt: null` means "open no Attempt" — an explicit sentinel rather than
 * `undefined`, because a default parameter would silently substitute a time and
 * quietly start the very Attempt a test means to leave absent.
 */
function opened(currentTeam, contract, { loopAt = 2, attemptAt = 3 } = {}) {
  let runtime = initializeGraphRuntime(currentTeam.teamId, 1, "digest", 1);
  runtime = startLoop(runtime, currentTeam, contract, { actorSessionId: "driver", loopInstanceId: "loop-1", now: loopAt }).runtime;
  if (attemptAt === null) return runtime;
  runtime = startAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", participantRoleId: "implementer", now: attemptAt }).runtime;
  return runtime;
}

test("an Attempt inside its deadline refuses to expire", () => {
  const currentTeam = team();
  const contract = loopContract({ attemptTimeoutMs: 1_000 });
  const runtime = opened(currentTeam, contract, { attemptAt: 3 });
  assert.equal(runtime.events.at(-1).payload.timeoutMs, 1_000, "the Attempt records the ceiling it started under");
  assert.equal(graphLoops(runtime)[0].attempts[0].deadlineAt, 1_003);
  assert.throws(
    () => expireAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 1_002 }),
    (error) => error instanceof GraphRuntimeError && error.code === "timeout_not_reached",
  );
  // A Loop with nothing open has nothing to expire either.
  assert.throws(
    () => expireAttempt(opened(currentTeam, contract, { attemptAt: null }), currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 9_999 }),
    (error) => error.code === "timeout_not_reached",
  );
});

test("reaching the deadline records attempt_expired and completes the Attempt as expired", () => {
  const currentTeam = team();
  const contract = loopContract({ maxAttempts: 3, attemptTimeoutMs: 1_000 });
  const runtime = opened(currentTeam, contract, { attemptAt: 3 });
  const result = expireAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "implementer-session", now: 1_003, reason: "node went quiet" });
  assert.equal(result.kind, "changed");
  assert.deepEqual(result.events.map((event) => event.type), ["attempt_expired", "attempt_completed"]);
  assert.deepEqual(result.events[0].payload, { attempt: 1, deadlineAt: 1_003, expiredAt: 1_003, reason: "node went quiet" });
  assert.deepEqual(result.events[1].payload, { attempt: 1, status: "expired", reason: "node went quiet" });
  const reread = readGraphRuntime(result.runtime, currentTeam.teamId, 1, "digest");
  assert.equal(reread.kind, "ready", reread.kind === "blocked" ? reread.diagnostic.message : reread.kind);
  // The participant Session may end its own Attempt; a verdict is still absent.
  const attempt = graphLoops(result.runtime)[0].attempts[0];
  assert.equal(attempt.status, "expired");
  assert.equal(attempt.verdict, undefined);
  assert.equal(graphLoops(result.runtime)[0].currentDeadlineAt, undefined, "a settled Attempt leaves no open deadline");
});

test("an expired Attempt can be retried, and only FAIL or expiry unlock a retry", () => {
  const currentTeam = team();
  const contract = loopContract({ maxAttempts: 3, attemptTimeoutMs: 1_000 });
  const runtime = opened(currentTeam, contract, { attemptAt: 3 });
  const expired = expireAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 1_003 }).runtime;
  const second = startAttempt(expired, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", participantRoleId: "implementer", now: 1_004 });
  assert.equal(second.kind, "changed");
  assert.equal(graphLoops(second.runtime)[0].attempts.length, 2);

  // An Attempt that is merely started (no verdict, no expiry) is not retryable.
  assert.throws(
    () => startAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", participantRoleId: "implementer", now: 1_004 }),
    (error) => error.code === "attempt_conflict",
  );
});

test("the final Attempt expiring ends the Loop through the same cap the verdict path uses", () => {
  const currentTeam = team();
  const contract = loopContract({ attemptTimeoutMs: 500 });
  const expiredRuntime = opened(currentTeam, contract, { attemptAt: 3 });
  const expired = expireAttempt(expiredRuntime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 503 });
  assert.deepEqual(expired.events.map((event) => event.type), ["attempt_expired", "attempt_completed", "cap_exhausted"]);
  const byDeadline = expired.events.at(-1).payload;
  assert.equal(graphLoops(expired.runtime)[0].status, "cap_exhausted");

  const verdictRuntime = opened(currentTeam, loopContract());
  const byVerdict = recordVerdict(verdictRuntime, currentTeam, loopContract(), { loopInstanceId: "loop-1", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "FAIL", findings: ["unresolved"], now: 4 }).events.at(-1).payload;
  assert.deepEqual(Object.keys(byDeadline).sort(), Object.keys(byVerdict).sort());
  assert.equal(byDeadline.escalation, byVerdict.escalation);
  assert.equal(byDeadline.loopId, byVerdict.loopId);
  assert.equal(byDeadline.evaluatorRole, byVerdict.evaluatorRole);
  assert.equal(byDeadline.attempts, 1);
});

test("the default Attempt ceiling applies to a Loop that declares none", () => {
  const currentTeam = team();
  const contract = loopContract();
  assert.equal(effectiveAttemptTimeoutMs(contract), DEFAULT_ATTEMPT_TIMEOUT_MS);
  const runtime = opened(currentTeam, contract, { attemptAt: 3 });
  assert.equal(graphLoops(runtime)[0].attempts[0].deadlineAt, 3 + DEFAULT_ATTEMPT_TIMEOUT_MS);
  assert.throws(
    () => expireAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 3 + DEFAULT_ATTEMPT_TIMEOUT_MS - 1 }),
    (error) => error.code === "timeout_not_reached",
  );
  assert.equal(expireAttempt(runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 3 + DEFAULT_ATTEMPT_TIMEOUT_MS }).kind, "changed");
});

test("a Loop budget ends the Loop once, through cap_exhausted", () => {
  const protocol = { loops: [loopContract({ maxAttempts: 3, wallClockBudgetMs: 100 })] };
  const currentTeam = team(protocol);
  const contract = protocol.loops[0];
  const runtime = opened(currentTeam, contract, { loopAt: 2, attemptAt: null });
  const swept = sweepBoundedRun(runtime, currentTeam, protocol.loops, 102);
  assert.equal(swept.kind, "changed");
  assert.deepEqual(swept.events.map((event) => event.type), ["budget_exhausted", "cap_exhausted"]);
  assert.deepEqual(swept.events[0].payload, { scope: "loop", loopId: "review-loop", limitMs: 100, consumedMs: 100 });
  assert.equal(swept.events[1].payload.attempts, 0, "a Loop capped before any Attempt ran reports zero honestly");
  assert.equal(graphLoops(swept.runtime)[0].status, "cap_exhausted");
  assert.deepEqual(graphLoops(swept.runtime)[0].budgetExhausted, { limitMs: 100, consumedMs: 100 });

  // Idempotent: the same ceiling is recorded once, and a second sweep is a noop.
  const again = sweepBoundedRun(swept.runtime, currentTeam, protocol.loops, 150);
  assert.equal(again.kind, "noop");
  assert.equal(swept.runtime.events.filter((event) => event.type === "budget_exhausted").length, 1);

  // The new event types survive the runtime's own strict read path: a runtime
  // this milestone wrote must be loadable by the runtime that reads it back.
  const reread = readGraphRuntime(swept.runtime, currentTeam.teamId, 1, "digest");
  assert.equal(reread.kind, "ready", reread.kind === "blocked" ? reread.diagnostic.message : reread.kind);
  assert.deepEqual(graphLoops(reread.runtime)[0].budgetExhausted, { limitMs: 100, consumedMs: 100 });
});

test("a Team budget stops advancement but never stops closure", () => {
  const protocol = { loops: [loopContract({ attemptTimeoutMs: 10_000 })], budgets: { teamWallClockMs: 100 }, closure: { owner: "driver", openGatePolicy: "reject", allowedOutcomes: ["completed", "failed", "abandoned"] } };
  const currentTeam = team(protocol);
  const contract = protocol.loops[0];
  // One Attempt is open across the whole scenario: the Loop must be closable in
  // the end, and closure refuses while a Loop is still running.
  const runtime = opened(currentTeam, contract, { loopAt: 2, attemptAt: 5 });
  const swept = sweepBoundedRun(runtime, currentTeam, protocol.loops, 1_100);
  assert.equal(swept.kind, "changed");
  assert.equal(swept.events.length, 1, "only the Team ceiling is due here; the Attempt is still inside its deadline");
  assert.deepEqual(swept.events[0].payload, { scope: "team", limitMs: 100, consumedMs: 100 });
  assert.equal(teamBudgetExhausted(swept.runtime), true);

  // Advancement is refused, loudly and by code.
  for (const advance of [
    () => startLoop(swept.runtime, currentTeam, contract, { actorSessionId: "driver", now: 1_200 }),
    () => startAttempt(swept.runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", participantRoleId: "implementer", now: 1_200 }),
    () => recordVerdict(swept.runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "reviewer-session", evaluatorRole: "reviewer", verdict: "PASS", now: 1_200 }),
  ]) {
    assert.throws(advance, (error) => error?.code === "budget_exhausted", String(advance));
  }

  // Deadline recording stays available, and it has to: a deadline that has
  // already passed is true regardless of the budget, and closure refuses while a
  // Loop is still running. Gating expiry here would make "closure stays
  // available" impossible at exactly the moment the budget is gone.
  const expired = expireAttempt(swept.runtime, currentTeam, contract, { loopInstanceId: "loop-1", actorSessionId: "driver", now: 20_000 });
  assert.equal(expired.kind, "changed");
  assert.deepEqual(expired.events.map((event) => event.type), ["attempt_expired", "attempt_completed", "cap_exhausted"]);
  assert.equal(graphLoops(expired.runtime)[0].status, "cap_exhausted");

  // ...so the run can still be brought to a terminal outcome.
  const closed = recordClosure(expired.runtime, currentTeam, protocol.closure, { outcome: "abandoned", actorSessionId: "driver", reason: "team budget exhausted", now: 20_100, evidence: [{ kind: "report", ref: "budget-exhausted.md" }] });
  assert.equal(closed.accepted, true);
  assert.equal(graphSummary(closed.runtime).closure.status, "recorded");
  assert.equal(graphSummary(closed.runtime).teamBudgetExhausted, true, "the exhausted budget stays on the record after closure");
});

test("sweeping twice in the same instant is a noop and never duplicates a fact", () => {
  const protocol = { loops: [loopContract({ maxAttempts: 2, attemptTimeoutMs: 10, wallClockBudgetMs: 1_000 })] };
  const currentTeam = team(protocol);
  const contract = protocol.loops[0];
  const runtime = opened(currentTeam, contract, { loopAt: 2, attemptAt: 3 });
  const first = sweepBoundedRun(runtime, currentTeam, protocol.loops, 13);
  assert.equal(first.kind, "changed");
  assert.deepEqual(first.events.map((event) => event.type), ["attempt_expired", "attempt_completed"]);
  const second = sweepBoundedRun(first.runtime, currentTeam, protocol.loops, 13);
  assert.deepEqual(second, { kind: "noop", runtime: first.runtime, events: [] });
});

test("bounded-run contract fields are validated rather than silently ignored", () => {
  // A complete topology, not just roles plus a Loop: P9 requires every declared
  // node to be referenced and P6 requires a completion authority, so a fixture
  // that declared roles and nothing else would fail those before reaching the
  // bounded-run rules under test.
  const base = {
    schemaVersion: 1,
    id: "bounded",
    roles: [{ id: "implementer", name: "Implementer" }, { id: "reviewer", name: "Reviewer" }],
    protocol: {
      ownership: { implementation: "implementer", review_verdict: "reviewer" },
      completion: { owner: "reviewer", rule: "done" },
    },
  };
  const withLoop = (loop) => ({ ...base, protocol: { ...base.protocol, loops: [loopContract(loop)] } });
  assert.deepEqual(validateTopology(withLoop({ maxAttempts: 5, attemptTimeoutMs: 1_000, wallClockBudgetMs: 60_000, maxTotalAttempts: 3, stallGraceMs: 500 })), []);
  assert.ok(validateTopology(withLoop({ attemptTimeoutMs: 0 })).some((problem) => /attemptTimeoutMs must be a positive safe integer/.test(problem)));
  assert.ok(validateTopology(withLoop({ wallClockBudgetMs: 1.5 })).some((problem) => /wallClockBudgetMs must be a positive safe integer/.test(problem)));
  assert.ok(validateTopology(withLoop({ maxTotalAttempts: 4 })).some((problem) => /may only narrow the Attempt ceiling/.test(problem)));
  assert.ok(validateTopology(withLoop({ attemptTimeoutMs: 100, stallGraceMs: 900 })).some((problem) => /stall projection could never fire/.test(problem)));
  assert.ok(validateTopology({ ...base, protocol: { ...base.protocol, budgets: { teamWallClockMs: -1 } } }).some((problem) => /teamWallClockMs must be a positive safe integer/.test(problem)));
  assert.deepEqual(validateTopology({ ...base, protocol: { ...base.protocol, budgets: { teamWallClockMs: 60_000 } } }), []);
  assert.equal(effectiveMaxAttempts({ maxAttempts: 5, maxTotalAttempts: 2 }), 2);
  assert.equal(effectiveMaxAttempts({ maxAttempts: 5 }), 5);
});

test("every shipped topology still validates and keeps its current ceilings", () => {
  for (const topology of BUILTIN_TOPOLOGIES) {
    assert.deepEqual(validateTopology(topology), [], `${topology.id} must stay valid`);
    for (const contract of topology.protocol?.loops ?? []) {
      // The nine shipped topologies declare no bounded-run fields, so the
      // runtime defaults are exactly what they run under: no behaviour change.
      assert.equal(contract.attemptTimeoutMs, undefined);
      assert.equal(contract.wallClockBudgetMs, undefined);
      assert.equal(contract.maxTotalAttempts, undefined);
    }
  }
});

test("a runtime written before these fields existed still reads and projects", () => {
  const currentTeam = team();
  const contract = loopContract();
  const runtime = opened(currentTeam, contract, { attemptAt: 3 });
  // Strip the fields this milestone added, simulating a v0.4-era log.
  const legacy = {
    ...runtime,
    events: runtime.events.map((event) => {
      if (event.type !== "attempt_started" && event.type !== "loop_started") return event;
      const payload = { ...event.payload };
      delete payload.timeoutMs;
      delete payload.effectiveMaxAttempts;
      return { ...event, payload };
    }),
  };
  const loops = graphLoops(legacy);
  assert.equal(loops[0].effectiveMaxAttempts, loops[0].maxAttempts, "an absent narrowing means the declared cap is the enforced one");
  assert.equal(loops[0].attempts[0].deadlineAt, 3 + DEFAULT_ATTEMPT_TIMEOUT_MS, "an absent timeout falls back to the deployment ceiling");
  assert.equal(graphSummary(legacy).expiredAttempts, 0);
  assert.equal(graphSummary(legacy).teamBudgetExhausted, false);
});
