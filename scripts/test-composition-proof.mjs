/**
 * Composition-proof acceptance for D2 (out-of-batch fix, Owner-authorized).
 *
 * THE DEFECT THIS PINS. `preflightGovernedRequiredTools` merged two different
 * namespaces into one set — `requiredTools` (TOOL NAMES: `read`, `edit`, `bash`)
 * and `compositionTools` (DSH composition ROW IDs: `tool-fs`, `tool-bash`) — and
 * then compared that union against the declared ROW IDs with a plain `includes`.
 * Any role that named a tool was therefore reported as missing every row and
 * could never pass, while the message blamed the declaration side. In the live
 * run this cost six rejected revisions of a real Team
 * (`docs/live-run-2026-10-04-first-batch.md`).
 *
 * WHAT IS ASSERTED
 *   1. a role declaring tool NAMES passes when the declared rows export those
 *      tools, or the host scope exposes them (the red case);
 *   2. a genuinely unprovable capability is STILL refused (the guard did not
 *      become vacuously true), for both planes;
 *   3. the neighbours the topology validator owns still refuse the same wrong
 *      placements (`compositionTools` with a host tool, `orchestraTools` with a
 *      composition tool name);
 *   4. the diagnostic names WHICH side is required, WHICH side is declared, and
 *      that the two are different namespaces.
 *
 * BOUNDARY: this is a pre-publication proof. It says the declared rows CAN
 * supply the named tools and the host scope exposes them; it does not say the
 * published session actually mounts them — that is verified after publication
 * (`toolReadiness`, `verifyGovernedAgent`) and is not claimed here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightGovernedRequiredTools } from "../lib/session-blueprint.js";
import { BUILTIN_ROLE_PRESETS } from "../lib/orchestra-role-presets.js";
import { validateTopology } from "../lib/orchestra-topology.js";

const IMPLEMENTER = BUILTIN_ROLE_PRESETS.find((spec) => spec.id === "orchestra-v04-implementer-v1");

function topologyWith(role) {
  return {
    schemaVersion: 1,
    id: "composition-proof",
    name: "composition proof",
    controller: { id: "driver", source: "caller" },
    roles: [{ id: "driver", name: "Driver" }, role],
    protocol: {
      ownership: { closure: "driver" },
      routes: [{ kind: "dispatch", from: "driver", to: [role.id] }],
      completion: { owner: "driver", rule: "done" },
    },
  };
}

test("D2/a: a role declaring tool NAMES is proven by the declared rows, not rejected as missing rows", () => {
  assert.notEqual(IMPLEMENTER, undefined, "the catalog preset this case binds must exist");
  assert.doesNotThrow(() =>
    preflightGovernedRequiredTools({
      presetId: IMPLEMENTER.id,
      rolePresetSpec: IMPLEMENTER,
      compositionTools: IMPLEMENTER.compositionTools,
      orchestraTools: IMPLEMENTER.orchestraTools,
      requiredTools: ["read", "edit", "write", "bash", "grep", "glob"],
      hostToolNames: IMPLEMENTER.orchestraTools,
    }),
  );

  // Same role, but the composition rows are the proof: no host scope needed for
  // a composition tool, because the declared row exports it.
  assert.doesNotThrow(() =>
    preflightGovernedRequiredTools({
      presetId: IMPLEMENTER.id,
      rolePresetSpec: IMPLEMENTER,
      compositionTools: IMPLEMENTER.compositionTools,
      orchestraTools: IMPLEMENTER.orchestraTools,
      requiredTools: ["bash"],
      // The host scope deliberately contains only Orchestra names here, so the
      // proof for `bash` can only come from the declared composition ROW.
      hostToolNames: IMPLEMENTER.orchestraTools,
    }),
  );

  // A tool name the host scope exposes is also provable, even when no declared
  // row exports it (`read_image` belongs to the fs row, but the host naming it is
  // on its own a proof that the name exists in this deployment).
  assert.doesNotThrow(() =>
    preflightGovernedRequiredTools({
      presetId: IMPLEMENTER.id,
      rolePresetSpec: IMPLEMENTER,
      compositionTools: IMPLEMENTER.compositionTools,
      // No Orchestra tool is declared here, so the only plane under test is the
      // tool NAME one.
      orchestraTools: [],
      requiredTools: ["read_image"],
      hostToolNames: ["read_image"],
    }),
  );
});

test("D2/b: a capability that cannot be proven is still refused on BOTH planes", () => {
  assert.throws(
    () =>
      preflightGovernedRequiredTools({
        presetId: IMPLEMENTER.id,
        rolePresetSpec: IMPLEMENTER,
        compositionTools: IMPLEMENTER.compositionTools,
        orchestraTools: IMPLEMENTER.orchestraTools,
        requiredTools: ["no-such-tool"],
        hostToolNames: IMPLEMENTER.orchestraTools,
      }),
    (error) => error?.code === "composition_tools_missing" && /no-such-tool/.test(error.message),
    "an unprovable TOOL NAME must still be refused",
  );

  assert.throws(
    () =>
      preflightGovernedRequiredTools({
        presetId: IMPLEMENTER.id,
        rolePresetSpec: IMPLEMENTER,
        compositionTools: ["no-such-row"],
        orchestraTools: IMPLEMENTER.orchestraTools,
        hostToolNames: IMPLEMENTER.orchestraTools,
      }),
    (error) => error?.code === "composition_tools_missing" && /no-such-row/.test(error.message),
    "an undeclared ROW ID must still be refused",
  );

  assert.throws(
    () => preflightGovernedRequiredTools({ compositionTools: ["tool-bash"], presetId: "custom-preset" }),
    (error) => error?.code === "composition_tools_unproven",
    "no declaration at all is still 'unproven', not 'missing'",
  );

  assert.throws(
    () => preflightGovernedRequiredTools({ presetFile: { id: "p", trust: "user", path: "/tmp/p.yml" }, requiredTools: ["read"] }),
    (error) => error?.code === "required_tools_unproven",
    "requiredTools with no composition/orchestra declaration at all keeps its own diagnostic",
  );
});

test("D2/c: the topology neighbours still refuse the same wrong placements", () => {
  const compositionProblems = validateTopology(
    topologyWith({ id: "worker", name: "Worker", compositionTools: ["orchestra_report"] }),
  );
  assert.ok(
    compositionProblems.some((problem) => /compositionTools cannot contain host transport\/orchestra tools/.test(problem)),
    `compositionTools must still refuse host tool names: ${JSON.stringify(compositionProblems)}`,
  );

  const orchestraProblems = validateTopology(
    topologyWith({ id: "worker", name: "Worker", orchestraTools: ["read"] }),
  );
  assert.ok(
    orchestraProblems.some((problem) => /orchestraTools must use Orchestra host tool names/.test(problem)),
    `orchestraTools must still refuse composition tool names: ${JSON.stringify(orchestraProblems)}`,
  );
});

test("D2/d: the diagnostic says which side is required, which is declared, and that they differ", () => {
  const error = (() => {
    try {
      preflightGovernedRequiredTools({
        presetId: IMPLEMENTER.id,
        rolePresetSpec: IMPLEMENTER,
        compositionTools: IMPLEMENTER.compositionTools,
        orchestraTools: IMPLEMENTER.orchestraTools,
        requiredTools: ["no-such-tool"],
        hostToolNames: IMPLEMENTER.orchestraTools,
      });
      return undefined;
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.notEqual(error, undefined, "the case must refuse");
  assert.match(error.message, /requiredTools are TOOL NAMES/);
  assert.match(error.message, /DIFFERENT namespace/);
  assert.match(error.message, /compositionTools ROW IDs/);
  assert.ok(error.details?.required?.includes("no-such-tool"), "the diagnostic keeps the required names");
  assert.ok(Array.isArray(error.details?.declared), "and the declared rows it compared against");
});
