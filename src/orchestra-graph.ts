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
import type { TopologyClosureDefinition, TopologyGateDefinition, TopologyHandoffContract, TopologyLoopContract } from "./orchestra-topology.js";

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "orchestra/gate-decision": {
      gateInstanceId: string;
      option: string;
      commandId: string;
      decidedAt: number;
      approvingSessionId: string;
      source: "user-command";
    };
  }
}

export const GRAPH_RUNTIME_SCHEMA_VERSION = 1;

/**
 * Wall-clock ceiling applied to an Attempt whose Loop declares none.
 *
 * This is a POLICY, not a magic number. Principle P10 says every Attempt must
 * have a deadline, and an unattended run must never hang on a node that simply
 * stopped working — so the deadline has to exist structurally rather than only
 * when a topology author remembered to ask for one. Thirty minutes is chosen to
 * be longer than any single honest Attempt in the shipped task topologies while
 * still bounding a stalled one inside a working session; a topology that knows
 * better tightens it with `attemptTimeoutMs`, and nothing may loosen it past
 * this ceiling by omission.
 *
 * Because the value is a default rather than a stored fact, an old persisted
 * runtime whose `attempt_started` events predate it projects the same deadline
 * it would have had if the field existed then.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;

export type GraphEventType =
  | "loop_started"
  | "attempt_started"
  | "attempt_expired"
  | "budget_exhausted"
  | "handoff_pending"
  | "handoff_accepted"
  | "handoff_failed"
  | "verdict_recorded"
  | "attempt_completed"
  | "cap_exhausted"
  | "remediation_requested"
  | "gate_opened"
  | "gate_resolved"
  | "gate_fallback_applied"
  | "gate_blocked"
  | "gate_expired"
  | "closure_requested"
  | "closure_rejected"
  | "closure_recorded";

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
  | "timeout_not_reached"
  | "budget_exhausted"
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
  /**
   * `expired` is a terminal Attempt outcome reached by deadline rather than by
   * a verdict. It exists so an unattended run has a recorded ending instead of
   * an Attempt that silently never finished.
   */
  status: "started" | "passed" | "failed" | "blocked" | "expired";
  candidate?: Record<string, unknown>;
  verdict?: "PASS" | "FAIL" | "BLOCKED";
  findings?: string[];
  /** When this Attempt opened (the `attempt_started` event time). */
  startedAt: number;
  /**
   * The deadline this Attempt ran under. Derived as `startedAt + timeoutMs`,
   * where the timeout is the effective one recorded when the Attempt opened; it
   * is reported even for a settled Attempt so a later reader can audit whether
   * the outcome arrived in time.
   */
  deadlineAt: number;
  evidence: EvidenceRef[];
}

/** One wall-clock ceiling that was actually exceeded, and when it started counting. */
export interface BudgetExhaustion {
  scope: "loop" | "team";
  loopId?: string;
  limitMs: number;
  consumedMs: number;
}

export interface LoopSummary {
  loopInstanceId: string;
  loopId: string;
  status: "running" | "passed" | "blocked" | "cap_exhausted";
  evaluatorRole: string;
  /** Declared ceiling from the frozen contract (`maxAttempts` in the start event). */
  maxAttempts: number;
  /**
   * The ceiling actually enforced: `min(maxAttempts, maxTotalAttempts)` when the
   * contract narrows it. A boundedness reader must use THIS, because the
   * declared value may be higher than the rule the run obeys.
   */
  effectiveMaxAttempts: number;
  startedAt: number;
  /** Deadline of the current open Attempt, when one is open. */
  currentDeadlineAt?: number;
  /** The Loop-level budget that was exceeded, once one has been. */
  budgetExhausted?: { limitMs: number; consumedMs: number };
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
  /** Attempts that ended by deadline instead of by verdict. */
  expiredAttempts: number;
  /** Every wall-clock ceiling recorded as exceeded, in append order. */
  budgets: BudgetExhaustion[];
  /**
   * Whether the TEAM-level budget is exhausted. Once true, advancement is
   * refused while closure stays available, so the run can always be brought to
   * a terminal outcome rather than being stranded by its own budget.
   */
  teamBudgetExhausted: boolean;
  openGates: GateSummary[];
  blockedScopes: string[];
  closure: ClosureSummary;
  runtimeRevision?: number;
  stale: boolean;
}

export type GraphCommandResult =
  | { kind: "changed"; runtime: GraphRuntimeState; events: GraphEvent[] }
  | { kind: "noop"; runtime: GraphRuntimeState; events: [] };

export interface GateSummary {
  gateInstanceId: string;
  gateId: string;
  status: "open" | "resolved" | "fallback_applied" | "blocked" | "expired";
  decisionScope: string[];
  blockingScope: string[];
  options: string[];
  required: boolean;
  onUnavailable: TopologyGateDefinition["onUnavailable"];
  fallbackOption?: string;
  selectedOption?: string;
  reason?: string;
  openedAt: number;
  expiresAt?: number;
}

export interface ClosureSummary {
  status: "none" | "requested" | "rejected" | "recorded";
  outcome?: "completed" | "failed" | "abandoned";
  owner?: string;
  reason?: string;
  evidence: EvidenceRef[];
}

