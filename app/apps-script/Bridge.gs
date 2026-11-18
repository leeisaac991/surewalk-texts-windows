/**
 * The local bridge's endpoint (Deployment B: "Anyone", Execute as me). The bridge on the dispatch PC talks to the
 * UT iPhone through BlueFerry and POSTs here every few seconds and right after a text comes in:
 *   request  { key, op: 'sync', bridge: { connected, healthy, version, error }, inbound: [{ id, from, text, ts }],
 *              results: [{ outId, status: 'sent' | 'failed' | 'unknown', error }] }
 *   response { outbox: [{ outId, to, body }], dial: [{ callId, number }], pollMs }
 * Without the right key the answer is an empty object and nothing is read or logged.
 */
const FILE_VERSION_BRIDGE = '2026-11-04h';
const POLL_MS = 3000;

function doPost(e) {
  let body = null;
  try { body = JSON.parse(e && e.postData ? e.postData.contents : ''); } catch (x) { /* not JSON */ }
  if (!body || !keyOk_(body.key)) return json_({});
  try {
    const rd = ridesCached_((body.inbound || []).length > 0); // the sheet read: before taking the lock
    return json_(withLock_(() => bridgeSync_(body, rd)));
  }
  catch (err) { console.error('bridge sync', err); return json_({ outbox: [], dial: [], pollMs: POLL_MS, error: String(err.message || err) }); }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Constant-time comparison with the key in Script Properties.
function keyOk_(k) {
  const real = SP_().getProperty('TX_KEY') || '';
  if (!real || typeof k !== 'string' || k.length !== real.length) return false;
  let d = 0;
  for (let i = 0; i < real.length; i++) d |= real.charCodeAt(i) ^ k.charCodeAt(i);
  return d === 0;
}

function bridgeSync_(body, rd) {
  const b = body.bridge || {};
  SP_().setProperty('TX_BRIDGE', JSON.stringify({ at: Date.now(), connected: !!b.connected, healthy: !!b.healthy,
    version: String(b.version || '').slice(0, 40), error: String(b.error || '').slice(0, 200) }));
  const tx = loadTx_();
  applyResults_(tx, body.results, (body.results || []).length ? sheet_() : null);
  const seen = new Set(tx.seen);
  const inbound = (body.inbound || []).filter(m => m && m.id && !seen.has(String(m.id)));
  const { rides, wait } = rd || ridesCached_(inbound.length > 0);
  scanRides_(tx, rides, wait);
  if (inbound.length) {
    const sh = sheet_();
    inbound.sort((x, y) => (x.ts || 0) - (y.ts || 0)).forEach(m => {
      tx.seen.push(String(m.id));
      try { handleInbound_(tx, m, rides, wait, sh); }
      catch (err) { flag_(tx, 'Error', '', String(m.from || ''), String(m.text || ''), String(err.message || err)); }
    });
  }
  const outbox = takeOutbox_(tx);
  const dial = (tx.dial || []).splice(0);
  saveTx_(tx);
  flushLog_();
  return { outbox, dial, pollMs: POLL_MS };
}

// The master sheet is read at most every 8 s by the bridge's polling (always fresh when a text came in).
function ridesCached_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('rides');
    if (hit) return JSON.parse(hit);
  }
  const r = tonightRides_();
  try { cache.put('rides', JSON.stringify(r), 8); } catch (e) { /* too big to cache: read each time */ }
  return r;
}
