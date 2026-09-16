/**
 * Deep raw A2A transport seam.
 *
 * This module knows only SessionId-addressed message delivery, public Agent /
 * Session persistence, and preset-backed cold resume. It deliberately has no
 * filesystem, Team, archive, cwd, workspace, or roster policy dependency.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, freezeMessage, MessageId, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, MessageSource } from "@deepseek-ai/dsh-llm";
import { agentPresetProjectionDefinition, mountPreset } from "@deepseek-ai/dsh-agent-presets";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import type { BlueprintStore } from "./session-blueprint.js";
import type { ReceiptStore } from "./receipt-store.js";

const SID = (value: string) => value as import("@deepseek-ai/dsh-session").SessionId;

export type DeliveryMode = "live_inbox" | "durable_inbox" | "resumed_inbox";

export interface DeliverResult {
  message_id: string;
  target_session_id: string;
  accepted_at_ms: number;
  delivery_mode: DeliveryMode;
  state: "accepted";
  interrupt?: boolean;
  reply_to_message_id?: string;
}

export type MessageLifecycleState = "accepted" | "claimed" | "answered" | "unknown" | "not_found";

export interface MessageStatusResult {
  message_id: string;
  target_session_id: string;
  state: MessageLifecycleState;
  evidence?: string;
}

type TransportOptions = {
  wake?: boolean;
  replyTo?: string;
  interrupt?: boolean;
  idempotencyKey?: string;
  receiptPolicy?: unknown;
  /**
   * Durable receipt sink. Injected rather than imported so this module keeps its
   * documented "no filesystem, cwd, or roster policy" seam; see
   * `receipt-store.ts` for why the record may not live in the session log.
   */
  receiptStore?: ReceiptStore;
  /**
   * Resolve the composition-marker store for a session being cold-resumed.
   *
   * A factory rather than a store because the cwd is only known AFTER the cold
   * snapshot is read — and a factory rather than a direct import so this module
   * keeps its documented "no filesystem, cwd, or roster policy" seam.
   */
  resolveBlueprintStore?: (cwd: string | undefined) => BlueprintStore;
};

const receiptCache = new WeakMap<object, Map<string, DeliverResult>>();
const inflightCache = new WeakMap<object, Map<string, Promise<DeliverResult>>>();

function keyOf(options: TransportOptions): string | undefined {
  if (options.idempotencyKey === undefined) return undefined;
  if (typeof options.idempotencyKey !== "string" || options.idempotencyKey === "" || options.idempotencyKey.length > 256) {
    throw new Error("a2a transport: idempotencyKey must be a non-empty string of at most 256 characters");
  }
  return options.idempotencyKey;
}

function isA2AMessage(value: unknown, messageId: string): boolean {
  if (typeof value !== "object" || value === null || (value as { id?: unknown }).id !== messageId) return false;
  const source = (value as { source?: unknown }).source;
  return typeof source === "object" && source !== null && (source as { kind?: unknown }).kind === "a2a" && (source as { form?: unknown }).form === "relay";
}

function eventsContainA2AMessage(events: readonly { type: string; data: any }[], messageId: string): boolean {
  return events.some((event) => {
    if (event.type === "agent/inbox/spliced") return event.data.inserted.some((message: unknown) => isA2AMessage(message, messageId));
    return event.type === "user/message" && isA2AMessage(event.data, messageId);
  });
}

function acceptedReceipt(messageId: string, targetSessionId: string, deliveryMode: DeliveryMode, acceptedAt = Date.now()): DeliverResult {
  return { message_id: messageId, target_session_id: targetSessionId, accepted_at_ms: acceptedAt, delivery_mode: deliveryMode, state: "accepted" };
}

/**
 * Persist an acceptance record through the injected store.
 *
 * Delivery has ALREADY happened by the time this runs. A write failure is
 * therefore surfaced rather than swallowed — but it must never be turned into
 * "not delivered", because that would provoke exactly the duplicate dispatch the
 * receipt exists to prevent. Recording after delivery matches the behaviour of
 * the event append this replaced.
 *
 * With no store there is nothing durable to write to, and this returns without
 * recording. That is a real reduction in guarantee (dedup becomes process-local)
 * and NOT a silent failure of a write that was attempted — the caller decides
 * whether to supply a store, and `receipt-store.ts` states the consequence.
 */
async function recordReceipt(store: ReceiptStore | undefined, receipt: DeliverResult, options?: { policy?: unknown; signal?: AbortSignal }): Promise<void> {
  if (store === undefined) return;
  await store.record(receipt, options);
}

