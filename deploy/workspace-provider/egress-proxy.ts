import { createServer, type Socket } from 'node:net';
import { clientHelloServerName } from './tls-client-hello.js';
import { requireUnprotectedDestination, resolveDependencyDestination, type DependencyEgressPolicy } from './egress-policy.js';

/** Experimental CONNECT gate; not wired to workspaces. Trusted host-address
 * discovery, authority enforcement and namespace wiring are required before exposure. */
export function dependencyEgressProxy(policy: DependencyEgressPolicy, options: {
  lookup: (hostname: string) => Promise<{ address: string; family: number }[]>;
  protectedAddresses: () => Promise<readonly string[]>;
  connect: (address: string, port: number) => Socket;
}) {
  return createServer(client => {
    let bytes = Buffer.alloc(0), started = false;
    const timeout = setTimeout(() => client.destroy(), 10000);
    const reject = () => { clearTimeout(timeout); client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
    client.on('error', () => client.destroy());
    client.on('data', async chunk => {
      if (started) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 8192) { started = true; reject(); return; }
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return;
      started = true; client.pause();
      const header = bytes.subarray(0, end).toString('latin1');
      const lines = header.split('\r\n');
      const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(lines[0]);
      if (!match || lines.slice(1).some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e]*$/.test(line))) { reject(); return; }
      try {
        const addresses = await resolveDependencyDestination(policy, match[1], 443, options.lookup);
        const protectedAddresses = await options.protectedAddresses();
        requireUnprotectedDestination(addresses, protectedAddresses);
        if (client.destroyed) return;
        clearTimeout(timeout);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let hello = bytes.subarray(end + 4);
        const handshakeTimeout = setTimeout(() => client.destroy(), 10000);
        const inspect = () => {
          try {
            if (hello.length > 16389) throw new Error('ClientHello too large');
            const name = clientHelloServerName(hello);
            if (name === null) return;
            if (name !== match[1]) throw new Error('TLS destination mismatch');
            client.removeListener('data', receiveHello);
            clearTimeout(handshakeTimeout);
            const upstream = options.connect(addresses[0], 443);
            upstream.once('error', () => { upstream.destroy(); client.destroy(); });
            upstream.once('connect', () => { upstream.write(hello); client.pipe(upstream); upstream.pipe(client); client.resume(); });
            client.once('close', () => upstream.destroy());
          } catch { clearTimeout(handshakeTimeout); client.destroy(); }
        };
        const receiveHello = (chunk: Buffer) => { hello = Buffer.concat([hello, chunk]); inspect(); };
        client.on('data', receiveHello); client.once('close', () => clearTimeout(handshakeTimeout));
        inspect(); client.resume();
      } catch { reject(); }
    });
    client.once('close', () => clearTimeout(timeout));
  });
}
