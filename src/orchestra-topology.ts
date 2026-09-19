/**
 * Topology catalog seam.
 *
 * This module owns topology types, bundled truth, id/filename validation,
 * source precedence, compatibility parsing, semantic validation, listing and
 * bare-role lookup. Callers never scan topology directories or fall through a
 * broken higher-precedence source to a lower one.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { mkdir, readFile, readdir, stat as nodeStat, writeFile } from "node:fs/promises";
import type { FsDirEntry, FsInfo, FsTarget } from "@deepseek-ai/dsh-fs";
// `JsonValue` moved out of `@deepseek-ai/dsh-tools` in DSH 0.1.5-rc.2.
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
// Type-only: `orchestra-state` is the single owner of the durable execution
// vocabulary, and a type import keeps this module free of a runtime cycle.
import type { TeamRoleExecution } from "./orchestra-state.js";

export type TopologySource = "project" | "global" | "bundled";

/** How a topology author asks for a role's backend, before it is resolved. */
export type RoleExecutionRequest = "auto" | "session" | "subagent";

export interface TopologyLane {
  id: string;
  name?: string;
  description?: string;
  phaseId?: string;
  roles?: string[];
  ownerRole?: string;
  tasks?: string[];
}

export interface TopologyPhase {
  id: string;
  name?: string;
  description?: string;
  order?: number;
  lanes?: TopologyLane[];
}

export interface RoleConfig {
  id: string;
  name: string;
  preset?: string | null;
  /** Optional phase this role primarily participates in. */
  phase?: string;
  /** Optional lane this role operates on. */
  lane?: string;
  /**
   * Requested backend for this role. Omit to keep the historical behavior
   * (`session`); `"auto"` derives the backend from the preset criterion in
   * {@link resolveRoleExecution}. A resolved `"subagent"` role may not declare
   * `preset` or `sandbox` — the native contract cannot honor either.
   */
  execution?: RoleExecutionRequest;
  /**
   * Native per-child persona for a `subagent` role: it SHADOWS the deployment
   * persona for that child alone. A `session` role must not declare it — a
   * session's persona lives inside its Agent Preset, so a field here would be
   * silently ignored.
   */
  persona?: string;
  /**
   * Native per-child tool scoping for a `subagent` role: the named tools vanish
   * from the child's prompt AND refuse to execute.
   *
   * This is a AVAILABILITY narrowing, NOT a permission guarantee — the child
   * inherits its parent's sandbox and a denied tool's underlying capability
   * (e.g. a shell) may still reach the same effect. A role whose read-only
   * property must hold is a `session` role with a read-only Permission Preset.
   */
  toolFilter?: { allow?: string[]; deny?: string[] };
  compositionTools?: string[];
  orchestraTools?: string[];
  optionalCapabilities?: string[];
  sandbox?: string;
  runtime?: { provider?: string; model?: string; reasoningEffort?: string };
  maxRounds?: number;
  welcome?: string;
}

export interface TopologyProtocol {
  ownership?: Record<string, string>;
  routes?: { kind: string; from: string | string[]; to: string[] }[];
  completion?: { owner: string; rule: string };
  handoffs?: TopologyHandoffContract[];
  loops?: TopologyLoopContract[];
  gates?: TopologyGateDefinition[];
  closure?: TopologyClosureDefinition;
  budgets?: TopologyBudgets;
  phases?: TopologyPhase[];
  lanes?: TopologyLane[];
}

/**
 * Run-wide ceilings that apply regardless of which Loop is advancing.
 *
 * A Team budget is measured from `TeamState.createdAt`, which is the only
 * creation fact a resumed or activated Team keeps. Exceeding it stops
 * ADVANCEMENT but never stops closure: a budget that could block the terminal
 * outcome would strand the run forever, which is the opposite of its purpose.
 */
export interface TopologyBudgets {
  /** Wall-clock ceiling for the whole Team run. */
  teamWallClockMs?: number;
}

export interface TopologyHandoffContract {
  kind: string;
  from: string | string[];
  to: string[];
  requiredPayloadFields?: string[];
  requiredEvidenceKinds?: string[];
}

export interface TopologyLoopContract {
  loopId: string;
  entry: { role: string; event: string };
  participants: string[];
  evaluatorRole: string;
  candidateKind: string;
  verdictKind: string;
  maxAttempts: number;
  passRoute: string;
  retryRoute: string;
  capExhaustedRoute: string;
  requiredEvidenceKinds: string[];
  /**
   * Wall-clock ceiling for one Attempt. Omission is NOT unbounded: the runtime
   * applies its own default, so every Attempt has a deadline and an unattended
   * run cannot hang on a node that simply stopped. Declaring a value here
   * tightens that ceiling; there is deliberately no way to remove it.
   */
  attemptTimeoutMs?: number;
  /**
   * Wall-clock ceiling for the whole Loop, across every Attempt. Exceeding it
   * ends the Loop through the SAME `capExhaustedRoute` a verdict or deadline
   * exhaustion uses, so a budget breach is a bounded outcome the charter
   * already anticipated rather than a new terminal kind.
   */
  wallClockBudgetMs?: number;
  /**
   * Hard ceiling on Attempts in this Loop. It may only NARROW `maxAttempts`;
   * a larger value is rejected by the validator instead of being stored and
   * silently ignored, because a ceiling that does not bind is worse than none.
   */
  maxTotalAttempts?: number;
  /**
   * How long an open Attempt may show no progress before the stall projection
   * reports it as stalled (milestone 2b). Validated here so a topology cannot
   * ship an unusable value, and declared here rather than added later so the
   * frozen contract shape does not have to change twice.
   */
  stallGraceMs?: number;
}

export interface TopologyGateDefinition {
  gateId: string;
  decisionScope: string[];
  blockingScope: string[];
  options: string[];
  required: boolean;
  onUnavailable: "fallback" | "blocked" | "failed" | "safe_stop";
  fallbackOption?: string;
  expiresAt?: number;
  timeoutPolicy?: "fallback" | "blocked" | "failed" | "safe_stop";
}

export interface TopologyClosureDefinition {
  owner: string;
  requiredLoopOutcomes?: string[];
  requiredVerdicts?: string[];
  requiredEvidenceKinds?: string[];
  requiredHandoffs?: string[];
  openGatePolicy: "reject" | "allow_failed";
  allowedOutcomes: ("completed" | "failed" | "abandoned")[];
  userOverride?: boolean;
}

export interface TopologyConfig {
  schemaVersion?: number;
  id: string;
  name?: string;
  description?: string;
  controller?: { id: string; source?: string };
  roles: RoleConfig[];
  protocol?: TopologyProtocol;
  phases?: TopologyPhase[];
  lanes?: TopologyLane[];
}

export interface ResolvedTopology {
  config: TopologyConfig;
  source: TopologySource;
  warnings: string[];
}

export interface TopologyRoleSummary {
  id: string;
  name: string;
  preset?: string;
  phase?: string;
  lane?: string;
  /** Resolved backend for this role — never the raw `"auto"` request. */
  execution?: TeamRoleExecution;
  /** Native per-child persona; only ever present on a `subagent` role. */
  persona?: string;
  /** Native per-child tool scoping; only ever present on a `subagent` role. */
  toolFilter?: { allow?: string[]; deny?: string[] };
  sandbox?: string;
  maxRounds?: number;
  runtime?: Record<string, JsonValue>;
  compositionTools?: string[];
  orchestraTools?: string[];
  optionalCapabilities?: string[];
}

export interface TopologyReadyEntry extends ResolvedTopology {
  kind: "ready";
  status: "ready";
  filename: string;
  roles: TopologyRoleSummary[];
}

export interface TopologyDiagnostic {
  code: "missing" | "invalid_id" | "invalid_json" | "invalid_shape" | "id_mismatch" | "unsupported_schema" | "invalid_topology" | "filesystem";
  message: string;
  fsCode?: string;
}

export interface TopologyBlockedEntry {
  kind: "blocked";
  status: "blocked";
  id: string;
  filename: string;
  source: TopologySource;
  diagnostic: TopologyDiagnostic;
  warnings: string[];
}

export interface TopologyList {
  ready: TopologyReadyEntry[];
  blocked: TopologyBlockedEntry[];
}

export type TopologyResolution =
  | TopologyReadyEntry
  | TopologyBlockedEntry
  | { kind: "missing"; id: string; diagnostic: TopologyDiagnostic };

export interface TopologyRoleMatch {
  role: RoleConfig;
  topology: ResolvedTopology;
}

export interface TopologyCatalogFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
}

export interface TopologyCatalogOptions {
  globalRoot?: string;
  globalReadFile?: (path: string) => Promise<string>;
}

export interface TopologyCatalog {
  resolve(cwd: string, id: string, options?: { signal?: AbortSignal }): Promise<TopologyResolution>;
  list(cwd: string, options?: { signal?: AbortSignal }): Promise<TopologyList>;
  findRole(cwd: string, roleName: string, options?: { signal?: AbortSignal }): Promise<TopologyRoleMatch | undefined>;
  ensureBundledArtifacts(): Promise<void>;
}

