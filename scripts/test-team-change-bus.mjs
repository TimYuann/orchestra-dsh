/**
 * The Team change bus: what wakes a waiter, what deliberately does not, and
 * that no waiter outlives the wait it belongs to.
 *
 * The bus is the only thing standing between "the driver sleeps until work
 * lands" and "the driver polls forever", so these tests pin both directions of
 * the error: a write that happened MUST wake a sleeper (a missed wake strands an
 * unattended run), and a write that committed nothing MUST NOT (a spurious wake
 * turns every no-op CAS into a busy loop).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTeamChangeBus, withChangeSignal } from "../lib/team-change-bus.js";

function team(id, revision, extra = {}) {
  return { teamId: id, ...(revision === undefined ? {} : { graphRuntime: { runtimeRevision: revision } }), ...extra };
}

function fakeStore(overrides = {}) {
  const calls = [];
  const store = {
    calls,
    async read(cwd) {
      return { kind: "missing", cwd };
    },
    async create(cwd, state) {
      calls.push({ op: "create", state });
      return { operation: "created", state, version: 1, statePath: "orchestra/state/team.json" };
    },
    async replace(snapshot, state) {
      calls.push({ op: "replace", snapshot, state });
      return { operation: "replaced", state, version: 2, statePath: "orchestra/state/team.json" };
    },
    async archive(snapshot) {
      calls.push({ op: "archive", snapshot });
      return { operation: "replaced", state: {}, version: 3, statePath: "orchestra/state/team.json" };
    },
    ...overrides,
  };
  return store;
}

test("a committed write wakes a waiter, and only once the write has resolved", async () => {
  const bus = createTeamChangeBus();
  const wrapped = withChangeSignal(fakeStore(), bus);
  const before = team("t1", 1);
  const waiting = bus.wait({ timeoutMs: 5_000, baselineRevision: 1 });

  // The waiter must not be woken by the write being ATTEMPTED: it wakes when the
  // state is durable and readable, which is what makes a post-wake read safe.
  const write = wrapped.replace({ team: before }, team("t1", 2), {});
  assert.equal(bus.pending(), 1, "still waiting while the write is in flight");
  await write;

  const outcome = await waiting;
  assert.equal(outcome.changed, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.cancelled, undefined);
  assert.ok(outcome.observedAt > 0);
  assert.ok(outcome.waitedMs >= 0);
  assert.equal(bus.pending(), 0, "a settled waiter must leave no timer behind");
});

test("a payload change at an unchanged graph revision still wakes a waiter", async () => {
  // This is the case a revision-only rule would silently drop: a role filing a
  // report books it on the Team without touching graphRuntime, and that is
  // exactly the wake-up a waiting driver needs.
  const bus = createTeamChangeBus();
  const wrapped = withChangeSignal(fakeStore(), bus);
  const before = team("t1", 7, { reports: [] });
  const waiting = bus.wait({ timeoutMs: 5_000, baselineRevision: 7 });
  await wrapped.replace({ team: before }, team("t1", 7, { reports: [{ reportId: "r1" }] }), {});
  const outcome = await waiting;
  assert.equal(outcome.changed, true);
  assert.equal(outcome.timedOut, false);
});

test("a write that commits the same payload does not wake a waiter", async () => {
  const bus = createTeamChangeBus();
  const wrapped = withChangeSignal(fakeStore(), bus);
  const before = team("t1", 3, { roles: [{ id: "reviewer", phase: "active" }] });
  const waiting = bus.wait({ timeoutMs: 25, baselineRevision: 3 });
  await wrapped.replace({ team: before }, structuredClone(before), {});
  const outcome = await waiting;
  assert.equal(outcome.changed, false, "an unchanged payload is not a change");
  assert.equal(outcome.timedOut, true);
  assert.equal(bus.pending(), 0);
});

test("a revision move wakes a waiter even when the payload compares equal", () => {
  const bus = createTeamChangeBus();
  const waiting = bus.wait({ timeoutMs: 5_000, baselineRevision: 4 });
  // Defensive branch: reached only by a caller that notifies with a revision but
  // no payload comparison. It must still wake rather than strand the waiter.
  bus.notify({ changed: false, runtimeRevision: 5 });
  return waiting.then((outcome) => {
    assert.equal(outcome.changed, true);
    assert.equal(outcome.timedOut, false);
  });
});

test("a failed write notifies nobody", async () => {
  const bus = createTeamChangeBus();
  const wrapped = withChangeSignal(
    fakeStore({
      async replace() {
        throw new Error("CAS lost: active team state changed");
      },
    }),
    bus,
  );
  const waiting = bus.wait({ timeoutMs: 25, baselineRevision: 1 });
  await assert.rejects(() => wrapped.replace({ team: team("t1", 1) }, team("t1", 2), {}), /CAS lost/);
  const outcome = await waiting;
  assert.equal(outcome.changed, false, "nothing was committed, so nothing may claim a change");
  assert.equal(outcome.timedOut, true);
});

test("creating and archiving a Team are changes, and read stays untouched", async () => {
  const bus = createTeamChangeBus();
  const store = fakeStore();
  const wrapped = withChangeSignal(store, bus);

  const created = bus.wait({ timeoutMs: 5_000, baselineRevision: 0 });
  await wrapped.create("/tmp/t", team("t1", 1), {});
  assert.equal((await created).changed, true);

  const archived = bus.wait({ timeoutMs: 5_000, baselineRevision: 1 });
  await wrapped.archive({ team: team("t1", 1) }, { archived: true }, {});
  assert.equal((await archived).changed, true, "a Team that disappeared is unambiguously a change");

  const read = await wrapped.read("/tmp/t");
  assert.equal(read.kind, "missing", "the wrapper must not alter read semantics");
  assert.deepEqual(
    store.calls.map((entry) => entry.op),
    ["create", "archive"],
  );
});

test("timeout, cancellation, and disposal all release the waiter", async () => {
  const bus = createTeamChangeBus();

  const timedOut = await bus.wait({ timeoutMs: 15, baselineRevision: 1 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.changed, false);
  assert.equal(bus.pending(), 0);
  assert.ok(timedOut.waitedMs >= 0);

  const controller = new AbortController();
  const cancelled = bus.wait({ timeoutMs: 5_000, baselineRevision: 1, signal: controller.signal });
  controller.abort();
  const cancelledOutcome = await cancelled;
  assert.equal(cancelledOutcome.cancelled, true, "the caller learns the wait ended for its own reason");
  assert.equal(cancelledOutcome.changed, false);
  assert.equal(cancelledOutcome.timedOut, false);
  assert.equal(bus.pending(), 0);

  // An already-aborted signal must not register a waiter at all.
  const abortedController = new AbortController();
  abortedController.abort();
  const preAborted = await bus.wait({ timeoutMs: 5_000, baselineRevision: 1, signal: abortedController.signal });
  assert.equal(preAborted.cancelled, true);
  assert.equal(bus.pending(), 0);

  const pending = bus.wait({ timeoutMs: 5_000, baselineRevision: 1 });
  assert.equal(bus.pending(), 1);
  bus.dispose();
  const disposed = await pending;
  assert.equal(disposed.cancelled, true, "plugin unload must end every pending wait, not leak it");
  assert.equal(bus.pending(), 0);

  // Post-dispose calls resolve rather than hang, and notify is a no-op.
  const afterDispose = await bus.wait({ timeoutMs: 5_000, baselineRevision: 1 });
  assert.equal(afterDispose.cancelled, true);
  assert.doesNotThrow(() => bus.notify({ changed: true }));
});

test("one write wakes every waiter registered before it", async () => {
  const bus = createTeamChangeBus();
  const wrapped = withChangeSignal(fakeStore(), bus);
  const first = bus.wait({ timeoutMs: 5_000, baselineRevision: 1 });
  const second = bus.wait({ timeoutMs: 5_000, baselineRevision: 2 });
  assert.equal(bus.pending(), 2);
  await wrapped.replace({ team: team("t1", 1) }, team("t1", 2), {});
  assert.equal((await first).changed, true);
  assert.equal((await second).changed, true, "a waiter whose baseline already differs still learns a write landed");
  assert.equal(bus.pending(), 0);
});

test("a write to another workspace's Team does not wake this waiter", async () => {
  // One store instance serves every workspace on the host. Without cwd scoping
  // a waiter would report `changed: true` for a commit that touched a Team it
  // was not waiting on — a boolean the driver would act on and find empty.
  const bus = createTeamChangeBus();
  const wrapped = withChangeSignal(fakeStore(), bus);
  const waiting = bus.wait({ timeoutMs: 25, cwd: "/tmp/mine", baselineRevision: 1 });
  await wrapped.replace({ cwd: "/tmp/other", team: team("t-other", 1) }, team("t-other", 2), {});
  const outcome = await waiting;
  assert.equal(outcome.changed, false, "another workspace's commit is not this Team's change");
  assert.equal(outcome.timedOut, true);

  // The same commit on the awaited workspace does wake it.
  const mine = bus.wait({ timeoutMs: 5_000, cwd: "/tmp/mine", baselineRevision: 1 });
  await wrapped.replace({ cwd: "/tmp/mine", team: team("t-mine", 1) }, team("t-mine", 2), {});
  assert.equal((await mine).changed, true);
});
