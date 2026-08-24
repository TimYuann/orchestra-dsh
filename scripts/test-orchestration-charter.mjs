import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARTER_APPROVAL_EVENT,
  CHARTER_DRAFT_EVENT,
  CharterError,
  foldCharterEvents,
  prepareApprovalEvent,
  prepareDraftEvent,
  prepareFreezeEvent,
  resolveFrozenCharter,
  frozenRef,
} from "../lib/orchestration-charter.js";
import { handleTeamApprovalCommand } from "../lib/orchestra.js";

const mission = {
  objective: "ship the bounded change",
  scope: ["src"],
  constraints: ["keep the seam small"],
  acceptanceCriteria: ["tests pass"],
  nonGoals: ["4C"],
  context: "charter test",
};

function topology(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "trio",
    name: "Trio",
    controller: { id: "driver", source: "caller" },
    roles: [{ id: "reviewer", name: "Reviewer", preset: "orchestra-reviewer", sandbox: "read-only" }],
    protocol: { ownership: { closure: "driver" }, routes: [], completion: { owner: "driver", rule: "done" } },
    ...overrides,
  };
}

function draftInput(overrides = {}) {
  return {
    draftId: "draft-charter-test",
    mission,
    topology: { source: "catalog", id: "trio", catalogSource: "bundled", config: topology() },
    humanParticipationPolicy: { mode: "checkpointed", onUnavailable: "safe_stop", summary: "stop at explicit human checkpoints" },
    authorSessionId: "driver-session",
    now: 100,
    ...overrides,
  };
}

test("Draft revisions are continuous, digest-stable, and stale updates fail", () => {
  const first = prepareDraftEvent([], draftInput());
  assert.equal(first.kind, "changed");
  assert.equal(first.value.revision, 1);
  assert.match(first.value.digest, /^[a-f0-9]{64}$/);
  const reordered = prepareDraftEvent([], draftInput({ mission: { context: "charter test", nonGoals: ["4C"], acceptanceCriteria: ["tests pass"], constraints: ["keep the seam small"], scope: ["src"], objective: "ship the bounded change" }, topology: { config: { protocol: topology().protocol, roles: topology().roles, controller: topology().controller, name: "Trio", id: "trio", schemaVersion: 1 }, catalogSource: "bundled", id: "trio", source: "catalog" } }));
  assert.equal(reordered.value.digest, first.value.digest);
  const updated = prepareDraftEvent([first.event], draftInput({ expectedRevision: 1, now: 101, reason: "tighten scope" }));
  assert.equal(updated.value.revision, 2);
  assert.throws(() => prepareDraftEvent([first.event], draftInput({ expectedRevision: 9 })), (error) => error?.code === "revision_conflict");
  const folded = foldCharterEvents([first.event, updated.event]);
  assert.equal(folded.kind, "ready");
  assert.equal(folded.drafts.at(-1).revision, 2);
});

test("user-command approval is exact, durable-fact based, and idempotent", () => {
  const draft = prepareDraftEvent([], draftInput()).value;
  const event = { type: CHARTER_DRAFT_EVENT, data: { draft } };
  assert.throws(() => prepareFreezeEvent([event], { draftId: draft.draftId, revision: 1, digest: draft.digest, frozenBySessionId: "driver-session", frozenAt: 102 }), (error) => error?.code === "approval_required");
  const approval = prepareApprovalEvent([event], { draftId: draft.draftId, revision: 1, commandId: "command-1", approvingSessionId: "driver-session", approvedAt: 102 });
  assert.equal(approval.kind, "changed");
  const retry = prepareApprovalEvent([event, approval.event], { draftId: draft.draftId, revision: 1, commandId: "command-2", approvingSessionId: "driver-session", approvedAt: 103 });
  assert.equal(retry.kind, "noop");
  assert.equal(retry.value.approvalRef, frozenRef(draft.draftId, 1, draft.digest));
  assert.throws(() => prepareApprovalEvent([event], { draftId: draft.draftId, revision: 9, commandId: "command-3", approvingSessionId: "driver-session", approvedAt: 103 }), (error) => error?.code === "revision_conflict");
});

