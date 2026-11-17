// Markdown editor on a plain <textarea> (fast for huge notes) with Obsidian/Notion-style helpers.
import { esc } from './md.js';

const today = () => new Date().toLocaleDateString('sv');
const SLASH = [
  { k: 'h1', label: 'Heading 1', icon: 'H1', ins: '# ' }, { k: 'h2', label: 'Heading 2', icon: 'H2', ins: '## ' }, { k: 'h3', label: 'Heading 3', icon: 'H3', ins: '### ' },
  { k: 'todo', label: 'To-do', icon: '☐', ins: '- [ ] ' }, { k: 'bullet', label: 'Bulleted list', icon: '•', ins: '- ' }, { k: 'number', label: 'Numbered list', icon: '1.', ins: '1. ' },
  { k: 'due', label: 'To-do with due date', icon: '📅', ins: () => `- [ ] ‸ @${today()}` },
  { k: 'table', label: 'Table', icon: '▦', ins: '| Column | Column |\n| --- | --- |\n| | |' },
  { k: 'code', label: 'Code block', icon: '</>', ins: '```bash\n‸\n```' },
  { k: 'callout', label: 'Callout', icon: '💡', ins: '> [!tip] ‸\n> ' }, { k: 'warning', label: 'Warning callout', icon: '⚠️', ins: '> [!warning] ‸\n> ' },
  { k: 'quote', label: 'Quote', icon: '❝', ins: '> ' }, { k: 'divider', label: 'Divider', icon: '—', ins: '---\n' },
  { k: 'field', label: 'Property (key:: value)', icon: '≔', ins: '‸:: ' },
  { k: 'card', label: 'Flashcard (Q ?? A)', icon: '🃏', ins: '‸ ?? ' }, { k: 'qa', label: 'Flashcard (Q:/A:)', icon: '🃏', ins: 'Q: ‸\nA: ' },
  { k: 'link', label: 'Link to note', icon: '🔗', ins: '[[‸]]' }, { k: 'date', label: "Today's date", icon: '📆', ins: () => today() },
  { k: 'time', label: 'Current time', icon: '🕑', ins: () => new Date().toTimeString().slice(0, 5) },
];

function caretXY(ta, pos) {
  const m = document.createElement('div');
  const cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderTopWidth', 'boxSizing', 'tabSize', 'width'])
    m.style[p] = cs[p];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', top: 0, left: 0 });
  m.textContent = ta.value.slice(0, pos);
  const s = document.createElement('span'); s.textContent = '\u200b'; m.appendChild(s);
  document.body.appendChild(m);
  const r = ta.getBoundingClientRect();
  const xy = { x: r.left + s.offsetLeft - ta.scrollLeft, y: r.top + s.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || 20) };
  m.remove();
  return xy;
}

function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return 1;
  const idx = s.indexOf(q);
  if (idx >= 0) return 100 - idx - s.length / 100;
  let j = 0, score = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) { score += i === 0 || /\W/.test(s[i - 1]) ? 3 : 1; j++; }
  return j === q.length ? score : 0;
}
export { fuzzy };

