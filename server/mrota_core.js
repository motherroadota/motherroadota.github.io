/**
 * Mother Road On The Air (MROTA) - core engine
 * ------------------------------------------------
 * Plain JavaScript. Runs in Google Apps Script AND in Node (for testing).
 * No Google calls in here: this file only reads logs, checks them, and counts awards.
 * The Google side (forms, sheets, sign-in) lives in Code.gs and calls these functions.
 *
 * Rules this follows (Richie OK'd Nov 18-19, 2026):
 *  - Activators upload a log (ADIF). Hunters do nothing; they get credit from activator logs.
 *  - Full activation = 10+ contacts from one stop in one UTC day (same as POTA).
 *    Fewer still counts for the hunters.
 *  - No repeater / EchoLink / IRLP / internet contacts. Satellites are OK.
 *  - Dupes: same hunter, same band, same mode group, same stop, same UTC day counts once.
 *  - Several sessions at one stop on one UTC day = one activation.
 *  - Honor system. Bad logs get kicked back right away with the reason.
 */

var MROTA_CONFIG = {
  programName: 'Mother Road On The Air',
  programStart: '20270101',   // contacts before this UTC date are not counted (Founders Season starts Jan 1, 2027)
  founderEnd: '20270430',     // contacts BEFORE this date earn the Founder badge (official launch Apr 30, 2027)
  minQsosForActivation: 10,
  requireStationCallMatch: true,   // the log's STATION_CALLSIGN/OPERATOR must match the signed-in call
  excludedPropModes: ['RPT', 'INTERNET', 'ECH', 'IRL'],  // land repeaters, internet, EchoLink, IRLP
  refPattern: /^MR-[A-Z]{2}-\d{3}$/,
  // Fun extras, per state
  midpointRef: { OK: 'MR-OK-001' },               // Wellston push pin
  endToEnd: { OK: ['MR-OK-002', 'MR-OK-023'] },   // Commerce (east end) + Erick (west end)
  awards: {
    activatorSpots: [5, 10, 20],
    hunterSpots: [5, 10, 20],
    activatorQsos: [100, 250, 500, 1000],
    hunterQsos: [25, 50, 100, 250, 500, 1000],
    activatorStp: [10, 25, 50]   // STP = STop to stoP: you at a stop, them at a stop
  }
};

/* ---------------- ADIF reading ---------------- */

/** Reads ADIF (.adi) text. Returns {header:{}, records:[{field:value}]} with lower-case field names. */
function mrotaParseAdif(text) {
  text = String(text || '');
  var out = { header: {}, records: [] };
  var tagRe = /<([A-Za-z0-9_]+)(?::(\d+)(?::[A-Za-z])?)?>/g;
  var cur = {};
  var inHeader = !/^\s*</.test(text);   // ADIF header is free text until <eoh>; files may also start with a tag
  if (!/<eoh>/i.test(text)) inHeader = false;
  var m;
  while ((m = tagRe.exec(text)) !== null) {
    var name = m[1].toLowerCase();
    if (name === 'eoh') { out.header = cur; cur = {}; inHeader = false; continue; }
    if (name === 'eor') {
      if (!inHeader && Object.keys(cur).length) out.records.push(cur);
      cur = {};
      continue;
    }
    if (m[2] !== undefined) {
      var len = parseInt(m[2], 10);
      var start = tagRe.lastIndex;
      cur[name] = text.substr(start, len);
      tagRe.lastIndex = start + len;
    }
  }
  return out;
}

/* ---------------- Small helpers ---------------- */

/** Base call: KJ5GVQ/P -> KJ5GVQ, W5/KJ5GVQ -> KJ5GVQ, kj5gvq -> KJ5GVQ */
function mrotaBaseCall(call) {
  call = String(call || '').toUpperCase().replace(/\s+/g, '');
  if (!call) return '';
  var parts = call.split('/').filter(function (p) { return p; });
  var best = '';
  parts.forEach(function (p) {
    if (/[A-Z]/.test(p) && /\d/.test(p) && p.length > best.length) best = p;
  });
  return best || parts[0] || '';
}

/** Looks like a real-ish call sign: letters and a digit, 3-10 chars. */
function mrotaLooksLikeCall(call) {
  return /^[A-Z0-9]{3,10}$/.test(call) && /[A-Z]/.test(call) && /\d/.test(call);
}

