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
  // Timestamp route IDs, upload dates and actual recording dates all disagree.
  id: `2020-01-${String(index + 1).padStart(2, '0')}--08-00-00`,
  uploaded: fixtureDate(daysAgo), recorded: fixtureDate([20, 1, 8, 0, 6][index]), index
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
const syntheticRouteBodies = new Map();
for (const route of syntheticRoutes) {
  const links = [];
  for (let segment = 0; segment < 2; segment++) {
    for (const [typeIndex, filename] of syntheticTypes.entries()) {
      const url = `https://commadata2.blob.core.windows.net/ci-fixtures/syntheticdevice/${route.id}/${segment}/${filename}`;
      links.push(`<a href="${url}">${filename}</a>`);
      syntheticPayloads.set(url, 64 + route.index * 16 + segment * 6 + typeIndex);
    }
  }
  syntheticRouteBodies.set(routeUrl(route), {route, links:links.join('')});
}
const syntheticCancelledScans = new Set();
const syntheticPendingReads = new Map();
const syntheticRecordingScans = new Set();
function fixtureDocument(url, message) {
  const detail = syntheticRouteBodies.get(url);
  if (!detail) return syntheticDocuments.get(url);
  const {route, links} = detail;
  const filter = message.recordingFilter;
  if (filter?.fromDate === fixtureDate(6) && filter?.toDate === fixtureDate(0) && message.scanId) {
    syntheticRecordingScans.add(message.scanId);
  }
  // Deliberate synthetic upstream correction BETWEEN two Last 7 recording scans.
  // Both date-mode selection and the next fresh scan run production code. This
  // tests fresh page reading, not live HTTP caching or real server updates.
  const recorded = route.index === 2 && syntheticRecordingScans.size > 1 ? fixtureDate(2) : route.recorded;
  return new DOMParser().parseFromString(`<html><head><title>Synthetic route ${route.index + 1}</title></head><body>
<table id="table_route5_route"><tr><td>start_time</td><td>${recorded}T08:00:00</td></tr>
<tr><td>end_time</td><td>${recorded}T08:20:00</td></tr>
<tr><td>create_time</td><td>${route.uploaded}T12:00:00</td></tr></table>${links}</body></html>`, 'text/html');
}
function syntheticDelay(scanId) {
  return new Promise((resolve, reject) => {
    if (syntheticCancelledScans.has(scanId)) {
      reject(new DOMException('Synthetic page read cancelled.', 'AbortError'));
      return;
    }
    const pending = {reject, timer:null};
    if (!syntheticPendingReads.has(scanId)) syntheticPendingReads.set(scanId, new Set());
    syntheticPendingReads.get(scanId).add(pending);
    pending.timer = setTimeout(() => {
      syntheticPendingReads.get(scanId)?.delete(pending);
      resolve();
    }, 20);
  });
}
const SyntheticBrowser = {
  runtime: browser.runtime,
  storage: browser.storage,
  tabs: {
    get: async () => ({id:42, url:syntheticSource, title:'Synthetic device · Route selection test'}),
    query: async () => [{id:42, url:syntheticSource, title:'Synthetic device · Route selection test'}],
    update: async () => {},
    sendMessage: async (_id, message) => {
      if (message.type === 'comma:cancel-read') {
        syntheticCancelledScans.add(message.scanId);
        for (const pending of syntheticPendingReads.get(message.scanId) || []) {
          clearTimeout(pending.timer);
          pending.reject(new DOMException('Synthetic page read cancelled.', 'AbortError'));
        }
        syntheticPendingReads.delete(message.scanId);
        return {cancelled:true};
      }
      const url = message.url || syntheticSource;
      // A short asynchronous wait allows the production request pool to overlap
      // page reads. It does not model bandwidth, server load or network latency.
      if (message.url) await syntheticDelay(message.scanId);
      const doc = fixtureDocument(url, message);
      if (!doc) throw new Error('Unexpected synthetic source URL');
      return CommaParser.snapshot(doc, url, message.selectedTypes, {recordingFilter:message.recordingFilter});
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
