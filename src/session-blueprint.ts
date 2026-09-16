/**
 * Complete lightweight Session Blueprint seam.
 *
 * The module resolves the preset/permission/model facts before creation,
 * composes or joins the agent inside setup, writes the durable lightweight
 * marker before publication, and returns a commit hook that verifies the
 * composed scope and visible tools immediately before the agent factory
 * publishes the Session/Agent pair.
 */

import type { Context } from "@deepseek-ai/cordis";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { installModelSelection, type Agent, type AgentOptions, type AgentSetupCommit } from "@deepseek-ai/dsh-agent";
import { mountPreset } from "@deepseek-ai/dsh-agent-presets";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { parseRecordJson, readRecordText, resolveRecordFileSystem, safeSegment, writeRecordJson, type RecordFileSystem } from "./orchestra-records.js";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-session-title";

export const LIGHTWEIGHT_BLUEPRINT_SCHEMA_VERSION = 1;
export const GOVERNED_BLUEPRINT_SCHEMA_VERSION = 1;

/*
 * These were the Session event types `orchestra/blueprint` and
 * `orchestra/governed-blueprint`. They are deliberately NOT kept as constants:
 * nothing writes or reads them any more, and a constant nothing consumes is a
 * claim that something might. The composition marker is a file now
 * (`docs/adr/0002`), and `scripts/check-session-readable.mjs` names the old
 * literals where that matters.
 */

/** Directory (relative to the role session's cwd) holding one marker per session. */
export const BLUEPRINT_DIRECTORY = "orchestra/blueprints";

export interface LightweightBlueprintMarker {
  schemaVersion: 1;
  mode: "lightweight";
  agentPreset: string;
  presetSource?: "file" | "dsh";
  presetPath?: string;
  presetTrust?: "system" | "user";
  permissionPreset: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  cwd?: string;
  title?: string;
  createdBySessionId: string;
  createdAt: number;
}

export interface GovernedBlueprintMarker {
  schemaVersion: 1;
  mode: "governed";
  teamId: string;
  roleId: string;
  topologyId: string;
  topologySource: "project" | "global" | "bundled";
  controllerSessionId: string;
  agentPreset: string;
  presetSource?: "file" | "dsh";
  presetPath?: string;
  presetTrust?: "system" | "user";
  permissionPreset: string;
  effectivePermissionPreset: string;
  approval: string;
  sandbox: SandboxMode;
  provider: string;
  model: string;
  reasoningEffort?: string;
  cwd: string;
  title?: string;
  compositionTools?: string[];
  orchestraTools?: string[];
  optionalCapabilities?: string[];
  createdAt: number;
}

export interface BlueprintPresetFile {
  id: string;
  trust: "system" | "user";
  path: string;
}

export interface LightweightBlueprintInput {
  sessionId: string;
  caller?: Agent;
  createdBySessionId?: string;
  cwd?: string;
  presetId?: string;
  presetFile?: BlueprintPresetFile;
  permissionPreset?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  title?: string;
  requiredTools?: string[];
  signal?: AbortSignal;
}

export interface LightweightToolReadiness {
  names: string[];
  count: number;
}

export interface LightweightBlueprintReceipt {
  mode: "lightweight";
  sessionId: string;
  cwd?: string;
  agentPreset: string;
  permissionPreset: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  title?: string;
  tools: LightweightToolReadiness;
}

export interface GovernedBlueprintInput {
  sessionId: string;
  teamId: string;
  roleId: string;
  roleName: string;
  topologyId: string;
  topologySource: "project" | "global" | "bundled";
  controllerSessionId: string;
  cwd: string;
  title?: string;
  presetId?: string;
  presetFile?: BlueprintPresetFile;
  permissionPreset?: string;
  sandbox?: SandboxMode;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  runtime?: { provider?: string; model?: string; reasoningEffort?: string };
  compositionTools?: string[];
  orchestraTools?: string[];
  optionalCapabilities?: string[];
  requiredTools?: string[];
  signal?: AbortSignal;
}

export interface GovernedBlueprintReceipt {
  mode: "governed";
  sessionId: string;
  teamId: string;
  roleId: string;
  topologyId: string;
  topologySource: "project" | "global" | "bundled";
  controllerSessionId: string;
  cwd: string;
  title?: string;
  agentPreset: string;
  permissionPreset: string;
  effectivePermissionPreset: string;
  approval: string;
  sandbox: SandboxMode;
  provider: string;
  model: string;
  reasoningEffort?: string;
  compositionTools: LightweightToolReadiness;
  orchestraTools: LightweightToolReadiness;
  optionalCapabilities: string[];
  tools: LightweightToolReadiness;
}

export interface PreparedLightweightBlueprint {
  readonly receipt: LightweightBlueprintReceipt;
  readonly agentOptions: AgentOptions;
  readonly meta: { cwd?: string; agentPreset: string };
  /**
   * Composition window callback. DSH's `AgentSetup` contract passes the
   * prepared, still-unpublished Agent as the SECOND argument, and during
   * that window it is the only carrier of the child's Session: the sessions
   * service registers a Session only at publication. `agentCtx.agent` is not
   * a declared service and reading it throws where the framework does not set
   * the property, so the agent is taken from the parameter.
   */
  readonly setup: (agentCtx: Context, agent: Agent) => Promise<AgentSetupCommit>;
}

export interface PreparedGovernedBlueprint {
  readonly receipt: GovernedBlueprintReceipt;
  readonly agentOptions: AgentOptions;
  readonly meta: { cwd: string; agentPreset: string };
  /**
   * Composition window callback. DSH's `AgentSetup` contract passes the
   * prepared, still-unpublished Agent as the SECOND argument, and during
   * that window it is the only carrier of the child's Session: the sessions
   * service registers a Session only at publication. `agentCtx.agent` is not
   * a declared service and reading it throws where the framework does not set
   * the property, so the agent is taken from the parameter.
   */
  readonly setup: (agentCtx: Context, agent: Agent) => Promise<AgentSetupCommit>;
}

