/**
 * orchestra-dsh/orchestra — topology management layer: create role sessions
 * from preset topologies, apply role sandboxes, track review rounds, and
 * reactivate the team after a DSH restart.
 *
 * Host-plane plugin. Self-contained: session creation reuses the a2a module;
 * state persists to <cwd>/orchestra/state/team.json (storage domain needs zod
 * schemas, unavailable to the previous dynamic-plugin sandbox; revisit on
 * formalization).
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, MessageSource } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-fs";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-commands";
import { createSession, installModelOverride } from "./a2a.js";
import "./relay-types.js";

const SID = (value: string): SessionId => value as SessionId;

/** Cordis plugin name used by loader diagnostics. */
export const name = "orchestra-manager";

/** Required services. */
export const inject = ["agents", "sessions", "fs", "sandboxPolicy", "tools"];

interface RoleConfig {
  id: string;
  name: string;
  preset: string | null;
  model?: unknown;
  mode?: string;
  sandbox?: string;
  maxRounds?: number;
  welcome?: string;
}

interface TopologyConfig {
  id: string;
  name?: string;
  description?: string;
  roles: RoleConfig[];
}

interface TeamRole {
  id: string;
  name: string;
  sessionId: string;
  preset: string | null;
  sandbox: string;
  rounds: number;
  lastReport: string | null;
  /** Per-role model override snapshot, re-applied by orchestra_activate after a restart. */
  model?: { provider?: string; model?: string; reasoningEffort?: string };
}

interface TeamState {
  topology: string;
  createdAt: number;
  executorSessionId: string;
  roles: TeamRole[];
  /** True after orchestra_dismiss: the instance is archived and the directory is free for a new one. */
  archived?: boolean;
  archivedAt?: number;
  archivePath?: string;
}

/** Bundled topology templates shipped with the plugin (source: "bundled"). */
const EMBEDDED_TEMPLATES: TopologyConfig[] = [
  {
    id: "duo",
    name: "Duo 开发",
    description: "executor（主会话）+ reviewer（只读评审）最小闭环",
    roles: [
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-reviewer",
        model: null,
        mode: "native",
        sandbox: "read-only",
        maxRounds: 2,
        welcome:
          "你已被 orchestra 团队录用为 Reviewer。职责：只审不修，最多两轮（R1 全量 → R2 只核对 R1 findings），每轮结束用 orchestra_report 工具把 review report 写入 orchestra/reports/，回复 executor 时返回报告路径。R2 中发现的新问题不追加本轮，记入 backlog，由 executor 决定是否另开评审。executor 是发起本消息的会话。",
      },
    ],
  },
  {
    id: "trio",
    name: "Trio 开发",
    description: "implementer（实现者）+ reviewer（只读两轮评审）的 实现-评审 闭环，适合严肃开发任务",
    roles: [
      {
        id: "implementer",
        name: "Implementer",
        preset: null,
        model: null,
        mode: "native",
        sandbox: "workspace-write",
        welcome:
          "你已被 orchestra 团队录用为 Implementer。职责：实现 orchestrator 派发的任务，产出可运行代码与验证记录；完成后用 orchestra_report 写交付说明到 orchestra/reports/，并回复 orchestrator 报告路径。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-reviewer",
        model: null,
        mode: "native",
        sandbox: "read-only",
        maxRounds: 2,
        welcome:
          "你已被 orchestra 团队录用为 Reviewer。职责：只审不修，最多两轮（R1 全量 → R2 只核对 R1 findings），每轮结束用 orchestra_report 工具把 review report 写入 orchestra/reports/，回复 executor 时返回报告路径。R2 中发现的新问题不追加本轮，记入 backlog，由 executor 决定是否另开评审。executor 是发起本消息的会话。",
      },
    ],
  },
  {
    id: "oracle",
    name: "Oracle 推演",
    description: "oracle（深度推演搭档）：driver 与它对话式推演方案（讨论即计划），收敛后把结论作为自包含任务派给执行角色（计划即任务）",
    roles: [
      {
        id: "oracle",
        name: "Oracle",
        preset: null,
        model: null,
        mode: "native",
        sandbox: "read-only",
        welcome:
          "你已被 orchestra 团队录用为 Oracle。职责：与 driver 深入推演——分析目标、权衡方案、识别风险、产出可执行的设计结论；推演过程即计划（取代 plan mode），收敛后用 orchestra_report 把设计结论写入 orchestra/reports/，并回复 driver 结论路径。",
      },
    ],
  },
];

const EMBEDDED_DUO: TopologyConfig = EMBEDDED_TEMPLATES[0];

/** One template role as listed by orchestra_topologies (null preset → omitted). */
function templateRoleEntry(role: RoleConfig): {
  id: string;
  name: string;
  preset?: string;
  sandbox?: string;
  maxRounds?: number;
} {
  const entry: { id: string; name: string; preset?: string; sandbox?: string; maxRounds?: number } = {
    id: role.id,
    name: role.name ?? role.id,
  };
  if (role.preset !== undefined && role.preset !== null) entry.preset = role.preset;
  if (role.sandbox !== undefined) entry.sandbox = role.sandbox;
  if (role.maxRounds !== undefined) entry.maxRounds = role.maxRounds;
  return entry;
}

