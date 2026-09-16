/**
 * orchestra-dsh/orchestra — topology management layer: create role sessions
 * from topology templates (spec §4), apply role sandboxes, track report
 * counts, archive and reactivate the team (spec §7-§9).
 *
 * Host-plane plugin. Self-contained: session creation reuses the a2a module;
 * state persists to <cwd>/orchestra/state/team.json (v1.1, spec §7.1);
 * archives live in <cwd>/orchestra/archive/ (immutable, spec §7.2);
 * configuration lives in <cwd>/.orchestra/ and ~/.dsh/orchestra/ (spec §4.1,
 * §5.3).
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, MessageSource } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
// `JsonValue` moved out of `@deepseek-ai/dsh-tools` in DSH 0.1.5-rc.2.
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { AgentHandle, Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-commands";
import { createSession, installModelOverride, deliverMessage, readDeliveryReceipt, transportStores } from "./a2a.js";
import { receiptStoreFor } from "./receipt-store.js";
import { charterRecordStoreFor } from "./charter-store.js";
import type { ResolvedPresetFile } from "./a2a.js";
import { hostToolNamesForPreflight, prepareGovernedBlueprint, preflightGovernedRequiredTools, resolveDraftRoleModel, SessionBlueprintError, REMOVED_ORCHESTRA_TOOLS } from "./session-blueprint.js";
import type { GovernedBlueprintReceipt, PreparedGovernedBlueprint } from "./session-blueprint.js";
import {
  ensureBuiltinRolePresetArtifacts,
  resolveRolePresetFile,
  rolePresetSpec,
} from "./orchestra-role-presets.js";
import { createActiveTeamStateStore, NOTICE_FAILURE_LIMIT } from "./orchestra-state.js";
import type {
  ArchiveList,
  ArchiveStore,
} from "./orchestra-archive.js";
import type {
  ActiveTeamArchivedMarker,
  ActiveTeamRead,
  ActiveTeamReady,
  ActiveTeamStateStore,
  TeamRole,
  TeamState,
  TeamRoleBlueprintFacts,
  TeamRoleDiagnostic,
  TeamRoleExecution,
  TeamRolePhase,
  TeamWelcomeReceipt,
} from "./orchestra-state.js";
import { createArchiveStore } from "./orchestra-archive.js";
import { createGovernedRoleAddressResolver } from "./orchestra-address.js";
import type { GovernedRoleAddress, GovernedRoleAddressResolver } from "./orchestra-address.js";
import {
  appendDriverDecision,
  applyFrozenCharterRevision,
  documentSummary,
  initializeOrchestrationDocument,
  initializeFrozenOrchestrationDocument,
  inspectMarkdownProjection,
  isRuntimeProjectionStale,
  OrchestrationDocumentError,
  readOrchestrationDocument,
  reconcileOrchestrationDocument,
  writeMarkdownProjection,
} from "./orchestration-document.js";
import type { DecisionInput, EvidenceRef, OrchestrationDocument } from "./orchestration-document.js";
import {
  CharterError,
  charterSummary,
  foldCharterEvents,
  frozenRef,
  latestDraft,
  prepareApprovalEvent,
  prepareDraftEvent,
  prepareFreezeEvent,
  resolveFrozenCharter,
} from "./orchestration-charter.js";
import type {
  CharterDraft,
  CharterEvent,
  CharterMission,
  CharterTopologySnapshot,
  FrozenCharterRevision,
  HumanParticipationPolicy,
} from "./orchestration-charter.js";
import {
  appendHandoffPending,
  appendHandoffResult,
  applyGateFallback,
  graphClosure,
  graphGates,
  graphHandoffs,
  graphLoops,
  graphSummary,
  GraphRuntimeError,
  initializeGraphRuntime,
  openGate,
  recordClosure,
  readGraphRuntime,
  recordVerdict,
  resolveGate,
  resolveHandoffTarget,
  startAttempt,
  startLoop,
  sweepBoundedRun,
  nodeStall,
  GATE_DECISION_EVENT,
} from "./orchestra-graph.js";
import type { GraphCommandResult, GraphRuntimeState, LoopSummary, NodeStall } from "./orchestra-graph.js";
import { createTeamChangeBus, withChangeSignal } from "./team-change-bus.js";
import type { TeamChangeBus } from "./team-change-bus.js";
import { createSubagentNode, sendToSubagentNode } from "./subagent-node.js";
import type { SubagentNodeSpec } from "./subagent-node.js";
import { createTopologyCatalog, resolveRoleExecution } from "./orchestra-topology.js";
import type { RoleConfig, TopologyCatalog, TopologyClosureDefinition, TopologyList, TopologyLoopContract, TopologyProtocol, TopologyResolution, TopologyRoleSummary } from "./orchestra-topology.js";
export { validateTopology } from "./orchestra-topology.js";
import { mountPreset } from "@deepseek-ai/dsh-agent-presets";
import { registerOrchestrationPrinciples } from "./orchestration-principles.js";
import "./relay-types.js";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SID = (value: string): SessionId => value as SessionId;

/**
 * `orchestra_wait` bounds. A minimum keeps a caller from turning a wait into a
 * busy poll, and a maximum keeps one call from outliving the turn budget that
 * has to notice the run is not advancing.
 */
export const MIN_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes stall heartbeat (1,200,000 ms)

/** DSH home directory (env override wins; default ~/.dsh). */
function dshHome(): string {
  const env = process.env["DSH_HOME"];
  if (typeof env === "string" && env !== "") return env;
  return join(homedir(), ".dsh");
}

/** Orchestra global config root (spec §4.1 / §5.3): ~/.dsh/orchestra/. */
function orchestraGlobalRoot(): string {
  return join(dshHome(), "orchestra");
}

/**
 * Project slug from a cwd string: takes the last path segment and slug-ifies
 * it (letters/digits/`_`/`-` only, repeated separators collapsed to one `-`,
 * leading/trailing `-` stripped). Empty / whitespace-only input → "unknown";
 * segment that is all separator chars → also "unknown". Used to disambiguate
 * role sessions across workspaces ("my-project · reviewer · trio" instead of
 * the collision-prone "orchestra: reviewer (trio)").
 */
export function projectSlugFromCwd(cwd: string | undefined): string {
  if (typeof cwd !== "string" || cwd === "") return "unknown";
  const segment = basename(cwd);
  if (segment === "" || segment === "." || segment === "/") return "unknown";
  const slug = segment.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "unknown" : slug;
}

/** Segment length caps for role session titles (user-approved three-part scheme). */
export const ROLE_SESSION_TITLE_ROLE_MAX = 16;
export const ROLE_SESSION_TITLE_MISSION_MAX = 14;
export const ROLE_SESSION_TITLE_SLUG_MAX = 16;

function truncateTitleSegment(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  return [...chars.slice(0, Math.max(0, max - 1)), "…"].join("");
}

/**
 * Deterministic mission abbreviation for a role session title: first non-empty
 * line of mission.objective, internal whitespace collapsed, capped at
 * ROLE_SESSION_TITLE_MISSION_MAX chars (code points, so CJK counts per char);
 * an ellipsis marks truncation. Missing/empty objective falls back to "mission".
 */
export function abbreviateMissionObjective(objective: string | undefined): string {
  if (typeof objective !== "string" || objective.trim() === "") return "mission";
  const firstLine = objective
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (firstLine === undefined || firstLine === "") return "mission";
  return truncateTitleSegment(firstLine.replace(/\s+/g, " ").trim(), ROLE_SESSION_TITLE_MISSION_MAX);
}

export interface RoleSessionTitleOptions {
  roleId: string;
  missionObjective?: string;
  cwd?: string;
}

/**
 * Deterministic three-part role session title: `<roleId> · <mission> · <cwd-slug>`.
 *
 * - roleId: role.id verbatim (case preserved), capped at ROLE_SESSION_TITLE_ROLE_MAX;
 * - mission: abbreviateMissionObjective(missionObjective) (≤14 chars, "mission" fallback);
 * - cwd: projectSlugFromCwd(cwd), capped at ROLE_SESSION_TITLE_SLUG_MAX;
 *
 * The title is a derived display value: it never enters the Frozen Charter and
 * never mutates mission structure. The function is total and deterministic, so
 * create/spawn/activate all produce the same title for the same (roleId,
 * mission.objective, cwd) — activate derives from the archived team.mission.
 */
export function roleSessionTitle(options: RoleSessionTitleOptions): string {
  const role = truncateTitleSegment(typeof options.roleId === "string" && options.roleId !== "" ? options.roleId : "role", ROLE_SESSION_TITLE_ROLE_MAX);
  const mission = abbreviateMissionObjective(options.missionObjective);
  const slug = truncateTitleSegment(projectSlugFromCwd(options.cwd), ROLE_SESSION_TITLE_SLUG_MAX);
  return `${role} · ${mission} · ${slug}`;
}

/** Milestone kinds the host auto-notifies the driver about (CP8 event 2, A). */
export type MilestoneNoticeKind = "handoff" | "verdict" | "report" | "gate" | "close";

/**
 * One-line driver milestone notice text. The notice is a trigger, not a state
 * source: the driver reports progress from orchestra_team, so
 * the text carries only node-level facts — never payload content or secrets.
 */
export function milestoneNotice(teamId: string, kind: MilestoneNoticeKind, detail: string): string {
  return `orchestra: ${teamId} ${kind} ${detail}`;
}

/** One milestone notice that could not be delivered, as a durable fact. */
export interface NoticeFailureFact {
  milestone: MilestoneNoticeKind;
  targetSessionId: string;
  failedAt: number;
  reason: string;
}

/** Persists one undelivered notice. Rejecting makes the caller fall back to stderr. */
export type NoticeFailureRecorder = (fact: NoticeFailureFact) => Promise<void>;

/** Optional channels for {@link notifyDriverMilestone}. */
export interface MilestoneNoticeOptions {
  /** Delivery channel; tests replace it. Defaults to the real transport. */
  deliver?: typeof deliverMessage;
  /**
   * Durable recorder for a notice that could not be delivered. Omitted means
   * the failure is only warned about, which is the legacy behavior.
   */
  recordFailure?: NoticeFailureRecorder;
}

/**
 * Best-effort node-milestone notification to the Team controller (driver).
 * Skips the controller's own calls (no self-messages).
 *
 * The failure path is a deliberate THREE-step degradation chain, because a
 * notice is both unreliable and load-bearing at the same time:
 *
 * 1. deliver the notice;
 * 2. if delivery fails, hand the failure to `recordFailure`, which persists it
 *    as a graph fact so "the driver was never woken" stops being invisible on an
 *    unattended run;
 * 3. if THAT fails too (a blocked store, a lost CAS), warn on stderr naming both
 *    reasons.
 *
 * No step ever throws: the notice is best-effort by contract and must never fail
 * the tool that triggered it. But no step is silent either — the failure is
 * either durable or explained, and a reader can always tell which.
 *
 * @param ctx - host context.
 * @param team - the Team whose controller is notified.
 * @param actorSessionId - the session that produced the milestone.
 * @param kind - the milestone kind.
 * @param detail - node-level detail, never payload content.
 * @param options - delivery and failure-recording channels, or just the
 *   delivery function (the historical signature).
 * @returns nothing; failures are recorded or warned, never raised.
 */
/**
 * Durable sinks for a milestone notice, or nothing if we cannot scope them.
 *
 * A notice is best-effort BY CONTRACT: it must never fail the tool that
 * triggered it, and the caller may hand us a context with no agent registry at
 * all (tests do exactly that, and some compositions omit the service). Delivering
 * without the sinks is worse than ideal — a cold driver would resume without its
 * composition marker — but refusing to deliver, or throwing while merely
 * BUILDING the options, is strictly worse: the notice is how a driver learns a
 * node finished.
 */
function milestoneStores(ctx: Context, actorSessionId: string) {
  try {
    const agents = ctx.get("agents");
    const actor = agents === undefined ? undefined : agents.get(actorSessionId as never);
    return transportStores(ctx, actor?.session.header.cwd);
  } catch {
    return {};
  }
}

