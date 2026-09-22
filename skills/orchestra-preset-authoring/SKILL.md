---
name: orchestra-preset-authoring
description: Create and verify a native DSH declared preset when dispatch wording, an existing skill or an installed preset cannot supply the required capabilities.
---
# Author a role capability composition

## Decide whether a preset is needed

Keep task-specific goals, files and completion conditions in dispatch. Use an existing skill for a method, or an installed preset for existing capabilities. Create a preset only when a durable, different composition is needed. Native children inherit the parent composition; an independent preset needs a Session.

Explain the capability gap and proposed tools, permission boundary, model/cost and installation location. Reuse existing authorization; get user approval before expanding it. Members keep approval `never` and send questions to the driver. A persona or tool filter is not a sandbox.

## Declare using the target's native mechanism

For DSH 0.1.7, load the available native `editing-cordis-compositions`, `cordis-plugin-development` and `cordis-composition-reference` skills for patch placement and plugin configuration. If those skills are absent, inspect the installed target package's docs/schema rather than guessing. Do not revive filesystem preset roots or add another preset registry.

Add a row to an authorized bundle's patch. Use a unique declaration row id and preset id. This example provides file inspection tools; **the read-only boundary is selected separately when creating the role**:

```yaml
- insert:
    - id: preset-example-evidence-reader
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: example-evidence-reader
        name: Example evidence reader
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                Answer the assigned question with cited observations. Distinguish
                facts, inference and unknowns. Report blockers and the evidence
                to the driver; proposing a change does not authorize making it.
              complete: false
              includeRuntimeContext: true
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
```

Keep `complete: false` so persona does not suppress host tool/environment guidance. Add only necessary capability plugins. Put approval/sandbox/cwd/model choices in the role creation contract, not in persona. Explicit node model choices take precedence; verify actual driver inheritance when omitting a model.

For a bundle you maintain, include the patch in its published files and native bundle composition. For another installed bundle or profile, follow its ownership and install procedure; do not silently edit Orchestra's package-owned declarations or a production profile. Never install a second copy of host `@deepseek-ai/*` runtime dependencies into a profile.

## Verify the actual role

1. Resolve the new id through `agentPresets.resolve(id)` in the target host. Check the composed plugin inventory, not merely YAML parsing.
2. Create a **new Session** with the declared preset and intended approval/sandbox/cwd/model. Check actual persona and tool schemas, then exercise the required capability with a harmless task. For read-only roles, include a harmless denied-write test in an isolated test workspace.
3. On an authorized development instance, restart and resume that test Session. Confirm the retained preset identity, tools and enforced permission boundary still match; dispatch again.
4. Record the preset id, tested host version, capability results and remaining gaps. Static resolution is not proof of runtime or restart behavior. Mark unavailable runtime checks explicitly and leave adoption pending.

Existing Sessions have retained composition state. Do not promise hot replacement or silently repurpose an in-flight role. When the new preset requires a replacement instance, give it a self-contained handoff, retain the old instance's identity/history and verify the new one before sending work.
