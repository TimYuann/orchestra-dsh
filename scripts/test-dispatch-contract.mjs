/**
 * First-batch dispatch-contract acceptance (plan §7.1 counterexamples 1, 2, 5, 7
 * plus the §7.1 "tool can write but has no action authority" clause).
 *
 * WHAT THIS FILE IS ALLOWED TO PROVE (plan §7.1, Reviewer Q4):
 *
 *   * it proves "no blind second dispatch record" and "no double bookkeeping";
 *   * it does NOT prove "the worker never receives the same text twice" — §5.2
 *     explicitly refuses that claim for the first batch, because the receiver
 *     has no claim/dedupe point of its own yet;
 *   * "the ledger does not double-count" is not "the report file bytes are never
 *     rewritten" (§5.3): the report file write stays unconditional.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bookRoleReport, dispatchRoleTask } from "../lib/orchestra.js";
import { normalizeTeam } from "../lib/orchestra-state.js";
import { dispatchBoardText, dispatchLedgerRows, handoffNoticeRows } from "../lib/orchestra-dispatch.js";
import { CWD, dispatchArgs, makeHarness, newGovernedTeam } from "./test-dispatch-harness.mjs";

const WORKER = { id: "worker", name: "Worker", preset: "preset-worker", sandbox: "workspace-write" };
const WORKER_B = { id: "worker-b", name: "Worker B", preset: "preset-worker", sandbox: "workspace-write" };

async function teamOf(harness) {
  const observation = await harness.store.read(CWD);
  assert.equal(observation.kind, "ready");
  return observation.team;
}

function dispatchesFor(team, roleId) {
  return (team.dispatches ?? []).filter((entry) => entry.roleId === roleId);
}

test("E1/r1: one intent is one dispatch record — same id + same content reuses, same id + different content conflicts, a new id is a new intent", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER, WORKER_B], "draft-r1");

  const first = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "fix the defect", dispatchId: "d-1" }),
  );
  assert.equal(first.status, "dispatched");
  assert.equal(first.dispatch_id, "d-1");
  assert.equal(first.binding_revision, 1, "the first batch pins bindingRevision to 1");
  assert.match(first.payload_digest, /^[0-9a-f]{64}$/, "payloadDigest is computed by the tool, not reported by the caller");

  const recorded = dispatchesFor(await teamOf(h), "worker");
  assert.equal(recorded.length, 1, "exactly one dispatch record exists for one intent");
  assert.equal(recorded[0].payloadDigest, first.payload_digest);
  assert.equal(recorded[0].subjects.initiatingSessionId, "driver-1", "the initiating session is recorded by the runtime");
  assert.equal(recorded[0].subjects.resultRecipientSessionId, "driver-1");
  assert.equal(recorded[0].delegation.charterRef, frozen);
  assert.equal(recorded[0].delegation.authorityRef, frozen);
  assert.equal(recorded[0].delivery.state, "delivered", "a materializing dispatch records the confirmed delivery");
  assert.ok(
    typeof recorded[0].delivery.idempotencyKey === "string" && recorded[0].delivery.idempotencyKey !== "",
    "the guaranteed delivery carries an idempotency credential",
  );
  const receipts = [...h.fs.files.keys()].filter((key) => key.includes("/orchestra/receipts/"));
  assert.equal(receipts.length, 1, "the guaranteed delivery left a queryable durable receipt (that is what 'confirmed' means)");

  const replay = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "fix the defect", dispatchId: "d-1" }),
  );
  assert.equal(replay.status, "reused");
  assert.equal(replay.payload_digest, first.payload_digest);
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 1, "a same-id retry must not add a second record");
  assert.equal(replay.created_new_session, false);

  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: h.controller },
        dispatchArgs(frozen, { roleId: "worker", task: "a different ask", dispatchId: "d-1" }),
      ),
    /conflict/i,
    "same id with different content must be an explicit conflict",
  );
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 1, "a conflicting call must not add a record");

  // A new id is a legal new intent even when the words are identical. It goes
  // to the second role because the busy rule (E7) owns what ONE role may hold.
  const other = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker-b", task: "fix the defect", dispatchId: "d-2" }),
  );
  assert.equal(other.status, "dispatched", "identity is the dispatch id, not the task text");
  assert.equal(dispatchesFor(await teamOf(h), "worker-b").length, 1);
});

test("E1/r2: concurrent first arrival of one id commits exactly one record", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-r2");
  const args = dispatchArgs(frozen, { roleId: "worker", task: "one intent", dispatchId: "d-race" });

  const results = await Promise.all([
    dispatchRoleTask(h.context, h.store, { agent: h.controller }, { ...args }),
    dispatchRoleTask(h.context, h.store, { agent: h.controller }, { ...args }),
  ]);

  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 1, "the check and the create share one atomic state change");
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["dispatched", "reused"],
    "one call creates, the other observes the created record",
  );
  const workerSessionId = (await teamOf(h)).roles.find((role) => role.id === "worker").sessionId;
  assert.equal(h.a2aMessages(workerSessionId).length, 1, "the same intent is delivered once");
});

test("E2: a delivery that was enqueued but whose receipt write failed is reconciled, never blindly re-dispatched", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e2");
  // Materialize the role and hand the first intent back, so this intent is a
  // plain delivery to a LIVE session — the window the counterexample names.
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "warm up", dispatchId: "d-warmup" }),
  );
  const sessionId = (await teamOf(h)).roles.find((role) => role.id === "worker").sessionId;
  await bookRoleReport(h.context, h.store, { agent: h.agents.get(sessionId) }, {
    path: "warmup.md",
    content: "warmup done",
    dispatchId: "d-warmup",
  });

  const args = dispatchArgs(frozen, { roleId: "worker", task: "land the change", dispatchId: "d-receipt" });
  h.fs.failNextWrite = (path) => path.includes("/orchestra/receipts/");

  const first = await dispatchRoleTask(h.context, h.store, { agent: h.controller }, { ...args });
  assert.equal(first.delivery_state, "unknown", "a failed receipt write is an unknown delivery outcome, not a failed one");
  assert.ok(first.delivery_reason, "the unknown outcome names its reason");
  const recorded = dispatchesFor(await teamOf(h), "worker").filter((entry) => entry.dispatchId === "d-receipt");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].delivery.state, "unknown");

  assert.equal(h.a2aMessages(sessionId).length, 2, "the message did land (one warm-up turn plus this one)");

  const retry = await dispatchRoleTask(h.context, h.store, { agent: h.controller }, { ...args });
  assert.equal(retry.status, "reused");
  assert.equal(retry.delivery_state, "delivered", "reconciliation reads the target's own durable log");
  assert.equal(h.a2aMessages(sessionId).length, 2, "reconciliation must not deliver the same intent again");
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 2, "the warm-up intent plus this one, and no third record");
});

test("E2/b: an unreconcilable delivery stays explicitly unknown and is not re-attempted", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e2b");

  // First intent materializes the role and is handed back, so the role is
  // active and the second intent is a plain delivery to a live session.
  const first = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "first", dispatchId: "d-a" }),
  );
  const workerSessionId = (await teamOf(h)).roles.find((role) => role.id === "worker").sessionId;
  await bookRoleReport(h.context, h.store, { agent: h.agents.get(workerSessionId) }, {
    path: "first.md",
    content: "done",
    dispatchId: "d-a",
  });

  const args = dispatchArgs(frozen, { roleId: "worker", task: "second", dispatchId: "d-b" });
  h.agents.get(workerSessionId).faultyFollowup = true;
  const second = await dispatchRoleTask(h.context, h.store, { agent: h.controller }, { ...args });
  h.agents.get(workerSessionId).faultyFollowup = false;

  assert.equal(second.delivery_state, "unknown");
  assert.equal(h.a2aMessages(workerSessionId).length, 1, "the failed attempt left no message behind");

  const retry = await dispatchRoleTask(h.context, h.store, { agent: h.controller }, { ...args });
  assert.equal(retry.status, "reused");
  assert.equal(retry.delivery_state, "unknown", "with no proof either way the outcome must stay unknown");
  assert.equal(h.a2aMessages(workerSessionId).length, 1, "an unknown outcome is never silently re-dispatched");
  assert.equal(first.delivery_state, "delivered");
});

test("E5: a foreign instance cannot satisfy a dispatch, and an old result cannot satisfy a new task", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e5");
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "the task", dispatchId: "d-old" }),
  );

  const impostor = h.agentFor("impostor-session");
  await assert.rejects(
    async () =>
      bookRoleReport(h.context, h.store, { agent: impostor }, { path: "impostor.md", content: "I did it", dispatchId: "d-old" }),
    /dispatch|session/i,
    "a report from a session that is not the dispatch target must not bind to it",
  );
  const stillOpen = dispatchesFor(await teamOf(h), "worker").find((entry) => entry.dispatchId === "d-old");
  assert.equal(stillOpen.supersededBy, undefined);
  assert.equal(
    (await teamOf(h)).reports.filter((report) => report.dispatchId === "d-old").length,
    0,
    "the impostor's report must not be booked against the dispatch",
  );

  // The real worker hands back, which closes d-old and lets a new intent exist.
  const workerSessionId = (await teamOf(h)).roles.find((role) => role.id === "worker").sessionId;
  const worker = h.agents.get(workerSessionId);
  await bookRoleReport(h.context, h.store, { agent: worker }, { path: "real.md", content: "done", dispatchId: "d-old", outcome: "report" });
  assert.equal((await teamOf(h)).reports.filter((report) => report.dispatchId === "d-old").length, 1);

  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "the new task", dispatchId: "d-new" }),
  );
  // A late report that belongs to the OLD dispatch is still booked (history is
  // kept) and must leave the NEW dispatch undelivered.
  await bookRoleReport(h.context, h.store, { agent: worker }, { path: "late.md", content: "old news", dispatchId: "d-old" });
  const team = await teamOf(h);
  assert.equal(
    team.reports.some((report) => report.dispatchId === "d-new"),
    false,
    "a result bound to an older dispatch cannot satisfy the current one",
  );
  const newer = dispatchesFor(team, "worker").find((entry) => entry.dispatchId === "d-new");
  assert.ok(newer, "the new dispatch record is retained");
});

test("E7: a role with an undelivered dispatch cannot silently receive a second one", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e7");
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "task one", dispatchId: "d-one" }),
  );

  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: h.controller },
        dispatchArgs(frozen, { roleId: "worker", task: "task two", dispatchId: "d-two" }),
      ),
    /undelivered dispatch/i,
    "a busy role gets an explicit result instead of a second undelivered dispatch",
  );
  const blocked = dispatchesFor(await teamOf(h), "worker");
  assert.equal(blocked.length, 1, "no second undelivered dispatch was created");
  assert.equal(blocked[0].dispatchId, "d-one");

  const workerSessionId = (await teamOf(h)).roles.find((role) => role.id === "worker").sessionId;
  await bookRoleReport(h.context, h.store, { agent: h.agents.get(workerSessionId) }, {
    path: "one.md",
    content: "one done",
    dispatchId: "d-one",
  });

  const allowed = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "task two", dispatchId: "d-two" }),
  );
  assert.equal(allowed.status, "dispatched", "a handed-back dispatch releases the role");
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 2);
});

test("E7/b: a dispatch that provably never reached the worker releases the role and is marked superseded", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e7b");
  // Break materialization before any session can exist.
  const originalCreate = h.context.agents.create;
  h.context.agents.create = async () => {
    throw new Error("injected provisioning failure");
  };
  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: h.controller },
        dispatchArgs(frozen, { roleId: "worker", task: "first attempt", dispatchId: "d-fail" }),
      ),
    /could not be brought up/,
  );
  h.context.agents.create = originalCreate;

  const record = dispatchesFor(await teamOf(h), "worker")[0];
  assert.equal(record.delivery.state, "not_delivered");
  assert.equal(record.subjects.materialized, false);

  const retry = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "second attempt", dispatchId: "d-ok" }),
  );
  assert.equal(retry.status, "dispatched");
  const records = dispatchesFor(await teamOf(h), "worker");
  assert.equal(records.length, 2, "the failed intent stays in the ledger");
  assert.equal(records.find((entry) => entry.dispatchId === "d-fail").supersededBy, "d-ok");
  assert.equal(records.find((entry) => entry.dispatchId === "d-ok").delivery.state, "delivered");
});

test("authority: a dispatch without this Team's real frozen charter and approval is refused, and creates nothing", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-auth");

  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: h.controller },
        dispatchArgs(frozen, { roleId: "worker", dispatchId: "d-ref", charterRef: "other-draft@1#deadbeef" }),
      ),
    /charterRef/i,
  );
  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: h.controller },
        dispatchArgs(frozen, { roleId: "worker", dispatchId: "d-ref", authorityRef: "other-draft@1#deadbeef" }),
      ),
    /authorityRef/i,
  );
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 0, "a refused dispatch leaves no record");

  const outsider = h.agentFor("outsider-session");
  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: outsider },
        dispatchArgs(frozen, { roleId: "worker", dispatchId: "d-outsider" }),
      ),
    /controller/i,
    "a session that is not this Team's controller may not dispatch",
  );
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 0);
});

test("authority/b: a method binding whose fixed text is not there with that digest is refused", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-method");
  const method = "# Local defect feedback loop\n\nfixed text\n";
  await h.fs.writeText(await h.fs.resolve(`${CWD}/methods/local-defect-feedback-loop.md`, { cwd: CWD }), method);

  const digest = (await import("node:crypto")).createHash("sha256").update(method).digest("hex");
  const good = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, {
      roleId: "worker",
      dispatchId: "d-method",
      methodBindings: [
        {
          methodId: "local-defect-feedback-loop",
          sourceCommit: "f5d6d0547459eb15c40aec25617418d5ea4710e6",
          contentDigest: digest,
          purpose: "bound the fix loop",
          ref: "methods/local-defect-feedback-loop.md",
        },
      ],
    }),
  );
  assert.equal(good.status, "dispatched");
  const binding = dispatchesFor(await teamOf(h), "worker")[0].methodBindings[0];
  assert.equal(binding.contentVerified, true, "the tool read the fixed text and matched the digest");

  await assert.rejects(
    async () =>
      dispatchRoleTask(
        h.context,
        h.store,
        { agent: h.controller },
        dispatchArgs(frozen, {
          roleId: "worker",
          dispatchId: "d-method-bad",
          methodBindings: [
            {
              methodId: "local-defect-feedback-loop",
              sourceCommit: "f5d6d0547459eb15c40aec25617418d5ea4710e6",
              contentDigest: "0".repeat(64),
              purpose: "bound the fix loop",
              ref: "methods/local-defect-feedback-loop.md",
            },
          ],
        }),
      ),
    /digest/i,
  );
  assert.equal(dispatchesFor(await teamOf(h), "worker").length, 1);
});

test("unsupported backend: a native subagent role is reported as unsupported, never as a guaranteed delivery", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-native");
  // Flip the seat to the native backend AFTER creation (topology validation runs
  // at creation, and this test is about the delivery claim, not the topology).
  await h.store.mutate(
    CWD,
    (team) => ({
      ...team,
      roles: team.roles.map((role) => (role.id === "worker" ? { ...role, execution: "subagent", phase: "active", parentSessionId: "driver-1" } : role)),
    }),
    { policy: { kind: "policy" } },
  );
  const sent = [];
  h.context.get = ((original) => (name) => {
    if (name === "subagents") {
      return {
        async sendMessage(_parent, childId) {
          sent.push(childId);
          return "native-message-1";
        },
      };
    }
    return original(name);
  })(h.context.get.bind(h.context));

  const result = await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "native work", dispatchId: "d-native" }),
  );
  assert.equal(result.status, "unsupported_backend", "the new contract does not pretend the native path carries the guarantee");
  assert.equal(result.delivery_state, "unsupported_backend");
  assert.equal(sent.length, 1, "the task was still delivered to the native child");
  const record = dispatchesFor(await teamOf(h), "worker")[0];
  assert.equal(record.delivery.state, "unsupported_backend");
  assert.match(record.delivery.reason, /native subagent backend/i);
});

test("board and migration: the ledger is what the driver reads, and a legacy team.json still reads", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-board");
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "board task", dispatchId: "d-board" }),
  );
  const team = await teamOf(h);
  const rows = dispatchLedgerRows(team);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].open, true, "an unsettled dispatch is shown as undelivered work");
  assert.equal(rows[0].delivery_state, "delivered");
  assert.match(dispatchBoardText(team), /1 undelivered/);

  const workerSessionId = team.roles.find((role) => role.id === "worker").sessionId;
  const booked = await bookRoleReport(h.context, h.store, { agent: h.agents.get(workerSessionId) }, {
    path: "board.md",
    content: "board done",
    dispatchId: "d-board",
  });
  const after = await teamOf(h);
  assert.equal(dispatchLedgerRows(after)[0].open, false, "a bound report closes the dispatch on the board");
  assert.equal(dispatchLedgerRows(after)[0].report_id, booked.report_id);
  assert.equal(handoffNoticeRows(after).length, 1);
  assert.equal(handoffNoticeRows(after)[0].report_id, booked.report_id);

  // A team.json written before this batch: no dispatches, no notices, and its
  // existing reports stay readable with no invented binding.
  const legacy = normalizeTeam(
    {
      schemaVersion: 1,
      teamId: "team-legacy",
      status: "active",
      rootCwd: CWD,
      controllerSessionId: "driver-1",
      createdAt: 1,
      roles: [{ id: "worker", name: "Worker", sessionId: "s-1", phase: "active", reportCount: 3, lastReport: "/old/report.md" }],
      reports: [{ reportId: "r-1", roleId: "worker", sessionId: "s-1", path: "/old/report.md", createdAt: 2 }],
    },
    CWD,
  );
  assert.equal(legacy.dispatches, undefined, "a legacy record carries no ledger rather than an empty fabrication");
  assert.equal(legacy.handoffNotices, undefined);
  assert.equal(legacy.reports.length, 1);
  assert.equal(legacy.reports[0].dispatchId, undefined, "an unbound historical report stays unbound");
  assert.equal(dispatchLedgerRows(legacy).length, 0);
  assert.match(dispatchBoardText(legacy), /0 total, 0 undelivered/);
});
