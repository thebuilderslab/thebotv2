/**
 * Retell Voice Queue Service
 * Creates voice calls for HOT-scored leads
 * Manages call scheduling and tracking
 */

interface PhoneNumber {
  number: string;
  type: string;
  dnc: boolean;
  attempted?: boolean;
  result?: "reached" | "voicemail" | "dnc" | "invalid" | "no_answer";
}

interface PropertyData {
  property_address: string;
  owner_name: string;
  phone?: string; // Legacy: single phone
  phone_numbers?: PhoneNumber[]; // New: multiple phones with DNC
  rented_units?: number;
  total_units?: number;
  equity_percent?: number;
  estimated_value?: number;
  property_status?: string;
  timeline?: string;
  owner_email?: string;
}

interface ScoreData {
  score: number;
  disposition: "hot" | "warm" | "cold";
  reasoning: string;
  call_angle: string;
  script_variables: Record<string, string>;
  confidence: number;
}

export interface RetellCallConfig {
  to_number: string;
  from_number?: string;
  override_agent_id?: string;
  task_id: string;
  property_address: string;
  owner_name: string;
  call_angle: string;
  script_variables: Record<string, string>;
}

/**
 * Select next callable phone number
 * Skip DNC numbers, try in order (primary → secondary → etc)
 */
function selectNextPhone(property: PropertyData): string | null {
  if (!property.phone_numbers) {
    // Legacy: use single phone field
    return property.phone || null;
  }

  // Find first non-DNC, non-attempted number
  for (const phone of property.phone_numbers) {
    if (!phone.dnc && !phone.attempted) {
      return phone.number;
    }
  }

  return null; // All phones DNC or already attempted
}

/**
 * Create Retell voice call for a HOT/WARM property
 * Handles multiple phone numbers + DNC skipping
 */
export async function queueRetellVoiceCall(
  property: PropertyData,
  score: ScoreData,
  retellApiKey: string,
  taskId: string,
  agentId: string,
): Promise<{ call_id: string; status: string; scheduled_for: string; phone: string } | null> {
  // Only queue HOT or WARM leads
  if (score.disposition !== "hot" && score.disposition !== "warm") return null;

  try {
    // Select phone: prefer phone_numbers array (multi-number), fall back to single phone
    const phoneToCall = selectNextPhone(property);
    if (!phoneToCall) {
      console.log(`[Retell Queue] Skipping ${property.owner_name}: All phone numbers DNC or already attempted`);
      return null;
    }

    // Prepare dynamic variables for Retell agent
    const firstName = property.owner_name.split(" ")[0];
    const dynamicVariables = {
      owner_name: property.owner_name,
      owner_first_name: firstName,
      property_address: property.property_address,
      total_units: String(property.total_units || ""),
      rented_units: String(property.rented_units || ""),
      equity_percent: String(property.equity_percent || ""),
      estimated_value: property.estimated_value ? `$${property.estimated_value.toLocaleString()}` : "",
      call_angle: score.call_angle,
      main_challenge: score.script_variables.property_status || "investment opportunity",
      ...score.script_variables,
    };

    // Call Retell API
    const payloadToSend = {
      agent_id: agentId,
      to_number: phoneToCall,
      from_number: "+1-860-901-0356", // Retell-assigned Twilio number
      dynamic_variables: dynamicVariables,
      metadata: {
        task_id: taskId,
        property_address: property.property_address,
        owner_name: property.owner_name,
        phone_called: phoneToCall,
        lead_score: score.score,
        disposition: score.disposition,
        confidence: score.confidence,
      },
    };

    console.log(`[Retell Queue] Creating call for ${property.owner_name} at ${phoneToCall}`);

    const retellResponse = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${retellApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payloadToSend),
    });

    if (!retellResponse.ok) {
      const error = await retellResponse.text();
      console.error(`[Retell API Error] ${retellResponse.status}: ${error}`);
      throw new Error(`Retell API error: ${retellResponse.status} - ${error}`);
    }

    const data = (await retellResponse.json()) as any;
    const callId = data.call_id || `call-${crypto.randomUUID().slice(0, 8)}`;
    const scheduledFor = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    console.log(`[Retell Queue] Voice call created: ${callId} for ${property.owner_name}`);

    return {
      call_id: callId,
      status: "queued",
      scheduled_for: scheduledFor,
      phone: phoneToCall,
    };
  } catch (err) {
    console.error(`[Retell Queue] Error creating call: ${err}`);
    return null;
  }
}

/**
 * Format Retell call as Telegram notification
 */
export function formatRetellNotification(
  property: PropertyData,
  score: ScoreData,
  callId: string,
  scheduledFor: string,
): string {
  return `📞 <b>LEAD → NAOMI VOICE CALL QUEUED</b>\n\n` +
         `🏢 Property: ${property.property_address}\n` +
         `👤 Owner: ${property.owner_name}\n` +
         `📱 Phone: ${property.phone}\n\n` +
         `📊 Score: ${score.score}/12 (${score.confidence}% confidence)\n` +
         `💡 Pitch: <i>${score.call_angle}</i>\n\n` +
         `☎️  Call ID: <code>${callId}</code>\n` +
         `⏰ Scheduled: ${new Date(scheduledFor).toLocaleTimeString()}\n` +
         `🎯 Agent: Naomi (Bailey Group AI Acquisitions Specialist)\n\n` +
         `Status: Queued for execution`;
}

/**
 * Niamo Voice Script Template
 * Dynamic based on property profile
 */
export function generateNiamoScript(property: PropertyData, score: ScoreData): string {
  const firstName = property.owner_name.split(" ")[0];
  const unitsText = property.rented_units === 0 ? "currently vacant" : `${property.rented_units} rented`;

  return `Hi ${firstName}, this is Niamo from Bailey Group. We specialize in off-market acquisitions for property owners like you.

I came across your property at ${property.property_address} — I see you have ${property.total_units} total units with ${unitsText}, and based on current market conditions, I think there could be a real opportunity here.

${score.call_angle}

Do you have 15 minutes this week to chat about what options might make sense for you?`;
}