export type BlueprintErrorCode =
  | "invalid_input"
  | "preset_unavailable"
  | "permission_unavailable"
  | "permission_mismatch"
  | "model_unavailable"
  | "required_tools_unproven"
  | "required_tools_missing"
  | "composition_tools_unproven"
  | "composition_tools_missing"
  | "orchestra_tools_unproven"
  | "orchestra_tools_missing"
  | "composition_mismatch"
  | "session_unavailable";

export class SessionBlueprintError extends Error {
  readonly code: BlueprintErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BlueprintErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionBlueprintError";
    this.code = code;
    this.details = details;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function presetUnavailable(presetId: string, source: "explicit" | "default" | "file", operation: string, error: unknown, details?: Record<string, unknown>): SessionBlueprintError {
  const reason = error instanceof Error ? error.message : String(error);
  return new SessionBlueprintError(
    "preset_unavailable",
    `agent preset "${presetId}" could not be ${operation}: ${reason}`,
    { presetId, source, ...details },
    error,
  );
}

async function resolvePresetOrThrow<T extends { resolve(id?: string): Promise<{ id: string }> }>(presets: T, id: string, source: "explicit" | "default"): Promise<{ id: string }> {
  try {
    return await presets.resolve(id);
  } catch (error) {
    throw presetUnavailable(id, source, "resolved", error);
  }
}

function sessionFrom(ctx: Context, agentCtx: Context, sessionId: string, prepared?: Agent): Session | undefined {
  // The agent factory runs setup on the prepared (unpublished) agent's ctx, so
  // the agent — and its session — are already constructed while the sessions
  // service registers the session only at publish. The prepared agent therefore
  // comes from the setup PARAMETER (`AgentSetup = (agentCtx, agent) => …`).
  //
  // `agentCtx.agent` is NOT a declared service on any DSH context (dsh-agent
  // publishes `ctx.agents`, the registry, not `ctx.agent`), so reading it where
  // the framework set no such property throws Cordis's "cannot get property
  // "agent" without inject" instead of yielding undefined. It is still probed
  // as a fallback for embedders that do set it, but a throw must not escape.
  const candidates: (Agent | undefined)[] = [prepared];
  try {
    candidates.push((agentCtx as { agent?: Agent }).agent);
  } catch {
    // This context carries no `agent` property; the parameter or the service decides.
  }
  for (const candidate of candidates) {
    if (candidate?.session !== undefined && candidate.session.id === sessionId) return candidate.session;
  }
  const scopedSessions = agentCtx.get("sessions");
  const session = scopedSessions?.get(sessionId as never);
  if (session !== undefined) return session;
  return ctx.get("sessions")?.get(sessionId as never);
}

/**
 * The session's sandbox-mode override, or `undefined` when it carries none —
 * in which case the deployment default applies.
 *
 * DSH 0.1.5-rc.2 removed the `effectiveSandboxMode(events)` export; the
 * documented read path is now the `sandboxMode` session projection, whose fold
 * is "the LAST `sandbox/mode` event wins". This helper performs that same fold
 * directly over the live log, so a blueprint commit can verify what it just
 * wrote without depending on a projection service being mounted in scope.
 *
 * @param session - the session whose override is read.
 * @returns the winning mode, or `undefined` without an override.
 */
function sandboxOverrideOf(session: Session): SandboxMode | undefined {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "sandbox/mode") return event.data.mode;
  }
  return undefined;
}

function currentModel(ctx: Context, caller: Agent | undefined): { provider: string; model: string; reasoningEffort?: string } {
  if (caller?.options.provider !== undefined && caller.options.model !== undefined) {
    return {
      provider: caller.options.provider,
      model: caller.options.model,
    };
  }
  const service = ctx.get("agentDefaultModel");
  if (service === undefined) throw new SessionBlueprintError("model_unavailable", "agentDefaultModel service is unavailable");
  const selection = service.currentSelection();
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
  };
}

function explicitModel(input: LightweightBlueprintInput): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const hasProvider = input.provider !== undefined;
  const hasModel = input.model !== undefined;
  if (hasProvider !== hasModel) {
    throw new SessionBlueprintError("invalid_input", "provider and model must be provided together");
  }
  if (input.reasoningEffort !== undefined && (!hasProvider || !hasModel)) {
    throw new SessionBlueprintError("invalid_input", "reasoningEffort requires provider and model");
  }
  if (!hasProvider || !hasModel) return undefined;
  return {
    provider: input.provider as string,
    model: input.model as string,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
  };
}

function requiredTools(input: { requiredTools?: string[] }): string[] {
  const names = input.requiredTools ?? [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name === "")) {
    throw new SessionBlueprintError("invalid_input", "requiredTools must be an array of non-empty strings");
  }
  return [...new Set(names)];
}

export const REMOVED_ORCHESTRA_TOOLS = new Set([
  "orchestra_handoff",
  "orchestra_verdict",
  "orchestra_loop_start",
  "orchestra_attempt_start",
  "orchestra_gate_open",
  "orchestra_gate_fallback",
  "orchestra_close",
  "orchestra_graph",
  "orchestra_graph_reconcile",
  "orchestra_document",
  "orchestra_reconcile",
  "orchestra_decision",
  "orchestra_charters",
  "orchestra_apply_amendment",
  "orchestra_freeze",
  "orchestra_draft_revise",
  "orchestra_draft_retract",
]);

