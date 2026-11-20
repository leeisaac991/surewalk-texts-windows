/**
 * Rider texting: tonight's texting state, templates, new-ride confirmations, reading replies, and the outbox the
 * local bridge sends from the UT iPhone.
 *
 * State (Script Properties, chunked with bigSet_ under 'TX', reset each night at 2:30am):
 *   rides: { rideId: { row, first, phone10, state, note, textedAt, confirmedAt, lastInAt } }
 *     state: ready (not texted yet) | queued | texted (waiting for YES) | confirmed | cancelled | duplicate |
 *            optedout | flagged (needs you before texting) | skipped (already picked / cancelled when first seen)
 *   out:   [{ outId, to, body, rideId, kind, st: queued|sending|sent|failed|unknown, at, lease, err }]
 *   msgs:  [{ id, ts, dir: in|out, phone, body, rideId, intent, st, outId }]   (newest 300; full log in the Texts sheet)
 *   flags: [{ id, ts, kind, rideId, phone, text, note, done }]                 ("needs a look")
 *   seen:  inbound ids already handled (the bridge may resend a batch)
 */
const FILE_VERSION_TEXTS = '2026-11-04h'; // + 👥 group rides 2026-11-18

const FRESH_MIN = 30;      // rides first seen later than this after submitting are not texted automatically
// No answer to the confirmation (user, 2026-11-14): a reminder text after REMIND_MIN, a "call them" flag after
// CALL_FLAG_MIN — only while the ride is still waiting (no crew, arrival or dispatcher on it). The windows keep a
// restart from reminding / flagging rides that were texted long ago.
const REMIND_MIN = 5, REMIND_UNTIL_MIN = 15, CALL_FLAG_MIN = 10, CALL_FLAG_UNTIL_MIN = 60, NO_REPLY_FLAG = 'No reply — call';
const RATE_LIMIT_RE = /wait a moment|try again|rate.?limit/i, RATE_PAUSE_MS = 60e3; // BlueFerry's send limit
const SEND_GAP_MS = typeof SW_SEND_GAP_MS === 'number' ? SW_SEND_GAP_MS : 6e3, SEND_PER_HOUR = 190, LOW_PRIORITY_KINDS = ['reminder', 'hoursTip', 'poll']; // pacing (takeOutbox_)
const LEASE_MS = 120e3;    // an outbox item handed to the bridge; no result by then = outcome unknown (never resent)
const KEEP_MSGS = 300;

const TEMPLATE_DEFAULTS = {
  confirm: "REPLY YES to confirm your SURE Walk ride ({pickup} → {dropoff}), or CANCEL if you no longer need it. Hi {first}! The current wait time is {eta}, and your driver will call you when they're ready to pick you up.",
  confirmed: "Thanks {first}, you're confirmed! Keep your phone nearby — your driver will call when they're close.",
  cancelled: 'Got it {first}, your ride is cancelled. Stay safe!',
  eta: "Hi {first}, the current wait time is {eta}. Your driver will call you when they're ready to pick you up. Thanks for your patience!",
  askCancel: 'Reply CANCEL to cancel your ride, or YES to keep it.',
  confirmAda: "REPLY YES if you need an ADA (wheelchair-accessible) vehicle, NO if you don't, or CANCEL if you no longer need a ride. Hi {first}! SURE Walk got your ride request: {pickup} → {dropoff}. The current wait time is {eta}, and your driver will call you when they're ready to pick you up.",
  confirmedAda: "Thanks {first}, you're confirmed for an ADA pickup! An accessible vehicle is coming for you — keep your phone nearby, your driver will call when they're close.",
  adaNo: "Got it {first} — no ADA vehicle needed. You're confirmed! Keep your phone nearby — your driver will call when they're close.",
  changeAsk: "Got it — change your {which} to {place}? Reply YES to confirm.",
  changeDone: "Done! Your {which} is now {place}. Your driver will call you when they're ready to pick you up.",
  reminder: "REPLY YES to keep your SURE Walk ride ({pickup} → {dropoff}) — we haven't heard back from you. Reply CANCEL if you no longer need it.",
  whichMoody: "REPLY CENTER or DMC: which Moody do you mean — the Moody Center (the arena) or DMC (the Dealey Center, Moody College)? Hi {first}! SURE Walk got your ride request: {pickup} → {dropoff}.",
  optout: "You won't get any more texts from SURE Walk.",
  // 👥 Added to the end of "you're confirmed" when other riders asked for a ride around the same time (no one is named):
  groupAsk: "Riding with friends who also requested a SURE Walk ride? Reply with their first names (or NO if it's just you) and we'll try to put you in the same car, but we can't promise it.",
  groupHint: "Going with friends? Text us their first names and we'll try to put you in the same car, but we can't promise it.",
  groupJoined: "Got it. Please be aware we may not be able to put your group in the same car because of driver availability. However, we will try our best to get you and {names} in the same vehicle.",
  poll_q1: "📋 SURE Walk (1/3)\nSURE Walk would love your input on shaping the future of our rides! Help us plan future features with 3 quick questions:\n\nHow would you like us to confirm your ride?\n1 • Text message\n2 • Phone call with ETA\n3 • Other (text us your own idea!)\n\n👉 Reply 1, 2, or text your idea (or SKIP)",
  poll_q2: "📋 SURE Walk (2/3)\n\nIn the future, would you like to request rides directly by texting this number?\n\n👉 Reply YES, NO, or MAYBE (or SKIP)",
  poll_q3: "📋 SURE Walk (3/3)\n\nAny other ideas you'd love to see SURE Walk try in the future?\n\n👉 Reply with your thoughts (or SKIP)",
  poll_thanks: "Thanks for helping shape the future of SURE Walk! 🧡\nHave a great night and stay safe!",
  poll_nudge: "Sorry, didn't catch that!\n👉 Please {hint} (or reply SKIP).",
};
const TEMPLATE_LABELS = {
  confirm: 'New ride (sent automatically)', confirmed: 'They replied YES', cancelled: 'They cancelled',
  eta: 'They asked how long', askCancel: 'They replied just "no"', optout: 'They replied STOP',
  whichMoody: 'Pickup / drop-off is just "Moody" (asked before confirming)',

  confirmAda: 'New ADA ride (asks them to confirm they need ADA)', confirmedAda: 'ADA ride: they replied YES', adaNo: 'ADA ride: they replied NO (not needed)',
  groupAsk: 'Group rides: added to "you\'re confirmed" when another rider asked for the same pickup + drop-off around the same time',
  groupHint: 'Group rides: added to "you\'re confirmed" when another rider asked for the same pickup (different drop-off) around the same time',
  groupJoined: 'Group rides: they named friends who also asked for a ride ({names})',
  reminder: 'No reply after 5 min (one reminder)', changeAsk: 'They asked to change their pickup / drop-off ({which}, {place})', changeDone: 'Pickup / drop-off changed after their YES',
  poll_q1: 'Poll: question 1, sent after "you\'re confirmed"', poll_q2: 'Poll: question 2', poll_q3: 'Poll: question 3',
  poll_thanks: 'Poll: thank-you', poll_nudge: 'Poll: answer not understood ({hint})',
};
// "Cancel + text" (dashboard): each choice = the sheet's cancel reason (V) + the text the rider gets (editable in
// Settings, and in the review pop-up before it's sent).
const CANCEL_NOTICES = [
  { key: 'cx_offcampus', label: 'Off-campus pickup', reason: 'Not Within Pickup Drop-off Parameters',
    text: "Hi {first}, SURE Walk can only pick up on UT campus, so we can't pick you up at {pickup}. If you can get to a campus building, please submit a new request. Stay safe!" },
  { key: 'cx_dropoffonly', label: 'Pickup at a drop-off-only place', reason: 'Not Within Pickup Drop-off Parameters',
    text: "Hi {first}, SURE Walk can't pick you up at {pickup} — it's a drop-off only spot. If you can walk to a nearby campus building, please submit a new request from there. Stay safe!" },
  { key: 'cx_area', label: 'Drop-off outside our area', reason: 'Not Within Pickup Drop-off Parameters',
    text: "Hi {first}, {dropoff} is outside SURE Walk's drop-off area, so we can't give this ride. Sorry about that — stay safe!" },
  { key: 'cx_noanswer', label: "Couldn't reach them", reason: 'Not Answering',
    text: "Hi {first}, we tried to reach you but couldn't, so your SURE Walk ride is cancelled. Submit a new request if you still need a ride." },
  { key: 'cx_wait', label: 'Driver waited, no-show', reason: 'Exceeded 2min Wait',
    text: "Hi {first}, your driver waited at {pickup} but couldn't find you, so your ride is cancelled. Submit a new request if you still need one." },
  { key: 'cx_long', label: 'Wait too long tonight', reason: 'Long Wait Time Expected',
    text: "Hi {first}, the wait tonight is much longer than usual, so we've cancelled your request. Sorry — please stay safe getting home." },
  { key: 'cx_closed', label: 'After closing', reason: 'After Deadline',
    text: "Hi {first}, SURE Walk has stopped taking rides for tonight, so we can't give this ride. Stay safe!" },
  { key: 'cx_early', label: 'Before we open', reason: 'Before Start',
    text: "Hi {first}, SURE Walk rides start at 7:00 PM. Please submit a new request then. Thanks!" },
  { key: 'cx_other', label: 'Other (write your own)', reason: 'Other', text: 'Hi {first}, your SURE Walk ride is cancelled. ' },
];
CANCEL_NOTICES.forEach(c => { TEMPLATE_DEFAULTS[c.key] = c.text; TEMPLATE_LABELS[c.key] = 'Cancel + text: ' + c.label; });
const NOREPLY_MIN_DEFAULT = 10;

function templates_() {
  return Object.assign({}, TEMPLATE_DEFAULTS, JSON.parse(SP_().getProperty('TX_TEMPLATES') || '{}'));
}
// {first} {pickup} {dropoff} {eta} {row}
function fill_(tpl, ride, eta, more) { // more: extra fill-ins, e.g. { which: 'pickup', place: 'Jester West' }
  const v = Object.assign({ first: ride.first || 'there', pickup: ride.pickupName || ride.pickup || '', dropoff: ride.dropoffName || ride.dropoff || '',
              eta: eta || 'about 10–15 min', row: ride.row || '' }, more || {});
  return String(tpl).replace(/\{(first|pickup|dropoff|eta|row|which|place|names)\}/g, (m, k) => (v[k] == null ? m : v[k])).replace(/\s+/g, ' ').trim();
}
// "about 8–12 min" from tonight's average wait (Arrival − Call of the last 10 rides).
// Wait estimate from the LINE, not the last few rides: riders ahead ÷ how fast crews are reaching riders right now.
//   minutes ≈ 11.3 + 0.337 × ahead ÷ √(arrivals per minute, last 30 min)
// Fitted on 4 November nights (388 rides), checked on nights it wasn't fitted on: average error 7.1 min (the old
// "average of the last 5" was 9.2) and, with 10+ riders ahead, about right on average (old: 8.6 min too low).
// The range (×0.7 – ×1.35) holds the real wait about half the time. ride: whose wait (riders requested before them).
const ETA_A = 11.3, ETA_B = 0.337;
// Floor (Nov 16, from the ETA log: 143 rides with a real wait): with 0–2 riders ahead the formula said ~12 min but riders
// waited ~17 (crews are spread out / just starting). A 14-min floor cut the average error in both halves of the night
// (5.54→5.38, 6.06→5.94 min) and the quoted range held the real wait more often (58%→62%). Refit A/B after more nights.
const ETA_MIN = 14;
function etaMinutes_(wait, ride) {
  if (!wait || !Array.isArray(wait.line)) return null;
  const ahead = wait.line.filter(o => !ride || (o.id !== ride.id && o.tsMs < ride.tsMs)).length;
  return Math.max(ETA_MIN, Math.min(90, ETA_A + ETA_B * ahead / Math.sqrt(Math.max(wait.rate || 0, 0.1))));
}
function etaText_(wait, ride) {
  const m = etaMinutes_(wait, ride);
  if (m == null) return 'about 10–15 min';
  const lo = Math.max(5, Math.round(m * 0.7 / 5) * 5 || 5), hi = Math.max(lo + 5, Math.round(m * 1.35 / 5) * 5);
  return `about ${lo}–${hi} min`;
}

