/**
 * Stall detection: the health projection that carries it, and the S4 runtime
 * guard that now produces it from FIRST-HAND signals.
 *
 * Stall is the one unattended failure nobody reports: a node that stopped
 * working looks exactly like a node that is thinking. These tests pin the three
 * -valued contract — `ok`, `stalled`, and `unknown` — because collapsing
 * `unknown` into `ok` is precisely how a dead run passes for a healthy one, and
 * they pin that a Loop's declared `stallGraceMs` actually reaches the verdict
 * rather than sitting in the schema as dead policy.
 *
 * The S4 half pins the guard's three load-bearing behaviours, each of which was
 * a defect when it was missing:
 *
 *  1. a role closing a turn with nothing handed back is steered ONCE per turn —
 *     the host re-reads the inbox after a steer and runs another step, so
 *     without the per-turn key the same turn would be steered once per step;
 *  2. an `approval/asked` with no `approval/decided` is kept until its answer
 *     arrives and reported to the driver at the boundary, durably when the
 *     notice cannot be delivered;
 *  3. the plugin subscribes to `agent/turn-stopping` and to nothing that
 *     infers liveness — `agent/status` in particular is gone, because a
 *     `running -> idle` transition says nothing about whether a role delivered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_STALL_GRACE_MS, nodeStall } from "../lib/orchestra-graph.js";
import {
  apply as applyOrchestra,
  createRoleTurnGuard,
  handedBackThisTurn,
  loopsWithAttemptTiming,
  nodeIsWorking,
  noticeRecorderFor,
  notifyDriverMilestone,
  openAttemptFor,
  roleAttemptHealth,
} from "../lib/orchestra.js";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(join(REPO, relative), "utf8");
const cwd = "/tmp/orchestra-turn-guard";

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

// ---------------------------------------------------------------------------
// S4 assertion 1 — the empty-turn steer fires once per turn, and only for a turn
// that really handed nothing back.
// ---------------------------------------------------------------------------

/** A live role session double whose log can carry tool calls. */
function sessionDouble(id, cwd, events = []) {
  return {
    id,
    header: { id, cwd },
    events,
    snapshotEvents() {
      return this.events;
    },
  };
}

/** An agent double carrying the members the guard reads. */
function agentDouble(id, cwd, overrides = {}) {
  return {
    id,
    session: sessionDouble(id, cwd),
    inbox: { hasPending: false },
    ...overrides,
  };
}

