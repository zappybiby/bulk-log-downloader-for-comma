"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const archive = require("../firefox/archive.js");

const MiB = 1024 * 1024;
const sourceUrl = index => `https://commadata2.blob.core.windows.net/synthetic/route/${index}/rlog.zst?sig=SYNTHETIC-SECRET`;
const file = (index = 0, targetPath = `synthetic-route/rlog/${index}.zst`) => ({ url: sourceUrl(index), targetPath });
const codeIs = code => error => error.code === code && !error.message.includes("SYNTHETIC-SECRET");

function dataFor(index, size) {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = (offset * 31 + index * 17 + (offset >> 8)) & 255;
  return bytes;
}

function streamedResponse(data, options = {}) {
  let cursor = 0;
  const chunkSize = options.chunkSize || 8191;
  return new Response(new ReadableStream({
    pull(controller) {
      if (cursor === data.length) { controller.close(); return; }
      const end = Math.min(cursor + chunkSize, data.length);
      controller.enqueue(data.subarray(cursor, end));
      cursor = end;
    },
    cancel: options.cancel
  }), { status: options.status || 200, headers: options.headers });
}

function mockStorage(settings = {}) {
  const directories = new Map([["another-tab-archive", { external: true }]]);
  const removed = [];
  let writes = 0;
  let closes = 0;
  let aborts = 0;
  return {
    directories, removed,
    get writes() { return writes; },
    get closes() { return closes; },
    get aborts() { return aborts; },
    async getDirectoryHandle(name) {
      if (settings.initError) throw settings.initError;
      const state = { chunks: [], closed: false };
      directories.set(name, state);
      return {
        async getFileHandle() {
          return {
            createWritable: settings.noWriter ? undefined : async () => ({
              async write(bytes) {
                writes++;
                if (settings.failWriteAt === writes) throw settings.writeError || new Error("Write failed");
                state.chunks.push(bytes.slice());
              },
              async close() { closes++; state.closed = true; },
              async abort() { aborts++; state.chunks = []; }
            }),
            async getFile() {
              assert.equal(state.closed, true, "ZIP must be closed before it is exposed");
              if (settings.getFileError) throw settings.getFileError;
              return new Blob(state.chunks, { type: "application/zip" });
            }
          };
        }
      };
    },
    async removeEntry(name) {
      removed.push(name);
      assert.notEqual(name, "another-tab-archive", "Never delete another tab's archive");
      directories.delete(name);
    }
  };
}

