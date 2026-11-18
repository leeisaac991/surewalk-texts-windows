/**
 * SURE Walk Texts — texting riders from the UT iPhone. A separate Apps Script project from the dispatch panel.
 *   Deployment A "Dashboard": Execute as me, Only myself  → this page (doGet) and the functions below.
 *   Deployment B "Bridge API": Execute as me, Anyone      → doPost (Bridge.gs), protected by the secret key.
 * Every dashboard function checks the viewer is the owner, so the "Anyone" deployment can't open the dashboard.
 */
const FILE_VERSION_CODE = '2026-11-04h';

function doGet() {
  if (!isOwner_()) return HtmlService.createHtmlOutput('Not available.');
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('SURE Walk Texts')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function isOwner_() {
  const a = Session.getActiveUser().getEmail(), me = Session.getEffectiveUser().getEmail();
  return !!a && a === me;
}
function guard_() { if (!isOwner_()) throw new Error('Not available.'); }

// Script properties with one bulk read per server call (same as the dispatch app).
let SP_CACHE_ = null;
function SP_() {
  const real = PropertiesService.getScriptProperties();
  const cache = () => SP_CACHE_ || (SP_CACHE_ = real.getProperties());
  return {
    getProperty: k => { const m = cache(); return k in m ? m[k] : null; },
    setProperty: (k, v) => { cache()[k] = String(v); real.setProperty(k, String(v)); },
    setProperties: obj => { Object.assign(cache(), obj); real.setProperties(obj, false); },
    deleteProperty: k => { delete cache()[k]; real.deleteProperty(k); },
  };
}
const BIG_CHUNK = 2000;
function bigGet_(key) {
  const p = SP_(), n = Number(p.getProperty(key + '#n') || 0);
  let s = '';
  for (let i = 0; i < n; i++) s += p.getProperty(key + '#' + i) || '';
  try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function bigSet_(key, obj) {
  const p = SP_(), s = JSON.stringify(obj), oldN = Number(p.getProperty(key + '#n') || 0), out = {};
  const n = Math.ceil(s.length / BIG_CHUNK);
  for (let i = 0; i < n; i++) out[key + '#' + i] = s.slice(i * BIG_CHUNK, (i + 1) * BIG_CHUNK);
  out[key + '#n'] = String(n);
  p.setProperties(out);
  for (let i = n; i < oldN; i++) p.deleteProperty(key + '#' + i);
}
// The lock only guards the quick bookkeeping (texting state in Script Properties). Slow sheet reads happen before
// taking it (ridesCached_), so the dashboard, the bridge and your actions don't queue up behind each other.
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  SP_CACHE_ = null; LAST_RIDE_CACHE_ = null;
  try { return fn(); } finally { lock.releaseLock(); }
}

function fileVersions_() {
  return { 'Code.gs': FILE_VERSION_CODE, 'Rides.gs': typeof FILE_VERSION_RIDES !== 'undefined' ? FILE_VERSION_RIDES : 'missing',
    'Texts.gs': typeof FILE_VERSION_TEXTS !== 'undefined' ? FILE_VERSION_TEXTS : 'missing',
    'Bridge.gs': typeof FILE_VERSION_BRIDGE !== 'undefined' ? FILE_VERSION_BRIDGE : 'missing',
    'Places.gs': typeof FILE_VERSION_PLACES !== 'undefined' ? FILE_VERSION_PLACES : 'missing' };
}

/** Everything the dashboard shows. Also picks up new rides (so they show even if the bridge is off). */
/** Every panel refresh: the state, plus which deploy is running (BUILD_ID, written by deploy.sh) so an open panel
 *  can say "New version available — reload" after a deploy. */
function getState() {
  return Object.assign(getStateCore_(), { build: typeof BUILD_ID !== 'undefined' ? BUILD_ID : '' });
}
function getStateCore_() {
  guard_();
  const { rides, wait } = ridesCached_(false); // the sheet read: outside the lock
  // A refresh never waits long: if the bridge or an action holds the lock right now, show the last state instead.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) {
    const hit = CacheService.getScriptCache().get('state_view');
    if (hit) return Object.assign(JSON.parse(hit), { stale: true });
    lock.waitLock(30000);
  }
  try {
    SP_CACHE_ = null; LAST_RIDE_CACHE_ = null;
    const view = stateView_(rides, wait);
    try { CacheService.getScriptCache().put('state_view', JSON.stringify(view), 60); } catch (e) { /* too big to cache */ }
    return view;
  } finally { lock.releaseLock(); }
}
function stateView_(rides, wait) {
  {
    const tx = loadTx_(), now = Date.now();
    scanRides_(tx, rides, wait);
    saveTx_(tx);
    flushLog_();
    const noReplyMin = Number(SP_().getProperty('TX_NOREPLY_MIN') || NOREPLY_MIN_DEFAULT);
    // Latest message (text or reaction) from each number — "No reply" checks the conversation itself too.
    const lastIn = {};
    tx.msgs.forEach(m => { if (m.dir === 'in' && m.phone && (lastIn[m.phone] || 0) < m.ts) lastIn[m.phone] = m.ts; });
    const view = rides.slice().reverse().map(r => {
      const rec = tx.rides[r.id] || {};
      return { id: r.id, row: r.row, time: r.time, tsMs: r.tsMs, first: r.first, last: r.last, phone10: r.phone10,
        pickup: r.pickup, dropoff: r.dropoff, pickupName: r.pickupName, dropoffName: r.dropoffName, ada: r.ada,
        eta: r.state === 'open' && !r.arrived ? etaText_(wait, r) : '', // this rider's wait (riders ahead of them in line)
        driver: r.driver, nav: r.nav, call: r.call, arrived: r.arrived, dispatcher: r.dispatcher, sheetState: r.state, dupOf: r.dupOf, offPickup: r.offPickup, dropoffOnly: r.dropoffOnly,
        state: rec.state || 'ready', note: rec.note || '', invalid: rec.state === 'flagged' && r.state === 'open' ? rec.invalid || (r.offPickup ? (dropoffOnly_(r.pickup) ? 'cx_dropoffonly' : 'cx_offcampus') : '') : '', textedAt: rec.textedAt || 0, confirmedAt: rec.confirmedAt || 0, lastInAt: rec.lastInAt || 0,
        // "No reply" only while they really haven't texted back since we texted them.
        noReply: rec.state === 'texted' && rec.textedAt && !(rec.lastInAt >= rec.textedAt - 60e3) && !((lastIn[r.phone10] || 0) >= rec.textedAt - 60e3) && now - rec.textedAt > noReplyMin * 60e3
          ? Math.round((now - rec.textedAt) / 60e3) : 0 };
    });
    const bridge = JSON.parse(SP_().getProperty('TX_BRIDGE') || 'null');
    return {
      versions: fileVersions_(), now, night: tx.night,
      texting: toggle_('TX_TEXTING'), autoText: toggle_('TX_AUTOTEXT'), lateNotice: SP_().getProperty('TX_LATE_NOTICE') !== 'false', riderPoll: SP_().getProperty('TX_POLL') === 'true', setUp: !!SP_().getProperty('TX_KEY'),
      bridge, rides: view, msgs: tx.msgs, flags: tx.flags.filter(f => !f.done),
      failedCount: (() => { const oo = new Set(optOuts_()), since = now - 2 * 3600e3; // for "Resend all failed"
        return tx.out.filter(o => o.st === 'failed' && !o.resent && (o.at || 0) >= since && o.err !== 'Cancelled before sending' && !oo.has(phone10_(o.to))).length; })(),
      sendPaused: (tx.sendPauseUntil || 0) > now, // the phone's send limit: texts wait a minute, then go out by themselves
      outbox: tx.out.filter(o => ['queued', 'sending'].includes(o.st)).length,
      templates: templates_(), templateLabels: TEMPLATE_LABELS, eta: etaText_(wait), wait: wait.avg, cancelReasons: CANCEL_REASONS, cancelNotices: CANCEL_NOTICES.map(c => ({ key: c.key, label: c.label, reason: c.reason })),
      noReplyMin, sheetUrl: SP_().getProperty('TEXTS_SHEET_ID') ? 'https://docs.google.com/spreadsheets/d/' + SP_().getProperty('TEXTS_SHEET_ID') : '',
      etaUrl: SP_().getProperty('ETA_SHEET_ID') ? (SP_().getProperty('ETA_SHEET_ID') === 'local-eta' ? '/eta.csv' : 'https://docs.google.com/spreadsheets/d/' + SP_().getProperty('ETA_SHEET_ID')) : '',
      pollUrl: SP_().getProperty('POLL_SHEET_ID') ? (SP_().getProperty('POLL_SHEET_ID') === 'local-poll' ? '/poll.csv' : 'https://docs.google.com/spreadsheets/d/' + SP_().getProperty('POLL_SHEET_ID')) : '',
      prefs: JSON.parse(PropertiesService.getUserProperties().getProperty('txPrefs') || 'null'),
    };
  }
}

