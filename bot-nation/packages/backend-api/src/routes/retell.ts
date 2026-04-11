/**
 * Retell AI Voice Integration
 * Handles post-call callbacks from Retell (Niamo voice agent)
 * Processes transcripts, extracts data, spawns property tour scheduling
 */

import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";

export const retellRouter = AutoRouter();

interface RetellCallCompleteEvent {
  call_id: string;
  phone_number: string;
  owner_name: string;
  call_duration: number;  // seconds
  transcript: string;
  disposition: "qualified" | "warm" | "not_interested" | "dnc" | "wrong_number" | "no_answer";
  extracted_data: {
    email?: string;
    property_address: string;
    rented_units?: number;
    total_units?: number;
    main_challenge?: string;
    timeline?: string;
    availability?: string[];
    condition_notes?: string;
  };
  recording_url: string;
}

retellRouter.post("/api/retell/call-complete", async (req, env: Env) => {
  try {
    const payload = (await req.json()) as any;

    // Handle Retell webhook test (empty payload)
    if (!payload.call_id) {
      return Response.json({ status: "ok", webhook: "ready" });
    }

    const callData = payload as RetellCallCompleteEvent;

    const {
      call_id,
      phone_number,
      owner_name,
      call_duration,
      transcript,
      disposition,
      extracted_data,
      recording_url,
    } = callData;

  const now = new Date().toISOString();
  const callRecord = crypto.randomUUID();

  // 1. Store call record in database
  await run(env.DB,
    `INSERT INTO artifacts (id, kind, name, url, content, task_id, created_at, updated_at)
     VALUES (?, 'retell_call', ?, ?, ?, NULL, ?, ?)`,
    [
      callRecord,
      `Call: ${owner_name} (${call_id})`,
      recording_url,
      JSON.stringify({
        call_id,
        phone_number,
        owner_name,
        disposition,
        duration: call_duration,
        extracted_data,
        transcript: transcript.slice(0, 5000),  // Store first 5000 chars
        recording_url,
      }),
      now,
      now,
    ],
  );

  // 2. If QUALIFIED → spawn schedule_property_tour task
  if (disposition === "qualified" && extracted_data.email && extracted_data.property_address) {
    const tourTaskId = crypto.randomUUID();

    await run(env.DB,
      `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, spawn_depth, created_at, updated_at)
       VALUES (?, 'schedule_property_tour', 'pending', 'agent-bailey-crm', 'team-bailey', ?, 0, ?, ?)`,
      [
        tourTaskId,
        JSON.stringify({
          call_record_id: callRecord,
          owner_name,
          owner_email: extracted_data.email,
          property_address: extracted_data.property_address,
          availability: extracted_data.availability ?? ["Tuesday PM", "Wednesday PM"],
          extracted_data,
          transcript: transcript.slice(0, 2000),
        }),
        now,
        now,
      ],
    );

    // 3. Notify via Telegram
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `🎯 <b>QUALIFIED LEAD → Tour Scheduling</b>\n\n` +
                  `Owner: ${owner_name}\n` +
                  `Property: ${extracted_data.property_address}\n` +
                  `Units: ${extracted_data.rented_units ?? "N/A"}/${extracted_data.total_units ?? "N/A"}\n` +
                  `Availability: ${(extracted_data.availability ?? []).join(", ")}\n\n` +
                  `Disposition: QUALIFIED (wants offer)\n` +
                  `Call duration: ${call_duration}s\n\n` +
                  `Task spawned: schedule_property_tour\n` +
                  `Status: Calendar invite ready\n\n` +
                  `[Brief Inspector] [View Transcript]`,
            parse_mode: "HTML",
          }),
        });
      } catch (err) {
        console.error(`[Retell] Telegram notification failed: ${err}`);
      }
    }
  } else {
    // Non-qualified disposition - log and notify
    const statusEmoji: Record<string, string> = {
      qualified: "🎯",
      warm: "🟠",
      not_interested: "❌",
      dnc: "🚫",
      wrong_number: "📵",
      no_answer: "📞",
    };

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `${statusEmoji[disposition] ?? "❓"} <b>Call Completed</b>\n\n` +
                  `Owner: ${owner_name}\n` +
                  `Phone: ${phone_number}\n` +
                  `Disposition: ${disposition}\n` +
                  `Duration: ${call_duration}s\n\n` +
                  `Call record saved for review.`,
            parse_mode: "HTML",
          }),
        });
      } catch (err) {
        console.error(`[Retell] Telegram notification failed: ${err}`);
      }
    }
  }

    return Response.json({ status: "ok", saved: true, call_id });
  } catch (err) {
    console.error(`[Retell Webhook] Error: ${err}`);
    return Response.json({ status: "error", error: String(err) }, { status: 500 });
  }
});

/**
 * Health check endpoint for Retell webhook configuration
 */
retellRouter.get("/api/retell/health", async () => {
  return Response.json({ status: "ready", webhook: "/retell/call-complete" });
});
