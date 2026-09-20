/**
 * S3 — a role preset is mounted from its SOURCE, through one function.
 *
 * ## Why this test is shaped this way
 *
 * `mountRolePreset` chooses between the engine's two mounting APIs, and the choice
 * is the whole point:
 *
 *  - a preset the ROSTER knows (the `dsh` source, and `builtin` too once §7 makes
 *    the catalog a roster root) must go through `agentPresets.mount(ctx, id)`,
 *    because that is what discovers, standing-mounts and records an identity the
 *    resume path can find again;
 *  - a `project` / `global` OVERRIDE file must go through `mountPreset(ctx, preset)`,
 *    because it lives outside every roster root and has no id to resolve.
 *
 * Before S3 four call sites each decided this for themselves and the reactivation
 * path always chose the file API — including for presets the roster knew, which is
 * exactly how a cold-resumed role came back with an empty global layer instead of
 * its composition.
 *
 * Driving that through a real composition is not possible in a unit test, so the
 * two mount APIs are injectable seams on the input and the test asserts WHICH one
 * ran for a given preset source. That is the behaviour under test.
 *
 * ## Anchoring
 *
 * Every assertion below is on a symbol or on observed behaviour. No assertion
 * compares a count to a count; where a count is printed it is labelled a
 * diagnostic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mountRolePreset, RolePresetMountError } from "../lib/role-preset-mount.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(join(REPO, relative), "utf8");

/** Non-comment source lines, so prose about a symbol is never read as a use. */
function codeLines(source) {
  return source.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
  });
}

/**
 * A minimal agent scope context. Only the two members production actually
 * touches are real; everything else is absent on purpose, because the function
 * under test must not depend on more than this.
 */
function scopeContext() {
  const calls = [];
  return {
    calls,
    agentCtx: {
      get(name) {
        calls.push({ api: "agentCtx.get", name });
        return undefined;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------

test("S3: an override file mounts through the file API, and the roster is not consulted", async () => {
  const { agentCtx, calls } = scopeContext();
  const mounted = [];
  const rosterMounts = [];

  const result = await mountRolePreset(agentCtx, {
    presetId: "team-preset",
    overrideFile: { id: "team-preset", trust: "user", path: "/project/.orchestra/presets/team-preset/agent.cordis.yml" },
    mountByFile: async (ctx, file) => {
      mounted.push(file);
      return file.id;
    },
    mountById: async (_ctx, id) => {
      rosterMounts.push(id);
    },
  });

  assert.equal(result.mountedBy, "file");
  assert.equal(result.presetId, "team-preset");
  assert.equal(mounted.length, 1, "the file API must run exactly once for an override");
  assert.equal(mounted[0].path, "/project/.orchestra/presets/team-preset/agent.cordis.yml");
  assert.deepEqual(rosterMounts, [], "an override must not also be mounted by id");
});

test("S3: a preset with no override mounts BY ID through the roster, and no file is read", async () => {
  const { agentCtx, calls } = scopeContext();
  const rosterMounts = [];
  const fileMounts = [];

  const result = await mountRolePreset(agentCtx, {
    presetId: "orchestra-v04-implementer-v1",
    roster: {
      async mount(ctx, id) {
        rosterMounts.push({ ctx, id });
        return { id, trust: "system", path: "/Users/x/.dsh/orchestra/catalog-presets/orchestra-v04-implementer-v1/agent.cordis.yml" };
      },
    },
    mountByFile: async (_ctx, file) => {
      fileMounts.push(file);
    },
  });

  assert.equal(result.mountedBy, "id");
  assert.equal(result.presetId, "orchestra-v04-implementer-v1");
  assert.equal(rosterMounts.length, 1, "the roster API must run exactly once");
  assert.equal(rosterMounts[0].id, "orchestra-v04-implementer-v1");
  assert.deepEqual(fileMounts, [], "a roster preset must not be composed from a file path");

  // The measured fact that keeps this function small: mounting by id never needs
  // the preset's path. Nothing here read a file, and the roster returned a path
  // that was ignored — so there is no `readFile(preset.path)` to assert against,
  // which is the honest form of the plan's "no path is generated" requirement.
  assert.deepEqual(
    calls.filter((entry) => entry.name === "agentPresets"),
    [],
    "the caller's roster wins; the agent context is not consulted for it",
  );
});

test("S3: with neither an override nor any roster, the failure is typed and says why", async () => {
  const { agentCtx } = scopeContext();
  await assert.rejects(
    () => mountRolePreset(agentCtx, { presetId: "ghost-preset" }),
    (error) => {
      assert.equal(error instanceof RolePresetMountError, true);
      assert.equal(error.code, "preset_roster_unavailable");
      assert.match(error.message, /ghost-preset/);
      return true;
    },
    "an id with nothing to resolve it must fail loudly rather than mount nothing",
  );
});

// ---------------------------------------------------------------------------
// The call sites: one name, and only one file-API user
// ---------------------------------------------------------------------------

test("S3: every role-session mount site goes through mountRolePreset", async () => {
  const blueprint = await read("src/session-blueprint.ts");
  const orchestra = await read("src/orchestra.ts");

  for (const [name, source] of [["src/session-blueprint.ts", blueprint], ["src/orchestra.ts", orchestra]]) {
    const direct = codeLines(source).filter((line) => line.includes("mountPreset("));
    assert.deepEqual(direct, [], `${name} must not call the engine's mountPreset directly`);
    const viaEntry = codeLines(source).filter((line) => line.includes("mountRolePreset("));
    assert.notDeepEqual(viaEntry, [], `${name} must mount role presets through mountRolePreset`);
  }

  // Only the module that OWNS the decision may import the file API. If another
  // file imports `mountPreset` from the package, a second decision has appeared.
  const sourceFiles = (await readdir(join(REPO, "src"))).filter((entry) => entry.endsWith(".ts"));
  const importers = [];
  for (const file of sourceFiles) {
    const source = await read(`src/${file}`);
    if (codeLines(source).some((line) => /import\s*\{[^}]*\bmountPreset\b/.test(line))) importers.push(file);
  }
  assert.deepEqual(
    importers,
    ["role-preset-mount.ts"],
    "exactly the mount module may import the engine's mountPreset; a second importer means a second decision point",
  );
});

test("S3: no code selects a MOUNT API from a `presetSource === \"file\"` branch any more", async () => {
  // The plan's criterion 3, as a grep assertion inside the test, narrowed to what
  // it actually forbids: a branch that CHOOSES HOW TO MOUNT based on the source.
  //
  // Two remaining `presetSource === "file"` reads exist and are deliberately NOT
  // flagged — they read a persisted blueprint MARKER to validate or reconstruct
  // it, which is a property of a stored record, not a mount decision:
  //   a2a-transport.ts      reconstructs an override file from the marker
  //   session-blueprint.ts  validates that a marker's file fields are coherent
  // Flagging those would be asserting the wrong thing, and would push a future
  // maintainer to delete a validation to satisfy a test.
  const MOUNT_SYMBOL = /mountRolePreset|mountPreset|presets\.mount|agentPresets\.mount/;
  const sourceFiles = (await readdir(join(REPO, "src"))).filter((entry) => entry.endsWith(".ts"));
  const offenders = [];
  for (const file of sourceFiles) {
    const source = await read(`src/${file}`);
    for (const line of codeLines(source)) {
      if (/presetSource\s*===\s*["']file["']/.test(line) && MOUNT_SYMBOL.test(line)) {
        offenders.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "no mount decision may branch on presetSource === \"file\"");
});
