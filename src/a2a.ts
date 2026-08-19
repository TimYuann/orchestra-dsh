/**
 * orchestra-dsh/a2a — A2A transport layer: peer-to-peer messaging between agent
 * threads (sessions), delivered as the target thread's next turn.
 *
 * Host-plane plugin. Mirrors the proven dynamic-plugin implementation, now as
 * a native bundle plugin: tools registered through ctx.tools, delivery through
 * the Agent inbox (agent.followup / agent.inject / durable inbox splices), and
 * a cold-target auto-resume (Codex ensure_v2_agent_loaded semantics).
 *
 * v0.3.0 contract (spec §10.3): every send/reply returns a delivery receipt
 * {message_id, target_session_id, accepted_at_ms, delivery_mode, interrupt}
 * with delivery_mode ∈ {live_inbox, durable_inbox, resumed_inbox}. The
 * unreliable in-memory `queued` success mode is gone: a truly cold target is
 * awaited through resume and the tool fails loudly when resume fails.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, MessageSource } from "@deepseek-ai/dsh-llm";
import { mountPreset, resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
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

/** A preset resolved to a concrete composition file (spec §5.3). */
export interface ResolvedPresetFile {
  id: string;
  /** DSH preset trust label; project-level presets count as "user". */
  trust: "system" | "user";
  /** Absolute path to the preset's agent.cordis.yml. */
  path: string;
}

