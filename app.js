import * as C from './core.mjs';

// ---------- settings & local state ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('tasks.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tasks.' + k, JSON.stringify(v)); } catch {} },
};
const DEFAULTS = { token: '', repo: '', branch: 'main', path: 'Tasks.md' };
let cfg = { ...DEFAULTS, ...LS.get('cfg', {}) };
// Demo mode: without a token the app shows demo.md, an example file shipped with the app.
// Demo edits live under their own keys, so they never reach a real repository.
const DEMO = !cfg.token;
const K = k => (DEMO ? 'demo.' : '') + k;
const st = {
  text: LS.get(K('text'), ''),
  sha: LS.get(K('sha'), null),
  etag: LS.get(K('etag'), null), // ETag of the GET that produced text + sha
  pending: LS.get(K('pending'), []),
  // Today, Next 7 days and All became one Agenda view on 2026-10-10 (story V1): old values open Agenda.
  view: (v => ['today', 'next', 'all'].includes(v) ? 'agenda' : v)(LS.get('view', 'agenda')),
  range: { id: '3d' }, // Agenda range; back to 3 days when you leave the view
  anchor: null, // first day tapped in the day strip, waiting for the last day of a range
  status: 'ok',
  syncing: false,
};
// Per-device view preferences: view mode per list, folded sections, notes preview lines (0-3, every view; an old true means 2 lines, the old fixed count).
// View options (story L8): showDone and sortBy per list; chips (tags, dates, repeat) and density for every list.
// navFold: the list types whose sidebar group the user toggled away from its default (Stock starts folded).
// groupBy: the grouping of a list view per list (story V32): section (default), tag, priority, date or none. showEmpty: lists that show their empty sections.
const prefs = { groupBy: LS.get('groupBy', {}), showEmpty: LS.get('showEmpty', {}), listView: LS.get('listView', {}), folded: LS.get('folded', []), preview: (v => typeof v === 'number' ? v : (typeof v === 'boolean' ? v : Object.values(v || {}).some(Boolean)) ? 2 : 0)(LS.get('preview', 0)),
  showDone: LS.get('showDone', {}), sortBy: LS.get('sortBy', {}), chips: { tags: true, dates: true, repeat: true, ...LS.get('chips', {}) }, density: LS.get('density', 1), shop: LS.get('shop', {}), navFold: LS.get('navFold', []) };
const savePrefs = () => { LS.set('groupBy', prefs.groupBy); LS.set('showEmpty', prefs.showEmpty); LS.set('listView', prefs.listView); LS.set('folded', prefs.folded); LS.set('preview', prefs.preview); LS.set('showDone', prefs.showDone); LS.set('sortBy', prefs.sortBy); LS.set('chips', prefs.chips); LS.set('density', prefs.density); LS.set('shop', prefs.shop); LS.set('navFold', prefs.navFold); };
const boardTab = {}; // list → group key shown on the phone board
const freshSecs = new Set(); // sections added in this session: they stay shown while empty, until a reload
const phone = () => matchMedia('(max-width: 760px)').matches;
const docked = () => matchMedia('(min-width: 1100px)').matches;
matchMedia('(max-width: 760px)').addEventListener('change', () => render());
const persist = () => { LS.set(K('text'), st.text); LS.set(K('sha'), st.sha); LS.set(K('etag'), st.etag); LS.set(K('pending'), st.pending); };

const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = () => C.todayIn();

// The visible doc = last known file + queued ops.
function currentDoc() {
  window.__docBuilds = (window.__docBuilds || 0) + 1; // the e2e speed guard counts the builds of one render
  const doc = C.parse(st.text);
  for (const op of st.pending) { try { C.apply(doc, op, op.today); } catch {} }
  return doc;
}

