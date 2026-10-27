import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile, writeFile, stat, lstat, readdir, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackage } from '@electron/asar';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from './runtime.mjs';

const MAX_PACKAGE = 128 * 1024 * 1024;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_HEADER = 8 * 1024 * 1024;
const MAX_FILES = 50_000;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const crypt = (profile) => xchacha20poly1305(profile.key, profile.nonce);

function component(name) {
  requireValue(typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
    && !/[\\/:\x00-\x1f<>"|?*]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'Unsafe archive path');
}
function assetPath(name) {
  requireValue(typeof name === 'string' && name.length > 0, 'Invalid asset path');
  name.split('/').forEach(component);
  return name;
}
export async function readBounded(file, max = MAX_PACKAGE) {
  const info = await stat(file);
  requireValue(info.isFile() && info.size <= max, 'Input exceeds size limit or is not a file');
  const bytes = await readFile(file);
  requireValue(bytes.length <= max, 'Input exceeds size limit');
  return bytes;
}

export function identityFrom(metadata) {
  const result = {};
  for (const name of ['os', 'app', 'developer', 'pluginId', 'ownerId']) {
    if (Object.hasOwn(metadata, name)) result[name] = metadata[name];
  }
  requireValue(isObject(result.os) && isObject(result.app) && isObject(result.developer)
    && typeof result.pluginId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.pluginId), 'Invalid package identity');
  return result;
}

export function seal(metadata, compressed, profile) {
  const header = Buffer.from(crypt(profile.header).encrypt(Buffer.from(JSON.stringify(metadata))));
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(metadata.key, 'hex'), Buffer.from(metadata.iv, 'hex'));
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  return Buffer.concat([length, header, body]);
}

export function open(bytes, profile) {
  requireValue(bytes.length >= 36 && bytes.length <= MAX_PACKAGE, 'Invalid UPXS size');
  const length = bytes.readUInt32LE(0);
  requireValue(length >= 16 && length <= MAX_HEADER && 4 + length < bytes.length, 'Invalid UPXS metadata length');
  let metadata;
  try { metadata = JSON.parse(Buffer.from(crypt(profile.header).decrypt(bytes.subarray(4, 4 + length))).toString('utf8')); }
  catch { throw new Error('UPXS metadata authentication failed'); }
  identityFrom(metadata);
  requireValue(typeof metadata.key === 'string' && /^[0-9a-f]{64}$/i.test(metadata.key)
    && typeof metadata.iv === 'string' && /^[0-9a-f]{32}$/i.test(metadata.iv)
    && Number.isSafeInteger(metadata.timestamp) && metadata.timestamp > 0
    && typeof metadata.encrypt2 === 'string' && /^(?:[0-9a-f]{2}){16,512}$/i.test(metadata.encrypt2), 'Invalid UPXS crypto metadata');
  let check;
  try { check = Buffer.from(crypt(profile.check).decrypt(Buffer.from(metadata.encrypt2, 'hex'))).toString('utf8'); }
  catch { throw new Error('UPXS binding authentication failed'); }
  requireValue(check === metadata.pluginId + metadata.timestamp, 'Plugin ID/timestamp binding mismatch');
  let compressed, archive;
  try {
    const cipher = createDecipheriv('aes-256-cbc', Buffer.from(metadata.key, 'hex'), Buffer.from(metadata.iv, 'hex'));
    compressed = Buffer.concat([cipher.update(bytes.subarray(4 + length)), cipher.final()]);
    archive = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE });
  } catch { throw new Error('Invalid UPXS payload or decompression limit exceeded'); }
  const warnings = [];
  const files = inspectArchive(archive, warnings);
  const manifest = validateManifest(files, metadata.pluginId);
  return { metadata, compressed, archive, files, manifest, warnings };
}

export function inspectArchive(archive, warnings) {
  requireValue(archive.length >= 16 && archive.length <= MAX_ARCHIVE && archive.readUInt32LE(0) === 4, 'Invalid ASAR header');
  const size = archive.readUInt32LE(4);
  const jsonSize = archive.readUInt32LE(12);
  requireValue(size >= 8 && size <= MAX_HEADER && size % 4 === 0 && size + 8 <= archive.length
    && archive.readUInt32LE(8) === size - 4 && jsonSize <= size - 8, 'Invalid ASAR header size');
  let header;
  try { header = JSON.parse(archive.toString('utf8', 16, 16 + jsonSize)); }
  catch { throw new Error('Invalid ASAR JSON'); }
  const files = new Map();
  const seen = new Set();
  const ranges = [];
  function walk(node, parents = []) {
    requireValue(isObject(node) && isObject(node.files) && parents.length < 64, 'Invalid ASAR directory');
    for (const [name, entry] of Object.entries(node.files)) {
      component(name);
      const parts = [...parents, name];
      const path = parts.join('/');
      const key = path.normalize('NFC').toLowerCase();
      requireValue(!seen.has(key) && seen.size < MAX_FILES, 'Duplicate path or too many archive entries');
      seen.add(key);
      requireValue(isObject(entry) && !Object.hasOwn(entry, 'link') && !entry.unpacked, 'Links and external ASAR files are not supported');
      if (Object.hasOwn(entry, 'files')) { walk(entry, parts); continue; }
      requireValue(typeof entry.offset === 'string' && /^\d+$/.test(entry.offset)
        && Number.isSafeInteger(entry.size) && entry.size >= 0, 'Invalid ASAR file bounds');
      const offset = Number(entry.offset);
      const start = 8 + size + offset;
      const end = start + entry.size;
      requireValue(Number.isSafeInteger(offset) && Number.isSafeInteger(end) && end <= archive.length, 'ASAR file exceeds archive');
      const bytes = archive.subarray(start, end);
      if (entry.integrity) {
        const integrity = entry.integrity;
        requireValue(integrity.algorithm === 'SHA256'
          && Number.isSafeInteger(integrity.blockSize) && integrity.blockSize > 0
          && Array.isArray(integrity.blocks), 'ASAR integrity check failed');
        const expectedBlocks = Math.ceil(bytes.length / integrity.blockSize);
        requireValue(integrity.blocks.length === expectedBlocks || (!bytes.length && integrity.blocks.length === 1), 'Invalid ASAR integrity block count');
        const hashes = [];
        for (let i = 0; i < bytes.length; i += integrity.blockSize) hashes.push(sha256(bytes.subarray(i, i + integrity.blockSize)));
        // Electron also writes one empty block for empty files.
        if (!bytes.length && integrity.blocks.length === 1) hashes.push(sha256(bytes));
        const valid = integrity.hash === sha256(bytes) && JSON.stringify(hashes) === JSON.stringify(integrity.blocks);
        if (!valid && path === 'plugin.json' && warnings) {
          // Official exports can replace plugin.json without refreshing its stored ASAR hash.
          warnings.push('plugin.json ASAR integrity mismatch; also observed in the pinned official developer export');
        } else requireValue(valid, 'ASAR integrity check failed');
      }
      if (entry.size) ranges.push([start, end]);
      files.set(path, { bytes, executable: entry.executable === true });
    }
  }
  walk(header);
  ranges.sort((a, b) => a[0] - b[0]);
  let end = 8 + size;
  for (const range of ranges) { requireValue(range[0] === end, 'Overlapping or gapped ASAR files'); end = range[1]; }
  requireValue(end === archive.length, 'Unexpected trailing ASAR data');
  return files;
}

