param(
  [Parameter(Position = 0)]
  [string]$PipelineCommand = "help",

  [string]$ProjectRoot = ".",

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeScript = Join-Path $ScriptDir "unreal-plugin-pipeline.mjs"

if (-not (Test-Path -LiteralPath $NodeScript -PathType Leaf)) {
  throw "Unreal Plugin Pipeline runtime script is missing: $NodeScript"
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

$lastError = $null
foreach ($candidate in $candidates) {
  try {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      & $candidate $NodeScript $PipelineCommand --project-root $ProjectRoot @Rest
      exit $LASTEXITCODE
    }
  } catch {
    $lastError = $_
  }
}

$detail = if ($lastError) { " Last error: $lastError" } else { "" }
throw "Node.js was not found or is not accessible. Set UPP_NODE_EXE to a readable node.exe path, or install Node.js so the Unreal Plugin Pipeline can run.$detail"
