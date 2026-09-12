/**
 * The orchestration method, as the driver is taught it.
 *
 * What this plugin stores is higher-order than a DAG: it is HOW to design a
 * multi-agent advancement orchestration, and a graph is that method's product.
 * `/team` is a three-step pipeline — sketch the mission WITH the user, turn it
 * into a graph under these principles, then explain the graph and dispatch
 * only after the user approves — so the principles are the product, and a
 * graph drawn without them is just a shape.
 *
 * They are delivered twice, on purpose, because the two halves have different
 * jobs:
 *
 * - {@link PRINCIPLES_SECTION_TEXT} is a SHORT system-prompt section. It is
 *   present on every request, so it carries only the decisions that change what
 *   a driver does — never the reasoning behind them, which would be paid for on
 *   every single turn of every session.
 * - {@link PRINCIPLES_SKILL_CONTENT} is a skill body, loaded when the driver is
 *   actually about to decompose a mission. It carries the worked detail, the
 *   full checklist, and the why.
 *
 * The split is also the degradation story: a deployment that composes no skill
 * registry still gets the rules that matter, so the driver never silently loses
 * its discipline — it only loses the elaboration.
 *
 * @module orchestra-dsh/orchestration-principles
 */

import type { Context } from "@deepseek-ai/cordis";
// Type-only: pulls in the `ctx.skills` Context augmentation without a runtime
// import (the registry is provided by the host composition).
import type {} from "@deepseek-ai/dsh-skill";

/** Kebab-case identifier the model addresses this skill by. */
export const PRINCIPLES_SKILL_NAME = "orchestration-principles";

/** Prompt-section name; distinct from the tool guidance so it can be read on its own. */
export const PRINCIPLES_SECTION_NAME = "orchestra:principles";

/**
 * The rules that change behaviour, on every request.
 *
 * Kept deliberately short: anything a driver would only need while actively
 * decomposing belongs in the skill, not here.
 */
export const PRINCIPLES_SECTION_TEXT = [
  "Orchestra principles (the method behind /team; load the `orchestration-principles` skill before you decompose a mission):",
  "GRAPH: a bounded acyclic graph — finite nodes, every path finite. Loops are its ONLY back edge and every Loop must be bounded: an attempt cap plus three exits (pass / retry / capExhausted). No other back edge may exist. A mission usually has several Loops, each of 2-4 nodes; more nodes is not more rigour.",
  "NODES: one node, one decidable responsibility — if you cannot say in one sentence what makes it complete, split it. Split for ATTENTION (a focused context explores deeper), and merge two duties that need the same deep context rather than forcing a split.",
  "BACKEND: a node that needs its own Agent Preset, the ability to ask the user for approval, its own cwd, or a real read-only guarantee MUST be a session node; anything else is a cheaper subagent node. A subagent inherits the driver's composition and permission, so toolFilter narrows availability and is NOT a permission guarantee — never claim read-only for one.",
  "PRESET: when a node looks like it wants a role-specific preset, ASK THE USER whether to build that preset into the graph. It is their composition, their cost, and their call — do not decide it silently, and do not fall back to a generic node to avoid asking.",
  "REACHABILITY: a subagent node talks ONLY to the driver. Native delegation authorizes on the direct-parent edge alone, so a session node cannot message a subagent node and a subagent node cannot reach a session node. Route every exchange with a subagent node THROUGH the driver; any other edge describes a message that cannot be sent.",
  "EDGES: an edge is a contract — declare its kind and the payload fields it carries. The receiver must not need the sender's history to understand a handoff.",
  "AUTHORITY: exactly one owner per decision; two owners means none. The evaluator is never the author. The driver owns decisions but never fabricates a quality verdict.",
  "UNATTENDED: after approval and without the user, the run must still reach a definite terminal state. Every attempt has a deadline and an expiry closes it through an existing exit; limits are enforced by the runtime, not written as discipline in a welcome message; exceeding a limit reports an error rather than silently doing less; a gate that needs a human carries a pre-approved fallback or an explicit blocked/failed destination — never a silent hang; a wake-up must rest on a durable fact.",
  "BEFORE PROPOSING: check the mission's five parts are present (objective, scope, constraints, acceptance criteria, non-goals), every node decidable, backend choice justified per node, every edge contracted, one owner per decision, every Loop bounded with a live capExhaustedRoute, no unreachable node, and a closure that exactly one owner can declare. Then explain the graph in plain language: if you cannot explain it, it is not right yet.",
].join("\n");

