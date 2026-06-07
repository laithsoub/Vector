$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$log = Join-Path $dir 'startup-debug.log'

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 $log }

Log "=== PS launcher started ==="

# 1) Kill anything listening on port 3000
try {
    $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Log "killed pid $($c.OwningProcess) on port 3000"
    }
} catch { Log "kill port 3000 failed: $_" }
Start-Sleep -Milliseconds 800

# 2) Kill Edge
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Log "edge killed"

# 3) Locate Edge
$edge = if (Test-Path 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') {
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
} elseif (Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe') {
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
} else { $null }
Log "edge path: $edge"

# 4) Launch Edge with remote debugging
if ($edge) {
    Start-Process $edge -ArgumentList @(
        '--remote-debugging-port=9222',
        '--no-first-run',
        '--profile-directory=Default',
        'https://eaton.sharepoint.com/sites/QuotationFactoryEMEA'
    )
    Log "edge launched with debugging"
}

# 5) Start server as detached hidden process using node.exe directly (no PATH dependency)
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$npmCli  = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$outLog  = Join-Path $dir 'vector.log'
$errLog  = Join-Path $dir 'vector-err.log'

try {
    $proc = Start-Process -FilePath $nodeExe `
        -ArgumentList @("`"$npmCli`"", 'run', 'dev') `
        -WorkingDirectory $dir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError  $errLog `
        -PassThru
    Log "server process started, PID=$($proc.Id)"
} catch {
    Log "server start FAILED: $_"
}

# 6) Poll for server readiness (up to 30s)
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 1
    $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { $ready = $true; Log "server READY after ${i}s"; break }
}
if (-not $ready) { Log "server NEVER came up after 30s" }

# 7) Open app tab
if ($edge) {
    Start-Process $edge -ArgumentList 'http://localhost:3000'
    Log "app tab opened"
}

Log "=== PS launcher done ==="
