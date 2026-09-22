---
name: orchestra-preset-authoring
description: Create a new DSH 0.1.7 declared preset only when an existing role, skill, or dispatch cannot meet the task.
---
# Orchestra preset authoring

Use this only after checking whether dispatch wording, an existing skill, or an existing declared preset solves the task. A new preset is justified only for a durable new capability composition; added tools, permissions, installation, or cost require user approval.

Load DSH's `editing-cordis-compositions`, `cordis-plugin-development`, and `cordis-composition-reference` skills before editing a declaration. DSH 0.1.7 has no preset-root authoring path: ship an installable bundle row, not a directory or another preset manager.

Keep persona, plugins/tools, permission/model choice, and task dispatch separate. An omitted per-role model inherits the driver. Do not use a tool filter as a sandbox guarantee.

Minimal declaration example (add it to the bundle patch, then install the bundle):
```yaml
- id: preset-example-evidence-reader
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: example-evidence-reader
    name: Example evidence reader
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: Gather cited observations for the assigned question; report uncertainty to the driver.
          complete: false
          includeRuntimeContext: true
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
```

Verify registry resolution, a new Session's persona/tools/approval/sandbox, and restart restoration. Existing Sessions retain their mounted revision: do not promise hot switching; create a new instance with a self-contained handoff when needed.
