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
  identity <your-plugin.upxs> --out <identity.json> --runtime <linux-x64.node>
  pack <built-plugin-directory> --identity <identity.json> --out <plugin.upxs> --runtime <linux-x64.node>

Only export identity from your own official package. Keep it in an Actions secret.
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
    if (['prepare-runtime', 'unpack', 'identity', 'pack'].includes(command) && !values.out) throw new Error('--out is required');
    let result;
    if (command === 'prepare-runtime') result = await prepareRuntime(values.out);
    else {
      const profile = await loadProfile(values.runtime);
      if (command === 'pack') {
        if (!values.out.endsWith('.upxs')) throw new Error('Output filename must end in .upxs');
        if (!values.identity) throw new Error('--identity is required; export it from your own official package');
        const identity = JSON.parse((await readBounded(values.identity, 64 * 1024)).toString('utf8'));
        result = await pack(input, values.out, identity, profile);
      } else {
        const decoded = open(await readBounded(input), profile);
        if (command === 'identity') {
          await writeFile(values.out, JSON.stringify(identityFrom(decoded.metadata), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          result = { output: values.out, private: true, message: 'Store this identity in a secret, never in source control' };
        } else if (command === 'unpack') result = await unpack(decoded, values.out);
        else result = summary(decoded);
      }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  // Do not echo arbitrary parsing errors: an identity file can contain phone numbers.
  console.error(error instanceof SyntaxError ? 'Invalid JSON input' : error.message);
  process.exitCode = 1;
}