function validateManifest(files, pluginId) {
  requireValue(files.has('plugin.json'), 'Missing plugin.json');
  let manifest;
  try { manifest = JSON.parse(files.get('plugin.json').bytes.toString('utf8')); }
  catch { throw new Error('Invalid plugin.json'); }
  requireValue(isObject(manifest) && manifest.name === pluginId, 'Manifest name must match the package plugin ID');
  requireValue(typeof manifest.pluginName === 'string' && manifest.pluginName.trim()
    && typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version)
    && Array.isArray(manifest.features) && manifest.features.length > 0, 'Missing plugin name, version or features');
  requireValue(manifest.main || manifest.preload, 'Plugin needs main or preload');
  for (const field of ['main', 'preload', 'logo']) {
    if (manifest[field] !== undefined) requireValue(files.has(assetPath(manifest[field])), `Missing ${field} asset`);
  }
  return manifest;
}

export function summary(result) {
  return { pluginId: result.metadata.pluginId, pluginName: result.manifest.pluginName,
    version: result.manifest.version, files: result.files.size, archiveBytes: result.archive.length,
    archiveSha256: sha256(result.archive), formatVerified: true,
    integrityVerified: result.warnings.length === 0, warnings: result.warnings, clientInstallVerified: false };
}

export async function pack(source, output, identity, profile, identityFile) {
  source = resolve(source); output = resolve(output);
  const privateIdentity = identityFile && resolve(identityFile);
  const rel = relative(source, output);
  requireValue(rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel), 'Output must be outside source directory');
  identity = identityFrom(identity);
  requireValue(typeof identity.developer.uid === 'string' && identity.developer.uid.length > 0
    && typeof identity.os.mid === 'string' && identity.os.mid.length > 0, 'Use an identity exported from your own official package');
  const temp = await mkdtemp(join(tmpdir(), 'utools-pack-'));
  try {
    const stage = join(temp, 'source');
    await mkdir(stage);
    let count = 0, total = 0;
    async function copy(from, to, depth = 0) {
      requireValue(depth < 64 && !(await lstat(from)).isSymbolicLink(), 'Source links or excessive nesting are not supported');
      for (const entry of await readdir(from, { withFileTypes: true })) {
        component(entry.name);
        requireValue(++count <= MAX_FILES, 'Too many source files');
        const src = join(from, entry.name), dst = join(to, entry.name);
        if (entry.name === 'identity.json' || src === privateIdentity) continue;
        if (entry.isDirectory()) { await mkdir(dst); await copy(src, dst, depth + 1); }
        else {
          requireValue(entry.isFile(), 'Source links and special files are not supported');
          total += (await stat(src)).size;
          requireValue(total <= MAX_ARCHIVE - MAX_HEADER, 'Source exceeds size limit');
          await copyFile(src, dst);
        }
      }
    }
    await copy(source, stage);
    const manifestFile = join(stage, 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    requireValue(!manifest.name || manifest.name === identity.pluginId, 'Identity belongs to another plugin');
    manifest.name = identity.pluginId;
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    const asarFile = join(temp, 'plugin.asar');
    await createPackage(stage, asarFile);
    const archive = await readBounded(asarFile, MAX_ARCHIVE);
    validateManifest(inspectArchive(archive), identity.pluginId);
    const metadata = { ...identity, key: randomBytes(32).toString('hex'), iv: randomBytes(16).toString('hex'), timestamp: Date.now() };
    metadata.encrypt2 = Buffer.from(crypt(profile.check).encrypt(Buffer.from(metadata.pluginId + metadata.timestamp))).toString('hex');
    const bytes = seal(metadata, gzipSync(archive), profile);
    const verified = open(bytes, profile);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
    return { ...summary(verified), packageSha256: sha256(bytes), output };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function unpack(result, output) {
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  // Reserve the destination so concurrent extraction cannot replace existing files.
  await mkdir(output);
  try {
    for (const [name, file] of result.files) {
      const target = join(output, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    }
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  return { ...summary(result), output };
}
