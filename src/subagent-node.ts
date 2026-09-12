/**
 * Native sub-agent node seam.
 *
 * A DAG node carried by a durable, continuable DSH sub-agent child instead of a
 * first-class Session. This module knows only the native delegation contract —
 * create a continuable child, deliver to it, read its activity — and
 * deliberately has no filesystem, Team, topology, or preset-policy dependency,
 * mirroring the layering of `a2a-transport.ts`.
 *
 * What the native contract cannot do (and why callers must not pretend
 * otherwise): a child joins its parent's LIVE Agent Preset rather than mounting
 * its own composition; its approval policy is pinned to `never` at the
 * delegation boundary, so it can never ask the user anything; and its sandbox
 * mode is frozen from the parent's explicit override at that same boundary.
 * Per-child variation is limited to persona, tool filter, and the model route.
 * The topology validator rejects roles that ask for more.
 */

import type { Context } from "@deepseek-ai/cordis";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolRestriction } from "@deepseek-ai/dsh-tools";
// Type-only: pulls in the `ctx.subagents` Context augmentation without adding a
// runtime import (the service is provided by the host composition).
import type {} from "@deepseek-ai/dsh-subagent";

const SID = (value: string) => value as SessionId;

/** Durable activity of one sub-agent child, as far as a listing can tell. */
export type SubagentNodeActivity = "running" | "inactive" | "unknown";

/** Everything one node needs to become a live child of its parent. */
export interface SubagentNodeSpec {
  /** Durable creation label (surfaces in `list_agents` and the child descriptor). */
  label: string;
  /** The node's opening prompt (the welcome/dispatch text). */
  prompt: string;
  /** Provider name; defaults to `"spawn"` (a fresh child; `"fork"` would inherit the parent's whole history). */
  provider?: string;
  /** Caller-reserved child identity, when the caller wants to record provisioning before materialization. */
  childId?: string;
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number };
  toolFilter?: { allow?: string[]; deny?: string[] };
  persona?: string;
}

/** Durable identity of one established child plus the accepted initial prompt. */
export interface SubagentNodeReceipt {
  childId: string;
  messageId: string;
  provider: string;
}

export type SubagentNodeErrorCode = "unavailable" | "create_failed" | "deliver_failed";

/**
 * A native delegation step that could not be completed.
 *
 * The three codes are separated because the recovery differs: `unavailable`
 * means the deployment composes no subagent registry (a composition problem),
 * `create_failed` means no child exists and nothing was materialized, and
 * `deliver_failed` means a child may exist but its inbox never accepted the
 * message.
 */
export class SubagentNodeError extends Error {
  readonly code: SubagentNodeErrorCode;
  constructor(code: SubagentNodeErrorCode, message: string) {
    super(message);
    this.name = "SubagentNodeError";
    this.code = code;
  }
}

function requireSubagents(ctx: Context): Context["subagents"] {
  const subagents = ctx.get("subagents");
  if (subagents === undefined) {
    throw new SubagentNodeError(
      "unavailable",
      "subagents service is unavailable: this composition mounts no sub-agent provider registry, so a sub-agent node cannot be created",
    );
  }
  return subagents;
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`subagent node: ${what} must be a non-empty string`);
  return value;
}

/** Native agent options, omitting every field the caller left unstated. */
function nativeAgentOptions(spec: SubagentNodeSpec) {
  const requested = spec.agentOptions;
  if (requested === undefined) return undefined;
  return {
    ...(requested.provider === undefined ? {} : { provider: requested.provider }),
    ...(requested.model === undefined ? {} : { model: requested.model }),
    // The seam's branded id, not a bare string: the native contract validates it.
    ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(String(requested.reasoningEffort)) }),
    ...(requested.maxTokens === undefined ? {} : { maxTokens: requested.maxTokens }),
  };
}

/** Native tool scoping, copied so a later caller mutation cannot reach the child. */
function nativeToolFilter(spec: SubagentNodeSpec): ToolRestriction | undefined {
  const requested = spec.toolFilter;
  if (requested === undefined) return undefined;
  return {
    ...(requested.allow === undefined ? {} : { allow: [...requested.allow] }),
    ...(requested.deny === undefined ? {} : { deny: [...requested.deny] }),
  };
}

/**
 * Establish one durable continuable child and deliver its opening prompt.
 *
 * `spawn` is the default provider because a node is a NEW role with its own
 * brief: `fork` would seed the child with the parent's completed turns and the
 * node would start from the controller's history instead of its own.
 *
 * @param ctx - host context carrying the subagent registry.
 * @param parent - the exact live Agent the child is created under; native
 *   delivery is authorized by this direct-parent edge, so the caller must be
 *   the session that will later address the node.
 * @param spec - label, opening prompt, and the per-child knobs the native
 *   contract actually honors.
 * @param signal - caller cancellation for PREPARATION only. Once the child is
 *   established its lifecycle belongs to the continuation manager, which is
 *   why this signal cannot be used to tear the node down.
 * @returns the durable child id, the accepted prompt's message id, and the
 *   provider that established it.
 * @throws {SubagentNodeError} `unavailable` without a registry,
 *   `create_failed` when materialization fails (no child is left behind).
 */
