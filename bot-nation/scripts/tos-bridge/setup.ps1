#!/usr/bin/env pwsh
<#
.SYNOPSIS
    First-time setup for Bot Nation TOS Bridge.
    Run this once before using tos-bridge.ahk or manual-alert.ps1.

.DESCRIPTION
    1. Verifies API is reachable
    2. Registers a session
    3. Adds default watchlist symbols
    4. Checks TOS export directory exists
    5. Prints quick-start guide
#>

$API = "https://bot-nation-api.thejamalshackleford.workers.dev"
$EXPORT_DIR = "$env:USERPROFILE\thinkorswim\TOS_exports"

Write-Host ""
Write-Host "  Bot Nation TOS Bridge — First-Time Setup" -ForegroundColor Cyan
Write-Host "  ==========================================" -ForegroundColor Cyan
Write-Host ""

$ok = $true

# ── 1. Test API connectivity ──────────────────────────────────────────────────
Write-Host "  [1/5] Testing API connectivity..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$API/health" -Method GET -ErrorAction Stop
    Write-Host "        ✅ API is up" -ForegroundColor Green
} catch {
    # /health may not exist, try watchlist endpoint
    try {
        $wl = Invoke-RestMethod -Uri "$API/api/tws/watchlist" -Method GET -ErrorAction Stop
        Write-Host "        ✅ API is up" -ForegroundColor Green
    } catch {
        Write-Host "        ❌ API unreachable: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "        Check your internet connection and worker deployment." -ForegroundColor DarkGray
        $ok = $false
    }
}

# ── 2. Register session ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "  [2/5] Registering TOS session..." -ForegroundColor Yellow

