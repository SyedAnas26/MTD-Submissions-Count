/**
 * MTD Income Tax — Successful Submissions dashboard
 * ---------------------------------------------------
 * One-file Node server. No dependencies. Node 18+.
 *
 *   /            -> dashboard page (polls for updates, animates the counter)
 *   /webhook     -> POST endpoint for the Cliq / Zoho Logs alert (adds matched count to total)
 *   /state       -> GET  JSON { total, lastUpdated, lastAdded, history }
 *   /reset       -> POST resets the total to 0 (needs ?key=ADMIN_KEY)
 *
 * The running total is persisted to state.json next to this file, so it
 * survives restarts.
 *
 * Run:   PORT=3000 ADMIN_KEY=changeme node server.js
 * Then point your alert's webhook at  https://YOUR-PUBLIC-URL/webhook
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const STATE_FILE = path.join(__dirname, "state.json");

// ---------- persistence ----------
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    return {
      total: Number(s.total) || 0,
      lastUpdated: s.lastUpdated || null,
      lastAdded: Number(s.lastAdded) || 0,
      history: Array.isArray(s.history) ? s.history : [],
    };
  } catch {
    return { total: 0, lastUpdated: null, lastAdded: 0, history: [] };
  }
}
let state = loadState();

function saveState() {
  fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
}

// ---------- parse the matched count out of an incoming alert ----------
// The alert can arrive as JSON (Cliq / custom) or as the raw message text you
// pasted. We try a few shapes, then fall back to regex on the text.
function extractCount(bodyRaw, parsed) {
  // 1) explicit numeric fields if someone sends structured JSON
  if (parsed && typeof parsed === "object") {
    const candidates = [
      parsed.matchedCount,
      parsed.matched_count,
      parsed.count,
      parsed.value,
      parsed.data && parsed.data.matchedCount,
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null && !isNaN(Number(c))) return Number(c);
    }
  }
  // 2) Cliq usually posts the message under "text" or "message"
  let text = bodyRaw || "";
  if (parsed && typeof parsed === "object") {
    text = parsed.text || parsed.message || parsed.content || bodyRaw || "";
  }
  // 3) regex: "Matched Count [Threshold Operator & Value] : 1 [>0]"
  const m = String(text).match(/Matched\s*Count[^:]*:\s*(\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

// ---------- request helpers ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // -- webhook --
  if (url.pathname === "/webhook" && req.method === "POST") {
    const raw = await readBody(req);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not json, that's fine */ }

    const count = extractCount(raw, parsed);
    if (count === null) {
      return sendJSON(res, 400, {
        ok: false,
        error: "Could not find a matched count in the payload.",
        hint: 'Send JSON { "matchedCount": N } or the raw alert text containing "Matched Count ... : N".',
      });
    }
    state.total += count;
    state.lastAdded = count;
    state.lastUpdated = new Date().toISOString();
    state.history.unshift({ added: count, total: state.total, at: state.lastUpdated });
    state.history = state.history.slice(0, 50);
    saveState();
    return sendJSON(res, 200, { ok: true, added: count, total: state.total });
  }

  // -- state (polled by the page) --
  if (url.pathname === "/state" && req.method === "GET") {
    return sendJSON(res, 200, state);
  }

  // -- reset --
  if (url.pathname === "/reset" && req.method === "POST") {
    if (url.searchParams.get("key") !== ADMIN_KEY) return sendJSON(res, 403, { ok: false, error: "Bad key" });
    state = { total: 0, lastUpdated: new Date().toISOString(), lastAdded: 0, history: [] };
    saveState();
    return sendJSON(res, 200, { ok: true, total: 0 });
  }

  // -- dashboard --
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => console.log(`MTD dashboard on http://localhost:${PORT}`));

