// Small, fast Markdown renderer with Nexus extensions (wikilinks, tags, properties, tasks, flashcards, callouts).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

const FIELD = /^\s*(?:[-*]\s+)?([\p{L}\p{N}_][\p{L}\p{N}_ \-]{0,40}?)::\s*(.*)$/u;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const CARD = /^\s*(?:[-*]\s+)?(.+?)\s+\?\?\s+(.+)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const safeUrl = (u) => (/^(https?:|mailto:|tel:|#|\/)/i.test(u) || !/^[a-z][\w+.-]*:/i.test(u) ? u : '#');

export function inline(text, ctx = {}) {
  const stash = [];
  const put = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(text);
  s = s.replace(/(`+)([\s\S]+?)\1/g, (_, __, c) => put(`<code>${esc(c)}</code>`));
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, t) => put(`<a class="wl" data-title="${esc(t.split('|')[0].trim())}">↪ ${esc(t.split('|')[0])}</a>`));
  s = s.replace(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_, t, h, a) => {
    const title = t.trim();
    const exists = ctx.exists ? ctx.exists(title) : true;
    return put(`<a class="wl${exists ? '' : ' missing'}" data-title="${esc(title)}"${h ? ` data-h="${esc(slug(h.slice(1)))}"` : ''}>${esc(a || title + (h || ''))}</a>`);
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, a, u) => put(`<img alt="${esc(a)}" src="${esc(safeUrl(u))}" loading="lazy">`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => put(`<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${inline(t, ctx)}</a>`));
  s = s.replace(/<(https?:\/\/[^>\s]+)>|(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (m, a, pre, b) => {
    const u = a || b;
    return (pre || '') + put(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))}</a>`);
  });
  s = esc(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
    .replace(/(^|[\s(,])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu, (_, p, t) => `${p}<a class="tag" data-tag="${t.toLowerCase()}" style="${ctx.tagStyle ? ctx.tagStyle(t.toLowerCase()) : ''}">#${t}</a>`)
    .replace(/(?:@|📅\s?|due:\s?)(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/g, (m, d, t) => `<span class="due${d < ctx.today ? ' over' : d === ctx.today ? ' today' : ''}" data-date="${d}">📅 ${d}${t ? ' ' + t : ''}</span>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}

export function render(src, ctx = {}) {
  ctx.today ??= new Date().toLocaleDateString('sv');
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l, next) => /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST.test(l) || FIELD.test(l) || CARD.test(l) ||
    /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l) || (l.includes('|') && next !== undefined && TABLE_SEP.test(next));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<div class="code"><button class="copy" title="Copy">⧉</button>${fence[2] ? `<span class="lang">${esc(fence[2])}</span>` : ''}<pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) { const n = h[1].length; out.push(`<h${n} id="h-${slug(h[2])}" data-line="${i}">${inline(h[2], ctx)}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line), aligns = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c, ctx)}</${tag}>`;
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const call = /^\[!(\w+)\]([+-]?)\s*(.*)$/.exec(buf[0] || '');
      if (call) {
        const type = call[1].toLowerCase();
        const body = render(buf.slice(1).join('\n'), ctx);
        out.push(`<details class="callout c-${esc(type)}"${call[2] === '-' ? '' : ' open'}><summary>${inline(call[3] || type[0].toUpperCase() + type.slice(1), ctx)}</summary>${body}</details>`);
      } else out.push(`<blockquote>${render(buf.join('\n'), ctx)}</blockquote>`);
      continue;
    }
    if (FIELD.test(line)) {
      const rows = [];
      while (i < lines.length && FIELD.test(lines[i])) { const m = FIELD.exec(lines[i]); rows.push(`<div class="pk">${esc(m[1].trim())}</div><div class="pv">${m[2].trim() ? inline(m[2].trim(), ctx) : '<span class="empty">—</span>'}</div>`); i++; }
      out.push(`<div class="props">${rows.join('')}</div>`);
      continue;
    }
    if (CARD.test(line) && !/^\s*[-*+]\s+\[/.test(line)) {
      const m = CARD.exec(line);
      out.push(`<div class="fcard"><div class="fq">${inline(m[1], ctx)}</div><button class="fa">Show answer</button><div class="fans">${inline(m[2], ctx)}</div></div>`);
      i++; continue;
    }
    if (/^\s*Q:\s+/.test(line) && /^\s*A:\s+/.test(lines[i + 1] || '')) {
      out.push(`<div class="fcard"><div class="fq">${inline(line.replace(/^\s*Q:\s+/, ''), ctx)}</div><button class="fa">Show answer</button><div class="fans">${inline(lines[i + 1].replace(/^\s*A:\s+/, ''), ctx)}</div></div>`);
      i += 2; continue;
    }
    if (LIST.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) { items.push({ ind: m[1].replace(/\t/g, '    ').length, ord: /\d/.test(m[2]), start: parseInt(m[2], 10), task: m[3], text: m[4], line: i }); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; continue; }
        break;
      }
      out.push(renderList(items, 0, items.length, ctx));
      continue;
    }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++]);
    out.push(`<p>${buf.map((l) => inline(l, ctx)).join('<br>')}</p>`);
  }
  return out.join('\n');
}

function renderList(items, from, to, ctx) {
  if (from >= to) return '';
  const base = items[from].ind, ord = items[from].ord;
  let html = ord ? `<ol${items[from].start > 1 ? ` start="${items[from].start}"` : ''}>` : '<ul>';
  let k = from;
  while (k < to) {
    const it = items[k];
    let j = k + 1;
    while (j < to && items[j].ind > base) j++;
    const kids = j > k + 1 ? renderList(items, k + 1, j, ctx) : '';
    const text = it.text.split('\n').map((t) => inline(t, ctx)).join('<br>');
    const cls = [it.task ? 'task' : '', it.task && it.task !== ' ' ? 'done' : '', kids ? 'kids' : ''].filter(Boolean).join(' ');
    html += `<li${cls ? ` class="${cls}"` : ''} data-line="${it.line}">${kids ? '<span class="fold"></span>' : ''}${it.task ? `<input type="checkbox" data-line="${it.line}"${it.task !== ' ' ? ' checked' : ''}> ` : ''}<span class="li">${text}</span>${kids}</li>`;
    k = j;
  }
  return html + (ord ? '</ol>' : '</ul>');
}

export function outline(src) {
  const out = []; let code = false;
  String(src).split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) code = !code;
    const h = !code && /^(#{1,6})\s+(.*?)\s*#*$/.exec(l);
    if (h) out.push({ level: h[1].length, text: h[2], id: 'h-' + slug(h[2]), line: i });
  });
  return out;
}
