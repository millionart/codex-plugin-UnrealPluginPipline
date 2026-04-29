# Unreal Plugin Pipeline

Windows-first Codex plugin for Unreal Engine plugin release builds.

It sets up project-local release tooling for a `.uplugin` project:

- `Build`: starts a full-auto Codex release agent.
- `Build Only`: runs direct `RunUAT.bat BuildPlugin`.
- `Detect Engines`: shows detected Unreal Engine installs and the filtered build order.
- `Show Config`: opens a local dashboard for engine selection, commands, and editable global/project settings.

Current Codex plugin metadata does not expose an independent desktop toolbar button extension point. The old Run dropdown action wiring is disabled by default because it occupies the built-in Run button.

The GitHub-style entry point is implemented as skill-agent prompt entries:

- `Build Plugin`: starts the current-conversation build/fix/package loop.
- `Detect Engines`: shows detected Unreal Engine versions and build order.
- `Show Config`: opens the editable local settings dashboard.
- `Install Run Actions`: opt-in install of Run dropdown actions.
- `Uninstall Run Actions`: remove only Unreal Plugin Pipeline Run actions.

## Setup In A Plugin Project

From this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup -ProjectRoot "D:\Path\To\MyPlugin"
```

The PowerShell launcher resolves a usable `node.exe` from `UPP_NODE_EXE`, PATH, or common Node.js install locations before running the plugin's Node runtime. Generated Run actions use the same launcher instead of assuming `node` is on PATH.

To add this repository as a local Codex marketplace:

```powershell
codex plugin marketplace add "D:\Users\milli\Git\UnrealPluginPipline"
```

To wire every Unreal plugin under a folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup-all --root "D:\Users\milli\Sync\Default Folder\MyUEPlugins\Plugins"
```

Setup writes only project-local configuration. It does not copy scripts or runtime files into the Unreal plugin project:

```text
Plugins\DiffPlus\.codex\unreal-plugin-pipeline.json
```

The dashboard command also writes a project-local HTML fallback:

```text
Plugins\DiffPlus\.codex\unreal-plugin-pipeline\dashboard.html
```

Run actions call the plugin bundle's own `scripts\unreal-plugin-pipeline.mjs` with `--project-root "<plugin-root>"`, so the same script adapts to each target project by arguments.

To remove project-local Run dropdown actions created by this plugin:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand uninstall -ProjectRoot "D:\Path\To\MyPlugin"
```

Install and uninstall are restricted to the target plugin root's `.codex\environments\environment.toml`. For a plugin at `D:\Users\milli\Sync\Default Folder\MyUEPlugins\Plugins\DiffPlus`, this plugin may write only `D:\Users\milli\Sync\Default Folder\MyUEPlugins\Plugins\DiffPlus\.codex\environments\environment.toml`, not the parent `MyUEPlugins\.codex\environments\environment.toml`.

An opt-in compatibility fallback can write project-local Run dropdown actions without replacing existing environment actions. The Codex `Install Run Actions` entry runs this guarded script; it must not edit files manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-run-actions.ps1 -ProjectRoot "D:\Path\To\MyPlugin"
```

If running from a folder that contains several plugin projects, name the target explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-run-actions.ps1 -ProjectRoot "D:\Path\To\Plugins" -PluginName "PopDetails"
```

Open the visual configuration dashboard without using the Run dropdown:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand dashboard -ProjectRoot "D:\Path\To\MyPlugin"
```

The normal `dashboard` command starts a loopback-only `127.0.0.1` panel so the Save buttons can write JSON config files. Use `--no-open` to only regenerate the static `dashboard.html` preview; saving is disabled when that file is opened directly.

Add engine scan roots or explicit engine roots:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-scan-root --root "D:\Epic\Epic Games"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-engine-root --root "D:\Epic\Epic Games\UE_5.7"
```

Configure output storage:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand set-output -ProjectRoot "D:\Path\To\MyPlugin" --output "D:\Builds\MyPlugin"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand set-output --global --output "D:\UnrealPluginBuilds"
```

Exclude or re-include versions:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand exclude-version -ProjectRoot "D:\Path\To\MyPlugin" --version 5.1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand include-version -ProjectRoot "D:\Path\To\MyPlugin" --version 5.1
```

## Config Paths

Global config:

```text
%USERPROFILE%\.unreal-plugin-pipeline\config.json
```

Project config:

```text
<plugin-root>\.codex\unreal-plugin-pipeline.json
```

## Safety Defaults

The generated `Show Config` Run action launches the plugin bundle's `dashboard` command through hidden PowerShell. It opens a local editable panel in the default browser and also refreshes the fallback `dashboard.html` file.

The `Build` command launches:

```text
codex exec --full-auto --sandbox workspace-write -c approval_policy="never"
```

It adds only the configured output directory, Unreal Engine roots, and Unreal-required user-state subdirectories via `--add-dir`. The user-state entries are limited to:

```text
%APPDATA%\Unreal Engine
%LOCALAPPDATA%\UnrealEngine
%LOCALAPPDATA%\Microsoft SDKs
```

It does not use `--dangerously-bypass-approvals-and-sandbox`.

Pipeline logs and release reports are written under the configured output directory:

```text
<output-directory>\logs\<PluginName>-UE<Version>.log
<output-directory>\reports\last-release-report.md
```

They are not written under the plugin project's `.codex` directory.

`Build` requires the standalone Codex CLI to be runnable from PowerShell. Install it with `npm install -g @openai/codex` and verify `codex --version` before using the agent build command. The Codex app's protected WindowsApps resource is not a usable `codex exec` CLI; use `Build Only` when you want direct Unreal packaging without a Codex agent.

## Tests

```powershell
node .\tests\unreal-plugin-pipeline.test.mjs
```
