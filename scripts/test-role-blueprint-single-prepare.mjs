/**
 * S1b: one entry point for preparing a role blueprint.
 *
 * ## What S1b actually delivers, and what it does NOT
 *
 * S1's criteria 1 and 3 were expected to go green here. They do not, and this
 * file states why rather than papering over it:
 *
 *  - **criterion 1** ("all three paths execute the same setup function") and
 *  - **criterion 3** ("all three paths' blueprint records have the same field set")
 *
 * both presuppose that all three paths PRODUCE a blueprint. Measured, they do
 * not: only the first-wave path prepares one. The lazy path resolves a preset
 * file and calls `buildRoleSession({kind:"create"})` with no blueprint, and the
 * reactivation replacement path does the same — `createSession` in those shapes
 * mounts the preset raw and publishes no receipt. So there is no setup function
 * and no record to compare on two of the three paths.
 *
 * Giving those two paths a blueprint is what D2 is for (a pinned blueprint is
 * exactly the thing that carries `approval: "never"`), so criteria 1 and 3 stay
 * open until D2 lands. Claiming them now would be the "formally complete, really
 * not" failure this project keeps naming.
 *
 * What S1b DOES deliver is the prerequisite those criteria need: preparation now
 * has ONE name and ONE dispatch point (`prepareRoleBlueprint`), so when D2 gives
 * the other two paths a blueprint there is exactly one function for them to call.
 *
 * ## Anchoring discipline
 *
 * Assertions here are anchored on **symbols and behaviour**, not on line counts.
 * A count-based assertion already failed once in this repository's P0 work: a
 * regex anchored on `await buildRoleSession(ctx, {` matched 4 sites while the
 * real number was 5, because two sites use different syntax. Counts are printed
 * as diagnostics; they are never the assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepareRoleBlueprint, prepareGovernedBlueprint, prepareLightweightBlueprint } from "../lib/session-blueprint.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(join(REPO, relative), "utf8");

/** Non-comment source lines, so prose about a symbol is never mistaken for a use. */
function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    });
}

// ---------------------------------------------------------------------------
// The entry point exists, is a real function, and dispatches on mode
// ---------------------------------------------------------------------------

test("S1b: prepareRoleBlueprint is exported and is the dispatch point for both planes", async () => {
  assert.equal(typeof prepareRoleBlueprint, "function", "the single entry point must be exported");
  assert.equal(typeof prepareGovernedBlueprint, "function");
  assert.equal(typeof prepareLightweightBlueprint, "function");

  // Dispatch is by `mode`, and it is a real branch: an unknown mode must not
  // silently fall through to a plane. The throw is the contract.
  await assert.rejects(
    () => prepareRoleBlueprint({}, { mode: "neither", sessionId: "s" }),
    (error) => error instanceof Error && error.name === "SessionBlueprintError",
    "an unrecognised mode must fail loudly rather than default into a plane",
  );
});

test("S1b: both role-session build paths in the source call prepareRoleBlueprint, not a plane function", async () => {
  const a2a = await read("src/a2a.ts");
  const orchestra = await read("src/orchestra.ts");

  // The lightweight call site (inside buildRoleSession's own module) and the
  // governed call site must both spell the dispatcher.
  const a2aUses = codeLines(a2a).filter((line) => line.includes("prepareRoleBlueprint("));
  const orchestraUses = codeLines(orchestra).filter((line) => line.includes("prepareRoleBlueprint("));
  assert.notDeepEqual(a2aUses, [], "a2a.ts must prepare blueprints through the dispatcher");
  assert.notDeepEqual(orchestraUses, [], "orchestra.ts must prepare blueprints through the dispatcher");

  // And neither may reach a plane function directly any more: that is the whole
  // point of the collapse, and it is asserted on the symbol rather than a count.
  for (const [name, source] of [["src/a2a.ts", a2a], ["src/orchestra.ts", orchestra]]) {
    const direct = codeLines(source).filter(
      (line) => line.includes("prepareLightweightBlueprint(") || line.includes("prepareGovernedBlueprint("),
    );
    assert.deepEqual(direct, [], `${name} must not call a plane prepare function directly`);
  }

  // Print the real call-site census as a diagnostic (never as the assertion).
  const census = codeLines(orchestra).filter((line) => line.includes("buildRoleSession("));
  assert.notDeepEqual(census, [], "orchestra.ts must call the session entry point");
});