/** The only bundled topology truth. */
export const BUILTIN_TOPOLOGIES: TopologyConfig[] = [
  {
    schemaVersion: 1,
    id: "duo",
    name: "Duo 开发",
    description: "driver + reviewer（只读评审）最小闭环：评审闭环，适合快速验收",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-reviewer",
        sandbox: "read-only",
        maxRounds: 2,
        welcome:
          "你已被 orchestra 团队录用为 Reviewer。职责：只审不修，最多两轮（R1 全量 → R2 只核对 R1 findings），每轮结束用 orchestra_report 工具把 review report 写入 orchestra/reports/，回复 driver 时返回报告路径。R2 中发现的新问题不追加本轮，记入 backlog，由 driver 决定是否另开评审。",
      },
    ],
    protocol: {
      ownership: { scope: "driver", review_verdict: "reviewer", closure: "driver" },
      routes: [
        { kind: "candidate", from: "driver", to: ["reviewer"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "Review PASS or explicit user override" },
    },
  },
  {
    schemaVersion: 1,
    id: "trio",
    name: "Trio 开发",
    description: "driver + implementer（实现）+ reviewer（只读两轮评审）的实现-评审闭环，适合严肃开发任务",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-implementer",
        sandbox: "workspace-write",
        welcome:
          "你已被 orchestra 团队录用为 Implementer。职责：实现 driver 派发的任务，产出可运行代码与验证记录；完成后用 orchestra_report 写交付说明到 orchestra/reports/，并回复 driver 报告路径。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-reviewer",
        sandbox: "read-only",
        maxRounds: 2,
        welcome:
          "你已被 orchestra 团队录用为 Reviewer。职责：只审不修，最多两轮（R1 全量 → R2 只核对 R1 findings），每轮结束用 orchestra_report 工具把 review report 写入 orchestra/reports/，回复 driver 时返回报告路径。R2 中发现的新问题不追加本轮，记入 backlog，由 driver 决定是否另开评审。",
      },
    ],
    protocol: {
      ownership: { scope: "driver", implementation: "implementer", review_verdict: "reviewer", closure: "driver" },
      routes: [
        { kind: "mission", from: "driver", to: ["implementer", "reviewer"] },
        { kind: "candidate", from: "implementer", to: ["reviewer"] },
        { kind: "findings", from: "reviewer", to: ["implementer", "driver"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "Review PASS or explicit user override" },
    },
  },
  {
    schemaVersion: 1,
    id: "oracle",
    name: "Oracle 推演",
    description: "driver + oracle（深度推演搭档）：对话式推演方案（讨论即计划），收敛后把结论作为自包含任务派给执行角色",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "oracle",
        name: "Oracle",
        preset: "orchestra-oracle",
        sandbox: "read-only",
        welcome:
          "你已被 orchestra 团队录用为 Oracle。职责：与 driver 深入推演——分析目标、权衡方案、识别风险、产出可执行的设计结论；推演过程即计划，收敛后用 orchestra_report 把设计结论写入 orchestra/reports/，并回复 driver 结论路径。",
      },
    ],
    protocol: {
      ownership: { scope: "driver", advice: "oracle", closure: "driver" },
      routes: [
        { kind: "escalation", from: ["driver"], to: ["oracle"] },
        { kind: "advice", from: "oracle", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "Driver acceptance" },
    },
  },
  {
    schemaVersion: 1,
    id: "four-role-dev",
    name: "Four-role development team",
    description: "driver + implementer ⇄ reviewer 主回路 + oracle 按需升级通道，适合复杂开发任务",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-implementer",
        sandbox: "workspace-write",
        welcome:
          "你已被 orchestra 团队录用为 Implementer。职责：实现 driver 派发的任务，产出可运行代码与验证记录；完成后用 orchestra_report 写交付说明到 orchestra/reports/，并回复 driver 报告路径。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-reviewer",
        sandbox: "read-only",
        maxRounds: 2,
        welcome:
          "你已被 orchestra 团队录用为 Reviewer。职责：只审不修，最多两轮（R1 全量 → R2 只核对 R1 findings），每轮结束用 orchestra_report 工具把 review report 写入 orchestra/reports/，回复 driver 时返回报告路径。R2 中发现的新问题不追加本轮，记入 backlog，由 driver 决定是否另开评审。",
      },
      {
        id: "oracle",
        name: "Oracle",
        preset: "orchestra-oracle",
        sandbox: "read-only",
        welcome:
          "你已被 orchestra 团队录用为 Oracle。职责：按需咨询——处理 mission 解释冲突、架构争议与高影响取舍；只提供建议不拍板；推演收敛后用 orchestra_report 把结论写入 orchestra/reports/。",
      },
    ],
    protocol: {
      ownership: { scope: "driver", implementation: "implementer", review_verdict: "reviewer", closure: "driver", advice: "oracle" },
      routes: [
        { kind: "mission", from: "driver", to: ["implementer", "reviewer"] },
        { kind: "candidate", from: "implementer", to: ["reviewer"] },
        { kind: "findings", from: "reviewer", to: ["implementer", "driver"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
        { kind: "escalation", from: ["driver", "implementer", "reviewer"], to: ["oracle"] },
        { kind: "advice", from: "oracle", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "Review PASS or explicit user override" },
    },
  },
  {
    schemaVersion: 1,
    id: "feature-development",
    name: "Feature Development",
    description:
      "把已批准的 feature mission 变成有边界、可测试、经评审的代码交付：implementer 实现 → verifier 验证 → reviewer 评审；Loop PASS 且用户 Gate approve 后才收束",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-v04-implementer-v1",
        sandbox: "workspace-write",
        compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 implementer（实现者）：把 driver 派发的 feature mission 变成有边界、可测试的代码交付。\n1) 只改 mission scope 内的文件，不顺手重构、不扩大权限与范围。\n2) 完成后用 orchestra_report 写交付说明（summary、changedFiles、knownRisks），evidence 引用 commit/diff/test。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（candidate → verifier）。\n4) 收到 findings 时按 repairScope 修复，修复后重新走 verifier。\n5) 不自报 PASS、不碰 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "verifier",
        name: "Verifier",
        preset: "orchestra-v04-verifier-v1",
        sandbox: "read-only",
        compositionTools: ["tool-bash", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 verifier（验证者）：解释 deterministic 检查（test/typecheck/build/diff）结果并整理 evidence。\n1) 只读沙箱，不改代码；唯一写通道是 orchestra_report。\n2) 检查必须列出 command、exit/result、scope、evidence refs 与未执行项，不能只写一句「tests pass」。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（verification → reviewer）。\n4) 不发 review PASS/FAIL。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 reviewer（评审者）：唯一有权记录 PASS/FAIL/BLOCKED 的 evaluator。\n1) 只读沙箱，只审不修，不替 implementer 修复。\n2) 按 frozen acceptance 评价 candidate；verdict 必须引用 report/diff/test evidence。\n3) 用 a2a_send 把 findings（summary、findings、repairScope）发回 implementer；verdict 交接用 a2a_send 直接投递（verdict → driver）。\n4) 把 PASS/FAIL/BLOCKED 写进 orchestra_report；对 driver 的汇报经 a2a_reply；不伪造用户 Gate、不改 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
    ],
    protocol: {
      ownership: {
        implementation: "implementer",
        verification: "verifier",
        review_verdict: "reviewer",
        user_decision: "driver",
        closure: "driver",
      },
      routes: [
        { kind: "mission", from: "driver", to: ["implementer"] },
        { kind: "candidate", from: "implementer", to: ["verifier"] },
        { kind: "verification", from: "verifier", to: ["reviewer"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
        { kind: "findings", from: "reviewer", to: ["implementer"] },
      ],
      completion: { owner: "driver", rule: "implementation-review Loop PASS + 用户 Gate approve 后由 driver 收束（completed/failed/abandoned）" },
      handoffs: [
        { kind: "candidate", from: "implementer", to: ["verifier"], requiredPayloadFields: ["summary", "changedFiles", "knownRisks"], requiredEvidenceKinds: ["commit", "diff", "test"] },
        { kind: "verification", from: "verifier", to: ["reviewer"], requiredPayloadFields: ["summary", "checks", "notes"], requiredEvidenceKinds: ["test", "diff", "file"] },
        { kind: "findings", from: "reviewer", to: ["implementer"], requiredPayloadFields: ["summary", "findings", "repairScope"], requiredEvidenceKinds: ["report", "diff", "message"] },
        { kind: "verdict", from: "reviewer", to: ["driver"], requiredPayloadFields: ["summary", "verdict", "unresolvedFindings"], requiredEvidenceKinds: ["report", "commit", "diff", "test"] },
      ],
      loops: [
        {
          loopId: "implementation-review",
          entry: { role: "implementer", event: "candidate_ready" },
          participants: ["implementer", "verifier", "reviewer"],
          evaluatorRole: "reviewer",
          candidateKind: "candidate",
          verdictKind: "PASS|FAIL|BLOCKED",
          maxAttempts: 2,
          passRoute: "verification → human gate → closure",
          retryRoute: "reviewer findings → implementer repair → verifier",
          capExhaustedRoute: "cap_exhausted → driver remediation branch",
          requiredEvidenceKinds: ["commit", "diff", "test", "report"],
        },
      ],
      gates: [
        {
          gateId: "feature-closure-approval",
          decisionScope: ["loop:implementation-review"],
          blockingScope: ["closure"],
          options: ["approve", "request-changes", "stop"],
          required: true,
          onUnavailable: "blocked",
        },
      ],
      closure: {
        owner: "driver",
        requiredLoopOutcomes: ["implementation-review:passed"],
        requiredVerdicts: ["PASS"],
        requiredEvidenceKinds: ["commit", "diff", "test"],
        openGatePolicy: "reject",
        allowedOutcomes: ["completed", "failed", "abandoned"],
        userOverride: false,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "bug-diagnosis-and-fix",
    name: "Bug Diagnosis and Fix",
    description:
      "先建立可复现事实和根因，再实施最小修复、回归验证和评审：investigator 调查 → implementer 修复 → verifier 回归 → reviewer 评审；Loop PASS 且用户 Gate approve 后才收束",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "investigator",
        name: "Investigator",
        preset: "orchestra-v04-investigator-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 investigator（调查者）：先建立可复现事实和根因，再给出 repair scope。\n1) 只读沙箱，不改代码；唯一写通道是 orchestra_report。\n2) 没有 reproduction/rootCause 证据前，不得把修复建议当事实；未知项要显式标 unknown。\n3) diagnosis 必须含 symptom、reproduction、rootCause、repairScope，evidence 引用 report/test/message/file。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（diagnosis → implementer）。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-v04-implementer-v1",
        sandbox: "workspace-write",
        compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 implementer（实现者）：只修已批准 repair scope 内的代码与测试。\n1) 以 investigator 的 rootCause 为准；证据不足时先回 findings，不硬修。\n2) 不扩大修复范围、不顺手重构；只改 scope 内文件。\n3) 完成后用 orchestra_report 写交付说明（summary、changedFiles、knownRisks），evidence 引用 commit/diff/test。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（candidate → verifier）。\n5) 收到 findings 时按 repairScope 修复，修复后重新走 verifier；不自报 PASS、不碰 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "verifier",
        name: "Verifier",
        preset: "orchestra-v04-verifier-v1",
        sandbox: "read-only",
        compositionTools: ["tool-bash", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 verifier（验证者）：运行原失败用例与回归用例，解释 deterministic 结果并整理 evidence。\n1) 只读沙箱，不改代码；唯一写通道是 orchestra_report。\n2) 必须列出 command、exit/result、scope、evidence refs 与未执行项，不能只写「tests pass」。\n3) verification 交接含 regressionSummary、remainingRisks，evidence 引用 test/diff/report。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（verification → reviewer）。\n5) 不发 review PASS/FAIL。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 reviewer（评审者）：唯一有权记录 PASS/FAIL/BLOCKED 的 evaluator。\n1) 只读沙箱，只审不修，不替 implementer/investigator 修复。\n2) 第一 attempt 若 diagnosis 不足必须返回 findings，不能让猜测的 root cause 进入成功路径。\n3) findings 交接（findings、nextEvidence、repairScope）可回 investigator 或 implementer；verdict 交接用 a2a_send 直接投递（verdict → driver）。\n4) 把 PASS/FAIL/BLOCKED 写进 orchestra_report；对 driver 的汇报经 a2a_reply；不伪造用户 Gate、不改 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
    ],
    protocol: {
      ownership: {
        reproduction_evidence: "investigator",
        repair: "implementer",
        verification: "verifier",
        review_verdict: "reviewer",
        closure: "driver",
      },
      routes: [
        { kind: "symptom", from: "driver", to: ["investigator"] },
        { kind: "diagnosis", from: "investigator", to: ["implementer"] },
        { kind: "candidate", from: "implementer", to: ["verifier"] },
        { kind: "verification", from: "verifier", to: ["reviewer"] },
        { kind: "findings", from: "reviewer", to: ["investigator", "implementer"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "diagnosis-fix-review Loop PASS + 用户 Gate approve 后由 driver 收束（completed/failed/abandoned）" },
      handoffs: [
        { kind: "diagnosis", from: "investigator", to: ["implementer"], requiredPayloadFields: ["symptom", "reproduction", "rootCause", "repairScope"], requiredEvidenceKinds: ["report", "test", "message", "file"] },
        { kind: "candidate", from: "implementer", to: ["verifier"], requiredPayloadFields: ["summary", "changedFiles", "knownRisks"], requiredEvidenceKinds: ["commit", "diff", "test"] },
        { kind: "verification", from: "verifier", to: ["reviewer"], requiredPayloadFields: ["regressionSummary", "remainingRisks"], requiredEvidenceKinds: ["test", "diff", "report"] },
        { kind: "findings", from: "reviewer", to: ["investigator", "implementer"], requiredPayloadFields: ["findings", "nextEvidence", "repairScope"], requiredEvidenceKinds: ["report", "message"] },
        { kind: "verdict", from: "reviewer", to: ["driver"], requiredPayloadFields: ["verdict", "unresolvedFindings"], requiredEvidenceKinds: ["report", "commit", "diff", "test"] },
      ],
      loops: [
        {
          loopId: "diagnosis-fix-review",
          entry: { role: "investigator", event: "diagnosis_ready" },
          participants: ["investigator", "implementer", "verifier", "reviewer"],
          evaluatorRole: "reviewer",
          candidateKind: "candidate",
          verdictKind: "PASS|FAIL|BLOCKED",
          maxAttempts: 2,
          passRoute: "verification → human gate → closure",
          retryRoute: "findings → investigator/implementer → verifier",
          capExhaustedRoute: "cap_exhausted → driver remediation branch",
          requiredEvidenceKinds: ["report", "commit", "diff", "test", "message"],
        },
      ],
      gates: [
        {
          gateId: "bug-fix-acceptance",
          decisionScope: ["loop:diagnosis-fix-review"],
          blockingScope: ["closure"],
          options: ["approve", "request-changes", "stop"],
          required: true,
          onUnavailable: "blocked",
        },
      ],
      closure: {
        owner: "driver",
        requiredLoopOutcomes: ["diagnosis-fix-review:passed"],
        requiredVerdicts: ["PASS"],
        requiredEvidenceKinds: ["report", "commit", "diff", "test"],
        openGatePolicy: "reject",
        allowedOutcomes: ["completed", "failed", "abandoned"],
        userOverride: false,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "architecture-decision",
    name: "Architecture Decision",
    description:
      "在约束、证据和候选方案之间形成可审查、可执行的架构决策：researcher 收集 source facts → architect 综合候选与推荐 → reviewer 评估 decision brief；Loop PASS 且用户 Gate accept 后才收束",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "researcher",
        name: "Researcher",
        preset: "orchestra-v04-researcher-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs-search", "tool-fs"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 researcher（研究者）：收集 source-backed facts、unknowns 和 option 输入，不做最终选择。\n1) 只读沙箱，不改代码；唯一写通道是 orchestra_report。\n2) research brief 必须保留 source URL/访问版本、fact/inference 标签、unknowns 和 evidence refs；二手资料不能支撑关键事实。\n3) 不能把 source availability 当作 correctness，不能伪造用户批准。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（research-brief → architect）。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "architect",
        name: "Architect",
        preset: "orchestra-v04-architect-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs-search", "tool-fs"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 architect（架构师）：把约束、候选、权衡与影响综合为 decision brief 与推荐。\n1) 只读沙箱，只写 report/evidence，不改 runtime code。\n2) decision brief 必须列 decision question、alternatives、tradeoffs、impact、constraints、migration impact、unknowns 与 evidence refs。\n3) 推荐不等于已批准：你不拥有用户 approval 或 runtime PASS 的伪造权。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（decision-brief → reviewer、recommendation → driver）。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 reviewer（评审者）：唯一有权记录 PASS/FAIL/BLOCKED 的 evaluator，评估 decision evidence。\n1) 只读沙箱，只审不修；PASS 只表示 decision brief 满足 evidence/structure 合同，不等于用户已选择方案。\n2) 第一轮缺失 evidence 必须返回 findings（missingEvidence、risks、requiredRevision），不能放行。\n3) findings 交接可回 researcher 或 architect；verdict 交接用 a2a_send 直接投递（verdict → driver）。\n4) 把 PASS/FAIL/BLOCKED 写进 orchestra_report；对 driver 的汇报经 a2a_reply；不伪造用户 Gate、不改 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
    ],
    protocol: {
      ownership: {
        source_gathering: "researcher",
        synthesis: "architect",
        review_verdict: "reviewer",
        user_decision: "driver",
        closure: "driver",
      },
      routes: [
        { kind: "question", from: "driver", to: ["researcher"] },
        { kind: "research-brief", from: "researcher", to: ["architect"] },
        { kind: "decision-brief", from: "architect", to: ["reviewer"] },
        { kind: "findings", from: "reviewer", to: ["researcher", "architect"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
        { kind: "recommendation", from: "architect", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "decision-validation Loop PASS + 用户 Gate accept 后由 driver 收束（completed/failed/abandoned）" },
      handoffs: [
        { kind: "research-brief", from: "researcher", to: ["architect"], requiredPayloadFields: ["question", "options", "facts", "unknowns"], requiredEvidenceKinds: ["url", "file", "report"] },
        { kind: "decision-brief", from: "architect", to: ["reviewer"], requiredPayloadFields: ["decision", "alternatives", "tradeoffs", "impact"], requiredEvidenceKinds: ["report", "file", "url"] },
        { kind: "findings", from: "reviewer", to: ["researcher", "architect"], requiredPayloadFields: ["missingEvidence", "risks", "requiredRevision"], requiredEvidenceKinds: ["report", "message", "url"] },
        { kind: "recommendation", from: "architect", to: ["driver"], requiredPayloadFields: ["recommendedOption", "reasons", "migrationImpact"], requiredEvidenceKinds: ["report", "file", "url"] },
        { kind: "verdict", from: "reviewer", to: ["driver"], requiredPayloadFields: ["verdict", "unresolvedFindings"], requiredEvidenceKinds: ["report", "message", "url"] },
      ],
      loops: [
        {
          loopId: "decision-validation",
          entry: { role: "researcher", event: "research_ready" },
          participants: ["researcher", "architect", "reviewer"],
          evaluatorRole: "reviewer",
          candidateKind: "decision-brief",
          verdictKind: "PASS|FAIL|BLOCKED",
          maxAttempts: 2,
          passRoute: "user decision gate → closure",
          retryRoute: "findings → researcher/architect → reviewer",
          capExhaustedRoute: "cap_exhausted → driver requests user/replan",
          requiredEvidenceKinds: ["report", "file", "url", "message"],
        },
      ],
      gates: [
        {
          gateId: "architecture-decision-approval",
          decisionScope: ["loop:decision-validation"],
          blockingScope: ["closure"],
          options: ["accept", "revise", "stop"],
          required: true,
          onUnavailable: "blocked",
        },
      ],
      closure: {
        owner: "driver",
        requiredLoopOutcomes: ["decision-validation:passed"],
        requiredVerdicts: ["PASS"],
        requiredEvidenceKinds: ["report", "file", "url"],
        openGatePolicy: "reject",
        allowedOutcomes: ["completed", "failed", "abandoned"],
        userOverride: false,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "refactor-and-migration",
    name: "Refactor and Migration",
    description:
      "在行为基线、兼容窗口和可回滚证据下完成结构或版本迁移：architect 规划 → implementer 逐 slice 实现 → verifier 验证 old/new 与 rollback → reviewer 评审；Loop PASS 且用户 Gate approve 后才收束",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "architect",
        name: "Architect",
        preset: "orchestra-v04-architect-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 architect（架构师）：把迁移任务拆成有 baseline、target 和 rollback 事实的 migration plan。\n1) 只读沙箱，只写 migration plan / compat report，不改代码。\n2) migration plan 必须含 baseline、target、slice、compatWindow、rollback；不得用「全量重写再看」替代可验证事实。\n3) 每个 slice 必须能回答：旧行为如何验证、何时允许切换、失败如何回退。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（migration-plan → implementer）。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-v04-implementer-v1",
        sandbox: "workspace-write",
        compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 implementer（实现者）：只实现当前声明 slice 的源码与测试。\n1) 只改当前 slice scope 内文件；不得改 baseline evidence 与既有兼容 fixture。\n2) 一个 candidate 只含一个已声明 slice，不得把多个未声明 slice 藏在一个 candidate 里。\n3) 完成后用 orchestra_report 写交付说明（changedFiles、compatImpact、rollbackStep），evidence 引用 commit/diff/test。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（slice-candidate → verifier）。\n5) 收到 findings 时按 scope 修复；不自报 PASS、不碰 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "verifier",
        name: "Verifier",
        preset: "orchestra-v04-verifier-v1",
        sandbox: "read-only",
        compositionTools: ["tool-bash", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 verifier（验证者）：运行 old/new contract tests 与 rollback smoke，整理 compatibility evidence。\n1) 只读沙箱，不改代码；唯一写通道是 orchestra_report。\n2) compatibility-evidence 必须含 oldPath、newPath、comparison、rollbackResult；evidence 引用 test/diff/report。\n3) 必须列出 command、exit/result、scope、evidence refs 与未执行项，不能只写「tests pass」。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（compatibility-evidence → reviewer）。\n5) 不发 review PASS/FAIL。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 reviewer（评审者）：唯一有权记录 PASS/FAIL/BLOCKED 的 evaluator。\n1) 只读沙箱，只审不修；旧行为失败、rollback 未验证或兼容窗口未覆盖时只能 FAIL/BLOCKED，不能放行。\n2) 第一轮缺旧路径证据必须返回 findings（findings、requiredCompatCheck、scope）。\n3) findings 交接可回 architect 或 implementer；verdict 交接用 a2a_send 直接投递（verdict → driver）。\n4) 把 PASS/FAIL/BLOCKED 写进 orchestra_report；对 driver 的汇报经 a2a_reply；不伪造用户 Gate、不改 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
    ],
    protocol: {
      ownership: {
        migration_contract: "architect",
        slice_code: "implementer",
        compat_checks: "verifier",
        review_verdict: "reviewer",
        closure: "driver",
      },
      routes: [
        { kind: "migration-question", from: "driver", to: ["architect"] },
        { kind: "migration-plan", from: "architect", to: ["implementer"] },
        { kind: "slice-candidate", from: "implementer", to: ["verifier"] },
        { kind: "compatibility-evidence", from: "verifier", to: ["reviewer"] },
        { kind: "findings", from: "reviewer", to: ["architect", "implementer"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "migration-validation Loop PASS + 用户 Gate approve 后由 driver 收束（completed/failed/abandoned）" },
      handoffs: [
        { kind: "migration-plan", from: "architect", to: ["implementer"], requiredPayloadFields: ["baseline", "target", "slice", "compatWindow", "rollback"], requiredEvidenceKinds: ["report", "file", "commit"] },
        { kind: "slice-candidate", from: "implementer", to: ["verifier"], requiredPayloadFields: ["changedFiles", "compatImpact", "rollbackStep"], requiredEvidenceKinds: ["commit", "diff", "test"] },
        { kind: "compatibility-evidence", from: "verifier", to: ["reviewer"], requiredPayloadFields: ["oldPath", "newPath", "comparison", "rollbackResult"], requiredEvidenceKinds: ["test", "diff", "report"] },
        { kind: "findings", from: "reviewer", to: ["architect", "implementer"], requiredPayloadFields: ["findings", "requiredCompatCheck", "scope"], requiredEvidenceKinds: ["report", "message"] },
        { kind: "verdict", from: "reviewer", to: ["driver"], requiredPayloadFields: ["verdict", "remainingRisk", "cutoverRecommendation"], requiredEvidenceKinds: ["report", "commit", "diff", "test"] },
      ],
      loops: [
        {
          loopId: "migration-validation",
          entry: { role: "architect", event: "migration_plan_ready" },
          participants: ["architect", "implementer", "verifier", "reviewer"],
          evaluatorRole: "reviewer",
          candidateKind: "slice-candidate",
          verdictKind: "PASS|FAIL|BLOCKED",
          maxAttempts: 2,
          passRoute: "compatibility Gate → closure",
          retryRoute: "findings → implementer/architect → verifier",
          capExhaustedRoute: "cap_exhausted → driver replan or abandon",
          requiredEvidenceKinds: ["commit", "diff", "test", "report", "file"],
        },
      ],
      gates: [
        {
          gateId: "migration-compatibility-approval",
          decisionScope: ["loop:migration-validation"],
          blockingScope: ["closure"],
          options: ["approve", "revise", "stop"],
          required: true,
          onUnavailable: "blocked",
        },
      ],
      closure: {
        owner: "driver",
        requiredLoopOutcomes: ["migration-validation:passed"],
        requiredVerdicts: ["PASS"],
        requiredEvidenceKinds: ["commit", "diff", "test", "report"],
        openGatePolicy: "reject",
        allowedOutcomes: ["completed", "failed", "abandoned"],
        userOverride: false,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "audit-and-hardening",
    name: "Audit and Hardening",
    description:
      "对明确边界做安全/可靠性审计，形成可验证 finding，并在批准后完成最小加固与 rescan：auditor 审计 → investigator 复现 → implementer 加固 → verifier rescan → reviewer 评审；Loop PASS 且用户 Gate approve 后才收束",
    controller: { id: "driver", source: "caller" },
    roles: [
      {
        id: "hardening-auditor",
        name: "Hardening Auditor",
        preset: "orchestra-v04-hardening-auditor-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 hardening-auditor（加固审计者）：对明确边界做安全/可靠性审计，产出可重现 finding。\n1) 只读沙箱，只写 findings/threat model report，不改代码。\n2) 初始 finding 必须含稳定 fingerprint、asset/location、impact、severity、reproduction 或 why-not、fix。\n3) rescan/regression/residual-risk 是 verifier → reviewer 的后置事实，初始 residual risk 只能标 unknown；不能预填未来结果。\n4) 不能把扫描分数当证明、不回显 secret、不把客户/用户数据写入 report。\n5) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（finding → investigator）。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "investigator",
        name: "Investigator",
        preset: "orchestra-v04-investigator-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 investigator（调查者）：为 finding 建立 reproduction/impact evidence，产出 remediation-brief。\n1) 只读沙箱，只写 reproduction/impact evidence，不改代码。\n2) remediation-brief 必须含 reproduction、rootCause、repairScope、risk；不能把猜测写成 root cause。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（remediation-brief → implementer）。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-v04-implementer-v1",
        sandbox: "workspace-write",
        compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 implementer（实现者）：只改批准的 hardening scope。\n1) 不扩大加固范围、不顺手重构；以 remediation-brief 的 repairScope 为准。\n2) hardening-candidate 含 changedFiles、controlAdded、knownRisks，evidence 引用 commit/diff/test。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（hardening-candidate → verifier）。\n4) 收到 findings 时按 scope 修复；不自报 PASS、不碰 charter/graph。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "verifier",
        name: "Verifier",
        preset: "orchestra-v04-verifier-v1",
        sandbox: "read-only",
        compositionTools: ["tool-bash", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 verifier（验证者）：运行 exploit/regression rescan，整理可重读证据。\n1) 只读沙箱，只写 rescan/regression evidence，不改代码。\n2) rescan-evidence 必须含 originalFinding、rescan、regression、residualRisk；evidence 引用 test/diff/report。\n3) 不能把一次命令退出 0 解释成全局成功；必须列 command/exit/scope/未执行项。\n4) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递（rescan-evidence → reviewer）。\n5) 不发 review PASS/FAIL。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 reviewer（评审者）：唯一有权记录 PASS/FAIL/BLOCKED 的 security evaluator。\n1) 只读沙箱，只审不修；缺少 rescan 只能 BLOCKED，不得被低严重度标签掩盖。\n2) 修复后仍可复现或 rescan 缺失时不得 PASS；verdict 含 openFindings、residualRisk。\n3) findings 回环按 scope 路由 investigator/implementer；verdict 交接用 a2a_send 直接投递（verdict → driver）。\n4) 风险接受必须是 direct user decision，不是 reviewer/auditor 自授；不伪造用户 Gate、不改 charter/graph。\n5) 对 driver 的汇报经 a2a_reply。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
    ],
    protocol: {
      ownership: {
        finding_model: "hardening-auditor",
        impact_reproduction: "investigator",
        remediation_code: "implementer",
        rescan_checks: "verifier",
        security_verdict: "reviewer",
        closure: "driver",
      },
      routes: [
        { kind: "audit-scope", from: "driver", to: ["hardening-auditor"] },
        { kind: "finding", from: "hardening-auditor", to: ["investigator"] },
        { kind: "remediation-brief", from: "investigator", to: ["implementer"] },
        { kind: "hardening-candidate", from: "implementer", to: ["verifier"] },
        { kind: "rescan-evidence", from: "verifier", to: ["reviewer"] },
        { kind: "findings", from: "reviewer", to: ["investigator", "implementer"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "hardening-remediation Loop PASS + 用户 Gate approve 后由 driver 收束（completed/failed/abandoned）" },
      handoffs: [
        { kind: "finding", from: "hardening-auditor", to: ["investigator"], requiredPayloadFields: ["fingerprint", "asset", "location", "impact", "severity", "fix", "reproductionOrWhyNot"], requiredEvidenceKinds: ["report", "file", "message"] },
        { kind: "remediation-brief", from: "investigator", to: ["implementer"], requiredPayloadFields: ["reproduction", "rootCause", "repairScope", "risk"], requiredEvidenceKinds: ["report", "test", "file"] },
        { kind: "hardening-candidate", from: "implementer", to: ["verifier"], requiredPayloadFields: ["changedFiles", "controlAdded", "knownRisks"], requiredEvidenceKinds: ["commit", "diff", "test"] },
        { kind: "rescan-evidence", from: "verifier", to: ["reviewer"], requiredPayloadFields: ["originalFinding", "rescan", "regression", "residualRisk"], requiredEvidenceKinds: ["test", "diff", "report"] },
        { kind: "verdict", from: "reviewer", to: ["driver"], requiredPayloadFields: ["verdict", "openFindings", "residualRisk"], requiredEvidenceKinds: ["report", "commit", "diff", "test"] },
      ],
      loops: [
        {
          loopId: "hardening-remediation",
          entry: { role: "investigator", event: "remediation_ready" },
          participants: ["investigator", "implementer", "verifier", "reviewer"],
          evaluatorRole: "reviewer",
          candidateKind: "hardening-candidate",
          verdictKind: "PASS|FAIL|BLOCKED",
          maxAttempts: 2,
          passRoute: "security-risk Gate → closure",
          retryRoute: "findings → investigator/implementer → verifier",
          capExhaustedRoute: "cap_exhausted → driver requests user risk decision or abandon",
          requiredEvidenceKinds: ["report", "commit", "diff", "test"],
        },
      ],
      gates: [
        {
          gateId: "security-risk-acceptance",
          decisionScope: ["loop:hardening-remediation"],
          blockingScope: ["closure"],
          options: ["approve", "remediate", "stop"],
          required: true,
          onUnavailable: "blocked",
        },
      ],
      closure: {
        owner: "driver",
        requiredLoopOutcomes: ["hardening-remediation:passed"],
        requiredVerdicts: ["PASS"],
        requiredEvidenceKinds: ["report", "commit", "diff", "test"],
        openGatePolicy: "reject",
        allowedOutcomes: ["completed", "failed", "abandoned"],
        userOverride: false,
      },
    },
  },
  {
    schemaVersion: 1,
    id: "architect-dev",
    name: "Architect Development",
    description: "多阶段多车道架构规划与开发拓扑：按需懒加载 architect/planner 输出任务卡，由 implementer 推进实现，经 reviewer 验收闭环",
    controller: { id: "driver", source: "caller" },
    phases: [
      { id: "planning", name: "Planning Phase", description: "Architecture exploration and task card breakdown" },
      { id: "execution", name: "Execution Phase", description: "Implementation of task cards" },
      { id: "verification", name: "Verification Phase", description: "Quality gate and review" },
    ],
    lanes: [
      { id: "architecture", name: "Architecture Lane", phaseId: "planning", roles: ["architect"] },
      { id: "main", name: "Main Implementation Lane", phaseId: "execution", roles: ["implementer"] },
      { id: "review", name: "Review Lane", phaseId: "verification", roles: ["reviewer"] },
    ],
    roles: [
      {
        id: "architect",
        name: "Architect",
        preset: "orchestra-v04-architect-v1",
        sandbox: "read-only",
        phase: "planning",
        lane: "architecture",
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 architect / planner：负责高熵任务的架构推演、接口拆解与微任务卡（Task Card）制定。\n1) 只读沙箱，不直接修改业务代码；唯一写通道是 orchestra_report。\n2) 针对复杂需求进行调研分析，把自包含 Task Card 的正文（context、changedFiles、acceptanceCriteria、verificationSteps）随调研报告一起经 orchestra_report 交回 driver；你是只读角色，唯一的写通道就是 orchestra_report（落盘在 orchestra/reports/ 下），需要把任务卡持久化到 orchestra/tasks/ 时由 driver 来做。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。\n4) 不直接发起代码变更，由 driver 派发给后续执行角色。",
      },
      {
        id: "implementer",
        name: "Implementer",
        preset: "orchestra-v04-implementer-v1",
        sandbox: "workspace-write",
        phase: "execution",
        lane: "main",
        compositionTools: ["tool-bash", "tool-fs", "tool-fs-search"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 implementer（实现者）：按 driver 派发的任务卡（Task Card）实现功能。\n1) 严格遵循 Task Card 约定的 scope 与边界，不扩大改动。\n2) 完成后用 orchestra_report 提交交付说明。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        preset: "orchestra-v04-reviewer-v1",
        sandbox: "read-only",
        phase: "verification",
        lane: "review",
        maxRounds: 2,
        compositionTools: ["tool-fs", "tool-fs-search", "tool-bash"],
        orchestraTools: ["orchestra_report"],
        welcome:
          "你作为 reviewer（评审者）：对 implementer 交付的成果进行客观验收评审。\n1) 只读沙箱，只审不修，最多两轮。\n2) 严格根据验收准则评估，结果写入 orchestra_report 并返回 PASS/FAIL 判定。\n3) 对 driver 的汇报经 a2a_reply；角色间交接用 a2a_send 直接投递。每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展；runtime 会自动通知 driver，你只需补充阻塞、风险或需要 driver 决策的信息。",
      },
    ],
    protocol: {
      ownership: {
        scope: "driver",
        architecture: "architect",
        implementation: "implementer",
        review_verdict: "reviewer",
        closure: "driver",
      },
      phases: [
        { id: "planning", name: "Planning Phase", description: "Architecture exploration and task card breakdown" },
        { id: "execution", name: "Execution Phase", description: "Implementation of task cards" },
        { id: "verification", name: "Verification Phase", description: "Quality gate and review" },
      ],
      lanes: [
        { id: "architecture", name: "Architecture Lane", phaseId: "planning", roles: ["architect"] },
        { id: "main", name: "Main Implementation Lane", phaseId: "execution", roles: ["implementer"] },
        { id: "review", name: "Review Lane", phaseId: "verification", roles: ["reviewer"] },
      ],
      routes: [
        { kind: "dispatch", from: "driver", to: ["architect", "implementer", "reviewer"] },
        { kind: "task_card", from: "architect", to: ["driver"] },
        { kind: "candidate", from: "implementer", to: ["reviewer"] },
        { kind: "verdict", from: "reviewer", to: ["driver"] },
      ],
      completion: { owner: "driver", rule: "Review PASS and driver acceptance" },
    },
  },
];

