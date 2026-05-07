// MEM-1 fixture — confirms persistTelegramMessage now bridges into chat_messages
// via storeMessage with idempotency on (chat_id, telegram_message_id).
//
// Pre-MEM-1 behavior:
//   - persistTelegramMessage wrote ONLY to telegram_messages
//   - chat_messages was populated only by supervisor.handleMessage's direct
//     storeMessage calls — leaving action queries (which bypass the supervisor)
//     and any other path through persistTelegramMessage invisible to agents
//     reading via getRecentHistory()
//
// Post-MEM-1:
//   - persistTelegramMessage writes telegram_messages AND chat_messages
//   - storeMessage uses INSERT OR IGNORE (with the partial UNIQUE index from
//     migration 0043) so calls with the same telegram_message_id produce
//     exactly one chat_messages row
//   - getRecentHistory (the agent-side reader) now sees the full conversation

const { storeMessage, getRecentHistory } = await import("./verify-out/services/chat-memory.js");
const { persistTelegramMessage }          = await import("./verify-out/services/nation-supervisor.js");

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

// ──────────────────────────────────────────────────────────────────────────────
// In-memory D1 stub that simulates:
//   - chat_messages with INTEGER PRIMARY KEY AUTOINCREMENT id, all the
//     migration-0022/0043 columns, and the partial UNIQUE on
//     (chat_id, telegram_message_id) WHERE telegram_message_id IS NOT NULL
//   - telegram_messages writes (we just track them, no real schema)
//   - INSERT OR IGNORE semantics
//   - getRecentHistory's SELECT ORDER BY id DESC LIMIT
// ──────────────────────────────────────────────────────────────────────────────
function makeStubDb() {
  const chatRows = []; // each row is the full ChatMessage shape + id
  const tgRows   = []; // each row is the telegram_messages bind set
  let nextId = 1;
  const uniqueKeys = new Set(); // "chat_id|telegram_message_id" for non-null tg-id rows

  return {
    __chat: chatRows,
    __tg:   tgRows,
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async run() {
              if (/INSERT OR IGNORE INTO chat_messages/i.test(sql)) {
                const [chat_id, user_id, role, content, query_type, task_id, pending_action, telegram_message_id] = binds;
                if (telegram_message_id !== null && telegram_message_id !== undefined) {
                  const key = `${chat_id}|${telegram_message_id}`;
                  if (uniqueKeys.has(key)) {
                    return { success: true, meta: { changes: 0 } }; // IGNORE
                  }
                  uniqueKeys.add(key);
                }
                chatRows.push({
                  id: nextId++,
                  chat_id, user_id, role, content,
                  query_type: query_type ?? null,
                  task_id: task_id ?? null,
                  pending_action: pending_action ?? null,
                  telegram_message_id: telegram_message_id ?? null,
                  created_at: new Date().toISOString(),
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (/INSERT INTO telegram_messages/i.test(sql)) {
                tgRows.push({ sql, binds: [...binds] });
                return { success: true, meta: { changes: 1 } };
              }
              if (/DELETE FROM chat_messages/i.test(sql)) {
                // The prune query — ignore for fixture purposes (we cap below MAX_HISTORY anyway).
                return { success: true, meta: { changes: 0 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
            async first() { return null; },
            async all() {
              if (/SELECT \* FROM chat_messages/i.test(sql) && /WHERE chat_id = \?/i.test(sql)) {
                const [chatId, limit] = binds;
                const filtered = chatRows
                  .filter((r) => r.chat_id === chatId)
                  .sort((a, b) => b.id - a.id)
                  .slice(0, limit ?? 10);
                return { results: filtered };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

// ── F1: persistTelegramMessage("in") writes BOTH tables; chat_messages row
//        has role=user and the right metadata.
{
  const db = makeStubDb();
  await persistTelegramMessage(db, "in", 5281111124, "what's today's P&L?", {
    userId: 12345,
    routeType: "supervisor",
    messageId: 999001,
  });
  const tgWrote = db.__tg.length === 1;
  const chatRow = db.__chat[0];
  const ok =
    tgWrote &&
    chatRow &&
    chatRow.role === "user" &&
    chatRow.chat_id === "5281111124" &&
    chatRow.user_id === "12345" &&
    chatRow.content === "what's today's P&L?" &&
    chatRow.telegram_message_id === 999001;
  if (ok) {
    pass(`F1: in→user — telegram_messages + chat_messages both written, role=user, msg_id=999001`);
  } else {
    fail(`F1: incoming bridge wrong`, `tg_count=${db.__tg.length} chat_row=${JSON.stringify(chatRow)}`);
  }
}

// ── F2: persistTelegramMessage("out") writes BOTH tables; chat_messages row
//        has role=assistant.
{
  const db = makeStubDb();
  await persistTelegramMessage(db, "out", 5281111124, "🤖 Dispatching to agent-finance-lead…", {
    taskId: "task-abc",
    routeType: "supervisor_dispatch",
    messageId: 999002,
  });
  const tgWrote = db.__tg.length === 1;
  const chatRow = db.__chat[0];
  const ok =
    tgWrote &&
    chatRow &&
    chatRow.role === "assistant" &&
    chatRow.chat_id === "5281111124" &&
    chatRow.task_id === "task-abc" &&
    chatRow.telegram_message_id === 999002 &&
    /Dispatching/.test(chatRow.content);
  if (ok) {
    pass(`F2: out→assistant — both tables written, role=assistant, task_id propagated`);
  } else {
    fail(`F2: outgoing bridge wrong`, `tg_count=${db.__tg.length} chat_row=${JSON.stringify(chatRow)}`);
  }
}

// ── F3: idempotency — calling persistTelegramMessage twice with the SAME
//        telegram message_id produces exactly ONE chat_messages row.
{
  const db = makeStubDb();
  await persistTelegramMessage(db, "in", 5281111124, "duplicate test", { messageId: 555 });
  await persistTelegramMessage(db, "in", 5281111124, "duplicate test", { messageId: 555 });
  const tgWrote = db.__tg.length === 2; // telegram_messages has no UNIQUE — both inserts hit
  const chatCount = db.__chat.length;
  if (tgWrote && chatCount === 1) {
    pass(`F3: idempotency — 2× calls with same msg_id=555 → 1 chat_messages row (UNIQUE caught the second)`);
  } else {
    fail(`F3: idempotency`, `tg_count=${db.__tg.length} chat_count=${chatCount}`);
  }
}

// ── F4: persistTelegramMessage WITHOUT messageId still writes chat_messages
//        (best-effort path, no idempotency guard since key is NULL).
{
  const db = makeStubDb();
  await persistTelegramMessage(db, "out", 5281111124, "ack without telegram id", {
    routeType: "supervisor_dispatch",
    // NO messageId
  });
  const chatRow = db.__chat[0];
  if (db.__tg.length === 1 && chatRow && chatRow.telegram_message_id === null) {
    pass(`F4: missing msg_id → still writes chat_messages, telegram_message_id=NULL`);
  } else {
    fail(`F4: missing-msgId case`, `tg_count=${db.__tg.length} chat_row=${JSON.stringify(chatRow)}`);
  }
}

// ── F5: missing userId on incoming message defaults to "unknown"; missing
//        userId on outgoing defaults to "system" (per persistTelegramMessage logic).
{
  const db = makeStubDb();
  await persistTelegramMessage(db, "in",  5281111124, "no user id", { messageId: 100 });
  await persistTelegramMessage(db, "out", 5281111124, "no user id either", { messageId: 101 });
  const inRow  = db.__chat.find((r) => r.role === "user");
  const outRow = db.__chat.find((r) => r.role === "assistant");
  if (inRow?.user_id === "unknown" && outRow?.user_id === "system") {
    pass(`F5: missing userId → "unknown" for in, "system" for out`);
  } else {
    fail(`F5: userId default`, `in_user_id=${inRow?.user_id} out_user_id=${outRow?.user_id}`);
  }
}

// ── F6: getRecentHistory returns chronological order including new bridged rows
{
  const db = makeStubDb();
  await persistTelegramMessage(db, "in",  5281111124, "first user msg",   { messageId: 1, userId: 9 });
  await persistTelegramMessage(db, "out", 5281111124, "first bot reply",  { messageId: 2 });
  await persistTelegramMessage(db, "in",  5281111124, "second user msg",  { messageId: 3, userId: 9 });
  const history = await getRecentHistory(db, "5281111124", 10);
  const ok =
    history.length === 3 &&
    history[0]?.content === "first user msg" &&
    history[1]?.content === "first bot reply" &&
    history[2]?.content === "second user msg" &&
    history[0]?.role === "user" &&
    history[1]?.role === "assistant" &&
    history[2]?.role === "user";
  if (ok) {
    pass(`F6: getRecentHistory returns 3 rows in chronological order, roles + content match`);
  } else {
    fail(`F6: getRecentHistory order/content wrong`, `count=${history.length} history=${JSON.stringify(history.map((h) => ({ role: h.role, content: h.content })))}`);
  }
}

// ── F7: storeMessage SQL contains INSERT OR IGNORE (idempotency primitive)
{
  const db = {
    __captured: [],
    prepare(sql) {
      return {
        bind() { return { async run() { db.__captured.push(sql); return { success: true }; } }; },
      };
    },
  };
  await storeMessage(db, {
    chat_id: "abc", user_id: "u1", role: "user", content: "x", telegram_message_id: 42,
  });
  const usedInsertOrIgnore = db.__captured.some((s) => /INSERT OR IGNORE INTO chat_messages/i.test(s));
  if (usedInsertOrIgnore) {
    pass(`F7: storeMessage SQL uses "INSERT OR IGNORE" (idempotency primitive)`);
  } else {
    fail(`F7: storeMessage SQL missing INSERT OR IGNORE`, `sql_seen=${JSON.stringify(db.__captured)}`);
  }
}

// ── F8: telegram_messages still gets written even when chat-memory write fails
//        (best-effort guarantee — never block primary table).
{
  const db = {
    __tg: [],
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async run() {
              if (/INSERT INTO telegram_messages/i.test(sql)) {
                db.__tg.push(binds);
                return { success: true };
              }
              if (/INSERT OR IGNORE INTO chat_messages/i.test(sql)) {
                throw new Error("simulated chat_messages write failure");
              }
              return { success: true };
            },
            async first() { return null; },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  let threw = false;
  try {
    await persistTelegramMessage(db, "in", 1, "test", { messageId: 1, userId: 1 });
  } catch {
    threw = true;
  }
  if (!threw && db.__tg.length === 1) {
    pass(`F8: chat-memory failure swallowed; telegram_messages write still succeeded`);
  } else {
    fail(`F8: best-effort guarantee broken`, `threw=${threw} tg_count=${db.__tg.length}`);
  }
}

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}
