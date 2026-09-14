"use strict";

// Invented route data only. The page-reader mock applies the same recording
// predicate as the bridge, so exclusions cannot accidentally use listing dates.
const test = require("node:test");
const assert = require("node:assert/strict");
const Scanner = require("../firefox/scanner.js");
const Parser = require("../firefox/parser.js");
const BASE = `${Parser.PAGE_ORIGIN}/?onebox=synthetic-device`;
const FILTER = Parser.dateFilter({ mode: "custom", from: "2026-09-01", to: "2026-09-07" });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function route(index, uploadDate = "2026-09-03") {
  const id = `${index.toString(16).padStart(8, "0")}--abc`;
  const key = `synthetic-device|${id}`;
  return { key, name: key.replace("|", "/"), url: `${Parser.PAGE_ORIGIN}/?onebox=${encodeURIComponent(key)}`, uploadDate };
}

function file(item, segment = 0, typeKey = "rlog") {
  const id = item.key.split("|")[1];
  const name = `${id}--${segment}--${typeKey}.zst`;
  const routeFolderName = `synthetic-device__${id}`;
  return {
    url: `${Parser.DOWNLOAD_ORIGIN}/synthetic-device/${id}/${segment}/${typeKey}.zst?sig=INVENTED`,
    name, typeKey, typeFolderName: typeKey, routeFolderName,
    targetPath: `${routeFolderName}/${typeKey}/${name}`
  };
}

function listing(items, url = BASE, nextPageUrl = "") {
  return { url, pageKind: "device", routes: items, files: [], nextPageUrl, deviceUrl: BASE };
}

function detail(item, recordingDate = "2026-09-03", files = [file(item)]) {
  return { url: item.url, pageKind: "route", routes: [], files, recordingDate, nextPageUrl: "", deviceUrl: BASE };
}

function reader(pages, options = {}) {
  const calls = [];
  const active = new Map();
  let peak = 0;
  let listings = 0;
  let peakListings = 0;
  let listingAndRouteOverlap = false;
  let cancelCalls = 0;
  const events = [];
  return {
    calls, events,
    get peak() { return peak; },
    get active() { return active.size; },
    get peakListings() { return peakListings; },
    get listingAndRouteOverlap() { return listingAndRouteOverlap; },
    get cancelCalls() { return cancelCalls; },
    async readPage(request) {
      assert.ok(request.url, "every scan read must fetch an explicit URL");
      calls.push(request);
      events.push({ kind: "start", url: request.url });
      const page = pages.get(request.url);
      assert.ok(page, "request must be in the invented catalog");
      const gate = deferred();
      const isListing = page.pageKind === "device";
      active.set(gate, { isListing });
      if (isListing) listings += 1;
      peak = Math.max(peak, active.size);
      peakListings = Math.max(peakListings, listings);
      if (listings && active.size > listings) listingAndRouteOverlap = true;
      let timer;
      try {
        if (options.hold?.(request, page)) options.started?.(request, page, gate);
        else timer = setTimeout(() => {
          if (options.fail?.(request, page)) gate.reject(options.failure);
          else gate.resolve();
        }, options.delay?.(request, page) ?? 1);
        await gate.promise;
        const result = structuredClone(page);
        if (request.recordingFilter && result.pageKind === "route") {
          result.recordingMatch = Parser.recordingMatches(result.recordingDate, request.recordingFilter);
          if (!result.recordingMatch) result.files = [];
        }
        return result;
      } finally {
        clearTimeout(timer);
        active.delete(gate);
        if (isListing) listings -= 1;
        events.push({ kind: "end", url: request.url });
      }
    },
    async cancelReads() {
      cancelCalls += 1;
      for (const gate of active.keys()) {
        const error = new Error("Reader cancelled");
        error.name = "AbortError";
        gate.reject(error);
      }
    }
  };
}

