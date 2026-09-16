/* Fresh, bounded page discovery shared by the manager and synthetic tests. */
(function (root) {
  "use strict";

  const Parser = root.CommaParser || (typeof require === "function" ? require("./parser.js") : null);
  const CONCURRENCY = 4;
  const LIMITS = Object.freeze({ listingPages: 100, routes: 5000, files: 10000 });

  function cancelled() {
    const error = new Error("Scan cancelled.");
    error.name = "AbortError";
    return error;
  }

  function pageKey(value) {
    const url = new URL(Parser.requirePageUrl(value));
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  }

  function dateMatches(date, filter) {
    return Parser.recordingMatches(date, filter);
  }

  async function scan(options = {}) {
    const { readPage, cancelReads, onProgress, signal } = options;
    if (typeof readPage !== "function") throw new Error("A page reader is required.");
    const sourceUrl = Parser.requirePageUrl(options.sourceUrl);
    const scope = options.scope || "listed";
    const dateBasis = options.dateBasis || "upload";
    if (!["listed", "current"].includes(scope) || !["upload", "recording"].includes(dateBasis)) {
      throw new Error("Choose a valid route scope and date field.");
    }
    const selectedTypes = Array.from(new Set(options.selectedTypes || ["rlog"]))
      .filter(type => Parser.LOG_TYPES.some(item => item.key === type));
    if (!selectedTypes.length) throw new Error("Choose at least one file type.");
    const filter = scope === "current" ? { mode: "all" } : options.filter || { mode: "all" };
    const limits = { ...LIMITS };
    for (const key of Object.keys(LIMITS)) {
      if (options.limits?.[key] === undefined) continue;
      const value = options.limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) {
        throw new Error("Invalid scan limit.");
      }
      limits[key] = value;
    }

    // Only this scan owns these sets. Every new scan fetches fresh page data.
    const found = new Map();
    const routes = new Set();
    const listingUrls = new Set();
    const queue = [];
    let queueIndex = 0;
    const active = new Set();
    let failure = null;
    let cancellation = null;
    let wake = null;
    let initialPending = true;
    let initialDone = false;
    let listingPending = "";
    let listingInFlight = false;
    let listingPages = 0;
    let pagesRead = 0;
    let filteredRoutes = 0;
    let undatedRoutes = 0;
    let matchedRoutes = 0;
    let routesRead = 0;

    const counts = () => ({
      pagesRead, filteredRoutes, undatedRoutes, matchedRoutes, routesRead,
      routeCount: routes.size, listingPages, activeReads: active.size, filesFound: found.size
    });

    function notify() {
      if (!wake) return;
      const resume = wake;
      wake = null;
      resume();
    }

    function stop(error) {
      if (failure) return;
      failure = error || new Error("Unable to read this source page. Keep useradmin open and try again.");
      // The bridge aborts the whole scan group, including messages already queued
      // in Firefox. Keep the first error, then wait for every dispatched read.
      cancellation = Promise.resolve().then(() => cancelReads?.()).catch(() => {});
      notify();
    }

    function progress(phase) {
      if (failure || !onProgress) return;
      try { onProgress({ ...counts(), phase }); } catch (error) { stop(error); }
    }

    function addFiles(files, uploadDate = null, recordingDate = null) {
      for (const file of files) {
        if (!selectedTypes.includes(file.typeKey)) continue;
        if (!Parser.isAllowedDownloadUrl(file.url) || typeof file.targetPath !== "string" || !file.targetPath) {
          throw new Error("A file address could not be verified. Reload the source page and scan again.");
        }
        if (found.has(file.targetPath)) continue;
        if (found.size >= limits.files) {
          throw new Error(`This scan reached the ${limits.files.toLocaleString("en-US")}-file limit. No partial ZIP was prepared. Choose fewer dates or one log type.`);
        }
        found.set(file.targetPath, { ...file, uploadDate, recordingDate });
      }
    }

    function reserveListing(url) {
      const key = pageKey(url);
      if (listingUrls.has(key)) {
        throw new Error("The route pages repeat a page. No partial ZIP was prepared. Reload the source page and scan again.");
      }
      if (listingPages >= limits.listingPages) {
        throw new Error(`This scan reached the ${limits.listingPages}-listing-page limit. No partial ZIP was prepared. Open a single route or use a smaller device route list.`);
      }
      listingUrls.add(key);
      listingPages += 1;
    }

    function readListing(page) {
      if (page.pageKind !== "device" && page.pageKind !== "route-list") {
        throw new Error("The device route list could not be read. Open the device page, then launch Bulk Logs again.");
      }
      for (const route of page.routes) {
        if (typeof route.key !== "string" || !route.key || !Parser.isAllowedPageUrl(route.url)) {
          throw new Error("A route address could not be verified. Reload the source page and scan again.");
        }
        const key = route.key.replace("/", "|").toLowerCase();
        if (routes.has(key)) continue;
        if (routes.size >= limits.routes) {
          throw new Error(`This scan reached the ${limits.routes.toLocaleString("en-US")}-route limit. No partial ZIP was prepared. Open a single route or use a smaller device route list.`);
        }
        routes.add(key);
        if (dateBasis === "upload") {
          if (!dateMatches(route.uploadDate, { mode: "custom", fromDate: null, toDate: null })) undatedRoutes += 1;
          if (!dateMatches(route.uploadDate, filter)) {
            filteredRoutes += 1;
            continue;
          }
        }
        // The queue is bounded by the unique-route limit. There is no promise
        // per queued route, and listings and details share the same four slots.
        queue.push(route);
      }
      if (page.nextPageUrl) {
        const next = Parser.requirePageUrl(page.nextPageUrl);
        if (listingUrls.has(pageKey(next))) {
          throw new Error("The route pages repeat a page. No partial ZIP was prepared. Reload the source page and scan again.");
        }
        listingPending = next;
      }
    }

    function readRoute(page, route) {
      if (page.pageKind !== "route") {
        throw new Error("A route page could not be read. No partial ZIP was prepared. Reload the source page and scan again.");
      }
      routesRead += 1;
      const recordingDate = dateMatches(page.recordingDate, { mode: "custom", fromDate: null, toDate: null })
        ? page.recordingDate : null;
      if (dateBasis === "recording") {
        if (recordingDate === null) undatedRoutes += 1;
        if (!dateMatches(recordingDate, filter)) {
          filteredRoutes += 1;
          return;
        }
      }
      matchedRoutes += 1;
      addFiles(page.files, route?.uploadDate || null, recordingDate);
    }

    function nextJob() {
      if (initialPending) {
        initialPending = false;
        return { kind: "initial", url: sourceUrl };
      }
      if (!initialDone) return null;
      // At most one listing read can be in flight. Give its next page priority
      // so the route catalog advances alongside the detail readers.
      if (listingPending && !listingInFlight) {
        const url = listingPending;
        reserveListing(url);
        listingPending = "";
        listingInFlight = true;
        return { kind: "listing", url };
      }
      if (queueIndex < queue.length) {
        const route = queue[queueIndex++];
        return { kind: "route", url: route.url, route };
      }
      return null;
    }

    function dispatch(job) {
      const request = { url: job.url, selectedTypes };
      if (scope === "listed" && dateBasis === "recording") request.recordingFilter = filter;
      const task = Promise.resolve().then(() => {
        if (failure) throw failure;
        return readPage(request);
      }).then(page => {
        if (failure) return;
        if (!page || !Array.isArray(page.routes) || !Array.isArray(page.files)
            || !Parser.isAllowedPageUrl(page.url) || pageKey(page.url) !== pageKey(job.url)) {
          throw new Error("The source page returned an unreadable result. Reload it and try again.");
        }
        pagesRead += 1;
        if (job.kind === "initial") {
          initialDone = true;
          if (scope === "current") {
            routes.add(pageKey(sourceUrl));
            readRoute(page);
          } else if (page.pageKind === "device" || page.pageKind === "route-list") {
            reserveListing(page.url);
            readListing(page);
          } else {
            const deviceUrl = page.deviceUrl || options.deviceUrl;
            if (!deviceUrl) throw new Error("The device route list could not be read. Open the device page, then launch Bulk Logs again.");
            listingPending = Parser.requirePageUrl(deviceUrl);
          }
        } else if (job.kind === "listing") {
          listingInFlight = false;
          readListing(page);
        } else readRoute(page, job.route);
      }).catch(stop).finally(() => {
        active.delete(task);
        progress(job.kind === "listing" ? "listing" : "routes");
        notify();
      });
      active.add(task);
      progress(job.kind === "initial" ? "source" : job.kind === "listing" ? "listing" : "routes");
    }

    const onAbort = () => stop(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) stop(cancelled());
      while (!failure) {
        try {
          while (!failure && active.size < CONCURRENCY) {
            const job = nextJob();
            if (!job) break;
            dispatch(job);
          }
        } catch (error) { stop(error); }
        if (failure || !active.size) break;
        await new Promise(resolve => { wake = resolve; });
      }
      // No task is left running when the caller sees cancellation or failure.
      await Promise.allSettled(Array.from(active));
      if (cancellation) await cancellation;
      if (failure) throw failure;
      const files = Array.from(found.values()).sort((a, b) => a.targetPath.localeCompare(b.targetPath, undefined, { numeric: true }));
      return { files, pagesRead, filteredRoutes, undatedRoutes, matchedRoutes, routesRead, routeCount: routes.size };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  const api = Object.freeze({ scan, CONCURRENCY, LIMITS });
  root.CommaScanner = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
