import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory, quotaEndpoint } from "./config.mjs";
import { sources } from "./sources.mjs";
import { collectSources } from "./upload.mjs";

const credentials = JSON.parse(await readFile(join(configDirectory, "credentials.json"), "utf8"));
const endpoint = quotaEndpoint();
const intervalMilliseconds = 10000;
const statePath = join(configDirectory, "refresh-state.json");
let handled = {};
try { handled = JSON.parse(await readFile(statePath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

async function request(path, method = "GET", body) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credentials.WRITE_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(70000),
  });
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
  return response.json();
}

async function refreshGroup(group) {
  const selected = sources.filter((source) => source.group === group);
  const collected = await collectSources(selected);
  const cards = collected.filter((card) => !card.error);
  const failedProviders = collected.filter((card) => card.error).map((card) => card.provider);
  await request("/refresh/complete", "POST", { group, cards, failed_providers: failedProviders });
  console.log(`${new Date().toISOString()} ${group}: 更新 ${cards.length} 张，失败 ${failedProviders.length} 个来源`);
}

async function poll() {
  const pending = await request("/refresh/requests");
  for (const refreshRequest of pending.requests ?? []) {
    if (handled[refreshRequest.group] === refreshRequest.requested_at) { continue; }
    await refreshGroup(refreshRequest.group);
    handled[refreshRequest.group] = refreshRequest.requested_at;
    await writeFile(statePath, JSON.stringify(handled, null, 2), { mode: 0o600 });
  }
}

async function main() {
  while (true) {
    try {
      await poll();
    } catch (error) {
      console.error(`${new Date().toISOString()} ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds));
  }
}

await main();