// ---------- GitHub sync ----------
// ?api=http://localhost:8787 points the app at the local dev server (dev.mjs).
const API = new URLSearchParams(location.search).get('api') || 'https://api.github.com';
const api = p => `${API}/repos/${cfg.repo}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}${p || ''}`;
const headers = () => ({ Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
const b64decode = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0)));
function b64encode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Conditional GET: with If-None-Match, an unchanged file answers 304, which GitHub does not count
// against the rate limit. That makes a 10-second poll free.
async function getRemote() {
  const h = headers();
  if (st.etag && st.sha) h['If-None-Match'] = st.etag;
  const r = await fetch(api(`?ref=${encodeURIComponent(cfg.branch)}`), { headers: h, cache: 'no-store' });
  if (r.status === 304) return { text: st.text, sha: st.sha, etag: st.etag, unchanged: true };
  // On a private repo, GitHub also answers 404 when the token has no access to it.
  if (r.status === 404) throw new HttpError(404, 'Not found. Give the token access to this repository, and check the file path.');
  if (!r.ok) throw new HttpError(r.status, (await r.json().catch(() => ({}))).message || r.statusText);
  const j = await r.json();
  return { text: b64decode(j.content), sha: j.sha, etag: r.headers.get('ETag') };
}
async function putRemote(text, sha, message) {
  const r = await fetch(api(), {
    method: 'PUT', headers: headers(),
    body: JSON.stringify({ message, content: b64encode(text), branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) throw new HttpError(r.status, (await r.json().catch(() => ({}))).message || r.statusText);
  return (await r.json()).content.sha;
}

let syncTimer = null;
function scheduleSync(ms = 700) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }

async function sync() {
  if (DEMO) { foldDemo(); setStatus('off'); return; }
  if (st.syncing) { scheduleSync(800); return; }
  st.syncing = true;
  const before = st.text, hadOps = st.pending.length > 0;
  setStatus(st.pending.length ? 'pending' : st.status);
  try {
    for (let attempt = 0; ; attempt++) {
      const remote = await getRemote();
      const ops = st.pending.slice();
      if (!ops.length) { st.text = remote.text; st.sha = remote.sha; st.etag = remote.etag; break; }
      const doc = C.parse(remote.text);
      for (const op of ops) C.apply(doc, op, op.today);
      const next = C.serialize(doc);
      try {
        let sha = remote.sha;
        if (next !== remote.text) {
          const msg = 'Tâches : ' + ops.map(op => C.describeOp(op, doc)).join(', ');
          sha = await putRemote(next, remote.sha, msg.length > 72 ? msg.slice(0, 70) + '…' : msg);
        }
        // Our own PUT made a new version: its ETag is unknown until the next 200.
        st.text = next; st.sha = sha; st.etag = sha === remote.sha ? remote.etag : null;
        st.pending = st.pending.slice(ops.length);
        if (!st.pending.length) break;
      } catch (e) {
        // 409/422: the file moved under us. Fetch again and replay.
        if ((e.status === 409 || e.status === 422) && attempt < 4) continue;
        throw e;
      }
    }
    persist();
    setStatus('ok');
  } catch (e) {
    console.error(e);
    setStatus('error', e.status === 401 ? 'Token refused (401). Check settings.' : e.message);
    if (e.status === 401 || e.status === 404) openSettings();
  } finally {
    st.syncing = false;
    if (st.text !== before || hadOps) render(); // a 304 poll leaves the screen alone
  }
}

function setStatus(s, msg = '') {
  st.status = s;
  const b = $('#syncBtn');
  b.className = 'icon-btn sync ' + s;
  b.title = { ok: 'Synced', pending: 'Saving…', error: 'Sync error: ' + msg, off: 'Demo: not connected' }[s] || '';
  if (msg) $('#sStatus').textContent = msg;
}

function commit(op) {
  op.today = today();
  st.pending.push(op);
  persist();
  render();
  setStatus('pending');
  scheduleSync();
}

// ---------- demo ----------
// demo.md is written for DEMO_DAY. Loading shifts every date by the days since, then puts each
// repeating task back on its rule (mon,thu, 1mon…), so the demo always looks like today.
// It loads again each new day; the Reset button loads it at once.
const DEMO_DAY = '2026-10-10';
const WEEKDAY_RULE = /^(weekday|1wd|-?[1-4](sun|mon|tue|wed|thu|fri|sat)|(sun|mon|tue|wed|thu|fri|sat)(,(sun|mon|tue|wed|thu|fri|sat))*)$/;
async function loadDemo(force = false) {
  const td = today();
  const r = await fetch('demo.md', { cache: 'no-store' });
  if (!r.ok) return;
  const src = await r.clone().text(); // a new demo.md loads at once, so a new feature shows without Reset
  if (!force && st.text && LS.get('demo.day', null) === td && LS.get('demo.src', '') === src) return;
  LS.set('demo.src', src);
  const shift = Math.round((C.fromYmd(td) - C.fromYmd(DEMO_DAY)) / 864e5);
  const doc = C.parse((await r.text()).replace(/\b(due|done|by):(\d{4}-\d{2}-\d{2})(?![\d-])/g, (_, k, d) => `${k}:${C.addDays(d, shift)}`)
    .replace(/^ +✓ .*$/gm, l => l.replace(/\d{4}-\d{2}-\d{2}/g, d => C.addDays(d, shift)))); // habit logs move too
  for (const { task: t } of C.allTasks(doc)) {
    if (t.every && t.due && WEEKDAY_RULE.test(t.every)) { const d = C.nextOccurrence(t.every, C.addDays(t.due, -1)); if (d !== t.due) C.apply(doc, { type: 'update', id: t.id, patch: { due: d, ...(t.by ? { by: C.moveBy('day', t.due, d, t.by) } : {}) } }, td); }
  }
  st.text = C.serialize(doc); st.pending = [];
  LS.set('demo.day', td);
  persist();
}
// In the demo the queued ops fold into the local text: there is no repository to write.
function foldDemo() {
  if (!st.pending.length) return;
  st.text = C.serialize(currentDoc()); st.pending = [];
  persist();
}

// ---------- views ----------
// Named colors for the color: marker of a list heading in Tasks.md (## Work color:#0f9d9a/teal).
const COLOR_NAMES = {
  blue: '#3e8ef7', pink: '#db2777', amber: '#e2900b', green: '#22a35a', teal: '#0f9d9a', purple: '#a855f7',
  indigo: '#4f5bd5', orange: '#ea580c', lime: '#65a30d', sky: '#0ea5e9', ochre: '#a16207', slate: '#64748b',
};
// Lists without a color: marker take the free colors, in file order.
const PALETTE = ['#4f5bd5', '#ea580c', '#65a30d', '#0ea5e9', '#a16207', '#64748b'];
// The hex code wins; the name is the fallback; a CSS color name also works.
function markerColor(spec) {
  if (!spec) return null;
  const [a, b] = spec.split('/');
  for (const p of [a, b]) if (p && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(p)) return p;
  for (const p of [a, b]) {
    if (!p) continue;
    const n = COLOR_NAMES[p.toLowerCase()];
    if (n) return n;
    if (window.CSS?.supports?.('color', p)) return p;
  }
  return null;
}
function listColor(name) {
  const marks = window.__listColors || {};
  const own = marks[name.toLowerCase()];
  if (own) return own;
  if (name.toLowerCase() === 'inbox') return COLOR_NAMES.blue;
  const others = (window.__lists || []).filter(l => !marks[l.toLowerCase()] && l.toLowerCase() !== 'inbox');
  const i = others.indexOf(name);
  return PALETTE[(i < 0 ? others.length : i) % PALETTE.length];
}
// SF Symbols-like line icons for the phone tab bar.
const ICON = {
  // The Agenda icon is a calendar page with today's day number (agendaIcon).
  habits: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.2 2.7 2.7 5-5.4"/>', // the habit ring, checked
  matrix: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 3.5v17M3.5 12h17"/>', // one square cut in four, unlike the Lists tiles
  stickies: '<path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19"/>', // a note with a folded corner (story L9)
  lists: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const agendaIcon = (n = 24) => `<svg viewBox="0 0 24 24" width="${n}" height="${n}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><text x="12" y="18" text-anchor="middle" fill="currentColor" stroke="none" font-size="7.5" font-weight="700" font-family="-apple-system,system-ui,sans-serif">${+today().slice(8)}</text></svg>`;
const VIEWS = [
  { id: 'agenda', label: 'Agenda' },
  { id: 'habits', label: 'Habits', ico: '◯' }, // story B10: every habits list in one view
  { id: 'stickies', label: 'Stickies' }, // story L9: every stickies list in one view; on the phone, a tile of the Lists page
  { id: 'matrix', label: 'Matrix', ico: '⊞' },
];
// Agenda ranges (story V2): rolling spans from today, plus a custom range picked in the day strip.
const RANGES = [
  { id: 'today', label: 'Today', title: 'Today', days: 0 },
  { id: '3d', label: '3 days', title: 'Next 3 days', days: 2 },
  { id: 'week', label: 'Week', title: 'Next 7 days', days: 6 },
  { id: 'month', label: 'Month', title: 'Next 30 days', days: 29 },
  { id: 'all', label: 'All', title: 'All' },
];
const WIDER = { today: '3d', '3d': 'week', week: 'month', month: 'all' };
const STRIP_DAYS = 14;
function rangeSpan(r, td) {
  if (r.id === 'custom') return [r.from, r.to];
  const x = RANGES.find(y => y.id === r.id);
  return [td, x.days === undefined ? null : C.addDays(td, x.days)];
}
const shortDate = d => C.fromYmd(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const MODES = [
  { id: 'list', label: 'List', svg: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>' },
  { id: 'board', label: 'Board', svg: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>' },
  { id: 'lanes', label: 'Lanes', svg: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 15h18M9 4v16"/>' },
  { id: 'matrix', label: 'Matrix', svg: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>' },
];
const icon = (body, n = 18) => `<svg viewBox="0 0 24 24" width="${n}" height="${n}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const listMode = l => prefs.listView[l] || 'list';

function dayLabel(d, long = false) {
  const t = today();
  if (d === t) return 'Today';
  if (d === C.addDays(t, 1)) return 'Tomorrow';
  if (d === C.addDays(t, -1)) return 'Yesterday';
  const dt = C.fromYmd(d);
  if (d > t && d <= C.addDays(t, 6)) return dt.toLocaleDateString('en-GB', { weekday: long ? 'long' : 'short', timeZone: 'UTC' });
  const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (long) opts.weekday = 'short';
  if (d.slice(0, 4) !== t.slice(0, 4)) opts.year = 'numeric';
  return dt.toLocaleDateString('en-GB', opts);
}

function checklistCount(t) {
  let n = 0, done = 0;
  for (const l of t.notes) { const m = l.match(/^\s*- \[([ xX])\]/); if (m) { n++; if (m[1] !== ' ') done++; } }
  return n ? `${done}/${n}` : '';
}

// The first lines of the notes, when the preview is on (story V23); View options sets 1 to 3 lines.
// The « — 8 km · J-16 · … » footer of a training run counts too: it comes last, so the clamp hides it under a longer note,
// and it is the only note of an easy run. Skipping it left those tiles with a mark and an empty preview (2026-10-15).
function notesPreview(t) {
  const lines = t.notes.map(n => n.trim()).filter(n => n && !/^- \[[ xX]\]/.test(n) && !C.HABIT_LOG_RE.test(n));
  return lines.slice(0, prefs.preview).join(' ');
}
// hideTag: the tag of the group the row sits in (story V32). ghost: a second copy of a task with several tags, faded.
function taskHTML({ task: t, list }, { showList = true, showDate = true, drag = false, hideTag = null, ghost = false } = {}) {
  const td = today();
  const chips = [];
  if (t.prio && !t.checked) chips.push(`<span class="chip prio p${t.prio}" title="${['', 'High', 'Medium', 'Low'][t.prio]} priority">${'!'.repeat(4 - t.prio)}</span>`);
  const ch = prefs.chips;
  const stk = (window.__stickies || []).includes(list), dl = stk ? C.byDate(t) : t.due; // a sticky dates from its deadline (by:)
  if (stk && dl && t.lead) {
    // A sticky with a lead (story L11): « Act by » its act-by date in the accent (red within 7 days), then the grey deadline − lead.
    const ab = C.actBy(t), n = Math.round((C.fromYmd(ab) - C.fromYmd(td)) / 864e5);
    if (ch.dates) chips.push(`<span class="chip act${!t.checked && n <= 7 ? ' late' : ''}">Act by ${esc(dayLabel(ab))}${!t.checked && n >= 0 ? ' · J-' + n : ''}</span><span class="chip mono">${esc(C.fromYmd(dl).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))} − ${t.lead} d</span>`);
  } else if (dl && showDate && ch.dates) {
    const cls = !t.checked && dl < td && !t.by ? 'late' : dl === td ? 'today' : '';
    chips.push(`<span class="chip ${cls}">${esc(dayLabel(dl))}${t.at ? ' · ' + t.at : ''}</span>`);
  } else if (t.at && ch.dates) chips.push(`<span class="chip mono">⏰ ${t.at}</span>`);
  if (t.every && ch.repeat) chips.push(`<span class="chip">↻ ${esc(C.describeEvery(t.every))}</span>`);
  // A sticky (story L9) counts down to its deadline (J-x, red within 7 days) and says firm or best effort.
  if (stk && dl && !t.checked) {
    const n = Math.round((C.fromYmd(dl) - C.fromYmd(td)) / 864e5);
    if (showDate && n >= 0 && !t.lead) chips.push(`<span class="chip mono${n <= 7 ? ' late' : ''}">J-${n}</span>`);
    chips.push(t.firm ? `<span class="chip firm">Firm</span>` : `<span class="chip soft">Best effort</span>`);
  }
  const cl = checklistCount(t);
  if (cl) chips.push(`<span class="chip mono">☑ ${cl}</span>`);
  else if (t.notes.some(n => n.trim() && !C.HABIT_LOG_RE.test(n))) chips.push(`<span class="chip">✎</span>`);
  if (showList) chips.push(`<span class="chip lchip"><span class="swatch" style="background:${listColor(list)}"></span>${esc(list)}</span>`);
  if (ch.tags) for (const tag of t.tags) if (tag !== hideTag) chips.push(`<span class="chip tag">#${esc(tag)}</span>`);
  if (t.checked && t.done) chips.push(`<span class="chip">✓ ${esc(dayLabel(t.done))}</span>`);
  // A window task (story L15): « window too short » in amber when start + estimate passes act by.
  const ph = !stk && (t.by || C.fixedStart(t, listTypeByName(list))) && !t.checked ? C.phase(t) : null; // L24: a fixed start fades before it opens
  if (ph && ph !== 'missed' && C.tooShort(t)) chips.push(`<span class="chip warn">Window too short · ${C.estLabel(t.est)}</span>`);
  if (!stk && t.by && t.firm && !t.checked) chips.push(`<span class="chip firm">Firm</span>`); // a task deadline can be firm too
  const bar = !stk && t.by ? winBar(t, ph) : '';
  const prev = prefs.preview && !t.checked ? notesPreview(t) : '';
  const sel = editing && editing.id === t.id ? ' sel' : '';
  const cart = opts_cart(t, list);
  return `<div class="task${t.checked ? ' done' : ''}${cart ? ' cart' : ''}${ghost ? ' ghost' : ''}${ph ? ' win-' + ph : ''}${sel}" data-id="${t.id}" style="--lc:${listColor(list)}"${drag ? ' draggable="true"' : ''}>
    <button class="check${stk ? ' stk' : ''}${t.checked || cart ? ' on' : ''}${t.doing && !cart ? ' doing' : ''}${t.prio ? ' p' + t.prio : ''}" data-act="check" aria-label="Complete"></button>
    <div class="body"><div class="ttl"><span class="tt">${esc(t.title) || '<span style="color:var(--ink3)">Untitled</span>'}</span></div>${bar}<div class="meta">${chips.join('')}</div>${prev ? `<div class="npreview" style="-webkit-line-clamp:${prefs.preview}">${esc(prev)}</div>` : ''}</div>
  </div>`;
}
// The window bar (story L15, round 1 variant B): the window in the accent from the start to act by, the margin hatched
// red up to the deadline, a mark at now. With no start, the window starts at now. Labels: start, act by, deadline.
function winBar(t, ph) {
  const now = Date.now(), dl = C.deadlineEpoch(t), act = C.actByEpoch(t), st = C.startEpoch(t) ?? Math.min(now, act);
  const pad = Math.max(30 * 60e3, (dl - st) * 0.08), a = st - pad, b = dl + pad, w = x => Math.max(0, Math.min(100, (x - a) / (b - a) * 100));
  // A day deadline ends at midnight: show its day, not « 00:00 » of the next day. The same for a start with no hour.
  const lab = x => {
    if (x === dl && !C.byTime(t)) return dayLabel(C.byDate(t));
    if (x === act && !C.byTime(t) && !t.leadH) return dayLabel(C.actBy(t));
    const d = C.todayIn(C.TZ, x), h = C.nowTimeIn(C.TZ, x);
    if (x === st && t.due && !t.at) return dayLabel(d);
    return (d === today() ? '' : dayLabel(d) + ' ') + h;
  };
  const nowMark = now >= a && now <= b && !t.checked ? `<span class="wb-now" style="left:${w(now).toFixed(1)}%"></span>` : '';
  const title = `Window ${lab(st)} → act by ${lab(act)}, deadline ${lab(dl)}`;
  return `<div class="wbar${ph === 'missed' ? ' missed' : ''}" title="${esc(title)}" aria-label="${esc(title)}"><span class="wb-w" style="left:${w(st).toFixed(1)}%;width:${Math.max(0, w(act) - w(st)).toFixed(1)}%"></span><span class="wb-m" style="left:${w(act).toFixed(1)}%;width:${Math.max(0, w(dl) - w(act)).toFixed(1)}%"></span>${nowMark}</div><div class="wlab"><span>${esc(lab(st))}</span><span>act by ${esc(lab(act))}</span><span>${esc(lab(dl).trim())}</span></div>`;
}
// In a stock list, an item in progress ([/]) is in the shopping cart: it shows struck, not half-filled.
const opts_cart = (t, list) => !t.checked && t.doing && (window.__stock || []).includes(list);

// ---------- habits (stories B1-B6) ----------
// A missed habit is never overdue: it waits for its next slot from today (C.habitDue).
// The streak reads 0 once a slot passed without a check-in; the next check-in restarts it at 1.
function habitHTML({ task: t, list }) {
  const td = today(), log = new Set(C.habitLog(t)), doneToday = log.has(td), due = C.habitDue(t, td);
  const chips = [];
  if (t.at) chips.push(`<span class="chip mono">⏰ ${t.at}</span>`);
  if (t.every) chips.push(`<span class="chip">↻ ${esc(C.describeEvery(t.every))}</span>`);
  if (due && due > td && !doneToday) chips.push(`<span class="chip">${esc(dayLabel(due))}</span>`);
  if (t.notes.some(n => n.trim() && !C.HABIT_LOG_RE.test(n))) chips.push(`<span class="chip">✎</span>`);
  for (const tag of t.tags) chips.push(`<span class="chip tag">#${esc(tag)}</span>`);
  const track = t.streak !== 'off';
  const streak = t.due && t.due < td ? 0 : t.streak || 0;
  const days = track ? `<span class="days" title="Last 7 days">${[6, 5, 4, 3, 2, 1, 0].map(i => `<i class="${log.has(C.addDays(td, -i)) ? 'y' : ''}"></i>`).join('')}</span><span class="streak" title="Streak: check-ins in a row">${streak}</span>` : '';
  const sel = editing && editing.id === t.id ? ' sel' : '';
  return `<div class="task habit${doneToday ? ' done' : ''}${sel}" data-id="${t.id}" data-today="${doneToday ? 1 : 0}" style="--lc:${listColor(list)}">
    <button class="check${doneToday ? ' on' : ''}" data-act="check" aria-label="Done today"></button>
    <div class="body"><div class="ttl">${esc(t.title)}</div><div class="meta">${chips.join('')}</div></div>${days}
  </div>`;
}
function habitGroup(title, rows) {
  return rows.length ? `<div class="group"><div class="group-h">${esc(title)} <span class="n">${rows.length}</span></div><div class="rows">${rows.map(habitHTML).join('')}</div></div>` : '';
}
// With ### sections (a moment of the day: Morning, Midday, Evening), one folding group per section, in file order:
// the habits to do now, then the later ones, then the ones done today at the bottom. Without sections: Today and Later.
function habitsListHTML(l, rows, groups) {
  const td = today();
  const doneT = x => C.habitLog(x.task).includes(td), nowT = x => !doneT(x) && C.habitDue(x.task, td) <= td;
  if (!rows.length) return empty('○', 'No habit yet.', 'Add one with +: it repeats every day.');
  if (!groups.length) {
    const now = rows.filter(nowT), done = rows.filter(doneT), later = rows.filter(x => !nowT(x) && !doneT(x));
    return habitGroup('Today', now.concat(done)) + habitGroup('Later', later);
  }
  return buckets(rows, groups).map(g => {
    const r = rows.filter(x => x.group.toLowerCase() === g.toLowerCase());
    if (!r.length) return '';
    const key = l + '|' + g, closed = prefs.folded.includes(key);
    const ordered = r.filter(nowT).concat(r.filter(x => !nowT(x) && !doneT(x)), r.filter(doneT));
    const left = r.filter(nowT).length;
    return `<div class="group sec${closed ? ' closed' : ''}"><button class="group-h fold" data-act="fold" data-key="${esc(key)}" aria-expanded="${!closed}"><span class="chev">▾</span>${esc(g || NOSEC)} <span class="n">${left ? left + ' to do' : r.some(doneT) ? '✓' : ''}</span></button><div class="rows">${closed ? '' : ordered.map(habitHTML).join('')}</div></div>`;
  }).join('');
}

// ---------- stock list (Groceries, Supplies): to buy as tiles, the stock as pills by section ----------
function stockHTML(l, all, groups) {
  const rows = all.filter(x => x.list === l);
  const buy = rows.filter(x => !x.task.checked);
  const inStock = rows.filter(x => x.task.checked);
  const shop = !!prefs.shop[l] || buy.some(x => x.task.doing);
  let html = `<div class="group"><div class="group-h">To buy <span class="n">${buy.length}</span></div><div class="rows">${buy.map(x => taskHTML(x, { showList: false })).join('') || '<div class="stock-empty">Nothing to buy. Tap an item below when you run out.</div>'}</div></div>`;
  const n = buy.filter(x => x.task.doing).length;
  html += shop
    ? `<div class="shopbar"><span>${n} in the cart</span><button class="ghost" data-act="shopcancel">Cancel</button><button class="go" data-act="shopdone">Finish</button></div>`
    : buy.length ? `<div class="shopbar"><span>Going shopping?</span><button class="go" data-act="shop">Shopping mode</button></div>` : '';
  for (const g of buckets(inStock, groups)) {
    const items = inStock.filter(x => x.group.toLowerCase() === g.toLowerCase())
      .sort((a, b) => (a.task.done || '').localeCompare(b.task.done || '') || a.task.title.localeCompare(b.task.title));
    if (!items.length) continue;
    const key = l + '|' + g, closed = prefs.folded.includes(key) !== (g === C.RARE); // Rare starts folded
    html += `<div class="group sec${closed ? ' closed' : ''}"><button class="group-h fold" data-act="fold" data-key="${esc(key)}" aria-expanded="${!closed}"><span class="chev">▾</span>${esc(g || NOSEC)} <span class="n">${items.length}</span></button>`
      + (closed ? '' : `<div class="pills" style="--lc:${listColor(l)}">${items.map(x => `<button class="pill" data-act="restock" data-id="${x.task.id}" title="Last bought ${x.task.done ? esc(dayLabel(x.task.done)) : '—'}">${esc(x.task.title)}</button>`).join('')}</div>`) + `</div>`;
  }
  return html;
}
function group(title, rows, opts = {}, extra = '') {
  if (!rows.length) return '';
  return `<div class="group"><div class="group-h ${opts.late ? 'late' : ''}">${extra}${esc(title)} <span class="n">${rows.length}</span></div><div class="rows">${rows.map(r => taskHTML(r, opts)).join('')}</div></div>`;
}

// ---------- list views: sections, board, lanes, matrix ----------
const NOSEC = 'No section';
// Section buckets of a list: « No section » first when it holds tasks, then the ### headings in file order.
function buckets(rows, groups) {
  const b = rows.some(x => !x.group) || !groups.length ? [''] : [];
  return b.concat(groups);
}
// ---------- group by (story V32): one grouping for the List, Board and Lanes views of a list ----------
const GROUP_BY = [['section', 'Section'], ['tag', 'Tag'], ['priority', 'Priority'], ['date', 'Date'], ['none', 'None']];
const groupMode = l => prefs.groupBy[l] || 'section';
const PRIO_NAMES = { 1: 'High', 2: 'Medium', 3: 'Low', 0: 'No priority' };
// Returns [{ key, label, value, items: [{ x, ghost, hideTag }] }]. value is what a drop on the group writes (section name, tag, priority).
// Section: empty sections hide unless the list shows them (prefs.showEmpty) or they were added in this session.
// Tag: a task sits in each of its tag groups, faded after its first tag; groups by count, then first use; « No tag » last.
// Sort inside a group (View options): date (the default order of the app), priority, or file order. Done tasks go last.
const SORTS = [['date', 'Date'], ['prio', 'Priority'], ['file', 'File']];
function sortItems(l, items) {
  const by = prefs.sortBy[l] || 'date';
  const key = i => i.x.task, byDate = C.sortTasksAt();
  const cmp = by === 'prio' ? (a, b) => (key(a).prio || 9) - (key(b).prio || 9) || byDate(a.x, b.x)
    : by === 'file' ? (a, b) => (a.x.ord ?? 0) - (b.x.ord ?? 0) : (a, b) => byDate(a.x, b.x);
  return items.sort((a, b) => (key(a).checked ? 1 : 0) - (key(b).checked ? 1 : 0) || cmp(a, b));
}
function groupRows(l, rows, groups, mode = groupMode(l)) {
  const out = groupRowsRaw(l, rows, groups, mode);
  for (const g of out) sortItems(l, g.items);
  return out;
}
function groupRowsRaw(l, rows, groups, mode) {
  const one = (key, label, value, items) => ({ key, label, value, items: items.map(x => ({ x })) });
  if (mode === 'section') {
    const all = buckets(rows, groups).map(g => one(g, g || NOSEC, g, rows.filter(x => x.group.toLowerCase() === g.toLowerCase())));
    const shown = all.filter(g => g.items.length || prefs.showEmpty[l] || freshSecs.has(l + '|' + g.key));
    return shown.length ? shown : all;
  }
  if (mode === 'tag') {
    const map = new Map(), none = [];
    for (const x of rows) {
      if (!x.task.tags.length) { none.push({ x }); continue; }
      x.task.tags.forEach((tag, i) => {
        const k = tag.toLowerCase();
        if (!map.has(k)) map.set(k, { key: 'tag:' + k, label: '#' + tag, value: tag, items: [], first: map.size });
        map.get(k).items.push({ x, ghost: i > 0, hideTag: tag });
      });
    }
    const out = [...map.values()].sort((a, b) => b.items.length - a.items.length || a.first - b.first);
    if (none.length) out.push({ key: 'tag:', label: 'No tag', value: '', items: none });
    return out;
  }
  if (mode === 'priority') return [1, 2, 3, 0].map(p => one('p:' + p, PRIO_NAMES[p], String(p), rows.filter(x => (x.task.prio || 0) === p))).filter(g => g.items.length);
  if (mode === 'date') {
    const td = today(), wk = C.addDays(td, 7);
    const D = [['late', 'Overdue', d => d && d < td], ['today', 'Today', d => d === td], ['week', 'Next 7 days', d => d && d > td && d <= wk], ['later', 'Later', d => d && d > wk], ['none', 'No date', d => !d]];
    return D.map(([k, label, f]) => ({ key: 'd:' + k, label, value: null, items: rows.filter(x => f(x.task.due)).sort(C.sortTasksAt()).map(x => ({ x })) })).filter(g => g.items.length);
  }
  return [one('all', '', null, rows)];
}
// A drop on a group writes its value: the section, the tag (it replaces the tag of the source group), or the priority. Date and None groups take no drop.
const droppable = mode => ['section', 'tag', 'priority'].includes(mode);
function groupPatch(mode, t, from, to, curGroup) {
  if (mode === 'section') return to.toLowerCase() !== curGroup.toLowerCase() ? { group: to } : {};
  if (mode === 'tag') {
    if ((from || '').toLowerCase() === (to || '').toLowerCase()) return {};
    const tags = t.tags.filter(x => !from || x.toLowerCase() !== from.toLowerCase());
    if (to && !tags.some(x => x.toLowerCase() === to.toLowerCase())) tags.unshift(to);
    return { tags };
  }
  if (mode === 'priority') return (+to || 0) !== (t.prio || 0) ? { prio: +to || 0 } : {};
  return {};
}
// « 3 + 1 »: the tasks whose first tag is this one, plus the faded copies.
const groupCount = g => { const live = g.items.filter(i => !i.x.task.checked), n = live.filter(i => !i.ghost).length, extra = live.length - n; return extra ? `${n} + ${extra}` : n; }; // done tasks shown by View options do not count
const foldKey = (l, mode, g) => l + '|' + g.key; // a section keeps its old key « list|name »; other keys carry a prefix (tag:, p:, d:)
function sectionsHTML(l, rows, groups) {
  const mode = groupMode(l), addSec = mode === 'section' ? `<button class="add-sec" data-act="addgroup">+ Section</button>` : '';
  if (mode === 'section' && !groups.length) {
    const sorted = sortItems(l, rows.map(x => ({ x }))).map(i => i.x);
    const dated = sorted.filter(x => x.task.due), undated = sorted.filter(x => !x.task.due);
    return group('Scheduled', dated, { showList: false }) + group(dated.length ? 'Anytime' : 'Tasks', undated, { showList: false }) + addSec;
  }
  if (mode === 'none') return `<div class="rows">${groupRows(l, rows, groups)[0].items.map(i => taskHTML(i.x, { showList: false })).join('')}</div>`;
  return groupRows(l, rows, groups).map(g => {
    const key = foldKey(l, mode, g), closed = prefs.folded.includes(key);
    return `<div class="group sec${closed ? ' closed' : ''}"><button class="group-h fold" data-act="fold" data-key="${esc(key)}" aria-expanded="${!closed}"><span class="chev">▾</span><span class="${mode === 'tag' && g.value ? 'gtag' : ''}">${esc(g.label)}</span> <span class="n">${groupCount(g)}</span></button><div class="rows">${closed ? '' : g.items.map(i => taskHTML(i.x, { showList: false, hideTag: i.hideTag, ghost: i.ghost })).join('') || '<div class="drop-hint">Empty section</div>'}</div></div>`;
  }).join('') + addSec;
}
function boardHTML(l, rows, groups) {
  const mode = groupMode(l), cols = groupRows(l, rows, groups), drop = droppable(mode);
  const cur = cols.find(g => g.key === boardTab[l]) ?? cols[0];
  const tabs = `<div class="board-tabs" role="tablist">${cols.map(g => `<button role="tab" data-act="tab" data-group="${esc(g.key)}" class="${g === cur ? 'on' : ''}">${esc(g.label || 'Tasks')}<span class="n">${g.items.length}</span></button>`).join('')}</div>`;
  const body = cols.map(g => {
    const zone = drop ? ` data-drop="1" data-gb="${mode}" data-group="${esc(g.value)}"` : '';
    const add = drop || mode === 'none' ? `<button class="col-add" data-act="addin" data-gb="${mode}" data-group="${esc(g.value ?? '')}" aria-label="Add a task here">+</button>` : '';
    return `<div class="col${g === cur ? ' cur' : ''}"${zone}><div class="group-h"><span class="${mode === 'tag' && g.value ? 'gtag' : ''}">${esc(g.label || 'Tasks')}</span> <span class="n">${groupCount(g)}</span>${add}</div><div class="rows">${g.items.map(i => taskHTML(i.x, { showList: false, drag: drop, hideTag: i.hideTag, ghost: i.ghost })).join('') || '<div class="drop-hint">Drop a task here</div>'}</div></div>`;
  }).join('');
  return tabs + `<div class="board">${body}${mode === 'section' ? '<button class="col add-col" data-act="addgroup">+ Section</button>' : ''}</div>`;
}
const STATES = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']];
function stateOf(t) { return t.checked ? 'done' : t.doing ? 'doing' : 'todo'; }
function lanesHTML(l, rows, groups) {
  const since = C.addDays(today(), -30), mode = groupMode(l), drop = droppable(mode);
  const live = rows.filter(x => (!x.task.checked || (x.task.done || '') >= since) && !notYet(x)); // story L19: only what I can do now
  let html = `<div class="lanes" style="--cols:${STATES.length}"><div></div>${STATES.map(([, s]) => `<div class="lane-h">${s}</div>`).join('')}`;
  const byDate = C.sortTasksAt();
  for (const g of groupRows(l, live, groups)) {
    html += `<div class="lane-name${mode === 'tag' && g.value ? ' gtag' : ''}">${esc(g.label || 'Tasks')}</div>`;
    for (const [k] of STATES) {
      const r = g.items.filter(i => stateOf(i.x.task) === k).sort((a, b) => byDate(a.x, b.x));
      // Without a group value (Date, None), a drop only changes the state.
      html += `<div class="cell" data-drop="1" data-gb="${drop ? mode : 'state'}" data-group="${esc(g.value ?? '')}" data-state="${k}">${r.map(i => taskHTML(i.x, { showList: false, drag: true, hideTag: i.hideTag, ghost: i.ghost })).join('')}</div>`;
    }
  }
  return `<div class="lanes-wrap">${html}</div></div>${mode === 'section' ? '<button class="add-sec" data-act="addgroup">+ Section</button>' : ''}`;
}
// Urgent = due in the next 7 days (or overdue); important = priority high or medium.
function matrixHTML(rows, showList) {
  const soon = C.addDays(today(), 7);
  const urgent = x => dueOf(x) && dueOf(x) <= soon && !['before', 'missed'].includes(winPhase(x)), important = x => x.task.prio === 1 || x.task.prio === 2;
  const Q = [
    ['Urgent · important', 'q1', x => urgent(x) && important(x)],
    ['Important · later', 'q2', x => !urgent(x) && important(x)],
    ['Urgent · less important', 'q3', x => urgent(x) && !important(x)],
    ['Neither', 'q4', x => !urgent(x) && !important(x)],
  ];
  return `<div class="matrix">${Q.map(([name, cls, f]) => { const r = rows.filter(x => !notYet(x) && f(x)); return `<div class="quad ${cls}"><div class="group-h">${name} <span class="n">${r.length}</span></div><div class="rows">${r.map(x => taskHTML(x, { showList })).join('')}</div></div>`; }).join('')}</div>`;
}
// ---------- View options (story L8): one button at the right edge, one glass panel ----------
// Three rows (variant G2): Group by and Sort; the eye toggles; Notes and Density. The « This list » parts apply to the open list;
// in another view, or in a habits or stock list, they stay in place, greyed out, so nothing moves (anchored controls).
const segsHTML = (k, vals, cur, off) => `<span class="vsegs" role="radiogroup">${vals.map(([v, name]) => `<button role="radio" data-opt="${k}" data-v="${v}" aria-checked="${String(cur) === String(v)}"${off ? ' disabled' : ''}>${name}</button>`).join('')}</span>`;
const EYE_ON = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1"/>';
const eyeHTML = (k, name, on, off, tip = '') => `<button class="veye${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-opt="${k}"${off ? ` disabled title="${tip}"` : ''}><span class="vi">${icon(on ? EYE_ON : EYE_OFF, 16)}</span>${name}</button>`;
function optsChanged(l) {
  const g = prefs.preview !== 0 || prefs.density !== 1 || !prefs.chips.tags || !prefs.chips.dates || !prefs.chips.repeat;
  return g || (!!l && (groupMode(l) !== 'section' || !!prefs.showEmpty[l] || !!prefs.showDone[l] || (prefs.sortBy[l] || 'date') !== 'date'));
}
function viewOptsHTML() {
  const l = st.optList && st.view === 'list:' + st.optList ? st.optList : null, off = !l;
  const tip = 'Open a task list';
  const groups = l ? C.listGroups(currentDoc(), l) : [];
  const noSec = !l || groupMode(l) !== 'section' || !groups.length;
  return `<div class="vrow"><span class="vlab">Group by</span>${segsHTML('group', GROUP_BY, l ? groupMode(l) : '', off)}<span class="vsp"></span><span class="vlab">Sort</span>${segsHTML('sort', SORTS, l ? prefs.sortBy[l] || 'date' : '', off)}</div>`
    + `<div class="vrow veyes">${eyeHTML('empty', 'Empty sections', !!(l && prefs.showEmpty[l]), noSec, l ? 'Group by Section, in a list with sections' : tip)}${eyeHTML('done', 'Done tasks', !!(l && prefs.showDone[l]), off, tip)}${eyeHTML('tags', 'Tags', prefs.chips.tags)}${eyeHTML('dates', 'Dates', prefs.chips.dates)}${eyeHTML('repeat', 'Repeat', prefs.chips.repeat)}</div>`
    + `<div class="vrow"><span class="vlab">Notes</span>${segsHTML('preview', [[0, 'Off'], [1, '1'], [2, '2'], [3, '3']], prefs.preview)}<span class="vsp"></span><span class="vlab">Density</span>${segsHTML('density', [[0, 'Compact'], [1, 'Normal'], [2, 'Airy']], prefs.density)}</div>`;
}
function paintViewOpts() {
  const l = st.optList && st.view === 'list:' + st.optList ? st.optList : null;
  const b = $('#optsBtn'), ch = optsChanged(l);
  b.classList.toggle('on', ch || !!st.optsOpen);
  b.classList.toggle('dot', ch);
  b.setAttribute('aria-expanded', !!st.optsOpen);
  document.body.dataset.density = prefs.density;
  const p = $('#viewOpts');
  p.hidden = !st.optsOpen;
  if (st.optsOpen) p.innerHTML = viewOptsHTML();
}
function toolsHTML(l) {
  const m = listMode(l);
  return `<div class="modes" role="group" aria-label="View">${MODES.map(x => `<button data-mode="${x.id}" class="${m === x.id ? 'on' : ''}" title="${x.label}" aria-pressed="${m === x.id}">${icon(x.svg)}</button>`).join('')}</div>`;
}

// Sidebar and phone Lists page (story B5): Inbox alone on its card, then one folding card per list type.
// The marker shape gives the type: a square for tasks, a ring for habits, a bag for stock.
const TILE_ICON = {
  inbox: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5"/>',
  habits: '<circle cx="12" cy="12" r="7.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  stock: '<path d="M5 8h14l-1.2 11.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  stickies: '<path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19"/>',
  matrix: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};
const TYPES = C.LIST_TYPES.map(t => [t.id, t.label]); // one source: core.mjs
function listsNav(lists, typeOf, countOf, withInbox = true) {
  const row = l => `<button data-view="list:${esc(l)}" class="${st.view === 'list:' + l ? 'on' : ''}"><span class="mk ${typeOf(l)}" style="--c:${listColor(l)}"></span>${esc(l)}<span class="count">${countOf(l) || ''}</span></button>`;
  const inbox = lists.find(l => l.toLowerCase() === 'inbox');
  let h = withInbox ? `<div class="ncard">${row(inbox)}</div>` : '';
  for (const [type, label] of TYPES) {
    const ls = lists.filter(l => l !== inbox && typeOf(l) === type);
    if (!ls.length) continue;
    const closed = prefs.navFold.includes(type) !== (type === 'stock');
    const n = ls.reduce((a, l) => a + countOf(l), 0);
    h += `<div class="ngroup"><div class="nhead"><button class="nfold" data-act="navfold" data-type="${type}" aria-expanded="${!closed}"><span class="chev">${closed ? '▸' : '▾'}</span>${label}${closed && n ? `<span class="count">${n}</span>` : ''}</button>`
      + `<button class="nplus" data-act="newlist" data-type="${type}" title="New ${label.toLowerCase()} list" aria-label="New ${label.toLowerCase()} list">+</button></div>`
      + (closed ? '' : `<div class="ncard">${ls.map(row).join('')}</div>`) + `</div>`;
  }
  return h;
}

// The date a task lives on in the Agenda, the strip, the counts and Matrix: its due date, or the act-by date of a sticky
// with a lead (story L11: the deadline only serves to compute it).
// The day a row belongs to (story L15): its start, else its act-by day. A window task still open after its start day
// moves to today; one past act by (margin or missed) counts as overdue, so it shows red at the top.
const isWin = x => !!x.task.by && !x.task.checked && !(window.__stickies || []).includes(x.list);
const winPhase = x => isWin(x) || (!x.task.checked && C.fixedStart(x.task, listTypeByName(x.list))) ? C.phase(x.task) : null; // L24: a fixed start too
// The list types change only with the file or the queued ops: read them once for each version, not once for each task.
let listTypes = { text: null, pending: null, n: -1, map: null };
const listTypeByName = l => {
  if (listTypes.text !== st.text || listTypes.pending !== st.pending || listTypes.n !== st.pending.length)
    listTypes = { text: st.text, pending: st.pending, n: st.pending.length, map: new Map(currentDoc().sections.map(s => [s.name, C.listTypeOf(s)])) };
  return listTypes.map.has(l) ? listTypes.map.get(l) : C.listTypeOf(undefined);
};
// Story L19: before its window opens, a task cannot be done yet. Matrix and Lanes (do-now views) leave it out;
// Agenda, List and Board (plan views) keep it.
const notYet = x => winPhase(x) === 'before';
const dueOf = x => {
  const d = C.dayOf(x.task), ph = winPhase(x), td = today();
  if (ph === 'margin' || ph === 'missed') return d && d < td ? d : C.addDays(td, -1);
  if ((ph === 'window' || ph === 'before') && d && d < td) return td;
  return d;
};
// ---------- stickies (story L9): pense-bêtes, sorted by date, the undated ones at the bottom ----------
function stickiesHTML(rows) {
  const dated = rows.filter(x => dueOf(x)).sort((a, b) => dueOf(a).localeCompare(dueOf(b)));
  const undated = rows.filter(x => !dueOf(x));
  const opts = { showList: false };
  return (group('By date', dated, opts) + group('No date', undated, opts))
    || empty('▱', 'No sticky yet.', 'Claude adds them: « add a sticky … ».');
}
// The horizon line (story L9, variant D, week groups G3), on every screen: one row of pills on a log scale with no end date, so the
// next days get room and the far ones squeeze. The scale reads Today · 1 wk · 1 mo · 3 mo (· 6 mo · 1 yr when a sticky is that far).
// The stickies of one week (Monday to Sunday) share one pill: the note icon and the J-x of the nearest one; with more than one, paper
// stacks behind the pill and a badge gives the count, so 3 or 10 take the same room. Pills that would touch are pushed apart after
// render (layoutHorizon); a small grey mark then stays at the true date. A hover lists the titles; a tap opens the sticky, or the
// Stickies view for a group. Project deadlines join in step 2 (L10).
// Story L11 (round 3, legend Y): a sticky with a lead sits at its act-by date, never at its deadline. Fill = commitment (filled firm,
// outline best effort); colour = urgency and action: red within 7 days or late, the accent when an action is due (a lead), else grey.
// A late sticky (act-by date or deadline passed) stays at Today in red, with « ! » for its count.
const HZ_TICKS = [[7, '1 wk'], [30, '1 mo'], [90, '3 mo'], [180, '6 mo'], [365, '1 yr']];
function horizonHTML(stickies, td) {
  const days = d => Math.max(0, Math.round((C.fromYmd(d) - C.fromYmd(td)) / 864e5));
  const on = stickies.filter(x => dueOf(x)).sort((a, b) => dueOf(a).localeCompare(dueOf(b)));
  if (!on.length) return '';
  const end = Math.max(120, Math.ceil(days(dueOf(on.at(-1))) * 1.15));
  const pos = n => Math.log(1 + n) / Math.log(1 + end); // 0 … 1
  const pc = n => (pos(n) * 100).toFixed(2) + '%';
  const ticks = HZ_TICKS.filter(([n]) => n < end * .9);
  const wd = (C.weekday(td) + 6) % 7; // Monday = 0
  const weeks = [];
  for (const x of on) { const k = Math.floor((days(dueOf(x)) + wd) / 7); if (weeks.at(-1)?.k !== k) weeks.push({ k, items: [] }); weeks.at(-1).items.push(x); }
  const axis = `<div class="hz-axis"><span style="left:0">Today</span>${ticks.map(([n, t]) => `<span style="left:${pc(n)}">${t}</span>`).join('')}</div>`;
  const jx = x => dueOf(x) < td ? '!' : days(dueOf(x));
  const pins = weeks.map(({ items }) => {
    const n = days(dueOf(items[0])), many = items.length > 1, late = dueOf(items[0]) < td;
    const cls = `hpin${n <= 7 ? ' hot' : ''}${items.some(x => x.task.lead) ? ' act' : ''}${items.some(x => x.task.firm) ? ' firm' : ''}${many ? ' stack' : ''}`;
    const names = items.map(x => `<span><b>${x.task.lead ? 'Act ' : ''}J-${jx(x)}</b>${esc(plainTitle(x.task.title))}</span>`).join('');
    const what = items[0].task.lead ? `act by ${esc(dayLabel(dueOf(items[0]), true))}` : esc(dayLabel(dueOf(items[0]), true));
    const label = many ? `${items.length} stickies, the nearest in ${n} days` : `${esc(items[0].task.title)}, ${late ? 'late' : `in ${n} days`}, ${what}`;
    return `<span class="hz-true" data-x="${pos(n)}"></span><button class="${cls}" data-act="${many ? 'hgroup' : 'hpin'}" data-id="${items[0].task.id}" data-x="${pos(n)}" aria-label="${label}">${icon(ICON.stickies, 12)}<b>${late ? '!' : n}</b>${many ? `<span class="hbdg">${items.length}</span>` : ''}<span class="hname">${names}</span></button>`;
  }).join('');
  return `<div class="horizon">${axis}<div class="hz-line"><span class="hz-base"></span>${ticks.map(([n]) => `<i style="left:${pc(n)}"></i>`).join('')}<span class="hz-now"></span>${pins}</div></div>`;
}
// Places the pills in pixels: true position first, then each pill at least its width + 6 px right of the previous one (a stack takes
// 6 px more for its paper), then pulled back from the right edge. A pill that moved shows the grey mark of its true date.
function layoutHorizon() {
  const line = document.querySelector('.horizon .hz-line'); if (!line) return;
  const W = line.clientWidth, pins = [...line.querySelectorAll('.hpin')], marks = [...line.querySelectorAll('.hz-true')];
  const w = pins.map(p => p.getBoundingClientRect().width + (p.classList.contains('stack') ? 8 : 0)), want = pins.map((p, i) => Math.max(w[i] / 2, +p.dataset.x * W));
  const x = want.slice();
  for (let i = 1; i < x.length; i++) x[i] = Math.max(x[i], x[i - 1] + (w[i - 1] + w[i]) / 2 + 6);
  for (let i = x.length - 1; i >= 0; i--) x[i] = Math.min(x[i], i === x.length - 1 ? W - w[i] / 2 : x[i + 1] - (w[i] + w[i + 1]) / 2 - 6);
  pins.forEach((p, i) => { p.style.left = x[i] + 'px'; p.classList.toggle('edge', x[i] > W - 140); });
  marks.forEach((m, i) => { m.style.left = +m.dataset.x * W + 'px'; m.hidden = Math.abs(x[i] - +m.dataset.x * W) < 3; });
}
addEventListener('resize', layoutHorizon);

// ---------- Agenda: one view for Today, 3 days, Week, Month, All and a custom range (stories V1, V2) ----------
// Story B10 (variant N, round 4): the Agenda shows the habits to do in the next 4 hours, by the time of day.
// A section name gives a habit its time window; an at: time wins. A habit whose window passed without a check
// stays (dashed) until midnight. The later ones count in a ghost tile « +N later ».
// A tap on a tile checks the habit; a tap anywhere else in the zone opens the Habits view.
const MOMENTS = [ // [names, start hour, end hour, title]
  [['morning', 'matin'], 6, 12, 'Morning'], [['midday', 'noon', 'midi'], 11, 14, 'Midday'],
  [['afternoon', 'après-midi', 'apres-midi'], 14, 18, 'Afternoon'], [['evening', 'soir'], 18, 23, 'Evening'], [['night', 'nuit'], 21, 24, 'Night'],
];
const hourOf = hm => +hm.slice(0, 2) + +hm.slice(3, 5) / 60;
function habitWindow(x) {
  if (x.task.at) { const a = hourOf(x.task.at); return [a, Math.min(24, a + 2)]; }
  const m = MOMENTS.find(([names]) => names.includes(x.group.toLowerCase()));
  return m ? [m[1], m[2]] : [0, 24];
}
const plainTitle = t => t.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '') || t;
const habitEmoji = t => (t.match(/^\p{Extended_Pictographic}️?/u) || [t.trim()[0] || '·'])[0];
function habitZone(rows) {
  if (!rows.length) return '';
  const td = today(), now = hourOf(C.nowTimeIn());
  const done = x => C.habitLog(x.task).includes(td);
  const soon = x => { const [a, b] = habitWindow(x); return a <= now + 4 && b > now; };
  const past = x => habitWindow(x)[1] <= now;
  const show = rows.filter(x => soon(x) || (past(x) && !done(x)));
  const later = rows.filter(x => !done(x) && !show.includes(x));
  if (!show.length) return `<button class="hzone thin" data-act="hopen">Habits <span class="rest">${later.length ? later.length + ' later' : '✓'}</span><span class="chev">›</span></button>`;
  const m = MOMENTS.find(([, a, b]) => now >= a && now < b) || MOMENTS.find(([, a]) => a > now);
  const head = m ? `${m[3]} <span class="when">until ${String(m[2]).padStart(2, '0')}:00</span>` : 'Habits';
  const tile = x => {
    const d = done(x), t = x.task, under = t.tags[0] ? `<span class="hlb tag">#${esc(t.tags[0])}</span>` : `<span class="hlb">${esc(t.at || t.title.replace(/^\p{Extended_Pictographic}️?\s*/u, ''))}</span>`;
    return `<button class="htile${d ? ' done' : ''}${!d && past(x) ? ' carry' : ''}" data-act="hcheck" data-id="${t.id}" style="--lc:${listColor(x.list)}" title="${esc(t.title)}${d ? ' · done today' : ''}"><span class="hsq">${esc(habitEmoji(t.title))}</span>${under}</button>`;
  };
  const ghost = later.length ? `<span class="htile ghost"><span class="hsq">+${later.length}</span><span class="hlb">later</span></span>` : '';
  return `<div class="hzone" data-act="hopen"><div class="hhead">${head}<span class="chev">›</span></div><div class="htiles">${show.map(tile).join('')}${ghost}</div></div>`;
}
function agendaHTML(tasks, habitsDay, td) {
  const r = st.range, [a, b] = rangeSpan(r, td);
  const overdue = tasks.filter(x => dueOf(x) && dueOf(x) < td);
  let html = horizonHTML(tasks.filter(x => (window.__stickies || []).includes(x.list)), td);
  html += a === td ? habitZone(habitsDay) : ''; // a short zone: the agenda keeps its room for the tasks
  html += group('Overdue', overdue, { late: true });
  let title, sub;
  if (r.id === 'all') {
    title = 'All'; sub = `${tasks.length} open tasks`;
    const wk = C.addDays(td, 6), mo = C.addDays(td, 29);
    html += group('This week', tasks.filter(x => dueOf(x) && dueOf(x) >= td && dueOf(x) <= wk))
      + group('This month', tasks.filter(x => dueOf(x) && dueOf(x) > wk && dueOf(x) <= mo))
      + group('Later', tasks.filter(x => dueOf(x) && dueOf(x) > mo))
      + group('No date', tasks.filter(x => !dueOf(x)));
  } else {
    title = r.id === 'custom' ? (a === b ? dayLabel(a, true) : 'Custom range') : RANGES.find(x => x.id === r.id).title;
    sub = a === b ? C.fromYmd(a).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : `${shortDate(a)} – ${shortDate(b)}`;
    for (let d = a; d <= b; d = C.addDays(d, 1)) html += group(dayLabel(d, true), tasks.filter(x => dueOf(x) === d), { showDate: false });
    const after = tasks.filter(x => dueOf(x) && dueOf(x) > b).length;
    if (after) html += `<div class="more-after">${WIDER[r.id] ? `<button data-range="${WIDER[r.id]}">${after} more after ${esc(shortDate(b))} · Show ${RANGES.find(x => x.id === WIDER[r.id]).label}</button>` : `<span>${after} more after ${esc(shortDate(b))}</span>`}</div>`;
  }
  if (!html.includes('class="group"')) html = empty('☀︎', r.id === 'today' ? 'Nothing due today.' : 'Nothing due in this range.', r.id === 'today' ? 'Tap 3 days or a day of the strip to look ahead.' : '') + html;
  return { html, title, sub };
}
// The day strip: the next 14 days, dots for the load of each day, the range highlighted.
// A tap shows that day; a tap on a later day then makes a custom range.
function stripHTML(tasks, td) {
  const [a, b0] = rangeSpan(st.range, td), b = b0 || '9999-12-31';
  let h = '';
  for (let i = 0; i < STRIP_DAYS; i++) {
    const d = C.addDays(td, i), n = tasks.filter(x => dueOf(x) === d).length;
    const cls = d === a || d === b ? 'end' : d > a && d < b ? 'in' : '';
    const wd = C.fromYmd(d).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2);
    h += `<button data-day="${d}" class="${cls}${C.weekday(d) === 1 && i ? ' wk' : ''}" aria-label="${esc(dayLabel(d, true))}${n ? `, ${n} task${n > 1 ? 's' : ''}` : ''}"><span class="w">${wd}</span><span class="dn">${+d.slice(8)}</span><span class="dots">${'<i></i>'.repeat(Math.min(n, 3))}</span></button>`;
  }
  const tip = st.anchor ? `From ${shortDate(st.anchor)}: tap the last day.` : 'Tap a day, then another day for a range.';
  return `<div class="strip">${h}</div><div class="strip-tip">${esc(tip)}</div>`;
}
function setRange(id) {
  if (st.view !== 'agenda') { st.view = 'agenda'; LS.set('view', 'agenda'); window.scrollTo(0, 0); }
  st.range = { id }; st.anchor = null; render(); window.scrollTo(0, 0);
}

function render() {
  if (hashRetry && currentDoc().sections.length) { hashRetry = false; readHash(); }
  const doc = currentDoc();
  const all = C.allTasks(doc);
  const open = all.filter(x => !x.task.checked).sort(C.sortTasksAt());
  const td = today();
  const lists = doc.sections.map(s => s.name);
  if (!lists.some(l => l.toLowerCase() === 'inbox')) lists.unshift('Inbox');
  window.__lists = lists;
  window.__listColors = Object.fromEntries(doc.sections.map(x => [x.name.toLowerCase(), markerColor(x.color)]).filter(e => e[1]));
  const stockLists = doc.sections.filter(s => s.stock).map(s => s.name);
  window.__stock = stockLists;
  const habitLists = doc.sections.filter(s => s.habits).map(s => s.name);
  window.__habits = habitLists;
  const stickyLists = doc.sections.filter(s => s.stickies).map(s => s.name);
  window.__stickies = stickyLists;
  // Habits stay out of the task views, the counts and the badge: Today shows them in their own strip.
  const habits = all.filter(x => !x.task.checked && habitLists.includes(x.list)); // file order, not the task sort
  const tasks = open.filter(x => !habitLists.includes(x.list));
  const habitsNow = habits.filter(x => C.habitDue(x.task, td) <= td);

  // nav
  const late = tasks.filter(x => dueOf(x) && dueOf(x) < td).length;
  const counts = {
    habits: habitsNow.length,
    stickies: tasks.filter(x => stickyLists.includes(x.list)).length,
    agenda: tasks.filter(x => dueOf(x) && dueOf(x) <= td).length,
    matrix: tasks.filter(x => dueOf(x) && dueOf(x) <= C.addDays(td, 7) && !['before', 'missed'].includes(winPhase(x)) && (x.task.prio === 1 || x.task.prio === 2)).length,
  };
  const typeOf = l => C.listTypeOf(doc.sections.find(s => s.name === l));
  const countOf = l => (typeOf(l) === 'habits' ? habitsNow : open).filter(x => x.list === l).length;
  let nav = `<div class="brand">Tasks</div>`;
  nav += `<button class="add-task" data-act="add" title="Add a task (n)"><span class="ico">+</span>New task<kbd>n</kbd></button>`;
  nav += `<button class="add-task search-btn" data-act="search" title="Search tasks and lists (/ or ⌘K)"><span class="ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>Search<kbd>⌘K</kbd></button>`;
  nav += VIEWS.map(v => `<button data-view="${v.id}" class="${st.view === v.id ? 'on' : ''}"><span class="ico">${v.id === 'stickies' ? '<span class="stk-ico"></span>' : v.ico || agendaIcon(17)}</span>${v.label}<span class="count ${v.id === 'agenda' && late ? 'late' : ''}">${counts[v.id] || ''}</span></button>`).join('');
  nav += `<div class="sep"></div>` + listsNav(lists, typeOf, countOf) + `<div class="sep"></div>`;
  nav += `<button data-view="done" class="${st.view === 'done' ? 'on' : ''}"><span class="ico">✓</span>Done</button>`;
  nav += `<button class="newlist" data-act="newlist"><span class="ico">+</span>New list</button>`;
  $('#nav').innerHTML = nav;

  // phone: floating tab bar (Agenda, Habits, Lists); lists and Done live on the Lists page behind the third tab (variant A)
  const tabs = [...VIEWS.filter(x => x.id !== 'matrix' && x.id !== 'stickies'), { id: 'lists', label: 'Lists' }]; // N2: Matrix and Stickies are tiles of the Lists page on the phone
  const inLists = (st.view.startsWith('list:') && !habitLists.includes(st.view.slice(5))) || ['lists', 'done', 'matrix', 'stickies'].includes(st.view);
  // « ‹ Lists » (phone only): a view under the Lists tab leads back to the Lists page; a habits list belongs to the Habits tab.
  $('#backLists').hidden = !inLists || st.view === 'lists';
  $('#tabbar').innerHTML = tabs.map(t => {
    const on = t.id === 'lists' ? inLists : t.id === 'habits' ? st.view === 'habits' || habitLists.includes(st.view.slice(5)) : st.view === t.id;
    const badge = t.id === 'agenda' && late ? `<span class="badge">${late}</span>` : '';
    return `<button data-view="${t.id}" class="${on ? 'on' : ''}" aria-current="${on ? 'page' : 'false'}">${t.id === 'agenda' ? agendaIcon() : svg(t.id)}<span>${t.label}</span>${badge}</button>`;
  }).join('');
  // Lists page (variant F tiles): four tiles with big counts, then the type groups. Inbox and Matrix live in the tiles.
  const firstOf = t => lists.find(l => typeOf(l) === t);
  const buyList = stockLists.find(l => open.some(x => x.list === l)) || firstOf('stock');
  const tiles = [
    ['list:Inbox', 'inbox', 'Inbox', listColor('Inbox'), countOf('Inbox')],
    firstOf('habits') && ['list:' + firstOf('habits'), 'habits', 'Habits', listColor(firstOf('habits')), habitsNow.length],
    buyList && ['list:' + buyList, 'stock', 'To buy', listColor(buyList), open.filter(x => stockLists.includes(x.list)).length],
    stickyLists.length && ['stickies', 'stickies', 'Stickies', 'var(--ink2)', counts.stickies],
    ['matrix', 'matrix', 'Matrix', 'var(--ink2)', counts.matrix],
  ].filter(Boolean);
  const listsPage = `<div class="tiles">${tiles.map(([v, ic, label, c, n]) => `<button class="tile${st.view === v ? ' on' : ''}" data-view="${esc(v)}" style="--c:${c}"><span class="tdot">${icon(TILE_ICON[ic], 16)}</span><span class="tn">${n}</span><span class="tl">${label}</span></button>`).join('')}</div>`
    + listsNav(lists, typeOf, countOf, false) + `<div class="sep"></div><button data-view="done" class="${st.view === 'done' ? 'on' : ''}"><span class="ico">✓</span>Done</button><button data-act="newlist" class="newlist"><span class="ico">+</span>New list</button>`;

  // main
  let html = '', title = '', sub = '', tools = '', wide = false;
  const v = st.view;
  let strip = '';
  if (v === 'agenda') {
    // Today's habits for the one-line bar: still to do, and done today (shown checked).
    const habitsDay = habits.filter(x => C.habitDue(x.task, td) <= td || C.habitLog(x.task).includes(td));
    ({ html, title, sub } = agendaHTML(tasks, habitsDay, td));
    tools = `<div class="ranges" role="group" aria-label="Range">${RANGES.map(x => `<button data-range="${x.id}" class="${st.range.id === x.id ? 'on' : ''}" aria-pressed="${st.range.id === x.id}">${x.label}</button>`).join('')}</div>`;
    strip = stripHTML(tasks, td);
  } else if (v === 'settings') {
    title = 'Settings';
  } else if (v === 'help') {
    title = 'How it works';
  } else if (v === 'lists') {
    title = 'Lists';
    html = `<div id="listsBody">${listsPage}</div>`;
  } else if (v === 'habits') {
    title = 'Habits';
    const left = habitsNow.length;
    sub = left ? `${left} to do today` : habits.length ? 'All done today' : '';
    html = habitLists.map(l => (habitLists.length > 1 ? `<div class="list-h"><span class="mk habits" style="--c:${listColor(l)}"></span>${esc(l)}</div>` : '')
      + habitsListHTML(l, habits.filter(x => x.list === l), C.listGroups(doc, l))).join('')
      || empty('◯', 'No habits list yet.', 'Create one with New list → Habits.');
  } else if (v === 'stickies') {
    title = 'Stickies';
    const rows = tasks.filter(x => stickyLists.includes(x.list));
    sub = rows.length ? `${rows.length} not to forget` : '';
    html = stickyLists.length ? stickiesHTML(rows) : empty('▱', 'No stickies list yet.', 'Claude creates it with the first sticky.');
  } else if (v === 'matrix') {
    title = 'Matrix';
    sub = 'Urgent = due within 7 days · important = !!! or !!';
    html = matrixHTML(tasks, true);
    wide = true;
  } else if (v === 'done') {
    title = 'Done';
    const done = all.filter(x => x.task.checked && !stockLists.includes(x.list)).sort((a, b) => (b.task.done || '').localeCompare(a.task.done || ''));
    html = group('Completed', done);
    if (!done.length) html = empty('✓', 'Nothing completed yet.', '');
  } else if (v.startsWith('list:')) {
    const l = v.slice(5);
    title = l;
    // « Done tasks » in View options adds the tasks done in the last 7 days, at the bottom of their group.
    const since7 = C.addDays(td, -7);
    const rows = all.filter(x => x.list === l && (!x.task.checked || (prefs.showDone[l] && (x.task.done || '') >= since7)));
    all.forEach((x, i) => { x.ord = i; }); // file order, for « Sort: File »
    const groups = C.listGroups(doc, l);
    // The phone is for reading (story V29): always the List view, no view switch, no « + Section ».
    const mode = phone() ? 'list' : listMode(l);
    const special = stockLists.includes(l) || habitLists.includes(l) || stickyLists.includes(l);
    tools = special || phone() ? '' : toolsHTML(l);
    st.optList = special ? null : l; // the « This list » part of View options
    if (stockLists.includes(l)) { html = stockHTML(l, all, groups); sub = 'Stock list'; }
    else if (habitLists.includes(l)) { html = habitsListHTML(l, habits.filter(x => x.list === l), groups); sub = 'Habits'; }
    else if (stickyLists.includes(l)) { html = stickiesHTML(rows.filter(x => !x.task.checked)); sub = 'Stickies'; }
    else if (mode === 'board') { html = boardHTML(l, rows, groups); wide = true; }
    else if (mode === 'lanes') { html = lanesHTML(l, all.filter(x => x.list === l), groups); wide = true; }
    else if (mode === 'matrix') { html = matrixHTML(rows.filter(x => !x.task.checked), false); wide = true; }
    else html = sectionsHTML(l, rows, groups);
    if (!rows.length && !groups.length && mode !== 'lanes' && !special) html = empty('○', 'This list is empty.', '') + `<button class="add-sec" data-act="addgroup">+ Section</button>`;
  }
  $('#viewTools').innerHTML = tools;
  $('#dayStrip').innerHTML = strip;
  $('#dayStrip').hidden = !strip;
  document.querySelector('main').classList.toggle('wide', wide);
  // List views center the title and the view switch: main stays centered at every width, so they keep their place when the view changes.
  document.querySelector('main').classList.toggle('centered', st.view.startsWith('list:'));
  document.querySelector('main').classList.toggle('no-tools', !tools);
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub || (st.view.startsWith('list:') ? '' : '');
  $('#list').innerHTML = html;
  $('#settings').hidden = v !== 'settings';
  $('#help').hidden = v !== 'help';
  $('#backSettings').hidden = !PAGES.includes(v);
  document.body.classList.toggle('on-settings', PAGES.includes(v));
  $('#settingsBtn').classList.toggle('on', v === 'settings');
  document.title = counts.agenda ? `Tasks (${counts.agenda})` : 'Tasks';
  updatePreview();
  if (!v.startsWith('list:')) st.optList = null;
  paintViewOpts();
  layoutHorizon();
  if (hashTask) setTimeout(openHashTask); else if (!hashRetry) writeHash(); // keep the anchor until the file can resolve it
}
const empty = (big, a, b) => `<div class="empty"><div class="big">${big}</div><div>${esc(a)}</div><div class="small">${esc(b)}</div></div>`;

function setView(v) {
  if (sheet.open && sheet.classList.contains('docked')) sheet.close(); // a new view closes the task panel
  if (v !== 'agenda' || st.view !== 'agenda') { st.range = { id: '3d' }; st.anchor = null; } // a range lasts while you stay in Agenda
  st.optsOpen = false; // View options closes when the view changes
  st.view = v; if (v !== 'settings' && v !== 'help') LS.set('view', v); render(); window.scrollTo(0, 0); // a reload never lands on Settings or How it works
}

// ---------- quick add ----------
function quickDefaults() {
  const v = st.view;
  return {
    list: v.startsWith('list:') ? v.slice(5) : 'Inbox',
    // In Agenda, a quick add takes the first day of the range when the range is one day (story C4).
    due: v === 'agenda' && (st.range.id === 'today' || (st.range.id === 'custom' && st.range.from === st.range.to)) ? rangeSpan(st.range, today())[0] : null,
  };
}
function parsedInput() {
  const raw = $('#addInput').value;
  if (!raw.trim()) return null;
  const q = C.parseQuick(raw, { today: today(), now: C.nowTimeIn(), lists: window.__lists || [] });
  const d = quickDefaults();
  if (!q.list) q.list = d.list;
  if (!q.due && d.due) q.due = d.due;
  return q;
}
function updatePreview() {
  const q = parsedInput();
  $('#addForm').classList.toggle('has', !!q);
  if (!q) { $('#addPreview').innerHTML = ''; return; }
  const c = [];
  if (q.due) c.push(`📅 ${dayLabel(q.due)}`);
  if (q.at) c.push(`⏰ ${q.at}`);
  if (q.every) c.push(`↻ ${C.describeEvery(q.every)}`);
  if (q.prio) c.push(['', 'High', 'Medium', 'Low'][q.prio]);
  for (const t of q.tags) c.push('#' + t);
  c.push('→ ' + q.list);
  $('#addPreview').innerHTML = c.map(x => `<span class="chip">${esc(x)}</span>`).join('');
}
$('#addInput').addEventListener('input', updatePreview);
function openAdd() { document.body.classList.add('adding'); $('#addForm').classList.add('open'); $('#fab').hidden = true; $('#addInput').focus(); }
function closeAdd() { document.body.classList.remove('adding'); $('#addForm').classList.remove('open'); $('#fab').hidden = false; $('#addInput').value = ''; updatePreview(); }
$('#fab').addEventListener('click', () => openPalette()); // story L25: the round button of the phone opens the search; the palette also adds
$('#addInput').addEventListener('keydown', e => { if (e.key === 'Escape') closeAdd(); });
// The bar stays open after Enter for a second task; leaving it empty closes it.
$('#addInput').addEventListener('blur', () => setTimeout(() => { if (!$('#addInput').value.trim() && document.activeElement !== $('#addInput')) closeAdd(); }, 150));
$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = parsedInput();
  if (!q || !q.title) return;
  commit({ type: 'add', id: C.newId(), title: q.title, list: q.list, due: q.due, at: q.at, every: q.every, prio: q.prio, tags: q.tags, firm: q.firm, fixed: q.fixed, lead: q.lead, leadH: q.leadH, by: q.by, est: q.est });
  $('#addInput').value = '';
  updatePreview();
});

// ---------- list interactions ----------
$('#tabbar').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  setView(b.dataset.view);
});
$('#backLists').addEventListener('click', () => setView('lists'));
const navClick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'navfold') {
    const k = b.dataset.type;
    prefs.navFold = prefs.navFold.includes(k) ? prefs.navFold.filter(x => x !== k) : [...prefs.navFold, k];
    savePrefs(); return render();
  }
  if (b.dataset.view) return setView(b.dataset.view);
  if (b.dataset.act === 'add') return openAdd();
  if (b.dataset.act === 'search') return openPalette();
  if (b.dataset.act === 'newlist') openNewList(b.dataset.type || 'tasks');
};
// New list: a name and a type (story B4). The type writes the heading marker: none, ~habits or ~stock.
let newListType = 'tasks';
// The type cards come from C.LIST_TYPES, like the sidebar groups: a new type shows here with no HTML change.
$('#nlTypes').innerHTML = C.LIST_TYPES.map(t => `<button type="button" data-type="${t.id}"><span class="mk ${t.id}" style="--c:${t.color}"></span><span><b>${esc(t.label)}</b><small>${esc(t.help)}</small></span></button>`).join('');
function paintNewList() { for (const b of $('#nlTypes').children) b.classList.toggle('on', b.dataset.type === newListType); }
function openNewList(type) { newListType = type; $('#nlName').value = ''; paintNewList(); $('#newList').showModal(); $('#nlName').focus(); }
$('#nlTypes').addEventListener('click', e => { const b = e.target.closest('[data-type]'); if (b) { newListType = b.dataset.type; paintNewList(); } });
$('#newList').addEventListener('click', e => { if (e.target === $('#newList')) $('#newList').close(); });
$('#newList').addEventListener('close', () => {
  const name = $('#nlName').value.replace(/\s+/g, ' ').trim();
  if ($('#newList').returnValue !== 'create' || !name) return;
  if (!(window.__lists || []).some(l => l.toLowerCase() === name.toLowerCase())) commit({ type: 'addList', name, ...(newListType === 'tasks' ? {} : { [newListType]: true }) });
  setView('list:' + name);
});
$('#nav').addEventListener('click', navClick);
function curList() { return st.view.startsWith('list:') ? st.view.slice(5) : null; }
function addGroupPrompt() {
  const l = curList(); if (!l) return;
  const name = (prompt('Section name') || '').trim();
  if (name) { freshSecs.add(l + '|' + name); commit({ type: 'addGroup', list: l, name }); }
}
$('#viewTools').addEventListener('click', e => {
  const r = e.target.closest('[data-range]');
  if (r) return setRange(r.dataset.range);
  const l = curList(); if (!l) return;
  const m = e.target.closest('[data-mode]');
  if (m) { prefs.listView[l] = m.dataset.mode; savePrefs(); return render(); }
});
$('#dayStrip').addEventListener('click', e => {
  const d = e.target.closest('[data-day]')?.dataset.day;
  if (!d) return;
  if (st.anchor && d > st.anchor) { st.range = { id: 'custom', from: st.anchor, to: d }; st.anchor = null; }
  else { st.range = { id: 'custom', from: d, to: d }; st.anchor = d; }
  render();
});
$('#list').addEventListener('click', e => {
  if (e.target.closest('#listsBody')) return navClick(e);
  const wider = e.target.closest('.more-after [data-range]');
  if (wider) return setRange(wider.dataset.range);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'fold') {
    const k = e.target.closest('[data-key]').dataset.key;
    prefs.folded = prefs.folded.includes(k) ? prefs.folded.filter(x => x !== k) : [...prefs.folded, k];
    savePrefs(); return render();
  }
  if (act === 'addgroup') return addGroupPrompt();
  if (act === 'hcheck') return toggle(e.target.closest('[data-id]').dataset.id, null); // habit zone: check in place
  if (act === 'hopen') return setView('habits'); // the rest of the habit zone opens the Habits view
  if (act === 'hpin') return openTask(e.target.closest('[data-id]').dataset.id); // a note of the horizon opens its sticky
  if (act === 'hgroup') return setView('stickies'); // a week group opens the Stickies view, sorted by date
  if (act === 'restock') {
    const id = e.target.closest('[data-id]').dataset.id, t = C.findTask(currentDoc(), id)?.task;
    commit({ type: 'reopen', id }); if (t) toast(`To buy · ${t.title.slice(0, 40)}`); return;
  }
  if (act === 'shop') { prefs.shop[curList()] = true; savePrefs(); return render(); }
  if (act === 'shopdone' || act === 'shopcancel') {
    const l = curList();
    const cart = C.allTasks(currentDoc()).filter(x => x.list === l && !x.task.checked && x.task.doing);
    for (const x of cart) commit(act === 'shopdone' ? { type: 'complete', id: x.task.id } : { type: 'update', id: x.task.id, patch: { doing: false } });
    prefs.shop[l] = false; savePrefs(); render();
    if (act === 'shopdone' && cart.length) toast(`${cart.length} back in stock`);
    return;
  }
  if (act === 'tab') { boardTab[curList()] = e.target.closest('[data-group]').dataset.group; return render(); }
  if (act === 'addin') {
    const title = (prompt('New task') || '').trim();
    if (title) { const q = C.parseQuick(title, { today: today(), now: C.nowTimeIn(), lists: window.__lists || [] }); const z = e.target.closest('[data-group]'), v = z.dataset.group, gb = z.dataset.gb || 'section';
      // A + in a column gives the new task the value of that column (story V32).
      const tags = gb === 'tag' && v && !q.tags.some(x => x.toLowerCase() === v.toLowerCase()) ? [v, ...q.tags] : q.tags;
      commit({ type: 'add', id: C.newId(), title: q.title || title, list: curList(), group: gb === 'section' ? v : '', due: q.due, at: q.at, every: q.every, prio: gb === 'priority' ? +v || 0 : q.prio, tags }); }
    return;
  }
  const row = e.target.closest('.task');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('[data-act=check]')) {
    const l = curList();
    if (l && (window.__stock || []).includes(l) && (prefs.shop[l] || C.allTasks(currentDoc()).some(x => x.list === l && !x.task.checked && x.task.doing))) {
      const t = C.findTask(currentDoc(), id)?.task; // shopping mode: a tap puts the item in the cart, or takes it out
      if (t && !t.checked) return commit({ type: 'update', id, patch: { doing: !t.doing } });
    }
    return toggle(id, row);
  }
  openTask(id);
});

