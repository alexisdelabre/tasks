// Tasks core: one module shared by the web app, the CLI and the reminder job.
// File format (Tasks.md):
//   ## <List name>
//   ### <Section name>      optional; groups the tasks below it, inside the list
//   - [ ] Title due:YYYY-MM-DD at:HH:MM every:week !1 #tag ^id
//   - [/] Title ^id          in progress
//     Notes, indented two spaces. "- [ ]" lines in notes are a checklist.
//   - [x] Title done:YYYY-MM-DD ^id
//   ## <List name> ~stock   a stock list (groceries, supplies): "- [ ]" = to buy, "- [x]" = in stock,
//                           done: = last purchase. Completing keeps the line; Clear done skips the list.
//   ## <List name> ~habits  a habits list: small recurring tasks (every:day by default). A missed habit
//                           never goes overdue: its slot moves to today (habitDue). streak:N counts the
//                           check-ins in a row; streak:off is a habit kept for its reminder only.
//                           The note line "✓ YYYY-MM-DD …" logs the last check-in dates (HABIT_LOG_MAX).
//   ## <List name> ~stickies  a stickies list: pense-bêtes, one entry not to forget each, no tasks under it.
//                           by: is the deadline (optional); the token ~firm marks a firm deadline, none = best effort.
//                           An old sticky with due: reads as by: (story L15) and is written back with by: when edited.
//                           Claude adds them; the app shows them on their act-by date and on the horizon line.
//   Window tokens (story L15), on any task: due: (+ at:) is the start, not before; by:YYYY-MM-DD[THH:MM] is the
//                           deadline, too late after it; lead:Nd or lead:Nh is the safety margin before the deadline
//                           (story L11), so the task must be done by by − lead (actBy); est:20m, est:2h or est:1h30m
//                           is the estimate. The app warns when start + est > act by.
//   ## <List name> color:#0f9d9a/teal   the list color: the hex code first, the name as a fallback.
//                           Either part can stand alone. Markers can come in any order after the name.
// Unchanged lines are written back byte for byte.

export const TZ = 'Europe/Paris';

// List types: the one source for the heading markers, the type names and the help text.
// The parser, the serializer, addList, the web app (sidebar, New list) and the MCP server all read it.
// A section carries one boolean per type with a marker (s.stock, s.habits, s.stickies).
export const LIST_TYPES = [
  { id: 'tasks', label: 'Tasks', marker: null, color: 'var(--accent)', help: 'Things to do once or on a schedule. Sections, board, lanes, matrix.' },
  { id: 'habits', label: 'Habits', marker: '~habits', color: '#65a30d', help: 'Small things to repeat every day. Each one keeps a streak.' },
  { id: 'stock', label: 'Stock', marker: '~stock', color: '#e2900b', help: 'Things you buy again. Tap one when you run out; Shopping mode in the shop.' },
  { id: 'stickies', label: 'Stickies', marker: '~stickies', color: '#64748b', help: 'Things not to forget, with an optional date, firm or best effort. Claude adds most of them.' },
];
const MARKED = LIST_TYPES.filter(t => t.marker).map(t => ({ ...t, re: new RegExp('\\s+' + t.marker + '$') }));
export const listTypeOf = s => MARKED.find(t => s?.[t.id])?.id || 'tasks';
const COLOR_RE = /\s+color:(\S+)$/;
export const RARE = 'Rare';
const TASK_RE = /^- \[([ xX/])\] ?(.*)$/;
const NOTE_RE = /^(  |\t)/;
const TOKEN = {
  due: /^due:(\d{4}-\d{2}-\d{2})$/,
  at: /^at:(\d{1,2}:\d{2})$/,
  every: /^every:(\S+)$/,
  streak: /^streak:(\d+|off)$/,
  done: /^done:(\d{4}-\d{2}-\d{2})$/,
  prio: /^!([123])$/,
  tag: /^#([\p{L}\p{N}_\/-]+)$/u,
  id: /^\^([a-z0-9]{3,10})$/,
  firm: /^~firm$/,
  fixed: /^~start$/,
  lead: /^lead:(\d{1,3})([dh])$/,
  by: /^by:(\d{4}-\d{2}-\d{2})(?:T(\d{1,2}:\d{2}))?$/,
  est: /^est:(?:(\d{1,2})h)?(?:(\d{1,3})m)?$/,
};

// ---------- ids ----------
function hash36(s) {
  let h = 2166136261;
  for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36).padStart(6, '0').slice(-5);
}
export function newId() {
  return Math.random().toString(36).slice(2, 7).padEnd(5, '0');
}

// ---------- parse ----------
export function parseTaskLine(text) {
  const t = { title: '', due: null, at: null, every: null, streak: null, done: null, prio: 0, tags: [], id: null, firm: false, fixed: false, lead: null, leadH: null, by: null, est: null };
  const words = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = w.match(TOKEN.due))) t.due = m[1];
    else if ((m = w.match(TOKEN.at))) t.at = m[1].padStart(5, '0');
    else if ((m = w.match(TOKEN.every))) t.every = m[1];
    else if ((m = w.match(TOKEN.streak))) t.streak = m[1] === 'off' ? 'off' : +m[1];
    else if ((m = w.match(TOKEN.done))) t.done = m[1];
    else if ((m = w.match(TOKEN.prio))) t.prio = +m[1];
    else if ((m = w.match(TOKEN.tag))) t.tags.push(m[1]);
    else if ((m = w.match(TOKEN.id))) t.id = m[1];
    else if (TOKEN.firm.test(w)) t.firm = true;
    else if (TOKEN.fixed.test(w)) t.fixed = true;
    else if ((m = w.match(TOKEN.lead))) { if (m[2] === 'h') t.leadH = +m[1] || null; else t.lead = +m[1] || null; }
    else if ((m = w.match(TOKEN.by))) t.by = m[2] ? `${m[1]}T${m[2].padStart(5, '0')}` : m[1];
    else if ((m = w.match(TOKEN.est)) && (m[1] || m[2])) t.est = (+m[1] || 0) * 60 + (+m[2] || 0) || null;
    else words.push(w);
  }
  t.title = words.join(' ');
  return t;
}