const EVENT_TYPES = new Set<GraphEventType>([
  "loop_started",
  "attempt_started",
  "attempt_expired",
  "budget_exhausted",
  "handoff_pending",
  "handoff_accepted",
  "handoff_failed",
  "verdict_recorded",
  "attempt_completed",
  "cap_exhausted",
  "remediation_requested",
  "gate_opened",
  "gate_resolved",
  "gate_fallback_applied",
  "gate_blocked",
  "gate_expired",
  "closure_requested",
  "closure_rejected",
  "closure_recorded",
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
    gatesFromEvents(raw.events as GraphEvent[]);
    graphHandoffs(raw as GraphRuntimeState);
    closureFromEvents(raw.events as GraphEvent[]);
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

/**
 * The Attempt ceiling a Loop actually enforces.
 *
 * `maxTotalAttempts` may only NARROW `maxAttempts`; the topology validator
 * rejects a value above it rather than letting the field sit there doing
 * nothing. Every enforcement site must use this instead of the declared cap,
 * or a narrowed Loop would be allowed to run past the rule it declared.
 *
 * @param contract - the frozen Loop contract.
 * @returns the enforced ceiling, never above `maxAttempts`.
 */
export function effectiveMaxAttempts(contract: Pick<TopologyLoopContract, "maxAttempts" | "maxTotalAttempts">): number {
  const narrowed = contract.maxTotalAttempts;
  if (narrowed === undefined) return contract.maxAttempts;
  return Math.min(contract.maxAttempts, narrowed);
}

/**
 * The wall-clock ceiling one Attempt runs under.
 *
 * A Loop that declares nothing still gets {@link DEFAULT_ATTEMPT_TIMEOUT_MS},
 * which is what makes "every Attempt has a deadline" a structural property of
 * the runtime rather than a property of well-written topologies.
 *
 * @param contract - the frozen Loop contract.
 * @returns the effective timeout in milliseconds.
 */
export function effectiveAttemptTimeoutMs(contract: Pick<TopologyLoopContract, "attemptTimeoutMs">): number {
  return contract.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
}

/** The deadline one Attempt runs to, derived from when it opened. */
export function attemptDeadlineAt(attempt: Pick<LoopAttemptSummary, "startedAt">, contract: Pick<TopologyLoopContract, "attemptTimeoutMs">): number {
  return attempt.startedAt + effectiveAttemptTimeoutMs(contract);
}

/**
 * Inactivity grace before an open Attempt whose node is provably not working is
 * reported as stalled. A POLICY, not a fact: it decides how long a silent node
 * is tolerated before the condition is worth surfacing, so it is deliberately
 * overridable per Loop through `stallGraceMs`.
 */
export const DEFAULT_STALL_GRACE_MS = 60_000;

/** Whether an open Attempt's node is working, silent, or unobservable. */
export type NodeStall = "ok" | "stalled" | "unknown";

/**
 * Whether an open Attempt whose node is provably not working has passed its
 * inactivity grace.
 *
 * The three-valued result is the point. "Cannot tell" is NOT "fine": a reader
 * that read no activity fact has no evidence the node is alive, and reporting
 * that as `ok` would let a dead node look healthy forever — the exact failure
 * unattended operation cannot detect for itself. So an unreadable activity
 * timestamp yields `unknown`, which a controller must resolve by looking rather
 * than by waiting.
 *
 * This is derived, never recorded: no event and no state field is written,
 * because the condition follows from facts already on the log (the open
 * Attempt) plus two observations (is the node working, when was it last seen).
 * A derived stall can be recomputed after a restart and can never disagree with
 * the log it was computed from.
 *
 * @param input.attempt - the Loop's current open Attempt, if any.
 * @param input.contract - the frozen Loop contract, for its declared grace.
 * @param input.working - whether the node is demonstrably working right now.
 * @param input.lastActivityAt - when the node was last observed to act, or
 *   `undefined` when that could not be read.
 * @param input.now - observation time; the caller never lets this drift.
 * @returns `ok` without an open Attempt or while the node works or is inside
 *   its grace, `stalled` once a silent node passes the grace, `unknown` when
 *   the node's last activity could not be observed.
 */
export function nodeStall(input: {
  attempt: LoopAttemptSummary | undefined;
  contract: TopologyLoopContract | undefined;
  working: boolean;
  lastActivityAt: number | undefined;
  now: number;
}): NodeStall {
  // No open Attempt: nothing is running, so nothing can be stalled.
  if (input.attempt === undefined || input.attempt.status !== "started") return "ok";
  if (input.working) return "ok";
  // Unobservable beats silent: an unreadable fact must not be reported as health.
  if (input.lastActivityAt === undefined) return "unknown";
  const grace = input.contract?.stallGraceMs ?? DEFAULT_STALL_GRACE_MS;
  return input.now - input.lastActivityAt >= grace ? "stalled" : "ok";
}


/**
 * Whether the TEAM-level wall-clock budget has been recorded as exhausted.
 *
 * Read from the durable event, never computed from a clock, so every command
 * refuses advancement on the same fact an earlier sweep wrote — and so a
 * restarted process reaches the same verdict.
 *
 * @param runtime - the graph runtime to read.
 * @returns true once a team-scope budget exhaustion is on the log.
 */
export function teamBudgetExhausted(runtime: GraphRuntimeState): boolean {
  return runtime.events.some((event) => event.type === "budget_exhausted" && event.payload.scope === "team");
}

/**
 * Refuse one advancement command once the team budget is gone.
 *
 * Closure is deliberately NOT routed through here: a budget that could block
 * closure would strand the run forever with no terminal outcome, which is the
 * opposite of what a budget is for. An exhausted team may not take another
 * step, but it can always be closed.
 *
 * @param runtime - the graph runtime to check.
 * @throws {GraphRuntimeError} `budget_exhausted` when the team ceiling is gone.
 */
function assertTeamBudgetOpen(runtime: GraphRuntimeState): void {
  if (teamBudgetExhausted(runtime)) {
    throw new GraphRuntimeError("budget_exhausted", "the Team wall-clock budget is exhausted; no further advancement is accepted — record closure to end this run");
  }
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
  // Team-scope budget exhaustion is a run-wide fact, not Loop state; it is
  // validated here (once, with usable numbers) and read by callers through
  // teamBudgetExhausted(). Loop-scope facts live on their Loop.
  let teamBudgetSeen = false;
  for (const event of events) {
    if (event.type === "loop_started") {
      const payload = event.payload;
      if (!nonEmpty(event.loopInstanceId) || typeof payload.loopId !== "string" || !safePositive(payload.maxAttempts) || typeof payload.evaluatorRole !== "string") throw new GraphRuntimeError("invalid_event", `loop_started event ${event.eventId} is incomplete`);
      // A runtime written before maxTotalAttempts existed has no effective
      // ceiling, and the declared value is then already the enforced one.
      const effective = payload.effectiveMaxAttempts === undefined ? payload.maxAttempts : payload.effectiveMaxAttempts;
      if (!safePositive(effective) || effective > payload.maxAttempts) throw new GraphRuntimeError("invalid_event", `loop_started event ${event.eventId} declares an effective ceiling above its declared cap`);
      if (loops.has(event.loopInstanceId)) throw new GraphRuntimeError("duplicate_event", `loop ${event.loopInstanceId} was started twice`);
      loops.set(event.loopInstanceId, { loopInstanceId: event.loopInstanceId, loopId: payload.loopId, status: "running", evaluatorRole: payload.evaluatorRole, maxAttempts: payload.maxAttempts, effectiveMaxAttempts: effective, startedAt: event.createdAt, attempts: [], capExhausted: false, unresolvedFindings: [] });
    } else if (event.type === "attempt_started") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `attempt ${event.eventId} references no loop`);
      if (loop.status !== "running") throw new GraphRuntimeError("loop_terminal", `attempt ${event.eventId} follows terminal loop ${loop.loopInstanceId}`);
      const attempt = event.payload.attempt;
      if (!safePositive(attempt) || attempt !== loop.attempts.length + 1 || typeof event.roleId !== "string" || typeof event.payload.sessionId !== "string") throw new GraphRuntimeError("attempt_conflict", `attempt ${event.eventId} is not continuous`);
      // The deadline is DERIVED here, never stored as its own event: the
      // Attempt records the timeout it started under, and every reader computes
      // startedAt + timeoutMs. A derived deadline cannot drift from the Attempt
      // it belongs to.
      const timeoutMs = event.payload.timeoutMs === undefined ? DEFAULT_ATTEMPT_TIMEOUT_MS : event.payload.timeoutMs;
      if (!safePositive(timeoutMs)) throw new GraphRuntimeError("invalid_event", `attempt ${event.eventId} declares an unusable timeout`);
      const startedAt = event.createdAt;
      loop.attempts.push({ attempt, roleId: event.roleId, sessionId: event.payload.sessionId, status: "started", candidate: record(event.payload.candidate) ? event.payload.candidate : undefined, startedAt, deadlineAt: startedAt + timeoutMs, evidence: clone(event.evidence) });
      loop.currentDeadlineAt = startedAt + timeoutMs;
    } else if (event.type === "attempt_expired") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      const attempt = loop?.attempts.at(-1);
      if (loop === undefined || attempt === undefined || attempt.attempt !== event.payload.attempt || attempt.verdict !== undefined || attempt.status !== "started") throw new GraphRuntimeError("attempt_conflict", `attempt expiry ${event.eventId} does not match one open attempt`);
      const deadlineAt = event.payload.deadlineAt;
      const expiredAt = event.payload.expiredAt;
      if (!finite(deadlineAt) || !finite(expiredAt)) throw new GraphRuntimeError("invalid_event", `attempt expiry ${event.eventId} lacks a finite deadline or expiry time`);
      // Expiry is the deadline being reached, not an opinion: an expiry that
      // precedes its own deadline would make every later sweep inconsistent.
      if (expiredAt < deadlineAt) throw new GraphRuntimeError("attempt_conflict", `attempt expiry ${event.eventId} precedes its deadline`);
      if (deadlineAt !== attempt.deadlineAt) throw new GraphRuntimeError("attempt_conflict", `attempt expiry ${event.eventId} names a deadline the attempt never had`);
    } else if (event.type === "budget_exhausted") {
      const scope = event.payload.scope;
      if (scope !== "loop" && scope !== "team") throw new GraphRuntimeError("invalid_event", `budget event ${event.eventId} has an unknown scope`);
      if (!safePositive(event.payload.limitMs) || !finite(event.payload.consumedMs)) throw new GraphRuntimeError("invalid_event", `budget event ${event.eventId} lacks usable limit or consumption`);
      if (scope === "team") {
        // One team can exceed its ceiling once; a second record would let a
        // repeated sweep look like a second, different breach.
        if (teamBudgetSeen) throw new GraphRuntimeError("duplicate_event", `team budget was already recorded as exhausted before ${event.eventId}`);
        teamBudgetSeen = true;
      } else {
        const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
        if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `budget event ${event.eventId} references no loop`);
        if (typeof event.payload.loopId !== "string" || event.payload.loopId !== loop.loopId) throw new GraphRuntimeError("invalid_event", `budget event ${event.eventId} names a different Loop`);
        if (loop.budgetExhausted !== undefined) throw new GraphRuntimeError("duplicate_event", `Loop ${loop.loopInstanceId} budget was already recorded as exhausted before ${event.eventId}`);
        loop.budgetExhausted = { limitMs: event.payload.limitMs, consumedMs: event.payload.consumedMs };
      }
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
      const status = String(event.payload.status);
      if (loop === undefined || attempt === undefined || attempt.attempt !== event.payload.attempt || !["passed", "failed", "blocked", "expired"].includes(status)) throw new GraphRuntimeError("attempt_conflict", `attempt completion ${event.eventId} is invalid`);
      // Every completion but `expired` is the consequence of a verdict and must
      // carry one; an expired Attempt has none by definition, and requiring one
      // would make a deadline ending unrecordable.
      if (status === "expired" ? attempt.verdict !== undefined : attempt.verdict === undefined) throw new GraphRuntimeError("attempt_conflict", `attempt completion ${event.eventId} disagrees with the attempt's verdict facts`);
      attempt.status = status as LoopAttemptSummary["status"];
      // A settled Attempt has no open deadline; leaving one would keep reporting
      // a pending deadline for work that already ended.
      loop.currentDeadlineAt = undefined;
      if (attempt.status === "passed") loop.status = "passed";
      if (attempt.status === "blocked") loop.status = "blocked";
    } else if (event.type === "cap_exhausted") {
      const loop = event.loopInstanceId === undefined ? undefined : loops.get(event.loopInstanceId);
      if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `cap event ${event.eventId} references no loop`);
      const attempt = loop.attempts.at(-1);
      if (loop.budgetExhausted !== undefined) {
        // A budget can be blown before any Attempt was ever started, so this
        // precedent does not require one — but the Loop must still be running,
        // because ending an already-ended Loop would rewrite history.
        if (loop.status !== "running") throw new GraphRuntimeError("cap_exhausted", `cap event ${event.eventId} follows a Loop that already ended`);
      } else {
        // The other two precedents are about one specific Attempt: a FAIL
        // verdict at the ceiling, or an Attempt that ran out of time there.
        // Anything else is an unexplained cap and is rejected.
        if (attempt === undefined || attempt.attempt !== loop.effectiveMaxAttempts) throw new GraphRuntimeError("cap_exhausted", `cap event ${event.eventId} does not follow the hard cap`);
        if (attempt.verdict !== "FAIL" && attempt.status !== "expired") throw new GraphRuntimeError("cap_exhausted", `cap event ${event.eventId} has no exhausted verdict or deadline behind it`);
      }
      loop.status = "cap_exhausted";
      loop.capExhausted = true;
      loop.unresolvedFindings = Array.isArray(event.payload.unresolvedFindings) && event.payload.unresolvedFindings.every((finding) => typeof finding === "string") ? event.payload.unresolvedFindings : attempt?.findings ?? [];
    }
  }
  return loops;
}