// ---------- the page ----------
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>MTD Income Tax — Submissions</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f5f7fa;
    --card:#ffffff;
    --ink:#1a2734;
    --muted:#6b7a8d;
    --line:#e6ebf1;
    --brand:#1a8f5c;      /* Zoho Books green */
    --brand-soft:#e8f6ef;
    --accent:#0f7ae5;
    --shadow:0 1px 2px rgba(16,32,48,.06),0 8px 24px rgba(16,32,48,.06);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  .topbar{background:var(--card);border-bottom:1px solid var(--line);
          padding:14px 24px;display:flex;align-items:center;gap:12px;}
  .logo{width:30px;height:30px;border-radius:8px;background:var(--brand);
        display:grid;place-items:center;color:#fff;font-weight:700;font-size:15px;}
  .topbar .name{font-weight:600;font-size:15px}
  .topbar .svc{color:var(--muted);font-size:13px;border-left:1px solid var(--line);padding-left:12px}
  .wrap{max-width:960px;margin:32px auto;padding:0 24px}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;color:var(--brand);
           background:var(--brand-soft);padding:5px 12px;border-radius:100px;
           font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--brand);
       box-shadow:0 0 0 0 rgba(26,143,92,.5);animation:pulse 2.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(26,143,92,.45)}70%{box-shadow:0 0 0 9px rgba(26,143,92,0)}100%{box-shadow:0 0 0 0 rgba(26,143,92,0)}}
  h1{font-size:22px;margin:14px 0 4px;font-weight:700;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:14px;margin:0 0 24px}

  .hero{background:var(--card);border:1px solid var(--line);border-radius:16px;
        box-shadow:var(--shadow);padding:38px 40px;position:relative;overflow:hidden}
  .hero:before{content:"";position:absolute;inset:0;
        background:radial-gradient(120% 100% at 100% 0,rgba(26,143,92,.08),transparent 55%);}
  .hero .label{color:var(--muted);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
  .count{font-family:'Roboto Mono',monospace;font-weight:600;
         font-size:clamp(56px,12vw,104px);line-height:1;letter-spacing:-.02em;
         color:var(--ink);margin:8px 0 6px;transition:color .25s}
  .count.bumped{color:var(--brand)}
  .metrow{display:flex;gap:28px;flex-wrap:wrap;margin-top:18px;position:relative}
  .metric .k{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  .metric .v{font-size:15px;font-weight:600;margin-top:3px}
  .flash{position:absolute;top:34px;right:40px;background:var(--brand);color:#fff;
         font-weight:600;font-size:13px;padding:6px 12px;border-radius:100px;
         opacity:0;transform:translateY(-6px);pointer-events:none;transition:all .3s}
  .flash.show{opacity:1;transform:translateY(0)}

  .grid{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;margin-top:20px}
  @media(max-width:720px){.grid{grid-template-columns:1fr}}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:20px 22px}
  .panel h2{font-size:14px;margin:0 0 14px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:9px 8px;border-bottom:1px solid var(--line)}
  td.n{font-family:'Roboto Mono',monospace;font-weight:600}
  .add{color:var(--brand);font-weight:600}
  .empty{color:var(--muted);font-size:13px;padding:10px 0}
  .kv{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px dashed var(--line);font-size:13px}
  .kv:last-child{border-bottom:0}
  .kv span:first-child{color:var(--muted)}
  .foot{color:var(--muted);font-size:12px;text-align:center;margin:26px 0 40px}
  code{background:#eef2f6;padding:2px 6px;border-radius:5px;font-family:'Roboto Mono',monospace;font-size:12px}
</style>
</head>
<body>
  <div class="topbar">
    <div class="logo">B</div>
    <div class="name">Books</div>
    <div class="svc">Log Alerts · US</div>
  </div>

  <div class="wrap">
    <span class="eyebrow"><span class="dot"></span> Live · updates automatically</span>
    <h1>MTD Income Tax — Successful Submissions</h1>
    <p class="sub">Running Month-to-Date total, tallied from Count Based Search Alerts.</p>

    <div class="hero">
      <div class="flash" id="flash">+0 new</div>
      <div class="label">Total MTD submissions</div>
      <div class="count" id="count">0</div>
      <div class="metrow">
        <div class="metric"><div class="k">Last update</div><div class="v" id="lastUpdated">—</div></div>
        <div class="metric"><div class="k">Last batch</div><div class="v" id="lastAdded">—</div></div>
        <div class="metric"><div class="k">Service</div><div class="v">books</div></div>
      </div>
    </div>

    <div class="grid">
      <div class="panel">
        <h2>Recent updates</h2>
        <table>
          <thead><tr><th>Time</th><th>Added</th><th>Running total</th></tr></thead>
          <tbody id="hist"><tr><td colspan="3" class="empty">Waiting for the first alert…</td></tr></tbody>
        </table>
      </div>
      <div class="panel">
        <h2>Alert details</h2>
        <div class="kv"><span>Alert</span><span>MTD Income tax — Successful Submissions</span></div>
        <div class="kv"><span>Type</span><span>Count based search</span></div>
        <div class="kv"><span>Threshold</span><span>&gt; 0</span></div>
        <div class="kv"><span>Region</span><span>US</span></div>
      </div>
    </div>

    <p class="foot">Point your alert webhook at <code>/webhook</code>. Counts add to the total each time an alert fires.</p>
  </div>

<script>
  const el = id => document.getElementById(id);
  let displayed = 0;   // what's currently shown
  let firstLoad = true;

  function fmtTime(iso){
    if(!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  // animate the big number from a -> b
  function animateCount(from, to){
    const node = el('count');
    const dur = 900, start = performance.now();
    node.classList.add('bumped');
    function step(now){
      const p = Math.min((now-start)/dur, 1);
      const eased = 1 - Math.pow(1-p, 3);       // easeOutCubic
      node.textContent = Math.round(from + (to-from)*eased).toLocaleString();
      if(p < 1) requestAnimationFrame(step);
      else { node.textContent = to.toLocaleString(); setTimeout(()=>node.classList.remove('bumped'),400); }
    }
    requestAnimationFrame(step);
  }

  function showFlash(added){
    const f = el('flash');
    f.textContent = '+' + added + ' new';
    f.classList.add('show');
    setTimeout(()=>f.classList.remove('show'), 2600);
  }

  function renderHistory(history){
    const tb = el('hist');
    if(!history || !history.length){ tb.innerHTML = '<tr><td colspan="3" class="empty">Waiting for the first alert…</td></tr>'; return; }
    tb.innerHTML = history.map(h =>
      '<tr><td>'+fmtTime(h.at)+'</td><td class="add">+'+h.added+'</td><td class="n">'+h.total.toLocaleString()+'</td></tr>'
    ).join('');
  }

  async function poll(){
    try{
      const r = await fetch('/state',{cache:'no-store'});
      const s = await r.json();
      el('lastUpdated').textContent = fmtTime(s.lastUpdated);
      el('lastAdded').textContent = s.lastAdded ? ('+'+s.lastAdded) : '—';
      renderHistory(s.history);

      if(firstLoad){
        el('count').textContent = (s.total||0).toLocaleString();
        displayed = s.total || 0;
        firstLoad = false;
      } else if(s.total !== displayed){
        const added = s.total - displayed;
        if(added > 0) showFlash(added);
        animateCount(displayed, s.total);
        displayed = s.total;
      }
    }catch(e){ /* keep trying */ }
  }

  poll();
  setInterval(poll, 4000);   // check every 4s
</script>
</body>
</html>`;