async function verifyWithPython(result, expected) {
  const directory = await fs.mkdtemp(path.join(__dirname, ".archive-fixture-"));
  try {
    const zipPath = path.join(directory, "synthetic.zip");
    const manifestPath = path.join(directory, "expected.json");
    await fs.writeFile(zipPath, new Uint8Array(await result.blob.arrayBuffer()));
    await fs.writeFile(manifestPath, JSON.stringify(expected));
    const verified = spawnSync("python3", [path.join(__dirname, "verify-archive.py"), zipPath, manifestPath], { encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.match(verified.stdout, /SHA-256 hashes/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const storage of ["memory", "opfs"]) {
  test(`${storage}: 120 streamed binary logs plus UTF-8 and empty entries round-trip through Python zipfile`, async () => {
    const root = storage === "opfs" ? mockStorage() : null;
    const files = Array.from({ length: 120 }, (_, index) => file(index));
    files.push(file(120, "synthetic-route/qlog/café-測試.zst"));
    files.push(file(121, "synthetic-route/qlog/empty.zst"));
    const expected = {};
    let expectedBytes = 0;
    let latest;
    let requests = 0;
    const result = await archive.build(files, {
      storageRoot: root,
      maxBytes: 16 * MiB,
      fetchFile: async (url, { signal }) => {
        assert.equal(signal.aborted, false);
        const index = Number(new URL(url).pathname.split("/").at(-2));
        const bytes = dataFor(index, index === 121 ? 0 : index === 120 ? 513 : 64 * 1024);
        expected[files[index].targetPath] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        expectedBytes += bytes.length;
        requests++;
        return streamedResponse(bytes);
      },
      onProgress(value) {
        if (latest) {
          assert.ok(value.bytesReceived >= latest.bytesReceived);
          assert.ok(value.filesDone >= latest.filesDone);
        }
        assert.equal(value.filesTotal, files.length);
        assert.equal(value.storage, storage);
        latest = value;
      }
    });
    assert.equal(requests, files.length);
    assert.equal(result.storage, storage);
    assert.equal(result.count, files.length);
    assert.equal(result.bytes, result.blob.size);
    assert.equal(latest.bytesReceived, expectedBytes);
    assert.equal(latest.filesDone, files.length);
    assert.equal(latest.archiveBytes, result.bytes);
    assert.equal(latest.currentFile, "");
    assert.match(result.filename, /^comma-logs-[\w-]+\.zip$/);
    if (root) {
      assert.equal(root.closes, 1);
      assert.equal(root.directories.size, 2, "Successful output remains available for the user to save");
    }
    await verifyWithPython(result, expected);
    await result.dispose();
    await result.dispose();
    if (root) {
      assert.equal(root.directories.size, 1);
      assert.equal(root.removed.length, 1, "Disposal is idempotent");
    }
  });
}

test("input validation rejects unsafe paths, unsupported hosts, duplicates, and invalid ZIP limits before fetching", async () => {
  let calls = 0;
  const options = { storageRoot: null, fetchFile: async () => { calls++; return new Response("unused"); } };
  for (const targetPath of ["../secret", "/absolute", "C:/log", "a/../log", "a//log", "a/./log", "a\\log", "a/\u0000log", "a/NUL.txt", "a/log.", "a/log ", "a/" + "x".repeat(256)]) {
    await assert.rejects(archive.build([file(0, targetPath)], options), codeIs("UNSAFE_PATH"));
  }
  for (const url of [
    "http://commadata2.blob.core.windows.net/file", "https://other.blob.core.windows.net/file",
    "https://commadata2.blob.core.windows.net.evil.invalid/file", "https://evil.invalid/file",
    "https://user:pass@commadata2.blob.core.windows.net/file", "https://commadata2.blob.core.windows.net:443/file",
    "https://commadata2.blob.core.windows.net\\@evil.invalid/file", "https://commadata2.blob.core.windows.net/\nfile",
    " https://commadata2.blob.core.windows.net/file", "/relative", "javascript:alert(1)"
  ]) await assert.rejects(archive.build([{ ...file(), url }], options), codeIs("UNSUPPORTED_URL"));
  await assert.rejects(archive.build([], options), codeIs("EMPTY_INPUT"));
  await assert.rejects(archive.build([file(), file()], options), codeIs("DUPLICATE_PATH"));
  await assert.rejects(archive.build(Array(65536).fill(file()), options), codeIs("ENTRY_LIMIT"));
  for (const maxBytes of [0, -1, 1.5, Infinity, NaN, 512 * MiB + 1, "1024"]) {
    await assert.rejects(archive.build([file()], { ...options, maxBytes }), codeIs("INVALID_LIMIT"));
  }
  assert.equal(calls, 0);
});

test("size guard includes metadata and central directory; an exact-size archive succeeds", async () => {
  const bytes = dataFor(0, 1000);
  const options = { storageRoot: null, fetchFile: async () => streamedResponse(bytes) };
  const baseline = await archive.build([file()], options);
  await assert.rejects(archive.build([file()], { ...options, maxBytes: baseline.bytes - 1 }), codeIs("SIZE_LIMIT"));
  const exact = await archive.build([file()], { ...options, maxBytes: baseline.bytes });
  assert.equal(exact.bytes, baseline.bytes);
  let fetched = false;
  await assert.rejects(archive.build([file()], { ...options, maxBytes: 1, fetchFile: async () => { fetched = true; } }), codeIs("SIZE_LIMIT"));
  assert.equal(fetched, false, "Reject metadata that cannot fit before starting transfers");
  await baseline.dispose();
  await exact.dispose();
});

test("content-length and unannounced oversize streams are rejected and cancelled", async () => {
  for (const headers of [{ "content-length": "5000" }, undefined]) {
    const root = mockStorage();
    let wasCancelled = false;
    await assert.rejects(archive.build([file()], {
      storageRoot: root,
      maxBytes: 2048,
      fetchFile: async () => streamedResponse(dataFor(0, 5000), { headers, chunkSize: 1024, cancel() { wasCancelled = true; } })
    }), codeIs("SIZE_LIMIT"));
    assert.equal(wasCancelled, true);
    assert.equal(root.directories.size, 1);
    assert.equal(root.aborts, 1);
  }
});

test("memory fallback is capped at 32 MiB while OPFS accepts a larger streamed archive", async () => {
  const data = dataFor(3, MiB);
  const largerResponse = () => {
    let count = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (count++ === 33) controller.close();
        else controller.enqueue(data);
      }
    }));
  };
  let storageNotice;
  await assert.rejects(archive.build([file()], {
    storageRoot: null, maxBytes: 64 * MiB, fetchFile: async () => largerResponse(),
    onProgress(progress) { storageNotice = progress; }
  }), codeIs("SIZE_LIMIT"));
  assert.equal(storageNotice.storage, "memory");
  assert.equal(storageNotice.maxBytes, 32 * MiB);
  const root = mockStorage();
  const result = await archive.build([file()], { storageRoot: root, maxBytes: 64 * MiB, fetchFile: async () => largerResponse() });
  assert.equal(result.storage, "opfs");
  assert.ok(result.bytes > 33 * MiB);
  await result.dispose();
});

test("unsupported OPFS initialization falls back, while quota failure never retries in memory", async () => {
  const unavailable = mockStorage({ noWriter: true });
  const result = await archive.build([file()], { storageRoot: unavailable, fetchFile: async () => new Response("small") });
  assert.equal(result.storage, "memory");
  assert.equal(unavailable.directories.size, 1, "Remove partial OPFS initialization before fallback");
  await result.dispose();
  const denied = mockStorage({ initError: new DOMException("Denied", "SecurityError") });
  const fallback = await archive.build([file()], { storageRoot: denied, fetchFile: async () => new Response("small") });
  assert.equal(fallback.storage, "memory");
  await fallback.dispose();
  const full = mockStorage({ initError: new DOMException("SYNTHETIC-SECRET", "QuotaExceededError") });
  let requested = false;
  await assert.rejects(archive.build([file()], {
    storageRoot: full, fetchFile: async () => { requested = true; return new Response("small"); }
  }), codeIs("STORAGE_FULL"));
  assert.equal(requested, false);
});

