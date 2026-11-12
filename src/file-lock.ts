import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function processExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

type RegistryClaim = { path: string; id: string; pid: number; choosing: boolean; ticket: number };

async function readClaims(directory: string): Promise<RegistryClaim[]> {
  const claims: RegistryClaim[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = /^(\d+)-([a-f0-9-]+)\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const pid = Number(match[1]);
    const path = join(directory, entry.name);
    if (!processExists(pid)) {
      // Every owner has a unique filename, so this cannot remove a replacement owner's claim.
      await rm(path, { force: true });
      continue;
    }
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object' || !('ticket' in value) || !('choosing' in value)
        || !Number.isSafeInteger(value.ticket) || Number(value.ticket) < 0 || typeof value.choosing !== 'boolean') {
        throw new Error('Incomplete claim');
      }
      claims.push({ path, id: entry.name, pid, ticket: Number(value.ticket), choosing: value.choosing });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // A live owner may still be publishing its claim. Wait instead of bypassing it.
      claims.push({ path, id: entry.name, pid, ticket: 0, choosing: true });
    }
  }
  return claims;
}

/** Serialize short registry transactions with per-owner tickets that survive abandoned contenders. */
export async function registryTransaction<T>(directory: string, operation: () => Promise<T>, timeoutMs = 30000): Promise<T> {
  const locks = join(directory, '.lock');
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}.json`;
  const claimPath = join(locks, id);
  const updateClaim = async (choosing: boolean, ticket: number) => {
    const temporary = `${claimPath}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ choosing, ticket }), { mode: 0o600 });
      await rename(temporary, claimPath);
    } finally { await rm(temporary, { force: true }); }
  };
  try {
    await updateClaim(true, 0);
    const claims = await readClaims(locks);
    const ticket = Math.max(0, ...claims.map(claim => claim.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Deployment registry lock ticket overflow');
    await updateClaim(false, ticket);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const contenders = await readClaims(locks);
      const waiting = contenders.some(claim => claim.id !== id && (claim.choosing
        || claim.ticket < ticket || (claim.ticket === ticket && claim.id < id)));
      if (!waiting) break;
      if (Date.now() >= deadline) throw new Error('Deployment registry is busy. Retry after the active registry transaction finishes.');
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    return await operation();
  } finally { await rm(claimPath, { force: true }); }
}

