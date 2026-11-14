import { randomBytes, createHash } from 'node:crypto';
import { questions, validateDecision } from './domain.mjs';
import { emailBody, decisionText, canReuseEmail } from './message-text.mjs';

export class ProviderError extends Error { constructor(message,status=502,details={}){super(message);this.status=status;Object.assign(this,details);} }
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
export function providerError(status,body,headers,url) {
  const google = new URL(url).hostname.endsWith('googleapis.com');
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.details?.find(d=>d.reason)?.reason || '';
  const rateLimited = status===429 || ['rateLimitExceeded','userRateLimitExceeded','RATE_LIMIT_EXCEEDED'].includes(reason);
  const messages={401:'Your connection has expired or the API key was rejected. Reconnect in Settings.',402:'OpenRouter needs credits before Jev can run.',403:'The provider denied access. Check your account permissions and enabled APIs.',404:'The selected model or resource is unavailable.'};
  const reasons={dailyLimitExceeded:'Google’s daily API quota has been reached. Try again after it resets.',domainPolicy:'Your Google Workspace administrator has blocked this app’s Gmail access.',accessNotConfigured:'The Gmail API is not enabled for this Google Cloud project.',SERVICE_DISABLED:'The Gmail API is not enabled for this Google Cloud project.',insufficientPermissions:'The Google connection does not have the required permission. Reconnect in Settings.'};
  const message = rateLimited ? `${google?'Google':'OpenRouter'} is limiting requests. Completed work is saved; wait a minute, then resume.` : reasons[reason] || messages[status] || `The provider returned an error (${status}). Check its setup and try again.`;
  const retryHeader = headers?.get?.('retry-after'),seconds=Number(retryHeader);
  const retryAfterMs = retryHeader ? (Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(retryHeader)-Date.now())) : 0;
  return new ProviderError(message,status>=400&&status<500?status:502,{reason,rateLimited,retryable:rateLimited||status>=500,retryAfterMs:Number.isFinite(retryAfterMs)?retryAfterMs:0,blocksBatch:[401,402,403,429].includes(status)||status>=500});
}
async function remote(url,options={},request=fetch,policy={}) {
  for(let attempt=0;;attempt++){
  await policy.beforeAttempt?.();
  let res; try {res=await request(url,{...options,signal:AbortSignal.timeout(25000),redirect:'error'});}catch {throw new ProviderError('The provider could not be reached. Check your connection and try again.');}
  const body=await res.json().catch(()=>null);
  if(!res.ok || body?.error) {
    const error=providerError(res.status,body,res.headers,url);
    if(error.retryable&&attempt<(policy.retries||0)&&error.retryAfterMs<=5000){const delay=Math.max(error.retryAfterMs,1000*2**attempt);policy.onRetry?.(delay,error);await (policy.sleep||wait)(delay);continue;}
    throw error;
  }
  if(!body)throw new ProviderError('The provider returned an unreadable response.');
  return body;
  }
}
export async function askJev(message,settings,key,request=fetch,policy={}) {
  if(!key)throw new ProviderError('Add your OpenRouter API key in Settings to run Jev.',409);
  const started=performance.now();
  const raw=await remote('https://openrouter.ai/api/alpha/decisions',{
    method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Title':'Jev Inbox Local'},
    body:JSON.stringify({model:settings.model,state:{sender:message.sender,senderEmail:message.fromEmail||message.email,subject:message.subject,content:decisionText(message.body),contentSource:message.bodySource||'saved email',mailingList:!!message.listId,automated:message.autoSubmitted||undefined,source:message.provider,date:message.date,currentTime:new Date().toISOString()},questions:questions(settings)})
  },request,{retries:2,...policy});
  const decision=validateDecision(raw,settings);
  if(message.bodySource==='snippet'||!message.body?.trim()){decision.review=true;decision.reviewReasons.push('Only a preview of the email was available. Check the full email.');}
  decision.latencyMs=Math.max(0,performance.now()-started);
  return decision;
}
const SCOPES={gmail:'https://www.googleapis.com/auth/gmail.modify',youtube:'https://www.googleapis.com/auth/youtube.force-ssl'};
export function authorizationUrl(provider,credentials,origin) {
  if(!SCOPES[provider])throw new ProviderError('Unknown provider.',400);
  if(!credentials?.clientId||!credentials?.clientSecret)throw new ProviderError('Add a Google OAuth client ID and client secret in Connections first.',409);
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  const redirectUri=origin+'/auth/google/callback';
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:credentials.clientId,redirect_uri:redirectUri,response_type:'code',scope:SCOPES[provider],state,access_type:'offline',prompt:'consent',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  return {url:url.href,state,verifier,redirectUri,provider};
}
export async function exchangeCode(code,pending,credentials,request=fetch) {
  const result=await remote('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:credentials.clientId,client_secret:credentials.clientSecret,redirect_uri:pending.redirectUri,grant_type:'authorization_code',code_verifier:pending.verifier})},request);
  if(typeof result.access_token!=='string')throw new ProviderError('Google did not return an access token.');
  return {...result,expiresAt:Date.now()+(result.expires_in||3600)*1000};
}
export async function googleIdentity(provider,token,request=fetch) {
  if(provider==='gmail'){const p=await remote('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token}`}},request);if(!p.emailAddress)throw new ProviderError('Google did not identify the Gmail account.');return {account:p.emailAddress,accountId:p.emailAddress.toLowerCase()};}
  const p=await remote('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',{headers:{Authorization:`Bearer ${token}`}},request);const c=p.items?.[0];if(!c)throw new ProviderError('No YouTube channel was found for this account.',409);return {account:c.snippet.title,accountId:c.id};
}
export async function accessToken(store,provider,request=fetch) {
  const tokens=store.secret(provider); const creds=store.secret('google');
  if(!tokens)throw new ProviderError(`Connect ${provider==='gmail'?'Gmail':'YouTube'} in Settings first.`,409);
  if(tokens.expiresAt>Date.now()+60000)return tokens.access_token;
  if(!tokens.refresh_token||!creds)throw new ProviderError('Your Google session has expired. Reconnect in Settings.',401);
  const result=await remote('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:creds.clientId,client_secret:creds.clientSecret,refresh_token:tokens.refresh_token,grant_type:'refresh_token'})},request);
  if(typeof result.access_token!=='string')throw new ProviderError('Google did not refresh the connection.');
  store.setSecret(provider,{...tokens,...result,expiresAt:Date.now()+(result.expires_in||3600)*1000});return result.access_token;
}
const auth=token=>({Authorization:`Bearer ${token}`});
const header=(payload,key)=>payload?.headers?.find(h=>h.name.toLowerCase()===key.toLowerCase())?.value||'';
const cleanHeader=s=>String(s||'').replace(/[\r\n]/g,' ').trim();
export function extractEmail(raw) {const m=raw.match(/<([^<>]+)>/);const e=(m?m[1]:raw).trim();return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(e)?e:'';}
// Full Gmail reads cost 60 units; pace below the 6,000 units/user/minute limit.
// The scheduler survives successive runs in this server; cached bodies cost no read quota.
const gmailSchedules=new WeakMap();
export async function syncGmail(store,request=fetch,onProgress=()=>{},options={}) {
  const token=await accessToken(store,'gmail',request),settings=store.settings();
  const limit=options.limit??settings.batchSize??50,query=options.query??settings.gmailQuery,shouldStop=options.shouldStop||(()=>false);
  const sleep=options.sleep||wait,now=options.now||Date.now,readIntervalMs=options.readIntervalMs??700;
  let schedule=gmailSchedules.get(store);if(!schedule){schedule={next:0};gmailSchedules.set(store,schedule);}
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new ProviderError('Choose a batch size between 1 and 1,000.',400);
  const policy={retries:2,sleep,onRetry:(delay,error)=>{onProgress({scanned:0,failed:0,retrying:true,reason:error.reason});schedule.next=Math.max(schedule.next,now()+delay);}};
  const read=url=>remote(url,{headers:auth(token)},request,policy);
  const profile=await read('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  const accountId=profile.emailAddress.toLowerCase(),prefix=`gmail-${createHash('sha256').update(accountId).digest('hex').slice(0,12)}-`;
  const messages=[],errors=[],seen=new Set(),pageTokens=new Set();
  let pageToken='',hasMore=false,stopped=false,blocked=false,pages=0,cached=0,downloaded=0;
  while(seen.size<limit){
    if(shouldStop()){stopped=true;hasMore=true;break;}
    let listed;
    try{listed=await read('https://gmail.googleapis.com/gmail/v1/users/me/messages?'+new URLSearchParams({q:query,maxResults:String(Math.min(500,limit-seen.size)),...(pageToken?{pageToken}:{})}));}
    catch(error){if(!pages)throw error;errors.push(error.message);onProgress({scanned:0,failed:1,pages});hasMore=true;break;}
    pages++;
    const ids=[];
    for(const row of listed.messages||[]){if(!row.id||seen.has(row.id)||seen.size>=limit)continue;seen.add(row.id);ids.push(row.id);}
    let cursor=0;
    async function worker(){
      while(cursor<ids.length&&!blocked&&!shouldStop()){
        const id=ids[cursor++],saved=store.get?.(prefix+id);
        if(saved?.accountId===accountId&&canReuseEmail(saved)){
          messages.push(saved);cached++;onProgress({scanned:1,failed:0,pages,cached:1});continue;
        }
        const at=Math.max(now(),schedule.next);schedule.next=at+readIntervalMs;
        if(at>now())await sleep(at-now());
        if(blocked||shouldStop())break;
        try{
          const m=await read(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
          const from=header(m.payload,'From'),replyTo=header(m.payload,'Reply-To');
          const message={id:prefix+id,workspace:'live',provider:'gmail',externalId:id,threadId:m.threadId,messageId:header(m.payload,'Message-ID'),references:header(m.payload,'References'),sender:from.replace(/<[^>]*>/,'').replace(/^"|"$/g,'').trim()||from,email:extractEmail(replyTo||from),fromEmail:extractEmail(from),listId:header(m.payload,'List-Id'),autoSubmitted:header(m.payload,'Auto-Submitted'),subject:header(m.payload,'Subject')||'(No subject)',...emailBody(m.payload,m.snippet),date:new Date(Number(m.internalDate)).toISOString(),context:'Inbox',category:'other',priority:'normal',needsReply:false,status:'new',draft:'',revision:1,pinned:false,accountId};
          messages.push(message);downloaded++;onProgress({scanned:1,failed:0,pages,downloaded:1});
        }catch(error){
          if(!errors.includes(error.message))errors.push(error.message);
          onProgress({scanned:0,failed:1,pages});
          // Stop the queue on systemic errors instead of repeating the same failure for every email.
          if(error.blocksBatch){blocked=true;hasMore=true;}
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(5,ids.length)},worker));
    if(shouldStop()){stopped=true;hasMore=true;}
    if(stopped||blocked)break;
    hasMore=!!listed.nextPageToken;
    if(!hasMore||seen.size>=limit)break;
    if(pageTokens.has(listed.nextPageToken)||!ids.length){errors.push('Gmail repeated a page; scanning stopped to avoid duplicate work.');onProgress({scanned:0,failed:1,pages});break;}
    pageToken=listed.nextPageToken;pageTokens.add(pageToken);
  }
  return {messages:messages.sort((a,b)=>new Date(b.date)-new Date(a.date)),errors,account:profile.emailAddress,accountId,hasMore,stopped,blocked,pages,cached,downloaded,scope:`Newest ${limit} emails matching: ${query}`};
}
export async function syncYoutube(store,request=fetch,onProgress=()=>{},options={}) {
  const token=await accessToken(store,'youtube',request),limit=options.limit??store.settings?.().batchSize??100,shouldStop=options.shouldStop||(()=>false);
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new ProviderError('Choose a batch size between 1 and 1,000.',400);
  const channels=await remote('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',{headers:auth(token)},request);
  const channel=channels.items?.[0];if(!channel)throw new ProviderError('No YouTube channel was found for this Google account.',409);
  const messages=[],errors=[],seen=new Set(),pageTokens=new Set();let pageToken='',pages=0,hasMore=false,stopped=false;
  while(messages.length<limit){
    if(shouldStop()){stopped=true;hasMore=true;break;}
    let result;
    try{result=await remote('https://www.googleapis.com/youtube/v3/commentThreads?'+new URLSearchParams({part:'snippet',allThreadsRelatedToChannelId:channel.id,maxResults:String(Math.min(100,limit-messages.length)),order:'time',textFormat:'plainText',...(pageToken?{pageToken}:{})}),{headers:auth(token)},request);}
    catch(error){if(!pages)throw error;errors.push(error.message);onProgress({scanned:0,failed:1,pages});hasMore=true;break;}
    pages++;let added=0;
    for(const t of result.items||[]){const c=t.snippet?.topLevelComment,s=c?.snippet;if(!c||!s||seen.has(c.id)||messages.length>=limit)continue;seen.add(c.id);messages.push({id:`youtube-${c.id}`,workspace:'live',provider:'youtube',externalId:c.id,videoId:t.snippet.videoId,sender:s.authorDisplayName,email:'',subject:s.textOriginal.slice(0,90),body:s.textOriginal,date:s.publishedAt,context:'YouTube comment',category:'other',priority:'normal',needsReply:false,status:'new',draft:'',revision:1,pinned:false,likeCount:s.likeCount,replyCount:t.snippet.totalReplyCount,accountId:channel.id});added++;}
    onProgress({scanned:added,failed:0,pages});hasMore=!!result.nextPageToken;
    if(!hasMore||messages.length>=limit)break;
    if(pageTokens.has(result.nextPageToken)||!added){errors.push('YouTube repeated a page; scanning stopped to avoid duplicate work.');onProgress({scanned:0,failed:1,pages});break;}
    pageToken=result.nextPageToken;pageTokens.add(pageToken);
  }
  return {messages,errors,account:channel.snippet.title,accountId:channel.id,hasMore,stopped,pages,scope:`Newest ${limit} published comment threads`};
}
export function gmailMime(message,draft) {
  if(!message.email||!extractEmail(message.email))throw new ProviderError('This message has no valid reply address.',400);
  const subject=/^re:/i.test(message.subject)?message.subject:'Re: '+message.subject;
  const lines=[`To: ${cleanHeader(message.email)}`,`Subject: =?UTF-8?B?${Buffer.from(cleanHeader(subject)).toString('base64')}?=`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
  if(message.messageId)lines.push(`In-Reply-To: ${cleanHeader(message.messageId)}`,`References: ${cleanHeader([message.references,message.messageId].filter(Boolean).join(' '))}`);
  return Buffer.from(lines.join('\r\n')+'\r\n\r\n'+Buffer.from(draft).toString('base64').match(/.{1,76}/g).join('\r\n')).toString('base64url');
}
export async function sendReply(store,message,draft,request=fetch) {
  if(message.workspace!=='live')throw new ProviderError('Sample messages cannot be sent to a provider.',400);
  const connection=store.secret(message.provider);
  if(!message.accountId||connection?.accountId!==message.accountId)throw new ProviderError('This conversation belongs to a different account. Connect its original account before replying.',409);
  const token=await accessToken(store,message.provider,request);
  if(message.provider==='gmail') {
    const result=await remote('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{...auth(token),'Content-Type':'application/json'},body:JSON.stringify({threadId:message.threadId,raw:gmailMime(message,draft)})},request);
    if(!result.id)throw new ProviderError('Gmail did not confirm delivery. Check Sent before retrying.');return {id:result.id};
  }
  const result=await remote('https://www.googleapis.com/youtube/v3/comments?part=snippet',{method:'POST',headers:{...auth(token),'Content-Type':'application/json'},body:JSON.stringify({snippet:{parentId:message.externalId,textOriginal:draft}})},request);
  if(!result.id)throw new ProviderError('YouTube did not confirm the reply. Check the thread before retrying.');return {id:result.id};
}
export async function revokeConnection(store,provider,request=fetch) {
  const t=store.secret(provider);
  if(t){const r=await request('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:t.refresh_token||t.access_token}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw new ProviderError('Google could not revoke the connection. Try again.');}
  store.deleteSecret(provider);
}
