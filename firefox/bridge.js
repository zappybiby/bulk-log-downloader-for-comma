/* Invisible reader: all controls live in the extension's own mobile-friendly tab. */
(function () {
  "use strict";

  if (globalThis.__commaPageBridgeInstalled) return;
  globalThis.__commaPageBridgeInstalled = true;

  const runtime = browser.runtime;
  const PAGE_FETCH_TIMEOUT_MS = 45000;
  const activeReads = new Map();
  const cancelledScans = new Set();
  const safeMessages = new Set([
    "Unsupported source page.",
    "Only https://useradmin.comma.ai pages can be read.",
    "The source tab has navigated. Choose it again before continuing.",
    "Invalid scan request. Start a new scan.",
    "A scan ID is required to cancel a scan.",
    "Scan cancelled.",
    "Page read timed out. Keep the source tab open and try again.",
    "This link is not a useradmin page. Open a device or route page and try again.",
    "Sign in to useradmin in the source tab, then choose it again.",
    "This is a log viewer. Open its route or device page in useradmin, then choose that tab.",
    "Open a device page with a route list, or a route page with log files, in useradmin."
  ]);

  function safeError(error) {
    const message = typeof error?.message === "string" ? error.message : "";
    // Browser network exceptions can contain the request URL. Only return our
    // controlled guidance and numeric HTTP statuses; never an arbitrary message.
    if (safeMessages.has(message) || /^Page read failed \(HTTP [1-5]\d\d\)\.$/.test(message)) return message;
    return "Unable to read this source page. Keep useradmin open and try again.";
  }

  function scanToken(message) {
    if (message.scanId === undefined) return "";
    if (typeof message.scanId !== "string" || !message.scanId || message.scanId.length > 128) {
      throw new Error("Invalid scan request. Start a new scan.");
    }
    return message.scanId;
  }

  function cancelRead(message) {
    const scanId = scanToken(message);
    if (!scanId) throw new Error("A scan ID is required to cancel a scan.");
    cancelledScans.add(scanId);
    // Remember recent cancellations so an already queued message cannot restart
    // a cancelled scan. Keep the content script's lifetime memory bounded.
    if (cancelledScans.size > 128) cancelledScans.delete(cancelledScans.values().next().value);
    for (const active of activeReads.get(scanId) || []) {
      active.cancelled = true;
      active.controller.abort();
    }
    return { cancelled: true };
  }

  async function read(message) {
    const scanId = scanToken(message);
    if (scanId && cancelledScans.has(scanId)) throw new Error("Scan cancelled.");
    const initialUrl = location.href;
    CommaParser.requirePageUrl(initialUrl);
    if (message.expectedUrl !== undefined && message.expectedUrl !== initialUrl) {
      throw new Error("The source tab has navigated. Choose it again before continuing.");
    }
    if (message.url === undefined) {
      return CommaParser.snapshot(document, initialUrl, message.selectedTypes);
    }

    const url = CommaParser.requirePageUrl(message.url);
    const controller = new AbortController();
    const active = { controller, cancelled: false, timedOut: false };
    if (!activeReads.has(scanId)) activeReads.set(scanId, new Set());
    activeReads.get(scanId).add(active);
    const timer = setTimeout(() => {
      active.timedOut = true;
      controller.abort();
    }, PAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        // Firefox MV2 content-script fetch uses the extension context. Include
        // the user's site cookies explicitly, only for the exact allowed origin.
        credentials: "include",
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Page read failed (HTTP ${response.status}).`);
      if (response.url) CommaParser.requirePageUrl(response.url);
      const contentType = response.headers?.get("Content-Type") || "";
      if (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        throw new Error("This link is not a useradmin page. Open a device or route page and try again.");
      }
      const html = await response.text();
      if (active.cancelled || (scanId && cancelledScans.has(scanId))) throw new Error("Scan cancelled.");
      if (active.timedOut) throw new Error("Page read timed out. Keep the source tab open and try again.");
      if (location.href !== initialUrl) throw new Error("The source tab has navigated. Choose it again before continuing.");
      const doc = new DOMParser().parseFromString(html, "text/html");
      return CommaParser.snapshot(doc, url, message.selectedTypes);
    } catch (error) {
      if (active.cancelled) throw new Error("Scan cancelled.");
      if (active.timedOut || error?.name === "AbortError") {
        throw new Error("Page read timed out. Keep the source tab open and try again.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      activeReads.get(scanId)?.delete(active);
      if (!activeReads.get(scanId)?.size) activeReads.delete(scanId);
    }
  }

  runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "comma:read" && message?.type !== "comma:cancel-read") return undefined;
    if (sender?.id !== runtime.id) return Promise.resolve({ error: "Unsupported message sender." });
    return Promise.resolve().then(() => message.type === "comma:read" ? read(message) : cancelRead(message))
      .catch(error => ({ error: safeError(error) }));
  });
})();