export async function notifyDriverMilestone(
  ctx: Context,
  team: TeamState,
  actorSessionId: string,
  kind: MilestoneNoticeKind,
  detail: string,
  options: typeof deliverMessage | MilestoneNoticeOptions = {},
): Promise<void> {
  if (actorSessionId === team.controllerSessionId) return;
  const resolved: MilestoneNoticeOptions = typeof options === "function" ? { deliver: options } : options;
  const deliver = resolved.deliver ?? deliverMessage;
  const text = milestoneNotice(team.teamId, kind, detail);
  try {
    // No idempotency key: this key was a fresh randomUUID on every call, so it
    // never deduplicated anything — it only forced an acceptance record (a file,
    // in the durable store) for each best-effort notice. A notice whose whole
    // contract is "never fail the tool that triggered it" should not create
    // durable state it cannot honour.
    await deliver(ctx, actorSessionId, team.controllerSessionId, [{ type: "text", text }], {
      wake: true,
      ...milestoneStores(ctx, actorSessionId),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (resolved.recordFailure !== undefined) {
      try {
        await resolved.recordFailure({ milestone: kind, targetSessionId: team.controllerSessionId, failedAt: Date.now(), reason });
        return;
      } catch (recordError) {
        const recordReason = recordError instanceof Error ? recordError.message : String(recordError);
        console.warn(
          `orchestra: milestone notice to controller ${team.controllerSessionId} failed (${reason}) AND recording that failure failed (${recordReason}); the driver was not woken and the run carries no durable trace of it`,
        );
        return;
      }
    }
    console.warn(`orchestra: milestone notice to controller ${team.controllerSessionId} failed: ${reason}`);
  }
}

/**
 * Recorder that persists an undelivered notice on the Team it concerns.
 *
 * WHY THE TEAM AND NOT THE GRAPH: the graph log is the record of DAG nodes and
 * Loops, and `readGraphRuntime` rejects any event that names neither a `nodeId`
 * nor a `loopInstanceId`. A failed wake-up is neither, so a graph entry would
 * have to invent a node that does not exist — and every reader that enumerates
 * nodes would then see a phantom. The Team record keeps the fact exactly as wide
 * as it is true. The trade-off is real and accepted: the fact is not part of the
 * bounded DAG, so it cannot be replayed as graph history; it is visible through
 * `orchestra_team` instead.
 *
 * It re-reads the Team instead of reusing a snapshot the caller is holding:
 * notice failure happens on the error path of an unrelated tool call, where the
 * caller's snapshot may already be stale, and a CAS write against a stale
 * snapshot would fail for a reason that has nothing to do with the notice.
 *
 * @param ctx - host context.
 * @param activeTeamState - the Team CAS store.
 * @param cwd - the Team's working directory.
 * @param exec - the calling execution; its sandbox policy owns the write.
 * @returns the recorder {@link notifyDriverMilestone} calls on a failed delivery.
 */
export function noticeRecorderFor(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  cwd: string,
  exec: ToolExecutionInput,
): NoticeFailureRecorder {
  return async (fact) => {
    const observed = await activeTeamState.read(cwd, { signal: exec.signal });
    if (observed.kind !== "ready") throw new Error(`active Team state is ${observed.kind}, so the failed notice cannot be recorded`);
    const noticeFailures = [...(observed.team.noticeFailures ?? []), fact].slice(-NOTICE_FAILURE_LIMIT);
    await activeTeamState.replace(observed, { ...observed.team, noticeFailures }, { policy: escrowPolicy(ctx, exec), signal: exec.signal });
  };
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "orchestra-manager";

/** Required services. */
export const inject = ["agents", "sessions", "fs", "sandboxPolicy", "tools", "timer"];

/** Resolve a role preset through project > global > DSH native > catalog builtin precedence. */
async function resolvePresetFile(ctx: Context, cwd: string, presetId: string): Promise<ResolvedPresetFile> {
  const resolved = await resolveRolePresetFile(ctx, cwd, presetId, orchestraGlobalRoot());
  return {
    id: resolved.id,
    trust: resolved.trust,
    path: resolved.path,
    source: resolved.source,
    ...(resolved.composition === undefined ? {} : { compositionRowIds: resolved.composition.rowIds }),
  };
}

/** Install catalog-owned role/topology artifacts independently and never overwrite user files. */
async function ensureBuiltinArtifacts(topologyCatalog: TopologyCatalog): Promise<void> {
  const results = await ensureBuiltinRolePresetArtifacts(orchestraGlobalRoot());
  for (const result of results) {
    if (result.status === "failed") {
      console.warn(
        "orchestra: could not install role preset " + result.id + ": " + (result.diagnostic?.message ?? "unknown artifact failure"),
      );
    }
  }
  await topologyCatalog.ensureBundledArtifacts();
}

export { normalizeTeam } from "./orchestra-state.js";

/**
 * The plugin's escrow write policy for its own state/report/archive paths:
 * an explicit workspace-write mode override (outranks a read-only session's
 * `sandbox/mode` override — this is what lets a read-only Reviewer hand in via
 * orchestra_report) plus the calling session's cwd as the workspace boundary.
 * The write footprint stays bounded because every call site confines its path
 * to `<cwd>/orchestra/<state|reports|archive>` (rel guards forbid `..`).
 *
 * Matches the official fs-tool contract (`ctx.sandboxPolicy.resolve({ session })`
 * in dsh-tool-fs) — `resolve({})` without the session would fall back to the
 * deployment-configured root instead of the session cwd and be out of bounds.
 */
function escrowPolicy(ctx: Context, exec: ToolExecutionInput): SandboxExecutionPolicy {
  const session = exec.agent === undefined ? undefined : exec.agent.session;
  return ctx.sandboxPolicy.resolve({ session, mode: "workspace-write" });
}

function throwIfBlocked(action: string, state: ActiveTeamRead): void {
  if (state.kind !== "blocked") return;
  throw new Error(`cannot ${action}: active team state is blocked (${state.diagnostic.code}): ${state.diagnostic.message}`);
}

export function topologyResolutionError(action: string, resolution: TopologyResolution, availableIds: string[] = []): Error {
  if (resolution.kind === "blocked") {
    return new Error(`cannot ${action}: topology "${resolution.id}" is blocked (${resolution.diagnostic.code}): ${resolution.diagnostic.message}`);
  }
  if (resolution.kind === "missing") {
    return new Error(`cannot ${action}: topology "${resolution.id}" was not found; available: ${availableIds.length === 0 ? "(none)" : availableIds.join(", ")}`);
  }
  return new Error(`cannot ${action}: topology resolution returned an unexpected ready state for "${resolution.config.id}"`);
}

export interface OrchestraTopologyToolEntry {
  id: string;
  name: string;
  description?: string;
  source: string;
  status: "ready" | "blocked";
  filename: string;
  controller?: Record<string, JsonValue>;
  protocol?: Record<string, JsonValue>;
  roles: TopologyRoleSummary[];
  diagnostic?: { code: string; message: string; fsCode?: string };
}

export function topologyListForTool(list: TopologyList): OrchestraTopologyToolEntry[] {
  return [
    ...list.ready.map((entry) => ({
      id: entry.config.id,
      name: entry.config.name ?? entry.config.id,
      ...(entry.config.description === undefined ? {} : { description: entry.config.description }),
      source: entry.source,
      status: entry.status,
      filename: entry.filename,
      ...(entry.config.controller === undefined ? {} : { controller: entry.config.controller as Record<string, JsonValue> }),
      ...(entry.config.protocol === undefined ? {} : { protocol: entry.config.protocol as Record<string, JsonValue> }),
      roles: entry.roles,
    })),
    ...list.blocked.map((entry) => ({
      id: entry.id,
      name: entry.id === "" ? entry.filename : entry.id,
      source: entry.source,
      status: entry.status,
      filename: entry.filename,
      roles: [],
      diagnostic: entry.diagnostic,
    })),
  ];
}

export interface OrchestraArchiveToolEntry {
  archive_id: string;
  filename: string;
  status: "ready" | "blocked";
  team_id: string;
  goal: string;
  topology: string;
  dismissed_at: number;
  archive_path: string;
  diagnostic?: { code: string; message: string; fsCode?: string };
}

/** Canonical archive projection consumed by orchestra_team and its output schema. */
export function archiveListForTeamTool(list: ArchiveList): OrchestraArchiveToolEntry[] {
  return [
    ...list.ready.map((archive) => ({
      archive_id: archive.archiveId,
      filename: archive.filename,
      status: archive.status,
      team_id: archive.teamId,
      goal: archive.goal,
      topology: archive.topology,
      dismissed_at: archive.dismissedAt,
      archive_path: archive.archivePath,
    })),
    ...list.blocked.map((archive) => ({
      archive_id: archive.archiveId,
      filename: archive.filename,
      status: archive.status,
      team_id: "",
      goal: "",
      topology: "",
      dismissed_at: 0,
      archive_path: archive.archivePath,
      diagnostic: archive.diagnostic,
    })),
  ];
}

/** Role self-awareness protocol (spec §8.2): identity, reply, dispatch, handoff, decision rights, routes, completion. */
function roleProtocolText(
  executorSessionId: string,
  roleName: string,
  opts: {
    ownership?: Record<string, string>;
    routes?: TopologyProtocol["routes"];
    completion?: { owner: string; rule: string };
    maxRounds?: number;
  } = {},
): string {
  const lines = [
    `You are running on orchestra, as role "${roleName}".`,
    `Your driver (the role that launched the team and owns decisions) is session ${executorSessionId}.`,
    `Reply rule: all replies go via a2a_reply to ${executorSessionId}; never reply directly to the user — users interact with you only through your driver.`,
    `Task source: tasks are dispatched by your driver via a2a_send; each task is self-contained and does not depend on your history.`,
    `Handoff: write outputs/reports with orchestra_report under orchestra/reports/, and return the report path when replying to the orchestrator.`,
    `Discipline (wait for dispatch): a welcome/activation message is NOT a task — do not start any work until your driver dispatches a concrete task via a2a_send; work starts only after the task arrives.`,
    `Discipline (spec scope): implement strictly what the dispatched task's spec asks for; do not extend features, variables, files, or scope beyond it.`,
  ];
  const ownership = opts.ownership;
  if (ownership !== undefined) {
    const lower = roleName.toLowerCase();
    const owned = Object.entries(ownership)
      .filter(([, owner]) => String(owner).toLowerCase() === lower)
      .map(([decision]) => decision);
    const notOwned = Object.entries(ownership)
      .filter(([, owner]) => String(owner).toLowerCase() !== lower)
      .map(([decision, owner]) => `${decision} → ${owner}`);
    if (owned.length > 0) {
      lines.push(`Decision rights (ownership): you own the final word on: ${owned.join(", ")}.`);
    }
    if (notOwned.length > 0) {
      lines.push(`Decision rights (boundaries): you do NOT own: ${notOwned.join("; ")}.`);
    }
  }
  const routes = opts.routes;
  if (Array.isArray(routes) && routes.length > 0) {
    const outgoing = routes
      .filter((route) => {
        const froms = Array.isArray(route.from) ? route.from : [route.from];
        return froms.some((from) => from === roleName);
      })
      .map((route) => `${route.kind} → ${route.to.join(", ")}`);
    if (outgoing.length > 0) {
      lines.push(`Default flow (routes): your outputs should go to: ${outgoing.join("; ")}. These are defaults, not permissions — but follow them unless the driver says otherwise.`);
    }
  }
  const completion = opts.completion;
  if (completion !== undefined) {
    lines.push(`Completion: the team is declared complete by "${completion.owner}" (${completion.rule}).`);
  }
  if (typeof opts.maxRounds === "number" && opts.maxRounds > 0) {
    lines.push(`Round discipline: at most ${opts.maxRounds} rounds for this role; the final round only re-checks the previous round's findings.`);
  }
  return lines.join("\n");
}

/**
 * 角色开场消息正文：协议段 + 可选自定义欢迎说明。
 *
 * Session 后端把它交给 `sendRoleWelcome` 投递，subagent 后端把它作为原生子节点的
 * 初始 prompt —— 两条路径必须生成完全相同的正文，否则协议段会只在其中一种后端生效。
 */
function roleWelcomeText(
  fromSessionId: string,
  roleName: string,
  extra?: string,
  protocol: Parameters<typeof roleProtocolText>[2] = {},
): string {
  const parts = [roleProtocolText(fromSessionId, roleName, protocol)];
  if (typeof extra === "string" && extra !== "") parts.push(extra);
  return parts.join("\n\n");
}

/** 向角色会话发送开场消息：协议段 + 可选自定义欢迎说明，并等待 durable admission。 */
async function sendRoleWelcome(
  ctx: Context,
  fromSessionId: string,
  toSessionId: string,
  roleName: string,
  extra?: string,
  protocol: Parameters<typeof roleProtocolText>[2] = {},
): Promise<TeamWelcomeReceipt> {
  const agent = ctx.agents.get(SID(toSessionId));
  if (agent === undefined) throw new Error(`role session ${toSessionId} is not live; cannot deliver`);
  const message = createUserMessage({
    content: [{ type: "text", text: roleWelcomeText(fromSessionId, roleName, extra, protocol) }] as ContentBlock[],
    source: { kind: "a2a", form: "relay", senderSessionId: fromSessionId },
  });
  agent.followup(message);
  const accepted = await ctx.sessions.flush(agent.session);
  if (!accepted) throw new Error(`welcome for role ${roleName} was queued but no durable session flush participated`);
  return { messageId: message.id, sessionId: toSessionId, acceptedAt: Date.now() };
}

export interface GovernedRolePlan {
  roleId: string;
  roleName: string;
  sessionId: string;
  /** Resolved backend; selects both the provisioning and the delivery path. */
  execution: TeamRoleExecution;
  /**
   * Controller Session id, present only for `subagent` roles. The child's
   * direct-parent edge is what authorizes later delivery, so it is durable.
   */
  parentSessionId?: string;
  /** Agent Preset to mount; absent for `subagent` roles, which join the parent's. */
  presetId?: string;
  /** Declared sandbox; absent for `subagent` roles, whose mode is frozen at delegation. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Native per-child model route, present only for `subagent` roles. */
  agentOptions?: SubagentNodeSpec["agentOptions"];
  /** Native per-child tool scoping, present only for `subagent` roles. */
  toolFilter?: SubagentNodeSpec["toolFilter"];
  /** Native per-child persona, present only for `subagent` roles. */
  persona?: string;
  welcome?: string;
  maxRounds?: number;
  protocol?: TopologyProtocol;
  /** Complete Blueprint for a `session` role. A `subagent` role has none: the native
   *  contract mounts no composition of its own, so fabricating a receipt would
   *  claim facts the child never had. */
  blueprint?: PreparedGovernedBlueprint;
}

/**
 * Recorded sandbox for a role whose mode this plugin does not choose.
 *
 * A native sub-agent's sandbox is frozen from its parent's explicit override at
 * the delegation boundary, so a `subagent` role has no declared mode to store.
 * `"inherited"` is a durable, honest marker — never a value to switch on — and
 * the Actor's own confined calls remain governed by the child's real mode.
 */
const INHERITED_SANDBOX = "inherited";

function governedSessionId(teamId: string): string {
  // Role ids are durable domain keys, not filesystem-safe session ids. Keep
  // the mapping in team.json and give every reserved role an independent id.
  return `orchestra-${teamId}-${randomUUID()}`;
}

export function assertUniqueGovernedSessionIds(plans: readonly Pick<GovernedRolePlan, "roleId" | "sessionId">[]): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    if (seen.has(plan.sessionId)) throw new Error(`governed role session id collision before reservation: ${plan.roleId} -> ${plan.sessionId}`);
    seen.add(plan.sessionId);
  }
}

function roleBlueprintFacts(receipt: GovernedBlueprintReceipt): TeamRoleBlueprintFacts {
  return {
    mode: "governed",
    teamId: receipt.teamId,
    roleId: receipt.roleId,
    topologyId: receipt.topologyId,
    topologySource: receipt.topologySource,
    controllerSessionId: receipt.controllerSessionId,
    agentPreset: receipt.agentPreset,
    permissionPreset: receipt.permissionPreset,
    effectivePermissionPreset: receipt.effectivePermissionPreset,
    approval: receipt.approval,
    sandbox: receipt.sandbox,
    provider: receipt.provider,
    model: receipt.model,
    ...(receipt.reasoningEffort === undefined ? {} : { reasoningEffort: receipt.reasoningEffort }),
    cwd: receipt.cwd,
    ...(receipt.title === undefined ? {} : { title: receipt.title }),
    compositionTools: receipt.compositionTools,
    orchestraTools: receipt.orchestraTools,
    optionalCapabilities: receipt.optionalCapabilities,
    tools: receipt.tools,
  };
}

function reservedRole(plan: GovernedRolePlan): TeamRole {
  // A subagent role carries no Blueprint receipt: its composition, permission
  // preset, and sandbox all belong to the controller Session it joins. Only the
  // native per-child options it actually declared are recorded.
  const receipt = plan.blueprint?.receipt;
  const model = receipt === undefined ? plan.agentOptions : {
    provider: receipt.provider,
    model: receipt.model,
    ...(receipt.reasoningEffort === undefined ? {} : { reasoningEffort: receipt.reasoningEffort }),
  };
  return {
    id: plan.roleId,
    name: plan.roleName,
    sessionId: plan.sessionId,
    phase: "reserved",
    execution: plan.execution,
    ...(plan.execution === "subagent" && plan.parentSessionId !== undefined ? { parentSessionId: plan.parentSessionId } : {}),
    sessionHistory: [],
    preset: plan.presetId ?? null,
    sandbox: plan.sandbox ?? INHERITED_SANDBOX,
    ...(model === undefined ? {} : { model }),
    ...(receipt === undefined ? {} : { blueprint: roleBlueprintFacts(receipt) }),
    reportCount: 0,
    lastReport: null,
  };
}

function updateTeamRole(team: TeamState, roleId: string, patch: Partial<TeamRole>): TeamState {
  return {
    ...team,
    roles: team.roles.map((role) => (role.id === roleId ? { ...role, ...patch } : role)),
  };
}

function provisioningDiagnostic(error: unknown): TeamRoleDiagnostic {
  const code = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : "provisioning_failed";
  return { code, message: error instanceof Error ? error.message : String(error) };
}

async function disposeCreatedHandles(handles: AgentHandle[]): Promise<void> {
  for (const handle of handles.reverse()) {
    try {
      await handle.dispose();
    } catch {
      // The durable failed/blocked state is the source of truth even if cleanup reports a secondary error.
    }
  }
}

/** 写入开场消息的协议段（ownership / routes / completion / maxRounds）。 */
function welcomeProtocol(plan: GovernedRolePlan): Parameters<typeof roleProtocolText>[2] {
  return {
    ownership: plan.protocol?.ownership,
    routes: plan.protocol?.routes,
    completion: plan.protocol?.completion,
    maxRounds: plan.maxRounds,
  };
}

export async function prepareGovernedRolePlan(
  ctx: Context,
  options: {
    cwd: string;
    teamId: string;
    controllerSessionId: string;
    topologyId: string;
    topologySource: "project" | "global" | "bundled";
    role: RoleConfig;
    presetId?: string | null;
    sandbox?: string;
    welcome?: string;
    protocol?: TopologyProtocol;
    maxRounds?: number;
    permissionPreset?: string;
    compositionTools?: string[];
    orchestraTools?: string[];
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    title?: string;
    /** Native per-child tool scoping; only meaningful for a `subagent` role. */
    toolFilter?: { allow?: string[]; deny?: string[] };
    /** Native per-child persona; only meaningful for a `subagent` role. */
    persona?: string;
    signal?: AbortSignal;
  },
): Promise<GovernedRolePlan> {
  const sessionId = governedSessionId(options.teamId);
  const execution = resolveRoleExecution(options.role);
  if (execution === "subagent") {
    return prepareSubagentRolePlan(options, sessionId);
  }
  const presetId = options.presetId ?? options.role.preset;
  if (typeof presetId !== "string" || presetId === "") {
    throw new Error(`governed role "${options.role.id}" requires an explicit complete Agent Preset`);
  }
  const requestedSandbox = options.sandbox ?? options.role.sandbox;
  if (requestedSandbox !== undefined && requestedSandbox !== "read-only" && requestedSandbox !== "workspace-write" && requestedSandbox !== "danger-full-access") {
    throw new Error(`governed role "${options.role.id}" has invalid sandbox "${requestedSandbox}"`);
  }
  const presetFile = await resolvePresetFile(ctx, options.cwd, presetId);
  const roleSpec = rolePresetSpec(presetId);
  const roleConfig = options.role as RoleConfig & { requiredTools?: string[] };
  const compositionTools = options.compositionTools ?? roleConfig.compositionTools ?? roleSpec?.compositionTools;
  const orchestraTools = options.orchestraTools ?? roleConfig.orchestraTools ?? roleSpec?.orchestraTools;
  const requiredTools = roleConfig.requiredTools;
  if (roleSpec === undefined && presetFile.path !== "" && compositionTools === undefined && (requiredTools === undefined || requiredTools.length === 0)) {
    throw new SessionBlueprintError(
      "composition_tools_unproven",
      "Governed role preset " + presetId + " is not cataloged and has no explicit static compositionTools proof; reservation was not attempted",
      { presetId, source: presetFile.source, plane: "composition" },
    );
  }
  preflightGovernedRequiredTools({
    requiredTools,
    compositionTools,
    orchestraTools,
    presetId,
    presetFile,
    rolePresetSpec: roleSpec,
    staticCompositionTools: presetFile.compositionRowIds,
    hostToolNames: hostToolNamesForPreflight(ctx),
  });
  const presetInput = presetFile.source === "dsh" ? { presetId } : { presetFile };
  const blueprint = await prepareGovernedBlueprint(ctx, {
    sessionId,
    teamId: options.teamId,
    roleId: options.role.id,
    roleName: options.role.name,
    topologyId: options.topologyId,
    topologySource: options.topologySource,
    controllerSessionId: options.controllerSessionId,
    cwd: options.cwd,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...presetInput,
    permissionPreset: options.permissionPreset,
    ...(requestedSandbox === undefined ? {} : { sandbox: requestedSandbox as "read-only" | "workspace-write" | "danger-full-access" }),
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    runtime: options.role.runtime,
    compositionTools,
    orchestraTools,
    optionalCapabilities: roleSpec?.optionalCapabilities,
    requiredTools,
    signal: options.signal,
  });
  return {
    roleId: options.role.id,
    roleName: options.role.name,
    sessionId,
    execution: "session",
    presetId: blueprint.receipt.agentPreset,
    sandbox: blueprint.receipt.sandbox,
    ...(options.welcome === undefined ? {} : { welcome: options.welcome }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    blueprint,
  };
}

/**
 * Plan one `subagent` role: a durable native child of the controller Session.
 *
 * This branch deliberately runs NONE of the Session machinery — no preset
 * resolution, no permission preset, no Blueprint, no composition preflight —
 * because none of it applies: the child joins its parent's live composition and
 * its sandbox and approval policy are fixed at the delegation boundary. What it
 * does instead is validate the native limits loudly, so a caller that asks for
 * something the child cannot have is told why rather than silently ignored.
 *
 * @param options - the same call shape `prepareGovernedRolePlan` accepts.
 * @param sessionId - the pre-reserved identity, which becomes the child id so
 *   team.json can record provisioning before materialization.
 * @returns a Blueprint-free plan carrying only the native per-child knobs.
 * @throws when the request names a preset or sandbox, when the model route is
 *   incomplete, or when a native knob has an unusable shape.
 */
function prepareSubagentRolePlan(
  options: Parameters<typeof prepareGovernedRolePlan>[1],
  sessionId: string,
): GovernedRolePlan {
  const roleId = options.role.id;
  const requestedPreset = options.presetId ?? options.role.preset;
  if (typeof requestedPreset === "string" && requestedPreset !== "") {
    throw new Error(
      `governed role "${roleId}" resolves to the "subagent" backend but requests preset "${requestedPreset}": a native sub-agent joins its parent's live Agent Preset and cannot mount its own composition, so the preset would never take effect — use execution: "session" for a role that needs its own preset`,
    );
  }
  const requestedSandbox = options.sandbox ?? options.role.sandbox;
  if (requestedSandbox !== undefined) {
    throw new Error(
      `governed role "${roleId}" resolves to the "subagent" backend but requests sandbox "${requestedSandbox}": a native sub-agent's sandbox mode is frozen from its parent's explicit override at the delegation boundary and its approval policy is pinned to "never", so the sandbox would never take effect — use execution: "session" for a read-only or otherwise restricted role`,
    );
  }
  const { provider, model, reasoningEffort } = options;
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error(`governed role "${roleId}" subagent model route must provide provider and model together`);
  }
  if (reasoningEffort !== undefined && (provider === undefined || model === undefined)) {
    throw new Error(`governed role "${roleId}" subagent model reasoningEffort requires provider and model`);
  }
  // The topology role is the durable declaration; a caller-supplied override
  // wins for one provisioning only, exactly like presetId.
  const toolFilter = options.toolFilter ?? options.role.toolFilter;
  if (toolFilter !== undefined) {
    for (const field of ["allow", "deny"] as const) {
      const value = toolFilter[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name === ""))) {
        throw new Error(`governed role "${roleId}" subagent toolFilter.${field} must be an array of non-empty tool names`);
      }
    }
  }
  const persona = options.persona ?? options.role.persona;
  if (persona !== undefined && (typeof persona !== "string" || persona === "")) {
    throw new Error(`governed role "${roleId}" subagent persona must be a non-empty string`);
  }
  return {
    roleId,
    roleName: options.role.name,
    sessionId,
    execution: "subagent",
    parentSessionId: options.controllerSessionId,
    ...(provider === undefined ? {} : { agentOptions: { provider, model: model as string, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }),
    ...(toolFilter === undefined ? {} : { toolFilter }),
    ...(persona === undefined ? {} : { persona }),
    ...(options.welcome === undefined ? {} : { welcome: options.welcome }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
  };
}

/**
 * The FROZEN charter revision the Team runs under, with the Loop contracts that
 * revision fixes.
 *
 * Both the bounded-run sweep and the health projection read the same authority:
 * the charter a run was APPROVED under is the only one whose deadlines,
 * budgets, and stall grace that run obeys. A later revision's contracts must
 * never govern an older run's Attempts, or a re-drafted charter would silently
 * rewrite the rules of work already in flight.
 *
 * @param team - the active Team.
 * @returns the frozen revision, its digest, and its Loop contracts; undefined
 *   when the Team has no document, no current revision, or no such revision.
 */
function frozenCharterOf(team: TeamState): { charterRevision: number; digest: string; contracts: TopologyLoopContract[] } | undefined {
  const document = documentReadForTeam(team);
  const revision = document?.currentCharterRevision;
  if (document === undefined || revision === null || revision === undefined) return undefined;
  const frozen = document.charterRevisions.find((entry) => entry.charterRevision === revision);
  if (frozen === undefined) return undefined;
  return { charterRevision: frozen.charterRevision, digest: frozen.digest, contracts: frozen.topology.config.protocol?.loops ?? [] };
}

/** Derived health inputs one Team's role rows share: one read serves every role. */
export interface TeamRoleHealth {
  loops: LoopSummary[];
  contracts: TopologyLoopContract[];
  now: number;
}

/**
 * Derived health inputs for one Team's role rows.
 *
 * The graph runtime is read through the SAME frozen-charter resolution the
 * bounded-run sweep uses, so a row's `stall` and `deadlineAt` always describe
 * the Attempt the sweep would act on. A runtime that no longer matches its
 * charter is still projected: a stale run is precisely when a reader most needs
 * to see that nothing is advancing.
 *
 * @param team - the active Team.
 * @returns the shared health inputs, or undefined when the Team has no readable
 *   graph runtime (in which case rows carry no stall claim at all).
 */
function roleHealthFor(team: TeamState): TeamRoleHealth | undefined {
  if (team.graphRuntime === undefined) return undefined;
  const frozen = frozenCharterOf(team);
  const read = readGraphRuntime(team.graphRuntime, team.teamId, frozen?.charterRevision, frozen?.digest);
  if (read.kind !== "ready" && read.kind !== "stale") return undefined;
  return { loops: graphLoops(read.runtime), contracts: frozen?.contracts ?? [], now: Date.now() };
}

/**
 * The newest OPEN Attempt belonging to one role, with the Loop it runs in.
 *
 * Matching on the Attempt's own `roleId` (rather than on a Loop-level
 * participant list) keeps the link honest for a Loop whose participants change
 * between Attempts: the row describes the Attempt that is actually open.
 *
 * @param loops - every Loop of the runtime.
 * @param roleId - the role whose open Attempt is wanted.
 * @returns the newest match, or undefined when the role has no open Attempt.
 */
export function openAttemptFor(loops: readonly LoopSummary[], roleId: string): { loopId: string; loopInstanceId: string; attempt: LoopSummary["attempts"][number] } | undefined {
  let found: { loopId: string; loopInstanceId: string; attempt: LoopSummary["attempts"][number] } | undefined;
  for (const loop of loops) {
    const attempt = loop.attempts.at(-1);
    if (attempt === undefined || attempt.status !== "started") continue;
    if (attempt.roleId !== roleId) continue;
    found = { loopId: loop.loopId, loopInstanceId: loop.loopInstanceId, attempt };
  }
  return found;
}

/** One role row's derived stall verdict and open-Attempt timing. */
export interface RoleAttemptHealth {
  stall: NodeStall;
  attempt?: { loopInstanceId: string; loopId: string; attempt: number; startedAt: number; deadlineAt: number; msRemaining: number; expired: boolean };
}

/**
 * The derived stall verdict and Attempt timing for one role row.
 *
 * Pure by construction: every input is an observation the caller already made,
 * so the same facts always produce the same row — a projection can be recomputed
 * after a restart, and a test can drive it without a live Team.
 *
 * @param role - the durable role record (only its id is read).
 * @param health - the Team's shared Attempt/contract inputs.
 * @param observations - whether the node is working, and when it was last seen.
 * @returns the stall verdict, plus Attempt timing when the role has one open.
 */
export function roleAttemptHealth(
  role: Pick<TeamRole, "id">,
  health: TeamRoleHealth,
  observations: { working: boolean; lastActivityAt: number | undefined },
): RoleAttemptHealth {
  const open = openAttemptFor(health.loops, role.id);
  const contract = open === undefined ? undefined : health.contracts.find((entry) => entry.loopId === open.loopId);
  const stall = nodeStall({
    attempt: open?.attempt,
    contract,
    working: observations.working,
    lastActivityAt: observations.lastActivityAt,
    now: health.now,
  });
  if (open === undefined) return { stall };
  return {
    stall,
    attempt: {
      loopInstanceId: open.loopInstanceId,
      loopId: open.loopId,
      attempt: open.attempt.attempt,
      startedAt: open.attempt.startedAt,
      deadlineAt: open.attempt.deadlineAt,
      msRemaining: Math.max(open.attempt.deadlineAt - health.now, 0),
      expired: health.now >= open.attempt.deadlineAt,
    },
  };
}

/**
 * Whether a node is demonstrably working right now.
 *
 * Two independent facts count, because either alone under-reports: `running`
 * says a turn is in flight, and a non-empty inbox says accepted work is parked
 * for the next step. A node with queued work that has not started its turn yet
 * is not stalled — it is waiting to be scheduled.
 *
 * @param agent - the live agent, when the role is loaded.
 * @returns true when the node is working or has pending work.
 */
export function nodeIsWorking(agent: { status?: string; inbox?: { nextTurn?: readonly unknown[]; nextStep?: readonly unknown[] } } | undefined): boolean {
  if (agent === undefined) return false;
  if (agent.status === "running") return true;
  const inbox = agent.inbox;
  if (inbox === undefined) return false;
  return (inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0;
}

/**
 * One role's proposal-card facts, resolved through the same preset/permission/
 * model seams that create-time provisioning uses (see prepareGovernedRolePlan).
 * This is presentation + pre-parsing only: it never creates a Session, never
 * persists a blueprint marker, and never changes Frozen Charter semantics.
 */
export interface DraftRoleFacts {
  roleId: string;
  roleName: string;
  /**
   * Resolved backend of this role — the one fact a user must see to judge a
   * proposal, since it decides whether the role can hold its own composition,
   * ask for approval, or be read-only at all.
   */
  execution: TeamRoleExecution;
  /** Session rows only: the composed Agent Preset. Absent for a subagent row. */
  preset?: string;
  presetSource?: "project" | "global" | "dsh" | "builtin";
  /**
   * `inherited` marks a subagent row: a delegated child's sandbox mode is frozen
   * from the driver's explicit override at the delegation boundary, so no
   * per-role mode exists to report.
   */
  sandbox: "read-only" | "workspace-write" | "danger-full-access" | "inherited";
  /** Session rows only. A subagent row has no permission preset: its approval policy is pinned to `never`. */
  permissionPreset?: string;
  effectivePermissionPreset?: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  /** Native per-child persona; only a subagent row can carry one. */
  persona?: string;
  /** Native per-child tool scoping; only a subagent row can carry one. */
  toolFilter?: { allow?: string[]; deny?: string[] };
  compositionTools: string[];
  orchestraTools: string[];
}

async function draftPermissionFacts(
  ctx: Context,
  roleSandbox: string | undefined,
): Promise<{ permissionPreset: string; effectivePermissionPreset: string; sandbox: DraftRoleFacts["sandbox"]; approval: string }> {
  const permissions = ctx.get("permissionPresets");
  if (permissions === undefined) throw new Error("permissionPresets service is unavailable");
  // Mirrors prepareGovernedBlueprint exactly: the deployment default preset is
  // the base permission, never the catalog spec's declared default.
  const permissionPreset = permissions.defaultPreset;
  if (permissionPreset === undefined) throw new Error("permissionPresets has no default preset for the draft role");
  let permissionSpec: { sandbox: string; approval: string };
  try {
    permissionSpec = permissions.resolve(permissionPreset) as { sandbox: string; approval: string };
  } catch (error) {
    throw new Error(`permission preset "${permissionPreset}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof permissionSpec.approval !== "string" || permissionSpec.approval === "") throw new Error(`permission preset "${permissionPreset}" has no usable approval policy`);
  const sandbox = roleSandbox ?? permissionSpec.sandbox;
  if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") {
    throw new Error(`draft role effective sandbox "${String(sandbox)}" is invalid`);
  }
  return {
    permissionPreset,
    effectivePermissionPreset: sandbox === permissionSpec.sandbox ? permissionPreset : "custom",
    sandbox,
    approval: permissionSpec.approval,
  };
}

/**
 * Draft-time per-role blueprint pre-parsing: mirrors prepareGovernedRolePlan's
 * resolution order (resolvePresetFile → rolePresetSpec → tools → sandbox /
 * permission preset → model), so the proposal card matches what orchestra_create
 * will provision. Any resolution failure fails the draft instead of being
 * silently skipped.
 */
export async function preparseDraftRoleFacts(ctx: Context, cwd: string, role: RoleConfig): Promise<DraftRoleFacts> {
  // The two backends have disjoint fact sets, so the draft must branch exactly
  // where provisioning branches. Without this, a hybrid topology whose
  // `subagent` role correctly declares no preset would fail the session path's
  // "requires an explicit complete Agent Preset" check and no proposal could
  // ever be drafted for it.
  if (resolveRoleExecution(role) === "subagent") return preparseSubagentDraftRoleFacts(ctx, role);
  const presetId = role.preset;
  if (typeof presetId !== "string" || presetId === "") {
    throw new Error(`draft topology role "${role.id}" requires an explicit complete Agent Preset`);
  }
  const presetFile = await resolvePresetFile(ctx, cwd, presetId);
  const roleSpec = rolePresetSpec(presetId);
  const compositionTools = role.compositionTools ?? roleSpec?.compositionTools;
  const orchestraTools = role.orchestraTools ?? roleSpec?.orchestraTools;
  if (roleSpec === undefined && presetFile.path !== "" && compositionTools === undefined) {
    throw new SessionBlueprintError(
      "composition_tools_unproven",
      "Draft role preset " + presetId + " is not cataloged and has no explicit static compositionTools proof; approval draft was not created",
      { roleId: role.id, presetId, source: presetFile.source, plane: "composition" },
    );
  }
  const permission = await draftPermissionFacts(ctx, role.sandbox);
  const model = resolveDraftRoleModel(ctx, { runtime: role.runtime });
  if (model.provider === "" || model.model === "") throw new Error(`draft role "${role.id}" resolved an empty provider/model selection`);
  return {
    roleId: role.id,
    roleName: role.name ?? role.id,
    execution: "session",
    preset: presetId,
    ...(presetFile.source === undefined ? {} : { presetSource: presetFile.source }),
    sandbox: permission.sandbox,
    permissionPreset: permission.permissionPreset,
    effectivePermissionPreset: permission.effectivePermissionPreset,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    compositionTools: compositionTools ?? [],
    orchestraTools: (orchestraTools ?? []).filter((name) => !REMOVED_ORCHESTRA_TOOLS.has(name)),
  };
}

/**
 * Draft-time facts for a `subagent` role.
 *
 * The session path's whole pre-parse — preset file, composition proof,
 * permission preset — has no counterpart here, because the native contract
 * provides none of it: a delegated child joins its parent's LIVE composition
 * and has its approval policy pinned at the delegation boundary. What a
 * proposal can honestly promise is therefore only the model route and the two
 * native per-child knobs, and the row says exactly that rather than borrowing
 * columns that would not hold.
 *
 * A preset or sandbox reaching this path is refused instead of rendered: the
 * topology validator already rejects both, and a draft that displayed them
 * would make the proposal card disagree with what provisioning can do.
 *
 * @param ctx - context carrying the model-selection service.
 * @param role - a role that resolved to the `subagent` backend.
 * @returns the facts a user needs to judge this node, with nothing invented.
 * @throws when the role carries a session-only field or resolves no model.
 */
function preparseSubagentDraftRoleFacts(ctx: Context, role: RoleConfig): DraftRoleFacts {
  if (typeof role.preset === "string" && role.preset !== "") {
    throw new Error(
      `draft topology role "${role.id}" resolves to the "subagent" backend but declares preset "${role.preset}": a native sub-agent joins its parent's live Agent Preset and cannot mount its own composition — use execution: "session" for a role that needs its own preset`,
    );
  }
  if (role.sandbox !== undefined) {
    throw new Error(
      `draft topology role "${role.id}" resolves to the "subagent" backend but declares sandbox "${String(role.sandbox)}": a native sub-agent's sandbox mode is frozen from its parent's explicit override at the delegation boundary — use execution: "session" for a read-only or otherwise restricted role`,
    );
  }
  const model = resolveDraftRoleModel(ctx, { runtime: role.runtime });
  if (model.provider === "" || model.model === "") throw new Error(`draft topology role "${role.id}" resolved an empty provider/model selection`);
  const toolFilter = role.toolFilter;
  return {
    roleId: role.id,
    roleName: role.name ?? role.id,
    execution: "subagent",
    sandbox: "inherited",
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(role.persona === undefined ? {} : { persona: role.persona }),
    ...(toolFilter === undefined
      ? {}
      : {
          toolFilter: {
            ...(toolFilter.allow === undefined ? {} : { allow: [...toolFilter.allow] }),
            ...(toolFilter.deny === undefined ? {} : { deny: [...toolFilter.deny] }),
          },
        }),
    compositionTools: [],
    orchestraTools: [],
  };
}

/** Markdown table cells; missing/empty values render as "-" for a stable grid. */
function tableCell(value: string | undefined): string {
  return value === undefined || value === "" ? "-" : value;
}

/**
 * Render the per-role blueprint preview as a Markdown table (rendered as a
 * table card by the GUI). Header + separator + one row per role; an empty
 * preview yields just the header and separator.
 *
 * The `backend` column comes first because it is what a user has to judge
 * before approving: it decides whether the role can hold its own composition,
 * ask for approval, or be read-only at all. A `subagent` row then reads `-` in
 * the columns the native contract cannot fill, and its two native knobs are
 * summarized on one line under the table rather than in two more columns that
 * would be empty for every session role.
 */
export function renderDraftBlueprintTable(preview: readonly DraftRoleFacts[]): string {
  const header = "| 角色 | backend | preset | sandbox | permission | model | reasoningEffort | compositionTools | orchestraTools |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = preview.map((role) =>
    `| ${[
      tableCell(role.roleId),
      tableCell(role.execution),
      tableCell(role.preset),
      tableCell(role.sandbox),
      tableCell(role.effectivePermissionPreset),
      `${tableCell(role.provider)}/${tableCell(role.model)}`,
      tableCell(role.reasoningEffort),
      // `tableCell` is what keeps the grid rectangular: a subagent row has no
      // tool lists at all, and an empty cell would collapse the columns.
      tableCell(role.compositionTools.join(", ")),
      tableCell(role.orchestraTools.join(", ")),
    ].join(" | ")} |`,
  );
  return [header, separator, ...rows, ...subagentKnobNotes(preview)].join("\n");
}

/**
 * One summary line per `subagent` role, listing the native knobs it carries.
 *
 * These rows have no preset and no permission to show, so without this line a
 * user approving a hybrid proposal could not tell one sub-agent node from
 * another. Rendering them as an explicit note (instead of two more table
 * columns that every session role would leave empty) keeps the grid readable.
 *
 * @param preview - the same rows the table renders.
 * @returns zero or more Markdown lines to append below the table.
 */
function subagentKnobNotes(preview: readonly DraftRoleFacts[]): string[] {
  const notes = preview
    .filter((role) => role.execution === "subagent")
    .map((role) => {
      const knobs: string[] = [];
      if (role.persona !== undefined) knobs.push(`persona ${role.persona.length} 字符`);
      const filter = role.toolFilter;
      if (filter !== undefined) {
        if (filter.allow !== undefined) knobs.push(`toolFilter allow=[${filter.allow.join(", ")}]`);
        if (filter.deny !== undefined) knobs.push(`toolFilter deny=[${filter.deny.join(", ")}]`);
      }
      return `- \`${role.roleId}\`（subagent）：继承 driver 的 composition 与权限（审批钉死 never）；原生可调项 ${knobs.length === 0 ? "无（仅模型路由）" : knobs.join("；")}`;
    });
  return notes.length === 0 ? [] : ["", ...notes];
}

async function readySnapshotAfterWrite(
  activeTeamState: ActiveTeamStateStore,
  cwd: string,
  result: { snapshot?: ActiveTeamReady },
  signal?: AbortSignal,
): Promise<ActiveTeamReady> {
  if (result.snapshot !== undefined) return result.snapshot;
  const observed = await activeTeamState.read(cwd, { signal });
  if (observed.kind === "ready") return observed;
  throw new Error(`active team write did not return a ready snapshot (${observed.kind})`);
}

interface DocumentPersistenceResult {
  snapshot: ActiveTeamReady;
  document: OrchestrationDocument;
  markdown: Awaited<ReturnType<typeof writeMarkdownProjection>>;
}

function documentCommandError(action: string, error: unknown): Error {
  if (error instanceof OrchestrationDocumentError) {
    return new Error(`cannot ${action}: ${error.code}: ${error.message}`);
  }
  return new Error(`cannot ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

async function persistDocumentTransition(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  snapshot: ActiveTeamReady,
  document: OrchestrationDocument,
  exec: ToolExecutionInput,
): Promise<DocumentPersistenceResult> {
  const cwd = snapshot.cwd;
  const nextTeam: TeamState = { ...snapshot.team, document };
  const written = await activeTeamState.replace(snapshot, nextTeam, {
    policy: escrowPolicy(ctx, exec),
    signal: exec.signal,
  });
  const nextSnapshot = await readySnapshotAfterWrite(activeTeamState, cwd, written, exec.signal);
  const markdown = await writeMarkdownProjection(ctx.fs, cwd, document, {
    policy: escrowPolicy(ctx, exec),
    signal: exec.signal,
    stale: isRuntimeProjectionStale(document, nextSnapshot.team),
  });
  return { snapshot: nextSnapshot, document, markdown };
}

function documentReadForTeam(team: TeamState): OrchestrationDocument | undefined {
  const result = readOrchestrationDocument(team.document, team.teamId);
  if (result.kind === "blocked") {
    throw new Error(`active team document is blocked (${result.diagnostic.code}): ${result.diagnostic.message}`);
  }
  return result.kind === "ready" ? result.document : undefined;
}

/** Existing legacy Teams require an explicit Driver reconcile before spawn may CAS them. */
export function assertSpawnableTeamDocument(state: ActiveTeamRead): void {
  throwIfBlocked("spawn a role", state);
  if (state.kind === "ready" && state.team.document === undefined) {
    throw new Error("cannot spawn a role: legacy_missing (spawning does not initialize a legacy document)");
  }
}

export function rejectDirectGovernedSpawn(): void {
  throw new Error("approval_required: a governed roster cannot be mutated directly; change it through orchestra_draft → the user's approval (a plain yes) → orchestra_create");
}

function documentToolStatus(
  team: TeamState | undefined,
  document: OrchestrationDocument | undefined,
  markdown: Awaited<ReturnType<typeof inspectMarkdownProjection>> | undefined,
  diagnostic?: { code: string; message: string },
) {
  if (team === undefined) {
    return {
      status: diagnostic === undefined ? ("missing" as const) : ("blocked" as const),
      team_id: null,
      document_revision: 0,
      charter_status: "legacy_missing" as const,
    runtime_stale: true,
    runtime_projection: null,
    decisions: [],
      markdown: { path: "", status: "projection_failed" as const, message: "no active Team" },
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }
  if (document === undefined) {
    return {
      status: "legacy_missing" as const,
      team_id: team.teamId,
      document_revision: 0,
      charter_status: "legacy_missing" as const,
    runtime_stale: true,
    runtime_projection: null,
    decisions: [],
      markdown: markdown ?? { path: `${team.rootCwd}/orchestra/orchestration.md`, status: "projection_failed" as const, message: "canonical document is absent" },
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }
  const summary = documentSummary(document, team);
  return {
    status: markdown?.status === "projection_failed" ? ("projection_failed" as const) : markdown?.status === "stale" ? ("stale" as const) : ("ready" as const),
    team_id: team.teamId,
    document_revision: summary.revision,
    charter_status: summary.status,
    runtime_stale: summary.stale,
    ...(summary.currentCharterRevision === undefined ? {} : { current_charter_revision: summary.currentCharterRevision }),
    ...(summary.currentCharterDigest === undefined ? {} : { charter_digest: summary.currentCharterDigest }),
    ...(summary.approvalRef === undefined ? {} : { approval_ref: summary.approvalRef }),
    runtime_projection: document.runtimeProjection,
    decisions: document.decisions,
    markdown: markdown ?? { path: document.markdown.path, status: "projection_failed" as const, message: "projection was not inspected" },
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

/**
 * The charter record list, oldest first.
 *
 * These records used to be Session events on the driver's log, folded back out
 * of it on every read. They are a file now (`docs/adr/0002`), which is also the
 * authority change the user approved: the charter is a document, and the driver
 * session merely operates it — so a driver that dies does not take the charter
 * with it, and a driver log stays readable by the rest of DSH.
 *
 * The read is async because it hits the filesystem; every caller was already in
 * an async command handler.
 *
 * @param ctx - host context.
 * @param session - the calling Session, used only for its working directory.
 * @returns the stored charter records, or an empty list when none exist yet.
 */
async function charterEventsOf(ctx: Context, session: { header?: { cwd?: string } }): Promise<readonly unknown[]> {
  const cwd = session?.header?.cwd;
  if (cwd === undefined || cwd === "") throw new Error("cannot read the charter records: the calling session has no working directory");
  return charterRecordStoreFor(ctx, cwd).read();
}

function charterCommandError(action: string, error: unknown): Error {
  if (error instanceof CharterError) return new Error(`cannot ${action}: ${error.code}: ${error.message}`);
  return new Error(`cannot ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Record one charter fact.
 *
 * The old implementation appended to the session log, flushed it, and — if the
 * flush was refused — "quarantined" the appended event so the fold would stop
 * seeing it. That whole dance existed to make an append into someone else's log
 * look atomic. A guarded file append either lands or reports that it did not, so
 * there is nothing left to quarantine.
 */
async function appendDurableCharterEvent(ctx: Context, session: { header?: { cwd?: string } }, event: CharterEvent): Promise<void> {
  const cwd = session?.header?.cwd;
  if (cwd === undefined || cwd === "") throw new Error(`cannot record ${event.type}: the calling session has no working directory`);
  const policy = ctx.sandboxPolicy?.resolve?.({ session: session as any, mode: "workspace-write" });
  await charterRecordStoreFor(ctx, cwd).append(event, { policy });
}

/**
 * Words that count as a yes, and NOTHING else does.
 *
 * The user asked for approval to be one plain sentence instead of a slash
 * command ("直接让用户回复一句'启动'就行了。打 slash 其实很麻烦"), which means this
 * set is the new hard gate. Two guards keep it from becoming a loophole:
 *
 * - the reply must be SHORT (see {@link AFFIRMATIVE_MAX_LENGTH}). A long message
 *   that merely contains 可以 is a message about something else, and treating it
 *   as consent is how a gate turns into a formality.
 * - it must be the WHOLE message, not a substring of one.
 */
const AFFIRMATIVE_REPLY = /^(启动|开始|开工|开始吧|可以|行|好|好的|同意|批准|确认|没问题|ok|okay|go|approve|yes)[\s!！。.，,~～]*$/i;
const AFFIRMATIVE_MAX_LENGTH = 40;

/** The plain text of one user message, or "" when it carries none. */
function userMessageText(data: unknown): string {
  const content = (data as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

interface RecordApprovalResult {
  changed: boolean;
  digest: string;
  ref: string;
  approvalRef: string;
}

/**
 * Record one user approval of a charter draft revision.
 *
 * Shared by the `/team approve <draftId>@<revision>` command and by a plain
 * "启动" reply, so both paths produce a byte-identical record — the difference
 * between them is only HOW the user said yes, never WHAT gets recorded.
 *
 * @param provenanceRef - a durable reference to whatever carried the consent
 *   (a command id, or `message:<sessionId>@<seq>` for a chat reply). It is stored
 *   as the approval's `commandId`, so the record still answers "what exactly did
 *   the user approve, and where is that act?".
 */
async function recordCharterApproval(
  ctx: Context,
  session: { header?: { cwd?: string } },
  input: {
    draftId: string;
    revision: number;
    approvingSessionId: string;
    provenanceRef: string;
    approvedAt: number;
    /** How the user said yes; recorded verbatim in the approval record. */
    source: "user-command" | "user-reply";
  },
): Promise<RecordApprovalResult> {
  const events = await charterEventsOf(ctx, session);
  let command;
  try {
    command = prepareApprovalEvent(events, {
      draftId: input.draftId,
      revision: input.revision,
      commandId: input.provenanceRef,
      approvingSessionId: input.approvingSessionId,
      approvedAt: input.approvedAt,
      source: input.source,
    });
  } catch (error) {
    throw charterCommandError("approve the charter draft", error);
  }
  if (command.kind === "changed") await appendDurableCharterEvent(ctx, session, command.event);
  return {
    changed: command.kind === "changed",
    digest: command.value.digest,
    ref: frozenRef(input.draftId, input.revision, command.value.digest),
    approvalRef: command.value.approvalRef,
  };
}

/**
 * Wake the driver after an approval.
 *
 * The approval is durable, but the driver's turn ended when it handed control
 * back to the user — without a followup it waits forever for a signal that never
 * comes (4600 实测发现). Single plugin-source notice, same shape as the /team
 * marker (never split deliveries).
 */
function approvalNotice(draftId: string, revision: number, result: RecordApprovalResult, how: string): unknown {
  return createUserMessage({
    content: [{ type: "text", text: `(orchestra /team approval notice) Draft ${draftId}@${revision} approved ${how} (digest=${result.digest}, freeze target=${result.ref}). The plan is ready. You can now dispatch tasks using orchestra_dispatch(roleId, task) and wait for reports with orchestra_wait.` }] as ContentBlock[],
    source: {
      kind: "plugin",
      plugin: "orchestra",
      form: "notice",
      summary: "orchestra /team charter approval",
    } as MessageSource,
  });
}

export async function handleTeamApprovalCommand(
  ctx: Context,
  invocation: { rawInput: string; commandId: string; agent: { id: string; session: any; followup?: (message: unknown) => unknown } },
): Promise<{ kind: "success"; text: string }> {
  const raw = invocation.rawInput.trim();
  const approvalMatch = raw.match(/^approve\s+([a-z0-9]+(?:-[a-z0-9]+)*)@([1-9]\d*)\s*$/);
  if (approvalMatch === null) throw new Error("approval command syntax is /team approve <draftId>@<revision>");
  const draftId = approvalMatch[1];
  const revision = Number(approvalMatch[2]);
  const result = await recordCharterApproval(ctx, invocation.agent.session, {
    draftId,
    revision,
    approvingSessionId: invocation.agent.id,
    provenanceRef: String(invocation.commandId),
    approvedAt: Date.now(),
    source: "user-command",
  });
  invocation.agent.followup?.(approvalNotice(draftId, revision, result, "by user command"));
  return result.changed
    ? { kind: "success", text: `Draft ${draftId}@${revision} approved by user command. digest=${result.digest}; freeze target=${result.ref}` }
    : { kind: "success", text: `Draft ${draftId}@${revision} was already approved; freeze target=${result.approvalRef}` };
}

/**
 * The newest draft revision this session wrote that no approval covers yet.
 *
 * "Pending" is derived from the records themselves rather than from a separate
 * pointer file: a pointer could drift from the records, and then an approval
 * would bind to something the user never saw.
 */
async function pendingDraftFor(ctx: Context, session: { header?: { cwd?: string; id?: string } }): Promise<{ draftId: string; revision: number } | undefined> {
  const sessionId = session.header?.id;
  if (sessionId === undefined) return undefined;
  const events = await charterEventsOf(ctx, session);
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") return undefined;
  const mine = folded.drafts.filter((draft) => draft.authorSessionId === sessionId);
  if (mine.length === 0) return undefined;
  const newest = mine.reduce((best, draft) => (draft.revision > best.revision || (draft.revision === best.revision && draft.createdAt > best.createdAt) ? draft : best));
  const approved = folded.approvals.some((entry) => entry.draftId === newest.draftId && entry.revision === newest.revision);
  return approved ? undefined : { draftId: newest.draftId, revision: newest.revision };
}

/**
 * Let one plain user reply approve the pending charter draft.
 *
 * This replaces "natural language is not approval" with the user's own rule:
 * replying 启动 IS approval. What the old rule was actually protecting is
 * enforced here instead, by inspecting the message rather than its syntax:
 *
 * 1. ONLY a real user turn can approve. `source.kind === "user"` excludes plugin
 *    notices and messages relayed from another session — including the role
 *    sessions this plugin creates, which could otherwise approve on the user's
 *    behalf and make the gate decorative.
 * 2. The approval binds to the NEWEST revision this session drafted, and
 *    `prepareApprovalEvent` re-derives that revision's digest from the records.
 *    If the plan changed after it was shown, the consent applies to what is on
 *    record now, and the driver is told exactly which revision it got.
 *
 * @returns the recorded approval, or undefined when the reply was not a yes or
 *   there was nothing pending.
 */
export async function approvePendingDraftFromUserMessage(
  ctx: Context,
  session: { header?: { cwd?: string; id?: string } },
  event: { seq: number; data?: unknown },
): Promise<RecordApprovalResult | undefined> {
  const sessionId = session.header?.id;
  if (sessionId === undefined) return undefined;
  // Checked HERE and not only in the listener that calls this: the guarantee is
  // "only a genuine user turn can approve", and a guarantee that lives in a
  // caller disappears the moment anything else calls the function. Tests call it
  // directly, so a missing check here would also be invisible to the listener's
  // own filter.
  if ((event.data as { source?: { kind?: unknown } } | undefined)?.source?.kind !== "user") return undefined;
  const text = userMessageText(event.data);
  if (text === "" || text.length > AFFIRMATIVE_MAX_LENGTH) return undefined;
  if (!AFFIRMATIVE_REPLY.test(text)) return undefined;
  const pending = await pendingDraftFor(ctx, session);
  if (pending === undefined) return undefined;
  const result = await recordCharterApproval(ctx, session, {
    draftId: pending.draftId,
    revision: pending.revision,
    approvingSessionId: sessionId,
    // Names the exact message that carried the consent, so a reader can go and
    // check what the user actually said.
    provenanceRef: `message:${sessionId}@${event.seq}`,
    approvedAt: Date.now(),
    source: "user-reply",
  });
  const agent = ctx.get("agents")?.get(sessionId as never);
  agent?.followup?.(approvalNotice(pending.draftId, pending.revision, result, "by user reply") as never);
  return result;
}

export async function handleTeamGateDecisionCommand(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  invocation: { rawInput: string; commandId: string; agent: { id: string; session: any; followup?: (message: unknown) => unknown } },
): Promise<{ kind: "success"; text: string }> {
  const match = invocation.rawInput.trim().match(/^decide\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s+(\S+)$/);
  if (match === null) throw new Error("gate decision syntax is /team decide <gateInstanceId> <option>");
  const cwd = invocation.agent.session.header.cwd;
  if (cwd === undefined) throw new Error("current session has no working directory");
  const observed = await activeTeamState.read(cwd);
  throwIfBlocked("decide a Human Gate", observed);
  if (observed.kind !== "ready") throw new Error(`cannot decide a Human Gate: no ready Team (${observed.kind})`);
  const team = observed.team;
  if (invocation.agent.id !== team.controllerSessionId) throw new Error("cannot decide a Human Gate: permission_denied (current Driver required)");
  const frozen = currentFrozenCharter(team);
  const graph = currentGraphRuntime(team);
  if (graph.stale) throw new Error("cannot decide a Human Gate: stale_charter");
  const gate = graphGates(graph.runtime).find((entry) => entry.gateInstanceId === match[1]);
  if (gate === undefined) throw new Error(`cannot decide a Human Gate: gate ${match[1]} is unknown`);
  const definition = frozen.topology.config.protocol?.gates?.find((entry) => entry.gateId === gate.gateId);
  if (definition === undefined) throw new Error(`cannot decide a Human Gate: definition ${gate.gateId} is missing from Frozen Charter`);
  let command;
  try {
    command = resolveGate(graph.runtime, team, definition, { gateInstanceId: gate.gateInstanceId, option: match[2], approvingSessionId: invocation.agent.id, commandId: String(invocation.commandId), source: "user-command", now: Date.now() });
  } catch (error) {
    throw graphCommandError("decide a Human Gate", error);
  }
  // Wake the driver after a user gate decision, same shape as the /team marker
  // (single plugin-source notice — the agent's turn ended when the command was
  // handed to the user, and notifyDriverMilestone skips the controller's own calls).
  const gateNotice = createUserMessage({
    content: [{ type: "text", text: `(orchestra /team gate decision notice) Gate ${gate.gateInstanceId} resolved: ${match[2]}. Continue per the Frozen Charter (reconcile, then proceed along the declared pass route).` }] as ContentBlock[],
    source: {
      kind: "plugin",
      plugin: "orchestra",
      form: "notice",
      summary: "orchestra /team gate decision",
    } as MessageSource,
  });
  if (command.kind === "noop") {
    invocation.agent.followup?.(gateNotice);
    return { kind: "success", text: `Gate ${gate.gateInstanceId} was already resolved with option ${match[2]}` };
  }
  await appendDurableCharterEvent(ctx, invocation.agent.session, { type: GATE_DECISION_EVENT, data: { gateInstanceId: gate.gateInstanceId, option: match[2], commandId: String(invocation.commandId), decidedAt: Date.now(), approvingSessionId: invocation.agent.id, source: "user-command" } });
  try {
    await persistGraphTransition(ctx, activeTeamState, observed, command.runtime, { agent: invocation.agent } as any);
  } catch (error) {
    throw new Error(`gate decision durable but graph transition is pending: ${error instanceof Error ? error.message : String(error)}`);
  }
  await notifyDriverMilestone(ctx, team, invocation.agent.id, "gate", `${gate.gateInstanceId} resolved: ${match[2]}`, {
    recordFailure: noticeRecorderFor(ctx, activeTeamState, invocation.agent.session.header.cwd ?? "", { agent: invocation.agent } as any),
  });
  invocation.agent.followup?.(gateNotice);
  return { kind: "success", text: `Gate ${gate.gateInstanceId} resolved with user option ${match[2]}` };
}

interface CharterDraftToolArgs {
  draftId?: string;
  expectedRevision?: number;
  goal?: string;
  topology?: string;
  inlineTopology?: unknown;
  scope?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  nonGoals?: string[];
  context?: string;
  humanParticipationMode?: "interactive" | "checkpointed" | "autonomous";
  onUnavailable?: "block" | "safe_stop" | "continue_without_gate";
  humanPolicySummary?: string;
  requiredHumanGate?: boolean;
  reason?: string;
  summary?: string;
}

function missionForDraft(args: CharterDraftToolArgs, current?: CharterDraft): CharterMission {
  return {
    objective: String(args.goal ?? current?.mission.objective ?? "").trim(),
    scope: args.scope ?? current?.mission.scope ?? [],
    constraints: args.constraints ?? current?.mission.constraints ?? [],
    acceptanceCriteria: args.acceptanceCriteria ?? current?.mission.acceptanceCriteria ?? [],
    nonGoals: args.nonGoals ?? current?.mission.nonGoals ?? [],
    context: args.context ?? current?.mission.context ?? "",
  };
}

function humanPolicyForDraft(args: CharterDraftToolArgs, current?: CharterDraft): HumanParticipationPolicy {
  return {
    mode: args.humanParticipationMode ?? current?.humanParticipationPolicy.mode ?? "interactive",
    onUnavailable: args.onUnavailable ?? current?.humanParticipationPolicy.onUnavailable ?? "block",
    ...(args.humanPolicySummary === undefined && current?.humanParticipationPolicy.summary === undefined
      ? {}
      : { summary: args.humanPolicySummary ?? current?.humanParticipationPolicy.summary }),
    ...(args.requiredHumanGate === undefined && current?.humanParticipationPolicy.requiredHumanGate === undefined
      ? {}
      : { requiredHumanGate: args.requiredHumanGate ?? current?.humanParticipationPolicy.requiredHumanGate }),
  };
}

async function topologySnapshotForDraft(
  ctx: Context,
  topologyCatalog: TopologyCatalog,
  cwd: string,
  args: CharterDraftToolArgs,
  current: CharterDraft | undefined,
  signal?: AbortSignal,
): Promise<CharterTopologySnapshot> {
  if (args.inlineTopology !== undefined) {
    const inline = args.inlineTopology as any;
    return { source: "inline", id: typeof inline?.id === "string" ? inline.id : "", config: inline };
  }
  if (args.topology !== undefined) {
    const resolved = await topologyCatalog.resolve(cwd, args.topology, { signal });
    if (resolved.kind !== "ready") {
      const available = (await topologyCatalog.list(cwd, { signal })).ready.map((entry) => entry.config.id);
      throw topologyResolutionError("create the charter draft", resolved, available);
    }
    return {
      source: "catalog",
      id: resolved.config.id,
      catalogSource: resolved.source,
      config: resolved.config,
    };
  }
  if (current !== undefined) return current.topology;
  const resolved = await topologyCatalog.resolve(cwd, "duo", { signal });
  if (resolved.kind !== "ready") {
    const available = (await topologyCatalog.list(cwd, { signal })).ready.map((entry) => entry.config.id);
    throw topologyResolutionError("create the charter draft", resolved, available);
  }
  return { source: "catalog", id: resolved.config.id, catalogSource: resolved.source, config: resolved.config };
}

function charterDraftOutput(events: readonly unknown[], draft: CharterDraft) {
  const summary = charterSummary(events, draft.draftId);
  return {
    draft_id: draft.draftId,
    revision: draft.revision,
    digest: draft.digest,
    approval_status: summary.frozen === undefined ? (summary.approval === undefined ? "pending" : "approved") : "frozen",
    ...(summary.frozen === undefined ? {} : { frozen_ref: summary.frozen.frozenRef }),
    ...(draft.baseTeamId === undefined ? {} : { base_team_id: draft.baseTeamId }),
    ...(draft.baseCharterRevision === undefined ? {} : { base_charter_revision: draft.baseCharterRevision }),
    mission: draft.mission,
    topology: { id: draft.topology.id, source: draft.topology.source, ...(draft.topology.catalogSource === undefined ? {} : { catalog_source: draft.topology.catalogSource }) },
    human_participation: draft.humanParticipationPolicy,
  };
}

function frozenCharterOutput(frozen: FrozenCharterRevision) {
  return {
    frozen_ref: frozen.frozenRef,
    charter_revision: frozen.charterRevision,
    draft_id: frozen.draftId,
    draft_revision: frozen.draftRevision,
    digest: frozen.digest,
    approval_ref: frozen.approval.approvalRef,
    mission: frozen.mission,
    topology: { id: frozen.topology.id, source: frozen.topology.source, ...(frozen.topology.catalogSource === undefined ? {} : { catalog_source: frozen.topology.catalogSource }) },
    human_participation: frozen.humanParticipationPolicy,
    frozen_by_session_id: frozen.frozenBySessionId,
    frozen_at: frozen.frozenAt,
    ...(frozen.reason === undefined ? {} : { reason: frozen.reason }),
    ...(frozen.impact === undefined ? {} : { impact: frozen.impact }),
  };
}

function charterListOutput(events: readonly unknown[], draftId?: string) {
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") {
    return { status: "blocked", drafts: [], approvals: [], freezes: [], diagnostic: folded.diagnostic };
  }
  const drafts = draftId === undefined ? folded.drafts : folded.drafts.filter((draft) => draft.draftId === draftId);
  const approvals = draftId === undefined ? folded.approvals : folded.approvals.filter((approval) => approval.draftId === draftId);
  const freezes = draftId === undefined ? folded.freezes : folded.freezes.filter((freeze) => freeze.draftId === draftId);
  return { status: "ready", drafts, approvals, freezes };
}

function currentFrozenCharter(team: TeamState): FrozenCharterRevision {
  const document = documentReadForTeam(team);
  if (document === undefined || document.currentCharterRevision === null) throw new Error("Team has no frozen charter revision");
  const frozen = document.charterRevisions.find((revision) => revision.charterRevision === document.currentCharterRevision);
  if (frozen === undefined) throw new Error("Team current charter revision is missing");
  return frozen;
}

function currentClosureDefinition(team: TeamState): TopologyClosureDefinition {
  const frozen = currentFrozenCharter(team);
  const protocol = frozen.topology.config.protocol;
  if (protocol?.closure !== undefined) return protocol.closure;
  const completion = protocol?.completion;
  if (completion === undefined) throw new Error("Frozen Charter has no structured closure definition or legacy completion owner");
  return { owner: completion.owner, openGatePolicy: "reject", allowedOutcomes: ["completed", "failed", "abandoned"] };
}

function currentGraphRuntime(team: TeamState): { runtime: GraphRuntimeState; stale: boolean } {
  const frozen = currentFrozenCharter(team);
  if (team.graphRuntime === undefined) throw new Error("legacy_missing: Team has no graph runtime; run orchestra_graph_reconcile first");
  const read = readGraphRuntime(team.graphRuntime, team.teamId, frozen.charterRevision, frozen.digest);
  if (read.kind === "blocked") throw new Error(`graph runtime is blocked (${read.diagnostic.code}): ${read.diagnostic.message}`);
  if (read.kind === "legacy_missing") throw new Error("legacy_missing: Team has no graph runtime; run orchestra_graph_reconcile first");
  return { runtime: read.runtime, stale: read.kind === "stale" };
}

/**
 * Record every deadline and budget that has already passed, on the read path.
 *
 * The design chose this over a background timer for three reasons: no lifecycle
 * is introduced that could outlive the plugin, the facts are recomputable from
 * the log and a clock so they can be audited offline, and the driver stays the
 * only party that advances the run. Every graph-reading tool calls it, so a
 * driver that merely looks at the team also learns that an Attempt ran out of
 * time, instead of waiting for a verdict that will never arrive.
 *
 * The caller's pre-sweep read is renamed to `initial`: the returned snapshot is
 * the one to work from, and it is also the correct CAS base for the caller's own
 * write. Reusing the pre-sweep snapshot would lose the race against the write
 * this function just made.
 *
 * Nothing is swept when the Team has no graph runtime, no frozen charter, or a
 * runtime bound to an older charter: those states have their own loud failures,
 * and quietly expiring attempts inside them would hide the real problem.
 *
 * @param ctx - host context, for the escrow policy the write needs.
 * @param activeTeamState - the Team CAS store.
 * @param initial - the caller's own pre-sweep read.
 * @param exec - the calling tool execution, which owns the write policy.
 * @param now - observation time; defaults to the wall clock.
 * @returns the snapshot to use from here on, refreshed only if facts were written.
 */
async function sweepTeamBoundedRun(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  initial: ActiveTeamReady,
  exec: ToolExecutionInput,
  now: number = Date.now(),
): Promise<ActiveTeamReady> {
  const team = initial.team;
  if (team.graphRuntime === undefined) return initial;
  const frozen = frozenCharterOf(team);
  if (frozen === undefined) return initial;
  const read = readGraphRuntime(team.graphRuntime, team.teamId, frozen.charterRevision, frozen.digest);
  if (read.kind !== "ready") return initial;
  const contracts = frozen.contracts;
  let command: GraphCommandResult;
  try {
    command = sweepBoundedRun(read.runtime, team, contracts, now);
  } catch (error) {
    throw graphCommandError("sweep bounded-run deadlines", error);
  }
  if (command.kind === "noop") return initial;
  return persistGraphTransition(ctx, activeTeamState, initial, command.runtime, exec);
}

async function persistGraphTransition(ctx: Context, activeTeamState: ActiveTeamStateStore, snapshot: ActiveTeamReady, runtime: GraphRuntimeState, exec: ToolExecutionInput, status?: TeamState["status"]): Promise<ActiveTeamReady> {
  const written = await activeTeamState.replace(snapshot, { ...snapshot.team, ...(status === undefined ? {} : { status }), graphRuntime: runtime }, { policy: escrowPolicy(ctx, exec), signal: exec.signal });
  return readySnapshotAfterWrite(activeTeamState, snapshot.cwd, written, exec.signal);
}

/**
 * Add the wall-clock reading of each Loop's open Attempt to its row.
 *
 * `currentDeadlineAt` alone forces every reader to do the subtraction against
 * its own clock, and a reader that forgets reports a deadline without saying
 * whether it has already passed. `msRemaining` and `expired` are derived here,
 * from ONE observation time, so every row in one answer agrees with every other
 * — and `expired` distinguishes "the deadline passed and the sweep has not run
 * yet" from "there is no open Attempt", which is the difference a controller
 * needs to decide whether to sweep or to wait.
 *
 * @param loops - the runtime's Loop summaries.
 * @param now - the single observation time for this answer.
 * @returns the same rows with timing fields on Loops that have an open Attempt.
 */
export function loopsWithAttemptTiming(loops: readonly LoopSummary[], now: number): LoopSummary[] {
  return loops.map((loop) => {
    const deadlineAt = loop.currentDeadlineAt;
    if (deadlineAt === undefined) return loop;
    return { ...loop, currentDeadlineMsRemaining: Math.max(deadlineAt - now, 0), currentDeadlineExpired: now >= deadlineAt } as LoopSummary;
  });
}

function graphToolOutput(team: TeamState, runtime: GraphRuntimeState, stale = false) {
  const summary = graphSummary(runtime, stale);
  return {
    status: summary.status,
    team_id: team.teamId,
    charter_revision: runtime.charterRevision,
    charter_digest: runtime.charterDigest,
    runtime_revision: runtime.runtimeRevision,
    stale: summary.stale,
    current_loop: summary.currentLoop,
    loops: loopsWithAttemptTiming(graphLoops(runtime), Date.now()),
    pending_handoffs: summary.pendingHandoffs,
    cap_exhausted: summary.capExhausted,
    expired_attempts: summary.expiredAttempts,
    budgets: summary.budgets,
    team_budget_exhausted: summary.teamBudgetExhausted,
    open_gates: summary.openGates,
    blocked_scopes: summary.blockedScopes,
    closure: summary.closure,
  };
}

function graphCommandError(action: string, error: unknown): Error {
  if (error instanceof GraphRuntimeError) return new Error(`cannot ${action}: ${error.code}: ${error.message}`);
  return new Error(`cannot ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

interface GovernedProvisionResult {
  team: TeamState;
  snapshot: ActiveTeamReady;
  handles: AgentHandle[];
}

export interface GovernedProvisionDependencies {
  createSession?: typeof createSession;
  sendRoleWelcome?: (ctx: Context, fromSessionId: string, toSessionId: string, roleName: string, extra?: string, protocol?: Parameters<typeof roleProtocolText>[2]) => Promise<TeamWelcomeReceipt>;
  /** Subagent-backend creation seam; tests replace it to run the branch without a native registry. */
  createSubagentNode?: typeof createSubagentNode;
  /**
   * Subagent-backend release seam used by the rollback path. Releasing a child
   * drops its live activation while its Session log stays durable, which is the
   * native analogue of disposing a created Session handle.
   */
  releaseSubagentNode?: (ctx: Context, parent: Agent, childId: string) => Promise<void>;
}

/**
 * Release one native child that a failed provisioning transaction had already
 * materialized. Best-effort for the same reason `disposeCreatedHandles` is: the
 * durable failed state is the source of truth, and a secondary cleanup error
 * must not replace the original failure.
 */
async function releaseSubagentNodeDefault(ctx: Context, parent: Agent, childId: string): Promise<void> {
  const subagents = ctx.get("subagents");
  if (subagents === undefined) return;
  try {
    await subagents.drainContinuableChildren(parent, [SID(childId)]);
  } catch {
    // See disposeCreatedHandles: the recorded failure outranks a cleanup error.
  }
}

/** Reserve-first role provisioning transaction shared by create and spawn. */
export async function provisionGovernedPlans(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  exec: ToolExecutionInput,
  cwd: string,
  initialSnapshot: ActiveTeamReady,
  plans: GovernedRolePlan[],
  finalStatus: "active" | "degraded",
  failureStatus: "failed" | "degraded",
  dependencies: GovernedProvisionDependencies = {},
): Promise<GovernedProvisionResult> {
  let snapshot = initialSnapshot;
  let team = snapshot.team;
  let snapshotUsable = true;
  let failedRoleId: string | undefined;
  const handles: AgentHandle[] = [];
  /** Native children this transaction materialized, released if a later step fails. */
  const subagentChildren: { parent: Agent; childId: string }[] = [];
  const createRoleSession = dependencies.createSession ?? createSession;
  const deliverRoleWelcome = dependencies.sendRoleWelcome ?? sendRoleWelcome;
  const createRoleSubagent = dependencies.createSubagentNode ?? createSubagentNode;
  const releaseRoleSubagent = dependencies.releaseSubagentNode ?? releaseSubagentNodeDefault;
  const writeOptions = { policy: escrowPolicy(ctx, exec), signal: exec.signal };
  try {
    for (const plan of plans) {
      failedRoleId = plan.roleId;
      const provisioningTeam = updateTeamRole(team, plan.roleId, { phase: "provisioning", diagnostic: undefined });
      let written;
      try {
        written = await activeTeamState.replace(snapshot, provisioningTeam, writeOptions);
      } catch (error) {
        snapshotUsable = false;
        throw error;
      }
      snapshot = await readySnapshotAfterWrite(activeTeamState, cwd, written, exec.signal);
      team = snapshot.team;

      if (plan.execution === "subagent") {
        const controller = exec.agent;
        if (controller === undefined) {
          throw new Error(
            `governed role "${plan.roleId}" runs on the "subagent" backend and requires a live controller agent: a native child's direct-parent edge is what authorizes every later delivery, so an agentless caller cannot create one`,
          );
        }
        if (plan.parentSessionId !== undefined && plan.parentSessionId !== controller.id) {
          throw new Error(
            `governed role "${plan.roleId}" was reserved under controller ${plan.parentSessionId} but is being provisioned by ${controller.id}: a native child can only be created by the parent that will address it`,
          );
        }
        const receipt = await createRoleSubagent(
          ctx,
          controller,
          {
            label: plan.roleName,
            // The opening prompt IS the welcome: `startContinuable` establishes
            // the child and delivers this prompt in one durable step, so a
            // separate follow-up would only duplicate the protocol text.
            prompt: roleWelcomeText(controller.id, plan.roleName, plan.welcome, welcomeProtocol(plan)),
            childId: plan.sessionId,
            ...(plan.agentOptions === undefined ? {} : { agentOptions: plan.agentOptions }),
            ...(plan.toolFilter === undefined ? {} : { toolFilter: plan.toolFilter }),
            ...(plan.persona === undefined ? {} : { persona: plan.persona }),
          },
          exec.signal,
        );
        if (receipt.childId !== plan.sessionId) {
          throw new Error(
            `governed role "${plan.roleId}" reserved child id ${plan.sessionId} but provider "${receipt.provider}" materialized ${receipt.childId}: the reserved identity is what team.json records, so a mismatch cannot be reconciled`,
          );
        }
        subagentChildren.push({ parent: controller, childId: receipt.childId });
        const activeSubagentTeam = updateTeamRole(team, plan.roleId, {
          phase: "active",
          diagnostic: undefined,
          welcome: { messageId: receipt.messageId, sessionId: receipt.childId, acceptedAt: Date.now() },
        });
        try {
          written = await activeTeamState.replace(snapshot, activeSubagentTeam, writeOptions);
        } catch (error) {
          snapshotUsable = false;
          throw error;
        }
        snapshot = await readySnapshotAfterWrite(activeTeamState, cwd, written, exec.signal);
        team = snapshot.team;
        continue;
      }

      const created = await createRoleSession(ctx, {
        mode: "governed",
        sessionId: plan.sessionId,
        cwd,
        governedBlueprint: plan.blueprint,
        currentSessionId: exec.agent?.id,
        returnHandle: true,
        signal: exec.signal,
      });
      if (created.handle !== undefined) handles.push(created.handle);
      const welcome = await deliverRoleWelcome(
        ctx,
        exec.agent?.id ?? team.controllerSessionId,
        created.sessionId,
        plan.roleName,
        plan.welcome,
        welcomeProtocol(plan),
      );
      const blueprint = plan.blueprint;
      if (blueprint === undefined) {
        throw new Error(`governed role "${plan.roleId}" runs on the "session" backend without a Blueprint receipt: Session provisioning cannot proceed`);
      }
      const activeRoleTeam = updateTeamRole(team, plan.roleId, {
        phase: "active",
        diagnostic: undefined,
        welcome,
        blueprint: roleBlueprintFacts(blueprint.receipt),
      });
      try {
        written = await activeTeamState.replace(snapshot, activeRoleTeam, writeOptions);
      } catch (error) {
        snapshotUsable = false;
        throw error;
      }
      snapshot = await readySnapshotAfterWrite(activeTeamState, cwd, written, exec.signal);
      team = snapshot.team;
    }

    failedRoleId = undefined;
    const completedTeam: TeamState = { ...team, status: finalStatus };
    let written;
    try {
      written = await activeTeamState.replace(snapshot, completedTeam, writeOptions);
    } catch (error) {
      snapshotUsable = false;
      throw error;
    }
    snapshot = await readySnapshotAfterWrite(activeTeamState, cwd, written, exec.signal);
    return { team: snapshot.team, snapshot, handles };
  } catch (error) {
    await disposeCreatedHandles(handles);
    // A native child owns no AgentHandle — the continuation manager holds it —
    // so the transactional release is the selected Activation, not a dispose.
    // The child's Session log stays durable; only the live orphan goes away.
    for (const child of subagentChildren.reverse()) {
      await releaseRoleSubagent(ctx, child.parent, child.childId);
    }
    if (!snapshotUsable) {
      throw new Error(`governed provisioning stopped after stale state CAS: ${error instanceof Error ? error.message : String(error)}`);
    }
    const diagnostic = provisioningDiagnostic(error);
    const failedTeam = {
      ...updateTeamRole(team, failedRoleId ?? "", failedRoleId === undefined ? {} : { phase: "failed", diagnostic }),
      status: failureStatus,
    } satisfies TeamState;
    try {
      const written = await activeTeamState.replace(snapshot, failedTeam, writeOptions);
      snapshot = await readySnapshotAfterWrite(activeTeamState, cwd, written, exec.signal);
    } catch (stateError) {
      throw new Error(
        `governed provisioning failed (${diagnostic.code}) and failure state could not be recorded: ${stateError instanceof Error ? stateError.message : String(stateError)}`,
      );
    }
    throw error;
  }
}

