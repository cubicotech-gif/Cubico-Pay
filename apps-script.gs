/**
 * CUBICO PAY — APPS SCRIPT BACKEND
 * ============================================
 * Last modified: 2026-10-20 (My Hisaab commission ledger)
 *
 * Receives requests from the Cubico Pay PWA. Auth is now session-based:
 * users log in with username + password; on success they get a session
 * token (UUID) stored server-side in PropertiesService with a 24h sliding
 * expiry. Every authenticated request carries that token.
 *
 * Roles:
 *   - admin  → full read/write of every payment, plus user management
 *   - client → can log own payments, can read only own payments
 *
 * Sheet tabs used:
 *   - "Payments Log" — payment entries. Column Q now holds clientId.
 *   - "My Hisaab"    — admin-only commission ledger, one row per Paid
 *                      payment (sheet only, never sent to the app).
 *   - "Users"        — auth store: username, passwordHash, salt, role,
 *                      clientId, active, createdAt. Auto-created on first
 *                      bootstrapAdmin() run.
 *
 * NOTE: After editing this file in the repo, paste the new contents into
 * the Apps Script editor and re-deploy (Manage Deployments → edit the
 * existing deployment → Save). The deployed version is stale until then.
 *
 * FIRST-TIME SETUP:
 *   1. Paste this file into Apps Script editor.
 *   2. Run bootstrapAdmin() once from the editor to seed the first admin
 *      user. Check the execution log for the credentials.
 *   3. Deploy as web app (Execute as: me; Who has access: anyone).
 *   4. Log into the PWA with those credentials and change the password.
 */

// ============================================
// CONFIG
// ============================================

const SHEET_NAME      = 'Payments Log';
const USERS_SHEET     = 'Users';
const PARTIES_SHEET   = 'Parties';   // per-client vendor/party list
const SESSION_PREFIX  = 'session_';
const SESSION_TTL_MS  = 24 * 60 * 60 * 1000;   // 24h sliding expiry
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_S  = 15 * 60;               // 15 minutes
const CACHE_TTL_S     = 30;                    // dashboard cache lifetime

// Column map for "Payments Log" — 1-based, matches the sheet.
const COL = {
  paymentDate: 1,  clientName: 2,  usdAmount: 3,  account: 4,  receipt: 5,
  pkrAmount:   6,  feePct:     7,  finalPKR:   8,  paidStatus: 9, daysSince: 10,
  batchRef:   11,  roe:       12,  entryDate: 13,
  actualUsd:  14,  actualSender: 15, paidDate: 16, clientId: 17, loggedBy: 18,
  currency:   19,  screenshotUrl: 20, partyFeePct: 21,
  partyPaid:  22,  partyPaidDate: 23, partyPayRef: 24   // the client's payout to the party
};

// Payments logged on/after this date with no screenshot get flagged in the app.
const SCREENSHOT_FLAG_FROM = '2026-10-21';

// Drive folder where logged payment screenshots are stored. Left blank →
// the backend lazily creates / reuses a folder named SCREENSHOT_FOLDER_NAME.
const SCREENSHOT_FOLDER_NAME = 'Cubico Pay Screenshots';

// ============================================
// GET DISPATCH
// ============================================

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'health';

  // Public — used for uptime checks
  if (action === 'health') {
    return jsonResponse({
      ok: true,
      status: 'Cubico Pay backend is live',
      timestamp: new Date().toISOString()
    });
  }

  const session = validateSession_(e && e.parameter && e.parameter.token);
  if (!session) return jsonResponse({ ok: false, error: 'Unauthorized', code: 'AUTH' });

  try {
    if (action === 'me') {
      return jsonResponse({
        ok: true,
        username: session.username,
        role:     session.role,
        clientId: session.clientId,
        partyName: session.partyName || ''
      });
    }

    // Parties see only their own dashboard — nothing else is readable.
    if (session.role === 'party' && action !== 'dashboard') {
      return jsonResponse({ ok: false, error: 'Forbidden' });
    }

    if (action === 'dashboard') {
      return jsonResponse(Object.assign({ ok: true }, getDashboardCached_(session)));
    }

    if (action === 'users.list') {
      if (session.role !== 'admin') return jsonResponse({ ok: false, error: 'Forbidden' });
      return jsonResponse({ ok: true, users: listUsers_() });
    }

    if (action === 'clients.list') {
      if (session.role !== 'admin') return jsonResponse({ ok: false, error: 'Forbidden' });
      return jsonResponse({ ok: true, clients: listClients_() });
    }

    // Party list for a client. Clients get their own; admin may pass a
    // clientId to load a specific client's list (for logging on behalf).
    if (action === 'parties.list') {
      const cid = session.role === 'admin'
        ? String((e.parameter && e.parameter.clientId) || '').trim()
        : session.clientId;
      return jsonResponse({ ok: true, parties: listParties_(cid) });
    }

    // Same list with each party's fee % and login status (client/admin only).
    if (action === 'parties.detail') {
      const cid = session.role === 'admin'
        ? String((e.parameter && e.parameter.clientId) || '').trim()
        : session.clientId;
      return jsonResponse({ ok: true, parties: listPartiesDetail_(cid) });
    }

    return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Server error: ' + (err.message || String(err)) });
  }
}

// ============================================
// POST DISPATCH
// ============================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (!action) return jsonResponse({ ok: false, error: 'Missing action' });

    // ---- Public actions ----
    if (action === 'login') return handleLogin_(data);

    // ---- Authenticated actions ----
    const session = validateSession_(data.token);
    if (!session) return jsonResponse({ ok: false, error: 'Unauthorized', code: 'AUTH' });

    if (action === 'logout')        return handleLogout_(data.token);
    if (action === 'changePassword') return handleChangePassword_(data, session);
    if (action === 'logPayment')    return handleLogPayment_(data, session);

    // A party login can only log its own payments and manage its own login.
    if (action === 'attachScreenshot') return handleAttachScreenshot_(data, session);
    if (session.role === 'party') return jsonResponse({ ok: false, error: 'Forbidden' });

    // Party management — a client manages their own list; an admin may
    // manage a given client's list by passing clientId. Allowed for both.
    if (action === 'parties.add')    return handleAddParty_(data, session);
    if (action === 'parties.remove') return handleRemoveParty_(data, session);
    if (action === 'partyPayout')          return handlePartyPayout_(data, session);
    if (action === 'parties.linkHistory')  return handleLinkPartyHistory_(data, session);
    if (action === 'parties.setFee')       return handleSetPartyFee_(data, session);
    if (action === 'parties.createLogin')  return handleCreatePartyLogin_(data, session);
    if (action === 'parties.resetLogin')   return handleResetPartyLogin_(data, session);
    if (action === 'parties.setLoginActive') return handleSetPartyLoginActive_(data, session);

    // ---- Admin-only ----
    if (session.role !== 'admin') return jsonResponse({ ok: false, error: 'Forbidden' });

    if (action === 'confirmEntry')         return handleConfirmEntry_(data);
    if (action === 'markPaid')             return handleMarkPaid_(data);
    if (action === 'setFinancials')        return handleSetFinancials_(data);
    if (action === 'editEntry')            return handleEditEntry_(data);
    if (action === 'users.add')            return handleAddUser_(data);
    if (action === 'users.remove')         return handleRemoveUser_(data);
    if (action === 'users.reactivate')     return handleReactivateUser_(data);
    if (action === 'users.resetPassword')  return handleResetPassword_(data);

    return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Server error: ' + (err.message || String(err)) });
  }
}

// ============================================
// AUTH — login, logout, sessions, hashing
// ============================================

function handleLogin_(data) {
  const username = normUsername_(data.username);
  const password = String(data.password || '');
  if (!username || !password) {
    return jsonResponse({ ok: false, error: 'Username and password required' });
  }

  const cache = CacheService.getScriptCache();
  const rlKey = 'rl_' + username;
  const fails = parseInt(cache.get(rlKey) || '0', 10);
  if (fails >= LOGIN_MAX_FAILS) {
    return jsonResponse({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const user = findUser_(username);
  if (!user || !user.active) {
    cache.put(rlKey, String(fails + 1), LOGIN_WINDOW_S);
    return jsonResponse({ ok: false, error: 'Invalid credentials' });
  }

  const hash = hashPassword_(password, user.salt);
  if (hash !== user.passwordHash) {
    cache.put(rlKey, String(fails + 1), LOGIN_WINDOW_S);
    return jsonResponse({ ok: false, error: 'Invalid credentials' });
  }

  cache.remove(rlKey);
  cleanupExpiredSessions_();

  const token = createSession_(user);
  return jsonResponse({
    ok: true,
    token: token,
    username: user.username,
    role: user.role,
    clientId: user.clientId,
    partyName: user.partyName || '',
    expiresAt: Date.now() + SESSION_TTL_MS
  });
}

function handleLogout_(token) {
  PropertiesService.getScriptProperties().deleteProperty(SESSION_PREFIX + token);
  return jsonResponse({ ok: true });
}

function handleChangePassword_(data, session) {
  const oldPassword = String(data.oldPassword || '');
  const newPassword = String(data.newPassword || '');
  if (!oldPassword || !newPassword) {
    return jsonResponse({ ok: false, error: 'oldPassword and newPassword required' });
  }
  if (newPassword.length < 8) {
    return jsonResponse({ ok: false, error: 'New password must be at least 8 characters' });
  }
  const user = findUser_(session.username);
  if (!user) return jsonResponse({ ok: false, error: 'User not found' });
  if (hashPassword_(oldPassword, user.salt) !== user.passwordHash) {
    return jsonResponse({ ok: false, error: 'Old password is incorrect' });
  }
  setUserPassword_(user, newPassword);
  return jsonResponse({ ok: true });
}

function createSession_(user) {
  const token = Utilities.getUuid().replace(/-/g, '') +
                Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const session = {
    username:  user.username,
    role:      user.role,
    clientId:  user.clientId,
    partyName: user.partyName || '',
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  PropertiesService.getScriptProperties()
    .setProperty(SESSION_PREFIX + token, JSON.stringify(session));
  return token;
}

function validateSession_(token) {
  if (!token) return null;
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(SESSION_PREFIX + token);
  if (!raw) return null;
  let session;
  try { session = JSON.parse(raw); } catch (e) { return null; }
  if (!session.expiresAt || session.expiresAt < Date.now()) {
    props.deleteProperty(SESSION_PREFIX + token);
    return null;
  }
  // Sliding expiry — extend by another full TTL on activity, but only
  // rewrite the row if we'd push it forward by at least a minute (cuts
  // write traffic on rapid back-to-back requests).
  if (session.expiresAt - Date.now() < SESSION_TTL_MS - 60 * 1000) {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    props.setProperty(SESSION_PREFIX + token, JSON.stringify(session));
  }
  return session;
}

function cleanupExpiredSessions_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = Date.now();
  Object.keys(all).forEach((k) => {
    if (k.indexOf(SESSION_PREFIX) !== 0) return;
    try {
      const s = JSON.parse(all[k]);
      if (!s.expiresAt || s.expiresAt < now) props.deleteProperty(k);
    } catch (e) {
      props.deleteProperty(k);
    }
  });
}

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + String(password),
    Utilities.Charset.UTF_8
  );
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function generateSalt_() {
  return Utilities.getUuid().replace(/-/g, '') +
         Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function normUsername_(u) {
  return String(u || '').trim().toLowerCase();
}

// ============================================
// USERS TAB
// ============================================

function getUsersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.getRange(1, 1, 1, 8).setValues([
      ['username', 'passwordHash', 'salt', 'role', 'clientId', 'active', 'createdAt', 'partyName']
    ]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(2, 320);
    sheet.setColumnWidth(3, 220);
  }
  ensureColumnHeader_(sheet, 8, 'partyName');   // older tabs stop at column G
  return sheet;
}

function findUser_(username) {
  const sheet = getUsersSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const u = normUsername_(username);
  const values = sheet.getRange(2, 1, last - 1, 8).getValues();
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    if (normUsername_(r[0]) === u) {
      return {
        row: i + 2,
        username: String(r[0]),
        passwordHash: String(r[1]),
        salt: String(r[2]),
        role: String(r[3]),
        clientId: String(r[4] || ''),
        active: toBool_(r[5]),
        createdAt: r[6],
        partyName: String(r[7] || '')
      };
    }
  }
  return null;
}

function listUsers_() {
  const sheet = getUsersSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, 8).getValues();
  return values.map((r) => ({
    username: String(r[0] || ''),
    role: String(r[3] || ''),
    clientId: String(r[4] || ''),
    partyName: String(r[7] || ''),
    active: toBool_(r[5]),
    createdAt: r[6] instanceof Date
      ? Utilities.formatDate(r[6], SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd')
      : String(r[6] || '')
  })).filter((u) => u.username);
}

function listClients_() {
  return listUsers_()
    .filter((u) => u.role === 'client' && u.active)
    .map((u) => ({ username: u.username, clientId: u.clientId }));
}

// ============================================
// PARTIES TAB — per-client vendor list
// ============================================
// One row per party, per client: clientId | party | active | createdAt.
// A client picks a party from this list when logging, instead of typing
// the vendor name each time. Removing a party just flips active to false
// so historical payments keep their vendor name.

function getPartiesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PARTIES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PARTIES_SHEET);
    sheet.getRange(1, 1, 1, 6).setValues([['clientId', 'party', 'active', 'createdAt', 'feePct', 'username']]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(2, 260);
  }
  ensureColumnHeader_(sheet, 5, 'feePct');     // the client's % charged to this party
  ensureColumnHeader_(sheet, 6, 'username');   // the party's login, if one was created
  return sheet;
}

