#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Bot Nation TOS Manual Alert & Position Sync Tool

.DESCRIPTION
    Run directly from PowerShell — no AutoHotkey required.
    Use this for one-off alerts, watchlist management,
    and manual position syncs.

.EXAMPLES
    # Fire an alert
    .\manual-alert.ps1 alert AAPL 185.50 ABOVE 183.00

    # Sync positions from latest TOS CSV
    .\manual-alert.ps1 sync

    # Add symbol to watchlist
    .\manual-alert.ps1 watch NVDA

    # Get order suggestion from agents
    .\manual-alert.ps1 order TSLA 245.00

    # View current portfolio summary
    .\manual-alert.ps1 portfolio

    # View recent signals
    .\manual-alert.ps1 signals
#>

param(
    [Parameter(Position=0)]
    [ValidateSet("alert","sync","watch","order","portfolio","signals","register","watchlist")]
    [string]$Command = "portfolio",

    [Parameter(Position=1)] [string]$Symbol,
    [Parameter(Position=2)] [double]$Price,
    [Parameter(Position=3)] [string]$Direction,   # ABOVE | BELOW
    [Parameter(Position=4)] [double]$TriggerVal,

    [string]$Strategy  = "DIAGONAL",
    [int]$DTE          = 30,
    [double]$Delta     = 0.20,
    [string]$Action    = "OPEN",
    [string]$ExportDir = "$env:USERPROFILE\thinkorswim\TOS_exports"
)

$API = "https://bot-nation-api.thejamalshackleford.workers.dev"