/** The skill body: the same method with the reasoning and the full checklist. */
export const PRINCIPLES_SKILL_CONTENT = `# Orchestration Principles

Use this before you turn a mission into a graph, and again before you show it to the user.

${PRINCIPLES_SECTION_TEXT.split("\n").slice(1).join("\n")}

## The three steps, in order

1. **Sketch the mission WITH the user.** objective (one sentence), scope, constraints, acceptance criteria, non-goals. Ask for whichever is missing; never assume one the user did not give and that you cannot verify from the repository.
2. **Turn it into a graph** under the rules above.
3. **Explain it in natural language and get approval.** The explanation must let the user judge the plan without reading JSON: what each node does, who owns each decision, where the Loops are, why each one stops, where they are needed, and what happens when something fails. Approval is the ONLY hard gate: \`/team approve <draftId>@<revision>\`. Conversational agreement is not approval.

## Reachability: the driver is the hub

A sub-agent child is addressed only by its direct parent. Native delegation authorizes delivery on that adjacency edge alone, and the platform refuses a sub-agent child's session id on its generic Session routing. So:

- a **session node cannot message a sub-agent node** — it is not the parent;
- a **sub-agent node cannot message a session node** — its only partner is the driver.

Every exchange involving a sub-agent node therefore goes THROUGH the driver: the child reports to the driver, and the driver relays onward. Draw the edges that way, because the other version describes a message that can never be sent and will only show up as a stalled run.

## Presets are the user's call

When a node looks like it wants a role-specific preset, ask the user whether to build that preset into the graph. The preset is their composition and their cost, and the choice between a preset-carrying session node and a cheaper sub-agent node is exactly the trade-off they should make deliberately — not one you settle silently, and not a reason to quietly pick a generic node instead of asking.

## Why the backend rule is structural

A native sub-agent child of the driver joins the driver's LIVE Agent Preset — it cannot mount its own composition. Its approval policy is pinned to \`never\` at the delegation boundary, so its asks are rejected deterministically and it can never reach the user. Its sandbox mode is frozen from the driver's explicit override at that same boundary, so a declared read-only mode would simply not take effect. Per-child variation stops at persona, tool filter, and the model route.

That is why a read-only role MUST be a session: a role that believes it is read-only while it is not is a safety bug, not a configuration preference.

## Checking the graph before you propose

- [ ] the mission's five parts are all present, and the missing ones were asked for
- [ ] every node has a one-sentence completion condition
- [ ] every node needing its own preset, approval, cwd, or read-only is a **session**
- [ ] every edge declares a kind and its payload contract
- [ ] exactly one owner per decision, and no author evaluates their own work
- [ ] every Loop has an attempt cap, all three exits, and a live receiver for \`capExhaustedRoute\`
- [ ] no back edge exists outside a Loop
- [ ] every node lies on a path to Closure (no unreachable node)
- [ ] every Attempt has a deadline, and exceeding a limit reports rather than truncates
- [ ] every human gate has a pre-approved fallback or an explicit blocked/failed destination
- [ ] closure is checkable and exactly one owner can declare it
- [ ] **you can explain the whole graph in one plain-language pass** — if you cannot, it is not right yet
`;

/** What registration managed to install. */
export interface PrinciplesRegistration {
  /** Whether the skill body was registered (a deployment may compose no skill registry). */
  readonly skill: boolean;
}

/**
 * Register the method where a driver will actually meet it.
 *
 * The prompt section is registered whenever the deployment composes a system
 * prompt, because it IS the discipline and its absence would be silent. The
 * skill is registered opportunistically: a deployment that mounts no skill
 * registry loses the elaboration and keeps the rules, which is a bounded,
 * documented degradation rather than a hidden one.
 *
 * @param ctx - host context carrying the system-prompt and skill registries.
 * @returns which halves were installed.
 */
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
    // The registry's own vocabulary for a skill contributed by live code rather
    // than discovered on disk.
    source: "runtime",
    description:
      "How to design a multi-agent advancement orchestration: the graph rules (bounded acyclic graph, Loops as its only back edge), the node rules (one decidable responsibility, and which backend a node needs), edge and authority contracts, and the unattended-completion invariant.",
    whenToUse:
      "Load before decomposing a mission into a graph, before drafting a collaboration charter, and before explaining a plan to the user for approval.",
    content: PRINCIPLES_SKILL_CONTENT,
  });
  return { skill: true };
}