var MROTA_BANDS = [
  ['160M', 1.8, 2.0], ['80M', 3.5, 4.0], ['60M', 5.06, 5.45], ['40M', 7.0, 7.3], ['30M', 10.1, 10.15],
  ['20M', 14.0, 14.35], ['17M', 18.068, 18.168], ['15M', 21.0, 21.45], ['12M', 24.89, 24.99],
  ['10M', 28.0, 29.7], ['6M', 50, 54], ['2M', 144, 148], ['1.25M', 222, 225], ['70CM', 420, 450],
  ['33CM', 902, 928], ['23CM', 1240, 1300]
];

function mrotaBand(rec) {
  if (rec.band) return String(rec.band).toUpperCase().trim();
  var f = parseFloat(rec.freq);
  if (!isNaN(f)) {
    for (var i = 0; i < MROTA_BANDS.length; i++) {
      if (f >= MROTA_BANDS[i][1] && f <= MROTA_BANDS[i][2]) return MROTA_BANDS[i][0];
    }
  }
  return '';
}

/** Mode shown to people (SSB, CW, FT8, FT4, PSK31...). ADIF puts FT4/JS8/PSK31 in SUBMODE. */
function mrotaMode(rec) {
  var sub = String(rec.submode || '').toUpperCase().trim();
  var mode = String(rec.mode || '').toUpperCase().trim();
  if (sub === 'USB' || sub === 'LSB') return 'SSB';
  return sub || mode;
}

/** Mode group for dupes, like POTA: CW / PHONE / DATA */
function mrotaModeGroup(mode) {
  if (mode === 'CW') return 'CW';
  if (['SSB', 'USB', 'LSB', 'AM', 'FM', 'DIGITALVOICE', 'DSTAR', 'C4FM', 'DMR'].indexOf(mode) >= 0) return 'PHONE';
  return 'DATA';
}

function mrotaValidDate(d) {
  if (!/^\d{8}$/.test(d)) return false;
  var y = +d.substr(0, 4), mo = +d.substr(4, 2), da = +d.substr(6, 2);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
  var dt = new Date(Date.UTC(y, mo - 1, da));
  return dt.getUTCMonth() === mo - 1;
}

/* ---------------- Checking an upload ---------------- */

/**
 * Checks one uploaded log.
 * params = {
 *   adifText, uploaderCall,           // signed-in activator's call
 *   formRef,                          // MR number picked on the form (optional if the log has MY_SIG_INFO)
 *   spots: [{ref, state, name, active}],
 *   existingKeys: {key:true},         // keys already on file (so re-uploads don't double count)
 *   todayUtc: 'YYYYMMDD',
 *   uploadId: 'U123'
 * }
 * Returns {ok, kickBack: [reasons], warnings: [], accepted: [qsoRows], skipped: [{call, reason}], summary}
 */
