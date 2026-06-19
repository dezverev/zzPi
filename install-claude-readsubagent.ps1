# zz Claude readsubagent - repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-claude-readsubagent.ps1 | iex
#
# Thin Claude Code wrapper around the harness-neutral zz-readsubagent-mcp server.
# Installs the MCP server at .\.zz-mcp\zz-readsubagent-mcp.py, registers the
# zz_readsubagent server in .\.mcp.json, writes .\.claude\agents\readsubagent.md
# (restricted to that one MCP tool), installs the readsubagent skill and hooks,
# merges .\.claude\settings.json hook entries, and adds repo CLAUDE.md guidance.
# The MCP server spawns a headless `pi` child on a local Qwen model (via LM Studio).

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
  --skip-hooks            Do not install hooks or merge .claude/settings.json.
  --skip-skill            Do not install the readsubagent Claude skill.
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
  ZZ_CLAUDE_READSUBAGENT_SKIP_HOOKS=1
  ZZ_CLAUDE_READSUBAGENT_SKIP_SKILL=1
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
$skipHooks = Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_SKIP_HOOKS
$skipSkill = Test-Truthy $env:ZZ_CLAUDE_READSUBAGENT_SKIP_SKILL
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
    '^--skip-hooks$' { $skipHooks = $true; continue }
    '^--skip-skill$' { $skipSkill = $true; continue }
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
  $hookNudgeShTmp = Join-Path $tmpDir 'readsubagent-nudge.sh'
  $hookBlockExploreShTmp = Join-Path $tmpDir 'block-explore-subagent.sh'
  $hookNudgeTmp = Join-Path $tmpDir 'readsubagent-nudge.ps1'
  $hookBlockExploreTmp = Join-Path $tmpDir 'block-explore-subagent.ps1'
  $skillTmp = Join-Path $tmpDir 'SKILL.md'
  Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/readsubagent.md" -OutFile $agentTmp
  Invoke-WebRequest -UseBasicParsing -Uri "$mcpSourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp
  if (-not $skipHooks) {
    Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/hooks/readsubagent-nudge.sh" -OutFile $hookNudgeShTmp
    Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/hooks/block-explore-subagent.sh" -OutFile $hookBlockExploreShTmp
    Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/hooks/readsubagent-nudge.ps1" -OutFile $hookNudgeTmp
    Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/hooks/block-explore-subagent.ps1" -OutFile $hookBlockExploreTmp
  }
  if (-not $skipSkill) {
    Invoke-WebRequest -UseBasicParsing -Uri "$agentSourceBase/skills/readsubagent/SKILL.md" -OutFile $skillTmp
  }

  $serverName = 'zz_readsubagent'
  $serverArgsPath = '.zz-mcp/zz-readsubagent-mcp.py'
  $relAgent = '.claude/agents/readsubagent.md'
  $relHookNudgeSh = '.claude/hooks/readsubagent-nudge.sh'
  $relHookBlockExploreSh = '.claude/hooks/block-explore-subagent.sh'
  $relHookNudge = '.claude/hooks/readsubagent-nudge.ps1'
  $relHookBlockExplore = '.claude/hooks/block-explore-subagent.ps1'
  $relSkill = '.claude/skills/readsubagent/SKILL.md'
  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $agentTarget = Join-Path $projectDir '.claude\agents\readsubagent.md'
  $hookNudgeShTarget = Join-Path $projectDir '.claude\hooks\readsubagent-nudge.sh'
  $hookBlockExploreShTarget = Join-Path $projectDir '.claude\hooks\block-explore-subagent.sh'
  $hookNudgeTarget = Join-Path $projectDir '.claude\hooks\readsubagent-nudge.ps1'
  $hookBlockExploreTarget = Join-Path $projectDir '.claude\hooks\block-explore-subagent.ps1'
  $skillTarget = Join-Path $projectDir '.claude\skills\readsubagent\SKILL.md'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $settingsJson = Join-Path $projectDir '.claude\settings.json'
  $mcpJson = Join-Path $projectDir '.mcp.json'
  $claudeMd = Join-Path $projectDir 'CLAUDE.md'
  $manifestPath = Join-Path $projectDir '.claude\zz-claude-readsubagent-manifest.json'

  $markerStart = '<!-- zz-claude-readsubagent:start -->'
  $markerEnd = '<!-- zz-claude-readsubagent:end -->'
  $claudeBlock = @'
<!-- zz-claude-readsubagent:start -->
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through `readsubagent`, which delegates to a local model
(Qwen via LM Studio, through a headless `pi` child).

`readsubagent` is reachable three equivalent ways — use whichever fits:

- the **`readsubagent` skill** (via the Skill tool),
- the **`readsubagent` subagent** (`Agent(subagent_type="readsubagent")`), and
- the **direct MCP tool `mcp__zz_readsubagent__readsubagent`**, served by
  `.zz-mcp/zz-readsubagent-mcp.py`.

Prefer the **direct MCP tool** when you already know the targets: it is the
lowest-overhead path and gives the most control. Pass `question` (required) plus
any of `path`/`paths`, `symbols`, `searchTerms`, `lineRanges`, `output`, and
`maxReportChars` to scope the inspection. Reach for the skill or subagent when
you want the wrapped read-planning workflow instead.

Use `readsubagent` (any entry point) to get a short subsystem map, candidate
files, the smallest focused read list, useful search terms/line anchors, areas
to avoid, and uncertainty or follow-up questions.

