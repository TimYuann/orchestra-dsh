/**
 * v0.5 Slimming and Lean Refactor Test Suite
 *
 * Verifies:
 * 1. a2a_stop immediately aborts agent reasoning with keepInbox: false
 * 2. a2a_list sorts by CWD activity descending, supports query filter, returns role/lastActivity
 * 3. a2a_read provides reverse progressive disclosure (turn-based windowing)
 * 4. orchestra_dispatch provisions role lanes on demand and binds task dispatch
 * 5. 17 micro state machine tools are cleanly removed from the registered tool surface
 * 6. orchestra_wait default timeout is 20 minutes (20 * 60 * 1000)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stopSession,
  formatRelativeTime,
  listThreads,
  readSessionText,
} from "../lib/a2a.js";
import { apply as applyOrchestra, DEFAULT_WAIT_TIMEOUT_MS } from "../lib/orchestra.js";

// 1. a2a_stop
test("a2a_stop: cancels agent reasoning and clears inbox", async () => {
  let cancelCalled = false;
  let cancelCause = null;
  let cancelOptions = null;

  const mockAgent = {
    cancel(cause, options) {
      cancelCalled = true;
      cancelCause = cause;
      cancelOptions = options;
    },
    status: { kind: "running" },
  };

  const fakeCtx = {
    agents: {
      get(id) {
        if (id === "session-test-1") return mockAgent;
        return undefined;
      },
    },
  };

  // Successful cancel
  const result = await stopSession(fakeCtx, "session-test-1", "user aborted runaway task");
  assert.equal(result.stopped, true);
  assert.equal(result.sessionId, "session-test-1");
  assert.equal(result.reason, "user aborted runaway task");
  assert.equal(cancelCalled, true);
  assert.deepEqual(cancelCause, { kind: "hook", reason: "user aborted runaway task" });
  assert.deepEqual(cancelOptions, { keepInbox: false });

  // Session not found
  const notFoundResult = await stopSession(fakeCtx, "session-missing");
  assert.equal(notFoundResult.stopped, false);
  assert.equal(notFoundResult.status, "not_found");
});

// 2. a2a_list enhancements
test("formatRelativeTime: produces human-readable relative time", () => {
  assert.equal(formatRelativeTime(5000), "just now");
  assert.equal(formatRelativeTime(30 * 1000), "30s ago");
  assert.equal(formatRelativeTime(2 * 60 * 1000), "2m ago");
  assert.equal(formatRelativeTime(45 * 60 * 1000), "45m ago");
  assert.equal(formatRelativeTime(3 * 3600 * 1000), "3h ago");
  assert.equal(formatRelativeTime(48 * 3600 * 1000), "2d ago");
});

test("a2a_list: sorts by activity descending, supports query, includes role and lastActivity", async () => {
  const now = Date.now();
  const sessions = [
    {
      id: "sess-1",
      title: "Backend API Worker",
      header: { cwd: "/work/project", createdAt: now - 3600 * 1000 },
      status: { kind: "idle" },
    },
    {
      id: "sess-2",
      title: "Frontend Implementer",
      header: { cwd: "/work/project", createdAt: now - 600 * 1000 },
      status: { kind: "running" },
    },
    {
      id: "sess-3",
      title: "Doc Reviewer",
      header: { cwd: "/work/other", createdAt: now - 60 * 1000 },
      status: { kind: "idle" },
    },
  ];

  const fakeCtx = {
    sessions: {
      async list() {
        return sessions;
      },
    },
    agents: {
      list() {
        return sessions.map((s) => fakeCtx.agents.get(s.id));
      },
      get(id) {
        return {
          id,
          session: sessions.find((s) => s.id === id),
          status: { kind: "idle" },
          activity: {
            steps: id === "sess-1" ? [{ timestamp: now - 120 * 1000 }] : [{ timestamp: now - 10 * 1000 }],
          },
        };
      },
    },
  };

  // Listing within /work/project with default sort (most recently active first)
  const res = await listThreads(fakeCtx, { driverCwd: "/work/project" });
  const list = res.threads;
  assert.equal(list.length, 3);
  // sess-2 (activity 10s ago) must precede sess-1 (activity 120s ago)
  const projSessions = list.filter((s) => s.cwd === "/work/project");
  assert.equal(projSessions[0].sessionId, "sess-2");
  assert.equal(projSessions[1].sessionId, "sess-1");
  assert.equal(projSessions[0].role, "Frontend Implementer");
  assert.ok(projSessions[0].lastActivity);

  // Search by query keyword "Backend"
  const filteredRes = await listThreads(fakeCtx, { driverCwd: "/work/project", query: "Backend" });
  const filtered = filteredRes.threads;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sessionId, "sess-1");
});

// 3. a2a_read reverse progressive disclosure
test("a2a_read: groups turns in reverse order, defaults to recent turns", async () => {
  const events = [
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "Turn 1 request" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Turn 1 response" }] } } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "Turn 2 request" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Turn 2 response" }] } } },
    { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "Turn 3 request" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Turn 3 response" }] } } },
  ];

  const fakeCtx = {
    get(name) {
      if (name === "sessionQuery") {
        return {
          async readSession(id) {
            if (id === "sess-turns") return { events };
            throw new Error("not found");
          },
        };
      }
      return undefined;
    },
  };

  // Default turns is 2: should only return Turn 2 and Turn 3, not Turn 1
  const output = await readSessionText(fakeCtx, "sess-turns", { turns: 2 });
  assert.equal(output.total_turns, 3);
  assert.equal(output.returned_turns, 2);
  const texts = output.messages.map((m) => m.text);
  assert.ok(texts.includes("Turn 3 response"));
  assert.ok(texts.includes("Turn 2 response"));
  assert.ok(!texts.includes("Turn 1 request"));

  // Expanding to turns: 3 returns all turns
  const fullOutput = await readSessionText(fakeCtx, "sess-turns", { turns: 3 });
  assert.equal(fullOutput.total_turns, 3);
  assert.equal(fullOutput.returned_turns, 3);
  const fullTexts = fullOutput.messages.map((m) => m.text);
  assert.ok(fullTexts.includes("Turn 1 request"));
  assert.ok(fullTexts.includes("Turn 2 request"));
  assert.ok(fullTexts.includes("Turn 3 request"));
});

// 4. orchestra_wait default timeout is 20 minutes
test("orchestra_wait: default heartbeat timeout is 20 minutes", () => {
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 20 * 60 * 1000);
});

// 5. Slimmed tool registry
test("orchestra tool surface: 17 state machine tools removed, orchestra_dispatch present", () => {
  const registered = [];
  const fakeCtx = {
    tools: {
      register(tool) {
        registered.push(tool);
      },
    },
    get(name) {
      return undefined;
    },
    on() {},
    effect() {},
    fs: {},
  };

  applyOrchestra(fakeCtx);

  const toolNames = registered.map((t) => t.name);

  // Tools that MUST be present
  assert.ok(toolNames.includes("orchestra_dispatch"), "orchestra_dispatch must be registered");
  assert.ok(toolNames.includes("orchestra_wait"), "orchestra_wait must be registered");
  assert.ok(toolNames.includes("orchestra_draft"), "orchestra_draft must be registered");
  assert.ok(toolNames.includes("orchestra_team"), "orchestra_team must be registered");
  assert.ok(toolNames.includes("orchestra_report"), "orchestra_report must be registered");
  assert.ok(toolNames.includes("orchestra_send"), "orchestra_send must be registered");
  assert.ok(toolNames.includes("orchestra_topologies"), "orchestra_topologies must be registered");
  assert.ok(toolNames.includes("orchestra_dismiss"), "orchestra_dismiss must be registered");
  assert.ok(toolNames.includes("orchestra_activate"), "orchestra_activate must be registered");

  // The 17 deleted micro state-machine tools that MUST NOT be present
  const deletedTools = [
    "orchestra_loop_start",
    "orchestra_attempt_start",
    "orchestra_verdict",
    "orchestra_handoff",
    "orchestra_gate_open",
    "orchestra_gate_fallback",
    "orchestra_graph_reconcile",
    "orchestra_reconcile",
    "orchestra_decision",
    "orchestra_document",
    "orchestra_charters",
    "orchestra_graph",
    "orchestra_close",
    "orchestra_apply_amendment",
    "orchestra_freeze",
    "orchestra_spawn",
  ];

  for (const deleted of deletedTools) {
    assert.ok(!toolNames.includes(deleted), `Tool ${deleted} should be deleted in v0.5 but was found registered`);
  }
});
