import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineChunks } from '../src/engine-options.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'sites', 'chess-analysis');
const dist = path.join(site, 'public');
const modules = ['annotations', 'app', 'bootstrap', 'chess-core', 'completion-alerts', 'engine', 'engine-options', 'insight', 'move-sounds', 'notification-center', 'opening-book', 'online-nav', 'pieces', 'piece-themes', 'piece-settings', 'sample', 'study', 'theme'];
const files = [
  ['index.html', 'index.html'],
  ['styles.css', 'styles.css'],
  ['notifications.css', 'notifications.css'],
  ['theme.css', 'theme.css'],
  ['online/play.js', 'online/play.js'],
  ['online/play.css', 'online/play.css'],
  ['online/account.js', 'online/account.js'],
  ['piece-settings.css', 'piece-settings.css'],
  ['sounds/chess-move.wav', 'sounds/chess-move.wav'],
  ['sounds/chess-capture.wav', 'sounds/chess-capture.wav'],
  ['sounds/SOURCES.json', 'licenses/move-sounds.json'],
  ['LICENSE', 'licenses/app.txt'],
  ['data/openings/COPYING.txt', 'licenses/openings.txt'],
  ['data/openings/SOURCES.json', 'licenses/openings-sources.json'],
  ['hosting-headers.txt', '_headers'],
  ['isolation-worker.js', 'isolation-worker.js'],
  ...modules.map(name => [`src/${name}.js`, `src/${name}.js`]),
  ['node_modules/chess.js/dist/esm/chess.js', 'vendor/chess.js'],
  ['node_modules/chess.js/LICENSE', 'licenses/chess-js.txt'],
  ['node_modules/stockfish/Copying.txt', 'licenses/stockfish.txt'],
  ...['js', 'wasm'].map(ext => [
    `node_modules/stockfish/bin/stockfish-19-lite-single.${ext}`,
    `engine/stockfish-19-lite-single.${ext}`,
  ]),
  ...['stockfish-19-single.js', 'stockfish-19.js', 'stockfish-19-lite.js', 'stockfish-19-lite.wasm'].map(name => [`node_modules/stockfish/bin/${name}`, `engine/${name}`]),
];

// Publish only application assets; saved games, logs and screenshots stay local.
for (const [source, target] of files) {
  const destination = path.join(dist, target);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, source), destination);
}
const corePath = path.join(dist, 'src/chess-core.js');
const core = await readFile(corePath, 'utf8');
const dependency = '../node_modules/chess.js/dist/esm/chess.js';
if (!core.includes(dependency)) throw new Error('Update the static chess.js import mapping.');
await writeFile(corePath, core.replace(dependency, '../vendor/chess.js'));
for (const parallel of [false,true]) {
  const data = await readFile(path.join(root, `node_modules/stockfish/bin/stockfish-19${parallel ? '' : '-single'}.wasm`));
  const chunks = engineChunks(parallel);
  if (data.length !== chunks.reduce((n,chunk) => n+chunk.size,0)) throw new Error('Update the full engine chunk mapping for this version.');
  for (const chunk of chunks) await writeFile(path.join(dist, chunk.url), data.subarray(chunk.start, chunk.start+chunk.size));
}

await writeFile(path.join(dist, 'licenses/README.txt'), [
  'Chess Review Studio: GPL-3.0-or-later. Application JavaScript is served unminified in /src/.',
  'Stockfish.js 19.0.0: GPLv3. Unmodified single-thread and multi-thread Lite/full engines. Full WASM files are split for delivery and reassembled without alteration.',
  'Corresponding engine source and build instructions: https://github.com/nmrugg/stockfish.js/tree/v19.0.0',
  'chess.js 1.4.0: BSD-2-Clause. https://github.com/jhlywa/chess.js/tree/v1.4.0',
  'Move and capture sounds: excerpts of chess pieces.wav by simone_ds, CC0 1.0. Source and edits: /licenses/move-sounds.json',
  '',
].join('\n'));

// Verify every shipped module import resolves within the public directory.
for (const module of modules) {
  const filename = path.join(dist, 'src', `${module}.js`);
  const source = await readFile(filename, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) throw new Error(`Unmapped module import: ${match[1]}`);
    const target = path.resolve(path.dirname(filename), match[1]);
    if (!target.startsWith(dist + path.sep)) throw new Error('Module import escapes the static directory.');
    await stat(target);
  }
}
const wasm = await readFile(path.join(dist, 'engine/stockfish-19-lite-single.wasm'));
if (!wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error('Invalid Stockfish WASM asset.');
console.log(`Static assets verified: ${dist}`);
await copyFile(path.join(root,'index.html'),path.join(site,'analysis.html'));
await copyFile(path.join(root,'play.html'),path.join(site,'play.html'));
await mkdir(path.join(site,'online'),{recursive:true});
await mkdir(path.join(site,'vendor'),{recursive:true});
await writeFile(path.join(site,'online/game-service.mjs'),(await readFile(path.join(root,'online/game-service.mjs'),'utf8')).replace('../node_modules/chess.js/dist/esm/chess.js','../vendor/chess.js'));
await copyFile(path.join(root,'online/auth-service.mjs'),path.join(site,'online/auth-service.mjs'));
await copyFile(path.join(root,'node_modules/chess.js/dist/esm/chess.js'),path.join(site,'vendor/chess.js'));
