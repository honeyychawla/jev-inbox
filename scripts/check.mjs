import {readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const folder of ['server','scripts','public','tests']){
  for(const entry of readdirSync(join(root,folder))){
    if(!/\.(mjs|js)$/.test(entry))continue;
    const result=spawnSync(process.execPath,['--check',resolve(root,folder,entry)],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);
  }
}
console.log('JavaScript syntax checks passed.');

