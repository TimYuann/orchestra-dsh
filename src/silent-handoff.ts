/**
 * D3 — the silent handoff: a turn that ends with nothing anyone can see.
 *
 * THE SHAPE (empirically located, see `docs/live-run-2026-10-04-first-batch.md`
 * §D3): a session finishes a turn whose LAST assistant message contains only
 * private reasoning, makes no outbound delivery call at all, and still owes a
 * reply to somebody who is waiting. The host then records `turn/end completed`
 * — correctly, because the model really did stop with `stopReason=stop` — and
 * nothing anywhere reports that the counterparty is now waiting forever.
 *
 * WHAT THIS MODULE IS: an independent, event-derived detector plus a disposition
 * (tell the waiting counterparty; steer the silent session) and a durable fact
 * (a `handoffNotices` entry, the same shape the first batch already records).
 *
 * WHAT IT IS NOT: it does not change the model's behaviour and does not promise
 * the shape stops occurring; it does not touch `handedBackThisTurn` or the
 * governed-team turn semantics; and it is not a policy engine, a scorer or a
 * scheduler.
 *
 * EVERYTHING HERE IS DERIVED FROM EVENTS: block types, tool names, parsed tool
 * arguments and message source markers. No message text is interpreted, so the
 * detector cannot be talked out of a detection by what a message says.
 *
 * @module orchestra-dsh/silent-handoff
 */

import type { HandoffNotice } from "./orchestra-dispatch.js";

/**
 * Tool calls that count as delivering something to somebody else.
 *
 * `orchestra_send` is included on purpose: it is the governed-role equivalent of
 * `a2a_send` on the same transport, so treating it as "not a delivery" would
 * create a false-positive path for team roles that did deliver. This widens the
 * list in the SAFE direction — it can only suppress a detection, never invent
 * one.
 */
export const OUTBOUND_DELIVERY_TOOLS: readonly string[] = ["a2a_reply", "a2a_send", "orchestra_report", "orchestra_send"];

/** The structural slice of a session event this module reads. */
export interface SilentHandoffEvent {
  type?: string;
  data?: {
    id?: unknown;
    turn?: unknown;
    name?: unknown;
    arguments?: unknown;
    source?: { kind?: unknown; senderSessionId?: unknown };
    inserted?: unknown;
    message?: { content?: unknown };
    [key: string]: unknown;
  };
}

/** One inbound A2A message that has not been answered by an outbound delivery. */
export interface PendingDeliveryRequest {
  messageId: string;
  senderSessionId?: string;
  /** Index in the event list, for a reader that wants to look at the context. */
  index: number;
}

export type SilentHandoffDetection =
  | { kind: "detected"; pendingRequest: PendingDeliveryRequest; pendingCount: number; lastAssistantAt: number }
  | { kind: "no-reasoning-only-last-message"; detail: string }
  | { kind: "outbound-delivery-in-turn"; tools: string[] }
  | { kind: "no-pending-request" };

interface InboundMessage extends PendingDeliveryRequest {}

interface OutboundCall {
  index: number;
  name: string;
  arguments: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * Every inbound A2A message in the log, oldest first.
 *
 * Both delivery shapes the transport produces are covered: a live `user/message`
 * carrying the relay source, and the durable `agent/inbox/spliced` splice the
 * cold path writes.
 */
export function inboundDeliveryRequests(events: readonly SilentHandoffEvent[], startIndex = 0): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (let index = Math.max(0, startIndex); index < events.length; index++) {
    const event = events[index];
    const data = event?.data;
    if (event?.type === "user/message") {
      const source = asRecord(data?.source);
      if (source?.kind === "a2a" && nonEmptyString(data?.id)) {
        out.push({
          messageId: data.id,
          ...(nonEmptyString(source.senderSessionId) ? { senderSessionId: source.senderSessionId } : {}),
          index,
        });
      }
      continue;
    }
    if (event?.type === "agent/inbox/spliced") {
      const inserted = Array.isArray(data?.inserted) ? (data!.inserted as unknown[]) : [];
      for (const entry of inserted) {
        const message = asRecord(entry);
        const source = asRecord(message?.source);
        if (source?.kind === "a2a" && nonEmptyString(message?.id)) {
          out.push({
            messageId: message!.id as string,
            ...(nonEmptyString(source.senderSessionId) ? { senderSessionId: source.senderSessionId as string } : {}),
            index,
          });
        }
      }
    }
  }
  return out;
}

