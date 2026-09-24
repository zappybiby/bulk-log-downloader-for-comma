"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { JSDOM } = require("jsdom");
const Parser = require("../firefox/parser.js");
const Scanner = require("../firefox/scanner.js");
const sourceUrl = `${Parser.PAGE_ORIGIN}/?onebox=0123456789abcdef`;
const name = index => `0123456789abcdef/${String(index).padStart(8, "0")}--abcdef01`;
const url = index => `${Parser.PAGE_ORIGIN}/?onebox=${encodeURIComponent(name(index))}`;
const doc = html => new JSDOM(html).window.document;
const filter = Parser.dateFilter({ mode: "custom", from: "2026-09-18", to: "2026-09-24" });
const link = index => `<a href="?onebox=${encodeURIComponent(name(index))}">${name(index)}</a>`;
const listing = (routes, next = "") => `<details><summary>routes (${routes.length + (next ? 1 : 0)})</summary>
  <table id="table_routes"><tr><th>upload_time</th><th>route_name</th></tr>
  ${routes.map(route => `<tr><td>${route.upload || "None"}</td><td>${link(route.index)}</td></tr>`).join("")}</table></details>${next}`;
const routePage = route => `<table id="table_route5_route">
  <tr><td>end_time</td><td>2026-09-24T23:59:59</td></tr>
  <tr><td>start_time</td><td>${route.recording || "None"}</td></tr></table>
  <a href="${Parser.DOWNLOAD_ORIGIN}/logs/${name(route.index)}/0/rlog.zst">rlog.zst</a>`;

async function scan(routes, basis, range = filter, options = {}) {
  const reads = [];
  const pages = new Map([[sourceUrl, listing(routes)], ...routes.map(route => [url(route.index), routePage(route)])]);
  const result = await Scanner.scan({
    sourceUrl, scope: "listed", dateBasis: basis, filter: range, selectedTypes: ["rlog"], ...options,
    readPage: async request => {
      reads.push(request.url);
      return Parser.snapshot(doc(pages.get(request.url)), request.url, request.selectedTypes,
        { recordingFilter: request.recordingFilter });
    }
  });
  return { result, reads };
}

test("recorded and uploaded filters use different source dates and inclusive bounds", async () => {
  const routes = [
    { index: 1, upload: "2026-09-25 00:00:00", recording: "2026-09-18T00:00:00" },
    { index: 2, upload: "2026-09-18 00:00:00", recording: "2026-09-17T23:59:59" },
    { index: 3, upload: "2026-09-24 23:59:59", recording: "2026-09-25T00:00:00" },
    { index: 4, upload: "2026-09-17 23:59:59", recording: "2026-09-24T23:59:59.999999" }
  ];
  const recorded = await scan(routes, "recording");
  const uploaded = await scan(routes, "upload");
  assert.deepEqual(recorded.result.files.map(file => file.recordingDate), ["2026-09-18", "2026-09-24"]);
  assert.deepEqual(uploaded.result.files.map(file => file.uploadDate), ["2026-09-18", "2026-09-24"]);
  assert.equal(recorded.reads.length, 5, "recorded mode cannot prefilter by upload date");
  assert.equal(uploaded.reads.length, 3, "uploaded mode only fetches matching details");
});

for (const basis of ["recording", "upload"]) {
  test(`${basis}: date ranges skip unknown dates; All includes them without reporting skips`, async () => {
    const routes = [{ index: 1, upload: null, recording: null }];
    const limited = await scan(routes, basis);
    assert.equal(limited.result.files.length, 0);
    assert.equal(limited.result.filteredRoutes, 1);
    assert.equal(limited.result.undatedRoutes, 1);
    const all = await scan(routes, basis, { mode: "all" });
    assert.equal(all.result.files.length, 1);
    assert.equal(all.result.filteredRoutes, 0);
    assert.equal(all.result.undatedRoutes, 0, "this counter drives the skipped-route notice");
  });

  test(`${basis}: This route ignores hidden date settings and never reports skipped dates`, async () => {
    const { result, reads } = await scan([{ index: 1 }], basis, filter, { sourceUrl: url(1), scope: "current" });
    assert.equal(result.files.length, 1);
    assert.equal(result.filteredRoutes, 0);
    assert.equal(result.undatedRoutes, 0);
    assert.deepEqual(reads, [url(1)]);
  });
}