/**
 * Bare-spawn template fallback (O3 sandbox matrix): when orchestra_spawn is
 * called with a plain roleName (no templateId+roleId), match templates by
 * role id/name and reuse the template's preset/sandbox/welcome — so a bare
 * "reviewer"/"oracle" spawn still gets read-only and never falls back to
 * workspace-write. Explicit templateId+roleId keeps its own resolution path.
 *
 * Matching rules:
 * - scans user templates under <cwd>/orchestra/topologies/*.json first, then
 *   the bundled duo/trio/oracle (loadTopology fallback semantics) — user
 *   read-only roles are covered too (F3);
 * - a trailing numeric suffix is stripped before matching ("reviewer-2" →
 *   "reviewer"), so renaming per the O5 suggestion still inherits the
 *   template's sandbox/preset/welcome instead of falling to workspace-write
 *   (F1).
 */

/** Lower-cased role id/name with a trailing numeric suffix stripped ("reviewer-2" → "reviewer"). */
function templateBaseName(roleName: string): string {
  return roleName.replace(/-\d+$/, "").toLowerCase();
}

async function templateRoleForSpawn(ctx: Context, cwd: string, roleName: string): Promise<RoleConfig | undefined> {
  const exact = roleName.toLowerCase();
  const base = templateBaseName(roleName);
  const candidates: TopologyConfig[] = [];
  try {
    const dir = await ctx.fs.resolve(`${cwd}/orchestra/topologies`, { cwd });
    const entries = await ctx.fs.listDir(dir);
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await ctx.fs.readText(entry.target)) as TopologyConfig;
        if (Array.isArray(parsed.roles)) candidates.push(parsed);
      } catch {
        // skip unparseable user templates
      }
    }
  } catch {
    // no user topologies directory
  }
  for (const template of EMBEDDED_TEMPLATES) {
    if (!candidates.some((candidate) => candidate.id === template.id)) candidates.push(template);
  }
  for (const topology of candidates) {
    for (const role of topology.roles) {
      const id = role.id.toLowerCase();
      const name = String(role.name ?? role.id).toLowerCase();
      if (id === exact || name === exact || id === base || name === base) return role;
    }
  }
  return undefined;
}

async function loadJson(ctx: Context, target: FsTarget): Promise<unknown> {
  const fs = ctx.fs;
  return JSON.parse(await fs.readText(target));
}

async function loadTopology(ctx: Context, cwd: string, id: string): Promise<TopologyConfig> {
  try {
    const target = await ctx.fs.resolve(`${cwd}/orchestra/topologies/${id}.json`, { cwd });
    const parsed = (await loadJson(ctx, target)) as TopologyConfig;
    if (parsed.id === id) return parsed;
  } catch (error) {
    // fall through to the embedded definition
  }
  const embedded = EMBEDDED_TEMPLATES.find((template) => template.id === id);
  if (embedded !== undefined) return embedded;
  throw new Error(`unknown topology "${id}"`);
}

async function loadTeam(ctx: Context, cwd: string): Promise<TeamState | undefined> {
  try {
    const target = await ctx.fs.resolve(`${cwd}/orchestra/state/team.json`, { cwd });
    return (await loadJson(ctx, target)) as TeamState;
  } catch (error) {
    return undefined;
  }
}

async function saveTeam(ctx: Context, cwd: string, team: TeamState, policy: SandboxExecutionPolicy): Promise<void> {
  const target = await ctx.fs.resolve(`${cwd}/orchestra/state/team.json`, { cwd });
  await ctx.fs.writeText(target, JSON.stringify(team, null, 2), undefined, undefined, policy);
}

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

/** Role self-awareness protocol (REQUIREMENTS §3): the opening discipline injected into every role session. */
function roleProtocolText(executorSessionId: string, roleName: string): string {
  return [
    `You are running on orchestra, as role "${roleName}".`,
    `Your driver (the role that launched the team and owns decisions) is session ${executorSessionId}.`,
    `Reply rule: all replies go via a2a_reply to ${executorSessionId}; never reply directly to the user — users interact with you only through your driver.`,
    `Task source: tasks are dispatched by your driver via a2a_send; each task is self-contained and does not depend on your history.`,
    `Handoff: write outputs/reports with orchestra_report under orchestra/reports/, and return the report path when replying to the orchestrator.`,
    `Discipline (wait for dispatch): a welcome/activation message is NOT a task — do not start any work until your driver dispatches a concrete task via a2a_send; work starts only after the task arrives.`,
    `Discipline (spec scope): implement strictly what the dispatched task's spec asks for; do not extend features, variables, files, or scope beyond it.`,
  ].join("\n");
}

/** 向角色会话发送开场消息：协议段 + 可选自定义欢迎/任务说明。目标必须在线。 */
function sendRoleWelcome(
  ctx: Context,
  fromSessionId: string,
  toSessionId: string,
  roleName: string,
  extra?: string,
): string {
  const agent = ctx.agents.get(SID(toSessionId));
  if (agent === undefined) throw new Error(`role session ${toSessionId} is not live; cannot deliver`);
  const parts = [roleProtocolText(fromSessionId, roleName)];
  if (typeof extra === "string" && extra !== "") parts.push(extra);
  const message = createUserMessage({
    content: [{ type: "text", text: parts.join("\n\n") }] as ContentBlock[],
    source: { kind: "a2a", form: "relay", senderSessionId: fromSessionId },
  });
  agent.followup(message);
  return message.id;
}

