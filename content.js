const state = {
  directory: null,
  existingNames: new Set(),
  running: false,
  cancelled: false,
  activePort: null,
  totals: {
    routes: 0,
    expectedFiles: 0,
    files: 0,
    saved: 0,
    skipped: 0,
    failed: 0
  }
};

const PAGE_FETCH_TIMEOUT_MS = 45000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 90000;
const ROUTE_DISCOVERY_CONCURRENCY = 4;
const DEFAULT_ROUTE_DATE_FILTER_DAYS = 7;
const LOG_PREFIX = "[useradmin-route-log-downloader]";
const DEBUG_LOGGING = false;
const LOG_TYPES = [
  { key: "rlog", fileName: "rlog.zst", folderName: "rlog", checked: true },
  { key: "qlog", fileName: "qlog.zst", folderName: "qlog", checked: false },
  { key: "qcamera", fileName: "qcamera.ts", folderName: "qcamera", checked: false },
  { key: "fcamera", fileName: "fcamera.hevc", folderName: "fcamera", checked: false },
  { key: "ecamera", fileName: "ecamera.hevc", folderName: "ecamera", checked: false },
  { key: "dcamera", fileName: "dcamera.hevc", folderName: "dcamera", checked: false }
];
const LOG_TYPE_SELECTION_STORAGE_KEY = "selectedLogTypes";
const ROUTE_DATE_FILTER_STORAGE_KEY = "routeDateFilter";

const panel = createPanel();
document.documentElement.append(panel.root);
window.addEventListener("beforeunload", warnBeforeUnload);
restoreSelectedLogTypes();
restoreRouteDateFilter();
refreshControls();
log("page actions", getPageActions());

function createPanel() {
  const root = document.createElement("div");
  root.id = "useradmin-route-log-downloader";

  const actions = document.createElement("div");
  actions.className = "useradmin-route-log-actions";

  const folderButton = createButton("Select DL Folder", chooseFolder);
  const routeButton = createButton("D/L Route", () => runCurrentRoute());
  const listedButton = createButton("D/L Routes", () => runListedRoutes());
  const stopButton = createButton("Stop", stopRun);
  stopButton.dataset.role = "stop";

  actions.append(folderButton, routeButton, listedButton, stopButton);

  const typeControls = document.createElement("div");
  typeControls.className = "useradmin-route-log-types";
  const typeInputs = new Map();

  for (const type of LOG_TYPES) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = type.key;
    input.checked = type.checked;
    input.addEventListener("change", () => {
      saveSelectedLogTypes();
      refreshControls();
    });

    label.append(input, document.createTextNode(type.key));
    typeControls.append(label);
    typeInputs.set(type.key, input);
  }

  const dateFilter = createDateFilter();

  const notice = document.createElement("div");
  notice.className = "useradmin-route-log-notice";
  notice.textContent = "Keep this page open while downloads are running.";

  const overallProgress = document.createElement("progress");
  overallProgress.className = "useradmin-route-log-progress";
  overallProgress.max = 1;
  overallProgress.value = 0;
  overallProgress.hidden = true;

  const overallProgressText = document.createElement("div");
  overallProgressText.className = "useradmin-route-log-progress-text";
  overallProgressText.hidden = true;

  const fileProgress = document.createElement("progress");
  fileProgress.className = "useradmin-route-log-progress useradmin-route-log-progress-file";
  fileProgress.max = 1;
  fileProgress.value = 0;
  fileProgress.hidden = true;

  const fileProgressText = document.createElement("div");
  fileProgressText.className = "useradmin-route-log-progress-text";
  fileProgressText.hidden = true;

  const status = document.createElement("div");
  status.className = "useradmin-route-log-status";
  status.textContent = supportsDirectoryPicker() ? "" : "Directory picker unavailable";
  status.hidden = !status.textContent;

  const detail = document.createElement("div");
  detail.className = "useradmin-route-log-detail";
  detail.hidden = true;

  root.append(
    actions,
    typeControls,
    dateFilter.root,
    notice,
    overallProgress,
    overallProgressText,
    fileProgress,
    fileProgressText,
    status,
    detail
  );

  return {
    root,
    folderButton,
    routeButton,
    listedButton,
    stopButton,
    typeInputs,
    dateFilter,
    notice,
    overallProgress,
    overallProgressText,
    fileProgress,
    fileProgressText,
    status,
    detail
  };
}