// Active party names for one client, de-duplicated (case-insensitive) and
// sorted alphabetically.
function listParties_(clientId) {
  const cid = String(clientId || '').trim();
  if (!cid) return [];
  const sheet = getPartiesSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, 4).getValues();
  const seen = {};
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const party = String(r[1] || '').trim();
    if (String(r[0]).trim() === cid && toBool_(r[2]) && party) {
      const k = party.toLowerCase();
      if (!seen[k]) { seen[k] = true; out.push(party); }
    }
  }
  out.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  return out;
}


// "10" or 10 -> 0.1. Returns '' for blank, null for invalid.
function parsePctInput_(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '';
  const n = parseFloat(String(v).replace('%', ''));
  if (isNaN(n) || n < 0 || n >= 100) return null;
  return Math.round(n * 100) / 10000;
}

// Row index (1-based) + record of one active-or-not party, or null.
function findParty_(clientId, partyName) {
  const cid = String(clientId || '').trim();
  const name = String(partyName || '').trim().toLowerCase();
  if (!cid || !name) return null;
  const sheet = getPartiesSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const values = sheet.getRange(2, 1, last - 1, 6).getValues();
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    if (String(r[0]).trim() === cid && String(r[1]).trim().toLowerCase() === name) {
      return {
        row: i + 2, party: String(r[1]).trim(), active: toBool_(r[2]),
        feePct: isNumeric_(r[4]) ? r[4] : '', username: String(r[5] || '')
      };
    }
  }
  return null;
}

// Fee fraction stamped on a payment at logging time, or '' if unknown.
function lookupPartyFee_(clientId, partyName) {
  const p = findParty_(clientId, partyName);
  return p && p.feePct !== '' ? p.feePct : '';
}

// Active parties for one client with fee % and login status.
function listPartiesDetail_(clientId) {
  const cid = String(clientId || '').trim();
  if (!cid) return [];
  const sheet = getPartiesSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const activeByName = {};
  listUsers_().forEach((u) => { activeByName[normUsername_(u.username)] = u.active; });
  const seen = {};
  const out = [];
  sheet.getRange(2, 1, last - 1, 6).getValues().forEach((r) => {
    const party = String(r[1] || '').trim();
    if (String(r[0]).trim() !== cid || !toBool_(r[2]) || !party) return;
    const k = party.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    const username = String(r[5] || '');
    out.push({
      party: party,
      feePct: isNumeric_(r[4]) ? r[4] : '',
      username: username,
      loginActive: username ? !!activeByName[normUsername_(username)] : false
    });
  });
  out.sort((a, b) => (a.party.toLowerCase() < b.party.toLowerCase() ? -1 : 1));
  return out;
}

function partyResponse_(cid, extra) {
  return jsonResponse(Object.assign({
    ok: true, parties: listParties_(cid), partiesDetail: listPartiesDetail_(cid)
  }, extra || {}));
}

function randomPassword_() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';   // no look-alikes
  const hex = Utilities.getUuid().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[parseInt(hex.substr(i * 2, 2), 16) % alphabet.length];
  return out;
}

function uniqueUsernameFor_(party) {
  const base = party.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'party';
  for (let i = 0; i < 20; i++) {
    const cand = base + String(Math.floor(100 + Math.random() * 900));
    if (!findUser_(cand)) return cand;
  }
  return base + Utilities.getUuid().slice(0, 6);
}

/**
 * Fill the fee % on this party's earlier payments that have none yet.
 * Never overwrites a % already stamped, so history stays as it was.
 */
function backfillPartyFee_(clientId, partyName, fee) {
  if (fee === '' || fee === null) return;
  let lock = null;
  try {
    try { lock = LockService.getScriptLock(); lock.waitLock(10000); } catch (e) { lock = null; }
    const sheet = getPaymentsSheetOrThrow_();
    ensureColumnHeader_(sheet, COL.partyFeePct, 'partyFeePct');
  ensureColumnHeader_(sheet, COL.partyPaid, 'partyPaid');
  ensureColumnHeader_(sheet, COL.partyPaidDate, 'partyPaidDate');
  ensureColumnHeader_(sheet, COL.partyPayRef, 'partyPayRef');
    const last = sheet.getLastRow();
    if (last < 2) return;
    const n = last - 1;
    const names = sheet.getRange(2, COL.clientName, n, 1).getValues();
    const ids   = sheet.getRange(2, COL.clientId,   n, 1).getValues();
    const fees  = sheet.getRange(2, COL.partyFeePct, n, 1).getValues();
    const want = String(partyName).trim().toLowerCase();
    let touched = 0;
    for (let i = 0; i < n; i++) {
      if (String(ids[i][0]).trim() === clientId &&
          String(names[i][0]).trim().toLowerCase() === want &&
          fees[i][0] === '') {
        fees[i][0] = fee; touched++;
      }
    }
    if (touched) {
      const rng = sheet.getRange(2, COL.partyFeePct, n, 1);
      rng.setValues(fees).setNumberFormat('0.00%');
      bustDashboardCache_({ clientId: clientId });
    }
  } catch (err) {
    console.error('backfillPartyFee_ failed: ' + err);
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { /* ignore */ } }
  }
}


/**
 * Link earlier payments to a party. Payments logged before client accounts
 * existed carry clientId "legacy" (or blank) and the sender name. Any such
 * payment whose name matches the party (or the alias given) is assigned to
 * this client. Never touches payments that already belong to a client.
 * Returns how many payments were linked.
 */
function claimPartyHistory_(clientId, partyName, aliasName) {
  let lock = null;
  try {
    try { lock = LockService.getScriptLock(); lock.waitLock(10000); } catch (e) { lock = null; }
    const sheet = getPaymentsSheetOrThrow_();
    const last = sheet.getLastRow();
    if (last < 2) return 0;
    const n = last - 1;
    const names = sheet.getRange(2, COL.clientName, n, 1).getValues();
    const ids   = sheet.getRange(2, COL.clientId,   n, 1).getValues();
    const party = String(partyName).trim();
    const alias = String(aliasName || '').trim();
    const want  = (alias || party).toLowerCase();
    let linked = 0, renamed = false;
    for (let i = 0; i < n; i++) {
      const nm = String(names[i][0]).trim();
      const id = String(ids[i][0]).trim().toLowerCase();
      if (!nm || nm.toLowerCase() !== want) continue;
      if (id !== '' && id !== 'legacy') continue;
      ids[i][0] = clientId;
      if (alias && alias.toLowerCase() !== party.toLowerCase()) { names[i][0] = party; renamed = true; }
      linked++;
    }
    if (linked) {
      sheet.getRange(2, COL.clientId, n, 1).setValues(ids);
      if (renamed) sheet.getRange(2, COL.clientName, n, 1).setValues(names);
      bustDashboardCache_({ clientId: clientId });
    }
    return linked;
  } catch (err) {
    console.error('claimPartyHistory_ failed: ' + err);
    return 0;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { /* ignore */ } }
  }
}

function handleLinkPartyHistory_(data, session) {
  const cid = partyClientId_(data, session);
  const p = findParty_(cid, data.party);
  if (!p || !p.active) return jsonResponse({ ok: false, error: 'Party not found' });
  const linked = claimPartyHistory_(cid, p.party, data.alias);
  if (p.feePct !== '') backfillPartyFee_(cid, p.party, p.feePct);
  return partyResponse_(cid, { linked: linked });
}

// ============================================
// ROW LOOKUP BY KEY, PAYOUTS TO PARTIES, LATE SCREENSHOTS
// ============================================

/** Stable id of a payment row object (row numbers shift as new rows are inserted on top). */
function entryKey_(r) {
  const day = r.paymentDate instanceof Date ? Math.floor(r.paymentDate.getTime() / 86400000) : String(r.paymentDate);
  if (r.entryDate instanceof Date) return 'E' + Math.floor(r.entryDate.getTime() / 1000) + '|' + day;
  return 'L|' + day + '|' + r.clientName + '|' + r.usdAmount + '|' + r.account;
}

/** Can this session act on this payment row? */
function canActOnRow_(session, r) {
  if (session.role === 'admin') return true;
  if (r.clientId !== session.clientId) return false;
  if (session.role === 'party') {
    return String(r.clientName || '').trim().toLowerCase() === String(session.partyName || '').trim().toLowerCase();
  }
  return true;
}

/**
 * The client marks payments as paid out to a party (or undoes it). Only
 * Confirmed receipts can be paid out. Writes the three partyPaid* columns,
 * which the admin can also see in the sheet.
 */
