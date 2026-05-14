'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const osc     = require('osc');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const PORT     = process.env.PORT || 3000;
const OSC_HOST    = '127.0.0.1';
const OSC_PORT    = 9000; // Server sends results to TouchOSC
const OSC_IN_PORT = 9001; // Server receives admin commands from TouchOSC
const MAX         = 20;
const DATAFILE = path.join(__dirname, 'questions.json');

// ── local IP ──────────────────────────────────────────────
function localIP() {
  try {
    const nets = os.networkInterfaces();
    for (const n of Object.keys(nets)) {
      for (const iface of nets[n]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch(e) {}
  return '127.0.0.1';
}

// ── data helpers ──────────────────────────────────────────
function blankOption(id) {
  return { id, name: 'Option ' + id, votes: 0 };
}

function blankQuestion(n) {
  return {
    title: 'Audience Voting',
    question: 'Question ' + n,
    isOpen: true,
    showResults: true,
    activeOptionCount: 4,
    options: Array.from({ length: MAX }, (_, i) => blankOption(i + 1)),
    votesByVoter: {}
  };
}

function fixQuestion(q, n) {
  const r = {
    title: q.title || 'Audience Voting',
    question: q.question || 'Question ' + n,
    isOpen: q.isOpen !== undefined ? q.isOpen : true,
    showResults: q.showResults !== undefined ? q.showResults : true,
    activeOptionCount: Math.max(1, Math.min(Number(q.activeOptionCount) || 4, MAX)),
    options: [],
    votesByVoter: q.votesByVoter || {}
  };

  for (let i = 1; i <= MAX; i++) {
    const o = (q.options || [])[i - 1] || {};
    r.options.push({
      id: i,
      name: o.name || 'Option ' + i,
      votes: Number(o.votes) || 0
    });
  }

  return r;
}

let db = { qi: 0, qs: [blankQuestion(1)] };
let previewQi = 0;

function load() {
  try {
    if (!fs.existsSync(DATAFILE)) return;
    const p = JSON.parse(fs.readFileSync(DATAFILE, 'utf8'));

    if (p && Array.isArray(p.qs) && p.qs.length) {
      db.qi = Math.max(0, Math.min(Number(p.qi) || 0, p.qs.length - 1));
      db.qs = p.qs.map((q, i) => fixQuestion(q, i + 1));
    }
  } catch(e) {
    console.error('load error:', e.message);
  }
}

function save() {
  try {
    fs.writeFileSync(DATAFILE, JSON.stringify(db, null, 2));
  } catch(e) {
    console.error('save error:', e.message);
  }
}

function cq() {
  return db.qs[db.qi] || db.qs[0];
}

load();

// ── express + socket.io ───────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── OSC ───────────────────────────────────────────────────
let udp;

try {
  udp = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: 0,
    remoteAddress: OSC_HOST,
    remotePort: OSC_PORT
  });
  udp.open();
} catch(e) {
  console.error('OSC init error:', e.message);
}

function osc_send(addr, args) {
  try {
    if (udp) udp.send({ address: addr, args });
  } catch(e) {}
}
// ── OSC INPUT FROM TOUCHOSC ADMIN BUTTONS ─────────────────
let oscIn;

try {
  oscIn = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: OSC_IN_PORT
  });

  oscIn.on('message', (msg) => {
    const address = msg.address;
    const args = msg.args || [];

    let value = 1;
    if (args[0] !== undefined) {
      value = typeof args[0] === 'object' && args[0].value !== undefined
        ? args[0].value
        : args[0];
    }

    console.log('OSC IN:', address, value);
    handleAdminOSC(address, value);
  });

  oscIn.open();

} catch(e) {
  console.error('OSC input init error:', e.message);
}
// ── voter helpers ─────────────────────────────────────────
function getVoteOptionId(voteValue) {
  if (!voteValue) return 0;
  if (typeof voteValue === 'object') return Number(voteValue.optionId) || 0;
  return Number(voteValue) || 0;
}

function getVoteName(voteValue) {
  if (!voteValue) return 'Guest';
  if (typeof voteValue === 'object') return String(voteValue.name || 'Guest').trim() || 'Guest';
  return 'Guest';
}
function buildQuestionPreview(index, label) {
  if (index < 0) index = 0;
  if (index >= db.qs.length) index = db.qs.length - 1;

  const q = db.qs[index];
  if (!q) return "";

  const count = Math.max(1, Math.min(Number(q.activeOptionCount) || 1, MAX));
  const activeOptions = q.options.slice(0, count);

  const lines = [];

  if (label) {
    lines.push(label + " Q" + (index + 1));
  } else {
    lines.push("Q" + (index + 1));
  }

  lines.push("");
  lines.push(q.question || "");
  lines.push("");

  activeOptions.forEach((o, i) => {
    lines.push((i + 1) + ". " + o.name);
  });

  return lines.join("\n");
}
// ── results() — single source of truth ───────────────────
function results() {
  const q      = cq();
  const active = q.options.slice(0, q.activeOptionCount);
  const total  = active.reduce((s, o) => s + o.votes, 0);

  // Build name lists in ONE pass — O(voters) not O(voters x options)
  const namesByOptionId = {};
  Object.keys(q.votesByVoter || {}).forEach(voterId => {
    const vote     = q.votesByVoter[voterId];
    const optionId = getVoteOptionId(vote);
    const name     = getVoteName(vote);
    if (optionId) {
      if (!namesByOptionId[optionId]) namesByOptionId[optionId] = [];
      namesByOptionId[optionId].push(name);
    }
  });

  const opts = active.map(o => ({
    id:      o.id,
    name:    o.name,
    votes:   o.votes,
    percent: total > 0 ? Math.round(o.votes / total * 100) : 0,
    names:   namesByOptionId[o.id] || []
  }));

  const allOpts = q.options.map(o => ({ id: o.id, name: o.name }));
  const winner  = total > 0 ? [...opts].sort((a, b) => b.votes - a.votes)[0] : null;

return {
    title: q.title,
    question: q.question,
    isOpen: q.isOpen,
    showResults: q.showResults,
    activeOptionCount: q.activeOptionCount,
    totalVotes: total,
    opts,
    allOpts,
    winner,
    qi: db.qi,
    qnum: db.qi + 1,
    qtotal: db.qs.length,
    qlist: db.qs.map((q, i) => ({ i, n: i + 1, q: q.question })),
    questionPreview: buildQuestionPreview(db.qi, ""),
    browsePreview: buildQuestionPreview(previewQi, "PREVIEW"),
    previewQuestionNumber: previewQi + 1
  };
}

