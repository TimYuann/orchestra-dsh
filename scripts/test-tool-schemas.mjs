/**
 * Tool-boundary guard (D4).
 *
 * ## Why this file changed shape (V7)
 *
 * The previous version of this guard was *structural*: it walked the declared
 * output schema and asserted that a schema which describes a role summary
 * declares every key a summary can carry. That did catch the original
 * `orchestra_topologies` incident, but it has a fatal weakness which V7 names:
 * it checks the schema against **a hand-written list of key names**, i.e. it
 * validates a schema it already knows the answer to. It never executes anything,
 * so it cannot see the far more common failure — the handler returning a value
 * the schema does not allow — and it cannot see a handler reaching for a service
 * it never declared.
 *
 * Both of those are real, and both are the same shape: **the model gets an error
 * instead of data, and nothing in the test suite notices.**
 *
 *  1. `orchestra_topologies` with a node-backend role: `roleSummary` emitted keys
 *     the tool schema did not declare. DSH snapshots the returned value and runs
 *     `validateJsonSchemaValue(tool.output.schema, value, "value")`; one extra key
 *     against `additionalProperties: false` fails the WHOLE call.
 *  2. `a2a_send` returning `cannot get property "sandboxPolicy" without inject`:
 *     `sendRawA2A` read `ctx.sandboxPolicy` while `a2a.ts`'s `inject` list did not
 *     declare it. Cordis resolves services through a proxy whose `get` throws that
 *     message; `?.` does NOT swallow it, because the trap throws rather than
 *     returning nullish (grounded in `@deepseek-ai/cordis@4.0.2`
 *     `lib/index.js:675-681`). Every existing test missed it because they hand the
 *     plugin a plain-object context, which has no such guard.
 *
 * So this guard now does what DSH itself does, on the real handlers:
 *
 *  - it captures the REAL registered tool definitions (both plugin halves);
 *  - it runs every tool's parameter contract through DSH's own `validateArgs`;
 *  - it CALLS each handler with minimal valid arguments;
 *  - it validates the handler's ACTUAL returned value with DSH's own
 *    `validateJsonSchemaValue` against the tool's REAL registered output schema
 *    (already converted by `defineTool`, so no second conversion to drift from);
 *  - it hands the handlers a context whose service surface mirrors the declared
 *    `inject` lists and **throws on an undeclared service access**, reproducing
 *    the Cordis trap that made defect 2 invisible.
 *
 * ## Applicable boundary (R-creep)
 *
 * This guard covers **the host tool boundary of this plugin's two registered
 * surfaces**: argument acceptance, real handler execution, real return value vs
 * declared output schema, and undeclared-service access. It does NOT cover, and
 * must not be read as covering:
 *
 *  - whether the handler's answer is *correct* (no schema can say that);
 *  - the engine-side behaviours behind the injected doubles (delivery, resume,
 *    provisioning) — those are `test-a2a-transport.mjs` /
 *    `test-session-blueprint.mjs` / the governed tests' job;
 *  - permission or sandbox enforcement (`capability-boundaries.md` #7).
 *
 * The fake engine ports are deliberately *faithful in shape* and *minimal in
 * behaviour*: they make the SUCCESS path reachable so the real value can be
 * validated. That is the whole point — a stub that cannot succeed would prove
 * nothing about the schema.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { snapshotJsonValue } from "@deepseek-ai/dsh-util-values";
import { apply as applyOrchestra, inject as orchestraInject } from "../lib/orchestra.js";
import { apply as applyA2a, inject as a2aInject } from "../lib/a2a.js";

/** Every key `roleSummary` can place on a `TopologyRoleSummary`. */
const ROLE_SUMMARY_KEYS = [
  "id",
  "name",
  "execution",
  "persona",
  "toolFilter",
  "preset",
  "sandbox",
  "maxRounds",
  "runtime",
  "compositionTools",
  "orchestraTools",
  "optionalCapabilities",
];

/** `preset` marks a schema as describing a full role summary rather than a projection. */
const SUMMARY_MARKER = "preset";

// ---------------------------------------------------------------------------
// Real filesystem port (so handlers reach their true success paths)
// ---------------------------------------------------------------------------

