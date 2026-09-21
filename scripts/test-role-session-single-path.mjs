/**
 * S1: every role-session lifecycle path goes through ONE entry point.
 *
 * ## What this proves, and what it deliberately does not
 *
 * The plan's S1 criterion 2 has two halves, and they land at different times:
 *
 *  - **now**: all three role-session paths call `buildRoleSession`, and
 *    `ctx.agents.resume(` exists in exactly one place — inside that function, in
 *    `src/a2a.ts`. (`src/a2a-transport.ts` still owns its own `resume`; that is
 *    S2's, and the全仓 form of this criterion only holds once S2 lands.)
 *  - **after S2**: the repository-wide "only one call site" form.
 *
 * This file asserts the "now" form and labels it as such, so nobody can read it
 * as the S2 form.
 *
 * ## Why it is built from two halves
 *
 * The three paths can only be driven for real inside a live DSH (they provision
 * sessions, presets and approvals), so a purely behavioural test would need a
 * fixture harness that would itself be the thing under test. Instead:
 *
 *  - **behaviourally**, `buildRoleSession` is driven through its three spec shapes
 *    against a recording context, asserting which engine primitive each shape
 *    reaches (`agents.create` vs `agents.resume`). This is what makes it the
 *    single funnel: a path that bypassed it would reach the engine some other way.
 *  - **structurally**, the three call sites in `src/orchestra.ts` are read and
 *    asserted to spell `buildRoleSession(` rather than the primitives, and the
 *    primitive count is asserted. Without this half the test would pass on a
 *    tree where nothing calls the entry point at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRoleSession } from "../lib/a2a.js";
import { createActiveTeamStateStore } from "../lib/orchestra-state.js";
import { PINNED_APPROVAL } from "../lib/session-blueprint.js";
import { addLanesToTeam } from "../lib/orchestra.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function session(id, cwd = "/role-workspace") {
  return {
    id,
    header: { id, cwd, agentPreset: "preset" },
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

/**
 * A recording context. `calls` is the point of the whole file: it records WHICH
 * engine primitive each spec shape reaches, so a shape that silently stopped
 * going through the entry point would show up as a missing or misrouted call.
 */
function recordingContext() {
  const calls = [];
  const agents = new Map();
  const sessions = new Map();
  const ctx = {
    calls,
    agents: {
      get: (id) => agents.get(String(id)),
      list: () => [...agents.values()],
      async create(options) {
        calls.push({ primitive: "agents.create", options });
        const target = session(String(options.sessionId));
        sessions.set(target.id, target);
        const agent = { id: target.id, session: target, status: "idle" };
        agents.set(target.id, agent);
        return { agent, async dispose() { agents.delete(target.id); } };
      },
      async resume(options) {
        calls.push({ primitive: "agents.resume", options });
        return {};
      },
    },
    sessions: { get: (id) => sessions.get(String(id)) },
    get: () => undefined,
  };
  return { ctx, calls };
}

// ---------------------------------------------------------------------------
// Behavioural half: the entry point funnels on to the right engine primitive
// ---------------------------------------------------------------------------

test("S1: buildRoleSession routes each spec shape to the engine primitive it declares", async () => {
  // `kind: "resume"` must reach `agents.resume` and only that.
  {
    const { ctx, calls } = recordingContext();
    const result = await buildRoleSession(ctx, {
      kind: "resume",
      sessionId: "role-A",
      agentOptions: { provider: "p", model: "m" },
    });
    assert.equal(result.sessionId, "role-A");
    assert.deepEqual(calls.map((entry) => entry.primitive), ["agents.resume"]);
    assert.equal(String(calls[0].options.resumeSessionId), "role-A");
    assert.deepEqual(calls[0].options.agentOptions, { provider: "p", model: "m" });
  }

  // `kind: "create"` with `mode: "governed"` must reach `agents.create` carrying
  // the prepared blueprint, and must surface the receipt AND the handle — the
  // handle is what the first-wave rollback path needs.
  {
    const { ctx, calls } = recordingContext();
    const blueprint = {
      agentOptions: { provider: "p", model: "m" },
      setup: async () => {},
      receipt: { mode: "governed", sessionId: "role-B", agentPreset: "orchestra-v04-implementer-v1" },
      meta: { cwd: "/role-workspace", agentPreset: "orchestra-v04-implementer-v1" },
    };
    const result = await buildRoleSession(ctx, {
      kind: "create",
      mode: "governed",
      sessionId: "role-B",
      cwd: "/role-workspace",
      governedBlueprint: blueprint,
      returnHandle: true,
    });
    assert.deepEqual(calls.map((entry) => entry.primitive), ["agents.create"]);
    assert.equal(result.sessionId, "role-B");
    assert.notEqual(result.governedReceipt, undefined, "the governed receipt must survive the funnel");
    assert.notEqual(result.handle, undefined, "the first-wave handle must survive the funnel");
  }

  // Omitting `returnHandle` must NOT produce a handle: the lazy and reactivation
  // paths do not collect one, and silently adding it would change their contract.
  {
    const { ctx } = recordingContext();
    const result = await buildRoleSession(ctx, {
      kind: "create",
      mode: "governed",
      sessionId: "role-C",
      governedBlueprint: {
        sessionId: "role-C",
        agentOptions: {},
        setup: async () => {},
        receipt: { mode: "governed", sessionId: "role-C", agentPreset: "p" },
        meta: { cwd: "/w", agentPreset: "p" },
      },
    });
    assert.equal(result.handle, undefined);
  }
});