const TOPOLOGY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function dshHome(): string {
  const env = process.env["DSH_HOME"];
  return typeof env === "string" && env !== "" ? env : join(homedir(), ".dsh");
}

function defaultGlobalRoot(): string {
  return join(dshHome(), "orchestra");
}

function fsCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function topologyDiagnostic(
  code: TopologyDiagnostic["code"],
  message: string,
  fsCode?: string,
): TopologyDiagnostic {
  return { code, message, ...(fsCode === undefined ? {} : { fsCode }) };
}

function validTopologyId(id: string): boolean {
  return id !== "" && !isAbsolute(id) && basename(id) === id && !id.includes("/") && !id.includes("\\") && !id.includes("..") && TOPOLOGY_ID.test(id);
}

function validateId(id: string): TopologyDiagnostic | undefined {
  return validTopologyId(id) ? undefined : topologyDiagnostic("invalid_id", `topology id "${String(id)}" must use lower-kebab syntax and must not contain path traversal`);
}

/**
 * Resolve a role's execution backend.
 *
 * - an explicit `"session"` / `"subagent"` wins;
 * - `"auto"` derives from the preset criterion: a role that NAMES a preset must
 *   be a session (only a session can mount its own composition), a role that
 *   names none is a sub-agent child that joins its parent's live composition;
 * - an ABSENT value stays `"session"`: the nine built-in topologies keep their
 *   current behavior until each one opts in deliberately.
 *
 * @param role - the role's backend request and its declared preset.
 * @returns the resolved backend.
 */
