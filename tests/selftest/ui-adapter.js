/* A test-only API boundary. Production HTML, styling and interaction handlers are reused. */
'use strict';
const syntheticSource = 'https://useradmin.comma.ai/?onebox=syntheticdevice%7C01234567--abcdef';
const syntheticHtml = `<html><head><title>Synthetic route · CI fixture</title></head><body>
<h1>Synthetic route</h1>${Array.from({length: 12}, (_, i) => `
<a href="https://commadata2.blob.core.windows.net/ci-fixtures/syntheticdevice/01234567--abcdef/${i}/rlog.zst">rlog.zst</a>
<a href="https://commadata2.blob.core.windows.net/ci-fixtures/syntheticdevice/01234567--abcdef/${i}/qlog.zst">qlog.zst</a>`).join('')}
</body></html>`;
const syntheticDoc = new DOMParser().parseFromString(syntheticHtml, 'text/html');
const SyntheticBrowser = {
  runtime: browser.runtime,
  storage: browser.storage,
  tabs: {
    get: async () => ({id:42, url:syntheticSource, title:'Synthetic route · CI fixture'}),
    query: async () => [{id:42, url:syntheticSource, title:'Synthetic route · CI fixture'}],
    update: async () => {},
    sendMessage: async (_id, message) => CommaParser.snapshot(syntheticDoc, syntheticSource, message.selectedTypes)
  }
};
// Fail closed for every network request: even Prepare ZIP stays completely synthetic.
globalThis.fetch = async () => new Response(new Uint8Array(4096).fill(37), {
  status:200, headers:{'Content-Length':'4096'}
});