// ---------- dashboard actions (each returns the fresh state) ----------
function act_(fn) {
  guard_();
  withLock_(() => {
    const tx = loadTx_();
    fn(tx);
    saveTx_(tx);
    flushLog_();
  });
  CacheService.getScriptCache().remove('rides');
  return getState();
}
function rideFor_(rideId) {
  const r = tonightRides_().rides.find(x => x.id === rideId);
  if (!r) throw new Error("That ride isn't in tonight's sheet anymore.");
  if (!r.phone10) throw new Error(`${r.first} has no valid phone number.`);
  return r;
}
/** Send (or resend) the confirmation text to one rider. */
function textRide(rideId) {
  return act_(tx => {
    const r = rideFor_(rideId);
    if (optOuts_().includes(r.phone10)) throw new Error(`${r.first} replied STOP — not texting them.`);
    const rec = tx.rides[r.id] || (tx.rides[r.id] = { row: r.row, first: r.first, phone10: r.phone10 });
    firstText_(tx, r, rec, tonightRides_().wait); // just "Moody"? asks which one first
  });
}
/** A text you typed (or a quick reply) to a rider. */
function sendText(rideId, body) {
  body = String(body || '').trim();
  if (!body) throw new Error('Type a message first.');
  if (body.length > 1000) throw new Error('Keep texts under 1,000 characters.');
  return act_(tx => {
    const r = rideFor_(rideId);
    queue_(tx, r, body, 'manual');
    // Sending the "you're confirmed" text yourself (the Confirmed ✓ quick reply) confirms the ride too.
    const t = templates_(), norm = x => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if ([t.confirmed, t.confirmedAda, t.adaNo].some(tpl => tpl && [etaText_(tonightRides_().wait, r), etaText_(tonightRides_().wait)].some(e => norm(fill_(tpl, r, e)) === norm(body)))) {
      const rec = tx.rides[r.id] || (tx.rides[r.id] = { row: r.row, first: r.first, phone10: r.phone10 });
      if (!['cancelled', 'duplicate'].includes(rec.state)) Object.assign(rec, { state: 'confirmed', confirmedAt: rec.confirmedAt || Date.now(), note: 'Confirmed by you' });
    }
  });
}
/** A text to any number (Settings → Test send, or replying to an unknown number). */
function sendToNumber(number, body) {
  const p = phone10_(number);
  if (!p) throw new Error("That doesn't look like a phone number.");
  body = String(body || '').trim();
  if (!body) throw new Error('Type a message first.');
  return act_(tx => queue_(tx, { phone10: p, id: '' }, body, 'manual'));
}
/** Starts a test poll (3 questions) to any phone number so someone can test the survey flow on their own phone. */
function sendTestPoll(number) {
  const p = phone10_(number);
  if (!p) throw new Error("That doesn't look like a 10-digit phone number.");
  return act_(tx => {
    const testId = 'test_' + p;
    const night = nightKey_(new Date());
    // allow repeated testing: clear polled lock for this phone
    if (tx.polled && Array.isArray(tx.polled.phones)) {
      tx.polled.phones = tx.polled.phones.filter(x => x !== p);
    }
    if (typeof clearPolled_ === 'function') clearPolled_(p);
    tx.rides[testId] = Object.assign(tx.rides[testId] || {}, {
      phone10: p, state: 'confirmed', first: 'Tester', last: '', row: 0, pickupName: 'Test', dropoffName: 'Test'
    });
    tx.rides[testId].poll = { step: 1, at: Date.now(), night, row: 0, miss: 0, a: {}, test: true };
    queue_(tx, { phone10: p, id: testId }, templates_().poll_q1, 'poll');
  });
}
/*
 * Cancel or mark a ride duplicate from the dashboard — the sheet changes exactly like the dispatch app's buttons, and NO
 * text goes to the rider. A confirmation still waiting to go out for that ride is dropped.
 */
