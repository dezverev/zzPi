# zz Copilot readsubagent - repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.ps1 | iex
#
# Copilot/VS Code wrapper around the harness-neutral zz-readsubagent-mcp server.
# Installs the MCP server at .\.zz-mcp\zz-readsubagent-mcp.py, registers the
# zz_readsubagent server in .\.vscode\mcp.json, and adds repo
# .\.github\copilot-instructions.md guidance. The MCP server spawns a headless
# `pi` child on a local Qwen model (via LM Studio).

$ErrorActionPreference = 'Stop'

function Test-Truthy($value) {
  if ($null -eq $value) { return $false }
  return @('1', 'true', 'yes', 'on') -contains ([string]$value).Trim().ToLowerInvariant()
}

function Show-Usage {
  @'
install-copilot-readsubagent.ps1 [options]

Options:
  --project-dir DIR          Target repo/project dir (default: current directory).
  --model SELECTOR           pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME              pi executable name/path for the MCP server (default: pi).
  --skip-mcp                 Do not add/update the zz_readsubagent server in .vscode/mcp.json.
  --skip-instructions        Do not add/update .github/copilot-instructions.md guidance.
  --skip-copilot-instructions
                              Alias for --skip-instructions.
  --force                    Claim/overwrite existing unowned readsubagent files/entries.
  --dry-run                  Show the install plan without writing files.
  -h, --help                 Show this help.

Environment:
  ZZ_DASH_URL                           Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_READSUBAGENT_MCP_URL               MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_COPILOT_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_COPILOT_READSUBAGENT_MODEL         pi model selector
  ZZ_COPILOT_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_COPILOT_READSUBAGENT_SKIP_MCP=1
  ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS=1
  ZZ_COPILOT_READSUBAGENT_FORCE=1
  ZZ_COPILOT_READSUBAGENT_DRY_RUN=1
  ZZ_COPILOT_READSUBAGENT_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves, and LM Studio reachable. In VS Code/Copilot, approve or
enable the workspace MCP server if prompted.
'@
}

$defaultHost = 'https://raw.githubusercontent.com/dezverev/zzPi/main'
$hostBase = if ($env:ZZ_DASH_URL) { $env:ZZ_DASH_URL.TrimEnd('/') } else { $defaultHost }
$mcpSourceBase = if ($env:ZZ_READSUBAGENT_MCP_URL) { $env:ZZ_READSUBAGENT_MCP_URL.TrimEnd('/') } else { "$hostBase/zz-readsubagent-mcp" }
$projectDir = if ($env:ZZ_COPILOT_READSUBAGENT_PROJECT_DIR) { $env:ZZ_COPILOT_READSUBAGENT_PROJECT_DIR } else { (Get-Location).Path }
$model = if ($env:ZZ_COPILOT_READSUBAGENT_MODEL) { $env:ZZ_COPILOT_READSUBAGENT_MODEL } else { 'lm-studio/qwen/qwen3.6-35b-a3b' }
$piBin = if ($env:ZZ_COPILOT_READSUBAGENT_PI_BIN) { $env:ZZ_COPILOT_READSUBAGENT_PI_BIN } else { 'pi' }
$skipMcp = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_SKIP_MCP
$skipInstructions = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS
$force = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_FORCE
$dryRun = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_DRY_RUN

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^--project-dir$' { if ($i + 1 -ge $args.Count) { throw '--project-dir needs a value' }; $i++; $projectDir = $args[$i]; continue }
    '^--project-dir=' { $projectDir = $args[$i].Substring('--project-dir='.Length); continue }
    '^--model$' { if ($i + 1 -ge $args.Count) { throw '--model needs a value' }; $i++; $model = $args[$i]; continue }
    '^--model=' { $model = $args[$i].Substring('--model='.Length); continue }
    '^--pi-bin$' { if ($i + 1 -ge $args.Count) { throw '--pi-bin needs a value' }; $i++; $piBin = $args[$i]; continue }
    '^--pi-bin=' { $piBin = $args[$i].Substring('--pi-bin='.Length); continue }
    '^--skip-mcp$' { $skipMcp = $true; continue }
    '^--skip-instructions$' { $skipInstructions = $true; continue }
    '^--skip-copilot-instructions$' { $skipInstructions = $true; continue }
    '^--force$' { $force = $true; continue }
    '^--dry-run$' { $dryRun = $true; continue }
    '^(-h|--help)$' { Show-Usage; exit 0 }
    default { throw "unknown option: $($args[$i])" }
  }
}

$projectDir = [System.IO.Path]::GetFullPath($projectDir)

if (-not (Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_ALLOW_SUBDIR)) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $inside = & git -C $projectDir rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and "$inside".Trim() -eq 'true') {
      $gitRoot = (& git -C $projectDir rev-parse --show-toplevel).Trim()
      $gitRoot = [System.IO.Path]::GetFullPath($gitRoot)
      if ($projectDir.TrimEnd('\') -ne $gitRoot.TrimEnd('\')) {
        throw "Refusing to install into a git subdirectory: current=$projectDir repo root=$gitRoot. Run from the repo root or set ZZ_COPILOT_READSUBAGENT_PROJECT_DIR."
      }
    }
  }
}