// Drag a tile to another column (board) or cell (lanes). Desktop only: touch has no HTML drag.
let dragId = null, dragFrom = null; // dragFrom: the group value of the source zone, so a tag drop knows which tag to replace
$('#list').addEventListener('dragstart', e => { const t = e.target.closest('.task'); if (!t) return; dragId = t.dataset.id; dragFrom = t.closest('[data-drop]')?.dataset.group ?? null; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); t.classList.add('dragging'); });
$('#list').addEventListener('dragend', e => { e.target.closest?.('.task')?.classList.remove('dragging'); document.querySelectorAll('.over').forEach(x => x.classList.remove('over')); dragId = null; });
$('#list').addEventListener('dragover', e => { const z = e.target.closest('[data-drop]'); if (!z || !dragId) return; e.preventDefault(); document.querySelectorAll('.over').forEach(x => x !== z && x.classList.remove('over')); z.classList.add('over'); });
$('#list').addEventListener('drop', e => {
  const z = e.target.closest('[data-drop]'); if (!z || !dragId) return;
  e.preventDefault();
  const f = C.findTask(currentDoc(), dragId); if (!f) return;
  const id = dragId, t = f.task, g = z.dataset.group, s = z.dataset.state, gb = z.dataset.gb || 'section';
  dragId = null;
  const patch = groupPatch(gb, t, dragFrom, g, f.group);
  if (s === 'done') {
    if (Object.keys(patch).length) commit({ type: 'update', id, patch });
    if (!t.checked) toggle(id, null);
    return;
  }
  if (s && t.checked) commit({ type: 'reopen', id });
  if (s && (s === 'doing') !== !!t.doing) patch.doing = s === 'doing';
  if (Object.keys(patch).length) commit({ type: 'update', id, patch });
});
// Phone board: swipe left or right to change section.
let touchX = null;
$('#list').addEventListener('touchstart', e => { touchX = e.target.closest('.board') ? e.touches[0].clientX : null; }, { passive: true });
$('#list').addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) < 60) return;
  const tabs = [...document.querySelectorAll('.board-tabs button')].map(b => b.dataset.group);
  const l = curList(), i = tabs.indexOf(boardTab[l] ?? tabs[0]);
  const j = Math.min(tabs.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)));
  if (j !== i) { boardTab[l] = tabs[j]; render(); }
});