function cancelRideQuiet(rideId, reason) {
  if (!CANCEL_REASONS.includes(reason)) throw new Error('Pick a cancel reason.');
  return act_(tx => {
    const r = openRide_(rideId), sh = sheet_();
    cancelRow_(sh, rowOf_(sh, r), reason);
    Object.assign(rideRec_(tx, r), { state: 'cancelled', note: 'Cancelled from the dashboard: ' + reason });
    dropQueued_(tx, r.id, 'Not sent — ride cancelled');
    logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'Cancelled from the dashboard (no text): ' + reason });
  });
}
/** Cancel + text: cancels the ride (reason in V, black row — like the dispatch app) and sends the rider `body`. */
function cancelRideAndText(rideId, key, body) {
  const notice = CANCEL_NOTICES.find(c => c.key === key);
  if (!notice) throw new Error('Pick a reason.');
  body = String(body || '').trim();
  if (!body) throw new Error('Write the text to send first.');
  if (body.length > 1000) throw new Error('Keep texts under 1,000 characters.');
  return act_(tx => {
    const r = openRide_(rideId);
    if (!r.phone10) throw new Error(`${r.first} has no valid phone number — use Cancel ride instead.`);
    if (optOuts_().includes(r.phone10)) throw new Error(`${r.first} replied STOP — use Cancel ride (no text) instead.`);
    const sh = sheet_();
    cancelRow_(sh, rowOf_(sh, r), notice.reason);
    Object.assign(rideRec_(tx, r), { state: 'cancelled', note: `Cancelled + texted: ${notice.label} (${notice.reason})` });
    dropQueued_(tx, r.id, 'Not sent — ride cancelled');
    queue_(tx, r, body, 'cancelNotice');
  });
}
/*
 * Not an ADA ride after all (we found out by text or a call): ADA (L) → No, so dispatch treats it as a normal ride.
 * No text goes out. We stop waiting for their ADA YES/NO; a confirmation that hadn't gone out yet becomes the plain one.
 */
