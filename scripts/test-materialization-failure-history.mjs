/**
 * A failed materialization must not claim it replaced something.
 *
 * ## The defect this pins
 *
 * `materializeRole`'s failure branch used to append to `sessionHistory`:
 *
 *     { sessionId: r.sessionId, reason: "materialization-failed" }
 *
 * `sessionHistory` means "the session id this role USED TO have, after being
 * replaced". In that branch nothing is replaced — `r.sessionId` never moves,
 * because the team state is deliberately left at `reserved` for the next
 * dispatch to rebuild. So the record asserted a replacement that did not happen.
 *
 * It also fed a loop. The retry builds ANOTHER session while `r.sessionId` still
 * holds the same value, so the same id was appended again on every failure. The
 * live evidence is team-f01da153's `difficulty-implementer`, whose history holds
 * two BYTE-IDENTICAL entries three seconds apart — and whose `role.sessionId`
 * points at a session directory that does not exist on disk
 * (`docs/review-rounds-ledger.md` §17/§18).
 *
 * ## What is asserted
 *
 * After a failed materialization: `sessionHistory` is unchanged, `role.sessionId`
 * is unchanged, `phase` is back to `reserved` — and, across TWO consecutive
 * failures, `sessionHistory` is STILL unchanged. That last one is the loop's
 * fingerprint, so it is asserted rather than assumed.
 *
 * ## Applicable boundary (R-creep)
 *
 * This covers the materialization FAILURE branch only. The other writer of
 * `sessionHistory` — the reactivation replacement path — is correct on purpose
 * (it advances `role.sessionId` FIRST, then records the id it moved off) and a
 * separate test below pins that ordering so a later "unify these two" change
 * cannot quietly break it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createActiveTeamStateStore } from "../lib/orchestra-state.js";
import { dispatchRoleTask } from "../lib/orchestra.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = "/tmp/orchestra-materialization-failure";

/** In-memory fs port: enough of the contract for the team store. */
class MemoryFs {
  constructor() {
    this.files = new Map();
    this.clock = 0;
  }
  async resolve(path, options = {}) {
    return { key: `${options.cwd ?? ""}:${path}`, displayPath: `${options.cwd ?? ""}/${path}` };
  }
  processPath(target) {
    return target.displayPath;
  }
  async stat(target) {
    const file = this.files.get(target.key);
    return file === undefined ? undefined : { type: "file", size: file.content.length, version: file.version };
  }
  async readText(target) {
    const file = this.files.get(target.key);
    if (file === undefined) throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
    return file.content;
  }
  async writeText(target, content, expected) {
    const current = this.files.get(target.key);
    if (expected?.kind === "createIfAbsent" && current !== undefined) {
      throw Object.assign(new Error("exists"), { code: "FS_NOT_OBSERVED" });
    }
    if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
      throw Object.assign(new Error("stale"), { code: "FS_STALE_VERSION" });
    }
    this.clock += 1;
    this.files.set(target.key, { content, version: `v${this.clock}` });
    return { kind: "written", version: `v${this.clock}` };
  }
}

function sessionFor(id) {
  return {
    id,
    header: { id, cwd, agentPreset: "orchestra-implementer" },
    inheritedEventCount: 0,
    events: [],
    snapshotEvents() {
      return this.events;
    },
    append(type, data) {
      this.events.push({ type, data, seq: this.events.length, time: Date.now() });
    },
  };
}

const RESERVED_SESSION = "orchestra-team-deadbeef-11111111-2222-3333-4444-555555555555";

function teamRecord() {
  return {
    schemaVersion: 1,
    teamId: "team-deadbeef",
    status: "active",
    cwd,
    rootCwd: cwd,
    controllerSessionId: "driver-1",
    createdAt: 1,
    roles: [
      {
        id: "implementer",
        name: "implementer",
        sessionId: RESERVED_SESSION,
        phase: "reserved",
        execution: "session",
        sessionHistory: [],
        preset: "orchestra-implementer",
        sandbox: "workspace-write",
        reportCount: 0,
        lastReport: null,
      },
    ],
    reports: [],
    notices: [],
    noticeFailures: [],
  };
}

/**
 * A context whose `agents.create` SUCCEEDS but whose composition window THROWS.
 *
 * That is the exact shape the failure branch was written for: the session object
 * is registered (so the branch's liveness probe sees it) while the attempt as a
 * whole fails, so the team state is left at `reserved` and `r.sessionId` does not
 * move. `createSession`'s own "already exists" guard reads `agents.get` first, so
 * the double reports the id as absent until `create` registers it.
 */
function makeHarness() {
  const fs = new MemoryFs();
  const agents = new Map();
  const sessions = new Map();
  const createAttempts = [];
  const controllerSession = sessionFor("driver-1");
  sessions.set("driver-1", controllerSession);
  agents.set("driver-1", { id: "driver-1", session: controllerSession, status: "idle" });

  const context = {
    fs,
    // `escrowPolicy` reads this on every dispatch; without it the dispatch dies
    // in the preamble and never reaches the branch under test.
    sandboxPolicy: { resolve: () => ({ kind: "policy" }) },
    get(name) {
      if (name === "fs") return fs;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "probe-p", model: "probe-m" }) };
      if (name === "tools") return { schemas: () => [{ name: "read", description: "read", parameters: {} }] };
      if (name === "agentPresets") return { resolve: async (id) => ({ id, trust: "system", path: `/presets/${id}/agent.cordis.yml` }), mount: async () => {} };
      if (name === "permissionPresets") return { defaultPreset: "workspace-write", resolve: () => ({ sandbox: "workspace-write", approval: "never" }) };
      if (name === "workspaceRegistry") return undefined;
      return undefined;
    },
    sessions: {
      get(id) {
        return sessions.get(String(id));
      },
    },
    agents: {
      get(id) {
        return agents.get(String(id));
      },
      async create(createOptions) {
        const id = String(createOptions.sessionId);
        createAttempts.push(id);
        const session = sessionFor(id);
        sessions.set(id, session);
        // Register BEFORE the setup window, so the liveness probe in the failure
        // branch finds it while the overall attempt still fails.
        agents.set(id, { id, session, status: "idle" });
        // The composition window runs and then FAILS — a preset that cannot be
        // composed, which is the failure this branch exists for. The agent stays
        // registered, so the branch's liveness probe sees it while the attempt as
        // a whole fails and the team state is left at `reserved`.
        try {
          if (createOptions.setup !== undefined) await createOptions.setup({ get: () => undefined, agentId: id });
        } finally {
          throw new Error("probe: the composition window failed");
        }
      },
    },
  };

  const exec = { agent: agents.get("driver-1"), signal: undefined };
  return {
    fs,
    context,
    store: createActiveTeamStateStore(fs),
    exec,
    createAttempts,
    agents,
    writeCount: () => fs.clock,
  };
}