// ---------------------------------------------------------------------------
// The one shared piece the criteria rest on: `setup`
// ---------------------------------------------------------------------------

test("S1b: both planes carry a setup of the same shape, which is what criterion 1 will compare", async () => {
  // This is the precondition, stated as a fact about the TYPES rather than as a
  // claim that the three paths already agree. Both prepared shapes expose
  // `setup`, `agentOptions` and `meta`; only `receipt` differs, and it differs
  // because a governed role names its place in a team and a lightweight
  // collaborator has no team. Those eleven extra fields are NOT invented for the
  // lightweight plane — see the header of this file.
  const source = await read("src/session-blueprint.ts");
  const declared = source.match(/readonly setup: \(agentCtx: Context, agent: Agent\) => Promise<AgentSetupCommit>;/g) ?? [];
  assert.equal(
    declared.length,
    2,
    "both prepared-blueprint interfaces must declare the same setup signature (2 interfaces), " +
      `found ${declared.length}`,
  );

  // The canonical receipt fields that a governed role record carries, and that a
  // lightweight record legitimately does not.
  const governedOnly = [
    "teamId",
    "roleId",
    "controllerSessionId",
    "topologyId",
    "topologySource",
    "approval",
    "effectivePermissionPreset",
    "sandbox",
    "compositionTools",
    "orchestraTools",
    "optionalCapabilities",
  ];
  // NOTE: `LightweightBlueprintReceipt` is declared FIRST (line ~112), governed
  // at ~150. An earlier version of this test sliced the other way round and got
  // an empty string — caught because the assertion failed, not by reading.
  const governedStart = source.indexOf("export interface GovernedBlueprintReceipt");
  assert.notEqual(governedStart, -1, "GovernedBlueprintReceipt must be declared");
  const governedEnd = source.indexOf("\n}", governedStart);
  const governed = source.slice(governedStart, governedEnd);
  for (const field of governedOnly) {
    assert.ok(governed.includes(`${field}:`), `GovernedBlueprintReceipt must declare ${field}`);
  }
});

// ---------------------------------------------------------------------------
// The blocker, asserted so it cannot be forgotten
// ---------------------------------------------------------------------------

test("S1b: criteria 1 and 3 are BLOCKED on D2 — two of the three paths build no blueprint at all", async () => {
  const orchestra = await read("src/orchestra.ts");
  const code = codeLines(orchestra);

  // The durable signal: only ONE `buildRoleSession` spec is handed a prepared
  // blueprint. The first wave passes `governedBlueprint`; the lazy create, the
  // lazy resume fallback and the reactivation replacement pass none, so
  // `createSession` mounts the preset raw and publishes no receipt. With no
  // receipt there is no `setup` to compare (criterion 1) and no record field set
  // to compare (criterion 3) on those two paths.
  //
  // When D2 gives them a blueprint this assertion flips, and criteria 1 and 3
  // become assertable. That is the intended failure mode: it is a TODO with a
  // tripwire, not a claim that they hold.
  const specsWithBlueprint = code.filter((line) => line.includes("governedBlueprint:"));
  assert.equal(
    specsWithBlueprint.length,
    1,
    `exactly one buildRoleSession spec passes a governedBlueprint today (the first wave); found ${specsWithBlueprint.length}. ` +
      "More than one means D2 has landed — criteria 1 and 3 should now be written.",
  );

  // The role record itself already branches on "no receipt": `reservedRole` is a
  // SHARED factory (first-wave plans and reactivation both build records through
  // it) and it spreads `blueprint` only when a receipt exists. So even the record
  // shape is conditional today. Printed as a diagnostic; not asserted, because a
  // count here says nothing a reader can act on.
  const receiptBranches = code.filter((line) => line.includes("receipt === undefined"));
  assert.notDeepEqual(
    receiptBranches,
    [],
    "the record factory is expected to branch on the absence of a receipt while D2 is outstanding",
  );
});