test("freeze requires exact approval and preserves a source topology snapshot", () => {
  const sourceConfig = topology();
  const draft = prepareDraftEvent([], draftInput({ topology: { source: "catalog", id: "trio", catalogSource: "bundled", config: sourceConfig } })).value;
  const draftEvent = { type: CHARTER_DRAFT_EVENT, data: { draft } };
  const approval = prepareApprovalEvent([draftEvent], { draftId: draft.draftId, revision: 1, commandId: "command-1", approvingSessionId: "driver-session", approvedAt: 102 });
  const frozen = prepareFreezeEvent([draftEvent, approval.event], { draftId: draft.draftId, revision: 1, digest: draft.digest, frozenBySessionId: "driver-session", frozenAt: 103 });
  assert.equal(frozen.kind, "changed");
  assert.equal(frozen.value.charterRevision, 1);
  assert.equal(frozen.value.approval.source, "user-command");
  sourceConfig.name = "mutated after freeze";
  assert.equal(frozen.value.topology.config.name, "Trio");
  const resolved = resolveFrozenCharter([draftEvent, approval.event, frozen.event], frozen.value.frozenRef);
  assert.equal(resolved.digest, draft.digest);
  const retry = prepareFreezeEvent([draftEvent, approval.event, frozen.event], { draftId: draft.draftId, revision: 1, digest: draft.digest, frozenBySessionId: "driver-session", frozenAt: 104 });
  assert.equal(retry.kind, "noop");
});

test("charter fold fails loud for malformed, out-of-order, and duplicate authoritative events", () => {
  const draft = prepareDraftEvent([], draftInput()).value;
  const draftEvent = { type: CHARTER_DRAFT_EVENT, data: { draft } };
  const approval = prepareApprovalEvent([draftEvent], { draftId: draft.draftId, revision: 1, commandId: "command-1", approvingSessionId: "driver-session", approvedAt: 102 });
  assert.equal(foldCharterEvents([approval.event]).kind, "blocked");
  assert.equal(foldCharterEvents([draftEvent, draftEvent]).kind, "blocked");
  assert.equal(foldCharterEvents([{ type: CHARTER_APPROVAL_EVENT, data: null }]).kind, "blocked");
  assert.doesNotThrow(() => foldCharterEvents([null, [], { type: "user/message", data: null }]));
  assert.equal(foldCharterEvents([null, [], { type: "user/message", data: null }]).kind, "ready");
  const badPolicy = prepareDraftEvent;
  assert.throws(() => badPolicy([], draftInput({ humanParticipationPolicy: { mode: "autonomous", onUnavailable: "block", requiredHumanGate: true } })), (error) => error instanceof CharterError && error.code === "invalid_human_policy");
});

test("/team approve is a direct user-command seam with flush and no natural-language bypass", async () => {
  const session = {
    events: [],
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  const draft = prepareDraftEvent([], draftInput()).value;
  session.append(CHARTER_DRAFT_EVENT, { draft });
  const flushes = [];
  const ctx = { sessions: { async flush() { flushes.push("flush"); return true; } } };
  const invocation = { rawInput: `approve ${draft.draftId}@1`, commandId: "command-approve", agent: { id: "driver-session", session } };
  const result = await handleTeamApprovalCommand(ctx, invocation);
  assert.equal(result.kind, "success");
  assert.equal(flushes.length, 1);
  assert.equal(session.events.filter((event) => event.type === CHARTER_APPROVAL_EVENT).length, 1);
  const retry = await handleTeamApprovalCommand(ctx, { ...invocation, commandId: "command-retry" });
  assert.equal(retry.kind, "success");
  assert.equal(session.events.filter((event) => event.type === CHARTER_APPROVAL_EVENT).length, 1);
  await assert.rejects(() => handleTeamApprovalCommand(ctx, { ...invocation, rawInput: `approve ${draft.draftId}@2` }), /revision_conflict/);
  await assert.rejects(() => handleTeamApprovalCommand(ctx, { ...invocation, rawInput: "可以" }), /approval command syntax/);
  const failedCtx = { sessions: { async flush() { return false; } } };
  const secondDraft = prepareDraftEvent(session.events, draftInput({ draftId: "draft-second", now: 200 })).value;
  session.append(CHARTER_DRAFT_EVENT, { draft: secondDraft });
  await assert.rejects(() => handleTeamApprovalCommand(failedCtx, { ...invocation, rawInput: `approve ${secondDraft.draftId}@1` }), /durable flush acceptance/);
});
