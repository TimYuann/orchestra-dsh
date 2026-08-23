/**
 * Immutable Orchestra archive seam.
 *
 * The module owns the archive directory, archive-id/filename validation,
 * legacy snapshot normalization, directory classification and create-only
 * publication. Callers never scan archive paths, parse archive JSON, or issue
 * an unconditional archive write.
 */

import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import type {
  FsDirEntry,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { normalizeTeam } from "./orchestra-state.js";
import type { TeamState } from "./orchestra-state.js";

export interface ArchiveSnapshot extends Omit<TeamState, "status"> {
  archiveId: string;
  status: "dismissed";
  dismissedAt: number;
}

export interface ArchiveCompatibility {
  source: "v1.0" | "v1.1";
  legacy: boolean;
  migratedFields: string[];
}

export type ArchiveDiagnosticCode =
  | "missing"
  | "invalid_json"
  | "invalid_shape"
  | "unsupported_schema"
  | "unrecoverable_identity"
  | "unsafe_id"
  | "filesystem";

export interface ArchiveDiagnostic {
  code: ArchiveDiagnosticCode;
  message: string;
  fsCode?: string;
}

export interface ArchiveSummary {
  status: "ready";
  archiveId: string;
  filename: string;
  teamId: string;
  goal: string;
  topology: string;
  dismissedAt: number;
  archivePath: string;
  compatibility: ArchiveCompatibility;
  warnings: string[];
}

export interface ArchiveBlockedEntry {
  status: "blocked";
  archiveId: string;
  filename: string;
  archivePath: string;
  diagnostic: ArchiveDiagnostic;
}

export interface ArchiveReadyRead {
  kind: "ready";
  snapshot: ArchiveSnapshot;
  summary: ArchiveSummary;
  compatibility: ArchiveCompatibility;
  warnings: string[];
}

export interface ArchiveMissingRead {
  kind: "missing";
  archiveId: string;
  filename: string;
  archivePath: string;
  diagnostic: ArchiveDiagnostic;
}

export interface ArchiveBlockedRead {
  kind: "blocked";
  archiveId: string;
  filename: string;
  archivePath: string;
  diagnostic: ArchiveDiagnostic;
  warnings: string[];
}

export type ArchiveRead = ArchiveReadyRead | ArchiveMissingRead | ArchiveBlockedRead;

export interface ArchiveList {
  ready: ArchiveSummary[];
  blocked: ArchiveBlockedEntry[];
}

declare const ARCHIVE_VERSION: unique symbol;
export type ArchiveVersion = { readonly [ARCHIVE_VERSION]: "ArchiveVersion" };

const versions = new WeakMap<object, FsVersion>();

function wrapVersion(version: FsVersion): ArchiveVersion {
  const token = Object.freeze({}) as unknown as ArchiveVersion;
  versions.set(token, version);
  return token;
}

export interface ArchiveWriteOptions {
  dismissedAt: number;
  policy: SandboxExecutionPolicy;
  signal?: AbortSignal;
}

export interface ArchiveCreateResult {
  snapshot: ArchiveSnapshot;
  summary: ArchiveSummary;
  version: ArchiveVersion;
}

export type ArchiveStoreErrorCode = "unsafe_id" | "collision" | "list_failed" | "write_failed";

export class ArchiveStoreError extends Error {
  readonly code: ArchiveStoreErrorCode;
  readonly fsCode?: string;

  constructor(code: ArchiveStoreErrorCode, message: string, fsCode?: string) {
    super(message);
    this.name = "ArchiveStoreError";
    this.code = code;
    this.fsCode = fsCode;
  }
}

/** The narrow filesystem adapter needed by the archive seam and its tests. */
export interface ArchiveFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    policy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>;
}

export interface ArchiveStoreOptions {
  /** Test seam for deterministic collision cases; production defaults to randomUUID. */
  dismissalId?: () => string;
}

export interface ArchiveStore {
  read(cwd: string, archiveId: string, options?: { signal?: AbortSignal }): Promise<ArchiveRead>;
  list(cwd: string, options?: { signal?: AbortSignal }): Promise<ArchiveList>;
  create(cwd: string, team: TeamState, options: ArchiveWriteOptions): Promise<ArchiveCreateResult>;
}

const ARCHIVE_DIR = "orchestra/archive";

function fsCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function asRecord(raw: unknown): Record<string, any> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, any>) : undefined;
}

function diagnostic(code: ArchiveDiagnosticCode, message: string, fsCode?: string): ArchiveDiagnostic {
  return { code, message, ...(fsCode === undefined ? {} : { fsCode }) };
}

