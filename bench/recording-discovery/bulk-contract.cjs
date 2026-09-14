#!/usr/bin/env node
'use strict';

// Offline adversarial models, not claims about comma's undocumented backend.
// No requests, credentials, private captures or production extension imports.
const assert = require('node:assert/strict');
const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 14, 12);
const FROM = Date.UTC(2026, 8, 8);
const TO = Date.UTC(2026, 8, 15); // Exclusive end; UTC only for these invented fixtures.
const DEVICE = 'synthetic-device';
const checks = [];
function check(name, fn) { checks.push({ name, ...fn() }); }
function route(i) {
  const start = NOW - (i % 32) * DAY;
  return {
    fullname: `${DEVICE}|synthetic-route-${String(i).padStart(4, '0')}`,
    start_time_utc_millis: start,
    end_time_utc_millis: start + 120000,
    segment_numbers: [0, 1],
    segment_start_times: [start, start + 60000],
    segment_end_times: [start + 60000, start + 120000],
    create_time: 1000000 - i, // Deliberately unrelated to recording chronology.
  };
}
const catalog = Array.from({ length: 1000 }, (_, i) => route(i));
const byId = new Map(catalog.map(r => [r.fullname, r]));
const matches = r => r.start_time_utc_millis >= FROM && r.start_time_utc_millis < TO;
const expected = catalog.filter(matches).map(r => r.fullname).sort();

function prefixWalk(rows, increment, cap = Infinity) {
  let limit = 5, requests = 0, transferredRows = 0, found = [];
  for (let step = 0; step < 1000; step++) {
    found = rows.slice(0, Math.min(limit, cap));
    requests++;
    transferredRows += found.length;
    if (found.length < limit) return { requests, transferredRows, found: found.length };
    limit = increment === 'double' ? limit * 2 : limit + increment;
  }
  throw new Error('Model guard exceeded');
}

// Deliberately conservative research validator. This is not a settled production
// time contract. Require explicit route and segment-0 agreement, valid real-date
// epochs, monotonic boundaries, aligned arrays and complete numbering evidence.
function usableDate(row) {
  const start = row.start_time_utc_millis;
  const end = row.end_time_utc_millis;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < Date.UTC(2015, 0, 1) || end > NOW + DAY || end < start) return null;
  const numbers = row.segment_numbers;
  const starts = row.segment_start_times;
  const ends = row.segment_end_times;
  if (!Array.isArray(numbers) || !Array.isArray(starts) || !Array.isArray(ends)
    || !numbers.length || numbers.length !== starts.length || starts.length !== ends.length
    || new Set(numbers).size !== numbers.length || numbers[0] !== 0
    || starts[0] !== start || ends.at(-1) !== end) return null;
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i || !Number.isSafeInteger(starts[i]) || !Number.isSafeInteger(ends[i])
      || starts[i] < start || ends[i] < starts[i] || ends[i] > end
      || (i && starts[i] < starts[i - 1])) return null;
  }
  return start;
}

function joinedScan(apiRows) {
  const accepted = new Map(), conflicting = new Set();
  for (const row of apiRows) {
    if (!byId.has(row.fullname)) continue; // Catalog controls membership/device.
    const date = usableDate(row);
    if (date === null || (accepted.has(row.fullname) && accepted.get(row.fullname) !== date)) {
      conflicting.add(row.fullname);
      accepted.delete(row.fullname);
    } else if (!conflicting.has(row.fullname)) accepted.set(row.fullname, date);
  }
  const selected = [], fallbackIds = [];
  let knownNonmatches = 0, selectedPageReads = 0;
  for (const actual of catalog) {
    const date = accepted.get(actual.fullname);
    if (date === undefined) fallbackIds.push(actual.fullname);
    else if (date < FROM || date >= TO) { knownNonmatches++; continue; }
    else selectedPageReads++;
    // A selected known date still needs a fresh file-page read. Missing/ambiguous
    // rows use that same read for metadata + files, once. Authoritative fixture
    // metadata is the offline replacement for the useradmin detail response.
    if (matches(actual)) selected.push(actual.fullname);
  }
  selected.sort();
  assert.deepEqual(selected, expected);
  return {
    selectedRoutes: selected.length,
    usableApiDates: accepted.size,
    excludedWithoutDetailRead: knownNonmatches,
    missingOrAmbiguousFallbackReads: fallbackIds.length,
    selectedFreshFilePageReads: selectedPageReads,
    totalDetailPageReads: fallbackIds.length + selectedPageReads,
  };
}

