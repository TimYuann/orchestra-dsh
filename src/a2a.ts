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
import type { SessionId, AgentCancelCause } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/cordis-plugin-timer";
import { randomUUID } from "node:crypto";
import { prepareLightweightBlueprint } from "./session-blueprint.js";
import { createSubagentNode } from "./subagent-node.js";
import type { GovernedBlueprintReceipt, PreparedGovernedBlueprint, LightweightBlueprintReceipt } from "./session-blueprint.js";
import { deliverMessage, queryMessageStatus, readDeliveryReceipt } from "./a2a-transport.js";
import { receiptStoreFor } from "./receipt-store.js";
import { blueprintStoreFor } from "./session-blueprint.js";
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
  /** Parsed row ids used as a static proof for a custom file-backed role. */
  compositionRowIds?: string[];
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

/**
 * Establish a lightweight collaborator on the NATIVE sub-agent backend.
 *
 * This is the same delegation the governed node backend performs, exposed on
 * the lightweight path so a caller can open a cheap collaborator without a
 * Team: a durable continuable child that joins the caller's live composition.
 *
 * Three capabilities of the session backend have no native counterpart, and
 * each is REFUSED rather than reinterpreted — a caller must never be handed a
 * guarantee that was not provided:
 *
 * - `cwd` — a native child shares its parent's working directory;
 * - `presetId` / `agentPreset` / `permissionPreset` / `requiredTools` — a child
 *   cannot mount its own composition or pin its own permission, so a caller
 *   asking for either wants `execution: "session"`;
 * - `title` — a native child's durable identity is its creation `label`, and a
 *   session title event would describe a session that has no independent life.
 *
 * `prompt` is required because the native contract has no
 * established-but-idle state: creation and the first delivery are one call.
 *
 * @param ctx - host context carrying the subagent registry.
 * @param args - the tool arguments; session-only fields must be absent.
 * @param exec - the calling tool execution, whose Agent becomes the child's parent.
 * @returns the durable child id plus the route the node actually runs.
 * @throws when a session-only field is present, `prompt` is missing, or the
 *   model route is incomplete or the delegation itself fails.
 */
export async function createLightweightSubagentNode(
  ctx: Context,
  args: {
    cwd?: string;
    presetId?: string;
    agentPreset?: string;
    permissionPreset?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    title?: string;
    label?: string;
    prompt?: string;
    persona?: string;
    toolFilter?: { allow?: string[]; deny?: string[] };
    requiredTools?: string[];
  },
  exec: ToolExecutionInput,
) {
  const caller = exec.agent;
  if (caller === undefined) throw new Error("a2a_create requires an agent caller");
  const sessionOnly: [string, unknown][] = [
    ["cwd", args.cwd],
    ["presetId", args.presetId],
    ["agentPreset", args.agentPreset],
    ["permissionPreset", args.permissionPreset],
    ["title", args.title],
    ["requiredTools", args.requiredTools],
  ];
  const used = sessionOnly.filter(([, value]) => value !== undefined).map(([name]) => name);
  if (used.length > 0) {
    throw new Error(
      `a2a_create execution "subagent" cannot honor ${used.join(", ")}: a native sub-agent shares its parent's cwd, joins the caller's live Agent Preset (so it mounts no composition of its own), takes its durable identity from label rather than a session title, and has its sandbox and approval policy pinned at the delegation boundary — use execution: "session" when any of those are required`,
    );
  }
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw new Error('a2a_create execution "subagent" requires prompt: the native contract establishes the child and delivers its initial prompt in one call, so there is no established-but-idle child to message afterwards');
  }
  if ((args.provider === undefined) !== (args.model === undefined)) throw new Error("a2a_create requires provider and model together");
  if (args.reasoningEffort !== undefined && (args.provider === undefined || args.model === undefined)) {
    throw new Error("a2a_create reasoningEffort requires provider and model");
  }
  const label = args.label === undefined || args.label === "" ? `a2a-node-${randomUUID().slice(0, 8)}` : args.label;
  const receipt = await createSubagentNode(
    ctx,
    caller,
    {
      label,
      prompt: args.prompt,
      ...(args.provider === undefined
        ? {}
        : {
            agentOptions: {
              provider: args.provider,
              model: args.model as string,
              ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
            },
          }),
      ...(args.persona === undefined ? {} : { persona: args.persona }),
      ...(args.toolFilter === undefined ? {} : { toolFilter: args.toolFilter }),
    },
    exec.signal,
  );
  // Report the route the node actually runs: an unstated override means the
  // child inherits the caller's, so the caller's values are the honest answer.
  const provider = args.provider ?? caller.options.provider;
  const model = args.model ?? caller.options.model;
  return {
    sessionId: receipt.childId,
    execution: "subagent" as const,
    label,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
  };
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

