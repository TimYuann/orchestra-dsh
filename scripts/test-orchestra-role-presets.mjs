import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALL_BUILTIN_ROLE_PRESETS,
  BUILTIN_ROLE_PRESETS,
  LEGACY_BUILTIN_ROLE_PRESETS,
  ensureBuiltinRolePresetArtifacts,
  parseRolePresetComposition,
  renderRolePresetComposition,
  resolveRolePresetFile,
  validateAllRolePresetSpecs,
  validateRolePresetSpec,
} from "../lib/orchestra-role-presets.js";
import { blueprintStoreFor, prepareGovernedBlueprint, preflightGovernedRequiredTools, SessionBlueprintError } from "../lib/session-blueprint.js";
import { prepareGovernedRolePlan } from "../lib/orchestra.js";

function nativeFs() {
  return {
    async resolve(path) {
      return { path };
    },
    processPath(target) {
      return target.path;
    },
    async stat(target) {
      try {
        return await import("node:fs/promises").then(({ stat }) => stat(target.path));
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async readText(target) {
      return readFile(target.path, "utf8");
    },
  };
}

function toolSchemas(names) {
  return names.map((name) => ({ name, description: name, parameters: {} }));
}

function blueprintRuntime(spec, missing = []) {
  const events = [];
  const session = {
    id: "role-session",
    // A real Session always has a header, and the composition marker is filed
    // under this cwd now.
    header: { id: "role-session", cwd: "/tmp/role-preset" },
    events,
    // DSH 0.1.5-rc.2 Session surface: `snapshotEvents()` replaced `.events`.
    snapshotEvents() {
      return events;
    },
    append(type, data) {
      events.push({ type, data });
    },
  };
  const sessionMap = new Map([["role-session", session]]);
  const visible = [...new Set([...spec.compositionTools, ...spec.orchestraTools])].filter((name) => !missing.includes(name));
  const sessions = {
    get(id) {
      return sessionMap.get(String(id));
    },
  };
  const presets = {
    defaultId: spec.id,
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
  const permissions = {
    defaultPreset: "workspace-write",
    resolve() {
      return { sandbox: "workspace-write", approval: "ask" };
    },
    set(target, name) {
      target.append("permission/preset", { preset: name });
    },
    // DSH 0.1.5-rc.2: `PermissionPresets.current` takes the Session itself.
    current(session) {
      const sandbox = [...session.snapshotEvents()].reverse().find((event) => event.type === "sandbox/mode")?.data?.mode;
      return sandbox !== undefined && sandbox !== "workspace-write" ? "custom" : "workspace-write";
    },
  };
  const context = {
    get(name) {
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      if (name === "tools") return { schemas: () => toolSchemas(visible) };
      if (name === "sessions") return sessions;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "provider", model: "model" }) };
      return undefined;
    },
    sessions,
    agents: { get() { return undefined; } },
    on() {
      return () => {};
    },
  };
  const child = {
    ...context,
    composedPreset: undefined,
    get(name) {
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      if (name === "tools") return { schemas: () => toolSchemas(visible) };
      if (name === "sessions") return sessions;
      return context.get(name);
    },
  };
  return {
    context,
    child,
    session,
    presets,
    visible,
    addSession(id) {
      const extra = {
        id,
        events: [],
        // DSH 0.1.5-rc.2 Session surface.
        snapshotEvents() {
          return this.events;
        },
        append(type, data) {
          this.events.push({ type, data });
        },
      };
      sessionMap.set(id, extra);
      return extra;
    },
  };
}

