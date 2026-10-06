import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MoveSounds, hasNewConfirmedMove } from '../src/move-sounds.js';

test('only newly appended moves make live-game sounds, including a mating move and reconnect catch-up',()=>{
  const previous={id:'a',status:'active',moves:['e2e4','d7d5']};
  assert.equal(hasNewConfirmedMove(null,previous),false);
  assert.equal(hasNewConfirmedMove(previous,{...previous,revision:4}),false);
  assert.equal(hasNewConfirmedMove(previous,{...previous,moves:['e2e4']}),false);
  assert.equal(hasNewConfirmedMove(previous,{...previous,id:'b',moves:[...previous.moves,'e4d5']}),false);
  assert.equal(hasNewConfirmedMove(previous,{...previous,moves:['d2d4','d7d5','c2c4']}),false);
  assert.equal(hasNewConfirmedMove(previous,{...previous,status:'finished',moves:[...previous.moves,'e4d5']}),true);
  assert.equal(hasNewConfirmedMove(previous,{...previous,moves:[...previous.moves,'e4d5','d8d5']}),true);
});

function fixture(saved=null){
  let storage=saved,resume;
  const played=[],stopped=[],fetched=[],decoded=[];
  class AudioContext{
    state='running';currentTime=0;sampleRate=44100;destination={};
    resume(){return new Promise(resolve=>{resume=()=>{this.state='running';resolve();};});}
    async decodeAudioData(bytes){
      decoded.push(bytes);
      const wav=Buffer.from(bytes);
      assert.equal(wav.toString('ascii',0,4),'RIFF');
      assert.equal(wav.toString('ascii',8,12),'WAVE');
      assert.equal(wav.readUInt16LE(20),1);
      assert.equal(wav.readUInt16LE(22),1);
      assert.equal(wav.readUInt16LE(34),16);
      const samples=new Float32Array(wav.readUInt32LE(40)/2);
      for(let i=0;i<samples.length;i++)samples[i]=wav.readInt16LE(44+i*2)/32768;
      return {duration:samples.length/wav.readUInt32LE(24),getChannelData:()=>samples};
    }
    createBufferSource(){const source={connect(){},disconnect(){},start(){played.push(source.buffer);},stop(){stopped.push(source);}};return source;}
    createGain(){return {gain:{setValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const host={AudioContext,localStorage:{getItem:()=>storage,setItem:(_,value)=>{storage=value;}},fetch:async url=>{
    fetched.push(url);
    const bytes=await readFile(new URL(url));
    return {ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
  }};
  const sounds=new MoveSounds({host});
  return {sounds,host,played,stopped,fetched,decoded,get storage(){return storage;},resume:()=>resume()};
}

test('normal and capture use separate recorded WAV clips, cached once without overlapping playback',async()=>{
  const f=fixture();
  assert.equal(await f.sounds.play(),true);
  assert.equal(await f.sounds.play({captured:'p',flags:'e'}),true);
  assert.equal(f.played.length,2);
  assert.ok(f.played[0].duration<f.played[1].duration);
  assert.ok(f.played[1].duration<.4);
  assert.notDeepEqual(f.played[0].getChannelData(0),f.played[1].getChannelData(0));
  assert.equal(f.stopped.length,1);
  for(const buffer of f.played){
    const samples=buffer.getChannelData(0);
    assert.ok(samples.some(n=>n!==0));
    assert.ok(samples.every(n=>Number.isFinite(n)&&Math.abs(n)<=1));
  }
  await f.sounds.play();
  assert.equal(f.played[0],f.played[2]);
  assert.equal(f.decoded.length,2);
  assert.deepEqual(f.fetched.map(url=>new URL(url).pathname.split('/').at(-1)).sort(),['chess-capture.wav','chess-move.wav']);
});

test('muting while a recording is decoding cancels the pending sound',async()=>{
  const f=fixture();await f.sounds.prepare();
  let finish,started;
  const decoding=new Promise(resolve=>{started=resolve;});
  f.sounds.context.decodeAudioData=()=>{started();return new Promise(resolve=>{finish=resolve;});};
  const pending=f.sounds.play();await decoding;
  f.sounds.setEnabled(false);finish({duration:.24});
  assert.equal(await pending,false);
  assert.equal(f.played.length,0);
});

test('a failed recording fetch stays silent and can be retried',async()=>{
  const f=fixture(),fetch=f.host.fetch;
  f.host.fetch=async()=>({ok:false});
  assert.equal(await f.sounds.play(),false);
  assert.equal(f.played.length,0);
  f.host.fetch=fetch;
  assert.equal(await f.sounds.play(),true);
});

test('mute stops audio, persists on reload, and cancels a pending browser resume',async()=>{
  const f=fixture();await f.sounds.play();
  f.sounds.context.state='suspended';
  const pending=f.sounds.play({captured:'q'});
  f.sounds.setEnabled(false);f.resume();
  assert.equal(await pending,false);
  assert.equal(f.stopped.length,1);
  assert.equal(f.played.length,1);
  assert.equal(await fixture(f.storage).sounds.play(),false);
  f.sounds.setEnabled(true);
  assert.equal(await f.sounds.play(),true);
});

test('unsupported or blocked audio never prevents moving pieces',async()=>{
  assert.equal(await new MoveSounds({host:{}}).play(),false);
  const f=fixture();await f.sounds.prepare();
  f.sounds.context.state='suspended';f.sounds.context.resume=()=>Promise.reject(new Error('blocked'));
  assert.equal(await f.sounds.play(),false);
});