// ---------- "Moody": Moody Center or CMA? ----------
// A pickup / drop-off of just "moody" ("Moody", "the moody", "moody bldg") could be the Moody Center or DMC: we ask first.
function justMoody_(text) {
  const w = String(text || '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(x => x && !['the', 'at', 'bldg', 'building', 'hall', 'please'].includes(x));
  return w.length === 1 && w[0] === 'moody';
}
const moodyField_ = r => justMoody_(r.pickup) ? 'pickup' : justMoody_(r.dropoff) ? 'dropoff' : '';
// Their answer: 'Moody Center' | 'DMC' (Dealey Center) | 'CMA' (only if they say CMA / Jones) | '' (not clear).
function moodyAnswer_(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const center = /\b(cent(er|re|ee)|arena|concert|game|basketball|mc)\b/.test(t) && !/\b(dealey|dealy|new media)\b/.test(t);
  const dmc = /\b(dmc|dealey|dealy|new media|auditorium|college|communication|communications|comm|class|school|building|bldg)\b/.test(t);
  const cma = /\b(cma|jones)\b/.test(t);
  const hits = [center && 'Moody Center', cma ? 'CMA' : dmc && 'DMC'].filter(Boolean);
  return hits.length === 1 ? hits[0] : '';
}
// The first text to a new ride: "which Moody?" when the place is ambiguous, else the confirmation.
function firstText_(tx, r, rec, wait) {
  const field = moodyField_(r);
  if (field) { // show their own word ("Moody"), not our guess (the place list reads "moody" as CMA)
    const asked = Object.assign({}, r, field === 'pickup' ? { pickupName: 'Moody' } : { dropoffName: 'Moody' });
    queue_(tx, r, fill_(templates_().whichMoody, asked), 'whichMoody'); Object.assign(rec, { state: 'asking', ask: field, note: 'Asked which Moody (' + (field === 'pickup' ? 'pickup' : 'drop-off') + ')' }); return; }
  // ADA riders confirm they need it (an ADA vehicle + a supervisor go out for them); their NO clears ADA in the sheet.
  queue_(tx, r, fill_(templates_()[r.ada ? 'confirmAda' : 'confirm'], r, etaText_(wait, r)), 'confirm');
  if (r.ada) rec.adaAsk = true;
  if (!['confirmed', 'cancelled'].includes(rec.state)) rec.state = 'queued';
}
// Their answer goes into the sheet (Pickup J / Drop-off K), then the ride carries on: confirm it, or ask about
// the other field if that's "moody" too. A Moody Center PICKUP isn't allowed (drop-off only) → review the cancel text.
function resolveMoody_(tx, ride, rec, place, sh, wait) {
  const field = rec.ask, row = rowOf_(sh, ride);
  assertEditable_(sh, row);
  sh.getRange(row, field === 'pickup' ? COL.PICKUP : COL.DROPOFF).setValue(place);
  // The sheet changed: drop the cached copy, or the dashboard shows the old "Moody (Center or DMC?)" for a few seconds
  // (and a cancel text reviewed then would say it).
  try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* cache is best-effort */ }
  logRow_({ dir: 'note', phone: ride.phone10, rideId: ride.id, row: ride.row, name: ride.first, note: `"Moody" ${field} → ${place} (from their text)` });
  const r = Object.assign({}, ride, field === 'pickup' ? { pickup: place, pickupName: canonPlace_(place) || place, offPickup: offCampusPickup_(place) }
                                                       : { dropoff: place, dropoffName: canonPlace_(place) || place });
  delete rec.ask;
  if (field === 'pickup' && r.offPickup && dropoffOnly_(place) && toggle_('TX_AUTOTEXT')) { autoCancel_(tx, r, rec, 'cx_dropoffonly', `Pickup at ${r.pickupName} (drop-off only)`); return; }
  if (field === 'pickup' && r.offPickup) {
    Object.assign(rec, { state: 'flagged', note: `Pickup at ${r.pickupName} (drop-off only)`, invalid: 'cx_dropoffonly' });
    flag_(tx, 'Drop-off-only pickup', r.id, r.phone10, `${r.pickupName} → ${r.dropoffName}`, `${r.first} (row ${r.row}) said the pickup is ${r.pickupName} — we don't pick up there (drop-off only). Review the cancel text to cancel it and tell them.`);
    return;
  }
  rec.state = 'texted'; // so firstText_ doesn't keep a stale state
  firstText_(tx, r, rec, wait);
}

// Spell out places for the crews right in the sheet (PLACE_REWRITES in Places.gs): "Target" → "Target (Dobie)".
function rewritePlaces_(r) {
  const fixPu = placeRewrite_(r.pickup), fixDr = placeRewrite_(r.dropoff);
  if (!fixPu && !fixDr || r.state !== 'open') return;
  try {
    const sh = sheet_(), row = rowOf_(sh, r);
    assertEditable_(sh, row);
    if (fixPu) { sh.getRange(row, COL.PICKUP).setValue(fixPu); Object.assign(r, { pickup: fixPu, pickupName: canonPlace_(fixPu) || fixPu, offPickup: offCampusPickup_(fixPu), dropoffOnly: dropoffOnly_(fixPu) }); }
    if (fixDr) { sh.getRange(row, COL.DROPOFF).setValue(fixDr); Object.assign(r, { dropoff: fixDr, dropoffName: canonPlace_(fixDr) || fixDr }); }
    try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
    logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: `Place spelled out: ${[fixPu && 'pickup → ' + fixPu, fixDr && 'drop-off → ' + fixDr].filter(Boolean).join(', ')}` });
  } catch (e) { /* not editable: leave the sheet as it is */ }
}

// How a new request from the same number relates to their open ride (places compared by name, so "Rec" = "Rec Center").
function routeRelation_(a, b) {
  const k = s => placeKey_(s), pu = k(a.pickup) === k(b.pickup), dr = k(a.dropoff) === k(b.dropoff);
  return pu && dr ? 'same' : pu ? 'newDropoff' : !dr ? 'newTrip' : 'other';
}
// Same pickup, new drop-off, sent within UPDATE_WINDOW_MIN of their open ride: the open ride's drop-off (K) is updated
// (it keeps its Call Time / dispatcher / confirmation), the new form row is marked duplicate (red) so dispatch ignores it,
// and a rider we already texted is told. A ride a crew already has goes to you instead (the crew must hear about it).
const UPDATE_WINDOW_MIN = 20;
function updateDropoff_(tx, prev, r, n) {
  const place = r.dropoffName || r.dropoff;
  if (prev.driver) {
    Object.assign(n, { state: 'flagged', note: `New drop-off for row ${prev.row} — crew has it` });
    flag_(tx, 'Updated request?', r.id, r.phone10, `${r.pickup} → ${r.dropoff}`, `${r.first} (row ${r.row}) changed the drop-off to ${place}, but ${[prev.driver, prev.nav].filter(Boolean).join(' / ')} already has row ${prev.row} — update it and tell the crew`);
    return;
  }
  try {
    const sh = sheet_(), prow = rowOf_(sh, prev);
    assertEditable_(sh, prow);
    sh.getRange(prow, COL.DROPOFF).setValue(r.dropoff);
    sh.getRange(rowOf_(sh, r), 1, 1, sh.getMaxColumns()).setBackground(DUPLICATE_COLOR);
    try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
    Object.assign(n, { state: 'duplicate', note: `Updated the drop-off of row ${prev.row} to ${place}` });
    logRow_({ dir: 'note', phone: r.phone10, rideId: prev.id, row: prev.row, name: r.first, note: `Drop-off → ${place} (resubmitted as row ${r.row}; that row marked duplicate)` });
    const pr = tx.rides[prev.id];
    if (pr && ['texted', 'confirmed', 'queued', 'asking'].includes(pr.state)) queue_(tx, prev, fill_(templates_().changeDone, prev, '', { which: 'drop-off', place }), 'changeDone');
  } catch (e) {
    Object.assign(n, { state: 'flagged', note: `Same phone as row ${prev.row} — updated request?` });
    flag_(tx, 'Updated request?', r.id, r.phone10, `${r.pickup} → ${r.dropoff}`, `${r.first} (row ${r.row}) changed the drop-off to ${place}, but row ${prev.row} couldn't be updated automatically: ${e.message}`);
  }
}
// Cancel the ride in the sheet and queue the matching cancel text; if the sheet can't be written, it's flagged instead.
function autoCancel_(tx, r, rec, noticeKey, note) {
  const notice = CANCEL_NOTICES.find(c => c.key === noticeKey);
  try {
    const sh = sheet_();
    cancelRow_(sh, rowOf_(sh, r), notice.reason);
    try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
    Object.assign(rec, { state: 'cancelled', note: note + ' — cancelled and texted automatically', invalid: '' });
    queue_(tx, r, fill_(templates_()[noticeKey], r), 'cancelNotice');
    logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'Cancelled automatically: ' + note });
  } catch (e) {
    Object.assign(rec, { state: 'flagged', note, invalid: noticeKey });
    flag_(tx, 'Drop-off-only pickup', r.id, r.phone10, `${r.pickupName} → ${r.dropoffName}`, `${r.first} (row ${r.row}) — ${note}, but it couldn't be cancelled automatically: ${e.message}`);
  }
}

// ---------- "change my pickup to X" ----------
// A rider asks by text to change their pickup or drop-off to a place we know: we ask "change your pickup to X?";
// their YES updates the sheet and confirms; anything else goes to you. Rides a crew already has always go to you.
const CHANGE_RES_ = [
  { re: /\b(?:change|switch|update|move)\s+(?:my\s+|the\s+|our\s+)?(pick\s*-?\s*up|drop\s*-?\s*off|destination|location)(?:\s+location)?\s+(?:to|at)\s+(.+)/i },
  { re: /\b(?:change|switch|update|move)\s+(?:it\s+)?to\s+(.+)/i, field: 'pickup' },
  { re: /\b(?:pick|get)\s+(?:me|us)\s+up\s+(?:at|from|outside|in front of)\s+(.+)/i, field: 'pickup' },
  { re: /\b(?:drop|take)\s+(?:me|us)\s+(?:off\s+)?(?:at|to)\s+(.+)/i, field: 'dropoff' },
];
function parseChange_(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  for (const c of CHANGE_RES_) {
    const m = c.re.exec(t);
    if (!m) continue;
    const word = c.field ? '' : m[1].toLowerCase().replace(/[\s-]/g, '');
    const field = c.field || (/drop|destination/.test(word) ? 'dropoff' : 'pickup');
    const raw = (c.field ? m[1] : m[2]).split(/\s*(?:[,.!?;]|\bsince\b|\bbecause\b|\bcuz\b|\binstead\b|\bplease\b|\bpls\b|\bthanks?\b|\bthank you\b|\bif\b)\s*/i)[0].trim();
    const place = raw && canonPlace_(raw);
    if (place) return { field, raw, place };
  }
  return null;
}