function createDateFilter() {
  const root = document.createElement("div");
  root.className = "useradmin-route-log-date-filter";

  const modeName = "useradmin-route-log-route-date-filter";
  const recentRadio = createRadio(modeName, "recent", true);
  const allRadio = createRadio(modeName, "all", false);
  const customRadio = createRadio(modeName, "custom", false);

  recentRadio.id = "useradmin-route-log-date-recent";
  allRadio.id = "useradmin-route-log-date-all";
  customRadio.id = "useradmin-route-log-date-custom";

  const daysInput = document.createElement("input");
  daysInput.type = "number";
  daysInput.min = "1";
  daysInput.step = "1";
  daysInput.value = String(DEFAULT_ROUTE_DATE_FILTER_DAYS);

  const today = new Date();
  const fromInput = document.createElement("input");
  fromInput.type = "date";
  fromInput.value = formatDateInputValue(addDays(today, -DEFAULT_ROUTE_DATE_FILTER_DAYS));

  const toInput = document.createElement("input");
  toInput.type = "date";
  toInput.value = formatDateInputValue(today);

  const recentRow = document.createElement("div");
  recentRow.className = "useradmin-route-log-date-row";
  const recentText = document.createElement("span");
  recentText.append(
    document.createTextNode("Download past "),
    daysInput,
    document.createTextNode(" days")
  );
  recentRow.append(
    recentRadio,
    recentText
  );

  const allRow = document.createElement("div");
  allRow.className = "useradmin-route-log-date-row";
  allRow.append(allRadio, document.createTextNode("Download All"));

  const custom = document.createElement("div");
  custom.className = "useradmin-route-log-date-custom";

  const customRow = document.createElement("div");
  customRow.className = "useradmin-route-log-date-row";
  customRow.append(customRadio, document.createTextNode("Custom Range"));

  const customDates = document.createElement("div");
  customDates.className = "useradmin-route-log-date-inputs";

  const fromLabel = document.createElement("label");
  fromLabel.append(document.createTextNode("from"), fromInput);

  const toLabel = document.createElement("label");
  toLabel.append(document.createTextNode("to"), toInput);

  customDates.append(fromLabel, toLabel);
  custom.append(customRow, customDates);
  root.append(recentRow, allRow, custom);

  daysInput.addEventListener("input", () => {
    recentRadio.checked = true;
    saveRouteDateFilter();
    refreshControls();
  });

  fromInput.addEventListener("input", () => {
    customRadio.checked = true;
    saveRouteDateFilter();
    refreshControls();
  });

  toInput.addEventListener("input", () => {
    customRadio.checked = true;
    saveRouteDateFilter();
    refreshControls();
  });

  for (const radio of [recentRadio, allRadio, customRadio]) {
    radio.addEventListener("change", () => {
      saveRouteDateFilter();
      refreshControls();
    });
  }

  return {
    root,
    recentRadio,
    allRadio,
    customRadio,
    daysInput,
    fromInput,
    toInput
  };
}

function createRadio(name, value, checked) {
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  return input;
}

function createButton(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === "function";
}

async function chooseFolder() {
  if (!supportsDirectoryPicker()) {
    setStatus("Directory picker unavailable");
    return false;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      setStatus("Folder permission denied");
      return false;
    }

    state.directory = handle;
    state.existingNames = await scanExistingNames(handle);
    log("folder selected", { existingFiles: state.existingNames.size });
    setStatus(`${state.existingNames.size} existing files indexed`);
    refreshControls();
    return true;
  } catch (error) {
    if (error?.name !== "AbortError") {
      logWarning("folder selection failed", { error: error?.message || String(error) });
      setStatus(error?.message || String(error));
    }
    refreshControls();
    return false;
  }
}

async function ensureFolder() {
  if (state.directory) {
    return true;
  }

  return chooseFolder();
}

async function scanExistingNames(directoryHandle) {
  const names = new Set();
  await collectExistingNames(directoryHandle, names, "");
  return names;
}

async function collectExistingNames(directoryHandle, names, prefix) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "file") {
      names.add(normalizePath(`${prefix}${name}`));
      continue;
    }

    if (handle.kind === "directory") {
      await collectExistingNames(handle, names, `${prefix}${name}/`);
    }
  }
}

async function runCurrentRoute() {
  if (state.running || !(await ensureFolder())) {
    return;
  }

  const selectedTypes = getSelectedLogTypes();
  if (!selectedTypes.length) {
    setStatus("Select a file type");
    return;
  }

  startRun();
  try {
    const files = collectLogFiles(document, selectedTypes, location.href);
    log("current route files", { count: files.length, types: selectedTypes, url: location.href });
    state.totals.routes = files.length ? 1 : 0;
    state.totals.expectedFiles = files.length;
    updateOverallProgressBar();
    if (!files.length) {
      setDetail("No selected files found");
    }
    await downloadFiles(files, "current route");
    finishRun();
  } catch (error) {
    if (state.cancelled) {
      finishRun();
    } else {
      failRun(error);
    }
  }
}

