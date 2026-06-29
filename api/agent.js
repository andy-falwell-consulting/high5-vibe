// Read-only + write-capable data assistant. Answers questions and takes actions
// across FileMaker, Shopify, QuickBooks Online, Gmail, Google Calendar, and
// Google Drive on behalf of the signed-in user.
import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import { getGoogleSession } from './_googleSession.js';

export const config = { maxDuration: 60 };

const FMP_HOST = 'https://ILELLCO.pcifmhosting.com';
const FMP_BASIC = 'Basic ' + Buffer.from('admin:itstime').toString('base64');
const ALLOWED_DBS = ['High5_Core4_Dev', 'High5_Core4_Stage', 'High5_Core4'];
const MODEL = 'claude-haiku-4-5';
const MAX_TOOL_TURNS = 12;
// Output cap per turn. Generous so long answers (e.g. a 50-row invoice table +
// summary) don't get cut off mid-sentence; 2000 was truncating list results.
const MAX_OUTPUT_TOKENS = 8192;

// ── FileMaker modules ────────────────────────────────────────────────────────
const MODULES = {
  inspections: {
    layout: 'Inspections_New',
    portals: { inspt_INSPLI: 200 },
    keyFields: ['_kpt__Inspection_ID', 'Organization', 'inspt_CNTCT__site::Name_Organization', 'inspt_CNTCT::NameFirstLast', 'Inspectors Name', 'Date', 'needs_repair', 'Report Ready'],
  },
  contacts: {
    layout: 'Contacts_New',
    keyFields: ['zz__Display__ct', 'cntct_ADDR::zz__Display_Single_Line__ct', 'Type', 'Status', 'NameFirstLast', 'Name_Organization'],
  },
  projects: {
    layout: 'RCD_New',
    keyFields: ['_kpt__RCD_ID', 'zz__Display_Organization__ct', 'zz__Display_Contact__ct', 'Status', 'kanban_status', 'rcd start date', 'rcd end date', 'Work Order'],
  },
  products: {
    layout: 'Products & Services_New',
    keyFields: ['Name', 'SKU', 'Vendor', 'Category'],
  },
};