function mrotaCheckUpload(params, config) {
  config = config || MROTA_CONFIG;
  var res = { ok: false, kickBack: [], warnings: [], accepted: [], skipped: [], summary: '' };
  var spotByRef = {};
  (params.spots || []).forEach(function (s) { if (s.active !== false) spotByRef[String(s.ref).toUpperCase()] = s; });

  var activator = mrotaBaseCall(params.uploaderCall);
  if (!mrotaLooksLikeCall(activator)) {
    res.kickBack.push('Your account does not have a valid call sign yet. Set your call on the sign-in page first.');
    return res;
  }
  var formRef = String(params.formRef || '').toUpperCase().trim();
  if (formRef && !config.refPattern.test(formRef)) {
    res.kickBack.push('"' + formRef + '" is not an MR number. They look like MR-OK-001.');
    return res;
  }
  if (formRef && !spotByRef[formRef]) {
    res.kickBack.push(formRef + ' is not on the stop list. Check the number on the Stops page.');
    return res;
  }

  var parsed = mrotaParseAdif(params.adifText);
  if (!parsed.records.length) {
    res.kickBack.push('No contacts found. Make sure you uploaded an ADIF (.adi) file from your logger.');
    return res;
  }

  // Whose log is this?
  var stationCalls = {};
  parsed.records.forEach(function (r) {
    var sc = mrotaBaseCall(r.station_callsign || r.operator || '');
    if (sc) stationCalls[sc] = true;
  });
  var others = Object.keys(stationCalls).filter(function (c) { return c !== activator; });
  if (config.requireStationCallMatch && others.length) {
    res.kickBack.push('This log was made by ' + others.join(', ') + ' but you are signed in as ' + activator +
      '. Upload your own log, or sign in with the right call.');
    return res;
  }

  var seen = {};
  var unknownRefs = {};
  var noRef = 0;
  parsed.records.forEach(function (r) {
    var hunterRaw = String(r.call || '').toUpperCase().trim();
    var hunter = mrotaBaseCall(hunterRaw);
    var skip = function (reason) { res.skipped.push({ call: hunterRaw || '(blank)', reason: reason }); };

    // Which spot? A QSO-level MROTA ref wins, then the form.
    var ref = '';
    if (String(r.my_sig || '').toUpperCase().trim() === 'MROTA') ref = String(r.my_sig_info || '').toUpperCase().trim();
    if (!ref) ref = formRef;
    if (!ref) { noRef++; return; }
    if (!spotByRef[ref]) { unknownRefs[ref] = true; return; }

    var date = String(r.qso_date || '').trim();
    var time = String(r.time_on || '').trim();
    var band = mrotaBand(r);
    var mode = mrotaMode(r);
    if (!hunter || !mrotaLooksLikeCall(hunter)) return skip('missing or bad call sign');
    if (!mrotaValidDate(date)) return skip('missing or bad date');
    if (!/^\d{4}(\d{2})?$/.test(time)) return skip('missing or bad time');
    if (!band) return skip('missing band or frequency');
    if (!mode) return skip('missing mode');
    if (hunter === activator) return skip('contact with yourself');
    var prop = String(r.prop_mode || '').toUpperCase().trim();
    if (config.excludedPropModes.indexOf(prop) >= 0) return skip('repeater or internet contact (' + prop + ') does not count');
    if (date < config.programStart) return skip('before Mother Road On The Air started (' + config.programStart + ')');
    if (params.todayUtc && date > params.todayUtc) return skip('date is in the future');

    var group = mrotaModeGroup(mode);
    // STP / S2P: the other station was at a stop (SIG=MROTA) or a park (SIG=POTA)
    var theirSig = String(r.sig || '').toUpperCase().trim();
    var theirRef = String(r.sig_info || '').toUpperCase().trim();
    var xtype = '';
    if (theirSig === 'MROTA' && config.refPattern.test(theirRef) && theirRef !== ref) xtype = 'STP';
    else if (theirSig === 'POTA' && /^[A-Z0-9]{1,4}-\d{4,5}$/.test(theirRef)) xtype = 'S2P';
    if (!xtype) theirRef = '';
    var key = [activator, ref, date, hunter, band, group].join('|');
    if (seen[key]) return skip('dupe (same band and mode, same day)');
    seen[key] = true;
    if (params.existingKeys && params.existingKeys[key]) return skip('already on file (uploaded before)');

    res.accepted.push({
      key: key, uploadId: params.uploadId || '', activator: activator, ref: ref, state: spotByRef[ref].state || ref.substr(3, 2),
      date: date, time: time.substr(0, 4), hunter: hunter, hunterRaw: hunterRaw, band: band, mode: mode, modeGroup: group,
      xtype: xtype, theirRef: theirRef
    });
  });

  var bad = Object.keys(unknownRefs);
  if (bad.length) {
    res.kickBack.push('These MR numbers are not on the stop list: ' + bad.join(', ') + '. Fix them in your log and upload again.');
    res.accepted = [];
    return res;
  }
  if (noRef) {
    res.kickBack.push('Which stop? Pick your MR number on the upload form (or put MY_SIG = MROTA and MY_SIG_INFO = MR-OK-### in your log).');
    res.accepted = [];
    return res;
  }
  if (!res.accepted.length) {
    var already = res.skipped.filter(function (s) { return s.reason.indexOf('already on file') === 0; }).length;
    if (already) {
      res.ok = true;
      res.summary = 'Every contact in this log was already on file. Nothing new to add, no harm done.';
      return res;
    }
    res.kickBack.push('None of the contacts in this log could be counted. See the list of reasons below.');
    return res;
  }

  // Summary per spot/day
  var perAct = {};
  res.accepted.forEach(function (q) {
    var k = q.ref + ' on ' + q.date.substr(0, 4) + '-' + q.date.substr(4, 2) + '-' + q.date.substr(6, 2);
    perAct[k] = (perAct[k] || 0) + 1;
  });
  var lines = Object.keys(perAct).map(function (k) { return k + ': ' + perAct[k] + ' new contact' + (perAct[k] === 1 ? '' : 's'); });
  res.ok = true;
  res.summary = 'Thanks, ' + activator + '! Added ' + res.accepted.length + ' contact' + (res.accepted.length === 1 ? '' : 's') +
    '. ' + lines.join('; ') + '.' + (res.skipped.length ? ' ' + res.skipped.length + ' skipped (see list).' : '');
  if (res.skipped.length) res.warnings.push(res.skipped.length + ' contact(s) were skipped.');
  return res;
}

