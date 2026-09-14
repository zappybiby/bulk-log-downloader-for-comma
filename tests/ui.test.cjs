"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");
const { parseHTML } = require("linkedom");
const CommaParser = require("../firefox/parser.js");
const CommaScanner = require("../firefox/scanner.js");

const UI_DIR = path.join(__dirname, "../firefox");
const html = fs.readFileSync(path.join(UI_DIR, "downloads.html"), "utf8");
const script = fs.readFileSync(path.join(UI_DIR, "downloads.js"), "utf8");
const SOURCE = "https://useradmin.comma.ai/?onebox=demo-device";
const TODAY = "2026-09-14";
const FROZEN_NOW = new Date(2026, 8, 14, 12, 0, 0).getTime();

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

function harness({ source = snapshot({ files: [file()] }), sourceTab = "42", read, build, preferences = { dateBasis: "upload" } } = {}) {
  const { document, window } = parseHTML(html);
  let currentTime = FROZEN_NOW;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  function setNow(value) {
    assert.ok(value instanceof Date && Number.isFinite(value.getTime()), "test clock requires a valid Date");
    currentTime = value.getTime();
  }
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
    CommaArchive, CommaScanner, URL: TestURL, Date: TestDate, AbortController, DOMException,
    crypto: webcrypto, addEventListener: window.addEventListener.bind(window)
  });
  vm.runInContext(script, context, { filename: "downloads.js" });
  const el = id => document.getElementById(id);
  const dispatchClick = id => el(id).dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  function openSettings() {
    if (el("settings-form").hidden) dispatchClick("edit-filters-button");
    assert.equal(el("settings-form").hidden, false, "settings interactions require the choose screen");
  }
  function click(id) {
    if (id.startsWith("date-preset-") || id === "edit-days-button") openSettings();
    return dispatchClick(id);
  }
  function choose(name, value, checked = true) {
    openSettings();
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
    const disclosure = input.closest("details");
    if (disclosure) disclosure.open = true;
    input.checked = checked;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  function input(id, value) {
    openSettings();
    if (id === "date-days" && el("recent-settings").hidden) dispatchClick("edit-days-button");
    if ((id === "date-from" || id === "date-to") && el("custom-settings").hidden) dispatchClick("date-preset-custom");
    el(id).value = value;
    el(id).dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  async function ready() { await until(() => el("source-indicator").classList.contains("connected") || el("source-title").textContent === "Source page unavailable", "initial source check"); }
  async function scan() {
    if (el("scan-button").hidden) openSettings();
    click("scan-button");
    await until(() => el("cancel-scan-button").hidden, "scan completion");
  }
  return { document, window, el, click, choose, input, ready, scan, setNow, reads, builds, revoked, saves, disposed };
}

function listedHarness(routes, options = {}) {
  return harness({
    ...options,
    read(message) {
      if (message.type === "comma:cancel-read") return { cancelled: true };
      if (!message.url || message.url === SOURCE) return snapshot({ routes, pageKind: "device" });
      const match = routes.find(item => item.url === message.url);
      assert.ok(match, "Only a listed route may be read");
      return snapshot({ url: match.url, files: [file("0", "rlog", match.key)] });
    }
  });
}

function recordedSnapshot(message, item, startTime) {
  const log = file("0", "rlog", item.key);
  const { document } = parseHTML(`<html><head><title>Invented route metadata</title></head><body>
    <table id="table_route5_route">
      ${startTime === null ? "" : `<tr><th>start_time</th><td>${startTime}</td></tr>`}
      <tr><th>create_time</th><td>2026-09-14T23:00:00</td></tr>
    </table>
    <a href="${log.url}">rlog.zst</a>
  </body></html>`);
  return CommaParser.snapshot(document, item.url, message.selectedTypes, { recordingFilter: message.recordingFilter });
}

function selectedMode(ui) {
  return ui.document.querySelector('input[name="date-mode"]:checked')?.value;
}

function fetchedRoutes(ui) {
  return ui.reads.filter(message => message.type === "comma:read" && message.url?.includes("|")).map(message => message.url);
}

test("missing source tab shows recovery instructions and prevents scanning", async () => {
  const ui = harness({ sourceTab: null });
  await ui.ready();
  assert.match(ui.el("page-notice").textContent, /Open a device or route page/);
  assert.equal(ui.el("scan-button").disabled, true);
  assert.equal(ui.reads.length, 0);
});

test("choose screen hides the empty review and scanning opens review with a frozen selection summary", async () => {
  const pending = deferred();
  const item = route("11111111--aaa", TODAY);
  let routeReadStarted = false;
  const ui = harness({ read(message) {
    if (!message.url || message.url === SOURCE) return snapshot({ routes: [item], pageKind: "device" });
    routeReadStarted = true;
    return pending.promise;
  } });
  await ui.ready();
  assert.equal(ui.el("settings-form").hidden, false);
  assert.equal(ui.el("review-panel").hidden, true);
  assert.equal(ui.el("review-button").hidden, true);
  assert.equal(ui.el("recent-settings").hidden, true, "a standard preset does not need a second days input");
  ui.document.querySelector("main").scrollTop = 160;
  ui.click("scan-button");
  assert.equal(ui.el("settings-form").hidden, true);
  assert.equal(ui.el("review-panel").hidden, false);
  assert.equal(ui.document.querySelector("main").scrollTop, 0);
  assert.equal(ui.el("edit-filters-button").disabled, true, "an active scan must not be edited");
  assert.match(ui.el("selection-summary").textContent, /Device routes/i);
  assert.match(ui.el("selection-summary").textContent, /Uploaded/i);
  assert.match(ui.el("selection-summary").textContent, /2026-09-08/);
  assert.match(ui.el("selection-summary").textContent, /2026-09-14/);
  assert.match(ui.el("selection-summary").textContent, /rlog/);
  await until(() => routeReadStarted);
  ui.setNow(new Date(2026, 8, 15, 0, 0, 1));
  pending.resolve(snapshot({ url: item.url, files: [file("0", "rlog", item.key)] }));
  await until(() => ui.el("cancel-scan-button").hidden);
  assert.equal(ui.el("edit-filters-button").disabled, false);
  assert.match(ui.el("selection-summary").textContent, /2026-09-08/);
  assert.match(ui.el("selection-summary").textContent, /2026-09-14/);
  assert.doesNotMatch(ui.el("selection-summary").textContent, /2026-09-15/, "review must describe the scan's exact dates after midnight");
});

test("Edit and Back to results preserve files and a prepared ZIP until a setting changes", async () => {
  const ui = listedHarness([route("11111111--aaa", TODAY)]);
  await ui.ready();
  await ui.scan();
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden);
  const href = ui.el("save-button").href;
  const previousReads = ui.reads.length;
  ui.document.querySelector("main").scrollTop = 240;
  ui.click("edit-filters-button");
  assert.equal(ui.el("settings-form").hidden, false);
  assert.equal(ui.el("review-panel").hidden, true);
  assert.equal(ui.document.querySelector("main").scrollTop, 0);
  assert.equal(ui.el("scan-button").hidden, false, "choose screen can start a fresh scan without changing a setting");
  assert.equal(ui.el("scan-button").disabled, false);
  assert.equal(ui.el("review-button").hidden, false);
  assert.equal(ui.el("save-button").hidden, true);
  assert.equal(ui.el("save-button").href, href);
  assert.equal(ui.revoked.length, 0);
  assert.equal(ui.disposed.length, 0);
  assert.equal(ui.el("date-preset-7").getAttribute("aria-pressed"), "true");
  ui.click("date-preset-7");
  assert.equal(ui.el("save-button").href, href, "reselecting the current preset preserves the prepared ZIP");
  assert.equal(ui.el("review-button").hidden, false);
  assert.equal(ui.revoked.length, 0);
  assert.equal(ui.disposed.length, 0);
  ui.click("review-button");
  assert.equal(ui.el("settings-form").hidden, true);
  assert.equal(ui.el("review-panel").hidden, false);
  assert.equal(ui.el("save-button").hidden, false);
  assert.equal(ui.el("save-button").href, href);
  assert.equal(ui.reads.length, previousReads, "returning to review does not reread routes");
  assert.equal(ui.builds.length, 1, "returning to review does not rebuild the ZIP");
  ui.click("edit-filters-button");
  ui.choose("file-type", "qlog");
  await until(() => ui.disposed.length === 1);
  assert.deepEqual(ui.revoked, [href]);
  assert.equal(ui.el("save-button").hasAttribute("href"), false);
  assert.equal(ui.el("download-button").disabled, true);
  assert.equal(ui.el("review-button").hidden, true, "changed settings cannot return to stale results");
});

