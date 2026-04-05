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
  list: () => request<unknown[]>("/api/tasks"),
  get: (id: string) => request<unknown>(`/api/tasks/${id}`),
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

// ─── Health ───────────────────────────────────────────────────────────────────

export const health = {
  check: () => request<{ status: string }>("/health"),
};