async function runListedRoutes() {
  if (state.running || !(await ensureFolder())) {
    return;
  }

  const selectedTypes = getSelectedLogTypes();
  if (!selectedTypes.length) {
    setStatus("Select a file type");
    return;
  }

  const routeDateFilter = getRouteDateFilter();
  if (!routeDateFilter) {
    setStatus("Select a valid date range");
    return;
  }

  startRun();
  let routeBatchQueue = null;
  let downloadTask = null;
  try {
    log("listed routes started", { types: selectedTypes, dateFilter: summarizeRouteDateFilter(routeDateFilter), url: location.href });
    let pageUrl = location.href;
    let pageCount = 0;
    const seenRoutes = new Set();
    let routeBatchCount = 0;
    let downloadError = null;
    routeBatchQueue = createRouteBatchQueue();
    downloadTask = downloadRouteBatches(routeBatchQueue).catch((error) => {
      downloadError = error;
      routeBatchQueue.cancel();
    });

    setOverallProgressPending("Finding files");

    while (pageUrl && !state.cancelled && !downloadError) {
      pageCount += 1;
      if (pageCount > 100) {
        throw new Error("Page limit reached");
      }

      setStatus(`Reading route page ${pageCount}`);
      const pageDocument = pageCount === 1
        ? document
        : await fetchDocument(pageUrl);

      const pageRoutes = collectRouteLinks(pageDocument, pageUrl);
      const routes = pageRoutes
        .filter((route) => routeMatchesDateFilter(route, routeDateFilter))
        .filter((route) => {
          if (seenRoutes.has(route.key)) {
            return false;
          }
          seenRoutes.add(route.key);
          return true;
        });
      log("route page read", {
        page: pageCount,
        routes: pageRoutes.length,
        selectedRoutes: routes.length,
        url: pageUrl
      });

      if (!pageRoutes.length) {
        log("route pagination stopped", {
          page: pageCount,
          reason: "no route links"
        });
        break;
      }

      if (routes.length) {
        setStatus(`Reading ${routes.length} routes`);
        routeBatchCount += await discoverRouteFiles(routes, selectedTypes, routeBatchQueue);
        if (downloadError) {
          throw downloadError;
        }
      }

      if (shouldStopRoutePagination(pageRoutes, routeDateFilter)) {
        log("route pagination stopped", {
          page: pageCount,
          reason: "date range complete"
        });
        break;
      }

      pageUrl = getNextPageUrl(pageDocument, pageUrl);
    }

    routeBatchQueue.close();
    await downloadTask;
    if (downloadError) {
      throw downloadError;
    }

    if (!state.cancelled && routeBatchCount) {
      log("listed route files discovered", {
        routes: routeBatchCount,
        files: state.totals.expectedFiles
      });
    }

    if (!state.cancelled && !state.totals.expectedFiles) {
      resetOverallProgressBar();
      setDetail("No selected files found");
    }

    finishRun();
  } catch (error) {
    const wasCancelled = state.cancelled;
    if (!wasCancelled) {
      state.cancelled = true;
      if (state.activePort) {
        state.activePort.disconnect();
        state.activePort = null;
      }
    }
    if (routeBatchQueue) {
      routeBatchQueue.cancel();
    }
    if (downloadTask) {
      await downloadTask.catch(() => {});
    }
    if (wasCancelled) {
      finishRun();
    } else {
      failRun(error);
    }
  }
}

function startRun() {
  state.running = true;
  state.cancelled = false;
  state.totals = {
    routes: 0,
    expectedFiles: 0,
    files: 0,
    saved: 0,
    skipped: 0,
    failed: 0
  };
  setDetail("");
  resetOverallProgressBar();
  resetFileProgressBar();
  setStatus("Starting");
  log("run started");
  refreshControls();
}

function finishRun() {
  const prefix = state.cancelled ? "Stopped" : "Complete";
  setStatus(`${prefix}: ${state.totals.saved} saved, ${state.totals.skipped} skipped, ${state.totals.failed} failed`);
  log("run finished", { cancelled: state.cancelled, totals: { ...state.totals } });
  state.running = false;
  state.cancelled = false;
  state.activePort = null;
  resetFileProgressBar();
  refreshControls();
}