function handlePartyPayout_(data, session) {
  const keys = Array.isArray(data.keys) ? data.keys.map(String) : [];
  if (!keys.length) return jsonResponse({ ok: false, error: 'Nothing selected' });
  if (keys.length > 300) return jsonResponse({ ok: false, error: 'Select 300 payments or fewer at a time' });
  const paid = toBool_(data.paid);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  let when = '';
  if (paid) {
    const ds = String(data.date || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
    try { when = Utilities.parseDate(ds, tz, 'yyyy-MM-dd'); } catch (e) { when = ''; }
    if (!when || isNaN(when.getTime())) return jsonResponse({ ok: false, error: 'Invalid date' });
  }
  const ref = String(data.ref || '').trim().slice(0, 120);

  const sheet = getPaymentsSheetOrThrow_();
  ensureLoggedByColumn_(sheet);
  const byKey = {};
  readFilledRows_().forEach((r) => { byKey[entryKey_(r)] = r; });

  let updated = 0, skipped = 0;
  keys.forEach((k) => {
    const r = byKey[k];
    if (!r || !canActOnRow_(session, r)) { skipped++; return; }
    if (paid && r.receipt !== 'Confirmed') { skipped++; return; }
    if (paid && r.partyPaid === 'Paid') { skipped++; return; }
    sheet.getRange(r.row, COL.partyPaid, 1, 3).setValues([[paid ? 'Paid' : '', paid ? when : '', paid ? ref : '']]);
    updated++;
  });
  if (updated) {
    sheet.getRange(2, COL.partyPaidDate, Math.max(1, sheet.getLastRow() - 1), 1).setNumberFormat('yyyy-mm-dd');
    bustDashboardCache_({ clientId: session.role === 'client' ? session.clientId : '' });
  }
  return jsonResponse({ ok: true, updated: updated, skipped: skipped });
}

/** Attach a screenshot to a payment that was logged without one. */
function handleAttachScreenshot_(data, session) {
  const key = String(data.key || '');
  if (!key) return jsonResponse({ ok: false, error: 'Missing payment key' });
  if (!data.screenshot) return jsonResponse({ ok: false, error: 'No image received' });
  const r = readFilledRows_().filter((x) => entryKey_(x) === key)[0];
  if (!r || !canActOnRow_(session, r)) return jsonResponse({ ok: false, error: 'Payment not found' });
  if (r.screenshotUrl && session.role !== 'admin') {
    return jsonResponse({ ok: false, error: 'This payment already has a screenshot' });
  }
  const sheet = getPaymentsSheetOrThrow_();
  ensureLoggedByColumn_(sheet);
  const url = saveScreenshot_(data.screenshot, r.clientName);
  if (!url) return jsonResponse({ ok: false, error: 'Could not read the image' });
  sheet.getRange(r.row, COL.screenshotUrl).setValue(url);
  bustDashboardCache_({ clientId: r.clientId });
  return jsonResponse({ ok: true, url: url });
}

function handleSetPartyFee_(data, session) {
  const cid = partyClientId_(data, session);
  const p = findParty_(cid, data.party);
  if (!p) return jsonResponse({ ok: false, error: 'Party not found' });
  const fee = parsePctInput_(data.feePct);
  if (fee === null) return jsonResponse({ ok: false, error: 'Fee % must be between 0 and 99.99' });
  getPartiesSheet_().getRange(p.row, 5).setValue(fee);
  backfillPartyFee_(cid, p.party, fee);
  bustDashboardCache_({ clientId: cid });
  return partyResponse_(cid);
}

function handleCreatePartyLogin_(data, session) {
  const cid = partyClientId_(data, session);
  const p = findParty_(cid, data.party);
  if (!p || !p.active) return jsonResponse({ ok: false, error: 'Party not found' });
  if (p.username) return jsonResponse({ ok: false, error: 'This party already has a login — reset the password instead.' });

  const username = uniqueUsernameFor_(p.party);
  const password = randomPassword_();
  const salt = generateSalt_();
  getUsersSheet_().appendRow([username, hashPassword_(password, salt), salt, 'party', cid, true, new Date(), p.party]);
  getPartiesSheet_().getRange(p.row, 6).setValue(username);
  return partyResponse_(cid, { credentials: { party: p.party, username: username, password: password } });
}

function handleResetPartyLogin_(data, session) {
  const cid = partyClientId_(data, session);
  const p = findParty_(cid, data.party);
  if (!p || !p.username) return jsonResponse({ ok: false, error: 'This party has no login yet' });
  const user = findUser_(p.username);
  if (!user || user.role !== 'party' || user.clientId !== cid) return jsonResponse({ ok: false, error: 'Login not found' });
  const password = randomPassword_();
  setUserPassword_(user, password);
  getUsersSheet_().getRange(user.row, 6).setValue(true);
  invalidateSessionsForUser_(user.username);
  return partyResponse_(cid, { credentials: { party: p.party, username: user.username, password: password } });
}

function handleSetPartyLoginActive_(data, session) {
  const cid = partyClientId_(data, session);
  const p = findParty_(cid, data.party);
  if (!p || !p.username) return jsonResponse({ ok: false, error: 'This party has no login yet' });
  const user = findUser_(p.username);
  if (!user || user.role !== 'party' || user.clientId !== cid) return jsonResponse({ ok: false, error: 'Login not found' });
  const on = toBool_(data.active);
  getUsersSheet_().getRange(user.row, 6).setValue(on);
  if (!on) invalidateSessionsForUser_(user.username);
  return partyResponse_(cid);
}

// Resolve which clientId a party action targets: admins act on the passed
// clientId (logging on behalf), clients act on their own.
function partyClientId_(data, session) {
  return session.role === 'admin'
    ? String(data.clientId || '').trim()
    : session.clientId;
}

function handleAddParty_(data, session) {
  const cid = partyClientId_(data, session);
  if (!cid) return jsonResponse({ ok: false, error: 'clientId required' });
  const party = String(data.party || '').trim();
  if (!party) return jsonResponse({ ok: false, error: 'Party name required' });
  if (party.length > 80) return jsonResponse({ ok: false, error: 'Party name too long (max 80)' });

  const fee = parsePctInput_(data.feePct);
  if (fee === null) return jsonResponse({ ok: false, error: 'Fee % must be between 0 and 99.99' });

  const sheet = getPartiesSheet_();
  const last = sheet.getLastRow();
  if (last >= 2) {
    const values = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim() === cid &&
          String(values[i][1]).trim().toLowerCase() === party.toLowerCase()) {
        // Already exists (maybe removed earlier) — just re-activate it.
        sheet.getRange(i + 2, 3).setValue(true);
        if (fee !== '') sheet.getRange(i + 2, 5).setValue(fee);
        const relinked = claimPartyHistory_(cid, party, '');
        if (fee !== '') backfillPartyFee_(cid, party, fee);
        return partyResponse_(cid, { linked: relinked });
      }
    }
  }
  sheet.appendRow([cid, party, true, new Date(), fee, '']);
  // Attach this party's earlier payments (logged before logins existed).
  const linked = claimPartyHistory_(cid, party, '');
  backfillPartyFee_(cid, party, fee);
  return partyResponse_(cid, { linked: linked });
}

function handleRemoveParty_(data, session) {
  const cid = partyClientId_(data, session);
  if (!cid) return jsonResponse({ ok: false, error: 'clientId required' });
  const party = String(data.party || '').trim().toLowerCase();
  if (!party) return jsonResponse({ ok: false, error: 'Party name required' });

  const sheet = getPartiesSheet_();
  const last = sheet.getLastRow();
  if (last >= 2) {
    const values = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (let i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim() === cid &&
          String(values[i][1]).trim().toLowerCase() === party) {
        sheet.getRange(i + 2, 3).setValue(false);   // hide, keep the row
      }
    }
  }
  // A removed party must not be able to sign in any more.
  const gone = findParty_(cid, party);
  if (gone && gone.username) {
    const u = findUser_(gone.username);
    if (u) { getUsersSheet_().getRange(u.row, 6).setValue(false); invalidateSessionsForUser_(u.username); }
  }
  return partyResponse_(cid);
}

function handleAddUser_(data) {
  const username = normUsername_(data.username);
  const password = String(data.password || '');
  const role = data.role === 'admin' ? 'admin' : 'client';
  const clientId = role === 'client'
    ? String(data.clientId || '').trim()
    : '';

  if (!username) return jsonResponse({ ok: false, error: 'Username required' });
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    return jsonResponse({ ok: false, error: 'Username must be 2–32 chars: a-z, 0-9, dot, dash, underscore' });
  }
  if (password.length < 8) {
    return jsonResponse({ ok: false, error: 'Password must be at least 8 characters' });
  }
  if (role === 'client' && !clientId) {
    return jsonResponse({ ok: false, error: 'clientId required for client accounts' });
  }
  if (role === 'client' && !/^[A-Za-z0-9_-]{1,16}$/.test(clientId)) {
    return jsonResponse({ ok: false, error: 'clientId must be 1–16 chars: a-z, A-Z, 0-9, dash, underscore' });
  }
  if (findUser_(username)) return jsonResponse({ ok: false, error: 'Username already exists' });

  const sheet = getUsersSheet_();
  const salt = generateSalt_();
  const hash = hashPassword_(password, salt);
  sheet.appendRow([username, hash, salt, role, clientId, true, new Date()]);
  return jsonResponse({ ok: true });
}

function handleRemoveUser_(data) {
  const username = normUsername_(data.username);
  const user = findUser_(username);
  if (!user) return jsonResponse({ ok: false, error: 'User not found' });
  if (user.role === 'admin' && countActiveAdmins_() <= 1) {
    return jsonResponse({ ok: false, error: 'Cannot deactivate the last admin' });
  }
  getUsersSheet_().getRange(user.row, 6).setValue(false);
  // Best-effort: drop any active sessions for this user
  invalidateSessionsForUser_(username);
  return jsonResponse({ ok: true });
}

function handleReactivateUser_(data) {
  const username = normUsername_(data.username);
  const user = findUser_(username);
  if (!user) return jsonResponse({ ok: false, error: 'User not found' });
  if (user.active) return jsonResponse({ ok: true });
  getUsersSheet_().getRange(user.row, 6).setValue(true);
  return jsonResponse({ ok: true });
}

function handleResetPassword_(data) {
  const username = normUsername_(data.username);
  const newPassword = String(data.newPassword || '');
  if (newPassword.length < 8) {
    return jsonResponse({ ok: false, error: 'New password must be at least 8 characters' });
  }
  const user = findUser_(username);
  if (!user) return jsonResponse({ ok: false, error: 'User not found' });
  setUserPassword_(user, newPassword);
  invalidateSessionsForUser_(username);
  return jsonResponse({ ok: true });
}

function setUserPassword_(user, newPassword) {
  const sheet = getUsersSheet_();
  const salt = generateSalt_();
  const hash = hashPassword_(newPassword, salt);
  sheet.getRange(user.row, 2, 1, 2).setValues([[hash, salt]]);
}

function countActiveAdmins_() {
  return listUsers_().filter((u) => u.role === 'admin' && u.active).length;
}

function invalidateSessionsForUser_(username) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const u = normUsername_(username);
  Object.keys(all).forEach((k) => {
    if (k.indexOf(SESSION_PREFIX) !== 0) return;
    try {
      const s = JSON.parse(all[k]);
      if (normUsername_(s.username) === u) props.deleteProperty(k);
    } catch (e) { props.deleteProperty(k); }
  });
}