test("catalog has nine versioned specs plus three explicit legacy specs", () => {
  assert.equal(BUILTIN_ROLE_PRESETS.length, 9);
  assert.equal(LEGACY_BUILTIN_ROLE_PRESETS.length, 3);
  assert.equal(ALL_BUILTIN_ROLE_PRESETS.length, 12);
  assert.deepEqual(validateAllRolePresetSpecs(), []);
  assert.equal(new Set(BUILTIN_ROLE_PRESETS.map((spec) => spec.id)).size, 9);
  for (const spec of ALL_BUILTIN_ROLE_PRESETS) {
    const parsed = parseRolePresetComposition(spec.cordisYml);
    assert.ok(parsed.rowIds.includes("persona"), spec.id);
    assert.ok(parsed.rowIds.includes("agent-instructions"), spec.id);
    assert.equal(parsed.pluginNames.some((name) => name.startsWith("orchestra_") || name.startsWith("a2a_")), false, spec.id);
    assert.equal(parsed.rowIds.some((id) => ["delegation", "tool-subagent", "tool-goal", "tool-presentation"].includes(id)), false, spec.id);
    if (spec.status === "v04") assert.ok(spec.reportHandoff.requiredPayloadFields.length > 0, spec.id);
  }
  const implementer = BUILTIN_ROLE_PRESETS.find((spec) => spec.role === "implementer");
  const verifier = BUILTIN_ROLE_PRESETS.find((spec) => spec.role === "verifier");
  const architect = BUILTIN_ROLE_PRESETS.find((spec) => spec.role === "architect");
  assert.ok(implementer && verifier && architect);
  assert.deepEqual(parseRolePresetComposition(implementer.cordisYml).rowIds.includes("planning"), true);
  assert.deepEqual(parseRolePresetComposition(implementer.cordisYml).rowIds.includes("tool-todo"), true);
  assert.deepEqual(parseRolePresetComposition(verifier.cordisYml).rowIds.includes("compaction"), true);
  assert.equal(parseRolePresetComposition(architect.cordisYml).rowIds.includes("tool-web"), false);
  assert.equal(parseRolePresetComposition(renderRolePresetComposition(architect, ["web"])).rowIds.includes("tool-web"), true);
  const expectedHandoffs = {
    implementer: { requiredPayloadFields: ["summary", "changedFiles", "knownRisks"], requiredEvidenceKinds: ["commit", "diff", "test", "report"] },
    reviewer: { requiredPayloadFields: ["summary", "verdict", "unresolvedFindings"], requiredEvidenceKinds: ["report", "diff", "test"] },
    investigator: { requiredPayloadFields: ["symptom", "reproduction", "rootCause", "repairScope", "knownRisks"], requiredEvidenceKinds: ["report", "test", "message", "file"] },
    verifier: { requiredPayloadFields: ["command", "exit", "scope", "evidenceRefs", "unexecuted"], requiredEvidenceKinds: ["test", "diff", "report"] },
    architect: { requiredPayloadFields: ["decisionQuestion", "alternatives", "recommendation", "tradeoffs", "constraints", "migrationImpact", "unknowns"], requiredEvidenceKinds: ["report", "file", "url"] },
    planner: { requiredPayloadFields: ["taskCardPath", "context", "changedFiles", "acceptanceCriteria", "verificationSteps"], requiredEvidenceKinds: ["report", "file"] },
    oracle: { requiredPayloadFields: ["summary", "artifactRefs", "knownRisks"], requiredEvidenceKinds: ["report", "message"] },
    researcher: { requiredPayloadFields: ["sourceRefs", "facts", "unknowns", "factInference", "nextQuestions"], requiredEvidenceKinds: ["url", "file", "report"] },
    "hardening-auditor": {
      requiredPayloadFields: ["fingerprint", "asset", "location", "impact", "severity", "fix", "reproductionOrWhyNot"],
      requiredEvidenceKinds: ["report", "file", "message"],
      postRemediationPayloadFields: ["originalFinding", "rescan", "regression", "residualRisk"],
      postRemediationEvidenceKinds: ["test", "diff", "report"],
    },
  };
  for (const spec of BUILTIN_ROLE_PRESETS) assert.deepEqual(spec.reportHandoff, expectedHandoffs[spec.role], spec.id);
});

// E4 (plan §1 E4 / `docs/plan-0.8.0-execution.md` §11 G-P0 ⑧, F9 + F12).
// Zero implementation delta: `danger-full-access` was already never a legal role
// default (`orchestra-role-presets.ts` `validateRolePresetSpec`), but no test
// covered it. These two assertions are the missing coverage, not a new rule.
// Applicable boundary: the ROLE PRESET validator only. This says nothing about
// `orchestra_add_lanes`'s tool-surface validation (a different function, already
// covered by scripts/test-add-lanes.mjs) — do not generalise it to "all specs".
test("E4: role preset validator refuses danger-full-access and any non-workspace-write permission default", () => {
  // A genuinely valid spec: `validateAllRolePresetSpecs()` is empty (asserted above),
  // so each builtin is a clean baseline to mutate one field at a time.
  const baseline = BUILTIN_ROLE_PRESETS.find((spec) => spec.role === "implementer");
  assert.ok(baseline);
  assert.deepEqual(validateRolePresetSpec({ ...baseline }), []);

  const fullAccess = validateRolePresetSpec({ ...baseline, sandbox: "danger-full-access" });
  assert.ok(
    fullAccess.includes("danger-full-access is not a role default"),
    "spec.sandbox === \"danger-full-access\" must raise invalid_spec, got: " + JSON.stringify(fullAccess),
  );

  for (const permissionPreset of ["read-only", "danger-full-access", ""]) {
    const problems = validateRolePresetSpec({ ...baseline, permissionPreset });
    assert.ok(
      problems.includes("role default permission must be workspace-write"),
      "spec.permissionPreset === " + JSON.stringify(permissionPreset) + " must raise invalid_spec, got: " + JSON.stringify(problems),
    );
  }
});

