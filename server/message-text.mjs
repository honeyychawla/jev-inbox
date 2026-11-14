// Email bodies are rendered as escaped text. Never load images, attachments or links.
export const BODY_VERSION = 2;
const decode = value => value ? Buffer.from(value, 'base64url').toString('utf8') : '';
export function decodeEntities(text) {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',hellip:'…',bull:'•',copy:'©',reg:'®'};
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if(entity[0] !== '#') return named[entity.toLowerCase()] ?? whole;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}
export function tidyText(text) {
  return decodeEntities(text).replace(/[\u00ad\u034f\u200b-\u200f\u2060\ufeff]/g,'').replace(/\r\n?/g,'\n').replace(/[\t \u00a0\u2007]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function htmlText(html) {
  return tidyText(String(html || '').replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1[^>]*>/gi,' $2 ').replace(/<(?:br|hr)\b[^>]*>|<\/(?:div|p|li|tr|h[1-6]|section|table)>/gi,'\n').replace(/<[^>]*>/g,' '));
}
function collectParts(payload, type, found = []) {
  if(payload?.mimeType === type && !payload.filename) found.push(decode(payload.body?.data));
  for(const part of payload?.parts || []) collectParts(part,type,found);
  return found;
}
export function emailBody(payload, snippet = '') {
  const plain = tidyText(collectParts(payload,'text/plain').join('\n'));
  const html = htmlText(collectParts(payload,'text/html').join('\n'));
  const stub = /^to view this content open|^view (?:this )?(?:email|message) in (?:your |a )?browser/i.test(plain);
  const text = (!plain || stub) && html ? html : plain;
  return {body:(text || tidyText(snippet)).slice(0,30000),bodySource:text ? ((!plain || stub) && html ? 'html' : 'plain') : 'snippet',bodyVersion:BODY_VERSION};
}
export function decisionText(text) {
  // Tracking URLs and invisible email padding can dominate the useful text.
  return tidyText(text).replace(/https?:\/\/[^\s<>\[\]()]+/gi, url => {
    try { const u = new URL(url); return u.hostname + (u.pathname.length < 90 ? u.pathname : '/…'); } catch { return '[link]'; }
  });
}
export function canReuseEmail(message) {
  if(!message?.body?.trim() || message.delivery === 'pending') return false;
  if(message.bodyVersion === BODY_VERSION) return true;
  // Earlier imports did not record whether the body was only Gmail's short snippet.
  return message.body.trim().length > 220 && decisionText(message.body).length > 100 && !/^to view this content open/i.test(message.body);
}
