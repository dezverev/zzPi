# Block Claude Code's Explore subagent; steer factual scouting to readsubagent.
# Blocking: denies only subagent_type = Explore. All other subagents proceed.

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

$sub = Get-JsonValue $obj @('tool_input', 'subagent_type')
if (-not $sub) { $sub = Get-RegexValue $body 'subagent_type' }

if ($sub -ne 'Explore') { exit 0 }

Write-Output '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The Explore subagent is disabled by this project readsubagent setup — it is exactly what the readsubagent tooling replaces (see CLAUDE.md Read Planning). For non-debug factual scouting/read planning only, use readsubagent for a subsystem map, the smallest focused read list, and symbol/line anchors: use the readsubagent skill, which calls mcp__zz_readsubagent__readsubagent directly (pass question plus path/paths/symbols/searchTerms/lineRanges). During debugging or failure investigation, do not use readsubagent: inspect source, logs, traces, failure output, and other diagnostic or root-cause evidence directly in the main agent or use the debugger. For fan-out that genuinely needs judgment or edits rather than factual reading, use a general-purpose or Plan agent — not Explore."}}'
exit 0
