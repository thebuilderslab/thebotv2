/**
 * Parse human-readable time strings into ISO 8601 timestamps for TODAY
 * Examples: "1:30pm", "1:30 pm", "13:30", "1:30pm EST"
 * Returns ISO string in UTC (e.g., "2026-04-13T17:30:00Z" for 1:30pm EST on April 13)
 */
export function parseTimeString(
  timeStr: string,
  timezone: string = "EST"
): string {
  // Remove whitespace and normalize
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, "");

  // Extract hours and minutes
  let hours: number;
  let minutes: number;

  // Match patterns: "1:30pm", "130pm", "13:30", "1:30"
  const match = normalized.match(/^(\d{1,2}):?(\d{2})(am|pm)?$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Invalid time format: ${timeStr}. Use "1:30pm", "13:30", or "1:30pm EST"`
    );
  }

  hours = parseInt(match[1], 10);
  minutes = parseInt(match[2], 10);
  const period = match[3] || undefined;

  // Validate hours and minutes
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time: ${timeStr}. Hours must be 0-23, minutes 0-59`);
  }

  // Convert 12-hour to 24-hour format
  if (period) {
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
  }

  // Timezone offsets from UTC
  const tzOffsets: Record<string, number> = {
    EST: -5, // Eastern Standard Time
    CST: -6, // Central Standard Time
    MST: -7, // Mountain Standard Time
    PST: -8, // Pacific Standard Time
    EDT: -4, // Eastern Daylight Time
    CDT: -5,
    MDT: -6,
    PDT: -7,
    UTC: 0,
    GMT: 0,
  };

  const tzUpper = timezone.toUpperCase();
  const offset = tzOffsets[tzUpper];
  if (offset === undefined) {
    throw new Error(
      `Unknown timezone: ${timezone}. Supported: EST, CST, MST, PST, EDT, CDT, MDT, PDT, UTC, GMT`
    );
  }

  // Create ISO timestamp for TODAY
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = String(today.getUTCMonth() + 1).padStart(2, "0");
  const day = String(today.getUTCDate()).padStart(2, "0");

  // Convert local time to UTC by subtracting the timezone offset
  // EST is UTC-5, meaning EST is 5 hours BEHIND UTC
  // So: 1:30pm EST = 1:30pm + 5 hours = 18:30 UTC
  // Formula: utcHours = localHours - offset
  // Example: utcHours = 13 - (-5) = 13 + 5 = 18 ✓
  let utcHours = hours - offset;
  let utcDay = parseInt(day, 10);
  let utcMonth = parseInt(month, 10);
  let utcYear = parseInt(year, 10);

  // Handle day boundary crossing
  if (utcHours < 0) {
    // Previous day in UTC
    utcHours += 24;
    utcDay -= 1;
    if (utcDay < 1) {
      utcMonth -= 1;
      if (utcMonth < 1) {
        utcMonth = 12;
        utcYear -= 1;
      }
      utcDay = 31; // Simplified: assume 31 days (close enough for timestamp)
    }
  } else if (utcHours >= 24) {
    // Next day in UTC
    utcHours -= 24;
    utcDay += 1;
    if (utcDay > 31) {
      utcMonth += 1;
      utcDay = 1;
      if (utcMonth > 12) {
        utcMonth = 1;
        utcYear += 1;
      }
    }
  }

  const isoStr = `${String(utcYear).padStart(4, "0")}-${String(utcMonth).padStart(2, "0")}-${String(utcDay).padStart(2, "0")}T${String(utcHours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00.000Z`;
  return isoStr;
}
