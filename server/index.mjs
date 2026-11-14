import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createStore } from './store.mjs';
import { applyDecision, needsClassification, hasManualCategory, CATEGORIES, CATEGORY_LABELS, CLASSIFICATION_VERSION, JEV_CONCURRENCY, TEMPLATES, BATCH_SIZES } from './domain.mjs';
import { askJev, authorizationUrl, exchangeCode, googleIdentity, syncGmail, syncYoutube, sendReply, revokeConnection, ProviderError } from './providers.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export function createApp({dataDir=join(ROOT,'data'),request=fetch,gmailReadIntervalMs=700}={}) {
  const store=createStore(dataDir),sessions=new Map(),pendingOAuth=new Map();
  for(const run of store.runs().filter(r=>r.busy))store.saveRun({...run,busy:false,status:'interrupted',phase:'Interrupted by a server restart',endedAt:new Date().toISOString()});
  let job=store.runs()[0]||{busy:false,phase:'idle',completed:0,total:0,errors:[],startedAt:null};
  let runStarted=0,lastCheckpoint=0;
  const jobView=()=>({...job,...(job.busy?{durationMs:Math.max(0,performance.now()-runStarted)}:{})});
  const checkpoint=(force=false)=>{if(force||performance.now()-lastCheckpoint>=250){store.saveRun(jobView());lastCheckpoint=performance.now();}};
  let origin='';
  const syncState={gmail:null,youtube:null};
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const fail=(message,status=400)=>{throw new ProviderError(message,status);};
  const connection=provider=>{const t=store.secret(provider);return {connected:!!t,account:t?.account||null,lastSync:store.settings()[provider+'LastSync']||null,...(syncState[provider]||{})};};
  const settingsView=()=>{const s=store.settings(),key=store.secret('openrouter')||process.env.OPENROUTER_API_KEY,google=store.secret('google');return {...s,jevConcurrency:JEV_CONCURRENCY,openrouter:{configured:!!key,keyHint:key?'•••• '+key.slice(-4):'',testedAt:s.openrouterTestedAt||null},google:{configured:!!(google?.clientId&&google?.clientSecret),clientId:google?.clientId||'',hasSecret:!!google?.clientSecret,redirectUri:origin+'/auth/google/callback'},gmail:connection('gmail'),youtube:connection('youtube')};};
  async function body(req) {let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>100000)fail('Request is too large.',413);}try{return JSON.parse(text||'{}');}catch{fail('Invalid JSON.');}}
  const bump=(m,patch)=>{const n={...m,...patch,revision:m.revision+1};store.put(n);return n;};
  async function classify(workspace,ids,reclassify=false) {
    const settings=store.settings(),key=store.secret('openrouter')||process.env.OPENROUTER_API_KEY;
    if(settings.paused)fail('Jev is paused. Resume it from the sidebar.',409);
    if(!key)fail('Add your OpenRouter API key in Settings to run Jev.',409);
    const candidates=store.all().filter(m=>m.workspace===workspace && (!job.source||m.provider===job.source||ids) && !['archived','sent'].includes(m.status) && !m.delivery && (!hasManualCategory(m)||ids) && (ids?ids.includes(m.id):reclassify||needsClassification(m))).sort((a,b)=>new Date(b.date)-new Date(a.date));
    const messages=candidates.slice(0,job.batchSize),phaseStarted=performance.now();
    job.remaining=candidates.length-messages.length;job.total=messages.length;job.phase='Classifying with Jev';checkpoint(true);
    let cursor=0,blocked=false,pausedUntil=0;
    const retryPolicy={
      beforeAttempt:async()=>{while(Date.now()<pausedUntil)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,pausedUntil-Date.now())));},
      onRetry:(delay)=>{pausedUntil=Math.max(pausedUntil,Date.now()+delay);job.retries=(job.retries||0)+1;job.phase='OpenRouter is busy · waiting before retrying';checkpoint();}
    };
    async function worker(){
      while(cursor<messages.length&&!blocked){
        if(store.settings().paused||job.stopRequested){job.stopped=true;break;}
        const m=messages[cursor++];
        if(job.kind==='classify')job[m.provider==='gmail'?'emailsScanned':'commentsScanned']++;
        try {const d=await askJev(m,settings,key,request,retryPolicy);job.phase='Classifying with Jev';const current=store.get(m.id);if(current.revision!==m.revision)throw new Error('A message changed while Jev was working and was left untouched.');store.put(applyDecision(current,d,settings));job.classified++;job[m.provider==='gmail'?'emailsClassified':'commentsClassified']++;}
        catch(e){if(!job.errors.includes(e.message))job.errors.push(e.message);job.failed++;if(e.blocksBatch)blocked=true;}
        finally{job.completed++;checkpoint();}
      }
    }
    await Promise.all(Array.from({length:Math.min(JEV_CONCURRENCY,messages.length)},worker));
    job.classificationMs=performance.now()-phaseStarted;
    job.remaining+=messages.length-job.completed;
    store.log('Jev finished',`${job.classified} classified out of ${job.completed} attempted; ${job.failed} failed.`,workspace);
  }
  async function sync() {
    const phaseStarted=performance.now();job.phase='Scanning connected inboxes';checkpoint(true);
    const scannedIds=[];
    for(const provider of [job.source]) {
      if(!store.secret(provider))continue;
      try {
        const result=await (provider==='gmail'?syncGmail:syncYoutube)(store,request,({scanned=0,failed=0,pages,cached=0,downloaded=0,retrying})=>{job[provider==='gmail'?'emailsScanned':'commentsScanned']+=scanned;job.failed+=failed;job.cached+=cached;job.downloaded+=downloaded;job.pages=pages||job.pages;job.phase=retrying?'Google is limiting requests · retrying shortly':provider==='gmail'?'Reading Gmail · reusing saved emails':'Reading YouTube';checkpoint();},{limit:job.batchSize,query:job.gmailQuery,shouldStop:()=>job.stopRequested,readIntervalMs:gmailReadIntervalMs});
        job.errors.push(...(result.errors||[]));job.hasMore[provider]=result.hasMore;job.stopped=!!result.stopped;
        const dates=result.messages.map(m=>m.date).filter(Boolean).sort();job.oldestMessageAt=dates[0]||null;job.newestMessageAt=dates.at(-1)||null;
        for(const m of result.messages){const old=store.get(m.id);if(!old)job.newMessages++;const changed=old&&(old.body!==m.body||old.subject!==m.subject);const merged=old?{...m,...old,accountId:m.accountId,body:m.body,bodySource:m.bodySource,bodyVersion:m.bodyVersion,fromEmail:m.fromEmail||old.fromEmail,listId:m.listId||old.listId,autoSubmitted:m.autoSubmitted||old.autoSubmitted,subject:m.subject,context:m.context,...(changed?{decision:null,categoryOverride:hasManualCategory(old),status:old.delivery?old.status:'review',revision:old.revision+1}:{})}:m;if(needsClassification(merged))scannedIds.push(m.id);else job.alreadyClassified++;store.put(merged);}
        const now=new Date().toISOString();store.saveSettings({...store.settings(),[provider+'LastSync']:now});
        store.setSecret(provider,{...store.secret(provider),account:result.account,accountId:result.accountId});syncState[provider]={error:null,hasMore:result.hasMore,scope:result.scope};
        store.log('Inbox synced',`${result.messages.length} ${provider==='gmail'?'emails':'comments'} checked.`);
      }catch(e){syncState[provider]={error:e.message};job.errors.push(e.message);job.failed++;}
    }
    job.syncMs=performance.now()-phaseStarted;checkpoint();
    if(!job.stopped&&!job.stopRequested&&(job.runJev||store.settings().autoTriage)&&!store.settings().paused&&(store.secret('openrouter')||process.env.OPENROUTER_API_KEY))await classify('live',scannedIds);
    if(job.stopRequested)job.stopped=true;
  }
  function startJob(work,{workspace='live',kind='sync',runJev=false,source}={}) {
    if(job.busy)fail('Jev is already working. Wait for this run to finish.',409);
    runStarted=performance.now();
    const preferences=store.settings();
    job={id:randomBytes(12).toString('hex'),workspace,kind,source:source||(workspace==='sample'?null:preferences.batchSource),batchSize:preferences.batchSize,gmailQuery:preferences.gmailQuery,runJev,pages:0,alreadyClassified:0,cached:0,downloaded:0,stopRequested:false,busy:true,status:'running',phase:'Starting',completed:0,total:0,classified:0,emailsScanned:0,commentsScanned:0,emailsClassified:0,commentsClassified:0,failed:0,newMessages:0,remaining:0,errors:[],hasMore:{gmail:false,youtube:false},durationMs:0,syncMs:0,classificationMs:0,startedAt:new Date().toISOString(),endedAt:null};checkpoint(true);
    Promise.resolve().then(work).catch(e=>{job.errors.push(e.message);job.failed++;}).finally(()=>{job.durationMs=Math.max(0,performance.now()-runStarted);job.busy=false;job.endedAt=new Date().toISOString();job.status=job.stopped?'stopped':job.errors.length?'partial':'complete';job.phase=job.stopped?'Paused':job.errors.length?'Finished with issues':'Finished';checkpoint(true);});
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port=server.address()?.port;const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      if(!hosts.includes(req.headers.host))return json(res,403,{error:'Only local access is allowed.'});
      origin='http://'+req.headers.host;
      const url=new URL(req.url,origin);
      const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('jev_session='))?.slice(12);
      let session=sessions.get(cookie);
      if(session&&session.expiresAt<Date.now()){sessions.delete(cookie);session=null;}
      if(url.pathname==='/'&&req.method==='GET'&&!session) {
        const sid=randomBytes(24).toString('hex');session={csrf:randomBytes(24).toString('hex'),expiresAt:Date.now()+86400000};sessions.set(sid,session);
        res.setHeader('Set-Cookie',`jev_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
      }
      if(url.pathname==='/auth/google/callback') {
        const state=url.searchParams.get('state'),p=pendingOAuth.get(state);pendingOAuth.delete(state);
        if(!p||p.session!==session||p.expiresAt<Date.now())fail('This sign-in link expired. Start again from Settings.',403);
        if(url.searchParams.has('error')){res.writeHead(302,{Location:'/?connection=cancelled'});return res.end();}
        if(!url.searchParams.get('code'))fail('Google did not return a sign-in code.');
        const tokens=await exchangeCode(url.searchParams.get('code'),p,store.secret('google'),request);
        const identity=await googleIdentity(p.provider,tokens.access_token,request);
        store.setSecret(p.provider,{...tokens,...identity});store.log('Account connected',`${p.provider==='gmail'?'Gmail':'YouTube'} is ready to sync.`);
        res.writeHead(302,{Location:'/?connected='+p.provider});return res.end();
      }
      if(url.pathname.startsWith('/api/')) {
        if(!session)fail('Refresh the dashboard to start a local session.',401);
        if(req.headers.origin&&req.headers.origin!==origin)fail('Cross-origin requests are not allowed.',403);
        if(req.method==='POST'&&(req.headers['x-inbox-csrf']!==session.csrf||req.headers['content-type']?.split(';')[0]!=='application/json'))fail('Refresh the dashboard before trying again.',403);
        if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,{messages:store.all(),settings:settingsView(),activity:store.activity(),job:jobView(),runs:store.runs(),categories:Object.entries(CATEGORIES).map(([id,description])=>({id,label:CATEGORY_LABELS[id],description})),classificationVersion:CLASSIFICATION_VERSION,csrf:session.csrf});
        if(req.method!=='POST')fail('Unknown route.',404);
        const b=await body(req);
        if(url.pathname==='/api/settings') {
          const s=store.settings();
          if(b.model!==undefined){if(!/^typesafe\/jev-[a-zA-Z0-9._-]{1,80}$/.test(b.model))fail('Use a Jev model ID such as typesafe/jev-1.14.');s.model=b.model;}
          if(b.apiKey!==undefined&&b.apiKey!==''){if(typeof b.apiKey!=='string'||!/^sk-or-[A-Za-z0-9_-]{16,500}$/.test(b.apiKey.trim()))fail('Enter a valid OpenRouter API key.');}
          for(const name of ['autoTriage','autoSync','paused'])if(b[name]!==undefined){if(typeof b[name]!=='boolean')fail('Invalid workflow setting.');s[name]=b[name];}
          if(b.threshold!==undefined){if(!Number.isFinite(b.threshold)||b.threshold<0.3||b.threshold>1)fail('Confidence must be between 30% and 100%.');s.threshold=b.threshold;}
          if(b.gmailQuery!==undefined){if(typeof b.gmailQuery!=='string'||b.gmailQuery.length>300)fail('Keep the Gmail search under 300 characters.');s.gmailQuery=b.gmailQuery;}
          if(b.batchSize!==undefined){if(!BATCH_SIZES.includes(b.batchSize))fail('Choose 50, 100, 250, 500, or 1,000 messages.');s.batchSize=b.batchSize;}
          if(b.batchSource!==undefined){if(!['gmail','youtube'].includes(b.batchSource))fail('Choose Gmail or YouTube.');s.batchSource=b.batchSource;}
          if(b.templates){for(const [id,text]of Object.entries(b.templates)){if(!Object.hasOwn(TEMPLATES,id)||id==='none'||typeof text!=='string'||text.length>3000)fail('Invalid reply template.');s.templates[id]={...s.templates[id],text};}}
          if(b.googleClientId!==undefined){if(typeof b.googleClientId!=='string'||!b.googleClientId.endsWith('.apps.googleusercontent.com')||b.googleClientId.length>300)fail('Enter a Google OAuth web client ID.');const old=store.secret('google')||{};if(old.clientId&&old.clientId!==b.googleClientId.trim()&&(store.secret('gmail')||store.secret('youtube')))fail('Disconnect Google accounts before changing the OAuth client ID.',409);if(!b.googleClientSecret&&!old.clientSecret)fail('Enter the Google client secret.');if(b.googleClientSecret&&(typeof b.googleClientSecret!=='string'||b.googleClientSecret.length>500))fail('Invalid client secret.');store.setSecret('google',{clientId:b.googleClientId.trim(),clientSecret:b.googleClientSecret||old.clientSecret});}
          if(b.apiKey?.trim()){store.setSecret('openrouter',b.apiKey.trim());s.openrouterTestedAt=null;}
          if(b.model&&b.model!==store.settings().model)s.openrouterTestedAt=null;
          store.saveSettings(s);return json(res,200,{settings:settingsView()});
        }
        if(url.pathname==='/api/test-model') {
          const result=await askJev({provider:'gmail',sender:'Connection test',subject:'Thank you',body:'Thank you for the helpful tutorial. It was very clear.',date:new Date().toISOString()},store.settings(),store.secret('openrouter')||process.env.OPENROUTER_API_KEY,request);
          store.saveSettings({...store.settings(),openrouterTestedAt:new Date().toISOString()});return json(res,200,{model:result.model,latencyMs:result.latencyMs,category:result.category});
        }
        if(url.pathname==='/api/disconnect-model'){store.deleteSecret('openrouter');store.saveSettings({...store.settings(),openrouterTestedAt:null});return json(res,200,{ok:true});}
        if(url.pathname==='/api/google/start') {
          const p=authorizationUrl(b.provider,store.secret('google'),origin);
          for(const [key,v]of pendingOAuth)if(v.expiresAt<Date.now())pendingOAuth.delete(key);
          pendingOAuth.set(p.state,{...p,session,expiresAt:Date.now()+600000});return json(res,200,{url:p.url});
        }
        if(url.pathname==='/api/google/disconnect') {
          if(!['gmail','youtube'].includes(b.provider))fail('Unknown provider.');await revokeConnection(store,b.provider,request);return json(res,200,{ok:true});
        }
        if(url.pathname==='/api/sync'){const source=store.settings().batchSource;if(!store.secret(source))fail(`Connect ${source==='gmail'?'Gmail':'YouTube'} in Settings to scan this source.`,409);if(b.runJev!==undefined&&typeof b.runJev!=='boolean')fail('Invalid run option.');if(b.runJev&&(!store.secret('openrouter')&&!process.env.OPENROUTER_API_KEY))fail('Add your OpenRouter key in Settings to run Jev.',409);if(b.runJev&&store.settings().paused)fail('Resume Jev before starting a classification run.',409);startJob(sync,{runJev:!!b.runJev,source});return json(res,202,{job});}
        if(url.pathname==='/api/stop'){if(job.busy){job.stopRequested=true;job.phase='Stopping after current requests';checkpoint();}return json(res,200,{job:jobView()});}
        if(url.pathname==='/api/run') {
          if(!['sample','live'].includes(b.workspace))fail('Choose a workspace.');
          if(b.ids!==undefined&&(!Array.isArray(b.ids)||b.ids.length>1000||b.ids.some(id=>typeof id!=='string')))fail('Choose up to 1,000 messages.');
          if(b.reclassify!==undefined&&typeof b.reclassify!=='boolean')fail('Invalid reclassification option.');
          if(!store.secret('openrouter')&&!process.env.OPENROUTER_API_KEY)fail('Add your OpenRouter API key in Settings to run Jev.',409);
          if(store.settings().paused)fail('Jev is paused. Resume it first.',409);
          startJob(()=>classify(b.workspace,b.ids,b.reclassify),{workspace:b.workspace,kind:'classify'});return json(res,202,{job});
        }
        if(url.pathname==='/api/message') {
          const m=store.get(b.id);if(!m)fail('Message not found.',404);
          if(m.revision!==b.revision)fail('This message has changed. Refresh and try again.',409);
          if(m.delivery==='pending'||m.delivery==='uncertain')fail('Check the provider before changing this message. Its delivery is not yet confirmed.',409);
          const patch={};
          if(b.draft!==undefined){if(typeof b.draft!=='string'||b.draft.length>10000)fail('Keep replies under 10,000 characters.');patch.draft=b.draft;}
          if(b.status!==undefined){if(!['new','open','review','archived'].includes(b.status))fail('Invalid status.');patch.status=b.status;patch.manualReview=b.status==='review';}
          if(b.category!==undefined){if(!Object.hasOwn(CATEGORIES,b.category))fail('Invalid category.');patch.category=b.category;patch.categoryOverride=true;if(m.status==='new')patch.status='open';}
          if(b.priority!==undefined){if(!['high','normal','low'].includes(b.priority))fail('Invalid priority.');patch.priority=b.priority;patch.priorityOverride=true;}
          if(b.pinned!==undefined){if(typeof b.pinned!=='boolean')fail('Invalid pin value.');patch.pinned=b.pinned;}
          const updated=bump(m,patch);return json(res,200,{message:updated});
        }
        if(url.pathname==='/api/send') {
          const m=store.get(b.id);if(!m||m.revision!==b.revision)fail('This message changed. Review it again.',409);
          if(typeof b.draft!=='string'||!b.draft.trim()||b.draft.length>10000)fail('Write a reply first.');
          if(m.status==='sent'||m.delivery)fail('This reply was already submitted. Check the provider before taking another action.',409);
          if(b.confirmed!==true)fail('Review and confirm this exact reply first.',409);
          if(m.workspace==='sample'){const message=bump(m,{status:'sent',draft:b.draft,sentAt:new Date().toISOString()});store.log('Sample reply completed','Simulation only. Nothing was sent.',m.workspace);return json(res,200,{message,simulated:true});}
          if(!m.accountId||store.secret(m.provider)?.accountId!==m.accountId)fail('Connect this conversation’s original account before replying.',409);
          const operationId=createHash('sha256').update(m.id+'|'+m.revision+'|'+b.draft).digest('hex');
          if(!store.startOperation(operationId,{messageId:m.id}))fail('This reply was already submitted. Check the provider.',409);
          const pending=bump(m,{delivery:'pending',draft:b.draft});
          try {const result=await sendReply(store,m,b.draft,request);const message=bump(pending,{status:'sent',delivery:'sent',sentAt:new Date().toISOString(),providerReplyId:result.id});store.endOperation(operationId,'sent',result);store.log('Reply sent',`${m.provider==='gmail'?'Email':'YouTube reply'} to ${m.sender}.`);return json(res,200,{message});}
          catch(e){bump(pending,{delivery:'uncertain'});store.endOperation(operationId,'uncertain',{error:e.message});fail(e.message+' Delivery is unconfirmed. Check the original inbox before retrying.',502);}
        }
        if(url.pathname==='/api/reset-samples'){if(job.busy)fail('Wait for Jev to finish first.',409);store.resetSamples();return json(res,200,{ok:true});}
        fail('Unknown route.',404);
      }
      const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml']};
      for(const [file,type]of Object.entries({'material-symbols.woff2':'font/woff2','roboto-latin.woff2':'font/woff2','gmail.png':'image/png','youtube.png':'image/png'}))files['/assets/'+file]=['assets/'+file,type];
      if(req.method!=='GET'||!files[url.pathname])return json(res,404,{error:'Not found.'});
      const [name,type]=files[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(await readFile(join(ROOT,'public',name)));
    }catch(e){json(res,e.status||500,{error:e.status?e.message:'Something went wrong locally. Refresh and try again.'});}
  });
  const timer=setInterval(()=>{const s=store.settings();if(s.autoSync&&!s.paused&&!job.busy&&store.secret(s.batchSource))startJob(sync);},300000);timer.unref();
  server.on('close',()=>{clearInterval(timer);store.close();});
  return {server,store,getJob:()=>job};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||5184);const app=createApp({dataDir:process.env.JEV_DATA_DIR||join(ROOT,'data')});
  app.server.listen(port,'127.0.0.1',()=>{const url=`http://localhost:${port}`;console.log(`Jev Inbox is ready at ${url}`);if(process.argv.includes('--open'))spawn('open',[url],{stdio:'ignore'});});
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Port ${port} is already in use. Open http://localhost:${port} or set PORT to another local port.`:e.message);process.exitCode=1;});
}
