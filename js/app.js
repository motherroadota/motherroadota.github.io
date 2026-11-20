/* Mother Road On The Air: website app.
 * LIVE mode (config.js filled in): Google sign-in, the server checks and saves every log.
 * DEMO mode (config.js empty): pretend sign-in, everything stays in this browser.
 * All page text built from data goes through esc(), so nothing in a log or a call sign can run as code. */
(function () {
'use strict';

var CFG = window.MROTA_SITE || {};
var LIVE = !!(CFG.apiUrl && CFG.clientId);
var CONFIG = LIVE ? MROTA_CONFIG : Object.assign({}, MROTA_CONFIG, { programStart: '20200101' });
var DEMO_KEY = 'mrota-demo';

var state = {
  call: '', email: '', isAdmin: false, token: '',
  spots: window.SPOTS || [], standings: null,
  qsos: [], uploads: [],          // demo only
  scan: null, file: null, busy: false
};

/* ---------- small helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function todayUtc() { var d = new Date(); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); }
function nice(d) { d = String(d || ''); return d.length === 8 ? d.substr(0, 4) + '-' + d.substr(4, 2) + '-' + d.substr(6, 2) : d; }
function spot(ref) { return state.spots.filter(function (s) { return s.ref === ref; })[0]; }
function chip(setup) { var c = setup === 'PUBLIC' ? 'public' : setup === 'ASK FIRST' ? 'ask' : 'check'; return '<span class="chip ' + c + '">' + esc(setup) + '</span>'; }
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
function $(id) { return document.getElementById(id); }
function validCall(c) { return /^[A-Z0-9]{3,10}$/.test(c) && /\d/.test(c); }

/* ---------- data: demo ---------- */
function demoLoad() {
  try { var d = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null'); if (d) { state.call = d.call || ''; state.qsos = d.qsos || []; state.uploads = d.uploads || []; } } catch (e) {}
  state.isAdmin = state.call === 'KJ5GVQ';
  demoStandings();
}
function demoSave() { try { localStorage.setItem(DEMO_KEY, JSON.stringify({ call: state.call, qsos: state.qsos, uploads: state.uploads })); } catch (e) {} }
function demoStandings() { state.standings = mrotaComputeStandings(state.qsos, state.spots, CONFIG); }
function demoExisting() { var m = {}; state.qsos.forEach(function (q) { m[q.key] = true; }); return m; }
function bySpotDay(accepted) {
  var m = {}; accepted.forEach(function (q) { var k = q.ref + '|' + q.date; m[k] = (m[k] || 0) + 1; });
  return Object.keys(m).sort().map(function (k) { var p = k.split('|'); return { ref: p[0], date: p[1], contacts: m[k] }; });
}
function demoCheck(text, ref, asCall, today, uploadId) {
  var r = mrotaCheckUpload({ adifText: text, uploaderCall: asCall || state.call, formRef: ref, spots: state.spots, existingKeys: demoExisting(), todayUtc: today || todayUtc(), uploadId: uploadId || ('U' + Date.now()) }, CONFIG);
  return { ok: r.ok, kickBack: r.kickBack, summary: r.summary, added: r.accepted.length, skipped: r.skipped, bySpotDay: bySpotDay(r.accepted), _accepted: r.accepted };
}

/* ---------- data: live ---------- */
function api(action, body) {
  var payload = Object.assign({ action: action, idToken: state.token }, body || {});
  return fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), credentials: 'omit', redirect: 'follow' })
    .then(function (r) { if (!r.ok) throw new Error('Server said ' + r.status); return r.json(); })
    .then(function (j) {
      if (j && j.error === 'Please sign in to see this.') { signOut(); throw new Error('Your sign-in ran out. Please sign in again.'); }
      return j;
    });
}
function liveBoot() {
  return api('boot').then(function (b) {
    if (b.error) throw new Error(b.error);
    state.email = b.email; state.call = b.call || ''; state.isAdmin = !!b.isAdmin;
    if (b.spots && b.spots.length) state.spots = b.spots;
    state.standings = b.standings;
  });
}

