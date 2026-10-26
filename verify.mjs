import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sources } from "./sources.mjs";
import { collectTibo } from "./tibo.mjs";
import { XMLParser } from "fast-xml-parser";
import { configDirectory, quotaEndpoint } from "./config.mjs";

const credentials = JSON.parse(await readFile(join(configDirectory, "credentials.json"), "utf8"));
const endpoint = quotaEndpoint();

async function request(path, token, method = "GET", body) {
  return fetch(`${endpoint}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
    signal: AbortSignal.timeout(15000),
  });
}

assert.equal((await request("/health")).status, 200);
assert.equal((await request("/quota")).status, 401);
assert.equal((await request("/quota", credentials.WRITE_TOKEN)).status, 401);
assert.equal((await request("/quota", credentials.READ_TOKEN, "POST", "{}")).status, 401);
assert.equal((await request("/quota", credentials.WRITE_TOKEN, "POST", "invalid-json")).status, 400);
const response = await request("/quota", credentials.READ_TOKEN);
assert.equal(response.status, 200);
const snapshot = await response.json();
assert(snapshot.cards.length > 0);
assert(Number.isFinite(Date.parse(snapshot.collected_at)));
assert(snapshot.cards.some((card) => card.windows.length > 0 && !card.error));
assert(snapshot.cards.every((card) => !Object.hasOwn(card, "user")));
for (const source of sources) {
  const cards = snapshot.cards.filter((card) => card.provider === source.provider);
  assert(cards.length > 0, `${source.provider} 应已上传`);
  assert(cards.every((card) => card.group === source.group && typeof card.account === "string"));
  assert(cards.every((card) => card.name === source.name));
}
for (const provider of sources.filter((source) => ["zcode", "workbuddy"].includes(source.group)).map((source) => source.provider)) {
  const cards = snapshot.cards.filter((card) => card.provider === provider);
  assert(cards.length > 0, `${provider} 应有额度记录`);
  for (const card of cards) {
    assert.equal(card.error, undefined);
    assert.equal(card.source, "magpie");
    assert(Number.isFinite(Date.parse(card.source_read_at)));
    assert(card.windows.length > 0);
    assert(card.windows.every((window) => Number.isFinite(window.remaining) && Number.isFinite(window.used)));
  }
}
for (const provider of sources.filter((source) => source.kind === "antigravity").map((source) => source.provider)) {
  const card = snapshot.cards.find((card) => card.provider === provider);
  assert(card, `${provider} 应有独立额度记录`);
  assert.equal(card.error, undefined);
  assert.equal(card.source, "antigravity-cli");
  assert(Number.isFinite(Date.parse(card.source_read_at)));
  for (const name of ["5 hours", "7 days"]) {
    const window = card.windows.find((window) => window.pool === "Gemini" && window.name === name);
    assert(window, `${provider} 缺少 ${name}`);
    assert(Number.isFinite(window.remaining));
    assert(window.remaining >= 0 && window.remaining <= 100);
    assert(Number.isFinite(Date.parse(window.resetsAt)));
  }
}
for (const card of snapshot.cards) {
  for (const window of card.windows) {
    if (Number.isFinite(Date.parse(window.resetsAt))) {
      assert.equal(window.resets_at_seconds, Math.floor(Date.parse(window.resetsAt) / 1000));
    }
  }
}
const text = await request("/quota.txt", credentials.READ_TOKEN);
assert.equal(text.status, 200);
assert((await text.text()).includes("GPT"));
assert.equal(snapshot.tibo?.source, "AIHOT");
assert.equal(snapshot.tibo.demo, undefined);
assert(snapshot.tibo.next_reset || snapshot.tibo.last_reset);
if (snapshot.tibo.last_reset) assert(Number.isFinite(snapshot.tibo.last_reset.at_seconds));
await collectTibo();
const cachePath = join(configDirectory, "tibo.json");
const firstCache = JSON.parse(await readFile(cachePath, "utf8"));
await Promise.all([collectTibo(), collectTibo()]);
const secondCache = JSON.parse(await readFile(cachePath, "utf8"));
assert.equal(secondCache.attempted_at, firstCache.attempted_at);
assert(secondCache.next_request_at >= Date.parse(secondCache.attempted_at) + 600000);
assert.equal(typeof secondCache.etag, "string");
if (process.argv.includes("--artifacts")) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const manifests = await Promise.all(["GPT", "Claude"].map(async (name) => parser.parse(
    await readFile(new URL(`./watch/private/${name}/manifest.xml`, import.meta.url), "utf8"))));
  assert.notEqual(manifests[0]["iq:manifest"]["iq:application"]["@_id"], manifests[1]["iq:manifest"]["iq:application"]["@_id"]);
  for (const filename of ["GPT.prg", "Claude.prg", "simulator.png", "simulator-detail.png", "simulator-gpt.png", "simulator-gpt-announced.png", "simulator-claude.png"]) {
    const download = await request(`/${filename}`);
    assert.equal(download.status, 200);
    if (filename.endsWith(".prg")) assert(download.headers.get("content-disposition").includes(filename));
    const local = await readFile(new URL(`./watch/bin/${filename}`, import.meta.url));
    assert(Buffer.from(await download.arrayBuffer()).equals(local));
  }
  console.log("两个独立应用和五张模拟器截图：直接下载及内容检查通过");
}
console.log("真实 KV 读写通过；未授权访问、读写权限隔离、错误请求检查通过");
console.log("Tibo 真实采集、十分钟请求间隔和并发缓存复用通过；生产快照使用真实公告");
