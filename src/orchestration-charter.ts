/**
 * Governed Orchestra Charter lifecycle.
 *
 * This deep module owns the append-only Session event contract for Draft →
 * user-command Approval → immutable Freeze. Callers provide an event log and
 * receive validated facts or a durable event to append; command handlers do
 * not fold, hash, or mutate charter state themselves.
 */

import { createHash, randomUUID } from "node:crypto";
import type { TopologyConfig, TopologySource } from "./orchestra-topology.js";
import { validateTopology } from "./orchestra-topology.js";

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "orchestra/charter-draft": { draft: CharterDraft };
    "orchestra/charter-approved": { approval: CharterApproval };
    "orchestra/charter-frozen": { frozen: FrozenCharterRevision };
  }
}

export const CHARTER_SCHEMA_VERSION = 1;
export const CHARTER_DRAFT_EVENT = "orchestra/charter-draft";
export const CHARTER_APPROVAL_EVENT = "orchestra/charter-approved";
export const CHARTER_FROZEN_EVENT = "orchestra/charter-frozen";

const SAFE_DRAFT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;

export interface CharterMission {
  objective: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  context: string;
}

export type HumanParticipationMode = "interactive" | "checkpointed" | "autonomous";
export type HumanUnavailableAction = "block" | "safe_stop" | "continue_without_gate";

export interface HumanParticipationPolicy {
  mode: HumanParticipationMode;
  onUnavailable: HumanUnavailableAction;
  summary?: string;
  /** Reserved for future Gate nodes; 4B only validates the fallback. */
  requiredHumanGate?: boolean;
}

export interface CharterTopologySnapshot {
  source: "catalog" | "inline";
  id: string;
  catalogSource?: TopologySource;
  config: TopologyConfig;
}

export interface CharterDraft {
  schemaVersion: 1;
  draftId: string;
  revision: number;
  baseTeamId?: string;
  baseCharterRevision?: number;
  mission: CharterMission;
  topology: CharterTopologySnapshot;
  humanParticipationPolicy: HumanParticipationPolicy;
  authorSessionId: string;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  summary?: string;
  digest: string;
}

export interface CharterApproval {
  schemaVersion: 1;
  draftId: string;
  revision: number;
  digest: string;
  approvalRef: string;
  commandId: string;
  approvedAt: number;
  approvingSessionId: string;
  source: "user-command";
}

export interface FrozenCharterRevision {
  schemaVersion: 1;
  charterRevision: number;
  draftId: string;
  draftRevision: number;
  frozenRef: string;
  digest: string;
  mission: CharterMission;
  topology: CharterTopologySnapshot;
  humanParticipationPolicy: HumanParticipationPolicy;
  approval: CharterApproval;
  sourceSessionId: string;
  frozenBySessionId: string;
  frozenAt: number;
  baseTeamId?: string;
  baseCharterRevision?: number;
  reason?: string;
  impact?: string;
}

export interface CharterEvent {
  type: string;
  data: unknown;
}

export type CharterDiagnosticCode =
  | "invalid_shape"
  | "invalid_digest"
  | "invalid_topology"
  | "invalid_human_policy"
  | "not_found"
  | "revision_conflict"
  | "approval_required"
  | "approval_conflict"
  | "frozen_conflict"
  | "permission_denied";

export class CharterError extends Error {
  readonly code: CharterDiagnosticCode;

  constructor(code: CharterDiagnosticCode, message: string) {
    super(message);
    this.name = "CharterError";
    this.code = code;
  }
}

export type CharterFold =
  | {
      kind: "ready";
      drafts: CharterDraft[];
      approvals: CharterApproval[];
      freezes: FrozenCharterRevision[];
    }
  | {
      kind: "blocked";
      diagnostic: { code: CharterDiagnosticCode; message: string };
    };

