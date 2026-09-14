"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");
const { parseHTML } = require("linkedom");
const CommaParser = require("../firefox/parser.js");

const UI_DIR = path.join(__dirname, "../firefox");
const html = fs.readFileSync(path.join(UI_DIR, "downloads.html"), "utf8");
const script = fs.readFileSync(path.join(UI_DIR, "downloads.js"), "utf8");
const SOURCE = "https://useradmin.comma.ai/?onebox=demo-device";
const TODAY = "2026-09-14";
const FROZEN_NOW = new Date(2026, 8, 14, 12, 0, 0).getTime();

class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [FROZEN_NOW])); }
  static now() { return FROZEN_NOW; }
}

function file(segment = "0", type = "rlog", route = "11111111--abc") {
  const extension = { rlog: "zst", qlog: "zst", qcamera: "ts" }[type] || "hevc";
  const name = `demo_${route}--${segment}--${type}.${extension}`;
  return {
    url: `https://commadata2.blob.core.windows.net/demo/${route}/${segment}/${type}.${extension}?sig=synthetic`,
    name, routeFolderName: `demo__${route}`, typeFolderName: type, typeKey: type,
    targetPath: `demo__${route}/${type}/${name}`
  };
}

function snapshot({ url = SOURCE, files = [], routes = [], nextPageUrl = "", pageKind = "route", deviceUrl = "" } = {}) {
  return { url, title: "Synthetic test route", files, routes, nextPageUrl, pageKind, deviceUrl };
}

