import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { engineChunks } from './src/engine-options.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const playSiteUrl = process.env.PLAY_SITE_URL?.trim();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav' };
const files = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'],
  ['/notifications.css', 'notifications.css'], ['/piece-settings.css', 'piece-settings.css'],
  ['/src/move-sounds.js', 'src/move-sounds.js'],
  ['/sounds/chess-move.wav', 'sounds/chess-move.wav'],
  ['/sounds/chess-capture.wav', 'sounds/chess-capture.wav'],
  ...['annotations', 'app', 'bootstrap', 'chess-core', 'completion-alerts', 'engine', 'engine-options', 'insight', 'notification-center', 'opening-book', 'online-nav', 'pieces', 'piece-themes', 'piece-settings', 'sample', 'study'].map(name => [`/src/${name}.js`, `src/${name}.js`]),
  ['/isolation-worker.js', 'isolation-worker.js'],
  ['/node_modules/chess.js/dist/esm/chess.js', 'node_modules/chess.js/dist/esm/chess.js'],
  ['/engine/stockfish-19-lite-single.js', 'node_modules/stockfish/bin/stockfish-19-lite-single.js'],
  ['/engine/stockfish-19-lite-single.wasm', 'node_modules/stockfish/bin/stockfish-19-lite-single.wasm'],
  ...['stockfish-19-single.js', 'stockfish-19.js', 'stockfish-19-lite.js', 'stockfish-19-lite.wasm'].map(name => [`/engine/${name}`, `node_modules/stockfish/bin/${name}`]),
  ['/licenses/stockfish.txt', 'node_modules/stockfish/Copying.txt'],
  ['/licenses/chess-js.txt', 'node_modules/chess.js/LICENSE'],
]);
const chunks = new Map([false,true].flatMap(parallel => engineChunks(parallel).map(chunk => [chunk.url, { ...chunk, file:`node_modules/stockfish/bin/stockfish-19${parallel ? '' : '-single'}.wasm` }])));

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname; }
  catch { res.writeHead(400).end(); return; }
  if(pathname==='/play'||pathname.startsWith('/api/play/')||pathname.startsWith('/online/')||pathname==='/signin-with-chatgpt'||pathname==='/signout-with-chatgpt'){
    try{
      const upstream=http.request({hostname:'127.0.0.1',port:5173,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent){if(pathname==='/play'&&playSiteUrl){res.writeHead(302,{Location:playSiteUrl}).end();}else if(pathname==='/api/play/me'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"signedIn":false}');}else res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'}).end('{"error":"온라인 대국 서버를 실행해 주세요."}');}else res.destroy();});req.pipe(upstream);return;
    }catch{res.writeHead(503).end();return;}
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if (pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"chess-review-studio"}'); return; }
  const chunk = chunks.get(pathname);
  const relative = files.get(pathname) || chunk?.file;
  if (!relative) { res.writeHead(404).end('Not found'); return; }
  const filename = path.join(root, relative);
  try {
    const info = await stat(filename);
    res.writeHead(200, {
      'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      'Content-Length': chunk?.size || info.size,
      'Cache-Control': pathname.startsWith('/engine/') ? 'public, max-age=86400' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; connect-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(filename, chunk ? { start:chunk.start, end:chunk.start+chunk.size-1 } : undefined).on('error', () => res.destroy()).pipe(res);
  } catch { res.writeHead(404).end('File missing. Install dependencies first: npm install --ignore-scripts'); }
});

server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if ((await response.json()).app === 'chess-review-studio') {
        console.log(`Already running: http://127.0.0.1:${port}`);
        if (process.argv.includes('--open')) openBrowser();
        return;
      }
    } catch { /* Another service occupies this port. */ }
  }
  console.error(error.message);
  process.exitCode = 1;
});

function openBrowser() {
  const url = `http://127.0.0.1:${port}`;
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Chess Review Studio: http://127.0.0.1:${port}`);
  console.log('Keep this process running. Press Ctrl+C to stop.');
  if (process.argv.includes('--open')) openBrowser();
});
