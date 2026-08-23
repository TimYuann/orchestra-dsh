import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../lib/a2a.js";
import {
  SessionBlueprintError,
  prepareLightweightBlueprint,
  readLightweightBlueprint,
} from "../lib/session-blueprint.js";

function makeRuntime(options = {}) {
  const events = [];
  const session = {
    events,
    append(type, data) {
      events.push({ type, data });
      return { type, data };
    },
  };
  const sessions = {
    get(id) {
      return id === "child" ? session : undefined;
    },
  };
  const calls = { mounts: [], composes: [], permissions: [] };
  const presets = {
    defaultId: options.defaultId ?? "default-preset",
    composedPreset(context) {
      return context.composedPreset;
    },
    async resolve(id) {
      if (options.brokenPreset === id) throw new Error(`broken preset ${id}`);
      if (options.unknownPreset === id) throw new Error(`unknown preset ${id}`);
      return { id };
    },
    async mount(context, id) {
      calls.mounts.push(id);
      context.composedPreset = id;
    },
    composeFrom(context, parent) {
      calls.composes.push(parent.composedPreset);
      context.composedPreset = parent.composedPreset;
      return parent.composedPreset;
    },
  };
  const permissions = {
    defaultPreset: options.defaultPermission ?? "workspace-write",
    resolve(name) {
      if (options.unknownPermission === name) throw new Error(`unknown permission ${name}`);
      return { sandbox: "workspace-write", approval: "ask" };
    },
    set(target, name) {
      calls.permissions.push(name);
      target.append("permission/preset", { preset: name });
    },
    current(log) {
      const event = [...log].reverse().find((entry) => entry.type === "permission/preset");
      return event?.data.preset ?? this.defaultPreset;
    },
  };
  const tools = {
    schemas() {
      return (options.tools ?? ["read", "write"]).map((name) => ({ name, description: name, parameters: {} }));
    },
  };
  const model = {
    currentSelection() {
      return options.defaultModel ?? { provider: "default-provider", model: "default-model" };
    },
  };
  const services = { agentPresets: presets, permissionPresets: permissions, tools, sessions, agentDefaultModel: model };
  const context = {
    get(name) {
      return services[name];
    },
    on() {
      return () => {};
    },
  };
  const childContext = {
    ...context,
    composedPreset: undefined,
  };
  const callerContext = {
    ...context,
    composedPreset: options.callerPreset,
  };
  const caller = {
    id: "caller",
    ctx: callerContext,
    options: options.callerOptions ?? {},
  };
  return { context, childContext, caller, session, sessions, calls, presets, permissions, tools, model, events };
}

async function runSetup(runtime, input) {
  const prepared = await prepareLightweightBlueprint(runtime.context, input);
  const commit = await prepared.setup(runtime.childContext);
  commit.commit();
  return prepared;
}

test("explicit preset mounts, pins permission/model, fixes title, and records marker", async () => {
  const runtime = makeRuntime({ tools: ["read", "write"] });
  const prepared = await runSetup(runtime, {
    sessionId: "child",
    caller: runtime.caller,
    createdBySessionId: "caller",
    cwd: "/tmp/blueprint",
    presetId: "explicit-preset",
    permissionPreset: "safe",
    provider: "provider-x",
    model: "model-x",
    reasoningEffort: "high",
    title: "child title",
    requiredTools: ["read"],
  });
  assert.deepEqual(runtime.calls.mounts, ["explicit-preset"]);
  assert.deepEqual(runtime.calls.permissions, ["safe"]);
  assert.equal(prepared.receipt.agentPreset, "explicit-preset");
  assert.equal(prepared.receipt.permissionPreset, "safe");
  assert.equal(prepared.receipt.provider, "provider-x");
  assert.equal(prepared.receipt.model, "model-x");
  assert.equal(prepared.receipt.reasoningEffort, "high");
  assert.deepEqual(prepared.receipt.tools, { names: ["read", "write"], count: 2 });
  assert.equal(runtime.events.some((event) => event.type === "session/title"), true);
  const marker = readLightweightBlueprint(runtime.events);
  assert.equal(marker.mode, "lightweight");
  assert.equal(marker.agentPreset, "explicit-preset");
  assert.equal("teamId" in marker, false);
  assert.equal("roleId" in marker, false);
  assert.equal("topologyId" in marker, false);
});