export function parse(text) {
  const lines = text.split('\n');
  const doc = { preamble: [], sections: [] };
  let sec = null, last = null;
  const seen = new Set();
  for (const line of lines) {
    const h = line.match(/^## +(.+?)\s*$/);
    if (h) {
      let name = h[1], color = null, m, hit;
      const flags = Object.fromEntries(MARKED.map(t => [t.id, false]));
      for (;;) {
        if ((hit = MARKED.find(t => t.re.test(name)))) { flags[hit.id] = true; name = name.replace(hit.re, ''); }
        else if ((m = name.match(COLOR_RE))) { color = m[1]; name = name.slice(0, m.index); }
        else break;
      }
      sec = { name, ...flags, color, raw: line, items: [] };
      doc.sections.push(sec);
      last = null;
      continue;
    }
    if (!sec) { doc.preamble.push(line); continue; }
    const g = line.match(/^### +(.+?)\s*$/);
    if (g) {
      sec.items.push({ kind: 'head', name: g[1], raw: line });
      last = null;
      continue;
    }
    const m = line.match(TASK_RE);
    if (m) {
      const t = parseTaskLine(m[2]);
      t.kind = 'task';
      // A sticky keeps its deadline in by: (story L15); an old due: reads as by:, and the line stays as it is until edited.
      if (sec.stickies && t.due && !t.by) { t.by = t.due; t.due = null; }
      t.checked = m[1] !== ' ' && m[1] !== '/';
      t.doing = m[1] === '/';
      t.notes = [];
      t.raw = [line];
      if (!t.id || seen.has(t.id)) {
        // Hand-written task: derive a stable id from its content.
        let id = hash36(sec.name + '|' + t.title), n = 0;
        while (seen.has(id)) id = hash36(sec.name + '|' + t.title + '|' + ++n);
        t.id = id;
        t.implicitId = true;
      }
      seen.add(t.id);
      sec.items.push(t);
      last = t;
      continue;
    }
    if (last && NOTE_RE.test(line)) {
      last.notes.push(line.replace(NOTE_RE, ''));
      last.raw.push(line);
      continue;
    }
    last = null;
    sec.items.push({ kind: 'raw', text: line });
  }
  return doc;
}

// ---------- serialize ----------
export function taskLine(t) {
  const parts = [`- [${t.checked ? 'x' : t.doing ? '/' : ' '}]`, t.title];
  if (t.due) parts.push('due:' + t.due);
  if (t.at) parts.push('at:' + t.at);
  if (t.fixed) parts.push('~start');
  if (t.by) parts.push('by:' + t.by);
  if (t.firm) parts.push('~firm');
  if (t.leadH) parts.push(`lead:${t.leadH}h`); else if (t.lead) parts.push(`lead:${t.lead}d`);
  if (t.est) parts.push('est:' + estLabel(t.est));
  if (t.every) parts.push('every:' + t.every);
  if (t.streak !== null && t.streak !== undefined) parts.push('streak:' + t.streak);
  if (t.prio) parts.push('!' + t.prio);
  for (const tag of t.tags) parts.push('#' + tag);
  if (t.checked && t.done) parts.push('done:' + t.done);
  parts.push('^' + t.id);
  return parts.filter(Boolean).join(' ');
}

export function serialize(doc) {
  const out = [...doc.preamble];
  for (const s of doc.sections) {
    out.push(s.raw ?? `## ${s.name}${MARKED.filter(t => s[t.id]).map(t => ' ' + t.marker).join('')}${s.color ? ' color:' + s.color : ''}`);
    for (const it of s.items) {
      if (it.kind === 'raw') out.push(it.text);
      else if (it.kind === 'head') out.push(it.raw ?? `### ${it.name}`);
      else if (it.raw) out.push(...it.raw);
      else out.push(taskLine(it), ...it.notes.map(n => '  ' + n)); // a blank note line keeps its indent, so it stays in the notes
    }
  }
  return out.join('\n');
}

// ---------- queries ----------
// A task's group is the last ### heading above it in its list; '' when there is none.
export function allTasks(doc) {
  const res = [];
  for (const s of doc.sections) {
    let group = '';
    for (const it of s.items) {
      if (it.kind === 'head') group = it.name;
      else if (it.kind === 'task') res.push({ task: it, list: s.name, group });
    }
  }
  return res;
}
// Stock list: completing an item keeps it as "in stock" (see the header comment).
export function isStock(doc, list) {
  return !!doc.sections.find(x => x.name.toLowerCase() === String(list || '').toLowerCase())?.stock;
}
// The item of a stock list with this title (case and spaces ignored), or null. Adding it again puts it back to buy.
export function stockMatch(doc, list, title) {
  const s = doc.sections.find(x => x.stock && x.name.toLowerCase() === String(list || '').toLowerCase());
  const key = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return s?.items.find(it => it.kind === 'task' && it.title.toLowerCase().replace(/\s+/g, ' ').trim() === key) || null;
}
// The ### headings of a list, in file order.
export function listGroups(doc, list) {
  const s = doc.sections.find(x => x.name.toLowerCase() === list.toLowerCase());
  return s ? s.items.filter(it => it.kind === 'head').map(it => it.name) : [];
}
function groupAt(section, index) {
  for (let i = index; i >= 0; i--) if (section.items[i].kind === 'head') return section.items[i].name;
  return '';
}
export function findTask(doc, id) {
  for (const s of doc.sections) {
    const i = s.items.findIndex(it => it.kind === 'task' && it.id === id);
    if (i >= 0) return { section: s, index: i, task: s.items[i], group: groupAt(s, i) };
  }
  return null;
}
function getSection(doc, name, create = true) {
  const key = name.trim().toLowerCase();
  let s = doc.sections.find(x => x.name.toLowerCase() === key);
  if (!s && create) {
    // Keep a blank line before a new heading.
    const prev = doc.sections.at(-1);
    const tail = prev ? prev.items : doc.preamble;
    if (tail.length && (tail.at(-1).kind === 'raw' ? tail.at(-1).text : tail.at(-1)) !== '') {
      prev ? prev.items.push({ kind: 'raw', text: '' }) : doc.preamble.push('');
    }
    s = { name: name.trim(), raw: null, items: [{ kind: 'raw', text: '' }] };
    doc.sections.push(s);
  }
  return s;
}
const isBlank = it => it.kind === 'raw' && it.text.trim() === '';
// Insert at the end of a range of items, before its trailing blank lines.
function insertBefore(section, end, task) {
  let i = end;
  while (i > 0 && isBlank(section.items[i - 1])) i--;
  section.items.splice(i, 0, task);
}
function findHead(section, group) {
  const key = group.trim().toLowerCase();
  return section.items.findIndex(it => it.kind === 'head' && it.name.toLowerCase() === key);
}
function addHead(section, group) {
  let i = section.items.length;
  while (i > 0 && isBlank(section.items[i - 1])) i--;
  const items = [{ kind: 'head', name: group.trim(), raw: null }];
  if (i > 0) items.unshift({ kind: 'raw', text: '' });
  section.items.splice(i, 0, ...items);
  return i + items.length - 1;
}
// group '' (or none) = above the first ### heading; a missing group gets a new heading at the end of the list.
function insertTask(section, task, group = '') {
  if (!group) {
    const first = section.items.findIndex(it => it.kind === 'head');
    return insertBefore(section, first < 0 ? section.items.length : first, task);
  }
  let h = findHead(section, group);
  if (h < 0) h = addHead(section, group);
  const next = section.items.findIndex((it, i) => i > h && it.kind === 'head');
  // The walk back over blank lines stops at the heading, so the task lands inside its group.
  insertBefore(section, next < 0 ? section.items.length : next, task);
}
function dirty(t) { t.raw = null; t.implicitId = false; }

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
export function ymd(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export function fromYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
export function addDays(s, n) { const d = fromYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
export function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))));
}
export function weekday(s) { return fromYmd(s).getUTCDay(); } // 0 = Sunday