function deriveGraph(runtime: GraphRuntimeState): Map<string, LoopSummary> {
  return loopsFromEvents(runtime.events);
}

function validGateDefinition(value: unknown): value is TopologyGateDefinition {
  return record(value) && nonEmpty(value.gateId) && Array.isArray(value.decisionScope) && value.decisionScope.length > 0 && value.decisionScope.every(nonEmpty) && Array.isArray(value.blockingScope) && value.blockingScope.length > 0 && value.blockingScope.every(nonEmpty) && Array.isArray(value.options) && value.options.length > 0 && new Set(value.options).size === value.options.length && value.options.every(nonEmpty) && typeof value.required === "boolean" && ["fallback", "blocked", "failed", "safe_stop"].includes(value.onUnavailable) && (value.fallbackOption === undefined || value.options.includes(value.fallbackOption)) && (value.timeoutPolicy !== "fallback" || (value.fallbackOption !== undefined && value.options.includes(value.fallbackOption))) && (value.expiresAt === undefined || finite(value.expiresAt));
}

function gatesFromEvents(events: readonly GraphEvent[]): Map<string, GateSummary> {
  const gates = new Map<string, GateSummary>();
  for (const event of events) {
    if (event.type === "gate_opened") {
      const definition = event.payload.definition;
      const instance = event.payload.gateInstanceId;
      if (!validGateDefinition(definition) || !nonEmpty(instance) || gates.has(instance)) throw new GraphRuntimeError("invalid_event", `gate_opened event ${event.eventId} is malformed or duplicated`);
      gates.set(instance, { gateInstanceId: instance, gateId: definition.gateId, status: "open", decisionScope: [...definition.decisionScope], blockingScope: [...definition.blockingScope], options: [...definition.options], required: definition.required, onUnavailable: definition.onUnavailable, ...(definition.fallbackOption === undefined ? {} : { fallbackOption: definition.fallbackOption }), openedAt: event.createdAt, ...(definition.expiresAt === undefined ? {} : { expiresAt: definition.expiresAt }) });
    } else if (["gate_resolved", "gate_fallback_applied", "gate_blocked", "gate_expired"].includes(event.type)) {
      const instance = event.payload.gateInstanceId;
      const gate = typeof instance === "string" ? gates.get(instance) : undefined;
      if (gate === undefined || gate.status !== "open") throw new GraphRuntimeError("invalid_event", `gate transition ${event.eventId} has no open gate`);
      if (event.type === "gate_resolved" || event.type === "gate_fallback_applied") {
        if (typeof event.payload.option !== "string" || !gate.options.includes(event.payload.option)) throw new GraphRuntimeError("invalid_event", `gate transition ${event.eventId} has an invalid option`);
        if (event.type === "gate_resolved" && (event.payload.source !== "user-command" || typeof event.payload.commandId !== "string" || typeof event.payload.approvingSessionId !== "string")) throw new GraphRuntimeError("invalid_event", `gate decision ${event.eventId} lacks direct user-command evidence`);
        gate.selectedOption = event.payload.option;
        gate.status = event.type === "gate_resolved" ? "resolved" : "fallback_applied";
      } else {
        gate.reason = typeof event.payload.reason === "string" ? event.payload.reason : undefined;
        gate.status = event.type === "gate_blocked" ? "blocked" : "expired";
      }
    }
  }
  return gates;
}

function closureFromEvents(events: readonly GraphEvent[]): ClosureSummary {
  let result: ClosureSummary = { status: "none", evidence: [] };
  for (const event of events) {
    if (event.type === "closure_requested") {
      if (result.status === "recorded" || result.status === "requested") throw new GraphRuntimeError("invalid_event", "closure requested after an unresolved closure request or terminal closure");
      if (typeof event.payload.owner !== "string" || event.payload.owner === "" || typeof event.payload.outcome !== "string" || !["completed", "failed", "abandoned"].includes(event.payload.outcome) || typeof event.payload.reason !== "string") throw new GraphRuntimeError("invalid_event", `closure request ${event.eventId} is malformed`);
      result = { status: "requested", owner: event.payload.owner, outcome: event.payload.outcome as ClosureSummary["outcome"], reason: event.payload.reason, evidence: clone(event.evidence) };
    } else if (event.type === "closure_rejected") {
      if (result.status !== "requested" || typeof event.payload.reason !== "string" || event.payload.reason === "") throw new GraphRuntimeError("invalid_event", `closure rejection ${event.eventId} is out of order or malformed`);
      result = { ...result, status: "rejected", reason: event.payload.reason, evidence: clone(event.evidence) };
    } else if (event.type === "closure_recorded") {
      if (result.status !== "requested" || typeof event.payload.owner !== "string" || event.payload.owner === "" || typeof event.payload.outcome !== "string" || !["completed", "failed", "abandoned"].includes(event.payload.outcome) || typeof event.payload.reason !== "string") throw new GraphRuntimeError("invalid_event", `closure record ${event.eventId} is out of order or malformed`);
      result = { status: "recorded", owner: event.payload.owner, outcome: event.payload.outcome as ClosureSummary["outcome"], reason: event.payload.reason, evidence: clone(event.evidence) };
    }
  }
  return result;
}

