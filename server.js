'use strict';
const WebSocket = require('ws');
const http      = require('http');
const https     = require('https');
const { URL }   = require('url');
const crypto    = require('crypto');

const PORT = 8080;

const AD_DOMAINS = new Set([
  'doubleclick.net','googlesyndication.com','googletagmanager.com',
  'googletagservices.com','google-analytics.com','adservice.google.com',
  'adnxs.com','adsystem.amazon.com','advertising.com','ads.yahoo.com',
  'outbrain.com','taboola.com','scorecardresearch.com','quantserve.com',
  'moatads.com','pubmatic.com','rubiconproject.com','openx.net',
  'adsrvr.org','casalemedia.com','criteo.com','hotjar.com',
  'mouseflow.com','fullstory.com','segment.com','mixpanel.com',
  'amplitude.com','heap.io','bat.bing.com','ads.twitter.com',
  'connect.facebook.net','mc.yandex.ru',
]);

function isAd(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    for (const d of AD_DOMAINS) if (h === d || h.endsWith('.' + d)) return true;
  } catch {}
  return false;
}

// ── Fetch with redirect following ─────────────────────────────────────────────
function fetchUrl(targetUrl, opts = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 12) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(new Error('Invalid URL: ' + targetUrl)); }

    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Connection': 'close',
    };
    if (opts.referer) headers['Referer'] = opts.referer;
    if (opts.blockCookies) { delete headers['Cookie']; }

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers,
    }, res => {
      const s = res.statusCode;
      if ([301,302,303,307,308].includes(s) && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, targetUrl).href; } catch { return reject(new Error('Bad redirect')); }
        res.resume();
        return resolve(fetchUrl(next, { ...opts, method: [302,303].includes(s) ? 'GET' : opts.method }, hops + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: s, headers: res.headers, body: Buffer.concat(chunks), finalUrl: targetUrl }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timed out')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── URL helpers ────────────────────────────────────────────────────────────────
function abs(href, base) {
  if (!href) return null;
  href = href.trim();
  if (!href || href === '#' || /^(javascript|data|mailto|tel|blob):/i.test(href)) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

// ── HTML rewriting — rewrites ALL URLs server-side ─────────────────────────────
function rewriteHtml(html, baseUrl, opts) {
  // Strip embedding-blocking meta tags
  html = html.replace(/<meta\b[^>]*?http-equiv\s*=\s*['"](?:x-frame-options|content-security-policy(?:-report-only)?)['"][^>]*?>/gi, '');

  // Strip scripts if requested
  if (opts.removeScripts) {
    html = html.replace(/<script\b[^>]*?>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/\s+on\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
  }

  // Strip images if requested
  if (opts.noImages) {
    html = html.replace(/<img\b[^>]*?>/gi, '');
    html = html.replace(/<picture\b[^>]*?>[\s\S]*?<\/picture>/gi, '');
  }

  // <script src= → data-wsrc  (scripts need to be fetched & embedded)
  if (!opts.removeScripts) {
    html = html.replace(/(<script\b[^>]*?\s)src\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, val) => {
      const r = abs(val, baseUrl); return r ? `${pre}data-wsrc="${r}" src=""` : m;
    });
  }

  // <img src= / <video src= / <audio src= / <source src= / <embed src=
  if (!opts.noImages) {
    html = html.replace(/(<(?:img|video|audio|source|embed|track)\b[^>]*?\s)src\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, val) => {
      const r = abs(val, baseUrl); return r ? `${pre}data-wsrc="${r}" src=""` : m;
    });
    html = html.replace(/(<(?:img|source)\b[^>]*?\s)srcset\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, val) => {
      const rw = val.replace(/([^\s,]+)(\s+\S+)?/g, (mm, u, d) => { const r = abs(u, baseUrl); return r ? r + (d||'') : mm; });
      return `${pre}srcset="${rw}"`;
    });
  }

  // <link href= (stylesheets, icons, preloads)
  html = html.replace(/(<link\b[^>]*?\s)href\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, val) => {
    const r = abs(val, baseUrl); return r ? `${pre}data-whref="${r}" href=""` : m;
  });

  // <a href= → data-proxyhref + href="javascript:void(0)"
  // This is the critical one — done server-side so JS frameworks can't undo it
  html = html.replace(/(<a\b[^>]*?\s)href\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, val) => {
    const r = abs(val, baseUrl);
    if (!r) return m;
    return `${pre}data-proxyhref="${r}" href="javascript:void(0)"`;
  });

  // Remove target= on all <a> tags
  html = html.replace(/(<a\b[^>]*?)\s+target\s*=\s*(['"])[^'"]*\2/gi, '$1');

  // <form action=
  html = html.replace(/(<form\b[^>]*?\s)action\s*=\s*(['"])(.*?)\2/gi, (m, pre, q, val) => {
    const r = abs(val, baseUrl); return r ? `${pre}data-proxyaction="${r}" action="javascript:void(0)"` : m;
  });

  // CSS url() inside <style> blocks and inline style=
  if (!opts.noImages) {
    html = html.replace(/(<style\b[^>]*?>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
      return open + rewriteCss(css, baseUrl) + close;
    });
    html = html.replace(/(\sstyle\s*=\s*['"])(.*?)(?=['"])/gi, (m, pre, css) => {
      return pre + rewriteCss(css, baseUrl);
    });
  }

  return html;
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, val) => {
    if (!val || val.startsWith('data:')) return m;
    const r = abs(val, baseUrl); return r ? `url("${r}")` : m;
  });
}

// ── Injected intercept script ─────────────────────────────────────────────────
function buildInjectedScript(finalUrl, opts) {
  return `<script id="__gp__">
(function(){
'use strict';
if(window.__gpActive) return; window.__gpActive=true;

var BASE   = ${JSON.stringify(finalUrl)};
var ORIGIN = (function(){ try{return new URL(BASE).origin;}catch(e){return '';} })();
var OPTS   = ${JSON.stringify(opts)};
var AD_HOSTS = ${JSON.stringify([...AD_DOMAINS])};

function isAd(url){ try{ var h=new URL(url).hostname.toLowerCase(); return AD_HOSTS.some(function(a){return h===a||h.endsWith('.'+a);}); }catch(e){return false;} }
function resolve(url){ if(!url)return url; try{return new URL(url,BASE).href;}catch(e){return url;} }
function sameOrigin(url){ try{return new URL(url).origin===ORIGIN;}catch(e){return false;} }

// ── postMessage bridge (for fetch/XHR) ───────────────────────────────────────
var _id=0, _pending={};
function wsBridge(opts){
  return new Promise(function(res,rej){
    var id=++_id; _pending[id]={resolve:res,reject:rej};
    window.parent.postMessage({type:'ws-api',id:id,opts:opts},'*');
  });
}
window.addEventListener('message',function(e){
  var d=e.data; if(!d) return;
  if(d.type==='ws-api-response'&&_pending[d.id]){_pending[d.id].resolve(d);delete _pending[d.id];}
  if(d.type==='ws-api-error'   &&_pending[d.id]){_pending[d.id].reject(new Error(d.message));delete _pending[d.id];}
});

// ── proxyNav — all navigation goes through parent ────────────────────────────
function proxyNav(url){
  if(!url) return;
  var r=resolve(url);
  if(!r||/^(javascript|data|blob|mailto|tel):/.test(r)) return;
  window.parent.postMessage({type:'ws-navigate',url:r},'*');
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: Location.prototype — intercepts location.href = '...',
//          location.assign(), location.replace()
//          Works because iframe uses allow-same-origin with null (blob:) origin.
// ═══════════════════════════════════════════════════════════════════════════
try {
  var _lp = Object.getPrototypeOf(window.location);
  var _hd = Object.getOwnPropertyDescriptor(_lp,'href');
  if(_hd){
    Object.defineProperty(_lp,'href',{
      get: _hd.get,
      set: function(v){ proxyNav(String(v)); },
      configurable:true
    });
  }
  _lp.assign  = function(u){ proxyNav(u); };
  _lp.replace = function(u){ proxyNav(u); };
} catch(e) {
  // Fallback — try window.location directly
  try { Object.defineProperty(window,'location',{get:function(){return window.location;},set:function(v){proxyNav(String(v));},configurable:true}); } catch(e2){}
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2: HTMLAnchorElement.prototype.href setter
//          Intercepts: a.href = '/new-page' from React Router etc.
// ═══════════════════════════════════════════════════════════════════════════
try {
  var _ap = HTMLAnchorElement.prototype;
  var _ahd = Object.getOwnPropertyDescriptor(_ap,'href');
  if(_ahd&&_ahd.set){
    Object.defineProperty(_ap,'href',{
      get: _ahd.get,
      set: function(v){
        var r=resolve(v);
        if(r&&r.startsWith('http')){
          this.setAttribute('data-proxyhref',r);
          _ahd.set.call(this,'javascript:void(0)');
        } else {
          _ahd.set.call(this,v);
        }
      },
      configurable:true
    });
  }
} catch(e){}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3: Element.prototype.setAttribute
//          Intercepts: el.setAttribute('href', '/page') — used by Svelte, Astro etc.
// ═══════════════════════════════════════════════════════════════════════════
var _origSetAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(name, value){
  if(name==='href' && this instanceof HTMLAnchorElement){
    var r=resolve(value);
    if(r&&r.startsWith('http')){
      _origSetAttr.call(this,'data-proxyhref',r);
      return _origSetAttr.call(this,name,'javascript:void(0)');
    }
  }
  return _origSetAttr.apply(this,arguments);
};

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4: Click event — reads data-proxyhref (server-set or Layer 2/3-set)
//          Uses capture+stopImmediatePropagation so page handlers can't prevent it
// ═══════════════════════════════════════════════════════════════════════════
function clickHandler(e){
  var el=e.target; while(el&&el.tagName!=='A') el=el.parentElement;
  if(!el) return;
  var href=el.getAttribute('data-proxyhref')||el.getAttribute('href')||'';
  if(!href||href==='#'||/^(javascript|data|blob|mailto|tel):/.test(href)) return;
  var r=resolve(href);
  if(!r||!r.startsWith('http')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  proxyNav(r);
}
document.addEventListener('click',clickHandler,true);
document.addEventListener('click',clickHandler,false);

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5: MutationObserver — patches links added after initial load
// ═══════════════════════════════════════════════════════════════════════════
function patchAnchor(a){
  if(a.__gp) return; a.__gp=true;
  var href=a.getAttribute('href');
  if(!href||href==='javascript:void(0)'||/^(javascript|data|blob|mailto|tel):/i.test(href)) return;
  var r=resolve(href);
  if(!r||!r.startsWith('http')) return;
  a.setAttribute('data-proxyhref',r);
  _origSetAttr.call(a,'href','javascript:void(0)');
  a.removeAttribute('target');
}
function patchAll(root){
  (root||document).querySelectorAll('a[href]').forEach(patchAnchor);
}
var _mo=new MutationObserver(function(muts){
  muts.forEach(function(m){
    if(m.type==='childList'){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1) return;
        if(n.tagName==='A') patchAnchor(n);
        else if(n.querySelectorAll) patchAll(n);
      });
    } else if(m.type==='attributes'&&m.target.tagName==='A'){
      m.target.__gp=false; patchAnchor(m.target);
    }
  });
});
_mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['href','target']});

// Patch links already in DOM
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',function(){patchAll();});
} else { patchAll(); }
window.addEventListener('load',patchAll);

// ── Form intercept ────────────────────────────────────────────────────────────
document.addEventListener('submit',function(e){
  e.preventDefault();
  e.stopImmediatePropagation();
  var action=e.target.getAttribute('data-proxyaction')||e.target.getAttribute('action')||BASE;
  proxyNav(resolve(action));
},true);

// ── window.open ───────────────────────────────────────────────────────────────
var _origOpen=window.open;
window.open=function(url){ if(url&&url!=='about:blank'){proxyNav(url);return null;} return _origOpen?_origOpen.apply(window,arguments):null; };

// ── history.pushState / replaceState ─────────────────────────────────────────
// Allow SPA internal routing but keep parent address bar in sync
var _ph=history.pushState.bind(history), _rh=history.replaceState.bind(history);
history.pushState=function(s,t,u){ _ph(s,t,u); if(u) window.parent.postMessage({type:'ws-urlupdate',url:resolve(String(u))},'*'); };
history.replaceState=function(s,t,u){ _rh(s,t,u); if(u) window.parent.postMessage({type:'ws-urlupdate',url:resolve(String(u))},'*'); };

// ── fetch() intercept ─────────────────────────────────────────────────────────
var _origFetch=window.fetch?window.fetch.bind(window):null;
window.fetch=function(input,init){
  var url=(input instanceof Request)?input.url:String(input);
  url=resolve(url);
  if(OPTS.removeAds&&isAd(url)) return Promise.resolve(new Response('',{status:204}));
  if(!sameOrigin(url)&&_origFetch) return _origFetch.apply(window,arguments);
  var method=(init&&init.method)||(input instanceof Request&&input.method)||'GET';
  var headers={}; var rawH=(init&&init.headers)||(input instanceof Request?input.headers:null);
  if(rawH){ if(typeof rawH.entries==='function'){for(var p of rawH.entries())headers[p[0]]=p[1];}else Object.assign(headers,rawH||{}); }
  var body=null; var rb=(init&&init.body!=null)?init.body:(input instanceof Request?null:null);
  if(rb!=null){ if(typeof rb==='string')body=rb; else if(rb instanceof URLSearchParams)body=rb.toString(); else if(rb instanceof FormData){var up=new URLSearchParams();for(var pr of rb.entries())up.append(pr[0],pr[1]);body=up.toString();} else body=String(rb); }
  return wsBridge({url:url,method:method,headers:headers,body:body}).then(function(res){
    var bi; if(res.encoding==='base64'){var bn=atob(res.body||'');var bf=new Uint8Array(bn.length);for(var i=0;i<bn.length;i++)bf[i]=bn.charCodeAt(i);bi=bf.buffer;}else bi=res.body||'';
    var rh=Object.assign({'content-type':res.contentType||'text/plain'},res.resHeaders||{});
    delete rh['x-frame-options'];delete rh['content-security-policy'];
    return new Response(bi,{status:res.status,headers:rh});
  });
};

// ── XMLHttpRequest intercept ───────────────────────────────────────────────────
var _XHR=window.XMLHttpRequest;
function ProxyXHR(){
  var self=this,_m,_u,_rh={},_async=true,_st=0,_s=0,_st2='',_rt='',_ru='',_ls={},_eh={};
  Object.defineProperties(self,{readyState:{get:function(){return _st;}},status:{get:function(){return _s;}},statusText:{get:function(){return _st2;}},responseText:{get:function(){return _rt;}},response:{get:function(){return _rt;}},responseURL:{get:function(){return _ru;}},responseType:{get:function(){return '';},set:function(){}},timeout:{get:function(){return 0;},set:function(){}},withCredentials:{get:function(){return false;},set:function(){}}});
  ['onreadystatechange','onload','onerror','onprogress','onabort','ontimeout','onloadstart','onloadend'].forEach(function(ev){Object.defineProperty(self,ev,{get:function(){return _eh[ev];},set:function(fn){_eh[ev]=fn;}});});
  self.addEventListener=function(e,fn){if(!_ls[e])_ls[e]=[];_ls[e].push(fn);};
  self.removeEventListener=function(e,fn){if(_ls[e])_ls[e]=_ls[e].filter(function(f){return f!==fn;});};
  function fire(e,x){var ev=Object.assign({target:self,currentTarget:self,type:e,bubbles:false},x||{});(_ls[e]||[]).forEach(function(fn){try{fn.call(self,ev);}catch(ex){}});var h=_eh['on'+e];if(typeof h==='function')try{h.call(self,ev);}catch(ex){}}
  function ss(s){_st=s;fire('readystatechange');}
  self.open=function(m,u,a){_m=m;_u=resolve(u);_async=a!==false;ss(1);};
  self.setRequestHeader=function(k,v){_rh[k]=v;};
  self.getAllResponseHeaders=function(){return '';};
  self.getResponseHeader=function(){return null;};
  self.overrideMimeType=function(){};
  self.abort=function(){fire('abort');};
  self.send=function(body){
    if(!sameOrigin(_u)){
      var real=new _XHR();real.open(_m,_u,_async);Object.keys(_rh).forEach(function(k){real.setRequestHeader(k,_rh[k]);});
      real.onreadystatechange=function(){_st=real.readyState;_s=real.status;_st2=real.statusText;_rt=real.responseText||'';_ru=real.responseURL||'';fire('readystatechange');if(real.readyState===4){fire('load');fire('loadend');}};
      real.onerror=function(e){fire('error',e);};real.send(body);return;
    }
    if(OPTS.removeAds&&isAd(_u)){ss(4);_s=204;fire('load');fire('loadend');return;}
    var bstr=null;if(body){if(typeof body==='string')bstr=body;else if(body instanceof URLSearchParams)bstr=body.toString();else if(body instanceof FormData){var up=new URLSearchParams();for(var pr of body.entries())up.append(pr[0],pr[1]);bstr=up.toString();}else bstr=String(body);}
    wsBridge({url:_u,method:_m,headers:_rh,body:bstr})
      .then(function(res){_s=res.status;_st2='OK';_rt=(res.encoding==='base64')?atob(res.body||''):(res.body||'');_ru=_u;ss(2);ss(3);ss(4);fire('load');fire('loadend');})
      .catch(function(err){fire('error',{message:err.message});});
  };
  return self;
}
ProxyXHR.prototype=_XHR.prototype;
ProxyXHR.UNSENT=0;ProxyXHR.OPENED=1;ProxyXHR.HEADERS_RECEIVED=2;ProxyXHR.LOADING=3;ProxyXHR.DONE=4;
window.XMLHttpRequest=ProxyXHR;

// ── WebSocket url rewrite ─────────────────────────────────────────────────────
if(window.WebSocket){
  var _NWS=window.WebSocket;
  window.WebSocket=function(url,protos){
    try{var bw=BASE.replace(/^https?/,function(p){return p==='https'?'wss':'ws';});url=new URL(url,bw).href;}catch(e){}
    return new _NWS(url,protos);
  };
  window.WebSocket.prototype=_NWS.prototype;
  window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;
}

// ── Title sync ────────────────────────────────────────────────────────────────
try {
  var _td=Object.getOwnPropertyDescriptor(Document.prototype,'title');
  Object.defineProperty(document,'title',{get:function(){return _td.get.call(document);},set:function(v){_td.set.call(document,v);window.parent.postMessage({type:'ws-title',title:v},'*');},configurable:true});
} catch(e){}
window.addEventListener('load',function(){
  window.parent.postMessage({type:'ws-title',title:document.title},'*');
  window.parent.postMessage({type:'ws-loaded'},'*');
});
if(document.readyState!=='loading'){
  window.parent.postMessage({type:'ws-title',title:document.title},'*');
}

})();
</script>`;
}

// ── WebSocket server ───────────────────────────────────────────────────────────
const srv = http.createServer((req, res) => { res.writeHead(200); res.end('AH-Pro WS server'); });
const wss = new WebSocket.Server({ server: srv });

wss.on('connection', ws => {
  console.log('Client connected');
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMsg(ws, msg);
  });
  ws.on('close', () => console.log('Client disconnected'));
  ws.on('error', e => console.error('WS error:', e.message));
});

async function handleMsg(ws, msg) {
  const { id, type, url: targetUrl, method, headers: reqHeaders, body, options: opts = {} } = msg;

  if (!targetUrl) { ws.send(JSON.stringify({ id, type: 'error', message: 'No URL' })); return; }

  let url = targetUrl.trim();
  if (opts.forceHttps) url = url.replace(/^http:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  if (opts.removeAds && isAd(url)) {
    ws.send(JSON.stringify({ id, type: 'resource', url, status: 204, contentType: 'text/plain', body: '', encoding: 'utf8', blocked: true }));
    return;
  }

  console.log(`[${(method||'GET').toUpperCase()}] ${url}`);

  let result;
  try {
    result = await fetchUrl(url, { method: method || 'GET', blockCookies: opts.blockCookies, body: body || null, accept: type === 'page' ? 'text/html,*/*' : '*/*' });
  } catch (e) {
    console.error('  ERR:', e.message);
    ws.send(JSON.stringify({ id, type: 'error', message: e.message, url }));
    return;
  }

  const ct = (result.headers['content-type'] || '').toLowerCase();
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  const isCss  = ct.includes('text/css');
  const isText = isHtml || isCss || ct.includes('javascript') || ct.includes('json') || ct.includes('text/plain') || ct.includes('xml') || ct.includes('svg');

  console.log(`  ${result.status} [${ct.split(';')[0]}]`);

  if (isHtml && type === 'page') {
    let html = result.body.toString('utf8');
    html = rewriteHtml(html, result.finalUrl, opts);
    const script = buildInjectedScript(result.finalUrl, opts);
    if (/<head[\s>]/i.test(html)) html = html.replace(/(<head[\s>][^>]*>)/i, '$1\n' + script);
    else if (/<html[\s>]/i.test(html)) html = html.replace(/(<html[\s>][^>]*>)/i, '$1\n' + script);
    else html = script + '\n' + html;
    ws.send(JSON.stringify({ id, type: 'html', url: result.finalUrl, status: result.status, contentType: ct, body: html }));
  } else if (isCss) {
    // Rewrite CSS url() references so images inside CSS resolve correctly
    let css = result.body.toString('utf8');
    css = rewriteCss(css, result.finalUrl);
    ws.send(JSON.stringify({ id, type: 'resource', url: result.finalUrl, status: result.status, contentType: ct, body: css, encoding: 'utf8' }));
  } else if (isText) {
    ws.send(JSON.stringify({ id, type: 'resource', url: result.finalUrl, status: result.status, contentType: ct, body: result.body.toString('utf8'), encoding: 'utf8' }));
  } else {
    ws.send(JSON.stringify({ id, type: 'resource', url: result.finalUrl, status: result.status, contentType: ct, body: result.body.toString('base64'), encoding: 'base64' }));
  }
}

srv.listen(PORT, () => console.log(`\n👻 AH-Pro  ws://localhost:${PORT}\n   Open client.html in your browser\n`));
