/**
 * Process-local change signal for the active Team state store.
 *
 * `orchestra_wait` exists so a driver can sleep until something it cares about
 * happened, instead of polling `orchestra_team` in a loop. The observation
 * therefore has to come from ONE choke point: `createActiveTeamStateStore` is
 * constructed once per plugin instance, so wrapping that single object covers
 * every committed write — including writes made by tools the driver never
 * calls. `orchestra_report` is the load-bearing example: a role finishing its
 * piece of work books the report through the same store, which is exactly the
 * event a waiting driver must be woken by.
 *
 * Why the wake decision compares payloads instead of graph revisions: a report
 * write commits a Team whose `graphRuntime` is unchanged, so the revision is
 * identical. A revision-only rule would silence the very wake-up that matters,
 * and a driver that never wakes is worse than a driver that wakes once too
 * often. Comparing the committed payload against the snapshot the write
 * replaced is still a true "something changed" test, and it cannot miss a field
 * the way a hand-picked field list would; a false positive only costs the
 * waiter one re-read, while a false negative would strand it. The runtime
 * revision is carried alongside so a waiter that recorded a baseline can also
 * wake on a graph-only move.
 *
 * The bus holds no durable state and no module-level globals: it belongs to one
 * plugin instance, and `dispose()` releases every pending waiter so an unload
 * cannot leave a timer or a promise behind.
 *
 * @module dsh-orchestra/team-change-bus
 */

import type { ActiveTeamStateStore, TeamState } from "./orchestra-state.js";

/** One committed team-state write, as the store choke point observed it. */
export interface TeamChangeObservation {
  /**
   * Whether the committed state differs from the state the write replaced. A
   * write that commits an identical payload is NOT a change, which is what
   * keeps a re-scan of an unchanged Team from waking a sleeper.
   */
  changed: boolean;
  /**
   * Working directory of the Team that was written. One store instance serves
   * EVERY workspace on the host, so without this a waiter on one Team would be
   * woken by another workspace's write and would then report a change that its
   * own Team never had.
   */
  cwd?: string;
  /** Post-commit graph runtime revision, when the committed Team carries one. */
  runtimeRevision?: number;
}

/** How one wait ended. Only booleans and timing — never what changed. */
export interface TeamChangeWaitOutcome {
  changed: boolean;
  timedOut: boolean;
  observedAt: number;
  waitedMs: number;
  /**
   * Present only when neither a commit nor the timeout ended the wait: the
   * caller's signal aborted, or the bus was disposed. The caller re-reads state
   * and decides; a cancelled wait is not evidence of anything.
   */
  cancelled?: boolean;
}

export interface TeamChangeWaitOptions {
  /** Total wait budget in milliseconds. The TOOL clamps this; the bus accepts any positive value. */
  timeoutMs: number;
  /**
   * Working directory of the Team being waited on. A write to any OTHER
   * workspace's Team is ignored, so `changed` is a statement about this Team
   * rather than about the host.
   */
  cwd?: string;
  /**
   * Graph runtime revision sampled when the waiter registered. A commit whose
   * revision differs from this wakes the waiter even when the payload compares
   * equal, so a graph-only advance is never missed.
   */
  baselineRevision: number;
  /** Caller cancellation: ends the wait immediately and releases its timer. */
  signal?: AbortSignal;
}

export interface TeamChangeBus {
  /** Wake every waiter that this observation concerns. */
  notify(observation: TeamChangeObservation): void;
  /** Register a ONE-SHOT waiter; it settles exactly once and leaves no timer behind. */
  wait(options: TeamChangeWaitOptions): Promise<TeamChangeWaitOutcome>;
  /** Pending waiter count, for diagnostics and tests. */
  pending(): number;
  /** Release every pending waiter (plugin unload). Idempotent. */
  dispose(): void;
}

