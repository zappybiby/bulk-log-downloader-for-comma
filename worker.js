const LOG_PREFIX = "[comma-log-downloader]";
const DEBUG_LOGGING = false;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "comma-log-fetch") {
    return;
  }

  const context = {
    disconnected: false,
    controllers: new Map()
  };
  const pendingAcks = new Map();

  port.onMessage.addListener((message) => {
    if (message?.type === "start") {
      log("worker stream requested", { id: message.id, url: message.url });
      streamFile(port, context, message, pendingAcks);
      return;
    }

    if (message?.type === "ack") {
      const key = `${message.id}:${message.sequence}`;
      const resolve = pendingAcks.get(key);
      if (resolve) {
        pendingAcks.delete(key);
        resolve(true);
      }
    }
  });

  port.onDisconnect.addListener(() => {
    log("worker port disconnected");
    context.disconnected = true;
    for (const controller of context.controllers.values()) {
      controller.abort();
    }
    context.controllers.clear();
    for (const resolve of pendingAcks.values()) {
      resolve(false);
    }
    pendingAcks.clear();
  });
});

async function streamFile(port, context, message, pendingAcks) {
  const { id, url } = message;
  const controller = new AbortController();
  context.controllers.set(id, controller);

  try {
    log("worker fetch started", { id, url });
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const size = Number(response.headers.get("content-length")) || 0;
    log("worker fetch response", { id, status: response.status, size });
    post(port, context, {
      type: "meta",
      id,
      size,
      disposition: response.headers.get("content-disposition") || ""
    });

    const reader = response.body.getReader();
    let sequence = 0;
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      post(port, context, {
        type: "chunk",
        id,
        sequence,
        received,
        data: bytesToBase64(value)
      });

      const acknowledged = await waitForAck(pendingAcks, id, sequence);
      if (!acknowledged || context.disconnected) {
        return;
      }
      sequence += 1;
    }

    log("worker stream finished", { id, received });
    post(port, context, { type: "done", id, received });
  } catch (error) {
    log("worker stream failed", { id, error: error?.message || String(error) });
    post(port, context, {
      type: "error",
      id,
      message: error?.message || String(error)
    });
  } finally {
    context.controllers.delete(id);
  }
}

function waitForAck(pendingAcks, id, sequence) {
  return new Promise((resolve) => {
    pendingAcks.set(`${id}:${sequence}`, resolve);
  });
}

function post(port, context, message) {
  if (!context.disconnected) {
    port.postMessage(message);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function log(message, data) {
  if (!DEBUG_LOGGING) {
    return;
  }

  if (data === undefined) {
    console.info(LOG_PREFIX, message);
    return;
  }

  console.info(LOG_PREFIX, message, data);
}
