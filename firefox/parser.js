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

  function parseRouteUploadTime(text) {
    const match = String(text).match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match.slice(1).map(value => Number(value || 0));
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1
        || date.getDate() !== day || date.getHours() !== hour
        || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
    return date.getTime();
  }

  function collectRouteLinks(doc, baseUrl) {
    const routes = [];
    const seen = new Set();
    // Device pages also contain route links in crash/event tables. Those are
    // unrelated to the visible route list and must not enter a bulk download.
    const scope = doc.querySelector("#table_routes") || doc;
    for (const link of scope.querySelectorAll('a[href*="onebox="]')) {
      const name = (link.textContent || "").trim();
      const url = allowedUrl(link.getAttribute("href"), PAGE_ORIGIN, baseUrl);
      if (!isRouteName(name) || !url) continue;
      const onebox = url.searchParams.get("onebox") || "";
      const key = normalizeRouteKey(name);
      if (!isRouteName(onebox) || normalizeRouteKey(onebox) !== key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const uploaded = link.closest("tr")?.querySelector("td, th")?.textContent || "";
      routes.push({ key, name, url: url.href, uploadedAt: parseRouteUploadTime(uploaded.trim().replace(/\s+/g, " ")) });
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
    if (mode === "all") return { mode, from: null, to: null };
    if (mode === "recent") {
      const days = Number(settings.days === undefined ? 7 : settings.days);
      if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
        throw new Error("Enter a whole number of days between 1 and 36500.");
      }
      const from = new Date(now);
      const to = new Date(now);
      // "Last N days" includes today and N - 1 preceding calendar dates.
      from.setDate(from.getDate() - (days - 1));
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) throw new Error("Invalid current date.");
      return { mode, from: from.getTime(), to: to.getTime() };
    }
    if (mode !== "custom") throw new Error("Choose a valid date filter.");
    const from = /^\d{4}-\d{2}-\d{2}$/.test(settings.from) ? parseRouteUploadTime(settings.from) : null;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(settings.to) ? parseRouteUploadTime(settings.to) : null;
    if (from === null || end === null || from > end) throw new Error("Choose a valid start and end date.");
    const to = new Date(end);
    to.setHours(23, 59, 59, 999);
    return { mode, from, to: to.getTime() };
  }

  function routeMatches(route, filter) {
    if (filter.mode === "all") return true;
    return Number.isFinite(route.uploadedAt)
      && (filter.from === null || route.uploadedAt >= filter.from)
      && (filter.to === null || route.uploadedAt <= filter.to);
  }

  function snapshot(doc, baseUrl, selectedTypes) {
    const url = requirePageUrl(baseUrl);
    const title = String(doc.title || "comma useradmin").trim().slice(0, 200);
    if (doc.querySelector('input[type="password"]') || /^(?:sign in|log ?in)(?:\b|$)/i.test(title)) {
      throw new Error("Sign in to useradmin in the source tab, then choose it again.");
    }
    const routes = collectRouteLinks(doc, url);
    const allFiles = collectLogFiles(doc, LOG_TYPES.map(type => type.key), url);
    const availableTypes = LOG_TYPES.filter(type => allFiles.some(file => file.typeKey === type.key)).map(type => type.key);
    const isDevice = Boolean(doc.querySelector("#table_routes"));
    const hasRouteQuery = isRouteName(new URL(url).searchParams.get("onebox") || "");
    const isRoute = Boolean(allFiles.length || (hasRouteQuery && doc.querySelector("table")));
    if (!isDevice && !isRoute && !routes.length) {
      if (doc.querySelector("pre") && doc.querySelector("select")) {
        throw new Error("This is a log viewer. Open its route or device page in useradmin, then choose that tab.");
      }
      throw new Error("Open a device page with a route list, or a route page with log files, in useradmin.");
    }
    const selected = new Set(Array.isArray(selectedTypes) ? selectedTypes : ["rlog"]);
    return {
      url,
      title,
      pageKind: isDevice ? "device" : isRoute ? "route" : "route-list",
      availableTypes,
      routes,
      files: allFiles.filter(file => selected.has(file.typeKey)),
      nextPageUrl: getNextPageUrl(doc, url)
    };
  }

  const api = Object.freeze({
    PAGE_ORIGIN, DOWNLOAD_ORIGIN, LOG_TYPES, snapshot, dateFilter, routeMatches,
    isAllowedPageUrl, isAllowedDownloadUrl, requirePageUrl, sanitizeFileName,
    collectRouteLinks, collectLogFiles, getNextPageUrl, parseRouteUploadTime
  });
  root.CommaParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