function markNotAda(rideId) {
  return act_(tx => {
    const r = openRide_(rideId), sh = sheet_(), row = rowOf_(sh, r);
    if (!r.ada) throw new Error(`${r.first}'s ride isn't marked ADA.`);
    assertEditable_(sh, row);
    sh.getRange(row, COL.ADA).setValue('No');
    try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
    const rec = tx.rides[r.id];
    if (rec) { delete rec.adaAsk; rec.note = 'Not ADA (marked by you)'; }
    const plain = Object.assign({}, r, { ada: false });
    tx.out.filter(o => o.rideId === r.id && o.st === 'queued' && o.kind === 'confirm').forEach(o => {
      o.body = fill_(templates_().confirm, plain, etaText_(tonightRides_().wait, plain));
      const m = tx.msgs.find(x => x.outId === o.outId); if (m) m.body = o.body;
    });
    logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'ADA → No (marked not ADA from the dashboard, no text)' });
  });
}
/*
 * Edit a ride's details from the dashboard: the rider's first / last name, pickup, drop-off. Only changed cells are
 * written. A pickup fixed to a real campus place clears the ride's "Off-campus pickup" / "drop-off only" flag and puts
 * it back to "not texted" (use Send confirmation); nothing is texted by itself.
 */
const EDIT_FIELDS_ = { first: COL.FIRST, last: COL.LAST, pickup: COL.PICKUP, dropoff: COL.DROPOFF };
function editRide(rideId, fields) {
  return act_(tx => {
    const r = openRide_(rideId), sh = sheet_(), row = rowOf_(sh, r), f = fields || {}, changed = [];
    assertEditable_(sh, row);
    Object.keys(EDIT_FIELDS_).forEach(k => {
      if (!(k in f)) return;
      const v = String(f[k] == null ? '' : f[k]).replace(/^[=+@]+/, '').trim().slice(0, 200); // never a formula
      if (!v && k !== 'last') throw new Error(`The ${k === 'first' ? 'first name' : k} can't be empty.`);
      const cell = sh.getRange(row, EDIT_FIELDS_[k]), old = String(cell.getDisplayValue()).trim();
      if (old === v) return;
      cell.setValue(v);
      changed.push(`${k} "${old}" → "${v}"`);
    });
    if (!changed.length) return;
    try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
    const rec = tx.rides[r.id], pickup = 'pickup' in f ? String(f.pickup).trim() : r.pickup;
    if (rec && rec.state === 'flagged' && ['cx_offcampus', 'cx_dropoffonly'].includes(rec.invalid) && !offCampusPickup_(pickup)) {
      delete rec.invalid;
      Object.assign(rec, { state: 'ready', note: 'Pickup fixed — not texted yet' });
      tx.flags.filter(x => x.rideId === r.id).forEach(x => { x.done = true; });
    }
    logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'Edited from the dashboard: ' + changed.join('; ') });
  });
}

