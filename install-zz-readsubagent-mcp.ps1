# zz readsubagent MCP server - harness-neutral repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-zz-readsubagent-mcp.ps1 | iex
#
# Drops the single stdio MCP server file at .\.zz-mcp\zz-readsubagent-mcp.py and
# prints how to register it in any MCP-capable harness. The server spawns a
# headless `pi` child on a local Qwen model (via LM Studio) to do read planning.
#
# For a ready-made Claude Code subagent wrapper, use install-claude-readsubagent.ps1.

$ErrorActionPreference = 'Stop'

function Test-Truthy($value) {
  if ($null -eq $value) { return $false }
  return @('1', 'true', 'yes', 'on') -contains ([string]$value).Trim().ToLowerInvariant()
}

function Show-Usage {
  @'
install-zz-readsubagent-mcp.ps1 [options]

Options:
  --project-dir DIR   Target repo/project dir (default: current directory).
  --model SELECTOR    Model selector for the printed registration snippet
                      (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --force             Claim/overwrite an existing unowned server file.
  --dry-run           Show the install plan without writing files.
  -h, --help          Show this help.

Environment:
  ZZ_DASH_URL                       Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_READSUBAGENT_MCP_URL           Exact source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_READSUBAGENT_MCP_PROJECT_DIR   Target repo/project dir
  ZZ_READSUBAGENT_MCP_MODEL         Model selector for the snippet
  ZZ_READSUBAGENT_MCP_FORCE=1
  ZZ_READSUBAGENT_MCP_DRY_RUN=1
  ZZ_READSUBAGENT_MCP_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available.
'@
}

$defaultHost = 'https://raw.githubusercontent.com/dezverev/zzPi/main'
$hostBase = if ($env:ZZ_DASH_URL) { $env:ZZ_DASH_URL.TrimEnd('/') } else { $defaultHost }
$sourceBase = if ($env:ZZ_READSUBAGENT_MCP_URL) { $env:ZZ_READSUBAGENT_MCP_URL.TrimEnd('/') } else { "$hostBase/zz-readsubagent-mcp" }
$projectDir = if ($env:ZZ_READSUBAGENT_MCP_PROJECT_DIR) { $env:ZZ_READSUBAGENT_MCP_PROJECT_DIR } else { (Get-Location).Path }
$model = if ($env:ZZ_READSUBAGENT_MCP_MODEL) { $env:ZZ_READSUBAGENT_MCP_MODEL } else { 'lm-studio/qwen/qwen3.6-35b-a3b' }
$force = Test-Truthy $env:ZZ_READSUBAGENT_MCP_FORCE
$dryRun = Test-Truthy $env:ZZ_READSUBAGENT_MCP_DRY_RUN

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^--project-dir$' { if ($i + 1 -ge $args.Count) { throw '--project-dir needs a value' }; $i++; $projectDir = $args[$i]; continue }
    '^--project-dir=' { $projectDir = $args[$i].Substring('--project-dir='.Length); continue }
    '^--model$' { if ($i + 1 -ge $args.Count) { throw '--model needs a value' }; $i++; $model = $args[$i]; continue }
    '^--model=' { $model = $args[$i].Substring('--model='.Length); continue }
    '^--force$' { $force = $true; continue }
    '^--dry-run$' { $dryRun = $true; continue }
    '^(-h|--help)$' { Show-Usage; exit 0 }
    default { throw "unknown option: $($args[$i])" }
  }
}

$projectDir = [System.IO.Path]::GetFullPath($projectDir)

if (-not (Test-Truthy $env:ZZ_READSUBAGENT_MCP_ALLOW_SUBDIR)) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $inside = & git -C $projectDir rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and "$inside".Trim() -eq 'true') {
      $gitRoot = (& git -C $projectDir rev-parse --show-toplevel).Trim()
      $gitRoot = [System.IO.Path]::GetFullPath($gitRoot)
      if ($projectDir.TrimEnd('\') -ne $gitRoot.TrimEnd('\')) {
        throw "Refusing to install into a git subdirectory: current=$projectDir repo root=$gitRoot. Run from the repo root or set ZZ_READSUBAGENT_MCP_PROJECT_DIR."
      }
    }
  }
}

$piWarning = ''
if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
  $piWarning = "WARNING: 'pi' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zz-readsubagent-mcp-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  $serverTmp = Join-Path $tmpDir 'zz-readsubagent-mcp.py'
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp

  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $manifestPath = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp-manifest.json'

  function Get-ManifestOwns([string]$rel) {
    if (-not (Test-Path $manifestPath)) { return $false }
    try {
      $state = Get-Content $manifestPath -Raw | ConvertFrom-Json
      return @($state.owned_files) -contains $rel
    } catch { return $false }
  }
  function Get-FileSha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant() }

  if ((Test-Path $serverTarget) -and -not (Get-ManifestOwns $relServer) -and -not $force) {
    if ((Get-FileSha256 $serverTarget) -ne (Get-FileSha256 $serverTmp)) {
      throw "Refusing to overwrite existing unowned $relServer. Use --force to claim it."
    }
    $action = "unchanged existing matching $relServer"
  } elseif ($dryRun) {
    $verb = if (Test-Path $serverTarget) { 'update' } else { 'create' }
    $action = "would $verb $relServer"
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $serverTarget -Parent) | Out-Null
    Copy-Item -Force -Path $serverTmp -Destination $serverTarget
    $action = "installed $relServer"
  }

  if (-not $dryRun) {
    $state = [ordered]@{
      installer     = 'zz-readsubagent-mcp'
      schemaVersion = 1
      source_url    = $sourceBase
      owned_files   = @($relServer)
      file_hashes   = [ordered]@{ $relServer = Get-FileSha256 $serverTarget }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath -Parent) | Out-Null
    [System.IO.File]::WriteAllText($manifestPath, ($state | ConvertTo-Json -Depth 10) + "`n")
  }

  Write-Host ''
  if ($dryRun) { Write-Host '  zz readsubagent MCP server install plan' -ForegroundColor Cyan }
  else { Write-Host '  zz readsubagent MCP server installed' -ForegroundColor Green }
  Write-Host "  -> $action"
  Write-Host "  -> target repo: $projectDir"
  Write-Host "  -> source: $sourceBase"
  Write-Host ''
  Write-Host '  Register this stdio MCP server in your harness (server name: zz_readsubagent,'
  Write-Host '  tool: mcp__zz_readsubagent__readsubagent). Generic config:'
  Write-Host ''
  Write-Host '    command: python3'
  Write-Host "    args:    [`"$relServer`"]   # relative to the repo root (the server's launch cwd)"
  Write-Host "    env:     { `"ZZ_READSUBAGENT_MODEL`": `"$model`" }"
  Write-Host ''
  Write-Host '  Claude Code:'
  Write-Host "    claude mcp add --scope project --transport stdio --env ZZ_READSUBAGENT_MODEL=$model -- zz_readsubagent python3 ./$relServer"
  if ($piWarning) { Write-Host "  -> $piWarning" -ForegroundColor Yellow }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
