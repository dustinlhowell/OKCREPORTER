// Canvas force-directed graph of notes and [[links]]. Grid-bucketed repulsion keeps it ~O(n).
export function mountGraph(canvas, data, { onOpen, colorFor, focusId }) {
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const nodes = data.nodes.map((n, i) => ({ ...n, x: Math.cos(i) * 40 * Math.sqrt(i + 1), y: Math.sin(i) * 40 * Math.sqrt(i + 1), vx: 0, vy: 0, deg: 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.map(([a, b]) => [byId.get(a), byId.get(b)]).filter(([a, b]) => a && b);
  for (const [a, b] of edges) { a.deg++; b.deg++; }
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  for (const [a, b] of edges) { adj.get(a).add(b); adj.get(b).add(a); }

  let W = 0, H = 0, scale = Math.max(0.35, Math.min(1.8, 7 / Math.sqrt(data.nodes.length + 4))), ox = 0, oy = 0, alpha = 1, hover = null, drag = null, pan = null, raf = 0;
  const resize = () => {
    const r = canvas.getBoundingClientRect(); W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    if (!ox && !oy) { ox = W / 2; oy = H / 2; }
    kick();
  };
  const ro = new ResizeObserver(resize); ro.observe(canvas);

  function tick() {
    const cell = 110, R = nodes.length > 1500 ? 1 : 2, grid = new Map();
    const key = (x, y) => (x + 30000) * 60000 + (y + 30000);
    for (const n of nodes) { const k = key(Math.floor(n.x / cell), Math.floor(n.y / cell)); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
    for (const n of nodes) {
      const gx = Math.floor(n.x / cell), gy = Math.floor(n.y / cell);
      for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
        const b = grid.get(key(gx + dx, gy + dy)); if (!b) continue;
        for (const m of b) {
          if (m === n) continue;
          let x = n.x - m.x, y = n.y - m.y, d2 = x * x + y * y;
          if (d2 < 0.01) { x = Math.random() - 0.5; y = Math.random() - 0.5; d2 = 0.5; }
          const f = 900 / d2 * alpha;
          n.vx += x * f / Math.sqrt(d2); n.vy += y * f / Math.sqrt(d2);
        }
      }
      n.vx -= n.x * 0.004 * alpha; n.vy -= n.y * 0.004 * alpha; // gravity
    }
    for (const [a, b] of edges) {
      const x = b.x - a.x, y = b.y - a.y, d = Math.sqrt(x * x + y * y) || 1, f = (d - 70) * 0.02 * alpha;
      a.vx += x / d * f; a.vy += y / d * f; b.vx -= x / d * f; b.vy -= y / d * f;
    }
    for (const n of nodes) {
      if (n === drag) continue;
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += Math.max(-30, Math.min(30, n.vx)); n.y += Math.max(-30, Math.min(30, n.vy));
    }
    alpha *= 0.985;
  }

  const css = getComputedStyle(document.documentElement);
  function draw() {
    const fg = css.getPropertyValue('--fg').trim() || '#ddd', mute = css.getPropertyValue('--line').trim() || '#444';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(ox, oy); ctx.scale(scale, scale);
    const hi = hover ? adj.get(hover) : null;
    ctx.lineWidth = 1 / scale;
    // Batched drawing: one path per edge style and one per node color.
    ctx.strokeStyle = mute; ctx.globalAlpha = hover ? 0.15 : 0.7; ctx.beginPath();
    for (const [a, b] of edges) if (!hover || (a !== hover && b !== hover)) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
    if (hover) { ctx.strokeStyle = '#8b5cf6'; ctx.globalAlpha = 1; ctx.beginPath(); for (const [a, b] of edges) if (a === hover || b === hover) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } ctx.stroke(); }
    const groups = new Map();
    for (const n of nodes) {
      const dim = hover && n !== hover && !hi.has(n);
      const k = (n.id === focusId ? '#f43f5e' : n.color || (n.color = colorFor(n))) + (dim ? '|d' : '');
      (groups.get(k) || groups.set(k, []).get(k)).push(n);
    }
    for (const [k, list] of groups) {
      const [color, dim] = k.split('|');
      ctx.fillStyle = color; ctx.globalAlpha = dim ? 0.2 : 1; ctx.beginPath();
      for (const n of list) { const r = 3 + Math.sqrt(n.deg) * 2.2; ctx.moveTo(n.x + r, n.y); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const n of nodes) {
      const r = 3 + Math.sqrt(n.deg) * 2.2;
      if (n === hover || (hi && hi.has(n)) || (nodes.length < 1500 ? scale > 0.9 || n.deg > 4 : scale > 1.4)) {
        ctx.fillStyle = fg; ctx.font = `${12 / Math.max(scale, 0.7)}px system-ui`; ctx.textAlign = 'center';
        ctx.fillText(n.title.length > 32 ? n.title.slice(0, 30) + '…' : n.title, n.x, n.y + r + 12 / Math.max(scale, 0.7));
      }
    }
    ctx.globalAlpha = 1;
  }
  function loop() {
    raf = 0;
    if (alpha > 0.02) tick();
    draw();
    if (alpha > 0.02 || drag) raf = requestAnimationFrame(loop);
  }
  function kick(a = 0.3) { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(loop); }

  const world = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left - ox) / scale, y: (e.clientY - r.top - oy) / scale }; };
  const pick = (p) => { let best = null, bd = 1e9; for (const n of nodes) { const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2, r = 6 + Math.sqrt(n.deg) * 2.2; if (d < r * r * 1.6 && d < bd) { bd = d; best = n; } } return best; };
  let moved = false;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId); moved = false;
    const n = pick(world(e));
    if (n) drag = n; else pan = { x: e.clientX - ox, y: e.clientY - oy };
  };
  canvas.onpointermove = (e) => {
    if (drag) { const p = world(e); drag.x = p.x; drag.y = p.y; moved = true; kick(0.1); return; }
    if (pan) { ox = e.clientX - pan.x; oy = e.clientY - pan.y; moved = true; draw(); return; }
    const n = pick(world(e));
    if (n !== hover) { hover = n; canvas.style.cursor = n ? 'pointer' : 'grab'; draw(); }
  };
  canvas.onpointerup = () => { if (drag && !moved) onOpen(drag); drag = null; pan = null; };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015), ns = Math.max(0.1, Math.min(5, scale * k));
    ox = mx - (mx - ox) * ns / scale; oy = my - (my - oy) * ns / scale; scale = ns; draw();
  };
  resize();
  return { destroy: () => { ro.disconnect(); cancelAnimationFrame(raf); } };
}
