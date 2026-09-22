/** Mount an Orchestra role through DSH 0.1.7's declaration registry. */
import type { Context } from "@deepseek-ai/cordis";

/** Retained only to give legacy callers a typed, loud migration failure. */
export interface RolePresetOverrideFile { id: string; trust: "system" | "user"; path: string }
export interface MountRolePresetInput {
  presetId: string;
  /** File presets are unsupported in 0.1.7: declarations must be bundled. */
  overrideFile?: RolePresetOverrideFile;
  roster?: { mount: (agentCtx: Context, id?: string) => Promise<unknown> };
  mountById?: (agentCtx: Context, id: string) => Promise<unknown>;
}
export interface MountRolePresetResult { mountedBy: "id"; presetId: string }
export class RolePresetMountError extends Error { readonly code = "preset_roster_unavailable"; }

/**
 * Mount a declared preset id.  Registry declarations, not filesystem roots,
 * are the only supported identity/revision source on DSH 0.1.7.
 */
export async function mountRolePreset(agentCtx: Context, input: MountRolePresetInput): Promise<MountRolePresetResult> {
  if (input.overrideFile !== undefined) {
    throw new RolePresetMountError(`file preset "${input.overrideFile.id}" is unsupported; install a declared preset bundle first`);
  }
  const registry = input.roster ?? (typeof (agentCtx as any).get === "function" ? (agentCtx as any).get("agentPresets") : undefined);
  const mount = input.mountById ?? (registry?.mount?.bind(registry));
  if (typeof mount !== "function") throw new RolePresetMountError(`role preset "${input.presetId}" cannot be mounted: agent preset registry is unavailable`);
  await mount(agentCtx, input.presetId);
  return { mountedBy: "id", presetId: input.presetId };
}
