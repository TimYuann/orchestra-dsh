/**
 * Active Orchestra team state seam.
 *
 * This module owns the active team.json path, JSON normalization, legacy
 * compatibility classification, opaque filesystem versions, and guarded
 * create/replace intent. Callers only decide whether an observed team may be
 * used and pass a ready snapshot back for replacement; they never construct a
 * filesystem version or write the active state file directly.
 */

import type {
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { OrchestrationDocument } from "./orchestration-document.js";
import { readOrchestrationDocument } from "./orchestration-document.js";

export type TeamRolePhase = "reserved" | "provisioning" | "active" | "failed";
export type TeamStatus = "provisioning" | "active" | "degraded" | "blocked" | "failed";

export interface TeamRoleDiagnostic {
  code: string;
  message: string;
}

/** Durable facts needed to reconstruct a Governed role Blueprint. */
export interface TeamRoleBlueprintFacts {
  mode: "governed";
  teamId: string;
  roleId: string;
  topologyId: string;
  topologySource: "project" | "global" | "bundled";
  controllerSessionId: string;
  agentPreset: string;
  permissionPreset: string;
  effectivePermissionPreset: string;
  approval: string;
  sandbox: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  cwd?: string;
  title?: string;
  tools: { names: string[]; count: number };
}

export interface TeamWelcomeReceipt {
  messageId: string;
  sessionId: string;
  acceptedAt: number;
}

/** team.json v1.1 role record. */
export interface TeamRole {
  id: string;
  name: string;
  sessionId: string;
  phase: TeamRolePhase;
  diagnostic?: TeamRoleDiagnostic;
  blueprint?: TeamRoleBlueprintFacts;
  welcome?: TeamWelcomeReceipt;
  /** Replacement history: previous session ids this role was bound to. */
  sessionHistory: { sessionId: string; replacedAt: number; reason: string }[];
  preset: string | null;
  sandbox: string;
  /** Per-role model override snapshot, re-applied by orchestra_activate after a restart. */
  model?: { provider?: string; model?: string; reasoningEffort?: string };
  reportCount: number;
  lastReport: string | null;
}

/** team.json v1.1 runtime state. */
export interface TeamState {
  schemaVersion: number;
  teamId: string;
  status: TeamStatus;
  rootCwd: string;
  controllerSessionId: string;
  controllerHistory: { sessionId: string; replacedAt: number; reason: string }[];
  topologyRef: { id: string; source: "project" | "global" | "bundled" };
  mission: {
    objective: string;
    scope: string[];
    constraints: string[];
    acceptanceCriteria: string[];
    nonGoals: string[];
    context: string;
  };
  createdAt: number;
  activatedFromArchiveId: string | null;
  /** Canonical Living Orchestration Document; absent only on legacy state until Driver initialization. */
  document?: OrchestrationDocument;
  roles: TeamRole[];
  reports: { reportId: string; roleId: string; sessionId: string; path: string; createdAt: number }[];
}

/** Inactive marker written after an immutable archive has been published. */
export interface ActiveTeamArchivedMarker {
  schemaVersion: 1;
  archived: true;
  status: "dismissed";
  archiveId: string;
  archivePath: string;
  archivedAt: number;
  teamId?: string;
}

export type ActiveTeamStatePayload = TeamState | ActiveTeamArchivedMarker;

export interface ActiveTeamCompatibility {
  source: "v1.0" | "v1.1";
  legacy: boolean;
  migratedFields: string[];
}

export type ActiveTeamDiagnosticCode =
  | "missing"
  | "inactive"
  | "invalid_json"
  | "invalid_shape"
  | "unsupported_schema"
  | "unrecoverable_identity"
  | "filesystem";

export interface ActiveTeamDiagnostic {
  code: ActiveTeamDiagnosticCode;
  message: string;
  fsCode?: string;
}

/** Opaque wrapper around dsh-fs' FsVersion. It cannot be manufactured by callers. */
declare const ACTIVE_TEAM_VERSION: unique symbol;
export type ActiveTeamVersion = { readonly [ACTIVE_TEAM_VERSION]: "ActiveTeamVersion" };

const versions = new WeakMap<object, FsVersion>();

function wrapVersion(version: FsVersion): ActiveTeamVersion {
  const token = Object.freeze({}) as unknown as ActiveTeamVersion;
  versions.set(token, version);
  return token;
}

function unwrapVersion(version: ActiveTeamVersion): FsVersion | undefined {
  return versions.get(version);
}

interface ActiveTeamReadCommon {
  cwd: string;
  compatibility: ActiveTeamCompatibility;
  warnings: string[];
  diagnostic: ActiveTeamDiagnostic;
}

export interface ActiveTeamMissing extends Pick<ActiveTeamReadCommon, "cwd" | "diagnostic"> {
  kind: "missing";
}

export interface ActiveTeamReady extends ActiveTeamReadCommon {
  kind: "ready";
  team: TeamState;
  version: ActiveTeamVersion;
}

export interface ActiveTeamInactive extends ActiveTeamReadCommon {
  kind: "inactive";
  reason: "archived" | "dismissed";
  version: ActiveTeamVersion;
}

export interface ActiveTeamBlocked extends Pick<ActiveTeamReadCommon, "cwd" | "diagnostic"> {
  kind: "blocked";
  warnings: string[];
}

export type ActiveTeamRead = ActiveTeamMissing | ActiveTeamReady | ActiveTeamInactive | ActiveTeamBlocked;

export type ActiveTeamStateErrorCode =
  | "active_exists"
  | "create_race"
  | "stale_write"
  | "invalid_snapshot"
  | "write_failed";

export class ActiveTeamStateError extends Error {
  readonly code: ActiveTeamStateErrorCode;
  readonly fsCode?: string;

  constructor(code: ActiveTeamStateErrorCode, message: string, fsCode?: string) {
    super(message);
    this.name = "ActiveTeamStateError";
    this.code = code;
    this.fsCode = fsCode;
  }
}

export interface ActiveTeamWriteOptions {
  policy: SandboxExecutionPolicy;
  signal?: AbortSignal;
}

export interface ActiveTeamWriteResult {
  operation: "created" | "replaced";
  state: ActiveTeamStatePayload;
  version: ActiveTeamVersion;
  /** New ready snapshot for TeamState writes; callers can continue CAS without rereading. */
  snapshot?: ActiveTeamReady;
  /** Canonical path for user-facing tool output; callers do not resolve the state path themselves. */
  statePath: string;
}

/** The narrow filesystem adapter needed by this module and its tests. */
export interface ActiveTeamStateFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    policy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>;
}