function route(key, date = "2026-09-10") {
  return {
    key, name: `demo/${key}`, url: `${SOURCE}|${key}`,
    uploadDate: date
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, description = "UI update") {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function harness({ source = snapshot({ files: [file()] }), sourceTab = "42", read, build, preferences } = {}) {
  const { document, window } = parseHTML(html);
  // linkedom does not reflect checked properties or enforce radio groups itself.
  Object.defineProperty(window.HTMLInputElement.prototype, "checked", {
    configurable: true,
    get() { return this.hasAttribute("checked"); },
    set(value) {
      if (value && this.type === "radio") {
        for (const input of this.ownerDocument.querySelectorAll('input[type="radio"]')) {
          if (input !== this && input.name === this.name) input.removeAttribute("checked");
        }
      }
      this.toggleAttribute("checked", Boolean(value));
    }
  });
  const reads = [], builds = [], revoked = [], saves = [], disposed = [];
  let objectCount = 0;
  class TestURL extends URL {
    static createObjectURL() { return `blob:synthetic-${++objectCount}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const browser = {
    tabs: {
      async sendMessage(id, message) {
        reads.push({ id, ...message });
        if (read) return read(message, reads);
        if (message.type === "comma:cancel-read") return { cancelled: true };
        return { ...source, files: source.files.filter(item => message.selectedTypes.includes(item.typeKey)) };
      },
      async update() {}
    },
    storage: { local: {
      async get() { return { firefoxPreferences: preferences }; },
      async set(value) { saves.push(value); }
    } }
  };
  const CommaArchive = {
    async build(files, options) {
      builds.push({ files, options });
      if (build) return build(files, options);
      options.onProgress({ filesDone: files.length, filesTotal: files.length, bytesReceived: 100, storage: "memory", maxBytes: 32 * 1024 * 1024 });
      return {
        blob: new Blob(["synthetic archive"]), count: files.length, filename: "synthetic-logs.zip", bytes: 117,
        storage: "memory", async dispose() { disposed.push(true); }
      };
    }
  };
  const context = vm.createContext({
    document, location: { href: `moz-extension://synthetic/downloads.html${sourceTab === null ? "" : `?sourceTab=${sourceTab}`}` },
    browser,
    CommaParser: { ...CommaParser, dateFilter: (settings, now = new TestDate()) => CommaParser.dateFilter(settings, now) },
    CommaArchive, URL: TestURL, Date: TestDate, AbortController, DOMException,
    crypto: webcrypto, addEventListener: window.addEventListener.bind(window)
  });
  vm.runInContext(script, context, { filename: "downloads.js" });
  const el = id => document.getElementById(id);
  const click = id => el(id).dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  function choose(name, value, checked = true) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    input.checked = checked;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  function input(id, value) {
    el(id).value = value;
    el(id).dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  async function ready() { await until(() => el("source-indicator").classList.contains("connected") || el("source-title").textContent === "Source page unavailable", "initial source check"); }
  async function scan() {
    click("scan-button");
    await until(() => el("cancel-scan-button").hidden, "scan completion");
  }
  return { document, window, el, click, choose, input, ready, scan, reads, builds, revoked, saves, disposed };
}

function listedHarness(routes, options = {}) {
  return harness({
    ...options,
    read(message) {
      if (message.type === "comma:cancel-read") return { cancelled: true };
      if (!message.url) return snapshot({ routes, pageKind: "device" });
      const match = routes.find(item => item.url === message.url);
      assert.ok(match, "Only a listed route may be read");
      return snapshot({ url: match.url, files: [file("0", "rlog", match.key)] });
    }
  });
}

function selectedMode(ui) {
  return ui.document.querySelector('input[name="date-mode"]:checked')?.value;
}

function fetchedRoutes(ui) {
  return ui.reads.filter(message => message.url).map(message => message.url);
}

test("missing source tab shows recovery instructions and prevents scanning", async () => {
  const ui = harness({ sourceTab: null });
  await ui.ready();
  assert.match(ui.el("page-notice").textContent, /Open a device or route page/);
  assert.equal(ui.el("scan-button").disabled, true);
  assert.equal(ui.reads.length, 0);
});

test("Last 7 uses seven inclusive upload dates, shows the exact range, and selects the preset", async () => {
  const before = route("11111111--aaa", "2026-09-07");
  const first = route("22222222--bbb", "2026-09-08");
  const today = route("33333333--ccc", TODAY);
  const future = route("44444444--ddd", "2026-09-15");
  const ui = listedHarness([before, first, today, future]);
  await ui.ready();
  ui.click("date-preset-7");
  assert.equal(selectedMode(ui), "recent");
  assert.equal(ui.el("date-days").value, "7");
  assert.equal(ui.el("date-preset-7").getAttribute("aria-pressed"), "true");
  assert.match(ui.el("date-summary").textContent, /2026-09-08/);
  assert.match(ui.el("date-summary").textContent, /2026-09-14/);
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui), [first.url, today.url]);
  assert.equal(ui.el("file-count").textContent, "2");
});

test("Today and Last 30 presets update the number of days and resolved bounds", async () => {
  const ui = listedHarness([route("11111111--aaa", TODAY)]);
  await ui.ready();
  ui.click("date-preset-1");
  assert.equal(ui.el("date-days").value, "1");
  assert.equal(ui.el("date-preset-1").getAttribute("aria-pressed"), "true");
  assert.equal(ui.el("date-preset-7").getAttribute("aria-pressed"), "false");
  assert.match(ui.el("date-summary").textContent, /2026-09-14/);
  ui.click("date-preset-30");
  assert.equal(ui.el("date-days").value, "30");
  assert.equal(ui.el("date-preset-30").getAttribute("aria-pressed"), "true");
  assert.match(ui.el("date-summary").textContent, /2026-08-16/);
  assert.match(ui.el("date-summary").textContent, /2026-09-14/);
});

test("typing arbitrary days selects recent mode and invalidates stale scan results", async () => {
  const older = route("11111111--aaa", "2026-09-05");
  const first = route("22222222--bbb", "2026-09-06");
  const today = route("33333333--ccc", TODAY);
  const ui = listedHarness([older, first, today]);
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  ui.click("date-preset-custom");
  ui.input("date-days", "9");
  assert.equal(selectedMode(ui), "recent");
  assert.equal(ui.el("download-button").disabled, true);
  assert.equal(ui.el("results-content").hidden, true);
  assert.match(ui.el("date-summary").textContent, /2026-09-06/);
  for (const days of [1, 7, 30]) assert.equal(ui.el(`date-preset-${days}`).getAttribute("aria-pressed"), "false");
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui).slice(1), [first.url, today.url]);
  assert.equal(ui.el("file-count").textContent, "2");
  assert.equal(ui.saves.at(-1).firefoxPreferences.date.days, "9");
});

