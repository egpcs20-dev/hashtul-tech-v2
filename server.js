// השתול.טק — שרת משחק בלי תלויות חיצוניות (Node 18+)
// Server-Sent Events לעדכונים בזמן אמת, POST לפעולות. כל הלוגיקה על השרת,
// כך שכל שחקן מקבל רק את השאלה שלו — אי אפשר "לרמות" ולראות מי השתול.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QS = require('./questions');
const CATS = { tech: QS.tech, it: QS.it, mix: [...QS.it, ...QS.tech] };

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_ROOMS = 500, MAX_PLAYERS = 12;

const rooms = new Map();
const rid = n => crypto.randomBytes(n).toString('hex');
const rnd = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BOTS = [['ביט', '🤖'], ['באגי', '🐞'], ['צ׳יפי', '💾'], ['רובו-רינה', '🦾'], ['פיקסל', '👾'], ['וויפי', '📶']];
const WORDS = ['גוגל', 'באג', 'וויפי', 'טיקטוק', 'פייתון', 'ריסטארט', 'מטען', 'וואטסאפ', 'אקסל', 'ענן', 'קפה', 'סיסמה'];
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f​-‏‪-‮]/g, '').trim().slice(0, n);

/* ---------------- rooms & players ---------------- */
function newCode() { let c; do { c = Array.from({ length: 4 }, () => rnd(LETTERS)).join(''); } while (rooms.has(c)); return c; }
function makeRoom() {
  const r = { code: newCode(), players: new Map(), order: [], host: null, used: new Set(), recent: [], busy: false, touched: Date.now(), dirty: false,
    g: { ph: 'lobby', R: 8, disc: 60, ai: false, cat: 'it', r: 0, sc: {}, d: {}, pl: [], k: 'lobby' + Date.now() } };
  rooms.set(r.code, r); return r;
}
function addPlayer(r, name, emo, bot) {
  const pid = rid(6);
  const p = { pid, token: rid(12), name, emo, bot: !!bot, conns: new Set(), seen: Date.now(), left: false, a: null, vt: null };
  r.players.set(pid, p); r.order.push(pid);
  if (!r.host && !bot) r.host = pid;
  return p;
}
const online = p => p && !p.left && (p.bot || p.conns.size > 0 || Date.now() - p.seen < 15000);
const active = r => r.order.map(id => r.players.get(id)).filter(p => p && !p.left);

/* ---------------- views (each player sees only what they should) ---------------- */
function view(r, pid) {
  const g = r.g, me = r.players.get(pid), inGame = g.pl.includes(pid), q = g.q || {};
  const v = {
    code: r.code, me: pid, host: r.host, aiAvailable: !!API_KEY, busy: r.busy,
    players: r.order.map(id => r.players.get(id)).filter(p => p && (!p.left || g.pl.includes(p.pid)))
      .map(p => ({ id: p.pid, n: p.name, e: p.emo, bot: p.bot, on: online(p), a: p.a != null, v: p.vt != null })),
    g: { ph: g.ph, k: g.k, R: g.R, disc: g.disc, ai: g.ai, cat: g.cat, r: g.r, np: g.np, sc: g.sc, d: g.d, pl: g.pl, t: g.t, left: g.end ? Math.max(0, g.end - Date.now()) : 0 }
  };
  if (g.ph === 'ans' && inGame) { v.g.q = { t: q.t, lo: q.lo, hi: q.hi, text: g.plants.includes(pid) ? q.p : q.m }; v.myA = me.a; }
  if (g.ph === 'ans' && !inGame) v.g.q = { t: q.t };
  if (['rev', 'vote', 'res'].includes(g.ph)) { v.g.q = { t: q.t, lo: q.lo, hi: q.hi, m: q.m }; v.g.ans = g.ans; }
  if (g.ph === 'vote') v.myV = me.vt;
  if (g.ph === 'res') { v.g.q.p = q.p; v.g.res = g.res; }
  return v;
}
function changed(r) {
  if (r.dirty) return; r.dirty = true;
  setImmediate(() => {
    r.dirty = false;
    for (const p of r.players.values()) {
      if (!p.conns.size) continue;
      const msg = 'data: ' + JSON.stringify(view(r, p.pid)) + '\n\n';
      for (const res of p.conns) { try { res.write(msg); } catch (e) {} }
    }
  });
}