/** Every outbound delivery call in one turn, oldest first. */
export function outboundDeliveryCalls(
  events: readonly SilentHandoffEvent[],
  turn: number | undefined,
  startIndex = 0,
): OutboundCall[] {
  const out: OutboundCall[] = [];
  for (let index = Math.max(0, startIndex); index < events.length; index++) {
    const event = events[index];
    if (event?.type !== "tool/call") continue;
    const data = event.data;
    if (!nonEmptyString(data?.name) || !OUTBOUND_DELIVERY_TOOLS.includes(data.name)) continue;
    if (turn !== undefined && data?.turn !== turn) continue;
    let parsed: Record<string, unknown> = {};
    if (typeof data?.arguments === "string" && data.arguments !== "") {
      try {
        parsed = asRecord(JSON.parse(data.arguments)) ?? {};
      } catch {
        // An unparseable argument blob cannot target anything, so it is treated
        // as an untargeted outbound act rather than as "no delivery at all".
        parsed = {};
      }
    } else if (asRecord(data?.arguments) !== undefined) {
      parsed = asRecord(data!.arguments)!;
    }
    out.push({ index, name: data.name, arguments: parsed });
  }
  return out;
}

/** `orchestra-dispatch:<id>` (the message id) and `<id>` (the dispatch id) agree. */
function normalizedMessageId(value: string): string {
  const prefix = "orchestra-dispatch:";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Whether one outbound call answers one inbound request.
 *
 * A call that names a target answers THAT request and only that one — replying
 * to B is not replying to A. A call that names no target is an outbound act
 * toward the counterparty and is read as a general answer to everything
 * outstanding before it.
 */
function settles(call: OutboundCall, inbound: InboundMessage): boolean {
  if (call.name === "a2a_reply") {
    const replyTo = call.arguments.reply_to ?? call.arguments.replyTo;
    if (nonEmptyString(replyTo)) return replyTo === inbound.messageId;
    return true;
  }
  if (call.name === "orchestra_report") {
    const dispatchId = call.arguments.dispatchId ?? call.arguments.dispatch_id;
    if (nonEmptyString(dispatchId)) return normalizedMessageId(inbound.messageId) === dispatchId;
    return true;
  }
  return true;
}

/**
 * Inbound requests still awaiting an outbound delivery, oldest first.
 *
 * This is criterion (c) of the detection: the false-positive guard. A session
 * that owes nobody anything may end a turn with private reasoning and nothing
 * else — that is a chat, not a stall.
 */
export function pendingDeliveryRequests(events: readonly SilentHandoffEvent[], startIndex = 0): PendingDeliveryRequest[] {
  const inbound = inboundDeliveryRequests(events, startIndex);
  if (inbound.length === 0) return [];
  const outbound = outboundDeliveryCalls(events, undefined, startIndex);
  return inbound.filter((request) => !outbound.some((call) => call.index > request.index && settles(call, request)));
}

interface LastAssistant {
  index: number;
  blocks: Record<string, any>[];
  hasReasoning: boolean;
  hasVisibleText: boolean;
  hasToolCall: boolean;
}

/** The last assistant message belonging to one turn. */
function lastAssistantMessage(
  events: readonly SilentHandoffEvent[],
  turn: number | undefined,
  startIndex = 0,
): LastAssistant | undefined {
  let found: LastAssistant | undefined;
  for (let index = Math.max(0, startIndex); index < events.length; index++) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const data = event.data;
    if (turn !== undefined && data?.turn !== turn) continue;
    const content = asRecord(data?.message)?.content;
    const blocks = (Array.isArray(content) ? content : []).map((block) => asRecord(block)).filter((block): block is Record<string, any> => block !== undefined);
    found = {
      index,
      blocks,
      hasReasoning: blocks.some((block) => block.type === "reasoning"),
      hasVisibleText: blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== ""),
      hasToolCall: blocks.some((block) => block.type === "tool-call"),
    };
  }
  return found;
}

/**
 * The D3 detector.
 *
 * All three criteria must hold together: (a) the turn's last assistant message
 * is private reasoning with nothing visible and no tool call, (b) the turn made
 * zero outbound delivery calls, and (c) an inbound delivery request is still
 * unanswered. The returned variant names which criterion failed, so a caller (or
 * a test) never has to guess why nothing happened.
 */
export function detectSilentHandoff(
  events: readonly SilentHandoffEvent[],
  turn: number | undefined,
  options: { startIndex?: number } = {},
): SilentHandoffDetection {
  const startIndex = options.startIndex ?? 0;
  const last = lastAssistantMessage(events, turn, startIndex);
  if (last === undefined) return { kind: "no-reasoning-only-last-message", detail: "the turn has no assistant message" };
  if (!last.hasReasoning) return { kind: "no-reasoning-only-last-message", detail: "the last assistant message carries no reasoning block" };
  if (last.hasVisibleText) return { kind: "no-reasoning-only-last-message", detail: "the last assistant message carries visible text" };
  if (last.hasToolCall) return { kind: "no-reasoning-only-last-message", detail: "the last assistant message carries a tool call" };

  const delivered = outboundDeliveryCalls(events, turn, startIndex);
  if (delivered.length > 0) return { kind: "outbound-delivery-in-turn", tools: [...new Set(delivered.map((call) => call.name))] };

  const pending = pendingDeliveryRequests(events, startIndex);
  if (pending.length === 0) return { kind: "no-pending-request" };
  return { kind: "detected", pendingRequest: pending[0], pendingCount: pending.length, lastAssistantAt: last.index };
}

