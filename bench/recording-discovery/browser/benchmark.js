/* Offline fixture benchmark. It does not read uploads, credentials or live pages. */
"use strict";
const P = globalThis.CommaParser;
const FROM = "2026-09-08", THROUGH = "2026-09-14", RESPONSE_DELAY_MS = 20;
const BASE = "https://useradmin.comma.ai/?onebox=syntheticdevice";
const TYPES = ["rlog.zst", "qlog.zst", "qcamera.ts", "fcamera.hevc", "ecamera.hevc", "dcamera.hevc"];
const TYPE_KEYS = ["rlog", "qlog", "qcamera", "fcamera", "ecamera", "dcamera"];
const STRATEGIES = [
  {name: "eager-all-links-pool-4", workers: 4, eager: true, warm: false},
  {name: "metadata-first-pool-1", workers: 1, eager: false, warm: false},
  {name: "metadata-first-pool-4", workers: 4, eager: false, warm: false},
  {name: "metadata-first-pool-8", workers: 8, eager: false, warm: false},
  {name: "warm-date-cache-pool-4", workers: 4, eager: false, warm: true}
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dayAgo = days => new Date(Date.UTC(2026, 8, 14 - days)).toISOString().slice(0, 10);
const wanted = date => date !== null && date >= FROM && date <= THROUGH;
const round = value => Math.round(value * 100) / 100;
const assert = (value, message) => { if (!value) throw new Error(message); };
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0);
};

