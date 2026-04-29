---
name: detect-unreal-engines
description: Detect local Unreal Engine installations and show the effective build plan for the current Unreal plugin project.
---

# Detect Unreal Engines

Use this skill to show the configured Unreal Engine installations and the filtered build plan for the current plugin project.

## Workflow

1. Find the target `.uplugin` under the current workspace.
2. Locate this plugin bundle's `scripts/unreal-plugin-pipeline.mjs`.
3. Run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle-root>/scripts/invoke-unreal-plugin-pipeline.ps1" -PipelineCommand detect-engines -ProjectRoot "<project-root>"`
4. Summarize detected versions, excluded versions, and the final build order.