/* ---------------- Counting awards ---------------- */

function mrotaThresholdAwards(prefix, label, levels) {
  return levels.map(function (n) { return { id: prefix + n, label: label.replace('{n}', n), need: n }; });
}

/**
 * Builds everybody's standings from all accepted contacts on file.
 * qsos: rows from mrotaCheckUpload (accepted), spots: spot list.
 * Returns {calls: {CALL: stats}, activations: [...]}
 */
function mrotaComputeStandings(qsos, spots, config) {
  config = config || MROTA_CONFIG;
  var activeSpots = spots.filter(function (s) { return s.active !== false; });
  var spotsByState = {};
  activeSpots.forEach(function (s) { (spotsByState[s.state] = spotsByState[s.state] || []).push(s.ref); });

  var sorted = qsos.slice().sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });

  // Activations: activator|ref|date
  var acts = {};
  sorted.forEach(function (q) {
    var k = q.activator + '|' + q.ref + '|' + q.date;
    if (!acts[k]) acts[k] = { activator: q.activator, ref: q.ref, state: q.state, date: q.date, qsos: 0, completedAt: '' };
    acts[k].qsos++;
    if (acts[k].qsos === config.minQsosForActivation) acts[k].completedAt = q.date + q.time;
  });
  var activations = Object.keys(acts).map(function (k) {
    var a = acts[k]; a.full = a.qsos >= config.minQsosForActivation; return a;
  });

  var calls = {};
  function get(c) {
    if (!calls[c]) calls[c] = {
      call: c,
      activator: { qsos: 0, activations: 0, fullActivations: 0, spots: {}, founder: false, qsoDates: [], stp: 0, stpDates: [], s2p: 0 },
      hunter: { qsos: 0, spots: {}, founder: false, qsoDates: [] }
    };
    return calls[c];
  }

  // Activator side
  sorted.forEach(function (q) {
    var s = get(q.activator).activator; s.qsos++; s.qsoDates.push(q.date);
    if (q.xtype === 'STP') { s.stp++; s.stpDates.push(q.date); }
    if (q.xtype === 'S2P') s.s2p++;
  });
  activations.slice().sort(function (a, b) { return (a.completedAt || a.date).localeCompare(b.completedAt || b.date); })
    .forEach(function (a) {
      var s = get(a.activator).activator;
      s.activations++;
      if (a.full) {
        s.fullActivations++;
        if (!s.spots[a.ref]) s.spots[a.ref] = a.date;   // first full activation date of that spot
        if (a.date < config.founderEnd) s.founder = true;
      }
    });

  // Hunter side (plus contacts per hunter at each stop, for the stop pages)
  var spotHunters = {};
  sorted.forEach(function (q) {
    var sh = spotHunters[q.ref] || (spotHunters[q.ref] = {});
    sh[q.hunter] = (sh[q.hunter] || 0) + 1;
    var s = get(q.hunter).hunter;
    s.qsos++; s.qsoDates.push(q.date);
    if (!s.spots[q.ref]) s.spots[q.ref] = q.date;
    if (q.date < config.founderEnd) s.founder = true;
  });

  Object.keys(calls).forEach(function (c) { calls[c].awards = mrotaAwardsFor(calls[c], spotsByState, config); });
  return { calls: calls, activations: activations, spotHunters: spotHunters };
}

/** Date the Nth item was reached, from a list of dates (already in time order). */
function mrotaNthDate(dates, n) { return dates.length >= n ? dates[n - 1] : ''; }