export type CharterCommandResult<T> =
  | { kind: "changed"; event: CharterEvent; value: T }
  | { kind: "noop"; value: T };

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? "undefined";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function digestPayload(value: {
  draftId: string;
  revision: number;
  baseTeamId?: string;
  baseCharterRevision?: number;
  mission: CharterMission;
  topology: CharterTopologySnapshot;
  humanParticipationPolicy: HumanParticipationPolicy;
}) {
  return {
    draftId: value.draftId,
    revision: value.revision,
    ...(value.baseTeamId === undefined ? {} : { baseTeamId: value.baseTeamId }),
    ...(value.baseCharterRevision === undefined ? {} : { baseCharterRevision: value.baseCharterRevision }),
    mission: value.mission,
    topology: value.topology,
    humanParticipationPolicy: value.humanParticipationPolicy,
  };
}

export function draftDigest(draft: CharterDraft): string {
  return sha256(digestPayload(draft));
}

export function draftRef(draftId: string, revision: number): string {
  return `${draftId}@${revision}`;
}

export function frozenRef(draftId: string, revision: number, digest: string): string {
  return `${draftRef(draftId, revision)}#${digest}`;
}

function validDraftId(value: unknown): value is string {
  return typeof value === "string" && SAFE_DRAFT_ID.test(value);
}

function validMission(value: unknown): value is CharterMission {
  if (!record(value) || !nonEmpty(value.objective)) return false;
  return stringArray(value.scope) && stringArray(value.constraints) && stringArray(value.acceptanceCriteria) && stringArray(value.nonGoals) && typeof value.context === "string";
}

function validHumanPolicy(value: unknown): value is HumanParticipationPolicy {
  if (!record(value) || !["interactive", "checkpointed", "autonomous"].includes(value.mode) || !["block", "safe_stop", "continue_without_gate"].includes(value.onUnavailable)) return false;
  if (value.summary !== undefined && typeof value.summary !== "string") return false;
  if (value.requiredHumanGate !== undefined && typeof value.requiredHumanGate !== "boolean") return false;
  if (value.mode === "autonomous" && value.requiredHumanGate === true && value.onUnavailable === "block") return false;
  return true;
}

function validTopologySnapshot(value: unknown): value is CharterTopologySnapshot {
  if (!record(value) || !["catalog", "inline"].includes(value.source) || !nonEmpty(value.id) || !record(value.config)) return false;
  if (value.catalogSource !== undefined && !["project", "global", "bundled"].includes(value.catalogSource)) return false;
  if (value.source === "catalog" && value.catalogSource === undefined) return false;
  if (value.config.id !== value.id) return false;
  return validateTopology(value.config).length === 0;
}

function validDraft(value: unknown): value is CharterDraft {
  if (!record(value) || value.schemaVersion !== CHARTER_SCHEMA_VERSION || !validDraftId(value.draftId) || !safeInteger(value.revision) || !validMission(value.mission) || !validTopologySnapshot(value.topology) || !validHumanPolicy(value.humanParticipationPolicy) || !nonEmpty(value.authorSessionId) || !finite(value.createdAt) || !finite(value.updatedAt) || !DIGEST.test(String(value.digest))) return false;
  if (value.baseTeamId !== undefined && !nonEmpty(value.baseTeamId)) return false;
  if (value.baseCharterRevision !== undefined && (!safeInteger(value.baseCharterRevision) || value.baseTeamId === undefined)) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.summary !== undefined && typeof value.summary !== "string") return false;
  if (value.humanParticipationPolicy.mode === "autonomous" && value.topology.config.protocol?.gates?.some((gate: any) => gate.required === true && gate.onUnavailable !== "fallback")) return false;
  return draftDigest(value as CharterDraft) === value.digest;
}

function validApproval(value: unknown): value is CharterApproval {
  if (!record(value) || value.schemaVersion !== CHARTER_SCHEMA_VERSION || !validDraftId(value.draftId) || !safeInteger(value.revision) || !DIGEST.test(String(value.digest)) || !nonEmpty(value.commandId) || !finite(value.approvedAt) || !nonEmpty(value.approvingSessionId) || value.source !== "user-command") return false;
  return value.approvalRef === frozenRef(value.draftId, value.revision, value.digest);
}

