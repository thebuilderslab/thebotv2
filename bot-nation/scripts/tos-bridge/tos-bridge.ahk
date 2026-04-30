; ============================================================
;  Bot Nation — ThinkorSwim Bridge  (AutoHotkey v2)
;
;  What this does:
;    • Registers a session with the bot-nation worker on startup
;    • Every 60 s: reads TOS position CSV → sends tick data
;    • Win+T  (⊞T): capture current symbol under cursor → send tick
;    • Win+A  (⊞A): fire a manual alert for the selected symbol
;    • Win+O  (⊞O): get agent order-entry suggestion for selected symbol
;    • Win+S  (⊞S): force-sync positions from latest CSV now
;
;  Prerequisites:
;    1. AutoHotkey v2 — https://www.autohotkey.com/
;    2. TOS position export saved to:
;         %USERPROFILE%\thinkorswim\TOS_exports\
;       (Monitor tab → right-click position table → Export)
;    3. PowerShell 5+ available (ships with Windows 10/11)
;
;  Run: double-click this file (AHK v2 must be installed)
; ============================================================

#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook

; ── Config ────────────────────────────────────────────────
API_BASE     := "https://bot-nation-api.thejamalshackleford.workers.dev"
EXPORT_DIR   := EnvGet("USERPROFILE") . "\thinkorswim\TOS_exports"
POLL_SECS    := 60          ; how often to auto-sync positions
SESSION_ID   := ""          ; filled on startup

; ── Startup ───────────────────────────────────────────────
TraySetIcon("shell32.dll", 278)   ; chart icon in system tray
A_TrayMenu.Delete()
A_TrayMenu.Add("Bot Nation TOS Bridge", (*) => MsgBox("Session: " SESSION_ID))
A_TrayMenu.Add("Sync Positions Now",    (*) => SyncPositions())
A_TrayMenu.Add("Exit",                  (*) => ExitApp())
A_TrayMenu.Default := "Bot Nation TOS Bridge"

; Register session
SESSION_ID := RegisterSession()
if SESSION_ID {
    TrayTip("Bot Nation TOS Bridge", "Connected — session " SubStr(SESSION_ID, 1, 8) "...", 3000)
} else {
    TrayTip("Bot Nation TOS Bridge", "WARNING: Could not register session. Check API.", 5000)
}

; Initial sync
SyncPositions()

; Auto-poll timer
SetTimer(AutoPoll, POLL_SECS * 1000)

; ── Hotkeys ───────────────────────────────────────────────

; Win+T — capture symbol from TOS active cell → send tick
#t:: {
    symbol := GetSymbolFromClipboard()
    if !symbol {
        ToolTip("Select a symbol in TOS first (click the symbol cell, Ctrl+C, then Win+T)")
        SetTimer(() => ToolTip(), -3000)
        return
    }
    price := InputBox("Enter current price for " symbol ":", "Tick Data", , "0.00").Value
    if price = "" || price = "0.00"
        return
    result := SendTick(symbol, Number(price))
    ToolTip("✓ Tick sent: " symbol " @ $" price)
    SetTimer(() => ToolTip(), -3000)
}

; Win+A — manual price alert for the selected symbol
#a:: {
    symbol := GetSymbolFromClipboard()
    if !symbol {
        symbol := InputBox("Enter symbol (e.g. AAPL):", "Send Alert", , "").Value
        if symbol = ""
            return
    }
    symbol := StrUpper(Trim(symbol))
    price  := InputBox("Current price of " symbol "?", "Alert Price", , "0.00").Value
    if price = "" || price = "0.00"
        return
    trigVal := InputBox("Alert trigger level (the price that was crossed)?", "Trigger Level", , price).Value
    if trigVal = ""
        trigVal := price
    dir := MsgBox("Did price cross ABOVE or BELOW $" trigVal "?", "Direction", "YesNo")
    direction := (dir = "Yes") ? "ABOVE" : "BELOW"

    result := SendAlert(symbol, Number(trigVal), direction, Number(price), "PRICE_CROSS")
    ToolTip("🔔 Alert sent: " symbol " " direction " $" trigVal " → signal created")
    SetTimer(() => ToolTip(), -5000)
}