function capabilityTools(input: { requiredTools?: string[]; compositionTools?: string[]; orchestraTools?: string[] }): {
  legacy: string[];
  composition: string[];
  orchestra: string[];
  all: string[];
} {
  const legacy = requiredTools(input);
  const compositionInput = input.compositionTools ?? [];
  const orchestraInput = input.orchestraTools ?? [];
  for (const [label, values] of [["compositionTools", compositionInput], ["orchestraTools", orchestraInput] as const]) {
    if (!Array.isArray(values) || values.some((name) => typeof name !== "string" || name === "")) {
      throw new SessionBlueprintError("invalid_input", label + " must be an array of non-empty strings");
    }
  }
  const composition = [...new Set([...legacy, ...compositionInput])];
  const orchestra = [...new Set(orchestraInput.filter((name) => !REMOVED_ORCHESTRA_TOOLS.has(name)))];
  return { legacy, composition, orchestra, all: [...new Set([...composition, ...orchestra])] };
}

const COMPOSITION_ROW_TOOLS: Record<string, string[]> = {
  "tool-bash": ["bash", "tool-bash"],
  "tool-fs": ["read", "write", "edit", "read_image", "tool-fs"],
  "tool-fs-search": ["glob", "grep", "tool-fs-search"],
  "tool-todo": ["todo", "tool-todo"],
  "tool-skill": ["skill", "tool-skill"],
};

function hasCompositionTool(visibleNames: readonly string[], requiredRow: string): boolean {
  if (visibleNames.includes(requiredRow)) return true;
  const aliases = COMPOSITION_ROW_TOOLS[requiredRow];
  return aliases !== undefined && aliases.some((alias) => visibleNames.includes(alias));
}

function toolReadiness(names: readonly string[], required: readonly string[]): LightweightToolReadiness {
  const selected = [...new Set(required)].filter((name) => hasCompositionTool(names, name)).sort();
  return { names: selected, count: selected.length };
}

/**
 * Non-publishing capability gate for Governed provisioning.
 *
 * The legacy requiredTools field remains a compatibility alias for
 * compositionTools. New role plans carry the two capability planes explicitly:
 * catalog composition proof for DSH rows and host-scope proof for Orchestra tools.
 */
export function preflightGovernedRequiredTools(input: {
  requiredTools?: string[];
  compositionTools?: string[];
  orchestraTools?: string[];
  presetId?: string;
  presetFile?: BlueprintPresetFile;
  rolePresetSpec?: { compositionTools: string[]; orchestraTools: string[] };
  staticCompositionTools?: string[];
  hostToolNames?: string[];
}): void {
  const capabilities = capabilityTools(input);
  const source = input.presetFile?.path ?? input.presetId ?? "explicit preset";
  if (capabilities.legacy.length > 0 && input.compositionTools === undefined && input.orchestraTools === undefined) {
    throw new SessionBlueprintError(
      "required_tools_unproven",
      "required governed tools cannot be proven before Agent publication for " + source + "; reservation was not attempted",
      { required: capabilities.legacy, source, plane: "legacy-required-tools" },
    );
  }
  if (capabilities.composition.length > 0) {
    const declared = input.rolePresetSpec?.compositionTools ?? input.staticCompositionTools;
    if (declared === undefined) {
      throw new SessionBlueprintError(
        "composition_tools_unproven",
        "compositionTools cannot be proven before Agent publication for " + source + "; a catalog spec or static composition proof is required",
        { required: capabilities.composition, source, plane: "composition" },
      );
    }
    const missing = capabilities.composition.filter((name) => !declared.includes(name));
    if (missing.length > 0) {
      throw new SessionBlueprintError(
        "composition_tools_missing",
        "catalog composition does not declare required compositionTools: " + missing.join(", "),
        { missing, declared, source, plane: "composition" },
      );
    }
  }
  if (capabilities.orchestra.length > 0) {
    const hostNames = input.hostToolNames ?? [];
    if (hostNames.length === 0) {
      throw new SessionBlueprintError(
        "orchestra_tools_unproven",
        "orchestraTools cannot be proven in the host/plugin scope before Agent publication for " + source,
        { required: capabilities.orchestra, source, plane: "orchestra" },
      );
    }
    const missing = capabilities.orchestra.filter((name) => !hostNames.includes(name));
    if (missing.length > 0) {
      throw new SessionBlueprintError(
        "orchestra_tools_missing",
        "required Orchestra host tools are not visible before reservation: " + missing.join(", "),
        { missing, visible: hostNames, source, plane: "orchestra" },
      );
    }
  }
}


function visibleToolNames(agentCtx: Context): string[] {
  const tools = agentCtx.get("tools");
  if (tools === undefined) return [];
  const schemas = tools.schemas(scopeOf(agentCtx)) as ToolSchema[];
  return [...new Set(schemas.map((schema) => schema.name))].sort();
}

export function hostToolNamesForPreflight(ctx: Context): string[] {
  try {
    return visibleToolNames(ctx);
  } catch {
    const tools = ctx.get("tools");
    if (tools === undefined) return [];
    try {
      const schemas = tools.schemas() as ToolSchema[];
      return [...new Set(schemas.map((schema) => schema.name))].sort();
    } catch {
      return [];
    }
  }
}

