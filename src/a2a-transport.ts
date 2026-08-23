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
import { mountPreset, resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { readGovernedBlueprint, readLightweightBlueprint } from "./session-blueprint.js";

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

type TransportOptions = { wake?: boolean; replyTo?: string; interrupt?: boolean; idempotencyKey?: string };

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

async function existingReceipt(ctx: Context, targetSessionId: string, messageId: string): Promise<DeliverResult | undefined> {
  const cached = receiptCache.get(ctx)?.get(`${targetSessionId}\0${messageId}`);
  if (cached !== undefined) return cached;
  const live = ctx.agents.get(SID(targetSessionId));
  if (live !== undefined) {
    const pending = [...(live.inbox?.nextTurn ?? []), ...(live.inbox?.nextStep ?? [])];
    if (pending.some((message) => isA2AMessage(message, messageId)) || eventsContainA2AMessage(live.session.events, messageId)) {
      return acceptedReceipt(messageId, targetSessionId, "live_inbox");
    }
  }
  const session = ctx.sessions.get(SID(targetSessionId));
  if (session !== undefined && eventsContainA2AMessage(session.events, messageId)) {
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

async function tryResume(ctx: Context, sessionId: string): Promise<void> {
  const presets = ctx.get("agentPresets");
  const query = ctx.get("sessionQuery");
  if (presets === undefined || query === undefined) {
    throw new Error(`a2a transport: cannot resume ${sessionId} — sessionQuery/agentPresets services unavailable`);
  }
  const snapshot = await query.readSession(SID(sessionId));
  const governed = readGovernedBlueprint(snapshot.events);
  const lightweight = readLightweightBlueprint(snapshot.events);
  const presetId = governed?.agentPreset ?? lightweight?.agentPreset ?? resolveSessionPreset({ header: snapshot.session, events: snapshot.events });
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

function pendingLength(session: { events: readonly { type: string; data: any }[]; header: { seedLength?: number } }, target: string): number {
  let length = 0;
  const start = session.header.seedLength ?? 0;
  for (let index = start; index < session.events.length; index++) {
    const event = session.events[index];
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
    if (options.interrupt === true) {
      live.steer(message);
      return {
        message_id: message.id,
        target_session_id: toSessionId,
        accepted_at_ms: acceptedAt,
        delivery_mode: "live_inbox",
        state: "accepted",
        interrupt: true,
        ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
      };
    }
    if (wake) live.followup(message);
    else live.inject(message);
    return {
      message_id: message.id,
      target_session_id: toSessionId,
      accepted_at_ms: acceptedAt,
      delivery_mode: "live_inbox",
      state: "accepted",
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    };
  }

  const session = ctx.sessions.get(SID(toSessionId));
  if (session !== undefined) {
    const target = wake ? "next-turn" : "next-step";
    session.append("agent/inbox/spliced", { target, start: pendingLength(session, target), inserted: [message] });
    return {
      message_id: message.id,
      target_session_id: toSessionId,
      accepted_at_ms: acceptedAt,
      delivery_mode: "durable_inbox",
      state: "accepted",
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    };
  }

  await tryResume(ctx, toSessionId);
  const resumed = ctx.agents.get(SID(toSessionId));
  if (resumed === undefined) throw new Error(`a2a transport: target ${toSessionId} could not be resumed`);
  if (wake) resumed.followup(message);
  else resumed.inject(message);
  return {
    message_id: message.id,
    target_session_id: toSessionId,
    accepted_at_ms: acceptedAt,
    delivery_mode: "resumed_inbox",
    state: "accepted",
    ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
  };
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
    const existing = await existingReceipt(ctx, toSessionId, key);
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

/** Reconstruct only lifecycle facts proven by the target Session log. */
export async function queryMessageStatus(ctx: Context, messageId: string, targetSessionId: string): Promise<MessageStatusResult> {
  if (messageId === "" || targetSessionId === "") return { message_id: messageId, target_session_id: targetSessionId, state: "not_found" };
  try {
    const live = ctx.sessions.get(SID(targetSessionId));
    let events: readonly SessionEvent[];
    if (live !== undefined) {
      events = live.events;
    } else {
      const query = ctx.get("sessionQuery");
      if (query === undefined) return { message_id: messageId, target_session_id: targetSessionId, state: "unknown", evidence: "sessionQuery unavailable" };
      const snapshot = await query.readSession(SID(targetSessionId));
      events = snapshot.events;
    }
    let accepted = false;
    let claimed = false;
    let answered = false;
    for (const event of events) {
      if (event.type === "agent/inbox/spliced") {
        if (event.data.inserted.some((message: unknown) => isA2AMessage(message, messageId))) accepted = true;
      } else if (event.type === "user/message") {
        if (isA2AMessage(event.data, messageId)) claimed = true;
      } else if (event.type === "assistant/message") {
        if (replyToOf(event.data.message) === messageId || replyToOf(event.data) === messageId) answered = true;
      }
    }
    if (answered && (accepted || claimed)) return { message_id: messageId, target_session_id: targetSessionId, state: "answered", evidence: "correlated assistant response" };
    if (claimed) return { message_id: messageId, target_session_id: targetSessionId, state: "claimed", evidence: "target A2A user/message event" };
    if (accepted) return { message_id: messageId, target_session_id: targetSessionId, state: "accepted", evidence: "durable inbox splice" };
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
