import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePreferences,
  resolveTierForRole,
  resolveModelForRole,
  readPreferences,
  writePreferences,
  DEFAULT_PREFERENCES,
} from "../lib/orchestra-preferences.js";
import {
  preparseDraftRoleFacts,
  renderDraftBlueprintTable,
} from "../lib/orchestra.js";

function draftRuntimeContext(options = {}) {
  const known = new Set(["orchestra-v04-implementer-v1", "orchestra-v04-reviewer-v1", "orchestra-v04-verifier-v1"]);
  const fs = {
    async resolve(path, opts = {}) {
      return { key: `${opts.cwd ?? ""}:${path}`, displayPath: `${opts.cwd ?? ""}/${path}` };
    },
    async stat() {
      return undefined;
    },
    async readText() {
      throw Object.assign(new Error("missing"), { code: "FS_NOT_FOUND" });
    },
  };
  const permissionSpecs = {
    workspace: { sandbox: "workspace-write", approval: "ask" },
    safe: { sandbox: "read-only", approval: "ask" },
  };
  const permissions = {
    defaultPreset: "workspace",
    resolve(name) {
      if (permissionSpecs[name] === undefined) throw new Error(`unknown permission ${name}`);
      return permissionSpecs[name];
    },
  };
  const presets = {
    async resolve(id) {
      if (!known.has(id)) throw new Error(`unknown preset ${id}`);
      return { id, trust: "system", path: "" };
    },
  };
  return {
    fs,
    get(name) {
      if (name === "agentPresets") return presets;
      if (name === "permissionPresets") return permissions;
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "default-p", model: "default-m" }) };
      return undefined;
    },
  };
}

test("validatePreferences validates correct preferences and rejects malformed objects", () => {
  assert.equal(validatePreferences(DEFAULT_PREFERENCES), true);

  // Invalid schemaVersion
  assert.equal(validatePreferences({ ...DEFAULT_PREFERENCES, schemaVersion: 2 }), false);

  // Missing tier
  const missingTier = {
    schemaVersion: 1,
    tiers: {
      high_intelligence: { provider: "deepseek", model: "deepseek-reasoner" },
      standard_work: { provider: "deepseek", model: "deepseek-chat" },
    },
  };
  assert.equal(validatePreferences(missingTier), false);

  // Empty provider or model
  const emptyProvider = {
    schemaVersion: 1,
    tiers: {
      ...DEFAULT_PREFERENCES.tiers,
      high_intelligence: { provider: "", model: "deepseek-reasoner" },
    },
  };
  assert.equal(validatePreferences(emptyProvider), false);

  // Invalid roleMapping tier
  const invalidMapping = {
    schemaVersion: 1,
    tiers: DEFAULT_PREFERENCES.tiers,
    roleMapping: {
      architect: "ultra_super_tier",
    },
  };
  assert.equal(validatePreferences(invalidMapping), false);
});

test("resolveTierForRole correctly classifies roles by default and honors custom roleMapping", () => {
  // Built-in defaults
  assert.equal(resolveTierForRole("architect"), "high_intelligence");
  assert.equal(resolveTierForRole("planner"), "high_intelligence");
  assert.equal(resolveTierForRole("oracle"), "high_intelligence");
  assert.equal(resolveTierForRole("driver"), "high_intelligence");

  assert.equal(resolveTierForRole("implementer"), "standard_work");
  assert.equal(resolveTierForRole("reviewer"), "standard_work");
  assert.equal(resolveTierForRole("coder"), "standard_work");

  assert.equal(resolveTierForRole("verifier"), "fast_verification");
  assert.equal(resolveTierForRole("tester"), "fast_verification");
  assert.equal(resolveTierForRole("code_audit"), "fast_verification");

  // Custom mapping
  const customPrefs = {
    schemaVersion: 1,
    tiers: DEFAULT_PREFERENCES.tiers,
    roleMapping: {
      reviewer: "fast_verification",
      specialist: "high_intelligence",
    },
  };
  assert.equal(resolveTierForRole("reviewer", customPrefs), "fast_verification");
  assert.equal(resolveTierForRole("specialist", customPrefs), "high_intelligence");
});