async function roleStatus(ctx: Context, role: TeamRole) {
  const agent = ctx.agents.get(SID(role.sessionId));
  const status: {
    id: string;
    name: string;
    sessionId: string;
    live: boolean;
    status: string;
    rounds: number;
    lastReport: string | null;
    lastActivityAt?: number;
    lastActivity?: string;
  } = {
    id: role.id,
    name: role.name,
    sessionId: role.sessionId,
    live: agent !== undefined,
    status: agent === undefined ? "cold" : agent.status,
    rounds: role.rounds ?? 0,
    lastReport: role.lastReport ?? null,
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

const SECTION_NAME = "tool:orchestra";
const SECTION_ORDER = 119;

export const Config = undefined;

export function apply(ctx: Context): void {
  const roleItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      name: { type: "string", required: true },
      sessionId: { type: "string", required: true },
      live: { type: "boolean", required: true },
      status: { type: "string", required: true },
      rounds: { type: "number", required: true },
      lastReport: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      lastActivityAt: { type: "number" },
      lastActivity: { type: "string" },
    },
  } as const;

  ctx.tools.register(
    defineTool({
      name: "orchestra_create",
      description:
        "Create the orchestra team: for each role in the topology, spawn its session with the role preset, apply the role sandbox, record the mapping in orchestra/state/team.json, and send each role its welcome message. Run once per working directory; repeat calls fail while a team exists. Use orchestra_team to inspect the team afterwards.",
      parameters: {
        topology: { type: "string", description: "Topology id. Defaults to \"duo\"." },
        provider: { type: "string", description: "Model provider override applied to every role session. Must be paired with model." },
        model: { type: "string", description: "Model override applied to every role session. Must be paired with provider." },
        reasoningEffort: { type: "string", description: "Reasoning effort override applied to every role session (e.g. \"medium\"). Requires provider and model." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            topology: { type: "string", required: true },
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
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `team ${value.topology} created: ${value.roles.map((r) => `${r.id}=${r.sessionId}${r.live ? "" : " (cold)"}`).join(", ")}`,
          },
        ],
      },
      async execute(
        args: { topology?: string; provider?: string; model?: string; reasoningEffort?: string },
        exec: ToolExecutionInput,
      ) {
        if (exec.agent === undefined) throw new Error("orchestra_create requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory; cannot create a team");
        const existing = await loadTeam(ctx, cwd);
        if (existing !== undefined && existing.archived !== true)
          throw new Error(
            `a team already exists here (topology=${existing.topology}); run orchestra_dismiss to close it, or use another working directory`,
          );
        const topology = await loadTopology(ctx, cwd, args.topology ?? "duo");
        const roles: TeamRole[] = [];
        if ((args.provider === undefined) !== (args.model === undefined))
          throw new Error("provider and model must be provided together (both or neither)");
        if (args.reasoningEffort !== undefined && (args.provider === undefined || args.model === undefined))
          throw new Error("reasoningEffort requires provider and model");
        const hasModelOverride =
          args.provider !== undefined || args.model !== undefined || args.reasoningEffort !== undefined;
        for (const role of topology.roles) {
          const created = await createSession(ctx, {
            cwd,
            ...(role.preset === null ? {} : { presetId: role.preset }),
            ...(args.provider === undefined ? {} : { provider: args.provider }),
            ...(args.model === undefined ? {} : { model: args.model }),
            ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
            currentSessionId: exec.agent.id,
            title: `orchestra: ${role.name} (${topology.id})`,
            signal: exec.signal,
          });
          if (role.sandbox === "read-only") {
            const session = ctx.sessions.get(SID(created.sessionId));
            if (session !== undefined) session.append("sandbox/mode", { mode: "read-only" });
          }
          const record: TeamRole = {
            id: role.id,
            name: role.name,
            sessionId: created.sessionId,
            preset: role.preset,
            sandbox: role.sandbox ?? "workspace-write",
            rounds: 0,
            lastReport: null,
            ...(hasModelOverride
              ? {
                  model: {
                    ...(args.provider === undefined ? {} : { provider: args.provider }),
                    ...(args.model === undefined ? {} : { model: args.model }),
                    ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
                  },
                }
              : {}),
          };
          roles.push(record);
          if (typeof role.welcome === "string" && role.welcome !== "") {
            sendRoleWelcome(ctx, exec.agent.id, created.sessionId, role.name, role.welcome);
          }
        }
        const team: TeamState = {
          topology: topology.id,
          createdAt: Date.now(),
          executorSessionId: exec.agent.id,
          roles,
        };
        await saveTeam(ctx, cwd, team, escrowPolicy(ctx, exec));
        return {
          topology: team.topology,
          roles: team.roles.map((role) => ({
            id: role.id,
            sessionId: role.sessionId,
            live: ctx.agents.get(SID(role.sessionId)) !== undefined,
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_spawn",
      description:
        "Dynamically create one role session for the current orchestra instance: spawns the session (optional role preset), injects the role self-awareness protocol (driver identity, reply via a2a_reply to the driver — never directly to the user, self-contained tasks, orchestra_report handoff), optionally applies a read-only sandbox, records the role in orchestra/state/team.json (creating a custom instance when none exists), and returns the session id. To add a role from a topology template, pass templateId plus roleId (its preset/sandbox/welcome are reused; explicit presetId/sandbox override them). The driver should follow up with a self-contained task via a2a_send.",
      parameters: {
        roleName: { type: "string", description: "Role name, e.g. \"implementer\" (required unless templateId+roleId are given)." },
        mission: { type: "string", description: "Role duties or current task summary; appended to the injected welcome." },
        presetId: { type: "string", description: "Agent preset id to mount; defaults to the deployment default." },
        sandbox: { type: "string", enum: ["read-only"], description: "Optional sandbox mode for the role session." },
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
            roles: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  sessionId: { type: "string", required: true },
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
        let roleName = String(args.roleName ?? "").trim();
        if (roleName === "" && args.templateId !== undefined && args.roleId !== undefined) {
          roleName = args.roleId;
        }
        if (roleName === "") throw new Error("roleName must not be empty (or provide templateId+roleId)");
        // Role configuration source (preset/sandbox/welcome):
        // 1) explicit templateId+roleId path keeps the original behavior;
        // 2) bare roleName spawn matches the bundled templates by id/name
        //    (O3 sandbox matrix) so reviewer-type roles are read-only by
        //    default instead of falling back to workspace-write.
        let templatePreset: string | null | undefined;
        let templateSandbox: string | undefined;
        let templateWelcome: string | undefined;
        if (args.templateId !== undefined || args.roleId !== undefined) {
          if (args.templateId === undefined || args.roleId === undefined)
            throw new Error("templateId and roleId must be provided together");
          const topology = await loadTopology(ctx, cwd, args.templateId);
          const source = topology.roles.find((role) => role.id === args.roleId);
          if (source === undefined) throw new Error(`template ${args.templateId} has no role ${args.roleId}`);
          templatePreset = source.preset;
          templateSandbox = source.sandbox;
          templateWelcome = source.welcome;
        } else {
          const matched = await templateRoleForSpawn(ctx, cwd, roleName);
          if (matched !== undefined) {
            templatePreset = matched.preset;
            templateSandbox = matched.sandbox;
            templateWelcome = matched.welcome;
          }
        }
        const effectivePreset = args.presetId !== undefined && args.presetId !== "" ? args.presetId : templatePreset;
        const effectiveSandbox = args.sandbox ?? templateSandbox;
        if ((args.provider === undefined) !== (args.model === undefined))
          throw new Error("provider and model must be provided together (both or neither)");
        if (args.reasoningEffort !== undefined && (args.provider === undefined || args.model === undefined))
          throw new Error("reasoningEffort requires provider and model");
        let team = await loadTeam(ctx, cwd);
        if (team === undefined || team.archived === true) {
          // New team keeps its topology source of truth (O4): the template id
          // when spawned from one, otherwise "custom".
          team = { topology: args.templateId ?? "custom", createdAt: Date.now(), executorSessionId: exec.agent.id, roles: [] };
        } else {
          // Role ids must be unique in a team (O5): fail fast with a clear
          // error instead of recording a duplicate id (e.g. a second "reviewer").
          // The check is case-insensitive (F4): "Reviewer" vs "reviewer" cannot coexist.
          if (team.roles.some((role) => role.id.toLowerCase() === roleName.toLowerCase())) {
            throw new Error(
              `role id "${roleName}" already exists in this team; choose a distinct roleName (e.g. "${roleName}-2", numeric suffixes still inherit the matching template's sandbox/preset), or pass templateId+roleId / sandbox:"read-only" explicitly`,
            );
          }
          // F2: topology must reflect the current role set, not just the creation
          // blueprint — appending a role that is not part of the team's template
          // (matched by base name) makes the instance a hybrid → downgrade to custom.
          if (team.topology !== "custom") {
            try {
              const blueprint = await loadTopology(ctx, cwd, team.topology);
              const base = templateBaseName(roleName);
              const inBlueprint = blueprint.roles.some(
                (role) => role.id.toLowerCase() === base || String(role.name ?? role.id).toLowerCase() === base,
              );
              if (!inBlueprint) team.topology = "custom";
            } catch {
              // unknown blueprint topology: leave the recorded value untouched
            }
          }
        }
        const hasModelOverride =
          args.provider !== undefined || args.model !== undefined || args.reasoningEffort !== undefined;
        const created = await createSession(ctx, {
          cwd,
          ...(effectivePreset === undefined || effectivePreset === null ? {} : { presetId: effectivePreset }),
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          currentSessionId: exec.agent.id,
          title: `orchestra: ${roleName} (${team.topology})`,
          signal: exec.signal,
        });
        if (effectiveSandbox === "read-only") {
          const session = ctx.sessions.get(SID(created.sessionId));
          if (session !== undefined) session.append("sandbox/mode", { mode: "read-only" });
        }
        const record: TeamRole = {
          id: roleName,
          name: roleName,
          sessionId: created.sessionId,
          preset: effectivePreset === undefined || effectivePreset === null ? null : effectivePreset,
          sandbox: effectiveSandbox ?? "workspace-write",
          rounds: 0,
          lastReport: null,
          ...(hasModelOverride
            ? {
                model: {
                  ...(args.provider === undefined ? {} : { provider: args.provider }),
                  ...(args.model === undefined ? {} : { model: args.model }),
                  ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
                },
              }
            : {}),
        };
        team.roles.push(record);
        await saveTeam(ctx, cwd, team, escrowPolicy(ctx, exec));
        const extra = [templateWelcome, args.mission].filter((part) => typeof part === "string" && part !== "").join("\n\n");
        sendRoleWelcome(ctx, exec.agent.id, created.sessionId, roleName, extra);
        return {
          sessionId: created.sessionId,
          roleName,
          topology: team.topology,
          roles: team.roles.map((role) => ({ id: role.id, sessionId: role.sessionId })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_team",
      description:
        "Show the orchestra team: every role with its session id, live status, review round counter, and last report path. Requires a team created by orchestra_create in this working directory.",
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
                    topology: { type: "string", required: true },
                    createdAt: { type: "number", required: true },
                    executorSessionId: { type: "string", required: true },
                    roles: { type: "array", required: true, items: roleItem },
                  },
                },
                { type: "null" },
              ],
            },
          },
        },
        render: (_args, value) => {
          if (value.team == null) return [{ type: "text", text: "no team yet; run orchestra_create" }];
          return [
            {
              type: "text",
              text: `team ${value.team.topology}: ${value.team.roles
                .map((r) => `${r.id}(${r.status},R${r.rounds}${r.lastReport === null ? "" : `, report=${r.lastReport}`}${r.lastActivity === undefined ? "" : `, last="${r.lastActivity}"`})`)
                .join(", ")}`,
            },
          ];
        },
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_team requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        const team = cwd === undefined ? undefined : await loadTeam(ctx, cwd);
        if (team === undefined || team.archived === true) return { team: null };
        return {
          team: {
            topology: team.topology,
            createdAt: team.createdAt,
            executorSessionId: team.executorSessionId,
            roles: await Promise.all(team.roles.map((role) => roleStatus(ctx, role))),
          },
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_activate",
      description:
        "Reactivate the orchestra team after a DSH restart: resumes every role session that is not live (agents.resume with the role preset), then sends each role an activation notice. Live roles are skipped. Requires a team created by orchestra_create in this working directory.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            activated: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: { id: { type: "string", required: true }, sessionId: { type: "string", required: true } },
              },
            },
            skipped: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string", required: true },
                  sessionId: { type: "string", required: true },
                  reason: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `activated ${value.activated.length}, skipped ${value.skipped.length}${value.skipped.length === 0 ? "" : ` (${value.skipped.map((s) => s.id).join(",")})`}`,
          },
        ],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_activate requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const team = await loadTeam(ctx, cwd);
        if (team === undefined) throw new Error("no team yet; run orchestra_create first");
        const presets = ctx.get("agentPresets");
        const model = ctx.get("agentDefaultModel");
        const selection = model === undefined ? undefined : model.currentSelection();
        const activated: { id: string; sessionId: string }[] = [];
        const skipped: { id: string; sessionId: string; reason: string }[] = [];
        for (const role of team.roles) {
          if (ctx.agents.get(SID(role.sessionId)) !== undefined) {
            skipped.push({ id: role.id, sessionId: role.sessionId, reason: "live" });
            continue;
          }
          try {
            // Re-apply the role's creation-time model override when one was recorded;
            // otherwise fall back to the deployment default (legacy teams / no override).
            const override =
              role.model !== undefined &&
              (role.model.provider !== undefined || role.model.model !== undefined || role.model.reasoningEffort !== undefined)
                ? role.model
                : undefined;
            const agentOptions =
              override === undefined
                ? selection === undefined
                  ? {}
                  : { provider: selection.provider, model: selection.model }
                : {
                    ...(override.provider === undefined ? {} : { provider: override.provider }),
                    ...(override.model === undefined ? {} : { model: override.model }),
                  };
            let setup: ((agentCtx: Context) => Promise<void>) | undefined;
            if (presets !== undefined && role.preset !== null) {
              const resolved = await presets.resolve(role.preset);
              setup = async (agentCtx) => {
                await presets.mount(agentCtx, resolved.id);
                if (override !== undefined) {
                  installModelOverride(agentCtx, true, override.provider, override.model, override.reasoningEffort);
                }
              };
            } else if (override !== undefined) {
              setup = (agentCtx) => {
                installModelOverride(agentCtx, true, override.provider, override.model, override.reasoningEffort);
                return Promise.resolve();
              };
            }
            await ctx.agents.resume({
              resumeSessionId: SID(role.sessionId),
              agentOptions,
              ...(setup === undefined ? {} : { setup }),
              ...(exec.signal === undefined ? {} : { signal: exec.signal }),
            });
            sendRoleWelcome(ctx, exec.agent.id, role.sessionId, role.name, "The team has been reactivated. Continue working under your role discipline and wait for driver instructions.");
            activated.push({ id: role.id, sessionId: role.sessionId });
          } catch (error) {
            skipped.push({
              id: role.id,
              sessionId: role.sessionId,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return { activated, skipped };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_dismiss",
      description:
        "Close the current orchestra instance: archive state/team.json to orchestra/archive/team-<topology>-<createdAt>.json (full history preserved) and mark the instance as dismissed so a new one can be created in this working directory. Role sessions are independent assets and stay alive (close them in the GUI if wanted). Requires an instance created by orchestra_create or orchestra_spawn in this working directory.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            archived: { type: "boolean", required: true },
            archivePath: { type: "string", required: true },
            topology: { type: "string", required: true },
            createdAt: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `instance ${value.topology} archived to ${value.archivePath}`,
          },
        ],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_dismiss requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const team = await loadTeam(ctx, cwd);
        if (team === undefined) throw new Error("no team yet; run orchestra_create or orchestra_spawn first");
        if (team.archived === true) throw new Error("instance already dismissed");
        const archivePath = `${cwd}/orchestra/archive/team-${team.topology}-${team.createdAt}.json`;
        const archiveTarget = await ctx.fs.resolve(archivePath, { cwd });
        await ctx.fs.writeText(archiveTarget, JSON.stringify(team, null, 2), undefined, undefined, escrowPolicy(ctx, exec));
        const stateTarget = await ctx.fs.resolve(`${cwd}/orchestra/state/team.json`, { cwd });
        const marker = { archived: true, archivedAt: Date.now(), archivePath };
        await ctx.fs.writeText(stateTarget, JSON.stringify(marker, null, 2), undefined, undefined, escrowPolicy(ctx, exec));
        return { archived: true, archivePath, topology: team.topology, createdAt: team.createdAt };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_report",
      description:
        "Escrow write channel for role sessions under a read-only sandbox: write one file under orchestra/reports/ in the calling session's working directory. The path must be relative to orchestra/reports/ and must not contain \"..\". Returns the absolute path of the written file. Each successful write also books one delivered round on the calling role's team entry (rounds +1, lastReport = path). Reviewer roles use this to hand over review reports.",
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
        await ctx.fs.writeText(target, String(args.content ?? ""), undefined, undefined, escrowPolicy(ctx, exec));
        // Bookkeeping: record one delivered round on the calling role's team entry,
        // so orchestra_team reflects the delivered report without manual sync.
        // lastReport/return use the backend-canonical target (resolved path), so a
        // case- or symlink-variant of the same rel still records a stable path.
        try {
          const team = await loadTeam(ctx, cwd);
          if (team !== undefined && team.archived !== true) {
            const role = team.roles.find((entry) => entry.sessionId === agentId);
            if (role !== undefined) {
              role.rounds = (role.rounds ?? 0) + 1;
              role.lastReport = canonical;
              await saveTeam(ctx, cwd, team, escrowPolicy(ctx, exec));
            }
          }
        } catch (error) {
          console.error(
            `orchestra_report: team bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return { path: canonical };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "orchestra_topologies",
      description:
        "List available topology templates: user templates under <cwd>/orchestra/topologies/*.json plus the bundled fallback (duo). Use this before deciding whether to start from a template (orchestra_create) or orchestrate dynamically (orchestra_spawn).",
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
                        maxRounds: { type: "number" },
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
                        `${t.id} (${t.source})${t.description === undefined ? "" : `: ${t.description}`} [roles: ${t.roles.map((r) => r.id).join(", ")}]`,
                    )
                    .join("; "),
          },
        ],
      },
      async execute(_args, exec: ToolExecutionInput) {
        if (exec.agent === undefined) throw new Error("orchestra_topologies requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory");
        const templates: {
          id: string;
          name: string;
          description?: string;
          source: string;
          roles: { id: string; name: string; preset?: string; sandbox?: string; maxRounds?: number }[];
        }[] = [];
        try {
          const dirTarget = await ctx.fs.resolve(`${cwd}/orchestra/topologies`, { cwd });
          const info = await ctx.fs.stat(dirTarget);
          if (info !== undefined) {
            const entries = await ctx.fs.listDir(dirTarget);
            for (const entry of entries) {
              if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
              try {
                const raw = JSON.parse(await ctx.fs.readText(entry.target)) as TopologyConfig;
                if (typeof raw.id !== "string" || raw.id === "") continue;
                templates.push({
                  id: raw.id,
                  name: raw.name ?? raw.id,
                  ...(raw.description === undefined ? {} : { description: raw.description }),
                  source: "user",
                  roles: (raw.roles ?? []).map(templateRoleEntry),
                });
              } catch {
                // skip unparseable template files
              }
            }
          }
        } catch {
          // topologies directory missing → bundled only
        }
        for (const embedded of EMBEDDED_TEMPLATES) {
          if (templates.some((template) => template.id === embedded.id)) continue;
          templates.push({
            id: embedded.id,
            name: embedded.name ?? embedded.id,
            ...(embedded.description === undefined ? {} : { description: embedded.description }),
            source: "bundled",
            roles: embedded.roles.map(templateRoleEntry),
          });
        }
        return { templates };
      },
    }),
  );

  // Web surface: team/template state route for the settings panel (browser).
  // Registers lazily because headless profiles never mount a web server.
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
            // Global panel payload: built-in templates are unconditional (the
            // settings panes must show duo/trio/oracle even with zero GUI
            // workspaces); team instances are enumerated best-effort over the
            // GUI workspace registry plus session working directories.
            const templates: {
              id: string;
              name: string;
              description?: string;
              source: string;
              roles: { id: string; name: string; preset?: string; sandbox?: string; maxRounds?: number }[];
            }[] = [];
            const teams: {
              workspacePath: string;
              workspaceTitle?: string;
              topology: string;
              createdAt: number;
              executorSessionId: string;
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
                rounds: number;
                lastReport: string | null;
                lastActivity?: string;
              }[];
            }[] = [];
            // Root union = GUI workspace registry + session cwds, deduped.
            // sessionQuery.listSessions() enumerates the whole logical corpus;
            // falls back to registry-only when the service is unavailable.
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
              // User templates — global dedupe by id (first user definition wins).
              try {
                const dir = await ctx.fs.resolve(`${path}/orchestra/topologies`, { cwd: path });
                const info = await ctx.fs.stat(dir);
                if (info !== undefined) {
                  const entries = await ctx.fs.listDir(dir);
                  for (const entry of entries) {
                    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
                    try {
                      const raw = JSON.parse(await ctx.fs.readText(entry.target)) as TopologyConfig;
                      if (typeof raw.id !== "string" || raw.id === "" || templates.some((t) => t.id === raw.id)) continue;
                      templates.push({
                        id: raw.id,
                        name: raw.name ?? raw.id,
                        ...(raw.description === undefined ? {} : { description: raw.description }),
                        source: "user",
                        roles: (raw.roles ?? []).map((role) => ({
                          id: role.id,
                          name: role.name ?? role.id,
                          ...(role.preset === undefined || role.preset === null ? {} : { preset: role.preset }),
                          ...(role.sandbox === undefined ? {} : { sandbox: role.sandbox }),
                          ...(role.maxRounds === undefined ? {} : { maxRounds: role.maxRounds }),
                        })),
                      });
                    } catch {
                      // skip unparseable template files
                    }
                  }
                }
              } catch {
                // no topologies directory
              }
              // Current team instance.
              try {
                const teamTarget = await ctx.fs.resolve(`${path}/orchestra/state/team.json`, { cwd: path });
                const parsed = JSON.parse(await ctx.fs.readText(teamTarget)) as TeamState;
                if (parsed.archived !== true && Array.isArray(parsed.roles)) {
                  const roles = await Promise.all(
                    parsed.roles.map(async (record) => {
                      const status = await roleStatus(ctx, record);
                      return {
                        id: status.id,
                        name: status.name,
                        sessionId: status.sessionId,
                        ...(record.preset === undefined || record.preset === null ? {} : { preset: record.preset }),
                        ...(record.sandbox === undefined ? {} : { sandbox: record.sandbox }),
                        live: status.live,
                        status: status.status,
                        rounds: status.rounds,
                        lastReport: status.lastReport,
                        ...(status.lastActivity === undefined ? {} : { lastActivity: status.lastActivity }),
                      };
                    }),
                  );
                  teams.push({
                    workspacePath: path,
                    ...(root.title === undefined ? {} : { workspaceTitle: root.title }),
                    topology: parsed.topology,
                    createdAt: parsed.createdAt,
                    executorSessionId: parsed.executorSessionId,
                    archived: false,
                    roles,
                  });
                }
              } catch {
                // no active team
              }
              // Archived instances.
              try {
                const dir = await ctx.fs.resolve(`${path}/orchestra/archive`, { cwd: path });
                const info = await ctx.fs.stat(dir);
                if (info !== undefined) {
                  const entries = await ctx.fs.listDir(dir);
                  for (const entry of entries) {
                    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
                    try {
                      const raw = JSON.parse(await ctx.fs.readText(entry.target)) as TeamState;
                      teams.push({
                        workspacePath: path,
                        ...(root.title === undefined ? {} : { workspaceTitle: root.title }),
                        topology: raw.topology,
                        createdAt: raw.createdAt,
                        executorSessionId: raw.executorSessionId ?? "",
                        archived: true,
                        archivePath: `${path}/orchestra/archive/${entry.name}`,
                        roles: (raw.roles ?? []).map((role) => ({
                          id: role.id,
                          name: role.name,
                          sessionId: role.sessionId,
                          ...(role.preset === undefined || role.preset === null ? {} : { preset: role.preset }),
                          ...(role.sandbox === undefined ? {} : { sandbox: role.sandbox }),
                          live: false,
                          status: "archived",
                          rounds: role.rounds ?? 0,
                          lastReport: role.lastReport ?? null,
                        })),
                      });
                    } catch {
                      // skip unparseable archive files
                    }
                  }
                }
              } catch {
                // no archive directory
              }
            }
            // Built-in templates are unconditional (hard requirement): every id
            // not shadowed by a user template is always listed, even with zero
            // GUI workspaces / no session cwds.
            for (const embedded of EMBEDDED_TEMPLATES) {
              if (templates.some((template) => template.id === embedded.id)) continue;
              templates.push({
                id: embedded.id,
                name: embedded.name ?? embedded.id,
                ...(embedded.description === undefined ? {} : { description: embedded.description }),
                source: "bundled",
                roles: embedded.roles.map(templateRoleEntry),
              });
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ templates, teams }));
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
        "4. Proposal: report to the user — your understanding of the work, the topology you propose (which roles, each role's duty, why this setup helps). Propose only the roles the goal actually needs; never add roles the user did not ask for.\n" +
        "5. Approval: wait for the user's explicit go-ahead BEFORE creating any role sessions. A proposal is NOT approval: end your proposal turn with an explicit question/request for approval (e.g. ask whether they 放行). Until the user explicitly approves (e.g. replies \"放行\"), you must NOT create/spawn any role session.\n" +
        "6. Execute: create roles (orchestra_create for a matching template, orchestra_spawn per role otherwise), then dispatch self-contained tasks via a2a_send.\n" +
        "Dispatch tightness: dispatch every spawned role's task immediately — in the same round, or the round right after spawning. Never leave a spawned role taskless (a spawn-to-dispatch vacuum makes roles start working on their own). Independent tasks must be dispatched together in one round; never serialize independent work.\n" +
        "Stay in your role: you are the driver, not an implementer or a reviewer. Never fix, polish, or take over any role's work — implementation issues loop back to the implementer (via the implementer-reviewer flow), review findings go to the reviewer. Your job is decisions, dispatch, and coordination, not edits.\n" +
        "Deterministic routing (no mindless relaying): you are NOT an information hub. Messages inside a fixed flow go directly between roles — never through you. Example flow: implementer finishes and hands the result directly to reviewer; reviewer finds issues and sends them directly back to implementer for another round; reviewer's targeted re-check passes and THEN reviewer notifies you to advance. You only receive decision points: advances, blockers, new directions, cross-flow coordination. Do not forward what you do not need to know. Roles may call orchestra_team themselves to check team progress (team transparency).\n" +
        "All created roles are told to reply to you (their driver) via a2a_reply, never directly to the user; users interact with roles only through you. Track progress with orchestra_team; recover after restart with orchestra_activate; close the instance with orchestra_dismiss; list templates with orchestra_topologies.\n" +
        "Review flow: to task a reviewer, send via a2a_send a review_request message stating scope, changed locations, and the goal; fix findings one by one; at most two rounds (R2 only re-checks R1 findings); stop after R2 regardless of outcome; new issues go to the backlog for the user to decide. Read handoff reports (paths returned by roles) under orchestra/reports/. All cross-role messages must be self-contained.\n" +
        "Delivery contract: an a2a_send/a2a_reply to a running role is durable and NEVER lost — it is processed when that role's current turn ends (roles are single-threaded, one turn at a time). Do NOT send pure confirmation/ack messages once delivery is confirmed (message storms: they only pile up in a busy role's queue). Dispatch each task once; use interrupt:true only when a message must surface mid-turn.\n" +
        "Concurrency discipline (avoid information blocking): you are the bottleneck — every role report lands in your context. Parallel by default: dispatch independent tasks together in one round, never serialize independent work. Dependency-aware: when a task depends on another role's outcome, wait for that specific signal (orchestra_team / a2a_read / report path) before dispatching, and declare the dependency explicitly in the task. Minimize fan-in: ask roles to return concise summaries plus report paths, not full dumps; read report files only when needed. Do not over-orchestrate: if one session can do the job, do not spawn roles.",
    });
  }

  const commands = ctx.get("commands");
  if (commands !== undefined) {
    commands.register({
      name: "team",
      description: "Orchestra dynamic orchestration: state your goal; the orchestrator will clarify it, propose a topology (roles and duties), and create role sessions only after your approval.",
      input: { hint: "Describe the task or goal..." },
      recordInput: false,
      handler: (invocation) => {
        const raw = invocation.rawInput.trim();
        // Atomic delivery: marker + goal MUST arrive in the same turn.
        // Earlier this split into two followup() calls (plugin-source marker
        // + user-source goal), which the framework delivered in separate
        // turns — the model saw the marker alone, asked "what's the goal?",
        // and then the user's content arrived in the next turn as if it
        // were a separate chat message, breaking the 6-step onboarding.
        // Fix: send a single user-source message with the orchestra marker
        // as an embedded text prefix. The marker is still visible to the
        // user (now part of the same bubble, not a separate context row)
        // and the agent sees marker + goal as one unit in one turn.
        if (raw === "") {
          // No input yet: send just the marker as a plugin-source notice
          // so it stays out of the user bubble but lands in the same turn
          // as the agent's "what's the goal?" response.
          const marker = createUserMessage({
            content: [
              {
                type: "text",
                text: "(orchestra /team orchestration request: the user wants to open a team collaboration; start by confirming the goal)",
              },
            ] as ContentBlock[],
            source: {
              kind: "plugin",
              plugin: "orchestra",
              form: "notice",
              summary: "orchestra /team orchestration request",
            } as MessageSource,
          });
          invocation.agent.followup(marker);
        } else {
          // User provided input: combine marker + raw into one
          // user-source message so the agent sees both atomically.
          const text = `(orchestra /team orchestration request)\n\n${raw}`;
          const combined = createUserMessage({
            content: [{ type: "text", text }] as ContentBlock[],
            source: { kind: "user" } as MessageSource,
          });
          invocation.agent.followup(combined);
        }
        return { kind: "success", text: "Orchestration request accepted; starting team onboarding." };
      },
    });
  }
}