function failRun(error) {
  state.running = false;
  state.cancelled = false;
  state.activePort = null;
  state.totals.failed += 1;
  resetOverallProgressBar();
  resetFileProgressBar();
  logError("run failed", { error: error?.message || String(error), totals: { ...state.totals } });
  setStatus(error?.message || String(error));
  refreshControls();
}

function stopRun() {
  state.cancelled = true;
  if (state.activePort) {
    state.activePort.disconnect();
    state.activePort = null;
  }
  log("stop requested", { totals: { ...state.totals } });
  setStatus("Stopping");
  refreshControls();
}

async function downloadFiles(files, routeName) {
  let skippedInRoute = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (state.cancelled) {
      break;
    }

    state.totals.files += 1;

    const targetPath = getTargetPath(file);
    if (state.existingNames.has(normalizePath(targetPath))) {
      state.totals.skipped += 1;
      skippedInRoute += 1;
      resetFileProgressBar();
      setDetail(`exists: ${index + 1}/${files.length} ${targetPath}`);
      updateProgress();
      continue;
    }

    setStatus(`${routeName}: ${index + 1}/${files.length}`);
    setDetail(`starting: ${targetPath}`);
    updateFileProgressBar(0, 0);
    log("file download started", {
      route: routeName,
      index: index + 1,
      total: files.length,
      targetPath,
      url: file.url
    });
    const saved = await saveFile(file);
    if (saved) {
      state.existingNames.add(normalizePath(targetPath));
      state.totals.saved += 1;
      log("file saved", { targetPath });
    }
    updateProgress();
  }

  if (skippedInRoute) {
    log("route files skipped", {
      route: routeName,
      skipped: skippedInRoute
    });
  }
  resetFileProgressBar();
}

async function discoverRouteFiles(routes, selectedTypes, routeBatchQueue) {
  let nextIndex = 0;
  let batchCount = 0;

  async function worker() {
    while (!state.cancelled) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= routes.length) {
        return;
      }

      const route = routes[index];
      state.totals.routes += 1;
      log("route read started", { route: route.name, url: route.url });
      const routeDocument = await fetchDocument(route.url);
      const files = collectLogFiles(routeDocument, selectedTypes, route.url);
      log("route files found", { route: route.name, files: files.length, types: selectedTypes });

      if (!files.length) {
        continue;
      }

      batchCount += 1;
      state.totals.expectedFiles += files.length;
      updateOverallProgressBar();
      routeBatchQueue.enqueue({
        name: route.name,
        files
      });
    }
  }

  const workers = Array.from(
    { length: Math.min(ROUTE_DISCOVERY_CONCURRENCY, routes.length) },
    () => worker()
  );
  await Promise.all(workers);
  return batchCount;
}

function createRouteBatchQueue() {
  const batches = [];
  const waiters = [];
  let closed = false;

  return {
    enqueue(batch) {
      if (closed) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter({ batch, done: false });
        return;
      }

      batches.push(batch);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      while (waiters.length) {
        waiters.shift()({ done: true });
      }
    },
    cancel() {
      batches.length = 0;
      this.close();
    },
    next() {
      if (batches.length) {
        return Promise.resolve({ batch: batches.shift(), done: false });
      }

      if (closed) {
        return Promise.resolve({ done: true });
      }

      return new Promise((resolve) => waiters.push(resolve));
    }
  };
}

async function downloadRouteBatches(routeBatchQueue) {
  while (!state.cancelled) {
    const { batch, done } = await routeBatchQueue.next();
    if (done) {
      return;
    }

    await downloadFiles(batch.files, batch.name);
  }
}

async function saveFile(file) {
  const routeHandle = await state.directory.getDirectoryHandle(file.routeFolderName, { create: true });
  const typeHandle = await routeHandle.getDirectoryHandle(file.typeFolderName, { create: true });
  const fileHandle = await typeHandle.getFileHandle(file.name, { create: true });
  const writer = await fileHandle.createWritable();
  const targetPath = getTargetPath(file);

  try {
    await streamToWriter(file.url, writer, (received, size) => {
      updateFileProgressBar(received, size);
      const amount = size
        ? `${formatBytes(received)} / ${formatBytes(size)}`
        : formatBytes(received);
      setDetail(`${amount}: ${targetPath}`);
    });
    await writer.close();
    return true;
  } catch (error) {
    try {
      await writer.abort();
    } catch {
      await writer.close().catch(() => {});
    }

    await typeHandle.removeEntry(file.name).catch(() => {});
    if (!state.cancelled) {
      state.totals.failed += 1;
      logWarning("file failed", { targetPath, error: error?.message || String(error) });
      setDetail(`${error?.message || String(error)}: ${targetPath}`);
    }
    return false;
  }
}

