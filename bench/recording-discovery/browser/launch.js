/* Test-only entry point; never distributed with the production extension. */
function openTest() { return browser.tabs.create({url: browser.runtime.getURL("benchmark.html")}); }
browser.runtime.onInstalled.addListener(openTest);
browser.browserAction.onClicked.addListener(openTest);
