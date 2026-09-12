import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_TOPOLOGIES } from "../lib/orchestra-topology.js";
import { milestoneNotice, notifyDriverMilestone, renderDraftBlueprintTable } from "../lib/orchestra.js";

function team(overrides = {}) {
  return {
    schemaVersion: 1,
    teamId: "team-cp8",
    status: "active",
    rootCwd: "/tmp/cp8",
    controllerSessionId: "driver-session",
    controllerHistory: [],
    topologyRef: { id: "trio", source: "bundled" },
    mission: { objective: "cp8", scope: [], constraints: [], acceptanceCriteria: [], nonGoals: [], context: "" },
    createdAt: 1,
    activatedFromArchiveId: null,
    roles: [],
    reports: [],
    ...overrides,
  };
}

test("milestoneNotice renders the five one-line milestone formats without sensitive fields", () => {
  assert.equal(milestoneNotice("team-1", "handoff", "candidate accepted: implementer → verifier"), "orchestra: team-1 handoff candidate accepted: implementer → verifier");
  assert.equal(milestoneNotice("team-1", "verdict", "FAIL: loop-x attempt 1 cap_exhausted"), "orchestra: team-1 verdict FAIL: loop-x attempt 1 cap_exhausted");
  assert.equal(milestoneNotice("team-1", "verdict", "PASS: loop-x attempt 2"), "orchestra: team-1 verdict PASS: loop-x attempt 2");
  assert.equal(milestoneNotice("team-1", "report", "written: orchestra/reports/review-R1.md"), "orchestra: team-1 report written: orchestra/reports/review-R1.md");
  assert.equal(milestoneNotice("team-1", "gate", "gate-1 resolved: approve"), "orchestra: team-1 gate gate-1 resolved: approve");
  assert.equal(milestoneNotice("team-1", "close", "completed"), "orchestra: team-1 close completed");
  // notice text is node-level only: it never embeds payload content or secrets
  const text = milestoneNotice("team-1", "handoff", "verdict accepted: reviewer → driver");
  assert.ok(!text.includes("password") && !text.includes("summary") && !text.includes("payload"));
});

test("renderDraftBlueprintTable emits a Markdown table with one row per role and a stable empty fallback", () => {
  const preview = [
    {
      roleId: "implementer",
      roleName: "Implementer",
      execution: "session",
      preset: "orchestra-v04-implementer-v1",
      presetSource: "bundled",
      sandbox: "workspace-write",
      permissionPreset: "workspace",
      effectivePermissionPreset: "workspace",
      provider: "p",
      model: "m",
      reasoningEffort: "medium",
      compositionTools: ["tool-bash", "tool-fs"],
      orchestraTools: ["orchestra_report", "orchestra_handoff"],
    },
    {
      roleId: "reviewer",
      roleName: "Reviewer",
      execution: "session",
      preset: "orchestra-v04-reviewer-v1",
      sandbox: "read-only",
      permissionPreset: "workspace",
      effectivePermissionPreset: "custom",
      provider: "p",
      model: "m",
      compositionTools: ["tool-fs", "tool-fs-search"],
      orchestraTools: ["orchestra_report", "orchestra_verdict"],
    },
    {
      // A subagent row carries no preset and no permission, and reports the
      // inherited sandbox honestly rather than borrowing a mode it cannot have.
      roleId: "scout",
      roleName: "Scout",
      execution: "subagent",
      sandbox: "inherited",
      provider: "p",
      model: "m",
      persona: "你是侦察节点。",
      toolFilter: { deny: ["write", "edit"] },
      compositionTools: [],
      orchestraTools: [],
    },
  ];
  const table = renderDraftBlueprintTable(preview);
  const lines = table.split("\n");
  assert.equal(lines[0], "| 角色 | backend | preset | sandbox | permission | model | reasoningEffort | compositionTools | orchestraTools |");
  assert.equal(lines[1], "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  // header + separator + 3 roles + blank + the subagent knob note
  // header + separator + 3 roles + a blank spacer + the subagent knob note
  assert.equal(lines.length, 7);
  assert.ok(lines[2].includes("| implementer | session | orchestra-v04-implementer-v1 | workspace-write | workspace | p/m | medium | tool-bash, tool-fs | orchestra_report, orchestra_handoff |"));
  assert.ok(lines[3].includes("| reviewer | session | orchestra-v04-reviewer-v1 | read-only | custom | p/m | - | tool-fs, tool-fs-search | orchestra_report, orchestra_verdict |"));
  assert.ok(lines[4].includes("| scout | subagent | - | inherited | - | p/m | - | - | - |"));
  assert.equal(lines[5], "");
  const note = lines[6];
  assert.ok(note.startsWith("- `scout`（subagent）"), note);
  assert.ok(note.includes("toolFilter deny=[write, edit]"), note);
  assert.ok(note.includes("persona 7 字符"), note);
  // empty preview falls back to header + separator only
  const empty = renderDraftBlueprintTable([]);
  assert.equal(empty.split("\n").length, 2);
  assert.equal(empty.split("\n")[0], lines[0]);
});

test("notifyDriverMilestone skips controller self-calls, delivers to the controller, and is best-effort", async () => {
  const delivered = [];
  const fakeDeliver = async (ctx, from, to, content, options) => {
    delivered.push({ from, to, text: content[0].text, wake: options?.wake });
  };
  const currentTeam = team();

  // controller's own call: no self-message
  await notifyDriverMilestone({}, currentTeam, currentTeam.controllerSessionId, "handoff", "x", fakeDeliver);
  assert.equal(delivered.length, 0);

  // role milestone reaches the controller with wake + the milestone text
  await notifyDriverMilestone({}, currentTeam, "reviewer-session", "verdict", "PASS: loop-1 attempt 2", fakeDeliver);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, "driver-session");
  assert.equal(delivered[0].from, "reviewer-session");
  assert.equal(delivered[0].text, "orchestra: team-cp8 verdict PASS: loop-1 attempt 2");
  assert.equal(delivered[0].wake, true);

  // delivery failure is caught: the tool-level caller never sees a rejection
  const failing = async () => {
    throw new Error("transport down");
  };
  await assert.doesNotReject(() => notifyDriverMilestone({}, currentTeam, "reviewer-session", "report", "written: r.md", failing));
  assert.equal(delivered.length, 1); // failed delivery added nothing
});