// ── System prompt factory ────────────────────────────────────────────────────
function buildSystem(googleUser) {
  const userCtx = googleUser
    ? `You are acting on behalf of ${googleUser.name} (${googleUser.email}). Their Google account is connected — you can access their Gmail, Calendar, and Drive.`
    : 'No Google account is connected for this session — gmail, calendar, and drive tools are unavailable.';

  return `You are the High 5 Adventure Learning Center assistant. You help the team work across FileMaker (internal records), Shopify (e-commerce), QuickBooks Online (accounting), Gmail, Google Calendar, and Google Drive.

${userCtx}

## FileMaker (read-only)
Tools: get_schema(module), search_records(module, query, limit), get_record(module, recordId)
Modules:
- inspections: ${MODULES.inspections.keyFields.join(', ')}. Line items in get_record. "needs_repair" non-empty / "Report Ready"=Yes are flags.
- contacts: ${MODULES.contacts.keyFields.join(', ')}.
- projects (RCD): ${MODULES.projects.keyFields.join(', ')}. "kanban_status" is the pipeline stage.
- products (internal catalog): ${MODULES.products.keyFields.join(', ')}.
FileMaker find query syntax: array of field→value objects (OR-combined, AND within one object). Operators: ">=date", "*wildcard*", "==exact". Dates are M/D/YYYY.

## Shopify (read/write)
Tool: shopify_graphql(query, variables?)
Use for: store products, orders, customers, inventory, collections, sales data.
Key types: Product (id, title, createdAt, status, totalInventory, variants), Order (id, name, createdAt, totalPriceSet, customer, lineItems), Customer (id, displayName, email, ordersCount).
Date filters: "created_at:>2026-03-01". Count: productsCount(query:...) { count }.

## QuickBooks Online (read/write)
Tool: qbo_query(sql) — returns { totalCount, entity, records }.
Tables: Item, Invoice (DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, CreateTime), Customer, Payment, Account.
SQL: SELECT [fields|*|COUNT(*)] FROM [Table] WHERE [conditions] ORDER BY ... STARTPOSITION n MAXRESULTS n
Dates are ISO 8601. Open invoices = Balance > '0'.
- QBO has no SUM or GROUP BY. Get a count with SELECT COUNT(*) FROM ... ; to total a money column (e.g. Balance), fetch the matching rows and add them up yourself.
- MAXRESULTS max is 1000 (default 100 if omitted). Never cap a "list everything / total" request at a small number like 50 — it silently drops rows. Use MAXRESULTS 1000, and if the COUNT(*) exceeds 1000, page with STARTPOSITION (1, then 1001, …) until you've covered every row.

## Gmail (full access)
Tool: gmail(action, params)
Actions:
- search: { q, maxResults? } — Gmail query syntax (from:, to:, subject:, after:, before:, has:attachment, etc.)
- get: { messageId, format? } — format: "full" (default) or "metadata"
- send: { to, subject, body, cc?, bcc?, threadId?, inReplyTo? }
- reply: { threadId, messageId, body, to? } — reply in an existing thread
- trash: { messageId }
- delete: { messageId } — permanent delete
- list_labels: {}

## Google Calendar (full access)
Tool: calendar(action, params)
Actions:
- list: { timeMin?, timeMax?, maxResults?, calendarId? } — ISO 8601 datetimes; default calendarId is "primary"
- get: { eventId, calendarId? }
- create: { summary, start, end, description?, location?, attendees?, calendarId? } — start/end: { dateTime: "ISO", timeZone: "America/New_York" }
- update: { eventId, changes, calendarId? } — changes is partial event object
- delete: { eventId, calendarId? }
- list_calendars: {}

## Google Drive (full access)
Tool: drive(action, params)
Actions:
- search: { q, pageSize?, fields? } — Drive query syntax (name contains '...', mimeType='...', modifiedTime>'...')
- get: { fileId, fields? } — metadata only
- get_content: { fileId } — text content (works for Google Docs, Sheets as text/plain; plain text files)
- create: { name, mimeType, content?, parentId? } — mimeType: "application/vnd.google-apps.document", "text/plain", etc.
- update: { fileId, content } — update file body content
- delete: { fileId }
- share: { fileId, email, role } — role: "reader" | "writer" | "commenter"

## Guidance
- Choose the right system: internal records → FileMaker; store → Shopify; accounting → QBO; email/calendar/files → Google.
- For write actions (send email, create event, delete file), confirm intent is clear from the conversation before acting. Do not ask for confirmation if the user has already explicitly stated what to do.
- Be concise and cite what you touched. If a search returns nothing, say so.
- Format with Markdown (it is rendered, not shown raw): present lists of records as a table with a header row, **bold** key figures, and close multi-row results with a one-line summary. Keep tables scannable — pick the few most useful columns rather than every field.
- For "how many" / "what's the total" questions, compute the real aggregate across ALL matching rows — not just one page — and lead with it: the count (COUNT(*)) and any money total (fetch + sum, since QBO can't SUM). When you also list a large result set, state the full count and total FIRST, then the rows, so the key number is never lost even if the list is long.`;
}

// ── FileMaker auth ───────────────────────────────────────────────────────────
async function fmpToken(db) {
  const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${db}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: FMP_BASIC },
    body: '{}',
  });
  const j = await r.json();
  if (!j?.response?.token) throw new Error('FileMaker auth failed: ' + (j?.messages?.[0]?.message || r.status));
  return j.response.token;
}
const fmpHeaders = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// ── Shopify auth ─────────────────────────────────────────────────────────────
async function shopifyToken() {
  const redis = Redis.fromEnv();
  try { const t = await redis.get('shopify_token'); if (t) return t; } catch { /* redis unavailable */ }
  return process.env.SHOPIFY_TOKEN || null;
}