/* ---------- sign in / out ---------- */
function signedIn() { return LIVE ? !!state.token : !!state.call; }
function signOut() {
  state.token = ''; state.email = ''; state.scan = null; state.file = null;
  if (LIVE) { state.call = ''; state.standings = null; try { google.accounts.id.disableAutoSelect(); } catch (e) {} }
  else { state.call = ''; demoSave(); }
  location.hash = '#home'; route();
}
function onGoogle(resp) {
  state.token = resp && resp.credential || '';
  if (!state.token) return;
  busy('Signing you in…');
  liveBoot().then(function () { location.hash = state.call ? '#home' : '#claim'; route(); }, showErr);
}
function setupGoogle() {
  if (!LIVE) return;
  var g = document.createElement('script'); g.src = 'https://accounts.google.com/gsi/client'; g.async = true; document.head.appendChild(g);
  var tries = 0;
  (function wait() {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.initialize({ client_id: CFG.clientId, callback: onGoogle, auto_select: true, cancel_on_tap_outside: true });
      google.accounts.id.prompt();
      route();
    } else if (tries++ < 50) setTimeout(wait, 200);
  })();
}
function renderGoogleButton() {
  var el = $('gsi'); if (!el || !LIVE || !window.google || !google.accounts) return;
  google.accounts.id.renderButton(el, { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill' });
}

/* ---------- views ---------- */
function st() { return state.standings || { calls: {}, activations: [], spotHunters: {} }; }

var VIEWS = {
  home: function () {
    var n = state.spots.length;
    return '<section class="card"><h2>Keep the Mother Road on the air, all year.</h2>' +
      '<p>Route 66 landmarks get reference numbers, starting with <span class="mr">MR-OK-001</span>, the Wellston push pin. ' +
      'Activators get on the air from the stops. Hunters work them from home. It\'s free, it runs on the honor system, and it works a lot like POTA.</p>' +
      '<div class="stats"><div class="stat"><b>' + n + '</b>stops in Oklahoma</div><div class="stat"><b>10</b>contacts = full activation</div>' +
      '<div class="stat"><b>Jan 1</b>Founders Season starts</div><div class="stat"><b>Apr 30</b>official launch, the day Route 66 got its number</div></div></section>' +
      (signedIn() ? homeSignedIn() : '<section class="card"><h3>Sign in to see the stops, upload logs and check progress</h3><p class="muted">You can read the rules without signing in.</p>' + signInBox() + '</section>');
  },
  rules: function () {
    return '<section class="card"><h2>The Rules</h2><ol class="list">' +
      '<li>Free, for fun, on the honor system. Any licensed ham can play.</li>' +
      '<li><b>Mobile first.</b> Working from your vehicle, legally parked, is always welcome. Pedestrian and man pack count too. Anything beyond your parking space (a table, a mast, a wire in a tree or across the lot) needs the owner\'s OK first. At PUBLIC stops, portable is fine if you don\'t block anyone. Park first: contacts made while driving don\'t count.</li>' +
      '<li>A full activation is 10 contacts from one stop in one UTC day. Fewer still counts for the hunters. Several sessions at one stop on one UTC day count as one activation.</li>' +
      '<li>Any band, any mode your license allows. No repeater, EchoLink, IRLP or internet contacts. Satellites are fine.</li>' +
      '<li>Dupes: the same station on the same band and mode, at the same stop, on the same UTC day, counts once.</li>' +
      '<li>On the air, "CQ Mother Road" is the suggested call.</li>' +
      '<li>Activators upload their log (ADIF) here. Hunters do nothing. If you\'re in an activator\'s log, you get credit.</li>' +
      '<li><b>STP (STop to stoP).</b> Work another activator at another stop and you both get credit. Log their MR number (SIG = MROTA, SIG_INFO = MR-OK-###) and it counts toward the STP award. Working a POTA park from a stop (S2P) counts too.</li>' +
      '<li>Free certificates for stops, contacts and STP, plus Oklahoma Midpoint, End to End and All of Oklahoma. Anyone on the air before April 30, 2027 gets a Founder badge.</li>' +
      '<li>What makes a stop: on or right along Route 66, something you\'d stop and take a picture with, open to the public with legal parking, and one per town.</li>' +
      '<li>If an owner or town asks, the stop comes off the list. No argument.</li>' +
      '<li>Use common sense. Be friendly, leave no trace, and show off ham radio.</li></ol>' +
      '<p class="muted">Every upload asks you to agree that you operate at your own risk, only where it\'s legal and allowed, and follow FCC rules. Mother Road On The Air is a free hobby list. It doesn\'t own or manage any location.</p></section>';
  },
  claim: function () {
    return '<section class="card"><h2>Claim your call sign</h2>' +
      '<p>One time only. This ties your call to your Google sign-in, so only you can upload logs as that call. Honor system: only claim your own call.</p>' +
      '<label class="field" for="claimIn">Your call sign<input type="text" id="claimIn" autocomplete="off" autocapitalize="characters" placeholder="KJ5GVQ"></label>' +
      '<div class="row"><button class="btn" id="claimGo">Claim it</button><button class="btn alt" id="signOut">Sign out</button></div>' +
      '<p class="muted small">Club or special event call? Claim it from the Google account that runs it. Mixed up? Email mrota.ota@gmail.com.</p></section>';
  },
  spots: function () {
    var me = st().calls[mrotaBaseCall(state.call)];
    var done = me ? Object.assign({}, me.activator.spots, me.hunter.spots) : {};
    return '<section class="card"><h2>Oklahoma Stops</h2><p class="muted">A green edge means you\'ve worked or activated it. Tap a stop for its page.</p>' +
      '<div class="row"><button class="btn alt" data-dl="csv">Stop list (CSV)</button><button class="btn alt" data-dl="gpx">GPS (GPX)</button><button class="btn alt" data-dl="kml">Google Earth (KML)</button></div></section>' +
      '<div class="spots">' + state.spots.map(function (s) {
        return '<a class="spot' + (done[s.ref] ? ' done' : '') + '" href="#spot-' + s.ref.toLowerCase() + '"><span class="mr">' + esc(s.ref) + '</span>' +
          '<span><b>' + esc(s.name) + '</b><br><span class="town">' + esc(s.icon) + ' · ' + esc(s.town) + '</span></span>' + chip(s.setup) + '</a>';
      }).join('') + '</div>';
  },
  upload: function () {
    var refOpts = '<option value="">From my log (MY_SIG_INFO)</option>' + state.spots.map(function (s) { return '<option value="' + esc(s.ref) + '">' + esc(s.ref + ' ' + s.name) + '</option>'; }).join('');
    var tests = (!LIVE && window.TESTLOGS) ? '<label class="field" for="testlog">Or a demo test log<select id="testlog"><option value="">Choose a test log…</option>' +
      TESTLOGS.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.id + ': ' + t.note + ' (as ' + t.uploader + ')') + '</option>'; }).join('') + '</select></label>' : '';
    return '<section class="card"><h2>Upload a Log</h2>' +
      '<p class="muted">Pick your ADIF file. It gets scanned first. If it looks good, tick both boxes and hit Submit.</p>' +
      '<label class="field" for="ref">Which stop?<select id="ref">' + refOpts + '</select></label>' +
      '<label class="field" for="file">Your log file (.adi from your logger, WRL, etc.)<input type="file" id="file" accept=".adi,.adif,.txt"></label>' +
      '<label class="field" for="paste">Or paste your log text (handy on iPhone)<textarea id="paste" rows="4" placeholder="Paste ADIF text here, then tap Scan"></textarea></label>' +
      '<div class="row"><button class="btn alt" id="scanPaste">Scan pasted log</button></div>' + tests +
      '</section><div id="scan"></div>';
  },
  progress: function () { return progressView(state.call, true); },
  lookup: function () {
    return '<section class="card"><h2>Look Up a Call</h2><label class="field" for="lk">Call sign<input type="text" id="lk" autocomplete="off" autocapitalize="characters" placeholder="KJ5GVQ"></label>' +
      '<div class="row"><button class="btn" id="lkGo">Look up</button></div></section><div id="lkOut"></div>';
  },
  myuploads: function () {
    if (LIVE) { setTimeout(loadMyUploads, 0); return '<section class="card"><h2>My Uploads</h2><div id="upList"><p class="muted">Loading…</p></div></section>' + adminBox(); }
    return '<section class="card"><h2>My Uploads</h2><div id="upList">' + uploadsTable(state.uploads.slice().reverse()) + '</div></section>' + adminBox();
  }
};