function toBool_(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

// ============================================
// PAYMENT LOGGING (client + admin)
// ============================================

function handleLogPayment_(data, session) {
  // A party logs under its own name and can never mark a receipt Confirmed —
  // that is the admin's call after matching against the account sheet.
  if (session.role === 'party') {
    data.receipt = 'Pending';
    data.clientName = session.partyName;
  }
  const required = ['paymentDate', 'usdAmount', 'account', 'receipt'];
  for (const field of required) {
    if (!data[field] && data[field] !== 0) {
      return jsonResponse({ ok: false, error: 'Missing field: ' + field });
    }
  }

  const dateParts = String(data.paymentDate).split('-');
  if (dateParts.length !== 3) {
    return jsonResponse({ ok: false, error: 'Invalid date format. Expected YYYY-MM-DD.' });
  }
  // Parse the date in the SPREADSHEET's timezone, not the script's. If the
  // two differ (Apps Script projects often default to US Pacific while
  // sheets are set to the user's local zone), `new Date(y, m, d)` would
  // anchor midnight in the script TZ and the cell would render the wrong
  // day after conversion to sheet TZ. parseDate avoids that drift.
  const sheetTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  let paymentDate;
  try {
    paymentDate = Utilities.parseDate(data.paymentDate, sheetTz, 'yyyy-MM-dd');
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Invalid payment date' });
  }
  if (!paymentDate || isNaN(paymentDate.getTime())) {
    return jsonResponse({ ok: false, error: 'Invalid payment date' });
  }

  const usdAmount = parseFloat(data.usdAmount);
  if (isNaN(usdAmount) || usdAmount <= 0) {
    return jsonResponse({ ok: false, error: 'USD amount must be a positive number' });
  }

  // Client name + clientId resolution:
  //   - client role: clientId comes from the session. clientName is the
  //                  *vendor name* if they typed one (client logging on
  //                  behalf of a vendor); otherwise we fall back to the
  //                  logged-in user's username so existing "log my own
  //                  payment" flow still produces a sensible row.
  //   - admin role:  must pass clientId in the payload (logging on behalf
  //                  of a specific client) and a sender/client name.
  let clientName, clientId;
  if (session.role === 'party') {
    clientId   = session.clientId;
    clientName = String(session.partyName || '').trim();
    if (!clientName) return jsonResponse({ ok: false, error: 'This login has no party name' });
  } else if (session.role === 'client') {
    clientId   = session.clientId;
    const typedVendor = data.clientName ? String(data.clientName).trim() : '';
    clientName = typedVendor || session.username;
  } else {
    clientId = String(data.clientId || '').trim();
    if (!clientId) return jsonResponse({ ok: false, error: 'clientId required when admin logs a payment' });
    clientName = String(data.clientName || '').trim();
    if (!clientName) return jsonResponse({ ok: false, error: 'Client name required' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return jsonResponse({ ok: false, error: 'Tab "' + SHEET_NAME + '" not found in spreadsheet' });

  // Make sure the sheet has column R (loggedBy) with its header before
  // we try to write to it. Existing sheets created before this change
  // may only go up to column Q.
  ensureLoggedByColumn_(sheet);

  sheet.insertRowBefore(2);
  const targetRow = 2;
  const tplRow = 3;

  // Re-seed formula columns from the template row (now shifted to row 3).
  [COL.pkrAmount, COL.finalPKR, COL.daysSince].forEach((col) => {
    const f = sheet.getRange(tplRow, col).getFormulaR1C1();
    if (f) sheet.getRange(targetRow, col).setFormulaR1C1(f);
  });
  const gVal = sheet.getRange(tplRow, COL.feePct).getValue();
  if (gVal !== '' && gVal !== null) sheet.getRange(targetRow, COL.feePct).setValue(gVal);

  // Write payment data
  sheet.getRange(targetRow, 1, 1, 5).setValues([[
    paymentDate, clientName, usdAmount, data.account, data.receipt
  ]]);
  sheet.getRange(targetRow, COL.entryDate).setValue(new Date());
  sheet.getRange(targetRow, COL.clientId).setValue(clientId);
  sheet.getRange(targetRow, COL.loggedBy).setValue(session.username);

  // Freeze the party's fee % on the payment so later rate changes never
  // rewrite history. Blank when the name isn't a saved party or has no %.
  const feeAtLog = lookupPartyFee_(clientId, clientName);
  if (feeAtLog !== '') sheet.getRange(targetRow, COL.partyFeePct).setValue(feeAtLog);

  // Currency the amount was received in (recorded only — no conversion).
  const currency = (String(data.currency || 'USD').trim().toUpperCase()) || 'USD';
  sheet.getRange(targetRow, COL.currency).setValue(currency);

  // Optional payment screenshot — saved to Drive, link stored in the row.
  let screenshotSaved = false;
  if (data.screenshot) {
    try {
      const url = saveScreenshot_(data.screenshot, clientName, paymentDate);
      if (url) { sheet.getRange(targetRow, COL.screenshotUrl).setValue(url); screenshotSaved = true; }
    } catch (err) {
      // Non-fatal: never block logging a payment because an image failed.
      console.error('Screenshot save failed: ' + err);
    }
  }

  // Apply the full standard formatting in one pass — supersedes the
  // per-cell setNumberFormat calls that used to live here.
  applyDataRangeFormatting_(sheet, targetRow, 1);

  bustDashboardCache_({ clientId: clientId });

  return jsonResponse({
    ok: true,
    row: targetRow,
    missingScreenshot: !screenshotSaved,
    message: 'Logged $' + usdAmount.toFixed(2) + ' from ' + clientName + ' via ' + data.account
  });
}

// ============================================
// ADMIN ACTIONS — edit existing rows
// ============================================

function handleConfirmEntry_(data) {
  const sheet = getPaymentsSheetOrThrow_();
  const row = validateRow_(sheet, data.row);
  if (row.error) return jsonResponse({ ok: false, error: row.error });

  sheet.getRange(row.n, COL.receipt).setValue('Confirmed');

  if (data.actualUsdAmount !== undefined && data.actualUsdAmount !== null && data.actualUsdAmount !== '') {
    const v = parseFloat(data.actualUsdAmount);
    if (isNaN(v) || v < 0) return jsonResponse({ ok: false, error: 'Invalid actualUsdAmount' });
    sheet.getRange(row.n, COL.actualUsd).setValue(v).setNumberFormat('$#,##0.00');
  }
  if (data.actualSenderName !== undefined) {
    sheet.getRange(row.n, COL.actualSender).setValue(String(data.actualSenderName || '').trim());
  }

  applyDataRangeFormatting_(sheet, row.n, 1);
  syncHisaabRow_(sheet, row.n);
  bustDashboardCache_({ clientId: getRowClientId_(sheet, row.n) });
  return jsonResponse({ ok: true });
}

function handleMarkPaid_(data) {
  const sheet = getPaymentsSheetOrThrow_();
  const row = validateRow_(sheet, data.row);
  if (row.error) return jsonResponse({ ok: false, error: row.error });

  const status = data.paidStatus === 'Paid' ? 'Paid' : 'Unpaid';
  sheet.getRange(row.n, COL.paidStatus).setValue(status);

  if (data.batchRef !== undefined) {
    sheet.getRange(row.n, COL.batchRef).setValue(String(data.batchRef || '').trim());
  }

  // onEdit() also handles the paid-date stamp for user edits in the sheet,
  // but API writes don't trigger onEdit reliably — so stamp it here too.
  const paidCell = sheet.getRange(row.n, COL.paidDate);
  if (status === 'Paid') {
    if (!(paidCell.getValue() instanceof Date)) {
      paidCell.setValue(new Date());
    }
  } else {
    paidCell.clearContent();
  }

  applyDataRangeFormatting_(sheet, row.n, 1);
  syncHisaabRow_(sheet, row.n);
  bustDashboardCache_({ clientId: getRowClientId_(sheet, row.n) });
  return jsonResponse({ ok: true });
}

function handleSetFinancials_(data) {
  const sheet = getPaymentsSheetOrThrow_();
  const row = validateRow_(sheet, data.row);
  if (row.error) return jsonResponse({ ok: false, error: row.error });

  if (data.feePct !== undefined && data.feePct !== '') {
    const v = parseFloat(data.feePct);
    if (isNaN(v) || v < 0) return jsonResponse({ ok: false, error: 'Invalid feePct' });
    sheet.getRange(row.n, COL.feePct).setValue(v);
  }
  if (data.roe !== undefined && data.roe !== '') {
    const v = parseFloat(data.roe);
    if (isNaN(v) || v < 0) return jsonResponse({ ok: false, error: 'Invalid ROE' });
    sheet.getRange(row.n, COL.roe).setValue(v);
  }

  applyDataRangeFormatting_(sheet, row.n, 1);
  syncHisaabRow_(sheet, row.n);
  bustDashboardCache_({ clientId: getRowClientId_(sheet, row.n) });
  return jsonResponse({ ok: true });
}

/**
 * Generic edit — apply any subset of writable fields at once. Lets the
 * admin drawer post one request instead of three.
 */
function handleEditEntry_(data) {
  const sheet = getPaymentsSheetOrThrow_();
  const row = validateRow_(sheet, data.row);
  if (row.error) return jsonResponse({ ok: false, error: row.error });

  const writes = []; // [col, value, numberFormat?]

  if (data.receipt !== undefined) writes.push([COL.receipt, String(data.receipt)]);
  if (data.actualUsdAmount !== undefined) {
    if (data.actualUsdAmount === '' || data.actualUsdAmount === null) {
      sheet.getRange(row.n, COL.actualUsd).clearContent();
    } else {
      const v = parseFloat(data.actualUsdAmount);
      if (isNaN(v) || v < 0) return jsonResponse({ ok: false, error: 'Invalid actualUsdAmount' });
      writes.push([COL.actualUsd, v, '$#,##0.00']);
    }
  }
  if (data.actualSenderName !== undefined) writes.push([COL.actualSender, String(data.actualSenderName || '').trim()]);
  if (data.batchRef !== undefined) writes.push([COL.batchRef, String(data.batchRef || '').trim()]);
  if (data.feePct !== undefined && data.feePct !== '') {
    const v = parseFloat(data.feePct);
    if (isNaN(v) || v < 0) return jsonResponse({ ok: false, error: 'Invalid feePct' });
    writes.push([COL.feePct, v]);
  }
  if (data.roe !== undefined && data.roe !== '') {
    const v = parseFloat(data.roe);
    if (isNaN(v) || v < 0) return jsonResponse({ ok: false, error: 'Invalid ROE' });
    writes.push([COL.roe, v]);
  }

  writes.forEach(([col, val, fmt]) => {
    const cell = sheet.getRange(row.n, col);
    cell.setValue(val);
    if (fmt) cell.setNumberFormat(fmt);
  });

  // Paid status is handled with the same date-stamp logic as markPaid.
  if (data.paidStatus !== undefined) {
    const status = data.paidStatus === 'Paid' ? 'Paid' : 'Unpaid';
    sheet.getRange(row.n, COL.paidStatus).setValue(status);
    const paidCell = sheet.getRange(row.n, COL.paidDate);
    if (status === 'Paid') {
      if (!(paidCell.getValue() instanceof Date)) {
        paidCell.setValue(new Date());
      }
    } else {
      paidCell.clearContent();
    }
  }

  applyDataRangeFormatting_(sheet, row.n, 1);
  syncHisaabRow_(sheet, row.n);
  bustDashboardCache_({ clientId: getRowClientId_(sheet, row.n) });
  return jsonResponse({ ok: true });
}

function getPaymentsSheetOrThrow_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Tab "' + SHEET_NAME + '" not found in spreadsheet');
  return sheet;
}

/**
 * Make sure column R (loggedBy) physically exists and has its header.
 * Existing deployments may have a sheet that only goes up to column Q,
 * so writes to column 18 would otherwise silently fail or get clipped.
 * Idempotent — safe to call before every write.
 */
function ensureLoggedByColumn_(sheet) {
  ensureColumnHeader_(sheet, COL.loggedBy, 'loggedBy');
  ensureColumnHeader_(sheet, COL.currency, 'currency');
  ensureColumnHeader_(sheet, COL.screenshotUrl, 'screenshotUrl');
  ensureColumnHeader_(sheet, COL.partyFeePct, 'partyFeePct');
}

/**
 * Make sure a given column physically exists and carries its header.
 * Existing deployments may have a sheet narrower than the column map, so
 * writes past the last column would otherwise be clipped. Idempotent.
 */
function ensureColumnHeader_(sheet, colIndex, headerText) {
  if (sheet.getMaxColumns() < colIndex) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), colIndex - sheet.getMaxColumns());
  }
  const header = sheet.getRange(1, colIndex);
  if (!header.getValue()) {
    header.setValue(headerText)
          .setBackground(SHEET_FORMAT.headerBg)
          .setFontColor(SHEET_FORMAT.headerText)
          .setFontWeight('bold')
          .setFontFamily(SHEET_FORMAT.font)
          .setFontSize(SHEET_FORMAT.headerSize)
          .setVerticalAlignment('middle')
          .setHorizontalAlignment('left');
  }
}

