// The four tiles a record's money strip shows: Estimated value, Received,
// Balance due, Event date.
//
// Lives here rather than in RecordLayout.jsx because that module states at the
// top that it is PRESENTATION ONLY — it takes finished values and renders them.
// This decides what the values ARE, which is a different job.
//
//
// ONE BUILDER, CALLED BY BOTH CCS AND TRAININGS, because "make Trainings match
// CCS" is only true for as long as nobody edits one of them. Two hand-written
// copies of the same four tiles had already drifted: CCS showed Event date,
// Trainings showed Invoiced; CCS labelled the first tile "Estimated value",
// Trainings "Estimated"; and CCS coloured Received and Balance due while
// Trainings coloured only Balance due, with the status colour rather than a
// money one.
//
// The tones were also RAW HEX INLINE IN JSX — #0f6e56 and #854f0b — which is
// why the branding sweep never reached them: it read stylesheets. They are
// --success-fg and --warning-fg now, so they follow the theme like everything
// else, instead of being two fixed colours that only worked on a light ground.

const fmMoney = v => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

const fmDate = v => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? '').trim());
  if (!m) return String(v ?? '') || '—';
  const d = new Date(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00`);
  return isNaN(d) ? (String(v) || '—') : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const daysTo = v => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v ?? '').trim());
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00`);
  if (isNaN(d)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
};

/** The four tiles a record's money strip shows: Estimated value, Received,
 *  Balance due, Event date.
 *
 *  `live` says the figures came from QuickBooks rather than a stored field,
 *  which is what the "live from QuickBooks" sub-label reports. `urgent` marks
 *  an event that is close AND not yet paid — the sub goes amber.
 */
export function financialTiles({ estimated, received, balanceDue, eventDate, live = false, urgent = false }) {
  const days = daysTo(eventDate);
  const when = days == null ? null
    : days < 0 ? `${-days}d ago`
    : days === 0 ? 'today'
    : `in ${days}d`;
  return [
    { label: 'Estimated value', value: fmMoney(estimated), sub: live ? 'live from QuickBooks' : undefined },
    { label: 'Received', value: fmMoney(received),
      tone: received ? 'var(--success-fg)' : undefined,
      sub: live ? 'live from QuickBooks' : undefined },
    { label: 'Balance due', value: fmMoney(balanceDue),
      tone: balanceDue ? 'var(--warning-fg)' : undefined,
      sub: live ? (balanceDue === 0 ? 'paid in full' : 'live from QuickBooks') : undefined },
    { label: 'Event date', value: fmDate(eventDate), sub: when, subUrgent: urgent && !!when },
  ];
}