function homeSignedIn() {
  var me = st().calls[mrotaBaseCall(state.call)];
  var bits = me ? '<p>You have <b>' + plural(me.activator.fullActivations, 'full activation') + '</b> and <b>' + plural(Object.keys(me.hunter.spots).length, 'stop') + '</b> hunted. <a href="#progress">See your progress</a>.</p>' : '<p>Nothing logged yet. <a href="#upload">Upload a log</a> or get on the air!</p>';
  return '<section class="card"><h3>Welcome, ' + esc(state.call) + '</h3>' + bits +
    (!LIVE ? '<div class="row"><button class="btn alt" id="loadAll">Load all demo test logs</button><button class="btn alt" id="wipe">Wipe demo data</button></div>' : '') + '</section>';
}

function signInBox() {
  if (LIVE) return '<div id="gsi"></div><p class="muted small">MROTA never sees your Google password. We only keep your email and your call sign.</p>';
  return '<label class="field" for="callIn">Demo sign-in: your call sign<input type="text" id="callIn" autocomplete="off" autocapitalize="characters" placeholder="KJ5GVQ"></label>' +
    '<div class="row"><button class="btn" id="signIn">Sign in (demo)</button></div>' +
    '<p class="muted small">On the live site this is "Sign in with Google", and you claim your call once.</p>';
}