export function resolveRoleExecution(role: Pick<RoleConfig, "execution" | "preset">): TeamRoleExecution {
  if (role.execution === "session" || role.execution === "subagent") return role.execution;
  if (role.execution === "auto") {
    const preset = role.preset;
    return typeof preset === "string" && preset !== "" ? "session" : "subagent";
  }
  return "session";
}

/**
 * Shape problems in a `subagent` role's native per-child knobs.
 *
 * Persona and toolFilter are the only per-child knobs the delegated backend
 * accepts beyond the model route. A malformed one is refused here rather than
 * at the delegation boundary, where the provider rejects the whole creation
 * with a message that no longer names the topology role that caused it.
 *
 * @param role - the role that resolved to the `subagent` backend.
 * @returns one diagnostic line per malformed knob (empty when both are usable).
 */
function subagentKnobProblems(role: RoleConfig): string[] {
  const problems: string[] = [];
  if (role.persona !== undefined && (typeof role.persona !== "string" || role.persona.trim() === "")) {
    problems.push(`role "${role.id}" persona must be a non-empty string`);
  }
  const filter: unknown = role.toolFilter;
  if (filter === undefined) return problems;
  if (!isRecord(filter)) {
    problems.push(`role "${role.id}" toolFilter must be an object with allow and/or deny`);
    return problems;
  }
  const toolNames = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry !== "");
  const allow = filter.allow;
  const deny = filter.deny;
  if (allow !== undefined && !toolNames(allow)) problems.push(`role "${role.id}" toolFilter.allow must be a non-empty array of non-empty tool names`);
  if (deny !== undefined && !toolNames(deny)) problems.push(`role "${role.id}" toolFilter.deny must be a non-empty array of non-empty tool names`);
  if (allow === undefined && deny === undefined) problems.push(`role "${role.id}" toolFilter declares neither allow nor deny, so it restricts nothing`);
  return problems;
}

