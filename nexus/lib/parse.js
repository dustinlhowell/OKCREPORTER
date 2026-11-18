// Extracts structure from Markdown note content:
//   [[Wiki Links]]            -> links (Obsidian)
//   #tags / #supertags        -> tags   (Tana)
//   key:: value               -> fields / properties (Tana + Notion database columns)
//   - [ ] task @2026-11-20    -> tasks with optional due date (shown on the calendar)
//   Question ?? Answer        -> flashcards (spaced repetition)
//   Q: question / A: answer   -> flashcards
import { createHash } from 'node:crypto';

const FENCE = /^(```|~~~)/;
export const WIKILINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const TAG = /(^|[\s(,])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const FIELD = /^\s*(?:[-*]\s+)?([\p{L}\p{N}_][\p{L}\p{N}_ \-]{0,40}?)::\s*(.*)$/u;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const DUE = /(?:@|📅\s?|due:\s?)(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/;
const CARD_INLINE = /^\s*(?:[-*]\s+)?(.+?)\s+\?\?\s+(.+)$/;

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export function parseNote(content) {
  const links = new Set(), tags = new Set(), fields = {}, tasks = [], cards = [];
  const lines = String(content || '').split('\n');
  let inCode = false, pendingQ = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line.trim())) { inCode = !inCode; continue; }
    if (inCode) continue;
    const text = line.replace(/`[^`]*`/g, '');

    for (const m of text.matchAll(WIKILINK)) links.add(m[1].trim().toLowerCase());
    for (const m of text.matchAll(TAG)) tags.add(m[2].toLowerCase());

    const f = FIELD.exec(text);
    if (f && !/^https?$/i.test(f[1].trim())) {
      const key = f[1].trim().toLowerCase();
      if (!(key in fields)) fields[key] = f[2].trim();
    }

    const t = TASK.exec(line);
    if (t) {
      const due = DUE.exec(t[3]);
      tasks.push({ line: i, text: t[3].replace(DUE, '').trim(), done: t[2] !== ' ', due: due ? due[1] : null, time: due && due[2] ? due[2].padStart(5, '0') : null });
    }

    const c = CARD_INLINE.exec(text);
    if (c) cards.push({ front: c[1].trim(), back: c[2].trim(), hash: hash(c[1].trim()) });
    const q = /^\s*Q:\s+(.+)$/.exec(text), a = /^\s*A:\s+(.+)$/.exec(text);
    if (q) pendingQ = q[1].trim();
    else if (a && pendingQ) { cards.push({ front: pendingQ, back: a[1].trim(), hash: hash(pendingQ) }); pendingQ = null; }
    else if (text.trim()) pendingQ = null;
  }
  return { links: [...links], tags: [...tags], fields, tasks, cards };
}

// Set or add a `key:: value` line in content (used by database/table edits).
export function setField(content, key, value) {
  const lines = String(content || '').split('\n');
  const lk = key.toLowerCase();
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i].trim())) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = FIELD.exec(lines[i]);
    if (m && m[1].trim().toLowerCase() === lk) {
      if (value === null || value === '') lines.splice(i, 1);
      else lines[i] = lines[i].replace(/::\s*.*$/, `:: ${value}`);
      return lines.join('\n');
    }
  }
  if (value === null || value === '') return content;
  // Insert after the last leading field line (or the leading tag line), else at top.
  let at = 0;
  while (at < lines.length && (FIELD.test(lines[at]) || /^\s*(#[\p{L}\p{N}_][^\s]*\s*)+$/u.test(lines[at]))) at++;
  lines.splice(at, 0, `${key}:: ${value}`);
  return lines.join('\n');
}

export function setTask(content, lineNo, done) {
  const lines = String(content || '').split('\n');
  if (lines[lineNo] && TASK.test(lines[lineNo])) lines[lineNo] = lines[lineNo].replace(/\[([ xX])\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}