try {
    $sessionResp = Invoke-RestMethod -Uri "$API/api/tws/ws/register" -Method POST `
        -ContentType "application/json" `
        -Body (@{ client_label = "setup-$env:COMPUTERNAME"; symbols = @() } | ConvertTo-Json) `
        -ErrorAction Stop

    $sessionId = $sessionResp.session_id
    Write-Host "        ✅ Session ID: $sessionId" -ForegroundColor Green
    Write-Host "        (sessions are stored in Cloudflare D1)" -ForegroundColor DarkGray
} catch {
    Write-Host "        ❌ Could not register session: $($_.Exception.Message)" -ForegroundColor Red
    $ok = $false
    $sessionId = $null
}

# ── 3. Set up watchlist ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "  [3/5] Setting up default watchlist..." -ForegroundColor Yellow

$defaultSymbols = @(
    @{ symbol = "SPY";  asset_type = "etf" },
    @{ symbol = "QQQ";  asset_type = "etf" },
    @{ symbol = "AAPL"; asset_type = "equity" },
    @{ symbol = "TSLA"; asset_type = "equity" },
    @{ symbol = "NVDA"; asset_type = "equity" },
    @{ symbol = "MSFT"; asset_type = "equity" },
    @{ symbol = "AMZN"; asset_type = "equity" }
)

$addedCount = 0
foreach ($sym in $defaultSymbols) {
    try {
        $r = Invoke-RestMethod -Uri "$API/api/tws/watchlist" -Method POST `
            -ContentType "application/json" `
            -Body ($sym | ConvertTo-Json) `
            -ErrorAction Stop
        Write-Host "        ✅ Added: $($sym.symbol)" -ForegroundColor Green
        $addedCount++
    } catch {
        $code = $_.Exception.Response?.StatusCode?.value__
        if ($code -eq 409 -or ($_.Exception.Message -match "UNIQUE")) {
            Write-Host "        ↩  $($sym.symbol) already in watchlist" -ForegroundColor DarkGray
        } else {
            Write-Host "        ⚠  $($sym.symbol): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

Write-Host "        Added $addedCount new symbols" -ForegroundColor Cyan

# Add custom symbols?
Write-Host ""
$addMore = Read-Host "  Add your own symbols now? (e.g. ORCL AMD GOOGL) — press Enter to skip"
if ($addMore.Trim()) {
    foreach ($s in ($addMore -split '\s+')) {
        $s = $s.ToUpper().Trim()
        if ($s -match '^[A-Z]{1,5}$') {
            try {
                Invoke-RestMethod -Uri "$API/api/tws/watchlist" -Method POST `
                    -ContentType "application/json" `
                    -Body (@{ symbol = $s; asset_type = "equity" } | ConvertTo-Json) `
                    -ErrorAction Stop | Out-Null
                Write-Host "        ✅ Added: $s" -ForegroundColor Green
            } catch {
                Write-Host "        ⚠  $s`: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }
}

# ── 4. Check TOS export directory ────────────────────────────────────────────
Write-Host ""
Write-Host "  [4/5] Checking TOS export directory..." -ForegroundColor Yellow

if (Test-Path $EXPORT_DIR) {
    $csvCount = (Get-ChildItem $EXPORT_DIR -Filter "*.csv" -ErrorAction SilentlyContinue).Count
    Write-Host "        ✅ Directory exists: $EXPORT_DIR" -ForegroundColor Green
    Write-Host "        Found $csvCount CSV file(s)" -ForegroundColor DarkGray
} else {
    Write-Host "        ⚠  Directory not found: $EXPORT_DIR" -ForegroundColor Yellow
    Write-Host "        Creating it now..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Path $EXPORT_DIR -Force | Out-Null
    Write-Host "        ✅ Created: $EXPORT_DIR" -ForegroundColor Green
}

# ── 5. Check AutoHotkey ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "  [5/5] Checking AutoHotkey v2..." -ForegroundColor Yellow

$ahk = Get-Command "AutoHotkey64.exe" -ErrorAction SilentlyContinue ??
       Get-Command "AutoHotkey.exe"   -ErrorAction SilentlyContinue

if ($ahk) {
    Write-Host "        ✅ AutoHotkey found: $($ahk.Source)" -ForegroundColor Green
} else {
    Write-Host "        ⚠  AutoHotkey not found in PATH" -ForegroundColor Yellow
    Write-Host "        Download from: https://www.autohotkey.com/" -ForegroundColor DarkGray
    Write-Host "        (Required for hotkeys Win+T / Win+A / Win+O)" -ForegroundColor DarkGray
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Quick Start:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  ① Double-click tos-bridge.ahk to start the bridge" -ForegroundColor White
Write-Host "    (runs in system tray — auto-syncs every 60 seconds)"
Write-Host ""
Write-Host "  ② Export positions from TOS:" -ForegroundColor White
Write-Host "    Monitor → Positions & P/L → right-click → Export to File"
Write-Host "    Save to: $EXPORT_DIR"
Write-Host ""
Write-Host "  ③ Hotkeys (while tos-bridge.ahk is running):" -ForegroundColor White
Write-Host "    Win+T  — Send tick for copied symbol"
Write-Host "    Win+A  — Fire an alert (routes to Telegram via agents)"
Write-Host "    Win+O  — Get order suggestion for current symbol"
Write-Host "    Win+S  — Force position sync now"
Write-Host ""
Write-Host "  ④ Or use PowerShell directly:" -ForegroundColor White
Write-Host "    .\manual-alert.ps1 portfolio       — view open positions"
Write-Host "    .\manual-alert.ps1 alert AAPL 185  — fire manual alert"
Write-Host "    .\manual-alert.ps1 sync             — sync TOS positions"
Write-Host "    .\manual-alert.ps1 order TSLA 245  — get order suggestion"
Write-Host ""
Write-Host "  ⑤ Add BotNationAlert.ts study to TOS charts for auto-alerts" -ForegroundColor White
Write-Host "    Charts → Studies → Edit Studies → Create → paste the .ts file"
Write-Host ""
Write-Host "  Worker: $API" -ForegroundColor DarkGray
Write-Host ""
