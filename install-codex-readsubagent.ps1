# zz Codex readsubagent - repo-local skill + MCP installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.ps1 | iex
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
  --model SELECTOR        pi model selector (default: lm-studio/qwen/qwen3.6-35b-a3b).
  --pi-bin NAME           pi executable name/path for the MCP server (default: pi).
  --skip-mcp              Do not install/register the repo-local MCP server.
  --skip-agents-md        Do not add/update the repo AGENTS.md guidance block.
  --skip-skill            Do not install/update .codex/skills/readsubagent/SKILL.md.
  --force                 Claim/overwrite existing unowned or modified managed files.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                         Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CODEX_READSUBAGENT_URL           Skill source URL
  ZZ_READSUBAGENT_MCP_URL             MCP server source URL
  ZZ_CODEX_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CODEX_READSUBAGENT_MODEL         pi model selector
  ZZ_CODEX_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_CODEX_READSUBAGENT_SKIP_MCP=1
  ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD=1
  ZZ_CODEX_READSUBAGENT_SKIP_SKILL=1
  ZZ_CODEX_READSUBAGENT_FORCE=1
  ZZ_CODEX_READSUBAGENT_DRY_RUN=1
  ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR=1
  CODEX_HOME                          User Codex config dir (used only to retire the old provider block)
'@
}

$hostBase = if ($env:ZZ_DASH_URL) { $env:ZZ_DASH_URL.TrimEnd('/') } else { 'https://raw.githubusercontent.com/dezverev/zzPi/main' }
$sourceBase = if ($env:ZZ_CODEX_READSUBAGENT_URL) { $env:ZZ_CODEX_READSUBAGENT_URL.TrimEnd('/') } else { "$hostBase/codex-readsubagent" }
$mcpSourceBase = if ($env:ZZ_READSUBAGENT_MCP_URL) { $env:ZZ_READSUBAGENT_MCP_URL.TrimEnd('/') } else { "$hostBase/zz-readsubagent-mcp" }
$projectDir = if ($env:ZZ_CODEX_READSUBAGENT_PROJECT_DIR) { $env:ZZ_CODEX_READSUBAGENT_PROJECT_DIR } else { (Get-Location).Path }
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$model = if ($env:ZZ_CODEX_READSUBAGENT_MODEL) { $env:ZZ_CODEX_READSUBAGENT_MODEL } else { 'lm-studio/qwen/qwen3.6-35b-a3b' }
$piBin = if ($env:ZZ_CODEX_READSUBAGENT_PI_BIN) { $env:ZZ_CODEX_READSUBAGENT_PI_BIN } else { 'pi' }
$skipMcp = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_MCP
$skipAgentsMd = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_AGENTS_MD
$skipSkill = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_SKILL
$force = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_FORCE
$dryRun = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_DRY_RUN

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^--project-dir$' { if (++$i -ge $args.Count) { throw '--project-dir needs a value' }; $projectDir = $args[$i]; continue }
    '^--project-dir=' { $projectDir = $args[$i].Substring('--project-dir='.Length); continue }
    '^--model$' { if (++$i -ge $args.Count) { throw '--model needs a value' }; $model = $args[$i]; continue }
    '^--model=' { $model = $args[$i].Substring('--model='.Length); continue }
    '^--pi-bin$' { if (++$i -ge $args.Count) { throw '--pi-bin needs a value' }; $piBin = $args[$i]; continue }
    '^--pi-bin=' { $piBin = $args[$i].Substring('--pi-bin='.Length); continue }
    '^--skip-mcp$' { $skipMcp = $true; continue }
    '^--skip-agents-md$' { $skipAgentsMd = $true; continue }
    '^--skip-skill$' { $skipSkill = $true; continue }
    '^--force$' { $force = $true; continue }
    '^--dry-run$' { $dryRun = $true; continue }
    '^(-h|--help)$' { Show-Usage; exit 0 }
    default { throw "unknown option: $($args[$i])" }
  }
}