export function roleSummary(role: RoleConfig): TopologyRoleSummary {
  const summary: TopologyRoleSummary = { id: role.id, name: role.name ?? role.id };
  if (role.preset !== undefined && role.preset !== null) summary.preset = role.preset;
  if (role.phase !== undefined) summary.phase = role.phase;
  if (role.lane !== undefined) summary.lane = role.lane;
  if (role.execution !== undefined) summary.execution = resolveRoleExecution(role);
  if (role.persona !== undefined) summary.persona = role.persona;
  if (role.toolFilter !== undefined) {
    summary.toolFilter = {
      ...(role.toolFilter.allow === undefined ? {} : { allow: [...role.toolFilter.allow] }),
      ...(role.toolFilter.deny === undefined ? {} : { deny: [...role.toolFilter.deny] }),
    };
  }
  if (role.sandbox !== undefined) summary.sandbox = role.sandbox;
  if (role.maxRounds !== undefined) summary.maxRounds = role.maxRounds;
  if (role.runtime !== undefined) summary.runtime = role.runtime as Record<string, JsonValue>;
  if (role.compositionTools !== undefined) summary.compositionTools = [...role.compositionTools];
  if (role.orchestraTools !== undefined) summary.orchestraTools = [...role.orchestraTools];
  if (role.optionalCapabilities !== undefined) summary.optionalCapabilities = [...role.optionalCapabilities];
  return summary;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Problems in one Loop's bounded-run fields.
 *
 * These are validated rather than defaulted wherever a default would make the
 * declared value meaningless. A ceiling that silently does not bind, or a grace
 * period that can never elapse, is worse than an absent field: the topology
 * reads as if it asked for something the runtime is not doing. Each message
 * therefore says what the value would have failed to do.
 *
 * @param loop - the raw loop record being validated.
 * @param index - its position, for a message that can be located.
 * @returns one line per unusable field (empty when all are absent or usable).
 */
function boundedRunProblems(loop: Record<string, any>, index: number): string[] {
  const problems: string[] = [];
  const ms = (field: "attemptTimeoutMs" | "wallClockBudgetMs" | "stallGraceMs"): number | undefined => {
    const value = loop[field];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      problems.push(`protocol.loops[${index}].${field} must be a positive safe integer of milliseconds`);
      return undefined;
    }
    return value;
  };
  const attemptTimeoutMs = ms("attemptTimeoutMs");
  ms("wallClockBudgetMs");
  const stallGraceMs = ms("stallGraceMs");
  const maxAttempts = typeof loop.maxAttempts === "number" && Number.isSafeInteger(loop.maxAttempts) ? loop.maxAttempts : undefined;
  const maxTotalAttempts = loop.maxTotalAttempts;
  if (maxTotalAttempts !== undefined) {
    if (typeof maxTotalAttempts !== "number" || !Number.isSafeInteger(maxTotalAttempts) || maxTotalAttempts < 1) {
      problems.push(`protocol.loops[${index}].maxTotalAttempts must be a positive safe integer`);
    } else if (maxAttempts !== undefined && maxTotalAttempts > maxAttempts) {
      problems.push(`protocol.loops[${index}].maxTotalAttempts (${maxTotalAttempts}) exceeds maxAttempts (${maxAttempts}): it may only narrow the Attempt ceiling, so a larger value would be stored and silently ignored`);
    }
  }
  if (stallGraceMs !== undefined && attemptTimeoutMs !== undefined && stallGraceMs > attemptTimeoutMs) {
    problems.push(`protocol.loops[${index}].stallGraceMs (${stallGraceMs}) exceeds attemptTimeoutMs (${attemptTimeoutMs}): the Attempt would always time out before the grace period could elapse, so the stall projection could never fire`);
  }
  return problems;
}