function sendOSC(r) {
  osc_send('/poll/title',           [{ type:'s', value: r.title }]);
  osc_send('/poll/question',        [{ type:'s', value: r.question }]);
  osc_send('/poll/question_number', [{ type:'i', value: r.qnum }]);
  osc_send('/poll/question_total',  [{ type:'i', value: r.qtotal }]);
  osc_send('/poll/status',          [{ type:'s', value: r.isOpen ? 'OPEN' : 'CLOSED' }]);
  osc_send('/poll/total_votes',     [{ type:'i', value: r.totalVotes }]);
  osc_send('/poll/option_count',    [{ type:'i', value: r.activeOptionCount }]);

  for (let i = 1; i <= MAX; i++) {
    const o = r.opts[i - 1];

    osc_send('/poll/option/' + i + '/name',    [{ type:'s', value: o ? o.name    : '' }]);
    osc_send('/poll/option/' + i + '/votes',   [{ type:'i', value: o ? o.votes   : 0  }]);
    osc_send('/poll/option/' + i + '/percent', [{ type:'i', value: o ? o.percent : 0  }]);

    const namesText = o && o.names ? o.names.join(' • ') : '';
    osc_send('/poll/option/' + i + '/names', [{ type:'s', value: namesText }]);
  }

  osc_send('/poll/winner/name',    [{ type:'s', value: r.winner ? r.winner.name    : '' }]);
  osc_send('/poll/winner/percent', [{ type:'i', value: r.winner ? r.winner.percent : 0  }]);
  const summaryLines = r.opts
    .map(o => o.name + ': ' + o.percent + '%  (' + o.votes + ' votes)')
    .join('\n');

  osc_send('/poll/summary', [{ type:'s', value: summaryLines }]);
  osc_send('/poll/question_preview', [{ type:'s', value: r.questionPreview || '' }]);
  osc_send('/poll/browse_preview', [{ type:'s', value: r.browsePreview || '' }]);
}
function handleAdminOSC(address, value) {
  let changed = true;

  if (address === '/admin/next-question') {
  if (db.qi < db.qs.length - 1) db.qi++;
  previewQi = db.qi;

  } else if (address === '/admin/prev-question') {
  if (db.qi > 0) db.qi--;
  previewQi = db.qi;

  } else if (address === '/admin/open') {
    cq().isOpen = true;

  } else if (address === '/admin/close') {
    cq().isOpen = false;

  } else if (address === '/admin/show-results') {
    cq().showResults = true;

  } else if (address === '/admin/hide-results') {
    cq().showResults = false;

  } else if (address === '/admin/reset') {
    const q = cq();
    q.options.forEach(o => { o.votes = 0; });
    q.votesByVoter = {};
    io.emit('reset-voters');

  } else if (address === '/admin/send-osc') {
    sendOSC(results());
    changed = false;

 } else if (address === '/admin/question') {
 const qNumber = Number(value) || 1;
 const index = qNumber - 1;

 if (index >= 0 && index < db.qs.length) {
   db.qi = index;
   previewQi = db.qi;
 }
    } else if (address === '/admin/preview-next') {
      if (previewQi < db.qs.length - 1) {
        previewQi++;
      }
      sendOSC(results());
      changed = false;

    } else if (address === '/admin/preview-prev') {
      if (previewQi > 0) {
        previewQi--;
      }
      sendOSC(results());
      changed = false;

    } else if (address === '/admin/preview-load') {
      if (previewQi >= 0 && previewQi < db.qs.length) {
        db.qi = previewQi;
      }
  } else if (address.match(/^\/admin\/set-votes\/(\d+)$/)) {
    // OSC from TouchOSC when exiting manual mode.
    // TouchOSC sends one message per option — debounce broadcast
    // so server broadcasts once after all options arrive.
    const optNum = Number(address.match(/(\d+)$/)[1]);
    const votes  = Math.max(0, Number(value) || 0);
    const opt    = cq().options.find(o => o.id === optNum);
    if (opt) {
      opt.votes = votes;
      console.log('OSC set-votes: option ' + optNum + ' = ' + votes);
    }
    // Also clear votesByVoter so new real votes add on top cleanly
    cq().votesByVoter = {};
    save();
    // Debounce broadcast — wait 300ms for all option messages to arrive
    clearTimeout(handleAdminOSC._setVotesTimer);
    handleAdminOSC._setVotesTimer = setTimeout(() => {
      broadcast();
      console.log('OSC set-votes: broadcast after debounce');
    }, 300);
    changed = false; // prevent double broadcast below

  } else if (address.match(/^\/admin\/override\/(\d+)$/)) {
    // OSC: /admin/override/N  with value = delta (e.g. +10 or -5)
    // e.g. send /admin/override/2 with value 10 to add 10 votes to option 2
    const oid   = Number(address.match(/(\d+)$/)[1]);
    const delta = Number(value) || 0;
    const opt   = cq().options.find(o => o.id === oid);
    if (opt) opt.votes = Math.max(0, opt.votes + delta);

  } else if (address.match(/^\/admin\/override\/(\d+)\/set$/)) {
    // OSC: /admin/override/N/set  with value = exact vote count
    // e.g. send /admin/override/2/set with value 150 to set option 2 to exactly 150
    const oid = Number(address.match(/(\d+)/)[1]);
    const opt = cq().options.find(o => o.id === oid);
    if (opt) opt.votes = Math.max(0, Number(value) || 0);

  } else {
    changed = false;
  }

  if (changed) {
    save();
    broadcast();
  }
}
// Debounce OSC output — with 1000 voters, coalesce rapid votes into one OSC burst
let oscDebounceTimer = null;
function broadcast() {
  const r = results();
  io.emit('R', r);                      // socket.io: send immediately (clients need real-time)
  clearTimeout(oscDebounceTimer);
  oscDebounceTimer = setTimeout(() => { // OSC: wait 80ms for vote burst to settle
    sendOSC(results());
  }, 80);
}

