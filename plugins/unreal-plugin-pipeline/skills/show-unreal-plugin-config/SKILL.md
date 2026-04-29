---
name: show-unreal-plugin-config
description: Open or generate the Unreal Plugin Pipeline visual dashboard for the current Unreal plugin project.
---

# Show Unreal Plugin Config

Use this skill to display the Unreal Plugin Pipeline dashboard. When opened through the normal dashboard command, the panel can save project and global config changes through a loopback-only local server.

## Workflow

1. Find the target `.uplugin` under the current workspace.
2. Locate this plugin bundle's `scripts/unreal-plugin-pipeline.mjs`.
3. Run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle-root>/scripts/invoke-unreal-plugin-pipeline.ps1" -PipelineCommand dashboard -ProjectRoot "<project-root>"`
4. Summarize where the dashboard was written and what it shows: project files, engine selection, copyable commands, output directory, Run action state, and editable global/project config.
