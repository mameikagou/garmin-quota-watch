import preview from "./design/quota-v5.html";
import { collectionCooldownMilliseconds, refreshGroupNames } from "./refresh-policy.mjs";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const refreshGroups = new Set(refreshGroupNames);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function authorized(request, secret) {
  return Boolean(secret) && request.headers.get("Authorization") === `Bearer ${secret}`;
}

function validCard(card) {
  return card && typeof card.provider === "string" && card.provider.length > 0 && card.provider.length <= 80
    && typeof card.name === "string" && card.name.length <= 80
    && Array.isArray(card.windows) && card.windows.length <= 32
    && (!["zcode", "workbuddy"].includes(card.group) || card.error
      || ["国内", "国外"].includes(card.region));
}

function validCollectionAttempts(attempts) {
  return attempts === undefined || (attempts && typeof attempts === "object"
    && Object.entries(attempts).every(([group, attemptedAt]) => refreshGroups.has(group)
      && Number.isFinite(Date.parse(attemptedAt))));
}

function isNewer(candidate, current) {
  return Number.isFinite(Date.parse(candidate))
    && (!Number.isFinite(Date.parse(current)) || Date.parse(candidate) > Date.parse(current));
}

export class RefreshCoordinator {
  constructor(context) {
    this.storage = context.storage;
  }

  async state() {
    return (await this.storage.get("state")) ?? { attempts: {}, requests: {}, overlays: {} };
  }

  async requestRefresh(state, group) {
    const latestAttempt = Date.parse(state.attempts[group]);
    if (Number.isFinite(latestAttempt) && Date.now() - latestAttempt < collectionCooldownMilliseconds) {
      return json({ status: "cached", attempted_at: state.attempts[group] });
    }
    if (state.requests[group]) return json({ status: "queued", ...state.requests[group] }, 202);
    const refreshRequest = { group, requested_at: new Date().toISOString() };
    state.requests[group] = refreshRequest;
    await this.storage.put("state", state);
    return json({ status: "queued", ...refreshRequest }, 202);
  }

  async complete(state, result) {
    if (isNewer(result.attempted_at, state.attempts[result.group])
        || result.attempted_at === state.attempts[result.group]) {
      state.attempts[result.group] = result.attempted_at;
      state.overlays[result.group] = { attempted_at: result.attempted_at, cards: result.cards };
    }
    delete state.requests[result.group];
    await this.storage.put("state", state);
    return json({ ok: true, updated: result.cards.length > 0 });
  }

  async syncSnapshot(state, snapshot) {
    for (const [group, attemptedAt] of Object.entries(snapshot.collection_attempts ?? {})) {
      if (!isNewer(attemptedAt, state.attempts[group]) && attemptedAt !== state.attempts[group]) continue;
      state.attempts[group] = attemptedAt;
      state.overlays[group] = {
        attempted_at: attemptedAt,
        cards: snapshot.cards.filter((card) => card.group === group && !card.error),
      };
    }
    await this.storage.put("state", state);
    return json({ ok: true });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const state = await this.state();
    const requestMatch = url.pathname.match(/^\/request\/([a-z]+)$/);
    if (requestMatch && request.method === "POST") return this.requestRefresh(state, requestMatch[1]);
    if (url.pathname === "/requests" && request.method === "GET") {
      return json({ requests: Object.values(state.requests) });
    }
    if (url.pathname === "/complete" && request.method === "POST") return this.complete(state, await request.json());
    if (url.pathname === "/snapshot" && request.method === "POST") return this.syncSnapshot(state, await request.json());
    if (url.pathname === "/view" && request.method === "GET") return json(state);
    return json({ error: "Not found" }, 404);
  }
}

function coordinator(env) {
  const id = env.REFRESH_COORDINATOR.idFromName("quota-refresh");
  return env.REFRESH_COORDINATOR.get(id);
}

