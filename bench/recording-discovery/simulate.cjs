#!/usr/bin/env node
"use strict";

/*
 * Recording-date discovery: deterministic, synthetic discrete-event model.
 *
 * Run: node bench/recording-discovery/simulate.cjs
 *      node bench/recording-discovery/simulate.cjs --json
 *
 * No requests are sent. No private captures are read. Times are predictions
 * under explicit assumptions, NOT measurements of comma's service or a phone.
 * A route has 12-59 segments; discovery fetches once per ROUTE, never once per
 * segment/file. Transfers share one bandwidth budget; HTML parsing is serial.
 * Discovery ends with fresh file links for every selected route in memory.
 * File downloading, ZIP creation, TLS startup, HTTP compression, disk/cache I/O,
 * browser connection limits, and live DOM rendering are outside this model.
 *
 * Cache: origin/account/device/route scoped; recording metadata only, NO URLs.
 * Completed dates are assumed immutable while the 24-hour entry is fresh.
 * In-progress metadata expires after five minutes. Unknown dates always retry.
 * A real implementation must clear the cache on logout/account changes, expose
 * Refresh, invalidate on parser/schema changes, and fetch selected route pages
 * again for current signed download URLs. No cache can prove immutable metadata
 * if the upstream service later corrects it; this is an explicit assumption.
 *
 * The rate-limited profile deliberately has four server slots and a two-second
 * Retry-After. That is a hypothetical stress case, NOT a claimed service limit.
 * The bulk-metadata strategy is an auth-dependent best case. Its response shape,
 * size, authorization, and extension integration are unverified assumptions.
 */

const assert = require("node:assert/strict");

const MiB = 1024 * 1024;
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 14, 12);
const FROM_DATE = "2026-09-08";
const THROUGH_DATE = "2026-09-14";
const ACCOUNT_SCOPE = "synthetic-account-a";
const DEVICE_SCOPE = "synthetic-device";
const CACHE_VERSION = 1;
const COMPLETED_TTL_MS = DAY_MS;
const ACTIVE_TTL_MS = 5 * 60_000;
const profiles = [
  { name: "ordinary", rttMs: 180, bandwidthMiBps: 4, serverSlots: Infinity, retryAfterMs: 2000 },
  { name: "bandwidth-limited", rttMs: 220, bandwidthMiBps: 0.75, serverSlots: Infinity, retryAfterMs: 2000 },
  { name: "rate-limited-stress", rttMs: 180, bandwidthMiBps: 4, serverSlots: 4, retryAfterMs: 2000 }
];