interface Waiter {
  readonly baselineRevision: number;
  readonly cwd: string | undefined;
  readonly startedAt: number;
  readonly resolve: (outcome: TeamChangeWaitOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}

const CANCELLED = (startedAt: number, now: number): TeamChangeWaitOutcome => ({
  changed: false,
  timedOut: false,
  observedAt: now,
  waitedMs: now - startedAt,
  cancelled: true,
});

/**
 * Create one plugin-owned change bus.
 *
 * @returns a bus whose waiters are all released by {@link TeamChangeBus.dispose}.
 */
export function createTeamChangeBus(): TeamChangeBus {
  const waiters = new Set<Waiter>();
  let disposed = false;

  const release = (waiter: Waiter): void => {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    waiter.detach?.();
    waiter.detach = undefined;
    waiters.delete(waiter);
  };

  const settle = (waiter: Waiter, outcome: TeamChangeWaitOutcome): void => {
    if (!waiters.has(waiter)) return;
    release(waiter);
    waiter.resolve(outcome);
  };

  return {
    notify(observation) {
      if (disposed) return;
      const now = Date.now();
      for (const waiter of [...waiters]) {
        // Another workspace's Team is not this waiter's business.
        if (waiter.cwd !== undefined && observation.cwd !== undefined && waiter.cwd !== observation.cwd) continue;
        const revisionMoved = observation.runtimeRevision !== undefined && observation.runtimeRevision !== waiter.baselineRevision;
        if (!observation.changed && !revisionMoved) continue;
        settle(waiter, { changed: true, timedOut: false, observedAt: now, waitedMs: now - waiter.startedAt });
      }
    },
    wait(options) {
      const startedAt = Date.now();
      // A disposed or already-aborted wait resolves immediately rather than
      // hanging: the caller's next action is to re-read state either way.
      if (disposed) return Promise.resolve(CANCELLED(startedAt, startedAt));
      if (options.signal?.aborted === true) return Promise.resolve(CANCELLED(startedAt, startedAt));
      return new Promise<TeamChangeWaitOutcome>((resolve) => {
        const waiter: Waiter = { baselineRevision: options.baselineRevision, cwd: options.cwd, startedAt, resolve };
        waiter.timer = setTimeout(() => {
          settle(waiter, { changed: false, timedOut: true, observedAt: Date.now(), waitedMs: Date.now() - startedAt });
        }, options.timeoutMs);
        // The timer is deliberately NOT unref'd. A wait is a live tool call, not
        // a background janitor: an unattended headless run whose only remaining
        // work is waiting for a Team commit must stay alive until the wait
        // settles, and an unref'd timer would let the process exit first and
        // silently turn "still waiting" into "run over".
        const signal = options.signal;
        if (signal !== undefined) {
          const onAbort = (): void => settle(waiter, CANCELLED(startedAt, Date.now()));
          signal.addEventListener("abort", onAbort, { once: true });
          waiter.detach = () => signal.removeEventListener("abort", onAbort);
        }
        waiters.add(waiter);
      });
    },
    pending() {
      return waiters.size;
    },
    dispose() {
      disposed = true;
      const now = Date.now();
      for (const waiter of [...waiters]) settle(waiter, CANCELLED(waiter.startedAt, now));
    },
  };
}

/**
 * Whether two committed Team payloads are the same change-relevant value.
 *
 * Both objects descend from the same in-memory lineage (callers spread the Team
 * they read), so key order is stable in practice. A differently-ordered but
 * equal payload would be reported as a change, which only costs the waiter one
 * re-read — the safe direction for this test.
 */
function sameCommittedTeam(before: TeamState, after: TeamState): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/**
 * Wrap the Team CAS store so every COMMITTED write notifies the bus.
 *
 * Wrapping the single store instance — rather than instrumenting the dozens of
 * `replace(...)` call sites — is what makes the signal complete: a future write
 * path cannot forget to notify, because it cannot reach the filesystem without
 * passing through here. The wrapper notifies only after the write resolves, so
 * a waiter that wakes is guaranteed the state is already durable and readable.
 *
 * @param store - the plugin's single active-team store.
 * @param bus - the plugin-owned change bus.
 * @returns a store with identical semantics plus the change signal.
 */
export function withChangeSignal(store: ActiveTeamStateStore, bus: TeamChangeBus): ActiveTeamStateStore {
  const observe = (cwd: string, before: TeamState | undefined, after: TeamState | undefined): void => {
    if (after === undefined) {
      // The active Team is gone (archived). That is unambiguously a change.
      bus.notify({ changed: true, cwd });
      return;
    }
    const revision = after.graphRuntime?.runtimeRevision;
    bus.notify({
      changed: before === undefined || !sameCommittedTeam(before, after),
      cwd,
      ...(revision === undefined ? {} : { runtimeRevision: revision }),
    });
  };
  return {
    read: (cwd, options) => store.read(cwd, options),
    async create(cwd, team, options) {
      const result = await store.create(cwd, team, options);
      observe(cwd, undefined, team);
      return result;
    },
    async replace(snapshot, team, options) {
      const result = await store.replace(snapshot, team, options);
      observe(snapshot.cwd, snapshot.team, team);
      return result;
    },
    async archive(snapshot, marker, options) {
      const result = await store.archive(snapshot, marker, options);
      observe(snapshot.cwd, snapshot.team, undefined);
      return result;
    },
  };
}