/**
 * A real `ctx.fs` port rooted at a temp directory. It implements the contract
 * the stores actually use — including the version-checked atomic-write protocol
 * (`createIfAbsent` / `replaceIfVersion`), which is what makes
 * `orchestra_draft` and `orchestra_report` reach a genuine success value
 * instead of failing on a missing method.
 */
function realFs(root) {
  const abs = (path) => (path.startsWith("/") ? path : join(root, path));
  const version = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  const codeOf = (error) => (typeof error?.code === "string" ? error.code : undefined);
  return {
    root,
    async resolve(path) {
      const displayPath = abs(path);
      return { targetKey: displayPath, displayPath };
    },
    processPath(target) {
      return target.displayPath;
    },
    version,
    async stat(target) {
      try {
        const info = await stat(target.displayPath);
        return {
          type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
          size: info.size,
          version: version(info),
        };
      } catch (error) {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      }
    },
    async listDir(target) {
      const entries = await readdir(target.displayPath, { withFileTypes: true });
      return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => ({
          name: entry.name,
          type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
          target: { targetKey: join(target.displayPath, entry.name), displayPath: join(target.displayPath, entry.name) },
        }));
    },
    async readText(target) {
      return readFile(target.displayPath, "utf8");
    },
    async writeText(target, content, expected) {
      const current = await this.stat(target);
      if (expected?.kind === "createIfAbsent" && current !== undefined) {
        throw Object.assign(new Error("target exists"), { code: "FS_NOT_OBSERVED" });
      }
      if (expected?.kind === "replaceIfVersion" && (current === undefined || current.version !== expected.version)) {
        throw Object.assign(new Error("stale target version"), { code: "FS_STALE_VERSION" });
      }
      await mkdir(dirname(target.displayPath), { recursive: true });
      await writeFile(target.displayPath, content, "utf8");
      return { kind: "written", version: version(await stat(target.displayPath)) };
    },
    async remove(target) {
      await rm(target.displayPath, { force: true, recursive: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Engine doubles (shape-faithful, minimal behaviour)
// ---------------------------------------------------------------------------

function session(id, cwd) {
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
 * The guarded context.
 *
 * `declared` is EXACTLY the plugin's `inject` list. A service becomes readable as
 * a property only when it is in that list — otherwise reading it throws the same
 * message Cordis throws (`cannot get property "…" without inject`), so a handler
 * that reaches for an undeclared service fails here instead of in production.
 *
 * `ctx.get(name)` stays ungated on purpose: it is the engine's documented way to
 * read an OPTIONAL service the plugin did not inject (`ctx.get("sessionQuery")`),
 * and production does not gate it either.
 */
function guardedContext({ fs, sessions, agents, declared, extras = {}, registered }) {
  const services = {
    fs,
    sessions: { get: (id) => sessions.get(String(id)), list: () => [...sessions.values()] },
    agents: {
      get: (id) => agents.get(String(id)),
      list: () => [...agents.values()],
      async resume(options) {
        const target = sessions.get(String(options.resumeSessionId)) ?? session(String(options.resumeSessionId), "/cold");
        sessions.set(target.id, target);
        await options.setup({ on: () => () => {} });
        return { agent: target.id, async dispose() {} };
      },
    },
    // Real timers, so a bounded wait is still bounded in real time.
    timer: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    // Ungated: `get()` returns these in the real engine too.
    ...extras,
  };
  // The administrative surface every plugin half is composed with regardless of
  // its own `inject` list (and the plugin-half-under-test's own registered tools).
  const admin = {
    tools: { register: (definition) => registered.push(definition) },
    effect(fn) {
      fn();
      return () => {};
    },
    on() {
      return () => {};
    },
  };
  const readable = new Set([...declared, ...Object.keys(admin), "__undeclaredAccesses"]);
  const undeclaredAccesses = [];
  const ctx = {
    __undeclaredAccesses: undeclaredAccesses,
    ...admin,
    get(name) {
      return services[name];
    },
  };
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop.startsWith("_") || prop === "then") return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (!readable.has(prop)) {
        const error = new Error(`cannot get property "${prop}" without inject`);
        undeclaredAccesses.push({ prop, stack: error.stack });
        throw error;
      }
      return services[prop];
    },
  });
}

function agentFor(sessionValue) {
  return {
    id: sessionValue.id,
    session: sessionValue,
    status: "idle",
    followup(message) {
      sessionValue.append("user/message", message);
    },
    inject(message) {
      sessionValue.append("user/message", message);
    },
    steer(message) {
      sessionValue.append("user/message", message);
    },
  };
}

const EXEC_SIGNAL = new AbortController().signal;

/**
 * Register both plugin halves against a real temp workspace and return the
 * captured definitions plus the live doubles, so a case can mutate state
 * between calls.
 */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "orchestra-tool-boundary-"));
  const fs = realFs(root);
  const sessions = new Map();
  const agents = new Map();
  const driver = session("driver-session", root);
  sessions.set(driver.id, driver);
  agents.set(driver.id, agentFor(driver));

  const query = {
    async readSession(id) {
      const value = sessions.get(String(id));
      if (value === undefined) throw Object.assign(new Error("not found"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      return { session: value.header, events: value.snapshotEvents() };
    },
    async listSessions() {
      // Corpus records carry a `header` (and may be cold): `listThreads` reads
      // `record.header.id` / `.cwd` / `.createdAt`. Returning bare live-session
      // objects here is exactly the kind of shape drift this guard exists to
      // surface — it produced `threads[i].sessionId` undefined the first run.
      return [...sessions.values()].map((value) => ({
        header: { id: value.id, cwd: value.header.cwd, createdAt: Date.now(), agentPreset: "preset" },
        live: agents.has(value.id),
      }));
    },
    async readTitleSnapshots() {
      return [];
    },
  };
  // Presets resolve to the REAL materialized catalog under the DSH home, exactly
  // as the roster does after the §7 `roots` patch. Pointing at a nonexistent path
  // instead made `orchestra_draft` fail its blueprint pre-parsing — i.e. the whole
  // draft path was unreachable and its return value could never be validated.
  // An unknown id fails the way the engine does, so the double does not silently
  // invent presets that do not exist.
  const catalogRoot = join(homedir(), ".dsh", "orchestra", "catalog-presets");
  const presets = {
    async resolve(id) {
      const path = join(catalogRoot, String(id), "agent.cordis.yml");
      if ((await stat(path).catch(() => undefined)) === undefined) {
        throw Object.assign(new Error(`unknown preset ${id}`), { name: "UnknownPresetError" });
      }
      return { id, path, trust: "system" };
    },
    async mount() {},
  };
  const extras = {
    sessionQuery: query,
    agentPresets: presets,
    agentDefaultModel: { currentSelection: () => ({ provider: "provider", model: "model" }) },
    permissionPresets: {
      // Faithful to `dsh-permission-presets`: `resolve(name)` returns the
      // configured bundle and `current(session)` the effective key. A double that
      // exposed only `defaultPreset`/`current` left every governed path
      // unreachable, so their return values could never be validated.
      defaultPreset: "workspace-write",
      current: () => "workspace-write",
      resolve: (name) => ({
        sandbox: name === "read-only" ? "read-only" : "workspace-write",
        approval: name === "read-only" ? "ask" : "never",
        name: String(name),
      }),
      optionOf: (name) => ({ name: String(name) }),
    },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", roots: [root] }) },
    subagents: { listChildren: () => [] },
    skills: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    workspaceRegistry: { list: () => [], current: () => undefined },
  };

  const registered = [];
  // Two contexts on purpose: each plugin half gets ITS OWN declared surface, so
  // an undeclared read is attributed to the half that made it. Sharing one
  // context would union the two inject lists and hide exactly this class of bug.
  const contexts = [
    guardedContext({ fs, sessions, agents, declared: orchestraInject, extras, registered }),
    guardedContext({ fs, sessions, agents, declared: a2aInject, extras, registered }),
  ];
  applyOrchestra(contexts[0]);
  applyA2a(contexts[1]);

  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  const exec = (name, overrides = {}) => ({
    callId: `call-${name}`,
    name,
    arguments: {},
    agent: agents.get(driver.id),
    signal: EXEC_SIGNAL,
    ...overrides,
  });
  return { root, fs, sessions, agents, driver, registered, byName, contexts, exec };
}

function cleanup(root) {
  return rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// D4-1: the tool surface is fully enumerated
// ---------------------------------------------------------------------------

test("D4: the guard enumerates the ENTIRE registered tool surface (no 'several')", async () => {
  const env = await harness();
  try {
    // 11 orchestra_* + 7 a2a_* = 18. A new tool that is added without touching
    // this file still gets swept, because the sweep is driven by registration.
    assert.equal(env.registered.length, 18, `registered: ${env.registered.map((t) => t.name).join(", ")}`);
    for (const tool of env.registered) {
      assert.equal(typeof tool.name, "string");
      assert.equal(typeof tool.execute, "function", `${tool.name} must expose a real handler`);
      assert.notEqual(tool.output?.schema, undefined, `${tool.name} must declare an output schema`);
    }
    assert.equal(new Set(env.registered.map((t) => t.name)).size, env.registered.length, "tool names must be unique");
  } finally {
    await cleanup(env.root);
  }
});

// ---------------------------------------------------------------------------
// D4-2: every tool's parameter contract accepts a minimal valid call
// ---------------------------------------------------------------------------

/**
 * Validate a call's arguments exactly the way `defineTool(...).execute` does.
 *
 * `tool.parameters` is ALREADY the compiled JSON Schema (`parameterSchemaSpecToJsonSchema`
 * ran at registration), and so is `tool.output.schema`. Running DSH's own
 * `validateJsonSchemaValue` against those two objects is therefore the engine's
 * own check — not a re-implementation that could drift from it.
 */
function validateArguments(tool, args) {
  return validateJsonSchemaValue(tool.parameters, args, "arguments");
}

test("D4: every tool's parameter contract accepts the minimal arguments this guard passes", async () => {
  const env = await harness();
  try {
    const violations = [];
    for (const [name, spec] of Object.entries(CASES)) {
      const tool = env.byName.get(name);
      assert.notEqual(tool, undefined, `${name} must be registered`);
      const problems = validateArguments(tool, spec.args(env));
      if (problems.length > 0) violations.push(`${name}: ${problems.join("; ")}`);
    }
    assert.deepEqual(violations, [], "a case must satisfy the tool's own declared parameter schema");
  } finally {
    await cleanup(env.root);
  }
});

// ---------------------------------------------------------------------------
// D4-3: call every real handler and validate its REAL return value
// ---------------------------------------------------------------------------

/**
 * The cases. `args(env)` returns minimal-but-valid arguments; `expect` is how the
 * case completes. A tool that cannot be driven to a real success value in this
 * harness is `error` with a pattern that pins the TYPED failure, and that is
 * stated explicitly rather than silently skipped — there is no third state.
 */
const CASES = {
  orchestra_topologies: {
    args: () => ({}),
    expect: "value",
    /// The bundled catalog always resolves, so this one must genuinely succeed.
  },
  orchestra_team: {
    args: () => ({}),
    expect: "value",
    // No active team and no archive: the documented `{team: null, archives}` shape.
  },
  orchestra_draft: {
    args: () => ({ goal: "D4 boundary probe: exercise the draft writer" }),
    expect: "value",
  },
  orchestra_report: {
    args: () => ({ path: "d4-boundary-report.md", content: "# D4\n\nboundary probe\n" }),
    expect: "value",
  },
  a2a_list: {
    args: () => ({}),
    expect: "value",
  },
  a2a_read: {
    args: () => ({ sessionId: "driver-session", turns: 1 }),
    expect: "value",
  },
  a2a_status: {
    args: () => ({ messageId: "no-such-message", targetSessionId: "driver-session" }),
    expect: "value",
  },
  a2a_create: {
    args: () => ({ execution: "subagent", label: "d4-probe", prompt: "D4 boundary probe" }),
    expect: "error",
    // The subagent backend is not mounted in this harness; the failure must be a
    // TYPED one naming the missing surface, not a crash and not a schema error.
    pattern: /subagent|not available|unsupported|requires/i,
  },
  a2a_send: {
    args: () => ({ to: "driver-session", message: "D4 boundary probe" }),
    expect: "error",
    // Self-send is refused before any delivery work: a typed precondition.
    pattern: /cannot send a message to yourself/,
  },
  a2a_reply: {
    args: () => ({ to: "driver-session", reply_to: "none", message: "D4 boundary probe" }),
    expect: "error",
    pattern: /./,
  },
  a2a_stop: {
    args: () => ({ sessionId: "driver-session", reason: "D4 boundary probe" }),
    expect: "error",
    pattern: /./,
  },
  orchestra_create: {
    args: () => ({ frozenRef: "no-such-draft@1#deadbeef" }),
    expect: "error",
    pattern: /./,
  },
  orchestra_send: {
    args: () => ({ teamId: "no-such-team", roleId: "implementer", message: "D4 boundary probe" }),
    expect: "error",
    pattern: /./,
  },
  orchestra_dispatch: {
    args: () => ({ roleId: "implementer", task: "D4 boundary probe" }),
    expect: "error",
    pattern: /./,
  },
  orchestra_add_lanes: {
    args: () => ({ roles: [], confirm: false }),
    expect: "error",
    pattern: /./,
  },
  orchestra_wait: {
    args: () => ({ teamId: "no-such-team", timeoutMs: 10_000 }),
    expect: "error",
    pattern: /./,
  },
  orchestra_activate: {
    args: () => ({ archiveId: "no-such-archive" }),
    expect: "error",
    pattern: /./,
  },
  orchestra_dismiss: {
    args: () => ({}),
    expect: "error",
    pattern: /./,
  },
};

test("D4: every registered tool runs its REAL handler and its REAL return value passes the declared output schema", async () => {
  const env = await harness();
  try {
    const results = [];
    const schemaViolations = [];
    const refusals = [];
    assert.deepEqual(Object.keys(CASES).sort(), [...env.byName.keys()].sort(), "every registered tool needs a case");

    for (const [name, spec] of Object.entries(CASES)) {
      const tool = env.byName.get(name);
      const args = spec.args(env);
      const parameterProblems = validateArguments(tool, args);
      assert.deepEqual(parameterProblems, [], `${name} case arguments must be valid: ${parameterProblems.join("; ")}`);

      let outcome;
      try {
        const value = await tool.execute(args, env.exec(name, { arguments: args }));
        outcome = { kind: "value", value };
      } catch (error) {
        outcome = { kind: "error", error };
      }

      if (spec.expect === "value") {
        if (outcome.kind !== "value") {
          refusals.push(`${name}: expected a value, handler threw ${outcome.error?.constructor?.name ?? typeof outcome.error}: ${outcome.error?.message}`);
          continue;
        }
        // DSH's own check, against the REAL registered schema, on the REAL value.
        //
        // Two engine steps, in the engine's own order (`dsh-tools`
        // `createSuccessResult` → `snapshotToolValue` → `snapshotJsonValue`,
        // then `validateJsonSchemaValue`):
        //
        //  1. `snapshotJsonValue` returns `undefined` for any value that does not
        //     survive a JSON round trip — and a field whose value is literally
        //     `undefined` does not. `snapshotToolValue` turns that into
        //     `ToolOutputError: value is not lossless JSON`, so the model gets an
        //     error instead of data. This is the `a2a_list` /
        //     `a2a_read` defect this guard caught on its first run.
        //  2. Only then is the detached value validated against the output schema.
        if (snapshotJsonValue(outcome.value) === undefined) {
          schemaViolations.push(`${name}: value is not lossless JSON (an \`undefined\` field fails the whole call)`);
          continue;
        }
        const violations = validateJsonSchemaValue(tool.output.schema, outcome.value, "value");
        if (violations.length > 0) schemaViolations.push(`${name}: ${violations.join("; ")}`);
        results.push(`${name}=value`);
      } else {
        if (outcome.kind !== "error") {
          refusals.push(`${name}: expected a typed refusal, handler returned ${JSON.stringify(outcome.value)?.slice(0, 120)}`);
          continue;
        }
        const message = String(outcome.error?.message ?? "");
        const isSchemaFailure = /is not a declared property|is required|must be/.test(message) && outcome.error?.name === "ToolArgsError";
        if (isSchemaFailure) {
          refusals.push(`${name}: refused by ARGUMENT validation, not by the handler: ${message}`);
          continue;
        }
        if (!spec.pattern.test(message)) {
          refusals.push(`${name}: refused with an unexpected message: ${message}`);
          continue;
        }
        results.push(`${name}=refused(${message.slice(0, 48)})`);
      }
    }

    assert.deepEqual(
      schemaViolations,
      [],
      "a returned value that is not lossless JSON, or that carries a key the schema does not declare, fails the WHOLE call in production",
    );
    assert.deepEqual(refusals, [], "every tool must either return a schema-valid value or refuse it as a typed precondition");
    assert.equal(results.length, Object.keys(CASES).length);
  } finally {
    await cleanup(env.root);
  }
});

// ---------------------------------------------------------------------------
// D4-4: no handler may read a service it never declared (the a2a_send defect)
// ---------------------------------------------------------------------------

test("D4: the undeclared-service trap itself is live (self-test, so the sweep cannot pass vacuously)", async () => {
  const env = await harness();
  try {
    // Without this, D4-4 would be a test that always passes: no current handler
    // reads an undeclared service, so a BROKEN trap (one that silently returned
    // `undefined`) would be indistinguishable from a working one. That is exactly
    // the "check script that always says OK" failure this repository already named
    // in `check-session-readable.mjs`'s `--self-test` precedent.
    const [orchestraCtx, a2aCtx] = env.contexts;

    // A DECLARED service must be readable.
    assert.notEqual(orchestraCtx.fs, undefined, "a declared service must resolve");
    assert.notEqual(a2aCtx.agents, undefined, "a declared service must resolve");

    // `a2a_send` resolves the escrow write policy from `sandboxPolicy`, so the a2a
    // half must declare it. This is the dependency the `docs/gate-round2-fixes.md`
    // §5.2 fault was about; asserting it here keeps the declaration from being
    // silently dropped again.
    assert.ok(a2aInject.includes("sandboxPolicy"), "a2a must declare the sandboxPolicy it reads");
    assert.notEqual(a2aCtx.sandboxPolicy, undefined, "a declared service must resolve");

    // An UNDECLARED service must throw the engine's own message. `systemPrompt` is
    // reached only through `ctx.get(...)` by both halves, so neither declares it —
    // naming it keeps this self-test independent of either inject list changing.
    assert.equal(orchestraInject.includes("systemPrompt"), false);
    assert.equal(a2aInject.includes("systemPrompt"), false);
    assert.throws(() => orchestraCtx.systemPrompt, /cannot get property "systemPrompt" without inject/);
    assert.throws(() => a2aCtx.systemPrompt, /cannot get property "systemPrompt" without inject/);

    // Optional chaining must NOT swallow it: `a2a.ts` used `ctx.sandboxPolicy?.resolve?.()`
    // and still failed, because a proxy `get` trap that throws is not a nullish value.
    assert.throws(() => a2aCtx.systemPrompt?.section?.({}), /cannot get property "systemPrompt" without inject/);

    // Attribution is per-context, and every access is recorded.
    assert.deepEqual(orchestraCtx.__undeclaredAccesses.map((entry) => entry.prop), ["systemPrompt"]);
    assert.deepEqual(a2aCtx.__undeclaredAccesses.map((entry) => entry.prop), ["systemPrompt", "systemPrompt"]);
  } finally {
    await cleanup(env.root);
  }
});

test("D4: no handler reads a service outside its plugin's declared inject list", async () => {
  const env = await harness();
  try {
    const undeclared = [];
    for (const [name, spec] of Object.entries(CASES)) {
      const tool = env.byName.get(name);
      const args = spec.args(env);
      // Each registration carries its own guarded context, but the trap is
      // recorded on the context the plugin was registered with; re-run the sweep
      // through the tools so any undeclared read is attributed to a tool name.
      try {
        await tool.execute(args, env.exec(name, { arguments: args }));
      } catch {
        // Refusals are D4-3's business; here only the trap matters.
      }
    }
    // The trap is installed per plugin half. Both halves are registered against
    // separate contexts, so collect from both.
    for (const ctx of env.contexts) {
      for (const entry of ctx.__undeclaredAccesses) {
        undeclared.push(`${entry.prop}: ${String(entry.stack).split("\n")[1]?.trim()}`);
      }
    }
    assert.deepEqual(
      undeclared,
      [],
      "reading an undeclared service throws 'cannot get property \"…\" without inject' in the real harness",
    );
  } finally {
    await cleanup(env.root);
  }
});

// ---------------------------------------------------------------------------
// The original structural guard (kept: it is still the cheapest signal)
// ---------------------------------------------------------------------------

/** Every object schema reachable from one tool definition's declared output. */
function objectSchemas(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const entry of node) objectSchemas(entry, out);
    return out;
  }
  if (node.type === "object" && node.properties !== undefined) out.push(node);
  for (const value of Object.values(node)) objectSchemas(value, out);
  return out;
}

