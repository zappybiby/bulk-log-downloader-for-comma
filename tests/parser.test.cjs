/* All HTML, identifiers, dates, and download URLs here are invented test data. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseHTML, DOMParser } = require("linkedom");
const P = require("../firefox/parser.js");

const BASE = `${P.PAGE_ORIGIN}/?onebox=demo-device`;
const ROUTE = "demo-device/11111111--aabbcc";
const OTHER_ROUTE = "demo-device/22222222--ddeeff";
const ROUTE_URL = `${P.PAGE_ORIGIN}/?onebox=${encodeURIComponent(ROUTE.replace("/", "|"))}`;
const documentFor = content => parseHTML(`<!doctype html><html><head><title>Demo useradmin</title></head><body>${content}</body></html>`).document;
const row = (name = ROUTE, date = "2026-04-15 12:30:00", extra = "") => `<tr><td>${date}</td><td><a href="/?onebox=${encodeURIComponent(name.replace("/", "|"))}">${name}</a></td>${extra}</tr>`;
const device = (rows = row(), extra = "") => documentFor(`<details><summary>routes (3)</summary><table id="table_routes"><tbody>${rows}</tbody></table>${extra}</details>`);
const blob = (segment = "0", name = "qlog.zst", query = "?sig=INVENTED_TEST_SIGNATURE") => `${P.DOWNLOAD_ORIGIN}/test-container/demo-device/11111111--aabbcc/${segment}/${name}${query}`;
const link = (url = blob(), label = "qlog.zst") => `<a href="${url.replaceAll("&", "&amp;")}">${label}</a>`;
const metadata = (start = "2026-04-15T12:30:00", extra = "") => `<table id="table_route5_route"><tbody><tr><td>create_time</td><td>1999-01-01T00:00:00</td></tr><tr><td>end_time</td><td>2026-04-16T00:10:00</td></tr><tr><td>start_time</td><td>${start}</td></tr>${extra}</tbody></table>`;

test("device route discovery excludes incident links and deduplicates its route table", () => {
  const doc = device(row() + row() + row(OTHER_ROUTE, "2026-04-16"), `<table>${row("incident-device/33333333--aaff")}</table>`);
  const result = P.snapshot(doc, BASE, ["qlog"]);
  assert.equal(result.pageKind, "device");
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0].key, ROUTE.replace("/", "|"));
  assert.equal(result.routes[0].uploadDate, "2026-04-15");
  assert.equal(result.deviceUrl, BASE);
  assert.equal(result.files.length, 0);
});

test("route identity comes from a validated link and matching text", () => {
  const mismatch = row().replace(encodeURIComponent(ROUTE.replace("/", "|")), encodeURIComponent(OTHER_ROUTE.replace("/", "|")));
  const external = row().replace('/?onebox=', 'https://untrusted.example/?onebox=');
  const legacy = "demo-device/2020-01-02--03-04-05";
  assert.deepEqual(P.collectRouteLinks(device(mismatch + external + row(legacy)), BASE).map(route => route.name), [legacy]);
});

test("date selection uses the labelled upload column and ignores other date fields and route IDs", () => {
  const legacy = "demo-device/2020-01-02--03-04-05";
  const headers = "<tr><td>start_time</td><td>route_name</td><td>upload time</td><td>create_time</td><td>git_commit_date</td></tr>";
  const rows = headers + row(legacy, "2020-01-02 03:04:05", "<td>2026-04-15 23:59:59</td><td>1999-01-01</td><td>2021-01-01</td>");
  const routes = P.collectRouteLinks(device(rows), BASE);
  assert.equal(routes[0].uploadDate, "2026-04-15");
  assert.equal(P.routeMatches(routes[0], P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-15" })), true);
});

test("named columns without upload time remain undated; headerless fragments keep first-column support", () => {
  const headers = "<tr><th>start_time</th><th>route_name</th></tr>";
  const route = P.collectRouteLinks(device(headers + row()), BASE)[0];
  assert.equal(route.uploadDate, null);
  assert.equal(P.routeMatches(route, P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-15" })), false);
  assert.equal(P.routeMatches(route, P.dateFilter({ mode: "all" })), true);
  assert.equal(P.collectRouteLinks(device(row()), BASE)[0].uploadDate, "2026-04-15");
  const labelled = "<tr><td>UPLOAD_TIME</td><td>route_name</td></tr>";
  assert.equal(P.collectRouteLinks(device(labelled + row()), BASE)[0].uploadDate, "2026-04-15");
});

test("device URLs derive from the current route or a unique matching device link", () => {
  assert.equal(P.getDeviceUrl(documentFor(""), `${ROUTE_URL}&page=3#details`), BASE);
  assert.equal(P.getDeviceUrl(documentFor(""), `${P.PAGE_ORIGIN}/?onebox=${encodeURIComponent(ROUTE)}`), BASE);
  assert.equal(P.getDeviceUrl(documentFor(""), `${BASE}&page=2`), BASE);
  const deviceLink = '<a href="/?onebox=other-device">other-device</a>';
  assert.equal(P.getDeviceUrl(documentFor(deviceLink), `${P.PAGE_ORIGIN}/route`), `${P.PAGE_ORIGIN}/?onebox=other-device`);
  assert.equal(P.getDeviceUrl(documentFor(deviceLink), ROUTE_URL), BASE);
  for (const html of [
    '<a href="https://untrusted.example/?onebox=other-device">other-device</a>',
    '<a href="https://useradmin.comma.ai:443/?onebox=other-device">other-device</a>',
    '<a href="/?onebox=other-device">different-device</a>',
    '<a href="/?onebox=other-device&onebox=another-device">other-device</a>',
    '<a href="/unrelated?onebox=other-device">other-device</a>',
    deviceLink + '<a href="/?onebox=another-device">another-device</a>'
  ]) assert.equal(P.getDeviceUrl(documentFor(html), `${P.PAGE_ORIGIN}/route`), "");
  assert.equal(P.getDeviceUrl(documentFor(""), `${P.PAGE_ORIGIN}/?onebox=first&onebox=second`), "");
});

test("qlog-only routes remain recognized when rlogs were selected", () => {
  const result = P.snapshot(documentFor(link()), ROUTE_URL, ["rlog"]);
  assert.equal(result.pageKind, "route");
  // availableTypes reports inspected selected files, not an all-types catalog.
  assert.deepEqual(result.availableTypes, []);
  assert.deepEqual(result.files, []);
});

test("recording dates use only the route details start_time and preserve inclusive displayed days", () => {
  const misleading = '<table><tr><td>start_time</td><td>2026-04-16T00:05:00</td></tr></table>';
  const legacyUrl = `${P.PAGE_ORIGIN}/?onebox=${encodeURIComponent("demo-device|2020-01-02--03-04-05")}`;
  const doc = documentFor(misleading + metadata("2026-04-15T23:59:59.123456") + link());
  const onStartDay = P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-15" });
  const onEndDay = P.dateFilter({ mode: "custom", from: "2026-04-16", to: "2026-04-16" });
  const result = P.snapshot(doc, legacyUrl, ["qlog"], { recordingFilter: onStartDay });
  assert.equal(result.recordingDate, "2026-04-15");
  assert.equal(result.recordingMatch, true);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.availableTypes, ["qlog"]);
  assert.equal(P.snapshot(doc, legacyUrl, ["qlog"], { recordingFilter: onEndDay }).recordingMatch, false);
  assert.equal(P.snapshot(device(row()), BASE, ["qlog"], { recordingFilter: onStartDay }).recordingDate, null);
});

test("missing, malformed, or ambiguous recording metadata stays unknown without substituting another timestamp", () => {
  const duplicateStart = '<tr><td>start_time</td><td>2026-04-15T12:30:00</td></tr>';
  const nestedStart = '<table><tr><td>start_time</td><td>2026-04-15T12:30:00</td></tr></table>';
  const cases = [
    "", '<table><tr><td>start_time</td><td>2026-04-15T12:30:00</td></tr></table>',
    metadata().replace("start_time", "upload time"), metadata() + metadata(),
    metadata("2026-04-15T12:30:00", duplicateStart),
    `<table id="table_route5_route"><tr><td>other</td><td>${nestedStart}</td></tr></table>`,
    `<table id="table_route5_route"><tr><td>start_time</td><td>${nestedStart}</td></tr></table>`,
    '<table id="table_route5_route"><tr><td>start_time</td><td>2026-04-15T12:30:00</td><td>2026-04-16T12:30:00</td></tr></table>',
    ...["unknown", "1710000000", "2026-04-15", "2026-04-15T12:00:00Z", "2026-04-15T12:00:00+02:00", "2026-02-29T12:00:00", "0000-01-01T12:00:00", "2026-04-15T24:00:00", "2026-04-15T12:60:00", "2026-04-15T12:00:60"].map(value => metadata(value))
  ];
  const filter = P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-16" });
  for (const html of cases) {
    const doc = documentFor(html + link());
    const result = P.snapshot(doc, ROUTE_URL, ["qlog"], { recordingFilter: filter });
    assert.equal(result.recordingDate, null, html);
    assert.equal(result.recordingMatch, false, html);
    assert.deepEqual(result.files, [], html);
    const all = P.snapshot(doc, ROUTE_URL, ["qlog"], { recordingFilter: P.dateFilter({ mode: "all" }) });
    assert.equal(all.recordingMatch, true, html);
    assert.equal(all.files.length, 1, html);
  }
});

test("recording-date rejection skips file enumeration and accepted routes inspect only requested types", () => {
  const filter = P.dateFilter({ mode: "custom", from: "2026-04-16", to: "2026-04-16" });
  for (const start of ["2026-04-15T12:30:00", "unknown"]) {
    const doc = documentFor(metadata(start) + link() + link(blob("0", "rlog.zst"), "rlog.zst"));
    const querySelectorAll = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = selector => {
      assert.notEqual(selector, "a[href]", "Rejected route must not enumerate its file links");
      return querySelectorAll(selector);
    };
    const rejected = P.snapshot(doc, ROUTE_URL, ["rlog"], { recordingFilter: filter });
    assert.equal(rejected.recordingMatch, false);
    assert.deepEqual(rejected.files, []);
  }
  const accepted = P.snapshot(documentFor(metadata("2026-04-16T00:00:00") + link() + link(blob("0", "rlog.zst"), "rlog.zst")), ROUTE_URL, ["rlog"], { recordingFilter: filter });
  assert.equal(accepted.files.length, 1);
  assert.equal(accepted.files[0].typeKey, "rlog");
  assert.deepEqual(accepted.availableTypes, ["rlog"]);
});

test("selected logs preserve query credentials, canonical names, segment order, and folders", () => {
  const signed = blob("2", "qlog.zst", "?sig=INVENTED%2BVALUE%3D&rscd=attachment%3Bfilename%3D..%2Fwrong.zst");
  const doc = documentFor(link(blob("10")) + link(signed) + link(signed) + link(blob("0", "rlog.zst"), "rlog.zst") + link(blob("0", "qcamera.ts"), "qcamera.ts"));
  const files = P.collectLogFiles(doc, ["qlog"], ROUTE_URL);
  assert.equal(files.length, 2);
  assert.equal(files[0].url, signed);
  assert.equal(files[0].targetPath, "demo-device__11111111--aabbcc/qlog/demo-device_11111111--aabbcc--2--qlog.zst");
  assert.match(files[1].name, /--10--qlog\.zst$/);
});

test("download discovery rejects unsupported hosts, misleading labels, malformed paths and bootlogs", () => {
  const cases = [
    link(blob().replace("commadata2.blob.core.windows.net", "untrusted.example")),
    link(blob(), "rlog.zst"),
    link(blob("%GG")),
    link(blob("%2Fparent")),
    link(blob("%5Cparent")),
    link(blob().replace("test-container", "bootlogs")),
    link(blob().replace("https:", "http:")),
    link(blob().replace("https://", "https://user:password@")),
    link(blob().replace(".net/", ".net:443/"))
  ];
  assert.deepEqual(P.collectLogFiles(documentFor(cases.join("")), ["rlog", "qlog"], BASE), []);
});

test("download names cannot escape folders or collapse distinct segment identifiers", () => {
  assert.notEqual(P.sanitizeFileName("a/b"), P.sanitizeFileName("a_b"));
  assert.notEqual(P.sanitizeFileName("a~2f~b"), P.sanitizeFileName("a/b"));
  for (const raw of ["../bad", "..", "\\root", "CON", "aux.txt", "trailing.", "é", ""]) {
    const safe = P.sanitizeFileName(raw);
    assert.ok(safe.length);
    assert.doesNotMatch(safe, /[/\\\x00-\x1f]|^\.|\.$/);
    assert.doesNotMatch(safe, /^(?:con|aux)(?:\.|$)/i);
  }
});

test("page and blob URL checks enforce exact HTTPS origins without credentials or ports", () => {
  assert.equal(P.isAllowedPageUrl(BASE), true);
  assert.equal(P.isAllowedDownloadUrl(blob()), true);
  for (const value of ["http://useradmin.comma.ai/", "https://useradmin.comma.ai.evil.example/", "https://x@useradmin.comma.ai/", "https://useradmin.comma.ai:443/", " https://useradmin.comma.ai/", "https://useradmin.comma.ai/\n", "https://useradmin.comma.ai\\@evil.example/", "//useradmin.comma.ai/"]) {
    assert.equal(P.isAllowedPageUrl(value), false);
  }
  assert.equal(P.requirePageUrl("/?onebox=demo", BASE), `${P.PAGE_ORIGIN}/?onebox=demo`);
  assert.throws(() => P.requirePageUrl("https://untrusted.example/"), /Only https/);
});

test("pagination keeps the existing device query and uses the following zero-based page", () => {
  const doc = device(row(), '<a onclick="loadMoreRoutes(0)">More routes</a>');
  const next = new URL(P.getNextPageUrl(doc, `${BASE}&sort=upload#routes`));
  assert.equal(next.searchParams.get("page"), "1");
  assert.equal(next.searchParams.get("onebox"), "demo-device");
  assert.equal(next.searchParams.get("sort"), "upload");
  assert.equal(next.hash, "");
  assert.equal(P.getNextPageUrl(device(row(), '<a onclick="loadMoreRoutes(1)">More routes</a>'), `${BASE}&page=1`), `${BASE}&page=2`);
});

test("pagination stops on an exhausted table or stale, disabled, or invalid controls", () => {
  const exhausted = device(row() + row(OTHER_ROUTE) + row("demo-device/33333333--aa"), '<a onclick="loadMoreRoutes(0)">More</a>');
  assert.equal(P.getNextPageUrl(exhausted, BASE), "");
  assert.equal(P.getNextPageUrl(device(row(), '<a onclick="loadMoreRoutes(0)">More</a>'), `${BASE}&page=1`), "");
  for (const attrs of ['onclick="loadMoreRoutes(-1)"', 'onclick="loadMoreRoutes(999999999999999999999)"', 'onclick="loadMoreRoutes(0)" hidden', 'onclick="loadMoreRoutes(0)" aria-disabled="true"']) {
    assert.equal(P.getNextPageUrl(device(row(), `<a ${attrs}>More</a>`), BASE), "");
  }
});

test("date filters reject invalid dates and include both complete calendar endpoints", () => {
  for (const text of ["2026-02-29", "2024-02-29 24:00:00", "2024-02-29 23:60:00", "2024-02-29 23:59:60", "0000-01-01", "2026-13-01", "2026-04-31", "2026-04-15T12:00:00Z"]) {
    assert.equal(P.parseRouteUploadDate(text), null);
  }
  assert.equal(P.parseRouteUploadDate("2024-02-29"), "2024-02-29");
  assert.equal(P.parseRouteUploadDate("2024-02-29 23:59:59"), "2024-02-29");
  assert.throws(() => P.dateFilter({ mode: "custom", from: "2026-04-16", to: "2026-04-15" }), /valid start/);
  assert.throws(() => P.dateFilter({ mode: "custom", from: "2026-02-29", to: "2026-03-01" }), /valid start/);
  assert.throws(() => P.dateFilter({ mode: "recent", days: 1.5 }), /whole number/);
  const filter = P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-16" });
  assert.deepEqual(filter, { mode: "custom", fromDate: "2026-04-15", toDate: "2026-04-16" });
  for (const text of ["2026-04-15 00:00:00", "2026-04-16 23:59:59"]) {
    assert.equal(P.routeMatches({ uploadDate: P.parseRouteUploadDate(text) }, filter), true);
  }
  for (const date of ["2026-04-14", "2026-04-17", "2026-04-31", null, undefined]) {
    assert.equal(P.routeMatches({ uploadDate: date }, filter), false);
  }
  assert.equal(P.routeMatches({ uploadedAt: new Date(2026, 3, 15).getTime() }, filter), false);
  assert.equal(P.routeMatches({ uploadDate: null }, P.dateFilter({ mode: "all" })), true);
});

test("recent windows contain exactly N calendar dates including today across month and year boundaries", () => {
  const recent = P.dateFilter({ mode: "recent", days: 7 }, new Date(2026, 3, 16, 12));
  assert.deepEqual(recent, { mode: "recent", fromDate: "2026-04-10", toDate: "2026-04-16" });
  assert.deepEqual(P.dateFilter({ mode: "recent", days: 1 }, new Date(2026, 3, 16, 12)), { mode: "recent", fromDate: "2026-04-16", toDate: "2026-04-16" });
  assert.deepEqual(P.dateFilter({ mode: "recent", days: 7 }, new Date(2026, 0, 3, 12)), { mode: "recent", fromDate: "2025-12-28", toDate: "2026-01-03" });
  assert.deepEqual(P.dateFilter({ mode: "recent", days: 2 }, new Date(2024, 2, 1, 12)), { mode: "recent", fromDate: "2024-02-29", toDate: "2024-03-01" });
  assert.throws(() => P.dateFilter({ mode: "recent" }, new Date(NaN)), /Invalid current date/);
});

test("displayed upload and recording dates survive DST gaps without reinterpreting their timezone", () => {
  const script = `const P = require(${JSON.stringify(require.resolve("../firefox/parser.js"))});
    console.log(JSON.stringify({
      gap: P.parseRouteUploadDate("2026-03-08 02:30:00"),
      skippedLocalDate: P.parseRouteUploadDate("2011-12-30 12:00:00"),
      recordingGap: P.parseRouteRecordingDate("2026-03-08T02:30:00"),
      recordingSkippedDate: P.parseRouteRecordingDate("2011-12-30T12:00:00"),
      recent: P.dateFilter({mode:"recent",days:7}, new Date(2026,2,9,12)),
      matches: P.routeMatches({uploadDate:"2026-03-08"},P.dateFilter({mode:"custom",from:"2026-03-08",to:"2026-03-08"}))
    }));`;
  for (const TZ of ["UTC", "America/New_York", "Pacific/Auckland", "Pacific/Apia"]) {
    const result = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ }, encoding: "utf8" }));
    assert.deepEqual(result, {
      gap: "2026-03-08", skippedLocalDate: "2011-12-30", recordingGap: "2026-03-08", recordingSkippedDate: "2011-12-30", matches: true,
      recent: { mode: "recent", fromDate: "2026-03-03", toDate: "2026-03-09" }
    }, TZ);
  }
});

test("login, raw log viewers, and unrelated pages give actionable errors", () => {
  assert.throws(() => P.snapshot(documentFor('<form><input type="password"></form>'), BASE), /Sign in/);
  assert.throws(() => P.snapshot(documentFor('<select><option>Demo event</option></select><pre>Invented log viewer text</pre>'), BASE), /log viewer/);
  assert.throws(() => P.snapshot(documentFor('<p>No route data here</p>'), BASE), /device page/);
  assert.equal(P.snapshot(device(""), BASE).pageKind, "device");
  assert.equal(P.snapshot(documentFor("<table><tr><td>No uploaded segments</td></tr></table>"), ROUTE_URL).pageKind, "route");
});

function bridgeHarness(fetchImpl) {
  let listener;
  const context = {
    CommaParser: P, document: device(), location: { href: BASE }, DOMParser,
    AbortController, setTimeout, clearTimeout,
    browser: { runtime: { id: "demo-extension@example.test", onMessage: { addListener(value) { listener = value; } } } },
    fetch: fetchImpl || (async () => { throw new Error("Unexpected fetch"); })
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../firefox/bridge.js"), "utf8"), context);
  return {
    context,
    read(message, sender = { id: "demo-extension@example.test" }) { return listener(message, sender); }
  };
}

test("bridge reads its source DOM, validates the sender, and detects source navigation", async () => {
  const harness = bridgeHarness();
  assert.equal((await harness.read({ type: "comma:read" })).routes.length, 1);
  assert.match((await harness.read({ type: "comma:read" }, { id: "someone-else" })).error, /Unsupported/);
  assert.match((await harness.read({ type: "comma:read", expectedUrl: `${BASE}&page=2` })).error, /navigated/);
  assert.equal(harness.read({ type: "unrelated" }), undefined);
});

test("bridge fetches only useradmin HTML with the existing tab's credentials and blocks redirects", async () => {
  let fetched = 0;
  const harness = bridgeHarness(async (url, options) => {
    fetched += 1;
    assert.equal(url, ROUTE_URL);
    assert.equal(options.credentials, "include");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return { ok: true, url, headers: { get: () => "text/html; charset=utf-8" }, text: async () => documentFor(link()).toString() };
  });
  const result = await harness.read({ type: "comma:read", url: ROUTE_URL, expectedUrl: BASE, selectedTypes: ["qlog"], scanId: "scan-1" });
  assert.equal(result.files.length, 1);
  assert.match((await harness.read({ type: "comma:read", url: "https://untrusted.example/" })).error, /Only https/);
  assert.equal(fetched, 1);
});

test("bridge forwards recording filters and reads corrected dates afresh on each explicit scan", async () => {
  let fetched = 0;
  const harness = bridgeHarness(async (url, options) => {
    assert.equal(options.cache, "no-store");
    const start = ++fetched === 1 ? "2026-04-14T12:30:00" : "2026-04-15T12:30:00";
    return { ok: true, url, headers: { get: () => "text/html" }, text: async () => documentFor(metadata(start) + link()).toString() };
  });
  const recordingFilter = P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-15" });
  const message = { type: "comma:read", url: ROUTE_URL, expectedUrl: BASE, selectedTypes: ["qlog"], recordingFilter };
  const before = await harness.read({ ...message, scanId: "fresh-1" });
  const after = await harness.read({ ...message, scanId: "fresh-2" });
  assert.equal(fetched, 2);
  assert.equal(before.recordingDate, "2026-04-14");
  assert.equal(before.recordingMatch, false);
  assert.equal(before.files.length, 0);
  assert.equal(after.recordingDate, "2026-04-15");
  assert.equal(after.recordingMatch, true);
  assert.equal(after.files.length, 1);
  harness.context.location.href = ROUTE_URL;
  harness.context.document = documentFor(metadata("2026-04-14T12:30:00") + link());
  const source = await harness.read({ type: "comma:read", selectedTypes: ["qlog"], recordingFilter });
  assert.equal(source.recordingMatch, false);
  assert.equal(source.files.length, 0);
  assert.equal(fetched, 2);
});

test("bridge cancellation aborts concurrent page reads and prevents queued reads restarting that scan", async () => {
  let fetched = 0;
  let aborted = 0;
  const harness = bridgeHarness(async (_url, { signal }) => {
    fetched += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      aborted += 1;
      const error = new Error("Aborted"); error.name = "AbortError"; reject(error);
    }, { once: true }));
  });
  const a = harness.read({ type: "comma:read", url: ROUTE_URL, scanId: "cancel-me" });
  const b = harness.read({ type: "comma:read", url: ROUTE_URL, scanId: "cancel-me" });
  await Promise.resolve();
  assert.equal((await harness.read({ type: "comma:cancel-read", scanId: "cancel-me" })).cancelled, true);
  assert.equal((await a).error, "Scan cancelled.");
  assert.equal((await b).error, "Scan cancelled.");
  assert.equal((await harness.read({ type: "comma:read", url: ROUTE_URL, scanId: "cancel-me" })).error, "Scan cancelled.");
  assert.equal(fetched, 2);
  assert.equal(aborted, 2);
});

test("bridge rejects non-HTML responses and source navigation during a fetch", async () => {
  const badContent = bridgeHarness(async () => ({ ok: true, url: ROUTE_URL, headers: { get: () => "application/octet-stream" } }));
  assert.match((await badContent.read({ type: "comma:read", url: ROUTE_URL })).error, /not a useradmin page/);
  const navigation = bridgeHarness(async () => ({ ok: true, url: ROUTE_URL, headers: { get: () => "text/html" }, text: async () => {
    navigation.context.location.href = `${BASE}&page=1`;
    return documentFor(link()).toString();
  } }));
  assert.match((await navigation.read({ type: "comma:read", url: ROUTE_URL })).error, /navigated/);
});

test("bridge does not expose request URLs through arbitrary network error messages", async () => {
  const harness = bridgeHarness(async () => { throw new Error(`Network request failed: ${blob()}`); });
  const result = await harness.read({ type: "comma:read", url: ROUTE_URL });
  assert.equal(result.error, "Unable to read this source page. Keep useradmin open and try again.");
  assert.doesNotMatch(result.error, /INVENTED_TEST_SIGNATURE|commadata2/);
});
