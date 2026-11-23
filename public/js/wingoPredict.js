(function () {
'use strict';

// ══════════════════════════════════════════════════════════════════
// WINGO SMART AI v3.0  —  Prediction + Auto-Bet Integration
// ══════════════════════════════════════════════════════════════════

// ── Color / size maps ──────────────────────────────────────────────
var COLOR_MAP = {
  0:'red-violet',1:'green',2:'red',3:'green',4:'red',
  5:'green-violet',6:'red',7:'green',8:'red',9:'green'
};
var SIZE_MAP = {
  0:'small',1:'small',2:'small',3:'small',4:'small',
  5:'big',  6:'big',  7:'big',  8:'big',  9:'big'
};
var COLOR_LABEL = {
  'red':'Red','green':'Green','red-violet':'Red+Violet',
  'green-violet':'Green+Violet','violet':'Violet'
};
var COLOR_CSS = {
  'red':'#e94560','green':'#4caf50',
  'red-violet':'linear-gradient(135deg,#e94560 50%,#9c27b0 50%)',
  'green-violet':'linear-gradient(135deg,#4caf50 50%,#9c27b0 50%)',
  'violet':'#9c27b0'
};

// ── Math helpers ───────────────────────────────────────────────────
function normalize(arr){
  var sum=arr.reduce(function(a,b){return a+b;},0);
  if(sum===0)return arr.map(function(){return 0.1;});
  return arr.map(function(v){return v/sum;});
}
function clampPos(arr){return arr.map(function(v){return Math.max(0,v);});}
function topN(probs,n){
  return probs.map(function(p,i){return{num:i,prob:p};})
    .sort(function(a,b){return b.prob-a.prob;}).slice(0,n);
}

// ── 7 prediction signals ───────────────────────────────────────────
function markov1(h){
  var c=[];for(var n=0;n<10;n++)c.push(new Array(10).fill(0));
  for(var i=0;i<h.length-1;i++)c[h[i]][h[i+1]]++;
  var last=h[h.length-1],row=c[last],sum=row.reduce(function(a,b){return a+b;},0);
  return normalize(row.map(function(cv){return(cv+0.1)/(sum+1);}));
}
function markov2(h){
  var c={};
  for(var i=0;i<h.length-2;i++){
    var k=h[i]+'-'+h[i+1];if(!c[k])c[k]=new Array(10).fill(0);c[k][h[i+2]]++;
  }
  var len=h.length,prev=h[len-2],last=h[len-1];
  var row=c[prev+'-'+last]||new Array(10).fill(0);
  var sum=row.reduce(function(a,b){return a+b;},0);
  return normalize(row.map(function(cv){return(cv+0.1)/(sum+1);}));
}
function freqDev(h,w){
  var sl=h.slice(-w),f=new Array(10).fill(0);
  sl.forEach(function(n){f[n]++;});
  var exp=sl.length/10;
  return normalize(clampPos(f.map(function(fv){return(exp-fv)/(exp+1);})));
}
function gapScore(h){
  var ls=new Array(10).fill(-1);
  h.forEach(function(n,i){ls[n]=i;});
  var len=h.length;
  return normalize(clampPos(ls.map(function(v){return v===-1?2:(len-1-v)/10;})));
}
function streakPat(h){
  var s=new Array(10).fill(0);
  if(h.length<10)return normalize(s.map(function(){return 0.1;}));
  for(var len=2;len<=5;len++){
    var tail=h.slice(-(len-1)).join(',');
    for(var i=0;i<=h.length-len;i++){
      if(h.slice(i,i+len-1).join(',')===tail&&i+len-1<h.length)s[h[i+len-1]]+=1/len;
    }
  }
  var sum=s.reduce(function(a,b){return a+b;},0);
  if(sum===0)return new Array(10).fill(0.1);
  return normalize(s);
}
function hotCold(h){
  var hot=new Array(10).fill(0),cold=new Array(10).fill(0);
  h.slice(-20).forEach(function(n){hot[n]++;});
  h.slice(-100).forEach(function(n){cold[n]++;});
  return normalize(hot.map(function(hv,n){return(cold[n]===0?1:0)+(hv<2?0.5:0);}));
}
function moduloPat(h){
  var s=new Array(10).fill(0);
  if(h.length<6)return normalize(s.map(function(){return 0.1;}));
  var r=h.slice(-6);
  for(var step=1;step<=5;step++){
    var ok=true;
    for(var i=0;i<r.length-1;i++){if((r[i]+step)%10!==r[i+1]){ok=false;break;}}
    if(ok)s[(r[r.length-1]+step)%10]+=2;
  }
  var sum=s.reduce(function(a,b){return a+b;},0);
  if(sum===0)return new Array(10).fill(0.1);
  return normalize(s);
}
function ensembleSigs(sigs,wts){
  var out=new Array(10).fill(0),ws=wts.reduce(function(a,b){return a+b;},0);
  sigs.forEach(function(sig,s){var w=wts[s]/ws;sig.forEach(function(v,n){out[n]+=v*w;});});
  return normalize(out);
}
function colorConf(probs){
  var red=[0,2,4,6,8].reduce(function(s,n){return s+probs[n];},0);
  var green=[1,3,5,7,9].reduce(function(s,n){return s+probs[n];},0);
  var vio=[0,5].reduce(function(s,n){return s+probs[n];},0);
  return{winner:red>=green?'red':'green',confidence:Math.round(Math.max(red,green)*100),
         redPct:Math.round(red*100),greenPct:Math.round(green*100),violetPct:Math.round(vio*100)};
}
function sizeConf(probs){
  var big=[5,6,7,8,9].reduce(function(s,n){return s+probs[n];},0);
  var sml=[0,1,2,3,4].reduce(function(s,n){return s+probs[n];},0);
  return{winner:big>=sml?'big':'small',confidence:Math.round(Math.max(big,sml)*100)};
}
function predictWindow(h){
  if(h.length<5)return null;
  var ratio=Math.min(h.length/200,1);
  var sigs=[markov1(h),markov2(h),freqDev(h,Math.min(50,h.length)),
            gapScore(h),streakPat(h),hotCold(h),moduloPat(h)];
  var wts=[0.30*ratio+0.15,0.25*ratio+0.10,0.15,0.12,0.15,0.08,0.10];
  var probs=ensembleSigs(sigs,wts);
  var t3=topN(probs,3);
  var ws=wts.reduce(function(a,b){return a+b;},0);
  var labels=['markov1','markov2','freqDev','gap','streak','hotCold','modulo'];
  var sigW={};labels.forEach(function(l,i){sigW[l]=Math.round(wts[i]/ws*100);});
  return{probs:probs,top3:t3,color:colorConf(probs),size:sizeConf(probs),weights:sigW};
}
function multiPredict(history){
  var windows=[{sl:history.slice(-50),w:0.5},{sl:history.slice(-100),w:0.3},{sl:history,w:0.2}];
  var votes=new Array(10).fill(0),lastResult=null;
  windows.forEach(function(wnd){
    var r=predictWindow(wnd.sl);if(!r)return;lastResult=r;
    r.top3.forEach(function(t){votes[t.num]+=t.prob*wnd.w;});
  });
  if(!lastResult)return null;
  var probs=normalize(votes),t3=topN(probs,3);
  return{probs:probs,top1:t3[0],top3:t3,
         color:colorConf(probs),size:sizeConf(probs),weights:lastResult.weights};
}

// ── Global prediction state ────────────────────────────────────────
var _history       = [];
var _prediction    = null;
var _lastPeriod    = null;
var _busy          = false;
var _retryCount    = 0;
var _pendingPred   = null;   // prediction stored before next period reveals result
var _prevHistLen   = 0;      // history length last time we settled
var _accuracy      = {total:0,top1:0,color:0,size:0};

// ── Auto-bet config (persisted in localStorage) ───────────────────
var AB = {
  enabled:   false,
  strategy:  'COLOR',   // 'COLOR' | 'SIZE' | 'NUMBER'
  amount:    10,         // 10 | 100 | 1000
  minConf:   60,         // minimum confidence % to place bet
  betsTotal: 0,
  betsWon:   0
};
(function loadAB(){
  try{var s=localStorage.getItem('wp_ab');if(s){var p=JSON.parse(s);Object.assign(AB,p);}}catch(e){}
})();
function saveAB(){try{localStorage.setItem('wp_ab',JSON.stringify(AB));}catch(e){}}

// ── DOM helpers ────────────────────────────────────────────────────
function eid(id){return document.getElementById(id);}
function setText(id,v){var e=eid(id);if(e)e.textContent=v;}
function setHtml(id,h){var e=eid(id);if(e)e.innerHTML=h;}
function applyBg(el,color){
  if(!el)return;
  var css=COLOR_CSS[color]||'#888';el.style.background=css;
}

// ── Inject auto-bet UI into the prediction panel ──────────────────
function injectAutoBetUI(){
  var panel=eid('ai-predict-panel');
  if(!panel||eid('wp-autobet-ui'))return;

  var ui=document.createElement('div');
  ui.id='wp-autobet-ui';
  ui.style.cssText='margin-top:12px;padding-top:12px;border-top:1px solid #2a3a52';
  ui.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'+
      '<span style="font-size:12px;font-weight:700;color:#f0b429;letter-spacing:.5px">⚡ AUTO-BET ON SCREEN</span>'+
      '<button id="wp-toggle" style="'+
        'padding:4px 14px;border-radius:20px;border:none;cursor:pointer;font-size:11px;font-weight:700;'+
        'font-family:inherit;transition:all .2s;background:#1e2d40;color:#8899aa">OFF</button>'+
    '</div>'+
    // Strategy
    '<div style="margin-bottom:8px">'+
      '<div style="font-size:10px;color:#8899aa;margin-bottom:5px">STRATEGY</div>'+
      '<div style="display:flex;gap:6px">'+
        '<button class="wp-strat" data-s="COLOR"  style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">COLOR</button>'+
        '<button class="wp-strat" data-s="SIZE"   style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">SIZE</button>'+
        '<button class="wp-strat" data-s="NUMBER" style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">TOP1 №</button>'+
      '</div>'+
    '</div>'+
    // Amount
    '<div style="margin-bottom:8px">'+
      '<div style="font-size:10px;color:#8899aa;margin-bottom:5px">BET AMOUNT (₹)</div>'+
      '<div style="display:flex;gap:6px">'+
        '<button class="wp-amt" data-a="10"   style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">₹10</button>'+
        '<button class="wp-amt" data-a="100"  style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">₹100</button>'+
        '<button class="wp-amt" data-a="1000" style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">₹1K</button>'+
      '</div>'+
    '</div>'+
    // Min confidence
    '<div style="margin-bottom:10px">'+
      '<div style="font-size:10px;color:#8899aa;margin-bottom:5px">MIN CONFIDENCE</div>'+
      '<div style="display:flex;gap:6px">'+
        '<button class="wp-conf" data-c="50" style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">50%</button>'+
        '<button class="wp-conf" data-c="60" style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">60%</button>'+
        '<button class="wp-conf" data-c="70" style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">70%</button>'+
        '<button class="wp-conf" data-c="80" style="flex:1;padding:5px 0;border-radius:8px;border:1px solid #2a3a52;background:#0f1a2b;color:#8899aa;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer">80%</button>'+
      '</div>'+
    '</div>'+
    // Status + stats
    '<div style="display:flex;align-items:center;justify-content:space-between">'+
      '<div id="wp-status" style="font-size:11px;color:#8899aa;font-family:monospace">— Idle</div>'+
      '<div style="font-size:10px;color:#8899aa">W:<span id="wp-won" style="color:#3fb950">0</span> / T:<span id="wp-total">0</span></div>'+
    '</div>';

  panel.appendChild(ui);
  refreshAutoBetUI();
  bindAutoBetControls();
}

// ── Reflect AB state in UI ─────────────────────────────────────────
function refreshAutoBetUI(){
  var tog=eid('wp-toggle');
  if(tog){
    tog.textContent=AB.enabled?'ON':'OFF';
    tog.style.background=AB.enabled?'#e94560':'#1e2d40';
    tog.style.color=AB.enabled?'#fff':'#8899aa';
  }
  var ACTIVE='background:#e94560;color:#fff;border-color:#e94560';
  var IDLE='background:#0f1a2b;color:#8899aa;border:1px solid #2a3a52';
  document.querySelectorAll('.wp-strat').forEach(function(b){
    b.style.cssText='flex:1;padding:5px 0;border-radius:8px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;'+(b.dataset.s===AB.strategy?ACTIVE:IDLE);
  });
  document.querySelectorAll('.wp-amt').forEach(function(b){
    b.style.cssText='flex:1;padding:5px 0;border-radius:8px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;'+(Number(b.dataset.a)===AB.amount?ACTIVE:IDLE);
  });
  document.querySelectorAll('.wp-conf').forEach(function(b){
    b.style.cssText='flex:1;padding:5px 0;border-radius:8px;font-family:inherit;font-size:11px;font-weight:600;cursor:pointer;'+(Number(b.dataset.c)===AB.minConf?ACTIVE:IDLE);
  });
  setText('wp-won',   AB.betsWon);
  setText('wp-total', AB.betsTotal);
}
function setStatus(msg,color){
  var el=eid('wp-status');
  if(!el)return;
  el.textContent=msg;
  el.style.color=color||'#8899aa';
}

// ── Bind controls ──────────────────────────────────────────────────
function bindAutoBetControls(){
  var tog=eid('wp-toggle');
  if(tog)tog.addEventListener('click',function(){
    AB.enabled=!AB.enabled;saveAB();refreshAutoBetUI();
    setStatus(AB.enabled?'Waiting for new period…':'Stopped','');
  });
  document.querySelectorAll('.wp-strat').forEach(function(b){
    b.addEventListener('click',function(){AB.strategy=b.dataset.s;saveAB();refreshAutoBetUI();});
  });
  document.querySelectorAll('.wp-amt').forEach(function(b){
    b.addEventListener('click',function(){AB.amount=Number(b.dataset.a);saveAB();refreshAutoBetUI();});
  });
  document.querySelectorAll('.wp-conf').forEach(function(b){
    b.addEventListener('click',function(){AB.minConf=Number(b.dataset.c);saveAB();refreshAutoBetUI();});
  });
}

// ── Auto-bet: determine target button join value ───────────────────
// join codes: 'x'=green, 'd'=red, 't'=violet, 'l'=big, 'n'=small, '0'-'9'=number
function resolveJoin(pred){
  if(!pred)return null;
  if(AB.strategy==='COLOR'){
    var w=pred.color.winner;
    if(w==='red')  return 'd';
    if(w==='green')return 'x';
    return 'd'; // fallback
  }
  if(AB.strategy==='SIZE'){
    return pred.size.winner==='big'?'l':'n';
  }
  if(AB.strategy==='NUMBER'){
    return String(pred.top1.num);
  }
  return null;
}

// ── Confidence for selected strategy ──────────────────────────────
function stratConfidence(pred){
  if(!pred)return 0;
  if(AB.strategy==='COLOR')  return pred.color.confidence;
  if(AB.strategy==='SIZE')   return pred.size.confidence;
  if(AB.strategy==='NUMBER') return Math.round(pred.top1.prob*100);
  return 0;
}

// ── Check if betting is locked (last 5s blackout) ─────────────────
function isLocked(){
  // The existing wingo JS adds 'block-click' to .box during lockdown
  var box=document.querySelector('.box');
  if(box&&box.classList.contains('block-click'))return true;
  // Also check by reading the timer digits
  var d3=document.querySelector('.number .item:eq(3), .number .item:nth-child(4)');
  var d4=document.querySelector('.number .item:eq(4), .number .item:nth-child(5)');
  if(d3&&d4){
    var s1=parseInt(d3.textContent,10)||0;
    var s2=parseInt(d4.textContent,10)||0;
    if(s1===0&&s2<=5)return true;
  }
  return false;
}

// ── Click a game button (native + jQuery fallback) ────────────────
function clickEl(el){
  if(!el)return false;
  if(el.classList.contains('block-click'))return false;
  // Try jQuery first (wingo1.js uses jQuery click handlers)
  if(window.$){try{$(el).trigger('click');return true;}catch(e){}}
  el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  return true;
}

// ── Find the target bet button ─────────────────────────────────────
function findBetButton(join){
  // Color/size buttons have data-join attribute
  if(['x','d','t','l','n'].indexOf(join)!==-1){
    return document.querySelector('[data-join="'+join+'"]');
  }
  // Number buttons: find by .txt content
  var num=String(join);
  var items=document.querySelectorAll('.number-box .item');
  for(var i=0;i<items.length;i++){
    var txt=items[i].querySelector('.txt');
    if(txt&&txt.textContent.trim()===num)return items[i];
  }
  return null;
}

// ── Select amount in confirmation popup ───────────────────────────
function selectAmount(amount){
  // amount-box .li[data-x] inside the popup
  var li=document.querySelector('.amount-box .li[data-x="'+amount+'"]');
  if(li&&window.$){
    try{$(li).trigger('click');return true;}catch(e){}
  }
  if(li){li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return true;}
  // Fallback: set data-money directly and trigger the right amount label
  var box=document.querySelector('.amount-box');
  if(box)box.setAttribute('data-money',String(amount));
  return false;
}

// ── Delay helper ──────────────────────────────────────────────────
function delay(ms){return new Promise(function(r){setTimeout(r,ms);});}

// ── Execute one auto-bet sequence ─────────────────────────────────
var _betting=false;
function placeBet(pred){
  if(_betting)return;
  if(!AB.enabled)return;
  if(!pred){setStatus('No prediction yet','#f0b429');return;}
  if(isLocked()){setStatus('⏸ Lockdown — skipped','#8899aa');return;}

  var conf=stratConfidence(pred);
  if(conf<AB.minConf){
    setStatus('⚡ Conf '+conf+'% < '+AB.minConf+'% — skipped','#8899aa');
    return;
  }

  var join=resolveJoin(pred);
  if(!join){setStatus('No valid bet target','#e94560');return;}

  var btn=findBetButton(join);
  if(!btn){setStatus('Button not found ('+join+')','#e94560');return;}
  if(btn.classList.contains('block-click')){setStatus('Button locked','#8899aa');return;}

  _betting=true;
  setStatus('⚡ Placing bet…','#f0b429');

  // Step 1: click the bet button (opens popup)
  var clicked=clickEl(btn);
  if(!clicked){_betting=false;setStatus('Click blocked','#e94560');return;}

  // Step 2: wait for popup animation, then select amount
  delay(450).then(function(){
    // Check popup is open
    var popup=document.querySelector('.popup-join');
    var isOpen=popup&&(popup.style.display!=='none'&&popup.style.transform!=='translateY(600px)');
    if(!isOpen){
      // Popup didn't open — maybe click didn't register. Retry once.
      var btn2=findBetButton(join);
      if(btn2)clickEl(btn2);
      return delay(400);
    }
    return Promise.resolve();
  }).then(function(){
    // Select amount
    selectAmount(AB.amount);
    return delay(300);
  }).then(function(){
    // Step 3: click confirm (.foot .right)
    var confirmBtn=document.querySelector('.foot .right');
    if(!confirmBtn||confirmBtn.classList.contains('block-click')){
      _betting=false;setStatus('Confirm btn unavailable','#e94560');return;
    }
    clickEl(confirmBtn);
    AB.betsTotal++;saveAB();refreshAutoBetUI();
    setStatus('✓ Bet placed: '+
      (AB.strategy==='COLOR'?pred.color.winner.toUpperCase():
       AB.strategy==='SIZE'?pred.size.winner.toUpperCase():
       'No.'+pred.top1.num)+
      ' ('+conf+'% conf)','#3fb950');
    return delay(1500);
  }).then(function(){
    _betting=false;
  }).catch(function(e){
    _betting=false;
    setStatus('Error: '+e.message,'#e94560');
    console.warn('[WingoBet]',e);
  });
}

// ── Fetch game history ─────────────────────────────────────────────
function getTypeId(){
  var p=window.location.pathname;
  if(p==='/win/3')return 3;if(p==='/win/5')return 5;if(p==='/win/10')return 10;return 1;
}
function fetchHistory(cb){
  fetch('/api/webapi/GetNoaverageEmerdList',{
    method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',
    body:JSON.stringify({typeid:getTypeId(),pageno:0,pageto:200})
  })
  .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
  .then(function(data){
    if(!data||!data.data||!Array.isArray(data.data.gameslist))throw new Error('Bad shape');
    var list=data.data.gameslist;
    if(!list.length)throw new Error('Empty');
    var parsed=list
      .map(function(row){return Number(row.amount);})
      .filter(function(n){return Number.isFinite(n)&&n>=0&&n<=9;})
      .reverse();
    if(parsed.length<5)throw new Error('Too few: '+parsed.length);
    _history=parsed;_retryCount=0;cb(parsed);
  })
  .catch(function(err){
    console.warn('[WingoPredict] fetch:',err.message);
    if(_history.length>=5){cb(_history);}
    else{
      _retryCount++;
      var d=Math.min(5000*_retryCount,30000);
      setTimeout(function(){fetchHistory(cb);},d);
      setStatus('Retrying…','');
    }
  });
}

// ── Render prediction panel ────────────────────────────────────────
function renderPredict(r,rounds){
  if(!r){setText('ai-status','Need more data');return;}
  var top1=r.top1,color=COLOR_MAP[top1.num],conf=Math.round(top1.prob*100);
  var badge=eid('ai-status');
  if(badge){badge.textContent='Live · '+rounds+' rounds';badge.style.color='#3fb950';}
  var numEl=eid('ai-top1-num');
  if(numEl){numEl.textContent=top1.num;applyBg(numEl,color);}
  setText('ai-top1-color',COLOR_LABEL[color]||color);
  setText('ai-size-pred',r.size.winner.toUpperCase());
  setText('ai-size-conf',r.size.confidence+'%');
  var cEl=eid('ai-color-pred');
  if(cEl){cEl.textContent=COLOR_LABEL[r.color.winner];cEl.style.color=r.color.winner==='red'?'#e94560':'#4caf50';}
  setText('ai-color-conf',r.color.confidence+'%');
  var bar=eid('ai-conf-bar');
  if(bar){
    bar.style.width=conf+'%';
    bar.style.background=conf>=70?'#3fb950':conf>=50?'#f0b429':'#e94560';
  }
  setText('ai-conf-pct',conf+'%');
  var row=eid('ai-top3');
  if(row){
    var rankLabel=['★#1','#2','#3'],rankColors=['#f5c518','#aaa','#cd7f32'];
    row.innerHTML='';
    r.top3.forEach(function(t,i){
      var c2=COLOR_MAP[t.num],css2=COLOR_CSS[c2]||'#888';
      var d=document.createElement('div');d.style.cssText='text-align:center;flex:1';
      d.innerHTML='<div style="width:44px;height:44px;border-radius:50%;background:'+css2+';'+
        'display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;'+
        'margin:0 auto 3px;border:2px solid '+rankColors[i]+';box-shadow:0 0 8px rgba(255,255,255,.12)">'+t.num+'</div>'+
        '<div style="font-size:9px;color:'+rankColors[i]+';font-weight:700">'+rankLabel[i]+'</div>'+
        '<div style="font-size:9px;color:#aaa">'+Math.round(t.prob*100)+'%</div>';
      row.appendChild(d);
    });
  }
  var sEl=eid('ai-signals');
  if(sEl){
    sEl.innerHTML='';
    Object.keys(r.weights).forEach(function(k){
      var sp=document.createElement('span');
      sp.style.cssText='background:#0a1628;border-radius:8px;padding:2px 7px;font-size:9px;color:#8899aa;border:1px solid #1e2d40';
      sp.textContent=k+':'+r.weights[k]+'%';sEl.appendChild(sp);
    });
  }
  // Highlight which button auto-bet will click
  highlightTarget(r);
}

// ── Highlight target button on the game board ─────────────────────
var _prevHighlight=null;
function highlightTarget(pred){
  // Clear previous
  if(_prevHighlight){
    _prevHighlight.style.outline='';_prevHighlight.style.boxShadow='';_prevHighlight=null;
  }
  if(!AB.enabled||!pred)return;
  var join=resolveJoin(pred);
  if(!join)return;
  var btn=findBetButton(join);
  if(!btn)return;
  btn.style.outline='2px solid #f0b429';
  btn.style.boxShadow='0 0 10px rgba(240,180,41,.5)';
  _prevHighlight=btn;
}

// ── Accuracy UI injector ───────────────────────────────────────────
function injectAccuracyUI(){
  var panel=eid('ai-predict-panel');
  if(!panel||eid('ai-accuracy-wrap'))return;
  var wrap=document.createElement('div');
  wrap.id='ai-accuracy-wrap';
  wrap.style.cssText='margin-top:10px;padding-top:10px;border-top:1px solid #1e2d40';
  wrap.innerHTML=
    // Last match row
    '<div id="ai-last-match" style="display:none;margin-bottom:8px;background:#0a1628;border-radius:8px;padding:7px 10px">'+
      '<div style="font-size:10px;color:#8899aa;margin-bottom:5px;letter-spacing:.4px">LAST PERIOD RESULT</div>'+
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap" id="ai-match-badges"></div>'+
    '</div>'+
    // Running accuracy
    '<div style="font-size:10px;color:#8899aa;margin-bottom:6px;letter-spacing:.4px">LIVE ACCURACY (<span id="ai-acc-total">0</span> rounds)</div>'+
    '<div style="display:flex;gap:8px">'+
      '<div style="flex:1;text-align:center;background:#0a1628;border-radius:8px;padding:6px 4px">'+
        '<div id="ai-acc-top1" style="font-size:18px;font-weight:800;color:#f5c518">—</div>'+
        '<div style="font-size:9px;color:#8899aa;margin-top:1px">Top1 №</div>'+
      '</div>'+
      '<div style="flex:1;text-align:center;background:#0a1628;border-radius:8px;padding:6px 4px">'+
        '<div id="ai-acc-color" style="font-size:18px;font-weight:800;color:#388bfd">—</div>'+
        '<div style="font-size:9px;color:#8899aa;margin-top:1px">Color</div>'+
      '</div>'+
      '<div style="flex:1;text-align:center;background:#0a1628;border-radius:8px;padding:6px 4px">'+
        '<div id="ai-acc-size" style="font-size:18px;font-weight:800;color:#a371f7">—</div>'+
        '<div style="font-size:9px;color:#8899aa;margin-top:1px">Size</div>'+
      '</div>'+
    '</div>';
  // Insert before auto-bet UI (or just append)
  var ab=eid('wp-autobet-ui');
  if(ab)panel.insertBefore(wrap,ab);
  else panel.appendChild(wrap);
}

// ── Settle pending prediction against actual result ────────────────
function settleAccuracy(pred,actual){
  if(!pred)return;
  var actualColor=COLOR_MAP[actual],actualSize=SIZE_MAP[actual];
  var matchTop1   = pred.top1.num===actual;
  var matchColor  = pred.color.winner===actualColor||
                    (actualColor==='red-violet'&&pred.color.winner==='red')||
                    (actualColor==='green-violet'&&pred.color.winner==='green');
  var matchSize   = pred.size.winner===actualSize;
  _accuracy.total++;
  if(matchTop1) _accuracy.top1++;
  if(matchColor)_accuracy.color++;
  if(matchSize) _accuracy.size++;

  // Render last-match row
  var lm=eid('ai-last-match');
  if(lm){
    lm.style.display='block';
    var badges=eid('ai-match-badges');
    if(badges){
      var actualCss=COLOR_CSS[actualColor]||'#888';
      function badge(label,ok){
        return '<span style="display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700;'+
               'background:'+(ok?'rgba(63,185,80,.15)':'rgba(233,69,96,.15)')+';'+
               'border:1px solid '+(ok?'#3fb950':'#e94560')+';color:'+(ok?'#3fb950':'#e94560')+'">'+
               (ok?'✓ ':'✗ ')+label+'</span>';
      }
      badges.innerHTML=
        '<div style="width:28px;height:28px;border-radius:50%;background:'+actualCss+
          ';display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;flex-shrink:0">'+actual+'</div>'+
        badge('Top1 '+pred.top1.num+'→'+actual, matchTop1)+
        badge(pred.color.winner+'→'+actualColor.replace('-',' '), matchColor)+
        badge(pred.size.winner+'→'+actualSize, matchSize);
    }
  }

  // Update accuracy numbers
  var pct=function(n,d){return d?Math.round(n/d*100)+'%':'—';};
  var t1pct =pct(_accuracy.top1, _accuracy.total);
  var colpct=pct(_accuracy.color,_accuracy.total);
  var szpct =pct(_accuracy.size, _accuracy.total);
  setText('ai-acc-total',_accuracy.total);
  var t1el=eid('ai-acc-top1');
  if(t1el){t1el.textContent=t1pct;t1el.style.color=_accuracy.total&&(_accuracy.top1/_accuracy.total)>=.5?'#3fb950':'#f5c518';}
  var coel=eid('ai-acc-color');
  if(coel){coel.textContent=colpct;coel.style.color=_accuracy.total&&(_accuracy.color/_accuracy.total)>=.5?'#3fb950':'#388bfd';}
  var szel=eid('ai-acc-size');
  if(szel){szel.textContent=szpct;szel.style.color=_accuracy.total&&(_accuracy.size/_accuracy.total)>=.5?'#3fb950':'#a371f7';}
}

// ── Main refresh ───────────────────────────────────────────────────
function run(){
  if(_busy)return;_busy=true;setText('ai-status','Analysing…');
  // Snapshot current prediction — will settle it after new result arrives
  var predSnapshot=_prediction;
  var prevLen=_prevHistLen;
  fetchHistory(function(history){
    _busy=false;
    if(!history||history.length<5){setText('ai-status','Waiting for data…');return;}
    // If history grew (new period result came in) and we had a prediction, settle it
    if(predSnapshot&&history.length>prevLen){
      var actual=history[history.length-1];
      settleAccuracy(predSnapshot,actual);
    }
    _prevHistLen=history.length;
    var result=multiPredict(history);
    _prediction=result;
    renderPredict(result,history.length);
    injectAccuracyUI();
    injectAutoBetUI();
    // Auto-bet: place after a short delay so popup system is ready
    if(AB.enabled){
      delay(800).then(function(){placeBet(_prediction);});
    }
  });
}

// ── Period watcher ─────────────────────────────────────────────────
var PERIOD_SEL=['.issueName','.period-title','[class*="period"]','.game-info-id','.number-game'];
function readPeriod(){
  for(var i=0;i<PERIOD_SEL.length;i++){
    var el=document.querySelector(PERIOD_SEL[i]);
    if(el&&el.textContent.trim())return el.textContent.trim();
  }
  return null;
}
function watchPeriod(){
  setInterval(function(){
    var p=readPeriod();
    if(p&&p!==_lastPeriod){_lastPeriod=p;run();}
    // Refresh highlight when strategy changes
    if(_prediction&&AB.enabled)highlightTarget(_prediction);
  },2500);
}
function hookSocket(){
  if(!window.io)return;
  try{
    var sock=io();
    sock.on('data-server',function(payload){
      if(!payload||!payload.data||!payload.data[0])return;
      var period=String(payload.data[0].period);
      if(period!==_lastPeriod){_lastPeriod=period;run();}
    });
  }catch(e){}
}

// ── Boot ───────────────────────────────────────────────────────────
function init(){
  run();
  watchPeriod();
  hookSocket();
}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}
else{init();}
window.wingoPredictRefresh=run;
window.wingoPredictBet=function(){placeBet(_prediction);};
})();