// ---------- state ----------
function loadTx_() {
  const night = nightKey_(new Date()), tx = bigGet_('TX');
  if (tx && tx.night === night) return tx;
  return { night, rides: {}, out: [], msgs: [], flags: [], seen: [], dial: [], seq: 0 };
}
function saveTx_(tx) {
  tx.msgs = tx.msgs.slice(-KEEP_MSGS);
  tx.out = tx.out.filter(o => ['queued', 'sending'].includes(o.st) || Date.now() - o.at < 6 * 3600e3).slice(-400);
  tx.flags = tx.flags.filter(f => !f.done || Date.now() - f.ts < 3600e3).slice(-200);
  tx.seen = tx.seen.slice(-600);
  bigSet_('TX', tx);
}
const optOuts_ = () => JSON.parse(SP_().getProperty('TX_OPTOUT') || '[]');
function setOptOut_(phone10, on) {
  const list = optOuts_().filter(p => p !== phone10);
  if (on) list.push(phone10);
  SP_().setProperty('TX_OPTOUT', JSON.stringify(list.slice(-2000)));
}
const toggle_ = name => SP_().getProperty(name) === 'true'; // TX_TEXTING / TX_AUTOTEXT: off until you turn them on (setupTexts turns Texting on)
const newId_ = (tx, p) => p + (++tx.seq) + '-' + Date.now().toString(36);

// When this number last texted us (any ride): a reply counts even if it was matched to another of their rides.
function lastInOf_(tx, phone10) {
  let t = 0;
  if (phone10) (tx.msgs || []).forEach(m => { if (m.dir === 'in' && m.phone === phone10 && m.ts > t) t = m.ts; });
  return t;
}
function flag_(tx, kind, rideId, phone, text, note) {
  const f = { id: newId_(tx, 'f'), ts: Date.now(), kind, rideId: rideId || '', phone: phone || '', text: text || '', note: note || '', done: false };
  tx.flags.push(f);
  logRow_({ dir: 'flag', phone, rideId, body: text, note: `${kind}: ${note || ''}` });
  return f;
}
function queue_(tx, ride, body, kind) {
  const o = { outId: newId_(tx, 'o'), to: '+1' + ride.phone10, body, rideId: ride.id || '', kind, st: 'queued', at: Date.now() };
  const rec = ride.id && tx.rides[ride.id], q = /about \d+–\d+ min/.exec(body); // the first wait we quoted them (ETA log)
  if (rec && q && !rec.etaQuote && /^(confirm|confirmAda|confirmed|eta)$/.test(kind)) rec.etaQuote = q[0];
  tx.out.push(o);
  tx.msgs.push({ id: o.outId, ts: o.at, dir: 'out', phone: ride.phone10, body, rideId: o.rideId, st: 'queued', outId: o.outId, kind });
  return o;
}

// ---------- new rides ----------
/**
 * New rides in the sheet get a record; an open ride with a good phone is texted (Auto-text on) or left Ready.
 * Never texted automatically: duplicates (dispatch app's rule), a second ride from the same phone with a different
 * route ("Updated request?"), off-campus pickups, opted-out numbers, rides already over 30 min old when first seen.
 */
function scanRides_(tx, rides, wait) {
  const now = Date.now(), auto = toggle_('TX_AUTOTEXT'), optOut = new Set(optOuts_()), tpl = templates_();
  // Were we watching a moment ago? (bridge / dashboard check every few seconds). Only then is "now" the assign time.
  const watching = !!tx.lastScan && now - tx.lastScan < 90e3;
  tx.lastScan = now;
  rides.forEach(r => {
    const rec = tx.rides[r.id];
    if (rec) { // follow what the sheet says now
      rec.row = r.row;
      if (r.state === 'cancelled' && rec.state !== 'cancelled') {
        rec.state = 'cancelled'; rec.note = rec.note || 'Cancelled in the sheet';
        // logged so Metrics knows (a texted rider cancelled before replying isn't a "no reply")
        logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'Cancelled in the sheet' + (r.reason ? ': ' + r.reason : '') });
      }
      if (r.state === 'dup' && !['duplicate', 'cancelled'].includes(rec.state)) { rec.before = rec.state; rec.state = 'duplicate'; rec.note = 'Marked duplicate in the sheet'; }
      // The red mark was taken off again: back to what it was (Confirmed if they said YES meanwhile).
      if (r.state === 'open' && rec.state === 'duplicate' && rec.note === 'Marked duplicate in the sheet' && !r.dupOf) {
        rec.state = rec.saidYes ? 'confirmed' : rec.before || 'texted';
        if (rec.state === 'confirmed' && !rec.confirmedAt) rec.confirmedAt = rec.lastInAt;
        rec.note = '';
      }
      if (r.state === 'picked') rec.picked = true;
      // Texted and waiting for their reply, then a dispatcher assigned a crew: resolved — Call Time = the assign time.
      if (['texted', 'queued', 'asking'].includes(rec.state) && r.driver && r.state === 'open') {
        const crew = [r.driver, r.nav].filter(Boolean).join(' / ');
        let t = '';
        if (watching) { // we saw it happen: Call Time = the assign time. After a gap (app was off / just updated) C is left alone.
          try { const sh = sheet_(); t = setCallTimeAssigned_(sh, rowOf_(sh, r), now, rec.callSet || ''); } catch (e) { /* finished / moved: leave C */ }
        }
        Object.assign(rec, { state: 'assigned', note: `Assigned to ${crew}` + (t ? ` · Call Time ${t}` : '') });
        if (t) rec.callSet = t;
      }
      // No answer to our text yet, and still waiting: one reminder at 5 min, then flagged for you to call at 10.
      // Their reply, a crew, an arrival or a dispatcher's name on the ride clears the flag.
      if (['texted', 'asking'].includes(rec.state) && rec.textedAt) {
        const replied = (rec.lastInAt || 0) >= rec.textedAt - 60e3 || lastInOf_(tx, r.phone10) >= rec.textedAt - 60e3;
        const waiting = r.state === 'open' && !r.driver && !r.arrived && !r.dispatcher;
        const mins = (now - rec.textedAt) / 60e3;
        if (!replied && waiting && r.phone10 && !optOut.has(r.phone10)) {
          if (auto && !rec.remindedAt && mins >= REMIND_MIN && mins < REMIND_UNTIL_MIN) {
            queue_(tx, r, fill_(tpl.reminder, r), 'reminder');
            rec.remindedAt = now; rec.note = 'No reply in 5 min — reminder sent';
          }
          if (!rec.callFlagAt && mins >= CALL_FLAG_MIN && mins < CALL_FLAG_UNTIL_MIN) {
            rec.callFlagAt = now; rec.note = `No reply in ${CALL_FLAG_MIN} min — call them`;
            flag_(tx, NO_REPLY_FLAG, r.id, r.phone10, `${r.pickup} → ${r.dropoff}`,
              `${r.first} (row ${r.row}) hasn't answered the text${rec.remindedAt ? ' or the reminder' : ''} in ${CALL_FLAG_MIN} min — call them (📞).`);
          }
        }
      }
      if (rec.callFlagAt && !rec.callFlagDone) { // (the ride may have moved on to Assigned / Confirmed / Cancelled since)
        const replied = (rec.lastInAt || 0) >= rec.textedAt - 60e3 || lastInOf_(tx, r.phone10) >= rec.textedAt - 60e3;
        if (replied || r.state !== 'open' || r.driver || r.arrived || r.dispatcher || !['texted', 'asking'].includes(rec.state)) {
          tx.flags.filter(f => f.rideId === r.id && f.kind === NO_REPLY_FLAG && !f.done).forEach(f => { f.done = true; });
          rec.callFlagDone = true;
        }
      }
      // Flagged "Off-campus pickup", but the place list now knows it's on campus (e.g. "Main Mall" was added):
      // back to "not texted" and off Needs a look — the same as fixing the pickup with ✎ Edit.
      if (rec.state === 'flagged' && rec.invalid === 'cx_offcampus' && r.pickup && !r.offPickup) {
        delete rec.invalid;
        Object.assign(rec, { state: 'ready', note: 'Pickup is on campus — not texted yet' });
        tx.flags.filter(x => x.rideId === r.id).forEach(x => { x.done = true; });
      }
      // Held back as "Updated request?" because of another open ride, and that ride is now over: not a change after all.
      const other = rec.state === 'flagged' && /^Same phone as row (\d+)/.exec(rec.note || '');
      if (other) {
        const o = rides.find(x => x.row === Number(other[1]) && x.phone10 === r.phone10);
        if (!o || rideDone_(tx, rides, o.id)) {
          Object.assign(rec, { state: 'ready', note: `Row ${other[1]} is finished — not texted yet` });
          tx.flags.filter(f => f.rideId === r.id && f.kind === 'Updated request?' && !f.done).forEach(f => { f.done = true; });
        }
      }
      // Not texted yet, but a dispatcher has since called or assigned it: it no longer needs a text.
      if (rec.state === 'ready' && handled_(r)) Object.assign(rec, { state: 'skipped', note: handledNote_(r) });
      return;
    }
    const n = tx.rides[r.id] = { row: r.row, first: r.first, phone10: r.phone10, state: 'ready', note: '', seenAt: now };
    rewritePlaces_(r); // "Target" → "Target (Dobie)" in the sheet, before anything reads the place
    // (a texting state like "confirmed" stays after the ride is over: only rides still going count — rideDone_)
    const openSamePhone = r.phone10 && Object.keys(tx.rides).filter(id => id !== r.id && tx.rides[id].phone10 === r.phone10 &&
      ['queued', 'texted', 'confirmed', 'ready', 'asking'].includes(tx.rides[id].state) && !rideDone_(tx, rides, id));
    // Their most recent open ride, and how this request relates to it: 'same' route, a 'newDropoff' (same pickup),
    // a 'newTrip' (new pickup and new drop-off = its own ride), or 'other' (new pickup, same drop-off).
    // (open = in the sheet: not picked, cancelled or duplicate — including rides a dispatcher already called / assigned)
    const prev = r.phone10 ? rides.filter(x => x.id !== r.id && x.phone10 === r.phone10 && x.state === 'open' && !x.dupOf && x.tsMs <= r.tsMs &&
      !rideDone_(tx, rides, x.id) && !['duplicate', 'cancelled'].includes((tx.rides[x.id] || {}).state)).sort((a, b) => b.tsMs - a.tsMs)[0] : null;
    const rel = prev ? routeRelation_(prev, r) : '';
    if (r.state === 'cancelled') Object.assign(n, { state: 'skipped', note: 'Cancelled in the sheet' });
    else if (r.state === 'dup' || r.dupOf) Object.assign(n, { state: 'duplicate', note: r.dupOf ? `Duplicate of row ${r.dupOf.row}` : 'Marked duplicate (red)' });
    else if (r.state === 'picked') Object.assign(n, { state: 'skipped', note: 'Already picked up' });
    else if (afterDeadline_(r.tsMs)) { // requested at/after 2:00 AM: we've stopped taking rides — cancel it, no confirmation
      try {
        const sh = sheet_();
        cancelRow_(sh, rowOf_(sh, r), 'After Deadline');
        Object.assign(n, { state: 'cancelled', note: 'Requested after 2:00 AM — cancelled automatically (After Deadline)' });
        logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: 'Cancelled automatically: after 2:00 AM' });
        if (r.phone10 && !optOut.has(r.phone10) && SP_().getProperty('TX_LATE_NOTICE') !== 'false') queue_(tx, r, fill_(tpl.cx_closed, r), 'cancelNotice');
      } catch (e) {
        Object.assign(n, { state: 'flagged', note: 'After 2:00 AM — cancel it' });
        flag_(tx, 'After 2:00 AM', r.id, r.phone10, `${r.pickup} → ${r.dropoff}`, `${r.first} (row ${r.row}) asked at ${r.time}, after closing, but it couldn't be cancelled automatically: ${e.message}`);
      }
    }
    else if (handled_(r)) Object.assign(n, { state: 'skipped', note: handledNote_(r) }); // already called or assigned: no text needed
    else if (!r.phone10) { Object.assign(n, { state: 'flagged', note: 'No valid phone number' }); flag_(tx, 'No phone', r.id, '', r.phone, `${r.first} (row ${r.row}): "${r.phone}" isn't a phone number`); }
    else if (optOut.has(r.phone10)) Object.assign(n, { state: 'optedout', note: 'Replied STOP before' });
    else if (prev && rel === 'same') {
      // The same route submitted again from the same number: a copy of the open request, not a change — mark duplicate in the sheet too
      try {
        const sh = sheet_();
        sh.getRange(rowOf_(sh, r), 1, 1, sh.getMaxColumns()).setBackground(DUPLICATE_COLOR);
        try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) {}
      } catch (e) {}
      Object.assign(n, { state: 'duplicate', note: `Same request again (row ${prev.row})` });
      logRow_({ dir: 'note', phone: r.phone10, rideId: r.id, row: r.row, name: r.first, note: `Marked duplicate (same request as row ${prev.row})` });
    }
    else if (prev && rel === 'newDropoff' && r.tsMs - prev.tsMs <= UPDATE_WINDOW_MIN * 60e3) {
      updateDropoff_(tx, prev, r, n); // same pickup, new drop-off soon after: the open ride is updated
    }
    else if (prev ? rel !== 'newTrip' : openSamePhone.length) { // (a new pickup AND new drop-off is simply another ride)
      const o = prev || rides.find(x => x.id === openSamePhone[0]) || { row: tx.rides[openSamePhone[0]].row };
      Object.assign(n, { state: 'flagged', note: `Same phone as row ${o.row} — updated request?` });
      flag_(tx, 'Updated request?', r.id, r.phone10, `${r.pickup} → ${r.dropoff}`, `${r.first} (row ${r.row}) has another open ride (row ${o.row}) — not texted automatically`);
    } else if (r.offPickup && dropoffOnly_(r.pickup) && auto) { // e.g. the Moody Center: cancelled and told right away
      autoCancel_(tx, r, n, 'cx_dropoffonly', `Pickup at ${r.pickupName} (drop-off only)`);
    } else if (r.offPickup) { // invalid: the cancel text is ready for you to review and approve
      const only = dropoffOnly_(r.pickup); // e.g. the Moody Center: on campus, but drop-off only
      Object.assign(n, { state: 'flagged', note: only ? `Pickup at ${r.pickupName} (drop-off only)` : 'Off-campus pickup', invalid: only ? 'cx_dropoffonly' : 'cx_offcampus' });
      flag_(tx, only ? 'Drop-off-only pickup' : 'Off-campus pickup', r.id, r.phone10, `${r.pickup} → ${r.dropoff}`,
        `${r.first} (row ${r.row}) — ${only ? `${r.pickupName} is drop-off only` : 'we only pick up on campus'}. Review the cancel text to cancel it and tell them.`);
    } else if (beforeStart_(r.tsMs)) {
      Object.assign(n, { state: 'flagged', note: 'Requested before 7:00 PM', invalid: 'cx_early' });
      flag_(tx, 'Before 7 PM', r.id, r.phone10, `${r.pickup} → ${r.dropoff}`, `${r.first} (row ${r.row}) asked at ${r.time}, before rides start. Review the cancel text to cancel it and tell them.`);
    } else if (now - r.tsMs > FRESH_MIN * 60e3) Object.assign(n, { note: `Already ${Math.round((now - r.tsMs) / 60e3)} min old when first seen — not texted automatically` });
    else if (auto) firstText_(tx, r, n, wait); // the confirmation, or "which Moody?" first
  });
  try { etaLog_(tx, rides, wait); } catch (e) { console.log('ETA log: ' + (e && e.message)); } // never in the way of texting
}

