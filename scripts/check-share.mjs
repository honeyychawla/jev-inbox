import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),failures=[];
const patterns=[/sk-or-v1-[A-Za-z0-9_-]{32,}/,/GOCSPX-[A-Za-z0-9_-]{16,}/,/ya29\.[A-Za-z0-9_-]{20,}/,/1\/\/[A-Za-z0-9_-]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b\d{6,}-[a-z0-9]{15,}\.apps\.googleusercontent\.com/];
let count=0;
function walk(dir){
  for(const name of readdirSync(dir)){
    if(['.git','node_modules'].includes(name))continue;
    const path=join(dir,name),rel=relative(root,path),stat=lstatSync(path);
    if(stat.isSymbolicLink()){failures.push(`${rel}: symbolic link`);continue;}
    if(name==='data'||name==='.encryption-key'||/^\.env(?:\.|$)/.test(name)||/\.(sqlite(?:-.*)?|db|pem|key|log)$/i.test(name)||/(?:client_secret|credentials|tokens).*\.json$/i.test(name)){failures.push(`${rel}: private runtime file`);continue;}
    if(stat.isDirectory()){walk(path);continue;}
    count++;const bytes=readFileSync(path);
    if(bytes.subarray(0,16).toString().startsWith('SQLite format'))failures.push(`${rel}: database content`);
    if(!/\.(png|jpg|woff2)$/i.test(name)&&patterns.some(p=>p.test(bytes.toString('utf8'))))failures.push(`${rel}: possible credential`);
  }
}
walk(root);
if(failures.length){console.error('Share check failed:\n'+failures.join('\n'));process.exit(1);}
console.log(`Share check passed: ${count} files; no runtime data or recognized credentials found.`);

