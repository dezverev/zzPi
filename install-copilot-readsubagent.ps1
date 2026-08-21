# zz Copilot readsubagent - repo-local installer for Windows.
#   cd C:\path\to\repo
#   irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-copilot-readsubagent.ps1 | iex
#
# GitHub Copilot CLI wrapper around the harness-neutral zz-readsubagent-mcp server.
# Installs a Copilot skill, the MCP server at
# .\.zz-mcp\zz-readsubagent-mcp.py, registers zz_readsubagent in
# .\.mcp.json, and adds .\.github\copilot-instructions.md guidance. The
# MCP server spawns a headless `pi` child on a local Qwen model (via LM Studio).

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
  --skip-mcp                 Do not add/update the zz_readsubagent server in .mcp.json.
  --skip-instructions        Do not add/update .github/copilot-instructions.md guidance.
  --skip-copilot-instructions
                              Alias for --skip-instructions.
  --skip-skill               Do not install/update the Copilot readsubagent skill.
  --skip-hooks               Do not install/update Copilot CLI readsubagent hooks.
  --force                    Claim/overwrite existing or locally modified managed files/entries.
  --dry-run                  Show the install plan without writing files.
  -h, --help                 Show this help.

Environment:
  ZZ_DASH_URL                           Website host (default: https://raw.githubusercontent.com/dezverev/zzPi/main)
  ZZ_READSUBAGENT_MCP_URL               MCP server source URL (default: $ZZ_DASH_URL/zz-readsubagent-mcp)
  ZZ_COPILOT_READSUBAGENT_URL           Skill/hooks source URL (default: $ZZ_DASH_URL/copilot-readsubagent)
  ZZ_COPILOT_READSUBAGENT_PROJECT_DIR   Target repo/project dir
  ZZ_COPILOT_READSUBAGENT_MODEL         pi model selector
  ZZ_COPILOT_READSUBAGENT_PI_BIN        pi executable name/path
  ZZ_COPILOT_READSUBAGENT_SKIP_MCP=1
  ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS=1
  ZZ_COPILOT_READSUBAGENT_SKIP_SKILL=1
  ZZ_COPILOT_READSUBAGENT_SKIP_HOOKS=1
  ZZ_COPILOT_READSUBAGENT_FORCE=1
  ZZ_COPILOT_READSUBAGENT_DRY_RUN=1
  ZZ_COPILOT_READSUBAGENT_ALLOW_SUBDIR=1

Requires `pi` on PATH with the LM Studio (lm-studio) provider available so the
model selector resolves, and LM Studio reachable. In Copilot CLI, trust the
project when prompted so its repo-local MCP server and hooks can load.
'@
}