function streamToWriter(url, writer, onProgress) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const port = chrome.runtime.connect({ name: "useradmin-route-log-fetch" });
    let writeChain = Promise.resolve();
    let totalSize = 0;
    let settled = false;
    let lastProgressAt = 0;
    let idleTimer = setIdleTimer();

    state.activePort = port;

    function setIdleTimer() {
      return window.setTimeout(() => {
        if (!settled) {
          settled = true;
          logError("download stream idle timeout", { url, timeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS });
          port.disconnect();
          reject(new Error("Download timed out"));
        }
      }, DOWNLOAD_IDLE_TIMEOUT_MS);
    }

    function resetIdleTimer() {
      window.clearTimeout(idleTimer);
      idleTimer = setIdleTimer();
    }

    function clearIdleTimer() {
      window.clearTimeout(idleTimer);
    }

    port.onMessage.addListener((message) => {
      if (message.id !== id || settled) {
        return;
      }

      resetIdleTimer();

      if (message.type === "meta") {
        totalSize = message.size || 0;
        onProgress(0, totalSize);
        return;
      }

      if (message.type === "chunk") {
        writeChain = writeChain
          .then(() => writer.write(base64ToBytes(message.data)))
          .then(() => {
            const now = performance.now();
            if (now - lastProgressAt >= 500 || (totalSize && message.received >= totalSize)) {
              lastProgressAt = now;
              onProgress(message.received || 0, totalSize);
            }
            port.postMessage({
              type: "ack",
              id,
              sequence: message.sequence
            });
          })
          .catch((error) => {
            settled = true;
            clearIdleTimer();
            logError("download writer failed", { url, error: error?.message || String(error) });
            port.disconnect();
            reject(error);
          });
        return;
      }

      if (message.type === "done") {
        settled = true;
        clearIdleTimer();
        writeChain
          .then(() => {
            if (state.activePort === port) {
              state.activePort = null;
            }
            port.disconnect();
            resolve();
          })
          .catch(reject);
        return;
      }

      if (message.type === "error") {
        settled = true;
        clearIdleTimer();
        logError("download stream error", { url, error: message.message });
        if (state.activePort === port) {
          state.activePort = null;
        }
        port.disconnect();
        reject(new Error(message.message));
      }
    });

    port.onDisconnect.addListener(() => {
      if (state.activePort === port) {
        state.activePort = null;
      }

      if (!settled) {
        settled = true;
        clearIdleTimer();
        if (!state.cancelled) {
          logWarning("download stream disconnected", { url });
        }
        reject(new Error(state.cancelled ? "Stopped" : "Download connection closed"));
      }
    });

    port.postMessage({ type: "start", id, url, idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS });
  });
}

async function fetchDocument(url) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);

  try {
    log("page read started", { url });
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    log("page read finished", { url, bytes: html.length });
    return new DOMParser().parseFromString(html, "text/html");
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Page read timed out");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function collectRouteLinks(doc, baseUrl) {
  const routes = [];
  const routePattern = /^[^/\s|]+\/[0-9a-f]{8}--[0-9a-f]+$/i;

  for (const link of doc.querySelectorAll('a[href*="onebox="]')) {
    const name = link.textContent.trim();
    if (!routePattern.test(name)) {
      continue;
    }

    let url;
    try {
      url = new URL(link.getAttribute("href"), baseUrl);
    } catch {
      continue;
    }

    const onebox = url.searchParams.get("onebox") || "";
    if (!onebox.includes("|") && !onebox.includes("/")) {
      continue;
    }

    routes.push({
      key: normalizeRouteKey(name),
      name,
      url: url.href,
      uploadedAt: getRouteUploadTime(link)
    });
  }

  return routes;
}

function getRouteUploadTime(link) {
  const row = link.closest("tr");
  const uploadText = row?.cells?.[0]?.textContent.trim() || "";
  return parseRouteUploadTime(uploadText);
}

function parseRouteUploadTime(text) {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const date = new Date(year, month, day, hour, minute, second);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
  ) {
    return null;
  }

  return date;
}

function routeMatchesDateFilter(route, filter) {
  if (filter.mode === "all") {
    return true;
  }

  if (!route.uploadedAt) {
    return false;
  }

  const timestamp = route.uploadedAt.getTime();
  return (!filter.from || timestamp >= filter.from.getTime())
    && (!filter.to || timestamp <= filter.to.getTime());
}