// A ride that's over: picked up (row colored, or seen picked), crew arrived (Arrival filled in), cancelled, duplicate,
// or no longer in tonight's sheet. Used so a rider's finished ride never makes their next request an "Updated request?".
function rideDone_(tx, rides, id) {
  const rec = tx.rides[id] || {}, s = rides.find(x => x.id === id);
  return !!rec.picked || !s || s.state !== 'open' || !!String(s.arrived || '').trim() || ['cancelled', 'duplicate'].includes(rec.state);
}

// ---------- 👥 Group rides ----------
/*
 * Friends often each submit a request. When a rider says YES and someone else asked for the same pickup within
 * 10 min, their "you're confirmed" text ends with a question (same pickup + drop-off: groupAsk) or a hint (same
 * pickup only: groupHint). No other rider is ever named to them: THEY name who they're with.
 * Their answer: first names → matched against tonight's open rides requested within 20 min (not their own phone);
 * "yes / we're together" → the one same-route ride, if there's exactly one; "no / just me" → riding alone.
 * One side naming the other is enough to group them. A conflict (the other rider said they're alone, or is already
 * in another group), names that match no ride, or a name that fits several rides → a "Group?" flag for you.
 * A group = tx.groups[] { id, rides: [ride ids], said: { rideId: true } (who told us themselves), letter, wrote };
 * the texting server gives it a letter and writes "Group A" into the Confirmed column once per rider (the same
 * place the calling panel keeps its traveling-together groups), so a dispatcher can still change or remove it.
 * Also read without asking: "Okay - I'm with Sam" right after the confirmation text.
 */
const GROUP_WINDOW_MIN = 10, GROUP_NAME_WINDOW_MIN = 20, GROUP_LISTEN_MIN = 45, GROUP_FLAG = 'Group?';
const groupSamePlace_ = (a, b) => !!norm_(a) && norm_(a) === norm_(b);
const groupLive_ = (tx, rides, x) => !rideDone_(tx, rides, x.id) && !x.dupOf && !['duplicate', 'cancelled', 'optedout'].includes((tx.rides[x.id] || {}).state);
/** Open rides that look like they go with r: same pickup, requested within 10 min, another phone. exact = same drop-off too. */
function groupMatches_(tx, rides, r) {
  return rides.filter(x => x.id !== r.id && (!r.phone10 || x.phone10 !== r.phone10) && groupLive_(tx, rides, x) &&
    Math.abs(x.tsMs - r.tsMs) <= GROUP_WINDOW_MIN * 60e3 && groupSamePlace_(x.pickupName, r.pickupName))
    .map(x => ({ ride: x, exact: groupSamePlace_(x.dropoffName, r.dropoffName) }));
}
const groupOf_ = (tx, id) => (tx.groups || []).find(g => g.rides.includes(id)) || null;
/** The ask (or hint) to add to r's "you're confirmed" text, or ''. Remembers that we asked. */
function groupAskFor_(tx, rides, r, rec, tpl) {
  if (!rec || rec.groupAsk || groupOf_(tx, r.id)) return '';
  const m = groupMatches_(tx, rides, r);
  if (!m.length) return '';
  const exact = m.some(x => x.exact);
  rec.groupAsk = { at: Date.now(), exact };
  return fill_(exact ? tpl.groupAsk : tpl.groupHint, r);
}
const GROUP_STOP_ = new Set(("yes yeah yea yep yup ya yah ye ok okay k kk sure and n with w my me im i i'm iam m we we're were are am is be " +
  "our friend friends friend's roommate roommates bf gf boyfriend girlfriend bestie buddy buddies the a an also too both all of " +
  "them they us together group riding ride rides going go car same one two three plus just hi hey hello thanks thank you u so " +
  "his her their name names it it's its that this here there coming come will be gonna want wants to for in on at by from " +
  "sister brother bro sis mom dad cousin partner person people other others another girl guy guys she he lol haha please pls " +
  "no nope nah alone solo myself only nobody none everyone all").split(' '));