export function validateFrozenCharterRevision(value: unknown): value is FrozenCharterRevision {
  if (!record(value) || value.schemaVersion !== CHARTER_SCHEMA_VERSION || !safeInteger(value.charterRevision) || !validDraftId(value.draftId) || !safeInteger(value.draftRevision) || !DIGEST.test(String(value.digest)) || !validMission(value.mission) || !validTopologySnapshot(value.topology) || !validHumanPolicy(value.humanParticipationPolicy) || !validApproval(value.approval) || !nonEmpty(value.sourceSessionId) || !nonEmpty(value.frozenBySessionId) || !finite(value.frozenAt)) return false;
  if (value.frozenRef !== frozenRef(value.draftId, value.draftRevision, value.digest)) return false;
  if (sha256(digestPayload({ draftId: value.draftId, revision: value.draftRevision, baseTeamId: value.baseTeamId, baseCharterRevision: value.baseCharterRevision, mission: value.mission, topology: value.topology, humanParticipationPolicy: value.humanParticipationPolicy })) !== value.digest) return false;
  if (value.approval.draftId !== value.draftId || value.approval.revision !== value.draftRevision || value.approval.digest !== value.digest) return false;
  if (value.baseTeamId !== undefined && !nonEmpty(value.baseTeamId)) return false;
  if (value.baseCharterRevision !== undefined && (!safeInteger(value.baseCharterRevision) || value.baseTeamId === undefined)) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.impact !== undefined && typeof value.impact !== "string") return false;
  return true;
}

export function validateFrozenCharterRevisions(value: unknown): { ok: true; revisions: FrozenCharterRevision[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: "charterRevisions must be an array" };
  const revisions: FrozenCharterRevision[] = [];
  for (const [index, item] of value.entries()) {
    if (!validateFrozenCharterRevision(item)) return { ok: false, message: `charter revision at index ${index} is invalid` };
    const expected = revisions.length + 1;
    if (item.charterRevision !== expected) return { ok: false, message: `charter revisions must be continuous from 1 (expected ${expected})` };
    if (revisions.some((revision) => revision.charterRevision === item.charterRevision || revision.frozenRef === item.frozenRef)) {
      return { ok: false, message: `charter revision ${item.charterRevision} is duplicated` };
    }
    revisions.push(clone(item));
  }
  return { ok: true, revisions };
}

function foldError(code: CharterDiagnosticCode, message: string): CharterFold {
  return { kind: "blocked", diagnostic: { code, message } };
}

function latestDraftOf(drafts: readonly CharterDraft[], draftId: string): CharterDraft | undefined {
  for (let index = drafts.length - 1; index >= 0; index--) {
    if (drafts[index].draftId === draftId) return drafts[index];
  }
  return undefined;
}

