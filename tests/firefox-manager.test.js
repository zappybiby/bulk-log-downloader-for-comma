"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { setImmediate } = require("node:timers/promises");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "../firefox");

async function settle(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("manager did not reach the expected state");
}

async function manager(t, { undated = false, saved = {} } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "downloads.html"), "utf8"), {
    url: "https://extension.example/downloads.html?sourceTab=12", runScripts: "outside-only"
  });
  t.after(() => dom.window.close());
  const win = dom.window;
  const source = "https://useradmin.comma.ai/?onebox=0123456789abcdef";
  const route = "0123456789abcdef/00000001--abcdef01";
  const routeUrl = `https://useradmin.comma.ai/?onebox=${encodeURIComponent(route)}`;
  const deviceHtml = `<table id="table_routes"><tr><th>upload_time</th><th>route_name</th></tr>
    <tr><td>${undated ? "None" : "2026-09-24 00:00:00"}</td><td><a href="${routeUrl}">${route}</a></td></tr></table>`;
  const routeHtml = `<table id="table_route5_route"><tr><td>start_time</td><td>${undated ? "None" : "2026-09-23T23:59:59"}</td></tr></table>
    <a href="https://commadata2.blob.core.windows.net/logs/${route}/0/rlog.zst">rlog.zst</a>`;
  win.browser = {
    storage: { local: {
      get: async () => ({ firefoxPreferences: { scope: "listed", dateBasis: "recording",
        date: { mode: "custom", from: "2026-09-23", to: "2026-09-23" }, ...saved } }),
      set: async () => {}
    } },
    tabs: { sendMessage: async (_id, request) => {
      const url = request.url || source;
      assert.ok([source, routeUrl].includes(url));
      return win.CommaParser.snapshot(new win.DOMParser().parseFromString(url === source ? deviceHtml : routeHtml, "text/html"),
        url, request.selectedTypes, { recordingFilter: request.recordingFilter });
    } }
  };
  for (const script of ["parser.js", "scanner.js", "downloads.js"]) win.eval(fs.readFileSync(path.join(root, script), "utf8"));
  const el = id => win.document.getElementById(id);
  await settle(() => !el("scan-button").disabled);
  return { win, el, scan: async () => {
    el("scan-button").click();
    await settle(() => el("scan-status").textContent === "Scan complete");
  } };
}

test("switching Recorded/Uploaded invalidates old results and applies the selected basis", async t => {
  const { win, el, scan } = await manager(t);
  await scan();
  assert.equal(el("file-count").textContent, "1");
  assert.match(el("file-preview").textContent, /Recorded 2026-09-23/);
  assert.equal(el("selection-title").textContent, "Recorded · Custom range");
  el("edit-filters-button").click();
  win.document.querySelector('input[name="date-basis"][value="upload"]').click();
  assert.equal(el("review-button").hidden, true);
  assert.equal(el("download-button").disabled, true);
  await scan();
  assert.equal(el("file-count").textContent, "0");
  assert.equal(el("selection-title").textContent, "Uploaded · Custom range");
  el("edit-filters-button").click();
  for (const id of ["date-from", "date-to"]) {
    el(id).value = "2026-09-24";
    el(id).dispatchEvent(new win.Event("input", { bubbles: true }));
  }
  await scan();
  assert.equal(el("file-count").textContent, "1");
  assert.match(el("file-preview").textContent, /Uploaded 2026-09-24/);
  assert.equal(el("selection-range").textContent, "2026-09-24 → 2026-09-24");
});

for (const dateBasis of ["recording", "upload"]) {
  test(`${dateBasis}: All dates does not show a false skipped-route notice`, async t => {
    const { el, scan } = await manager(t, { undated: true, saved: { dateBasis, date: { mode: "all" } } });
    await scan();
    assert.equal(el("file-count").textContent, "1");
    assert.doesNotMatch(el("scan-detail").textContent, /skipped/);
    assert.match(el("file-preview").textContent, /date unavailable/);
  });
}

test("legacy preferences without a date basis retain Uploaded semantics", async t => {
  const { win } = await manager(t, { saved: { dateBasis: undefined } });
  assert.equal(win.document.querySelector('input[name="date-basis"]:checked').value, "upload");
});