/** Create one agent thread (session) with model default + preset composition. */
export async function createSession(
  ctx: Context,
  options: {
    sessionId?: string;
    cwd?: string;
    /** DSH-native preset id (resolved through ctx.agentPresets). */
    presetId?: string;
    /** Orchestra-resolved preset file (project/global/builtin), takes precedence over presetId. */
    presetFile?: ResolvedPresetFile;
    currentSessionId?: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    /** Display title pinned on the new session (e.g. "my-project · implementer · trio"; slug = path.basename(cwd)). */
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
  if (options.presetFile !== undefined) {
    // Orchestra-resolved preset (project > global > builtin): mount the file
    // directly — no DSH resolver root registration needed (spec §5.3).
    const file = options.presetFile;
    agentPreset = file.id;
    setup = async (agentCtx) => {
      await mountPreset(agentCtx, { id: file.id, trust: file.trust, path: file.path });
      installModelOverride(agentCtx, modelOverride, overrideProvider, overrideModel, options.reasoningEffort);
    };
  } else if (options.presetId !== undefined && options.presetId !== "") {
    const presets = ctx.get("agentPresets");
    if (presets !== undefined) {
      const resolved = await presets.resolve(options.presetId);
      agentPreset = resolved.id;
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id);
        installModelOverride(agentCtx, modelOverride, overrideProvider, overrideModel, options.reasoningEffort);
      };
    }
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

/** Resume a cold session so a message can be delivered to a live agent. Throws on failure (spec §10.3). */
async function tryResume(ctx: Context, sessionId: string): Promise<void> {
  const presets = ctx.get("agentPresets");
  const query = ctx.get("sessionQuery");
  if (presets === undefined || query === undefined)
    throw new Error(`a2a: cannot resume ${sessionId} — sessionQuery/agentPresets services unavailable`);
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

/** Delivery receipt returned by a2a_send / a2a_reply (spec §10.3). */
export interface DeliverResult {
  message_id: string;
  target_session_id: string;
  accepted_at_ms: number;
  delivery_mode: "live_inbox" | "durable_inbox" | "resumed_inbox";
  /** Present when delivery used the interrupt (steer) path — best-effort mid-turn steering. */
  interrupt?: boolean;
  /** Present on replies: the message id this reply answers. */
  reply_to_message_id?: string;
}

/**
 * Core delivery: live agent → followup/inject (interrupt → steer); attached →
 * durable inbox splice; truly cold → await resume then deliver, or throw.
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
export async function deliverMessage(
  ctx: Context,
  senderSessionId: string | undefined,
  toSessionId: string,
  contentBlocks: ContentBlock[],
  options: { wake?: boolean; replyTo?: string; interrupt?: boolean } = {},
): Promise<DeliverResult> {
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
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    };
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
    return {
      message_id: message.id,
      target_session_id: toSessionId,
      accepted_at_ms: acceptedAt,
      delivery_mode: "durable_inbox",
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    };
  }
  // Truly cold: await the resume — success means the message enters the inbox
  // now (resumed_inbox); failure throws and the message is NOT delivered
  // (no fire-and-forget queue, no fake "queued" success — spec §10.3).
  await tryResume(ctx, toSessionId);
  const agent = ctx.agents.get(SID(toSessionId));
  if (agent === undefined) throw new Error(`a2a: target ${toSessionId} could not be resumed`);
  try {
    if (wake) agent.followup(message);
    else agent.inject(message);
  } catch (error) {
    console.error(
      `a2a: post-resume delivery to ${toSessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  return {
    message_id: message.id,
    target_session_id: toSessionId,
    accepted_at_ms: acceptedAt,
    delivery_mode: "resumed_inbox",
    ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
  };
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

/**
 * Resolve the set of session ids that legally belong to the team at `cwd`.
 * Includes the current (non-archived) team.json roles plus every archive/*
 * snapshot — so a session id from a dismissed instance is still legal as
 * long as it belongs to *this* cwd. Used by a2a_send to reject cross-cwd
 * dispatch. Returns an empty set when no fs service is available.
 *
 * v0.3.0: dismissed teams leave NO state/team.json (deleted), so the active
 * source is the file when it exists; archives are the fallback set.
 */
export async function collectTeamSessionIds(ctx: Context, cwd: string | undefined): Promise<Set<string>> {
  const ids = new Set<string>();
  if (typeof cwd !== "string" || cwd === "") return ids;
  const fs = ctx.get("fs");
  if (fs === undefined) return ids;
  // Active team (v1.0 marker or v1.1 state — both are "no active roles" for
  // dispatch purposes when archived === true / status === "dismissed").
  try {
    const target = await fs.resolve(`${cwd}/orchestra/state/team.json`, { cwd });
    const raw = JSON.parse(await fs.readText(target)) as {
      archived?: boolean;
      status?: string;
      roles?: { sessionId?: string }[];
    };
    if (raw.archived !== true && raw.status !== "dismissed" && Array.isArray(raw.roles)) {
      for (const role of raw.roles) {
        if (typeof role.sessionId === "string" && role.sessionId !== "") ids.add(role.sessionId);
      }
    }
  } catch {
    // no active team
  }
  // Archived teams (each file is one dismissed instance's full snapshot)
  try {
    const dir = await fs.resolve(`${cwd}/orchestra/archive`, { cwd });
    const info = await fs.stat(dir);
    if (info !== undefined) {
      const entries = await fs.listDir(dir);
      for (const entry of entries) {
        if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(await fs.readText(entry.target)) as { roles?: { sessionId?: string }[] };
          for (const role of raw.roles ?? []) {
            if (typeof role.sessionId === "string" && role.sessionId !== "") ids.add(role.sessionId);
          }
        } catch {
          // skip unparseable archive files
        }
      }
    }
  } catch {
    // no orchestra/archive directory
  }
  return ids;
}

/**
 * Scan every known cwd's orchestra state and produce, per session id, its
 * authoritative category — backed by team.json (current) or archive/ (archived)
 * *physical location*, not by the (potentially user-edited) session header
 * cwd. Returns a map keyed by session id with the cwd where it was found
 * and the category: "active" (current team.json), "archived" (archive/*.json),
 * or absent (no team backing — caller decides how to label/filter).
 */
async function scanTeamRoster(
  ctx: Context,
  unknownCwds: Set<string>,
): Promise<Map<string, { cwd: string; category: "active" | "archived" }>> {
  const map = new Map<string, { cwd: string; category: "active" | "archived" }>();
  const fs = ctx.get("fs");
  if (fs === undefined) return map;
  for (const cwd of unknownCwds) {
    try {
      const target = await fs.resolve(`${cwd}/orchestra/state/team.json`, { cwd });
      const raw = JSON.parse(await fs.readText(target)) as {
        archived?: boolean;
        status?: string;
        roles?: { sessionId?: string }[];
      };
      if (raw.archived !== true && raw.status !== "dismissed" && Array.isArray(raw.roles)) {
        for (const role of raw.roles) {
          if (typeof role.sessionId === "string" && role.sessionId !== "" && !map.has(role.sessionId)) {
            map.set(role.sessionId, { cwd, category: "active" });
          }
        }
      }
    } catch {
      // no current team
    }
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
            if (typeof role.sessionId === "string" && role.sessionId !== "" && !map.has(role.sessionId)) {
              map.set(role.sessionId, { cwd, category: "archived" });
            }
          }
        } catch {
          // skip unparseable archive files
        }
      }
    } catch {
      // no orchestra/archive directory
    }
  }
  return map;
}

