// PR A3 fixture verification — exercises the admin replay route handler with
// a stub Env (mocked DB, mocked AGENT_ACTOR namespace). Runs BEFORE deploy.
// Exits 1 on any failed assertion.
//
// We compile admin.ts to verify-out/ via tsc + then import the router and
// drive it through Hono's Request → Response interface. This tests the
// actually-shipped handler, not a copy of its logic.
//
// Build step (run before this file):
//   pnpm exec tsc --module esnext --target es2022 --moduleResolution bundler \
//     --outDir verify-out --ignoreConfig src/routes/admin.ts \
//     src/utils/telegram-format.ts src/db/schema.ts

const { adminRouter } = await import("./verify-out/routes/admin.js");

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

const SECRET = "test-deploy-secret";

// ── Stub env factory ────────────────────────────────────────────────────────
function makeEnv({ tasks = {}, doForwarder = null } = {}) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return {
              async first() {
                if (sql.includes("FROM tasks WHERE id")) {
                  return tasks[binds[0]] ?? null;
                }
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    },
    DEPLOY_WEBHOOK_SECRET: SECRET,
    TELEGRAM_BOT_TOKEN: "fake-bot-token",
    AGENT_ACTOR: {
      idFromName(name) {
        return { name };
      },
      get(_id) {
        return {
          async fetch(_url, init) {
            if (doForwarder) return doForwarder(init);
            return new Response(
              JSON.stringify({ ok: true, taskId: "stub", totalChunks: 1, sentChunks: 1 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        };
      },
    },
  };
}

async function callRouter(env, init) {
  return adminRouter.fetch(init.req, env);
}

function buildReq(method, url, headers = {}) {
  return { req: new Request(url, { method, headers }) };
}

// ── F1: missing x-deploy-secret → 401 ───────────────────────────────────────
{
  const env = makeEnv();
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/abc-123"));
  if (res.status === 401) pass("F1: missing x-deploy-secret → 401");
  else fail("F1: missing secret should 401", `got ${res.status}`);
}

// ── F2: bad secret → 401 ────────────────────────────────────────────────────
{
  const env = makeEnv();
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/abc-123", {
    "x-deploy-secret": "wrong",
  }));
  if (res.status === 401) pass("F2: bad x-deploy-secret → 401");
  else fail("F2: bad secret should 401", `got ${res.status}`);
}

// ── F3: unknown task id → 404 ───────────────────────────────────────────────
{
  const env = makeEnv({ tasks: {} });
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/does-not-exist", {
    "x-deploy-secret": SECRET,
  }));
  if (res.status === 404) pass("F3: unknown task id → 404");
  else fail("F3: unknown id should 404", `got ${res.status}`);
}

// ── F4: task exists but telegram_chat_id null → 400 ─────────────────────────
{
  const env = makeEnv({
    tasks: {
      "task-no-chat": {
        id: "task-no-chat",
        telegram_chat_id: null,
        output: "some output",
        assigned_agent_id: "agent-x",
      },
    },
  });
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/task-no-chat", {
    "x-deploy-secret": SECRET,
  }));
  if (res.status === 400) pass("F4: missing telegram_chat_id → 400");
  else fail("F4: missing chat_id should 400", `got ${res.status}`);
}

// ── F5: task exists but output null → 400 ───────────────────────────────────
{
  const env = makeEnv({
    tasks: {
      "task-no-output": {
        id: "task-no-output",
        telegram_chat_id: 5281111124,
        output: null,
        assigned_agent_id: "agent-x",
      },
    },
  });
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/task-no-output", {
    "x-deploy-secret": SECRET,
  }));
  if (res.status === 400) pass("F5: missing output → 400");
  else fail("F5: missing output should 400", `got ${res.status}`);
}

// ── F5b: task exists but assigned_agent_id null → 400 ───────────────────────
{
  const env = makeEnv({
    tasks: {
      "task-no-agent": {
        id: "task-no-agent",
        telegram_chat_id: 5281111124,
        output: "some output",
        assigned_agent_id: null,
      },
    },
  });
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/task-no-agent", {
    "x-deploy-secret": SECRET,
  }));
  if (res.status === 400) pass("F5b: missing assigned_agent_id → 400");
  else fail("F5b: missing agent should 400", `got ${res.status}`);
}

// ── F6: happy path → relays DO body unchanged ──────────────────────────────
{
  let forwardedBody = null;
  const env = makeEnv({
    tasks: {
      "task-ok": {
        id: "task-ok",
        telegram_chat_id: 5281111124,
        output: "task body",
        assigned_agent_id: "agent-finance-lead",
      },
    },
    doForwarder: async (init) => {
      forwardedBody = init.body;
      return new Response(
        JSON.stringify({ ok: true, taskId: "task-ok", totalChunks: 2, sentChunks: 2 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const res = await callRouter(env, buildReq("POST", "https://x/api/admin/replay-task-output/task-ok", {
    "x-deploy-secret": SECRET,
  }));
  const body = await res.json();
  const okStatus = res.status === 200;
  const okBody   = body.ok === true && body.taskId === "task-ok" && body.totalChunks === 2;
  const okForward = forwardedBody && JSON.parse(forwardedBody).taskId === "task-ok";
  if (okStatus && okBody && okForward) {
    pass("F6: happy path → 200 + relayed DO body + forwarded {taskId} payload");
  } else {
    fail("F6: happy path", `status=${res.status} body=${JSON.stringify(body)} forwarded=${forwardedBody}`);
  }
}

// ── F7: legacy ?task_id= query-param form still works ───────────────────────
{
  const env = makeEnv({
    tasks: {
      "legacy-task": {
        id: "legacy-task",
        telegram_chat_id: 5281111124,
        output: "task body",
        assigned_agent_id: "agent-x",
      },
    },
  });
  const res = await callRouter(env, buildReq(
    "POST",
    "https://x/api/admin/replay-task-output?task_id=legacy-task",
    { "x-deploy-secret": SECRET },
  ));
  if (res.status === 200) pass("F7: legacy ?task_id= query form → 200");
  else fail("F7: legacy query form", `got ${res.status}`);
}

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}