function spotView(ref) {
  var s = spot(ref.toUpperCase());
  if (!s) return '<section class="card"><h2>Stop not found</h2><p><a href="#spots">← All stops</a></p></section>';
  var acts = st().activations.filter(function (a) { return a.ref === s.ref; });
  var activators = {};
  acts.forEach(function (a) { if (a.full) activators[a.activator] = (activators[a.activator] || 0) + 1; });
  var hunters = (st().spotHunters || {})[s.ref] || {};
  var topA = Object.keys(activators).sort(function (a, b) { return activators[b] - activators[a]; }).slice(0, 5);
  var topH = Object.keys(hunters).sort(function (a, b) { return hunters[b] - hunters[a]; }).slice(0, 5);
  var map = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.lat + ',' + s.lon);
  var bl = (window.BLURBS || {})[s.ref];
  return '<section class="card"><span class="mr">' + esc(s.ref) + '</span><h2>' + esc(s.name) + '</h2>' +
    '<p><b>' + esc(s.icon) + '</b> · ' + esc(s.town) + ', Oklahoma</p>' +
    '<div class="row">' + chip(s.setup) + '<span class="chip check">Grid ' + esc(s.grid) + '</span></div>' +
    (bl ? '<p>' + esc(bl.b) + '</p>' : '') +
    '<p class="muted">' + (s.setup === 'PUBLIC' ? 'Public ground. Mobile is always welcome, and portable is fine if you don\'t block anyone.' : s.setup === 'ASK FIRST' ? 'Business or museum. Mobile from a legal parking space is welcome. Ask the owner before setting up anything beyond your space.' : 'Setup still being checked.') + '</p>' +
    '<p><a href="' + esc(map) + '" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>' + (bl && /^https:\/\//.test(bl.link) ? ' · <a href="' + esc(bl.link) + '" target="_blank" rel="noopener noreferrer">Learn more</a>' : '') + '</p></section>' +
    '<section class="card"><h3>Top activators</h3>' + (topA.length ? '<ol class="list">' + topA.map(function (c) { return '<li><a href="#lookup-' + esc(c.toLowerCase()) + '">' + esc(c) + '</a> · ' + plural(activators[c], 'full activation') + '</li>'; }).join('') + '</ol>' : '<p class="muted">Nobody yet. Be the first!</p>') +
    '<h3>Top hunters</h3>' + (topH.length ? '<ol class="list">' + topH.map(function (c) { return '<li><a href="#lookup-' + esc(c.toLowerCase()) + '">' + esc(c) + '</a> · ' + plural(hunters[c], 'contact') + '</li>'; }).join('') + '</ol>' : '<p class="muted">Nobody yet.</p>') +
    '</section><p><a href="#spots">← All stops</a></p>';
}

function progressView(call, mine) {
  if (!call) return '<section class="card"><p class="muted">Sign in first.</p></section>';
  var p = mrotaProgressFor(call, st(), state.spots);
  if (!p.found) return '<section class="card"><h2>' + esc(p.call) + '</h2><p class="muted">' + esc(p.message) + '</p></section>';
  function side(label, s, isAct) {
    if (!s.qsos) return '';
    return '<section class="card"><h3>' + label + (s.founder ? ' <span class="chip public">Founder</span>' : '') + '</h3><div class="stats">' +
      '<div class="stat"><b>' + s.spotsCount + '</b>stops ' + (isAct ? 'activated' : 'hunted') + '</div>' +
      '<div class="stat"><b>' + s.qsos + '</b>contacts</div>' +
      (isAct ? '<div class="stat"><b>' + s.fullActivations + '</b>full activations</div><div class="stat"><b>' + (s.stp || 0) + '</b>STP contacts</div>' + (s.s2p ? '<div class="stat"><b>' + s.s2p + '</b>stop to park</div>' : '') : '') +
      '</div><details><summary>Stops still needed (' + s.stillNeed.length + ')</summary><p>' + s.stillNeed.map(function (r) { var x = spot(r); return '<a href="#spot-' + esc(r.toLowerCase()) + '">' + esc(r) + '</a> ' + esc(x ? x.town : ''); }).join(' · ') + '</p></details></section>';
  }
  var earned = p.awardsEarned.map(function (a) {
    return '<div class="earned"><span><b>' + esc(a.label) + '</b>' + (a.date ? ' <span class="muted">' + nice(a.date) + '</span>' : '') + '</span>' +
      '<a class="btn alt" href="#cert-' + esc(p.call.toLowerCase()) + '-' + esc(a.id) + '">Certificate</a></div>';
  }).join('');
  var nextList = p.awardsNext.filter(function (a) { return a.have > 0 || /spots-5|qsos-25|qsos-100|stp-10|mid|e2e/.test(a.id); }).slice(0, 10).map(function (a) {
    var pct = Math.min(100, Math.round(100 * a.have / a.need));
    return '<div class="award"><span><b>' + esc(a.label) + '</b> · ' + a.have + ' of ' + a.need + (a.need - a.have > 0 ? ', ' + (a.need - a.have) + ' to go' : '') + '</span><div class="bar"><i style="width:' + pct + '%"></i></div>' +
      (a.stillNeed && a.stillNeed.length && a.stillNeed.length <= 3 ? '<span class="muted">Still need ' + esc(a.stillNeed.join(', ')) + '</span>' : '') + '</div>';
  }).join('');
  return '<section class="card"><h2>' + (mine ? 'My Progress · ' : '') + esc(p.call) + '</h2></section>' +
    side('Activator', p.activator, true) + side('Hunter', p.hunter, false) +
    '<section class="card"><h3>Awards earned</h3>' + (earned || '<p class="muted">None yet.</p>') + '</section>' +
    (mine ? '<section class="card"><h3>Coming up</h3>' + (nextList || '<p class="muted">Keep going!</p>') + '</section>' : '');
}

