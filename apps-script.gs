/**
 * CUBICO PAY — APPS SCRIPT BACKEND
 * ============================================
 * Last modified: 2026-05-11 (role-based auth: admin + client accounts)
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
  currency:   19,  screenshotUrl: 20
};

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
        clientId: session.clientId
      });
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
    sheet.getRange(1, 1, 1, 7).setValues([
      ['username', 'passwordHash', 'salt', 'role', 'clientId', 'active', 'createdAt']
    ]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(2, 320);
    sheet.setColumnWidth(3, 220);
  }
  return sheet;
}

function findUser_(username) {
  const sheet = getUsersSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const u = normUsername_(username);
  const values = sheet.getRange(2, 1, last - 1, 7).getValues();
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
        createdAt: r[6]
      };
    }
  }
  return null;
}

function listUsers_() {
  const sheet = getUsersSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, 7).getValues();
  return values.map((r) => ({
    username: String(r[0] || ''),
    role: String(r[3] || ''),
    clientId: String(r[4] || ''),
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
  if (session.role === 'client') {
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

  // Currency the amount was received in (recorded only — no conversion).
  const currency = (String(data.currency || 'USD').trim().toUpperCase()) || 'USD';
  sheet.getRange(targetRow, COL.currency).setValue(currency);

  // Optional payment screenshot — saved to Drive, link stored in the row.
  if (data.screenshot) {
    try {
      const url = saveScreenshot_(data.screenshot, clientName, paymentDate);
      if (url) sheet.getRange(targetRow, COL.screenshotUrl).setValue(url);
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
  const readCols = Math.max(13, Math.min(20, maxCols));

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
      screenshotUrl:    readCols >= 20 ? String(r[19] || '') : ''
    });
  }
  return rows;
}

function isNumeric_(v) {
  return typeof v === 'number' && !isNaN(v);
}

function getDashboardCached_(session) {
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
  }

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
    const isUnpaid = r.paidStatus === 'Unpaid';
    const usdForBucket = isNumeric_(r.actualUsdAmount) ? r.actualUsdAmount : r.usdAmount;

    if (isUnpaid && roeSet && isNumeric_(r.finalPKR)) totalUnpaidPKR += r.finalPKR;
    if (isUnpaid && roeSet && isNumeric_(r.daysSince) && r.daysSince > 10) overdueCount += 1;
    if (r.receipt === 'Pending') pendingReceiptsCount += 1;

    if (r.paymentDate instanceof Date) {
      const ym = Utilities.formatDate(r.paymentDate, tz, 'yyyy-MM');
      if (ym === thisMonth && isNumeric_(usdForBucket)) {
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
    alerts: alerts.map(serializeEntry_),
    months: months,
    payouts: buildPayouts_(rows),
    allEntries: allEntries.map(serializeEntry_)
  };
}

function buildPayouts_(rows) {
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
      entries: b.entries.map(serializeEntry_)
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

function serializeEntry_(r) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return {
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
    screenshotUrl: r.screenshotUrl || ''
  };
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