function shouldStopRoutePagination(routes, filter) {
  if (filter.mode === "all" || !filter.from) {
    return false;
  }

  const datedRoutes = routes.filter((route) => route.uploadedAt);
  return datedRoutes.length > 0
    && datedRoutes.every((route) => route.uploadedAt.getTime() < filter.from.getTime());
}

function collectLogFiles(doc, selectedTypes, baseUrl) {
  const files = [];
  const seen = new Set();
  const selected = new Set(selectedTypes);

  for (const link of doc.querySelectorAll("a[href]")) {
    let href;
    try {
      href = new URL(link.getAttribute("href"), baseUrl).href;
    } catch {
      continue;
    }

    const type = getLogTypeForLink(link, href);
    if (!type || !selected.has(type.key) || href.includes("/bootlogs/")) {
      continue;
    }

    const name = getDownloadName(href);
    const routeFolderName = getRouteFolderName(href);
    const targetPath = `${routeFolderName}/${type.folderName}/${name}`;
    if (seen.has(targetPath)) {
      continue;
    }

    seen.add(targetPath);
    files.push({
      url: href,
      name,
      routeFolderName,
      typeFolderName: type.folderName,
      typeKey: type.key
    });
  }

  files.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  return files;
}

function getLogTypeForLink(link, href) {
  const label = link.textContent.trim();
  return LOG_TYPES.find((type) => label === type.fileName && href.includes(`/${type.fileName}`));
}

function getNextPageUrl(doc, baseUrl) {
  const declaredRoutes = getDeclaredRouteCount(doc);
  const visibleRoutes = getRouteTableLinkCount(doc, baseUrl);
  if (declaredRoutes !== null && visibleRoutes >= declaredRoutes) {
    log("route pagination skipped", {
      declaredRoutes,
      visibleRoutes
    });
    return "";
  }

  const loadMore = Array.from(doc.querySelectorAll("a[onclick]"))
    .map((link) => link.getAttribute("onclick") || "")
    .map((onclick) => onclick.match(/loadMoreRoutes\((\d+)\)/))
    .find(Boolean);

  if (!loadMore) {
    return "";
  }

  const url = new URL(baseUrl);
  url.searchParams.set("page", String(Number(loadMore[1]) + 1));
  return url.href;
}

