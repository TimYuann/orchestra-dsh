# Demo fixture: the §7.2 first-batch handoff chain

This directory is the FIXED INPUT of the first-batch live demonstration. It is
not shipped (`files` in package.json excludes `scripts/`); it exists so the demo
task's failure observation is byte-reproducible.

## What the demo proves

Plan §7.2: a real approved Team → a Driver dispatch under a real frozen charter
→ a Session worker that actually receives the bound Profile/method text → it
submits this Task's result (or an explicit block) → the runtime commits the
report plus the pending-notice fact in one Team state change → the Driver is
notified and reads it → after a restart the same delegation and the unfinished
step are still locatable → the Driver states the next move.

It proves the HANDOFF. It does not prove the task was independently evaluated,
authorized for release, or formally closed.

## The task

`src/slugify.mjs` carries one seeded defect: the separator pattern maps every
non-alphanumeric character to its own dash instead of collapsing the run.

    node --test test/slugify.test.mjs     # FAILS: 'hello---world----again'
    # apply methods/local-defect-feedback-loop.md
    node --test test/slugify.test.mjs     # PASSES

No network, no external effect, and the observation is deterministic.

## Input identity

Every file the dispatch binds is copied VERBATIM into the workspace and its
sha256 is recorded in the dispatch's method binding and fixed-input brief. The
method text comes from the accepted TPW commit:

    git -C <tim-professional-workflow> show f5d6d0547459eb15c40aec25617418d5ea4710e6:professional-workflow/methods/local-defect-feedback-loop.md
    # sha256 0feec14d81db315262f79a9709a67b08d621d8833e3e28ad9c55beedc90a8bd2
