/**
 * Bounded Graph Runtime domain.
 *
 * This deep module owns the append-only execution DAG, bounded loop state
 * machine, typed handoff facts, verdict ownership, and cap-exhausted facts.
 * Callers receive a next TeamState.graphRuntime and persist it through the
 * ActiveTeam CAS seam; no caller may mutate events in place.
 */

import { randomUUID } from "node:crypto";
import type { EvidenceRef } from "./orchestration-document.js";
import type { TeamRole, TeamState } from "./orchestra-state.js";
import type { TopologyHandoffContract, TopologyLoopContract } from "./orchestra-topology.js";

export const GRAPH_RUNTIME_SCHEMA_VERSION = 1;

export type GraphEventType =
  | "loop_started"
  | "attempt_started"
  | "handoff_pending"
  | "handoff_accepted"
  | "handoff_failed"
  | "verdict_recorded"
  | "attempt_completed"
  | "cap_exhausted"
  | "remediation_requested";

export interface GraphEvent {
  eventId: string;
  seq: number;
  type: GraphEventType;
  actorSessionId: string;
  roleId?: string;
  nodeId?: string;
  loopInstanceId?: string;
  parents: string[];
  createdAt: number;
  payload: Record<string, unknown>;
  evidence: EvidenceRef[];
}

export interface GraphRuntimeState {
  schemaVersion: 1;
  runtimeRevision: number;
  teamId: string;
  charterRevision: number;
  charterDigest: string;
  events: GraphEvent[];
  updatedAt: number;
}

export type GraphRead =
  | { kind: "ready"; runtime: GraphRuntimeState; warnings: string[] }
  | { kind: "legacy_missing"; warnings: string[] }
  | { kind: "stale"; runtime: GraphRuntimeState; warnings: string[] }
  | { kind: "blocked"; diagnostic: { code: GraphDiagnosticCode; message: string } };

export type GraphDiagnosticCode =
  | "invalid_shape"
  | "invalid_event"
  | "unknown_parent"
  | "cycle"
  | "duplicate_event"
  | "revision_conflict"
  | "permission_denied"
  | "loop_not_found"
  | "loop_terminal"
  | "attempt_conflict"
  | "role_not_participant"
  | "evaluator_required"
  | "cap_exhausted"
  | "stale_charter"
  | "handoff_invalid";

export class GraphRuntimeError extends Error {
  readonly code: GraphDiagnosticCode;

  constructor(code: GraphDiagnosticCode, message: string) {
    super(message);
    this.name = "GraphRuntimeError";
    this.code = code;
  }
}

export interface LoopAttemptSummary {
  attempt: number;
  roleId: string;
  sessionId: string;
  status: "started" | "passed" | "failed" | "blocked";
  candidate?: Record<string, unknown>;
  verdict?: "PASS" | "FAIL" | "BLOCKED";
  findings?: string[];
  evidence: EvidenceRef[];
}

export interface LoopSummary {
  loopInstanceId: string;
  loopId: string;
  status: "running" | "passed" | "blocked" | "cap_exhausted";
  evaluatorRole: string;
  maxAttempts: number;
  attempts: LoopAttemptSummary[];
  capExhausted: boolean;
  unresolvedFindings: string[];
}

export interface HandoffSummary {
  handoffId: string;
  loopInstanceId?: string;
  attempt?: number;
  fromRole: string;
  toRole: string;
  targetSessionId?: string;
  status: "pending" | "accepted" | "failed";
  receipt?: Record<string, unknown>;
  error?: string;
  summary: string;
  evidence: EvidenceRef[];
}

export interface GraphProjectionSummary {
  status: "idle" | "running" | "passed" | "blocked" | "cap_exhausted" | "stale" | "legacy_missing";
  currentLoop?: { loopInstanceId: string; loopId: string; attempt?: number; status: LoopSummary["status"] };
  pendingHandoffs: HandoffSummary[];
  capExhausted: string[];
  runtimeRevision?: number;
  stale: boolean;
}