/** Stop an active session immediately by cancelling its agent driver and clearing inbox. */
export async function stopSession(
  ctx: Context,
  sessionId: string,
  reason?: string,
): Promise<{
  sessionId: string;
  stopped: boolean;
  status: string;
  reason?: string;
  message: string;
}> {
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error('a2a_stop: "sessionId" must be a non-empty string');
  }
  const live = ctx.agents.get(SID(sessionId));
  if (live === undefined) {
    const session = ctx.sessions?.get(SID(sessionId));
    if (session === undefined) {
      return {
        sessionId,
        stopped: false,
        status: "not_found",
        message: `session ${sessionId} does not exist or has no active agent`,
      };
    }
    return {
      sessionId,
      stopped: false,
      status: "idle",
      message: `session ${sessionId} is cold or idle (no running agent to cancel)`,
    };
  }

  const prevStatus = live.status;
  const cause: AgentCancelCause = typeof reason === "string" && reason.trim() !== ""
    ? { kind: "hook", reason: reason.trim() }
    : { kind: "user" };

  live.cancel(cause, { keepInbox: false });

  return {
    sessionId,
    stopped: true,
    status: live.status,
    ...(reason !== undefined ? { reason } : {}),
    message: `session ${sessionId} execution stopped (was ${prevStatus}, inbox cleared)`,
  };
}

