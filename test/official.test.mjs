import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extractFile } from '@electron/asar';
import { open, seal, summary } from '../src/package.mjs';
import { loadProfile, sha256 } from '../src/runtime.mjs';

test('official developer 2.7.0 sample: authenticated decode, every ASAR entry, byte-exact reseal', async (t) => {
  const url = 'https://res.u-tools.cn/plugins/9t97fzw4ihpnvmhmnhonuev3hpxoqji4.upxs';
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.ok, true);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), '04cde14fb4b1b0fe40f4067d52b47b61906394e612fe5d1b23924a400a651a17');
  const profile = await loadProfile(process.env.UTOOLS_RUNTIME);
  const decoded = open(bytes, profile);
  assert.equal(decoded.manifest.name, 'developer');
  assert.equal(decoded.manifest.version, '2.7.0');
  assert.equal(decoded.archive.length, 1399813);
  assert.equal(decoded.files.size, 44);
  assert.equal(decoded.warnings.length, 1);
  assert.equal(summary(decoded).integrityVerified, false);
  assert.match(decoded.warnings[0], /plugin.json/);
  assert.deepEqual(seal(decoded.metadata, decoded.compressed, profile), bytes);
  const dir = await mkdtemp(join(tmpdir(), 'utools-official-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'official.asar');
  await writeFile(file, decoded.archive);
  for (const [name, entry] of decoded.files) assert.deepEqual(extractFile(file, join(...name.split('/'))), entry.bytes);
  const safe = JSON.stringify(summary(decoded));
  for (const value of [decoded.metadata.os.mid, decoded.metadata.developer.cellphone, decoded.metadata.developer.uid, decoded.metadata.key]) assert.equal(safe.includes(value), false);
  const packageFile = join(dir, 'official.upxs');
  await writeFile(packageFile, bytes);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  function run(command, args = []) {
    return spawnSync(process.execPath, [cli, command, packageFile, '--runtime', resolve(process.env.UTOOLS_RUNTIME), ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  }
  assert.equal(run('inspect').status, 0);
  const verified = run('verify');
  assert.equal(verified.status, 1);
  assert.equal(JSON.parse(verified.stdout).integrityVerified, false);
  const destination = join(dir, 'unpacked');
  assert.equal(run('unpack', ['--out', destination]).status, 0);
  assert.equal((await readFile(join(destination, 'plugin.json'))).equals(decoded.files.get('plugin.json').bytes), true);
  const identityFile = join(dir, 'identity.json');
  assert.equal(run('identity').status, 0);
  const identity = JSON.parse(await readFile(identityFile, 'utf8'));
  assert.equal(identity.developer.uid === decoded.metadata.developer.uid, true);
  assert.equal(Object.hasOwn(identity, 'key'), false);
  assert.equal(run('identity', ['--out', identityFile]).status, 1);
  console.log('Official sample passed; no identity or vendor code is included in artifacts.');
});

test('CLI packs from project identity.json, supports explicit paths and rejects pending plugin IDs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'utools-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'utools'); await mkdir(source);
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ pluginName: 'CLI fixture', version: '1.0.0', main: 'index.html', features: [{ code: 'ci', cmds: ['fixture'] }] }));
  await writeFile(join(source, 'index.html'), '<h1>Fixture</h1>');
  const identity = { os: { mid: 'test-machine' }, app: { name: 'uTools', version: '8.0.2' }, developer: { uid: 'test-only' }, pluginId: 'clifixture' };
  const identityFile = join(dir, 'identity.json');
  await writeFile(identityFile, JSON.stringify(identity));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  function run(output, args = [], account = {}) {
    return spawnSync(process.execPath, [cli, 'pack', 'utools', '--out', output, '--runtime', resolve(process.env.UTOOLS_RUNTIME), ...args], { cwd: dir, env: { ...process.env, UTOOLS_MID: '', UTOOLS_UID: '', UTOOLS_CELLPHONE: '', ...account }, encoding: 'utf8', timeout: 30_000 });
  }
  assert.equal(run('default.upxs').status, 0);
  const profile = await loadProfile(process.env.UTOOLS_RUNTIME);
  assert.equal(open(await readFile(join(dir, 'default.upxs')), profile).metadata.pluginId, identity.pluginId);
  await rename(identityFile, join(dir, 'custom-identity.json'));
  assert.equal(run('missing.upxs').status, 1);
  assert.equal(run('explicit.upxs', ['--identity', 'custom-identity.json']).status, 0);
  await writeFile(identityFile, JSON.stringify({ ...identity, pluginId: '' }));
  assert.equal(run('pending.upxs').status, 1);
  await assert.rejects(readFile(join(dir, 'pending.upxs')), /ENOENT/);
  const publicIdentity = { ...identity, os: {}, developer: {} };
  await writeFile(identityFile, JSON.stringify(publicIdentity));
  assert.equal(run('no-secrets.upxs').status, 1);
  const secretRun = run('secrets.upxs', [], { UTOOLS_MID: 'ci-private-mid', UTOOLS_UID: 'ci-private-uid', UTOOLS_CELLPHONE: 'ci-private-phone' });
  assert.equal(secretRun.status, 0);
  for (const privateValue of ['ci-private-mid', 'ci-private-uid', 'ci-private-phone']) assert.equal((secretRun.stdout + secretRun.stderr).includes(privateValue), false);
  const { metadata } = open(await readFile(join(dir, 'secrets.upxs')), profile);
  assert.equal(metadata.os.mid === 'ci-private-mid' && metadata.developer.uid === 'ci-private-uid' && metadata.developer.cellphone === 'ci-private-phone', true);
  assert.deepEqual(JSON.parse(await readFile(identityFile, 'utf8')), publicIdentity);
});
