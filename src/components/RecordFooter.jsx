// The provenance line under a record: its ids, who created it and when, who
// last changed it and when.
//
// ONE COMPONENT BECAUSE THERE WERE NINE COPIES. Every record module had its own
// `<div className="xxx-record-footer">` with the same template string inside and
// its own near-identical CSS rule. Two of the nine bodies differed: some guarded
// a missing value with `|| '—'` and some did not, so the same absent field read
// as an em dash on one page and printed nothing on another. That is the kind of
// difference nobody notices and nobody chooses.
//
// Every value is optional. A record with no modification stamp shows the fields
// it has and drops the rest, rather than printing "Modified undefined by
// undefined" — which is what the unguarded copies did.

// FileMaker stores timestamps as '06/05/2013 09:52:54'; only the date is worth
// showing here. Vibe's own records store an ISO string, which has no space to
// split on, so this takes the leading date part of either.
const justDate = v => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.includes(' ') ? s.split(' ')[0] : s.split('T')[0];
};

export default function RecordFooter({ id, recordId, fieldData, created, createdBy, modified, modifiedBy }) {
  // Read straight off fieldData when given one — every FileMaker-backed module
  // uses the same four field names, so nine call sites do not need to repeat
  // them. Explicit props win, for records whose metadata is shaped differently.
  const f = fieldData || {};
  const cOn = justDate(created ?? f.zz__Created_On);
  const cBy = createdBy ?? f.zz__Created_By;
  const mOn = justDate(modified ?? f.zz__Modified_On);
  const mBy = modifiedBy ?? f.zz__Modified_By;

  const parts = [];
  if (id) parts.push(`ID ${id}`);
  if (recordId) parts.push(`Record ${recordId}`);
  if (cOn || cBy) parts.push(`Created ${cOn || '—'}${cBy ? ` by ${cBy}` : ''}`);
  if (mOn || mBy) parts.push(`Modified ${mOn || '—'}${mBy ? ` by ${mBy}` : ''}`);
  if (!parts.length) return null;

  return (
    <div className="h5-record-footer">
      {parts.map((p, i) => (
        <span key={p}>
          {i > 0 && <span className="h5-record-footer__sep">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}