$piWarning = ''
if (-not (Get-Command $piBin -ErrorAction SilentlyContinue)) {
  $piWarning = "WARNING: '$piBin' not found on PATH. The readsubagent MCP tool needs pi with the LM Studio (lm-studio) provider available."
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zz-copilot-readsubagent-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  $serverTmp = Join-Path $tmpDir 'zz-readsubagent-mcp.py'
  Invoke-WebRequest -UseBasicParsing -Uri "$mcpSourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp

  $serverName = 'zz_readsubagent'
  $serverArgsPath = '.zz-mcp/zz-readsubagent-mcp.py'
  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $mcpJson = Join-Path $projectDir '.vscode\mcp.json'
  $instructionsMd = Join-Path $projectDir '.github\copilot-instructions.md'
  $manifestPath = Join-Path $projectDir '.github\zz-copilot-readsubagent-manifest.json'

  $markerStart = '<!-- zz-copilot-readsubagent:start -->'
  $markerEnd = '<!-- zz-copilot-readsubagent:end -->'
  $copilotBlock = @'
<!-- zz-copilot-readsubagent:start -->
## Read Planning

Before doing focused reads of specific implementation files, ask Copilot to use
the `readsubagent` tool from the `zz_readsubagent` MCP server to get a
read-planning pass. The tool delegates to a local model via `pi` and returns a
concise factual report with paths and line ranges.

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

When to skip readsubagent (Exceptions):

- You already know the exact files and lines you need to read (no ambiguity).
- The user names exact files or asks for an immediate direct read.
- The needed context is already in the current thread.
- A tool or environment limitation prevents using the MCP tool.

**Crucial rule for ambiguity:** The decision to use `readsubagent` is about *knowledge*, not tool-call count. If there is *any ambiguity* about where to look or what to read, do NOT do exploratory manual reads (like `find`, `ls`, or `grep` to hunt around). Instead, ask Copilot to call the `readsubagent` MCP tool with a targeted question to clear the ambiguity and tell you exactly where and what to read.

When an exception applies, mention it briefly and continue with the smallest
reasonable focused read.
<!-- zz-copilot-readsubagent:end -->
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
  $actions.Add((Install-OwnedFile $relServer $serverTarget $serverTmp))

  if ($skipMcp) {
    $actions.Add('skipped .vscode/mcp.json registration')
  } else {
    $data = $null
    if (Test-Path $mcpJson) {
      try { $data = Get-Content $mcpJson -Raw | ConvertFrom-Json } catch { throw "Refusing to edit malformed .vscode/mcp.json: $_" }
    }
    if ($null -eq $data) { $data = [pscustomobject]@{} }
    if (-not ($data.PSObject.Properties.Name -contains 'servers') -or $null -eq $data.servers) {
      $data | Add-Member -NotePropertyName servers -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $existing = $data.servers.PSObject.Properties.Name -contains $serverName
    $managed = Get-ManagedServer $serverName
    if ($existing -and -not $managed -and -not $force) {
      $actions.Add("preserved existing unmanaged $serverName server in .vscode/mcp.json")
    } elseif ($dryRun) {
      $verb = if ($existing) { 'update' } else { 'add' }
      $actions.Add("would $verb $serverName server in .vscode/mcp.json")
    } else {
      $envBlock = [ordered]@{ ZZ_READSUBAGENT_MODEL = $model }
      if ($piBin -ne 'pi') { $envBlock['ZZ_READSUBAGENT_PI_BIN'] = $piBin }
      $entry = [ordered]@{
        type    = 'stdio'
        command = 'python3'
        args    = @($serverArgsPath)
        env     = $envBlock
      }
      $data.servers | Add-Member -NotePropertyName $serverName -NotePropertyValue $entry -Force
      New-Item -ItemType Directory -Force -Path (Split-Path $mcpJson -Parent) | Out-Null
      [System.IO.File]::WriteAllText($mcpJson, ($data | ConvertTo-Json -Depth 10) + "`n")
      $actions.Add("registered $serverName server in .vscode/mcp.json")
    }
  }

  if ($skipInstructions) {
    $actions.Add('skipped .github/copilot-instructions.md guidance')
  } elseif ($dryRun) {
    $actions.Add('would add/update .github/copilot-instructions.md read-planning block')
  } else {
    $existingMd = if (Test-Path $instructionsMd) { Get-Content $instructionsMd -Raw } else { "# Copilot Instructions`n" }
    $updatedMd = Set-MarkedBlock $existingMd $markerStart $markerEnd $copilotBlock
    New-Item -ItemType Directory -Force -Path (Split-Path $instructionsMd -Parent) | Out-Null
    [System.IO.File]::WriteAllText($instructionsMd, $updatedMd.TrimEnd() + "`n")
    $actions.Add('added/updated .github/copilot-instructions.md read-planning block')
  }

  if (-not $dryRun) {
    $managedBlocks = @()
    if (-not $skipInstructions) { $managedBlocks += '.github/copilot-instructions.md:zz-copilot-readsubagent' }
    $managedServers = @()
    if (-not $skipMcp) { $managedServers += $serverName }
    $state = [ordered]@{
      installer       = 'zz-copilot-readsubagent'
      schemaVersion   = 1
      source_url      = $mcpSourceBase
      owned_files     = @($relServer)
      managed_blocks  = $managedBlocks
      managed_servers = $managedServers
      file_hashes     = [ordered]@{ $relServer = Get-FileSha256 $serverTarget }
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
    Write-Host '  zz Copilot readsubagent install plan' -ForegroundColor Cyan
  } else {
    Write-Host '  zz Copilot readsubagent installed' -ForegroundColor Green
  }
  foreach ($action in $actions) { Write-Host "  -> $action" }
  Write-Host "  -> model: $model"
  Write-Host "  -> target repo: $projectDir"
  Write-Host "  -> source: $mcpSourceBase"
  if (-not $dryRun) {
    Write-Host '  -> open VS Code/Copilot Chat in this repo and approve or enable the zz_readsubagent MCP server when prompted'
  }
  if ($piWarning) { Write-Host "  -> $piWarning" -ForegroundColor Yellow }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
