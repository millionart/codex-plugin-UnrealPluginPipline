# Unreal Plugin Pipeline

<p align="center">
  <strong>English</strong> | <a href="README_CN.md">简体中文</a>
</p>

A Windows-first Codex plugin for building, fixing, and packaging Unreal Engine `.uplugin` projects.

Unreal Plugin Pipeline turns Unreal plugin release work into a repeatable local pipeline: it detects installed Unreal Engine versions, runs `RunUAT.bat BuildPlugin` from low versions to high versions, writes zip packages and logs, and can let Codex inspect build failures, patch the project, and retry.

This project was developed end to end with Codex using the GPT-5.5 model, including requirement shaping, plugin architecture, Node.js and PowerShell scripts, Codex skills, tests, and documentation. The plugin is also intended to be self-deployed through Codex: open this repository in Codex, ask Codex to register the marketplace, install the plugin, set up the target Unreal plugin project, detect engines, and run builds from the conversation.

![Unreal Plugin Pipeline](assets/unreal-plugin-pipeline.svg)

## Features

- Detects local Unreal Engine installs and sorts the build plan by engine version.
- Supports global and project-level configuration for output directories, excluded versions, and zip naming.
- Sets up a single Unreal plugin project or scans a folder of plugin projects.
- Provides direct build mode through Unreal `RunUAT.bat BuildPlugin`.
- Provides Codex agent build mode for log inspection, source fixes, and retries.
- Provides a local dashboard for engine selection, commands, output paths, Run action state, and editable config.
- Writes only project-local config by default; Run dropdown actions are an explicit opt-in compatibility layer.

## Why This Is Not an Official-Style Action Bar Button

Official built-in Codex plugins can use host-side UI surfaces such as automatic action bar placement or official settings panels. Current local and third-party Codex plugin metadata does not expose an equivalent desktop UI extension point, so this project cannot automatically add an independent action bar button or inject its configuration UI into the official Codex settings panel.

This is a plugin capability boundary, not a missing script:

- `.codex-plugin/plugin.json` can declare the plugin name, icon, category, skills, and default prompts.
- Skill-agent entries can appear as callable plugin actions, such as `Build Plugin`, `Detect Engines`, and `Show Config`.
- Project-level Run dropdown actions can only be written explicitly to the target project's `.codex\environments\environment.toml`.
- The official settings panel does not currently expose a writable configuration page API for local plugins.
- Directly editing Codex Desktop global UI state under `C:\Users\<you>\.codex` is not a supported plugin implementation mechanism. It can affect every project and may break Codex startup or conversation behavior.

For that reason, this plugin uses supported and reversible integration points: Codex plugin category entries and skills as the main entry point, a local loopback dashboard for configuration, and opt-in Run dropdown actions as a compatibility fallback.

## Scope

This version is focused on:

- Windows
- Unreal Engine plugin projects
- Project roots with a `.uplugin` descriptor
- Unreal Automation Tool `BuildPlugin` packaging
- Local Codex Desktop / Codex CLI plugin workflows

macOS and Linux are not supported in this version. This plugin also cannot create an independent Codex Desktop toolbar button. Optional Run actions appear under the built-in Codex Run dropdown.

## Repository Layout

```text
.
├─ .codex-plugin/plugin.json              # Codex plugin metadata
├─ assets/                                # Plugin icons
├─ commands/                              # Codex slash command
├─ scripts/
│  ├─ invoke-unreal-plugin-pipeline.ps1   # Windows PowerShell launcher
│  ├─ install-run-actions.ps1             # Guarded Run actions installer
│  └─ unreal-plugin-pipeline.mjs          # Core Node.js CLI
├─ skills/                                # Codex skill entry points
└─ tests/                                 # Node.js tests
```

`plugins/unreal-plugin-pipeline/` contains a packaged mirror that can be used as a local Codex marketplace entry.

## Requirements

