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
import { createSession, installModelOverride, deliverMessage } from "./a2a.js";
import type { ResolvedPresetFile } from "./a2a.js";
import { prepareGovernedBlueprint } from "./session-blueprint.js";
import type { GovernedBlueprintReceipt, PreparedGovernedBlueprint } from "./session-blueprint.js";
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
import { createTopologyCatalog } from "./orchestra-topology.js";
import type { RoleConfig, TopologyCatalog, TopologyList, TopologyProtocol, TopologyResolution, TopologyRoleSummary } from "./orchestra-topology.js";
export { validateTopology } from "./orchestra-topology.js";
import { mountPreset } from "@deepseek-ai/dsh-agent-presets";
import "./relay-types.js";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, stat as fsStat } from "node:fs/promises";

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

/** Cordis plugin name used by loader diagnostics. */
export const name = "orchestra-manager";

/** Required services. */
export const inject = ["agents", "sessions", "fs", "sandboxPolicy", "tools", "timer"];

/** Builtin preset behavior packages (spec §5): written to the global root on install. */
interface BuiltinPreset {
  id: string;
  name: string;
  description: string;
  presetYml: string;
  cordisYml: string;
}

const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    id: "orchestra-implementer",
    name: "Orchestra Implementer",
    description: "Orchestra Implementer：实现者纪律（严格按派发任务 scope 实现、orchestra_report 交接、自包含回复）。",
    presetYml: "name: Orchestra Implementer\ndescription: Orchestra Implementer：实现者纪律（严格按派发任务 scope 实现、orchestra_report 交接、自包含回复）。\n",
    cordisYml: `# orchestra-implementer：实现者角色预设（orchestra 插件安装时注入）。
# 基底：minimal；融合方式：persona 段 = 角色纪律全文，
# complete: false + includeRuntimeContext: true —— 纪律 + 运行时上下文 + 工具 schema 共存。
#
# 工具集：fs/grep/glob/bash（workspace-write 沙箱由团队拓扑决定）+ 全局 a2a_* / orchestra_report。
# 不含：plan mode、goal、subagent 委派、workflow、web、compaction、PTY。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are a coding implementer (实现者) powered by the {{model}} model. Your working directory is {{cwd}}.

      # 角色
      你是独立会话中的实现者，负责实现 driver 通过 a2a_send 派发的任务，不负责评审、不负责最终验收判定。

      # 硬边界
      1. 只实现派发任务 spec 要求的内容：不扩 feature、不加变量、不改无关文件、不扩大范围。
      2. 不自我批准：你无权宣布自己的实现通过验收；验收判定属于 review / driver。
      3. 不直接回复用户：所有回复经 a2a_reply 发给 driver。
      4. 收到欢迎 / 激活消息不是任务：driver 派发具体任务前不开始工作。

      # 交接
      - 完成后用 orchestra_report 写交付说明到 orchestra/reports/（Markdown：改动清单、验证记录、已知风险、commit/diff 引用），回复 driver 时返回报告绝对路径 + 一行摘要。

      # 消息纪律
      - 每条回复必须自包含（driver 与评审看不到你的上下文）：结论先行，引用完整路径，不写"上面那个文件"。
    complete: false
    includeRuntimeContext: true

# 工作区治理规则（AGENTS.md）与主会话一致
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# 代码工具：消费宿主 fs 服务（无 realm，提供行）
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`,
  },
  {
    id: "orchestra-reviewer",
    name: "Orchestra Reviewer",
    description: "Orchestra Reviewer：极简基底 + 评审员纪律（只读审查、两轮定向评审、orchestra_report 文档交接）。",
    presetYml: "name: Orchestra Reviewer\ndescription: Orchestra Reviewer：极简基底 + 评审员纪律（只读审查、两轮定向评审、orchestra_report 文档交接）。\n",
    cordisYml: `# orchestra-reviewer：评审员角色预设（orchestra 插件安装时注入）。
# 基底：minimal（极简提示词）而非 standard（全量 800 行）。
# 融合方式：persona 段 = 角色纪律全文，complete: false + includeRuntimeContext: true
#   ——角色纪律段 + DSH 运行时上下文段 + 工具 schema 共存，不整体替换系统提示。
#
# 工具集：只读代码工具（fs 读 + grep/glob + bash，bash 受 read-only 沙箱硬约束）
#   + 全局注册的 a2a_* / orchestra_report（由本插件提供，任何预设可见）。
# 不含：plan mode、goal、subagent 委派、workflow、web、compaction、PTY。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are a coding reviewer (评审员) powered by the {{model}} model. Your working directory is {{cwd}}.

      # 角色
      你是独立评审会话中的评审员，只负责审查实现者交付的代码与变更，不负责实现。

      # 硬边界
      1. 你运行在只读沙箱中：不得用 bash 或 fs 工具修改、创建、删除任何文件，不得执行有写副作用的命令。
      2. 你唯一的写通道是 orchestra_report 工具，仅用于把 review report 写入 orchestra/reports/ 目录（工具会校验路径，你只需给出相对该目录的路径与内容）。
      3. 只响应 driver 发来的 review_request；绝不主动发起任务，绝不自行扩大审查范围。
      4. 不做设计决策、不重写方案；只对给定范围内的实现给出评审意见。
      5. 不自我扩展 scope：发现超出原范围的问题 → 提交 driver 决定（不纳入本轮或修改 mission），不自行扩大本轮审查。

      # 评审协议（硬上限：2 轮）
      - 第 1 轮（R1）：对实现者给出的变更做全量评审，输出 findings 清单，每条格式：[F编号] 严重度(blocker/major/minor/nit) | 位置(文件:行) | 问题 | 修复建议。
      - 第 2 轮（R2）：实现者修复后，只针对 R1 的 findings 逐条核对，标记 passed/failed；R2 后无论结果一律结束评审。
      - 新发现：R2 中发现的新问题不追加到本轮，记入 backlog 列表末尾，由 driver 决定是否另开评审。

      # 文档交接（重要）
      - 每轮评审结束后，把完整 review report 写入 orchestra/reports/review-<主题>-R<轮次>.md（Markdown：结论、findings 表格、backlog）。
      - 回复 driver 时直接返回 report 的绝对路径，正文只给一行结论 + 关键 findings 摘要，不重复全文。

      # 消息纪律
      - 每条回复必须自包含（driver 与实现者看不到你的上下文）：结论先行，引用完整路径，不写"上面那个文件"。
      - 每条回复开头标注 [R1]/[R2]，结尾给出 backlog 计数。
    complete: false
    includeRuntimeContext: true

# 工作区治理规则（AGENTS.md）与主会话一致
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# 只读代码工具：消费宿主 fs 服务（无 realm，提供行）
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

# bash：只读命令由 read-only 沙箱硬约束
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`,
  },
  {
    id: "orchestra-oracle",
    name: "Orchestra Oracle",
    description: "Orchestra Oracle：按需推演搭档（只读、只给建议不拍板、讨论即计划、orchestra_report 落结论）。",
    presetYml: "name: Orchestra Oracle\ndescription: Orchestra Oracle：按需推演搭档（只读、只给建议不拍板、讨论即计划、orchestra_report 落结论）。\n",
    cordisYml: `# orchestra-oracle：推演搭档角色预设（orchestra 插件安装时注入）。
# 基底：minimal；persona 段 = 角色纪律全文，complete: false + includeRuntimeContext: true。
# 工具集：只读代码工具 + 全局 a2a_* / orchestra_report。不含 plan mode / goal / 委派 / workflow。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are an oracle (推演搭档) powered by the {{model}} model. Your working directory is {{cwd}}.

      # 角色
      你是团队按需咨询的分析角色：处理其他角色无法低成本解决的不确定性（mission 解释冲突、架构争议、高影响取舍）。
      你不是常驻审批人，不进入每轮主流程，不主动接管任务。

      # 硬边界
      1. 只读沙箱：不得修改、创建、删除任何文件；唯一写通道是 orchestra_report。
      2. 只提供建议（recommendation + rationale + confidence + implications），不直接改变团队状态。
      3. 不发出 review PASS/FAIL、不关闭团队、不替代 driver 决策。
      4. 只响应明确的咨询请求（escalation）；请求应包含 question / known_facts / competing_options / requested_output。
      5. 收束问题：面对"你怎么看"式开放问题，先列出已知事实与可选方案，再给推荐。

      # 交接
      - 推演收敛后，用 orchestra_report 把设计结论写入 orchestra/reports/，回复请求方时返回报告路径。
      - 讨论即计划：推演过程就是计划生成过程；收敛后给出可直接派发的结论。
    complete: false
    includeRuntimeContext: true

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`,
  },
];