check('Same-window prefix growth: cumulative +5 versus doubling', () => {
  const plusFive = prefixWalk(catalog, 5), doubling = prefixWalk(catalog, 'double');
  assert.deepEqual(plusFive, { requests: 201, transferredRows: 101500, found: 1000 });
  assert.deepEqual(doubling, { requests: 9, transferredRows: 2275, found: 1000 });
  return { plusFive, doubling, assumption: 'Server honors limit and returns a complete stable prefix.' };
});

check('A silent cap makes length < requested limit a false completeness signal', () => {
  const result = prefixWalk(catalog, 5, 250);
  assert.equal(result.found, 250);
  assert.equal(result.requests, 51);
  return { ...result, missed: catalog.length - result.found, hypotheticalServerCap: 250 };
});

check('Timestamp-only cursor can skip records sharing the boundary timestamp', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, time: NOW }));
  const firstPage = rows.slice(0, 50);
  const nextExclusiveEnd = Math.min(...firstPage.map(r => r.time));
  const secondPage = rows.filter(r => r.time < nextExclusiveEnd).slice(0, 50);
  assert.equal(firstPage.length + secondPage.length, 50);
  return { expected: 100, returned: 50, missed: 50, assumption: 'A hypothetical newest-first strict timestamp cursor, not a documented comma API feature.' };
});

check('Partitioning a containment query loses a route crossing the split', () => {
  const split = Date.UTC(2026, 8, 10);
  const drive = { start: split - 30000, end: split + 90000 };
  const windows = [[split - DAY, split], [split, split + DAY]];
  const contains = windows.filter(([start, end]) => drive.start >= start && drive.end <= end);
  assert.equal(contains.length, 0);
  return { expected: 1, returned: contains.length, assumption: 'One plausible start/end containment contract; backend predicates remain unverified.' };
});

check('Missing segment zero, epoch clocks and corrected-clock conflicts need fallback', () => {
  const normal = route(0);
  const missingZero = { ...normal, segment_numbers: [1], segment_start_times: [normal.segment_start_times[1]], segment_end_times: [normal.segment_end_times[1]] };
  const correctedClock = { ...normal, segment_start_times: [normal.start_time_utc_millis - 2 * DAY, normal.segment_start_times[1]] };
  const epochClock = { ...normal, start_time_utc_millis: 0, end_time_utc_millis: 120000, segment_start_times: [0, 60000], segment_end_times: [60000, 120000] };
  assert.notEqual(usableDate(normal), null);
  for (const row of [missingZero, correctedClock, epochClock]) assert.equal(usableDate(row), null);
  return { ambiguousCases: 3, allRequireFallback: true, policy: 'Research prototype conservatively defers all conflicts, rather than reproducing Connect clock repair as authoritative truth.' };
});

check('Complete broad metadata eliminates only known nonmatching detail reads', () => joinedScan(catalog));
check('A date-matching-only API result cannot safely skip absent catalog IDs', () => {
  const result = joinedScan(catalog.filter(matches));
  assert.equal(result.totalDetailPageReads, 1000);
  assert.equal(result.excludedWithoutDetailRead, 0);
  return result;
});
check('Capped and ambiguous bulk data remains correct with catalog fallback', () => {
  const partial = catalog.slice(0, 250).map((r, i) => i % 10 ? r : { ...r, segment_numbers: [1, 2] });
  const result = joinedScan(partial);
  assert.equal(result.usableApiDates, 225);
  assert.equal(result.missingOrAmbiguousFallbackReads, 775);
  return { hypotheticalServerCap: 250, ...result };
});
check('Conflicting duplicates and foreign IDs cannot silently select or exclude a route', () => {
  const conflicting = structuredClone(route(0));
  const delta = -20 * DAY;
  conflicting.start_time_utc_millis += delta;
  conflicting.end_time_utc_millis += delta;
  conflicting.segment_start_times = conflicting.segment_start_times.map(t => t + delta);
  conflicting.segment_end_times = conflicting.segment_end_times.map(t => t + delta);
  const result = joinedScan([...catalog, conflicting, { ...route(2), fullname: 'foreign-device|synthetic-route' }]);
  assert.equal(result.missingOrAmbiguousFallbackReads, 1);
  return result;
});

process.stdout.write(JSON.stringify({
  kind: 'Offline API contract adversarial simulations',
  networkRequests: 0,
  actualBackendContractVerified: false,
  privateDataUsed: false,
  fixtureRoutes: catalog.length,
  assertionsPassed: checks.length,
  checks,
}, null, 2) + '\n');
