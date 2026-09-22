import test from "node:test";
import assert from "node:assert/strict";
import { preparseDraftRoleFacts, renderDraftBlueprintTable } from "../lib/orchestra.js";
import { resolveDraftRoleModel } from "../lib/session-blueprint.js";

function draftRuntimeContext() {
  const known = new Set(["orchestra-v04-implementer-v1", "orchestra-v04-reviewer-v1"]);
  return {
    fs: { async readText() { throw new Error("legacy model preference files must not be read"); } },
    get(name) {
      if (name === "agentPresets") return { async resolve(id) {
        if (!known.has(id)) throw new Error(`unknown preset ${id}`);
        return { id };
      } };
      if (name === "permissionPresets") return {
        defaultPreset: "workspace", resolve: () => ({ sandbox: "workspace-write", approval: "ask" }),
      };
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "default-p", model: "default-m", reasoningEffort: "low" }) };
      return undefined;
    },
  };
}

const caller = { options: { provider: "driver-p", model: "driver-m", reasoningEffort: "high" } };

for (const role of [
  { id: "architect", execution: "subagent" },
  { id: "implementer", preset: "orchestra-v04-implementer-v1", sandbox: "workspace-write" },
]) {
  test(`draft ${role.id} inherits the driver's actual model and reasoning, not deployment or role tier`, async () => {
    const facts = await preparseDraftRoleFacts(draftRuntimeContext(), "/tmp/model-test", role, caller);
    assert.equal(facts.provider, "driver-p");
    assert.equal(facts.model, "driver-m");
    assert.equal(facts.reasoningEffort, "high");
    assert.match(renderDraftBlueprintTable([facts]), /driver-p\/driver-m/);
  });
}

test("explicit node route wins without borrowing the driver's reasoning level", async () => {
  const facts = await preparseDraftRoleFacts(draftRuntimeContext(), "/tmp/model-test", {
    id: "scout", execution: "subagent", runtime: { provider: "node-p", model: "node-m" },
  }, caller);
  assert.equal(facts.provider, "node-p");
  assert.equal(facts.model, "node-m");
  assert.equal(facts.reasoningEffort, undefined);
});

test("deployment route is only a fallback when the driver has no selected route", () => {
  assert.deepEqual(resolveDraftRoleModel(draftRuntimeContext(), {}), {
    provider: "default-p", model: "default-m", reasoningEffort: "low",
  });
});

test("partial explicit node selection is rejected rather than silently inherited", () => {
  assert.throws(() => resolveDraftRoleModel(draftRuntimeContext(), { runtime: { model: "partial" }, caller }), /provider and model/);
  assert.throws(() => resolveDraftRoleModel(draftRuntimeContext(), { runtime: { reasoningEffort: "high" }, caller }), /requires provider and model/);
});
