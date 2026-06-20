# zz Codex readsubagent - repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.ps1 | iex
#
# Installs the project-local Codex readsubagent under .\.codex\agents\,
# installs the shared zz-readsubagent MCP server under .\.zz-mcp\, registers it
# in .\.codex\config.toml, adds repo AGENTS.md read-planning guidance, and
# ensures the user-level LM Studio provider required by the custom agent.

$ErrorActionPreference = 'Stop'

function Test-Truthy($value) {
  if ($null -eq $value) { return $false }
  return @('1', 'true', 'yes', 'on') -contains ([string]$value).Trim().ToLowerInvariant()
}

function Show-Usage {
  @'
install-codex-readsubagent.ps1 [options]

Options:
  --project-dir DIR       Target repo/project dir (default: current directory).
  --provider-url URL      LM Studio OpenAI-compatible base URL for ~/.codex/config.toml.
  --skip-provider         Do not add/update the user-level model provider.
  --skip-mcp              Do not install/register the repo-local MCP server.
  --skip-agents-md        Do not add/update the repo AGENTS.md guidance block.
  --force                 Claim/overwrite existing unowned readsubagent files.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                         Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CODEX_READSUBAGENT_URL           Exact source URL (default: $ZZ_DASH_URL/codex-readsubagent)
  ZZ_READSUBAGENT_MCP_URL             MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_CODEX_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CODEX_READSUBAGENT_PROVIDER_URL  Provider base URL (default: http://127.0.0.1:11444/v1)
  ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER=1
  ZZ_CODEX_READSUBAGENT_SKIP_MCP=1
  ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD=1
  ZZ_CODEX_READSUBAGENT_FORCE=1
  ZZ_CODEX_READSUBAGENT_DRY_RUN=1
  ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR=1
  CODEX_HOME                          User Codex config dir (default: ~/.codex)
'@
}

$defaultHost = 'https://raw.githubusercontent.com/dezverev/zzPi/main'
$hostBase = if ($env:ZZ_DASH_URL) { $env:ZZ_DASH_URL.TrimEnd('/') } else { $defaultHost }
$sourceBase = if ($env:ZZ_CODEX_READSUBAGENT_URL) {
  $env:ZZ_CODEX_READSUBAGENT_URL.TrimEnd('/')
} else {
  "$hostBase/codex-readsubagent"
}
$mcpSourceBase = if ($env:ZZ_READSUBAGENT_MCP_URL) {
  $env:ZZ_READSUBAGENT_MCP_URL.TrimEnd('/')
} else {
  "$hostBase/zz-readsubagent-mcp"
}
$projectDir = if ($env:ZZ_CODEX_READSUBAGENT_PROJECT_DIR) { $env:ZZ_CODEX_READSUBAGENT_PROJECT_DIR } else { (Get-Location).Path }
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$providerUrl = if ($env:ZZ_CODEX_READSUBAGENT_PROVIDER_URL) { $env:ZZ_CODEX_READSUBAGENT_PROVIDER_URL } else { 'http://127.0.0.1:11444/v1' }
$skipProvider = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER
$skipMcp = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_MCP
$skipAgentsMd = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD
$force = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_FORCE
$dryRun = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_DRY_RUN

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^--project-dir$' {
      if ($i + 1 -ge $args.Count) { throw '--project-dir needs a value' }
      $i++
      $projectDir = $args[$i]
      continue
    }
    '^--project-dir=' {
      $projectDir = $args[$i].Substring('--project-dir='.Length)
      continue
    }
    '^--provider-url$' {
      if ($i + 1 -ge $args.Count) { throw '--provider-url needs a value' }
      $i++
      $providerUrl = $args[$i]
      continue
    }
    '^--provider-url=' {
      $providerUrl = $args[$i].Substring('--provider-url='.Length)
      continue
    }
    '^--skip-provider$' { $skipProvider = $true; continue }
    '^--skip-mcp$' { $skipMcp = $true; continue }
    '^--skip-agents-md$' { $skipAgentsMd = $true; continue }
    '^--force$' { $force = $true; continue }
    '^--dry-run$' { $dryRun = $true; continue }
    '^(-h|--help)$' { Show-Usage; exit 0 }
    default { throw "unknown option: $($args[$i])" }
  }
}

$projectDir = [System.IO.Path]::GetFullPath($projectDir)
New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
$codexDir = [System.IO.Path]::GetFullPath($codexDir)