export function foldCharterEvents(events: readonly unknown[]): CharterFold {
  const drafts: CharterDraft[] = [];
  const approvals: CharterApproval[] = [];
  const freezes: FrozenCharterRevision[] = [];
  for (const [index, rawEvent] of events.entries()) {
    if (!record(rawEvent) || typeof rawEvent.type !== "string") continue;
    if (rawEvent.type !== CHARTER_DRAFT_EVENT && rawEvent.type !== CHARTER_APPROVAL_EVENT && rawEvent.type !== CHARTER_FROZEN_EVENT) continue;
    if (!record(rawEvent.data)) return foldError("invalid_shape", `charter event at index ${index} has invalid data`);
    if (rawEvent.type === CHARTER_DRAFT_EVENT) {
      const draft = rawEvent.data.draft;
      if (!validDraft(draft)) return foldError("invalid_shape", `charter draft event at index ${index} is invalid`);
      const previous = latestDraftOf(drafts, draft.draftId);
      const expected = previous === undefined ? 1 : previous.revision + 1;
      if (draft.revision !== expected) return foldError("revision_conflict", `draft ${draft.draftId} expected revision ${expected}, got ${draft.revision}`);
      drafts.push(clone(draft));
      continue;
    }
    if (rawEvent.type === CHARTER_APPROVAL_EVENT) {
      const approval = rawEvent.data.approval;
      if (!validApproval(approval)) return foldError("invalid_shape", `charter approval event at index ${index} is invalid`);
      const current = latestDraftOf(drafts, approval.draftId);
      if (current === undefined || current.digest !== approval.digest) return foldError("approval_required", `approval at index ${index} does not reference the current draft digest`);
      if (approvals.some((entry) => entry.approvalRef === approval.approvalRef)) return foldError("approval_conflict", `duplicate approval ${approval.approvalRef}`);
      approvals.push(clone(approval));
      continue;
    }
    const frozen = rawEvent.data.frozen;
    if (!validateFrozenCharterRevision(frozen)) return foldError("invalid_shape", `frozen charter event at index ${index} is invalid`);
    const current = latestDraftOf(drafts, frozen.draftId);
    if (current === undefined || current.digest !== frozen.digest) return foldError("frozen_conflict", `freeze at index ${index} does not reference the current draft digest`);
    if (frozen.sourceSessionId !== current.authorSessionId || canonicalJson(frozen.mission) !== canonicalJson(current.mission) || canonicalJson(frozen.topology) !== canonicalJson(current.topology) || canonicalJson(frozen.humanParticipationPolicy) !== canonicalJson(current.humanParticipationPolicy)) {
      return foldError("frozen_conflict", `freeze at index ${index} does not preserve the approved Draft snapshot`);
    }
    if (!approvals.some((entry) => entry.approvalRef === frozen.approval.approvalRef)) return foldError("approval_required", `freeze ${frozen.frozenRef} has no durable user approval`);
    const expectedRevision = frozen.baseCharterRevision === undefined ? 1 : frozen.baseCharterRevision + 1;
    if (frozen.charterRevision !== expectedRevision) return foldError("revision_conflict", `freeze ${frozen.frozenRef} expected charter revision ${expectedRevision}`);
    if (freezes.some((entry) => entry.frozenRef === frozen.frozenRef || (entry.baseTeamId !== undefined && entry.baseTeamId === frozen.baseTeamId && entry.charterRevision === frozen.charterRevision))) {
      return foldError("frozen_conflict", `duplicate charter revision ${frozen.charterRevision}`);
    }
    freezes.push(clone(frozen));
  }
  return { kind: "ready", drafts, approvals, freezes };
}

export interface DraftCommandInput {
  draftId?: string;
  expectedRevision?: number;
  mission: CharterMission;
  topology: CharterTopologySnapshot;
  humanParticipationPolicy: HumanParticipationPolicy;
  authorSessionId: string;
  now: number;
  reason?: string;
  summary?: string;
  baseTeamId?: string;
  baseCharterRevision?: number;
}

function makeDraft(input: DraftCommandInput, draftId: string, revision: number): CharterDraft {
  const body: Omit<CharterDraft, "digest"> = {
    schemaVersion: CHARTER_SCHEMA_VERSION,
    draftId,
    revision,
    ...(input.baseTeamId === undefined ? {} : { baseTeamId: input.baseTeamId }),
    ...(input.baseCharterRevision === undefined ? {} : { baseCharterRevision: input.baseCharterRevision }),
    mission: clone(input.mission),
    topology: clone(input.topology),
    humanParticipationPolicy: clone(input.humanParticipationPolicy),
    authorSessionId: input.authorSessionId,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  };
  const draft = { ...body, digest: "" } as CharterDraft;
  draft.digest = draftDigest(draft);
  return draft;
}