function parts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}
export function todayIn(tz = TZ, now = Date.now()) { const p = parts(now, tz); return `${p.year}-${p.month}-${p.day}`; }
export function nowTimeIn(tz = TZ, now = Date.now()) { const p = parts(now, tz); return `${p.hour}:${p.minute}`; }
function offsetAt(ts, tz) {
  const p = parts(ts, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// Wall-clock time in tz → epoch ms. Correct across daylight saving changes.
export function zonedToEpoch(date, time, tz = TZ) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetAt(guess, tz);
  ts = guess - offsetAt(ts, tz);
  return ts;
}

// ---------- windows (stories L11 and L15) ----------
// est in minutes → "20m", "2h", "1h30m".
export function estLabel(min) { const h = Math.floor(min / 60), m = min % 60; return (h ? h + 'h' : '') + (m || !h ? m + 'm' : ''); }
// "2h", "7d", 7 (days) → { lead, leadH }; anything else clears both.
export function parseLead(v) {
  if (typeof v === 'number') return { lead: v > 0 ? v : null, leadH: null };
  const m = String(v ?? '').trim().match(/^(\d{1,3})\s*([dh])?$/i);
  if (!m || !+m[1]) return { lead: null, leadH: null };
  return (m[2] || 'd').toLowerCase() === 'h' ? { lead: null, leadH: +m[1] } : { lead: +m[1], leadH: null };
}
// "20m", "2h", "1h30m", 20 → minutes, or null.
export function parseEst(v) {
  if (typeof v === 'number') return v > 0 ? v : null;
  const m = String(v ?? '').trim().toLowerCase().match(/^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,3})\s*m(?:in)?)?$/);
  return m && (m[1] || m[2]) ? (+m[1] || 0) * 60 + (+m[2] || 0) || null : null;
}
export const byDate = t => t.by ? t.by.slice(0, 10) : null;
export const byTime = t => t.by && t.by.length > 10 ? t.by.slice(11) : null;
// Epoch ms. A deadline with no hour ends with its day.
export function startEpoch(t, tz = TZ) { return t.due ? zonedToEpoch(t.due, t.at || '00:00', tz) : null; }
export function deadlineEpoch(t, tz = TZ) {
  if (!t.by) return null;
  const d = byDate(t), h = byTime(t);
  return h ? zonedToEpoch(d, h, tz) : zonedToEpoch(addDays(d, 1), '00:00', tz);
}
export function actByEpoch(t, tz = TZ) {
  if (!t.by) return null;
  const d = byDate(t), h = byTime(t);
  const base = t.lead ? (h ? zonedToEpoch(addDays(d, -t.lead), h, tz) : zonedToEpoch(addDays(d, 1 - t.lead), '00:00', tz)) : deadlineEpoch(t, tz);
  return base - (t.leadH || 0) * 3600e3;
}
// The day to act by: the deadline minus the margin; with no deadline, the start day (a plain task).
// A day deadline ends at midnight, so its act-by day is the day before; a deadline at an hour keeps its day (story M5).
export function actBy(t, tz = TZ) { return t.by ? todayIn(tz, actByEpoch(t, tz) - (byTime(t) ? 0 : 1)) : t.due; }
export function actByTime(t, tz = TZ) { return t.by && (byTime(t) || t.leadH) ? nowTimeIn(tz, actByEpoch(t, tz)) : null; }
// The day a task belongs to in the Agenda, the counts and the digest: its start, else its act-by day.
export function dayOf(t, tz = TZ) { return t.due || (t.by ? actBy(t, tz) : null); }
// A fixed start with no deadline (story L24): the token ~start on a task with a date and an hour. It opens at its start.
export const fixedStart = t => !t.by && !!(t.fixed && t.due && t.at);
// before (not yet), window (act now), margin (act by passed, deadline ahead), missed; null with no deadline.
// A fixed start with no deadline is « before » until its start, then a plain task (null).
export function phase(t, now = Date.now(), tz = TZ) {
  if (!t.by) return fixedStart(t) && now < startEpoch(t, tz) ? 'before' : null;
  const s = startEpoch(t, tz);
  if (s !== null && now < s) return 'before';
  if (now < actByEpoch(t, tz)) return 'window';
  return now < deadlineEpoch(t, tz) ? 'margin' : 'missed';
}
// The plan cannot fit: start + estimate is after act by.
export function tooShort(t, tz = TZ) {
  const s = startEpoch(t, tz);
  return !!(t.by && t.est && s !== null && s + t.est * 60e3 > actByEpoch(t, tz));
}

