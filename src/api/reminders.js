// Reminders client — thin wrapper over /api/google calendar actions. Reminders
// are real Google Calendar events on the user's primary calendar, tagged so the
// app can find them. Google handles the actual time-based notifications.
//
// recordType is the app moduleId of the linked record (e.g. 'contacts',
// 'projects', 'estimates') so a reminder's chip can deep-link straight back.

const ENDPOINT = '/api/google';
const DAY = 86400000;
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

async function call(action, payload = {}) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  // On localhost there are no serverless functions; the dev server returns HTML.
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function mapEvent(ev) {
  const ext = ev.extendedProperties?.private || {};
  // Lead time (minutes before start) for the in-app "in X" heads-up toast,
  // derived from the event's own reminder overrides so it matches what the user
  // picked in the modal. 0 = "at time of event" (no heads-up, just the "now").
  const ov = ev.reminders?.overrides || [];
  const lead = ov.length ? Math.max(0, ...ov.map(o => o.minutes ?? 0)) : (ev.reminders?.useDefault ? 10 : 0);
  return {
    id: ev.id,
    title: ev.summary || '(no title)',
    notes: ev.description || '',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    lead,
    recordType: ext.recordType || null,
    recordId: ext.recordId || null,
    recordLabel: ext.recordLabel || '',
    done: ext.done === '1',
    htmlLink: ev.htmlLink || null,
  };
}

export async function listReminders({ recordId, daysBack = 30, daysAhead = 180 } = {}) {
  const now = Date.now();
  const timeMin = new Date(now - daysBack * DAY).toISOString();
  const timeMax = new Date(now + daysAhead * DAY).toISOString();
  const data = await call('calendar.list', { timeMin, timeMax, recordId });
  return (data.items || []).map(mapEvent);
}

export async function createReminder({ title, notes, startISO, durationMin = 30, recordType, recordId, recordLabel, overrides }) {
  const endISO = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString();
  const ev = await call('calendar.create', { title, notes, startISO, endISO, timeZone: tz(), recordType, recordId, recordLabel, overrides });
  notifyRemindersChanged();
  return mapEvent(ev);
}

export async function updateReminder(id, { title, notes, startISO, durationMin = 30, overrides } = {}) {
  const patch = { id, timeZone: tz() };
  if (title !== undefined) patch.title = title;
  if (notes !== undefined) patch.notes = notes;
  if (startISO) { patch.startISO = startISO; patch.endISO = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString(); }
  if (overrides) patch.overrides = overrides;
  const ev = await call('calendar.update', patch);
  notifyRemindersChanged();
  return mapEvent(ev);
}

export async function completeReminder(id, done = true) {
  const ev = await call('calendar.update', { id, done });
  notifyRemindersChanged();
  return mapEvent(ev);
}

export async function snoozeReminder(id, startISO, durationMin = 30) {
  const endISO = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString();
  const ev = await call('calendar.update', { id, startISO, endISO, timeZone: tz() });
  notifyRemindersChanged();
  return mapEvent(ev);
}

export async function deleteReminder(id) {
  await call('calendar.delete', { id });
  notifyRemindersChanged();
  return true;
}

// ── Lightweight change subscription ──────────────────────────────
// Surfaces (the page, the per-record panel, the nav badge) subscribe so they
// refresh after any mutation, wherever it happened.
const subs = new Set();
export function subscribeReminders(cb) { subs.add(cb); return () => subs.delete(cb); }
export function notifyRemindersChanged() { subs.forEach(cb => { try { cb(); } catch { /* ignore */ } }); }

// ── Bucketing helper for agenda views ────────────────────────────
export function bucketReminders(items) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + DAY;
  const endOfWeek = endOfToday + 6 * DAY;
  const groups = { overdue: [], today: [], week: [], later: [], done: [] };
  for (const r of items) {
    if (r.done) { groups.done.push(r); continue; }
    const t = r.start ? new Date(r.start).getTime() : Infinity;
    if (t < startOfToday) groups.overdue.push(r);
    else if (t < endOfToday) groups.today.push(r);
    else if (t < endOfWeek) groups.week.push(r);
    else groups.later.push(r);
  }
  return groups;
}

// Count of things that need attention now: overdue + due today, not done.
export function dueCount(items) {
  const g = bucketReminders(items);
  return g.overdue.length + g.today.length;
}
