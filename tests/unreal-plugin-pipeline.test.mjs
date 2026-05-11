import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCommandOptions,
  buildCodexExecArgs,
  buildLogPath,
  buildUatLogDirectory,
  codexSandboxWritableDirs,
  codexProcessInvocation,
  copyReleasePackageForZip,
  dashboardServerMetadataReusable,
  discoverEngines,
  discoverUPluginProjectRoots,
  findUPlugin,
  generateProjectDashboard,
  makeReleasePrompt,
  removeProjectRunActions,
  releaseReportPath,
  resolveCodexExecutable,
  resolveBuildPlan,
  runUatProcessInvocation,
  saveDashboardConfig,
  startDashboardServer,
  withVersionExclusion,
  writeProjectBootstrap,
  zipDirectoryProcessInvocation,
} from "../scripts/unreal-plugin-pipeline.mjs";

async function tempDir(name) {
  return await mkdir(path.join(os.tmpdir(), `upp-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`), {
    recursive: true,
  });
}

async function createEngine(root, relativePath, buildVersion) {
  const engineRoot = path.join(root, relativePath);
  await mkdir(path.join(engineRoot, "Engine", "Build", "BatchFiles"), { recursive: true });
  await writeFile(path.join(engineRoot, "Engine", "Build", "BatchFiles", "RunUAT.bat"), "@echo off\r\n", "utf8");

  if (buildVersion) {
    await mkdir(path.join(engineRoot, "Engine", "Build"), { recursive: true });
    await writeFile(
      path.join(engineRoot, "Engine", "Build", "Build.version"),
      JSON.stringify(buildVersion),
      "utf8",
    );
  }

  return engineRoot;
}