- Windows 10/11
- PowerShell
- Node.js 18 or newer
- One or more Unreal Engine installs with `Engine\Build\BatchFiles\RunUAT.bat`
- A target Unreal plugin project with a `.uplugin` file in the project root

Codex agent build mode outside Codex Desktop also requires the standalone Codex CLI:

```powershell
npm install -g @openai/codex
codex --version
```

The Codex Desktop WindowsApps resource is not a usable `codex exec` CLI for this pipeline. Inside Codex Desktop, `build` detects the desktop session and keeps the release loop in the current conversation instead of spawning a nested Codex session. If you only want direct Unreal packaging, use `build-only`.

## Install as a Local Codex Plugin

The recommended path is to let Codex self-deploy this plugin. Open this repository in Codex and ask Codex to register the current repository as a local marketplace, install `Unreal Plugin Pipeline`, and run setup for your target Unreal plugin project. This keeps engine detection, dashboard access, builds, and failure fixes inside the Codex conversation.

Add this repository as a local Codex marketplace:

```powershell
codex plugin marketplace add "D:\Path\To\UnrealPluginPipline"
```

Then install `Unreal Plugin Pipeline` from the Codex plugin UI. After installation, the Codex plugin page will show a new local plugin source/category dropdown entry named `Unreal Plugin Pipeline Local`; the plugin itself is categorized under `Coding`. Use that dropdown entry to select the plugin and access its actions.

Main plugin actions:

- `Build Plugin`: build this Unreal plugin in the current conversation, inspect failures, patch, and retry.
- `Detect Engines`: show detected Unreal Engine versions and the final build order.
- `Show Config`: open the local configuration dashboard.
- `Install Run Actions`: explicitly install Codex Run dropdown actions.
- `Uninstall Run Actions`: remove only this plugin's Run dropdown actions.

## Quick Start

Assume your Unreal plugin project is located at:

```text
D:\Path\To\MyPlugin
```

Write project-local configuration:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand setup -ProjectRoot "D:\Path\To\MyPlugin"
```

Detect available engines and the build order:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand detect-engines -ProjectRoot "D:\Path\To\MyPlugin"
```

Run direct Unreal packaging:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand build-only -ProjectRoot "D:\Path\To\MyPlugin"
```

Open the configuration dashboard:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand dashboard -ProjectRoot "D:\Path\To\MyPlugin"
```

## Common Commands

All commands go through the PowerShell launcher. The launcher resolves a usable `node.exe` from `UPP_NODE_EXE`, PATH, or common Node.js installation paths.

The table below lists the `-PipelineCommand` value and its arguments. Prefix each row with `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand` when running it.

| Task | PipelineCommand arguments |
| --- | --- |
| Set up one plugin project | `setup -ProjectRoot "D:\Path\To\MyPlugin"` |
| Set up all plugins under a folder | `setup-all --root "D:\Path\To\Plugins"` |
| Detect engines | `detect-engines -ProjectRoot "D:\Path\To\MyPlugin"` |
| Build all available versions directly | `build-only -ProjectRoot "D:\Path\To\MyPlugin"` |
| Build one version directly | `build-only -ProjectRoot "D:\Path\To\MyPlugin" --engine-version 5.7` |
| Start Codex agent build mode | `build -ProjectRoot "D:\Path\To\MyPlugin"` |
| Open dashboard | `dashboard -ProjectRoot "D:\Path\To\MyPlugin"` |
| Generate static dashboard HTML only | `dashboard -ProjectRoot "D:\Path\To\MyPlugin" --no-open` |
| Show current config JSON | `show-config -ProjectRoot "D:\Path\To\MyPlugin"` |
| Remove Run actions | `uninstall -ProjectRoot "D:\Path\To\MyPlugin"` |

Full example:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand build-only -ProjectRoot "D:\Path\To\MyPlugin" --engine-version 5.7
```

## Engine Discovery

Default global scan roots:

```text
D:\Epic\Epic Games
C:\Program Files\Epic Games
```

Add another scan root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-scan-root --root "D:\Epic\Epic Games"
```

