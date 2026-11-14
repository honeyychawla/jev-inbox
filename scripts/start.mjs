import {spawn} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13)||(major===23&&minor<4)){
  console.error(`Jev Inbox needs Node.js 22.13 or newer. You have ${process.versions.node}.\nInstall the LTS version from https://nodejs.org/en/download, then reopen this launcher.`);
  process.exit(1);
}
const port=Number(process.env.PORT||5184);
if(!Number.isInteger(port)||port<1||port>65535){console.error('PORT must be a number between 1 and 65535. The default is 5184.');process.exit(1);}
const {createApp}=await import('../server/index.mjs');
const app=createApp({dataDir:process.env.JEV_DATA_DIR||join(root,'data')});
const url=`http://localhost:${port}`;
function openBrowser(){
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'cmd':'xdg-open';
  const args=process.platform==='win32'?['/c','start','',url]:[url];
  const child=spawn(command,args,{stdio:'ignore',windowsHide:true});
  child.on('error',()=>console.log(`Open this address in your browser: ${url}`));
  child.unref();
}
app.server.once('listening',()=>{
  console.log(`\nJev Inbox is ready: ${url}\nKeep this terminal open while using the dashboard. Press Ctrl+C to stop.\n\nFirst time? The dashboard guides you through your own Google setup, Gmail sign-in, and OpenRouter key.\n`);
  if(process.argv.includes('--open'))openBrowser();
});
app.server.once('error',error=>{
  console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Jev Inbox may already be running at ${url}. Close the other app or choose a different PORT. If you change the port, update the Google redirect URI too.`:error.message);
  app.store.close();process.exit(1);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close(()=>process.exit(0)));
app.server.listen(port,'127.0.0.1');

