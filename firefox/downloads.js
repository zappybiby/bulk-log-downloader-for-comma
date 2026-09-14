/* Runs entirely in the extension tab; source pages are read by the invisible bridge. */
(function () {
  "use strict";

  const MAX_PAGES = 100;
  const MAX_FILES = 10000;
  const MAX_BYTES = 256 * 1024 * 1024;
  const PREF_KEY = "firefoxPreferences";
  const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), element => [element.id, element]));
  const el = id => elements[id];
  const sourceParam = new URL(location.href).searchParams.get("sourceTab");
  const sourceTabId = sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null;
  const state = {
    mode: "idle", source: null, files: [], scanController: null, scanId: null,
    buildController: null, archive: null, objectUrl: null, scopeChosen: false
  };

  function selectedValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value;
  }

  function settings() {
    return {
      scope: selectedValue("scope") || "current",
      selectedTypes: Array.from(document.querySelectorAll('input[name="file-type"]:checked'), input => input.value),
      date: {
        mode: selectedValue("date-mode") || "recent", days: el("date-days").value,
        from: el("date-from").value, to: el("date-to").value
      }
    };
  }

  function showNotice(message, error = false) {
    el("page-notice").textContent = message;
    el("page-notice").classList.toggle("error", error);
    el("page-notice").hidden = !message;
  }

  function errorMessage(error, fallback) {
    return typeof error?.message === "string" ? error.message : fallback;
  }

  function formatBytes(value) {
    const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
      : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${Math.round(bytes)} bytes`;
  }

  function setMode(mode) {
    state.mode = mode;
    const busy = mode !== "idle";
    el("settings-fieldset").disabled = busy;
    el("check-source-button").disabled = busy || !Number.isSafeInteger(sourceTabId);
    el("scan-button").disabled = busy || !state.source || !settings().selectedTypes.length;
    el("cancel-scan-button").hidden = mode !== "scan";
    el("download-button").disabled = busy || !state.files.length || Boolean(state.archive);
    el("stop-button").hidden = mode !== "build";
    el("clear-button").disabled = busy;
  }

  function updateControls() {
    const prefs = settings();
    el("date-settings").hidden = prefs.scope !== "listed";
    el("recent-settings").hidden = prefs.date.mode !== "recent";
    el("custom-settings").hidden = prefs.date.mode !== "custom";
    el("scope-help").textContent = prefs.scope === "current"
      ? "Use the log file list on your open route page."
      : "Read routes listed on your device page, including additional route pages.";
    setMode(state.mode);
  }

  async function discardArchive() {
    const previous = state.archive;
    state.archive = null;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    el("save-button").hidden = true;
    el("save-button").removeAttribute("href");
    el("clear-button").hidden = true;
    el("save-note").hidden = true;
    if (previous) await previous.dispose();
  }

  function invalidateResults() {
    state.files = [];
    el("results-content").hidden = true;
    el("empty-results").hidden = false;
    el("scan-status").hidden = true;
    el("scan-progress").hidden = true;
    el("transfer-card").hidden = true;
    el("file-preview").replaceChildren();
    void discardArchive().catch(() => showNotice("The old ZIP could not be cleared from temporary storage. Close this tab before trying again.", true));
    setMode(state.mode);
  }

  async function readPage(options = {}) {
    if (!Number.isSafeInteger(sourceTabId)) {
      throw new Error("Open a device or route page on useradmin.comma.ai, then choose Bulk Logs from Firefox’s extension menu.");
    }
    let response;
    try {
      response = await browser.tabs.sendMessage(sourceTabId, { type: "comma:read", ...options });
    } catch {
      throw new Error("Cannot reach the source tab. Open it, sign in if needed, and reload the page. Then return here and tap Check source.");
    }
    if (!response || response.error) throw new Error(response?.error || "The source page did not respond. Reload it and try again.");
    if (!CommaParser.isAllowedPageUrl(response.url) || !Array.isArray(response.routes) || !Array.isArray(response.files)) {
      throw new Error("The source page returned an unreadable result. Reload it and try again.");
    }
    return response;
  }

  async function checkSource() {
    if (state.mode !== "idle") return;
    invalidateResults();
    state.source = null;
    setMode("check");
    showNotice("");
    el("source-indicator").classList.remove("connected");
    el("source-title").textContent = "Checking your comma page…";
    el("source-url").textContent = "";
    try {
      const source = await readPage({ selectedTypes: ["rlog", "qlog"] });
      state.source = source;
      el("source-title").textContent = source.title || "comma useradmin";
      el("source-url").textContent = source.url;
      el("source-link").href = source.url;
      el("source-indicator").classList.add("connected");
      if (!state.scopeChosen) {
        const scope = source.pageKind === "route" || source.files.length ? "current" : "listed";
        document.querySelector(`input[name="scope"][value="${scope}"]`).checked = true;
      }
      if (!source.routes.length && !source.files.length) {
        showNotice("No rlogs, qlogs, or listed routes were found on this page. Open a route or device page in the source tab, then tap Check source.");
      }
      updateControls();
    } catch (error) {
      el("source-title").textContent = "Source page unavailable";
      showNotice(errorMessage(error, "Unable to read the source page."), true);
    } finally {
      setMode("idle");
    }
  }

  function throwIfAborted(signal) {
    if (signal.aborted) throw new DOMException("Scan cancelled.", "AbortError");
  }

  function scanStatus(message) {
    el("scan-status").textContent = message;
    el("scan-status").hidden = false;
    el("scan-status").classList.remove("error");
  }

  function showResults(files, detail) {
    state.files = files;
    el("empty-results").hidden = true;
    el("results-content").hidden = false;
    el("file-count").textContent = String(files.length);
    el("file-count-label").textContent = files.length === 1 ? "file found" : "files found";
    const routes = new Set(files.map(file => file.routeFolderName)).size;
    el("route-count").textContent = `${routes} ${routes === 1 ? "route" : "routes"} · ZIP folders preserve route and log type`;
    el("scan-detail").textContent = detail;
    const preview = document.createDocumentFragment();
    for (const file of files.slice(0, 30)) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.name;
      const route = document.createElement("span");
      route.className = "file-route";
      route.textContent = `${file.routeFolderName} / ${file.typeFolderName}`;
      item.append(name, route);
      preview.append(item);
    }
    el("file-preview").replaceChildren(preview);
    el("file-preview").hidden = !files.length;
    el("preview-note").textContent = `Showing the first 30 of ${files.length} files. All matched files will be included.`;
    el("preview-note").hidden = files.length <= 30;
  }

  async function scanFiles() {
    if (state.mode !== "idle" || !state.source) return;
    const prefs = settings();
    let filter;
    try {
      if (!prefs.selectedTypes.length) throw new Error("Choose rlog, qlog, or both.");
      filter = prefs.scope === "listed" ? CommaParser.dateFilter(prefs.date) : { mode: "all" };
    } catch (error) {
      showNotice(errorMessage(error, "Check your file and date choices."), true);
      return;
    }
    invalidateResults();
    showNotice("");
    const controller = new AbortController();
    const scanId = crypto.randomUUID();
    state.scanController = controller;
    state.scanId = scanId;
    const expectedUrl = state.source.url;
    setMode("scan");
    el("empty-results").hidden = true;
    el("scan-progress").hidden = false;
    el("scan-progress").removeAttribute("value");
    scanStatus("Reading source page…");
    let pagesRead = 0;
    const seenPages = new Map();
    const found = new Map();
    const seenRoutes = new Set();
    let filteredRoutes = 0;
    let undatedRoutes = 0;
    let matchedRoutes = 0;

    async function getPage(url) {
      throwIfAborted(controller.signal);
      const key = url || expectedUrl;
      if (seenPages.has(key)) return seenPages.get(key);
      if (pagesRead >= MAX_PAGES) throw new Error("This scan reached the 100-page limit. No partial ZIP was prepared. Choose a smaller date range or open a single route.");
      pagesRead += 1;
      const page = await readPage({ selectedTypes: prefs.selectedTypes, expectedUrl, scanId, ...(url ? { url } : {}) });
      throwIfAborted(controller.signal);
      seenPages.set(key, page);
      return page;
    }

    function addFiles(files) {
      for (const file of files) {
        if (!prefs.selectedTypes.includes(file.typeKey)) continue;
        if (!CommaParser.isAllowedDownloadUrl(file.url)) throw new Error("A file address could not be verified. Reload the source page and scan again.");
        const previous = found.get(file.targetPath);
        if (previous) continue;
        if (found.size >= MAX_FILES) throw new Error("This scan reached the 10,000-file limit. No partial ZIP was prepared. Choose fewer dates or one log type.");
        found.set(file.targetPath, file);
      }
    }

    try {
      const initial = await getPage();
      if (prefs.scope === "current") {
        addFiles(initial.files);
      } else {
        let page = initial;
        const listingPages = new Set();
        while (page) {
          throwIfAborted(controller.signal);
          if (listingPages.has(page.url)) throw new Error("The route pages repeat a page. No partial ZIP was prepared. Reload the source page and scan again.");
          listingPages.add(page.url);
          for (const route of page.routes) {
            if (seenRoutes.has(route.key)) continue;
            seenRoutes.add(route.key);
            if (!CommaParser.routeMatches(route, filter)) {
              filteredRoutes += 1;
              if (!Number.isFinite(route.uploadedAt)) undatedRoutes += 1;
              continue;
            }
            matchedRoutes += 1;
            scanStatus(`Reading route ${matchedRoutes} · ${found.size} files found…`);
            const routePage = await getPage(route.url);
            addFiles(routePage.files);
          }
          if (!page.nextPageUrl) break;
          scanStatus(`Checking more listed routes · ${found.size} files found…`);
          page = await getPage(page.nextPageUrl);
        }
      }
      throwIfAborted(controller.signal);
      const files = Array.from(found.values()).sort((a, b) => a.targetPath.localeCompare(b.targetPath, undefined, { numeric: true }));
      let detail = files.length ? "All matching files from this scan will go into the ZIP. Their sizes are checked while preparing it."
        : prefs.scope === "current" ? "No matching log files on this page. Try qlog, another route, or Listed routes from a device page."
        : "No matching log files found. Try qlog, a wider date range, or another device page.";
      if (filteredRoutes) detail += ` ${filteredRoutes} ${filteredRoutes === 1 ? "route was" : "routes were"} excluded by the date filter.`;
      if (undatedRoutes) detail += ` ${undatedRoutes} had no readable upload date.`;
      showResults(files, detail);
      scanStatus(`Scan complete · ${pagesRead} ${pagesRead === 1 ? "page" : "pages"} checked`);
    } catch (error) {
      state.files = [];
      el("results-content").hidden = true;
      el("scan-status").textContent = controller.signal.aborted
        ? "Scan cancelled. No partial results were kept."
        : errorMessage(error, "The scan failed. No partial results were kept.");
      el("scan-status").classList.toggle("error", !controller.signal.aborted);
    } finally {
      if (state.scanController === controller) {
        state.scanController = null;
        state.scanId = null;
        el("scan-progress").hidden = true;
        setMode("idle");
      }
    }
  }

  function cancelScan() {
    const scanId = state.scanId;
    state.scanController?.abort();
    el("cancel-scan-button").disabled = true;
    scanStatus("Stopping scan…");
    if (scanId && Number.isSafeInteger(sourceTabId)) {
      void browser.tabs.sendMessage(sourceTabId, { type: "comma:cancel-read", scanId }).catch(() => {});
    }
  }

  function transferStatus(message, isError = false) {
    el("transfer-status").textContent = message;
    el("transfer-status").classList.toggle("error", isError);
  }

  async function prepareZip() {
    if (state.mode !== "idle" || !state.files.length || state.archive) return;
    showNotice("");
    const controller = new AbortController();
    state.buildController = controller;
    setMode("build");
    el("transfer-card").hidden = false;
    el("storage-fallback").hidden = true;
    el("transfer-progress").hidden = false;
    el("transfer-progress").value = 0;
    el("transfer-progress").max = state.files.length;
    el("transfer-detail").textContent = "Keep this tab open. The ZIP will be ready to save after every selected file has been fetched.";
    transferStatus("Preparing ZIP…");
    try {
      await discardArchive();
      const archive = await CommaArchive.build(state.files, {
        signal: controller.signal, maxBytes: MAX_BYTES,
        onProgress(progress) {
          if (controller.signal.aborted || state.buildController !== controller) return;
          const done = Number(progress.filesDone) || 0;
          const total = Number(progress.filesTotal) || state.files.length;
          el("transfer-progress").max = total;
          el("transfer-progress").value = done;
          transferStatus(`${done} of ${total} files prepared`);
          const cap = Number(progress.maxBytes) || MAX_BYTES;
          el("transfer-detail").textContent = `${formatBytes(progress.bytesReceived)} received · ${formatBytes(cap)} ZIP limit. Keep this tab open.`;
          if (progress.storage === "memory") el("storage-fallback").hidden = false;
        }
      });
      if (controller.signal.aborted) {
        await archive.dispose();
        throw new DOMException("Preparation cancelled.", "AbortError");
      }
      state.archive = archive;
      state.objectUrl = URL.createObjectURL(archive.blob);
      el("save-button").href = state.objectUrl;
      el("save-button").download = archive.filename;
      el("save-button").hidden = false;
      el("clear-button").hidden = false;
      el("save-note").hidden = false;
      el("storage-fallback").hidden = archive.storage !== "memory";
      el("transfer-progress").value = state.files.length;
      transferStatus("ZIP ready to save");
      el("transfer-detail").textContent = `${archive.count} files · ${formatBytes(archive.bytes)}. Tap Save ZIP, then confirm it in Firefox’s Downloads screen.`;
    } catch (error) {
      transferStatus(controller.signal.aborted ? "Preparation cancelled" : "ZIP could not be prepared", !controller.signal.aborted);
      el("transfer-detail").textContent = controller.signal.aborted
        ? "No partial ZIP was kept. You can prepare the selected files again."
        : `${errorMessage(error, "Please try again.")} No partial ZIP is offered. If this batch is too large, choose fewer dates, a single route, or qlog only.`;
      el("transfer-progress").hidden = true;
    } finally {
      if (state.buildController === controller) {
        state.buildController = null;
        setMode("idle");
      }
    }
  }

  async function restorePreferences() {
    try {
      const saved = (await browser.storage.local.get(PREF_KEY))[PREF_KEY];
      if (!saved || typeof saved !== "object") return;
      if (["current", "listed"].includes(saved.scope)) {
        document.querySelector(`input[name="scope"][value="${saved.scope}"]`).checked = true;
        state.scopeChosen = true;
      }
      if (Array.isArray(saved.selectedTypes) && saved.selectedTypes.some(type => ["rlog", "qlog"].includes(type))) {
        for (const input of document.querySelectorAll('input[name="file-type"]')) input.checked = saved.selectedTypes.includes(input.value);
      }
      if (["recent", "all", "custom"].includes(saved.date?.mode)) document.querySelector(`input[name="date-mode"][value="${saved.date.mode}"]`).checked = true;
      if (/^\d{1,5}$/.test(String(saved.date?.days))) el("date-days").value = saved.date.days;
      if (/^\d{4}-\d{2}-\d{2}$/.test(saved.date?.from)) el("date-from").value = saved.date.from;
      if (/^\d{4}-\d{2}-\d{2}$/.test(saved.date?.to)) el("date-to").value = saved.date.to;
    } catch {
      showNotice("Saved choices could not be loaded. You can still scan and download logs.");
    }
  }

  el("settings-form").addEventListener("submit", event => event.preventDefault());
  el("settings-form").addEventListener("change", event => {
    if (state.mode !== "idle") return;
    if (event.target.name === "scope") state.scopeChosen = true;
    invalidateResults();
    updateControls();
    void browser.storage.local.set({ [PREF_KEY]: settings() }).catch(() => showNotice("Your choices could not be saved. This scan can still continue."));
  });
  el("check-source-button").addEventListener("click", () => void checkSource());
  el("scan-button").addEventListener("click", () => {
    el("cancel-scan-button").disabled = false;
    void scanFiles();
  });
  el("cancel-scan-button").addEventListener("click", cancelScan);
  el("download-button").addEventListener("click", () => void prepareZip());
  el("stop-button").addEventListener("click", () => {
    state.buildController?.abort();
    transferStatus("Cancelling preparation…");
    el("stop-button").hidden = true;
  });
  el("clear-button").addEventListener("click", () => {
    if (state.mode !== "idle") return;
    setMode("clear");
    el("transfer-card").hidden = true;
    void discardArchive().then(() => {
      setMode("idle");
    }).catch(() => {
      setMode("idle");
      showNotice("The ZIP could not be cleared from temporary storage. Close this tab before trying again.", true);
    });
  });
  el("save-button").addEventListener("click", () => {
    transferStatus("ZIP sent to Firefox for saving");
    el("save-note").textContent = "Check Firefox’s Downloads screen to confirm the ZIP was saved. If nothing appeared, tap Save ZIP again. This tab cannot confirm that the download finished.";
  });
  el("source-link").addEventListener("click", event => {
    if (!state.source || !Number.isSafeInteger(sourceTabId)) return;
    event.preventDefault();
    void browser.tabs.update(sourceTabId, { active: true }).catch(() => showNotice("The source tab is closed. Open a route or device page and launch Bulk Logs again.", true));
  });
  addEventListener("pagehide", () => {
    state.scanController?.abort();
    state.buildController?.abort();
    if (state.scanId && Number.isSafeInteger(sourceTabId)) void browser.tabs.sendMessage(sourceTabId, { type: "comma:cancel-read", scanId: state.scanId }).catch(() => {});
    void discardArchive().catch(() => {});
  });

  async function init() {
    setMode("check");
    await restorePreferences();
    state.mode = "idle";
    updateControls();
    await checkSource();
  }
  void init();
})();