function powerShellExecutable() {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

test("discoverEngines finds configured engines and sorts versions from low to high", async () => {
  const root = await tempDir("engines");
  await createEngine(root, "UE_5.4", null);
  await createEngine(root, "UE_5.2", null);
  const explicit = await createEngine(root, "CustomInstall", {
    MajorVersion: 5,
    MinorVersion: 7,
    PatchVersion: 0,
  });

  const engines = await discoverEngines({
    scanRoots: [root],
    explicitEngineRoots: [explicit],
  });

  assert.deepEqual(
    engines.map((engine) => engine.version),
    ["5.2", "5.4", "5.7"],
  );
  assert.equal(engines[2].runUatPath, path.join(explicit, "Engine", "Build", "BatchFiles", "RunUAT.bat"));
});

test("resolveBuildPlan excludes versions from global and project settings", () => {
  const engines = [
    { version: "5.2", root: "C:/UE_5.2" },
    { version: "5.4", root: "C:/UE_5.4" },
    { version: "5.7", root: "C:/UE_5.7" },
  ];

  const plan = resolveBuildPlan({
    engines,
    globalConfig: { excludedVersions: ["5.2"] },
    projectConfig: { excludedVersions: ["5.7"] },
  });

  assert.deepEqual(
    plan.map((engine) => engine.version),
    ["5.4"],
  );
});

test("withVersionExclusion adds and removes normalized excluded versions", () => {
  const excluded = withVersionExclusion({ excludedVersions: ["5.2"] }, "5.7.0", true);
  assert.deepEqual(excluded.excludedVersions, ["5.2", "5.7"]);

  const included = withVersionExclusion(excluded, "5.2", false);
  assert.deepEqual(included.excludedVersions, ["5.7"]);
});

test("findUPlugin identifies the Unreal plugin descriptor in a project root", async () => {
  const projectRoot = await tempDir("uplugin");
  const descriptor = path.join(projectRoot, "DemoPlugin.uplugin");
  await writeFile(descriptor, "{\"FileVersion\":3}\n", "utf8");

  const found = await findUPlugin(projectRoot);

  assert.equal(found, descriptor);
});

test("discoverUPluginProjectRoots finds plugin roots and ignores generated package directories", async () => {
  const root = await tempDir("plugin-roots");
  await mkdir(path.join(root, "PluginA"), { recursive: true });
  await mkdir(path.join(root, "PluginA", "_BuildPlugin57"), { recursive: true });
  await mkdir(path.join(root, "Nested", "PluginB"), { recursive: true });
  await writeFile(path.join(root, "PluginA", "PluginA.uplugin"), "{}", "utf8");
  await writeFile(path.join(root, "PluginA", "_BuildPlugin57", "PluginA.uplugin"), "{}", "utf8");
  await writeFile(path.join(root, "Nested", "PluginB", "PluginB.uplugin"), "{}", "utf8");

  const roots = await discoverUPluginProjectRoots(root);

  assert.deepEqual(
    roots.map((pluginRoot) => path.relative(root, pluginRoot).replaceAll("\\", "/")),
    ["Nested/PluginB", "PluginA"],
  );
});

test("writeProjectBootstrap creates project config without project-local output settings by default", async () => {
  const projectRoot = await tempDir("bootstrap");
  const runtimeSource = path.join(projectRoot, "runtime-source.mjs");
  const dashboardPath = path.join(projectRoot, ".codex", "unreal-plugin-pipeline", "dashboard.html");
  const legacyRuntimeDir = path.join(projectRoot, ".codex", "unreal-plugin-pipeline", "bin");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");
  await mkdir(legacyRuntimeDir, { recursive: true });
  await writeFile(path.join(legacyRuntimeDir, "unreal-plugin-pipeline.mjs"), "legacy copy\n", "utf8");
  await writeFile(dashboardPath, "dashboard\n", "utf8");

  await writeProjectBootstrap({
    projectRoot,
    runtimeSourcePath: runtimeSource,
    outputDirectory: path.join(projectRoot, "dist"),
    projectName: "DemoPlugin",
  });

  await assert.rejects(stat(path.join(projectRoot, ".codex", "environments", "environment.toml")));

  const projectConfig = JSON.parse(await readFile(path.join(projectRoot, ".codex", "unreal-plugin-pipeline.json"), "utf8"));
  assert.deepEqual(projectConfig, {
    excludedVersions: [],
  });

  await assert.rejects(stat(path.join(projectRoot, "script", "unreal_plugin_pipeline.ps1")));
  await assert.rejects(stat(path.join(projectRoot, ".codex", "unreal-plugin-pipeline", "bin", "unreal-plugin-pipeline.mjs")));
  assert.equal(await readFile(dashboardPath, "utf8"), "dashboard\n");
});

test("writeProjectBootstrap can opt into Run dropdown actions", async () => {
  const projectRoot = await tempDir("bootstrap-actions");
  const runtimeSource = path.join(projectRoot, "runtime-source.mjs");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");

  const result = await writeProjectBootstrap({
    projectRoot,
    runtimeSourcePath: runtimeSource,
    outputDirectory: path.join(projectRoot, "dist"),
    projectName: "DemoPlugin",
    wireRunActions: true,
  });

  assert.equal(result.runActionsWired, true);
  const envText = await readFile(path.join(projectRoot, ".codex", "environments", "environment.toml"), "utf8");
  assert.match(envText, /name = "DemoPlugin"/);
  assert.match(envText, /name = "Build"/);
  assert.match(envText, /invoke-unreal-plugin-pipeline\.ps1/);
  assert.match(envText, /-PipelineCommand build/);
  assert.match(envText, /-ProjectRoot/);
  assert.doesNotMatch(envText, /command = "node /);
  assert.doesNotMatch(envText, /script\/unreal_plugin_pipeline\.ps1/);
  assert.match(envText, /name = "Build Only"/);
  assert.match(envText, /name = "Detect Engines"/);
  assert.match(envText, /name = "Show Config"/);
  assert.match(envText, /powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File/);
  assert.doesNotMatch(envText, /show-config/);
});

test("writeProjectBootstrap writes action config only at target project root for nested plugin projects", async () => {
  const workspaceRoot = await tempDir("workspace-root");
  const projectRoot = path.join(workspaceRoot, "Plugins", "DiffPlus");
  await mkdir(projectRoot, { recursive: true });
  const runtimeSource = path.join(workspaceRoot, "runtime-source.mjs");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");

  await writeProjectBootstrap({
    projectRoot,
    workspaceRoot,
    runtimeSourcePath: runtimeSource,
    projectName: "DiffPlus",
    wireRunActions: true,
  });

  await assert.rejects(stat(path.join(workspaceRoot, ".codex", "environments", "environment.toml")));

  const localEnvText = await readFile(path.join(projectRoot, ".codex", "environments", "environment.toml"), "utf8");
  assert.match(localEnvText, /name = "DiffPlus"/);
  assert.match(localEnvText, /name = "Build"/);
  assert.doesNotMatch(localEnvText, /name = "Build DiffPlus"/);
  assert.match(localEnvText, /invoke-unreal-plugin-pipeline\.ps1/);
  assert.match(localEnvText, /-ProjectRoot/);
  assert.doesNotMatch(localEnvText, /command = "node /);
  assert.doesNotMatch(localEnvText, /script\/unreal_plugin_pipeline\.ps1/);

  await stat(path.join(projectRoot, ".codex", "unreal-plugin-pipeline.json"));
  await assert.rejects(stat(path.join(projectRoot, "script", "unreal_plugin_pipeline.ps1")));
  await assert.rejects(stat(path.join(projectRoot, ".codex", "unreal-plugin-pipeline", "bin", "unreal-plugin-pipeline.mjs")));
});

test("generateProjectDashboard writes a visual HTML config panel", async () => {
  const projectRoot = await tempDir("dashboard");
  await createEngine(projectRoot, "Engines/UE_4.27", null);
  const engineRoot = await createEngine(projectRoot, "Engines/UE_5.7", null);
  const runtimeSource = path.join(projectRoot, "runtime-source.mjs");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");
  await writeFile(path.join(projectRoot, "DemoPlugin.uplugin"), "{\"FileVersion\":3}\n", "utf8");
  await mkdir(path.join(projectRoot, "Resources"), { recursive: true });
  await writeFile(path.join(projectRoot, "Resources", "Icon128.png"), "icon", "utf8");
  await writeProjectBootstrap({
    projectRoot,
    runtimeSourcePath: runtimeSource,
    outputDirectory: path.join(projectRoot, "dist"),
    projectName: "DemoPlugin",
    wireRunActions: true,
  });

  const globalConfig = {
    engineScanRoots: [path.join(projectRoot, "Engines")],
    engineRoots: [engineRoot],
    excludedVersions: [],
    outputDirectory: path.join(projectRoot, "global-dist", "{pluginName}"),
    zipNamePattern: "{pluginName}-global-UE{engineVersion}.zip",
    maxFixAttemptsPerVersion: 3,
    allowDangerFullAccess: false,
  };
  const result = await generateProjectDashboard({
    projectRoot,
    globalConfig,
    open: false,
  });

  const html = await readFile(result.dashboardPath, "utf8");
  assert.match(html, /<title>DemoPlugin - Unreal Plugin Pipeline<\/title>/);
  assert.match(html, /<link rel="icon" type="image\/png" href="\.\.\/\.\.\/Resources\/Icon128\.png">/);
  assert.match(html, /<img class="plugin-icon" src="\.\.\/\.\.\/Resources\/Icon128\.png" alt="DemoPlugin icon">/);
  assert.match(html, /<h1>DemoPlugin - Unreal Plugin Pipeline<\/h1>/);
  assert.match(html, /DemoPlugin/);
  assert.match(html, /UE 4\.27/);
  assert.match(html, /UE 5\.7/);
  assert.match(html, /Run actions installed/);
  assert.match(html, /data-tab="project"/);
  assert.match(html, /data-tab="project-config"/);
  assert.match(html, /data-tab="global-config"/);
  assert.match(html, /data-tab-button="project-config">Project Config/);
  assert.match(html, /data-tab-button="global-config">Global Config/);
  assert.doesNotMatch(html, /data-tab="commands"/);
  assert.doesNotMatch(html, /data-tab="config"/);
  assert.doesNotMatch(html, /data-tab="engines"/);
  assert.doesNotMatch(html, /data-tab-button="engines"/);
  assert.match(html, /class="upp-engine-checkbox"/);
  assert.match(html, /Engine Selection/);
  assert.match(html, /id="buildOnlyVersionGroup"/);
  assert.match(html, /data-build-only-version/);
  assert.match(html, /data-build-command-mode="build"/);
  assert.match(html, /data-build-command-mode="build-only"/);
  assert.match(html, /data-command-card="build"[\s\S]*id="buildOnlyVersionGroup"/);
  assert.match(html, /"--build-only", "--engine-version"/);
  assert.match(html, /invoke-unreal-plugin-pipeline\.ps1/);
  assert.match(html, /-ProjectRoot/);
  assert.doesNotMatch(html, /unreal_plugin_pipeline\.ps1/);
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
  assert.doesNotMatch(html, /data-command-card="build-only"/);
  assert.match(html, /data-copy-command/);
  assert.match(html, /data-command-card="build"[\s\S]*class="icon-button copy-build"/);
  assert.match(html, /data-command-card="uninstall"[\s\S]*class="icon-button copy-danger"/);
  assert.doesNotMatch(html, /data-command-card="detect"/);
  assert.match(html, /data-command-slot="build"[\s\S]*<h2>Engine Selection<\/h2>[\s\S]*data-command-slot="uninstall"/);
  assert.match(html, /Project Config[\s\S]*Build[\s\S]*Build Only[\s\S]*Engine Selection[\s\S]*Uninstall Run Actions/);
  assert.match(html, /Engine Scan Roots[\s\S]*data-config-command="detect"[\s\S]*Detect Engines/);
  assert.doesNotMatch(html, /id="projectOutput"/);
  assert.doesNotMatch(html, /id="projectZipPattern"/);
  assert.match(html, /Global Config[\s\S]*Output Directory[\s\S]*id="globalOutput"[\s\S]*Zip Name Pattern[\s\S]*id="globalZipPattern"/);
  assert.doesNotMatch(html, /data-tab="global-config"[\s\S]*<h2>Engine Selection<\/h2>/);
  assert.match(html, /Save Project Config/);
  assert.match(html, /Save Global Config/);
  assert.doesNotMatch(html, /[\p{Script=Han}]/u);
  assert.match(html, /Browse/);
  assert.match(html, /\/api\/pick-directory/);
  assert.match(html, /id="projectOutputValue">[^<]*global-dist[^<]*DemoPlugin/);
  assert.match(html, /\{pluginName\}/);
  assert.match(html, /\{pluginName\}-global-UE\{engineVersion\}\.zip/);
  assert.doesNotMatch(html, /Excluded Versions/);
  assert.doesNotMatch(html, /Global Excluded Versions/);
  assert.doesNotMatch(html, /<h2>Build Plan<\/h2>/);

  const bootMatch = html.match(/<script id="upp-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(bootMatch);
  const boot = JSON.parse(bootMatch[1]);
  assert.equal(boot.state.projectName, "DemoPlugin");
});

test("saveDashboardConfig keeps output and zip settings global-only", async () => {
  const projectRoot = await tempDir("dashboard-save");
  const globalConfigPath = path.join(projectRoot, "global-config.json");
  await writeFile(path.join(projectRoot, "DemoPlugin.uplugin"), "{\"FileVersion\":3}\n", "utf8");

  const projectResult = await saveDashboardConfig({
    projectRoot,
    scope: "project",
    config: {
      outputDirectory: path.join(projectRoot, "release"),
      excludedVersions: ["5.2.1", "bad", "5.7"],
      zipNamePattern: "{pluginName}-{engineVersion}.zip",
    },
  });
  assert.deepEqual(projectResult.projectConfig.excludedVersions, ["5.2", "5.7"]);
  const projectConfig = JSON.parse(await readFile(path.join(projectRoot, ".codex", "unreal-plugin-pipeline.json"), "utf8"));
  assert.deepEqual(projectConfig, {
    excludedVersions: ["5.2", "5.7"],
  });

  const globalResult = await saveDashboardConfig({
    projectRoot,
    globalConfigPath,
    scope: "global",
    config: {
      engineScanRoots: [path.join(projectRoot, "Engines"), ""],
      engineRoots: [path.join(projectRoot, "UE_5.7")],
      excludedVersions: ["5.1.0", "5.1", ""],
      outputDirectory: path.join(projectRoot, "global-release", "{pluginName}"),
      zipNamePattern: "{pluginName}-global-{engineVersion}.zip",
      maxFixAttemptsPerVersion: 5,
      allowDangerFullAccess: false,
    },
  });
  assert.deepEqual(globalResult.globalConfig.excludedVersions, ["5.1"]);
  const globalConfig = JSON.parse(await readFile(globalConfigPath, "utf8"));
  assert.deepEqual(globalConfig.engineScanRoots, [path.join(projectRoot, "Engines")]);
  assert.equal(globalConfig.outputDirectory, path.join(projectRoot, "global-release", "{pluginName}"));
  assert.equal(globalConfig.zipNamePattern, "{pluginName}-global-{engineVersion}.zip");
  assert.equal(globalConfig.maxFixAttemptsPerVersion, 5);
});

test("startDashboardServer serves the editable dashboard and saves project config", async () => {
  const projectRoot = await tempDir("dashboard-server");
  const globalConfigPath = path.join(projectRoot, "global-config.json");
  await writeFile(path.join(projectRoot, "DemoPlugin.uplugin"), "{\"FileVersion\":3}\n", "utf8");
  await mkdir(path.join(projectRoot, "Resources"), { recursive: true });
  await writeFile(path.join(projectRoot, "Resources", "Icon128.png"), "icon", "utf8");

  const session = await startDashboardServer({
    projectRoot,
    globalConfigPath,
    port: 0,
    token: "test-token",
    idleMs: 0,
    pickDirectory: async ({ initialPath, fallbackPath }) => {
      assert.equal(initialPath, path.join(projectRoot, "_UnrealPluginBuilds"));
      assert.equal(fallbackPath, path.resolve(projectRoot));
      return path.join(projectRoot, "SelectedOutput");
    },
  });

  try {
    const page = await fetch(session.url);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Save Project Config/);
    assert.match(pageText, /href="\/Resources\/Icon128\.png\?token=test-token"/);
    const bootMatch = pageText.match(/<script id="upp-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(bootMatch);
    const boot = JSON.parse(bootMatch[1]);
    assert.equal(boot.apiToken, "test-token");
    assert.equal(boot.apiBase, "");

    const icon = await fetch(`http://127.0.0.1:${session.port}/Resources/Icon128.png?token=test-token`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.equal(await icon.text(), "icon");

    const browse = await fetch(`http://127.0.0.1:${session.port}/api/browse?path=${encodeURIComponent(projectRoot)}`, {
      headers: {
        "X-UPP-Token": "test-token",
      },
    });
    assert.equal(browse.status, 200);
    const browsePayload = await browse.json();
    assert.equal(browsePayload.path, path.resolve(projectRoot));
    assert.ok(Array.isArray(browsePayload.entries));

    const missingOutputPath = path.join(projectRoot, "_UnrealPluginBuilds");
    const missingBrowse = await fetch(`http://127.0.0.1:${session.port}/api/browse?path=${encodeURIComponent(missingOutputPath)}`, {
      headers: {
        "X-UPP-Token": "test-token",
      },
    });
    assert.equal(missingBrowse.status, 200);
    const missingBrowsePayload = await missingBrowse.json();
    assert.equal(missingBrowsePayload.path, path.resolve(projectRoot));

    const pick = await fetch(`http://127.0.0.1:${session.port}/api/pick-directory`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-UPP-Token": "test-token",
      },
      body: JSON.stringify({
        initialPath: path.join(projectRoot, "_UnrealPluginBuilds"),
      }),
    });
    assert.equal(pick.status, 200);
    const pickPayload = await pick.json();
    assert.equal(pickPayload.path, path.join(projectRoot, "SelectedOutput"));

    const save = await fetch(`http://127.0.0.1:${session.port}/api/config/project`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-UPP-Token": "test-token",
      },
      body: JSON.stringify({
        config: {
          outputDirectory: path.join(projectRoot, "server-release"),
          excludedVersions: ["5.3"],
          zipNamePattern: "{pluginName}-server.zip",
        },
      }),
    });
    assert.equal(save.status, 200);
    const payload = await save.json();
    assert.equal(payload.state.projectConfig.outputDirectory, undefined);

    const projectConfig = JSON.parse(await readFile(path.join(projectRoot, ".codex", "unreal-plugin-pipeline.json"), "utf8"));
    assert.deepEqual(projectConfig, {
      excludedVersions: ["5.3"],
    });
  } finally {
    await new Promise((resolve) => session.server.close(resolve));
  }
});

test("dashboard server reuse requires the current runtime fingerprint", () => {
  const runtimePath = path.join(os.tmpdir(), "unreal-plugin-pipeline.mjs");
  const currentRuntime = {
    runtimePath,
    runtimeFingerprint: "current-script",
  };

  assert.equal(dashboardServerMetadataReusable({
    url: "http://127.0.0.1:12345/?token=test",
    runtimePath,
    runtimeFingerprint: "current-script",
  }, currentRuntime), true);
  assert.equal(dashboardServerMetadataReusable({
    url: "http://127.0.0.1:12345/?token=test",
  }, currentRuntime), false);
  assert.equal(dashboardServerMetadataReusable({
    url: "http://127.0.0.1:12345/?token=test",
    runtimePath,
    runtimeFingerprint: "old-script",
  }, currentRuntime), false);
});

test("removeProjectRunActions removes only the target project Run dropdown action file", async () => {
  const workspaceRoot = await tempDir("cleanup-workspace");
  const projectRoot = path.join(workspaceRoot, "Plugins", "DiffPlus");
  await mkdir(projectRoot, { recursive: true });
  const runtimeSource = path.join(workspaceRoot, "runtime-source.mjs");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");
  const workspaceEnvPath = path.join(workspaceRoot, ".codex", "environments", "environment.toml");
  const workspaceEnvText = [
    "# existing workspace run config",
    "version = 1",
    "name = \"SharedWorkspace\"",
    "",
    "[[actions]]",
    "name = \"Existing Action\"",
    "icon = \"run\"",
    "command = \"echo existing\"",
    "",
  ].join("\n");
  await mkdir(path.dirname(workspaceEnvPath), { recursive: true });
  await writeFile(workspaceEnvPath, workspaceEnvText, "utf8");

  await writeProjectBootstrap({
    projectRoot,
    workspaceRoot,
    runtimeSourcePath: runtimeSource,
    projectName: "DiffPlus",
    wireRunActions: true,
  });

  const result = await removeProjectRunActions({
    projectRoot,
    workspaceRoot,
    projectName: "DiffPlus",
  });

  assert.deepEqual(result.results.map((entry) => entry.targetPath), [path.join(projectRoot, ".codex", "environments", "environment.toml")]);
  assert.equal(await readFile(workspaceEnvPath, "utf8"), workspaceEnvText);
  await assert.rejects(stat(path.join(projectRoot, ".codex", "environments", "environment.toml")));
});

test("installProjectRunActions and removeProjectRunActions add and remove Run dropdown actions", async () => {
  const module = await import("../scripts/unreal-plugin-pipeline.mjs");
  assert.equal(typeof module.installProjectRunActions, "function");
  const projectRoot = await tempDir("cli-install");
  const runtimeSource = path.join(projectRoot, "runtime-source.mjs");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");

  const install = await module.installProjectRunActions({
    projectRoot,
    runtimeSourcePath: runtimeSource,
    projectName: "DemoPlugin",
  });
  assert.equal(install.runActionsWired, true);
  const envPath = path.join(projectRoot, ".codex", "environments", "environment.toml");
  const envText = await readFile(envPath, "utf8");
  assert.match(envText, /name = "Build"/);
  assert.match(envText, /BEGIN UNREAL PLUGIN PIPELINE ACTIONS: DemoPlugin/);

  await removeProjectRunActions({
    projectRoot,
    projectName: "DemoPlugin",
  });
  await assert.rejects(stat(envPath));
});

test("installProjectRunActions writes only the target project environment by default", async () => {
  const module = await import("../scripts/unreal-plugin-pipeline.mjs");
  const workspaceRoot = await tempDir("cli-install-shared-workspace");
  await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const projectRoot = path.join(workspaceRoot, "Plugins", "OtherPlugin");
  await mkdir(projectRoot, { recursive: true });
  const runtimeSource = path.join(workspaceRoot, "runtime-source.mjs");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");

  const install = await module.installProjectRunActions({
    projectRoot,
    runtimeSourcePath: runtimeSource,
    projectName: "OtherPlugin",
  });

  const workspaceEnvPath = path.join(workspaceRoot, ".codex", "environments", "environment.toml");
  const projectEnvPath = path.join(projectRoot, ".codex", "environments", "environment.toml");
  await assert.rejects(stat(workspaceEnvPath));
  const envText = await readFile(projectEnvPath, "utf8");
  assert.equal(install.environmentPath, projectEnvPath);
  assert.equal(install.localEnvironmentPath, projectEnvPath);
  assert.match(envText, /name = "Build"/);
  assert.doesNotMatch(envText, /name = "Build OtherPlugin"/);
  assert.match(envText, /invoke-unreal-plugin-pipeline\.ps1/);
  assert.match(envText, /-ProjectRoot/);
  assert.doesNotMatch(envText, /command = "node /);
  assert.doesNotMatch(envText, /script\/unreal_plugin_pipeline\.ps1/);
  await assert.rejects(stat(path.join(projectRoot, "script", "unreal_plugin_pipeline.ps1")));
  await assert.rejects(stat(path.join(projectRoot, ".codex", "unreal-plugin-pipeline", "bin", "unreal-plugin-pipeline.mjs")));
});

test("install-run-actions PowerShell script installs only the selected project", async (t) => {
  const workspaceRoot = await tempDir("ps-install-shared-workspace");
  await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const projectRoot = path.join(workspaceRoot, "Plugins", "PopDetails");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "PopDetails.uplugin"), "{\"FileVersion\":3}\n", "utf8");

  const scriptPath = path.resolve("scripts", "install-run-actions.ps1");
  const result = spawnSync(powerShellExecutable(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ProjectRoot",
    projectRoot,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      UPP_NODE_EXE: process.execPath,
    },
  });

  if (result.error?.code === "ENOENT") {
    t.skip("PowerShell is not available in this environment");
    return;
  }

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await assert.rejects(stat(path.join(workspaceRoot, ".codex", "environments", "environment.toml")));
  const projectEnvPath = path.join(projectRoot, ".codex", "environments", "environment.toml");
  const envText = await readFile(projectEnvPath, "utf8");
  assert.match(envText, /BEGIN UNREAL PLUGIN PIPELINE ACTIONS: PopDetails/);
  assert.match(envText, /invoke-unreal-plugin-pipeline\.ps1/);
  assert.match(envText, /-ProjectRoot/);
  assert.doesNotMatch(envText, /command = "node /);
  assert.doesNotMatch(envText, /script\/unreal_plugin_pipeline\.ps1/);
  await assert.rejects(stat(path.join(projectRoot, "script", "unreal_plugin_pipeline.ps1")));
  await assert.rejects(stat(path.join(projectRoot, ".codex", "unreal-plugin-pipeline", "bin", "unreal-plugin-pipeline.mjs")));
});

