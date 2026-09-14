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

function file(segment = "0", type = "rlog", route = "11111111--abc") {
  const name = `demo_${route}--${segment}--${type}.zst`;
  return {
    url: `https://commadata2.blob.core.windows.net/demo/${route}/${segment}/${type}.zst?sig=synthetic`,
    name, routeFolderName: `demo__${route}`, typeFolderName: type, typeKey: type,
    targetPath: `demo__${route}/${type}/${name}`
  };
}

function snapshot({ url = SOURCE, files = [], routes = [], nextPageUrl = "", pageKind = "route" } = {}) {
  return { url, title: "Synthetic test route", files, routes, nextPageUrl, pageKind };
}

function route(key, date = "2026-09-10") {
  return {
    key, name: `demo/${key}`, url: `${SOURCE}|${key}`,
    uploadedAt: date ? new Date(`${date}T12:00:00`).getTime() : null
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
    browser, CommaParser, CommaArchive, URL: TestURL, AbortController, DOMException,
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
  async function ready() { await until(() => el("source-indicator").classList.contains("connected") || el("source-title").textContent === "Source page unavailable", "initial source check"); }
  async function scan() {
    click("scan-button");
    await until(() => el("cancel-scan-button").hidden, "scan completion");
  }
  return { document, window, el, click, choose, ready, scan, reads, builds, revoked, saves, disposed };
}

test("missing source tab shows recovery instructions and prevents scanning", async () => {
  const ui = harness({ sourceTab: null });
  await ui.ready();
  assert.match(ui.el("page-notice").textContent, /Open a device or route page/);
  assert.equal(ui.el("scan-button").disabled, true);
  assert.equal(ui.reads.length, 0);
});

test("qlog-only route reports no matching rlogs, then prepares selected qlogs", async () => {
  const ui = harness({ source: snapshot({ files: [file("0", "qlog"), file("1", "qlog")] }) });
  await ui.ready();
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "0");
  assert.match(ui.el("scan-detail").textContent, /Try qlog/);
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
  const ui = harness({
    preferences: { scope: "listed", date: { mode: "all" } },
    read(message) {
      if (!message.url) return snapshot({ routes: [one, two], pageKind: "device" });
      if (message.url === one.url) return snapshot({ url: one.url, files: [file()] });
      return { error: "Page read failed (HTTP 503)." };
    }
  });
  await ui.ready();
  await ui.scan();
  assert.match(ui.el("scan-status").textContent, /503/);
  assert.equal(ui.el("results-content").hidden, true);
  assert.equal(ui.el("download-button").disabled, true);
  ui.click("download-button");
  assert.equal(ui.builds.length, 0);
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
  assert.equal(ui.el("download-button").disabled, true);
  assert.ok(ui.reads.some(message => message.type === "comma:cancel-read"));
  await ui.scan();
  assert.equal(ui.el("file-count").textContent, "1");
  assert.equal(ui.el("download-button").disabled, false);
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