export interface ActiveTeamStateStore {
  read(cwd: string, options?: { signal?: AbortSignal }): Promise<ActiveTeamRead>;
  create(cwd: string, team: TeamState, options: ActiveTeamWriteOptions): Promise<ActiveTeamWriteResult>;
  replace(snapshot: ActiveTeamReady, team: TeamState, options: ActiveTeamWriteOptions): Promise<ActiveTeamWriteResult>;
  archive(snapshot: ActiveTeamReady, marker: ActiveTeamArchivedMarker, options: ActiveTeamWriteOptions): Promise<ActiveTeamWriteResult>;
}

const ACTIVE_STATE_PATH = "orchestra/state/team.json";

function fsCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function compatibilityOf(record: Record<string, any>): ActiveTeamCompatibility {
  const legacy = record.schemaVersion === undefined;
  const migratedFields: string[] = [];
  if (legacy) migratedFields.push("schemaVersion");
  if (record.topologyRef === undefined && typeof record.topology === "string") {
    migratedFields.push("topology→topologyRef");
  }
  if (record.controllerSessionId === undefined && typeof record.executorSessionId === "string") {
    migratedFields.push("executorSessionId→controllerSessionId");
  }
  if (Array.isArray(record.roles) && record.roles.some((role: any) => role?.reportCount === undefined && typeof role?.rounds === "number")) {
    migratedFields.push("roles.rounds→roles.reportCount");
  }
  if (Array.isArray(record.roles) && record.roles.some((role: any) => role?.phase === undefined)) {
    migratedFields.push("roles.phase→active");
  }
  if (record.document === undefined) migratedFields.push("document→legacy_missing");
  return {
    source: legacy ? "v1.0" : "v1.1",
    legacy,
    migratedFields,
  };
}