/* ---------------- questions ---------------- */
function pickBank(r) {
  const BANK = CATS[r.g.cat] || CATS.it;
  let idx = BANK.filter(b => !r.used.has(b[1]));
  if (!idx.length) { r.used.clear(); idx = BANK; }
  const b = rnd(idx); r.used.add(b[1]);
  return { t: b[0], m: b[1], p: b[2], lo: b[3] ?? 1, hi: b[4] ?? 10 };
}
async function genAI(r) {
  if (!API_KEY) return null;
  const t = rnd(['n', 'n', 'r', 'w', 'w', 'p']);
  const rules = { n: 'התשובה היא מספר. תן גם lo ו-hi (טווח הגיוני לסליידר, lo<hi).', r: 'התשובה היא דירוג 1 עד 10. השאלה מתחילה ב״כמה״.', w: 'התשובה היא מילה אחת או ביטוי קצר.', p: 'שאלת ״מי בחדר הכי...״ — התשובה היא אחד מהשחקנים.' };
  const prompt = `אתה כותב שאלות בעברית למשחק המסיבות "השתול": כל השחקנים מקבלים שאלה m, ושחקן אחד (השתול) מקבל שאלה p דומה במבנה אבל שונה בתוכן. אחרי שכולם עונים, חושפים את m ואת כל התשובות, והחברים מנחשים מי ענה על שאלה אחרת.
נושא: ${r.g.cat === 'tech' ? 'מחשבים, טכנולוגיה, אינטרנט, גיימינג, AI, גאדג׳טים ותרבות הייטק' : 'החיים בצוות מחשוב / תמיכה טכנית בארגון: סוגי טכנאים (מי לא סוגר קריאות, מי עושה תקלות, מי נעלם כשיש תקלה דחופה), קריאות, משתמשים, מדפסות, סיסמאות, שרתים ותורנויות'}. קהל: צוות אנשי מחשוב שמכירים זה את זה, הומור קליל ועוקצני-חברי, בלי העלבות אמיתיות ובלי גסויות.
סוג השאלה: ${rules[t]}
זוג טוב: התשובה ל-p יכולה להיראות סבירה גם כתשובה ל-m, אבל לרוב תהיה קצת שונה, כך שהשתול יכול לבלף. p לא חייבת להיות על טכנולוגיה. עד 70 תווים לשאלה.
אל תחזור על: ${r.recent.slice(-8).join(' | ') || '—'}
החזר JSON בלבד: {"m":"...","p":"...","lo":0,"hi":100}`;
  try {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 15000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    clearTimeout(to);
    if (!res.ok) { console.error('AI error', res.status, (await res.text()).slice(0, 200)); return null; }
    const j = await res.json();
    const text = (j.content || []).map(c => c.text || '').join('');
    const o = JSON.parse((text.match(/\{[\s\S]*\}/) || ['null'])[0]);
    if (!o || typeof o.m !== 'string' || typeof o.p !== 'string') return null;
    const q = { t, m: clean(o.m, 120), p: clean(o.p, 120), lo: 1, hi: 10 };
    if (t === 'n') { const lo = Math.round(+o.lo), hi = Math.round(+o.hi); if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null; q.lo = lo; q.hi = hi; }
    return q;
  } catch (e) { console.error('AI failed', e.message); return null; }
}

