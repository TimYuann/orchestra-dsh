/**
 * Living Orchestration Document domain.
 *
 * The document is canonical structured state nested in TeamState. This module
 * owns validation, deterministic runtime projection, append-only Driver
 * journal commands, stale detection, and the derived Markdown projection
 * write seam. It never parses Markdown or reads evidence contents.
 */

import type { FsInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { TeamState } from "./orchestra-state.js";

export const ORCHESTRATION_DOCUMENT_SCHEMA_VERSION = 1;
export const ORCHESTRATION_MARKDOWN_RELATIVE_PATH = "orchestra/orchestration.md";

export type CharterStatus = "draft_required" | "legacy_missing";
export type EvidenceKind = "report" | "commit" | "diff" | "test" | "screenshot" | "message" | "file" | "url";

export interface EvidenceRef {
  kind: EvidenceKind;
  ref: string;
  label?: string;
}

export interface RuntimeProjectionRole {
  id: string;
  sessionId: string;
  phase: string;
  reportCount: number;
  lastReport: string | null;
}

export interface RuntimeProjection {
  teamId: string;
  status: TeamState["status"];
  controllerSessionId: string;
  topologyRef: TeamState["topologyRef"];
  mission: {
    objective: string;
    scope: string[];
    constraints: string[];
    acceptanceCriteria: string[];
    nonGoals: string[];
    context: string;
  };
  roles: RuntimeProjectionRole[];
  reports: TeamState["reports"];
  activatedFromArchiveId: string | null;
  projectionAt: number;
}

export interface DriverDecision {
  decisionId: string;
  kind: string;
  summary: string;
  rationale?: string;
  actorSessionId: string;
  createdAt: number;
  evidence: EvidenceRef[];
  affects?: string[];
}

export interface MarkdownProjectionMetadata {
  path: string;
  lastRenderedDocumentRevision?: number;
  hash?: string;
}

export interface OrchestrationDocument {
  schemaVersion: 1;
  documentRevision: number;
  teamId: string;
  semanticWriterSessionId: string;
  charterStatus: CharterStatus;
  currentCharterRevision: null;
  /** Frozen Charter revisions are intentionally empty until Checkpoint 4B. */
  charterRevisions: unknown[];
  runtimeProjection: RuntimeProjection;
  decisions: DriverDecision[];
  createdAt: number;
  updatedAt: number;
  lastReconciledAt: number;
  markdown: MarkdownProjectionMetadata;
}

export type DocumentDiagnosticCode = "invalid_shape" | "invalid_evidence" | "permission_denied" | "revision_conflict" | "stale_projection" | "projection_failed";

export class OrchestrationDocumentError extends Error {
  readonly code: DocumentDiagnosticCode;
  constructor(code: DocumentDiagnosticCode, message: string) {
    super(message);
    this.name = "OrchestrationDocumentError";
    this.code = code;
  }
}

export type DocumentRead =
  | { kind: "ready"; document: OrchestrationDocument; warnings: string[] }
  | { kind: "legacy_missing"; warnings: string[] }
  | { kind: "blocked"; diagnostic: { code: DocumentDiagnosticCode; message: string } };

export type DocumentCommandResult = { kind: "changed" | "noop"; document: OrchestrationDocument };

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (record(input)) {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    }
    return input;
  }
  return JSON.stringify(canonical(value)) ?? "undefined";
}

function evidence(value: unknown): value is EvidenceRef {
  if (!record(value) || !nonEmpty(value.kind) || !nonEmpty(value.ref)) return false;
  if (!["report", "commit", "diff", "test", "screenshot", "message", "file", "url"].includes(value.kind)) return false;
  return value.label === undefined || typeof value.label === "string";
}

function projection(value: unknown): value is RuntimeProjection {
  if (!record(value) || !nonEmpty(value.teamId) || !nonEmpty(value.controllerSessionId) || !["provisioning", "active", "degraded", "blocked", "failed"].includes(value.status) || !nonEmpty(value.status)) return false;
  if (!record(value.topologyRef) || !nonEmpty(value.topologyRef.id) || !["project", "global", "bundled"].includes(value.topologyRef.source)) return false;
  if (!record(value.mission) || !Array.isArray(value.roles) || !Array.isArray(value.reports) || !finiteNumber(value.projectionAt)) return false;
  if (typeof value.mission.objective !== "string" || !stringArray(value.mission.scope) || !stringArray(value.mission.constraints) || !stringArray(value.mission.acceptanceCriteria) || !stringArray(value.mission.nonGoals) || typeof value.mission.context !== "string") return false;
  if (!value.roles.every((role: unknown) => record(role) && nonEmpty(role.id) && nonEmpty(role.sessionId) && ["reserved", "provisioning", "active", "failed"].includes(role.phase) && finiteNumber(role.reportCount) && (role.lastReport === null || typeof role.lastReport === "string"))) return false;
  return value.reports.every((report: unknown) => record(report) && nonEmpty(report.reportId) && nonEmpty(report.roleId) && nonEmpty(report.sessionId) && nonEmpty(report.path) && finiteNumber(report.createdAt));
}

