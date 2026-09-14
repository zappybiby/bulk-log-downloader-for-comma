/* Runs entirely in the extension tab; source pages are read by the invisible bridge. */
(function () {
  "use strict";

  const FILE_TYPES = ["rlog", "qlog", "qcamera", "fcamera", "ecamera", "dcamera"];
  const MAX_BYTES = 256 * 1024 * 1024;
  const PREF_KEY = "firefoxPreferences";
  const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), element => [element.id, element]));
  const el = id => elements[id];
  const sourceParam = new URL(location.href).searchParams.get("sourceTab");
  const sourceTabId = sourceParam && /^\d+$/.test(sourceParam) ? Number(sourceParam) : null;
  const state = {
    mode: "idle", source: null, files: [], scanController: null, scanId: null,
    buildController: null, archive: null, objectUrl: null, scopeChosen: false, lastOutcome: "",
    view: "choose", reviewAvailable: false, daysEditor: false, renderMore: null, scannedSettings: ""
  };

  function selectedValue(name) {
    return document.querySelector(`input[name="${name}"]:checked`)?.value;
  }

  function settings() {
    return {
      scope: selectedValue("scope") || "current",
      dateBasis: selectedValue("date-basis") || "recording",
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

  function scopeAvailable(scope) {
    if (!state.source) return false;
    return scope === "current" ? state.source.pageKind === "route"
      : state.source.pageKind === "device" || CommaParser.isAllowedPageUrl(state.source.deviceUrl);
  }

  function setRadio(name, value) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
  }

  function setMode(mode) {
    state.mode = mode;
    const busy = mode !== "idle";
    const hasArchive = Boolean(state.archive);
    const hasFiles = Boolean(state.files.length);
    const prefs = settings();
    const choosing = state.view === "choose";
    el("settings-form").hidden = !choosing;
    el("review-panel").hidden = choosing;
    el("edit-filters-button").disabled = busy;
    el("review-button").hidden = !choosing || !state.reviewAvailable;
    el("review-button").disabled = busy;
    el("settings-fieldset").disabled = busy;
    el("check-source-button").disabled = busy || !Number.isSafeInteger(sourceTabId);
    for (const input of document.querySelectorAll('input[name="scope"]')) input.disabled = !scopeAvailable(input.value);
    el("scan-button").hidden = !choosing && (hasFiles || hasArchive);
    el("scan-button").disabled = busy || !scopeAvailable(prefs.scope) || !prefs.selectedTypes.length;
    el("scan-button").textContent = mode === "scan" ? "Scanning…" : mode === "check" ? "Checking source…" : "Scan files";
    el("cancel-scan-button").hidden = mode !== "scan";
    el("download-button").hidden = choosing || !hasFiles || hasArchive;
    el("download-button").disabled = busy || !hasFiles || hasArchive;
    el("download-button").textContent = mode === "build" ? "Preparing…" : "Prepare ZIP";
    el("save-button").hidden = choosing || !hasArchive;
    el("stop-button").hidden = mode !== "build";
    el("clear-button").hidden = choosing || !hasArchive;
    el("clear-button").disabled = busy;
    const routes = new Set(state.files.map(file => file.routeFolderName)).size;
    el("action-summary").textContent = mode === "scan" ? "Scanning · keep the source tab open"
      : mode === "build" ? "Preparing ZIP · keep this tab open"
      : choosing && state.source && prefs.selectedTypes.length
        ? state.reviewAvailable ? "Scan again, or return to your results" : "Choose dates and files, then scan"
      : mode === "idle" && state.lastOutcome ? state.lastOutcome
      : hasArchive ? `${state.archive.count} files · ${formatBytes(state.archive.bytes)} · ready to save`
      : hasFiles ? `${state.files.length} files · ${routes} ${routes === 1 ? "route" : "routes"} · ready to prepare`
      : !state.source ? "Open a device or route page to begin"
      : !prefs.selectedTypes.length ? "Choose at least one file type"
      : "Choose files, then scan";
  }

  function setView(view) {
    if (view === "review" && !state.reviewAvailable) return;
    state.view = view;
    setMode(state.mode);
    el("app").scrollTop = 0;
    el(view === "choose" ? "choose-title" : "review-title").focus?.({ preventScroll: true });
  }

  function summarizeSelection(prefs, range) {
    const basis = prefs.dateBasis === "recording" ? "Recorded" : "Uploaded";
    const period = range.mode === "all" ? "All dates" : range.mode === "custom" ? "Custom range"
      : Number(prefs.date.days) === 1 ? "Today" : `Last ${Number(prefs.date.days)} days`;
    el("selection-title").textContent = prefs.scope === "current" ? "This route" : `${basis} · ${period}`;
    el("selection-range").textContent = prefs.scope === "current" ? "All matching uploaded files on this route"
      : range.mode === "all" ? "Includes routes with unknown dates" : `${range.fromDate} → ${range.toDate}`;
    el("selection-files").textContent = `${prefs.scope === "listed" ? "Device routes · " : ""}${prefs.selectedTypes.join(" + ")}`;
  }

  function showDateRange(range) {
    const basis = settings().dateBasis === "recording" ? "recording" : "upload";
    el("date-summary").textContent = range.mode === "all" ? `All ${basis} dates` : `${range.fromDate} → ${range.toDate}`;
    el("date-summary").classList.remove("error");
  }

  function updateControls() {
    const prefs = settings();
    el("date-settings").hidden = prefs.scope !== "listed";
    const hasPresetDays = [1, 7, 30].includes(Number(prefs.date.days));
    const daysVisible = prefs.date.mode === "recent" && (state.daysEditor || !hasPresetDays);
    el("recent-settings").hidden = !daysVisible;
    el("edit-days-button").setAttribute("aria-expanded", String(daysVisible));
    el("scope-settings").hidden = !scopeAvailable("current") && scopeAvailable("listed");
    el("scope-summary").hidden = !el("scope-settings").hidden;
    el("custom-settings").hidden = prefs.date.mode !== "custom";
    el("scope-help").textContent = prefs.scope === "current"
      ? "Include matching uploaded files from this route."
      : prefs.dateBasis === "recording" ? "Check each route’s recording start date."
      : "Filter this device’s routes by the upload dates shown in its table.";
    el("date-explanation").textContent = prefs.dateBasis === "recording"
      ? "Recording start date as shown on each route page."
      : "Upload date as shown on the device page.";
    for (const preset of ["1", "7", "30", "all", "custom"]) {
      const pressed = preset === "all" || preset === "custom" ? prefs.date.mode === preset
        : prefs.date.mode === "recent" && Number(prefs.date.days) === Number(preset);
      el(`date-preset-${preset}`).setAttribute("aria-pressed", String(pressed));
    }
    try {
      showDateRange(CommaParser.dateFilter(prefs.date));
    } catch (error) {
      el("date-summary").textContent = errorMessage(error, "Choose a start and end date.");
      el("date-summary").classList.add("error");
    }
    const cameraCount = prefs.selectedTypes.filter(type => type.endsWith("camera")).length;
    el("camera-selection").textContent = cameraCount ? `${cameraCount} selected` : "Optional";
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
    state.lastOutcome = "";
    state.files = [];
    state.reviewAvailable = false;
    state.renderMore = null;
    state.view = "choose";
    el("routes-disclosure").open = false;
    el("results-content").hidden = true;
    el("empty-results").hidden = false;
    el("scan-status").hidden = true;
    el("scan-progress").hidden = true;
    el("transfer-card").hidden = true;
    el("file-preview").replaceChildren();
    el("scan-hint").textContent = "Scan to review";
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
      throw new Error("Cannot reach the source tab. Open it, sign in if needed, and reload the page. Then return here and tap Refresh.");
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
      const source = await readPage({ selectedTypes: FILE_TYPES });
      state.source = source;
      el("source-title").textContent = source.title || "comma useradmin";
      el("source-url").textContent = source.url;
      el("source-link").href = source.url;
      el("source-indicator").classList.add("connected");
      if (!state.scopeChosen || !scopeAvailable(settings().scope)) {
        setRadio("scope", source.pageKind === "route" ? "current" : "listed");
      }
      if (!scopeAvailable(settings().scope)) {
        showNotice("No device or route was found on this page. Open a device or route page in the source tab, then tap Refresh.");
        el("source-disclosure").open = true;
      } else if (!source.routes.length && !source.files.length && !source.deviceUrl) {
        showNotice("No uploaded files or listed routes were found. Check the source page, then tap Refresh.");
      }
      updateControls();
    } catch (error) {
      el("source-title").textContent = "Source page unavailable";
      el("source-disclosure").open = true;
      showNotice(errorMessage(error, "Unable to read the source page."), true);
    } finally {
      setMode("idle");
    }
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
    const groups = new Map();
    for (const file of files) {
      if (!groups.has(file.routeFolderName)) groups.set(file.routeFolderName, []);
      groups.get(file.routeFolderName).push(file);
    }
    el("route-count").textContent = `${groups.size} ${groups.size === 1 ? "route" : "routes"}`;
    el("scan-detail").textContent = detail;
    const entries = Array.from(groups);
    let shown = 0;
    el("file-preview").replaceChildren();
    el("routes-label").textContent = `Review ${groups.size} ${groups.size === 1 ? "route" : "routes"}`;
    el("routes-disclosure").hidden = !files.length;
    el("routes-disclosure").open = false;
    state.renderMore = () => {
      const preview = document.createDocumentFragment();
      for (const [routeName, routeFiles] of entries.slice(shown, shown + 10)) {
        const item = document.createElement("li");
        const group = document.createElement("details");
        group.className = "route-group";
        const summary = document.createElement("summary");
        const heading = document.createElement("span");
        heading.className = "route-heading";
        const name = document.createElement("span");
        name.className = "route-name";
        name.textContent = routeName;
        const date = document.createElement("span");
        date.className = "route-date";
        const recorded = settings().dateBasis === "recording";
        const routeDate = recorded ? routeFiles[0].recordingDate : routeFiles[0].uploadDate;
        date.textContent = routeDate ? `${recorded ? "Recorded" : "Uploaded"} ${routeDate}`
          : settings().scope === "current" ? "Current route"
          : `${recorded ? "Recording" : "Upload"} date unavailable`;
        heading.append(date, name);
        const counts = document.createElement("span");
        counts.className = "route-counts";
        const typeCounts = FILE_TYPES.map(type => {
          const count = routeFiles.filter(file => file.typeKey === type).length;
          return count ? `${count} ${type}` : null;
        }).filter(Boolean);
        counts.textContent = typeCounts.length === 1 ? typeCounts[0] : `${routeFiles.length} files`;
        summary.append(heading, counts);
        group.append(summary);
        // Only populate filenames when a route is expanded; every matched file is still archived.
        let expanded = false;
        group.addEventListener("toggle", () => {
          if (!group.open || expanded) return;
          expanded = true;
          const types = document.createElement("p");
          types.className = "route-types help";
          types.textContent = typeCounts.join(" · ");
          group.append(types);
          const filenames = document.createElement("ul");
          filenames.className = "route-files";
          for (const file of routeFiles) {
            const filename = document.createElement("li");
            filename.textContent = `${file.typeFolderName} / ${file.name}`;
            filenames.append(filename);
          }
          group.append(filenames);
        });
        item.append(group);
        preview.append(item);
      }
      el("file-preview").append(preview);
      shown = Math.min(shown + 10, entries.length);
      el("show-more-routes-button").hidden = shown >= entries.length;
      el("show-more-routes-button").textContent = `Show ${Math.min(10, entries.length - shown)} more routes`;
      el("preview-note").textContent = `${shown} of ${entries.length} routes shown. All matching files are included in the ZIP.`;
    };
    state.renderMore();
    el("file-preview").hidden = !files.length;
    el("preview-note").hidden = !files.length;
    el("scan-hint").textContent = files.length ? "Grouped by route" : "No matches";
  }

  async function scanFiles() {
    if (state.mode !== "idle" || !scopeAvailable(settings().scope)) return;
    const prefs = settings();
    let filter;
    try {
      if (!prefs.selectedTypes.length) throw new Error("Choose at least one file type.");
      filter = prefs.scope === "listed" ? CommaParser.dateFilter(prefs.date) : { mode: "all" };
      // A tab may have stayed open overnight. Display the exact range captured
      // for this scan, and keep it fixed while those results are being collected.
      if (prefs.scope === "listed") showDateRange(filter);
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
    summarizeSelection(prefs, filter);
    state.scannedSettings = JSON.stringify(prefs);
    state.reviewAvailable = true;
    setMode("scan");
    setView("review");
    el("empty-results").hidden = true;
    el("scan-progress").hidden = false;
    el("scan-progress").removeAttribute("value");
    scanStatus("Reading source page…");
    try {
      const result = await CommaScanner.scan({
        sourceUrl: expectedUrl, deviceUrl: state.source.deviceUrl,
        scope: prefs.scope, selectedTypes: prefs.selectedTypes,
        filter, dateBasis: prefs.dateBasis, signal: controller.signal,
        readPage: options => readPage({ ...options, expectedUrl, scanId }),
        cancelReads: () => cancelReadGroup(scanId),
        onProgress(progress) {
          if (controller.signal.aborted || state.scanController !== controller) return;
          scanStatus(`${progress.routesRead} routes checked · ${progress.filesFound} files found…`);
        }
      });
      const { files, pagesRead, filteredRoutes, undatedRoutes } = result;
      let detail = files.length ? "Sizes are checked while preparing the ZIP."
        : prefs.scope === "current" ? "No matching files on this route. Choose another file type or scan Device routes."
        : "No matching files. Choose another file type, a wider date range, or another device.";
      if (filteredRoutes) detail += ` ${filteredRoutes} ${filteredRoutes === 1 ? "route was" : "routes were"} excluded by the date filter.`;
      if (undatedRoutes) detail += ` ${undatedRoutes} had no readable ${prefs.dateBasis === "recording" ? "recording" : "upload"} date.`;
      showResults(files, detail);
      scanStatus(`Scan complete · ${pagesRead} ${pagesRead === 1 ? "page" : "pages"} checked`);
    } catch (error) {
      state.lastOutcome = controller.signal.aborted ? "Scan cancelled" : "Scan failed · review the details";
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

  async function cancelReadGroup(scanId) {
    if (scanId && Number.isSafeInteger(sourceTabId)) {
      await browser.tabs.sendMessage(sourceTabId, { type: "comma:cancel-read", scanId }).catch(() => {});
    }
  }

  function cancelScan() {
    const scanId = state.scanId;
    state.scanController?.abort();
    el("cancel-scan-button").disabled = true;
    scanStatus("Stopping scan…");
    void cancelReadGroup(scanId);
  }

  function transferStatus(message, isError = false) {
    el("transfer-status").textContent = message;
    el("transfer-status").classList.toggle("error", isError);
  }

  async function prepareZip() {
    if (state.mode !== "idle" || !state.files.length || state.archive) return;
    state.lastOutcome = "";
    showNotice("");
    const controller = new AbortController();
    state.buildController = controller;
    setMode("build");
    setView("review");
    el("routes-disclosure").open = false;
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
          el("action-summary").textContent = `${done} / ${total} files · ${formatBytes(progress.bytesReceived)} received`;
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
      el("transfer-detail").textContent = `${archive.count} files · ${formatBytes(archive.bytes)}`;
      el("save-note").textContent = "Tap Save ZIP, then confirm the save in Firefox Downloads.";
    } catch (error) {
      state.lastOutcome = controller.signal.aborted ? "Preparation cancelled" : "ZIP could not be prepared";
      transferStatus(state.lastOutcome, !controller.signal.aborted);
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
      // Preserve the meaning of ranges saved by the upload-only v0.2 release.
      setRadio("date-basis", ["upload", "recording"].includes(saved.dateBasis) ? saved.dateBasis : "upload");
      if (["current", "listed"].includes(saved.scope)) {
        setRadio("scope", saved.scope);
        state.scopeChosen = true;
      }
      if (Array.isArray(saved.selectedTypes) && saved.selectedTypes.some(type => FILE_TYPES.includes(type))) {
        for (const input of document.querySelectorAll('input[name="file-type"]')) input.checked = saved.selectedTypes.includes(input.value);
      }
      if (["recent", "all", "custom"].includes(saved.date?.mode)) setRadio("date-mode", saved.date.mode);
      if (/^\d{1,5}$/.test(String(saved.date?.days))) el("date-days").value = saved.date.days;
      if (/^\d{4}-\d{2}-\d{2}$/.test(saved.date?.from)) el("date-from").value = saved.date.from;
      if (/^\d{4}-\d{2}-\d{2}$/.test(saved.date?.to)) el("date-to").value = saved.date.to;
    } catch {
      showNotice("Saved choices could not be loaded. You can still scan and download logs.");
    }
  }

  function settingsChanged() {
    // Tapping an already-selected preset must not destroy a prepared archive.
    if (state.reviewAvailable && JSON.stringify(settings()) === state.scannedSettings) {
      updateControls();
      return;
    }
    invalidateResults();
    updateControls();
    void browser.storage.local.set({ [PREF_KEY]: settings() }).catch(() => showNotice("Your choices could not be saved. This scan can still continue."));
  }

  el("settings-form").addEventListener("submit", event => event.preventDefault());
  el("settings-form").addEventListener("change", event => {
    if (state.mode !== "idle") return;
    if (event.target.name === "scope") state.scopeChosen = true;
    if (event.target.id === "date-days") {
      state.daysEditor = true;
      setRadio("date-mode", "recent");
    }
    if (["date-from", "date-to"].includes(event.target.id)) setRadio("date-mode", "custom");
    settingsChanged();
  });
  el("settings-form").addEventListener("input", event => {
    if (state.mode !== "idle") return;
    if (event.target.id === "date-days") {
      state.daysEditor = true;
      setRadio("date-mode", "recent");
    }
    else if (["date-from", "date-to"].includes(event.target.id)) setRadio("date-mode", "custom");
    else return;
    settingsChanged();
  });
  for (const preset of ["1", "7", "30", "all", "custom"]) {
    el(`date-preset-${preset}`).addEventListener("click", () => {
      if (state.mode !== "idle") return;
      state.daysEditor = false;
      if (preset === "all" || preset === "custom") {
        setRadio("date-mode", preset);
        if (preset === "custom" && (!el("date-from").value || !el("date-to").value)) {
          const range = CommaParser.dateFilter({ mode: "recent", days: 7 });
          if (!el("date-from").value) el("date-from").value = range.fromDate;
          if (!el("date-to").value) el("date-to").value = range.toDate;
        }
      } else {
        setRadio("date-mode", "recent");
        el("date-days").value = preset;
      }
      settingsChanged();
    });
  }
  el("edit-days-button").addEventListener("click", () => {
    if (state.mode !== "idle") return;
    state.daysEditor = true;
    const wasRecent = settings().date.mode === "recent";
    setRadio("date-mode", "recent");
    // Merely revealing the existing day count does not change the selection.
    if (wasRecent) updateControls();
    else settingsChanged();
    el("date-days").focus?.();
  });
  el("edit-filters-button").addEventListener("click", () => {
    if (state.mode === "idle") setView("choose");
  });
  el("review-button").addEventListener("click", () => {
    if (state.mode === "idle") setView("review");
  });
  el("show-more-routes-button").addEventListener("click", () => state.renderMore?.());
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
    el("save-note").textContent = "Check Firefox Downloads to confirm the save. This tab cannot confirm completion; you can tap Save ZIP again.";
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
