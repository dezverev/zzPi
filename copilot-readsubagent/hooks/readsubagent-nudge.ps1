param([string]$Mode = 'nudge')
$ErrorActionPreference = 'SilentlyContinue'
$body = [Console]::In.ReadToEnd()
$obj = $null
try { $obj = $body | ConvertFrom-Json -ErrorAction Stop } catch {}
$sid = if ($obj.sessionId) { [string]$obj.sessionId } elseif ($obj.session_id) { [string]$obj.session_id } else { 'default' }
$stateRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$stateDir = Join-Path $stateRoot 'copilot-readsubagent-nudge'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$sentinel = Join-Path $stateDir "$sid.nudged"
if ($Mode -eq 'reset') { Remove-Item -Force -ErrorAction SilentlyContinue $sentinel; exit 0 }
if (Test-Path $sentinel) { exit 0 }
$file = ''
if ($obj.toolArgs) {
  foreach ($name in @('path', 'filePath', 'file_path')) {
    $prop = $obj.toolArgs.PSObject.Properties[$name]
    if ($null -ne $prop -and $prop.Value) { $file = [string]$prop.Value; break }
  }
}
if (-not $file -or $file -notmatch '\.(rs|ts|tsx|js|mjs|cjs|py)$') { exit 0 }
New-Item -ItemType File -Force -Path $sentinel | Out-Null
@{
  additionalContext = 'Read-planning reminder: outside debugging, before focused reads of unfamiliar implementation files, scout the area FIRST with readsubagent—use the readsubagent skill, which calls zz_readsubagent/readsubagent directly—for a subsystem map and the smallest focused read list. Ignore this scouting nudge during debugging or failure investigation; inspect logs, traces, failure output, and other diagnostic or root-cause evidence directly in the main agent or use the debugger. Otherwise, ignore this if you already scouted here or are re-reading a known file.'
} | ConvertTo-Json -Compress