function validateRow_(sheet, rowInput) {
  const n = parseInt(rowInput, 10);
  if (!n || n < 2) return { error: 'Invalid row' };
  if (n > sheet.getMaxRows()) return { error: 'Row out of range' };
  return { n: n };
}

// ============================================
// DASHBOARD READS
// ============================================

function readFilledRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Tab "' + SHEET_NAME + '" not found in spreadsheet');

  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) return [];

  const maxCols = sheet.getMaxColumns();
  const readCols = Math.max(13, Math.min(24, maxCols));

  const values = sheet.getRange(2, 1, maxRows - 1, readCols).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const a = r[0];
    if (a === '' || a === null || a === undefined) continue;
    rows.push({
      row:              i + 2,
      paymentDate:      r[0],
      clientName:       r[1],
      usdAmount:        r[2],
      account:          r[3],
      receipt:          r[4],
      pkrAmount:        r[5],
      feePct:           r[6],
      finalPKR:         r[7],
      paidStatus:       r[8],
      daysSince:        r[9],
      batchRef:         r[10],
      roe:              r[11],
      entryDate:        r[12],
      actualUsdAmount:  readCols >= 14 ? r[13] : '',
      actualSenderName: readCols >= 15 ? r[14] : '',
      paidDate:         readCols >= 16 ? r[15] : '',
      clientId:         readCols >= 17 ? String(r[16] || '') : '',
      loggedBy:         readCols >= 18 ? String(r[17] || '') : '',
      currency:         readCols >= 19 ? String(r[18] || '') : '',
      screenshotUrl:    readCols >= 20 ? String(r[19] || '') : '',
      partyFeePct:      readCols >= 21 ? r[20] : '',
      partyPaid:        readCols >= 22 ? String(r[21] || '') : '',
      partyPaidDate:    readCols >= 23 ? r[22] : '',
      partyPayRef:      readCols >= 24 ? String(r[23] || '') : ''
    });
  }
  return rows;
}

function isNumeric_(v) {
  return typeof v === 'number' && !isNaN(v);
}

function getDashboardCached_(session) {
  if (session.role === 'party') return buildDashboard_(session);   // per-party view, not cached
  const cache = CacheService.getScriptCache();
  const key = session.role === 'admin'
    ? 'dashboard_admin'
    : 'dashboard_client_' + session.clientId;
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  const data = buildDashboard_(session);
  try { cache.put(key, JSON.stringify(data), CACHE_TTL_S); } catch (e) { /* non-fatal */ }
  return data;
}

function buildDashboard_(session) {
  let rows = readFilledRows_();
  if (session.role === 'client') {
    rows = rows.filter((r) => r.clientId === session.clientId);
  } else if (session.role === 'party') {
    const mine = String(session.partyName || '').trim().toLowerCase();
    rows = rows
      .filter((r) => r.clientId === session.clientId && String(r.clientName || '').trim().toLowerCase() === mine)
      .map(partyView_);
  }
  const role = session.role;

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const thisMonth = Utilities.formatDate(new Date(), tz, 'yyyy-MM');

  let totalUnpaidPKR = 0;
  let totalReceivedUSDThisMonth = 0;
  let overdueCount = 0;
  let pendingReceiptsCount = 0;

  const buckets = {};
  const alerts = [];

  for (const r of rows) {
    const roeSet   = isNumeric_(r.roe) && r.roe > 0;
    const isPaid   = r.paidStatus === 'Paid';
    // A row counts as unpaid unless it's explicitly marked Paid. Blank
    // status is the default lifecycle state (still owed) — matches the
    // row's "Unpaid" badge and the Statements outstanding-PKR logic.
    const isUnpaid = !isPaid;
    // USD currency check — amounts are recorded only (no conversion), so
    // non-USD entries must NOT be summed into a USD total.
    const isUSD    = !r.currency || String(r.currency).toUpperCase() === 'USD';
    const usdForBucket = isNumeric_(r.actualUsdAmount) ? r.actualUsdAmount : r.usdAmount;

    if (isUnpaid && roeSet && isNumeric_(r.finalPKR)) totalUnpaidPKR += r.finalPKR;
    if (isUnpaid && roeSet && isNumeric_(r.daysSince) && r.daysSince > 10) overdueCount += 1;
    if (r.receipt === 'Pending') pendingReceiptsCount += 1;

    if (r.paymentDate instanceof Date) {
      const ym = Utilities.formatDate(r.paymentDate, tz, 'yyyy-MM');
      // "This month USD" = money actually received this month: only
      // Confirmed receipts, only USD entries (no Pending/Not Received
      // claims, no foreign currencies polluting the figure).
      if (ym === thisMonth && r.receipt === 'Confirmed' && isUSD && isNumeric_(usdForBucket)) {
        totalReceivedUSDThisMonth += usdForBucket;
      }

      let b = buckets[ym];
      if (!b) {
        b = buckets[ym] = {
          month: ym,
          label: Utilities.formatDate(r.paymentDate, tz, 'MMMM yyyy'),
          count: 0, totalUSD: 0, totalFinalPKR: 0, outstandingPKR: 0,
          paidCount: 0, unpaidCount: 0, overdueCount: 0,
          roeSum: 0, roeCount: 0
        };
      }
      b.count += 1;
      if (isNumeric_(usdForBucket)) b.totalUSD += usdForBucket;
      if (isNumeric_(r.finalPKR))   b.totalFinalPKR += r.finalPKR;
      if (isPaid) b.paidCount += 1; else b.unpaidCount += 1;
      if (!isPaid && isNumeric_(r.finalPKR) && roeSet) b.outstandingPKR += r.finalPKR;
      if (!isPaid && isNumeric_(r.daysSince) && r.daysSince > 10 && roeSet) b.overdueCount += 1;
      if (roeSet) { b.roeSum += r.roe; b.roeCount += 1; }
    }

    if (r.receipt !== 'Confirmed' || !isPaid) alerts.push(r);
  }

  const byPaymentDateDesc = (a, b) => {
    const pa = a.paymentDate instanceof Date ? a.paymentDate.getTime() : -Infinity;
    const pb = b.paymentDate instanceof Date ? b.paymentDate.getTime() : -Infinity;
    if (pb !== pa) return pb - pa;
    const ea = a.entryDate instanceof Date ? a.entryDate.getTime() : -Infinity;
    const eb = b.entryDate instanceof Date ? b.entryDate.getTime() : -Infinity;
    return eb - ea;
  };
  alerts.sort(byPaymentDateDesc);
  const allEntries = rows.slice().sort(byPaymentDateDesc);

  const months = Object.values(buckets).map((b) => ({
    month: b.month,
    label: b.label,
    count: b.count,
    totalUSD: round2_(b.totalUSD),
    totalFinalPKR: round2_(b.totalFinalPKR),
    outstandingPKR: round2_(b.outstandingPKR),
    paidCount: b.paidCount,
    unpaidCount: b.unpaidCount,
    overdueCount: b.overdueCount,
    avgRoe: b.roeCount > 0 ? round2_(b.roeSum / b.roeCount) : ''
  })).sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  return {
    summary: {
      totalUnpaidPKR: round2_(totalUnpaidPKR),
      totalReceivedUSDThisMonth: round2_(totalReceivedUSDThisMonth),
      overdueCount: overdueCount,
      pendingReceiptsCount: pendingReceiptsCount,
      totalEntries: rows.length
    },
    alerts: alerts.map((r) => serializeEntry_(r, role)),
    months: months,
    payouts: role === 'party' ? [] : buildPayouts_(rows, role),
    allEntries: allEntries.map((r) => serializeEntry_(r, role))
  };
}

function buildPayouts_(rows, role) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const buckets = {};

  for (const r of rows) {
    if (r.paidStatus !== 'Paid') continue;
    const key = (r.batchRef && String(r.batchRef).trim()) || '(no batch)';
    let b = buckets[key];
    if (!b) {
      b = buckets[key] = {
        batchRef: key,
        count: 0,
        totalUSD: 0,
        totalFinalPKR: 0,
        paidDates: {},
        latestPaid: null,
        entries: []
      };
    }
    b.count += 1;
    const usd = isNumeric_(r.actualUsdAmount) ? r.actualUsdAmount
              : (isNumeric_(r.usdAmount) ? r.usdAmount : 0);
    b.totalUSD += usd;
    if (isNumeric_(r.finalPKR)) b.totalFinalPKR += r.finalPKR;
    if (r.paidDate instanceof Date) {
      b.paidDates[Utilities.formatDate(r.paidDate, tz, 'yyyy-MM-dd')] = true;
      if (!b.latestPaid || r.paidDate.getTime() > b.latestPaid.getTime()) {
        b.latestPaid = r.paidDate;
      }
    }
    b.entries.push(r);
  }

  const result = Object.keys(buckets).map((key) => {
    const b = buckets[key];
    const dates = Object.keys(b.paidDates).sort();
    const paidDate = dates.length > 0 ? dates[dates.length - 1] : '';
    const paidDateLabel = b.latestPaid
      ? Utilities.formatDate(b.latestPaid, tz, 'd MMM yyyy')
      : '';
    return {
      batchRef: b.batchRef,
      paidDate: paidDate,
      paidDateLabel: paidDateLabel,
      paidDateRange: dates.length > 1 ? (dates[0] + ' → ' + dates[dates.length - 1]) : paidDate,
      multipleDates: dates.length > 1,
      count: b.count,
      totalUSD: round2_(b.totalUSD),
      totalFinalPKR: round2_(b.totalFinalPKR),
      entries: b.entries.map((r) => serializeEntry_(r, role))
    };
  });

  result.sort((a, b) => {
    if (a.paidDate && !b.paidDate) return -1;
    if (!a.paidDate && b.paidDate) return 1;
    if (a.paidDate < b.paidDate) return 1;
    if (a.paidDate > b.paidDate) return -1;
    return a.batchRef.localeCompare(b.batchRef);
  });

  return result;
}