/** A ready Team observation with one governed role on the given session. */
function readyTeam(roleId, sessionId, controllerSessionId = "driver-session") {
  return {
    kind: "ready",
    cwd,
    team: {
      schemaVersion: 2,
      teamId: "team-guard",
      status: "active",
      rootCwd: cwd,
      controllerSessionId,
      controllerHistory: [],
      topologyRef: { id: "duo", source: "bundled" },
      mission: { objective: "o", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
      createdAt: 1,
      activatedFromArchiveId: null,
      roles: [{ id: roleId, name: roleId, sessionId, phase: "active", execution: "session", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 0, lastReport: null }],
      reports: [],
    },
  };
}

function guardHarness(overrides = {}) {
  const steers = [];
  const notices = [];
  const guard = createRoleTurnGuard({
    readTeam: async () => overrides.read ?? readyTeam("reviewer", "role-session"),
    steer: (agent, text) => steers.push({ sessionId: agent.id, text }),
    notifyDriver: async (team, sessionId, detail) => notices.push({ teamId: team.teamId, sessionId, detail }),
    now: () => NOW,
  });
  return { guard, steers, notices };
}

test("S4 1: a role closing its turn empty is steered once for that turn, and once only", async () => {
  const { guard, steers } = guardHarness();
  const agent = agentDouble("role-session", cwd);

  await guard.onTurnStopping({ agent, turn: 1 });
  await guard.onTurnStopping({ agent, turn: 1 });
  assert.equal(steers.length, 1, "the same turn must not be steered twice — the host reruns a step after a steer, which re-enters this boundary with the same turn number");
  assert.match(steers[0].text, /closing this turn without handing anything back/, "the steer says what is wrong");
  assert.match(steers[0].text, /orchestra_report/, "the steer names the durable channel rather than asking for 'something'");

  // A later turn is a new opportunity: the key is per turn, not per session.
  await guard.onTurnStopping({ agent, turn: 2 });
  assert.equal(steers.length, 2, "a new turn may be steered again");

  // A role that DID hand something back inside this turn is left alone.
  const busy = agentDouble("role-session", cwd, {
    session: sessionDouble("role-session", cwd, [{ type: "tool/call", data: { turn: 3, name: "orchestra_report" } }]),
  });
  await guard.onTurnStopping({ agent: busy, turn: 3 });
  assert.equal(steers.length, 2, "a turn that filed a report is not a stall");

  // A role with pending input is already being woken.
  const pending = agentDouble("role-session", cwd, { inbox: { hasPending: true } });
  await guard.onTurnStopping({ agent: pending, turn: 4 });
  assert.equal(steers.length, 2, "pending inbox work IS a wake-up; steering on top of it would double the work");

  // The controller is never steered: it is the one asking.
  const driverAgent = agentDouble("driver-session", cwd);
  await guard.onTurnStopping({ agent: driverAgent, turn: 5 });
  assert.equal(steers.length, 2, "the driver's own turns are not the driver's problem");

  // A session that is not a governed role of this Team is nobody's business.
  const stranger = agentDouble("someone-else", cwd);
  await guard.onTurnStopping({ agent: stranger, turn: 6 });
  assert.equal(steers.length, 2, "a session with no role record is not steered");

  // No turn number means the host did not tell us which turn is closing, and a
  // steer without a turn key could not be deduplicated.
  const noTurn = agentDouble("role-session", cwd);
  await guard.onTurnStopping({ agent: noTurn });
  assert.equal(steers.length, 2, "without a turn number there is nothing to deduplicate on, so nothing is sent");
});

test("S4 1b: handedBackThisTurn reads the turn stamp, not a scan for the last turn/start", () => {
  // The host stamps every tool/call with the turn it belongs to, so "this turn"
  // is exact. A role that handed off in turn 1 and is closing turn 9 empty has
  // handed nothing back in turn 9.
  const agent = agentDouble("role-session", cwd, {
    session: sessionDouble("role-session", cwd, [
      { type: "turn/start", data: { turn: 1 } },
      { type: "tool/call", data: { turn: 1, name: "a2a_reply" } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      { type: "turn/start", data: { turn: 9 } },
    ]),
  });
  assert.equal(handedBackThisTurn(agent, 1), true);
  assert.equal(handedBackThisTurn(agent, 9), false, "an earlier turn's handoff does not excuse this one");
  assert.equal(handedBackThisTurn(agent, undefined), true, "with no turn given, any handoff counts — the caller must not ask this without a turn");
  assert.equal(handedBackThisTurn(agentDouble("role-session", cwd), 9), false, "a session with no log has handed nothing back");
});

// ---------------------------------------------------------------------------
// S4 assertion 2 — the approval watchdog: kept until answered, reported at the
// boundary, durable when the notice cannot be delivered.
// ---------------------------------------------------------------------------

test("S4 2: an approval question is held until its own decided arrives", () => {
  const { guard, notices } = guardHarness();
  guard.noteApprovalEvent({ id: "role-session" }, { type: "approval/asked", data: { id: "ask-1", toolName: "bash" } });
  assert.deepEqual(guard.pendingApprovals(), [{ id: "ask-1", sessionId: "role-session", toolName: "bash", askedAt: NOW }]);

  // A decided for a DIFFERENT request reconciles nothing: pairing is by id, and
  // an answer to another question is not an answer to this one.
  guard.noteApprovalEvent({ id: "role-session" }, { type: "approval/decided", data: { id: "ask-other", outcome: "rejected" } });
  assert.equal(guard.pendingApprovals().length, 1, "another request's answer must not close this one");

  // Unrelated events are not approval events.
  guard.noteApprovalEvent({ id: "role-session" }, { type: "user/message", data: { id: "ask-1" } });
  assert.equal(guard.pendingApprovals().length, 1, "only the two approval event types are read");

  guard.noteApprovalEvent({ id: "role-session" }, { type: "approval/decided", data: { id: "ask-1", outcome: "unavailable" } });
  assert.deepEqual(guard.pendingApprovals(), [], "its own answer closes it — `unavailable` is an answer too, and it ends the turn");
  assert.deepEqual(notices, [], "a question that was answered is not reported");
});

test("S4 2b: a dangling approval is reported to the driver at the turn boundary", async () => {
  const { guard, notices } = guardHarness();
  guard.noteApprovalEvent({ id: "role-session" }, { type: "approval/asked", data: { id: "ask-1", toolName: "bash" } });
  // The role handed its report back in this very turn, so the steer stays quiet
  // and only the watchdog speaks: a parked approval is not made harmless by a
  // report.
  const agent = agentDouble("role-session", cwd, {
    session: sessionDouble("role-session", cwd, [{ type: "tool/call", data: { turn: 7, name: "orchestra_report" } }]),
  });
  await guard.onTurnStopping({ agent, turn: 7 });

  assert.equal(notices.length, 1, "one notice per dangling question");
  assert.equal(notices[0].teamId, "team-guard");
  assert.equal(notices[0].sessionId, "role-session");
  assert.match(notices[0].detail, /ask-1/, "the notice names the request");
  assert.match(notices[0].detail, /never decided/, "the notice says what is wrong");

  // The boundary fires again on the step the host runs afterwards; the question
  // is still unanswered, so it is reported again rather than forgotten.
  await guard.onTurnStopping({ agent, turn: 7 });
  assert.equal(notices.length, 2, "an unanswered question keeps being reported until it is answered");
});

test("S4 2c: an undeliverable dangling-approval notice lands durably on the Team", async () => {
  // The notice chain is the one every milestone notice uses: deliver, and if
  // that fails, record it on the Team (`noticeFailures`) so "the driver was
  // never told" stops being invisible. No new Team field, and no step throws.
  const writes = [];
  const team = readyTeam("reviewer", "role-session").team;
  const store = {
    async read() {
      return { kind: "ready", cwd, team };
    },
    async replace(_snapshot, next) {
      writes.push(next);
      return { operation: "replaced", state: next, version: 2, statePath: "p" };
    },
  };
  const ctx = { sandboxPolicy: { resolve: () => ({}) } };
  const notifyDriver = async (current, sessionId, detail) =>
    notifyDriverMilestone(ctx, current, sessionId, "stalled", detail, {
      deliver: async () => {
        throw new Error("transport down");
      },
      recordFailure: noticeRecorderFor(ctx, store, cwd, {}),
    });
  const failing = createRoleTurnGuard({
    readTeam: async () => ({ kind: "ready", cwd, team }),
    steer: () => {},
    notifyDriver,
    now: () => NOW,
  });
  failing.noteApprovalEvent({ id: "role-session" }, { type: "approval/asked", data: { id: "ask-9", toolName: "bash" } });
  await failing.onTurnStopping({ agent: agentDouble("role-session", cwd), turn: 1 });

  assert.equal(writes.length, 1, "the failed notice is recorded once");
  assert.equal(writes[0].noticeFailures.length, 1);
  assert.equal(writes[0].noticeFailures[0].milestone, "stalled");
  assert.match(writes[0].noticeFailures[0].reason, /transport down/, "the recorded reason is the delivery failure");
});

// ---------------------------------------------------------------------------
// S4 assertion 3 — the plugin subscribes to the first-hand boundary and to no
// liveness inference.
// ---------------------------------------------------------------------------

test("S4 3: the plugin subscribes to agent/turn-stopping and to no agent/status listener", async () => {
  // Runtime half: drive the real `apply` with a recording context and read back
  // the event names it subscribed to.
  const root = await mkdtemp(join(tmpdir(), "orchestra-turn-guard-apply-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const listeners = [];
  try {
    applyOrchestra({
      fs: {},
      tools: { register: () => {} },
      get: () => undefined,
      effect: () => () => {},
      on: (name) => {
        listeners.push(name);
        return () => {};
      },
    });
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    // `apply` installs the catalog artifacts into the scratch home detached, so
    // give that write chain a moment to finish before the directory is removed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }

  assert.ok(listeners.includes("agent/turn-stopping"), "the awaited turn boundary is subscribed");
  assert.ok(listeners.includes("session/event"), "the approval audit pair arrives as session events");
  assert.equal(listeners.filter((name) => name === "agent/status").length, 0, "no listener infers liveness from agent/status");

  // Source half: the inference is not merely unsubscribed, it is gone. A
  // `runningRoles` set or a status fold left behind would be a second
  // implementation of the same idea.
  const orchestra = await read("src/orchestra.ts");
  const statusSubscriptions = orchestra.split("\n").filter((line) => /ctx\.on\(\s*["']agent\/status["']/.test(line));
  assert.deepEqual(statusSubscriptions, [], "src/orchestra.ts must not subscribe to agent/status");
  const statusFolds = orchestra.split("\n").filter((line) => /["']agent\/status["']/.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
  assert.deepEqual(statusFolds, [], "no agent/status reference survives outside prose");
  assert.equal(/runningRoles/.test(orchestra), false, "the running->idle bookkeeping is gone with it");
});
