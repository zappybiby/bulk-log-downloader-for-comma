/* The transfer lives in a full tab. The event page only opens the interface. */
browser.browserAction.onClicked.addListener(async tab => {
  const url = new URL(browser.runtime.getURL("downloads.html"));
  if (Number.isInteger(tab?.id) && typeof tab.url === "string") {
    try {
      if (new URL(tab.url).origin === "https://useradmin.comma.ai") url.searchParams.set("sourceTab", String(tab.id));
    } catch { /* Unsupported source opens the interface's help state. */ }
  }
  // Reuse the manager for this source, preserving any in-progress archive.
  const managers = await browser.tabs.query({ url: `${browser.runtime.getURL("downloads.html")}*` });
  const existing = managers.find(item => item.url === url.href);
  if (existing) await browser.tabs.update(existing.id, { active: true });
  else await browser.tabs.create({ url: url.href });
});
