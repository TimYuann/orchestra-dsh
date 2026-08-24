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
} from "../lib/orchestra-role-presets.js";
import { prepareGovernedBlueprint, preflightGovernedRequiredTools, SessionBlueprintError } from "../lib/session-blueprint.js";
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
    events,
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
    current(log) {
      const sandbox = [...log].reverse().find((event) => event.type === "sandbox/mode")?.data?.mode;
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
        append(type, data) {
          this.events.push({ type, data });
        },
      };
      sessionMap.set(id, extra);
      return extra;
    },
  };
}

test("catalog has seven versioned specs plus three explicit legacy specs", () => {
  assert.equal(BUILTIN_ROLE_PRESETS.length, 7);
  assert.equal(LEGACY_BUILTIN_ROLE_PRESETS.length, 3);
  assert.equal(ALL_BUILTIN_ROLE_PRESETS.length, 10);
  assert.deepEqual(validateAllRolePresetSpecs(), []);
  assert.equal(new Set(BUILTIN_ROLE_PRESETS.map((spec) => spec.id)).size, 7);
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

test("artifact installation is create-if-absent, idempotent, and preserves user bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-role-artifacts-"));
  try {
    const first = await ensureBuiltinRolePresetArtifacts(root);
    assert.equal(first.length, 10);
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

test("project/global precedence is fail-loud and legacy files remain resolvable", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-role-resolution-"));
  const project = await mkdtemp(join(tmpdir(), "orchestra-role-project-"));
  try {
    const spec = BUILTIN_ROLE_PRESETS[0];
    const projectPath = join(project, ".orchestra", "presets", spec.id, "agent.cordis.yml");
    await mkdir(join(project, ".orchestra", "presets", spec.id), { recursive: true });
    await writeFile(projectPath, spec.cordisYml, "utf8");
    const context = { fs: nativeFs(), get() { return undefined; } };
    const projectResolved = await resolveRolePresetFile(context, project, spec.id, root);
    assert.equal(projectResolved.source, "project");
    assert.equal(projectResolved.trust, "user");
    assert.equal(projectResolved.path, projectPath);

    await writeFile(projectPath, "not: a plugin list\\n", "utf8");
    await assert.rejects(
      () => resolveRolePresetFile(context, project, spec.id, root),
      (error) => error?.code === "composition_invalid",
    );

    const hostRow = spec.cordisYml + "\n- id: orchestra_report\n  name: orchestra_report\n";
    await writeFile(projectPath, hostRow, "utf8");
    await assert.rejects(
      () => resolveRolePresetFile(context, project, spec.id, root),
      (error) => error?.code === "composition_mismatch",
    );
    await rm(join(project, ".orchestra"), { recursive: true, force: true });
    const globalHostPath = join(root, "presets", spec.id, "agent.cordis.yml");
    await mkdir(dirname(globalHostPath), { recursive: true });
    await writeFile(globalHostPath, hostRow, "utf8");
    await assert.rejects(
      () => resolveRolePresetFile(context, project, spec.id, root),
      (error) => error?.code === "composition_mismatch",
    );
    await rm(join(root, "presets", spec.id), { recursive: true, force: true });
    const globalResolved = await resolveRolePresetFile(context, project, spec.id, root);
    assert.equal(globalResolved.source, "builtin");
    assert.equal(globalResolved.spec.id, spec.id);

    const legacy = LEGACY_BUILTIN_ROLE_PRESETS[1];
    const legacyPath = join(root, "presets", legacy.id, "agent.cordis.yml");
    await mkdir(join(root, "presets", legacy.id), { recursive: true });
    await writeFile(legacyPath, legacy.cordisYml, "utf8");
    assert.equal(await readFile(legacyPath, "utf8"), legacy.cordisYml);
    const legacyResolved = await resolveRolePresetFile(context, project, legacy.id, root);
    assert.equal(legacyResolved.source, "global");
    assert.equal(legacyResolved.spec.status, "legacy");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
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

test("DSH-native preset remains above catalog fallback after artifact seeding", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-role-native-root-"));
  const nativeRoot = await mkdtemp(join(tmpdir(), "orchestra-role-native-"));
  try {
    const spec = BUILTIN_ROLE_PRESETS[0];
    const nativePath = join(nativeRoot, "agent.cordis.yml");
    await writeFile(nativePath, spec.cordisYml, "utf8");
    const nativePresets = {
      async resolve(id) {
        return { id, trust: "system", path: nativePath };
      },
    };
    const context = {
      fs: nativeFs(),
      get(name) {
        return name === "agentPresets" ? nativePresets : undefined;
      },
    };
    await ensureBuiltinRolePresetArtifacts(root);
    const before = await resolveRolePresetFile(context, "/tmp/native-precedence", spec.id, root);
    await ensureBuiltinRolePresetArtifacts(root);
    const after = await resolveRolePresetFile(context, "/tmp/native-precedence", spec.id, root);
    assert.equal(before.source, "dsh");
    assert.equal(after.source, "dsh");
    assert.equal(before.path, nativePath);
    assert.equal(after.path, nativePath);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(nativeRoot, { recursive: true, force: true });
  }
});

test("unknown persona-only project preset fails Governed planning before reservation", async () => {
  const project = await mkdtemp(join(tmpdir(), "orchestra-role-persona-only-"));
  try {
    const presetPath = join(project, ".orchestra", "presets", "custom-persona", "agent.cordis.yml");
    await mkdir(dirname(presetPath), { recursive: true });
    await writeFile(presetPath, "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n", "utf8");
    const spec = BUILTIN_ROLE_PRESETS[0];
    const runtime = blueprintRuntime(spec);
    runtime.context.fs = nativeFs();
    await assert.rejects(
      () => prepareGovernedRolePlan(runtime.context, {
        cwd: project,
        teamId: "team-persona-only",
        controllerSessionId: "driver",
        topologyId: "foundation-test",
        topologySource: "bundled",
        role: { id: "custom", name: "Custom", preset: "custom-persona", sandbox: "read-only" },
      }),
      (error) => error?.code === "preset_unavailable" || error?.code === "composition_tools_unproven",
    );
    assert.equal(runtime.context.agents.get("custom"), undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
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
    assert.equal(runtime.session.events.some((event) => event.type === "orchestra/governed-blueprint"), true);
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
