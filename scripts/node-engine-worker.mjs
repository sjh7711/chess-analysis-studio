import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A CLI adapter for exercising the same bundled WASM build outside browser UI tests.
export class NodeEngineWorker {
  constructor(url) {
    const filename=url.split('/').at(-1).split(/[?#]/)[0];
    this.child=spawn(process.execPath,[fileURLToPath(new URL(`../node_modules/stockfish/bin/${filename}`,import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let buffer='';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let end;
      while((end=buffer.indexOf('\n'))>=0){const data=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);this.onmessage?.({data});}
    });
    this.child.stderr.on('data',chunk=>process.stderr.write(chunk));
    this.child.on('error',error=>this.onerror?.(error));
  }
  postMessage(command){this.child.stdin.write(command+'\n');}
  terminate(){this.child.kill();}
}
