// "Ask Claude" chat view. Streams answers from /api/claude/chat; Claude can read and edit notes and the calendar.
import { render, esc } from './md.js';

const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const SUGGESTIONS = [
  "What's on our calendar this week?",
  'Quiz me on my AZ-104 flashcards',
  'Which homelab services are down, and what do my notes say about them?',
  'Summarize what I wrote in my notes this week',
  'Turn my notes on resetting MFA into a step-by-step runbook',
  'Add a dentist appointment for me next Tuesday at 3pm',
  "What's new in the latest Proxmox VE release, and does it affect my setup?",
];

export async function viewClaude(main, app, params) {
  const { state } = app;
  app.setTitle('Ask Claude');
  main.className = 'claudemain';
  const cfg = state.claude || {};
  if (!cfg.configured) {
    main.innerHTML = `<div class="page"><h1>✨ Ask Claude</h1>
      <p>Claude isn't connected yet. Once it is, you can ask questions about everything in Nexus, and have it write notes, build study cards or add calendar events for you.</p>
      <ol><li>Create an API key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com → API keys</a>, and add credits under <b>Billing</b>.</li>
      <li>In Unraid, go to <b>Docker → Nexus → Edit → Show more settings</b>, and paste the key into <b>Anthropic API key</b>. Click <b>Apply</b>.</li></ol>
      <p class="muted small">Your Claude.ai subscription can't be used here; apps like Nexus use a separate, pay-as-you-go API account.</p></div>`;
    return {};
  }

  let noteId = +params.get('note') || null;
  let chat = LS.get('claude.chat', []); // [{role, text, tools?:[label]}]
  let ctrl = null;

  main.innerHTML = `<div class="claude">
    <div class="chead"><h1>✨ Ask Claude</h1><span id="ctx"></span><span class="sp"></span><button class="btn sm" id="newChat">New chat</button></div>
    <div class="cmsgs" id="msgs"></div>
    <form class="cinput" id="form"><textarea id="q" rows="1" placeholder="Ask about your notes, calendar or homelab…"></textarea>
      <button class="btn primary" id="send">Send</button></form>
    <p class="cfoot muted">Claude can read your notes and calendar, and create or edit them as you. Notes it reads are sent to Anthropic's API.</p></div>`;
  const msgs = main.querySelector('#msgs'), q = main.querySelector('#q'), form = main.querySelector('#form'), sendBtn = main.querySelector('#send');

  const drawCtx = () => {
    const n = noteId && state.byId.get(noteId);
    main.querySelector('#ctx').innerHTML = n ? `<span class="ctxchip">📄 ${esc(n.title)} <button class="iconbtn sm" id="clearCtx" title="Stop sharing this note">✕</button></span>` : '';
  };
  const bubble = (m, i) => m.role === 'user'
    ? `<div class="cmsg user"><div class="cb">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`
    : `<div class="cmsg bot" data-i="${i}">${(m.tools || []).map((t) => `<div class="ctool">${esc(t)}</div>`).join('')}<div class="cb md">${m.text ? render(m.text, app.mdctx()) : ''}${m.pending ? '<span class="dots"><i></i><i></i><i></i></span>' : ''}${m.error ? `<div class="cerr">⚠ ${esc(m.error)}</div>` : ''}${m.sources?.length ? `<div class="csrc"><b>Sources</b>${m.sources.map((x) => { let h = ''; try { h = new URL(x.url).hostname.replace(/^www\./, ''); } catch {} return `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}<span>${esc(h)}</span></a>`; }).join('')}</div>` : ''}</div></div>`;
  const draw = () => {
    msgs.innerHTML = chat.length ? chat.map(bubble).join('')
      : `<div class="cempty"><p>Ask anything about your notes, calendar or homelab, or something on the web. Claude can also create notes, flashcards and events.</p>
         <div class="csugg">${SUGGESTIONS.map((s) => `<button class="btn">${esc(s)}</button>`).join('')}</div></div>`;
    msgs.scrollTop = msgs.scrollHeight;
  };
  const drawLast = () => {
    const i = chat.length - 1, el = msgs.querySelector(`[data-i="${i}"]`);
    const stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    if (el) el.outerHTML = bubble(chat[i], i); else draw();
    if (stick) msgs.scrollTop = msgs.scrollHeight;
  };
  const save = () => LS.set('claude.chat', chat.map(({ pending, ...m }) => m).slice(-40));
  const autosize = () => { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 200) + 'px'; };

  async function ask(text) {
    if (!text.trim() || ctrl) return;
    chat.push({ role: 'user', text }, { role: 'assistant', text: '', tools: [], pending: true });
    q.value = ''; autosize(); draw(); save();
    ctrl = new AbortController();
    sendBtn.textContent = 'Stop'; sendBtn.classList.remove('primary');
    const bot = chat[chat.length - 1];
    let rafQueued = false;
    const redraw = () => { if (!rafQueued) { rafQueued = true; requestAnimationFrame(() => { rafQueued = false; drawLast(); }); } };
    try {
      const res = await fetch('/api/claude/chat', {
        method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: chat.slice(0, -1).map(({ role, text: t }) => ({ role, text: t })), noteId, tz: TZ }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 2);
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'text') bot.text += ev.text;
          else if (ev.type === 'text_start' && bot.text && !bot.text.endsWith('\n')) bot.text += '\n\n';
          else if (ev.type === 'tool') bot.tools.push(ev.label);
          else if (ev.type === 'error') bot.error = ev.message;
          else if (ev.type === 'sources') bot.sources = ev.items;
          redraw();
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') bot.error = e.message; else bot.text += bot.text ? '\n\n*(stopped)*' : '*(stopped)*';
    } finally {
      bot.pending = false; ctrl = null;
      sendBtn.textContent = 'Send'; sendBtn.classList.add('primary');
      drawLast(); save();
    }
  }

  form.onsubmit = (e) => { e.preventDefault(); if (ctrl) ctrl.abort(); else ask(q.value); };
  q.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
  q.oninput = autosize;
  main.querySelector('#newChat').onclick = () => { if (ctrl) ctrl.abort(); chat = []; save(); draw(); q.focus(); };
  main.onclick = (e) => {
    const s = e.target.closest('.csugg .btn'); if (s) return ask(s.textContent);
    if (e.target.closest('#clearCtx')) { noteId = null; drawCtx(); return; }
    const wl = e.target.closest('.wl'); if (wl) { e.preventDefault(); return app.openByTitle(wl.dataset.title); }
    const tg = e.target.closest('.tag'); if (tg) return app.go(`/db/${encodeURIComponent(tg.dataset.tag)}`);
    if (e.target.classList.contains('fa')) { e.target.parentElement.classList.toggle('show'); return; }
    if (e.target.classList.contains('copy')) navigator.clipboard?.writeText(e.target.parentElement.querySelector('code').textContent);
  };

  drawCtx(); draw();
  const initial = params.get('q');
  if (initial) { history.replaceState(null, '', `#/claude${noteId ? `?note=${noteId}` : ''}`); ask(initial); } else q.focus();
  return { teardown: () => { if (ctrl) ctrl.abort(); main.onclick = null; } };
}