export function validateTopology(config: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(config)) return ["shape: topology config must be an object"];
  if (config.schemaVersion !== undefined && (typeof config.schemaVersion !== "number" || config.schemaVersion !== 1)) {
    problems.push(`schemaVersion ${String(config.schemaVersion)} is not supported (expected 1)`);
  }
  if (typeof config.id !== "string" || config.id === "") {
    problems.push("topology id must be a non-empty string");
  } else if (!validTopologyId(config.id)) {
    problems.push(`topology id "${config.id}" must use lower-kebab syntax`);
  }
  if (!Array.isArray(config.roles) || config.roles.length === 0) {
    problems.push("topology must declare at least one role");
    return problems;
  }
  const roleIds = new Set<string>();
  for (const [index, rawRole] of config.roles.entries()) {
    if (!isRecord(rawRole)) {
      problems.push(`shape: role at index ${index} must be an object`);
      continue;
    }
    const role = rawRole;
    if (typeof role.id !== "string" || role.id === "") {
      problems.push("every role must have a non-empty id");
      continue;
    }
    if (role.name !== undefined && typeof role.name !== "string") problems.push(`shape: role "${role.id}" name must be a string`);
    const lower = role.id.toLowerCase();
    if (roleIds.has(lower)) problems.push(`role id "${role.id}" is duplicated (ids are case-insensitive unique)`);
    roleIds.add(lower);
    if (role.sandbox !== undefined && typeof role.sandbox !== "string") {
      problems.push(`shape: role "${role.id}" sandbox must be a string`);
    } else if (role.sandbox !== undefined && role.sandbox !== "workspace-write" && role.sandbox !== "read-only") {
      problems.push(`role "${role.id}" sandbox "${role.sandbox}" is invalid (workspace-write | read-only)`);
    }
    for (const field of ["compositionTools", "orchestraTools"] as const) {
      if (role[field] !== undefined && !stringArray(role[field])) {
        problems.push("shape: role \"" + role.id + "\" " + field + " must be an array of strings");
      }
    }
    if (role.optionalCapabilities !== undefined && !stringArray(role.optionalCapabilities)) {
      problems.push("shape: role \"" + role.id + "\" optionalCapabilities must be an array of strings");
    }
    if (stringArray(role.compositionTools) && role.compositionTools.some((tool) => tool.startsWith("orchestra_") || tool.startsWith("a2a_"))) {
      problems.push("role \"" + role.id + "\" compositionTools cannot contain host transport/orchestra tools");
    }
    if (stringArray(role.orchestraTools) && role.orchestraTools.some((tool) => !tool.startsWith("orchestra_"))) {
      problems.push("role \"" + role.id + "\" orchestraTools must use Orchestra host tool names");
    }
    if (role.runtime !== undefined) {
      if (!isRecord(role.runtime)) {
        problems.push(`shape: role "${role.id}" runtime must be an object`);
        continue;
      }
      const runtime = role.runtime;
      for (const field of ["provider", "model", "reasoningEffort"]) {
        if (runtime[field] !== undefined && typeof runtime[field] !== "string") problems.push(`shape: role "${role.id}" runtime.${field} must be a string`);
      }
      if ((runtime.provider === undefined) !== (runtime.model === undefined)) {
        problems.push(`role "${role.id}" runtime provider/model must be provided together`);
      }
      if (runtime.reasoningEffort !== undefined && (runtime.provider === undefined || runtime.model === undefined)) {
        problems.push(`role "${role.id}" runtime reasoningEffort requires provider and model`);
      }
    }
    if (role.phase !== undefined && typeof role.phase !== "string") problems.push(`shape: role "${role.id}" phase must be a string`);
    if (role.lane !== undefined && typeof role.lane !== "string") problems.push(`shape: role "${role.id}" lane must be a string`);
    if (role.execution !== undefined && role.execution !== "auto" && role.execution !== "session" && role.execution !== "subagent") {
      problems.push(`role "${role.id}" execution "${String(role.execution)}" is invalid (auto | session | subagent)`);
    } else if (resolveRoleExecution({ execution: role.execution, preset: role.preset }) === "subagent") {
      // Fail loud rather than degrade silently: both fields below are accepted
      // by the schema but structurally unenforceable on a native sub-agent, and
      // a role that believes it is read-only while it is not is a safety bug.
      if (typeof role.preset === "string" && role.preset !== "") {
        problems.push(
          `role "${role.id}" resolves to the "subagent" backend but declares preset "${role.preset}": a native sub-agent joins its parent's live Agent Preset and cannot mount its own composition, so the preset would never take effect — use execution: "session" for a role that needs its own preset`,
        );
      }
      if (role.sandbox !== undefined) {
        problems.push(
          `role "${role.id}" resolves to the "subagent" backend but declares sandbox "${String(role.sandbox)}": a native sub-agent's sandbox mode is frozen from its parent's explicit override at the delegation boundary and its approval policy is pinned to "never", so the declared sandbox would never take effect — use execution: "session" for a read-only or otherwise restricted role`,
        );
      }
      problems.push(...subagentKnobProblems(role as unknown as RoleConfig));
    } else {
      // The native knobs are honored ONLY by the delegated backend. A session
      // role declaring one would see it silently ignored, so the topology is
      // rejected instead — the same fail-loud rule as the preset/sandbox pair
      // above, applied in the other direction.
      if (role.persona !== undefined) {
        problems.push(
          `role "${role.id}" resolves to the "session" backend but declares persona: a session role's persona lives inside its Agent Preset, so this field would never take effect — put the persona in the preset, or use execution: "subagent" for a native child persona`,
        );
      }
      if (role.toolFilter !== undefined) {
        problems.push(
          `role "${role.id}" resolves to the "session" backend but declares toolFilter: native per-child tool scoping exists only on the delegated backend, so this field would never take effect — narrow the tool set through the role's Agent Preset, or use execution: "subagent"`,
        );
      }
    }
  }
  if (config.phases !== undefined) {
    if (!Array.isArray(config.phases)) {
      problems.push("shape: topology phases must be an array");
    } else {
      for (const [index, p] of config.phases.entries()) {
        if (!isRecord(p) || typeof p.id !== "string" || p.id === "") {
          problems.push(`shape: topology phases[${index}] must be an object with non-empty id`);
        }
      }
    }
  }
  if (config.lanes !== undefined) {
    if (!Array.isArray(config.lanes)) {
      problems.push("shape: topology lanes must be an array");
    } else {
      for (const [index, l] of config.lanes.entries()) {
        if (!isRecord(l) || typeof l.id !== "string" || l.id === "") {
          problems.push(`shape: topology lanes[${index}] must be an object with non-empty id`);
        }
      }
    }
  }

  // A role's `phase` / `lane` is only meaningful if it names something the
  // topology actually declares. Cross-check ONLY when that side declares
  // entries at all: a topology that assigns a free-form label without declaring
  // phases must keep working, but a declared catalogue with a dangling
  // reference is a typo the author wants to hear about now, not when a draft
  // card shows a phase nobody can find.
  const declaredPhaseIds = new Set<string>();
  for (const source of [config.phases, isRecord(config.protocol) ? config.protocol.phases : undefined]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (isRecord(entry) && typeof entry.id === "string" && entry.id !== "") declaredPhaseIds.add(entry.id);
    }
  }
  const declaredLaneIds = new Set<string>();
  for (const source of [config.lanes, isRecord(config.protocol) ? config.protocol.lanes : undefined]) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (isRecord(entry) && typeof entry.id === "string" && entry.id !== "") declaredLaneIds.add(entry.id);
    }
  }
  if (Array.isArray(config.roles)) {
    for (const role of config.roles) {
      if (!isRecord(role)) continue;
      const roleId = typeof role.id === "string" ? role.id : "(unnamed)";
      if (typeof role.phase === "string" && declaredPhaseIds.size > 0 && !declaredPhaseIds.has(role.phase)) {
        problems.push(`role "${roleId}" phase "${role.phase}" is not declared in phases/ protocol.phases (declared: ${[...declaredPhaseIds].join(", ")})`);
      }
      if (typeof role.lane === "string" && declaredLaneIds.size > 0 && !declaredLaneIds.has(role.lane)) {
        problems.push(`role "${roleId}" lane "${role.lane}" is not declared in lanes/ protocol.lanes (declared: ${[...declaredLaneIds].join(", ")})`);
      }
    }
  }
  if (config.controller !== undefined && !isRecord(config.controller)) problems.push("shape: topology controller must be an object");
  if (isRecord(config.controller) && config.controller.id !== undefined && typeof config.controller.id !== "string") {
    problems.push("shape: topology controller.id must be a string");
  }
  const controllerId = isRecord(config.controller) && typeof config.controller.id === "string" ? config.controller.id : "driver";
  const known = (ref: string): boolean => ref === controllerId || roleIds.has(ref.toLowerCase());
  const protocol = config.protocol;
  if (protocol !== undefined && !isRecord(protocol)) {
    problems.push("shape: topology protocol must be an object");
    return problems;
  }
  // A topology with NO protocol is the v0.3 shape, and the catalog already
  // classifies it as ready-with-a-warning rather than rejecting it: the shipped
  // contract is that legacy templates stay readable and are flagged, never
  // silently replaced. P6 and P9 therefore apply to AUTHORED topologies — those
  // that declare a protocol — and this early return is the legacy boundary
  // rather than an oversight. Reading it the other way would break every v0.3
  // template on disk to enforce a rule they predate.
  if (!isRecord(protocol)) return problems;
  if (protocol.phases !== undefined) {
    if (!Array.isArray(protocol.phases)) {
      problems.push("shape: protocol.phases must be an array");
    } else {
      for (const [index, p] of protocol.phases.entries()) {
        if (!isRecord(p) || typeof p.id !== "string" || p.id === "") {
          problems.push(`shape: protocol.phases[${index}] must be an object with non-empty id`);
        }
      }
    }
  }
  if (protocol.lanes !== undefined) {
    if (!Array.isArray(protocol.lanes)) {
      problems.push("shape: protocol.lanes must be an array");
    } else {
      for (const [index, l] of protocol.lanes.entries()) {
        if (!isRecord(l) || typeof l.id !== "string" || l.id === "") {
          problems.push(`shape: protocol.lanes[${index}] must be an object with non-empty id`);
        }
      }
    }
  }
  if (protocol.ownership !== undefined && !isRecord(protocol.ownership)) {
    problems.push("shape: protocol.ownership must be an object");
  } else if (isRecord(protocol.ownership)) {
    for (const [decision, owner] of Object.entries(protocol.ownership)) {
      if (typeof owner !== "string" || owner === "" || !known(owner)) {
        problems.push(`protocol.ownership.${decision} references unknown role "${owner}"`);
      }
    }
  }
  if (protocol.routes !== undefined && !Array.isArray(protocol.routes)) {
    problems.push("shape: protocol.routes must be an array");
  } else if (Array.isArray(protocol.routes)) {
    for (const [index, rawRoute] of protocol.routes.entries()) {
      if (!isRecord(rawRoute)) {
        problems.push(`shape: protocol.routes[${index}] must be an object`);
        continue;
      }
      const route = rawRoute;
      if (typeof route.kind !== "string" || route.kind === "") problems.push(`shape: protocol.routes[${index}].kind must be a non-empty string`);
      const fromValid = typeof route.from === "string" || stringArray(route.from);
      if (!fromValid) problems.push(`shape: protocol.routes[${index}].from must be a string or string array`);
      if (!stringArray(route.to)) problems.push(`shape: protocol.routes[${index}].to must be a string array`);
      if (!fromValid || !stringArray(route.to)) continue;
      const froms = Array.isArray(route.from) ? route.from : [route.from];
      for (const from of froms) if (!known(from)) problems.push(`protocol.routes[${route.kind}] from references unknown role "${from}"`);
      for (const to of route.to) if (!known(to)) problems.push(`protocol.routes[${route.kind}] to references unknown role "${to}"`);
    }
  }
  if (protocol.completion !== undefined && !isRecord(protocol.completion)) {
    problems.push("shape: protocol.completion must be an object");
  } else if (isRecord(protocol.completion)) {
    if (typeof protocol.completion.owner !== "string" || protocol.completion.owner === "") problems.push("shape: protocol.completion.owner must be a non-empty string");
    if (typeof protocol.completion.rule !== "string" || protocol.completion.rule === "") problems.push("shape: protocol.completion.rule must be a non-empty string");
    if (typeof protocol.completion.owner === "string" && protocol.completion.owner !== "" && !known(protocol.completion.owner)) {
      problems.push(`protocol.completion.owner references unknown role "${protocol.completion.owner}"`);
    }
  }
  if (protocol.handoffs !== undefined && !Array.isArray(protocol.handoffs)) {
    problems.push("shape: protocol.handoffs must be an array");
  } else if (Array.isArray(protocol.handoffs)) {
    const handoffKinds = new Set<string>();
    for (const [index, rawHandoff] of protocol.handoffs.entries()) {
      if (!isRecord(rawHandoff)) {
        problems.push(`shape: protocol.handoffs[${index}] must be an object`);
        continue;
      }
      const handoff = rawHandoff;
      if (typeof handoff.kind !== "string" || handoff.kind === "") problems.push(`shape: protocol.handoffs[${index}].kind must be non-empty`);
      if (typeof handoff.kind === "string" && handoff.kind !== "" && handoffKinds.has(handoff.kind)) problems.push(`protocol.handoffs kind "${handoff.kind}" is duplicated`);
      if (typeof handoff.kind === "string" && handoff.kind !== "") handoffKinds.add(handoff.kind);
      const fromValid = typeof handoff.from === "string" || stringArray(handoff.from);
      if (!fromValid || (Array.isArray(handoff.from) && handoff.from.length === 0)) problems.push(`shape: protocol.handoffs[${index}].from must be a role or non-empty role array`);
      if (!stringArray(handoff.to) || handoff.to.length === 0) problems.push(`shape: protocol.handoffs[${index}].to must be a non-empty role array`);
      const froms = fromValid ? (Array.isArray(handoff.from) ? handoff.from : [handoff.from]) : [];
      for (const from of froms) if (!known(from)) problems.push(`protocol.handoffs[${index}].from references unknown role "${from}"`);
      if (stringArray(handoff.to)) for (const to of handoff.to) if (!known(to)) problems.push(`protocol.handoffs[${index}].to references unknown role "${to}"`);
      for (const field of ["requiredPayloadFields", "requiredEvidenceKinds"]) {
        if (handoff[field] !== undefined && !stringArray(handoff[field])) problems.push(`shape: protocol.handoffs[${index}].${field} must be a string array`);
      }
    }
  }
  if (protocol.loops !== undefined && !Array.isArray(protocol.loops)) {
    problems.push("shape: protocol.loops must be an array");
  } else if (Array.isArray(protocol.loops)) {
    const loopIds = new Set<string>();
    for (const [index, rawLoop] of protocol.loops.entries()) {
      if (!isRecord(rawLoop)) {
        problems.push(`shape: protocol.loops[${index}] must be an object`);
        continue;
      }
      const loop = rawLoop;
      if (typeof loop.loopId !== "string" || loop.loopId === "") problems.push(`shape: protocol.loops[${index}].loopId must be non-empty`);
      if (typeof loop.loopId === "string" && loop.loopId !== "" && loopIds.has(loop.loopId)) problems.push(`protocol loop id "${loop.loopId}" is duplicated`);
      if (typeof loop.loopId === "string" && loop.loopId !== "") loopIds.add(loop.loopId);
      if (!isRecord(loop.entry) || typeof loop.entry.role !== "string" || loop.entry.role === "" || typeof loop.entry.event !== "string" || loop.entry.event === "") {
        problems.push(`shape: protocol.loops[${index}].entry must contain role and event`);
      } else if (!known(loop.entry.role)) {
        problems.push(`protocol.loops[${index}].entry.role references unknown role "${loop.entry.role}"`);
      }
      if (!stringArray(loop.participants) || loop.participants.length === 0) {
        problems.push(`protocol.loops[${index}].participants must be a non-empty role array`);
      } else {
        for (const participant of loop.participants) if (!known(participant)) problems.push(`protocol.loops[${index}].participants references unknown role "${participant}"`);
      }
      if (typeof loop.evaluatorRole !== "string" || loop.evaluatorRole === "" || !known(loop.evaluatorRole)) problems.push(`protocol.loops[${index}].evaluatorRole references an unknown role`);
      for (const field of ["candidateKind", "verdictKind", "passRoute", "retryRoute", "capExhaustedRoute"]) {
        if (typeof loop[field] !== "string" || loop[field] === "") problems.push(`shape: protocol.loops[${index}].${field} must be non-empty`);
      }
      if (typeof loop.maxAttempts !== "number" || !Number.isSafeInteger(loop.maxAttempts) || loop.maxAttempts <= 0) problems.push(`protocol.loops[${index}].maxAttempts must be a positive safe integer`);
      if (!stringArray(loop.requiredEvidenceKinds)) problems.push(`shape: protocol.loops[${index}].requiredEvidenceKinds must be a string array`);
      problems.push(...boundedRunProblems(loop, index));
    }
  }
  if (protocol.budgets !== undefined) {
    if (!isRecord(protocol.budgets)) {
      problems.push("shape: protocol.budgets must be an object");
    } else {
      const teamWallClockMs = protocol.budgets.teamWallClockMs;
      if (teamWallClockMs !== undefined && (typeof teamWallClockMs !== "number" || !Number.isSafeInteger(teamWallClockMs) || teamWallClockMs <= 0)) {
        problems.push("protocol.budgets.teamWallClockMs must be a positive safe integer of milliseconds");
      }
    }
  }
  if (protocol.gates !== undefined && !Array.isArray(protocol.gates)) {
    problems.push("shape: protocol.gates must be an array");
  } else if (Array.isArray(protocol.gates)) {
    const gateIds = new Set<string>();
    for (const [index, rawGate] of protocol.gates.entries()) {
      if (!isRecord(rawGate)) {
        problems.push(`shape: protocol.gates[${index}] must be an object`);
        continue;
      }
      const gate = rawGate;
      if (typeof gate.gateId !== "string" || gate.gateId === "") problems.push(`shape: protocol.gates[${index}].gateId must be non-empty`);
      if (typeof gate.gateId === "string" && gate.gateId !== "" && gateIds.has(gate.gateId)) problems.push(`protocol gate id "${gate.gateId}" is duplicated`);
      if (typeof gate.gateId === "string" && gate.gateId !== "") gateIds.add(gate.gateId);
      for (const field of ["decisionScope", "blockingScope"]) if (!stringArray(gate[field]) || gate[field].length === 0) problems.push(`shape: protocol.gates[${index}].${field} must be a non-empty string array`);
      if (!stringArray(gate.options) || gate.options.length === 0 || new Set(gate.options).size !== gate.options.length || gate.options.some((option) => option === "")) problems.push(`protocol.gates[${index}].options must be non-empty and unique`);
      if (typeof gate.required !== "boolean") problems.push(`shape: protocol.gates[${index}].required must be boolean`);
      if (!["fallback", "blocked", "failed", "safe_stop"].includes(gate.onUnavailable)) problems.push(`protocol.gates[${index}].onUnavailable is invalid`);
      if (gate.onUnavailable === "fallback" && (typeof gate.fallbackOption !== "string" || !Array.isArray(gate.options) || !gate.options.includes(gate.fallbackOption))) problems.push(`protocol.gates[${index}] fallbackOption must be one of options`);
      if (gate.expiresAt !== undefined && (typeof gate.expiresAt !== "number" || !Number.isFinite(gate.expiresAt))) problems.push(`protocol.gates[${index}].expiresAt must be finite`);
      if (gate.timeoutPolicy !== undefined && !["fallback", "blocked", "failed", "safe_stop"].includes(gate.timeoutPolicy)) problems.push(`protocol.gates[${index}].timeoutPolicy is invalid`);
    }
  }
  const declaredLoopIds = new Set(Array.isArray(protocol.loops) ? protocol.loops.filter(isRecord).map((loop) => typeof loop.loopId === "string" ? loop.loopId : "") : []);
  if (Array.isArray(protocol.gates)) {
    for (const [index, rawGate] of protocol.gates.entries()) {
      if (!isRecord(rawGate)) continue;
      for (const scopeField of ["decisionScope", "blockingScope"]) {
        if (!stringArray(rawGate[scopeField])) continue;
        for (const scope of rawGate[scopeField]) {
          const [kind, ref] = scope.split(":", 2);
          if (kind === "role" && (ref === undefined || !known(ref))) problems.push(`protocol.gates[${index}].${scopeField} references unknown role "${ref ?? ""}"`);
          if (kind === "loop" && (ref === undefined || !declaredLoopIds.has(ref))) problems.push(`protocol.gates[${index}].${scopeField} references unknown loop "${ref ?? ""}"`);
          if (!["global", "role", "loop", "node", "event", "closure"].includes(kind)) problems.push(`protocol.gates[${index}].${scopeField} has invalid scope ref "${scope}"`);
        }
      }
    }
  }
  if (protocol.closure !== undefined) {
    if (!isRecord(protocol.closure)) {
      problems.push("shape: protocol.closure must be an object");
    } else {
      const closure = protocol.closure;
      if (typeof closure.owner !== "string" || closure.owner === "" || !known(closure.owner)) problems.push("protocol.closure.owner references an unknown role/controller");
      for (const field of ["requiredLoopOutcomes", "requiredVerdicts", "requiredEvidenceKinds", "requiredHandoffs"]) if (closure[field] !== undefined && !stringArray(closure[field])) problems.push(`shape: protocol.closure.${field} must be a string array`);
      if (stringArray(closure.requiredLoopOutcomes)) for (const outcome of closure.requiredLoopOutcomes) if (!declaredLoopIds.has(outcome.split(":", 1)[0])) problems.push(`protocol.closure.requiredLoopOutcomes references unknown loop "${outcome}"`);
      if (stringArray(closure.requiredVerdicts)) for (const verdict of closure.requiredVerdicts) if (!["PASS", "FAIL", "BLOCKED"].includes(verdict)) problems.push(`protocol.closure.requiredVerdicts contains invalid verdict "${verdict}"`);
      if (!["reject", "allow_failed"].includes(closure.openGatePolicy)) problems.push("protocol.closure.openGatePolicy is invalid");
      if (!Array.isArray(closure.allowedOutcomes) || closure.allowedOutcomes.length === 0 || new Set(closure.allowedOutcomes).size !== closure.allowedOutcomes.length || closure.allowedOutcomes.some((outcome) => !["completed", "failed", "abandoned"].includes(outcome))) problems.push("protocol.closure.allowedOutcomes must contain unique completed/failed/abandoned values");
      if (closure.userOverride !== undefined && typeof closure.userOverride !== "boolean") problems.push("shape: protocol.closure.userOverride must be boolean");
    }
  }
  // ── P10: a sub-agent node is reachable only through its parent ────────────
  //
  // Native delegation authorizes delivery on the direct-parent edge ALONE: the
  // seam throws when adjacency is rejected, and the platform's generic Session
  // routing refuses a sub-agent child's id outright. So a session node can never
  // hand work to a sub-agent node, and a sub-agent node can never reach a
  // session node — the controller is the only party on either side of such an
  // exchange. A route that says otherwise describes a message that cannot be
  // sent, and it would only be discovered when the orchestration stalled.
  const subagentRoles = new Set<string>();
  for (const role of Array.isArray(config.roles) ? config.roles : []) {
    if (!isRecord(role) || typeof role.id !== "string") continue;
    if (resolveRoleExecution({ execution: role.execution, preset: role.preset }) === "subagent") {
      subagentRoles.add(role.id.toLowerCase());
    }
  }
  if (subagentRoles.size > 0) {
    const edges: { label: string; from: unknown[]; to: unknown[] }[] = [];
    if (Array.isArray(protocol.routes)) {
      for (const route of protocol.routes) {
        if (!isRecord(route)) continue;
        const froms = Array.isArray(route.from) ? route.from : [route.from];
        const tos = Array.isArray(route.to) ? route.to : [];
        edges.push({ label: `protocol.routes[${String(route.kind)}]`, from: froms, to: tos });
      }
    }
    if (Array.isArray(protocol.handoffs)) {
      for (const handoff of protocol.handoffs) {
        if (!isRecord(handoff)) continue;
        const froms = Array.isArray(handoff.from) ? handoff.from : [handoff.from];
        const tos = Array.isArray(handoff.to) ? handoff.to : [];
        edges.push({ label: `protocol.handoffs[${String(handoff.kind)}]`, from: froms, to: tos });
      }
    }
    const isSubagent = (ref: unknown): boolean => typeof ref === "string" && subagentRoles.has(ref.toLowerCase());
    const isController = (ref: unknown): boolean => typeof ref === "string" && ref.toLowerCase() === controllerId.toLowerCase();
    for (const edge of edges) {
      const subagentSenders = edge.from.filter(isSubagent).length;
      const subagentTargets = edge.to.filter(isSubagent).length;
      if (subagentSenders > 0) {
        if (edge.from.length > subagentSenders) {
          problems.push(`${edge.label} mixes a sub-agent node with other senders: a delegated child is only reachable by its direct parent, so it cannot be one sender among several (P10)`);
        } else if (edge.to.length !== 1 || !isController(edge.to[0])) {
          problems.push(`${edge.label} sends from a sub-agent node to ${edge.to.map(String).join(", ") || "nobody"}: a delegated child can only reach its direct parent ("${controllerId}"), because native delivery authorizes on that edge alone (P10)`);
        }
      }
      if (subagentTargets > 0 && (edge.from.length !== 1 || !isController(edge.from[0]))) {
        problems.push(`${edge.label} delivers to a sub-agent node from ${edge.from.map(String).join(", ") || "nobody"}: only its direct parent ("${controllerId}") can reach a delegated child; a session node cannot message a sub-agent node (P10)`);
      }
    }
  }

  // ── Principles P6 and P9, as far as a static topology can prove them ──────
  //
  // P9: a declared node that nothing references is a design defect, not a
  // harmless extra. It cannot be dispatched to, cannot be handed anything, and
  // no decision belongs to it — the run simply never uses it, and the author
  // believes it does.
  const referenced = new Set<string>([controllerId.toLowerCase()]);
  const noteRef = (ref: unknown): void => {
    if (typeof ref === "string" && ref !== "") referenced.add(ref.toLowerCase());
  };
  const noteRefs = (refs: unknown): void => {
    if (Array.isArray(refs)) for (const ref of refs) noteRef(ref);
  };
  for (const role of Array.isArray(config.roles) ? config.roles : []) {
    if (!isRecord(role)) continue;
    // A role that names itself as the controller is referenced by that fact.
    if (typeof role.id === "string" && role.id.toLowerCase() === controllerId.toLowerCase()) noteRef(role.id);
  }
  if (isRecord(protocol.ownership)) for (const owner of Object.values(protocol.ownership)) noteRef(owner);
  for (const collection of ["routes", "handoffs"] as const) {
    const entries = protocol[collection];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      noteRef(entry.from);
      noteRefs(entry.to);
    }
  }
  if (isRecord(protocol.completion)) noteRef(protocol.completion.owner);
  if (Array.isArray(protocol.loops)) {
    for (const loop of protocol.loops) {
      if (!isRecord(loop)) continue;
      noteRef(loop.evaluatorRole);
      noteRefs(loop.participants);
      if (isRecord(loop.entry)) noteRef(loop.entry.role);
    }
  }
  if (Array.isArray((protocol as { gates?: unknown }).gates)) {
    for (const gate of (protocol as { gates: unknown[] }).gates) if (isRecord(gate)) noteRefs(gate.decisionScope);
  }
  if (isRecord(protocol.closure)) noteRef(protocol.closure.owner);
  for (const id of roleIds) {
    if (!referenced.has(id)) {
      const original = (Array.isArray(config.roles) ? config.roles : []).find(
        (role) => isRecord(role) && typeof role.id === "string" && role.id.toLowerCase() === id,
      );
      problems.push(
        `role "${isRecord(original) ? String(original.id) : id}" is referenced by nothing: no ownership entry, route, handoff, Loop, completion owner, or closure owner names it, so the run would never use it — give it a decision or a route, or delete it (P9: every declared node must lie on a path to closure)`,
      );
    }
  }

  // P6: the topology must name who declares the run complete. Without one there
  // is no terminal state to reach, and an approved run could never be declared
  // finished — precisely the outcome this plugin exists to prevent.
  //
  // BOTH mechanisms count, because the runtime honors both: an explicit
  // `protocol.closure`, or the legacy `protocol.completion.owner` from which
  // the close path synthesizes a closure. Requiring the structured form alone
  // would reject topologies that close perfectly well today, which is a stricter
  // rule than the system it guards rather than a safer one.
  if (protocol.closure === undefined && (protocol.completion === undefined || !isRecord(protocol.completion) || typeof protocol.completion.owner !== "string" || protocol.completion.owner === "")) {
    problems.push(
      "topology declares no completion authority: neither protocol.closure nor a legacy protocol.completion.owner names who may declare the run finished, so an approved run could have no terminal state (P6)",
    );
  }

  return problems;
}

