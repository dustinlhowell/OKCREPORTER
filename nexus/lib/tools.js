// Nexus tools shared by Ask Claude (in-app, via the Anthropic SDK tool runner) and the MCP connector
// (Claude apps on phone/desktop). Each tool: { name, description, inputSchema (zod), run(input), label(input) }.
// Tools act as the given user and only see what that user can see.
import { z } from 'zod';
import { zonedToUtc } from './time.js';

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length - n} more characters]` : s || '');

// Insert text at the end of the section under `heading` (created at the end of the note if missing).
export function appendUnder(content, heading, text) {
  const lines = String(content || '').split('\n');
  const hi = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === heading.toLowerCase());
  if (hi < 0) return String(content || '').replace(/\s*$/, '') + `\n\n## ${heading}\n${text}\n`;
  const level = lines[hi].match(/^#+/)[0].length;
  let end = hi + 1;
  while (end < lines.length && !new RegExp(`^#{1,${level}}\\s`).test(lines[end])) end++;
  while (end > hi + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, text);
  return lines.join('\n');
}

export function buildTools({ deps, user, tz }) {
  const { q, visible, saveNote, getNote, createEvent, eventsInRange, health, ensureDaily, origin } = deps;
  const aiHidden = deps.aiHidden || (() => false);
  const uid = user.id;
  const users = q('SELECT id, name FROM users ORDER BY id').all();
  const userIds = (names = []) => names.map((nm) => users.find((u) => u.name.toLowerCase() === String(nm).toLowerCase())?.id).filter(Boolean);
  const findNote = (ref) => {
    const r = String(ref ?? '').trim();
    const row = /^\d+$/.test(r)
      ? q(`SELECT n.id FROM notes n WHERE n.id = :r AND ${visible}`).get({ r: +r, uid })
      : q(`SELECT n.id FROM notes n WHERE lower(n.title) = lower(:r) AND ${visible}`).get({ r, uid });
    return row ? row.id : null;
  };
  const noteLine = (n) => `[[${n.title}]]${n.folder ? ` (folder: ${n.folder})` : ''}`;
  const localToIso = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(s));
    if (!m) throw new Error(`Bad date/time "${s}" – use YYYY-MM-DD or YYYY-MM-DDTHH:MM`);
    return new Date(zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), 0, tz)).toISOString();
  };
  const fmtLocal = (iso, allDay) => (allDay ? iso.slice(0, 10)
    : new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

  const tool = (spec, run, label) => ({ ...spec, run, label });

  const tools = [
    tool({
      name: 'capture',
      description: 'Save a quick thought, voice memo, idea, reminder or to-dos into the user\'s Nexus inbox so nothing gets lost. '
        + 'Short thoughts are added to today\'s daily note under "Inbox" with the time; pass a title (or longer text) to save a memo as its own note in the Inbox folder. '
        + 'Put action items in `tasks` (with a due date when the user mentioned one: resolve "Friday", "tomorrow" etc. to YYYY-MM-DD) instead of leaving them in `text`. '
        + 'Keep the user\'s wording; tidy up obvious dictation errors only.',
      inputSchema: z.object({
        text: z.string().optional().describe('The thought or memo, in Markdown. May be omitted when only tasks are captured.'),
        title: z.string().optional().describe('Title to save a longer memo as its own note'),
        tasks: z.array(z.object({
          text: z.string(),
          due: z.string().optional().describe('YYYY-MM-DD'),
          time: z.string().optional().describe('HH:MM, 24-hour'),
        })).optional(),
        tags: z.array(z.string()).optional().describe('Tags without #, e.g. ["homelab"]'),
      }),
    }, ({ text = '', title, tasks = [], tags = [] }) => {
      text = text.trim();
      if (!text && !tasks.length) return 'Nothing to capture.';
      const now = new Date();
      const today = now.toLocaleDateString('sv', { timeZone: tz });
      const time = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      const tagStr = tags.map((t) => '#' + String(t).replace(/^#/, '').replace(/\s+/g, '-')).join(' ');
      const taskLines = tasks.filter((t) => t.text?.trim()).map((t) => {
        const due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? ` @${t.due}${/^\d{1,2}:\d{2}$/.test(t.time || '') ? ' ' + t.time : ''}` : '';
        return `- [ ] ${t.text.trim()}${due}`;
      });
      const daily = ensureDaily(uid, today, origin);
      let dailyText, saved;
      if (title || text.length > 280 || text.includes('\n')) {
        const t = (title || text.split(/\s+/).slice(0, 7).join(' ')).replace(/[[\]|#^]/g, '').slice(0, 80);
        const body = [tagStr, text, taskLines.length ? `## Tasks\n${taskLines.join('\n')}` : '', `---\nCaptured ${today} ${time} · [[${today}]]`].filter(Boolean).join('\n\n');
        const n = saveNote(uid, { title: t, folder: 'Inbox', icon: '📥', content: body }, origin);
        dailyText = `- ${time} 📥 [[${n.title}]]`;
        saved = `Saved as a new note [[${n.title}]] in the Inbox folder, linked from today's note`;
      } else {
        dailyText = [text ? `- ${time} ${text}${tagStr ? ' ' + tagStr : ''}` : '', ...taskLines].filter(Boolean).join('\n');
        saved = `Saved to the Inbox in today's note [[${today}]]`;
      }
      const cur = getNote(daily.id, uid);
      saveNote(uid, { id: daily.id, content: appendUnder(cur.content, 'Inbox', dailyText), revReason: 'Before a capture' }, origin);
      const dated = taskLines.filter((l) => / @\d{4}-/.test(l)).length;
      return `${saved}${taskLines.length ? `, with ${taskLines.length} task${taskLines.length > 1 ? 's' : ''}${dated ? ` (${dated} on the calendar)` : ''}` : ''}.`;
    }, ({ title, tasks }) => (title ? `Captured “${title}”` : tasks?.length ? `Captured ${tasks.length} task${tasks.length > 1 ? 's' : ''}` : 'Captured to inbox')),

    tool({
      name: 'search_notes',
      readOnly: true,
      description: 'Full-text search across all notes the user can see. Returns matching note titles with a snippet. Use short keyword queries.',
      inputSchema: z.object({ query: z.string().describe('Keywords to search for') }),
    }, ({ query }) => {
      const terms = query.replace(/["*():^]/g, ' ').split(/\s+/).filter(Boolean);
      if (!terms.length) return 'Empty query.';
      // Whole-word matches rank first; prefix matches ("kube" → kubernetes) fill in after.
      const sql = `SELECT n.id, n.title, n.folder, snippet(notes_fts, 1, '«', '»', '…', 18) AS snip FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
        WHERE notes_fts MATCH :m AND ${visible} ORDER BY bm25(notes_fts, 8.0, 1.0) LIMIT 15`;
      const rows = q(sql).all({ m: terms.map((t) => `"${t}"`).join(' OR '), uid });
      if (rows.length < 15) {
        const seen = new Set(rows.map((r) => r.id));
        for (const r of q(sql).all({ m: terms.map((t) => `"${t}"*`).join(' OR '), uid })) if (!seen.has(r.id) && rows.length < 15) rows.push(r);
      }
      return rows.length ? rows.map((r) => `- ${noteLine(r)}: ${r.snip.replace(/\n/g, ' ')}`).join('\n') : `No notes match "${query}".`;
    }, ({ query }) => `Searched notes for “${query}”`),

    tool({
      name: 'read_note',
      readOnly: true,
      description: 'Read the full Markdown content of a note, plus its tags, properties and which notes link to it.',
      inputSchema: z.object({ title: z.string().describe('Exact note title (or numeric id)') }),
    }, ({ title }) => {
      const id = findNote(title);
      if (!id) return `No note titled "${title}". Try search_notes.`;
      const n = getNote(id, uid);
      const files = q('SELECT id, name, mime, size FROM attachments WHERE note_id = ? ORDER BY created').all(id);
      const fileList = files.length ? `\nattachments (use read_attachment): ${files.map((f) => `${f.name} [id ${f.id}, ${f.mime}, ${Math.ceil(f.size / 1024)} KB]`).join('; ')}` : '';
      return `# ${n.title}${fileList}\nfolder: ${n.folder || '(root)'} · updated ${new Date(n.updated).toISOString().slice(0, 10)}${n.updated_by_name ? ` by ${n.updated_by_name}` : ''}\n`
        + `linked from: ${n.backlinks.filter((b) => !aiHidden(b.id)).map((b) => `[[${b.title}]]`).join(', ') || 'none'}\n\n${trunc(n.content, 60000)}`;
    }, ({ title }) => `Read “${title}”`),

    tool({
      name: 'read_attachment',
      readOnly: true,
      description: 'Look at a file attached to a note: images (photos, screenshots) and PDFs are shown to you directly; text files are returned as text. Use the file name or id listed by read_note.',
      inputSchema: z.object({ file: z.string().describe('File name or numeric id') }),
    }, ({ file }) => {
      const a = deps.findAttachment?.(file, uid);
      if (!a) return `No attachment "${file}" found. Use read_note to see a note's attachments.`;
      if (a.mime.startsWith('text/') || a.mime === 'application/json') return `${a.name}:\n\n${trunc(a.read().toString('utf8'), 60000)}`;
      if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(a.mime)) {
        if (a.size > 5 * 1024 * 1024) return `${a.name} is ${(a.size / 1048576).toFixed(1)} MB – images over 5 MB can't be viewed. Ask the user for a smaller copy.`;
        return [{ type: 'text', text: `Image ${a.name}:` }, { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.read().toString('base64') } }];
      }
      if (a.mime === 'application/pdf') {
        if (a.size > 30 * 1024 * 1024) return `${a.name} is too large to read (over 30 MB).`;
        return [{ type: 'text', text: `PDF ${a.name}:` }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.read().toString('base64') }, title: a.name }];
      }
      if (a.mime.startsWith('audio/')) return `${a.name} is an audio recording. You can't listen to audio; if a transcript was captured with it, it is in the note text next to the recording.`;
      if (a.mime === 'image/heic') return `${a.name} is a HEIC photo, which can't be viewed. On iPhone set Camera → Formats → Most Compatible, or share it as JPEG.`;
      return `${a.name} (${a.mime}) can't be read directly.`;
    }, ({ file }) => `Opened attachment “${file}”`),

    tool({
      name: 'list_notes',
      readOnly: true,
      description: 'List notes, optionally filtered by tag (e.g. "cert", "kb", "service") and/or folder. For tagged notes the result includes their properties (key:: value), like a database table.',
      inputSchema: z.object({ tag: z.string().optional().describe('Tag without #'), folder: z.string().optional() }),
    }, ({ tag, folder }) => {
      const t = tag?.replace(/^#/, '').toLowerCase();
      const rows = q(`SELECT n.id, n.title, n.folder FROM notes n ${t ? 'JOIN tags tg ON tg.note_id = n.id AND tg.tag = :t' : ''}
        WHERE ${visible} ${folder ? "AND (n.folder = :f OR n.folder LIKE :f || '/%')" : ''} ORDER BY n.title LIMIT 300`)
        .all({ uid, ...(t ? { t } : {}), ...(folder ? { f: folder } : {}) });
      if (!rows.length) return 'No notes found.';
      return rows.map((r) => {
        const f = t ? q('SELECT key, value FROM fields WHERE note_id = ?').all(r.id).map((x) => `${x.key}=${x.value}`).join('; ') : '';
        const h = t === 'service' && health.get(r.id) ? ` · ${health.get(r.id).ok ? 'UP' : 'DOWN'}` : '';
        return `- ${noteLine(r)}${f ? ` — ${f}` : ''}${h}`;
      }).join('\n');
    }, ({ tag, folder }) => `Listed notes${tag ? ` tagged #${tag}` : ''}${folder ? ` in ${folder}` : ''}`),

    tool({
      name: 'create_note',
      description: 'Create a new note. Write the content in Nexus Markdown. To make it a database item, start the content with its supertag (e.g. "#kb") and properties.',
      inputSchema: z.object({
        title: z.string(),
        content: z.string().describe('Markdown body'),
        folder: z.string().optional().describe('Folder path, e.g. "Work KB" or "Homelab/Docker"'),
      }),
    }, ({ title, content, folder }) => {
      const n = saveNote(uid, { title, content, folder: folder || '' }, origin);
      return `Created [[${n.title}]]${n.title !== title ? ` (renamed because "${title}" already exists)` : ''}.`;
    }, ({ title }) => `Created note “${title}”`),

    tool({
      name: 'append_to_note',
      description: 'Append Markdown to the end of an existing note (or under a heading if given).',
      inputSchema: z.object({ title: z.string(), text: z.string(), under_heading: z.string().optional().describe('Insert at the end of this section instead of the end of the note') }),
    }, ({ title, text, under_heading }) => {
      const id = findNote(title);
      if (!id) return `No note titled "${title}".`;
      const { content } = getNote(id, uid);
      let next;
      if (under_heading) {
        const lines = content.split('\n');
        const hi = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === under_heading.trim().toLowerCase());
        if (hi < 0) return `Heading "${under_heading}" not found in [[${title}]].`;
        const level = lines[hi].match(/^#+/)[0].length;
        let end = hi + 1;
        while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[end]))) end++;
        while (end > hi + 1 && !lines[end - 1].trim()) end--;
        lines.splice(end, 0, text);
        next = lines.join('\n');
      } else next = content.replace(/\s*$/, '') + '\n\n' + text + '\n';
      saveNote(uid, { id, content: next, revReason: 'Before an edit by Claude' }, origin);
      return `Appended to [[${title}]].`;
    }, ({ title }) => `Added to “${title}”`),

    tool({
      name: 'replace_in_note',
      description: 'Replace an exact piece of text in a note with new text (find/replace once). old_text must appear exactly once; read the note first.',
      inputSchema: z.object({ title: z.string(), old_text: z.string(), new_text: z.string() }),
    }, ({ title, old_text, new_text }) => {
      const id = findNote(title);
      if (!id) return `No note titled "${title}".`;
      const { content } = getNote(id, uid);
      const count = content.split(old_text).length - 1;
      if (count !== 1) return `old_text appears ${count} times in [[${title}]] – it must appear exactly once. Read the note and use a longer, unique excerpt.`;
      saveNote(uid, { id, content: content.replace(old_text, () => new_text), revReason: 'Before an edit by Claude' }, origin);
      return `Updated [[${title}]].`;
    }, ({ title }) => `Edited “${title}”`),

    tool({
      name: 'list_events',
      readOnly: true,
      description: 'List calendar events and dated tasks for the household between two dates (inclusive), in the user\'s time zone.',
      inputSchema: z.object({ from: z.string().describe('YYYY-MM-DD'), to: z.string().describe('YYYY-MM-DD') }),
    }, ({ from, to }) => {
      const a = Date.parse(localToIso(from)), b = Date.parse(localToIso(to)) + 864e5;
      if (b - a > 370 * 864e5) return 'Range too long – ask for at most a year.';
      const { events, tasks } = eventsInRange(uid, a, b);
      const cals = new Map(q('SELECT id, name, user_id FROM calendars').all().map((c) => [c.id, c]));
      const name = (id) => users.find((u) => u.id === id)?.name;
      const evs = events.filter((e) => (e.all_day ? e.end > from && e.start <= to : Date.parse(e.end) > a && Date.parse(e.start) < b))
        .sort((x, y) => (x.start < y.start ? -1 : 1))
        .map((e) => {
          const cal = cals.get(e.calendar_id);
          const who = (e.who.length ? e.who : cal?.user_id ? [cal.user_id] : []).map(name).filter(Boolean);
          return `- ${fmtLocal(e.start, e.all_day)}${e.all_day ? ' (all day)' : `–${fmtLocal(e.end).split(', ').pop()}`}: ${e.title}${e.location ? ` @ ${e.location}` : ''} · ${who.join(' & ') || 'everyone'} · ${cal?.name}${e.rrule ? ' · repeats' : ''}`;
        });
      const ts = tasks.filter((t) => t.due >= from && t.due <= to && !aiHidden(t.note_id)).map((t) => `- ${t.due}: [${t.done ? 'x' : ' '}] ${t.text} (task in [[${t.note_title}]])`);
      return [...evs, ...ts].join('\n') || 'Nothing scheduled in that range.';
    }, ({ from, to }) => `Checked the calendar ${from}${to !== from ? ` → ${to}` : ''}`),

    tool({
      name: 'create_event',
      description: 'Add an event to a calendar. Times are local (user\'s time zone). Defaults to the shared Household calendar.',
      inputSchema: z.object({
        title: z.string(),
        start: z.string().describe('YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day'),
        end: z.string().optional().describe('Same format; defaults to 1 hour after start (or the same day for all-day)'),
        all_day: z.boolean().optional(),
        who: z.array(z.string()).optional().describe('Names of household members involved'),
        calendar: z.string().optional().describe('Calendar name; omit for Household'),
        location: z.string().optional(),
        description: z.string().optional(),
        repeat: z.enum(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly']).optional(),
      }),
    }, async (i) => {
      const cals = q('SELECT * FROM calendars WHERE kind != \'ics\' AND (user_id IS NULL OR user_id = ? OR (kind = \'local\' AND shared = 1))').all(uid);
      const cal = i.calendar ? cals.find((c) => c.name.toLowerCase().includes(i.calendar.toLowerCase())) : cals.find((c) => c.user_id === null && c.kind === 'local');
      if (!cal) return `No writable calendar matching "${i.calendar}". Available: ${cals.map((c) => c.name).join(', ')}`;
      const allDay = i.all_day ?? !/T|\s\d/.test(i.start);
      let start, end;
      if (allDay) { start = i.start.slice(0, 10); end = i.end ? new Date(Date.parse(i.end.slice(0, 10)) + 864e5).toISOString().slice(0, 10) : new Date(Date.parse(start) + 864e5).toISOString().slice(0, 10); }
      else { start = localToIso(i.start); end = i.end ? localToIso(i.end) : new Date(Date.parse(start) + 3600e3).toISOString(); }
      const rrule = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' }[i.repeat] || null;
      const r = await createEvent(uid, { calendar_id: cal.id, title: i.title, start, end, all_day: allDay, tz, who: userIds(i.who), location: i.location, description: i.description, rrule }, origin);
      return `Added "${i.title}" on ${fmtLocal(allDay ? start : start, allDay)} to the ${r.calendar} calendar.`;
    }, (i) => `Added event “${i.title}”`),

    tool({
      name: 'server_status',
      readOnly: true,
      description: 'Live status of the household\'s Unraid server: array state and space, each disk\'s health and temperature, and Docker containers. Also includes the #service health checks.',
      inputSchema: z.object({}),
    }, () => {
      const u = deps.unraid?.();
      const svc = q(`SELECT n.id, n.title FROM notes n JOIN tags t ON t.note_id = n.id AND t.tag = 'service' WHERE ${visible}`).all({ uid })
        .map((r) => { const h = health.get(r.id); return h ? `- ${r.title}: ${h.down ? 'DOWN' : h.ok ? `up (${h.ms} ms)` : 'failing'}` : null; }).filter(Boolean);
      return `${u || 'Unraid isn\'t connected to Nexus (set UNRAID_URL and UNRAID_API_KEY).'}${svc.length ? `\n\nService checks:\n${svc.join('\n')}` : ''}`;
    }, () => 'Checked the server'),

    tool({
      name: 'list_tasks',
      readOnly: true,
      description: 'List open to-do items from all notes (with due dates where set).',
      inputSchema: z.object({ include_done: z.boolean().optional() }),
    }, ({ include_done }) => {
      const rows = q(`SELECT t.text, t.done, t.due, n.title FROM tasks t JOIN notes n ON n.id = t.note_id WHERE ${visible} ${include_done ? '' : 'AND t.done = 0'}
        ORDER BY t.due IS NULL, t.due LIMIT 200`).all({ uid });
      return rows.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ` (due ${t.due})` : ''} — [[${t.title}]]`).join('\n') || 'No open tasks.';
    }, () => 'Checked tasks'),
  ];
  return tools;
}