function legacyWarnings(compatibility: ActiveTeamCompatibility): string[] {
  if (compatibility.legacy) return ["legacy active team state normalized in memory; the source file was not rewritten"];
  if (compatibility.migratedFields.length > 0) {
    return [`active team state compatibility fields normalized in memory (${compatibility.migratedFields.join(", ")}); the source file was not rewritten`];
  }
  return [];
}

function diagnostic(code: ActiveTeamDiagnosticCode, message: string, fsCode?: string): ActiveTeamDiagnostic {
  return { code, message, ...(fsCode === undefined ? {} : { fsCode }) };
}

function asRecord(raw: unknown): Record<string, any> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, any>) : undefined;
}

function classifyRaw(raw: unknown, cwd: string):
  | { kind: "ready"; team: TeamState; compatibility: ActiveTeamCompatibility; warnings: string[]; diagnostic: ActiveTeamDiagnostic }
  | { kind: "inactive"; reason: "archived" | "dismissed"; compatibility: ActiveTeamCompatibility; warnings: string[]; diagnostic: ActiveTeamDiagnostic }
  | { kind: "blocked"; warnings: string[]; diagnostic: ActiveTeamDiagnostic } {
  const record = asRecord(raw);
  if (record === undefined) {
    return {
      kind: "blocked",
      warnings: [],
      diagnostic: diagnostic("invalid_shape", "active team state root must be a JSON object"),
    };
  }

  const compatibility = compatibilityOf(record);
  const warnings = legacyWarnings(compatibility);
  if (record.schemaVersion !== undefined && (typeof record.schemaVersion !== "number" || record.schemaVersion !== 1)) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("unsupported_schema", `active team state schemaVersion ${String(record.schemaVersion)} is unsupported`),
    };
  }
  if (record.archived === true) {
    return {
      kind: "inactive",
      reason: "archived",
      compatibility,
      warnings,
      diagnostic: diagnostic("inactive", "active team state contains an archived marker"),
    };
  }
  if (record.status === "dismissed") {
    return {
      kind: "inactive",
      reason: "dismissed",
      compatibility,
      warnings,
      diagnostic: diagnostic("inactive", "active team state contains a dismissed snapshot"),
    };
  }
  if (record.status !== undefined && !["provisioning", "active", "degraded", "blocked", "failed"].includes(record.status)) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("invalid_shape", `active team state status ${String(record.status)} is invalid`),
    };
  }
  if (!Array.isArray(record.roles) || record.roles.length === 0) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("invalid_shape", "active team state must contain at least one recoverable role"),
    };
  }
  for (const [index, role] of record.roles.entries()) {
    if (typeof role !== "object" || role === null || typeof role.sessionId !== "string" || role.sessionId === "") {
      return {
        kind: "blocked",
        warnings,
        diagnostic: diagnostic("unrecoverable_identity", `active team role at index ${index} has no recoverable sessionId`),
      };
    }
    if (role.phase !== undefined && !["reserved", "provisioning", "active", "failed"].includes(role.phase)) {
      return {
        kind: "blocked",
        warnings,
        diagnostic: diagnostic("invalid_shape", `active team role at index ${index} has invalid provisioning phase`),
      };
    }
  }

  const team = normalizeTeam(raw, cwd);
  if (team === undefined) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("invalid_shape", "active team state could not be normalized"),
    };
  }
  if (team.controllerSessionId === "") {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("unrecoverable_identity", "active team state has no recoverable controller session"),
    };
  }
  if (team.roles.length === 0) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("unrecoverable_identity", "active team state has no recoverable roles"),
    };
  }
  const documentRead = readOrchestrationDocument(record.document, team.teamId);
  if (documentRead.kind === "blocked") {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("invalid_shape", `active team document is blocked (${documentRead.diagnostic.code}): ${documentRead.diagnostic.message}`),
    };
  }
  if (documentRead.kind === "ready") team.document = documentRead.document;
  return {
    kind: "ready",
    team,
    compatibility,
    warnings,
    diagnostic: diagnostic("filesystem", "active team state is ready"),
  };
}