const DUPLICATE_COLOR = '#ff0000'; // the sheet's mark for a duplicate (same as the dispatch app)
function markDuplicateRide(rideId) {
  return act_(tx => {
    const r = openRide_(rideId), sh = sheet_(), row = rowOf_(sh, r);
    assertEditable_(sh, row);
    sh.getRange(row, 1, 1, sh.getMaxColumns()).setBackground(DUPLICATE_COLOR);
    Object.assign(rideRec_(tx, r), { state: 'duplicate', note: 'Marked duplicate from the dashboard' });
    dropQueued_(tx, r.id, 'Not sent — marked duplicate');
    logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'Marked duplicate from the dashboard (no text)' });
  });
}
function openRide_(rideId) {
  const r = tonightRides_().rides.find(x => x.id === rideId);
  if (!r) throw new Error("That ride isn't in tonight's sheet anymore.");
  if (r.state !== 'open') throw new Error(`${r.first}'s ride is already ${r.state === 'dup' ? 'marked duplicate' : r.state}.`);
  return r;
}
const rideRec_ = (tx, r) => tx.rides[r.id] || (tx.rides[r.id] = { row: r.row, first: r.first, phone10: r.phone10 });
// The ride is dealt with: its "needs a look" flags go away, and any confirmation that hadn't gone out is dropped.
function dropQueued_(tx, rideId, why) {
  tx.flags.filter(f => f.rideId === rideId).forEach(f => { f.done = true; });
  tx.out.filter(o => o.rideId === rideId && o.st === 'queued').forEach(o => {
    o.st = 'failed'; o.err = why;
    const m = tx.msgs.find(x => x.outId === o.outId); if (m) m.st = 'failed';
  });
}

function markHandled(flagId) { return act_(tx => { tx.flags.filter(f => f.id === flagId).forEach(f => { f.done = true; }); }); }
function markAllHandled() { return act_(tx => { tx.flags.forEach(f => { f.done = true; }); }); }
/** Resend a text that failed (or whose outcome was unknown — the dashboard asks you to check the phone first). */
function retryOut(outId) {
  return act_(tx => {
    const o = tx.out.find(x => x.outId === outId);
    if (!o || !['failed', 'unknown'].includes(o.st)) throw new Error('Only a failed text can be resent.');
    if (o.resent) throw new Error('That text was already resent.');
    resend_(tx, o);
  });
}
function resend_(tx, o) {
  queue_(tx, { phone10: phone10_(o.to), id: o.rideId }, o.body, o.kind);
  o.resent = true;
  tx.flags.filter(f => !f.done && /^Text (failed|may not have sent)$/.test(f.kind) && f.text === o.body && phone10_(f.phone) === phone10_(o.to)).forEach(f => { f.done = true; });
}
/** "Resend all failed": every text that failed in the last 2 hours and wasn't resent (not opted-out numbers, not ones you cancelled). */
function resendFailed() {
  return act_(tx => {
    const optOut = new Set(optOuts_()), since = Date.now() - 2 * 3600e3;
    const list = tx.out.filter(o => o.st === 'failed' && !o.resent && (o.at || 0) >= since && o.err !== 'Cancelled before sending' && !optOut.has(phone10_(o.to)));
    if (!list.length) throw new Error('No failed texts to resend.');
    list.forEach(o => resend_(tx, o));
  });
}
function cancelQueued(outId) {
  return act_(tx => {
    const o = tx.out.find(x => x.outId === outId && x.st === 'queued');
    if (!o) throw new Error('That text is already on its way.');
    o.st = 'failed'; o.err = 'Cancelled before sending';
    const m = tx.msgs.find(x => x.outId === outId); if (m) m.st = 'failed';
    const rec = tx.rides[o.rideId]; if (rec && rec.state === 'queued') rec.state = 'ready';
  });
}
/** Ring the rider from the iPhone (BlueFerry calls; experimental). */
/*
 * Metrics (📊 in the dashboard), from the Messages log. Per operating night (7 PM – 2 AM, see opNightKey_): the rides we texted (a confirmation or "which Moody?"
 * that reached the phone) and what each one led to — cancelled by text > confirmed (YES) > another reply > no reply —
 * plus reply times, opt-outs and the other texts. nights: how many of the most recent nights (1–60).
 */