function decision(value: unknown): value is DriverDecision {
  if (!record(value) || !nonEmpty(value.decisionId) || !nonEmpty(value.kind) || !nonEmpty(value.summary) || !nonEmpty(value.actorSessionId) || !finiteNumber(value.createdAt) || !Array.isArray(value.evidence)) return false;
  if (!value.evidence.every(evidence)) return false;
  if (value.rationale !== undefined && typeof value.rationale !== "string") return false;
  return value.affects === undefined || stringArray(value.affects);
}

export function readOrchestrationDocument(raw: unknown, teamId?: string): DocumentRead {
  if (raw === undefined) return { kind: "legacy_missing", warnings: ["Team state has no canonical document; no approved charter was invented"] };
  if (!record(raw)) return { kind: "blocked", diagnostic: { code: "invalid_shape", message: "document must be a JSON object" } };
  if (raw.schemaVersion !== ORCHESTRATION_DOCUMENT_SCHEMA_VERSION || !finiteSafe(raw.documentRevision) || !nonEmpty(raw.teamId) || (teamId !== undefined && raw.teamId !== teamId) || !nonEmpty(raw.semanticWriterSessionId)) {
    return { kind: "blocked", diagnostic: { code: "invalid_shape", message: "document identity or schema is invalid" } };
  }
  if (raw.charterStatus !== "draft_required" && raw.charterStatus !== "legacy_missing") return { kind: "blocked", diagnostic: { code: "invalid_shape", message: "document charterStatus is invalid" } };
  if (raw.currentCharterRevision !== null || !Array.isArray(raw.charterRevisions) || raw.charterRevisions.length !== 0 || !projection(raw.runtimeProjection) || raw.runtimeProjection.teamId !== raw.teamId || !Array.isArray(raw.decisions) || !raw.decisions.every(decision) || !finiteNumber(raw.createdAt) || !finiteNumber(raw.updatedAt) || !finiteNumber(raw.lastReconciledAt)) {
    return { kind: "blocked", diagnostic: { code: "invalid_shape", message: "document runtime, journal, revision, or timestamp shape is invalid" } };
  }
  if (!record(raw.markdown) || !nonEmpty(raw.markdown.path) || (raw.markdown.lastRenderedDocumentRevision !== undefined && !finiteSafe(raw.markdown.lastRenderedDocumentRevision)) || (raw.markdown.hash !== undefined && typeof raw.markdown.hash !== "string")) {
    return { kind: "blocked", diagnostic: { code: "invalid_shape", message: "document Markdown projection metadata is invalid" } };
  }
  return { kind: "ready", document: raw as OrchestrationDocument, warnings: [] };
}

export function runtimeProjectionFromTeam(team: TeamState, projectionAt: number): RuntimeProjection {
  return {
    teamId: team.teamId,
    status: team.status,
    controllerSessionId: team.controllerSessionId,
    topologyRef: clone(team.topologyRef),
    mission: clone(team.mission),
    roles: team.roles.map((role) => ({ id: role.id, sessionId: role.sessionId, phase: role.phase, reportCount: role.reportCount, lastReport: role.lastReport })),
    reports: clone(team.reports),
    activatedFromArchiveId: team.activatedFromArchiveId,
    projectionAt,
  };
}

function semanticProjection(value: RuntimeProjection): Omit<RuntimeProjection, "projectionAt"> {
  const { projectionAt: _ignored, ...rest } = value;
  return rest;
}

export function isRuntimeProjectionStale(document: OrchestrationDocument, team: TeamState): boolean {
  return stable(semanticProjection(document.runtimeProjection)) !== stable(semanticProjection(runtimeProjectionFromTeam(team, document.runtimeProjection.projectionAt)));
}

