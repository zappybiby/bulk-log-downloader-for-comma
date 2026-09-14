/* Experimental early-body exit. Invented fixtures and loopback requests only. */
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");
const { Parser } = require("htmlparser2");
const { parseHTML } = require("linkedom");
const P = require("../../firefox/parser.js");

function metadataReader() {
  let tables = 0, target = 0, activeRow = false, cell = null, cells = [], rows = [];
  let done = false, value = null;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "table") {
        tables++;
        if (!target && attrs.id === "table_route5_route") target = tables;
      }
      if (!target || tables !== target || done) return;
      if (name === "tr") { activeRow = true; cells = []; }
      if (activeRow && (name === "td" || name === "th")) cell = "";
    },
    ontext(text) { if (cell !== null && !done) cell += text; },
    onclosetag(name) {
      if (done) return;
      if (target && tables === target) {
        if ((name === "td" || name === "th") && cell !== null) { cells.push(cell.trim()); cell = null; }
        if (name === "tr" && activeRow) { rows.push(cells); activeRow = false; }
        if (name === "table") {
          const starts = rows.filter(row => row[0] === "start_time");
          value = starts.length === 1 ? P.parseRouteUploadDate(starts[0][1]?.replace("T", " ")) : null;
          done = true;
        }
      }
      if (name === "table") tables--;
    }
  }, { decodeEntities: true });
  return { write(text) { if (!done) parser.write(text); }, end() { if (!done) parser.end(); }, get done() { return done; }, get date() { return value; } };
}

function domDate(html) {
  const table = parseHTML(html).document.querySelector("#table_route5_route");
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll("tr")).filter(row => row.closest("table") === table);
  const starts = rows.map(row => Array.from(row.children).map(cell => cell.textContent.trim())).filter(cells => cells[0] === "start_time");
  return starts.length === 1 ? P.parseRouteUploadDate(starts[0][1]?.replace("T", " ")) : null;
}

function metadata(date) {
  return `<table id="table_route5_route"><tbody><tr><td>create_time</td><td>1700000000</td></tr><tr><td>end_time</td><td>${date}T09:00:00</td></tr><tr><td>start_time</td><td>${date}T08:00:00</td></tr></tbody></table>`;
}

function parserChecks() {
  const cases = [
    metadata("2026-09-10"),
    metadata("2026-09-10").replace("start_time", "start&#95;time"),
    `<script>const x = '<table id="table_route5_route"><tr><td>start_time</td><td>2000-01-01T00:00:00</td></tr></table>';</script>${metadata("2026-09-10")}`,
    `<!-- ${metadata("2000-01-01")} -->${metadata("2026-09-10")}`,
    metadata("2026-02-30"),
    metadata("2026-09-10").replace("<tbody>", "<tbody><tr><td>start_time</td><td>2026-09-09T08:00:00</td></tr>"),
    `<table><tr><td>start_time</td><td>2000-01-01T00:00:00</td></tr></table>`,
    `<p>Sign in</p>`
  ];
  for (const html of cases) for (const chunkSize of [1, 7, 31, 4096]) {
    const reader = metadataReader();
    for (let offset = 0; offset < html.length; offset += chunkSize) reader.write(html.slice(offset, offset + chunkSize));
    reader.end();
    assert.equal(reader.date, domDate(html));
  }
  return { fixtures: cases.length, chunkSizes: [1, 7, 31, 4096], assertions: cases.length * 4,
    coverage: "normal table, entities, comments, script lookalike, invalid date, duplicate start field, missing target, sign-in",
    limitation: "This narrow tokenizer prototype is not a validated browser HTML5 parser or production replacement. Malformed/foster-parented/nested table recovery needs further equivalence tests." };
}

function makeHtml(id, sizeKiB, placement) {
  const date = id % 10 === 0 ? "2026-09-10" : "2026-08-01";
  let seed = id + 123;
  const token = () => Array.from({ length: 64 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[seed >>> 26]; }).join("");
  const rows = [];
  let bytes = 0;
  while (bytes < sizeKiB * 1024) {
    const row = `<a href="https://synthetic.invalid/route/${id}/segment/${rows.length}/rlog.zst?signature=${token()}">rlog.zst</a>\n`;
    rows.push(row); bytes += row.length;
  }
  const content = rows.join("");
  return `<!doctype html><meta charset="utf-8"><title>Synthetic route</title>${placement === "front" ? metadata(date) + content : content + metadata(date)}`;
}

