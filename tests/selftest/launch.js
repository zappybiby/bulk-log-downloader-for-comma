/* Test-only entry point; never included in the distributable add-on. */
function openTest() { return browser.tabs.create({url: browser.runtime.getURL('selftest.html')}); }
browser.runtime.onInstalled.addListener(openTest);
browser.browserAction.onClicked.addListener(openTest);
