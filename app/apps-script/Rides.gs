/**
 * The master ride sheet, read the same way the dispatch app reads it (helpers copied from its Code.gs so the two
 * apps agree on what a ride, a duplicate, a cancel and the wait time are). This app only WRITES two things there:
 * a rider's cancel (cancelRow_, exactly like the dispatch app) and the Call Time when we text them (setCallTime_).
 */
const FILE_VERSION_RIDES = '2026-11-04h';

const CFG = {
  SPREADSHEET_ID: '1PJrdOZyGD4U9inBKzXrf5p-J_T3-OFwKqwimbBu--Oo', // Master Form 2026-27
  SHEET_INDEX: 0,           // live form-response tab is the first tab
  TZ: 'America/Chicago',
  EDIT_WINDOW_MIN: 60,      // never write to finished rides submitted longer ago than this
  DUP_WINDOW_MIN: 40,       // possible-duplicate check looks back this far
  SCAN_ROWS: 600,           // only look at the newest rows
  LAST_COL: 23,             // A:W
};

const COL = {
  TS: 1, DISPATCH: 2, CALL: 3, ARRIVE: 4, EID: 6, LAST: 7, FIRST: 8, PHONE: 9,
  PICKUP: 10, DROPOFF: 11, ADA: 12, LOC: 13, VAN: 14, DRIVER: 15, NAV: 16, REASON: 22,
};

// A cancel reason is real text in V. The sheet has 0s pre-filled in V below the rides, so 0 / blank = none.
const hasReason_ = v => { const s = String(v == null ? '' : v).trim(); return !!s && s !== '0'; };
const norm_ = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const phone10_ = s => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };

const CANCEL_REASONS = [
  'Chose Alternative Way Home', 'Not Answering', 'Long Wait Time Expected', 'Before Start',
  'Not Ready', 'Not Within Pickup Drop-off Parameters', 'Exceeded 2min Wait', 'After Deadline',
  'Wrong Number', 'Not Grouped with Friends', 'Luggage etc.', 'Other',
];

function sheet_() {
  return SpreadsheetApp.openById(CFG.SPREADSHEET_ID).getSheets()[CFG.SHEET_INDEX];
}

function fmtTime_(date) {
  return Utilities.formatDate(date || new Date(), CFG.TZ, 'H:mm');
}

// Ride rows end at the last form submission (a timestamp with a time); the shift roster sits below.
let LAST_RIDE_CACHE_ = null; // per server call; reset by withLock_
function lastRideRow_(sh) {
  if (LAST_RIDE_CACHE_) return LAST_RIDE_CACHE_;
  const lastRow = sh.getLastRow();
  for (const start of [Math.max(1, lastRow - 999), 1]) {
    const a = sh.getRange(start, COL.TS, lastRow - start + 1, 1).getDisplayValues();
    for (let i = a.length - 1; i >= 0; i--) {
      if (start + i > 1 && /\d{1,2}:\d{2}/.test(a[i][0])) return (LAST_RIDE_CACHE_ = start + i);
    }
    if (start === 1) break;
  }
  return (LAST_RIDE_CACHE_ = 1);
}

// Row colors (same rules as the dispatch app): black = cancelled, red = duplicate, any other real color = picked.
function rgb_(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? m.slice(1).map(h => parseInt(h, 16)) : null;
}
function isBlack_(hex) {
  const c = rgb_(hex);
  return !!c && Math.max(...c) <= 0x50 && Math.max(...c) - Math.min(...c) <= 40;
}
function isRed_(hex) {
  const c = rgb_(hex);
  if (!c || isBlack_(hex)) return false;
  const [r, g, b] = c, max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max !== r || max - min < 25 || (max - min) / max < 0.15) return false;
  const hue = ((g - b) / (max - min)) * 60;
  return hue >= -15 && hue <= 15;
}
function isColored_(hex) {
  const c = rgb_(hex);
  return !!c && !isBlack_(hex) && !isRed_(hex) && Math.max(...c) - Math.min(...c) >= 12;
}
function rowColor_(bgRow) {
  let black = 0, red = 0;
  const colors = {};
  bgRow.forEach(h => {
    h = String(h).toLowerCase();
    if (isBlack_(h)) black++;
    else if (isRed_(h)) red++;
    else if (isColored_(h)) colors[h] = (colors[h] || 0) + 1;
  });
  if (black >= 3) return { kind: 'black' };
  if (red >= 3) return { kind: 'red' };
  const top = Object.keys(colors).sort((a, b) => colors[b] - colors[a])[0];
  return top && colors[top] >= 3 ? { kind: 'color', color: top } : { kind: 'none' };
}
const isPickedRow_ = (color, arrival) => color.kind === 'color' && !!String(arrival || '').trim();