/** "Sam and Priya", "yes we're together", "no just me" → { names: [ride], unknown: [word], ambiguous: [word], together, alone } */
function parseGroupReply_(text, cands, me) {
  const t = String(text || '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  const words = t.replace(/[^a-z' -]/g, ' ').split(/[\s-]+/).map(w => w.replace(/^'+|'+$/g, '').replace(/'s$/, '')).filter(Boolean);
  const out = { names: [], unknown: [], ambiguous: [], together: false, alone: false };
  const first = x => norm_(String(x.first || '').split(/\s+/)[0]);
  words.forEach(w => {
    if (GROUP_STOP_.has(w) || w.length < 2) return;
    const fits = cands.filter(x => { const f = first(x); return f && (f === w || (w.length >= 3 && f.length >= 3 && (f.startsWith(w) || w.startsWith(f)))); });
    const exactName = fits.filter(x => first(x) === w), pool = exactName.length ? exactName : fits;
    const pick = pool.length > 1 ? pool.filter(x => groupSamePlace_(x.pickupName, me.pickupName)) : pool;
    if (pick.length === 1) { if (!out.names.includes(pick[0])) out.names.push(pick[0]); }
    else if (pool.length) out.ambiguous.push(w);
    else if (w.length >= 2 && w !== norm_(me.first)) out.unknown.push(w);
  });
  out.alone = /^(no|nope|nah|n)\b|\b(just me|only me|me only|by myself|just myself|alone|solo|no ?one|nobody|not with anyone|just one)\b/.test(t);
  out.together = !out.alone && /^(y|ya|yah|yes+|yeah+|yea|yep|yup|ye|sure|correct)\b|\b(together|same (group|car)|we'?re (a group|all)|all of us|both of us|with (them|him|her|my friends?|friends))\b/.test(t);
  return out;
}
/** Put rides a and b in one group (a told us). null = they're already in two different groups. */
function joinGroup_(tx, a, b) {
  tx.groups = tx.groups || [];
  const ga = groupOf_(tx, a.id), gb = groupOf_(tx, b.id);
  if (ga && gb && ga !== gb) return null;
  let g = ga || gb;
  if (!g) { g = { id: newId_(tx, 'g'), rides: [], said: {}, letter: '', wrote: {}, at: Date.now() }; tx.groups.push(g); }
  [a.id, b.id].forEach(id => { if (!g.rides.includes(id)) g.rides.push(id); });
  g.said[a.id] = true;
  return g;
}
const who_ = r => `${r.first} (row ${r.row})`;
/**
 * Their text as an answer about riding together. asked = we asked / hinted and they haven't answered yet.
 * Returns '' (not about groups: handle it as usual), 'used' (taken; a YES still confirms them) or 'done' (nothing else to do).
 */
function groupReply_(tx, rides, ride, rec, text, asked, tpl) {
  const t = String(text || '').toLowerCase();
  const mention = /\b(with|together|friends?|roommates?|group)\b/.test(t);
  if (!asked && !mention) return '';
  const cands = rides.filter(x => x.id !== ride.id && x.first && (!ride.phone10 || x.phone10 !== ride.phone10) &&
    Math.abs(x.tsMs - ride.tsMs) <= GROUP_NAME_WINDOW_MIN * 60e3 && groupLive_(tx, rides, x));
  const p = parseGroupReply_(text, cands, ride), now = Date.now(), body = String(text || '').slice(0, 300);
  if (!asked && !p.names.length) return ''; // a mention we can't place: read as usual
  if (p.alone && !p.names.length) {
    rec.groupAnswer = { alone: true, at: now };
    const g = groupOf_(tx, ride.id);
    if (g) flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} says they're riding alone, but ${g.rides.filter(id => id !== ride.id).map(id => who_(rides.find(x => x.id === id) || tx.rides[id] || { first: '?', row: '?' })).join(', ')} named them — check the group`);
    return 'done';
  }
  let named = p.names;
  if (!named.length && p.together) {
    const same = groupMatches_(tx, rides, ride).filter(x => x.exact).map(x => x.ride);
    if (same.length === 1) named = same;
    else {
      rec.groupAnswer = { together: true, at: now };
      flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} says they're riding with friends, but ${same.length ? `${same.length} rides could be theirs (${same.map(who_).join(', ')})` : 'no other ride has their route'} — ask who, or group them in the calling panel`);
      return 'used';
    }
  }
  if (p.ambiguous.length) flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} named ${p.ambiguous.join(', ')} — more than one ride tonight has that name; group them by hand`);
  if (!named.length) {
    if (!asked) return '';
    rec.groupAnswer = { unmatched: true, at: now };
    if (!p.ambiguous.length) flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} answered about riding together, but no ride requested near theirs has ${p.unknown.length ? 'the name ' + p.unknown.join(' / ') : 'a name they gave'} — check`);
    return 'used';
  }
  rec.groupAnswer = { named: named.map(x => x.id), at: now };
  const joined = [];
  named.forEach(o => {
    const ans = (tx.rides[o.id] || {}).groupAnswer;
    if (ans && ans.alone) { flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} says they're with ${who_(o)}, but ${o.first} said they're riding alone — not grouped`); return; }
    const g = joinGroup_(tx, ride, o);
    if (!g) { flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} says they're with ${who_(o)}, but they're already in different groups — check`); return; }
    joined.push(o);
  });
  if (p.unknown.length && joined.length) flag_(tx, GROUP_FLAG, ride.id, ride.phone10, body, `${who_(ride)} also named ${p.unknown.join(', ')}, who has no ride near theirs — grouped with ${joined.map(x => x.first).join(', ')} only`);
  if (joined.length) {
    const names = joined.map(x => x.first);
    logRow_({ dir: 'note', phone: ride.phone10, rideId: ride.id, row: ride.row, name: ride.first, note: `Group: with ${joined.map(who_).join(', ')} (they named them)` });
    // the caller sends it (or adds it to "you're confirmed" when this same text was their YES)
    if (tpl.groupJoined) rec.groupJoinedText = fill_(tpl.groupJoined, ride, '', { names: names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] });
  }
  return 'used';
}
/** For the dashboard: r's group (letter, the others, and whether each told us themselves). */
function groupView_(tx, rides, id) {
  const g = groupOf_(tx, id);
  if (!g) return null;
  const members = g.rides.map(rid => { const x = rides.find(y => y.id === rid) || {}; const rec = tx.rides[rid] || {}; return { id: rid, first: x.first || rec.first || '?', row: x.row || rec.row || '', said: !!g.said[rid] }; });
  return { letter: g.letter || '', both: members.every(x => x.said), members };
}

// ---------- ETA log: what we predicted vs what happened (to refit etaMinutes_) ----------
// A ride seen while still open, within 15 min of its request, gets a row with the model's inputs at that moment and
// its prediction; the text's quoted range is added when one goes out; when the ride ends, its Call Time, Arrival, the
// real wait (Arrival − request) and the error. No names or phone numbers. Local: <state>/eta.json, dashboard ▸ /eta.csv.
const ETA_HEAD = ['Night', 'Row', 'Requested', 'Seen', 'Ahead', 'Line', 'Arrivals/min (30 min)', 'Crews', 'Predicted min', 'Shown',
  'Quoted in text', 'ADA', 'Pick-up', 'Drop-off', 'Call', 'Arrival', 'Wait min', 'Outcome', 'Error min', 'Model'];
const ETA_LOG_FRESH_MIN = 15;
function etaSheet_() {
  const props = SP_();
  let ss = null;
  let id = props.getProperty('ETA_SHEET_ID');
  if (id && id === props.getProperty('TEXTS_SHEET_ID')) id = ''; // never the message log (an older server stand-in handed that out)
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss || ss.getId() === props.getProperty('TEXTS_SHEET_ID')) {
    ss = SpreadsheetApp.create('SURE Walk ETA');
    props.setProperty('ETA_SHEET_ID', ss.getId());
    const sh = ss.getSheets()[0];
    sh.setName('ETA');
    sh.getRange(1, 1, 1, ETA_HEAD.length).setValues([ETA_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return ss.getSheetByName('ETA') || ss.getSheets()[0];
}
// "H:MM" on the ride's night -> ms (after midnight = the next day).
function etaClockMs_(tsMs, hm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '').trim());
  if (!m) return null;
  const d = new Date(tsMs); d.setHours(+m[1], +m[2], 0, 0);
  let t = d.getTime();
  if (t < tsMs - 6 * 3600e3) t += 864e5; // past midnight
  return t;
}
function etaLog_(tx, rides, wait) {
  const now = Date.now(), fmt = ms => Utilities.formatDate(new Date(ms), CFG.TZ, 'yyyy-MM-dd HH:mm');
  let sh = null;
  const S = () => sh || (sh = etaSheet_());
  // crews working lately: on an open ride, or arrived somewhere in the last 45 min
  const crews = new Set();
  rides.forEach(r => {
    if (!r.driver || r.state === 'cancelled' || r.state === 'dup') return;
    const a = etaClockMs_(r.tsMs, r.arrived);
    if (r.state === 'open' || (a && now - a <= 45 * 60e3)) crews.add(norm_(r.driver));
  });
  rides.forEach(r => {
    const rec = tx.rides[r.id];
    if (!rec) return;
    const e = rec.eta;
    if (!e) {
      if (r.state !== 'open' || r.dupOf || r.arrived || now - r.tsMs > ETA_LOG_FRESH_MIN * 60e3) { rec.eta = { skip: 1 }; return; }
      const pred = etaMinutes_(wait, r);
      const ahead = (wait.line || []).filter(o => o.id !== r.id && o.tsMs < r.tsMs).length;
      const row = S().getLastRow() + 1;
      S().getRange(row, 1, 1, ETA_HEAD.length).setValues([[nightKey_(new Date(r.tsMs)), r.row, fmt(r.tsMs), fmt(now), ahead, (wait.line || []).length,
        Math.round((wait.rate || 0) * 1000) / 1000, crews.size, pred == null ? '' : Math.round(pred * 10) / 10, etaText_(wait, r).replace(/^about /, ''),
        '', r.ada ? 'Yes' : 'No', r.pickupName || r.pickup, r.dropoffName || r.dropoff, '', '', '', '', '', `${ETA_A} + ${ETA_B}·ahead/√rate`]]);
      rec.eta = { row, pred, book: SP_().getProperty('ETA_SHEET_ID') };
      return;
    }
    if (!e.row || e.done) return;
    if (e.book !== SP_().getProperty('ETA_SHEET_ID')) { e.done = 1; return; } // its row is in another (old) log: leave it
    if (rec.etaQuote && !e.q) { S().getRange(e.row, 11).setValue(rec.etaQuote.replace(/^about /, '')); e.q = 1; }
    let out = '';
    const arr = etaClockMs_(r.tsMs, r.arrived);
    if (arr && arr >= r.tsMs - 60e3 && arr - r.tsMs <= 4 * 3600e3) out = 'arrived';
    else if (r.state === 'cancelled') out = 'cancelled' + (r.reason ? ': ' + r.reason : '');
    else if (r.state === 'dup') out = 'duplicate';
    if (!out) return;
    const w = out === 'arrived' ? Math.round((arr - r.tsMs) / 6e3) / 10 : '';
    S().getRange(e.row, 15, 1, 5).setValues([[r.call, r.arrived, w, out, w === '' || e.pred == null ? '' : Math.round((w - e.pred) * 10) / 10]]);
    e.done = 1;
  });
}

// We stop taking rides at 2:00 AM: a request submitted from 2:00 AM until noon is after the deadline.
const DEADLINE_MIN = 2 * 60;
function afterDeadline_(tsMs) {
  const d = new Date(tsMs), t = Number(Utilities.formatDate(d, CFG.TZ, 'H')) * 60 + Number(Utilities.formatDate(d, CFG.TZ, 'm'));
  return t >= DEADLINE_MIN && t < 12 * 60;
}
// Rides start at 7:00 PM: a request submitted between noon and 7:00 PM came in before we open.
const RIDES_START_MIN = 19 * 60;
function beforeStart_(tsMs) {
  const d = new Date(tsMs), t = Number(Utilities.formatDate(d, CFG.TZ, 'H')) * 60 + Number(Utilities.formatDate(d, CFG.TZ, 'm'));
  return t >= 12 * 60 && t < RIDES_START_MIN;
}
// A dispatcher already has this rider: their name in Dispatch (B), a Call Time (C), or a crew (O/P).
const handled_ = r => !!(r.dispatcher || r.call || r.driver);
// "Called by C. Chapa · Assigned to Rachel / Moses · Call Time 22:41" — why a ride isn't waiting for a text.
function handledNote_(r) {
  const crew = [r.driver, r.nav].filter(Boolean).join(' / ');
  return [r.dispatcher ? 'Called by ' + r.dispatcher : '', crew ? 'Assigned to ' + crew : '', r.call ? 'Call Time ' + r.call : '']
    .filter(Boolean).join(' · ') + ' — not texted';
}

