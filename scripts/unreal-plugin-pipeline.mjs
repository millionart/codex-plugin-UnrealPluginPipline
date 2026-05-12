#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, cp, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const GLOBAL_DIR = path.join(os.homedir(), ".unreal-plugin-pipeline");
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_DIR, "config.json");
const PROJECT_CONFIG_RELATIVE = path.join(".codex", "unreal-plugin-pipeline.json");
const DASHBOARD_RELATIVE = path.join(".codex", "unreal-plugin-pipeline", "dashboard.html");
const DASHBOARD_SERVER_RELATIVE = path.join(".codex", "unreal-plugin-pipeline", "dashboard-server.json");
const LEGACY_PROJECT_RUNTIME_RELATIVE = path.join(".codex", "unreal-plugin-pipeline", "bin");
const DASHBOARD_IDLE_MS = 30 * 60 * 1000;
const INVOKER_SCRIPT_NAME = "invoke-unreal-plugin-pipeline.ps1";

const DEFAULT_GLOBAL_CONFIG = {
  engineScanRoots: [
    "D:\\Epic\\Epic Games",
    "C:\\Program Files\\Epic Games",
  ],
  engineRoots: [],
  excludedVersions: [],
  outputDirectory: "",
  zipNamePattern: "{pluginName}-UE{engineVersion}.zip",
  maxFixAttemptsPerVersion: 3,
  allowDangerFullAccess: false,
};

const DEFAULT_PROJECT_CONFIG = {
  excludedVersions: [],
};

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function normalizeVersion(version) {
  const text = String(version || "").trim();
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return "";
  return `${Number(match[1])}.${Number(match[2])}`;
}

function versionFromPath(engineRoot) {
  const name = path.basename(engineRoot);
  const match = name.match(/(?:UE[_-]?)?(\d+)\.(\d+)/i);
  return match ? `${Number(match[1])}.${Number(match[2])}` : "";
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathEnvValue(env) {
  const key = Object.keys(env || {}).find((name) => name.toLowerCase() === "path");
  return key ? env[key] : "";
}

function codexExecutableNames(platform = process.platform) {
  if (platform !== "win32") return ["codex"];
  return ["codex.exe", "codex.cmd", "codex.bat", "codex"];
}

function codexExecutableCandidates({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  const pathModule = platform === "win32" ? path.win32 : path;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const candidates = [];

  for (const entry of String(pathEnvValue(env) || "").split(delimiter).filter(Boolean)) {
    for (const name of codexExecutableNames(platform)) {
      candidates.push(pathModule.join(entry, name));
    }
  }

  if (platform === "win32") {
    for (const root of uniq([
      env.LOCALAPPDATA,
      env.LocalAppData,
      env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Local") : "",
      homeDir ? path.win32.join(homeDir, "AppData", "Local") : "",
    ])) {
      candidates.push(path.win32.join(root, "OpenAI", "Codex", "bin", "codex.exe"));
    }
  }

  return uniq(candidates);
}

function isCodexAppWindowsAppsResource(candidate, platform = process.platform) {
  if (platform !== "win32") return false;
  const normalized = String(candidate || "").replaceAll("/", "\\").toLowerCase();
  return normalized.includes("\\windowsapps\\openai.codex_")
    && (
      normalized.endsWith("\\app\\resources\\codex.exe")
      || normalized.endsWith("\\app\\resources\\codex")
    );
}

export async function resolveCodexExecutable({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  pathExists = exists,
} = {}) {
  for (const candidate of codexExecutableCandidates({ env, homeDir, platform })) {
    if (isCodexAppWindowsAppsResource(candidate, platform)) continue;
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function codexCliUnavailableMessage(error) {
  const detail = error ? ` (${error.code || "error"}: ${error.message})` : "";
  return [
    `Codex CLI was not found or is not runnable${detail}.`,
    "Install the standalone Codex CLI with `npm install -g @openai/codex`, then make sure `codex --version` works from PowerShell.",
    "The Codex app WindowsApps resource is not a runnable `codex exec` CLI for this pipeline.",
  ].join(" ");
}

function cmdArgument(value, { alwaysQuote = false } = {}) {
  const text = String(value);
  const escaped = text.replaceAll("\"", "\\\"");
  if (alwaysQuote || text === "" || /[\s&()^|<>"]/.test(text)) {
    return `"${escaped}"`;
  }
  return escaped;
}

function isWindowsCommandShim(filePath, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(String(filePath || ""));
}

export function codexProcessInvocation(codexExecutable, args, {
  platform = process.platform,
  comSpec = process.env.ComSpec,
  pathExistsSync = existsSync,
} = {}) {
  if (isWindowsCommandShim(codexExecutable, platform)) {
    const directory = path.win32.dirname(codexExecutable);
    const codexScript = path.win32.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (pathExistsSync(codexScript)) {
      const adjacentNode = path.win32.join(directory, "node.exe");
      return {
        command: pathExistsSync(adjacentNode) ? adjacentNode : "node",
        args: [codexScript, ...args],
      };
    }

    const commandLine = [
      cmdArgument(codexExecutable, { alwaysQuote: true }),
      ...args.map((arg) => cmdArgument(arg)),
    ].join(" ");
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: codexExecutable, args };
}

async function readJsonIfExists(filePath, fallback) {
  if (!(await exists(filePath))) return structuredClone(fallback);
  const text = await readFile(filePath, "utf8");
  return { ...structuredClone(fallback), ...JSON.parse(text) };
}

async function readJsonFileIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readEngineBuildVersion(engineRoot) {
  const filePath = path.join(engineRoot, "Engine", "Build", "Build.version");
  if (!(await exists(filePath))) return "";
  try {
    const payload = JSON.parse(await readFile(filePath, "utf8"));
    if (payload.MajorVersion && payload.MinorVersion !== undefined) {
      return `${Number(payload.MajorVersion)}.${Number(payload.MinorVersion)}`;
    }
  } catch {
    return "";
  }
  return "";
}

function runUatPathFor(engineRoot) {
  return path.join(engineRoot, "Engine", "Build", "BatchFiles", "RunUAT.bat");
}

async function isEngineRoot(engineRoot) {
  return await exists(runUatPathFor(engineRoot));
}

async function candidateEngineRoots(scanRoots, explicitEngineRoots) {
  const candidates = [];

  for (const explicitRoot of explicitEngineRoots || []) {
    candidates.push(path.resolve(explicitRoot));
  }

  for (const scanRoot of scanRoots || []) {
    const resolvedScanRoot = path.resolve(scanRoot);
    if (!(await exists(resolvedScanRoot))) continue;

    if (await isEngineRoot(resolvedScanRoot)) {
      candidates.push(resolvedScanRoot);
      continue;
    }

    let entries = [];
    try {
      entries = await readdir(resolvedScanRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push(path.join(resolvedScanRoot, entry.name));
      }
    }
  }

  return uniq(candidates);
}

export async function discoverEngines({ scanRoots = [], explicitEngineRoots = [] } = {}) {
  const candidates = await candidateEngineRoots(scanRoots, explicitEngineRoots);
  const byVersion = new Map();

  for (const candidate of candidates) {
    if (!(await isEngineRoot(candidate))) continue;
    const version = normalizeVersion((await readEngineBuildVersion(candidate)) || versionFromPath(candidate));
    if (!version || byVersion.has(version)) continue;

    byVersion.set(version, {
      version,
      root: candidate,
      runUatPath: runUatPathFor(candidate),
    });
  }

  return [...byVersion.values()].sort((left, right) => compareVersions(left.version, right.version));
}

async function findFilesByExtension(root, extension, depth = 3) {
  const found = [];

  async function walk(current, currentDepth) {
    if (currentDepth > depth) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        found.push(absolute);
      } else if (entry.isDirectory() && shouldWalkDirectory(entry.name)) {
        await walk(absolute, currentDepth + 1);
      }
    }
  }

  await walk(root, 0);
  return found.sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function shouldWalkDirectory(name) {
  if ([".git", ".codex", "Binaries", "Intermediate", "Saved"].includes(name)) return false;
  return !name.startsWith("_Build");
}

export async function findUPlugin(projectRoot) {
  const descriptors = await findFilesByExtension(projectRoot, ".uplugin");
  if (descriptors.length === 0) {
    throw new Error(`No .uplugin descriptor found under ${projectRoot}`);
  }
  return descriptors[0];
}

export async function discoverUPluginProjectRoots(root, depth = 6) {
  const descriptors = await findFilesByExtension(path.resolve(root), ".uplugin", depth);
  return uniq(descriptors.map((descriptor) => path.dirname(descriptor)))
    .sort((left, right) => left.localeCompare(right));
}

async function findWorkspaceRoot(startDirectory) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDirectory);
    current = parent;
  }
}

export function resolveBuildPlan({ engines, globalConfig = {}, projectConfig = {} }) {
  const excluded = new Set([
    ...(globalConfig.excludedVersions || []),
    ...(projectConfig.excludedVersions || []),
  ].map(normalizeVersion));

  return [...engines]
    .filter((engine) => !excluded.has(normalizeVersion(engine.version)))
    .sort((left, right) => compareVersions(left.version, right.version));
}

export function withVersionExclusion(config, version, shouldExclude) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error(`Invalid Unreal Engine version: ${version}`);
  const versions = new Set((config.excludedVersions || []).map(normalizeVersion).filter(Boolean));
  if (shouldExclude) {
    versions.add(normalized);
  } else {
    versions.delete(normalized);
  }
  return {
    ...config,
    excludedVersions: [...versions].sort(compareVersions),
  };
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function normalizeStringList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n|,/);
  return uniq(values.map((entry) => String(entry || "").trim()).filter(Boolean));
}

function normalizePathList(value, baseDirectory = process.cwd()) {
  return normalizeStringList(value).map((entry) => path.resolve(baseDirectory, entry));
}

function normalizeVersionList(value) {
  return uniq(normalizeStringList(value).map(normalizeVersion).filter(Boolean)).sort(compareVersions);
}

function optionalResolvedPath(value, baseDirectory = process.cwd()) {
  const text = String(value || "").trim();
  return text ? path.resolve(baseDirectory, text) : "";
}

function sanitizeProjectConfigInput(config, previousConfig, projectRoot) {
  const previous = { ...DEFAULT_PROJECT_CONFIG, ...previousConfig };
  void projectRoot;
  return {
    excludedVersions: normalizeVersionList(config.excludedVersions ?? previous.excludedVersions),
  };
}

function sanitizeGlobalConfigInput(config, previousConfig) {
  const previous = { ...DEFAULT_GLOBAL_CONFIG, ...previousConfig };
  const maxFixAttempts = Number.parseInt(config.maxFixAttemptsPerVersion ?? previous.maxFixAttemptsPerVersion, 10);
  return {
    ...previous,
    engineScanRoots: normalizePathList(config.engineScanRoots ?? previous.engineScanRoots),
    engineRoots: normalizePathList(config.engineRoots ?? previous.engineRoots),
    excludedVersions: normalizeVersionList(config.excludedVersions ?? previous.excludedVersions),
    outputDirectory: optionalResolvedPath(config.outputDirectory ?? previous.outputDirectory),
    zipNamePattern: String(config.zipNamePattern || previous.zipNamePattern || DEFAULT_GLOBAL_CONFIG.zipNamePattern).trim()
      || DEFAULT_GLOBAL_CONFIG.zipNamePattern,
    maxFixAttemptsPerVersion: Number.isFinite(maxFixAttempts) && maxFixAttempts > 0 ? maxFixAttempts : DEFAULT_GLOBAL_CONFIG.maxFixAttemptsPerVersion,
    allowDangerFullAccess: Boolean(config.allowDangerFullAccess),
  };
}