test("a notice that cannot be delivered becomes a durable fact, and a double failure is explained not swallowed", async () => {
  const currentTeam = team();
  const failing = async () => {
    throw new Error("transport down");
  };

  // 1) Delivery fails, recording succeeds: the failure is now on the log, so
  //    "the driver was never woken" stops being invisible on an unattended run.
  const recorded = [];
  await assert.doesNotReject(() =>
    notifyDriverMilestone({}, currentTeam, "reviewer-session", "verdict", "PASS: loop-1", {
      deliver: failing,
      recordFailure: async (fact) => {
        recorded.push(fact);
      },
    }),
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].milestone, "verdict");
  assert.equal(recorded[0].targetSessionId, currentTeam.controllerSessionId);
  assert.equal(recorded[0].reason, "transport down");
  assert.ok(recorded[0].failedAt > 0);

  // 2) A successful delivery records nothing: the notice IS the record.
  const untouched = [];
  await notifyDriverMilestone({}, currentTeam, "reviewer-session", "verdict", "PASS: loop-1", {
    deliver: async () => {},
    recordFailure: async (fact) => {
      untouched.push(fact);
    },
  });
  assert.equal(untouched.length, 0);

  // 3) Both paths fail. The caller still must not see a rejection (the notice is
  //    best-effort by contract), but the failure must not vanish either: the
  //    warning names BOTH reasons so a human can tell a quiet Team from a
  //    recording path that is itself broken.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await assert.doesNotReject(() =>
      notifyDriverMilestone({}, currentTeam, "reviewer-session", "verdict", "PASS: loop-1", {
        deliver: failing,
        recordFailure: async () => {
          throw new Error("state blocked: invalid_json");
        },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transport down/);
  assert.match(warnings[0], /state blocked: invalid_json/);
  assert.match(warnings[0], /no durable trace/);

  // 4) Without a recorder the legacy behavior is preserved: warn once, never throw.
  const legacy = [];
  console.warn = (...args) => legacy.push(args.join(" "));
  try {
    await assert.doesNotReject(() => notifyDriverMilestone({}, currentTeam, "reviewer-session", "report", "written: r.md", failing));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(legacy.length, 1);
  assert.match(legacy[0], /milestone notice to controller driver-session failed: transport down/);
});

test("all five task topologies carry the driver-progress reporting discipline in every role welcome", () => {
  const sentence = "每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展";
  for (const id of ["feature-development", "bug-diagnosis-and-fix", "architecture-decision", "refactor-and-migration", "audit-and-hardening"]) {
    const topology = BUILTIN_TOPOLOGIES.find((entry) => entry.id === id);
    assert.ok(topology, `${id} must be bundled`);
    for (const role of topology.roles) {
      assert.ok(role.welcome !== undefined && role.welcome.includes(sentence), `${id}/${role.id} welcome must carry the driver-progress discipline`);
      assert.ok(role.welcome.includes("a2a_reply") && role.welcome.includes("orchestra_handoff"), `${id}/${role.id} welcome must keep the reply/handoff discipline`);
    }
  }
});