function scan(pages, extra = {}, readerOptions = {}) {
  const reads = reader(pages, readerOptions);
  const result = Scanner.scan({ sourceUrl: BASE, scope: "listed", selectedTypes: ["rlog"],
    dateBasis: "recording", filter: FILTER, readPage: reads.readPage,
    cancelReads: reads.cancelReads, ...extra });
  return { result, reads };
}

test("1,000 fresh route reads pipeline with listing pages inside four shared slots", async () => {
  const items = Array.from({ length: 1000 }, (_, index) => route(index, index % 2 ? "2026-09-14" : "2020-01-01"));
  const pages = new Map();
  const expected = [];
  for (let index = 0; index < items.length; index += 50) {
    const page = index / 50;
    const url = page ? `${BASE}&page=${page}` : BASE;
    pages.set(url, listing(items.slice(index, index + 50), url, index + 50 < items.length ? `${BASE}&page=${page + 1}` : ""));
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const files = [file(item, 10), file(item, 2), file(item, 2), file(item, 0, "qlog")];
    const matches = index % 9 === 0;
    pages.set(item.url, detail(item, matches ? "2026-09-04" : "2026-08-04", files));
    if (matches) expected.push(file(item, 2).targetPath, file(item, 10).targetPath);
  }
  const { result, reads } = scan(pages);
  const found = await result;
  assert.equal(reads.calls.length, 1020);
  assert.equal(reads.peak, 4);
  assert.equal(reads.peakListings, 1);
  assert.equal(reads.listingAndRouteOverlap, true);
  const firstDetailStart = reads.events.findIndex(event => event.kind === "start" && event.url === items[0].url);
  const finalListingEnd = reads.events.findIndex(event => event.kind === "end" && event.url === `${BASE}&page=19`);
  assert.ok(firstDetailStart < finalListingEnd);
  assert.equal(found.pagesRead, 1020);
  assert.equal(found.routesRead, 1000);
  assert.equal(found.routeCount, 1000);
  assert.equal(found.matchedRoutes, 112);
  assert.equal(found.filteredRoutes, 888);
  assert.equal(found.undatedRoutes, 0);
  assert.deepEqual(found.files.map(item => item.targetPath), expected.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  assert.ok(reads.calls.every(call => call.recordingFilter === FILTER));
  assert.ok(found.files.every(item => item.recordingDate === "2026-09-04"));
  assert.equal(reads.active, 0);
});

test("upload and recording selections stay distinct, including late uploads", async () => {
  const lateUpload = route(1, "2026-09-14");
  const oldRecording = route(2, "2026-09-03");
  const unknownRecording = route(3, "2026-09-03");
  const pages = new Map([
    [BASE, listing([lateUpload, oldRecording, unknownRecording])],
    [lateUpload.url, detail(lateUpload, "2026-09-02")],
    [oldRecording.url, detail(oldRecording, "2024-01-01")],
    [unknownRecording.url, detail(unknownRecording, null)]
  ]);
  const recording = scan(pages);
  const recorded = await recording.result;
  assert.deepEqual(recorded.files.map(item => item.targetPath), [file(lateUpload).targetPath]);
  assert.equal(recorded.files[0].uploadDate, "2026-09-14");
  assert.equal(recorded.files[0].recordingDate, "2026-09-02");
  assert.equal(recorded.routesRead, 3);
  assert.equal(recorded.filteredRoutes, 2);
  assert.equal(recorded.undatedRoutes, 1);
  const upload = scan(pages, { dateBasis: "upload" });
  const uploaded = await upload.result;
  assert.deepEqual(uploaded.files.map(item => item.targetPath), [file(oldRecording).targetPath, file(unknownRecording).targetPath]);
  assert.equal(uploaded.routesRead, 2);
  assert.equal(upload.reads.calls.some(call => call.url === lateUpload.url), false);
  assert.ok(upload.reads.calls.every(call => !call.recordingFilter));
});

test("All includes unknown dates while a recording range excludes and counts them", async () => {
  const items = [route(1), route(2), route(3)];
  const pages = new Map([[BASE, listing(items)],
    [items[0].url, detail(items[0], null)],
    [items[1].url, detail(items[1], "2026-02-30")],
    [items[2].url, detail(items[2], "2026-09-03")]]);
  const all = await scan(pages, { filter: { mode: "all" } }).result;
  assert.equal(all.files.length, 3);
  assert.equal(all.undatedRoutes, 2);
  assert.equal(all.filteredRoutes, 0);
  const dated = await scan(pages).result;
  assert.equal(dated.files.length, 1);
  assert.equal(dated.filteredRoutes, 2);
  assert.equal(dated.undatedRoutes, 2);
});

test("a second scan fetches both dates and signed file addresses again", async () => {
  const item = route(1);
  const pages = new Map([[BASE, listing([item])], [item.url, detail(item, "2025-01-01")]]);
  const reads = reader(pages);
  const options = { sourceUrl: BASE, dateBasis: "recording", filter: FILTER,
    readPage: reads.readPage, cancelReads: reads.cancelReads };
  assert.equal((await Scanner.scan(options)).files.length, 0);
  const updated = file(item);
  updated.url += "_SECOND_FRESH_RESPONSE";
  pages.set(item.url, detail(item, "2026-09-03", [updated]));
  const second = await Scanner.scan(options);
  assert.equal(second.files.length, 1);
  assert.equal(second.files[0].url, updated.url);
  assert.deepEqual(reads.calls.map(call => call.url), [BASE, item.url, BASE, item.url]);
});

test("current-route scope fetches fresh files and ignores the date filter", async () => {
  const item = route(1);
  const pages = new Map([[item.url, detail(item, "2020-01-01")]]);
  const { result, reads } = scan(pages, { sourceUrl: item.url, scope: "current" });
  const found = await result;
  assert.equal(found.files.length, 1);
  assert.equal(found.pagesRead, 1);
  assert.equal(found.routesRead, 1);
  assert.equal(found.matchedRoutes, 1);
  assert.equal(reads.calls[0].recordingFilter, undefined);
});

test("a route source discovers its device and includes other matching routes", async () => {
  const one = route(1), two = route(2);
  const pages = new Map([[BASE, listing([one, two])], [one.url, detail(one)], [two.url, detail(two)]]);
  const { result, reads } = scan(pages, { sourceUrl: one.url });
  assert.equal((await result).files.length, 2);
  assert.deepEqual(reads.calls.slice(0, 2).map(call => call.url), [one.url, BASE]);
});

test("repeated routes on a page do not stop pagination or cause duplicate reads", async () => {
  const one = route(1), two = route(2), three = route(3);
  const page1 = `${BASE}&page=1`, page2 = `${BASE}&page=2`;
  const pages = new Map([
    [BASE, listing([one, two], BASE, page1)],
    [page1, listing([one, two], page1, page2)],
    [page2, listing([three], page2)],
    ...[one, two, three].map(item => [item.url, detail(item)])
  ]);
  const { result, reads } = scan(pages);
  const found = await result;
  assert.equal(found.files.length, 3);
  assert.equal(found.routeCount, 3);
  assert.equal(found.routesRead, 3);
  assert.equal(reads.calls.length, 6);
});

test("a listing URL loop rejects the whole scan", async () => {
  const item = route(1), page1 = `${BASE}&page=1`;
  const pages = new Map([[BASE, listing([item], BASE, page1)],
    [page1, listing([item], page1, `${BASE}#same-page`)], [item.url, detail(item)]]);
  const { result, reads } = scan(pages);
  await assert.rejects(result, /repeat a page.*No partial ZIP/);
  assert.equal(reads.cancelCalls, 1);
  assert.equal(reads.active, 0);
});

test("cancellation stops queued work and settles every in-flight reader", async () => {
  const items = Array.from({ length: 25 }, (_, index) => route(index));
  const pages = new Map([[BASE, listing(items)], ...items.map(item => [item.url, detail(item)])]);
  const fourStarted = deferred();
  let held = 0;
  const controller = new AbortController();
  const { result, reads } = scan(pages, { signal: controller.signal }, {
    hold: (request, page) => page.pageKind === "route",
    started() { if (++held === 4) fourStarted.resolve(); }
  });
  await fourStarted.promise;
  controller.abort();
  await assert.rejects(result, error => error.name === "AbortError" && error.message === "Scan cancelled.");
  assert.equal(reads.calls.length, 5);
  assert.equal(reads.active, 0);
  assert.equal(reads.cancelCalls, 1);
  assert.equal(reads.peak, 4);
});

test("a 503 preserves its original error, cancels siblings, and returns no partial result", async () => {
  const items = Array.from({ length: 25 }, (_, index) => route(index));
  const pages = new Map([[BASE, listing(items)], ...items.map(item => [item.url, detail(item)])]);
  const expected = new Error("Page read failed (HTTP 503).");
  const { result, reads } = scan(pages, {}, {
    hold: (request, page) => page.pageKind === "route" && request.url !== items[0].url,
    fail: request => request.url === items[0].url,
    failure: expected
  });
  await assert.rejects(result, error => error === expected);
  assert.equal(reads.calls.length, 5);
  assert.equal(reads.active, 0);
  assert.equal(reads.cancelCalls, 1);
});

test("cancellation before scanning dispatches no requests", async () => {
  const controller = new AbortController();
  controller.abort();
  const { result, reads } = scan(new Map(), { signal: controller.signal });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(reads.calls.length, 0);
});

test("a listing failure cancels simultaneous detail reads and never publishes their files", async () => {
  const items = Array.from({ length: 10 }, (_, index) => route(index));
  const page1 = `${BASE}&page=1`;
  const pages = new Map([[BASE, listing(items, BASE, page1)], [page1, listing([], page1)],
    ...items.map(item => [item.url, detail(item)])]);
  const expected = new Error("Page read failed (HTTP 503).");
  const { result, reads } = scan(pages, {}, {
    hold: (request, page) => page.pageKind === "route",
    fail: request => request.url === page1,
    failure: expected
  });
  await assert.rejects(result, error => error === expected);
  assert.equal(reads.calls.length, 5);
  assert.equal(reads.listingAndRouteOverlap, true);
  assert.equal(reads.active, 0);
  assert.equal(reads.cancelCalls, 1);
});

test("listing, route, and file limits fail explicitly without offering partial files", async t => {
  const one = route(1), two = route(2);
  const page1 = `${BASE}&page=1`;
  await t.test("listing page cap", async () => {
    const pages = new Map([[BASE, listing([one], BASE, page1)],
      [page1, listing([two], page1)], [one.url, detail(one)], [two.url, detail(two)]]);
    const { result, reads } = scan(pages, { limits: { listingPages: 1 } });
    await assert.rejects(result, /1-listing-page limit.*No partial ZIP.*single route/);
    assert.equal(reads.calls.length, 1);
    assert.equal(reads.active, 0);
  });
  await t.test("route cap", async () => {
    const { result, reads } = scan(new Map([[BASE, listing([one, two])]]), { limits: { routes: 1 } });
    await assert.rejects(result, /1-route limit.*No partial ZIP.*single route/);
    assert.equal(reads.active, 0);
  });
  await t.test("file cap", async () => {
    const pages = new Map([[BASE, listing([one])], [one.url, detail(one, "2026-09-03", [file(one, 0), file(one, 1)])]]);
    const { result, reads } = scan(pages, { limits: { files: 1 } });
    await assert.rejects(result, /1-file limit.*No partial ZIP/);
    assert.equal(reads.active, 0);
  });
});

test("an unverified download URL fails the entire scan", async () => {
  const item = route(1), bad = file(item);
  bad.url = "https://untrusted.example/private-file";
  const { result, reads } = scan(new Map([[BASE, listing([item])], [item.url, detail(item, "2026-09-03", [bad])]]));
  await assert.rejects(result, /file address could not be verified/);
  assert.equal(reads.active, 0);
  assert.equal(reads.cancelCalls, 1);
});