function certView(call, id) {
  var p = mrotaProgressFor(call, st(), state.spots);
  var a = (p.awardsEarned || []).filter(function (x) { return x.id === id; })[0];
  if (!a) return '<section class="card"><h2>Certificate not found</h2><p class="muted">That award isn\'t earned yet.</p></section>';
  var founder = p.awardsEarned.some(function (x) { return x.id === a.role + '-founder'; });
  return '<div class="cert-page"><div class="cert full">' +
    '<img src="pushpin.jpg" alt="">' +
    '<span class="muted">Mother Road On The Air</span><span class="big">' + esc(a.label) + '</span><span>presented to</span><span class="call">' + esc(p.call) + '</span>' +
    (a.date ? '<span class="muted">Earned ' + nice(a.date) + '</span>' : '') +
    (founder ? '<span class="chip public" style="justify-self:center">Founder</span>' : '') +
    '<span class="muted small">CQ Mother Road · motherroadota.github.io</span></div>' +
    '<div class="row noprint"><button class="btn" id="printCert">Save as PDF / Print</button><a class="btn alt" href="#progress">Back</a></div>' +
    '<p class="muted small noprint">Tip: in the print screen, pick "Save as PDF".</p></div>';
}

/* ---------- uploads list & admin ---------- */
function uploadsTable(list) {
  if (!list.length) return '<p class="muted">Nothing submitted yet.</p>';
  return '<div class="scroll"><table><tr><th>When</th><th>File</th><th>Added</th><th>Skipped</th>' + (state.isAdmin ? '<th>ID</th>' : '') + '</tr>' +
    list.map(function (u) {
      return '<tr><td>' + esc(u.when) + '</td><td>' + esc(u.file) + (u.result && u.result !== 'ACCEPTED' ? ' <span class="chip ask">' + esc(u.result) + '</span>' : '') + '</td><td>' + esc(u.added) + '</td><td>' + esc(Array.isArray(u.skipped) ? u.skipped.length : u.skipped) + '</td>' + (state.isAdmin ? '<td class="small">' + esc(u.id) + '</td>' : '') + '</tr>';
    }).join('') + '</table></div>';
}
function loadMyUploads() {
  api('myUploads').then(function (j) { var el = $('upList'); if (el) el.innerHTML = uploadsTable((j.uploads || []).map(function (u) { u.when = new Date(u.when).toLocaleString(); return u; })); }, showErr);
}
function adminBox() {
  if (!state.isAdmin) return '';
  return '<section class="card"><h3>Admin: take back an upload</h3><p class="muted small">Removes every contact from that upload. Use the upload ID (starts with U).</p>' +
    '<label class="field" for="rmId">Upload ID<input type="text" id="rmId" autocomplete="off"></label><div class="row"><button class="btn alt" id="rmGo">Remove upload</button></div><div id="rmOut"></div></section>';
}
function removeUpload(id) {
  id = String(id || '').trim();
  if (!/^U\d+$/.test(id)) { $('rmOut').innerHTML = '<p class="muted">That isn\'t an upload ID.</p>'; return; }
  if (!LIVE) {
    var before = state.qsos.length;
    state.qsos = state.qsos.filter(function (q) { return q.uploadId !== id; });
    state.uploads.forEach(function (u) { if (u.id === id) u.result = 'REMOVED'; });
    demoSave(); demoStandings();
    $('rmOut').innerHTML = '<p>Removed ' + plural(before - state.qsos.length, 'contact') + '.</p>';
    return;
  }
  busyBtn('rmGo', true);
  api('removeUpload', { uploadId: id }).then(function (j) {
    $('rmOut').innerHTML = j.ok ? '<p>Removed ' + plural(j.removed, 'contact') + '.</p>' : '<p class="muted">' + esc(j.error) + '</p>';
    return liveBoot();
  }, showErr).then(function () { busyBtn('rmGo', false); });
}