/**
 * Resolve a preset id to a concrete composition file (spec §5.3):
 * project (.orchestra/presets) > global (~/.dsh/orchestra/presets) >
 * DSH-native agentPresets > builtin (written to the global root on install).
 */
async function resolvePresetFile(ctx: Context, cwd: string, presetId: string): Promise<ResolvedPresetFile> {
  if (typeof presetId !== "string" || presetId === "") throw new Error("preset id must be a non-empty string");
  // Project-level
  try {
    const target = await ctx.fs.resolve(`${cwd}/.orchestra/presets/${presetId}/agent.cordis.yml`, { cwd });
    const info = await ctx.fs.stat(target);
    if (info !== undefined) return { id: presetId, trust: "user", path: ctx.fs.processPath(target) };
  } catch {
    // fall through
  }
  // Global orchestra root
  try {
    const presetPath = join(orchestraGlobalRoot(), "presets", presetId, "agent.cordis.yml");
    await fsStat(presetPath);
    return { id: presetId, trust: "user", path: presetPath };
  } catch {
    // fall through
  }
  // DSH-native presets
  const presets = ctx.get("agentPresets");
  if (presets !== undefined) {
    try {
      const resolved = await presets.resolve(presetId);
      return { id: resolved.id, trust: resolved.trust, path: resolved.path };
    } catch {
      // fall through
    }
  }
  // Builtin: ensure the global root copy exists, then mount it.
  const builtin = BUILTIN_PRESETS.find((preset) => preset.id === presetId);
  if (builtin === undefined) {
    throw new Error(`preset "${presetId}" not found (checked project .orchestra, global ${orchestraGlobalRoot()}, DSH presets, builtin)`);
  }
  const file = await ensureBuiltinPresetOnDisk(builtin);
  return { id: builtin.id, trust: "user", path: file };
}