test("caller composition inherits the exact generation; rosterless caller mounts default", async () => {
  const inherited = makeRuntime({ callerPreset: "caller-generation" });
  await runSetup(inherited, { sessionId: "child", caller: inherited.caller, createdBySessionId: "caller" });
  assert.deepEqual(inherited.calls.composes, ["caller-generation"]);
  assert.deepEqual(inherited.calls.mounts, []);

  const rosterless = makeRuntime({ callerPreset: undefined, defaultId: "default-generation" });
  const prepared = await runSetup(rosterless, { sessionId: "child", caller: rosterless.caller, createdBySessionId: "caller" });
  assert.deepEqual(rosterless.calls.mounts, ["default-generation"]);
  assert.equal(prepared.receipt.agentPreset, "default-generation");
});

test("rosterless default missing/broken and explicit permission/model inputs fail loudly", async () => {
  const missingDefault = makeRuntime({ defaultId: "" });
  await assert.rejects(
    () => prepareLightweightBlueprint(missingDefault.context, { sessionId: "child", caller: missingDefault.caller, createdBySessionId: "caller" }),
    (error) => error instanceof SessionBlueprintError && error.code === "preset_unavailable",
  );
  const brokenDefault = makeRuntime({ defaultId: "broken", brokenPreset: "broken" });
  await assert.rejects(
    () => prepareLightweightBlueprint(brokenDefault.context, { sessionId: "child", caller: brokenDefault.caller, createdBySessionId: "caller" }),
    (error) => error instanceof SessionBlueprintError && error.code === "preset_unavailable",
  );
  const unknownExplicit = makeRuntime({ unknownPreset: "missing-explicit" });
  await assert.rejects(
    () => prepareLightweightBlueprint(unknownExplicit.context, { sessionId: "child", caller: unknownExplicit.caller, createdBySessionId: "caller", presetId: "missing-explicit" }),
    (error) => error instanceof SessionBlueprintError && error.code === "preset_unavailable",
  );
  const brokenExplicit = makeRuntime({ brokenPreset: "broken-explicit" });
  await assert.rejects(
    () => prepareLightweightBlueprint(brokenExplicit.context, { sessionId: "child", caller: brokenExplicit.caller, createdBySessionId: "caller", presetId: "broken-explicit" }),
    (error) => error instanceof SessionBlueprintError && error.code === "preset_unavailable" && error.cause?.message === "broken preset broken-explicit",
  );
  const brokenFile = makeRuntime();
  const filePrepared = await prepareLightweightBlueprint(brokenFile.context, {
    sessionId: "child",
    caller: brokenFile.caller,
    createdBySessionId: "caller",
    presetFile: { id: "file-preset", trust: "user", path: "/missing/preset.json" },
  });
  await assert.rejects(
    () => filePrepared.setup(brokenFile.childContext),
    (error) => error instanceof SessionBlueprintError && error.code === "preset_unavailable",
  );
  const invalidPair = makeRuntime();
  await assert.rejects(
    () => prepareLightweightBlueprint(invalidPair.context, { sessionId: "child", caller: invalidPair.caller, createdBySessionId: "caller", provider: "only-provider" }),
    (error) => error instanceof SessionBlueprintError && error.code === "invalid_input",
  );
  const unknownPermission = makeRuntime({ unknownPermission: "missing-permission" });
  await assert.rejects(
    () => prepareLightweightBlueprint(unknownPermission.context, { sessionId: "child", caller: unknownPermission.caller, createdBySessionId: "caller", permissionPreset: "missing-permission" }),
    (error) => error instanceof SessionBlueprintError && error.code === "permission_unavailable",
  );
});

