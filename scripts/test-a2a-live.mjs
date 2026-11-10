import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Sessions from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Agents from "@deepseek-ai/dsh-agent";
import Llm, { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import * as NativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import { sendRawA2A, installModelOverride } from "../lib/a2a.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};

// A deterministic model keeps the real host driver busy. Only the remote model
// is simulated: Agent, Inbox, Session, projections and loop are DSH 0.2.2 code.
for (const queued of [false, true]) {
  test(`real AgentLoop: ${queued ? "explicit queue starts a new turn" : "default A2A reply reaches the busy turn's next step"}`, { timeout: 10000 }, async () => {
    const ctx = new Context();
    const entered = deferred();
    const release = deferred();
    const calls = [];
    class Adapter extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, reasoning: { efforts: [{ id: "max", name: "Max" }] } };
      }
      async *stream(options) {
        calls.push(options);
        if (calls.length === 1) { entered.resolve(); await release.promise; }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "done" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    try {
      for (const plugin of [Sessions, Projections, Agents, Llm, SystemPrompt, Tools, NativeExecutor, AgentLoop]) await ctx.plugin(plugin, {});
      ctx.llm.registerAdapter(["test"], new Adapter());
      const { agent } = await ctx.agents.create({ sessionId: `delivery-${queued}`, agentOptions: { provider: "test", model: "test" },
        setup: (agentCtx, agent) => installModelOverride(agentCtx, true, "test", "test", "max", agent),
      });
      assert.equal(agent.model.current().reasoningEffort, "max");
      assert.ok(agent.session.snapshotEvents().some((event) => event.type === "model/selection" && event.data.reasoningEffort === "max"));
      agent.followup(createUserMessage({ content: [{ type: "text", text: "original task" }], source: { kind: "user" } }));
      await entered.promise;
      assert.equal(agent.status, "running");
      await sendRawA2A(ctx, { to: agent.id, message: "peer-result-marker", ...(queued ? { interrupt: false } : {}) }, { agent: { id: "peer", session: { header: {} } } });
      release.resolve();
      await agent.whenIdle();
      assert.equal(calls.length, 2);
      assert.ok(calls[1].messages.some((message) => message.content.some((part) => part.type === "text" && part.text.includes("peer-result-marker"))));
      const events = agent.session.snapshotEvents();
      const starts = events.filter((event) => event.type === "turn/start");
      assert.equal(starts.length, queued ? 2 : 1);
      const headers = events.filter((event) => event.type === "request/header");
      assert.ok(headers.every((event) => event.data.header.config.reasoningEffort === "max"));
      assert.equal(events.some((event) => event.type === "turn/end" && event.data.reason.kind !== "completed"), false);
    } finally {
      release.resolve();
      await ctx.fiber.dispose();
    }
  });
}