test("editing either custom date selects custom mode and includes both boundary dates", async () => {
  const before = route("11111111--aaa", "2026-09-08");
  const first = route("22222222--bbb", "2026-09-09");
  const last = route("33333333--ccc", "2026-09-10");
  const after = route("44444444--ddd", "2026-09-11");
  const ui = listedHarness([before, first, last, after]);
  await ui.ready();
  ui.click("date-preset-all");
  ui.input("date-from", "2026-09-09");
  assert.equal(selectedMode(ui), "custom");
  ui.click("date-preset-7");
  ui.input("date-to", "2026-09-10");
  assert.equal(selectedMode(ui), "custom");
  assert.equal(ui.el("date-preset-custom").getAttribute("aria-pressed"), "true");
  assert.match(ui.el("date-summary").textContent, /2026-09-09/);
  assert.match(ui.el("date-summary").textContent, /2026-09-10/);
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui), [first.url, last.url]);
  assert.equal(ui.el("file-count").textContent, "2");
});

test("invalid custom ranges cannot reuse a previously successful selection", async () => {
  const ui = listedHarness([route("11111111--aaa", TODAY)]);
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("download-button").disabled, false);
  const priorReads = ui.reads.length;
  ui.input("date-from", "2026-09-15");
  ui.input("date-to", "2026-09-14");
  assert.equal(ui.el("download-button").disabled, true);
  ui.click("scan-button");
  assert.equal(ui.reads.length, priorReads, "invalid dates must not start a page read");
  assert.equal(ui.el("download-button").disabled, true);
});

test("All dates includes undated and older routes", async () => {
  const older = route("11111111--aaa", "2020-01-01");
  const undated = route("22222222--bbb", null);
  const ui = listedHarness([older, undated]);
  await ui.ready();
  ui.click("date-preset-all");
  assert.equal(selectedMode(ui), "all");
  assert.equal(ui.el("date-preset-all").getAttribute("aria-pressed"), "true");
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui), [older.url, undated.url]);
  assert.equal(ui.el("file-count").textContent, "2");
});

test("route upload date governs UI filtering when drive dates and route timestamp IDs disagree", async () => {
  const rows = [
    { id: "2026-01-01--10-00-00", upload: "2026-09-10 23:59:59", drive: "2026-01-01" },
    { id: "2026-09-10--10-00-00", upload: "2026-09-09 12:00:00", drive: "2026-09-10" }
  ];
  const { document } = parseHTML(`<html><head><title>Invented date fixture</title></head><body>
    <table id="table_routes"><thead><tr><th>Upload time</th><th>route</th><th>Drive date</th></tr></thead><tbody>
      ${rows.map(row => `<tr><td>${row.upload}</td><td><a href="?onebox=demo|${row.id}">demo/${row.id}</a></td><td>${row.drive}</td></tr>`).join("")}
    </tbody></table></body></html>`);
  const parsed = CommaParser.snapshot(document, SOURCE, ["rlog"]);
  assert.deepEqual(parsed.routes.map(item => item.uploadDate), ["2026-09-10", "2026-09-09"]);
  const ui = harness({
    read(message) {
      if (!message.url) return parsed;
      assert.equal(message.url, parsed.routes[0].url, "drive date and route ID must not select the second route");
      return snapshot({ url: message.url, files: [file("0", "rlog", rows[0].id)] });
    }
  });
  await ui.ready();
  ui.input("date-from", "2026-09-10");
  ui.input("date-to", "2026-09-10");
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui), [parsed.routes[0].url]);
  assert.equal(ui.el("file-count").textContent, "1");
});