function toggle(id, row) {
  const f = C.findTask(currentDoc(), id);
  if (!f) return;
  const t = f.task;
  if (t.checked) { commit({ type: 'reopen', id }); toast(`Reopened`); return; }
  const prevDue = t.due, prevBy = t.by;
  const habit = (window.__habits || []).includes(f.section.name);
  if (habit && C.habitLog(t).includes(today())) { // done today: a tap takes the check-in back (a tap by mistake)
    commit({ type: 'uncheck', id });
    return toast({ title: plainTitle(t.title), detail: t.streak === 'off' ? 'Unchecked' : `Unchecked · streak ${Math.max(0, (t.streak || 0) - 1)}`, icon: '↺', color: 'var(--ink3)' }, () => commit({ type: 'complete', id, due: today() }));
  }
  const undoHabit = habit ? { streak: t.streak ?? null, notes: t.notes.join('\n') } : {};
  const doIt = () => {
    commit({ type: 'complete', id, due: t.due });
    if (t.every) {
      const next = C.rollForward(t.every, t.due, today());
      const streak = prevDue && prevDue < today() ? 1 : (t.streak || 0) + 1;
      const when = `next ${dayLabel(next, true).toLowerCase()}`;
      toast({ title: habit ? plainTitle(t.title) : t.title, detail: habit && t.streak !== 'off' ? `Streak ${streak} · ${when}` : `Done · ${when}`,
        icon: habit ? habitEmoji(t.title) : '✓', color: listColor(f.section.name) }, () => commit({ type: 'reopen', id, due: prevDue, ...(t.by && !habit ? { by: prevBy } : {}), ...undoHabit }));
    } else toast({ title: t.title, detail: 'Done', icon: '✓', color: listColor(f.section.name) }, () => commit({ type: 'reopen', id }));
  };
  if (row) {
    const chk = row.querySelector('.check');
    // Completion, variant 2 (story V31): the circle pops, a line draws across the title, then the row leaves.
    chk.classList.add('popping');
    row.classList.add('striking');
    setTimeout(() => row.classList.add('leaving'), 380);
    setTimeout(doIt, 650);
  } else doIt();
}

