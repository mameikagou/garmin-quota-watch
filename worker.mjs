import preview from "./design/quota-v5.html";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function authorized(request, secret) {
  return Boolean(secret) && request.headers.get("Authorization") === `Bearer ${secret}`;
}

function validCard(card) {
  return card && typeof card.provider === "string" && card.provider.length > 0 && card.provider.length <= 80
    && typeof card.name === "string" && card.name.length <= 80
    && Array.isArray(card.windows) && card.windows.length <= 32;
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
  await env.QUOTA_KV.put("latest_quota", JSON.stringify(snapshot));
  return json({ ok: true, received_at: snapshot.received_at });
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
    const snapshot = await env.QUOTA_KV.get("latest_quota", "json");
    if (!snapshot) return json({ status: "empty" }, 404);
    if (path === "/quota.txt") {
      return new Response(watchText(snapshot), {
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return json(snapshot);
  },
};
