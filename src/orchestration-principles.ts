/** Thin driver guidance, with detailed methods loaded only when needed. */
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-skill";

export const PRINCIPLES_SKILL_NAME = "orchestration-principles";
export const PRESET_AUTHORING_SKILL_NAME = "orchestra-preset-authoring";
export const PRINCIPLES_SECTION_NAME = "orchestra:principles";

// Use the shipped playbook itself, not a second abbreviated runtime copy.
export const PRESET_AUTHORING_SKILL_CONTENT = readFileSync(
  new URL("../skills/orchestra-preset-authoring/SKILL.md", import.meta.url),
  "utf8",
);

export const PRINCIPLES_SECTION_TEXT = [
  "Orchestra: choose the smallest collaboration that meets the user's mission.",
  "MISSION: align the outcome, scope and success check; ask only about missing decisions that change the work. The driver owns user discussion and final synthesis.",
  "SCALE: work directly when enough; delegate bounded work to native subagents; use independent Sessions for separate capabilities or peer collaboration. Add a Team only when shared roles and lanes help. A small task needs no graph or task-card file.",
  "BACKEND: native children inherit the driver's composition/cwd; toolFilter narrows availability and is NOT a permission guarantee. Use Session for a separate preset, cwd or enforced read-only boundary. All members use approval never and route questions to the driver.",
  "LANES: discuss a new mission, then add its goal and completion conditions to the existing team's lanes; reuse suitable available members before reserving new ones. Keep the original mission and authorization intact.",
  "HANDOFF: give the next actor the goal, relevant inputs, constraints, success check and recipient. Reports distinguish verified results, remaining work and blockers. Name one closure owner; use independent checking when the task requires it.",
  "LIMITS: set a bounded retry/escalation path where needed. Current graph declarations do not enforce attempt caps or deadlines; use observed runtime facts, and report blocked work rather than inventing progress or approval.",
  "PRESETS: reuse authorized capabilities. For a new composition load orchestra-preset-authoring; for team design or scaling load orchestration-principles. Get approval for new scope, permissions or cost, not for every in-scope dispatch.",
].join("\n");

