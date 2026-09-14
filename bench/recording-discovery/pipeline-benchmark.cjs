/* Localhost-only experiment. Reads no captures, credentials, or live sites.
 * Run: node bench/recording-discovery/pipeline-benchmark.cjs
 * Results are checkpointed into pipeline-results.json beside this script.
 */
"use strict";
const http = require("node:http");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { parseHTML } = require("linkedom");
const P = require("../../firefox/parser.js");

const BASE = "https://useradmin.comma.ai/?onebox=syntheticdevice";
const FROM = "2026-09-08", THROUGH = "2026-09-14", DELAY_MS = 15, BUDGET = 4;
const TYPES = ["rlog.zst", "qlog.zst", "qcamera.ts", "fcamera.hevc", "ecamera.hevc", "dcamera.hevc"];
const dayAgo = n => new Date(Date.UTC(2026, 8, 14 - n)).toISOString().slice(0, 10);
const wanted = date => date !== null && date >= FROM && date <= THROUGH;
const rounded = value => value === null ? null : Math.round(value * 10) / 10;

function fixtures(count) {
  const routes = Array.from({ length: count }, (_, id) => ({
    id, key: `syntheticdevice|${id.toString(16).padStart(8, "0")}--abcdef0123`,
    uploadDate: dayAgo(Math.floor(id / 17)),
    recordedDate: id % 41 === 0 ? null : dayAgo((id * 17 + 3) % 60),
    live: id % 29 === 0
  }));
  // An old drive uploaded today and a recent drive near the end of enumeration.
  routes[0].recordedDate = dayAgo(45);
  routes[count - 1].recordedDate = dayAgo(1);
  return routes;
}

function listingHtml(routes, next) {
  const rows = routes.map(r => `<tr><td>${r.uploadDate} 18:00:00</td><td><a href="?onebox=${encodeURIComponent(r.key)}">${r.key}</a></td></tr>`).join("");
  return `<table id="table_routes"><tr><th>upload time</th><th>route_name</th></tr>${rows}</table>${next === null ? "" : `<a rel="next" data-next-page="${next}">More routes</a>`}`;
}

function routeHtml(route) {
  const [device, name] = route.key.split("|");
  const files = Array.from({ length: 20 }, (_, segment) => TYPES.map(type =>
    `<a href="https://commadata2.blob.core.windows.net/synthetic/${device}/${name}/${segment}/${type}?sig=synthetic-only">${type}</a>`).join(" ")).join("\n");
  return `<table id="table_route5_route"><tr><td>create_time</td><td>1700000000</td></tr><tr><td>start_time</td><td>${route.recordedDate ? `${route.recordedDate}T08:00:00` : "unknown"}</td></tr><tr><td>end_time</td><td>${route.recordedDate ? `${route.recordedDate}T08:20:00` : "unknown"}</td></tr></table><section>${files}</section>`;
}

function recordingDate(doc) {
  for (const row of doc.querySelectorAll("#table_route5_route tr")) {
    const cells = Array.from(row.children);
    if (cells[0]?.textContent.trim() === "start_time") return P.parseRouteUploadDate(cells[1]?.textContent.trim().replace("T", " "));
  }
  return null;
}