test("all original log and camera choices reach the scan and ZIP builder", async () => {
  const types = ["rlog", "qlog", "qcamera", "fcamera", "ecamera", "dcamera"];
  const ui = harness({ source: snapshot({ files: types.map(type => file("0", type)) }) });
  await ui.ready();
  for (const type of types) {
    const input = ui.document.querySelector(`input[name="file-type"][value="${type}"]`);
    assert.ok(input, `${type} must be available`);
    if (type.endsWith("camera")) assert.ok(input.closest("details"), "camera choices belong in a disclosure");
    ui.choose("file-type", type);
  }
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "6");
  assert.deepEqual(Array.from(ui.reads.at(-1).selectedTypes).sort(), [...types].sort());
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden);
  assert.deepEqual(Array.from(ui.builds[0].files, item => item.typeKey).sort(), [...types].sort());
});

test("bulk selection from a route reads its device listing and keeps the source navigation guard", async () => {
  const sourceUrl = `${SOURCE}|11111111--aaa`;
  const selected = route("22222222--bbb", TODAY);
  const ui = harness({
    read(message) {
      if (!message.url) return snapshot({ url: sourceUrl, files: [file()], deviceUrl: SOURCE });
      if (message.url === SOURCE) return snapshot({ routes: [selected], pageKind: "device" });
      if (message.url === selected.url) return snapshot({ url: selected.url, files: [file("0", "rlog", selected.key)] });
      assert.fail("unexpected URL");
    }
  });
  await ui.ready();
  assert.equal(ui.document.querySelector('input[name="scope"][value="listed"]').disabled, false);
  ui.choose("scope", "listed");
  ui.click("date-preset-7");
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui), [SOURCE, selected.url]);
  assert.equal(ui.el("file-count").textContent, "1");
  assert.ok(ui.reads.slice(1).every(message => message.expectedUrl === sourceUrl));
});

test("source capabilities disable invalid scopes and override stale saved scope preferences", async () => {
  const device = listedHarness([route("11111111--aaa", TODAY)], { preferences: { scope: "current" } });
  await device.ready();
  const deviceCurrent = device.document.querySelector('input[name="scope"][value="current"]');
  assert.equal(deviceCurrent.disabled, true);
  assert.equal(device.document.querySelector('input[name="scope"]:checked').value, "listed");
  assert.equal(device.el("date-settings").hidden, false);
  const isolatedRoute = harness({ source: snapshot({ files: [file()] }), preferences: { scope: "listed" } });
  await isolatedRoute.ready();
  assert.equal(isolatedRoute.document.querySelector('input[name="scope"][value="listed"]').disabled, true);
  assert.equal(isolatedRoute.document.querySelector('input[name="scope"]:checked').value, "current");
  assert.equal(isolatedRoute.el("date-settings").hidden, true);
  const viewer = harness({ source: snapshot({ pageKind: "viewer" }) });
  await viewer.ready();
  assert.equal(viewer.el("scan-button").disabled, true);
  for (const scope of viewer.document.querySelectorAll('input[name="scope"]')) assert.equal(scope.disabled, true);
});

