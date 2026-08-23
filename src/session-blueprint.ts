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
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-session-title";

export const LIGHTWEIGHT_BLUEPRINT_SCHEMA_VERSION = 1;
export const LIGHTWEIGHT_BLUEPRINT_EVENT = "orchestra/blueprint" as const;

export interface LightweightBlueprintMarker {
  schemaVersion: 1;
  mode: "lightweight";
  agentPreset: string;
  permissionPreset: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  cwd?: string;
  title?: string;
  createdBySessionId: string;
  createdAt: number;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "orchestra/blueprint": LightweightBlueprintMarker;
  }
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

export interface PreparedLightweightBlueprint {
  readonly receipt: LightweightBlueprintReceipt;
  readonly agentOptions: AgentOptions;
  readonly meta: { cwd?: string; agentPreset: string };
  readonly setup: (agentCtx: Context) => Promise<AgentSetupCommit>;
}

export type BlueprintErrorCode =
  | "invalid_input"
  | "preset_unavailable"
  | "permission_unavailable"
  | "permission_mismatch"
  | "model_unavailable"
  | "required_tools_missing"
  | "composition_mismatch"
  | "session_unavailable";

export class SessionBlueprintError extends Error {
  readonly code: BlueprintErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BlueprintErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SessionBlueprintError";
    this.code = code;
    this.details = details;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function sessionFrom(ctx: Context, agentCtx: Context, sessionId: string): Session | undefined {
  const scopedSessions = agentCtx.get("sessions");
  const session = scopedSessions?.get(sessionId as never);
  if (session !== undefined) return session;
  return ctx.get("sessions")?.get(sessionId as never);
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

function requiredTools(input: LightweightBlueprintInput): string[] {
  const names = input.requiredTools ?? [];
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name === "")) {
    throw new SessionBlueprintError("invalid_input", "requiredTools must be an array of non-empty strings");
  }
  return [...new Set(names)];
}

function visibleToolNames(agentCtx: Context): string[] {
  const tools = agentCtx.get("tools");
  if (tools === undefined) return [];
  const schemas = tools.schemas(scopeOf(agentCtx)) as ToolSchema[];
  return [...new Set(schemas.map((schema) => schema.name))].sort();
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
    agentPreset = input.presetFile.id;
    presetStrategy = "file";
  } else if (asString(input.presetId) !== undefined) {
    const resolved = await presets.resolve(input.presetId);
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
      const resolved = await presets.resolve(defaultId);
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
    permissionPreset,
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(input.title === undefined ? {} : { title: input.title }),
    tools: readiness,
  };
  const agentOptions: AgentOptions = { provider: model.provider, model: model.model };

  const setup = async (agentCtx: Context): Promise<AgentSetupCommit> => {
    const agentPresets = agentCtx.get("agentPresets") ?? presets;
    if (presetStrategy === "file") {
      await mountPreset(agentCtx, input.presetFile as BlueprintPresetFile);
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
    const session = sessionFrom(ctx, agentCtx, sessionId);
    if (session === undefined) throw new SessionBlueprintError("session_unavailable", `unpublished session ${sessionId} is not visible during blueprint setup`);
    const permissionService = agentCtx.get("permissionPresets") ?? permissions;
    permissionService.set(session, permissionPreset);
    if (input.title !== undefined && input.title !== "") {
      session.append("session/title", { title: input.title, messageSeqs: [], source: { kind: "user" } });
    }
    session.append(LIGHTWEIGHT_BLUEPRINT_EVENT, marker);
    return {
      commit() {
        const actualPreset = agentPresets.composedPreset(agentCtx);
        if (actualPreset !== agentPreset) throw new SessionBlueprintError("composition_mismatch", `published composition "${String(actualPreset)}" does not match blueprint "${agentPreset}"`);
        const actualPermission = permissionService.current(session.events);
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

/** Read a lightweight marker without inventing facts for old sessions. */
export function readLightweightBlueprint(events: readonly SessionEvent[]): LightweightBlueprintMarker | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== LIGHTWEIGHT_BLUEPRINT_EVENT) continue;
    const marker = event.data as Partial<LightweightBlueprintMarker>;
    if (marker.schemaVersion !== 1 || marker.mode !== "lightweight" || typeof marker.agentPreset !== "string" || typeof marker.permissionPreset !== "string" || typeof marker.provider !== "string" || typeof marker.model !== "string" || typeof marker.createdBySessionId !== "string" || typeof marker.createdAt !== "number") return undefined;
    if ("teamId" in marker || "roleId" in marker || "topologyId" in marker) return undefined;
    return marker as LightweightBlueprintMarker;
  }
  return undefined;
}
