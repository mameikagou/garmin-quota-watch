import { execFile } from "node:child_process";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { configDirectory } from "./config.mjs";

const execute = promisify(execFile);
const endpoint = "https://aihot.news/api/v1/codex-resets/recent";
const directory = configDirectory;
const cachePath = join(directory, "tibo.json");
const minimumInterval = 10 * 60 * 1000;

async function readCache() {
  try { return JSON.parse(await readFile(cachePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return {}; }
}

async function saveCache(cache) {
  await writeFile(`${cachePath}.pending`, JSON.stringify(cache), { mode: 0o600 });
  await rename(`${cachePath}.pending`, cachePath);
}

function eventSummary(event) {
  return {
    id: event.id, kind: event.type, label: event.displayLabel,
    scope: event.presentation?.scopeLabel ?? event.scope, url: event.url,
    updated_at: event.updatedAt,
  };
}

function summarize(data, previous) {
  const pending = data.events.filter((event) => event.status === "announced"
    && event.presentation?.status !== "likely_completed");
  pending.sort((left, right) => {
    const leftTime = Date.parse(left.schedule?.from ?? left.estimate?.from);
    const rightTime = Date.parse(right.schedule?.from ?? right.estimate?.from);
    return (Number.isFinite(leftTime) ? leftTime : Infinity) - (Number.isFinite(rightTime) ? rightTime : Infinity);
  });
  const confirmed = data.events.filter((event) => event.status === "confirmed"
    && Number.isFinite(Date.parse(event.occurredOn ?? event.confirmedAt)));
  confirmed.sort((left, right) => Date.parse(right.occurredOn ?? right.confirmedAt)
    - Date.parse(left.occurredOn ?? left.confirmedAt));
  let last = null;
  if (confirmed.length) {
    const event = confirmed[0];
    const time = event.occurredOn ? `${event.occurredOn}T00:00:00+08:00` : event.confirmedAt;
    last = { ...eventSummary(event), at: time, at_seconds: Date.parse(time) / 1000,
      basis: event.occurredOn ? "occurrence_day" : "confirmation_post" };
  } else if (previous?.last_reset && Date.parse(previous.last_reset.updated_at) < Date.parse(data.historyFrom)
      && !(data.activities ?? []).some((activity) => activity.action === "withdraw"
        && activity.eventIds?.includes(previous.last_reset.id))) {
    // recent 窗口之外的最近一次确认仍可保留；窗口内的撤回按新响应更新。
    last = previous.last_reset;
  }
  const event = pending[0];
  let next = null;
  if (event) {
    const window = event.schedule ?? event.estimate;
    const expected = Date.parse(window?.from);
    let timeBasis = "unspecified";
    if (event.schedule) timeBasis = "source_schedule";
    else if (event.estimate) timeBasis = `estimate_${event.estimate.basis}`;
    next = { ...eventSummary(event), status: event.presentation?.status ?? "announced",
      ...(Number.isFinite(expected) ? { expected_at: window.from, expected_at_seconds: expected / 1000 } : {}),
      ...(window?.through ? { through: window.through, through_seconds: Date.parse(window.through) / 1000 } : {}),
      time_basis: timeBasis };
  }
  return { source: "AIHOT", source_url: endpoint, checked_at: data.checkedAt,
    next_reset: next, last_reset: last };
}

function nextRequest(response, now) {
  const retry = response.headers.get("retry-after");
  const retryTime = /^\d+$/.test(retry ?? "") ? now + Number(retry) * 1000 : Date.parse(retry);
  const cacheControl = response.headers.get("cache-control") ?? "";
  const maxAge = /(?:s-maxage|max-age)=(\d+)/.exec(cacheControl);
  return Math.max(now + minimumInterval, Number.isFinite(retryTime) ? retryTime : 0,
    maxAge ? now + Number(maxAge[1]) * 1000 : 0);
}

async function refresh() {
  const cache = await readCache();
  const now = Date.now();
  if (now < (cache.next_request_at ?? 0)) return cache.summary ?? null;
  cache.next_request_at = now + minimumInterval;
  cache.attempted_at = new Date(now).toISOString();
  await saveCache(cache);
  try {
    const response = await fetch(endpoint, {
      headers: { "User-Agent": "aihot-api/2.0.0", "Accept-Encoding": "gzip, br", Accept: "application/json",
        ...(cache.etag ? { "If-None-Match": cache.etag } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    cache.next_request_at = nextRequest(response, Date.now());
    cache.http_status = response.status;
    cache.conditional_request = Boolean(cache.etag);
    cache.content_encoding = response.headers.get("content-encoding");
    if (response.status === 304) {
      cache.etag = response.headers.get("etag") ?? cache.etag;
      cache.validated_at = new Date().toISOString();
    } else if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data.events)) throw new Error("AIHOT 未返回事件列表");
      cache.summary = summarize(data, cache.summary);
      cache.response = data;
      cache.etag = response.headers.get("etag");
      cache.validated_at = new Date().toISOString();
    } else {
      throw new Error(`AIHOT HTTP ${response.status}`);
    }
    delete cache.error;
  } catch (error) {
    cache.error = error.message;
    console.error(`Tibo 监控保留上次结果：${error.message}`);
  }
  await saveCache(cache);
  return cache.summary ?? null;
}

export async function collectTibo() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const { stdout, stderr } = await execute("flock", ["-w", "1", join(directory, "tibo.lock"),
      process.execPath, fileURLToPath(import.meta.url), "--collect"], { timeout: 15000 });
    if (stderr) console.error(stderr.trim());
    return JSON.parse(stdout);
  } catch (error) {
    console.error(`Tibo 监控保留上次结果：${error.message}`);
    try { return (await readCache()).summary ?? null; }
    catch { return null; }
  }
}

if (process.argv.includes("--collect")) {
  console.log(JSON.stringify(await refresh()));
}