export interface OrchestraCreateArgs {
  frozenRef?: string;
  goal?: string;
  topology?: string;
  scope?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  nonGoals?: string[];
  context?: string;
  permissionPreset?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Bounded entrypoint used by orchestra_create and its integration harness. */
export async function createGovernedTeam(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  topologyCatalog: TopologyCatalog,
  args: OrchestraCreateArgs,
  exec: ToolExecutionInput,
  dependencies: GovernedProvisionDependencies = {},
) {
  if (exec.agent === undefined) throw new Error("orchestra_create requires an agent caller");
  const cwd = exec.agent.session.header.cwd;
  if (cwd === undefined) throw new Error("current session has no working directory; cannot create a team");
  const existing = await activeTeamState.read(cwd, { signal: exec.signal });
  throwIfBlocked("create a team", existing);
  if (existing.kind === "ready") {
    throw new Error(
      `a team already exists here (team=${existing.team.teamId}, topology=${existing.team.topologyRef.id}); run orchestra_dismiss to close it, or use another working directory`,
    );
  }
  if (args.frozenRef === undefined || args.frozenRef === "") {
    throw new Error("approval_required: orchestra_create requires frozenRef produced upon draft approval; use orchestra_draft → the user's approval (a plain yes; /team approve also works)");
  }
  let events = await charterEventsOf(ctx, exec.agent.session);
  const folded = foldCharterEvents(events);
  let effectiveFrozenRef = args.frozenRef;
  if (folded.kind !== "blocked") {
    if (!folded.approvals.some((a) => a.approvalRef === effectiveFrozenRef) && !folded.freezes.some((f) => f.frozenRef === effectiveFrozenRef)) {
      const match = folded.approvals.find(
        (a) =>
          a.approvalRef === `draft-${effectiveFrozenRef}` ||
          a.draftId === effectiveFrozenRef ||
          a.draftId === `draft-${effectiveFrozenRef}` ||
          effectiveFrozenRef.startsWith(a.draftId) ||
          effectiveFrozenRef.startsWith(a.draftId.replace(/^draft-/, "")),
      );
      if (match !== undefined) {
        effectiveFrozenRef = match.approvalRef;
      }
    }
    const approval = folded.approvals.find((entry) => entry.approvalRef === effectiveFrozenRef);
    if (approval !== undefined && !folded.freezes.some((f) => f.frozenRef === effectiveFrozenRef)) {
      const draft = latestDraft(events, approval.draftId);
      if (draft !== undefined) {
        const freeze = prepareFreezeEvent(events, {
          draftId: draft.draftId,
          revision: draft.revision,
          digest: draft.digest,
          frozenBySessionId: exec.agent.id,
          frozenAt: Date.now(),
        });
        if (freeze.kind === "changed") {
          await appendDurableCharterEvent(ctx, exec.agent.session, freeze.event);
          events = await charterEventsOf(ctx, exec.agent.session);
        }
      }
    }
  }
  let frozen: FrozenCharterRevision;
  try {
    frozen = resolveFrozenCharter(events, effectiveFrozenRef);
  } catch (error) {
    throw charterCommandError("create a team", error);
  }
  if (frozen.baseTeamId !== undefined || frozen.sourceSessionId !== exec.agent.id || frozen.frozenBySessionId !== exec.agent.id) {
    throw new Error("cannot create a Team from an amendment or a charter frozen by another Session");
  }
  const topology = {
    config: frozen.topology.config,
    source: frozen.topology.catalogSource ?? ("bundled" as const),
  };
  void topologyCatalog;
  const teamId = `team-${randomUUID().slice(0, 8)}`;
  const plans: GovernedRolePlan[] = [];
  for (const role of topology.config.roles) {
    plans.push(
      await prepareGovernedRolePlan(ctx, {
        cwd,
        teamId,
        controllerSessionId: exec.agent.id,
        topologyId: topology.config.id,
        topologySource: topology.source,
        role,
        sandbox: role.sandbox,
        welcome: role.welcome,
        protocol: topology.config.protocol,
        maxRounds: role.maxRounds,
        permissionPreset: args.permissionPreset,
        provider: args.provider,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        title: roleSessionTitle({ roleId: role.id, missionObjective: frozen.mission.objective, cwd }),
        signal: exec.signal,
      }),
    );
  }
  assertUniqueGovernedSessionIds(plans);
  const team: TeamState = {
    schemaVersion: 1,
    teamId,
    status: "provisioning",
    rootCwd: cwd,
    controllerSessionId: exec.agent.id,
    controllerHistory: [],
    topologyRef: { id: topology.config.id, source: topology.source },
    mission: {
      ...frozen.mission,
    },
    createdAt: Date.now(),
    activatedFromArchiveId: null,
    roles: plans.map(reservedRole),
    reports: [],
  };
  team.graphRuntime = initializeGraphRuntime(teamId, frozen.charterRevision, frozen.digest, team.createdAt);
  team.document = initializeFrozenOrchestrationDocument(team, frozen, team.createdAt);
  const reservation = await activeTeamState.create(cwd, team, {
    policy: escrowPolicy(ctx, exec),
    signal: exec.signal,
  });
  const initialSnapshot = await readySnapshotAfterWrite(activeTeamState, cwd, reservation, exec.signal);
  const provisioned = await provisionGovernedPlans(ctx, activeTeamState, exec, cwd, initialSnapshot, plans, "active", "failed", dependencies);
  return {
    team_id: provisioned.team.teamId,
    status: provisioned.team.status,
    topology: provisioned.team.topologyRef.id,
    state_path: reservation.statePath,
    created_at: provisioned.team.createdAt,
    mission: provisioned.team.mission,
    charter_revision: frozen.charterRevision,
    frozen_ref: frozen.frozenRef,
    roles: provisioned.team.roles.map((role) => ({
      id: role.id,
      sessionId: role.sessionId,
      live: ctx.agents.get(SID(role.sessionId)) !== undefined,
      phase: role.phase,
    })),
  };
}

export interface OrchestraDispatchArgs {
  roleId: string;
  task: string;
  laneId?: string;
  preset?: string;
  timeoutMs?: number;
}

export interface OrchestraDispatchResult {
  status: string;
  team_id: string;
  role_id: string;
  session_id: string;
  created_new_session: boolean;
  receipt?: unknown;
}

export async function dispatchRoleTask(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  exec: ToolExecutionInput,
  args: OrchestraDispatchArgs,
): Promise<OrchestraDispatchResult> {
  if (exec.agent === undefined) throw new Error("orchestra_dispatch requires an agent caller");
  const cwd = exec.agent.session.header.cwd;
  if (cwd === undefined) throw new Error("current session has no working directory; cannot dispatch task");
  if (typeof args.roleId !== "string" || args.roleId.trim() === "") {
    throw new Error('orchestra_dispatch: "roleId" must be a non-empty string');
  }
  if (typeof args.task !== "string" || args.task.trim() === "") {
    throw new Error('orchestra_dispatch: "task" must be a non-empty string');
  }

  const roleId = args.roleId.trim();
  const laneId = args.laneId?.trim() || "main";

  const observation = await activeTeamState.read(cwd, { signal: exec.signal });
  throwIfBlocked("dispatch a task", observation);

  let team: TeamState;
  let isNewTeam = false;

  if (observation.kind === "ready") {
    team = observation.team;
  } else {
    isNewTeam = true;
    const teamId = `team-${randomUUID().slice(0, 8)}`;
    team = {
      schemaVersion: 1,
      teamId,
      topologyRef: { id: "lane-orchestra", source: "bundled" },
      rootCwd: cwd,
      controllerSessionId: exec.agent.id,
      status: "active",
      createdAt: Date.now(),
      mission: {
        objective: args.task.slice(0, 140),
        scope: [],
        constraints: [],
        acceptanceCriteria: [],
        nonGoals: [],
        context: "",
      },
      controllerHistory: [],
      activatedFromArchiveId: null,
      reports: [],
      roles: [],
    };
  }

  let roleEntry = team.roles.find((r) => r.id.toLowerCase() === roleId.toLowerCase());
  let createdRole = false;
  let sessionId: string;

  if (roleEntry !== undefined && typeof roleEntry.sessionId === "string" && roleEntry.sessionId !== "") {
    sessionId = roleEntry.sessionId;
  } else {
    createdRole = true;
    const presetId = args.preset ?? `orchestra-v04-${roleId}-v1`;
    let effectivePreset = presetId;
    try {
      await resolveRolePresetFile(ctx, cwd, presetId, orchestraGlobalRoot());
    } catch {
      effectivePreset = "orchestra-v04-worker-v1";
    }

    const title = roleSessionTitle({ roleId, missionObjective: team.mission.objective, cwd });
    const created = await createSession(ctx, {
      cwd,
      agentPresetId: effectivePreset,
      title,
      signal: exec.signal,
    });
    sessionId = created.sessionId;
    roleEntry = {
      id: roleId,
      name: roleId,
      sessionId,
      execution: "session",
      phase: "active",
      sessionHistory: [],
      preset: effectivePreset,
      sandbox: "read-write",
      reportCount: 0,
      lastReport: null,
    };
    team.roles.push(roleEntry);
  }

  const policy = escrowPolicy(ctx, exec);
  if (isNewTeam) {
    await activeTeamState.create(cwd, team, { policy, signal: exec.signal });
  } else {
    await activeTeamState.replace(observation as ActiveTeamReady, team, { policy, signal: exec.signal });
  }

  const dispatchPayload =
    `[Orchestra Dispatch | Lane: ${laneId} | Role: ${roleId}]\n\n` +
    `Task:\n${args.task}\n\n` +
    `---\n` +
    `Frontline Autonomy Rule: execute independently and coordinate Hard Facts directly with collaborators. ` +
    `File progress or completion with orchestra_report when ready.`;

  const delivery = await deliverMessage(
    ctx,
    exec.agent.id,
    sessionId,
    [{ type: "text", text: dispatchPayload }],
    {
      wake: true,
      ...transportStores(ctx, cwd),
    },
  );

  return {
    status: "dispatched",
    team_id: team.teamId,
    role_id: roleId,
    session_id: sessionId,
    created_new_session: createdRole,
    receipt: delivery,
  };
}

export interface ActivateRoleResult {
  role_id: string;
  sessionId: string;
  action: string;
  replacedSessionId?: string;
}

export interface ActivateArchivedTeamResult {
  teamId: string;
  archiveId: string;
  status: string;
  roles: ActivateRoleResult[];
}

export interface ActivateResumeOptions {
  resumeSessionId: SessionId;
  agentOptions?: Record<string, unknown>;
  setup?: (agentCtx: Context) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Dependency seams for orchestra_activate so its recovery branches are testable
 * without a real Agent registry (mirrors GovernedProvisionDependencies).
 */
export interface ActivateDependencies {
  createSession?: typeof createSession;
  resumeAgent?: (ctx: Context, options: ActivateResumeOptions) => Promise<unknown>;
  sendRoleWelcome?: (ctx: Context, fromSessionId: string, toSessionId: string, roleName: string, extra?: string, protocol?: Parameters<typeof roleProtocolText>[2]) => Promise<TeamWelcomeReceipt>;
}

/**
 * Reactivate a dismissed (archived) team. Per role: live sessions are reused,
 * persisted sessions are resumed, authoritatively missing sessions are replaced
 * (sessionHistory + replacement reason + Recovery Packet), and other resume
 * errors fail that role without replacement (team enters degraded). The caller
 * becomes the new controller when it differs from the archived one (controller
 * takeover, recorded in controllerHistory). The archive stays immutable.
 *
 * CP7 hardening: the archived document and graph runtime are validated before
 * an active team is published — a blocked/stale runtime fails activation loudly
 * instead of pretending the team is active.
 */
export async function activateArchivedTeam(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  archiveStore: ArchiveStore,
  args: { archiveId: string },
  exec: ToolExecutionInput,
  dependencies: ActivateDependencies = {},
): Promise<ActivateArchivedTeamResult> {
  if (exec.agent === undefined) throw new Error("orchestra_activate requires an agent caller");
  const cwd = exec.agent.session.header.cwd;
  if (cwd === undefined) throw new Error("current session has no working directory");
  const existing = await activeTeamState.read(cwd, { signal: exec.signal });
  throwIfBlocked("activate a team", existing);
  if (existing.kind === "ready")
    throw new Error(`an active team already exists here (${existing.team.teamId}); dismiss it first or activate in another working directory`);
  const loaded = await archiveStore.read(cwd, args.archiveId, { signal: exec.signal });
  if (loaded.kind === "blocked") {
    throw new Error(
      `archive "${args.archiveId}" is blocked (${loaded.diagnostic.code}): ${loaded.diagnostic.message}; repair or remove the archive before activation`,
    );
  }
  if (loaded.kind === "missing") {
    const available = (await archiveStore.list(cwd, { signal: exec.signal })).ready.map((a) => a.archiveId);
    throw new Error(
      `archive "${args.archiveId}" not found at ${cwd}/orchestra/archive/; available: ${available.length === 0 ? "(none)" : available.join(", ")}`,
    );
  }
  const archived = loaded.snapshot;
  // Rebuild the active state from the archive snapshot (archive stays immutable).
  const query = ctx.get("sessionQuery");
  const newTeam: TeamState = {
    ...archived,
    status: "active",
    activatedFromArchiveId: archived.archiveId,
    roles: archived.roles.map((role) => ({ ...role, sessionHistory: [...(role.sessionHistory ?? [])] })),
  };
  // Controller takeover: the caller of activate becomes the controller when different.
  if (newTeam.controllerSessionId !== exec.agent.id) {
    newTeam.controllerHistory = [
      ...newTeam.controllerHistory,
      { sessionId: newTeam.controllerSessionId, replacedAt: Date.now(), reason: "controller-takeover" },
    ];
    newTeam.controllerSessionId = exec.agent.id;
  }
  // Fail loud instead of pretending active: validate the archived document and
  // graph runtime before publishing the active team.
  if (newTeam.document !== undefined) {
    const documentRead = readOrchestrationDocument(newTeam.document, newTeam.teamId);
    if (documentRead.kind === "blocked") {
      throw new Error(`cannot activate: archived team document is blocked (${documentRead.diagnostic.code}): ${documentRead.diagnostic.message}`);
    }
    if (documentRead.kind === "ready") newTeam.document = documentRead.document;
  }
  if (newTeam.graphRuntime !== undefined) {
    const current = (() => {
      if (newTeam.document === undefined || newTeam.document.currentCharterRevision === null || newTeam.document.currentCharterRevision === undefined) return undefined;
      return newTeam.document.charterRevisions.find((revision) => revision.charterRevision === newTeam.document?.currentCharterRevision);
    })();
    const graphRead = readGraphRuntime(newTeam.graphRuntime, newTeam.teamId, current?.charterRevision, current?.digest);
    if (graphRead.kind === "blocked") {
      throw new Error(`cannot activate: archived graph runtime is blocked (${graphRead.diagnostic.code}): ${graphRead.diagnostic.message}`);
    }
    if (graphRead.kind === "stale") {
      throw new Error("cannot activate: archived graph runtime is bound to an older Frozen Charter; no history was migrated");
    }
    if (graphRead.kind === "ready") newTeam.graphRuntime = graphRead.runtime;
  }
  const results: ActivateRoleResult[] = [];
  let degraded = false;
  const activationNotice = "The team has been reactivated. You remain under your role discipline: stop/continue as instructed — wait for driver dispatch before starting new work.";
  const createRoleSession = dependencies.createSession ?? createSession;
  const deliverRoleWelcome = dependencies.sendRoleWelcome ?? sendRoleWelcome;
  const resumeRoleSession = dependencies.resumeAgent ?? (async (agentCtx: Context, options: ActivateResumeOptions): Promise<void> => {
    await agentCtx.agents.resume({
      resumeSessionId: options.resumeSessionId,
      ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options.setup === undefined ? {} : { setup: options.setup }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    } as never);
  });
  for (const role of newTeam.roles) {
    const agent = ctx.agents.get(SID(role.sessionId));
    if (agent !== undefined) {
      // Step 5a: live → reused
      await deliverRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, activationNotice);
      results.push({ role_id: role.id, sessionId: role.sessionId, action: "reused" });
      continue;
    }
    // Step 5b/5c/5d: probe persistence to distinguish "missing" from "temporarily failing".
    let snapshot: unknown = undefined;
    if (query !== undefined) {
      try {
        snapshot = await query.readSession(SID(role.sessionId));
      } catch (error) {
        const code = (error as any)?.code;
        if (code === "SESSION_QUERY_SESSION_NOT_FOUND") snapshot = "not-found";
        else if (code === "SESSION_QUERY_CORRUPT_SESSION") snapshot = "corrupt";
        else snapshot = "query-error";
      }
    } else {
      snapshot = "no-query";
    }
    if (snapshot === "not-found" || snapshot === "no-query") {
      // Step 5c: authoritatively missing → create a replacement session.
      try {
        if (role.execution === "subagent") {
          // Re-creating the missing child as a Session would silently change the
          // role's backend and drop its direct-parent address: the replacement
          // would no longer be deliverable through the native edge team.json
          // records. Re-establishing a native child is not implemented, so this
          // role fails loudly and the team degrades for a human to re-provision.
          throw new Error(
            `role ${role.id} runs on the "subagent" backend and its child session ${role.sessionId} is missing; replacing it with a Session would silently change the role's backend, and re-establishing a native child is not implemented — re-provision this role instead`,
          );
        }
        const presetFile =
          role.preset === null ? undefined : await resolvePresetFile(ctx, cwd, role.preset);
        const roleModel = role.model;
        const created = await createRoleSession(ctx, {
          cwd,
          ...(presetFile === undefined ? {} : { presetFile }),
          ...(roleModel === undefined || roleModel.provider === undefined || roleModel.model === undefined
            ? {}
            : { provider: roleModel.provider, model: roleModel.model, reasoningEffort: roleModel.reasoningEffort }),
          currentSessionId: exec.agent.id,
          title: roleSessionTitle({ roleId: role.id, missionObjective: newTeam.mission.objective, cwd }),
          signal: exec.signal,
        });
        if (role.sandbox === "read-only") {
          const session = ctx.sessions.get(SID(created.sessionId));
          if (session !== undefined) session.append("sandbox/mode", { mode: "read-only" });
        }
        const oldSessionId = role.sessionId;
        role.sessionId = created.sessionId;
        role.sessionHistory = [
          ...role.sessionHistory,
          { sessionId: oldSessionId, replacedAt: Date.now(), reason: "session-not-found" },
        ];
        // Recovery Packet (spec §8.4).
        const recoveryPacket = [
          `Your previous session (${oldSessionId}) no longer exists, so you were re-created as a replacement.`,
          `team_id: ${newTeam.teamId}`,
          `role_id: ${role.id}`,
          `role_name: ${role.name}`,
          `mission: ${newTeam.mission.objective}`,
          `topology_id: ${newTeam.topologyRef.id}`,
          `current driver session id: ${exec.agent.id}`,
          `replaced session id: ${oldSessionId}`,
          `existing report paths: ${newTeam.reports.filter((r) => r.roleId === role.id).map((r) => r.path).join(", ") || "(none)"}`,
          `known state: ${newTeam.status} (reactivated from archive ${newTeam.activatedFromArchiveId ?? "(none)"})`,
          `IMPORTANT: your old conversation history was NOT inherited.`,
          "The team has been reactivated. Wait for driver dispatch before starting new work.",
        ].join("\n");
        await deliverRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, recoveryPacket);
        results.push({ role_id: role.id, sessionId: created.sessionId, action: "replaced", replacedSessionId: oldSessionId });
      } catch (error) {
        degraded = true;
        results.push({
          role_id: role.id,
          sessionId: role.sessionId,
          action: "failed",
        });
        console.error(
          `orchestra_activate: replacement for role ${role.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    // Step 5b/5d: snapshot readable → try to resume; other errors → failed.
    try {
      const presetFile = role.preset === null ? undefined : await resolvePresetFile(ctx, cwd, role.preset);
      const roleModel = role.model;
      let setup: ((agentCtx: Context) => Promise<void>) | undefined;
      if (presetFile !== undefined) {
        setup = async (agentCtx) => {
          await mountPreset(agentCtx, { id: presetFile.id, trust: presetFile.trust, path: presetFile.path });
          installModelOverride(agentCtx, true, roleModel?.provider, roleModel?.model, roleModel?.reasoningEffort);
        };
      } else if (roleModel !== undefined) {
        setup = (agentCtx) => {
          installModelOverride(agentCtx, true, roleModel.provider, roleModel.model, roleModel.reasoningEffort);
          return Promise.resolve();
        };
      }
      const override =
        role.model !== undefined &&
        (role.model.provider !== undefined || role.model.model !== undefined || role.model.reasoningEffort !== undefined)
          ? role.model
          : undefined;
      const modelSvc = ctx.get("agentDefaultModel");
      const selection = modelSvc === undefined ? undefined : modelSvc.currentSelection();
      const agentOptions =
        override === undefined
          ? selection === undefined
            ? {}
            : { provider: selection.provider, model: selection.model }
          : {
              ...(override.provider === undefined ? {} : { provider: override.provider }),
              ...(override.model === undefined ? {} : { model: override.model }),
            };
      await resumeRoleSession(ctx, {
        resumeSessionId: SID(role.sessionId),
        agentOptions,
        ...(setup === undefined ? {} : { setup }),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      });
      await deliverRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, activationNotice);
      results.push({ role_id: role.id, sessionId: role.sessionId, action: "resumed" });
    } catch (error) {
      degraded = true;
      results.push({
        role_id: role.id,
        sessionId: role.sessionId,
        action: "failed",
      });
      console.error(
        `orchestra_activate: resume for role ${role.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (degraded) newTeam.status = "degraded";
  await activeTeamState.create(cwd, newTeam, {
    policy: escrowPolicy(ctx, exec),
    signal: exec.signal,
  });
  return {
    teamId: newTeam.teamId,
    archiveId: archived.archiveId,
    status: newTeam.status,
    roles: results,
  };
}

export interface OrchestraSendArgs {
  teamId: string;
  roleId: string;
  message: string;
  wake?: boolean;
  interrupt?: boolean;
  idempotencyKey?: string;
}

/** Governed role-addressed send entrypoint; raw Transport remains shared. */
export async function sendGovernedRole(
  ctx: Context,
  addressResolver: GovernedRoleAddressResolver,
  args: OrchestraSendArgs,
  exec: ToolExecutionInput,
) {
  if (exec.agent === undefined) throw new Error("orchestra_send requires an agent caller");
  const cwd = exec.agent.session.header.cwd;
  if (cwd === undefined) throw new Error("current session has no working directory");
  const address = await addressResolver.resolve(cwd, args.teamId, args.roleId, { signal: exec.signal });
  if (address.resolved_session_id === exec.agent.id) throw new Error("orchestra_send cannot target the caller's own Governed role");
  const blocks: ContentBlock[] = [
    { type: "text", text: `Governed dispatch from ${exec.agent.id} to ${address.team_id}/${address.role_id}:` },
    { type: "text", text: args.message },
  ];
  if (address.execution === "subagent") {
    return sendToGovernedSubagentNode(ctx, address, args, exec, blocks);
  }
  const receipt = await deliverMessage(ctx, exec.agent.id, address.resolved_session_id, blocks, {
    wake: args.wake,
    interrupt: args.interrupt === true,
    idempotencyKey: args.idempotencyKey,
    ...transportStores(ctx, exec.agent.session.header.cwd),
  });
  return { team_id: address.team_id, role_id: address.role_id, resolved_session_id: address.resolved_session_id, receipt };
}

/**
 * Deliver one dispatch to a `subagent` role.
 *
 * The native seam authorizes delivery by the direct-parent edge alone: only the
 * exact Agent that created the child can steer it, and there is no host path
 * that impersonates that Agent. So a caller that is not the recorded parent is
 * refused here with the reason, rather than handed a routing error later.
 *
 * Three raw-transport guarantees have no native counterpart, and each one is
 * refused instead of silently dropped — a caller must never believe it received
 * a guarantee that was never provided:
 *
 * - `wake: false` (park the message for a later turn without waking the target)
 *   — native delivery always steers: a running child admits at its next step
 *   boundary and an idle one starts a turn;
 * - `interrupt: true` — cancelling a child's current turn is a separate native
 *   operation this path does not perform;
 * - `idempotencyKey` — native delivery mints its own message id and has no
 *   caller-supplied dedup key.
 *
 * @param ctx - host context carrying the subagent registry.
 * @param address - the resolved role address; `parent_session_id` must equal the caller.
 * @param args - the original dispatch arguments.
 * @param exec - the calling tool execution (its Agent is the only legal sender).
 * @param blocks - already-composed dispatch content.
 * @returns the durable mapping plus an accepted-only receipt.
 */
async function sendToGovernedSubagentNode(
  ctx: Context,
  address: GovernedRoleAddress,
  args: OrchestraSendArgs,
  exec: ToolExecutionInput,
  blocks: ContentBlock[],
) {
  const sender = exec.agent;
  if (sender === undefined) throw new Error("orchestra_send requires an agent caller");
  if (address.parent_session_id !== sender.id) {
    throw new Error(
      `governed role ${address.team_id}/${address.role_id} is a native sub-agent node whose direct parent is ${address.parent_session_id ?? "not recorded in team state"}; only that exact parent may deliver, but the caller is ${sender.id} — native delivery is authorized by the direct-parent edge and cannot be delegated or impersonated`,
    );
  }
  if (args.wake === false) {
    throw new Error(
      `orchestra_send cannot honor wake=false for sub-agent role ${address.role_id}: native delivery always steers (a running child admits at its next step boundary, an idle one starts a turn), so parking a message without waking is not expressible`,
    );
  }
  if (args.interrupt === true) {
    throw new Error(
      `orchestra_send cannot honor interrupt=true for sub-agent role ${address.role_id}: the native delivery path does not cancel the target's current turn`,
    );
  }
  if (args.idempotencyKey !== undefined) {
    throw new Error(
      `orchestra_send cannot honor idempotencyKey for sub-agent role ${address.role_id}: native delivery mints its own message identity and offers no caller-supplied dedup key`,
    );
  }
  const delivered = await sendToSubagentNode(ctx, sender, address.resolved_session_id, blocks, { signal: exec.signal });
  return {
    team_id: address.team_id,
    role_id: address.role_id,
    resolved_session_id: address.resolved_session_id,
    receipt: {
      message_id: delivered.messageId,
      target_session_id: address.resolved_session_id,
      accepted_at_ms: Date.now(),
      // Not one of the raw transport's three modes: this is the native steer
      // path, reported as itself so a reader cannot mistake it for an inbox
      // splice or a cold-resume delivery.
      delivery_mode: "native_steer",
      state: "accepted" as const,
    },
  };
}

/**
 * One role's live status row.
 *
 * @param ctx - host context.
 * @param role - the durable role record.
 * @param health - derived Attempt/stall inputs, when the caller could supply
 *   them. Omitting it produces the row without stall information rather than a
 *   row that guesses: a reader must never see `ok` for a check nobody ran.
 */
async function roleStatus(ctx: Context, role: TeamRole, health?: TeamRoleHealth) {
  const agent = ctx.agents.get(SID(role.sessionId));
  const status: {
    id: string;
    name: string;
    sessionId: string;
    live: boolean;
    status: string;
    phase: TeamRolePhase;
    execution: TeamRoleExecution;
    parentSessionId?: string;
    reportCount: number;
    lastReport: string | null;
    diagnostic?: TeamRoleDiagnostic;
    lastActivityAt?: number;
    lastActivity?: string;
    stall?: NodeStall;
    attempt?: { loopInstanceId: string; loopId: string; attempt: number; startedAt: number; deadlineAt: number; msRemaining: number; expired: boolean };
  } = {
    id: role.id,
    name: role.name,
    sessionId: role.sessionId,
    live: agent !== undefined,
    status: agent === undefined ? "cold" : agent.status,
    phase: role.phase,
    execution: role.execution,
    // A subagent role's durable address is its direct-parent edge, so the
    // controller it hangs off is part of every status read.
    ...(role.parentSessionId === undefined ? {} : { parentSessionId: role.parentSessionId }),
    reportCount: role.reportCount ?? 0,
    lastReport: role.lastReport ?? null,
    ...(role.diagnostic === undefined ? {} : { diagnostic: role.diagnostic }),
  };
  const annotateHealth = (): void => {
    if (health === undefined) return;
    const derived = roleAttemptHealth(role, health, {
      working: nodeIsWorking(agent as { status?: string; inbox?: { nextTurn?: readonly unknown[]; nextStep?: readonly unknown[] } } | undefined),
      lastActivityAt: status.lastActivityAt,
    });
    status.stall = derived.stall;
    if (derived.attempt !== undefined) status.attempt = derived.attempt;
  };
  try {
    const query = ctx.get("sessionQuery");
    if (query === undefined) {
      annotateHealth();
      return status;
    }
    const snapshot = await query.readSession(SID(role.sessionId));
    for (let i = snapshot.events.length - 1; i >= 0; i--) {
      const event = snapshot.events[i];
      let text = "";
      if (event.type === "assistant/message") {
        text = textOf(event.data.message);
      } else if (event.type === "user/message") {
        const kind = event.data.source === undefined ? undefined : (event.data.source as any).kind;
        if (kind !== "a2a" && kind !== "user") continue;
        text = textOf(event.data);
      } else {
        continue;
      }
      if (text === "") continue;
      status.lastActivityAt = event.time;
      status.lastActivity = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      break;
    }
  } catch (error) {
    // read-only best effort: absence of activity detail must not fail the team view
  }
  annotateHealth();
  return status;
}

/** Extract concatenated text blocks from a dsh-llm message payload (mirror of a2a). */
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

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SECTION_NAME = "tool:orchestra";
const SECTION_ORDER = 119;

export const Config = undefined;

export function apply(ctx: Context): void {
  // One change bus per plugin instance, owned by this fiber: unloading the
  // plugin releases every pending waiter instead of leaving a timer behind.
  const teamChange = createTeamChangeBus();
  ctx.effect(() => () => teamChange.dispose());
  // The store is constructed ONCE here, which makes this the single choke point
  // every committed Team write passes through — a future write path cannot
  // bypass the signal without bypassing the store itself.
  const activeTeamState = withChangeSignal(createActiveTeamStateStore(ctx.fs), teamChange);
  const archiveStore = createArchiveStore(ctx.fs);
  const topologyCatalog = createTopologyCatalog(ctx.fs);
  const governedAddress = createGovernedRoleAddressResolver(activeTeamState);
  const roleItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      name: { type: "string", required: true },
      sessionId: { type: "string", required: true },
      live: { type: "boolean", required: true },
      status: { type: "string", required: true },
      phase: { type: "string", required: true },
      execution: { type: "string", required: true },
      parentSessionId: { type: "string" },
      reportCount: { type: "number", required: true },
      lastReport: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      diagnostic: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string", required: true },
          message: { type: "string", required: true },
        },
      },
      lastActivityAt: { type: "number" },
      lastActivity: { type: "string" },
      stall: { type: "string" },
      attempt: {
        type: "object",
        additionalProperties: false,
        properties: {
          loopInstanceId: { type: "string", required: true },
          loopId: { type: "string", required: true },
          attempt: { type: "number", required: true },
          startedAt: { type: "number", required: true },
          deadlineAt: { type: "number", required: true },
          msRemaining: { type: "number", required: true },
          expired: { type: "boolean", required: true },
        },
      },
    },
  } as const;

