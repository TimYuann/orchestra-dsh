---
name: orchestra-teams
description: Use for /team, an explicitly requested Governed Orchestra team, or dispatching, extending, restoring or archiving an existing Orchestra team. Not for ordinary A2A collaboration or delegation.
---

# Optional governed teams

A2A works without a team. Use this workflow only when the user requests a governed team or an existing team's work needs it. The driver owns user discussion and final synthesis; role Sessions own their assigned work.

## Create and dispatch

1. Establish the goal, scope, constraints and concrete completion check from the conversation and project. Ask only about missing decisions that change the work.
2. Load `orchestration-principles` for team design and `orchestra_topologies` for the available role presets. Compose the smallest useful graph, including reachable handoffs, one closure owner and bounded review rounds. Reuse declared presets; load `orchestra-preset-authoring` only when a required composition is missing.
3. Persist the proposal with `orchestra_draft`. Show its exact draft revision and digest, roles, backends, model choices and permission boundaries.
4. Ask the user to approve that proposal with a plain yes (启动 / 可以 / ok). Only a genuine user reply or `/team approve` produces approval. The model cannot approve itself. Create with the resulting exact `frozenRef`.
5. Dispatch self-contained tasks with `orchestra_dispatch`. Copy `charterRef` and `authorityRef` from `orchestra_team`'s `charter_ref` and `approval_ref`. Mint and retain a `dispatchId` before calling: retry identical intent with the same id and content, use a new id for new intent. Include the brief, responsibility, scope, checks and result recipient; bind fixed Profile/method content when required. A reserved role materializes on first dispatch; a role with an undelivered dispatch rejects a second one.
6. Continue independent work while roles run. When only replies remain, end the turn. `orchestra_wait` is for headless/scripted loops, not interactive waiting. Verify actual reports and team state when results arrive; acceptance receipts are not task completion.

## Extend or recover

One active Orchestra team per working directory. For another objective in the same project, use `orchestra_add_lanes`: preview the mission, scope, participants, ownership and completion check, show the plan, then apply with `confirm:true` only after the user agrees. Reuse suitable participants. An unrelated objective needs a discussion, not a silent scope change.

Use `orchestra_team` for state and archives, `orchestra_activate` to recover an archive, `a2a_read` for bounded conversation history, and `a2a_stop` to cancel a stuck Session. Stop/archival failures remain failures; do not force an archive past them.

## Close

The driver checks objective facts and reports verified results, remaining work and blockers. Role self-reports do not replace evidence. Close the team with `orchestra_dismiss` after its work is finished; it stops roles before archiving and retains their durable Sessions. A graph declaration does not enforce review limits, deadlines, professional acceptance or release authority.
