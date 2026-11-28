/*
 * Repertoire trainer, ported from the standalone Repertoire Trainer page.
 * Spaced-repetition drilling of an imported opening repertoire, a study
 * tree with notes and stored engine lines, free analysis and play against
 * the bundled Stockfish 19 Lite, and progress stats.
 *
 * The repertoire data arrives at runtime from the user's own import file
 * (see main.js); none of it is part of the app bundle.
 */
import { Chess } from 'chess.js';
import { PIECE_SVG } from '../chess/pieces.js';
import { encodeMoveLine } from '../chess/shareUrl.js';
import { MIN, HOUR, DAY, cardStatus, gradeRecord, learnRecord } from './model.js';
import { PREP_DRILL_STORAGE_KEY } from './opponentPrep.js';

const STOCKFISH_MT_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite.js`;
const STOCKFISH_ST_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Piece images as data URIs, keyed by FEN letter, from tichess's own set. */
const PIECES = {};
for (const [k, svg] of Object.entries(PIECE_SVG)) {
  const letter = k[0] === 'w' ? k[1] : k[1].toLowerCase();
  PIECES[letter] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
}

export function startTrainer({ data: D, progress, saveProgress }) {
  const $ = id => document.getElementById(id);
  const POS=D.pos, LINES=D.lines, SECS=D.secs, CARDS=D.cards, WARN=D.warn||{}, TH=D.theory;
  const esc = s => String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const now = () => Date.now();
  const dayKey = t => { const d=new Date(t); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };

  /* ---------- settings (per browser) ---------- */
  const SET={sound:true,notes:true,coords:true};
  try{ Object.assign(SET, JSON.parse(localStorage.getItem("rt2-set")||"{}")); }catch(_){}
  function saveSet(){ try{ localStorage.setItem("rt2-set",JSON.stringify(SET)); }catch(_){} }

  /* ---------- derived structures ---------- */
  const meIdx = ln => ln.color==="w" ? 0 : 1;
  function edgeAt(ln,p){ return POS[ln.pos[p]].e.find(e=>e[0]===ln.uci[p]); }
  function cardAt(ln,p){ const e=edgeAt(ln,p); return e && e[5]; }
  LINES.forEach((ln,i)=>{ ln.i=i; ln.cards=[]; for(let p=meIdx(ln);p<ln.uci.length;p+=2) ln.cards.push({p,c:cardAt(ln,p)}); });
  const SECBY={}; SECS.forEach(s=>SECBY[s.id]=s);
  const CARD_LINES={}; LINES.forEach(ln=>ln.cards.forEach(x=>{ (CARD_LINES[x.c]=CARD_LINES[x.c]||[]).push(ln.i); }));
  const CARD_SEC={}; Object.keys(CARD_LINES).forEach(c=>CARD_SEC[c]=LINES[CARD_LINES[c][0]].sec);
  const ALLCARDS=Object.keys(CARDS);
  // cards reachable below each position (for weighting random play)
  const SUB={};
  function subCards(pi){
    if(SUB[pi]) return SUB[pi];
    const s=new Set(); SUB[pi]=s;
    for(const e of POS[pi].e){ if(e[5]) s.add(e[5]); subCards(e[2]).forEach(c=>s.add(c)); }
    return s;
  }
  function plyOfFen(f){ const p=f.split(" "); return (parseInt(p[5],10)-1)*2+(p[1]==="b"?1:0); }
  function moveNo(ply){ return Math.floor(ply/2)+1+(ply%2?"...":"."); }
  function fmtEv(e){ if(e===null||e===undefined) return "–"; if(typeof e==="string") return esc(e.replace("#-","−#")); const v=Math.abs(e)<0.05?0:e; return (v>0?"+":v<0?"−":"")+Math.abs(v).toFixed(1); }
  function evNeg(e){ return typeof e==="string" ? e.startsWith("#-") : e<-0.05; }
  function evNum(e){ return typeof e==="string" ? (e.startsWith("#-")?-50:50) : e; }
  function fmtPv(pv,ply){ const out=[]; let p=ply; pv.forEach((m,k)=>{ if(p%2===0) out.push('<span class="n">'+(Math.floor(p/2)+1)+'.</span>'+esc(m)); else out.push((k===0?'<span class="n">'+(Math.floor(p/2)+1)+'...</span>':'')+esc(m)); p++; }); return out.join(" "); }
  function openingName(pi){ const t=TH[POS[pi].t]; return t&&t.name ? t.name : null; }
  function lineLabel(ln){ return ln.id+" · "+ln.name; }

  /* ---------- sound ---------- */
  const Snd={ctx:null,
    unlock(){ if(this.ctx){ if(this.ctx.state==="suspended") this.ctx.resume().catch(()=>{}); return; } try{ const C=window.AudioContext||window.webkitAudioContext; if(C) this.ctx=new C(); }catch(_){} },
    play(kind){ if(!SET.sound||!this.ctx) return; try{
      const c=this.ctx, t=c.currentTime, len=kind==="capture"?0.09:0.05;
      const buf=c.createBuffer(1,Math.floor(c.sampleRate*len),c.sampleRate), d=buf.getChannelData(0);
      for(let i=0;i<d.length;i++){ d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,kind==="capture"?2:3.5); }
      const src=c.createBufferSource(); src.buffer=buf;
      const f=c.createBiquadFilter(); f.type="bandpass"; f.frequency.value=kind==="capture"?900:kind==="err"?220:1500; f.Q.value=kind==="err"?2:0.9;
      const g=c.createGain(); g.gain.value=kind==="capture"?0.9:kind==="err"?0.7:0.6;
      src.connect(f); f.connect(g); g.connect(c.destination); src.start(t);
      if(kind==="ok"){ const o=c.createOscillator(), og=c.createGain(); o.frequency.value=880; og.gain.setValueAtTime(0.08,t); og.gain.exponentialRampToValueAtTime(0.0001,t+0.18); o.connect(og); og.connect(c.destination); o.start(t); o.stop(t+0.2); }
    }catch(_){} } };
  document.addEventListener("pointerdown",()=>Snd.unlock(),{once:false,passive:true});

  /* ---------- board ---------- */
  class Board{
    constructor(el){
      this.el=el; el.classList.add("cb");
      el.innerHTML='<div class="sqs"></div><div class="pcs"></div><svg class="arrows" viewBox="0 0 800 800" aria-hidden="true"><defs><marker id="ah-'+el.id+'" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs><g></g></svg>';
      this.sqEl={}; this.pcEl={}; this.orient="w"; this.fen=null; this.sel=null; this.marks={};
      this.movable=()=>false; this.onMove=null; this.dests=()=>[];
      this.buildSquares();
      // Stop the page (and the app around it) from scrolling or bouncing while a finger is on the board.
      const stop=e=>{ if(e.cancelable) e.preventDefault(); };
      el.addEventListener("touchstart",stop,{passive:false});
      el.addEventListener("touchmove",stop,{passive:false});
      el.addEventListener("contextmenu",stop);
      el.addEventListener("pointerdown",e=>this.down(e));
      el.addEventListener("pointermove",e=>this.moveP(e));
      el.addEventListener("pointerup",e=>this.up(e));
      el.addEventListener("pointercancel",e=>this.cancel(e));
    }
    buildSquares(){
      const sqs=this.el.querySelector(".sqs"); sqs.innerHTML=""; this.sqEl={};
      for(let row=0;row<8;row++) for(let col=0;col<8;col++){
        const f=this.orient==="w"?col:7-col, r=this.orient==="w"?8-row:row+1, sq="abcdefgh"[f]+r;
        const d=document.createElement("div"); d.className="sq "+((f+r)%2?"l":"d"); d.dataset.sq=sq;
        if(SET.coords){
          if(row===7){ const c=document.createElement("span"); c.className="co f"; c.textContent="abcdefgh"[f]; d.appendChild(c); }
          if(col===7){ const c=document.createElement("span"); c.className="co r"; c.textContent=r; d.appendChild(c); }
        }
        sqs.appendChild(d); this.sqEl[sq]=d;
      }
    }
    setOrient(o){ if(o===this.orient) return; this.orient=o; this.buildSquares(); const f=this.fen; this.fen=null; Object.values(this.pcEl).forEach(p=>p.remove()); this.pcEl={}; if(f) this.set(f,{last:this.last,anim:false}); }
    xy(sq){ const f=sq.charCodeAt(0)-97, r=+sq[1]; return this.orient==="w"?[f,8-r]:[7-f,r-1]; }
    place(el,sq){ const [x,y]=this.xy(sq); el.style.transform="translate("+(x*100)+"%,"+(y*100)+"%)"; }
    parse(fen){ const m={}; const rows=fen.split(" ")[0].split("/"); for(let r=0;r<8;r++){ let c=0; for(const ch of rows[r]){ if(/\d/.test(ch)) c+=+ch; else { m["abcdefgh"[c]+(8-r)]=ch; c++; } } } return m; }
    set(fen,opt={}){
      const hadFen=this.fen!==null, anim=opt.anim!==false && hadFen;
      const next=this.parse(fen), layer=this.el.querySelector(".pcs");
      const old=this.pcEl, keep={}, vac=[];
      for(const sq in old){ if(next[sq]===old[sq].dataset.p) keep[sq]=old[sq]; else vac.push(sq); }
      const arrive=Object.keys(next).filter(sq=>!keep[sq]);
      const used=new Set(), res={...keep}; let captured=false;
      for(const sq of arrive){
        const p=next[sq]; let best=null, bd=99;
        for(const v of vac){ if(used.has(v)||old[v].dataset.p!==p) continue; const a=this.xy(v), b=this.xy(sq), d=Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]); if(d<bd){bd=d;best=v;} }
        let el;
        if(best){ used.add(best); el=old[best]; }
        else { el=document.createElement("div"); el.className="pc"; el.dataset.p=p; el.style.backgroundImage="url('"+PIECES[p]+"')"; el.style.transition="none"; this.place(el,sq); layer.appendChild(el); void el.offsetWidth; el.style.transition=""; }
        if(!anim) el.style.transition="none";
        this.place(el,sq); res[sq]=el;
        if(!anim) { void el.offsetWidth; el.style.transition=""; }
      }
      for(const v of vac){ if(!used.has(v)){ const el=old[v]; captured=true; if(anim){ el.classList.add("gone"); setTimeout(()=>el.remove(),220); } else el.remove(); } }
      this.pcEl=res; this.fen=fen;
      for(const sq in res) res[sq].classList.remove("lift","drag");
      this.last=opt.last||null; this.sel=null;
      this.paint();
      if(hadFen && opt.sound!==false && opt.last) Snd.play(captured?"capture":"move");
    }
    paint(){
      const dests=this.sel?this.dests(this.sel):[];
      for(const sq in this.sqEl){
        const d=this.sqEl[sq], cls=["sq",d.classList.contains("l")?"l":"d"];
        if(this.last&&this.last.includes(sq)) cls.push("last");
        if(this.sel===sq) cls.push("sel");
        if(dests.includes(sq)){ cls.push("dest"); if(this.pcEl[sq]) cls.push("occ"); }
        if(this.marks[sq]) cls.push(this.marks[sq]);
        d.className=cls.join(" ");
      }
    }
    mark(sq,cls){ if(cls) this.marks[sq]=cls; else delete this.marks[sq]; this.paint(); }
    clearMarks(){ this.marks={}; this.paint(); }
    arrow(from,to,color,opt={}){
      const col=color||"#15781b", defs=this.el.querySelector("svg defs"), g=this.el.querySelector("svg g"), c=xy=>[xy[0]*100+50,xy[1]*100+50];
      const mid="ah-"+this.el.id+"-"+col.replace(/[^a-zA-Z0-9]/g,"");
      if(defs && !defs.querySelector("#"+mid)){
        const mk=document.createElementNS("http://www.w3.org/2000/svg","marker");
        mk.setAttribute("id",mid); mk.setAttribute("viewBox","0 0 10 10"); mk.setAttribute("refX","5"); mk.setAttribute("refY","5");
        mk.setAttribute("markerWidth","3.2"); mk.setAttribute("markerHeight","3.2"); mk.setAttribute("orient","auto");
        const p=document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d","M0,0 L10,5 L0,10 z"); p.setAttribute("fill",col); mk.appendChild(p); defs.appendChild(mk);
      }
      const a=c(this.xy(from)), b=c(this.xy(to)), dx=b[0]-a[0], dy=b[1]-a[1], len=Math.hypot(dx,dy);
      if(!len) return;
      const k=(len-28)/len;
      const ln=document.createElementNS("http://www.w3.org/2000/svg","line");
      ln.setAttribute("x1",a[0]); ln.setAttribute("y1",a[1]); ln.setAttribute("x2",a[0]+dx*k); ln.setAttribute("y2",a[1]+dy*k);
      ln.setAttribute("stroke",col); ln.setAttribute("stroke-width",String(opt.width||20)); ln.setAttribute("stroke-linecap","round");
      ln.setAttribute("opacity",String(opt.opacity||0.82));
      if(opt.dashed) ln.setAttribute("stroke-dasharray","26 16");
      ln.setAttribute("marker-end","url(#"+mid+")"); g.appendChild(ln);
    }
    clearArrows(){ this.el.querySelector("svg g").innerHTML=""; }
    shake(){ this.el.classList.remove("shake"); void this.el.offsetWidth; this.el.classList.add("shake"); }
    sqAt(x,y){ const r=this.el.getBoundingClientRect(); const cx=Math.floor((x-r.left)/r.width*8), cy=Math.floor((y-r.top)/r.height*8); if(cx<0||cx>7||cy<0||cy>7) return null; const f=this.orient==="w"?cx:7-cx, rk=this.orient==="w"?8-cy:cy+1; return "abcdefgh"[f]+rk; }
    down(e){
      const sq=this.sqAt(e.clientX,e.clientY); if(!sq) return;
      if(this.movable(sq)){
        e.preventDefault();
        const wasSel=this.sel===sq; this.sel=sq; this.paint();
        const r=this.el.getBoundingClientRect();
        this.drag={from:sq,x0:e.clientX,y0:e.clientY,moved:false,wasSel,size:r.width/8,id:e.pointerId};
        try{ this.el.setPointerCapture(e.pointerId); }catch(_){}
      } else if(this.sel){
        e.preventDefault(); const from=this.sel; this.sel=null; this.paint();
        if(this.dests(from).includes(sq)) this.onMove&&this.onMove(from,sq);
      }
    }
    moveP(e){
      const d=this.drag; if(!d||e.pointerId!==d.id) return;
      if(!d.moved && Math.hypot(e.clientX-d.x0,e.clientY-d.y0)<6) return;
      const el=this.pcEl[d.from]; if(!el) return;
      if(!d.moved){ d.moved=true; el.classList.add("drag"); }
      const r=this.el.getBoundingClientRect();
      el.style.transform="translate("+(e.clientX-r.left-d.size/2)+"px,"+(e.clientY-r.top-d.size/2)+"px)";
      const over=this.sqAt(e.clientX,e.clientY);
      if(over!==d.over){ d.over=over; for(const s in this.sqEl) this.sqEl[s].classList.remove("over"); if(over&&this.dests(d.from).includes(over)) this.sqEl[over].classList.add("over"); }
    }
    up(e){
      const d=this.drag; if(!d||e.pointerId!==d.id) return; this.drag=null;
      for(const s in this.sqEl) this.sqEl[s].classList.remove("over");
      const el=this.pcEl[d.from];
      if(!d.moved){ if(d.wasSel){ this.sel=null; this.paint(); } return; }
      const to=this.sqAt(e.clientX,e.clientY);
      const ok=to&&to!==d.from&&this.dests(d.from).includes(to);
      if(el){ el.classList.remove("drag"); if(!ok) this.place(el,d.from); }
      if(!ok) return;
      this.sel=null; this.paint();
      this.onMove&&this.onMove(d.from,to,true);
    }
    cancel(){ const d=this.drag; this.drag=null; if(d&&this.pcEl[d.from]){ const el=this.pcEl[d.from]; el.classList.remove("drag"); this.place(el,d.from); } }
  }
  function chessDests(fen){ return sq=>{ try{ const g=new Chess(fen); return [...new Set(g.moves({square:sq,verbose:true}).map(m=>m.to))]; }catch(_){ return []; } }; }
  function sideToMove(fen){ return fen.split(" ")[1]; }
  function ownPiece(fen,board){ const w=sideToMove(fen)==="w"; return sq=>{ const p=board.pcEl[sq]&&board.pcEl[sq].dataset.p; return !!p && (w? p===p.toUpperCase() : p===p.toLowerCase()); }; }
  function tryMove(fen,from,to,promo){ try{ const g=new Chess(fen); const m=g.move({from,to,promotion:promo||"q"}); if(!m) return null; return {m, fen:g.fen(), uci:from+to+(m.promotion||"")}; }catch(_){ return null; } }
  function checkSq(fen){ try{ const g=new Chess(fen); if(!g.inCheck()) return null; const b=g.board(); for(let r=0;r<8;r++) for(let f=0;f<8;f++){ const p=b[r][f]; if(p&&p.type==="k"&&p.color===g.turn()) return "abcdefgh"[f]+(8-r); } }catch(_){} return null; }

  /* ---------- progress store (this browser only) ---------- */
  let prog=progress||{};  // cardId -> {b,d,r,l,t,s}; plus "days"
  const clone=o=>JSON.parse(JSON.stringify(o));
  function setSync(t){ $("sync").textContent=t; }
  function saveLocal(){ setSync(saveProgress(prog)?"Saved in this browser":"Could not save progress in this browser"); }
  function persist(){ saveLocal(); }
  function status(c){ return cardStatus(prog[c],now()); }
  function grade(c,ok){ prog[c]=gradeRecord(prog[c],ok,now()); persist(c); bumpDay(ok); }
  function learnCard(c){ const r=learnRecord(prog[c],now()); if(r===prog[c]) return; prog[c]=r; persist(c); }
  function bumpDay(ok){ const k=dayKey(now()); const d=prog.days?clone(prog.days):{t:0,d:{}}; const x=d.d[k]||{n:0,ok:0}; x.n++; if(ok) x.ok++; d.d[k]=x; d.t=now();
    const keys=Object.keys(d.d).sort(); while(keys.length>60) delete d.d[keys.shift()]; prog.days=d; saveLocal(); }
  function flushDays(){}
  function initStore(){ setSync("Saved in this browser"); refreshAll(); }

  /* ---------- counts ---------- */
  function counts(cards){ const c={new:0,due:0,learning:0,mastered:0}; cards.forEach(x=>c[status(x)]++); return c; }
  function secCards(sid){ return ALLCARDS.filter(c=>CARD_SEC[c]===sid); }
  function barHtml(c,total){ return ["d","l","m"].map(k=>{ const v=k==="d"?c.due:k==="l"?c.learning:c.mastered; return v?'<i class="b-'+k+'" style="width:'+(100*v/total)+'%"></i>':""; }).join(""); }
  function nextLearnLine(sid){
    const order = sid ? LINES.filter(l=>l.sec===sid) : LINES;
    // prefer non-alt lines, then alt
    const cands=[...order.filter(l=>!l.alt),...order.filter(l=>l.alt)];
    return cands.find(l=>l.cards.some(x=>status(x.c)==="new")) || null;
  }

  /* ---------- mobile board pin ---------- */
  let repBoardPinned=true;
  try{ const p=localStorage.getItem("rt2-pin-board"); if(p==="0"||p==="false") repBoardPinned=false; }catch(_){}
  function applyRepPin(){
    document.body.classList.toggle("rep-board-pinned",repBoardPinned);
    document.querySelectorAll("[data-rep-pin]").forEach(btn=>{
      btn.setAttribute("aria-pressed",String(repBoardPinned));
      btn.classList.toggle("is-on",repBoardPinned);
      btn.title=repBoardPinned?"Board fixed at top while scrolling — tap to unpin":"Fix board at top while scrolling";
      const sp=btn.querySelector("span"); if(sp) sp.textContent=repBoardPinned?"Pinned":"Pin";
    });
  }
  document.querySelectorAll("[data-rep-pin]").forEach(btn=>{
    btn.onclick=()=>{ repBoardPinned=!repBoardPinned; applyRepPin(); try{ localStorage.setItem("rt2-pin-board",repBoardPinned?"1":"0"); }catch(_){} };
  });
  applyRepPin();

  /* ---------- tabs ---------- */
  let tab="train";
  function setTab(t){
    tab=t;
    if(!S) document.body.style.overflow="";
    document.body.classList.toggle("rep-has-board",t==="study"||t==="explore");
    document.querySelectorAll("[data-tab]").forEach(b=>b.setAttribute("aria-current",b.dataset.tab===t?"page":"false"));
    ["train","study","explore","stats"].forEach(v=>$("v-"+v).hidden=v!==t);
    if(t!=="explore") engStop(); else { engInit(); renderExplore(); }
    if(t==="study") renderStudy();
    if(t==="train") renderTrain();
    if(t==="stats") renderStats();
    try{ localStorage.setItem("rt2-tab",t); }catch(_){}
    window.scrollTo({top:0});
  }
  document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  function refreshAll(){ if(tab==="train") renderTrain(); if(tab==="stats") renderStats(); if(tab==="study") renderStudyTree(); }

  /* ---------- TRAIN home ---------- */
  let learnSec=null, playSec="B";
  try{ const s=JSON.parse(localStorage.getItem("rt2-train")||"{}"); learnSec=s.learnSec||null; playSec=s.playSec||"A"; }catch(_){}
  function saveTrain(){ try{ localStorage.setItem("rt2-train",JSON.stringify({learnSec,playSec})); }catch(_){} }
  function secChips(el,sel,onPick,withAll,countFn){
    el.innerHTML="";
    const mk=(id,label,n)=>{ const b=document.createElement("button"); b.className="chip"; b.setAttribute("aria-pressed",sel===id); b.innerHTML=esc(label)+(n!==undefined&&n!==null?'<span class="n">'+n+'</span>':""); b.onclick=()=>onPick(id); el.appendChild(b); };
    if(withAll) mk(null,"Any opening",null);
    SECS.forEach(s=>mk(s.id,(s.color==="w"?"♙ ":"♟ ")+s.name,countFn?countFn(s.id):null));
  }
  function renderTrain(){
    const c=counts(ALLCARDS);
    $("h-due").textContent=c.due; $("h-due-l").textContent=c.due===1?"move":"moves";
    const nextDue=ALLCARDS.map(x=>prog[x]).filter(r=>r&&r.s&&r.d>now()).map(r=>r.d).sort((a,b)=>a-b)[0];
    const todayN=((prog.days&&prog.days.d[dayKey(now())])||{n:0}).n;
    $("h-stats").innerHTML='<span><b>'+(c.learning+c.mastered+c.due)+'</b> of '+ALLCARDS.length+' moves learned</span><span><b>'+c.mastered+'</b> mastered</span><span><b>'+todayN+'</b> trained today</span>'+(c.due===0&&nextDue?'<span>next review '+esc(relTime(nextDue))+'</span>':"");
    $("b-review").hidden=c.due===0; $("b-learn2").hidden=c.due>0||c.new===0;
    // activity
    const act=$("h-act"); act.innerHTML=""; const days=(prog.days&&prog.days.d)||{}; let mx=1; const arr=[];
    for(let i=13;i>=0;i--){ const k=dayKey(now()-i*DAY); const n=(days[k]||{n:0}).n; arr.push([k,n,i]); mx=Math.max(mx,n); }
    arr.forEach(([k,n,i])=>{ const b=document.createElement("i"); if(n) b.className="on"; if(i===0) b.classList.add("today"); b.style.height=(n?Math.max(6,34*n/mx):4)+"px"; b.title=k+": "+n+" moves"; act.appendChild(b); });
    // learn
    const nl=nextLearnLine(learnSec);
    secChips($("l-secs"),learnSec,id=>{ learnSec=id; saveTrain(); renderTrain(); },true,id=>counts(secCards(id)).new||null);
    if(nl){ const nNew=nl.cards.filter(x=>status(x.c)==="new").length; $("l-next").textContent=lineLabel(nl); $("l-desc").textContent=nNew+" new move"+(nNew>1?"s":"")+" in this line. You see each one with its explanation, then play the line from memory."; $("b-learn").disabled=false; }
    else { $("l-next").textContent="All learned"; $("l-desc").textContent=learnSec?"Every move in this opening has been introduced. Pick another opening or review.":"Every move in your repertoire has been introduced."; $("b-learn").disabled=true; }
    secChips($("p-secs"),playSec,id=>{ playSec=id; saveTrain(); renderTrain(); },false,null);
    // weak
    const weak=weakCards();
    $("w-desc").textContent = weak.length ? "Moves you have missed most often. A short drill on just these:" : "No missed moves yet. Moves you miss in reviews show up here.";
    const wl=$("w-list"); wl.innerHTML="";
    weak.slice(0,8).forEach(c=>{ const b=document.createElement("button"); b.className="wchip"; const ln=LINES[CARD_LINES[c][0]], x=ln.cards.find(y=>y.c===c); b.textContent=ln.id+" "+moveNo(x.p)+CARDS[c].s+" ×"+prog[c].l; b.title="Open in Study"; b.onclick=()=>openStudyAt(ln.i,x.p); wl.appendChild(b); });
    $("b-weak").disabled=!weak.length;
  }
  function weakCards(){ return ALLCARDS.filter(c=>prog[c]&&prog[c].l>0).sort((a,b)=>prog[b].l-prog[a].l||prog[a].b-prog[b].b); }
  function relTime(t){ const d=t-now(); if(d<HOUR) return "in "+Math.max(1,Math.round(d/MIN))+" min"; if(d<DAY) return "in "+Math.round(d/HOUR)+" h"; const n=Math.round(d/DAY); return n===1?"tomorrow":"in "+n+" days"; }
  $("b-review").onclick=()=>startSession("review");
  $("b-learn").onclick=()=>startSession("learn");
  $("b-learn2").onclick=()=>startSession("learn");
  $("b-play").onclick=()=>startSession("play",{sec:playSec});
  $("b-weak").onclick=()=>startSession("weak");

  /* ---------- SESSION ---------- */
  const sb=new Board($("se-board"));
  let S=null;
  function buildReviewRuns(cards,kind){
    const left=new Set(cards), runs=[];
    while(left.size && runs.length<15){
      let best=null,bn=0;
      for(const ln of LINES){ const n=ln.cards.filter(x=>left.has(x.c)).length; if(n>bn || (n===bn&&n>0&&ln.uci.length<best.uci.length)){ best=ln; bn=n; } }
      if(!best) break;
      const due=best.cards.filter(x=>left.has(x.c));
      due.forEach(x=>left.delete(x.c));
      runs.push({line:best.i, from:Math.max(0,due[0].p-1), gradeSet:new Set(due.map(x=>x.c)), mode:kind});
    }
    return runs;
  }
  function startSession(kind,opt={}){
    let runs=[], title="";
    if(kind==="review"){ const due=ALLCARDS.filter(c=>status(c)==="due").sort((a,b)=>prog[a].d-prog[b].d); runs=buildReviewRuns(due,"review"); title="Review"; }
    else if(kind==="weak"){ runs=buildReviewRuns(weakCards().slice(0,12),"weak"); title="Weak moves"; }
    else if(kind==="redo"){ runs=buildReviewRuns(opt.cards,"weak"); title="Missed moves"; }
    else if(kind==="prep"){ const valid=(opt.cards||[]).filter(c=>CARDS[c]); runs=buildReviewRuns(valid,opt.mode==="learn"?"learn":"review"); title=opt.title||"Opponent Prep"; }
    else if(kind==="learn"){ const ln=opt.line!==undefined?LINES[opt.line]:nextLearnLine(learnSec); if(!ln) return; const newC=ln.cards.filter(x=>status(x.c)==="new"); const from=Math.max(0,(newC[0]?newC[0].p:0)-1); runs=[{line:ln.i,from,mode:"learn"},{line:ln.i,from,mode:"recall",gradeSet:new Set(newC.map(x=>x.c))}]; title="Learn · "+ln.id; }
    else if(kind==="play"){ runs=[{tree:true,sec:opt.sec,startPos:opt.pos,prefixSan:opt.prefix,color:opt.color||(SECBY[opt.sec]||{}).color,mode:"play"}]; title="Play · "+(opt.pos!==undefined?"from this position":SECBY[opt.sec].name); }
    if(!runs.length) return;
    S={kind,title,runs,ri:0,stats:{asked:0,first:0,miss:0,learned:0},missed:new Set(),opt};
    $("session").hidden=false; document.body.style.overflow="hidden";
    $("se-title").textContent=title; $("se-sum").hidden=true; $("se-coach").querySelectorAll(".ln,.prompt,.fb,.minimoves,.c-act").forEach(e=>e.hidden=false);
    startRun();
  }
  function endSession(){ clearAutoTimer(); flushDays(); S=null; $("session").hidden=true; document.body.style.overflow=""; refreshAll(); if(tab==="train") renderTrain(); }
  $("se-x").onclick=()=>{ if(S && S.stats.asked && !S.done){ showSummary(true); } else endSession(); };
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&S) $("se-x").click(); });

  function updHead(){
    const tot=S.runs.length; $("se-prog").style.width=(100*Math.min(S.ri,tot)/Math.max(1,tot))+"%";
    $("se-score").textContent=S.stats.asked?("✓ "+S.stats.first+"  ✗ "+S.stats.miss):"";
  }
  function setCoach({prompt,cls,fb,fbCls,note,noteHead,warn,acts}){
    if(prompt!==undefined){ const p=$("se-prompt"); p.textContent=prompt; p.className="prompt"+(cls?" "+cls:""); }
    if(fb!==undefined){ const f=$("se-fb"); f.innerHTML=fb; f.style.color=fbCls==="err"?"var(--bad)":fbCls==="ok"?"var(--good)":""; }
    if(note!==undefined){ $("se-note").hidden=!note; $("se-note-t").textContent=note||""; $("se-note-h").textContent=noteHead||"Why"; }
    if(warn!==undefined){ $("se-warn").hidden=!warn; $("se-warn").textContent=warn||""; }
    if(acts!==undefined){ const a=$("se-act"); a.innerHTML=""; acts.forEach(x=>{ const b=document.createElement("button"); b.className="btn"+(x.primary?" primary":""); b.textContent=x.label; b.onclick=x.fn; if(x.id) b.id=x.id; a.appendChild(b); }); }
  }
  function buildTreeFrames(prefix, fallbackFen, prefixLine, startPly, fallbackPi){
    if(prefixLine && startPly!==undefined && startPly!==null && prefixLine.pos.length>startPly){
      const out=[];
      for(let k=0;k<=startPly;k++){
        const u=k>0?prefixLine.uci[k-1]:null;
        out.push({fen:POS[prefixLine.pos[k]].f,last:u?[u.slice(0,2),u.slice(2,4)]:null,pi:prefixLine.pos[k],prevPi:k>0?prefixLine.pos[k-1]:null,uci:u,san:k>0?prefixLine.san[k-1]:null,card:k>0?cardAt(prefixLine,k-1):null,ply:k});
      }
      return out;
    }
    if(prefix && prefix.length){
      const mv=movesFromSan(prefix);
      if(mv && mv.length && mv[mv.length-1].fen.split(" ").slice(0,4).join(" ")===fallbackFen.split(" ").slice(0,4).join(" ")){
        return [{fen:START,last:null,pi:null,prevPi:null,uci:null,san:null,card:null,ply:0}].concat(mv.map((m,i)=>({fen:m.fen,last:[m.from,m.to],pi:i===mv.length-1?(fallbackPi??null):null,prevPi:null,uci:m.from+m.to+(m.promotion||""),san:m.san,card:null,ply:i+1})));
      }
    }
    return [{fen:fallbackFen,last:null,pi:fallbackPi??null,prevPi:null,uci:null,san:null,card:null,ply:0}];
  }
  function sessionFrames(run){
    if(!run) return [];
    if(run.tree) return run.frames||[{fen:POS[run.pos].f,last:null,pi:run.pos,prevPi:null,uci:null,san:null,card:null,ply:0}];
    const ln=LINES[run.line];
    const tip=Math.min(ln.pos.length-1, run.p+(run.justPlayed?1:0));
    const out=[];
    for(let k=0;k<=tip;k++){
      const u=k>0?ln.uci[k-1]:null;
      out.push({fen:POS[ln.pos[k]].f,last:u?[u.slice(0,2),u.slice(2,4)]:null,pi:ln.pos[k],prevPi:k>0?ln.pos[k-1]:null,uci:u,san:k>0?ln.san[k-1]:null,card:k>0?cardAt(ln,k-1):null,ply:k});
    }
    return out;
  }
  let fastLearn=false;
  try{ const f=localStorage.getItem("rt2-fast-learn"); if(f==="1"||f==="true") fastLearn=true; }catch(_){}
  let autoTimer=0;
  function clearAutoTimer(){ if(autoTimer){ clearTimeout(autoTimer); autoTimer=0; } }
  function applyFastLearn(){
    const b=$("se-auto"); if(!b) return;
    b.setAttribute("aria-pressed",String(fastLearn));
    b.title=fastLearn?"Auto-advance ON: plays through learned moves in one tap":"Auto-advance OFF: pause after each learned move";
  }
  const autoBtn=$("se-auto");
  if(autoBtn){
    applyFastLearn();
    autoBtn.onclick=()=>{
      fastLearn=!fastLearn;
      applyFastLearn();
      try{ localStorage.setItem("rt2-fast-learn",fastLearn?"1":"0"); }catch(_){}
      if(fastLearn && S && S.run && S.run.pendingAdvance && S.run.teach){
        const fn=S.run.pendingAdvance; S.run.pendingAdvance=null; clearAutoTimer(); fn();
      }
    };
  }
  function renderSessionSibs(pi, excludeUci){
    const box=$("se-sibs"); if(!box) return;
    box.innerHTML="";
    if(pi===null||pi===undefined||!POS[pi]){ box.hidden=true; return; }
    const node=POS[pi];
    const ex4=excludeUci?excludeUci.slice(0,4):"";
    const sibEdges=node.e.filter(e=>e[0].slice(0,4)!==ex4);
    const transLines=[];
    const curSec=S&&S.run?(S.run.tree?S.run.sec:LINES[S.run.line]?.sec):null;
    if(curSec){
      const seenSec=new Set([curSec]);
      for(const l of LINES){
        if(!seenSec.has(l.sec) && l.pos.includes(pi)){ seenSec.add(l.sec); transLines.push(l); }
      }
    }
    if(!sibEdges.length && !transLines.length){ box.hidden=true; return; }
    box.hidden=false;
    const lbl=document.createElement("span");
    lbl.className="sib-lbl";
    lbl.textContent=sibEdges.length?"Also here":"Transposes";
    box.appendChild(lbl);
    sibEdges.slice(0,5).forEach(e=>{
      const li=e[4][0];
      const b=document.createElement("button");
      b.type="button"; b.className="sib-chip";
      b.textContent=e[1];
      b.title="Inspect "+e[1]+" in Study";
      b.onclick=()=>{
        if(li===undefined) return;
        const ln=LINES[li];
        const idx=ln.pos.indexOf(e[2]);
        endSession();
        openStudyAt(li,idx>=0?idx:ln.pos.length-1);
      };
      box.appendChild(b);
    });
    transLines.slice(0,3).forEach(l=>{
      const sec=SECBY[l.sec];
      const b=document.createElement("button");
      b.type="button"; b.className="sib-chip";
      b.textContent="⇄ "+(sec?sec.name:l.name);
      b.title="Open transposition in Study";
      b.onclick=()=>{
        const idx=l.pos.indexOf(pi);
        endSession();
        openStudyAt(l.i,idx>=0?idx:0);
      };
      box.appendChild(b);
    });
  }
  function syncSessionNav(){
    const run=S&&S.run;
    const frames=sessionFrames(run);
    const tip=Math.max(0,frames.length-1);
    const cur=run&&run.viewIdx!==null&&run.viewIdx!==undefined?Math.min(run.viewIdx,tip):tip;
    const canBack=Boolean(run && cur>0);
    const canStepFwd=Boolean(run && cur<tip);
    const canAdvance=Boolean(run && cur===tip && (run.pendingAdvance || run.awaitingMove));
    const highlightNext=Boolean(run && cur===tip && (run.pendingAdvance || (run.awaitingMove && (run.teach || run.liveArrow))));
    $("se-first").disabled=$("se-prev").disabled=!canBack;
    $("se-next").disabled=!(canStepFwd || canAdvance);
    $("se-next").classList.toggle("board-btn-primary",highlightNext);
    $("se-next").setAttribute("aria-label",run&&run.pendingAdvance?"Continue to next move":"Next move");
    $("se-last").disabled=!(canStepFwd || Boolean(run && cur===tip && run.pendingAdvance));
  }
  function goSessionView(targetIdx){
    if(!S||!S.run) return;
    clearAutoTimer();
    const run=S.run, frames=sessionFrames(run), tip=frames.length-1;
    if(tip<0) return;
    const idx=Math.max(0,Math.min(tip,targetIdx));
    const f=frames[idx];
    sb.clearArrows(); sb.clearMarks();
    sb.set(f.fen,{last:f.last,anim:false,sound:false});
    const ck=checkSq(f.fen); if(ck) sb.mark(ck,"check");
    if(idx===tip){
      run.viewIdx=null;
      if(run.savedTipCoach){
        const sc=run.savedTipCoach; run.savedTipCoach=null;
        $("se-note").hidden=sc.noteHidden; $("se-note-h").textContent=sc.noteHead; $("se-note-t").textContent=sc.noteText;
        $("se-warn").hidden=sc.warnHidden; $("se-warn").textContent=sc.warnText;
      }
      if(run.liveHabitArrows) run.liveHabitArrows.forEach(a=>sb.arrow(a[0],a[1],"#e11d48",{width:15,opacity:0.72,dashed:true}));
      if(run.liveArrow) sb.arrow(run.liveArrow[0],run.liveArrow[1],run.liveArrow[2]);
      if(run.liveHintSq) sb.mark(run.liveHintSq,"hint");
      if(run.awaitingMove){ sb.dests=chessDests(f.fen); sb.movable=ownPiece(f.fen,sb); }
      else sb.movable=()=>false;
    } else {
      if(!run.savedTipCoach){
        run.savedTipCoach={
          noteHidden:$("se-note").hidden,
          noteHead:$("se-note-h").textContent,
          noteText:$("se-note-t").textContent,
          warnHidden:$("se-warn").hidden,
          warnText:$("se-warn").textContent
        };
      }
      run.viewIdx=idx;
      sb.movable=()=>false;
      const nextF=frames[idx+1]||null;
      const canShowNext=Boolean(nextF && (!run.awaitingMove || run.teach || idx+1<tip));
      const curCard=f.card?CARDS[f.card]:null;
      const nextCard=canShowNext && nextF.card?CARDS[nextF.card]:null;
      const hereHabits=f.pi!==null&&f.pi!==undefined?habitWarnsAtPos(f.pi):[];
      const prevHabits=f.prevPi!==null&&f.prevPi!==undefined?habitWarnsAtPos(f.prevPi):[];
      const oppWarn=f.prevPi!==null&&f.prevPi!==undefined&&f.uci?WARN[f.prevPi+"|"+f.uci]||null:null;
      if(canShowNext && (nextCard || hereHabits.length)){
        hereHabits.slice(0,2).forEach(h=>sb.arrow(h.uci.slice(0,2),h.uci.slice(2,4),"#e11d48",{width:15,opacity:0.72,dashed:true}));
        if(nextF.uci) sb.arrow(nextF.uci.slice(0,2),nextF.uci.slice(2,4),"#1f5f8b");
      }
      const noteCard=(curCard&&curCard.n)?curCard:(nextCard&&nextCard.n)?nextCard:null;
      const viewWarn=curCard
        ?(prevHabits[0]?.text||oppWarn||null)
        :(canShowNext?(oppWarn||hereHabits[0]?.text||null):oppWarn);
      $("se-note").hidden=!noteCard;
      if(noteCard){ $("se-note-h").textContent="Why "+noteCard.s; $("se-note-t").textContent=noteCard.n; }
      $("se-warn").hidden=!viewWarn;
      $("se-warn").textContent=viewWarn||"";
    }
    syncSessionNav();
    renderMini();
  }
  function sessionNextAction(){
    const run=S&&S.run; if(!run) return;
    clearAutoTimer();
    const frames=sessionFrames(run), tip=frames.length-1;
    const cur=run.viewIdx!==null&&run.viewIdx!==undefined?Math.min(run.viewIdx,tip):tip;
    if(cur<tip){ goSessionView(cur+1); return; }
    if(run.pendingAdvance){ const fn=run.pendingAdvance; run.pendingAdvance=null; fn(); return; }
    if(run.awaitingMove){
      const card=CARDS[run.cur]; if(!card) return;
      const fen=frames[tip]&&frames[tip].fen; if(!fen) return;
      if(run.teach || run.liveArrow){
        const r=tryMove(fen,card.u.slice(0,2),card.u.slice(2,4));
        if(r) correct(fen,r);
      } else {
        giveHint(2);
      }
    }
  }
  $("se-first").onclick=()=>goSessionView(0);
  $("se-prev").onclick=()=>{ const run=S&&S.run; if(!run) return; const tip=sessionFrames(run).length-1; goSessionView((run.viewIdx??tip)-1); };
  $("se-next").onclick=sessionNextAction;
  $("se-last").onclick=()=>{
    const run=S&&S.run; if(!run) return;
    clearAutoTimer();
    const frames=sessionFrames(run), tip=frames.length-1;
    const cur=run.viewIdx!==null&&run.viewIdx!==undefined?Math.min(run.viewIdx,tip):tip;
    if(cur<tip){ goSessionView(tip); return; }
    if(run.pendingAdvance){ const fn=run.pendingAdvance; run.pendingAdvance=null; fn(); }
  };
  $("se-flip").onclick=()=>{ sb.setOrient(sb.orient==="w"?"b":"w"); };

  function startRun(){
    clearAutoTimer();
    updHead();
    if(S.ri>=S.runs.length){ showSummary(false); return; }
    const run=S.runs[S.ri];
    run.viewIdx=null; run.savedTipCoach=null; run.justPlayed=false; run.awaitingMove=false; run.liveArrow=null; run.liveHabitArrows=[]; run.liveHintSq=null; run.pendingAdvance=null;
    renderSessionSibs(null);
    if(run.tree){
      const sec=SECBY[run.sec];
      run.pos = run.startPos!==undefined ? run.startPos : sec.start;
      run.color = run.startPos!==undefined ? run.color : sec.color;
      const prefixLine = run.startPos===undefined && sec && sec.lines.length ? LINES[sec.lines[0]] : null;
      run.hist=[]; run.prefix = run.startPos!==undefined ? (run.prefixSan||[]) : prefixLine.san.slice(0,sec.startPly);
      run.me = run.color==="w"?"w":"b";
      run.frames = buildTreeFrames(run.prefix, POS[run.pos].f, prefixLine, prefixLine?sec.startPly:null, run.pos);
      sb.setOrient(run.color==="w"?"w":"b"); sb.clearArrows(); sb.clearMarks();
      const lastF=run.frames[run.frames.length-1];
      sb.set(POS[run.pos].f,{anim:false,last:lastF?lastF.last:null});
      $("se-line").textContent=sec?sec.name:"From this position"; $("se-open").textContent=openingName(run.pos)||"";
      run.tries=0; S.run=run;
      syncSessionNav();
      // The session may have been closed or moved on before this fires.
      setTimeout(()=>{ if(S&&S.run===run) treeStep(); },250);
      return;
    }
    const ln=LINES[run.line]; run.p=run.from; run.tries=0; S.run=run;
    sb.setOrient(ln.color); sb.clearArrows(); sb.clearMarks();
    const lastU=run.p>0?ln.uci[run.p-1]:null;
    sb.set(POS[ln.pos[run.p]].f,{anim:false,last:lastU?[lastU.slice(0,2),lastU.slice(2,4)]:null});
    $("se-line").textContent=lineLabel(ln)+(run.mode==="recall"?" · from memory":run.mode==="learn"?" · new moves":"");
    $("se-open").textContent=openingName(ln.pos[run.p])||"";
    renderMini(); syncSessionNav();
    setCoach({prompt:run.mode==="recall"?"Now from memory":"",fb:"",note:null,warn:null,acts:[]});
    setTimeout(()=>{ if(S&&S.run===run) lineStep(); },run.mode==="recall"?700:350);
  }
  function renderMini(){
    const run=S&&S.run; if(!run) return;
    const frames=sessionFrames(run), tip=frames.length-1;
    const activeIdx=run.viewIdx!==null&&run.viewIdx!==undefined?run.viewIdx:tip;
    let sans, meParity;
    if(run.tree){
      sans=run.prefix.concat(run.hist);
      if(run.justPlayed && run.pendingSan) sans=sans.concat([run.pendingSan]);
      meParity=run.me==="w"?0:1;
    } else {
      const ln=LINES[run.line];
      const count=Math.min(ln.san.length, run.p+(run.justPlayed?1:0));
      sans=ln.san.slice(0,count);
      meParity=meIdx(ln);
    }
    const offset=frames.length-1-sans.length;
    const host=$("se-moves"); host.innerHTML="";
    sans.forEach((s,p)=>{
      if(p>0) host.appendChild(document.createTextNode(" "));
      if(p%2===0){ const n=document.createElement("span"); n.textContent=(Math.floor(p/2)+1)+"."; host.appendChild(n); }
      const b=document.createElement("button");
      const frameIdx=offset+p+1;
      b.type="button";
      b.className="mm"+(frameIdx===activeIdx && run.viewIdx!==null?" cur":"");
      b.innerHTML=p%2===meParity?"<b>"+esc(s)+"</b>":esc(s);
      if(frameIdx>=0 && frameIdx<frames.length) b.onclick=()=>goSessionView(frameIdx);
      host.appendChild(b);
    });
  }
  function playAuto(fen,uci){ sb.clearArrows(); sb.clearMarks(); const r=tryMove(fen,uci.slice(0,2),uci.slice(2,4)); sb.set(r.fen,{last:[uci.slice(0,2),uci.slice(2,4)]}); const ck=checkSq(r.fen); if(ck) sb.mark(ck,"check"); return r.fen; }

  /* line runs */
  function lineStep(){
    if(!S) return; const run=S.run, ln=LINES[run.line];
    run.viewIdx=null; run.savedTipCoach=null; run.justPlayed=false; run.liveArrow=null; run.liveHabitArrows=[]; run.liveHintSq=null; run.pendingAdvance=null;
    if(run.p>=ln.uci.length){ run.awaitingMove=false; renderSessionSibs(ln.pos[ln.pos.length-1],null); syncSessionNav(); finishRun(); return; }
    const fen=POS[ln.pos[run.p]].f;
    if(run.p%2!==meIdx(ln)){
      // opponent move
      run.awaitingMove=false;
      sb.movable=()=>false;
      syncSessionNav();
      setCoach({prompt:(ln.color==="w"?"Black":"White")+" plays…",cls:"",acts:[]});
      setTimeout(()=>{ if(!S||S.run!==run) return;
        playAuto(fen,ln.uci[run.p]); const w=WARN[ln.pos[run.p]+"|"+ln.uci[run.p]];
        run.warn=w||null; run.p++; renderMini(); syncSessionNav(); $("se-open").textContent=openingName(ln.pos[run.p])||$("se-open").textContent; lineStep(); },250);
      return;
    }
    askLineMove();
  }
  function habitWarnsAtPos(pi){
    const node=POS[pi]; if(!node) return [];
    const prefix=pi+"|";
    const edgeUcis=new Set((node.e||[]).map(e=>e[0].slice(0,4)));
    const out=[];
    for(const k in WARN){
      if(!k.startsWith(prefix)) continue;
      const u=k.slice(prefix.length);
      if(u.length>=4 && !edgeUcis.has(u.slice(0,4))) out.push({uci:u,text:WARN[k]});
    }
    return out;
  }
  function collectLineHabitWarns(run, ln){
    const posList=ln?ln.pos:(run&&run.frames?run.frames.map(f=>f.pi).filter(pi=>pi!==null&&pi!==undefined):[]);
    const seen=new Set();
    const out=[];
    for(const pi of posList){
      for(const h of habitWarnsAtPos(pi)){
        if(!seen.has(h.text)){
          seen.add(h.text);
          out.push(h.text);
          if(out.length>=2) return out.join(" · ");
        }
      }
    }
    return out.length?out.join(" · "):null;
  }
  function findEndedTreeLine(run){
    return (run.sec && LINES.find(l=>l.sec===run.sec && l.pos[l.pos.length-1]===run.pos)) || LINES.find(l=>l.pos[l.pos.length-1]===run.pos) || null;
  }
  function askLineMove(){
    const run=S.run, ln=LINES[run.line], pi=ln.pos[run.p], fen=POS[pi].f, c=cardAt(ln,run.p), card=CARDS[c];
    run.tries=0; run.cur=c; run.hinted=false; run.viewIdx=null; run.savedTipCoach=null; run.awaitingMove=true; run.liveHintSq=null; run.pendingAdvance=null;
    const isNew = status(c)==="new";
    const teach = (run.mode==="learn"&&isNew) || (run.mode==="play"&&isNew);
    run.teach=teach;
    const habits=habitWarnsAtPos(pi);
    const coachWarn=run.warn||(teach&&habits.length?habits[0].text:null);
    sb.clearArrows();
    if(teach){
      run.liveHabitArrows=habits.slice(0,2).map(h=>[h.uci.slice(0,2),h.uci.slice(2,4)]);
      run.liveHabitArrows.forEach(a=>sb.arrow(a[0],a[1],"#e11d48",{width:15,opacity:0.72,dashed:true}));
      run.liveArrow=[card.u.slice(0,2),card.u.slice(2,4),"#1f5f8b"];
      sb.arrow(...run.liveArrow);
      setCoach({prompt:"New move: "+moveNo(run.p)+card.s,cls:"new",fb:"Play the move or tap › to step forward.",note:card.n,noteHead:"Why "+card.s,warn:coachWarn,acts:[]});
    } else {
      run.liveHabitArrows=[];
      run.liveArrow=null;
      setCoach({prompt:"Your move",cls:"",fb:run.mode==="recall"?"Play the move you just learned.":"",note:null,warn:run.warn,acts:[
        {label:"Hint",fn:()=>giveHint(1)},{label:"Show move",fn:()=>giveHint(2)} ]});
    }
    run.warn=null;
    renderSessionSibs(pi,card.u);
    sb.dests=chessDests(fen); sb.movable=ownPiece(fen,sb);
    sb.onMove=(from,to)=>onUserMove(fen,from,to);
    syncSessionNav();
  }
  function giveHint(level){
    const run=S.run, card=CARDS[run.cur];
    if(run.viewIdx!==null) goSessionView(Infinity);
    if(!run.hinted && !run.teach){ run.hinted=true; noteMiss(); }
    if(level===1){ run.liveHintSq=card.u.slice(0,2); sb.clearMarks(); sb.mark(run.liveHintSq,"hint"); setCoach({fb:"This piece moves."}); }
    else {
      const pi=run.tree?run.pos:LINES[run.line].pos[run.p];
      const habits=habitWarnsAtPos(pi);
      run.liveHabitArrows=habits.slice(0,2).map(h=>[h.uci.slice(0,2),h.uci.slice(2,4)]);
      run.liveArrow=[card.u.slice(0,2),card.u.slice(2,4),"#b0382e"];
      sb.clearArrows();
      run.liveHabitArrows.forEach(a=>sb.arrow(a[0],a[1],"#e11d48",{width:15,opacity:0.72,dashed:true}));
      sb.arrow(...run.liveArrow);
      setCoach({fb:"Play "+esc(card.s)+" or tap ›.",note:card.n,noteHead:"Why "+card.s,warn:habits.length?habits[0].text:undefined});
    }
    syncSessionNav();
  }
  function noteMiss(){ const run=S.run; if(run.missed) return; run.missed=true; S.stats.miss++; S.missed.add(run.cur); }
  function altVerdict(fen,uci){
    // Is a non-repertoire move still good? Compare to the repertoire move with the stored engine lines.
    const pi=S.run.tree?S.run.pos:LINES[S.run.line].pos[S.run.p];
    const node=POS[pi];
    if(node.e.some(e=>e[0]===uci && (e[3]&1))) return "otherline";
    const t=TH[node.t]; if(!t||!t.alts) return null;
    const a=t.alts.find(x=>x.uci===uci); if(!a) return null;
    const exp=t.alts.find(x=>x.uci===CARDS[S.run.cur].u)||t.alts[0];
    const white=sideToMove(fen)==="w"; const diff=(evNum(exp.ev)-evNum(a.ev))*(white?1:-1);
    return diff<=0.35 ? {ev:a.ev} : null;
  }
  function onUserMove(fen,from,to){
    const run=S.run; const card=CARDS[run.cur];
    const r=tryMove(fen,from,to); if(!r) return;
    const uci=r.uci.slice(0,4);
    if(uci===card.u.slice(0,4)){ correct(fen,r); return; }
    // wrong but legal: show it briefly, then take it back
    const prevLast=sb.last; sb.set(r.fen,{last:[from,to],anim:false}); sb.movable=()=>false;
    const pi=S.run.tree?S.run.pos:LINES[S.run.line].pos[S.run.p];
    const habitWarn=WARN[pi+"|"+r.uci]||WARN[pi+"|"+uci]||null;
    const v=habitWarn?null:altVerdict(fen,uci);
    setTimeout(()=>{ if(!S||S.run!==run) return;
      sb.set(fen,{anim:false,sound:false,last:prevLast}); sb.movable=ownPiece(fen,sb);
      if(v==="otherline"){ setCoach({fb:"That's your other repertoire move here. This drill is "+(run.tree?"the main line":LINES[run.line].name)+". Try again."}); return; }
      if(v){ setCoach({fb:"Good move ("+fmtEv(v.ev)+"), but not your repertoire move. Try again."}); return; }
      run.tries++; if(!run.teach) noteMiss(); Snd.play("err"); sb.shake();
      sb.mark(from,"bad"); setTimeout(()=>{ if(S&&S.run===run){ sb.mark(from,null); } },700);
      if(habitWarn){
        setCoach({prompt:"Old habit",cls:"err",warn:habitWarn,fb:run.teach?"Follow the arrow for your new repertoire move.":"Try your new repertoire move, or use a hint."});
        return;
      }
      if(run.teach){ setCoach({fb:"Not that one: follow the arrow or tap ›."}); return; }
      if(run.tries===1) setCoach({prompt:"Not this one",cls:"err",fb:"Try again, or use a hint."});
      else if(run.tries===2) giveHint(1);
      else giveHint(2);
    },420);
  }
  function correct(fen,r){
    const run=S.run, c=run.cur, card=CARDS[c];
    const piBefore=run.tree?run.pos:LINES[run.line].pos[run.p];
    const habitsBefore=habitWarnsAtPos(piBefore);
    clearAutoTimer();
    run.awaitingMove=false; run.liveArrow=null; run.liveHabitArrows=[]; run.liveHintSq=null; run.viewIdx=null; run.savedTipCoach=null; run.pendingAdvance=null;
    sb.movable=()=>false; sb.clearArrows(); sb.clearMarks();
    const last=[card.u.slice(0,2),card.u.slice(2,4)];
    sb.set(r.fen,{last,anim:false});
    const ck=checkSq(r.fen); if(ck) sb.mark(ck,"check");
    run.justPlayed=true; run.pendingSan=card.s;
    if(run.tree && run.frames){
      const nextEd=POS[run.pos]?.e?.find(e=>e[0]===card.u);
      run.frames.push({fen:r.fen,last,pi:nextEd?nextEd[2]:null,prevPi:run.pos,uci:card.u,san:card.s,card:c,ply:run.frames.length});
    }
    renderMini();
    S.stats.asked++;
    let shouldGrade;
    if(run.teach){ learnCard(c); S.stats.learned++; }
    else {
      if(!run.missed) S.stats.first++;
      if(run.missed) shouldGrade=true;
      else if(run.mode==="play") shouldGrade = status(c)==="due";
      else if(run.gradeSet) shouldGrade = run.gradeSet.has(c);
      else shouldGrade = status(c)==="due";
      if(shouldGrade) grade(c,!run.missed);
    }
    updHead();
    const wasMiss=run.missed; run.missed=false;
    const advance=()=>{
      clearAutoTimer();
      if(!S||S.run!==run) return;
      run.justPlayed=false; run.pendingSan=null; run.viewIdx=null; run.savedTipCoach=null; run.pendingAdvance=null;
      if(run.tree){
        run.hist.push(card.s);
        run.pos=POS[run.pos].e.find(e=>e[0]===card.u)[2];
        const f=run.frames[run.frames.length-1];
        if(f) sb.set(f.fen,{last:f.last,anim:false,sound:false});
        treeStep();
      } else {
        run.p++;
        const ln=LINES[run.line], u=run.p>0?ln.uci[run.p-1]:null;
        sb.set(POS[ln.pos[run.p]].f,{last:u?[u.slice(0,2),u.slice(2,4)]:null,anim:false,sound:false});
        renderMini(); syncSessionNav(); lineStep();
      }
    };
    if(wasMiss){
      Snd.play("move");
      run.pendingAdvance=advance;
      setCoach({prompt:card.s,cls:"err",fb:"Got it. This move comes back in 10 minutes.",note:card.n,noteHead:"Why "+card.s,warn:habitsBefore.length?habitsBefore[0].text:undefined,acts:[]});
      syncSessionNav();
    } else if(run.teach){
      run.pendingAdvance=advance;
      setCoach({prompt:"✓ "+card.s,cls:"ok",fb:"",note:card.n,noteHead:"Why "+card.s,acts:[]});
      syncSessionNav();
      if(fastLearn) autoTimer=setTimeout(advance,550);
    } else {
      Snd.play("ok");
      setCoach({prompt:"✓ "+card.s,cls:"ok",fb:"",note:SET.notes?card.n:null,noteHead:"Why "+card.s,acts:[]});
      syncSessionNav();
      autoTimer=setTimeout(advance,SET.notes?300:150);
    }
  }
  function finishRun(){
    clearAutoTimer();
    const run=S.run;
    run.awaitingMove=false; run.liveArrow=null; run.liveHabitArrows=[]; run.liveHintSq=null; run.savedTipCoach=null; run.pendingAdvance=null;
    syncSessionNav();
    if(run.tree){
      S.ri++; updHead();
      const ln=findEndedTreeLine(run);
      const lineHabitWarn=collectLineHabitWarns(run,ln);
      setCoach({prompt:"Line complete",cls:"ok",fb:esc(run.endName||"You reached the end of your repertoire here."),note:ln?ln.note:null,noteHead:"The plan",warn:lineHabitWarn,acts:[
        {label:"Play another",primary:true,fn:()=>{ S.runs.push({tree:true,sec:run.sec,startPos:run.startPos,color:run.color,mode:"play"}); startRun(); }},
        {label:"Play on vs engine",fn:()=>sessionToExplore(run.prefix.concat(run.hist),POS[run.pos].f,run.color,openingName(run.pos)||"From your line",true)},
        {label:"Analyze",fn:()=>sessionToExplore(run.prefix.concat(run.hist),POS[run.pos].f,run.color,openingName(run.pos)||"From your line",false)},
        {label:"Finish",fn:()=>showSummary(false)} ]});
      return;
    }
    const ln=LINES[run.line];
    const lineHabitWarn=collectLineHabitWarns(run,ln);
    S.ri++; updHead();
    const isLast=S.ri>=S.runs.length;
    const next=()=>startRun();
    if(run.mode==="learn"){
      setCoach({prompt:"Line learned",cls:"ok",fb:"Now play it once from memory.",note:ln.note,noteHead:"The plan",warn:lineHabitWarn,acts:[{label:"Play from memory",primary:true,fn:next}]});
      return;
    }
    const endFen=POS[ln.pos[ln.pos.length-1]].f, lbl=openingName(ln.pos[ln.pos.length-1])||lineLabel(ln);
    setCoach({prompt:"Line complete",cls:"ok",fb:"",note:ln.note,noteHead:"The plan",warn:lineHabitWarn,acts:[{label:isLast?"See results":"Next line",primary:true,fn:next},
      {label:"Play on vs engine",fn:()=>sessionToExplore(ln.san,endFen,ln.color,lbl,true)},
      {label:"Analyze",fn:()=>sessionToExplore(ln.san,endFen,ln.color,lbl,false)}]});
  }
  /* tree (play) runs */
  function treeStep(){
    if(!S) return; const run=S.run, node=POS[run.pos], fen=node.f, stm=sideToMove(fen);
    run.viewIdx=null; run.savedTipCoach=null; run.justPlayed=false; run.liveArrow=null; run.liveHabitArrows=[]; run.liveHintSq=null; run.pendingAdvance=null;
    $("se-open").textContent=openingName(run.pos)||$("se-open").textContent;
    renderMini(); syncSessionNav();
    const mine = stm===run.me;
    const inSec = e => !run.sec || e[4].some(li=>LINES[li].sec===run.sec);
    const edges = node.e.filter(e=> (mine ? (e[3]&1)&&!(e[3]&2) : true) && inSec(e));
    if(!edges.length){ const ln=findEndedTreeLine(run); run.endName=ln?"End of "+lineLabel(ln)+".":""; renderSessionSibs(run.pos,null); finishRun(); return; }
    if(!mine){
      run.awaitingMove=false;
      sb.movable=()=>false;
      setCoach({prompt:(run.me==="w"?"Black":"White")+" plays…",cls:"",note:SET.notes?undefined:null,acts:[]});
      const ws=edges.map(e=>{ let w=1; subCards(e[2]).forEach(c=>{ const s=status(c); if(s==="due") w+=3; else if(s==="new") w+=1; }); return w; });
      let tot=ws.reduce((a,b)=>a+b,0), r=Math.random()*tot, pick=edges[0];
      for(let i=0;i<edges.length;i++){ r-=ws[i]; if(r<=0){ pick=edges[i]; break; } }
      setTimeout(()=>{ if(!S||S.run!==run) return; const prevPi=run.pos; const nextFen=playAuto(fen,pick[0]); run.warn=WARN[prevPi+"|"+pick[0]]||null; run.hist.push(pick[1]); run.pos=pick[2]; if(run.frames) run.frames.push({fen:nextFen,last:[pick[0].slice(0,2),pick[0].slice(2,4)],pi:pick[2],prevPi,uci:pick[0],san:pick[1],card:pick[5]||null,ply:run.frames.length}); treeStep(); },250);
      return;
    }
    const ed=edges[0]; run.cur=ed[5]; run.tries=0; run.hinted=false; run.missed=false; run.awaitingMove=true;
    const isNew=status(run.cur)==="new"; run.teach=isNew;
    const card=CARDS[run.cur];
    const habits=habitWarnsAtPos(run.pos);
    const coachWarn=run.warn||(isNew&&habits.length?habits[0].text:null);
    sb.clearArrows();
    if(isNew){
      run.liveHabitArrows=habits.slice(0,2).map(h=>[h.uci.slice(0,2),h.uci.slice(2,4)]);
      run.liveHabitArrows.forEach(a=>sb.arrow(a[0],a[1],"#e11d48",{width:15,opacity:0.72,dashed:true}));
      run.liveArrow=[card.u.slice(0,2),card.u.slice(2,4),"#1f5f8b"];
      sb.arrow(...run.liveArrow);
      setCoach({prompt:"New move: "+card.s,cls:"new",fb:"Play the move or tap › to step forward.",note:card.n,noteHead:"Why "+card.s,warn:coachWarn,acts:[]});
    } else {
      run.liveHabitArrows=[];
      run.liveArrow=null;
      setCoach({prompt:"Your move",cls:"",fb:"",note:null,warn:run.warn,acts:[{label:"Hint",fn:()=>giveHint(1)},{label:"Show move",fn:()=>giveHint(2)}]});
    }
    run.warn=null;
    renderSessionSibs(run.pos,card.u);
    sb.dests=chessDests(fen); sb.movable=ownPiece(fen,sb); sb.onMove=(from,to)=>onUserMove(fen,from,to);
    syncSessionNav();
  }
  function showSummary(early){
    flushDays(); S.done=true;
    const st=S.stats, pct=st.asked?Math.round(100*st.first/Math.max(1,st.asked-st.learned)):0;
    $("se-coach").querySelectorAll(".ln,.prompt,.fb,.minimoves,.notecard,.warnbox").forEach(e=>e.hidden=true);
    const due=counts(ALLCARDS).due;
    const sum=$("se-sum"); sum.hidden=false;
    const missedList=[...S.missed].map(c=>{ const ln=LINES[CARD_LINES[c][0]], x=ln.cards.find(y=>y.c===c); return ln.id+" "+moveNo(x.p)+CARDS[c].s; });
    sum.innerHTML='<h2 style="margin-bottom:12px">'+(early?"Session ended":"Session complete")+'</h2>'+
      '<div class="sumgrid"><div><b>'+(st.asked-st.learned)+'</b><span>moves tested</span></div><div><b>'+(st.asked-st.learned?pct+"%":"–")+'</b><span>found first try</span></div><div><b>'+st.learned+'</b><span>new moves learned</span></div></div>'+
      (missedList.length?'<p class="note" style="margin-top:14px">Missed: <span class="minimoves">'+missedList.map(esc).join(" · ")+'</span></p>':"")+
      '<p class="note muted" style="margin-top:10px;font-size:14px">'+(due?due+" move"+(due>1?"s are":" is")+" still due.":"Nothing else is due right now.")+'</p>';
    const acts=[];
    if(S.missed.size) acts.push({label:"Drill missed moves now",primary:true,fn:()=>{ const cards=[...S.missed]; endSession(); startSession("redo",{cards}); }});
    if(S.kind==="learn"){ const nl=nextLearnLine(learnSec); if(nl) acts.push({label:"Learn next: "+nl.id,primary:!S.missed.size,fn:()=>{ endSession(); startSession("learn"); }}); }
    if(due && S.kind!=="review") acts.push({label:"Review due moves",fn:()=>{ endSession(); startSession("review"); }});
    acts.push({label:"Done",fn:endSession});
    $("se-act").hidden=false; setCoach({acts});
    $("se-prog").style.width="100%";
  }

  /* ---------- STUDY ---------- */
  const stb=new Board($("s-board"));
  let study={sec:"A", path:[], fullPath:[], flipped:false};   // path: list of edge uci from the section start
  try{ const s=JSON.parse(localStorage.getItem("rt2-study")||"{}"); if(s.sec&&SECBY[s.sec]) study.sec=s.sec; if(Array.isArray(s.path)){ study.path=s.path; study.fullPath=s.path.slice(); } }catch(_){}
  function saveStudy(){ try{ localStorage.setItem("rt2-study",JSON.stringify({sec:study.sec,path:study.path})); }catch(_){} }
  function studyRootPath(){ const sec=SECBY[study.sec]; const ln=LINES[sec.lines[0]]; return {pos:ln.pos.slice(0,sec.startPly+1), san:ln.san.slice(0,sec.startPly), uci:ln.uci.slice(0,sec.startPly)}; }
  function studyWalk(path){ const root=studyRootPath(); let pi=root.pos[root.pos.length-1]; const nodes=[pi], sans=[]; for(const u of path){ const e=POS[pi].e.find(x=>x[0]===u); if(!e) break; sans.push(e[1]); pi=e[2]; nodes.push(pi); } return {root,nodes,sans,pi}; }
  function openStudyAt(li,p){ const ln=LINES[li], sec=SECBY[ln.sec]; study.sec=ln.sec; study.path=ln.uci.slice(sec.startPly,p); study.fullPath=study.path.slice(); study.flipped=false; saveStudy(); setTab("study"); }
  function mainEdge(pi){ const es=POS[pi].e; if(!es.length) return null; return es.slice().sort((a,b)=>((a[3]&2)-(b[3]&2))||(Math.min(...a[4])-Math.min(...b[4])))[0]; }
  function syncStudyFullPath(nextPath){
    const matches=study.fullPath.length>=nextPath.length && nextPath.every((u,i)=>study.fullPath[i]===u);
    if(!matches) study.fullPath=nextPath.slice();
  }
  function renderStudy(){
    secChips($("s-secs"),study.sec,id=>{ study.sec=id; study.path=[]; study.fullPath=[]; study.flipped=false; saveStudy(); renderStudy(); },false,null);
    renderStudyTree();
  }
  function renderStudyTree(){
    const sec=SECBY[study.sec], W=studyWalk(study.path); study.path=study.path.slice(0,W.sans.length);
    const pi=W.pi, node=POS[pi], fen=node.f;
    const baseColor=sec.color==="b"?"b":"w";
    stb.setOrient(study.flipped?(baseColor==="w"?"b":"w"):baseColor);
    const lastU=study.path.length?study.path[study.path.length-1]:(W.root.uci.length?W.root.uci[W.root.uci.length-1]:null);
    stb.set(fen,{last:lastU?[lastU.slice(0,2),lastU.slice(2,4)]:null,anim:!study.instant}); study.instant=false;
    stb.clearMarks(); const ck=checkSq(fen); if(ck) stb.mark(ck,"check");
    stb.dests=chessDests(fen); stb.movable=ownPiece(fen,stb);
    stb.onMove=(from,to)=>{ const r=tryMove(fen,from,to); if(!r) return; const u=r.uci.slice(0,4); const e=node.e.find(x=>x[0].slice(0,4)===u); if(e){ study.path.push(e[0]); syncStudyFullPath(study.path); saveStudy(); study.instant=true; renderStudyTree(); } else { exploreFrom(fen,[{san:r.m.san,from,to,uci:r.uci,fen:r.fen}],"Your move from "+sec.name); setTab("explore"); } };
    stb.clearArrows();
    const studyHabits=habitWarnsAtPos(pi);
    studyHabits.slice(0,2).forEach(h=>stb.arrow(h.uci.slice(0,2),h.uci.slice(2,4),"#e11d48",{width:15,opacity:0.7,dashed:true}));
    const me=mainEdge(pi);
    const drawn=new Set();
    for(const e of node.e){
      const key=e[0].slice(0,4);
      if(drawn.has(key)) continue;
      drawn.add(key);
      const isMain=me && e===me;
      const isMine=Boolean(e[3]&1);
      const col=isMain?(isMine?"#15781b":"#777"):(isMine?"#d97706":"#888");
      stb.arrow(e[0].slice(0,2),e[0].slice(2,4),col);
    }
    // header
    const ply=plyOfFen(fen);
    $("s-open").textContent=(sec.color==="w"?"White":"Black")+" · "+sec.group.split(" · ")[1];
    let nm=null; for(let k=W.nodes.length-1;k>=0&&!nm;k--) nm=openingName(W.nodes[k]); if(!nm) for(let k=W.root.pos.length-1;k>=0&&!nm;k--) nm=openingName(W.root.pos[k]);
    $("s-title").textContent=nm||sec.name;
    // notes: the move just played (yours or theirs) and the next repertoire move
    const notes=$("s-notes"); notes.innerHTML="";
    const prevPi=W.nodes.length>1?W.nodes[W.nodes.length-2]:null;
    const shownWarns=new Set();
    if(prevPi!==null){ const e=POS[prevPi].e.find(x=>x[0]===study.path[study.path.length-1]);
      if(e&&e[5]){ notes.insertAdjacentHTML("beforeend",'<p class="note"><b>'+esc(moveNo(ply-1)+e[1])+'</b> '+esc(CARDS[e[5]].n)+'</p>'); }
      const w=WARN[prevPi+"|"+study.path[study.path.length-1]];
      if(w){ shownWarns.add(w); notes.insertAdjacentHTML("beforeend",'<p class="warnbox">'+esc(w)+'</p>'); } }
    for(const h of studyHabits){
      if(!shownWarns.has(h.text)){
        shownWarns.add(h.text);
        notes.insertAdjacentHTML("beforeend",'<p class="warnbox">'+esc(h.text)+'</p>');
      }
    }
    const mine=node.e.filter(e=>e[3]&1);
    if(mine.length){ mine.forEach(e=>notes.insertAdjacentHTML("beforeend",'<div class="notecard"><span class="eyebrow">Your move here'+((e[3]&2)?" · Schliemann":"")+'</span><b style="font-family:var(--f-mono)">'+esc(moveNo(ply)+e[1])+'</b> '+esc(CARDS[e[5]].n)+'</div>')); }
    else if(node.e.length) notes.insertAdjacentHTML("beforeend",'<p class="note muted" style="font-size:14px">'+(sideToMove(fen)==="w"?"White":"Black")+' to move. Your repertoire covers '+node.e.map(e=>esc(e[1])).join(", ")+'.</p>');
    else notes.insertAdjacentHTML("beforeend",'<p class="note muted" style="font-size:14px">End of the prepared line. Use Analyze to keep going with the engine.</p>');
    // branch & transposition quick-switch chips
    const sbBox=$("s-sibs");
    if(sbBox){
      sbBox.innerHTML="";
      const branchEdges=node.e.length>1?node.e:[];
      const trans=[];
      const seenSec=new Set([study.sec]);
      for(const l of LINES){ if(!seenSec.has(l.sec) && l.pos.includes(pi)){ seenSec.add(l.sec); trans.push(l); } }
      if(branchEdges.length || trans.length){
        sbBox.hidden=false;
        const lbl=document.createElement("span"); lbl.className="sib-lbl";
        lbl.textContent=branchEdges.length?"Branches":"Transposes";
        sbBox.appendChild(lbl);
        branchEdges.forEach(e=>{
          const b=document.createElement("button"); b.type="button"; b.className="sib-chip";
          b.textContent=moveNo(ply)+e[1];
          b.onclick=()=>{ study.path=study.path.concat([e[0]]); syncStudyFullPath(study.path); saveStudy(); study.instant=true; renderStudyTree(); };
          sbBox.appendChild(b);
        });
        trans.forEach(l=>{
          const s2=SECBY[l.sec];
          const b=document.createElement("button"); b.type="button"; b.className="sib-chip";
          b.textContent="⇄ "+(s2?s2.name:l.name);
          b.onclick=()=>{ const idx=l.pos.indexOf(pi); openStudyAt(l.i,idx>=0?idx:0); };
          sbBox.appendChild(b);
        });
      } else {
        sbBox.hidden=true;
      }
    }
    // lines through this node
    const lc=$("s-lines"); lc.innerHTML=""; const ids=new Set(); LINES.forEach(l=>{ if(l.pos.includes(pi)&&l.sec===study.sec) ids.add(l.i); });
    [...ids].forEach(i=>{ const s=document.createElement("span"); s.className="lchip"; s.textContent=LINES[i].id+" "+LINES[i].name; lc.appendChild(s); });
    $("s-prefix").textContent=W.root.san.length?W.root.san.map((s,k)=>(k%2===0?(k/2+1)+".":"")+s).join(" "):"";
    // tree
    const tree=$("s-tree"); tree.innerHTML=""; const rootPi=W.root.pos[W.root.pos.length-1];
    const seen=new Set();
    const curPath=study.path.join(" ");
    function tok(e,path,ply,force){ const b=document.createElement("button"); b.className="mv"+((e[3]&1)?" me":"")+(path.join(" ")===curPath?" cur":"");
      b.innerHTML=((ply%2===0||force)?'<span class="n">'+moveNo(ply)+'</span>':"")+esc(e[1])+(e[5]?'<i class="dot '+status(e[5])+'"></i>':"");
      b.onclick=()=>{ study.path=path; syncStudyFullPath(path); saveStudy(); renderStudyTree(); }; return b; }
    function walk(pi,path,ply,container,force){
      let line=document.createElement("span"); line.className="vline"; container.appendChild(line);
      let first=true;
      while(true){
        const es=POS[pi].e; if(!es.length) break;
        if(seen.has(pi)){ const t=document.createElement("span"); t.className="tp"; t.textContent=" (transposes to a line above)"; line.appendChild(t); break; }
        seen.add(pi);
        const sorted=es.slice().sort((a,b)=>((a[3]&2)-(b[3]&2))||(Math.min(...a[4])-Math.min(...b[4])));
        const m=sorted[0];
        line.appendChild(tok(m,path.concat([m[0]]),ply,first||force)); line.appendChild(document.createTextNode(" "));
        force=false; first=false;
        if(sorted.length>1){
          for(const v of sorted.slice(1)){ const vd=document.createElement("div"); vd.className="var"; container.appendChild(vd); const vl=document.createElement("span"); vl.className="vline"; vd.appendChild(vl); vl.appendChild(tok(v,path.concat([v[0]]),ply,true)); vl.appendChild(document.createTextNode(" ")); walkCont(v[2],path.concat([v[0]]),ply+1,vd,vl); }
          line=document.createElement("span"); line.className="vline"; container.appendChild(line); force=true;
        }
        path=path.concat([m[0]]); pi=m[2]; ply++;
      }
    }
    function walkCont(pi,path,ply,container,line){
      // continue a variation on the same visual line, nesting further branches
      let force=false;
      while(true){
        const es=POS[pi].e; if(!es.length) return;
        if(seen.has(pi)){ const t=document.createElement("span"); t.className="tp"; t.textContent=" (transposes)"; line.appendChild(t); return; }
        seen.add(pi);
        const sorted=es.slice().sort((a,b)=>((a[3]&2)-(b[3]&2))||(Math.min(...a[4])-Math.min(...b[4])));
        const m=sorted[0];
        line.appendChild(tok(m,path.concat([m[0]]),ply,force)); line.appendChild(document.createTextNode(" ")); force=false;
        if(sorted.length>1){
          for(const v of sorted.slice(1)){ const vd=document.createElement("div"); vd.className="var"; container.appendChild(vd); const vl=document.createElement("span"); vl.className="vline"; vd.appendChild(vl); vl.appendChild(tok(v,path.concat([v[0]]),ply,true)); vl.appendChild(document.createTextNode(" ")); walkCont(v[2],path.concat([v[0]]),ply+1,vd,vl); }
          line=document.createElement("span"); line.className="vline"; container.appendChild(line); force=true;
        }
        path=path.concat([m[0]]); pi=m[2]; ply++;
      }
    }
    walk(rootPi,[],plyOfFen(POS[rootPi].f),tree,true);
    const cur=tree.querySelector(".cur");
    if(cur && tree.scrollHeight > tree.clientHeight){
      const cr=tree.getBoundingClientRect(), er=cur.getBoundingClientRect();
      if(er.top < cr.top) tree.scrollTop -= (cr.top - er.top + 6);
      else if(er.bottom > cr.bottom) tree.scrollTop += (er.bottom - cr.bottom + 6);
    }
    // engine panel
    const t=TH[node.t]||{alts:[]};
    $("s-eval").textContent=fmtEv(t.ev); $("s-eval").className="evalchip"+(evNeg(t.ev)?" neg":"");
    $("s-pv").innerHTML=t.alts&&t.alts.length?"Best line: "+fmtPv(t.alts[0].pv,ply):"No engine data.";
    const al=$("s-alts"); al.innerHTML="";
    (t.alts||[]).forEach(a=>{ const inRep=node.e.find(e=>e[0].slice(0,4)===a.uci.slice(0,4)); const d=document.createElement("div"); d.className="alt";
      d.innerHTML='<span class="m">'+esc(moveNo(ply)+a.san)+'</span><span class="e">'+fmtEv(a.ev)+'</span><span>'+(inRep?'<span class="tag here">In repertoire</span> ':node.e.length&&!mine.length?'<span class="tag gap">Not prepared</span> ':"")+(a.name?'<span class="muted" style="font-size:12.5px">'+esc(a.name)+'</span>':"")+'</span><span class="pvs">'+fmtPv(a.pv.slice(1,7),ply+1)+'</span>'; al.appendChild(d); });
    const hasFullFwd=study.fullPath.length>study.path.length && study.path.every((u,i)=>study.fullPath[i]===u);
    $("s-first").disabled=$("s-back").disabled=!study.path.length;
    $("s-fwd").disabled=!hasFullFwd && !node.e.length;
    $("s-last").disabled=!hasFullFwd && !node.e.length;
  }
  $("s-first").onclick=()=>{ if(!study.path.length) return; syncStudyFullPath(study.path); study.path=[]; saveStudy(); renderStudyTree(); };
  $("s-back").onclick=()=>{ if(!study.path.length) return; syncStudyFullPath(study.path); study.path.pop(); saveStudy(); renderStudyTree(); };
  $("s-fwd").onclick=()=>{
    const hasFullFwd=study.fullPath.length>study.path.length && study.path.every((u,i)=>study.fullPath[i]===u);
    if(hasFullFwd){ study.path=study.fullPath.slice(0,study.path.length+1); saveStudy(); renderStudyTree(); return; }
    const W=studyWalk(study.path); const m=mainEdge(W.pi); if(m){ study.path.push(m[0]); syncStudyFullPath(study.path); saveStudy(); renderStudyTree(); }
  };
  $("s-last").onclick=()=>{
    const hasFullFwd=study.fullPath.length>study.path.length && study.path.every((u,i)=>study.fullPath[i]===u);
    if(hasFullFwd){ study.path=study.fullPath.slice(); saveStudy(); renderStudyTree(); return; }
    const W=studyWalk(study.path); let curPi=W.pi; const seenPi=new Set(W.nodes);
    while(true){ const m=mainEdge(curPi); if(!m||seenPi.has(m[2])) break; study.path.push(m[0]); curPi=m[2]; seenPi.add(curPi); }
    syncStudyFullPath(study.path); saveStudy(); renderStudyTree();
  };
  $("s-flip").onclick=()=>{ study.flipped=!study.flipped; renderStudyTree(); };
  $("s-drill").onclick=()=>{ const W=studyWalk(study.path); const sec=SECBY[study.sec]; startSession("play",{sec:study.sec,pos:W.pi,color:sec.color,prefix:W.root.san.concat(W.sans)}); };
  $("s-an").onclick=()=>{ const W=studyWalk(study.path); exploreFrom(POS[W.pi].f,[],openingName(W.pi)||SECBY[study.sec].name); an.flip=SECBY[study.sec].color==="b"; setTab("explore"); };
  $("s-vs").onclick=()=>{ const W=studyWalk(study.path); const c=SECBY[study.sec].color; exploreFrom(POS[W.pi].f,[],openingName(W.pi)||SECBY[study.sec].name); an.flip=c==="b"; an.vs=c; setTab("explore"); };
  document.addEventListener("keydown",e=>{
    if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if(S && !S.done){
      if(e.key==="ArrowLeft"){ $("se-prev").click(); e.preventDefault(); }
      else if(e.key==="ArrowRight"){ $("se-next").click(); e.preventDefault(); }
      else if((e.key==="Enter"||e.key===" ") && S.run && S.run.pendingAdvance){ $("se-next").click(); e.preventDefault(); }
      else if(e.key==="Home"){ $("se-first").click(); e.preventDefault(); }
      else if(e.key==="End"){ $("se-last").click(); e.preventDefault(); }
      else if(e.key==="f"||e.key==="F"){ $("se-flip").click(); e.preventDefault(); }
      return;
    }
    if(S) return;
    if(tab==="study"){
      if(e.key==="ArrowLeft"){ $("s-back").click(); e.preventDefault(); }
      else if(e.key==="ArrowRight"){ $("s-fwd").click(); e.preventDefault(); }
      else if(e.key==="Home"){ $("s-first").click(); e.preventDefault(); }
      else if(e.key==="End"){ $("s-last").click(); e.preventDefault(); }
      else if(e.key==="f"||e.key==="F"){ $("s-flip").click(); e.preventDefault(); }
    }
    if(tab==="explore"){
      if(e.key==="ArrowLeft"){ anGo(an.idx-1); e.preventDefault(); }
      else if(e.key==="ArrowRight"){ anGo(an.idx+1); e.preventDefault(); }
      else if(e.key==="Home"){ anGo(0); e.preventDefault(); }
      else if(e.key==="End"){ anGo(an.moves.length); e.preventDefault(); }
      else if(e.key==="f"||e.key==="F"){ $("x-flip").click(); e.preventDefault(); }
    }
  });

  /* ---------- EXPLORE (live engine) ---------- */
  const xb=new Board($("x-board"));
  const an={start:START,moves:[],idx:0,flip:false,label:"Starting position",vs:null};
  const VSLVL={easy:{skill:3,ms:300},club:{skill:10,ms:700},strong:{skill:20,ms:1500}};
  try{ const l=localStorage.getItem("rt2-vslvl"); if(l&&VSLVL[l]) setTimeout(()=>{ $("x-lvl").value=l; },0); }catch(_){}
  function movesFromSan(sans){ const g=new Chess(), out=[]; for(const s of sans){ let m; try{ m=g.move(s); }catch(_){ return null; } if(!m) return null; out.push({san:m.san,from:m.from,to:m.to,uci:m.from+m.to+(m.promotion||""),fen:g.fen()}); } return out; }
  /* Leave a training session for Explore at the current position, with the game so far on the sheet. */
  function sessionToExplore(sans,fen,color,label,vs){
    const mv=movesFromSan(sans);
    if(mv&&mv.length&&mv[mv.length-1].fen.split(" ").slice(0,4).join(" ")===fen.split(" ").slice(0,4).join(" ")) exploreFrom(START,mv,label); else exploreFrom(fen,[],label);
    an.flip=color==="b"; an.vs=vs?color:null;
    endSession(); setTab("explore");
  }
  function anFen(){ return an.idx===0?an.start:an.moves[an.idx-1].fen; }
  function exploreFrom(fen,moves,label){ an.start=fen; an.moves=moves||[]; an.idx=an.moves.length; an.label=label||"Analysis"; an.flip=sideToMove(fen)==="b"; an.vs=null; }
  function anPlay(from,to,promo){ const r=tryMove(anFen(),from,to,promo); if(!r) return; an.moves=an.moves.slice(0,an.idx).concat([{san:r.m.san,from,to,uci:r.uci,fen:r.fen}]); an.idx++; an.instant=true; renderExplore(); }
  function anGo(i){ an.idx=Math.max(0,Math.min(an.moves.length,i)); renderExplore(); }
  function renderExplore(){
    const fen=anFen();
    xb.setOrient(an.flip?"b":"w");
    const last=an.idx>0?[an.moves[an.idx-1].from,an.moves[an.idx-1].to]:null;
    xb.set(fen,{last,anim:!an.instant}); an.instant=false; xb.clearMarks(); const ck=checkSq(fen); if(ck) xb.mark(ck,"check");
    const engTurn=!!an.vs && sideToMove(fen)!==an.vs && an.idx===an.moves.length;
    xb.dests=chessDests(fen); xb.movable=engTurn?()=>false:ownPiece(fen,xb); xb.onMove=(f,t)=>anPlay(f,t);
    $("x-title").textContent=an.label;
    const sh=$("x-sheet"); sh.innerHTML=""; let ply=plyOfFen(an.start);
    if(!an.moves.length) sh.innerHTML='<span class="muted" style="font-size:14px">Move a piece to start a variation.</span>';
    an.moves.forEach((m,k)=>{ if(ply%2===0||k===0){ const n=document.createElement("span"); n.className="n"; n.textContent=moveNo(ply); sh.appendChild(n); } const b=document.createElement("button"); b.className="mv"+(an.idx===k+1?" cur":""); b.textContent=m.san; b.onclick=()=>anGo(k+1); sh.appendChild(b); ply++; });
    $("x-prev").disabled=$("x-start").disabled=an.idx===0;
    $("x-next").disabled=$("x-last").disabled=an.idx===an.moves.length;
    if(an.vs){ if(engTurn && !new Chess(fen).isGameOver()) engPlay(fen); else engStop(); } else engAnalyze(fen);
    renderLive();
  }
  function vsToggle(){
    if(an.vs){ an.vs=null; engStop(); renderExplore(); return; }
    an.vs=an.flip?"b":"w"; engInit(ENG.failed); renderExplore();
  }
  $("x-vs").onclick=vsToggle;
  $("x-lvl").onchange=e=>{ try{ localStorage.setItem("rt2-vslvl",e.target.value); }catch(_){} };
  $("x-start").onclick=()=>anGo(0); $("x-prev").onclick=()=>anGo(an.idx-1); $("x-next").onclick=()=>anGo(an.idx+1); $("x-last").onclick=()=>anGo(an.moves.length);
  $("x-reset").onclick=()=>{ exploreFrom(START,[],"Starting position"); an.flip=false; renderExplore(); };
  $("x-flip").onclick=()=>{ an.flip=!an.flip; if(an.vs) an.vs=an.flip?"b":"w"; renderExplore(); };
  const ENG={w:null,ready:false,failed:false,loading:false,on:true,searching:false,pending:null,fen:null,lines:[],depth:0,raf:0,kind:"",threads:1,err:"",note:"",playing:false,playFen:null,pendingPlay:null};
  function engPost(c){ try{ ENG.w.postMessage(c); }catch(_){} }
  async function engInit(forceRetry=false){
    if(ENG.ready||ENG.loading) return;
    if(ENG.failed && !forceRetry) return;
    ENG.failed=false; ENG.err=""; ENG.loading=true; ENG.note="Starting Stockfish 19 Lite…"; renderLive();
    const canMt=typeof crossOriginIsolated!=="undefined" && crossOriginIsolated===true && typeof SharedArrayBuffer!=="undefined";
    const threads=canMt?Math.min(4,Math.max(1,(navigator.hardwareConcurrency||2)-1)):1;
    try{
      if(canMt && threads>1){
        try{ await engBoot(STOCKFISH_MT_URL,threads,6000); }
        catch(_){ ENG.note="Switching to single-threaded Stockfish…"; renderLive(); await engBoot(STOCKFISH_ST_URL,1,30000); }
      } else {
        await engBoot(STOCKFISH_ST_URL,1,30000);
      }
    }catch(e){ ENG.failed=true; ENG.err=String((e&&e.message)||e).slice(0,200); }
    ENG.loading=false; renderLive();
  }
  function engBoot(url,threads,timeoutMs){
    return new Promise((res,rej)=>{
      let w,to,gotUciOk=false;
      try{ w=new Worker(url); }catch(e){ return rej(e); }
      const fail=m=>{ clearTimeout(to); try{ w.terminate(); }catch(_){} rej(new Error(m)); };
      to=setTimeout(()=>fail("no answer from the engine"),timeoutMs||30000);
      w.onmessage=e=>{
        const msg=String(e.data||"");
        if(msg==="uciok" && !gotUciOk){
          gotUciOk=true;
          if(threads>1){ w.postMessage("setoption name Threads value "+threads); w.postMessage("setoption name Hash value 32"); }
          w.postMessage("setoption name MultiPV value 3");
          w.postMessage("isready");
          return;
        }
        if(msg==="readyok" && gotUciOk){
          clearTimeout(to);
          ENG.w=w; ENG.ready=true; ENG.kind=threads>1?"wasm-mt":"wasm"; ENG.threads=threads;
          w.onmessage=ev=>engMsg(String(ev.data||""));
          if(tab==="explore") renderExplore();
          res();
        }
      };
      w.onerror=ev=>{ ev.preventDefault&&ev.preventDefault(); fail((ev&&ev.message)||"engine worker error"); };
      w.postMessage("uci");
    });
  }
  function engMsg(s){
    if(s==="readyok"){ if(tab==="explore") renderExplore(); return; }
    if(s.startsWith("bestmove")){
      ENG.searching=false;
      if(ENG.playing){ ENG.playing=false; engPost("setoption name Skill Level value 20"); engPost("setoption name MultiPV value 3");
        const bm=s.split(" ")[1], f=ENG.playFen; ENG.playFen=null;
        if(ENG.pendingPlay){ const p=ENG.pendingPlay; ENG.pendingPlay=null; engPlay(p); return; }
        if(ENG.pending){ const p=ENG.pending; ENG.pending=null; engStart(p); return; }
        if(an.vs && tab==="explore" && bm && bm!=="(none)" && f===anFen() && an.idx===an.moves.length){ anPlay(bm.slice(0,2),bm.slice(2,4),bm[4]); return; }
        renderLive(); return; }
      if(ENG.pendingPlay){ const p=ENG.pendingPlay; ENG.pendingPlay=null; ENG.pending=null; engPlay(p); return; }
      if(ENG.pending){ const f=ENG.pending; ENG.pending=null; engStart(f); } else renderLive(); return; }
    if(ENG.playing) return;
    if(!s.startsWith("info")||ENG.pending||!s.includes(" pv ")) return;
    const tok=s.split(" "), get=k=>{ const i=tok.indexOf(k); return i<0?null:tok[i+1]; };
    const depth=+get("depth"), mpv=+(get("multipv")||1), ti=tok.indexOf("score"); if(ti<0) return;
    let v=tok[ti+1]==="cp"?+tok[ti+2]/100:(tok[ti+2]>0?"#":"#-")+Math.abs(+tok[ti+2]);
    if(ENG.fen.split(" ")[1]==="b") v=typeof v==="number"?-v:(v.startsWith("#-")?"#"+v.slice(2):"#-"+v.slice(1));
    ENG.lines[mpv-1]={v,pv:tok.slice(tok.indexOf("pv")+1),depth}; ENG.depth=Math.max(ENG.depth,depth);
    if(!ENG.raf) ENG.raf=requestAnimationFrame(()=>{ ENG.raf=0; renderLive(); });
  }
  function engStart(fen){ ENG.fen=fen; ENG.lines=[]; ENG.depth=0; ENG.searching=true; engPost("position fen "+fen); engPost("go depth 24"); renderLive(); }
  function engAnalyze(fen,force){
    if(!ENG.ready||!ENG.on) return;
    if(ENG.playing){ ENG.pending=fen; ENG.pendingPlay=null; ENG.playFen=null; engPost("stop"); return; }
    if(!force&&fen===ENG.fen&&(ENG.searching||ENG.lines.length)) return;
    if(ENG.searching){ ENG.pending=fen; ENG.fen=fen; ENG.lines=[]; engPost("stop"); } else engStart(fen);
  }
  function engStop(){ ENG.pendingPlay=null; if(ENG.searching){ ENG.pending=null; if(ENG.playing) ENG.playFen=null; engPost("stop"); } }
  function engPlay(fen){
    if(!ENG.ready) return;
    if(ENG.playing && ENG.playFen===fen) return;
    if(ENG.searching){ ENG.pendingPlay=fen; ENG.pending=null; if(ENG.playing) ENG.playFen=null; engPost("stop"); return; }
    const L=VSLVL[$("x-lvl").value]||VSLVL.club;
    ENG.playing=true; ENG.playFen=fen; ENG.searching=true; ENG.lines=[]; ENG.fen=null;
    engPost("setoption name MultiPV value 1"); engPost("setoption name Skill Level value "+L.skill);
    engPost("position fen "+fen); engPost("go movetime "+L.ms); renderLive();
  }
  function uciToSan(fen,pv,n){ const g=new Chess(fen), out=[]; for(const u of pv.slice(0,n)){ let m; try{ m=g.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"}); }catch(_){ break; } if(!m) break; out.push(m.san); } return out; }
  function appendRetryEngineBtn(box){
    const b=document.createElement("button"); b.className="btn"; b.style.marginTop="6px"; b.textContent="Retry Stockfish";
    b.onclick=()=>engInit(true);
    box.appendChild(b);
  }
  function renderLive(){
    if(tab!=="explore") return;
    const fen=anFen(), g=new Chess(fen), NAME=ENG.threads>1?("Stockfish 19 Lite MT ("+ENG.threads+"T)"):"Stockfish 19 Lite";
    $("x-toggle").textContent=ENG.on?"Pause":"Resume";
    const box=$("x-lines"); box.innerHTML="";
    const vsOn=!!an.vs; $("x-vs").textContent=vsOn?"Stop and analyze":"Play vs Stockfish"; $("x-vs").className="btn"+(vsOn?"":" primary");
    $("x-toggle").hidden=vsOn; $("x-help").hidden=vsOn;
    $("x-vsstate").textContent=vsOn?("You play "+(an.vs==="w"?"White":"Black")+". Analysis is hidden until you stop. Use ◀ to take back."):"Practice this position: play it out against Stockfish.";
    if(vsOn && !g.isGameOver()){
      $("x-eval").textContent="vs"; $("x-eval").className="evalchip";
      if(ENG.failed){ $("x-head").textContent="Live engine unavailable"; $("x-status").textContent="Stockfish could not start ("+(ENG.err||"worker blocked")+")."; appendRetryEngineBtn(box); return; }
      if(!ENG.ready){ $("x-head").textContent="Stockfish · starting"; $("x-status").textContent=ENG.note||"Loading the engine in your browser."; return; }
      const myTurn=sideToMove(fen)===an.vs;
      $("x-head").textContent="Playing Stockfish · "+$("x-lvl").selectedOptions[0].textContent;
      $("x-status").textContent=an.idx<an.moves.length?"You stepped back. Make a move here to continue from this point.":myTurn?"Your move.":"Stockfish is thinking…";
      return;
    }
    if(g.isGameOver()){ $("x-eval").textContent=g.isCheckmate()?(g.turn()==="w"?"0-1":"1-0"):"½-½"; $("x-eval").className="evalchip"; $("x-head").textContent="Game over"; $("x-status").textContent=g.isCheckmate()?"Checkmate.":"Draw."; return; }
    if(ENG.failed){ $("x-eval").textContent="–"; $("x-head").textContent="Live engine unavailable"; $("x-status").textContent="Stockfish could not start ("+(ENG.err||"worker blocked")+"). The Study tab still has the stored engine lines."; appendRetryEngineBtn(box); return; }
    if(!ENG.ready){ $("x-eval").textContent="…"; $("x-head").textContent="Stockfish · starting"; $("x-status").textContent=ENG.note||"Loading the engine in your browser."; return; }
    if(!ENG.on){ $("x-head").textContent=NAME+" · paused"; $("x-status").textContent="Press Resume to analyze."; return; }
    const lines=ENG.lines.filter(Boolean), top=lines[0];
    $("x-eval").textContent=top?fmtEv(top.v):"…"; $("x-eval").className="evalchip"+(top&&evNeg(top.v)?" neg":"");
    $("x-head").textContent=NAME+" · depth "+(ENG.depth||"…")+(ENG.searching?"":" · done");
    $("x-status").innerHTML=top?fmtPv(uciToSan(fen,top.pv,10),plyOfFen(fen)):"Thinking…";
    lines.forEach(l=>{ const b=document.createElement("button"); b.className="lline"; b.innerHTML='<span class="e">'+fmtEv(l.v)+'</span><span class="pv">'+fmtPv(uciToSan(fen,l.pv,8),plyOfFen(fen))+'</span>'; b.onclick=()=>anPlay(l.pv[0].slice(0,2),l.pv[0].slice(2,4),l.pv[0][4]); box.appendChild(b); });
  }
  $("x-toggle").onclick=()=>{ ENG.on=!ENG.on; if(ENG.on) engAnalyze(anFen(),true); else engStop(); renderLive(); };

  /* ---------- STATS ---------- */
  function renderStats(){
    const c=counts(ALLCARDS);
    $("st-tot").innerHTML='<span><b>'+ALLCARDS.length+'</b> moves in your repertoire</span><span><b>'+c.mastered+'</b> mastered</span><span><b>'+c.learning+'</b> learning</span><span><b>'+c.due+'</b> due</span><span><b>'+c.new+'</b> new</span>';
    const ops=$("st-ops"); ops.innerHTML="";
    SECS.forEach(s=>{ const cs=secCards(s.id), k=counts(cs); const row=document.createElement("div"); row.className="oprow";
      row.innerHTML='<div><div class="nm">'+(s.color==="w"?"♙ ":"♟ ")+esc(s.name)+'</div><div class="ct">'+k.mastered+' mastered · '+k.learning+' learning · '+k.due+' due · '+k.new+' new</div></div><div class="bar">'+barHtml(k,cs.length)+'</div>';
      const a=document.createElement("div"); a.className="row";
      const b1=document.createElement("button"); b1.className="btn"; b1.textContent="Study"; b1.onclick=()=>{ study.sec=s.id; study.path=[]; saveStudy(); setTab("study"); };
      const b2=document.createElement("button"); b2.className="btn"+(k.new?" primary":""); b2.textContent=k.new?"Learn":"Play"; b2.onclick=()=>{ if(k.new){ learnSec=s.id; saveTrain(); startSession("learn"); } else startSession("play",{sec:s.id}); };
      a.append(b1,b2); row.appendChild(a); ops.appendChild(row); });
    const days=(prog.days&&prog.days.d)||{}, box=$("st-days"); box.innerHTML=""; let mx=1; const arr=[];
    for(let i=13;i>=0;i--){ const t=now()-i*DAY, k=dayKey(t), x=days[k]||{n:0,ok:0}; arr.push([t,x]); mx=Math.max(mx,x.n); }
    arr.forEach(([t,x])=>{ const d=document.createElement("div"); d.innerHTML='<i class="'+(x.n?"":"z")+'" style="height:'+(x.n?Math.max(4,60*x.n/mx):2)+'px" title="'+x.n+' moves, '+x.ok+' first try"></i><span>'+new Date(t).getDate()+'</span>'; box.appendChild(d); });
    const wk=$("st-weak"); wk.innerHTML=""; const weak=weakCards();
    if(!weak.length) wk.innerHTML='<p class="note muted" style="font-size:14px">No misses recorded yet.</p>';
    weak.slice(0,12).forEach(c=>{ const ln=LINES[CARD_LINES[c][0]], x=ln.cards.find(y=>y.c===c); const b=document.createElement("button"); b.className="wchip"; b.textContent=ln.id+" "+moveNo(x.p)+CARDS[c].s+" ×"+prog[c].l; b.onclick=()=>openStudyAt(ln.i,x.p); wk.appendChild(b); });
    $("set-sound").checked=SET.sound; $("set-notes").checked=SET.notes; $("set-coords").checked=SET.coords;
  }
  $("set-sound").onchange=e=>{ SET.sound=e.target.checked; saveSet(); };
  $("set-notes").onchange=e=>{ SET.notes=e.target.checked; saveSet(); };
  $("set-coords").onchange=e=>{ SET.coords=e.target.checked; saveSet(); [sb,stb,xb].forEach(b=>{ b.buildSquares(); b.paint(); }); };

  /* ---------- open in the tichess analysis studio ---------- */
  function openInAnalysis(startFen,ucis,flipped,title){
    const url="./"+encodeMoveLine(startFen,ucis,{flipped,title});
    const w=window.open(url,"_blank"); if(w) w.opener=null; else window.location.href=url;
  }
  $("s-tichess").onclick=()=>{ const root=studyRootPath(); openInAnalysis(START,root.uci.concat(study.path),SECBY[study.sec].color==="b",$("s-title").textContent); };
  $("x-tichess").onclick=()=>{ openInAnalysis(an.start,an.moves.slice(0,an.idx).map(m=>m.uci||(m.from+m.to)),an.flip,an.label); };

  /* ---------- boot ---------- */
  let startTab="train"; try{ startTab=localStorage.getItem("rt2-tab")||"train"; }catch(_){}
  setTab(["train","study","explore","stats"].includes(startTab)?startTab:"train");
  initStore();

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("prep") === "1") {
      const raw = localStorage.getItem(PREP_DRILL_STORAGE_KEY);
      if (raw) {
        const spec = JSON.parse(raw);
        const valid = Array.isArray(spec?.cardIds) ? spec.cardIds.filter((c) => CARDS[c]) : [];
        if (valid.length) {
          startSession("prep", {
            cards: valid,
            mode: spec.mode === "learn" ? "learn" : "review",
            title: spec.title || (spec.opponentName ? `Prep vs ${spec.opponentName}` : "Opponent Prep"),
          });
        }
      }
    }
  } catch (_) {}
}
