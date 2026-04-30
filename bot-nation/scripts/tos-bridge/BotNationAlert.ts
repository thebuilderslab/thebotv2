#
# Bot Nation Alert Study for thinkorswim
#
# PURPOSE:
#   This ThinkScript study watches RSI, DTE, and price levels.
#   When triggered it fires a TOS alert — you then use the
#   AutoHotkey bridge (Win+A) or PowerShell (manual-alert.ps1)
#   to forward that alert to bot-nation for multi-agent analysis.
#
# INSTALL:
#   1. In TOS: Charts → Studies → Edit Studies
#   2. Click "Create" → paste this entire script
#   3. Name it "BotNationAlert"
#   4. Click OK, then "Add Selected" on your chart
#   5. Configure thresholds via the study Settings panel
#
# ALERT SETUP (after adding study to chart):
#   1. Right-click any arrow label on the chart
#   2. "Set Alert Condition" → choose the scan/signal
#   3. Alert Action: "Alert" (plays sound + shows notification)
#   4. When you hear the alert → press Win+A in AutoHotkey bridge
#      to forward it to bot-nation with one keypress
#

declare upper;

# ── Inputs ────────────────────────────────────────────────────────────────────
input rsi_period       = 14;
input rsi_overbought   = 70;
input rsi_oversold     = 30;
input price_alert_1    = 0.0;   # Set to a key level (0 = disabled)
input price_alert_2    = 0.0;   # Second key level
input price_alert_3    = 0.0;   # Third key level
input dte_warning      = 7;     # Days to expiry warning threshold
input show_rsi_labels  = yes;
input show_price_lines = yes;

# ── RSI ───────────────────────────────────────────────────────────────────────
def rsi = RSI(Length = rsi_period);

# ── Price Conditions ──────────────────────────────────────────────────────────
def closePrice = close;
def prevClose  = close[1];

# RSI signals
def rsi_cross_up_oversold   = rsi crosses above rsi_oversold;
def rsi_cross_dn_overbought = rsi crosses below rsi_overbought;

# Price level crosses
def price1_cross_above = price_alert_1 > 0 and closePrice crosses above price_alert_1;
def price1_cross_below = price_alert_1 > 0 and closePrice crosses below price_alert_1;
def price2_cross_above = price_alert_2 > 0 and closePrice crosses above price_alert_2;
def price2_cross_below = price_alert_2 > 0 and closePrice crosses below price_alert_2;
def price3_cross_above = price_alert_3 > 0 and closePrice crosses above price_alert_3;
def price3_cross_below = price_alert_3 > 0 and closePrice crosses below price_alert_3;

# ── Labels ────────────────────────────────────────────────────────────────────
# RSI status in top-right
AddLabel(show_rsi_labels,
    "RSI " + Round(rsi, 1),
    if rsi >= rsi_overbought then Color.RED
    else if rsi <= rsi_oversold then Color.GREEN
    else Color.GRAY
);

# Alert readiness label — green = bot-nation bridge is watching
AddLabel(yes, "BN BRIDGE", Color.CYAN);

# ── Price Level Lines ─────────────────────────────────────────────────────────
plot level1 = if show_price_lines and price_alert_1 > 0 then price_alert_1 else Double.NaN;
level1.SetDefaultColor(Color.YELLOW);
level1.SetStyle(Curve.SHORT_DASH);
level1.SetLineWeight(2);

plot level2 = if show_price_lines and price_alert_2 > 0 then price_alert_2 else Double.NaN;
level2.SetDefaultColor(Color.ORANGE);
level2.SetStyle(Curve.SHORT_DASH);
level2.SetLineWeight(2);

plot level3 = if show_price_lines and price_alert_3 > 0 then price_alert_3 else Double.NaN;
level3.SetDefaultColor(Color.PINK);
level3.SetStyle(Curve.SHORT_DASH);
level3.SetLineWeight(2);

# ── RSI Arrow Signals ─────────────────────────────────────────────────────────
# Green up-arrow when RSI crosses out of oversold territory
plot rsiOversoldSignal = if rsi_cross_up_oversold then low * 0.998 else Double.NaN;
rsiOversoldSignal.SetPaintingStrategy(PaintingStrategy.ARROW_UP);
rsiOversoldSignal.SetDefaultColor(Color.GREEN);
rsiOversoldSignal.SetLineWeight(3);

# Red down-arrow when RSI crosses out of overbought territory
plot rsiOverboughtSignal = if rsi_cross_dn_overbought then high * 1.002 else Double.NaN;
rsiOverboughtSignal.SetPaintingStrategy(PaintingStrategy.ARROW_DOWN);
rsiOverboughtSignal.SetDefaultColor(Color.RED);
rsiOverboughtSignal.SetLineWeight(3);

# Price level cross signals
plot priceCrossAbove = if (price1_cross_above or price2_cross_above or price3_cross_above) then low * 0.997 else Double.NaN;
priceCrossAbove.SetPaintingStrategy(PaintingStrategy.ARROW_UP);
priceCrossAbove.SetDefaultColor(Color.CYAN);
priceCrossAbove.SetLineWeight(4);

plot priceCrossBelow = if (price1_cross_below or price2_cross_below or price3_cross_below) then high * 1.003 else Double.NaN;
priceCrossBelow.SetPaintingStrategy(PaintingStrategy.ARROW_DOWN);
priceCrossBelow.SetDefaultColor(Color.MAGENTA);
priceCrossBelow.SetLineWeight(4);

# ── Alerts ────────────────────────────────────────────────────────────────────
Alert(rsi_cross_up_oversold,
    GetSymbol() + " RSI bounced from oversold (" + Round(rsi,1) + ") — price: " + closePrice,
    Alert.BAR,
    Sound.Ring);

Alert(rsi_cross_dn_overbought,
    GetSymbol() + " RSI dropped from overbought (" + Round(rsi,1) + ") — price: " + closePrice,
    Alert.BAR,
    Sound.Ring);

Alert(price1_cross_above,
    GetSymbol() + " crossed ABOVE " + price_alert_1 + " — current: " + closePrice,
    Alert.BAR,
    Sound.Ding);

Alert(price1_cross_below,
    GetSymbol() + " crossed BELOW " + price_alert_1 + " — current: " + closePrice,
    Alert.BAR,
    Sound.Ding);

Alert(price2_cross_above,
    GetSymbol() + " crossed ABOVE " + price_alert_2 + " — current: " + closePrice,
    Alert.BAR,
    Sound.Ding);

Alert(price2_cross_below,
    GetSymbol() + " crossed BELOW " + price_alert_2 + " — current: " + closePrice,
    Alert.BAR,
    Sound.Ding);
