/**
 * DANISH DIARY — APPS SCRIPT BACKEND
 * ============================================
 * Personal khata / receivables tracker. Tracks money people owe you
 * (charges) and the repayments they make (partial or full). The
 * dashboard endpoint returns every person with their computed balance,
 * aging metrics, and a recent-activity feed.
 *
 * Sheets used (auto-created on first call):
 *   - "People"  — personId, name, phone, notes, archived, createdAt
 *   - "Ledger"  — entryId, personId, date, type, amount, description, createdAt
 *
 * Auth model: a single shared token between the PWA and this script.
 * Anyone with the deployed URL + the token can read/write. Fine for
 * personal use behind an unguessable Vercel URL.
 *
 * NOTE: After editing this file in the repo, paste the new contents
 * into the Apps Script editor and re-deploy (Manage Deployments →
 * edit the existing deployment → Save).
 */

// ============================================
// CONFIG — keep in sync with the PWA's CONFIG.TOKEN
// ============================================

const SECRET_TOKEN  = 'diary-7Nq2Pk5Hm8Rt3vXz9wL';
const PEOPLE_SHEET  = 'People';
const LEDGER_SHEET  = 'Ledger';
const CACHE_TTL_S   = 30;
const CACHE_KEY     = 'diary_dashboard_v1';

// Column maps (1-based)
const P = { id: 1, name: 2, phone: 3, notes: 4, archived: 5, createdAt: 6 };
const L = { id: 1, personId: 2, date: 3, type: 4, amount: 5, description: 6, createdAt: 7 };

// ============================================
// GET DISPATCH
// ============================================

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'health';

  if (action === 'health') {
    return jsonResponse({ ok: true, status: 'Danish Diary backend is live', timestamp: new Date().toISOString() });
  }

  if (!authOk_(e && e.parameter && e.parameter.token)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' });
  }

  try {
    if (action === 'dashboard') {
      return jsonResponse(Object.assign({ ok: true }, getDashboardCached_()));
    }
    if (action === 'person') {
      const personId = String((e && e.parameter && e.parameter.personId) || '');
      if (!personId) return jsonResponse({ ok: false, error: 'personId required' });
      return jsonResponse({ ok: true, person: getPersonDetail_(personId) });
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
    if (!authOk_(data.token)) return jsonResponse({ ok: false, error: 'Unauthorized' });

    const action = data.action;
    if (!action) return jsonResponse({ ok: false, error: 'Missing action' });

    if (action === 'addPerson')      return handleAddPerson_(data);
    if (action === 'updatePerson')   return handleUpdatePerson_(data);
    if (action === 'archivePerson')  return handleArchivePerson_(data);
    if (action === 'addEntry')       return handleAddEntry_(data);
    if (action === 'deleteEntry')    return handleDeleteEntry_(data);

    return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Server error: ' + (err.message || String(err)) });
  }
}

function authOk_(token) {
  return token === SECRET_TOKEN;
}

// ============================================
// SHEETS — ensure they exist with headers
// ============================================

function getPeopleSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(PEOPLE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PEOPLE_SHEET);
    sheet.getRange(1, 1, 1, 6).setValues([
      ['personId', 'name', 'phone', 'notes', 'archived', 'createdAt']
    ]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(4, 280);
  }
  return sheet;
}

function getLedgerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LEDGER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LEDGER_SHEET);
    sheet.getRange(1, 1, 1, 7).setValues([
      ['entryId', 'personId', 'date', 'type', 'amount', 'description', 'createdAt']
    ]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(6, 280);
  }
  return sheet;
}

// ============================================
// READING — full table reads
// ============================================

function readPeople_() {
  const sheet = getPeopleSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, 6).getValues();
  return values
    .map((r, i) => ({
      row: i + 2,
      personId: String(r[P.id - 1] || ''),
      name: String(r[P.name - 1] || ''),
      phone: String(r[P.phone - 1] || ''),
      notes: String(r[P.notes - 1] || ''),
      archived: toBool_(r[P.archived - 1]),
      createdAt: r[P.createdAt - 1]
    }))
    .filter((p) => p.personId);
}

