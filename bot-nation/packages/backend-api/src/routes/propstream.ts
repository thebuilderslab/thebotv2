/**
 * PropStream CSV Import & Call Scheduling
 * Accepts PropStream exports → converts to Naomi calling tasks
 * Handles multi-number calling with DNC + retry scheduling
 */

import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { run, query, queryOne } from "../db/schema";
import { transformPropStreamRow, validateCallable, generateCallReport } from "../services/propstream-transformer";
import { parseTimeString } from "../utils/time-parser";
import Papa from "papaparse";

export const propstreamRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

interface PropStreamRow {
  Address: string;
  "Unit #": string;
  City: string;
  State: string;
  Zip: string;
  County: string;
  APN: string;
  "Phone 1": string;
  "Phone 1 Type": string;
  "Phone 1 DNC": string;
  "Phone 2": string;
  "Phone 2 Type": string;
  "Phone 2 DNC": string;
  "Phone 3": string;
  "Phone 3 Type": string;
  "Phone 3 DNC": string;
  "Phone 4": string;
  "Phone 4 Type": string;
  "Phone 4 DNC": string;
  "Phone 5": string;
  "Phone 5 Type": string;
  "Phone 5 DNC": string;
  "Owner 1 First Name": string;
  "Owner 1 Last Name": string;
  "Owner 2 First Name": string;
  "Owner 2 Last Name": string;
  "Property Status": string;
  Notes: string;
  "Est. Value": number;
  "Est. Equity": number;
  "Est. Loan-to-Value": number;
  "Property Type": string;
}

/**
 * POST /api/propstream/import-csv
 * Upload PropStream export CSV → schedule calling tasks
 */
propstreamRouter.post("/api/propstream/import-csv", async (req: IRequest, env: Env) => {
  try {
    const contentType = req.headers.get("content-type") || "";
    let csvText = "";
    let startTime: string | undefined;
    let scheduledFor: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("csv") as File;
      if (!file) throw new Error("No CSV file provided");
      csvText = await file.text();
      startTime = (formData.get("start_time") as string) || undefined;
      scheduledFor = (formData.get("scheduled_for") as string) || undefined;
    } else if (contentType.includes("text/csv") || contentType.includes("application/json")) {
      const body = (await req.json()) as {
        csv: string;
        start_time?: string;
        scheduled_for?: string;
      };
      csvText = body.csv;
      startTime = body.start_time;
      scheduledFor = body.scheduled_for;
    } else {
      throw new Error("Invalid content type. Use multipart/form-data or application/json with csv field");
    }

    if (!csvText) throw new Error("No CSV content provided");

    // Calculate scheduled_for timestamp
    let targetScheduledFor: string | null = null;
    if (scheduledFor) {
      // Validate ISO 8601 format
      targetScheduledFor = new Date(scheduledFor).toISOString();
    } else if (startTime) {
      // Parse time string (e.g., "1:30pm") to ISO timestamp for TODAY
      targetScheduledFor = parseTimeString(startTime);
    }

    // Parse CSV
    const parseResult = Papa.parse(csvText, {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: true,
    });

    if (parseResult.errors.length > 0) {
      throw new Error(`CSV parse error: ${parseResult.errors[0].message}`);
    }

    const rows = parseResult.data as PropStreamRow[];
    if (rows.length === 0) throw new Error("No valid property records found");

    // Transform rows
    const tasks = rows
      .map((row, idx) => transformPropStreamRow(row, idx))
      .filter((task) => validateCallable(task).callable);

    // Check duplicates
    const existingAddresses = await query<{ address: string }>(
      env.DB,
      `SELECT DISTINCT json_extract(input, '$.property_address') as address
       FROM tasks
       WHERE kind = 'propstream_outbound_call' AND status IN ('pending', 'running', 'completed')`,
      [],
    );

    const existingSet = new Set(existingAddresses.map((a) => a.address));
    const newTasks = tasks.filter((t) => !existingSet.has(t.propertyAddress));
    const duplicateCount = tasks.length - newTasks.length;

    // Spawn calling tasks
    const now = new Date().toISOString();
    const spawnedTaskIds: string[] = [];

    for (const task of newTasks) {
      const taskId = crypto.randomUUID();

      // Select first callable phone
      const callablePhone = task.availablePhones[0];
      if (!callablePhone) continue;

      const input = JSON.stringify({
        property_address: task.propertyAddress,
        owner_name: task.ownerName,
        owner_first_name: task.ownerFirstName,
        county: task.county,
        property_type: task.propertyType,
        est_value: task.estValue,
        est_equity: task.estEquity,
        est_ltv: task.estLTV,
        phone_numbers: task.phoneNumbers,
        available_phones: task.availablePhones,
        current_phone: callablePhone.number,
        current_phone_type: callablePhone.type,
        notes: task.notes,
        score: task.score,
        disposition: task.disposition,
      });

      await run(
        env.DB,
        `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, scheduled_for, spawn_depth, created_at, updated_at)
         VALUES (?, 'propstream_outbound_call', 'pending', 'agent-bailey-voice', 'team-bailey', ?, ?, 0, ?, ?)`,
        [taskId, input, targetScheduledFor, now, now],
      );

      spawnedTaskIds.push(taskId);
    }

    // Generate report
    const report = generateCallReport(tasks);

    // Send Telegram notification
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      let schedulingInfo = "";
      if (targetScheduledFor) {
        const scheduledTime = new Date(targetScheduledFor).toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        });
        schedulingInfo = `⏰ <b>Scheduled for:</b> ${scheduledTime} EST\n\n`;
      } else {
        schedulingInfo = `⚡ <b>Starting immediately</b>\n\n`;
      }

      const message = `📞 <b>PropStream Import Complete</b>\n\n` +
                      schedulingInfo +
                      `Total properties: ${tasks.length}\n` +
                      `Callable: ${report.callableProperties}\n` +
                      `Non-callable: ${report.nonCallableProperties}\n\n` +
                      `📊 Score breakdown:\n` +
                      `🔥 HOT: ${report.summary.hotProperties}\n` +
                      `🟠 WARM: ${report.summary.warmProperties}\n` +
                      `❄️  COLD: ${report.summary.coldProperties}\n` +
                      `❓ Unscored: ${report.summary.unscored}\n\n` +
                      `☎️  Phone numbers:\n` +
                      `Total: ${report.totalPhoneNumbers}\n` +
                      `Callable: ${report.callablePhoneNumbers}\n` +
                      `DNC: ${report.dncPhoneNumbers}\n\n` +
                      `Tasks spawned: ${spawnedTaskIds.length}`;

      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "HTML",
          }),
        });
      } catch (err) {
        console.error(`[PropStream] Telegram notification failed: ${err}`);
      }
    }

    return Response.json({
      status: "ok",
      summary: {
        total_properties: tasks.length,
        callable_properties: report.callableProperties,
        non_callable_properties: report.nonCallableProperties,
        tasks_spawned: spawnedTaskIds.length,
        duplicates_skipped: duplicateCount,
        task_ids: spawnedTaskIds,
      },
      report,
    });
  } catch (err) {
    return Response.json(
      {
        status: "error",
        error: String(err),
      },
      { status: 400 },
    );
  }
});

/**
 * GET /api/propstream/health
 */
propstreamRouter.get("/api/propstream/health", async () => {
  return Response.json({
    status: "ready",
    endpoint: "/api/propstream/import-csv",
    methods: ["POST"],
    accepts: ["multipart/form-data (CSV file)", "application/json with {csv: '...'}"],
  });
});