function validateArchiveId(archiveId: string): void {
  if (
    typeof archiveId !== "string" ||
    archiveId === "" ||
    archiveId === "." ||
    archiveId === ".." ||
    isAbsolute(archiveId) ||
    basename(archiveId) !== archiveId ||
    archiveId.includes("/") ||
    archiveId.includes("\\") ||
    archiveId.includes("..")
  ) {
    throw new ArchiveStoreError("unsafe_id", `invalid archive_id "${String(archiveId)}"`);
  }
}

function filenameFor(archiveId: string): string {
  return `${archiveId}.json`;
}

function archiveIdFromFilename(filename: string): string | undefined {
  if (!filename.endsWith(".json")) return undefined;
  return filename.slice(0, -".json".length);
}

function compatibilityOf(record: Record<string, any>): ArchiveCompatibility {
  const legacy = record.schemaVersion === undefined;
  const migratedFields: string[] = [];
  if (legacy) migratedFields.push("schemaVersion");
  if (record.archiveId === undefined) migratedFields.push("filename→archiveId");
  if (record.dismissedAt === undefined && record.archivedAt === undefined) migratedFields.push("createdAt/filename→dismissedAt");
  if (record.teamId === undefined) migratedFields.push("createdAt→teamId");
  if (record.topologyRef === undefined && typeof record.topology === "string") {
    migratedFields.push("topology→topologyRef");
  }
  if (record.controllerSessionId === undefined && typeof record.executorSessionId === "string") {
    migratedFields.push("executorSessionId→controllerSessionId");
  }
  if (Array.isArray(record.roles) && record.roles.some((role: any) => role?.reportCount === undefined && typeof role?.rounds === "number")) {
    migratedFields.push("roles.rounds→roles.reportCount");
  }
  return { source: legacy ? "v1.0" : "v1.1", legacy, migratedFields };
}

function warningsOf(compatibility: ArchiveCompatibility): string[] {
  return compatibility.legacy
    ? ["legacy archive snapshot normalized in memory; the source file was not rewritten"]
    : [];
}

function timestampFromFilename(archiveId: string): number | undefined {
  const match = /-(\d+)(?:-[A-Za-z0-9]+)?$/.exec(archiveId);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function safeSegment(value: string, fallback: string): string {
  const segment = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment === "" ? fallback : segment;
}

function classifyRaw(
  raw: unknown,
  cwd: string,
  archiveId: string,
  filename: string,
  archivePath: string,
): { kind: "ready"; snapshot: ArchiveSnapshot; summary: ArchiveSummary } | { kind: "blocked"; diagnostic: ArchiveDiagnostic; warnings: string[] } {
  const record = asRecord(raw);
  if (record === undefined) {
    return { kind: "blocked", warnings: [], diagnostic: diagnostic("invalid_shape", "archive snapshot root must be a JSON object") };
  }
  const compatibility = compatibilityOf(record);
  const warnings = warningsOf(compatibility);
  if (record.schemaVersion !== undefined && (typeof record.schemaVersion !== "number" || record.schemaVersion !== 1)) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("unsupported_schema", `archive schemaVersion ${String(record.schemaVersion)} is unsupported`),
    };
  }
  if (record.status !== undefined && record.status !== "dismissed") {
    return { kind: "blocked", warnings, diagnostic: diagnostic("invalid_shape", "archive snapshot status must be dismissed") };
  }
  if (record.archiveId !== undefined && (typeof record.archiveId !== "string" || record.archiveId !== archiveId)) {
    return { kind: "blocked", warnings, diagnostic: diagnostic("invalid_shape", "archiveId does not match the archive filename") };
  }
  if (!Array.isArray(record.roles) || record.roles.length === 0) {
    return { kind: "blocked", warnings, diagnostic: diagnostic("invalid_shape", "archive snapshot must contain at least one recoverable role") };
  }
  for (const [index, role] of record.roles.entries()) {
    if (typeof role !== "object" || role === null || typeof role.sessionId !== "string" || role.sessionId === "") {
      return {
        kind: "blocked",
        warnings,
        diagnostic: diagnostic("unrecoverable_identity", `archive role at index ${index} has no recoverable sessionId`),
      };
    }
  }

  const rawForTeam = {
    ...record,
    archived: false,
    status: "dismissed",
  };
  const base = normalizeTeam(rawForTeam, cwd, { allowDismissed: true });
  if (base === undefined || base.controllerSessionId === "" || base.roles.length === 0) {
    return {
      kind: "blocked",
      warnings,
      diagnostic: diagnostic("unrecoverable_identity", "archive snapshot has no recoverable team controller or roles"),
    };
  }
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : undefined;
  const dismissedAt =
    typeof record.dismissedAt === "number"
      ? record.dismissedAt
      : typeof record.archivedAt === "number"
        ? record.archivedAt
        : timestampFromFilename(archiveId) ?? createdAt ?? 0;
  const snapshot: ArchiveSnapshot = {
    ...base,
    status: "dismissed",
    archiveId,
    dismissedAt,
  };
  const summary: ArchiveSummary = {
    status: "ready",
    archiveId,
    filename,
    teamId: snapshot.teamId,
    goal: snapshot.mission.objective,
    topology: snapshot.topologyRef.id,
    dismissedAt,
    archivePath,
    compatibility,
    warnings,
  };
  return { kind: "ready", snapshot, summary };
}