test("preset days stay compact and the explicit days editor supports arbitrary ranges", async () => {
  const ui = listedHarness([route("11111111--aaa", TODAY)]);
  await ui.ready();
  for (const days of [1, 7, 30]) {
    ui.click(`date-preset-${days}`);
    assert.equal(ui.el("recent-settings").hidden, true);
    assert.equal(ui.el("custom-settings").hidden, true);
    assert.equal(ui.el(`date-preset-${days}`).getAttribute("aria-pressed"), "true");
  }
  ui.click("date-preset-custom");
  assert.equal(ui.el("custom-settings").hidden, false);
  ui.click("edit-days-button");
  assert.equal(selectedMode(ui), "recent");
  assert.equal(ui.el("recent-settings").hidden, false);
  assert.equal(ui.el("custom-settings").hidden, true);
  ui.input("date-days", "9");
  assert.match(ui.el("date-summary").textContent, /2026-09-06/);
  assert.match(ui.el("date-summary").textContent, /2026-09-14/);
  ui.click("date-preset-7");
  assert.equal(ui.el("recent-settings").hidden, true, "choosing a preset closes the optional editor again");
});

test("saved arbitrary days reopen their editor and saved custom dates reopen only their fields", async () => {
  const recent = listedHarness([route("11111111--aaa", TODAY)], {
    preferences: { dateBasis: "upload", date: { mode: "recent", days: "19" } }
  });
  await recent.ready();
  assert.equal(selectedMode(recent), "recent");
  assert.equal(recent.el("date-days").value, "19");
  assert.equal(recent.el("recent-settings").hidden, false);
  assert.equal(recent.el("custom-settings").hidden, true);
  assert.match(recent.el("date-summary").textContent, /2026-08-27/);
  const custom = listedHarness([route("11111111--aaa", TODAY)], {
    preferences: { dateBasis: "upload", date: { mode: "custom", from: "2026-09-10", to: "2026-09-12" } }
  });
  await custom.ready();
  assert.equal(selectedMode(custom), "custom");
  assert.equal(custom.el("recent-settings").hidden, true);
  assert.equal(custom.el("custom-settings").hidden, false);
  assert.equal(custom.el("date-from").value, "2026-09-10");
  assert.equal(custom.el("date-to").value, "2026-09-12");
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

test("new installs default to recording dates while pre-existing saved ranges retain upload dates", async () => {
  const fresh = listedHarness([route("11111111--aaa", TODAY)], { preferences: null });
  await fresh.ready();
  assert.equal(fresh.document.querySelector('input[name="date-basis"]:checked').value, "recording");
  assert.match(fresh.el("date-explanation").textContent, /recording/i);
  const upgraded = listedHarness([route("11111111--aaa", TODAY)], { preferences: { date: { mode: "recent", days: "7" } } });
  await upgraded.ready();
  assert.equal(upgraded.document.querySelector('input[name="date-basis"]:checked').value, "upload");
  await upgraded.scan();
  assert.equal(upgraded.el("file-count").textContent, "1");
});

test("changing Recorded or Uploaded invalidates the previous selection and persists only the choice", async () => {
  const ui = listedHarness([route("11111111--aaa", TODAY)]);
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("download-button").disabled, false);
  ui.choose("date-basis", "recording");
  assert.equal(ui.el("download-button").disabled, true);
  assert.equal(ui.el("results-content").hidden, true);
  assert.equal(ui.saves.at(-1).firefoxPreferences.dateBasis, "recording");
  assert.ok(ui.saves.every(saved => !JSON.stringify(saved).includes("demo-device")), "saved settings must not become a metadata cache");
});

test("recording selection displays the actual start date and never substitutes upload, create time, or route ID", async () => {
  const recordedToday = route("11111111--aaa", "2026-01-01");
  const oldRecording = route("22222222--bbb", TODAY);
  const unknownRecording = route("2026-09-14--10-00-00", TODAY);
  const routes = [recordedToday, oldRecording, unknownRecording];
  const dates = new Map([[recordedToday.key, "2026-09-14T09:00:00"], [oldRecording.key, "2026-01-01T09:00:00"], [unknownRecording.key, null]]);
  const ui = harness({
    preferences: { dateBasis: "recording" },
    read(message) {
      if (message.type === "comma:cancel-read") return { cancelled: true };
      if (!message.url || message.url === SOURCE) return snapshot({ routes, pageKind: "device" });
      const item = routes.find(candidate => candidate.url === message.url);
      assert.ok(item, "only enumerated routes are read");
      return recordedSnapshot(message, item, dates.get(item.key));
    }
  });
  await ui.ready();
  ui.click("date-preset-1");
  await ui.scan();
  assert.deepEqual(fetchedRoutes(ui), routes.map(item => item.url), "upload dates must not shortcut a recording-date scan");
  assert.equal(ui.el("file-count").textContent, "1");
  assert.match(ui.el("file-preview").querySelector("summary").textContent, /Recorded 2026-09-14/);
  assert.doesNotMatch(ui.el("file-preview").querySelector("summary").textContent, /Uploaded/);
  assert.equal(ui.el("scan-detail").textContent, "1 route skipped · recording date unavailable");
});

test("a second recording scan rereads excluded routes and discovers an upstream corrected date", async () => {
  const item = route("11111111--aaa", "2026-01-01");
  let startTime = "2026-01-01T09:00:00";
  const ui = harness({
    preferences: { dateBasis: "recording" },
    read(message) {
      if (message.type === "comma:cancel-read") return { cancelled: true };
      if (!message.url || message.url === SOURCE) return snapshot({ routes: [item], pageKind: "device" });
      assert.equal(message.url, item.url);
      return recordedSnapshot(message, item, startTime);
    }
  });
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "0");
  startTime = "2026-09-14T09:00:00";
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  assert.equal(ui.reads.filter(message => message.url === SOURCE).length, 2, "each scan rereads the route catalog");
  assert.deepEqual(fetchedRoutes(ui), [item.url, item.url], "even previously excluded routes must be read again");
  assert.match(ui.el("file-preview").querySelector("summary").textContent, /Recorded 2026-09-14/);
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

test("a tab kept overnight displays the exact new scan range and holds it fixed during that scan", async () => {
  const expired = route("11111111--aaa", "2026-09-08");
  const first = route("22222222--bbb", "2026-09-09");
  const today = route("33333333--ccc", "2026-09-15");
  const later = route("44444444--ddd", "2026-09-16");
  const ui = listedHarness([expired, first, today, later]);
  await ui.ready();
  assert.equal(ui.el("date-summary").textContent, "2026-09-08 → 2026-09-14");
  ui.setNow(new Date(2026, 8, 15, 23, 59, 59));
  ui.click("scan-button");
  assert.equal(ui.el("date-summary").textContent, "2026-09-09 → 2026-09-15");
  ui.setNow(new Date(2026, 8, 16, 0, 0, 1));
  await until(() => ui.el("cancel-scan-button").hidden, "scan completion after midnight");
  assert.deepEqual(fetchedRoutes(ui), [first.url, today.url]);
  assert.equal(ui.el("file-count").textContent, "2");
  assert.equal(ui.el("date-summary").textContent, "2026-09-09 → 2026-09-15", "displayed dates must still describe the collected files");
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
      if (!message.url || message.url === SOURCE) return parsed;
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
      if (!message.url || message.url === sourceUrl) return snapshot({ url: sourceUrl, files: [file()], deviceUrl: SOURCE });
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
  assert.deepEqual(ui.reads.filter(message => message.type === "comma:read" && message.url).map(message => message.url), [sourceUrl, SOURCE, selected.url]);
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
    if (!message.url || message.url === SOURCE) return snapshot({ routes: [one, two], pageKind: "device" });
    const item = [one, two].find(candidate => candidate.url === message.url);
    return snapshot({ url: item.url, files: [file("0", "rlog", item.key), file("1", "rlog", item.key)] });
  } });
  const primary = () => ["scan-button", "download-button", "save-button"].filter(id => !ui.el(id).hidden);
  await ui.ready();
  assert.deepEqual(primary(), ["scan-button"]);
  await ui.scan();
  assert.deepEqual(primary(), ["download-button"]);
  assert.equal(ui.el("file-count").textContent, "4");
  assert.equal(ui.el("routes-disclosure").hasAttribute("open"), false, "route details should not consume review space until requested");
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

test("route details reveal ten at a time while the ZIP still includes every selected route", async t => {
  const routes = Array.from({ length: 25 }, (_, index) => route(`${String(index + 1).padStart(8, "0")}--abc`, TODAY));
  const ui = listedHarness(routes);
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "25");
  assert.equal(ui.el("route-count").textContent, "25 routes");
  const disclosure = ui.el("routes-disclosure");
  assert.equal(disclosure.hidden, false);
  assert.equal(disclosure.hasAttribute("open"), false);
  disclosure.open = true;
  disclosure.dispatchEvent(new ui.window.Event("toggle"));
  const visibleGroups = () => Array.from(ui.el("file-preview").querySelectorAll("details.route-group"))
    .filter(group => !group.hidden && !group.closest("li").hidden);
  assert.equal(visibleGroups().length, 10);
  assert.equal(ui.el("show-more-routes-button").hidden, false);
  for (const group of visibleGroups()) {
    const heading = group.querySelector(".route-heading");
    assert.equal(heading.firstElementChild.className, "route-date", "the useful date precedes the route identifier");
    assert.match(heading.firstElementChild.textContent, /2026-09-14/);
  }
  const focused = [];
  t.mock.method(ui.window.HTMLElement.prototype, "focus", function () { focused.push(this); });
  ui.click("show-more-routes-button");
  assert.equal(visibleGroups().length, 20);
  assert.equal(focused.at(-1), visibleGroups()[10].querySelector("summary"), "focus continues at the first newly revealed route");
  ui.click("show-more-routes-button");
  assert.equal(visibleGroups().length, 25);
  assert.equal(focused.at(-1), visibleGroups()[20].querySelector("summary"), "the final batch retains focus when Show more disappears");
  assert.equal(ui.el("show-more-routes-button").hidden, true);
  ui.click("download-button");
  await until(() => !ui.el("save-button").hidden);
  assert.equal(ui.builds[0].files.length, 25, "progressive disclosure must never truncate archive contents");
  assert.equal(new Set(ui.builds[0].files.map(item => item.routeFolderName)).size, 25);
});