function openBlockingGates(runtime: GraphRuntimeState, scopes: string[]): GateSummary[] {
  return [...gatesFromEvents(runtime.events).values()].filter((gate) => ["open", "blocked", "expired"].includes(gate.status) && gate.required && (gate.blockingScope.includes("global") || gate.blockingScope.some((scope) => scopes.includes(scope))));
}

function assertScopesOpen(runtime: GraphRuntimeState, scopes: string[]): void {
  const blocked = openBlockingGates(runtime, scopes);
  if (blocked.length > 0) throw new GraphRuntimeError("handoff_invalid", `scope is blocked by Human Gate ${blocked[0].gateInstanceId} (${blocked[0].decisionScope.join(", ")})`);
}

function assertGraphOpen(runtime: GraphRuntimeState): void {
  const closure = closureFromEvents(runtime.events);
  if (closure.status === "recorded") throw new GraphRuntimeError("loop_terminal", "Graph is terminal after closure; no new execution mutation is allowed");
}

function ownerSession(team: TeamState, owner: string): string {
  if (owner.toLowerCase() === "driver" || owner === team.controllerSessionId) return team.controllerSessionId;
  return roleFor(team, owner).sessionId;
}

/** Controller role id used by every builtin topology (topology.controller.id). */
export const CONTROLLER_ROLE_ID = "driver" as const;

export interface HandoffTarget {
  kind: "role" | "controller";
  id: string;
  sessionId: string;
}

/**
 * Resolve a typed-handoff target: a TeamRole, or the Team controller when the
 * roleId matches the controller role id (frozen topology.controller.id, i.e.
 * "driver" for builtin topologies). A verdict/report handoff to the controller
 * must not go through the TeamRole lookup, because the controller is not a
 * provisioned role; its session is team.controllerSessionId. The caller passes
 * the frozen controller id so custom topologies work too; "driver" is the
 * default that matches all builtin templates and the deep-module convention
 * (see ownerSession). fromRole stays a plain TeamRole lookup elsewhere, so a
 * driver-initiated handoff remains rejected.
 */
export function resolveHandoffTarget(team: TeamState, roleId: string, controllerRoleId: string = CONTROLLER_ROLE_ID): HandoffTarget {
  const normalized = roleId.toLowerCase();
  if (normalized === controllerRoleId.toLowerCase()) {
    return { kind: "controller", id: controllerRoleId, sessionId: team.controllerSessionId };
  }
  const role = team.roles.find((entry) => entry.id.toLowerCase() === normalized);
  if (role === undefined) throw new GraphRuntimeError("role_not_participant", `handoff target role ${roleId} is not in the current Team`);
  if (role.phase !== "active") throw new GraphRuntimeError("role_not_participant", `handoff target role ${role.id} is not active`);
  return { kind: "role", id: role.id, sessionId: role.sessionId };
}

function closureReadiness(runtime: GraphRuntimeState, definition: TopologyClosureDefinition, outcome: ClosureSummary["outcome"], evidenceRefs: EvidenceRef[]): string | undefined {
  const loops = graphLoops(runtime);
  if (graphHandoffs(runtime).some((handoff) => handoff.status === "pending")) return "pending handoff requires reconcile";
  if (loops.some((loop) => loop.status === "running")) return "active Loop attempt remains";
  if ([...gatesFromEvents(runtime.events).values()].some((gate) => ["open", "blocked", "expired"].includes(gate.status) && gate.required) && (definition.openGatePolicy === "reject" || outcome !== "failed")) return "required Human Gate remains unresolved";
  if (definition.requiredLoopOutcomes !== undefined) {
    for (const required of definition.requiredLoopOutcomes) {
      const [loopId, expected] = required.split(":");
      if (!loops.some((loop) => loop.loopId === loopId && loop.status === expected)) return `required Loop outcome ${required} is missing`;
    }
  }
  if (definition.requiredVerdicts !== undefined) {
    const verdicts = new Set(runtime.events.filter((event) => event.type === "verdict_recorded").map((event) => String(event.payload.verdict)));
    for (const required of definition.requiredVerdicts) if (!verdicts.has(required)) return `required verdict ${required} is missing`;
  }
  if (definition.requiredHandoffs !== undefined) {
    const handoffs = graphHandoffs(runtime);
    for (const required of definition.requiredHandoffs) if (!handoffs.some((handoff) => handoff.handoffId === required && handoff.status === "accepted")) return `required handoff ${required} is missing`;
  }
  if (definition.requiredEvidenceKinds !== undefined) for (const kind of definition.requiredEvidenceKinds) if (!evidenceRefs.some((ref) => ref.kind === kind) && !runtime.events.some((event) => event.evidence.some((ref) => ref.kind === kind))) return `required closure evidence ${kind} is missing`;
  if ((outcome === "failed" || outcome === "abandoned") && evidenceRefs.length === 0) return `${outcome} closure requires evidence`;
  return undefined;
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
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  if (input.actorSessionId !== team.controllerSessionId) throw new GraphRuntimeError("permission_denied", "only the Team controller may start a Loop");
  if (!loopContractValid(contract)) throw new GraphRuntimeError("invalid_shape", "Loop contract is malformed");
  roleFor(team, contract.evaluatorRole);
  for (const participant of contract.participants) roleFor(team, participant);
  assertEvidenceKinds(input.evidence ?? [], contract.requiredEvidenceKinds, "Loop start");
  assertScopesOpen(runtime, [contract.loopId, `loop:${contract.loopId}`]);
  const loopInstanceId = input.loopInstanceId ?? `loop-${contract.loopId}-${randomUUID()}`;
  const effective = effectiveMaxAttempts(contract);
  const existing = graphLoops(runtime).find((loop) => loop.loopInstanceId === loopInstanceId);
  if (existing !== undefined) {
    if (existing.loopId !== contract.loopId || existing.evaluatorRole !== contract.evaluatorRole || existing.maxAttempts !== contract.maxAttempts || existing.effectiveMaxAttempts !== effective) throw new GraphRuntimeError("duplicate_event", `Loop ${loopInstanceId} already exists with different contract facts`);
    return { kind: "noop", runtime, events: [] };
  }
  return appendOne(runtime, { type: "loop_started", actorSessionId: input.actorSessionId, loopInstanceId, createdAt: input.now, payload: { loopId: contract.loopId, maxAttempts: contract.maxAttempts, effectiveMaxAttempts: effective, evaluatorRole: contract.evaluatorRole, entry: contract.entry, participants: contract.participants, candidateKind: contract.candidateKind, verdictKind: contract.verdictKind, passRoute: contract.passRoute, retryRoute: contract.retryRoute, capExhaustedRoute: contract.capExhaustedRoute, requiredEvidenceKinds: contract.requiredEvidenceKinds }, evidence: input.evidence });
}

export function startAttempt(runtime: GraphRuntimeState, team: TeamState, contract: TopologyLoopContract, input: { loopInstanceId: string; actorSessionId: string; participantRoleId: string; candidate?: Record<string, unknown>; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  const role = roleFor(team, input.participantRoleId);
  const loops = deriveGraph(runtime);
  const loop = loops.get(input.loopInstanceId);
  if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `Loop ${input.loopInstanceId} was not found`);
  if (loop.loopId !== contract.loopId) throw new GraphRuntimeError("invalid_shape", "attempt contract does not match Loop");
  assertScopesOpen(runtime, [contract.loopId, `loop:${contract.loopId}`]);
  if (loop.status !== "running") throw new GraphRuntimeError(loop.status === "cap_exhausted" ? "cap_exhausted" : "loop_terminal", `Loop ${loop.loopInstanceId} is ${loop.status}`);
  if (!contract.participants.some((participant) => participant.toLowerCase() === role.id.toLowerCase())) throw new GraphRuntimeError("role_not_participant", `role ${role.id} is not a Loop participant`);
  if (input.candidate !== undefined && !record(input.candidate)) throw new GraphRuntimeError("invalid_shape", "attempt candidate payload must be an object");
  const actorIsDriver = input.actorSessionId === team.controllerSessionId;
  if (!actorIsDriver && input.actorSessionId !== role.sessionId) throw new GraphRuntimeError("permission_denied", "attempt actor must be the Team controller or current participant Session");
  const nextAttempt = loop.attempts.length + 1;
  const cap = effectiveMaxAttempts(contract);
  if (nextAttempt > cap) throw new GraphRuntimeError("cap_exhausted", "Loop hard cap is exhausted; start a new remediation Loop in a later checkpoint");
  // A retry needs a REASON to exist: the previous Attempt must have been judged
  // FAIL, or must have run out of time. An expired Attempt carries no verdict by
  // definition, so requiring one would make a timed-out Loop unretryable and
  // strand the run — the exact failure this milestone removes.
  if (nextAttempt > 1) {
    const previous = loop.attempts.at(-1);
    const retryable = previous?.verdict === "FAIL" || previous?.status === "expired";
    if (!retryable) throw new GraphRuntimeError("attempt_conflict", `next attempt requires the previous attempt to have a FAIL verdict or to have expired (previous status ${String(previous?.status ?? "missing")})`);
  }
  assertEvidenceKinds(input.evidence ?? [], contract.requiredEvidenceKinds, "attempt");
  return appendOne(runtime, { type: "attempt_started", actorSessionId: input.actorSessionId, roleId: role.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { attempt: nextAttempt, sessionId: role.sessionId, candidateKind: contract.candidateKind, timeoutMs: effectiveAttemptTimeoutMs(contract), ...(input.candidate === undefined ? {} : { candidate: input.candidate }) }, evidence: input.evidence });
}