test("recorded mode finds matching dates on later pages despite older upload dates", async () => {
  const routes = [
    { index: 1, upload: "2026-09-01", recording: "2026-09-01T00:00:00" },
    { index: 2, upload: "2026-09-02", recording: "2026-09-23T00:00:00" }
  ];
  const page2 = `${sourceUrl}&page=1`;
  const pages = new Map([
    [sourceUrl, listing([routes[0]], '<a onclick="loadMoreRoutes(0)">Load more</a>')],
    [page2, listing([routes[1]])],
    ...routes.map(route => [url(route.index), routePage(route)])
  ]);
  const result = await Scanner.scan({ sourceUrl, dateBasis: "recording", filter,
    readPage: async request => Parser.snapshot(doc(pages.get(request.url)), request.url, ["rlog"],
      { recordingFilter: request.recordingFilter }) });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].recordingDate, "2026-09-23");
  assert.equal(result.routesRead, 2);
});

test("recording date comes only from one unambiguous start_time, not end/upload/route ID", () => {
  assert.equal(Parser.collectRecordingDate(doc(routePage({ index: 1, recording: "2026-09-23T23:59:59" }))), "2026-09-23");
  for (const fields of [
    '<tr><td>end_time</td><td>2026-09-24T00:00:00</td></tr>',
    '<tr><td>start_time</td><td>None</td></tr>',
    '<tr><td>start_time</td><td>2026-02-30T12:00:00</td></tr>',
    '<tr><td>start_time</td><td>2026-09-23T12:00:00</td></tr>'.repeat(2)
  ]) assert.equal(Parser.collectRecordingDate(doc(`<table id="table_route5_route">${fields}</table>`)), null);
});

test("upload header position is honored without substituting other dates", () => {
  const html = `<table id="table_routes"><tr><th>recorded</th><th>route_name</th><th>Upload time</th></tr>
    <tr><td>2026-09-18</td><td>${link(1)}</td><td>2026-09-24 00:00:00</td></tr></table>`;
  assert.equal(Parser.collectRouteLinks(doc(html), sourceUrl)[0].uploadDate, "2026-09-24");
  assert.equal(Parser.collectRouteLinks(doc(html.replace("Upload time", "other date")), sourceUrl)[0].uploadDate, null);
});

test("date parser rejects invalid dates/times and retains displayed calendar days", () => {
  assert.equal(Parser.parseRouteUploadDate("2024-02-29 23:59:59"), "2024-02-29");
  assert.equal(Parser.parseRouteRecordingDate("2024-02-29T00:00:00.123456"), "2024-02-29");
  for (const day of ["2026-02-29", "2026-04-31", "0000-01-01", "2026-13-01"]) {
    assert.equal(Parser.parseRouteUploadDate(`${day} 12:00:00`), null);
    assert.equal(Parser.parseRouteRecordingDate(`${day}T12:00:00`), null);
  }
  for (const time of ["24:00:00", "12:60:00", "12:00:60"]) {
    assert.equal(Parser.parseRouteUploadDate(`2026-09-24 ${time}`), null);
    assert.equal(Parser.parseRouteRecordingDate(`2026-09-24T${time}`), null);
  }
  assert.throws(() => Parser.dateFilter({ mode: "custom", from: "2026-09-25", to: "2026-09-24" }));
  assert.throws(() => Parser.dateFilter({ mode: "custom", from: "2026-02-29", to: "2026-09-24" }));
  for (const days of ["", 0, -1, 1.5, "abc", 36501]) assert.throws(() => Parser.dateFilter({ mode: "recent", days }));
});

for (const timezone of ["America/New_York", "UTC", "Pacific/Honolulu", "Pacific/Kiritimati"]) {
  test(`calendar ranges stay inclusive across midnight, DST, leap day and year end in ${timezone}`, () => {
    const output = execFileSync(process.execPath, ["-e", `
      const p = require('./firefox/parser.js');
      const dates = [[2026, 8, 24], [2026, 2, 9], [2026, 10, 2], [2024, 2, 1], [2026, 0, 1]];
      console.log(JSON.stringify(dates.map(([y, m, d]) => [1, 7, 30].map(days =>
        p.dateFilter({mode: 'recent', days}, new Date(y, m, d, 0, 1))))));
    `], { cwd: require("node:path").resolve(__dirname, ".."), env: { ...process.env, TZ: timezone }, encoding: "utf8" });
    const ranges = JSON.parse(output);
    assert.deepEqual(ranges.map(items => items[0].toDate), ["2026-09-24", "2026-03-09", "2026-11-02", "2024-03-01", "2026-01-01"]);
    assert.deepEqual(ranges.map(items => items[1].fromDate), ["2026-09-18", "2026-03-03", "2026-10-27", "2024-02-24", "2025-12-26"]);
    for (const items of ranges) for (const [index, days] of [1, 7, 30].entries()) {
      assert.equal((Date.parse(items[index].toDate) - Date.parse(items[index].fromDate)) / 86400000 + 1, days);
    }
  });
}
