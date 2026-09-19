import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTopology,
  createTopologyCatalog,
  resolveRoleExecution,
  roleSummary,
} from "../lib/orchestra-topology.js";
import { renderDraftBlueprintTable } from "../lib/orchestra.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class MinimalFs {
  async resolve(path) {
    return { targetKey: path, displayPath: path };
  }
  processPath(target) {
    return target.displayPath;
  }
  async stat() {
    return undefined;
  }
  async listDir() {
    return [];
  }
  async readText() {
    return "";
  }
}

test("validateTopology accepts topologies with phases, lanes, and role phase/lane assignments", () => {
  const topo = {
    schemaVersion: 1,
    id: "lane-test",
    name: "Lane Test",
    phases: [
      { id: "alpha", name: "Phase Alpha", description: "First phase" },
      { id: "beta", name: "Phase Beta" },
    ],
    lanes: [
      { id: "lane-1", name: "Lane 1", description: "Primary lane" },
      { id: "lane-2", name: "Lane 2" },
    ],
    roles: [
      {
        id: "worker-1",
        name: "Worker 1",
        preset: "orchestra-worker",
        sandbox: "workspace-write",
        phase: "alpha",
        lane: "lane-1",
      },
      {
        id: "worker-2",
        name: "Worker 2",
        preset: "orchestra-worker",
        sandbox: "read-only",
        phase: "beta",
        lane: "lane-2",
      },
    ],
    protocol: {
      phases: [
        { id: "alpha", name: "Protocol Alpha" },
      ],
      lanes: [
        { id: "lane-1", name: "Protocol Lane 1" },
      ],
      ownership: { scope: "driver", closure: "driver" },
      routes: [{ kind: "work", from: "driver", to: ["worker-1", "worker-2"] }],
      completion: { owner: "driver", rule: "All done" },
    },
  };

  const problems = validateTopology(topo);
  assert.deepEqual(problems, []);
  assert.equal(topo.phases?.length, 2);
  assert.equal(topo.lanes?.length, 2);
  assert.equal(topo.roles[0].phase, "alpha");
  assert.equal(topo.roles[0].lane, "lane-1");
  assert.equal(topo.protocol?.phases?.length, 1);
  assert.equal(topo.protocol?.lanes?.length, 1);
});

test("built-in architect-dev topology resolves and has correct phases, lanes, and role mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-lane-test-"));
  const projectRoot = join(root, "project");
  const globalRoot = join(root, "global");
  const fs = new MinimalFs();
  try {
    const catalog = createTopologyCatalog(fs, { globalRoot });
    const resolved = await catalog.resolve(projectRoot, "architect-dev");
    assert.equal(resolved.kind, "ready");
    assert.equal(resolved.source, "bundled");

    const config = resolved.config;
    assert.equal(config.id, "architect-dev");
    assert.equal(config.name, "Architect Development");

    // Check phases and lanes
    assert.deepEqual(config.phases?.map((p) => p.id), ["planning", "execution", "verification"]);
    assert.deepEqual(config.lanes?.map((l) => l.id), ["architecture", "main", "review"]);

    // Check roles
    const roles = config.roles;
    assert.equal(roles.length, 3);

    const architect = roles.find((r) => r.id === "architect");
    assert.ok(architect);
    assert.equal(architect.phase, "planning");
    assert.equal(architect.lane, "architecture");
    assert.equal(resolveRoleExecution(architect), "session");

    const implementer = roles.find((r) => r.id === "implementer");
    assert.ok(implementer);
    assert.equal(implementer.phase, "execution");
    assert.equal(implementer.lane, "main");
    assert.equal(resolveRoleExecution(implementer), "session");

    const reviewer = roles.find((r) => r.id === "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.phase, "verification");
    assert.equal(reviewer.lane, "review");
    assert.equal(resolveRoleExecution(reviewer), "session");
    assert.equal(reviewer.sandbox, "read-only");

    // Check roleSummary preserves phase and lane
    const summary = roleSummary(architect);
    assert.equal(summary.phase, "planning");
    assert.equal(summary.lane, "architecture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderDraftBlueprintTable renders 10 columns when phase/lane present, 9 columns when absent", () => {
  const baseRole = {
    roleId: "implementer",
    execution: "session",
    preset: "preset-imp",
    sandbox: "workspace-write",
    effectivePermissionPreset: "standard",
    provider: "deepseek",
    model: "chat",
    reasoningEffort: "medium",
    compositionTools: ["tool-fs"],
    orchestraTools: ["orchestra_report"],
  };

  // Case 1: No phase/lane declared
  const tableWithoutPhaseLane = renderDraftBlueprintTable([baseRole]);
  const headerLinesWithout = tableWithoutPhaseLane.split("\n");
  assert.ok(headerLinesWithout[0].includes("| 角色 | backend |"));
  assert.ok(!headerLinesWithout[0].includes("阶段/车道"));
  const colsWithout = headerLinesWithout[0].split("|").filter((c) => c.trim().length > 0);
  assert.equal(colsWithout.length, 9);

  // Case 2: Phase/lane declared
  const tableWithPhaseLane = renderDraftBlueprintTable([
    {
      ...baseRole,
      roleId: "architect",
      phase: "planning",
      lane: "architecture",
    },
  ]);
  const headerLinesWith = tableWithPhaseLane.split("\n");
  assert.ok(headerLinesWith[0].includes("| 角色 | 阶段/车道 | backend |"));
  const colsWith = headerLinesWith[0].split("|").filter((c) => c.trim().length > 0);
  assert.equal(colsWith.length, 10);
  assert.ok(headerLinesWith[2].includes("planning / architecture"));
});
