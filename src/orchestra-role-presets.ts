/**
 * Orchestra v0.4 Role Preset catalog.
 *
 * This is the single truth for role-preset ids, versioning, complete
 * composition bytes, capability planes, legacy compatibility and artifact
 * installation. Callers do not scan preset roots or manufacture composition
 * rows.
 */

import type { Context } from "@deepseek-ai/cordis";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type {} from "@deepseek-ai/dsh-fs";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as {
  load(source: string, options?: { schema?: unknown }): unknown;
};

export const ROLE_PRESET_VERSION = 1 as const;
export const V04_ROLE_PRESET_ID_PREFIX = "orchestra-v04-" as const;
export const ROLE_PRESET_COMPOSITION_FILE = "agent.cordis.yml" as const;
export const ROLE_PRESET_METADATA_FILE = "preset.yml" as const;
export const ROLE_PRESET_BUILTIN_DIRECTORY = "catalog-presets" as const;

export type RolePresetRole =
  | "implementer"
  | "reviewer"
  | "investigator"
  | "verifier"
  | "architect"
  | "researcher"
  | "hardening-auditor"
  | "oracle";

export type RolePresetStatus = "v04" | "legacy";
export type RolePresetBase = "standard" | "minimal" | "code";
export type RolePresetSource = "project" | "global" | "dsh" | "builtin";
export type RolePresetCapability =
  | "web"
  | "code-mode"
  | "subagent"
  | "sast"
  | "dast";

export interface RolePresetHandoffContract {
  requiredPayloadFields: string[];
  requiredEvidenceKinds: string[];
  postRemediationPayloadFields?: string[];
  postRemediationEvidenceKinds?: string[];
}

export interface RolePresetSpec {
  id: string;
  version: typeof ROLE_PRESET_VERSION;
  status: RolePresetStatus;
  role: RolePresetRole;
  name: string;
  purpose: string;
  baseStrategy: RolePresetBase;
  compositionSource: "builtin";
  compositionTools: string[];
  orchestraTools: string[];
  sandbox: SandboxMode;
  permissionPreset: string;
  modelStrategy: "deployment-default-pinned";
  optionalCapabilities: RolePresetCapability[];
  skills: boolean;
  compaction: boolean;
  planMode: boolean;
  todo: boolean;
  reportHandoff: RolePresetHandoffContract;
  reuse: {
    initial: string[];
    remediationOnly: string[];
    deferred: string[];
  };
  legacyIds: string[];
  presetYml: string;
  cordisYml: string;
}

export interface ParsedRolePresetComposition {
  rows: Record<string, unknown>[];
  rowIds: string[];
  pluginNames: string[];
}

export interface RolePresetFileResolution {
  id: string;
  trust: "system" | "user";
  path: string;
  source: RolePresetSource;
  spec?: RolePresetSpec;
  composition?: ParsedRolePresetComposition;
}

export interface RolePresetArtifactResult {
  id: string;
  status: "installed" | "exists" | "failed";
  path?: string;
  diagnostic?: { code: string; message: string };
}

export class RolePresetError extends Error {
  readonly code:
    | "invalid_id"
    | "invalid_spec"
    | "composition_invalid"
    | "composition_mismatch"
    | "preset_unavailable"
    | "filesystem"
    | "artifact_failed";
  readonly details?: Record<string, unknown>;