/**
 * Resolve an already-recorded acceptance for one (target, message) pair.
 *
 * Two independent sources, in trust order:
 *
 * 1. The durable receipt store — the only source that records WHICH idempotency
 *    key we accepted, and survives a restart.
 * 2. The target's own log/inbox, using harness-known events only
 *    (`agent/inbox/spliced`, `user/message`). This is what proves the message
 *    physically landed when no receipt was kept (deliveries without an
 *    idempotency key never record one).
 */
async function existingReceipt(
  ctx: Context,
  targetSessionId: string,
  messageId: string,
  receiptStore: ReceiptStore | undefined,
): Promise<DeliverResult | undefined> {
  const cached = receiptCache.get(ctx)?.get(`${targetSessionId}\0${messageId}`);
  if (cached !== undefined) return cached;
  if (receiptStore !== undefined) {
    const stored = await receiptStore.read(targetSessionId, messageId);
    if (stored !== undefined) return stored;
  }
  const live = ctx.agents.get(SID(targetSessionId));
  if (live !== undefined) {
    const pending = [...(live.inbox?.nextTurn ?? []), ...(live.inbox?.nextStep ?? [])];
    if (pending.some((message) => isA2AMessage(message, messageId)) || eventsContainA2AMessage(live.session.snapshotEvents(), messageId)) {
      return acceptedReceipt(messageId, targetSessionId, "live_inbox");
    }
  }
  const session = ctx.sessions.get(SID(targetSessionId));
  if (session !== undefined && eventsContainA2AMessage(session.snapshotEvents(), messageId)) {
    return acceptedReceipt(messageId, targetSessionId, "durable_inbox");
  }
  try {
    const query = ctx.get("sessionQuery");
    if (query !== undefined) {
      const snapshot = await query.readSession(SID(targetSessionId));
      if (eventsContainA2AMessage(snapshot.events, messageId)) return acceptedReceipt(messageId, targetSessionId, "durable_inbox");
    }
  } catch {
    // A status/duplicate lookup failure must not make a new raw delivery fail.
  }
  return undefined;
}

/**
 * The preset a persisted session actually runs, folded from its cold snapshot.
 *
 * `resolveSessionPreset` was removed from `@deepseek-ai/dsh-agent-presets`
 * (DSH 0.1.5-rc.2); the same fold is now published as the `agentPreset`
 * projection definition, whose `init`/`apply` pair is exactly the removed
 * helper's body. The header supplies the creation-time value and the last
 * `agent-preset/selected` event wins — reading the header alone would rebuild a
 * switched session under the composition it was created with.
 *
 * @param header - the snapshot's creation header.
 * @param events - the snapshot's event log, oldest first.
 * @returns the preset id, or `undefined` when neither source names one.
 */
function presetFromSnapshot(header: SessionHeader, events: readonly SessionEvent[]): string | undefined {
  let state: string | null = agentPresetProjectionDefinition.init(header);
  for (const event of events) state = agentPresetProjectionDefinition.apply(state, event);
  return state ?? undefined;
}

