// Converts a Google Docs HTML export into a small, theme-safe HTML string for
// the in-app Help page. Docs exports every run of text as a <span
// style="..."> with hardcoded colors/fonts (never <b>/<i>/<a>), plus a bulky
// unscoped <style> block of list-numbering rules — none of that is safe to
// inject as-is (it fights dark mode and can leak styles into the rest of the
// app). This walks the parsed body and rebuilds a plain, semantic subset:
// headings (with slug ids for the TOC), paragraphs, lists, <hr>, plus
// <strong>/<em> for bold/italic runs and a small allowlist of intentionally
// authored colors (e.g. the "heads up" callouts) — everything else is dropped.
const DEFAULT_COLORS = new Set(['#000000', '#1a1a1a']);

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => escapeHtml(s).replace(/"/g, '&quot;');

function parseStyle(styleAttr) {
  const props = {};
  (styleAttr || '').split(';').forEach(rule => {
    const i = rule.indexOf(':');
    if (i < 0) return;
    const k = rule.slice(0, i).trim();
    const v = rule.slice(i + 1).trim();
    if (k && v) props[k] = v;
  });
  return props;
}

function slugify(text, seen) {
  let base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  let id = base, n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

function renderInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '<br>';
  const inner = Array.from(node.childNodes).map(renderInline).join('');
  if (!inner.trim() && tag !== 'br') return inner;
  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    return href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${inner}</a>` : inner;
  }
  const style = parseStyle(node.getAttribute('style'));
  let out = inner;
  if (style['font-weight'] === '700' || style['font-weight'] === 'bold') out = `<strong>${out}</strong>`;
  if (style['font-style'] === 'italic') out = `<em>${out}</em>`;
  const color = (style['color'] || '').toLowerCase();
  if (color && !DEFAULT_COLORS.has(color)) out = `<span style="color:${escapeAttr(color)}">${out}</span>`;
  return out;
}

function renderList(el) {
  const tag = el.tagName.toLowerCase(); // ul | ol
  const items = Array.from(el.children)
    .filter(li => li.tagName.toLowerCase() === 'li')
    .map(li => `<li>${Array.from(li.childNodes).map(renderInline).join('')}</li>`)
    .join('');
  return items ? `<${tag}>${items}</${tag}>` : '';
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Returns { html, toc } — html is a string of clean tags ready for
// dangerouslySetInnerHTML; toc is [{ id, title }] built from every <h1>.
export function cleanGoogleDocHtml(rawHtml) {
  const parsed = new DOMParser().parseFromString(rawHtml, 'text/html');
  const seen = new Set();
  const toc = [];
  const parts = [];

  Array.from(parsed.body.children).forEach(el => {
    const tag = el.tagName.toLowerCase();
    if (HEADING_TAGS.has(tag)) {
      const text = el.textContent.trim();
      if (!text) return;
      const id = slugify(text, seen);
      if (tag === 'h1') toc.push({ id, title: text });
      parts.push(`<${tag} id="${escapeAttr(id)}">${escapeHtml(text)}</${tag}>`);
    } else if (tag === 'p') {
      const inner = Array.from(el.childNodes).map(renderInline).join('');
      if (inner.trim()) parts.push(`<p>${inner}</p>`);
    } else if (tag === 'ul' || tag === 'ol') {
      const rendered = renderList(el);
      if (rendered) parts.push(rendered);
    } else if (tag === 'hr') {
      parts.push('<hr>');
    }
    // anything else (stray divs, etc.) is intentionally dropped
  });

  return { html: parts.join('\n'), toc };
}
