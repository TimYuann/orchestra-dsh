/**
 * S3 — the ONE place a role preset gets mounted onto an agent.
 *
 * ## Why this module exists
 *
 * Before it, four call sites each decided for themselves how to mount a role
 * preset, and they decided differently:
 *
 *  - `a2a-transport.ts` resolved the preset id and called the roster's own
 *    `mount(agentCtx, resolved.id)` when there was no override file, and
 *    `mountPreset(agentCtx, file)` when there was;
 *  - `session-blueprint.ts` (both planes) branched on a precomputed
 *    `presetStrategy === "file"`;
 *  - `orchestra.ts` (reactivation) built a `{id, trust, path}` triple and always
 *    went through `mountPreset`, even for a preset the roster could have resolved
 *    by name.
 *
 * That last one is the defect this closes. A preset that the roster knows — the
 * deployment's `agent-presets` roots include `~/.dsh/orchestra/catalog-presets`
 * after §7 — must be mounted BY ID, because mounting by file bypasses the roster
 * entirely: the composition is composed from whatever bytes that path holds, with
 * no discovery, no standing mount, and no identity the resume path can find again
 * after a restart. Mounting by id is what makes a cold-resumed session come back
 * with its role composition instead of an empty global layer.
 *
 * ## The two shapes, and why there are exactly two
 *
 *  - **by id** — `agentPresets.mount(agentCtx, id)`. This is the engine's own
 *    public entry point (`dsh-agent-presets` `AgentPresets.mount`), and it
 *    resolves the id against the configured roots itself. It covers BOTH the
 *    roster source and the builtin catalog source: after §7 the catalog root IS a
 *    roster root, so a builtin preset is reachable by id too.
 *  - **by file** — `mountPreset(agentCtx, preset)`. Only for a `project` or
 *    `global` override file, which lives outside every roster root and therefore
 *    has no id the roster could resolve.
 *
 * A measured note that keeps this module small: `mountPreset(agentCtx, preset)`
 * takes a RESOLVED `AgentPreset`, not an `{id, trust, path}` triple. The pre-S3
 * call sites passed a hand-built triple that happened to satisfy the type only
 * because every other `AgentPreset` field is optional. So there is no third shape
 * to support here — a roster preset needs no path at all.
 *
 * ## Applicable boundary (R-creep)
 *
 * This module decides **which API mounts a role preset**. It does not resolve
 * overrides (that stays `resolveRolePresetFile`, which owns the
 * `project > global` precedence), does not validate compositions, and does not
 * write blueprint records. It is used by the ROLE-SESSION paths only: the
 * lightweight collaborator path (`a2a_create` with an explicit preset) and the
 * `A2A transport` resume path keep their own shapes until S2 moves them.
 */

import type { Context } from "@deepseek-ai/cordis";
import { mountPreset } from "@deepseek-ai/dsh-agent-presets";

/** An override file resolved outside every roster root (`project` / `global`). */
export interface RolePresetOverrideFile {
  id: string;
  trust: "system" | "user";
  path: string;
}

export interface MountRolePresetInput {
  /** The preset id team.json / the blueprint records. */
  presetId: string;
  /**
   * An override file, when a `project`/`global` preset shadows the roster id.
   * Absent means "mount the id"; present means "mount these bytes".
   */
  overrideFile?: RolePresetOverrideFile;
  /**
   * A roster already resolved by the caller. This is the precedence the engine
   * itself uses: when the caller holds a roster (the transport captured one
   * before the setup window opened), that roster mounted the preset id — the
   * agent's own scope context is not consulted. Reaching into `agentCtx` first
   * would silently change which roster composes the agent.
   */
  roster?: { mount: (agentCtx: Context, id: string) => Promise<unknown> };
  /**
   * Injection seam. The two mounts are passed in so a test can observe the
   * decision without a live composition; production omits them.
   */
  mountById?: (agentCtx: Context, id: string) => Promise<unknown>;
  mountByFile?: (agentCtx: Context, file: RolePresetOverrideFile) => Promise<unknown>;
}

export interface MountRolePresetResult {
  /** Which API mounted it — the fact the blueprint record and the tests need. */
  mountedBy: "id" | "file";
  /** The id that was mounted. Same as `presetId`; returned so callers stop re-deriving it. */
  presetId: string;
}

/** Thrown when the deployment composes no preset roster at all. */
export class RolePresetMountError extends Error {
  readonly code = "preset_roster_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "RolePresetMountError";
  }
}

/**
 * Mount one role preset onto an agent, choosing the engine entry point from the
 * preset's SOURCE rather than from which call site is running.
 *
 * @param agentCtx - the agent's scope context, inside the setup window.
 * @param input - the preset id plus an override file when one shadows it.
 * @returns which API mounted it, so the caller can record the fact.
 * @throws {RolePresetMountError} when no roster is composed and there is no
 *   override file — the id cannot be resolved by anything, so failing loudly here
 *   is the only honest answer. A deployment with a roster never reaches this.
 */
export async function mountRolePreset(agentCtx: Context, input: MountRolePresetInput): Promise<MountRolePresetResult> {
  const file = input.overrideFile;
  if (file !== undefined) {
    const mountByFile = input.mountByFile ?? ((ctx, preset) => mountPreset(ctx, preset as never));
    await mountByFile(agentCtx, file);
    return { mountedBy: "file", presetId: file.id };
  }

  const mountById =
    input.mountById ??
    (async (ctx: Context, id: string) => {
      // Precedence: the caller's roster FIRST, and the agent's context only as a
      // fallback. Checking the context first would ask every mount about a
      // service the caller already supplied, and would risk composing the agent
      // from a different roster than the one that resolved its id.
      let presets = input.roster;
      if (presets === undefined) {
        // `get` is read defensively because a caller may hand this a
        // deliberately minimal agent context (the a2a transport tests do exactly
        // that); a missing roster must yield the typed error below rather than a
        // bare "ctx.get is not a function".
        const fromContext = typeof (ctx as { get?: unknown }).get === "function"
          ? (ctx as { get: (name: string) => { mount?: (c: Context, i: string) => Promise<unknown> } | undefined }).get("agentPresets")
          : undefined;
        presets = fromContext !== undefined && typeof fromContext.mount === "function"
          ? { mount: fromContext.mount.bind(fromContext) }
          : undefined;
      }
      if (presets === undefined || typeof presets.mount !== "function") {
        throw new RolePresetMountError(
          `role preset "${id}" cannot be mounted by id: this deployment composes no agent-preset roster`,
        );
      }
      return presets.mount(ctx, id);
    });
  await mountById(agentCtx, input.presetId);
  return { mountedBy: "id", presetId: input.presetId };
}