/* ---------------- game flow ---------------- */
function phase(r, ph, secs) { const g = r.g; g.ph = ph; g.t = secs || 0; g.end = secs ? Date.now() + secs * 1000 : 0; g.k = g.r + ph + Date.now(); changed(r); }
function startGame(r) {
  const ps = active(r).filter(online);
  if (ps.length < 3) return 'צריך לפחות 3 שחקנים מחוברים';
  const g = r.g; g.pl = ps.map(p => p.pid); g.sc = {}; g.d = {}; g.r = 0;
  g.pl.forEach(id => g.sc[id] = 0);
  nextRound(r);
}
async function nextRound(r) {
  if (r.busy) return; const g = r.g;
  if (g.r + 1 > g.R) { g.d = {}; phase(r, 'end'); return; }
  r.busy = true; changed(r);
  let q = g.ai ? await genAI(r) : null;
  if (!q) q = pickBank(r);
  r.recent.push(q.m); r.busy = false;
  g.r++; g.q = q; g.ans = null; g.res = null; g.d = {};
  const n = g.pl.length; g.np = n <= 6 ? 1 : n <= 9 ? 2 : 3;
  g.plants = shuffle(g.pl).slice(0, g.np);
  for (const p of r.players.values()) { p.a = null; p.vt = null; }
  phase(r, 'ans', q.t === 'w' ? 80 : 60);
}
const live = r => r.g.pl.filter(id => online(r.players.get(id)));
function toReveal(r) {
  const g = r.g; g.ans = {};
  for (const id of g.pl) { const p = r.players.get(id); if (p && p.a != null) g.ans[id] = p.a; }
  phase(r, 'rev', g.disc);
}
function toVote(r) { phase(r, 'vote', 50); }
function toResults(r) {
  const g = r.g, plants = g.plants, tally = {}, d = {}, votes = {};
  g.pl.forEach(id => { tally[id] = 0; d[id] = 0; });
  for (const id of g.pl) { const p = r.players.get(id); if (p && p.vt) { votes[id] = p.vt; p.vt.forEach(t => tally[t]++); } }
  const need = Math.max(1, Math.ceil((g.pl.length - 1) / 2)), caught = [];
  for (const [v, t] of Object.entries(votes)) for (const s of t) if (plants.includes(s)) d[v] += 100;
  for (const pl of plants) {
    const fooled = g.pl.filter(id => !plants.includes(id) && !(votes[id] || []).includes(pl)).length;
    d[pl] += fooled * 50;
    if (tally[pl] >= need) caught.push(pl); else d[pl] += 150;
  }
  g.pl.forEach(id => g.sc[id] = (g.sc[id] || 0) + d[id]);
  g.d = d; g.res = { p: plants, c: caught, t: tally };
  phase(r, 'res');
}
function backToLobby(r) {
  const g = r.g;
  r.g = { ph: 'lobby', R: g.R, disc: g.disc, ai: g.ai, cat: g.cat, r: 0, sc: {}, d: {}, pl: [], k: 'lobby' + Date.now() };
  for (const [id, p] of r.players) { p.a = null; p.vt = null; if (p.left) { r.players.delete(id); r.order = r.order.filter(x => x !== id); } }
  changed(r);
}
function botAct(r) {
  const g = r.g;
  for (const id of g.pl) {
    const b = r.players.get(id); if (!b || !b.bot) continue;
    if (g.ph === 'ans' && b.a == null && Math.random() < .15) {
      const q = g.q;
      if (q.t === 'n') b.a = Math.round(q.lo + (q.hi - q.lo) * (.1 + Math.random() * (g.plants.includes(id) ? .8 : .5)));
      else if (q.t === 'r') b.a = 1 + (Math.random() * 10 | 0);
      else if (q.t === 'p') b.a = rnd(g.pl);
      else b.a = rnd(WORDS);
      changed(r);
    }
    if (g.ph === 'vote' && b.vt == null && Math.random() < .15) { b.vt = shuffle(g.pl.filter(x => x !== id)).slice(0, g.np); changed(r); }
  }
}
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    const humans = active(r).filter(p => !p.bot);
    if (humans.some(online)) r.touched = now;
    else if (now - r.touched > 30 * 60e3) { rooms.delete(r.code); continue; }
    const h = r.players.get(r.host);
    if (!online(h)) { const c = humans.find(online); if (c) { r.host = c.pid; changed(r); } }
    if (r.busy) continue;
    const g = r.g;
    botAct(r);
    if (g.ph === 'ans') { const L = live(r); if ((L.length && L.every(id => r.players.get(id).a != null)) || now > g.end) toReveal(r); }
    else if (g.ph === 'rev') { if (now > g.end) toVote(r); }
    else if (g.ph === 'vote') { const L = live(r); if ((L.length && L.every(id => r.players.get(id).vt != null)) || now > g.end) toResults(r); }
  }
}, 500);

