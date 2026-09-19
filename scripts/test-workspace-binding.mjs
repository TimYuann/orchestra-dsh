import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../lib/a2a.js";

function makeRuntimeWithWorkspace(options = {}) {
  const events = [];
  const session = {
    header: { id: options.sessionId ?? "child", cwd: options.cwd ?? "/tmp/project" },
    events,
    snapshotEvents() {
      return events;
    },
    append(type, data) {
      events.push({ type, data });
      return { type, data };
    },
  };
  const sessions = {
    get(id) {
      return id === (options.sessionId ?? "child") ? session : undefined;
    },
  };
  const presets = {
    defaultId: "default-preset",
    composedPreset(context) {
      return context.composedPreset;
    },
    async resolve(id) {
      return { id };
    },
    async mount(context, id) {
      context.composedPreset = id;
    },
    composeFrom(context, parent) {
      context.composedPreset = parent.composedPreset;
      return parent.composedPreset;
    },
  };
  const permissions = {
    defaultPreset: "workspace-write",
    resolve() {
      return { sandbox: "workspace-write", approval: "ask" };
    },
    set(target, name) {
      target.append("permission/preset", { preset: name });
    },
    current() {
      return "workspace-write";
    },
  };
  const tools = {
    schemas() {
      return [{ name: "read", description: "read", parameters: {} }];
    },
  };
  const model = {
    currentSelection() {
      return { provider: "default-provider", model: "default-model" };
    },
  };

  const attached = [];
  const mockWorkspaces = (options.workspaces ?? []).map((ws) => ({
    ...ws,
    async attachSession(sid) {
      attached.push({ workspaceId: ws.id, sessionId: sid });
    },
  }));

  const workspaceRegistry = {
    get(id) {
      return mockWorkspaces.find((w) => w.id === id);
    },
    list() {
      return mockWorkspaces;
    },
  };

  const services = {
    agentPresets: presets,
    permissionPresets: permissions,
    tools,
    sessions,
    agentDefaultModel: model,
    ...(options.noRegistry ? {} : { workspaceRegistry }),
  };

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

  const agents = {
    get() {
      return undefined;
    },
    async create(opts) {
      if (typeof opts.setup === "function") {
        const res = await opts.setup(childContext);
        if (res && typeof res.commit === "function") {
          res.commit();
        }
      }
      return { sessionId: opts.sessionId };
    },
  };
  context.agents = agents;

  return { context, childContext, attached };
}

test("createSession attaches to workspace via currentSessionId in registry", async () => {
  const runtime = makeRuntimeWithWorkspace({
    sessionId: "role-session-1",
    workspaces: [
      { id: "ws-other", path: "/tmp/other", sessionIds: ["other-parent"] },
      { id: "ws-target", path: "/tmp/project", sessionIds: ["driver-session-123"] },
    ],
  });

  const res = await createSession(runtime.context, {
    sessionId: "role-session-1",
    cwd: "/tmp/project",
    presetId: "default-preset",
    currentSessionId: "driver-session-123",
  });

  assert.equal(res.sessionId, "role-session-1");
  assert.deepEqual(runtime.attached, [{ workspaceId: "ws-target", sessionId: "role-session-1" }]);
});

test("createSession attaches to workspace via cwd fallback matching when currentSessionId is missing or unmatched", async () => {
  const runtime = makeRuntimeWithWorkspace({
    sessionId: "role-session-2",
    cwd: "/tmp/project-alpha",
    workspaces: [
      { id: "ws-beta", path: "/tmp/project-beta", sessionIds: ["beta-sid"] },
      { id: "ws-alpha", path: "/tmp/project-alpha", sessionIds: [] },
    ],
  });

  const res = await createSession(runtime.context, {
    sessionId: "role-session-2",
    cwd: "/tmp/project-alpha",
    presetId: "default-preset",
    // No currentSessionId provided
  });

  assert.equal(res.sessionId, "role-session-2");
  assert.deepEqual(runtime.attached, [{ workspaceId: "ws-alpha", sessionId: "role-session-2" }]);
});

test("createSession does NOT touch workspace storage on disk when the registry service is absent", async () => {
  // The plugin deliberately owns no write path into ~/.dsh/storages/workspace.json:
  // that file belongs to the workspace domain, whose attachSession is what
  // enforces the account invariants. A headless deployment simply has no
  // registry, and an unattached session is reported honestly rather than
  // smuggled into the account by a read-modify-write.
  const runtime = makeRuntimeWithWorkspace({
    sessionId: "role-session-3",
    cwd: "/tmp/project",
    noRegistry: true,
  });

  const res = await createSession(runtime.context, {
    sessionId: "role-session-3",
    cwd: "/tmp/project",
    presetId: "default-preset",
    currentSessionId: "driver-session-123",
  });

  assert.equal(res.sessionId, "role-session-3");
  assert.deepEqual(runtime.attached, []);
});