test("install-run-actions PowerShell script preserves existing workspace Run config", async (t) => {
  const workspaceRoot = await tempDir("ps-install-preserve-workspace");
  await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const workspaceEnvPath = path.join(workspaceRoot, ".codex", "environments", "environment.toml");
  const existingWorkspaceEnv = [
    "# existing workspace run config",
    "version = 1",
    "name = \"SharedWorkspace\"",
    "",
    "[[actions]]",
    "name = \"Existing Action\"",
    "icon = \"run\"",
    "command = \"echo existing\"",
    "",
  ].join("\n");
  await mkdir(path.dirname(workspaceEnvPath), { recursive: true });
  await writeFile(workspaceEnvPath, existingWorkspaceEnv, "utf8");

  const projectRoot = path.join(workspaceRoot, "Plugins", "PopDetails");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "PopDetails.uplugin"), "{\"FileVersion\":3}\n", "utf8");

  const scriptPath = path.resolve("scripts", "install-run-actions.ps1");
  const result = spawnSync(powerShellExecutable(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ProjectRoot",
    projectRoot,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      UPP_NODE_EXE: process.execPath,
    },
  });

  if (result.error?.code === "ENOENT") {
    t.skip("PowerShell is not available in this environment");
    return;
  }

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(workspaceEnvPath, "utf8"), existingWorkspaceEnv);
  const projectEnvText = await readFile(path.join(projectRoot, ".codex", "environments", "environment.toml"), "utf8");
  assert.match(projectEnvText, /BEGIN UNREAL PLUGIN PIPELINE ACTIONS: PopDetails/);
});

