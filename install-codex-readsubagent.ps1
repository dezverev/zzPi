# zz Codex readsubagent - repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-codex-readsubagent.ps1 | iex
#
# Installs the project-local Codex readsubagent under .\.codex\agents\,
# adds repo AGENTS.md read-planning guidance, and ensures the user-level
# LM Studio provider required by the agent.

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
  --skip-agents-md        Do not add/update the repo AGENTS.md guidance block.
  --force                 Claim/overwrite an existing unowned readsubagent TOML.
  --dry-run               Show the install plan without writing files.
  -h, --help              Show this help.

Environment:
  ZZ_DASH_URL                         Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_CODEX_READSUBAGENT_URL           Exact source URL (default: $ZZ_DASH_URL/codex-readsubagent)
  ZZ_CODEX_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_CODEX_READSUBAGENT_PROVIDER_URL  Provider base URL (default: http://127.0.0.1:11444/v1)
  ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER=1
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
$projectDir = if ($env:ZZ_CODEX_READSUBAGENT_PROJECT_DIR) { $env:ZZ_CODEX_READSUBAGENT_PROJECT_DIR } else { (Get-Location).Path }
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$providerUrl = if ($env:ZZ_CODEX_READSUBAGENT_PROVIDER_URL) { $env:ZZ_CODEX_READSUBAGENT_PROVIDER_URL } else { 'http://127.0.0.1:11444/v1' }
$skipProvider = Test-Truthy $env:ZZ_CODEX_READSUBAGENT_SKIP_PROVIDER
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
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/readsubagent.toml" -OutFile $agentTmp

  $relAgent = '.codex/agents/readsubagent.toml'
  $agentTarget = Join-Path $projectDir '.codex\agents\readsubagent.toml'
  $agentsMd = Join-Path $projectDir 'AGENTS.md'
  $manifestPath = Join-Path $projectDir '.codex\zz-codex-readsubagent-manifest.json'
  $userConfig = Join-Path $codexDir 'config.toml'

  $markerStart = '<!-- zz-codex-readsubagent:start -->'
  $markerEnd = '<!-- zz-codex-readsubagent:end -->'
  $agentsBlock = @'
<!-- zz-codex-readsubagent:start -->
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through the `readsubagent` custom agent.

Use `readsubagent` to get:

- A short map of the relevant subsystem.
- Candidate files and directories, with reasons.
- The smallest focused read list for the main agent.
- Search terms, symbols, or line anchors that should guide the focused reads.
- Files or areas that look related but should be avoided for now.
- Uncertainty or follow-up questions that could change the read plan.

Use at least a ten-minute wait for `readsubagent` when the tool supports an
explicit timeout; the role uses a local LM Studio model and may be slower than
hosted models. Prefer a longer wait over assuming the subagent stalled.

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
- A tool or environment limitation prevents using the custom agent.

**Crucial rule for ambiguity:** The decision to use `readsubagent` is about *knowledge*, not tool-call count. If there is *any ambiguity* about where to look or what to read, do NOT do exploratory manual reads (like `find`, `ls`, or `grep` to hunt around). Instead, use `readsubagent` by asking it a targeted question to clear the ambiguity and tell you exactly where and what to read.

When an exception applies, mention it briefly and continue with the smallest
reasonable focused read.
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

  $actions = New-Object System.Collections.Generic.List[string]

  if ((Test-Path $agentTarget) -and -not (Get-ManifestOwns $relAgent) -and -not $force) {
    $same = (Get-FileSha256 $agentTarget) -eq (Get-FileSha256 $agentTmp)
    if (-not $same) {
      throw "Refusing to overwrite existing unowned $relAgent. Use --force if you want this installer to claim it."
    }
    $actions.Add('unchanged existing matching readsubagent.toml')
  } elseif ($dryRun) {
    $verb = if (Test-Path $agentTarget) { 'update' } else { 'create' }
    $actions.Add("would $verb $relAgent")
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $agentTarget -Parent) | Out-Null
    Copy-Item -Force -Path $agentTmp -Destination $agentTarget
    $actions.Add("installed $relAgent")
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
    $state = [ordered]@{
      installer      = 'zz-codex-readsubagent'
      schemaVersion  = 1
      source_url     = $sourceBase
      owned_files    = @($relAgent)
      managed_blocks = @('AGENTS.md:zz-codex-readsubagent')
      file_hashes    = [ordered]@{ $relAgent = Get-FileSha256 $agentTarget }
      provider       = [ordered]@{
        name        = 'zz_lmstudio_read'
        base_url    = $providerUrl
        config_path = $userConfig
        managed     = -not $skipProvider
      }
    }
    if (-not $skipProvider) {
      $state.managed_blocks += '~/.codex/config.toml:zz-codex-readsubagent'
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
  if (-not $dryRun) {
    Write-Host '  -> restart Codex from this repo so it discovers .codex\agents\readsubagent.toml'
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