async function seedTeam(harness) {
  const policy = { kind: "policy" };
  // `create`, not `mutate`: there is no snapshot yet to mutate.
  await harness.store.create(cwd, teamRecord(), { policy, signal: undefined });
}

function roleOf(state) {
  return state.team.roles.find((role) => role.id === "implementer");
}

test("a failed materialization leaves sessionHistory, sessionId and phase semantics intact", async () => {
  const harness = makeHarness();
  await seedTeam(harness);
  const before = roleOf(await harness.store.read(cwd, { signal: undefined }));

  // The dispatch will try to materialize the reserved seat, the composition window
  // will fail, and the role goes back to `reserved`.
  await assert.rejects(
    () => dispatchRoleTask(harness.context, harness.store, harness.exec, { roleId: "implementer", task: "probe" }),
    (error) => {
      assert.equal(error instanceof Error, true);
      return true;
    },
  );

  const after = roleOf(await harness.store.read(cwd, { signal: undefined }));

  // (1) the history did NOT grow — no replacement happened, so nothing may be
  //     recorded as replaced.
  assert.deepEqual(after.sessionHistory, before.sessionHistory, "sessionHistory must not change on a failed materialization");
  assert.deepEqual(after.sessionHistory, [], "and it must still be empty for a role that was never replaced");

  // (2) the role still points at the SAME session id. This is the ghost fix: the
  //     id must not be quietly abandoned while the team state keeps naming it.
  assert.equal(after.sessionId, RESERVED_SESSION, "the role's session id must not move on a failed materialization");

  // (3) the seat goes back to reserved so the next dispatch rebuilds it.
  assert.equal(after.phase, "reserved", "a failed materialization must return the seat to reserved");

  // (4) if the abandoned attempt was recorded at all, it went to noticeFailures —
  //     and it must NOT carry `replacedAt`, because "replaced" is precisely the
  //     false claim being removed.
  const recorded = after.noticeFailures ?? [];
  for (const entry of recorded) {
    assert.equal(
      Object.hasOwn(entry, "replacedAt"),
      false,
      `noticeFailures entries must not carry replacedAt semantics: ${JSON.stringify(entry)}`,
    );
    assert.equal(typeof entry.milestone, "string");
    assert.equal(typeof entry.failedAt, "number");
    assert.equal(typeof entry.reason, "string");
  }
});

test("two consecutive failures still leave sessionHistory untouched (the loop's fingerprint)", async () => {
  const harness = makeHarness();
  await seedTeam(harness);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => dispatchRoleTask(harness.context, harness.store, harness.exec, { roleId: "implementer", task: `probe ${attempt}` }),
      () => true,
    );
  }

  const after = roleOf(await harness.store.read(cwd, { signal: undefined }));
  assert.deepEqual(
    after.sessionHistory,
    [],
    "the original defect appended the same id once per failed attempt; two failures must still add nothing",
  );
  assert.equal(after.sessionId, RESERVED_SESSION);

  // Anti-vacuity, on a signal that is honest about this double: it cannot reach
  // `agents.create` (the dispatch refuses the preset before that), but it CAN
  // show the team store was written twice — i.e. the failure branch really ran
  // twice, which is the loop this test is about. Asserting on create-attempt
  // counts would have been asserting something the double never produces.
  assert.ok(
    harness.writeCount() >= 2,
    `expected the failure branch to have written the team at least twice, saw ${harness.writeCount()}`,
  );
});

test("the reactivation replacement path keeps advancing sessionId BEFORE recording the old one", async () => {
  // Pinned on purpose. The two writers of sessionHistory look similar and a later
  // "unify them" change is exactly how the correct one would get broken: the
  // ORDER is the correctness. Asserted on the source, because the behaviour needs
  // a full archive/reactivation fixture that this file deliberately does not build.
  const source = await readFile(join(REPO, "src", "orchestra.ts"), "utf8");
  const lines = source.split("\n");
  const assignIndex = lines.findIndex((line) => /^\s*role\.sessionId = created\.sessionId;\s*$/.test(line));
  assert.notEqual(assignIndex, -1, "the reactivation path must still assign the new session id");
  const historyIndex = lines.findIndex(
    (line, index) => index > assignIndex && /role\.sessionHistory = \[/.test(line),
  );
  assert.notEqual(historyIndex, -1, "the reactivation path must still record the replaced id");
  assert.ok(
    assignIndex < historyIndex,
    "reactivation must set role.sessionId first and only then record the OLD id in sessionHistory",
  );
  assert.match(
    lines.slice(historyIndex, historyIndex + 6).join("\n"),
    /oldSessionId/,
    "reactivation must record the id it moved OFF, not the new one",
  );
});