test("install-run-actions PowerShell script refuses to guess among sibling plugins", async (t) => {
  const workspaceRoot = await tempDir("ps-install-multiple-siblings");
  await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const diffPlusRoot = path.join(workspaceRoot, "DiffPlus");
  const popDetailsRoot = path.join(workspaceRoot, "PopDetails");
  await mkdir(diffPlusRoot, { recursive: true });
  await mkdir(popDetailsRoot, { recursive: true });
  await writeFile(path.join(diffPlusRoot, "DiffPlus.uplugin"), "{\"FileVersion\":3}\n", "utf8");
  await writeFile(path.join(popDetailsRoot, "PopDetails.uplugin"), "{\"FileVersion\":3}\n", "utf8");

  const scriptPath = path.resolve("scripts", "install-run-actions.ps1");
  const result = spawnSync(powerShellExecutable(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ProjectRoot",
    workspaceRoot,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      UPP_NODE_EXE: process.execPath,
    },
  });

  if (result.error?.code === "ENOENT") {
    t.skip("PowerShell is not available in this environment");
    return;
  }

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Multiple child plugin projects exist/);
  assert.match(`${result.stdout}\n${result.stderr}`, /DiffPlus/);
  assert.match(`${result.stdout}\n${result.stderr}`, /PopDetails/);
  await assert.rejects(stat(path.join(diffPlusRoot, ".codex", "environments", "environment.toml")));
  await assert.rejects(stat(path.join(popDetailsRoot, ".codex", "environments", "environment.toml")));
});