// ── QBO auth ─────────────────────────────────────────────────────────────────
async function qboToken() {
  const redis = Redis.fromEnv();
  const cached = await redis.get('qbo_access_token').catch(() => null);
  if (cached) return cached;
  const refreshToken = (await redis.get('qbo_refresh_token').catch(() => null)) || process.env.QBO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('QBO not connected.');
  const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const tokens = await resp.json();
  if (!resp.ok || !tokens.access_token) throw new Error('QBO refresh failed: ' + JSON.stringify(tokens));
  await redis.set('qbo_refresh_token', tokens.refresh_token, { ex: 86400 * 90 }).catch(() => {});
  await redis.set('qbo_access_token', tokens.access_token, { ex: 55 * 60 }).catch(() => {});
  return tokens.access_token;
}

// ── Google API helpers ───────────────────────────────────────────────────────
const gHeaders = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

function buildRFC2822({ from, to, subject, body, cc, bcc, inReplyTo, threadId }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    '',
    body,
  ].filter(Boolean);
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

function slimMessage(msg) {
  if (!msg) return null;
  const headers = {};
  for (const h of msg.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
  const body = extractBody(msg.payload);
  return { id: msg.id, threadId: msg.threadId, subject: headers.subject, from: headers.from, to: headers.to, date: headers.date, snippet: msg.snippet, body: body?.slice(0, 2000) };
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  for (const part of payload.parts || []) {
    const text = extractBody(part);
    if (text) return text;
  }
  return '';
}

// ── Tool runner ───────────────────────────────────────────────────────────────
async function runTool(name, input, ctx) {

  // ── Gmail ────────────────────────────────────────────────────────────────
  if (name === 'gmail') {
    if (!ctx.googleToken) return { error: 'Gmail not available — no Google account connected.' };
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const h = gHeaders(ctx.googleToken);

    if (input.action === 'list_labels') {
      const r = await fetch(`${base}/labels`, { headers: h });
      const j = await r.json();
      return { labels: (j.labels || []).map(l => ({ id: l.id, name: l.name })) };
    }

    if (input.action === 'search') {
      const params = new URLSearchParams({ q: input.q || '', maxResults: String(Math.min(input.maxResults || 10, 25)) });
      const r = await fetch(`${base}/messages?${params}`, { headers: h });
      const j = await r.json();
      if (!r.ok) return { error: j.error?.message || 'Gmail search failed' };
      const messages = j.messages || [];
      // Fetch snippets for each
      const details = await Promise.all(messages.slice(0, 10).map(async m => {
        const dr = await fetch(`${base}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`, { headers: h });
        return slimMessage(await dr.json());
      }));
      return { total: j.resultSizeEstimate, returned: details.length, messages: details };
    }

    if (input.action === 'get') {
      const format = input.format || 'full';
      const r = await fetch(`${base}/messages/${input.messageId}?format=${format}`, { headers: h });
      const j = await r.json();
      if (!r.ok) return { error: j.error?.message || 'Message not found' };
      return slimMessage(j);
    }

    if (input.action === 'send' || input.action === 'reply') {
      const raw = buildRFC2822({
        from: ctx.googleUser.email,
        to: input.to || ctx.googleUser.email,
        subject: input.subject || '(no subject)',
        body: input.body || '',
        cc: input.cc,
        bcc: input.bcc,
        inReplyTo: input.inReplyTo,
      });
      const sendBody = { raw };
      if (input.threadId) sendBody.threadId = input.threadId;
      const r = await fetch(`${base}/messages/send`, { method: 'POST', headers: h, body: JSON.stringify(sendBody) });
      const j = await r.json();
      if (!r.ok) return { error: j.error?.message || 'Send failed' };
      return { sent: true, messageId: j.id, threadId: j.threadId };
    }

    if (input.action === 'trash') {
      const r = await fetch(`${base}/messages/${input.messageId}/trash`, { method: 'POST', headers: h });
      const j = await r.json();
      return r.ok ? { trashed: true, messageId: j.id } : { error: j.error?.message };
    }

    if (input.action === 'delete') {
      const r = await fetch(`${base}/messages/${input.messageId}`, { method: 'DELETE', headers: h });
      return r.ok ? { deleted: true } : { error: 'Delete failed', status: r.status };
    }

    return { error: `Unknown gmail action: ${input.action}` };
  }

  // ── Calendar ─────────────────────────────────────────────────────────────
  if (name === 'calendar') {
    if (!ctx.googleToken) return { error: 'Calendar not available — no Google account connected.' };
    const calId = encodeURIComponent(input.calendarId || 'primary');
    const base = `https://www.googleapis.com/calendar/v3/calendars/${calId}`;
    const h = gHeaders(ctx.googleToken);

    if (input.action === 'list_calendars') {
      const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: h });
      const j = await r.json();
      return { calendars: (j.items || []).map(c => ({ id: c.id, summary: c.summary, primary: c.primary })) };
    }

    if (input.action === 'list') {
      const params = new URLSearchParams({ maxResults: String(Math.min(input.maxResults || 20, 50)), singleEvents: 'true', orderBy: 'startTime' });
      if (input.timeMin) params.set('timeMin', input.timeMin);
      if (input.timeMax) params.set('timeMax', input.timeMax);
      const r = await fetch(`${base}/events?${params}`, { headers: h });
      const j = await r.json();
      if (!r.ok) return { error: j.error?.message || 'Calendar list failed' };
      return { events: (j.items || []).map(e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location, description: e.description?.slice(0, 300), attendees: e.attendees?.map(a => a.email) })) };
    }

    if (input.action === 'get') {
      const r = await fetch(`${base}/events/${encodeURIComponent(input.eventId)}`, { headers: h });
      const j = await r.json();
      return r.ok ? j : { error: j.error?.message };
    }

    if (input.action === 'create') {
      const r = await fetch(`${base}/events`, { method: 'POST', headers: h, body: JSON.stringify(input) });
      const j = await r.json();
      return r.ok ? { created: true, eventId: j.id, htmlLink: j.htmlLink } : { error: j.error?.message };
    }

    if (input.action === 'update') {
      const r = await fetch(`${base}/events/${encodeURIComponent(input.eventId)}`, { method: 'PATCH', headers: h, body: JSON.stringify(input.changes || {}) });
      const j = await r.json();
      return r.ok ? { updated: true, eventId: j.id } : { error: j.error?.message };
    }

    if (input.action === 'delete') {
      const r = await fetch(`${base}/events/${encodeURIComponent(input.eventId)}`, { method: 'DELETE', headers: h });
      return r.ok ? { deleted: true } : { error: 'Delete failed', status: r.status };
    }

    return { error: `Unknown calendar action: ${input.action}` };
  }

  // ── Drive ────────────────────────────────────────────────────────────────
  if (name === 'drive') {
    if (!ctx.googleToken) return { error: 'Drive not available — no Google account connected.' };
    const base = 'https://www.googleapis.com/drive/v3';
    const h = gHeaders(ctx.googleToken);

    if (input.action === 'search') {
      const params = new URLSearchParams({ q: input.q || '', pageSize: String(Math.min(input.pageSize || 15, 30)), fields: input.fields || 'files(id,name,mimeType,modifiedTime,size,webViewLink)' });
      const r = await fetch(`${base}/files?${params}`, { headers: h });
      const j = await r.json();
      return r.ok ? { files: j.files } : { error: j.error?.message };
    }

    if (input.action === 'get') {
      const fields = input.fields || 'id,name,mimeType,modifiedTime,size,webViewLink,parents';
      const r = await fetch(`${base}/files/${input.fileId}?fields=${encodeURIComponent(fields)}`, { headers: h });
      const j = await r.json();
      return r.ok ? j : { error: j.error?.message };
    }

    if (input.action === 'get_content') {
      // Google Workspace files need export; binary files return raw bytes (skip those)
      const meta = await fetch(`${base}/files/${input.fileId}?fields=mimeType,name`, { headers: h }).then(r => r.json());
      const gsuite = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' };
      let url, isExport = false;
      if (gsuite[meta.mimeType]) { url = `${base}/files/${input.fileId}/export?mimeType=${encodeURIComponent(gsuite[meta.mimeType])}`; isExport = true; }
      else if (meta.mimeType?.startsWith('text/') || meta.mimeType === 'application/json') { url = `${base}/files/${input.fileId}?alt=media`; }
      else return { error: `Cannot read content of ${meta.mimeType} files (${meta.name}). Try a Google Doc, Sheet, or plain text file.` };
      const r = await fetch(url, { headers: h });
      if (!r.ok) return { error: `Failed to get content (${r.status})` };
      const text = await r.text();
      return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 8000) + (text.length > 8000 ? '\n[truncated]' : '') };
    }

    if (input.action === 'create') {
      const meta = { name: input.name };
      if (input.mimeType) meta.mimeType = input.mimeType;
      if (input.parentId) meta.parents = [input.parentId];
      if (!input.content) {
        const r = await fetch(`${base}/files`, { method: 'POST', headers: h, body: JSON.stringify(meta) });
        const j = await r.json();
        return r.ok ? { created: true, fileId: j.id, name: j.name } : { error: j.error?.message };
      }
      // Multipart upload for files with content
      const boundary = '-------314159265358979323846';
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${input.content}\r\n--${boundary}--`;
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { ...h, 'Content-Type': `multipart/related; boundary="${boundary}"` }, body });
      const j = await r.json();
      return r.ok ? { created: true, fileId: j.id, name: j.name } : { error: j.error?.message };
    }

    if (input.action === 'update') {
      const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${input.fileId}?uploadType=media`, { method: 'PATCH', headers: { ...h, 'Content-Type': 'text/plain' }, body: input.content });
      return r.ok ? { updated: true } : { error: 'Update failed', status: r.status };
    }

    if (input.action === 'delete') {
      const r = await fetch(`${base}/files/${input.fileId}`, { method: 'DELETE', headers: h });
      return r.ok ? { deleted: true } : { error: 'Delete failed', status: r.status };
    }

    if (input.action === 'share') {
      const r = await fetch(`${base}/files/${input.fileId}/permissions`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'user', role: input.role || 'reader', emailAddress: input.email }) });
      const j = await r.json();
      return r.ok ? { shared: true, permissionId: j.id } : { error: j.error?.message };
    }

    return { error: `Unknown drive action: ${input.action}` };
  }

  // ── Shopify GraphQL ──────────────────────────────────────────────────────
  if (name === 'shopify_graphql') {
    const store = process.env.SHOPIFY_STORE;
    const token = await shopifyToken();
    if (!store || !token) return { error: 'Shopify is not connected.' };
    const body = { query: input.query };
    if (input.variables) body.variables = input.variables;
    const r = await fetch(`https://${store}/admin/api/2025-10/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.errors) return { error: j.errors.map(e => e.message).join('; '), data: j.data ?? null };
    return { data: j.data };
  }

  // ── QBO SQL ──────────────────────────────────────────────────────────────
  if (name === 'qbo_query') {
    const realmId = process.env.QBO_REALM_ID;
    if (!realmId) return { error: 'QBO not connected.' };
    let token; try { token = await qboToken(); } catch (e) { return { error: String(e.message) }; }
    const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent(input.sql)}&minorversion=65`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const j = await r.json();
    if (!r.ok) return { error: JSON.stringify(j?.Fault ?? j).slice(0, 400) };
    const qr = j?.QueryResponse ?? {};
    const entityKey = Object.keys(qr).find(k => !['startPosition', 'maxResults', 'totalCount'].includes(k));
    return { totalCount: qr.totalCount ?? (entityKey ? (qr[entityKey]?.length ?? 0) : 0), entity: entityKey || null, records: entityKey ? qr[entityKey] : [] };
  }

  // ── FileMaker ────────────────────────────────────────────────────────────
  const mod = MODULES[input?.module];
  if (!mod) return { error: `Unknown module "${input?.module}". Valid: ${Object.keys(MODULES).join(', ')}` };
  const layout = encodeURIComponent(mod.layout);

  if (name === 'get_schema') {
    const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${ctx.db}/layouts/${layout}`, { headers: fmpHeaders(ctx.token) });
    const j = await r.json();
    return { module: input.module, fields: (j?.response?.fieldMetaData || []).map(f => f.name) };
  }

  if (name === 'search_records') {
    const limit = Math.min(input.limit || 15, 40);
    const query = Array.isArray(input.query) && input.query.length ? input.query : [{ [mod.keyFields[0]]: '*' }];
    const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${ctx.db}/layouts/${layout}/_find`, { method: 'POST', headers: fmpHeaders(ctx.token), body: JSON.stringify({ query, limit }) });
    const j = await r.json();
    if (j?.messages?.[0]?.code !== '0') {
      if (j?.messages?.[0]?.code === '401') return { found: 0, records: [] };
      return { error: j?.messages?.[0]?.message || 'search failed' };
    }
    const rows = j?.response?.data || [];
    return { module: input.module, found: j?.response?.dataInfo?.foundCount ?? rows.length, returned: rows.length, records: rows.map(row => ({ recordId: row.recordId, ...slim(row.fieldData) })) };
  }

  if (name === 'get_record') {
    const portalParam = mod.portals ? '?' + Object.entries(mod.portals).map(([p, n]) => `_limit.${encodeURIComponent(p)}=${n}`).join('&') : '';
    const r = await fetch(`${FMP_HOST}/fmi/data/v2/databases/${ctx.db}/layouts/${layout}/records/${encodeURIComponent(input.recordId)}${portalParam}`, { headers: fmpHeaders(ctx.token) });
    const j = await r.json();
    const rec = j?.response?.data?.[0];
    if (!rec) return { error: `No record ${input.recordId} in ${input.module}` };
    const out = { module: input.module, recordId: rec.recordId, fields: slim(rec.fieldData) };
    if (rec.portalData) out.lineItems = rec.portalData;
    return out;
  }

  return { error: `Unknown tool ${name}` };
}