function readLedger_() {
  const sheet = getLedgerSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, 7).getValues();
  return values
    .map((r, i) => ({
      row: i + 2,
      entryId: String(r[L.id - 1] || ''),
      personId: String(r[L.personId - 1] || ''),
      date: r[L.date - 1],
      type: String(r[L.type - 1] || '').toLowerCase(),
      amount: parseFloat(r[L.amount - 1]) || 0,
      description: String(r[L.description - 1] || ''),
      createdAt: r[L.createdAt - 1]
    }))
    .filter((e) => e.entryId && e.personId);
}

// ============================================
// DASHBOARD — single read, returns everything the PWA needs
// ============================================

function getDashboardCached_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);
  const data = buildDashboard_();
  try { cache.put(CACHE_KEY, JSON.stringify(data), CACHE_TTL_S); } catch (e) { /* non-fatal */ }
  return data;
}

function buildDashboard_() {
  const people = readPeople_();
  const ledger = readLedger_();
  const tz = Session.getScriptTimeZone();
  const today = startOfDay_(new Date());

  // Group ledger by personId
  const byPerson = {};
  for (const e of ledger) {
    if (!byPerson[e.personId]) byPerson[e.personId] = [];
    byPerson[e.personId].push(e);
  }

  // Compute per-person aggregates
  const computed = people.map((p) => {
    const entries = (byPerson[p.personId] || []).slice().sort(byDateAsc_);
    let totalCharged = 0, totalRepaid = 0;
    let lastActivity = null, lastRepayment = null, firstCharge = null;
    for (const e of entries) {
      if (e.type === 'charge') {
        totalCharged += e.amount;
        if (!firstCharge && e.date instanceof Date) firstCharge = e.date;
      } else if (e.type === 'repayment') {
        totalRepaid += e.amount;
        if (e.date instanceof Date && (!lastRepayment || e.date.getTime() > lastRepayment.getTime())) {
          lastRepayment = e.date;
        }
      }
      if (e.date instanceof Date && (!lastActivity || e.date.getTime() > lastActivity.getTime())) {
        lastActivity = e.date;
      }
    }
    const balance = round2_(totalCharged - totalRepaid);
    // Anchor for aging: last repayment if there is one, else first charge.
    // Falls back to today (0 days) if no dated entries exist.
    const anchor = lastRepayment || firstCharge;
    const daysSincePayment = anchor ? daysBetween_(anchor, today) : 0;
    return {
      personId: p.personId,
      name: p.name,
      phone: p.phone,
      notes: p.notes,
      archived: p.archived,
      totalCharged: round2_(totalCharged),
      totalRepaid: round2_(totalRepaid),
      balance: balance,
      entryCount: entries.length,
      lastActivity: lastActivity ? Utilities.formatDate(lastActivity, tz, 'yyyy-MM-dd') : '',
      lastRepayment: lastRepayment ? Utilities.formatDate(lastRepayment, tz, 'yyyy-MM-dd') : '',
      firstCharge: firstCharge ? Utilities.formatDate(firstCharge, tz, 'yyyy-MM-dd') : '',
      daysSincePayment: daysSincePayment
    };
  });

  // Sort: active people with positive balance first, by daysSincePayment desc.
  computed.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const aOwes = a.balance > 0, bOwes = b.balance > 0;
    if (aOwes !== bOwes) return aOwes ? -1 : 1;
    if (a.daysSincePayment !== b.daysSincePayment) return b.daysSincePayment - a.daysSincePayment;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Summary metrics (exclude archived from totals)
  let totalOutstanding = 0;
  let peopleWithBalance = 0;
  const aging = { fresh: 0, week: 0, month: 0, twoMonth: 0, old: 0 };
  for (const p of computed) {
    if (p.archived) continue;
    if (p.balance > 0) {
      totalOutstanding += p.balance;
      peopleWithBalance += 1;
      const d = p.daysSincePayment;
      if (d <= 7)       aging.fresh += 1;
      else if (d <= 30) aging.week += 1;
      else if (d <= 60) aging.month += 1;
      else if (d <= 90) aging.twoMonth += 1;
      else              aging.old += 1;
    }
  }

  // Recent activity (last 30 entries, newest first, with person name resolved)
  const peopleById = {};
  for (const p of computed) peopleById[p.personId] = p;
  const recent = ledger
    .slice()
    .sort((a, b) => {
      const ta = a.date instanceof Date ? a.date.getTime() : 0;
      const tb = b.date instanceof Date ? b.date.getTime() : 0;
      if (tb !== ta) return tb - ta;
      const ca = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
      const cb = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
      return cb - ca;
    })
    .slice(0, 30)
    .map((e) => ({
      entryId: e.entryId,
      personId: e.personId,
      personName: (peopleById[e.personId] && peopleById[e.personId].name) || '(unknown)',
      date: e.date instanceof Date ? Utilities.formatDate(e.date, tz, 'yyyy-MM-dd') : '',
      type: e.type,
      amount: round2_(e.amount),
      description: e.description
    }));

  return {
    summary: {
      totalOutstanding: round2_(totalOutstanding),
      peopleWithBalance: peopleWithBalance,
      totalPeople: computed.filter((p) => !p.archived).length,
      aging: aging
    },
    people: computed,
    recent: recent
  };
}