async function tryResume(
  ctx: Context,
  sessionId: string,
  senderSessionId: string | undefined,
  options: TransportOptions = {},
): Promise<void> {
  const presets = ctx.get("agentPresets");
  const query = ctx.get("sessionQuery");
  if (presets === undefined || query === undefined) {
    throw new Error(`a2a transport: cannot resume ${sessionId} — sessionQuery/agentPresets services unavailable`);
  }
  const snapshot = await query.readSession(SID(sessionId));
  // Checked before reviving anything: cold-resuming a sub-agent child is the
  // same delivery as reaching a live one, and doing it for a non-parent would
  // also wake a child its owner is not expecting to run.
  assertSubagentTargetReachable(snapshot.session, sessionId, senderSessionId);
  // The composition marker is a plugin record beside the other orchestra files,
  // not a Session event: recording it in the log is what made every created
  // session unreadable after a restart (docs/adr/0002). Without a store the
  // resume still works from the header's own preset projection below.
  const store = options.resolveBlueprintStore?.(snapshot.session.cwd);
  const stored = store === undefined ? undefined : await store.read(sessionId);
  const governed = stored?.mode === "governed" ? stored : undefined;
  const lightweight = stored?.mode === "lightweight" ? stored : undefined;
  const presetId = governed?.agentPreset ?? lightweight?.agentPreset ?? presetFromSnapshot(snapshot.session, snapshot.events);
  if (typeof presetId !== "string" || presetId === "") throw new Error(`a2a transport: session ${sessionId} has no recoverable Agent Preset`);
  const marker = governed ?? lightweight;
  const presetFile = marker?.presetSource === "file" && marker.presetPath !== undefined
    ? { id: presetId, trust: marker.presetTrust ?? "user", path: marker.presetPath }
    : undefined;
  const resolved = presetFile === undefined ? await presets.resolve(presetId) : undefined;
  const model = ctx.get("agentDefaultModel");
  const selection = model === undefined ? undefined : model.currentSelection();
  const provider = governed?.provider ?? lightweight?.provider ?? selection?.provider;
  const modelId = governed?.model ?? lightweight?.model ?? selection?.model;
  const reasoningEffort = governed?.reasoningEffort ?? lightweight?.reasoningEffort ?? selection?.reasoningEffort;
  await ctx.agents.resume({
    resumeSessionId: SID(sessionId),
    agentOptions: provider === undefined || modelId === undefined ? {} : { provider, model: modelId },
    setup: async (agentCtx) => {
      if (presetFile === undefined) {
        if (resolved === undefined) throw new Error(`a2a transport: preset ${presetId} was not resolved`);
        await presets.mount(agentCtx, resolved.id);
      } else {
        await mountPreset(agentCtx, presetFile);
      }
      if (provider !== undefined && modelId !== undefined) {
        installModelSelection(agentCtx, {
          current: {
            provider,
            model: modelId,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(String(reasoningEffort)) }),
          },
          assembled: undefined,
        });
      }
    },
  });
}

/**
 * Current length of one pending-inbox list, folded from the session's own log.
 *
 * DSH 0.1.5-rc.2 replaced `Session.events` with `snapshotEvents()` and moved
 * the fork-prefix length off the header onto `inheritedEventCount`; the fold's
 * meaning is unchanged — only events after the inherited prefix moved.
 *
 * @param session - the target session whose log is folded.
 * @param target - the pending list (`next-turn` or `next-step`).
 * @returns the non-negative pending length in that list.
 */
function pendingLength(session: Session, target: string): number {
  const events = session.snapshotEvents();
  let length = 0;
  const start = Number(session.inheritedEventCount);
  for (let index = start; index < events.length; index++) {
    const event = events[index];
    if (event.type !== "agent/inbox/spliced" || event.data.target !== target) continue;
    length += event.data.inserted.length - (event.data.removedCount ?? 0);
  }
  return Math.max(length, 0);
}

async function deliverMessageOnce(
  ctx: Context,
  senderSessionId: string | undefined,
  toSessionId: string,
  contentBlocks: ContentBlock[],
  options: TransportOptions = {},
): Promise<DeliverResult> {
  if (typeof toSessionId !== "string" || toSessionId === "") throw new Error("a2a transport: target session id must be non-empty");
  const wake = options.wake !== false;
  const acceptedAt = Date.now();
  const source = Object.assign(
    { kind: "a2a", form: "relay", senderSessionId },
    options.replyTo === undefined ? {} : { replyTo: options.replyTo },
  ) as MessageSource;
  const message = options.idempotencyKey === undefined
    ? createUserMessage({
        content: contentBlocks,
        source,
      })
    : freezeMessage({
        id: MessageId(options.idempotencyKey),
        role: "user" as const,
        content: contentBlocks,
        source,
      });
  const live = ctx.agents.get(SID(toSessionId));
  if (live !== undefined) {
    assertSubagentTargetReachable(live.session.header, toSessionId, senderSessionId);
    if (options.interrupt === true) {
      live.steer(message);
      const result: DeliverResult = {
        message_id: message.id,
        target_session_id: toSessionId,
        accepted_at_ms: acceptedAt,
        delivery_mode: "live_inbox",
        state: "accepted",
        interrupt: true,
        ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
      };
      if (options.idempotencyKey !== undefined) await recordReceipt(options.receiptStore, result, { policy: options.receiptPolicy });
      return result;
    }
    if (wake) live.followup(message);
    else live.inject(message);
    const result: DeliverResult = {
      message_id: message.id,
      target_session_id: toSessionId,
      accepted_at_ms: acceptedAt,
      delivery_mode: "live_inbox",
      state: "accepted",
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    };
    if (options.idempotencyKey !== undefined) await recordReceipt(options.receiptStore, result, { policy: options.receiptPolicy });
    return result;
  }

  const session = ctx.sessions.get(SID(toSessionId));
  if (session !== undefined) {
    assertSubagentTargetReachable(session.header, toSessionId, senderSessionId);
    const target = wake ? "next-turn" : "next-step";
    session.append("agent/inbox/spliced", { target, start: pendingLength(session, target), inserted: [message] });
    const result: DeliverResult = {
      message_id: message.id,
      target_session_id: toSessionId,
      accepted_at_ms: acceptedAt,
      delivery_mode: "durable_inbox",
      state: "accepted",
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    };
    if (options.idempotencyKey !== undefined) await recordReceipt(options.receiptStore, result, { policy: options.receiptPolicy });
    return result;
  }

  await tryResume(ctx, toSessionId, senderSessionId, options);
  const resumed = ctx.agents.get(SID(toSessionId));
  if (resumed === undefined) throw new Error(`a2a transport: target ${toSessionId} could not be resumed`);
  if (wake) resumed.followup(message);
  else resumed.inject(message);
  const result: DeliverResult = {
    message_id: message.id,
    target_session_id: toSessionId,
    accepted_at_ms: acceptedAt,
    delivery_mode: "resumed_inbox",
    state: "accepted",
    ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
  };
  if (options.idempotencyKey !== undefined) await recordReceipt(options.receiptStore, result, { policy: options.receiptPolicy });
  return result;
}