  constructor(
    code: RolePresetError["code"],
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RolePresetError";
    this.code = code;
    this.details = details;
  }
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function validPresetId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

function rolePrompt(role: RolePresetRole, purpose: string, write: boolean, baseStrategy: RolePresetBase, handoff: RolePresetHandoffContract): string {
  const writeRule = write
    ? "You may edit only the explicitly dispatched write scope; do not expand it."
    : "You are read-only for repository files; your only durable write is the Orchestra report channel.";
  return [
    "You are the Orchestra v0.4 " + role + " role.",
    "Base DSH composition strategy: " + baseStrategy + ".",
    purpose,
    writeRule,
    "Wait for a concrete driver dispatch; a welcome is not a task.",
    "Do not change the canonical Charter, Document, Graph, Journal or role roster.",
    "Do not claim another role's verdict, user approval or closure decision.",
    "Handoff payload fields: " + handoff.requiredPayloadFields.join(", ") + ".",
    "Required evidence kinds: " + handoff.requiredEvidenceKinds.join(", ") + ".",
    "Use orchestra_report for durable evidence and orchestra_handoff for typed milestones.",
  ].join(" ");
}

function renderComposition(options: {
  role: RolePresetRole;
  purpose: string;
  baseStrategy: RolePresetBase;
  compositionTools: readonly string[];
  skills: boolean;
  compaction: boolean;
  planMode: boolean;
  todo: boolean;
  optionalCapabilities: readonly RolePresetCapability[];
  reportHandoff: RolePresetHandoffContract;
  write: boolean;
}): string {
  const rows: string[] = [
    "- id: persona",
    "  name: '@deepseek-ai/dsh-persona'",
    "  config:",
    "    text: " + JSON.stringify(rolePrompt(options.role, options.purpose, options.write, options.baseStrategy, options.reportHandoff)),
    "    complete: false",
    "    includeRuntimeContext: true",
    "- id: agent-instructions",
    "  name: '@deepseek-ai/dsh-agent-instructions'",
    "  config:",
    "    maxBytes: 65536",
  ];

  if (options.compositionTools.includes("tool-fs")) {
    rows.push(
      "- id: tool-fs",
      "  name: '@deepseek-ai/dsh-tool-fs'",
    );
  }
  if (options.compositionTools.includes("tool-fs-search")) {
    rows.push(
      "- id: tool-fs-search",
      "  name: '@deepseek-ai/dsh-tool-fs-search'",
      "  config:",
      "    sampleOverCapGlobResults: false",
    );
  }
  if (options.compositionTools.includes("tool-bash")) {
    rows.push(
      "- id: tool-bash",
      "  name: '@deepseek-ai/dsh-tool-bash'",
    );
  }

  if (options.planMode) {
    rows.push(
      "- id: planning",
      "  name: cordis:group",
      "  group: true",
      "  isolate:",
      "    planMode: true",
      "  config:",
      "    - id: plan-mode",
      "      name: '@deepseek-ai/dsh-plan-mode'",
      "      config:",
      "        section: |",
      "          You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Explore with non-mutating reads and searches; do not edit or write files, run formatters, or carry out the plan. A user's conversational agreement approves nothing and does not end plan mode; fold confirmed decisions into the plan and submit it through exit_plan_mode.",
    );
  }
  if (options.todo) {
    rows.push(
      "- id: tool-todo",
      "  name: '@deepseek-ai/dsh-tool-todo'",
      "  config:",
      "    allowParallelInProgress: true",
    );
  }

  if (options.skills) {
    rows.push(
      "- id: skill-filesystem",
      "  name: '@deepseek-ai/dsh-skill-filesystem'",
      "- id: tool-skill",
      "  name: '@deepseek-ai/dsh-tool-skill'",
    );
  }

  if (options.compaction) {
    rows.push(
      "- id: compaction",
      "  name: cordis:group",
      "  group: true",
      "  isolate:",
      "    compaction: true",
      "  config:",
      "    - id: compaction-basic",
      "      name: '@deepseek-ai/dsh-compaction-basic'",
      "    - id: command-compact",
      "      name: '@deepseek-ai/dsh-command-compact'",
      "    - id: tool-result-pruner",
      "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      "      config:",
      "        thresholdChars: 8192",
      "        headChars: 4096",
      "        tailChars: 1024",
    );
  }
  if (options.optionalCapabilities.includes("web")) {
    rows.push(
      "- id: tool-web",
      "  name: '@deepseek-ai/dsh-tool-web'",
    );
  }
  if (options.optionalCapabilities.includes("code-mode")) {
    rows.push(
      "- id: tool-presentation",
      "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
      "  config:",
      "    mode: code",
    );
  }

  return rows.join("\n") + "\n";
}

function metadata(name: string, description: string): string {
  return [
    "name: " + JSON.stringify(name),
    "description: " + JSON.stringify(description),
  ].join("\n") + "\n";
}

function makeSpec(input: {
  id: string;
  status: RolePresetStatus;
  role: RolePresetRole;
  name: string;
  purpose: string;
  baseStrategy: RolePresetBase;
  compositionTools: string[];
  orchestraTools: string[];
  sandbox: SandboxMode;
  skills: boolean;
  compaction: boolean;
  planMode?: boolean;
  todo?: boolean;
  optionalCapabilities?: RolePresetCapability[];
  reportHandoff?: RolePresetHandoffContract;
  legacyIds?: string[];
  presetYml?: string;
  cordisYml?: string;
  reuse: RolePresetSpec["reuse"];
}): RolePresetSpec {
  const compositionTools = unique(input.compositionTools);
  const orchestraTools = unique(input.orchestraTools);
  const write = input.sandbox === "workspace-write";
  const reportHandoff = input.reportHandoff ?? {
    requiredPayloadFields: ["summary", "artifactRefs", "knownRisks"],
    requiredEvidenceKinds: ["report", "message"],
  };
  return {
    id: input.id,
    version: ROLE_PRESET_VERSION,
    status: input.status,
    role: input.role,
    name: input.name,
    purpose: input.purpose,
    baseStrategy: input.baseStrategy,
    compositionSource: "builtin",
    compositionTools,
    orchestraTools,
    sandbox: input.sandbox,
    permissionPreset: "workspace-write",
    modelStrategy: "deployment-default-pinned",
    optionalCapabilities: unique(input.optionalCapabilities ?? []),
    skills: input.skills,
    compaction: input.compaction,
    planMode: input.planMode ?? false,
    todo: input.todo ?? false,
    reportHandoff,
    reuse: input.reuse,
    legacyIds: unique(input.legacyIds ?? []),
    presetYml: input.presetYml ?? metadata(input.name, input.purpose),
    cordisYml: input.cordisYml ?? renderComposition({
      role: input.role,
      purpose: input.purpose,
      baseStrategy: input.baseStrategy,
      compositionTools,
      skills: input.skills,
      compaction: input.compaction,
      planMode: input.planMode ?? false,
      todo: input.todo ?? false,
      optionalCapabilities: [],
      reportHandoff,
      write,
    }),
  };
}

const V04_ROLE_PRESETS: RolePresetSpec[] = [
  makeSpec({
    id: "orchestra-v04-implementer-v1",
    status: "v04",
    role: "implementer",
    name: "Orchestra v0.4 Implementer",
    purpose: "Implement a dispatched feature or repair candidate and return bounded code evidence.",
    baseStrategy: "standard",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "workspace-write",
    skills: true,
    compaction: true,
    planMode: true,
    todo: true,
    optionalCapabilities: ["code-mode", "web", "subagent"],
    legacyIds: ["orchestra-implementer"],
    reportHandoff: {
      requiredPayloadFields: ["summary", "changedFiles", "knownRisks"],
      requiredEvidenceKinds: ["commit", "diff", "test", "report"],
    },
    reuse: {
      initial: ["feature-development", "bug-diagnosis-and-fix", "refactor-and-migration", "audit-and-hardening"],
      remediationOnly: ["architecture-decision"],
      deferred: ["release-readiness"],
    },
  }),
  makeSpec({
    id: "orchestra-v04-reviewer-v1",
    status: "v04",
    role: "reviewer",
    name: "Orchestra v0.4 Reviewer",
    purpose: "Review a bounded candidate and record evidence-backed PASS, FAIL or BLOCKED verdicts.",
    baseStrategy: "standard",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_verdict", "orchestra_handoff"],
    sandbox: "read-only",
    skills: true,
    compaction: true,
    optionalCapabilities: ["web"],
    legacyIds: ["orchestra-reviewer"],
    reportHandoff: {
      requiredPayloadFields: ["summary", "verdict", "unresolvedFindings"],
      requiredEvidenceKinds: ["report", "diff", "test"],
    },
    reuse: {
      initial: ["feature-development", "bug-diagnosis-and-fix", "refactor-and-migration", "architecture-decision", "audit-and-hardening"],
      remediationOnly: [],
      deferred: ["release-readiness"],
    },
  }),
  makeSpec({
    id: "orchestra-v04-investigator-v1",
    status: "v04",
    role: "investigator",
    name: "Orchestra v0.4 Investigator",
    purpose: "Establish reproduction, root-cause evidence, repair scope and unknowns before implementation.",
    baseStrategy: "standard",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "read-only",
    skills: true,
    compaction: true,
    optionalCapabilities: ["web"],
    reportHandoff: {
      requiredPayloadFields: ["symptom", "reproduction", "rootCause", "repairScope", "knownRisks"],
      requiredEvidenceKinds: ["report", "test", "message", "file"],
    },
    reuse: {
      initial: ["bug-diagnosis-and-fix", "audit-and-hardening"],
      remediationOnly: ["feature-development"],
      deferred: ["release-readiness"],
    },
  }),
  makeSpec({
    id: "orchestra-v04-verifier-v1",
    status: "v04",
    role: "verifier",
    name: "Orchestra v0.4 Verifier",
    purpose: "Interpret deterministic command results and assemble reproducible acceptance evidence.",
    baseStrategy: "standard",
    compositionTools: ["tool-bash", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "read-only",
    skills: false,
    compaction: true,
    reportHandoff: {
      requiredPayloadFields: ["command", "exit", "scope", "evidenceRefs", "unexecuted"],
      requiredEvidenceKinds: ["test", "diff", "report"],
    },
    reuse: {
      initial: ["feature-development", "bug-diagnosis-and-fix", "refactor-and-migration", "audit-and-hardening"],
      remediationOnly: [],
      deferred: ["release-readiness"],
    },
  }),
  makeSpec({
    id: "orchestra-v04-architect-v1",
    status: "v04",
    role: "architect",
    name: "Orchestra v0.4 Architect",
    purpose: "Synthesize constraints, alternatives, tradeoffs and impact into a decision or migration brief.",
    baseStrategy: "standard",
    compositionTools: ["tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "read-only",
    skills: true,
    compaction: true,
    optionalCapabilities: ["web"],
    reportHandoff: {
      requiredPayloadFields: ["decisionQuestion", "alternatives", "recommendation", "tradeoffs", "constraints", "migrationImpact", "unknowns"],
      requiredEvidenceKinds: ["report", "file", "url"],
    },
    reuse: {
      initial: ["architecture-decision", "refactor-and-migration"],
      remediationOnly: ["feature-development", "bug-diagnosis-and-fix", "audit-and-hardening"],
      deferred: ["release-readiness"],
    },
  }),
  makeSpec({
    id: "orchestra-v04-researcher-v1",
    status: "v04",
    role: "researcher",
    name: "Orchestra v0.4 Researcher",
    purpose: "Collect source-backed local facts, unknowns and option inputs without deciding the outcome.",
    baseStrategy: "standard",
    compositionTools: ["tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "read-only",
    skills: true,
    compaction: true,
    optionalCapabilities: ["web"],
    reportHandoff: {
      requiredPayloadFields: ["sourceRefs", "facts", "unknowns", "factInference", "nextQuestions"],
      requiredEvidenceKinds: ["url", "file", "report"],
    },
    reuse: {
      initial: ["architecture-decision"],
      remediationOnly: ["bug-diagnosis-and-fix", "refactor-and-migration"],
      deferred: ["product-or-ui-design", "release-readiness", "audit-and-hardening"],
    },
  }),
  makeSpec({
    id: "orchestra-v04-hardening-auditor-v1",
    status: "v04",
    role: "hardening-auditor",
    name: "Orchestra v0.4 Hardening Auditor",
    purpose: "Produce reproducible security or reliability findings and define remediation and rescan evidence.",
    baseStrategy: "standard",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "read-only",
    skills: true,
    compaction: true,
    optionalCapabilities: ["web", "sast", "dast"],
    reportHandoff: {
      requiredPayloadFields: ["fingerprint", "asset", "location", "impact", "severity", "fix", "reproductionOrWhyNot"],
      requiredEvidenceKinds: ["report", "file", "message"],
      postRemediationPayloadFields: ["originalFinding", "rescan", "regression", "residualRisk"],
      postRemediationEvidenceKinds: ["test", "diff", "report"],
    },
    reuse: {
      initial: ["audit-and-hardening"],
      remediationOnly: [],
      deferred: ["release-readiness"],
    },
  }),
];

const LEGACY_IMPLEMENTER_PRESET_YML = "name: Orchestra Implementer\ndescription: Orchestra Implementer：实现者纪律（严格按派发任务 scope 实现、orchestra_report 交接、自包含回复）。\n";
const LEGACY_IMPLEMENTER_CORDIS_YML = "# orchestra-implementer：实现者角色预设（orchestra 插件安装时注入）。\n# 基底：minimal；融合方式：persona 段 = 角色纪律全文，\n# complete: false + includeRuntimeContext: true —— 纪律 + 运行时上下文 + 工具 schema 共存。\n#\n# 工具集：fs/grep/glob/bash（workspace-write 沙箱由团队拓扑决定）+ 全局 a2a_* / orchestra_report。\n# 不含：plan mode、goal、subagent 委派、workflow、web、compaction、PTY。\n\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |\n      You are a coding implementer (实现者) powered by the {{model}} model. Your working directory is {{cwd}}.\n\n      # 角色\n      你是独立会话中的实现者，负责实现 driver 通过 a2a_send 派发的任务，不负责评审、不负责最终验收判定。\n\n      # 硬边界\n      1. 只实现派发任务 spec 要求的内容：不扩 feature、不加变量、不改无关文件、不扩大范围。\n      2. 不自我批准：你无权宣布自己的实现通过验收；验收判定属于 review / driver。\n      3. 不直接回复用户：所有回复经 a2a_reply 发给 driver。\n      4. 收到欢迎 / 激活消息不是任务：driver 派发具体任务前不开始工作。\n\n      # 交接\n      - 完成后用 orchestra_report 写交付说明到 orchestra/reports/（Markdown：改动清单、验证记录、已知风险、commit/diff 引用），回复 driver 时返回报告绝对路径 + 一行摘要。\n\n      # 消息纪律\n      - 每条回复必须自包含（driver 与评审看不到你的上下文）：结论先行，引用完整路径，不写\"上面那个文件\"。\n    complete: false\n    includeRuntimeContext: true\n\n# 工作区治理规则（AGENTS.md）与主会话一致\n- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n\n# 代码工具：消费宿主 fs 服务（无 realm，提供行）\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false\n\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n";
const LEGACY_REVIEWER_PRESET_YML = "name: Orchestra Reviewer\ndescription: Orchestra Reviewer：极简基底 + 评审员纪律（只读审查、两轮定向评审、orchestra_report 文档交接）。\n";
const LEGACY_REVIEWER_CORDIS_YML = "# orchestra-reviewer：评审员角色预设（orchestra 插件安装时注入）。\n# 基底：minimal（极简提示词）而非 standard（全量 800 行）。\n# 融合方式：persona 段 = 角色纪律全文，complete: false + includeRuntimeContext: true\n#   ——角色纪律段 + DSH 运行时上下文段 + 工具 schema 共存，不整体替换系统提示。\n#\n# 工具集：只读代码工具（fs 读 + grep/glob + bash，bash 受 read-only 沙箱硬约束）\n#   + 全局注册的 a2a_* / orchestra_report（由本插件提供，任何预设可见）。\n# 不含：plan mode、goal、subagent 委派、workflow、web、compaction、PTY。\n\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |\n      You are a coding reviewer (评审员) powered by the {{model}} model. Your working directory is {{cwd}}.\n\n      # 角色\n      你是独立评审会话中的评审员，只负责审查实现者交付的代码与变更，不负责实现。\n\n      # 硬边界\n      1. 你运行在只读沙箱中：不得用 bash 或 fs 工具修改、创建、删除任何文件，不得执行有写副作用的命令。\n      2. 你唯一的写通道是 orchestra_report 工具，仅用于把 review report 写入 orchestra/reports/ 目录（工具会校验路径，你只需给出相对该目录的路径与内容）。\n      3. 只响应 driver 发来的 review_request；绝不主动发起任务，绝不自行扩大审查范围。\n      4. 不做设计决策、不重写方案；只对给定范围内的实现给出评审意见。\n      5. 不自我扩展 scope：发现超出原范围的问题 → 提交 driver 决定（不纳入本轮或修改 mission），不自行扩大本轮审查。\n\n      # 评审协议（硬上限：2 轮）\n      - 第 1 轮（R1）：对实现者给出的变更做全量评审，输出 findings 清单，每条格式：[F编号] 严重度(blocker/major/minor/nit) | 位置(文件:行) | 问题 | 修复建议。\n      - 第 2 轮（R2）：实现者修复后，只针对 R1 的 findings 逐条核对，标记 passed/failed；R2 后无论结果一律结束评审。\n      - 新发现：R2 中发现的新问题不追加到本轮，记入 backlog 列表末尾，由 driver 决定是否另开评审。\n\n      # 文档交接（重要）\n      - 每轮评审结束后，把完整 review report 写入 orchestra/reports/review-<主题>-R<轮次>.md（Markdown：结论、findings 表格、backlog）。\n      - 回复 driver 时直接返回 report 的绝对路径，正文只给一行结论 + 关键 findings 摘要，不重复全文。\n\n      # 消息纪律\n      - 每条回复必须自包含（driver 与实现者看不到你的上下文）：结论先行，引用完整路径，不写\"上面那个文件\"。\n      - 每条回复开头标注 [R1]/[R2]，结尾给出 backlog 计数。\n    complete: false\n    includeRuntimeContext: true\n\n# 工作区治理规则（AGENTS.md）与主会话一致\n- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n\n# 只读代码工具：消费宿主 fs 服务（无 realm，提供行）\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false\n\n# bash：只读命令由 read-only 沙箱硬约束\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n";
const LEGACY_ORACLE_PRESET_YML = "name: Orchestra Oracle\ndescription: Orchestra Oracle：按需推演搭档（只读、只给建议不拍板、讨论即计划、orchestra_report 落结论）。\n";
const LEGACY_ORACLE_CORDIS_YML = "# orchestra-oracle：推演搭档角色预设（orchestra 插件安装时注入）。\n# 基底：minimal；persona 段 = 角色纪律全文，complete: false + includeRuntimeContext: true。\n# 工具集：只读代码工具 + 全局 a2a_* / orchestra_report。不含 plan mode / goal / 委派 / workflow。\n\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |\n      You are an oracle (推演搭档) powered by the {{model}} model. Your working directory is {{cwd}}.\n\n      # 角色\n      你是团队按需咨询的分析角色：处理其他角色无法低成本解决的不确定性（mission 解释冲突、架构争议、高影响取舍）。\n      你不是常驻审批人，不进入每轮主流程，不主动接管任务。\n\n      # 硬边界\n      1. 只读沙箱：不得修改、创建、删除任何文件；唯一写通道是 orchestra_report。\n      2. 只提供建议（recommendation + rationale + confidence + implications），不直接改变团队状态。\n      3. 不发出 review PASS/FAIL、不关闭团队、不替代 driver 决策。\n      4. 只响应明确的咨询请求（escalation）；请求应包含 question / known_facts / competing_options / requested_output。\n      5. 收束问题：面对\"你怎么看\"式开放问题，先列出已知事实与可选方案，再给推荐。\n\n      # 交接\n      - 推演收敛后，用 orchestra_report 把设计结论写入 orchestra/reports/，回复请求方时返回报告路径。\n      - 讨论即计划：推演过程就是计划生成过程；收敛后给出可直接派发的结论。\n    complete: false\n    includeRuntimeContext: true\n\n- id: agent-instructions\n  name: '@deepseek-ai/dsh-agent-instructions'\n  config:\n    maxBytes: 65536\n\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false\n\n- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n";

const LEGACY_ROLE_PRESETS: RolePresetSpec[] = [
  makeSpec({
    id: "orchestra-implementer",
    status: "legacy",
    role: "implementer",
    name: "Orchestra Implementer",
    purpose: "Legacy v0.3 implementer discipline. Existing user files remain authoritative.",
    presetYml: LEGACY_IMPLEMENTER_PRESET_YML,
    cordisYml: LEGACY_IMPLEMENTER_CORDIS_YML,
    baseStrategy: "minimal",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "workspace-write",
    skills: false,
    compaction: false,
    reuse: { initial: [], remediationOnly: [], deferred: [] },
  }),
  makeSpec({
    id: "orchestra-reviewer",
    status: "legacy",
    role: "reviewer",
    name: "Orchestra Reviewer",
    purpose: "Legacy v0.3 read-only reviewer discipline. Existing user files remain authoritative.",
    presetYml: LEGACY_REVIEWER_PRESET_YML,
    cordisYml: LEGACY_REVIEWER_CORDIS_YML,
    baseStrategy: "minimal",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_verdict", "orchestra_handoff"],
    sandbox: "read-only",
    skills: false,
    compaction: false,
    reuse: { initial: [], remediationOnly: [], deferred: [] },
  }),
  makeSpec({
    id: "orchestra-oracle",
    status: "legacy",
    role: "oracle",
    name: "Orchestra Oracle",
    purpose: "Legacy v0.3 advisory oracle discipline. Existing user files remain authoritative.",
    presetYml: LEGACY_ORACLE_PRESET_YML,
    cordisYml: LEGACY_ORACLE_CORDIS_YML,
    baseStrategy: "minimal",
    compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
    orchestraTools: ["orchestra_report", "orchestra_handoff"],
    sandbox: "read-only",
    skills: false,
    compaction: false,
    reuse: { initial: [], remediationOnly: [], deferred: [] },
  }),
];

export const BUILTIN_ROLE_PRESETS: readonly RolePresetSpec[] = Object.freeze(V04_ROLE_PRESETS);
export const LEGACY_BUILTIN_ROLE_PRESETS: readonly RolePresetSpec[] = Object.freeze(LEGACY_ROLE_PRESETS);
export const ALL_BUILTIN_ROLE_PRESETS: readonly RolePresetSpec[] = Object.freeze([
  ...V04_ROLE_PRESETS,
  ...LEGACY_ROLE_PRESETS,
]);

const PRESET_BY_ID = new Map(ALL_BUILTIN_ROLE_PRESETS.map((spec) => [spec.id, spec]));

export function rolePresetSpec(id: string): RolePresetSpec | undefined {
  return PRESET_BY_ID.get(id);
}

export function v04RolePresetSpecs(): readonly RolePresetSpec[] {
  return BUILTIN_ROLE_PRESETS;
}

export function legacyRolePresetSpecs(): readonly RolePresetSpec[] {
  return LEGACY_BUILTIN_ROLE_PRESETS;
}

export function rolePresetIdIsSafe(id: string): boolean {
  return validPresetId(id);
}

export function renderRolePresetComposition(
  spec: RolePresetSpec,
  enabledOptionalCapabilities: readonly RolePresetCapability[] = [],
): string {
  const enabled = unique(enabledOptionalCapabilities);
  const unsupported = enabled.filter((capability) => !["web", "code-mode"].includes(capability));
  if (unsupported.length > 0) {
    throw new RolePresetError(
      "invalid_spec",
      "optional capability variant is not implemented in 6B-0: " + unsupported.join(", "),
      { id: spec.id, unsupported },
    );
  }
  const undeclared = enabled.filter((capability) => !spec.optionalCapabilities.includes(capability));
  if (undeclared.length > 0) {
    throw new RolePresetError(
      "invalid_spec",
      "optional capability is not declared by " + spec.id + ": " + undeclared.join(", "),
      { id: spec.id, undeclared },
    );
  }
  return renderComposition({
    role: spec.role,
    purpose: spec.purpose,
    baseStrategy: spec.baseStrategy,
    compositionTools: spec.compositionTools,
    skills: spec.skills,
    compaction: spec.compaction,
    planMode: spec.planMode,
    todo: spec.todo,
    optionalCapabilities: enabled,
    reportHandoff: spec.reportHandoff,
    write: spec.sandbox === "workspace-write",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRolePresetComposition(text: string): ParsedRolePresetComposition {
  let parsed: unknown;
  try {
    parsed = yaml.load(text, { schema: entryListSchema });
  } catch (error) {
    throw new RolePresetError(
      "composition_invalid",
      "role preset composition is not valid DSH rc.6 YAML: " + (error instanceof Error ? error.message : String(error)),
      undefined,
      error,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RolePresetError("composition_invalid", "role preset composition must be a top-level plugin row list");
  }

  const rows: Record<string, unknown>[] = [];
  const rowIds: string[] = [];
  const pluginNames: string[] = [];
  const visit = (items: unknown[], prefix: string): void => {
    for (const [index, item] of items.entries()) {
      if (!isRecord(item) || typeof item.name !== "string" || item.name === "") {
        throw new RolePresetError("composition_invalid", "invalid plugin row at " + (prefix === "" ? String(index) : prefix + "." + String(index)));
      }
      const id = item.id;
      if (typeof id === "string" && id !== "") {
        if (rowIds.includes(id)) throw new RolePresetError("composition_invalid", "duplicate plugin row id " + id);
        rowIds.push(id);
      }
      pluginNames.push(item.name);
      rows.push(item);
      if (item.group === true) {
        if (!Array.isArray(item.config)) throw new RolePresetError("composition_invalid", "group row " + String(id ?? index) + " must have a nested plugin list");
        visit(item.config, prefix === "" ? String(index) : prefix + "." + String(index));
      }
    }
  };
  visit(parsed, "");
  return { rows, rowIds, pluginNames };
}

function commonCompositionProblems(composition: ParsedRolePresetComposition): string[] {
  const problems: string[] = [];
  if (!composition.rowIds.includes("persona")) problems.push("persona row is required");
  if (!composition.rowIds.includes("agent-instructions")) problems.push("agent-instructions row is required");
  const hasToolRow = composition.rowIds.some((id) => id.startsWith("tool-")) || composition.pluginNames.some((name) => name.includes("dsh-tool-"));
  if (!hasToolRow) problems.push("at least one model-facing tool row is required");
  for (const id of composition.rowIds) {
    if (id.startsWith("orchestra_") || id.startsWith("a2a_")) problems.push("host row id cannot be in DSH composition: " + id);
  }
  for (const name of composition.pluginNames) {
    if (name.startsWith("orchestra_") || name.startsWith("a2a_")) problems.push("host plugin cannot be in DSH composition: " + name);
  }
  return problems;
}

export function validateRolePresetSpec(spec: RolePresetSpec): string[] {
  const problems: string[] = [];
  if (!validPresetId(spec.id)) problems.push("invalid preset id");
  if (spec.version !== ROLE_PRESET_VERSION) problems.push("unsupported preset version");
  if (spec.status === "v04" && !spec.id.startsWith(V04_ROLE_PRESET_ID_PREFIX)) problems.push("v0.4 id is not versioned");
  if (spec.status === "legacy" && spec.id.startsWith(V04_ROLE_PRESET_ID_PREFIX)) problems.push("legacy id uses v0.4 prefix");
  if (spec.sandbox !== "read-only" && spec.sandbox !== "workspace-write") problems.push("danger-full-access is not a role default");
  if (spec.permissionPreset !== "workspace-write") problems.push("role default permission must be workspace-write");
  if (spec.modelStrategy !== "deployment-default-pinned") problems.push("model strategy is not pinned deployment default");
  if (spec.orchestraTools.some((name) => name.startsWith("orchestra_") === false)) problems.push("orchestraTools must use Orchestra host names");
  if (spec.compositionTools.some((name) => name.startsWith("orchestra_") || name.startsWith("a2a_"))) problems.push("host tools cannot be compositionTools");
  if (spec.reportHandoff.requiredPayloadFields.length === 0 || spec.reportHandoff.requiredEvidenceKinds.length === 0) problems.push("report/handoff contract is incomplete");
  if (spec.status === "v04") {
    const expected = expectedRoleHandoff(spec.role);
    if (JSON.stringify(spec.reportHandoff) !== JSON.stringify(expected)) problems.push("report/handoff contract does not match the frozen role contract");
  }
  let composition: ParsedRolePresetComposition;
  try {
    composition = parseRolePresetComposition(spec.cordisYml);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  problems.push(...commonCompositionProblems(composition));
  for (const tool of spec.compositionTools) {
    if (!composition.rowIds.includes(tool)) problems.push("composition tool row is missing: " + tool);
  }
  if (!composition.rowIds.includes("persona") || !composition.rowIds.includes("agent-instructions")) {
    problems.push("persona and agent-instructions rows are required");
  }
  if (spec.skills && (!composition.rowIds.includes("skill-filesystem") || !composition.rowIds.includes("tool-skill"))) {
    problems.push("skills rows are required");
  }
  if (spec.compaction && !composition.rowIds.includes("compaction")) problems.push("compaction row is required");
  if (spec.planMode && !composition.rowIds.includes("planning")) problems.push("plan-mode row is required");
  if (spec.todo && !composition.rowIds.includes("tool-todo")) problems.push("todo row is required");
  const forbidden = ["delegation", "tool-subagent", "tool-goal", "tool-presentation"];
  for (const id of forbidden) if (composition.rowIds.includes(id)) problems.push("forbidden default row is present: " + id);
  return problems;
}

function expectedRoleHandoff(role: RolePresetRole): RolePresetHandoffContract {
  switch (role) {
    case "implementer":
      return { requiredPayloadFields: ["summary", "changedFiles", "knownRisks"], requiredEvidenceKinds: ["commit", "diff", "test", "report"] };
    case "reviewer":
      return { requiredPayloadFields: ["summary", "verdict", "unresolvedFindings"], requiredEvidenceKinds: ["report", "diff", "test"] };
    case "investigator":
      return { requiredPayloadFields: ["symptom", "reproduction", "rootCause", "repairScope", "knownRisks"], requiredEvidenceKinds: ["report", "test", "message", "file"] };
    case "verifier":
      return { requiredPayloadFields: ["command", "exit", "scope", "evidenceRefs", "unexecuted"], requiredEvidenceKinds: ["test", "diff", "report"] };
    case "architect":
      return { requiredPayloadFields: ["decisionQuestion", "alternatives", "recommendation", "tradeoffs", "constraints", "migrationImpact", "unknowns"], requiredEvidenceKinds: ["report", "file", "url"] };
    case "researcher":
      return { requiredPayloadFields: ["sourceRefs", "facts", "unknowns", "factInference", "nextQuestions"], requiredEvidenceKinds: ["url", "file", "report"] };
    case "hardening-auditor":
      return {
        requiredPayloadFields: ["fingerprint", "asset", "location", "impact", "severity", "fix", "reproductionOrWhyNot"],
        requiredEvidenceKinds: ["report", "file", "message"],
        postRemediationPayloadFields: ["originalFinding", "rescan", "regression", "residualRisk"],
        postRemediationEvidenceKinds: ["test", "diff", "report"],
      };
    case "oracle":
      return { requiredPayloadFields: ["summary", "artifactRefs", "knownRisks"], requiredEvidenceKinds: ["report", "message"] };
  }
}

export function validateAllRolePresetSpecs(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const spec of ALL_BUILTIN_ROLE_PRESETS) {
    if (ids.has(spec.id)) problems.push("duplicate role preset id: " + spec.id);
    ids.add(spec.id);
    problems.push(...validateRolePresetSpec(spec).map((problem) => spec.id + ": " + problem));
  }
  return problems;
}

function isMissingError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return code === "ENOENT" || code === "FS_NOT_FOUND";
}

function isUnknownPresetError(error: unknown): boolean {
  if (error instanceof Error && error.name === "UnknownPresetError") return true;
  if (isRecord(error) && (error.code === "UNKNOWN_PRESET" || error.name === "UnknownPresetError")) return true;
  return error instanceof Error && /unknown preset|preset .* not found/i.test(error.message);
}

interface Candidate {
  path: string;
  trust: "system" | "user";
  source: RolePresetSource;
  text: string;
}

function validateCandidate(spec: RolePresetSpec | undefined, candidate: Candidate): ParsedRolePresetComposition | undefined {
  let composition: ParsedRolePresetComposition;
  try {
    composition = parseRolePresetComposition(candidate.text);
  } catch (error) {
    throw new RolePresetError(
      "composition_invalid",
      "preset " + (spec?.id ?? "custom") + " at " + candidate.path + " is not mountable: " + (error instanceof Error ? error.message : String(error)),
      { id: spec?.id ?? "custom", source: candidate.source, path: candidate.path },
      error,
    );
  }
  const commonProblems = commonCompositionProblems(composition);
  if (spec === undefined) {
    if (commonProblems.length > 0) {
      throw new RolePresetError(
        "preset_unavailable",
        "custom preset " + candidate.path + " is not a complete composition: " + commonProblems.join("; "),
        { source: candidate.source, path: candidate.path, problems: commonProblems },
      );
    }
    return composition;
  }
  const expectedProblems = validateRolePresetSpec({ ...spec, cordisYml: candidate.text });
  if (expectedProblems.length > 0) {
    throw new RolePresetError(
      "composition_mismatch",
      "preset " + spec.id + " at " + candidate.path + " does not satisfy its catalog contract: " + expectedProblems.join("; "),
      { id: spec.id, source: candidate.source, path: candidate.path, problems: expectedProblems },
    );
  }
  return composition;
}

async function projectCandidate(ctx: Context, cwd: string, id: string): Promise<Candidate | undefined> {
  const fs = ctx.fs;
  let target;
  try {
    target = await fs.resolve(cwd + "/.orchestra/presets/" + id + "/" + ROLE_PRESET_COMPOSITION_FILE, { cwd });
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw new RolePresetError("filesystem", "project preset path could not be resolved for " + id, { id, cwd }, error);
  }
  let info;
  try {
    info = await fs.stat(target);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw new RolePresetError("filesystem", "project preset could not be statted for " + id, { id, cwd }, error);
  }
  if (info === undefined) return undefined;
  const path = fs.processPath(target);
  let text: string;
  try {
    text = await fs.readText(target);
  } catch (error) {
    throw new RolePresetError("filesystem", "project preset could not be read at " + path, { id, path }, error);
  }
  return { path, trust: "user", source: "project", text };
}

async function globalCandidate(globalRoot: string, id: string): Promise<Candidate | undefined> {
  const path = join(globalRoot, "presets", id, ROLE_PRESET_COMPOSITION_FILE);
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw new RolePresetError("filesystem", "global preset could not be statted at " + path, { id, path }, error);
  }
  try {
    return { path, trust: "user", source: "global", text: await readFile(path, "utf8") };
  } catch (error) {
    throw new RolePresetError("filesystem", "global preset could not be read at " + path, { id, path }, error);
  }
}

async function writeIfAbsent(path: string, text: string): Promise<"created" | "exists"> {
  try {
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") return "exists";
    throw error;
  }
}

export async function ensureBuiltinRolePresetArtifact(globalRoot: string, spec: RolePresetSpec): Promise<string> {
  const directory = join(globalRoot, ROLE_PRESET_BUILTIN_DIRECTORY, spec.id);
  await mkdir(directory, { recursive: true });
  await writeIfAbsent(join(directory, ROLE_PRESET_METADATA_FILE), spec.presetYml);
  const path = join(directory, ROLE_PRESET_COMPOSITION_FILE);
  await writeIfAbsent(path, spec.cordisYml);
  return path;
}

export async function ensureBuiltinRolePresetArtifacts(globalRoot: string): Promise<RolePresetArtifactResult[]> {
  const results: RolePresetArtifactResult[] = [];
  for (const spec of ALL_BUILTIN_ROLE_PRESETS) {
    try {
      const path = await ensureBuiltinRolePresetArtifact(globalRoot, spec);
      results.push({ id: spec.id, status: "installed", path });
    } catch (error) {
      results.push({
        id: spec.id,
        status: "failed",
        diagnostic: {
          code: error instanceof RolePresetError ? error.code : "artifact_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return results;
}

export async function resolveRolePresetFile(
  ctx: Context,
  cwd: string,
  id: string,
  globalRoot: string,
): Promise<RolePresetFileResolution> {
  if (!validPresetId(id)) throw new RolePresetError("invalid_id", "role preset id must use safe lower-kebab syntax: " + id, { id });
  const spec = rolePresetSpec(id);

  const project = await projectCandidate(ctx, cwd, id);
  if (project !== undefined) {
    return {
      id,
      trust: project.trust,
      path: project.path,
      source: project.source,
      spec,
      composition: validateCandidate(spec, project),
    };
  }

  const global = await globalCandidate(globalRoot, id);
  if (global !== undefined) {
    return {
      id,
      trust: global.trust,
      path: global.path,
      source: global.source,
      spec,
      composition: validateCandidate(spec, global),
    };
  }

  const presets = ctx.get("agentPresets");
  if (presets !== undefined) {
    try {
      const resolved = await presets.resolve(id);
      if (isRecord(resolved) && typeof resolved.broken === "string") {
        throw new RolePresetError("preset_unavailable", "DSH native preset " + id + " is broken: " + resolved.broken, { id, source: "dsh" });
      }
      if (typeof resolved.path !== "string" || resolved.path === "") {
        return {
          id: resolved.id,
          trust: resolved.trust,
          path: "",
          source: "dsh",
          spec,
        };
      }
      const candidate: Candidate = {
        path: resolved.path,
        trust: resolved.trust,
        source: "dsh",
        text: await readFile(resolved.path, "utf8"),
      };
      return {
        id: resolved.id,
        trust: resolved.trust,
        path: resolved.path,
        source: "dsh",
        spec,
        composition: validateCandidate(spec, candidate),
      };
    } catch (error) {
      if (!isUnknownPresetError(error)) {
        if (error instanceof RolePresetError) throw error;
        throw new RolePresetError("preset_unavailable", "DSH native preset " + id + " could not be resolved", { id, source: "dsh" }, error);
      }
    }
  }

  if (spec === undefined) {
    throw new RolePresetError("preset_unavailable", "role preset " + id + " was not found in project, global, DSH native or catalog sources", { id });
  }
  let path: string;
  try {
    path = await ensureBuiltinRolePresetArtifact(globalRoot, spec);
  } catch (error) {
    throw new RolePresetError("artifact_failed", "catalog preset " + id + " could not be installed", { id, source: "builtin" }, error);
  }
  return {
    id: spec.id,
    trust: "system",
    path,
    source: "builtin",
    spec,
    composition: parseRolePresetComposition(spec.cordisYml),
  };
}
