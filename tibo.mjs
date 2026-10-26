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

const beijingFormatter = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

function beijingDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const stamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(stamp)) return null;
  const parts = Object.fromEntries(beijingFormatter.formatToParts(stamp)
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function predictionSummary(event) {
  const precision = event.schedule?.precision ?? (event.estimate ? "estimate" : "date");
  let expectedAt = null;
  let predictionDate = null;
  let deadline = false;
  if (event.schedule) {
    const scheduled = event.schedule;
    if (precision === "date") {
      predictionDate = beijingDate(scheduled.through ?? scheduled.from);
    } else {
      deadline = precision === "deadline" || precision === "window";
      expectedAt = deadline ? (scheduled.through ?? scheduled.from) : scheduled.from;
      predictionDate = beijingDate(expectedAt);
    }
  } else if (event.estimate) {
    deadline = true;
    expectedAt = event.estimate.through ?? event.estimate.from;
    predictionDate = beijingDate(expectedAt);
  } else {
    predictionDate = beijingDate(event.occurredOn ?? event.confirmedAt);
  }
  if (!predictionDate) return null;
  const expected = Date.parse(expectedAt);
  const throughAt = event.schedule?.through ?? event.estimate?.through;
  const through = Date.parse(throughAt);
  const dateSeconds = Date.parse(`${predictionDate}T00:00:00+08:00`) / 1000;
  return {
    ...eventSummary(event),
    status: event.presentation?.status ?? event.status,
    confirmed: event.status === "confirmed",
    precision,
    date: predictionDate,
    date_seconds: dateSeconds,
    ...(Number.isFinite(expected) ? { expected_at: expectedAt, expected_at_seconds: expected / 1000 } : {}),
    ...(Number.isFinite(through) ? {
      through: throughAt,
      through_seconds: through / 1000,
    } : {}),
    deadline,
  };
}

function summarize(data, previous) {
  const today = beijingDate(Date.now());
  const predictions = data.events.map(predictionSummary)
    .filter((prediction) => prediction != null && prediction.date >= today);
  predictions.sort((left, right) => left.date_seconds - right.date_seconds
    || (left.expected_at_seconds ?? left.date_seconds) - (right.expected_at_seconds ?? right.date_seconds));
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
  return { source: "AIHOT", source_url: endpoint, checked_at: data.checkedAt,
    next_reset: predictions[0] ?? null, last_reset: last };
}

function cacheSummary(cache) {
  if (Array.isArray(cache.response?.events)) return summarize(cache.response, cache.summary);
  return cache.summary ?? null;
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
  if (now < (cache.next_request_at ?? 0)) return cacheSummary(cache);
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
      cache.summary = cacheSummary(cache);
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
  return cacheSummary(cache);
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
    try { return cacheSummary(await readCache()); }
    catch { return null; }
  }
}

if (process.argv.includes("--collect")) {
  console.log(JSON.stringify(await refresh()));
}