// ---------------------------------------------------------------------------
// Structural half: the S1 call sites, read from source
// ---------------------------------------------------------------------------

test("S1 (now-form): the three role-session paths call buildRoleSession, and orchestra.ts owns no resume", async () => {
  const orchestra = await readFile(join(REPO, "src", "orchestra.ts"), "utf8");
  const a2a = await readFile(join(REPO, "src", "a2a.ts"), "utf8");

  // 1. `agents.resume(` is gone from orchestra.ts entirely: both the lazy-fallback
  //    resume and the reactivation resume wrapper now funnel through the entry.
  const orchestraResumes = orchestra.split("\n").filter((line) => /agents\.resume\(/.test(line) && !line.trimStart().startsWith("//"));
  assert.deepEqual(orchestraResumes, [], "orchestra.ts must not call agents.resume directly");

  // 2. In a2a.ts it appears exactly once as a CALL (the other hits are prose).
  const a2aResumeCalls = a2a.split("\n").filter((line) => /^\s*await ctx\.agents\.resume\(/.test(line));
  assert.equal(a2aResumeCalls.length, 1, "a2a.ts must call agents.resume exactly once, inside buildRoleSession");

  // 3. All three paths spell the entry point. The first wave and the reactivation
  //    replacement create governed sessions; the lazy fallback and the
  //    reactivation resume use kind:"resume" / the plain create shape.
  // FOUR call sites across the three paths, because the lazy path has two: the
  // create attempt and the `already exists` resume fallback.
  //   2497 first wave (governed create)      3069 lazy create
  //   3090 lazy resume fallback              3575 reactivation replacement create
  const orchestrasEntryPoints = orchestra.split("\n").filter((line) => /await (createRoleSession|buildRoleSession)\(ctx, \{/.test(line));
  assert.equal(orchestrasEntryPoints.length, 4, `expected 4 role-session call sites, found ${orchestrasEntryPoints.length}`);
  // No other way into a session may exist here.
  assert.deepEqual(
    orchestra.split("\n").filter((line) => /await createSession\(ctx, \{/.test(line)),
    [],
    "orchestra.ts must not call createSession directly — that would bypass the entry point",
  );
  // `createRoleSession` in orchestra.ts must itself be defined BY the entry point,
  // never by `createSession` — that is the difference between "funnels" and "used to funnel".
  const seam = orchestra.split("\n").find((line) => line.includes("const createRoleSession ="));
  assert.notEqual(seam, undefined, "the reactivation seam must still exist for the recovery test");
  assert.match(seam, /buildRoleSession/, "the reactivation seam must default to buildRoleSession, not createSession");

  // 4. The first-wave path must request the handle (it is the rollback owner).
  assert.ok(orchestra.includes("returnHandle: true"), "the first wave must still collect its rollback handle");
});

test("S1: the S2 boundary is stated, not silently assumed", async () => {
  // This test exists so the "全仓 one call site" form cannot be read as already
  // satisfied. When S2 lands, this assertion flips and the file gets updated.
  const transport = await readFile(join(REPO, "src", "a2a-transport.ts"), "utf8");
  const transportResumes = transport.split("\n").filter((line) => /await ctx\.agents\.resume\(/.test(line));
  assert.equal(
    transportResumes.length,
    1,
    "S2 has NOT landed: a2a-transport.ts still owns its own resume. The repo-wide 'exactly one call site' form of S1 criterion 2 is therefore NOT satisfied yet, and this test says so on purpose.",
  );
});

// ---------------------------------------------------------------------------
// D2-a: every build path pins the approval policy, and none double-pins it.
// ---------------------------------------------------------------------------

/**
 * A context whose factory honours the `AgentSetup` contract: setup runs on the
 * unpublished agent, then `commit()` is invoked, then the session is published.
 *
 * `recordingContext` above deliberately does NOT call setup — it is a routing
 * test. The pin cannot be observed there, so this double is the faithful one.
 */
function publishingContext() {
  const sessions = new Map();
  const agents = new Map();
  const policies = (id) =>
    (sessions.get(id)?.snapshotEvents() ?? []).filter((event) => event.type === "approval/policy").map((event) => event.data.policy);
  const ctx = {
    sessions: { get: (id) => sessions.get(String(id)) },
    agents: {
      get: (id) => agents.get(String(id)),
      async create(options) {
        const id = String(options.sessionId);
        const session = {
          id,
          events: [],
          header: { id, cwd: "/role-workspace" },
          snapshotEvents() {
            return this.events;
          },
          append(type, data) {
            this.events.push({ type, data });
          },
        };
        sessions.set(id, session);
        const child = { ...ctx, agentId: id, on: () => () => {} };
        const commit = await options.setup?.(child, { id, session });
        commit?.commit?.();
        agents.set(id, { id, session });
        return { agent: agents.get(id), async dispose() {} };
      },
      async resume(options) {
        const id = String(options.resumeSessionId);
        const session = sessions.get(id) ?? {
          id,
          events: [],
          header: { id, cwd: "/role-workspace" },
          snapshotEvents() {
            return this.events;
          },
          append(type, data) {
            this.events.push({ type, data });
          },
        };
        sessions.set(id, session);
        const child = { ...ctx, agentId: id, on: () => () => {} };
        await options.setup?.(child, { id, session });
        return { agent: { id, session }, async dispose() {} };
      },
    },
    get(name) {
      if (name === "agentPresets") {
        return {
          async resolve(id) {
            return { id };
          },
          async mount(agentCtx, id) {
            agentCtx.composedPreset = id;
          },
          composedPreset(agentCtx) {
            return agentCtx.composedPreset;
          },
        };
      }
      if (name === "permissionPresets") {
        return { defaultPreset: "workspace", resolve: () => ({ sandbox: "workspace-write", approval: "ask" }), set: () => {}, current: () => "workspace" };
      }
      if (name === "tools") return { schemas: () => ["read", "write", "bash", "glob", "grep", "orchestra_report"].map((tool) => ({ name: tool, description: tool, parameters: {} })) };
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      return undefined;
    },
  };
  return { ctx, policies };
}

test("D2-a: every build path pins approval to never, and the governed path pins it once", async () => {
  // Lazy materialization: a plain preset create with no Blueprint at all — the
  // path that used to inherit the deployment default (`ask`).
  {
    const { ctx, policies } = publishingContext();
    await buildRoleSession(ctx, { kind: "create", sessionId: "role-lazy", cwd: "/role-workspace", presetId: "orchestra-v04-reviewer-v1" });
    assert.deepEqual(policies("role-lazy"), ["never"], "the lazy path must pin the policy");
  }

  // Lightweight (a2a_create): same requirement, different plane.
  {
    const { ctx, policies } = publishingContext();
    await buildRoleSession(ctx, {
      kind: "create",
      mode: "lightweight",
      sessionId: "role-light",
      cwd: "/role-workspace",
      presetId: "orchestra-v04-reviewer-v1",
      caller: { id: "driver", ctx: {}, options: {} },
    });
    assert.deepEqual(policies("role-light"), ["never"], "the lightweight path must pin the policy");
  }

  // Reactivation resume with NO setup of its own: nothing else would pin it.
  {
    const { ctx, policies } = publishingContext();
    await buildRoleSession(ctx, { kind: "resume", sessionId: "role-resumed" });
    assert.deepEqual(policies("role-resumed"), ["never"], "a bare resume must pin the policy");
  }

  // Reactivation resume WITH a caller setup: the composition work still runs.
  {
    const { ctx, policies } = publishingContext();
    const ran = [];
    await buildRoleSession(ctx, {
      kind: "resume",
      sessionId: "role-resumed-2",
      setup: async () => {
        ran.push("caller");
      },
    });
    assert.deepEqual(policies("role-resumed-2"), ["never"]);
    assert.deepEqual(ran, ["caller"], "composing the pin must not replace the caller's setup");
  }

  // Governed: the Blueprint's own setup already pins, so the fold must absorb it
  // rather than appending a second identical event.
  {
    const { ctx, policies } = publishingContext();
    const blueprint = {
      sessionId: "role-governed",
      agentOptions: {},
      meta: { cwd: "/role-workspace", agentPreset: "p" },
      receipt: { mode: "governed", sessionId: "role-governed", agentPreset: "p" },
      setup: async () => ({ commit() {} }),
    };
    await buildRoleSession(ctx, { kind: "create", mode: "governed", sessionId: "role-governed", cwd: "/role-workspace", governedBlueprint: blueprint });
    assert.deepEqual(policies("role-governed"), ["never"], "exactly one policy event, not two");
  }
});
// ---------------------------------------------------------------------------
// 裁定 AH: the record DECLARES the approval policy every path pins, without
// overwriting the permission preset's own declared value.
// ---------------------------------------------------------------------------

/** A minimal in-memory fs port: enough of the contract for the team store. */
function memoryFs() {
  const files = new Map();
  return {
    files,
    async resolve(path, options = {}) {
      return { key: `${options.cwd ?? ""}:${path}`, displayPath: `${options.cwd ?? ""}/${path}` };
    },
    processPath: (target) => target.displayPath,
    async stat(target) {
      const file = files.get(target.key);
      return file === undefined ? undefined : { type: "file", size: file.content.length, version: file.version };
    },
    async readText(target) {
      const file = files.get(target.key);
      if (file === undefined) throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
      return file.content;
    },
    async writeText(target, content, expected) {
      const current = files.get(target.key);
      if (expected?.kind === "createIfAbsent" && current !== undefined) {
        throw Object.assign(new Error("exists"), { code: "FS_NOT_OBSERVED" });
      }
      if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
        throw Object.assign(new Error("stale"), { code: "FS_STALE_VERSION" });
      }
      const version = `v${files.size + 1}`;
      files.set(target.key, { content, version });
      return { operation: current === undefined ? "create" : "update", version, before: current?.content ?? null, after: content };
    },
  };
}

test("裁定 AH: a reserved record declares the pinned approval without overwriting the preset's declared value", async () => {
  const { ctx, policies } = publishingContext();
  ctx.fs = memoryFs();
  ctx.sandboxPolicy = { resolve: () => ({}) };
  const store = createActiveTeamStateStore(ctx.fs);
  const controller = { id: "driver", session: { header: { cwd: "/role-workspace" } }, options: {} };
  await store.create(
    "/role-workspace",
    {
      schemaVersion: 1,
      teamId: "team-pinned",
      status: "active",
      rootCwd: "/role-workspace",
      controllerSessionId: "driver",
      controllerHistory: [],
      topologyRef: { id: "duo", source: "bundled" },
      mission: { objective: "o", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
      createdAt: 1,
      activatedFromArchiveId: null,
      // A team with no role at all is not a recoverable team, so the store blocks
      // it; the lane under test is added on top of one live seat.
      roles: [{ id: "worker", name: "Worker", sessionId: "session-worker", phase: "active", execution: "session", sessionHistory: [], preset: "orchestra-v04-reviewer-v1", sandbox: "read-only", reportCount: 1, lastReport: null }],
      reports: [],
    },
    { policy: {} },
  );

  const added = await addLanesToTeam(ctx, store, { agent: controller }, {
    roles: [{ roleId: "reviewer", preset: "orchestra-v04-reviewer-v1", sandbox: "read-only" }],
    confirm: true,
  });
  assert.equal(added.status, "added");

  const observed = await store.read("/role-workspace");
  assert.equal(observed.kind, "ready");
  const record = observed.team.roles.find((role) => role.id === "reviewer").blueprint;
  assert.notEqual(record, undefined, "a session role's reservation carries a blueprint record");

  // Two different facts, both preserved: the permission preset declares `ask`,
  // and the plugin declares that it pins the session to `never`. Overwriting one
  // with the other is what made §4.8 D2-a step 1 / E1's literal criterion miss.
  assert.equal(record.approval, "ask", "the permission preset's declared value survives untouched");
  assert.equal(record.pinnedApproval, PINNED_APPROVAL, "the record declares what the plugin pins");
  assert.notEqual(record.pinnedApproval, record.approval, "the declaration and the preset value are distinct facts");

  // And the declaration is not decorative: every build path pins exactly it.
  const shapes = [
    { name: "governed", spec: { kind: "create", mode: "governed", sessionId: "pinned-governed", cwd: "/role-workspace", governedBlueprint: { sessionId: "pinned-governed", agentOptions: {}, meta: { cwd: "/role-workspace", agentPreset: "orchestra-v04-reviewer-v1" }, receipt: { mode: "governed", sessionId: "pinned-governed", agentPreset: "orchestra-v04-reviewer-v1" }, setup: async () => ({ commit() {} }) } } },
    { name: "lazy", spec: { kind: "create", sessionId: "pinned-lazy", cwd: "/role-workspace", presetId: "orchestra-v04-reviewer-v1" } },
    { name: "lightweight", spec: { kind: "create", mode: "lightweight", sessionId: "pinned-light", cwd: "/role-workspace", presetId: "orchestra-v04-reviewer-v1", caller: { id: "driver", ctx: {}, options: {} } } },
    { name: "resume", spec: { kind: "resume", sessionId: "pinned-resume" } },
  ];
  for (const shape of shapes) {
    const built = publishingContext();
    await buildRoleSession(built.ctx, shape.spec);
    assert.deepEqual(built.policies(shape.spec.sessionId), [PINNED_APPROVAL], `${shape.name} pins the declared policy`);
  }
  void policies;
});
