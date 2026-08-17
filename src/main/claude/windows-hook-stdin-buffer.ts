import { MANAGED_HOOK_TIMEOUT_MILLISECONDS } from '../agent-hooks/installer-utils'

export const WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV = 'ORCA_AGENT_HOOK_PAYLOAD_FILE'
export const WINDOWS_CLAUDE_HOOK_DESCENDANT_BUDGET_MILLISECONDS = 3_000
export const WINDOWS_CLAUDE_HOOK_STDIN_TOTAL_TIMEOUT_MILLISECONDS =
  MANAGED_HOOK_TIMEOUT_MILLISECONDS - WINDOWS_CLAUDE_HOOK_DESCENDANT_BUDGET_MILLISECONDS
// Why: the listener rejects request bodies above the same 1 MB ceiling.
export const WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES = 1_000_000

// Why (#13285): providers can leave hook stdin open after writing JSON, so EOF is not a safe boundary.
// Why: compact PowerShell names keep EncodedCommand below cmd.exe's 8,191-character ceiling.
export function buildWindowsClaudeHookStdinBuffer(scriptInvocation: string): string {
  return [
    "if (-not $env:ORCA_PANE_KEY) { Write-Output '{}'; exit 0 }",
    '$a = $env:ORCA_AGENT_HOOK_ENDPOINT -and [System.IO.File]::Exists($env:ORCA_AGENT_HOOK_ENDPOINT)',
    "if ((-not $env:ORCA_AGENT_HOOK_PORT -or -not $env:ORCA_AGENT_HOOK_TOKEN) -and -not $a) { Write-Output '{}'; exit 0 }",
    '$i = [Console]::OpenStandardInput()',
    '$p = New-Object System.IO.MemoryStream',
    '$b = New-Object byte[] 8192',
    '$s = $false',
    '$d = 0',
    '$q = $false',
    '$e = $false',
    '$c = $false',
    '$x = $false',
    '$w = [System.Diagnostics.Stopwatch]::StartNew()',
    'try {',
    `  while (-not $c -and $p.Length -lt ${WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES} -and $w.ElapsedMilliseconds -lt ${WINDOWS_CLAUDE_HOOK_STDIN_TOTAL_TIMEOUT_MILLISECONDS}) {`,
    `    $m = ${WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES} - [int]$p.Length`,
    `    $u = ${WINDOWS_CLAUDE_HOOK_STDIN_TOTAL_TIMEOUT_MILLISECONDS} - [int]$w.ElapsedMilliseconds`,
    '    $t = New-Object System.Threading.CancellationTokenSource',
    '    try {',
    '      $r = $i.ReadAsync($b, 0, [Math]::Min($b.Length, $m), $t.Token)',
    '      if (-not $r.Wait($u)) { $t.Cancel(); break }',
    '      $n = $r.Result',
    '    } finally {',
    '      $t.Dispose()',
    '    }',
    '    if ($n -eq 0) { break }',
    '    $p.Write($b, 0, $n)',
    '    for ($j = 0; $j -lt $n; $j += 1) {',
    '      $v = $b[$j]',
    '      if (-not $s) {',
    '        if ($v -eq 0x7b) { $s = $true; $d = 1 }',
    '        elseif ($v -gt 0x20 -and $v -ne 0xef -and $v -ne 0xbb -and $v -ne 0xbf) { $x = $true; break }',
    '      } elseif ($q) {',
    '        if ($e) { $e = $false }',
    '        elseif ($v -eq 0x5c) { $e = $true }',
    '        elseif ($v -eq 0x22) { $q = $false }',
    '      } elseif ($v -eq 0x22) {',
    '        $q = $true',
    '      } elseif ($v -eq 0x7b -or $v -eq 0x5b) {',
    '        $d += 1',
    '      } elseif ($v -eq 0x7d -or $v -eq 0x5d) {',
    '        $d -= 1',
    '        if ($d -eq 0) { $c = $true; break }',
    '        if ($d -lt 0) { $x = $true; break }',
    '      }',
    '    }',
    '    if ($x) { break }',
    '  }',
    "  if (-not $c -or $x) { Write-Output '{}'; exit 0 }",
    '  $z = [System.Text.Encoding]::UTF8.GetString($p.GetBuffer(), 0, [int]$p.Length)',
    '  if ($z.Length -gt 0 -and $z[0] -eq [char]0xfeff) { $z = $z.Substring(1) }',
    '  $null = ConvertFrom-Json -InputObject $z -ErrorAction Stop',
    "  $f = Join-Path ([System.IO.Path]::GetTempPath()) ('orca-claude-hook-' + [Guid]::NewGuid().ToString('N') + '.json')",
    '  $h = [System.IO.FileStream]::new($f, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::DeleteOnClose)',
    '  try {',
    '    $p.WriteTo($h)',
    '    $h.Flush()',
    `    $env:${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV} = $f`,
    `    ${scriptInvocation}`,
    '    exit $LASTEXITCODE',
    '  } finally {',
    '    $h.Dispose()',
    '  }',
    '} catch {',
    "  Write-Output '{}'",
    '  exit 0',
    '} finally {',
    '  $p.Dispose()',
    '}'
  ].join('\n')
}