// ---------- recurrence ----------
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function nextOccurrence(every, from) {
  const e = every.toLowerCase();
  if (e === 'day' || e === 'daily') return addDays(from, 1);
  if (e === 'weekday') { let d = addDays(from, 1); while ([0, 6].includes(weekday(d))) d = addDays(d, 1); return d; }
  if (e === 'week' || e === 'weekly') return addDays(from, 7);
  if (e === 'month' || e === 'monthly') return addMonths(from, 1);
  if (e === 'year' || e === 'yearly') return addMonths(from, 12);
  // First office day of the month (Mon-Fri, on or after the 1st; no public holidays).
  if (e === '1wd') {
    const first = (ym) => { let d = ym + '-01'; while ([0, 6].includes(weekday(d))) d = addDays(d, 1); return d; };
    let c = first(from.slice(0, 7));
    if (c <= from) c = first(addMonths(from.slice(0, 8) + '01', 1).slice(0, 7));
    return c;
  }
  let m = e.match(/^(\d+)([dwmy])$/);
  if (m) {
    const n = +m[1];
    return { d: () => addDays(from, n), w: () => addDays(from, 7 * n), m: () => addMonths(from, n), y: () => addMonths(from, 12 * n) }[m[2]]();
  }
  // Nth weekday of the month: 1mon = first Monday, -1fri = last Friday.
  m = e.match(/^(-?[1-4])(sun|mon|tue|wed|thu|fri|sat)$/);
  if (m) {
    const n = +m[1], wd = DAYS.indexOf(m[2]);
    const nth = (ym) => {
      const [y, mo] = ym.split('-').map(Number);
      if (n > 0) { let d = `${y}-${pad(mo)}-01`; while (weekday(d) !== wd) d = addDays(d, 1); return addDays(d, 7 * (n - 1)); }
      let d = ymd(new Date(Date.UTC(y, mo, 0))); while (weekday(d) !== wd) d = addDays(d, -1); return addDays(d, 7 * (n + 1));
    };
    let c = nth(from.slice(0, 7));
    if (c <= from) c = nth(addMonths(from.slice(0, 8) + '01', 1).slice(0, 7));
    return c;
  }
  const days = e.split(',').map(x => DAYS.indexOf(x.slice(0, 3))).filter(x => x >= 0);
  if (days.length) { let d = addDays(from, 1); while (!days.includes(weekday(d))) d = addDays(d, 1); return d; }
  return null;
}
export function isValidEvery(every) { return !!every && nextOccurrence(every, '2026-01-01') !== null; }
// Next due date strictly after today, so an overdue recurring task skips missed slots.
export function rollForward(every, due, today) {
  let d = nextOccurrence(every, due ?? today);
  if (!d) return null;
  for (let i = 0; d <= today && i < 2000; i++) d = nextOccurrence(every, d);
  return d;
}

// A recurring task with a deadline: when due moves, by moves with it. Month-based rules move by in calendar
// months (Nov 4 stays the 4th: Dec 4), day and week rules by the same number of days. The by hour stays.
const MONTHLY_RULE = /^(month|monthly|year|yearly|\d+[my]|1wd|-?[1-4](sun|mon|tue|wed|thu|fri|sat))$/;
export function moveBy(every, oldDue, newDue, by) {
  if (!by || !oldDue || !newDue || !every) return by;
  const d = by.slice(0, 10), h = by.length > 10 ? by.slice(10) : '';
  let nd;
  if (MONTHLY_RULE.test(every.toLowerCase())) {
    const [oy, om] = oldDue.split('-').map(Number), [ny, nm] = newDue.split('-').map(Number);
    nd = addMonths(d, (ny * 12 + nm) - (oy * 12 + om));
  } else nd = addDays(d, Math.round((fromYmd(newDue) - fromYmd(oldDue)) / 864e5));
  return nd + h;
}

