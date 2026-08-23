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
import type { JsonValue } from "@deepseek-ai/dsh-tools";

export type TopologySource = "project" | "global" | "bundled";

export interface RoleConfig {
  id: string;
  name: string;
  preset?: string | null;
  sandbox?: string;
  runtime?: { provider?: string; model?: string; reasoningEffort?: string };
  maxRounds?: number;
  welcome?: string;
}

export interface TopologyProtocol {
  ownership?: Record<string, string>;
  routes?: { kind: string; from: string | string[]; to: string[] }[];
  completion?: { owner: string; rule: string };
}

export interface TopologyConfig {
  schemaVersion?: number;
  id: string;
  name?: string;
  description?: string;
  controller?: { id: string; source?: string };
  roles: RoleConfig[];
  protocol?: TopologyProtocol;
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
  sandbox?: string;
  maxRounds?: number;
  runtime?: Record<string, JsonValue>;
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

function roleSummary(role: RoleConfig): TopologyRoleSummary {
  const summary: TopologyRoleSummary = { id: role.id, name: role.name ?? role.id };
  if (role.preset !== undefined && role.preset !== null) summary.preset = role.preset;
  if (role.sandbox !== undefined) summary.sandbox = role.sandbox;
  if (role.maxRounds !== undefined) summary.maxRounds = role.maxRounds;
  if (role.runtime !== undefined) summary.runtime = role.runtime as Record<string, JsonValue>;
  return summary;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
  if (!isRecord(protocol)) return problems;
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