async function main() {
  const checks = parserChecks(), count = 30, results = [];
  const profiles = [
    { name: "18KiB-paced-front", sizeKiB: 18, placement: "front", chunkBytes: 4096, pauseMs: 2, gzip: false },
    { name: "256KiB-paced-front", sizeKiB: 256, placement: "front", chunkBytes: 4096, pauseMs: 2, gzip: false },
    { name: "256KiB-gzip-paced-front", sizeKiB: 256, placement: "front", chunkBytes: 4096, pauseMs: 2, gzip: true },
    { name: "18KiB-gzip-buffered-front", sizeKiB: 18, placement: "front", chunkBytes: Infinity, pauseMs: 0, gzip: true },
    { name: "256KiB-paced-end", sizeKiB: 256, placement: "end", chunkBytes: 4096, pauseMs: 2, gzip: false }
  ];
  for (const profile of profiles) {
    const html = Array.from({ length: count }, (_, id) => makeHtml(id, profile.sizeKiB, profile.placement));
    const raw = html.map(text => Buffer.from(text));
    const bodies = raw.map(bytes => profile.gzip ? zlib.gzipSync(bytes) : bytes);
    let counters;
    const server = http.createServer((req, res) => {
      const id = Number(req.url.slice(1));
      if (!Number.isInteger(id) || id < 0 || id >= count) { res.writeHead(404); res.end(); return; }
      counters.requests++;
      counters.activeResponses++;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(profile.gzip ? { "Content-Encoding": "gzip" } : {}) });
      const body = bodies[id];
      let offset = 0, timer;
      res.on("close", () => { clearTimeout(timer); counters.activeResponses--; if (offset < body.length) counters.earlyCloses++; });
      function send() {
        if (res.destroyed) return;
        const end = Math.min(body.length, offset + profile.chunkBytes);
        counters.serverBytesWritten += end - offset;
        res.write(body.subarray(offset, end)); offset = end;
        if (offset === body.length) res.end();
        else timer = setTimeout(send, profile.pauseMs);
      }
      send();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const strategy of ["full-body-DOM", "stream-metadata-first"]) {
        counters = { requests: 0, serverBytesWritten: 0, earlyCloses: 0, activeResponses: 0 };
        const selected = [], begin = performance.now();
        let decodedBytesRead = 0, cancelledBodies = 0;
        for (let id = 0; id < count; id++) {
          const response = await fetch(`${origin}/${id}`);
          assert.equal(response.status, 200);
          if (strategy === "full-body-DOM") {
            const text = await response.text(); decodedBytesRead += Buffer.byteLength(text);
            if (domDate(text) === "2026-09-10") selected.push(id);
            continue;
          }
          const reader = response.body.getReader(), decoder = new TextDecoder(), metadata = metadataReader();
          const chunks = [];
          let cancelled = false;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            decodedBytesRead += value.byteLength;
            const text = decoder.decode(value, { stream: true }); chunks.push(text); metadata.write(text);
            // Only a recognized valid out-of-range date can justify early exit.
            // Unrecognized/ambiguous markup falls back to the full DOM path.
            if (metadata.done && metadata.date !== null && metadata.date !== "2026-09-10") {
              await reader.cancel(); cancelledBodies++; cancelled = true; break;
            }
          }
          if (!cancelled) {
            chunks.push(decoder.decode());
            const full = chunks.join("");
            assert.equal(full, html[id], "Selected/fallback response must retain its complete original HTML");
            if (domDate(full) === "2026-09-10") selected.push(id);
          }
        }
        const wallMs = Math.round(performance.now() - begin);
        const drainStart = performance.now();
        while (counters.activeResponses && performance.now() - drainStart < 2000) {
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        assert.equal(counters.activeResponses, 0, "All server responses must settle before byte counts are finalized");
        assert.deepEqual(selected, [0, 10, 20]);
        const result = { profile: profile.name, strategy, routes: count, matchedRoutes: selected.length,
          wallMs, serverDrainAfterClientMs: Math.round(performance.now() - drainStart), decodedBytesRead, ...counters, cancelledBodies, correctSelection: true };
        results.push(result);
        process.stderr.write(`${profile.name} ${strategy}: ${wallMs}ms, ${counters.serverBytesWritten} server bytes, correct\n`);
      }
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
  console.log(JSON.stringify({ kind: "measured-localhost-early-body-exit", node: process.version,
    assumptions: { routesPerCase: count, selectedFraction: 0.1, repetitions: 1, concurrency: 1,
      serverBytesWritten: "Application bytes handed to local HTTP response, compressed where stated; excludes transport overhead and can include bytes already buffered before cancellation.",
      scope: "Discovery and parsing only, no log-file downloads. Headers/RTT cost is unchanged. Local artificial chunk pacing does not establish real server buffering or Firefox cancellation behavior.",
      profiles: profiles.map(p => ({ ...p, chunkBytes: Number.isFinite(p.chunkBytes) ? p.chunkBytes : "entire response" })) },
    parserChecks: checks, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
