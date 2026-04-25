/**
 * API client for the bot-nation backend.
 *
 * In dev:  Vite proxies /api/* → http://localhost:8787
 * In prod: requests go directly to the deployed worker URL via VITE_API_URL
 */

const BASE =
  import.meta.env["VITE_API_URL"] ??
  "https://bot-nation-api.thejamalshackleford.workers.dev";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export const agents = {
  list: () => request<unknown[]>("/api/agents"),
  get: (id: string) => request<unknown>(`/api/agents/${id}`),
  create: (body: unknown) =>
    request<{ id: string }>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  patch: (id: string, body: unknown) =>
    request<{ ok: boolean }>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
};

// ─── Teams ───────────────────────────────────────────────────────────────────

export const teams = {
  list: () => request<unknown[]>("/api/teams"),
  get: (id: string) => request<unknown>(`/api/teams/${id}`),
  create: (body: unknown) =>
    request<{ id: string }>("/api/teams", { method: "POST", body: JSON.stringify(body) }),
};

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const tasks = {
  list: (status?: string, teamId?: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (teamId) params.set("teamId", teamId);
    const qs = params.toString();
    return request<unknown[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => request<unknown>(`/api/tasks/${id}`),
  events: (id: string) => request<unknown[]>(`/api/tasks/${id}/events`),
  children: (id: string) => request<unknown[]>(`/api/tasks/${id}/children`),
  assign: (id: string, body: { agentId?: string; teamId?: string }) =>
    request<{ ok: boolean }>(`/api/tasks/${id}/assign`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  create: (body: unknown) =>
    request<{ id: string; status: string; assignedAgentId: string | null; teamId: string | null }>(
      "/api/tasks",
      { method: "POST", body: JSON.stringify(body) },
    ),
};

// ─── Proposals ───────────────────────────────────────────────────────────────

export const proposals = {
  list: (status?: string) =>
    request<unknown[]>(`/api/proposals${status ? `?status=${status}` : ""}`),
  get: (id: string) => request<unknown>(`/api/proposals/${id}`),
  create: (body: unknown) =>
    request<{ id: string; status: string }>("/api/proposals", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  submit: (id: string) =>
    request<{ proposalId: string; approvalId: string; status: string }>(
      `/api/proposals/${id}/submit`,
      { method: "POST" },
    ),
  patch: (id: string, body: unknown) =>
    request<{ ok: boolean }>(`/api/proposals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};

// ─── Approvals ───────────────────────────────────────────────────────────────

export const approvals = {
  list: () => request<unknown[]>("/api/approvals"),
  get: (id: string) => request<unknown>(`/api/approvals/${id}`),
  inbox: () => request<unknown[]>("/api/approvals/inbox"),
  decide: (id: string, body: { decision: "approved" | "rejected"; userId: string; channel: string; rationale?: string }) =>
    request<{ ok: boolean }>(`/api/approvals/${id}/decision`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

// ─── Events ───────────────────────────────────────────────────────────────────

export const events = {
  list: (kind?: string, targetId?: string) => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (targetId) params.set("targetId", targetId);
    const qs = params.toString();
    return request<unknown[]>(`/api/events${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => request<unknown>(`/api/events/${id}`),
};

// ─── Artifacts ───────────────────────────────────────────────────────────────

export const artifacts = {
  list: (taskId?: string, kind?: string) => {
    const params = new URLSearchParams();
    if (taskId) params.set("taskId", taskId);
    if (kind)   params.set("kind", kind);
    const qs = params.toString();
    return request<unknown[]>(`/api/artifacts${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => request<unknown>(`/api/artifacts/${id}`),
  create: (body: unknown) =>
    request<{ id: string }>("/api/artifacts", { method: "POST", body: JSON.stringify(body) }),
};

// ─── Agent Notes ─────────────────────────────────────────────────────────────

export const notes = {
  list: (agentId: string) => request<unknown[]>(`/api/agents/${agentId}/notes`),
  get: (agentId: string, key: string) => request<unknown>(`/api/agents/${agentId}/notes/${key}`),
  upsert: (agentId: string, key: string, value: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/notes/${key}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  delete: (agentId: string, key: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/notes/${key}`, { method: "DELETE" }),
};

// ─── Tools ───────────────────────────────────────────────────────────────────

export const tools = {
  list: (status?: string) =>
    request<unknown[]>(`/api/tools${status ? `?status=${status}` : ""}`),
  get: (id: string) => request<unknown>(`/api/tools/${id}`),
  create: (body: unknown) =>
    request<{ id: string; status: string }>("/api/tools", { method: "POST", body: JSON.stringify(body) }),
  setStatus: (id: string, status: "active" | "disabled" | "pending_review") =>
    request<{ ok: boolean }>(`/api/tools/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
};

// ─── Actors (Durable Objects) ─────────────────────────────────────────────────

export const actors = {
  session: (agentId: string) => request<unknown>(`/api/actors/${agentId}/session`),
  sessions: (agentId: string) => request<unknown[]>(`/api/actors/${agentId}/sessions`),
  status: (agentId: string) => request<unknown>(`/api/actors/${agentId}/status`),
  dispatch: (agentId: string, taskId: string) =>
    request<{ sessionId: string; queued: boolean }>(`/api/actors/${agentId}/dispatch`, {
      method: "POST",
      body: JSON.stringify({ taskId }),
    }),
};

// ─── Agent Graphs ─────────────────────────────────────────────────────────────

export const graphs = {
  list: () => request<unknown[]>("/api/graphs"),
  listForAgent: (agentId: string) => request<unknown[]>(`/api/graphs/agent/${agentId}`),
  get: (id: string) => request<unknown>(`/api/graphs/${id}`),
  create: (body: unknown) =>
    request<{ id: string }>("/api/graphs", { method: "POST", body: JSON.stringify(body) }),
  patch: (id: string, body: unknown) =>
    request<{ ok: boolean }>(`/api/graphs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/api/graphs/${id}`, { method: "DELETE" }),
};

// ─── Graph ────────────────────────────────────────────────────────────────────

export const graph = {
  get: () => request<unknown>("/api/graph"),
};

// ─── Stats ───────────────────────────────────────────────────────────────────

export const stats = {
  get: () => request<Record<string, number>>("/api/stats"),
};

// ─── Health ───────────────────────────────────────────────────────────────────

export const health = {
  check: () => request<{ status: string }>("/health"),
};