function mrotaAwardsFor(st, spotsByState, config) {
  var earned = [], next = [];
  function role(r, spotLevels, qsoLevels, spotWord) {
    var s = st[r];
    var spotDates = Object.keys(s.spots).map(function (k) { return s.spots[k]; }).sort();
    var R = r === 'activator' ? 'Activator' : 'Hunter';
    mrotaThresholdAwards(r + '-spots-', R + ' ' + '{n} Stops', spotLevels).forEach(function (a) {
      if (spotDates.length >= a.need) earned.push({ id: a.id, label: a.label, role: r, date: mrotaNthDate(spotDates, a.need) });
      else next.push({ id: a.id, label: a.label, role: r, have: spotDates.length, need: a.need });
    });
    mrotaThresholdAwards(r + '-qsos-', R + ' {n} Contacts', qsoLevels).forEach(function (a) {
      if (s.qsos >= a.need) earned.push({ id: a.id, label: a.label, role: r, date: mrotaNthDate(s.qsoDates, a.need) });
      else next.push({ id: a.id, label: a.label, role: r, have: s.qsos, need: a.need });
    });
    Object.keys(spotsByState).forEach(function (state) {
      var all = spotsByState[state];
      var have = all.filter(function (ref) { return s.spots[ref]; });
      var lbl = R + ' All of ' + mrotaStateName(state);
      if (have.length === all.length) {
        var d = have.map(function (ref) { return s.spots[ref]; }).sort().pop();
        earned.push({ id: r + '-all-' + state, label: lbl, role: r, date: d });
      } else {
        next.push({ id: r + '-all-' + state, label: lbl, role: r, have: have.length, need: all.length,
          stillNeed: all.filter(function (ref) { return !s.spots[ref]; }) });
      }
      var mid = config.midpointRef[state];
      if (mid) {
        var ml = R + ' ' + mrotaStateName(state) + ' Midpoint';
        if (s.spots[mid]) earned.push({ id: r + '-mid-' + state, label: ml, role: r, date: s.spots[mid] });
        else next.push({ id: r + '-mid-' + state, label: ml, role: r, have: 0, need: 1, stillNeed: [mid] });
      }
      var ends = config.endToEnd[state];
      if (ends) {
        var el = R + ' ' + mrotaStateName(state) + ' End to End';
        var gotEnds = ends.filter(function (ref) { return s.spots[ref]; });
        if (gotEnds.length === ends.length) {
          earned.push({ id: r + '-e2e-' + state, label: el, role: r, date: ends.map(function (ref) { return s.spots[ref]; }).sort().pop() });
        } else {
          next.push({ id: r + '-e2e-' + state, label: el, role: r, have: gotEnds.length, need: ends.length,
            stillNeed: ends.filter(function (ref) { return !s.spots[ref]; }) });
        }
      }
    });
    if (r === 'activator') mrotaThresholdAwards('activator-stp-', 'STP {n} (Stop to Stop)', config.awards.activatorStp || []).forEach(function (a) {
      if (s.stp >= a.need) earned.push({ id: a.id, label: a.label, role: r, date: mrotaNthDate(s.stpDates, a.need) });
      else next.push({ id: a.id, label: a.label, role: r, have: s.stp, need: a.need });
    });
    if (s.founder) earned.push({ id: r + '-founder', label: R + ' Founder', role: r, date: '' });
  }
  if (st.activator.qsos) role('activator', config.awards.activatorSpots, config.awards.activatorQsos);
  if (st.hunter.qsos) role('hunter', config.awards.hunterSpots, config.awards.hunterQsos);
  return { earned: earned, next: next };
}

function mrotaStateName(code) {
  var names = { IL: 'Illinois', MO: 'Missouri', KS: 'Kansas', OK: 'Oklahoma', TX: 'Texas', NM: 'New Mexico', AZ: 'Arizona', CA: 'California' };
  return names[code] || code;
}

/** What the "My Progress" page shows for one call (logged-in users can look up anyone). */
function mrotaProgressFor(call, standings, spots) {
  var c = mrotaBaseCall(call);
  var st = standings.calls[c];
  var activeSpots = spots.filter(function (s) { return s.active !== false; }).map(function (s) { return s.ref; });
  if (!st) return { call: c, found: false, message: 'No Mother Road contacts on file for ' + c + ' yet.' };
  function side(s) {
    var done = Object.keys(s.spots).sort();
    return {
      qsos: s.qsos, spots: done, spotsCount: done.length, founder: s.founder,
      stillNeed: activeSpots.filter(function (r) { return done.indexOf(r) < 0; }),
      activations: s.activations, fullActivations: s.fullActivations,
      stp: s.stp || 0, s2p: s.s2p || 0
    };
  }
  return {
    call: c, found: true,
    activator: side(st.activator),
    hunter: side(st.hunter),
    awardsEarned: st.awards.earned,
    awardsNext: st.awards.next
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    MROTA_CONFIG: MROTA_CONFIG, mrotaParseAdif: mrotaParseAdif, mrotaBaseCall: mrotaBaseCall,
    mrotaCheckUpload: mrotaCheckUpload, mrotaComputeStandings: mrotaComputeStandings,
    mrotaProgressFor: mrotaProgressFor, mrotaModeGroup: mrotaModeGroup, mrotaBand: mrotaBand
  };
}