export function describeEvery(every) {
  if (!every) return '';
  const e = every.toLowerCase();
  const map = { day: 'Daily', daily: 'Daily', weekday: 'Weekdays', week: 'Weekly', weekly: 'Weekly', month: 'Monthly', monthly: 'Monthly', year: 'Yearly', yearly: 'Yearly' };
  if (map[e]) return map[e];
  if (e === '1wd') return 'Monthly, 1st office day';
  const m = e.match(/^(\d+)([dwmy])$/);
  if (m) return `Every ${m[1]} ${{ d: 'days', w: 'weeks', m: 'months', y: 'years' }[m[2]]}`;
  const n = e.match(/^(-?[1-4])(\w{3})$/);
  if (n) return `Monthly, ${{ 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', '-1': 'last' }[n[1]]} ${n[2].slice(0, 1).toUpperCase() + n[2].slice(1)}`;
  return 'Every ' + e.split(',').map(x => x.slice(0, 1).toUpperCase() + x.slice(1, 3)).join(', ');
}

// The note line that notify.mjs sends with the reminder: the first non-blank line that is not a checklist item
// or a habit log.
export function firstNoteLine(notes) {
  const lines = Array.isArray(notes) ? notes : String(notes || '').split('\n');
  return lines.find(n => n.trim() && !/^\s*- \[[ xX]\]/.test(n) && !HABIT_LOG_RE.test(n)) || '';
}

// ---------- habits ----------
export const HABIT_LOG_RE = /^\s*✓ /;
const HABIT_LOG_MAX = 60;
export function isStickies(doc, list) {
  return !!doc.sections.find(x => x.name.toLowerCase() === String(list || '').toLowerCase())?.stickies;
}
export function isHabits(doc, list) {
  return !!doc.sections.find(x => x.name.toLowerCase() === String(list || '').toLowerCase())?.habits;
}
// The check-in dates of a habit, oldest first, from its "✓ …" note line.
export function habitLog(t) {
  const l = t.notes.find(n => HABIT_LOG_RE.test(n));
  return l ? l.trim().slice(2).split(/\s+/).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
}
function setHabitLog(t, dates) {
  const line = dates.length ? '✓ ' + dates.slice(-HABIT_LOG_MAX).join(' ') : null;
  const i = t.notes.findIndex(n => HABIT_LOG_RE.test(n));
  if (i >= 0) { if (line) t.notes[i] = line; else t.notes.splice(i, 1); } else if (line) t.notes.push(line);
}
// The slot a habit waits for: its due date, or the first slot from today when that date has passed.
// For display and reminders only: never write it back, so a miss stays visible to the streak.
export function habitDue(t, today = todayIn()) {
  if (!t.due || !t.every || t.due >= today) return t.due;
  let d = t.due;
  for (let i = 0; d < today && i < 2000; i++) d = nextOccurrence(t.every, d) || today;
  return d;
}

