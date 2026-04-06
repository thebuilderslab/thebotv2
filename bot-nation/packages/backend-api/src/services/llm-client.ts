/**
 * LLM Client — Phase 7
 *
 * OpenAI-compatible client pointed at OpenRouter.
 * Supports streaming + tool use for all OpenRouter models.
 * Falls back to direct Anthropic SDK if OPENROUTER_API_KEY is absent.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { OPENROUTER_BASE_URL, OPENROUTER_APP_NAME, OPENROUTER_APP_URL } from "./model-router";

export interface LLMTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | LLMToolResult[];
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface LLMResponse {
  text: string;
  toolCalls: LLMToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop";
  model: string;
}

export interface StreamChunk {
  type: "token" | "tool_call" | "done";
  text?: string;
  toolCall?: LLMToolCall;
}

// ── Client factory ────────────────────────────────────────────────────────────

function makeOpenRouterClient(apiKey: string): OpenAI {
  return new OpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    defaultHeaders: {
      "HTTP-Referer": OPENROUTER_APP_URL,
      "X-Title": OPENROUTER_APP_NAME,
    },
  });
}

// ── Non-streaming completion ──────────────────────────────────────────────────

export async function llmComplete(params: {
  apiKey: string;
  openrouterKey?: string;
  model: string;
  fallbackModel?: string;
  systemPrompt: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: LLMTool[];
  maxTokens?: number;
  temperature?: number;
}): Promise<LLMResponse> {

  // Prefer OpenRouter if key available
  if (params.openrouterKey) {
    return openrouterComplete(params.openrouterKey, params);
  }

  // Fallback: Anthropic direct
  return anthropicComplete(params.apiKey, params);
}

// ── OpenRouter completion ─────────────────────────────────────────────────────

async function openrouterComplete(
  openrouterKey: string,
  params: {
    model: string;
    fallbackModel?: string;
    systemPrompt: string;
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: LLMTool[];
    maxTokens?: number;
    temperature?: number;
  },
): Promise<LLMResponse> {
  const client = makeOpenRouterClient(openrouterKey);

  const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined = params.tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const requestBody: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    temperature: params.temperature ?? 0.7,
    messages: [
      { role: "system", content: params.systemPrompt },
      ...params.messages,
    ],
    ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools } : {}),
  };

  // Add fallback model via OpenRouter extra body
  const extraBody = params.fallbackModel
    ? { models: [params.model, params.fallbackModel, "openrouter/auto"] }
    : undefined;

  const response = await client.chat.completions.create(
    extraBody ? ({ ...requestBody, ...extraBody } as typeof requestBody) : requestBody,
  );

  const choice = response.choices[0];
  const msg = choice?.message;
  const text = msg?.content ?? "";
  const stopReason = mapStopReason(choice?.finish_reason ?? "stop");
  const usedModel = (response as unknown as { model?: string }).model ?? params.model;

  const toolCalls: LLMToolCall[] = (msg?.tool_calls ?? [])
    .filter((tc) => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

  return { text, toolCalls, stopReason, model: usedModel };
}

// ── Anthropic fallback completion ─────────────────────────────────────────────

async function anthropicComplete(
  apiKey: string,
  params: {
    model: string;
    systemPrompt: string;
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: LLMTool[];
    maxTokens?: number;
    temperature?: number;
  },
): Promise<LLMResponse> {
  const anthropic = new Anthropic({ apiKey });

  const anthropicTools: Anthropic.Tool[] | undefined = params.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  // Convert messages: filter to user/assistant only for Anthropic
  const anthropicMessages: Anthropic.MessageParam[] = params.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : String(m.content),
    }));

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: params.maxTokens ?? 2048,
    system: params.systemPrompt,
    messages: anthropicMessages,
    ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";
  const stopReason = response.stop_reason === "tool_use" ? "tool_use" : "end_turn";

  const toolCalls: LLMToolCall[] = response.content
    .filter((b) => b.type === "tool_use")
    .map((b) => {
      if (b.type !== "tool_use") return null;
      return { id: b.id, name: b.name, input: b.input as Record<string, unknown> };
    })
    .filter(Boolean) as LLMToolCall[];

  return { text, toolCalls, stopReason, model: "claude-haiku-4-5" };
}

// ── Streaming (OpenRouter only) ───────────────────────────────────────────────

export async function* llmStream(params: {
  openrouterKey: string;
  model: string;
  systemPrompt: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: LLMTool[];
  maxTokens?: number;
  temperature?: number;
}): AsyncGenerator<StreamChunk> {
  const client = makeOpenRouterClient(params.openrouterKey);

  const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined = params.tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const stream = await client.chat.completions.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    temperature: params.temperature ?? 0.7,
    stream: true,
    messages: [
      { role: "system", content: params.systemPrompt },
      ...params.messages,
    ],
    ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools } : {}),
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) {
      yield { type: "token", text: delta.content };
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          yield {
            type: "tool_call",
            toolCall: {
              id: tc.id ?? crypto.randomUUID(),
              name: tc.function.name,
              input: tc.function.arguments
                ? JSON.parse(tc.function.arguments) as Record<string, unknown>
                : {},
            },
          };
        }
      }
    }
  }

  yield { type: "done" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapStopReason(reason: string): LLMResponse["stopReason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  return "stop";
}
