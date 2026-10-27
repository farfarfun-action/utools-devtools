#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { loadProfile, prepareRuntime } from './runtime.mjs';
import { readBounded, identityFrom, open, pack, unpack, summary } from './package.mjs';

const usage = `utools-devtools (Node.js 22.12+)
  prepare-runtime --out <linux-x64.node>
  inspect <plugin.upxs> --runtime <linux-x64.node>
  verify <plugin.upxs> --runtime <linux-x64.node>
  unpack <plugin.upxs> --out <new-directory> --runtime <linux-x64.node>
  identity <your-plugin.upxs> [--out <identity.json>] --runtime <linux-x64.node>
  pack <built-plugin-directory> [--identity <identity.json>] --out <plugin.upxs> --runtime <linux-x64.node>

Identity defaults to identity.json in the current project directory.
Set UTOOLS_MID, UTOOLS_UID and UTOOLS_CELLPHONE to inject private account fields.
The identity export contains private data; remove these fields before committing it.
Only export identity from your own official package; set the target project's pluginId before packing.
Verification checks the file format; it does not assert client installation.`;

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    runtime: { type: 'string' }, out: { type: 'string' }, identity: { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, input] = positionals;
  if (values.help || !command) console.log(usage);
  else {
    if (!['prepare-runtime', 'inspect', 'verify', 'unpack', 'identity', 'pack'].includes(command)) throw new Error('Unknown command; use --help');
    if (positionals.length !== (command === 'prepare-runtime' ? 1 : 2)) throw new Error('Invalid arguments; use --help');
    if (command === 'identity') values.out ??= 'identity.json';
    if (['prepare-runtime', 'unpack', 'pack'].includes(command) && !values.out) throw new Error('--out is required');
    let result;
    if (command === 'prepare-runtime') result = await prepareRuntime(values.out);
    else {
      const profile = await loadProfile(values.runtime);
      if (command === 'pack') {
        if (!values.out.endsWith('.upxs')) throw new Error('Output filename must end in .upxs');
        const identityFile = values.identity ?? 'identity.json';
        const identity = JSON.parse((await readBounded(identityFile, 64 * 1024)).toString('utf8'));
        if (process.env.UTOOLS_MID) identity.os = { ...identity.os, mid: process.env.UTOOLS_MID };
        if (process.env.UTOOLS_UID) identity.developer = { ...identity.developer, uid: process.env.UTOOLS_UID };
        if (process.env.UTOOLS_CELLPHONE) identity.developer = { ...identity.developer, cellphone: process.env.UTOOLS_CELLPHONE };
        result = await pack(input, values.out, identity, profile, identityFile);
      } else {
        const decoded = open(await readBounded(input), profile);
        if (command === 'identity') {
          await writeFile(values.out, JSON.stringify(identityFrom(decoded.metadata), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          result = { output: values.out, private: true, message: 'Store this identity in a secret, never in source control' };
        } else if (command === 'unpack') result = await unpack(decoded, values.out);
        else {
          result = summary(decoded);
          if (command === 'verify' && !result.integrityVerified) process.exitCode = 1;
        }
      }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  // Do not echo arbitrary parsing errors: an identity file can contain phone numbers.
  console.error(error instanceof SyntaxError ? 'Invalid JSON input' : error.message);
  process.exitCode = 1;
}