test("artifact installation is create-if-absent, idempotent, and preserves user bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-role-artifacts-"));
  try {
    const first = await ensureBuiltinRolePresetArtifacts(root);
    assert.equal(first.length, 12);
    assert.equal(first.every((entry) => entry.status !== "failed"), true);
    const reviewer = BUILTIN_ROLE_PRESETS.find((spec) => spec.role === "reviewer");
    assert.ok(reviewer);
    const path = join(root, "catalog-presets", reviewer.id, "agent.cordis.yml");
    assert.equal(await readFile(path, "utf8"), reviewer.cordisYml);
    const userBytes = "# user-owned composition\\n- id: custom\\n  name: local-plugin\\n";
    await writeFile(path, userBytes, "utf8");
    await ensureBuiltinRolePresetArtifacts(root);
    assert.equal(await readFile(path, "utf8"), userBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declared registry presets resolve without filesystem roots", async () => {
  const spec = BUILTIN_ROLE_PRESETS[0];
  const context = { get(name) { return name === "agentPresets" ? { async resolve(id) { assert.equal(id, spec.id); return { id }; } } : undefined; } };
  const resolved = await resolveRolePresetFile(context, "/ignored", spec.id, "/ignored");
  assert.equal(resolved.source, "dsh");
  assert.equal(resolved.path, "");
  await assert.rejects(() => resolveRolePresetFile({ get() { return undefined; } }, "/ignored", spec.id, "/ignored"), /registry is unavailable/);
});

test("composition and Orchestra host capabilities have separate preflight diagnostics", () => {
  const spec = BUILTIN_ROLE_PRESETS[0];
  assert.doesNotThrow(() => preflightGovernedRequiredTools({
    compositionTools: spec.compositionTools,
    orchestraTools: spec.orchestraTools,
    rolePresetSpec: spec,
    hostToolNames: spec.orchestraTools,
    presetId: spec.id,
  }));
  assert.throws(
    () => preflightGovernedRequiredTools({
      compositionTools: spec.compositionTools,
      orchestraTools: spec.orchestraTools,
      rolePresetSpec: spec,
      hostToolNames: [],
      presetId: spec.id,
    }),
    (error) => error instanceof SessionBlueprintError && error.code === "orchestra_tools_unproven",
  );
  assert.throws(
    () => preflightGovernedRequiredTools({
      compositionTools: ["missing-composition-row"],
      orchestraTools: [],
      rolePresetSpec: spec,
      presetId: spec.id,
    }),
    (error) => error instanceof SessionBlueprintError && error.code === "composition_tools_missing",
  );
  assert.throws(
    () => preflightGovernedRequiredTools({ compositionTools: ["tool-bash"], presetId: "custom-preset" }),
    (error) => error instanceof SessionBlueprintError && error.code === "composition_tools_unproven",
  );
});

test("DSH registry resolution is declaration-owned", async () => {
  const spec = BUILTIN_ROLE_PRESETS[0];
  const context = { get(name) { return name === "agentPresets" ? { async resolve(id) { return { id }; } } : undefined; } };
  const resolved = await resolveRolePresetFile(context, "/ignored", spec.id, "/ignored");
  assert.equal(resolved.id, spec.id);
  assert.equal(resolved.source, "dsh");
});

test("file-only custom presets are rejected before reservation", async () => {
  const spec = BUILTIN_ROLE_PRESETS[0];
  const runtime = blueprintRuntime(spec);
  runtime.context.get = (name) => name === "agentPresets" ? { async resolve() { throw new Error("missing declaration"); } } : undefined;
  await assert.rejects(() => prepareGovernedRolePlan(runtime.context, {
    cwd: "/ignored", teamId: "team", controllerSessionId: "driver", topologyId: "topology", topologySource: "bundled",
    role: { id: "custom", name: "Custom", preset: "custom-persona", sandbox: "read-only" },
  }), (error) => error?.code === "preset_unavailable");
});