export async function createSubagentNode(
  ctx: Context,
  parent: Agent,
  spec: SubagentNodeSpec,
  signal: AbortSignal,
): Promise<SubagentNodeReceipt> {
  const subagents = requireSubagents(ctx);
  const label = requireNonEmpty(spec.label, "label");
  const prompt = requireNonEmpty(spec.prompt, "prompt");
  const provider = spec.provider === undefined || spec.provider === "" ? "spawn" : spec.provider;
  const agentOptions = nativeAgentOptions(spec);
  const toolFilter = nativeToolFilter(spec);
  try {
    const started = await subagents.startContinuable({
      provider,
      label,
      ...(spec.childId === undefined ? {} : { childId: SID(spec.childId) }),
      request: {
        prompt: [{ type: "text", text: prompt }] as ContentBlock[],
        parent,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(toolFilter === undefined ? {} : { toolFilter }),
        ...(spec.persona === undefined ? {} : { persona: spec.persona }),
      },
      signal,
    });
    return { childId: String(started.childId), messageId: String(started.messageId), provider };
  } catch (error) {
    throw new SubagentNodeError(
      "create_failed",
      `sub-agent node "${label}" could not be established by provider "${provider}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Steer host-authored content to one direct continuable child.
 *
 * The native seam accepts only an exact live sender that is the child's DIRECT
 * PARENT (or, from the child's side, its direct parent). A controller that is
 * not the parent cannot deliver, and no impersonation path exists — so this
 * function passes the caller's own Agent through rather than fabricating one.
 *
 * A running target admits the message at its nearest step boundary, an idle
 * target starts a turn, and an absent direct child cold-resumes from
 * persistence; the returned id is the accepted inbox id, not proof the node has
 * processed it.
 *
 * @param ctx - host context carrying the subagent registry.
 * @param parent - the exact live direct parent authorizing delivery.
 * @param childId - durable child session id.
 * @param blocks - host-authored content to deliver.
 * @param options - caller cancellation before inbox acceptance.
 * @returns the accepted message's inbox id.
 * @throws {SubagentNodeError} `unavailable` without a registry, `deliver_failed`
 *   when adjacency is rejected or the message was not admitted.
 */
export async function sendToSubagentNode(
  ctx: Context,
  parent: Agent,
  childId: string,
  blocks: ContentBlock[],
  options: { signal?: AbortSignal } = {},
): Promise<{ messageId: string }> {
  const subagents = requireSubagents(ctx);
  const target = requireNonEmpty(childId, "childId");
  try {
    const messageId = await subagents.sendMessage(
      parent,
      SID(target),
      blocks,
      // The native contract requires a signal; callers that have none still get
      // a real one so a hung pre-acceptance step stays cancellable by disposal.
      { signal: options.signal ?? new AbortController().signal },
    );
    return { messageId: String(messageId) };
  } catch (error) {
    throw new SubagentNodeError(
      "deliver_failed",
      `sub-agent node ${target} did not accept the delivery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read the durable activity of a parent's direct children.
 *
 * `listChildren` reports `running` for a session resident in the store and
 * `inactive` for one that exists only in persistence — neither is a durable
 * outcome, and a continuable child may still reject delivery. A listing entry
 * this runtime cannot classify (a corrupt or transiently unreadable candidate)
 * is reported as `unknown` rather than omitted, so a caller never mistakes
 * "could not tell" for "not running". The returned map is a sparse index of
 * what the listing reported: an id the listing never mentioned is simply
 * absent, and callers read absence as `unknown`.
 *
 * @param ctx - host context carrying the subagent registry.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - caller-owned cancellation for the listing.
 * @returns per-child activity, with `unknown` for unclassifiable entries.
 * @throws {SubagentNodeError} `unavailable` without a registry; a listing
 *   failure propagates as itself, because "cannot enumerate" must not be
 *   silently rendered as "no children".
 */
export async function subagentNodeActivity(
  ctx: Context,
  parentSessionId: string,
  signal?: AbortSignal,
): Promise<Map<string, SubagentNodeActivity>> {
  const subagents = requireSubagents(ctx);
  const parent = requireNonEmpty(parentSessionId, "parentSessionId");
  const entries = await subagents.listChildren(SID(parent), signal);
  const activity = new Map<string, SubagentNodeActivity>();
  for (const entry of entries) {
    if (entry.kind === "child") {
      activity.set(String(entry.id), entry.activity);
      continue;
    }
    activity.set(String(entry.id), "unknown");
  }
  return activity;
}