// ============================================
// PERSON DETAIL — full ledger for one person
// ============================================

function getPersonDetail_(personId) {
  const tz = Session.getScriptTimeZone();
  const people = readPeople_();
  const person = people.find((p) => p.personId === personId);
  if (!person) throw new Error('Person not found');
  const ledger = readLedger_().filter((e) => e.personId === personId);
  ledger.sort(byDateDesc_);
  let totalCharged = 0, totalRepaid = 0;
  for (const e of ledger) {
    if (e.type === 'charge') totalCharged += e.amount;
    else if (e.type === 'repayment') totalRepaid += e.amount;
  }
  return {
    personId: person.personId,
    name: person.name,
    phone: person.phone,
    notes: person.notes,
    archived: person.archived,
    totalCharged: round2_(totalCharged),
    totalRepaid: round2_(totalRepaid),
    balance: round2_(totalCharged - totalRepaid),
    entries: ledger.map((e) => ({
      entryId: e.entryId,
      date: e.date instanceof Date ? Utilities.formatDate(e.date, tz, 'yyyy-MM-dd') : '',
      type: e.type,
      amount: round2_(e.amount),
      description: e.description
    }))
  };
}

// ============================================
// WRITES — people
// ============================================

function handleAddPerson_(data) {
  const name = String(data.name || '').trim();
  if (!name) return jsonResponse({ ok: false, error: 'Name required' });
  const phone = normalizePhone_(data.phone);
  const notes = String(data.notes || '').trim();

  const sheet = getPeopleSheet_();
  const personId = nextPersonId_(sheet);
  sheet.appendRow([personId, name, phone, notes, false, new Date()]);
  bustCache_();
  return jsonResponse({ ok: true, personId: personId });
}

function handleUpdatePerson_(data) {
  const personId = String(data.personId || '');
  if (!personId) return jsonResponse({ ok: false, error: 'personId required' });
  const sheet = getPeopleSheet_();
  const row = findRowByValue_(sheet, P.id, personId);
  if (!row) return jsonResponse({ ok: false, error: 'Person not found' });
  if (data.name !== undefined)  sheet.getRange(row, P.name).setValue(String(data.name).trim());
  if (data.phone !== undefined) sheet.getRange(row, P.phone).setValue(normalizePhone_(data.phone));
  if (data.notes !== undefined) sheet.getRange(row, P.notes).setValue(String(data.notes).trim());
  bustCache_();
  return jsonResponse({ ok: true });
}