/* ---------------- actions ---------------- */
function act(r, p, b) {
  const g = r.g, isHost = r.host === p.pid, inGame = g.pl.includes(p.pid);
  switch (b.type) {
    case 'settings':
      if (!isHost || g.ph !== 'lobby') return 'רק המארח';
      if ([5, 8, 12].includes(b.R)) g.R = b.R;
      if ([45, 60, 90, 120].includes(b.disc)) g.disc = b.disc;
      if (typeof b.ai === 'boolean') g.ai = b.ai && !!API_KEY;
      if (['tech', 'it', 'mix'].includes(b.cat)) g.cat = b.cat;
      break;
    case 'addbot': {
      if (!isHost || g.ph !== 'lobby') return 'רק המארח';
      if (active(r).length >= MAX_PLAYERS) return 'החדר מלא';
      const used = new Set(active(r).map(x => x.name)); const bt = BOTS.find(x => !used.has(x[0])); if (!bt) return 'אין עוד בוטים';
      addPlayer(r, bt[0], bt[1], true); break;
    }
    case 'rmbot': {
      if (!isHost || g.ph !== 'lobby') return 'רק המארח';
      const bt = [...active(r)].reverse().find(x => x.bot); if (bt) { r.players.delete(bt.pid); r.order = r.order.filter(x => x !== bt.pid); }
      break;
    }
    case 'start': if (!isHost || g.ph !== 'lobby') return 'רק המארח'; { const e = startGame(r); if (e) return e; } break;
    case 'answer': {
      if (g.ph !== 'ans' || !inGame) return 'לא עכשיו';
      const q = g.q; let v = b.v;
      if (q.t === 'n') { v = Math.round(+v); if (!isFinite(v)) return 'מספר לא תקין'; v = Math.min(q.hi, Math.max(q.lo, v)); }
      else if (q.t === 'r') { v = Math.round(+v); if (!(v >= 1 && v <= 10)) return 'דירוג 1–10'; }
      else if (q.t === 'p') { if (!g.pl.includes(v)) return 'בחר שחקן'; }
      else { v = clean(v, 24); if (!v) return 'כתוב משהו'; }
      p.a = v; break;
    }
    case 'unanswer': if (g.ph === 'ans') p.a = null; break;
    case 'tovote': if (!isHost || g.ph !== 'rev') return 'רק המארח'; toVote(r); break;
    case 'vote': {
      if (g.ph !== 'vote' || !inGame) return 'לא עכשיו';
      const n = Math.min(g.np, g.pl.length - 1);
      const t = [...new Set((Array.isArray(b.t) ? b.t : []).filter(x => g.pl.includes(x) && x !== p.pid))].slice(0, n);
      if (t.length !== n) return `בחר ${n}`;
      p.vt = t; break;
    }
    case 'next': if (!isHost || g.ph !== 'res') return 'רק המארח'; nextRound(r); break;
    case 'again': if (!isHost || g.ph !== 'end') return 'רק המארח'; backToLobby(r); break;
    case 'leave':
      p.left = true; for (const c of p.conns) { try { c.end(); } catch (e) {} } p.conns.clear();
      if (g.ph === 'lobby') { r.players.delete(p.pid); r.order = r.order.filter(x => x !== p.pid); }
      if (r.host === p.pid) { const c = active(r).find(x => !x.bot && online(x)); r.host = c ? c.pid : null; }
      break;
    default: return 'פעולה לא מוכרת';
  }
  changed(r);
}

/* ---------------- http ---------------- */
const INDEX = path.join(__dirname, 'public', 'index.html');
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, bad) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 10000) { bad(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
  });
}
function auth(b) {
  const r = rooms.get(String(b.code || '').toUpperCase()); if (!r) return {};
  const p = r.players.get(String(b.pid || ''));
  if (!p || p.left || !b.token || p.token.length !== String(b.token).length || !crypto.timingSafeEqual(Buffer.from(p.token), Buffer.from(String(b.token)))) return { r };
  return { r, p };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await body(req);
      const name = clean(b.name, 16), emo = clean(b.emo, 8) || '🙂';
      if (!name) return json(res, 400, { error: 'איך קוראים לך?' });
      if (b.code) {
        const { r, p } = auth(b);
        if (!r) return json(res, 404, { error: 'אין חדר עם הקוד הזה' });
        if (p) { p.name = name; p.emo = emo; changed(r); return json(res, 200, { code: r.code, pid: p.pid, token: p.token }); }
        if (active(r).length >= MAX_PLAYERS) return json(res, 403, { error: 'החדר מלא (12 שחקנים)' });
        const np = addPlayer(r, name, emo); changed(r);
        return json(res, 200, { code: r.code, pid: np.pid, token: np.token });
      }
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'השרת עמוס, נסו בעוד כמה דקות' });
      const r = makeRoom(), p = addPlayer(r, name, emo);
      const nb = Math.min(5, Math.max(0, +b.bots || 0));
      for (const bt of shuffle(BOTS).slice(0, nb)) addPlayer(r, bt[0], bt[1], true);
      return json(res, 200, { code: r.code, pid: p.pid, token: p.token });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const { r, p } = auth({ code: url.searchParams.get('code'), pid: url.searchParams.get('pid'), token: url.searchParams.get('token') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (!p) { res.end('event: gone\ndata: {}\n\n'); return; }
      res.write('retry: 2000\n\n');
      p.conns.add(res); p.seen = Date.now();
      res.write('data: ' + JSON.stringify(view(r, p.pid)) + '\n\n');
      changed(r);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(hb); p.conns.delete(res); p.seen = Date.now(); changed(r); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/act') {
      const b = await body(req);
      const { r, p } = auth(b);
      if (!r) return json(res, 404, { error: 'החדר נסגר' });
      if (!p) return json(res, 403, { error: 'לא מחובר לחדר' });
      p.seen = Date.now();
      const err = act(r, p, b);
      return err ? json(res, 400, { error: err }) : json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 400, { error: 'בקשה לא תקינה' }); }
}).listen(PORT, () => console.log(`השתול.טק on :${PORT}${API_KEY ? ' (AI questions on)' : ''}`));