test("install-run-actions PowerShell script can select a named sibling plugin", async (t) => {
  const workspaceRoot = await tempDir("ps-install-named-sibling");
  await mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
  const diffPlusRoot = path.join(workspaceRoot, "DiffPlus");
  const popDetailsRoot = path.join(workspaceRoot, "PopDetails");
  await mkdir(diffPlusRoot, { recursive: true });
  await mkdir(popDetailsRoot, { recursive: true });
  await writeFile(path.join(diffPlusRoot, "DiffPlus.uplugin"), "{\"FileVersion\":3}\n", "utf8");
  await writeFile(path.join(popDetailsRoot, "PopDetails.uplugin"), "{\"FileVersion\":3}\n", "utf8");

  const scriptPath = path.resolve("scripts", "install-run-actions.ps1");
  const result = spawnSync(powerShellExecutable(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ProjectRoot",
    workspaceRoot,
    "-PluginName",
    "PopDetails",
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      UPP_NODE_EXE: process.execPath,
    },
  });

  if (result.error?.code === "ENOENT") {
    t.skip("PowerShell is not available in this environment");
    return;
  }

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await assert.rejects(stat(path.join(diffPlusRoot, ".codex", "environments", "environment.toml")));
  const projectEnvText = await readFile(path.join(popDetailsRoot, ".codex", "environments", "environment.toml"), "utf8");
  assert.match(projectEnvText, /BEGIN UNREAL PLUGIN PIPELINE ACTIONS: PopDetails/);
  assert.doesNotMatch(projectEnvText, /DiffPlus/);
});

