/** Parse one bounded TLS ClientHello. Return null when more bytes are needed. */
export function clientHelloServerName(data: Buffer): string | null {
  if (data.length < 5) return null;
  if (data[0] !== 22 || data[1] !== 3) throw new Error('TLS handshake required');
  const recordLength = data.readUInt16BE(3);
  if (recordLength > 16384 || recordLength < 4) throw new Error('Invalid TLS record');
  if (data.length < 5 + recordLength) return null;
  const end = 5 + recordLength;
  if (data[5] !== 1 || data.readUIntBE(6, 3) !== recordLength - 4) throw new Error('Invalid ClientHello');
  let p = 9;
  const take = (n: number) => { if (n < 0 || p + n > end) throw new Error('Truncated ClientHello'); const start = p; p += n; return start; };
  take(34);
  const sessionLength = data[take(1)]; take(sessionLength);
  const cipherLength = data.readUInt16BE(take(2)); if (!cipherLength || cipherLength % 2) throw new Error('Invalid ciphers'); take(cipherLength);
  const compressionLength = data[take(1)]; take(compressionLength);
  const extensionLength = data.readUInt16BE(take(2)); if (p + extensionLength !== end) throw new Error('Invalid extensions');
  let hostname: string | undefined, seenSni = false;
  while (p < end) {
    const type = data.readUInt16BE(take(2)); const length = data.readUInt16BE(take(2)); const start = take(length);
    if (type === 0xfe0d || type === 0xffce) throw new Error('Encrypted ClientHello is unsupported');
    if (type !== 0) continue;
    if (seenSni || length < 5) throw new Error('Invalid SNI'); seenSni = true;
    const listLength = data.readUInt16BE(start); if (listLength !== length - 2 || data[start + 2] !== 0) throw new Error('Invalid SNI');
    const nameLength = data.readUInt16BE(start + 3); if (!nameLength || nameLength !== length - 5) throw new Error('Invalid SNI');
    const nameBytes = data.subarray(start + 5, start + 5 + nameLength);
    if (nameBytes.some(byte => byte > 127)) throw new Error('Invalid SNI');
    hostname = nameBytes.toString('ascii');
    if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error('Invalid SNI');
  }
  if (!hostname) throw new Error('SNI required');
  return hostname;
}
