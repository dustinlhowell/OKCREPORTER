// Small dependency-free SVG charts with hover tooltips. Colors come from CSS custom properties (light + dark).
import { esc } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
const kfmt = (c) => { const d = Math.abs(c) / 100, s = d >= 1e6 ? `${+(d / 1e6).toFixed(1)}M` : d >= 1e3 ? `${+(d / 1e3).toFixed(1)}k` : `${Math.round(d)}`; return `${c < 0 ? '−' : ''}$${s}`; };

function tip(host) {
  let t = host.querySelector('.ctip');
  if (!t) { t = document.createElement('div'); t.className = 'ctip'; t.hidden = true; host.appendChild(t); }
  return {
    show(html, x, y) { t.innerHTML = html; t.hidden = false; const w = t.offsetWidth, hw = host.clientWidth; t.style.left = `${Math.max(0, Math.min(hw - w, x - w / 2))}px`; t.style.top = `${Math.max(0, y - t.offsetHeight - 10)}px`; },
    hide() { t.hidden = true; },
  };
}

// Line (optionally area) chart. points: [{ label, value, note? , dashed? }]. A zero line is drawn when values cross zero.
export function lineChart(host, points, { height = 200, fmt = kfmt, full = (v) => v, splitAt = -1, color = 'var(--series-1)' } = {}) {
  if (!host) return;
  host.classList.add('chart'); host.innerHTML = '';
  if (!points.length) return;
  const W = Math.max(280, host.clientWidth || 600), H = height, P = { l: 52, r: 12, t: 12, b: 26 };
  const vals = points.map((p) => p.value);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  hi = niceMax(hi || 1); if (lo < 0) lo = -niceMax(-lo);
  const x = (i) => P.l + (points.length === 1 ? 0 : i / (points.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (hi - v) / (hi - lo || 1) * (H - P.t - P.b);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('role', 'img');
  const ticks = [lo, lo + (hi - lo) / 2, hi].filter((v, i, a) => a.indexOf(v) === i);
  let s = ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${esc(fmt(v))}</text>`).join('');
  if (lo < 0) s += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(0)}" y2="${y(0)}" class="zero"/>`;
  const step = Math.max(1, Math.ceil(points.length / Math.floor((W - P.l) / 70)));
  points.forEach((p, i) => { if (i % step === 0) s += `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${esc(p.label)}</text>`; });
  const path = (from, to) => points.slice(from, to + 1).map((p, k) => `${k ? 'L' : 'M'}${x(from + k).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const base = y(Math.max(lo, Math.min(0, hi)));
  const solidEnd = splitAt >= 0 ? splitAt : points.length - 1;
  s += `<path d="${path(0, points.length - 1)}L${x(points.length - 1)},${base}L${x(0)},${base}Z" class="area" style="fill:${color}"/>`;
  s += `<path d="${path(0, solidEnd)}" class="line" style="stroke:${color}"/>`;
  if (splitAt >= 0 && splitAt < points.length - 1) s += `<path d="${path(splitAt, points.length - 1)}" class="line dashed" style="stroke:${color}"/>`;
  points.forEach((p, i) => { if (p.value < 0) s += `<circle cx="${x(i)}" cy="${y(p.value)}" r="2.5" class="negdot"/>`; });
  s += `<line class="cross" y1="${P.t}" y2="${H - P.b}" x1="-10" x2="-10"/><circle class="hov" r="5" cx="-10" cy="-10" style="fill:${color}"/>`;
  svg.innerHTML = s;
  host.appendChild(svg);
  const t = tip(host), cross = svg.querySelector('.cross'), dot = svg.querySelector('.hov');
  const move = (e) => {
    const r = svg.getBoundingClientRect(), px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const i = Math.max(0, Math.min(points.length - 1, Math.round((px - P.l) / ((W - P.l - P.r) / Math.max(1, points.length - 1)))));
    const p = points[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.value));
    t.show(`<b>${esc(p.title || p.label)}</b><br>${esc(full(p.value))}${p.note ? `<br><span class="muted">${esc(p.note)}</span>` : ''}`, x(i), y(p.value));
  };
  svg.addEventListener('pointermove', move); svg.addEventListener('touchmove', move, { passive: true });
  svg.addEventListener('pointerleave', () => { t.hide(); cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); dot.setAttribute('cx', -10); });
}

// Grouped vertical bars. series: [{ name, cls, values[] }]; labels: [] for the x axis.
export function barChart(host, labels, series, { height = 220, fmt = kfmt, full = (v) => v, titles = labels } = {}) {
  if (!host) return;
  host.classList.add('chart'); host.innerHTML = '';
  const W = Math.max(280, host.clientWidth || 600), H = height, P = { l: 52, r: 8, t: 10, b: 26 };
  const hi = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const bw = (W - P.l - P.r) / labels.length, inner = Math.min(28, (bw - 8) / series.length);
  const y = (v) => P.t + (1 - v / hi) * (H - P.t - P.b);
  let s = [0, hi / 2, hi].map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${esc(fmt(v))}</text>`).join('');
  const step = Math.max(1, Math.ceil(labels.length / Math.floor((W - P.l) / 46)));
  labels.forEach((l, i) => {
    const cx = P.l + bw * i + bw / 2, x0 = cx - (inner * series.length + 2 * (series.length - 1)) / 2;
    series.forEach((se, k) => {
      const v = se.values[i] || 0, top = y(Math.max(0, v)), h = Math.max(0, y(0) - top);
      if (h > 0) s += `<path class="bar ${se.cls}" d="M${x0 + k * (inner + 2)},${y(0)}V${top + Math.min(4, h)}q0,-4 4,-4h${inner - 8}q4,0 4,4V${y(0)}Z"/>`;
    });
    s += `<rect class="hit" x="${P.l + bw * i}" y="${P.t}" width="${bw}" height="${H - P.t - P.b}" data-i="${i}"/>`;
    if (i % step === 0) s += `<text x="${cx}" y="${H - 6}" class="axis" text-anchor="middle">${esc(l)}</text>`;
  });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('role', 'img');
  svg.innerHTML = s;
  const legend = document.createElement('div'); legend.className = 'legend';
  legend.innerHTML = series.map((se) => `<span><i class="sw ${se.cls}"></i>${esc(se.name)}</span>`).join('');
  host.append(legend, svg);
  const t = tip(host);
  svg.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('pointerenter', () => { const i = +r.dataset.i; r.classList.add('on'); t.show(`<b>${esc(titles[i])}</b>${series.map((se) => `<br><i class="sw ${se.cls}"></i>${esc(se.name)}: ${esc(full(se.values[i] || 0))}`).join('')}`, P.l + bw * i + bw / 2 + legend.offsetHeight * 0, y(Math.max(...series.map((se) => se.values[i] || 0))) + legend.offsetHeight); });
    r.addEventListener('pointerleave', () => { r.classList.remove('on'); t.hide(); });
  });
}

// Horizontal bars as HTML (category breakdowns). rows: [{ label, value, color, sub? , href? }]
export function hbars(rows, { fmt = (v) => v, max } = {}) {
  const m = max || Math.max(1, ...rows.map((r) => r.value));
  return `<ul class="hbars">${rows.map((r) => `<li${r.title ? ` title="${esc(r.title)}"` : ''}><span class="hl">${r.label}</span><span class="ht"><i style="width:${Math.max(0.5, r.value / m * 100)}%;background:${r.color || 'var(--series-1)'}"></i></span><b>${esc(fmt(r.value))}</b>${r.sub ? `<small class="muted">${r.sub}</small>` : ''}</li>`).join('')}</ul>`;
}

// Sequential (one-hue) ramp for heatmaps; level 0 = no spending.
export const heatLevel = (v, max) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((v / Math.max(1, max)) * 4.999)));