/**
 * Refuse to hand work to a sub-agent child this sender does not parent.
 *
 * A delegated child is addressed ONLY by its direct parent: the native seam
 * authorizes delivery on that adjacency edge alone ("throws when … adjacency is
 * rejected"), and the platform's generic Session routing refuses these ids
 * outright — "use subagent delivery for this child session".
 *
 * This transport writes into a target's inbox by bare session id, so without
 * this guard ANY session could hand a task to a child it did not create. That
 * would bypass the edge that authorizes delivery and race the parent that owns
 * the child's lifecycle (and would do it invisibly, since the write looks like
 * an ordinary inbox splice).
 *
 * A sender with no identity at all is refused for the same reason: an
 * unauthenticated caller cannot demonstrate the parent edge, and the safe
 * reading of "cannot prove adjacency" is "not adjacent".
 *
 * @param header - the resolved target session header.
 * @param targetSessionId - the addressed session id, for the message.
 * @param senderSessionId - the caller's session id, or undefined without one.
 * @throws when the target is a sub-agent child of somebody else.
 */
function assertSubagentTargetReachable(
  header: { origin?: "subagent"; parentSession?: string } | undefined,
  targetSessionId: string,
  senderSessionId: string | undefined,
): void {
  if (header?.origin !== "subagent") return;
  if (senderSessionId !== undefined && header.parentSession === senderSessionId) return;
  throw new Error(
    `a2a transport: session ${targetSessionId} is a sub-agent child of ${header.parentSession ?? "(unknown parent)"} and only that direct parent may deliver to it — native delegation authorizes on the adjacency edge alone, so no other session can reach it`,
  );
}

/** Deliver one raw SessionId-addressed message. No Team/CWD/FS policy is consulted. */
export async function deliverMessage(
  ctx: Context,
  senderSessionId: string | undefined,
  toSessionId: string,
  contentBlocks: ContentBlock[],
  options: TransportOptions = {},
): Promise<DeliverResult> {
  const key = keyOf(options);
  if (key === undefined) return deliverMessageOnce(ctx, senderSessionId, toSessionId, contentBlocks, options);
  const cacheKey = `${toSessionId}\0${key}`;
  const inflight = inflightCache.get(ctx) ?? new Map<string, Promise<DeliverResult>>();
  const prior = inflight.get(cacheKey);
  if (prior !== undefined) return prior;
  const promise = (async () => {
    const cached = receiptCache.get(ctx)?.get(cacheKey);
    if (cached !== undefined) return cached;
    const existing = await existingReceipt(ctx, toSessionId, key, options.receiptStore);
    if (existing !== undefined) {
      const cache = receiptCache.get(ctx) ?? new Map<string, DeliverResult>();
      cache.set(cacheKey, existing);
      receiptCache.set(ctx, cache);
      return existing;
    }
    const result = await deliverMessageOnce(ctx, senderSessionId, toSessionId, contentBlocks, options);
    const cache = receiptCache.get(ctx) ?? new Map<string, DeliverResult>();
    cache.set(cacheKey, result);
    receiptCache.set(ctx, cache);
    return result;
  })();
  inflight.set(cacheKey, promise);
  inflightCache.set(ctx, inflight);
  try {
    return await promise;
  } finally {
    inflight.delete(cacheKey);
  }
}