export type GraphCommandResult =
  | { kind: "changed"; runtime: GraphRuntimeState; events: GraphEvent[] }
  | { kind: "noop"; runtime: GraphRuntimeState; events: [] };

const EVENT_TYPES = new Set<GraphEventType>([
  "loop_started",
  "attempt_started",
  "handoff_pending",
  "handoff_accepted",
  "handoff_failed",
  "verdict_recorded",
  "attempt_completed",
  "cap_exhausted",
  "remediation_requested",
]);

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stable(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (record(input)) return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    return input;
  };
  return JSON.stringify(canonical(value)) ?? "undefined";
}

function evidence(value: unknown): value is EvidenceRef {
  return record(value) && ["report", "commit", "diff", "test", "screenshot", "message", "file", "url"].includes(value.kind) && nonEmpty(value.ref) && (value.label === undefined || typeof value.label === "string");
}

function evidenceArray(value: unknown): value is EvidenceRef[] {
  return Array.isArray(value) && value.every(evidence);
}

function validEvent(value: unknown): value is GraphEvent {
  return record(value) && nonEmpty(value.eventId) && safePositive(value.seq) && EVENT_TYPES.has(value.type) && nonEmpty(value.actorSessionId) && Array.isArray(value.parents) && value.parents.every(nonEmpty) && finite(value.createdAt) && record(value.payload) && evidenceArray(value.evidence) && (value.roleId === undefined || nonEmpty(value.roleId)) && (value.nodeId === undefined || nonEmpty(value.nodeId)) && (value.loopInstanceId === undefined || nonEmpty(value.loopInstanceId)) && (value.nodeId !== undefined || value.loopInstanceId !== undefined);
}

function diagnostic(code: GraphDiagnosticCode, message: string): GraphRead {
  return { kind: "blocked", diagnostic: { code, message } };
}

export function initializeGraphRuntime(teamId: string, charterRevision: number, charterDigest: string, now: number): GraphRuntimeState {
  if (!nonEmpty(teamId) || !safePositive(charterRevision) || !nonEmpty(charterDigest) || !finite(now)) throw new GraphRuntimeError("invalid_shape", "graph runtime requires Team and frozen charter identity");
  return { schemaVersion: GRAPH_RUNTIME_SCHEMA_VERSION, runtimeRevision: 0, teamId, charterRevision, charterDigest, events: [], updatedAt: now };
}

export function readGraphRuntime(raw: unknown, teamId: string, charterRevision?: number, charterDigest?: string): GraphRead {
  if (raw === undefined) return { kind: "legacy_missing", warnings: ["Team has no graph runtime; no execution history was invented"] };
  if (!record(raw) || raw.schemaVersion !== GRAPH_RUNTIME_SCHEMA_VERSION || !safePositive(raw.runtimeRevision) && raw.runtimeRevision !== 0 || !nonEmpty(raw.teamId) || !safePositive(raw.charterRevision) || !nonEmpty(raw.charterDigest) || !Array.isArray(raw.events) || !finite(raw.updatedAt)) return diagnostic("invalid_shape", "graph runtime root is malformed");
  if (raw.teamId !== teamId) return diagnostic("invalid_shape", "graph runtime Team identity differs");
  const ids = new Set<string>();
  for (const [index, rawEvent] of raw.events.entries()) {
    if (!validEvent(rawEvent)) return diagnostic("invalid_event", `graph event at index ${index} is malformed`);
    if (rawEvent.seq !== index + 1) return diagnostic("revision_conflict", `graph event at index ${index} has non-continuous seq`);
    if (ids.has(rawEvent.eventId)) return diagnostic("duplicate_event", `graph event ${rawEvent.eventId} is duplicated`);
    for (const parent of rawEvent.parents) {
      if (!ids.has(parent)) return diagnostic(parent === rawEvent.eventId ? "cycle" : "unknown_parent", `graph event ${rawEvent.eventId} references a non-earlier parent ${parent}`);
    }
    ids.add(rawEvent.eventId);
  }
  if (raw.runtimeRevision !== raw.events.length) return diagnostic("revision_conflict", "graph runtimeRevision must equal the append-only event count");
  try {
    deriveGraph(raw as GraphRuntimeState);
  } catch (error) {
    return diagnostic(error instanceof GraphRuntimeError ? error.code : "invalid_event", error instanceof Error ? error.message : String(error));
  }
  if (charterRevision !== undefined && (raw.charterRevision !== charterRevision || raw.charterDigest !== charterDigest)) {
    return { kind: "stale", runtime: raw as GraphRuntimeState, warnings: ["graph runtime is bound to an older Frozen Charter; no history was migrated"] };
  }
  return { kind: "ready", runtime: clone(raw as GraphRuntimeState), warnings: [] };
}