export const PRINCIPLES_SKILL_CONTENT = `# Right-sized orchestration

## Choose a working shape

Start with the outcome discussed with the user, the real constraints and a concrete success check. Infer routine details from evidence; ask about material unknowns. Explain the chosen shape in plain language. Use the smallest option that fits:

- **Direct**: the driver does bounded work. No team, mandatory graph, task-card file or extra reviewer.
- **Native subagent**: one or a few bounded investigations, implementations or checks using the driver's composition. Native children already have durable logs and continuation; persistence alone is not a reason for Session.
- **Independent Session / A2A**: a separate declared preset, execution cwd, enforced permission boundary, or peer-to-peer collaboration. A2A remains usable without an Orchestra team.
- **Team**: shared roles, mission lanes and explicit handoffs are useful. Start with the needed members, often one to three, then scale. Session and native-child seats may coexist. Existing topology entries without execution keep their Session meaning.
- **Host delivery layer**: a separately enabled, future deterministic delivery mechanism, not something available merely because a graph exists. Do not claim it currently runs evidence or gates Git changes. Risk and required guarantees, not headcount, determine whether it is needed.

A graph describes dependencies when they matter; it is not the entrance fee for work. Planner and architect are optional tools for unresolved scope or structural decisions, not required seats. Keep longer handoffs in the project's existing document locations when useful; no prescribed file for a short dispatch.

## Choose the backend honestly

A native child joins the driver's LIVE Agent Preset. Per-child persona, tool filter and model can vary; a tool filter does not enforce a filesystem boundary. Use a Session when a separate preset, cwd or read-only sandbox is required. Check the actual native contract before promising another per-child capability. Permissions are enforced by the host, not by role prose.

Both member types keep approval never. A member reports a question or denied operation to the driver, who resolves it within authorization or discusses a scope change with the user; a Session is not a back door to member approval UI.

Native continuation communication uses the direct-parent edge. Route exchanges involving a native child through its driver, using native child dispatch rather than generic A2A addressing. Independent Sessions can use A2A. Design handoffs only along reachable paths.

## Close the collaboration loop

Before dispatch, make clear: goal and scope; relevant inputs; success check; who receives the result. Add time/retry bounds for work that can loop, not as ceremony on every small task.

An implementer supplies the change and verification; a reviewer checks the assigned candidate when independent review is warranted; a verifier explains what execution evidence proves. These are responsibilities, not a requirement to spawn three agents. Read-only reviewers cannot execute checks that write build/cache files: route those checks to an appropriately authorized executor.

A receiver accepts a useful result, requests a specific correction, or escalates a concrete blocker. A report being filed does not itself prove success. If the bounded correction allowance is exhausted, surface the unresolved finding to the driver; never conceal a new blocking defect merely because it appeared late. The driver owns final synthesis, not invented quality verdicts.

Current graph attempt/cap fields are declarative. Observe actual tool results, reports and host lifecycle state; do not claim the runtime enforces graph deadlines or advances graph counters. Permission rejection, missing capability or uncertain external effects should become an explicit blocked outcome, not blind retries. Existing stop/archive tools must confirm stopping before success is reported.

## Grow an existing team

Discuss a new objective with the user and identify its relation to the running mission. Use orchestra_add_lanes to retain the lane's objective, scope, constraints, acceptance, relationship and participant ids. Preview and apply under the tool's approval contract. Preserve the original mission and already approved boundaries.

Reuse appropriate available roles when possible; a new lane need not add a member. Keep each dispatch self-contained and avoid overlapping writes or mixing unrelated active tasks into the same conversation. Reserve new roles only when needed; first dispatch materializes them. The board and recovered team record should still explain why the lane exists and who handles it.

A goal outside the project's execution/permission boundary is not silently absorbed into this team. Discuss a separate workspace or explicit boundary change. Do not claim canonical cross-worktree team discovery or future delivery governance unless that capability has actually been implemented and verified.

## Presets and approval

Reuse installed, authorized presets without repeatedly asking to rebuild them. When a real composition is missing, load orchestra-preset-authoring. Separate durable persona/capabilities from the current task. Explain any new tools, installation, permissions or cost before seeking the needed approval.

For an Orchestra charter, show the exact proposed scope, roles/backends and model choices, then use the existing approval flow. A user's actual reply is consent; the driver's prose or another member's message is not. Subsequent dispatch within that authorization does not require repeated approval. Changed goals or expanded authority do.

## Before dispatch

Check that the chosen capabilities can do the job, the recipient knows what done means, the next recipient/closure owner is clear, and unresolved prerequisites are visible. For a team, verify membership and approved scope; for direct work, simply proceed within the user's request.
`;

export interface PrinciplesRegistration {
  readonly skill: boolean;
}

export function registerOrchestrationPrinciples(ctx: Context): PrinciplesRegistration {
  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: PRINCIPLES_SECTION_NAME,
      order: 118,
      text: PRINCIPLES_SECTION_TEXT,
    });
  }
  const skills = ctx.get("skills");
  if (skills === undefined) return { skill: false };
  skills.register({
    name: PRINCIPLES_SKILL_NAME,
    source: "runtime",
    description: "Choose direct work, native children, independent Sessions or a Team; design reachable handoffs and add mission lanes without unnecessary seats.",
    whenToUse: "Load when choosing a collaboration shape, designing team handoffs, or adding a new mission to an active team.",
    content: PRINCIPLES_SKILL_CONTENT,
  });
  skills.register({
    name: PRESET_AUTHORING_SKILL_NAME,
    source: "runtime",
    description: "Create and verify a native DSH declared preset when an existing dispatch, skill or preset cannot supply the required capabilities.",
    whenToUse: "Load before proposing or authoring a new role capability composition; reuse existing presets for ordinary dispatch.",
    content: PRESET_AUTHORING_SKILL_CONTENT,
  });
  return { skill: true };
}