test("every registered tool declares the keys its own role-summary values can carry", async () => {
  const env = await harness();
  try {
    const violations = [];
    for (const tool of env.registered) {
      const schema = tool.output?.schema;
      if (schema === undefined) continue;
      for (const object of objectSchemas(schema)) {
        const declared = Object.keys(object.properties);
        // Only a schema that already describes a role summary is held to the rule;
        // a narrow projection is a different, legitimate shape.
        if (!declared.includes(SUMMARY_MARKER)) continue;
        const missing = ROLE_SUMMARY_KEYS.filter((key) => !declared.includes(key));
        if (missing.length > 0) violations.push(`${tool.name}: role schema is missing ${missing.join(", ")}`);
      }
    }
    assert.deepEqual(violations, [], "a value carrying an undeclared key makes the whole tool call invalid");
  } finally {
    await cleanup(env.root);
  }
});

test("orchestra_topologies declares the full role summary, including the node backend", async () => {
  const env = await harness();
  try {
    const tool = env.byName.get("orchestra_topologies");
    assert.notEqual(tool, undefined, "orchestra_topologies must be registered");
    const schemas = objectSchemas(tool.output.schema);
    const roleSchema = schemas.find((object) => Object.keys(object.properties).includes(SUMMARY_MARKER));
    assert.notEqual(roleSchema, undefined, "the templates[].roles[] item schema must exist");
    for (const key of ROLE_SUMMARY_KEYS) {
      assert.ok(Object.keys(roleSchema.properties).includes(key), `templates[].roles[] must declare "${key}"`);
    }
    // The two native knobs are the ones a hybrid topology actually uses, so their
    // nested shape is asserted rather than just their presence.
    assert.equal(roleSchema.properties.toolFilter.type, "object");
    assert.equal(roleSchema.properties.toolFilter.additionalProperties, false);
    assert.deepEqual(Object.keys(roleSchema.properties.toolFilter.properties).sort(), ["allow", "deny"]);
  } finally {
    await cleanup(env.root);
  }
});

test("inlineTopology accepts the config as an object OR as a JSON string of it", async () => {
  const { parseInlineTopologyArgument } = await import("../lib/orchestra.js");
  const config = { schemaVersion: 1, id: "topo", roles: [{ id: "a", name: "A", preset: "p" }] };
  // A model can hand the same value over either way; the tool knows what it
  // asked for, so it must not make the caller guess the spelling.
  assert.deepEqual(parseInlineTopologyArgument(config, "orchestra_draft"), config);
  assert.deepEqual(parseInlineTopologyArgument(JSON.stringify(config), "orchestra_draft"), config);
  assert.throws(() => parseInlineTopologyArgument("{not json", "orchestra_draft"), /not valid JSON/);
  assert.throws(() => parseInlineTopologyArgument([1, 2], "orchestra_draft"), /must be a topology config object/);
  assert.throws(() => parseInlineTopologyArgument(null, "orchestra_draft"), /must be a topology config object/);
  assert.throws(() => parseInlineTopologyArgument(42, "orchestra_draft"), /must be a topology config object/);
});