function assertDraftInput(input: DraftCommandInput): void {
  if (!validMission(input.mission)) throw new CharterError("invalid_shape", "charter mission is incomplete");
  if (!validTopologySnapshot(input.topology)) throw new CharterError("invalid_topology", "charter topology snapshot is invalid");
  if (!validHumanPolicy(input.humanParticipationPolicy)) throw new CharterError("invalid_human_policy", "human participation policy is invalid");
  if (input.humanParticipationPolicy.mode === "autonomous" && input.topology.config.protocol?.gates?.some((gate: any) => gate.required === true && gate.onUnavailable !== "fallback")) throw new CharterError("invalid_human_policy", "autonomous required Human Gates must have a pre-approved fallback");
  if (!nonEmpty(input.authorSessionId) || !finite(input.now)) throw new CharterError("invalid_shape", "charter author and timestamp are required");
  if (input.baseCharterRevision !== undefined && input.baseTeamId === undefined) throw new CharterError("invalid_shape", "baseCharterRevision requires baseTeamId");
}

export function prepareDraftEvent(events: readonly unknown[], input: DraftCommandInput): CharterCommandResult<CharterDraft> {
  assertDraftInput(input);
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") throw new CharterError(folded.diagnostic.code, folded.diagnostic.message);
  if (input.draftId === undefined) {
    const id = `draft-${randomUUID()}`;
    const draft = makeDraft(input, id, 1);
    return { kind: "changed", event: { type: CHARTER_DRAFT_EVENT, data: { draft } }, value: draft };
  }
  if (!validDraftId(input.draftId)) throw new CharterError("invalid_shape", "draftId must use safe lower-kebab syntax");
  const current = latestDraftOf(folded.drafts, input.draftId);
  if (current === undefined) {
    if (input.expectedRevision !== undefined) throw new CharterError("not_found", `draft ${input.draftId} was not found`);
    const draft = makeDraft(input, input.draftId, 1);
    return { kind: "changed", event: { type: CHARTER_DRAFT_EVENT, data: { draft } }, value: draft };
  }
  if (input.baseTeamId !== current.baseTeamId || input.baseCharterRevision !== current.baseCharterRevision) {
    throw new CharterError("revision_conflict", `draft ${input.draftId} base charter is stale`);
  }
  if (input.expectedRevision !== current.revision) throw new CharterError("revision_conflict", `draft ${input.draftId} is at revision ${current.revision}; expectedRevision is required`);
  const draft = makeDraft({ ...input, baseTeamId: input.baseTeamId ?? current.baseTeamId, baseCharterRevision: input.baseCharterRevision ?? current.baseCharterRevision, now: input.now }, input.draftId, current.revision + 1);
  return { kind: "changed", event: { type: CHARTER_DRAFT_EVENT, data: { draft } }, value: draft };
}

export interface ApprovalCommandInput {
  draftId: string;
  revision: number;
  commandId: string;
  approvingSessionId: string;
  approvedAt: number;
}

export function prepareApprovalEvent(events: readonly unknown[], input: ApprovalCommandInput): CharterCommandResult<CharterApproval> {
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") throw new CharterError(folded.diagnostic.code, folded.diagnostic.message);
  const draft = latestDraftOf(folded.drafts, input.draftId);
  if (draft === undefined) throw new CharterError("not_found", `draft ${input.draftId} was not found`);
  if (draft.revision !== input.revision) throw new CharterError("revision_conflict", `draft ${input.draftId} is at revision ${draft.revision}; approval target is stale`);
  const ref = frozenRef(draft.draftId, draft.revision, draft.digest);
  const existing = folded.approvals.find((approval) => approval.approvalRef === ref);
  if (existing !== undefined) return { kind: "noop", value: existing };
  const approval: CharterApproval = {
    schemaVersion: CHARTER_SCHEMA_VERSION,
    draftId: draft.draftId,
    revision: draft.revision,
    digest: draft.digest,
    approvalRef: ref,
    commandId: input.commandId,
    approvedAt: input.approvedAt,
    approvingSessionId: input.approvingSessionId,
    source: "user-command",
  };
  if (!validApproval(approval)) throw new CharterError("invalid_shape", "approval facts are invalid");
  return { kind: "changed", event: { type: CHARTER_APPROVAL_EVENT, data: { approval } }, value: approval };
}