function blockedEntry(
  archiveId: string,
  filename: string,
  archivePath: string,
  diagnosticValue: ArchiveDiagnostic,
): ArchiveBlockedEntry {
  return { status: "blocked", archiveId, filename, archivePath, diagnostic: diagnosticValue };
}

function writeFailure(error: unknown, archiveId: string): ArchiveStoreError {
  const fsCode = fsCodeOf(error);
  if (fsCode === "FS_NOT_OBSERVED") {
    return new ArchiveStoreError("collision", `archive "${archiveId}" already exists; immutable archive was not overwritten`, fsCode);
  }
  return new ArchiveStoreError(
    "write_failed",
    `archive "${archiveId}" could not be created${fsCode === undefined ? "" : ` (${fsCode})`}: ${error instanceof Error ? error.message : String(error)}`,
    fsCode,
  );
}

export function createArchiveStore(fs: ArchiveFileSystem, options: ArchiveStoreOptions = {}): ArchiveStore {
  const makeDismissalId = options.dismissalId ?? randomUUID;

  async function resolveArchive(cwd: string, archiveId: string, signal?: AbortSignal): Promise<FsTarget> {
    return fs.resolve(`${ARCHIVE_DIR}/${filenameFor(archiveId)}`, { cwd, signal });
  }

  async function readTarget(
    cwd: string,
    archiveId: string,
    filename: string,
    target: FsTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<ArchiveRead> {
    const archivePath = fs.processPath(target);
    let info: FsInfo | undefined;
    try {
      info = await fs.stat(target, options.signal);
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") {
        return { kind: "missing", archiveId, filename, archivePath, diagnostic: diagnostic("missing", `archive "${archiveId}" is absent`, fsCode) };
      }
      return {
        kind: "blocked",
        archiveId,
        filename,
        archivePath,
        warnings: [],
        diagnostic: diagnostic("filesystem", `archive "${archiveId}" could not be observed: ${error instanceof Error ? error.message : String(error)}`, fsCode),
      };
    }
    if (info === undefined) {
      return { kind: "missing", archiveId, filename, archivePath, diagnostic: diagnostic("missing", `archive "${archiveId}" is absent`) };
    }
    if (info.type !== "file") {
      return {
        kind: "blocked",
        archiveId,
        filename,
        archivePath,
        warnings: [],
        diagnostic: diagnostic("invalid_shape", `archive target is not a regular file (${info.type})`),
      };
    }
    let text: string;
    try {
      text = await fs.readText(target, options.signal);
    } catch (error) {
      return {
        kind: "blocked",
        archiveId,
        filename,
        archivePath,
        warnings: [],
        diagnostic: diagnostic("filesystem", `archive "${archiveId}" could not be read: ${error instanceof Error ? error.message : String(error)}`, fsCodeOf(error)),
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return {
        kind: "blocked",
        archiveId,
        filename,
        archivePath,
        warnings: [],
        diagnostic: diagnostic("invalid_json", `archive "${archiveId}" contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
    const classified = classifyRaw(raw, cwd, archiveId, filename, archivePath);
    if (classified.kind === "blocked") {
      return { kind: "blocked", archiveId, filename, archivePath, warnings: classified.warnings, diagnostic: classified.diagnostic };
    }
    return {
      kind: "ready",
      snapshot: classified.snapshot,
      summary: classified.summary,
      compatibility: classified.summary.compatibility,
      warnings: classified.summary.warnings,
    };
  }

  async function read(cwd: string, archiveId: string, options: { signal?: AbortSignal } = {}): Promise<ArchiveRead> {
    validateArchiveId(archiveId);
    const filename = filenameFor(archiveId);
    let target: FsTarget;
    try {
      target = await resolveArchive(cwd, archiveId, options.signal);
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") {
        return { kind: "missing", archiveId, filename, archivePath: `${cwd}/${ARCHIVE_DIR}/${filename}`, diagnostic: diagnostic("missing", `archive "${archiveId}" is absent`, fsCode) };
      }
      return {
        kind: "blocked",
        archiveId,
        filename,
        archivePath: `${cwd}/${ARCHIVE_DIR}/${filename}`,
        warnings: [],
        diagnostic: diagnostic("filesystem", `archive path could not be resolved: ${error instanceof Error ? error.message : String(error)}`, fsCode),
      };
    }
    return readTarget(cwd, archiveId, filename, target, options);
  }

  async function list(cwd: string, options: { signal?: AbortSignal } = {}): Promise<ArchiveList> {
    let directory: FsTarget;
    try {
      directory = await fs.resolve(ARCHIVE_DIR, { cwd, signal: options.signal });
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") return { ready: [], blocked: [] };
      throw new ArchiveStoreError("list_failed", `archive directory could not be resolved: ${error instanceof Error ? error.message : String(error)}`, fsCode);
    }
    let info: FsInfo | undefined;
    try {
      info = await fs.stat(directory, options.signal);
    } catch (error) {
      const fsCode = fsCodeOf(error);
      if (fsCode === "FS_NOT_FOUND") return { ready: [], blocked: [] };
      throw new ArchiveStoreError("list_failed", `archive directory could not be observed: ${error instanceof Error ? error.message : String(error)}`, fsCode);
    }
    if (info === undefined) return { ready: [], blocked: [] };
    if (info.type !== "directory") {
      throw new ArchiveStoreError("list_failed", `archive path is not a directory (${info.type})`);
    }
    let entries: FsDirEntry[];
    try {
      entries = await fs.listDir(directory, options.signal);
    } catch (error) {
      throw new ArchiveStoreError("list_failed", `archive directory could not be listed: ${error instanceof Error ? error.message : String(error)}`, fsCodeOf(error));
    }
    const ready: ArchiveSummary[] = [];
    const blocked: ArchiveBlockedEntry[] = [];
    for (const entry of entries) {
      const archiveId = archiveIdFromFilename(entry.name);
      if (archiveId === undefined) continue;
      const archivePath = fs.processPath(entry.target);
      try {
        validateArchiveId(archiveId);
      } catch (error) {
        blocked.push(blockedEntry(archiveId, entry.name, archivePath, diagnostic("unsafe_id", error instanceof Error ? error.message : String(error))));
        continue;
      }
      if (entry.type !== "file") {
        blocked.push(blockedEntry(archiveId, entry.name, archivePath, diagnostic("invalid_shape", `archive target is not a regular file (${entry.type})`)));
        continue;
      }
      const result = await readTarget(cwd, archiveId, entry.name, entry.target, options);
      if (result.kind === "ready") ready.push(result.summary);
      else if (result.kind === "blocked") blocked.push(blockedEntry(result.archiveId, result.filename, result.archivePath, result.diagnostic));
      else blocked.push(blockedEntry(result.archiveId, result.filename, result.archivePath, diagnostic("filesystem", "archive disappeared while listing")));
    }
    ready.sort((a, b) => b.dismissedAt - a.dismissedAt || a.archiveId.localeCompare(b.archiveId));
    blocked.sort((a, b) => a.filename.localeCompare(b.filename));
    return { ready, blocked };
  }

  async function create(cwd: string, team: TeamState, writeOptions: ArchiveWriteOptions): Promise<ArchiveCreateResult> {
    if (!Number.isFinite(writeOptions.dismissedAt)) throw new ArchiveStoreError("write_failed", "dismissedAt must be a finite number");
    const identity = safeSegment(makeDismissalId(), "dismissal");
    const archiveId = `team-${safeSegment(team.teamId, "unknown")}-${writeOptions.dismissedAt}-${identity}`;
    validateArchiveId(archiveId);
    const filename = filenameFor(archiveId);
    let target: FsTarget;
    try {
      target = await resolveArchive(cwd, archiveId, writeOptions.signal);
      const snapshot: ArchiveSnapshot = {
        ...team,
        status: "dismissed",
        archiveId,
        dismissedAt: writeOptions.dismissedAt,
      };
      const outcome = await fs.writeText(
        target,
        JSON.stringify(snapshot, null, 2),
        { kind: "createIfAbsent" },
        writeOptions.signal,
        writeOptions.policy,
      );
      if (outcome.version === undefined) throw new ArchiveStoreError("write_failed", `archive "${archiveId}" write returned no version`);
      const archivePath = fs.processPath(target);
      const compatibility: ArchiveCompatibility = { source: "v1.1", legacy: false, migratedFields: [] };
      const summary: ArchiveSummary = {
        status: "ready",
        archiveId,
        filename,
        teamId: snapshot.teamId,
        goal: snapshot.mission.objective,
        topology: snapshot.topologyRef.id,
        dismissedAt: snapshot.dismissedAt,
        archivePath,
        compatibility,
        warnings: [],
      };
      return { snapshot, summary, version: wrapVersion(outcome.version) };
    } catch (error) {
      if (error instanceof ArchiveStoreError) throw error;
      throw writeFailure(error, archiveId);
    }
  }

  return { read, list, create };
}