export function recordVerdict(runtime: GraphRuntimeState, team: TeamState, contract: TopologyLoopContract, input: { loopInstanceId: string; actorSessionId: string; evaluatorRole: string; verdict: "PASS" | "FAIL" | "BLOCKED"; findings?: string[]; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  const evaluator = roleFor(team, contract.evaluatorRole);
  const loop = deriveGraph(runtime).get(input.loopInstanceId);
  if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `Loop ${input.loopInstanceId} was not found`);
  assertScopesOpen(runtime, [loop.loopId, `loop:${loop.loopId}`]);
  if (loop.evaluatorRole.toLowerCase() !== input.evaluatorRole.toLowerCase() || contract.evaluatorRole.toLowerCase() !== input.evaluatorRole.toLowerCase()) throw new GraphRuntimeError("evaluator_required", "verdict evaluator does not match the declared evaluator role");
  if (input.actorSessionId !== evaluator.sessionId) throw new GraphRuntimeError("evaluator_required", "only the current evaluator Session may record a verdict");
  const attempt = loop.attempts.at(-1);
  if (loop.status !== "running" && attempt?.verdict === input.verdict) return { kind: "noop", runtime, events: [] };
  if (loop.status !== "running") throw new GraphRuntimeError(loop.status === "cap_exhausted" ? "cap_exhausted" : "loop_terminal", `Loop ${loop.loopInstanceId} is ${loop.status}`);
  if (attempt === undefined || attempt.verdict !== undefined) throw new GraphRuntimeError("attempt_conflict", "verdict requires one current started attempt");
  if (input.verdict === "PASS" && attempt.attempt > effectiveMaxAttempts(contract)) throw new GraphRuntimeError("cap_exhausted", "PASS cannot occur after the hard cap");
  if (input.findings !== undefined && (!Array.isArray(input.findings) || !input.findings.every((finding) => typeof finding === "string"))) throw new GraphRuntimeError("invalid_shape", "verdict findings must be a string array");
  assertEvidenceKinds(input.evidence ?? [], contract.requiredEvidenceKinds, "verdict");
  let next = appendOne(runtime, { type: "verdict_recorded", actorSessionId: input.actorSessionId, roleId: evaluator.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { attempt: attempt.attempt, verdict: input.verdict, findings: input.findings ?? [] }, evidence: input.evidence });
  if (next.kind === "noop") return next;
  const completed = appendOne(next.runtime, { type: "attempt_completed", actorSessionId: input.actorSessionId, roleId: evaluator.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { attempt: attempt.attempt, status: input.verdict === "PASS" ? "passed" : input.verdict === "BLOCKED" ? "blocked" : "failed" }, evidence: input.evidence });
  if (completed.kind === "noop") return completed;
  next = { kind: "changed", runtime: completed.runtime, events: [...next.events, ...completed.events] };
  if (input.verdict === "FAIL" && attempt.attempt >= effectiveMaxAttempts(contract)) {
    const capped = appendOne(next.runtime, { type: "cap_exhausted", actorSessionId: input.actorSessionId, roleId: evaluator.id, loopInstanceId: input.loopInstanceId, createdAt: input.now, payload: { loopId: loop.loopId, attempts: attempt.attempt, evaluatorRole: evaluator.id, unresolvedFindings: input.findings ?? [], charterRevision: runtime.charterRevision, charterDigest: runtime.charterDigest, escalation: contract.capExhaustedRoute }, evidence: input.evidence });
    if (capped.kind === "changed") next = { kind: "changed", runtime: capped.runtime, events: [...next.events, ...capped.events] };
  }
  return next;
}

/**
 * The cap event every exhausted Loop ends on, whichever way it was exhausted.
 *
 * One payload shape for all three precedents (verdict at the ceiling, deadline
 * at the ceiling, Loop budget exceeded) means downstream readers — and the
 * frozen `capExhaustedRoute` a driver follows — never have to branch on how a
 * Loop died, only on the fact that it did.
 */
function capExhaustedPayload(runtime: GraphRuntimeState, loop: LoopSummary, attempt: LoopAttemptSummary | undefined, contract: TopologyLoopContract, unresolvedFindings: string[]): Record<string, unknown> {
  // `attempts` counts Attempts that actually ran. A Loop whose budget was blown
  // before anything started honestly reports zero rather than borrowing a
  // number from an Attempt that never existed.
  return { loopId: loop.loopId, attempts: attempt?.attempt ?? 0, evaluatorRole: loop.evaluatorRole, unresolvedFindings, charterRevision: runtime.charterRevision, charterDigest: runtime.charterDigest, escalation: contract.capExhaustedRoute };
}

/**
 * Close one Attempt that reached its deadline, without inventing a verdict.
 *
 * A deadline is a fact about time, not an opinion about the work, so an expired
 * Attempt records `expired` rather than a FAIL nobody judged — and it still
 * leaves the Loop through the SAME three exits a verdict would (retry, or
 * `cap_exhausted` at the ceiling). That is what keeps "超时不是异常" true: a
 * timed-out Loop is a normal bounded outcome, not a new terminal kind.
 *
 * Permission is controller OR the Attempt's own participant Session. Requiring
 * the evaluator would be wrong: the evaluator may be exactly the party that
 * never woke up, and the deadline is true regardless of who notices it.
 *
 * @param runtime - current graph runtime.
 * @param team - the Team the runtime belongs to.
 * @param contract - the frozen Loop contract the attempt started under.
 * @param input - loop instance, actor, observation time, and optional reason.
 * @returns appended `attempt_expired` (+ `attempt_completed`, + `cap_exhausted`).
 * @throws {GraphRuntimeError} `timeout_not_reached` when no Attempt is due,
 *   `loop_not_found`/`loop_terminal` when the Loop cannot be swept,
 *   `permission_denied` for an unrelated actor.
 */
