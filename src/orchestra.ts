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
import type { ToolExecutionInput, JsonValue } from "@deepseek-ai/dsh-tools";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-commands";
import { createSession, installModelOverride, deliverMessage, readDeliveryReceipt } from "./a2a.js";
import type { ResolvedPresetFile } from "./a2a.js";
import { hostToolNamesForPreflight, prepareGovernedBlueprint, preflightGovernedRequiredTools, resolveDraftRoleModel, SessionBlueprintError } from "./session-blueprint.js";
import type { GovernedBlueprintReceipt, PreparedGovernedBlueprint } from "./session-blueprint.js";
import {
  ensureBuiltinRolePresetArtifacts,
  resolveRolePresetFile,
  rolePresetSpec,
} from "./orchestra-role-presets.js";
import { createActiveTeamStateStore } from "./orchestra-state.js";
import type {
  ArchiveList,
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
  TeamRolePhase,
  TeamWelcomeReceipt,
} from "./orchestra-state.js";
import { createArchiveStore } from "./orchestra-archive.js";
import { createGovernedRoleAddressResolver } from "./orchestra-address.js";
import type { GovernedRoleAddressResolver } from "./orchestra-address.js";
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
} from "./orchestra-graph.js";
import type { GraphRuntimeState } from "./orchestra-graph.js";
import { createTopologyCatalog } from "./orchestra-topology.js";
import type { RoleConfig, TopologyCatalog, TopologyClosureDefinition, TopologyList, TopologyProtocol, TopologyResolution, TopologyRoleSummary } from "./orchestra-topology.js";
export { validateTopology } from "./orchestra-topology.js";
import { mountPreset } from "@deepseek-ai/dsh-agent-presets";
import "./relay-types.js";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SID = (value: string): SessionId => value as SessionId;

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
  const parts = [roleProtocolText(fromSessionId, roleName, protocol)];
  if (typeof extra === "string" && extra !== "") parts.push(extra);
  const message = createUserMessage({
    content: [{ type: "text", text: parts.join("\n\n") }] as ContentBlock[],
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
  presetId: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  welcome?: string;
  maxRounds?: number;
  protocol?: TopologyProtocol;
  blueprint: PreparedGovernedBlueprint;
}

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
  return {
    id: plan.roleId,
    name: plan.roleName,
    sessionId: plan.sessionId,
    phase: "reserved",
    sessionHistory: [],
    preset: plan.presetId,
    sandbox: plan.sandbox,
    model: {
      provider: plan.blueprint.receipt.provider,
      model: plan.blueprint.receipt.model,
      ...(plan.blueprint.receipt.reasoningEffort === undefined ? {} : { reasoningEffort: plan.blueprint.receipt.reasoningEffort }),
    },
    blueprint: roleBlueprintFacts(plan.blueprint.receipt),
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
    signal?: AbortSignal;
  },
): Promise<GovernedRolePlan> {
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
  const sessionId = governedSessionId(options.teamId);
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
    presetId: blueprint.receipt.agentPreset,
    sandbox: blueprint.receipt.sandbox,
    ...(options.welcome === undefined ? {} : { welcome: options.welcome }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    blueprint,
  };
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
  preset: string;
  presetSource?: "project" | "global" | "dsh" | "builtin";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  permissionPreset: string;
  effectivePermissionPreset: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
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
    preset: presetId,
    ...(presetFile.source === undefined ? {} : { presetSource: presetFile.source }),
    sandbox: permission.sandbox,
    permissionPreset: permission.permissionPreset,
    effectivePermissionPreset: permission.effectivePermissionPreset,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    compositionTools: compositionTools ?? [],
    orchestraTools: orchestraTools ?? [],
  };
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
    throw new Error("cannot spawn a role: legacy_missing (run orchestra_reconcile first; spawning does not initialize a legacy document)");
  }
}