export function initializeOrchestrationDocument(team: TeamState, now: number): OrchestrationDocument {
  return {
    schemaVersion: ORCHESTRATION_DOCUMENT_SCHEMA_VERSION,
    documentRevision: 0,
    teamId: team.teamId,
    semanticWriterSessionId: team.controllerSessionId,
    charterStatus: "draft_required",
    currentCharterRevision: null,
    charterRevisions: [],
    runtimeProjection: runtimeProjectionFromTeam(team, now),
    decisions: [],
    createdAt: now,
    updatedAt: now,
    lastReconciledAt: now,
    markdown: { path: `${team.rootCwd}/${ORCHESTRATION_MARKDOWN_RELATIVE_PATH}` },
  };
}

function assertWriter(document: OrchestrationDocument, team: TeamState, actorSessionId: string): void {
  if (actorSessionId !== team.controllerSessionId || actorSessionId !== document.semanticWriterSessionId) {
    throw new OrchestrationDocumentError("permission_denied", "only the current Team controller and semantic writer may mutate the document");
  }
}

function nextRevision(document: OrchestrationDocument, now: number): Pick<OrchestrationDocument, "documentRevision" | "updatedAt"> {
  if (!finiteSafe(document.documentRevision) || document.documentRevision >= Number.MAX_SAFE_INTEGER) throw new OrchestrationDocumentError("revision_conflict", "documentRevision cannot advance safely");
  return { documentRevision: document.documentRevision + 1, updatedAt: Math.max(document.updatedAt, now) };
}

export function reconcileOrchestrationDocument(document: OrchestrationDocument, team: TeamState, actorSessionId: string, now: number): DocumentCommandResult {
  assertWriter(document, team, actorSessionId);
  if (document.teamId !== team.teamId) throw new OrchestrationDocumentError("invalid_shape", "document and Team identity differ");
  const next = clone(document);
  const revision = nextRevision(document, now);
  next.runtimeProjection = runtimeProjectionFromTeam(team, now);
  next.lastReconciledAt = now;
  Object.assign(next, revision);
  return { kind: "changed", document: next };
}

export interface DecisionInput {
  decisionId: string;
  kind: string;
  summary: string;
  rationale?: string;
  actorSessionId: string;
  createdAt: number;
  evidence?: EvidenceRef[];
  affects?: string[];
}

export function appendDriverDecision(document: OrchestrationDocument, team: TeamState, input: DecisionInput): DocumentCommandResult {
  assertWriter(document, team, input.actorSessionId);
  const entry: DriverDecision = {
    decisionId: input.decisionId,
    kind: input.kind,
    summary: input.summary,
    ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    actorSessionId: input.actorSessionId,
    createdAt: input.createdAt,
    evidence: clone(input.evidence ?? []),
    ...(input.affects === undefined ? {} : { affects: clone(input.affects) }),
  };
  if (!decision(entry)) throw new OrchestrationDocumentError("invalid_evidence", "decision requires valid id/kind/summary/actor/time/evidence");
  const existing = document.decisions.find((item) => item.decisionId === entry.decisionId);
  if (existing !== undefined) {
    if (stable(existing) === stable(entry)) return { kind: "noop", document };
    throw new OrchestrationDocumentError("revision_conflict", `decisionId ${entry.decisionId} already exists with different payload`);
  }
  const next = clone(document);
  next.decisions.push(entry);
  Object.assign(next, nextRevision(document, entry.createdAt));
  return { kind: "changed", document: next };
}

export function documentSummary(document: OrchestrationDocument | undefined, team: TeamState): {
  status: CharterStatus;
  revision: number;
  stale: boolean;
  lastDecision?: { decisionId: string; kind: string; summary: string };
} {
  if (document === undefined) return { status: "legacy_missing", revision: 0, stale: true };
  const last = document.decisions[document.decisions.length - 1];
  return {
    status: document.charterStatus,
    revision: document.documentRevision,
    stale: isRuntimeProjectionStale(document, team),
    ...(last === undefined ? {} : { lastDecision: { decisionId: last.decisionId, kind: last.kind, summary: last.summary } }),
  };
}

function markdownLine(value: unknown): string {
  return String(value ?? "").replaceAll("\n", " ").replaceAll("\r", " ");
}

function renderEvidence(ref: EvidenceRef): string {
  const label = markdownLine(ref.label ?? `${ref.kind}: ${ref.ref}`);
  return ref.kind === "url" || ref.kind === "file" || ref.kind === "commit" || ref.kind === "diff" || ref.kind === "test" || ref.kind === "screenshot" || ref.kind === "message"
    ? `[${label}](${ref.ref})`
    : label;
}

