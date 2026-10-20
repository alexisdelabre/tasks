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
// Release channel (story M6): deploy.sh stamps it in index.html: stable, beta or beta-<name>.
// A beta channel keeps its own copy of the file and its own offline queue, so a beta edit never waits in the stable app.
const CHANNEL = document.querySelector('meta[name="tasks-channel"]')?.content || 'stable';
const BETA = CHANNEL !== 'stable';
const CH = BETA ? CHANNEL + '.' : '';
const K = k => (DEMO ? 'demo.' : '') + CH + k;
// The mark of the version: the channel on beta, « dev » on the local dev server (a sky-blue line and pill), none on stable.
// Tests and frames set tasks.nodev (or tasks.e2e) to see the app as stable. The dev mark changes no storage key: CH stays ''.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const MARK = BETA ? CHANNEL : LOCAL && !LS.get('nodev', false) && !LS.get('e2e', false) ? 'dev' : '';
if (MARK) document.documentElement.dataset.channel = MARK;
// Feature flags (story M6): one switch per flag in Settings › Beta features, kept per device, off by default (beta: true: on in beta and dev).
// A flag is temporary: when the feature is kept or dropped, delete the flag. <html data-flags> lists the flags that are on, for CSS.
const FLAGS = [
  // { id: 'L12', name: 'Calendar view', since: '2026-10-20' },
  { id: 'L30', name: 'Notes mark at the top right, with a peek', since: '2026-10-15' },
  { id: 'L23', name: 'Can start now, one task at a time', since: '2026-10-15' },
  { id: 'L34', name: 'Sidebar width: drag its edge', since: '2026-10-16' },
  { id: 'L35', name: 'Centered column and widget rail', since: '2026-10-19', beta: true },
];
// The test flag X0 exists only for e2e-channels.mjs: on localhost, with tasks.e2e set, so the frames never show it.
if (location.hostname === 'localhost' && LS.get('e2e', false)) FLAGS.push({ id: 'X0', name: 'Test flag (local only)', since: '2026-10-15' });
const flagState = LS.get('flags', {});
// A flag with beta: true starts on in a beta channel and on the dev server (MARK), off in stable and in a test browser
// (navigator.webdriver, set by scripts/dev-up.sh); its switch still wins (2026-10-20).
const flagOn = id => { const f = FLAGS.find(x => x.id === id); return !!f && !!(flagState[id] ?? (f.beta && MARK && !navigator.webdriver)); };
const applyFlags = () => { document.documentElement.dataset.flags = FLAGS.filter(f => flagOn(f.id)).map(f => f.id.toLowerCase()).join(' '); };
applyFlags();
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
    if (t.every && t.due && WEEKDAY_RULE.test(t.every)) { const d = C.nextOccurrence(t.every, C.addDays(t.due, -1)); if (d !== t.due) C.apply(doc, { type: 'update', id: t.id, patch: { due: d, ...(t.by && !t.links?.length ? { by: C.moveBy('day', t.due, d, t.by) } : {}) } }, td); }
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
  flag: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>', // a project deadline (story L10)
  notes: '<path d="M5 7h14M5 12h14M5 17h9"/>', // three lines, the last one shorter (story L30)
  // The Agenda icon is a calendar page with today's day number (agendaIcon).
  habits: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.2 2.7 2.7 5-5.4"/>', // the habit ring, checked
  matrix: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 3.5v17M3.5 12h17"/>', // one square cut in four, unlike the Lists tiles
  stickies: '<path d="M5 4h14v10.5L13.5 20H5z"/><path d="M13.5 20v-5.5H19"/>', // a note with a folded corner (story L9)
  lists: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
};
// The Done entry of the sidebar: a 17 px check drawn like the other icons; the ✓ glyph read too small (2026-10-20).
const doneIcon = '<svg class="done-ico" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 4.8 4.8L19.5 7"/></svg>';
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
// Story L30 (flag): a task with notes gets the lines glyph at the top right of its tile, in place of the ✎ chip.
// A hover (or keyboard focus) on it shows the notes in a dark bubble, up to 8 lines; a click goes on to the tile and opens the panel.
const hasNotes = t => t.notes.some(n => n.trim() && !C.HABIT_LOG_RE.test(n));
function notesMark(t) {
  const lines = t.notes.map(n => n.trim()).filter(n => n && !C.HABIT_LOG_RE.test(n));
  if (!lines.some(n => !/^- \[[ xX/]\]/.test(n))) return ''; // a checklist only: its ☑ chip already says it
  const show = lines.slice(0, 8).map(n => { const m = n.match(/^- \[([ xX/])\]\s*(.*)$/); return `<span>${m ? (m[1] === ' ' ? '☐ ' : '☑ ') + esc(m[2]) : esc(n)}</span>`; }).join('');
  return `<span class="nmark" tabindex="0" aria-label="Notes">${icon(ICON.notes, 15)}<span class="nbub" role="tooltip"><b>Notes</b>${show}${lines.length > 8 ? '<i>Open the task for the rest</i>' : ''}</span></span>`;
}
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
  else if (!flagOn('L30') && hasNotes(t)) chips.push(`<span class="chip">✎</span>`);
  if (showList) chips.push(`<span class="chip lchip"><span class="swatch" style="background:${listColor(list)}"></span>${esc(list)}</span>`);
  if (ch.tags) for (const tag of t.tags) if (tag !== hideTag) chips.push(`<span class="chip tag">#${esc(tag)}</span>`);
  if (t.checked && t.done) chips.push(`<span class="chip">✓ ${esc(dayLabel(t.done))}</span>`);
  // A window task (story L15): « window too short » in amber when start + estimate passes act by.
  const ph = !stk && (t.by || C.fixedStart(t, listTypeByName(list))) && !t.checked ? C.phase(t) : null; // L24: a fixed start fades before it opens
  if (ph && ph !== 'missed' && C.tooShort(t)) chips.push(`<span class="chip warn">Window too short · ${C.estLabel(t.est)}</span>`);
  if (!stk && t.by && t.firm && !t.checked) chips.push(`<span class="chip firm">Firm</span>`); // a task deadline can be firm too
  if (t.links?.length && !t.checked) chips.push(...linkChips(t));
  const bar = !stk && t.by ? winBar(t, ph) : '';
  const prev = prefs.preview && !t.checked ? notesPreview(t) : '';
  const sel = editing && editing.id === t.id ? ' sel' : '';
  const cart = opts_cart(t, list);
  return `<div class="task${t.checked ? ' done' : ''}${cart ? ' cart' : ''}${ghost ? ' ghost' : ''}${ph ? ' win-' + ph : ''}${sel}" data-id="${t.id}" style="--lc:${listColor(list)}"${drag ? ' draggable="true"' : ''}>
    <button class="check${stk ? ' stk' : ''}${t.checked || cart ? ' on' : ''}${t.doing && !cart ? ' doing' : ''}${t.prio ? ' p' + t.prio : ''}" data-act="check" aria-label="Complete"></button>
    <div class="body"><div class="ttl"><span class="tt">${esc(t.title) || '<span style="color:var(--ink3)">Untitled</span>'}</span></div>${bar}<div class="meta">${chips.join('')}</div>${prev ? `<div class="npreview" style="-webkit-line-clamp:${prefs.preview}">${esc(prev)}</div>` : ''}</div>${flagOn('L30') ? notesMark(t) : ''}
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
// Story L10 (round 4): one chip per link, « 7 d before ⚑ Marathon ». The link that sets the deadline is in the accent, the
// others grey; a link that cannot resolve says « Link broken » in red (a missing task, a loop, a project with no deadline).
const linkName = l => l.project ? '⚑ ' + l.name : plainTitle(l.name);
const linkText = l => `${l.gap ? l.gap + ' d before' : 'on'} ${linkName(l)}`;
function linkChips(t) {
  const info = t.linkInfo || [];
  return info.map(l => l.ok ? `<span class="chip link${l.win ? ' win' : ''}" title="${esc(linkText(l))}: ${esc(dayLabel(l.date))}">${esc(linkText(l))}</span>`
    : `<span class="chip late" title="${esc(l.ref ? 'The task ^' + l.ref + ' is missing, or the links make a loop.' : 'This list has no project deadline.')}">Link broken</span>`);
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
  if (!flagOn('L30') && hasNotes(t)) chips.push(`<span class="chip">✎</span>`);
  for (const tag of t.tags) chips.push(`<span class="chip tag">#${esc(tag)}</span>`);
  const track = t.streak !== 'off';
  const streak = t.due && t.due < td ? 0 : t.streak || 0;
  const days = track ? `<span class="days" title="Last 7 days">${[6, 5, 4, 3, 2, 1, 0].map(i => `<i class="${log.has(C.addDays(td, -i)) ? 'y' : ''}"></i>`).join('')}</span><span class="streak" title="Streak: check-ins in a row">${streak}</span>` : '';
  const sel = editing && editing.id === t.id ? ' sel' : '';
  return `<div class="task habit${doneToday ? ' done' : ''}${sel}" data-id="${t.id}" data-today="${doneToday ? 1 : 0}" style="--lc:${listColor(list)}">
    <button class="check${doneToday ? ' on' : ''}" data-act="check" aria-label="Done today"></button>
    <div class="body"><div class="ttl">${esc(t.title)}</div><div class="meta">${chips.join('')}</div></div>${flagOn('L30') ? notesMark(t) : ''}${days}
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
// Urgent (story L33): the act-by day is within 7 days, the same day as the Date sort and « Can start now ». A task not open yet
// is not urgent; a late or missed task stays urgent, so it stays in view until it is done or closed.
const isUrgent = (x, soon = C.addDays(today(), 7)) => { const d = C.actBy(x.task); return !!d && d <= soon && winPhase(x) !== 'before'; };
function matrixHTML(rows, showList) {
  const soon = C.addDays(today(), 7);
  const urgent = x => isUrgent(x, soon), important = x => x.task.prio === 1 || x.task.prio === 2;
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
  const g = prefs.preview !== 0 || prefs.density !== 1 || !prefs.chips.tags || !prefs.chips.dates || !prefs.chips.repeat || LS.get('create', 'show') === 'hide';
  return g || (!!l && (groupMode(l) !== 'section' || !!prefs.showEmpty[l] || !!prefs.showDone[l] || (prefs.sortBy[l] || 'date') !== 'date'));
}
function viewOptsHTML() {
  const l = st.optList && st.view === 'list:' + st.optList ? st.optList : null, off = !l;
  const tip = 'Open a task list';
  const groups = l ? C.listGroups(currentDoc(), l) : [];
  const noSec = !l || groupMode(l) !== 'section' || !groups.length;
  return `<div class="vrow"><span class="vlab">Group by</span>${segsHTML('group', GROUP_BY, l ? groupMode(l) : '', off)}<span class="vsp"></span><span class="vlab">Sort</span>${segsHTML('sort', SORTS, l ? prefs.sortBy[l] || 'date' : '', off)}</div>`
    + `<div class="vrow veyes">${eyeHTML('empty', 'Empty sections', !!(l && prefs.showEmpty[l]), noSec, l ? 'Group by Section, in a list with sections' : tip)}${eyeHTML('done', 'Done tasks', !!(l && prefs.showDone[l]), off, tip)}${eyeHTML('tags', 'Tags', prefs.chips.tags)}${eyeHTML('dates', 'Dates', prefs.chips.dates)}${eyeHTML('repeat', 'Repeat', prefs.chips.repeat)}${eyeHTML('create', 'Create buttons', LS.get('create', 'show') !== 'hide')}</div>`
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
const dueOfRow = x => dueOf(x);
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
// Story L10 (round 4): a project deadline joins the line as a flag in the project color, inside its week group; no text under the line.
function horizonHTML(stickies, td, projects = []) {
  const days = d => Math.max(0, Math.round((C.fromYmd(d) - C.fromYmd(td)) / 864e5));
  const dueOf = x => x.proj ? x.proj.by : dueOfRow(x);
  const on = [...stickies.filter(x => dueOf(x)), ...projects.filter(s => s.by && s.by >= td).map(s => ({ proj: s, task: { id: 'p:' + s.name, title: s.name, firm: s.firm } }))].sort((a, b) => dueOf(a).localeCompare(dueOf(b)));
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
    const pj = items.find(x => x.proj);
    const cls = `hpin${n <= 7 ? ' hot' : ''}${items.some(x => x.task.lead) ? ' act' : ''}${items.some(x => x.task.firm) ? ' firm' : ''}${many ? ' stack' : ''}${pj ? ' proj' : ''}`;
    const names = items.map(x => `<span><b>${x.task.lead ? 'Act ' : ''}J-${jx(x)}</b>${x.proj ? '⚑ ' : ''}${esc(plainTitle(x.task.title))}</span>`).join('');
    const what = items[0].task.lead ? `act by ${esc(dayLabel(dueOf(items[0]), true))}` : esc(dayLabel(dueOf(items[0]), true));
    const label = many ? `${items.length} stickies, the nearest in ${n} days` : `${esc(items[0].task.title)}, ${late ? 'late' : `in ${n} days`}, ${what}`;
    if (pj) return `<span class="hz-true" data-x="${pos(n)}"></span><button class="${cls}" data-act="hproj" data-list="${esc(pj.proj.name)}" data-x="${pos(n)}" style="--pc:${listColor(pj.proj.name)}" aria-label="${esc(items.map(x => (x.proj ? 'Project ' : '') + x.task.title).join(', '))}, the nearest in ${n} days">${icon(ICON.flag, 12)}<b>${n}</b>${many ? `<span class="hbdg">${items.length}</span>` : ''}<span class="hname">${names}</span></button>`;
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
function habitParts(rows) {
  const td = today(), now = hourOf(C.nowTimeIn());
  const done = x => C.habitLog(x.task).includes(td);
  const soon = x => { const [a, b] = habitWindow(x); return a <= now + 4 && b > now; };
  const past = x => habitWindow(x)[1] <= now;
  const show = rows.filter(x => soon(x) || (past(x) && !done(x)));
  const later = rows.filter(x => !done(x) && !show.includes(x));
  const m = MOMENTS.find(([, a, b]) => now >= a && now < b) || MOMENTS.find(([, a]) => a > now);
  return { done, past, show, later, m };
}
const habitThin = later => `<button class="hzone thin" data-act="hopen">Habits <span class="rest">${later.length ? later.length + ' later' : '✓'}</span><span class="chev">›</span></button>`;
function habitZone(rows) {
  if (!rows.length) return '';
  const { done, past, show, later, m } = habitParts(rows);
  if (!show.length) return habitThin(later);
  const head = m ? `${m[3]} <span class="when">until ${String(m[2]).padStart(2, '0')}:00</span>` : 'Habits';
  const tile = x => {
    const d = done(x), t = x.task, under = t.tags[0] ? `<span class="hlb tag">#${esc(t.tags[0])}</span>` : `<span class="hlb">${esc(t.at || t.title.replace(/^\p{Extended_Pictographic}️?\s*/u, ''))}</span>`;
    return `<button class="htile${d ? ' done' : ''}${!d && past(x) ? ' carry' : ''}" data-act="hcheck" data-id="${t.id}" style="--lc:${listColor(x.list)}" title="${esc(t.title)}${d ? ' · done today' : ''}"><span class="hsq">${esc(habitEmoji(t.title))}</span>${under}</button>`;
  };
  const ghost = later.length ? `<span class="htile ghost"><span class="hsq">+${later.length}</span><span class="hlb">later</span></span>` : '';
  return `<div class="hzone" data-act="hopen"><div class="hhead">${head}<span class="chev">›</span></div><div class="htiles">${show.map(tile).join('')}${ghost}</div></div>`;
}
// Story L23 (flag L23, round 2 choice E, 2026-10-15): « Can start now ». A task of a task list whose window is open (a deadline,
// and no start or a start passed) lives on its act-by day; when that day is after the range, the range never shows it. With the
// flag, the habit zone of a range that starts today shares its row with these tasks: the habits as dots at the left (30 %), and
// one task at a time at the right, which turns to the next one with a flip. The closer the act-by day, the longer a task stays on
// screen (csSecs). The rotation follows the clock, not the render: the task on screen is a function of Date.now() (csIndex), so a
// return to Agenda, a sync or a reload never starts it over. Story L32 (round 2, C4 + C5): the row is a pile, one button to the page
// « Can start now » (#canstart): a count square, the task of the clock, ›. The rotation holds every task that can start now, the
// ones already on a day of the range too, so the row is the same in every range that starts today.
// On the day strip, an amber number at the bottom right of a day counts these tasks to do by that day (today left out).
const canStart = x => isWin(x) && C.isTaskType(listTypeByName(x.list)) && winPhase(x) === 'window'; // a project task too (L10, T1)
const daysTo = (d, td) => Math.round((C.fromYmd(d) - C.fromYmd(td)) / 864e5);
const HD_DESK = 4, HD_PHONE = 5; // rounds in the habits part, « +N » included: 4 on a computer, 5 on the phone line
const csSecs = j => Math.max(3, Math.min(12, 84 / (j + 7))); // J-0 12 s, J-3 8.4 s, J-7 6 s, J-16 3.7 s, J-21 and later 3 s
// The act-by day and hour order the row, the page and the weights, not the Agenda day: a started window task sits on today
// in the Agenda (dueOf), but it acts by its own day (story L32, fix of 2026-10-16).
const csDay = x => C.actBy(x.task), csAt = x => C.actByTime(x.task) || '24:00';
const csSort = rows => rows.sort((x, y) => csDay(x).localeCompare(csDay(y)) || csAt(x).localeCompare(csAt(y)) || (x.task.prio || 4) - (y.task.prio || 4) || x.task.id.localeCompare(y.task.id));
function csIndex(rows, td, now = Date.now()) {
  const ms = rows.map(x => csSecs(daysTo(csDay(x), td)) * 1000), cycle = ms.reduce((s, v) => s + v, 0);
  let t = now % cycle, i = 0;
  while (t >= ms[i]) t -= ms[i++];
  return i;
}
let csLast = { rows: [], td: null }; // the rows of the last render, for the rotation timer
const csJ = (x, td) => `J-${daysTo(csDay(x), td)}<span class="cs-jd"> · ${esc(shortDate(csDay(x)))}</span>`; // the phone card keeps J-x only
const csRowHTML = (x, td, extra = '') => `<span class="cs-row" data-id="${x.task.id}" style="--lc:${listColor(x.list)}"><span class="cs-c"></span><span class="cs-t">${esc(x.task.title)}</span><span class="cs-j${daysTo(csDay(x), td) <= 7 ? ' soon' : ''}">${csJ(x, td)}</span>${extra}</span>`;
function canStartHTML(rows, td) {
  const x = rows[csIndex(rows, td)], many = rows.length > 1;
  return `<div class="cs" aria-label="Can start now, ${rows.length}"><div class="cs-head">Can start now <span class="when">· ${rows.length}</span></div>`
    + `<button class="cs-pile${many ? ' many' : ''}" data-act="cspage" aria-label="Can start now: ${rows.length} task${many ? 's' : ''}. Open the list">${many ? '<span class="pl3"></span><span class="pl2"></span>' : ''}`
    + `<span class="cs-card"><span class="cs-cnt">${rows.length}</span><span class="cs-tick" data-cs="${x.task.id}">${csRowHTML(x, td)}</span><span class="cs-chev">›</span></span></button></div>`;
}
// The page « Can start now » (story L32, P1 + G1): every task that can start now, grouped by act-by day, soonest first. A summary
// line gives the count, the sum of the estimates and the soonest act-by; each day header gives J-x and its estimate.
function canStartPage(rows, td) {
  if (!rows.length) return empty('○', 'Nothing to start now.', 'A task with a deadline shows here once its start has passed.');
  const est = rs => rs.reduce((a, x) => a + (x.task.est || 0), 0), first = csDay(rows[0]);
  let html = `<div class="cs-sum meta"><span class="chip">${rows.length} task${rows.length > 1 ? 's' : ''}</span>${est(rows) ? `<span class="chip mono">⏱ ${C.estLabel(est(rows))} in all</span>` : ''}<span class="chip${daysTo(first, td) <= 7 ? ' soon' : ''}">Soonest J-${daysTo(first, td)} · ${esc(dayLabel(first))}</span></div>`;
  for (const d of [...new Set(rows.map(csDay))]) {
    const rs = rows.filter(x => csDay(x) === d), j = daysTo(d, td), e = est(rs);
    html += `<div class="group"><div class="group-h cs-gh${j <= 7 ? ' soon' : ''}">J-${j} · ${esc(dayLabel(d, true))} <span class="n">${rs.length}</span>${e ? `<span class="cs-gsum">${C.estLabel(e)}</span>` : ''}</div><div class="rows">${rs.map(r => taskHTML(r, { showDate: false })).join('')}</div></div>`;
  }
  return html;
}
function canStartZone(habitsDay, rows, td) {
  if (!habitsDay.length) return `<div class="cs-split solo">${canStartHTML(rows, td)}</div>`;
  const { done, past, show, later, m } = habitParts(habitsDay);
  if (!show.length) return habitThin(later) + `<div class="cs-split solo">${canStartHTML(rows, td)}</div>`;
  const left = show.filter(x => !done(x)).length;
  const when = m ? ` · until ${String(m[2]).padStart(2, '0')}:00` : '';
  // At most 4 rounds on a computer (the 30 % part) and 4 dots plus « +N » on the phone line. To do first, done last. « +N » counts
  // the habits left out and the later ones, as the ghost tile of the stable zone; a tap on it opens Habits.
  const order = [...show.filter(x => !done(x)), ...show.filter(done)];
  const fit = cap => order.length + (later.length ? 1 : 0) <= cap ? order.length : cap - 1;
  const fd = fit(HD_DESK), fp = fit(HD_PHONE);
  const ghost = (f, cls) => { const n = order.length - f + later.length; return n ? `<span class="hdot ghost ${cls}" title="${n} more">+${n}</span>` : ''; };
  const dot = (x, i) => { const d = done(x), t = x.task; return `<button class="hdot${d ? ' done' : ''}${!d && past(x) ? ' carry' : ''}${i >= fd ? ' x-d' : ''}${i >= fp ? ' x-p' : ''}" data-act="hcheck" data-id="${t.id}" style="--lc:${listColor(x.list)}" title="${esc(t.title)}${d ? ' · done today' : ''}">${d ? '' : esc(habitEmoji(t.title))}</button>`; };
  const dots = order.map(dot).join('') + ghost(fd, 'g-d') + ghost(fp, 'g-p');
  return `<div class="cs-split"><div class="hmini" data-act="hopen"><span class="hm-t">Habits</span><span class="when">· ${left ? left + ' left' : '✓'}${when}</span><span class="chev">›</span><span class="hdots">${dots}</span></div><div class="cs-div"></div>${canStartHTML(rows, td)}</div>`;
}
function agendaHTML(tasks, habitsDay, td) {
  const r = st.range, [a, b] = rangeSpan(r, td);
  const overdue = tasks.filter(x => dueOf(x) && dueOf(x) < td);
  let html = horizonHTML(tasks.filter(x => (window.__stickies || []).includes(x.list)), td, currentDoc().sections.filter(s => s.project));
  const cs = flagOn('L23') && a === td && b ? csSort(tasks.filter(canStart)) : [];
  csLast = { rows: cs, td };
  // L35: a widget of the rail takes its part out of this zone (Habits now, Can start now).
  const inRail = k => l35.rail && wgs.list.includes(k);
  const zone = cs.length && !inRail('cs') ? (inRail('habits') ? `<div class="cs-split solo">${canStartHTML(cs, td)}</div>` : canStartZone(habitsDay, cs, td)) : inRail('habits') ? '' : habitZone(habitsDay);
  html += a === td ? zone : ''; // a short zone: the agenda keeps its room for the tasks
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
  for (let i = 0; i < (l35.on ? 42 : STRIP_DAYS); i++) { // L35: up to six weeks, fitStrip() keeps the days that fit
    const d = C.addDays(td, i), n = tasks.filter(x => dueOf(x) === d).length;
    const cs = flagOn('L23') && i ? tasks.filter(x => canStart(x) && csDay(x) === d).length : 0; // L23: to start now, act by that day
    const cls = d === a || d === b ? 'end' : d > a && d < b ? 'in' : '';
    const wd = C.fromYmd(d).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2);
    h += `<button data-day="${d}" class="${cls}${C.weekday(d) === 1 && i ? ' wk' : ''}" aria-label="${esc(dayLabel(d, true))}${n ? `, ${n} task${n > 1 ? 's' : ''}` : ''}${cs ? `, ${cs} to start now` : ''}"><span class="w">${wd}</span><span class="dn">${+d.slice(8)}</span><span class="dots">${'<i></i>'.repeat(Math.min(n, 3))}</span>${cs ? `<span class="csb">${cs}</span>` : ''}</button>`;
  }
  const tip = st.anchor ? `From ${shortDate(st.anchor)}: tap the last day.` : 'Tap a day, then another day for a range.';
  return `<div class="strip">${h}</div><div class="strip-tip">${esc(tip)}</div>`;
}
// L35: the strip fills the width of the centered column with whole days, and changes with it.
function fitStrip() {
  const s = $('#dayStrip .strip');
  if (!l35.on || !s) return;
  const r = s.getBoundingClientRect().right;
  for (let b = s.lastElementChild; b && b.getBoundingClientRect().right > r + .5; b = s.lastElementChild) b.remove();
}
function setRange(id) {
  if (st.view !== 'agenda') { st.view = 'agenda'; LS.set('view', 'agenda'); window.scrollTo(0, 0); }
  st.range = { id }; st.anchor = null; render(); window.scrollTo(0, 0);
}