async function coordinatorRequest(env, path, method = "GET", body) {
  const response = await coordinator(env).fetch(`https://coordinator${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`刷新协调器返回 HTTP ${response.status}`);
  return { status: response.status, body: await response.json() };
}

async function currentSnapshot(env) {
  const snapshot = await env.QUOTA_KV.get("latest_quota", "json");
  if (!snapshot) return null;
  const { body: state } = await coordinatorRequest(env, "/view");
  const merged = {
    ...snapshot,
    collection_attempts: { ...(snapshot.collection_attempts ?? {}) },
    cards: [...snapshot.cards],
  };
  let collectedAt = Date.parse(snapshot.collected_at);
  for (const [group, overlay] of Object.entries(state.overlays ?? {})) {
    if (!isNewer(overlay.attempted_at, merged.collection_attempts[group])) continue;
    const providers = new Set(overlay.cards.map((card) => card.provider));
    merged.cards = [...merged.cards.filter((card) => !providers.has(card.provider)), ...overlay.cards];
    merged.collection_attempts[group] = overlay.attempted_at;
    if (overlay.cards.length) collectedAt = Math.max(collectedAt, Date.parse(overlay.attempted_at));
  }
  for (const [group, attemptedAt] of Object.entries(state.attempts ?? {})) {
    if (isNewer(attemptedAt, merged.collection_attempts[group])) merged.collection_attempts[group] = attemptedAt;
  }
  if (Number.isFinite(collectedAt)) {
    merged.collected_at = new Date(collectedAt).toISOString();
    merged.collected_at_seconds = Math.floor(collectedAt / 1000);
  }
  return merged;
}

function watchText(snapshot) {
  const lines = snapshot.cards.map((card) => {
    if (card.error) return `${card.name}: 查询失败`;
    const labels = { "7 days": "周", "1 day": "日", "5 hours": "5小时", Month: "月" };
    const windows = card.windows.map((window) => {
      const period = labels[window.name] ?? window.name;
      const label = window.pool ? `${window.pool} ${period}` : period;
      const remaining = window.unit === "USD" && Number.isFinite(window.limit) && Number.isFinite(window.amount)
        ? `$${(window.limit - window.amount).toFixed(2)}` : `${window.remaining.toFixed(1)}%`;
      const reset = Number.isFinite(Date.parse(window.resetsAt))
        ? `，重置 ${new Date(window.resetsAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}` : "";
      return `${label}剩 ${remaining}${reset}`;
    });
    return `${card.name}: ${windows.join(" / ")}`;
  });
  const updated = new Date(snapshot.collected_at).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  });
  return [...lines, `更新 ${updated}`].join("\n");
}

async function save(request, env) {
  if (!authorized(request, env.WRITE_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const body = await request.text();
  if (body.length > 65536) return json({ error: "Payload too large" }, 413);
  let snapshot;
  try {
    snapshot = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(snapshot?.cards) || !snapshot.cards.length || snapshot.cards.length > 64
      || !snapshot.cards.every(validCard) || !Number.isFinite(Date.parse(snapshot.collected_at))) {
    return json({ error: "Invalid quota summary" }, 400);
  }
  if (!validCollectionAttempts(snapshot.collection_attempts)) return json({ error: "Invalid collection attempts" }, 400);
  for (const card of snapshot.cards) {
    if (!card.windows.every((window) => typeof window.name === "string"
      && Number.isFinite(window.remaining) && Number.isFinite(window.used))) {
      return json({ error: "Invalid quota window" }, 400);
    }
  }
  snapshot.received_at = new Date().toISOString();
  if (!snapshot.tibo) {
    const previous = await env.QUOTA_KV.get("latest_quota", "json");
    if (previous?.tibo) snapshot.tibo = previous.tibo;
  }
  await coordinatorRequest(env, "/snapshot", "POST", snapshot);
  await env.QUOTA_KV.put("latest_quota", JSON.stringify(snapshot));
  return json({ ok: true, received_at: snapshot.received_at });
}

async function queueRefresh(request, env, group) {
  if (!authorized(request, env.READ_TOKEN)) return json({ error: "Unauthorized" }, 401);
  if (!refreshGroups.has(group)) return json({ error: "Unknown group" }, 404);
  const result = await coordinatorRequest(env, `/request/${group}`, "POST");
  return json(result.body, result.status);
}

async function pendingRefreshes(request, env) {
  if (!authorized(request, env.WRITE_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const result = await coordinatorRequest(env, "/requests");
  return json(result.body);
}

async function completeRefresh(request, env) {
  if (!authorized(request, env.WRITE_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const body = await request.text();
  if (body.length > 65536) return json({ error: "Payload too large" }, 413);
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { group, attempted_at: attemptedAt, cards } = result;
  if (!refreshGroups.has(group) || !Array.isArray(cards) || cards.length > 32
      || !cards.every((card) => validCard(card) && card.group === group)
      || !Number.isFinite(Date.parse(attemptedAt))) {
    return json({ error: "Invalid refresh result" }, 400);
  }
  const completed = await coordinatorRequest(env, "/complete", "POST", {
    group, attempted_at: attemptedAt, cards,
  });
  return json(completed.body);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/design" && request.method === "GET") {
      return new Response(preview, {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if ((path === "/" || path === "/health") && request.method === "GET") {
      return json({ status: "ok", service: "quota-watch" });
    }
    if (path === "/refresh/requests" && request.method === "GET") return pendingRefreshes(request, env);
    if (path === "/refresh/complete" && request.method === "POST") return completeRefresh(request, env);
    const refreshMatch = path.match(/^\/refresh\/([a-z]+)$/);
    if (refreshMatch && request.method === "POST") return queueRefresh(request, env, refreshMatch[1]);
    if (path !== "/quota" && path !== "/quota.txt") {
      if (request.method !== "GET" || !env.ASSETS) return json({ error: "Not found" }, 404);
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set("Cache-Control", "no-store");
      if (asset.ok && path.endsWith(".prg")) {
        response.headers.set("Content-Disposition", `attachment; filename="${path.slice(1)}"`);
      }
      return response;
    }
    if (request.method === "POST" && path === "/quota") return save(request, env);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (!authorized(request, env.READ_TOKEN)) return json({ error: "Unauthorized" }, 401);
    const snapshot = await currentSnapshot(env);
    if (!snapshot) return json({ status: "empty" }, 404);
    if (path === "/quota.txt") {
      return new Response(watchText(snapshot), {
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return json(snapshot);
  },
};