// A dispatch night runs past midnight and rolls over at 2:30am.
const NIGHT_ROLLOVER_MIN = 2 * 60 + 30;
function nightKey_(date) {
  return Utilities.formatDate(new Date(date.getTime() - NIGHT_ROLLOVER_MIN * 60e3), CFG.TZ, 'yyyy-MM-dd');
}

function rideId_(ts, phone, first) {
  const p = String(phone || '').replace(/\D/g, '').slice(-10);
  return (ts instanceof Date ? ts.getTime() : '') + '|' + (p || norm_(first));
}
function rowIdAt_(sh, row) {
  if (!row || row < 2 || row > sh.getLastRow()) return '';
  const rng = sh.getRange(row, 1, 1, COL.PHONE), v = rng.getValues()[0], d = rng.getDisplayValues()[0];
  return rideId_(v[COL.TS - 1], d[COL.PHONE - 1], d[COL.FIRST - 1]);
}
// The ride's row now (rows can move when the sheet is archived or rows are inserted).
function rowOf_(sh, ride) {
  if (rowIdAt_(sh, ride.row) === ride.id) return ride.row;
  const last = lastRideRow_(sh), first = Math.max(2, last - CFG.SCAN_ROWS + 1);
  const rng = sh.getRange(first, 1, last - first + 1, COL.PHONE), v = rng.getValues(), d = rng.getDisplayValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] instanceof Date && rideId_(v[i][0], d[i][COL.PHONE - 1], d[i][COL.FIRST - 1]) === ride.id) return first + i;
  throw new Error(`${ride.first}'s ride isn't in the sheet anymore — nothing was changed.`);
}

