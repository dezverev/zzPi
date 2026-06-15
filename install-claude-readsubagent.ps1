# zz Claude readsubagent - repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-claude-readsubagent.ps1 | iex
#
# Thin Claude Code wrapper around the harness-neutral zz-readsubagent-mcp server.
# Installs the MCP server at .\.zz-mcp\zz-readsubagent-mcp.py, registers the
# zz_readsubagent server in .\.mcp.json, writes .\.claude\agents\readsubagent.md
# (restricted to that one MCP tool), and adds repo CLAUDE.md guidance. The MCP
# server spawns a headless `pi` child on a local Qwen model (via LM Studio).

$ErrorActionPreference = 'Stop'

function Test-Truthy($value) {
  if ($null -eq $value) { return $false }
  return @('1', 'true', 'yes', 'on') -contains ([string]$value).Trim().ToLowerInvariant()
}

function Show-Usage {
  @'
install-claude-readsubagent.ps1 [options]

Options:
  --project-dir DIR       Target repo/project dir (default: current directory).
  --model SELECTOR        pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME           pi executable name/path for the MCP server (default: pi).
  --skip-mcp              Do not add/update the zz_readsubagent server in .mcp.json.
  --skip-claude-md        Do not add/update the repo CLAUDE.md guidance block.
  --force                 Claim/overwrite existing unowned readsubagent files.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                          Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CLAUDE_READSUBAGENT_URL           Subagent source URL (default: $ZZ_DASH_URL/claude-readsubagent)
  ZZ_READSUBAGENT_MCP_URL              MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CLAUDE_READSUBAGENT_MODEL         pi model selector
  ZZ_CLAUDE_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_CLAUDE_READSUBAGENT_SKIP_MCP=1
  ZZ_CLAUDE_READSUBAGENT_SKIP_CLAUDE_MD=1
  ZZ_CLAUDE_READSUBAGENT_FORCE=1
  ZZ_CLAUDE_READSUBAGENT_DRY_RUN=1
  ZZ_CLAUDE_READSUBAGENT_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves, and LM Studio reachable.
'@
}

$defaultHost = 'https://raw.githubusercontent.com/dezverev/zzPi/main'
$hostBase = if ($env:ZZ_DASH_URL) { $env:ZZ_DASH_URL.TrimEnd('/') } else { $defaultHost }
$agentSourceBase = if ($env:ZZ_CLAUDE_READSUBAGENT_URL) { $env:ZZ_CLAUDE_READSUBAGENT_URL.TrimEnd('/') } else { "$hostBase/claude-readsubagent" }
$mcpSourceBase = if ($env:ZZ_READSUBAGENT_MCP_URL) { $env:ZZ_READSUBAGENT_MCP_URL.TrimEnd('/') } else { "$hostBase/zz-readsubagent-mcp" }
$projectDir = if ($env:ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR) { $env:ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR } else { (Get-Location).Path }
$model = if ($env:ZZ_CLAUDE_READSUBAGENT_MODEL) { $env:ZZ_CLAUDE_READSUBAGENT_MODEL } else { 'lm-studio/qwen/qwen3.6-35b-a3b' }
$piBin = if ($env:ZZ_CLAUDE_READSUBAGENT_PI_BIN) { $env:ZZ_CLAUDE_READSUBAGENT_PI_BIN } else { 'pi' }
$skipMcp = Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_SKIP_MCP
$skipClaudeMd = Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_SKIP_CLAUDE_MD
$force = Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_FORCE
$dryRun = Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_DRY_RUN

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^--project-dir$' { if ($i + 1 -ge $args.Count) { throw '--project-dir needs a value' }; $i++; $projectDir = $args[$i]; continue }
    '^--project-dir=' { $projectDir = $args[$i].Substring('--project-dir='.Length); continue }
    '^--model$' { if ($i + 1 -ge $args.Count) { throw '--model needs a value' }; $i++; $model = $args[$i]; continue }
    '^--model=' { $model = $args[$i].Substring('--model='.Length); continue }
    '^--pi-bin$' { if ($i + 1 -ge $args.Count) { throw '--pi-bin needs a value' }; $i++; $piBin = $args[$i]; continue }
    '^--pi-bin=' { $piBin = $args[$i].Substring('--pi-bin='.Length); continue }
    '^--skip-mcp$' { $skipMcp = $true; continue }
    '^--skip-claude-md$' { $skipClaudeMd = $true; continue }
    '^--force$' { $force = $true; continue }
    '^--dry-run$' { $dryRun = $true; continue }
    '^(-h|--help)$' { Show-Usage; exit 0 }
    default { throw "unknown option: $($args[$i])" }
  }
}

