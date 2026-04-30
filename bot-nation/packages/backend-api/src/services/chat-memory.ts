/**
 * Chat Memory Service
 *
 * Stores and retrieves recent conversation history per chat.
 * Enables follow-up handling ("yes", "no", "do it") and contextual responses.
 */

import { query, run } from '../db/schema';

export interface ChatMessage {
  id?: number;
  chat_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  query_type?: string;
  task_id?: string;
  pending_action?: string;
  created_at?: string;
}

const MAX_HISTORY = 10; // Keep last 10 messages per chat

// ============================================================================
// Store & Retrieve
// ============================================================================

/**
 * Store a message in chat history
 */
export async function storeMessage(
  db: D1Database,
  message: Omit<ChatMessage, 'id' | 'created_at'>,
): Promise<void> {
  await run(
    db,
    `INSERT INTO chat_messages (chat_id, user_id, role, content, query_type, task_id, pending_action)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      message.chat_id,
      message.user_id,
      message.role,
      message.content,
      message.query_type || null,
      message.task_id || null,
      message.pending_action || null,
    ],
  );

  // Prune old messages beyond MAX_HISTORY
  await run(
    db,
    `DELETE FROM chat_messages
     WHERE chat_id = ? AND id NOT IN (
       SELECT id FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
     )`,
    [message.chat_id, message.chat_id, MAX_HISTORY * 2], // keep 20 rows (10 pairs)
  );
}

/**
 * Get recent conversation history for a chat
 */
export async function getRecentHistory(
  db: D1Database,
  chatId: string,
  limit: number = MAX_HISTORY,
): Promise<ChatMessage[]> {
  return query<ChatMessage>(
    db,
    `SELECT * FROM chat_messages
     WHERE chat_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [chatId, limit],
  ).then((msgs) => msgs.reverse()); // Return in chronological order
}

/**
 * Get the last assistant message (to check for pending actions)
 */
export async function getLastAssistantMessage(
  db: D1Database,
  chatId: string,
): Promise<ChatMessage | null> {
  const msgs = await query<ChatMessage>(
    db,
    `SELECT * FROM chat_messages
     WHERE chat_id = ? AND role = 'assistant'
     ORDER BY id DESC
     LIMIT 1`,
    [chatId],
  );
  return msgs[0] || null;
}

/**
 * Format conversation history for LLM context
 */
export function formatHistoryForLLM(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';

  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
}

/**
 * Format conversation history as Claude API messages
 */
export function formatHistoryAsMessages(
  messages: ChatMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

// ============================================================================
// Follow-up Detection
// ============================================================================

const AFFIRMATIVE_PATTERNS = /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please|affirmative|correct|right|y|go|proceed|confirm)\.?$/i;
const NEGATIVE_PATTERNS = /^(no|nope|nah|cancel|never mind|nevermind|skip|don't|dont|stop|n)\.?$/i;

/**
 * Check if a message is a follow-up response (yes/no) to a previous question
 */
export function isFollowUp(text: string): 'yes' | 'no' | null {
  const trimmed = text.trim();
  if (AFFIRMATIVE_PATTERNS.test(trimmed)) return 'yes';
  if (NEGATIVE_PATTERNS.test(trimmed)) return 'no';
  return null;
}
