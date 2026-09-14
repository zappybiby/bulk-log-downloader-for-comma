import {mkdir, copyFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const out = resolve(root, '.android-selftest/discovery');
await mkdir(out, {recursive: true});
for (const name of await readdir(import.meta.dirname)) {
  if (!name.endsWith('.mjs')) await copyFile(resolve(import.meta.dirname, name), resolve(out, name));
}
await copyFile(resolve(root, 'firefox/parser.js'), resolve(out, 'parser.js'));
console.log('Staged isolated synthetic discovery benchmark. No captures included.');