test("Install Run Actions agent delegates to the deterministic installer script", async () => {
  const agentPrompt = await readFile(
    path.resolve("plugins", "unreal-plugin-pipeline", "skills", "install-unreal-run-actions", "agents", "openai.yaml"),
    "utf8",
  );

  assert.match(agentPrompt, /install-run-actions\.ps1/);
  assert.match(agentPrompt, /Do not search recursively/i);
  assert.match(agentPrompt, /do not choose the first plugin/i);
  assert.match(agentPrompt, /Pass -PluginName only if the user explicitly named a plugin/i);
  assert.match(agentPrompt, /Do not edit files manually/i);
  assert.match(agentPrompt, /Do not use git/i);
});

test("install and uninstall preserve existing Run environment actions", async () => {
  const module = await import("../scripts/unreal-plugin-pipeline.mjs");
  const projectRoot = await tempDir("preserve-run-actions");
  const runtimeSource = path.join(projectRoot, "runtime-source.mjs");
  const envPath = path.join(projectRoot, ".codex", "environments", "environment.toml");
  await writeFile(runtimeSource, "export const marker = true;\n", "utf8");
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(envPath, [
    "# existing config",
    "version = 1",
    "name = \"Existing\"",
    "",
    "[[actions]]",
    "name = \"Existing Run\"",
    "icon = \"run\"",
    "command = \"echo existing\"",
    "",
  ].join("\n"), "utf8");

  await module.installProjectRunActions({
    projectRoot,
    runtimeSourcePath: runtimeSource,
    projectName: "DemoPlugin",
  });
  let envText = await readFile(envPath, "utf8");
  assert.match(envText, /name = "Existing Run"/);
  assert.match(envText, /BEGIN UNREAL PLUGIN PIPELINE ACTIONS: DemoPlugin/);

  await removeProjectRunActions({
    projectRoot,
    projectName: "DemoPlugin",
  });
  envText = await readFile(envPath, "utf8");
  assert.match(envText, /name = "Existing Run"/);
  assert.doesNotMatch(envText, /UNREAL PLUGIN PIPELINE ACTIONS/);
  assert.doesNotMatch(envText, /name = "Build"/);
});