test("results group files by route and the sticky bar exposes only the next primary action", async () => {
  const one = route("11111111--aaa", "2026-09-12");
  const two = route("22222222--bbb", TODAY);
  const ui = harness({ read(message) {
    if (!message.url) return snapshot({ routes: [one, two], pageKind: "device" });
    const item = [one, two].find(candidate => candidate.url === message.url);
    return snapshot({ url: item.url, files: [file("0", "rlog", item.key), file("1", "rlog", item.key)] });
  } });
  const primary = () => ["scan-button", "download-button", "save-button"].filter(id => !ui.el(id).hidden);
  await ui.ready();
  assert.deepEqual(primary(), ["scan-button"]);
  await ui.scan();
  assert.deepEqual(primary(), ["download-button"]);
  assert.equal(ui.el("file-count").textContent, "4");
  const groups = ui.el("file-preview").querySelectorAll("details.route-group");
  assert.equal(groups.length, 2);
  for (const [index, group] of Array.from(groups).entries()) {
    assert.equal(group.hasAttribute("open"), false, "individual filenames stay collapsed initially");
    assert.match(group.querySelector("summary").textContent, /2/);
    assert.match(group.querySelector("summary").textContent, /rlog/);
    assert.ok(group.querySelector("summary").textContent.includes([one, two][index].uploadDate));
  }
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden);
  assert.deepEqual(primary(), ["save-button"]);
});

test("qlog-only route reports no matching rlogs, then prepares selected qlogs", async () => {
  const ui = harness({ source: snapshot({ files: [file("0", "qlog"), file("1", "qlog")] }) });
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "0");
  assert.match(ui.el("scan-detail").textContent, /Choose another file type/);
  assert.equal(ui.el("download-button").disabled, true);
  ui.choose("file-type", "rlog", false);
  ui.choose("file-type", "qlog");
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "2");
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden, "ZIP preparation");
  assert.deepEqual(Array.from(ui.builds[0].files, item => item.typeKey), ["qlog", "qlog"]);
  assert.equal(ui.el("storage-fallback").hidden, false);
  assert.ok(ui.saves.every(saved => !JSON.stringify(saved).includes("synthetic")), "preferences must not retain route or file URLs");
});

test("listed routes follow pagination, deduplicate files, and apply custom dates without early stopping", async () => {
  const old = route("11111111--aaa", "2025-01-01");
  const recent = route("22222222--bbb", "2026-09-10");
  const undated = route("33333333--ccc", null);
  const nextUrl = `${SOURCE}&page=2`;
  const first = snapshot({ routes: [old], nextPageUrl: nextUrl, pageKind: "device" });
  const ui = harness({
    preferences: { scope: "listed", selectedTypes: ["rlog"], date: { mode: "custom", from: "2026-09-01", to: "2026-09-14" } },
    read(message) {
      if (!message.url) return first;
      if (message.url === nextUrl) return snapshot({ url: nextUrl, routes: [recent, recent, undated], pageKind: "route-list" });
      if (message.url === recent.url) return snapshot({ url: recent.url, files: [file(), file()] });
      assert.fail("Out-of-range routes should not be fetched");
    }
  });
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  assert.match(ui.el("scan-detail").textContent, /2 routes were excluded/);
  assert.match(ui.el("scan-detail").textContent, /1 had no readable upload date/);
  assert.equal(ui.reads.filter(message => message.url === recent.url).length, 1);
  const scanReads = ui.reads.slice(1);
  assert.ok(scanReads.every(message => message.expectedUrl === SOURCE && message.scanId));
});

test("a failed route read discards earlier files and prevents partial preparation", async () => {
  const one = route("11111111--aaa"), two = route("22222222--bbb");
  let failRouteRead = true;
  const ui = harness({
    preferences: { scope: "listed", date: { mode: "all" } },
    read(message) {
      if (!message.url) return snapshot({ routes: [one, two], pageKind: "device" });
      if (message.url === one.url) return snapshot({ url: one.url, files: [file()] });
      return failRouteRead ? { error: "Page read failed (HTTP 503)." }
        : snapshot({ url: two.url, files: [file("0", "rlog", two.key)] });
    }
  });
  await ui.ready();
  await ui.scan();
  assert.match(ui.el("scan-status").textContent, /503/);
  assert.match(ui.el("action-summary").textContent, /scan failed/i);
  assert.doesNotMatch(ui.el("action-summary").textContent, /ready to prepare/i);
  assert.equal(ui.el("results-content").hidden, true);
  assert.equal(ui.el("download-button").disabled, true);
  ui.click("download-button");
  assert.equal(ui.builds.length, 0);
  failRouteRead = false;
  ui.click("scan-button");
  assert.match(ui.el("action-summary").textContent, /scanning/i);
  assert.doesNotMatch(ui.el("action-summary").textContent, /failed/i);
  await until(() => ui.el("cancel-scan-button").hidden);
  assert.equal(ui.el("file-count").textContent, "2");
  assert.match(ui.el("action-summary").textContent, /ready to prepare/i);
});