function calendarDate(daysAgo) {
  return new Date(NOW - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function inRange(date, from = FROM_DATE, through = THROUGH_DATE) {
  return date !== null && date >= from && date <= through;
}

function metadataKey(accountScope, routeId) {
  return [CACHE_VERSION, "https://synthetic.invalid", accountScope, DEVICE_SCOPE, routeId].join("|");
}

function makeRoutes(count) {
  // Multiplication by 37 gives unsorted recording dates. A quarter of routes
  // upload 15 days late and another subset 35 days late, yielding false upload
  // matches. No row ordering, timestamp-ID decoding, or date monotonicity is
  // available to a strategy.
  return Array.from({ length: count }, (_, index) => {
    const ageDays = (index * 37 + 11) % 60;
    const lagDays = index % 4 === 0 ? 15 : index % 7 === 0 ? 35 : index % 3;
    const segments = 12 + (index * 17) % 48;
    return {
      index,
      id: `invented-route-${String(index).padStart(4, "0")}`,
      recordingDate: index % 79 === 0 ? null : calendarDate(ageDays),
      uploadDate: calendarDate(Math.max(0, ageDays - lagDays)),
      segments,
      // An invented route response with six file links per segment.
      htmlBytes: 18_000 + segments * 1_500,
      parseMs: 2 + segments * 0.12,
      active: index % 137 === 0
    };
  });
}

function makeMetadataCache(routes) {
  const cache = new Map();
  for (const route of routes) {
    // Foreign-account entries may never fill this account's cache misses.
    cache.set(metadataKey("synthetic-account-b", route.id), {
      recordingDate: calendarDate(0), active: false, savedAt: NOW, version: CACHE_VERSION
    });
    if (route.index % 20 === 0) continue; // Exactly 5% never cached.
    cache.set(metadataKey(ACCOUNT_SCOPE, route.id), {
      recordingDate: route.index % 101 === 0 ? null : route.active ? calendarDate(50) : route.recordingDate,
      active: route.active,
      savedAt: NOW - (route.active ? 10 * 60_000 : 12 * 60 * 60_000),
      version: CACHE_VERSION
    });
  }
  for (const value of cache.values()) {
    assert.deepEqual(Object.keys(value).sort(), ["active", "recordingDate", "savedAt", "version"]);
  }
  return cache;
}

function cacheEntryIsFresh(entry) {
  if (!entry || entry.version !== CACHE_VERSION || entry.recordingDate === null) return false;
  return NOW - entry.savedAt < (entry.active ? ACTIVE_TTL_MS : COMPLETED_TTL_MS);
}

function routeJob(route) {
  return { id: route.index + 100, bytes: route.htmlBytes, parseMs: route.parseMs };
}

/** Fluid fair-share transfers, one parser, bounded workers, retry-aware slots. */
function simulateNetwork(jobs, concurrency, profile) {
  if (!jobs.length) return { ms: 0, requests: 0, retries429: 0, bytes: 0, peakRequests: 0 };
  const queued = jobs.slice();
  const workers = [];
  const parseQueue = [];
  const result = { ms: 0, requests: 0, retries429: 0, bytes: 0, peakRequests: 0 };
  let now = 0;
  let completed = 0;
  let activeServerRequests = 0;
  let parsing = null;
  const bytesPerMs = profile.bandwidthMiBps * MiB / 1000;

  function request(worker) {
    worker.attempt += 1;
    result.requests += 1;
    worker.accepted = activeServerRequests < profile.serverSlots;
    if (worker.accepted) activeServerRequests += 1;
    else result.retries429 += 1;
    worker.phase = "latency";
    // Stable bounded jitter; neither randomness nor host timing affects results.
    worker.due = now + profile.rttMs * (0.9 + ((worker.job.id * 7 + worker.attempt * 3) % 11) / 50);
    const inFlight = workers.filter(item => item.phase === "latency" || item.phase === "transfer").length;
    result.peakRequests = Math.max(result.peakRequests, inFlight);
  }

  function fillWorkers() {
    while (workers.length < concurrency && queued.length) {
      const worker = { job: queued.shift(), attempt: 0 };
      workers.push(worker);
      request(worker);
    }
  }

  function beginParsing() {
    if (!parsing && parseQueue.length) {
      parsing = parseQueue.shift();
      parsing.phase = "parse";
      parsing.due = now + parsing.job.parseMs;
    }
  }

  fillWorkers();
  while (completed < jobs.length) {
    const transferring = workers.filter(item => item.phase === "transfer");
    const perTransferRate = transferring.length ? bytesPerMs / transferring.length : 0;
    const nextTransfer = transferring.length
      ? now + Math.min(...transferring.map(item => item.remaining)) / perTransferRate : Infinity;
    const dueWorkers = workers.filter(item => ["latency", "retry", "parse"].includes(item.phase));
    const nextTimed = dueWorkers.length ? Math.min(...dueWorkers.map(item => item.due)) : Infinity;
    const next = Math.min(nextTransfer, nextTimed);
    assert.ok(Number.isFinite(next), "Network model deadlocked.");
    for (const worker of transferring) worker.remaining -= (next - now) * perTransferRate;
    now = next;

    // Process already-transferred bodies before admitting requests at this time.
    for (const worker of transferring.filter(item => item.remaining <= 0.0001)) {
      if (worker.accepted) {
        activeServerRequests -= 1;
        worker.phase = "parse-queued";
        parseQueue.push(worker);
      } else {
        worker.phase = "retry";
        worker.due = now + profile.retryAfterMs + (worker.job.id * 13 + worker.attempt * 71) % 251;
      }
    }
    if (parsing && parsing.due <= now + 0.0001) {
      const finished = parsing;
      parsing = null;
      workers.splice(workers.indexOf(finished), 1);
      completed += 1;
    }
    for (const worker of workers.filter(item => item.phase === "latency" && item.due <= now + 0.0001)) {
      worker.phase = "transfer";
      worker.remaining = worker.accepted ? worker.job.bytes : 256;
      result.bytes += worker.remaining;
    }
    for (const worker of workers.filter(item => item.phase === "retry" && item.due <= now + 0.0001)) request(worker);
    beginParsing();
    fillWorkers();
    assert.ok(result.requests < jobs.length * 100, "Unbounded retry loop in model.");
  }
  result.ms = now;
  return result;
}

function combine(...results) {
  return results.reduce((total, item) => ({
    ms: total.ms + item.ms,
    requests: total.requests + item.requests,
    retries429: total.retries429 + item.retries429,
    bytes: total.bytes + item.bytes,
    peakRequests: Math.max(total.peakRequests, item.peakRequests)
  }), { ms: 0, requests: 0, retries429: 0, bytes: 0, peakRequests: 0 });
}

function ids(routes) { return routes.map(route => route.id).sort(); }

function runScenario(count, profile) {
  const routes = makeRoutes(count);
  const expected = routes.filter(route => inRange(route.recordingDate));
  const expectedIds = ids(expected);
  const cache = makeMetadataCache(routes);
  const unknown = routes.filter(route => route.recordingDate === null).length;
  const listJobs = Array.from({ length: Math.ceil(count / 100) }, (_, page) => ({
    id: page, bytes: 12_000 + Math.min(100, count - page * 100) * 400, parseMs: 4
  }));
  // Device pages are paginated sequentially because each reveals the next link.
  const list = simulateNetwork(listJobs, 1, profile);
  const rows = [];

  function row(strategy, stats, fetched, selected, options = {}) {
    const selectedIds = ids(selected);
    const falsePositive = selectedIds.filter(id => !expectedIds.includes(id)).length;
    const falseNegative = expectedIds.filter(id => !selectedIds.includes(id)).length;
    if (!options.unsafe) {
      assert.deepEqual(selectedIds, expectedIds, `${strategy} must select the correct routes.`);
      assert.ok(selected.every(route => fetched.includes(route)), `${strategy} must obtain fresh selected-route file links.`);
    }
    rows.push({
      profile: profile.name, routes: count, strategy,
      seconds: Number((stats.ms / 1000).toFixed(2)),
      responseMiB: Number((stats.bytes / MiB).toFixed(2)),
      requests: stats.requests, routePages: fetched.length,
      retries429: stats.retries429, peakRequests: stats.peakRequests,
      selectedRoutes: selected.length,
      selectedFiles: selected.reduce((sum, route) => sum + route.segments, 0),
      falsePositive, falseNegative,
      unknownDatesReported: options.unsafe ? null : unknown,
      ...options
    });
  }

  for (const concurrency of [1, 4, 6, 8]) {
    const stats = combine(list, simulateNetwork(routes.map(routeJob), concurrency, profile));
    row(concurrency === 1 ? "cold-sequential" : `cold-pool-${concurrency}`, stats, routes,
      routes.filter(route => inRange(route.recordingDate)));
  }

  for (const concurrency of [4, 6, 8]) {
    const refreshMetadata = routes.filter(route => !cacheEntryIsFresh(cache.get(metadataKey(ACCOUNT_SCOPE, route.id))));
    const freshCacheRoutes = routes.filter(route => cacheEntryIsFresh(cache.get(metadataKey(ACCOUNT_SCOPE, route.id))));
    const selectedFromCache = freshCacheRoutes.filter(route => inRange(cache.get(metadataKey(ACCOUNT_SCOPE, route.id)).recordingDate));
    // Union deduplicates requests: a newly fetched selected route already has
    // fresh file links and must not be fetched again merely to download it.
    const fetched = [...new Set([...refreshMetadata, ...selectedFromCache])];
    const selected = [...selectedFromCache, ...refreshMetadata.filter(route => inRange(route.recordingDate))];
    const stats = combine(list, simulateNetwork(fetched.map(routeJob), concurrency, profile));
    row(`warm95-pool-${concurrency}`, stats, fetched, selected, {
      metadataRefreshRoutes: refreshMetadata.length,
      freshCachedRoutes: freshCacheRoutes.length,
      cachedSelectedRefetched: selectedFromCache.length
    });
  }

  // CONDITIONAL optimization: never impose the recording range's upper bound
  // on upload dates. Only upload >= range start is safe IF recording/upload
  // calendars share a timezone and clocks guarantee upload >= recording.
  // This fixture has that invariant; a separate counterexample below does not.
  assert.ok(routes.every(route => route.recordingDate === null || route.uploadDate >= route.recordingDate));
  const lowerBoundCandidates = routes.filter(route => route.uploadDate >= FROM_DATE);
  const lowerBoundSelected = lowerBoundCandidates.filter(route => inRange(route.recordingDate));
  row("CONDITIONAL-upload-lower-bound", combine(list, simulateNetwork(lowerBoundCandidates.map(routeJob), 4, profile)),
    lowerBoundCandidates, lowerBoundSelected, {
      conditional: "Requires uploadDate >= recordingDate on comparable calendars; clock/timezone counterexample invalidates it otherwise.",
      unknownDatesReported: lowerBoundCandidates.filter(route => route.recordingDate === null).length,
      unknownDatesNotInspected: routes.filter(route => route.recordingDate === null && !lowerBoundCandidates.includes(route)).length
    });

  // Deliberately incorrect: treating a recent upload as a recent recording.
  // Correctness checks must expose this despite its smaller request count.
  const uploadSelected = routes.filter(route => inRange(route.uploadDate));
  row("UNSAFE-upload-date", combine(list, simulateNetwork(uploadSelected.map(routeJob), 4, profile)),
    uploadSelected, uploadSelected, { unsafe: true });
  assert.ok(rows.at(-1).falsePositive > 0, "Late uploads must disprove upload-date substitution.");

  // Auth-dependent best-case API model: one compact date catalog, then selected
  // HTML pages for fresh links. Includes list cost conservatively; this does not
  // establish that the extension can access a compatible endpoint.
  const metadata = simulateNetwork([{ id: 50_000, bytes: 2000 + count * 160, parseMs: 2 + count * 0.008 }], 1, profile);
  row("AUTH-DEPENDENT-bulk-api", combine(list, metadata, simulateNetwork(expected.map(routeJob), 4, profile)),
    expected, expected, { integrationUnverified: true });

  const customFrom = "2026-08-20";
  const customThrough = "2026-08-26";
  const customExpected = routes.filter(route => inRange(route.recordingDate, customFrom, customThrough));
  const customUpload = routes.filter(route => inRange(route.uploadDate, customFrom, customThrough));
  const customFalseNegative = customExpected.filter(route => !customUpload.includes(route)).length;
  assert.ok(customFalseNegative > 0, "An upload-date upper bound must miss late-uploaded recordings in a past custom range.");
  const customLowerBound = routes.filter(route => route.uploadDate >= customFrom);
  assert.deepEqual(ids(customLowerBound.filter(route => inRange(route.recordingDate, customFrom, customThrough))), ids(customExpected));
  const customLateUploads = customExpected.filter(route => route.uploadDate > customThrough).length;
  assert.ok(customLateUploads > 0, "Past-range lower-bound test must retain recordings uploaded after the range end.");

  // One calendar-day mismatch can result from comparing differently zoned
  // dates at midnight; larger discrepancies can come from an incorrect clock.
  // This invented route is recorded inside our range but uploaded on a date
  // lexically before its start, so the lower-bound shortcut loses it.
  const mismatchedClockRoute = { recordingDate: FROM_DATE, uploadDate: calendarDate(7) };
  assert.ok(inRange(mismatchedClockRoute.recordingDate));
  assert.ok(mismatchedClockRoute.uploadDate < FROM_DATE);

  return { rows, dataset: {
    routes: count, segmentFiles: routes.reduce((sum, route) => sum + route.segments, 0),
    expectedSelectedRoutes: expected.length,
    expectedSelectedFiles: expected.reduce((sum, route) => sum + route.segments, 0),
    unknownRecordingDates: unknown,
    lateUploadFalseMatches: uploadSelected.filter(route => !inRange(route.recordingDate)).length,
    recordingDatesAreUnsorted: routes.some((route, index) => index > 0 && route.recordingDate < routes[index - 1].recordingDate),
    pastCustomRangeUploadShortcut: {
      from: customFrom, through: customThrough,
      falsePositive: customUpload.filter(route => !customExpected.includes(route)).length,
      falseNegative: customFalseNegative
    },
    pastCustomRangeConditionalLowerBound: {
      from: customFrom, through: customThrough,
      candidateRoutePages: customLowerBound.length,
      expectedSelectedRoutes: customExpected.length,
      selectedRoutesUploadedAfterRangeEnd: customLateUploads,
      falseNegativeUnderValidClockInvariant: 0
    },
    uploadLowerBoundClockTimezoneCounterexample: {
      ...mismatchedClockRoute,
      expectedIncluded: true,
      lowerBoundWouldInclude: false,
      conclusion: "Do not use as a universal exclusion rule without comparable calendars and trustworthy timestamp ordering."
    }
  } };
}

function validateModel() {
  const profile = { rttMs: 100, bandwidthMiBps: 1, serverSlots: Infinity, retryAfterMs: 1000 };
  const one = simulateNetwork([{ id: 0, bytes: MiB, parseMs: 5 }], 1, profile);
  // The deterministic jitter for this request is 0.96: 96 ms RTT + 1000 ms
  // transfer + 5 ms parse. Two simultaneous 1 MiB bodies share 1 MiB/s.
  assert.equal(one.ms, 1101);
  assert.equal(one.bytes, MiB);
  const two = simulateNetwork([{ id: 0, bytes: MiB, parseMs: 0 }, { id: 1, bytes: MiB, parseMs: 0 }],
    2, { ...profile, rttMs: 0 });
  assert.equal(two.ms, 2000);
  assert.equal(two.bytes, 2 * MiB);
  assert.equal(two.requests, 2);
  assert.equal(cacheEntryIsFresh({ version: CACHE_VERSION, recordingDate: null, savedAt: NOW, active: false }), false);
  assert.equal(cacheEntryIsFresh({ version: CACHE_VERSION, recordingDate: FROM_DATE, savedAt: NOW - ACTIVE_TTL_MS, active: true }), false);
  assert.equal(cacheEntryIsFresh({ version: CACHE_VERSION, recordingDate: FROM_DATE, savedAt: NOW - COMPLETED_TTL_MS, active: false }), false);
}

function main() {
  validateModel();
  const rows = [];
  const datasets = [];
  for (const count of [300, 1000]) {
    for (const [profileIndex, profile] of profiles.entries()) {
      const scenario = runScenario(count, profile);
      rows.push(...scenario.rows);
      if (!profileIndex) datasets.push(scenario.dataset);
    }
  }
  const report = {
    kind: "synthetic-discrete-event-simulation",
    measuredOnPhone: false,
    assumptions: {
      recordingCalendar: "Synthetic UTC date; recording-date timezone choice is outside this model.",
      inclusiveRange: { from: FROM_DATE, through: THROUGH_DATE },
      profiles: profiles.map(profile => ({ ...profile, serverSlots: Number.isFinite(profile.serverSlots) ? profile.serverSlots : null })),
      transfer: "Response bytes, shared fair bandwidth; no compression model.",
      routeHtmlBytes: "18000 + 1500 * segments; segments vary 12..59.",
      parseMs: "2 + 0.12 * segments; a single serial parser, assumed rather than measured.",
      list: "100 routes/page; sequential page discovery; 12000 + 400 * routes bytes/page.",
      cache: {
        initiallyPresentFraction: 0.95,
        key: "version + origin + account + device + route",
        storedFields: ["recordingDate", "active", "savedAt", "version"],
        completedTtlHours: COMPLETED_TTL_MS / 3_600_000,
        activeTtlMinutes: ACTIVE_TTL_MS / 60_000,
        unknownDates: "Always refetch; still-unknown dates are reported, never inferred from uploads.",
        selectedRoutes: "Refetch pages for fresh signed URLs; never persist URL/signature data.",
        completedDateAssumption: "Stable within TTL; upstream corrections require refresh or expiry."
      },
      conditionalUploadPrefilter: "Lower bound only, uploadDate >= recording range start; correctness requires comparable calendars and reliable upload >= recording ordering. Never impose recording range end on uploads.",
      limits: "Excludes file download/ZIP, rendering, cache I/O, and connection setup; rate limits are hypothetical and API access/integration is unverified."
    },
    correctness: "Safe strategies select exact expected route IDs. Conditional lower bound also passes under fixture clock ordering, but its explicit clock/timezone counterexample fails. Unknown dates are reported separately.",
    datasets,
    results: rows
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log("SYNTHETIC MODEL — seconds are predictions, not phone/server measurements.");
    console.log("Last 7 recording days; fresh links for selected routes; one rlog per segment.");
    console.log("profile | routes | strategy | seconds | MiB | requests | 429 | selected | wrong (+/-)");
    for (const item of rows) console.log([
      item.profile, item.routes, item.strategy, item.seconds, item.responseMiB,
      item.requests, item.retries429, item.selectedRoutes, `${item.falsePositive}/${item.falseNegative}`
    ].join(" | "));
    console.log("\nAll safe strategy selection assertions passed. Use --json for complete assumptions and counts.");
  }
}

if (require.main === module) main();
module.exports = { simulateNetwork, runScenario, makeRoutes, makeMetadataCache, cacheEntryIsFresh, profiles };