// ---------- operations ----------
// An op is plain JSON, so the app can queue it offline and replay it on a fresh copy of the file.
export function apply(doc, op, today = todayIn()) {
  switch (op.type) {
    case 'add': {
      const t = { kind: 'task', id: op.id || newId(), title: op.title.trim(), due: op.due || null, at: op.at || null, every: op.every || null,
        prio: op.prio || 0, tags: op.tags || [], firm: !!op.firm, fixed: !!op.fixed, ...parseLead(op.leadH ? op.leadH + 'h' : op.lead), by: op.by || null, est: parseEst(op.est),
        checked: false, doing: false, done: null, notes: op.notes ? op.notes.split('\n') : [], raw: null };
      if (isStickies(doc, op.list) && t.due && !t.by) { t.by = t.due; t.due = null; } // a sticky deadline lives in by: (story L15)
      if (isHabits(doc, op.list) && !t.every) t.every = 'day';
      if ('streak' in op) t.streak = op.streak;
      if (t.every && !t.due) t.due = today;
      if (findTask(doc, t.id)) return t.id; // replayed op
      const same = stockMatch(doc, op.list, t.title);
      if (same) { // a stock item comes back to buy: no duplicate
        if (same.checked) { same.checked = false; same.doing = false; same.done = null; dirty(same); }
        return same.id;
      }
      insertTask(getSection(doc, op.list || 'Inbox'), t, op.group || '');
      return t.id;
    }
    case 'update': {
      const f = findTask(doc, op.id);
      if (!f) return null;
      const t = f.task, p = op.patch;
      for (const k of ['title', 'due', 'at', 'every', 'prio', 'tags']) if (k in p) t[k] = p[k];
      if ('firm' in p) t.firm = !!p.firm;
      if ('fixed' in p) t.fixed = !!p.fixed;
      if ('lead' in p) Object.assign(t, parseLead(p.lead));
      if ('by' in p) t.by = p.by || null;
      if ('est' in p) t.est = parseEst(p.est);
      if (isStickies(doc, f.section.name)) { // a sticky deadline lives in by: (story L15); clearing due clears it
        if ('due' in p && !('by' in p)) t.by = p.due || null;
        if (t.due && !t.every) { t.by = t.by || t.due; t.due = null; }
      }
      if ('doing' in p) t.doing = !!p.doing && !t.checked;
      if ('streak' in p) t.streak = p.streak;
      if ('notes' in p) {
        const log = t.notes.find(n => HABIT_LOG_RE.test(n));
        t.notes = p.notes ? p.notes.split('\n') : [];
        if (log && !t.notes.some(n => HABIT_LOG_RE.test(n))) t.notes.push(log); // the history survives a notes edit
      }
      if (t.every && !t.due) t.due = today;
      dirty(t);
      const toList = p.list && p.list.toLowerCase() !== f.section.name.toLowerCase();
      const toGroup = 'group' in p && (p.group || '').toLowerCase() !== f.group.toLowerCase();
      if (toList || toGroup) {
        // A task moves with its notes: they are part of the task item.
        f.section.items.splice(f.index, 1);
        insertTask(toList ? getSection(doc, p.list) : f.section, t, 'group' in p ? p.group || '' : toList ? '' : f.group);
      }
      return t.id;
    }
    case 'complete': {
      const f = findTask(doc, op.id);
      if (!f || f.task.checked) return null;
      const t = f.task;
      if (t.every && (op.due === undefined || t.due === op.due)) {
        // Recurring: move to the next slot, keep it open. op.due guards against a double replay.
        const td = op.today || today;
        if (f.section.habits) {
          const log = habitLog(t);
          if (log.includes(td)) return null; // one check-in a day: a second one would eat tomorrow's slot
          // The stored due is before today only when a slot passed without a check-in. streak:off logs, never counts.
          if (t.streak !== 'off') t.streak = t.due && t.due < td ? 1 : (t.streak || 0) + 1;
          setHabitLog(t, [...log, td]);
        }
        const next = rollForward(t.every, t.due, td);
        if (!f.section.habits) t.by = moveBy(t.every, t.due, next, t.by);
        t.due = next;
        t.notes = t.notes.map(n => n.replace(/^- \[[xX]\]/, '- [ ]'));
      } else if (!t.every) {
        t.checked = true;
        t.doing = false;
        t.done = op.today || today;
      } else return null;
      dirty(t);
      if (f.section.stock && !f.group) {
        // A new stock item goes to Rare after its first purchase; the user moves it if they buy it often.
        f.section.items.splice(f.index, 1);
        insertTask(f.section, t, RARE);
      }
      return t.id;
    }
    case 'reopen': {
      const f = findTask(doc, op.id);
      if (!f) return null;
      if (op.due) f.task.due = op.due;
      if ('by' in op) f.task.by = op.by || null; // undo of a recurring completion: by moved with due
      if ('streak' in op) f.task.streak = op.streak; // undo of a habit check-in
      if ('notes' in op) f.task.notes = op.notes ? op.notes.split('\n') : [];
      f.task.checked = false; f.task.doing = false; f.task.done = null; dirty(f.task);
      return f.task.id;
    }
    case 'uncheck': {
      // Undo today's check-in of a habit (a tap by mistake): today leaves the log, the streak drops by 1
      // and the habit waits for today again. Replay-safe: it acts only while today is in the log.
      const f = findTask(doc, op.id);
      if (!f || !f.section.habits) return null;
      const t = f.task, td = op.today || today, log = habitLog(t);
      if (!log.includes(td)) return null;
      setHabitLog(t, log.filter(d => d !== td));
      if (t.streak !== 'off') t.streak = Math.max(0, (t.streak || 0) - 1);
      t.due = td;
      dirty(t);
      return t.id;
    }
    case 'toggleNote': {
      const f = findTask(doc, op.id);
      if (!f) return null;
      const n = f.task.notes[op.line];
      if (n === undefined) return null;
      f.task.notes[op.line] = n.replace(/^(\s*- \[)([ xX])\]/, (_, a, c) => a + (c === ' ' ? 'x' : ' ') + ']');
      dirty(f.task);
      return f.task.id;
    }
    case 'delete': {
      const f = findTask(doc, op.id);
      if (!f) return null;
      f.section.items.splice(f.index, 1);
      return op.id;
    }
    case 'addList': {
      const s = getSection(doc, op.name);
      for (const t of MARKED) if (op[t.id] && !s[t.id]) { s[t.id] = true; s.raw = null; }
      if (op.color && op.color !== s.color) { s.color = op.color; s.raw = null; }
      return op.name;
    }
    case 'addGroup': {
      const s = getSection(doc, op.list);
      if (findHead(s, op.name) < 0) addHead(s, op.name);
      return op.name;
    }
    case 'clearDone': {
      // Remove checked tasks completed before op.before.
      let n = 0;
      for (const s of doc.sections) if (!s.stock) s.items = s.items.filter(it => !(it.kind === 'task' && it.checked && (it.done ?? '0') < op.before && ++n));
      return n;
    }
    default: throw new Error('Unknown op ' + op.type);
  }
}

export function describeOp(op, doc) {
  const name = id => findTask(doc, id)?.task.title ?? id;
  switch (op.type) {
    case 'add': return `ajout « ${op.title} »`;
    case 'update': return `modif « ${name(op.id)} »`;
    case 'complete': return `fait « ${name(op.id)} »`;
    case 'reopen': return `rouvert « ${name(op.id)} »`;
    case 'uncheck': return `décoché « ${name(op.id)} »`;
    case 'toggleNote': return `sous-tâche de « ${name(op.id)} »`;
    case 'delete': return `suppression ${op.id}`;
    case 'addList': return `liste « ${op.name} »`;
    case 'addGroup': return `section « ${op.name} » dans ${op.list}`;
    case 'clearDone': return `nettoyage des tâches faites`;
  }
  return op.type;
}

