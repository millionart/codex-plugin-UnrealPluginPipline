---
name: build-unreal-plugin
description: Build and package the current Windows Unreal Engine plugin across configured engine versions in the current Codex conversation. Use when the user wants a one-click Unreal plugin release build with failure analysis, code fixes, retries, and zip output.
---

# Build Unreal Plugin

Use this skill for the primary release build entry point. It is intended to behave like a current-conversation action button: do the work in this thread, do not spawn a new Codex conversation, and do not use `.codex/environments/environment.toml`.

## Workflow

1. Find the target `.uplugin` under the current workspace.
2. Locate this plugin bundle's `scripts/unreal-plugin-pipeline.mjs`.
3. Run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle-root>/scripts/invoke-unreal-plugin-pipeline.ps1" -PipelineCommand detect-engines -ProjectRoot "<project-root>"`
4. Build versions from low to high with:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle-root>/scripts/invoke-unreal-plugin-pipeline.ps1" -PipelineCommand build-only -ProjectRoot "<project-root>" --engine-version <version>`
5. If a build fails, inspect the output-directory `logs` folder and the smallest useful Unreal Automation Tool, compiler, or packaging error.
6. Fix the project source or descriptor, retry the same version, and continue only after it passes.
7. Do not reset or revert user changes. Do not use destructive git operations.
8. Write or update `<output-directory>/reports/last-release-report.md` with built versions, zip paths, fixes made, and blockers.

## Defaults

- Windows only.
- Use the project and global Unreal Plugin Pipeline config files.
- Preserve the current conversation as the control loop.
- Use direct `build-only` commands for each engine version so failures stay visible in this thread.
- Keep pipeline logs and release reports under the configured output directory, not under the project `.codex` directory.