test("qlog-only route reports no matching rlogs, then prepares selected qlogs", async () => {
  const ui = harness({ source: snapshot({ files: [file("0", "qlog"), file("1", "qlog")] }) });
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "0");
  assert.equal(ui.el("scan-detail").textContent, "No matching files. Try another file type.");
  assert.equal(ui.el("download-button").disabled, true);
  assert.equal(ui.el("review-panel").hidden, false);
  assert.equal(ui.el("settings-form").hidden, true);
  assert.equal(ui.el("edit-filters-button").disabled, false);
  assert.equal(ui.el("scan-button").hidden, false, "an empty result can be retried directly");
  ui.click("edit-filters-button");
  assert.equal(ui.el("settings-form").hidden, false);
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
      if (!message.url || message.url === SOURCE) return first;
      if (message.url === nextUrl) return snapshot({ url: nextUrl, routes: [recent, recent, undated], pageKind: "route-list" });
      if (message.url === recent.url) return snapshot({ url: recent.url, files: [file(), file()] });
      assert.fail("Out-of-range routes should not be fetched");
    }
  });
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  assert.equal(ui.el("scan-detail").textContent, "1 route skipped · upload date unavailable");
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
      if (!message.url || message.url === SOURCE) return snapshot({ routes: [one, two], pageKind: "device" });
      if (message.url === one.url) return snapshot({ url: one.url, files: [file()] });
      return failRouteRead ? { error: "Page read failed (HTTP 503)." }
        : snapshot({ url: two.url, files: [file("0", "rlog", two.key)] });
    }
  });
  await ui.ready();
  await ui.scan();
  assert.match(ui.el("scan-status").textContent, /503/);
  assert.equal(ui.el("review-panel").hidden, false, "a failed scan stays on its visible status screen");
  assert.equal(ui.el("settings-form").hidden, true);
  assert.equal(ui.el("edit-filters-button").disabled, false);
  assert.equal(ui.el("scan-button").hidden, false, "the review screen exposes a fresh retry after failure");
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
  assert.equal(ui.el("review-panel").hidden, false);
  assert.equal(ui.el("edit-filters-button").disabled, false);
  assert.equal(ui.el("scan-button").hidden, false);
  ui.click("edit-filters-button");
  assert.equal(ui.el("settings-form").hidden, false);
  assert.equal(ui.el("review-button").hidden, false, "a cancelled scan can still be reviewed without rerunning it");
  ui.click("review-button");
  assert.equal(ui.el("review-panel").hidden, false);
  assert.match(ui.el("scan-status").textContent, /cancelled/);
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
  assert.equal(ui.el("transfer-status").textContent, "Save requested");
  ui.click("clear-button");
  await until(() => ui.disposed.length === 1 && !ui.el("download-button").disabled, "ZIP cleanup completion");
  assert.deepEqual(ui.revoked, [href]);
  assert.equal(ui.el("save-button").hidden, true);
  assert.equal(ui.el("save-button").hasAttribute("href"), false);
  assert.equal(ui.el("review-panel").hidden, false, "clearing a ZIP keeps the selected files in review");
  assert.equal(ui.el("file-count").textContent, "1");
  assert.equal(ui.el("download-button").hidden, false);
  assert.equal(ui.el("download-button").disabled, false);
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
