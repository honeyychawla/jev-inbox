import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { DEFAULT_SETTINGS, sampleMessages } from './domain.mjs';

export function createStore(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  chmodSync(dir,0o700);
  const keyPath=join(dir,'.encryption-key');
  if(!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
  const key=readFileSync(keyPath);
  const dbPath=join(dir,'inbox.sqlite');
  const db=new DatabaseSync(dbPath); chmodSync(dbPath,0o600);
  db.exec(`PRAGMA journal_mode=DELETE;
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, data TEXT NOT NULL);`);
  const encrypt=value=>{const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64');};
  const decrypt=value=>{const b=Buffer.from(value,'base64');const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString());};
  const store={
    db,
    all:()=>db.prepare('SELECT data FROM messages').all().map(x=>JSON.parse(x.data)),
    get:id=>{const r=db.prepare('SELECT data FROM messages WHERE id=?').get(id);return r?JSON.parse(r.data):null;},
    put:m=>db.prepare('INSERT INTO messages VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(m.id,JSON.stringify(m)),
    settings:()=>({...structuredClone(DEFAULT_SETTINGS),...JSON.parse(db.prepare("SELECT value FROM settings WHERE key='preferences'").get()?.value||'{}')}),
    saveSettings:s=>db.prepare("INSERT INTO settings VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(s)),
    secret:name=>{const r=db.prepare('SELECT value FROM secrets WHERE key=?').get(name);return r?decrypt(r.value):null;},
    setSecret:(name,value)=>db.prepare('INSERT INTO secrets VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name,encrypt(value)),
    deleteSecret:name=>db.prepare('DELETE FROM secrets WHERE key=?').run(name),
    log:(action,detail,workspace='live')=>{db.prepare('INSERT INTO activity(data) VALUES(?)').run(JSON.stringify({action,detail,workspace,date:new Date().toISOString()}));db.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 200)');},
    activity:()=>db.prepare('SELECT data FROM activity ORDER BY id DESC LIMIT 100').all().map(r=>JSON.parse(r.data)),
    saveRun:run=>{db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.startedAt,JSON.stringify(run));db.exec('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT 100)');},
    runs:()=>db.prepare('SELECT data FROM runs ORDER BY started_at DESC LIMIT 100').all().map(r=>JSON.parse(r.data)),
    startOperation:(id,data)=>{try{db.prepare('INSERT INTO operations VALUES(?,?,?)').run(id,'pending',JSON.stringify(data));return true;}catch{return false;}},
    endOperation:(id,status,data)=>db.prepare('UPDATE operations SET status=?,data=? WHERE id=?').run(status,JSON.stringify(data),id),
    operation:id=>db.prepare('SELECT status,data FROM operations WHERE id=?').get(id),
    resetSamples:()=>{db.prepare("DELETE FROM messages WHERE id LIKE 'sample-%'").run();for(const m of sampleMessages()) store.put(m);},
    close:()=>db.close()
  };
  if(!db.prepare("SELECT value FROM settings WHERE key='initialized'").get()) {
    store.resetSamples(); db.prepare("INSERT INTO settings VALUES('initialized','true')").run();
    store.log('Workspace ready','Example messages are separate from your connected inbox.','sample');
  }
  if(!db.prepare("SELECT value FROM settings WHERE key='sample-taxonomy-v2'").get()) {
    for(const sample of sampleMessages()){const old=store.get(sample.id);if(!old||old.revision===1)store.put({...sample,...(old?{date:old.date}:{})});}
    db.prepare("INSERT INTO settings VALUES('sample-taxonomy-v2','true')").run();
  }
  return store;
}
