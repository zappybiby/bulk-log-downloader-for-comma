import {mkdir, copyFile, readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(process.argv[2] || `${root}/.android-selftest`);
await mkdir(out, {recursive:true});
for (const name of await readdir(`${root}/tests/selftest`)) {
  await copyFile(`${root}/tests/selftest/${name}`, `${out}/${name}`);
}
for (const name of ['archive.js', 'parser.js', 'scanner.js', 'downloads.css']) {
  await copyFile(`${root}/firefox/${name}`, `${out}/${name}`);
}
// Use production HTML/CSS/handlers with a synthetic adapter only at the API boundary.
const html = (await readFile(`${root}/firefox/downloads.html`, 'utf8'))
  .replace('<script src="downloads.js" defer></script>', '<script src="ui-adapter.js" defer></script>\n    <script src="downloads.js" defer></script>');
await writeFile(`${out}/downloads.html`, html);
const script = await readFile(`${root}/firefox/downloads.js`, 'utf8');
await writeFile(`${out}/downloads.js`, script.replace(/\bbrowser\./g, 'SyntheticBrowser.'));
console.log(`Staged only public source and synthetic fixtures at ${out}`);