/**
 * What a party is allowed to know about a row. The admin's fee to the
 * client (column G) and the final PKR owed to the client (column H) are
 * replaced by the party's own numbers, so nothing here can be used to work
 * out anyone else's percentage.
 */
function partyView_(r) {
  const v = Object.assign({}, r);
  const pp = isNumeric_(r.partyFeePct) ? r.partyFeePct : '';
  const gross = isNumeric_(r.pkrAmount) && isNumeric_(r.roe) && r.roe > 0 ? r.pkrAmount : '';
  v.finalPKR = (gross !== '' && pp !== '') ? round2_(gross * (1 - pp)) : '';   // net to the party
  v.feePct = '';
  v.actualSenderName = '';
  // For a party, "paid" means the client paid them — never the admin->client payout.
  v.paidStatus = r.partyPaid === 'Paid' ? 'Paid' : 'Unpaid';
  v.paidDate = r.partyPaid === 'Paid' ? r.partyPaidDate : '';
  v.batchRef = r.partyPayRef || '';
  return v;
}

function serializeEntry_(r, role) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const roeSet = isNumeric_(r.roe) && r.roe > 0;
  const gross  = roeSet && isNumeric_(r.pkrAmount) ? r.pkrAmount : '';
  const pp     = isNumeric_(r.partyFeePct) ? r.partyFeePct : '';
  const entryTs = r.entryDate instanceof Date ? r.entryDate.getTime() : 0;
  const out = {
    row: r.row,
    paymentDate: r.paymentDate instanceof Date
      ? Utilities.formatDate(r.paymentDate, tz, 'yyyy-MM-dd') : '',
    entryDate: r.entryDate instanceof Date
      ? Utilities.formatDate(r.entryDate, tz, 'yyyy-MM-dd') : '',
    clientName: r.clientName || '',
    usdAmount: isNumeric_(r.usdAmount) ? round2_(r.usdAmount) : '',
    actualUsdAmount: isNumeric_(r.actualUsdAmount) ? round2_(r.actualUsdAmount) : '',
    actualSenderName: r.actualSenderName || '',
    paidDate: r.paidDate instanceof Date
      ? Utilities.formatDate(r.paidDate, tz, 'yyyy-MM-dd') : '',
    account: r.account || '',
    receipt: r.receipt || '',
    pkrAmount: isNumeric_(r.pkrAmount) ? round2_(r.pkrAmount) : '',
    feePct: isNumeric_(r.feePct) ? r.feePct : '',
    finalPKR: isNumeric_(r.finalPKR) ? round2_(r.finalPKR) : '',
    paidStatus: r.paidStatus || '',
    daysSince: isNumeric_(r.daysSince) ? r.daysSince : '',
    batchRef: r.batchRef || '',
    roe: isNumeric_(r.roe) ? r.roe : '',
    clientId: r.clientId || '',
    loggedBy: r.loggedBy || '',
    currency: r.currency || 'USD',
    screenshotUrl: r.screenshotUrl || '',
    partyFeePct: pp,
    key: entryKey_(r),
    partyPaid: r.partyPaid === 'Paid' ? 'Paid' : '',
    partyPaidDate: r.partyPaidDate instanceof Date
      ? Utilities.formatDate(r.partyPaidDate, tz, 'yyyy-MM-dd') : '',
    partyPayRef: r.partyPayRef || '',
    // Logged after the rule started, not a "never arrived" claim, and no image.
    noScreenshot: !r.screenshotUrl && r.receipt !== 'Not Received' &&
                  entryTs >= new Date(SCREENSHOT_FLAG_FROM + 'T00:00:00').getTime()
  };

  if (role === 'party') {
    // finalPKR already holds the party's net (see partyView_).
    out.partyFeeAmount = (gross !== '' && pp !== '') ? round2_(gross * pp) : '';
    out.netToParty = out.finalPKR;
    out.clientId = '';
  } else {
    // Admin and client: split the gross into party fee / net to party and
    // the client's own profit (what the admin pays them, minus what they
    // pass on to the party).
    out.partyFeeAmount = (gross !== '' && pp !== '') ? round2_(gross * pp) : '';
    out.netToParty     = (gross !== '' && pp !== '') ? round2_(gross * (1 - pp)) : '';
    out.clientProfit   = (out.netToParty !== '' && isNumeric_(r.finalPKR))
      ? round2_(r.finalPKR - out.netToParty) : '';
  }
  return out;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Invalidate the cached dashboard payload(s). Admin cache is always
 * cleared; pass clientId to also clear that client's cache so the
 * change is visible to them on their next refresh (no 30s tail).
 */
function bustDashboardCache_(opts) {
  try {
    const cache = CacheService.getScriptCache();
    // Old key from pre-roles deployment, keep clearing it for a while.
    cache.remove('dashboard_v1');
    cache.remove('dashboard_admin');
    const cid = opts && opts.clientId;
    if (cid) cache.remove('dashboard_client_' + cid);
  } catch (e) { /* non-fatal */ }
}

function getRowClientId_(sheet, row) {
  return String(sheet.getRange(row, COL.clientId).getValue() || '');
}

// ============================================
// SCREENSHOT STORAGE (Google Drive)
// ============================================

/**
 * Decode a base64 data-URL screenshot, save it to the screenshots Drive
 * folder, share it as view-only-by-link, and return the file URL.
 * Returns '' if the payload isn't a recognisable data URL.
 */
function saveScreenshot_(dataUrl, clientName) {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(String(dataUrl));
  if (!m) return '';
  const contentType = m[1];
  const bytes = Utilities.base64Decode(m[2]);
  const ext = contentType === 'image/png' ? 'png'
            : contentType === 'image/webp' ? 'webp' : 'jpg';
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss');
  const safeName = String(clientName || 'payment').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'payment';
  const blob = Utilities.newBlob(bytes, contentType, safeName + '-' + stamp + '.' + ext);
  const file = getScreenshotFolder_().createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* sharing policy may forbid link sharing; keep the file */ }
  return file.getUrl();
}

function getScreenshotFolder_() {
  const it = DriveApp.getFoldersByName(SCREENSHOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(SCREENSHOT_FOLDER_NAME);
}

// ============================================
// HELPERS
// ============================================

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// SHEET FORMATTING — keeps the sheet looking consistent
// ============================================
//
// Change any value in SHEET_FORMAT (or the column widths below) to
// tweak the look. Re-run applyStandardFormatting() from the editor to
// push the change across all existing rows. Every backend write (new
// payment, admin edit) and every user edit (via onEdit) auto-reapplies
// the standard to the affected row(s), so manual font / color / size
// changes get auto-corrected.

const SHEET_FORMAT = {
  headerBg:   '#060C18',
  headerText: '#FFFFFF',
  bodyBg:     '#FFFFFF',
  bodyText:   '#0A1628',
  font:       'Inter',
  headerSize: 11,
  bodySize:   10
};

const COL_WIDTHS = {
  paymentDate: 110, clientName: 180, usdAmount: 110, account: 130, receipt: 110,
  pkrAmount:   120, feePct:      90, finalPKR:  130, paidStatus: 100, daysSince: 90,
  batchRef:    140, roe:         80, entryDate: 150,
  actualUsd:   120, actualSender: 180, paidDate: 110, clientId: 90, loggedBy: 110
};

/**
 * Apply the standard formatting to the entire Payments Log sheet.
 * Idempotent — safe to re-run anytime. Run this once from the Apps
 * Script editor to clean up existing inconsistent formatting; after
 * that, the auto-revert hooks keep things tidy.
 */
function applyStandardFormatting() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Tab "' + SHEET_NAME + '" not found in spreadsheet');
  ensureLoggedByColumn_(sheet);
  applyHeaderFormatting_(sheet);
  applyColumnWidths_(sheet);
  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  const last = sheet.getLastRow();
  if (last >= 2) applyDataRangeFormatting_(sheet, 2, last - 1);
  Logger.log('Standard formatting applied to ' + Math.max(0, last - 1) + ' data rows.');
}

function applyHeaderFormatting_(sheet) {
  const range = sheet.getRange(1, 1, 1, COL.loggedBy);
  range.setBackground(SHEET_FORMAT.headerBg)
       .setFontColor(SHEET_FORMAT.headerText)
       .setFontWeight('bold')
       .setFontFamily(SHEET_FORMAT.font)
       .setFontSize(SHEET_FORMAT.headerSize)
       .setVerticalAlignment('middle')
       .setHorizontalAlignment('left');
  try { sheet.setRowHeight(1, 36); } catch (e) { /* non-fatal */ }
}

/**
 * Format a block of data rows. Resets font, size, color, alignment, and
 * per-column number formats. Does NOT change cell values.
 */
function applyDataRangeFormatting_(sheet, startRow, numRows) {
  if (numRows <= 0 || startRow < 2) return;
  const full = sheet.getRange(startRow, 1, numRows, COL.loggedBy);
  if (sheet.getMaxColumns() >= COL.partyFeePct) {
    sheet.getRange(startRow, COL.partyFeePct, numRows).setNumberFormat('0.00%');
  }
  if (sheet.getMaxColumns() >= COL.partyPaidDate) {
    sheet.getRange(startRow, COL.partyPaidDate, numRows).setNumberFormat('yyyy-mm-dd');
  }
  full.setFontFamily(SHEET_FORMAT.font)
      .setFontSize(SHEET_FORMAT.bodySize)
      .setFontColor(SHEET_FORMAT.bodyText)
      .setBackground(SHEET_FORMAT.bodyBg)
      .setFontWeight('normal')
      .setFontStyle('normal')
      .setVerticalAlignment('middle')
      .setHorizontalAlignment('left');

  sheet.getRange(startRow, COL.paymentDate, numRows).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(startRow, COL.usdAmount,   numRows).setNumberFormat('$#,##0.00');
  sheet.getRange(startRow, COL.pkrAmount,   numRows).setNumberFormat('"₨"#,##0');
  sheet.getRange(startRow, COL.feePct,      numRows).setNumberFormat('0.00%');
  sheet.getRange(startRow, COL.finalPKR,    numRows).setNumberFormat('"₨"#,##0');
  sheet.getRange(startRow, COL.daysSince,   numRows).setNumberFormat('0');
  sheet.getRange(startRow, COL.roe,         numRows).setNumberFormat('0.00');
  sheet.getRange(startRow, COL.entryDate,   numRows).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(startRow, COL.actualUsd,   numRows).setNumberFormat('$#,##0.00');
  sheet.getRange(startRow, COL.paidDate,    numRows).setNumberFormat('yyyy-mm-dd');
}

