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
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { mountPreset } from "@deepseek-ai/dsh-agent-presets";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { AgentHandle, AgentSetup } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-title";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/cordis-plugin-timer";
import { randomUUID } from "node:crypto";
import { prepareLightweightBlueprint } from "./session-blueprint.js";
import type { GovernedBlueprintReceipt, PreparedGovernedBlueprint, LightweightBlueprintReceipt } from "./session-blueprint.js";
import { deliverMessage, queryMessageStatus, readDeliveryReceipt } from "./a2a-transport.js";
export { deliverMessage, queryMessageStatus, readDeliveryReceipt } from "./a2a-transport.js";
export type { DeliverResult, MessageLifecycleState, MessageStatusResult } from "./a2a-transport.js";
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
  /** Resolution layer; Governed Blueprint uses DSH-native ids through AgentPresets.mount. */
  source?: "project" | "global" | "dsh" | "builtin";
}

/** Create one agent thread (session) with model default + preset composition. */
export interface CreateSessionOptions {
    sessionId?: string;
    cwd?: string;
    /** DSH-native preset id (resolved through ctx.agentPresets). */
    presetId?: string;
    /** Lightweight alias for an explicit Agent Preset id. */
    agentPresetId?: string;
    /** Orchestra-resolved preset file (project/global/builtin), takes precedence over presetId. */
    presetFile?: ResolvedPresetFile;
    currentSessionId?: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    /** Provision through a complete mode-specific Session Blueprint seam. */
    mode?: "lightweight" | "governed";
    permissionPreset?: string;
    requiredTools?: string[];
    callerAgent?: import("@deepseek-ai/dsh-agent").Agent;
    /** Prepared Governed role Blueprint; only orchestra provisioning supplies this. */
    governedBlueprint?: PreparedGovernedBlueprint;
    /** Return the owned handle to a transactional caller for explicit cleanup. */
    returnHandle?: boolean;
    /** Display title pinned on the new session (e.g. "my-project · implementer · trio"; slug = path.basename(cwd)). */
    title?: string;
    signal?: AbortSignal;
}

export interface SessionCreateResult {
  sessionId: string;
  cwd?: string;
  agentPreset?: string;
  mode?: "lightweight" | "governed";
  governedBlueprint?: GovernedBlueprintReceipt;
  handle?: AgentHandle;
  permissionPreset?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  title?: string;
  tools?: { names: string[]; count: number };
}

export interface LightweightSessionCreateResult extends SessionCreateResult {
  mode: "lightweight";
  agentPreset: string;
  permissionPreset: string;
  provider: string;
  model: string;
  tools: { names: string[]; count: number };
}

