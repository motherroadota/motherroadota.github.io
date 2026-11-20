/**
 * Mother Road On The Air (MROTA) - Google hookup
 * ------------------------------------------------
 * Lives in the MROTA Google account (mrota.ota@gmail.com) as an Apps Script project,
 * next to mrota_core.gs (the engine). Set up on hookup day.
 *
 * What it does:
 *  1. Upload right on the MROTA website (like POTA): the activator picks a log, the site shows a
 *     PREVIEW first (what will count, what gets skipped, or a stop sign if something is wrong),
 *     they tick 2 boxes, hit Upload, and see "Accepted" on screen in seconds. No emails.
 *  2. Website asks for data (POST, signed in with Google) -> claim your call, look up anyone's
 *     progress, spot list and downloads. Not signed in = nothing but an error (rules live on the site).
 *  3. Weekly backup copy of the data sheet. Emails the admins only if something breaks.
 *
 * Fill in SETTINGS on hookup day. Then run setup() once from the Apps Script editor.
 */

var SETTINGS = {
  DATA_SHEET_ID: 'PASTE_ID',          // spreadsheet with tabs: Spots, QSOs, Uploads, Accounts
  BACKUP_FOLDER_ID: 'PASTE_ID',       // MROTA > Backups
  GOOGLE_CLIENT_ID: 'PASTE_ID.apps.googleusercontent.com',  // for "Sign in with Google" on the website
  ADMIN_EMAILS: ['mrota.ota@gmail.com', 'kj5gvq@gmail.com'],
  KEEP_BACKUPS: 8,
  MAX_LOG_CHARS: 2000000,         // about 10,000 contacts; bigger files are refused
  MAX_UPLOADS_PER_HOUR: 30,       // per account; stops runaway scripts and spam
  MAX_PREVIEWS_PER_HOUR: 120
};

var TABS = {
  Spots:    ['MR Ref', 'Spot', 'Icon', 'Town', 'State', 'Lat', 'Lon', 'Grid', 'Setup', 'POTA 2fer?', 'Coords checked?', 'Status', 'Notes'],
  QSOs:     ['key', 'uploadId', 'activator', 'ref', 'state', 'date', 'time', 'hunter', 'hunterRaw', 'band', 'mode', 'modeGroup', 'addedAt', 'xtype', 'theirRef'],
  Uploads:  ['uploadId', 'when', 'email', 'call', 'fileName', 'formRef', 'result', 'added', 'skipped', 'message', 'skippedDetail'],
  Accounts: ['email', 'call', 'claimedAt']
};

/* ---------------- One-time setup ---------------- */

function setup() {
  var ss = SpreadsheetApp.openById(SETTINGS.DATA_SHEET_ID);
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.appendRow(TABS[name]); sh.setFrozenRows(1); }
  });
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weeklyBackup').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  Logger.log('MROTA setup done.');
}

/* ---------------- Helpers ---------------- */

function sheet_(name) { return SpreadsheetApp.openById(SETTINGS.DATA_SHEET_ID).getSheetByName(name); }