// ── routes ────────────────────────────────────────────────
app.get('/',            (_, res) => res.redirect('/vote'));
app.get('/vote',        (_, res) => res.send(VOTE_PAGE));
app.get('/admin',       (_, res) => res.send(adminPage()));
app.get('/results',     (_, res) => res.send(RESULTS_PAGE));
app.get('/api/results', (_, res) => res.json(results()));

// Simple in-memory rate limit — prevents vote spam from a single device
const voteRateLimit = new Map();
function isRateLimited(vid) {
  const now = Date.now();
  const last = voteRateLimit.get(vid) || 0;
  if (now - last < 1000) return true;  // 1 vote per second per voter
  voteRateLimit.set(vid, now);
  // Clean up old entries every 10,000 votes to prevent memory leak
  if (voteRateLimit.size > 10000) {
    const cutoff = now - 60000;
    for (const [k, v] of voteRateLimit) { if (v < cutoff) voteRateLimit.delete(k); }
  }
  return false;
}

app.post('/api/vote', (req, res) => {
  const q     = cq();
  const oid   = Number(req.body.optionId);
  const vid   = String(req.body.voterId || '').trim();
  const vname = String(req.body.voterName || 'Guest').trim().slice(0, 30) || 'Guest';

  if (!q.isOpen)                             return res.json({ ok:false, msg:'Closed' });
  if (!vid)                                  return res.json({ ok:false, msg:'No voter ID' });
  if (oid < 1 || oid > q.activeOptionCount) return res.json({ ok:false, msg:'Bad option' });
  if (isRateLimited(vid))                    return res.json({ ok:false, msg:'Too fast, try again' });

  const newO = q.options.find(o => o.id === oid);

  // Supports old saved format: votesByVoter[voterId] = optionId
  // Supports new saved format: votesByVoter[voterId] = { name, optionId }
  const oldVote = q.votesByVoter[vid];
  const oldId = getVoteOptionId(oldVote);

  if (oldId === oid) {
    q.votesByVoter[vid] = { name: vname, optionId: oid };
    save();
    broadcast();
    return res.json({ ok:true, msg:'Already voted', selectedOptionId:oid });
  }

  if (oldId) {
    const old = q.options.find(o => o.id === oldId);
    if (old && old.votes > 0) old.votes--;
  }

  newO.votes++;
  q.votesByVoter[vid] = { name: vname, optionId: oid };

  save();
  broadcast();

  res.json({ ok:true, msg:'Voted!', selectedOptionId:oid });
});

