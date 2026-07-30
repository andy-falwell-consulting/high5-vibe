// Deep links into QuickBooks Online.
//
// QBO's app routes take the transaction's internal Id (NOT its DocNumber) as
// `txnId`. The link resolves against whichever company the user is currently
// signed into, so it only lands correctly for someone already in the High 5
// company file — which is everyone who'd have reason to click it.
//
// Keyed by QBO's own entity names so a raw API response can be passed straight
// through. `Payment` is QBO's "receive payment" screen, hence `recvpayment`.
const QBO_APP_PATH = {
  Invoice: 'invoice',
  Estimate: 'estimate',
  CreditMemo: 'creditmemo',
  SalesReceipt: 'salesreceipt',
  Payment: 'recvpayment',
};

/** Link to a QBO transaction, or null when there's no id to link to. */
export function qboLink(type, id) {
  if (!id) return null;
  const path = QBO_APP_PATH[type] || 'invoice';
  return `https://app.qbo.intuit.com/app/${path}?txnId=${encodeURIComponent(id)}`;
}

export { QBO_APP_PATH };