// ---------- quick add ----------
// "Appeler la banque demain 9h #admin !1 @Life" → fields. French and English.
const MONTHS = { jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, fev: 2, 'fév': 2, fevr: 2, 'févr': 2, fevrier: 2, 'février': 2, february: 2,
  mar: 3, mars: 3, march: 3, apr: 4, avr: 4, avril: 4, april: 4, may: 5, mai: 5, jun: 6, juin: 6, june: 6, jul: 7, juil: 7, juillet: 7, july: 7,
  aug: 8, aou: 8, 'aoû': 8, aout: 8, 'août': 8, august: 8, sep: 9, sept: 9, septembre: 9, september: 9, oct: 10, octobre: 10, october: 10,
  nov: 11, novembre: 11, november: 11, dec: 12, 'déc': 12, decembre: 12, 'décembre': 12, december: 12 };
const WD = { sun: 0, sunday: 0, dim: 0, dimanche: 0, mon: 1, monday: 1, lun: 1, lundi: 1, tue: 2, tues: 2, tuesday: 2, mar: 2, mardi: 2,
  wed: 3, wednesday: 3, mer: 3, mercredi: 3, thu: 4, thur: 4, thursday: 4, jeu: 4, jeudi: 4, fri: 5, friday: 5, ven: 5, vendredi: 5,
  sat: 6, saturday: 6, sam: 6, samedi: 6 };
const WD_FULL = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi|sun|mon|tue|wed|thu|fri|sat|dim|lun|mer|jeu|ven|sam';
const B = '(?<=^|\\s)';
const E = '(?=$|[\\s,.!?;])';

function nextWeekday(today, wd, strict = true) {
  let d = addDays(today, strict ? 1 : 0);
  while (weekday(d) !== wd) d = addDays(d, 1);
  return d;
}