function loopContractValid(contract: TopologyLoopContract): boolean {
  return nonEmpty(contract.loopId) && record(contract.entry) && nonEmpty(contract.entry.role) && nonEmpty(contract.entry.event) && Array.isArray(contract.participants) && contract.participants.length > 0 && contract.participants.every(nonEmpty) && nonEmpty(contract.evaluatorRole) && nonEmpty(contract.candidateKind) && nonEmpty(contract.verdictKind) && safePositive(contract.maxAttempts) && nonEmpty(contract.passRoute) && nonEmpty(contract.retryRoute) && nonEmpty(contract.capExhaustedRoute) && Array.isArray(contract.requiredEvidenceKinds) && contract.requiredEvidenceKinds.every(nonEmpty);
}

function roleFor(team: TeamState, roleId: string): TeamRole {
  const role = team.roles.find((entry) => entry.id.toLowerCase() === roleId.toLowerCase());
  if (role === undefined) throw new GraphRuntimeError("role_not_participant", `role ${roleId} is not in the current Team`);
  if (role.phase !== "active") throw new GraphRuntimeError("role_not_participant", `role ${role.id} is not active`);
  return role;
}

function currentCharterMatches(runtime: GraphRuntimeState, team: TeamState): void {
  if (runtime.teamId !== team.teamId) throw new GraphRuntimeError("stale_charter", "graph runtime Team identity differs");
  const current = team.document?.currentCharterRevision === null || team.document?.currentCharterRevision === undefined
    ? undefined
    : team.document.charterRevisions.find((revision) => revision.charterRevision === team.document?.currentCharterRevision);
  if (current === undefined || current.charterRevision !== runtime.charterRevision || current.digest !== runtime.charterDigest) throw new GraphRuntimeError("stale_charter", "graph runtime is not bound to the current Frozen Charter");
}

function appendOne(runtime: GraphRuntimeState, input: {
  type: GraphEventType;
  actorSessionId: string;
  roleId?: string;
  nodeId?: string;
  loopInstanceId?: string;
  parents?: string[];
  createdAt: number;
  payload: Record<string, unknown>;
  evidence?: EvidenceRef[];
  eventId?: string;
}): GraphCommandResult {
  const eventId = input.eventId ?? `graph-${randomUUID()}`;
  const existing = runtime.events.find((event) => event.eventId === eventId);
  if (existing !== undefined) {
    const candidate = { ...input, eventId, seq: existing.seq, parents: input.parents ?? existing.parents, evidence: input.evidence ?? [] };
    if (stable(existing) === stable(candidate)) return { kind: "noop", runtime, events: [] };
    throw new GraphRuntimeError("duplicate_event", `event ${eventId} already exists with different facts`);
  }
  const parents = input.parents ?? (runtime.events.length === 0 ? [] : [runtime.events[runtime.events.length - 1].eventId]);
  const known = new Set(runtime.events.map((event) => event.eventId));
  for (const parent of parents) if (!known.has(parent)) throw new GraphRuntimeError(parent === eventId ? "cycle" : "unknown_parent", `event ${eventId} references unknown parent ${parent}`);
  const event: GraphEvent = {
    eventId,
    seq: runtime.events.length + 1,
    type: input.type,
    actorSessionId: input.actorSessionId,
    ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.loopInstanceId === undefined ? {} : { loopInstanceId: input.loopInstanceId }),
    parents: [...parents],
    createdAt: input.createdAt,
    payload: clone(input.payload),
    evidence: clone(input.evidence ?? []),
  };
  const next: GraphRuntimeState = { ...runtime, runtimeRevision: runtime.runtimeRevision + 1, events: [...runtime.events, event], updatedAt: input.createdAt };
  return { kind: "changed", runtime: next, events: [event] };
}

