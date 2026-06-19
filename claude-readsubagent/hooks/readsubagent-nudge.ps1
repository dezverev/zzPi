param([string]$Mode = 'nudge')
# Read-planning nudge for Claude Code projects with zz readsubagent installed.
# Non-blocking: emits additional context on the first implementation-file Read
# per turn (or per subagent), then lets the read proceed.

$ErrorActionPreference = 'SilentlyContinue'
$body = [Console]::In.ReadToEnd()

function Get-JsonValue([object]$obj, [string[]]$path) {
  $cur = $obj
  foreach ($part in $path) {
    if ($null -eq $cur) { return '' }
    $prop = $cur.PSObject.Properties[$part]
    if ($null -eq $prop) { return '' }
    $cur = $prop.Value
  }
  if ($null -eq $cur) { return '' }
  return [string]$cur
}

function Get-RegexValue([string]$text, [string]$name) {
  $m = [regex]::Match($text, '"' + [regex]::Escape($name) + '"\s*:\s*"([^"]*)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

$obj = $null
try { $obj = $body | ConvertFrom-Json -ErrorAction Stop } catch { $obj = $null }

$sid = Get-JsonValue $obj @('session_id')
if (-not $sid) { $sid = Get-RegexValue $body 'session_id' }
if (-not $sid) { $sid = 'default' }

$stateRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$stateDir = Join-Path $stateRoot 'claude-readsubagent-nudge'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$sentinel = Join-Path $stateDir "$sid.nudged"

if ($Mode -eq 'reset') {
  Remove-Item -Force -ErrorAction SilentlyContinue $sentinel
  exit 0
}

$aid = Get-JsonValue $obj @('agent_id')
if (-not $aid) { $aid = Get-RegexValue $body 'agent_id' }
if ($aid) { $sentinel = Join-Path $stateDir "agent-$aid.nudged" }

if (Test-Path $sentinel) { exit 0 }

$file = Get-JsonValue $obj @('tool_input', 'file_path')
if (-not $file) { $file = Get-RegexValue $body 'file_path' }
if (-not $file) { exit 0 }

if ($file -notmatch '\.(rs|ts|tsx|js|mjs|cjs|py)$') { exit 0 }

New-Item -ItemType File -Force -Path $sentinel | Out-Null
Write-Output '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Read-planning reminder: before focused reads of unfamiliar implementation files, scout the area FIRST with readsubagent — use the readsubagent skill/subagent, or call mcp__zz_readsubagent__readsubagent directly when you already know the targets — for a subsystem map and the smallest focused read list, then read against those anchors. Ignore this if you''ve already scouted here or are re-reading a known file."}}'
exit 0