test("resolveModelForRole returns explicit runtime if provided, else resolves tier config", () => {
  const customPrefs = {
    schemaVersion: 1,
    tiers: {
      high_intelligence: { provider: "openai", model: "o1", reasoningEffort: "high" },
      standard_work: { provider: "anthropic", model: "claude-3-7-sonnet", reasoningEffort: "medium" },
      fast_verification: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
    },
  };

  // 1. Role has explicit runtime -> explicit wins
  const explicit = resolveModelForRole(
    "architect",
    { provider: "google", model: "gemini-2.5-pro", reasoningEffort: "high" },
    customPrefs,
  );
  assert.deepEqual(explicit, { provider: "google", model: "gemini-2.5-pro", reasoningEffort: "high" });

  // 2. High intelligence role -> resolved from customPrefs
  const archModel = resolveModelForRole("architect", undefined, customPrefs);
  assert.deepEqual(archModel, { provider: "openai", model: "o1", reasoningEffort: "high" });

  // 3. Standard work role
  const impModel = resolveModelForRole("implementer", undefined, customPrefs);
  assert.deepEqual(impModel, { provider: "anthropic", model: "claude-3-7-sonnet", reasoningEffort: "medium" });

  // 4. Fast verification role
  const verModel = resolveModelForRole("verifier", undefined, customPrefs);
  assert.deepEqual(verModel, { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" });
});

test("readPreferences and writePreferences handle project file and global fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-prefs-"));
  const projectRoot = join(root, "project");
  const globalRoot = join(root, "global");

  try {
    // Initially no preferences exist
    const initial = await readPreferences(projectRoot, { globalRoot });
    assert.equal(initial, undefined);

    // Write global preferences
    const globalPrefs = {
      schemaVersion: 1,
      tiers: {
        high_intelligence: { provider: "global-provider", model: "global-high" },
        standard_work: { provider: "global-provider", model: "global-std" },
        fast_verification: { provider: "global-provider", model: "global-fast" },
      },
    };
    await writePreferences(projectRoot, globalPrefs, { global: true, globalRoot });

    // readPreferences should now resolve global fallback
    const fromGlobal = await readPreferences(projectRoot, { globalRoot });
    assert.ok(fromGlobal);
    assert.equal(fromGlobal.tiers.high_intelligence.model, "global-high");

    // Write project-specific preferences
    const projectPrefs = {
      schemaVersion: 1,
      tiers: {
        high_intelligence: { provider: "proj-provider", model: "proj-high" },
        standard_work: { provider: "proj-provider", model: "proj-std" },
        fast_verification: { provider: "proj-provider", model: "proj-fast" },
      },
    };
    await writePreferences(projectRoot, projectPrefs);

    // readPreferences should now resolve project preferences (precedence over global)
    const fromProject = await readPreferences(projectRoot, { globalRoot });
    assert.ok(fromProject);
    assert.equal(fromProject.tiers.high_intelligence.model, "proj-high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preparseDraftRoleFacts applies preferences to blueprint facts and table rendering", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-prefs-test-"));
  const projectRoot = join(root, "project");

  try {
    const customPrefs = {
      schemaVersion: 1,
      tiers: {
        high_intelligence: { provider: "custom-cloud", model: "mega-brain", reasoningEffort: "high" },
        standard_work: { provider: "custom-cloud", model: "worker-bee", reasoningEffort: "medium" },
        fast_verification: { provider: "custom-cloud", model: "quick-eye", reasoningEffort: "low" },
      },
    };
    await writePreferences(projectRoot, customPrefs);

    const ctx = draftRuntimeContext();

    const architectRole = {
      id: "architect",
      name: "Architect",
      execution: "subagent",
      phase: "planning",
      lane: "architecture",
    };

    const implementerRole = {
      id: "implementer",
      name: "Implementer",
      preset: "orchestra-v04-implementer-v1",
      sandbox: "workspace-write",
      phase: "execution",
      lane: "main",
    };

    // Preparse with preferences
    const archFacts = await preparseDraftRoleFacts(ctx, projectRoot, architectRole, customPrefs);
    assert.equal(archFacts.provider, "custom-cloud");
    assert.equal(archFacts.model, "mega-brain");
    assert.equal(archFacts.reasoningEffort, "high");

    const impFacts = await preparseDraftRoleFacts(ctx, projectRoot, implementerRole, customPrefs);
    assert.equal(impFacts.provider, "custom-cloud");
    assert.equal(impFacts.model, "worker-bee");
    assert.equal(impFacts.reasoningEffort, "medium");

    // Table rendering contains the tiered models and reasoning efforts
    const table = renderDraftBlueprintTable([archFacts, impFacts]);
    assert.ok(table.includes("custom-cloud/mega-brain"));
    assert.ok(table.includes("custom-cloud/worker-bee"));
    assert.ok(table.includes("| high |"));
    assert.ok(table.includes("| medium |"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