The local model can be slow. Allow a long wait for `readsubagent`; prefer
waiting over assuming it stalled. Use it only for factual read planning and file
inspection, not implementation planning or code-review judgments.
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

  function New-CommandHook([string]$scriptRel, [string]$arg) {
    $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`${CLAUDE_PROJECT_DIR}/$scriptRel")
    if ($arg) { $argsList += $arg }
    return [ordered]@{ type = 'command'; command = 'powershell.exe'; args = $argsList; timeout = 5 }
  }

  function New-HookEntry([string]$scriptRel, [string]$arg, [string]$matcher) {
    $entry = [ordered]@{ hooks = @((New-CommandHook $scriptRel $arg)) }
    if ($matcher) { $entry = [ordered]@{ matcher = $matcher; hooks = $entry.hooks } }
    return $entry
  }

  function Test-EntryHasScript([object]$entry, [string]$scriptName, [string]$arg) {
    $text = $entry | ConvertTo-Json -Depth 10 -Compress
    return ($text -like "*$scriptName*" -and (-not $arg -or $text -like "*$arg*"))
  }

  function Add-HookEvent([object]$settings, [string]$event, [object]$entry, [string]$scriptName, [string]$arg) {
    if (-not ($settings.PSObject.Properties.Name -contains 'hooks') -or $null -eq $settings.hooks) {
      $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not ($settings.hooks -is [pscustomobject])) { throw 'Refusing to edit .claude/settings.json because hooks is not an object' }
    $current = @()
    if ($settings.hooks.PSObject.Properties.Name -contains $event -and $null -ne $settings.hooks.$event) {
      $current = @($settings.hooks.$event)
    }
    foreach ($existing in $current) {
      if (Test-EntryHasScript $existing $scriptName $arg) { return $false }
    }
    $settings.hooks | Add-Member -NotePropertyName $event -NotePropertyValue @($current + $entry) -Force
    return $true
  }

  function Add-SettingsHooks() {
    if ($skipHooks) { return 'skipped Claude readsubagent hooks' }
    if ($dryRun) { return 'would merge readsubagent hooks into .claude/settings.json' }
    $settings = $null
    if (Test-Path $settingsJson) {
      try { $settings = Get-Content $settingsJson -Raw | ConvertFrom-Json } catch { throw "Refusing to edit malformed .claude/settings.json: $_" }
      if (-not ($settings -is [pscustomobject])) { throw 'Refusing to edit .claude/settings.json because root is not an object' }
    }
    if ($null -eq $settings) { $settings = [pscustomobject]@{} }
    $changed = $false
    $changed = (Add-HookEvent $settings 'PreToolUse' (New-HookEntry '.claude/hooks/readsubagent-nudge.ps1' 'nudge' 'Read') 'readsubagent-nudge.ps1' 'nudge') -or $changed
    $changed = (Add-HookEvent $settings 'PreToolUse' (New-HookEntry '.claude/hooks/block-explore-subagent.ps1' '' 'Agent|Task') 'block-explore-subagent.ps1' '') -or $changed
    $changed = (Add-HookEvent $settings 'UserPromptSubmit' (New-HookEntry '.claude/hooks/readsubagent-nudge.ps1' 'reset' '') 'readsubagent-nudge.ps1' 'reset') -or $changed
    New-Item -ItemType Directory -Force -Path (Split-Path $settingsJson -Parent) | Out-Null
    [System.IO.File]::WriteAllText($settingsJson, ($settings | ConvertTo-Json -Depth 10) + "`n")
    if ($changed) { return 'merged readsubagent hooks into .claude/settings.json' }
    return 'readsubagent hooks already present in .claude/settings.json'
  }

  $actions = New-Object System.Collections.Generic.List[string]
  $actions.Add((Install-OwnedFile $relAgent $agentTarget $agentTmp))
  $actions.Add((Install-OwnedFile $relServer $serverTarget $serverTmp))
  if ($skipHooks) {
    $actions.Add('skipped Claude readsubagent hook files')
  } else {
    $actions.Add((Install-OwnedFile $relHookNudgeSh $hookNudgeShTarget $hookNudgeShTmp))
    $actions.Add((Install-OwnedFile $relHookBlockExploreSh $hookBlockExploreShTarget $hookBlockExploreShTmp))
    $actions.Add((Install-OwnedFile $relHookNudge $hookNudgeTarget $hookNudgeTmp))
    $actions.Add((Install-OwnedFile $relHookBlockExplore $hookBlockExploreTarget $hookBlockExploreTmp))
  }
  if ($skipSkill) {
    $actions.Add('skipped Claude readsubagent skill')
  } else {
    $actions.Add((Install-OwnedFile $relSkill $skillTarget $skillTmp))
  }
  $actions.Add((Add-SettingsHooks))

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
    $ownedFiles = @($relAgent, $relServer)
    if (-not $skipHooks) { $ownedFiles += @($relHookNudgeSh, $relHookBlockExploreSh, $relHookNudge, $relHookBlockExplore) }
    if (-not $skipSkill) { $ownedFiles += $relSkill }
    $fileHashes = [ordered]@{}
    foreach ($rel in $ownedFiles) { $fileHashes[$rel] = Get-FileSha256 (Join-Path $projectDir $rel) }
    $managedBlocks = @()
    if (-not $skipClaudeMd) { $managedBlocks += 'CLAUDE.md:zz-claude-readsubagent' }
    $managedSettings = @()
    if (-not $skipHooks) { $managedSettings += '.claude/settings.json:readsubagent-hooks' }
    $managedServers = @()
    if (-not $skipMcp) { $managedServers += $serverName }
    $state = [ordered]@{
      installer        = 'zz-claude-readsubagent'
      schemaVersion    = 1
      source_url       = $agentSourceBase
      mcp_source_url   = $mcpSourceBase
      owned_files      = $ownedFiles
      managed_blocks   = $managedBlocks
      managed_settings = $managedSettings
      managed_servers  = $managedServers
      file_hashes      = $fileHashes
      server           = [ordered]@{
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