function getMetrics(nights) {
  guard_();
  const id = SP_().getProperty('TEXTS_SHEET_ID');
  if (!id) return { nights: [] };
  const sh = SpreadsheetApp.openById(id).getSheetByName('Messages');
  const last = sh ? sh.getLastRow() : 0;
  if (last < 2) return { nights: [] };
  // tonight's rides cancelled in the sheet before this was logged (texting server's own record)
  const cancelled = new Set();
  try { const tx = loadTx_(); Object.keys(tx.rides || {}).forEach(id => { if (tx.rides[id].state === 'cancelled') cancelled.add(id); }); } catch (e) { /* log only */ }
  return metricsFrom_(sh.getRange(2, 1, last - 1, 11).getValues(), Math.max(1, Math.min(60, Number(nights) || 14)), cancelled);
}
// Texts that ask the rider to clarify something before we confirm ("which Moody?"). Add new kinds here.
const CLARIFY_KINDS = ['whichMoody'];
// Metrics count by OPERATING night (7:00 PM – 2:00 AM), not the calendar day: a message belongs to the night that
// started on the date of (its time − 12 h) in CFG.TZ. So 1:30 AM Tuesday counts toward Monday night, and the noon cut
// matches afterDeadline_ (2 AM–noon = the night that just ended) / beforeStart_ (noon–7 PM = the night ahead).
const OP_NIGHT_CUT_MS = 12 * 3600e3;
const opNightKey_ = ms => Utilities.formatDate(new Date(ms - OP_NIGHT_CUT_MS), CFG.TZ, 'yyyy-MM-dd');
// A texted ride that was cancelled (in the sheet, from the dashboard, automatically, or with a cancel text) and never got
// a reply isn't a "no reply": it's left out of the texted rides and counted as cancelledNoReply instead.
const CANCEL_NOTE_RE_ = /^Cancel(l)?ed\b/i, CANCEL_TEXT_KINDS_ = /^(cancelNotice|cx_)/;
function metricsFrom_(rows, keep, cancelledIds) {
  const by = {}, cancelled = new Set(cancelledIds || []);
  rows.forEach(([, , dir, , rideId, , , , status, intent, note]) => {
    if (!rideId) return;
    if ((dir === 'note' && CANCEL_NOTE_RE_.test(String(note || ''))) || (dir === 'out' && status === 'sent' && CANCEL_TEXT_KINDS_.test(String(intent || '')))) cancelled.add(String(rideId));
  });
  const key = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || '').trim());
  rows.forEach(([ts, night, dir, , rideId, , , , status, intent]) => {
    const ms = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
    const k = isNaN(ms) ? key(night) : opNightKey_(ms); // the logged 'night' column only if the timestamp is unreadable
    if (!k || (dir !== 'in' && dir !== 'out')) return;
    const N = by[k] = by[k] || { night: k, rides: {}, sent: 0, failed: 0, inbound: 0, kinds: {}, optOuts: 0 };
    const ride = () => (N.rides[rideId] = N.rides[rideId] || { ins: [] });
    if (dir === 'out') {
      if (status === 'sent') { N.sent++; N.kinds[intent] = (N.kinds[intent] || 0) + 1; } else if (status) N.failed++;
      if (rideId && status === 'sent' && (intent === 'confirm' || CLARIFY_KINDS.includes(intent))) { const R = ride(); if (!R.textedAt || ms < R.textedAt) R.textedAt = ms; }
    } else {
      N.inbound++;
      if (intent === 'stop') N.optOuts++;
      if (rideId) ride().ins.push({ ms, intent: String(intent || '') });
    }
  });
  const out = Object.values(by).sort((a, b) => (a.night < b.night ? 1 : -1)).slice(0, keep).map(N => {
    const m = { night: N.night, texted: 0, confirmed: 0, cancelled: 0, other: 0, noReply: 0, cancelledNoReply: 0, replySecs: [], optOuts: N.optOuts,
      sent: N.sent, failed: N.failed, inbound: N.inbound, cancelNotices: N.kinds.cancelNotice || 0, clarifyAsks: CLARIFY_KINDS.reduce((a, k) => a + (N.kinds[k] || 0), 0),
      hoursTips: N.kinds.hoursTip || 0, etaAnswers: N.kinds.eta || 0 };
    Object.keys(N.rides).forEach(id => {
      const R = N.rides[id];
      if (!R.textedAt) return;
      const ins = R.ins.filter(x => x.ms >= R.textedAt - 60e3).sort((a, b) => a.ms - b.ms);
      if (!ins.length && cancelled.has(id)) { m.cancelledNoReply++; return; } // cancelled before they answered
      m.texted++;
      if (ins.length) m.replySecs.push(Math.max(0, Math.round((ins[0].ms - R.textedAt) / 1000))); // whole seconds
      if (ins.some(x => x.intent === 'cancel')) m.cancelled++;
      else if (ins.some(x => x.intent === 'yes')) m.confirmed++;
      else if (ins.length) m.other++;
      else m.noReply++;
    });
    return m;
  });
  return { nights: out };
}

