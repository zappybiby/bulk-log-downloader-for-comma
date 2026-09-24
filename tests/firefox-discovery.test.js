"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const Parser = require("../firefox/parser.js");
const Scanner = require("../firefox/scanner.js");

const device = "0123456789abcdef";
const sourceUrl = `${Parser.PAGE_ORIGIN}/?onebox=${device}`;
const ids = ["0000000a--aaaaaaaa", "0000000c--cccccccc", "0000000e--eeeeeeee",
  "00000014--dddddddd", "0000006b--bbbbbbbb", "00000099--ffffffff"];
const routeName = index => `${device}/${ids[index]}`;
const routeUrl = index => `${Parser.PAGE_ORIGIN}/?onebox=${encodeURIComponent(routeName(index))}`;
const key = index => routeName(index).replace("/", "|");
const filter = Parser.dateFilter({ mode: "custom", from: "2026-09-18", to: "2026-09-24" });

function document(html) {
  return new JSDOM(html).window.document;
}

function row(index, upload = "2026-09-24 12:00:00", separator = "/") {
  const name = routeName(index).replace("/", separator);
  return `<tr><td>${upload}</td><td><a href="?onebox=${encodeURIComponent(name)}">${name}</a></td></tr>`;
}

function table(rows, id = "") {
  return `<table${id ? ` id="${id}"` : ""}><tr><th>upload_time</th><th>route_name</th></tr>${rows}</table>`;
}

function section(label, rows, id = "") {
  return `<details><summary>${label}</summary>${table(rows, id)}</details>`;
}

function listing() {
  // Synthetic version of the reported layout, including a preserved route
  // whose rlogs start at segment 30 and an old preserved route outside the range.
  return section("preserved routes (2)", row(3) + row(4))
    + section("routes (3)", row(0) + row(1) + row(2), "table_routes")
    + section("crash logs (1)", row(5), "table_crashes");
}

function routePage(index, recorded, segments) {
  const files = segments.map(segment => `<tr><td><a href="${Parser.DOWNLOAD_ORIGIN}/logs/${routeName(index)}/${segment}/rlog.zst">rlog.zst</a></td></tr>`).join("");
  return `<table id="table_route5_route"><tr><td>start_time</td><td>${recorded}T12:00:00</td></tr></table>`
    + `<table>${files}</table>`;
}

test("discovers regular and preserved routes, excluding crash/event links", () => {
  const html = listing() + section("events (1)", row(5), "table_events");
  const routes = Parser.collectRouteLinks(document(html), sourceUrl);
  assert.deepEqual(new Set(routes.map(route => route.key)), new Set([0, 1, 2, 3, 4].map(key)));
  assert.equal(routes.find(route => route.key === key(3)).uploadDate, "2026-09-24");
});

test("recognizes a device with only a collapsed preserved route section", () => {
  const page = Parser.snapshot(document(section("preserved routes (1)", row(3))), sourceUrl, ["rlog"]);
  assert.equal(page.pageKind, "device");
  assert.deepEqual(page.routes.map(route => route.key), [key(3)]);
});

test("accepts the live preserved-table ID with spaces and pipe queries with slash labels", () => {
  const preservedRow = row(3).replace(encodeURIComponent(routeName(3)), encodeURIComponent(key(3)));
  const html = section("preserved routes (1)", preservedRow, "table_preserved routes")
    + section("routes (1)", row(0), "table_routes");
  const page = Parser.snapshot(document(html), sourceUrl, ["rlog"]);
  assert.equal(page.pageKind, "device");
  assert.equal(page.routes.length, 2);
  const preserved = page.routes.find(route => route.key === key(3));
  assert.ok(preserved);
  assert.equal(new URL(preserved.url).searchParams.get("onebox"), key(3));
  assert.equal(preserved.uploadDate, "2026-09-24");
});

test("deduplicates preserved/regular route links and normalizes separators", () => {
  const html = section("preserved routes (1)", row(3))
    + section("routes (2)", row(3, "2026-09-24 12:00:00", "|") + row(0), "table_routes");
  const routes = Parser.collectRouteLinks(document(html), sourceUrl);
  assert.equal(routes.length, 2);
  assert.equal(routes.filter(route => route.key === key(3)).length, 1);
});

test("continues to exclude unrelated links on regular-only device pages", () => {
  const html = section("routes (1)", row(0), "table_routes")
    + section("crash logs (1)", row(5), "table_crashes");
  assert.deepEqual(Parser.collectRouteLinks(document(html), sourceUrl).map(route => route.key), [key(0)]);
});

test("retains route-list fragment support", () => {
  const doc = document(table(row(0)));
  assert.deepEqual(Parser.collectRouteLinks(doc, sourceUrl).map(route => route.key), [key(0)]);
  assert.deepEqual(Parser.collectRouteLinks(doc.querySelector("table"), sourceUrl).map(route => route.key), [key(0)]);
});

test("preserved links cannot satisfy the regular route pagination count", () => {
  const html = section("preserved routes (2)", row(3) + row(4))
    + section("routes (3)", row(0), "table_routes")
    + '<a onclick="loadMoreRoutes(0)">Load more</a>';
  assert.equal(Parser.getNextPageUrl(document(html), sourceUrl), `${sourceUrl}&page=1`);
  assert.equal(Parser.getNextPageUrl(document(listing() + '<a onclick="loadMoreRoutes(0)">Load more</a>'), sourceUrl), "");
});

async function scanFixture(dateBasis) {
  const range = (start, count) => Array.from({ length: count }, (_, offset) => start + offset);
  const pages = new Map([
    [sourceUrl, listing()],
    [routeUrl(0), routePage(0, "2026-09-21", range(0, 13))],
    [routeUrl(1), routePage(1, "2026-09-21", range(0, 8))],
    [routeUrl(2), routePage(2, "2026-09-22", range(0, 2))],
    [routeUrl(3), routePage(3, "2026-09-23", range(30, 12))],
    [routeUrl(4), routePage(4, "2026-05-31", range(0, 7))]
  ]);
  const reads = [];
  const result = await Scanner.scan({
    sourceUrl, scope: "listed", dateBasis, filter, selectedTypes: ["rlog"],
    readPage: async request => {
      reads.push(request.url);
      assert.ok(pages.has(request.url), "must only read catalogued route pages");
      return Parser.snapshot(document(pages.get(request.url)), request.url, request.selectedTypes,
        { recordingFilter: request.recordingFilter });
    }
  });
  return { result, reads };
}

test("recording scan finds late-segment preserved rlogs within the date range", async () => {
  const { result, reads } = await scanFixture("recording");
  assert.equal(result.files.length, 35);
  assert.equal(result.matchedRoutes, 4);
  assert.equal(result.filteredRoutes, 1);
  assert.equal(result.routesRead, 5);
  assert.equal(reads.length, 6);
  const preserved = result.files.filter(file => file.url.includes(ids[3]));
  assert.equal(preserved.length, 12);
  assert.ok(preserved.some(file => file.url.includes("/30/rlog.zst")));
  assert.ok(preserved.some(file => file.url.includes("/41/rlog.zst")));
  assert.ok(preserved.every(file => file.recordingDate === "2026-09-23"));
  assert.ok(result.files.every(file => !file.url.includes(ids[4])));
});

test("upload scan applies the preserved table upload date, not recording date", async () => {
  const { result } = await scanFixture("upload");
  assert.equal(result.files.length, 42);
  assert.equal(result.matchedRoutes, 5);
  assert.ok(result.files.every(file => file.uploadDate === "2026-09-24"));
});
