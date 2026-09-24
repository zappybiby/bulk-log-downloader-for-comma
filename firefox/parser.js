/* Shared, DOM-only parsing for the Firefox page reader and download manager. */
(function (root) {
  "use strict";

  const PAGE_ORIGIN = "https://useradmin.comma.ai";
  const DOWNLOAD_ORIGIN = "https://commadata2.blob.core.windows.net";
  const LOG_TYPES = Object.freeze([
    { key: "rlog", fileName: "rlog.zst", folderName: "rlog", checked: true },
    { key: "qlog", fileName: "qlog.zst", folderName: "qlog", checked: false },
    { key: "qcamera", fileName: "qcamera.ts", folderName: "qcamera", checked: false },
    { key: "fcamera", fileName: "fcamera.hevc", folderName: "fcamera", checked: false },
    { key: "ecamera", fileName: "ecamera.hevc", folderName: "ecamera", checked: false },
    { key: "dcamera", fileName: "dcamera.hevc", folderName: "dcamera", checked: false }
  ].map(Object.freeze));

  function allowedUrl(value, origin, baseUrl) {
    if (typeof value !== "string" || !value || value.trim() !== value
        || /[\\\x00-\x20\x7f]/.test(value)) return null;
    // URL normalizes an explicit :443 away, so inspect the original authority too.
    const authority = value.match(/^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]*)/i)?.[1];
    if (authority && /[@:]/.test(authority)) return null;
    try {
      const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
      if (url.origin !== origin || url.username || url.password || url.port) return null;
      return url;
    } catch {
      return null;
    }
  }

  function isAllowedPageUrl(value) {
    return Boolean(allowedUrl(value, PAGE_ORIGIN));
  }

  function isAllowedDownloadUrl(value) {
    return Boolean(allowedUrl(value, DOWNLOAD_ORIGIN));
  }

  function requirePageUrl(value, baseUrl) {
    if (baseUrl && !isAllowedPageUrl(baseUrl)) throw new Error("Unsupported source page.");
    const url = allowedUrl(value, PAGE_ORIGIN, baseUrl);
    if (!url) throw new Error("Only https://useradmin.comma.ai pages can be read.");
    return url.href;
  }

  function normalizeRouteKey(name) {
    return name.replace("/", "|").toLowerCase();
  }

  function isRouteName(name) {
    // Newer route IDs are hexadecimal; older drives use a timestamp ID.
    return /^[a-z\d_-]+[|/](?:[0-9a-f]{8}--[0-9a-f]+|\d{4}-\d{2}-\d{2}--\d{2}-\d{2}-\d{2})$/i.test(name);
  }

  function calendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    if (year < 1) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day ? value : null;
  }

  function parseRouteUploadDate(text) {
    const match = String(text).match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
    if (!match) return null;
    if (Number(match[4] || 0) > 23 || Number(match[5] || 0) > 59 || Number(match[6] || 0) > 59) return null;
    // The site does not declare a timezone for this column. Preserve its displayed
    // calendar date, including times that fall in the phone's local DST gap.
    return calendarDate(`${match[1]}-${match[2]}-${match[3]}`);
  }

  function parseRouteRecordingDate(text) {
    // start_time is a naive ISO timestamp on the route details page. Keep its
    // displayed day; do not infer a timezone from the phone, upload, or route ID.
    const match = typeof text === "string"
      ? text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/) : null;
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
    return calendarDate(match[1]);
  }

  function collectRecordingDate(doc) {
    const tables = doc.querySelectorAll("table#table_route5_route");
    if (tables.length !== 1) return null;
    const table = tables[0];
    const starts = [];
    for (const row of table.querySelectorAll("tr")) {
      if (row.closest("table") !== table) continue;
      const cells = Array.from(row.children).filter(cell => /^(?:TD|TH)$/.test(cell.tagName));
      if ((cells[0]?.textContent || "").trim() !== "start_time") continue;
      // Multiple start fields or extra/nested value cells are ambiguous even
      // when their displayed dates happen to agree.
      starts.push(cells.length === 2 && !cells[1].querySelector("table")
        ? parseRouteRecordingDate((cells[1].textContent || "").trim()) : null);
    }
    return starts.length === 1 ? starts[0] : null;
  }

  function uploadColumn(table) {
    if (!table) return 0;
    for (const row of table.querySelectorAll("tr")) {
      if (row.closest("table") !== table) continue;
      const cells = Array.from(row.children).filter(cell => /^(?:TD|TH)$/.test(cell.tagName));
      if (!cells.length) continue;
      const labels = cells.map(cell => (cell.textContent || "").trim().toLowerCase().replace(/[_\s]+/g, " "));
      const column = labels.indexOf("upload time");
      if (column !== -1) return column;
      // The first row is data only if it actually contains a route link. Named
      // headers without "upload time" must not make another date a substitute.
      return Array.from(row.querySelectorAll('a[href*="onebox="]'))
        .some(link => isRouteName((link.textContent || "").trim())) ? 0 : -1;
    }
    return -1;
  }

  function routeTables(doc) {
    const tables = new Set(doc.querySelectorAll("#table_routes"));
    // Preserved routes are a separate (possibly collapsed) section. Identify it
    // by its displayed summary rather than depending on its table's generated ID.
    for (const summary of doc.querySelectorAll("details > summary")) {
      const label = (summary.textContent || "").trim().replace(/\s+/g, " ");
      if (!/^preserved routes\s*\(\d+\)$/i.test(label)) continue;
      const section = summary.parentElement;
      for (const table of section.querySelectorAll("table")) {
        if (table.closest("details") === section && !table.parentElement.closest("table")) tables.add(table);
      }
    }
    return Array.from(tables);
  }

  function collectRouteLinks(doc, baseUrl) {
    const routes = [];
    const seen = new Set();
    const columns = new Map();
    // Device pages also contain route links in crash/event tables. Those are
    // unrelated to the regular/preserved route lists and must not enter a bulk download.
    const tables = routeTables(doc);
    const links = tables.length ? tables.flatMap(table =>
      Array.from(table.querySelectorAll('a[href*="onebox="]')).filter(link => link.closest("table") === table))
      : doc.querySelectorAll('a[href*="onebox="]');
    for (const link of links) {
      const name = (link.textContent || "").trim();
      const url = allowedUrl(link.getAttribute("href"), PAGE_ORIGIN, baseUrl);
      if (!isRouteName(name) || !url) continue;
      const onebox = url.searchParams.get("onebox") || "";
      const key = normalizeRouteKey(name);
      if (!isRouteName(onebox) || normalizeRouteKey(onebox) !== key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = link.closest("tr");
      const table = row?.closest("table");
      if (!columns.has(table)) columns.set(table, uploadColumn(table));
      const cells = Array.from(row?.children || []).filter(cell => /^(?:TD|TH)$/.test(cell.tagName));
      const uploaded = cells[columns.get(table)]?.textContent || "";
      routes.push({ key, name, url: url.href, uploadDate: parseRouteUploadDate(uploaded.trim().replace(/\s+/g, " ")) });
    }
    return routes;
  }

  // Escape unsafe characters instead of replacing them with a shared underscore.
  // The escape marker is escaped too, so different route/segment IDs stay distinct.
  function sanitizeFileName(value) {
    const raw = String(value);
    let safe = Array.from(raw, character => /^[a-z\d_.-]$/i.test(character)
      ? character : `~${character.codePointAt(0).toString(16)}~`).join("");
    safe = safe.replace(/^\.+|\.+$/g, dots => dots.replace(/\./g, "~2e~"));
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
      safe = `~${safe.charCodeAt(0).toString(16)}~${safe.slice(1)}`;
    }
    return safe || "unnamed";
  }

  function fileFromLink(link, baseUrl, selected) {
    const url = allowedUrl(link.getAttribute("href"), DOWNLOAD_ORIGIN, baseUrl);
    if (!url) return null;
    let parts;
    try {
      parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
    } catch {
      // A single malformed URL must not prevent reading the other files.
      return null;
    }
    if (parts.length < 4 || parts.some(part => part.toLowerCase() === "bootlogs")) return null;
    const [dongle, route, segment, basename] = parts.slice(-4);
    if ([dongle, route, segment].some(part => !part || part === "." || part === ".."
        || /[/\\\x00-\x1f\x7f]/.test(part))) return null;
    const label = (link.textContent || "").trim();
    const type = LOG_TYPES.find(item => item.fileName === basename && item.fileName === label);
    if (!type || !selected.has(type.key)) return null;
    // A SAS rscd filename can omit segment identity or contain path traversal.
    // Always derive the name from the canonical blob path, as in the original fallback.
    const name = sanitizeFileName(`${dongle}_${route}--${segment}--${basename}`);
    const routeFolderName = sanitizeFileName(`${dongle}__${route}`);
    if (name.length > 240 || routeFolderName.length > 240) return null;
    return {
      url: url.href,
      name,
      routeFolderName,
      typeFolderName: type.folderName,
      typeKey: type.key,
      targetPath: `${routeFolderName}/${type.folderName}/${name}`
    };
  }

  function collectLogFiles(doc, selectedTypes, baseUrl) {
    const selected = new Set(Array.isArray(selectedTypes) ? selectedTypes : ["rlog"]);
    const seen = new Set();
    const files = [];
    for (const link of doc.querySelectorAll("a[href]")) {
      const file = fileFromLink(link, baseUrl, selected);
      if (!file || seen.has(file.targetPath)) continue;
      seen.add(file.targetPath);
      files.push(file);
    }
    return files.sort((a, b) => a.targetPath.localeCompare(b.targetPath, undefined, { numeric: true }));
  }

  function getNextPageUrl(doc, baseUrl) {
    let declaredCount = null;
    for (const summary of doc.querySelectorAll("summary")) {
      const match = (summary.textContent || "").trim().match(/^routes\s*\((\d+)\)/i);
      if (match) {
        declaredCount = Number(match[1]);
        break;
      }
    }
    const table = doc.querySelector("#table_routes");
    if (declaredCount !== null && table && collectRouteLinks(table, baseUrl).length >= declaredCount) return "";
    const current = new URL(requirePageUrl(baseUrl));
    const currentPage = /^\d+$/.test(current.searchParams.get("page") || "")
      ? Number(current.searchParams.get("page")) : 0;
    for (const link of doc.querySelectorAll("a[onclick], button[onclick]")) {
      if (link.hasAttribute("hidden") || link.hasAttribute("disabled")
          || link.getAttribute("aria-disabled") === "true") continue;
      const match = (link.getAttribute("onclick") || "").match(/\bloadMoreRoutes\(\s*(\d+)\s*\)/);
      if (!match) continue;
      const page = Number(match[1]);
      if (!Number.isSafeInteger(page) || page < 0 || page >= Number.MAX_SAFE_INTEGER) continue;
      // The site supplies the current zero-based page to loadMoreRoutes().
      // It fetches page + 1. Never revisit a stale control from an older page.
      if (page + 1 <= currentPage) continue;
      const url = new URL(current);
      url.searchParams.set("page", String(page + 1));
      url.hash = "";
      return url.href;
    }
    return "";
  }

  function dateFilter(settings = {}, now = new Date()) {
    if (!settings || typeof settings !== "object") throw new Error("Choose a valid date filter.");
    const mode = settings.mode || "recent";
    if (mode === "all") return { mode, fromDate: null, toDate: null };
    if (mode === "recent") {
      const days = Number(settings.days === undefined ? 7 : settings.days);
      if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
        throw new Error("Enter a whole number of days between 1 and 36500.");
      }
      const current = new Date(now);
      if (!Number.isFinite(current.getTime())) throw new Error("Invalid current date.");
      const toDate = calendarDate(`${String(current.getFullYear()).padStart(4, "0")}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`);
      if (!toDate) throw new Error("Invalid current date.");
      const from = new Date(`${toDate}T00:00:00Z`);
      // "Last N days" includes today and N - 1 preceding calendar dates.
      from.setUTCDate(from.getUTCDate() - (days - 1));
      const fromDate = calendarDate(from.toISOString().slice(0, 10));
      if (!fromDate) throw new Error("Invalid current date.");
      return { mode, fromDate, toDate };
    }
    if (mode !== "custom") throw new Error("Choose a valid date filter.");
    const fromDate = calendarDate(settings.from);
    const toDate = calendarDate(settings.to);
    if (!fromDate || !toDate || fromDate > toDate) throw new Error("Choose a valid start and end date.");
    return { mode, fromDate, toDate };
  }

  function routeMatches(route, filter) {
    return recordingMatches(route?.uploadDate, filter);
  }

  function recordingMatches(recordingDate, filter) {
    if (filter.mode === "all") return true;
    const date = calendarDate(recordingDate);
    return date !== null
      && (filter.fromDate === null || date >= filter.fromDate)
      && (filter.toDate === null || date <= filter.toDate);
  }

  function getDeviceUrl(doc, baseUrl) {
    const source = new URL(requirePageUrl(baseUrl));
    const query = source.searchParams.getAll("onebox");
    const name = query.length === 1 ? query[0] : "";
    const deviceName = isRouteName(name) ? name.split(/[|/]/)[0] : /^[a-z\d_-]+$/i.test(name) ? name : "";
    const deviceUrl = device => `${PAGE_ORIGIN}/?onebox=${encodeURIComponent(device)}`;
    if (deviceName) return deviceUrl(deviceName);
    const devices = new Set();
    for (const link of doc.querySelectorAll('a[href*="onebox="]')) {
      const url = allowedUrl(link.getAttribute("href"), PAGE_ORIGIN, baseUrl);
      if (!url || url.pathname !== "/" || url.searchParams.getAll("onebox").length !== 1) continue;
      const candidate = url.searchParams.get("onebox") || "";
      if (/^[a-z\d_-]+$/i.test(candidate) && (link.textContent || "").trim() === candidate) devices.add(candidate);
    }
    // Multiple device links are ambiguous; do not choose an unrelated device.
    return devices.size === 1 ? deviceUrl(devices.values().next().value) : "";
  }

  function snapshot(doc, baseUrl, selectedTypes, options = {}) {
    const url = requirePageUrl(baseUrl);
    const title = String(doc.title || "comma useradmin").trim().slice(0, 200);
    if (doc.querySelector('input[type="password"]') || /^(?:sign in|log ?in)(?:\b|$)/i.test(title)) {
      throw new Error("Sign in to useradmin in the source tab, then choose it again.");
    }
    const routes = collectRouteLinks(doc, url);
    const isDevice = routeTables(doc).length > 0;
    const hasRouteQuery = isRouteName(new URL(url).searchParams.get("onebox") || "");
    let isRoute = Boolean(hasRouteQuery && doc.querySelector("table"));
    if (!isDevice && !isRoute) {
      // Recognize sparse routes whose only uploaded type is not selected. Stop
      // at the first valid link; don't build or sort a catalog of every type.
      const allTypes = new Set(LOG_TYPES.map(type => type.key));
      for (const link of doc.querySelectorAll("a[href]")) {
        if (fileFromLink(link, url, allTypes)) { isRoute = true; break; }
      }
    }
    if (!isDevice && !isRoute && !routes.length) {
      if (doc.querySelector("pre") && doc.querySelector("select")) {
        throw new Error("This is a log viewer. Open its route or device page in useradmin, then choose that tab.");
      }
      throw new Error("Open a device page with a route list, or a route page with log files, in useradmin.");
    }
    const recordingDate = !isDevice && isRoute ? collectRecordingDate(doc) : null;
    const recordingMatch = !isDevice && isRoute
      ? !options.recordingFilter || recordingMatches(recordingDate, options.recordingFilter) : null;
    // Date rejection happens before inspecting file links. No recording dates
    // or signed file links are retained across scans.
    const files = recordingMatch === false ? [] : collectLogFiles(doc, selectedTypes, url);
    // These are the selected types actually inspected, not a full type catalog.
    const availableTypes = LOG_TYPES.filter(type => files.some(file => file.typeKey === type.key)).map(type => type.key);
    return {
      url,
      title,
      deviceUrl: getDeviceUrl(doc, url),
      pageKind: isDevice ? "device" : isRoute ? "route" : "route-list",
      recordingDate,
      recordingMatch,
      availableTypes,
      routes,
      files,
      nextPageUrl: getNextPageUrl(doc, url)
    };
  }

  const api = Object.freeze({
    PAGE_ORIGIN, DOWNLOAD_ORIGIN, LOG_TYPES, snapshot, dateFilter, routeMatches, recordingMatches,
    isAllowedPageUrl, isAllowedDownloadUrl, requirePageUrl, sanitizeFileName,
    collectRouteLinks, collectLogFiles, getNextPageUrl, parseRouteUploadDate, parseRouteRecordingDate,
    collectRecordingDate, getDeviceUrl
  });
  root.CommaParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
