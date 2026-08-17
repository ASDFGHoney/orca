export const WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV = 'ORCA_AGENT_HOOK_PAYLOAD_FILE'
export const WINDOWS_CLAUDE_HOOK_STDIN_IDLE_TIMEOUT_MILLISECONDS = 250
export const WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES = 1_000_000

// Why (#13285): providers can leave hook stdin open after writing JSON, so EOF is not a safe boundary.
export function buildWindowsClaudeHookStdinBuffer(scriptInvocation: string): string {
  return [
    '$inputStream = [Console]::OpenStandardInput()',
    '$payload = New-Object System.IO.MemoryStream',
    '$buffer = New-Object byte[] 8192',
    'try {',
    `  while ($payload.Length -lt ${WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES}) {`,
    `    $remaining = ${WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES} - [int]$payload.Length`,
    '    $read = $inputStream.ReadAsync($buffer, 0, [Math]::Min($buffer.Length, $remaining))',
    `    if (-not $read.Wait(${WINDOWS_CLAUDE_HOOK_STDIN_IDLE_TIMEOUT_MILLISECONDS})) { break }`,
    '    $count = $read.Result',
    '    if ($count -eq 0) { break }',
    '    $payload.Write($buffer, 0, $count)',
    '  }',
    "  if ($payload.Length -eq 0) { Write-Output '{}'; exit 0 }",
    "  $payloadPath = Join-Path ([System.IO.Path]::GetTempPath()) ('orca-claude-hook-' + [Guid]::NewGuid().ToString('N') + '.json')",
    '  $payloadFile = [System.IO.FileStream]::new($payloadPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read, 4096, [System.IO.FileOptions]::DeleteOnClose)',
    '  try {',
    '    $payload.WriteTo($payloadFile)',
    '    $payloadFile.Flush()',
    `    $env:${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV} = $payloadPath`,
    `    ${scriptInvocation}`,
    '    exit $LASTEXITCODE',
    '  } finally {',
    '    $payloadFile.Dispose()',
    '  }',
    '} catch {',
    "  Write-Output '{}'",
    '  exit 0',
    '} finally {',
    '  $payload.Dispose()',
    '}'
  ].join('\n')
}