; Win+O — get agent order-entry suggestion
#o:: {
    symbol := GetSymbolFromClipboard()
    if !symbol {
        symbol := InputBox("Enter symbol:", "Order Analysis", , "").Value
        if symbol = ""
            return
    }
    symbol := StrUpper(Trim(symbol))
    price  := InputBox("Current price of " symbol "?", "Order Entry", , "0.00").Value
    if price = "" || price = "0.00"
        return

    ToolTip("Requesting agent analysis for " symbol "...")
    result := PostJSON(API_BASE "/api/tws/order-entry", Map(
        "symbol",        symbol,
        "strategy",      "DIAGONAL",
        "action",        "OPEN",
        "current_price", Number(price),
        "dte_target",    30,
        "delta_target",  0.20
    ))

    if result {
        tosStr := result["tos_order_string"] ?? "N/A"
        conf   := Round((result["confidence"] ?? 0) * 100) "%"
        reason := SubStr(result["reasoning"] ?? "No reasoning", 1, 200)

        ; Copy TOS order string to clipboard
        A_Clipboard := tosStr

        MsgBox(
            symbol " — Agent Analysis`n`n" .
            "Confidence: " conf "`n" .
            "Order: " tosStr "`n`n" .
            reason "`n`n" .
            "(Order string copied to clipboard — paste into TOS Order Entry)",
            "Bot Nation: " symbol,
            "OK"
        )
    } else {
        ToolTip("✗ Agent analysis failed. Check API.")
        SetTimer(() => ToolTip(), -3000)
    }
}

; Win+S — force sync now
#s:: {
    ToolTip("Syncing positions...")
    n := SyncPositions()
    ToolTip("✓ Synced " n " positions")
    SetTimer(() => ToolTip(), -3000)
}

; ── Functions ─────────────────────────────────────────────

AutoPoll() {
    global SESSION_ID
    if SESSION_ID
        PingSession(SESSION_ID)
    SyncPositions()
}

RegisterSession() {
    result := PostJSON(A_ScriptDir "/../../../packages/backend-api" , Map(  ; dummy path — use API
        "client_label", "thinkorswim-" A_ComputerName,
        "symbols",      []
    ))
    ; actual call:
    result := PostJSON(API_BASE "/api/tws/ws/register", Map(
        "client_label", "thinkorswim-" A_ComputerName,
        "symbols",      []
    ))
    return result ? (result["session_id"] ?? "") : ""
}

PingSession(sessionId) {
    PostJSON(API_BASE "/api/tws/ws/ping", Map("session_id", sessionId))
}

SendTick(symbol, price, volume := 0, bid := 0, ask := 0) {
    return PostJSON(API_BASE "/api/tws/ws/tick", Map(
        "symbol",    symbol,
        "price",     price,
        "volume",    volume,
        "bid",       bid,
        "ask",       ask,
        "timestamp", FormatTime(, "yyyy-MM-ddTHH:mm:ssZ")
    ))
}

SendAlert(symbol, triggerVal, direction, currentPrice, triggerType := "PRICE_CROSS") {
    return PostJSON(API_BASE "/api/tws/alert", Map(
        "symbol",        symbol,
        "trigger_type",  triggerType,
        "trigger_val",   triggerVal,
        "direction",     direction,
        "current_price", currentPrice,
        "timestamp",     FormatTime(, "yyyy-MM-ddTHH:mm:ssZ")
    ))
}

SyncPositions() {
    global EXPORT_DIR
    count := 0

    ; Find newest CSV in TOS export dir
    csvFile := ""
    newestTime := 0
    loop files EXPORT_DIR "\*.csv" {
        if A_LoopFileTimeModified > newestTime {
            newestTime := A_LoopFileTimeModified
            csvFile := A_LoopFileFullPath
        }
    }

    if !csvFile {
        ; No CSV found — prompt user to export
        TrayTip("No position CSV found",
            "In TOS: Monitor tab → right-click positions → Export`nSave to: " EXPORT_DIR,
            5000)
        return 0
    }

    ; Parse CSV
    rows := ReadCSV(csvFile)
    if !rows.Length
        return 0

    ; Detect header row
    headers := rows[1]
    symbolCol := FindCol(headers, ["Symbol", "Instrument", "Sym"])
    markCol   := FindCol(headers, ["Mark", "Last", "Price", "Bid/Ask Mid"])
    plCol     := FindCol(headers, ["P/L Open", "P&L", "Open P/L"])
    plPctCol  := FindCol(headers, ["P/L %", "P&L %", "Open P/L %"])
    dteCol    := FindCol(headers, ["DTE", "Days to Exp", "Days"])

    if !symbolCol || !markCol
        return 0

    ; Send each row
    ticks := []
    for i, row in rows {
        if i = 1  ; skip header
            continue
        sym  := Trim(row[symbolCol] ?? "")
        mark := Trim(row[markCol]   ?? "")
        if !sym || !mark || !IsNumber(mark)
            continue

        ; Strip option suffixes — keep root symbol only
        rootSym := RegExReplace(sym, "\s.*$", "")
        if RegExMatch(rootSym, "^[A-Z]{1,5}$") {
            SendTick(rootSym, Number(mark))
            count++
        }

        ; If we have full position data, also PATCH position if ID known
        ; (skip for now — tick update is sufficient)
    }

    return count
}