export interface FreezeCommandInput {
  draftId: string;
  revision: number;
  digest: string;
  frozenBySessionId: string;
  frozenAt: number;
}

export function prepareFreezeEvent(events: readonly unknown[], input: FreezeCommandInput): CharterCommandResult<FrozenCharterRevision> {
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") throw new CharterError(folded.diagnostic.code, folded.diagnostic.message);
  const draft = latestDraftOf(folded.drafts, input.draftId);
  if (draft === undefined) throw new CharterError("not_found", `draft ${input.draftId} was not found`);
  if (draft.revision !== input.revision || draft.digest !== input.digest) throw new CharterError("revision_conflict", "freeze target revision or digest is stale");
  const ref = frozenRef(draft.draftId, draft.revision, draft.digest);
  const existing = folded.freezes.find((freeze) => freeze.frozenRef === ref);
  if (existing !== undefined) return { kind: "noop", value: existing };
  const approval = folded.approvals.find((entry) => entry.approvalRef === ref);
  if (approval === undefined) throw new CharterError("approval_required", `freeze ${ref} requires the exact user-command approval first`);
  const frozen: FrozenCharterRevision = {
    schemaVersion: CHARTER_SCHEMA_VERSION,
    charterRevision: draft.baseCharterRevision === undefined ? 1 : draft.baseCharterRevision + 1,
    draftId: draft.draftId,
    draftRevision: draft.revision,
    frozenRef: ref,
    digest: draft.digest,
    mission: clone(draft.mission),
    topology: clone(draft.topology),
    humanParticipationPolicy: clone(draft.humanParticipationPolicy),
    approval: clone(approval),
    sourceSessionId: draft.authorSessionId,
    frozenBySessionId: input.frozenBySessionId,
    frozenAt: input.frozenAt,
    ...(draft.baseTeamId === undefined ? {} : { baseTeamId: draft.baseTeamId }),
    ...(draft.baseCharterRevision === undefined ? {} : { baseCharterRevision: draft.baseCharterRevision }),
    ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    ...(draft.summary === undefined ? {} : { impact: draft.summary }),
  };
  if (!validateFrozenCharterRevision(frozen)) throw new CharterError("invalid_shape", "frozen charter facts are invalid");
  return { kind: "changed", event: { type: CHARTER_FROZEN_EVENT, data: { frozen } }, value: frozen };
}

export function resolveFrozenCharter(events: readonly unknown[], ref: string): FrozenCharterRevision {
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") throw new CharterError(folded.diagnostic.code, folded.diagnostic.message);
  const value = folded.freezes.find((freeze) => freeze.frozenRef === ref);
  if (value === undefined) throw new CharterError("approval_required", `frozen charter ${ref} is missing or not durably approved and frozen`);
  return clone(value);
}

export function latestDraft(events: readonly unknown[], draftId: string): CharterDraft | undefined {
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") throw new CharterError(folded.diagnostic.code, folded.diagnostic.message);
  const value = latestDraftOf(folded.drafts, draftId);
  return value === undefined ? undefined : clone(value);
}

export function charterSummary(events: readonly unknown[], draftId: string): {
  draft: CharterDraft;
  approval?: CharterApproval;
  frozen?: FrozenCharterRevision;
} {
  const folded = foldCharterEvents(events);
  if (folded.kind === "blocked") throw new CharterError(folded.diagnostic.code, folded.diagnostic.message);
  const draft = latestDraftOf(folded.drafts, draftId);
  if (draft === undefined) throw new CharterError("not_found", `draft ${draftId} was not found`);
  const approval = folded.approvals.find((entry) => entry.draftId === draft.draftId && entry.revision === draft.revision);
  const frozen = folded.freezes.find((entry) => entry.frozenRef === frozenRef(draft.draftId, draft.revision, draft.digest));
  return { draft: clone(draft), ...(approval === undefined ? {} : { approval: clone(approval) }), ...(frozen === undefined ? {} : { frozen: clone(frozen) }) };
}