/** Stable identity of one silent-handoff fact: one session, one turn. */
export function silentHandoffNoticeId(sessionId: string, turn: number): string {
  return `silent-handoff:${sessionId}:${turn}`;
}

/** The steer the silent session receives: deliver, or say what blocks you. */
export function silentHandoffSteerPrompt(input: {
  pendingMessageId: string;
  counterpartySessionId?: string;
  pendingCount: number;
}): string {
  const waiting = input.counterpartySessionId === undefined ? "your counterparty" : `session ${input.counterpartySessionId}`;
  return (
    `orchestra: you ended this turn with private reasoning only — no visible reply and no delivery — while ${waiting} is still waiting on ${input.pendingMessageId}` +
    `${input.pendingCount > 1 ? ` (and ${input.pendingCount - 1} more unanswered request(s))` : ""}. ` +
    `Do not end the turn silently. Either deliver now (a2a_reply, or orchestra_report when the request was a dispatched task) ` +
    `or state in one line what blocks you and what you need. Silence is not a handback.`
  );
}

/** The message the waiting counterparty receives. */
export function silentHandoffNoticeText(input: { sessionId: string; pendingMessageId: string; pendingCount: number; steered: boolean }): string {
  return (
    `orchestra: session ${input.sessionId} ended its turn with private reasoning only — no visible reply, no delivery — ` +
    `so your request ${input.pendingMessageId} is still unanswered${input.pendingCount > 1 ? ` (${input.pendingCount} requests are unanswered)` : ""}. ` +
    (input.steered
      ? "It has been steered to continue and either deliver or say what blocks it."
      : "It could not be steered automatically; the request needs a decision.")
  );
}

/** One recorded disposition, kept for diagnostics and assertions. */
export interface SilentHandoffRecord {
  sessionId: string;
  turn: number;
  noticeId: string;
  pendingMessageId: string;
  pendingCount: number;
  counterpartySessionId?: string;
  notified: boolean;
  persisted: "persisted" | "no-team" | "failed" | "skipped";
  steered: boolean;
}

export type SilentHandoffOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "detected"; record: SilentHandoffRecord };

/** The notice entry a silent handoff produces, in the first batch's shape. */
export function silentHandoffNotice(input: {
  sessionId: string;
  turn: number;
  pendingMessageId: string;
  counterpartySessionId?: string;
  pendingCount: number;
  roleId?: string;
  now: number;
}): HandoffNotice {
  return {
    noticeId: silentHandoffNoticeId(input.sessionId, input.turn),
    kind: "silent-handoff",
    submittingSessionId: input.sessionId,
    targetSessionId: input.counterpartySessionId ?? "",
    roleId: input.roleId ?? "",
    pendingMessageId: input.pendingMessageId,
    state: "pending",
    attempts: 0,
    createdAt: input.now,
    reason:
      `turn ${input.turn} ended with reasoning only and no outbound delivery while ${input.pendingCount} inbound A2A request(s) were unanswered`,
  };
}

/** Structural slice of the turn-stopping payload this guard reads. */
export interface SilentTurnStoppingLike {
  agent?: {
    id?: string;
    session?: {
      header?: { id?: string; cwd?: string };
      inheritedEventCount?: number;
      snapshotEvents?: () => readonly SilentHandoffEvent[];
    };
    steer?: (message: never) => void;
  };
  turn?: number;
}

export interface SilentHandoffGuardOptions {
  /** Append the fact durably. `no-team` means there was nothing to append it to. */
  persist(notice: HandoffNotice, context: { cwd: string | undefined }): Promise<"persisted" | "no-team" | "failed">;
  /** Tell the waiting counterparty. Best-effort: a failure is reported, never thrown. */
  notify(input: {
    sessionId: string;
    counterpartySessionId: string | undefined;
    pendingMessageId: string;
    pendingCount: number;
    steered: boolean;
  }): Promise<{ delivered: boolean; reason?: string }>;
  /** Steer the silent session so its turn runs another step. */
  steer(agent: NonNullable<SilentTurnStoppingLike["agent"]>, text: string): void;
  /** Whether the governed-team path already owns this session's turn. */
  teamOwnsTurn?(sessionId: string, cwd: string | undefined): Promise<boolean>;
  /** Role id for the record, when the session is a team role. */
  roleIdOf?(sessionId: string, cwd: string | undefined): Promise<string | undefined>;
  now?(): number;
}