/** Active team membership annotation for the caller's cwd (spec §11). */
async function readCurrentCwdTeam(ctx: Context, cwd: string | undefined): Promise<Map<string, { team_id: string; role_id: string }>> {
  const map = new Map<string, { team_id: string; role_id: string }>();
  if (typeof cwd !== "string" || cwd === "") return map;
  const fs = ctx.get("fs");
  if (fs === undefined) return map;
  try {
    const target = await fs.resolve(`${cwd}/orchestra/state/team.json`, { cwd });
    const raw = JSON.parse(await fs.readText(target)) as {
      archived?: boolean;
      status?: string;
      teamId?: string;
      roles?: { id?: string; sessionId?: string }[];
    };
    if (raw.archived !== true && raw.status !== "dismissed" && Array.isArray(raw.roles)) {
      const teamId = typeof raw.teamId === "string" && raw.teamId !== "" ? raw.teamId : "team-unknown";
      for (const role of raw.roles) {
        if (typeof role.sessionId === "string" && role.sessionId !== "") {
          map.set(role.sessionId, { team_id: teamId, role_id: role.id ?? "" });
        }
      }
    }
  } catch {
    // no active team at the caller's cwd
  }
  return map;
}

export interface ThreadEntry {
  sessionId: string;
  title?: string;
  cwd?: string;
  status: string;
  live: boolean;
  archived?: boolean;
  /** active | archived | other (cross-cwd) — "other" only when includeOtherCwds. */
  category?: "active" | "archived" | "other";
  /** caller-relative team membership (spec §11): non-null only for the caller's cwd ACTIVE team. */
  current_cwd_team?: { team_id: string; role_id: string } | null;
}

/**
 * List live + recent cold threads with title/status/cwd — progressive
 * disclosure (spec §11):
 *
 * - Sorting: the caller's cwd group first, other cwds after (only when
 *   includeOtherCwds); within a group, live entries first, then cold entries
 *   in newest-first session-corpus order.
 * - Default return: the caller's cwd active-team roles + other live sessions
 *   of that cwd + recent cold sessions, capped by `limit`.
 * - Archived roles are folded away by default; pass includeArchived to reveal
 *   them (labeled archived).
 * - Lightweight mode: when the caller's cwd has no orchestra footprint
 *   (no active team and no archive), no cwd filtering applies — the full
 *   session corpus is listed (limit/offset still apply).
 */
export async function listThreads(
  ctx: Context,
  options: { limit?: number; offset?: number; driverCwd?: string; includeOtherCwds?: boolean; includeArchived?: boolean } = {},
): Promise<{ threads: ThreadEntry[] }> {
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const driverCwd = options.driverCwd;
  const includeOtherCwds = options.includeOtherCwds === true;
  const includeArchived = options.includeArchived === true;
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
    .slice(0, 200);
  const ids = [...liveEntries.map((entry: any) => entry.sessionId), ...cold.map((record: any) => record.header.id)];
  const observations = await query.readTitleSnapshots(ids);
  const titles = new Map<string, string>();
  for (const observation of observations) {
    if (observation.status === "fulfilled" && observation.value.title !== undefined) {
      titles.set(observation.sessionId, observation.value.title.title);
    }
  }
  // Authoritative roster from team.json/archive on disk: per-cwd scan keyed
  // by session id with category (active | archived).
  const unknownCwds = new Set<string>();
  for (const entry of liveEntries) if (entry.cwd !== undefined) unknownCwds.add(entry.cwd);
  for (const record of cold) if (record.header.cwd !== undefined) unknownCwds.add(record.header.cwd);
  if (driverCwd !== undefined && driverCwd !== "") unknownCwds.add(driverCwd);
  const roster = await scanTeamRoster(ctx, unknownCwds);
  // Caller-relative annotation: only the caller's cwd ACTIVE team.
  const teamMembership = await readCurrentCwdTeam(ctx, driverCwd);
  // Lightweight-mode check: does the caller's cwd have any orchestra footprint
  // (an active team or an archive)? Only then does cwd filtering apply.
  const hasOrchestra = driverCwd === undefined || driverCwd === ""
    ? false
    : [...roster.values()].some((v) => v.cwd === driverCwd);
  const filterMode = hasOrchestra;

  const classified = (sid: string): {
    keep: boolean;
    archived: boolean;
    category?: "active" | "archived" | "other";
  } => {
    const found = roster.get(sid);
    if (found !== undefined) {
      if (!filterMode) {
        return { keep: true, archived: found.category === "archived", category: found.category };
      }
      if (found.cwd === driverCwd) {
        if (found.category === "archived" && !includeArchived) {
          return { keep: false, archived: true };
        }
        return { keep: true, archived: found.category === "archived", category: found.category };
      }
      if (includeOtherCwds) {
        return { keep: true, archived: found.category === "archived", category: "other" };
      }
      return { keep: false, archived: found.category === "archived" };
    }
    if (!filterMode) return { keep: true, archived: false };
    // Wild session (no team backing at any known cwd): dropped in filter mode.
    return { keep: false, archived: false };
  };

  const threads: ThreadEntry[] = [];
  for (const entry of liveEntries) {
    const cls = classified(entry.sessionId);
    if (!cls.keep) continue;
    threads.push({
      ...entry,
      ...(titles.get(entry.sessionId) === undefined ? {} : { title: titles.get(entry.sessionId) }),
      ...(cls.archived ? { archived: true } : {}),
      ...(cls.category === undefined ? {} : { category: cls.category }),
      ...(teamMembership.has(entry.sessionId)
        ? { current_cwd_team: teamMembership.get(entry.sessionId) }
        : { current_cwd_team: null }),
    });
  }
  for (const record of cold) {
    const cls = classified(record.header.id);
    if (!cls.keep) continue;
    threads.push({
      sessionId: record.header.id,
      cwd: record.header.cwd,
      status: "cold",
      live: false,
      ...(titles.get(record.header.id) === undefined ? {} : { title: titles.get(record.header.id) }),
      ...(cls.archived ? { archived: true } : {}),
      ...(cls.category === undefined ? {} : { category: cls.category }),
      ...(teamMembership.has(record.header.id)
        ? { current_cwd_team: teamMembership.get(record.header.id) }
        : { current_cwd_team: null }),
    });
  }
  // Progressive-disclosure ordering (spec §11):
  // caller cwd first (live before cold, corpus newest-first within), then
  // other cwds grouped by cwd, then archived (when included).
  const rank = (t: ThreadEntry): [number, number, number] => {
    const sameCwd = driverCwd !== undefined && t.cwd === driverCwd ? 0 : 1;
    const liveRank = t.live ? 0 : 1;
    const archivedRank = t.archived === true ? 1 : 0;
    return [sameCwd, liveRank, archivedRank];
  };
  threads.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.sessionId.localeCompare(b.sessionId);
  });
  return { threads: threads.slice(offset, offset + limit) };
}