function loopsFromEvents(events: readonly GraphEvent[]): Map<string, LoopSummary> {
  const loops = new Map<string, LoopSummary>();
  for (const event of events) {
    if (event.type === "loop_started") {
      const payload = event.payload;
      if (!nonEmpty(event.loopInstanceId) || typeof payload.loopId !== "string" || !safePositive(payload.maxAttempts) || typeof payload.evaluatorRole !== "string") throw new GraphRuntimeError("invalid_event", `loop_started event ${event.eventId} is incomplete`);
      if (loops.has(event.loopInstanceId)) throw new GraphRuntimeError("duplicate_event", `loop ${event.loopInstanceId} was started twice`);
      loops.set(event.loopInstanceId, { loopInstanceId: event.loopInstanceId, loopId: payload.loopId, status: "running", evaluatorRole: payload.evaluatorRole, maxAttempts: payload.maxAttempts, attempts: [], capExhausted: false, unresolvedFindings: [] });
    } else if (event.type === "attempt_started") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `attempt ${event.eventId} references no loop`);
      if (loop.status !== "running") throw new GraphRuntimeError("loop_terminal", `attempt ${event.eventId} follows terminal loop ${loop.loopInstanceId}`);
      const attempt = event.payload.attempt;
      if (!safePositive(attempt) || attempt !== loop.attempts.length + 1 || typeof event.roleId !== "string" || typeof event.payload.sessionId !== "string") throw new GraphRuntimeError("attempt_conflict", `attempt ${event.eventId} is not continuous`);
      loop.attempts.push({ attempt, roleId: event.roleId, sessionId: event.payload.sessionId, status: "started", candidate: record(event.payload.candidate) ? event.payload.candidate : undefined, evidence: clone(event.evidence) });
    } else if (event.type === "verdict_recorded") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `verdict ${event.eventId} references no loop`);
      const attempt = loop.attempts.at(-1);
      if (attempt === undefined || attempt.attempt !== event.payload.attempt || attempt.verdict !== undefined) throw new GraphRuntimeError("attempt_conflict", `verdict ${event.eventId} does not match the current attempt`);
      if (event.payload.verdict !== "PASS" && event.payload.verdict !== "FAIL" && event.payload.verdict !== "BLOCKED") throw new GraphRuntimeError("invalid_event", `verdict ${event.eventId} is invalid`);
      attempt.verdict = event.payload.verdict;
      attempt.findings = Array.isArray(event.payload.findings) && event.payload.findings.every((finding) => typeof finding === "string") ? event.payload.findings : [];
      attempt.evidence = [...attempt.evidence, ...event.evidence];
    } else if (event.type === "attempt_completed") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      const attempt = loop?.attempts.at(-1);
      if (loop === undefined || attempt === undefined || attempt.attempt !== event.payload.attempt || !["passed", "failed", "blocked"].includes(String(event.payload.status)) || attempt.verdict === undefined) throw new GraphRuntimeError("attempt_conflict", `attempt completion ${event.eventId} is invalid`);
      attempt.status = event.payload.status as LoopAttemptSummary["status"];
      if (attempt.status === "passed") loop.status = "passed";
      if (attempt.status === "blocked") loop.status = "blocked";
    } else if (event.type === "cap_exhausted") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      const attempt = loop?.attempts.at(-1);
      if (loop === undefined || attempt === undefined || attempt.verdict !== "FAIL" || attempt.attempt !== loop.maxAttempts) throw new GraphRuntimeError("cap_exhausted", `cap event ${event.eventId} does not follow the hard cap`);
      loop.status = "cap_exhausted";
      loop.capExhausted = true;
      loop.unresolvedFindings = Array.isArray(event.payload.unresolvedFindings) && event.payload.unresolvedFindings.every((finding) => typeof finding === "string") ? event.payload.unresolvedFindings : attempt.findings ?? [];
    }
  }
  return loops;
}