function adminRoute(fn) {
  return (req, res) => {
    try {
      fn(req);
      save();
      const r = results();       // compute once
      io.emit('R', r);           // push to browser clients
      sendOSC(r);                // push to OSC (already debounced inside broadcast)
      res.json(r);               // return same object to admin page
    } catch(e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  };
}

app.post('/api/admin/open',         adminRoute(() => { cq().isOpen = true; }));
app.post('/api/admin/close',        adminRoute(() => { cq().isOpen = false; }));
app.post('/api/admin/show-results', adminRoute(() => { cq().showResults = true; }));
app.post('/api/admin/hide-results', adminRoute(() => { cq().showResults = false; }));

app.post('/api/admin/reset', adminRoute(() => {
  const q = cq();
  q.options.forEach(o => { o.votes = 0; });
  q.votesByVoter = {};
  io.emit('reset-voters');
}));

app.post('/api/admin/reset-all', adminRoute(() => {
  db.qs.forEach(q => {
    q.options.forEach(o => { o.votes = 0; });
    q.votesByVoter = {};
  });
  io.emit('reset-voters');
}));

app.post('/api/admin/next-question', adminRoute(() => {
  if (db.qi < db.qs.length - 1) db.qi++;
}));

app.post('/api/admin/prev-question', adminRoute(() => {
  if (db.qi > 0) db.qi--;
}));

app.post('/api/admin/add-question', adminRoute(() => {
  db.qs.push(blankQuestion(db.qs.length + 1));
  db.qi = db.qs.length - 1;
}));

app.post('/api/admin/duplicate-question', adminRoute(() => {
  const copy = fixQuestion(JSON.parse(JSON.stringify(cq())), db.qs.length + 1);
  copy.question += ' (Copy)';
  copy.options.forEach(o => { o.votes = 0; });
  copy.votesByVoter = {};
  db.qs.push(copy);
  db.qi = db.qs.length - 1;
}));

app.post('/api/admin/question/:idx', adminRoute((req) => {
  const i = Number(req.params.idx);
  if (i >= 0 && i < db.qs.length) db.qi = i;
}));

app.post('/api/admin/set-count', adminRoute((req) => {
  cq().activeOptionCount = Math.max(1, Math.min(Number(req.body.count) || 1, MAX));
}));

app.post('/api/admin/update', adminRoute((req) => {
  const q = cq();

  if (req.body.title)    q.title    = String(req.body.title).trim();
  if (req.body.question) q.question = String(req.body.question).trim();

  const c = Number(req.body.count);
  if (c >= 1 && c <= MAX) q.activeOptionCount = c;

  for (let i = 1; i <= MAX; i++) {
    const v = req.body['o' + i];
    if (v !== undefined && String(v).trim()) {
      q.options[i - 1].name = String(v).trim();
    }
  }
}));

app.post('/api/admin/send-osc', (_, res) => {
  sendOSC(results());
  res.json({ ok:true });
});

// Bulk override — sets multiple option vote counts at once.
// Called from TouchOSC when exiting manual mode so the server
// continues from the manually adjusted numbers.
// Body: { votes: [0, 120, 145, 0, ...] }  (index 0 = option 1)
app.post('/api/admin/set-votes', adminRoute((req) => {
  const q     = cq();
  const votes = req.body.votes;
  if (!Array.isArray(votes)) throw new Error('votes must be an array');
  votes.forEach((v, i) => {
    if (i < q.options.length) {
      q.options[i].votes = Math.max(0, Number(v) || 0);
    }
  });
  // Also clear votesByVoter so vote counts are authoritative
  // (existing voters can still change their vote, new totals are the base)
  q.votesByVoter = {};
}));

// ── MANUAL OVERRIDE ───────────────────────────────────────
// Add/subtract/set votes directly on any option.
// Triggered from admin page override panel OR via OSC from TouchOSC.
// POST { optionId: 2, delta: +10 }  → adds 10 votes to option 2
// POST { optionId: 2, delta: -5  }  → removes 5 votes from option 2
// POST { optionId: 2, set: 150   }  → sets option 2 to exactly 150 votes
app.post('/api/admin/override', adminRoute((req) => {
  const q   = cq();
  const oid = Number(req.body.optionId);
  const opt = q.options.find(o => o.id === oid);
  if (!opt) throw new Error('Option ' + oid + ' not found');

  if (req.body.set !== undefined) {
    opt.votes = Math.max(0, Number(req.body.set) || 0);
  } else {
    const delta = Number(req.body.delta) || 0;
    opt.votes   = Math.max(0, opt.votes + delta);
  }
}));

// OSC override: /admin/override/1/+10  or  /admin/override/1/-5  or  /admin/override/1/set/150
// Handled inside handleAdminOSC below — see the OSC INPUT section.

io.on('connection', s => s.emit('R', results()));

// ── VOTE PAGE ─────────────────────────────────────────────
const VOTE_PAGE = `<!doctype html><html><head>
<meta charset="utf-8"/><title>Vote</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#101018;color:#fff;padding:20px;-webkit-user-select:none;user-select:none}
.pill{display:inline-block;padding:6px 14px;border-radius:99px;background:#2a2a3d;font-size:13px;margin-bottom:12px}
h1{font-size:28px;margin-bottom:4px}
h2{font-size:18px;opacity:.75;margin-bottom:20px;font-weight:normal}
.namebox{margin:12px 0 16px}
.namebox label{display:block;font-size:13px;opacity:.6;margin-bottom:5px}
.namebox input{width:100%;padding:13px;border:none;border-radius:12px;background:#202033;color:white;font-size:16px;-webkit-user-select:text;user-select:text}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{padding:18px;border:none;border-radius:14px;background:#2e2e45;color:#fff;font-size:17px;font-weight:bold;cursor:pointer;width:100%;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
button:hover{background:#3d3d5c}
.sel{background:#3cb85c!important;box-shadow:0 0 0 3px rgba(60,184,92,.4)}
.msg{margin-top:14px;opacity:.5;font-size:14px}
@media(max-width:500px){.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="pill" id="st">Connecting...</div>
<h1 id="ttl">Audience Voting</h1>
<h2 id="qst"></h2>

<div class="namebox">
  <label>Your Name</label>
  <input id="voterName" placeholder="Enter your name"/>
</div>

<div class="grid" id="opts"></div>
<p class="msg" id="msg"></p>
<script src="/socket.io/socket.io.js"></script>
<script>
var skt=io(), VK='vv', NK='voter_name', SP='vs_', last=null, sending=false;

function vid(){
  var v=localStorage.getItem(VK);
  if(!v){
    v='v'+Date.now()+Math.random().toString(36).slice(2);
    localStorage.setItem(VK,v);
  }
  return v;
}

function voterName(){
  var box = document.getElementById('voterName');
  var name = box ? box.value.trim() : '';
  if (!name) name = 'Guest';
  localStorage.setItem(NK, name);
  return name;
}

function setupNameBox(){
  var box = document.getElementById('voterName');
  if (box) {
    box.value = localStorage.getItem(NK) || '';
    box.oninput = function(){
      localStorage.setItem(NK, this.value.trim());
    };
  }
}

function renderVoteButtons(d){
  var box=document.getElementById('opts');
  box.innerHTML='';

  if(!d.isOpen){
    box.innerHTML='<p style="opacity:.5;padding:10px">Voting is closed.</p>';
    return;
  }

  var sel=Number(localStorage.getItem(SP+d.qi)||0);

  d.opts.forEach(function(o){
    var b=document.createElement('button');
    b.textContent=(o.id===sel?'✓ ':'')+o.name;

    if(o.id===sel){
      b.className='sel';
    }

    b.onpointerdown=function(e){
      if(e) e.preventDefault();

      if(!last || sending) return;

      // Instant local selection on first touch
      localStorage.setItem(SP + last.qi, String(o.id));
      renderVoteButtons(last);

      sending = true;
      document.getElementById('msg').textContent='Submitting...';

      fetch('/api/vote',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({optionId:o.id,voterId:vid(),voterName:voterName()})
      })
      .then(function(r){return r.json();})
      .then(function(j){
        sending = false;
        document.getElementById('msg').textContent=j.msg||'';

        if(!j.ok){
          localStorage.removeItem(SP + last.qi);
          renderVoteButtons(last);
        }
      })
      .catch(function(){
        sending = false;
        document.getElementById('msg').textContent='Network issue. Please try again.';
        localStorage.removeItem(SP + last.qi);
        renderVoteButtons(last);
      });
    };

    // fallback for browsers without pointer events
    b.ontouchstart=function(e){
      if(!window.PointerEvent && b.onpointerdown) b.onpointerdown(e);
    };

    box.appendChild(b);
  });
}

setupNameBox();

skt.on('R',function(d){
  last=d;
  document.getElementById('ttl').textContent=d.title;
  document.getElementById('qst').textContent='Q'+d.qnum+': '+d.question;
  document.getElementById('st').textContent=d.isOpen?'VOTING OPEN':'VOTING CLOSED';
  renderVoteButtons(d);
});

skt.on('reset-voters',function(){
  Object.keys(localStorage).forEach(function(k){
    if(k.indexOf(SP)===0)localStorage.removeItem(k);
  });
  if(last) renderVoteButtons(last);
});
</script></body></html>`;

// ── RESULTS PAGE ──────────────────────────────────────────
const RESULTS_PAGE = `<!doctype html><html><head>
<meta charset="utf-8"/><title>Live Results</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:radial-gradient(ellipse at top,#23234a,#070710);color:#fff;padding:30px}
.pill{display:inline-block;padding:7px 14px;border-radius:99px;background:#2a2a3d;font-size:14px;margin-bottom:10px}
h1{font-size:52px;margin:8px 0 4px}
h2{font-size:32px;opacity:.85;margin-bottom:16px;font-weight:normal}
.big{font-size:44px;font-weight:bold;margin:10px 0 2px}
.sub{opacity:.5;font-size:14px;margin-bottom:20px}
.bar{margin:14px 0}
.bt{display:flex;justify-content:space-between;font-size:20px;margin-bottom:6px}
.bg{height:26px;background:#2a2a40;border-radius:99px;overflow:hidden}
.bf{height:100%;background:#4da3ff;border-radius:99px;transition:width .4s}
.win{font-size:28px;color:#3cb85c;margin-top:20px;font-weight:bold}
.names{font-size:13px;opacity:.55;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<div class="pill" id="st">Connecting...</div>
<h1 id="ttl">Audience Voting</h1>
<h2 id="qst"></h2>
<div class="big" id="tot">0</div>
<div class="sub">Total Votes</div>
<div id="bars"></div>
<div class="win" id="win"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var skt=io();

function esc(v){
  return String(v || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

skt.on('R',function(d){
  document.getElementById('st').textContent=d.isOpen?'LIVE VOTING':'VOTING CLOSED';
  document.getElementById('ttl').textContent=d.title;
  document.getElementById('qst').textContent='Q'+d.qnum+': '+d.question;
  document.getElementById('tot').textContent=d.totalVotes;

  if(!d.showResults){
    document.getElementById('bars').innerHTML='<p style="opacity:.4;margin-top:20px;font-size:20px">Results hidden</p>';
    document.getElementById('win').textContent='';
    return;
  }

  var bars=document.getElementById('bars');
  bars.innerHTML='';

  d.opts.forEach(function(o){
    var row=document.createElement('div');
    row.className='bar';

    var namesLine = '';
    if(o.names && o.names.length > 0){
      namesLine = '<div class="names">' + esc(o.names.join(' • ')) + '</div>';
    }

    row.innerHTML='<div class="bt"><span>'+esc(o.name)+'</span><span>'+o.percent+'%</span></div>'+
      '<div class="bg"><div class="bf" style="width:'+o.percent+'%"></div></div>' +
      namesLine;

    bars.appendChild(row);
  });

  document.getElementById('win').textContent=d.winner?'🏆 '+d.winner.name:'';
});
</script></body></html>`;

// ── ADMIN PAGE ────────────────────────────────────────────
function adminPage() {
  const ip   = localIP();
  const base = 'http://' + ip + ':' + PORT;

  let rows = '';

  for (let i = 1; i <= MAX; i++) {
    rows += '<div id="R' + i + '" style="display:none">' +
      '<label style="font-size:13px;opacity:.6;display:block;margin:8px 0 2px">Option ' + i + '</label>' +
      '<input id="O' + i + '" style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid #44445a;background:#101018;color:#fff;font-size:15px;margin-bottom:4px" placeholder="Option ' + i + '"/>' +
      '</div>';
  }

  return `<!doctype html><html><head>
<meta charset="utf-8"/><title>Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#101018;color:#fff}
.page{display:grid;grid-template-columns:1fr 300px;gap:16px;max-width:1300px;margin:0 auto;padding:20px;align-items:start}
.left{background:#1d1d2b;border:1px solid #34344a;border-radius:16px;padding:20px}
.right{position:sticky;top:20px;display:flex;flex-direction:column;gap:14px}
.rp{background:#0d0d1a;border:1px solid #252538;border-radius:14px;padding:16px}
h1{font-size:26px;margin-bottom:14px}
label{font-size:13px;opacity:.6;display:block;margin:10px 0 3px}
input,select{width:100%;padding:10px 12px;border-radius:9px;border:1px solid #44445a;background:#101018;color:#fff;font-size:15px;margin-bottom:4px}
button{width:100%;padding:13px;margin:4px 0;border:none;border-radius:12px;background:#2e2e45;color:#fff;font-size:15px;font-weight:bold;cursor:pointer}
button:hover{background:#3d3d5c}
button:active{opacity:.8}
.bp{background:#4da3ff}
.bs{background:#3cb85c}
.bd{background:#d63333}
.pill{display:inline-block;padding:6px 13px;border-radius:99px;background:#2a2a3d;font-size:13px;margin-bottom:12px}
.pill.op{background:#1b3a25;color:#3cb85c;font-weight:bold}
.pill.cl{background:#3a1b1b;color:#d63333;font-weight:bold}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
hr{border:none;border-top:1px solid #2a2a3a;margin:16px 0}
.ql{max-height:160px;overflow-y:auto;background:#101018;border:1px solid #34344a;border-radius:10px;padding:5px;margin:6px 0 12px}
.qi{display:grid;grid-template-columns:40px 1fr 80px;gap:6px;align-items:center;padding:7px;border-radius:7px}
.qi+.qi{border-top:1px solid #222}
.qi.on{background:#1b3025}
.qi button{margin:0;padding:6px;font-size:12px}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:bold;background:#2a2a3d;margin:2px}
.badge.op{background:#1b3a25;color:#3cb85c}
.badge.cl{background:#3a1b1b;color:#d63333}
.pb{margin:6px 0}
.pl{display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px}
.pg{height:7px;background:#1c1c2e;border-radius:99px;overflow:hidden}
.pf{height:100%;background:#4da3ff;border-radius:99px;transition:width .4s}
.pf.ld{background:#3cb85c}
.pnames{font-size:11px;opacity:.55;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ul{font-size:11px;opacity:.4;margin-bottom:3px}
.uv{font-family:monospace;font-size:12px;color:#4da3ff;word-break:break-all}
@media(max-width:900px){.page{grid-template-columns:1fr}.right{position:static}}
</style></head><body>
<div class="page">

  <div class="left">
    <h1>Admin Control</h1>
    <div id="pill" class="pill">Loading...</div>

    <div class="g3">
      <button onclick="go('/api/admin/prev-question')">&#8592; Prev</button>
      <button class="bp" onclick="go('/api/admin/add-question')">+ Add</button>
      <button onclick="go('/api/admin/next-question')">Next &#8594;</button>
    </div>

    <button onclick="go('/api/admin/duplicate-question')">Duplicate Current Question</button>

    <label>Jump to Question</label>
    <select id="qsel"></select>
    <div id="qlist" class="ql"></div>

    <hr>

    <label>Title</label>
    <input id="inT" placeholder="e.g. BEST ACTOR"/>

    <label>Question Text</label>
    <input id="inQ" placeholder="e.g. Who is the best actor?"/>

    <label>Number of Options (1-${MAX})</label>
    <input id="inC" type="number" min="1" max="${MAX}" oninput="onCount(this.value)"/>

    <div class="g2" style="margin-top:6px">${rows}</div>

    <button class="bp" style="margin-top:10px" onclick="doSave()">&#128190; Save Question &amp; Options</button>

    <hr>

    <div class="g3">
      <button class="bs" onclick="go('/api/admin/open')">&#9989; Open</button>
      <button onclick="go('/api/admin/close')">&#128274; Close</button>
      <button class="bd" onclick="go('/api/admin/reset')">&#128465; Reset</button>
    </div>

    <div class="g3">
      <button onclick="go('/api/admin/show-results')">&#128065; Show</button>
      <button onclick="go('/api/admin/hide-results')">&#128584; Hide</button>
      <button class="bp" onclick="go('/api/admin/send-osc')">&#128225; OSC</button>
    </div>

    <button class="bd" style="margin-top:4px" onclick="if(confirm('Reset ALL votes?'))go('/api/admin/reset-all')">&#9888; Reset ALL Votes</button>

    <hr>

    <!-- ── MANUAL OVERRIDE PANEL ── -->
    <div style="background:#1a0a0a;border:2px solid #8b0000;border-radius:12px;padding:16px;margin-top:4px">
      <div style="font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em;color:#ff4444;margin-bottom:4px">&#9888; Manual Override</div>
      <div style="font-size:12px;opacity:.55;margin-bottom:14px">Use if connection drops. Directly add or set votes per option. Invisible to audience — results update instantly.</div>

      <div style="display:grid;grid-template-columns:1fr 80px 80px 80px 80px;gap:6px;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;opacity:.5;font-weight:bold">Option</div>
        <div style="font-size:12px;opacity:.5;text-align:center">−10</div>
        <div style="font-size:12px;opacity:.5;text-align:center">−1</div>
        <div style="font-size:12px;opacity:.5;text-align:center">+1</div>
        <div style="font-size:12px;opacity:.5;text-align:center">+10</div>
      </div>

      <div id="overrideRows"></div>

      <hr style="border-color:#3a1515;margin:14px 0">
      <div style="font-size:12px;opacity:.5;margin-bottom:8px;font-weight:bold">Set exact vote count</div>
      <div style="display:grid;grid-template-columns:1fr 120px 80px;gap:8px;align-items:center">
        <select id="ovOption" style="background:#101018;color:#fff;border:1px solid #44445a;padding:8px;border-radius:8px;font-size:14px"></select>
        <input id="ovCount" type="number" min="0" placeholder="e.g. 150" style="background:#101018;color:#fff;border:1px solid #44445a;padding:8px;border-radius:8px;font-size:14px;text-align:center"/>
        <button onclick="doSetVotes()" style="background:#8b2222;padding:10px;font-size:13px;border-radius:8px;margin:0">Set</button>
      </div>
    </div>
  </div>

  <div class="right">
    <div class="rp">
      <div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em;color:#4da3ff;margin-bottom:10px">&#9679; Live Preview</div>
      <div id="pN" style="font-size:11px;opacity:.4;margin-bottom:2px">Q1/1</div>
      <div id="pTtl" style="font-size:11px;opacity:.3;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">-</div>
      <div id="pQ" style="font-size:16px;font-weight:bold;line-height:1.3;margin-bottom:9px">-</div>
      <div id="pBadge" style="margin-bottom:10px"></div>
      <div style="border-top:1px solid #1e1e30;margin-bottom:10px"></div>
      <div id="pOpts"></div>
      <div id="pWin" style="margin-top:8px;font-size:13px;font-weight:bold;color:#3cb85c"></div>
    </div>

    <div class="rp">
      <div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.1em;color:#4da3ff;margin-bottom:12px">&#127760; Network URLs</div>
      <div style="margin-bottom:10px"><div class="ul">&#128241; Audience phones</div><div class="uv">${base}/vote</div></div>
      <div style="margin-bottom:10px"><div class="ul">&#128250; Results / Resolume</div><div class="uv">${base}/results</div></div>
      <div><div class="ul">&#9881; Admin</div><div class="uv">${base}/admin</div></div>
    </div>
  </div>

</div>

<script>
var MAX=` + MAX + `;
var debT=null;

// Admin uses plain fetch — no socket needed, avoids connection issues
function refreshAdmin(){
  fetch('/api/results')
  .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
  .then(function(d){ render(d); })
  .catch(function(e){ document.getElementById('pill').textContent='ERROR: '+e.message; });
}

function esc(v){
  return String(v || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function render(d) {
  var pill=document.getElementById('pill');

  pill.textContent='Q'+d.qnum+' / '+d.qtotal+'  ·  '+(d.isOpen?'OPEN':'CLOSED');
  pill.className='pill '+(d.isOpen?'op':'cl');

  document.getElementById('inT').value=d.title;
  document.getElementById('inQ').value=d.question;
  document.getElementById('inC').value=d.activeOptionCount;

  d.allOpts.forEach(function(o){
    var el=document.getElementById('O'+o.id);
    if(el) el.value=o.name;
  });

  for(var i=1;i<=MAX;i++){
    var r=document.getElementById('R'+i);
    if(r) r.style.display=i<=d.activeOptionCount?'block':'none';
  }

  var sel=document.getElementById('qsel');
  sel.onchange=null;
  sel.innerHTML='';

  d.qlist.forEach(function(q){
    var opt=document.createElement('option');
    opt.value=q.i;
    opt.textContent='Q'+q.n+' - '+q.q;
    sel.appendChild(opt);
  });

  sel.value=d.qi;
  sel.onchange=function(){ go('/api/admin/question/'+this.value); };

  var ql=document.getElementById('qlist');
  ql.innerHTML='';

  d.qlist.forEach(function(q){
    var row=document.createElement('div');
    row.className='qi'+(q.i===d.qi?' on':'');

    var num=document.createElement('strong');
    num.textContent='Q'+q.n;

    var lbl=document.createElement('span');
    lbl.textContent=q.q;

    var btn=document.createElement('button');
    btn.textContent='Load';
    btn.setAttribute('data-i',q.i);
    btn.onclick=function(){ go('/api/admin/question/'+this.getAttribute('data-i')); };

    row.appendChild(num);
    row.appendChild(lbl);
    row.appendChild(btn);
    ql.appendChild(row);
  });

  document.getElementById('pN').textContent='Q'+d.qnum+'/'+d.qtotal;
  document.getElementById('pTtl').textContent=d.title;
  document.getElementById('pQ').textContent=d.question;

  var pb=document.getElementById('pBadge');
  pb.innerHTML='';

  function badge(t,c){
    var s=document.createElement('span');
    s.className='badge '+(c||'');
    s.textContent=t;
    pb.appendChild(s);
  }

  badge(d.isOpen?'OPEN':'CLOSED', d.isOpen?'op':'cl');
  badge(d.totalVotes+' votes');
  badge(d.activeOptionCount+' options');

  var po=document.getElementById('pOpts');
  po.innerHTML='';

  d.opts.forEach(function(o){
    var lead=d.winner&&d.winner.id===o.id&&d.totalVotes>0;
    var w=document.createElement('div');
    w.className='pb';

    var namesLine = '';
    if(o.names && o.names.length > 0){
      namesLine = '<div class="pnames">' + esc(o.names.join(' • ')) + '</div>';
    }

    w.innerHTML='<div class="pl"><span>'+esc(o.name)+(lead?' ❖':'')+'</span><span style="opacity:.4">'+o.votes+'v·'+o.percent+'%</span></div>' +
      '<div class="pg"><div class="pf'+(lead?' ld':'')+'" style="width:'+o.percent+'%"></div></div>' +
      namesLine;

    po.appendChild(w);
  });

  document.getElementById('pWin').textContent=(d.winner&&d.totalVotes>0)?'🏆 '+d.winner.name:'';
}

function onCount(val){
  var n=Math.max(1,Math.min(parseInt(val,10)||1,MAX));

  for(var i=1;i<=MAX;i++){
    var r=document.getElementById('R'+i);
    if(r)r.style.display=i<=n?'block':'none';
  }

  clearTimeout(debT);

  debT=setTimeout(function(){
    fetch('/api/admin/set-count',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({count:n})
    })
    .then(function(r){return r.json();})
    .then(function(d){render(d);})
    .catch(function(e){console.error('set-count error:',e);});
  },600);
}

function doSave(){
  var p={
    title:document.getElementById('inT').value,
    question:document.getElementById('inQ').value,
    count:document.getElementById('inC').value
  };

  for(var i=1;i<=MAX;i++){
    var el=document.getElementById('O'+i);
    p['o'+i]=el?el.value:'';
  }

  fetch('/api/admin/update',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(p)
  })
  .then(function(r){return r.json();})
  .then(function(d){render(d);})
  .catch(function(e){alert('Save error: '+e.message);});
}

function go(url){
  fetch(url,{method:'POST'})
  .then(function(r){
    if(!r.ok){ return r.text().then(function(t){alert('Error '+r.status+': '+t);}); }
    return r.json();
  })
  .then(function(d){
    if(d && d.qnum !== undefined) render(d);
  })
  .catch(function(e){ alert('Cannot reach server: '+e.message); });
}

// ── Manual override functions ─────────────────────────────
function buildOverrideRows(d) {
  var box = document.getElementById('overrideRows');
  if (!box) return;
  box.innerHTML = '';

  // Also rebuild the "set exact" option selector
  var sel = document.getElementById('ovOption');
  if (sel) {
    sel.innerHTML = '';
    d.opts.forEach(function(o) {
      var opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name + ' (' + o.votes + ' votes)';
      sel.appendChild(opt);
    });
  }

  d.opts.forEach(function(o) {
    var row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px 80px 80px;gap:6px;align-items:center;margin-bottom:6px';

    var lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:13px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    lbl.title = o.name;
    lbl.textContent = o.name + ' · ' + o.votes + 'v';

    function makeBtn(label, delta, color) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:' + color + ';padding:9px 0;font-size:13px;border-radius:8px;margin:0;font-weight:bold';
      b.setAttribute('data-oid', o.id);
      b.setAttribute('data-delta', delta);
      b.onclick = function() { doOverride(Number(this.getAttribute('data-oid')), Number(this.getAttribute('data-delta'))); };
      return b;
    }

    row.appendChild(lbl);
    row.appendChild(makeBtn('−10', -10, '#5a1a1a'));
    row.appendChild(makeBtn('−1',   -1, '#3a1a1a'));
    row.appendChild(makeBtn('+1',   +1, '#1a3a1a'));
    row.appendChild(makeBtn('+10', +10, '#1a4a1a'));
    box.appendChild(row);
  });
}

function doOverride(optionId, delta) {
  fetch('/api/admin/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionId: optionId, delta: delta })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) { if (d && d.qnum !== undefined) { render(d); buildOverrideRows(d); } })
  .catch(function(e) { alert('Override error: ' + e.message); });
}

function doSetVotes() {
  var sel   = document.getElementById('ovOption');
  var input = document.getElementById('ovCount');
  var oid   = sel ? Number(sel.value) : 0;
  var count = input ? Number(input.value) : 0;
  if (!oid)          return alert('Select an option first');
  if (isNaN(count) || count < 0) return alert('Enter a valid vote count (0 or more)');
  if (!confirm('Set ' + (sel.options[sel.selectedIndex] || {}).text + ' to exactly ' + count + ' votes?')) return;
  fetch('/api/admin/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionId: oid, set: count })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) { if (d && d.qnum !== undefined) { render(d); buildOverrideRows(d); if (input) input.value = ''; } })
  .catch(function(e) { alert('Set votes error: ' + e.message); });
}

// Hook into render so override rows refresh automatically with every update
var _origRender = render;
render = function(d) {
  _origRender(d);
  buildOverrideRows(d);
};

// Load on page open
refreshAdmin();
</script>
</body></html>`;
}

// ── start ─────────────────────────────────────────────────
server.listen(PORT, () => {
  const ip = localIP();

  console.log('');
  console.log('======================================================');
  console.log('              Voting App  —  RUNNING');
  console.log('======================================================');
  console.log('Your IP   : ' + ip);
  console.log('Audience  : http://' + ip + ':' + PORT + '/vote');
  console.log('Admin     : http://' + ip + ':' + PORT + '/admin');
  console.log('Results   : http://' + ip + ':' + PORT + '/results');
  console.log('OSC out   : ' + OSC_HOST + ':' + OSC_PORT);
  console.log('OSC in    : 0.0.0.0:' + OSC_IN_PORT);
  console.log('======================================================');
  console.log('Share the Audience URL with phones on the same WiFi.');
  console.log('');
});