// Listing and detail requests share this budget. A listing request gets the next
// free slot, but cannot create a fifth active request. Rejections are handled at
// task creation, and stop() rejects every queued job and aborts active fetches.
class RequestBudget {
  constructor(origin, onStop = () => {}) {
    this.origin = origin;
    this.controller = new AbortController();
    this.active = 0;
    this.peak = 0;
    this.queue = [];
    this.dispatched = 0;
    this.queuedAtStop = 0;
    this.activeAtStop = 0;
    this.dispatchedAtStop = null;
    this.error = null;
    this.onStop = onStop;
    this.stoppedAt = null;
  }
  acquire(priority) {
    if (this.error) return Promise.reject(this.error);
    if (this.active < BUDGET) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      if (priority) this.queue.unshift(entry); else this.queue.push(entry);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next.resolve(); else this.active--;
  }
  stop(error) {
    if (this.error) return;
    this.error = error;
    this.queuedAtStop = this.queue.length;
    this.activeAtStop = this.active;
    this.dispatchedAtStop = this.dispatched;
    this.stoppedAt = performance.now();
    this.onStop();
    this.controller.abort(error);
    for (const item of this.queue.splice(0)) item.reject(error);
  }
  async fetch(path, priority = false) {
    await this.acquire(priority);
    try {
      if (this.error) throw this.error;
      this.dispatched++;
      const response = await fetch(this.origin + path, { signal: this.controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      this.stop(error);
      throw error;
    } finally {
      this.release();
    }
  }
}

async function createEnvironment(count, pageSize, { duplicates = false, stale = false, failRoute = null, routeDelayMs = DELAY_MS } = {}) {
  const routes = fixtures(count);
  const cache = new Map();
  // Invented mostly warm cache. Known live, missing-date and expired records are
  // excluded, but a recently corrected date on a supposedly stable route cannot
  // be detected without fresh metadata. No signed URL or file list is cached.
  for (const route of routes) {
    if (route.id % 20 && route.recordedDate && !route.live && route.id % 37) cache.set(route.key, route.recordedDate);
  }
  const changed = routes[1];
  assert(cache.has(changed.key) && !wanted(cache.get(changed.key)));
  if (stale) changed.recordedDate = dayAgo(1);
  const chunks = [];
  for (let offset = 0; offset < count; offset += pageSize) {
    const chunk = routes.slice(offset, offset + pageSize);
    if (duplicates && offset) chunk.unshift(routes[offset - 1]);
    chunks.push(chunk);
  }
  if (duplicates) chunks.splice(1, 0, chunks[0]); // Empty-of-new-routes page must not end enumeration.
  const pages = chunks.map((chunk, i) => listingHtml(chunk, i + 1 < chunks.length ? i + 1 : null));
  const details = routes.map(routeHtml);
  let counters = null;
  const server = http.createServer((request, response) => {
    const match = request.url.match(/^\/(listing|route)\/(\d+)$/);
    if (!match || !counters) { response.writeHead(404); response.end(); return; }
    const stats = counters, type = match[1], id = Number(match[2]);
    const html = (type === "listing" ? pages : details)[id];
    if (html === undefined) { response.writeHead(404); response.end(); return; }
    stats[type]++;
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stats.active--;
      if (!response.writableFinished) stats.aborted++;
    };
    const timer = setTimeout(() => {
      const status = type === "route" && id === failRoute ? 503 : 200;
      stats.responseBytes += Buffer.byteLength(html);
      response.writeHead(status, { "Content-Type": "text/html" });
      response.end(html);
    }, type === "route" && id !== failRoute ? routeDelayMs : DELAY_MS);
    response.on("finish", cleanup);
    response.on("close", cleanup);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    routes, cache, changedKey: changed.key, expectedPages: pages.length,
    origin: `http://127.0.0.1:${server.address().port}`,
    reset() { counters = { listing: 0, route: 0, active: 0, peak: 0, aborted: 0, responseBytes: 0 }; return counters; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}

async function discover(env, strategy, { warm = false, fullRefresh = false, cancel = false } = {}) {
  const stats = env.reset(), seen = new Map(), found = new Map();
  const budget = new RequestBudget(env.origin, () => { stats.activeAtClientStop = stats.active; });
  const byKey = new Map(env.routes.map(route => [route.key, route]));
  let firstMatchMs = null, parserMs = 0, cancelTimer = null, unknownDates = 0;
  const tasks = [], started = performance.now();
  const parse = html => { const t = performance.now(); const doc = parseHTML(html).document; parserMs += performance.now() - t; return doc; };
  const visit = async route => {
    if (warm && !fullRefresh && env.cache.has(route.key) && !wanted(env.cache.get(route.key))) return;
    if (cancel && !cancelTimer) cancelTimer = setTimeout(() => budget.stop(new Error("User cancelled")), 65);
    const doc = parse(await budget.fetch(`/route/${byKey.get(route.key).id}`));
    const t = performance.now(), date = recordingDate(doc);
    if (date === null) unknownDates++;
    if (wanted(date)) {
      found.set(route.key, P.collectLogFiles(doc, ["rlog"], BASE));
      if (firstMatchMs === null) firstMatchMs = performance.now() - started;
    }
    parserMs += performance.now() - t;
  };
  const enqueue = route => tasks.push(visit(route).catch(error => budget.stop(error)));
  try {
    let page = 0;
    const visitedPages = new Set();
    while (page !== null) {
      assert(!visitedPages.has(page), "pagination cursor loop");
      visitedPages.add(page);
      const doc = parse(await budget.fetch(`/listing/${page}`, true));
      const t = performance.now(), routes = P.collectRouteLinks(doc, BASE);
      parserMs += performance.now() - t;
      for (const route of routes) {
        if (seen.has(route.key)) continue;
        seen.set(route.key, route);
        if (strategy === "pipelined") enqueue(route);
      }
      const next = doc.querySelector('[rel="next"]')?.getAttribute("data-next-page");
      page = next === undefined || next === null ? null : Number(next);
    }
    if (strategy === "staged") for (const route of seen.values()) enqueue(route);
  } catch (error) {
    budget.stop(error);
  }
  await Promise.all(tasks);
  if (cancelTimer) clearTimeout(cancelTimer);
  const wallMs = performance.now() - started;
  // Observe known server requests settling rather than assuming a fixed sleep
  // is enough. The two-second bound is an assertion deadline, not a delay.
  // Client abort cannot prove that a remote server has stopped its own work.
  const cleanupStarted = performance.now();
  if (budget.error) {
    while (stats.active && performance.now() - cleanupStarted < 2000) await new Promise(resolve => setTimeout(resolve, 1));
  }
  const serverDrainWaitMs = performance.now() - cleanupStarted;
  assert.equal(budget.active, 0);
  assert.equal(budget.queue.length, 0);
  assert.equal(stats.active, 0);
  assert(budget.peak <= BUDGET && stats.peak <= BUDGET);
  if (budget.error) assert.equal(budget.dispatched, budget.dispatchedAtStop);
  const expected = env.routes.filter(r => wanted(r.recordedDate)).map(r => r.key).sort();
  const keys = [...found.keys()].sort();
  const missing = expected.filter(key => !found.has(key));
  const unexpected = keys.filter(key => !expected.includes(key));
  for (const files of found.values()) assert.equal(files.length, 20);
  return {
    strategy, warmCache: warm, fullRefresh,
    uniqueRoutesDiscovered: seen.size, matchedRoutes: found.size, selectedRlogs: found.size * 20, unknownDates,
    firstMatchMs: rounded(firstMatchMs), wallMs: rounded(wallMs), parserMs: rounded(parserMs),
    requests: stats.listing + stats.route, listingRequests: stats.listing, detailRequests: stats.route,
    responseBytes: stats.responseBytes, peakConcurrentRequests: stats.peak,
    correct: missing.length === 0 && unexpected.length === 0,
    missingMatches: missing.length, unexpectedMatches: unexpected.length,
    missingOnlyChangedDate: missing.length === 1 && missing[0] === env.changedKey,
    stopped: budget.error?.message ?? null, queuedAtStop: budget.queuedAtStop,
    activeAtStop: budget.activeAtStop, activeAfterStop: budget.active,
    dispatchedAfterStop: budget.error ? budget.dispatched - budget.dispatchedAtStop : 0,
    abortedServerResponses: stats.aborted, serverActiveAfterCleanup: stats.active,
    serverActiveAtClientStop: stats.activeAtClientStop ?? null,
    clientSettleAfterStopMs: budget.stoppedAt === null ? null : rounded(cleanupStarted - budget.stoppedAt),
    serverDrainWaitMs: rounded(serverDrainWaitMs)
  };
}

function median(values) { const sorted = values.toSorted((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }

(async () => {
  const rows = [], correctnessCases = [];
  const faultOnly = process.argv.includes("--faults-only");
  const correctnessOnly = process.argv.includes("--correctness-only");
  const save = result => { if (!faultOnly && !correctnessOnly) fs.writeFileSync(path.join(__dirname, "pipeline-results.json"), JSON.stringify(result, null, 2) + "\n"); };
  if (!faultOnly && !correctnessOnly) {
    for (const count of [500, 1000]) for (const pageSize of [50, 200]) {
      const env = await createEnvironment(count, pageSize);
      try {
        // Untimed-by-report parser/connection warm-up; every measured strategy then
        // runs three rounds and alternates order to reduce first-run/JIT bias.
        await discover(env, "pipelined", { warm: true });
        for (let round = 1; round <= 3; round++) for (const warm of [false, true]) {
          const order = (round + Number(warm)) % 2 ? ["staged", "pipelined"] : ["pipelined", "staged"];
          for (const strategy of order) {
            const result = await discover(env, strategy, { warm });
            assert(result.correct && !result.stopped);
            assert.equal(result.uniqueRoutesDiscovered, count);
            assert.equal(result.listingRequests, env.expectedPages);
            const expectedDetails = env.routes.filter(route => !warm || !env.cache.has(route.key) || wanted(env.cache.get(route.key))).length;
            assert.equal(result.detailRequests, expectedDetails);
            rows.push({ routes: count, pageSize, round, initialCacheEntries: warm ? env.cache.size : 0, ...result });
            save({ kind: "measured-localhost-pipeline", complete: false, rows, correctnessCases });
            process.stderr.write(`${count}/${pageSize} round ${round} ${warm ? "warm" : "cold"} ${strategy}: first ${result.firstMatchMs}ms, total ${result.wallMs}ms, ${result.requests} requests\n`);
          }
        }
      } finally { await env.close(); }
    }
  }
  if (!faultOnly) {
    const duplicateEnv = await createEnvironment(500, 50, { duplicates: true });
    try {
      for (const strategy of ["staged", "pipelined"]) {
        const result = await discover(duplicateEnv, strategy);
        assert(result.correct && !result.stopped);
        assert.equal(result.detailRequests, 500);
        assert.equal(result.listingRequests, 11);
        correctnessCases.push({ case: "duplicate-routes-and-entire-page-plus-late-uploads", ...result });
      }
    } finally { await duplicateEnv.close(); }
    const staleEnv = await createEnvironment(500, 50, { stale: true });
    try {
      const stale = await discover(staleEnv, "pipelined", { warm: true });
      assert.equal(stale.correct, false);
      assert.equal(stale.missingOnlyChangedDate, true);
      correctnessCases.push({ case: "fresh-looking-cache-misses-corrected-date", expectedLimitation: true, ...stale });
      const refreshed = await discover(staleEnv, "pipelined", { warm: true, fullRefresh: true });
      assert(refreshed.correct && !refreshed.stopped);
      assert.equal(refreshed.detailRequests, 500);
      correctnessCases.push({ case: "full-refresh-recovers-corrected-date", ...refreshed });
    } finally { await staleEnv.close(); }
  }
  for (const fault of ["cancel", "503"]) {
    // Slow siblings ensure the stop signal catches genuine outstanding server
    // responses, instead of only client continuations after responses finish.
    const env = await createEnvironment(500, 50, { failRoute: fault === "503" ? 3 : null, routeDelayMs: 80 });
    try {
      const result = await discover(env, "pipelined", { cancel: fault === "cancel" });
      assert.equal(result.stopped, fault === "cancel" ? "User cancelled" : "HTTP 503");
      assert(result.queuedAtStop > 0 && result.activeAtStop > 0);
      assert(result.serverActiveAtClientStop > 0);
      assert(result.abortedServerResponses > 0);
      assert(result.requests < 500);
      correctnessCases.push({ case: `${fault}-stops-queued-and-active-work`, faultRouteDelayMs: 80, ...result });
    } finally { await env.close(); }
  }
  const summaries = [];
  for (const routes of [500, 1000]) for (const pageSize of [50, 200]) for (const warmCache of [false, true]) for (const strategy of ["staged", "pipelined"]) {
    const group = rows.filter(r => r.routes === routes && r.pageSize === pageSize && r.warmCache === warmCache && r.strategy === strategy);
    if (!group.length) continue;
    summaries.push({ routes, pageSize, warmCache, strategy,
      medianFirstMatchMs: median(group.map(r => r.firstMatchMs)), medianWallMs: median(group.map(r => r.wallMs)),
      minWallMs: Math.min(...group.map(r => r.wallMs)), maxWallMs: Math.max(...group.map(r => r.wallMs)),
      requests: group[0].requests, peakConcurrentRequests: Math.max(...group.map(r => r.peakConcurrentRequests)), allCorrect: group.every(r => r.correct) });
  }
  const result = { kind: "measured-localhost-pipeline", complete: !faultOnly && !correctnessOnly, environment: { node: process.version, platform: process.platform, arch: process.arch },
    assumptions: {
      responseDelayMs: DELAY_MS, sharedRequestBudget: BUDGET, rounds: 3, listingPageSizes: [50, 200], filesPerRoute: 120,
      enumeration: "Sequential next-page discovery; listing gets priority within the shared four-slot budget. No extra fifth request.",
      network: "Loopback HTTP with synthetic fixed response delay; no mobile bandwidth cap, server throttling, live account, or production requests.",
      parser: "Node/linkedom parses invented HTML with the production route/file parser. This is not native Firefox or Android timing.",
      eventLoop: "The synthetic HTTP server and synchronous client parsing share one Node event loop; client parsing can also delay server timers. A remote server would not share this coupling.",
      recordingDate: "The scheduler experiment uses invented ISO start_time text. It does not validate real timestamp formats or timezone interpretation.",
      cache: "Synthetic mostly warm recording-date metadata only; known live, missing-date, and TTL-expired entries refetched. Selected routes always fetched once for current file links.",
      freshness: "A recently corrected date outside the chosen range can be missed by a valid-TTL cache; the explicit stale-date case demonstrates this. Only full refresh is complete under that model.",
      unknowns: "Unknown recording dates remain unknown and are refetched on each scan; cache cannot prove a route is no longer live.",
      pagination: "Page-size variants are simulation inputs, not proof the real site accepts larger pages. Complete repeated pages do not imply end of listing.",
      stop: "Cancel/503 must abort active requests, reject queued work, settle all tasks, and dispatch no additional request after stop. Partial results are not a complete result. Client settlement and observed server drain are reported separately; server drain is observed until active requests reach zero, with a two-second assertion deadline. Client abort cannot prove that a remote server stopped its own processing."
    }, summaries, rows, correctnessCases };
  save(result);
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