// Toast notification (round 5, variant S): glass card, top right on a computer, bottom right on the phone.
// msg is a string, or { title, detail, icon, color }. With an undo, a floating time bar shows the 4.5 s left.
let toastTimer;
function toast(msg, undo) {
  const m = typeof msg === 'string' ? { title: msg } : msg;
  $('#toastText').textContent = m.title;
  $('#toastDetail').textContent = m.detail || '';
  $('#toastDetail').hidden = !m.detail;
  $('#toastIcon').textContent = m.icon || '✓';
  $('#toast').style.setProperty('--c', m.color || 'var(--ink3)');
  const bar = $('#toastBar'); bar.hidden = !undo;
  bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; // restart the countdown
  $('#toastUndo').hidden = !undo;
  $('#toastUndo').onclick = () => { undo(); $('#toast').hidden = true; };
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

// ---------- edit sheet ----------
let editing = null; // { id, orig, prio, deleted }
const sheet = $('#sheet');
const PRESET = ['', 'day', 'weekday', 'week', '2w', 'month', 'year'];

function paintGroups(list, value) {
  const gs = C.listGroups(currentDoc(), list);
  $('#fGroup').innerHTML = `<option value="">—</option>` + gs.map(g => `<option ${g === value ? 'selected' : ''}>${esc(g)}</option>`).join('') + `<option value="__new">+ New section…</option>`;
  $('#fGroup').value = gs.includes(value) ? value : '';
}
// Habits only (story B7): Count keeps the streak; Reminder only writes streak:off. Turning the count back on starts at 0.
function paintStreak(list) {
  const hab = (window.__habits || []).includes(list);
  $('#streakRow').hidden = !hab;
  for (const b of $('#fStreak').children) b.classList.toggle('on', (b.dataset.on === '1') === editing.streakOn);
}
// The Deadline card (stories L9, L11, L15): one block for tasks and stickies. Deadline (by:), Type (Firm or Best effort,
// ~firm), Margin (lead:, hours or days: act by = deadline − margin) and Estimate (est:). With no deadline, Type, Margin and
// Estimate are greyed out, never hidden. A sticky has no start: its Date and Reminder are greyed out.
const MARGINS = ['', '1h', '2h', '4h', '1d', '3d', '7d', '14d', '30d'], ESTS = [0, 10, 20, 30, 60, 120];
const leadStr = t => t.leadH ? t.leadH + 'h' : t.lead ? t.lead + 'd' : '';
const winBy = () => $('#fBy').value ? ($('#fByAt').value ? `${$('#fBy').value}T${$('#fByAt').value}` : $('#fBy').value) : null;
const isStkList = list => (window.__stickies || []).includes(list);
function paintWin(list = $('#fList').value) {
  const type = C.listTypeOf(currentDoc().sections.find(s => s.name === list));
  const stk = isStkList(list), show = type === 'tasks' || stk;
  // Story L24: the Start row, from the core (startRow). « Anytime » stays pressable on a task; on a deadline window it clears the
  // Date (open now). « Not before » needs a Date with a deadline, else a Date and a Reminder hour; the hint says why when it is greyed out.
  const sr = C.startRow({ due: $('#fDue').value || null, at: $('#fAt').value || null, by: $('#fBy').value || null, fixed: editing.fixed }, type);
  for (const b of $('#fFixed').querySelectorAll('button')) { const nb = b.dataset.x === '1'; b.classList.toggle('on', nb === sr.on); b.disabled = !(nb ? sr.notBefore : sr.anytime); }
  $('#fFixedHint').textContent = sr.hint;
  $('#dlBlock').hidden = !show;
  for (const el of [$('#fDue'), $('#fAt'), ...document.querySelectorAll('.quick-dates button')]) el.disabled = stk;
  $('#startRow').title = stk ? 'A sticky has no start: set its Deadline above.' : '';
  if (!show) return;
  const by = $('#fBy').value, off = by ? '' : ' disabled', offE = by || (sr.on && sr.notBefore) ? '' : ' disabled'; // L24: an estimate on a fixed start too
  for (const b of $('#fFirm').children) { b.classList.toggle('on', (b.dataset.f === '1') === editing.firm); b.disabled = !by; }
  const m = MARGINS.includes(editing.margin) ? MARGINS : [...MARGINS, editing.margin];
  $('#fMargin').innerHTML = m.map(v => `<button type="button" data-m="${v}" class="${v === editing.margin ? 'on' : ''}"${off}>${v ? v.replace(/(\d+)([hd])/, '$1 $2') : 'None'}</button>`).join('');
  const e = ESTS.includes(editing.est) ? ESTS : [...ESTS, editing.est].sort((a, b) => a - b);
  $('#fEst').innerHTML = e.map(v => `<button type="button" data-e="${v}" class="${v === editing.est ? 'on' : ''}"${offE}>${v ? C.estLabel(v).replace(/(\d+)([hm])/g, '$1 $2 ').trim() : 'None'}</button>`).join('');
  const t = { due: stk ? null : $('#fDue').value || null, at: !stk && $('#fDue').value && $('#fAt').value || null, fixed: !!editing.fixed, by: winBy(), ...C.parseLead(editing.margin), est: editing.est || null };
  const when = (d, h) => shortDate(d) + (h ? ' · ' + h : '');
  const hint = $('#winHint');
  hint.classList.toggle('warn', !!(t.by && C.tooShort(t)));
  hint.textContent = C.fixedStart(t) ? `Fixed start: opens ${when(t.due, t.at)}${t.est ? ', about ' + C.estLabel(t.est) : ''}. No deadline.`
    : !t.by ? (stk ? 'Set the date not to pass. A margin then gives the act-by date.' : 'Set a deadline to give the task a window: start (Date + Reminder), act by, deadline.')
    : `Act by ${when(C.actBy(t), C.actByTime(t))}.`
      + (t.due ? ` Window from ${when(t.due, t.at)}.` : stk ? (t.lead || t.leadH ? ' The horizon line shows this date, not the deadline.' : ' No margin: the horizon line shows the deadline.') : ' No start: the window opens now.')
      + (C.tooShort(t) ? ` Too short for ${C.estLabel(t.est)}: start earlier.` : '');
}
function paintState() { for (const b of $('#fState').children) b.classList.toggle('on', +b.dataset.s === (editing.doing ? 1 : 0)); }
function markSelected() { document.querySelectorAll('.task.sel').forEach(x => x.classList.remove('sel')); if (editing) document.querySelector(`.task[data-id="${editing.id}"]`)?.classList.add('sel'); }
function openTask(id) {
  const doc = currentDoc();
  const f = C.findTask(doc, id);
  if (!f) return;
  const t = f.task;
  // In the docked panel, opening another task saves the current one first.
  if (sheet.open && editing) saveEdit();
  const shown = t.notes.filter(n => !C.HABIT_LOG_RE.test(n)); // the habit log stays in the file, out of the sheet
  editing = { id, orig: { ...t, lead: leadStr(t) || null, tags: [...t.tags], notes: shown.join('\n'), list: f.section.name, group: f.group, doing: !!t.doing }, prio: t.prio, doing: !!t.doing, deleted: false, items: [] };
  $('#fTitle').value = t.title;
  $('#fDue').value = t.due || '';
  $('#fBy').value = C.byDate(t) || '';
  $('#fByAt').value = C.byTime(t) || '';
  $('#fAt').value = t.at || '';
  const ev = t.every || '';
  $('#fEvery').value = PRESET.includes(ev) ? ev : 'custom';
  $('#fEveryCustom').value = PRESET.includes(ev) ? '' : ev;
  $('#customEveryRow').hidden = PRESET.includes(ev);
  $('#fList').innerHTML = (window.__lists || []).map(l => `<option ${l === f.section.name ? 'selected' : ''}>${esc(l)}</option>`).join('') + `<option value="__new">+ New list…</option>`;
  $('#fTags').value = t.tags.join(', ');
  const ITEM = /^\s*- \[([ xX])\] ?(.*)$/;
  editing.items = shown.filter(l => ITEM.test(l)).map(l => { const m = l.match(ITEM); return { done: m[1] !== ' ', text: m[2] }; });
  $('#fNotes').value = shown.filter(l => !ITEM.test(l)).join('\n').trim();
  $('#sheetCheck').className = 'check big' + (t.checked ? ' on' : '') + (t.prio ? ' p' + t.prio : '');
  editing.streakOn = t.streak !== 'off';
  editing.firm = !!t.firm;
  editing.fixed = !!t.fixed;
  editing.margin = leadStr(t);
  editing.est = t.est || 0;
  paintStreak(f.section.name);
  paintWin(f.section.name);
  paintGroups(f.section.name, f.group);
  paintPrio(); paintDates(); paintChecklist(); paintState();
  $('#moreFields').open = !phone();
  $('#completeBtn').textContent = t.checked ? 'Reopen' : t.every ? 'Done, next one ↻' : 'Mark as done ✓';
  const dock = docked();
  document.body.classList.toggle('panel-open', dock);
  sheet.classList.toggle('docked', dock);
  if (!sheet.open) dock ? sheet.show() : sheet.showModal();
  sheet.scrollTop = 0;
  // Opening focuses the first button (× or ‹ Back); the ring there is noise.
  if (t.title && sheet.contains(document.activeElement)) document.activeElement.blur();
  autoGrow($('#fTitle')); autoGrow($('#fNotes'));
  markSelected();
  if (!t.title) $('#fTitle').focus();
  writeHash();
}
function paintPrio() { for (const b of $('#fPrio').children) b.classList.toggle('on', +b.dataset.p === editing.prio); }
function paintDates() {
  const td = today(), v = $('#fDue').value;
  for (const b of document.querySelectorAll('.quick-dates button')) {
    const d = b.dataset.date;
    const val = d === '' ? '' : d === 'nextweek' ? nextMonday() : C.addDays(td, +d);
    b.classList.toggle('on', val === v);
  }
}
const nextMonday = () => { let d = C.addDays(today(), 1); while (C.weekday(d) !== 1) d = C.addDays(d, 1); return d; };
function paintChecklist() {
  $('#fChecklist').innerHTML = editing.items.map((it, i) =>
    `<div class="item ${it.done ? 'on' : ''}" data-i="${i}"><span class="check ${it.done ? 'on' : ''}"></span><span class="grow">${esc(it.text)}</span><button type="button" class="x" data-x="${i}" aria-label="Remove">×</button></div>`
  ).join('') + `<input class="add-item" id="addItem" placeholder="+ Add checklist item" enterkeyhint="enter">`;
}
function autoGrow(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

$('#fTitle').addEventListener('input', e => autoGrow(e.target));
$('#fNotes').addEventListener('input', e => autoGrow(e.target));
$('#fStreak').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { editing.streakOn = b.dataset.on === '1'; paintStreak($('#fList').value); } });
// These button rows sit inside a <label>: a repaint during the click detaches the button, and the label then forwards the
// click to its first button (None). So the click is cancelled and the repaint waits for the end of the click.
$('#fFixed').addEventListener('click', e => {
  e.preventDefault(); const b = e.target.closest('button'); if (!b || b.disabled) return;
  editing.fixed = b.dataset.x === '1' && !$('#fBy').value; // a window already starts at its Date: no flag to set
  if (!editing.fixed && $('#fBy').value && b.dataset.x === '0') { $('#fDue').value = ''; $('#fAt').value = ''; paintDates(); } // a window with no start: open now
  setTimeout(() => paintWin());
});
$('#fFirm').addEventListener('click', e => { e.preventDefault(); const b = e.target.closest('button'); if (b && !b.disabled) { editing.firm = b.dataset.f === '1'; setTimeout(() => paintWin()); } });
$('#fState').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { editing.doing = b.dataset.s === '1'; paintState(); } });
$('#fGroup').addEventListener('change', e => {
  if (e.target.value !== '__new') return;
  const name = (prompt('Section name') || '').trim();
  if (!name) { e.target.value = editing.orig.group; return; }
  e.target.insertAdjacentHTML('beforeend', `<option>${esc(name)}</option>`);
  e.target.value = name;
});
$('#fTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sheet.close('save'); } });
$('#fPrio').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { editing.prio = +b.dataset.p; paintPrio(); } });
document.querySelector('.quick-dates').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset.date;
  $('#fDue').value = d === '' ? '' : d === 'nextweek' ? nextMonday() : C.addDays(today(), +d);
  if (d === '') $('#fAt').value = '';
  paintDates(); paintWin();
});
$('#fDue').addEventListener('input', () => { paintDates(); paintWin(); });
$('#fAt').addEventListener('input', () => paintWin());
$('#fBy').addEventListener('input', () => { if (!$('#fBy').value) $('#fByAt').value = ''; paintWin(); });
$('#fByAt').addEventListener('input', () => paintWin());
$('#fMargin').addEventListener('click', e => { e.preventDefault(); const b = e.target.closest('button'); if (b && !b.disabled) { editing.margin = b.dataset.m; setTimeout(() => paintWin()); } });
$('#fEst').addEventListener('click', e => { e.preventDefault(); const b = e.target.closest('button'); if (b && !b.disabled) { editing.est = +b.dataset.e; setTimeout(() => paintWin()); } });
$('#fEvery').addEventListener('change', e => { $('#customEveryRow').hidden = e.target.value !== 'custom'; if (e.target.value === 'custom') $('#fEveryCustom').focus(); });
$('#fList').addEventListener('change', e => {
  if (e.target.value !== '__new') return;
  const name = (prompt('List name') || '').trim();
  if (!name) { e.target.value = editing.orig.list; return; }
  e.target.insertAdjacentHTML('afterbegin', `<option>${esc(name)}</option>`);
  e.target.value = name;
});
$('#fList').addEventListener('change', e => { if (e.target.value !== '__new') { paintGroups(e.target.value, ''); paintStreak(e.target.value); paintWin(e.target.value); } });
$('#fChecklist').addEventListener('click', e => {
  const x = e.target.closest('[data-x]');
  if (x) { editing.items.splice(+x.dataset.x, 1); return paintChecklist(); }
  const it = e.target.closest('.item'); if (!it) return;
  const item = editing.items[+it.dataset.i];
  item.done = !item.done;
  paintChecklist();
});
$('#fChecklist').addEventListener('keydown', e => {
  if (e.target.id !== 'addItem' || e.key !== 'Enter') return;
  e.preventDefault();
  const text = e.target.value.trim();
  if (!text) return;
  editing.items.push({ done: false, text });
  paintChecklist();
  $('#addItem').focus();
});
$('#sheetCheck').addEventListener('click', () => { const id = editing.id; editing.skip = true; sheet.close(); saveEdit(); toggle(id, null); });
$('#completeBtn').addEventListener('click', () => $('#sheetCheck').click());
$('#deleteBtn').addEventListener('click', () => {
  const { id, orig } = editing;
  const full = C.findTask(currentDoc(), id)?.task; // with the habit log and streak, which the sheet hides
  editing.deleted = true;
  sheet.close();
  commit({ type: 'delete', id });
  toast('Deleted', () => commit({ type: 'add', id, title: orig.title, list: orig.list, due: orig.due, at: orig.at, every: orig.every, prio: orig.prio, tags: orig.tags, notes: full ? full.notes.join('\n') : orig.notes, streak: full?.streak ?? null, firm: orig.firm, fixed: orig.fixed, by: full?.by ?? null, lead: full ? leadStr(full) || null : null, est: full?.est ?? null }));
});
sheet.addEventListener('close', () => { if (!editing?.skip) saveEdit(); editing = null; document.body.classList.remove('panel-open'); markSelected(); writeHash(); });
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close(); }); // backdrop

