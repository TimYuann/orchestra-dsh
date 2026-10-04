/**
 * First-batch dispatch ledger: the smallest recoverable dispatch set.
 *
 * WHAT THIS MODULE IS. One durable record per *intent* ("dispatch D binds role R
 * to this brief, under this charter and approval, with these fixed inputs"), a
 * deterministic payload identity for it, and the pending-notice fact that keeps
 * a committed report from being invisible when the driver cannot be reached.
 *
 * WHAT IT IS NOT. It is not a second task platform and not a workflow engine:
 * there is no status machine, no queue, no scheduler, and no revision editor.
 * The initial binding is immutable; a substantive change is a NEW dispatch that
 * names the one it follows.
 *
 * `bindingRevision` is fixed at 1 and is a PLACEHOLDER: nothing in this batch
 * consumes it, and it must not be used to claim any first-batch guarantee. The
 * report/dispatch link is carried by `dispatchId` alone.
 *
 * @module orchestra-dsh/orchestra-dispatch
 */

import { createHash } from "node:crypto";
import type { TeamState } from "./orchestra-state.js";
// The CANONICALIZATION RULE is shared with the charter digests on purpose: two
// canonicalizers would be two answers to "are these the same bytes".
import { canonicalJson } from "./orchestration-charter.js";

/**
 * The binding revision this batch writes. Fixed at 1 because the initial
 * delegation is immutable here; no revision protocol exists yet.
 */
export const DISPATCH_BINDING_REVISION = 1;

/** Upper bound on a caller-supplied dispatch id; it becomes a message identity. */
export const DISPATCH_ID_LIMIT = 200;

/** A method the dispatch binds, with the identity of the text that was bound. */
export interface DispatchMethodBinding {
  methodId: string;
  sourceCommit: string;
  contentDigest: string;
  purpose: string;
  sections?: string[];
  /**
   * Where the fixed text is read. A cwd-relative path is verified by the
   * dispatch entry itself: the file is read and its sha256 must equal
   * `contentDigest`, so "the method body really reached the worker" is checked
   * at the only place the plugin can check it — before the binding is recorded.
   */
  ref?: string;
  /** True only when the dispatch entry read the text and matched the digest. */
  contentVerified?: boolean;
}

/** The selected Profile, carried as a fixed digest of its body plus its source. */
export interface DispatchProfileRef {
  id: string;
  source: string;
  contentDigest: string;
}

/** The delegation this dispatch rests on. Refs are validated against THIS Team. */
export interface DispatchDelegation {
  charterRef: string;
  authorityRef: string;
  responsibility: string;
  scope: string[];
}

/**
 * Who the dispatch is actually about. Every field is recorded by the runtime:
 * `recordedBy`/`author` strings a model writes are never trusted as identity.
 */
export interface DispatchSubjects {
  initiatingSessionId: string;
  roleId: string;
  targetSessionId: string;
  resultRecipientSessionId: string;
  /** True once the role's session was confirmed built (or already live) for this dispatch. */
  materialized: boolean;
}

export type DispatchDeliveryState = "not_delivered" | "delivered" | "unknown" | "unsupported_backend";

/** Delivery recovery facts: what is known, and what is deliberately left unknown. */
export interface DispatchDelivery {
  state: DispatchDeliveryState;
  /** The idempotency credential the guaranteed delivery carries. */
  idempotencyKey: string;
  messageId?: string;
  deliveryMode?: string;
  acceptedAt?: number;
  attemptedAt?: number;
  reason?: string;
}

export interface DispatchRecord {
  dispatchId: string;
  /** Tool-computed identity of the bound payload; never caller-reported. */
  payloadDigest: string;
  /** Fixed at 1 in this batch; see the module comment. */
  bindingRevision: number;
  teamId: string;
  roleId: string;
  laneId: string;
  task: string;
  /** The persistent fixed brief carrying the six startup baselines. */
  brief: string;
  delegation: DispatchDelegation;
  profileRef?: DispatchProfileRef;
  methodBindings: DispatchMethodBinding[];
  subjects: DispatchSubjects;
  delivery: DispatchDelivery;
  createdAt: number;
  /**
   * Set when a later intent replaced this one. Only ever set on a dispatch whose
   * delivery PROVABLY never happened, so the ledger keeps the history while the
   * role is not reported as holding two undelivered dispatches.
   */
  supersededBy?: string;
}

export type HandoffOutcome = "report" | "blocked";
export type HandoffNoticeState = "pending" | "delivered" | "unknown" | "not_applicable";

