/* Localhost-only experiment. Never reads captures, credentials, or live sites. */
"use strict";
const http = require("node:http");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { parseHTML } = require("linkedom");
const P = require("../../firefox/parser.js");

const BASE = "https://useradmin.comma.ai/?onebox=syntheticdevice";
const FROM = "2026-09-08", THROUGH = "2026-09-14", PAGE_SIZE = 50;
const DELAY_MS = 15;
const TYPES = ["rlog.zst", "qlog.zst", "qcamera.ts", "fcamera.hevc", "ecamera.hevc", "dcamera.hevc"];
const dayAgo = n => new Date(Date.UTC(2026, 8, 14 - n)).toISOString().slice(0, 10);
const wanted = date => date !== null && date >= FROM && date <= THROUGH;

function fixtures(count) {
  return Array.from({ length: count }, (_, id) => ({
    id, key: `syntheticdevice|${id.toString(16).padStart(8, "0")}--abcdef0123`,
    // Listing order and recording order deliberately disagree; unknowns stay unknown.
    uploadDate: dayAgo(Math.floor(id / 17)),
    recordedDate: id % 41 === 0 ? null : dayAgo((id * 17 + 3) % 60),
    live: id % 29 === 0
  }));
}

function listingHtml(routes, page) {
  const rows = routes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(r =>
    `<tr><td>${r.uploadDate} 18:00:00</td><td><a href="?onebox=${encodeURIComponent(r.key)}">${r.key}</a></td></tr>`).join("");
  const more = (page + 1) * PAGE_SIZE < routes.length ? `<button onclick="loadMoreRoutes(${page})">More routes</button>` : "";
  return `<details><summary>routes (${routes.length})</summary><table id="table_routes"><tr><th>upload time</th><th>route_name</th></tr>${rows}</table>${more}</details>`;
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
    if (cells[0]?.textContent.trim() === "start_time") {
      return P.parseRouteUploadDate(cells[1]?.textContent.trim().replace("T", " "));
    }
  }
  return null;
}

async function pool(items, concurrency, visit) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) await visit(items[next++]);
  }));
}

async function run(count) {
  const routes = fixtures(count), byKey = new Map(routes.map(r => [r.key, r]));
  const pages = Array.from({ length: Math.ceil(count / PAGE_SIZE) }, (_, page) => listingHtml(routes, page));
  const details = routes.map(routeHtml);
  let counters;
  const server = http.createServer((request, response) => {
    const match = request.url.match(/^\/(listing|route)\/(\d+)$/);
    if (!match) { response.writeHead(404); response.end(); return; }
    const html = (match[1] === "listing" ? pages : details)[Number(match[2])];
    if (html === undefined) { response.writeHead(404); response.end(); return; }
    counters.active++;
    counters.peak = Math.max(counters.peak, counters.active);
    counters[match[1]]++;
    counters.bytes += Buffer.byteLength(html);
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
      counters.active--;
    }, DELAY_MS);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  try {
    for (const [name, workers, warm] of [["sequential", 1, false], ["pool-4", 4, false], ["pool-8", 8, false], ["warm-cache-pool-4", 4, true]]) {
      counters = { listing: 0, route: 0, active: 0, peak: 0, bytes: 0 };
      let parseMs = 0;
      const cache = new Map();
      // Model a mostly populated cache, excluding missing dates, live routes and
      // TTL-expired records. Values contain only the recording date, never URLs.
      if (warm) for (const route of routes) {
        if (route.id % 20 && route.recordedDate && !route.live && route.id % 37) cache.set(route.key, route.recordedDate);
      }
      const initialCacheEntries = cache.size;
      const fetchDoc = async path => {
        const response = await fetch(origin + path);
        assert.equal(response.status, 200);
        const html = await response.text();
        const started = performance.now();
        const doc = parseHTML(html).document;
        parseMs += performance.now() - started;
        return doc;
      };
      const begin = performance.now(), discovered = [];
      for (let page = 0; page < pages.length; page++) {
        const doc = await fetchDoc(`/listing/${page}`);
        const started = performance.now();
        discovered.push(...P.collectRouteLinks(doc, BASE));
        parseMs += performance.now() - started;
      }
      const found = new Map();
      await pool(discovered, workers, async route => {
        if (cache.has(route.key) && !wanted(cache.get(route.key))) return;
        const fixture = byKey.get(route.key);
        const doc = await fetchDoc(`/route/${fixture.id}`);
        const started = performance.now();
        const date = recordingDate(doc);
        if (wanted(date)) {
          // Parse selected files from the same response; do not fetch twice.
          found.set(route.key, P.collectLogFiles(doc, ["rlog"], BASE));
        }
        parseMs += performance.now() - started;
      });
      const wallMs = performance.now() - begin;
      assert.deepEqual([...found.keys()].sort(), routes.filter(r => wanted(r.recordedDate)).map(r => r.key).sort());
      assert.equal([...found.values()].reduce((n, files) => n + files.length, 0), found.size * 20);
      assert(counters.peak <= workers);
      assert.equal(counters.route, warm ? routes.filter(r => !cache.has(r.key) || wanted(cache.get(r.key))).length : count);
      const entry = { strategy: name, routes: count, initialCacheEntries, matchedRoutes: found.size, selectedRlogs: found.size * 20,
        requests: counters.listing + counters.route, listingRequests: counters.listing, detailRequests: counters.route,
        responseBytes: counters.bytes, peakConcurrentRequests: counters.peak, wallMs: Math.round(wallMs), parserMs: Math.round(parseMs), correct: true };
      results.push(entry);
      process.stderr.write(`${count} routes ${name}: ${entry.wallMs}ms, ${entry.requests} requests, correct\n`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return results;
}

(async () => {
  const rows = [];
  for (const count of [300, 1000]) rows.push(...await run(count));
  console.log(JSON.stringify({ kind: "measured-localhost", environment: { node: process.version, platform: process.platform, arch: process.arch },
    assumptions: { artificialResponseDelayMs: DELAY_MS, listingPageSize: PAGE_SIZE, filesPerRoute: 120, selectedRlogsPerMatchedRoute: 20,
      network: "loopback HTTP; no shared mobile bandwidth cap or server rate limit; no production requests", repetitions: 1,
      cache: "synthetic mostly warm recording-date cache; unknown, live and TTL-expired entries refetched; selected pages always refetched",
      limitations: "Node/linkedom timing is not Firefox Android or live comma performance. Cache freshness and account-scoped persistence are assumptions, not implemented production behavior." }, rows }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