function rows_(name) {
  var sh = sheet_(name);
  var v = sh.getDataRange().getValues();
  var head = v.shift();
  return v.map(function (r) { var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}

function spots_() {
  return rows_('Spots').filter(function (r) { return r['MR Ref']; }).map(function (r) {
    return {
      ref: String(r['MR Ref']).trim().toUpperCase(), name: r['Spot'], icon: r['Icon'], town: r['Town'],
      state: String(r['State']).trim(), lat: r['Lat'], lon: r['Lon'], grid: r['Grid'], setup: r['Setup'],
      active: String(r['Status']).toUpperCase() !== 'RETIRED'   // DRAFT and LIVE both count; RETIRED spots drop off
    };
  });
}

function qsos_() {
  return rows_('QSOs').map(function (r) {
    return {
      key: r.key, uploadId: r.uploadId, activator: r.activator, ref: r.ref, state: r.state,
      date: String(r.date), time: String(r.time).padStart(4, '0'), hunter: r.hunter, hunterRaw: r.hunterRaw,
      band: r.band, mode: r.mode, modeGroup: r.modeGroup, xtype: String(r.xtype || ''), theirRef: String(r.theirRef || '')
    };
  });
}

function todayUtc_() { return Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd'); }

function callForEmail_(email) {
  email = String(email || '').toLowerCase();
  var a = rows_('Accounts').filter(function (r) { return String(r.email).toLowerCase() === email; })[0];
  return a ? String(a.call) : '';
}

function alertAdmins_(subject, body) {
  try { MailApp.sendEmail(SETTINGS.ADMIN_EMAILS.join(','), 'MROTA problem: ' + subject, body); } catch (e) { Logger.log(e); }
}

/* ---------------- 1. Upload on the website ---------------- */

/**
 * preview (save = false): checks the log and says what WOULD happen. Nothing is saved.
 * upload  (save = true):  same check, then saves. Needs both boxes ticked.
 * The server always re-checks; the website preview is never trusted on its own.
 */
function processLog_(email, req, save) {
  var call = callForEmail_(email);
  var adifText = String(req.adifText || '');
  if (adifText.length > SETTINGS.MAX_LOG_CHARS) return { ok: false, kickBack: ['That file is too big. Split it into smaller logs.'] };
  if (save && !(req.confirmMine === true && req.agree === true)) {
    return { ok: false, kickBack: ['Please tick both boxes before uploading.'] };
  }
  var lock = LockService.getScriptLock();
  if (save) lock.waitLock(30000);   // one save at a time so dupes can't sneak in
  try {
    var existing = {};
    qsos_().forEach(function (q) { existing[q.key] = true; });
    var uploadId = 'U' + new Date().getTime();
    var res = mrotaCheckUpload({
      adifText: adifText, uploaderCall: call, formRef: req.formRef || '', spots: spots_(),
      existingKeys: existing, todayUtc: todayUtc_(), uploadId: uploadId
    });
    var reply = {
      ok: res.ok, call: call, kickBack: res.kickBack, summary: res.summary,
      added: res.accepted.length, skipped: res.skipped,
      bySpotDay: summarizeBySpotDay_(res.accepted), saved: false
    };
    if (!save || !res.ok) return reply;

    var now = new Date();
    if (res.accepted.length) {
      var out = res.accepted.map(function (q) {
        return [q.key, q.uploadId, q.activator, q.ref, q.state, "'" + q.date, "'" + q.time, q.hunter, q.hunterRaw, q.band, q.mode, q.modeGroup, now, q.xtype || '', q.theirRef || ''];
      });
      var sh = sheet_('QSOs');
      sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
      CacheService.getScriptCache().remove('standings');
    }
    sheet_('Uploads').appendRow([uploadId, now, email, call, String(req.fileName || ''), String(req.formRef || ''), 'ACCEPTED',
      res.accepted.length, res.skipped.length, res.summary,
      res.skipped.map(function (x) { return x.call + ': ' + x.reason; }).join('\n')]);
    reply.saved = true;
    reply.uploadId = uploadId;
    return reply;
  } finally {
    if (save) lock.releaseLock();
  }
}

/** "MR-OK-001 on 2027-01-01: 12 contacts (full activation)" lines for the preview screen. */
function summarizeBySpotDay_(accepted) {
  var m = {};
  accepted.forEach(function (q) { var k = q.ref + '|' + q.date; m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).sort().map(function (k) {
    var p = k.split('|');
    return { ref: p[0], date: p[1], contacts: m[k] };
  });
}

/** Activator's own upload history for the "My Uploads" page. */
function myUploads_(email) {
  return rows_('Uploads').filter(function (r) { return String(r.email).toLowerCase() === email; })
    .slice(-50).reverse().map(function (r) {
      return { id: r.uploadId, when: r.when, file: r.fileName, result: r.result, added: r.added, skipped: r.skipped, message: r.message };
    });
}

/* ---------------- 2. Website data (signed in only) ---------------- */

/** Website sends POST with body {"idToken": "...", "action": "...", ...} as text/plain (no CORS preflight). */
function doPost(e) {
  var req = {};
  try { req = JSON.parse(e.postData.contents); } catch (x) { return json_({ error: 'Bad request' }); }
  var who = verifyGoogle_(req.idToken);
  if (!who) return json_({ error: 'Please sign in to see this.' });
  try {
    switch (req.action) {
      case 'me':       return json_({ email: who.email, call: callForEmail_(who.email) });
      case 'boot':     return json_(boot_(who.email));
      case 'preview':  return tooMany_(who.email, 'p', SETTINGS.MAX_PREVIEWS_PER_HOUR) || json_(processLog_(who.email, req, false));
      case 'upload':   return tooMany_(who.email, 'u', SETTINGS.MAX_UPLOADS_PER_HOUR) || json_(processLog_(who.email, req, true));
      case 'removeUpload': return json_(removeUpload_(who.email, req.uploadId));
      case 'myUploads':return json_({ uploads: myUploads_(who.email) });
      case 'claim':    return json_(claimCall_(who.email, req.call));
      case 'progress': return json_(progress_(req.call || callForEmail_(who.email)));
      case 'spots':    return json_({ spots: spots_().filter(function (s) { return s.active; }) });
      case 'download': return json_({ filename: 'mrota_spots.' + req.format, text: download_(req.format) });
      default:         return json_({ error: 'Unknown action' });
    }
  } catch (err) {
    alertAdmins_('website request failed', JSON.stringify({ action: req.action, email: who.email }) + '\n' + err + '\n' + (err.stack || ''));
    return json_({ error: 'Something went wrong. Richie has been told.' });
  }
}

/** Everything the website needs after sign-in, in one trip. */
function boot_(email) {
  return { email: email, call: callForEmail_(email), isAdmin: isAdmin_(email),
    spots: spots_().filter(function (s) { return s.active; }), standings: slim_(standings_()) };
}

/** Drop the per-contact date lists before sending standings to the browser (keeps it small). */
function slim_(st) {
  var calls = {};
  Object.keys(st.calls).forEach(function (c) {
    var x = st.calls[c];
    calls[c] = { call: x.call, awards: x.awards,
      activator: { qsos: x.activator.qsos, activations: x.activator.activations, fullActivations: x.activator.fullActivations,
        spots: x.activator.spots, founder: x.activator.founder, stp: x.activator.stp, s2p: x.activator.s2p },
      hunter: { qsos: x.hunter.qsos, spots: x.hunter.spots, founder: x.hunter.founder } };
  });
  return { calls: calls, activations: st.activations, spotHunters: st.spotHunters };
}

function isAdmin_(email) { return SETTINGS.ADMIN_EMAILS.map(function (e) { return e.toLowerCase(); }).indexOf(email) >= 0; }

/** Per-account speed limit. Returns an error reply when over the limit, otherwise null. */
function tooMany_(email, kind, max) {
  var cache = CacheService.getScriptCache();
  var key = 'rl:' + kind + ':' + email + ':' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 3700);
  if (n > max) return json_({ ok: false, kickBack: ['Too many tries this hour. Take a break and try again later.'] });
  return null;
}

/** Admin only: take back an upload by its ID (bad log, wrong call, etc.). */
function removeUpload_(email, uploadId) {
  if (!isAdmin_(email)) return { error: 'Admins only.' };
  uploadId = String(uploadId || '').trim();
  if (!/^U\d+$/.test(uploadId)) return { error: 'That is not an upload ID.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = sheet_('QSOs'), v = sh.getDataRange().getValues(), col = v[0].indexOf('uploadId'), gone = 0;
    for (var i = v.length - 1; i >= 1; i--) if (String(v[i][col]) === uploadId) { sh.deleteRow(i + 1); gone++; }
    var up = sheet_('Uploads'), u = up.getDataRange().getValues();
    for (var j = 1; j < u.length; j++) if (String(u[j][0]) === uploadId) up.getRange(j + 1, 7).setValue('REMOVED by ' + email);
    CacheService.getScriptCache().remove('standings');
    return { ok: true, removed: gone };
  } finally { lock.releaseLock(); }
}

function doGet() { return json_({ ok: true, program: 'Mother Road On The Air', note: 'Sign in on the website to see data.' }); }

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Checks a Google sign-in token. Returns {email} or null. */
function verifyGoogle_(idToken) {
  if (!idToken) return null;
  var cache = CacheService.getScriptCache();
  var hit = cache.get('tok:' + idToken.slice(-40));
  if (hit) return JSON.parse(hit);
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', {
    method: 'post', payload: { id_token: idToken }, muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) return null;
  var info = JSON.parse(r.getContentText());
  if (info.aud !== SETTINGS.GOOGLE_CLIENT_ID) return null;
  if (String(info.email_verified) !== 'true') return null;
  var who = { email: String(info.email).toLowerCase() };
  cache.put('tok:' + idToken.slice(-40), JSON.stringify(who), 300);
  return who;
}

/** Honor system: one call per account. If someone else already has it, Richie sorts it out. */
function claimCall_(email, call) {
  call = mrotaBaseCall(call);
  if (!/^[A-Z0-9]{3,10}$/.test(call) || !/\d/.test(call)) return { error: 'That does not look like a call sign.' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var acc = rows_('Accounts');
    var mine = acc.filter(function (r) { return String(r.email).toLowerCase() === email; })[0];
    if (mine) return mine.call === call ? { ok: true, call: call } : { error: 'Your account is already set to ' + mine.call + '. To change it, email Richie.' };
    var taken = acc.filter(function (r) { return String(r.call) === call; })[0];
    if (taken) return { error: call + ' is already claimed by another account. If it is yours, email Richie and he will sort it out.' };
    sheet_('Accounts').appendRow([email, call, new Date()]);
    return { ok: true, call: call };
  } finally { lock.releaseLock(); }
}

function standings_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('standings');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var st = mrotaComputeStandings(qsos_(), spots_());
  var s = JSON.stringify(st);
  if (s.length < 90000) cache.put('standings', s, 600);   // cache limit is 100KB per item
  return st;
}

function progress_(call) {
  if (!call) return { error: 'Set your call sign first.' };
  return mrotaProgressFor(call, standings_(), spots_());
}

/** Spot list downloads: csv, gpx, kml */
function download_(format) {
  var s = spots_().filter(function (x) { return x.active; });
  var esc = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  if (format === 'csv') {
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return ['MR Ref,Spot,Icon,Town,State,Lat,Lon,Grid,Setup'].concat(s.map(function (x) {
      return [x.ref, x.name, x.icon, x.town, x.state, x.lat, x.lon, x.grid, x.setup].map(q).join(',');
    })).join('\n');
  }
  if (format === 'gpx') {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Mother Road On The Air" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      s.map(function (x) {
        return '<wpt lat="' + x.lat + '" lon="' + x.lon + '"><name>' + esc(x.ref + ' ' + x.name) + '</name><desc>' +
          esc(x.icon + ' - ' + x.town + ', ' + x.state + ' - ' + x.grid + ' - ' + x.setup) + '</desc></wpt>';
      }).join('\n') + '\n</gpx>';
  }
  if (format === 'kml') {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mother Road On The Air</name>\n' +
      s.map(function (x) {
        return '<Placemark><name>' + esc(x.ref + ' ' + x.name) + '</name><description>' + esc(x.icon + ' - ' + x.town + ', ' + x.state +
          ' - Grid ' + x.grid + ' - ' + x.setup) + '</description><Point><coordinates>' + x.lon + ',' + x.lat + ',0</coordinates></Point></Placemark>';
      }).join('\n') + '\n</Document></kml>';
  }
  return 'Unknown format';
}

/* ---------------- 3. Weekly backup ---------------- */

function weeklyBackup() {
  try {
    var folder = DriveApp.getFolderById(SETTINGS.BACKUP_FOLDER_ID);
    var src = DriveApp.getFileById(SETTINGS.DATA_SHEET_ID);
    src.makeCopy('MROTA backup ' + Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd'), folder);
    var files = [], it = folder.getFiles();
    while (it.hasNext()) files.push(it.next());
    files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
    files.slice(SETTINGS.KEEP_BACKUPS).forEach(function (f) { f.setTrashed(true); });   // keep the newest 8
  } catch (err) {
    alertAdmins_('weekly backup failed', String(err) + '\n' + (err.stack || ''));
  }
}
