import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// A slow real network for the native listening-clock case, not a media fixture:
// forward the backend's status, headers and bytes without decoding/replacing them.
export async function startMediaRelay(backendURL) {
  const backend = new URL(backendURL);
  const requests = new Set();
  const controllers = new Set();
  const records = [];
  const bytesPerSecond = 64 * 1024;
  const chunkBytes = 16 * 1024;
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    controllers.add(controller);
    const upstream = request({ hostname: backend.hostname, port: backend.port,
      method: incoming.method, path: incoming.url, headers: incoming.rawHeaders,
    });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    outgoing.once('close', () => {
      controller.abort();
      controllers.delete(controller);
      upstream.destroy();
    });
    incoming.once('aborted', () => upstream.destroy());
    upstream.once('error', error => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.destroy(error);
    });
    upstream.once('response', async response => {
      outgoing.writeHead(response.statusCode, response.statusMessage, response.rawHeaders);
      const paced = response.statusCode >= 200 && response.statusCode < 300
        && /^audio\//i.test(String(response.headers['content-type'] ?? ''));
      const record = paced ? { method: incoming.method, path: incoming.url,
        range: incoming.headers.range ?? null, status: response.statusCode,
        contentType: response.headers['content-type'], contentRange: response.headers['content-range'] ?? null,
        contentLength: response.headers['content-length'] ?? null, bytes: 0, elapsedMs: 0 } : null;
      if (record) records.push(record);
      const started = performance.now();
      let nextWrite = started;
      try {
        for await (const chunk of response) {
          for (let offset = 0; offset < chunk.length; offset += paced ? chunkBytes : chunk.length) {
            if (controller.signal.aborted) return;
            if (paced && nextWrite > performance.now()) {
              await delay(nextWrite - performance.now(), undefined, { signal: controller.signal });
            }
            const part = chunk.subarray(offset, paced ? Math.min(offset + chunkBytes, chunk.length) : chunk.length);
            const writable = outgoing.write(part);
            if (record) record.bytes += part.length;
            nextWrite = performance.now() + part.length / bytesPerSecond * 1000;
            if (!writable) await once(outgoing, 'drain', { signal: controller.signal });
          }
        }
        outgoing.end();
      } catch (error) {
        if (!controller.signal.aborted) outgoing.destroy(error);
      } finally {
        if (record) record.elapsedMs = performance.now() - started;
        response.destroy();
      }
    });
    incoming.pipe(upstream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stopping;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    records,
    bytesPerSecond,
    chunkBytes,
    stop: () => stopping ??= (async () => {
      for (const controller of controllers) controller.abort();
      for (const upstream of requests) upstream.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    })(),
  };
}