function saveEdit() {
  if (!editing || editing.deleted) { editing = null; return; }
  const o = editing.orig;
  let every = $('#fEvery').value === 'custom' ? $('#fEveryCustom').value.trim().toLowerCase() : $('#fEvery').value;
  if (every && !C.isValidEvery(every)) every = o.every; // keep the old rule if the new one is unreadable
  const next = {
    title: $('#fTitle').value.replace(/\s+/g, ' ').trim() || o.title,
    due: $('#fDue').value || null,
    at: ($('#fDue').value && $('#fAt').value) || null,
    every: every || null,
    prio: editing.prio,
    tags: $('#fTags').value.split(/[,\s]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean),
    notes: [$('#fNotes').value.replace(/\s+$/, ''), ...editing.items.map(it => `- [${it.done ? 'x' : ' '}] ${it.text}`)].filter(Boolean).join('\n'),
    list: $('#fList').value,
    group: $('#fGroup').value === '__new' ? o.group : $('#fGroup').value,
    doing: editing.doing,
    streak: !$('#streakRow').hidden && !editing.streakOn ? 'off' : o.streak === 'off' && editing.streakOn ? null : o.streak,
    firm: editing.firm,
    fixed: !!editing.fixed, // L24: the core drops it when it would do nothing (no hour, a deadline, not a task list)
    lead: editing.margin || null,
  };
  if (!$('#dlBlock').hidden) { next.by = winBy(); next.est = next.by || next.fixed ? editing.est || null : null; if (!next.by) { next.lead = null; next.firm = false; } }
  if (isStkList(next.list)) { next.due = o.due ?? null; next.at = o.at ?? null; } // a sticky has no start: its greyed Date stays as it was
  const patch = {};
  for (const k of Object.keys(next)) {
    const a = JSON.stringify(next[k] ?? null), b = JSON.stringify(o[k] ?? null);
    if (a !== b) patch[k] = next[k];
  }
  if (patch.list && !('group' in patch)) patch.group = next.group; // a moved task keeps the section picked for its new list
  const id = editing.id;
  editing = null;
  if (Object.keys(patch).length) commit({ type: 'update', id, patch });
}

