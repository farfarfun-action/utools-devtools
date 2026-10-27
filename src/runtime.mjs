import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const RUNTIME_URL = 'https://open.u-tools.cn/download/utools_8.0.2_amd64.deb';
export const DEB_SHA256 = '3904b1081ae0562cd1ae4c3f3d33592521f3a9001f72392b5b0228cde3c23056';
export const ADDON_SHA256 = 'b8f96f70e87d2f5c07f1fae9182d6d1472b66403d4ede8a73cd3bfdf1ae96086';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function profileFromRuntime(binary) {
  if (sha256(binary) !== ADDON_SHA256) throw new Error('Unsupported runtime: expected the pinned uTools 8.0.2 Linux x64 addon');
  const phoff = Number(binary.readBigUInt64LE(32));
  const entsize = binary.readUInt16LE(54);
  const count = binary.readUInt16LE(56);
  function at(address, size) {
    for (let i = 0; i < count; i++) {
      const start = phoff + i * entsize;
      const offset = Number(binary.readBigUInt64LE(start + 8));
      const vaddr = Number(binary.readBigUInt64LE(start + 16));
      const length = Number(binary.readBigUInt64LE(start + 32));
      if (binary.readUInt32LE(start) === 1 && vaddr <= address && address + size <= vaddr + length) {
        return binary.subarray(offset + address - vaddr, offset + address - vaddr + size);
      }
    }
    throw new Error('Runtime address is not mapped');
  }
  function constants(address, keySeed, nonceSeed) {
    const decode = (bytes, seed) => Buffer.from(bytes.map((b, i) => b ^ ((seed + i) & 255)));
    const nonce = Buffer.alloc(25);
    at(address + 32, 16).copy(nonce);
    at(address + 48, 16).copy(nonce, 9);
    return { key: decode(at(address, 32), keySeed), nonce: decode(nonce.subarray(0, 24), nonceSeed) };
  }
  // shortcut: offsets support only this pinned binary; add a separately verified profile for newer runtimes.
  return { header: constants(0x27b040, 0x38, 0x18), check: constants(0x27af20, 0x42, 0x24) };
}

export async function loadProfile(file) {
  if (!file) throw new Error('Pass --runtime <linux-x64.node>; run prepare-runtime first');
  return profileFromRuntime(await readFile(file));
}

export async function prepareRuntime(output) {
  const response = await fetch(RUNTIME_URL, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
  const deb = Buffer.from(await response.arrayBuffer());
  if (sha256(deb) !== DEB_SHA256) throw new Error('Official runtime download checksum changed; refusing to use it');
  let data;
  for (let offset = 8; offset + 60 <= deb.length;) {
    const name = deb.toString('ascii', offset, offset + 16).trim().replace(/\/$/, '');
    const size = Number(deb.toString('ascii', offset + 48, offset + 58).trim());
    if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > deb.length) throw new Error('Invalid DEB member');
    if (name === 'data.tar.xz') data = deb.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + size % 2;
  }
  if (!data) throw new Error('Official DEB has no data.tar.xz');
  const binary = execFileSync('tar', ['-xJOf', '-', './opt/uTools/resources/app.asar.unpacked/node_modules/addon/linux-x64.node'], {
    input: data, maxBuffer: 10 * 1024 * 1024, timeout: 120_000,
  });
  profileFromRuntime(binary);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, binary, { flag: 'wx', mode: 0o600 });
  return { runtime: output, sha256: ADDON_SHA256 };
}