export function parseQuick(input, { today = todayIn(), now = nowTimeIn(), lists = [] } = {}) {
  let s = ' ' + input + ' ';
  const r = { title: '', due: null, at: null, every: null, prio: 0, tags: [], list: null, firm: false, fixed: false, lead: null, leadH: null, by: null, est: null, spans: [] };
  const take = (re, fn) => {
    s = s.replace(re, (...m) => { const v = fn(...m); if (v === false) return m[0]; r.spans.push(m[0].trim()); return ' '; });
  };
  const ci = (src) => new RegExp(src, 'giu');

  take(ci(`${B}#([\\p{L}\\p{N}_/-]+)${E}`), (_, t) => { r.tags.push(t); });
  take(ci(`${B}!([123])${E}`), (_, p) => { r.prio = +p; });
  take(ci(`${B}!(high|haute|med|medium|low|basse)${E}`), (_, p) => { r.prio = /^h/i.test(p) ? 1 : /^m/i.test(p) ? 2 : 3; });
  take(ci(`${B}@([\\p{L}\\p{N}_-]+)${E}`), (_, l) => {
    const key = l.toLowerCase();
    const hit = lists.find(x => x.toLowerCase().replace(/\s+/g, '') === key) || lists.find(x => x.toLowerCase().replace(/\s+/g, '').startsWith(key));
    r.list = hit || l;
  });
  // Raw tokens from the file syntax.
  take(ci(`${B}due:(\\d{4}-\\d{2}-\\d{2})${E}`), (_, d) => { r.due = d; });
  take(ci(`${B}every:(\\S+)${E}`), (_, e) => { r.every = e; });
  take(ci(`${B}~firm${E}`), () => { r.firm = true; }); // a firm deadline (stickies)
  take(ci(`${B}~start${E}`), () => { r.fixed = true; }); // a fixed start: not before due + at (L24)
  take(ci(`${B}lead:(\\d{1,3})([dh])${E}`), (_, n, u) => { Object.assign(r, parseLead(n + u)); }); // the margin before the deadline (L11, L15)
  take(ci(`${B}by:(\\d{4}-\\d{2}-\\d{2})(?:T(\\d{1,2}:\\d{2}))?${E}`), (_, d, h) => { r.by = h ? `${d}T${h.padStart(5, '0')}` : d; }); // the deadline (L15)
  take(ci(`${B}est:((?:\\d{1,2}h)?(?:\\d{1,3}m)?)${E}`), (_, v) => { const e = parseEst(v); if (!e) return false; r.est = e; }); // the estimate (L15)

  // Recurrence.
  const rec = [
    [`(?:every ?day|daily|chaque jour|tous les jours|quotidien)`, 'day'],
    [`(?:every ?weekday|weekdays|en semaine|jours ouvrés|jours ouvres)`, 'weekday'],
    [`(?:every ?week|weekly|chaque semaine|toutes les semaines|hebdo)`, 'week'],
    [`(?:every ?month|monthly|chaque mois|tous les mois|mensuel)`, 'month'],
    [`(?:every ?year|yearly|chaque année|chaque annee|tous les ans|annuel)`, 'year'],
  ];
  for (const [src, val] of rec) take(ci(`${B}${src}${E}`), () => { r.every = val; });
  take(ci(`${B}(?:every|chaque|tous les|toutes les) (\\d+) (days?|jours?|weeks?|semaines?|months?|mois|years?|ans?)${E}`), (_, n, u) => {
    r.every = n + (/^(d|j)/i.test(u) ? 'd' : /^(w|s)/i.test(u) ? 'w' : /^m/i.test(u) ? 'm' : 'y');
  });
  take(ci(`${B}(?:every|chaque|tous les|toutes les) ((?:${WD_FULL})s?(?:(?:,| and | et | ?& ?)(?:${WD_FULL})s?)*)${E}`), (_, days) => {
    const list = days.split(/,| and | et |&/).map(x => x.trim().toLowerCase().replace(/s$/, '')).map(x => WD[x] ?? WD[x + 's']).filter(x => x !== undefined);
    if (!list.length) return false;
    r.every = list.map(d => DAYS[d]).join(',');
    if (!r.due) r.due = nextWeekday(today, list[0], false);
  });

  // Time.
  const setTime = (h, m, ap) => {
    h = +h; m = +(m || 0);
    if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
    if (h > 23 || m > 59) return false;
    r.at = `${pad(h)}:${pad(m)}`;
  };
  take(ci(`${B}(?:(?:à|a|at|@) )?(\\d{1,2})h(\\d{2})?${E}`), (_, h, m) => setTime(h, m));
  take(ci(`${B}(?:(?:à|a|at|@) )?(\\d{1,2}):(\\d{2}) ?(am|pm)?${E}`), (_, h, m, ap) => setTime(h, m, ap));
  take(ci(`${B}(?:(?:à|a|at|@) )?(\\d{1,2}) ?(am|pm)${E}`), (_, h, ap) => setTime(h, 0, ap));
  take(ci(`${B}(?:noon|midi)${E}`), () => setTime(12, 0));
  take(ci(`${B}(?:ce soir|tonight)${E}`), () => { r.due = r.due || today; if (!r.at) setTime(19, 0); });

  // Date.
  const setDue = d => { r.due = d; };
  take(ci(`${B}(?:today|tod|aujourd'hui|aujourd’hui|auj)${E}`), () => setDue(today));
  take(ci(`${B}(?:après-demain|apres-demain|après demain|apres demain|day after tomorrow)${E}`), () => setDue(addDays(today, 2)));
  take(ci(`${B}(?:tomorrow|tmr|tmrw|demain|dem)${E}`), () => setDue(addDays(today, 1)));
  take(ci(`${B}(?:next week|semaine prochaine|la semaine prochaine)${E}`), () => setDue(nextWeekday(today, 1)));
  take(ci(`${B}(?:next month|mois prochain|le mois prochain)${E}`), () => setDue(addMonths(today.slice(0, 8) + '01', 1)));
  take(ci(`${B}(?:this weekend|ce week-end|ce weekend|weekend|week-end)${E}`), () => setDue(nextWeekday(today, 6, false)));
  take(ci(`${B}(?:in|dans) (\\d+) (days?|jours?|weeks?|semaines?|months?|mois)${E}`), (_, n, u) => {
    setDue(/^(d|j)/i.test(u) ? addDays(today, +n) : /^(w|s)/i.test(u) ? addDays(today, 7 * n) : addMonths(today, +n));
  });
  take(ci(`${B}(\\d{4})-(\\d{2})-(\\d{2})${E}`), (_, y, m, d) => setDue(`${y}-${m}-${d}`));
  const dm = (d, m, y) => {
    d = +d; m = +m;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    let yr = y ? (y.length === 2 ? 2000 + +y : +y) : +today.slice(0, 4);
    let out = `${yr}-${pad(m)}-${pad(d)}`;
    if (!y && out < today) out = `${yr + 1}-${pad(m)}-${pad(d)}`;
    setDue(out);
  };
  take(ci(`${B}(?:(?:le|on) )?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?${E}`), (_, d, m, y) => dm(d, m, y));
  take(ci(`${B}(?:(?:le|on) )?(\\d{1,2})(?:er)? ([\\p{L}]+)\\.?(?: (\\d{4}))?${E}`), (_, d, mon, y) => {
    const m = MONTHS[mon.toLowerCase()];
    return m ? dm(d, m, y) : false;
  });
  take(ci(`${B}([\\p{L}]+)\\.? (\\d{1,2})(?:st|nd|rd|th)?${E}`), (_, mon, d) => {
    const m = MONTHS[mon.toLowerCase()];
    return m && mon.length >= 3 && !(mon.toLowerCase() in WD) ? dm(d, m) : false;
  });
  take(ci(`${B}(?:(?:on|le|ce) )?(?:(next|prochain) )?(${WD_FULL})(?: (prochain|next))?${E}`), (_, a, w, b) => {
    const wd = WD[w.toLowerCase()];
    if (wd === undefined) return false;
    // A bare 3-letter French day that is also a common word stays in the title.
    if (['mar', 'sam', 'dim', 'ven', 'mer'].includes(w.toLowerCase()) && !a && !b) return false;
    setDue(nextWeekday(today, wd));
  });

  if (r.at && !r.due) r.due = r.at > now ? today : addDays(today, 1);
  if (r.every && !r.due) r.due = today;
  r.title = s.replace(/\s+/g, ' ').trim();
  return r;
}

// ---------- views ----------
export function reminderEpoch(t, tz = TZ) {
  if (t.checked || !t.due || !t.at) return null;
  return zonedToEpoch(t.due, t.at, tz);
}

export function sortTasks(a, b) {
  const da = a.task.due ?? '9999', db = b.task.due ?? '9999';
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.task.at ?? '99', tb = b.task.at ?? '99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a.task.prio || 9) - (b.task.prio || 9);
}