; ── Clipboard helper ──────────────────────────────────────

GetSymbolFromClipboard() {
    saved := A_Clipboard
    A_Clipboard := ""
    ; User should have already Ctrl+C'd the symbol in TOS
    ; We just grab whatever is on the clipboard
    txt := Trim(A_Clipboard)
    if !txt {
        ; Try to read via Ctrl+C on active window
        Send("^c")
        Sleep(150)
        txt := Trim(A_Clipboard)
    }
    A_Clipboard := saved

    ; Validate: 1-5 uppercase letters only
    txt := StrUpper(txt)
    if RegExMatch(txt, "^[A-Z]{1,5}$")
        return txt
    return ""
}

; ── CSV reader ────────────────────────────────────────────

ReadCSV(filePath) {
    rows := []
    try {
        content := FileRead(filePath, "UTF-8")
    } catch {
        try content := FileRead(filePath)
        catch return rows
    }
    for line in StrSplit(content, "`n", "`r") {
        if Trim(line) = ""
            continue
        cols := []
        ; Simple CSV split (handles quoted fields)
        inQuote := false
        cell := ""
        loop parse, line {
            ch := A_LoopField
            if ch = '"' {
                inQuote := !inQuote
            } else if ch = "," && !inQuote {
                cols.Push(Trim(cell, ' "'))
                cell := ""
            } else {
                cell .= ch
            }
        }
        cols.Push(Trim(cell, ' "'))
        rows.Push(cols)
    }
    return rows
}

FindCol(headers, candidates) {
    for i, h in headers {
        for cand in candidates {
            if InStr(h, cand)
                return i
        }
    }
    return 0
}

; ── JSON POST (PowerShell under the hood) ─────────────────

PostJSON(url, data) {
    ; Build JSON string from Map
    json := MapToJSON(data)

    ; Use PowerShell Invoke-RestMethod
    ps := "
    (
        try {
            $r = Invoke-RestMethod -Uri '" url "' -Method POST ``
                -ContentType 'application/json' ``
                -Body '" StrReplace(json, "'", "''") "' ``
                -ErrorAction Stop
            Write-Output ($r | ConvertTo-Json -Compress)
        } catch {
            Write-Output 'ERROR: ' + $_.Exception.Message
        }
    )"

    shell := ComObject("WScript.Shell")
    cmd   := 'powershell -NoProfile -NonInteractive -Command "' StrReplace(ps, '"', '\"') '"'
    exec  := shell.Exec(cmd)
    result := ""
    while !exec.StdOut.AtEndOfStream
        result .= exec.StdOut.ReadLine()

    if SubStr(result, 1, 6) = "ERROR:" || result = ""
        return ""

    ; Parse JSON response (minimal)
    parsed := Map()
    for match in [result] {
        ; Extract key fields we care about
        if RegExMatch(result, '"session_id"\s*:\s*"([^"]+)"', &m)
            parsed["session_id"] := m[1]
        if RegExMatch(result, '"signal_id"\s*:\s*"([^"]+)"', &m)
            parsed["signal_id"] := m[1]
        if RegExMatch(result, '"tos_order_string"\s*:\s*"([^"]+)"', &m)
            parsed["tos_order_string"] := m[1]
        if RegExMatch(result, '"confidence"\s*:\s*([\d.]+)', &m)
            parsed["confidence"] := Number(m[1])
        if RegExMatch(result, '"reasoning"\s*:\s*"([^"]+)"', &m)
            parsed["reasoning"] := m[1]
    }
    return parsed
}

MapToJSON(m) {
    json := "{"
    first := true
    for k, v in m {
        if !first
            json .= ","
        json .= '"' k '":'
        if v is Array {
            json .= "["
            for i, item in v {
                if i > 1
                    json .= ","
                json .= IsNumber(item) ? item : '"' item '"'
            }
            json .= "]"
        } else if IsNumber(v) {
            json .= v
        } else {
            json .= '"' StrReplace(String(v), '"', '\"') '"'
        }
        first := false
    }
    return json . "}"
}
