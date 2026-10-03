// Builds a self-contained, interactive map of the vault (one HTML file, no external requests).
// Sent to the owner on WhatsApp by /graph; open it in any browser. Notes are dots, [[wikilinks]] are lines.
const fs = require('fs/promises');
const { files } = require('./vault');

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

async function collect() {
  const paths = await files.walk();
  const notes = [];
  for (const f of paths) {
    const [text, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const body = fm ? text.slice(fm[0].length) : text;
    const tags = new Set();
    const tl = fm && /^tags:\s*\[?(.*?)\]?\s*$/m.exec(fm[1]);
    if (tl) tl[1].split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean).forEach((t) => tags.add(t));
    for (const m of body.matchAll(/(?:^|\s)#([\w-]{2,30})\b/g)) tags.add(m[1]);
    const rel = files.rel(f);
    notes.push({
      id: notes.length, title: files.titleOf(f), path: rel,
      folder: rel.includes('/') ? rel.split('/')[0] : 'Root',
      tags: [...tags].slice(0, 6), words: body.split(/\s+/).filter(Boolean).length, mtime: st.mtimeMs,
      preview: body.replace(/^#.*\n+/, '').replace(/\[\[([^\]|#]+)[^\]]*\]\]/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 320),
      text: body,
    });
  }
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.id]));
  const seen = new Set();
  const links = [];
  for (const n of notes) {
    for (const m of n.text.matchAll(WIKILINK)) {
      const to = byTitle.get(m[1].trim().toLowerCase());
      const key = to != null && [Math.min(n.id, to), Math.max(n.id, to)].join('-');
      if (to != null && to !== n.id && !seen.has(key)) { seen.add(key); links.push([n.id, to]); }
    }
  }
  for (const n of notes) delete n.text;
  return { notes, links, generated: Date.now() };
}