function getDeclaredRouteCount(doc) {
  for (const summary of doc.querySelectorAll("summary")) {
    const match = summary.textContent.trim().match(/^routes\s*\((\d+)\)/i);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function getRouteTableLinkCount(doc, baseUrl) {
  const table = doc.querySelector("#table_routes");
  if (!table) {
    return 0;
  }

  return collectRouteLinks(table, baseUrl).length;
}

function getDownloadName(url) {
  const parsed = new URL(url);
  const disposition = parsed.searchParams.get("rscd") || "";
  const dispositionName = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);

  if (dispositionName) {
    return sanitizeFileName(decodeURIComponent(dispositionName[1] || dispositionName[2]));
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const fileName = parts.at(-1) || "segment.log";
  const segment = parts.at(-2) || "segment";
  const route = parts.at(-3) || "route";
  const dongle = parts.at(-4) || "device";
  return sanitizeFileName(`${dongle}_${route}--${segment}--${fileName}`);
}

function getRouteFolderName(url) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const fileName = getDownloadName(url);
  const fallback = fileName.match(/^(.+?)_([0-9a-f]{8}--[0-9a-f]+)--\d+--/i);

  const dongle = parts.at(-4) || fallback?.[1] || "route";
  const route = parts.at(-3) || fallback?.[2] || "unknown";
  return sanitizeFileName(`${dongle}__${route}`);
}

function getTargetPath(file) {
  return `${file.routeFolderName}/${file.typeFolderName}/${file.name}`;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").toLowerCase();
}

function normalizeRouteKey(name) {
  return name.replace("/", "|").toLowerCase();
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function setStatus(text) {
  panel.status.textContent = text;
  panel.status.hidden = !text;
}

function setDetail(text) {
  panel.detail.textContent = text;
  panel.detail.hidden = !text;
}

function updateProgress() {
  updateOverallProgressBar();
  setStatus(`${state.totals.saved} saved, ${state.totals.skipped} skipped, ${state.totals.failed} failed`);
}

function setOverallProgressPending(text) {
  panel.overallProgress.hidden = false;
  panel.overallProgress.removeAttribute("value");
  panel.overallProgressText.hidden = false;
  panel.overallProgressText.textContent = text;
}

function updateOverallProgressBar() {
  if (!state.totals.expectedFiles) {
    resetOverallProgressBar();
    return;
  }

  const completed = Math.min(
    state.totals.saved + state.totals.skipped + state.totals.failed,
    state.totals.expectedFiles
  );

  panel.overallProgress.hidden = false;
  panel.overallProgress.max = state.totals.expectedFiles;
  panel.overallProgress.value = completed;
  panel.overallProgressText.hidden = false;
  const percent = Math.floor((completed / state.totals.expectedFiles) * 100);
  panel.overallProgressText.textContent = `${completed}/${state.totals.expectedFiles} files (${percent}%)`;
}

function updateFileProgressBar(received, size) {
  panel.fileProgress.hidden = false;
  panel.fileProgressText.hidden = false;

  if (size) {
    panel.fileProgress.max = size;
    panel.fileProgress.value = Math.min(received, size);
    const percent = Math.floor((Math.min(received, size) / size) * 100);
    panel.fileProgressText.textContent = `${percent}% current file (${formatBytes(received)})`;
    return;
  }

  panel.fileProgress.removeAttribute("value");
  panel.fileProgressText.textContent = received
    ? `Receiving current file (${formatBytes(received)})`
    : "Receiving current file";
}

function resetOverallProgressBar() {
  panel.overallProgress.hidden = true;
  panel.overallProgress.max = 1;
  panel.overallProgress.value = 0;
  panel.overallProgressText.hidden = true;
  panel.overallProgressText.textContent = "";
}

function resetFileProgressBar() {
  panel.fileProgress.hidden = true;
  panel.fileProgress.max = 1;
  panel.fileProgress.value = 0;
  panel.fileProgressText.hidden = true;
  panel.fileProgressText.textContent = "";
}

function refreshControls() {
  const hasFolder = Boolean(state.directory);
  const canUsePicker = supportsDirectoryPicker();
  const pageActions = getPageActions();
  const hasSelectedTypes = getSelectedLogTypes().length > 0;
  const hasValidDateFilter = isRouteDateFilterReady();

  panel.folderButton.disabled = state.running || !canUsePicker;
  panel.routeButton.disabled = state.running || !canUsePicker || !hasSelectedTypes;
  panel.listedButton.disabled = state.running || !canUsePicker || !hasSelectedTypes || !hasValidDateFilter;
  panel.stopButton.disabled = !state.running;
  panel.routeButton.hidden = !pageActions.canDownloadRoute;
  panel.listedButton.hidden = !pageActions.canDownloadListedRoutes;
  panel.stopButton.hidden = !state.running;
  panel.dateFilter.root.dataset.active = String(pageActions.canDownloadListedRoutes);
  panel.notice.hidden = !state.running;
  for (const input of panel.typeInputs.values()) {
    input.disabled = state.running;
  }
  refreshDateFilterControls();

  if (hasFolder) {
    panel.root.dataset.folder = "selected";
  } else {
    delete panel.root.dataset.folder;
  }
}

function getPageActions() {
  const supportedTypes = LOG_TYPES.map((type) => type.key);
  return {
    canDownloadRoute: collectLogFiles(document, supportedTypes, location.href).length > 0,
    canDownloadListedRoutes: collectRouteLinks(document, location.href).length > 0
  };
}

function getSelectedLogTypes() {
  return Array.from(panel.typeInputs.values())
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function refreshDateFilterControls() {
  const controls = panel.dateFilter;
  const mode = getRouteDateFilterMode();
  const inactive = controls.root.dataset.active !== "true";

  controls.daysInput.disabled = inactive || state.running || mode !== "recent";
  controls.fromInput.disabled = inactive || state.running || mode !== "custom";
  controls.toInput.disabled = inactive || state.running || mode !== "custom";
  controls.recentRadio.disabled = inactive || state.running;
  controls.allRadio.disabled = inactive || state.running;
  controls.customRadio.disabled = inactive || state.running;
}

function getRouteDateFilterMode() {
  const controls = panel.dateFilter;
  if (controls.allRadio.checked) {
    return "all";
  }
  if (controls.customRadio.checked) {
    return "custom";
  }
  return "recent";
}

function isRouteDateFilterReady() {
  return Boolean(getRouteDateFilter());
}

function getRouteDateFilter() {
  const controls = panel.dateFilter;
  const mode = getRouteDateFilterMode();

  if (mode === "all") {
    return { mode };
  }

  if (mode === "recent") {
    const days = parseRouteDayCount(controls.daysInput.value);
    if (!days) {
      return null;
    }
    const now = new Date();

    return {
      mode,
      from: startOfDay(addDays(now, -days)),
      to: endOfDay(now)
    };
  }

  const from = parseDateInputValue(controls.fromInput.value, false);
  const to = parseDateInputValue(controls.toInput.value, true);
  if (!from || !to || from.getTime() > to.getTime()) {
    return null;
  }

  return { mode, from, to };
}

function summarizeRouteDateFilter(filter) {
  if (filter.mode === "all") {
    return { mode: filter.mode };
  }

  return {
    mode: filter.mode,
    from: filter.from.toISOString(),
    to: filter.to.toISOString()
  };
}

function parseDateInputValue(value, endOfDay) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(
    year,
    month,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  );
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }

  return date;
}

function formatDateInputValue(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function saveRouteDateFilter() {
  const storage = getExtensionStorage();
  if (!storage) {
    return;
  }

  storage.set(
    { [ROUTE_DATE_FILTER_STORAGE_KEY]: getRouteDateFilterSettings() },
    reportStorageError("settings save failed")
  );
}

function restoreRouteDateFilter() {
  const storage = getExtensionStorage();
  if (!storage) {
    return;
  }

  storage.get(ROUTE_DATE_FILTER_STORAGE_KEY, (items) => {
    const error = getStorageError();
    if (error) {
      logWarning("settings restore failed", { error });
      return;
    }

    applyRouteDateFilterSettings(items?.[ROUTE_DATE_FILTER_STORAGE_KEY]);
    refreshControls();
  });
}

function getRouteDateFilterSettings() {
  const controls = panel.dateFilter;
  return {
    mode: getRouteDateFilterMode(),
    days: controls.daysInput.value,
    from: controls.fromInput.value,
    to: controls.toInput.value
  };
}

function applyRouteDateFilterSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return;
  }

  const controls = panel.dateFilter;
  const days = parseRouteDayCount(settings.days);
  if (days) {
    controls.daysInput.value = String(days);
  }

  if (typeof settings.from === "string" && parseDateInputValue(settings.from, false)) {
    controls.fromInput.value = settings.from;
  }

  if (typeof settings.to === "string" && parseDateInputValue(settings.to, true)) {
    controls.toInput.value = settings.to;
  }

  if (settings.mode === "all") {
    controls.allRadio.checked = true;
  } else if (settings.mode === "custom") {
    controls.customRadio.checked = true;
  } else {
    controls.recentRadio.checked = true;
  }
}

