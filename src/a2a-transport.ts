/**
 * Deep raw A2A transport seam.
 *
 * This module knows only SessionId-addressed message delivery, public Agent /
 * Session persistence, and preset-backed cold resume. It deliberately has no
 * filesystem, Team, archive, cwd, workspace, or roster policy dependency.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
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
  const resolved = await presets.resolve(presetId);
  const model = ctx.get("agentDefaultModel");
  const selection = model === undefined ? undefined : model.currentSelection();
  const provider = governed?.provider ?? lightweight?.provider ?? selection?.provider;
  const modelId = governed?.model ?? lightweight?.model ?? selection?.model;
  const reasoningEffort = governed?.reasoningEffort ?? lightweight?.reasoningEffort ?? selection?.reasoningEffort;
  await ctx.agents.resume({
    resumeSessionId: SID(sessionId),
    agentOptions: provider === undefined || modelId === undefined ? {} : { provider, model: modelId },
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id);
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

/** Deliver one raw SessionId-addressed message. No Team/CWD/FS policy is consulted. */
export async function deliverMessage(
  ctx: Context,
  senderSessionId: string | undefined,
  toSessionId: string,
  contentBlocks: ContentBlock[],
  options: { wake?: boolean; replyTo?: string; interrupt?: boolean } = {},
): Promise<DeliverResult> {
  if (typeof toSessionId !== "string" || toSessionId === "") throw new Error("a2a transport: target session id must be non-empty");
  const wake = options.wake !== false;
  const acceptedAt = Date.now();
  const message = createUserMessage({
    content: contentBlocks,
    source: Object.assign(
      { kind: "a2a", form: "relay", senderSessionId },
      options.replyTo === undefined ? {} : { replyTo: options.replyTo },
    ) as MessageSource,
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
        if (event.data.inserted.some((message: unknown) => idOf(message) === messageId)) accepted = true;
      } else if (event.type === "user/message") {
        if (idOf(event.data) === messageId) claimed = true;
      } else if (event.type === "assistant/message") {
        if (replyToOf(event.data.message) === messageId || replyToOf(event.data) === messageId) answered = true;
      }
    }
    if (answered) return { message_id: messageId, target_session_id: targetSessionId, state: "answered", evidence: "correlated assistant response" };
    if (claimed) return { message_id: messageId, target_session_id: targetSessionId, state: "claimed", evidence: "target user/message event" };
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