function deriveGraph(runtime: GraphRuntimeState): Map<string, LoopSummary> {
  return loopsFromEvents(runtime.events);
}

export function graphLoops(runtime: GraphRuntimeState): LoopSummary[] {
  return [...deriveGraph(runtime).values()].map(clone);
}

function assertEvidenceKinds(evidenceRefs: EvidenceRef[], required: string[], action: string): void {
  if (!evidenceArray(evidenceRefs)) throw new GraphRuntimeError("invalid_shape", `${action} evidence is malformed`);
  for (const kind of required) if (!evidenceRefs.some((ref) => ref.kind === kind)) throw new GraphRuntimeError("handoff_invalid", `${action} requires evidence kind ${kind}`);
}

export function startLoop(runtime: GraphRuntimeState, team: TeamState, contract: TopologyLoopContract, input: { actorSessionId: string; loopInstanceId?: string; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  if (input.actorSessionId !== team.controllerSessionId) throw new GraphRuntimeError("permission_denied", "only the Team controller may start a Loop");
  if (!loopContractValid(contract)) throw new GraphRuntimeError("invalid_shape", "Loop contract is malformed");
  roleFor(team, contract.evaluatorRole);
  for (const participant of contract.participants) roleFor(team, participant);
  assertEvidenceKinds(input.evidence ?? [], contract.requiredEvidenceKinds, "Loop start");
  const loopInstanceId = input.loopInstanceId ?? `loop-${contract.loopId}-${randomUUID()}`;
  const existing = graphLoops(runtime).find((loop) => loop.loopInstanceId === loopInstanceId);
  if (existing !== undefined) {
    if (existing.loopId !== contract.loopId || existing.evaluatorRole !== contract.evaluatorRole || existing.maxAttempts !== contract.maxAttempts) throw new GraphRuntimeError("duplicate_event", `Loop ${loopInstanceId} already exists with different contract facts`);
    return { kind: "noop", runtime, events: [] };
  }
  return appendOne(runtime, { type: "loop_started", actorSessionId: input.actorSessionId, loopInstanceId, createdAt: input.now, payload: { loopId: contract.loopId, maxAttempts: contract.maxAttempts, evaluatorRole: contract.evaluatorRole, entry: contract.entry, participants: contract.participants, candidateKind: contract.candidateKind, verdictKind: contract.verdictKind, passRoute: contract.passRoute, retryRoute: contract.retryRoute, capExhaustedRoute: contract.capExhaustedRoute, requiredEvidenceKinds: contract.requiredEvidenceKinds }, evidence: input.evidence });
}

export function startAttempt(runtime: GraphRuntimeState, team: TeamState, contract: TopologyLoopContract, input: { loopInstanceId: string; actorSessionId: string; participantRoleId: string; candidate?: Record<string, unknown>; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  const role = roleFor(team, input.participantRoleId);
  const loops = deriveGraph(runtime);
  const loop = loops.get(input.loopInstanceId);
  if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `Loop ${input.loopInstanceId} was not found`);
  if (loop.loopId !== contract.loopId) throw new GraphRuntimeError("invalid_shape", "attempt contract does not match Loop");
  if (loop.status !== "running") throw new GraphRuntimeError(loop.status === "cap_exhausted" ? "cap_exhausted" : "loop_terminal", `Loop ${loop.loopInstanceId} is ${loop.status}`);
  if (!contract.participants.some((participant) => participant.toLowerCase() === role.id.toLowerCase())) throw new GraphRuntimeError("role_not_participant", `role ${role.id} is not a Loop participant`);
  if (input.candidate !== undefined && !record(input.candidate)) throw new GraphRuntimeError("invalid_shape", "attempt candidate payload must be an object");
  const actorIsDriver = input.actorSessionId === team.controllerSessionId;
  if (!actorIsDriver && input.actorSessionId !== role.sessionId) throw new GraphRuntimeError("permission_denied", "attempt actor must be the Team controller or current participant Session");
  const nextAttempt = loop.attempts.length + 1;
  if (nextAttempt > loop.maxAttempts) throw new GraphRuntimeError("cap_exhausted", "Loop hard cap is exhausted; start a new remediation Loop in a later checkpoint");
  if (nextAttempt > 1 && loop.attempts.at(-1)?.verdict !== "FAIL") throw new GraphRuntimeError("attempt_conflict", "next attempt requires the previous attempt to have a FAIL verdict");
  assertEvidenceKinds(input.evidence ?? [], contract.requiredEvidenceKinds, "attempt");
  return appendOne(runtime, { type: "attempt_started", actorSessionId: input.actorSessionId, roleId: role.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { attempt: nextAttempt, sessionId: role.sessionId, candidateKind: contract.candidateKind, ...(input.candidate === undefined ? {} : { candidate: input.candidate }) }, evidence: input.evidence });
}

export function recordVerdict(runtime: GraphRuntimeState, team: TeamState, contract: TopologyLoopContract, input: { loopInstanceId: string; actorSessionId: string; evaluatorRole: string; verdict: "PASS" | "FAIL" | "BLOCKED"; findings?: string[]; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  const evaluator = roleFor(team, contract.evaluatorRole);
  const loop = deriveGraph(runtime).get(input.loopInstanceId);
  if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `Loop ${input.loopInstanceId} was not found`);
  if (loop.evaluatorRole.toLowerCase() !== input.evaluatorRole.toLowerCase() || contract.evaluatorRole.toLowerCase() !== input.evaluatorRole.toLowerCase()) throw new GraphRuntimeError("evaluator_required", "verdict evaluator does not match the declared evaluator role");
  if (input.actorSessionId !== evaluator.sessionId) throw new GraphRuntimeError("evaluator_required", "only the current evaluator Session may record a verdict");
  const attempt = loop.attempts.at(-1);
  if (loop.status !== "running" && attempt?.verdict === input.verdict) return { kind: "noop", runtime, events: [] };
  if (loop.status !== "running") throw new GraphRuntimeError(loop.status === "cap_exhausted" ? "cap_exhausted" : "loop_terminal", `Loop ${loop.loopInstanceId} is ${loop.status}`);
  if (attempt === undefined || attempt.verdict !== undefined) throw new GraphRuntimeError("attempt_conflict", "verdict requires one current started attempt");
  if (input.verdict === "PASS" && attempt.attempt > loop.maxAttempts) throw new GraphRuntimeError("cap_exhausted", "PASS cannot occur after the hard cap");
  if (input.findings !== undefined && (!Array.isArray(input.findings) || !input.findings.every((finding) => typeof finding === "string"))) throw new GraphRuntimeError("invalid_shape", "verdict findings must be a string array");
  assertEvidenceKinds(input.evidence ?? [], contract.requiredEvidenceKinds, "verdict");
  let next = appendOne(runtime, { type: "verdict_recorded", actorSessionId: input.actorSessionId, roleId: evaluator.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { attempt: attempt.attempt, verdict: input.verdict, findings: input.findings ?? [] }, evidence: input.evidence });
  if (next.kind === "noop") return next;
  const completed = appendOne(next.runtime, { type: "attempt_completed", actorSessionId: input.actorSessionId, roleId: evaluator.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { attempt: attempt.attempt, status: input.verdict === "PASS" ? "passed" : input.verdict === "BLOCKED" ? "blocked" : "failed" }, evidence: input.evidence });
  if (completed.kind === "noop") return completed;
  next = { kind: "changed", runtime: completed.runtime, events: [...next.events, ...completed.events] };
  if (input.verdict === "FAIL" && attempt.attempt >= loop.maxAttempts) {
    const capped = appendOne(next.runtime, { type: "cap_exhausted", actorSessionId: input.actorSessionId, roleId: evaluator.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { loopId: loop.loopId, attempts: attempt.attempt, evaluatorRole: evaluator.id, unresolvedFindings: input.findings ?? [], charterRevision: runtime.charterRevision, charterDigest: runtime.charterDigest, escalation: contract.capExhaustedRoute }, evidence: input.evidence });
    if (capped.kind === "changed") next = { kind: "changed", runtime: capped.runtime, events: [...next.events, ...capped.events] };
  }
  return next;
}

function handoffContractMatches(contract: TopologyHandoffContract, fromRole: string, toRole: string, kind: string): boolean {
  const from = Array.isArray(contract.from) ? contract.from : [contract.from];
  return contract.kind === kind && from.some((role) => role.toLowerCase() === fromRole.toLowerCase()) && contract.to.some((role) => role.toLowerCase() === toRole.toLowerCase());
}

export function validateHandoffPayload(contract: TopologyHandoffContract, fromRole: string, toRole: string, kind: string, payload: Record<string, unknown>, evidenceRefs: EvidenceRef[]): void {
  if (!handoffContractMatches(contract, fromRole, toRole, kind)) throw new GraphRuntimeError("handoff_invalid", `handoff ${kind} is not allowed from ${fromRole} to ${toRole}`);
  for (const field of contract.requiredPayloadFields ?? []) if (!(field in payload)) throw new GraphRuntimeError("handoff_invalid", `handoff requires payload field ${field}`);
  assertEvidenceKinds(evidenceRefs, contract.requiredEvidenceKinds ?? [], "handoff");
}

export function appendHandoffPending(runtime: GraphRuntimeState, team: TeamState, contract: TopologyHandoffContract, input: { handoffId: string; kind: string; fromRole: string; toRole: string; loopInstanceId?: string; attempt?: number; summary: string; payload: Record<string, unknown>; actorSessionId: string; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  if (!record(input.payload) || !nonEmpty(input.handoffId) || !nonEmpty(input.summary)) throw new GraphRuntimeError("handoff_invalid", "handoff id, summary, and object payload are required");
  const from = roleFor(team, input.fromRole);
  const to = roleFor(team, input.toRole);
  if (input.actorSessionId !== from.sessionId) throw new GraphRuntimeError("permission_denied", "handoff actor does not own the fromRole");
  validateHandoffPayload(contract, from.id, to.id, input.kind, input.payload, input.evidence ?? []);
  if (input.loopInstanceId !== undefined) {
    const loop = graphLoops(runtime).find((entry) => entry.loopInstanceId === input.loopInstanceId);
    if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `handoff references unknown Loop ${input.loopInstanceId}`);
    if (loop.status !== "running") throw new GraphRuntimeError(loop.status === "cap_exhausted" ? "cap_exhausted" : "loop_terminal", `handoff Loop ${input.loopInstanceId} is ${loop.status}`);
    const currentAttempt = loop.attempts.at(-1)?.attempt;
    if (input.attempt !== undefined && input.attempt !== currentAttempt) throw new GraphRuntimeError("attempt_conflict", `handoff attempt ${input.attempt} is not the current attempt ${currentAttempt ?? "none"}`);
  }
  const existing = graphHandoffs(runtime).find((handoff) => handoff.handoffId === input.handoffId);
  if (existing !== undefined) {
    const event = runtime.events.find((candidate) => candidate.type === "handoff_pending" && candidate.payload.handoffId === input.handoffId);
    const original = event === undefined ? undefined : {
      handoffId: event.payload.handoffId,
      kind: event.payload.kind,
      fromRole: event.payload.fromRole,
      toRole: event.payload.toRole,
      ...(event.payload.attempt === undefined ? {} : { attempt: event.payload.attempt }),
      summary: event.payload.summary,
      payload: event.payload.payload,
    };
    const requested = { handoffId: input.handoffId, kind: input.kind, fromRole: from.id, toRole: to.id, ...(input.attempt === undefined ? {} : { attempt: input.attempt }), summary: input.summary, payload: input.payload };
    if (original !== undefined && stable(original) !== stable(requested)) throw new GraphRuntimeError("duplicate_event", `handoff ${input.handoffId} already exists with different payload`);
    return { kind: "noop", runtime, events: [] };
  }
  return appendOne(runtime, { type: "handoff_pending", actorSessionId: input.actorSessionId, roleId: from.id, nodeId: `handoff:${input.handoffId}`, loopInstanceId: input.loopInstanceId, createdAt: input.now, eventId: `handoff:${input.handoffId}:pending`, payload: { handoffId: input.handoffId, kind: input.kind, fromRole: from.id, toRole: to.id, toSessionId: to.sessionId, ...(input.attempt === undefined ? {} : { attempt: input.attempt }), summary: input.summary, payload: input.payload }, evidence: input.evidence });
}

export function appendHandoffResult(runtime: GraphRuntimeState, team: TeamState, input: { handoffId: string; actorSessionId: string; accepted: boolean; receipt?: Record<string, unknown>; error?: string; now: number }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  const existing = graphHandoffs(runtime).find((handoff) => handoff.handoffId === input.handoffId);
  if (existing === undefined) throw new GraphRuntimeError("handoff_invalid", `handoff ${input.handoffId} has no pending intent`);
  if (existing.status === "accepted" || existing.status === "failed") return { kind: "noop", runtime, events: [] };
  return appendOne(runtime, { type: input.accepted ? "handoff_accepted" : "handoff_failed", actorSessionId: input.actorSessionId, roleId: existing.fromRole, nodeId: `handoff:${input.handoffId}`, loopInstanceId: existing.loopInstanceId, createdAt: input.now, eventId: `handoff:${input.handoffId}:${input.accepted ? "accepted" : "failed"}`, payload: { handoffId: input.handoffId, ...(input.receipt === undefined ? {} : { receipt: input.receipt }), ...(input.error === undefined ? {} : { error: input.error }) }, evidence: [] });
}

export function graphHandoffs(runtime: GraphRuntimeState): HandoffSummary[] {
  const handoffs = new Map<string, HandoffSummary>();
  for (const event of runtime.events) {
    if (!["handoff_pending", "handoff_accepted", "handoff_failed"].includes(event.type)) continue;
    const id = typeof event.payload.handoffId === "string" ? event.payload.handoffId : undefined;
    if (id === undefined) continue;
    if (event.type === "handoff_pending") {
      handoffs.set(id, { handoffId: id, ...(event.loopInstanceId === undefined ? {} : { loopInstanceId: event.loopInstanceId }), ...(typeof event.payload.attempt === "number" ? { attempt: event.payload.attempt } : {}), fromRole: String(event.payload.fromRole ?? event.roleId ?? ""), toRole: String(event.payload.toRole ?? ""), ...(typeof event.payload.toSessionId === "string" ? { targetSessionId: event.payload.toSessionId } : {}), status: "pending", summary: String(event.payload.summary ?? ""), evidence: clone(event.evidence) });
    } else {
      const current = handoffs.get(id);
      if (current === undefined) continue;
      current.status = event.type === "handoff_accepted" ? "accepted" : "failed";
      if (record(event.payload.receipt)) current.receipt = clone(event.payload.receipt);
      if (typeof event.payload.error === "string") current.error = event.payload.error;
    }
  }
  return [...handoffs.values()].map(clone);
}

export function graphSummary(runtime: GraphRuntimeState, stale = false): GraphProjectionSummary {
  const loops = graphLoops(runtime);
  const current = loops.find((loop) => loop.status === "running") ?? loops.at(-1);
  const pending = graphHandoffs(runtime).filter((handoff) => handoff.status === "pending");
  return {
    status: stale ? "stale" : current === undefined ? "idle" : current.status === "cap_exhausted" ? "cap_exhausted" : current.status,
    ...(current === undefined ? {} : { currentLoop: { loopInstanceId: current.loopInstanceId, loopId: current.loopId, ...(current.attempts.at(-1) === undefined ? {} : { attempt: current.attempts.at(-1)?.attempt }), status: current.status } }),
    pendingHandoffs: pending,
    capExhausted: loops.filter((loop) => loop.capExhausted).map((loop) => loop.loopInstanceId),
    runtimeRevision: runtime.runtimeRevision,
    stale,
  };
}