/**
 * One committed report that the driver has not necessarily been told about.
 *
 * SEPARATE FROM `noticeFailures` ON PURPOSE: the diagnostic list is bounded at
 * 20 entries and holds failure reasons, so a pending handoff stored there would
 * vanish exactly when a run fails often enough to need it.
 */
export interface HandoffNotice {
  noticeId: string;
  reportId: string;
  dispatchId?: string;
  roleId: string;
  submittingSessionId: string;
  targetSessionId: string;
  path: string;
  contentHash: string;
  outcome: HandoffOutcome;
  createdAt: number;
  state: HandoffNoticeState;
  attempts: number;
  lastAttemptAt?: number;
  deliveredAt?: number;
  reason?: string;
  /**
   * The receiver's own message lifecycle, read from the transport: `accepted`
   * means the message is durable but the driver has not consumed it, `claimed`
   * means the driver's log consumed it as a user message. This plugin never
   * infers "the driver processed it" from anything else.
   */
  driverState?: "accepted" | "claimed" | "answered" | "unknown";
}

/** Stable identity of one handoff notice: one committed report, one notice. */
export function noticeIdFor(reportId: string): string {
  return `notice:${reportId}`;
}

/** The idempotency credential a guaranteed dispatch delivery carries. */
export function dispatchIdempotencyKey(dispatchId: string): string {
  return `orchestra-dispatch:${dispatchId}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The payload a dispatch pins. The dispatch id is deliberately NOT part of it. */
export interface DispatchPayload {
  teamId: string;
  roleId: string;
  laneId: string;
  task: string;
  brief: string;
  delegation: DispatchDelegation;
  profileRef?: DispatchProfileRef;
  methodBindings: DispatchMethodBinding[];
  resultRecipientSessionId: string;
}

/**
 * Compute the bound payload's identity.
 *
 * It is computed from the canonical form of the agreed input fields, so a caller
 * cannot report its own digest and two callers cannot disagree about whether two
 * dispatches are "the same content".
 */
export function computeDispatchPayloadDigest(payload: DispatchPayload): string {
  return sha256Hex(
    canonicalJson({
      teamId: payload.teamId,
      roleId: payload.roleId,
      laneId: payload.laneId,
      task: payload.task,
      brief: payload.brief,
      delegation: payload.delegation,
      profileRef: payload.profileRef ?? null,
      methodBindings: payload.methodBindings,
      resultRecipientSessionId: payload.resultRecipientSessionId,
    }),
  );
}

/** The report entry of a Team, as the ledger reads it. */
export type TeamReportEntry = TeamState["reports"][number];

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Normalize the ledger. A malformed entry is DROPPED rather than fatal: refusing
 * to read a Team because one dispatch record is corrupt would hide the very
 * facts a reader came for. A dropped record is visibly absent from the ledger,
 * which is the honest representation of "this record is unreadable".
 */
export function normalizeDispatches(raw: unknown): DispatchRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DispatchRecord[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    if (!nonEmptyString(record.dispatchId) || !nonEmptyString(record.payloadDigest)) continue;
    if (!nonEmptyString(record.roleId) || !nonEmptyString(record.teamId)) continue;
    const subjects = asRecord(record.subjects);
    const delegation = asRecord(record.delegation);
    const delivery = asRecord(record.delivery);
    if (subjects === undefined || delegation === undefined || delivery === undefined) continue;
    if (!nonEmptyString(subjects.targetSessionId) || !nonEmptyString(subjects.initiatingSessionId)) continue;
    if (!nonEmptyString(delegation.charterRef) || !nonEmptyString(delegation.authorityRef)) continue;
    if (!nonEmptyString(delivery.idempotencyKey)) continue;
    const state = delivery.state;
    if (state !== "not_delivered" && state !== "delivered" && state !== "unknown" && state !== "unsupported_backend") continue;
    const methodBindings: DispatchMethodBinding[] = (Array.isArray(record.methodBindings) ? record.methodBindings : [])
      .map((binding: unknown) => {
        const value = asRecord(binding);
        if (value === undefined) return undefined;
        if (!nonEmptyString(value.methodId) || !nonEmptyString(value.sourceCommit) || !nonEmptyString(value.contentDigest)) return undefined;
        return {
          methodId: value.methodId,
          sourceCommit: value.sourceCommit,
          contentDigest: value.contentDigest,
          purpose: typeof value.purpose === "string" ? value.purpose : "",
          ...(stringArray(value.sections) ? { sections: [...value.sections] } : {}),
          ...(nonEmptyString(value.ref) ? { ref: value.ref } : {}),
          ...(value.contentVerified === true ? { contentVerified: true } : {}),
        };
      })
      .filter((binding: DispatchMethodBinding | undefined): binding is DispatchMethodBinding => binding !== undefined);
    const profileRef = asRecord(record.profileRef);
    out.push({
      dispatchId: record.dispatchId,
      payloadDigest: record.payloadDigest,
      bindingRevision: typeof record.bindingRevision === "number" ? record.bindingRevision : DISPATCH_BINDING_REVISION,
      teamId: record.teamId,
      roleId: record.roleId,
      laneId: nonEmptyString(record.laneId) ? record.laneId : "main",
      task: typeof record.task === "string" ? record.task : "",
      brief: typeof record.brief === "string" ? record.brief : "",
      delegation: {
        charterRef: delegation.charterRef,
        authorityRef: delegation.authorityRef,
        responsibility: typeof delegation.responsibility === "string" ? delegation.responsibility : "",
        scope: stringArray(delegation.scope) ? [...delegation.scope] : [],
      },
      ...(profileRef !== undefined && nonEmptyString(profileRef.id) && nonEmptyString(profileRef.contentDigest)
        ? {
            profileRef: {
              id: profileRef.id,
              source: typeof profileRef.source === "string" ? profileRef.source : "",
              contentDigest: profileRef.contentDigest,
            },
          }
        : {}),
      methodBindings,
      subjects: {
        initiatingSessionId: subjects.initiatingSessionId,
        roleId: nonEmptyString(subjects.roleId) ? subjects.roleId : record.roleId,
        targetSessionId: subjects.targetSessionId,
        resultRecipientSessionId: nonEmptyString(subjects.resultRecipientSessionId)
          ? subjects.resultRecipientSessionId
          : subjects.initiatingSessionId,
        materialized: subjects.materialized === true,
      },
      delivery: {
        state,
        idempotencyKey: delivery.idempotencyKey,
        ...(nonEmptyString(delivery.messageId) ? { messageId: delivery.messageId } : {}),
        ...(nonEmptyString(delivery.deliveryMode) ? { deliveryMode: delivery.deliveryMode } : {}),
        ...(typeof delivery.acceptedAt === "number" ? { acceptedAt: delivery.acceptedAt } : {}),
        ...(typeof delivery.attemptedAt === "number" ? { attemptedAt: delivery.attemptedAt } : {}),
        ...(typeof delivery.reason === "string" ? { reason: delivery.reason } : {}),
      },
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
      ...(nonEmptyString(record.supersededBy) ? { supersededBy: record.supersededBy } : {}),
    });
  }
  return out;
}

/** Normalize pending handoff notices; same drop-don't-fail rule as the ledger. */
export function normalizeHandoffNotices(raw: unknown): HandoffNotice[] {
  if (!Array.isArray(raw)) return [];
  const out: HandoffNotice[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    if (!nonEmptyString(record.noticeId) || !nonEmptyString(record.reportId)) continue;
    if (!nonEmptyString(record.targetSessionId) || !nonEmptyString(record.path)) continue;
    if (record.state !== "pending" && record.state !== "delivered" && record.state !== "unknown" && record.state !== "not_applicable") continue;
    if (record.outcome !== "report" && record.outcome !== "blocked") continue;
    out.push({
      noticeId: record.noticeId,
      reportId: record.reportId,
      ...(nonEmptyString(record.dispatchId) ? { dispatchId: record.dispatchId } : {}),
      roleId: typeof record.roleId === "string" ? record.roleId : "",
      submittingSessionId: typeof record.submittingSessionId === "string" ? record.submittingSessionId : "",
      targetSessionId: record.targetSessionId,
      path: record.path,
      contentHash: typeof record.contentHash === "string" ? record.contentHash : "",
      outcome: record.outcome,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
      state: record.state,
      attempts: typeof record.attempts === "number" ? record.attempts : 0,
      ...(typeof record.lastAttemptAt === "number" ? { lastAttemptAt: record.lastAttemptAt } : {}),
      ...(typeof record.deliveredAt === "number" ? { deliveredAt: record.deliveredAt } : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(record.driverState === "accepted" || record.driverState === "claimed" || record.driverState === "answered" || record.driverState === "unknown"
        ? { driverState: record.driverState }
        : {}),
    });
  }
  return out;
}

/** Every report the Team booked against one dispatch, oldest first. */
export function reportsForDispatch(team: TeamState, dispatchId: string): TeamReportEntry[] {
  return (team.reports ?? []).filter((report) => (report as { dispatchId?: unknown }).dispatchId === dispatchId);
}

/**
 * Whether the worker handed this dispatch back: a result — or an explicit block
 * — is committed in the ledger and bound to THIS dispatch. Nothing else counts,
 * and in particular a coordination message never does.
 */
export function dispatchIsHandedBack(team: TeamState, record: DispatchRecord): boolean {
  return reportsForDispatch(team, record.dispatchId).length > 0;
}

/** The dispatch a role still owes a handback for: newest first, superseded excluded. */
export function openDispatchesFor(team: TeamState, roleId: string): DispatchRecord[] {
  return (team.dispatches ?? [])
    .filter((record) => record.roleId === roleId && record.supersededBy === undefined && !dispatchIsHandedBack(team, record))
    .sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * The dispatch that makes a role BUSY: one the worker may already hold and has
 * not handed back. A dispatch whose delivery provably never happened does not
 * make the role busy — the honest retry for that is the same id, and a new
 * intent supersedes it explicitly.
 */
export function blockingDispatchFor(team: TeamState, roleId: string): DispatchRecord | undefined {
  return openDispatchesFor(team, roleId).find(
    (record) => record.delivery.state === "delivered" || record.delivery.state === "unknown",
  );
}

/** The open dispatch bound to one session, for the turn boundary. */
export function openDispatchForSession(team: TeamState, sessionId: string): DispatchRecord | undefined {
  const role = (team.roles ?? []).find((entry) => entry.sessionId === sessionId);
  if (role === undefined) return undefined;
  return blockingDispatchFor(team, role.id) ?? openDispatchesFor(team, role.id)[0];
}

/**
 * The steer text for a role that is closing a turn with work still undelivered.
 *
 * It names the dispatch because "hand something back" is exactly the vagueness
 * that produced silent turns; the role must know WHICH intent it still owes.
 */
export function roleDeliveryStallPrompt(teamId: string, roleId: string, dispatchId: string): string {
  return (
    `orchestra: ${teamId} ${roleId} is closing this turn with dispatch ${dispatchId} still undelivered. ` +
    `Do not end the turn silently. File the result with orchestra_report and pass dispatchId="${dispatchId}" ` +
    `(outcome="blocked" if you cannot proceed) so the handback is bound to THIS dispatch, then reply to the driver with a2a_reply. ` +
    `A progress message alone is not a handback.`
  );
}

/** Compact projection of one dispatch record for the `orchestra_team` board. */
export interface DispatchLedgerRow {
  dispatch_id: string;
  role_id: string;
  lane_id: string;
  target_session_id: string;
  delivery_state: DispatchDeliveryState;
  open: boolean;
  report_id?: string;
  superseded_by?: string;
  created_at: number;
}

export function dispatchLedgerRows(team: TeamState): DispatchLedgerRow[] {
  return (team.dispatches ?? []).map((record) => {
    const report = reportsForDispatch(team, record.dispatchId)[0];
    return {
      dispatch_id: record.dispatchId,
      role_id: record.roleId,
      lane_id: record.laneId,
      target_session_id: record.subjects.targetSessionId,
      delivery_state: record.delivery.state,
      open: record.supersededBy === undefined && report === undefined,
      ...(report === undefined ? {} : { report_id: report.reportId }),
      ...(record.supersededBy === undefined ? {} : { superseded_by: record.supersededBy }),
      created_at: record.createdAt,
    };
  });
}

/** Compact projection of one pending notice for the `orchestra_team` board. */
export interface HandoffNoticeRow {
  notice_id: string;
  report_id: string;
  dispatch_id?: string;
  role_id: string;
  state: HandoffNoticeState;
  attempts: number;
  path: string;
  driver_state?: HandoffNotice["driverState"];
}

export function handoffNoticeRows(team: TeamState): HandoffNoticeRow[] {
  return (team.handoffNotices ?? []).map((notice) => ({
    notice_id: notice.noticeId,
    report_id: notice.reportId,
    ...(notice.dispatchId === undefined ? {} : { dispatch_id: notice.dispatchId }),
    role_id: notice.roleId,
    state: notice.state,
    attempts: notice.attempts,
    path: notice.path,
    ...(notice.driverState === undefined ? {} : { driver_state: notice.driverState }),
  }));
}

/**
 * How many ledger rows ONE render may list before it truncates.
 *
 * The counts are always complete; only the per-row detail is bounded. A board
 * that dumps every row would grow with the run and crowd out everything else the
 * driver asked for, which is why the limit exists at all.
 */
export const BOARD_RENDER_LIMIT = 5;

/**
 * The board's ledger block: per-row state, from the SAME projected rows the tool
 * returns.
 *
 * WHY PER-ROW AND NOT A SUMMARY. §3.2 keeps "show undelivered work per dispatch"
 * in the first batch, and a single "3 total, 0 undelivered" line cannot answer
 * the question a driver actually has — WHICH dispatch is still open, which one
 * already has a report, and which notice is still waiting for them. The
 * structured rows carried that answer; the render text did not, so the only
 * reader who could act on it was one that read `team.json` itself
 * (`docs/taskbook-2026-10-04-d5-d2.md`, item D5).
 *
 * UNRESOLVED FIRST, THEN THE REST, THEN AN EXPLICIT TRUNCATION COUNT — SPLIT BY
 * CATEGORY. The rows a reader most needs are the ones still open / still
 * awaiting them, so those lead; but ordering alone does NOT guarantee they all
 * fit, and saying so would be a false promise: with more unresolved rows than
 * the bound, the tail of the unresolved block is truncated too. What the reader
 * needs in that case is to know HOW MANY of the hidden rows are unresolved, so
 * the truncation line counts each category separately rather than reporting one
 * total that hides exactly that fact.
 */
export function dispatchBoardTextFromRows(
  rows: ReadonlyArray<{
    dispatch_id: string;
    role_id: string;
    delivery_state: string;
    open: boolean;
    report_id?: string;
    superseded_by?: string;
    target_session_id?: string;
  }>,
  notices: ReadonlyArray<{
    notice_id?: string;
    report_id?: string;
    dispatch_id?: string;
    role_id?: string;
    state: string;
    attempts?: number;
    path?: string;
    driver_state?: string;
  }>,
): string {
  const isAwaiting = (notice: { state: string }): boolean => notice.state === "pending" || notice.state === "unknown";

  const open = rows.filter((row) => row.open);
  const orderedRows = [...open, ...rows.filter((row) => !row.open)];
  const shownRows = orderedRows.slice(0, BOARD_RENDER_LIMIT);
  const hiddenRowList = orderedRows.slice(BOARD_RENDER_LIMIT);
  const hiddenOpen = hiddenRowList.filter((row) => row.open).length;
  const hiddenClosed = hiddenRowList.length - hiddenOpen;

  const awaiting = notices.filter(isAwaiting);
  const orderedNotices = [...awaiting, ...notices.filter((notice) => !isAwaiting(notice))];
  const shownNotices = orderedNotices.slice(0, BOARD_RENDER_LIMIT);
  const hiddenNoticeList = orderedNotices.slice(BOARD_RENDER_LIMIT);
  const hiddenAwaiting = hiddenNoticeList.filter(isAwaiting).length;
  const hiddenSettled = hiddenNoticeList.length - hiddenAwaiting;

  const lines = [
    `dispatches: ${rows.length} total, ${open.length} undelivered (per-row state follows; counts are complete)`,
    ...shownRows.map(
      (row) =>
        `  - dispatch ${row.dispatch_id} → role ${row.role_id} [delivery=${row.delivery_state}] ` +
        (row.open
          ? "UNDELIVERED (no bound result)"
          : `handed back${row.report_id === undefined ? "" : ` report=${row.report_id}`}`) +
        (row.superseded_by === undefined ? "" : ` superseded_by=${row.superseded_by}`) +
        (row.target_session_id === undefined ? "" : ` session=${row.target_session_id}`),
    ),
    ...(hiddenRowList.length === 0
      ? []
      : [
          `  … ${hiddenOpen} open + ${hiddenClosed} closed not shown (bounded render; counts above are complete)`,
        ]),
    `handoff notices: ${notices.length} total, ${awaiting.length} awaiting the driver`,
    ...shownNotices.map(
      (notice) =>
        `  - notice ${notice.notice_id ?? "(unknown)"} → role ${notice.role_id ?? "(unknown)"} [state=${notice.state}] ` +
        `driver=${notice.driver_state ?? "unknown"} attempts=${notice.attempts ?? 0}` +
        (notice.path === undefined ? "" : ` path=${notice.path}`) +
        (notice.dispatch_id === undefined ? "" : ` dispatch=${notice.dispatch_id}`),
    ),
    ...(hiddenNoticeList.length === 0
      ? []
      : [
          `  … ${hiddenAwaiting} awaiting the driver + ${hiddenSettled} settled not shown (bounded render; counts above are complete)`,
        ]),
  ];
  return lines.join("\n");
}

