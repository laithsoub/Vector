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

# 2) Is a debug Edge already listening on 9222?
# The debug instance runs on its own --user-data-dir, so it coexists with the
# user's normal Edge windows. Never kill Edge: a launcher run must not close
# the browsing session, and a debug instance that is already up is reused.
function Test-DebugPort {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ok = $c.ConnectAsync('127.0.0.1', 9222).Wait(700)
        $c.Close()
        return $ok
    } catch { return $false }
}
$debugUp = Test-DebugPort
Log "debug port 9222 already up: $debugUp"

# 3) Locate Edge
$edge = if (Test-Path 'C:\Program Files\Microsoft\Edge\Application\msedge.exe') {
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
} elseif (Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe') {
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
} else { $null }
Log "edge path: $edge"

# 4) Launch Edge with remote debugging
# Edge 136+ (this machine: 150) silently ignores --remote-debugging-port when
# launched on the DEFAULT user-data-dir — an anti-cookie-theft change. The port
# only binds with a dedicated --user-data-dir. Log into SharePoint once in this
# profile; cookies persist here for Connect to JOE.
$edgeProfile = Join-Path $env:LOCALAPPDATA 'VectorEdgeDebug'
if ($edge -and -not $debugUp) {
    Start-Process $edge -ArgumentList @(
        '--remote-debugging-port=9222',
        '--no-first-run',
        "--user-data-dir=`"$edgeProfile`"",
        'https://eaton.sharepoint.com/sites/QuotationFactoryEMEA'
    )
    Log "edge launched with debugging (user-data-dir=$edgeProfile)"
} elseif ($debugUp) {
    Log "reusing the debug Edge already on 9222"
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

# 7) Open the app tab in the NORMAL Edge profile. The app itself needs no
# SharePoint cookies (the server-side python holds them), so it does not have
# to live in the debug profile — this way it opens as a tab in the browser
# window that is already in front of the user.
if ($edge) {
    Start-Process $edge -ArgumentList @('http://localhost:3000')
    Log "app tab opened in the default profile"
}

Log "=== PS launcher done ==="