/** Normalize a raw team.json (v1.0 or v1.1) into v1.1 shape. */
export function normalizeTeam(raw: unknown, cwd: string, options: { allowDismissed?: boolean } = {}): TeamState | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  if (record.archived === true) return undefined;
  if (record.status === "dismissed" && options.allowDismissed !== true) return undefined;
  if (!Array.isArray(record.roles)) return undefined;
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  const teamId = typeof record.teamId === "string" && record.teamId !== "" ? record.teamId : `team-${createdAt}`;
  const roles: TeamRole[] = record.roles
    .filter((role: any) => typeof role?.sessionId === "string" && role.sessionId !== "")
    .map((role: any) => ({
      id: typeof role.id === "string" ? role.id : "role",
      name: typeof role.name === "string" ? role.name : String(role.id ?? "role"),
      sessionId: role.sessionId,
      phase: role.phase === "reserved" || role.phase === "provisioning" || role.phase === "failed" ? role.phase : "active",
      ...(asRecord(role.diagnostic) && typeof role.diagnostic.code === "string" && typeof role.diagnostic.message === "string"
        ? { diagnostic: { code: role.diagnostic.code, message: role.diagnostic.message } }
        : {}),
      ...(asRecord(role.blueprint) ? { blueprint: role.blueprint as TeamRoleBlueprintFacts } : {}),
      ...(asRecord(role.welcome) && typeof role.welcome.messageId === "string" && typeof role.welcome.sessionId === "string" && typeof role.welcome.acceptedAt === "number"
        ? { welcome: role.welcome as TeamWelcomeReceipt }
        : {}),
      sessionHistory: Array.isArray(role.sessionHistory) ? role.sessionHistory : [],
      preset: role.preset === undefined || role.preset === null ? null : role.preset,
      sandbox: typeof role.sandbox === "string" ? role.sandbox : "workspace-write",
      ...(role.model === undefined ? {} : { model: role.model }),
      reportCount: typeof role.reportCount === "number" ? role.reportCount : typeof role.rounds === "number" ? role.rounds : 0,
      lastReport: role.lastReport === undefined || role.lastReport === null ? null : role.lastReport,
    }));
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
    teamId,
    status:
      record.status === "provisioning" || record.status === "degraded" || record.status === "blocked" || record.status === "failed"
        ? record.status
        : "active",
    rootCwd: typeof record.rootCwd === "string" && record.rootCwd !== "" ? record.rootCwd : cwd,
    controllerSessionId:
      typeof record.controllerSessionId === "string"
        ? record.controllerSessionId
        : typeof record.executorSessionId === "string"
          ? record.executorSessionId
          : "",
    controllerHistory: Array.isArray(record.controllerHistory) ? record.controllerHistory : [],
    topologyRef:
      record.topologyRef !== undefined && typeof record.topologyRef.id === "string"
        ? record.topologyRef
        : { id: typeof record.topology === "string" ? record.topology : "custom", source: "bundled" as const },
    mission:
      record.mission !== undefined && typeof record.mission === "object"
        ? {
            objective: typeof record.mission.objective === "string" ? record.mission.objective : "",
            scope: Array.isArray(record.mission.scope) ? record.mission.scope : [],
            constraints: Array.isArray(record.mission.constraints) ? record.mission.constraints : [],
            acceptanceCriteria: Array.isArray(record.mission.acceptanceCriteria) ? record.mission.acceptanceCriteria : [],
            nonGoals: Array.isArray(record.mission.nonGoals) ? record.mission.nonGoals : [],
            context: typeof record.mission.context === "string" ? record.mission.context : "",
          }
        : { objective: "", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt,
    activatedFromArchiveId:
      typeof record.activatedFromArchiveId === "string" && record.activatedFromArchiveId !== ""
        ? record.activatedFromArchiveId
        : null,
    ...(asRecord(record.document) ? { document: record.document as OrchestrationDocument } : {}),
    roles,
    reports: Array.isArray(record.reports) ? record.reports : [],
  };
}