export interface SilentHandoffGuard {
  onTurnStopping(payload: SilentTurnStoppingLike): Promise<SilentHandoffOutcome>;
  /** Every disposition this guard has made, oldest first. */
  records(): readonly SilentHandoffRecord[];
}

function sessionIdOf(agent: SilentTurnStoppingLike["agent"]): string | undefined {
  for (const candidate of [agent?.id, agent?.session?.header?.id]) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
}

/**
 * The runtime guard for D3.
 *
 * It runs at the same awaited turn boundary the team stall guard uses, but it is
 * a SEPARATE predicate with its own bookkeeping: it never reads or writes
 * `handedBackThisTurn`, so the governed-team semantics are untouched. Its
 * coverage is any session that owes a delivery — team role or bare A2A peer.
 *
 * Disposition levels (R2), in the order they are attempted:
 *   1. tell the waiting counterparty (always attempted);
 *   2. record the fact durably (team notice list when there is one);
 *   3. steer the silent session, unless the team path already owns this turn.
 */
export function createSilentHandoffGuard(options: SilentHandoffGuardOptions): SilentHandoffGuard {
  const now = options.now ?? (() => Date.now());
  /** `session#turn` keys already handled, so one turn costs at most one steer. */
  const handled = new Set<string>();
  const records: SilentHandoffRecord[] = [];

  return {
    async onTurnStopping(payload) {
      const agent = payload?.agent;
      const sessionId = sessionIdOf(agent);
      const turn = typeof payload?.turn === "number" ? payload.turn : undefined;
      if (agent === undefined || sessionId === undefined || turn === undefined) {
        return { kind: "ignored", reason: "the boundary carries no session id or turn number" };
      }
      const key = `${sessionId}#${turn}`;
      if (handled.has(key)) return { kind: "ignored", reason: "this turn was already handled" };
      const events = agent.session?.snapshotEvents?.();
      if (events === undefined) return { kind: "ignored", reason: "the session exposes no events" };

      const detection = detectSilentHandoff(events, turn, { startIndex: agent.session?.inheritedEventCount ?? 0 });
      if (detection.kind !== "detected") return { kind: "ignored", reason: detection.kind };

      // Taken BEFORE any side effect: the host re-reads the inbox after a steer
      // and runs another step, whose boundary fires this handler again with the
      // same turn number.
      handled.add(key);
      const cwd = agent.session?.header?.cwd;
      const owns = options.teamOwnsTurn === undefined ? false : await options.teamOwnsTurn(sessionId, cwd).catch(() => false);
      const roleId = options.roleIdOf === undefined ? undefined : await options.roleIdOf(sessionId, cwd).catch(() => undefined);

      let steered = false;
      if (!owns) {
        try {
          options.steer(
            agent,
            silentHandoffSteerPrompt({
              pendingMessageId: detection.pendingRequest.messageId,
              ...(detection.pendingRequest.senderSessionId === undefined ? {} : { counterpartySessionId: detection.pendingRequest.senderSessionId }),
              pendingCount: detection.pendingCount,
            }),
          );
          steered = true;
        } catch {
          steered = false;
        }
      }

      const notice = silentHandoffNotice({
        sessionId,
        turn,
        pendingMessageId: detection.pendingRequest.messageId,
        ...(detection.pendingRequest.senderSessionId === undefined ? {} : { counterpartySessionId: detection.pendingRequest.senderSessionId }),
        pendingCount: detection.pendingCount,
        ...(roleId === undefined ? {} : { roleId }),
        now: now(),
      });

      let persisted: SilentHandoffRecord["persisted"] = "skipped";
      try {
        persisted = await options.persist(notice, { cwd });
      } catch {
        persisted = "failed";
      }

      let notified = false;
      try {
        const outcome = await options.notify({
          sessionId,
          counterpartySessionId: detection.pendingRequest.senderSessionId,
          pendingMessageId: detection.pendingRequest.messageId,
          pendingCount: detection.pendingCount,
          steered,
        });
        notified = outcome.delivered;
      } catch {
        notified = false;
      }

      const record: SilentHandoffRecord = {
        sessionId,
        turn,
        noticeId: notice.noticeId,
        pendingMessageId: detection.pendingRequest.messageId,
        pendingCount: detection.pendingCount,
        ...(detection.pendingRequest.senderSessionId === undefined ? {} : { counterpartySessionId: detection.pendingRequest.senderSessionId }),
        notified,
        persisted,
        steered,
      };
      records.push(record);
      return { kind: "detected", record };
    },

    records() {
      return [...records];
    },
  };
}
