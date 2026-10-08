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

// ---------- the date this count starts from ----------
// An IST calendar date; the page shows it as "counting from <date>".
const PERIOD_START = process.env.PERIOD_START || "2026-10-01";

// ---------- day helpers (for the "today" counter) ----------
// The dashboard is anchored to India Standard Time so "today" and the row
// times are consistent no matter where the server runs or who is viewing.
const TZ = "Asia/Kolkata";
// Date in IST as YYYY-MM-DD.
function dayKey(d) {
  return new Date(d || Date.now()).toLocaleDateString("en-CA", { timeZone: TZ });
}
// Make sure state.today reflects the current day. If the stored day is stale
// (new day, first run, or migration), re-derive today's count from history.
// Returns true if it changed anything.
function syncToday(st) {
  const key = dayKey();
  if (st.today && st.today.date === key) return false;
  let count = 0;
  for (const h of st.history) {
    if (dayKey(h.at) === key) count += Number(h.added) || 0;
  }
  st.today = { date: key, count };
  return true;
}

// ---------- persistence ----------
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    const st = {
      total: Number(s.total) || 0,
      lastUpdated: s.lastUpdated || null,
      lastAdded: Number(s.lastAdded) || 0,
      history: Array.isArray(s.history) ? s.history : [],
      today: s.today && typeof s.today === "object"
        ? { date: s.today.date || null, count: Number(s.today.count) || 0 }
        : { date: null, count: 0 },
    };
    syncToday(st);   // align the today counter with the current day
    return st;
  } catch {
    return { total: 239, lastUpdated: null, lastAdded: 0, history: [], today: { date: dayKey(), count: 0 } };
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
    syncToday(state);            // roll the today counter over if it's a new day
    state.total += count;
    state.lastAdded = count;
    state.lastUpdated = new Date().toISOString();
    state.today.count += count;
    state.history.unshift({ added: count, total: state.total, at: state.lastUpdated });
    state.history = state.history.slice(0, 50);
    saveState();
    return sendJSON(res, 200, { ok: true, added: count, total: state.total, todayCount: state.today.count });
  }

  // -- state (polled by the page) --
  if (url.pathname === "/state" && req.method === "GET") {
    if (syncToday(state)) saveState();   // reflect a midnight rollover even without a new alert
    return sendJSON(res, 200, {
      ...state,
      todayCount: state.today.count,
      periodStart: PERIOD_START,
    });
  }

  // -- reset --
  if (url.pathname === "/reset" && req.method === "POST") {
    if (url.searchParams.get("key") !== ADMIN_KEY) return sendJSON(res, 403, { ok: false, error: "Bad key" });
    state = { total: 0, lastUpdated: new Date().toISOString(), lastAdded: 0, history: [], today: { date: dayKey(), count: 0 } };
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
<meta name="color-scheme" content="light"/>
<title>MTD Income Tax Submissions</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Roboto+Mono:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  /* ============ design tokens ============
     green  = the numbers (the thing being counted)
     blue   = Zoho Books brand chrome: logo, rails, chart bars
     amber  = the one highlight (newest batch)                       */
  :root{
    --bg:#eef4fb;
    --surface:#ffffff;
    --surface-2:#f7fafd;
    --ink:#0f2744;
    --ink-deep:#0c1f36;
    --card-ink:#ffffff;      /* the digits, reading out of the blue card */
    --card-seam:#174a8c;     /* the hinge gap between the two leaves */
    --ink-2:#44586e;
    --muted:#8295ab;
    --line:#e2eaf4;
    --line-soft:#eef3f9;

    --green:#15a05a;
    --green-2:#2cb972;
    --green-soft:#e7f7ee;

    --blue:#2f6fe4;          /* Books blue */
    --blue-2:#5b94f0;
    --blue-soft:#e9f2ff;
    --blue-ring:rgba(47,111,228,.4);

    --purple:#7c5cf0;
    --purple-soft:#f0ecfe;

    --amber:#f0883d;
    --amber-2:#f7a860;
    --amber-soft:#fef3e6;

    --bar:linear-gradient(180deg,#6fa6f5,#3b7ce8);
    --bar-last:linear-gradient(180deg,#fbb268,#f0883d);

    --shadow:0 1px 2px rgba(15,34,53,.04),0 14px 32px -16px rgba(15,34,53,.2);
    --shadow-lg:0 1px 2px rgba(15,34,53,.05),0 28px 60px -28px rgba(15,34,53,.3);
    --r-lg:20px;
    --r-md:14px;
    --r-sm:10px;
  }

  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);min-height:100vh;
       font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       -webkit-font-smoothing:antialiased;
       background-image:linear-gradient(180deg,#f6fafe 0%,#eaf2fb 55%,#e6eef9 100%);
       background-repeat:no-repeat;background-attachment:fixed}

  /* ============ top bar ============ */
  .topbar{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.88);
          -webkit-backdrop-filter:saturate(1.6) blur(12px);backdrop-filter:saturate(1.6) blur(12px);
          border-bottom:1px solid var(--line);
          display:flex;align-items:center;justify-content:space-between;gap:16px;
          padding:11px max(20px,calc(50vw - 560px))}
  .brand{display:flex;align-items:center;gap:10px;min-width:0}
  .logo{width:30px;height:30px;border-radius:8px;flex:none;display:block;
        box-shadow:0 2px 8px -2px var(--blue-ring)}
  .brand-name{font-weight:650;font-size:15px;letter-spacing:-.01em}
  .brand-div{width:1px;height:16px;background:var(--line);flex:none}
  .brand-svc{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  .status{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;
          padding:6px 13px;border-radius:999px;white-space:nowrap;flex:none;
          background:var(--blue-soft);color:var(--blue);
          border:1px solid rgba(34,109,180,.22)}
  .status svg{width:13px;height:13px;flex:none;opacity:.85}

  /* ============ layout ============ */
  .wrap{max-width:1120px;margin:0 auto;padding:30px 20px 0}
  .page-head{margin-bottom:22px}
  h1{font-size:clamp(20px,3.2vw,27px);margin:0 0 7px;font-weight:750;letter-spacing:-.022em;line-height:1.2}
  .sub{color:var(--muted);font-size:14px;margin:0;line-height:1.55;max-width:66ch}
  .sub b{color:var(--ink-2);font-weight:650}

  /* ============ entrance choreography ============ */
  @keyframes rise{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  @keyframes riseSm{from{opacity:0;transform:translateY(11px)}to{opacity:1;transform:none}}
  @keyframes sweep{
    0%{opacity:0;transform:translateX(-110%) skewX(-16deg)}
    15%{opacity:1}
    85%{opacity:1}
    100%{opacity:0;transform:translateX(300%) skewX(-16deg)}}
  @keyframes ring{0%{opacity:.5;transform:translate(-50%,-50%) scale(.55)}100%{opacity:0;transform:translate(-50%,-50%) scale(2)}}
  @keyframes floatUp{0%{opacity:0;transform:translateX(-50%) translateY(6px) scale(.9)}18%{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}80%{opacity:1}100%{opacity:0;transform:translateX(-50%) translateY(-30px) scale(1)}}
  @keyframes cardIn{from{opacity:0;transform:translateY(14px) scale(.96)}
                    to{opacity:1;transform:none}}
  @keyframes growBar{from{height:0}}
  .anim{opacity:0}
  .anim.in{animation:rise .7s cubic-bezier(.16,.84,.44,1) both}
  .anim-sm{opacity:0}
  .anim-sm.in{animation:riseSm .55s cubic-bezier(.16,.84,.44,1) both}

  /* ============ hero ============ */
  .hero{background:linear-gradient(168deg,#ffffff 0%,#f5faff 55%,#e9f3fd 100%);
        border:1px solid #dfeaf7;border-radius:var(--r-lg);
        box-shadow:0 1px 2px rgba(15,39,68,.04),0 22px 44px -26px rgba(47,111,228,.26);
        padding:26px 30px 24px;position:relative;overflow:hidden}
  /* two soft wave bands across the lower half */
  .hero:before{content:"";position:absolute;left:0;right:0;bottom:0;height:50%;pointer-events:none;
        background-repeat:no-repeat;background-size:100% 100%;
        background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 320' preserveAspectRatio='none'><path d='M0,78 C190,18 340,132 540,104 C790,70 940,172 1200,82 L1200,320 L0,320 Z' fill='rgba(47,111,228,0.019)'/><path d='M0,160 C220,112 380,206 620,178 C840,152 1010,224 1200,164 L1200,320 L0,320 Z' fill='rgba(47,111,228,0.013)'/></svg>")}
  .hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;position:relative;z-index:2}
  .hero-label{color:#04172f;font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.09em}
  .hero-label .since{display:block;margin-top:5px;font-style:normal;font-weight:600;
         font-size:11px;letter-spacing:.04em;text-transform:none;color:var(--blue)}
  .flash{background:linear-gradient(135deg,var(--green-2),var(--green));color:#fff;
         font-weight:650;font-size:12.5px;padding:6px 13px;border-radius:999px;flex:none;
         opacity:0;transform:translateY(-5px) scale(.94);pointer-events:none;
         transition:opacity .3s,transform .3s;box-shadow:0 6px 18px -4px rgba(23,138,90,.4)}
  .flash.show{opacity:1;transform:none}

  .counthost{position:relative;width:fit-content;margin:18px auto 8px}
  .countwrap{position:relative;display:block;padding:18px 14px 22px;overflow:hidden}
  .count{font-family:'Roboto Mono',ui-monospace,monospace;font-weight:700;font-variant-numeric:tabular-nums;
         font-size:clamp(46px,10.5vw,84px);line-height:1;letter-spacing:0;
         color:var(--card-ink);position:relative;z-index:1;
         display:inline-flex;align-items:stretch;justify-content:center;
         gap:.09em;transform-origin:center;
         /* The footprint is reserved up front, wide enough for "9,999" and one
            card tall, so the hero never reflows: not on first paint while the
            board is still empty, and not when the total gains a digit. The
            cards sit centred inside it. */
         min-width:4em;min-height:1.38em}

  /* ---- flip-calendar digit ----
     Four stacked halves per digit. At rest all four show the same glyph, so the
     cell looks like plain text. On a change the top half folds down (showing the
     OLD digit) to reveal the NEW one behind it, then the bottom half swings up. */
  /* the card. Its own background is the hinge seam colour; the four halves are
     inset 1px vertically, so a hairline of it shows through across the middle. */
  .dg{position:relative;display:inline-block;width:.84em;height:1.38em;
      perspective:300px;-webkit-perspective:300px;
      border-radius:.12em;background:var(--card-seam);
      box-shadow:0 10px 22px -10px rgba(23,74,140,.5),
                 0 2px 4px -1px rgba(23,74,140,.3),
                 0 0 0 1px rgba(23,74,140,.18)}
  /* hinge pins, left and right of the seam */
  .dg:before,.dg:after{content:"";position:absolute;top:50%;width:.062em;height:.14em;
      transform:translateY(-50%);border-radius:.025em;z-index:6;pointer-events:none;
      background:linear-gradient(90deg,#8396ab,#f2f7fb 42%,#8b9eb3);
      box-shadow:0 1px 2px rgba(24,54,86,.45)}
  .dg:before{left:-.026em}
  .dg:after{right:-.026em}

  .dg .h{position:absolute;left:0;right:0;height:calc(50% - 1px);overflow:hidden;display:block}
  .dg .h > span{position:absolute;left:0;right:0;height:1.38em;line-height:1.38em;
         text-align:center;display:block}
  /* top halves catch the light, bottom halves fall away slightly */
  .dg .st,.dg .ft{top:0;border-radius:.12em .12em 0 0;
         background:linear-gradient(180deg,#4a8bea 0%,#3a79db 58%,#3171d2 100%);
         box-shadow:inset 0 1px 0 rgba(255,255,255,.26)}
  .dg .sb,.dg .fb{bottom:0;border-radius:0 0 .12em .12em;
         background:linear-gradient(180deg,#1f5bad 0%,#2868bd 62%,#2d70c6 100%);
         box-shadow:inset 0 -1px 0 rgba(255,255,255,.14)}
  .dg .st > span,.dg .ft > span{top:0}
  .dg .sb > span,.dg .fb > span{bottom:0}
  .dg .st,.dg .sb{z-index:1}
  /* only the two leaves that rotate hide their backface */
  .dg .ft,.dg .fb{backface-visibility:hidden;-webkit-backface-visibility:hidden}
  .dg .ft{z-index:3;transform-origin:bottom center;-webkit-transform-origin:bottom center}
  .dg .fb{z-index:3;transform-origin:top center;-webkit-transform-origin:top center;
          transform:rotateX(90deg);-webkit-transform:rotateX(90deg)}
  /* the folding panel darkens a touch as it swings, so the motion reads */
  .dg.go .ft{animation:foldTop var(--ft,.3s) cubic-bezier(.52,.04,.78,.46) var(--d,0ms) forwards}
  .dg.go .fb{animation:foldBot var(--fb,.34s) cubic-bezier(.2,.85,.3,1.06)
             calc(var(--d,0ms) + var(--ft,.3s)) forwards}
  /* the static bottom half sits in the falling leaf's shadow as it passes over */
  .dg.go .sb{animation:leafShade var(--ft,.3s) linear var(--d,0ms) both}
  /* while folding, both leaves catch light along the hinge edge, which is what
     reads as thickness */
  .dg.go .ft{box-shadow:inset 0 1px 0 rgba(255,255,255,.24),
                        inset 0 -2px 3px -1px rgba(255,255,255,.3)}
  .dg.go .fb{box-shadow:inset 0 -1px 0 rgba(255,255,255,.14),
                        inset 0 2px 3px -1px rgba(0,0,0,.35)}
  /* while the counter is rolling up from zero the leaves snap over quickly */
  .count.rolling{--ft:.045s;--fb:.05s}
  @keyframes foldTop{
    0%{transform:rotateX(0);filter:brightness(1)}
    70%{filter:brightness(.74)}
    100%{transform:rotateX(-90deg);filter:brightness(.48)}}
  @keyframes foldBot{
    0%{transform:rotateX(90deg);filter:brightness(.42)}
    60%{filter:brightness(.8)}
    100%{transform:rotateX(0);filter:brightness(1)}}
  @keyframes leafShade{
    0%{filter:brightness(1)}
    75%{filter:brightness(.72)}
    100%{filter:brightness(.8)}}
  /* same font-size and line box as a card, bottom-aligned, so the comma's
     baseline lands exactly where the digits' baseline does */
  /* entrance only — removed again before the folds run, so no stray transform
     is left on .dg to flatten the 3D of its leaves */
  .dg.appear,.sep.appear{animation:cardIn .36s cubic-bezier(.16,.84,.44,1) var(--ad,0ms) both}
  .sep{display:inline-block;width:.26em;text-align:center;align-self:flex-end;
       line-height:1.38em;color:var(--ink-2)}
  /* starts fully clear of the left edge, ends fully clear of the right */
  .countwrap .shine{position:absolute;z-index:4;
        top:var(--sh-t,0px);left:var(--sh-l,0px);
        height:var(--sh-h,100%);width:var(--sh-w,34%);
        pointer-events:none;opacity:0;
        transform:translateX(-110%) skewX(-16deg);
        background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.5) 40%,
                   rgba(255,255,255,.92) 50%,rgba(255,255,255,.5) 60%,transparent 100%);
        mix-blend-mode:overlay}
  .countwrap.sweep .shine{animation:sweep .95s cubic-bezier(.33,0,.3,1) forwards}
  .counthost .ripple{position:absolute;top:50%;left:50%;width:150px;height:150px;
        border-radius:50%;border:2px solid var(--green);z-index:0;opacity:0;pointer-events:none}
  .countwrap.ripple-go ~ .ripple{animation:ring .9s ease-out}
  .floater{position:absolute;left:50%;top:-10px;transform:translateX(-50%);z-index:3;pointer-events:none;
           font-family:'Roboto Mono',monospace;font-weight:700;font-size:28px;color:var(--green);opacity:0}
  .floater.go{animation:floatUp 1.4s ease-out}

  /* milestone rail — blue, so it reads as chrome not as a number */
  .ms{position:relative;z-index:2;max-width:520px;margin:16px auto 2px}
  .ms-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
           font-size:12px;margin-bottom:7px}
  .ms-head .l{color:var(--ink-2);font-weight:600}
  .ms-head .r{color:var(--blue);font-weight:700;font-family:'Roboto Mono',monospace;font-variant-numeric:tabular-nums;
           transition:color .55s ease}
  .ms-track{height:9px;border-radius:999px;overflow:hidden;
            background:#e6ecf5;border:1px solid #dde6f1}
  /* one flat colour across the whole bar; MS_STAGES below picks which one */
  .ms-fill{display:block;height:100%;width:0;border-radius:999px;
           background:#e8736b;
           transition:width .9s cubic-bezier(.16,.84,.44,1),background-color .55s ease}

  /* ============ stat cards — values green, chrome blue ============ */
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:16px}
  .stat{border:1px solid var(--line);border-radius:var(--r-md);
        box-shadow:0 1px 2px rgba(15,39,68,.03),0 10px 22px -16px rgba(15,39,68,.16);
        padding:15px 17px 16px;position:relative;overflow:hidden;
        background:var(--surface);
        transition:transform .2s cubic-bezier(.16,.84,.44,1),box-shadow .2s}
  .stat:hover{transform:translateY(-2px);
              box-shadow:0 1px 2px rgba(15,39,68,.04),0 16px 30px -18px rgba(15,39,68,.26)}
  .stat .k{display:flex;align-items:center;gap:10px;color:var(--ink-2);
           font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
  .stat .ic{width:34px;height:34px;border-radius:50%;flex:none;display:grid;place-items:center}
  .stat .ic svg{width:16px;height:16px}
  .stat .v{font-family:'Roboto Mono',monospace;font-variant-numeric:tabular-nums;
           font-size:27px;font-weight:700;letter-spacing:-.03em;margin:11px 0 3px;line-height:1;
           color:var(--green)}
  .stat .s{color:var(--muted);font-size:12px;font-weight:500}
  /* one accent per card, matching the mockup */
  .s-blue  {background:linear-gradient(168deg,#f3f9ff,#ffffff 72%);border-color:#dceaf9}
  .s-blue   .ic{background:#dcebff;color:var(--blue)}
  .s-green {background:linear-gradient(168deg,#f1fbf6,#ffffff 72%);border-color:#d8f0e3}
  .s-green  .ic{background:#d9f3e5;color:var(--green)}
  .s-purple{background:linear-gradient(168deg,#f7f4ff,#ffffff 72%);border-color:#e5ddfb}
  .s-purple .ic{background:#e8e0fd;color:var(--purple)}
  .s-amber {background:linear-gradient(168deg,#fff9f1,#ffffff 72%);border-color:#f8e7d0}
  .s-amber  .ic{background:#fdecd8;color:var(--amber)}

  /* ============ panels ============ */
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);
         box-shadow:var(--shadow);margin-top:16px;overflow:hidden}
  .panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
              padding:15px 20px;border-bottom:1px solid var(--line-soft)}
  .panel-head h2{font-size:13.5px;margin:0;font-weight:650;letter-spacing:-.005em}
  .panel-head .note{color:var(--muted);font-size:11.5px;font-weight:500}
  .tag{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;
       padding:5px 11px;border-radius:999px;background:var(--surface);color:var(--ink-2);
       border:1px solid var(--line)}
  .tag i{width:8px;height:8px;border-radius:50%;display:block;background:#3b7ce8}
  .tag.t-last i{background:var(--amber)}
  .seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--line);
       border-radius:999px;padding:2px;flex:none}
  .seg-b{appearance:none;-webkit-appearance:none;border:0;background:transparent;
       cursor:pointer;font:inherit;font-size:11.5px;font-weight:600;color:var(--muted);
       padding:4px 11px;border-radius:999px;white-space:nowrap;
       transition:background .18s,color .18s}
  .seg-b.on{background:var(--surface);color:var(--blue);
       box-shadow:0 1px 2px rgba(15,39,68,.12)}
  .panel-body{padding:18px 20px 20px}

  /* ---- activity chart ---- */
  /* axis gutter on the left, plot area on the right */
  .plot-row{display:flex;align-items:stretch;gap:10px}
  .yax{position:relative;width:16px;flex:none;height:132px}
  .yax span{position:absolute;right:0;transform:translateY(50%);
            color:var(--muted);font-size:11px;font-weight:500;line-height:1}
  .plot{position:relative;flex:1 1 auto;min-width:0;height:132px}
  .gl{position:absolute;left:0;right:0;height:0;border-top:1px dashed #dfe7f1}
  .gl.zero{border-top:1px solid var(--line)}
  .chart{display:flex;align-items:flex-end;gap:4px;height:100%;position:relative}
  /* the columns always share the full width and it is the BAR that gets capped,
     centred in its column — so 3 updates space out as deliberately as 24 */
  .col{flex:1 1 0;min-width:0;height:100%;position:relative;
       display:flex;flex-direction:column;align-items:center;justify-content:flex-end}
  /* when there are few enough bars to read, print the value above each one */
  .col .val{font-family:'Roboto Mono',monospace;font-variant-numeric:tabular-nums;
       font-size:11px;font-weight:700;color:var(--ink-2);line-height:1;margin-bottom:5px}
  .col.last .val{color:var(--amber)}
  .col .bar{width:100%;max-width:40px;border-radius:5px 5px 2px 2px;background:var(--bar);min-height:3px;
            animation:growBar .62s cubic-bezier(.16,.84,.44,1) both;
            transition:filter .18s,opacity .18s;opacity:.92}
  .col:hover .bar{opacity:1;filter:brightness(1.1) saturate(1.08)}
  .col.last .bar{background:var(--bar-last);opacity:1}
  .col .tip{position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%) translateY(3px);
            background:var(--ink);color:#fff;font-size:11.5px;font-weight:600;line-height:1.45;
            padding:6px 10px;border-radius:8px;white-space:nowrap;pointer-events:none;
            opacity:0;transition:opacity .16s,transform .16s;z-index:5;
            box-shadow:0 8px 20px -8px rgba(0,0,0,.45)}
  .col .tip b{font-family:'Roboto Mono',monospace;color:#7fe3b4;font-weight:700}
  .col .tip:after{content:"";position:absolute;top:100%;left:50%;margin-left:-4px;
            border:4px solid transparent;border-top-color:var(--ink)}
  .col:hover .tip{opacity:1;transform:translateX(-50%)}
  .chart-x{display:flex;justify-content:space-between;color:var(--muted);
           font-size:11px;font-weight:500;margin-top:9px;padding-left:26px}
  .chart-empty{height:132px;display:grid;place-items:center;color:var(--muted);font-size:13px;
               border:1px dashed var(--line);border-radius:var(--r-sm)}

  /* ---- table ---- */
  .tscroll{max-height:360px;overflow:auto;overscroll-behavior:contain}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{position:sticky;top:0;z-index:1;background:var(--surface-2);
       text-align:left;color:var(--muted);font-weight:650;font-size:11px;
       text-transform:uppercase;letter-spacing:.06em;
       padding:9px 20px;border-bottom:1px solid var(--line)}
  thead th.r{text-align:right}
  tbody td{padding:10px 20px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}
  tbody tr{transition:background .15s}
  tbody tr:hover{background:var(--blue-soft)}
  tbody tr.fresh{animation:riseSm .5s cubic-bezier(.16,.84,.44,1) both}
  td.when{white-space:nowrap}
  td.when .abs{color:var(--ink-2);font-weight:500}
  td.when .rel{color:var(--muted);font-size:11.5px;margin-left:7px}
  td.add{width:1%;white-space:nowrap}
  .pill{display:inline-flex;align-items:center;justify-content:center;min-width:46px;
        font-family:'Roboto Mono',monospace;font-variant-numeric:tabular-nums;
        font-weight:700;font-size:12px;padding:4px 9px;border-radius:7px;
        background:var(--green-soft);color:var(--green);border:1px solid rgba(23,138,90,.2)}
  td.tot{text-align:right;font-family:'Roboto Mono',monospace;font-variant-numeric:tabular-nums;
         font-weight:650;color:var(--green)}
  .empty{color:var(--muted);font-size:13px;padding:26px 20px!important;text-align:center}

  .foot{color:var(--muted);font-size:11.5px;text-align:center;padding:28px 20px 40px;
        display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap}
  .foot span{opacity:.6}

  /* ============ responsive ============ */
  @media (max-width:860px){
    .stats{grid-template-columns:repeat(2,1fr)}
    .hero{padding:22px 20px 20px}
    .wrap{padding-top:22px}
  }
  @media (max-width:520px){
    .stats{grid-template-columns:1fr 1fr;gap:10px}
    .stat .v{font-size:23px}
    .brand-div,.brand-svc{display:none}
    .panel-head{padding:13px 15px}
    .panel-head .tag{display:none}
    .seg-b{padding:4px 9px;font-size:11px}
    .panel-body{padding:15px}
    thead th,tbody td{padding-left:15px;padding-right:15px}
    /* shrink the plot box, NOT .chart — .chart is height:100% of .plot now, and
       pinning it to 98px left the bars floating 34px above the zero line */
    .plot,.yax{height:104px}
    .chart-empty{height:104px}
    .countwrap{padding:8px 10px;border-radius:16px}
    /* leave room for more digits on a narrow screen */
    .count{font-size:clamp(34px,10.5vw,46px);min-width:3.6em}
  }
  @media(prefers-reduced-motion:reduce){
    .anim,.anim-sm{opacity:1;animation:none!important}
    .countwrap.sweep .shine,.countwrap.ripple-go ~ .ripple,
    .dg.go .ft,.dg.go .fb,.floater.go,.col .bar,tbody tr.fresh{animation:none!important}
    .ms-fill{transition:none}
  }

  /* ============ milestone confetti + banner ============ */
  .confetti-layer{position:fixed;inset:0;pointer-events:none;z-index:60;overflow:hidden}
  .confetti-piece{position:absolute;top:-20px;border-radius:2px;opacity:.95;
    animation-name:confettiFall;animation-timing-function:cubic-bezier(.25,.6,.4,1);
    animation-fill-mode:forwards}
  @keyframes confettiFall{
    0%{transform:translateY(-20px) translateX(0) rotate(0);opacity:1}
    100%{transform:translateY(102vh) translateX(var(--drift)) rotate(var(--spin));opacity:.9}
  }
  .milestone-banner{position:fixed;top:64px;left:50%;transform:translate(-50%,-24px);
    z-index:70;pointer-events:none;opacity:0;
    background:linear-gradient(135deg,var(--blue),#3d8fd8);color:#fff;font-weight:700;
    font-size:15px;padding:12px 22px;border-radius:999px;
    box-shadow:0 14px 38px -10px rgba(34,109,180,.6);transition:opacity .35s,transform .35s}
  .milestone-banner.show{opacity:1;transform:translate(-50%,0)}
  .milestone-banner.big{background:linear-gradient(135deg,#f5b301,#e0447a 55%,#7b5cff);
    font-size:17px;box-shadow:0 16px 44px -10px rgba(224,68,122,.6)}

  /* ============ fireworks (thousands milestones) ============ */
  .fireworks-layer{position:fixed;inset:0;pointer-events:none;z-index:65;overflow:hidden}
  .fw-burst{position:absolute;width:0;height:0}
  .fw-spark{position:absolute;left:0;top:0;width:7px;height:7px;border-radius:50%;
    transform:translate(-50%,-50%);opacity:1;box-shadow:0 0 8px 1px currentColor;
    animation:fwFly var(--fw-dur,1100ms) cubic-bezier(.15,.6,.3,1) forwards}
  @keyframes fwFly{
    0%{transform:translate(-50%,-50%) translate(0,0) scale(1);opacity:1}
    70%{opacity:1}
    100%{transform:translate(-50%,-50%) translate(var(--fw-x),var(--fw-y)) scale(.3);opacity:0}
  }
  .fw-flash{position:absolute;width:12px;height:12px;border-radius:50%;
    transform:translate(-50%,-50%);background:#fff;
    box-shadow:0 0 26px 12px rgba(255,255,255,.9);
    animation:fwFlash .5s ease-out forwards}
  @keyframes fwFlash{0%{opacity:.95;transform:translate(-50%,-50%) scale(.4)}
    100%{opacity:0;transform:translate(-50%,-50%) scale(2.4)}}
  .fw-rocket{position:absolute;bottom:0;width:4px;height:16px;border-radius:2px;
    transform:translate(-50%,0);background:currentColor;
    box-shadow:0 0 10px 3px currentColor;
    animation:fwRise var(--rk-dur,850ms) cubic-bezier(.15,.7,.35,1) forwards}
  @keyframes fwRise{
    0%{transform:translate(-50%,0) scaleY(.7);opacity:.2}
    12%{opacity:1}
    88%{opacity:1}
    100%{transform:translate(-50%,var(--rk-y)) scaleY(1.15);opacity:.5}
  }
  @media(prefers-reduced-motion:reduce){
    .milestone-banner{transition:opacity .2s}
    .fireworks-layer{display:none}
  }
</style>
</head>
<body>
  <div id="confetti" class="confetti-layer" aria-hidden="true"></div>
  <div id="fireworks" class="fireworks-layer" aria-hidden="true"></div>
  <div id="milestone" class="milestone-banner" role="status"></div>

  <header class="topbar">
    <div class="brand">
      <svg class="logo" viewBox="0 0 32 32" role="img" aria-label="Zoho Books">
        <rect width="32" height="32" rx="8" fill="#226db4"/>
        <path d="M10 8.5h7.6c3.1 0 5 1.5 5 4.05 0 1.62-.83 2.72-2.2 3.2 1.74.42 2.8 1.65 2.8 3.5 0 2.75-2.04 4.25-5.4 4.25H10V8.5Zm3.35 6.2h3.6c1.3 0 2.05-.6 2.05-1.65 0-1.03-.75-1.6-2.05-1.6h-3.6v3.25Zm0 6.1h4.05c1.4 0 2.2-.63 2.2-1.75s-.8-1.75-2.2-1.75h-4.05v3.5Z" fill="#fff"/>
      </svg>
      <span class="brand-name">Books</span>
      <span class="brand-div" aria-hidden="true"></span>
      <span class="brand-svc">MTD Income Tax</span>
    </div>
    <span class="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.3V12l3 1.8"/></svg>
      Updates every hour
    </span>
  </header>

  <main class="wrap">
    <div class="page-head anim-sm">
      <h1>MTD Income Tax - Successful Submissions</h1>
      <p class="sub" id="headSub">Running total of submissions accepted by HMRC, which includes <b>Q2</b> submissions. The count <b>updates automatically every hour</b>. All times in IST.</p>
    </div>

    <section class="hero anim" aria-labelledby="heroLabel">
      <div class="hero-top">
        <span class="hero-label" id="heroLabel"><span id="heroTitle">Total MTD submissions</span><em class="since" id="heroSince"></em></span>
        <span class="flash" id="flash">+0 new</span>
      </div>
      <div class="counthost">
        <div class="countwrap" id="countwrap">
          <span class="count" id="count"></span>
          <span class="shine" aria-hidden="true"></span>
        </div>
        <span class="ripple" aria-hidden="true"></span>
        <span class="floater" id="floater" aria-hidden="true"></span>
      </div>
      <div class="ms">
        <div class="ms-head">
          <span class="l" id="msLabel">Next milestone</span>
          <span class="r" id="msLeft">—</span>
        </div>
        <div class="ms-track"><span class="ms-fill" id="msFill"></span></div>
      </div>
    </section>

    <section class="stats" aria-label="Key figures">
      <article class="stat s-blue anim-sm">
        <div class="k"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></span>Today</div>
        <div class="v" id="sToday">—</div>
        <div class="s" id="sTodaySub">submissions so far</div>
      </article>
      <article class="stat s-green anim-sm">
        <div class="k"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7-7 7 7"/></svg></span>Last batch</div>
        <div class="v" id="sBatch">—</div>
        <div class="s" id="sBatchSub">waiting for the next update</div>
      </article>
      <article class="stat s-purple anim-sm">
        <div class="k"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.3V12l3 1.8"/></svg></span>Updates today</div>
        <div class="v" id="sRuns">—</div>
        <div class="s" id="sRunsSub">hourly updates received</div>
      </article>
      <article class="stat s-amber anim-sm">
        <div class="k"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15l5-5.5 4 3.5 7-7.5"/><path d="M20 5.5h-4.6M20 5.5v4.6"/></svg></span>Busiest hour</div>
        <div class="v" id="sPeak">—</div>
        <div class="s" id="sPeakSub">no data yet</div>
      </article>
    </section>

    <section class="panel anim">
      <div class="panel-head">
        <h2>Submission activity</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="seg" id="chartSeg" role="group" aria-label="Chart grouping">
            <button type="button" class="seg-b on" data-mode="update">Per update</button>
            <button type="button" class="seg-b" data-mode="day">Per day</button>
          </div>
          <span class="tag t-last"><i></i>Latest</span>
        </div>
      </div>
      <div class="panel-body">
        <div id="chartHost"><div class="chart-empty">No activity recorded yet</div></div>
      </div>
    </section>

    <section class="panel anim">
      <div class="panel-head">
        <h2>Recent updates</h2>
        <span class="note" id="histNote">times in IST</span>
      </div>
      <div class="tscroll">
        <table>
          <thead><tr><th>Time</th><th>Added</th><th class="r">Running total</th></tr></thead>
          <tbody id="hist"><tr><td colspan="3" class="empty">Waiting for the first update…</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>

  <footer class="foot">
    <span>Updates automatically every hour</span>
    <span aria-hidden="true">·</span>
    <span>Anchored to Asia/Kolkata</span>
  </footer>

<script>
  const el = id => document.getElementById(id);
  const reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  const TZ = 'Asia/Kolkata';
  const STEP = 500;          // celebrate (and measure the rail) every 500 submissions
  let displayed = 0;
  let firstLoad = true;
  let knownTop = null;       // timestamp of the newest history row we have rendered
  let rollFast = false;      // true only during the intro roll, for snappier folds
  let chartSig = null;       // fingerprint of the data the chart was last drawn from
  let lastHistory = [];      // kept so the toggle can redraw without a fetch
  let chartMode = 'update';  // 'update' = one bar per alert, 'day' = summed per IST day
  try{ const m = localStorage.getItem('mtdChartMode');
       if(m === 'day' || m === 'update') chartMode = m; }catch(e){}
  let histSig = null;        // same for the table, so polling never steals your scroll

  /* ---------- time helpers (all anchored to IST) ---------- */
  function fmtTime(iso){
    if(!iso) return '—';
    return new Date(iso).toLocaleString('en-IN',
      {timeZone:TZ,month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function fmtClock(iso){
    if(!iso) return '—';
    return new Date(iso).toLocaleTimeString('en-IN',
      {timeZone:TZ,hour:'2-digit',minute:'2-digit'});
  }
  function relTime(iso){
    if(!iso) return '';
    const secs = Math.round((Date.now() - new Date(iso).getTime())/1000);
    if(secs < 45) return 'just now';
    if(secs < 3600) return Math.round(secs/60) + 'm ago';
    if(secs < 86400) return Math.round(secs/3600) + 'h ago';
    return Math.round(secs/86400) + 'd ago';
  }
  function dayKey(iso){
    return new Date(iso || Date.now()).toLocaleDateString('en-CA',{timeZone:TZ});
  }
  function fmtDay(iso){
    return new Date(iso).toLocaleDateString('en-IN',
      {timeZone:TZ,day:'numeric',month:'short'});
  }
  function hourOf(iso){
    return new Date(iso).toLocaleTimeString('en-GB',{timeZone:TZ,hour:'2-digit',hour12:false}).slice(0,2);
  }

  /* ---------- entrance choreography ---------- */
  function orchestrate(){
    const seq = [...document.querySelectorAll('.anim-sm, .anim')];
    seq.sort((a,b)=> a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    seq.forEach((node,i)=> setTimeout(()=>node.classList.add('in'), reduce ? 0 : 80*i));
    // safety net: never leave content invisible if something above throws
    setTimeout(()=>seq.forEach(n=>n.classList.add('in')), 2600);
  }

  /* ---------- counter effects ---------- */
  // a single left-to-right pass; callers fire this only once the digits have settled
  function sweep(){
    const w = el('countwrap');
    w.classList.remove('sweep'); void w.offsetWidth; w.classList.add('sweep');
    setTimeout(()=>w.classList.remove('sweep'), 1000);
  }
  function ripple(){
    const w = el('countwrap');
    w.classList.remove('ripple-go'); void w.offsetWidth; w.classList.add('ripple-go');
    setTimeout(()=>w.classList.remove('ripple-go'), 950);
  }
  function floatPlus(added){
    const f = el('floater');
    f.textContent = '+' + added;
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    setTimeout(()=>f.classList.remove('go'), 1450);
  }
  function showFlash(added){
    const f = el('flash');
    f.textContent = '+' + added + ' new';
    f.classList.add('show');
    setTimeout(()=>f.classList.remove('show'), 2800);
  }

  // count-up with easing; also drives the milestone rail so they move together
  /* ---------- flip-calendar digits ---------- */
  const CELL = '<span class="dg" data-v="">'
    + '<span class="h st"><span></span></span>'
    + '<span class="h sb"><span></span></span>'
    + '<span class="h ft"><span></span></span>'
    + '<span class="h fb"><span></span></span>'
    + '</span>';

  // park a cell on one glyph, all four halves agreeing, nothing animating
  function cellSet(cell, ch){
    cell.dataset.v = ch;
    cell.querySelectorAll('.h > span').forEach(sp => sp.textContent = ch);
  }

  // fold from whatever the cell shows now to ch; order staggers the cascade
  function cellFlip(cell, ch, order){
    const prev = cell.dataset.v;
    if(prev === ch) return;
    const fast = rollFast;
    cell.querySelector('.st > span').textContent = ch;    // revealed as the old top falls
    cell.querySelector('.sb > span').textContent = prev;  // holds until the new bottom lands
    cell.querySelector('.ft > span').textContent = prev;  // the panel that folds down
    cell.querySelector('.fb > span').textContent = ch;    // the panel that swings up
    cell.dataset.v = ch;
    cell.style.setProperty('--d', (fast ? 0 : order * 70) + 'ms');
    cell.classList.remove('go'); void cell.offsetWidth; cell.classList.add('go');
    // a flip arriving before the last one finished must cancel its cleanup,
    // or that timer fires mid-animation and snaps the card
    if(cell.tidy) clearTimeout(cell.tidy);
    cell.tidy = setTimeout(()=>{
      cell.classList.remove('go'); cellSet(cell, ch); cell.tidy = null;
    }, fast ? 190 : 700 + order * 70);
  }

  // Size the shine onto the row of cards, so the highlight runs across the
  // number itself rather than the whole reserved footprint.
  function fitShine(){
    const host = el('count'), wrap = el('countwrap');
    if(!host || !wrap || !host.children.length) return;
    const kids = host.children;
    const a = kids[0].getBoundingClientRect();
    const b = kids[kids.length - 1].getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const span = b.right - a.left;
    if(span <= 0) return;
    wrap.style.setProperty('--sh-l', (a.left - w.left).toFixed(1) + 'px');
    wrap.style.setProperty('--sh-w', (span * 0.34).toFixed(1) + 'px');
    wrap.style.setProperty('--sh-t', (a.top - w.top).toFixed(1) + 'px');
    wrap.style.setProperty('--sh-h', a.height.toFixed(1) + 'px');
  }

  function paintNumber(value, flip){
    const host = el('count');
    const chars = Array.from(value.toLocaleString());
    // the comma moves when the number gains a digit, so compare the shape too
    const sameShape = host.childElementCount === chars.length
      && chars.every((ch,i) => (ch === ',') === host.children[i].classList.contains('sep'));
    if(!sameShape){
      host.innerHTML = chars.map(ch => ch === ',' ? '<span class="sep">,</span>' : CELL).join('');
    }
    let order = 0;
    chars.forEach((ch,i) => {
      if(ch === ',') return;
      const cell = host.children[i];
      if(cell.dataset.v === ch){ order++; return; }   // digit unchanged: leave it still
      if(flip) cellFlip(cell, ch, order++);
      else { cellSet(cell, ch); order++; }
    });
    fitShine();
  }

  function animateCount(from, to, opts){
    paintNumber(to, !reduce);
    paintMilestone(to);
  }

  /* ---------- intro: settle the board one column at a time ----------
     Every card starts on 0 in the final layout. The rightmost column tumbles
     up to its digit first; the columns to its left stay on 0 until their turn.
     The milestone rail is deliberately left alone until the whole thing lands,
     so it fills once instead of twitching on every step. */
  const ROLL_STEP_MS = 98;        // between folds within a column
  const ROLL_GAP_MS  = 98;        // between one column finishing and the next

  // every value from 1 up to the digit, so a column folds as many times as its
  // digit is worth: 6 is six folds, 0 is none
  function rollStops(digit){
    const stops = [];
    for(let v = 1; v <= digit; v++) stops.push(v);
    return stops;
  }

  function rollUp(target, done){
    const host = el('count');
    const finish = () => {
      rollFast = false;
      host.classList.remove('rolling');
      paintMilestone(target);     // the rail moves only now, once
      if(done) done();
    };
    if(reduce || target <= 0){
      paintNumber(target, false);
      paintMilestone(target);
      if(done) done();
      return;
    }

    const chars = Array.from(target.toLocaleString());
    // lay out the final shape with every digit parked on zero
    host.innerHTML = chars.map(ch => ch === ',' ? '<span class="sep">,</span>' : CELL).join('');
    chars.forEach((ch,i) => { if(ch !== ',') cellSet(host.children[i], '0'); });
    fitShine();

    // digit columns, rightmost first
    const cols = [];
    chars.forEach((ch,i) => { if(ch !== ',') cols.push(i); });
    cols.reverse();

    rollFast = true;
    host.classList.add('rolling');

    // ease the board in rather than letting it snap into existence
    const kids = [...host.children];
    kids.forEach((node,i) => {
      node.style.setProperty('--ad', (i * 50) + 'ms');
      node.classList.add('appear');
    });
    const settledIn = 50 * Math.max(0, kids.length - 1) + 360;
    setTimeout(()=>kids.forEach(node => {
      node.classList.remove('appear');
      node.style.removeProperty('--ad');
    }), settledIn);

    let c = 0;
    const nextCol = () => {
      if(c >= cols.length){ setTimeout(finish, 170); return; }
      const at = cols[c];
      const cell = host.children[at];
      const stops = rollStops(Number(chars[at]));
      c++;
      if(!stops.length){ setTimeout(nextCol, 55); return; }   // already a zero
      let k = 0;
      const step = () => {
        cellFlip(cell, String(stops[k]), 0);
        k++;
        setTimeout(k < stops.length ? step : nextCol, k < stops.length ? ROLL_STEP_MS : ROLL_GAP_MS);
      };
      step();
    };
    setTimeout(nextCol, settledIn + 70);   // start rolling once the board has arrived
  }

  /* ---------- milestone rail: how far to the next 500 ----------
     The bar is a single flat colour that steps red -> amber -> blue -> green
     as it fills, so the colour alone tells you how close the milestone is. */
  const MS_STAGES = [
    { upto:  25, colour: '#f0883d' },   // just started
    { upto:  50, colour: '#f0b429' },
    { upto:  75, colour: '#2f6fe4' },
    { upto: 101, colour: '#15a05a' },   // nearly there
  ];
  function msColour(pct){
    for(const st of MS_STAGES) if(pct < st.upto) return st.colour;
    return MS_STAGES[MS_STAGES.length-1].colour;
  }

  function paintMilestone(total){
    const next = Math.floor(total/STEP)*STEP + STEP;
    const prev = next - STEP;
    const pct  = Math.max(0, Math.min(100, ((total - prev)/STEP)*100));
    const left = next - total;
    const big  = next % 1000 === 0;
    el('msLabel').textContent = (big ? 'Next major milestone · ' : 'Next milestone · ') + next.toLocaleString();
    el('msLeft').textContent  = left.toLocaleString() + ' to go';
    const colour = msColour(pct);
    el('msFill').style.width = pct.toFixed(1) + '%';
    el('msFill').style.backgroundColor = colour;
    el('msLeft').style.color = colour;                  // keep the label in step
  }

  /* ---------- the date the count starts from ---------- */
  function paintStart(iso){
    if(!iso) return;
    const start = new Date(iso + 'T00:00:00+05:30')
      .toLocaleDateString('en-GB',{timeZone:TZ,day:'numeric',month:'short',year:'numeric'});
    el('heroSince').textContent = 'Counting from ' + start;
    el('headSub').innerHTML = 'Running total of submissions accepted by HMRC since <b>' + start
      + '</b>, which includes <b>Q2</b> submissions. The count <b>updates automatically every hour</b>.'
      + ' All times in IST.';
  }

  /* ---------- derived stats ---------- */
  function paintStats(s){
    paintStart(s.periodStart);
    const hist = s.history || [];
    const today = dayKey();
    const todays = hist.filter(h => dayKey(h.at) === today);
    const todayCount = (s.todayCount != null) ? s.todayCount
                     : (s.today && s.today.count) || 0;

    el('sToday').textContent = todayCount.toLocaleString();
    el('sTodaySub').textContent = todayCount === 1 ? 'submission so far' : 'submissions so far';

    el('sBatch').textContent = s.lastAdded ? ('+' + s.lastAdded.toLocaleString()) : '—';
    el('sBatchSub').textContent = s.lastUpdated
      ? fmtClock(s.lastUpdated) + ' · ' + relTime(s.lastUpdated)
      : 'waiting for the next update';

    el('sRuns').textContent = todays.length.toLocaleString();
    const avg = todays.length ? Math.round((todayCount/todays.length)*10)/10 : 0;
    el('sRunsSub').textContent = todays.length
      ? 'avg +' + avg + ' per update'
      : 'hourly updates received';

    // busiest hour of the day so far
    const byHour = {};
    todays.forEach(h => { const k = hourOf(h.at); byHour[k] = (byHour[k]||0) + (Number(h.added)||0); });
    const hours = Object.keys(byHour);
    if(hours.length){
      const top = hours.reduce((a,b)=> byHour[b] > byHour[a] ? b : a);
      el('sPeak').textContent = top + ':00';
      el('sPeakSub').textContent = '+' + byHour[top].toLocaleString() + ' submissions';
    }else{
      el('sPeak').textContent = '—';
      el('sPeakSub').textContent = 'no data yet';
    }
  }

  // Sum each IST day into one bar. Keyed on dayKey so the bucket boundaries
  // match the "today" counter rather than drifting with the viewer's clock.
  function dayBuckets(history){
    const byDay = new Map();
    (history || []).forEach(h => {
      const k = dayKey(h.at);
      const cur = byDay.get(k) || { day:k, added:0, at:h.at, runs:0 };
      cur.added += Number(h.added) || 0;
      cur.runs += 1;
      if(new Date(h.at) > new Date(cur.at)) cur.at = h.at;
      byDay.set(k, cur);
    });
    return [...byDay.values()].sort((a,b) => a.day < b.day ? -1 : 1);
  }

  function sigOf(history){
    if(!history || !history.length) return 'empty';
    return history.length + '|' + history[0].at + '|' + history[0].added;
  }

  /* ---------- activity chart: last 24 updates, oldest to newest ---------- */
  function renderChart(history){
    const host = el('chartHost');
    const sig = chartMode + '|' + sigOf(history);
    if(sig === chartSig) return;      // nothing new: leave the bars alone
    chartSig = sig;
    if(!history || !history.length){
      host.innerHTML = '<div class="chart-empty">No activity recorded yet</div>';
      return;
    }
    const byDay = chartMode === 'day';
    const rows = byDay ? dayBuckets(history).slice(-14)
                       : history.slice(0, 24).reverse();
    const max = Math.max.apply(null, rows.map(h => Number(h.added)||0)) || 1;

    // Pick a round axis step (1, 2, 5, 10, 20, 50 …) aiming for ~3 gridlines,
    // then take the ceiling one step above the peak so a bar never touches the
    // top of the plot and its label always has room.
    const raw  = Math.max(max, 1) / 3;
    const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
    let ceiling = step * Math.ceil(max / step);
    if(ceiling <= max) ceiling += step;

    const ticks = [];
    for(let v = 0; v <= ceiling + 1e-9; v += step) ticks.push(Math.round(v));

    const labelled = rows.length <= 12;        // sparse enough to print values
    const cols = rows.map((h,i) => {
      const v = Number(h.added)||0;
      // One huge batch would squash every small one into nothing, so keep a
      // readable floor. The printed value is the exact figure.
      const pct = Math.max(v > 0 ? 4 : 1, (v/ceiling)*100);
      const isLast = i === rows.length-1;
      return '<div class="col' + (isLast ? ' last' : '') + '">'
           +   '<span class="tip">'
           +     (byDay ? fmtDay(h.at) + ' &nbsp;<b>+' + v + '</b>'
                          + ' <span style="opacity:.6">(' + h.runs
                          + (h.runs === 1 ? ' update)' : ' updates)') + '</span>'
                        : fmtTime(h.at) + ' &nbsp;<b>+' + v + '</b>')
           +   '</span>'
           +   (labelled ? '<span class="val">+' + v + '</span>' : '')
           +   '<span class="bar" style="height:' + pct.toFixed(1) + '%;animation-delay:' + (i*26) + 'ms"></span>'
           + '</div>';
    }).join('');

    const axis = ticks.map(t =>
      '<span style="bottom:' + ((t/ceiling)*100).toFixed(2) + '%">' + t + '</span>').join('');
    const grid = ticks.map(t =>
      '<span class="gl' + (t === 0 ? ' zero' : '') + '" style="bottom:'
      + ((t/ceiling)*100).toFixed(2) + '%"></span>').join('');

    const spanOne = rows.length === 1;
    const edge = byDay ? fmtDay : fmtTime;
    host.innerHTML =
        '<div class="plot-row">'
      +   '<div class="yax">' + axis + '</div>'
      +   '<div class="plot">' + grid + '<div class="chart">' + cols + '</div></div>'
      + '</div>'
      + '<div class="chart-x"><span>' + edge(rows[0].at) + '</span>'
      + '<span>peak +' + max + (byDay ? ' in a day' : '') + '</span>'
      + '<span>' + (spanOne ? '' : edge(rows[rows.length-1].at)) + '</span></div>';
  }

  /* ---------- recent updates table ---------- */
  function renderHistory(history){
    const tb = el('hist');
    const sig = sigOf(history);
    if(sig === histSig){ refreshRelTimes(); return; }   // keeps scroll + hover intact
    histSig = sig;
    if(!history || !history.length){
      tb.innerHTML = '<tr><td colspan="3" class="empty">Waiting for the first update…</td></tr>';
      el('histNote').textContent = 'times in IST';
      return;
    }
    const newTop = history[0].at;
    const isNew = knownTop !== null && newTop !== knownTop;
    tb.innerHTML = history.map((h,i) =>
      '<tr' + (isNew && i === 0 ? ' class="fresh"' : '') + '>'
      + '<td class="when" data-at="' + h.at + '"><span class="abs">' + fmtTime(h.at) + '</span>'
      +   '<span class="rel">' + relTime(h.at) + '</span></td>'
      + '<td class="add"><span class="pill">+' + h.added + '</span></td>'
      + '<td class="tot">' + h.total.toLocaleString() + '</td>'
      + '</tr>'
    ).join('');
    knownTop = newTop;
    el('histNote').textContent = history.length + ' entries · times in IST';
  }

  // nudge only the relative labels so a static table still ages correctly
  function refreshRelTimes(){
    document.querySelectorAll('td.when').forEach(td => {
      const rel = td.querySelector('.rel');
      if(rel) rel.textContent = relTime(td.dataset.at);
    });
  }

  /* ---------- polling ---------- */
  async function poll(){
    try{
      const r = await fetch('/state',{cache:'no-store'});
      if(!r.ok) throw new Error('bad status');
      const s = await r.json();

      paintStats(s);
      lastHistory = s.history || [];
      renderChart(lastHistory);
      renderHistory(s.history);

      if(firstLoad){
        firstLoad = false;
        const total = s.total || 0;
        // claim the total NOW. The intro animation starts 560ms later, and any
        // poll landing in that gap would otherwise see displayed:0 and flash the
        // whole running total as if it had just arrived.
        displayed = total;
        const delay = reduce ? 0 : 560;
        setTimeout(()=>{
          rollUp(total, sweep);          // the shine runs once, after the roll lands
          maybeCelebrateMilestone(total, {delay: 900});
        }, delay);
      } else if(s.total !== displayed){
        const added = s.total - displayed;
        if(added > 0){ showFlash(added); floatPlus(added); ripple(); }
        animateCount(displayed, s.total, {dur:1000});
        if(added > 0 && !reduce) setTimeout(sweep, 760);   // after the fold, once
        // If this update crosses into a new thousand, ALWAYS fire the big
        // celebration for it — even if another milestone already celebrated
        // this session, and even if the batch jumped past the exact thousand.
        const crossedThousand = added > 0 &&
          Math.floor(s.total / 1000) > Math.floor(displayed / 1000);
        if(crossedThousand){
          const milestone = Math.floor(s.total / 1000) * 1000;
          try{ sessionStorage.setItem('mtdMilestone', String(Math.floor(s.total/STEP)*STEP)); }catch(e){}
          setTimeout(()=>celebrateBig(milestone), reduce ? 0 : 700);
        } else {
          maybeCelebrateMilestone(s.total, {delay: 700});
        }
        displayed = s.total;
      }
    }catch(e){ /* keep trying on the next tick */ }
  }

  // Celebrations land on every 500. The thousands get the full fireworks show;
  // the halfway marks (500, 1500, 2500, …) get confetti and a banner.
  function isBigMilestone(m){
    return m >= 1000 && m % 1000 === 0;
  }
  // fire a celebration for the latest 500-milestone, at most once per browser session.
  function maybeCelebrateMilestone(total, opts){
    opts = opts || {};
    if(!total || total < STEP) return;
    const reached = Math.floor(total / STEP) * STEP;   // latest 500-step passed
    let seen = 0;
    try { seen = parseInt(sessionStorage.getItem('mtdMilestone') || '0', 10) || 0; } catch(e){}
    if(reached > seen){
      try { sessionStorage.setItem('mtdMilestone', String(reached)); } catch(e){}
      const fn = isBigMilestone(reached) ? celebrateBig : celebrate;
      setTimeout(()=>fn(reached), reduce ? 0 : (opts.delay || 700));
    }
  }

  /* ---------- milestone confetti + banner ---------- */
  function celebrate(milestone){
    const b = document.getElementById('milestone');
    b.textContent = '🎉 Crossed ' + milestone.toLocaleString() + ' submissions!';
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    setTimeout(()=>b.classList.remove('show'), 4200);
    if(reduce) return;
    dropConfetti(130);
  }

  // spawn a shower of confetti pieces (no banner)
  function dropConfetti(N){
    const colors = ['#226db4','#4a9ddd','#178a5a','#23b377','#e08a1e','#7b5cff'];
    const layer = document.getElementById('confetti');
    for(let i=0;i<N;i++){
      const p = document.createElement('span');
      p.className = 'confetti-piece';
      const size = 6 + Math.random()*8;
      p.style.left = (Math.random()*100) + '%';
      p.style.width = size + 'px';
      p.style.height = (size*0.5) + 'px';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = (Math.random()*0.35) + 's';
      p.style.animationDuration = (1.8 + Math.random()*1.4) + 's';
      p.style.setProperty('--drift', ((Math.random()*2-1)*160).toFixed(0) + 'px');
      p.style.setProperty('--spin', (360 + Math.random()*720).toFixed(0) + 'deg');
      layer.appendChild(p);
      setTimeout(()=>p.remove(), 3600);
    }
  }

  /* ---------- fireworks + confetti for thousands milestones ---------- */
  function celebrateBig(milestone){
    const b = document.getElementById('milestone');
    b.textContent = '🎉 Crossed ' + milestone.toLocaleString() + ' submissions!';
    b.classList.add('big');
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    // fade out first, then drop the .big style AFTER it's hidden so it never
    // flashes back to the base (blue) gradient mid-fade
    setTimeout(()=>{
      b.classList.remove('show');
      setTimeout(()=>b.classList.remove('big'), 450);
    }, 6000);

    if(reduce) return;

    dropConfetti(220);

    const bursts = 10;
    for(let i=0;i<bursts;i++){
      setTimeout(()=>fireworkBurst(), i * 300);
    }
    setTimeout(()=>{ fireworkBurst(); fireworkBurst(); }, 500);
    setTimeout(()=>{ fireworkBurst(); fireworkBurst(); }, 2200);

    for(let i=0;i<3;i++){
      setTimeout(()=>launchRocket(), 150 + i*520);
    }
  }

  // launch a rocket from the bottom that streaks up and bursts at its apex
  function launchRocket(cxVw, apexVh){
    const layer = document.getElementById('fireworks');
    if(!layer) return;
    const cx = cxVw != null ? cxVw : (20 + Math.random()*60);       // vw
    const apex = apexVh != null ? apexVh : (22 + Math.random()*20); // vh from top
    const color = FW_COLORS[Math.floor(Math.random()*FW_COLORS.length)];

    const rk = document.createElement('span');
    rk.className = 'fw-rocket';
    rk.style.left = cx + 'vw';
    rk.style.color = color;
    const riseY = -(window.innerHeight * (1 - apex/100));
    rk.style.setProperty('--rk-y', riseY.toFixed(0) + 'px');
    const dur = 780 + Math.random()*260;
    rk.style.setProperty('--rk-dur', dur.toFixed(0) + 'ms');
    layer.appendChild(rk);

    setTimeout(()=>{ rk.remove(); fireworkBurst(cx, apex); }, dur);
  }

  const FW_COLORS = ['#f5b301','#e0447a','#7b5cff','#23b377','#4a9ddd','#ff7a3d','#ffffff'];
  function fireworkBurst(x, y){
    const layer = document.getElementById('fireworks');
    if(!layer) return;
    const cx = x != null ? x : (10 + Math.random()*80);          // vw
    const cy = y != null ? y : (12 + Math.random()*48);          // vh
    const color = FW_COLORS[Math.floor(Math.random()*FW_COLORS.length)];

    const burst = document.createElement('div');
    burst.className = 'fw-burst';
    burst.style.left = cx + 'vw';
    burst.style.top  = cy + 'vh';

    const flash = document.createElement('span');
    flash.className = 'fw-flash';
    burst.appendChild(flash);

    const sparks = 26 + Math.floor(Math.random()*10);
    const radius = 90 + Math.random()*70;   // px
    for(let i=0;i<sparks;i++){
      const ang = (i / sparks) * Math.PI * 2 + Math.random()*0.2;
      const r = radius * (0.7 + Math.random()*0.3);
      const sp = document.createElement('span');
      sp.className = 'fw-spark';
      sp.style.color = Math.random() < 0.2 ? FW_COLORS[Math.floor(Math.random()*FW_COLORS.length)] : color;
      sp.style.background = 'currentColor';
      sp.style.setProperty('--fw-x', (Math.cos(ang)*r).toFixed(0) + 'px');
      sp.style.setProperty('--fw-y', (Math.sin(ang)*r).toFixed(0) + 'px');
      sp.style.setProperty('--fw-dur', (900 + Math.random()*500).toFixed(0) + 'ms');
      burst.appendChild(sp);
    }

    layer.appendChild(burst);
    setTimeout(()=>burst.remove(), 1800);
  }

  (function initChartToggle(){
    const seg = el('chartSeg');
    if(!seg) return;
    const paint = () => [...seg.children].forEach(b =>
      b.classList.toggle('on', b.dataset.mode === chartMode));
    paint();
    [...seg.children].forEach(b => b.addEventListener('click', () => {
      if(chartMode === b.dataset.mode) return;
      chartMode = b.dataset.mode;
      try{ localStorage.setItem('mtdChartMode', chartMode); }catch(e){}
      paint();
      chartSig = null;               // force a redraw in the new grouping
      renderChart(lastHistory);
    }));
  })();

  orchestrate();
  poll();
  setInterval(poll, 4000);   // the figure itself only changes hourly; this just keeps the page in step
  // re-sync immediately when the tab comes back to the foreground
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) poll(); });
  window.addEventListener('resize', fitShine);
</script>
</body>
</html>`;
