import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';

test('the portable launcher starts a clean local workspace with no connected accounts or keys',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-first-run-'));
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env,PORT:String(port),JEV_DATA_DIR:dir};delete env.OPENROUTER_API_KEY;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/start.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}await rm(dir,{recursive:true,force:true});});
  let landing;
  for(let attempt=0;attempt<100;attempt++){
    try{landing=await fetch(`http://localhost:${port}`);break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}
  }
  assert.ok(landing,output);assert.equal(landing.status,200);assert.match(await landing.text(),/First-run setup/);
  const cookie=landing.headers.get('set-cookie').split(';')[0];
  const response=await fetch(`http://localhost:${port}/api/state`,{headers:{Cookie:cookie}});const state=await response.json();
  assert.equal(state.settings.gmail.connected,false);assert.equal(state.settings.youtube.connected,false);assert.equal(state.settings.google.configured,false);assert.equal(state.settings.openrouter.configured,false);
  assert.equal(state.messages.filter(m=>m.workspace==='live').length,0);assert.ok(state.messages.every(m=>m.workspace==='sample'));assert.equal(state.settings.batchSize,50);assert.equal(state.settings.autoSync,false);
  assert.match(output,/Keep this terminal open/);
});