export async function prepareLightweightBlueprint(ctx: Context, input: LightweightBlueprintInput): Promise<PreparedLightweightBlueprint> {
  const sessionId = asString(input.sessionId);
  if (sessionId === undefined) throw new SessionBlueprintError("invalid_input", "sessionId must be non-empty");
  const createdBySessionId = asString(input.createdBySessionId) ?? asString(input.caller?.id);
  if (createdBySessionId === undefined) throw new SessionBlueprintError("invalid_input", "createdBySessionId is required for a lightweight Session");
  const presets = ctx.get("agentPresets");
  if (presets === undefined) throw new SessionBlueprintError("preset_unavailable", "agentPresets service is unavailable");
  const permissions = ctx.get("permissionPresets");
  if (permissions === undefined) throw new SessionBlueprintError("permission_unavailable", "permissionPresets service is unavailable");

  let agentPreset: string;
  let presetStrategy: "file" | "explicit" | "inherit" | "default";
  let resolvedPreset: { id: string } | undefined;
  if (input.presetFile !== undefined) {
    if (typeof input.presetFile.path !== "string" || input.presetFile.path === "") throw new SessionBlueprintError("preset_unavailable", "lightweight presetFile path must be non-empty");
    agentPreset = input.presetFile.id;
    presetStrategy = "file";
  } else if (asString(input.presetId) !== undefined) {
    const resolved = await resolvePresetOrThrow(presets, input.presetId as string, "explicit");
    agentPreset = resolved.id;
    resolvedPreset = resolved;
    presetStrategy = "explicit";
  } else {
    const callerPreset = input.caller === undefined ? undefined : presets.composedPreset(input.caller.ctx);
    if (callerPreset !== undefined) {
      agentPreset = callerPreset;
      presetStrategy = "inherit";
    } else {
      const defaultId = asString(presets.defaultId);
      if (defaultId === undefined) throw new SessionBlueprintError("preset_unavailable", "agentPresets has no default preset for a rosterless caller");
      const resolved = await resolvePresetOrThrow(presets, defaultId, "default");
      agentPreset = resolved.id;
      resolvedPreset = resolved;
      presetStrategy = "default";
    }
  }

  const permissionPreset = asString(input.permissionPreset) ?? permissions.defaultPreset;
  if (permissionPreset === undefined) throw new SessionBlueprintError("permission_unavailable", "permissionPresets has no default preset");
  try {
    permissions.resolve(permissionPreset);
  } catch (error) {
    throw new SessionBlueprintError("permission_unavailable", `permission preset "${permissionPreset}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }

  const model = explicitModel(input) ?? currentModel(ctx, input.caller);
  if (model.provider === "" || model.model === "") throw new SessionBlueprintError("model_unavailable", "provider and model must be non-empty");
  const required = requiredTools(input);
  const marker: LightweightBlueprintMarker = {
    schemaVersion: LIGHTWEIGHT_BLUEPRINT_SCHEMA_VERSION,
    mode: "lightweight",
    agentPreset,
    ...(input.presetFile === undefined
      ? { presetSource: "dsh" as const }
      : { presetSource: "file" as const, presetPath: input.presetFile.path, presetTrust: input.presetFile.trust }),
    permissionPreset,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.title === undefined ? {} : { title: input.title }),
    createdBySessionId,
    createdAt: Date.now(),
  };
  const readiness: LightweightToolReadiness = { names: [], count: 0 };
  const receipt: LightweightBlueprintReceipt = {
    mode: "lightweight",
    sessionId,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    agentPreset,
    ...(input.presetFile === undefined
      ? { presetSource: "dsh" as const }
      : { presetSource: "file" as const, presetPath: input.presetFile.path, presetTrust: input.presetFile.trust }),
    permissionPreset,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(input.title === undefined ? {} : { title: input.title }),
    tools: readiness,
  };
  const agentOptions: AgentOptions = { provider: model.provider, model: model.model };

  const setup = async (agentCtx: Context, agent: Agent): Promise<AgentSetupCommit> => {
    const agentPresets = agentCtx.get("agentPresets") ?? presets;
    if (presetStrategy === "file") {
      try {
        await mountPreset(agentCtx, input.presetFile as BlueprintPresetFile);
      } catch (error) {
        throw presetUnavailable(agentPreset, "file", "mounted", error, { path: input.presetFile?.path });
      }
    } else if (presetStrategy === "inherit") {
      if (input.caller === undefined) throw new SessionBlueprintError("composition_mismatch", "inherit strategy has no caller agent");
      const joined = agentPresets.composeFrom(agentCtx, input.caller.ctx);
      if (joined !== agentPreset) throw new SessionBlueprintError("composition_mismatch", `caller composition joined "${String(joined)}", expected "${agentPreset}"`);
    } else {
      await agentPresets.mount(agentCtx, resolvedPreset?.id ?? agentPreset);
    }
    installModelSelection(agentCtx, {
      current: {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }),
      },
      assembled: undefined,
    });
    const session = sessionFrom(ctx, agentCtx, sessionId, agent);
    if (session === undefined) throw new SessionBlueprintError("session_unavailable", `unpublished session ${sessionId} is not visible during blueprint setup`);
    const permissionService = agentCtx.get("permissionPresets") ?? permissions;
    permissionService.set(session, permissionPreset);
    if (input.title !== undefined && input.title !== "") {
      session.append("session/title", { title: input.title, messageSeqs: [], source: { kind: "user" } });
    }
    // The marker records HOW this session was composed, so a cold resume can
    // rebuild it. It used to be a Session event, which made the session itself
    // unreadable after a restart (docs/adr/0002); it is now a file beside the
    // other plugin records.
    const blueprintPolicy = (ctx as any).sandboxPolicy?.resolve?.({ session: session as any, mode: "workspace-write" });
    await blueprintStoreFor(ctx, marker.cwd ?? session.header.cwd).write(input.sessionId, marker, { policy: blueprintPolicy });
    return {
      commit() {
        // file strategy mounts the preset tree directly into the agent scope
        // (mountPreset already awaited the tree and validated its rows and
        // services), which by design records no standing parent — so
        // composedPreset is undefined. Only the roster strategies (explicit /
        // default) are expected to resolve a composed preset id here.
        const actualPreset = agentPresets.composedPreset(agentCtx);
        if (presetStrategy !== "file" && actualPreset !== agentPreset) throw new SessionBlueprintError("composition_mismatch", `published composition "${String(actualPreset)}" does not match blueprint "${agentPreset}"`);
        const actualPermission = permissionService.current(session);
        if (actualPermission !== permissionPreset) throw new SessionBlueprintError("permission_mismatch", `published permission "${actualPermission}" does not match blueprint "${permissionPreset}"`);
        const names = visibleToolNames(agentCtx);
        const missing = required.filter((name) => !names.includes(name));
        if (missing.length > 0) throw new SessionBlueprintError("required_tools_missing", `required tools are not visible in the composed scope: ${missing.join(", ")}`, { missing, visible: names });
        readiness.names = names;
        readiness.count = names.length;
      },
    };
  };

  return {
    receipt,
    agentOptions,
    meta: { ...(input.cwd === undefined ? {} : { cwd: input.cwd }), agentPreset },
    setup,
  };
}

export interface GovernedModelInput {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  runtime?: { provider?: string; model?: string; reasoningEffort?: string };
}

/**
 * Model selection for a Governed role, shared by provisioning and draft-time
 * pre-parsing so the proposal card shows exactly what create will pin.
 */
export function resolveDraftRoleModel(ctx: Context, input: GovernedModelInput): { provider: string; model: string; reasoningEffort?: string } {
  return governedModel(ctx, input);
}

function governedModel(ctx: Context, input: GovernedModelInput): { provider: string; model: string; reasoningEffort?: string } {
  const explicit = input.provider !== undefined || input.model !== undefined || input.reasoningEffort !== undefined;
  if (explicit) {
    if (typeof input.provider !== "string" || typeof input.model !== "string" || input.provider === "" || input.model === "") {
      throw new SessionBlueprintError("invalid_input", "governed provider and model must be provided together as non-empty strings");
    }
    if (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== "string" || input.reasoningEffort === "")) {
      throw new SessionBlueprintError("invalid_input", "governed reasoningEffort must be a non-empty string when provided");
    }
    return {
      provider: input.provider,
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    };
  }

  const runtime = input.runtime;
  if (runtime !== undefined) {
    const hasProvider = runtime.provider !== undefined;
    const hasModel = runtime.model !== undefined;
    if ((hasProvider && typeof runtime.provider !== "string") || (hasModel && typeof runtime.model !== "string") || (runtime.reasoningEffort !== undefined && typeof runtime.reasoningEffort !== "string")) {
      throw new SessionBlueprintError("invalid_input", "topology runtime model selection fields must be strings");
    }
    if (hasProvider !== hasModel) throw new SessionBlueprintError("invalid_input", "topology runtime provider and model must be provided together");
    if (runtime.reasoningEffort !== undefined && (!hasProvider || !hasModel)) {
      throw new SessionBlueprintError("invalid_input", "topology runtime reasoningEffort requires provider and model");
    }
    if (runtime.reasoningEffort === "") throw new SessionBlueprintError("invalid_input", "topology runtime reasoningEffort must be non-empty");
    if (hasProvider && hasModel) {
      if (runtime.provider === "" || runtime.model === "") throw new SessionBlueprintError("invalid_input", "topology runtime provider and model must be non-empty");
      return {
        provider: runtime.provider as string,
        model: runtime.model as string,
        ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
      };
    }
  }

  const service = ctx.get("agentDefaultModel");
  if (service === undefined) throw new SessionBlueprintError("model_unavailable", "agentDefaultModel service is unavailable for governed role");
  const selection = service.currentSelection();
  if (typeof selection.provider !== "string" || selection.provider === "" || typeof selection.model !== "string" || selection.model === "") {
    throw new SessionBlueprintError("model_unavailable", "deployment default model selection is incomplete for governed role");
  }
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
  };
}

function governedIdentity(input: GovernedBlueprintInput): void {
  for (const [name, value] of Object.entries({
    sessionId: input.sessionId,
    teamId: input.teamId,
    roleId: input.roleId,
    roleName: input.roleName,
    topologyId: input.topologyId,
    controllerSessionId: input.controllerSessionId,
    cwd: input.cwd,
  })) {
    if (typeof value !== "string" || value === "") throw new SessionBlueprintError("invalid_input", `governed ${name} must be non-empty`);
  }
  if (input.topologySource !== "project" && input.topologySource !== "global" && input.topologySource !== "bundled") {
    throw new SessionBlueprintError("invalid_input", "governed topologySource is invalid");
  }
  if (input.title !== undefined && typeof input.title !== "string") throw new SessionBlueprintError("invalid_input", "governed title must be a string");
  if (input.sandbox !== undefined && input.sandbox !== "read-only" && input.sandbox !== "workspace-write" && input.sandbox !== "danger-full-access") {
    throw new SessionBlueprintError("invalid_input", `governed sandbox mode "${String(input.sandbox)}" is invalid`);
  }
}

/** Prepare one fully identified Governed role; setup is the only publication-side effect. */
export async function prepareGovernedBlueprint(ctx: Context, input: GovernedBlueprintInput): Promise<PreparedGovernedBlueprint> {
  governedIdentity(input);
  const presets = ctx.get("agentPresets");
  if (presets === undefined) throw new SessionBlueprintError("preset_unavailable", "agentPresets service is unavailable for governed role");
  const permissions = ctx.get("permissionPresets");
  if (permissions === undefined) throw new SessionBlueprintError("permission_unavailable", "permissionPresets service is unavailable for governed role");

  let agentPreset: string;
  let presetStrategy: "file" | "explicit";
  let resolvedPreset: { id: string } | undefined;
  if (input.presetFile !== undefined) {
    if (typeof input.presetFile.id !== "string" || input.presetFile.id === "") throw new SessionBlueprintError("preset_unavailable", "governed presetFile id must be non-empty");
    if (typeof input.presetFile.path !== "string" || input.presetFile.path === "") throw new SessionBlueprintError("preset_unavailable", "governed presetFile path must be non-empty");
    agentPreset = input.presetFile.id;
    presetStrategy = "file";
  } else if (asString(input.presetId) !== undefined) {
    const resolved = await resolvePresetOrThrow(presets, input.presetId as string, "explicit");
    agentPreset = resolved.id;
    resolvedPreset = resolved;
    presetStrategy = "explicit";
  } else {
    throw new SessionBlueprintError("preset_unavailable", `governed role "${input.roleId}" requires an explicit Agent Preset`);
  }

  const permissionPreset = asString(input.permissionPreset) ?? permissions.defaultPreset;
  if (permissionPreset === undefined) throw new SessionBlueprintError("permission_unavailable", "permissionPresets has no default preset for governed role");
  let permissionSpec: { sandbox: SandboxMode; approval: string };
  try {
    permissionSpec = permissions.resolve(permissionPreset);
  } catch (error) {
    throw new SessionBlueprintError("permission_unavailable", `permission preset "${permissionPreset}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`, { permissionPreset }, error);
  }
  if (typeof permissionSpec.approval !== "string" || permissionSpec.approval === "") {
    throw new SessionBlueprintError("permission_unavailable", `permission preset "${permissionPreset}" has no usable approval policy`);
  }
  const sandbox = input.sandbox ?? permissionSpec.sandbox;
  if (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") {
    throw new SessionBlueprintError("invalid_input", `governed effective sandbox "${String(sandbox)}" is invalid`);
  }
  const model = governedModel(ctx, input);
  const capabilities = capabilityTools(input);
  const predictedEffectivePermission = sandbox === permissionSpec.sandbox ? permissionPreset : "custom";
  const readiness: LightweightToolReadiness = { names: [], count: 0 };
  const compositionReadiness: LightweightToolReadiness = { names: [], count: 0 };
  const orchestraReadiness: LightweightToolReadiness = { names: [], count: 0 };
  const receipt: GovernedBlueprintReceipt = {
    mode: "governed",
    sessionId: input.sessionId,
    teamId: input.teamId,
    roleId: input.roleId,
    topologyId: input.topologyId,
    topologySource: input.topologySource,
    controllerSessionId: input.controllerSessionId,
    cwd: input.cwd,
    ...(input.title === undefined ? {} : { title: input.title }),
    agentPreset,
    permissionPreset,
    effectivePermissionPreset: predictedEffectivePermission,
    approval: permissionSpec.approval,
    sandbox,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    compositionTools: compositionReadiness,
    orchestraTools: orchestraReadiness,
    optionalCapabilities: input.optionalCapabilities ?? [],
    tools: readiness,
  };
  const agentOptions: AgentOptions = { provider: model.provider, model: model.model };

  const setup = async (agentCtx: Context, agent: Agent): Promise<AgentSetupCommit> => {
    const agentPresets = agentCtx.get("agentPresets") ?? presets;
    if (presetStrategy === "file") {
      try {
        await mountPreset(agentCtx, input.presetFile as BlueprintPresetFile);
      } catch (error) {
        throw presetUnavailable(agentPreset, "file", "mounted", error, { path: input.presetFile?.path, roleId: input.roleId });
      }
    } else {
      await agentPresets.mount(agentCtx, resolvedPreset?.id ?? agentPreset);
    }
    installModelSelection(agentCtx, {
      current: {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }),
      },
      assembled: undefined,
    });
    const session = sessionFrom(ctx, agentCtx, input.sessionId, agent);
    if (session === undefined) throw new SessionBlueprintError("session_unavailable", `unpublished governed session ${input.sessionId} is not visible during blueprint setup`);
    const permissionService = agentCtx.get("permissionPresets") ?? permissions;
    permissionService.set(session, permissionPreset);
    setSandboxMode(session, sandbox);
    const effectivePermissionPreset = permissionService.current(session);
    const effectiveSandbox = sandboxOverrideOf(session) ?? sandbox;
    if (effectiveSandbox !== sandbox) throw new SessionBlueprintError("permission_mismatch", `governed sandbox resolved to "${String(effectiveSandbox)}", expected "${sandbox}"`);
    receipt.effectivePermissionPreset = effectivePermissionPreset;
    if (input.title !== undefined && input.title !== "") {
      session.append("session/title", { title: input.title, messageSeqs: [], source: { kind: "user" } });
    }
    const marker: GovernedBlueprintMarker = {
      schemaVersion: GOVERNED_BLUEPRINT_SCHEMA_VERSION,
      mode: "governed",
      teamId: input.teamId,
      roleId: input.roleId,
      topologyId: input.topologyId,
      topologySource: input.topologySource,
      controllerSessionId: input.controllerSessionId,
      agentPreset,
      ...(input.presetFile === undefined
        ? { presetSource: "dsh" as const }
        : { presetSource: "file" as const, presetPath: input.presetFile.path, presetTrust: input.presetFile.trust }),
      permissionPreset,
      effectivePermissionPreset,
      approval: permissionSpec.approval,
      sandbox,
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      cwd: input.cwd,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(capabilities.composition.length === 0 ? {} : { compositionTools: capabilities.composition }),
      ...(capabilities.orchestra.length === 0 ? {} : { orchestraTools: capabilities.orchestra }),
      ...(input.optionalCapabilities === undefined ? {} : { optionalCapabilities: [...input.optionalCapabilities] }),
      createdAt: Date.now(),
    };
    const blueprintPolicy = (ctx as any).sandboxPolicy?.resolve?.({ session: session as any, mode: "workspace-write" });
    await blueprintStoreFor(ctx, marker.cwd ?? session.header.cwd).write(input.sessionId, marker, { policy: blueprintPolicy });
    return {
      commit() {
        // See the lightweight commit: the file strategy (catalog presets,
        // outside the roster roots) mounts directly into the agent scope and
        // records no standing parent, so composedPreset is undefined there.
        const actualPreset = agentPresets.composedPreset(agentCtx);
        if (presetStrategy !== "file" && actualPreset !== agentPreset) throw new SessionBlueprintError("composition_mismatch", `published governed composition "${String(actualPreset)}" does not match blueprint "${agentPreset}"`);
        const actualPermission = permissionService.current(session);
        if (actualPermission !== effectivePermissionPreset) throw new SessionBlueprintError("permission_mismatch", `published governed permission "${actualPermission}" does not match blueprint "${effectivePermissionPreset}"`);
        const actualSandbox = sandboxOverrideOf(session);
        if (actualSandbox !== sandbox) throw new SessionBlueprintError("permission_mismatch", `published governed sandbox "${String(actualSandbox)}" does not match blueprint "${sandbox}"`);
        const names = visibleToolNames(agentCtx);
        const legacyOnly = capabilities.legacy.length > 0 && input.compositionTools === undefined && input.orchestraTools === undefined;
        const missingLegacy = capabilities.legacy.filter((name) => !names.includes(name));
        if (legacyOnly && missingLegacy.length > 0) {
          throw new SessionBlueprintError("required_tools_missing", "required governed tools are not visible in the composed scope: " + missingLegacy.join(", "), { missing: missingLegacy, visible: names, roleId: input.roleId });
        }
        const missingComposition = (legacyOnly ? [] : capabilities.composition).filter((name) => !hasCompositionTool(names, name));
        if (missingComposition.length > 0) {
          throw new SessionBlueprintError("composition_tools_missing", "required composition tools are not visible in the composed scope: " + missingComposition.join(", "), { missing: missingComposition, visible: names, roleId: input.roleId, plane: "composition" });
        }
        const missingOrchestra = capabilities.orchestra.filter((name) => !names.includes(name));
        if (missingOrchestra.length > 0) {
          throw new SessionBlueprintError("orchestra_tools_missing", "required Orchestra host tools are not visible in the composed scope: " + missingOrchestra.join(", "), { missing: missingOrchestra, visible: names, roleId: input.roleId, plane: "orchestra" });
        }
        readiness.names = names;
        readiness.count = names.length;
        compositionReadiness.names = toolReadiness(names, capabilities.composition).names;
        compositionReadiness.count = compositionReadiness.names.length;
        orchestraReadiness.names = toolReadiness(names, capabilities.orchestra).names;
        orchestraReadiness.count = orchestraReadiness.names.length;
      },
    };
  };

  return { receipt, agentOptions, meta: { cwd: input.cwd, agentPreset }, setup };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const GOVERNED_IDENTITY_FIELDS = [
  "teamId",
  "roleId",
  "topologyId",
  "team",
  "role",
  "roles",
  "topology",
  "topologyRef",
] as const;

