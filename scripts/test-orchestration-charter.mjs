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
import { approvePendingDraftFromUserMessage, handleTeamApprovalCommand } from "../lib/orchestra.js";
import { charterRecordStoreFor } from "../lib/charter-store.js";

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
    // P9: the declared reviewer must be referenced by a route.
    protocol: { ownership: { closure: "driver" }, routes: [{ kind: "dispatch", from: "driver", to: ["reviewer"] }], completion: { owner: "driver", rule: "done" } },
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

/**
 * Minimal `fs` double: enough for the charter record store to be exercised for
 * real (resolve/stat/read/write with the platform's guard codes) instead of
 * being stubbed out, so the guarded append is what the assertions actually run.
 */
function charterFs() {
  const files = new Map();
  return {
    files,
    async resolve(path) { return { path }; },
    async stat(target) {
      const held = files.get(target.path);
      return held === undefined ? undefined : { type: "file", version: held.version };
    },
    async readText(target) {
      const held = files.get(target.path);
      if (held === undefined) throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
      return held.text;
    },
    async writeText(target, content, expected) {
      const held = files.get(target.path);
      if (expected?.kind === "createIfAbsent" && held !== undefined) {
        throw Object.assign(new Error("already there"), { code: "FS_NOT_OBSERVED" });
      }
      if (expected?.kind === "replaceIfVersion" && (held === undefined || held.version !== expected.version)) {
        throw Object.assign(new Error("changed under us"), { code: "FS_STALE_VERSION" });
      }
      const next = `v${held === undefined ? 1 : Number(held.version.slice(1)) + 1}`;
      files.set(target.path, { text: content, version: next });
      return { version: next };
    },
  };
}

test("/team approve is a direct user-command seam with no natural-language bypass", async () => {
  const cwd = "/driver";
  const fs = charterFs();
  const ctx = { get: (name) => (name === "fs" ? fs : undefined) };
  const store = charterRecordStoreFor(ctx, cwd);
  const session = {
    header: { id: "driver-session", cwd },
    events: [],
    snapshotEvents() { return this.events; },
    append(type, data) { this.events.push({ type, data }); },
  };
  const draft = prepareDraftEvent([], draftInput()).value;
  await store.append({ type: CHARTER_DRAFT_EVENT, data: { draft } });

  const followups = [];
  const invocation = { rawInput: `approve ${draft.draftId}@1`, commandId: "command-approve", agent: { id: "driver-session", session, followup: (message) => { followups.push(message); } } };
  const result = await handleTeamApprovalCommand(ctx, invocation);
  assert.equal(result.kind, "success");
  const approvalsOf = async (draftId) => (await store.read()).filter((event) => event.type === CHARTER_APPROVAL_EVENT && event.data.approval.draftId === draftId);
  assert.equal((await approvalsOf(draft.draftId)).length, 1);
  assert.equal(
    session.events.some((event) => typeof event.type === "string" && event.type.startsWith("orchestra/")),
    false,
    "the approval must not be written into the driver's session log",
  );
  // The driver must be woken after approval (4600 实测：命令成功后 agent 死等)
  assert.equal(followups.length, 1);
  const notice = followups[0];
  assert.equal(notice?.source?.kind, "plugin");
  assert.equal(notice?.source?.form, "notice");
  assert.match(notice?.content?.[0]?.text ?? "", new RegExp(`Draft ${draft.draftId}@1 approved`));
  assert.match(notice?.content?.[0]?.text ?? "", /digest=/);
  assert.match(notice?.content?.[0]?.text ?? "", /freeze target=/);

  const retry = await handleTeamApprovalCommand(ctx, { ...invocation, commandId: "command-retry" });
  assert.equal(retry.kind, "success");
  assert.equal((await approvalsOf(draft.draftId)).length, 1, "a retry must not record a second approval");
  assert.equal(followups.length, 2, "an already-approved retry still wakes the driver (it needs the freeze target)");

  await assert.rejects(() => handleTeamApprovalCommand(ctx, { ...invocation, rawInput: `approve ${draft.draftId}@2` }), /revision_conflict/);
  await assert.rejects(() => handleTeamApprovalCommand(ctx, { ...invocation, rawInput: "可以" }), /approval command syntax/);
  assert.equal(followups.length, 2, "syntax errors must not wake the driver");

  // A record that cannot be written must reject loudly AND leave nothing behind.
  // (This replaces the old "flush refused" case: a guarded file append either
  // lands or reports that it did not, so there is no partial append to undo.)
  const secondDraft = prepareDraftEvent(await store.read(), draftInput({ draftId: "draft-second", now: 200 })).value;
  await store.append({ type: CHARTER_DRAFT_EVENT, data: { draft: secondDraft } });
  const realWrite = fs.writeText;
  fs.writeText = async () => { throw Object.assign(new Error("disk on fire"), { code: "FS_IO" }); };
  await assert.rejects(
    () => handleTeamApprovalCommand(ctx, { ...invocation, rawInput: `approve ${secondDraft.draftId}@1`, commandId: "command-broken" }),
    /could not be written/,
  );
  fs.writeText = realWrite;
  assert.equal((await approvalsOf(secondDraft.draftId)).length, 0, "a failed write must record no approval");
  const afterFailure = await store.read();
  assert.throws(
    () => prepareFreezeEvent(afterFailure, { draftId: secondDraft.draftId, revision: 1, digest: secondDraft.digest, frozenBySessionId: "driver-session", frozenAt: 202 }),
    (error) => error?.code === "approval_required",
    "an unrecorded approval must not authorize a freeze",
  );

  await handleTeamApprovalCommand(ctx, { ...invocation, rawInput: `approve ${secondDraft.draftId}@1`, commandId: "command-retry-after-failure" });
  const authorized = prepareFreezeEvent(await store.read(), { draftId: secondDraft.draftId, revision: 1, digest: secondDraft.digest, frozenBySessionId: "driver-session", frozenAt: 202 });
  assert.equal(authorized.kind, "changed");
});

