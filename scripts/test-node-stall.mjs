/**
 * Stall detection and the health projection that carries it.
 *
 * Stall is the one unattended failure nobody reports: a node that stopped
 * working looks exactly like a node that is thinking. These tests pin the three
 * -valued contract — `ok`, `stalled`, and `unknown` — because collapsing
 * `unknown` into `ok` is precisely how a dead run passes for a healthy one, and
 * they pin that a Loop's declared `stallGraceMs` actually reaches the verdict
 * rather than sitting in the schema as dead policy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STALL_GRACE_MS, nodeStall } from "../lib/orchestra-graph.js";
import { loopsWithAttemptTiming, nodeIsWorking, openAttemptFor, roleAttemptHealth } from "../lib/orchestra.js";

const NOW = 1_000_000;

function attempt(overrides = {}) {
  return {
    attempt: 1,
    roleId: "implementer",
    sessionId: "session-impl",
    status: "started",
    startedAt: NOW - 10_000,
    deadlineAt: NOW + 20_000,
    evidence: [],
    ...overrides,
  };
}

function loop(overrides = {}) {
  return {
    loopInstanceId: "loop-1",
    loopId: "implementation-review",
    status: "running",
    evaluatorRole: "reviewer",
    maxAttempts: 2,
    effectiveMaxAttempts: 2,
    startedAt: NOW - 60_000,
    attempts: [attempt()],
    capExhausted: false,
    unresolvedFindings: [],
    ...overrides,
  };
}

test("nodeStall answers ok, stalled, and unknown from the facts it is given", () => {
  // No open Attempt: nothing is running, so nothing can be stalled.
  assert.equal(nodeStall({ attempt: undefined, contract: undefined, working: false, lastActivityAt: undefined, now: NOW }), "ok");
  assert.equal(nodeStall({ attempt: attempt({ status: "passed" }), contract: undefined, working: false, lastActivityAt: undefined, now: NOW }), "ok");

  // Working nodes are never stalled, however long the Attempt has run.
  assert.equal(nodeStall({ attempt: attempt(), contract: undefined, working: true, lastActivityAt: NOW - 10 * DEFAULT_STALL_GRACE_MS, now: NOW }), "ok");

  // Unobservable is NOT healthy: with no activity fact there is no evidence the
  // node is alive, so the answer must be "cannot tell", never "ok".
  assert.equal(nodeStall({ attempt: attempt(), contract: undefined, working: false, lastActivityAt: undefined, now: NOW }), "unknown");

  // Silent past the default grace, and silent inside it.
  assert.equal(nodeStall({ attempt: attempt(), contract: undefined, working: false, lastActivityAt: NOW - DEFAULT_STALL_GRACE_MS, now: NOW }), "stalled");
  assert.equal(nodeStall({ attempt: attempt(), contract: undefined, working: false, lastActivityAt: NOW - DEFAULT_STALL_GRACE_MS + 1, now: NOW }), "ok");

  assert.equal(DEFAULT_STALL_GRACE_MS, 60_000, "the default grace is policy and is documented as such");
});

test("a Loop's declared stallGraceMs reaches the verdict instead of sitting in the schema", () => {
  const silentFor = 30_000;
  const observations = { attempt: attempt(), working: false, lastActivityAt: NOW - silentFor, now: NOW };
  assert.equal(nodeStall({ ...observations, contract: undefined }), "ok", `silent ${silentFor}ms is inside the default ${DEFAULT_STALL_GRACE_MS}ms grace`);
  assert.equal(nodeStall({ ...observations, contract: { stallGraceMs: 10_000 } }), "stalled", "a tighter declared grace must be enforced");
  assert.equal(nodeStall({ ...observations, contract: { stallGraceMs: 120_000 } }), "ok", "a looser declared grace must be honored");
});

test("the health projection derives stall and Attempt timing for one role", () => {
  const health = { loops: [loop()], contracts: [{ loopId: "implementation-review", stallGraceMs: 5_000 }], now: NOW };

  const stalled = roleAttemptHealth({ id: "implementer" }, health, { working: false, lastActivityAt: NOW - 9_000 });
  assert.equal(stalled.stall, "stalled");
  assert.deepEqual(stalled.attempt, {
    loopInstanceId: "loop-1",
    loopId: "implementation-review",
    attempt: 1,
    startedAt: NOW - 10_000,
    deadlineAt: NOW + 20_000,
    msRemaining: 20_000,
    expired: false,
  });

  const working = roleAttemptHealth({ id: "implementer" }, health, { working: true, lastActivityAt: NOW - 9_000 });
  assert.equal(working.stall, "ok");

  const unreadable = roleAttemptHealth({ id: "implementer" }, health, { working: false, lastActivityAt: undefined });
  assert.equal(unreadable.stall, "unknown");

  // A role with no open Attempt gets a verdict but no invented timing.
  const idle = roleAttemptHealth({ id: "reviewer" }, health, { working: false, lastActivityAt: NOW });
  assert.equal(idle.stall, "ok");
  assert.equal(idle.attempt, undefined);

  // An Attempt past its deadline is reported as expired rather than hidden.
  const past = roleAttemptHealth({ id: "implementer" }, { ...health, now: NOW + 25_000 }, { working: false, lastActivityAt: NOW + 24_000 });
  assert.equal(past.attempt.expired, true);
  assert.equal(past.attempt.msRemaining, 0, "remaining time never goes negative");
});

test("openAttemptFor matches on the Attempt's own role, and stamps a deadline on every Loop row", () => {
  const loops = [
    loop({ loopInstanceId: "loop-1", attempts: [attempt({ attempt: 1, status: "passed" })] }),
    loop({ loopInstanceId: "loop-2", attempts: [attempt({ attempt: 2, roleId: "verifier", sessionId: "session-ver" })] }),
  ];
  // The newest open Attempt wins, and only for the role that owns it.
  assert.deepEqual(
    openAttemptFor(loops, "verifier"),
    { loopId: "implementation-review", loopInstanceId: "loop-2", attempt: loops[1].attempts[0] },
  );
  assert.equal(openAttemptFor(loops, "implementer"), undefined, "a settled Attempt is not an open one");

  const timed = loopsWithAttemptTiming([loop({ currentDeadlineAt: NOW + 5_000 }), loop({ loopInstanceId: "loop-3" })], NOW);
  assert.equal(timed[0].currentDeadlineMsRemaining, 5_000);
  assert.equal(timed[0].currentDeadlineExpired, false);
  assert.equal(timed[1].currentDeadlineMsRemaining, undefined, "a Loop without an open Attempt gains no timing");

  const overdue = loopsWithAttemptTiming([loop({ currentDeadlineAt: NOW - 1 })], NOW);
  assert.equal(overdue[0].currentDeadlineExpired, true, "a deadline that has passed is distinguishable from no deadline");
  assert.equal(overdue[0].currentDeadlineMsRemaining, 0);
});

test("nodeIsWorking counts a running turn and parked inbox work, but not a cold node", () => {
  assert.equal(nodeIsWorking(undefined), false, "a role that is not loaded is not working");
  assert.equal(nodeIsWorking({ status: "idle" }), false);
  assert.equal(nodeIsWorking({ status: "running" }), true);
  assert.equal(nodeIsWorking({ status: "idle", inbox: { nextTurn: [{}] } }), true, "accepted work awaiting its turn is not a stall");
  assert.equal(nodeIsWorking({ status: "idle", inbox: { nextStep: [{}] } }), true);
  assert.equal(nodeIsWorking({ status: "idle", inbox: { nextTurn: [], nextStep: [] } }), false);
});

test("a notice failure is recorded on the Team, never as an invented graph node", async () => {
  // The Team record and the graph log are different ledgers. The graph log
  // requires every event to name a nodeId or a loopInstanceId, so a delivery
  // failure has no honest place there. This pins the two behaviors D4 depends
  // on: the recorder appends a bounded breadcrumb to the Team, and a malformed
  // breadcrumb is dropped by the reader instead of making the Team unreadable.
  const { NOTICE_FAILURE_LIMIT, normalizeTeam } = await import("../lib/orchestra-state.js");
  const { noticeRecorderFor } = await import("../lib/orchestra.js");
  assert.ok(NOTICE_FAILURE_LIMIT > 0);

  const rawTeam = (noticeFailures) => ({
    schemaVersion: 2,
    teamId: "team-1",
    status: "active",
    rootCwd: "/tmp/x",
    controllerSessionId: "driver-session",
    controllerHistory: [],
    topologyRef: { id: "duo", source: "bundled" },
    mission: { objective: "o", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    roles: [],
    reports: [],
    ...(noticeFailures === undefined ? {} : { noticeFailures }),
  });

  const good = { milestone: "verdict", targetSessionId: "driver-session", failedAt: 5, reason: "transport down" };
  const normalized = normalizeTeam(rawTeam([good, { milestone: 7, targetSessionId: "d", failedAt: 6, reason: "malformed" }, null]), "/tmp/x");
  assert.deepEqual(normalized.noticeFailures, [good], "a malformed breadcrumb is dropped and the readable one survives");
  assert.deepEqual(normalizeTeam(rawTeam(undefined), "/tmp/x").noticeFailures, [], "a Team from before this field existed reads as having none");

  // The recorder appends through CAS and keeps the list bounded.
  const writes = [];
  const existing = Array.from({ length: NOTICE_FAILURE_LIMIT }, (_unused, index) => ({
    milestone: "report",
    targetSessionId: "driver-session",
    failedAt: index,
    reason: "old",
  }));
  const observed = { kind: "ready", cwd: "/tmp/x", team: { ...rawTeam(existing), noticeFailures: existing } };
  const store = {
    async read() {
      return observed;
    },
    async replace(snapshot, team) {
      writes.push(team);
      return { operation: "replaced", state: team, version: 2, statePath: "p" };
    },
  };
  const ctx = { sandboxPolicy: { resolve: () => ({}) } };
  const recorder = noticeRecorderFor(ctx, store, "/tmp/x", { agent: undefined, signal: undefined });
  await recorder({ milestone: "close", targetSessionId: "driver-session", failedAt: 999, reason: "transport down" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].noticeFailures.length, NOTICE_FAILURE_LIMIT, "the list is bounded");
  assert.equal(writes[0].noticeFailures.at(-1).milestone, "close", "the newest failure is retained");
  assert.equal(writes[0].noticeFailures[0].failedAt, 1, "the oldest failure is dropped first");

  // A Team that cannot be read is reported, not silently skipped.
  await assert.rejects(
    () => noticeRecorderFor(ctx, { read: async () => ({ kind: "blocked", cwd: "/tmp/x", warnings: [], diagnostic: { code: "invalid_json", message: "bad" } }) }, "/tmp/x", { agent: undefined })(good),
    /active Team state is blocked/,
  );
});