function render() {
  if (hashRetry && currentDoc().sections.length) { hashRetry = false; readHash(); }
  l35Apply();
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
    matrix: tasks.filter(x => isUrgent(x, C.addDays(td, 7)) && (x.task.prio === 1 || x.task.prio === 2)).length,
  };
  const typeOf = l => C.listTypeOf(doc.sections.find(s => s.name === l));
  const countOf = l => (typeOf(l) === 'habits' ? habitsNow : open).filter(x => x.list === l).length;
  let nav = `<div class="brand">Tasks${MARK ? ` <span class="chan">${esc(MARK)}</span>` : ''}</div>`;
  // Story L31: no New task button; the palette (and the n key) add a task.
  nav += `<button class="add-task search-btn" data-act="search" title="Search tasks and lists (/ or ⌘K)"><span class="ico"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>Search<kbd>⌘K</kbd></button>`;
  nav += VIEWS.map(v => `<button data-view="${v.id}" class="${st.view === v.id ? 'on' : ''}"><span class="ico">${v.id === 'stickies' ? '<span class="stk-ico"></span>' : v.ico || agendaIcon(17)}</span>${v.label}<span class="count ${v.id === 'agenda' && late ? 'late' : ''}">${counts[v.id] || ''}</span></button>`).join('');
  nav += `<div class="sep"></div>` + listsNav(lists, typeOf, countOf) + `<div class="sep"></div>`;
  nav += `<button data-view="done" class="${st.view === 'done' ? 'on' : ''}"><span class="ico">${doneIcon}</span>Done</button>`;
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
    + listsNav(lists, typeOf, countOf, false) + `<div class="sep"></div><button data-view="done" class="${st.view === 'done' ? 'on' : ''}"><span class="ico">${doneIcon}</span>Done</button><button data-act="newlist" class="newlist"><span class="ico">+</span>New list</button>`;

  railCtx = { all, open, tasks, habits, td, doc, stockLists };
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
  } else if (v === 'canstart') {
    title = 'Can start now'; sub = 'Soonest act-by first';
    html = canStartPage(csSort(tasks.filter(canStart)), td);
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
    else if (typeOf(l) === 'project' && mode === 'list') { html = projectHead(doc.sections.find(s => s.name === l), rows, td) + (groups.length ? sectionsHTML(l, rows, groups) : group('Steps', [...rows].sort((a, b) => (dueOf(a) || '9').localeCompare(dueOf(b) || '9')), { showList: false })); sub = 'Project'; }
    else if (mode === 'board') { html = boardHTML(l, rows, groups); wide = true; }
    else if (mode === 'lanes') { html = lanesHTML(l, all.filter(x => x.list === l), groups); wide = true; }
    else if (mode === 'matrix') { html = matrixHTML(rows.filter(x => !x.task.checked), false); wide = true; }
    else html = sectionsHTML(l, rows, groups);
    if (!rows.length && !groups.length && mode !== 'lanes' && !special) html = empty('○', 'This list is empty.', '') + `<button class="add-sec" data-act="addgroup">+ Section</button>`;
  }
  $('#viewTools').innerHTML = tools;
  $('#dayStrip').innerHTML = strip;
  $('#dayStrip').hidden = !strip;
  fitStrip();
  document.querySelector('main').classList.toggle('wide', wide);
  // List views center the title and the view switch: main stays centered at every width, so they keep their place when the view changes.
  document.querySelector('main').classList.toggle('centered', st.view.startsWith('list:'));
  document.querySelector('main').classList.toggle('no-tools', !tools);
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub || (st.view.startsWith('list:') ? '' : '');
  $('#list').innerHTML = html;
  $('#settings').hidden = v !== 'settings';
  $('#help').hidden = v !== 'help';
  $('#backSettings').hidden = !PAGES.includes(v) && v !== 'canstart'; // L32: the page « Can start now » has Back too
  document.body.classList.toggle('on-settings', PAGES.includes(v));
  $('#settingsBtn').classList.toggle('on', v === 'settings');
  document.title = `Tasks${MARK ? ' · ' + MARK : ''}${counts.agenda ? ` (${counts.agenda})` : ''}`;
  updatePreview();
  paintRail();
  if (!v.startsWith('list:')) st.optList = null;
  paintViewOpts();
  layoutHorizon();
  if (hashTask) setTimeout(openHashTask); else if (!hashRetry) writeHash(); // keep the anchor until the file can resolve it
}
// Story L10 (round 4): the head of a project page. The flag in the project color, the deadline (a date field: the change moves
// every linked task), Firm or Best effort, the J-x count, the number of steps, the sum of the estimates and the next act-by day.
function projectHead(s, rows, td) {
  const open = rows.filter(x => !x.task.checked), n = s.by ? daysTo(s.by, td) : null;
  const est = open.reduce((a, x) => a + (x.task.est || 0), 0), noEst = open.filter(x => !x.task.est).length;
  const next = open.filter(x => dueOf(x)).sort((a, b) => dueOf(a).localeCompare(dueOf(b)))[0];
  const broken = open.filter(x => x.task.linkBroken).length;
  const chips = [`<span class="chip">${open.length} step${open.length === 1 ? '' : 's'}</span>`,
    est ? `<span class="chip mono">⏱ ${C.estLabel(est)}${noEst ? ` · ${noEst} with no estimate` : ''}</span>` : `<span class="chip">No estimate yet</span>`,
    next ? `<span class="chip act${daysTo(dueOf(next), td) <= 7 ? ' late' : ''}">Next: act by ${esc(dayLabel(dueOf(next)))}</span>` : '',
    broken ? `<span class="chip late">${broken} link${broken > 1 ? 's' : ''} broken</span>` : ''].join('');
  return `<div class="proj-head" style="--pc:${listColor(s.name)}"><span class="proj-flag">${icon(ICON.flag, 18)}</span><div class="proj-main">`
    + `<div class="proj-row"><b class="proj-j">${n === null ? 'No deadline' : n < 0 ? 'Passed' : 'J-' + n}</b><label class="proj-by"><span>Deadline</span><input type="date" id="projBy" value="${s.by || ''}" aria-label="Project deadline"></label>`
    + `<div class="prio-pick proj-firm"><button type="button" data-act="projfirm" data-f="1" class="${s.firm ? 'on' : ''}"${s.by ? '' : ' disabled'}>Firm</button><button type="button" data-act="projfirm" data-f="0" class="${s.firm ? '' : 'on'}"${s.by ? '' : ' disabled'}>Best effort</button></div></div>`
    + `<div class="meta">${chips}</div>${s.by ? '' : '<p class="proj-hint">Set the deadline: a step with « by:-7d » takes its date 7 days before it.</p>'}</div></div>`;
}
$('#list').addEventListener('change', e => { if (e.target.id === 'projBy') commit({ type: 'listDeadline', list: st.view.slice(5), by: e.target.value || null }); });
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
  commit({ type: 'add', id: C.newId(), title: q.title, list: q.list, due: q.due, at: q.at, every: q.every, prio: q.prio, tags: q.tags, firm: q.firm, fixed: q.fixed, lead: q.lead, leadH: q.leadH, by: q.by, links: q.links, est: q.est });
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
  if (act === 'cspage') return openPage('canstart'); // L32: the row opens the page, Back returns to the Agenda
  if (act === 'hopen') return setView('habits'); // the rest of the habit zone opens the Habits view
  if (act === 'hpin') return openTask(e.target.closest('[data-id]').dataset.id); // a note of the horizon opens its sticky
  if (act === 'hgroup') return setView('stickies'); // a week group opens the Stickies view, sorted by date
  if (act === 'hproj') return setView('list:' + e.target.closest('[data-list]').dataset.list); // a flag opens its project (L10)
  if (act === 'projfirm') return commit({ type: 'listDeadline', list: st.view.slice(5), firm: e.target.closest('[data-f]').dataset.f === '1' });
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
  const stk = isStkList(list), show = C.isTaskType(type) || stk;
  paintLinks(list);
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
// Story L10 (round 4): the Link rows of the Deadline card, under Deadline. One row per link: « 7 d before ⚑ Marathon (1 Nov) »
// and its result; the earliest is ticked and fills the Deadline field. The last row adds a link: the project deadline or a task
// with a date, and a gap in days. Rows are divs, not labels, so a click never lands on another control of the card.
function linkTargets(list) {
  const doc = currentDoc(), s = doc.sections.find(x => x.name === list), opts = [];
  if (s?.project) opts.push(['', `⚑ ${s.name}${s.by ? ' · ' + shortDate(s.by) : ' · no deadline'}`]);
  const rows = C.allTasks(doc).filter(x => !x.task.checked && x.task.id !== editing.id && (x.task.by || x.task.due) && !(window.__habits || []).includes(x.list));
  rows.sort((a, b) => (b.list === list) - (a.list === list) || (C.byDate(a.task) || a.task.due).localeCompare(C.byDate(b.task) || b.task.due));
  for (const x of rows.slice(0, 60)) opts.push([x.task.id, `${plainTitle(x.task.title)} · ${shortDate(C.byDate(x.task) || x.task.due)}`]);
  return opts;
}
function linkPreview(list) {
  const doc = currentDoc(), s = doc.sections.find(x => x.name === list);
  const rows = editing.links.map(str => {
    const l = C.parseLinks(str).links[0], f = l.ref ? C.findTask(doc, l.ref) : null;
    const base = l.ref ? (f ? C.byDate(f.task) || f.task.due : null) : s?.project ? s.by : null;
    const name = l.ref ? (f ? f.task.title : 'missing task') : s?.project ? s.name : 'no project';
    return { ...l, str, name, project: !l.ref, base, date: base ? C.addDays(base, -l.gap) : null };
  });
  const win = rows.filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (win) win.win = true;
  return rows;
}
function paintLinks(list = $('#fList').value) {
  const box = $('#linkRows'), stk = isStkList(list), type = C.listTypeOf(currentDoc().sections.find(s => s.name === list));
  if (!(C.isTaskType(type) || stk)) { box.innerHTML = ''; return; }
  const rows = linkPreview(list);
  const row = (r, i) => `<div class="lk-row${r.win ? ' win' : ''}${r.date ? '' : ' bad'}"><span class="lk-k">Link</span><span class="lk-t">${esc(r.gap ? r.gap + ' d before' : 'On')} ${esc(r.project ? '⚑ ' + r.name : plainTitle(r.name))}${r.base ? ` <small>(${esc(shortDate(r.base))})</small>` : ''}</span><b class="lk-r">${r.date ? '→ ' + esc(shortDate(r.date)) + (r.win ? ' ✓' : '') : 'Link broken'}</b><button type="button" class="lk-del" data-i="${i}" aria-label="Remove this link">×</button></div>`;
  const opts = linkTargets(list);
  box.innerHTML = rows.map(row).join('') + `<div class="lk-row lk-new"><span class="lk-k">${rows.length ? '' : 'Link'}</span><span class="lk-add"><input type="number" id="lkGap" min="0" max="365" value="${rows.length ? 1 : 7}" aria-label="Days before"><span>d before</span><select id="lkTo" aria-label="Link to">${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select><button type="button" id="lkAdd"${opts.length ? '' : ' disabled'}>Add</button></span></div>`;
  if (rows.length) { const w = rows.find(r => r.win); $('#fBy').value = w ? w.date : ''; $('#fByAt').value = ''; editing.linkBy = $('#fBy').value || null; }
}
$('#linkRows').addEventListener('click', e => {
  const del = e.target.closest('.lk-del');
  if (del) { editing.links.splice(+del.dataset.i, 1); if (!editing.links.length) editing.linkBy = undefined; return paintWin(); }
  if (e.target.closest('#lkAdd')) {
    const gap = Math.max(0, Math.min(365, Math.round(+$('#lkGap').value || 0))), to = $('#lkTo').value;
    const str = (to ? '^' + to : '') + (gap || !to ? `-${gap}d` : '');
    if (!editing.links.includes(str)) editing.links.push(str);
    paintWin();
  }
});
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
  editing.links = (t.links || []).map(l => C.linkStr(l).slice(3));
  editing.orig.links = [...editing.links];
  editing.linkBy = editing.links.length ? C.byDate(t) : undefined;
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
  if (!$('#dlBlock').hidden) { next.by = winBy(); next.est = next.by || next.fixed || editing.links.length ? editing.est || null : null; if (!next.by && !editing.links.length) { next.lead = null; next.firm = false; } }
  // Story L10: the links win while the Deadline field shows their result; a new date in the field replaces them.
  const linksChanged = JSON.stringify(editing.links) !== JSON.stringify(o.links);
  if (editing.links.length && 'by' in next) { if (next.by === (editing.linkBy ?? o.by ?? null)) delete next.by; else editing.links = []; }
  if (isStkList(next.list)) { next.due = o.due ?? null; next.at = o.at ?? null; } // a sticky has no start: its greyed Date stays as it was
  const patch = {};
  for (const k of Object.keys(next)) {
    const a = JSON.stringify(next[k] ?? null), b = JSON.stringify(o[k] ?? null);
    if (a !== b) patch[k] = next[k];
  }
  if (patch.list && !('group' in patch)) patch.group = next.group; // a moved task keeps the section picked for its new list
  delete patch.links;
  if (linksChanged || (o.links.length && 'by' in patch)) { patch.links = editing.links; if (!editing.links.length) patch.by = next.by ?? null; } // no link left: the date stays, as a plain deadline
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
// Story L31: the eye « Create buttons » of View options, for every view. Off removes New list, + Section and the + of a column; the palette still creates.
function applyCreate(v) {
  v = v === 'hide' ? 'hide' : 'show';
  LS.set('create', v);
  if (v === 'hide') document.documentElement.dataset.create = 'hide'; else delete document.documentElement.dataset.create;
}
applyCreate(LS.get('create', 'show'));
// Settings and How it works are pages (stories S9, S6): « ‹ Back » returns to the view each one was opened from.
const PAGES = ['settings', 'help'];
const backTo = {};
function openPage(v) { if (st.view !== v) { backTo[v] = st.view; setView(v); } }
const closePage = () => setView(backTo[st.view] || 'agenda');
const fillSettings = () => { $('#sToken').value = cfg.token; $('#sRepo').value = cfg.repo; $('#sBranch').value = cfg.branch; $('#sPath').value = cfg.path; };
// Fill the form only on the way in: a failed sync (401, 404) calls this again every 10 s, and it must not wipe a token being typed.
function openSettings() {
  if (st.view !== 'settings') fillSettings();
  renderFlags();
  openPage('settings');
}
function renderFlags() {
  const age = f => { const d = Math.max(0, Math.floor((Date.now() - Date.parse(f.since)) / 864e5)); return d === 1 ? '1 day' : d + ' days'; };
  $('#flagList').innerHTML = FLAGS.length ? FLAGS.map(f => `<div class="set-row flag-row" data-flag="${esc(f.id)}"><span>${esc(f.id)} · ${esc(f.name)} <span class="set-note">${age(f)}</span></span>
    <div class="prio-pick"><button type="button" data-on="0" class="${flagOn(f.id) ? '' : 'on'}">Off</button><button type="button" data-on="1" class="${flagOn(f.id) ? 'on' : ''}">On</button></div></div>`).join('')
    : '<div class="set-row"><span class="set-note">No beta feature now.</span></div>';
}
$('#flagList').addEventListener('click', e => {
  const b = e.target.closest('button[data-on]'); if (!b) return;
  flagState[b.closest('[data-flag]').dataset.flag] = b.dataset.on === '1';
  LS.set('flags', flagState); applyFlags(); renderFlags(); render();
});
fillSettings(); renderFlags(); // Settings can open on a reload without openSettings()

