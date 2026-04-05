# Run from: C:\Users\janin\thebotv2\thebotv2\pbot-nation
# This script wires up core-domain src, backend-api, and creates the D1 database.
# One section at a time - paste output back before continuing.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot

Write-Host "`n=== [1/5] Copying core-domain files ===" -ForegroundColor Cyan
$srcDest = "$root\packages\core-domain\src"
New-Item -ItemType Directory -Force -Path $srcDest | Out-Null
# Files are dropped in manually from the download — this just confirms the dir exists
Write-Host "  src\ ready at $srcDest"

Write-Host "`n=== [2/5] Installing core-domain deps ===" -ForegroundColor Cyan
Set-Location "$root\packages\core-domain"
pnpm install
Write-Host "  core-domain deps installed"

Write-Host "`n=== [3/5] Installing backend-api deps ===" -ForegroundColor Cyan
Set-Location "$root\packages\backend-api"
pnpm install
Write-Host "  backend-api deps installed"

Write-Host "`n=== [4/5] Creating D1 database ===" -ForegroundColor Cyan
Write-Host "  Running: npx wrangler d1 create pbot-nation-db"
Write-Host "  >>> COPY the database_id from the output and paste it into wrangler.jsonc <<<"
npx wrangler d1 create pbot-nation-db

Write-Host "`n=== [5/5] Running local D1 migration ===" -ForegroundColor Cyan
Write-Host "  (After you've pasted the database_id into wrangler.jsonc)"
Read-Host "  Press Enter when wrangler.jsonc is updated..."
npx wrangler d1 migrations apply pbot-nation-db --local

Write-Host "`n=== Done! ===" -ForegroundColor Green
Write-Host "Next: set secrets and run 'pnpm dev' in backend-api"
