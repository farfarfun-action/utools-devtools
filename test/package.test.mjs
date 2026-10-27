import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { pack, open, seal, unpack, summary, inspectArchive, identityFrom } from '../src/package.mjs';
import { profileFromRuntime } from '../src/runtime.mjs';

// Synthetic keys and identity; never use a real developer account in fixtures.
const profile = { header: { key: Buffer.alloc(32, 1), nonce: Buffer.alloc(24, 2) }, check: { key: Buffer.alloc(32, 3), nonce: Buffer.alloc(24, 4) } };
const identity = { os: { mid: 'test-machine' }, app: { name: 'uTools', version: '8.0.2' }, developer: { uid: 'test-only', cellphone: 'PRIVATE_FIXTURE' }, pluginId: 'testplugin' };
const manifest = { pluginName: '测试插件', version: '1.0.0', main: 'index.html', preload: 'preload.js', logo: 'logo.svg', features: [{ code: 'test', cmds: ['test'] }] };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'utools-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'); await mkdir(source);
  for (const [name, content] of Object.entries({ 'plugin.json': JSON.stringify(manifest), 'index.html': '<h1>测试</h1>', 'preload.js': 'globalThis.fixture = true', 'logo.svg': '<svg/>', 'empty.txt': '' })) await writeFile(join(source, name), content);
  await mkdir(join(source, 'assets'));
  await writeFile(join(source, 'assets', '矩阵.txt'), '矩阵');
  const output = join(dir, 'test.upxs');
  return { dir, source, output };
}
function asar(header, body = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const size = 8 + Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(8 + size);
  bytes.writeUInt32LE(4); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(size - 4, 8); bytes.writeUInt32LE(json.length, 12);
  json.copy(bytes, 16);
  return Buffer.concat([bytes, body]);
}

test('pack/unpack preserves files, injects plugin ID only in staging, and redacts identity', async (t) => {
  const { dir, source, output } = await fixture(t);
  const result = await pack(source, output, identity, profile);
  assert.equal(result.formatVerified, true);
  const decoded = open(await readFile(output), profile);
  assert.equal(decoded.manifest.name, identity.pluginId);
  assert.equal(JSON.parse(await readFile(join(source, 'plugin.json'))).name, undefined);
  assert.equal(decoded.files.get('assets/矩阵.txt').bytes.toString(), '矩阵');
  assert.equal(JSON.stringify(summary(decoded)).includes('PRIVATE_FIXTURE'), false);
  assert.deepEqual(identityFrom(decoded.metadata), identity);
  assert.equal(summary(decoded).clientInstallVerified, false);
  const target = join(dir, 'extracted');
  await unpack(decoded, target);
  for (const [name, file] of decoded.files) assert.deepEqual(await readFile(join(target, name)), file.bytes);
  await assert.rejects(unpack(decoded, target), /EEXIST/);
  await assert.rejects(pack(source, output, identity, profile), /EEXIST/);
  const second = join(dir, 'second.upxs');
  await pack(source, second, identity, profile);
  assert.notDeepEqual(await readFile(output), await readFile(second));
});

test('reject tampered metadata, binding, body and truncation', async (t) => {
  const { source, output } = await fixture(t);
  await pack(source, output, identity, profile);
  const bytes = await readFile(output);
  const decoded = open(bytes, profile);
  for (const offset of [5, 4 + bytes.readUInt32LE(0) + 8, bytes.length - 1]) {
    const corrupted = Buffer.from(bytes); corrupted[offset] ^= 1;
    assert.throws(() => open(corrupted, profile));
  }
  for (const length of [0, 3, 20, bytes.length - 1]) assert.throws(() => open(bytes.subarray(0, length), profile));
  const mismatch = { ...decoded.metadata, timestamp: decoded.metadata.timestamp + 1 };
  assert.throws(() => open(seal(mismatch, decoded.compressed, profile), profile), /binding mismatch/);
  mismatch.encrypt2 = '00'.repeat(32);
  assert.throws(() => open(seal(mismatch, decoded.compressed, profile), profile), /binding authentication/);
  const malformed = Buffer.from(bytes); malformed.writeUInt32LE(0xffffffff);
  assert.throws(() => open(malformed, profile), /metadata length/);
  assert.deepEqual(seal(decoded.metadata, decoded.compressed, profile), bytes);
});

test('reject unsafe source, missing assets, mismatched identity and nested output', async (t) => {
  const { dir, source, output } = await fixture(t);
  await assert.rejects(pack(source, join(source, 'out.upxs'), identity, profile), /outside source/);
  await assert.rejects(pack(source, output, { ...identity, developer: {} }, profile), /own official package/);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, name: 'another' }));
  await assert.rejects(pack(source, output, identity, profile), /another plugin/);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, main: '../escape' }));
  await assert.rejects(pack(source, output, identity, profile), /Unsafe archive path/);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, main: 'missing.html' }));
  await assert.rejects(pack(source, output, identity, profile), /Missing main asset/);
  await writeFile(join(source, 'plugin.json'), JSON.stringify(manifest));
  await symlink(dir, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pack(source, output, identity, profile), /links/);
});

test('reject traversal, links, external files, Windows paths, duplicate names and invalid bounds', () => {
  const file = { offset: '0', size: 1 };
  for (const name of ['..', '/absolute', 'a/b', 'a\\b', 'C:escape', 'CON', 'a.', 'a ', 'x\0y']) {
    assert.throws(() => inspectArchive(asar({ files: { [name]: file } }, Buffer.from('x'))), /Unsafe archive path/);
  }
  for (const entry of [{ link: 'elsewhere' }, { unpacked: true, ...file }, { offset: '-1', size: 1 }, { offset: '0', size: 10 }, { offset: '0', size: -1 }]) {
    assert.throws(() => inspectArchive(asar({ files: { x: entry } }, Buffer.from('x'))));
  }
  assert.throws(() => inspectArchive(asar({ files: { A: file, a: file } }, Buffer.from('x'))), /Duplicate/);
  assert.throws(() => inspectArchive(asar({ files: { x: file, y: file } }, Buffer.from('x'))), /Overlapping/);
  assert.throws(() => inspectArchive(asar({ files: {} }, Buffer.from('trailing'))), /trailing/);
  assert.throws(() => profileFromRuntime(Buffer.from('not the official addon')), /Unsupported runtime/);
});

test('payload must contain manifest matching authenticated plugin ID', async (t) => {
  const { source, output } = await fixture(t);
  await pack(source, output, identity, profile);
  const { metadata } = open(await readFile(output), profile);
  assert.throws(() => open(seal(metadata, gzipSync(asar({ files: {} })), profile), profile), /Missing plugin.json/);
  const other = { ...metadata, pluginId: 'another' };
  other.encrypt2 = Buffer.from(xchacha20poly1305(profile.check.key, profile.check.nonce).encrypt(Buffer.from(other.pluginId + other.timestamp))).toString('hex');
  const { compressed } = open(await readFile(output), profile);
  assert.throws(() => open(seal(other, compressed, profile), profile), /must match/);
});

test('ASAR integrity detects changed bytes', async (t) => {
  const { source, output } = await fixture(t);
  await pack(source, output, identity, profile);
  const { archive } = open(await readFile(output), profile);
  const modified = Buffer.from(archive); modified[modified.length - 1] ^= 1;
  assert.throws(() => inspectArchive(modified), /integrity/);
});