export function expireAttempt(
  runtime: GraphRuntimeState,
  team: TeamState,
  contract: TopologyLoopContract,
  input: { loopInstanceId: string; actorSessionId: string; now: number; reason?: string; evidence?: EvidenceRef[] },
): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  if (!finite(input.now)) throw new GraphRuntimeError("invalid_shape", "attempt expiry requires a finite time");
  const loop = deriveGraph(runtime).get(input.loopInstanceId);
  if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `Loop ${input.loopInstanceId} was not found`);
  if (loop.status !== "running") throw new GraphRuntimeError(loop.status === "cap_exhausted" ? "cap_exhausted" : "loop_terminal", `Loop ${loop.loopInstanceId} is ${loop.status}`);
  if (loop.loopId !== contract.loopId) throw new GraphRuntimeError("invalid_shape", "attempt contract does not match Loop");
  const attempt = loop.attempts.at(-1);
  if (attempt === undefined || attempt.status !== "started" || attempt.verdict !== undefined) {
    throw new GraphRuntimeError("timeout_not_reached", `Loop ${loop.loopInstanceId} has no open attempt to expire; every attempt is already settled`);
  }
  // The deadline is recomputed from the contract and the Attempt's own start
  // time. Trusting a caller-supplied deadline would let a participant end a
  // peer's Attempt early by asserting one.
  const deadlineAt = attemptDeadlineAt(attempt, contract);
  if (input.now < deadlineAt) {
    throw new GraphRuntimeError("timeout_not_reached", `attempt ${attempt.attempt} of Loop ${loop.loopInstanceId} is still inside its deadline (${deadlineAt - input.now}ms remaining)`);
  }
  const actor = input.actorSessionId === team.controllerSessionId ? undefined : roleFor(team, attempt.roleId);
  if (actor !== undefined && actor.sessionId !== input.actorSessionId) {
    throw new GraphRuntimeError("permission_denied", "attempt expiry actor must be the Team controller or the attempt's own participant Session");
  }
  const reason = input.reason ?? "attempt deadline reached";
  const expired = appendOne(runtime, { type: "attempt_expired", actorSessionId: input.actorSessionId, roleId: attempt.roleId, loopInstanceId: loop.loopInstanceId, createdAt: input.now, eventId: `attempt:${loop.loopInstanceId}:${attempt.attempt}:expired`, payload: { attempt: attempt.attempt, deadlineAt, expiredAt: input.now, reason }, evidence: input.evidence });
  if (expired.kind === "noop") return expired;
  const completed = appendOne(expired.runtime, { type: "attempt_completed", actorSessionId: input.actorSessionId, roleId: attempt.roleId, loopInstanceId: loop.loopInstanceId, createdAt: input.now, eventId: `attempt:${loop.loopInstanceId}:${attempt.attempt}:completed`, payload: { attempt: attempt.attempt, status: "expired", reason }, evidence: input.evidence });
  if (completed.kind === "noop") return completed;
  let next: GraphCommandResult = { kind: "changed", runtime: completed.runtime, events: [...expired.events, ...completed.events] };
  if (attempt.attempt >= loop.effectiveMaxAttempts) {
    const capped = appendOne(next.runtime, { type: "cap_exhausted", actorSessionId: input.actorSessionId, roleId: attempt.roleId, loopInstanceId: loop.loopInstanceId, createdAt: input.now, payload: capExhaustedPayload(runtime, loop, attempt, contract, [reason]), evidence: input.evidence });
    if (capped.kind === "changed") next = { kind: "changed", runtime: capped.runtime, events: [...next.events, ...capped.events] };
  }
  return next;
}

/**
 * Record a Loop-level wall-clock budget as exceeded, and end that Loop.
 *
 * Exceeding a budget is an outcome the frozen charter already anticipated
 * (`capExhaustedRoute`), so the Loop ends through that exit rather than on a
 * fourth one. The budget event is written BEFORE the cap event so a reader can
 * always see why the cap fired.
 */
function exhaustLoopBudget(runtime: GraphRuntimeState, loop: LoopSummary, contract: TopologyLoopContract, actorSessionId: string, now: number): GraphCommandResult {
  const consumedMs = now - loop.startedAt;
  const limitMs = contract.wallClockBudgetMs as number;
  const recorded = appendOne(runtime, {
    type: "budget_exhausted",
    actorSessionId,
    loopInstanceId: loop.loopInstanceId,
    createdAt: now,
    payload: { scope: "loop", loopId: loop.loopId, limitMs, consumedMs },
  });
  if (recorded.kind === "noop") return recorded;
  const attempt = loop.attempts.at(-1);
  const capped = appendOne(recorded.runtime, {
    type: "cap_exhausted",
    actorSessionId,
    loopInstanceId: loop.loopInstanceId,
    createdAt: now,
    payload: capExhaustedPayload(runtime, loop, attempt, contract, [`Loop budget ${limitMs}ms exceeded after ${consumedMs}ms`]),
  });
  if (capped.kind === "changed") return { kind: "changed", runtime: capped.runtime, events: [...recorded.events, ...capped.events] };
  return { kind: "changed", runtime: recorded.runtime, events: recorded.events };
}

/**
 * The Team-level wall-clock ceiling the current Frozen Charter declares, if any.
 *
 * Read from the FROZEN topology, not from whatever is on disk now: the charter a
 * run was approved under is the only one whose budget that run can be judged
 * against.
 */
function teamBudgetLimitMs(team: TeamState): number | undefined {
  const document = team.document;
  const revision = document?.currentCharterRevision;
  if (document === undefined || revision === null || revision === undefined) return undefined;
  const frozen = document.charterRevisions.find((entry) => entry.charterRevision === revision);
  return frozen?.topology.config.protocol?.budgets?.teamWallClockMs;
}

/**
 * Record every deadline and budget that has already passed, and nothing else.
 *
 * This is the read-path sweep the design chose over a background timer: it adds
 * no lifecycle that could leak on unload, it is deterministic given the log and
 * a clock (so it can be replayed offline), and it makes "the driver is the only
 * advancer" literal — the facts get written when someone looks, and any
 * remaining unfairness is stated plainly rather than hidden behind a timer.
 *
 * It is idempotent by STATE, not by event id: once an Attempt is `expired` or a
 * budget is recorded, the guard that produced it no longer fires, so a second
 * sweep in the same instant returns `noop` instead of raising a duplicate.
 *
 * Expiry here does NOT consult the Team budget gate: a deadline that has passed
 * is already true, and refusing to record it would strand an open Attempt
 * forever and hide the truth from every later reader.
 *
 * @param runtime - current graph runtime.
 * @param team - the Team the runtime belongs to.
 * @param contracts - the FROZEN Loop contracts of the current charter.
 * @param now - observation time; the sweep never invents a different one.
 * @returns one `changed` carrying every appended fact, or `noop`.
 */