/* ---------- scanning & submitting ---------- */
function scan(text, fileName, ref, demoOpts) {
  state.scan = { text: text, file: fileName, ref: ref, r: null, demo: demoOpts || null };
  if (!LIVE) { var o = demoOpts || {}; state.scan.r = demoCheck(text, ref, o.asCall, o.today); renderScan(); return; }
  renderScanMsg('Scanning your log…');
  api('preview', { adifText: text, formRef: ref, fileName: fileName }).then(function (r) { state.scan.r = r; renderScan(); }, showErr);
}
function renderScanMsg(m) { var el = $('scan'); if (el) el.innerHTML = '<section class="card"><p class="muted">' + esc(m) + '</p></section>'; }
function renderScan() {
  var el = $('scan'); if (!el) return;
  var s = state.scan; if (!s || !s.r) { el.innerHTML = ''; return; }
  var r = s.r, sk = r.skipped || [];
  var skipped = sk.length ? '<details><summary>' + plural(sk.length, 'contact') + ' will be skipped</summary><ul class="list">' +
    sk.map(function (x) { return '<li><b>' + esc(x.call) + '</b>: ' + esc(x.reason) + '</li>'; }).join('') + '</ul></details>' : '';
  if (!r.ok) {
    el.innerHTML = '<section class="card stop"><h3>🛑 Stop: fix this first</h3><p>' + (r.kickBack || []).map(esc).join('<br>') + '</p>' + skipped +
      '<p class="muted">There\'s no Submit button until the log is fixed. Fix it in your logger, export again, and upload the new file.</p></section>';
    return;
  }
  var lines = (r.bySpotDay || []).map(function (d) {
    var x = spot(d.ref);
    return '<li><span class="mr">' + esc(d.ref) + '</span> ' + esc(x ? x.name : '') + ', ' + nice(d.date) + ': <b>' + d.contacts + '</b> new contact' + (d.contacts === 1 ? '' : 's') + (d.contacts >= CONFIG.minQsosForActivation ? ' ✅' : '') + '</li>';
  }).join('');
  var asCall = (s.demo && s.demo.asCall) || state.call;
  el.innerHTML = '<section class="card good"><h3>✅ Scan looks good</h3>' +
    (r.added ? '<p>Ready to add <b>' + plural(r.added, 'contact') + '</b> as <b>' + esc(asCall) + '</b>:</p><ul class="list">' + lines + '</ul>' : '<p>' + esc(r.summary) + '</p>') +
    skipped +
    (r.added ? '<label class="box" for="b1"><input type="checkbox" id="b1"> This log is mine, and it is true and accurate.</label>' +
      '<label class="box" for="b2"><input type="checkbox" id="b2"> I agree: I operate at my own risk and I\'m responsible for my own station and safety. I operate only where it\'s legal and allowed, get permission for anything beyond my parking space, follow all FCC rules, and leave no trace. Mother Road On The Air and KJ5GVQ are a free hobby list. They don\'t own or manage any location and aren\'t responsible for anything that happens at an activation.</label>' +
      '<div class="row"><button class="btn" id="submit" disabled>Submit</button></div>' : '') + '</section>';
}
function submit() {
  var s = state.scan; if (!s || !s.r || !s.r.ok || state.busy) return;
  var mine = $('b1') && $('b1').checked, agree = $('b2') && $('b2').checked;
  if (!(mine && agree)) return;
  if (!LIVE) {
    var o = s.demo || {}, id = 'U' + Date.now();
    var r = demoCheck(s.text, s.ref, o.asCall, o.today, id);    // re-check right before saving, like the server does
    if (!r.ok) { s.r = r; renderScan(); return; }
    r._accepted.forEach(function (q) { state.qsos.push(q); });
    state.uploads.push({ id: id, when: new Date().toLocaleString(), call: o.asCall || state.call, file: s.file, added: r.added, skipped: r.skipped.length, result: 'ACCEPTED' });
    demoSave(); demoStandings(); state.scan = null;
    $('scan').innerHTML = accepted(r.summary);
    return;
  }
  busyBtn('submit', true);
  api('upload', { adifText: s.text, formRef: s.ref, fileName: s.file, confirmMine: true, agree: true }).then(function (r) {
    if (!r.saved) { s.r = r; renderScan(); return; }
    state.scan = null;
    $('scan').innerHTML = accepted(r.summary);
    return liveBoot();
  }, function (e) { busyBtn('submit', false); showErr(e); });
}
function accepted(summary) { return '<section class="card good"><h3>🎉 Accepted!</h3><p>' + esc(summary) + '</p><p><a href="#progress">See My Progress</a> · <a href="#myuploads">My Uploads</a></p></section>'; }