function parseRouteDayCount(value) {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 1) {
    return 0;
  }
  return days;
}

function saveSelectedLogTypes() {
  const storage = getExtensionStorage();
  if (!storage) {
    return;
  }

  storage.set(
    { [LOG_TYPE_SELECTION_STORAGE_KEY]: getSelectedLogTypes() },
    reportStorageError("settings save failed")
  );
}

function restoreSelectedLogTypes() {
  const storage = getExtensionStorage();
  if (!storage) {
    return;
  }

  storage.get(LOG_TYPE_SELECTION_STORAGE_KEY, (items) => {
    const error = getStorageError();
    if (error) {
      logWarning("settings restore failed", { error });
      return;
    }

    const selectedTypes = items?.[LOG_TYPE_SELECTION_STORAGE_KEY];
    if (!Array.isArray(selectedTypes)) {
      return;
    }

    applySelectedLogTypes(selectedTypes);
    refreshControls();
  });
}

function applySelectedLogTypes(selectedTypes) {
  const selected = new Set(
    selectedTypes.filter((key) => panel.typeInputs.has(key))
  );

  for (const [key, input] of panel.typeInputs) {
    input.checked = selected.has(key);
  }
}

function getExtensionStorage() {
  if (typeof chrome === "undefined") {
    return null;
  }

  return chrome.storage?.local || null;
}

function reportStorageError(message) {
  return () => {
    const error = getStorageError();
    if (error) {
      logWarning(message, { error });
    }
  };
}

function getStorageError() {
  if (typeof chrome === "undefined") {
    return "";
  }

  return chrome.runtime?.lastError?.message || "";
}

function warnBeforeUnload(event) {
  if (!state.running) {
    return undefined;
  }

  event.preventDefault();
  event.returnValue = "";
  return "";
}

function log(message, data) {
  if (!DEBUG_LOGGING) {
    return;
  }

  writeConsole(console.info, message, data);
}

function logWarning(message, data) {
  writeConsole(console.warn, message, data);
}

function logError(message, data) {
  writeConsole(console.error, message, data);
}

function writeConsole(writer, message, data) {
  if (data === undefined) {
    writer.call(console, LOG_PREFIX, message);
    return;
  }

  writer.call(console, LOG_PREFIX, message, data);
}