/**
 * Validate one stored lightweight marker without inventing facts for old data.
 *
 * A record that fails validation is reported as `undefined` — "this file does
 * not describe a lightweight session" — which is the pre-existing contract and
 * lets a caller fall back to the header's own preset projection. Malformed JSON
 * is NOT swallowed here: that is caught by the store, which fails loudly, so a
 * truncated file cannot masquerade as "no marker".
 */
export function parseLightweightBlueprint(value: unknown): LightweightBlueprintMarker | undefined {
  try {
    const marker = value as Record<string, unknown> & { data?: unknown };
    if (!isPlainObject(marker)) return undefined;
    if (marker.schemaVersion !== LIGHTWEIGHT_BLUEPRINT_SCHEMA_VERSION || marker.mode !== "lightweight") return undefined;
    if (!nonEmptyString(marker.agentPreset) || !nonEmptyString(marker.permissionPreset) || !nonEmptyString(marker.provider) || !nonEmptyString(marker.model) || !nonEmptyString(marker.createdBySessionId)) return undefined;
    if (typeof marker.createdAt !== "number" || !Number.isFinite(marker.createdAt)) return undefined;
    if (("reasoningEffort" in marker && typeof marker.reasoningEffort !== "string") || ("cwd" in marker && typeof marker.cwd !== "string") || ("title" in marker && typeof marker.title !== "string")) return undefined;
    if (marker.presetSource !== undefined && marker.presetSource !== "file" && marker.presetSource !== "dsh") return undefined;
    if (marker.presetSource === "file" && (!nonEmptyString(marker.presetPath) || (marker.presetTrust !== "system" && marker.presetTrust !== "user"))) return undefined;
    if (marker.presetPath !== undefined && typeof marker.presetPath !== "string") return undefined;
    if (marker.presetTrust !== undefined && marker.presetTrust !== "system" && marker.presetTrust !== "user") return undefined;
    if (GOVERNED_IDENTITY_FIELDS.some((field) => field in marker)) return undefined;
    return marker as unknown as LightweightBlueprintMarker;
  } catch {
    return undefined;
  }
}