const SECTION_NAME = "tool:a2a";
const SECTION_ORDER = 118;

export const Config = undefined;

export function apply(ctx: Context): void {
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      message_id: { type: "string", required: true },
      target_session_id: { type: "string", required: true },
      accepted_at_ms: { type: "number", required: true },
      delivery_mode: { type: "string", required: true },
      interrupt: { type: "boolean" },
      reply_to_message_id: { type: "string" },
    },
  } as const;
  const renderResult = (
    _args: unknown,
    value: {
      message_id: string;
      target_session_id: string;
      accepted_at_ms: number;
      delivery_mode: string;
      interrupt?: boolean;
      reply_to_message_id?: string;
    },
  ): ContentBlock[] => [
    {
      type: "text",
      text:
        value.delivery_mode === "live_inbox"
          ? value.interrupt === true
            ? `message ${value.message_id} steered to agent ${value.target_session_id} (mid-turn interrupt)`
            : `message ${value.message_id} accepted into agent ${value.target_session_id}'s inbox (live)`
          : value.delivery_mode === "durable_inbox"
            ? `message ${value.message_id} recorded durably for agent ${value.target_session_id}; delivered when that thread resumes`
            : `message ${value.message_id} accepted after resuming agent ${value.target_session_id}`,
    },
  ] as ContentBlock[];

  ctx.tools.register(
    defineTool({
      name: "a2a_list",
      description:
        "List agent threads that can receive A2A messages: session id, title, working directory, status, whether the thread is live, its current_cwd_team annotation (non-null only when the session belongs to the caller's cwd ACTIVE team), and whether it belongs to a dismissed (archived) orchestra instance. Progressive disclosure: by default only the caller's cwd threads are shown (archived folded away, capped by limit); pass includeOtherCwds:true to reveal other workspaces, includeArchived:true to reveal archived role sessions, limit/offset to page. When the caller's cwd has no orchestra footprint at all, the full session corpus is listed (lightweight mode). Use the session id with a2a_send / a2a_reply / a2a_read / a2a_create.",
      parameters: {
        limit: { type: "number", description: "Max threads returned. Defaults to 30, max 100." },
        offset: { type: "number", description: "Pagination offset. Defaults to 0." },
        includeOtherCwds: {
          type: "boolean",
          description:
            "When true, also surface threads from cwds other than the calling driver's cwd (each labeled with its cwd). Defaults to false.",
        },
        includeArchived: {
          type: "boolean",
          description: "When true, also surface archived role sessions of the caller's cwd (labeled archived). Defaults to false.",
        },
      },
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
                  category: { type: "string", enum: ["active", "archived", "other"] },
                  current_cwd_team: {
                    oneOf: [
                      {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          team_id: { type: "string", required: true },
                          role_id: { type: "string", required: true },
                        },
                      },
                      { type: "null" },
                    ],
                  },
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
                    .map((t) => {
                      const tag =
                        t.category === "active"
                          ? ` (active${t.current_cwd_team === null || t.current_cwd_team === undefined ? "" : `, team=${t.current_cwd_team.team_id}/${t.current_cwd_team.role_id}`})`
                          : t.category === "archived"
                            ? " (archived)"
                            : t.category === "other"
                              ? ` (cwd=${t.cwd ?? "unknown"})`
                              : t.archived === true
                                ? " (archived)"
                                : "";
                      return `${t.sessionId}${t.live ? "" : " (cold)"}${tag}${t.title === undefined ? "" : ` (${t.title})`}`;
                    })
                    .join(", ")}`,
          },
        ] as ContentBlock[],
      },
      async execute(
        args: { limit?: number; offset?: number; includeOtherCwds?: boolean; includeArchived?: boolean },
        exec: ToolExecutionInput,
      ) {
        const driverCwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd;
        return listThreads(ctx, {
          limit: args.limit,
          offset: args.offset,
          driverCwd,
          includeOtherCwds: args.includeOtherCwds === true,
          includeArchived: args.includeArchived === true,
        });
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
        "Send a message to another agent thread. The message becomes that thread's next turn: the receiving agent reads it like a user prompt, attributed to your session id. Find session ids with a2a_list. Returns immediately after the target accepts the message; it does NOT wait for or return the target's answer. To get an answer, tell the recipient to use a2a_reply and expect the reply as your own later turn (you can also a2a_read the target later). Live targets are woken; attached-but-idle targets receive a durable inbox splice; truly cold targets are resumed first — resume failure makes the call fail (no queued fallback). Sending to yourself is rejected. wake=false queues the message as context for the target's next step without waking it. Messages on the default next-turn path are NEVER dropped — a message to a working thread is claimed at its next turn boundary. interrupt=true steers the message into a running target's nearest step boundary (mid-turn) instead of waiting; it is best-effort steering (a rejected/cancelled step may discard pending steering), so use it only for urgent interrupts, not routine task dispatch (which should stay a clean task boundary).",
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
        // Bug #1 — reject cross-cwd dispatch: the target sessionId must belong
        // to a team (active or archived) at the calling driver's cwd. Sessions
        // that simply *happen* to be live here but were created in another
        // cwd's orchestra instance cannot be addressed silently; the driver
        // gets an explicit error listing every legal sessionId so it can pick
        // one. Wild sessions (a2a_create outside orchestra) are not rejected
        // when the caller's cwd has NO team footprint at all (lightweight
        // mode) — the legal set is empty then and everything passes.
        const driverCwd = exec.agent.session.header.cwd;
        if (typeof driverCwd === "string" && driverCwd !== "") {
          const legalIds = await collectTeamSessionIds(ctx, driverCwd);
          if (legalIds.size > 0 && !legalIds.has(args.to)) {
            const sample = [...legalIds].slice(0, 12).join(", ");
            const more = legalIds.size > 12 ? ` (and ${legalIds.size - 12} more)` : "";
            throw new Error(
              `a2a_send: target ${args.to} does not belong to any team at cwd=${driverCwd}; legal sessionIds: ${sample}${more}`,
            );
          }
        }
        return deliverMessage(ctx, exec.agent.id, args.to, [
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
        return deliverMessage(ctx, exec.agent.id, args.to, [
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
      text: "A2A: you can exchange messages with other agent threads. a2a_list shows the threads (progressive disclosure: your cwd first, archived folded by default); a2a_send delivers a message that becomes the target's next turn; a2a_reply answers a specific message you received; a2a_read inspects another thread's recent conversation; a2a_create opens a new thread. A delivered message does not wait for the target's answer: request a reply explicitly and expect it later as your own new turn. Receipts: send/reply return delivery_mode live_inbox (accepted into the target's inbox, NOT yet processed) / durable_inbox (recorded for a suspended thread) / resumed_inbox (cold thread resumed first). Delivery contract: a message to a thread that is currently working is claimed at its next turn boundary and is NEVER dropped on the default next-turn path; interrupt:true steers it into the target's nearest step boundary (mid-turn) instead — best-effort steering rather than a durable guarantee, so keep routine dispatch on the clean next-turn path.",
    });
  }
}