function dialRide(rideId) {
  return act_(tx => { const r = rideFor_(rideId); (tx.dial = tx.dial || []).push({ callId: newId_(tx, 'c'), number: '+1' + r.phone10 }); });
}
function setToggle(name, on) {
  if (!['TX_TEXTING', 'TX_AUTOTEXT', 'TX_LATE_NOTICE', 'TX_POLL'].includes(name)) throw new Error('Unknown setting.');
  guard_();
  SP_().setProperty(name, on ? 'true' : 'false');
  return getState();
}
function saveTemplates(obj) {
  guard_();
  const clean = {};
  Object.keys(TEMPLATE_DEFAULTS).forEach(k => { if (obj && typeof obj[k] === 'string' && obj[k].trim()) clean[k] = obj[k].trim().slice(0, 600); });
  SP_().setProperty('TX_TEMPLATES', JSON.stringify(clean));
  return getState();
}
function setNoReplyMin(min) { guard_(); SP_().setProperty('TX_NOREPLY_MIN', String(Math.max(2, Math.min(60, Number(min) || NOREPLY_MIN_DEFAULT)))); return getState(); }
function savePrefs(p) { guard_(); PropertiesService.getUserProperties().setProperty('txPrefs', JSON.stringify(p || {}).slice(0, 2000)); }

/** The bridge key (Settings only). Regenerating it disconnects the bridge until its config gets the new key. */
function getBridgeKey() { guard_(); return SP_().getProperty('TX_KEY') || ''; }
function regenerateKey() {
  guard_();
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  SP_().setProperty('TX_KEY', key);
  return key;
}

/**
 * Run once from the editor (or Settings → Set up): makes the "SURE Walk Texts" log spreadsheet in your Drive,
 * the bridge key, and turns texting on with Auto-text OFF (turn it on in the dashboard when you're ready).
 */
function setupTexts() {
  guard_();
  const p = SP_();
  if (!p.getProperty('TEXTS_SHEET_ID')) {
    const ss = SpreadsheetApp.create('SURE Walk Texts');
    const msgs = ss.getSheets()[0].setName('Messages');
    msgs.getRange(1, 1, 1, 11).setValues([['Time', 'Night', 'Direction', 'Phone', 'Ride ID', 'Row', 'Name', 'Text', 'Status', 'Intent', 'Note']])
      .setFontWeight('bold');
    msgs.setFrozenRows(1);
    p.setProperty('TEXTS_SHEET_ID', ss.getId());
  }
  if (!p.getProperty('TX_KEY')) regenerateKey();
  if (p.getProperty('TX_TEXTING') === null) p.setProperty('TX_TEXTING', 'true');
  if (p.getProperty('TX_AUTOTEXT') === null) p.setProperty('TX_AUTOTEXT', 'false');
  return { sheet: 'https://docs.google.com/spreadsheets/d/' + p.getProperty('TEXTS_SHEET_ID'), key: p.getProperty('TX_KEY') };
}
