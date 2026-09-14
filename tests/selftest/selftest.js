/* All file contents and routes in this file are invented and deterministic. */
'use strict';
const statusNode = document.querySelector('#status');
const detail = document.querySelector('#detail');
const save = document.querySelector('#save');
let archive;
let blobUrl;
const counts = {small: 120, medium: 120, large: 120};
const sizes = {small: 64 * 1024, medium: 256 * 1024, large: 512 * 1024};
function state(text, extra = '') { statusNode.textContent = text; detail.textContent = extra; }
function pathFor(i) { return `synthetic-route-${Math.floor(i / 40)}/${String(i % 40).padStart(4, '0')}/rlog.zst`; }
function filesFor(count) {
  return Array.from({length: count}, (_, i) => ({
    url: `https://commadata2.blob.core.windows.net/ci-fixtures/${i}/rlog.zst`,
    targetPath: pathFor(i)
  }));
}
function syntheticResponse(i, size, signal, delay = 0) {
  let offset = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (signal?.aborted) { controller.error(new DOMException('Cancelled', 'AbortError')); return; }
      if (offset >= size) { controller.close(); return; }
      const chunk = new Uint8Array(Math.min(65536, size - offset));
      for (let j = 0; j < chunk.length; j++) {
        const n = offset + j;
        chunk[j] = (i * 31 + n * 17 + (n >>> 8)) & 255;
      }
      offset += chunk.length;
      controller.enqueue(chunk);
    }
  }), {status: 200, headers: {'Content-Length': String(size)}});
}
async function clearArchive() {
  save.hidden = true;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = undefined;
  if (archive) await archive.dispose();
  archive = undefined;
}
async function runZip(kind) {
  await clearArchive();
  const started = performance.now();
  state(`${kind.toUpperCase()} BUILDING`);
  let i = 0;
  archive = await CommaArchive.build(filesFor(counts[kind]), {
    maxBytes: (kind === 'large' ? 128 : 32) * 1024 * 1024,
    fetchFile: async (_url, {signal} = {}) => syntheticResponse(i++, sizes[kind], signal),
    onProgress: p => { detail.textContent = `${p.filesDone}/${p.filesTotal} files · ${p.bytesReceived} bytes · ${p.storage}`; }
  });
  if (archive.count !== counts[kind]) throw new Error('Archive entry count mismatch');
  blobUrl = URL.createObjectURL(archive.blob);
  save.href = blobUrl;
  save.download = `comma-selftest-${kind}.zip`;
  save.hidden = false;
  state(`${kind.toUpperCase()} READY ${archive.count} FILES`, JSON.stringify({
    kind, files: archive.count, bytes: archive.blob.size, storage: archive.storage,
    elapsedMs: Math.round(performance.now() - started), userAgent: navigator.userAgent
  }, null, 2));
}
async function runCancel() {
  await clearArchive();
  state('CANCEL RUNNING');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250);
  try {
    const unexpected = await CommaArchive.build(filesFor(120), {
      signal: controller.signal,
      fetchFile: async (_url, {signal} = {}) => syntheticResponse(0, 8 * 1024 * 1024, signal, 40)
    });
    await unexpected.dispose();
    throw new Error('Cancellation incorrectly returned an archive');
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    state('CANCEL PASS', 'An interrupted stream rejected with AbortError. No save link was offered.');
  } finally { clearTimeout(timeout); }
}
async function runFailure() {
  await clearArchive();
  state('FAILURE RUNNING');
  let rejected = false;
  try {
    const unexpected = await CommaArchive.build(filesFor(3), {
      fetchFile: async () => new Response('synthetic unavailable', {status: 503})
    });
    await unexpected.dispose();
  } catch (error) {
    rejected = true;
    if (error.name === 'AbortError') throw error;
    state('FAILURE PASS', 'A synthetic HTTP 503 rejected. No successful partial ZIP was offered.');
  }
  if (!rejected) throw new Error('HTTP 503 incorrectly returned an archive');
}
function action(id, fn) {
  document.querySelector(`#${id}`).addEventListener('click', async () => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try { await fn(); } catch (error) { state('SELFTEST FAIL', `${error.name}: ${error.message}`); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
action('small', () => runZip('small'));
action('medium', () => runZip('medium'));
action('large', () => runZip('large'));
action('cancel', runCancel);
action('failure', runFailure);
action('ui', () => browser.tabs.create({url: browser.runtime.getURL('downloads.html?sourceTab=42')}));
