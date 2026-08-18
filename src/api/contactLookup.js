// Phone and e-mail for a record's contact, from VIBE'S contact store.
//
// Shared by the CCS work order PDF and the CCS Contact card, which both used to
// read FileMaker's related fields on RCD_New — `rcd_cntct_PHONE__work::Number`,
// `rcd_cntct_PHONE__mobile::Number`, `rcd_cntct_INADR__email::zz__Address__ct`.
// Those are on the layout and readable, but populated on ZERO of all 6,436 CCS
// projects: the relationships resolve empty over the Data API. So the work order
// printed "—" for all three, and the Contact card showed nothing but an address.
//
// Vibe holds the same contacts keyed by _kft__Contact_ID (populated on 958 of
// 1,000 projects) and fills at least one of the three for 115 of a 120-contact
// sample.
import { getContact } from './vibeContacts';
import { formatPhone, telHref } from '../../api/_phone';

// Type vocabularies match METHOD_SPEC in ContactsV2 — the values actually in
// the data, in preference order. A fax is never offered as a phone number.
const WORK_TYPES = ['Work', 'Main Office', 'Work Parent'];
const CELL_TYPES = ['Mobile', 'Personal Mobile', 'Mobile Parent'];
const MAIL_TYPES = ['Email', 'Home Email', 'Billing'];

const EMPTY = { workPhone: '', workHref: '', cellPhone: '', cellHref: '', email: '' };

const pickByType = (rows, types) => {
  for (const t of types) {
    const hit = (rows || []).find(r => String(r.type || '').toLowerCase() === t.toLowerCase());
    if (hit) return hit;
  }
  return null;
};

/**
 * Reduce a contact to what these two surfaces print. Returns empty strings
 * rather than throwing: a missing or unreachable contact should still leave a
 * usable work order and a usable card, just without the details filled.
 *
 * `firstEmail`: Trainings wants the person's own drag-to-sorted email order
 * respected rather than CCS's type-preference pick — see ContactsV2's email
 * reorder UI. Still skips a bare 'Web' row, same as the default fallback
 * below, since a website is not an email address.
 */
export async function contactDetails(contactId, { firstEmail = false } = {}) {
  const id = String(contactId || '').trim();
  if (!id) return EMPTY;
  try {
    const d = await getContact(id);
    const e = d?.person || d?.organization;
    if (!e) return EMPTY;
    const w = pickByType(e.phones, WORK_TYPES);
    const c = pickByType(e.phones, CELL_TYPES);
    const m = firstEmail
      ? (e.emails || []).find(x => String(x.type || '') !== 'Web')
      : (pickByType(e.emails, MAIL_TYPES) || (e.emails || []).find(x => String(x.type || '') !== 'Web'));
    // Display text and dial link are both returned. They differ: the display
    // reads "(781) 455-0800 ext. 2140", while the link has to be
    // "tel:+17814550800,2140" — a comma is the pause convention, and folding the
    // extension into the digits would dial a number that does not exist.
    return {
      workPhone: w ? formatPhone(w.number, w.ext) : '',
      workHref: w ? telHref(w.number, w.ext) : '',
      cellPhone: c ? formatPhone(c.number, c.ext) : '',
      cellHref: c ? telHref(c.number, c.ext) : '',
      email: m?.address || '',
    };
  } catch {
    return EMPTY;
  }
}

/** The same, taking a whole record and reading its contact key. */
export const contactDetailsFor = (record, opts) =>
  contactDetails(record?.fieldData?._kft__Contact_ID, opts);