function artifactFileName(value) {
  return String(value || "artifact").replace(/[<>:"/\\|?*\x00-\x1F]/g, "-");
}

export function buildLogPath({ outputDirectory, pluginName, engineVersion }) {
  return path.join(
    path.resolve(outputDirectory),
    "logs",
    `${artifactFileName(pluginName)}-UE${artifactFileName(engineVersion)}.log`,
  );
}

export function buildUatLogDirectory({ outputDirectory, engineVersion }) {
  return path.join(path.resolve(outputDirectory), "logs", "uat", `UE${artifactFileName(engineVersion)}`);
}

export function releaseReportPath(outputDirectory) {
  return path.join(path.resolve(outputDirectory), "reports", "last-release-report.md");
}

function invokerScriptPathFor(runtimeScriptPath) {
  return path.join(path.dirname(path.resolve(runtimeScriptPath)), INVOKER_SCRIPT_NAME);
}

function pipelineCommandText({ runtimeScriptPath, projectRoot, command, args = [], hidden = false }) {
  const executable = hidden ? "powershell -WindowStyle Hidden" : "powershell";
  return [
    executable,
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    powerShellSingleQuoted(invokerScriptPathFor(runtimeScriptPath)),
    "-PipelineCommand",
    command,
    "-ProjectRoot",
    powerShellSingleQuoted(projectRoot),
    ...args,
  ].join(" ");
}

function makeActionBlock({ projectName, runtimeScriptPath, projectRoot, includeProjectName }) {
  const suffix = includeProjectName ? ` ${projectName}` : "";
  const markerName = projectName.replaceAll(/[^A-Za-z0-9_.-]/g, "-");
  const buildCommand = pipelineCommandText({ runtimeScriptPath, projectRoot, command: "build" });
  const buildOnlyCommand = pipelineCommandText({ runtimeScriptPath, projectRoot, command: "build-only" });
  const detectCommand = pipelineCommandText({ runtimeScriptPath, projectRoot, command: "detect-engines" });
  const dashboardCommand = pipelineCommandText({ runtimeScriptPath, projectRoot, command: "dashboard", hidden: true });
  return [
    `# BEGIN UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`,
    "",
    "[[actions]]",
    `name = "Build${suffix}"`,
    "icon = \"run\"",
    `command = ${tomlString(buildCommand)}`,
    "",
    "[[actions]]",
    `name = "Build Only${suffix}"`,
    "icon = \"tool\"",
    `command = ${tomlString(buildOnlyCommand)}`,
    "",
    "[[actions]]",
    `name = "Detect Engines${suffix}"`,
    "icon = \"tool\"",
    `command = ${tomlString(detectCommand)}`,
    "",
    "[[actions]]",
    `name = "Show Config${suffix}"`,
    "icon = \"tool\"",
    `command = ${tomlString(dashboardCommand)}`,
    "",
    `# END UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`,
    "",
  ].join("\n");
}

function makeEnvironmentToml({ environmentName, projectName, runtimeScriptPath, projectRoot, includeProjectName, existingText = "" }) {
  const block = makeActionBlock({ projectName, runtimeScriptPath, projectRoot, includeProjectName });
  const markerName = projectName.replaceAll(/[^A-Za-z0-9_.-]/g, "-");
  const markerPairs = [
    [
      `# BEGIN UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`,
      `# END UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`,
    ],
    [
      "# BEGIN UNREAL PLUGIN PIPELINE ACTIONS",
      "# END UNREAL PLUGIN PIPELINE ACTIONS",
    ],
  ];

  for (const [begin, end] of markerPairs) {
    if (existingText.includes(begin) && existingText.includes(end)) {
      const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
      return existingText.replace(pattern, block);
    }
  }

  if (existingText.trim()) {
    return `${existingText.trimEnd()}\n\n${block}`;
  }

  return [
    "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
    "version = 1",
    `name = ${tomlString(environmentName)}`,
    "",
    "[setup]",
    "script = \"\"",
    "",
    block,
  ].join("\n");
}

function stripActionBlock({ projectName, existingText = "" }) {
  const markerName = projectName.replaceAll(/[^A-Za-z0-9_.-]/g, "-");
  const markerPairs = [
    [
      `# BEGIN UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`,
      `# END UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`,
    ],
    [
      "# BEGIN UNREAL PLUGIN PIPELINE ACTIONS",
      "# END UNREAL PLUGIN PIPELINE ACTIONS",
    ],
  ];

  let nextText = existingText;
  for (const [begin, end] of markerPairs) {
    if (nextText.includes(begin) && nextText.includes(end)) {
      const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
      nextText = nextText.replace(pattern, "");
    }
  }

  nextText = nextText.replace(/\n{3,}/g, "\n\n").trimEnd();
  return nextText ? `${nextText}\n` : "";
}

function isGeneratedEmptyEnvironment(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY")
    && trimmed.includes("[setup]")
    && !trimmed.includes("[[actions]]");
}

async function removeEnvironmentActionBlock({ targetPath, projectName }) {
  if (!(await exists(targetPath))) {
    return { targetPath, changed: false, removed: false };
  }

  const existingText = await readFile(targetPath, "utf8");
  const nextText = stripActionBlock({ projectName, existingText });
  if (nextText === existingText) {
    return { targetPath, changed: false, removed: false };
  }

  if (isGeneratedEmptyEnvironment(nextText)) {
    await unlink(targetPath);
    return { targetPath, changed: true, removed: true };
  }

  await writeFile(targetPath, nextText, "utf8");
  return { targetPath, changed: true, removed: false };
}

export function makeReleasePrompt({
  projectRoot,
  outputDirectory = "",
  maxFixAttempts,
  runtimeScriptPath = SELF_PATH,
}) {
  const detectCommand = pipelineCommandText({ runtimeScriptPath, projectRoot, command: "detect-engines" });
  const buildCommand = pipelineCommandText({
    runtimeScriptPath,
    projectRoot,
    command: "build",
    args: ["--build-only", "--engine-version", "<version>"],
  });
  const logsDirectory = path.join(path.resolve(outputDirectory || projectRoot), "logs");
  const reportPath = releaseReportPath(outputDirectory || projectRoot);
  return `You are the Unreal Plugin Pipeline release agent for this project.

Project root: ${projectRoot}
Build output directory: ${path.resolve(outputDirectory || projectRoot)}
Build logs directory: ${logsDirectory}
Release report path: ${reportPath}

Goal:
Build the current Unreal Engine plugin for every configured engine version from lowest to highest. If a build fails, diagnose the first concrete blocker, edit the plugin source or descriptor to fix it, retry the same engine version, and continue to the next version only after the current version builds successfully.

Required workflow:
1. Inspect .codex/unreal-plugin-pipeline.json and %USERPROFILE%/.unreal-plugin-pipeline/config.json if present.
2. Use ${detectCommand} to list available engines.
3. Use ${buildCommand} for each version, in ascending order.
4. When build-only fails, inspect the generated logs under ${logsDirectory} and the smallest useful compiler or packaging error.
5. Fix the project, then retry the same engine version.
6. Stop after ${maxFixAttempts} failed fix attempts for the same engine version and write a clear failure report.
7. Do not spawn another Codex process. You are already the release agent.
8. Do not use destructive git operations. Do not reset or revert user changes.
9. Do not write release reports or pipeline logs under the project .codex directory.

Output:
At the end, write ${reportPath} with the built engine versions, zip paths, fixes made, and any remaining blockers.`;
}

export async function writeProjectBootstrap({
  projectRoot,
  workspaceRoot = "",
  runtimeSourcePath = SELF_PATH,
  outputDirectory = "",
  projectName = path.basename(projectRoot),
  wireRunActions = false,
  workspaceRunActions = true,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  void workspaceRoot;
  void workspaceRunActions;
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedRuntimeScriptPath = path.resolve(runtimeSourcePath);
  const codexDir = path.join(resolvedProjectRoot, ".codex");
  const projectEnvironmentPath = path.join(resolvedProjectRoot, ".codex", "environments", "environment.toml");
  const projectConfigPath = path.join(resolvedProjectRoot, PROJECT_CONFIG_RELATIVE);
  const legacyRuntimeDir = path.join(resolvedProjectRoot, LEGACY_PROJECT_RUNTIME_RELATIVE);

  await mkdir(codexDir, { recursive: true });
  await removeDirectoryIfExists(legacyRuntimeDir);

  void outputDirectory;
  const existingProjectConfig = await readJsonIfExists(projectConfigPath, DEFAULT_PROJECT_CONFIG);
  const nextProjectConfig = sanitizeProjectConfigInput(existingProjectConfig, DEFAULT_PROJECT_CONFIG, resolvedProjectRoot);
  await writeJson(projectConfigPath, nextProjectConfig);

  const writeEnvironment = async ({ targetPath, environmentName, includeProjectName }) => {
    const existingEnvironment = (await exists(targetPath)) ? await readFile(targetPath, "utf8") : "";
    await writeFile(targetPath, makeEnvironmentToml({
      environmentName,
      projectName,
      runtimeScriptPath: resolvedRuntimeScriptPath,
      projectRoot: resolvedProjectRoot,
      includeProjectName,
      existingText: existingEnvironment,
    }), "utf8");
  };

  if (wireRunActions) {
    await mkdir(path.dirname(projectEnvironmentPath), { recursive: true });
    await writeEnvironment({
      targetPath: projectEnvironmentPath,
      environmentName: projectName,
      includeProjectName: false,
    });
  }

  return {
    runActionsWired: wireRunActions,
    environmentPath: wireRunActions ? projectEnvironmentPath : null,
    localEnvironmentPath: wireRunActions ? projectEnvironmentPath : null,
    projectConfigPath,
    runtimeScriptPath: resolvedRuntimeScriptPath,
  };
}

export async function installProjectRunActions({
  projectRoot,
  workspaceRoot = "",
  runtimeSourcePath = SELF_PATH,
  outputDirectory = "",
  projectName = path.basename(projectRoot),
} = {}) {
  return await writeProjectBootstrap({
    projectRoot,
    workspaceRoot,
    runtimeSourcePath,
    outputDirectory,
    projectName,
    wireRunActions: true,
    workspaceRunActions: false,
  });
}

export async function removeProjectRunActions({
  projectRoot,
  workspaceRoot = "",
  projectName = path.basename(projectRoot),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot || await findWorkspaceRoot(resolvedProjectRoot));
  const projectEnvironmentPath = path.join(resolvedProjectRoot, ".codex", "environments", "environment.toml");
  const targetPaths = [projectEnvironmentPath];
  const results = [];

  for (const targetPath of targetPaths) {
    results.push(await removeEnvironmentActionBlock({ targetPath, projectName }));
  }

  return {
    projectRoot: resolvedProjectRoot,
    workspaceRoot: resolvedWorkspaceRoot,
    results,
  };
}

export function codexSandboxWritableDirs({ env = process.env } = {}) {
  const appData = env.APPDATA || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Roaming") : "");
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Local") : "");
  return uniq([
    appData ? path.win32.join(appData, "Unreal Engine") : "",
    localAppData ? path.win32.join(localAppData, "UnrealEngine") : "",
    localAppData ? path.win32.join(localAppData, "Microsoft SDKs") : "",
  ]);
}

export function buildCodexExecArgs({ projectRoot, outputDirectory, engines, env = process.env }) {
  const args = [
    "exec",
    "--cd",
    projectRoot,
    "--sandbox",
    "workspace-write",
    "--full-auto",
    "-c",
    "approval_policy=\"never\"",
  ];

  for (const directory of uniq([
    outputDirectory,
    ...(engines || []).map((engine) => engine.root),
    ...codexSandboxWritableDirs({ env }),
  ])) {
    args.push("--add-dir", directory);
  }

  args.push("-");
  return args;
}

async function loadGlobalConfig(configPath = GLOBAL_CONFIG_PATH) {
  return await readJsonIfExists(configPath, DEFAULT_GLOBAL_CONFIG);
}

async function loadProjectConfig(projectRoot) {
  return await readJsonIfExists(path.join(projectRoot, PROJECT_CONFIG_RELATIVE), DEFAULT_PROJECT_CONFIG);
}

function applyPathTemplate(value, { pluginName = "" } = {}) {
  return String(value || "").replaceAll("{pluginName}", pluginName);
}

function resolveOutputDirectory(projectRoot, globalConfig, projectConfig, pluginName = "") {
  void projectConfig;
  const configuredDirectory = globalConfig.outputDirectory || path.join(projectRoot, "_UnrealPluginBuilds");
  return path.resolve(applyPathTemplate(configuredDirectory, { pluginName }));
}

async function configuredEngines(projectRoot) {
  const globalConfig = await loadGlobalConfig();
  const projectConfig = await loadProjectConfig(projectRoot);
  const engines = await discoverEngines({
    scanRoots: globalConfig.engineScanRoots || [],
    explicitEngineRoots: globalConfig.engineRoots || [],
  });
  const plan = resolveBuildPlan({ engines, globalConfig, projectConfig });
  return { globalConfig, projectConfig, engines, plan };
}

async function hasRunActionBlock(targetPath, projectName) {
  if (!(await exists(targetPath))) return false;
  const markerName = projectName.replaceAll(/[^A-Za-z0-9_.-]/g, "-");
  const text = await readFile(targetPath, "utf8");
  return text.includes(`# BEGIN UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`)
    && text.includes(`# END UNREAL PLUGIN PIPELINE ACTIONS: ${markerName}`);
}

function statusPill(label, enabled) {
  const className = enabled ? "pill ok" : "pill muted";
  const text = enabled ? "Installed" : "Not installed";
  return `<span class="${className}">${htmlEscape(label)}: ${text}</span>`;
}

function dashboardCommands(state) {
  return [
    {
      id: "build",
      title: "Build",
      description: "Builds selected engine versions from lowest to highest using the saved configuration, then starts the analysis and fix loop if a build fails.",
      command: pipelineCommandText({
        runtimeScriptPath: state.paths.runtime,
        projectRoot: state.projectRoot,
        command: "build",
      }),
    },
    {
      id: "uninstall",
      title: "Uninstall Run Actions",
      description: "Removes only the Run dropdown actions written by this plugin and leaves other actions intact.",
      command: pipelineCommandText({
        runtimeScriptPath: state.paths.runtime,
        projectRoot: state.projectRoot,
        command: "uninstall",
      }),
    },
  ];
}

function detectEngineCommand(state) {
  return {
    id: "detect",
    title: "Detect Engines",
    description: "Refreshes local Unreal Engine detection results and available versions.",
    command: pipelineCommandText({
      runtimeScriptPath: state.paths.runtime,
      projectRoot: state.projectRoot,
      command: "detect-engines",
    }),
  };
}

function commandCard(command, state) {
  const copyClass = command.id === "build"
    ? "icon-button copy-build"
    : command.id === "uninstall"
      ? "icon-button copy-danger"
      : "icon-button";
  const buildOptions = command.id === "build" && state
    ? `<div class="version-picker command-mode-picker">
      <div class="label">Build Mode</div>
      <div class="radio-row" id="buildCommandModeGroup" role="radiogroup" aria-label="Build mode">
        <label class="radio-pill selected">
          <input type="radio" name="buildCommandMode" value="build" data-build-command-mode="build" checked>
          Build
        </label>
        <label class="radio-pill">
          <input type="radio" name="buildCommandMode" value="build-only" data-build-command-mode="build-only">
          Build Only
        </label>
      </div>
    </div>
    <div class="version-picker command-version-picker" id="buildOnlyVersionPicker" hidden>
      <div class="label">Build Only Version</div>
      <div class="radio-row" id="buildOnlyVersionGroup" role="radiogroup" aria-label="Build Only version">${renderInitialBuildOnlyVersions(state)}</div>
    </div>`
    : "";
  return `<article class="command-card" data-command-card="${htmlEscape(command.id || "")}">
    <div>
      <h3>${htmlEscape(command.title)}</h3>
      <p>${htmlEscape(command.description)}</p>
    </div>
    <button type="button" class="${copyClass}" data-copy-command="${htmlEscape(command.command)}">Copy</button>
    ${buildOptions}
    <pre><code>${htmlEscape(command.command)}</code></pre>
  </article>`;
}

function configCommand(command) {
  return `<div class="config-command" data-config-command="${htmlEscape(command.id)}">
    <div class="config-command-header">
      <div>
        <h3>${htmlEscape(command.title)}</h3>
        <p>${htmlEscape(command.description)}</p>
      </div>
      <button type="button" class="icon-button" data-copy-command="${htmlEscape(command.command)}">Copy</button>
    </div>
    <pre><code>${htmlEscape(command.command)}</code></pre>
  </div>`;
}

function renderInitialBuildOnlyVersions(state) {
  const versions = state.engines
    .filter((engine) => engine.included)
    .map((engine) => engine.version);

  if (versions.length === 0) {
    return "<div class=\"label\">No selected versions. Enable a version in Project Config.</div>";
  }

  const selected = versions[0];
  return versions.map((version) => {
    const checked = version === selected ? " checked" : "";
    const selectedClass = version === selected ? " selected" : "";
    return `<label class="radio-pill${selectedClass}">
      <input type="radio" name="buildOnlyVersion" value="${htmlEscape(version)}" data-build-only-version="${htmlEscape(version)}"${checked}>
      UE ${htmlEscape(version)}
    </label>`;
  }).join("");
}

function renderInitialEngineRows(state) {
  if (state.engines.length === 0) {
    return "<tr><td colspan=\"4\">No Unreal Engine installs detected.</td></tr>";
  }

  return state.engines.map((engine) => {
    const disabled = engine.globalExcluded ? " disabled" : "";
    const checked = engine.included ? " checked" : "";
    const status = engine.globalExcluded
      ? "Global excluded"
      : engine.projectExcluded
        ? "Project excluded"
        : "Included";
    return `<tr>
      <td><input type="checkbox" class="upp-engine-checkbox" data-version="${htmlEscape(engine.version)}"${checked}${disabled}></td>
      <td>UE ${htmlEscape(engine.version)}</td>
      <td>${htmlEscape(status)}</td>
      <td>${htmlEscape(engine.root)}</td>
    </tr>`;
  }).join("");
}

async function openDashboardFile(dashboardPath) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Start-Process -FilePath ${powerShellSingleQuoted(dashboardPath)}`,
  ], {
    stdio: "ignore",
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Failed to open dashboard: powershell exited with ${result.status}`);
  }
}

