import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sources } from "./sources.mjs";
import { collectTibo } from "./tibo.mjs";
import { configDirectory, quotaEndpoint } from "./config.mjs";

const execute = promisify(execFile);

function summary(card, source, account) {
  const windows = (card.windows ?? []).map((window) => {
    const result = { name: window.name, used: window.used, remaining: window.remaining };
    for (const key of ["resetsAt", "amount", "limit", "unit", "pool", "display"]) {
      if (window[key] !== undefined) result[key] = window[key];
    }
    const reset = Date.parse(window.resetsAt);
    if (Number.isFinite(reset)) result.resets_at_seconds = Math.floor(reset / 1000);
    return result;
  });
  const result = {
    provider: source.provider,
    name: source.name,
    group: source.group,
    account,
    source_read_at: card.readAt ?? null,
    windows,
    ...(card.error ? { error: "额度查询失败" } : {}),
  };
  for (const key of ["plan", "until", "runsOutAt", "runsOut", "last"]) {
    if (card[key] !== undefined) result[key] = card[key];
  }
  for (const key of ["until", "runsOutAt"]) {
    const stamp = Date.parse(card[key]);
    if (Number.isFinite(stamp)) result[`${key}_seconds`] = Math.floor(stamp / 1000);
  }
  return result;
}

function accountLabel(source, card, labels) {
  if (source.account) return source.account;
  if (!card.user) return card.account ?? "";
  const accounts = labels[source.group] ??= [];
  const identity = `${source.provider}/${card.user}`;
  if (!accounts.includes(identity)) accounts.push(identity);
  return String.fromCharCode(65 + accounts.indexOf(identity));
}

async function collect(source, labels) {
  try {
    if (source.kind === "antigravity") return await collectAntigravity(source);
    const { stdout } = await execute(process.env.MAGPIE_BIN ?? "magpie", ["quota", "refresh", source.provider, "--json"], {
      timeout: 60000, maxBuffer: 1024 * 1024,
    });
    const cards = JSON.parse(stdout).filter((card) => card.provider === source.provider);
    if (!cards.length) throw new Error("No quota card");
    return cards.map((card) => ({ ...summary(card, source, accountLabel(source, card, labels)), source: "magpie" }));
  } catch {
    return [{ provider: source.provider, name: source.name, group: source.group, account: source.account ?? "", windows: [], error: "额度查询失败" }];
  }
}

function antigravityWindows(groups) {
  const periods = { "5h": "5 hours", weekly: "7 days", monthly: "Month" };
  const windows = [];
  const missing = [];
  for (const group of groups.filter((group) => group.name?.startsWith("Gemini"))) {
    const pool = group.name === "Gemini Models" ? "Gemini" : group.name;
    for (const bucket of group.buckets ?? []) {
      const name = periods[bucket.window] ?? bucket.name;
      const remaining = bucket.remaining_fraction;
      if (!name || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) {
        missing.push({ pool, name: name ?? "未提供周期" });
        continue;
      }
      windows.push({
        name, pool, used: (1 - remaining) * 100, remaining: remaining * 100,
        ...(bucket.reset_time ? { resetsAt: bucket.reset_time } : {}),
      });
    }
  }
  return { windows, missing };
}

async function collectAntigravity(account) {
  try {
    const { stdout } = await execute(account.command, [
      "--print", "/usage", "--output-format", "json", "--print-timeout", "30s",
    ], { timeout: 45000, maxBuffer: 1024 * 1024 });
    const usage = JSON.parse(stdout);
    if (usage.status !== "SUCCESS" || usage.command?.name !== "usage" || !Array.isArray(usage.command.data?.groups)) {
      throw new Error("未返回反重力额度");
    }
    const { windows, missing } = antigravityWindows(usage.command.data.groups);
    if (!windows.length) throw new Error("未返回 Gemini 额度");
    const card = summary({ windows, readAt: new Date().toISOString() }, account, account.account);
    return [{ ...card, source: "antigravity-cli", ...(missing.length ? { missing_windows: missing } : {}) }];
  } catch {
    return [{ provider: account.provider, name: account.name, group: account.group, account: account.account, source: "antigravity-cli", windows: [], error: "额度查询失败" }];
  }
}

async function main() {
  const labelPath = join(configDirectory, "account-labels.json");
  let labels = {};
  try { labels = JSON.parse(await readFile(labelPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const [collected, tibo] = await Promise.all([
    Promise.all(sources.map((source) => collect(source, labels))), collectTibo(),
  ]);
  const cards = collected.flat();
  await writeFile(labelPath, JSON.stringify(labels, null, 2), { mode: 0o600 });
  if (cards.every((card) => card.error)) throw new Error("所有渠道查询失败，保留云端最近一次数据");
  const collectedAt = new Date();
  const snapshot = {
    collected_at: collectedAt.toISOString(),
    collected_at_seconds: Math.floor(collectedAt.getTime() / 1000),
    cards,
    ...(tibo ? { tibo } : {}),
  };
  if (process.argv.includes("--preview")) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const credentials = JSON.parse(await readFile(join(configDirectory, "credentials.json"), "utf8"));
  const endpoint = quotaEndpoint();
  const response = await fetch(`${endpoint}/quota`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.WRITE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`上传失败 HTTP ${response.status}`);
  console.log(`已上传 ${cards.length} 个额度卡片，${cards.filter((card) => card.error).length} 个查询失败`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
