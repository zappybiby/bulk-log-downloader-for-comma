/* Sequential, uncompressed ZIP32 writer. No third-party code or remote libraries. */
(function (root) {
  "use strict";

  const MiB = 1024 * 1024;
  const DEFAULT_MAX_BYTES = 256 * MiB;
  const HARD_MAX_BYTES = 512 * MiB;
  const MEMORY_MAX_BYTES = 32 * MiB;
  const ZIP32_MAX = 0xffffffff;
  const UTF8_DESCRIPTOR_FLAGS = 0x0808;
  const encoder = new TextEncoder();
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });

  class ArchiveError extends Error {
    constructor(message, code) {
      super(message);
      this.name = "ArchiveError";
      this.code = code;
    }
  }

  function cancelled() {
    return new DOMException("Archive creation cancelled.", "AbortError");
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw cancelled();
  }

  // Never expose fetch exceptions: they can contain a signed download URL.
  function safeError(error, message, code, signal) {
    if (signal?.aborted || error?.name === "AbortError") return cancelled();
    if (error instanceof ArchiveError) return error;
    if (error?.name === "QuotaExceededError") {
      return new ArchiveError("Device storage is full. Free some space or select fewer files.", "STORAGE_FULL");
    }
    return new ArchiveError(message, code);
  }

  function allowedDownloadUrl(value) {
    if (root.CommaParser?.isAllowedDownloadUrl) return root.CommaParser.isAllowedDownloadUrl(value);
    if (typeof value !== "string" || !value || value.trim() !== value || /[\\\x00-\x20\x7f]/.test(value)) return false;
    const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
    if (!authority || /[@:]/.test(authority)) return false;
    try {
      const url = new URL(value);
      return url.origin === "https://commadata2.blob.core.windows.net" && !url.username && !url.password && !url.port;
    } catch {
      return false;
    }
  }

  function validatePath(path) {
    if (typeof path !== "string" || !path || /[\\:\x00-\x1f\x7f]/.test(path)) return false;
    return path.split("/").every(part => part && part !== "." && part !== ".."
      && !/[. ]$/.test(part) && encoder.encode(part).length <= 255
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  }

  function validateFiles(files, maxBytes) {
    if (!Array.isArray(files) || files.length === 0) throw new ArchiveError("Choose at least one log file.", "EMPTY_INPUT");
    if (files.length > 65535) throw new ArchiveError("A ZIP batch can contain at most 65,535 files.", "ENTRY_LIMIT");
    const paths = new Set();
    let overhead = 22;
    const entries = files.map(file => {
      if (!file || !allowedDownloadUrl(file.url)) throw new ArchiveError("A file has an unsupported download address.", "UNSUPPORTED_URL");
      if (!validatePath(file.targetPath)) throw new ArchiveError("A file has an unsafe archive path.", "UNSAFE_PATH");
      const nameLength = encoder.encode(file.targetPath).length;
      if (nameLength > 65535) throw new ArchiveError("An archive path is too long.", "UNSAFE_PATH");
      if (paths.has(file.targetPath)) throw new ArchiveError("The selection contains a duplicate archive path.", "DUPLICATE_PATH");
      paths.add(file.targetPath);
      overhead += 92 + 2 * nameLength;
      if (overhead > maxBytes) throw sizeError("opfs", maxBytes);
      // Encode names for output only after the effective storage cap is known.
      return { url: file.url, targetPath: file.targetPath };
    });
    return { entries, overhead };
  }

  function sizeLimit(value) {
    const limit = value === undefined ? DEFAULT_MAX_BYTES : value;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAX_BYTES) {
      throw new ArchiveError("Choose a batch size between 1 byte and 512 MiB.", "INVALID_LIMIT");
    }
    return limit;
  }

  function timeout(value, defaultValue) {
    if (value === undefined) return defaultValue;
    if (!Number.isSafeInteger(value) || value < 1 || value > 180000) {
      throw new ArchiveError("Invalid request timeout.", "INVALID_TIMEOUT");
    }
    return value;
  }

  function sizeError(storage, maxBytes) {
    const amount = maxBytes >= MiB ? `${Math.floor(maxBytes / MiB)} MiB` : `${maxBytes} bytes`;
    return new ArchiveError(storage === "memory"
      ? `This browser is using memory storage. Select fewer files to keep the ZIP under ${amount}.`
      : `This ZIP exceeds the ${amount} batch limit. Select fewer files.`, "SIZE_LIMIT");
  }

  function record(length, signature) {
    const bytes = new Uint8Array(length);
    new DataView(bytes.buffer).setUint32(0, signature, true);
    return bytes;
  }

  function put16(bytes, offset, value) { new DataView(bytes.buffer).setUint16(offset, value, true); }
  function put32(bytes, offset, value) { new DataView(bytes.buffer).setUint32(offset, value, true); }

  function zipDate(now) {
    const year = Math.max(1980, Math.min(2107, now.getFullYear()));
    return {
      date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
      time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
    };
  }

  function temporaryName() {
    if (root.crypto?.randomUUID) return `comma-logs-${root.crypto.randomUUID()}`;
    if (root.crypto?.getRandomValues) {
      const words = root.crypto.getRandomValues(new Uint32Array(4));
      return `comma-logs-${Array.from(words, word => word.toString(16).padStart(8, "0")).join("")}`;
    }
    return `comma-logs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function memorySink(maxBytes) {
    // Coalesce tiny stream chunks instead of retaining millions of array objects.
    const chunkSize = Math.min(128 * 1024, maxBytes);
    let chunks = [];
    let pending = new Uint8Array(chunkSize);
    let used = 0;
    let size = 0;
    return {
      storage: "memory",
      maxBytes: Math.min(maxBytes, MEMORY_MAX_BYTES),
      async write(bytes) {
        if (size + bytes.length > Math.min(maxBytes, MEMORY_MAX_BYTES)) throw sizeError("memory", Math.min(maxBytes, MEMORY_MAX_BYTES));
        let cursor = 0;
        while (cursor < bytes.length) {
          const take = Math.min(bytes.length - cursor, pending.length - used);
          pending.set(bytes.subarray(cursor, cursor + take), used);
          cursor += take;
          used += take;
          if (used === pending.length) {
            chunks.push(pending);
            pending = new Uint8Array(chunkSize);
            used = 0;
          }
        }
        size += bytes.length;
      },
      async finish() {
        if (used) chunks.push(pending.subarray(0, used));
        const blob = new Blob(chunks, { type: "application/zip" });
        chunks = [];
        pending = null;
        return blob;
      },
      async dispose() { chunks = []; pending = null; }
    };
  }

  function storageUnavailable(error) {
    return ["NotSupportedError", "SecurityError", "NotAllowedError"].includes(error?.name);
  }

  async function createSink(options, maxBytes) {
    let directory;
    let directoryName;
    let writer;
    const cleanup = async () => {
      if (writer) {
        try { await writer.abort(); } catch { /* Already closed, or the device removed the file. */ }
        writer = null;
      }
      if (directory && directoryName) {
        try {
          await directory.removeEntry(directoryName, { recursive: true });
          directoryName = null;
        } catch (error) {
          if (error?.name === "NotFoundError") directoryName = null;
          else throw new ArchiveError("Could not remove temporary archive storage. Close this tab and clear this extension's storage if needed.", "CLEANUP_FAILED");
        }
      }
    };
    try {
      checkAbort(options.signal);
      if (Object.prototype.hasOwnProperty.call(options, "storageRoot")) directory = options.storageRoot;
      else if (root.navigator?.storage?.getDirectory) directory = await root.navigator.storage.getDirectory();
      if (!directory || typeof directory.getDirectoryHandle !== "function") return memorySink(maxBytes);
      checkAbort(options.signal);
      directoryName = temporaryName();
      const temporary = await directory.getDirectoryHandle(directoryName, { create: true });
      checkAbort(options.signal);
      const handle = await temporary.getFileHandle("archive.zip", { create: true });
      if (typeof handle.createWritable !== "function") {
        await cleanup();
        return memorySink(maxBytes);
      }
      writer = await handle.createWritable();
      checkAbort(options.signal);
      return {
        storage: "opfs",
        maxBytes,
        async write(bytes) { await writer.write(bytes); },
        async finish() {
          await writer.close();
          writer = null;
          checkAbort(options.signal);
          return handle.getFile();
        },
        dispose: cleanup
      };
    } catch (error) {
      let cleanupError;
      try { await cleanup(); } catch (failure) { cleanupError = failure; }
      if (cleanupError) throw cleanupError;
      checkAbort(options.signal);
      // A full disk or a failed write is an error, never a reason to retry in RAM.
      if (storageUnavailable(error)) return memorySink(maxBytes);
      throw safeError(error, "Could not open temporary storage. Retry with fewer files or free some space.", "STORAGE_FAILED", options.signal);
    }
  }

  // Race every network operation against cancellation and a deadline, even when
  // a test adapter or a stalled network operation fails to honor AbortSignal.
  function waitForIO(operation, controller, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const signal = controller.signal;
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, cancelled());
      if (signal.aborted) { reject(cancelled()); return; }
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        finish(reject, new ArchiveError(message, "TIMEOUT"));
        controller.abort();
      }, timeoutMs);
      Promise.resolve().then(() => {
        checkAbort(signal);
        return operation();
      }).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  async function build(files, options = {}) {
    checkAbort(options.signal);
    const maxBytes = sizeLimit(options.maxBytes);
    const { entries, overhead } = validateFiles(files, maxBytes);
    const headerTimeoutMs = timeout(options.headerTimeoutMs, 45000);
    const idleTimeoutMs = timeout(options.idleTimeoutMs, 90000);
    const fetchFile = options.fetchFile || ((url, settings) => root.fetch(url, {
      signal: settings.signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"
    }));
    if (typeof fetchFile !== "function") throw new ArchiveError("The download provider is unavailable.", "INVALID_FETCH");
    const sink = await createSink(options, maxBytes);
    let offset = 0;
    let bytesReceived = 0;
    let filesDone = 0;
    let currentFile = "";
    const central = [];
    const date = zipDate(new Date());
    const progress = () => options.onProgress?.({
      filesDone, filesTotal: entries.length, bytesReceived, currentFile,
      archiveBytes: offset, storage: sink.storage, maxBytes: sink.maxBytes
    });
    const write = async bytes => {
      checkAbort(options.signal);
      if (offset + bytes.length > sink.maxBytes || offset + bytes.length > ZIP32_MAX) throw sizeError(sink.storage, sink.maxBytes);
      try { await sink.write(bytes); } catch (error) {
        throw safeError(error, "Could not write the ZIP to temporary storage. Free some space or select fewer files.", "STORAGE_FAILED", options.signal);
      }
      offset += bytes.length;
      checkAbort(options.signal);
    };

    try {
      progress();
      if (overhead > sink.maxBytes) throw sizeError(sink.storage, sink.maxBytes);
      for (const file of entries) {
        checkAbort(options.signal);
        file.name = encoder.encode(file.targetPath);
        currentFile = file.targetPath;
        progress();
        const start = offset;
        const local = record(30, 0x04034b50);
        put16(local, 4, 20); put16(local, 6, UTF8_DESCRIPTOR_FLAGS);
        put16(local, 10, date.time); put16(local, 12, date.date); put16(local, 26, file.name.length);
        await write(local);
        await write(file.name);

        const controller = new AbortController();
        const cancelFile = () => controller.abort();
        options.signal?.addEventListener("abort", cancelFile, { once: true });
        if (options.signal?.aborted) controller.abort();
        let reader;
        let size = 0;
        let crc = 0xffffffff;
        let bodyComplete = false;
        try {
          let response;
          try {
            response = await waitForIO(() => fetchFile(file.url, { signal: controller.signal }), controller,
              headerTimeoutMs, "The file server took too long to respond. Try again.");
          } catch (error) {
            throw safeError(error, "Could not fetch a log file. Check your connection and read the source page again.", "NETWORK_FAILED", options.signal);
          }
          if (!response?.ok) {
            const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : "";
            throw new ArchiveError(`A log file request failed${status}. Its link may have expired; read the source page again.`, "HTTP_FAILED");
          }
          if (response.url && !allowedDownloadUrl(response.url)) throw new ArchiveError("The file server redirected to an unsupported address.", "UNSUPPORTED_URL");
          if (!response.body || typeof response.body.getReader !== "function") throw new ArchiveError("The file server returned no readable content.", "NETWORK_FAILED");
          reader = response.body.getReader();
          const declaredSize = response.headers?.get("content-length");
          if (declaredSize && /^\d+$/.test(declaredSize)
              && Number(declaredSize) + bytesReceived + overhead > sink.maxBytes) throw sizeError(sink.storage, sink.maxBytes);
          while (true) {
            checkAbort(options.signal);
            let chunk;
            try {
              chunk = await waitForIO(() => reader.read(), controller, idleTimeoutMs,
                "A log file stopped sending data. Check your connection and try again.");
            } catch (error) {
              throw safeError(error, "A log file transfer failed. Check your connection and try again.", "NETWORK_FAILED", options.signal);
            }
            if (chunk.done) { bodyComplete = true; break; }
            const value = chunk.value;
            if (!(value instanceof Uint8Array)) throw new ArchiveError("The file server returned an unreadable data chunk.", "NETWORK_FAILED");
            if (bytesReceived + value.length + overhead > sink.maxBytes || size + value.length > ZIP32_MAX) throw sizeError(sink.storage, sink.maxBytes);
            for (let index = 0; index < value.length; index++) crc = crcTable[(crc ^ value[index]) & 255] ^ (crc >>> 8);
            await write(value);
            size += value.length;
            bytesReceived += value.length;
            progress();
          }
        } finally {
          options.signal?.removeEventListener("abort", cancelFile);
          if (!bodyComplete) {
            controller.abort();
            // Do not await a stalled underlying cancel algorithm.
            try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* Reader already closed. */ }
          }
          try { reader?.releaseLock(); } catch { /* An adapter may still have a pending read. */ }
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = record(16, 0x08074b50);
        put32(descriptor, 4, crc); put32(descriptor, 8, size); put32(descriptor, 12, size);
        await write(descriptor);
        central.push({ name: file.name, start, size, crc });
        filesDone++;
        progress();
      }

      currentFile = "";
      const centralStart = offset;
      for (const file of central) {
        const header = record(46, 0x02014b50);
        put16(header, 4, 20); put16(header, 6, 20); put16(header, 8, UTF8_DESCRIPTOR_FLAGS);
        put16(header, 12, date.time); put16(header, 14, date.date);
        put32(header, 16, file.crc); put32(header, 20, file.size); put32(header, 24, file.size);
        put16(header, 28, file.name.length); put32(header, 42, file.start);
        await write(header);
        await write(file.name);
      }
      const end = record(22, 0x06054b50);
      put16(end, 8, entries.length); put16(end, 10, entries.length);
      put32(end, 12, offset - centralStart); put32(end, 16, centralStart);
      await write(end);
      let blob;
      try { blob = await sink.finish(); } catch (error) {
        throw safeError(error, "Could not finish the ZIP in temporary storage. Free some space or select fewer files.", "STORAGE_FAILED", options.signal);
      }
      checkAbort(options.signal);
      if (!(blob instanceof Blob) || blob.size !== offset) throw new ArchiveError("The saved archive size did not match. Please try again.", "STORAGE_FAILED");
      progress();
      const filename = `comma-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      return { blob, filename, bytes: offset, count: filesDone, storage: sink.storage, dispose: sink.dispose };
    } catch (error) {
      try { await sink.dispose(); } catch { /* Preserve the actionable original error. */ }
      throw safeError(error, "Archive creation failed. Try again with fewer files.", "ARCHIVE_FAILED", options.signal);
    }
  }

  const api = Object.freeze({ build, DEFAULT_MAX_BYTES, HARD_MAX_BYTES, MEMORY_MAX_BYTES });
  root.CommaArchive = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
