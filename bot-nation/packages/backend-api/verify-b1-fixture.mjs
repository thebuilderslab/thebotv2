// Phase B-1 fixture verification — confirms the supervisor-dispatch routing
// decision is correct for canonical finance + non-routable queries.
//
// Run BEFORE deploy: `node verify-b1-fixture.mjs`. Exits 1 on any failure.
//
// What this fixture covers:
//   • classifyQuery() correctly populates suggestedTeam='team-finance' for
//     conversational finance queries that previously fell into type='simple'
//     and therefore landed in the tool-less inline LLM path (the operational
//     pain that motivated B-1).
//   • classifyQuery() does NOT populate suggestedTeam for non-routable
//     queries (e.g., "what's the weather?"), so the supervisor correctly
//     falls through to the existing inline LLM reply (no over-dispatch).
//   • dispatchTextAsTask() honors the new forceTeam/forceTaskKind override
//     and creates a task with the expected agent + kind for type='simple'
//     classifications, bypassing the original "not_action_(simple)" gate.
//
// The full end-to-end path (chat message → handleMessage → dispatch → DO →
// editTelegramCompletion) is exercised by the post-deploy live verification.
// This fixture covers the routing decision in isolation so we don't deploy
// a regression.

const classifierMod  = await import("./verify-out/services/query-classifier.js");
const dispatchMod    = await import("./verify-out/services/dispatch-helper.js");
const { classifyQuery }    = classifierMod;
const { dispatchTextAsTask } = dispatchMod;

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

// ── F1–F4: classifier populates suggestedTeam for canonical finance queries ──
const FINANCE_QUERIES = [
  "what's today's p&l",
  "what's today's P&L?",
  "list my schwab positions",
  "show my portfolio",
  "list my open positions",
  "what are my options",
];

for (const q of FINANCE_QUERIES) {
  const cls = classifyQuery(q);
  if (cls.suggestedTeam === "team-finance") {
    pass(`F1: "${q}" → suggestedTeam=team-finance (type=${cls.type})`);
  } else {
    fail(
      `F1: "${q}" should suggest team-finance`,
      `got suggestedTeam=${cls.suggestedTeam ?? "undefined"} type=${cls.type}`,
    );
  }
}

// ── F5: non-routable queries do NOT get a finance team suggestion ─────────────
const NON_ROUTABLE = [
  "what's the weather today",
  "what is the capital of france",
  "explain machine learning",
  "how does photosynthesis work",
];

for (const q of NON_ROUTABLE) {
  const cls = classifyQuery(q);
  if (cls.suggestedTeam !== "team-finance") {
    pass(`F5: "${q}" → suggestedTeam=${cls.suggestedTeam ?? "undefined"} (no over-dispatch to finance)`);
  } else {
    fail(
      `F5: "${q}" should NOT suggest team-finance`,
      `got suggestedTeam=${cls.suggestedTeam} type=${cls.type}`,
    );
  }
}

// ── Find a confirmed type=simple query for F6/F7 that ALSO has the
// classifier-driven specialist signal. "what are my options" is verified
// to classify as type=simple with suggestedTeam=team-finance — the canonical
// case B-1 was created to fix.
{
  const cls = classifyQuery("what are my options");
  if (cls.type !== "simple" || cls.suggestedTeam !== "team-finance") {
    fail(
      `F6/F7 prerequisite: "what are my options" should be type=simple + suggestedTeam=team-finance`,
      `got type=${cls.type} suggestedTeam=${cls.suggestedTeam}`,
    );
  } else {
    pass(`F6/F7 prereq: "what are my options" → type=simple + suggestedTeam=team-finance`);
  }
}

// ── F6: dispatchTextAsTask without forceTeam refuses non-action classifications
{
  const stubEnv = makeStubEnv();
  const result = await dispatchTextAsTask(
    stubEnv,
    5281111124,
    "what are my options", // type=simple per the classifier
    { sendAck: false },
  );
  if (!result.ok && result.reason && result.reason.startsWith("not_action_")) {
    pass(`F6: dispatchTextAsTask without forceTeam refuses non-action (reason=${result.reason})`);
  } else {
    fail(
      `F6: should refuse non-action without forceTeam`,
      `got ${JSON.stringify(result)}`,
    );
  }
}

// ── F7: dispatchTextAsTask WITH forceTeam bypasses the type gate ──────────────
{
  const stubEnv = makeStubEnv();
  const result = await dispatchTextAsTask(
    stubEnv,
    5281111124,
    "what are my options",
    {
      sendAck: false,
      forceTeam: "team-finance",
      forceTaskKind: "research",
      sourceLabel: "supervisor_dispatch",
    },
  );
  const dispatchOk =
    result.ok === true &&
    typeof result.taskId === "string" && result.taskId.length > 0 &&
    result.agentId === "agent-finance-lead";
  const correctInsert = stubEnv.__inserts.some((row) =>
    row.kind === "research" &&
    row.assigned_agent_id === "agent-finance-lead" &&
    row.team_id === "team-finance",
  );
  if (dispatchOk && correctInsert) {
    pass(`F7: forceTeam bypass creates task with assigned_agent_id=agent-finance-lead, kind=research`);
  } else {
    fail(
      `F7: forceTeam bypass should create finance-lead task`,
      `result=${JSON.stringify(result)} inserts=${JSON.stringify(stubEnv.__inserts)}`,
    );
  }
}

// ── F8: trivial-reply gate still applies even with forceTeam (defense in depth)
{
  const stubEnv = makeStubEnv();
  const result = await dispatchTextAsTask(
    stubEnv,
    5281111124,
    "ok", // 2 chars, would also match trivial-reply regex
    { forceTeam: "team-finance", sendAck: false },
  );
  // Either too_short OR trivial_reply is acceptable — both are pre-classifier
  // gates that should still fire.
  if (!result.ok && (result.reason === "too_short" || result.reason === "trivial_reply")) {
    pass(`F8: trivial/short gate still applies with forceTeam (reason=${result.reason})`);
  } else {
    fail(
      `F8: trivial/short reply should still be refused`,
      `got ${JSON.stringify(result)}`,
    );
  }
}

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Stub Env factory — minimal mocks of D1 + AGENT_ACTOR so dispatchTextAsTask
// can run end-to-end without touching production D1 / DOs.

function makeStubEnv() {
  const inserts = [];
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return {
              async run() {
                if (/INSERT INTO tasks/i.test(sql)) {
                  inserts.push({
                    id:                 binds[0],
                    kind:               binds[1],
                    assigned_agent_id:  binds[2],
                    team_id:            binds[3],
                    input_json:         binds[4],
                  });
                }
                return { success: true };
              },
              async first() { return null; },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    },
    TELEGRAM_BOT_TOKEN: "fake-bot-token",
    AGENT_ACTOR: {
      idFromName(name) { return { name }; },
      get(_id) {
        return {
          async fetch(_url, _init) {
            return new Response(JSON.stringify({ queued: true, queueLength: 1 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        };
      },
    },
    // Test introspection
    __inserts: inserts,
  };
}
