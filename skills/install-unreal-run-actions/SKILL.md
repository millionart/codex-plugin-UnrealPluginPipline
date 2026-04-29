---
name: install-unreal-run-actions
description: Install Unreal Plugin Pipeline actions into the built-in Codex Run dropdown for the current Unreal plugin project without replacing existing Run actions.
---

# Install Unreal Run Actions

Use this skill when the user says `install` for Unreal Plugin Pipeline or explicitly wants the built-in Run dropdown configured. The AI must only run the guarded installer script and report the result.

## Workflow

1. Locate this plugin bundle's `scripts/install-run-actions.ps1`.
2. Do not search recursively for `.uplugin` files and do not choose the first plugin found.
3. Run:
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<bundle-root>/scripts/install-run-actions.ps1" -ProjectRoot "<current-workspace>"`
   If the user explicitly named a plugin, add `-PluginName "<plugin-name>"`.
4. Report the generated plugin-local environment file path.

## Safety

- Do not edit files manually.
- Do not run `git restore`, `git checkout`, or any other recovery command.
- Do not edit Codex global state or force-select the generated environment.
- Preserve existing `.codex/environments/environment.toml` content.
- Only add or replace the current project's `UNREAL PLUGIN PIPELINE ACTIONS` marker block.
- If the script fails, report its output and stop.
