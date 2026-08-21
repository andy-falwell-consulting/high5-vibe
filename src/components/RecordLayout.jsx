// Presentational pieces of the CCS record layout, extracted so other modules
// can wear the same page.
//
// Deliberately PRESENTATION ONLY — every piece takes finished values and
// renders them. Each module keeps its own data fetching, its own field names
// and its own vocabulary, because those are exactly the parts that differ:
// CCS stores QuickBooks references in repeating fields, Trainings in single
// ones; CCS has builders, Trainings has trainers.
//
// Classes stay `cv2-` so both modules share one stylesheet rather than
// duplicating it under a second prefix.
import './CCSv2.css';

/** A bordered card with an uppercase head and an optional right-hand action. */
export function LayoutCard({ title, action, children, className = '' }) {
  return (
    <div className={`cv2-card ${className}`.trim()}>
      <div className="cv2-card-head"><span>{title}</span>{action}</div>
      {children}
    </div>
  );
}

/** The four-across figure strip. Values arrive formatted. */
export function StatTiles({ tiles }) {
  return (
    <div className="cv2-kpis">
      {tiles.map(t => (
        <div className="cv2-kpi" key={t.label}>
          <div className="cv2-kpi-label">{t.label}</div>
          <div className="cv2-kpi-num" style={t.tone ? { color: t.tone } : undefined}>{t.value}</div>
          {t.sub && <div className={`cv2-kpi-sub${t.subUrgent ? ' urg' : ''}`}>{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Stage bar. `stages` is the ordered vocabulary, `index` how far along (-1 for
 * a status that is not a stage at all — completed, no go — which is why the
 * caller passes a label to show instead of a position.
 */
// Dots joined by lines, matching CCS's own pipeline exactly — not an
// approximation. The first version here was a flat bar of thin segments with
// no connecting lines and no click target, which is what read as "cramped and
// not spaced": there was nothing between the dots to space OUT.
//
// A dot is clickable and sets Status directly (`onSetStage`), same as CCS.
export function Pipeline({ stages, shortLabels, index, fallbackLabel, fallbackColor, onSetStage }) {
  return (
    <div className="cv2-pipe-wrap">
      <div className="cv2-pipe-head">
        <span className="cv2-pipe-label">Pipeline</span>
        <span className="cv2-pipe-stage">
          {index >= 0
            ? <><b style={{ color: '#993c1d' }}>Stage {index + 1} of {stages.length}</b> · {(shortLabels || stages)[index]}</>
            : <b style={{ color: fallbackColor }}>{fallbackLabel || '—'}</b>}
        </span>
      </div>
      <div className="cv2-pipe">
        {stages.map((s, i) => (
          <div key={s} className="cv2-pipe-seg">
            {i > 0 && <span className="cv2-pipe-line" style={{ background: i <= index ? '#d85a30' : 'var(--cv2-line)' }} />}
            <button className={`cv2-pipe-dot${i < index ? ' done' : i === index ? ' cur' : ''}`}
              title={(shortLabels || stages)[i]} aria-label={(shortLabels || stages)[i]}
              onClick={() => onSetStage?.(s)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The sent-value / received-checkbox rows.
 *
 * `rows` is [{ label, value, onChange, type, received, onToggle }]. A row with
 * no `received` key renders the spacer, so columns stay aligned whether or not
 * that particular milestone has a received half.
 */
export function FinancialRows({ rows, InlineText, InlineDate }) {
  return (
    <div className="cv2-fin-grid">
      {rows.map(row => (
        <div className="cv2-fin-line" key={row.label}>
          <span className="cv2-fin-label">{row.label}</span>
          {/* The date-only modifier gives the GRID CELL a min-width, not just
              the input inside it — a min-width on the input alone let it
              overflow its own (still-collapsed) cell rather than growing it,
              which is what clipped/overlapped the calendar icon. */}
          <div className={`cv2-fin-input${row.type === 'date' ? ' cv2-fin-input--date' : ''}`}>
            {row.type === 'date'
              ? <InlineDate value={row.value} onChange={row.onChange} />
              : <InlineText value={row.value} onChange={row.onChange} placeholder="—" />}
          </div>
          {row.received === undefined
            ? <span className="cv2-fin-rcv-spacer" />
            : (
              <button className={`cv2-fin-rcv${row.received ? ' on' : ''}`} onClick={row.onToggle}>
                <span className="cv2-fin-rcv-box">{row.received ? '✓' : ''}</span>Received
              </button>
            )}
        </div>
      ))}
    </div>
  );
}

/**
 * Two long text fields side by side, finishing level.
 *
 * The height floor is the size these boxes had before they were paired, so
 * equalising costs no space: the card carrying an extra action keeps the floor
 * and the other stretches past it to match.
 */
export function NotesPair({ left, right }) {
  const pane = pane => (
    <div className="cv2-card">
      <div className="cv2-card-head"><span>{pane.title}</span>{pane.action}</div>
      <div className="cv2-field-block cv2-field-block--card">
        {pane.children}
      </div>
    </div>
  );
  return (
    <div className="cv2-cols cv2-cols-even cv2-notes-row">
      {pane(left)}
      {pane(right)}
    </div>
  );
}

/** The 1/3 (stacked) + 2/3 row. */
export function ThirdsRow({ left, right }) {
  return (
    <div className="cv2-cols cv2-cols-third">
      <div className="cv2-stack">{left}</div>
      {right}
    </div>
  );
}

/**
 * Contact details — address, e-mail, work and mobile.
 *
 * `info` comes from src/api/contactLookup.js. FileMaker's own related fields
 * are not consulted here at all: on CCS they are empty on every record, and on
 * Trainings only the work number is populated.
 */
export function ContactDetails({ addressBlock, info, hasContact }) {
  const rows = [];
  if (addressBlock) {
    rows.push(
      <div className="cv2-contact-row" key="addr">
        <span className="cv2-ic">⌖</span>
        <span style={{ whiteSpace: 'pre-wrap' }}>{String(addressBlock).replace(/\r/g, '\n')}</span>
      </div>
    );
  }
  if (info?.email) {
    rows.push(
      <div className="cv2-contact-row" key="email">
        <span className="cv2-ic">✉</span><a href={`mailto:${info.email}`}>{info.email}</a>
      </div>
    );
  }
  if (info?.workPhone) {
    rows.push(
      <div className="cv2-contact-row" key="work">
        <span className="cv2-ic">✆</span><a href={info.workHref}>{info.workPhone}</a>
        <span className="cv2-contact-tag">work</span>
      </div>
    );
  }
  if (info?.cellPhone) {
    rows.push(
      <div className="cv2-contact-row" key="cell">
        <span className="cv2-ic">▢</span><a href={info.cellHref}>{info.cellPhone}</a>
        <span className="cv2-contact-tag">mobile</span>
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="cv2-contact">
        <div className="cv2-contact-row cv2-contact-none">
          {hasContact ? (info ? 'No phone or e-mail on this contact.' : 'Loading…') : 'No contact assigned.'}
        </div>
      </div>
    );
  }
  return <div className="cv2-contact">{rows}</div>;
}