$projectDir = [System.IO.Path]::GetFullPath($projectDir)

if (-not (Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_ALLOW_SUBDIR)) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $inside = & git -C $projectDir rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and "$inside".Trim() -eq 'true') {
      $gitRoot = (& git -C $projectDir rev-parse --show-toplevel).Trim()
      $gitRoot = [System.IO.Path]::GetFullPath($gitRoot)
      if ($projectDir.TrimEnd('\') -ne $gitRoot.TrimEnd('\')) {
        throw "Refusing to install into a git subdirectory: current=$projectDir repo root=$gitRoot. Run from the repo root or set ZZ_CLAUDE_READSUBAGENT_PROJECT_DIR."
      }
    }
  }
}

$piWarning = ''
if (-not (Get-Command $piBin -ErrorAction SilentlyContinue)) {
  $piWarning = "WARNING: '$piBin' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zz-claude-readsubagent-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  $agentTmp = Join-Path $tmpDir 'readsubagent.md'
  $serverTmp = Join-Path $tmpDir 'zz-readsubagent-mcp.py'
  Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/readsubagent.md" -OutFile $agentTmp
  Invoke-WebRequest -UseBasicParsing -Uri "$mcpSourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp

  $serverName = 'zz_readsubagent'
  $serverArgsPath = '.zz-mcp/zz-readsubagent-mcp.py'
  $relAgent = '.claude/agents/readsubagent.md'
  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $agentTarget = Join-Path $projectDir '.claude\agents\readsubagent.md'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $mcpJson = Join-Path $projectDir '.mcp.json'
  $claudeMd = Join-Path $projectDir 'CLAUDE.md'
  $manifestPath = Join-Path $projectDir '.claude\zz-claude-readsubagent-manifest.json'

  $markerStart = '<!-- zz-claude-readsubagent:start -->'
  $markerEnd = '<!-- zz-claude-readsubagent:end -->'
  $claudeBlock = @'
<!-- zz-claude-readsubagent:start -->
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through the `readsubagent` subagent, which delegates to a
local model via the `mcp__zz_readsubagent__readsubagent` MCP tool.

Use `readsubagent` to get:

- A short map of the relevant subsystem.
- Candidate files and directories, with reasons.
- The smallest focused read list for the main agent.
- Search terms, symbols, or line anchors that should guide the focused reads.
- Files or areas that look related but should be avoided for now.
- Uncertainty or follow-up questions that could change the read plan.

The local model can be slow. Allow a long wait for `readsubagent`; prefer
waiting over assuming it stalled.

The main agent should then read only the recommended files or sections first.
Expand beyond that list only when the focused reads reveal a concrete reason.

Use `readsubagent` only for factual read planning and file inspection. Do not
ask it to create implementation plans, choose edit strategies, review code,
find bugs, judge correctness, or validate type/control-flow safety. For those
tasks, do direct focused reads in the main thread or use a review-focused agent
when one is available.

Exceptions:

- The user names exact files or asks for an immediate direct read.
- The task is a trivial single-file edit or question.
- The needed context is already in the current thread.
- A tool or environment limitation prevents using the subagent.

When an exception applies, mention it briefly and continue with the smallest
reasonable focused read.
<!-- zz-claude-readsubagent:end -->
'@

  function Get-ManifestOwns([string]$rel) {
    if (-not (Test-Path $manifestPath)) { return $false }
    try {
      $state = Get-Content $manifestPath -Raw | ConvertFrom-Json
      return @($state.owned_files) -contains $rel
    } catch { return $false }
  }

  function Get-ManagedServer([string]$name) {
    if (-not (Test-Path $manifestPath)) { return $false }
    try {
      $state = Get-Content $manifestPath -Raw | ConvertFrom-Json
      return @($state.managed_servers) -contains $name
    } catch { return $false }
  }

  function Get-FileSha256([string]$path) {
    return (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
  }

  function Set-MarkedBlock([string]$text, [string]$start, [string]$end, [string]$block) {
    $pattern = '(?s)' + [regex]::Escape($start) + '.*?' + [regex]::Escape($end)
    if ([regex]::IsMatch($text, $pattern)) {
      return [regex]::Replace($text, $pattern, $block.TrimEnd())
    }
    $prefix = $text.TrimEnd()
    if ($prefix.Length -gt 0) { return "$prefix`n`n$($block.TrimEnd())" }
    return $block.TrimEnd()
  }

  function Install-OwnedFile([string]$rel, [string]$target, [string]$tmp) {
    if ((Test-Path $target) -and -not (Get-ManifestOwns $rel) -and -not $force) {
      $same = (Get-FileSha256 $target) -eq (Get-FileSha256 $tmp)
      if (-not $same) {
        throw "Refusing to overwrite existing unowned $rel. Use --force if you want this installer to claim it."
      }
      return "unchanged existing matching $rel"
    }
    if ($dryRun) {
      $verb = if (Test-Path $target) { 'update' } else { 'create' }
      return "would $verb $rel"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -Force -Path $tmp -Destination $target
    return "installed $rel"
  }

  $actions = New-Object System.Collections.Generic.List[string]
  $actions.Add((Install-OwnedFile $relAgent $agentTarget $agentTmp))
  $actions.Add((Install-OwnedFile $relServer $serverTarget $serverTmp))

  if ($skipMcp) {
    $actions.Add('skipped .mcp.json registration')
  } else {
    $data = $null
    if (Test-Path $mcpJson) {
      try { $data = Get-Content $mcpJson -Raw | ConvertFrom-Json } catch { throw "Refusing to edit malformed .mcp.json: $_" }
    }
    if ($null -eq $data) { $data = [pscustomobject]@{} }
    if (-not ($data.PSObject.Properties.Name -contains 'mcpServers') -or $null -eq $data.mcpServers) {
      $data | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $existing = $data.mcpServers.PSObject.Properties.Name -contains $serverName
    $managed = Get-ManagedServer $serverName
    if ($existing -and -not $managed -and -not $force) {
      $actions.Add("preserved existing unmanaged $serverName server in .mcp.json")
    } elseif ($dryRun) {
      $verb = if ($existing) { 'update' } else { 'add' }
      $actions.Add("would $verb $serverName server in .mcp.json")
    } else {
      $envBlock = [ordered]@{ ZZ_READSUBAGENT_MODEL = $model }
      if ($piBin -ne 'pi') { $envBlock['ZZ_READSUBAGENT_PI_BIN'] = $piBin }
      $entry = [ordered]@{
        type    = 'stdio'
        command = 'python3'
        args    = @($serverArgsPath)
        env     = $envBlock
      }
      $data.mcpServers | Add-Member -NotePropertyName $serverName -NotePropertyValue $entry -Force
      [System.IO.File]::WriteAllText($mcpJson, ($data | ConvertTo-Json -Depth 10) + "`n")
      $actions.Add("registered $serverName server in .mcp.json")
    }
  }

  if ($skipClaudeMd) {
    $actions.Add('skipped CLAUDE.md guidance')
  } elseif ($dryRun) {
    $actions.Add('would add/update CLAUDE.md read-planning block')
  } else {
    $existingMd = if (Test-Path $claudeMd) { Get-Content $claudeMd -Raw } else { "# Project Guidance`n" }
    $updatedMd = Set-MarkedBlock $existingMd $markerStart $markerEnd $claudeBlock
    [System.IO.File]::WriteAllText($claudeMd, $updatedMd.TrimEnd() + "`n")
    $actions.Add('added/updated CLAUDE.md read-planning block')
  }

  if (-not $dryRun) {
    $managedBlocks = @()
    if (-not $skipClaudeMd) { $managedBlocks += 'CLAUDE.md:zz-claude-readsubagent' }
    $managedServers = @()
    if (-not $skipMcp) { $managedServers += $serverName }
    $state = [ordered]@{
      installer       = 'zz-claude-readsubagent'
      schemaVersion   = 1
      source_url      = $agentSourceBase
      owned_files     = @($relAgent, $relServer)
      managed_blocks  = $managedBlocks
      managed_servers = $managedServers
      file_hashes     = [ordered]@{ $relAgent = Get-FileSha256 $agentTarget; $relServer = Get-FileSha256 $serverTarget }
      server          = [ordered]@{
        name        = $serverName
        model       = $model
        pi_bin      = $piBin
        config_path = $mcpJson
        managed     = -not $skipMcp
      }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath -Parent) | Out-Null
    [System.IO.File]::WriteAllText($manifestPath, ($state | ConvertTo-Json -Depth 10) + "`n")
  }

  Write-Host ''
  if ($dryRun) {
    Write-Host '  zz Claude readsubagent install plan' -ForegroundColor Cyan
  } else {
    Write-Host '  zz Claude readsubagent installed' -ForegroundColor Green
  }
  foreach ($action in $actions) { Write-Host "  -> $action" }
  Write-Host "  -> model: $model"
  Write-Host "  -> target repo: $projectDir"
  Write-Host "  -> sources: $agentSourceBase + zz-readsubagent-mcp"
  if (-not $dryRun) {
    Write-Host '  -> open Claude Code in this repo and approve the zz_readsubagent MCP server when prompted'
  }
  if ($piWarning) { Write-Host "  -> $piWarning" -ForegroundColor Yellow }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