test("buildCodexExecArgs uses full-auto workspace-write without dangerous sandbox bypass", () => {
  const args = buildCodexExecArgs({
    projectRoot: "D:/Projects/MyPlugin",
    outputDirectory: "D:/Builds/MyPlugin",
    engines: [
      { version: "5.4", root: "D:/Epic/UE_5.4" },
      { version: "5.7", root: "D:/Epic/UE_5.7" },
    ],
    env: {
      APPDATA: "C:\\Users\\milli\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\milli\\AppData\\Local",
    },
  });

  assert.deepEqual(args.slice(0, 2), ["exec", "--cd"]);
  assert.ok(args.includes("--full-auto"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes("-c"));
  assert.ok(args.includes("approval_policy=\"never\""));
  assert.ok(args.includes("--add-dir"));
  assert.ok(args.includes("D:/Builds/MyPlugin"));
  assert.ok(args.includes("D:/Epic/UE_5.4"));
  assert.ok(args.includes("D:/Epic/UE_5.7"));
  assert.ok(args.includes("C:\\Users\\milli\\AppData\\Roaming\\Unreal Engine"));
  assert.ok(args.includes("C:\\Users\\milli\\AppData\\Local\\UnrealEngine"));
  assert.ok(args.includes("C:\\Users\\milli\\AppData\\Local\\Microsoft SDKs"));
  assert.ok(args.includes("-"));
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("codexSandboxWritableDirs adds only Unreal user-state directories", () => {
  assert.deepEqual(codexSandboxWritableDirs({
    env: {
      APPDATA: "C:\\Users\\milli\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\milli\\AppData\\Local",
    },
  }), [
    "C:\\Users\\milli\\AppData\\Roaming\\Unreal Engine",
    "C:\\Users\\milli\\AppData\\Local\\UnrealEngine",
    "C:\\Users\\milli\\AppData\\Local\\Microsoft SDKs",
  ]);
});

test("runUatProcessInvocation launches batch files through PowerShell instead of cmd shell", () => {
  const invocation = runUatProcessInvocation(
    "D:\\Epic\\UE_5.1\\Engine\\Build\\BatchFiles\\RunUAT.bat",
    ["BuildPlugin", "-Plugin=D:\\Plugins\\PopDetails\\PopDetails.uplugin"],
    { platform: "win32" },
  );

  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoProfile", "-ExecutionPolicy", "Bypass"]);
  assert.ok(invocation.args.includes("-Command"));
  assert.match(invocation.args.at(-1), /RunUAT\.bat/);
  assert.doesNotMatch(invocation.command, /cmd/i);
});

test("zipDirectoryProcessInvocation does not depend on Compress-Archive", () => {
  const invocation = zipDirectoryProcessInvocation("D:\\Builds\\Plugin Stage", "D:\\Builds\\Plugin.zip");

  assert.equal(invocation.command, "powershell.exe");
  assert.match(invocation.args.join(" "), /System\.IO\.Compression\.ZipFile/);
  assert.doesNotMatch(invocation.args.join(" "), /Compress-Archive/);
  assert.match(invocation.args.at(-1), /D:\\Builds\\Plugin Stage/);
  assert.match(invocation.args.at(-1), /D:\\Builds\\Plugin\.zip/);
});

test("build logs and release report paths are under the output directory", () => {
  const outputDirectory = "D:\\Builds\\DiffPlus";

  assert.equal(
    buildLogPath({ outputDirectory, pluginName: "DiffPlus", engineVersion: "5.7" }),
    path.join(outputDirectory, "logs", "DiffPlus-UE5.7.log"),
  );
  assert.equal(
    buildUatLogDirectory({ outputDirectory, engineVersion: "5.7" }),
    path.join(outputDirectory, "logs", "uat", "UE5.7"),
  );
  assert.equal(
    releaseReportPath(outputDirectory),
    path.join(outputDirectory, "reports", "last-release-report.md"),
  );
});

test("release agent prompt stores logs and reports in the output directory", () => {
  const projectRoot = "D:\\Projects\\DiffPlus";
  const outputDirectory = "D:\\Builds\\DiffPlus";
  const prompt = makeReleasePrompt({
    projectRoot,
    outputDirectory,
    maxFixAttempts: 3,
    runtimeScriptPath: "D:\\PluginBundle\\scripts\\unreal-plugin-pipeline.mjs",
  });

  assert.match(prompt, /D:\\Builds\\DiffPlus\\logs/);
  assert.match(prompt, /D:\\Builds\\DiffPlus\\reports\\last-release-report\.md/);
  assert.match(prompt, /invoke-unreal-plugin-pipeline\.ps1/);
  assert.doesNotMatch(prompt, /\bnode\s+'/);
  assert.doesNotMatch(prompt, /\.codex[\\/]unreal-plugin-pipeline[\\/]last-release-report\.md/);
});

test("buildCommandOptions treats --build-only as an option on build", () => {
  assert.deepEqual(
    buildCommandOptions(["--build-only", "--engine-version", "5.7"]),
    { buildOnly: true, engineVersion: "5.7" },
  );
  assert.deepEqual(
    buildCommandOptions([]),
    { buildOnly: false, engineVersion: "" },
  );
});

test("resolveCodexExecutable finds the Codex desktop local install when PATH misses it", async () => {
  const localAppData = "C:\\Users\\milli\\AppData\\Local";
  const expected = path.win32.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe");
  const resolved = await resolveCodexExecutable({
    env: {
      Path: "C:\\Windows\\System32",
      LOCALAPPDATA: localAppData,
    },
    homeDir: "C:\\Users\\milli",
    platform: "win32",
    pathExists: async (candidate) => candidate === expected,
  });

  assert.equal(resolved, expected);
});

test("resolveCodexExecutable ignores the Codex app WindowsApps sandbox binary", async () => {
  const localAppData = "C:\\Users\\milli\\AppData\\Local";
  const windowsApps = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.422.8496.0_x64__2p2nqsd0c76g0\\app\\resources";
  const sandboxBinary = path.win32.join(windowsApps, "codex.exe");
  const expected = path.win32.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe");
  const resolved = await resolveCodexExecutable({
    env: {
      Path: windowsApps,
      LOCALAPPDATA: localAppData,
    },
    homeDir: "C:\\Users\\milli",
    platform: "win32",
    pathExists: async (candidate) => candidate === sandboxBinary || candidate === expected,
  });

  assert.equal(resolved, expected);
});

test("resolveCodexExecutable returns null when only the Codex app WindowsApps sandbox binary exists", async () => {
  const windowsApps = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.422.8496.0_x64__2p2nqsd0c76g0\\app\\resources";
  const sandboxBinary = path.win32.join(windowsApps, "codex.exe");
  const resolved = await resolveCodexExecutable({
    env: {
      Path: windowsApps,
    },
    homeDir: "C:\\Users\\milli",
    platform: "win32",
    pathExists: async (candidate) => candidate === sandboxBinary,
  });

  assert.equal(resolved, null);
});

test("codexProcessInvocation runs Windows npm command shims through the Codex node script", () => {
  const nodeExe = "C:\\Users\\milli\\AppData\\Local\\Programs\\nodejs\\node.exe";
  const codexScript = "C:\\Users\\milli\\AppData\\Local\\Programs\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js";
  const invocation = codexProcessInvocation(
    "C:\\Users\\milli\\AppData\\Local\\Programs\\nodejs\\codex.cmd",
    ["exec", "--cd", "D:\\Users\\milli\\Sync\\Default Folder\\MyUEPlugins\\Plugins\\DiffPlus", "-"],
    {
      platform: "win32",
      pathExistsSync: (candidate) => candidate === nodeExe || candidate === codexScript,
    },
  );

  assert.deepEqual(invocation, {
    command: nodeExe,
    args: [
      codexScript,
      "exec",
      "--cd",
      "D:\\Users\\milli\\Sync\\Default Folder\\MyUEPlugins\\Plugins\\DiffPlus",
      "-",
    ],
  });
});

test("codexProcessInvocation runs executable Codex binaries directly", () => {
  const invocation = codexProcessInvocation(
    "C:\\Users\\milli\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe",
    ["exec", "--help"],
    { platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe" },
  );

  assert.deepEqual(invocation, {
    command: "C:\\Users\\milli\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe",
    args: ["exec", "--help"],
  });
});

test("copyReleasePackageForZip excludes pdb debug symbols from release zips", async () => {
  const root = await tempDir("release-zip-filter");
  const source = path.join(root, "DiffPlus-UE5.7");
  const staging = path.join(root, "zip-staging", "DiffPlus-UE5.7");
  await mkdir(path.join(source, "Binaries", "Win64"), { recursive: true });
  await mkdir(path.join(source, "Resources"), { recursive: true });
  await writeFile(path.join(source, "Binaries", "Win64", "UnrealEditor-DiffPlus.dll"), "dll", "utf8");
  await writeFile(path.join(source, "Binaries", "Win64", "UnrealEditor-DiffPlus.pdb"), "symbols", "utf8");
  await writeFile(path.join(source, "Binaries", "Win64", "ExtraSymbols.PDB"), "symbols", "utf8");
  await writeFile(path.join(source, "Binaries", "Win64", "UnrealEditor.modules"), "modules", "utf8");
  await writeFile(path.join(source, "Resources", "Icon128.png"), "icon", "utf8");

  await copyReleasePackageForZip({ sourceDir: source, stagingDir: staging });

  await stat(path.join(staging, "Binaries", "Win64", "UnrealEditor-DiffPlus.dll"));
  await stat(path.join(staging, "Binaries", "Win64", "UnrealEditor.modules"));
  await stat(path.join(staging, "Resources", "Icon128.png"));
  await assert.rejects(stat(path.join(staging, "Binaries", "Win64", "UnrealEditor-DiffPlus.pdb")));
  await assert.rejects(stat(path.join(staging, "Binaries", "Win64", "ExtraSymbols.PDB")));
});
