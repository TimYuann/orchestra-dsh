/**
 * orchestra-dsh/a2a — A2A transport layer: peer-to-peer messaging between agent
 * threads (sessions), delivered as the target thread's next turn.
 *
 * Host-plane plugin. Mirrors the proven dynamic-plugin implementation, now as
 * a native bundle plugin: tools registered through ctx.tools, delivery through
 * the Agent inbox (agent.followup / agent.inject / durable inbox splices), and
 * a cold-target auto-resume (Codex ensure_v2_agent_loaded semantics) before
 * falling back to an in-memory queue.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, MessageSource } from "@deepseek-ai/dsh-llm";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-title";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/cordis-plugin-timer";
import { randomUUID } from "node:crypto";
import "./relay-types.js";

const SID = (value: string): SessionId => value as SessionId;

/** Install an agent-scoped model selection override (provider/model/reasoningEffort) on a fresh agent context. */
export function installModelOverride(
  agentCtx: Context,
  active: boolean,
  provider: string | undefined,
  model: string | undefined,
  reasoningEffort: string | undefined,
): void {
  if (!active || provider === undefined || model === undefined) return;
  installModelSelection(agentCtx, {
    current: {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    },
    assembled: undefined,
  });
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "orchestra-a2a";

/** Required services: live agent registry, in-memory session store, timer. */
export const inject = ["agents", "sessions", "timer", "tools"];

interface PendingItem {
  message: ReturnType<typeof createUserMessage>;
  wake: boolean;
}

/** Create one agent thread (session) with model default + preset composition. */
export async function createSession(
  ctx: Context,
  options: {
    sessionId?: string;
    cwd?: string;
    presetId?: string;
    currentSessionId?: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    /** Display title pinned on the new session (e.g. "orchestra: implementer (trio)"). */
    title?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ sessionId: string; cwd?: string; agentPreset?: string }> {
  const sessionId =
    typeof options.sessionId === "string" && options.sessionId !== ""
      ? options.sessionId
      : `session-${randomUUID()}`;
  const sid = SID(sessionId);
  if (ctx.agents.get(sid) !== undefined)
    throw new Error(`a2a: session "${sessionId}" already exists`);
  const cwd = typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : undefined;
  const model = ctx.get("agentDefaultModel");
  const selection = model === undefined ? undefined : model.currentSelection();
  const agentOptions =
    options.provider !== undefined || options.model !== undefined
      ? {
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        }
      : selection === undefined
        ? {}
        : { provider: selection.provider, model: selection.model };
  const modelOverride =
    options.provider !== undefined || options.model !== undefined || options.reasoningEffort !== undefined;
  const overrideProvider = options.provider ?? selection?.provider;
  const overrideModel = options.model ?? selection?.model;
  let setup: ((agentCtx: Context) => Promise<void>) | undefined;
  let agentPreset: string | undefined;
  const presets = ctx.get("agentPresets");
  if (presets !== undefined) {
    const resolved = await presets.resolve(options.presetId);
    agentPreset = resolved.id;
    setup = async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id);
      installModelOverride(agentCtx, modelOverride, overrideProvider, overrideModel, options.reasoningEffort);
    };
  } else if (modelOverride && overrideProvider !== undefined && overrideModel !== undefined) {
    setup = (agentCtx) => {
      installModelOverride(agentCtx, true, overrideProvider, overrideModel, options.reasoningEffort);
      return Promise.resolve();
    };
  }
  await ctx.agents.create({
    sessionId: sid,
    agentOptions,
    meta: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    ...(setup === undefined ? {} : { setup }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (typeof options.title === "string" && options.title !== "") {
    const session = ctx.sessions.get(sid);
    if (session !== undefined) {
      // Pinned display title: log-only "session/title" event (kind:user pins it,
      // so automatic title generation does not later rename role sessions).
      session.append("session/title", { title: options.title, messageSeqs: [], source: { kind: "user" } });
    }
  }
  const registry = ctx.get("workspaceRegistry");
  if (registry !== undefined) {
    let workspace;
    if (typeof options.workspaceId === "string" && options.workspaceId !== "") {
      workspace = registry.get(options.workspaceId);
    } else if (typeof options.currentSessionId === "string" && options.currentSessionId !== "") {
      workspace = registry.list().find((entry: any) => entry.sessionIds.includes(options.currentSessionId));
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sid);
      } catch (error) {
        console.error(
          `a2a: attach ${sessionId} to workspace failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return {
    sessionId: sid,
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  };
}

/** Try to resume a cold session so a message can be delivered to a live agent. */
async function tryResume(ctx: Context, sessionId: string): Promise<boolean> {
  const presets = ctx.get("agentPresets");
  const query = ctx.get("sessionQuery");
  if (presets === undefined || query === undefined) return false;
  try {
    const snapshot = await query.readSession(SID(sessionId));
    const presetId = resolveSessionPreset({ header: snapshot.session, events: snapshot.events });
    const resolved = await presets.resolve(presetId);
    const model = ctx.get("agentDefaultModel");
    const selection = model === undefined ? undefined : model.currentSelection();
    await ctx.agents.resume({
      resumeSessionId: SID(sessionId),
      agentOptions: selection === undefined ? {} : { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
      },
    });
    return true;
  } catch (error) {
    console.error(`a2a: auto-resume of ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Pending length of one inbox target list in the durable log (mirror of Inbox.apply). */
function pendingLength(session: { events: readonly { type: string; data: any }[]; header: { seedLength?: number } }, target: string): number {
  let length = 0;
  const events = session.events;
  const start = session.header.seedLength ?? 0;
  for (let i = start; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "agent/inbox/spliced") continue;
    const splice = event.data;
    if (splice.target !== target) continue;
    length += splice.inserted.length - (splice.removedCount ?? 0);
  }
  return Math.max(length, 0);
}

export interface DeliverResult {
  messageId: string;
  to: string;
  mode: "live" | "resumed" | "durable-splice" | "queued";
  /** Present when delivery used the interrupt (steer) path — best-effort mid-turn steering. */
  interrupt?: boolean;
}

/**
 * Core delivery: live agent → followup/inject (interrupt → steer); attached →
 * durable inbox splice; cold → auto-resume, else queue.
 *
 * Turn-model contract: DSH sessions are single-threaded — a message to a live
 * agent that is currently working is claimed at the agent's next step/turn
 * boundary and is NEVER dropped (the inbox is durable). Setting `interrupt`
 * delivers through DSH's native steering path (`agent.steer` = next-step +
 * wake): an idle target still starts a fresh turn, but a running target picks
 * the message up at its nearest step boundary within the current turn instead
 * of waiting for the turn to end. This is the closest physically possible
 * "mid-turn interrupt" — an in-flight model generation cannot be preempted.
 */
export function deliverMessage(
  ctx: Context,
  queue: Map<string, PendingItem[]>,
  senderSessionId: string | undefined,
  toSessionId: string,
  contentBlocks: ContentBlock[],
  options: { wake?: boolean; replyTo?: string; interrupt?: boolean } = {},
): DeliverResult {
  const wake = options.wake !== false;
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
      return { messageId: message.id, to: toSessionId, mode: "live", interrupt: true };
    }
    if (wake) live.followup(message);
    else live.inject(message);
    return { messageId: message.id, to: toSessionId, mode: "live" };
  }
  // Attached but not live: append a durable inbox splice (delivered on resume).
  const session = ctx.sessions.get(SID(toSessionId));
  if (session !== undefined && ctx.agents.get(SID(toSessionId)) === undefined) {
    const target = wake ? "next-turn" : "next-step";
    session.append("agent/inbox/spliced", {
      target,
      start: pendingLength(session, target),
      inserted: [message],
    });
    return { messageId: message.id, to: toSessionId, mode: "durable-splice" };
  }
  // Truly cold: try to resume the agent so the message can be delivered now.
  // The resume is fire-and-forget; if it fails, fall back to the in-memory queue.
  const resumed = tryResume(ctx, toSessionId).then((ok) => {
    if (!ok) return;
    const agent = ctx.agents.get(SID(toSessionId));
    if (agent !== undefined) {
      try {
        if (wake) agent.followup(message);
        else agent.inject(message);
      } catch (error) {
        console.error(`a2a: post-resume delivery to ${toSessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  // Remember the message for the queue-flush path in case resume never lands.
  let pending = queue.get(toSessionId);
  if (pending === undefined) {
    pending = [];
    queue.set(toSessionId, pending);
  }
  pending.push({ message, wake });
  // If resume succeeds, the message was already delivered; remove it from the queue.
  resumed.then(() => {
    const list = queue.get(toSessionId);
    if (list === undefined) return;
    const index = list.findIndex((item) => item.message.id === message.id);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) queue.delete(toSessionId);
  });
  return { messageId: message.id, to: toSessionId, mode: "queued" };
}

/** Flush queued messages once the target agent is live (agent/created listener). */
export function flushQueued(ctx: Context, queue: Map<string, PendingItem[]>, sessionId: string): { flushed: number; stillQueued: number } {
  const pending = queue.get(sessionId);
  if (pending === undefined) return { flushed: 0, stillQueued: 0 };
  const agent = ctx.agents.get(SID(sessionId));
  if (agent === undefined) return { flushed: 0, stillQueued: pending.length };
  queue.delete(sessionId);
  for (const item of pending) {
    try {
      if (item.wake) agent.followup(item.message);
      else agent.inject(item.message);
    } catch (error) {
      console.error(`a2a: flush to ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { flushed: pending.length, stillQueued: 0 };
}

function textOf(message: { content?: unknown } | undefined | null): string {
  const content = message === undefined || message === null ? undefined : message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
      parts.push((block as any).text);
    }
  }
  return parts.join("\n");
}

/** Read the recent user/assistant messages of one session (live or persisted). */
export async function readSessionText(
  ctx: Context,
  sessionId: string,
  limit = 8,
): Promise<{ sessionId: string; messages: { role: string; text: string }[] }> {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("a2a: sessionQuery service is unavailable");
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("a2a: \"sessionId\" must be a non-empty string");
  const snapshot = await query.readSession(SID(sessionId));
  const messages: { role: string; text: string }[] = [];
  for (const event of snapshot.events) {
    if (event.type === "user/message") {
      const kind = event.data.source === undefined ? undefined : (event.data.source as any).kind;
      if (kind !== "a2a" && kind !== "user") continue;
      const text = textOf(event.data);
      if (text === "") continue;
      messages.push({ role: "user", text });
    } else if (event.type === "assistant/message") {
      const text = textOf(event.data.message);
      if (text === "") continue;
      messages.push({ role: "assistant", text });
    }
  }
  const picked = messages.slice(-Math.max(1, Math.min(limit, 20)));
  return {
    sessionId,
    messages: picked.map((entry) => ({
      role: entry.role,
      text: entry.text.length > 600 ? `${entry.text.slice(0, 600)}…` : entry.text,
    })),
  };
}

/** List live + recent cold threads with title/status/archived flag. */
export async function listThreads(
  ctx: Context,
  limit = 30,
): Promise<{ threads: { sessionId: string; title?: string; cwd?: string; status: string; live: boolean; archived?: boolean }[] }> {
  const query = ctx.get("sessionQuery");
  const live = ctx.agents.list();
  const liveEntries = live.map((agent) => ({
    sessionId: agent.id,
    cwd: agent.session.header.cwd,
    status: agent.status,
    live: true,
  }));
  if (query === undefined) return { threads: liveEntries };
  const records = await query.listSessions();
  const cold = records
    .filter((record: any) => record.live !== true && !liveEntries.some((entry: any) => entry.sessionId === record.header.id))
    .slice(0, limit);
  const ids = [...liveEntries.map((entry: any) => entry.sessionId), ...cold.map((record: any) => record.header.id)];
  const observations = await query.readTitleSnapshots(ids);
  const titles = new Map<string, string>();
  for (const observation of observations) {
    if (observation.status === "fulfilled" && observation.value.title !== undefined) {
      titles.set(observation.sessionId, observation.value.title.title);
    }
  }
  // Collect session ids of dismissed orchestra instances (archived teams) per cwd.
  const archived = new Set<string>();
  const fs = ctx.get("fs");
  if (fs !== undefined) {
    const cwds = new Set<string>();
    for (const entry of liveEntries) if (entry.cwd !== undefined) cwds.add(entry.cwd);
    for (const record of cold) if (record.header.cwd !== undefined) cwds.add(record.header.cwd);
    for (const cwd of cwds) {
      try {
        const dir = await fs.resolve(`${cwd}/orchestra/archive`, { cwd });
        const info = await fs.stat(dir);
        if (info === undefined) continue;
        const entries = await fs.listDir(dir);
        for (const entry of entries) {
          if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
          try {
            const raw = JSON.parse(await fs.readText(entry.target)) as { roles?: { sessionId?: string }[] };
            for (const role of raw.roles ?? []) {
              if (typeof role.sessionId === "string") archived.add(role.sessionId);
            }
          } catch {
            // skip unparseable archive files
          }
        }
      } catch {
        // no orchestra/archive directory for this cwd
      }
    }
  }
  const threads: { sessionId: string; title?: string; cwd?: string; status: string; live: boolean; archived?: boolean }[] = [
    ...liveEntries.map((entry) => ({
      ...entry,
      ...(titles.get(entry.sessionId) === undefined ? {} : { title: titles.get(entry.sessionId) }),
      ...(archived.has(entry.sessionId) ? { archived: true } : {}),
    })),
    ...cold.map((record: any) => ({
      sessionId: record.header.id,
      cwd: record.header.cwd,
      status: "cold",
      live: false,
      ...(titles.get(record.header.id) === undefined ? {} : { title: titles.get(record.header.id) }),
      ...(archived.has(record.header.id) ? { archived: true } : {}),
    })),
  ];
  threads.sort((a, b) => (a.cwd ?? "").localeCompare(b.cwd ?? "") || a.sessionId.localeCompare(b.sessionId));
  return { threads };
}

const SECTION_NAME = "tool:a2a";
const SECTION_ORDER = 118;

export const Config = undefined;

export function apply(ctx: Context): void {
  const queue = new Map<string, PendingItem[]>();

  ctx.on("agent/created", ({ agent }) => {
    const pending = queue.get(agent.id);
    if (pending === undefined) return;
    ctx.timeout(() => {
      try {
        flushQueued(ctx, queue, agent.id);
      } catch (error) {
        console.error(`a2a: queued flush for ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 0);
  });

  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      messageId: { type: "string", required: true },
      to: { type: "string", required: true },
      mode: { type: "string", required: true },
      interrupt: { type: "boolean" },
    },
  } as const;
  const renderResult = (
    _args: unknown,
    value: { messageId: string; to: string; mode: string; interrupt?: boolean },
  ): ContentBlock[] => [
    {
      type: "text",
      text:
        value.mode === "live"
          ? value.interrupt === true
            ? `message ${value.messageId} steered to agent ${value.to} (mid-turn interrupt)`
            : `message ${value.messageId} delivered to agent ${value.to}`
          : value.mode === "resumed"
            ? `message ${value.messageId} delivered to agent ${value.to} (cold session resumed)`
            : value.mode === "durable-splice"
              ? `message ${value.messageId} recorded for agent ${value.to}; delivered when that thread resumes`
              : `message ${value.messageId} queued for agent ${value.to}; that thread is not live yet`,
    },
  ] as ContentBlock[];

  ctx.tools.register(
    defineTool({
      name: "a2a_list",
      description:
        "List agent threads that can receive A2A messages: session id, title, working directory, status, whether the thread is live, and whether it belongs to a dismissed (archived) orchestra instance. Use the session id with a2a_send / a2a_reply / a2a_read / a2a_create.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            threads: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sessionId: { type: "string", required: true },
                  title: { type: "string" },
                  cwd: { type: "string" },
                  status: { type: "string", required: true },
                  live: { type: "boolean", required: true },
                  archived: { type: "boolean" },
                },
              },
            },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: "text",
            text:
              value.threads.length === 0
                ? "no threads"
                : `${value.threads.length} thread(s): ${value.threads
                    .map((t) => `${t.sessionId}${t.live ? "" : " (cold)"}${t.archived === true ? " (archived)" : ""}${t.title === undefined ? "" : ` (${t.title})`}`)
                    .join(", ")}`,
          },
        ] as ContentBlock[],
      },
      execute() {
        return listThreads(ctx);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_read",
      description:
        "Read the recent conversation of another agent thread (session): the last user/assistant messages, newest last. Useful to inspect what a thread is working on before messaging it. Reads the persisted log, so cold threads work too.",
      parameters: {
        sessionId: { type: "string", required: true, description: "Target session id (see a2a_list)." },
        limit: { type: "number", description: "How many recent messages to return. Defaults to 8, max 20." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            messages: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  role: { type: "string", required: true },
                  text: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: "text",
            text:
              value.messages.length === 0
                ? `thread ${value.sessionId} has no readable messages`
                : `thread ${value.sessionId}: ${value.messages
                    .map((m) => `${m.role}: ${m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text}`)
                    .join(" | ")}`,
          },
        ] as ContentBlock[],
      },
      execute(args: { sessionId: string; limit?: number }) {
        return readSessionText(ctx, args.sessionId, args.limit);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_send",
      description:
        "Send a message to another agent thread. The message becomes that thread's next turn: the receiving agent reads it like a user prompt, attributed to your session id. Find session ids with a2a_list. Returns immediately after the target accepts the message; it does NOT wait for or return the target's answer. To get an answer, tell the recipient to use a2a_reply and expect the reply as your own later turn (you can also a2a_read the target later). Live targets are woken; cold targets are automatically resumed when possible, otherwise queued until they come live. Sending to yourself is rejected. wake=false queues the message as context for the target's next step without waking it. Messages on the default next-turn path are NEVER dropped — a message to a working thread is claimed at its next turn boundary. interrupt=true steers the message into a running target's nearest step boundary (mid-turn) instead of waiting; it is best-effort steering (a rejected/cancelled step may discard pending steering), so use it only for urgent interrupts, not routine task dispatch (which should stay a clean task boundary).",
      parameters: {
        to: { type: "string", required: true, description: "Target session id (see a2a_list)." },
        message: { type: "string", required: true, description: "The message text for the target agent." },
        wake: { type: "boolean", description: "Wake the target to process the message now. Defaults to true." },
        interrupt: { type: "boolean", description: "Deliver as an immediate mid-turn interrupt (steering into the target's nearest step boundary) when the target is running. Idle targets are woken immediately either way. Defaults to false." },
      },
      output: { schema: outputSchema, render: renderResult },
      async execute(args: { to: string; message: string; wake?: boolean; interrupt?: boolean }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("a2a_send requires an agent caller");
        if (args.to === exec.agent.id) throw new Error("a2a: cannot send a message to yourself");
        return deliverMessage(ctx, queue, exec.agent.id, args.to, [
          { type: "text", text: `Message from agent ${exec.agent.id}:` },
          { type: "text", text: args.message },
        ], { wake: args.wake, interrupt: args.interrupt === true });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_reply",
      description:
        "Reply to a message another agent sent you. Delivers your answer back to that agent as its next turn, tagged with the message id you are answering. Incoming a2a messages show their sender session id in the transcript. Returns immediately; the reply does not wait for a further answer. Note the argument name is reply_to (underscore, not camelCase). The reply on the default next-turn path is never dropped; interrupt=true steers it into a running target's nearest step boundary instead (best-effort, only for urgent answers).",
      parameters: {
        to: { type: "string", required: true, description: "Session id of the agent you are answering (the sender of the message you received)." },
        reply_to: { type: "string", required: true, description: "Message id you are answering, or a short marker such as \"your last message\". Note: the argument name is reply_to (underscore)." },
        message: { type: "string", required: true, description: "Your reply text." },
        interrupt: { type: "boolean", description: "Deliver as an immediate mid-turn interrupt (steering into the target's nearest step boundary) when the target is running. Defaults to false." },
      },
      output: { schema: outputSchema, render: renderResult },
      async execute(args: { to: string; reply_to: string; message: string; interrupt?: boolean }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("a2a_reply requires an agent caller");
        if (args.to === exec.agent.id) throw new Error("a2a: cannot reply to yourself");
        return deliverMessage(ctx, queue, exec.agent.id, args.to, [
          { type: "text", text: `Reply from agent ${exec.agent.id} (to message ${args.reply_to}):` },
          { type: "text", text: args.message },
        ], { replyTo: args.reply_to, interrupt: args.interrupt === true });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_create",
      description:
        "Open a new agent thread (session). The new session starts live, appears in the sidebar, and can be addressed with a2a_send / a2a_read. Working directory and agent preset default to the calling thread's; model follows the deployment default.",
      parameters: {
        cwd: { type: "string", description: "Working directory for the new session. Defaults to the calling thread's cwd." },
        presetId: { type: "string", description: "Agent preset id to mount on the new session. Defaults to the deployment default preset." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            cwd: { type: "string" },
            agentPreset: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `new session ${value.sessionId} opened${value.cwd === undefined ? "" : ` in ${value.cwd}`}${value.agentPreset === undefined ? "" : ` (${value.agentPreset})`}`,
          },
        ],
      },
      execute(args: { cwd?: string; presetId?: string }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("a2a_create requires an agent caller");
        return createSession(ctx, {
          cwd: args.cwd ?? exec.agent.session.header.cwd,
          presetId: args.presetId,
          currentSessionId: exec.agent.id,
          signal: exec.signal,
        });
      },
    }),
  );

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: "A2A: you can exchange messages with other agent threads. a2a_list shows the threads; a2a_send delivers a message that becomes the target's next turn; a2a_reply answers a specific message you received; a2a_read inspects another thread's recent conversation; a2a_create opens a new thread. A delivered message does not wait for the target's answer: request a reply explicitly and expect it later as your own new turn. Delivery contract: a message to a thread that is currently working is claimed at its next turn boundary and is NEVER dropped on the default next-turn path; interrupt:true steers it into the target's nearest step boundary (mid-turn) instead — best-effort steering rather than a durable guarantee, so keep routine dispatch on the clean next-turn path.",
    });
  }
}
