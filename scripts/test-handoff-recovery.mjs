/**
 * First-batch handoff/recovery acceptance (plan §7.1 counterexamples 3, 4, 6).
 *
 * The three judgments of §5.3 are kept separate here on purpose:
 *
 *   1. the worker fulfilled its submission duty — a result (or an explicit
 *      block) is COMMITTED in the Team ledger, bound to this dispatch;
 *   2. the receiver accepted the notice — the handoff notice's own delivery
 *      state, which may legitimately stay pending;
 *   3. the driver processed the result — the notice message's own lifecycle,
 *      which this plugin does not infer from anything else.
 *
 * Only judgment 1 governs the turn-stop steer. A committed report whose notice
 * is still pending — the driver merely unreachable — must NOT re-steer the
 * worker into producing the same report again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateArchivedTeam,
  bookRoleReport,
  createRoleTurnGuard,
  dispatchRoleTask,
  orchestra_dismiss,
  reconcileHandoffNotices,
} from "../lib/orchestra.js";
import { CWD, dispatchArgs, makeHarness, newGovernedTeam } from "./test-dispatch-harness.mjs";

const WORKER = { id: "worker", name: "Worker", preset: "preset-worker", sandbox: "workspace-write" };

async function teamOf(harness) {
  const observation = await harness.store.read(CWD);
  assert.equal(observation.kind, "ready");
  return observation.team;
}

async function workerFor(harness) {
  const team = await teamOf(harness);
  return harness.agents.get(team.roles.find((role) => role.id === "worker").sessionId);
}

function guardFor(harness, steers) {
  return createRoleTurnGuard({
    readTeam: (cwd) => harness.store.read(cwd),
    steer: (_agent, text) => steers.push(text),
    notifyDriver: async () => {},
  });
}

test("E3: the commit point is the CAS — a fault between it and the notice leaves locatable, single-booked facts; a restart re-attaches them", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e3");
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "fix the defect", dispatchId: "d-1" }),
  );
  const worker = await workerFor(h);

  // The driver cannot be reached at the moment of the report: the file write and
  // the CAS both happen, the notice delivery does not.
  h.controller.faultyFollowup = true;
  const booked = await bookRoleReport(h.context, h.store, { agent: worker }, {
    path: "fix.md",
    content: "the defect is fixed\n",
    dispatchId: "d-1",
  });
  assert.equal(booked.dispatch_id, "d-1");
  assert.equal(booked.notice_delivery, "pending", "the notice is a pending fact, not a lost one");

  let team = await teamOf(h);
  assert.equal(team.reports.length, 1, "the report index committed");
  assert.equal(team.handoffNotices.length, 1, "the pending-notice fact entered the SAME TeamState change");
  const notice = team.handoffNotices[0];
  assert.equal(notice.reportId, booked.report_id);
  assert.equal(notice.state, "pending");
  assert.equal(team.noticeFailures.length, 1, "the failure stays a bounded diagnostic breadcrumb");
  assert.equal(notice.dispatchId, "d-1");
  assert.equal(notice.outcome, "report");

  // Replaying the identical submission is idempotent: same reportId → no second
  // index entry and no second pending fact.
  const replay = await bookRoleReport(h.context, h.store, { agent: worker }, {
    path: "fix.md",
    content: "the defect is fixed\n",
    dispatchId: "d-1",
  });
  assert.equal(replay.booked, false, "a replay is not booked twice");
  assert.equal(replay.report_id, booked.report_id);
  team = await teamOf(h);
  assert.equal(team.reports.length, 1);
  assert.equal(team.handoffNotices.length, 1);

  // Restart: durable bytes survive, every live object does not.
  const restarted = makeHarness({ fs: h.fs });
  const observed = await restarted.store.read(CWD);
  assert.equal(observed.kind, "ready");
  const pending = observed.team.handoffNotices.filter((entry) => entry.state === "pending");
  assert.equal(pending.length, 1, "the unfinished step is locatable after a restart");
  assert.equal(observed.team.reports.length, 1);

  const delivered = await reconcileHandoffNotices(restarted.context, restarted.store, observed, { agent: restarted.controller });
  assert.equal(delivered, 1, "the restart re-attaches the pending handoff");
  const after = await restarted.store.read(CWD);
  assert.equal(after.team.handoffNotices[0].state, "delivered");
  assert.equal(after.team.reports.length, 1, "recovery must not double-book the report");
  const texts = restarted.textsFor("driver-1");
  assert.equal(texts.length, 1);
  assert.match(texts[0], /fix\.md/, "the driver is told which report exists");

  // Re-running the sweep is a no-op: an already-accepted notice is not re-sent.
  const again = await reconcileHandoffNotices(restarted.context, restarted.store, after, { agent: restarted.controller });
  assert.equal(again, 0);
  assert.equal(restarted.textsFor("driver-1").length, 1);
});

test("E4: a progress message is not a submission, and a committed report whose notice is pending must not re-steer the worker", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e4");
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", task: "fix the defect", dispatchId: "d-1" }),
  );
  const worker = await workerFor(h);
  const steers = [];
  const guard = guardFor(h, steers);

  // 1. a progress message inside the turn is NOT a handoff while the dispatch is
  //    still undelivered.
  worker.session.append("tool/call", { turn: 1, name: "orchestra_send" });
  await guard.onTurnStopping({ agent: worker, turn: 1 });
  assert.equal(steers.length, 1, "a coordination message cannot stand in for the delivery");
  assert.match(steers[0], /d-1/, "the steer names the dispatch that is still open");

  // 2. a failed report call leaves nothing committed, so the dispatch is still
  //    undelivered.
  await assert.rejects(
    async () => bookRoleReport(h.context, h.store, { agent: worker }, { path: "../escape.md", content: "nope", dispatchId: "d-1" }),
    /path/i,
  );
  await guard.onTurnStopping({ agent: worker, turn: 2 });
  assert.equal(steers.length, 2, "a report call that failed to commit is not a submission");

  // 3. the report commits, the notice cannot be delivered: the worker's duty is
  //    fulfilled, so it must NOT be steered again even though the driver is
  //    still unreachable.
  h.controller.faultyFollowup = true;
  const booked = await bookRoleReport(h.context, h.store, { agent: worker }, {
    path: "fix.md",
    content: "fixed",
    dispatchId: "d-1",
  });
  assert.equal(booked.notice_delivery, "pending");
  await guard.onTurnStopping({ agent: worker, turn: 3 });
  assert.equal(steers.length, 2, "judgment 1 (committed submission) is what decides the steer, not the notice");

  const team = await teamOf(h);
  assert.equal(team.handoffNotices[0].state, "pending", "judgment 2 is recorded as its own fact");
  assert.equal(team.reports[0].dispatchId, "d-1");
});

test("E6: an old report does not hide a new undelivered dispatch across archive and restore, and the archive is not a professional closure", async () => {
  const h = makeHarness();
  const frozen = await newGovernedTeam(h, [WORKER], "draft-e6");
  const workerRef = () => dispatchRoleTask(h.context, h.store, { agent: h.controller }, dispatchArgs(frozen, { roleId: "worker", dispatchId: "d-1", task: "first task" }));
  await workerRef();
  const worker = await workerFor(h);

  await bookRoleReport(h.context, h.store, { agent: worker }, { path: "first.md", content: "first done", dispatchId: "d-1" });
  await dispatchRoleTask(
    h.context,
    h.store,
    { agent: h.controller },
    dispatchArgs(frozen, { roleId: "worker", dispatchId: "d-2", task: "second task" }),
  );

  const dismissed = await orchestra_dismiss(h.context, h.store, h.archiveStore, { agent: h.controller }, {
    reason: "window closed",
    summary: "archived for the record",
  });
  const archived = await h.archiveStore.read(CWD, dismissed.archive_id);
  assert.equal(archived.kind, "ready");
  const snapshot = archived.snapshot;
  assert.equal(snapshot.status, "dismissed", "archive is not a second spelling of completed");

  const pendingRow = (snapshot.handoffSummary?.pendingTasks ?? []).find((row) => row.roleId === "worker");
  assert.ok(pendingRow, "the role must still be pending: its NEW dispatch was never handed back");
  assert.deepEqual(pendingRow.openDispatchIds, ["d-2"], "the archive names the undelivered dispatch, not just a report count");
  assert.equal(pendingRow.reportCount, 1, "the old report is visible and still does not close the new task");

  const ledger = snapshot.dispatches ?? [];
  const openInArchive = ledger.filter((entry) => entry.dispatchId === "d-2");
  assert.equal(openInArchive.length, 1, "the dispatch ledger survives the archive");
  assert.equal(snapshot.reports.some((report) => report.dispatchId === "d-2"), false);
  const closureText = JSON.stringify({ summary: snapshot.handoffSummary, status: snapshot.status });
  assert.equal(
    /"(closed|completed|accepted|verified|authorized)"/.test(closureText),
    false,
    "archiving must not claim a professional closure it never performed",
  );

  // Restore: the ledger comes back with the same open work. The worker session
  // is persisted but no longer live — the only shape a real restart produces.
  h.agents.delete(worker.session.id);
  await activateArchivedTeam(h.context, h.store, h.archiveStore, { archiveId: dismissed.archive_id }, { agent: h.controller }, {
    createSession: async () => ({ sessionId: "unused" }),
    resumeAgent: async () => ({}),
    sendRoleWelcome: async (_ctx, _from, toSessionId) => ({ messageId: `welcome-${toSessionId}`, sessionId: toSessionId, acceptedAt: 1 }),
  });
  const restored = await teamOf(h);
  const openAfterRestore = (restored.dispatches ?? []).filter((entry) => entry.dispatchId === "d-2" && entry.supersededBy === undefined);
  assert.equal(openAfterRestore.length, 1, "the new task is still undelivered after restore");
  assert.equal(
    restored.reports.some((report) => report.dispatchId === "d-2"),
    false,
    "restoring must not invent a handback for the open dispatch",
  );
  assert.equal(restored.status, "active");
});

test("tool boundary: the REAL handlers' success values pass their REAL declared schemas", async () => {
  // The failure this pins is not hypothetical: the first live run of this batch
  // made `orchestra_team` return an ERROR instead of the board, because a booked
  // report now carries `dispatchId`/`binding`/`contentHash`/`outcome` and the
  // board's `reports` items were declared with `additionalProperties: false`.
  // DSH validates the returned value, so one undeclared key fails the WHOLE call.
  const { apply: applyOrchestra } = await import("../lib/orchestra.js");
  const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");
  const { snapshotJsonValue } = await import("@deepseek-ai/dsh-util-values");

  const h = makeHarness();
  applyOrchestra(h.context);
  const tool = (name) => {
    const definition = h.toolNamed(name);
    assert.notEqual(definition, undefined, `${name} must be registered`);
    return definition;
  };
  const checkValue = (name, value) => {
    assert.notEqual(snapshotJsonValue(value), undefined, `${name}: value must survive a JSON round trip`);
    const violations = validateJsonSchemaValue(tool(name).output.schema, value, "value");
    assert.deepEqual(violations, [], `${name} returned a value its declared schema rejects`);
  };

  const frozen = await newGovernedTeam(h, [WORKER], "draft-tool-boundary");
  const exec = { agent: h.controller, signal: undefined };

  const dispatched = await tool("orchestra_dispatch").execute(
    dispatchArgs(frozen, { roleId: "worker", dispatchId: "tool-boundary-1" }),
    exec,
  );
  checkValue("orchestra_dispatch", dispatched);

  const workerSessionId = (await h.store.read(CWD)).team.roles.find((role) => role.id === "worker").sessionId;
  const booked = await tool("orchestra_report").execute(
    { path: "tool-boundary.md", content: "boundary", dispatchId: "tool-boundary-1" },
    { agent: h.agents.get(workerSessionId), signal: undefined },
  );
  checkValue("orchestra_report", booked);
  assert.equal(booked.booked, true);

  // The board is the value that broke: an ACTIVE team with a bound report.
  const board = await tool("orchestra_team").execute({}, exec);
  checkValue("orchestra_team", board);
  assert.equal(board.team.reports.length, 1);
  assert.equal(board.team.reports[0].dispatchId, "tool-boundary-1");
  assert.equal(board.team.dispatches.length, 1);
  assert.equal(board.team.handoff_notices.length, 1);

  // D5: the ledger's per-row state must reach the READER, not just the JSON.
  const rendered = tool("orchestra_team")
    .output.render({}, board)
    .map((block) => block.text)
    .join("\n");
  assert.match(rendered, /dispatches: 1 total, 0 undelivered/);
  assert.match(rendered, /- dispatch tool-boundary-1 → role worker \[delivery=delivered\] handed back report=/);
  assert.match(rendered, /handoff notices: 1 total, 0 awaiting the driver/);
  assert.match(rendered, /- notice notice:[0-9a-f]+ → role worker \[state=delivered\] driver=/, "a notice row names its state and the driver's own lifecycle");
  assert.match(rendered, /attempts=\d+/);
  assert.match(rendered, /path=.*tool-boundary\.md/);
});

test("D5: the ledger render stays bounded when the ledger grows", async () => {
  const { BOARD_RENDER_LIMIT, dispatchBoardTextFromRows } = await import("../lib/orchestra-dispatch.js");
  assert.ok(BOARD_RENDER_LIMIT > 0 && BOARD_RENDER_LIMIT < 20, "the bound must be a real bound");

  const many = Array.from({ length: BOARD_RENDER_LIMIT + 4 }, (_, index) => ({
    dispatch_id: `d-${index}`,
    role_id: `role-${index}`,
    delivery_state: "delivered",
    open: index >= 2,
    ...(index < 2 ? { report_id: `r-${index}` } : {}),
    target_session_id: `s-${index}`,
  }));
  const notices = Array.from({ length: BOARD_RENDER_LIMIT + 3 }, (_, index) => ({
    notice_id: `notice:${index}`,
    report_id: `r-${index}`,
    role_id: `role-${index}`,
    state: index < 2 ? "pending" : "delivered",
    attempts: 1,
    path: `orchestra/reports/r-${index}.md`,
  }));

  const text = dispatchBoardTextFromRows(many, notices);
  const lines = text.split("\n");
  const dispatchLines = lines.filter((line) => line.includes("- dispatch "));
  const noticeLines = lines.filter((line) => line.includes("- notice "));
  assert.equal(dispatchLines.length, BOARD_RENDER_LIMIT, "the render lists at most the bound");
  assert.equal(noticeLines.length, BOARD_RENDER_LIMIT);
  assert.ok(dispatchLines.every((line) => line.startsWith("  - ")), "rows are indented under their count line");

  // Unresolved work is shown FIRST. That ordering does NOT guarantee all of it
  // fits: this fixture has 7 open rows against a bound of 5, so 2 open rows ARE
  // truncated — which is exactly why the truncation line counts categories
  // separately instead of reporting one total that would hide it.
  assert.ok(dispatchLines[0].includes("d-2"), `open work must lead: ${dispatchLines[0]}`);
  assert.ok(dispatchLines.every((line) => line.includes("UNDELIVERED")), "the shown rows are all open ones (the closed pair is behind them)");
  assert.ok(noticeLines[0].includes("notice:0"), `awaiting notices must lead: ${noticeLines[0]}`);

  // Truncation is stated PER CATEGORY, and the counts stay complete.
  assert.match(
    text,
    /… 2 open \+ 2 closed not shown \(bounded render; counts above are complete\)/,
    "the hidden dispatch rows must be split into open vs closed",
  );
  assert.match(
    text,
    /… 0 awaiting the driver \+ 3 settled not shown \(bounded render; counts above are complete\)/,
    "the hidden notice rows must be split into awaiting vs settled",
  );
  assert.match(text, new RegExp(`dispatches: ${many.length} total, 7 undelivered`));
  assert.match(text, new RegExp(`handoff notices: ${notices.length} total, 2 awaiting the driver`));

  // A bounded render is bounded in BYTES too, not only in rows.
  const bytesPerRow = text.length / (dispatchLines.length + noticeLines.length);
  assert.ok(bytesPerRow < 400, `one row must stay one short line (got ${bytesPerRow.toFixed(1)} chars/row)`);
});

test("D5: when everything truncated is unresolved, the truncation line says so", async () => {
  const { BOARD_RENDER_LIMIT, dispatchBoardTextFromRows } = await import("../lib/orchestra-dispatch.js");

  // The case the old single total could not express: MORE unresolved rows than
  // the bound, so the hidden tail is entirely open / entirely awaiting.
  const rows = Array.from({ length: BOARD_RENDER_LIMIT + 3 }, (_, index) => ({
    dispatch_id: `open-${index}`,
    role_id: `role-${index}`,
    delivery_state: "delivered",
    open: true,
    target_session_id: `s-${index}`,
  }));
  const notices = Array.from({ length: BOARD_RENDER_LIMIT + 4 }, (_, index) => ({
    notice_id: `notice:open-${index}`,
    report_id: `r-${index}`,
    role_id: `role-${index}`,
    state: "pending",
    attempts: 1,
    path: `orchestra/reports/r-${index}.md`,
  }));

  const text = dispatchBoardTextFromRows(rows, notices);
  assert.match(
    text,
    /… 3 open \+ 0 closed not shown \(bounded render; counts above are complete\)/,
    "an all-open hidden tail must be reported as such, not as a bare total",
  );
  assert.match(
    text,
    /… 4 awaiting the driver \+ 0 settled not shown \(bounded render; counts above are complete\)/,
  );
  assert.match(text, new RegExp(`dispatches: ${rows.length} total, ${rows.length} undelivered`));
  assert.match(text, new RegExp(`handoff notices: ${notices.length} total, ${notices.length} awaiting the driver`));

  // And the render is still bounded: the counts are complete, the detail is not.
  assert.equal(text.split("\n").filter((line) => line.includes("- dispatch ")).length, BOARD_RENDER_LIMIT);
  assert.equal(text.split("\n").filter((line) => line.includes("- notice ")).length, BOARD_RENDER_LIMIT);
});
