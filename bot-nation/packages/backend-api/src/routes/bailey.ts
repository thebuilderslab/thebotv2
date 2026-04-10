/**
 * Bailey Group Lead Ingest & Scoring
 * Accepts manual CSV uploads → spawns propstream_lead_score tasks
 */

import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { run, query, queryOne } from "../db/schema";

export const baileyRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

interface PropertyRecord {
  address: string;
  owner_name: string;
  phone: string;
  rented_units: number;
  total_units: number;
  equity_percent: number;
  estimated_value: number;
  property_status: string;
  timeline?: string;
  owner_email?: string;
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim().replace(/^"|"$/g, ""));
  return values;
}

function parseCSV(csvText: string): PropertyRecord[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) throw new Error("CSV must have header + at least 1 data row");

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
  const records: PropertyRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const record: Record<string, any> = {};

    headers.forEach((header, idx) => {
      record[header] = values[idx];
    });

    records.push({
      address: record.address || "",
      owner_name: record.owner_name || "",
      phone: record.phone || "",
      rented_units: parseInt(record.rented_units) || 0,
      total_units: parseInt(record.total_units) || 0,
      equity_percent: parseFloat(record.equity_percent) || 0,
      estimated_value: parseInt(record.estimated_value) || 0,
      property_status: record.property_status || "",
      timeline: record.timeline,
      owner_email: record.owner_email,
    });
  }

  return records;
}

baileyRouter.post("/api/bailey/ingest-gdrive", async (req, env: Env) => {
  try {
    const contentType = req.headers.get("content-type") || "";
    let csvText = "";

    // Handle multipart form data (file upload)
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("csv") as File;
      if (!file) throw new Error("No CSV file provided");
      csvText = await file.text();
    }
    // Handle raw CSV text in body
    else if (contentType.includes("text/csv") || contentType.includes("application/json")) {
      const body = (await req.json()) as { csv: string };
      csvText = body.csv;
    }

    if (!csvText) throw new Error("No CSV content provided");

    // Parse CSV
    const records = parseCSV(csvText);
    if (records.length === 0) throw new Error("No valid property records found");

    // Check for duplicates
    const existingAddresses = await query<{ property_address: string }>(
      env.DB,
      `SELECT DISTINCT json_extract(input, '$.property_address') as property_address
       FROM tasks
       WHERE kind = 'propstream_lead_score' AND status IN ('pending', 'running', 'completed')`,
      [],
    );

    const existingSet = new Set(existingAddresses.map((a) => a.property_address));
    const newRecords = records.filter((r) => !existingSet.has(r.address));
    const duplicateCount = records.length - newRecords.length;

    // Spawn tasks for new properties
    const now = new Date().toISOString();
    const spawnedTaskIds: string[] = [];

    for (const record of newRecords) {
      const taskId = crypto.randomUUID();
      const input = JSON.stringify({
        property_address: record.address,
        owner_name: record.owner_name,
        phone: record.phone,
        rented_units: record.rented_units,
        total_units: record.total_units,
        equity_percent: record.equity_percent,
        estimated_value: record.estimated_value,
        property_status: record.property_status,
        timeline: record.timeline || "Flexible",
        owner_email: record.owner_email,
      });

      await run(env.DB,
        `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, spawn_depth, created_at, updated_at)
         VALUES (?, 'propstream_lead_score', 'pending', 'agent-bailey-scorer', 'team-bailey', ?, 0, ?, ?)`,
        [taskId, input, now, now],
      );

      spawnedTaskIds.push(taskId);
    }

    // Send Telegram notification
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && spawnedTaskIds.length > 0) {
      const message = `🏢 <b>Bailey Group — CSV Ingest Complete</b>\n\n` +
                      `✅ New leads: ${newRecords.length}\n` +
                      `⚠️  Duplicates skipped: ${duplicateCount}\n` +
                      `📋 Total in batch: ${records.length}\n\n` +
                      `🤖 Agent: agent-bailey-scorer\n` +
                      `⏳ Status: ${newRecords.length} tasks queued for scoring\n\n` +
                      `Task IDs (first 3):\n${spawnedTaskIds.slice(0, 3).map((id) => `├─ ${id.slice(0, 12)}...`).join("\n")}`;

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
        console.error(`[Bailey] Telegram notification failed: ${err}`);
      }
    }

    return Response.json({
      status: "ok",
      summary: {
        total_records: records.length,
        new_leads: newRecords.length,
        duplicates_skipped: duplicateCount,
        tasks_spawned: spawnedTaskIds.length,
        task_ids: spawnedTaskIds,
      },
    });
  } catch (err) {
    return Response.json({
      status: "error",
      error: String(err),
    }, { status: 400 });
  }
});

/**
 * Health check for Bailey ingest pipeline
 */
baileyRouter.get("/api/bailey/health", async () => {
  return Response.json({
    status: "ready",
    endpoint: "/api/bailey/ingest-gdrive",
    methods: ["POST"],
    accepts: ["multipart/form-data (CSV file)", "application/json with {csv: '...'}"],
  });
});

/**
 * Execute propstream_lead_score task
 */
baileyRouter.post("/api/bailey/execute/:id", async (req, env: Env) => {
  const taskId = req.params["id"];
  if (!taskId) return new Response("Bad Request", { status: 400 });

  try {
    const { scoreLead } = await import("../services/bailey-scorer");

    // Get task
    const task = await queryOne<{
      id: string;
      kind: string;
      status: string;
      input: string;
      assigned_agent_id: string;
      team_id: string;
    }>(
      env.DB,
      `SELECT id, kind, status, input, assigned_agent_id, team_id FROM tasks WHERE id = ?`,
      [taskId],
    );

    if (!task) return new Response("Task not found", { status: 404 });
    if (task.kind !== "propstream_lead_score") {
      return new Response("Task is not a propstream_lead_score", { status: 400 });
    }

    // Parse input
    const input = JSON.parse(task.input);

    // Score the lead
    const score = await scoreLead(input, env.ANTHROPIC_API_KEY);

    // Update task with output
    const now = new Date().toISOString();
    const output = {
      score: score.score,
      disposition: score.disposition,
      reasoning: score.reasoning,
      call_angle: score.call_angle,
      script_variables: score.script_variables,
      confidence: score.confidence,
    };

    await run(env.DB,
      `UPDATE tasks SET status = 'completed', output = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(output), now, taskId],
    );

    // Send Telegram notification
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const emoji = {
        hot: "🔥",
        warm: "🟠",
        cold: "❄️",
      }[score.disposition] || "❓";

      const message = `${emoji} <b>${score.disposition.toUpperCase()}</b> — ${score.owner_name}\n\n` +
                      `<code>Score: ${score.score}/12 | Confidence: ${score.confidence}%</code>\n\n` +
                      `📍 ${score.property_address}\n` +
                      `💡 <i>${score.call_angle}</i>\n\n` +
                      `✅ Scored by agent-bailey-scorer`;

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
        console.error(`[Bailey Execute] Telegram notification failed: ${err}`);
      }
    }

    return Response.json({
      status: "ok",
      task_id: taskId,
      result: {
        disposition: score.disposition,
        score: score.score,
        confidence: score.confidence,
        reasoning: score.reasoning,
      },
    });
  } catch (err) {
    console.error(`[Bailey Execute] Error: ${err}`);
    return Response.json({
      status: "error",
      error: String(err),
    }, { status: 500 });
  }
});