  const graphOutputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", required: true },
      team_id: { type: "string", required: true },
      charter_revision: { type: "number", required: true },
      charter_digest: { type: "string", required: true },
      runtime_revision: { type: "number", required: true },
      stale: { type: "boolean", required: true },
      current_loop: { type: "object", additionalProperties: true },
      loops: { type: "array", items: { type: "json" }, required: true },
      pending_handoffs: { type: "array", items: { type: "json" }, required: true },
      cap_exhausted: { type: "array", items: { type: "string" }, required: true },
      expired_attempts: { type: "number", required: true },
      budgets: { type: "array", items: { type: "json" }, required: true },
      team_budget_exhausted: { type: "boolean", required: true },
      open_gates: { type: "array", items: { type: "json" }, required: true },
      blocked_scopes: { type: "array", items: { type: "string" }, required: true },
      closure: { type: "object", additionalProperties: true, required: true },
    },
  } as const;

  // Install-time artifact seeding (spec §5.3): write builtin presets/topologies
  // to the global root when absent; never overwrites user content.
  void ensureBuiltinArtifacts(topologyCatalog).catch((error) => {
    console.error(`orchestra: builtin artifact install failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  ctx.tools.register(
    defineTool({
      name: "orchestra_create",
      description:
        "Create a Governed orchestra team from an immutable frozenRef produced after the USER approved the draft. goal/topology alone are not approval and return approval_required. The user approves by replying with a plain yes (启动 / 可以 / ok); /team approve <draftId>@<revision> also works. The frozen mission/topology snapshot is used for role provisioning and recorded into team.json.",
      parameters: {
        frozenRef: { type: "string", required: true, description: "Exact frozen charter ref: draftId@revision#digest produced upon user approval." },
        goal: { type: "string", description: "Deprecated compatibility input; ignored without frozenRef and never substitutes approval." },
        topology: { type: "string", description: "Deprecated compatibility input; frozen topology snapshot is authoritative." },
        scope: { type: "array", items: { type: "string" }, description: "Optional mission scope boundaries." },
        constraints: { type: "array", items: { type: "string" }, description: "Optional mission constraints." },
        acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Optional acceptance criteria." },
        nonGoals: { type: "array", items: { type: "string" }, description: "Optional explicit non-goals." },
        context: { type: "string", description: "Optional project context." },
        permissionPreset: { type: "string", description: "Base Permission Preset applied to every governed role; defaults to the deployment default." },
        provider: { type: "string", description: "Model provider override applied to every role session. Must be paired with model." },
        model: { type: "string", description: "Model override applied to every role session. Must be paired with provider." },
        reasoningEffort: { type: "string", description: "Reasoning effort override applied to every role session (e.g. \"medium\"). Requires provider and model." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            team_id: { type: "string", required: true },
            topology: { type: "string", required: true },
            status: { type: "string", required: true },
            charter_revision: { type: "number", required: true },
            frozen_ref: { type: "string", required: true },
            state_path: { type: "string", required: true },
            created_at: { type: "number", required: true },
            mission: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                objective: { type: "string", required: true },
                scope: { type: "array", items: { type: "string" } },
                constraints: { type: "array", items: { type: "string" } },
                acceptanceCriteria: { type: "array", items: { type: "string" } },
                nonGoals: { type: "array", items: { type: "string" } },
                context: { type: "string" },
              },
            },
            roles: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  sessionId: { type: "string", required: true },
                  live: { type: "boolean", required: true },
                  phase: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `team ${value.team_id} (${value.topology}) created at ${value.state_path}: ${value.roles.map((r) => `${r.id}=${r.sessionId}${r.live ? "" : " (cold)"}`).join(", ")}`,
          },
        ],
      },
      async execute(
        args: OrchestraCreateArgs,
        exec: ToolExecutionInput,
      ) {
        return createGovernedTeam(ctx, activeTeamState, topologyCatalog, args, exec);
      },
    }),
  );


  ctx.tools.register(
    defineTool({
      name: "orchestra_send",
      description: "Send a message to a Governed role by stable teamId+roleId. Resolves the current active session mapping, then reuses raw A2A Transport; accepted does not mean claimed or answered.",
      parameters: {
        teamId: { type: "string", required: true, description: "Exact Governed Team id." },
        roleId: { type: "string", required: true, description: "Governed role id; case-insensitive lookup returns the canonical role id." },
        message: { type: "string", required: true, description: "Self-contained dispatch or handoff message." },
        wake: { type: "boolean", description: "Wake the role; defaults to true." },
        interrupt: { type: "boolean", description: "Best-effort steering interrupt; defaults to false." },
        idempotencyKey: { type: "string", description: "Optional retry key; repeated delivery to this role with the same key returns the original accepted receipt." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            team_id: { type: "string", required: true },
            role_id: { type: "string", required: true },
            resolved_session_id: { type: "string", required: true },
            receipt: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                message_id: { type: "string", required: true },
                target_session_id: { type: "string", required: true },
                accepted_at_ms: { type: "number", required: true },
                delivery_mode: { type: "string", required: true },
                state: { type: "string", required: true },
                interrupt: { type: "boolean" },
                reply_to_message_id: { type: "string" },
              },
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: `role ${value.team_id}/${value.role_id} resolved to ${value.resolved_session_id}; message ${value.receipt.message_id} ${value.receipt.state} (accepted only)` }],
      },
      async execute(args: OrchestraSendArgs, exec: ToolExecutionInput) {
        return sendGovernedRole(ctx, governedAddress, args, exec);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_draft",
      description:
        "Driver-only Charter Draft command. Creates revision 1 or appends a new revision using expectedRevision. The Draft is recorded in <cwd>/orchestra/charter/records.json (ADR-0002: plugin records live in files, never in Session events); it is not a Team or approval. For an active Team, only the current controller/semantic writer may create an amendment Draft.",
      parameters: {
        draftId: { type: "string", description: "Existing draft id to revise; omit to create a new draft." },
        expectedRevision: { type: "number", description: "Required when revising an existing draft; stale values fail loud." },
        goal: { type: "string", description: "Mission objective; required for a new draft." },
        topology: { type: "string", description: "Catalog topology id to snapshot; omitted on update reuses the latest snapshot." },
        inlineTopology: { type: "json", description: "Inline custom topology config; validated by the same Topology Catalog validator." },
        scope: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        nonGoals: { type: "array", items: { type: "string" } },
        context: { type: "string" },
        humanParticipationMode: { type: "string", enum: ["interactive", "checkpointed", "autonomous"] },
        onUnavailable: { type: "string", enum: ["block", "safe_stop", "continue_without_gate"] },
        humanPolicySummary: { type: "string" },
        requiredHumanGate: { type: "boolean" },
        reason: { type: "string" },
        summary: { type: "string" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            draft_id: { type: "string", required: true },
            revision: { type: "number", required: true },
            digest: { type: "string", required: true },
            approval_status: { type: "string", required: true },
            frozen_ref: { type: "string" },
            base_team_id: { type: "string" },
            base_charter_revision: { type: "number" },
            mission: { type: "object", additionalProperties: true, required: true },
            topology: { type: "object", additionalProperties: true, required: true },
            human_participation: { type: "object", additionalProperties: true, required: true },
            role_blueprint_preview: { type: "array", items: { type: "json" }, required: true },
          },
        },
        render: (_args, value) => {
          const preview = (value.role_blueprint_preview ?? []) as unknown as DraftRoleFacts[];
          const table = renderDraftBlueprintTable(preview);
          const summary = `charter draft ${value.draft_id}@${value.revision} (${value.approval_status}) digest=${value.digest}`;
          return [{ type: "text", text: `${table}\n${summary}` }];
        },
      },
      async execute(args: CharterDraftToolArgs, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_draft requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("create a charter draft", observation);
        const events = await charterEventsOf(ctx, exec.agent.session);
        let current: CharterDraft | undefined;
        if (args.draftId !== undefined) {
          try {
            current = latestDraft(events, args.draftId);
          } catch (error) {
            throw charterCommandError("read the charter draft", error);
          }
          if (current === undefined) throw new Error(`cannot create a charter draft: draft ${args.draftId} was not found`);
          if (current.authorSessionId !== exec.agent.id) throw new Error("cannot revise the charter draft: permission_denied (author Session required)");
        }
        let baseTeamId: string | undefined;
        let baseCharterRevision: number | undefined;
        if (observation.kind === "ready") {
          const team = observation.team;
          const document = documentReadForTeam(team);
          if (document === undefined) throw new Error("cannot create an amendment Draft: legacy_missing (this team has no orchestration document)");
          if (exec.agent.id !== team.controllerSessionId || exec.agent.id !== document.semanticWriterSessionId) {
            throw new Error("cannot create a charter amendment: permission_denied (current controller/semantic writer required)");
          }
          if (document.currentCharterRevision === null) throw new Error("cannot create an amendment Draft: the Team has no frozen charter revision");
          baseTeamId = team.teamId;
          baseCharterRevision = document.currentCharterRevision;
        }
        let topology;
        try {
          topology = await topologySnapshotForDraft(ctx, topologyCatalog, cwd, args, current, exec.signal);
        } catch (error) {
          throw charterCommandError("resolve the charter topology", error);
        }
        let roleBlueprintPreview: DraftRoleFacts[];
        try {
          roleBlueprintPreview = [];
          for (const role of topology.config.roles) {
            roleBlueprintPreview.push(await preparseDraftRoleFacts(ctx, cwd, role));
          }
        } catch (error) {
          throw new Error(`cannot create a charter draft: role blueprint pre-parsing failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        let command;
        try {
          command = prepareDraftEvent(events, {
            draftId: args.draftId,
            expectedRevision: args.expectedRevision,
            mission: missionForDraft(args, current),
            topology,
            humanParticipationPolicy: humanPolicyForDraft(args, current),
            authorSessionId: current?.authorSessionId ?? exec.agent.id,
            now: Date.now(),
            reason: args.reason ?? current?.reason,
            summary: args.summary ?? current?.summary,
            baseTeamId: baseTeamId ?? current?.baseTeamId,
            baseCharterRevision: baseCharterRevision ?? current?.baseCharterRevision,
          });
        } catch (error) {
          throw charterCommandError("create the charter draft", error);
        }
        if (command.kind !== "changed") throw new Error("charter draft command unexpectedly produced no event");
        await appendDurableCharterEvent(ctx, exec.agent.session, command.event);
        return { ...charterDraftOutput([...events, command.event], command.value), role_blueprint_preview: roleBlueprintPreview } as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_dispatch",
      description:
        "Dispatch a concrete task to a team role lane. If the role's Session does not exist yet, it is automatically created and recorded into .orchestra/ state. The task message is sent directly to the role session with wake=true, returning the delivery receipt.",
      parameters: {
        roleId: { type: "string", required: true, description: "Role identifier to dispatch to (e.g. 'implementer', 'reviewer')." },
        task: { type: "string", required: true, description: "Actionable, self-contained task description for this role lane." },
        laneId: { type: "string", description: "Optional lane identifier or phase name." },
        preset: { type: "string", description: "Optional agent preset name override when lazily creating this role." },
        timeoutMs: { type: "number", description: "Heartbeat timeout in ms (default 20 minutes)." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            team_id: { type: "string", required: true },
            role_id: { type: "string", required: true },
            session_id: { type: "string", required: true },
            created_new_session: { type: "boolean", required: true },
            receipt: { type: "json" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `orchestra_dispatch: dispatched to role '${value.role_id}' (session ${value.session_id}${value.created_new_session ? ", newly provisioned" : ""}), status=${value.status}`,
          },
        ],
      },
      async execute(args: { roleId: string; task: string; laneId?: string; preset?: string; timeoutMs?: number }, exec: ToolExecutionInput) {
        return dispatchRoleTask(ctx, activeTeamState, exec, args) as any;
      },
    }),
  );






  ctx.tools.register(
    defineTool({
      name: "orchestra_wait",
      description:
        "Sleep until an active Team change occurs (such as a role filing an orchestra_report or a state change), or until the 20-minute heartbeat timeout elapses. Reports whether a change occurred. Use this instead of polling in a loop: after dispatching work via orchestra_dispatch, sleep here; on waking or heartbeat timeout, re-read orchestra_team and advance whichever lane can advance.",
      parameters: {
        teamId: { type: "string", description: "Team to wait on; defaults to the active Team of the calling session's working directory." },
        timeoutMs: {
          type: "number",
          description: `Maximum wait in milliseconds (${MIN_WAIT_TIMEOUT_MS}..${MAX_WAIT_TIMEOUT_MS}); defaults to ${DEFAULT_WAIT_TIMEOUT_MS} (20 minutes heartbeat).`,
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            team_id: { type: "string", required: true },
            changed: { type: "boolean", required: true },
            timedOut: { type: "boolean", required: true },
            observed_at: { type: "number", required: true },
            waited_ms: { type: "number", required: true },
            cancelled: { type: "boolean" },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.cancelled === true
              ? `orchestra_wait ${value.team_id}: cancelled after ${value.waited_ms}ms — re-read state before deciding`
              : value.changed
                ? `orchestra_wait ${value.team_id}: a change was committed after ${value.waited_ms}ms — inspect orchestra_team / reports`
                : `orchestra_wait ${value.team_id}: heartbeat interval reached after ${value.waited_ms}ms — inspect team progress`,
          },
        ],
      },
      async execute(args: { teamId?: string; timeoutMs?: number }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_wait requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const timeoutMs = args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_WAIT_TIMEOUT_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
          throw new Error(`orchestra_wait timeoutMs must be an integer between ${MIN_WAIT_TIMEOUT_MS} and ${MAX_WAIT_TIMEOUT_MS} (received ${String(args.timeoutMs)}); it is never silently clamped`);
        }
        const observed = await activeTeamState.read(cwd, { signal: exec.signal });
        if (observed.kind !== "ready") {
          throw new Error(`orchestra_wait requires an active Team at ${cwd} (state is ${observed.kind}); waiting with nothing to wait on would just burn the timeout`);
        }
        const team = observed.team;
        if (args.teamId !== undefined && args.teamId !== "" && args.teamId !== team.teamId) {
          throw new Error(`orchestra_wait teamId "${args.teamId}" does not match the active Team ${team.teamId} at ${cwd}`);
        }
        // The baseline is sampled from the SAME read that proved the Team
        // exists, so a commit that lands between the read and the wait is not
        // mistaken for the waiter's own starting point.
        const outcome = await teamChange.wait({
          timeoutMs,
          cwd,
          baselineRevision: team.graphRuntime?.runtimeRevision ?? 0,
          signal: exec.signal,
        });
        return {
          team_id: team.teamId,
          changed: outcome.changed,
          timedOut: outcome.timedOut,
          observed_at: outcome.observedAt,
          waited_ms: outcome.waitedMs,
          ...(outcome.cancelled === true
            ? { cancelled: true, reason: "the wait was cancelled by the caller's signal before any change was committed" }
            : {}),
        };
      },
    }),
  );






  ctx.tools.register(
    defineTool({
      name: "orchestra_team",
      description:
        "Show the orchestra team state plus archive summaries: every role with its session id, live status, report count, last report path, and last activity; the team's mission, controller, and status; plus the current cwd's archive list (dismissed teams, newest first) for orchestra_activate selection. Requires a team created by orchestra_create in this working directory — returns {team: null, archives} when none is active.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            team: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    team_id: { type: "string", required: true },
                    status: { type: "string", required: true },
                    goal: { type: "string", required: true },
                    topology: { type: "string", required: true },
                    controller_session_id: { type: "string", required: true },
                    created_at: { type: "number", required: true },
                    activated_from_archive_id: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                    roles: { type: "array", required: true, items: roleItem },
                    reports: {
                      type: "array",
                      required: true,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          reportId: { type: "string", required: true },
                          roleId: { type: "string", required: true },
                          sessionId: { type: "string", required: true },
                          path: { type: "string", required: true },
                          createdAt: { type: "number", required: true },
                        },
                      },
                    },
                    notice_failures: {
                      type: "array",
                      required: true,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          milestone: { type: "string", required: true },
                          targetSessionId: { type: "string", required: true },
                          failedAt: { type: "number", required: true },
                          reason: { type: "string", required: true },
                        },
                      },
                    },
                    document_status: { type: "string" },
                    document_revision: { type: "number" },
                    document_stale: { type: "boolean" },
                    current_charter_revision: { type: "number" },
                    charter_digest: { type: "string" },
                    approval_ref: { type: "string" },
                    graph_status: { type: "string" },
                    graph_runtime_revision: { type: "number" },
                    graph_stale: { type: "boolean" },
                    graph: {
                      oneOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            status: { type: "string", required: true },
                            runtime_revision: { type: "number", required: true },
                            stale: { type: "boolean", required: true },
                            current_loop: {
                              oneOf: [
                                {
                                  type: "object",
                                  additionalProperties: false,
                                  properties: {
                                    loop_id: { type: "string", required: true },
                                    attempt: { type: "number" },
                                    status: { type: "string", required: true },
                                  },
                                },
                                { type: "null" },
                              ],
                              required: true,
                            },
                            pending_handoffs: { type: "number", required: true },
                            cap_exhausted: { type: "number", required: true },
                            expired_attempts: { type: "number", required: true },
                            team_budget_exhausted: { type: "boolean", required: true },
                            open_gates: { type: "number", required: true },
                            closure_status: { type: "string", required: true },
                            closure_outcome: { type: "string" },
                          },
                        },
                        { type: "null" },
                      ],
                    },
                    last_decision: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        decision_id: { type: "string", required: true },
                        kind: { type: "string", required: true },
                        summary: { type: "string", required: true },
                      },
                    },
                  },
                },
                { type: "null" },
              ],
            },
            archives: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  archive_id: { type: "string", required: true },
                  filename: { type: "string", required: true },
                  status: { type: "string", required: true },
                  team_id: { type: "string", required: true },
                  goal: { type: "string", required: true },
                  topology: { type: "string", required: true },
                  dismissed_at: { type: "number", required: true },
                  archive_path: { type: "string", required: true },
                  diagnostic: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      code: { type: "string", required: true },
                      message: { type: "string", required: true },
                      fsCode: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const archiveText =
            value.archives.length === 0
              ? "no archives"
              : value.archives
                  .map((a) =>
                    a.status === "blocked"
                      ? `${a.filename} (blocked: ${a.diagnostic?.code ?? "unknown"})`
                      : `${a.archive_id}${a.goal === "" ? "" : ` (${a.goal})`}`,
                  )
                  .join(", ");
          if (value.team == null) return [{ type: "text", text: `no active team; archives: ${archiveText}` }];
          const graphText =
            value.team.graph == null
              ? "graph: none"
              : `graph: ${value.team.graph.status}${value.team.graph.stale ? " (stale)" : ""} (rev ${value.team.graph.runtime_revision}) | ${value.team.graph.current_loop == null ? "no active loop" : `loop=${value.team.graph.current_loop.loop_id} attempt=${value.team.graph.current_loop.attempt ?? "-"} ${value.team.graph.current_loop.status}`} | pending handoffs=${value.team.graph.pending_handoffs} | cap exhausted=${value.team.graph.cap_exhausted} | open gates=${value.team.graph.open_gates} | closure=${value.team.graph.closure_status}${value.team.graph.closure_outcome === undefined ? "" : ` (${value.team.graph.closure_outcome})`}`;
          return [
            {
              type: "text",
              text: `team ${value.team.team_id} (${value.team.topology}, ${value.team.status}): ${value.team.roles
                .map((r) => `${r.id}(${r.status},R${r.reportCount}${r.lastReport === null ? "" : `, report=${r.lastReport}`}${r.lastActivity === undefined ? "" : `, last="${r.lastActivity}"`})`)
                .join(", ")} | archives: ${archiveText}\n${graphText}`,
            },
          ];
        },
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_team requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const initialTeam = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("inspect the team", initialTeam);
        const archiveList = await archiveStore.list(cwd, { signal: exec.signal });
        const archives = archiveListForTeamTool(archiveList);
        if (initialTeam.kind !== "ready") return { team: null, archives };
        const teamObservation = await sweepTeamBoundedRun(ctx, activeTeamState, initialTeam, exec);
        const team = teamObservation.team;
        const document = documentReadForTeam(team);
        const documentSummaryValue = documentSummary(document, team);
        const graphStale = document?.currentCharterRevision !== null && document?.currentCharterRevision !== undefined && document.charterRevisions.find((revision) => revision.charterRevision === document.currentCharterRevision)?.digest !== team.graphRuntime?.charterDigest;
        const graph = team.graphRuntime === undefined ? undefined : graphSummary(team.graphRuntime, graphStale || document?.runtimeProjection.graph?.stale === true);
        const roleHealth = roleHealthFor(team);
        return {
          team: {
            team_id: team.teamId,
            status: team.status,
            goal: team.mission.objective,
            topology: team.topologyRef.id,
            controller_session_id: team.controllerSessionId,
            created_at: team.createdAt,
            activated_from_archive_id: team.activatedFromArchiveId,
            roles: await Promise.all(team.roles.map((role) => roleStatus(ctx, role, roleHealth))),
            reports: team.reports,
            notice_failures: team.noticeFailures ?? [],
            document_status: documentSummaryValue.status,
            document_revision: documentSummaryValue.revision,
            document_stale: documentSummaryValue.stale,
            ...(documentSummaryValue.currentCharterRevision === undefined ? {} : { current_charter_revision: documentSummaryValue.currentCharterRevision }),
            ...(documentSummaryValue.currentCharterDigest === undefined ? {} : { charter_digest: documentSummaryValue.currentCharterDigest }),
            ...(documentSummaryValue.approvalRef === undefined ? {} : { approval_ref: documentSummaryValue.approvalRef }),
            ...(graph === undefined ? {} : { graph_status: graph.status, graph_runtime_revision: graph.runtimeRevision, graph_stale: graph.stale }),
            ...(graph === undefined
              ? {}
              : {
                  graph: {
                    status: graph.status,
                    runtime_revision: graph.runtimeRevision ?? 0,
                    stale: graph.stale,
                    ...(graph.currentLoop === undefined
                      ? { current_loop: null }
                      : {
                          current_loop: {
                            loop_id: graph.currentLoop.loopId,
                            ...(graph.currentLoop.attempt === undefined ? {} : { attempt: graph.currentLoop.attempt }),
                            status: graph.currentLoop.status,
                          },
                        }),
                    pending_handoffs: graph.pendingHandoffs.length,
                    cap_exhausted: graph.capExhausted.length,
                    expired_attempts: graph.expiredAttempts,
                    team_budget_exhausted: graph.teamBudgetExhausted,
                    open_gates: graph.openGates.length,
                    closure_status: graph.closure.status,
                    ...(graph.closure.outcome === undefined ? {} : { closure_outcome: graph.closure.outcome }),
                  },
                }),
            ...(documentSummaryValue.lastDecision === undefined
              ? {}
              : {
                  last_decision: {
                    decision_id: documentSummaryValue.lastDecision.decisionId,
                    kind: documentSummaryValue.lastDecision.kind,
                    summary: documentSummaryValue.lastDecision.summary,
                  },
                }),
          },
          archives,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_activate",
      description:
        "Reactivate a dismissed (archived) team: archive_id is REQUIRED (get the list from orchestra_team). Per role: live sessions are reused, persisted sessions are resumed, sessions authoritatively missing (session-not-found) are replaced with a new session (recorded in sessionHistory, sent a Recovery Packet), and other resume errors fail that role without replacement (team enters degraded). The caller becomes the new controller when it differs from the archived one (controller takeover). Requires a team created by orchestra_create in this working directory; fails while an active team exists.",
      parameters: {
        archiveId: { type: "string", required: true, description: "Archive id to reactivate (see orchestra_team archives[].archive_id)." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            team_id: { type: "string", required: true },
            archive_id: { type: "string", required: true },
            status: { type: "string", required: true },
            roles: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  role_id: { type: "string", required: true },
                  session_id: { type: "string", required: true },
                  action: { type: "string", required: true },
                  replaced_session_id: { type: "string" },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `team ${value.team_id} reactivated from ${value.archive_id} (${value.status}): ${value.roles
              .map((r) => `${r.role_id}=${r.session_id} (${r.action}${r.replaced_session_id === undefined ? "" : `, replaced ${r.replaced_session_id}`})`)
              .join(", ")}`,
          },
        ],
      },
      async execute(args: { archiveId: string }, exec: ToolExecutionInput) {
        const result = await activateArchivedTeam(ctx, activeTeamState, archiveStore, args, exec);
        return {
          team_id: result.teamId,
          archive_id: result.archiveId,
          status: result.status,
          roles: result.roles.map((role) => ({
            role_id: role.role_id,
            session_id: role.sessionId,
            action: role.action,
            ...(role.replacedSessionId === undefined ? {} : { replaced_session_id: role.replacedSessionId }),
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_dismiss",
      description:
        "Close the current orchestra instance: publish an immutable archive, CAS the active state into an archived marker, then notify every live role session that the team is archived (stop waiting for new tasks). Role sessions are independent assets and stay alive. Requires an instance created by orchestra_create in this working directory.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            team_id: { type: "string", required: true },
            archive_id: { type: "string", required: true },
            archive_path: { type: "string", required: true },
            dismissed_at: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `team ${value.team_id} dismissed and archived to ${value.archive_path}`,
          },
        ],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_dismiss requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const teamObservation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("dismiss the team", teamObservation);
        if (teamObservation.kind !== "ready") throw new Error(`cannot dismiss the team: ${teamObservation.diagnostic.message}`);
        const team = teamObservation.team;
        const dismissedAt = Date.now();
        const archived = await archiveStore.create(cwd, team, {
          dismissedAt,
          policy: escrowPolicy(ctx, exec),
          signal: exec.signal,
        });
        const archiveId = archived.summary.archiveId;
        const archivePath = archived.summary.archivePath;
        const marker: ActiveTeamArchivedMarker = {
          schemaVersion: 1,
          archived: true,
          status: "dismissed",
          archiveId,
          archivePath,
          archivedAt: dismissedAt,
          teamId: team.teamId,
        };
        try {
          await activeTeamState.archive(teamObservation, marker, {
            policy: escrowPolicy(ctx, exec),
            signal: exec.signal,
          });
        } catch (error) {
          throw new Error(
            `archive ${archiveId} was created at ${archivePath}, but active team CAS failed; the team was not dismissed and no role retirement notice was sent: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Archive notice to live roles (spec §8.3): cold roles are skipped —
        // they will be told again on reactivation.
        for (const role of team.roles) {
          const agent = ctx.agents.get(SID(role.sessionId));
          if (agent === undefined) continue;
          try {
            void deliverMessage(ctx, exec.agent.id, role.sessionId, [
              {
                type: "text",
                text: `Your team has been ARCHIVED (archive_id=${archiveId}, path=${archivePath}). You are retired from active collaboration: stop waiting for new tasks. If the team is reactivated, you will receive a notice.`,
              },
            ]).catch((error) => {
              console.error(
                `orchestra_dismiss: archive notice to ${role.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          } catch (error) {
            console.error(
              `orchestra_dismiss: archive notice to ${role.sessionId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { team_id: team.teamId, archive_id: archiveId, archive_path: archivePath, dismissed_at: dismissedAt };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_report",
      description:
        "Escrow write channel for role sessions under a read-only sandbox: write one file under orchestra/reports/ in the calling session's working directory. The path must be relative to orchestra/reports/ and must not contain \"..\". Returns the absolute path of the written file. Each successful write also books one delivered report on the calling role's team entry (reportCount +1, lastReport = path, reports[] appended). Reviewer roles use this to hand over review reports.",
      parameters: {
        path: { type: "string", required: true, description: "Relative path under orchestra/reports/, e.g. \"review-fix-bug-R1.md\"." },
        content: { type: "string", required: true, description: "Full file content." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `report written: ${value.path}` }],
      },
      async execute(args: { path: string; content: string }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_report requires an agent caller");
        const agentId = exec.agent.id;
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const rel = String(args.path ?? "");
        if (rel === "" || rel.includes("..") || rel.startsWith("/"))
          throw new Error("path must be relative under orchestra/reports/, no '..' or absolute paths");
        const full = `${cwd}/orchestra/reports/${rel}`;
        const target = await ctx.fs.resolve(full, { cwd });
        // Official canonical path API: FsTarget is an object ({ targetKey,
        // displayPath }) — String(target) would yield "[object Object]". Use the
        // backend's canonical execution-world path so lastReport/render/return
        // are real absolute paths (B5 fix).
        const canonical = ctx.fs.processPath(target);
        const teamObservation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("bookkeep the report", teamObservation);
        await ctx.fs.writeText(target, String(args.content ?? ""), undefined, undefined, escrowPolicy(ctx, exec));
        // Bookkeeping: record one delivered report on the calling role's team entry.
        if (teamObservation.kind === "ready") {
          const team = teamObservation.team;
          const role = team.roles.find((entry) => entry.sessionId === agentId);
          let updatedTeam = team;
          if (role !== undefined) {
            const nextRoles = team.roles.map((entry) =>
              entry.sessionId === agentId
                ? { ...entry, reportCount: (entry.reportCount ?? 0) + 1, lastReport: canonical }
                : entry,
            );
            const nextReports = [
              ...team.reports,
              {
                reportId: `report-${randomUUID().slice(0, 8)}`,
                roleId: role.id,
                sessionId: agentId,
                path: canonical,
                createdAt: Date.now(),
              },
            ];
            updatedTeam = {
              ...team,
              roles: nextRoles,
              reports: nextReports,
            };
            await activeTeamState.replace(teamObservation, updatedTeam, {
              policy: escrowPolicy(ctx, exec),
              signal: exec.signal,
            });
          }
          await notifyDriverMilestone(ctx, updatedTeam, agentId, "report", `written: ${rel}`, {
            recordFailure: noticeRecorderFor(ctx, activeTeamState, cwd, exec),
          });
        }
        return { path: canonical };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_topologies",
      description:
        "List available topology templates (spec §4.1): project templates under <cwd>/.orchestra/topologies/*.json, global templates under ~/.dsh/orchestra/topologies/*.json, plus the bundled fallback (duo/trio/oracle/four-role-dev). Each entry shows source, controller, protocol (ownership/routes/completion), and roles. Snapshot one in orchestra_draft before the user approves; roster mutation is refused outright — changes go through orchestra_draft → the user's approval → orchestra_create.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            templates: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  name: { type: "string", required: true },
                  description: { type: "string" },
                  source: { type: "string", required: true },
                  status: { type: "string", required: true },
                  filename: { type: "string", required: true },
                  controller: { type: "object", additionalProperties: true },
                  protocol: { type: "object", additionalProperties: true },
                  diagnostic: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      code: { type: "string", required: true },
                      message: { type: "string", required: true },
                      fsCode: { type: "string" },
                    },
                  },
                  roles: {
                    type: "array",
                    required: true,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        id: { type: "string", required: true },
                        name: { type: "string", required: true },
                        // The backend decides what the role can do at all, and the
                        // two native knobs only ever appear on a `subagent` role.
                        // A summary that carries a field its schema does not declare
                        // makes the WHOLE tool call invalid, so these three are
                        // declared here the moment roleSummary can emit them.
                        execution: { type: "string" },
                        persona: { type: "string" },
                        toolFilter: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            allow: { type: "array", items: { type: "string" } },
                            deny: { type: "array", items: { type: "string" } },
                          },
                        },
                        preset: { type: "string" },
                        sandbox: { type: "string" },
                        compositionTools: { type: "array", items: { type: "string" } },
                        orchestraTools: { type: "array", items: { type: "string" } },
                        optionalCapabilities: { type: "array", items: { type: "string" } },
                        maxRounds: { type: "number" },
                        runtime: { type: "object", additionalProperties: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.templates.length === 0
                ? "no templates"
                : value.templates
                    .map(
                      (t) =>
                        t.status === "blocked"
                          ? `${t.id || t.filename} (${t.source}, blocked: ${t.diagnostic?.code ?? "unknown"})`
                          // The backend is printed with the role id because it is what
                          // decides whether that role can hold its own preset or be
                          // read-only; a driver reading only ids cannot tell a hybrid
                          // template from a uniform one.
                          : `${t.id} (${t.source})${t.description === undefined ? "" : `: ${t.description}`} [roles: ${t.roles.map((r) => (r.execution === undefined ? r.id : `${r.id}:${r.execution}`)).join(", ")}]`,
                    )
                    .join("; "),
          },
        ],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_topologies requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const topologyList = await topologyCatalog.list(cwd, { signal: exec.signal });
        return { templates: topologyListForTool(topologyList) };
      },
    }),
  );

  // Web surface: team/template/archive state route for the settings panel (browser).
  const WEB_SERVER_KEYS = ["webServer", "httpServer"] as const;
  let webRegistered = false;
  const registerWebSurface = (): void => {
    if (webRegistered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    const workspaceRegistry = ctx.get("workspaceRegistry");
    webRegistered = true;
    ctx.effect(
      () =>
        (webServer as any).register({
          kind: "exact",
          path: "/plugins/orchestra-dsh/state",
          handler: async (req: unknown, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void }) => {
            const templatesById = new Map<string, OrchestraTopologyToolEntry>();
            const teams: {
              workspacePath: string;
              workspaceTitle?: string;
              teamId: string;
              status: string;
              goal: string;
              topology: string;
              createdAt: number;
              controllerSessionId: string;
              archived: boolean;
              archivePath?: string;
              roles: {
                id: string;
                name: string;
                sessionId: string;
                preset?: string;
                sandbox?: string;
                live: boolean;
                status: string;
                reportCount: number;
                lastReport: string | null;
                lastActivity?: string;
              }[];
            }[] = [];
            const roots: { path: string; title?: string }[] = [];
            const seenPaths = new Set<string>();
            const registryRoots = workspaceRegistry === undefined ? [] : ((workspaceRegistry as any).list() ?? []);
            for (const root of registryRoots) {
              if (typeof root?.path !== "string" || root.path === "" || seenPaths.has(root.path)) continue;
              seenPaths.add(root.path);
              roots.push({ path: root.path, ...(typeof root.title === "string" ? { title: root.title } : {}) });
            }
            const query = ctx.get("sessionQuery");
            if (query !== undefined) {
              try {
                const records = await query.listSessions();
                for (const record of records) {
                  const cwd = record.header.cwd;
                  if (typeof cwd !== "string" || cwd === "" || seenPaths.has(cwd)) continue;
                  seenPaths.add(cwd);
                  roots.push({ path: cwd });
                }
              } catch {
                // session enumeration is best-effort: registry-only still works
              }
            }
            for (const root of roots) {
              const path = root.path;
              try {
                const topologyList = await topologyCatalog.list(path);
                for (const template of topologyListForTool(topologyList)) {
                  const id = typeof template.id === "string" ? template.id : "";
                  const filename = typeof template.filename === "string" ? template.filename : "";
                  const key = id === "" ? `blocked:${filename}` : id;
                  if (!templatesById.has(key)) templatesById.set(key, template);
                }
                for (const blocked of topologyList.blocked) {
                  console.warn(`orchestra: state route observed blocked topology ${blocked.filename} at ${path}: ${blocked.diagnostic.message}`);
                }
              } catch {
                // Topology observation is optional for the GUI projection; the
                // core catalog/tool surfaces list failures directly.
              }
              try {
                const teamObservation = await activeTeamState.read(path);
                if (teamObservation.kind === "blocked") {
                  console.warn(`orchestra: state route skipped blocked active team at ${path}: ${teamObservation.diagnostic.message}`);
                }
                if (teamObservation.kind === "ready") {
                  const team = teamObservation.team;
                  const roleHealth = roleHealthFor(team);
                  const roles = await Promise.all(
                    team.roles.map(async (record) => {
                      const status = await roleStatus(ctx, record, roleHealth);
                      return {
                        id: status.id,
                        name: status.name,
                        sessionId: status.sessionId,
                        // The backend decides what a role can do at all (hold its
                        // own preset, ask for approval, be read-only), so the panel
                        // shows it ahead of the facts it constrains.
                        execution: status.execution,
                        ...(status.parentSessionId === undefined ? {} : { parentSessionId: status.parentSessionId }),
                        ...(record.preset === undefined || record.preset === null ? {} : { preset: record.preset }),
                        ...(record.sandbox === undefined ? {} : { sandbox: record.sandbox }),
                        live: status.live,
                        status: status.status,
                        reportCount: status.reportCount,
                        lastReport: status.lastReport,
                        ...(status.lastActivity === undefined ? {} : { lastActivity: status.lastActivity }),
                      };
                    }),
                  );
                  teams.push({
                    workspacePath: path,
                    ...(root.title === undefined ? {} : { workspaceTitle: root.title }),
                    teamId: team.teamId,
                    status: team.status,
                    goal: team.mission.objective,
                    topology: team.topologyRef.id,
                    createdAt: team.createdAt,
                    controllerSessionId: team.controllerSessionId,
                    archived: false,
                    roles,
                  });
                }
              } catch {
                // no active team
              }
              try {
                const archiveList = await archiveStore.list(path);
                for (const archive of archiveList.ready) {
                  teams.push({
                    workspacePath: path,
                    ...(root.title === undefined ? {} : { workspaceTitle: root.title }),
                    teamId: archive.teamId,
                    status: "dismissed",
                    goal: archive.goal,
                    topology: archive.topology,
                    createdAt: 0,
                    controllerSessionId: "",
                    archived: true,
                    archivePath: archive.archivePath,
                    roles: [],
                  });
                }
                for (const blocked of archiveList.blocked) {
                  console.warn(`orchestra: state route skipped blocked archive ${blocked.filename} at ${path}: ${blocked.diagnostic.message}`);
                }
              } catch {
                // Archive observation is optional for the GUI projection; the
                // core team/archive tools surface list failures directly.
              }
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ templates: [...templatesById.values()], teams }));
          },
        }),
      "orchestra: state route",
    );
  };
  registerWebSurface();

  // Approving with a plain reply instead of a slash command (user decision,
  // 2026-09-15 — see docs/adr/0006). `session/event` is a post-commit feed, so by
  // the time this runs the user's message is already durable and the approval it
  // triggers can cite it.
  //
  // The filter is deliberately cheap and first: this listener sees EVERY appended
  // event of EVERY session, so anything that is not a user-authored text message
  // must cost two property reads and return. The approval work itself is async
  // and detached — an observer failure must never touch the append that triggered
  // it (the event contract says so explicitly), and a thrown error here would be
  // a plugin breaking a session's log write.
  ctx.on("session/event", (session: any, event: any) => {
    if (event?.type !== "user/message") return;
    if (event?.data?.source?.kind !== "user") return;
    void approvePendingDraftFromUserMessage(ctx, session, { seq: event.seq, data: event.data }).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      // A thrown approval is the worst silence in this plugin: the user's reply
      // IS the approval gesture now, so if the record is not written they will
      // believe they approved while nothing was frozen. A console line is not
      // enough — the failure is injected into the conversation, the same channel
      // a successful approval uses, so the driver learns it must not proceed.
      console.warn(`orchestra: could not read a plain-reply approval from ${String(session?.id)} seq ${String(event?.seq)}: ${reason}`);
      try {
        const agent = ctx.get("agents")?.get(session?.id);
        agent?.followup?.(
          createUserMessage({
            content: [
              {
                type: "text",
                text: `(orchestra approval failure) The user's reply was NOT recorded as an approval: ${reason}. Nothing was frozen and no role was created. Do not treat the plan as approved; fix the cause and ask the user to reply again.`,
              },
            ] as ContentBlock[],
            source: {
              kind: "plugin",
              plugin: "orchestra",
              form: "notice",
              summary: "orchestra approval failure",
            } as MessageSource,
          }) as never,
        );
      } catch (noticeError) {
        console.warn(
          `orchestra: could not report the approval failure into ${String(session?.id)} either (${noticeError instanceof Error ? noticeError.message : String(noticeError)}); the user's approval was dropped and nobody was told`,
        );
      }
    });
  });

  ctx.on("internal/service", (name) => {
    if ((WEB_SERVER_KEYS as readonly string[]).includes(name) || name === "workspaceRegistry") {
      registerWebSurface();
    }
  });

  // The method behind /team, registered where a driver meets it: a short
  // always-on section plus the worked detail as a loadable skill.
  registerOrchestrationPrinciples(ctx);

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text:
        "Orchestra: you are the team driver — the role that starts a team toward a goal and owns decisions. When the user says /team or expresses intent to open a team / collaborate / delegate, follow the onboarding protocol below:\n" +
        "1. Goal: ask the user to state the goal — what \"done\" looks like. One topology run completes one goal; a clear goal defines when to stop.\n" +
        "2. Constraints: ask about limits/constraints (time, quality, boundaries). Merge into the same round when possible.\n" +
        "3. Context: read the project context relevant to the goal (files, docs) to ground your understanding.\n" +
        "4. Proposal: call orchestra_draft to persist the mission and topology Draft, then report its draftId@revision and digest to the user with a per-role roster card preview.\n" +
        "5. Approval: ask the user to approve by replying with a plain yes — 启动 (or 可以 / 同意 / ok). Their reply is recorded automatically against the exact draft revision. Only the USER can approve. Until approval lands, do not dispatch roles.\n" +
        "6. Dispatch and Execute: dispatch concrete lane tasks using orchestra_dispatch(roleId, task, { laneId, preset }). orchestra_dispatch automatically provisions the role session if not already running. Roles work autonomously.\n" +
        "7. Sleep & Heartbeat: after dispatching, call orchestra_wait to sleep with a 20-minute heartbeat. Filing an orchestra_report wakes you early; if 20 minutes elapse without activity, the heartbeat wakes you to inspect orchestra_team and intervene.\n" +
        "8. Session Control: use a2a_stop(sessionId, reason) to immediately abort a runaway or stuck session. Use a2a_list(query) to inspect or search sessions sorted by recent activity. Use a2a_read for progressive turn review.\n" +
        "Stay in your role: you are the driver, not an implementer or reviewer. Do not edit code or do the role's work yourself. Dispatch tasks, monitor with orchestra_wait, and verify objective facts with orchestra_team and report files. Close the run with orchestra_dismiss when done.",
    });
  }

  const commands = ctx.get("commands");
  if (commands !== undefined) {
    commands.register({
      name: "team",
      description: "Orchestra dynamic orchestration: state your goal; the orchestrator will clarify it, propose a topology (roles and duties), and create role sessions only after your approval.",
      input: { hint: "Describe the task or goal..." },
      // recordInput: true — the UI renders the user's full "/team <goal>" line
      // as a normal command bubble (the command/run event's args). The model
      // never sees command/run, so the handler below still delivers the goal
      // to the agent as ONE followup (single delivery: splitting marker and
      // goal across deliveries previously caused turn misalignment).
      recordInput: true,
      handler: (invocation) => {
        const raw = invocation.rawInput.trim();
        if (/^approve(?:\s|$)/.test(raw)) return handleTeamApprovalCommand(ctx, invocation as any);
        if (/^decide(?:\s|$)/.test(raw)) return handleTeamGateDecisionCommand(ctx, activeTeamState, invocation as any);
        // Single plugin-source notice carrying the marker (+ the goal when
        // provided). It renders as a collapsed context row, NOT as a user
        // bubble — the user's bubble is the command bubble itself ("/team
        // <goal>"), so no bracket-prefixed user message pollutes the chat.
        const noticeText =
          raw === ""
            ? "(orchestra /team orchestration request: the user wants to open a team collaboration; start by confirming the goal)"
            : `(orchestra /team orchestration request: the user wants to open a team collaboration)\n\n${raw}`;
        const marker = createUserMessage({
          content: [{ type: "text", text: noticeText }] as ContentBlock[],
          source: {
            kind: "plugin",
            plugin: "orchestra",
            form: "notice",
            summary: "orchestra /team orchestration request",
          } as MessageSource,
        });
        invocation.agent.followup(marker);
        return { kind: "success", text: "Orchestration request accepted; starting team onboarding." };
      },
    });
  }
}
