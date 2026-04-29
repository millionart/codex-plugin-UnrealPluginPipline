param(
  [string]$ProjectRoot = ".",
  [string]$PluginName = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

function Get-FullPath([string]$Value) {
  $Value = Convert-FromExtendedPath $Value
  return [System.IO.Path]::GetFullPath($Value).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Convert-FromExtendedPath([string]$Value) {
  if ($Value.StartsWith("\\?\UNC\")) {
    return "\\" + $Value.Substring(8)
  }
  if ($Value.StartsWith("\\?\")) {
    return $Value.Substring(4)
  }

  return $Value
}

function Resolve-FileSystemPath([string]$Value) {
  $resolved = Resolve-Path -LiteralPath $Value
  if ($resolved.ProviderPath) {
    return Convert-FromExtendedPath $resolved.ProviderPath
  }

  return Convert-FromExtendedPath $resolved.Path
}

function Test-SamePath([string]$Left, [string]$Right) {
  return [string]::Equals((Get-FullPath $Left), (Get-FullPath $Right), [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-WorkspaceRoot([string]$StartDirectory) {
  $startPath = Resolve-FileSystemPath $StartDirectory
  $directory = [System.IO.DirectoryInfo]::new($startPath)
  while ($null -ne $directory) {
    if (Test-Path -LiteralPath (Join-Path $directory.FullName ".git")) {
      return $directory.FullName
    }
    $directory = $directory.Parent
  }

  return $startPath
}

function Get-FileSnapshot([string]$Path) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    return @{
      Exists = $true
      Bytes = [System.IO.File]::ReadAllBytes($Path)
    }
  }

  return @{
    Exists = $false
    Bytes = $null
  }
}

function Test-FileSnapshot([string]$Path, $Snapshot) {
  $exists = Test-Path -LiteralPath $Path -PathType Leaf
  if (-not $Snapshot.Exists) {
    return -not $exists
  }

  if (-not $exists) {
    return $false
  }

  $currentBytes = [System.IO.File]::ReadAllBytes($Path)
  if ($currentBytes.Length -ne $Snapshot.Bytes.Length) {
    return $false
  }

  for ($index = 0; $index -lt $currentBytes.Length; $index += 1) {
    if ($currentBytes[$index] -ne $Snapshot.Bytes[$index]) {
      return $false
    }
  }

  return $true
}

function Restore-FileSnapshot([string]$Path, $Snapshot) {
  if ($Snapshot.Exists) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    [System.IO.File]::WriteAllBytes($Path, $Snapshot.Bytes)
    return
  }

  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Get-DirectPluginDescriptors([string]$Root) {
  return @(Get-ChildItem -LiteralPath $Root -Filter "*.uplugin" -File)
}

function Get-ChildPluginCandidates([string]$Root) {
  $skipNames = @(".git", ".codex", "Binaries", "Intermediate", "Saved")
  $candidates = @()
  foreach ($entry in @(Get-ChildItem -LiteralPath $Root -Directory)) {
    if ($skipNames -contains $entry.Name -or $entry.Name.StartsWith("_Build")) {
      continue
    }

    $descriptors = Get-DirectPluginDescriptors $entry.FullName
    foreach ($descriptor in $descriptors) {
      $candidates += [pscustomobject]@{
        Name = [System.IO.Path]::GetFileNameWithoutExtension($descriptor.Name)
        Root = $entry.FullName
        Descriptor = $descriptor.FullName
      }
    }
  }

  return @($candidates | Sort-Object Name, Root)
}

function Format-Candidates($Candidates) {
  return ($Candidates | ForEach-Object { "  - $($_.Name): $($_.Root)" }) -join [Environment]::NewLine
}

function Add-NodeCandidate([System.Collections.Generic.List[string]]$Candidates, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return
  }

  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if (-not $Candidates.Contains($expanded)) {
    $Candidates.Add($expanded) | Out-Null
  }
}

function Resolve-NodeExecutable() {
  $candidates = [System.Collections.Generic.List[string]]::new()
  Add-NodeCandidate $candidates $env:UPP_NODE_EXE

  try {
    foreach ($command in @(Get-Command node -All -ErrorAction Stop)) {
      Add-NodeCandidate $candidates $command.Source
    }
  } catch {
  }

  Add-NodeCandidate $candidates (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  Add-NodeCandidate $candidates (Join-Path $env:ProgramFiles "nodejs\node.exe")
  Add-NodeCandidate $candidates (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe")

  foreach ($candidate in $candidates) {
    try {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
      }
    } catch {
    }
  }

  throw "Node.js was not found or is not accessible. Set UPP_NODE_EXE to a readable node.exe path, or install Node.js so the Unreal Plugin Pipeline installer can run."
}

$resolvedProjectRoot = Resolve-FileSystemPath $ProjectRoot
$descriptors = Get-DirectPluginDescriptors $resolvedProjectRoot
if (-not [string]::IsNullOrWhiteSpace($PluginName) -and $descriptors.Count -gt 0) {
  $descriptors = @($descriptors | Where-Object {
    [string]::Equals([System.IO.Path]::GetFileNameWithoutExtension($_.Name), $PluginName, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($descriptors.Count -eq 0) {
    throw "Project root does not contain the requested plugin '$PluginName': $resolvedProjectRoot"
  }
}

if ($descriptors.Count -eq 0) {
  $childCandidates = Get-ChildPluginCandidates $resolvedProjectRoot
  if (-not [string]::IsNullOrWhiteSpace($PluginName)) {
    $matchingChildren = @($childCandidates | Where-Object {
      [string]::Equals($_.Name, $PluginName, [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($matchingChildren.Count -eq 1) {
      $resolvedProjectRoot = $matchingChildren[0].Root
      $descriptors = Get-DirectPluginDescriptors $resolvedProjectRoot
    } elseif ($matchingChildren.Count -gt 1) {
      throw "Multiple child plugin projects match '$PluginName'. Pass a specific -ProjectRoot.`n$(Format-Candidates $matchingChildren)"
    }
  }

  if ($descriptors.Count -eq 0) {
    if ($childCandidates.Count -gt 0) {
      throw "No .uplugin descriptor found directly under project root: $resolvedProjectRoot. Multiple child plugin projects exist; pass a specific -ProjectRoot or -PluginName.`n$(Format-Candidates $childCandidates)"
    }

    throw "No .uplugin descriptor found directly under project root: $resolvedProjectRoot"
  }
}
if ($descriptors.Count -gt 1) {
  throw "Multiple .uplugin descriptors found directly under project root: $resolvedProjectRoot"
}

$nodeScript = Join-Path $PSScriptRoot "unreal-plugin-pipeline.mjs"
if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
  throw "Unreal Plugin Pipeline runtime script is missing: $nodeScript"
}

$workspaceRoot = Find-WorkspaceRoot $resolvedProjectRoot
$workspaceEnvironmentPath = Join-Path $workspaceRoot ".codex\environments\environment.toml"
$projectEnvironmentPath = Join-Path $resolvedProjectRoot ".codex\environments\environment.toml"
$guardWorkspaceEnvironment = -not (Test-SamePath $workspaceEnvironmentPath $projectEnvironmentPath)
$workspaceEnvironmentSnapshot = if ($guardWorkspaceEnvironment) {
  Get-FileSnapshot $workspaceEnvironmentPath
} else {
  $null
}

$nodeExe = Resolve-NodeExecutable
$nodeArgs = @($nodeScript, "install", "--project-root", $resolvedProjectRoot)
if (-not [string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $nodeArgs += @("--output", $OutputDirectory)
}

$installOutput = $null
$installError = $null
$installExitCode = 0
try {
  $installOutput = & $nodeExe @nodeArgs 2>&1
  $installExitCode = $LASTEXITCODE
} catch {
  $installError = $_
  $installExitCode = 1
}

if ($guardWorkspaceEnvironment -and -not (Test-FileSnapshot $workspaceEnvironmentPath $workspaceEnvironmentSnapshot)) {
  Restore-FileSnapshot $workspaceEnvironmentPath $workspaceEnvironmentSnapshot
  throw "Install attempted to modify the workspace-level Run environment and was rolled back: $workspaceEnvironmentPath"
}

$installText = ($installOutput | Out-String).Trim()
if ($installError) {
  throw "Failed to launch Unreal Plugin Pipeline installer: $installError"
}
if ($installExitCode -ne 0) {
  throw "Unreal Plugin Pipeline installer failed with exit code $installExitCode.`n$installText"
}

try {
  $result = $installText | ConvertFrom-Json
} catch {
  throw "Unreal Plugin Pipeline installer did not return valid JSON.`n$installText"
}

if (-not (Test-Path -LiteralPath $projectEnvironmentPath -PathType Leaf)) {
  throw "Install completed but project-local Run environment was not created: $projectEnvironmentPath"
}
if (-not (Test-SamePath $result.environmentPath $projectEnvironmentPath)) {
  throw "Install returned an unexpected environmentPath. Expected '$projectEnvironmentPath', got '$($result.environmentPath)'."
}
if (-not (Test-SamePath $result.localEnvironmentPath $projectEnvironmentPath)) {
  throw "Install returned an unexpected localEnvironmentPath. Expected '$projectEnvironmentPath', got '$($result.localEnvironmentPath)'."
}

$result | ConvertTo-Json -Depth 8
