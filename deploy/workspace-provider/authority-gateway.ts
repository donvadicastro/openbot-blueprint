import { createServer, request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { SecureContext, TLSSocket } from 'node:tls';
import { requireUnprotectedDestination, resolveDependencyDestination, type DependencyEgressPolicy } from './egress-policy.js';

type UpstreamRequest = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

/**
 * Experimental HTTPS gateway. It terminates TLS so every HTTP authority can be
 * checked, including requests sharing an upstream IP. It is not wired to VMs:
 * trusted certificate provisioning and namespace enforcement are still needed.
 */
export function dependencyAuthorityGateway(policy: DependencyEgressPolicy, options: {
  certificates: ReadonlyMap<string, SecureContext>;
  lookup: (hostname: string) => Promise<{ address: string; family: number }[]>;
  protectedAddresses: () => Promise<readonly string[]>;
  requestUpstream?: UpstreamRequest;
}) {
  const allowed = new Set(policy.destinations.map(item => item.hostname));
  const openUpstream: UpstreamRequest = options.requestUpstream ?? ((requestOptions, onResponse) => httpsRequest(requestOptions, onResponse));
  const server = createServer({
    SNICallback(name, callback) {
      const hostname = name.toLowerCase();
      const certificate = allowed.has(hostname) ? options.certificates.get(hostname) : undefined;
      if (!certificate) return callback(new Error('Unauthorized dependency hostname.'));
      callback(null, certificate);
    },
  }, (client, response) => { void handle(client, response); });
  const reject = (response: ServerResponse, status: number) => { if (!response.headersSent) response.writeHead(status, { connection: 'close' }); response.end(); };
  async function handle(client: IncomingMessage, response: ServerResponse) {
    const sni = (client.socket as TLSSocket).servername;
    const hostname = typeof sni === 'string' ? sni.toLowerCase() : undefined;
    const hostHeaders = client.rawHeaders.filter((_, index) => index % 2 === 0 && client.rawHeaders[index].toLowerCase() === 'host');
    const authority = client.headers.host?.toLowerCase();
    const length = client.headers['content-length'];
    if (!hostname || !allowed.has(hostname) || hostHeaders.length !== 1 || (authority !== hostname && authority !== `${hostname}:443`) ||
        client.httpVersionMajor !== 1 || !['GET', 'HEAD'].includes(client.method ?? '') ||
        !client.url?.startsWith('/') || client.url.startsWith('//') || client.headers.upgrade ||
        client.headers['transfer-encoding'] || (length !== undefined && length !== '0')) return reject(response, 403);
    try {
      const addresses = await resolveDependencyDestination(policy, hostname, 443, options.lookup);
      requireUnprotectedDestination(addresses, await options.protectedAddresses());
      if (client.destroyed) return;
      const headers: IncomingHttpHeaders = { ...client.headers };
      for (const name of String(client.headers.connection ?? '').split(',').map(item => item.trim().toLowerCase())) if (name) delete headers[name];
      for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[name];
      // The hop-by-hop list is client-controlled and may itself name Host.
      headers.host = hostname;
      const upstream = openUpstream({ hostname: addresses[0], port: 443, servername: hostname, rejectUnauthorized: true,
        method: client.method, path: client.url, headers, agent: false }, upstreamResponse => {
        const resultHeaders = { ...upstreamResponse.headers };
        for (const name of String(upstreamResponse.headers.connection ?? '').split(',').map(item => item.trim().toLowerCase())) if (name) delete resultHeaders[name];
        for (const name of ['connection', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'keep-alive', 'te', 'transfer-encoding', 'trailer', 'upgrade']) delete resultHeaders[name];
        response.writeHead(upstreamResponse.statusCode ?? 502, resultHeaders);
        upstreamResponse.on('error', () => response.destroy());
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout(15000, () => upstream.destroy());
      upstream.on('error', () => reject(response, 502));
      response.on('close', () => upstream.destroy());
      upstream.end();
    } catch { reject(response, 403); }
  }
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  return server;
}