/** Read Governed identity/facts without treating malformed durable data as a live role. */
export function parseGovernedBlueprint(value: unknown): GovernedBlueprintMarker | undefined {
  try {
    const marker = value as Record<string, unknown> & { data?: unknown };
    if (!isPlainObject(marker)) return undefined;
    if (marker.schemaVersion !== GOVERNED_BLUEPRINT_SCHEMA_VERSION || marker.mode !== "governed") return undefined;
    if (!nonEmptyString(marker.teamId) || !nonEmptyString(marker.roleId) || !nonEmptyString(marker.topologyId) || !nonEmptyString(marker.controllerSessionId)) return undefined;
    if (!nonEmptyString(marker.agentPreset) || !nonEmptyString(marker.permissionPreset) || !nonEmptyString(marker.effectivePermissionPreset) || !nonEmptyString(marker.approval)) return undefined;
    if (marker.topologySource !== "project" && marker.topologySource !== "global" && marker.topologySource !== "bundled") return undefined;
    if (marker.sandbox !== "read-only" && marker.sandbox !== "workspace-write" && marker.sandbox !== "danger-full-access") return undefined;
    if (!nonEmptyString(marker.provider) || !nonEmptyString(marker.model)) return undefined;
    if (typeof marker.createdAt !== "number" || !Number.isFinite(marker.createdAt)) return undefined;
    if (!nonEmptyString(marker.cwd)) return undefined;
    if (("reasoningEffort" in marker && typeof marker.reasoningEffort !== "string") || ("title" in marker && typeof marker.title !== "string")) return undefined;
    if (marker.presetSource !== undefined && marker.presetSource !== "file" && marker.presetSource !== "dsh") return undefined;
    if (marker.presetSource === "file" && (!nonEmptyString(marker.presetPath) || (marker.presetTrust !== "system" && marker.presetTrust !== "user"))) return undefined;
    if (marker.presetPath !== undefined && typeof marker.presetPath !== "string") return undefined;
    if (marker.presetTrust !== undefined && marker.presetTrust !== "system" && marker.presetTrust !== "user") return undefined;
    if (marker.compositionTools !== undefined && (!Array.isArray(marker.compositionTools) || marker.compositionTools.some((name) => typeof name !== "string" || name === ""))) return undefined;
    if (marker.orchestraTools !== undefined && (!Array.isArray(marker.orchestraTools) || marker.orchestraTools.some((name) => typeof name !== "string" || name === ""))) return undefined;
    if (marker.optionalCapabilities !== undefined && (!Array.isArray(marker.optionalCapabilities) || marker.optionalCapabilities.some((name) => typeof name !== "string" || name === ""))) return undefined;
    if ("createdBySessionId" in marker || "topology" in marker || "roles" in marker) return undefined;
    return marker as unknown as GovernedBlueprintMarker;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Either composition marker, as stored. */
export type BlueprintMarker = LightweightBlueprintMarker | GovernedBlueprintMarker;

/**
 * Where a session's composition marker lives.
 *
 * Keyed by session id under the session's own cwd, because that is what a cold
 * resume has in hand: the persisted header gives the id and the cwd, and nothing
 * else about the session is readable without waking it.
 */
export interface BlueprintWriteOptions {
  policy?: unknown;
  signal?: AbortSignal;
}

export interface BlueprintStore {
  read(sessionId: string): Promise<BlueprintMarker | undefined>;
  write(sessionId: string, marker: BlueprintMarker, options?: BlueprintWriteOptions): Promise<void>;
}

/** Process-local markers: the fallback when no `fs` service is composed. */
export function createMemoryBlueprintStore(): BlueprintStore {
  const records = new Map<string, BlueprintMarker>();
  return {
    async read(sessionId) {
      return records.get(sessionId);
    },
    async write(sessionId, marker) {
      records.set(sessionId, marker);
    },
  };
}

/** File-backed markers under `<cwd>/orchestra/blueprints/`. */
export function createFsBlueprintStore(fs: RecordFileSystem, cwd: string): BlueprintStore {
  const pathOf = (sessionId: string): string => `${BLUEPRINT_DIRECTORY}/${safeSegment(sessionId, "session id")}.json`;
  return {
    async read(sessionId) {
      const relative = pathOf(sessionId);
      const found = await readRecordText(fs, relative, cwd);
      if (found === undefined) return undefined;
      const value = parseRecordJson(found.text, relative);
      // Shape failures answer "no marker" (the pre-existing contract, so a caller
      // can still fall back); a syntax failure already threw above.
      const record = value as { mode?: unknown };
      return record?.mode === "governed" ? parseGovernedBlueprint(value) : parseLightweightBlueprint(value);
    },
    async write(sessionId, marker, options) {
      // A session is composed once. If a marker already exists for this id the
      // id is being reused, which means two different compositions claim one
      // session — that must be loud, not last-writer-wins.
      const outcome = await writeRecordJson(fs, pathOf(sessionId), cwd, marker, { kind: "createIfAbsent" }, options);
      if (outcome === "exists") {
        throw new SessionBlueprintError("composition_mismatch", `a composition marker already exists for session ${sessionId}; refusing to overwrite it`);
      }
    },
  };
}

const blueprintStores = new WeakMap<object, Map<string, BlueprintStore>>();

/**
 * Resolve the marker store for one cwd.
 *
 * Without an `fs` service there is nothing durable to write to, so this returns a
 * process-local store — which means a cold resume after a restart falls back to
 * the header's preset projection. That reduction is stated here rather than
 * hidden: writing the marker back into the session log is what made sessions
 * unreadable in the first place.
 */
export function blueprintStoreFor(ctx: Context, cwd: string | undefined): BlueprintStore {
  const fs = resolveRecordFileSystem(ctx);
  if (fs === undefined || cwd === undefined || cwd === "") {
    const existing = blueprintStores.get(ctx)?.get("\0memory");
    if (existing !== undefined) return existing;
    const created = createMemoryBlueprintStore();
    const table = blueprintStores.get(ctx) ?? new Map<string, BlueprintStore>();
    table.set("\0memory", created);
    blueprintStores.set(ctx, table);
    return created;
  }
  const existing = blueprintStores.get(ctx)?.get(cwd);
  if (existing !== undefined) return existing;
  const created = createFsBlueprintStore(fs, cwd);
  const table = blueprintStores.get(ctx) ?? new Map<string, BlueprintStore>();
  table.set(cwd, created);
  blueprintStores.set(ctx, table);
  return created;
}