interface SourceFile {
  filename: string;
  path: string;
  type: "file" | "directory" | "other";
  read(): Promise<string>;
}

type SourceDirectory =
  | { kind: "absent" }
  | { kind: "ready"; files: SourceFile[] }
  | { kind: "blocked"; filename: string; diagnostic: TopologyDiagnostic };

function idFromFilename(filename: string): string | undefined {
  return filename.endsWith(".json") ? filename.slice(0, -".json".length) : undefined;
}

function sourceRank(source: TopologySource): number {
  return source === "project" ? 0 : source === "global" ? 1 : 2;
}

function sourceFailure(source: TopologySource, message: string, fsCode?: string): TopologyBlockedEntry {
  return {
    kind: "blocked",
    status: "blocked",
    id: "",
    filename: source === "project" ? ".orchestra/topologies" : "~/.dsh/orchestra/topologies",
    source,
    warnings: [],
    diagnostic: topologyDiagnostic("filesystem", message, fsCode),
  };
}

export function createTopologyCatalog(fs: TopologyCatalogFileSystem, options: TopologyCatalogOptions = {}): TopologyCatalog {
  const globalRoot = options.globalRoot ?? defaultGlobalRoot();

  async function projectDirectory(cwd: string, signal?: AbortSignal): Promise<SourceDirectory> {
    let directory: FsTarget;
    try {
      directory = await fs.resolve(`${cwd}/.orchestra/topologies`, { cwd, signal });
      const info = await fs.stat(directory, signal);
      if (info === undefined) return { kind: "absent" };
      if (info.type !== "directory") return { kind: "blocked", filename: ".orchestra/topologies", diagnostic: topologyDiagnostic("filesystem", `project topology path is not a directory (${info.type})`) };
      const entries = await fs.listDir(directory, signal);
      return {
        kind: "ready",
        files: entries
          .filter((entry) => entry.name.endsWith(".json"))
          .map((entry) => ({ filename: entry.name, type: entry.type, path: fs.processPath(entry.target), read: () => fs.readText(entry.target, signal) })),
      };
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") return { kind: "absent" };
      return { kind: "blocked", filename: ".orchestra/topologies", diagnostic: topologyDiagnostic("filesystem", `project topology source failed: ${error instanceof Error ? error.message : String(error)}`, fsCode) };
    }
  }

  async function globalDirectory(): Promise<SourceDirectory> {
    const directory = join(globalRoot, "topologies");
    try {
      const info = await nodeStat(directory);
      if (!info.isDirectory()) return { kind: "blocked", filename: directory, diagnostic: topologyDiagnostic("filesystem", `global topology path is not a directory (${info.isDirectory() ? "directory" : "file"})`) };
      const entries = await readdir(directory, { withFileTypes: true });
      return {
        kind: "ready",
        files: entries
          .filter((entry) => entry.name.endsWith(".json"))
          .map((entry) => ({
            filename: entry.name,
            type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
            path: join(directory, entry.name),
            read: () => (options.globalReadFile ?? ((path: string) => readFile(path, "utf8")))(join(directory, entry.name)),
          })),
      };
    } catch (error) {
      if ((error as { code?: string })?.code === "ENOENT") return { kind: "absent" };
      return { kind: "blocked", filename: directory, diagnostic: topologyDiagnostic("filesystem", `global topology source failed: ${error instanceof Error ? error.message : String(error)}`, fsCodeOf(error)) };
    }
  }

  async function parseFile(file: SourceFile, source: TopologySource, expectedId?: string): Promise<TopologyReadyEntry | TopologyBlockedEntry> {
    const filenameId = idFromFilename(file.filename);
    const id = filenameId ?? expectedId ?? file.filename;
    const idProblem = validateId(id);
    if (idProblem !== undefined) return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: idProblem };
    if (file.type !== "file") {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", `topology target is not a regular file (${file.type})`) };
    }
    let raw: unknown;
    try {
      const text = await file.read();
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_json", `topology file ${file.path} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`) };
      }
    } catch (error) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("filesystem", `topology file ${file.path} could not be read: ${error instanceof Error ? error.message : String(error)}`, fsCodeOf(error)) };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", "topology root must be a JSON object") };
    }
    const config = raw as TopologyConfig;
    if (typeof config.id !== "string") {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", "topology id must be a string") };
    }
    if (config.id !== id) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("id_mismatch", `topology id "${config.id}" does not match filename/request id "${id}"`) };
    }
    if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("unsupported_schema", `schemaVersion ${config.schemaVersion} is not supported (expected 1)`) };
    }
    if (!Array.isArray(config.roles)) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", "topology roles must be an array") };
    }
    if (config.roles.some((role) => typeof role !== "object" || role === null)) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", "topology roles must contain objects") };
    }
    if (config.controller !== undefined && (typeof config.controller !== "object" || config.controller === null || Array.isArray(config.controller))) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", "topology controller must be an object") };
    }
    if (config.protocol !== undefined && (typeof config.protocol !== "object" || config.protocol === null || Array.isArray(config.protocol))) {
      return { kind: "blocked", status: "blocked", id, filename: file.filename, source, warnings: [], diagnostic: topologyDiagnostic("invalid_shape", "topology protocol must be an object") };
    }
    const problems = validateTopology(config);
    if (problems.length > 0) {
      const shapeProblem = problems.find((problem) => problem.startsWith("shape:"));
      return {
        kind: "blocked",
        status: "blocked",
        id,
        filename: file.filename,
        source,
        warnings: [],
        diagnostic: topologyDiagnostic(shapeProblem === undefined ? "invalid_topology" : "invalid_shape", problems.join("; ").replaceAll("shape: ", "")),
      };
    }
    const warnings = config.schemaVersion === undefined ? ["legacy topology schema normalized in memory; source file was not rewritten"] : [];
    return {
      kind: "ready",
      status: "ready",
      filename: file.filename,
      source,
      config,
      warnings,
      roles: config.roles.map(roleSummary),
    };
  }

  function builtinFile(config: TopologyConfig): SourceFile {
    return { filename: `${config.id}.json`, type: "file", path: `bundled:${config.id}`, read: async () => JSON.stringify(config) };
  }

  async function resolve(cwd: string, id: string, options: { signal?: AbortSignal } = {}): Promise<TopologyResolution> {
    const idProblem = validateId(id);
    if (idProblem !== undefined) return { kind: "blocked", status: "blocked", id, filename: `${id}.json`, source: "project", warnings: [], diagnostic: idProblem };
    const project = await projectDirectory(cwd, options.signal);
    if (project.kind === "blocked") return { kind: "blocked", status: "blocked", id, filename: project.filename, source: "project", warnings: [], diagnostic: project.diagnostic };
    if (project.kind === "ready") {
      const file = project.files.find((candidate) => candidate.filename === `${id}.json`);
      if (file !== undefined) return await parseFile(file, "project", id);
    }
    const global = await globalDirectory();
    if (global.kind === "blocked") return { kind: "blocked", status: "blocked", id, filename: global.filename, source: "global", warnings: [], diagnostic: global.diagnostic };
    if (global.kind === "ready") {
      const file = global.files.find((candidate) => candidate.filename === `${id}.json`);
      if (file !== undefined) return await parseFile(file, "global", id);
    }
    const builtin = BUILTIN_TOPOLOGIES.find((candidate) => candidate.id === id);
    if (builtin === undefined) return { kind: "missing", id, diagnostic: topologyDiagnostic("missing", `topology "${id}" was not found`) };
    const parsed = await parseFile(builtinFile(builtin), "bundled", id);
    if (parsed.status === "blocked") return parsed;
    return parsed;
  }

  async function list(cwd: string, options: { signal?: AbortSignal } = {}): Promise<TopologyList> {
    const ready: TopologyReadyEntry[] = [];
    const blocked: TopologyBlockedEntry[] = [];
    const seen = new Set<string>();
    const sources: { source: TopologySource; directory: Promise<SourceDirectory> }[] = [
      { source: "project", directory: projectDirectory(cwd, options.signal) },
      { source: "global", directory: globalDirectory() },
    ];
    for (const source of sources) {
      const directory = await source.directory;
      if (directory.kind === "blocked") {
        blocked.push(sourceFailure(source.source, directory.diagnostic.message, directory.diagnostic.fsCode));
        continue;
      }
      if (directory.kind === "absent") continue;
      for (const file of directory.files) {
        const fileId = idFromFilename(file.filename) ?? file.filename;
        if (seen.has(fileId)) continue;
        seen.add(fileId);
        const parsed = await parseFile(file, source.source);
        if (parsed.status === "ready") ready.push(parsed);
        else blocked.push(parsed);
      }
    }
    for (const builtin of BUILTIN_TOPOLOGIES) {
      if (seen.has(builtin.id)) continue;
      seen.add(builtin.id);
      const parsed = await parseFile(builtinFile(builtin), "bundled");
      if (parsed.status === "ready") ready.push(parsed);
      else blocked.push(parsed);
    }
    ready.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.config.id.localeCompare(b.config.id));
    blocked.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.id.localeCompare(b.id) || a.filename.localeCompare(b.filename));
    return { ready, blocked };
  }

  async function findRole(cwd: string, roleName: string, options: { signal?: AbortSignal } = {}): Promise<TopologyRoleMatch | undefined> {
    const exact = roleName.toLowerCase();
    const base = roleName.replace(/-\d+$/, "").toLowerCase();
    const catalog = await list(cwd, options);
    const sourceFailureEntry = catalog.blocked.find((entry) => entry.id === "" && entry.diagnostic.code === "filesystem");
    if (sourceFailureEntry !== undefined) {
      throw new Error(`cannot lookup topology role "${roleName}": ${sourceFailureEntry.diagnostic.message}`);
    }
    for (const topology of catalog.ready) {
      for (const role of topology.config.roles) {
        const id = role.id.toLowerCase();
        const name = String(role.name ?? role.id).toLowerCase();
        if (id === exact || name === exact || id === base || name === base) {
          return { role, topology: { config: topology.config, source: topology.source, warnings: topology.warnings } };
        }
      }
    }
    return undefined;
  }

  async function ensureBundledArtifacts(): Promise<void> {
    const root = join(globalRoot, "topologies");
    for (const topology of BUILTIN_TOPOLOGIES) {
      const target = join(root, `${topology.id}.json`);
      try {
        await nodeStat(target);
        continue;
      } catch (error) {
        if ((error as { code?: string })?.code !== "ENOENT") {
          console.warn(`orchestra: could not inspect builtin topology ${topology.id}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }
      try {
        await mkdir(root, { recursive: true });
        await writeFile(target, JSON.stringify(topology, null, 2), "utf8");
      } catch (error) {
        console.warn(`orchestra: could not install builtin topology ${topology.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { resolve, list, findRole, ensureBundledArtifacts };
}