/** Read the recent user/assistant messages of one session (live or persisted), progressive disclosure. */
export async function readSessionText(
  ctx: Context,
  sessionId: string,
  options?: number | { limit?: number; turns?: number },
): Promise<{
  sessionId: string;
  total_turns?: number;
  returned_turns?: number;
  messages: { role: string; text: string; turn?: number }[];
}> {
  const query = ctx.get("sessionQuery");
  if (query === undefined) throw new Error("a2a: sessionQuery service is unavailable");
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("a2a: \"sessionId\" must be a non-empty string");
  const snapshot = await query.readSession(SID(sessionId));

  let limit: number | undefined;
  let turns = 2; // Default progressive disclosure: 2 turns

  if (typeof options === "number") {
    limit = Math.max(1, Math.min(options, 20));
  } else if (typeof options === "object" && options !== null) {
    if (typeof options.turns === "number") turns = Math.max(1, Math.min(options.turns, 10));
    if (typeof options.limit === "number") limit = Math.max(1, Math.min(options.limit, 30));
  }

  interface RawMessage {
    role: string;
    text: string;
  }
  const turnGroups: { turnNumber: number; messages: RawMessage[] }[] = [];
  let currentGroup: RawMessage[] = [];

  for (const event of snapshot.events) {
    if (event.type === "user/message") {
      const kind = event.data.source === undefined ? undefined : (event.data.source as any).kind;
      if (kind !== "a2a" && kind !== "user") continue;
      const text = textOf(event.data);
      if (text === "") continue;

      if (currentGroup.length > 0) {
        turnGroups.push({ turnNumber: turnGroups.length + 1, messages: currentGroup });
        currentGroup = [];
      }
      currentGroup.push({ role: "user", text });
    } else if (event.type === "assistant/message") {
      const text = textOf(event.data.message);
      if (text === "") continue;
      currentGroup.push({ role: "assistant", text });
    }
  }
  if (currentGroup.length > 0) {
    turnGroups.push({ turnNumber: turnGroups.length + 1, messages: currentGroup });
  }

  const totalTurns = turnGroups.length;
  let pickedMessages: { role: string; text: string; turn?: number }[] = [];
  let returnedTurns = 0;

  if (limit !== undefined) {
    const allMsgs = turnGroups.flatMap((g) => g.messages.map((m) => ({ ...m, turn: g.turnNumber })));
    pickedMessages = allMsgs.slice(-limit);
    returnedTurns = new Set(pickedMessages.map((m) => m.turn)).size;
  } else {
    const pickedGroups = turnGroups.slice(-turns);
    returnedTurns = pickedGroups.length;
    pickedMessages = pickedGroups.flatMap((g) => g.messages.map((m) => ({ ...m, turn: g.turnNumber })));
  }

  return {
    sessionId,
    total_turns: totalTurns,
    returned_turns: returnedTurns > 0 ? returnedTurns : undefined,
    messages: pickedMessages.map((entry) => ({
      role: entry.role,
      turn: entry.turn,
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

export function formatRelativeTime(diffMs: number): string {
  if (diffMs < 10_000) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export interface ThreadEntry {
  sessionId: string;
  title?: string;
  cwd?: string;
  /** When the session was CREATED (ms since epoch), from its own header. */
  createdAt?: number;
  /** Relative time since last activity (e.g. "2m ago", "just now"). */
  lastActivity?: string;
  /** Milliseconds timestamp of last known activity. */
  lastActivityMs?: number;
  /** Team role id if assigned to current cwd team. */
  role?: string;
  status: string;
  live: boolean;
  archived?: boolean;
  /** active | archived | other (cross-cwd); annotation, never an ACL. */
  category?: "active" | "archived" | "other";
  /** caller-relative team membership (spec §11): non-null only for the caller's cwd ACTIVE team. */
  current_cwd_team?: { team_id: string; role_id: string } | null;
}

/**
 * List live + recent cold threads with title/status/cwd/lastActivity/role — progressive
 * disclosure (spec §11 + v0.5 slimming):
 *
 * - Sorting: the caller's cwd group first, sorted strictly by recent activity descending;
 *   other cwds after, also sorted by recent activity descending.
 * - Query: optional case-insensitive keyword filter across title, role, and sessionId.
 * - Default return: all host sessions, caller cwd first, capped by `limit`.
 * - Archived roles are folded away by default; pass includeArchived to reveal them.
 */
export async function listThreads(
  ctx: Context,
  options: {
    limit?: number;
    offset?: number;
    driverCwd?: string;
    includeOtherCwds?: boolean;
    includeArchived?: boolean;
    query?: string;
  } = {},
): Promise<{ threads: ThreadEntry[]; discovery_note?: string }> {
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const offset = Math.max(0, options.offset ?? 0);
  const driverCwd = options.driverCwd;
  // Kept in the input for compatibility; raw transport/discovery visibility
  // is host-wide and cannot be narrowed by Team/CWD policy.
  void options.includeOtherCwds;
  const includeArchived = options.includeArchived === true;
  const now = Date.now();
  const live = ctx.agents.list();
  const liveEntries = live.map((agent) => {
    let lastTime = asTimestamp(agent.session?.header?.createdAt);
    try {
      const events = agent.session?.snapshotEvents?.();
      if (events && events.length > 0) {
        const latestTime = events[events.length - 1].time;
        if (typeof latestTime === "number" && Number.isFinite(latestTime)) {
          lastTime = latestTime;
        }
      }
    } catch {
      // ignore
    }
    if (lastTime === undefined || lastTime === asTimestamp(agent.session?.header?.createdAt)) {
      try {
        const steps = (agent as any).activity?.steps;
        if (Array.isArray(steps) && steps.length > 0) {
          const stepTime = steps[steps.length - 1]?.timestamp ?? steps[steps.length - 1]?.time;
          if (typeof stepTime === "number" && Number.isFinite(stepTime)) {
            lastTime = stepTime;
          }
        }
      } catch {
        // ignore
      }
    }
    const sess = agent.session as any;
    const statusStr = typeof agent.status === "string" ? agent.status : ((agent.status as any)?.kind ?? "unknown");
    const agentTitle = (agent as any).title ?? sess?.title ?? sess?.header?.title;
    const agentRole = (agent as any).role ?? sess?.role ?? sess?.header?.role;
    return {
      sessionId: agent.id,
      cwd: agent.session?.header?.cwd,
      status: statusStr,
      live: true,
      lastActivityMs: lastTime,
      lastActivity: lastTime !== undefined ? formatRelativeTime(Math.max(0, now - lastTime)) : undefined,
      ...(agentTitle !== undefined ? { title: agentTitle } : {}),
      ...(agentRole !== undefined ? { role: agentRole } : {}),
      ...(asTimestamp(agent.session?.header?.createdAt) === undefined
        ? {}
        : { createdAt: asTimestamp(agent.session?.header?.createdAt) }),
    };
  });
  // Every degraded answer below says so in `discovery_note`. A caller that gets
  // a SHORT list must be able to tell "there is nothing else" from "I could not
  // look", because for a discovery tool those are opposite facts and this list is
  // what an agent picks a target from.
  let query: any;
  let discovery_note: string | undefined;
  try {
    query = typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
  } catch {
    query = undefined;
  }
  if (query === undefined) {
    discovery_note = "sessionQuery service unavailable: only live sessions are listed";
  }
  let records: any[] = [];
  if (query !== undefined) {
    try {
      records = await query.listSessions();
    } catch (error) {
      // Discovery is progressive: a failed corpus adapter must not hide live reachability.
      discovery_note = `persisted-session corpus could not be listed (${error instanceof Error ? error.message : String(error)}): only live sessions are listed`;
    }
  }
  const coldCandidates = records.filter(
    (record: any) => record.live !== true && !liveEntries.some((entry: any) => entry.sessionId === record.header?.id),
  );
  // The cap must not be allowed to starve the sessions the caller most needs.
  const ownCwd = typeof driverCwd === "string" && driverCwd !== "" ? driverCwd : undefined;
  const ownFirst = ownCwd === undefined ? [] : coldCandidates.filter((record: any) => record.header?.cwd === ownCwd);
  const ownFirstIds = new Set(ownFirst.map((record: any) => record.header?.id));
  const rest = coldCandidates.filter((record: any) => !ownFirstIds.has(record.header?.id));
  const cold = [...ownFirst, ...rest.slice(0, Math.max(0, COLD_DISCOVERY_LIMIT - ownFirst.length))];
  const starvedByCap = ownCwd === undefined ? 0 : Math.max(0, ownFirst.length - COLD_DISCOVERY_LIMIT);
  const ids = [...liveEntries.map((entry: any) => entry.sessionId), ...cold.map((record: any) => record.header?.id)];
  let observations: any[] = [];
  if (query !== undefined) {
    try {
      observations = await query.readTitleSnapshots(ids);
    } catch {
      // Titles are optional annotations; keep the session rows visible.
    }
  }
  const titles = new Map<string, string>();
  for (const observation of observations) {
    if (observation.status === "fulfilled" && observation.value?.title !== undefined) {
      titles.set(observation.sessionId, observation.value.title.title);
    }
  }
  // Authoritative roster from team.json/archive on disk: per-cwd scan keyed
  // by session id with category (active | archived).
  const unknownCwds = new Set<string>();
  for (const entry of liveEntries) if (entry.cwd !== undefined) unknownCwds.add(entry.cwd);
  for (const record of cold) if (record.header?.cwd !== undefined) unknownCwds.add(record.header.cwd);
  if (driverCwd !== undefined && driverCwd !== "") unknownCwds.add(driverCwd);
  let roster = new Map<string, { cwd: string; category: "active" | "archived" }>();
  let teamMembership = new Map<string, { team_id: string; role_id: string }>();
  try {
    roster = await scanTeamRoster(ctx, unknownCwds);
    teamMembership = await readCurrentCwdTeam(ctx, driverCwd);
  } catch {
    // team roster inspection is best-effort
  }
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
    const teamMem = teamMembership.get(entry.sessionId);
    const role = teamMem ? teamMem.role_id : (entry.role ?? (entry.title !== undefined ? entry.title : undefined));
    const title = titles.get(entry.sessionId) ?? entry.title;
    threads.push({
      ...entry,
      ...(role !== undefined ? { role } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(cls.archived ? { archived: true } : {}),
      ...(cls.category === undefined ? {} : { category: cls.category }),
      ...(teamMem !== undefined
        ? { current_cwd_team: teamMem }
        : { current_cwd_team: null }),
    });
  }
  for (const record of cold) {
    const cls = classified(record.header?.id);
    if (!cls.keep) continue;
    const cTime = asTimestamp(record.header?.createdAt);
    const teamMem = teamMembership.get(record.header?.id);
    const role = teamMem ? teamMem.role_id : undefined;
    const title = titles.get(record.header?.id) ?? record.header?.title;
    threads.push({
      sessionId: record.header?.id,
      cwd: record.header?.cwd,
      status: "cold",
      live: false,
      lastActivityMs: cTime,
      lastActivity: cTime !== undefined ? formatRelativeTime(Math.max(0, now - cTime)) : undefined,
      ...(role !== undefined ? { role } : {}),
      ...(asTimestamp(record.header?.createdAt) === undefined
        ? {}
        : { createdAt: asTimestamp(record.header?.createdAt) }),
      ...(title !== undefined ? { title } : {}),
      ...(cls.archived ? { archived: true } : {}),
      ...(cls.category === undefined ? {} : { category: cls.category }),
      ...(teamMem !== undefined
        ? { current_cwd_team: teamMem }
        : { current_cwd_team: null }),
    });
  }

  let filtered = threads;
  if (typeof options.query === "string" && options.query.trim() !== "") {
    const q = options.query.trim().toLowerCase();
    filtered = filtered.filter((t) => {
      if (t.title?.toLowerCase().includes(q)) return true;
      if (t.sessionId.toLowerCase().includes(q)) return true;
      if (t.role?.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  // Progressive-disclosure ordering (spec §11 + v0.5 slimming):
  // caller cwd first, sorted strictly by last activity descending (most recently active first),
  // then other cwds sorted by last activity descending.
  filtered.sort((a, b) => {
    const sameCwdA = driverCwd !== undefined && a.cwd === driverCwd ? 0 : 1;
    const sameCwdB = driverCwd !== undefined && b.cwd === driverCwd ? 0 : 1;
    if (sameCwdA !== sameCwdB) return sameCwdA - sameCwdB;

    const liveRankA = a.live ? 0 : 1;
    const liveRankB = b.live ? 0 : 1;
    if (liveRankA !== liveRankB) return liveRankA - liveRankB;

    const actA = a.lastActivityMs ?? 0;
    const actB = b.lastActivityMs ?? 0;
    if (actA !== actB) return actB - actA;

    return a.sessionId.localeCompare(b.sessionId);
  });
  const dropped = coldCandidates.length - cold.length;
  return {
    threads: filtered.slice(offset, offset + limit),
    // Never a silent cap: P13 forbids one, and a truncated discovery list is
    // exactly the shape that makes an agent conclude a target does not exist.
    ...(discovery_note !== undefined
      ? { discovery_note }
      : dropped === 0
      ? {}
      : {
          discovery_note:
            `discovery cap ${COLD_DISCOVERY_LIMIT}: ${dropped} older persisted session(s) from other working directories were not listed` +
            (starvedByCap === 0 ? "" : `; this working directory alone has ${starvedByCap} more than the cap`),
        }),
  };
}

/** How many persisted sessions one discovery pass will consider. */
const COLD_DISCOVERY_LIMIT = 200;

/** A header timestamp is only worth showing when it is a real finite number. */
function asTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

/**
 * The plugin-owned durable sinks one delivery needs.
 *
 * Both are scoped to the CALLER's cwd: that is where a retry, an `a2a_status`
 * lookup and a handoff replay will look for them again. The blueprint resolver
 * takes the target's cwd instead, because a cold resume reads it off the target's
 * own persisted header.
 */
export function transportStores(ctx: Context, cwd: string | undefined) {
  return {
    receiptStore: receiptStoreFor(ctx, cwd),
    resolveBlueprintStore: (targetCwd: string | undefined) => blueprintStoreFor(ctx, targetCwd),
  };
}

/** Bounded raw-send entrypoint shared by a2a_send and its cross-cwd harness. */
export async function sendRawA2A(ctx: Context, args: RawA2ASendArgs, exec: ToolExecutionInput) {
  if (exec.agent === undefined) throw new Error("a2a_send requires an agent caller");
  if (args.to === exec.agent.id) throw new Error("a2a: cannot send a message to yourself");
  const policy = (ctx as any).sandboxPolicy?.resolve?.({ session: exec.agent.session, mode: "workspace-write" });
  return deliverMessage(ctx, exec.agent.id, args.to, [
    { type: "text", text: `Message from agent ${exec.agent.id}:` },
    { type: "text", text: args.message },
  ], {
    wake: args.wake,
    interrupt: args.interrupt === true,
    idempotencyKey: args.idempotencyKey,
    receiptPolicy: policy,
    ...transportStores(ctx, exec.agent.session.header.cwd),
  });
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
        "List the host's A2A sessions with session id, title, working directory, status, liveness, last activity, role, and honest Team/archive annotations. The caller cwd sorts first by recent activity descending; other cwds also sort by recent activity. Archived roles are folded unless includeArchived:true. Supports fast keyword search via query.",
      parameters: {
        query: { type: "string", description: "Optional case-insensitive keyword query to filter sessions by title, role, or sessionId." },
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
                  createdAt: {
                    type: "number",
                    description: "Session creation time (ms since epoch).",
                  },
                  lastActivity: {
                    type: "string",
                    description: "Relative time since last activity (e.g. \"2m ago\", \"just now\").",
                  },
                  lastActivityMs: {
                    type: "number",
                    description: "Milliseconds timestamp of last known activity.",
                  },
                  role: {
                    type: "string",
                    description: "Team role id if this session belongs to an active team.",
                  },
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
            discovery_note: {
              type: "string",
              description:
                "Present only when discovery was incomplete (a missing service, a failed corpus read, or the discovery cap). A short list WITHOUT this field means there is nothing else to find.",
            },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: "text",
            text:
              (value.threads.length === 0
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
                      const roleStr = t.role ? ` [role: ${t.role}]` : "";
                      const actStr = t.lastActivity ? ` [${t.lastActivity}]` : "";
                      const created = t.createdAt === undefined ? "" : ` [created ${new Date(t.createdAt).toISOString().slice(0, 16).replace("T", " ")}]`;
                      return `${t.sessionId}${t.live ? "" : " (cold)"}${roleStr}${actStr}${tag}${t.title === undefined ? "" : ` (${t.title})`}${created}`;
                    })
                    .join(", ")}`) +
              (value.discovery_note === undefined ? "" : `\nINCOMPLETE DISCOVERY: ${value.discovery_note}`),
          },
        ] as ContentBlock[],
      },
      async execute(
        args: { query?: string; limit?: number; offset?: number; includeOtherCwds?: boolean; includeArchived?: boolean },
        exec: ToolExecutionInput,
      ) {
        const driverCwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd;
        return listThreads(ctx, {
          query: args.query,
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
      name: "a2a_stop",
      description:
        "Instantly cancel the target session's active turn and clear its pending inbox (equivalent to the Composer Stop button). Directly invokes agent.cancel({ keepInbox: false }) on the target. Returns immediately, bringing the target to idle.",
      parameters: {
        sessionId: { type: "string", required: true, description: "Target session id to stop (see a2a_list)." },
        reason: { type: "string", description: "Optional reason for cancellation." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            stopped: { type: "boolean", required: true },
            status: { type: "string", required: true },
            reason: { type: "string" },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value): ContentBlock[] => [
          {
            type: "text",
            text: `[a2a_stop] session ${value.sessionId}: ${value.message}`,
          },
        ] as ContentBlock[],
      },
      async execute(args: { sessionId: string; reason?: string }) {
        return stopSession(ctx, args.sessionId, args.reason);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_read",
      description:
        "Read recent conversation of another agent thread (session) with progressive disclosure: defaults to inspecting the last 1~2 turns of interaction to save context. Supports specifying turns or limit.",
      parameters: {
        sessionId: { type: "string", required: true, description: "Target session id (see a2a_list)." },
        turns: { type: "number", description: "Number of recent turns to return. Defaults to 2 (max 10)." },
        limit: { type: "number", description: "Optional raw message count limit (legacy compatibility, max 30)." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            total_turns: { type: "number" },
            returned_turns: { type: "number" },
            messages: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  role: { type: "string", required: true },
                  turn: { type: "number" },
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
                : `thread ${value.sessionId}${value.returned_turns !== undefined ? ` (${value.returned_turns}/${value.total_turns ?? "?"} turns)` : ""}:\n` +
                  value.messages
                    .map((m) => `${m.turn !== undefined ? `[Turn ${m.turn}] ` : ""}${m.role}: ${m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text}`)
                    .join("\n"),
          },
        ] as ContentBlock[],
      },
      execute(args: { sessionId: string; turns?: number; limit?: number }) {
        return readSessionText(ctx, args.sessionId, { turns: args.turns, limit: args.limit });
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
        ], {
          replyTo: args.reply_to,
          interrupt: args.interrupt === true,
          idempotencyKey: args.idempotency_key,
          ...transportStores(ctx, exec.agent.session.header.cwd),
        });
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
      execute(args: { messageId: string; targetSessionId: string }, exec: ToolExecutionInput) {
        return queryMessageStatus(ctx, args.messageId, args.targetSessionId, receiptStoreFor(ctx, exec.agent?.session.header.cwd));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "a2a_create",
      description:
        "Open a lightweight collaborator under the caller. Two backends share this tool, and `execution` selects one. Default \"session\": a complete peer Session that resolves and installs its own Agent Preset composition, pins a Permission Preset and Model Selection, records a lightweight blueprint marker, fixes the title, and verifies required tools; it is addressable by any session through a2a_send. \"subagent\": a durable continuable DSH sub-agent child — cheaper, and it CANNOT hold its own preset (it joins the caller's live composition), CANNOT ask the user for approval (its policy is pinned to never), and CANNOT be addressed by anyone but the exact caller, because native delegation authorizes delivery by the direct-parent edge alone. Choose \"subagent\" when the node needs only a model route and, optionally, a per-child persona or tool filter.",
      parameters: {
        execution: { type: "string", enum: ["session", "subagent"], description: "Backend: \"session\" (default, a complete peer Session) or \"subagent\" (a native continuable child of the caller)." },
        cwd: { type: "string", description: "Working directory for the new session. Defaults to the calling thread's cwd. Session backend only." },
        presetId: { type: "string", description: "Legacy-compatible explicit Agent Preset id. Session backend only." },
        agentPreset: { type: "string", description: "Explicit Agent Preset id; takes precedence over presetId. Session backend only." },
        permissionPreset: { type: "string", description: "Permission Preset to pin; defaults to permissionPresets.defaultPreset. Session backend only." },
        provider: { type: "string", description: "Explicit model provider; must be paired with model." },
        model: { type: "string", description: "Explicit model id; must be paired with provider." },
        reasoningEffort: { type: "string", description: "Optional reasoning effort; requires provider and model." },
        title: { type: "string", description: "Title pinned before the Session is published. Session backend only." },
        label: { type: "string", description: "Durable creation label, shown by list_agents and the GUI lineage. Subagent backend only; defaults to a generated id." },
        prompt: { type: "string", description: "The node's opening task. REQUIRED by the subagent backend: the native contract establishes the child and delivers its initial prompt in one call, so there is no established-but-idle child to message later." },
        persona: { type: "string", description: "Per-child persona shadowing the deployment persona for this child alone. Subagent backend only." },
        toolFilter: {
          type: "object",
          additionalProperties: false,
          description: "Native per-child tool scoping: the named tools vanish from the child's prompt AND refuse to execute. This narrows AVAILABILITY, it is NOT a permission guarantee (the denied tool's underlying capability, e.g. a shell, may still reach the same effect). Subagent backend only.",
          properties: {
            allow: { type: "array", items: { type: "string" }, description: "Global tool names the child keeps; everything else is removed." },
            deny: { type: "array", items: { type: "string" }, description: "Global tool names removed from the child." },
          },
        },
        requiredTools: { type: "array", items: { type: "string" }, description: "Optional tool names that must be visible in the child scope before publication. Session backend only." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            execution: { type: "string", required: true },
            cwd: { type: "string" },
            agentPreset: { type: "string" },
            mode: { type: "string" },
            permissionPreset: { type: "string" },
            provider: { type: "string" },
            model: { type: "string" },
            reasoningEffort: { type: "string" },
            title: { type: "string" },
            label: { type: "string" },
            tools: {
              type: "object",
              additionalProperties: false,
              properties: {
                names: { type: "array", items: { type: "string" }, required: true },
                count: { type: "number", required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          // An absent route means the node inherits whatever the caller resolves
          // at its next request, so the card says that instead of inventing one.
          const route = `${value.provider ?? "inherited"}/${value.model ?? "inherited"}`;
          return value.execution === "subagent"
            ? [
                {
                  type: "text",
                  text: `new sub-agent node ${value.sessionId} established${value.label === undefined ? "" : ` as "${value.label}"`} (model=${route}; inherits the caller's composition and permission — approval is pinned to never; only the caller can address it)`,
                },
              ]
            : [
                {
                  type: "text",
                  text: `new lightweight session ${value.sessionId} opened${value.cwd === undefined ? "" : ` in ${value.cwd}`} (${value.agentPreset}, permission=${value.permissionPreset}, model=${route}, tools=${value.tools?.count ?? 0})`,
                },
              ];
        },
      },
      async execute(
        args: {
          execution?: string;
          cwd?: string;
          presetId?: string;
          agentPreset?: string;
          permissionPreset?: string;
          provider?: string;
          model?: string;
          reasoningEffort?: string;
          title?: string;
          label?: string;
          prompt?: string;
          persona?: string;
          toolFilter?: { allow?: string[]; deny?: string[] };
          requiredTools?: string[];
        },
        exec: ToolExecutionInput,
      ) {
        if (exec.agent === undefined) throw new Error("a2a_create requires an agent caller");
        if (args.execution !== undefined && args.execution !== "session" && args.execution !== "subagent") {
          throw new Error(`a2a_create execution "${String(args.execution)}" is invalid (session | subagent)`);
        }
        if (args.execution === "subagent") return createLightweightSubagentNode(ctx, args, exec);
        const created = await createSession(ctx, {
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
        // The backend is a required fact of this result: a caller must be able
        // to tell which of the two very different collaborators it just opened.
        return { ...created, execution: "session" as const };
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