test("a plain user reply approves the pending draft, and nothing else does", async () => {
  const cwd = "/driver";
  const fs = charterFs();
  const ctx = { get: (name) => (name === "fs" ? fs : undefined) };
  const store = charterRecordStoreFor(ctx, cwd);
  const session = {
    header: { id: "driver-session", cwd },
    events: [],
    snapshotEvents() { return this.events; },
    append(type, data) { this.events.push({ type, data }); },
  };
  const draft = prepareDraftEvent([], draftInput()).value;
  await store.append({ type: CHARTER_DRAFT_EVENT, data: { draft } });

  const approvals = async () => (await store.read()).filter((event) => event.type === CHARTER_APPROVAL_EVENT);
  const reply = (text, kind = "user") => ({ seq: 7, data: { role: "user", content: [{ type: "text", text }], source: { kind } } });

  // The whole point of the gate: only the user may open it. A plugin notice, or a
  // message relayed from another session (including the role sessions this plugin
  // creates), must NOT be able to approve on the user's behalf.
  assert.equal(await approvePendingDraftFromUserMessage(ctx, session, reply("启动", "plugin")), undefined);
  assert.equal(await approvePendingDraftFromUserMessage(ctx, session, reply("启动", "a2a")), undefined);
  assert.equal((await approvals()).length, 0, "only a real user turn may approve");

  // A long message that merely CONTAINS a yes-word is a message about something
  // else; treating it as consent would turn the gate into a formality.
  assert.equal(await approvePendingDraftFromUserMessage(ctx, session, reply("启动之前我想先确认一下范围，可以吗")), undefined);
  assert.equal(await approvePendingDraftFromUserMessage(ctx, session, reply("我再想想")), undefined);
  assert.equal((await approvals()).length, 0);

  // The plain reply approves, and the record names the exact message that did it.
  const recorded = await approvePendingDraftFromUserMessage(ctx, session, reply("启动"));
  assert.equal(recorded.changed, true);
  const approval = (await approvals())[0];
  assert.equal(approval.data.approval.draftId, draft.draftId);
  assert.equal(approval.data.approval.revision, 1);
  assert.equal(approval.data.approval.commandId, "message:driver-session@7");
  assert.equal(approval.data.approval.digest, draft.digest);
  // The record must name how the user actually said yes: a chat reply is not a
  // command, and a field that says otherwise is worse than a missing one.
  assert.equal(approval.data.approval.source, "user-reply");
  assert.equal(recorded.ref, frozenRef(draft.draftId, 1, draft.digest));

  // Nothing is pending any more, so a second yes records nothing new.
  assert.equal(await approvePendingDraftFromUserMessage(ctx, session, reply("启动")), undefined);
  assert.equal((await approvals()).length, 1);

  // The approval authorizes a freeze — the same downstream effect as the command.
  const frozen = prepareFreezeEvent(await store.read(), { draftId: draft.draftId, revision: 1, digest: draft.digest, frozenBySessionId: "driver-session", frozenAt: 300 });
  assert.equal(frozen.kind, "changed");
});

test("a plain reply does not approve somebody else's draft", async () => {
  const cwd = "/other";
  const fs = charterFs();
  const ctx = { get: (name) => (name === "fs" ? fs : undefined) };
  const store = charterRecordStoreFor(ctx, cwd);
  const author = prepareDraftEvent([], draftInput({ authorSessionId: "someone-else" })).value;
  await store.append({ type: CHARTER_DRAFT_EVENT, data: { draft: author } });
  const session = { header: { id: "driver-session", cwd }, events: [], snapshotEvents() { return this.events; }, append(type, data) { this.events.push({ type, data }); } };
  const reply = { seq: 3, data: { role: "user", content: [{ type: "text", text: "启动" }], source: { kind: "user" } } };
  assert.equal(await approvePendingDraftFromUserMessage(ctx, session, reply), undefined);
  assert.equal((await store.read()).filter((event) => event.type === CHARTER_APPROVAL_EVENT).length, 0);
});