function loadAll() {
  (window.TESTLOGS || []).forEach(function (t) {
    var id = 'U' + Date.now() + t.id.replace(/\D/g, '');
    var r = demoCheck(t.text, t.formRef, t.uploader, '20270601', id);
    if (r.ok) { r._accepted.forEach(function (q) { state.qsos.push(q); }); state.uploads.push({ id: id, when: 'test', call: t.uploader, file: t.id, added: r.added, skipped: r.skipped.length, result: 'ACCEPTED' }); }
  });
  demoSave(); demoStandings(); route();
}

/* ---------- downloads ---------- */
function downloadText(fmt) {
  var s = state.spots;
  var x = function (v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  if (fmt === 'csv') return 'MR Ref,Stop,Icon,Town,State,Lat,Lon,Grid,Setup\n' + s.map(function (p) { return [p.ref, p.name, p.icon, p.town, p.state || 'OK', p.lat, p.lon, p.grid, p.setup].map(function (v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
  if (fmt === 'gpx') return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Mother Road On The Air" xmlns="http://www.topografix.com/GPX/1/1">\n' + s.map(function (p) { return '<wpt lat="' + x(p.lat) + '" lon="' + x(p.lon) + '"><name>' + x(p.ref + ' ' + p.name) + '</name><desc>' + x(p.icon + ' - ' + p.town + ' - ' + p.grid + ' - ' + p.setup) + '</desc></wpt>'; }).join('\n') + '\n</gpx>';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Mother Road On The Air</name>\n' + s.map(function (p) { return '<Placemark><name>' + x(p.ref + ' ' + p.name) + '</name><description>' + x(p.icon + ' - ' + p.town + ' - Grid ' + p.grid + ' - ' + p.setup) + '</description><Point><coordinates>' + x(p.lon) + ',' + x(p.lat) + ',0</coordinates></Point></Placemark>'; }).join('\n') + '\n</Document></kml>';
}
function download(fmt) {
  var types = { csv: 'text/csv', gpx: 'application/gpx+xml', kml: 'application/vnd.google-earth.kml+xml' };
  var blob = new Blob([downloadText(fmt)], { type: types[fmt] || 'text/plain' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mrota_stops.' + fmt;
  document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- busy & errors ---------- */
function busy(msg) { $('main').innerHTML = '<section class="card"><p class="muted">' + esc(msg) + '</p></section>'; }
function busyBtn(id, on) { state.busy = on; var b = $(id); if (b) { b.disabled = on; if (on) b.textContent = 'Working…'; } }
function showErr(e) {
  state.busy = false;
  var m = $('main'); var d = document.createElement('section'); d.className = 'card stop';
  d.innerHTML = '<p>' + esc(e && e.message ? e.message : e) + '</p>'; m.insertBefore(d, m.firstChild); window.scrollTo(0, 0);
}

/* ---------- routing ---------- */
function route() {
  var h = (location.hash || '#home').slice(1);
  var signed = signedIn(), needClaim = LIVE && signed && !state.call;
  var allowed = !signed ? ['home', 'rules'] : needClaim ? ['claim', 'rules'] : ['home', 'rules', 'spots', 'upload', 'progress', 'lookup', 'myuploads'];
  var isSpot = /^spot-mr-[a-z]{2}-\d{3}$/.test(h);
  var isLook = /^lookup-[a-z0-9]{3,10}$/.test(h);
  var cert = /^cert-([a-z0-9]{3,10})-([A-Za-z0-9-]+)$/.exec(h);
  var special = (isSpot || isLook || cert) && signed && !needClaim;
  if (!special && allowed.indexOf(h) < 0) h = needClaim ? 'claim' : 'home';
  var labels = { home: 'Home', rules: 'Rules', claim: 'Claim Call', spots: 'Stops', upload: 'Upload', progress: 'My Progress', lookup: 'Look Up', myuploads: 'My Uploads' };
  $('nav').innerHTML = allowed.map(function (v) { return '<a href="#' + v + '" class="' + (v === h || (isSpot && v === 'spots') || (isLook && v === 'lookup') ? 'on' : '') + '">' + labels[v] + '</a>'; }).join('');
  $('who').innerHTML = signed ? '<span>Signed in as</span><b>' + esc(state.call || state.email) + '</b><button class="linkish" id="signOut">sign out</button>' : '';
  var html;
  if (special && isSpot) html = spotView(h.slice(5));
  else if (special && isLook) html = VIEWS.lookup() ;
  else if (special && cert) html = certView(cert[1].toUpperCase(), cert[2]);
  else html = VIEWS[h]();
  $('main').innerHTML = html;
  if (special && isLook) { var c = h.slice(7).toUpperCase(); $('lk').value = c; $('lkOut').innerHTML = progressView(c, false); }
  if (h === 'upload' && state.scan) renderScan();
  if (!signed) renderGoogleButton();
  window.scrollTo(0, 0);
}

/* ---------- wiring ---------- */
document.addEventListener('click', function (e) {
  var t = e.target.closest ? e.target.closest('button, [data-dl]') || e.target : e.target;
  if (t.id === 'signIn') {
    var c = mrotaBaseCall($('callIn').value);
    if (!validCall(c)) { showErr('That doesn\'t look like a call sign.'); return; }
    state.call = c; state.isAdmin = c === 'KJ5GVQ'; demoSave(); location.hash = '#home'; route();
  }
  if (t.id === 'signOut') { e.preventDefault(); signOut(); }
  if (t.id === 'claimGo') {
    var cc = mrotaBaseCall($('claimIn').value);
    if (!validCall(cc)) { showErr('That doesn\'t look like a call sign.'); return; }
    busyBtn('claimGo', true);
    api('claim', { call: cc }).then(function (j) {
      if (j.error) { busyBtn('claimGo', false); $('claimGo').textContent = 'Claim it'; showErr(j.error); return; }
      state.call = j.call; return liveBoot().then(function () { location.hash = '#home'; route(); });
    }, showErr);
  }
  if (t.id === 'submit') submit();
  if (t.id === 'scanPaste') { var txt = $('paste').value; if (txt.trim()) { state.file = { name: 'pasted log', text: txt }; scan(txt, 'pasted log', $('ref').value); } }
  if (t.id === 'loadAll') loadAll();
  if (t.id === 'wipe') { state.qsos = []; state.uploads = []; demoSave(); demoStandings(); route(); }
  if (t.id === 'lkGo') { var v = mrotaBaseCall($('lk').value); if (validCall(v)) location.hash = '#lookup-' + v.toLowerCase(); }
  if (t.id === 'rmGo') removeUpload($('rmId').value);
  if (t.id === 'printCert') window.print();
  if (t.dataset && t.dataset.dl) download(t.dataset.dl);
});
document.addEventListener('change', function (e) {
  var t = e.target;
  if (t.id === 'b1' || t.id === 'b2') { var b = $('submit'); if (b) b.disabled = !($('b1').checked && $('b2').checked); }
  if (t.id === 'testlog' && t.value) {
    var tl = (window.TESTLOGS || []).filter(function (x) { return x.id === t.value; })[0];
    $('ref').value = tl.formRef || '';
    scan(tl.text, tl.id + '.adi', tl.formRef || '', { asCall: tl.uploader, today: '20270601' });
  }
  if (t.id === 'file' && t.files && t.files[0]) {
    var f = t.files[0];
    if (f.size > 2000000) { showErr('That file is too big. Split it into smaller logs.'); return; }
    var rd = new FileReader();
    rd.onload = function () { state.file = { name: f.name, text: String(rd.result) }; scan(state.file.text, f.name, $('ref').value); };
    rd.readAsText(f);
  }
  if (t.id === 'ref' && state.file) scan(state.file.text, state.file.name, t.value);
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  var id = e.target.id, map = { lk: 'lkGo', callIn: 'signIn', claimIn: 'claimGo', rmId: 'rmGo' };
  if (map[id] && $(map[id])) $(map[id]).click();
});

window.addEventListener('hashchange', route);
if (LIVE) { $('banner').classList.add('hide'); setupGoogle(); } else { demoLoad(); }
route();
})();