export function renderOrchestrationMarkdown(document: OrchestrationDocument, stale = false): string {
  const projection = document.runtimeProjection;
  const lines = [
    "# Orchestra Orchestration Document",
    "",
    "## Identity",
    `- Team: ${markdownLine(document.teamId)}`,
    `- Semantic writer: ${markdownLine(document.semanticWriterSessionId)}`,
    `- Document revision: ${document.documentRevision}`,
    `- Charter: ${document.charterStatus} (current revision: none)`,
    "",
    "## Runtime Projection",
    `- Status: ${markdownLine(projection.status)}`,
    `- Controller: ${markdownLine(projection.controllerSessionId)}`,
    `- Topology: ${markdownLine(projection.topologyRef.id)} (${markdownLine(projection.topologyRef.source)})`,
    `- Mission: ${markdownLine(projection.mission.objective)}`,
    `- Projection at: ${projection.projectionAt}`,
    "",
    "### Roles",
    ...projection.roles.map((role) => `- ${markdownLine(role.id)} → ${markdownLine(role.sessionId)} · ${markdownLine(role.phase)} · reports=${role.reportCount} · last=${markdownLine(role.lastReport ?? "none")}`),
    "",
    "### Reports / Evidence",
    ...projection.reports.map((report) => `- ${markdownLine(report.reportId)} (${markdownLine(report.roleId)}): ${renderEvidence({ kind: "file", ref: report.path })}`),
    "",
    "## Driver Decision Journal",
    ...(document.decisions.length === 0 ? ["- No decisions recorded."] : document.decisions.map((item, index) => [
      `### ${index + 1}. ${markdownLine(item.kind)} — ${markdownLine(item.decisionId)}`,
      `- ${markdownLine(item.summary)}`,
      ...(item.rationale === undefined ? [] : [`- Rationale: ${markdownLine(item.rationale)}`]),
      `- Actor: ${markdownLine(item.actorSessionId)} · at=${item.createdAt}`,
      `- Evidence: ${item.evidence.length === 0 ? "none" : item.evidence.map(renderEvidence).join(", ")}`,
    ].join("\n"))),
    "",
    `- Runtime projection stale: ${stale}`,
    `- Markdown is derived; canonical source is active team.json document revision ${document.documentRevision}.`,
    "",
  ];
  return `${lines.join("\n").replaceAll("\n\n\n", "\n\n")}\n`;
}

export interface DocumentProjectionFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>;
}

export interface MarkdownProjectionResult {
  status: "rendered" | "projection_failed" | "stale";
  path: string;
  message?: string;
}

export async function writeMarkdownProjection(
  fs: DocumentProjectionFileSystem,
  cwd: string,
  document: OrchestrationDocument,
  options: { policy: SandboxExecutionPolicy; signal?: AbortSignal; stale?: boolean },
): Promise<MarkdownProjectionResult> {
  let path = `${cwd}/${ORCHESTRATION_MARKDOWN_RELATIVE_PATH}`;
  try {
    const target = await fs.resolve(ORCHESTRATION_MARKDOWN_RELATIVE_PATH, { cwd, signal: options.signal });
    path = fs.processPath(target);
    const info = await fs.stat(target, options.signal);
    const expected: FsWriteIntent = info === undefined
      ? { kind: "createIfAbsent" }
      : info.version === undefined
        ? { kind: "createIfAbsent" }
        : { kind: "replaceIfVersion", version: info.version };
    await fs.writeText(target, renderOrchestrationMarkdown(document, options.stale === true), expected, options.signal, options.policy);
    return { status: "rendered", path };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return { status: code === "FS_STALE_VERSION" ? "stale" : "projection_failed", path, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectMarkdownProjection(
  fs: DocumentProjectionFileSystem,
  cwd: string,
  document: OrchestrationDocument,
  stale = false,
  signal?: AbortSignal,
): Promise<MarkdownProjectionResult> {
  let path = `${cwd}/${ORCHESTRATION_MARKDOWN_RELATIVE_PATH}`;
  try {
    const target = await fs.resolve(ORCHESTRATION_MARKDOWN_RELATIVE_PATH, { cwd, signal });
    path = fs.processPath(target);
    const info = await fs.stat(target, signal);
    if (info === undefined) return { status: "projection_failed", path, message: "derived Markdown projection is missing" };
    const text = await fs.readText(target, signal);
    return text === renderOrchestrationMarkdown(document, stale)
      ? { status: "rendered", path }
      : { status: "stale", path, message: "derived Markdown does not match canonical document" };
  } catch (error) {
    return { status: "projection_failed", path, message: error instanceof Error ? error.message : String(error) };
  }
}
