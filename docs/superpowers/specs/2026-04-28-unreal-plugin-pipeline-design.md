# Unreal Plugin Pipeline Design

## Goal

Build a Windows-only Codex plugin that configures Unreal Engine plugin projects for repeatable release builds.

## User Flow

After setup in an Unreal plugin project, the project has a local config file, PowerShell wrapper, and copied runtime. The primary build command launches an automatic release agent with `codex exec --full-auto`, scoped to the current project, configured Unreal Engine directories, and the configured output directory. The agent builds Unreal Engine versions from low to high, fixes failures by editing the project, retries the current version, then continues.

## Configuration

Global settings live at `%USERPROFILE%\.unreal-plugin-pipeline\config.json`.

Project settings live at `<plugin-root>\.codex\unreal-plugin-pipeline.json`.

The global config defines output directory and zip naming for centralized artifact management. Both global and project config may define excluded Unreal Engine versions. Engine discovery uses configured scan roots and explicit engine roots. Engine roots are valid when they contain `Engine\Build\BatchFiles\RunUAT.bat`.

## Architecture

The plugin source lives at the repository root. Runtime behavior is implemented by a testable Node CLI in `scripts/unreal-plugin-pipeline.mjs`. Project commands invoke `script\unreal_plugin_pipeline.ps1`, which delegates to a copied project-local Node runtime under `.codex\unreal-plugin-pipeline\bin`.

Codex plugin metadata currently exposes plugin presentation, composer prompts, skills, apps, and MCP integration, but no independent desktop toolbar button extension point. Writing `.codex\environments\environment.toml` is kept only as an explicit compatibility fallback through `--wire-run-actions`, because those actions occupy the built-in Run dropdown.

## Safety

The automatic agent uses `--full-auto`, `--sandbox workspace-write`, and `approval_policy="never"`. It does not use `--dangerously-bypass-approvals-and-sandbox`. The generated exec arguments add only the resolved output directory and resolved Unreal Engine roots as extra writable directories.

## Scope

Version 1 targets Windows and `RunUAT.bat BuildPlugin`. Other operating systems, marketplace submission automation, and a native graphical settings UI are out of scope.