if (-not (Test-Truthy $env:ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR)) {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    $inside = & git -C $projectDir rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and "$inside".Trim() -eq 'true') {
      $gitRoot = (& git -C $projectDir rev-parse --show-toplevel).Trim()
      $gitRoot = [System.IO.Path]::GetFullPath($gitRoot)
      if ($projectDir.TrimEnd('\') -ne $gitRoot.TrimEnd('\')) {
        throw "Refusing to install into a git subdirectory: current=$projectDir repo root=$gitRoot. Run from the repo root or set ZZ_CODEX_READSUBAGENT_PROJECT_DIR."
      }
    }
  }
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zz-codex-readsubagent-$([System.Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  $agentTmp = Join-Path $tmpDir 'readsubagent.toml'
  $serverTmp = Join-Path $tmpDir 'zz-readsubagent-mcp.py'
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/readsubagent.toml" -OutFile $agentTmp
  if (-not $skipMcp) {
    Invoke-WebRequest -UseBasicParsing -Uri "$mcpSourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp
  }

  $relAgent = '.codex/agents/readsubagent.toml'
  $relCodexConfig = '.codex/config.toml'
  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $agentTarget = Join-Path $projectDir '.codex\agents\readsubagent.toml'
  $codexConfig = Join-Path $projectDir '.codex\config.toml'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $agentsMd = Join-Path $projectDir 'AGENTS.md'
  $manifestPath = Join-Path $projectDir '.codex\zz-codex-readsubagent-manifest.json'
  $userConfig = Join-Path $codexDir 'config.toml'

  $markerStart = '<!-- zz-codex-readsubagent:start -->'
  $markerEnd = '<!-- zz-codex-readsubagent:end -->'
  $agentsBlock = @'
<!-- zz-codex-readsubagent:start -->
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through `readsubagent`.

Prefer the Codex MCP tool provided by `.zz-mcp/zz-readsubagent-mcp.py`. This
repo registers it in `.codex/config.toml`, so trusted Codex sessions should see
a `readsubagent` tool that behaves similarly to `.pi/extensions/readsubagent.ts`.
If that MCP tool is not exposed in the current session, fall back to the
`readsubagent` custom agent.

Use `readsubagent` to get:

- A short map of the relevant subsystem.
- Candidate files and directories, with reasons.
- The smallest focused read list for the main agent.
- Search terms, symbols, or line anchors that should guide the focused reads.
- Files or areas that look related but should be avoided for now.
- Uncertainty or follow-up questions that could change the read plan.

When using the MCP tool, ask a targeted factual `question` and include
repo-relative `path`/`paths`, `symbols`, `searchTerms`, `lineRanges`, `output`,
and `maxReportChars` where useful. Keep reports small and ask narrower
follow-ups before falling back to broad direct reads.

Use at least a ten-minute wait for `readsubagent` when the tool supports an
explicit timeout, because the local model may be slower than hosted models.
Prefer a longer wait over assuming the subagent stalled.

Use `readsubagent` only for factual read planning and file inspection. Do not
ask it to create implementation plans, solution proposals, edit strategies,
code-review judgments, bug findings, correctness assessments, or accept/reject
recommendations.
<!-- zz-codex-readsubagent:end -->
'@

  $providerStart = '# zz-codex-readsubagent:start'
  $providerEnd = '# zz-codex-readsubagent:end'
  $providerBlock = @"
$providerStart
[model_providers.zz_lmstudio_read]
name = "LM Studio readsubagent"
base_url = "$providerUrl"
$providerEnd
"@

  $codexMcpStart = '# zz-codex-readsubagent-mcp:start'
  $codexMcpEnd = '# zz-codex-readsubagent-mcp:end'
  $codexMcpBlock = @"
$codexMcpStart
[mcp_servers.readsubagent]
command = "python3"
args = ["$relServer"]
cwd = "."
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 1800
enabled_tools = ["readsubagent"]
$codexMcpEnd
"@

  function Get-ManifestOwns([string]$rel) {
    if (-not (Test-Path $manifestPath)) { return $false }
    try {
      $state = Get-Content $manifestPath -Raw | ConvertFrom-Json
      return @($state.owned_files) -contains $rel
    } catch {
      return $false
    }
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

  if ($skipMcp) {
    $actions.Add('skipped repo-local Codex MCP server')
    $actions.Add('skipped .codex/config.toml MCP registration')
  } else {
    $actions.Add((Install-OwnedFile $relServer $serverTarget $serverTmp))
    $existingCodexConfig = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { '' }
    if ($existingCodexConfig.Contains($codexMcpStart) -and $existingCodexConfig.Contains($codexMcpEnd)) {
      if ($dryRun) {
        $actions.Add('would update .codex/config.toml MCP registration')
      } else {
        $updatedCodexConfig = Set-MarkedBlock $existingCodexConfig $codexMcpStart $codexMcpEnd $codexMcpBlock
        New-Item -ItemType Directory -Force -Path (Split-Path $codexConfig -Parent) | Out-Null
        [System.IO.File]::WriteAllText($codexConfig, $updatedCodexConfig.TrimEnd() + "`n")
        $actions.Add('updated .codex/config.toml MCP registration')
      }
    } elseif ($existingCodexConfig -match '(?m)^\[mcp_servers\.readsubagent\]\s*$') {
      $actions.Add('preserved existing unmanaged readsubagent MCP server in .codex/config.toml')
    } elseif ($dryRun) {
      $actions.Add('would add readsubagent MCP server to .codex/config.toml')
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $codexConfig -Parent) | Out-Null
      $nextCodexConfig = $existingCodexConfig.TrimEnd()
      if ($nextCodexConfig.Length -gt 0) { $nextCodexConfig = "$nextCodexConfig`n`n" }
      $nextCodexConfig = "$nextCodexConfig$($codexMcpBlock.TrimEnd())`n"
      [System.IO.File]::WriteAllText($codexConfig, $nextCodexConfig)
      $actions.Add('added readsubagent MCP server to .codex/config.toml')
    }
  }

  if ($skipAgentsMd) {
    $actions.Add('skipped AGENTS.md guidance')
  } elseif ($dryRun) {
    $actions.Add('would add/update AGENTS.md read-planning block')
  } else {
    $existing = if (Test-Path $agentsMd) { Get-Content $agentsMd -Raw } else { "# Codex Guidance`n" }
    $updated = Set-MarkedBlock $existing $markerStart $markerEnd $agentsBlock
    [System.IO.File]::WriteAllText($agentsMd, $updated.TrimEnd() + "`n")
    $actions.Add('added/updated AGENTS.md read-planning block')
  }

  if ($skipProvider) {
    $actions.Add('skipped user-level provider')
  } else {
    $existingConfig = if (Test-Path $userConfig) { Get-Content $userConfig -Raw } else { '' }
    if ($existingConfig.Contains($providerStart) -and $existingConfig.Contains($providerEnd)) {
      if ($dryRun) {
        $actions.Add("would update $userConfig")
      } else {
        $updatedConfig = Set-MarkedBlock $existingConfig $providerStart $providerEnd $providerBlock
        New-Item -ItemType Directory -Force -Path (Split-Path $userConfig -Parent) | Out-Null
        [System.IO.File]::WriteAllText($userConfig, $updatedConfig.TrimEnd() + "`n")
        $actions.Add("updated $userConfig")
      }
    } elseif ($existingConfig -match '(?m)^\[model_providers\.zz_lmstudio_read\]\s*$') {
      $actions.Add("preserved existing unmanaged zz_lmstudio_read provider in $userConfig")
    } elseif ($dryRun) {
      $actions.Add("would add zz_lmstudio_read provider to $userConfig")
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $userConfig -Parent) | Out-Null
      $next = $existingConfig.TrimEnd()
      if ($next.Length -gt 0) { $next = "$next`n`n" }
      $next = "$next$($providerBlock.TrimEnd())`n"
      [System.IO.File]::WriteAllText($userConfig, $next)
      $actions.Add("added zz_lmstudio_read provider to $userConfig")
    }
  }

  if (-not $dryRun) {
    $ownedFiles = @($relAgent)
    if (-not $skipMcp) { $ownedFiles += @($relCodexConfig, $relServer) }
    $fileHashes = [ordered]@{}
    foreach ($rel in $ownedFiles) { $fileHashes[$rel] = Get-FileSha256 (Join-Path $projectDir $rel) }
    $managedBlocks = @()
    if (-not $skipAgentsMd) { $managedBlocks += 'AGENTS.md:zz-codex-readsubagent' }
    if (-not $skipMcp) { $managedBlocks += '.codex/config.toml:zz-codex-readsubagent-mcp' }
    if (-not $skipProvider) { $managedBlocks += '~/.codex/config.toml:zz-codex-readsubagent' }
    $state = [ordered]@{
      installer      = 'zz-codex-readsubagent'
      schemaVersion  = 1
      source_url     = $sourceBase
      mcp_source_url = $mcpSourceBase
      owned_files    = $ownedFiles
      managed_blocks = $managedBlocks
      file_hashes    = $fileHashes
      mcp_server     = [ordered]@{
        name        = 'readsubagent'
        config_path = $codexConfig
        server_path = $relServer
        managed     = -not $skipMcp
      }
      provider       = [ordered]@{
        name        = 'zz_lmstudio_read'
        base_url    = $providerUrl
        config_path = $userConfig
        managed     = -not $skipProvider
      }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath -Parent) | Out-Null
    [System.IO.File]::WriteAllText($manifestPath, ($state | ConvertTo-Json -Depth 10) + "`n")
  }

  Write-Host ''
  if ($dryRun) {
    Write-Host '  zz Codex readsubagent install plan' -ForegroundColor Cyan
  } else {
    Write-Host '  zz Codex readsubagent installed' -ForegroundColor Green
  }
  foreach ($action in $actions) { Write-Host "  -> $action" }
  Write-Host "  -> target repo: $projectDir"
  Write-Host "  -> source: $sourceBase"
  Write-Host "  -> mcp source: $mcpSourceBase"
  if (-not $dryRun) {
    Write-Host '  -> restart Codex from this repo so it discovers .codex\agents\readsubagent.toml and .codex\config.toml'
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