function readFailure(cwd: string, code: string | undefined, message: string): ActiveTeamBlocked {
  return {
    kind: "blocked",
    cwd,
    warnings: [],
    diagnostic: diagnostic("filesystem", message, code),
  };
}

function writeFailure(error: unknown, expected: FsWriteIntent): ActiveTeamStateError {
  const fsCode = fsCodeOf(error);
  if (expected.kind === "createIfAbsent" && fsCode === "FS_NOT_OBSERVED") {
    return new ActiveTeamStateError("create_race", "active team state was created concurrently; no write was published", fsCode);
  }
  if (expected.kind === "replaceIfVersion" && fsCode === "FS_STALE_VERSION") {
    return new ActiveTeamStateError("stale_write", "active team state changed since it was read; no write was published", fsCode);
  }
  return new ActiveTeamStateError(
    "write_failed",
    `active team state write failed${fsCode === undefined ? "" : ` (${fsCode})`}: ${error instanceof Error ? error.message : String(error)}`,
    fsCode,
  );
}

export function createActiveTeamStateStore(fs: ActiveTeamStateFileSystem): ActiveTeamStateStore {
  async function resolve(cwd: string, signal?: AbortSignal): Promise<FsTarget> {
    return fs.resolve(ACTIVE_STATE_PATH, { cwd, signal });
  }

  async function read(cwd: string, options: { signal?: AbortSignal } = {}): Promise<ActiveTeamRead> {
    let target: FsTarget;
    try {
      target = await resolve(cwd, options.signal);
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") {
        return { kind: "missing", cwd, diagnostic: diagnostic("missing", "active team state file is absent", fsCode) };
      }
      return readFailure(cwd, fsCode, `active team state path could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }

    let info: FsInfo | undefined;
    try {
      info = await fs.stat(target, options.signal);
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") {
        return { kind: "missing", cwd, diagnostic: diagnostic("missing", "active team state file is absent", fsCode) };
      }
      return readFailure(cwd, fsCode, `active team state could not be observed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (info === undefined) {
      return { kind: "missing", cwd, diagnostic: diagnostic("missing", "active team state file is absent") };
    }
    if (info.type !== "file") {
      return readFailure(cwd, undefined, `active team state target is not a regular file (${info.type})`);
    }
    if (info.version === undefined) {
      return readFailure(cwd, "FS_NOT_OBSERVED", "active team state exists but has no observable version");
    }

    let text: string;
    try {
      text = await fs.readText(target, options.signal);
    } catch (error) {
      return readFailure(cwd, fsCodeOf(error), `active team state could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return {
        kind: "blocked",
        cwd,
        warnings: [],
        diagnostic: diagnostic("invalid_json", `active team state contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
    const classified = classifyRaw(raw, cwd);
    if (classified.kind === "blocked") return { kind: "blocked", cwd, warnings: classified.warnings, diagnostic: classified.diagnostic };
    if (classified.kind === "inactive") {
      return {
        kind: "inactive",
        cwd,
        reason: classified.reason,
        compatibility: classified.compatibility,
        warnings: classified.warnings,
        diagnostic: classified.diagnostic,
        version: wrapVersion(info.version),
      };
    }
    return {
      kind: "ready",
      cwd,
      team: classified.team,
      compatibility: classified.compatibility,
      warnings: classified.warnings,
      diagnostic: classified.diagnostic,
      version: wrapVersion(info.version),
    };
  }

  async function write(
    cwd: string,
    state: ActiveTeamStatePayload,
    expected: FsWriteIntent,
    options: ActiveTeamWriteOptions,
  ): Promise<ActiveTeamWriteResult> {
    let target: FsTarget;
    try {
      target = await resolve(cwd, options.signal);
      const outcome = await fs.writeText(target, JSON.stringify(state, null, 2), expected, options.signal, options.policy);
      if (outcome.version === undefined) {
        throw new ActiveTeamStateError("write_failed", "active team state write returned no version");
      }
      const version = wrapVersion(outcome.version);
      const snapshot = "roles" in state
        ? {
            kind: "ready" as const,
            cwd,
            team: state,
            compatibility: { source: "v1.1" as const, legacy: false, migratedFields: [] },
            warnings: [],
            diagnostic: diagnostic("filesystem", "active team state is ready"),
            version,
          }
        : undefined;
      return {
        operation: expected.kind === "createIfAbsent" ? "created" : "replaced",
        state,
        version,
        ...(snapshot === undefined ? {} : { snapshot }),
        statePath: fs.processPath(target),
      };
    } catch (error) {
      if (error instanceof ActiveTeamStateError) throw error;
      throw writeFailure(error, expected);
    }
  }

  async function create(cwd: string, team: TeamState, options: ActiveTeamWriteOptions): Promise<ActiveTeamWriteResult> {
    const current = await read(cwd, { signal: options.signal });
    if (current.kind === "blocked") {
      throw new ActiveTeamStateError("write_failed", `cannot create active team state: ${current.diagnostic.message}`, current.diagnostic.fsCode);
    }
    if (current.kind === "ready") {
      throw new ActiveTeamStateError("active_exists", "an active team state already exists; no create was attempted");
    }
    if (current.kind === "inactive") {
      const version = unwrapVersion(current.version);
      if (version === undefined) throw new ActiveTeamStateError("invalid_snapshot", "inactive team state has no usable version token");
      // An inactive marker occupies the legacy active path. Replace only that
      // exact observed marker; a genuinely absent state always uses createIfAbsent.
      return write(cwd, team, { kind: "replaceIfVersion", version }, options);
    }
    return write(cwd, team, { kind: "createIfAbsent" }, options);
  }

  async function replace(snapshot: ActiveTeamReady, team: TeamState, options: ActiveTeamWriteOptions): Promise<ActiveTeamWriteResult> {
    if (snapshot.kind !== "ready") {
      throw new ActiveTeamStateError("invalid_snapshot", "active team replacement requires a ready snapshot");
    }
    const version = unwrapVersion(snapshot.version);
    if (version === undefined) {
      throw new ActiveTeamStateError("invalid_snapshot", "active team replacement received an unknown version token");
    }
    return write(snapshot.cwd, team, { kind: "replaceIfVersion", version }, options);
  }

  async function archive(
    snapshot: ActiveTeamReady,
    marker: ActiveTeamArchivedMarker,
    options: ActiveTeamWriteOptions,
  ): Promise<ActiveTeamWriteResult> {
    if (snapshot.kind !== "ready") {
      throw new ActiveTeamStateError("invalid_snapshot", "active team archive requires a ready snapshot");
    }
    if (marker.archived !== true || marker.status !== "dismissed" || marker.archiveId === "" || marker.archivePath === "") {
      throw new ActiveTeamStateError("invalid_snapshot", "active team archive marker is incomplete");
    }
    const version = unwrapVersion(snapshot.version);
    if (version === undefined) {
      throw new ActiveTeamStateError("invalid_snapshot", "active team archive received an unknown version token");
    }
    return write(snapshot.cwd, marker, { kind: "replaceIfVersion", version }, options);
  }

  return { read, create, replace, archive };
}