$projectDir = [System.IO.Path]::GetFullPath($projectDir)
New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
$codexDir = [System.IO.Path]::GetFullPath($codexDir)
if (-not (Test-Truthy $env:ZZ_CODEX_READSUBAGENT_ALLOW_SUBDIR) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  $inside = & git -C $projectDir rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -eq 0 -and "$inside".Trim() -eq 'true') {
    $gitRoot = [System.IO.Path]::GetFullPath((& git -C $projectDir rev-parse --show-toplevel).Trim())
    if ($projectDir.TrimEnd('\') -ne $gitRoot.TrimEnd('\')) { throw "Refusing to install into a git subdirectory: current=$projectDir repo root=$gitRoot" }
  }
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zz-codex-readsubagent-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
try {
  $skillTmp = Join-Path $tmpDir 'SKILL.md'
  $serverTmp = Join-Path $tmpDir 'zz-readsubagent-mcp.py'
  if (-not $skipSkill) { Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/skills/readsubagent/SKILL.md" -OutFile $skillTmp }
  if (-not $skipMcp) { Invoke-WebRequest -UseBasicParsing -Uri "$mcpSourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp }

  $relSkill = '.codex/skills/readsubagent/SKILL.md'
  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $obsoleteAgent = '.codex/agents/readsubagent.toml'
  $skillTarget = Join-Path $projectDir '.codex\skills\readsubagent\SKILL.md'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $obsoleteAgentTarget = Join-Path $projectDir '.codex\agents\readsubagent.toml'
  $codexConfig = Join-Path $projectDir '.codex\config.toml'
  $agentsMd = Join-Path $projectDir 'AGENTS.md'
  $manifestPath = Join-Path $projectDir '.codex\zz-codex-readsubagent-manifest.json'
  $userConfig = Join-Path $codexDir 'config.toml'

  $guidanceStart = '<!-- zz-codex-readsubagent:start -->'
  $guidanceEnd = '<!-- zz-codex-readsubagent:end -->'
  $guidanceBlock = @'
<!-- zz-codex-readsubagent:start -->
## Read Planning

Before focused reads of unfamiliar implementation files, use the repo-local
`readsubagent` skill. The skill calls the direct MCP tool registered in
`.codex/config.toml`; do not launch another Codex subagent.

Ask a targeted factual `question` and include repo-relative `path`/`paths`,
`symbols`, `searchTerms`, `lineRanges`, `output`, and `maxReportChars` where
useful. Use it for subsystem maps, focused read lists, definitions, factual
summaries, and line anchors—not implementation planning, edit strategy, bug
finding, code review, or correctness judgments. The local model can be slow;
wait rather than retrying merely because it is taking time.
<!-- zz-codex-readsubagent:end -->
'@
  $mcpStart = '# zz-codex-readsubagent-mcp:start'
  $mcpEnd = '# zz-codex-readsubagent-mcp:end'
  $modelEscaped = $model.Replace('\', '\\').Replace('"', '\"')
  $piBinEscaped = $piBin.Replace('\', '\\').Replace('"', '\"')
  $envFields = "ZZ_READSUBAGENT_MODEL = `"$modelEscaped`""
  if ($piBin -ne 'pi') { $envFields += ", ZZ_READSUBAGENT_PI_BIN = `"$piBinEscaped`"" }
  $mcpBlock = @"
$mcpStart
[mcp_servers.readsubagent]
command = "python3"
args = ["$relServer"]
cwd = "."
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 1800
enabled_tools = ["readsubagent"]
env = { $envFields }
$mcpEnd
"@
  $providerStart = '# zz-codex-readsubagent:start'
  $providerEnd = '# zz-codex-readsubagent:end'

  $prior = $null
  if (Test-Path $manifestPath) { try { $prior = Get-Content $manifestPath -Raw | ConvertFrom-Json } catch { $prior = $null } }
  $priorOwned = @(); if ($null -ne $prior) { $priorOwned = @($prior.owned_files) }

  function Get-FileSha256([string]$path) { (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant() }
  function Get-PriorHash([string]$rel) {
    if ($null -eq $prior -or $null -eq $prior.file_hashes) { return $null }
    $property = $prior.file_hashes.PSObject.Properties[$rel]
    if ($null -eq $property) { return $null }
    return [string]$property.Value
  }
  function Set-MarkedBlock([string]$text, [string]$start, [string]$end, [string]$block) {
    $pattern = '(?s)' + [regex]::Escape($start) + '.*?' + [regex]::Escape($end)
    if ([regex]::IsMatch($text, $pattern)) { return [regex]::Replace($text, $pattern, $block.TrimEnd()) }
    if ($text.Trim().Length -eq 0) { return $block.TrimEnd() }
    return $text.TrimEnd() + "`n`n" + $block.TrimEnd()
  }
  function Remove-MarkedBlock([string]$text, [string]$start, [string]$end) {
    $pattern = '(?s)(?:^|\r?\n)' + [regex]::Escape($start) + '.*?' + [regex]::Escape($end) + '(?:\r?\n|$)'
    return ([regex]::Replace($text, $pattern, "`n")).Trim() + "`n"
  }
  function Test-Markers([string]$path, [string]$start, [string]$end) {
    if (-not (Test-Path $path)) { return }
    $text = Get-Content $path -Raw
    $starts = ([regex]::Matches($text, [regex]::Escape($start))).Count
    $ends = ([regex]::Matches($text, [regex]::Escape($end))).Count
    if ($starts -ne $ends -or $starts -gt 1) { throw "Refusing to edit ${path}: managed markers are malformed or duplicated" }
  }
  function Test-OwnedFile([string]$rel, [string]$target, [string]$tmp) {
    if (-not (Test-Path $target)) { return }
    if ($priorOwned -contains $rel) {
      $expected = Get-PriorHash $rel
      if (-not $expected -and -not $force) { throw "Cannot verify ownership baseline for $rel. Use --force to replace it." }
      if ($expected -and (Get-FileSha256 $target) -ne $expected -and -not $force) { throw "Refusing to overwrite locally modified managed $rel. Use --force to replace it." }
    } elseif ((Get-FileSha256 $target) -ne (Get-FileSha256 $tmp) -and -not $force) {
      throw "Refusing to overwrite existing unowned $rel. Use --force to claim it."
    }
  }
  function Install-OwnedFile([string]$rel, [string]$target, [string]$tmp) {
    if ($dryRun) { return "would $(if (Test-Path $target) {'update'} else {'create'}) $rel" }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -Force $tmp $target
    return "installed $rel"
  }

  if (-not $skipSkill) { Test-OwnedFile $relSkill $skillTarget $skillTmp }
  if (-not $skipMcp) { Test-OwnedFile $relServer $serverTarget $serverTmp }
  Test-Markers $codexConfig $mcpStart $mcpEnd
  Test-Markers $agentsMd $guidanceStart $guidanceEnd
  Test-Markers $userConfig $providerStart $providerEnd

  $actions = New-Object System.Collections.Generic.List[string]
  if (($priorOwned -contains $obsoleteAgent) -and (Test-Path $obsoleteAgentTarget)) {
    $expected = Get-PriorHash $obsoleteAgent
    if ($expected -and (Get-FileSha256 $obsoleteAgentTarget) -ne $expected) { $actions.Add("preserved locally modified obsolete $obsoleteAgent") }
    elseif ($dryRun) { $actions.Add("would remove obsolete $obsoleteAgent") }
    else { Remove-Item -Force $obsoleteAgentTarget; $actions.Add("removed obsolete $obsoleteAgent") }
  }
  if (Test-Path $userConfig) {
    $userText = Get-Content $userConfig -Raw
    if ($userText.Contains($providerStart)) {
      if ($dryRun) { $actions.Add("would remove obsolete zz_lmstudio_read provider from $userConfig") }
      else { [IO.File]::WriteAllText($userConfig, (Remove-MarkedBlock $userText $providerStart $providerEnd)); $actions.Add("removed obsolete zz_lmstudio_read provider from $userConfig") }
    }
  }
  if ($skipSkill) { $actions.Add('skipped Codex readsubagent skill') } else { $actions.Add((Install-OwnedFile $relSkill $skillTarget $skillTmp)) }
  if ($skipMcp) {
    $actions.Add('skipped repo-local Codex MCP server')
    $actions.Add('skipped .codex/config.toml MCP registration')
  } else {
    $actions.Add((Install-OwnedFile $relServer $serverTarget $serverTmp))
    $existing = if (Test-Path $codexConfig) { Get-Content $codexConfig -Raw } else { '' }
    if (-not $existing.Contains($mcpStart) -and $existing -match '(?m)^\[mcp_servers\.readsubagent\]\s*$') { $actions.Add('preserved existing unmanaged readsubagent MCP server in .codex/config.toml') }
    elseif ($dryRun) { $actions.Add("would add/update .codex/config.toml MCP registration") }
    else {
      $updated = Set-MarkedBlock $existing $mcpStart $mcpEnd $mcpBlock
      New-Item -ItemType Directory -Force -Path (Split-Path $codexConfig -Parent) | Out-Null
      [IO.File]::WriteAllText($codexConfig, $updated.TrimEnd() + "`n")
      $actions.Add('added/updated .codex/config.toml MCP registration')
    }
  }
  if ($skipAgentsMd) { $actions.Add('skipped AGENTS.md guidance') }
  elseif ($dryRun) { $actions.Add('would add/update AGENTS.md read-planning block') }
  else {
    $existing = if (Test-Path $agentsMd) { Get-Content $agentsMd -Raw } else { "# Codex Guidance`n" }
    [IO.File]::WriteAllText($agentsMd, (Set-MarkedBlock $existing $guidanceStart $guidanceEnd $guidanceBlock).TrimEnd() + "`n")
    $actions.Add('added/updated AGENTS.md read-planning block')
  }

  if (-not $dryRun) {
    $owned = @($priorOwned | Where-Object { $_ -ne $obsoleteAgent -and $_ -ne '.codex/config.toml' })
    if (-not $skipSkill) { $owned += $relSkill }
    if (-not $skipMcp) { $owned += $relServer }
    $owned = @($owned | Select-Object -Unique | Where-Object { Test-Path (Join-Path $projectDir $_) } | Sort-Object)
    $hashes = [ordered]@{}
    foreach ($rel in $owned) {
      $oldHash = Get-PriorHash $rel
      $refreshed = (-not $skipSkill -and $rel -eq $relSkill) -or (-not $skipMcp -and $rel -eq $relServer)
      $hashes[$rel] = if ($refreshed -or -not $oldHash) { Get-FileSha256 (Join-Path $projectDir $rel) } else { $oldHash }
    }
    $blocks = @(); if ($null -ne $prior) { $blocks = @($prior.managed_blocks) }
    $blocks = @($blocks | Where-Object { $_ -ne '~/.codex/config.toml:zz-codex-readsubagent' })
    if (-not $skipAgentsMd) { $blocks += 'AGENTS.md:zz-codex-readsubagent' }
    if (-not $skipMcp) { $blocks += '.codex/config.toml:zz-codex-readsubagent-mcp' }
    $blocks = @($blocks | Select-Object -Unique | Sort-Object)
    $state = [ordered]@{
      installer = 'zz-codex-readsubagent'; schemaVersion = 2; source_url = $sourceBase; mcp_source_url = $mcpSourceBase
      owned_files = $owned; managed_blocks = $blocks; file_hashes = $hashes
      mcp_server = [ordered]@{ name = 'readsubagent'; config_path = $codexConfig; server_path = $relServer; model = $model; pi_bin = $piBin; managed = $blocks -contains '.codex/config.toml:zz-codex-readsubagent-mcp' }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath -Parent) | Out-Null
    [IO.File]::WriteAllText($manifestPath, ($state | ConvertTo-Json -Depth 100) + "`n")
  }

  Write-Host ''
  Write-Host $(if ($dryRun) { '  zz Codex readsubagent install plan' } else { '  zz Codex readsubagent installed' }) -ForegroundColor Cyan
  foreach ($action in $actions) { Write-Host "  -> $action" }
  Write-Host "  -> model: $model"
  Write-Host "  -> target repo: $projectDir"
  if (-not $dryRun) { Write-Host '  -> restart Codex from this repo so it discovers .codex\skills\readsubagent\SKILL.md and .codex\config.toml' }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