// ---------- replies ----------
/**
 * What a rider's reply means. awaiting = we asked them to reply YES (so "ok" / "sounds good" / 👍 count as yes).
 * yes | cancel | no | eta | stop | start | thanks | other ; extra = they also wrote more than a plain answer.
 */
// An iPhone tapback / Android reaction sent as text: 'Loved “Got it Annika…”', 'Liked "…"', 'Reacted 👍 to "…"'.
// Newer iPhones send any emoji reaction as '❤️ to "…"' / '😂 to "…"'.
const REACTION_RE = /^(loved|liked|disliked|laughed at|emphasi[sz]ed|questioned|removed an? .{1,20} from|reacted .{1,12} to|[^\sA-Za-z0-9]{1,8}\s*to)\s*[“"'‘]/iu;
// "yes" typed with one slip: a key next to it ("tes", "ues", "yrs", "yed"), one extra letter ("yesa", "yees") or two
// letters swapped ("yse", "eys"). Only used when we asked for YES and the whole reply is that one word.
const KEY_NEAR_ = { y: 'tugh', e: 'wrds', s: 'awedzx' };
function yesTypo_(w) {
  w = String(w || '').toLowerCase();
  if (!/^[a-z]{2,5}$/.test(w) || w === 'yes' || ['tea', 'yet', 'ye', 'see', 'use', 'ugh'].includes(w)) return false;
  if (w.length === 3 && [...w].filter((ch, i) => ch !== 'yes'[i]).length === 1 && [...w].every((ch, i) => ch === 'yes'[i] || KEY_NEAR_['yes'[i]].includes(ch))) return true;
  if (w.length === 4 && [0, 1, 2, 3].some(i => w.slice(0, i) + w.slice(i + 1) === 'yes')) return true;
  return ['yse', 'eys', 'ysee'].includes(w);
}
// "where" asks for the ETA only when it's about the driver / ride: "where's my driver", "where are you", "where y'all at".
// Not when they don't know a place ("idk where that is", "where is that?") or ask where to go ("where do I wait") —
// those go to Needs a look for a person to answer.
function whereEta_(t) {
  if (!/\bwhere\b/.test(t)) return false;
  if (/\b(idk|dunno|i don'?t know|i do not know|dont know|not sure|no idea|unsure|confused|lost)\b.*\bwhere\b/.test(t)) return false;
  if (/\bwhere(('?s| is| exactly)? (that|this|it|is that|is this)\b|abouts\b)/.test(t)) return false;
  if (/\bwhere (do|should|can|am|will|would) (i|we)\b|\bwhere (to|i'?m|im|we'?re)\b/.test(t)) return false;
  // the next few words name the driver / ride: "where (is) (my|the) driver", "where are you", "where y'all at"
  const next = (t.split(/\bwhere\b/)[1] || '').replace(/[^a-z' ]/g, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
  return /\b(driver|drivers|ride|car|van|cart|crew|you|u|ya|y'?all|yall|they|them|he|she|surewalk|sure walk)\b/.test(next);
}
function classify_(text, awaiting) {
  const raw = String(text || '').trim(), t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
  // A reaction to one of our texts. positive = Loved / Liked / Emphasized / Laughed at / ❤️ / 👍…; not Disliked, Questioned, 👎, ❓.
  if (REACTION_RE.test(raw)) return { intent: 'reaction', positive: !/^(disliked|questioned|removed)\b|^\s*(👎|❓|❔)/iu.test(raw) };
  const words = t.replace(/[^a-z0-9' ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (/^(stop|stop all|unsubscribe|end|quit|opt out|optout)[.!]*$/.test(t)) return { intent: 'stop' };
  if (/^(start|unstop)[.!]*$/.test(t)) return { intent: 'start' };
  const negCancel = /\b(don'?t|do not|didn'?t|not|no need to)\s+cancel/.test(t);
  if (!negCancel && /\b(cancel+(ed|led|ing)?|cancell?ation|nvm|never ?mind|no longer need|don'?t need (it|a ride|the ride|one)|not needed anymore|found a ride|got a ride|getting a ride|have a ride now|uber|lyft|i'?ll walk|walking (home|back)|already home|made it home)\b/.test(t))
    return { intent: 'cancel', extra: words.length > 12 };
  const yesWord = /^(y|ya|yah|yas|yes+|yeah+|yea|yep|yup|ye|yess+|confirm(ed)?|correct|sure|absolutely|definitely|si)\b/;
  const yesEmoji = /^(👍|✅|👌|🙏|❤️|💯)/u;
  if (yesWord.test(t) || yesEmoji.test(raw)) return { intent: 'yes', extra: words.length > 6 || /\?/.test(t) };
  if (awaiting && words.length === 1 && yesTypo_(words[0])) return { intent: 'yes' }; // "TES", "UES", "YESA" when we asked for YES
  if (/^(no|nope|nah|n)[.!]*$/.test(t)) return { intent: 'no' };
  if (whereEta_(t) || /\b(how long|how much longer|eta|when (will|is|are|do)|still coming|on (the|their|his|her) way|wait time|coming soon|how many min|how close|how far|any updates?|still waiting|estimated? time|time estimate)/.test(t)) return { intent: 'eta' };
  const okish = /^(ok(ay)?|k+|kk|sounds good|alright|aight|bet|cool|perfect|great|got it|will do)[.!]*$/.test(t);
  if (okish && awaiting) return { intent: 'yes' };
  // "Okay - I'm with Sam", "ok sounds good, my friend is coming too" when we asked for YES: a YES, with more to read.
  if (awaiting && /^(ok(ay)?|kk?|sounds good|alright|bet|cool|perfect|great|got it)\b/.test(t) && !/\?/.test(t)) return { intent: 'yes', extra: true };
  // "thanks", "thank you so much!", "ty!!", "appreciate it" — short only (a longer message after "thanks" is read by a person).
  if (okish || (/^(thanks?|thank (you|u)|ty|thx|tysm|appreciate (it|you))\b/.test(t) && t.length <= 30 && !/\?/.test(t)) || /^(👍|🙏|❤️|😊|🙂)+$/u.test(raw)) return { intent: 'thanks' };
  return { intent: 'other' };
}

/** One incoming text: {id, from, text, ts}. Writes to the sheet for YES (Call Time) and CANCEL. */
function handleInbound_(tx, m, rides, wait, sh) {
  const from10 = phone10_(m.from), tpl = templates_(), ms = m.ts ? Number(m.ts) : Date.now();
  const inMsg = { id: 'i' + m.id, ts: ms, dir: 'in', phone: from10 || String(m.from), body: String(m.text || '').slice(0, 1000), rideId: '', intent: '' };
  tx.msgs.push(inMsg);
  const mine = from10 ? rides.filter(r => r.phone10 === from10) : [];
  const open = mine.filter(r => r.state === 'open' && !['duplicate', 'cancelled'].includes((tx.rides[r.id] || {}).state));
  // Several open rides that are copies of one request count as one (the original).
  const distinct = open.filter(r => !r.dupOf);
  // A reply goes with the ride we texted them about (e.g. not the "Updated request?" one we held back).
  const texted = distinct.filter(r => ['queued', 'texted', 'confirmed', 'asking'].includes((tx.rides[r.id] || {}).state));
  // Several rides texted (e.g. a second trip the same night): the reply answers the one we texted most recently.
  const lastOut = id => Math.max(0, ...tx.msgs.filter(x => x.dir === 'out' && x.rideId === id).map(x => x.ts));
  const latest = texted.length > 1 ? texted.slice().sort((a, b) => lastOut(b.id) - lastOut(a.id))[0] : null;
  const ride = distinct.length === 1 ? distinct[0] : texted.length === 1 ? texted[0] : latest || (!distinct.length && open.length ? open[0] : null);
  const rec = ride && tx.rides[ride.id];
  const awaiting = !!rec && ['texted', 'queued'].includes(rec.state);
  const c = classify_(m.text, awaiting);
  // A positive reaction (Loved / Liked / ❤️ / 👍…) to the text we asked them to answer counts as their YES.
  if (c.intent === 'reaction' && c.positive && rec && (awaiting || rec.change || rec.adaAsk)) c.intent = 'yes';
  inMsg.intent = c.intent;
  logRow_({ dir: 'in', phone: inMsg.phone, rideId: ride ? ride.id : '', row: ride ? ride.row : '', name: ride ? ride.first : '', body: inMsg.body, intent: c.intent });

  // 📋 An open poll takes their answers — CANCEL, STOP, "where's my driver?" and reactions go on as usual.
  const pollOf = from10 && !['cancel', 'stop', 'start', 'eta', 'reaction'].includes(c.intent) ? pollRecOf_(tx, from10) : null;
  if (pollOf && pollAnswer_(tx, pollOf[0], pollOf[1], m.text)) {
    inMsg.intent = 'poll';
    if (rec) rec.lastInAt = ms;
    return;
  }

  if (c.intent === 'reaction') { // other tapbacks need nothing from anyone — but they do count as a reply (no "No reply")
    if (rec) { rec.lastInAt = ms; rec.lastIntent = 'reaction'; }
    return;
  }
  if (c.intent === 'stop') {
    if (from10) setOptOut_(from10, true);
    mine.forEach(r => { if (tx.rides[r.id]) tx.rides[r.id].state = 'optedout'; });
    if (from10) queue_(tx, { phone10: from10, id: ride ? ride.id : '' }, tpl.optout, 'optout');
    return;
  }
  if (c.intent === 'start') { if (from10) setOptOut_(from10, false); return; }
  if (!from10 || !mine.length) { flag_(tx, 'Unknown number', '', inMsg.phone, inMsg.body, 'Not a rider tonight'); return; }
  inMsg.rideId = (ride || mine[mine.length - 1]).id;
  if (!ride) {
    const last = mine[mine.length - 1];
    // Remember the reply on that ride anyway (it can be reopened; and it's no longer "No reply").
    const lrec = tx.rides[last.id];
    if (lrec) { lrec.lastInAt = ms; lrec.lastIntent = c.intent; if (c.intent === 'yes') lrec.saidYes = true; }
    if (c.intent === 'cancel' && open.length) {
      // Rider texted CANCEL when multiple open rides exist: cancel all un-assigned open rides!
      let cancelledCount = 0;
      open.filter(r => !r.driver).forEach(r => {
        try {
          cancelRow_(sh, rowOf_(sh, r), cancelReason_(m.text));
          const rrec = tx.rides[r.id] || (tx.rides[r.id] = { row: r.row, first: r.first, phone10: from10 });
          rrec.state = 'cancelled'; rrec.note = 'Cancelled by text: ' + cancelReason_(m.text);
          dropQueued_(tx, r.id, 'Not sent — rider cancelled');
          cancelledCount++;
        } catch (e) {}
      });
      if (cancelledCount > 0) {
        queue_(tx, { phone10: from10, id: last.id }, fill_(tpl.cancelled, last), 'cancelled');
        tx.flags.filter(f => f.phone === from10 && f.kind === 'Updated request?' && !f.done).forEach(f => { f.done = true; });
        return;
      }
    }
    if (distinct.length > 1) { flag_(tx, 'Which ride?', '', from10, inMsg.body, `${distinct.map(r => `row ${r.row} (${r.pickupName} → ${r.dropoffName})`).join(', ')} are all open for this number`); return; }
    // A yes / no / thanks / cancel to a ride that's already picked, cancelled or marked duplicate needs nothing from anyone.
    if (!['thanks', 'yes', 'no', 'cancel'].includes(c.intent)) flag_(tx, last.state === 'picked' ? 'After pickup' : 'Ride closed', last.id, from10, inMsg.body,
      `${last.first} (row ${last.row}) is ${last.state === 'picked' ? 'already picked up' : last.state === 'dup' ? 'marked duplicate' : last.state}`);
    return;
  }
  rec.lastInAt = ms; rec.lastIntent = c.intent; if (c.intent === 'yes') rec.saidYes = true;

  // We asked "change your pickup to X?": YES updates the sheet and confirms; anything but CANCEL / STOP goes to you.
  if (rec.change && !['cancel', 'stop'].includes(c.intent) && Date.now() - rec.change.at < 60 * 60e3) {
    const ch = rec.change; delete rec.change;
    const yes = c.intent === 'yes' || classify_(m.text, true).intent === 'yes';
    if (!yes) { flag_(tx, 'Pickup change?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) asked to change the ${ch.which} to ${ch.place} but didn't confirm — check with them`); return; }
    try {
      const row = rowOf_(sh, ride);
      assertEditable_(sh, row);
      sh.getRange(row, ch.field === 'pickup' ? COL.PICKUP : COL.DROPOFF).setValue(ch.place);
      try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
      logRow_({ dir: 'note', phone: from10, rideId: ride.id, row: ride.row, name: ride.first, note: `${ch.which} → ${ch.place} (they confirmed by text)` });
      if (!['confirmed'].includes(rec.state)) { rec.state = 'confirmed'; rec.confirmedAt = rec.confirmedAt || ms; }
      queue_(tx, ride, fill_(tpl.changeDone, ride, '', { which: ch.which, place: ch.place }), 'changeDone');
    } catch (e) { flag_(tx, 'Pickup change?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) confirmed changing the ${ch.which} to ${ch.place}, but the sheet couldn't be updated: ${e.message}`); }
    return;
  }
  // "Can you pick me up at Jester West instead?" — a place we know: ask them to confirm the change.
  if (c.intent === 'other' || c.intent === 'eta') {
    const ch = parseChange_(m.text);
    if (ch) {
      const which = ch.field === 'pickup' ? 'pickup' : 'drop-off';
      if (ride.driver) { flag_(tx, 'Pickup change?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) wants the ${which} changed to ${ch.place}, but ${[ride.driver, ride.nav].filter(Boolean).join(' / ')} already has the ride — update it and tell the crew`); return; }
      if (ch.field === 'pickup' && offCampusPickup_(ch.place)) { flag_(tx, 'Pickup change?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) wants to be picked up at ${ch.place}, which isn't a pickup spot`); return; }
      rec.change = { field: ch.field, which, place: ch.place, at: Date.now() };
      queue_(tx, ride, fill_(tpl.changeAsk, ride, '', { which, place: ch.place }), 'changeAsk');
      return;
    }
  }

  // We asked "which Moody?": their answer fixes the sheet, then they get the confirmation.
  if (rec.state === 'asking' && !['cancel', 'stop'].includes(c.intent)) {
    const place = moodyAnswer_(m.text);
    if (!place) { flag_(tx, 'Which Moody?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) — couldn't tell Moody Center from DMC in their reply. Fix the ${rec.ask === 'pickup' ? 'pickup' : 'drop-off'} in the sheet and send the confirmation.`); return; }
    try { resolveMoody_(tx, ride, rec, place, sh, wait); }
    catch (e) { flag_(tx, 'Which Moody?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) said ${place}, but the sheet couldn't be updated: ${e.message}`); }
    return;
  }

  // We asked an ADA rider to confirm: NO = they don't need ADA (cleared in the sheet) and they're confirmed.
  if (rec.adaAsk && c.intent === 'no') {
    delete rec.adaAsk;
    try {
      const row = rowOf_(sh, ride);
      assertEditable_(sh, row);
      sh.getRange(row, COL.ADA).setValue('No');
      try { CacheService.getScriptCache().removeAll(['rides', 'state_view']); } catch (e) { /* best-effort */ }
      logRow_({ dir: 'note', phone: from10, rideId: ride.id, row: ride.row, name: ride.first, note: 'ADA → No (they replied NO)' });
      Object.assign(rec, { state: 'confirmed', confirmedAt: rec.confirmedAt || ms, saidYes: true });
      queue_(tx, ride, fill_(tpl.adaNo, ride), 'confirmed');
      maybePoll_(tx, ride, rec); // 📋 poll (at most once ever)
    } catch (e) { flag_(tx, 'ADA?', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) says they don't need ADA, but the sheet couldn't be updated: ${e.message}`); }
    return;
  }
  // 👥 Who they're riding with: an answer to our group question, or "Okay - I'm with Sam" (see groupReply_).
  if (!['cancel', 'stop', 'start', 'eta'].includes(c.intent)) {
    const asked = !!rec.groupAsk && !rec.groupAnswer && ms - rec.groupAsk.at < GROUP_LISTEN_MIN * 60e3;
    const g = groupReply_(tx, rides, ride, rec, m.text, asked, tpl);
    const joinedText = rec.groupJoinedText || ''; delete rec.groupJoinedText;
    if (g === 'done' || (g === 'used' && (c.intent !== 'yes' || rec.state === 'confirmed'))) {
      inMsg.intent = 'group';
      if (joinedText) queue_(tx, ride, joinedText, 'groupJoined');
      return;
    }
    if (joinedText) rec.groupJoinedLater = joinedText;
    if (g === 'used') c.extra = false; // their YES still confirms them below; the rest of the text was about the group
  }
  if (c.intent === 'yes') {
    const already = rec.state === 'confirmed';
    rec.state = 'confirmed'; rec.confirmedAt = rec.confirmedAt || ms;
    // Multiple rides under one phone: if there were other open duplicate requests for this phone (same route),
    // mark them duplicate in the sheet and resolve their flags so they don't linger as open ghost rides!
    if (from10) {
      const dupRides = rides.filter(x => x.id !== ride.id && x.phone10 === from10 && x.state === 'open' && !x.driver && routeRelation_(ride, x) === 'same');
      dupRides.forEach(d => {
        try {
          sh.getRange(rowOf_(sh, d), 1, 1, sh.getMaxColumns()).setBackground(DUPLICATE_COLOR);
          const drec = tx.rides[d.id] || (tx.rides[d.id] = { row: d.row, first: d.first, phone10: from10 });
          drec.state = 'duplicate'; drec.note = `Duplicate of row ${ride.row} (confirmed)`;
          dropQueued_(tx, d.id, 'Not sent — duplicate of confirmed ride');
        } catch (e) {}
      });
      tx.flags.filter(f => f.phone === from10 && f.kind === 'Updated request?' && !f.done && dupRides.some(d => d.id === f.rideId)).forEach(f => { f.done = true; });
    }
    if (already) { // "Sure" / "ok" to something else after they confirmed: no second "you're confirmed!"
      if (c.extra) flag_(tx, 'Reply', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}): ${inMsg.body}`);
      return;
    }
    const groupLine = rec.groupJoinedLater || groupAskFor_(tx, rides, ride, rec, tpl); // 👥 others asked for the same pickup just now
    delete rec.groupJoinedLater;
    queue_(tx, ride, fill_(rec.adaAsk ? tpl.confirmedAda : tpl.confirmed, ride, etaText_(wait, ride)) + (groupLine ? ' ' + groupLine : ''), 'confirmed');
    delete rec.adaAsk;
    maybePoll_(tx, ride, rec); // 📋 poll (at most once ever)
    if (c.extra) flag_(tx, 'Confirmed + more', ride.id, from10, inMsg.body, `${ride.first} confirmed but wrote more — read it`);
    return;
  }
  if (c.intent === 'cancel') {
    const crew = [ride.driver, ride.nav].filter(Boolean).join(' / ');
    try {
      cancelRow_(sh, rowOf_(sh, ride), cancelReason_(m.text));
      rec.state = 'cancelled'; rec.note = 'Cancelled by text: ' + cancelReason_(m.text);
      queue_(tx, ride, fill_(tpl.cancelled, ride), 'cancelled');
      if (crew) flag_(tx, 'Cancelled — tell the crew', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}) was already assigned to ${crew}. Tell them in GroupMe.`).urgent = true;
      else if (c.extra) flag_(tx, 'Cancelled + more', ride.id, from10, inMsg.body, `${ride.first} cancelled but wrote more — read it`);

      // Multiple rides under one phone: also cancel any other open un-assigned rides for this phone,
      // so duplicate/updated rows aren't left behind as open ghost rides in the sheet, and won't get auto-texted!
      if (from10) {
        const otherOpen = open.filter(x => x.id !== ride.id && !x.driver);
        otherOpen.forEach(o => {
          try {
            cancelRow_(sh, rowOf_(sh, o), cancelReason_(m.text));
            const orec = tx.rides[o.id] || (tx.rides[o.id] = { row: o.row, first: o.first, phone10: from10 });
            orec.state = 'cancelled';
            orec.note = `Cancelled by text (same phone as row ${ride.row}): ` + cancelReason_(m.text);
            dropQueued_(tx, o.id, 'Not sent — rider cancelled');
            logRow_({ dir: 'note', phone: from10, rideId: o.id, row: o.row, name: o.first, note: `Also cancelled row ${o.row} (same phone as row ${ride.row})` });
          } catch (e) {}
        });
        tx.flags.filter(f => f.phone === from10 && f.kind === 'Updated request?' && !f.done).forEach(f => { f.done = true; });
      }
    } catch (e) { flag_(tx, "Couldn't cancel", ride.id, from10, inMsg.body, e.message); }
    return;
  }
  if (c.intent === 'no') { queue_(tx, ride, fill_(tpl.askCancel, ride), 'askCancel'); return; }
  if (c.intent === 'eta') { queue_(tx, ride, fill_(tpl.eta, ride, etaText_(wait, ride)), 'eta'); return; }
  if (c.intent === 'thanks') return;
  flag_(tx, 'Reply', ride.id, from10, inMsg.body, `${ride.first} (row ${ride.row}): ${inMsg.body}`);
}

// ---------- 📋 Rider poll ----------
/*
 * After a rider is confirmed, a 3-question poll by text (one question at a time; SKIP stops it).
 * Off by default (Settings toggle TX_POLL); when on, sent to confirmed riders at most ONCE EVER per phone number.
 * Answers go to the "SURE Walk Poll" spreadsheet with NO personal data: only the night's date and the answers
 * (no name, phone, EID, ride, row, or exact time). CANCEL / STOP / "where's my driver?" keep working during the poll.
 */
const POLL_EXPIRE_MIN = 120;                                      // an unfinished poll stops listening after this
function polledEver_() {
  const p = bigGet_('TX_POLLED');
  return Array.isArray(p) ? p : [];
}
function wasPolled_(phone10) {
  if (!phone10) return false;
  return polledEver_().includes(phone10);
}
function markPolled_(phone10) {
  if (!phone10) return;
  const list = polledEver_();
  if (!list.includes(phone10)) {
    list.push(phone10);
    bigSet_('TX_POLLED', list.slice(-50000));
  }
}
function clearPolled_(phone10) {
  if (!phone10) return;
  const list = polledEver_().filter(p => p !== phone10);
  bigSet_('TX_POLLED', list);
}
function maybePoll_(tx, ride, rec) {
  if (!ride.phone10 || !rec) return;
  if (SP_().getProperty('TX_POLL') !== 'true') return; // Settings → Timing: off unless turned on (test polls still work)
  const night = nightKey_(new Date());
  // Never poll the same rider more than once ever
  if (wasPolled_(ride.phone10) || (tx.polled && Array.isArray(tx.polled.phones) && tx.polled.phones.includes(ride.phone10))) {
    markPolled_(ride.phone10);
    return;
  }
  markPolled_(ride.phone10);
  if (!tx.polled || !Array.isArray(tx.polled.phones)) tx.polled = { night, phones: [] };
  if (!tx.polled.phones.includes(ride.phone10)) tx.polled.phones.push(ride.phone10);
  rec.poll = { step: 1, at: Date.now(), night, row: 0, miss: 0, a: {} };
  queue_(tx, ride, templates_().poll_q1, 'poll');
}
// [rideId, rec] of this phone's open poll — it keeps going even after the ride is picked up or closed
function pollRecOf_(tx, phone10) {
  return Object.entries(tx.rides).find(([, r]) => r.poll && r.poll.step && r.phone10 === phone10 && Date.now() - r.poll.at < POLL_EXPIRE_MIN * 60e3) || null;
}
const POLL_Q1_ = [
  [/^\s*1\b|\b(texts?|texting|txt|sms|messages?)\b/i, 'Text'],
  [/^\s*2\b|\b(calls?|calling|phone|ring)\b/i, 'Phone call with ETA'],
  [/^\s*3\s*$/i, 'Other'],
  [/^\s*other\b/i, 'Other'],
];
const POLL_Q2_ = [[/^\s*(y|ya|yes+|yeah+|yea|yep|yup|sure|definitely|absolutely|of course|for sure)\b|^\s*(👍|✅)/iu, 'Yes'],
  [/\b(maybe|idk|not sure|possibly|perhaps|might|depends)\b/i, 'Maybe'], [/^\s*(n|no|nope|nah|not really)\b|^\s*👎/iu, 'No']];
/** A text from someone with an open poll. Returns true when it was a poll answer (nothing else to do). */
function pollAnswer_(tx, rideId, rec, text) {
  const t = String(text || '').trim(), tpl = templates_(), p = rec.poll, to = { phone10: rec.phone10, id: rideId };
  const send = body => queue_(tx, to, body, 'poll');
  p.at = Date.now();
  if (/^skip\b/i.test(t)) { p.status = 'skipped'; p.step = 0; pollSave_(p); send(tpl.poll_thanks); return true; }
  const pick = (list, hint) => {
    const hit = list.find(([re]) => re.test(t));
    if (hit) { p.miss = 0; return hit[1]; }
    if (!p.miss) { p.miss = 1; send(String(tpl.poll_nudge).replace('{hint}', hint)); return null; } // ask once more
    p.miss = 0; return '(unclear)';
  };
  if (p.step === 1) {
    let a = null;
    const hit = POLL_Q1_.find(([re]) => re.test(t));
    if (hit) {
      a = hit[1];
    } else if (/^\s*3\s*[:\-–—]?\s*(.+)$/i.test(t)) {
      const rest = t.replace(/^\s*3\s*[:\-–—]?\s*/i, '').trim();
      a = `Other: ${rest.slice(0, 200)}`;
    } else if (t.length >= 2 && !/^[?.!]+$/.test(t)) {
      // Direct custom idea texted in response to Q1!
      a = `Other: ${t.slice(0, 200)}`;
    } else {
      if (!p.miss) {
        p.miss = 1;
        send(String(tpl.poll_nudge).replace('{hint}', 'reply 1 (text), 2 (call), or text your own idea'));
        return true;
      }
      p.miss = 0;
      a = t ? `Other: ${t.slice(0, 200)}` : '(unclear)';
    }
    p.miss = 0;
    p.a.q1 = a; p.step = 2; pollSave_(p); send(tpl.poll_q2); return true;
  }
  if (p.step === 2) {
    const a = pick(POLL_Q2_, 'reply YES, NO, or MAYBE');
    if (a == null) return true;
    p.a.q2 = a; p.step = 3; pollSave_(p); send(tpl.poll_q3); return true;
  }
  if (p.step === 3) {
    p.a.q3 = t.slice(0, 500); p.step = 0; p.status = 'finished'; pollSave_(p); send(tpl.poll_thanks); return true;
  }
  return false;
}
// The answers sheet: night + answers only. One row per poll, filled in as the answers come.
function pollSheet_() {
  const props = SP_();
  let ss = null;
  const id = props.getProperty('POLL_SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('SURE Walk Poll');
    props.setProperty('POLL_SHEET_ID', ss.getId());
    const sh = ss.getSheets()[0];
    sh.setName('Answers');
    sh.getRange(1, 1, 1, 5).setValues([['Night', 'How to confirm the ride', 'Order rides by texting?', 'Other input', 'Status']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return ss.getSheetByName('Answers') || ss.getSheets()[0];
}
function pollSave_(p) {
  try {
    const sh = pollSheet_(), line = [[p.night, p.a.q1 || '', p.a.q2 || '', p.a.q3 || '', p.status || 'in progress']];
    if (!p.row) { p.row = sh.getLastRow() + 1; }
    sh.getRange(p.row, 1, 1, 5).setValues(line);
  } catch (e) { console.error('poll sheet', e); }
}

// ---------- outbox ----------
function applyResults_(tx, results, sh) {
  (results || []).forEach(res => {
    const o = tx.out.find(x => x.outId === res.outId);
    if (!o || ['sent', 'failed', 'unknown'].includes(o.st)) return;
    // BlueFerry refuses past 30 texts a minute / 200 an hour ("please wait a moment, then try again"). That isn't a
    // failure: the text goes back in line and sending pauses a minute, then it goes out by itself (up to 30 tries).
    if (res.status === 'failed' && RATE_LIMIT_RE.test(String(res.error || '')) && (o.tries || 0) < 30) {
      o.st = 'queued'; o.tries = (o.tries || 0) + 1; o.err = 'phone send limit reached — retrying automatically';
      tx.sendPauseUntil = Date.now() + RATE_PAUSE_MS;
      const qm = tx.msgs.find(x => x.outId === o.outId); if (qm) qm.st = 'queued';
      return;
    }
    o.st = ['sent', 'failed', 'unknown'].includes(res.status) ? res.status : 'unknown';
    o.err = String(res.error || '').slice(0, 300);
    // BlueFerry's "Send failed" is usually wrong — the text went out (checked on the phone, 2026-11-08). Counted as sent,
    // no flag, never resent. A real failure (e.g. phone not connected to the PC) is still flagged.
    if (o.st === 'failed' && /send failed/i.test(o.err)) { o.st = 'sent'; o.err = 'phone reported an error, but it usually still sends'; }
    const msg = tx.msgs.find(x => x.outId === o.outId);
    if (msg) msg.st = o.st;
    const rec = tx.rides[o.rideId];
    if (o.st === 'sent' && ['confirm', 'whichMoody'].includes(o.kind) && rec) {
      if (rec.state === 'queued') { rec.state = 'texted'; rec.textedAt = Date.now(); }
      if (rec.state === 'asking' && !rec.textedAt) rec.textedAt = Date.now();
      // Call Time = when we texted them (only if still blank).
      try {
        const sheet = sh || sheet_(), r = setCallTime_(sheet, rowOf_(sheet, { id: o.rideId, row: rec.row, first: rec.first }), Date.now());
        if (r.set) { rec.note = 'Call Time ' + r.time + ' (texted)'; rec.callSet = r.time; }
      } catch (e) { flag_(tx, "Couldn't set Call Time", o.rideId, o.to, o.body, e.message); }
    }
    if (o.st !== 'sent') flag_(tx, o.st === 'failed' ? 'Text failed' : 'Text may not have sent', o.rideId, o.to, o.body,
      o.st === 'failed' ? o.err || 'The phone refused it' : 'The phone never confirmed it — check the iPhone before resending');
    logRow_({ dir: 'out', phone: o.to, rideId: o.rideId, row: rec ? rec.row : '', name: rec ? rec.first : '', body: o.body, status: o.st, intent: o.kind, note: o.err });
  });
}
// Up to 3 queued texts, leased to the bridge; a lease that runs out with no result is "unknown" (never resent).
function takeOutbox_(tx) {
  const now = Date.now();
  tx.out.forEach(o => {
    if (o.st === 'sending' && o.lease < now) applyResults_(tx, [{ outId: o.outId, status: 'unknown', error: 'no result from the bridge' }]);
  });
  if (!toggle_('TX_TEXTING')) return [];
  if ((tx.sendPauseUntil || 0) > now) return []; // the phone's send limit: wait, then carry on
  // Paced (user, 2026-11-14 — a burst used up the phone's limit and every text failed at once): one text every
  // SEND_GAP_MS, and never more than SEND_PER_HOUR in an hour (BlueFerry refuses past 200). A backlog sends what
  // riders are waiting on first (confirmations, answers, cancel notices); reminders, tips and the poll wait.
  tx.sentTimes = (tx.sentTimes || []).filter(t => t > now - 3600e3);
  if (tx.sentTimes.length && now - tx.sentTimes[tx.sentTimes.length - 1] < SEND_GAP_MS) return [];
  if (tx.sentTimes.length >= SEND_PER_HOUR) return [];
  const queued = tx.out.filter(o => o.st === 'queued');
  const first = queued.filter(o => !LOW_PRIORITY_KINDS.includes(o.kind)).concat(queued.filter(o => LOW_PRIORITY_KINDS.includes(o.kind)));
  const take = first.slice(0, SEND_GAP_MS > 0 ? 1 : 3); // (no gap = tests: up to 3 at once, like before)
  take.forEach(o => { o.st = 'sending'; o.lease = now + LEASE_MS; tx.sentTimes.push(now); const m = tx.msgs.find(x => x.outId === o.outId); if (m) m.st = 'sending'; });
  return take.map(o => ({ outId: o.outId, to: o.to, body: o.body }));
}

// ---------- the Texts spreadsheet (full log) ----------
let LOG_ROWS_ = [];
function logRow_(e) {
  LOG_ROWS_.push([new Date(), nightKey_(new Date()), e.dir, e.phone || '', e.rideId || '', e.row || '', e.name || '',
    e.body || '', e.status || '', e.intent || '', e.note || '']);
}
function flushLog_() {
  if (!LOG_ROWS_.length) return;
  const id = SP_().getProperty('TEXTS_SHEET_ID');
  if (id) {
    try {
      const sh = SpreadsheetApp.openById(id).getSheetByName('Messages');
      sh.getRange(sh.getLastRow() + 1, 1, LOG_ROWS_.length, LOG_ROWS_[0].length).setValues(LOG_ROWS_);
    } catch (e) { console.error('Texts log', e); }
  }
  LOG_ROWS_ = [];
}