test("scan cancellation ignores late files and a fresh scan can succeed", async () => {
  const pending = deferred();
  let readCount = 0;
  const ui = harness({
    read(message) {
      if (message.type === "comma:cancel-read") return { cancelled: true };
      readCount += 1;
      return readCount === 2 ? pending.promise : snapshot({ files: [file()] });
    }
  });
  await ui.ready();
  ui.click("scan-button");
  await until(() => readCount === 2);
  ui.click("cancel-scan-button");
  pending.resolve(snapshot({ files: [file()] }));
  await until(() => ui.el("cancel-scan-button").hidden);
  assert.match(ui.el("scan-status").textContent, /cancelled/);
  assert.match(ui.el("action-summary").textContent, /scan cancelled/i);
  assert.doesNotMatch(ui.el("action-summary").textContent, /ready to prepare/i);
  assert.equal(ui.el("download-button").disabled, true);
  assert.ok(ui.reads.some(message => message.type === "comma:cancel-read"));
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  assert.equal(ui.el("download-button").disabled, false);
  assert.match(ui.el("action-summary").textContent, /ready to prepare/i);
  assert.doesNotMatch(ui.el("action-summary").textContent, /cancelled/i);
});

for (const failure of [
  { label: "HTTP 503", error: new Error("File request failed (HTTP 503)."), detail: /503/ },
  { label: "storage quota", error: new DOMException("Temporary storage quota exceeded.", "QuotaExceededError"), detail: /quota/i }
]) {
  test(`${failure.label} preparation failure stays visible in the footer until a new build starts`, async () => {
    const retriedArchive = deferred();
    let attempts = 0;
    const ui = harness({ build: async () => {
      attempts += 1;
      if (attempts === 1) throw failure.error;
      return retriedArchive.promise;
    } });
    await ui.ready();
    await ui.scan();
    ui.click("download-button");
    await until(() => ui.builds.length === 1 && !ui.el("download-button").disabled, "failed ZIP preparation");
    assert.match(ui.el("transfer-detail").textContent, failure.detail);
    assert.match(ui.el("action-summary").textContent, /ZIP could not be prepared/);
    assert.doesNotMatch(ui.el("action-summary").textContent, /ready to prepare/i);
    assert.equal(ui.el("save-button").hidden, true);
    assert.equal(ui.el("save-button").hasAttribute("href"), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(ui.el("action-summary").textContent, /ZIP could not be prepared/, "idle updates must retain the failure");
    ui.click("download-button");
    await until(() => ui.builds.length === 2, "retry starts");
    assert.match(ui.el("action-summary").textContent, /preparing ZIP/i);
    assert.doesNotMatch(ui.el("action-summary").textContent, /could not|failed/i);
    retriedArchive.resolve({
      blob: new Blob(["retry archive"]), count: 1, filename: "retry.zip", bytes: 13,
      storage: "opfs", async dispose() {}
    });
    await until(() => !ui.el("save-button").hidden, "retry creates an archive");
    assert.match(ui.el("action-summary").textContent, /ready to save/i);
    assert.doesNotMatch(ui.el("action-summary").textContent, /could not|failed/i);
  });
}

test("changing file choices clears a quota failure before rescanning the new selection", async () => {
  const ui = harness({
    source: snapshot({ files: [file("0", "rlog"), file("0", "qlog")] }),
    build: async () => { throw new DOMException("Temporary storage quota exceeded.", "QuotaExceededError"); }
  });
  await ui.ready();
  await ui.scan();
  ui.click("download-button");
  await until(() => ui.builds.length === 1 && !ui.el("download-button").disabled);
  assert.match(ui.el("action-summary").textContent, /could not be prepared/);
  ui.choose("file-type", "qlog");
  ui.choose("file-type", "rlog", false);
  assert.doesNotMatch(ui.el("action-summary").textContent, /could not|failed|quota/i);
  assert.equal(ui.el("transfer-card").hidden, true);
  assert.equal(ui.el("download-button").disabled, true);
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  assert.match(ui.el("action-summary").textContent, /ready to prepare/i);
  assert.deepEqual(Array.from(ui.reads.at(-1).selectedTypes), ["qlog"]);
});

test("cancelled preparation remains visible in the footer until the source is refreshed", async () => {
  const ui = harness({ build: async (files, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Preparation cancelled.", "AbortError")), { once: true });
  }) });
  await ui.ready();
  await ui.scan();
  ui.click("download-button");
  await until(() => ui.builds.length === 1, "preparation begins");
  ui.click("stop-button");
  await until(() => !ui.el("download-button").disabled, "preparation cancellation");
  assert.equal(ui.builds[0].options.signal.aborted, true);
  assert.match(ui.el("action-summary").textContent, /preparation cancelled/i);
  assert.doesNotMatch(ui.el("action-summary").textContent, /ready to prepare/i);
  assert.equal(ui.el("save-button").hidden, true);
  assert.equal(ui.el("save-button").hasAttribute("href"), false);
  const previousReads = ui.reads.length;
  ui.click("check-source-button");
  await until(() => ui.reads.length > previousReads && !ui.el("scan-button").disabled, "source refresh");
  assert.doesNotMatch(ui.el("action-summary").textContent, /cancelled/i);
  assert.equal(ui.el("transfer-card").hidden, true);
  assert.equal(ui.el("download-button").disabled, true);
});