$defaultHost = 'https://raw.githubusercontent.com/dezverev/zzPi/main'
$hostBase = if ($env:ZZ_DASH_URL) { $env:ZZ_DASH_URL.TrimEnd('/') } else { $defaultHost }
$mcpSourceBase = if ($env:ZZ_READSUBAGENT_MCP_URL) { $env:ZZ_READSUBAGENT_MCP_URL.TrimEnd('/') } else { "$hostBase/zz-readsubagent-mcp" }
$sourceBase = if ($env:ZZ_COPILOT_READSUBAGENT_URL) { $env:ZZ_COPILOT_READSUBAGENT_URL.TrimEnd('/') } else { "$hostBase/copilot-readsubagent" }
$projectDir = if ($env:ZZ_COPILOT_READSUBAGENT_PROJECT_DIR) { $env:ZZ_COPILOT_READSUBAGENT_PROJECT_DIR } else { (Get-Location).Path }
$model = if ($env:ZZ_COPILOT_READSUBAGENT_MODEL) { $env:ZZ_COPILOT_READSUBAGENT_MODEL } else { 'lm-studio/qwen/qwen3.6-35b-a3b' }
$piBin = if ($env:ZZ_COPILOT_READSUBAGENT_PI_BIN) { $env:ZZ_COPILOT_READSUBAGENT_PI_BIN } else { 'pi' }
$skipMcp = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_SKIP_MCP
$skipInstructions = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_SKIP_INSTRUCTIONS
$skipSkill = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_SKIP_SKILL
$skipHooks = Test-Truthy $env:ZZ_COPILOT_READSUBAGENT_SKIP_HOOKS
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
    '^--skip-skill$' { $skipSkill = $true; continue }
    '^--skip-hooks$' { $skipHooks = $true; continue }
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
  $skillTmp = Join-Path $tmpDir 'SKILL.md'
  $hookConfigTmp = Join-Path $tmpDir 'zz-readsubagent.json'
  $hookNudgeShTmp = Join-Path $tmpDir 'readsubagent-nudge.sh'
  $hookNudgePs1Tmp = Join-Path $tmpDir 'readsubagent-nudge.ps1'
  $hookBlockShTmp = Join-Path $tmpDir 'block-explore-subagent.sh'
  $hookBlockPs1Tmp = Join-Path $tmpDir 'block-explore-subagent.ps1'
  $serverTmp = Join-Path $tmpDir 'zz-readsubagent-mcp.py'
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/skills/readsubagent/SKILL.md" -OutFile $skillTmp
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/hooks/zz-readsubagent.json" -OutFile $hookConfigTmp
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/hooks/readsubagent-nudge.sh" -OutFile $hookNudgeShTmp
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/hooks/readsubagent-nudge.ps1" -OutFile $hookNudgePs1Tmp
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/hooks/block-explore-subagent.sh" -OutFile $hookBlockShTmp
  Invoke-WebRequest -UseBasicParsing -Uri "$sourceBase/hooks/block-explore-subagent.ps1" -OutFile $hookBlockPs1Tmp
  Invoke-WebRequest -UseBasicParsing -Uri "$mcpSourceBase/zz-readsubagent-mcp.py" -OutFile $serverTmp

  $serverName = 'zz_readsubagent'
  $serverArgsPath = '.zz-mcp/zz-readsubagent-mcp.py'
  $obsoleteAgent = '.github/agents/readsubagent.agent.md'
  $relSkill = '.github/skills/readsubagent/SKILL.md'
  $relHookConfig = '.github/hooks/zz-readsubagent.json'
  $relHookNudgeSh = '.github/hooks/readsubagent-nudge.sh'
  $relHookNudgePs1 = '.github/hooks/readsubagent-nudge.ps1'
  $relHookBlockSh = '.github/hooks/block-explore-subagent.sh'
  $relHookBlockPs1 = '.github/hooks/block-explore-subagent.ps1'
  $relServer = '.zz-mcp/zz-readsubagent-mcp.py'
  $obsoleteAgentTarget = Join-Path $projectDir '.github\agents\readsubagent.agent.md'
  $skillTarget = Join-Path $projectDir '.github\skills\readsubagent\SKILL.md'
  $hookConfigTarget = Join-Path $projectDir '.github\hooks\zz-readsubagent.json'
  $hookNudgeShTarget = Join-Path $projectDir '.github\hooks\readsubagent-nudge.sh'
  $hookNudgePs1Target = Join-Path $projectDir '.github\hooks\readsubagent-nudge.ps1'
  $hookBlockShTarget = Join-Path $projectDir '.github\hooks\block-explore-subagent.sh'
  $hookBlockPs1Target = Join-Path $projectDir '.github\hooks\block-explore-subagent.ps1'
  $serverTarget = Join-Path $projectDir '.zz-mcp\zz-readsubagent-mcp.py'
  $mcpJson = Join-Path $projectDir '.mcp.json'
  $instructionsMd = Join-Path $projectDir '.github\copilot-instructions.md'
  $manifestPath = Join-Path $projectDir '.github\zz-copilot-readsubagent-manifest.json'

  $markerStart = '<!-- zz-copilot-readsubagent:start -->'
  $markerEnd = '<!-- zz-copilot-readsubagent:end -->'
  $copilotBlock = @'
<!-- zz-copilot-readsubagent:start -->
## Read Planning

Before doing focused reads of specific implementation files, start with a
read-planning pass through `readsubagent`. It delegates to a local model via
`pi` and returns a concise factual report with paths and line ranges.

Use the `readsubagent` skill. The skill calls the direct
`zz_readsubagent/readsubagent` MCP tool; do not launch another Copilot custom
agent.

