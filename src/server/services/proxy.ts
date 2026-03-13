import type { FastifyRequest, FastifyReply } from 'fastify';
import { getMachine, getTunnelToken } from './machine-discovery.js';

const PROXY_TIMEOUT_MS = 30_000; // 30 second timeout
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB response body limit

// Only proxy requests to known RemoteAgent API paths — prevents SSRF
const ALLOWED_PATH_PREFIXES = ['/api/', '/ws/'];

// Machine IDs are 16-char hex strings (from SHA-256) or 'local' — reject anything else
const VALID_MACHINE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validate that a tunnel URL looks like a devtunnel URL.
 */
export function isValidTunnelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.endsWith('.devtunnels.ms');
  } catch {
    return false;
  }
}

/**
 * Proxy an HTTP request to a remote machine.
 * Strips the /proxy/:machineId prefix and forwards to the remote machine's tunnel URL.
 */
export async function proxyHttpRequest(
  machineId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Validate machineId format (defense-in-depth — Fastify param won't contain slashes,
  // but reject unexpected characters before they reach getMachine or log messages)
  if (!VALID_MACHINE_ID.test(machineId)) {
    reply.status(400).send({ error: 'Invalid machine ID' });
    return;
  }

  const machine = await getMachine(machineId);

  if (!machine) {
    reply.status(404).send({ error: 'Machine not found' });
    return;
  }

  if (machine.isLocal) {
    reply.status(400).send({ error: 'Cannot proxy to local machine' });
    return;
  }

  // Don't reject based on cached status — it may be stale.
  // Let the actual connection attempt determine if the machine is reachable.

  if (!machine.tunnelUrl) {
    reply.status(502).send({ error: `Machine "${machine.name}" has no tunnel URL` });
    return;
  }

  // Validate tunnel URL is actually a devtunnel URL (prevent SSRF)
  if (!isValidTunnelUrl(machine.tunnelUrl)) {
    reply.status(502).send({ error: `Machine "${machine.name}" has an invalid tunnel URL` });
    return;
  }

  // Extract the path after /proxy/:machineId/
  const fullUrl = request.url;
  const proxyPrefix = `/proxy/${machineId}`;
  let targetPath = fullUrl.slice(proxyPrefix.length) || '/';

  // Decode percent-encoding before validation to prevent %2e%2e bypass
  try {
    targetPath = decodeURIComponent(targetPath);
  } catch {
    reply.status(400).send({ error: 'Invalid proxy path encoding' });
    return;
  }

  // Reject path traversal attempts (defense-in-depth, matches WS proxy check)
  if (targetPath.includes('..') || targetPath.includes('//')) {
    reply.status(400).send({ error: 'Invalid proxy path' });
    return;
  }

  // Validate the target path starts with an allowed prefix (prevent SSRF to arbitrary paths)
  if (!ALLOWED_PATH_PREFIXES.some(prefix => targetPath.startsWith(prefix))) {
    reply.status(403).send({ error: 'Proxy path not allowed' });
    return;
  }

  const targetUrl = `${machine.tunnelUrl}${targetPath}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    // Build headers — forward most headers but strip sensitive and hop-by-hop ones
    const headers: Record<string, string> = {};
    const STRIPPED_HEADERS = new Set([
      'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
      'cookie', 'authorization', 'proxy-authorization', 'content-length',
    ]);
    for (const [key, value] of Object.entries(request.headers)) {
      if (STRIPPED_HEADERS.has(key.toLowerCase())) {
        continue;
      }
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    // Inject tunnel access token for devtunnel auth (server-to-server, no browser cookies)
    if (machine.tunnelId) {
      const token = getTunnelToken(machine.tunnelId);
      if (token) {
        headers['x-tunnel-authorization'] = `tunnel ${token}`;
      }
    }

    // Forward the request
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
      signal: controller.signal,
    };

    // Include body for methods that support it
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const rawBody = request.body;
      if (rawBody !== undefined && rawBody !== null) {
        if (typeof rawBody === 'string' || Buffer.isBuffer(rawBody)) {
          fetchOptions.body = rawBody as any;
        } else {
          fetchOptions.body = JSON.stringify(rawBody);
          if (!headers['content-type']) {
            headers['content-type'] = 'application/json';
          }
        }
      }
    }

    const response = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeout);

    // Buffer response body FIRST (before setting reply status/headers)
    // This ensures we can still send a clean 502 if the body exceeds the size limit
    let responseBody: Buffer | null = null;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          reply.status(502).send({ error: `Response from machine exceeded ${MAX_RESPONSE_SIZE / 1024 / 1024}MB limit` });
          return;
        }
        chunks.push(value);
      }

      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      responseBody = Buffer.from(combined);
    }

    // Now that body is fully buffered and validated, set status + headers + send
    reply.status(response.status);

    // Forward response headers (strip hop-by-hop, set-cookie, and content-encoding
    // since fetch() auto-decompresses gzip/brotli — forwarding the header would cause
    // the browser to try decompressing the already-decompressed body → ERR_CONTENT_DECODING_FAILED)
    for (const [key, value] of response.headers.entries()) {
      if (['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'content-encoding', 'content-length'].includes(key.toLowerCase())) {
        continue;
      }
      reply.header(key, value);
    }
    // Defense-in-depth: explicitly remove set-cookie in case multiple Set-Cookie headers
    // leaked through (some runtimes don't merge them in headers.entries())
    reply.removeHeader('set-cookie');

    reply.send(responseBody ?? '');
  } catch (err: any) {
    if (err.name === 'AbortError') {
      reply.status(504).send({ error: `Proxy timeout: remote machine did not respond within ${PROXY_TIMEOUT_MS / 1000}s` });
    } else if (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED') {
      reply.status(502).send({ error: 'Connection refused: remote machine is not accepting connections' });
    } else {
      console.error(`[Proxy] Error proxying to ${machine.name} (${targetUrl}):`, err.message);
      reply.status(502).send({ error: 'Proxy error: failed to reach remote machine' });
    }
  }
}
