import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sources } from "./sources.mjs";
import { collectTibo } from "./tibo.mjs";
import { configDirectory, quotaEndpoint } from "./config.mjs";
import { collectionCooldownMilliseconds } from "./refresh-policy.mjs";

const execute = promisify(execFile);
const collectionDirectory = join(configDirectory, "collections");
const magpieConfigDirectory = process.env.MAGPIE_CONFIG_DIR ?? join(homedir(), ".config/magpie");

function summary(card, source, account, region) {
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
    ...(region ? { region } : {}),
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

function zcodeRegion(auth) {
  if (!auth || typeof auth.refresh !== "string") return null;
  let login;
  try { login = JSON.parse(auth.refresh); }
  catch { return null; }
  const base = typeof login.base === "string" ? login.base : "";
  if (login.site === "bigmodel" || base.startsWith("https://open.bigmodel.cn/")) return "国内";
  if (login.site === "zai" || base.startsWith("https://api.z.ai/")) return "国外";
  return null;
}

async function loadZcodeRegions() {
  const regions = new Map();
  try {
    const [loginText, authText] = await Promise.all([
      readFile(join(magpieConfigDirectory, "logins.json"), "utf8"),
      readFile(join(magpieConfigDirectory, "plugin-auth.json"), "utf8"),
    ]);
    const logins = JSON.parse(loginText);
    const auth = JSON.parse(authText);
    for (const login of logins) {
      if (login.agent !== "plugin:zcode" || typeof login.user !== "string") continue;
      const region = zcodeRegion(auth[login.home]);
      if (region) regions.set(login.user, region);
    }
  } catch {
    return regions;
  }
  return regions;
}

function failedCard(source, region) {
  return {
    provider: source.provider, name: source.name, group: source.group,
    account: region ?? source.account ?? "", ...(region ? { region } : {}),
    windows: [], error: "额度查询失败",
  };
}

function accountLabel(source, card, labels) {
  if (source.account) return source.account;
  if (!card.user) return card.account ?? "";
  const accounts = labels[source.group] ??= [];
  const identity = `${source.provider}/${card.user}`;
  if (!accounts.includes(identity)) accounts.push(identity);
  return String.fromCharCode(65 + accounts.indexOf(identity));
}

async function collect(source, labels, zcodeRegions) {
  try {
    if (source.kind === "antigravity") return await collectAntigravity(source);
    const { stdout } = await execute(process.env.MAGPIE_BIN ?? "magpie", ["quota", "refresh", source.provider, "--json"], {
      timeout: 60000, maxBuffer: 1024 * 1024,
    });
    const cards = JSON.parse(stdout).filter((card) => card.provider === source.provider);
    if (!cards.length) throw new Error("No quota card");
    return cards.map((card) => {
      const region = source.region ?? zcodeRegions.get(card.user);
      if ((source.group === "zcode" || source.group === "workbuddy") && !region) {
        return failedCard(source, null);
      }
      const account = region ?? accountLabel(source, card, labels);
      return { ...summary(card, source, account, region), source: "magpie" };
    });
  } catch {
    return [failedCard(source, source.region)];
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

export async function collectSources(selectedSources) {
  const group = selectedSources[0]?.group;
  if (!group || selectedSources.some((source) => source.group !== group)) {
    throw new Error("一次采集只能包含一个额度组");
  }
  const labelDirectory = join(configDirectory, "account-labels");
  const labelPath = join(labelDirectory, `${group}.json`);
  let groupLabels = [];
  try { groupLabels = JSON.parse(await readFile(labelPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const labels = { [group]: groupLabels };
  const zcodeRegions = group === "zcode" ? await loadZcodeRegions() : new Map();
  const collected = await Promise.all(selectedSources.map((source) => collect(source, labels, zcodeRegions)));
  const cards = collected.flat();
  await mkdir(labelDirectory, { recursive: true, mode: 0o700 });
  await writeFile(labelPath, JSON.stringify(labels[group], null, 2), { mode: 0o600 });
  return cards;
}

function groupSources(group) {
  return sources.filter((source) => source.group === group);
}

async function readCollection(group) {
  try {
    return JSON.parse(await readFile(join(collectionDirectory, `${group}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCollection(group, collection) {
  await mkdir(collectionDirectory, { recursive: true, mode: 0o700 });
  const path = join(collectionDirectory, `${group}.json`);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(collection, null, 2), { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function collectGroupUnlocked(group) {
  const selectedSources = groupSources(group);
  if (!selectedSources.length) throw new Error(`未知额度组 ${group}`);
  const previous = await readCollection(group);
  const previousAttempt = Date.parse(previous?.attempted_at);
  if (Number.isFinite(previousAttempt) && Date.now() - previousAttempt < collectionCooldownMilliseconds) {
    return { ...previous, cached: true };
  }
  const attemptedAt = new Date().toISOString();
  const cards = await collectSources(selectedSources);
  const collection = { group, attempted_at: attemptedAt, cards };
  await writeCollection(group, collection);
  return { ...collection, cached: false };
}

export async function collectGroup(group) {
  await mkdir(collectionDirectory, { recursive: true, mode: 0o700 });
  const { stdout } = await execute("flock", [
    "--exclusive", join(collectionDirectory, `${group}.lock`),
    process.execPath, fileURLToPath(import.meta.url), "--collect-group", group,
  ], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function collectAllGroups() {
  const groups = [...new Set(sources.map((source) => source.group))];
  return Promise.all(groups.map((group) => collectGroup(group)));
}

async function main() {
  const requestedGroup = process.argv[process.argv.indexOf("--collect-group") + 1];
  if (process.argv.includes("--collect-group")) {
    console.log(JSON.stringify(await collectGroupUnlocked(requestedGroup)));
    return;
  }
  const [collections, tibo] = await Promise.all([collectAllGroups(), collectTibo()]);
  const cards = collections.flatMap((collection) => collection.cards);
  if (cards.every((card) => card.error)) throw new Error("所有渠道查询失败，保留云端最近一次数据");
  const collectedAt = new Date();
  const snapshot = {
    collected_at: collectedAt.toISOString(),
    collected_at_seconds: Math.floor(collectedAt.getTime() / 1000),
    collection_attempts: Object.fromEntries(collections.map((collection) => [collection.group, collection.attempted_at])),
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