async function openDashboardUrl(url) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Start-Process ${powerShellSingleQuoted(url)}`,
  ], {
    stdio: "ignore",
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Failed to open dashboard: powershell exited with ${result.status}`);
  }
}

function makeDashboardHtml({ state, apiBase = "", apiToken = "" }) {
  const engineRows = renderInitialEngineRows(state);
  const commandCards = new Map(dashboardCommands(state).map((command) => [command.id, commandCard(command, state)]));
  const detectCommand = configCommand(detectEngineCommand(state));
  const iconHref = apiToken
    ? `${apiBase || ""}/Resources/Icon128.png?token=${encodeURIComponent(apiToken)}`
    : "../../Resources/Icon128.png";
  const boot = {
    state: {
      ...state,
      commands: dashboardCommands(state),
    },
    apiBase,
    apiToken,
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(state.projectName)} - Unreal Plugin Pipeline</title>
  <link rel="icon" type="image/png" href="${htmlEscape(iconHref)}">
  <style>
    :root {
      color-scheme: dark;
      --bg: #111315;
      --panel: #1b1f23;
      --panel-2: #22272e;
      --line: #343a40;
      --text: #edf2f7;
      --muted: #9aa4af;
      --accent: #58a6ff;
      --accent-2: #8b949e;
      --ok: #3fb950;
      --warn: #d29922;
      --danger: #f85149;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      font: 14px/1.5 "Segoe UI", system-ui, sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    header {
      padding: 24px 36px 0;
      border-bottom: 1px solid var(--line);
      background: #16191d;
    }
    .header-brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .header-copy {
      min-width: 0;
    }
    .plugin-icon {
      width: 56px;
      height: 56px;
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      object-fit: cover;
      background: var(--panel-2);
    }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
    h2 { margin: 0 0 14px; font-size: 17px; letter-spacing: 0; }
    h3 { margin: 0; font-size: 14px; letter-spacing: 0; }
    p { margin: 4px 0 0; color: var(--muted); }
    nav {
      display: flex;
      gap: 4px;
      margin-top: 20px;
      overflow-x: auto;
    }
    nav button {
      appearance: none;
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 12px 14px 10px;
      cursor: pointer;
      font: inherit;
    }
    nav button.active {
      color: var(--text);
      border-color: var(--accent);
    }
    main { padding: 20px 36px 36px; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .grid {
      display: grid;
      grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
      gap: 16px;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 16px;
    }
    .meta {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 8px 14px;
    }
    .label { color: var(--muted); }
    .value { overflow-wrap: anywhere; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--panel-2);
      color: var(--muted);
    }
    .pill.ok { color: var(--ok); border-color: rgba(63, 185, 80, .45); }
    .pill.warn { color: var(--warn); border-color: rgba(210, 153, 34, .45); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 9px 8px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      background: #0d1117;
      padding: 9px 10px;
      font: inherit;
    }
    input[type="checkbox"] { width: auto; }
    input[type="radio"] { width: auto; }
    textarea {
      min-height: 88px;
      resize: vertical;
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: 12px;
    }
    label { display: grid; gap: 6px; color: var(--muted); }
    form { display: grid; gap: 12px; }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
    }
    .input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    button.primary, button.secondary, .icon-button {
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--text);
      background: var(--panel-2);
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
    }
    button.primary { border-color: rgba(88, 166, 255, .6); background: #1f6feb; }
    .copy-build {
      border-color: rgba(63, 185, 80, .65);
      background: rgba(63, 185, 80, .22);
    }
    .copy-danger {
      border-color: rgba(248, 81, 73, .7);
      background: rgba(248, 81, 73, .2);
    }
    button:disabled { opacity: .55; cursor: not-allowed; }
    pre {
      margin: 0;
      padding: 12px;
      overflow: auto;
      border-radius: 6px;
      background: #0d1117;
      border: 1px solid var(--line);
    }
    code { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; }
    .commands { display: grid; gap: 10px; }
    .version-picker {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    .radio-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .radio-pill {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 10px;
      color: var(--text);
      background: var(--panel-2);
      cursor: pointer;
    }
    .radio-pill.selected {
      border-color: rgba(88, 166, 255, .75);
      background: rgba(88, 166, 255, .16);
    }
    .command-version-picker {
      grid-column: 1 / -1;
      margin-bottom: 0;
    }
    .command-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel);
    }
    .command-card pre { grid-column: 1 / -1; }
    .config-command {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #0d1117;
    }
    .config-command-header {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-start;
    }
    .notice {
      border: 1px solid rgba(210, 153, 34, .4);
      color: #f0d58c;
      background: rgba(210, 153, 34, .08);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 14px;
    }
    .modal[hidden] { display: none; }
    .modal {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(0, 0, 0, .58);
      z-index: 20;
    }
    .modal-panel {
      width: min(780px, calc(100vw - 48px));
      max-height: min(720px, calc(100vh - 48px));
      display: grid;
      grid-template-rows: auto auto minmax(180px, 1fr) auto;
      gap: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 16px;
    }
    .directory-list {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0d1117;
    }
    .directory-list button {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      color: var(--text);
      background: transparent;
      padding: 9px 10px;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .directory-list button:hover { background: var(--panel-2); }
    #toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: min(420px, calc(100vw - 36px));
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0d1117;
      color: var(--text);
      padding: 10px 12px;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .16s ease, transform .16s ease;
      pointer-events: none;
    }
    #toast.visible { opacity: 1; transform: translateY(0); }
    @media (max-width: 920px) {
      main { padding: 16px; }
      header { padding: 22px 16px 0; }
      .plugin-icon { width: 48px; height: 48px; }
      .grid, .form-row, .input-row { grid-template-columns: 1fr; }
      .meta { grid-template-columns: 120px minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-brand">
      <img class="plugin-icon" src="${htmlEscape(iconHref)}" alt="${htmlEscape(state.projectName)} icon">
      <div class="header-copy">
        <h1>${htmlEscape(state.projectName)} - Unreal Plugin Pipeline</h1>
        <div class="label">${htmlEscape(state.projectName)} release settings</div>
      </div>
    </div>
    <nav aria-label="Dashboard sections">
      <button type="button" class="active" data-tab-button="project">Project</button>
      <button type="button" data-tab-button="project-config">Project Config</button>
      <button type="button" data-tab-button="global-config">Global Config</button>
    </nav>
  </header>
  <main>
    <section class="tab-panel active" data-tab="project">
      <div class="grid">
        <div class="panel">
          <h2>Project</h2>
          <div class="meta" id="projectMeta">
            <div class="label">Plugin</div><div class="value">${htmlEscape(state.projectName)}</div>
            <div class="label">Root</div><div class="value">${htmlEscape(state.projectRoot)}</div>
            <div class="label">Descriptor</div><div class="value">${htmlEscape(state.paths.descriptor)}</div>
            <div class="label">Output</div><div class="value" id="projectOutputValue">${htmlEscape(state.outputDirectory)}</div>
            <div class="label">Generated</div><div class="value">${htmlEscape(state.generatedAt)}</div>
          </div>
          <div class="label" style="margin-top:12px">Run actions installed</div>
          <div class="pills">
            ${statusPill("Workspace", state.runActions.workspace)}
            ${statusPill("Plugin", state.runActions.project)}
          </div>
        </div>
        <div class="panel">
          <h2>Files</h2>
          <div class="meta">
            <div class="label">Project config</div><div class="value">${htmlEscape(state.paths.projectConfig)}</div>
            <div class="label">Global config</div><div class="value">${htmlEscape(state.paths.globalConfig)}</div>
            <div class="label">Workspace action</div><div class="value">${htmlEscape(state.paths.workspaceEnvironment)}</div>
            <div class="label">Plugin action</div><div class="value">${htmlEscape(state.paths.projectEnvironment)}</div>
            <div class="label">Dashboard HTML</div><div class="value">${htmlEscape(state.paths.dashboard)}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="tab-panel" data-tab="project-config">
      <div class="commands">
        <div data-command-slot="build">${commandCards.get("build") || ""}</div>
        <div class="panel">
          <h2>Engine Selection</h2>
          <p id="engineSummary"></p>
          <form id="projectConfigForm">
            <table>
              <thead><tr><th>Use</th><th>Version</th><th>Status</th><th>Root</th></tr></thead>
              <tbody id="engineRows">${engineRows}</tbody>
            </table>
            <div class="actions">
              <span class="label">Unchecked versions are saved with Project Config.</span>
            </div>
            <button type="submit" class="primary">Save Project Config</button>
          </form>
        </div>
        <div data-command-slot="uninstall">${commandCards.get("uninstall") || ""}</div>
      </div>
    </section>

    <section class="tab-panel" data-tab="global-config">
      <div class="notice" id="saveNotice">Saving is enabled when this page is opened from the Codex Run action. If opened as a local file, copy commands still work but config writes are disabled.</div>
      <div class="panel">
        <h2>Global Config</h2>
        <form id="globalConfigForm">
          <label>Engine Scan Roots
            <textarea id="globalScanRoots">${htmlEscape((state.globalConfig.engineScanRoots || []).join("\\n"))}</textarea>
          </label>
          ${detectCommand}
          <label>Engine Roots
            <textarea id="globalEngineRoots">${htmlEscape((state.globalConfig.engineRoots || []).join("\\n"))}</textarea>
          </label>
          <div class="form-row">
            <label>Output Directory
              <div class="input-row">
                <input id="globalOutput" autocomplete="off" value="${htmlEscape(state.globalConfig.outputDirectory || "")}">
                <button type="button" class="secondary" data-browse-target="globalOutput">Browse</button>
              </div>
            </label>
            <label>Zip Name Pattern
              <input id="globalZipPattern" autocomplete="off" value="${htmlEscape(state.globalConfig.zipNamePattern || DEFAULT_GLOBAL_CONFIG.zipNamePattern)}">
            </label>
          </div>
          <div class="form-row">
            <label>Max Fix Attempts
              <input id="globalMaxFix" type="number" min="1" max="20" value="${htmlEscape(state.globalConfig.maxFixAttemptsPerVersion || DEFAULT_GLOBAL_CONFIG.maxFixAttemptsPerVersion)}">
            </label>
          </div>
          <label style="display:flex;gap:8px;align-items:center">
            <input id="globalDanger" type="checkbox"${state.globalConfig.allowDangerFullAccess ? " checked" : ""}>
            Allow dangerous full access
          </label>
          <button type="submit" class="primary">Save Global Config</button>
        </form>
      </div>
    </section>
  </main>
  <div class="modal" id="directoryBrowser" hidden>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="directoryBrowserTitle">
      <h2 id="directoryBrowserTitle">Browse Directory</h2>
      <div class="input-row">
        <input id="browsePath" autocomplete="off">
        <button type="button" class="secondary" id="browseGo">Go</button>
      </div>
      <div class="directory-list" id="browseEntries"></div>
      <div class="actions">
        <button type="button" class="primary" id="browseSelect">Select</button>
        <button type="button" class="secondary" id="browseClose">Cancel</button>
      </div>
    </div>
  </div>
  <div id="toast" role="status"></div>
  <script id="upp-dashboard-data" type="application/json">${jsonScript(boot)}</script>
  <script>
    (function () {
      const boot = JSON.parse(document.getElementById("upp-dashboard-data").textContent);
      let state = boot.state;
      const apiEnabled = Boolean(boot.apiToken);
      const toast = document.getElementById("toast");
      let buildCommandMode = "build";
      let buildOnlyVersion = selectedVersions()[0] || "";
      let browseTargetId = "";

      function escapeHtml(value) {
        return String(value == null ? "" : value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function psQuote(value) {
        return "'" + String(value == null ? "" : value).replaceAll("'", "''") + "'";
      }

      function pipelineCommand(command, extraArgs) {
        return [
          "powershell",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          psQuote(state.paths.invoker),
          "-PipelineCommand",
          command,
          "-ProjectRoot",
          psQuote(state.projectRoot),
          ...(extraArgs || []),
        ].join(" ");
      }

      function lines(value) {
        return String(value || "").split(/\\r?\\n|,/).map((entry) => entry.trim()).filter(Boolean);
      }

      function compareVersions(left, right) {
        const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
        const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
        const length = Math.max(a.length, b.length);
        for (let index = 0; index < length; index += 1) {
          const diff = (a[index] || 0) - (b[index] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      }

      function showToast(message) {
        toast.textContent = message;
        toast.classList.add("visible");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
      }

      function selectedVersions() {
        const projectExcluded = new Set(state.projectConfig.excludedVersions || []);
        const globalExcluded = new Set(state.globalConfig.excludedVersions || []);
        return state.engines
          .filter((engine) => !projectExcluded.has(engine.version) && !globalExcluded.has(engine.version))
          .map((engine) => engine.version);
      }

      function refreshEngineFlags() {
        const projectExcluded = new Set(state.projectConfig.excludedVersions || []);
        const globalExcluded = new Set(state.globalConfig.excludedVersions || []);
        state.engines = state.engines.map((engine) => ({
          ...engine,
          projectExcluded: projectExcluded.has(engine.version),
          globalExcluded: globalExcluded.has(engine.version),
          included: !projectExcluded.has(engine.version) && !globalExcluded.has(engine.version),
        }));
      }

      function normalizeBuildOnlyVersion() {
        const versions = selectedVersions();
        if (!versions.includes(buildOnlyVersion)) {
          buildOnlyVersion = versions[0] || "";
        }
        return buildOnlyVersion;
      }

      function commandSpecs() {
        const version = normalizeBuildOnlyVersion() || "<version>";
        const buildOnly = buildCommandMode === "build-only";
        return [
          {
            id: "build",
            title: "Build",
            description: buildOnly
              ? "Builds only UE " + version + ", useful for quickly checking whether that engine packages successfully."
              : "Builds selected engine versions from lowest to highest using the saved configuration, then starts the analysis and fix loop if a build fails.",
            command: buildOnly
              ? pipelineCommand("build", ["--build-only", "--engine-version", version])
              : pipelineCommand("build"),
          },
          {
            id: "uninstall",
            title: "Uninstall Run Actions",
            description: "Removes only the Run dropdown actions written by this plugin and leaves other actions intact.",
            command: pipelineCommand("uninstall"),
          },
        ];
      }

      function renderEngines() {
        const rows = state.engines.length
          ? state.engines.map((engine) => {
              const status = engine.globalExcluded ? "Global excluded" : engine.projectExcluded ? "Project excluded" : "Included";
              return '<tr>' +
                '<td><input type="checkbox" class="upp-engine-checkbox" data-version="' + escapeHtml(engine.version) + '"' + (engine.included ? " checked" : "") + (engine.globalExcluded ? " disabled" : "") + '></td>' +
                '<td>UE ' + escapeHtml(engine.version) + '</td>' +
                '<td>' + escapeHtml(status) + '</td>' +
                '<td>' + escapeHtml(engine.root) + '</td>' +
              '</tr>';
            }).join("")
          : '<tr><td colspan="4">No Unreal Engine installs detected.</td></tr>';
        document.getElementById("engineRows").innerHTML = rows;
        document.getElementById("engineSummary").textContent = selectedVersions().length
          ? "Selected order: UE " + selectedVersions().join(" -> UE ")
          : "No versions selected.";
      }

      function renderBuildOnlyVersions() {
        const versions = selectedVersions();
        const selected = normalizeBuildOnlyVersion();
        const group = document.getElementById("buildOnlyVersionGroup");
        if (!group) return;
        if (versions.length === 0) {
          group.innerHTML = '<div class="label">No selected versions. Enable a version in Project Config.</div>';
          return;
        }
        group.innerHTML = versions.map((version) => (
          '<label class="radio-pill' + (version === selected ? " selected" : "") + '">' +
            '<input type="radio" name="buildOnlyVersion" value="' + escapeHtml(version) + '" data-build-only-version="' + escapeHtml(version) + '"' + (version === selected ? " checked" : "") + '>' +
            'UE ' + escapeHtml(version) +
          '</label>'
        )).join("");
      }

      function buildOnlyVersionPickerHtml() {
        const versions = selectedVersions();
        if (versions.length === 0) {
          return '<div class="label">No selected versions. Enable a version in Project Config.</div>';
        }
        const selected = normalizeBuildOnlyVersion();
        return versions.map((version) => (
          '<label class="radio-pill' + (version === selected ? " selected" : "") + '">' +
            '<input type="radio" name="buildOnlyVersion" value="' + escapeHtml(version) + '" data-build-only-version="' + escapeHtml(version) + '"' + (version === selected ? " checked" : "") + '>' +
            'UE ' + escapeHtml(version) +
          '</label>'
        )).join("");
      }

      function buildModePickerHtml() {
        return '<div class="version-picker command-mode-picker">' +
          '<div class="label">Build Mode</div>' +
          '<div class="radio-row" id="buildCommandModeGroup" role="radiogroup" aria-label="Build mode">' +
            '<label class="radio-pill' + (buildCommandMode === "build" ? " selected" : "") + '">' +
              '<input type="radio" name="buildCommandMode" value="build" data-build-command-mode="build"' + (buildCommandMode === "build" ? " checked" : "") + '>' +
              'Build' +
            '</label>' +
            '<label class="radio-pill' + (buildCommandMode === "build-only" ? " selected" : "") + '">' +
              '<input type="radio" name="buildCommandMode" value="build-only" data-build-command-mode="build-only"' + (buildCommandMode === "build-only" ? " checked" : "") + '>' +
              'Build Only' +
            '</label>' +
          '</div>' +
        '</div>';
      }

      function buildOptionsHtml() {
        return buildModePickerHtml() +
          '<div class="version-picker command-version-picker" id="buildOnlyVersionPicker"' + (buildCommandMode === "build-only" ? "" : " hidden") + '>' +
            '<div class="label">Build Only Version</div>' +
            '<div class="radio-row" id="buildOnlyVersionGroup" role="radiogroup" aria-label="Build Only version">' + buildOnlyVersionPickerHtml() + '</div>' +
          '</div>';
      }

      function commandCardHtml(item) {
        return (
          '<article class="command-card" data-command-card="' + escapeHtml(item.id || "") + '">' +
            '<div><h3>' + escapeHtml(item.title) + '</h3><p>' + escapeHtml(item.description) + '</p></div>' +
            '<button type="button" class="icon-button' + (item.id === "build" ? " copy-build" : item.id === "uninstall" ? " copy-danger" : "") + '" data-copy-command="' + escapeHtml(item.command) + '">Copy</button>' +
            (item.id === "build" ? buildOptionsHtml() : '') +
            '<pre><code>' + escapeHtml(item.command) + '</code></pre>' +
          '</article>'
        );
      }

      function renderCommands() {
        const specs = commandSpecs();
        ["build", "uninstall"].forEach((id) => {
          const slot = document.querySelector('[data-command-slot="' + id + '"]');
          const item = specs.find((entry) => entry.id === id);
          if (slot && item) slot.innerHTML = commandCardHtml(item);
        });
      }

      function renderProjectSummary() {
        document.getElementById("projectOutputValue").textContent = state.outputDirectory || "";
      }

      function fillForms() {
        document.getElementById("globalScanRoots").value = (state.globalConfig.engineScanRoots || []).join("\\n");
        document.getElementById("globalEngineRoots").value = (state.globalConfig.engineRoots || []).join("\\n");
        document.getElementById("globalOutput").value = state.globalConfig.outputDirectory || "";
        document.getElementById("globalZipPattern").value = state.globalConfig.zipNamePattern || "{pluginName}-UE{engineVersion}.zip";
        document.getElementById("globalMaxFix").value = state.globalConfig.maxFixAttemptsPerVersion || 3;
        document.getElementById("globalDanger").checked = Boolean(state.globalConfig.allowDangerFullAccess);
      }

      function renderAll() {
        refreshEngineFlags();
        renderProjectSummary();
        renderEngines();
        renderBuildOnlyVersions();
        renderCommands();
        fillForms();
      }

      async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }

      async function postConfig(scope, config) {
        if (!apiEnabled) {
          showToast("Open this page from Codex Run > Show Config to save changes.");
          return;
        }
        const response = await fetch(boot.apiBase + "/api/config/" + scope, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-UPP-Token": boot.apiToken,
          },
          body: JSON.stringify({ config }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Save failed");
        state = payload.state;
        renderAll();
        showToast(scope === "project" ? "Project config saved." : "Global config saved.");
      }

      document.querySelectorAll("[data-tab-button]").forEach((button) => {
        button.addEventListener("click", () => {
          document.querySelectorAll("[data-tab-button]").forEach((entry) => entry.classList.toggle("active", entry === button));
          document.querySelectorAll("[data-tab]").forEach((panel) => panel.classList.toggle("active", panel.dataset.tab === button.dataset.tabButton));
        });
      });

      document.addEventListener("click", async (event) => {
        const copyButton = event.target.closest("[data-copy-command]");
        if (copyButton) {
          await copyText(copyButton.dataset.copyCommand);
          showToast("Command copied.");
        }
      });

      document.addEventListener("change", (event) => {
        if (event.target.matches("[data-build-command-mode]")) {
          buildCommandMode = event.target.dataset.buildCommandMode;
          renderCommands();
          return;
        }
        if (!event.target.matches("[data-build-only-version]")) return;
        buildOnlyVersion = event.target.dataset.buildOnlyVersion;
        renderCommands();
      });

      document.getElementById("engineRows").addEventListener("change", (event) => {
        if (!event.target.classList.contains("upp-engine-checkbox")) return;
        const unknownExcluded = (state.projectConfig.excludedVersions || []).filter((version) => !state.engines.some((engine) => engine.version === version));
        const unchecked = Array.from(document.querySelectorAll(".upp-engine-checkbox"))
          .filter((checkbox) => !checkbox.disabled && !checkbox.checked)
          .map((checkbox) => checkbox.dataset.version);
        state.projectConfig.excludedVersions = Array.from(new Set([...unknownExcluded, ...unchecked])).sort(compareVersions);
        refreshEngineFlags();
        renderEngines();
        renderBuildOnlyVersions();
        renderCommands();
      });

      document.getElementById("projectConfigForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        await postConfig("project", {
          excludedVersions: state.projectConfig.excludedVersions || [],
        });
      });

      document.getElementById("globalConfigForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        await postConfig("global", {
          engineScanRoots: lines(document.getElementById("globalScanRoots").value),
          engineRoots: lines(document.getElementById("globalEngineRoots").value),
          outputDirectory: document.getElementById("globalOutput").value,
          zipNamePattern: document.getElementById("globalZipPattern").value,
          maxFixAttemptsPerVersion: Number.parseInt(document.getElementById("globalMaxFix").value, 10),
          allowDangerFullAccess: document.getElementById("globalDanger").checked,
        });
      });

      async function browseDirectory(directory) {
        if (!apiEnabled) {
          showToast("Open this page from Codex Run > Show Config to browse folders.");
          return;
        }
        const query = directory ? "?path=" + encodeURIComponent(directory) : "";
        const response = await fetch((boot.apiBase || "") + "/api/browse" + query, {
          headers: { "X-UPP-Token": boot.apiToken },
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Browse failed");
        document.getElementById("browsePath").value = payload.path;
        const entries = [];
        if (payload.parent) {
          entries.push('<button type="button" data-browse-path="' + escapeHtml(payload.parent) + '">..</button>');
        }
        entries.push(...payload.entries.map((entry) => (
          '<button type="button" data-browse-path="' + escapeHtml(entry.path) + '">' + escapeHtml(entry.name) + '</button>'
        )));
        document.getElementById("browseEntries").innerHTML = entries.length
          ? entries.join("")
          : '<div class="label" style="padding:10px">No child directories.</div>';
      }

      async function pickDirectory(initialPath) {
        if (!apiEnabled) {
          showToast("Open this page from Codex Run > Show Config to browse folders.");
          return "";
        }
        const response = await fetch((boot.apiBase || "") + "/api/pick-directory", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-UPP-Token": boot.apiToken,
          },
          body: JSON.stringify({ initialPath }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Native browse failed");
        return payload.path || "";
      }

      document.addEventListener("click", async (event) => {
        const browseButton = event.target.closest("[data-browse-target]");
        if (browseButton) {
          browseTargetId = browseButton.dataset.browseTarget;
          const input = document.getElementById(browseTargetId);
          const initialPath = input.value || state.projectRoot;
          try {
            const selectedPath = await pickDirectory(initialPath);
            if (selectedPath) {
              input.value = selectedPath;
              showToast("Directory selected.");
            }
          } catch (error) {
            showToast("Native browse unavailable. Opening folder list.");
            document.getElementById("directoryBrowser").hidden = false;
            await browseDirectory(initialPath);
          }
          return;
        }

        const browseEntry = event.target.closest("[data-browse-path]");
        if (browseEntry) {
          await browseDirectory(browseEntry.dataset.browsePath);
        }
      });

      document.getElementById("browseGo").addEventListener("click", async () => {
        await browseDirectory(document.getElementById("browsePath").value);
      });

      document.getElementById("browseSelect").addEventListener("click", () => {
        if (browseTargetId) {
          document.getElementById(browseTargetId).value = document.getElementById("browsePath").value;
        }
        document.getElementById("directoryBrowser").hidden = true;
      });

      document.getElementById("browseClose").addEventListener("click", () => {
        document.getElementById("directoryBrowser").hidden = true;
      });

      if (!apiEnabled) {
        document.querySelectorAll('form button[type="submit"], form button[data-browse-target]').forEach((button) => { button.disabled = true; });
      } else {
        document.getElementById("saveNotice").style.display = "none";
      }

      renderAll();
    }());
  </script>
</body>
</html>
`;
}

async function buildDashboardState({
  projectRoot,
  globalConfig = null,
  projectConfig = null,
  globalConfigPath = GLOBAL_CONFIG_PATH,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const resolvedProjectRoot = path.resolve(projectRoot);
  const descriptorPath = await findUPlugin(resolvedProjectRoot);
  const projectName = pluginNameFromDescriptor(descriptorPath);
  const resolvedWorkspaceRoot = await findWorkspaceRoot(resolvedProjectRoot);
  const effectiveGlobalConfig = globalConfig || await loadGlobalConfig(globalConfigPath);
  const effectiveProjectConfig = projectConfig || await loadProjectConfig(resolvedProjectRoot);
  const detectedEngines = await discoverEngines({
    scanRoots: effectiveGlobalConfig.engineScanRoots || [],
    explicitEngineRoots: effectiveGlobalConfig.engineRoots || [],
  });
  const plan = resolveBuildPlan({
    engines: detectedEngines,
    globalConfig: effectiveGlobalConfig,
    projectConfig: effectiveProjectConfig,
  });
  const planVersions = new Set(plan.map((engine) => engine.version));
  const projectExcluded = new Set((effectiveProjectConfig.excludedVersions || []).map(normalizeVersion).filter(Boolean));
  const globalExcluded = new Set((effectiveGlobalConfig.excludedVersions || []).map(normalizeVersion).filter(Boolean));
  const outputDirectory = resolveOutputDirectory(resolvedProjectRoot, effectiveGlobalConfig, effectiveProjectConfig, projectName);
  const workspaceEnvironmentPath = path.join(resolvedWorkspaceRoot, ".codex", "environments", "environment.toml");
  const projectEnvironmentPath = path.join(resolvedProjectRoot, ".codex", "environments", "environment.toml");
  const dashboardPath = path.join(resolvedProjectRoot, DASHBOARD_RELATIVE);
  const runtimePath = SELF_PATH;

  return {
    projectRoot: resolvedProjectRoot,
    workspaceRoot: resolvedWorkspaceRoot,
    projectName,
    outputDirectory,
    generatedAt: new Date().toLocaleString(),
    paths: {
      descriptor: descriptorPath,
      projectConfig: path.join(resolvedProjectRoot, PROJECT_CONFIG_RELATIVE),
      globalConfig: globalConfigPath,
      workspaceEnvironment: workspaceEnvironmentPath,
      projectEnvironment: projectEnvironmentPath,
      dashboard: dashboardPath,
      runtime: runtimePath,
      invoker: invokerScriptPathFor(runtimePath),
    },
    runActions: {
      workspace: await hasRunActionBlock(workspaceEnvironmentPath, projectName),
      project: await hasRunActionBlock(projectEnvironmentPath, projectName),
    },
    engines: detectedEngines.map((engine) => ({
      ...engine,
      projectExcluded: projectExcluded.has(engine.version),
      globalExcluded: globalExcluded.has(engine.version),
      included: planVersions.has(engine.version),
    })),
    projectConfig: effectiveProjectConfig,
    globalConfig: effectiveGlobalConfig,
  };
}

export async function generateProjectDashboard({
  projectRoot,
  globalConfig = null,
  projectConfig = null,
  globalConfigPath = GLOBAL_CONFIG_PATH,
  open = false,
} = {}) {
  const state = await buildDashboardState({ projectRoot, globalConfig, projectConfig, globalConfigPath });
  const dashboardPath = state.paths.dashboard;
  const html = makeDashboardHtml({ state });

  await mkdir(path.dirname(dashboardPath), { recursive: true });
  await writeFile(dashboardPath, html, "utf8");

  let opened = false;
  if (open) {
    await openDashboardFile(dashboardPath);
    opened = true;
  }

  return { dashboardPath, opened };
}

export async function saveDashboardConfig({
  projectRoot,
  globalConfigPath = GLOBAL_CONFIG_PATH,
  scope,
  config = {},
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const resolvedProjectRoot = path.resolve(projectRoot);
  if (scope === "project") {
    const configPath = path.join(resolvedProjectRoot, PROJECT_CONFIG_RELATIVE);
    const previous = await readJsonIfExists(configPath, DEFAULT_PROJECT_CONFIG);
    await writeJson(configPath, sanitizeProjectConfigInput(config, previous, resolvedProjectRoot));
  } else if (scope === "global") {
    const previous = await readJsonIfExists(globalConfigPath, DEFAULT_GLOBAL_CONFIG);
    await writeJson(globalConfigPath, sanitizeGlobalConfigInput(config, previous));
  } else {
    throw new Error(`Unsupported dashboard config scope: ${scope}`);
  }

  return await buildDashboardState({ projectRoot: resolvedProjectRoot, globalConfigPath });
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function requestAuthorized(request, url, token) {
  if (!token) return true;
  return request.headers["x-upp-token"] === token || url.searchParams.get("token") === token;
}

async function resolveBrowseDirectory(target, fallback) {
  let current = target;

  while (true) {
    try {
      const currentStat = await stat(current);
      return currentStat.isDirectory() ? current : path.dirname(current);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return fallback;
      current = parent;
    }
  }
}

async function browseDirectory(requestedPath, fallbackPath) {
  const fallback = path.resolve(fallbackPath || os.homedir());
  const target = path.resolve(String(requestedPath || fallback));
  const directoryPath = await resolveBrowseDirectory(target, fallback);
  const root = path.parse(directoryPath).root;
  const entries = await readdir(directoryPath, { withFileTypes: true });

  return {
    path: directoryPath,
    parent: directoryPath === root ? "" : path.dirname(directoryPath),
    entries: entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(directoryPath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function pickDirectoryWithDialog({ initialPath = "", fallbackPath = "" } = {}) {
  const fallback = path.resolve(fallbackPath || os.homedir());
  const target = path.resolve(String(initialPath || fallback));
  const startPath = await resolveBrowseDirectory(target, fallback).catch(() => fallback);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select output directory"
$dialog.ShowNewFolderButton = $true
$initial = [Environment]::GetEnvironmentVariable("UPP_INITIAL_DIRECTORY")
if ($initial -and (Test-Path -LiteralPath $initial)) {
  $dialog.SelectedPath = $initial
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    env: { ...process.env, UPP_INITIAL_DIRECTORY: startPath },
    windowsHide: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || `Folder picker exited with ${result.status}`).trim());
  }

  return String(result.stdout || "").trim();
}

export async function startDashboardServer({
  projectRoot,
  globalConfigPath = GLOBAL_CONFIG_PATH,
  port = 0,
  token = randomBytes(16).toString("hex"),
  idleMs = DASHBOARD_IDLE_MS,
  pickDirectory = pickDirectoryWithDialog,
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const currentRuntime = {
    runtimePath: SELF_PATH,
    runtimeFingerprint: await runtimeFingerprint(SELF_PATH),
  };
  let idleTimer = null;
  let server = null;

  const touch = () => {
    if (!idleMs || !server) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), idleMs);
    idleTimer.unref?.();
  };

  server = createServer(async (request, response) => {
    try {
      touch();
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (url.pathname === "/api/health") {
        if (!requestAuthorized(request, url, token)) return sendJson(response, 403, { error: "Forbidden" });
        return sendJson(response, 200, { ok: true, projectRoot: resolvedProjectRoot });
      }

      if (url.pathname === "/api/state") {
        if (!requestAuthorized(request, url, token)) return sendJson(response, 403, { error: "Forbidden" });
        return sendJson(response, 200, { state: await buildDashboardState({ projectRoot: resolvedProjectRoot, globalConfigPath }) });
      }

      if (url.pathname === "/api/browse") {
        if (!requestAuthorized(request, url, token)) return sendJson(response, 403, { error: "Forbidden" });
        return sendJson(response, 200, await browseDirectory(url.searchParams.get("path"), resolvedProjectRoot));
      }

      if (request.method === "POST" && url.pathname === "/api/pick-directory") {
        if (!requestAuthorized(request, url, token)) return sendJson(response, 403, { error: "Forbidden" });
        const body = await readRequestJson(request);
        const pickedPath = await pickDirectory({
          initialPath: body.initialPath || resolvedProjectRoot,
          fallbackPath: resolvedProjectRoot,
        });
        return sendJson(response, 200, pickedPath ? { path: path.resolve(pickedPath) } : { canceled: true });
      }

      if (request.method === "POST" && (url.pathname === "/api/config/project" || url.pathname === "/api/config/global")) {
        if (!requestAuthorized(request, url, token)) return sendJson(response, 403, { error: "Forbidden" });
        const body = await readRequestJson(request);
        const scope = url.pathname.endsWith("/project") ? "project" : "global";
        const state = await saveDashboardConfig({
          projectRoot: resolvedProjectRoot,
          globalConfigPath,
          scope,
          config: body.config || {},
        });
        return sendJson(response, 200, { state });
      }

      if (request.method === "GET" && url.pathname === "/Resources/Icon128.png") {
        if (!requestAuthorized(request, url, token)) return sendJson(response, 403, { error: "Forbidden" });
        try {
          const iconBytes = await readFile(path.join(resolvedProjectRoot, "Resources", "Icon128.png"));
          response.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "no-store",
          });
          response.end(iconBytes);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
        }
        return;
      }

      if (request.method !== "GET" || url.pathname !== "/") {
        return sendJson(response, 404, { error: "Not found" });
      }

      if (!requestAuthorized(request, url, token)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }

      const state = await buildDashboardState({ projectRoot: resolvedProjectRoot, globalConfigPath });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(makeDashboardHtml({ state, apiBase: "", apiToken: token }));
    } catch (error) {
      sendJson(response, 500, { error: error.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  touch();

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(token)}`;
  await mkdir(path.join(resolvedProjectRoot, ".codex", "unreal-plugin-pipeline"), { recursive: true });
  await writeJson(path.join(resolvedProjectRoot, DASHBOARD_SERVER_RELATIVE), {
    pid: process.pid,
    port: actualPort,
    url,
    startedAt: new Date().toISOString(),
    runtimePath: currentRuntime.runtimePath,
    runtimeFingerprint: currentRuntime.runtimeFingerprint,
  });

  return { server, port: actualPort, token, url };
}

async function waitForDashboardServer(baseUrl, token) {
  const healthUrl = `${baseUrl}/api/health`;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 5000) {
    try {
      const response = await fetch(healthUrl, {
        headers: { "X-UPP-Token": token },
      });
      if (response.ok) return;
      lastError = new Error(`health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error("Dashboard server did not start");
}

function dashboardBaseUrl(dashboardUrl) {
  const url = new URL(dashboardUrl);
  return `${url.protocol}//${url.host}`;
}

function dashboardToken(dashboardUrl) {
  return new URL(dashboardUrl).searchParams.get("token") || "";
}

async function readLiveDashboardMetadata(metadataPath) {
  const metadata = await readJsonFileIfExists(metadataPath);
  if (!metadata?.url) return null;
  const token = dashboardToken(metadata.url);
  if (!token) return null;
  await waitForDashboardServer(dashboardBaseUrl(metadata.url), token);
  return metadata;
}

async function runtimeFingerprint(runtimePath = SELF_PATH) {
  const bytes = await readFile(runtimePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function dashboardServerMetadataReusable(metadata, currentRuntime) {
  if (!metadata?.url) return false;
  if (!metadata.runtimePath || !metadata.runtimeFingerprint) return false;
  if (!currentRuntime?.runtimePath || !currentRuntime.runtimeFingerprint) return false;
  return path.resolve(metadata.runtimePath) === path.resolve(currentRuntime.runtimePath)
    && metadata.runtimeFingerprint === currentRuntime.runtimeFingerprint;
}

async function waitForDashboardMetadata(metadataPath, token) {
  const startedAt = Date.now();
  const encodedToken = encodeURIComponent(token);
  let lastError = null;

  while (Date.now() - startedAt < 5000) {
    const metadata = await readJsonFileIfExists(metadataPath);
    if (metadata?.url && metadata.url.includes(encodedToken)) {
      try {
        await waitForDashboardServer(dashboardBaseUrl(metadata.url), token);
        return metadata;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error("Dashboard server did not publish metadata");
}

export async function openProjectDashboard({
  projectRoot,
  globalConfigPath = GLOBAL_CONFIG_PATH,
} = {}) {
  const generated = await generateProjectDashboard({ projectRoot, globalConfigPath, open: false });
  const resolvedProjectRoot = path.resolve(projectRoot);
  const metadataPath = path.join(resolvedProjectRoot, DASHBOARD_SERVER_RELATIVE);
  const currentRuntime = {
    runtimePath: SELF_PATH,
    runtimeFingerprint: await runtimeFingerprint(SELF_PATH),
  };

  const existing = await readLiveDashboardMetadata(metadataPath).catch(() => null);
  if (dashboardServerMetadataReusable(existing, currentRuntime)) {
    await openDashboardUrl(existing.url);
    return {
      ...generated,
      opened: true,
      served: true,
      reused: true,
      url: existing.url,
      port: existing.port,
    };
  }

  const token = randomBytes(16).toString("hex");

  const child = spawn(process.execPath, [
    SELF_PATH,
    "dashboard-server",
    "--project-root",
    resolvedProjectRoot,
    "--port",
    "0",
    "--token",
    token,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const metadata = await waitForDashboardMetadata(metadataPath, token);
  await openDashboardUrl(metadata.url);
  return {
    ...generated,
    opened: true,
    served: true,
    url: metadata.url,
    port: metadata.port,
  };
}

async function runCodexReleaseAgent(projectRoot) {
  const { globalConfig, projectConfig, plan } = await configuredEngines(projectRoot);
  if (plan.length === 0) {
    throw new Error("No Unreal Engine versions are available after applying exclusions.");
  }

  const descriptor = await findUPlugin(projectRoot);
  const outputDirectory = resolveOutputDirectory(projectRoot, globalConfig, projectConfig, pluginNameFromDescriptor(descriptor));
  await mkdir(outputDirectory, { recursive: true });

  const args = buildCodexExecArgs({
    projectRoot,
    outputDirectory,
    engines: plan,
  });
  const prompt = makeReleasePrompt({
    projectRoot,
    outputDirectory,
    maxFixAttempts: globalConfig.maxFixAttemptsPerVersion || 3,
  });

  if (releaseAgentMode() === "current-session") {
    return await runCurrentSessionReleaseAgent({
      projectRoot,
      outputDirectory,
      globalConfig,
      projectConfig,
      plan,
      prompt,
    });
  }

  const codexExecutable = await resolveCodexExecutable();
  if (!codexExecutable) {
    throw new Error(codexCliUnavailableMessage());
  }
  const invocation = codexProcessInvocation(codexExecutable, args);

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    input: prompt,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });

  if (result.error?.code === "ENOENT" || result.error?.code === "EPERM") {
    throw new Error(codexCliUnavailableMessage(result.error));
  }
  if (result.error) throw result.error;
  return result.status || 0;
}

export function releaseAgentMode({ env = process.env } = {}) {
  const originator = String(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "");
  if (originator.toLowerCase().includes("codex desktop")) {
    return "current-session";
  }
  return "codex-exec";
}

function pluginNameFromDescriptor(descriptorPath) {
  return path.basename(descriptorPath, ".uplugin");
}

async function removeDirectoryIfExists(directory) {
  if (!(await exists(directory))) return;
  await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true, force: true }));
}

const GENERATED_PLUGIN_FOLDERS = new Set(["Binaries", "Build", "Intermediate", "Saved"]);

function shouldIncludeInReleaseZip(filePath) {
  const normalized = String(filePath || "");
  const segments = normalized.split(/[\\/]+/);
  if (segments.some((segment) => GENERATED_PLUGIN_FOLDERS.has(segment))) {
    return false;
  }

  return path.extname(normalized).toLowerCase() !== ".pdb";
}

export function validateFabPluginZipEntries({ pluginName, entries = [] } = {}) {
  const normalizedPluginName = String(pluginName || "").trim();
  const normalizedEntries = entries
    .map((entry) => String(entry || "").replaceAll("\\", "/").replace(/^\/+/, ""))
    .filter(Boolean);
  const issues = [];
  const roots = new Set(normalizedEntries.map((entry) => entry.split("/")[0]).filter(Boolean));

  if (roots.size !== 1 || !roots.has(normalizedPluginName)) {
    issues.push(`Zip must contain exactly one root folder named ${normalizedPluginName}.`);
  }

  if (!normalizedEntries.includes(`${normalizedPluginName}/${normalizedPluginName}.uplugin`)) {
    issues.push(`Zip must include ${normalizedPluginName}/${normalizedPluginName}.uplugin.`);
  }

  for (const entry of normalizedEntries) {
    const segments = entry.split("/");
    for (const segment of segments) {
      if (GENERATED_PLUGIN_FOLDERS.has(segment)) {
        issues.push(`Zip includes generated folder ${segment}: ${entry}`);
        break;
      }
    }
    if (path.posix.extname(entry).toLowerCase() === ".pdb") {
      issues.push(`Zip includes debug symbol file: ${entry}`);
    }
  }

  return issues;
}

async function collectRelativeFilePaths(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRelativeFilePaths(rootDir, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }
  return files;
}

async function assertFabReadyStaging({ stagingRoot, pluginName }) {
  const entries = await collectRelativeFilePaths(stagingRoot);
  const issues = validateFabPluginZipEntries({ pluginName, entries });
  if (issues.length > 0) {
    throw new Error([
      "Release zip staging failed Fab TRC validation.",
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n"));
  }
}

async function copyFilterPluginConfigForZip({ projectRoot, stagingDir }) {
  if (!projectRoot) return;

  const source = path.join(projectRoot, "Config", "FilterPlugin.ini");
  if (!(await exists(source))) return;

  await mkdir(path.join(stagingDir, "Config"), { recursive: true });
  await cp(source, path.join(stagingDir, "Config", "FilterPlugin.ini"));
}

async function restoreDescriptorPlatformListsForZip({ projectRoot, stagingDir, pluginName }) {
  if (!projectRoot || !pluginName) return;

  const sourceDescriptorPath = path.join(projectRoot, `${pluginName}.uplugin`);
  const stagedDescriptorPath = path.join(stagingDir, `${pluginName}.uplugin`);
  if (!(await exists(sourceDescriptorPath)) || !(await exists(stagedDescriptorPath))) return;

  const sourceDescriptor = JSON.parse(await readFile(sourceDescriptorPath, "utf8"));
  const stagedDescriptor = JSON.parse(await readFile(stagedDescriptorPath, "utf8"));
  const sourceModules = new Map((sourceDescriptor.Modules || []).map((module) => [module.Name, module]));
  let changed = false;

  for (const stagedModule of stagedDescriptor.Modules || []) {
    const sourceModule = sourceModules.get(stagedModule.Name);
    if (!sourceModule) continue;
    for (const key of ["PlatformAllowList", "PlatformDenyList"]) {
      if (sourceModule[key] && !stagedModule[key]) {
        stagedModule[key] = sourceModule[key];
        changed = true;
      }
    }
  }

  if (changed) {
    await writeFile(stagedDescriptorPath, `${JSON.stringify(stagedDescriptor, null, "\t")}\n`, "utf8");
  }
}

export async function copyReleasePackageForZip({ sourceDir, stagingDir, projectRoot, pluginName }) {
  await removeDirectoryIfExists(stagingDir);
  await mkdir(path.dirname(stagingDir), { recursive: true });
  await cp(sourceDir, stagingDir, {
    recursive: true,
    filter: (source) => shouldIncludeInReleaseZip(source),
  });
  await copyFilterPluginConfigForZip({ projectRoot, stagingDir });
  await restoreDescriptorPlatformListsForZip({ projectRoot, stagingDir, pluginName });
}

export function runUatProcessInvocation(runUatPath, args, { platform = process.platform } = {}) {
  if (platform !== "win32") {
    return { command: runUatPath, args };
  }

  const command = [
    "&",
    powerShellSingleQuoted(runUatPath),
    ...args.map((arg) => powerShellSingleQuoted(arg)),
  ].join(" ");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
  };
}

export function zipDirectoryProcessInvocation(sourceDir, zipPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$SourceDir = ${powerShellSingleQuoted(sourceDir)}`,
    `$ZipPath = ${powerShellSingleQuoted(zipPath)}`,
    "if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue",
    "[System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDir, $ZipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)",
  ].join("; ");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
  };
}

async function buildWithRunUat({ projectRoot, engine, projectConfig, globalConfig }) {
  const descriptor = await findUPlugin(projectRoot);
  const pluginName = pluginNameFromDescriptor(descriptor);
  const outputRoot = resolveOutputDirectory(projectRoot, globalConfig, projectConfig, pluginName);
  const packageDir = path.join(outputRoot, "packages", `${pluginName}-UE${engine.version}`);
  const zipStagingRoot = path.join(outputRoot, "zip-staging", `${pluginName}-UE${engine.version}`);
  const zipStagingPluginDir = path.join(zipStagingRoot, pluginName);
  const zipDir = path.join(outputRoot, "zips");
  const logPath = buildLogPath({ outputDirectory: outputRoot, pluginName, engineVersion: engine.version });
  const uatLogDirectory = buildUatLogDirectory({ outputDirectory: outputRoot, engineVersion: engine.version });
  const zipName = (globalConfig.zipNamePattern || DEFAULT_GLOBAL_CONFIG.zipNamePattern)
    .replaceAll("{pluginName}", pluginName)
    .replaceAll("{engineVersion}", engine.version);
  const zipPath = path.join(zipDir, zipName);

  await mkdir(path.dirname(packageDir), { recursive: true });
  await mkdir(zipDir, { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(uatLogDirectory, { recursive: true });
  await removeDirectoryIfExists(packageDir);
  await removeDirectoryIfExists(logPath);

  const buildArgs = [
    "BuildPlugin",
    `-Plugin=${descriptor}`,
    `-Package=${packageDir}`,
    "-Rocket",
  ];

  console.log(`[unreal-plugin-pipeline] Building ${pluginName} for UE ${engine.version}`);
  console.log(`[unreal-plugin-pipeline] ${engine.runUatPath} ${buildArgs.join(" ")}`);
  const invocation = runUatProcessInvocation(engine.runUatPath, buildArgs);
  const build = spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      uebp_LogFolder: uatLogDirectory,
      uebp_FinalLogFolder: uatLogDirectory,
    },
    maxBuffer: 100 * 1024 * 1024,
    shell: false,
  });
  const buildStdout = build.stdout || "";
  const buildStderr = build.stderr || "";
  if (buildStdout) process.stdout.write(buildStdout);
  if (buildStderr) process.stderr.write(buildStderr);
  await writeFile(logPath, `${buildStdout}${buildStderr}`, "utf8");

  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error(`RunUAT failed for UE ${engine.version} with exit code ${build.status}. Log: ${logPath}`);
  }

  await removeDirectoryIfExists(zipPath);
  await removeDirectoryIfExists(zipStagingRoot);
  await copyReleasePackageForZip({ sourceDir: packageDir, stagingDir: zipStagingPluginDir, projectRoot, pluginName });
  await assertFabReadyStaging({ stagingRoot: zipStagingRoot, pluginName });
  const zipInvocation = zipDirectoryProcessInvocation(zipStagingRoot, zipPath);
  const compress = spawnSync(zipInvocation.command, zipInvocation.args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
  });

  if (compress.error) throw compress.error;
  if (compress.status !== 0) {
    throw new Error(`Zip creation failed for UE ${engine.version} with exit code ${compress.status}`);
  }

  await removeDirectoryIfExists(zipStagingRoot);
  return { engineVersion: engine.version, packageDir, zipPath, logPath };
}

async function runBuildOnly(projectRoot, engineVersion = "") {
  const { globalConfig, projectConfig, plan } = await configuredEngines(projectRoot);
  const wantedVersion = normalizeVersion(engineVersion);
  const targets = wantedVersion ? plan.filter((engine) => engine.version === wantedVersion) : plan;
  if (targets.length === 0) {
    throw new Error(wantedVersion ? `No configured Unreal Engine found for ${wantedVersion}` : "No Unreal Engine versions are configured.");
  }

  const results = [];
  for (const engine of targets) {
    results.push(await buildWithRunUat({ projectRoot, engine, projectConfig, globalConfig }));
  }
  console.log(JSON.stringify({ builds: results }, null, 2));
}

function releaseReportText({
  projectRoot,
  outputDirectory,
  results = [],
  blockedVersion = "",
  blocker = null,
  mode = "current-session",
}) {
  const lines = [
    "# Unreal Plugin Pipeline Release Report",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Project root: ${projectRoot}`,
    `Output directory: ${outputDirectory}`,
    `Mode: ${mode}`,
    "",
    "## Build Results",
    "",
  ];

  if (results.length === 0) {
    lines.push("No engine versions completed successfully.", "");
  } else {
    lines.push("| Engine | Result | Zip |", "| --- | --- | --- |");
    for (const result of results) {
      lines.push(`| UE ${result.engineVersion} | Success | ${result.zipPath} |`);
    }
    lines.push("");
  }

  if (blocker) {
    lines.push(
      "## Current Blocker",
      "",
      `UE ${blockedVersion} failed and needs current-session AI repair before continuing.`,
      "",
      "```text",
      blocker.stack || blocker.message || String(blocker),
      "```",
      "",
    );
  } else {
    lines.push("## Current Blocker", "", "None.", "");
  }

  return `${lines.join("\n")}\n`;
}

async function writeReleaseReport(outputDirectory, payload) {
  const reportPath = releaseReportPath(outputDirectory);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, releaseReportText(payload), "utf8");
  return reportPath;
}

async function runCurrentSessionReleaseAgent({
  projectRoot,
  outputDirectory,
  globalConfig,
  projectConfig,
  plan,
  prompt,
}) {
  console.log("[unreal-plugin-pipeline] Codex Desktop detected; using current-session release loop.");
  console.log("[unreal-plugin-pipeline] The release-agent instructions for this thread are:");
  console.log(prompt);

  const results = [];
  for (const engine of plan) {
    try {
      results.push(await buildWithRunUat({ projectRoot, engine, projectConfig, globalConfig }));
    } catch (error) {
      const reportPath = await writeReleaseReport(outputDirectory, {
        projectRoot,
        outputDirectory,
        results,
        blockedVersion: engine.version,
        blocker: error,
      });
      throw new Error([
        `UE ${engine.version} failed during current-session release build.`,
        `Report: ${reportPath}`,
        "Inspect the generated logs, fix the plugin in this Codex thread, then rerun the same build command.",
        error.stack || error.message,
      ].filter(Boolean).join("\n"));
    }
  }

  const reportPath = await writeReleaseReport(outputDirectory, {
    projectRoot,
    outputDirectory,
    results,
  });
  console.log(JSON.stringify({ builds: results, reportPath }, null, 2));
  return 0;
}

function readOption(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function hasFlag(args, name) {
  return args.includes(name);
}

export function buildCommandOptions(args) {
  return {
    buildOnly: hasFlag(args, "--build-only"),
    engineVersion: readOption(args, "--engine-version", ""),
  };
}

async function updateGlobalConfig(mutator) {
  const config = await loadGlobalConfig();
  const next = mutator(config);
  await writeJson(GLOBAL_CONFIG_PATH, next);
  return next;
}

async function updateProjectConfig(projectRoot, mutator) {
  const configPath = path.join(projectRoot, PROJECT_CONFIG_RELATIVE);
  const config = await loadProjectConfig(projectRoot);
  const next = mutator(config);
  await writeJson(configPath, next);
  return next;
}

async function main(argv) {
  const [command = "help", ...args] = argv;
  const projectRoot = path.resolve(readOption(args, "--project-root", process.cwd()));

  if (command === "setup") {
    const descriptor = await findUPlugin(projectRoot);
    const result = await writeProjectBootstrap({
      projectRoot,
      runtimeSourcePath: readOption(args, "--runtime-source", SELF_PATH),
      outputDirectory: readOption(args, "--output", ""),
      projectName: pluginNameFromDescriptor(descriptor),
      wireRunActions: hasFlag(args, "--wire-run-actions"),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "install") {
    const descriptor = await findUPlugin(projectRoot);
    const result = await installProjectRunActions({
      projectRoot,
      runtimeSourcePath: readOption(args, "--runtime-source", SELF_PATH),
      outputDirectory: readOption(args, "--output", ""),
      projectName: pluginNameFromDescriptor(descriptor),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "setup-all") {
    const root = path.resolve(readOption(args, "--root", projectRoot));
    const roots = await discoverUPluginProjectRoots(root);
    const results = [];
    for (const pluginRoot of roots) {
      const descriptor = await findUPlugin(pluginRoot);
      results.push(await writeProjectBootstrap({
        projectRoot: pluginRoot,
        runtimeSourcePath: readOption(args, "--runtime-source", SELF_PATH),
        outputDirectory: readOption(args, "--output", ""),
        projectName: pluginNameFromDescriptor(descriptor),
        wireRunActions: hasFlag(args, "--wire-run-actions"),
      }));
    }
    console.log(JSON.stringify({ count: results.length, projectRoots: roots, results }, null, 2));
    return 0;
  }

  if (command === "cleanup-run-actions" || command === "uninstall") {
    const descriptor = await findUPlugin(projectRoot);
    const result = await removeProjectRunActions({
      projectRoot,
      projectName: pluginNameFromDescriptor(descriptor),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "build") {
    const buildOptions = buildCommandOptions(args);
    if (buildOptions.buildOnly) {
      await runBuildOnly(projectRoot, buildOptions.engineVersion);
      return 0;
    }
    return await runCodexReleaseAgent(projectRoot);
  }

  if (command === "build-only") {
    await runBuildOnly(projectRoot, readOption(args, "--engine-version", ""));
    return 0;
  }

  if (command === "detect-engines") {
    const { engines, plan } = await configuredEngines(projectRoot);
    console.log(JSON.stringify({ engines, buildPlan: plan }, null, 2));
    return 0;
  }

  if (command === "dashboard") {
    const result = hasFlag(args, "--no-open")
      ? await generateProjectDashboard({ projectRoot, open: false })
      : await openProjectDashboard({ projectRoot });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "dashboard-server") {
    const token = readOption(args, "--token", "");
    const port = Number.parseInt(readOption(args, "--port", "0"), 10) || 0;
    const session = await startDashboardServer({ projectRoot, port, token });
    console.error(`[unreal-plugin-pipeline] Dashboard server: ${session.url}`);
    await new Promise((resolve) => session.server.once("close", resolve));
    return 0;
  }

  if (command === "show-config") {
    const globalConfig = await loadGlobalConfig();
    const projectConfig = await loadProjectConfig(projectRoot);
    console.log(JSON.stringify({
      globalConfigPath: GLOBAL_CONFIG_PATH,
      projectConfigPath: path.join(projectRoot, PROJECT_CONFIG_RELATIVE),
      globalConfig,
      projectConfig,
    }, null, 2));
    return 0;
  }

  if (command === "set-output") {
    const outputDirectory = readOption(args, "--output");
    if (!outputDirectory) throw new Error("set-output requires --output <directory>");
    const next = await updateGlobalConfig((config) => ({ ...config, outputDirectory: path.resolve(outputDirectory) }));
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }

  if (command === "add-scan-root") {
    const root = readOption(args, "--root");
    if (!root) throw new Error("add-scan-root requires --root <directory>");
    const next = await updateGlobalConfig((config) => ({
      ...config,
      engineScanRoots: uniq([...(config.engineScanRoots || []), path.resolve(root)]),
    }));
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }

  if (command === "add-engine-root") {
    const root = readOption(args, "--root");
    if (!root) throw new Error("add-engine-root requires --root <directory>");
    const next = await updateGlobalConfig((config) => ({
      ...config,
      engineRoots: uniq([...(config.engineRoots || []), path.resolve(root)]),
    }));
    console.log(JSON.stringify(next, null, 2));
    return 0;
  }

  if (command === "exclude-version" || command === "include-version") {
    const version = readOption(args, "--version");
    if (!version) throw new Error(`${command} requires --version <version>`);
    const shouldExclude = command === "exclude-version";
    if (hasFlag(args, "--global")) {
      const next = await updateGlobalConfig((config) => withVersionExclusion(config, version, shouldExclude));
      console.log(JSON.stringify(next, null, 2));
    } else {
      const next = await updateProjectConfig(projectRoot, (config) => withVersionExclusion(config, version, shouldExclude));
      console.log(JSON.stringify(next, null, 2));
    }
    return 0;
  }

  console.log(`usage: node ${path.relative(process.cwd(), path.join(HERE, "unreal-plugin-pipeline.mjs"))} <command>

Commands:
  install --project-root <dir> [--output <dir>]
  uninstall --project-root <dir>
  setup --project-root <dir> [--output <dir>] [--wire-run-actions]
  setup-all --root <dir> [--output <dir>] [--wire-run-actions]
  cleanup-run-actions --project-root <dir>
  build --project-root <dir> [--build-only] [--engine-version <version>]
  build-only --project-root <dir> [--engine-version <version>]
  detect-engines --project-root <dir>
  dashboard --project-root <dir> [--no-open]
  dashboard-server --project-root <dir> --port <port> --token <token>
  show-config --project-root <dir>
  set-output --output <dir>
  add-scan-root --root <dir>
  add-engine-root --root <dir>
  exclude-version --project-root <dir> --version <version> [--global]
  include-version --project-root <dir> --version <version> [--global]`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[unreal-plugin-pipeline] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
