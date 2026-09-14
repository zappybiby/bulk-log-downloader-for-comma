/* All HTML, identifiers, dates, and download URLs here are invented test data. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
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

test("device route discovery excludes incident links and deduplicates its route table", () => {
  const doc = device(row() + row() + row(OTHER_ROUTE, "2026-04-16"), `<table>${row("incident-device/33333333--aaff")}</table>`);
  const result = P.snapshot(doc, BASE, ["qlog"]);
  assert.equal(result.pageKind, "device");
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0].key, ROUTE.replace("/", "|"));
  assert.equal(result.routes[0].uploadedAt, new Date(2026, 3, 15, 12, 30).getTime());
  assert.equal(result.files.length, 0);
});

test("route identity comes from a validated link and matching text", () => {
  const mismatch = row().replace(encodeURIComponent(ROUTE.replace("/", "|")), encodeURIComponent(OTHER_ROUTE.replace("/", "|")));
  const external = row().replace('/?onebox=', 'https://untrusted.example/?onebox=');
  const legacy = "demo-device/2020-01-02--03-04-05";
  assert.deepEqual(P.collectRouteLinks(device(mismatch + external + row(legacy)), BASE).map(route => route.name), [legacy]);
});

test("qlog-only routes remain recognized when rlogs were selected", () => {
  const result = P.snapshot(documentFor(link()), ROUTE_URL, ["rlog"]);
  assert.equal(result.pageKind, "route");
  assert.deepEqual(result.availableTypes, ["qlog"]);
  assert.deepEqual(result.files, []);
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

test("date filters reject invalid calendar dates and include the complete end date", () => {
  assert.equal(P.parseRouteUploadTime("2026-02-29"), null);
  assert.equal(P.parseRouteUploadTime("2024-02-29 24:00:00"), null);
  assert.notEqual(P.parseRouteUploadTime("2024-02-29"), null);
  assert.throws(() => P.dateFilter({ mode: "custom", from: "2026-04-16", to: "2026-04-15" }), /valid start/);
  assert.throws(() => P.dateFilter({ mode: "recent", days: 1.5 }), /whole number/);
  const filter = P.dateFilter({ mode: "custom", from: "2026-04-15", to: "2026-04-16" });
  assert.equal(P.routeMatches({ uploadedAt: new Date(2026, 3, 16, 23, 59, 59, 999).getTime() }, filter), true);
  assert.equal(P.routeMatches({ uploadedAt: new Date(2026, 3, 17).getTime() }, filter), false);
  assert.equal(P.routeMatches({ uploadedAt: null }, filter), false);
  assert.equal(P.routeMatches({ uploadedAt: null }, P.dateFilter({ mode: "all" })), true);
  const recent = P.dateFilter({ mode: "recent", days: 7 }, new Date(2026, 3, 16, 12));
  assert.equal(recent.from, new Date(2026, 3, 10).getTime());
  assert.equal(recent.to, new Date(2026, 3, 16, 23, 59, 59, 999).getTime());
  assert.equal(P.dateFilter({ mode: "recent", days: 1 }, new Date(2026, 3, 16, 12)).from, new Date(2026, 3, 16).getTime());
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
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return { ok: true, url, headers: { get: () => "text/html; charset=utf-8" }, text: async () => documentFor(link()).toString() };
  });
  const result = await harness.read({ type: "comma:read", url: ROUTE_URL, expectedUrl: BASE, selectedTypes: ["qlog"], scanId: "scan-1" });
  assert.equal(result.files.length, 1);
  assert.match((await harness.read({ type: "comma:read", url: "https://untrusted.example/" })).error, /Only https/);
  assert.equal(fetched, 1);
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
