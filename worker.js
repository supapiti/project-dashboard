/**
 * ESCMS shared data API  (Cloudflare Worker + Static Assets)
 * ---------------------------------------------------------------------------
 * Static files (index.html, logo) are served by Workers Static Assets.
 * This script only answers /api/* requests.
 *
 * Bindings (see wrangler.jsonc):
 *   ESCMS_KV  - KV namespace that stores the shared data   (required)
 *   ASSETS    - static assets                              (automatic)
 *   EDIT_KEY  - secret password for writes                 (optional, recommended)
 *               If set, every write must send header  X-Edit-Key: <EDIT_KEY>
 *
 * Routes
 *   GET    /api/data         -> { state, thresholds, records, updatedAt }
 *   PUT    /api/state        body: { state }
 *   PUT    /api/thresholds   body: { thresholds }
 *   POST   /api/records      body: { records: [...] }   (append, server prunes)
 *   DELETE /api/records
 *   GET    /api/auth         -> 200 if X-Edit-Key is valid (or no key configured)
 */

const KEYS = { state: 'state', thresholds: 'thresholds', records: 'records', meta: 'meta' };
const TANK_IDS = ['t1', 't2', 't3'];
const MAX_AGE = 35 * 864e5;      // keep 35 days, same as the page
const MAX_RECORDS = 20000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

async function readJSON(kv, key, def) {
  const v = await kv.get(key, 'json');
  return v === null ? def : v;
}

async function touch(kv) {
  const updatedAt = Date.now();
  await kv.put(KEYS.meta, JSON.stringify({ updatedAt }));
  return updatedAt;
}

function canWrite(request, env) {
  if (!env.EDIT_KEY) return true;
  return request.headers.get('X-Edit-Key') === env.EDIT_KEY;
}

function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const id of TANK_IDS) {
    const e = s[id];
    if (!e || (e.mode !== 'free' && e.mode !== 'avail') || !Number.isFinite(+e.value)) return null;
    out[id] = { mode: e.mode, value: +e.value };
  }
  return out;
}

function cleanThresholds(t) {
  if (!t) return null;
  const med = +t.med, warn = +t.warn, crit = +t.crit;
  if (!(med > 0 && med < warn && warn < crit && crit <= 100)) return null;
  return { med, warn, crit };
}

function cleanRecord(r) {
  if (!r || !TANK_IDS.includes(r.id) || !Number.isFinite(+r.t)) return null;
  const n = k => (Number.isFinite(+r[k]) ? +r[k] : 0);
  return { t: +r.t, id: r.id, tank: String(r.tank || '').slice(0, 60), level: n('level'), vol: n('vol'), avail: n('avail'), free: n('free') };
}

async function handleApi(request, env, route) {
  const kv = env.ESCMS_KV;
  if (!kv) return json({ error: 'KV namespace ESCMS_KV is not bound to this Worker.' }, 500);
  const method = request.method.toUpperCase();

  if (route === 'data' && method === 'GET') {
    const [state, thresholds, records, meta] = await Promise.all([
      readJSON(kv, KEYS.state, null),
      readJSON(kv, KEYS.thresholds, null),
      readJSON(kv, KEYS.records, []),
      readJSON(kv, KEYS.meta, { updatedAt: 0 })
    ]);
    return json({ state, thresholds, records, updatedAt: meta.updatedAt, editLocked: !!env.EDIT_KEY });
  }

  if (route === 'auth' && method === 'GET') {
    return canWrite(request, env) ? json({ ok: true }) : json({ error: 'Invalid edit key' }, 401);
  }

  // ---- everything below writes data ----
  if (!canWrite(request, env)) return json({ error: 'Invalid edit key' }, 401);

  if (route === 'state' && method === 'PUT') {
    const body = await request.json();
    const state = cleanState(body.state);
    if (!state) return json({ error: 'Invalid state' }, 400);
    await kv.put(KEYS.state, JSON.stringify(state));
    return json({ ok: true, updatedAt: await touch(kv) });
  }

  if (route === 'thresholds' && method === 'PUT') {
    const body = await request.json();
    const th = cleanThresholds(body.thresholds);
    if (!th) return json({ error: 'Invalid thresholds' }, 400);
    await kv.put(KEYS.thresholds, JSON.stringify(th));
    return json({ ok: true, updatedAt: await touch(kv) });
  }

  if (route === 'records' && method === 'POST') {
    const body = await request.json();
    const add = (Array.isArray(body.records) ? body.records : []).map(cleanRecord).filter(Boolean);
    if (!add.length) return json({ error: 'No valid records' }, 400);
    let records = await readJSON(kv, KEYS.records, []);
    if (!Array.isArray(records)) records = [];
    records = records.concat(add);
    const cutoff = Date.now() - MAX_AGE;
    records = records.filter(x => x.t >= cutoff).sort((a, b) => a.t - b.t);
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
    await kv.put(KEYS.records, JSON.stringify(records));
    return json({ ok: true, count: records.length, updatedAt: await touch(kv) });
  }

  if (route === 'records' && method === 'DELETE') {
    await kv.put(KEYS.records, '[]');
    return json({ ok: true, updatedAt: await touch(kv) });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url.pathname.slice(5).replace(/\/+$/, ''));
      } catch (e) {
        return json({ error: 'Server error: ' + (e && e.message ? e.message : e) }, 500);
      }
    }
    // Anything else: static files (index.html, logo, ...)
    return env.ASSETS.fetch(request);
  }
};
