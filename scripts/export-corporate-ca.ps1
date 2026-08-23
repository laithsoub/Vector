# Exports the corporate root CAs from the Windows certificate store into a PEM
# bundle that Node can trust via NODE_EXTRA_CA_CERTS.
#
# Why this exists: Eaton's Zscaler proxy terminates TLS and re-signs every HTTPS
# connection with "Eaton Zscaler Proxy", chaining up to "Eaton Root CA 3". Windows
# and the browsers trust that root, so they are happy; Node ships its own root
# store and does not, so every outbound HTTPS call fails with
# SELF_SIGNED_CERT_IN_CHAIN.
#
# The old workaround was NODE_TLS_REJECT_UNAUTHORIZED=0, which fixed SharePoint by
# switching off certificate checking for *everything* — including the connection
# carrying the Gemini API key. This trusts the one root that is actually in play
# instead, so the rest of the internet is still verified.
#
# Run:  npm run certs
# Then the dev scripts point NODE_EXTRA_CA_CERTS at the file they produce.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $repo 'certs\corporate-roots.pem'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

# Both stores: the machine store holds the policy-deployed roots, the user store
# picks up anything installed per-user.
$stores = @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root',
            'Cert:\LocalMachine\CA',   'Cert:\CurrentUser\CA')

$seen  = @{}
$lines = @()
$count = 0

foreach ($store in $stores) {
    Get-ChildItem $store -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -match 'Eaton|Zscaler' -and $_.NotAfter -gt (Get-Date) } |
      ForEach-Object {
        if (-not $seen.ContainsKey($_.Thumbprint)) {
            $seen[$_.Thumbprint] = $true
            $count++
            $lines += "# $($_.Subject)"
            $lines += "# expires $($_.NotAfter.ToString('yyyy-MM-dd'))  sha1=$($_.Thumbprint)"
            $lines += '-----BEGIN CERTIFICATE-----'
            $lines += [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
            $lines += '-----END CERTIFICATE-----'
            $lines += ''
        }
      }
}

if ($count -eq 0) {
    Write-Error "No corporate root certificates found. If the proxy has changed, widen the Subject filter in this script."
}

($lines -join "`n") | Out-File -FilePath $out -Encoding ascii
Write-Host "Wrote $out ($count certificates)"
Write-Host "The dev scripts already point NODE_EXTRA_CA_CERTS here - restart the server to pick it up."
