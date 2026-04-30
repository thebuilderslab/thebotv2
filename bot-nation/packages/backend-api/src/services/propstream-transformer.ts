/**
 * PropStream CSV Transformer
 * Converts PropStream export format → Naomi calling format
 * Handles multiple phone numbers with DNC flags + retry scheduling
 */

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

interface PhoneNumber {
  number: string;
  type: string;
  dnc: boolean;
  attempted?: boolean;
  result?: "reached" | "voicemail" | "dnc" | "invalid" | "no_answer";
  attemptedAt?: string;
  nextRetry?: string;
}

interface NaomiCallTask {
  propertyId: string;
  propertyAddress: string;
  abbreviatedAddress: string;
  ownerName: string;
  ownerFirstName: string;
  county: string;
  estValue: number;
  estEquity: number;
  estLTV: number;
  propertyType: string;
  phoneNumbers: PhoneNumber[];
  availablePhones: PhoneNumber[];
  callablePhoneCount: number;
  allPhonesDNC: boolean;
  notes: string;
  hasScore: boolean;
  score?: number;
  disposition?: "hot" | "warm" | "cold";
}

export function transformPropStreamRow(
  row: PropStreamRow,
  rowIndex: number,
): NaomiCallTask {
  // Build address
  const unitStr = row["Unit #"] ? ` #${row["Unit #"]}` : "";
  const propertyAddress = `${row.Address}${unitStr}, ${row.City}, ${row.State} ${row.Zip}`;
  const abbreviatedAddress = row.Address.split(" ").slice(0, 2).join(" ");

  // Extract owner name
  const firstName = row["Owner 1 First Name"] || "";
  const lastName = row["Owner 1 Last Name"] || "";
  const ownerName = `${firstName} ${lastName}`.trim() || "Unknown Owner";

  // Collect phone numbers
  const phoneNumbers: PhoneNumber[] = [];
  for (let i = 1; i <= 5; i++) {
    const phoneKey = `Phone ${i}` as keyof PropStreamRow;
    const typeKey = `Phone ${i} Type` as keyof PropStreamRow;
    const dncKey = `Phone ${i} DNC` as keyof PropStreamRow;

    const phone = row[phoneKey];
    if (phone && String(phone).trim()) {
      phoneNumbers.push({
        number: String(phone).trim(),
        type: String(row[typeKey] || "Unknown"),
        dnc: String(row[dncKey] || "").includes("DNC") || String(row[dncKey] || "").includes("Public DNC"),
      });
    }
  }

  // Filter: callable numbers (not DNC)
  const availablePhones = phoneNumbers.filter((p) => !p.dnc);
  const allPhonesDNC = phoneNumbers.length > 0 && availablePhones.length === 0;

  // Extract score from Notes
  const scoreMatch = String(row.Notes || "").match(/SCORE:\s*(\d+)/);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : undefined;
  const disposition =
    score === undefined ? undefined : score >= 8 ? "hot" : score >= 4 ? "warm" : "cold";

  return {
    propertyId: `prop-${rowIndex}`,
    propertyAddress,
    abbreviatedAddress,
    ownerName,
    ownerFirstName: firstName,
    county: row.County || "",
    estValue: Number(row["Est. Value"]) || 0,
    estEquity: Number(row["Est. Equity"]) || 0,
    estLTV: Number(row["Est. Loan-to-Value"]) || 0,
    propertyType: row["Property Type"] || "",
    phoneNumbers,
    availablePhones,
    callablePhoneCount: availablePhones.length,
    allPhonesDNC,
    notes: String(row.Notes || "").slice(0, 200),
    hasScore: !!score,
    score,
    disposition,
  };
}

export function validateCallable(task: NaomiCallTask): {
  callable: boolean;
  reason?: string;
} {
  if (task.allPhonesDNC) {
    return {
      callable: false,
      reason: `All ${task.phoneNumbers.length} phone numbers marked DNC`,
    };
  }

  if (task.callablePhoneCount === 0) {
    return {
      callable: false,
      reason: "No valid phone numbers found",
    };
  }

  if (!task.ownerName) {
    return {
      callable: false,
      reason: "No owner name found",
    };
  }

  return {
    callable: true,
  };
}

export interface CallExecutionReport {
  totalProperties: number;
  callableProperties: number;
  nonCallableProperties: number;
  totalPhoneNumbers: number;
  callablePhoneNumbers: number;
  dncPhoneNumbers: number;
  properties: {
    callable: NaomiCallTask[];
    nonCallable: Array<NaomiCallTask & { skipReason: string }>;
  };
  summary: {
    hotProperties: number;
    warmProperties: number;
    coldProperties: number;
    unscored: number;
  };
}

export function generateCallReport(tasks: NaomiCallTask[]): CallExecutionReport {
  const callable: NaomiCallTask[] = [];
  const nonCallable: Array<NaomiCallTask & { skipReason: string }> = [];

  for (const task of tasks) {
    const validation = validateCallable(task);
    if (validation.callable) {
      callable.push(task);
    } else {
      nonCallable.push({
        ...task,
        skipReason: validation.reason || "Unknown",
      });
    }
  }

  const totalPhones = tasks.reduce((sum, t) => sum + t.phoneNumbers.length, 0);
  const callablePhones = tasks.reduce((sum, t) => sum + t.callablePhoneCount, 0);
  const dncPhones = tasks.reduce(
    (sum, t) => sum + t.phoneNumbers.filter((p) => p.dnc).length,
    0,
  );

  return {
    totalProperties: tasks.length,
    callableProperties: callable.length,
    nonCallableProperties: nonCallable.length,
    totalPhoneNumbers: totalPhones,
    callablePhoneNumbers: callablePhones,
    dncPhoneNumbers: dncPhones,
    properties: {
      callable,
      nonCallable,
    },
    summary: {
      hotProperties: callable.filter((t) => t.disposition === "hot").length,
      warmProperties: callable.filter((t) => t.disposition === "warm").length,
      coldProperties: callable.filter((t) => t.disposition === "cold").length,
      unscored: callable.filter((t) => !t.hasScore).length,
    },
  };
}
