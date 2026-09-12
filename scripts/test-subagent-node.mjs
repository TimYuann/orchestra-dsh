/**
 * Native sub-agent node seam: what the module sends to `ctx.subagents`, what it
 * reports back, and how it fails.
 *
 * The fakes below deliberately record the exact native call arguments: the
 * point of this seam is that the plugin composes the native contract correctly,
 * so the assertions compare the composed spec rather than a normalized copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SubagentNodeError,
  createSubagentNode,
  sendToSubagentNode,
  subagentNodeActivity,
} from "../lib/subagent-node.js";
import { createLightweightSubagentNode } from "../lib/a2a.js";

function makeRuntime(options = {}) {
  const calls = { startContinuable: [], sendMessage: [], listChildren: [] };
  const subagents = {
    async startContinuable(spec) {
      calls.startContinuable.push(spec);
      if (options.createFailure) throw new Error("provider exploded");
      return { childId: spec.childId ?? "child-generated", messageId: "msg-created" };
    },
    async sendMessage(sender, targetId, content, sendOptions) {
      calls.sendMessage.push({ sender, targetId, content, sendOptions });
      if (options.deliverFailure) throw new Error("target is not an adjacent agent");
      return "msg-delivered";
    },
    async listChildren(parentSessionId, signal) {
      calls.listChildren.push({ parentSessionId, signal });
      if (options.listFailure) throw new Error("projection registry is not mounted");
      return options.children ?? [];
    },
  };
  const ctx = {
    get(name) {
      return name === "subagents" && options.noRegistry !== true ? subagents : undefined;
    },
  };
  return { ctx, calls };
}

const PARENT = { id: "driver-session" };
const SIGNAL = () => new AbortController().signal;

test("createSubagentNode composes the native spec and maps the receipt back", async () => {
  const { ctx, calls } = makeRuntime();
  const receipt = await createSubagentNode(
    ctx,
    PARENT,
    {
      label: "reviewer",
      prompt: "review the candidate diff",
      childId: "child-reserved",
      provider: "fork",
      persona: "You are the reviewer.",
      toolFilter: { deny: ["write", "edit"] },
      agentOptions: { provider: "route-provider", model: "route-model", reasoningEffort: "high", maxTokens: 4096 },
    },
    SIGNAL(),
  );

  assert.deepEqual(receipt, { childId: "child-reserved", messageId: "msg-created", provider: "fork" });
  assert.equal(calls.startContinuable.length, 1);
  const spec = calls.startContinuable[0];
  assert.equal(spec.provider, "fork");
  assert.equal(spec.label, "reviewer");
  assert.equal(spec.childId, "child-reserved");
  assert.equal(spec.request.parent, PARENT, "the caller's own Agent is the delegation parent");
  assert.deepEqual(spec.request.prompt, [{ type: "text", text: "review the candidate diff" }]);
  assert.equal(spec.request.persona, "You are the reviewer.");
  assert.deepEqual(spec.request.toolFilter, { deny: ["write", "edit"] });
  assert.deepEqual(spec.request.agentOptions, {
    provider: "route-provider",
    model: "route-model",
    reasoningEffort: "high",
    maxTokens: 4096,
  });
  assert.ok(spec.signal instanceof AbortSignal, "the caller's cancellation reaches preparation");
  assert.ok(!("outputSchema" in spec.request), "the seam never claims a result contract it does not use");
});

test("createSubagentNode defaults to spawn and omits every unstated knob", async () => {
  const { ctx, calls } = makeRuntime();
  const receipt = await createSubagentNode(ctx, PARENT, { label: "auditor", prompt: "audit the module" }, SIGNAL());

  assert.equal(calls.startContinuable[0].provider, "spawn", "a node is a new role, so a fresh child is the default");
  assert.equal(receipt.childId, "child-generated", "without a reserved id the provider allocates one");
  assert.equal(receipt.messageId, "msg-created");
  const spec = calls.startContinuable[0];
  assert.ok(!("childId" in spec), "no reserved identity is invented when the caller did not supply one");
  assert.ok(!("agentOptions" in spec.request));
  assert.ok(!("toolFilter" in spec.request));
  assert.ok(!("persona" in spec.request));
});

test("createSubagentNode fails loud without a subagent registry and on provider failure", async () => {
  const missing = makeRuntime({ noRegistry: true });
  await assert.rejects(
    () => createSubagentNode(missing.ctx, PARENT, { label: "reviewer", prompt: "x" }, SIGNAL()),
    (error) => error instanceof SubagentNodeError && error.code === "unavailable",
  );

  const failing = makeRuntime({ createFailure: true });
  await assert.rejects(
    () => createSubagentNode(failing.ctx, PARENT, { label: "reviewer", prompt: "x" }, SIGNAL()),
    (error) => error instanceof SubagentNodeError && error.code === "create_failed" && /provider exploded/.test(error.message),
  );

  const { ctx } = makeRuntime();
  await assert.rejects(
    () => createSubagentNode(ctx, PARENT, { label: "", prompt: "x" }, SIGNAL()),
    /label must be a non-empty string/,
  );
  await assert.rejects(
    () => createSubagentNode(ctx, PARENT, { label: "reviewer", prompt: "" }, SIGNAL()),
    /prompt must be a non-empty string/,
  );
});

test("sendToSubagentNode steers the caller's blocks to the addressed child", async () => {
  const { ctx, calls } = makeRuntime();
  const blocks = [{ type: "text", text: "handoff payload" }];
  const result = await sendToSubagentNode(ctx, PARENT, "child-1", blocks);

  assert.deepEqual(result, { messageId: "msg-delivered" });
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].sender, PARENT, "native delivery is authorized by the caller's own identity");
  assert.equal(calls.sendMessage[0].targetId, "child-1");
  assert.deepEqual(calls.sendMessage[0].content, blocks);
  assert.ok(calls.sendMessage[0].sendOptions.signal instanceof AbortSignal, "a real signal always crosses the boundary");
});

test("sendToSubagentNode reports rejected adjacency as deliver_failed", async () => {
  const { ctx } = makeRuntime({ deliverFailure: true });
  await assert.rejects(
    () => sendToSubagentNode(ctx, PARENT, "child-9", [{ type: "text", text: "x" }]),
    (error) => error instanceof SubagentNodeError && error.code === "deliver_failed" && /not an adjacent agent/.test(error.message),
  );

  const missing = makeRuntime({ noRegistry: true });
  await assert.rejects(
    () => sendToSubagentNode(missing.ctx, PARENT, "child-9", [{ type: "text", text: "x" }]),
    (error) => error instanceof SubagentNodeError && error.code === "unavailable",
  );
});

test("subagentNodeActivity maps child rows and reports unclassifiable rows as unknown", async () => {
  const { ctx, calls } = makeRuntime({
    children: [
      { kind: "child", id: "child-running", activity: "running", hasChildren: false, mode: "continuable", label: "reviewer" },
      { kind: "child", id: "child-idle", activity: "inactive", hasChildren: true, mode: "one-shot" },
      { kind: "diagnostic", id: "child-ghost", reason: "corrupt" },
    ],
  });
  const activity = await subagentNodeActivity(ctx, "driver-session");

  assert.equal(activity.get("child-running"), "running");
  assert.equal(activity.get("child-idle"), "inactive");
  assert.equal(activity.get("child-ghost"), "unknown", "a row this runtime cannot classify is not reported as stopped");
  assert.equal(activity.get("never-listed"), undefined, "the map is a sparse index of what the listing reported");
  assert.equal(activity.size, 3);
  assert.equal(calls.listChildren[0].parentSessionId, "driver-session");

  const missing = makeRuntime({ noRegistry: true });
  await assert.rejects(
    () => subagentNodeActivity(missing.ctx, "driver-session"),
    (error) => error instanceof SubagentNodeError && error.code === "unavailable",
  );

  const failing = makeRuntime({ listFailure: true });
  await assert.rejects(
    () => subagentNodeActivity(failing.ctx, "driver-session"),
    /projection registry is not mounted/,
    "an enumeration failure stays itself instead of becoming an empty listing",
  );
});

test("the lightweight path opens a native node only for what the contract can honor", async () => {
  const runtime = makeRuntime();
  const caller = { id: "driver-session", options: { provider: "command", model: "deepseek-v4.1-flash" }, session: {} };
  const exec = { agent: caller };

  // Success: the composed spec is what the native contract promises, and the
  // reported route is the caller's own when the node states no override.
  const receipt = await createLightweightSubagentNode(
    runtime.ctx,
    { label: "scout", prompt: "侦察这个仓库的构建脚本。", persona: "你是侦察节点。", toolFilter: { deny: ["write", "edit"] } },
    exec,
  );
  assert.equal(receipt.execution, "subagent");
  assert.equal(receipt.sessionId, "child-generated");
  assert.equal(receipt.label, "scout");
  assert.equal(receipt.provider, "command");
  assert.equal(receipt.model, "deepseek-v4.1-flash");
  const spec = runtime.calls.startContinuable[0];
  assert.equal(spec.provider, "spawn", "a node is a NEW role, never a fork of the caller's history");
  assert.equal(spec.label, "scout");
  assert.equal(spec.request.parent, caller);
  assert.equal(spec.request.prompt[0].text, "侦察这个仓库的构建脚本。");
  assert.equal(spec.request.persona, "你是侦察节点。");
  assert.deepEqual(spec.request.toolFilter, { deny: ["write", "edit"] });
  assert.equal(spec.request.agentOptions, undefined, "an unstated route stays unstated so the node inherits the caller's");

  // A generated label when none is given.
  const generated = await createLightweightSubagentNode(runtime.ctx, { prompt: "x" }, exec);
  assert.match(generated.label, /^a2a-node-[0-9a-f]{8}$/);

  // Explicit route is forwarded and reported.
  const routed = await createLightweightSubagentNode(runtime.ctx, { prompt: "x", provider: "p", model: "m", reasoningEffort: "low" }, exec);
  assert.deepEqual(runtime.calls.startContinuable[2].request.agentOptions, { provider: "p", model: "m", reasoningEffort: "low" });
  assert.equal(routed.provider, "p");
  assert.equal(routed.model, "m");

  // Every session-only field is refused BY NAME rather than reinterpreted.
  await assert.rejects(
    () => createLightweightSubagentNode(runtime.ctx, { prompt: "x", cwd: "/tmp", presetId: "p", title: "t" }, exec),
    /cannot honor cwd, presetId, title/,
  );
  assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "x", agentPreset: "p" }, exec), /cannot honor agentPreset/);
  assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "x", permissionPreset: "read-only" }, exec), /cannot honor permissionPreset/);
  assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "x", requiredTools: ["read"] }, exec), /cannot honor requiredTools/);

  // The native contract has no established-but-idle child, so prompt is required.
  await assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { label: "scout" }, exec), /requires prompt/);
  await assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "   " }, exec), /requires prompt/);

  // Route pairing mirrors the session backend's rule.
  await assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "x", provider: "p" }, exec), /provider and model together/);
  await assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "x", reasoningEffort: "low" }, exec), /requires provider and model/);

  // The caller must exist: a node without a live parent cannot be delivered to.
  await assert.rejects(() => createLightweightSubagentNode(runtime.ctx, { prompt: "x" }, { agent: undefined }), /requires an agent caller/);
});