export function enhanceEditor(ta, { titles, tags, templates, onSave }) {
  let pop = null, items = [], sel = 0, mode = null, anchor = 0;

  const close = () => { pop?.remove(); pop = null; mode = null; };
  function show(list, m, a) {
    items = list.slice(0, 12); mode = m; anchor = a; sel = 0;
    if (!items.length) return close();
    if (!pop) { pop = document.createElement('div'); pop.className = 'pop'; document.body.appendChild(pop); pop.addEventListener('mousedown', (e) => { e.preventDefault(); const li = e.target.closest('[data-i]'); if (li) { sel = +li.dataset.i; accept(); } }); }
    pop.innerHTML = items.map((it, i) => `<div class="pi${i === sel ? ' sel' : ''}" data-i="${i}"><span class="pic">${esc(it.icon || '')}</span>${esc(it.label)}${it.hint ? `<span class="ph">${esc(it.hint)}</span>` : ''}</div>`).join('');
    const { x, y } = caretXY(ta, ta.selectionStart);
    const w = 280;
    pop.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    pop.style.top = (y + 220 > innerHeight ? y - 240 : y + 4) + 'px';
  }
  const highlight = () => pop?.querySelectorAll('.pi').forEach((el, i) => { el.classList.toggle('sel', i === sel); if (i === sel) el.scrollIntoView({ block: 'nearest' }); });

  function replaceRange(a, b, text) {
    ta.focus();
    ta.setSelectionRange(a, b);
    let caret = text.indexOf('‸');
    const clean = text.replace('‸', '');
    if (!document.execCommand('insertText', false, clean)) ta.setRangeText(clean, a, b, 'end');
    if (caret >= 0) ta.setSelectionRange(a + caret, a + caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function accept() {
    const it = items[sel]; if (!it) return close();
    const pos = ta.selectionStart;
    const m = mode; close();
    if (m === 'link') {
      const after = ta.value.slice(pos, pos + 2) === ']]' ? 2 : 0;
      replaceRange(anchor, pos + after, `${it.value}]]‸`);
    } else if (m === 'tag') replaceRange(anchor, pos, `${it.value} ‸`);
    else if (m === 'slash') {
      const v = typeof it.ins === 'function' ? it.ins() : it.ins;
      replaceRange(anchor, pos, v.includes('‸') ? v : v + '‸');
    }
  }

  function update() {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return close();
    const before = ta.value.slice(Math.max(0, pos - 120), pos);
    const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
    const line = ta.value.slice(lineStart, pos);
    let m;
    if ((m = /\[\[([^\]\n|#]*)$/.exec(before))) {
      const qy = m[1];
      const list = titles().map((t) => ({ t, s: fuzzy(qy, t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12)
        .map((x) => ({ label: x.t, value: x.t, icon: '📄' }));
      if (qy && !list.some((x) => x.value.toLowerCase() === qy.toLowerCase())) list.push({ label: `Create “${qy}”`, value: qy, icon: '＋' });
      return show(list, 'link', pos - qy.length);
    }
    if ((m = /(?:^|\s)#([\p{L}\p{N}_\-/]*)$/u.exec(line)) && !/^#+$/.test(line.trim())) {
      const qy = m[1];
      const list = tags().map((t) => ({ t, s: fuzzy(qy, t.name) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
        .map((x) => ({ label: '#' + x.t.name, value: x.t.name, icon: x.t.icon || '#', hint: x.t.super ? 'supertag' : '' }));
      return show(list, 'tag', pos - qy.length);
    }
    if ((m = /^\s*\/([\w-]*)$/.exec(line))) {
      const qy = m[1];
      const tpl = templates().map((t) => ({ k: 'tpl ' + t.name, label: `Template: #${t.name}`, icon: t.icon || '#', ins: `#${t.name}\n${t.template}` }));
      const list = [...SLASH, ...tpl].map((c) => ({ c, s: Math.max(fuzzy(qy, c.k), fuzzy(qy, c.label)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c);
      return show(list, 'slash', pos - qy.length - 1);
    }
    close();
  }

  ta.addEventListener('input', update);
  ta.addEventListener('blur', () => setTimeout(close, 120));
  ta.addEventListener('click', close);

  ta.addEventListener('keydown', (e) => {
    if (pop) {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; highlight(); return e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; highlight(); return e.preventDefault(); }
      if (e.key === 'Enter' || e.key === 'Tab') { accept(); return e.preventDefault(); }
      if (e.key === 'Escape') { close(); return e.preventDefault(); }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') { e.preventDefault(); onSave?.(); return; }
    if (mod && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); wrap(e.key === 'b' ? '**' : '*'); return; }
    if (mod && e.key === 'k' && ta.selectionStart !== ta.selectionEnd) { e.preventDefault(); const s = ta.value.slice(ta.selectionStart, ta.selectionEnd); replaceRange(ta.selectionStart, ta.selectionEnd, `[[${s}]]‸`); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); toggleTask(); return; }
    if (e.key === 'Tab') { e.preventDefault(); indent(e.shiftKey); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const pos = ta.selectionStart;
      const ls = ta.value.lastIndexOf('\n', pos - 1) + 1;
      const line = ta.value.slice(ls, pos);
      const m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/.exec(line);
      if (m) {
        e.preventDefault();
        if (line.trim() === m[0].trim()) { replaceRange(ls, pos, '‸'); return; } // empty item -> end list
        let bullet = m[2];
        if (/\d/.test(bullet)) bullet = (parseInt(bullet, 10) + 1) + bullet.slice(-1);
        replaceRange(pos, pos, `\n${m[1]}${bullet}${m[3]}${m[4] ? '[ ] ' : ''}‸`);
        return;
      }
      const fm = /^(\s*)>\s?/.exec(line);
      if (fm && line.trim() !== '>') { e.preventDefault(); replaceRange(pos, pos, `\n${fm[1]}> ‸`); return; }
    }
    if (e.key === '(' || e.key === '[' || e.key === '`') {
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (s !== en) { e.preventDefault(); const pair = { '(': ')', '[': ']', '`': '`' }[e.key]; replaceRange(s, en, e.key + ta.value.slice(s, en) + pair + '‸'); }
      else if (e.key === '[' && ta.value[s - 1] === '[') { e.preventDefault(); replaceRange(s, s, '[‸]]'); }
    }
  });

  function wrap(m) {
    const s = ta.selectionStart, en = ta.selectionEnd, t = ta.value.slice(s, en);
    replaceRange(s, en, t ? `${m}${t}${m}‸` : `${m}‸${m}`);
  }
  function lineRange() {
    const s = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let e = ta.value.indexOf('\n', ta.selectionEnd); if (e < 0) e = ta.value.length;
    return [s, e];
  }
  function indent(out) {
    const [s, e] = lineRange();
    const block = ta.value.slice(s, e);
    const next = block.split('\n').map((l) => (out ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
    const ss = ta.selectionStart, delta = next.length - block.length;
    replaceRange(s, e, next);
    ta.setSelectionRange(Math.max(s, ss + (out ? Math.min(0, delta) : 2)), s + next.length);
  }
  function toggleTask() {
    const [s, e] = lineRange();
    const l = ta.value.slice(s, e);
    let n;
    if (/^\s*[-*+]\s+\[[ ]\]/.test(l)) n = l.replace('[ ]', '[x]');
    else if (/^\s*[-*+]\s+\[[xX]\]/.test(l)) n = l.replace(/\[[xX]\]/, '[ ]');
    else if (/^\s*[-*+]\s+/.test(l)) n = l.replace(/^(\s*[-*+]\s+)/, '$1[ ] ');
    else n = `- [ ] ${l}`;
    const pos = ta.selectionStart;
    replaceRange(s, e, n);
    ta.setSelectionRange(pos + n.length - l.length, pos + n.length - l.length);
  }

  return { close };
}