test("required tool failure happens at commit and leaves no published agent in a factory harness", async () => {
  const runtime = makeRuntime({ tools: ["read"] });
  const prepared = await prepareLightweightBlueprint(runtime.context, {
    sessionId: "child",
    caller: runtime.caller,
    createdBySessionId: "caller",
    requiredTools: ["missing-tool"],
  });
  let published = false;
  await assert.rejects(async () => {
    const commit = await prepared.setup(runtime.childContext);
    commit.commit();
    published = true;
  }, (error) => error instanceof SessionBlueprintError && error.code === "required_tools_missing");
  assert.equal(published, false);
});

test("createSession lightweight output carries complete receipt and rollback does not publish", async () => {
  const runtime = makeRuntime({ callerPreset: "caller-generation", tools: ["read"] });
  const published = [];
  const agents = {
    get() {
      return undefined;
    },
    async create(options) {
      try {
        const commit = await options.setup(runtime.childContext);
        commit.commit();
        published.push(options);
        return { sessionId: options.sessionId };
      } catch (error) {
        throw error;
      }
    },
  };
  runtime.context.agents = agents;
  const result = await createSession(runtime.context, {
    mode: "lightweight",
    sessionId: "child",
    cwd: "/tmp/blueprint",
    callerAgent: runtime.caller,
    currentSessionId: "caller",
    requiredTools: ["read"],
  });
  assert.equal(result.mode, "lightweight");
  assert.equal(result.agentPreset, "caller-generation");
  assert.equal(result.permissionPreset, "workspace-write");
  assert.equal(result.provider, "default-provider");
  assert.equal(result.model, "default-model");
  assert.deepEqual(result.tools, { names: ["read"], count: 1 });
  assert.equal(published.length, 1);
});

test("old sessions without a marker remain unknown rather than gaining invented facts", () => {
  assert.equal(readLightweightBlueprint([{ type: "session/end-seed", data: {}, seq: 0, time: 1 }]), undefined);
});

test("malformed durable markers are rejected without throwing or inventing facts", () => {
  const valid = {
    schemaVersion: 1,
    mode: "lightweight",
    agentPreset: "preset",
    permissionPreset: "permission",
    provider: "provider",
    model: "model",
    createdBySessionId: "caller",
    createdAt: 1,
  };
  const malformed = [
    ["null", null],
    ["array", []],
    ["empty agentPreset", { ...valid, agentPreset: "" }],
    ["empty permissionPreset", { ...valid, permissionPreset: "" }],
    ["empty provider", { ...valid, provider: "" }],
    ["empty model", { ...valid, model: "" }],
    ["empty createdBySessionId", { ...valid, createdBySessionId: "" }],
    ["wrong reasoningEffort", { ...valid, reasoningEffort: 1 }],
    ["wrong cwd", { ...valid, cwd: 1 }],
    ["wrong title", { ...valid, title: false }],
    ["NaN createdAt", { ...valid, createdAt: NaN }],
    ["Infinity createdAt", { ...valid, createdAt: Infinity }],
    ["teamId", { ...valid, teamId: "team" }],
    ["roleId", { ...valid, roleId: "role" }],
    ["topologyId", { ...valid, topologyId: "topology" }],
  ];
  for (const [label, data] of malformed) {
    const event = { type: "orchestra/blueprint", data, seq: 0, time: 1 };
    assert.doesNotThrow(() => readLightweightBlueprint([event]), label);
    assert.equal(readLightweightBlueprint([event]), undefined, label);
  }
  assert.deepEqual(readLightweightBlueprint([{ type: "orchestra/blueprint", data: valid, seq: 0, time: 1 }]), valid);
});
