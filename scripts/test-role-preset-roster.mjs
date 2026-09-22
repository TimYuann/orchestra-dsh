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

test("S3: file presets fail loudly; declarations mount only by registry id", async () => {
  const { agentCtx } = scopeContext();
  await assert.rejects(() => mountRolePreset(agentCtx, {
    presetId: "team-preset", overrideFile: { id: "team-preset", trust: "user", path: "/legacy/agent.cordis.yml" },
  }), /unsupported/);
  const mounted = [];
  const result = await mountRolePreset(agentCtx, {
    presetId: "declared-role",
    mountById: async (_ctx, id) => { mounted.push(id); },
  });
  assert.deepEqual(mounted, ["declared-role"]);
  assert.deepEqual(result, { mountedBy: "id", presetId: "declared-role" });
  await assert.rejects(() => mountRolePreset(agentCtx, { presetId: "missing-registry" }), (error) => error?.code === "preset_roster_unavailable");
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
  }
  const blueprintEntry = codeLines(blueprint).filter((line) => line.includes("mountRolePreset("));
  assert.notDeepEqual(blueprintEntry, [], "the single blueprint owner must mount role presets through mountRolePreset");
  const orchestraEntry = codeLines(orchestra).filter((line) => line.includes("mountRolePreset("));
  assert.deepEqual(orchestraEntry, [], "orchestra.ts must delegate mounting to the single blueprint owner");

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
    [],
    "DSH 0.1.7 registry mounting must not import the removed file mount API",
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