function applyColumnWidths_(sheet) {
  const map = {};
  map[COL.paymentDate]  = COL_WIDTHS.paymentDate;
  map[COL.clientName]   = COL_WIDTHS.clientName;
  map[COL.usdAmount]    = COL_WIDTHS.usdAmount;
  map[COL.account]      = COL_WIDTHS.account;
  map[COL.receipt]      = COL_WIDTHS.receipt;
  map[COL.pkrAmount]    = COL_WIDTHS.pkrAmount;
  map[COL.feePct]       = COL_WIDTHS.feePct;
  map[COL.finalPKR]     = COL_WIDTHS.finalPKR;
  map[COL.paidStatus]   = COL_WIDTHS.paidStatus;
  map[COL.daysSince]    = COL_WIDTHS.daysSince;
  map[COL.batchRef]     = COL_WIDTHS.batchRef;
  map[COL.roe]          = COL_WIDTHS.roe;
  map[COL.entryDate]    = COL_WIDTHS.entryDate;
  map[COL.actualUsd]    = COL_WIDTHS.actualUsd;
  map[COL.actualSender] = COL_WIDTHS.actualSender;
  map[COL.paidDate]     = COL_WIDTHS.paidDate;
  map[COL.clientId]     = COL_WIDTHS.clientId;
  map[COL.loggedBy]     = COL_WIDTHS.loggedBy;
  Object.keys(map).forEach((col) => {
    try { sheet.setColumnWidth(parseInt(col, 10), map[col]); } catch (e) { /* non-fatal */ }
  });
}

// ============================================
// SIMPLE TRIGGERS
// ============================================

/**
 * Watches column I (Paid status) of "Payments Log". See original notes:
 * stamps column P with today's date when status flips to Paid, clears it
 * otherwise. Also busts the dashboard cache so admin/clients see fresh
 * data on next open. After all that, re-applies the standard formatting
 * to the touched rows so manual font / color changes get auto-corrected.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const startCol = e.range.getColumn();
  const endCol = startCol + e.range.getNumColumns() - 1;
  const startRow = e.range.getRow();
  const numRows = e.range.getNumRows();

  // Paid-status side-effect: stamp / clear column P when col I changes.
  const touchesPaidStatus = startCol <= COL.paidStatus && endCol >= COL.paidStatus;
  if (touchesPaidStatus) {
    const today = new Date();
    for (let i = 0; i < numRows; i++) {
      const row = startRow + i;
      if (row < 2) continue;
      const status = sheet.getRange(row, COL.paidStatus).getValue();
      const paidCell = sheet.getRange(row, COL.paidDate);
      const existing = paidCell.getValue();
      if (status === 'Paid') {
        if (!(existing instanceof Date)) {
          paidCell.setValue(today);
        }
      } else if (existing) {
        paidCell.clearContent();
      }
    }
  }

  // Auto-revert: re-apply the standard formatting to whatever rows the
  // user just touched. Their values stay; only fonts / colors / number
  // formats snap back to the standard.
  try {
    const firstDataRow = Math.max(startRow, 2);
    const overlap = (startRow + numRows - 1) - firstDataRow + 1;
    if (overlap > 0) applyDataRangeFormatting_(sheet, firstDataRow, overlap);
  } catch (err) { /* non-fatal */ }

  // Keep My Hisaab in step with manual edits (cap guards huge pastes).
  syncHisaabRows_(sheet, startRow, Math.min(numRows, 500));

  bustDashboardCache_();
}

// ============================================
// ONE-TIME SETUP — run from the Apps Script editor
// ============================================

/**
 * Seed the first admin user. Run this once from the script editor after
 * pasting this file in. Check the execution log for the temporary
 * password — log in with it and change it immediately.
 *
 * Safe to run more than once: it bails out if an admin already exists.
 */
function bootstrapAdmin() {
  const sheet = getUsersSheet_();
  const existing = findUser_('admin');
  if (existing) {
    Logger.log('User "admin" already exists. Aborting.');
    return;
  }
  // Random 12-char temporary password — visible only in the execution log.
  const tempPassword = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  const salt = generateSalt_();
  const hash = hashPassword_(tempPassword, salt);
  sheet.appendRow(['admin', hash, salt, 'admin', '', true, new Date()]);
  Logger.log('================================================');
  Logger.log('ADMIN USER CREATED');
  Logger.log('Username: admin');
  Logger.log('Password: ' + tempPassword);
  Logger.log('LOG IN AND CHANGE THIS IMMEDIATELY.');
  Logger.log('================================================');
}

/**
 * Convenience: backfill the clientId column on existing payment rows.
 * Set DEFAULT_CLIENT_ID to whatever you want assigned to legacy rows,
 * then run this once. Skips rows that already have a clientId.
 */
function backfillClientIds() {
  const DEFAULT_CLIENT_ID = 'legacy';
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Payments Log not found');
  const last = sheet.getLastRow();
  if (last < 2) return;
  const range = sheet.getRange(2, COL.clientId, last - 1, 1);
  const values = range.getValues();
  let touched = 0;
  for (let i = 0; i < values.length; i++) {
    if (!values[i][0] || String(values[i][0]).trim() === '') {
      values[i][0] = DEFAULT_CLIENT_ID;
      touched += 1;
    }
  }
  range.setValues(values);
  Logger.log('Backfilled clientId on ' + touched + ' rows.');
}

// ============================================
// MY HISAAB — admin-only commission ledger (lives in the sheet only)
// ============================================
//
// Every payment marked "Paid" in Payments Log gets one row in the
// "My Hisaab" tab. The sub-agent charges a lower fee than the one we
// charge the client; the difference is our commission, taken on the gross
// PKR (column F of Payments Log):
//
//     commission PKR = gross PKR x commission %
//
// The commission % is read from cell B1 of My Hisaab when a row is first
// added and is then stored on that row, so changing B1 only affects
// payments marked Paid afterwards. Edit a row's own H cell to override it.
//
// Rows are matched by a stable key (the entry timestamp), not by row
// number, because new payments are inserted at the top of Payments Log.
// Marking a payment unpaid again removes its My Hisaab row.

const HISAAB_SHEET        = 'My Hisaab';
const HISAAB_DEFAULT_RATE = 0.02;
const HISAAB_HEADER_ROW   = 4;
const HISAAB_FIRST_ROW    = 5;
const HISAAB_HEADERS = [
  'Paid Date', 'Client', 'USD Received', 'ROE', 'Gross PKR', 'My Fee %',
  'Other Party %', 'My Commission %', 'Commission PKR', 'Running Total',
  'Final PKR Paid', 'Batch Ref', 'Key'
];
// 1-based column numbers in My Hisaab
const HC = { date: 1, client: 2, usd: 3, roe: 4, gross: 5, fee: 6, other: 7,
             rate: 8, commission: 9, running: 10, finalPkr: 11, batch: 12, key: 13 };

/** Run once from the editor to create the tab (also created lazily). */
function setupMyHisaab() {
  getHisaabSheet_();
}

/**
 * Run once from the editor to copy every payment already marked Paid into
 * My Hisaab. Safe to re-run: payments already listed are skipped.
 */
function backfillMyHisaab() {
  const payments = getPaymentsSheetOrThrow_();
  const hs = getHisaabSheet_();
  const last = payments.getLastRow();
  if (last < 2) return;

  const rows = payments.getRange(2, 1, last - 1, COL.paidDate).getValues();
  const existing = {};
  hisaabKeys_(hs).forEach(function (k) { existing[k] = true; });

  const rate = readHisaabRate_(hs);
  const fresh = [];
  rows.forEach(function (r) {
    if (r[0] === '' || r[COL.paidStatus - 1] !== 'Paid') return;
    if (!isNumeric_(r[COL.pkrAmount - 1])) return;
    const key = hisaabKey_(r);
    if (existing[key]) return;
    existing[key] = true;
    fresh.push({ r: r, paid: hisaabPaidDate_(r) });
  });
  if (!fresh.length) { Logger.log('Nothing to backfill.'); return; }

  fresh.sort(function (a, b) { return a.paid - b.paid; });
  const start = hisaabLastRow_(hs) + 1;
  const out = fresh.map(function (f, i) { return buildHisaabRow_(f.r, start + i, rate); });
  hs.getRange(start, 1, out.length, HISAAB_HEADERS.length).setValues(out);
  applyHisaabFormatting_(hs, start, out.length);
  Logger.log('Backfilled ' + out.length + ' paid payments into ' + HISAAB_SHEET + '.');
}

/**
 * Run once from the editor to tidy My Hisaab: rebuilds every row from
 * Payments Log (dates fall back to the received date), oldest first, and
 * keeps the commission % each existing row already had. Rows for payments
 * that are no longer Paid disappear.
 */
function rebuildMyHisaab() {
  const payments = getPaymentsSheetOrThrow_();
  const hs = getHisaabSheet_();
  const rate = readHisaabRate_(hs);

  const oldRates = {};
  const keys = hisaabKeys_(hs);
  if (keys.length) {
    hs.getRange(HISAAB_FIRST_ROW, HC.rate, keys.length, 1).getValues()
      .forEach(function (x, i) { oldRates[keys[i]] = x[0]; });
  }

  const last = payments.getLastRow();
  const fresh = [];
  if (last >= 2) {
    payments.getRange(2, 1, last - 1, COL.paidDate).getValues().forEach(function (r) {
      if (r[0] === '' || r[COL.paidStatus - 1] !== 'Paid') return;
      if (!isNumeric_(r[COL.pkrAmount - 1])) return;
      fresh.push({ r: r, date: hisaabPaidDate_(r) });
    });
  }
  fresh.sort(function (a, b) { return a.date - b.date; });

  const oldLast = hisaabLastRow_(hs);
  if (oldLast >= HISAAB_FIRST_ROW) {
    hs.getRange(HISAAB_FIRST_ROW, 1, oldLast - HISAAB_FIRST_ROW + 1, HISAAB_HEADERS.length).clearContent();
  }
  if (!fresh.length) return;
  const out = fresh.map(function (f, i) {
    const k = hisaabKey_(f.r);
    const old = oldRates[k] !== undefined ? oldRates[k] : oldRates[k.split('|')[0]];
    const rt = old !== undefined && old !== '' ? old : rate;
    return buildHisaabRow_(f.r, HISAAB_FIRST_ROW + i, rt);
  });
  hs.getRange(HISAAB_FIRST_ROW, 1, out.length, HISAAB_HEADERS.length).setValues(out);
  applyHisaabFormatting_(hs, HISAAB_FIRST_ROW, out.length);
  Logger.log('Rebuilt ' + out.length + ' rows in ' + HISAAB_SHEET + '.');
}

/**
 * Bring My Hisaab in line with a block of Payments Log rows: add/refresh
 * each one that is Paid, remove each that is not. Works in one pass (one
 * read of the block, one read of the keys, bulk writes) so a bulk status
 * change cannot run out of time half way. Never throws — a Hisaab problem
 * must not block the payment action that triggered it.
 */