function Invoke-API {
    param([string]$Method, [string]$Path, [hashtable]$Body = $null)
    $uri = "$API$Path"
    try {
        if ($Body) {
            $json = $Body | ConvertTo-Json -Compress -Depth 5
            $resp = Invoke-RestMethod -Uri $uri -Method $Method `
                -ContentType "application/json" -Body $json -ErrorAction Stop
        } else {
            $resp = Invoke-RestMethod -Uri $uri -Method $Method -ErrorAction Stop
        }
        return $resp
    } catch {
        $code = $_.Exception.Response?.StatusCode?.value__
        Write-Error "API $Method $Path → $code : $($_.Exception.Message)"
        return $null
    }
}

function Show-Banner {
    Write-Host ""
    Write-Host "  ████████╗ ██████╗ ███████╗" -ForegroundColor Cyan
    Write-Host "     ██╔══╝██╔═══██╗██╔════╝" -ForegroundColor Cyan
    Write-Host "     ██║   ██║   ██║███████╗" -ForegroundColor Cyan
    Write-Host "     ██║   ██║   ██║╚════██║" -ForegroundColor Cyan
    Write-Host "     ██║   ╚██████╔╝███████║" -ForegroundColor Cyan
    Write-Host "     ╚═╝    ╚═════╝ ╚══════╝ TOS Bridge" -ForegroundColor Cyan
    Write-Host ""
}

Show-Banner

switch ($Command) {

    # ── ALERT ────────────────────────────────────────────────────────────────
    "alert" {
        if (!$Symbol) { $Symbol = Read-Host "Symbol (e.g. AAPL)" }
        if (!$Price)  { $Price  = [double](Read-Host "Current price") }
        if (!$Direction) {
            $d = Read-Host "Direction [A=Above / B=Below]"
            $Direction = if ($d -match '^[Aa]') { "ABOVE" } else { "BELOW" }
        }
        if (!$TriggerVal) { $TriggerVal = [double](Read-Host "Trigger level (price that was crossed)") }

        Write-Host "  Sending alert: $($Symbol.ToUpper()) $Direction `$$TriggerVal (current: `$$Price)..." -ForegroundColor Yellow

        $resp = Invoke-API -Method POST -Path "/api/tws/alert" -Body @{
            symbol        = $Symbol.ToUpper()
            trigger_type  = "PRICE_CROSS"
            trigger_val   = $TriggerVal
            direction     = $Direction.ToUpper()
            current_price = $Price
            timestamp     = (Get-Date -Format "o")
        }

        if ($resp) {
            Write-Host "  ✅ Alert processed!" -ForegroundColor Green
            Write-Host "     Signal ID : $($resp.signal_id)"
            Write-Host "     Message   : $($resp.message)"
            Write-Host ""
            Write-Host "  (Telegram notification sent to your chat)" -ForegroundColor DarkGray
        }
    }

    # ── SYNC POSITIONS ───────────────────────────────────────────────────────
    "sync" {
        Write-Host "  Looking for TOS position exports in:" -ForegroundColor Yellow
        Write-Host "  $ExportDir" -ForegroundColor DarkGray

        $csvFiles = Get-ChildItem -Path $ExportDir -Filter "*.csv" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending

        if (!$csvFiles) {
            Write-Host ""
            Write-Host "  ❌ No CSV files found." -ForegroundColor Red
            Write-Host ""
            Write-Host "  To export from TOS:" -ForegroundColor Yellow
            Write-Host "    1. Open thinkorswim"
            Write-Host "    2. Monitor tab → Positions & P/L"
            Write-Host "    3. Right-click anywhere in the positions table"
            Write-Host "    4. Click 'Export to File...'"
            Write-Host "    5. Save to: $ExportDir"
            Write-Host "    6. Run this script again"
            return
        }

        $latest = $csvFiles[0]
        Write-Host "  Using: $($latest.Name) (modified $($latest.LastWriteTime))" -ForegroundColor Cyan

        $rows = Import-Csv $latest.FullName -ErrorAction SilentlyContinue
        if (!$rows) {
            Write-Error "Could not parse CSV: $($latest.FullName)"
            return
        }

        $count = 0
        $skipped = 0

        foreach ($row in $rows) {
            # Try common TOS column names
            $sym  = $row.Symbol ?? $row.Instrument ?? $row."Symbol/Exp/Strike/Type" ?? ""
            $mark = $row.Mark   ?? $row.Last        ?? $row.Price                    ?? ""

            $sym  = $sym.Trim()
            $mark = $mark.Trim() -replace '[,$]', ''

            if (!$sym -or !$mark -or ![double]::TryParse($mark, [ref]$null)) {
                $skipped++
                continue
            }

            # Strip to root symbol only (e.g. "AAPL 240119C185" → "AAPL")
            $root = ($sym -split '\s+')[0].Trim().ToUpper()
            if ($root -notmatch '^[A-Z]{1,5}$') {
                $skipped++
                continue
            }

            $markVal = [double]$mark
            $resp = Invoke-API -Method POST -Path "/api/tws/ws/tick" -Body @{
                symbol    = $root
                price     = $markVal
                volume    = 0
                bid       = 0
                ask       = 0
                timestamp = (Get-Date -Format "o")
            }

            if ($resp -and $resp.status -eq "ok") {
                Write-Host "  ✓ $root @ `$$markVal" -ForegroundColor Green
                $count++
            } else {
                $skipped++
            }
        }

        Write-Host ""
        Write-Host "  Sync complete: $count ticks sent, $skipped rows skipped" -ForegroundColor Cyan
    }

    # ── ADD TO WATCHLIST ─────────────────────────────────────────────────────
    "watch" {
        if (!$Symbol) { $Symbol = Read-Host "Symbol to add to watchlist" }
        $Symbol = $Symbol.ToUpper().Trim()

        $resp = Invoke-API -Method POST -Path "/api/tws/watchlist" -Body @{
            symbol     = $Symbol
            asset_type = "equity"
        }

        if ($resp) {
            Write-Host "  ✅ $Symbol added to watchlist (ID: $($resp.id))" -ForegroundColor Green
        }
    }

    # ── ORDER SUGGESTION ─────────────────────────────────────────────────────
    "order" {
        if (!$Symbol) { $Symbol = Read-Host "Symbol (e.g. TSLA)" }
        if (!$Price)  { $Price  = [double](Read-Host "Current price") }
        $Symbol = $Symbol.ToUpper().Trim()

        Write-Host "  Requesting agent analysis for $Symbol `$$Price..." -ForegroundColor Yellow
        Write-Host "  (This calls 4 trading agents — may take ~15s)" -ForegroundColor DarkGray

        $resp = Invoke-API -Method POST -Path "/api/tws/order-entry" -Body @{
            symbol        = $Symbol
            strategy      = $Strategy
            action        = $Action
            current_price = $Price
            dte_target    = $DTE
            delta_target  = $Delta
        }

        if ($resp) {
            Write-Host ""
            Write-Host "  ╔══ $Symbol $($resp.strategy) $($resp.action) ══╗" -ForegroundColor Cyan
            Write-Host "  Confidence : $([Math]::Round($resp.confidence * 100))%" -ForegroundColor White
            Write-Host "  Reasoning  : $($resp.reasoning)" -ForegroundColor DarkGray
            Write-Host ""
            Write-Host "  TOS Order String (ready to paste):" -ForegroundColor Yellow
            Write-Host "  $($resp.tos_order_string)" -ForegroundColor Green
            Write-Host ""

            if ($resp.legs) {
                Write-Host "  Legs:" -ForegroundColor Yellow
                foreach ($leg in $resp.legs) {
                    Write-Host "    $($leg.action) $($leg.qty_effect) $Symbol $($leg.expiry) $($leg.strike) $($leg.option_type) (DTE: $($leg.dte), Δ≈$($leg.delta_approx))"
                }
            }

            if ($resp.pricing) {
                Write-Host ""
                Write-Host "  Pricing:" -ForegroundColor Yellow
                if ($null -ne $resp.pricing.net_credit) {
                    Write-Host "    Net Credit  : `$$([Math]::Abs($resp.pricing.net_credit))"
                }
                if ($resp.pricing.max_profit) {
                    Write-Host "    Max Profit  : `$$($resp.pricing.max_profit)"
                }
                if ($resp.pricing.max_loss) {
                    Write-Host "    Max Loss    : `$$($resp.pricing.max_loss)"
                }
                if ($resp.pricing.breakeven) {
                    Write-Host "    Breakeven   : `$$($resp.pricing.breakeven)"
                }
                if ($resp.pricing.risk_reward) {
                    Write-Host "    Risk/Reward : $([Math]::Round($resp.pricing.risk_reward, 2)):1"
                }
            }

            # Copy TOS order string to clipboard
            $resp.tos_order_string | Set-Clipboard
            Write-Host ""
            Write-Host "  (TOS order string copied to clipboard)" -ForegroundColor DarkGray
        }
    }

    # ── PORTFOLIO SUMMARY ────────────────────────────────────────────────────
    "portfolio" {
        Write-Host "  Fetching portfolio summary..." -ForegroundColor Yellow
        $resp = Invoke-API -Method GET -Path "/api/tws/portfolio"

        if ($resp) {
            $s = $resp.summary
            Write-Host ""
            Write-Host "  ╔══ Portfolio Summary ══╗" -ForegroundColor Cyan
            Write-Host "  Open Positions  : $($s.open_positions)" -ForegroundColor White
            $plColor = if ($s.total_pl_open -ge 0) { "Green" } else { "Red" }
            Write-Host "  Total P/L Open  : `$$($s.total_pl_open)" -ForegroundColor $plColor
            if ($s.urgent_expirations -gt 0) {
                Write-Host "  ⚠️  Urgent Expirations (≤7 DTE): $($s.urgent_expirations)" -ForegroundColor Red
            }

            if ($resp.urgent -and $resp.urgent.Count -gt 0) {
                Write-Host ""
                Write-Host "  ⚠️  Urgent Positions:" -ForegroundColor Red
                foreach ($p in $resp.urgent) {
                    Write-Host "    $($p.symbol) $($p.strategy) $($p.strike) exp $($p.expiry) — $($p.days_to_expiry) DTE, P/L: `$$($p.pl_open)"
                }
            }

            if ($resp.recent_signals -and $resp.recent_signals.Count -gt 0) {
                Write-Host ""
                Write-Host "  Recent Signals:" -ForegroundColor Yellow
                foreach ($sig in $resp.recent_signals) {
                    $sColor = switch ($sig.signal_type) {
                        "BUY"   { "Green"  }
                        "SELL"  { "Red"    }
                        "ROLL"  { "Cyan"   }
                        "CLOSE" { "Red"    }
                        default { "White"  }
                    }
                    Write-Host "    $($sig.symbol) — $($sig.signal_type) ($([Math]::Round($sig.confidence * 100))% confidence)" -ForegroundColor $sColor
                }
            }
        }
    }

    # ── SIGNALS ──────────────────────────────────────────────────────────────
    "signals" {
        $path = if ($Symbol) { "/api/tws/signals?symbol=$Symbol" } else { "/api/tws/signals" }
        $resp = Invoke-API -Method GET -Path $path

        if ($resp -and $resp.signals) {
            Write-Host ""
            Write-Host "  Recent Trading Signals:" -ForegroundColor Cyan
            foreach ($sig in $resp.signals) {
                $sColor = switch ($sig.signal_type) {
                    "BUY"   { "Green"  }
                    "SELL"  { "Red"    }
                    "ROLL"  { "Cyan"   }
                    "CLOSE" { "Red"    }
                    default { "White"  }
                }
                $conf  = [Math]::Round($sig.confidence * 100)
                $entry = if ($sig.entry_price)  { " Entry:`$$($sig.entry_price)" }  else { "" }
                $tgt   = if ($sig.target_price) { " Target:`$$($sig.target_price)" } else { "" }
                $stp   = if ($sig.stop_price)   { " Stop:`$$($sig.stop_price)" }    else { "" }
                Write-Host "    [$($sig.signal_type)] $($sig.symbol) — $conf% $($sig.timeframe)$entry$tgt$stp" -ForegroundColor $sColor
                if ($sig.reasoning) {
                    $r = $sig.reasoning | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if ($r?.technical) { Write-Host "      📈 $($r.technical.Substring(0, [Math]::Min(100, $r.technical.Length)))" -ForegroundColor DarkGray }
                }
            }
        } else {
            Write-Host "  No signals found." -ForegroundColor DarkGray
        }
    }

    # ── REGISTER ─────────────────────────────────────────────────────────────
    "register" {
        Write-Host "  Registering new session..." -ForegroundColor Yellow
        $resp = Invoke-API -Method POST -Path "/api/tws/ws/register" -Body @{
            client_label = "thinkorswim-$env:COMPUTERNAME"
            symbols      = @()
        }
        if ($resp) {
            Write-Host "  ✅ Session ID: $($resp.session_id)" -ForegroundColor Green
            Write-Host ""
            Write-Host "  Add this to tos-bridge.ahk → SESSION_ID" -ForegroundColor DarkGray
        }
    }

    # ── WATCHLIST VIEW ───────────────────────────────────────────────────────
    "watchlist" {
        $resp = Invoke-API -Method GET -Path "/api/tws/watchlist"
        if ($resp -and $resp.watchlist) {
            Write-Host ""
            Write-Host "  Active Watchlist:" -ForegroundColor Cyan
            foreach ($w in $resp.watchlist) {
                Write-Host "    $($w.symbol)  [$($w.asset_type)]  $($w.notes ?? '')" -ForegroundColor White
            }
        } else {
            Write-Host "  Watchlist is empty. Use: .\manual-alert.ps1 watch AAPL" -ForegroundColor DarkGray
        }
    }
}

Write-Host ""