// Story L34 (flag L34): the sidebar width. Drag the right edge of the sidebar (computer only). The width snaps to steps of
// 16 px from 200 to 424 px, so a size is easy to find again; the default is 264 px, for long project names. A pill gives the
// value while you drag and for 1.5 s after, then fades. Double-click: back to 264 px. Arrow keys on the focused edge: one step.
// The width lives in this browser (tasks.navWidth). The handle sits outside #nav, because each render rewrites the sidebar.
const NAV_MIN = 200, NAV_MAX = 424, NAV_STEP = 16, NAV_DEF = 264, NAV_SHOW = 1500;
const navSnap = w => Math.max(NAV_MIN, Math.min(NAV_MAX, NAV_MIN + Math.round((w - NAV_MIN) / NAV_STEP) * NAV_STEP));
let navW = navSnap(+LS.get('navWidth', NAV_DEF) || NAV_DEF), ngTimer = null;
const grip = document.createElement('div');
Object.assign(grip, { className: 'nav-grip', id: 'navGrip', tabIndex: 0, title: `Drag to change the width · double-click: ${NAV_DEF} px` });
for (const [k, v] of [['role', 'separator'], ['aria-orientation', 'vertical'], ['aria-label', 'Sidebar width'], ['aria-valuemin', NAV_MIN], ['aria-valuemax', NAV_MAX]]) grip.setAttribute(k, v);
grip.innerHTML = '<span class="ng-val" id="navGripVal" hidden></span>';
document.body.append(grip);
const ngVal = grip.firstChild;
function ngHide() { ngVal.classList.add('out'); ngTimer = setTimeout(() => { ngVal.hidden = true; ngVal.classList.remove('out'); }, 300); }
function setNavW(w, show = true, y = null) {
  navW = navSnap(w);
  document.documentElement.style.setProperty('--nav-w', navW + 'px');
  grip.setAttribute('aria-valuenow', navW);
  LS.set('navWidth', navW);
  if (show) {
    ngVal.textContent = navW + ' px';
    if (y !== null) grip.style.setProperty('--gy', Math.max(24, Math.min(innerHeight - 24, y)) + 'px');
    ngVal.hidden = false; ngVal.classList.remove('out'); clearTimeout(ngTimer);
    if (!grip.classList.contains('drag')) ngTimer = setTimeout(ngHide, NAV_SHOW);
  }
  layoutHorizon();
}
setNavW(navW, false);
grip.addEventListener('pointerdown', e => { if (e.button) return; e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); document.body.classList.add('resizing'); setNavW(e.clientX, true, e.clientY); });
grip.addEventListener('pointermove', e => { if (grip.classList.contains('drag')) setNavW(e.clientX, true, e.clientY); });
const ngEnd = e => { if (!grip.classList.contains('drag')) return; grip.classList.remove('drag'); document.body.classList.remove('resizing'); setNavW(navW, true, e.clientY); };
grip.addEventListener('pointerup', ngEnd);
grip.addEventListener('pointercancel', ngEnd);
grip.addEventListener('dblclick', e => setNavW(NAV_DEF, true, e.clientY));
grip.addEventListener('keydown', e => {
  const d = { ArrowLeft: -NAV_STEP, ArrowRight: NAV_STEP }[e.key];
  if (d) { e.preventDefault(); setNavW(navW + d); }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setNavW(e.key === 'Home' ? NAV_MIN : NAV_MAX); }
});
// Story L30: the notes bubble opens under its mark; near the bottom of the screen it opens above it.
const placeBubble = e => {
  const m = e.target.closest?.('.nmark'); if (!m) return;
  m.classList.remove('up');
  requestAnimationFrame(() => { const b = m.querySelector('.nbub'); if (b && b.getBoundingClientRect().bottom > innerHeight - 8) m.classList.add('up'); });
};
document.addEventListener('pointerover', placeBubble);
document.addEventListener('focusin', placeBubble);
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
    for (const k of ['text', 'sha', 'etag', 'pending']) LS.set(CH + k, k === 'pending' ? [] : k === 'text' ? '' : null);
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
  else if (k === 'create') applyCreate(LS.get('create', 'show') === 'hide' ? 'show' : 'hide');
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
  // Story L31: the palette add reads the quick-add tokens (date, time, repeat, !prio, #tag, @list), as the add bar does.
  const p = C.parseQuick(q.trim(), { today: today(), now: C.nowTimeIn(), lists: window.__lists || [] });
  items.push({ kind: 'add', title: q.trim(), q: { ...p, title: p.title || q.trim(), list: p.list || 'Inbox' } });
  // A list or a section of the open list, when that name is new: with Create buttons on Hide, the palette is the only way to create them.
  const name = q.replace(/\s+/g, ' ').trim(), cl = curList(), low = name.toLowerCase();
  if (!(window.__lists || []).some(l => l.toLowerCase() === low)) items.push({ kind: 'newlist', name });
  const sec = cl && doc.sections.find(x => x.name === cl);
  if (sec && !sec.items.some(it => it.kind === 'head' && it.name.toLowerCase() === low)) items.push({ kind: 'newsec', name, list: cl });
  return items;
}
function paintPalette() {
  const q = $('#palInput').value, doc = currentDoc();
  palItems = palResults(q);
  palSel = Math.max(0, Math.min(palSel, palItems.length - 1));
  let h = '', sec = null;
  palItems.forEach((it, i) => {
    const k = it.kind === 'list' ? 'Lists' : it.kind === 'add' ? 'New task' : it.kind === 'newlist' || it.kind === 'newsec' ? 'Create' : it.r.task.checked ? 'Done' : 'Tasks';
    if (k !== sec) { h += `<div class="pal-sec">${k}</div>`; sec = k; }
    const sel = i === palSel ? ' sel' : '';
    if (it.kind === 'list') {
      const s = doc.sections.find(x => x.name === it.name);
      h += `<button type="button" class="pal-item${sel}" data-i="${i}" role="option"><span class="pal-ck pal-go" style="--c:${listColor(it.name)}"></span><span class="pal-b"><span class="pal-t">Go to ${hlq(it.name, q)}</span></span><span class="pal-w">${C.allTasks({ sections: [s] }).filter(x => !x.task.checked).length} open</span></button>`;
    } else if (it.kind === 'add') {
      h += `<button type="button" class="pal-item${sel}" data-i="${i}" role="option"><span class="pal-ck pal-plus">+</span><span class="pal-b"><span class="pal-t">Add « ${esc(it.q.title)} »</span></span><span class="pal-w">${esc([it.q.list, it.q.due ? dayLabel(it.q.due) + (it.q.at ? ' · ' + it.q.at : '') : ''].filter(Boolean).join(' · '))}</span></button>`;
    } else if (it.kind === 'newlist' || it.kind === 'newsec') {
      h += `<button type="button" class="pal-item${sel}" data-i="${i}" role="option"><span class="pal-ck pal-plus">+</span><span class="pal-b"><span class="pal-t">${it.kind === 'newlist' ? 'New list' : 'New section'} « ${esc(it.name)} »</span></span><span class="pal-w">${it.kind === 'newsec' ? 'in ' + esc(it.list) : 'choose the type'}</span></button>`;
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
  if (it.kind === 'newlist') { openNewList('tasks'); $('#nlName').value = it.name; return; }
  if (it.kind === 'newsec') { freshSecs.add(it.list + '|' + it.name); commit({ type: 'addGroup', list: it.list, name: it.name }); toast('Section added'); return; }
  if (it.kind === 'add') { const q = it.q; if (q.title) { commit({ type: 'add', id: C.newId(), title: q.title, list: q.list, due: q.due, at: q.at, every: q.every, prio: q.prio, tags: q.tags, firm: q.firm, fixed: q.fixed, lead: q.lead, leadH: q.leadH, by: q.by, links: q.links, est: q.est }); toast('Added to ' + q.list); } return; }
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
  if (['habits', 'stickies', 'matrix', 'lists', 'done', 'settings', 'help'].includes(head) || (head === 'canstart' && flagOn('L23'))) st.view = head;
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
// Story L23: the rotation. The task on screen follows the clock (csIndex); this timer only plays the flip when the slot changes.
// It waits while the pointer is on the pile, then shows the task of the current slot.
setInterval(() => {
  const box = document.querySelector('.cs-tick'), rows = csLast.rows;
  if (!box || rows.length < 2 || document.visibilityState !== 'visible' || box.closest('.cs-pile').matches(':hover')) return;
  const i = csIndex(rows, csLast.td), x = rows[i];
  if (!x || box.dataset.cs === x.task.id) return;
  box.dataset.cs = x.task.id;
  const old = box.querySelector('.cs-row:last-child'), tmp = document.createElement('span');
  tmp.innerHTML = csRowHTML(x, csLast.td); const n = tmp.firstElementChild; n.classList.add('cs-in'); box.appendChild(n);
  if (old) { old.classList.add('cs-out'); setTimeout(() => old.remove(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600); }
}, 250);
let lastHm = C.nowTimeIn();
setInterval(() => {
  const hm = C.nowTimeIn(), td = today(), was = lastHm; lastHm = hm;
  if (hm < was || document.visibilityState !== 'visible' || editing) return;
  if (C.allTasks(currentDoc()).some(x => !x.task.checked && x.task.due === td && x.task.at && x.task.at > was && x.task.at <= hm)) render();
}, 30_000);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// Story L35 (flag L35, round 3 choice W2, 2026-10-19): on a computer, the column of Agenda, Habits and Stickies sits at the center
// of the window, not at the center of the space right of the sidebar. Its width is the window minus two widths of the wider bar
// (sidebar or rail) and two 20 px gutters, 836 px at most; below 640 px it keeps 640 px and moves right only as far as necessary, and the rail hides.
// The widget rail is docked to the right edge, a mirror of the sidebar, and its left edge drags like the L34 edge (tasks.railWidth).
// The column fits between the wider of the two bars on both sides: one set of widgets for the three views, kept in this browser (tasks.widgets). The task
// panel covers the rail and does not move the column. Since 2026-10-20 every view has the column and the rail, except a wide view
// (see l35Kind), which keeps its full width: the rail folds to a 40 px strip, and a click on it opens the rail over the content
// until Esc or a click outside.
const L35_G = 20, L35_MIN = 640, L35_CAP = 836;
let l35 = { on: false, rail: false, mini: false }, railW = navSnap(+LS.get('railWidth', NAV_DEF) || NAV_DEF), railCtx = null, wEdit = false, wGal = false, wDrag = null, wPeek = false;
const wgs = Object.assign({ list: ['habits', 'cs', 'stock', 'chg', 'next', 'prog'], folded: ['next', 'prog'], max: {} }, LS.get('widgets', {}));
const wSave = () => LS.set('widgets', { list: wgs.list, folded: wgs.folded, max: wgs.max });
const W_MAX = [3, 5, 8, 10, 15, 0]; // the « Show » choices of a widget with a row cap; 0 shows every row
const wMax = (k, def) => wgs.max[k] ?? def;
const rail = document.createElement('aside');
Object.assign(rail, { id: 'rail', className: 'rail' });
rail.setAttribute('aria-label', 'Widgets');
document.body.append(rail);
// The rail layout of the view: 'col' (centered column and rail), 'mini' (full width and the strip) or '' (no rail).
// It follows the width rule of render(): a wide view (the Matrix page, a list in Board, Lanes or Matrix mode; a stock, habits or
// stickies list keeps its own view) needs the full width and gets the strip. Settings, Help and the Lists page have no rail;
// every other view gets the column and the rail (2026-10-20: « hide only when not needed, and when full width is required »).
const wideView = v => v === 'matrix' || (v.startsWith('list:') && !['stock', 'habits', 'stickies'].includes(C.listTypeOf(currentDoc().sections.find(s => s.name === v.slice(5)))) && ['board', 'lanes', 'matrix'].includes(listMode(v.slice(5))));
function l35Kind() {
  if (['settings', 'help', 'lists'].includes(st.view)) return '';
  return wideView(st.view) ? 'mini' : 'col';
}
function l35Apply() {
  const W = document.documentElement.clientWidth, side = $('#nav').getBoundingClientRect().width;
  const kind = flagOn('L35') && W >= 1100 ? l35Kind() : '', on = kind === 'col', mini = kind === 'mini';
  const was = l35.rail;
  l35 = { on, rail: mini, mini };
  if (!mini) wPeek = false;
  document.documentElement.style.setProperty('--rail-w', railW + 'px');
  if (on) {
    const sym = W - 2 * (Math.max(side, railW) + L35_G), fb = sym < L35_MIN; // the wider bar sets both gaps
    const colW = fb ? Math.min(L35_MIN, W - side - 2 * L35_G) : Math.min(L35_CAP, sym);
    const left = fb ? side + L35_G : (W - colW) / 2;
    l35.rail = !fb;
    const r = document.documentElement.style;
    r.setProperty('--l35-w', colW + 'px'); r.setProperty('--l35-ml', left - side + 'px');
  }
  document.body.classList.toggle('l35', on);
  document.body.classList.toggle('has-rail', l35.rail);
  document.body.classList.toggle('rail-mini', mini);
  document.body.classList.toggle('rail-peek', wPeek);
  return was !== l35.rail || (mini && !rail.childElementCount);
}
const railPeek = v => { wPeek = v; document.body.classList.toggle('rail-peek', v); if (!v) { wEdit = false; wGal = false; } paintRail(); };
// The open rail over a wide view closes on Esc or on a click outside it (not on the strip, the panel or a dialog).
document.addEventListener('click', e => { if (wPeek && e.target.isConnected && !e.target.closest('#rail, #railGrip, dialog')) railPeek(false); });
document.addEventListener('keydown', e => { if (wPeek && e.key === 'Escape' && !sheet.open && !pal.open) { e.stopImmediatePropagation(); railPeek(false); } }, true);
// The observer also sees the scrollbar come and go (the window keeps its size, the page loses 15 px), so the center stays exact.
// With the flag on, every resize renders again: the day strip refits to the column.
new ResizeObserver(() => { if (l35Apply() || l35.on) render(); }).observe(document.documentElement);
// The rail edge: the same steps, limits, pill, double-click and keys as the sidebar edge (L34), mirrored.
let rgTimer = null;
const rgrip = document.createElement('div');
Object.assign(rgrip, { className: 'nav-grip rail-grip', id: 'railGrip', tabIndex: 0, title: `Drag to change the width · double-click: ${NAV_DEF} px` });
for (const [k, v] of [['role', 'separator'], ['aria-orientation', 'vertical'], ['aria-label', 'Widget rail width'], ['aria-valuemin', NAV_MIN], ['aria-valuemax', NAV_MAX]]) rgrip.setAttribute(k, v);
rgrip.innerHTML = '<span class="ng-val" hidden></span>';
document.body.append(rgrip);
const rgVal = rgrip.firstChild;
function setRailW(w, show = true, y = null) {
  const room = (document.documentElement.clientWidth - L35_MIN) / 2 - L35_G; // a drag stops where the column keeps 640 px
  railW = navSnap(w);
  while (railW > NAV_MIN && railW > room) railW -= NAV_STEP;
  rgrip.setAttribute('aria-valuenow', railW);
  LS.set('railWidth', railW);
  if (l35Apply() || l35.on) render();
  if (show) {
    rgVal.textContent = railW + ' px';
    if (y !== null) rgrip.style.setProperty('--gy', Math.max(24, Math.min(innerHeight - 24, y)) + 'px');
    rgVal.hidden = false; rgVal.classList.remove('out'); clearTimeout(rgTimer);
    if (!rgrip.classList.contains('drag')) rgTimer = setTimeout(() => { rgVal.classList.add('out'); rgTimer = setTimeout(() => { rgVal.hidden = true; rgVal.classList.remove('out'); }, 300); }, NAV_SHOW);
  }
  layoutHorizon();
}
const rgX = e => document.documentElement.clientWidth - e.clientX;
rgrip.addEventListener('pointerdown', e => { if (e.button) return; e.preventDefault(); rgrip.setPointerCapture(e.pointerId); rgrip.classList.add('drag'); document.body.classList.add('resizing'); setRailW(rgX(e), true, e.clientY); });
rgrip.addEventListener('pointermove', e => { if (rgrip.classList.contains('drag')) setRailW(rgX(e), true, e.clientY); });
const rgEnd = e => { if (!rgrip.classList.contains('drag')) return; rgrip.classList.remove('drag'); document.body.classList.remove('resizing'); setRailW(railW, true, e.clientY); };
rgrip.addEventListener('pointerup', rgEnd);
rgrip.addEventListener('pointercancel', rgEnd);
rgrip.addEventListener('dblclick', e => setRailW(NAV_DEF, true, e.clientY));
rgrip.addEventListener('keydown', e => {
  const d = { ArrowLeft: NAV_STEP, ArrowRight: -NAV_STEP }[e.key];
  if (d) { e.preventDefault(); setRailW(railW + d); }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setRailW(e.key === 'Home' ? NAV_MIN : NAV_MAX); }
});

// The widgets. Each gives a title, an optional link and its body; t(ctx) reads the data of the last render.
const wRow = (x, right = '') => `<button class="wg-row" data-open="${x.task.id}"><span class="dot" style="background:${listColor(x.list)}"></span><span class="wg-x">${esc(x.task.title)}</span>${right}</button>`;
const W_ALL = {
  habits: { n: 'Habits now', src: 'L23', d: 'The habits of the next hours. A tap checks one.', t: c => {
    const day = c.habits.filter(x => C.habitDue(x.task, c.td) <= c.td || C.habitLog(x.task).includes(c.td));
    if (!day.length) return { h: 'Habits', b: '<p class="wg-empty">No habit today.</p>' };
    const { done, show, later } = habitParts(day), left = show.filter(x => !done(x)).length;
    const dots = [...show.filter(x => !done(x)), ...show.filter(done)].map(x => `<button class="wg-hab${done(x) ? ' done' : ''}" data-act="hcheck" data-id="${x.task.id}" title="${esc(x.task.title)}">${esc(habitEmoji(x.task.title))}</button>`).join('');
    return { h: `Habits now · ${left ? left + ' left' : '✓'}`, link: ['hopen', later.length ? `+${later.length} ›` : '›'], b: dots ? `<div class="wg-habs">${dots}</div>` : `<p class="wg-empty">${later.length} later today.</p>` };
  } },
  cs: { n: 'Can start now', src: 'L23 · L32', d: 'The tasks you can start now, soonest act-by first.', t: c => {
    const rows = csSort(c.tasks.filter(canStart));
    const max = wMax('cs', 5);
    if (!rows.length) return { h: 'Can start now', max, b: '<p class="wg-empty">Nothing to start now.</p>' };
    return { h: `Can start now · ${rows.length}`, max, link: ['cspage', `All ${rows.length} ›`], b: rows.slice(0, max || rows.length).map(x => { const j = daysTo(csDay(x), c.td); return wRow(x, `<span class="wg-j${j <= 7 ? ' soon' : ''}">J-${j}</span>`); }).join('') };
  } },
  stock: { n: 'To buy', src: 'stock lists', d: 'The open items of the stock lists. A tap checks one as bought.', t: c => {
    const rows = c.open.filter(x => c.stockLists.includes(x.list));
    const l = rows[0]?.list || c.stockLists[0];
    if (!rows.length) return { h: 'To buy', b: '<p class="wg-empty">Nothing to buy.</p>' };
    return { h: `To buy · ${rows.length}`, link: l ? ['view:list:' + l, '›'] : null, b: rows.slice(0, 8).map(x => `<button class="wg-row" data-act="wbuy" data-id="${x.task.id}"><span class="wg-box"></span><span class="wg-x">${esc(x.task.title)}</span><span class="wg-j">${esc(x.list)}</span></button>`).join('') };
  } },
  chg: { n: 'Recent changes', src: 'L28', d: 'The last writes to Tasks.md: the app, Claude (MCP), the CLI, the reminder job.', t: () => {
    const rows = chgRows();
    return { h: 'Recent changes', b: rows === null ? '<p class="wg-empty">Loading…</p>' : !rows.length ? '<p class="wg-empty">No change yet.</p>'
      : `<div class="wg-chg">${rows.map(r => `<span class="wg-who src-${r.who.toLowerCase()}">${esc(r.who)}</span><span class="wg-x" title="${esc(r.msg)}">${esc(r.msg)}</span><span class="wg-tm">${esc(r.when)}</span>`).join('')}</div>${DEMO ? '<p class="wg-note">Examples: the demo has no git history.</p>' : ''}` };
  } },
  next: { n: 'Next up', src: 'reminders', d: 'The tasks and habits of today with a time, the next one first.', t: c => {
    const now = C.nowTimeIn();
    const rows = [...c.tasks.filter(x => dueOf(x) === c.td && x.task.at), ...c.habits.filter(x => x.task.at && C.habitDue(x.task, c.td) <= c.td && !C.habitLog(x.task).includes(c.td))].sort((a, b) => a.task.at.localeCompare(b.task.at));
    if (!rows.length) return { h: 'Next up', b: '<p class="wg-empty">No timed item today.</p>' };
    const i = rows.findIndex(x => x.task.at >= now);
    return { h: 'Next up', b: rows.map((x, k) => wRow(x, `<span class="wg-tm${k === i ? ' now' : ''}${x.task.at < now ? ' past' : ''}">${esc(x.task.at)}</span>`)).join('') };
  } },
  prog: { n: 'Today progress', src: 'new', d: 'Done today against the plan, in tasks and estimated time.', t: c => {
    const done = c.all.filter(x => x.task.checked && x.task.done === c.td && !c.stockLists.includes(x.list) && !(window.__habits || []).includes(x.list));
    const left = c.tasks.filter(x => dueOf(x) && dueOf(x) <= c.td);
    const n = done.length + left.length, p = n ? Math.round(done.length / n * 100) : 0;
    const est = rs => rs.reduce((a, x) => a + (x.task.est || 0), 0), e1 = est(done), e2 = est(done) + est(left);
    return { h: 'Today', b: `<div class="wg-prog"><span class="wg-ring" style="--p:${p}"></span><span><b>${done.length} of ${n} done</b><small>${e2 ? `${C.estLabel(e1 || 0)} of ${C.estLabel(e2)} estimated` : 'No estimate'}</small></span></div>` };
  } },
  inbox: { n: 'Inbox to sort', src: 'Inbox', d: 'The Inbox tasks that wait for a list, a date or a priority.', t: c => {
    const rows = c.tasks.filter(x => x.list.toLowerCase() === 'inbox');
    return { h: `Inbox · ${rows.length}`, link: ['view:list:Inbox', '›'], b: rows.length ? rows.slice(0, 5).map(x => wRow(x)).join('') : '<p class="wg-empty">Inbox is empty.</p>' };
  } },
  proj: { n: 'Projects', src: 'L10', d: 'Each deadline project: days left, steps done, estimated time left.', t: c => {
    const ps = c.doc.sections.filter(s => s.project);
    if (!ps.length) return { h: 'Projects', b: '<p class="wg-empty">No project yet.</p>' };
    return { h: 'Projects', b: ps.map(s => {
      const rs = c.all.filter(x => x.list === s.name), d = rs.filter(x => x.task.checked).length, est = rs.filter(x => !x.task.checked).reduce((a, x) => a + (x.task.est || 0), 0);
      return `<button class="wg-proj" data-view="list:${esc(s.name)}" style="--pc:${listColor(s.name)}"><span class="wg-pr"><span class="dot"></span><span class="wg-x">${esc(s.name)}</span><span class="wg-j">${s.by ? 'J-' + daysTo(s.by, c.td) : 'no date'}</span></span><span class="wg-pb"><i style="width:${rs.length ? d / rs.length * 100 : 0}%"></i></span><span class="wg-pm"><span>${d}/${rs.length} done</span><span>${est ? C.estLabel(est) + ' left' : ''}</span></span></button>`;
    }).join('') };
  } },
};
// Recent changes: the last commits of the data file, read from GitHub once a minute. The commit message carries its source.
let chgCache = { at: 0, rows: null };
const CHG_DEMO = [['MCP', 'added 3 tasks to Work', '10:42'], ['App', 'done « Water the plants »', '09:15'], ['MCP', 'Buy socks: act by moved to J-3', '08:30'], ['Job', 'sent 2 reminders', '08:00']];
function chgRows() {
  if (DEMO) return CHG_DEMO.map(([who, msg, when]) => ({ who, msg, when }));
  if (Date.now() - chgCache.at > 60e3) {
    chgCache.at = Date.now();
    fetch(`${API}/repos/${cfg.repo}/commits?path=${encodeURIComponent(cfg.path)}&sha=${encodeURIComponent(cfg.branch)}&per_page=6`, { headers: headers() })
      .then(r => r.ok ? r.json() : []).then(cs => {
        const td = today();
        chgCache.rows = cs.map(k => {
          const m = k.commit.message.split('\n')[0], src = (m.match(/\((MCP|CLI|app|App|job|Job)\)/) || [])[1] || 'Git';
          const d = new Date(k.commit.author.date), day = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
          const when = day === td ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : shortDate(day);
          return { who: src[0].toUpperCase() + src.slice(1).toLowerCase(), msg: m.replace(/^[^:]*:\s*/, ''), when };
        });
        paintRail();
      }).catch(() => { chgCache.rows = []; paintRail(); });
  }
  return chgCache.rows;
}
// The rail. W2: a quiet « Edit widgets » button under the last widget; edit mode shows the controls on every widget, dashed
// borders, « + Add widget » (the gallery) and « Done ». A title tap folds a widget to one line in both modes.
function paintRail() {
  if (!l35.rail || !railCtx) { rail.innerHTML = ''; return; }
  if (l35.mini && !wPeek) { rail.classList.remove('editing'); rail.innerHTML = `<button class="rail-strip" data-w="peek" title="Show the widgets" aria-label="Show the widgets" aria-expanded="false"><span>‹</span></button>`; return; }
  const ws = wgs.list.filter(k => W_ALL[k]).map((k, i, a) => {
    const w = W_ALL[k].t(railCtx), f = wgs.folded.includes(k);
    const link = w.link ? (w.link[0].startsWith('view:') ? `<button class="wg-link" data-view="${esc(w.link[0].slice(5))}">${w.link[1]}</button>` : `<button class="wg-link" data-act="${w.link[0]}">${w.link[1]}</button>`) : '';
    const ctl = wEdit ? `<span class="wg-ctl"><span class="wg-grip" title="Drag to move">⠿</span><button data-w="up" data-k="${k}" aria-label="Move up"${i ? '' : ' disabled'}>↑</button><button data-w="dn" data-k="${k}" aria-label="Move down"${i < a.length - 1 ? '' : ' disabled'}>↓</button><button class="wg-rm" data-w="rm" data-k="${k}" aria-label="Remove ${esc(W_ALL[k].n)}">×</button></span>` : link;
    // A widget with a row cap (w.max) shows its « Show » picker in edit mode, above its rows.
    const max = wEdit && 'max' in w ? `<label class="wg-max">Show <select data-w="max" data-k="${k}">${W_MAX.map(n => `<option value="${n}"${n === w.max ? ' selected' : ''}>${n || 'All'}</option>`).join('')}</select></label>` : '';
    return `<section class="wg${f ? ' folded' : ''}" data-k="${k}"${wEdit ? ' draggable="true"' : ''}><header><button class="wg-h" data-w="fold" data-k="${k}" aria-expanded="${!f}">${esc(w.h)}</button>${ctl}</header>${f ? '' : `${max}<div class="wg-b">${w.b}</div>`}</section>`;
  }).join('');
  const free = Object.keys(W_ALL).filter(k => !wgs.list.includes(k));
  const gal = wGal ? `<div class="wg-gal"><div class="wg-galh">Add a widget<button data-w="gal" aria-label="Close">×</button></div>${free.map(k => `<button data-w="add" data-k="${k}"><b>${esc(W_ALL[k].n)} <span>${esc(W_ALL[k].src)}</span></b><small>${esc(W_ALL[k].d)}</small></button>`).join('') || '<small>Every widget is in the rail.</small>'}</div>` : '';
  const foot = wEdit ? `<div class="wg-foot"><button class="wg-add" data-w="gal">+ Add widget</button><button class="wg-done" data-w="edit">Done</button></div>` : `<button class="wg-edit" data-w="edit">✎ Edit widgets</button>`;
  rail.classList.toggle('editing', wEdit);
  rail.innerHTML = ws + foot + gal;
  if (wGal) rail.querySelector('.wg-gal').scrollIntoView({ block: 'nearest' });
}
function wMove(k, to) { const a = wgs.list.filter(x => x !== k); a.splice(Math.max(0, Math.min(a.length, to)), 0, k); wgs.list = a; }
rail.addEventListener('click', e => {
  const w = e.target.closest('[data-w]');
  if (w?.dataset.w === 'max') return; // the « Show » picker saves on change
  if (w?.dataset.w === 'peek') return railPeek(true);
  if (w) {
    const k = w.dataset.k, i = wgs.list.indexOf(k), was = wgs.list.join();
    ({ up: () => wMove(k, i - 1), dn: () => wMove(k, i + 1), rm: () => { wgs.list = wgs.list.filter(x => x !== k); },
       fold: () => { wgs.folded = wgs.folded.includes(k) ? wgs.folded.filter(x => x !== k) : [...wgs.folded, k]; },
       add: () => { wgs.list = [...wgs.list, k]; wGal = false; }, gal: () => { wGal = !wGal; },
       edit: () => { wEdit = !wEdit; wGal = false; } })[w.dataset.w]?.();
    wSave();
    return wgs.list.join() !== was ? render() : paintRail(); // the Agenda zone changes when Habits now or Can start now moves in or out
  }
  const v = e.target.closest('[data-view]')?.dataset.view;
  if (v) return setView(v);
  const o = e.target.closest('[data-open]')?.dataset.open;
  if (o) return openTask(o);
  const act = e.target.closest('[data-act]'), a = act?.dataset.act;
  if (a === 'hcheck' || a === 'wbuy') return toggle(act.dataset.id, null);
  if (a === 'hopen') return setView('habits');
  if (a === 'cspage') return openPage('canstart');
});
rail.addEventListener('change', e => { const s = e.target.closest('[data-w="max"]'); if (s) { wgs.max[s.dataset.k] = +s.value; wSave(); paintRail(); } });
rail.addEventListener('dragstart', e => { const s = e.target.closest?.('.wg'); if (!wEdit || !s) return; wDrag = s.dataset.k; s.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', wDrag); });
const wClear = () => rail.querySelectorAll('.drop-a, .drop-b').forEach(x => x.classList.remove('drop-a', 'drop-b'));
rail.addEventListener('dragover', e => {
  const s = e.target.closest?.('.wg'); if (!wDrag || !s) return;
  e.preventDefault(); wClear();
  if (s.dataset.k !== wDrag) { const r = s.getBoundingClientRect(); s.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-b' : 'drop-a'); }
});
rail.addEventListener('drop', e => {
  const s = e.target.closest?.('.wg'); if (!wDrag || !s) return;
  e.preventDefault();
  if (s.dataset.k !== wDrag) { const a = wgs.list.filter(x => x !== wDrag); a.splice(a.indexOf(s.dataset.k) + (s.classList.contains('drop-a') ? 1 : 0), 0, wDrag); wgs.list = a; wSave(); }
  wDrag = null; render();
});
rail.addEventListener('dragend', () => { wDrag = null; wClear(); rail.querySelectorAll('.drag').forEach(x => x.classList.remove('drag')); });

readHash();
if (DEMO) { $('#demoBar').hidden = false; setStatus('off'); loadDemo().then(render); }
render();
if (!DEMO) sync();
