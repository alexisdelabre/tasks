// Reminder job: sync the ntfy schedule with the tasks file.
// Runs in GitHub Actions on each push of the tasks file and every few hours.
// ntfy holds each reminder as a scheduled message (up to 3 days ahead), keyed by
// a sequence id: publishing again replaces it, DELETE cancels it. So every run is idempotent.
//
// Env: NTFY_TOPIC (required), NTFY_SERVER, NTFY_TOKEN, TASKS_FILE, TASKS_TZ, APP_URL, DIGEST_AT.
// Flags: --dry (print the plan, send nothing).
import { readFileSync } from 'node:fs';
import * as C from './core.mjs';

const SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const TOPIC = process.env.NTFY_TOPIC;
const FILE = process.env.TASKS_FILE || 'Tasks.md';
const TZ = process.env.TASKS_TZ || C.TZ; // an IANA zone, e.g. Europe/Paris
const APP = process.env.APP_URL || '';
const DIGEST_AT = process.env.DIGEST_AT || '08:00';
const DRY = process.argv.includes('--dry');
const HORIZON = 3 * 24 * 3600e3 - 10 * 60e3; // ntfy.sh limit: 3 days
const CATCH_UP = 45 * 60e3; // send at once a reminder missed by less than this

if (!TOPIC) { console.error('NTFY_TOPIC is not set'); process.exit(1); }
const auth = process.env.NTFY_TOKEN ? { Authorization: 'Bearer ' + process.env.NTFY_TOKEN } : {};

const now = Date.now();
const today = C.todayIn(TZ, now);
const doc = C.parse(readFileSync(FILE, 'utf8'));
const open = C.allTasks(doc).filter(x => !x.task.checked);

// ---------- what ntfy should hold ----------
const want = new Map();
const habitLists = new Set(doc.sections.filter(s => s.habits).map(s => s.name));
for (const { task: t, list } of open) {
  // A missed habit waits for its next slot from today, so its reminder keeps coming.
  const at = C.reminderEpoch(habitLists.has(list) ? { ...t, due: C.habitDue(t, today) } : t, TZ);
  if (at === null || at > now + HORIZON || at < now - CATCH_UP) continue;
  const note = C.firstNoteLine(t.notes);
  want.set('t-' + t.id, {
    at, title: t.title,
    message: [`${list} · ${t.at}${t.every ? ' · ' + C.describeEvery(t.every) : ''}`, note].filter(Boolean).join('\n'),
    priority: t.prio === 1 ? 5 : t.prio === 2 ? 4 : 3,
    tags: ['alarm_clock'],
  });
}

// A task with a deadline at an hour (story L15) gets a second reminder at act by (deadline − margin), while it is open.
for (const { task: t, list } of open) {
  if (habitLists.has(list) || !C.actByTime(t) || !(t.lead || t.leadH)) continue;
  const at = C.actByEpoch(t, TZ);
  if (at > now + HORIZON || at < now - CATCH_UP) continue;
  want.set('a-' + t.id, {
    at, title: t.title,
    message: `${list} · act by now · deadline ${C.byTime(t) || C.byDate(t)}`,
    priority: 4,
    tags: ['hourglass'],
  });
}

// Morning digest: open tasks of the next digest day or before (start day, else act-by day). Habits stay out of it.
const digestDay = C.nowTimeIn(TZ, now) < DIGEST_AT ? today : C.addDays(today, 1);
const due = open.filter(x => !habitLists.has(x.list) && C.dayOf(x.task, TZ) && C.dayOf(x.task, TZ) <= digestDay).sort(C.sortTasks);
if (due.length) {
  const late = due.filter(x => C.dayOf(x.task, TZ) < digestDay).length;
  want.set('digest-' + digestDay, {
    at: C.zonedToEpoch(digestDay, DIGEST_AT, TZ),
    title: `${due.length} task${due.length > 1 ? 's' : ''} today${late ? ` (${late} overdue)` : ''}`,
    message: due.slice(0, 12).map(({ task: t }) => `${C.dayOf(t, TZ) < digestDay ? '⚠ ' : ''}${t.at ? t.at + ' ' : ''}${t.title}`).join('\n')
      + (due.length > 12 ? `\n+${due.length - 12} more` : ''),
    priority: 3,
    tags: ['sunrise'],
  });
}

// ---------- what ntfy holds now ----------
const res = await fetch(`${SERVER}/${TOPIC}/json?poll=1&sched=1&since=all`, { headers: auth });
if (!res.ok) throw new Error(`poll ${res.status}`);
const have = new Map(); // sequence id → latest event
for (const line of (await res.text()).split('\n').filter(Boolean)) {
  const e = JSON.parse(line);
  const seq = e.sequence_id || e.id;
  if (e.event === 'message' || e.event === 'message_delete') have.set(seq, e);
}

// ---------- diff ----------
const actions = [];
for (const [seq, m] of want) {
  const h = have.get(seq);
  const atSec = Math.floor(m.at / 1000);
  const same = h && h.event === 'message' && h.title === m.title && h.message === m.message && Math.abs(h.time - atSec) < 60;
  if (same) continue;
  if (m.at <= now + 15e3) {
    // Missed slot: send now, unless it already went out.
    if (h && h.event === 'message' && h.title === m.title) continue;
    actions.push(['send-now', seq, m]);
  } else actions.push(['schedule', seq, m]);
}
for (const [seq, h] of have) {
  if (want.has(seq) || h.event !== 'message' || h.time * 1000 <= now) continue;
  if (seq.startsWith('t-') || seq.startsWith('a-') || seq.startsWith('digest-')) actions.push(['cancel', seq]);
}

for (const [kind, seq, m] of actions) {
  console.log(kind.padEnd(9), seq.padEnd(18), m ? `${new Date(m.at).toISOString()}  ${m.title}` : '');
  if (DRY) continue;
  if (kind === 'cancel') {
    const r = await fetch(`${SERVER}/${TOPIC}/${seq}`, { method: 'DELETE', headers: auth });
    if (!r.ok) console.error('  cancel failed', r.status, await r.text());
    continue;
  }
  const body = { topic: TOPIC, sequence_id: seq, title: m.title, message: m.message, priority: m.priority, tags: m.tags };
  if (APP) body.click = APP;
  if (kind === 'schedule') body.delay = String(Math.floor(m.at / 1000));
  const r = await fetch(SERVER + '/', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) console.error('  publish failed', r.status, await r.text());
}
console.log(`${open.length} open tasks, ${want.size} wanted, ${actions.length} change(s)${DRY ? ' (dry run)' : ''}`);
