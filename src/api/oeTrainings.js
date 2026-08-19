import { getCurrentEnv } from '../config/fmpEnvironments';

// OE Trainings — registrations on course sessions, from Vibe's normalised store.
//
// One Workshops_New row is ONE PERSON on ONE session, so a session's roster is
// many rows sharing a course number. See docs/oe-trainings-scope.md.

const qs = extra => `db=${encodeURIComponent(getCurrentEnv().db)}&${extra}`;

async function get(extra) {
  const res = await fetch(`/api/oe-training?${qs(extra)}`, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/** Every session Vibe holds registrations for: `[{ course, count }]`.
 *  Reads an index of ids, so it never loads a row. */
export const listCourses = () => get('courses=1').then(b => b.courses || []);

/** One session's roster. */
export const getRoster = course =>
  get(`course=${encodeURIComponent(course)}`).then(b => b.workshops || []);

/** Normalised course key — matches the server's, so a code typed or stored with
 *  a stray carriage return or in lower case still finds its session. */
export const courseKey = v => String(v ?? '').replace(/[\r\n]+/g, '').trim().toUpperCase();

// ── Money ───────────────────────────────────────────────────────────────────
//
// COMPUTED, never read from the stored value, even though the stored value is
// present and currently correct. `Fee Total`, `Deposit Due` and `Balance Due`
// are FileMaker calculations: they freeze at cutover and would then be right for
// every existing registration and silently wrong for every new one.
//
// The arithmetic was measured over 1,500 recent rows with NO exceptions
// (docs/oe-trainings-scope.md §2), so this reproduces FileMaker exactly rather
// than approximating it.

const n = v => { const x = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };

/** Tuition + Food + Lodging + Extra Lodging. 1500/1500 agreement. */
export const feeTotal = w =>
  n(w?.tuitionFee) + n(w?.foodFee) + n(w?.lodgingFee) + n(w?.extraLodgingFee);

/** Half the fee. 1397/1397 agreement among rows with a non-zero fee. */
export const depositDue = w => Math.round(feeTotal(w) * 50) / 100;

/** Fee total less what has been received. 1500/1500 agreement. */
export const balanceDue = w => Math.round((feeTotal(w) - n(w?.depositReceived)) * 100) / 100;

/** Session-level totals, for the roster header. */
export function rosterTotals(rows) {
  const t = { registrants: 0, fees: 0, received: 0, outstanding: 0, unassigned: 0 };
  for (const w of rows || []) {
    t.registrants += 1;
    t.fees += feeTotal(w);
    t.received += n(w.depositReceived);
    t.outstanding += balanceDue(w);
    if (!w.contactId) t.unassigned += 1;
  }
  for (const k of ['fees', 'received', 'outstanding']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

export const money = v =>
  n(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