export function rejectDirectGovernedSpawn(): void {
  throw new Error("approval_required: orchestra_spawn cannot mutate a Governed roster directly; use orchestra_draft → /team approve <draftId>@<revision> → orchestra_freeze → orchestra_apply_amendment");
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

const quarantinedCharterEvents = new WeakMap<object, Set<unknown>>();

function charterEventsOf(session: { events?: readonly unknown[] }): readonly unknown[] {
  const events = Array.isArray(session.events) ? session.events : [];
  const quarantined = quarantinedCharterEvents.get(session as object);
  return quarantined === undefined ? events : events.filter((event) => !quarantined.has(event));
}

export function charterEventsForSession(session: { events?: readonly unknown[] }): readonly unknown[] {
  return charterEventsOf(session);
}

function quarantineCharterEvent(session: object, event: unknown): void {
  let quarantined = quarantinedCharterEvents.get(session);
  if (quarantined === undefined) {
    quarantined = new Set<unknown>();
    quarantinedCharterEvents.set(session, quarantined);
  }
  quarantined.add(event);
}

function charterCommandError(action: string, error: unknown): Error {
  if (error instanceof CharterError) return new Error(`cannot ${action}: ${error.code}: ${error.message}`);
  return new Error(`cannot ${action}: ${error instanceof Error ? error.message : String(error)}`);
}

async function appendDurableCharterEvent(ctx: Context, session: any, event: CharterEvent): Promise<void> {
  const beforeLength = Array.isArray(session.events) ? session.events.length : 0;
  const appended: unknown = session.append(event.type, event.data);
  const inserted = Array.isArray(session.events) ? session.events[beforeLength] : undefined;
  try {
    const accepted = await ctx.sessions.flush(session as any);
    if (!accepted) throw new Error(`charter event ${event.type} was appended but did not receive durable flush acceptance`);
  } catch (error) {
    if (appended !== undefined) quarantineCharterEvent(session, appended);
    if (inserted !== undefined) quarantineCharterEvent(session, inserted);
    throw error;
  }
}

export async function handleTeamApprovalCommand(
  ctx: Context,
  invocation: { rawInput: string; commandId: string; agent: { id: string; session: any } },
): Promise<{ kind: "success"; text: string }> {
  const raw = invocation.rawInput.trim();
  const approvalMatch = raw.match(/^approve\s+([a-z0-9]+(?:-[a-z0-9]+)*)@([1-9]\d*)\s*$/);
  if (approvalMatch === null) throw new Error("approval command syntax is /team approve <draftId>@<revision>; natural-language consent is not hard approval");
  const draftId = approvalMatch[1];
  const revision = Number(approvalMatch[2]);
  const events = charterEventsOf(invocation.agent.session);
  let command;
  try {
    command = prepareApprovalEvent(events, {
      draftId,
      revision,
      commandId: String(invocation.commandId),
      approvingSessionId: invocation.agent.id,
      approvedAt: Date.now(),
    });
  } catch (error) {
    throw charterCommandError("approve the charter draft", error);
  }
  if (command.kind === "changed") {
    await appendDurableCharterEvent(ctx, invocation.agent.session, command.event);
    return { kind: "success", text: `Draft ${draftId}@${revision} approved by user command. digest=${command.value.digest}; freeze target=${frozenRef(draftId, revision, command.value.digest)}` };
  }
  return { kind: "success", text: `Draft ${draftId}@${revision} was already approved; freeze target=${command.value.approvalRef}` };
}

export async function handleTeamGateDecisionCommand(
  ctx: Context,
  activeTeamState: ActiveTeamStateStore,
  invocation: { rawInput: string; commandId: string; agent: { id: string; session: any } },
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
  if (command.kind === "noop") return { kind: "success", text: `Gate ${gate.gateInstanceId} was already resolved with option ${match[2]}` };
  await appendDurableCharterEvent(ctx, invocation.agent.session, { type: "orchestra/gate-decision", data: { gateInstanceId: gate.gateInstanceId, option: match[2], commandId: String(invocation.commandId), decidedAt: Date.now(), approvingSessionId: invocation.agent.id, source: "user-command" } });
  try {
    await persistGraphTransition(ctx, activeTeamState, observed, command.runtime, { agent: invocation.agent } as any);
  } catch (error) {
    throw new Error(`gate decision durable but graph transition is pending: ${error instanceof Error ? error.message : String(error)}`);
  }
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

async function persistGraphTransition(ctx: Context, activeTeamState: ActiveTeamStateStore, snapshot: ActiveTeamReady, runtime: GraphRuntimeState, exec: ToolExecutionInput, status?: TeamState["status"]): Promise<ActiveTeamReady> {
  const written = await activeTeamState.replace(snapshot, { ...snapshot.team, ...(status === undefined ? {} : { status }), graphRuntime: runtime }, { policy: escrowPolicy(ctx, exec), signal: exec.signal });
  return readySnapshotAfterWrite(activeTeamState, snapshot.cwd, written, exec.signal);
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
    loops: graphLoops(runtime),
    pending_handoffs: summary.pendingHandoffs,
    cap_exhausted: summary.capExhausted,
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
  const createRoleSession = dependencies.createSession ?? createSession;
  const deliverRoleWelcome = dependencies.sendRoleWelcome ?? sendRoleWelcome;
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
        {
          ownership: plan.protocol?.ownership,
          routes: plan.protocol?.routes,
          completion: plan.protocol?.completion,
          maxRounds: plan.maxRounds,
        },
      );
      const activeRoleTeam = updateTeamRole(team, plan.roleId, {
        phase: "active",
        diagnostic: undefined,
        welcome,
        blueprint: roleBlueprintFacts(plan.blueprint.receipt),
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
    throw new Error("approval_required: orchestra_create now requires frozenRef from orchestra_freeze; use orchestra_draft → /team approve <draftId>@<revision> → orchestra_freeze");
  }
  let frozen: FrozenCharterRevision;
  try {
    frozen = resolveFrozenCharter(charterEventsOf(exec.agent.session), args.frozenRef);
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
  const receipt = await deliverMessage(ctx, exec.agent.id, address.resolved_session_id, [
    { type: "text", text: `Governed dispatch from ${exec.agent.id} to ${address.team_id}/${address.role_id}:` },
    { type: "text", text: args.message },
  ], { wake: args.wake, interrupt: args.interrupt === true, idempotencyKey: args.idempotencyKey });
  return { team_id: address.team_id, role_id: address.role_id, resolved_session_id: address.resolved_session_id, receipt };
}

async function roleStatus(ctx: Context, role: TeamRole) {
  const agent = ctx.agents.get(SID(role.sessionId));
  const status: {
    id: string;
    name: string;
    sessionId: string;
    live: boolean;
    status: string;
    phase: TeamRolePhase;
    reportCount: number;
    lastReport: string | null;
    diagnostic?: TeamRoleDiagnostic;
    lastActivityAt?: number;
    lastActivity?: string;
  } = {
    id: role.id,
    name: role.name,
    sessionId: role.sessionId,
    live: agent !== undefined,
    status: agent === undefined ? "cold" : agent.status,
    phase: role.phase,
    reportCount: role.reportCount ?? 0,
    lastReport: role.lastReport ?? null,
    ...(role.diagnostic === undefined ? {} : { diagnostic: role.diagnostic }),
  };
  try {
    const query = ctx.get("sessionQuery");
    if (query === undefined) return status;
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
  const activeTeamState = createActiveTeamStateStore(ctx.fs);
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
        "Create a Governed orchestra team only from an exact immutable frozenRef produced by orchestra_freeze after /team approve <draftId>@<revision>. goal/topology alone are not approval and return approval_required. The frozen mission/topology snapshot is used for transactional role provisioning and copied into team.json.document charterRevisions.",
      parameters: {
        frozenRef: { type: "string", required: true, description: "Exact frozen charter ref: draftId@revision#digest from orchestra_freeze." },
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
      name: "orchestra_spawn",
      description:
        "Governed role spawning is approval-gated in 4B and this direct tool fails closed. Use orchestra_draft → /team approve <draftId>@<revision> → orchestra_freeze → orchestra_create for initial Teams, or orchestra_apply_amendment for an approved charter change; no direct roster mutation is performed here.",
      parameters: {
        roleName: { type: "string", description: "Role name, e.g. \"implementer\" (required unless templateId+roleId are given)." },
        mission: { type: "string", description: "Role duties or current task summary; appended to the injected welcome." },
        presetId: { type: "string", description: "Agent preset id to mount; defaults to the deployment default." },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"], description: "Optional sandbox mode for the role session." },
        permissionPreset: { type: "string", description: "Base Permission Preset for the governed role; defaults to the deployment default." },
        templateId: { type: "string", description: "Topology template id to source the role from (with roleId)." },
        roleId: { type: "string", description: "Role id inside the template to source preset/sandbox/welcome from." },
        provider: { type: "string", description: "Model provider override for the role session. Must be paired with model." },
        model: { type: "string", description: "Model override for the role session. Must be paired with provider." },
        reasoningEffort: { type: "string", description: "Reasoning effort override for the role session (e.g. \"medium\"). Requires provider and model." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            roleName: { type: "string", required: true },
            topology: { type: "string", required: true },
            status: { type: "string", required: true },
            phase: { type: "string", required: true },
            roles: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  sessionId: { type: "string", required: true },
                  phase: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `role ${value.roleName} spawned as ${value.sessionId} (instance ${value.topology}, ${value.roles.length} role(s))`,
          },
        ],
      },
      async execute(
        args: {
          roleName?: string;
          mission?: string;
          presetId?: string;
          sandbox?: string;
          permissionPreset?: string;
          templateId?: string;
          roleId?: string;
          provider?: string;
          model?: string;
          reasoningEffort?: string;
        },
        exec: ToolExecutionInput,
      ) {
        if (exec.agent === undefined) throw new Error("orchestra_spawn requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory; cannot create a role");
        rejectDirectGovernedSpawn();
        let roleName = String(args.roleName ?? "").trim();
        if (roleName === "" && args.templateId !== undefined && args.roleId !== undefined) {
          roleName = args.roleId;
        }
        if (roleName === "") throw new Error("roleName must not be empty (or provide templateId+roleId)");
        let templatePreset: string | null | undefined;
        let templateSandbox: string | undefined;
        let templateWelcome: string | undefined;
        let templateMaxRounds: number | undefined;
        let templateRuntime: RoleConfig["runtime"] | undefined;
        let templateProtocol: TopologyProtocol | undefined;
        let templateTopologyId: string | undefined;
        let templateTopologySource: "project" | "global" | "bundled" | undefined;
        if (args.templateId !== undefined || args.roleId !== undefined) {
          if (args.templateId === undefined || args.roleId === undefined)
            throw new Error("templateId and roleId must be provided together");
          const topologyResolution = await topologyCatalog.resolve(cwd, args.templateId, { signal: exec.signal });
          if (topologyResolution.kind !== "ready") {
            const available = (await topologyCatalog.list(cwd, { signal: exec.signal })).ready.map((entry) => entry.config.id);
            throw topologyResolutionError("spawn a role from a template", topologyResolution, available);
          }
          const topology = topologyResolution;
          const source = topology.config.roles.find((role) => role.id === args.roleId);
          if (source === undefined) throw new Error(`template ${args.templateId} has no role ${args.roleId}`);
          templatePreset = source.preset;
          templateSandbox = source.sandbox;
          templateWelcome = source.welcome;
          templateMaxRounds = source.maxRounds;
          templateRuntime = source.runtime;
          templateProtocol = topology.config.protocol;
          templateTopologyId = topology.config.id;
          templateTopologySource = topology.source;
        } else {
          const matched = await topologyCatalog.findRole(cwd, roleName, { signal: exec.signal });
          if (matched !== undefined) {
            templatePreset = matched.role.preset;
            templateSandbox = matched.role.sandbox;
            templateWelcome = matched.role.welcome;
            templateMaxRounds = matched.role.maxRounds;
            templateRuntime = matched.role.runtime;
            templateProtocol = matched.topology.config.protocol;
            templateTopologyId = matched.topology.config.id;
            templateTopologySource = matched.topology.source;
          }
        }
        const effectivePreset = args.presetId !== undefined && args.presetId !== "" ? args.presetId : templatePreset;
        const effectiveSandbox = args.sandbox ?? templateSandbox;
        const teamObservation = await activeTeamState.read(cwd, { signal: exec.signal });
        assertSpawnableTeamDocument(teamObservation);
        if (teamObservation.kind === "ready" && teamObservation.team.status !== "active" && teamObservation.team.status !== "degraded") {
          throw new Error(`cannot spawn a role while team status is ${teamObservation.team.status}; inspect the failed/provisioning state first`);
        }
        let team: TeamState;
        let existingStatus: "active" | "degraded" = "active";
        if (teamObservation.kind !== "ready") {
          team = {
            schemaVersion: 1,
            teamId: `team-${randomUUID().slice(0, 8)}`,
            status: "provisioning",
            rootCwd: cwd,
            controllerSessionId: exec.agent.id,
            controllerHistory: [],
            topologyRef: { id: templateTopologyId ?? args.templateId ?? "custom", source: templateTopologySource ?? "bundled" },
            mission: { objective: "", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
            createdAt: Date.now(),
            activatedFromArchiveId: null,
            roles: [],
            reports: [],
          };
        } else {
          team = teamObservation.team;
          existingStatus = team.status === "degraded" ? "degraded" : "active";
          if (team.roles.some((role) => role.id.toLowerCase() === roleName.toLowerCase())) {
            throw new Error(
              `role id "${roleName}" already exists in this team; choose a distinct roleName (e.g. "${roleName}-2", numeric suffixes still inherit the matching template's sandbox/preset), or pass templateId+roleId / sandbox:"read-only" explicitly`,
            );
          }
          if (team.topologyRef.id !== "custom") {
            const blueprint = await topologyCatalog.resolve(cwd, team.topologyRef.id, { signal: exec.signal });
            if (blueprint.kind !== "ready") {
              const available = (await topologyCatalog.list(cwd, { signal: exec.signal })).ready.map((entry) => entry.config.id);
              throw topologyResolutionError("check the team topology", blueprint, available);
            }
            const base = roleName.replace(/-\d+$/, "").toLowerCase();
            const inBlueprint = blueprint.config.roles.some(
              (role) => role.id.toLowerCase() === base || String(role.name ?? role.id).toLowerCase() === base,
            );
            if (!inBlueprint) team = { ...team, topologyRef: { id: "custom", source: "bundled" } };
          }
        }
        const roleConfig: RoleConfig = {
          id: roleName,
          name: roleName,
          preset: effectivePreset,
          sandbox: effectiveSandbox,
          runtime: templateRuntime,
          welcome: templateWelcome,
        };
        const plan = await prepareGovernedRolePlan(ctx, {
          cwd,
          teamId: team.teamId,
          controllerSessionId: team.controllerSessionId,
          topologyId: team.topologyRef.id,
          topologySource: team.topologyRef.source,
          role: roleConfig,
          presetId: effectivePreset,
          sandbox: effectiveSandbox,
          welcome: [templateWelcome, args.mission].filter((part) => typeof part === "string" && part !== "").join("\n\n") || undefined,
          protocol: templateProtocol,
          maxRounds: templateMaxRounds,
          permissionPreset: args.permissionPreset,
          provider: args.provider,
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          title: roleSessionTitle({ roleId: roleConfig.id, missionObjective: team.mission.objective, cwd }),
          signal: exec.signal,
        });
        assertUniqueGovernedSessionIds([plan]);
        const reservedTeam: TeamState = {
          ...team,
          status: "provisioning",
          roles: [...team.roles, reservedRole(plan)],
        };
        if (teamObservation.kind !== "ready" && reservedTeam.document === undefined) reservedTeam.document = initializeOrchestrationDocument(reservedTeam, reservedTeam.createdAt);
        const writeOptions = { policy: escrowPolicy(ctx, exec), signal: exec.signal };
        const reservation = teamObservation.kind === "ready"
          ? await activeTeamState.replace(teamObservation, reservedTeam, writeOptions)
          : await activeTeamState.create(cwd, reservedTeam, writeOptions);
        const initialSnapshot = await readySnapshotAfterWrite(activeTeamState, cwd, reservation, exec.signal);
        const provisioned = await provisionGovernedPlans(
          ctx,
          activeTeamState,
          exec,
          cwd,
          initialSnapshot,
          [plan],
          existingStatus,
          teamObservation.kind === "ready" ? "degraded" : "failed",
        );
        return {
          sessionId: plan.sessionId,
          roleName,
          topology: provisioned.team.topologyRef.id,
          status: provisioned.team.status,
          phase: provisioned.team.roles.find((role) => role.id === plan.roleId)?.phase ?? "active",
          roles: provisioned.team.roles.map((role) => ({ id: role.id, sessionId: role.sessionId, phase: role.phase })),
        };
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
        "Driver-only Charter Draft command. Creates revision 1 or appends a new revision using expectedRevision. The Draft is stored in the current Driver Session's append-only events; it is not a Team or approval. For an active Team, only the current controller/semantic writer may create an amendment Draft.",
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
          const lines = [`charter draft ${value.draft_id}@${value.revision} (${value.approval_status}) digest=${value.digest}`];
          for (const rawRole of value.role_blueprint_preview ?? []) {
            const role = rawRole as unknown as DraftRoleFacts;
            lines.push(
              `role ${role.roleId}: preset=${role.preset}${role.presetSource === undefined ? "" : ` (${role.presetSource})`} sandbox=${role.sandbox} permission=${role.permissionPreset} model=${role.provider}/${role.model}${role.reasoningEffort === undefined ? "" : ` reasoningEffort=${role.reasoningEffort}`} compositionTools=[${(role.compositionTools ?? []).join(", ")}] orchestraTools=[${(role.orchestraTools ?? []).join(", ")}]`,
            );
          }
          return [{ type: "text", text: lines.join("\n") }];
        },
      },
      async execute(args: CharterDraftToolArgs, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_draft requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("create a charter draft", observation);
        const events = charterEventsOf(exec.agent.session);
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
          if (document === undefined) throw new Error("cannot create an amendment Draft: legacy_missing (run orchestra_reconcile first)");
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
      name: "orchestra_charters",
      description: "Read Draft revisions, durable user approvals, and frozen charter facts from the current Driver Session event log. This is read-only and never infers approval from chat text.",
      parameters: {
        draftId: { type: "string", description: "Optional exact draft id filter; all revisions remain visible." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            drafts: { type: "array", items: { type: "json" }, required: true },
            approvals: { type: "array", items: { type: "json" }, required: true },
            freezes: { type: "array", items: { type: "json" }, required: true },
            diagnostic: { type: "object", additionalProperties: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `charter event log ${value.status}: drafts=${value.drafts.length}, approvals=${value.approvals.length}, freezes=${value.freezes.length}` }],
      },
      async execute(args: { draftId?: string }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_charters requires an agent caller");
        return charterListOutput(charterEventsOf(exec.agent.session), args.draftId) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_freeze",
      description:
        "Freeze an exactly user-approved Charter Draft into an immutable FrozenCharterRevision. The approval must come from /team approve <draftId>@<revision>; model text and natural-language consent are insufficient. Freeze returns the exact frozenRef used by orchestra_create or amendment application.",
      parameters: {
        draftId: { type: "string", required: true },
        revision: { type: "number", required: true },
        digest: { type: "string", required: true },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            frozen_ref: { type: "string", required: true },
            charter_revision: { type: "number", required: true },
            draft_id: { type: "string", required: true },
            draft_revision: { type: "number", required: true },
            digest: { type: "string", required: true },
            approval_ref: { type: "string", required: true },
            mission: { type: "object", additionalProperties: true, required: true },
            topology: { type: "object", additionalProperties: true, required: true },
            human_participation: { type: "object", additionalProperties: true, required: true },
            frozen_by_session_id: { type: "string", required: true },
            frozen_at: { type: "number", required: true },
            reason: { type: "string" },
            impact: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `charter frozen ${value.frozen_ref} (charter revision ${value.charter_revision})` }],
      },
      async execute(args: { draftId: string; revision: number; digest: string }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_freeze requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("freeze a charter", observation);
        if (observation.kind === "ready") {
          const document = documentReadForTeam(observation.team);
          if (document === undefined) throw new Error("cannot freeze a charter for an active legacy Team: run orchestra_reconcile first");
          if (exec.agent.id !== observation.team.controllerSessionId || exec.agent.id !== document.semanticWriterSessionId) throw new Error("cannot freeze a charter: permission_denied (current controller/semantic writer required)");
        }
        const events = charterEventsOf(exec.agent.session);
        let current: CharterDraft;
        try {
          const summary = charterSummary(events, args.draftId);
          current = summary.draft;
        } catch (error) {
          throw charterCommandError("read the charter draft", error);
        }
        if (observation.kind !== "ready" && current.authorSessionId !== exec.agent.id) throw new Error("cannot freeze a charter: permission_denied (draft author Session required)");
        let command;
        try {
          command = prepareFreezeEvent(events, {
            draftId: args.draftId,
            revision: args.revision,
            digest: args.digest,
            frozenBySessionId: exec.agent.id,
            frozenAt: Date.now(),
          });
        } catch (error) {
          throw charterCommandError("freeze the charter", error);
        }
        if (command.kind === "changed") await appendDurableCharterEvent(ctx, exec.agent.session, command.event);
        return frozenCharterOutput(command.value) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_apply_amendment",
      description:
        "Apply an exactly approved and frozen amendment to the current Team document. This appends an immutable charter revision through ActiveTeam CAS and records a Driver decision; it never spawns, dismisses, or rewrites role Session mappings. Topology roster changes return pending_runtime_actions instead of pretending to be applied.",
      parameters: {
        frozenRef: { type: "string", required: true, description: "Exact frozen amendment ref from orchestra_freeze." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            team_id: { type: "string", required: true },
            frozen_ref: { type: "string", required: true },
            current_charter_revision: { type: "number", required: true },
            target_charter_revision: { type: "number", required: true },
            pending_roles: { type: "array", items: { type: "string" }, required: true },
            markdown_status: { type: "string", required: true },
            markdown_path: { type: "string", required: true },
            message: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `charter amendment ${value.status} for ${value.team_id}: revision ${value.current_charter_revision}${value.pending_roles.length === 0 ? "" : `; pending roles=${value.pending_roles.join(", ")}`}` }],
      },
      async execute(args: { frozenRef: string }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_apply_amendment requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("apply a charter amendment", observation);
        if (observation.kind !== "ready") throw new Error(`cannot apply a charter amendment: no ready Team state (${observation.kind})`);
        if (observation.team.status !== "active" && observation.team.status !== "degraded") throw new Error(`cannot apply a charter amendment while Team status is ${observation.team.status}`);
        const team = observation.team;
        const document = documentReadForTeam(team);
        if (document === undefined) throw new Error("cannot apply a charter amendment: legacy_missing (run orchestra_reconcile first)");
        if (exec.agent.id !== team.controllerSessionId || exec.agent.id !== document.semanticWriterSessionId) throw new Error("cannot apply a charter amendment: permission_denied (current controller/semantic writer required)");
        let frozen: FrozenCharterRevision;
        try {
          frozen = resolveFrozenCharter(charterEventsOf(exec.agent.session), args.frozenRef);
        } catch (error) {
          throw charterCommandError("read the frozen amendment", error);
        }
        if (frozen.baseTeamId !== team.teamId || frozen.baseCharterRevision !== document.currentCharterRevision) {
          throw new Error("cannot apply a charter amendment: stale_base (Team id or current charter revision differs)");
        }
        const currentRoleIds = new Set(team.roles.map((role) => role.id.toLowerCase()));
        const frozenRoleIds = new Set(frozen.topology.config.roles.map((role) => role.id.toLowerCase()));
        const pendingRoles = [...new Set([...team.roles.map((role) => role.id), ...frozen.topology.config.roles.map((role) => role.id)])].filter((roleId) => !currentRoleIds.has(roleId.toLowerCase()) || !frozenRoleIds.has(roleId.toLowerCase()));
        if (pendingRoles.length > 0) {
          return {
            status: "pending_runtime_actions",
            team_id: team.teamId,
            frozen_ref: frozen.frozenRef,
            current_charter_revision: document.currentCharterRevision ?? 0,
            target_charter_revision: frozen.charterRevision,
            pending_roles: pendingRoles,
            markdown_status: "unchanged",
            markdown_path: document.markdown.path,
            message: "topology roster differs from the current Team; no Session mapping was changed",
          };
        }
        let applied;
        try {
          applied = applyFrozenCharterRevision(document, team, frozen, exec.agent.id, Date.now());
        } catch (error) {
          throw documentCommandError("apply the charter amendment", error);
        }
        if (applied.kind === "noop") {
          const markdown = await inspectMarkdownProjection(ctx.fs, cwd, document, isRuntimeProjectionStale(document, team), exec.signal);
          return {
            status: "already_applied",
            team_id: team.teamId,
            frozen_ref: frozen.frozenRef,
            current_charter_revision: document.currentCharterRevision ?? 0,
            target_charter_revision: frozen.charterRevision,
            pending_roles: [],
            markdown_status: markdown.status,
            markdown_path: markdown.path,
          };
        }
        let nextDocument = applied.document;
        try {
          nextDocument = appendDriverDecision(nextDocument, team, {
            decisionId: `charter-amendment:${frozen.frozenRef}`,
            kind: "charter_amendment",
            summary: frozen.reason ?? `Applied charter revision ${frozen.charterRevision}`,
            actorSessionId: exec.agent.id,
            createdAt: Date.now(),
            evidence: [{ kind: "message", ref: frozen.approval.approvalRef }],
            affects: frozen.topology.config.roles.map((role) => role.id),
          }).document;
        } catch (error) {
          throw documentCommandError("record the charter amendment decision", error);
        }
        const persisted = await persistDocumentTransition(ctx, activeTeamState, observation, nextDocument, exec);
        return {
          status: persisted.markdown.status === "projection_failed" ? "projection_failed" : persisted.markdown.status === "stale" ? "stale" : "applied",
          team_id: team.teamId,
          frozen_ref: frozen.frozenRef,
          current_charter_revision: persisted.document.currentCharterRevision ?? 0,
          target_charter_revision: frozen.charterRevision,
          pending_roles: [],
          markdown_status: persisted.markdown.status,
          markdown_path: persisted.markdown.path,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_document",
      description:
        "Read the canonical Living Orchestration Document for the current Team. The structured document is authoritative; orchestration.md is a derived projection only and is never parsed as state. Legacy Teams report legacy_missing until the Driver explicitly reconciles them.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            team_id: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
            document_revision: { type: "number", required: true },
            charter_status: { type: "string", required: true },
            runtime_stale: { type: "boolean", required: true },
            current_charter_revision: { type: "number" },
            charter_digest: { type: "string" },
            approval_ref: { type: "string" },
            runtime_projection: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    teamId: { type: "string", required: true },
                    status: { type: "string", required: true },
                    controllerSessionId: { type: "string", required: true },
                    topologyRef: { type: "object", additionalProperties: true, required: true },
                    mission: { type: "object", additionalProperties: true, required: true },
                    roles: { type: "array", required: true },
                    reports: { type: "array", required: true },
                    activatedFromArchiveId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                    projectionAt: { type: "number", required: true },
                    graph: { type: "object", additionalProperties: true },
                  },
                },
                { type: "null" },
              ],
              required: true,
            },
            decisions: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  decisionId: { type: "string", required: true },
                  kind: { type: "string", required: true },
                  summary: { type: "string", required: true },
                  rationale: { type: "string" },
                  actorSessionId: { type: "string", required: true },
                  createdAt: { type: "number", required: true },
                  evidence: { type: "array", required: true },
                  affects: { type: "array" },
                },
              },
            },
            markdown: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                path: { type: "string", required: true },
                status: { type: "string", required: true },
                message: { type: "string" },
              },
            },
            diagnostic: {
              type: "object",
              additionalProperties: false,
              properties: {
                code: { type: "string", required: true },
                message: { type: "string", required: true },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `orchestration document ${value.status}${value.team_id === null ? "" : ` for ${value.team_id}`} (revision ${value.document_revision}, charter ${value.charter_status}, runtime ${value.runtime_stale ? "stale" : "current"}); Markdown ${value.markdown.status}`,
          },
        ],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_document requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        if (observation.kind === "blocked") {
          return documentToolStatus(undefined, undefined, undefined, {
            code: observation.diagnostic.code,
            message: observation.diagnostic.message,
          }) as any;
        }
        if (observation.kind !== "ready") return documentToolStatus(undefined, undefined, undefined) as any;
        const team = observation.team;
        const document = documentReadForTeam(team);
        if (document === undefined) return documentToolStatus(team, undefined, undefined) as any;
        const markdown = await inspectMarkdownProjection(ctx.fs, cwd, document, isRuntimeProjectionStale(document, team), exec.signal);
        return documentToolStatus(team, document, markdown) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_reconcile",
      description:
        "Driver-only checkpoint command: initialize a legacy Team's missing canonical document or reconcile its Runtime Projection from active Team state, using one ActiveTeamState CAS. Only after canonical CAS succeeds does it refresh the derived Markdown projection.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            team_id: { type: "string", required: true },
            document_revision: { type: "number", required: true },
            charter_status: { type: "string", required: true },
            runtime_stale: { type: "boolean", required: true },
            current_charter_revision: { type: "number" },
            charter_digest: { type: "string" },
            approval_ref: { type: "string" },
            runtime_projection: { type: "object", additionalProperties: true, required: true },
            decisions: { type: "array", required: true },
            markdown: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                path: { type: "string", required: true },
                status: { type: "string", required: true },
                message: { type: "string" },
              },
            },
            diagnostic: {
              type: "object",
              additionalProperties: false,
              properties: {
                code: { type: "string", required: true },
                message: { type: "string", required: true },
              },
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: `orchestration document ${value.status} for ${value.team_id} at revision ${value.document_revision}; Markdown ${value.markdown.status}` }],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_reconcile requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("reconcile the orchestration document", observation);
        if (observation.kind !== "ready") throw new Error(`cannot reconcile the orchestration document: no ready Team state (${observation.kind})`);
        const team = observation.team;
        if (exec.agent.id !== team.controllerSessionId) throw new Error("cannot reconcile the orchestration document: permission_denied (Driver/controller required)");
        let next: OrchestrationDocument;
        try {
          const current = documentReadForTeam(team);
          next = current === undefined
            ? initializeOrchestrationDocument(team, Date.now())
            : reconcileOrchestrationDocument(current, team, exec.agent.id, Date.now()).document;
        } catch (error) {
          throw documentCommandError("reconcile the orchestration document", error);
        }
        const persisted = await persistDocumentTransition(ctx, activeTeamState, observation, next, exec);
        return documentToolStatus(persisted.snapshot.team, persisted.document, persisted.markdown) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_decision",
      description:
        "Driver-only append to the canonical Driver Decision Journal. Entries are append-only and idempotent by decisionId; the operation is CAS-guarded and refreshes only the derived Markdown projection after canonical persistence.",
      parameters: {
        decisionId: { type: "string", required: true, description: "Stable id for this decision; retrying the same payload is a no-op." },
        kind: { type: "string", required: true, description: "Decision category, for example scope, route, review, or escalation." },
        summary: { type: "string", required: true, description: "Short decision summary." },
        rationale: { type: "string", description: "Optional rationale." },
        createdAt: { type: "number", description: "Optional finite timestamp; defaults to the current time." },
        evidence: {
          type: "array",
          description: "Evidence references; refs are recorded, not read.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true },
              ref: { type: "string", required: true },
              label: { type: "string" },
            },
          },
        },
        affects: { type: "array", items: { type: "string" }, description: "Optional affected role/decision summaries." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            team_id: { type: "string", required: true },
            document_revision: { type: "number", required: true },
            charter_status: { type: "string", required: true },
            runtime_stale: { type: "boolean", required: true },
            current_charter_revision: { type: "number" },
            charter_digest: { type: "string" },
            approval_ref: { type: "string" },
            runtime_projection: { type: "object", additionalProperties: true, required: true },
            decisions: { type: "array", required: true },
            markdown: {
              type: "object",
              additionalProperties: false,
              required: true,
              properties: {
                path: { type: "string", required: true },
                status: { type: "string", required: true },
                message: { type: "string" },
              },
            },
            diagnostic: {
              type: "object",
              additionalProperties: false,
              properties: {
                code: { type: "string", required: true },
                message: { type: "string", required: true },
              },
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: `orchestration decision ${value.status} for ${value.team_id}; document revision ${value.document_revision}; Markdown ${value.markdown.status}` }],
      },
      async execute(
        args: DecisionInput & { createdAt?: number },
        exec: ToolExecutionInput,
      ) {
        if (exec.agent === undefined) throw new Error("orchestra_decision requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("append a Driver decision", observation);
        if (observation.kind !== "ready") throw new Error(`cannot append a Driver decision: no ready Team state (${observation.kind})`);
        const team = observation.team;
        if (exec.agent.id !== team.controllerSessionId) throw new Error("cannot append a Driver decision: permission_denied (Driver/controller required)");
        const current = documentReadForTeam(team);
        if (current === undefined) throw new Error("cannot append a Driver decision: legacy_missing (run orchestra_reconcile first)");
        let command;
        try {
          const existing = current.decisions.find((entry) => entry.decisionId === args.decisionId);
          command = appendDriverDecision(current, team, {
            decisionId: args.decisionId,
            kind: args.kind,
            summary: args.summary,
            ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
            actorSessionId: exec.agent.id,
            createdAt: args.createdAt ?? existing?.createdAt ?? Date.now(),
            evidence: args.evidence,
            affects: args.affects,
          });
        } catch (error) {
          throw documentCommandError("append a Driver decision", error);
        }
        if (command.kind === "noop") {
          const markdown = await inspectMarkdownProjection(ctx.fs, cwd, current, isRuntimeProjectionStale(current, team), exec.signal);
          return documentToolStatus(team, current, markdown) as any;
        }
        const persisted = await persistDocumentTransition(ctx, activeTeamState, observation, command.document, exec);
        return documentToolStatus(persisted.snapshot.team, persisted.document, persisted.markdown) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_gate_open",
      description: "Driver-only open of a Human Gate declared by the current Frozen Charter. Gate scope/options/fallback are copied into append-only Graph facts; arbitrary runtime gates are rejected.",
      parameters: {
        gateId: { type: "string", required: true },
        gateInstanceId: { type: "string", required: true },
        evidence: { type: "array", items: { type: "json" } },
      },
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `gate open ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}` }],
      },
      async execute(args: { gateId: string; gateInstanceId: string; evidence?: unknown[] }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_gate_open requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("open a Human Gate", observation);
        if (observation.kind !== "ready") throw new Error(`cannot open a Human Gate: no ready Team (${observation.kind})`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot open a Human Gate: stale_charter");
        const frozen = currentFrozenCharter(team);
        const definition = frozen.topology.config.protocol?.gates?.find((gate) => gate.gateId === args.gateId);
        if (definition === undefined) throw new Error(`cannot open a Human Gate: gate ${args.gateId} is not declared by Frozen Charter`);
        let command;
        try {
          command = openGate(runtime, team, definition, { gateInstanceId: args.gateInstanceId, actorSessionId: exec.agent.id, now: Date.now(), humanMode: frozen.humanParticipationPolicy.mode, evidence: args.evidence as EvidenceRef[] | undefined });
        } catch (error) {
          throw graphCommandError("open a Human Gate", error);
        }
        const snapshot = command.kind === "noop" ? observation : await persistGraphTransition(ctx, activeTeamState, observation, command.runtime, exec);
        return graphToolOutput(snapshot.team, command.runtime, false) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_gate_fallback",
      description: "Driver-only explicit checkpoint fallback for a declared Human Gate. Before expiry it requires an explicit unavailable fact; it may only apply the pre-approved onUnavailable action and never invents a new option.",
      parameters: {
        gateInstanceId: { type: "string", required: true },
        unavailableConfirmed: { type: "boolean", required: true },
        reason: { type: "string", required: true },
        evidence: { type: "array", items: { type: "json" } },
      },
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `gate fallback ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}` }],
      },
      async execute(args: { gateInstanceId: string; unavailableConfirmed: boolean; reason: string; evidence?: unknown[] }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_gate_fallback requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("apply a Human Gate fallback", observation);
        if (observation.kind !== "ready") throw new Error(`cannot apply a Human Gate fallback: no ready Team (${observation.kind})`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot apply a Human Gate fallback: stale_charter");
        const frozen = currentFrozenCharter(team);
        const gate = graphGates(runtime).find((entry) => entry.gateInstanceId === args.gateInstanceId);
        if (gate === undefined) throw new Error(`cannot apply a Human Gate fallback: gate ${args.gateInstanceId} is unknown`);
        const definition = frozen.topology.config.protocol?.gates?.find((entry) => entry.gateId === gate.gateId);
        if (definition === undefined) throw new Error(`cannot apply a Human Gate fallback: definition ${gate.gateId} is missing`);
        let command;
        try {
          command = applyGateFallback(runtime, team, definition, { gateInstanceId: args.gateInstanceId, actorSessionId: exec.agent.id, now: Date.now(), unavailableConfirmed: args.unavailableConfirmed, reason: args.reason, evidence: args.evidence as EvidenceRef[] | undefined });
        } catch (error) {
          throw graphCommandError("apply a Human Gate fallback", error);
        }
        const snapshot = command.kind === "noop" ? observation : await persistGraphTransition(ctx, activeTeamState, observation, command.runtime, exec);
        return graphToolOutput(snapshot.team, command.runtime, false) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_graph",
      description: "Read the current Frozen-Charter-bound execution DAG summary: bounded Loops/attempts, pending typed handoffs, cap exhaustion, runtime revision, and stale status. It never dumps or mutates the event log.",
      parameters: {},
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `graph ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}, pending handoffs=${value.pending_handoffs.length}, cap exhausted=${value.cap_exhausted.length}` }],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_graph requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("read the graph runtime", observation);
        if (observation.kind !== "ready") throw new Error(`cannot read the graph runtime: ${observation.kind}`);
        const { runtime, stale } = currentGraphRuntime(observation.team);
        return graphToolOutput(observation.team, runtime, stale) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_loop_start",
      description: "Driver-only start of a Loop declared by the current Frozen Charter. The loop contract, evaluator, participants, exits, hard cap, and required evidence are resolved from the frozen snapshot.",
      parameters: {
        loopId: { type: "string", required: true },
        loopInstanceId: { type: "string" },
        evidence: { type: "array", items: { type: "json" } },
      },
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `loop start ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}` }],
      },
      async execute(args: { loopId: string; loopInstanceId?: string; evidence?: unknown[] }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_loop_start requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("start a Loop", observation);
        if (observation.kind !== "ready") throw new Error(`cannot start a Loop: no ready Team (${observation.kind})`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot start a Loop: stale_charter (reconcile or create a new runtime branch after amendment)");
        const frozen = currentFrozenCharter(team);
        const contract = frozen.topology.config.protocol?.loops?.find((loop) => loop.loopId === args.loopId);
        if (contract === undefined) throw new Error(`cannot start a Loop: loop ${args.loopId} is not declared by Frozen Charter ${frozen.frozenRef}`);
        let command;
        try {
          command = startLoop(runtime, team, contract, { actorSessionId: exec.agent.id, loopInstanceId: args.loopInstanceId, now: Date.now(), evidence: args.evidence as EvidenceRef[] | undefined });
        } catch (error) {
          throw graphCommandError("start a Loop", error);
        }
        const snapshot = command.kind === "noop" ? observation : await persistGraphTransition(ctx, activeTeamState, observation, command.runtime, exec);
        return graphToolOutput(snapshot.team, command.runtime, false) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_attempt_start",
      description: "Start the next continuous attempt of a declared bounded Loop. Attempt number is derived from immutable graph history; a participant or Driver may start it, but cap/passed/blocked Loops cannot retry.",
      parameters: {
        loopInstanceId: { type: "string", required: true },
        participantRoleId: { type: "string", required: true },
        candidate: { type: "json" },
        evidence: { type: "array", items: { type: "json" } },
      },
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `attempt start ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}` }],
      },
      async execute(args: { loopInstanceId: string; participantRoleId: string; candidate?: unknown; evidence?: unknown[] }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_attempt_start requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("start a Loop attempt", observation);
        if (observation.kind !== "ready") throw new Error(`cannot start a Loop attempt: no ready Team (${observation.kind})`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot start a Loop attempt: stale_charter");
        const loop = graphLoops(runtime).find((entry) => entry.loopInstanceId === args.loopInstanceId);
        if (loop === undefined) throw new Error(`cannot start a Loop attempt: Loop ${args.loopInstanceId} was not found`);
        const frozen = currentFrozenCharter(team);
        const contract = frozen.topology.config.protocol?.loops?.find((entry) => entry.loopId === loop.loopId);
        if (contract === undefined) throw new Error(`cannot start a Loop attempt: contract ${loop.loopId} is missing from the current Frozen Charter`);
        let command;
        try {
          command = startAttempt(runtime, team, contract, { loopInstanceId: args.loopInstanceId, actorSessionId: exec.agent.id, participantRoleId: args.participantRoleId, candidate: args.candidate as Record<string, unknown> | undefined, now: Date.now(), evidence: args.evidence as EvidenceRef[] | undefined });
        } catch (error) {
          throw graphCommandError("start a Loop attempt", error);
        }
        const snapshot = command.kind === "noop" ? observation : await persistGraphTransition(ctx, activeTeamState, observation, command.runtime, exec);
        return graphToolOutput(snapshot.team, command.runtime, false) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_verdict",
      description: "Record PASS/FAIL/BLOCKED only from the declared evaluator's current active Session. PASS closes the Loop; FAIL below cap permits a later attempt; FAIL at cap emits cap_exhausted; BLOCKED does not silently retry.",
      parameters: {
        loopInstanceId: { type: "string", required: true },
        verdict: { type: "string", enum: ["PASS", "FAIL", "BLOCKED"], required: true },
        findings: { type: "array", items: { type: "string" } },
        evidence: { type: "array", items: { type: "json" } },
      },
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `verdict ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}` }],
      },
      async execute(args: { loopInstanceId: string; verdict: "PASS" | "FAIL" | "BLOCKED"; findings?: string[]; evidence?: unknown[] }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_verdict requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("record a Loop verdict", observation);
        if (observation.kind !== "ready") throw new Error(`cannot record a Loop verdict: no ready Team (${observation.kind})`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot record a Loop verdict: stale_charter");
        const loop = graphLoops(runtime).find((entry) => entry.loopInstanceId === args.loopInstanceId);
        if (loop === undefined) throw new Error(`cannot record a Loop verdict: Loop ${args.loopInstanceId} was not found`);
        const frozen = currentFrozenCharter(team);
        const contract = frozen.topology.config.protocol?.loops?.find((entry) => entry.loopId === loop.loopId);
        if (contract === undefined) throw new Error(`cannot record a Loop verdict: contract ${loop.loopId} is missing from the current Frozen Charter`);
        let command;
        try {
          command = recordVerdict(runtime, team, contract, { loopInstanceId: args.loopInstanceId, actorSessionId: exec.agent.id, evaluatorRole: contract.evaluatorRole, verdict: args.verdict, findings: args.findings, now: Date.now(), evidence: args.evidence as EvidenceRef[] | undefined });
        } catch (error) {
          throw graphCommandError("record a Loop verdict", error);
        }
        const snapshot = command.kind === "noop" ? observation : await persistGraphTransition(ctx, activeTeamState, observation, command.runtime, exec);
        return graphToolOutput(snapshot.team, command.runtime, false) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_graph_reconcile",
      description: "Driver-only graph checkpoint. Initializes a missing graph runtime for a Frozen Team; an existing runtime bound to an older charter is reported stale and is never silently migrated.",
      parameters: {},
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `graph reconcile ${value.team_id}: ${value.status}, runtime revision ${value.runtime_revision}` }],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_graph_reconcile requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("reconcile the graph runtime", observation);
        if (observation.kind !== "ready") throw new Error(`cannot reconcile the graph runtime: no ready Team (${observation.kind})`);
        const team = observation.team;
        if (exec.agent.id !== team.controllerSessionId) throw new Error("cannot reconcile the graph runtime: permission_denied (Driver/controller required)");
        const frozen = currentFrozenCharter(team);
        if (team.graphRuntime === undefined) {
          const runtime = initializeGraphRuntime(team.teamId, frozen.charterRevision, frozen.digest, Date.now());
          const snapshot = await persistGraphTransition(ctx, activeTeamState, observation, runtime, exec);
          return graphToolOutput(snapshot.team, runtime, false) as any;
        }
        const read = readGraphRuntime(team.graphRuntime, team.teamId, frozen.charterRevision, frozen.digest);
        if (read.kind === "blocked") throw new Error(`cannot reconcile the graph runtime: ${read.diagnostic.code}: ${read.diagnostic.message}`);
        if (read.kind === "stale") throw new Error("cannot reconcile the graph runtime: stale_charter (start a new runtime branch in a later checkpoint)");
        if (read.kind === "legacy_missing") throw new Error("cannot reconcile the graph runtime: legacy_missing");
        let runtime = read.runtime;
        let snapshot = observation;
        for (const pending of graphHandoffs(runtime).filter((handoff) => handoff.status === "pending")) {
          if (pending.targetSessionId === undefined) continue;
          const receipt = await readDeliveryReceipt(ctx, pending.targetSessionId, pending.handoffId);
          if (receipt === undefined) continue;
          const accepted = appendHandoffResult(runtime, snapshot.team, { handoffId: pending.handoffId, actorSessionId: exec.agent.id, accepted: true, receipt: receipt as unknown as Record<string, unknown>, now: Date.now() });
          if (accepted.kind === "noop") continue;
          try {
            snapshot = await persistGraphTransition(ctx, activeTeamState, snapshot, accepted.runtime, exec);
            runtime = accepted.runtime;
          } catch (error) {
            throw graphCommandError("reconcile an accepted typed handoff", error);
          }
        }
        return graphToolOutput(snapshot.team, runtime, false) as any;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_handoff",
      description: "Send a route-aware typed milestone through the same A2A Transport while recording a CAS-guarded Graph pending/accepted/failed transaction. Ordinary a2a_send/orchestra_send remain untyped and unaffected. Reusing handoffId never enqueues a duplicate.",
      parameters: {
        handoffId: { type: "string", required: true, description: "Stable idempotency key for this typed handoff." },
        kind: { type: "string", required: true },
        fromRole: { type: "string", required: true },
        toRole: { type: "string", required: true },
        loopInstanceId: { type: "string" },
        attempt: { type: "number" },
        summary: { type: "string", required: true },
        payload: { type: "json" },
        evidence: { type: "array", items: { type: "json" } },
        wake: { type: "boolean" },
        interrupt: { type: "boolean" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            handoff_id: { type: "string", required: true },
            team_id: { type: "string", required: true },
            from_role: { type: "string", required: true },
            to_role: { type: "string", required: true },
            resolved_session_id: { type: "string", required: true },
            runtime_revision: { type: "number", required: true },
            receipt: { type: "json" },
            error: { type: "string" },
            reconcile_required: { type: "boolean" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `handoff ${value.handoff_id} ${value.status}: ${value.from_role} → ${value.to_role}${value.reconcile_required ? " (reconcile required)" : ""}` }],
      },
      async execute(args: { handoffId: string; kind: string; fromRole: string; toRole: string; loopInstanceId?: string; attempt?: number; summary: string; payload?: unknown; evidence?: unknown[]; wake?: boolean; interrupt?: boolean }, exec: ToolExecutionInput): Promise<any> {
        if (exec.agent === undefined) throw new Error("orchestra_handoff requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("send a typed handoff", observation);
        if (observation.kind !== "ready") throw new Error(`cannot send a typed handoff: no ready Team (${observation.kind})`);
        if (observation.team.status !== "active" && observation.team.status !== "degraded") throw new Error(`cannot send a typed handoff while Team status is ${observation.team.status}`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot send a typed handoff: stale_charter (runtime is bound to an older Frozen Charter)");
        const frozen = currentFrozenCharter(team);
        const controllerRoleId = frozen.topology.config.controller?.id ?? "driver";
        const contract = frozen.topology.config.protocol?.handoffs?.find((entry) => entry.kind === args.kind);
        if (contract === undefined) throw new Error(`cannot send a typed handoff: route ${args.kind} is not declared by Frozen Charter ${frozen.frozenRef}`);
        const payload = jsonRecord(args.payload) ? { ...args.payload, summary: args.summary } : { summary: args.summary };
        let pendingCommand;
        try {
          pendingCommand = appendHandoffPending(runtime, team, contract, {
            handoffId: args.handoffId,
            kind: args.kind,
            fromRole: args.fromRole,
            toRole: args.toRole,
            loopInstanceId: args.loopInstanceId,
            attempt: args.attempt,
            summary: args.summary,
            payload,
            actorSessionId: exec.agent.id,
            now: Date.now(),
            evidence: args.evidence as EvidenceRef[] | undefined,
            controllerRoleId,
          });
        } catch (error) {
          throw graphCommandError("prepare a typed handoff", error);
        }
        let pendingSnapshot = observation;
        let pendingRuntime = runtime;
        const existing = graphHandoffs(runtime).find((handoff) => handoff.handoffId === args.handoffId);
        if (pendingCommand.kind === "changed") {
          pendingRuntime = pendingCommand.runtime;
          try {
            pendingSnapshot = await persistGraphTransition(ctx, activeTeamState, observation, pendingRuntime, exec);
          } catch (error) {
            throw graphCommandError("reserve a typed handoff", error);
          }
        } else if (existing?.status === "accepted" || existing?.status === "failed") {
          return {
            status: existing.status,
            handoff_id: existing.handoffId,
            team_id: team.teamId,
            from_role: existing.fromRole,
            to_role: existing.toRole,
            resolved_session_id: resolveHandoffTarget(team, existing.toRole, controllerRoleId).sessionId,
            runtime_revision: runtime.runtimeRevision,
            ...(existing.receipt === undefined ? {} : { receipt: existing.receipt }),
            ...(existing.error === undefined ? {} : { error: existing.error }),
          };
        }
        const pendingFact = graphHandoffs(pendingRuntime).find((handoff) => handoff.handoffId === args.handoffId);
        if (pendingFact === undefined) throw new Error("typed handoff pending fact could not be reconstructed");
        const targetSessionId = resolveHandoffTarget(team, pendingFact.toRole, controllerRoleId).sessionId;
        let receipt: Record<string, unknown>;
        try {
          receipt = await deliverMessage(ctx, exec.agent.id, targetSessionId, [{ type: "text", text: JSON.stringify({ type: "orchestra_handoff", handoff_id: args.handoffId, kind: args.kind, summary: args.summary, payload, evidence: args.evidence ?? [] }) }], { wake: args.wake, interrupt: args.interrupt, idempotencyKey: args.handoffId }) as any;
        } catch (error) {
          try {
            const failed = appendHandoffResult(pendingRuntime, pendingSnapshot.team, { handoffId: args.handoffId, actorSessionId: exec.agent.id, accepted: false, error: error instanceof Error ? error.message : String(error), now: Date.now() });
            const failedSnapshot = await persistGraphTransition(ctx, activeTeamState, pendingSnapshot, failed.runtime, exec);
            return { status: "failed", handoff_id: args.handoffId, team_id: team.teamId, from_role: pendingFact.fromRole, to_role: pendingFact.toRole, resolved_session_id: targetSessionId, runtime_revision: failedSnapshot.team.graphRuntime?.runtimeRevision ?? failed.runtime.runtimeRevision, error: error instanceof Error ? error.message : String(error) };
          } catch (stateError) {
            return { status: "delivery_failed_state_pending", handoff_id: args.handoffId, team_id: team.teamId, from_role: pendingFact.fromRole, to_role: pendingFact.toRole, resolved_session_id: targetSessionId, runtime_revision: pendingRuntime.runtimeRevision, error: error instanceof Error ? error.message : String(error), reconcile_required: true };
          }
        }
        try {
          const accepted = appendHandoffResult(pendingRuntime, pendingSnapshot.team, { handoffId: args.handoffId, actorSessionId: exec.agent.id, accepted: true, receipt, now: Date.now() });
          const acceptedSnapshot = await persistGraphTransition(ctx, activeTeamState, pendingSnapshot, accepted.runtime, exec);
          return { status: "accepted", handoff_id: args.handoffId, team_id: team.teamId, from_role: pendingFact.fromRole, to_role: pendingFact.toRole, resolved_session_id: targetSessionId, runtime_revision: acceptedSnapshot.team.graphRuntime?.runtimeRevision ?? accepted.runtime.runtimeRevision, receipt };
        } catch (error) {
          return { status: "delivery_accepted_state_pending", handoff_id: args.handoffId, team_id: team.teamId, from_role: pendingFact.fromRole, to_role: pendingFact.toRole, resolved_session_id: targetSessionId, runtime_revision: pendingRuntime.runtimeRevision, receipt, reconcile_required: true };
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_close",
      description: "Request semantic terminal closure under the Frozen Charter's single closure owner. Machine-checks loops, verdicts, evidence, handoffs, and required Human Gates; terminal closure blocks further Graph mutation and is required before dismissing a Frozen Team.",
      parameters: {
        outcome: { type: "string", enum: ["completed", "failed", "abandoned"], required: true },
        reason: { type: "string" },
        evidence: { type: "array", items: { type: "json" } },
      },
      output: {
        schema: graphOutputSchema,
        render: (_args, value) => [{ type: "text", text: `closure ${value.team_id}: ${value.status}, outcome=${value.closure?.outcome ?? "rejected"}` }],
      },
      async execute(args: { outcome: "completed" | "failed" | "abandoned"; reason?: string; evidence?: unknown[] }, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_close requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const observation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("close the Team", observation);
        if (observation.kind !== "ready") throw new Error(`cannot close the Team: no ready Team (${observation.kind})`);
        const team = observation.team;
        const { runtime, stale } = currentGraphRuntime(team);
        if (stale) throw new Error("cannot close the Team: stale_charter");
        const definition = currentClosureDefinition(team);
        let command;
        try {
          command = recordClosure(runtime, team, definition, { outcome: args.outcome, actorSessionId: exec.agent.id, reason: args.reason, now: Date.now(), evidence: args.evidence as EvidenceRef[] | undefined });
        } catch (error) {
          throw graphCommandError("close the Team", error);
        }
        if (command.kind === "noop") return graphToolOutput(team, runtime, false) as any;
        const terminalStatus: TeamState["status"] | undefined = command.accepted ? args.outcome === "completed" ? "completed" : args.outcome === "abandoned" ? "abandoned" : "failed" : undefined;
        const snapshot = await persistGraphTransition(ctx, activeTeamState, observation, command.runtime, exec, terminalStatus);
        if (!command.accepted) throw new Error(`closure rejected: ${command.diagnostic ?? "requirements not satisfied"}`);
        return graphToolOutput(snapshot.team, command.runtime, false) as any;
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
                    document_status: { type: "string" },
                    document_revision: { type: "number" },
                    document_stale: { type: "boolean" },
                    current_charter_revision: { type: "number" },
                    charter_digest: { type: "string" },
                    approval_ref: { type: "string" },
                    graph_status: { type: "string" },
                    graph_runtime_revision: { type: "number" },
                    graph_stale: { type: "boolean" },
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
          return [
            {
              type: "text",
              text: `team ${value.team.team_id} (${value.team.topology}, ${value.team.status}): ${value.team.roles
                .map((r) => `${r.id}(${r.status},R${r.reportCount}${r.lastReport === null ? "" : `, report=${r.lastReport}`}${r.lastActivity === undefined ? "" : `, last="${r.lastActivity}"`})`)
                .join(", ")} | archives: ${archiveText}`,
            },
          ];
        },
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_team requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const teamObservation = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("inspect the team", teamObservation);
        const archiveList = await archiveStore.list(cwd, { signal: exec.signal });
        const archives = archiveListForTeamTool(archiveList);
        if (teamObservation.kind !== "ready") return { team: null, archives };
        const team = teamObservation.team;
        const document = documentReadForTeam(team);
        const documentSummaryValue = documentSummary(document, team);
        const graphStale = document?.currentCharterRevision !== null && document?.currentCharterRevision !== undefined && document.charterRevisions.find((revision) => revision.charterRevision === document.currentCharterRevision)?.digest !== team.graphRuntime?.charterDigest;
        const graph = team.graphRuntime === undefined ? undefined : graphSummary(team.graphRuntime, graphStale || document?.runtimeProjection.graph?.stale === true);
        return {
          team: {
            team_id: team.teamId,
            status: team.status,
            goal: team.mission.objective,
            topology: team.topologyRef.id,
            controller_session_id: team.controllerSessionId,
            created_at: team.createdAt,
            activated_from_archive_id: team.activatedFromArchiveId,
            roles: await Promise.all(team.roles.map((role) => roleStatus(ctx, role))),
            reports: team.reports,
            document_status: documentSummaryValue.status,
            document_revision: documentSummaryValue.revision,
            document_stale: documentSummaryValue.stale,
            ...(documentSummaryValue.currentCharterRevision === undefined ? {} : { current_charter_revision: documentSummaryValue.currentCharterRevision }),
            ...(documentSummaryValue.currentCharterDigest === undefined ? {} : { charter_digest: documentSummaryValue.currentCharterDigest }),
            ...(documentSummaryValue.approvalRef === undefined ? {} : { approval_ref: documentSummaryValue.approvalRef }),
            ...(graph === undefined ? {} : { graph_status: graph.status, graph_runtime_revision: graph.runtimeRevision, graph_stale: graph.stale }),
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
        const results: {
          role_id: string;
          session_id: string;
          action: string;
          replaced_session_id?: string;
        }[] = [];
        let degraded = false;
        const activationNotice = "The team has been reactivated. You remain under your role discipline: stop/continue as instructed — wait for driver dispatch before starting new work.";
        for (const role of newTeam.roles) {
          const agent = ctx.agents.get(SID(role.sessionId));
          if (agent !== undefined) {
            // Step 5a: live → reused
            await sendRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, activationNotice);
            results.push({ role_id: role.id, session_id: role.sessionId, action: "reused" });
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
              const presetFile =
                role.preset === null ? undefined : await resolvePresetFile(ctx, cwd, role.preset);
              const roleModel = role.model;
              const created = await createSession(ctx, {
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
              await sendRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, recoveryPacket);
              results.push({ role_id: role.id, session_id: created.sessionId, action: "replaced", replaced_session_id: oldSessionId });
            } catch (error) {
              degraded = true;
              results.push({
                role_id: role.id,
                session_id: role.sessionId,
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
            await ctx.agents.resume({
              resumeSessionId: SID(role.sessionId),
              agentOptions,
              ...(setup === undefined ? {} : { setup }),
              ...(exec.signal === undefined ? {} : { signal: exec.signal }),
            });
            await sendRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, activationNotice);
            results.push({ role_id: role.id, session_id: role.sessionId, action: "resumed" });
          } catch (error) {
            degraded = true;
            results.push({
              role_id: role.id,
              session_id: role.sessionId,
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
          team_id: newTeam.teamId,
          archive_id: archived.archiveId,
          status: newTeam.status,
          roles: results,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_dismiss",
      description:
        "Close the current orchestra instance: publish an immutable archive, CAS the active state into an archived marker, then notify every live role session that the team is archived (stop waiting for new tasks). Role sessions are independent assets and stay alive. Requires an instance created by orchestra_create or orchestra_spawn in this working directory.",
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
        if (team.document?.charterStatus === "frozen") {
          const graph = currentGraphRuntime(team);
          if (graph.stale || graphClosure(graph.runtime).status !== "recorded") throw new Error("cannot dismiss a Frozen Team before terminal closure; run orchestra_close with an allowed outcome first");
        }
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
          if (role !== undefined) {
            role.reportCount = (role.reportCount ?? 0) + 1;
            role.lastReport = canonical;
            team.reports.push({
              reportId: `report-${randomUUID().slice(0, 8)}`,
              roleId: role.id,
              sessionId: agentId,
              path: canonical,
              createdAt: Date.now(),
            });
            await activeTeamState.replace(teamObservation, team, {
              policy: escrowPolicy(ctx, exec),
              signal: exec.signal,
            });
          }
        }
        return { path: canonical };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_topologies",
      description:
        "List available topology templates (spec §4.1): project templates under <cwd>/.orchestra/topologies/*.json, global templates under ~/.dsh/orchestra/topologies/*.json, plus the bundled fallback (duo/trio/oracle/four-role-dev). Each entry shows source, controller, protocol (ownership/routes/completion), and roles. Use a snapshot in orchestra_draft before approval/freeze; direct orchestra_spawn roster mutation is approval-gated and fails closed in 4B.",
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
                          : `${t.id} (${t.source})${t.description === undefined ? "" : `: ${t.description}`} [roles: ${t.roles.map((r) => r.id).join(", ")}]`,
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
                  const roles = await Promise.all(
                    team.roles.map(async (record) => {
                      const status = await roleStatus(ctx, record);
                      return {
                        id: status.id,
                        name: status.name,
                        sessionId: status.sessionId,
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
  ctx.on("internal/service", (name) => {
    if ((WEB_SERVER_KEYS as readonly string[]).includes(name) || name === "workspaceRegistry") {
      registerWebSurface();
    }
  });

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text:
        "Orchestra: you are the team driver — the role that starts a team toward a goal and owns decisions. When the user says /team or expresses intent to open a team / collaborate / delegate, follow the FIXED onboarding protocol below (do not skip steps 4-5):\n" +
        "1. Goal: ask the user to state the goal — what \"done\" looks like. One topology run completes one goal; a clear goal defines when to stop.\n" +
        "2. Constraints: ask about limits/constraints (time, quality, boundaries). Merge into the same round when possible.\n" +
        "3. Context: read the project context relevant to the goal (files, docs) to ground your understanding.\n" +
        "4. Proposal: call orchestra_draft to persist the exact mission/topology/human-policy Draft in your Session events, then report its draftId@revision and digest to the user. The proposal report MUST include a per-role roster card straight from orchestra_draft's role_blueprint_preview: for every role, its preset id, sandbox, permission preset, model provider/model, reasoningEffort, and compositionTools/orchestraTools, so the user can verify each role's configuration before approving. A proposal IS a collaboration charter (编排 = 协作宪章): it must answer who does what; who owns each decision; routes and handoffs; escalation; round limits; and closure.\n" +
        "5. Approval: proposal text or natural-language \"可以/放行\" is NOT approval. Tell the user to run the exact command /team approve <draftId>@<revision>; only the durable user-command approval event permits orchestra_freeze. Until that command succeeds, do NOT freeze or create/spawn any Governed role session.\n" +
        "6. Freeze and execute: after the approval command, call orchestra_freeze with the exact digest, then orchestra_create with frozenRef; for active Teams use orchestra_draft → user command → orchestra_freeze → orchestra_apply_amendment. Dispatch Governed roles via orchestra_send(teamId+roleId); use raw a2a_send only for explicit free SessionId communication.\n" +
        "Dispatch tightness: dispatch every spawned role's task immediately — in the same round, or the round right after spawning. Never leave a spawned role taskless (a spawn-to-dispatch vacuum makes roles start working on their own).\n" +
        "Parallelism discipline: parallelize everything that CAN run in parallel (dispatch independent tasks together in one round; never serialize independent work) but NEVER parallelize anything that would BLOCK or conflict (dependency-aware: wait for that specific signal — orchestra_team / a2a_read / report path — before dispatching, and declare the dependency explicitly in the task).\n" +
        "No filler messages: creation injects the welcome; injection IS the confirmation. Do NOT send extra confirmation/ack messages after a role is created or a delivery is confirmed — they pile up in the target's inbox (queue buildup). To check session state use orchestra_team (activity, reportCount, lastReport) or a2a_read (history) — never send a message to ask. Dispatch each task once; use interrupt:true only when a message must surface mid-turn.\n" +
        "Lightweight mode: for one-off collaboration (check a session, ask a question, read history) use the A2A tools directly (a2a_list/a2a_send/a2a_reply/a2a_read/a2a_status) — no team needed. Governed role dispatch uses orchestra_send so replacement mappings remain current.\n" +
        "Stay in your role: you are the driver, not an implementer or a reviewer. Never fix, polish, or take over any role's work — implementation issues loop back to the implementer (via the implementer-reviewer flow), review findings go to the reviewer. Your job is decisions, dispatch, and coordination, not edits.\n" +
        "Deterministic routing (no mindless relaying): you are NOT an information hub. Messages inside a fixed flow go directly between roles — never through you. Example flow: implementer finishes and hands the result directly to reviewer; reviewer finds issues and sends them directly back to implementer for another round; reviewer's targeted re-check passes and THEN reviewer notifies you to advance. You only receive decision points: advances, blockers, new directions, cross-flow coordination. Do not forward what you do not need to know. Roles may call orchestra_team themselves to check team progress (team transparency).\n" +
        "All created roles are told to reply to you (their driver) via a2a_reply, never directly to the user; users interact with roles only through you. Track progress with orchestra_team; inspect the canonical Living Orchestration Document with orchestra_document; at a Driver checkpoint use orchestra_reconcile for runtime projection and orchestra_decision for append-only decisions. For Frozen-Charter execution use orchestra_graph/orchestra_loop_start/orchestra_attempt_start/orchestra_verdict and route milestones through orchestra_handoff; a cap_exhausted Loop has no next attempt in this checkpoint. Roles may read the document but only the Driver may mutate it. Recover after restart or after dismissal with orchestra_activate (archive_id required — list archives via orchestra_team); close the instance with orchestra_dismiss (archives the team, notifies roles, frees the cwd); list templates with orchestra_topologies.\n" +
        "Review flow: to task a reviewer, send via orchestra_send using teamId+roleId a review_request message stating scope, changed locations, and the goal; fix findings one by one; at most two rounds (R2 only re-checks R1 findings); stop after R2 regardless of outcome; new issues go to the backlog for the user to decide. Read handoff reports (paths returned by roles) under orchestra/reports/. All cross-role messages must be self-contained.\n" +
        "Delivery contract: a raw a2a_send/a2a_reply receipt state=accepted means the Transport accepted the message, not that it was claimed or answered; use a2a_status for proven lifecycle facts. orchestra_send adds the resolved teamId/roleId mapping but has the same accepted-only semantics.\n" +
        "Concurrency discipline (avoid information blocking): you are the bottleneck — every role report lands in your context. Minimize fan-in: ask roles to return concise summaries plus report paths, not full dumps; read report files only when needed. Do not over-orchestrate: if one session can do the job, do not spawn roles.",
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
