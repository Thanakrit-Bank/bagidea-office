# Point the Claude Code hook settings at THIS install, WITHOUT dropping hooks
# that anything else (office plugins) has registered.
#
# The committed .claude/settings.json files carry the dev machine's ABSOLUTE
# paths (e.g. E:\Projects\...). On a user's machine those paths don't exist, so
# the PreToolUse permission hook (Security Center) and the task hooks (Mission
# Control feed) silently never fire. install.ps1 calls this after the clone and
# update.ps1 calls it after every git pull, so the hooks always resolve to the
# real install directory. Mirrors what build-mac.sh does for macOS/Linux.
#
# It used to rebuild both files from scratch, which wiped every plugin hook on
# each `bagidea update` (studio-lease PreToolUse, run-clock PostToolUse were
# lost this way on 2026-09-24). It now MERGES: the existing file is read, every
# entry it holds is kept in place, and only the entries this installer owns
# (daemon\hook.ps1 per task type, daemon\perm.ps1) are added or refreshed,
# deduped on the script path inside the command.
param([Parameter(Mandatory = $true)][string]$App)

$ErrorActionPreference = "Stop"

$hookScript = Join-Path $App "daemon\hook.ps1"
$permScript = Join-Path $App "daemon\perm.ps1"

function HookCmd([string]$script, [string]$arg) {
  $c = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$script`""
  if ($arg) { $c += " -Type $arg" }
  return $c
}

# One hook entry as Claude Code expects it: { "hooks": [ { type, command } ] }.
function NewEntry([string]$command, $timeout) {
  $h = [ordered]@{ type = "command"; command = $command }
  if ($timeout) { $h["timeout"] = $timeout }
  return [ordered]@{ hooks = @($h) }
}

# ConvertFrom-Json hands back PSCustomObject trees; turn the whole thing into
# ordered hashtables so entries can be edited and written back in their order,
# with every key we don't know about carried over untouched.
function ConvertTo-Map($node) {
  if ($null -eq $node) { return $null }
  if ($node -is [string] -or $node -is [ValueType]) { return $node }
  if ($node -is [System.Collections.IDictionary]) {
    $m = [ordered]@{}
    foreach ($k in @($node.Keys)) { $m[[string]$k] = ConvertTo-Map $node[$k] }
    return $m
  }
  if ($node -is [System.Collections.IEnumerable]) {
    $list = New-Object System.Collections.ArrayList
    foreach ($i in $node) { [void]$list.Add((ConvertTo-Map $i)) }
    return , $list.ToArray()
  }
  if ($node.PSObject -and $node.PSObject.Properties) {
    $m = [ordered]@{}
    foreach ($p in $node.PSObject.Properties) { $m[$p.Name] = ConvertTo-Map $p.Value }
    return $m
  }
  return $node
}

# Commands are compared on the script path only: separators differ (/ vs \) and
# JSON written by other tools often carries doubled backslashes.
function NormalizePath([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return "" }
  $t = $s -replace '/', '\'
  while ($t -match '\\\\') { $t = $t -replace '\\\\', '\' }
  return $t.ToLowerInvariant()
}

function EntryCommands($entry) {
  $out = @()
  if ($entry -is [System.Collections.IDictionary] -and $entry.Contains('hooks')) {
    foreach ($h in @($entry['hooks'])) {
      if ($h -is [System.Collections.IDictionary] -and $h.Contains('command')) {
        $out += [string]$h['command']
      }
    }
  }
  return , $out
}

# Replace the installer's own entry for this event in place, or append it when
# the file has never seen it. Everything else in the event keeps its position.
function SetOwnedHook($settings, [string]$eventName, [string[]]$markers, $newEntry) {
  if (-not $settings.Contains('hooks') -or $settings['hooks'] -isnot [System.Collections.IDictionary]) {
    $settings['hooks'] = [ordered]@{}
  }
  $hooks = $settings['hooks']

  $list = @()
  if ($hooks.Contains($eventName) -and $null -ne $hooks[$eventName]) { $list = @($hooks[$eventName]) }

  $needles = @()
  foreach ($m in $markers) { $needles += (NormalizePath $m) }

  $idx = -1
  for ($i = 0; $i -lt $list.Count; $i++) {
    foreach ($cmd in (EntryCommands $list[$i])) {
      $n = NormalizePath $cmd
      $hit = $true
      foreach ($needle in $needles) { if (-not $n.Contains($needle)) { $hit = $false } }
      if ($hit) { $idx = $i; break }
    }
    if ($idx -ge 0) { break }
  }

  if ($idx -ge 0) { $list[$idx] = $newEntry } else { $list += $newEntry }
  $hooks[$eventName] = $list
}

function ReadSettings([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return [ordered]@{} }
  $raw = ""
  try { $raw = [System.IO.File]::ReadAllText($path) } catch { $raw = "" }
  if ([string]::IsNullOrWhiteSpace($raw)) { return [ordered]@{} }
  try {
    $parsed = $raw | ConvertFrom-Json
  }
  catch {
    # Never silently throw away a file we cannot parse: keep it beside the
    # original, then fall back to writing a fresh set of hooks.
    $bad = "$path.broken-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    try { Copy-Item -LiteralPath $path -Destination $bad -Force } catch {}
    Write-Warning "wire-hooks: $path is not valid JSON - a copy was kept at $bad and the hooks were rebuilt from scratch."
    return [ordered]@{}
  }
  $map = ConvertTo-Map $parsed
  if ($map -isnot [System.Collections.IDictionary]) { return [ordered]@{} }
  return $map
}

function Write-JsonNoBom([string]$path, $obj) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $json = $obj | ConvertTo-Json -Depth 20
  $old = $null
  if (Test-Path -LiteralPath $path) { try { $old = [System.IO.File]::ReadAllText($path) } catch { $old = $null } }
  if ($old -eq $json) { return }
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$rootPath = Join-Path $App ".claude\settings.json"
$wsPath = Join-Path $App "workspace\.claude\settings.json"

$root = ReadSettings $rootPath
SetOwnedHook $root "UserPromptSubmit" @("daemon\hook.ps1", "-Type task.started")   (NewEntry (HookCmd $hookScript "task.started") $null)
SetOwnedHook $root "PostToolUse"      @("daemon\hook.ps1", "-Type task.progress")  (NewEntry (HookCmd $hookScript "task.progress") $null)
SetOwnedHook $root "Stop"             @("daemon\hook.ps1", "-Type task.completed") (NewEntry (HookCmd $hookScript "task.completed") $null)
Write-JsonNoBom $rootPath $root

$ws = ReadSettings $wsPath
SetOwnedHook $ws "PreToolUse" @("daemon\perm.ps1") (NewEntry (HookCmd $permScript $null) 60)
Write-JsonNoBom $wsPath $ws
