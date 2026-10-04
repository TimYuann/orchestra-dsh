/**
 * D3 acceptance: the silent handoff must be OBSERVED and DISPOSED OF.
 *
 * THE SHAPE (empirically located, `docs/live-run-2026-10-04-first-batch.md` §D3):
 * a session ends a turn whose last assistant message is private reasoning only,
 * makes no outbound delivery call, and still owes a reply to somebody waiting.
 * The host records `turn/end completed` — correctly, the model did stop — and
 * nothing anywhere notices that the counterparty will now wait forever.
 *
 * R4 requires three cases, red first:
 *   1. the shape occurs  → detected AND disposed of;
 *   2. a normal turn WITH an outbound delivery → must NOT be reported;
 *   3. a normal turn with no delivery and NO pending request (a chat) → must NOT
 *      be reported.
 *
 * BOUNDARY: this pins observation and disposition only. It says nothing about
 * whether the model stops producing the shape — it cannot, that is model
 * behaviour — and it does not touch `handedBackThisTurn` or the governed-team
 * turn semantics (those keep their own tests in `test-handoff-recovery.mjs`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actedSinceRequest,
  detectSilentHandoff,
  pendingDeliveryRequests,
  silentHandoffNotice,
  silentHandoffSteerPrompt,
  createSilentHandoffGuard,
  OUTBOUND_DELIVERY_TOOLS,
} from "../lib/silent-handoff.js";
import { handoffNoticeRows, normalizeHandoffNotices, dispatchBoardTextFromRows } from "../lib/orchestra-dispatch.js";

const CWD = "/tmp/orchestra-silent-handoff";
const COUNTERPARTY = "session-driver";

// ---------------------------------------------------------------------------
// Event builders: exactly the shapes the host writes (see the live session log)
// ---------------------------------------------------------------------------

const inbound = (id, sender = COUNTERPARTY) => ({
  type: "user/message",
  data: { id, role: "user", content: [{ type: "text", text: "please do the thing" }], source: { kind: "a2a", form: "relay", senderSessionId: sender } },
});

const splicedInbound = (id, sender = COUNTERPARTY) => ({
  type: "agent/inbox/spliced",
  data: { target: "next-turn", start: 0, inserted: [{ id, role: "user", content: [{ type: "text", text: "please do the thing" }], source: { kind: "a2a", form: "relay", senderSessionId: sender } }] },
});

const assistant = (turn, content) => ({ type: "assistant/message", data: { turn, step: 1, message: { role: "assistant", content } } });
const reasoningOnly = (turn) => assistant(turn, [{ type: "reasoning", text: "Let me check the call site…" }]);
const withText = (turn, text = "Here is the result.") => assistant(turn, [{ type: "reasoning", text: "thinking" }, { type: "text", text }]);
const withToolCallOnly = (turn) => assistant(turn, [{ type: "reasoning", text: "thinking" }, { type: "tool-call", id: "c1", name: "read", arguments: "{}" }]);

const toolCall = (turn, name, args) => ({ type: "tool/call", data: { turn, step: 1, callId: `c-${name}`, name, arguments: JSON.stringify(args) } });

function fakeAgent(events, { cwd = CWD, steer } = {}) {
  return {
    id: "session-silent",
    session: {
      header: { id: "session-silent", cwd },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
    },
    ...(steer === undefined ? {} : { steer }),
  };
}

function guardHarness(overrides = {}) {
  const calls = { persisted: [], notified: [], steered: [] };
  const guard = createSilentHandoffGuard({
    persist: async (notice) => {
      calls.persisted.push(notice);
      return overrides.persisted ?? "persisted";
    },
    notify: async (input) => {
      calls.notified.push(input);
      return overrides.notified ?? { delivered: true };
    },
    steer: (_agent, text) => calls.steered.push(text),
    ...(overrides.teamOwnsTurn === undefined ? {} : { teamOwnsTurn: overrides.teamOwnsTurn }),
    ...(overrides.roleIdOf === undefined ? {} : { roleIdOf: overrides.roleIdOf }),
  });
  return { guard, calls };
}

// ---------------------------------------------------------------------------
// R4-1: the shape is detected AND disposed of
// ---------------------------------------------------------------------------

test("D3/R4-1: reasoning-only turn with an unanswered request is detected", () => {
  const events = [inbound("orchestra-dispatch:task-1"), toolCall(1, "read", { file_path: "/tmp/x" }), reasoningOnly(1)];
  const detection = detectSilentHandoff(events, 1);
  assert.equal(detection.kind, "detected", `expected detection, got ${detection.kind}`);
  assert.equal(detection.pendingRequest.messageId, "orchestra-dispatch:task-1");
  assert.equal(detection.pendingRequest.senderSessionId, COUNTERPARTY);
  assert.equal(detection.pendingCount, 1);
  // The live incidents had 55 and 12 tool calls after the request arrived; the
  // (c) second half must keep them inside the detection.
  assert.equal(actedSinceRequest(events, 0), true);
});

test("D3/R4-1: the durable splice shape is detected too (cold delivery path)", () => {
  const events = [splicedInbound("orchestra-dispatch:task-2"), toolCall(1, "read", { file_path: "/tmp/x" }), reasoningOnly(1)];
  const detection = detectSilentHandoff(events, 1);
  assert.equal(detection.kind, "detected");
  assert.equal(detection.pendingRequest.messageId, "orchestra-dispatch:task-2");
});

test("D3/R4-1: disposition tells the counterparty, records the fact and steers the session", async () => {
  const events = [inbound("orchestra-dispatch:task-1"), toolCall(1, "read", { file_path: "/tmp/x" }), reasoningOnly(1)];
  const { guard, calls } = guardHarness();
  const outcome = await guard.onTurnStopping({ agent: fakeAgent(events), turn: 1 });

  assert.equal(outcome.kind, "detected");
  assert.equal(calls.notified.length, 1, "the waiting counterparty must be told");
  assert.equal(calls.notified[0].counterpartySessionId, COUNTERPARTY);
  assert.equal(calls.notified[0].pendingMessageId, "orchestra-dispatch:task-1");
  assert.equal(calls.persisted.length, 1, "the fact must be recorded durably");
  assert.equal(calls.persisted[0].kind, "silent-handoff");
  assert.equal(calls.persisted[0].submittingSessionId, "session-silent");
  assert.equal(calls.persisted[0].targetSessionId, COUNTERPARTY);
  assert.equal(calls.persisted[0].pendingMessageId, "orchestra-dispatch:task-1");
  assert.equal(calls.persisted[0].reportId, undefined, "a silent handoff has no report to point at");
  assert.equal(calls.steered.length, 1, "the silent session must be steered to continue");
  assert.match(calls.steered[0], /task-1/, "the steer names the request that is unanswered");
  assert.equal(outcome.record.notified && outcome.record.steered, true);
  assert.equal(outcome.record.persisted, "persisted");
});

test("D3/R4-1: one turn costs at most one steer, even if the boundary fires again", async () => {
  const events = [inbound("orchestra-dispatch:task-1"), toolCall(1, "read", { file_path: "/tmp/x" }), reasoningOnly(1)];
  const { guard, calls } = guardHarness();
  await guard.onTurnStopping({ agent: fakeAgent(events), turn: 1 });
  const second = await guard.onTurnStopping({ agent: fakeAgent(events), turn: 1 });
  assert.equal(second.kind, "ignored");
  assert.equal(calls.steered.length, 1);
  assert.equal(calls.notified.length, 1);
});

test("D3/R4-1: when the team path already owns the turn, the fact is still recorded but not steered twice", async () => {
  const events = [inbound("orchestra-dispatch:task-1"), toolCall(1, "read", { file_path: "/tmp/x" }), reasoningOnly(1)];
  const { guard, calls } = guardHarness({ teamOwnsTurn: async () => true, roleIdOf: async () => "implementer" });
  const outcome = await guard.onTurnStopping({ agent: fakeAgent(events), turn: 1 });
  assert.equal(outcome.kind, "detected");
  assert.equal(calls.steered.length, 0, "the governed-team guard owns the steer for that turn");
  assert.equal(calls.notified.length, 1);
  assert.equal(calls.persisted[0].roleId, "implementer");
});

// ---------------------------------------------------------------------------
// R4-2 and R4-3: the two false-positive guards
// ---------------------------------------------------------------------------

test("D3/R4-2: a turn that delivered is never reported", async () => {
  for (const name of OUTBOUND_DELIVERY_TOOLS) {
    const events = [inbound("orchestra-dispatch:task-1"), toolCall(1, name, { to: COUNTERPARTY }), reasoningOnly(1)];
    const detection = detectSilentHandoff(events, 1);
    assert.equal(detection.kind, "outbound-delivery-in-turn", `${name} must count as a delivery`);
    assert.deepEqual(detection.tools, [name]);
    const { guard, calls } = guardHarness();
    const outcome = await guard.onTurnStopping({ agent: fakeAgent(events), turn: 1 });
    assert.equal(outcome.kind, "ignored");
    assert.equal(calls.notified.length + calls.persisted.length + calls.steered.length, 0);
  }
});

test("D3/R4-2: a delivery in an EARLIER turn does not excuse this one", async () => {
  const events = [
    inbound("orchestra-dispatch:task-1"),
    toolCall(1, "a2a_reply", { reply_to: "orchestra-dispatch:task-1", message: "done" }),
    inbound("orchestra-dispatch:task-2"),
    // The session DID work on the second request — it just never handed anything
    // back, which is exactly the shape (c) is meant to catch.
    toolCall(2, "read", { file_path: "/tmp/y" }),
    reasoningOnly(2),
  ];
  const detection = detectSilentHandoff(events, 2);
  assert.equal(detection.kind, "detected", "the second request is still unanswered");
  assert.equal(detection.pendingRequest.messageId, "orchestra-dispatch:task-2");
});

test("D3/R4-3: an acknowledged message with NO work after it is a chat, not a stall", async () => {
  // Oracle's ruling: (c) needs BOTH halves — an unanswered request AND at least
  // one tool call after it. Otherwise a peer that merely said "收到" and got no
  // answer would be reported as a silent hand-off.
  const chat = [inbound("a2a-ack-1"), reasoningOnly(1)];
  const detection = detectSilentHandoff(chat, 1);
  assert.equal(detection.kind, "no-work-since-request", `expected a chat, got ${JSON.stringify(detection)}`);
  assert.equal(actedSinceRequest(chat, 0), false);
  const { guard, calls } = guardHarness();
  const outcome = await guard.onTurnStopping({ agent: fakeAgent(chat), turn: 1 });
  assert.equal(outcome.kind, "ignored");
  assert.equal(calls.notified.length + calls.persisted.length + calls.steered.length, 0, "nothing may fire for a chat");

  // The moment the session actually works on it, the same request DOES fire —
  // that is the case the counterparty is genuinely waiting on.
  const worked = [inbound("a2a-ack-1"), toolCall(1, "read", { file_path: "/tmp/x" }), reasoningOnly(1)];
  assert.equal(actedSinceRequest(worked, 0), true);
  assert.equal(detectSilentHandoff(worked, 1).kind, "detected");
});

test("D3/R4-3: reasoning-only with no pending request (a chat) is never reported", async () => {
  const chat = [reasoningOnly(1)];
  assert.deepEqual(detectSilentHandoff(chat, 1), { kind: "no-pending-request" });
  const { guard, calls } = guardHarness();
  const outcome = await guard.onTurnStopping({ agent: fakeAgent(chat), turn: 1 });
  assert.equal(outcome.kind, "ignored");
  assert.equal(calls.notified.length + calls.persisted.length + calls.steered.length, 0);
});

test("D3/R4-3: an inbound that was already answered leaves nothing pending", async () => {
  const answered = [
    inbound("orchestra-dispatch:task-1"),
    toolCall(1, "orchestra_report", { dispatchId: "task-1", path: "r.md", content: "done" }),
    reasoningOnly(1),
  ];
  assert.equal(detectSilentHandoff(answered, 1).kind, "outbound-delivery-in-turn");
  // The same log seen from a LATER turn: no delivery in that turn, but nothing is
  // pending either — so it is still not a silent handoff.
  const laterTurn = [...answered, reasoningOnly(2)];
  assert.equal(detectSilentHandoff(laterTurn, 2).kind, "no-pending-request");
  assert.deepEqual(pendingDeliveryRequests(answered), []);
});

test("D3/R4-3: a visible answer is not a silent handoff", () => {
  const events = [inbound("orchestra-dispatch:task-1"), withText(1)];
  const detection = detectSilentHandoff(events, 1);
  assert.equal(detection.kind, "no-reasoning-only-last-message");
  assert.match(detection.detail, /visible text/);
});

test("D3: a last message that carries a tool call is not the shape this task names", () => {
  const events = [inbound("orchestra-dispatch:task-1"), withToolCallOnly(1)];
  const detection = detectSilentHandoff(events, 1);
  assert.equal(detection.kind, "no-reasoning-only-last-message");
  assert.match(detection.detail, /tool call/);
});

// ---------------------------------------------------------------------------
// R1(c) precision: a reply aimed at another request does not answer this one
// ---------------------------------------------------------------------------

test("D3/R1(c): a reply targeted at request B does not settle the older request A", () => {
  const events = [
    inbound("orchestra-dispatch:task-A"),
    inbound("orchestra-dispatch:task-B"),
    toolCall(1, "a2a_reply", { reply_to: "orchestra-dispatch:task-B", message: "B done" }),
    reasoningOnly(1),
  ];
  const pending = pendingDeliveryRequests(events);
  assert.deepEqual(pending.map((request) => request.messageId), ["orchestra-dispatch:task-A"]);
  const detection = detectSilentHandoff(events, 1);
  assert.equal(detection.kind, "outbound-delivery-in-turn", "the turn DID deliver, so the shape itself does not hold");

  // Same log, later turn: A is still unanswered and nothing was delivered in
  // that turn, so the shape now holds and it names A.
  const laterTurn = [...events, reasoningOnly(2)];
  const later = detectSilentHandoff(laterTurn, 2);
  assert.equal(later.kind, "detected");
  assert.equal(later.pendingRequest.messageId, "orchestra-dispatch:task-A");
});

test("D3/R1(c): an untargeted outbound send is read as a general answer", () => {
  const events = [
    inbound("orchestra-dispatch:task-A"),
    toolCall(1, "a2a_send", { to: COUNTERPARTY, message: "working on it" }),
  ];
  assert.deepEqual(pendingDeliveryRequests(events), []);
});

// ---------------------------------------------------------------------------
// R3: the fact uses the first batch's notice shape, and reaches the board
// ---------------------------------------------------------------------------

test("D3/R3: the notice keeps the handoffNotices shape and survives a team.json round trip", () => {
  const notice = silentHandoffNotice({
    sessionId: "session-silent",
    turn: 4,
    pendingMessageId: "orchestra-dispatch:task-1",
    counterpartySessionId: COUNTERPARTY,
    pendingCount: 2,
    roleId: "implementer",
    now: 1234,
  });
  assert.equal(notice.noticeId, "silent-handoff:session-silent:4");
  assert.equal(notice.kind, "silent-handoff");
  assert.equal(notice.state, "pending");
  assert.equal(notice.targetSessionId, COUNTERPARTY);
  assert.equal(notice.reportId, undefined);

  const normalized = normalizeHandoffNotices([notice]);
  assert.equal(normalized.length, 1, "a silent-handoff notice must survive normalization, not be dropped");
  assert.equal(normalized[0].kind, "silent-handoff");
  assert.equal(normalized[0].pendingMessageId, "orchestra-dispatch:task-1");
  assert.equal(normalized[0].targetSessionId, COUNTERPARTY);

  // A report notice still round-trips exactly as before (no regression).
  const reportNotice = {
    noticeId: "notice:abc",
    reportId: "abc",
    roleId: "implementer",
    submittingSessionId: "s1",
    targetSessionId: "s2",
    path: "/tmp/r.md",
    contentHash: "hash",
    outcome: "report",
    createdAt: 1,
    state: "pending",
    attempts: 0,
  };
  const kept = normalizeHandoffNotices([reportNotice]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reportId, "abc");
  assert.equal(kept[0].path, "/tmp/r.md");
  assert.equal(kept[0].kind, undefined, "legacy report notices keep no kind");
});

test("D3/R3: the board projects and renders the silent-handoff row", () => {
  const notice = silentHandoffNotice({
    sessionId: "session-silent",
    turn: 4,
    pendingMessageId: "orchestra-dispatch:task-1",
    counterpartySessionId: COUNTERPARTY,
    pendingCount: 1,
    now: 1234,
  });
  const team = { handoffNotices: [notice] };
  const rows = handoffNoticeRows(team);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "silent-handoff");
  assert.equal(rows[0].pending_message_id, "orchestra-dispatch:task-1");
  assert.equal(rows[0].report_id, undefined);
  assert.equal(rows[0].path, undefined);

  const text = dispatchBoardTextFromRows([], rows);
  assert.match(text, /kind=silent-handoff/, "the driver must be able to tell it apart from a report notice");
  assert.match(text, /unanswered=orchestra-dispatch:task-1/);
  assert.match(text, /handoff notices: 1 total, 1 awaiting the driver/);
});

test("D3/R2: the steer and the counterparty notice both name the unanswered request", () => {
  const steer = silentHandoffSteerPrompt({ pendingMessageId: "m-1", counterpartySessionId: COUNTERPARTY, pendingCount: 2 });
  assert.match(steer, /m-1/);
  assert.match(steer, /1 more unanswered request/);
  assert.match(steer, /Silence is not a handback/);
});
