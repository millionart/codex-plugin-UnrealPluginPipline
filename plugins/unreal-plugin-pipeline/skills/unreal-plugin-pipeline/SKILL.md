---
name: unreal-plugin-pipeline
description: Configure, build, package, install, and uninstall Windows Unreal Engine plugin Run actions from Codex. Use when the user wants Unreal plugin release builds, local Unreal Engine version detection, BuildPlugin packaging, output directory configuration, project setup, or install/uninstall of Run dropdown actions for a .uplugin project.
---

# Unreal Plugin Pipeline

Use this skill to wire a Windows Unreal Engine plugin project into Codex release packaging.

## Command Dispatch

- If the user says `install`, install Run dropdown actions with:
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-run-actions.ps1 -ProjectRoot "<project>"`
- If the user says `uninstall`, remove only this plugin's Run dropdown actions with:
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand uninstall -ProjectRoot "<project>"`
- Do not treat `install` as plain setup. Plain setup intentionally does not write Run dropdown actions.

## Supported Scope

- Windows only.
- Unreal Engine plugin projects with a `.uplugin` descriptor.
- `RunUAT.bat BuildPlugin` packaging.
- Project-local config for release packaging. Runtime commands use this plugin bundle's PowerShell launcher with `-ProjectRoot`.

Do not describe macOS or Linux support as available in this version.
Do not claim this plugin can create an independent Codex desktop toolbar button. Codex environment actions can be written only as an explicit compatibility fallback, and they appear under the built-in Run dropdown.

## Setup Workflow

1. Confirm the target directory contains a `.uplugin` descriptor.
2. Configure engine discovery if needed:
   - Add a scan root:
     `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-scan-root --root "D:\Epic\Epic Games"`
   - Add a single engine root:
     `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-engine-root --root "D:\Epic\Epic Games\UE_5.7"`
3. Set global output storage if the user wants a custom location:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand set-output --output "D:\UnrealPluginBuilds\{pluginName}"`
4. Exclude or re-include versions when requested:
   - Project exclusion:
     `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand exclude-version -ProjectRoot "<project>" --version 5.1`
   - Project include:
     `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand include-version -ProjectRoot "<project>" --version 5.1`
   - Add `--global` to apply the exclusion globally.
5. Run setup:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup -ProjectRoot "<project>"`
6. For a folder containing many plugins, run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup-all --root "<plugins-root>"`
7. If the user explicitly accepts using the built-in Run dropdown as a fallback, add `--wire-run-actions`.
8. To remove project-local Run dropdown wiring, run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand cleanup-run-actions -ProjectRoot "<project>"`
9. If the user says `install` while using this plugin, configure the Run dropdown by running:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-run-actions.ps1 -ProjectRoot "<project>"`
10. If the user says `uninstall`, remove only this plugin's Run dropdown block by running:
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand uninstall -ProjectRoot "<project>"`

## Commands

Setup writes the project config only. It does not copy scripts, wrappers, or runtime files into the target Unreal plugin project, and it does not write `.codex/environments/environment.toml` by default.

Project commands:

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand build -ProjectRoot "<project>"`: runs the automatic release workflow. In Codex Desktop it stays in the current conversation release loop; outside Codex Desktop it launches the automatic Codex release agent through `codex exec --full-auto`.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand build-only -ProjectRoot "<project>"`: runs direct `RunUAT.bat BuildPlugin` packaging without an agent fix loop.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand detect-engines -ProjectRoot "<project>"`: prints detected engines and the filtered build order.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/invoke-unreal-plugin-pipeline.ps1 -PipelineCommand dashboard -ProjectRoot "<project>"`: opens a local dashboard for project details, engine checkboxes, copyable commands, and editable project/global config forms.

`install` runs the guarded `scripts/install-run-actions.ps1` script, which delegates to the Node CLI and verifies the workspace-level Run environment was not changed. It writes `.codex/environments/environment.toml` at the current plugin project root only. It appends or replaces only that project's `UNREAL PLUGIN PIPELINE ACTIONS` marker block and preserves existing Run environment actions. `uninstall` removes only that project-local marker block and deletes the project-local environment file only when it was generated by this plugin and no other actions remain.

When the current workspace contains several sibling plugins, `install` must pass `-PluginName` only if the user explicitly named one. Otherwise let the guarded script fail and report its candidate list; do not choose the first `.uplugin`.

`Show Config` must use the `dashboard` command, not the raw `show-config` command, when configured as a Run dropdown action. The dashboard action calls this plugin bundle's Node script through `powershell -WindowStyle Hidden` to avoid a visible PowerShell window when possible. The normal dashboard command starts a loopback-only local panel so Save buttons can write config files; `dashboard --no-open` only regenerates the static HTML fallback.

## Release Agent Behavior

The `Build` command runs this plugin bundle's Node script with `--project-root`.

In Codex Desktop, the script does not spawn a new Codex conversation. It detects the desktop session, prints the current-thread release-agent instructions, runs direct `BuildPlugin` packaging from low engine version to high engine version, and writes `<output-directory>\reports\last-release-report.md`. If a version fails, the command stops with the log/report path so the current Codex conversation can inspect the error, edit the plugin, retry the same version, and continue.

Outside Codex Desktop, the script launches `codex exec` with:

- `--full-auto`
- `--sandbox workspace-write`
- `-c approval_policy="never"`
- `--add-dir` for the output directory, configured Unreal Engine roots, and Unreal-required user-state subdirectories:
  `%APPDATA%\Unreal Engine`, `%LOCALAPPDATA%\UnrealEngine`, and `%LOCALAPPDATA%\Microsoft SDKs`

The generated workflow intentionally does not use `--dangerously-bypass-approvals-and-sandbox`.

The release agent must:

1. Detect available engine versions.
2. Apply global and project exclusions.
3. Build from low version to high version.
4. On failure, inspect logs under the configured output directory, fix the project, retry the same version, then continue.
5. Write `<output-directory>\reports\last-release-report.md` when finished or blocked.
6. Do not write pipeline logs or release reports under the project `.codex` directory.

## Configuration Files

Global config:

`%USERPROFILE%\.unreal-plugin-pipeline\config.json`

Project config:

`<plugin-root>\.codex\unreal-plugin-pipeline.json`

Output directory and zip name pattern are global-only settings so all plugin build artifacts are managed in one place. Project config can exclude versions for one project. Both configs can exclude versions.

## Guardrails

- Do not reset or revert user changes to fix a failed build.
- Prefer the direct `Build Only` action when diagnosing whether the problem is the pipeline or Unreal itself.
- Do not silently add dangerous sandbox bypass settings.
- Do not write `.codex/environments/environment.toml` outside the target plugin project root.
- If multiple `.uplugin` files exist and the default shortest-path descriptor is not obviously right, ask the user which plugin to package.
