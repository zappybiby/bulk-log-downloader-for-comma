/* Test-only API boundary. Production HTML, styling, parser and handlers are reused.
 * Every route, date and byte is invented; no captured page is used here. */
'use strict';
const syntheticSource = 'https://useradmin.comma.ai/?onebox=syntheticdevice';
const syntheticTypes = ['rlog.zst', 'qlog.zst', 'qcamera.ts', 'fcamera.hevc', 'ecamera.hevc', 'dcamera.hevc'];
function fixtureDate(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const syntheticRoutes = [0, 2, 6, 8, 31].map((daysAgo, index) => ({
  // Deliberately unrelated recording dates: upload date must select the route.
  id: `2020-01-${String(index + 1).padStart(2, '0')}--08-00-00`,
  uploaded: fixtureDate(daysAgo), index
}));
function routeUrl(route) {
  return `https://useradmin.comma.ai/?onebox=${encodeURIComponent(`syntheticdevice|${route.id}`)}`;
}
const syntheticHtml = `<html><head><title>Synthetic device · Route selection test</title></head><body>
<h1>Synthetic device</h1><table id="table_routes"><thead><tr><td>upload time</td><td>route_name</td><td>start_time</td></tr></thead><tbody>
${syntheticRoutes.map(route => `<tr><td>${route.uploaded} 12:00:00</td>
<td><a href="${routeUrl(route)}">syntheticdevice|${route.id}</a></td><td>2020-01-01 08:00:00</td></tr>`).join('')}
</tbody></table></body></html>`;
const syntheticDocuments = new Map([[syntheticSource, new DOMParser().parseFromString(syntheticHtml, 'text/html')]]);
const syntheticPayloads = new Map();
for (const route of syntheticRoutes) {
  const links = [];
  for (let segment = 0; segment < 2; segment++) {
    for (const [typeIndex, filename] of syntheticTypes.entries()) {
      const url = `https://commadata2.blob.core.windows.net/ci-fixtures/syntheticdevice/${route.id}/${segment}/${filename}`;
      links.push(`<a href="${url}">${filename}</a>`);
      syntheticPayloads.set(url, 64 + route.index * 16 + segment * 6 + typeIndex);
    }
  }
  syntheticDocuments.set(routeUrl(route), new DOMParser().parseFromString(
    `<html><head><title>Synthetic route ${route.index + 1}</title></head><body>${links.join('')}</body></html>`, 'text/html'));
}
const SyntheticBrowser = {
  runtime: browser.runtime,
  storage: browser.storage,
  tabs: {
    get: async () => ({id:42, url:syntheticSource, title:'Synthetic device · Route selection test'}),
    query: async () => [{id:42, url:syntheticSource, title:'Synthetic device · Route selection test'}],
    update: async () => {},
    sendMessage: async (_id, message) => {
      if (message.type === 'comma:cancel') return {cancelled:true};
      const url = message.url || syntheticSource;
      const doc = syntheticDocuments.get(url);
      if (!doc) throw new Error('Unexpected synthetic source URL');
      return CommaParser.snapshot(doc, url, message.selectedTypes);
    }
  }
};
// Fail closed for every network request: even Prepare ZIP stays completely synthetic.
globalThis.fetch = async url => {
  const value = syntheticPayloads.get(String(url));
  if (value === undefined) throw new Error('Unexpected synthetic download URL');
  return new Response(new Uint8Array(4096).fill(value), {
    status:200, headers:{'Content-Length':'4096'}
  });
};