export function createSession(ctx: Context, options: CreateSessionOptions & { mode: "lightweight" }): Promise<LightweightSessionCreateResult>;
export function createSession(ctx: Context, options?: CreateSessionOptions): Promise<SessionCreateResult>;
export async function createSession(ctx: Context, options: CreateSessionOptions = {}): Promise<SessionCreateResult> {
  const sessionId =
    typeof options.sessionId === "string" && options.sessionId !== ""
      ? options.sessionId
      : `session-${randomUUID()}`;
  const sid = SID(sessionId);
  if (ctx.agents.get(sid) !== undefined)
    throw new Error(`a2a: session "${sessionId}" already exists`);
  const cwd = typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : undefined;
  const lightweight = options.mode === "lightweight";
  const governed = options.mode === "governed";
  let agentOptions: { provider?: string; model?: string } = {};
  let setup: AgentSetup | undefined;
  let agentPreset: string | undefined;
  let blueprintReceipt: LightweightBlueprintReceipt | undefined;
  let governedReceipt: GovernedBlueprintReceipt | undefined;
  let governedMeta: { cwd: string; agentPreset: string } | undefined;
  const model = ctx.get("agentDefaultModel");
  const selection = model === undefined ? undefined : model.currentSelection();
  const modelOverride =
    options.provider !== undefined || options.model !== undefined || options.reasoningEffort !== undefined;
  const overrideProvider = options.provider ?? selection?.provider;
  const overrideModel = options.model ?? selection?.model;
  if (!lightweight) {
    agentOptions =
      options.provider !== undefined || options.model !== undefined
        ? {
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
            ...(options.model !== undefined ? { model: options.model } : {}),
          }
        : selection === undefined
          ? {}
          : { provider: selection.provider, model: selection.model };
  }
  if (lightweight) {
    const blueprint = await prepareLightweightBlueprint(ctx, {
      sessionId,
      caller: options.callerAgent,
      createdBySessionId: options.currentSessionId ?? options.callerAgent?.id,
      cwd,
      presetId: options.agentPresetId ?? options.presetId,
      ...(options.presetFile === undefined ? {} : { presetFile: options.presetFile }),
      permissionPreset: options.permissionPreset,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      title: options.title,
      requiredTools: options.requiredTools,
      signal: options.signal,
    });
    agentOptions = blueprint.agentOptions;
    setup = blueprint.setup;
    agentPreset = blueprint.receipt.agentPreset;
    blueprintReceipt = blueprint.receipt;
  } else if (governed) {
    const blueprint = options.governedBlueprint;
    if (blueprint === undefined) throw new Error("a2a: governed createSession requires a prepared Governed Session Blueprint");
    if (blueprint.receipt.sessionId !== sessionId) throw new Error(`a2a: governed Blueprint session id ${blueprint.receipt.sessionId} does not match ${sessionId}`);
    agentOptions = blueprint.agentOptions;
    setup = blueprint.setup;
    agentPreset = blueprint.receipt.agentPreset;
    governedReceipt = blueprint.receipt;
    governedMeta = blueprint.meta;
  } else if (options.presetFile !== undefined) {
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
    if (presets === undefined) throw new Error(`a2a: agentPresets service is unavailable for preset "${options.presetId}"`);
    const resolved = await presets.resolve(options.presetId);
    agentPreset = resolved.id;
    setup = async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id);
      installModelOverride(agentCtx, modelOverride, overrideProvider, overrideModel, options.reasoningEffort);
    };
  } else {
    throw new Error("a2a: createSession requires a complete Agent Preset; mode=lightweight resolves one when no preset is explicit");
  }
  const handle = await ctx.agents.create({
    sessionId: sid,
    agentOptions,
    meta: {
      ...(governedMeta === undefined ? (cwd === undefined ? {} : { cwd }) : governedMeta),
      ...(governedMeta === undefined && agentPreset !== undefined ? { agentPreset } : {}),
    },
    ...(setup === undefined ? {} : { setup }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!lightweight && !governed && typeof options.title === "string" && options.title !== "") {
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
    ...(blueprintReceipt === undefined
      ? {}
      : {
          mode: blueprintReceipt.mode,
          permissionPreset: blueprintReceipt.permissionPreset,
          provider: blueprintReceipt.provider,
          model: blueprintReceipt.model,
          ...(blueprintReceipt.reasoningEffort === undefined ? {} : { reasoningEffort: blueprintReceipt.reasoningEffort }),
          ...(blueprintReceipt.title === undefined ? {} : { title: blueprintReceipt.title }),
          tools: blueprintReceipt.tools,
        }),
    ...(governedReceipt === undefined ? {} : { mode: governedReceipt.mode, governedBlueprint: governedReceipt }),
    ...(options.returnHandle ? { handle } : {}),
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
  let fs;
  try {
    fs = ctx.get("fs");
  } catch {
    return map;
  }
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
  let fs;
  try {
    fs = ctx.get("fs");
  } catch {
    return map;
  }
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
  /** active | archived | other (cross-cwd); annotation, never an ACL. */
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
 * - Default return: all host sessions, caller cwd first, capped by `limit`.
 * - Archived roles are folded away by default; pass includeArchived to reveal
 *   them (labeled archived).
 * - `includeOtherCwds` remains a compatibility input but never acts as a
 *   Transport ACL; annotations distinguish other cwd and wild sessions.
 */
export async function listThreads(
  ctx: Context,
  options: { limit?: number; offset?: number; driverCwd?: string; includeOtherCwds?: boolean; includeArchived?: boolean } = {},
): Promise<{ threads: ThreadEntry[] }> {
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const driverCwd = options.driverCwd;
  // Kept in the input for compatibility; raw transport/discovery visibility
  // is host-wide and cannot be narrowed by Team/CWD policy.
  void options.includeOtherCwds;
  const includeArchived = options.includeArchived === true;
  const live = ctx.agents.list();
  const liveEntries = live.map((agent) => ({
    sessionId: agent.id,
    cwd: agent.session.header.cwd,
    status: agent.status,
    live: true,
  }));
  let query;
  try {
    query = ctx.get("sessionQuery");
  } catch {
    return { threads: liveEntries };
  }
  if (query === undefined) return { threads: liveEntries };
  let records: any[];
  try {
    records = await query.listSessions();
  } catch {
    // Discovery is progressive: a failed corpus adapter must not hide live reachability.
    return { threads: liveEntries };
  }
  const cold = records
    .filter((record: any) => record.live !== true && !liveEntries.some((entry: any) => entry.sessionId === record.header.id))
    .slice(0, 200);
  const ids = [...liveEntries.map((entry: any) => entry.sessionId), ...cold.map((record: any) => record.header.id)];
  let observations: any[] = [];
  try {
    observations = await query.readTitleSnapshots(ids);
  } catch {
    // Titles are optional annotations; keep the session rows visible.
  }
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
  const classified = (sid: string): {
    keep: boolean;
    archived: boolean;
    category?: "active" | "archived" | "other";
  } => {
    const found = roster.get(sid);
    if (found === undefined) return { keep: true, archived: false };
    if (found.category === "archived" && !includeArchived) return { keep: false, archived: true };
    return {
      keep: true,
      archived: found.category === "archived",
      category: found.cwd === driverCwd ? found.category : "other",
    };
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
  const liveOrder = new Map<string, number>(liveEntries.map((entry, index) => [String(entry.sessionId), index]));
  const coldOrder = new Map<string, number>(cold.map((record: any, index: number) => [String(record.header.id), index]));
  const rank = (t: ThreadEntry): [number, number, number, number] => {
    const sameCwd = driverCwd !== undefined && t.cwd === driverCwd ? 0 : 1;
    const liveRank = t.live ? 0 : 1;
    const archivedRank = t.archived === true ? 1 : 0;
    const recency = t.live ? liveOrder.get(t.sessionId) ?? Number.MAX_SAFE_INTEGER : coldOrder.get(t.sessionId) ?? Number.MAX_SAFE_INTEGER;
    return [sameCwd, liveRank, archivedRank, recency];
  };
  threads.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.sessionId.localeCompare(b.sessionId);
  });
  return { threads: threads.slice(offset, offset + limit) };
}

const SECTION_NAME = "tool:a2a";
const SECTION_ORDER = 118;

export const Config = undefined;

export interface RawA2ASendArgs {
  to: string;
  message: string;
  wake?: boolean;
  interrupt?: boolean;
  idempotencyKey?: string;
}

/** Bounded raw-send entrypoint shared by a2a_send and its cross-cwd harness. */
export async function sendRawA2A(ctx: Context, args: RawA2ASendArgs, exec: ToolExecutionInput) {
  if (exec.agent === undefined) throw new Error("a2a_send requires an agent caller");
  if (args.to === exec.agent.id) throw new Error("a2a: cannot send a message to yourself");
  return deliverMessage(ctx, exec.agent.id, args.to, [
    { type: "text", text: `Message from agent ${exec.agent.id}:` },
    { type: "text", text: args.message },
  ], { wake: args.wake, interrupt: args.interrupt === true, idempotencyKey: args.idempotencyKey });
}

export function apply(ctx: Context): void {
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      message_id: { type: "string", required: true },
      target_session_id: { type: "string", required: true },
      accepted_at_ms: { type: "number", required: true },
      delivery_mode: { type: "string", required: true },
      state: { type: "string", required: true },
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
      state: string;
      interrupt?: boolean;
      reply_to_message_id?: string;
    },
  ): ContentBlock[] => [
    {
      type: "text",
      text:
        value.state === "accepted"
          ? `message ${value.message_id} accepted for ${value.target_session_id} (${value.delivery_mode}${value.interrupt === true ? ", interrupt" : ""}); no answer awaited`
          : value.delivery_mode === "live_inbox"
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
        "List the host's A2A sessions with session id, title, working directory, status, liveness, and honest Team/archive annotations. The caller cwd sorts first, but other cwd and wild sessions remain visible; annotations are not Transport ACLs. Archived roles are folded unless includeArchived:true. includeOtherCwds is retained for compatibility and does not hide sessions. Use the session id with a2a_send / a2a_reply / a2a_read / a2a_create.",
      parameters: {
        limit: { type: "number", description: "Max threads returned. Defaults to 30, max 100." },
        offset: { type: "number", description: "Pagination offset. Defaults to 0." },
        includeOtherCwds: {
          type: "boolean",
          description: "Compatibility input; other cwd sessions are visible by default and this flag does not act as an ACL.",
        },
        includeArchived: {
          type: "boolean",
          description: "When true, surface archived role sessions (labeled archived). Defaults to false.",
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
        "Send a raw SessionId-addressed A2A message across the host. Transport does not require an Orchestra Team or same cwd; use orchestra_send when addressing a Governed role by teamId+roleId. The message becomes the target's next turn and returns state=accepted without waiting for claimed/answered. Live targets are woken; attached targets receive a durable inbox splice; cold targets are resumed first and resume failure is loud. Sending to yourself is rejected. wake=false queues context without waking; interrupt=true is best-effort steering.",
      parameters: {
        to: { type: "string", required: true, description: "Target session id (see a2a_list)." },
        message: { type: "string", required: true, description: "The message text for the target agent." },
        wake: { type: "boolean", description: "Wake the target to process the message now. Defaults to true." },
        interrupt: { type: "boolean", description: "Deliver as an immediate mid-turn interrupt (steering into the target's nearest step boundary) when the target is running. Idle targets are woken immediately either way. Defaults to false." },
        idempotencyKey: { type: "string", description: "Optional retry key; repeated delivery with the same target and key returns the original accepted receipt." },
      },
      output: { schema: outputSchema, render: renderResult },
      async execute(args: RawA2ASendArgs, exec: ToolExecutionInput) {
        return sendRawA2A(ctx, args, exec);
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
        idempotency_key: { type: "string", description: "Optional retry key; repeated delivery with the same target and key returns the original accepted receipt." },
      },
      output: { schema: outputSchema, render: renderResult },
      async execute(args: { to: string; reply_to: string; message: string; interrupt?: boolean; idempotency_key?: string }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("a2a_reply requires an agent caller");
        if (args.to === exec.agent.id) throw new Error("a2a: cannot reply to yourself");
        return deliverMessage(ctx, exec.agent.id, args.to, [
          { type: "text", text: `Reply from agent ${exec.agent.id} (to message ${args.reply_to}):` },
          { type: "text", text: args.message },
        ], { replyTo: args.reply_to, interrupt: args.interrupt === true, idempotencyKey: args.idempotency_key });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_status",
      description: "Inspect the reconstructable lifecycle facts for one accepted A2A message. Status is monotonic accepted → claimed → answered only when correlated Session events prove the transition; otherwise it remains unknown. Query failure never affects delivery.",
      parameters: {
        messageId: { type: "string", required: true, description: "The message_id returned by a2a_send or a2a_reply." },
        targetSessionId: { type: "string", required: true, description: "The target session id used for delivery." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            message_id: { type: "string", required: true },
            target_session_id: { type: "string", required: true },
            state: { type: "string", required: true },
            evidence: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `message ${value.message_id} for ${value.target_session_id}: ${value.state}${value.evidence === undefined ? "" : ` (${value.evidence})`}` }] as ContentBlock[],
      },
      execute(args: { messageId: string; targetSessionId: string }) {
        return queryMessageStatus(ctx, args.messageId, args.targetSessionId);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_create",
      description:
        "Open a complete lightweight agent Session. Before publication it resolves and installs an Agent Preset composition, pins a Permission Preset and Model Selection, records a lightweight blueprint marker, fixes the title, and verifies required tools. If the caller has a composed preset, the child joins that exact generation; a rosterless caller mounts the deployment default or fails loudly. The new session appears only after setup/commit succeeds.",
      parameters: {
        cwd: { type: "string", description: "Working directory for the new session. Defaults to the calling thread's cwd." },
        presetId: { type: "string", description: "Legacy-compatible explicit Agent Preset id." },
        agentPreset: { type: "string", description: "Explicit Agent Preset id; takes precedence over presetId." },
        permissionPreset: { type: "string", description: "Permission Preset to pin; defaults to permissionPresets.defaultPreset." },
        provider: { type: "string", description: "Explicit model provider; must be paired with model." },
        model: { type: "string", description: "Explicit model id; must be paired with provider." },
        reasoningEffort: { type: "string", description: "Optional reasoning effort; requires provider and model." },
        title: { type: "string", description: "Title pinned before the Session is published." },
        requiredTools: { type: "array", items: { type: "string" }, description: "Optional tool names that must be visible in the child scope before publication." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            cwd: { type: "string" },
            agentPreset: { type: "string", required: true },
            mode: { type: "string", required: true },
            permissionPreset: { type: "string", required: true },
            provider: { type: "string", required: true },
            model: { type: "string", required: true },
            reasoningEffort: { type: "string" },
            title: { type: "string" },
            tools: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                names: { type: "array", items: { type: "string" }, required: true },
                count: { type: "number", required: true },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `new lightweight session ${value.sessionId} opened${value.cwd === undefined ? "" : ` in ${value.cwd}`} (${value.agentPreset}, permission=${value.permissionPreset}, model=${value.provider}/${value.model}, tools=${value.tools.count})`,
          },
        ],
      },
      execute(
        args: {
          cwd?: string;
          presetId?: string;
          agentPreset?: string;
          permissionPreset?: string;
          provider?: string;
          model?: string;
          reasoningEffort?: string;
          title?: string;
          requiredTools?: string[];
        },
        exec: ToolExecutionInput,
      ) {
        if (exec.agent === undefined) throw new Error("a2a_create requires an agent caller");
        return createSession(ctx, {
          mode: "lightweight",
          cwd: args.cwd ?? exec.agent.session.header.cwd,
          presetId: args.agentPreset ?? args.presetId,
          agentPresetId: args.agentPreset,
          permissionPreset: args.permissionPreset,
          provider: args.provider,
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          title: args.title,
          requiredTools: args.requiredTools,
          callerAgent: exec.agent,
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
      text: "A2A: you can exchange messages with other agent threads. a2a_list shows all host-visible sessions with caller-cwd-first ordering and annotations that are not ACLs; a2a_send delivers by explicit SessionId across cwd; a2a_reply answers a specific message; a2a_read inspects history; a2a_status reports only proven accepted/claimed/answered lifecycle facts; a2a_create opens a complete lightweight session. A delivered message does not wait for the target's answer: request a reply explicitly and expect it later as your own new turn. Governed Team role dispatch uses orchestra_send(teamId+roleId), while raw a2a_send is for explicit free SessionId communication. Receipts state=accepted means no answer was awaited.",
    });
  }
}