/** Write one builtin preset to the global root if absent (install behavior; never overwrites). */
async function ensureBuiltinPresetOnDisk(preset: BuiltinPreset): Promise<string> {
  const dir = join(orchestraGlobalRoot(), "presets", preset.id);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "preset.yml"), preset.presetYml, "utf8");
    const cordisPath = join(dir, "agent.cordis.yml");
    await writeFile(cordisPath, preset.cordisYml, "utf8");
    return cordisPath;
  } catch (error) {
    console.error(
      `orchestra: failed to write builtin preset ${preset.id} to ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

/** Ensure builtin presets and Catalog-owned topology artifacts exist (install-time, idempotent). */
async function ensureBuiltinArtifacts(topologyCatalog: TopologyCatalog): Promise<void> {
  const root = orchestraGlobalRoot();
  for (const preset of BUILTIN_PRESETS) {
    try {
      const target = join(root, "presets", preset.id, "agent.cordis.yml");
      try {
        await fsStat(target);
        continue; // user content wins — never overwrite
      } catch {
        // absent → install
      }
      await ensureBuiltinPresetOnDisk(preset);
    } catch (error) {
      console.warn(
        `orchestra: could not install builtin preset ${preset.id} (in-memory fallback only): ${error instanceof Error ? error.message : String(error)}`,
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

function governedSessionId(teamId: string, roleId: string): string {
  const safeRole = roleId.replace(/[^A-Za-z0-9_-]+/g, "-");
  return `orchestra-${teamId}-${safeRole}`;
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

async function prepareGovernedRolePlan(
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
  const sessionId = governedSessionId(options.teamId, options.role.id);
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
    presetFile,
    permissionPreset: options.permissionPreset,
    ...(requestedSandbox === undefined ? {} : { sandbox: requestedSandbox as "read-only" | "workspace-write" | "danger-full-access" }),
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    runtime: options.role.runtime,
    requiredTools: (options.role as RoleConfig & { requiredTools?: string[] }).requiredTools,
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

interface GovernedProvisionResult {
  team: TeamState;
  snapshot: ActiveTeamReady;
  handles: AgentHandle[];
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
): Promise<GovernedProvisionResult> {
  let snapshot = initialSnapshot;
  let team = snapshot.team;
  let snapshotUsable = true;
  let failedRoleId: string | undefined;
  const handles: AgentHandle[] = [];
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

      const created = await createSession(ctx, {
        mode: "governed",
        sessionId: plan.sessionId,
        cwd,
        governedBlueprint: plan.blueprint,
        currentSessionId: exec.agent?.id,
        returnHandle: true,
        signal: exec.signal,
      });
      if (created.handle !== undefined) handles.push(created.handle);
      const welcome = await sendRoleWelcome(
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

const SECTION_NAME = "tool:orchestra";
const SECTION_ORDER = 119;

export const Config = undefined;

export function apply(ctx: Context): void {
  const activeTeamState = createActiveTeamStateStore(ctx.fs);
  const archiveStore = createArchiveStore(ctx.fs);
  const topologyCatalog = createTopologyCatalog(ctx.fs);
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

  // Install-time artifact seeding (spec §5.3): write builtin presets/topologies
  // to the global root when absent; never overwrites user content.
  void ensureBuiltinArtifacts(topologyCatalog).catch((error) => {
    console.error(`orchestra: builtin artifact install failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  ctx.tools.register(
    defineTool({
      name: "orchestra_create",
      description:
        "Create the orchestra team: for each role in the topology, spawn its session with the role preset, apply the role sandbox, record the mapping in orchestra/state/team.json (v1.1 with mission + topologyRef + controller), and send each role its welcome message. Run once per working directory; repeat calls fail while a team exists. Use orchestra_team to inspect the team afterwards.",
      parameters: {
        goal: { type: "string", required: true, description: "The team's mission objective — what \"done\" looks like. Stored as mission.objective." },
        topology: { type: "string", description: "Topology id. Defaults to \"duo\"." },
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
        args: {
          goal: string;
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
        },
        exec: ToolExecutionInput,
      ) {
        if (exec.agent === undefined) throw new Error("orchestra_create requires an agent caller");
        const cwd = exec.agent.session.header.cwd;
        if (cwd === undefined) throw new Error("current session has no working directory; cannot create a team");
        const existing = await activeTeamState.read(cwd, { signal: exec.signal });
        throwIfBlocked("create a team", existing);
        if (existing.kind === "ready")
          throw new Error(
            `a team already exists here (team=${existing.team.teamId}, topology=${existing.team.topologyRef.id}); run orchestra_dismiss to close it, or use another working directory`,
          );
        const objective = String(args.goal ?? "").trim();
        if (objective === "") throw new Error("goal must not be empty");
        const topologyResolution = await topologyCatalog.resolve(cwd, args.topology ?? "duo", { signal: exec.signal });
        if (topologyResolution.kind !== "ready") {
          const available = (await topologyCatalog.list(cwd, { signal: exec.signal })).ready.map((entry) => entry.config.id);
          throw topologyResolutionError("create a team", topologyResolution, available);
        }
        const topology = topologyResolution;
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
              title: `${projectSlugFromCwd(cwd)} · ${role.name} · ${topology.config.id}`,
              signal: exec.signal,
            }),
          );
        }
        const team: TeamState = {
          schemaVersion: 1,
          teamId,
          status: "provisioning",
          rootCwd: cwd,
          controllerSessionId: exec.agent.id,
          controllerHistory: [],
          topologyRef: { id: topology.config.id, source: topology.source },
          mission: {
            objective,
            scope: args.scope ?? [],
            constraints: args.constraints ?? [],
            acceptanceCriteria: args.acceptanceCriteria ?? [],
            nonGoals: args.nonGoals ?? [],
            context: args.context ?? "",
          },
          createdAt: Date.now(),
          activatedFromArchiveId: null,
          roles: plans.map(reservedRole),
          reports: [],
        };
        const reservation = await activeTeamState.create(cwd, team, {
          policy: escrowPolicy(ctx, exec),
          signal: exec.signal,
        });
        const initialSnapshot = await readySnapshotAfterWrite(activeTeamState, cwd, reservation, exec.signal);
        const provisioned = await provisionGovernedPlans(ctx, activeTeamState, exec, cwd, initialSnapshot, plans, "active", "failed");
        return {
          team_id: provisioned.team.teamId,
          status: provisioned.team.status,
          topology: provisioned.team.topologyRef.id,
          state_path: reservation.statePath,
          created_at: provisioned.team.createdAt,
          mission: provisioned.team.mission,
          roles: provisioned.team.roles.map((role) => ({
            id: role.id,
            sessionId: role.sessionId,
            live: ctx.agents.get(SID(role.sessionId)) !== undefined,
            phase: role.phase,
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
        throwIfBlocked("spawn a role", teamObservation);
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
          title: `${projectSlugFromCwd(cwd)} · ${roleName} · ${team.topologyRef.id}`,
          signal: exec.signal,
        });
        const reservedTeam: TeamState = {
          ...team,
          status: "provisioning",
          roles: [...team.roles, reservedRole(plan)],
        };
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
                title: `${projectSlugFromCwd(cwd)} · ${role.name} · ${newTeam.topologyRef.id}`,
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
        "List available topology templates (spec §4.1): project templates under <cwd>/.orchestra/topologies/*.json, global templates under ~/.dsh/orchestra/topologies/*.json, plus the bundled fallback (duo/trio/oracle/four-role-dev). Each entry shows source, controller, protocol (ownership/routes/completion), and roles. Use this before deciding whether to start from a template (orchestra_create) or orchestrate dynamically (orchestra_spawn).",
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
        "4. Proposal: report to the user — your understanding of the work, the topology you propose, and why this setup helps. A proposal IS a collaboration charter (编排 = 协作宪章): it must answer all seven questions — who does what; who owns each decision (ownership, one final owner per decision); where work goes when done (routes); what handoffs must carry; where disputes go (escalation); when loops end (round limits); who declares the team complete (closure). You MUST define routes and ownership; the number of roles (3 or 10) is entirely up to what the task needs — use your judgment, never add roles the user did not ask for, and self-check the six completeness tests: reachability, unique power, every output has a consumer, every loop has an exit, disputes have a destination, completion has a single owner.\n" +
        "5. Approval: wait for the user's explicit go-ahead BEFORE creating any role sessions. A proposal is NOT approval: end your proposal turn with an explicit question/request for approval (e.g. ask whether they 放行). Until the user explicitly approves (e.g. replies \"放行\"), you must NOT create/spawn any role session.\n" +
        "6. Execute: create roles (orchestra_create for a matching template, orchestra_spawn per role otherwise), then dispatch self-contained tasks via a2a_send.\n" +
        "Dispatch tightness: dispatch every spawned role's task immediately — in the same round, or the round right after spawning. Never leave a spawned role taskless (a spawn-to-dispatch vacuum makes roles start working on their own).\n" +
        "Parallelism discipline: parallelize everything that CAN run in parallel (dispatch independent tasks together in one round; never serialize independent work) but NEVER parallelize anything that would BLOCK or conflict (dependency-aware: wait for that specific signal — orchestra_team / a2a_read / report path — before dispatching, and declare the dependency explicitly in the task).\n" +
        "No filler messages: creation injects the welcome; injection IS the confirmation. Do NOT send extra confirmation/ack messages after a role is created or a delivery is confirmed — they pile up in the target's inbox (queue buildup). To check session state use orchestra_team (activity, reportCount, lastReport) or a2a_read (history) — never send a message to ask. Dispatch each task once; use interrupt:true only when a message must surface mid-turn.\n" +
        "Lightweight mode: for one-off collaboration (check a session, ask a question, read history) use the A2A tools directly (a2a_list/a2a_send/a2a_reply/a2a_read) — no team needed. Teams are for multi-role coordinated work.\n" +
        "Stay in your role: you are the driver, not an implementer or a reviewer. Never fix, polish, or take over any role's work — implementation issues loop back to the implementer (via the implementer-reviewer flow), review findings go to the reviewer. Your job is decisions, dispatch, and coordination, not edits.\n" +
        "Deterministic routing (no mindless relaying): you are NOT an information hub. Messages inside a fixed flow go directly between roles — never through you. Example flow: implementer finishes and hands the result directly to reviewer; reviewer finds issues and sends them directly back to implementer for another round; reviewer's targeted re-check passes and THEN reviewer notifies you to advance. You only receive decision points: advances, blockers, new directions, cross-flow coordination. Do not forward what you do not need to know. Roles may call orchestra_team themselves to check team progress (team transparency).\n" +
        "All created roles are told to reply to you (their driver) via a2a_reply, never directly to the user; users interact with roles only through you. Track progress with orchestra_team; recover after restart or after dismissal with orchestra_activate (archive_id required — list archives via orchestra_team); close the instance with orchestra_dismiss (archives the team, notifies roles, frees the cwd); list templates with orchestra_topologies.\n" +
        "Review flow: to task a reviewer, send via a2a_send a review_request message stating scope, changed locations, and the goal; fix findings one by one; at most two rounds (R2 only re-checks R1 findings); stop after R2 regardless of outcome; new issues go to the backlog for the user to decide. Read handoff reports (paths returned by roles) under orchestra/reports/. All cross-role messages must be self-contained.\n" +
        "Delivery contract: an a2a_send/a2a_reply to a running role is durable and NEVER lost — it is processed when that role's current turn ends (roles are single-threaded, one turn at a time). Receipts: live_inbox (accepted into the target's inbox — NOT yet processed), durable_inbox (recorded for a suspended thread), resumed_inbox (cold thread resumed first); a failed resume makes the call fail — never assume delivery from a queued state. Do NOT send pure confirmation/ack messages once delivery is confirmed (message storms).\n" +
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