function slim(fieldData = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fieldData)) {
    if (v === '' || v == null) continue;
    out[k] = typeof v === 'string' && v.length > 600 ? v.slice(0, 600) + '…' : v;
  }
  return out;
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'get_schema', description: 'List field names on a FileMaker module layout.', input_schema: { type: 'object', properties: { module: { type: 'string', enum: Object.keys(MODULES) } }, required: ['module'] } },
  { name: 'search_records', description: 'Find FileMaker records via a query.', input_schema: { type: 'object', properties: { module: { type: 'string', enum: Object.keys(MODULES) }, query: { type: 'array', items: { type: 'object' } }, limit: { type: 'number' } }, required: ['module', 'query'] } },
  { name: 'get_record', description: 'Full detail for one FileMaker record.', input_schema: { type: 'object', properties: { module: { type: 'string', enum: Object.keys(MODULES) }, recordId: { type: 'string' } }, required: ['module', 'recordId'] } },
  { name: 'shopify_graphql', description: 'Read-only or write GraphQL query against the Shopify Admin API (products, orders, customers, inventory).', input_schema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'] } },
  { name: 'qbo_query', description: 'SQL query against QuickBooks Online (invoices, payments, items, customers).', input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } },
  {
    name: 'gmail',
    description: "Interact with the signed-in user's Gmail.",
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['search', 'get', 'send', 'reply', 'trash', 'delete', 'list_labels'] }, q: { type: 'string' }, maxResults: { type: 'number' }, messageId: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' }, bcc: { type: 'string' }, threadId: { type: 'string' }, inReplyTo: { type: 'string' }, format: { type: 'string' } }, required: ['action'] },
  },
  {
    name: 'calendar',
    description: "Interact with the signed-in user's Google Calendar.",
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete', 'list_calendars'] }, calendarId: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, maxResults: { type: 'number' }, eventId: { type: 'string' }, summary: { type: 'string' }, start: { type: 'object' }, end: { type: 'object' }, description: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'object' } }, changes: { type: 'object' } }, required: ['action'] },
  },
  {
    name: 'drive',
    description: "Interact with the signed-in user's Google Drive.",
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['search', 'get', 'get_content', 'create', 'update', 'delete', 'share'] }, q: { type: 'string' }, pageSize: { type: 'number' }, fields: { type: 'string' }, fileId: { type: 'string' }, name: { type: 'string' }, mimeType: { type: 'string' }, content: { type: 'string' }, parentId: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } }, required: ['action'] },
  },
];