test("Save ZIP remains reusable until explicit clearing and never claims download completion", async () => {
  const ui = harness();
  await ui.ready();
  await ui.scan();
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden);
  const href = ui.el("save-button").href;
  assert.match(href, /^blob:/);
  assert.equal(ui.el("save-button").download, "synthetic-logs.zip");
  assert.equal(ui.el("download-button").disabled, true);
  ui.click("download-button");
  assert.equal(ui.builds.length, 1, "a ready ZIP should not be fetched again accidentally");
  ui.click("save-button");
  ui.click("save-button");
  assert.equal(ui.el("save-button").href, href);
  assert.equal(ui.revoked.length, 0);
  assert.match(ui.el("save-note").textContent, /cannot confirm/);
  ui.click("clear-button");
  await until(() => ui.disposed.length === 1);
  assert.deepEqual(ui.revoked, [href]);
  assert.equal(ui.el("save-button").hidden, true);
  assert.equal(ui.el("save-button").hasAttribute("href"), false);
});

test("clearing temporary storage keeps scanning and preparation disabled until cleanup finishes", async () => {
  const cleanup = deferred();
  const ui = harness({ build: async files => ({
    blob: new Blob(["test"]), filename: "test.zip", bytes: 4, count: files.length, storage: "opfs",
    dispose: () => cleanup.promise
  }) });
  await ui.ready();
  await ui.scan();
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden);
  ui.click("clear-button");
  assert.equal(ui.el("download-button").disabled, true);
  assert.equal(ui.el("scan-button").disabled, true);
  ui.click("download-button");
  assert.equal(ui.builds.length, 1);
  cleanup.resolve();
  await until(() => !ui.el("download-button").disabled);
  assert.equal(ui.el("scan-button").disabled, false);
});