// ---------- settings ----------
// Appearance: Auto follows the system theme; Light and Dark force one.
function applyTheme(v) {
  const root = document.documentElement;
  if (v === 'light' || v === 'dark') root.dataset.theme = v; else { delete root.dataset.theme; v = 'auto'; }
  LS.set('theme', v);
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m, i) => m.content = v === 'auto' ? ['#ffffff', '#111113'][i] : v === 'dark' ? '#111113' : '#ffffff');
  document.querySelectorAll('#themePick button').forEach(b => b.classList.toggle('on', b.dataset.theme === v));
}
$('#themePick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) applyTheme(b.dataset.theme); });
applyTheme(LS.get('theme', 'auto'));
// Settings and How it works are pages (stories S9, S6): « ‹ Back » returns to the view each one was opened from.
const PAGES = ['settings', 'help'];
const backTo = {};
function openPage(v) { if (st.view !== v) { backTo[v] = st.view; setView(v); } }
const closePage = () => setView(backTo[st.view] || 'agenda');
function openSettings() {
  $('#sToken').value = cfg.token; $('#sRepo').value = cfg.repo; $('#sBranch').value = cfg.branch; $('#sPath').value = cfg.path;
  openPage('settings');
}
$('#settingsBtn').addEventListener('click', () => st.view === 'settings' ? closePage() : openSettings());
$('#backSettings').addEventListener('click', closePage);
$('#settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  const old = cfg;
  cfg = { token: $('#sToken').value.trim(), repo: $('#sRepo').value.trim() || DEFAULTS.repo, branch: $('#sBranch').value.trim() || DEFAULTS.branch, path: $('#sPath').value.trim() || DEFAULTS.path };
  LS.set('cfg', cfg);
  $('#sStatus').textContent = '';
  // Another token or file: drop the cached copy and the queued ops, so they never land in the wrong file.
  if (cfg.token !== old.token || cfg.repo !== old.repo || cfg.path !== old.path || cfg.branch !== old.branch) {
    for (const k of ['text', 'sha', 'etag', 'pending']) LS.set(k, k === 'pending' ? [] : k === 'text' ? '' : null);
    return location.reload();
  }
  sync();
  toast('Settings saved');
});
$('#clearDoneBtn').addEventListener('click', () => {
  commit({ type: 'clearDone', before: C.addDays(today(), -30) });
  toast('Old done tasks cleared');
});
$('#syncBtn').addEventListener('click', () => sync());
$('#optsBtn').addEventListener('click', () => { st.optsOpen = !st.optsOpen; paintViewOpts(); });
$('#viewOpts').addEventListener('click', e => {
  const b = e.target.closest('[data-opt]'); if (!b || b.disabled) return;
  const k = b.dataset.opt, v = b.dataset.v, l = st.optList;
  if (k === 'group') prefs.groupBy[l] = v;
  else if (k === 'sort') prefs.sortBy[l] = v;
  else if (k === 'empty') prefs.showEmpty[l] = !prefs.showEmpty[l];
  else if (k === 'done') prefs.showDone[l] = !prefs.showDone[l];
  else if (k === 'preview' || k === 'density') prefs[k] = +v;
  else prefs.chips[k] = !prefs.chips[k];
  savePrefs(); render();
});