Add an explicit engine root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand add-engine-root --root "D:\Epic\Epic Games\UE_5.7"
```

Exclude or re-include a version:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand exclude-version -ProjectRoot "D:\Path\To\MyPlugin" --version 5.1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand include-version -ProjectRoot "D:\Path\To\MyPlugin" --version 5.1
```

Add `--global` to write the version exclusion rule to global config.

## Output Directory

Set the global output directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\invoke-unreal-plugin-pipeline.ps1 -PipelineCommand set-output --output "D:\UnrealPluginBuilds\{pluginName}"
```

Build logs and reports are written under the output directory:

```text
<output-directory>\logs\<PluginName>-UE<Version>.log
<output-directory>\reports\last-release-report.md
```

They are not written under the target plugin project's `.codex` directory.

## Configuration Files

Global config:

```text
%USERPROFILE%\.unreal-plugin-pipeline\config.json
```

Project config:

```text
<plugin-root>\.codex\unreal-plugin-pipeline.json
```

Output directory and zip name pattern are global-only settings so all plugin build artifacts are managed in one place. Project config can exclude Unreal Engine versions for one plugin.

## Run Dropdown Compatibility Mode

By default, `setup` writes only project-local config. It does not create Codex Run dropdown actions, and it does not copy runtime scripts into the Unreal plugin project.

If you want `Build`, `Build Only`, `Detect Engines`, and `Show Config` under Codex's built-in Run dropdown, install them explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-run-actions.ps1 -ProjectRoot "D:\Path\To\MyPlugin"
```

If the path contains multiple sibling plugin projects, specify the plugin name:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-run-actions.ps1 -ProjectRoot "D:\Path\To\Plugins" -PluginName "MyPlugin"
```

Install and uninstall are restricted to the target plugin root:

```text
<plugin-root>\.codex\environments\environment.toml
```

They do not modify a parent workspace `.codex\environments\environment.toml`.

## Safety Defaults

Outside Codex Desktop, `Build` agent mode starts:

```text
codex exec --full-auto --sandbox workspace-write -c approval_policy="never"
```

It only adds necessary paths through `--add-dir`, including:

- The configured output directory
- Configured Unreal Engine roots
- Unreal-required user-state directories:
  - `%APPDATA%\Unreal Engine`
  - `%LOCALAPPDATA%\UnrealEngine`
  - `%LOCALAPPDATA%\Microsoft SDKs`

The pipeline does not use `--dangerously-bypass-approvals-and-sandbox`.

Inside Codex Desktop, `Build` does not spawn a second Codex process. It runs the visible release loop in the current conversation, writes `<output-directory>\reports\last-release-report.md`, and stops on the failed engine version so the current Codex agent can inspect logs, patch the project, retry, and continue.

When a build fails, the Codex agent should read logs under the output directory, patch the current project, retry the failed version, then continue with later versions. It should not reset or revert user changes.

## Development and Tests

Installing dependencies is not required for the current test suite; it uses Node.js' built-in test runner.

```powershell
npm test
```

Equivalent direct command:

```powershell
node .\tests\unreal-plugin-pipeline.test.mjs
```

## Contributing

This is a Codex plugin, so the project assumes every user already has Codex and can reproduce deployment, build, and fix workflows from Codex. This repository does not accept GitHub issues as a support or feature-request channel.

If you find a problem or want to improve the plugin, submit a pull request directly. A PR should include:

- Change summary
- Reproduction steps or use case
- Tests, or a short explanation of why no new test is needed
- Any required updates to `README.md`, `README_CN.md`, or skill documentation

This keeps maintenance aligned with the way the plugin is used: use Codex to diagnose the problem, then submit a reviewable code change.

## Before Publishing

- This repository is Windows-first; do not describe cross-platform support as available.
- Add a root `LICENSE` file before public release if needed; plugin metadata currently declares MIT.
- If the repository path or name changes, update local marketplace path examples.