/** Read an existing idempotent receipt without enqueueing or resending anything. */
export async function readDeliveryReceipt(
  ctx: Context,
  targetSessionId: string,
  idempotencyKey: string,
  receiptStore?: ReceiptStore,
): Promise<DeliverResult | undefined> {
  const key = keyOf({ idempotencyKey });
  if (key === undefined) return undefined;
  return existingReceipt(ctx, targetSessionId, key, receiptStore);
}

function idOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : undefined;
}

function replyToOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = (value as { source?: unknown }).source;
  return typeof source === "object" && source !== null && typeof (source as { replyTo?: unknown }).replyTo === "string"
    ? (source as { replyTo: string }).replyTo
    : undefined;
}

/**
 * Reconstruct only lifecycle facts that are actually proven.
 *
 * The acceptance fact now comes from the durable receipt store when one is
 * supplied; the target's own log still proves it through `agent/inbox/spliced`
 * and `user/message`, which are harness-known events. Nothing here reads a
 * plugin-private event type any more — that is what used to make the target
 * session unreadable after a restart (see `docs/adr/0002`).
 */
export async function queryMessageStatus(
  ctx: Context,
  messageId: string,
  targetSessionId: string,
  receiptStore?: ReceiptStore,
): Promise<MessageStatusResult> {
  if (messageId === "" || targetSessionId === "") return { message_id: messageId, target_session_id: targetSessionId, state: "not_found" };
  try {
    // A recorded acceptance precedes anything the target wrote, so it sorts
    // before every event index: -1 is not a placeholder, it is the fact that
    // our record was written before the message entered the log.
    const stored = receiptStore === undefined ? undefined : await receiptStore.read(targetSessionId, messageId);
    let accepted = stored !== undefined;
    let firstAcceptedOrClaimed = stored === undefined ? Number.POSITIVE_INFINITY : -1;
    const live = ctx.sessions.get(SID(targetSessionId));
    let events: readonly SessionEvent[];
    if (live !== undefined) {
      events = live.snapshotEvents();
    } else {
      const query = ctx.get("sessionQuery");
      if (query === undefined) {
        // Without the log we can still report a proven acceptance; only the
        // claimed/answered half is unavailable.
        if (accepted) return { message_id: messageId, target_session_id: targetSessionId, state: "accepted", evidence: "durable delivery receipt; session log unavailable" };
        return { message_id: messageId, target_session_id: targetSessionId, state: "unknown", evidence: "sessionQuery unavailable" };
      }
      const snapshot = await query.readSession(SID(targetSessionId));
      events = snapshot.events;
    }
    let claimed = false;
    let answered = false;
    let firstAnswer = Number.POSITIVE_INFINITY;
    for (const [index, event] of events.entries()) {
      if (event.type === "agent/inbox/spliced") {
        if (event.data.inserted.some((message: unknown) => isA2AMessage(message, messageId))) {
          accepted = true;
          firstAcceptedOrClaimed = Math.min(firstAcceptedOrClaimed, index);
        }
      } else if (event.type === "user/message") {
        if (isA2AMessage(event.data, messageId)) {
          claimed = true;
          firstAcceptedOrClaimed = Math.min(firstAcceptedOrClaimed, index);
        }
      } else if (event.type === "assistant/message") {
        if (replyToOf(event.data.message) === messageId || replyToOf(event.data) === messageId) {
          answered = true;
          firstAnswer = Math.min(firstAnswer, index);
        }
      }
    }
    if (answered && firstAnswer <= firstAcceptedOrClaimed) return { message_id: messageId, target_session_id: targetSessionId, state: "unknown", evidence: "assistant response precedes accepted/claimed fact" };
    if (answered && (accepted || claimed) && firstAnswer > firstAcceptedOrClaimed) return { message_id: messageId, target_session_id: targetSessionId, state: "answered", evidence: "correlated assistant response after accepted/claimed" };
    if (claimed) return { message_id: messageId, target_session_id: targetSessionId, state: "claimed", evidence: "target A2A user/message event" };
    if (accepted) {
      return {
        message_id: messageId,
        target_session_id: targetSessionId,
        state: "accepted",
        evidence: stored === undefined ? "durable inbox splice" : "durable delivery receipt",
      };
    }
    return { message_id: messageId, target_session_id: targetSessionId, state: "unknown", evidence: "no correlated lifecycle event" };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return {
      message_id: messageId,
      target_session_id: targetSessionId,
      state: code === "SESSION_QUERY_SESSION_NOT_FOUND" ? "not_found" : "unknown",
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}