function fixtures(count) {
  return Array.from({length: count}, (_, id) => {
    const name = `${id.toString(16).padStart(8, "0")}--abcdef0123`;
    const recordedDate = id % 41 === 0 ? null : dayAgo((id * 17 + 3) % 60);
    const files = Array.from({length: 20}, (_, segment) => TYPES.map(type =>
      `<a href="https://commadata2.blob.core.windows.net/synthetic/syntheticdevice/${name}/${segment}/${type}?sig=synthetic-only">${type}</a>`
    ).join(" ")).join("\n");
    // The route ID is opaque; upload order deliberately disagrees with recording order.
    // Decoy create_time and end_time must not decide the recording-start filter.
    const html = `<!doctype html><html><body><h1>Synthetic route ${id}</h1><table id="table_route5_route"><tr><td>create_time</td><td>2026-09-14T12:00:00</td></tr><tr><td>start_time</td><td>${recordedDate ? `${recordedDate}T08:00:00` : "unknown"}</td></tr><tr><td>end_time</td><td>2026-09-14T23:00:00</td></tr></table><section>${files}</section></body></html>`;
    return {id, name, recordedDate, live: id % 29 === 0, html};
  });
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

async function digestTokens(tokens) {
  const bytes = new TextEncoder().encode([...tokens].sort().join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function runStrategy(routes, strategy, repetition) {
  const cache = new Map();
  if (strategy.warm) for (const route of routes) {
    // Invented warm-cache distribution. Unknown/live/expired/missing entries refetch.
    if (route.id % 20 && route.recordedDate && !route.live && route.id % 37) {
      cache.set(route.id, route.recordedDate);
    }
  }
  const stats = {detailRequests: 0, peakInFlight: 0, domParseMs: 0, metadataMs: 0,
    fileEnumerationMs: 0, responseBytes: 0, enumeratedFileLinks: 0};
  const taskSamples = [], lagSamples = [], matched = [], tokens = [];
  let inFlight = 0, next = 0, nextTick = performance.now() + 20;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    lagSamples.push(Math.max(0, now - nextTick));
    nextTick = now + 20;
  }, 20);
  const begin = performance.now();
  try {
    await Promise.all(Array.from({length: strategy.workers}, async () => {
      while (next < routes.length) {
        const route = routes[next++];
        if (cache.has(route.id) && !wanted(cache.get(route.id))) continue;
        stats.detailRequests++;
        stats.responseBytes += route.html.length; // All fixtures are ASCII.
        stats.peakInFlight = Math.max(stats.peakInFlight, ++inFlight);
        await delay(RESPONSE_DELAY_MS); // No fetch: CSP also denies every connection.
        const taskStart = performance.now();
        const doc = new DOMParser().parseFromString(route.html, "text/html");
        const parsed = performance.now();
        const date = recordingDate(doc);
        const metadataRead = performance.now();
        let files = [];
        if (strategy.eager || wanted(date)) {
          // Hold requested types constant: eager means inspect file links on
          // every route, not materialize more file types than the other strategies.
          files = P.collectLogFiles(doc, ["rlog"], BASE);
          stats.enumeratedFileLinks += 120;
        }
        const enumerated = performance.now();
        stats.domParseMs += parsed - taskStart;
        stats.metadataMs += metadataRead - parsed;
        stats.fileEnumerationMs += enumerated - metadataRead;
        taskSamples.push(enumerated - taskStart);
        if (wanted(date)) {
          matched.push(route.id);
          files = files.filter(file => file.typeKey === "rlog");
          assert(files.length === 20, `Wrong file count for route ${route.id}`);
          for (const file of files) {
            const parts = new URL(file.url).pathname.split("/").filter(Boolean);
            const [device, name, segment, basename] = parts.slice(-4);
            assert(device === "syntheticdevice" && name === route.name && basename === "rlog.zst", "Wrong selected path");
            tokens.push(`${route.id}/${segment}`);
          }
        }
        inFlight--;
      }
    }));
  } finally {
    clearInterval(heartbeat);
  }
  const wallMs = performance.now() - begin;
  const expected = routes.filter(route => wanted(route.recordedDate)).map(route => route.id).sort((a, b) => a - b);
  assert(JSON.stringify(matched.sort((a, b) => a - b)) === JSON.stringify(expected), "Wrong route selection");
  assert(new Set(tokens).size === tokens.length, "Duplicate selected segment");
  assert(stats.peakInFlight <= strategy.workers, "Pool exceeded requested concurrency");
  assert(stats.detailRequests === routes.filter(route => !cache.has(route.id) || wanted(cache.get(route.id))).length, "Wrong request count");
  return {
    strategy: strategy.name, routes: routes.length, repetition, workers: strategy.workers,
    cacheEntries: cache.size, matchedRoutes: matched.length, selectedRlogs: tokens.length,
    ...stats, wallMs: round(wallMs), domParseMs: round(stats.domParseMs), metadataMs: round(stats.metadataMs),
    fileEnumerationMs: round(stats.fileEnumerationMs),
    totalMeasuredParseCpuMs: round(stats.domParseMs + stats.metadataMs + stats.fileEnumerationMs),
    parseTaskP95Ms: percentile(taskSamples, .95), parseTaskMaxMs: round(Math.max(...taskSamples)),
    heartbeatLagP95Ms: percentile(lagSamples, .95), heartbeatLagMaxMs: round(Math.max(0, ...lagSamples)),
    heartbeatSamples: lagSamples.length, selectionSha256: await digestTokens(tokens), correct: true
  };
}

document.getElementById("run").addEventListener("click", async () => {
  const status = document.getElementById("status"), results = document.getElementById("results");
  document.getElementById("run").disabled = true;
  const rows = [];
  try {
    // Warm JIT/parser before measurement; exclude this from the reported rows.
    const warmup = fixtures(20);
    for (const route of warmup) {
      const doc = new DOMParser().parseFromString(route.html, "text/html");
      recordingDate(doc);
      P.collectLogFiles(doc, TYPE_KEYS, BASE);
    }
    for (const count of [300, 1000]) {
      const routes = fixtures(count);
      for (let repetition = 1; repetition <= 2; repetition++) {
        // Reverse the second pass to expose gross warmup/order effects.
        const strategies = repetition === 1 ? STRATEGIES : [...STRATEGIES].reverse();
        for (const strategy of strategies) {
          status.textContent = `Running ${count} routes: ${strategy.name} (${repetition}/2)`;
          await delay(100);
          const row = await runStrategy(routes, strategy, repetition);
          rows.push(row);
          const summary = document.createElement("div");
          summary.className = "row";
          const heading = document.createElement("strong");
          heading.textContent = `${count} routes · ${strategy.name} · pass ${repetition}`;
          summary.append(heading, `${(row.wallMs / 1000).toFixed(2)} s · ${row.detailRequests} reads · ${row.matchedRoutes} matches · CPU ${(row.totalMeasuredParseCpuMs / 1000).toFixed(2)} s`);
          results.prepend(summary);
        }
      }
    }
    const report = {
      status: "passed", kind: "firefox-browser-synthetic-recording-discovery", createdAt: new Date().toISOString(),
      environment: {userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        viewport: {width: innerWidth, height: innerHeight}, nativeDOMParser: true},
      assumptions: {
        responseDelayMs: RESPONSE_DELAY_MS, routeCounts: [300, 1000], repetitions: 2,
        fixtureFileLinksPerRoute: 120, selectedRlogsPerMatchedRoute: 20, fromDate: FROM, throughDate: THROUGH,
        network: "No network traffic. In-memory full response strings become available after an artificial delay. No bandwidth sharing, rate limits or streaming model.",
        discoveryScope: "Route-detail discovery only; route listing/pagination excluded equally from every strategy.",
        parser: "Native DOMParser plus current production collectLogFiles. Recording start-time extraction is benchmark-only.",
        eagerBaseline: "Every strategy requests rlog only. Eager inspects file links on every route. Current production snapshot materializes all six types before filtering; this benchmark intentionally gives its eager baseline the cheaper same-type extraction to isolate metadata-first gains.",
        cache: "Invented mostly warm cache of recording dates only. Missing, live, unknown and expired records refetch; selected routes always refetch for current file links.",
        timing: "Wall time and main-thread parse/enumeration intervals measured in this browser. GC/scheduling vary. Heartbeat delay is a responsiveness proxy, not Android frame timing. Both passes run in reversed strategy order."
      }, rows
    };
    const save = document.getElementById("save");
    save.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: "application/json"}));
    save.hidden = false;
    status.textContent = `DISCOVERY PASS ${rows.length} RUNS`;
  } catch (error) {
    status.textContent = `DISCOVERY FAIL ${error.message}`;
  }
});
