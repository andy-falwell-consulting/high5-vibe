// Turning a QuickBooks sales transaction into what Vibe stores.
//
// ITS OWN FILE SO IT CAN BE TESTED. txn-sync.js builds a Redis client at import
// time, so anything living there can only be exercised by copying it into a
// harness — and a copied rule is a rule that drifts from the one that ships.
// This imports nothing.
//
// TWO VALUES OUT, NOT ONE. The row and its line items are stored in separate
// Redis hashes, because the ledger list reads every row and needs none of the
// lines:
//
//   txn:{db}:recs    Type:Id -> the row          ~320 bytes
//   txn:{db}:lines   Type:Id -> [ {line}, … ]    ~320 bytes, read on demand
//
// Before the split, `HSCAN` shipped the whole 643-byte record for all 34,452
// transactions on every ledger load — 21 MB — and api/transactions.js then threw
// 62% of it away before answering. Measured; see §10 of
// docs/transaction-source-scope.md.

export const TYPES = ['Invoice', 'Estimate', 'CreditMemo', 'SalesReceipt'];

const today = () => new Date().toISOString().slice(0, 10);

function statusOf(type, e, balance) {
  if (type === 'Invoice') return balance <= 0 ? 'Paid' : (e.DueDate && e.DueDate < today() ? 'Overdue' : 'Open');
  if (type === 'Estimate') return e.TxnStatus || 'Pending';
  if (type === 'CreditMemo') return balance > 0 ? 'Unapplied' : 'Applied';
  return 'Paid';   // SalesReceipt
}

/**
 * The row.
 *
 * `links`, `note` and `po` are the evidence a transaction's SOURCE is derived
 * from — which estimate it came from, what the office wrote on it, the
 * customer's purchase order. They were previously discarded here, which is why
 * nothing in the app could say where a transaction came from.
 *
 * The RAW evidence is stored rather than a derived label: measured at 77 bytes
 * against 158 for the label form, and a rule that changes later can be re-run
 * over evidence without re-reading all of QuickBooks.
 */
export function normalizeRow(type, e) {
  const total = Number(e.TotalAmt || 0);
  const balance = e.Balance != null ? Number(e.Balance) : 0;

  // Only the two fields that identify anything. QBO's LinkedTxn also carries a
  // TxnLineId that points inside the other document, which nothing here needs.
  const links = (e.LinkedTxn || [])
    .filter(l => l?.TxnType && l?.TxnId)
    .map(l => ({ t: String(l.TxnType), id: String(l.TxnId) }));

  // QuickBooks returns every custom field whether or not it holds anything,
  // so empties are dropped rather than stored as "".
  const po = (e.CustomField || [])
    .filter(c => c?.StringValue)
    .map(c => String(c.StringValue))
    .join(', ');

  const row = {
    type, id: String(e.Id), docNumber: e.DocNumber || '',
    customerId: e.CustomerRef?.value || '', customerName: e.CustomerRef?.name || '',
    date: e.TxnDate || '', dueDate: e.DueDate || '',
    total, balance, status: statusOf(type, e, balance),
    currency: e.CurrencyRef?.value || 'USD',
    updated: e.MetaData?.LastUpdatedTime || '',
  };
  // Absent rather than empty: an empty array or string on 34,452 records is
  // bytes shipped on every ledger load to say nothing.
  if (links.length) row.links = links;
  if (e.PrivateNote) row.note = String(e.PrivateNote);
  if (po) row.po = po;
  return row;
}

/** The line items, stored apart from the row. */
export function normalizeLines(e) {
  return (e.Line || [])
    .filter(l => l.DetailType === 'SalesItemLineDetail')
    .map(l => ({
      desc: l.Description || l.SalesItemLineDetail?.ItemRef?.name || '',
      qty: l.SalesItemLineDetail?.Qty ?? null,
      amount: Number(l.Amount || 0),
      item: l.SalesItemLineDetail?.ItemRef?.name || '',
    }));
}
