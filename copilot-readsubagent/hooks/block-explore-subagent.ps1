$ErrorActionPreference = 'SilentlyContinue'
$body = [Console]::In.ReadToEnd()
$obj = $null
try { $obj = $body | ConvertFrom-Json -ErrorAction Stop } catch {}
$sub = ''
if ($obj.toolArgs) {
  foreach ($name in @('agentName', 'agent_name', 'agentType', 'agent_type', 'subagent_type')) {
    $prop = $obj.toolArgs.PSObject.Properties[$name]
    if ($null -ne $prop -and $prop.Value) { $sub = [string]$prop.Value; break }
  }
}
if ($sub.ToLowerInvariant() -ne 'explore') { exit 0 }
@{
  permissionDecision = 'deny'
  permissionDecisionReason = 'The built-in explore subagent is disabled by this project readsubagent setup. For non-debug factual scouting/read planning only, use the readsubagent skill for subsystem maps, focused read lists, and symbol/line anchors; it calls zz_readsubagent/readsubagent directly. During debugging or failure investigation, do not use readsubagent: inspect source, logs, traces, failure output, and other diagnostic or root-cause evidence directly in the main agent or use the debugger. Use another agent only when the task genuinely needs judgment or edits.'
} | ConvertTo-Json -Compress