// Wait time like column E: Arrival (D) minus Call Time (C).
const WAIT_SAMPLE = 5; // user: the last 5 rides
function waitMinutes_(call, arrive) {
  const p = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const c = p(call), a = p(arrive);
  if (c == null || a == null) return null;
  const w = (a - c + 1440) % 1440;
  return w <= 120 ? w : null;
}
function waitSummary_(waits, rides) {
  const recent = waits.slice().sort((x, y) => y.row - x.row).slice(0, WAIT_SAMPLE);
  const out = { avg: recent.length ? recent.reduce((s, x) => s + x.wait, 0) / recent.length : null, n: recent.length };
  // The line and how fast it moves (used by etaText_): riders still waiting for a crew to get there, oldest first,
  // and crews' arrivals per minute over the last 30 min. Times after midnight count as 24:xx (one night).
  const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const nightMin = m => (m == null ? null : m < 12 * 60 ? m + 1440 : m), d = new Date(), now = nightMin(d.getHours() * 60 + d.getMinutes());
  const list = rides || [];
  out.rate = list.filter(r => { const a = nightMin(hm(r.arrived)); return a != null && a <= now && a > now - 30 && r.state !== 'dup'; }).length / 30;
  out.line = list.filter(r => r.state === 'open' && !r.dupOf && hm(r.arrived) == null).map(r => ({ id: r.id, tsMs: r.tsMs }))
    .sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

/**
 * Tonight's rides, every state (open / picked / cancelled / dup), newest last, with the dispatch app's duplicate rule:
 * an earlier request within DUP_WINDOW_MIN with the identical pickup and drop-off text, the same first + last name AND
 * the same phone — never against cancelled or red rows.
 */
function tonightRides_() {
  const sh = sheet_(), last = lastRideRow_(sh), first = Math.max(2, last - CFG.SCAN_ROWS + 1);
  const rng = sh.getRange(first, 1, last - first + 1, CFG.LAST_COL);
  const vals = rng.getValues(), disp = rng.getDisplayValues(), bgs = rng.getBackgrounds();
  const night = nightKey_(new Date()), rides = [], prior = [], waits = [];
  const same = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  vals.forEach((r, i) => {
    const ts = r[COL.TS - 1];
    if (!(ts instanceof Date) || nightKey_(ts) !== night) return;
    const get = c => String(disp[i][c - 1]).trim(), color = rowColor_(bgs[i]);
    const state = hasReason_(get(COL.REASON)) || color.kind === 'black' ? 'cancelled' : color.kind === 'red' ? 'dup'
      : isPickedRow_(color, get(COL.ARRIVE)) ? 'picked' : 'open';
    const ride = {
      row: first + i, id: rideId_(ts, get(COL.PHONE), get(COL.FIRST)), tsMs: ts.getTime(), time: fmtTime_(ts),
      first: get(COL.FIRST), last: get(COL.LAST), phone: get(COL.PHONE), phone10: phone10_(get(COL.PHONE)),
      pickup: get(COL.PICKUP), dropoff: get(COL.DROPOFF), ada: /yes/i.test(get(COL.ADA)),
      pickupName: canonPlace_(get(COL.PICKUP)) || get(COL.PICKUP), dropoffName: canonPlace_(get(COL.DROPOFF)) || get(COL.DROPOFF),
      offPickup: offCampusPickup_(get(COL.PICKUP)), dropoffOnly: dropoffOnly_(get(COL.PICKUP)),
      driver: get(COL.DRIVER), nav: get(COL.NAV), call: get(COL.CALL), arrived: get(COL.ARRIVE),
      dispatcher: get(COL.DISPATCH), // a dispatcher's name in B = they've called / taken this rider
      reason: hasReason_(get(COL.REASON)) ? get(COL.REASON) : '', state, dupOf: null,
    };
    if (state !== 'cancelled' && state !== 'dup') {
      const me = { route: same(ride.pickup) + '>' + same(ride.dropoff), phone: ride.phone10, name: norm_(ride.first + ride.last) };
      const dup = me.phone && me.name.length > 3 ? prior.filter(q => q.ts >= ride.tsMs - CFG.DUP_WINDOW_MIN * 60e3 &&
        q.route === me.route && q.phone === me.phone && q.name === me.name).pop() : null;
      if (dup) ride.dupOf = { row: dup.row, id: dup.id, first: dup.first, time: dup.time };
      prior.push(Object.assign({ ts: ride.tsMs, row: ride.row, id: ride.id, first: ride.first, time: ride.time }, me));
    }
    const w = waitMinutes_(ride.call, ride.arrived);
    if (w != null) waits.push({ row: ride.row, wait: w });
    rides.push(ride);
  });
  return { rides, wait: waitSummary_(waits, rides) };
}

// Finished rows older than the edit window are never touched (same guard as the dispatch app).
function assertEditable_(sh, row) {
  const ts = sh.getRange(row, COL.TS).getValue();
  if (!(ts instanceof Date)) throw new Error(`Row ${row} isn't a ride — not editing it.`);
  const kind = rowColor_(sh.getRange(row, 1, 1, CFG.LAST_COL).getBackgrounds()[0]).kind;
  if (kind === 'black' || kind === 'red') {
    throw new Error(`Row ${row} is marked ${kind === 'red' ? 'duplicate (red)' : 'cancelled (black)'} — not editing it.`);
  }
  const open = !(kind === 'color' && String(sh.getRange(row, COL.ARRIVE).getDisplayValue()).trim()) &&
    !hasReason_(sh.getRange(row, COL.REASON).getDisplayValue()) && nightKey_(ts) === nightKey_(new Date());
  if (!open && ts.getTime() < Date.now() - CFG.EDIT_WINDOW_MIN * 60e3) {
    throw new Error(`Row ${row} is finished and older than ${CFG.EDIT_WINDOW_MIN} min — not editing it.`);
  }
}

// Cancel exactly like the dispatch app: clear B–D and M–P, reason in V, whole row black with white text.
function cancelRow_(sh, row, reason) {
  assertEditable_(sh, row);
  sh.getRange(row, COL.DISPATCH, 1, 3).clearContent();
  sh.getRange(row, COL.LOC, 1, 4).clearContent();
  sh.getRange(row, COL.REASON).setValue(reason);
  sh.getRange(row, 1, 1, sh.getMaxColumns()).setBackground('#000000').setFontColor('#ffffff');
}

/**
 * We texted the rider their confirmation: that time goes in Call Time (C) — only if C is still blank, so a resend or a
 * ride a dispatcher already called keeps its Call Time. The dispatch app only fills C when it's blank, so it keeps
 * this value too. Returns what happened.
 */
function setCallTime_(sh, row, whenMs) {
  assertEditable_(sh, row);
  const c = String(sh.getRange(row, COL.CALL).getDisplayValue()).trim();
  if (c) return { set: false, why: 'Call Time already ' + c };
  const t = fmtTime_(new Date(whenMs));
  sh.getRange(row, COL.CALL).setValue(t);
  return { set: true, time: t };
}

/** The ride got a crew while we waited for their reply: Call Time = the assign time, replacing the time we texted
 *  (`ours`) — never a time someone else wrote. Returns the new time or ''. */
function setCallTimeAssigned_(sh, row, whenMs, ours) {
  assertEditable_(sh, row);
  const c = String(sh.getRange(row, COL.CALL).getDisplayValue()).trim();
  if (c && c !== ours) return '';
  const t = fmtTime_(new Date(whenMs));
  if (c !== t) sh.getRange(row, COL.CALL).setValue(t);
  return t;
}

// Same mapping as the dispatch app's driver-message cancels.
function cancelReason_(text) {
  const t = String(text).toLowerCase();
  if (/not ready/.test(t)) return 'Not Ready';
  if (/uber|lyft|walk(ed|ing)?|got a ride|found a ride|another ride|friend|bus|alternative|getting a ride|drive me|driving/.test(t)) return 'Chose Alternative Way Home';
  if (/too long|long wait|taking (so|too) long|wait(ing)? (is )?too/.test(t)) return 'Long Wait Time Expected';
  return 'Other';
}