async function build() {
  await files.pull();
  const data = await collect();
  const json = JSON.stringify(data).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join(' ').split(String.fromCharCode(0x2029)).join(' ');
  return { html: PAGE.replace('__DATA__', () => json), notes: data.notes.length, links: data.links.length };
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Second brain</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0b0e14;color:#dbe2f0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
canvas{position:fixed;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
.bar{position:fixed;top:12px;left:12px;right:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;pointer-events:none}
.bar>*{pointer-events:auto}
input{background:#141a26cc;border:1px solid #2a3550;color:#fff;border-radius:10px;padding:9px 12px;min-width:150px;flex:0 1 240px;outline:none;backdrop-filter:blur(8px)}
input:focus{border-color:#6ea8ff}
.chip{background:#141a26cc;border:1px solid #2a3550;border-radius:999px;padding:5px 11px;font-size:12px;color:#9fb0cf;backdrop-filter:blur(8px)}
.legend{position:fixed;left:12px;bottom:12px;max-width:46vw;display:flex;flex-wrap:wrap;gap:6px}
.legend button{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;background:#141a26cc;border:1px solid #2a3550;border-radius:999px;padding:4px 10px;font-size:12px;backdrop-filter:blur(8px)}
.legend button.off{opacity:.35}.dot{width:9px;height:9px;border-radius:50%}
#panel{position:fixed;top:0;right:0;width:min(340px,86vw);height:100%;background:#0f1420f2;border-left:1px solid #2a3550;padding:18px;transform:translateX(100%);transition:transform .2s;overflow:auto;backdrop-filter:blur(10px)}
#panel.open{transform:none}#panel h2{margin:0 26px 4px 0;font-size:18px}#panel .meta{color:#7e8db0;font-size:12px;margin-bottom:10px}
#panel p{color:#c3cde2;white-space:pre-wrap}#panel h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7e8db0;margin:16px 0 6px}
#panel a{display:block;color:#8fbaff;padding:3px 0;cursor:pointer;text-decoration:none}
#x{position:absolute;top:12px;right:14px;cursor:pointer;color:#7e8db0;font-size:20px}
.tag{display:inline-block;background:#1b2438;border-radius:6px;padding:1px 7px;margin:0 4px 4px 0;font-size:12px;color:#9fb0cf}
#tip{position:fixed;pointer-events:none;background:#000c;border:1px solid #2a3550;border-radius:8px;padding:4px 9px;font-size:12px;display:none;white-space:nowrap}
#empty{position:fixed;inset:0;display:none;align-items:center;justify-content:center;color:#7e8db0;text-align:center;padding:30px}
</style></head><body>
<canvas id="c"></canvas>
<div class="bar"><input id="q" placeholder="Search notes..." autocomplete="off"><span class="chip" id="stats"></span><span class="chip" id="when"></span></div>
<div class="legend" id="legend"></div>
<div id="panel"><span id="x">&times;</span><div id="pc"></div></div>
<div id="tip"></div><div id="empty">No notes yet.<br>Tell the bot to save one and run /graph again.</div>
<script>
var D=__DATA__;
var N=D.notes,L=D.links,cv=document.getElementById('c'),cx=cv.getContext('2d'),dpr=window.devicePixelRatio||1,W,H;
var deg=N.map(function(){return 0}),adj=N.map(function(){return []});
L.forEach(function(l){deg[l[0]]++;deg[l[1]]++;adj[l[0]].push(l[1]);adj[l[1]].push(l[0])});
var folders=[],fi={};N.forEach(function(n){if(!(n.folder in fi)){fi[n.folder]=folders.length;folders.push(n.folder)}});
function hue(i){return (i*137.508+210)%360}
function col(n,a){return 'hsla('+hue(fi[n.folder])+',75%,'+(62)+'%,'+(a==null?1:a)+')'}
var hidden={},sel=-1,hov=-1,query='',now=Date.now();
var cam={x:0,y:0,k:1};
N.forEach(function(n,i){var a=Math.random()*6.283,r=60+Math.random()*160;n.x=Math.cos(a)*r;n.y=Math.sin(a)*r;n.vx=0;n.vy=0;n.r=4+Math.min(14,Math.sqrt(deg[i])*3.2+Math.sqrt(n.words)*0.18);n.fixed=false});
document.getElementById('stats').textContent=N.length+' notes · '+L.length+' links · '+folders.length+' folders';
document.getElementById('when').textContent='as of '+new Date(D.generated).toLocaleString();
if(!N.length)document.getElementById('empty').style.display='flex';
var lg=document.getElementById('legend');
folders.forEach(function(f){var b=document.createElement('button');b.innerHTML='<span class="dot" style="background:hsl('+hue(fi[f])+',75%,62%)"></span>'+f.replace(/</g,'&lt;')+' ('+N.filter(function(n){return n.folder===f}).length+')';
b.onclick=function(){hidden[f]=!hidden[f];b.className=hidden[f]?'off':'';alpha=Math.max(alpha,.3)};lg.appendChild(b)});
function resize(){W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr}resize();addEventListener('resize',resize);
var alpha=1;
function step(){
  var n=N.length,i,j,a,b,dx,dy,d2,d,f;
  for(i=0;i<n;i++){a=N[i];for(j=i+1;j<n;j++){b=N[j];dx=a.x-b.x;dy=a.y-b.y;d2=dx*dx+dy*dy;if(d2>90000)continue;if(d2<1){dx=Math.random()-.5;dy=Math.random()-.5;d2=1}
    f=(2600/d2)*alpha;d=Math.sqrt(d2);dx=dx/d*f;dy=dy/d*f;a.vx+=dx;a.vy+=dy;b.vx-=dx;b.vy-=dy}}
  L.forEach(function(l){a=N[l[0]];b=N[l[1]];dx=b.x-a.x;dy=b.y-a.y;d=Math.sqrt(dx*dx+dy*dy)||1;f=(d-90)*0.02*alpha;dx=dx/d*f;dy=dy/d*f;a.vx+=dx;a.vy+=dy;b.vx-=dx;b.vy-=dy});
  var cen={};N.forEach(function(a){var c=cen[a.folder]||(cen[a.folder]={x:0,y:0,n:0});c.x+=a.x;c.y+=a.y;c.n++});
  N.forEach(function(a){var c=cen[a.folder];a.vx+=(c.x/c.n-a.x)*0.004*alpha-a.x*0.0016;a.vy+=(c.y/c.n-a.y)*0.004*alpha-a.y*0.0016});
  N.forEach(function(a){if(a.fixed){a.vx=a.vy=0;return}a.vx*=0.82;a.vy*=0.82;a.x+=a.vx;a.y+=a.vy});
  alpha=Math.max(alpha*0.992,0.02);
}
function vis(n){return !hidden[n.folder]}
function match(n){return !query||n.title.toLowerCase().indexOf(query)>=0||n.tags.join(' ').toLowerCase().indexOf(query)>=0||n.preview.toLowerCase().indexOf(query)>=0}
function focusSet(){var s={};if(sel>=0){s[sel]=1;adj[sel].forEach(function(k){s[k]=1})}else if(hov>=0){s[hov]=1;adj[hov].forEach(function(k){s[k]=1})}return s}
function draw(){
  cx.setTransform(dpr,0,0,dpr,0,0);cx.clearRect(0,0,W,H);
  var g=cx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.max(W,H)*.7);g.addColorStop(0,'#121a2b');g.addColorStop(1,'#0b0e14');cx.fillStyle=g;cx.fillRect(0,0,W,H);
  cx.translate(W/2+cam.x,H/2+cam.y);cx.scale(cam.k,cam.k);
  var fs=focusSet(),has=sel>=0||hov>=0;
  L.forEach(function(l){var a=N[l[0]],b=N[l[1]];if(!vis(a)||!vis(b))return;var on=has&&fs[l[0]]&&fs[l[1]]&&(l[0]===(sel>=0?sel:hov)||l[1]===(sel>=0?sel:hov));
    cx.strokeStyle=on?'rgba(160,200,255,.9)':(has?'rgba(120,140,180,.07)':'rgba(120,150,200,.22)');cx.lineWidth=(on?1.8:1)/cam.k;cx.beginPath();cx.moveTo(a.x,a.y);cx.lineTo(b.x,b.y);cx.stroke()});
  N.forEach(function(n,i){if(!vis(n))return;var dim=(has&&!fs[i])||!match(n);
    cx.globalAlpha=dim?.16:1;
    if(!dim){cx.shadowColor=col(n,.9);cx.shadowBlur=(i===sel||i===hov?26:10)}
    cx.fillStyle=col(n);cx.beginPath();cx.arc(n.x,n.y,n.r,0,6.283);cx.fill();cx.shadowBlur=0;
    if(i===sel){cx.strokeStyle='#fff';cx.lineWidth=2/cam.k;cx.stroke()}
    cx.globalAlpha=1});
  cx.font=(12/Math.max(cam.k,.6))+'px system-ui';cx.textAlign='center';
  N.forEach(function(n,i){if(!vis(n))return;var show=i===sel||i===hov||(fs[i]&&has)||(query&&match(n))||(cam.k>0.9&&n.r>7)||cam.k>1.6;if(!show)return;
    if(!match(n)&&!(i===sel||i===hov))return;cx.fillStyle='#e8eefc';cx.fillText(n.title.length>28?n.title.slice(0,27)+'…':n.title,n.x,n.y+n.r+13/cam.k)})
}
function loop(){step();draw();requestAnimationFrame(loop)}loop();
function toWorld(px,py){return {x:(px-W/2-cam.x)/cam.k,y:(py-H/2-cam.y)/cam.k}}
function pick(px,py){var w=toWorld(px,py),best=-1,bd=1e9;N.forEach(function(n,i){if(!vis(n))return;var dx=n.x-w.x,dy=n.y-w.y,d=Math.sqrt(dx*dx+dy*dy);if(d<n.r+6/cam.k&&d<bd){bd=d;best=i}});return best}
var drag=-1,pan=false,last=null,moved=0,pts={},pinch=0;
cv.addEventListener('pointerdown',function(e){cv.setPointerCapture(e.pointerId);pts[e.pointerId]=[e.clientX,e.clientY];last=[e.clientX,e.clientY];moved=0;
  if(Object.keys(pts).length===2){var p=Object.values(pts);pinch=Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]);drag=-1;return}
  drag=pick(e.clientX,e.clientY);if(drag>=0){N[drag].fixed=true;alpha=Math.max(alpha,.25)}else pan=true;cv.style.cursor='grabbing'});
cv.addEventListener('pointermove',function(e){
  if(pts[e.pointerId])pts[e.pointerId]=[e.clientX,e.clientY];
  if(Object.keys(pts).length===2){var p=Object.values(pts),d=Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]);if(pinch){zoom(d/pinch,(p[0][0]+p[1][0])/2,(p[0][1]+p[1][1])/2)}pinch=d;return}
  if(drag>=0){var w=toWorld(e.clientX,e.clientY);N[drag].x=w.x;N[drag].y=w.y;moved+=1;alpha=Math.max(alpha,.2)}
  else if(pan&&last){cam.x+=e.clientX-last[0];cam.y+=e.clientY-last[1];moved+=1}
  else{var h=pick(e.clientX,e.clientY);if(h!==hov){hov=h}var t=document.getElementById('tip');if(h>=0){t.style.display='block';t.style.left=(e.clientX+14)+'px';t.style.top=(e.clientY+14)+'px';t.textContent=N[h].title+' · '+N[h].folder}else t.style.display='none'}
  last=[e.clientX,e.clientY]});
function up(e){delete pts[e.pointerId];pinch=0;cv.style.cursor='grab';
  if(drag>=0){N[drag].fixed=false;if(moved<4)select(drag)}else if(pan&&moved<4){select(-1)}drag=-1;pan=false}
cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
function zoom(f,px,py){var k=Math.min(4,Math.max(.15,cam.k*f)),r=k/cam.k,ox=px-W/2,oy=py-H/2;cam.x=ox-(ox-cam.x)*r;cam.y=oy-(oy-cam.y)*r;cam.k=k}
cv.addEventListener('wheel',function(e){e.preventDefault();zoom(e.deltaY<0?1.12:.89,e.clientX,e.clientY)},{passive:false});
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function select(i){sel=i;var p=document.getElementById('panel');if(i<0){p.className='';return}
  var n=N[i];var h='<h2>'+esc(n.title)+'</h2><div class="meta">'+esc(n.path)+' · '+n.words+' words · edited '+new Date(n.mtime).toLocaleDateString()+'</div>';
  if(n.tags.length)h+=n.tags.map(function(t){return '<span class="tag">#'+esc(t)+'</span>'}).join('');
  h+='<p>'+esc(n.preview||'(empty)')+'</p>';
  if(adj[i].length){h+='<h3>Linked notes ('+adj[i].length+')</h3>'+adj[i].map(function(k){return '<a data-k="'+k+'">'+esc(N[k].title)+'</a>'}).join('')}
  else h+='<h3>No links yet</h3><p style="color:#7e8db0">Link notes with [[Note Title]] and they connect here.</p>';
  document.getElementById('pc').innerHTML=h;p.className='open'}
document.getElementById('pc').addEventListener('click',function(e){var k=e.target.getAttribute&&e.target.getAttribute('data-k');if(k!=null){select(+k);cam.x=-N[+k].x*cam.k;cam.y=-N[+k].y*cam.k}});
document.getElementById('x').onclick=function(){select(-1)};
document.getElementById('q').addEventListener('input',function(e){query=e.target.value.trim().toLowerCase()});
</script></body></html>`;

module.exports = { build };