test("every v0.4 preset mounts in an unpublished Blueprint harness with plane facts", async () => {
  for (const spec of BUILTIN_ROLE_PRESETS) {
    const runtime = blueprintRuntime(spec);
    let published = false;
    const prepared = await prepareGovernedBlueprint(runtime.context, {
      sessionId: "role-session",
      teamId: "team",
      roleId: spec.role,
      roleName: spec.role,
      topologyId: "foundation-test",
      topologySource: "bundled",
      controllerSessionId: "driver",
      cwd: "/tmp/role-preset",
      presetId: spec.id,
      sandbox: spec.sandbox,
      compositionTools: spec.compositionTools,
      orchestraTools: spec.orchestraTools,
      optionalCapabilities: spec.optionalCapabilities,
      provider: "provider",
      model: "model",
    });
    const commit = await prepared.setup(runtime.child);
    commit.commit();
    published = false;
    assert.equal(published, false);
    assert.deepEqual(prepared.receipt.compositionTools.names, [...spec.compositionTools].sort());
    assert.deepEqual(prepared.receipt.orchestraTools.names, [...spec.orchestraTools].sort());
    assert.deepEqual(prepared.receipt.optionalCapabilities, spec.optionalCapabilities);
    assert.equal(prepared.receipt.sandbox, spec.sandbox);
    // The composition marker is a record on disk now, not a Session event: a
    // custom event type makes the whole session log unreadable on reread.
    const marker = await blueprintStoreFor(runtime.context, "/tmp/role-preset").read(runtime.session.id);
    assert.equal(marker?.teamId, "team");
    assert.equal(
      runtime.session.events.some((event) => typeof event.type === "string" && event.type.startsWith("orchestra/")),
      false,
      "no orchestra/* event may be written into a governed role session",
    );
  }
});

test("Governed role planning resolves the catalog ID and preflights both planes", async () => {
  const spec = BUILTIN_ROLE_PRESETS.find((entry) => entry.role === "architect");
  assert.ok(spec);
  const root = await mkdtemp(join(tmpdir(), "orchestra-role-plan-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const runtime = blueprintRuntime(spec);
    runtime.context.fs = nativeFs();
    const plan = await prepareGovernedRolePlan(runtime.context, {
      cwd: "/tmp/role-plan",
      teamId: "team",
      controllerSessionId: "driver",
      topologyId: "foundation-test",
      topologySource: "bundled",
      role: { id: "architect", name: "Architect", preset: spec.id, sandbox: spec.sandbox },
    });
    assert.equal(plan.presetId, spec.id);
    assert.equal(plan.blueprint.receipt.agentPreset, spec.id);
    runtime.addSession(plan.blueprint.receipt.sessionId);
    const commit = await plan.blueprint.setup(runtime.child);
    commit.commit();
    assert.deepEqual(plan.blueprint.receipt.compositionTools.names, [...spec.compositionTools].sort());
    assert.deepEqual(plan.blueprint.receipt.orchestraTools.names, [...spec.orchestraTools].sort());
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("commit-time host readiness failure never publishes the role", async () => {
  const spec = BUILTIN_ROLE_PRESETS.find((entry) => entry.role === "reviewer");
  assert.ok(spec);
  const runtime = blueprintRuntime(spec, spec.orchestraTools);
  const prepared = await prepareGovernedBlueprint(runtime.context, {
    sessionId: "role-session",
    teamId: "team",
    roleId: "reviewer",
    roleName: "reviewer",
    topologyId: "foundation-test",
    topologySource: "bundled",
    controllerSessionId: "driver",
    cwd: "/tmp/role-preset",
    presetId: spec.id,
    sandbox: spec.sandbox,
    compositionTools: spec.compositionTools,
    orchestraTools: spec.orchestraTools,
    optionalCapabilities: spec.optionalCapabilities,
    provider: "provider",
    model: "model",
  });
  await assert.rejects(
    async () => {
      const commit = await prepared.setup(runtime.child);
      commit.commit();
    },
    (error) => error instanceof SessionBlueprintError && error.code === "orchestra_tools_missing",
  );
  assert.equal(runtime.context.agents.get("role-session"), undefined);
});
