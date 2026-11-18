// Unraid server status via the Unraid API (GraphQL at <webGUI>/graphql, header x-api-key; Unraid 7+, or 6.12 with the API plugin).
// Each piece is fetched with its own small query so one unknown field (schemas differ between versions) can't break the rest.
export const unraidConfigured = () => !!(process.env.UNRAID_URL && process.env.UNRAID_API_KEY);

async function gql(query) {
  const url = process.env.UNRAID_URL.replace(/\/$/, '') + '/graphql';
  const opts = { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.UNRAID_API_KEY }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) };
  const res = await fetch(url, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok && !j.data) throw new Error(`HTTP ${res.status}${j.errors ? ': ' + j.errors[0].message : ''}`);
  if (j.errors?.length && !j.data) throw new Error(j.errors[0].message);
  return j.data;
}
const attempt = async (queries) => {
  let last;
  for (const qy of queries) { try { const d = await gql(qy); if (d) return d; } catch (e) { last = e; } }
  throw last || new Error('no data');
};

export async function fetchStatus() {
  const s = { at: Date.now(), state: null, capacity: null, disks: [], containers: null, errors: [] };
  const piece = async (name, queries, use) => { try { use(await attempt(queries)); } catch (e) { s.errors.push(`${name}: ${e.message}`); } };
  const disk = (kind) => (d) => ({ kind, name: d.name, status: d.status ?? null, temp: typeof d.temp === 'number' ? d.temp : null, size: d.size ?? null });
  await Promise.all([
    piece('array', ['{ array { state } }'], (d) => { s.state = d.array?.state ?? null; }),
    piece('capacity', ['{ array { capacity { kilobytes { free used total } } } }'], (d) => {
      const k = d.array?.capacity?.kilobytes; if (k) s.capacity = { free: +k.free, used: +k.used, total: +k.total };
    }),
    piece('parity', ['{ array { parities { name status temp } } }'], (d) => s.disks.push(...(d.array?.parities || []).map(disk('parity')))),
    piece('disks', ['{ array { disks { name status temp size } } }', '{ array { disks { name status temp } } }'], (d) => s.disks.push(...(d.array?.disks || []).map(disk('data')))),
    piece('cache', ['{ array { caches { name status temp } } }'], (d) => s.disks.push(...(d.array?.caches || []).map(disk('cache')))),
    piece('docker', ['{ docker { containers { names state status } } }', '{ dockerContainers { names state status } }'], (d) => {
      const list = d.docker?.containers || d.dockerContainers || [];
      s.containers = list.map((c) => ({ name: (Array.isArray(c.names) ? c.names[0] : c.names || '').replace(/^\//, ''), state: String(c.state || '').toUpperCase(), status: c.status || '' }));
    }),
  ]);
  const order = { parity: 0, data: 1, cache: 2 };
  s.disks.sort((a, b) => order[a.kind] - order[b.kind] || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  return s;
}

// Problems worth telling someone about. Temperatures: warn at UNRAID_TEMP_WARN (°C, default 50 for drives).
export function problems(s) {
  const out = [];
  const warn = +(process.env.UNRAID_TEMP_WARN || 50);
  if (s.state && s.state !== 'STARTED') out.push({ key: 'array', text: `Array is ${s.state.toLowerCase()}` });
  for (const d of s.disks) {
    if (d.status && !/^DISK_OK$|^DISK_NP$/.test(d.status)) out.push({ key: `disk:${d.name}:${d.status}`, text: `${d.name}: ${d.status.replace(/^DISK_/, '').toLowerCase().replace(/_/g, ' ')}` });
    if (d.temp != null && d.temp >= warn) out.push({ key: `temp:${d.name}`, text: `${d.name} is hot: ${d.temp} °C` });
  }
  if (s.capacity?.total && s.capacity.used / s.capacity.total > 0.9) out.push({ key: 'capacity', text: `Array is ${Math.round((s.capacity.used / s.capacity.total) * 100)}% full` });
  return out;
}

export function summary(s) {
  if (!s) return 'Unraid status is not available.';
  const tb = (kb) => `${(kb / 1024 ** 3).toFixed(1)} TB`;
  const lines = [`Array: ${s.state || 'unknown'}${s.capacity ? ` · ${tb(s.capacity.used)} used of ${tb(s.capacity.total)} (${tb(s.capacity.free)} free)` : ''}`];
  if (s.disks.length) lines.push('Disks:\n' + s.disks.map((d) => `- ${d.name} (${d.kind}): ${d.status ? d.status.replace(/^DISK_/, '') : '?'}${d.temp != null ? `, ${d.temp} °C` : ', spun down'}`).join('\n'));
  if (s.containers) {
    const run = s.containers.filter((c) => c.state === 'RUNNING');
    lines.push(`Docker: ${run.length} of ${s.containers.length} containers running${s.containers.length > run.length ? `\nStopped: ${s.containers.filter((c) => c.state !== 'RUNNING').map((c) => c.name).join(', ')}` : ''}`);
  }
  const p = problems(s);
  lines.push(p.length ? `Problems: ${p.map((x) => x.text).join('; ')}` : 'No problems detected.');
  if (s.errors.length) lines.push(`(Couldn't read: ${s.errors.join('; ')})`);
  return lines.join('\n');
}