export function sweepBoundedRun(
  runtime: GraphRuntimeState,
  team: TeamState,
  contracts: readonly TopologyLoopContract[],
  now: number,
): GraphCommandResult {
  if (!finite(now)) throw new GraphRuntimeError("invalid_shape", "sweep requires a finite observation time");
  currentCharterMatches(runtime, team);
  // The sweep is performed on the controller's behalf — it runs while a
  // controller-side command is executing, and only the controller may advance
  // the graph — so that is the honest actor to attribute an automatic fact to.
  const actorSessionId = team.controllerSessionId;
  let current = runtime;
  let appended: GraphEvent[] = [];
  const emit = (result: GraphCommandResult): void => {
    if (result.kind !== "changed") return;
    current = result.runtime;
    appended = [...appended, ...result.events];
  };
  const contractFor = (loop: LoopSummary): TopologyLoopContract | undefined => contracts.find((entry) => entry.loopId === loop.loopId);

  // 1) Team budget first: it is the outermost ceiling, and recording it before
  //    the per-Loop work keeps the log readable in the order the limits apply.
  const teamLimit = teamBudgetLimitMs(team);
  if (teamLimit !== undefined && !teamBudgetExhausted(current)) {
    const consumedMs = now - team.createdAt;
    if (consumedMs >= teamLimit) {
      emit(appendOne(current, { type: "budget_exhausted", actorSessionId, createdAt: now, payload: { scope: "team", limitMs: teamLimit, consumedMs } }));
    }
  }

  // 2) Attempt deadlines.
  for (const loop of graphLoops(current)) {
    if (loop.status !== "running") continue;
    const contract = contractFor(loop);
    if (contract === undefined) continue;
    const attempt = loop.attempts.at(-1);
    if (attempt === undefined || attempt.status !== "started") continue;
    if (now < attemptDeadlineAt(attempt, contract)) continue;
    emit(expireAttempt(current, team, contract, { loopInstanceId: loop.loopInstanceId, actorSessionId, now, reason: "attempt deadline reached" }));
  }

  // 3) Loop budgets. Re-read the loops: step 2 may have ended one.
  for (const loop of graphLoops(current)) {
    if (loop.status !== "running" || loop.budgetExhausted !== undefined) continue;
    const contract = contractFor(loop);
    if (contract?.wallClockBudgetMs === undefined) continue;
    if (now - loop.startedAt < contract.wallClockBudgetMs) continue;
    emit(exhaustLoopBudget(current, loop, contract, actorSessionId, now));
  }

  return appended.length === 0 ? { kind: "noop", runtime, events: [] } : { kind: "changed", runtime: current, events: appended };
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

export function appendHandoffPending(runtime: GraphRuntimeState, team: TeamState, contract: TopologyHandoffContract, input: { handoffId: string; kind: string; fromRole: string; toRole: string; loopInstanceId?: string; attempt?: number; summary: string; payload: Record<string, unknown>; actorSessionId: string; now: number; evidence?: EvidenceRef[]; controllerRoleId?: string }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  if (!record(input.payload) || !nonEmpty(input.handoffId) || !nonEmpty(input.summary)) throw new GraphRuntimeError("handoff_invalid", "handoff id, summary, and object payload are required");
  const from = roleFor(team, input.fromRole);
  const to = resolveHandoffTarget(team, input.toRole, input.controllerRoleId);
  if (input.actorSessionId !== from.sessionId) throw new GraphRuntimeError("permission_denied", "handoff actor does not own the fromRole");
  validateHandoffPayload(contract, from.id, to.id, input.kind, input.payload, input.evidence ?? []);
  if (input.loopInstanceId !== undefined) {
    const loop = graphLoops(runtime).find((entry) => entry.loopInstanceId === input.loopInstanceId);
    if (loop === undefined) throw new GraphRuntimeError("loop_not_found", `handoff references unknown Loop ${input.loopInstanceId}`);
    if (loop.status === "cap_exhausted") throw new GraphRuntimeError("cap_exhausted", `handoff Loop ${input.loopInstanceId} is ${loop.status}`);
    // A passed Loop still accepts a handoff bound to its final (passed) attempt —
    // the frozen verdict handoff (reviewer → driver) is delivered after PASS.
    if (loop.status !== "running" && loop.status !== "passed") throw new GraphRuntimeError("loop_terminal", `handoff Loop ${input.loopInstanceId} is ${loop.status}`);
    const currentAttempt = loop.attempts.at(-1)?.attempt;
    if (input.attempt !== undefined && input.attempt !== currentAttempt) throw new GraphRuntimeError("attempt_conflict", `handoff attempt ${input.attempt} is not the current attempt ${currentAttempt ?? "none"}`);
    assertScopesOpen(runtime, [loop.loopId, `loop:${loop.loopId}`, `role:${from.id}`, `role:${to.id}`]);
  }
  if (input.loopInstanceId === undefined) assertScopesOpen(runtime, [`role:${from.id}`, `role:${to.id}`]);
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
  assertTeamBudgetOpen(runtime);
  const existing = graphHandoffs(runtime).find((handoff) => handoff.handoffId === input.handoffId);
  if (existing === undefined) throw new GraphRuntimeError("handoff_invalid", `handoff ${input.handoffId} has no pending intent`);
  const scopes = [`role:${existing.fromRole}`, `role:${existing.toRole}`];
  if (existing.loopInstanceId !== undefined) {
    const loop = graphLoops(runtime).find((entry) => entry.loopInstanceId === existing.loopInstanceId);
    if (loop !== undefined) scopes.push(loop.loopId, `loop:${loop.loopId}`);
  }
  assertScopesOpen(runtime, scopes);
  if (existing.status === "accepted" || existing.status === "failed") return { kind: "noop", runtime, events: [] };
  return appendOne(runtime, { type: input.accepted ? "handoff_accepted" : "handoff_failed", actorSessionId: input.actorSessionId, roleId: existing.fromRole, nodeId: `handoff:${input.handoffId}`, loopInstanceId: existing.loopInstanceId, createdAt: input.now, eventId: `handoff:${input.handoffId}:${input.accepted ? "accepted" : "failed"}`, payload: { handoffId: input.handoffId, ...(input.receipt === undefined ? {} : { receipt: input.receipt }), ...(input.error === undefined ? {} : { error: input.error }) }, evidence: [] });
}

export function graphHandoffs(runtime: GraphRuntimeState): HandoffSummary[] {
  const handoffs = new Map<string, HandoffSummary>();
  for (const event of runtime.events) {
    if (!["handoff_pending", "handoff_accepted", "handoff_failed"].includes(event.type)) continue;
    const id = typeof event.payload.handoffId === "string" && event.payload.handoffId !== "" ? event.payload.handoffId : undefined;
    if (id === undefined) throw new GraphRuntimeError("invalid_event", `handoff event ${event.eventId} has no handoffId`);
    if (event.type === "handoff_pending") {
      if (handoffs.has(id) || typeof event.payload.kind !== "string" || typeof event.payload.fromRole !== "string" || typeof event.payload.toRole !== "string" || typeof event.payload.toSessionId !== "string" || typeof event.payload.summary !== "string" || !record(event.payload.payload)) throw new GraphRuntimeError("invalid_event", `handoff pending event ${event.eventId} is malformed or duplicated`);
      handoffs.set(id, { handoffId: id, ...(event.loopInstanceId === undefined ? {} : { loopInstanceId: event.loopInstanceId }), ...(typeof event.payload.attempt === "number" ? { attempt: event.payload.attempt } : {}), fromRole: String(event.payload.fromRole ?? event.roleId ?? ""), toRole: String(event.payload.toRole ?? ""), ...(typeof event.payload.toSessionId === "string" ? { targetSessionId: event.payload.toSessionId } : {}), status: "pending", summary: String(event.payload.summary ?? ""), evidence: clone(event.evidence) });
    } else {
      const current = handoffs.get(id);
      if (current === undefined || current.status !== "pending") throw new GraphRuntimeError("invalid_event", `handoff result ${event.eventId} has no pending intent`);
      if (event.type === "handoff_accepted" && !record(event.payload.receipt)) throw new GraphRuntimeError("invalid_event", `handoff accepted event ${event.eventId} has no receipt`);
      if (event.type === "handoff_failed" && (typeof event.payload.error !== "string" || event.payload.error === "")) throw new GraphRuntimeError("invalid_event", `handoff failed event ${event.eventId} has no error`);
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
  const gates = gatesFromEvents(runtime.events);
  const closure = closureFromEvents(runtime.events);
  const blockedGates = [...gates.values()].filter((gate) => ["open", "blocked", "expired"].includes(gate.status) && gate.required);
  const budgets: BudgetExhaustion[] = runtime.events
    .filter((event) => event.type === "budget_exhausted")
    .map((event) => ({
      scope: event.payload.scope as BudgetExhaustion["scope"],
      ...(typeof event.payload.loopId === "string" ? { loopId: event.payload.loopId } : {}),
      limitMs: Number(event.payload.limitMs),
      consumedMs: Number(event.payload.consumedMs),
    }));
  return {
    status: stale ? "stale" : blockedGates.length > 0 ? "blocked" : current === undefined ? "idle" : current.status === "cap_exhausted" ? "cap_exhausted" : current.status,
    ...(current === undefined ? {} : { currentLoop: { loopInstanceId: current.loopInstanceId, loopId: current.loopId, ...(current.attempts.at(-1) === undefined ? {} : { attempt: current.attempts.at(-1)?.attempt }), status: current.status } }),
    pendingHandoffs: pending,
    capExhausted: loops.filter((loop) => loop.capExhausted).map((loop) => loop.loopInstanceId),
    expiredAttempts: loops.reduce((total, loop) => total + loop.attempts.filter((attempt) => attempt.status === "expired").length, 0),
    budgets,
    teamBudgetExhausted: budgets.some((budget) => budget.scope === "team"),
    openGates: [...gates.values()].filter((gate) => ["open", "blocked", "expired"].includes(gate.status)),
    blockedScopes: blockedGates.flatMap((gate) => gate.blockingScope),
    closure,
    runtimeRevision: runtime.runtimeRevision,
    stale,
  };
}

export function graphGates(runtime: GraphRuntimeState): GateSummary[] {
  return [...gatesFromEvents(runtime.events).values()].map(clone);
}

export function graphClosure(runtime: GraphRuntimeState): ClosureSummary {
  return clone(closureFromEvents(runtime.events));
}

export function openGate(runtime: GraphRuntimeState, team: TeamState, definition: TopologyGateDefinition, input: { gateInstanceId: string; actorSessionId: string; now: number; humanMode?: "interactive" | "checkpointed" | "autonomous"; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  if (input.actorSessionId !== team.controllerSessionId) throw new GraphRuntimeError("permission_denied", "only the Team controller may open a Human Gate");
  if (!validGateDefinition(definition) || !nonEmpty(input.gateInstanceId)) throw new GraphRuntimeError("invalid_shape", "Gate definition or instance id is invalid");
  if (input.humanMode === "autonomous" && definition.required && (definition.onUnavailable !== "fallback" || (definition.timeoutPolicy !== undefined && definition.timeoutPolicy !== "fallback"))) throw new GraphRuntimeError("handoff_invalid", "autonomous required Human Gate must have a pre-approved fallback");
  const existing = gatesFromEvents(runtime.events).get(input.gateInstanceId);
  if (existing !== undefined) {
    if (existing.gateId !== definition.gateId || stable(existing.blockingScope) !== stable(definition.blockingScope)) throw new GraphRuntimeError("duplicate_event", `Gate instance ${input.gateInstanceId} conflicts with existing scope`);
    return { kind: "noop", runtime, events: [] };
  }
  return appendOne(runtime, { type: "gate_opened", actorSessionId: input.actorSessionId, nodeId: `gate:${input.gateInstanceId}`, createdAt: input.now, eventId: `gate:${input.gateInstanceId}:opened`, payload: { gateInstanceId: input.gateInstanceId, gateId: definition.gateId, definition }, evidence: input.evidence });
}

export function resolveGate(runtime: GraphRuntimeState, team: TeamState, definition: TopologyGateDefinition, input: { gateInstanceId: string; option: string; approvingSessionId: string; commandId: string; source: "user-command"; now: number; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  if (input.approvingSessionId !== team.controllerSessionId) throw new GraphRuntimeError("permission_denied", "Human Gate decisions must be issued from the current Driver Session");
  if (input.source !== "user-command" || !nonEmpty(input.commandId) || !definition.options.includes(input.option)) throw new GraphRuntimeError("handoff_invalid", "Gate decision must use a declared option and user-command source");
  const gate = gatesFromEvents(runtime.events).get(input.gateInstanceId);
  if (gate === undefined || gate.gateId !== definition.gateId) throw new GraphRuntimeError("loop_not_found", `Gate ${input.gateInstanceId} is unknown`);
  if (gate.status === "resolved" || gate.status === "fallback_applied") return gate.selectedOption === input.option ? { kind: "noop", runtime, events: [] } : (() => { throw new GraphRuntimeError("duplicate_event", `Gate ${input.gateInstanceId} already resolved with another option`); })();
  if (gate.status !== "open") throw new GraphRuntimeError("loop_terminal", `Gate ${input.gateInstanceId} is ${gate.status}`);
  return appendOne(runtime, { type: "gate_resolved", actorSessionId: input.approvingSessionId, nodeId: `gate:${input.gateInstanceId}`, createdAt: input.now, eventId: `gate:${input.gateInstanceId}:resolved`, payload: { gateInstanceId: input.gateInstanceId, gateId: definition.gateId, option: input.option, commandId: input.commandId, source: input.source, approvingSessionId: input.approvingSessionId }, evidence: input.evidence });
}

export function applyGateFallback(runtime: GraphRuntimeState, team: TeamState, definition: TopologyGateDefinition, input: { gateInstanceId: string; actorSessionId: string; now: number; unavailableConfirmed: boolean; reason: string; evidence?: EvidenceRef[] }): GraphCommandResult {
  currentCharterMatches(runtime, team);
  assertGraphOpen(runtime);
  assertTeamBudgetOpen(runtime);
  if (input.actorSessionId !== team.controllerSessionId) throw new GraphRuntimeError("permission_denied", "only the Team controller may apply a Gate fallback");
  const gate = gatesFromEvents(runtime.events).get(input.gateInstanceId);
  if (gate === undefined || gate.gateId !== definition.gateId) throw new GraphRuntimeError("loop_not_found", `Gate ${input.gateInstanceId} is unknown`);
  if (gate.status !== "open") return { kind: "noop", runtime, events: [] };
  const expired = gate.expiresAt !== undefined && input.now >= gate.expiresAt;
  if (!expired && !input.unavailableConfirmed) throw new GraphRuntimeError("handoff_invalid", "Gate fallback is not allowed before expiry without an explicit unavailable fact");
  const action = expired && definition.timeoutPolicy !== undefined ? definition.timeoutPolicy : definition.onUnavailable;
  if (action === "fallback" && definition.fallbackOption === undefined) throw new GraphRuntimeError("handoff_invalid", "Gate fallback action has no pre-approved fallback option");
  const type: GraphEventType = action === "fallback" ? "gate_fallback_applied" : expired ? "gate_expired" : "gate_blocked";
  const payload = { gateInstanceId: input.gateInstanceId, gateId: definition.gateId, reason: input.reason, action, ...(action === "fallback" && definition.fallbackOption === undefined ? {} : action === "fallback" ? { option: definition.fallbackOption } : {}) };
  return appendOne(runtime, { type, actorSessionId: input.actorSessionId, nodeId: `gate:${input.gateInstanceId}`, createdAt: input.now, eventId: `gate:${input.gateInstanceId}:${type}`, payload, evidence: input.evidence });
}

export type ClosureCommandResult = (GraphCommandResult & { accepted: boolean; diagnostic?: string });

export function recordClosure(runtime: GraphRuntimeState, team: TeamState, definition: TopologyClosureDefinition, input: { outcome: "completed" | "failed" | "abandoned"; actorSessionId: string; reason?: string; now: number; evidence?: EvidenceRef[] }): ClosureCommandResult {
  currentCharterMatches(runtime, team);
  const owner = ownerSession(team, definition.owner);
  const existing = closureFromEvents(runtime.events);
  if (existing.status === "recorded") {
    if (existing.outcome === input.outcome) return { kind: "noop", runtime, events: [], accepted: true };
    throw new GraphRuntimeError("duplicate_event", "Team closure already has a different terminal outcome");
  }
  if (input.actorSessionId !== owner) throw new GraphRuntimeError("permission_denied", "only the Frozen Charter closure owner may close the Team");
  if (!definition.allowedOutcomes.includes(input.outcome)) throw new GraphRuntimeError("invalid_shape", `closure outcome ${input.outcome} is not allowed by the Frozen Charter`);
  const reason = input.reason ?? "";
  const evidenceRefs = input.evidence ?? [];
  const readiness = closureReadiness(runtime, definition, input.outcome, evidenceRefs);
  const requested = appendOne(runtime, { type: "closure_requested", actorSessionId: input.actorSessionId, nodeId: "closure", createdAt: input.now, payload: { owner: definition.owner, outcome: input.outcome, reason }, evidence: evidenceRefs });
  if (requested.kind === "noop") return { kind: "noop", runtime, events: [], accepted: false };
  if (readiness !== undefined || ((input.outcome === "failed" || input.outcome === "abandoned") && reason === "")) {
    const rejected = appendOne(requested.runtime, { type: "closure_rejected", actorSessionId: input.actorSessionId, nodeId: "closure", createdAt: input.now, payload: { reason: readiness ?? `${input.outcome} closure requires a reason` }, evidence: evidenceRefs });
    if (rejected.kind === "changed") return { kind: "changed", runtime: rejected.runtime, events: [...requested.events, ...rejected.events], accepted: false, diagnostic: readiness ?? `${input.outcome} closure requires a reason` };
    return { kind: "changed", runtime: requested.runtime, events: requested.events, accepted: false, diagnostic: readiness };
  }
  const recorded = appendOne(requested.runtime, { type: "closure_recorded", actorSessionId: input.actorSessionId, nodeId: "closure", createdAt: input.now, payload: { owner: definition.owner, outcome: input.outcome, reason }, evidence: evidenceRefs });
  if (recorded.kind === "changed") return { kind: "changed", runtime: recorded.runtime, events: [...requested.events, ...recorded.events], accepted: true };
  return { kind: "changed", runtime: requested.runtime, events: requested.events, accepted: true };
}