const STATUS = {
  get_schema: 'Reading schema', search_records: 'Searching', get_record: 'Reading record',
  shopify_graphql: 'Querying Shopify', qbo_query: 'Querying QuickBooks',
  gmail: inp => `Gmail — ${inp.action}…`,
  calendar: inp => `Calendar — ${inp.action}…`,
  drive: inp => `Drive — ${inp.action}…`,
};
function statusFor(name, input) {
  const s = STATUS[name];
  return typeof s === 'function' ? s(input) : `${s || 'Working'}${input?.module ? ` ${input.module}` : ''}…`;
}

function labelFor(module, f = {}) {
  if (module === 'inspections') return f.Organization || f['inspt_CNTCT__site::Name_Organization'] || `Inspection ${f._kpt__Inspection_ID || ''}`.trim();
  if (module === 'contacts') return f.zz__Display__ct || f.NameFirstLast || f.Name_Organization || 'Contact';
  if (module === 'projects') return f.zz__Display_Organization__ct || `Project ${f._kpt__RCD_ID || ''}`.trim();
  if (module === 'products') return f.Name || 'Product';
  return 'Record';
}

function collectSources(name, input, result, add) {
  const module = input?.module;
  if (name === 'get_record' && result?.recordId) add({ module, recordId: String(result.recordId), label: labelFor(module, result.fields) });
  else if (name === 'search_records' && Array.isArray(result?.records)) {
    for (const r of result.records.slice(0, 6)) add({ module, recordId: String(r.recordId), label: labelFor(module, r) });
  }
}

