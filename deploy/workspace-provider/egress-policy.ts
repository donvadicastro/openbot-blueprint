import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/** Explicit HTTPS destinations for a future isolated workspace egress adapter. */
export type DependencyEgressPolicy = { destinations: { hostname: string; port: number }[] };

/** Parse configuration without resolving DNS or granting network access. */
export function parseDependencyEgressPolicy(input: unknown): DependencyEgressPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'destinations')) throw new Error('Invalid dependency egress policy.');
  const destinations = (input as Record<string, unknown>).destinations;
  if (!Array.isArray(destinations) || destinations.length > 100) throw new Error('Invalid dependency egress policy.');
  const seen = new Set<string>();
  const parsed = destinations.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'hostname' && key !== 'port')) throw new Error('Invalid dependency destination.');
    const { hostname, port } = value as Record<string, unknown>;
    if (typeof hostname !== 'string' || hostname !== hostname.toLowerCase() || hostname.length > 253 || isIP(hostname) ||
        !hostname.includes('.') || hostname.endsWith('.') || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        ['localhost', 'local', 'internal', 'localhost.localdomain'].some(suffix => hostname === suffix || hostname.endsWith('.' + suffix)) ||
        port !== 443) throw new Error('Invalid dependency destination.');
    const key = `${hostname}:${port}`;
    if (seen.has(key)) throw new Error('Duplicate dependency destination.');
    seen.add(key);
    return { hostname, port };
  });
  return { destinations: parsed };
}

/** Reject non-public IPv4 destinations. IPv6 is denied until its routing policy is enforced.
 * IPv4 special-purpose ranges: https://www.iana.org/assignments/iana-ipv4-special-registry */
export function isPublicDependencyAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

/** Resolve an explicitly authorized name and reject mixed public/private answers. */
export async function resolveDependencyDestination(policy: DependencyEgressPolicy, hostname: string, port: number,
  lookup: (name: string) => Promise<{ address: string; family: number }[]>) {
  if (!policy.destinations.some(destination => destination.hostname === hostname && destination.port === port)) throw new Error('Dependency destination is not authorized.');
  const records = await lookup(hostname);
  if (!Array.isArray(records) || !records.length || records.length > 100 || records.some(record => !record || record.family !== 4 || !isPublicDependencyAddress(record.address))) {
    throw new Error('Dependency destination did not resolve exclusively to permitted addresses.');
  }
  // Callers must connect to one of these addresses directly, retaining the
  // original hostname for TLS verification, and must not resolve it again.
  return [...new Set(records.map(record => record.address))];
}

/** Fail closed unless the caller supplies protected IPv4 addresses and none match. */
export function requireUnprotectedDestination(addresses: readonly string[], protectedAddresses: readonly string[]) {
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(address => typeof address !== 'string' || !isPublicDependencyAddress(address)) ||
      !Array.isArray(protectedAddresses) || !protectedAddresses.length || protectedAddresses.some(address => typeof address !== 'string' || isIP(address) !== 4) ||
      addresses.some(address => protectedAddresses.includes(address))) throw new Error('Dependency destination overlaps a protected address.');
}

/**
 * Combine current host interfaces with operator-supplied external addresses.
 * The operator must supply every public address that can route to this host;
 * interface enumeration alone cannot discover NAT or externally routed IPs.
 * Call again for every decision, and keep egress disabled if the list cannot
 * be maintained authoritatively. IPv6 destinations remain unsupported.
 */
export function discoverProtectedAddresses(externalAddresses: readonly string[],
  interfaces: Record<string, readonly { address: string; family: string }[] | undefined> = networkInterfaces()): string[] {
  if (!Array.isArray(externalAddresses) || !externalAddresses.length ||
      externalAddresses.some(address => typeof address !== 'string' || !isPublicDependencyAddress(address))) {
    throw new Error('Configure the complete set of public host addresses before enabling dependency egress.');
  }
  if (!interfaces || typeof interfaces !== 'object' || Array.isArray(interfaces)) throw new Error('Host interface discovery failed.');
  const addresses = new Set<string>(externalAddresses);
  let count = 0;
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    if (!Array.isArray(entries)) throw new Error('Host interface discovery failed.');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new Error('Host interface discovery failed.');
      if (entry.family === 'IPv6') {
        if (typeof entry.address !== 'string' || isIP(entry.address) !== 6) throw new Error('Host interface discovery failed.');
        continue;
      }
      if (entry.family !== 'IPv4') throw new Error('Host interface discovery failed.');
      if (typeof entry.address !== 'string' || isIP(entry.address) !== 4) throw new Error('Host interface discovery failed.');
      addresses.add(entry.address);
      count++;
    }
  }
  if (!count) throw new Error('Host interface discovery failed.');
  return [...addresses].sort();
}