function syncHisaabRows_(paymentsSheet, startRow, numRows) {
  let lock = null;
  try {
    startRow = Math.max(startRow, 2);
    if (numRows < 1) return;
    SpreadsheetApp.flush();
    const block = paymentsSheet.getRange(startRow, 1, numRows, COL.paidDate).getValues();

    // LockService may be unavailable inside a simple onEdit trigger.
    try { lock = LockService.getScriptLock(); lock.waitLock(10000); } catch (e) { lock = null; }

    const hs = getHisaabSheet_();
    const index = {};
    hisaabKeys_(hs).forEach(function (k, i) { index[k] = HISAAB_FIRST_ROW + i; });
    const rate = readHisaabRate_(hs);

    const deletes = [];
    const adds = [];
    block.forEach(function (r) {
      if (r[0] === '' || r[0] === null) return;
      const key = hisaabKey_(r);
      const found = index[key] || 0;
      const isPaid = r[COL.paidStatus - 1] === 'Paid' && isNumeric_(r[COL.pkrAmount - 1]);
      if (!isPaid) {
        if (found) deletes.push(found);
        return;
      }
      if (found) {
        // Refresh amounts but keep the commission % this row was stamped with.
        const v = buildHisaabRow_(r, found, rate);
        hs.getRange(found, HC.date, 1, HC.fee).setValues([v.slice(0, HC.fee)]);
        hs.getRange(found, HC.finalPkr, 1, 3).setValues([v.slice(HC.finalPkr - 1)]);
        applyHisaabFormatting_(hs, found, 1);
      } else {
        index[key] = -1;               // guard against the same key twice in one block
        adds.push(r);
      }
    });

    // Delete bottom-up so row numbers stay valid, then append the new rows.
    deletes.sort(function (x, y) { return y - x; })
           .filter(function (x, i, arr) { return i === 0 || x !== arr[i - 1]; })
           .forEach(function (rowNum) { hs.deleteRow(rowNum); });

    if (adds.length) {
      const start = hisaabLastRow_(hs) + 1;
      const out = adds.map(function (r, i) { return buildHisaabRow_(r, start + i, rate); });
      hs.getRange(start, 1, out.length, HISAAB_HEADERS.length).setValues(out);
      applyHisaabFormatting_(hs, start, out.length);
    }
  } catch (err) {
    console.error('My Hisaab sync failed for rows ' + startRow + '+' + numRows + ': ' + err);
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { /* ignore */ } }
  }
}

function syncHisaabRow_(paymentsSheet, rowN) {
  syncHisaabRows_(paymentsSheet, rowN, 1);
}

function hisaabPaidDate_(r) {
  // Column P (paid date) is the date for My Hisaab. If a row has none
  // (marked Paid before that column existed), use the date the money was
  // received (column A) rather than today's date.
  const d = r[COL.paidDate - 1];
  if (d instanceof Date) return d;
  return r[0] instanceof Date ? r[0] : new Date();
}

function normPct_(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;   // tolerate "5" typed instead of 5%
}

/** Stable identity of a payment, independent of its (shifting) row number. */
function hisaabKey_(r) {
  const day = r[0] instanceof Date ? Math.floor(r[0].getTime() / 86400000) : String(r[0]);
  const e = r[COL.entryDate - 1];
  if (e instanceof Date) return 'E' + Math.floor(e.getTime() / 1000) + '|' + day;
  return 'L|' + day + '|' + r[1] + '|' + r[2] + '|' + r[3];
}

function readHisaabRate_(hs) {
  const v = hs.getRange('B1').getValue();
  return (v === '' || v === null || !isFinite(Number(v))) ? HISAAB_DEFAULT_RATE : normPct_(v);
}

/** Keys of all data rows, in sheet order (index 0 = first data row). */
function hisaabKeys_(hs) {
  const n = hs.getMaxRows() - HISAAB_FIRST_ROW + 1;
  if (n < 1) return [];
  const keys = hs.getRange(HISAAB_FIRST_ROW, HC.key, n, 1).getValues()
                 .map(function (x) { return String(x[0]); });
  while (keys.length && keys[keys.length - 1] === '') keys.pop();
  return keys;
}

/** Last row holding a payment (measured on the Key column, so the month list doesn't count). */
function hisaabLastRow_(hs) {
  return HISAAB_FIRST_ROW - 1 + hisaabKeys_(hs).length;
}

/** One full My Hisaab row (values + formulas) for sheet row n. */
function buildHisaabRow_(r, n, rate) {
  const actual = r[COL.actualUsd - 1];
  const usd = isNumeric_(actual) ? actual : r[COL.usdAmount - 1];
  return [
    hisaabPaidDate_(r),
    r[COL.clientName - 1],
    usd,
    r[COL.roe - 1],
    r[COL.pkrAmount - 1],
    normPct_(r[COL.feePct - 1]),
    '=F' + n + '-H' + n,
    rate,
    '=E' + n + '*H' + n,
    '=SUM(I$' + HISAAB_FIRST_ROW + ':I' + n + ')',
    r[COL.finalPKR - 1],
    r[COL.batchRef - 1],
    hisaabKey_(r)
  ];
}

/**
 * Month picker in the header: pick a month in H1 and H2/H3 show the
 * commission and payment count for it. The dropdown list is built from the
 * paid dates in column A and lives in column O (grey, off to the side).
 * Idempotent; added automatically to an existing tab on next use.
 */
function addMonthPicker_(hs) {
  const F = HISAAB_FIRST_ROW;
  const sel = 'DATE(LEFT($H$1,4),MID($H$1,6,2),1)';
  const crit = 'A' + F + ':A,">="&' + sel + ',A' + F + ':A,"<"&EDATE(' + sel + ',1)';

  hs.getRange('G1').setValue('Select month').setFontWeight('bold');
  hs.getRange('G2').setValue('Commission').setFontWeight('bold');
  hs.getRange('G3').setValue('Payments').setFontWeight('bold');

  const pick = hs.getRange('H1');
  if (pick.getValue() === '') {
    pick.setNumberFormat('@').setValue(Utilities.formatDate(
      new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM'));
  }
  pick.setBackground('#FFF8DC').setFontWeight('bold').setHorizontalAlignment('left')
      .setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInRange(hs.getRange('O' + F + ':O'), true)
        .setAllowInvalid(true).build());

  hs.getRange('H2').setFormula('=IF($H$1="","",SUMIFS(I' + F + ':I,' + crit + '))')
    .setNumberFormat('"₨"#,##0.00').setFontWeight('bold').setHorizontalAlignment('left');
  hs.getRange('H3').setFormula('=IF($H$1="","",COUNTIFS(' + crit + '))')
    .setHorizontalAlignment('left');

  hs.getRange('O' + HISAAB_HEADER_ROW).setValue('Months (for dropdown)')
    .setFontColor('#9CA3AF').setFontStyle('italic');
  hs.getRange('O' + F).setFormula(
    '=IFERROR(ARRAYFORMULA(TEXT(SORT(UNIQUE(ARRAYFORMULA(DATE(YEAR(FILTER(A' + F + ':A,A' + F + ':A<>"")),' +
    'MONTH(FILTER(A' + F + ':A,A' + F + ':A<>"")),1))),1,FALSE),"yyyy-mm")),"")'
  ).setFontColor('#9CA3AF');
  hs.getRange('G1:H3').setFontFamily(SHEET_FORMAT.font).setFontSize(SHEET_FORMAT.bodySize);
  hs.setColumnWidth(7, 110); hs.setColumnWidth(8, 130); hs.setColumnWidth(15, 130);
}

function getHisaabSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hs = ss.getSheetByName(HISAAB_SHEET);
  if (hs) {
    if (hs.getRange('G1').getValue() === '') addMonthPicker_(hs);
    return hs;
  }

  hs = ss.insertSheet(HISAAB_SHEET);
  const H = SHEET_FORMAT;
  hs.getRange('A1').setValue('My commission %');
  hs.getRange('B1').setValue(HISAAB_DEFAULT_RATE).setNumberFormat('0.00%')
    .setBackground('#FFF8DC').setFontWeight('bold');
  hs.getRange('C1').setValue('← change this to set the rate for payments marked Paid from now on');
  hs.getRange('A2').setValue('Total commission');
  hs.getRange('B2').setFormula('=SUM(I' + HISAAB_FIRST_ROW + ':I)').setNumberFormat('"₨"#,##0');
  hs.getRange('D1').setValue('This month');
  hs.getRange('E1').setFormula(
    '=SUMIFS(I' + HISAAB_FIRST_ROW + ':I,A' + HISAAB_FIRST_ROW + ':A,">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1))'
  ).setNumberFormat('"₨"#,##0');
  hs.getRange('D2').setValue('Payments');
  hs.getRange('E2').setFormula('=COUNT(I' + HISAAB_FIRST_ROW + ':I)');
  hs.getRange('A1:E2').setFontFamily(H.font).setFontSize(H.bodySize);
  hs.getRange('A1:A2').setFontWeight('bold');
  hs.getRange('D1:D2').setFontWeight('bold');
  hs.getRange('C1').setFontColor('#6B7280').setFontStyle('italic');

  hs.getRange(HISAAB_HEADER_ROW, 1, 1, HISAAB_HEADERS.length)
    .setValues([HISAAB_HEADERS])
    .setBackground(H.headerBg).setFontColor(H.headerText).setFontWeight('bold')
    .setFontFamily(H.font).setFontSize(H.headerSize).setVerticalAlignment('middle');
  hs.setFrozenRows(HISAAB_HEADER_ROW);
  [110, 180, 110, 70, 110, 90, 110, 120, 130, 130, 130, 140, 120].forEach(function (w, i) {
    hs.setColumnWidth(i + 1, w);
  });
  hs.getRange(HISAAB_FIRST_ROW, HC.key, hs.getMaxRows() - HISAAB_FIRST_ROW + 1, 1)
    .setNumberFormat('@').setFontColor('#9CA3AF');
  addMonthPicker_(hs);
  return hs;
}

function applyHisaabFormatting_(hs, startRow, numRows) {
  if (numRows <= 0) return;
  const H = SHEET_FORMAT;
  hs.getRange(startRow, 1, numRows, HISAAB_HEADERS.length)
    .setFontFamily(H.font).setFontSize(H.bodySize).setFontColor(H.bodyText)
    .setBackground(H.bodyBg).setVerticalAlignment('middle').setHorizontalAlignment('left');
  hs.getRange(startRow, HC.date,       numRows).setNumberFormat('yyyy-mm-dd');
  hs.getRange(startRow, HC.usd,        numRows).setNumberFormat('$#,##0.00');
  hs.getRange(startRow, HC.roe,        numRows).setNumberFormat('0.00');
  hs.getRange(startRow, HC.gross,      numRows).setNumberFormat('"₨"#,##0');
  hs.getRange(startRow, HC.fee,        numRows).setNumberFormat('0.00%');
  hs.getRange(startRow, HC.other,      numRows).setNumberFormat('0.00%');
  hs.getRange(startRow, HC.rate,       numRows).setNumberFormat('0.00%');
  hs.getRange(startRow, HC.commission, numRows).setNumberFormat('"₨"#,##0.00').setFontWeight('bold');
  hs.getRange(startRow, HC.running,    numRows).setNumberFormat('"₨"#,##0.00');
  hs.getRange(startRow, HC.finalPkr,   numRows).setNumberFormat('"₨"#,##0');
  hs.getRange(startRow, HC.key,        numRows).setNumberFormat('@').setFontColor('#9CA3AF');
}

/** Adds a "My Hisaab" menu to the spreadsheet for a one-click refresh. */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('My Hisaab')
      .addItem('Refresh from Payments Log', 'rebuildMyHisaab')
      .addToUi();
  } catch (e) { /* not available in every context */ }
}