// ── Handler (Server-Sent Events) ──────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { messages = [], db: reqDb } = body || {};
  const db = ALLOWED_DBS.includes(reqDb) ? reqDb : ALLOWED_DBS[0];
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // Resolve FileMaker token and Google session in parallel
    const [fmpTok, googleSession] = await Promise.all([
      fmpToken(db),
      getGoogleSession(req),
    ]);

    const ctx = {
      db,
      token: fmpTok,
      googleToken: googleSession?.accessToken || null,
      googleUser: googleSession ? { email: googleSession.email, name: googleSession.name } : null,
    };

    const convo = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content }));

    const sources = []; const seen = new Set();
    const addSource = s => { const k = `${s.module}:${s.recordId}`; if (!seen.has(k) && sources.length < 12) { seen.add(k); sources.push(s); } };

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = anthropic.messages.stream({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, system: buildSystem(ctx.googleUser), tools: TOOLS, messages: convo });
      stream.on('text', delta => send({ type: 'delta', text: delta }));
      const msg = await stream.finalMessage();

      if (msg.stop_reason === 'tool_use') {
        convo.push({ role: 'assistant', content: msg.content });
        const results = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          send({ type: 'status', text: statusFor(block.name, block.input) });
          let result;
          try { result = await runTool(block.name, block.input, ctx); }
          catch (e) { result = { error: String(e?.message || e) }; }
          collectSources(block.name, block.input, result, addSource);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        convo.push({ role: 'user', content: results });
        continue;
      }
      break;
    }

    if (sources.length) send({ type: 'sources', sources });
    send({ type: 'done' });
    res.end();
  } catch (e) {
    send({ type: 'error', error: String(e?.message || e) });
    res.end();
  }
}