function handleArchivePerson_(data) {
  const personId = String(data.personId || '');
  if (!personId) return jsonResponse({ ok: false, error: 'personId required' });
  const sheet = getPeopleSheet_();
  const row = findRowByValue_(sheet, P.id, personId);
  if (!row) return jsonResponse({ ok: false, error: 'Person not found' });
  const archived = data.archived === false ? false : true;
  sheet.getRange(row, P.archived).setValue(archived);
  bustCache_();
  return jsonResponse({ ok: true });
}

// ============================================
// WRITES — ledger entries
// ============================================

function handleAddEntry_(data) {
  const personId = String(data.personId || '');
  if (!personId) return jsonResponse({ ok: false, error: 'personId required' });
  const type = String(data.type || '').toLowerCase();
  if (type !== 'charge' && type !== 'repayment') {
    return jsonResponse({ ok: false, error: "type must be 'charge' or 'repayment'" });
  }
  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) {
    return jsonResponse({ ok: false, error: 'Amount must be a positive number' });
  }
  const date = parseLocalDate_(data.date);
  if (!date) return jsonResponse({ ok: false, error: 'Invalid date (expected YYYY-MM-DD)' });
  const description = String(data.description || '').trim();

  // Confirm person exists
  const people = readPeople_();
  if (!people.find((p) => p.personId === personId)) {
    return jsonResponse({ ok: false, error: 'Person not found' });
  }

  const sheet = getLedgerSheet_();
  const entryId = nextEntryId_(sheet);
  sheet.appendRow([entryId, personId, date, type, amount, description, new Date()]);

  // Format the columns we just wrote so they look like the others.
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, L.date).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(newRow, L.amount).setNumberFormat('#,##0.00');
  sheet.getRange(newRow, L.createdAt).setNumberFormat('yyyy-mm-dd hh:mm');

  bustCache_();
  return jsonResponse({ ok: true, entryId: entryId });
}

function handleDeleteEntry_(data) {
  const entryId = String(data.entryId || '');
  if (!entryId) return jsonResponse({ ok: false, error: 'entryId required' });
  const sheet = getLedgerSheet_();
  const row = findRowByValue_(sheet, L.id, entryId);
  if (!row) return jsonResponse({ ok: false, error: 'Entry not found' });
  sheet.deleteRow(row);
  bustCache_();
  return jsonResponse({ ok: true });
}

// ============================================
// ID GENERATION
// ============================================

function nextPersonId_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 'p001';
  const values = sheet.getRange(2, P.id, last - 1, 1).getValues();
  let maxN = 0;
  for (const r of values) {
    const m = String(r[0] || '').match(/^p(\d+)$/i);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return 'p' + String(maxN + 1).padStart(3, '0');
}

function nextEntryId_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 'e00001';
  const values = sheet.getRange(2, L.id, last - 1, 1).getValues();
  let maxN = 0;
  for (const r of values) {
    const m = String(r[0] || '').match(/^e(\d+)$/i);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return 'e' + String(maxN + 1).padStart(5, '0');
}

// ============================================
// HELPERS
// ============================================

function findRowByValue_(sheet, col, target) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const values = sheet.getRange(2, col, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(target)) return i + 2;
  }
  return 0;
}

function parseLocalDate_(s) {
  if (!s) return null;
  const parts = String(s).split('-');
  if (parts.length !== 3) return null;
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween_(a, b) {
  const ms = startOfDay_(b).getTime() - startOfDay_(a).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function byDateAsc_(a, b) {
  const ta = a.date instanceof Date ? a.date.getTime() : 0;
  const tb = b.date instanceof Date ? b.date.getTime() : 0;
  return ta - tb;
}
function byDateDesc_(a, b) { return byDateAsc_(b, a); }

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function toBool_(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function normalizePhone_(p) {
  // Strip everything that isn't a digit. WhatsApp's wa.me format wants
  // the international number without the leading +. The PWA reminds the
  // user to enter country code; we just clean it.
  return String(p || '').replace(/[^\d]/g, '');
}

function bustCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) { /* non-fatal */ }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