test("write and finish failures clean up only this archive and never retry the network", async () => {
  for (const settings of [
    { failWriteAt: 3, writeError: new DOMException("SYNTHETIC-SECRET", "QuotaExceededError") },
    { failWriteAt: 3, writeError: new Error("SYNTHETIC-SECRET") },
    { getFileError: new Error("SYNTHETIC-SECRET") }
  ]) {
    const root = mockStorage(settings);
    let fetches = 0;
    await assert.rejects(archive.build([file()], {
      storageRoot: root,
      fetchFile: async () => { fetches++; return new Response("payload"); }
    }), error => ["STORAGE_FULL", "STORAGE_FAILED"].includes(error.code) && !error.message.includes("SYNTHETIC-SECRET"));
    assert.equal(fetches, 1);
    assert.equal(root.directories.size, 1);
    assert.equal(root.removed.length, 1);
  }
});

test("HTTP and transport errors are credential-safe and preserve no partial output", async () => {
  for (const fetchFile of [
    async () => new Response("bad", { status: 503 }),
    async () => { throw new Error(sourceUrl(0)); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(sourceUrl(0))); } })),
    async () => ({ ok: true, url: "https://evil.invalid/file", body: new Response("bad").body })
  ]) {
    const root = mockStorage();
    await assert.rejects(archive.build([file()], { storageRoot: root, fetchFile }), error => {
      assert.ok(["HTTP_FAILED", "NETWORK_FAILED", "UNSUPPORTED_URL"].includes(error.code));
      assert.ok(!String(error).includes("SYNTHETIC-SECRET"));
      assert.ok(!String(error).includes("https://"));
      return true;
    });
    assert.equal(root.directories.size, 1);
  }
});

test("cancellation before start, during fetch and during body streaming completes promptly and cleans storage", async () => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort("SYNTHETIC-SECRET");
  let fetched = false;
  await assert.rejects(archive.build([file()], {
    signal: alreadyCancelled.signal,
    fetchFile: async () => { fetched = true; }
  }), { name: "AbortError", message: "Archive creation cancelled." });
  assert.equal(fetched, false);

  for (const phase of ["headers", "body"]) {
    const root = mockStorage();
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    let sourceSignal;
    const pending = archive.build([file()], {
      storageRoot: root, signal: controller.signal,
      fetchFile: async (url, { signal }) => {
        sourceSignal = signal;
        if (phase === "headers") { started(); return new Promise(() => {}); }
        return new Response(new ReadableStream({ pull() { started(); return new Promise(() => {}); } }));
      }
    });
    await ready;
    controller.abort("SYNTHETIC-SECRET");
    await assert.rejects(pending, { name: "AbortError", message: "Archive creation cancelled." });
    assert.equal(sourceSignal.aborted, true);
    assert.equal(root.directories.size, 1);
  }
});

test("header and idle deadlines abort even a provider that ignores AbortSignal", async () => {
  for (const phase of ["headers", "body"]) {
    const root = mockStorage();
    let sourceSignal;
    await assert.rejects(archive.build([file()], {
      storageRoot: root, headerTimeoutMs: 10, idleTimeoutMs: 10,
      fetchFile: async (url, { signal }) => {
        sourceSignal = signal;
        if (phase === "headers") return new Promise(() => {});
        return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
      }
    }), codeIs("TIMEOUT"));
    assert.equal(sourceSignal.aborted, true);
    assert.equal(root.directories.size, 1);
  }
});

test("two concurrent successful batches own separate temporary directories", async () => {
  const root = mockStorage();
  const results = await Promise.all([0, 1].map(index => archive.build([file(index)], {
    storageRoot: root, fetchFile: async () => new Response(`synthetic payload ${index}`)
  })));
  assert.equal(root.directories.size, 3);
  assert.equal(results[0].storage, "opfs");
  assert.equal(results[1].storage, "opfs");
  await results[0].dispose();
  assert.equal(root.directories.size, 2);
  const secondBytes = await results[1].blob.arrayBuffer();
  assert.equal(secondBytes.byteLength, results[1].bytes);
  await results[1].dispose();
  assert.equal(root.directories.size, 1);
  assert.equal(new Set(root.removed).size, 2);
});

test("production fetch omits credentials and referrers and refuses redirects", async () => {
  const original = globalThis.fetch;
  let requested = false;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, sourceUrl(0));
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.ok(options.signal instanceof AbortSignal);
      requested = true;
      return new Response("synthetic payload");
    };
    const result = await archive.build([file()], { storageRoot: null });
    assert.equal(requested, true);
    await result.dispose();
  } finally {
    globalThis.fetch = original;
  }
});
