import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configDirectory, quotaEndpoint } from "./config.mjs";
import { collectGroup } from "./upload.mjs";

const credentials = JSON.parse(await readFile(join(configDirectory, "credentials.json"), "utf8"));
const endpoint = quotaEndpoint();
const intervalMilliseconds = 15000;

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
  const collection = await collectGroup(group);
  const cards = collection.cards.filter((card) => !card.error);
  const failedProviders = collection.cards.filter((card) => card.error).map((card) => card.provider);
  await request("/refresh/complete", "POST", {
    group, attempted_at: collection.attempted_at, cards, failed_providers: failedProviders,
  });
  const action = collection.cached ? "复用最近采集" : "真实采集";
  console.log(`${new Date().toISOString()} ${group}: ${action}，更新 ${cards.length} 张，失败 ${failedProviders.length} 个来源`);
}

async function poll() {
  const pending = await request("/refresh/requests");
  await Promise.all((pending.requests ?? []).map((refreshRequest) => refreshGroup(refreshRequest.group)));
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
