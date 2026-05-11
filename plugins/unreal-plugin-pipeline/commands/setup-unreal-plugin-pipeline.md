---
description: Set up Unreal plugin release packaging for the current project
argument-hint: [project-root]
allowed-tools: [Read, Glob, Grep, Bash, Write, Edit]
---

# Setup Unreal Plugin Pipeline

Set up Windows Unreal Engine plugin release packaging.

## Arguments

The user invoked this command with: $ARGUMENTS

## Workflow

1. Use the `unreal-plugin-pipeline` skill.
2. Resolve the target project root from `$ARGUMENTS` or the current workspace.
3. Confirm the root contains a `.uplugin` descriptor.
4. Run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup -ProjectRoot "<project-root>"`
5. If the user provided an output directory, configure it globally with `set-output --output "<dir>"`.
6. Report the generated plugin-local `.codex/unreal-plugin-pipeline.json` path. Do not report or create project-local script or runtime copy paths.
7. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand detect-engines -ProjectRoot "<project-root>"` so the user can see which versions will build.

## Output

Return the command names, config paths, detected engine versions, excluded versions, and output directory. Do not claim an independent Codex toolbar button was created.