If the user asks to test, smoke-check, verify, or diagnose readsubagent itself,
make one small factual MCP call immediately and report whether it succeeded; do
not ask the user to invent another test prompt.

Pass `question` plus any of
`path`/`paths`, `symbols`, `searchTerms`, `lineRanges`, `output`, and
`maxReportChars` to scope the inspection.

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

  function Get-ManifestHash([string]$rel) {
    if (-not (Test-Path $manifestPath)) { return '' }
    try {
      $state = Get-Content $manifestPath -Raw | ConvertFrom-Json
      $property = $state.file_hashes.PSObject.Properties[$rel]
      if ($null -ne $property) { return [string]$property.Value }
    } catch { return '' }
    return ''
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

  function Test-OwnedFile([string]$rel, [string]$target, [string]$tmp) {
    if (-not (Test-Path $target) -or $force) { return $false }
    $same = (Get-FileSha256 $target) -eq (Get-FileSha256 $tmp)
    $owned = Get-ManifestOwns $rel
    if (-not $owned -and -not $same) {
      throw "Refusing to overwrite existing unowned $rel. Use --force if you want this installer to claim it."
    }
    $expectedHash = Get-ManifestHash $rel
    if ($owned -and -not $expectedHash) {
      throw "Cannot verify ownership baseline for managed $rel. Use --force to replace it."
    }
    if ($owned -and (Get-FileSha256 $target) -ne $expectedHash -and -not $same) {
      throw "Refusing to overwrite locally modified managed $rel. Use --force to replace it."
    }
    return $same
  }

  function Install-OwnedFile([string]$rel, [string]$target, [string]$tmp, [bool]$executable = $false) {
    if (Test-OwnedFile $rel $target $tmp) {
      if ($executable -and -not $dryRun -and $env:OS -ne 'Windows_NT') { & chmod +x -- $target }
      return "unchanged existing matching $rel"
    }
    if ($dryRun) {
      $verb = if (Test-Path $target) { 'update' } else { 'create' }
      return "would $verb $rel"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -Force -Path $tmp -Destination $target
    if ($executable -and $env:OS -ne 'Windows_NT') { & chmod +x -- $target }
    return "installed $rel"
  }

  function New-ServerEntry([string]$entryModel, [string]$entryPiBin) {
    $envBlock = [ordered]@{ ZZ_READSUBAGENT_MODEL = $entryModel }
    if ($entryPiBin -ne 'pi') { $envBlock['ZZ_READSUBAGENT_PI_BIN'] = $entryPiBin }
    return [pscustomobject][ordered]@{
      type = 'local'; command = 'python3'; args = @($serverArgsPath); env = [pscustomobject]$envBlock; tools = @('readsubagent')
    }
  }

  function Test-ServerEntryMatches([object]$entry, [string]$expectedModel, [string]$expectedPiBin) {
    if (-not ($entry -is [pscustomobject])) { return $false }
    $entryNames = @($entry.PSObject.Properties.Name | Sort-Object)
    if ((Compare-Object $entryNames @('args', 'command', 'env', 'tools', 'type')).Count -ne 0) { return $false }
    if ($entry.type -ne 'local' -or $entry.command -ne 'python3') { return $false }
    if (@($entry.tools).Count -ne 1 -or @($entry.tools)[0] -ne 'readsubagent') { return $false }
    if (@($entry.args).Count -ne 1 -or @($entry.args)[0] -ne $serverArgsPath) { return $false }
    if (-not ($entry.env -is [pscustomobject])) { return $false }
    $expectedEnvNames = @('ZZ_READSUBAGENT_MODEL')
    if ($expectedPiBin -ne 'pi') { $expectedEnvNames += 'ZZ_READSUBAGENT_PI_BIN' }
    $envNames = @($entry.env.PSObject.Properties.Name | Sort-Object)
    if ((Compare-Object $envNames @($expectedEnvNames | Sort-Object)).Count -ne 0) { return $false }
    if ($entry.env.ZZ_READSUBAGENT_MODEL -ne $expectedModel) { return $false }
    if ($expectedPiBin -ne 'pi' -and $entry.env.ZZ_READSUBAGENT_PI_BIN -ne $expectedPiBin) { return $false }
    return $true
  }

  function Test-ManagedMcpEntry([object]$servers) {
    if ($force -or -not (Get-ManagedServer $serverName)) { return }
    try {
      $state = Get-Content $manifestPath -Raw | ConvertFrom-Json
      $priorModel = [string]$state.server.model
      $priorPiBin = [string]$state.server.pi_bin
      if (-not $priorPiBin) { $priorPiBin = 'pi' }
    } catch { $priorModel = ''; $priorPiBin = '' }
    if (-not $priorModel) { throw "Cannot verify legacy ownership of $serverName in .mcp.json. Use --force to replace it." }
    if (-not ($servers.PSObject.Properties.Name -contains $serverName) -or -not (Test-ServerEntryMatches $servers.$serverName $priorModel $priorPiBin)) {
      throw "Refusing to overwrite locally modified managed $serverName server in .mcp.json. Use --force to replace it."
    }
  }

  function Test-TargetParent([string]$target) {
    $parent = Split-Path $target -Parent
    while ($parent -and $parent.TrimEnd('\') -ne $projectDir.TrimEnd('\')) {
      if (Test-Path $parent) {
        if (-not (Test-Path $parent -PathType Container)) { throw "Refusing to install because $parent is not a directory" }
        return
      }
      $parent = Split-Path $parent -Parent
    }
  }

  function Test-InstallerConfiguration {
    foreach ($target in @($serverTarget, $manifestPath)) { Test-TargetParent $target }
    if ((Test-Path $manifestPath) -and -not (Test-Path $manifestPath -PathType Leaf)) { throw 'Refusing to write Copilot manifest because its path is not a file' }
    if (-not $skipSkill) { Test-TargetParent $skillTarget }
    if (-not $skipHooks) {
      foreach ($target in @($hookConfigTarget, $hookNudgeShTarget, $hookNudgePs1Target, $hookBlockShTarget, $hookBlockPs1Target)) { Test-TargetParent $target }
    }
    if (-not $skipInstructions) {
      Test-TargetParent $instructionsMd
      if (Test-Path $instructionsMd) {
        if (-not (Test-Path $instructionsMd -PathType Leaf)) { throw 'Refusing to edit .github/copilot-instructions.md because it is not a file' }
        $text = Get-Content $instructionsMd -Raw
        $starts = ([regex]::Matches($text, [regex]::Escape($markerStart))).Count
        $ends = ([regex]::Matches($text, [regex]::Escape($markerEnd))).Count
        if ($starts -ne $ends -or $starts -gt 1) { throw 'Refusing to edit .github/copilot-instructions.md because managed markers are malformed or duplicated' }
      }
    }
    if (-not $skipMcp) { Test-TargetParent $mcpJson }
    if (-not $skipMcp -and (Test-Path $mcpJson)) {
      $raw = Get-Content $mcpJson -Raw
      if (-not $raw.TrimStart().StartsWith('{')) { throw 'Refusing to edit .mcp.json because root is not an object' }
      try { $data = $raw | ConvertFrom-Json } catch { throw "Refusing to edit malformed .mcp.json: $_" }
      if (-not ($data -is [pscustomobject])) { throw 'Refusing to edit .mcp.json because root is not an object' }
      if ($data.PSObject.Properties.Name -contains 'mcpServers' -and $null -ne $data.mcpServers -and -not ($data.mcpServers -is [pscustomobject])) {
        throw 'Refusing to edit .mcp.json because mcpServers is not an object'
      }
      if ($null -ne $data.mcpServers) { Test-ManagedMcpEntry $data.mcpServers }
    }
  }

  $preflightFiles = @(
    [pscustomobject]@{ Rel = $relServer; Target = $serverTarget; Tmp = $serverTmp }
  )
  if (-not $skipSkill) { $preflightFiles += [pscustomobject]@{ Rel = $relSkill; Target = $skillTarget; Tmp = $skillTmp } }
  if (-not $skipHooks) {
    $preflightFiles += @(
      [pscustomobject]@{ Rel = $relHookConfig; Target = $hookConfigTarget; Tmp = $hookConfigTmp }
      [pscustomobject]@{ Rel = $relHookNudgeSh; Target = $hookNudgeShTarget; Tmp = $hookNudgeShTmp }
      [pscustomobject]@{ Rel = $relHookNudgePs1; Target = $hookNudgePs1Target; Tmp = $hookNudgePs1Tmp }
      [pscustomobject]@{ Rel = $relHookBlockSh; Target = $hookBlockShTarget; Tmp = $hookBlockShTmp }
      [pscustomobject]@{ Rel = $relHookBlockPs1; Target = $hookBlockPs1Target; Tmp = $hookBlockPs1Tmp }
    )
  }
  foreach ($item in $preflightFiles) { [void](Test-OwnedFile $item.Rel $item.Target $item.Tmp) }
  Test-InstallerConfiguration

  $mcpManagedThisRun = $false
  $actions = New-Object System.Collections.Generic.List[string]
  if (Test-Path $obsoleteAgentTarget) {
    $prior = $null
    try { if (Test-Path $manifestPath) { $prior = Get-Content $manifestPath -Raw | ConvertFrom-Json } } catch { $prior = $null }
    if ($null -ne $prior -and @($prior.owned_files) -contains $obsoleteAgent) {
      $expected = $null
      if ($null -ne $prior.file_hashes) {
        $property = $prior.file_hashes.PSObject.Properties[$obsoleteAgent]
        if ($null -ne $property) { $expected = [string]$property.Value }
      }
      if ($expected -and (Get-FileSha256 $obsoleteAgentTarget) -ne $expected) {
        $actions.Add("preserved locally modified obsolete $obsoleteAgent")
      } elseif ($dryRun) {
        $actions.Add("would remove obsolete $obsoleteAgent")
      } else {
        Remove-Item -Force $obsoleteAgentTarget
        $actions.Add("removed obsolete $obsoleteAgent")
      }
    }
  }
  $actions.Add((Install-OwnedFile $relServer $serverTarget $serverTmp))
  if ($skipSkill) { $actions.Add('skipped Copilot readsubagent skill') }
  else { $actions.Add((Install-OwnedFile $relSkill $skillTarget $skillTmp)) }
  if ($skipHooks) { $actions.Add('skipped Copilot CLI readsubagent hooks') }
  else {
    $actions.Add((Install-OwnedFile $relHookConfig $hookConfigTarget $hookConfigTmp))
    $actions.Add((Install-OwnedFile $relHookNudgeSh $hookNudgeShTarget $hookNudgeShTmp $true))
    $actions.Add((Install-OwnedFile $relHookNudgePs1 $hookNudgePs1Target $hookNudgePs1Tmp))
    $actions.Add((Install-OwnedFile $relHookBlockSh $hookBlockShTarget $hookBlockShTmp $true))
    $actions.Add((Install-OwnedFile $relHookBlockPs1 $hookBlockPs1Target $hookBlockPs1Tmp))
  }

  if ($skipMcp) {
    $actions.Add('skipped .mcp.json registration')
  } else {
    $data = $null
    if (Test-Path $mcpJson) {
      $raw = Get-Content $mcpJson -Raw
      if (-not $raw.TrimStart().StartsWith('{')) { throw 'Refusing to edit .mcp.json because root is not an object' }
      try { $data = $raw | ConvertFrom-Json } catch { throw "Refusing to edit malformed .mcp.json: $_" }
    }
    if ($null -eq $data) { $data = [pscustomobject]@{} }
    if (-not ($data -is [pscustomobject])) { throw 'Refusing to edit .mcp.json because root is not an object' }
    if (-not ($data.PSObject.Properties.Name -contains 'mcpServers') -or $null -eq $data.mcpServers) {
      $data | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
    } elseif (-not ($data.mcpServers -is [pscustomobject])) {
      throw 'Refusing to edit .mcp.json because mcpServers is not an object'
    }
    Test-ManagedMcpEntry $data.mcpServers
    $existing = $data.mcpServers.PSObject.Properties.Name -contains $serverName
    $managed = Get-ManagedServer $serverName
    if ($existing -and -not $managed -and -not $force) {
      $actions.Add("preserved existing unmanaged $serverName server in .mcp.json")
    } elseif ($dryRun) {
      $verb = if ($existing) { 'update' } else { 'add' }
      $actions.Add("would $verb $serverName server in .mcp.json")
    } else {
      $entry = New-ServerEntry $model $piBin
      $data.mcpServers | Add-Member -NotePropertyName $serverName -NotePropertyValue $entry -Force
      $mcpManagedThisRun = $true
      New-Item -ItemType Directory -Force -Path (Split-Path $mcpJson -Parent) | Out-Null
      [System.IO.File]::WriteAllText($mcpJson, ($data | ConvertTo-Json -Depth 100) + "`n")
      $actions.Add("registered $serverName server in .mcp.json")
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
    $priorState = $null
    if (Test-Path $manifestPath) {
      try { $priorState = Get-Content $manifestPath -Raw | ConvertFrom-Json } catch { $priorState = $null }
    }
    $ownedFiles = @()
    if ($null -ne $priorState) { $ownedFiles += @($priorState.owned_files) }
    $ownedFiles = @($ownedFiles | Where-Object { $_ -ne $obsoleteAgent })
    $ownedFiles += $relServer
    if (-not $skipSkill) { $ownedFiles += $relSkill }
    if (-not $skipHooks) { $ownedFiles += @($relHookConfig, $relHookNudgeSh, $relHookNudgePs1, $relHookBlockSh, $relHookBlockPs1) }
    $ownedFiles = @($ownedFiles | Select-Object -Unique | Where-Object { Test-Path (Join-Path $projectDir $_) })
    $fileHashes = [ordered]@{}
    $refreshedFiles = @($relServer)
    if (-not $skipSkill) { $refreshedFiles += $relSkill }
    if (-not $skipHooks) { $refreshedFiles += @($relHookConfig, $relHookNudgeSh, $relHookNudgePs1, $relHookBlockSh, $relHookBlockPs1) }
    foreach ($rel in $ownedFiles) {
      $priorHash = $null
      if ($null -ne $priorState -and $null -ne $priorState.file_hashes) {
        $property = $priorState.file_hashes.PSObject.Properties[$rel]
        if ($null -ne $property) { $priorHash = [string]$property.Value }
      }
      if ((@($refreshedFiles) -contains $rel) -or -not $priorHash) { $fileHashes[$rel] = Get-FileSha256 (Join-Path $projectDir $rel) }
      else { $fileHashes[$rel] = $priorHash }
    }
    $managedBlocks = @(if ($skipInstructions) {
      if ($null -ne $priorState) { @($priorState.managed_blocks) }
    } else { '.github/copilot-instructions.md:zz-copilot-readsubagent' })
    $managedServers = @(if ($skipMcp -and $null -ne $priorState) {
      @($priorState.managed_servers)
    } elseif ($mcpManagedThisRun) { $serverName })
    $serverModel = $model; $serverPiBin = $piBin; $serverConfigPath = $mcpJson
    if ($skipMcp -and $null -ne $priorState -and $null -ne $priorState.server) {
      if ($priorState.server.model) { $serverModel = [string]$priorState.server.model }
      if ($priorState.server.pi_bin) { $serverPiBin = [string]$priorState.server.pi_bin }
      if ($priorState.server.config_path) { $serverConfigPath = [string]$priorState.server.config_path }
    }
    $state = [ordered]@{
      installer       = 'zz-copilot-readsubagent'
      schemaVersion   = 1
      source_url      = $sourceBase
      mcp_source_url  = $mcpSourceBase
      owned_files     = $ownedFiles
      managed_blocks  = $managedBlocks
      managed_servers = $managedServers
      file_hashes     = $fileHashes
      server          = [ordered]@{
        name = $serverName; model = $serverModel; pi_bin = $serverPiBin; config_path = $serverConfigPath
        managed = @($managedServers) -contains $serverName
      }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath -Parent) | Out-Null
    [System.IO.File]::WriteAllText($manifestPath, ($state | ConvertTo-Json -Depth 100) + "`n")
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
  Write-Host "  -> source: $sourceBase"
  Write-Host "  -> MCP source: $mcpSourceBase"
  if (-not $dryRun) {
    Write-Host '  -> start Copilot CLI in this repo and approve folder trust so the MCP server and hooks can load'
  }
  if ($piWarning) { Write-Host "  -> $piWarning" -ForegroundColor Yellow }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmpDir
}