// ---------- help ----------
const openHelp = () => openPage('help');
$('#sHowTo').addEventListener('click', openHelp);
$('#demoHelp').addEventListener('click', openHelp);
$('#sHelp').addEventListener('click', openHelp);
$('#demoReset').addEventListener('click', async () => { await loadDemo(true); render(); toast('Demo reset'); });
$('#demoConnect').addEventListener('click', openSettings);

// ---------- no zoom (story V28) ----------
// iOS Safari ignores user-scalable=no, so block its pinch gesture; on a computer, a trackpad pinch arrives as a wheel event with ctrlKey.
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

// The docked panel never stays open behind other work (story E6), but it closes only when you mean it (2026-10-11).
// A click on an item (a task, a habit row, a sticky pill, a habit tile) fills the panel with it or acts on it: one click, no close.
// The header, the sidebar, the tab bar, the + button, the toast and open dialogs work as usual; a change of view closes the panel.
// Any other click (empty space, the habit zone, a group header) only closes the panel: that click does nothing else.
const KEEPS_PANEL = '.task, .hpin, .htile, header.top, #nav, #tabbar, #fab, #viewOpts, .toast, dialog[open]';
document.addEventListener('pointerdown', e => {
  if (!sheet.open || !sheet.classList.contains('docked')) return;
  if (sheet.contains(e.target) || e.target.closest(KEEPS_PANEL)) return;
  sheet.close();
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
  addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', swallow, true), 700); // a press with no click (a drag) leaves nothing behind
}, true);

// ---------- command palette (story L25, round 1 choice B) ----------
// One search over every list: the lists that match (Go to), the open tasks, then the done ones, then « Add … to Inbox ».
// Adding by hand is rare (Claude adds most tasks), so the add row is the last one and takes the text as typed, into Inbox.
const pal = $('#palette');
let palSel = 0, palItems = [];
function hlq(text, q) {
  const f = C.fold(text), words = C.fold(q).split(/\s+/).filter(Boolean);
  if (!words.length || f.length !== text.length) return esc(text);
  const on = new Array(text.length).fill(false);
  for (const w of words) { const re = new RegExp(C.wordStart(w).source, 'g'); let m; while ((m = re.exec(f))) { const i = m.index + m[1].length; for (let k = i; k < i + w.length; k++) on[k] = true; if (re.lastIndex === m.index) re.lastIndex++; } }
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) { if (on[i] !== open) { out += on[i] ? '<mark>' : '</mark>'; open = on[i]; } out += esc(text[i]); }
  return out + (open ? '</mark>' : '');
}
function noteHit(t, q) {
  const words = C.fold(q).split(/\s+/).filter(Boolean), line = t.notes.find(n => words.some(w => C.wordStart(w).test(C.fold(n)))) || '';
  return line.trim().slice(0, 120);
}
function palResults(q) {
  const doc = currentDoc(), words = C.fold(q).split(/\s+/).filter(Boolean), items = [];
  if (!words.length) return items;
  for (const s of doc.sections) if (words.every(w => C.wordStart(w).test(C.fold(s.name)))) items.push({ kind: 'list', name: s.name });
  for (const r of C.searchTasks(doc, q).slice(0, 50)) items.push({ kind: 'task', r });
  items.push({ kind: 'add', title: q.trim() });
  return items;
}
function paintPalette() {
  const q = $('#palInput').value, doc = currentDoc();
  palItems = palResults(q);
  palSel = Math.max(0, Math.min(palSel, palItems.length - 1));
  let h = '', sec = null;
  palItems.forEach((it, i) => {
    const k = it.kind === 'list' ? 'Lists' : it.kind === 'add' ? 'New task' : it.r.task.checked ? 'Done' : 'Tasks';
    if (k !== sec) { h += `<div class="pal-sec">${k}</div>`; sec = k; }
    const sel = i === palSel ? ' sel' : '';
    if (it.kind === 'list') {
      const s = doc.sections.find(x => x.name === it.name);
      h += `<button type="button" class="pal-item${sel}" data-i="${i}" role="option"><span class="pal-ck pal-go" style="--c:${listColor(it.name)}"></span><span class="pal-b"><span class="pal-t">Go to ${hlq(it.name, q)}</span></span><span class="pal-w">${C.allTasks({ sections: [s] }).filter(x => !x.task.checked).length} open</span></button>`;
    } else if (it.kind === 'add') {
      h += `<button type="button" class="pal-item${sel}" data-i="${i}" role="option"><span class="pal-ck pal-plus">+</span><span class="pal-b"><span class="pal-t">Add « ${esc(it.title)} »</span></span><span class="pal-w">Inbox</span></button>`;
    } else {
      const x = it.r, t = x.task, d = t.checked ? null : dueOf(x);
      const meta = [x.list, t.checked ? (t.done ? 'done ' + dayLabel(t.done) : 'done') : d ? dayLabel(d) + (t.at ? ' · ' + t.at : '') : ''].filter(Boolean).join(' · ');
      h += `<button type="button" class="pal-item${sel}${t.checked ? ' done' : ''}" data-i="${i}" role="option"><span class="pal-ck${t.checked ? ' pal-done' : ''}" style="--c:${listColor(x.list)}"></span><span class="pal-b"><span class="pal-t">${hlq(t.title, q)}</span>${x.inNote ? `<span class="pal-n">${hlq(noteHit(t, q), q)}</span>` : ''}</span><span class="pal-w">${esc(meta)}</span></button>`;
    }
  });
  $('#palList').innerHTML = h || `<div class="pal-empty">Type a few letters of a task or a list.</div>`;
}
// The phone card sits on the keyboard (round 2, choice C): the keyboard height and the visible height come from visualViewport.
function palFit() {
  const vv = window.visualViewport; if (!vv) return;
  pal.style.setProperty('--kb', Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px');
  pal.style.setProperty('--vvh', vv.height + 'px');
}
window.visualViewport?.addEventListener('resize', () => { if (pal.open) palFit(); });
window.visualViewport?.addEventListener('scroll', () => { if (pal.open) palFit(); });
function openPalette() {
  if (pal.open) return $('#palInput').focus();
  $('#palInput').value = ''; palSel = 0; paintPalette();
  pal.showModal(); palFit(); $('#palInput').focus();
}
function palPick(i) {
  const it = palItems[i]; if (!it) return;
  pal.close();
  if (it.kind === 'list') return setView('list:' + it.name);
  if (it.kind === 'add') { if (it.title) { commit({ type: 'add', id: C.newId(), title: it.title, list: 'Inbox' }); toast('Added to Inbox'); } return; }
  setView('list:' + it.r.list); // the task opens where it lives
  openTask(it.r.task.id);
  document.querySelector(`#list .task[data-id="${it.r.task.id}"]`)?.scrollIntoView({ block: 'center' });
}
function palMove(d) {
  if (!palItems.length) return;
  palSel = (palSel + d + palItems.length) % palItems.length;
  for (const b of $('#palList').querySelectorAll('.pal-item')) b.classList.toggle('sel', +b.dataset.i === palSel);
  $('#palList').querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
}
$('#palInput').addEventListener('input', () => { palSel = 0; paintPalette(); });
$('#palInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); palPick(palSel); }
});
$('#palList').addEventListener('click', e => { const b = e.target.closest('.pal-item'); if (b) palPick(+b.dataset.i); });
$('#palList').addEventListener('pointermove', e => { const b = e.target.closest('.pal-item'); if (b && +b.dataset.i !== palSel && e.pointerType === 'mouse') { palSel = +b.dataset.i; palMove(0); } });
$('#palCancel').addEventListener('click', () => pal.close());
pal.addEventListener('click', e => { if (e.target === pal) pal.close(); }); // a click or a tap on the dim page around the card closes it

// ---------- keyboard ----------
// The « Group by » menu closes on a click outside it or on Esc.
// View options closes on a click outside it or on Esc.
document.addEventListener('click', e => { if (st.optsOpen && e.target.isConnected && !e.target.closest('#viewOpts, #optsBtn')) { st.optsOpen = false; paintViewOpts(); } });
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return pal.open ? pal.close() : openPalette(); } // story L25, from anywhere
  if (e.target.matches('input, textarea, select')) return;
  if (st.optsOpen && e.key === 'Escape') { st.optsOpen = false; return paintViewOpts(); }
  // Docked panel: Esc closes, arrows move to the previous or next task.
  if (sheet.open && sheet.classList.contains('docked')) {
    if (e.key === 'Escape') { e.preventDefault(); return sheet.close(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...document.querySelectorAll('#list .task')];
      const i = rows.findIndex(r => r.dataset.id === editing?.id);
      const n = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (n) { e.preventDefault(); openTask(n.dataset.id); n.scrollIntoView({ block: 'nearest' }); }
      return;
    }
  }
  if (document.querySelector('dialog[open]:not(.docked)')) return;
  if (e.key === 'n') { e.preventDefault(); openAdd(); }
  if (e.key === '/') { e.preventDefault(); openPalette(); } // story L25: / searches, n adds
  // 1 to 5 pick an Agenda range; m opens Matrix.
  const r = RANGES[+e.key - 1];
  if (r && /^[1-5]$/.test(e.key)) setRange(r.id);
  if (e.key === 'm') setView('matrix');
});

// ---------- URL anchor (story L6): the state lives in the hash, so a reload restores it and a link opens it ----------
// #agenda, #agenda/week, #agenda/2026-10-12, #agenda/2026-10-12..2026-10-15, #habits, #matrix, #lists, #done, #settings, #help,
// #list/life, #list/work/board; any of them + /task/<id> opens a task. An unknown hash is replaced by the current state.
const slug = n => n.toLowerCase().trim().replace(/\s+/g, '-');
const YMD = /^\d{4}-\d{2}-\d{2}$/;
let hashView = null, hashTask = null, hashRetry = false; // hashRetry: a list anchor read before the file was loaded
function stateHash() {
  const v = st.view;
  let h = v;
  if (v === 'agenda') {
    const r = st.range;
    if (r.id === 'custom') h += '/' + (r.from === r.to ? r.from : r.from + '..' + r.to);
    else if (r.id !== '3d') h += '/' + r.id;
  } else if (v.startsWith('list:')) {
    const l = v.slice(5), m = listMode(l);
    h = 'list/' + encodeURIComponent(slug(l)) + (m !== 'list' && !phone() ? '/' + m : '');
  }
  if (editing && sheet.open) h += '/task/' + editing.id;
  return '#' + h;
}
function writeHash() {
  const h = stateHash();
  if (h === location.hash) return;
  // A new view or a task that opens adds a history entry, so Back closes the task, then returns to the last view.
  const push = hashView !== null && (hashView !== st.view || (h.includes('/task/') && !location.hash.includes('/task/')));
  try { history[push ? 'pushState' : 'replaceState'](null, '', h); } catch {}
  hashView = st.view;
}
// Reads the hash into the state. Returns false when the hash names nothing known (an old link, a deleted list).
function readHash() {
  let h = decodeURIComponent(location.hash.slice(1));
  if (!h) return false;
  hashTask = null;
  const ti = h.indexOf('/task/');
  if (ti >= 0) { hashTask = h.slice(ti + 6); h = h.slice(0, ti); }
  const [head, a, b] = h.split('/');
  if (['habits', 'stickies', 'matrix', 'lists', 'done', 'settings', 'help'].includes(head)) st.view = head;
  else if (head === 'agenda') {
    st.view = 'agenda'; st.anchor = null; st.range = { id: '3d' };
    if (a && RANGES.some(x => x.id === a)) st.range = { id: a };
    else if (a) { const [f, t = f] = a.split('..'); if (YMD.test(f) && YMD.test(t) && f <= t) st.range = { id: 'custom', from: f, to: t }; }
  } else if (head === 'list' && a) {
    const l = currentDoc().sections.map(x => x.name).find(x => slug(x) === a.toLowerCase());
    if (!l) { hashRetry = !currentDoc().sections.length; return false; }
    st.view = 'list:' + l;
    if (b && MODES.some(x => x.id === b)) { prefs.listView[l] = b; savePrefs(); }
  } else return false;
  if (st.view !== 'settings' && st.view !== 'help') LS.set('view', st.view);
  hashView = st.view;
  return true;
}
// Opens the task named in the hash once the file holds it (the demo and the first sync load late).
function openHashTask() {
  if (!hashTask) return;
  if (C.findTask(currentDoc(), hashTask)) { const id = hashTask; hashTask = null; if (!(editing && editing.id === id)) openTask(id); }
}
window.addEventListener('popstate', () => {
  if (!readHash()) { try { history.replaceState(null, '', stateHash()); } catch {} return; }
  if (sheet.open && !hashTask) sheet.close();
  render(); openHashTask();
});

// ---------- lifecycle ----------
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
// Near real time: poll every 10 s while the app is visible. Unchanged → 304, free.
setInterval(() => { if (document.visibilityState === 'visible' && !st.pending.length && !st.syncing) sync(); }, 10_000);
// Midnight rolls "Today" over.
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { lastDay = today(); DEMO ? loadDemo().then(render) : render(); } }, 30_000);
// Story L27: an Anytime task sits at the current hour. When the hour of an open task of today passes, that task moves above
// the Anytime ones: render again, unless the edit panel is open (the next change or sync sorts it).
let lastHm = C.nowTimeIn();
setInterval(() => {
  const hm = C.nowTimeIn(), td = today(), was = lastHm; lastHm = hm;
  if (hm < was || document.visibilityState !== 'visible' || editing) return;
  if (C.allTasks(currentDoc()).some(x => !x.task.checked && x.task.due === td && x.task.at && x.task.at > was && x.task.at <= hm)) render();
}, 30_000);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

readHash();
if (DEMO) { $('#demoBar').hidden = false; setStatus('off'); loadDemo().then(render); }
render();
if (!DEMO) sync();
