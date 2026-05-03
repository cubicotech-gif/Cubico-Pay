/**
 * CUBICO PAY — APPS SCRIPT BACKEND
 * ============================================
 * Last modified: 2026-05-02 (single dashboard endpoint with CacheService — fast mobile loads)
 *
 * Receives POST requests from the Cubico Pay PWA, validates the shared
 * secret, and writes the payment entry directly into the "Payments Log"
 * tab. Also serves read-only GET endpoints for the in-app dashboard.
 *
 * Returns JSON with {ok: true|false, ...}.
 *
 * NOTE: After editing this file in the repo, paste the new contents into
 * the Apps Script editor and re-deploy (Manage Deployments → edit the
 * existing deployment → Save). The deployed version is stale until then.
 */

// ============================================
// CONFIG — keep these in sync with the PWA
// ============================================

// Shared secret. Must match CONFIG.TOKEN in the PWA's index.html.
// Treat like a password. Change BOTH places to rotate.
const SECRET_TOKEN = 'cube-pay-7Hk9Mn4Q8s3xL2vR';

// Sheet tab name where new entries land
const SHEET_NAME = 'Payments Log';

// ============================================
// ENDPOINTS — GET dispatch
// ============================================

/**
 * GET handler. Dispatches on ?action=...
 *
 *   (none) | ?action=health   → public health check, no auth
 *   ?action=dashboard&token=… → everything the PWA needs in one shot:
 *                               {summary, alerts, months, allEntries}
 *
 * The dashboard response is memoised in CacheService for 30 seconds, so
 * repeated taps from the phone don't repeatedly scan the sheet. doPost()
 * busts the cache so a freshly logged payment is visible immediately.
 *
 * Token is passed as a query param because Apps Script GET handlers
 * cannot read custom request headers reliably.
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'health';

  if (action === 'health') {
    return jsonResponse({
      ok: true,
      status: 'Cubico Pay backend is live',
      timestamp: new Date().toISOString()
    });
  }

  // All non-health actions require the shared secret.
  const token = e && e.parameter && e.parameter.token;
  if (token !== SECRET_TOKEN) {
    return jsonResponse({ ok: false, error: 'Unauthorized' });
  }

  try {
    if (action === 'dashboard') {
      const data = getDashboardCached_();
      return jsonResponse(Object.assign({ ok: true }, data));
    }

    return jsonResponse({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'Server error: ' + (err.message || String(err))
    });
  }
}

/**
 * Receives payment entries from the PWA.
 * Expected body: {token, paymentDate, clientName, usdAmount, account, receipt}
 */
function doPost(e) {
  try {
    // Parse the body. PWA sends as text/plain to avoid CORS preflight.
    const data = JSON.parse(e.postData.contents);

    // ---- Auth ----
    if (data.token !== SECRET_TOKEN) {
      return jsonResponse({ ok: false, error: 'Unauthorized' });
    }

    // ---- Validate required fields ----
    const required = ['paymentDate', 'clientName', 'usdAmount', 'account', 'receipt'];
    for (const field of required) {
      if (!data[field] && data[field] !== 0) {
        return jsonResponse({ ok: false, error: `Missing field: ${field}` });
      }
    }

    // ---- Parse + validate ----
    // Build payment date as a local date so timezone offset doesn't shift it
    const dateParts = String(data.paymentDate).split('-');
    if (dateParts.length !== 3) {
      return jsonResponse({ ok: false, error: 'Invalid date format. Expected YYYY-MM-DD.' });
    }
    const paymentDate = new Date(
      parseInt(dateParts[0], 10),
      parseInt(dateParts[1], 10) - 1,
      parseInt(dateParts[2], 10)
    );
    if (isNaN(paymentDate.getTime())) {
      return jsonResponse({ ok: false, error: 'Invalid payment date' });
    }

    const usdAmount = parseFloat(data.usdAmount);
    if (isNaN(usdAmount) || usdAmount <= 0) {
      return jsonResponse({ ok: false, error: 'USD amount must be a positive number' });
    }

    const clientName = String(data.clientName).trim();
    if (clientName.length === 0) {
      return jsonResponse({ ok: false, error: 'Client name cannot be empty' });
    }

    // ---- Find target sheet ----
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      return jsonResponse({ ok: false, error: `Tab "${SHEET_NAME}" not found in spreadsheet` });
    }

    // ---- Insert a fresh row at the top so newest entries appear first ----
    // After insertRowBefore(2): the new blank row is row 2, and what was
    // previously rows 2..N is now rows 3..(N+1). Existing formulas auto-
    // adjust their row references — nothing else to do for them.
    sheet.insertRowBefore(2);
    const targetRow = 2;
    const tplRow = 3; // template — first pre-filled row, now shifted down

    // Re-seed the formula / default-value columns on the new top row by
    // copying from the template row directly below it.
    //   F = PKR Amount             (formula)
    //   G = Transaction Fee %      (default 4% literal)
    //   H = Final PKR to Pay       (formula)
    //   J = Days Since Received    (formula)
    [6, 8, 10].forEach((col) => {
      const f = sheet.getRange(tplRow, col).getFormulaR1C1();
      if (f) sheet.getRange(targetRow, col).setFormulaR1C1(f);
    });
    const gVal = sheet.getRange(tplRow, 7).getValue();
    if (gVal !== '' && gVal !== null) sheet.getRange(targetRow, 7).setValue(gVal);

    // ---- Write the entry ----
    // Columns A–E come from the form, M is auto-stamped, I/K/L stay manual.
    sheet.getRange(targetRow, 1, 1, 5).setValues([[
      paymentDate, clientName, usdAmount, data.account, data.receipt
    ]]);
    sheet.getRange(targetRow, 13).setValue(new Date());

    // ---- Format the cells we just wrote ----
    sheet.getRange(targetRow, 1).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(targetRow, 3).setNumberFormat('$#,##0.00');
    sheet.getRange(targetRow, 13).setNumberFormat('yyyy-mm-dd');

    // Invalidate the dashboard cache so the new entry is visible right away.
    try { CacheService.getScriptCache().remove('dashboard_v1'); } catch (e) { /* non-fatal */ }

    return jsonResponse({
      ok: true,
      row: targetRow,
      message: `Logged $${usdAmount.toFixed(2)} from ${clientName} via ${data.account}`
    });

  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'Server error: ' + (err.message || String(err))
    });
  }
}

// ============================================
// DASHBOARD QUERIES
// ============================================

/**
 * Read every filled row from the Payments Log as plain objects.
 * "Filled" = column A (Payment Received Date) is non-empty.
 */
function readFilledRows_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Tab "${SHEET_NAME}" not found in spreadsheet`);

  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) return [];

  // Columns N (actual USD received), O (actual sender name) and P (paid
  // date, auto-stamped by onEdit) are all optional — older sheets may not
  // have them yet. Read them when present, otherwise fall back gracefully.
  const maxCols = sheet.getMaxColumns();
  const readCols = Math.max(13, Math.min(16, maxCols));

  const values = sheet.getRange(2, 1, maxRows - 1, readCols).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const a = r[0];
    if (a === '' || a === null || a === undefined) continue;
    rows.push({
      row:              i + 2,
      paymentDate:      r[0],   // Date | ''
      clientName:       r[1],
      usdAmount:        r[2],   // sender's claimed amount
      account:          r[3],
      receipt:          r[4],
      pkrAmount:        r[5],   // formula or ''
      feePct:           r[6],
      finalPKR:         r[7],   // formula or ''
      paidStatus:       r[8],
      daysSince:        r[9],   // formula or ''
      batchRef:         r[10],
      roe:              r[11],  // number or ''
      entryDate:        r[12],  // Date | ''
      actualUsdAmount:  readCols >= 14 ? r[13] : '',
      actualSenderName: readCols >= 15 ? r[14] : '',
      paidDate:         readCols >= 16 ? r[15] : ''   // Date | ''
    });
  }
  return rows;
}

function isNumeric_(v) {
  return typeof v === 'number' && !isNaN(v);
}

/**
 * Single sheet read → {summary, alerts, months, allEntries}.
 * Cached in CacheService for 30s so repeated taps from the phone don't
 * re-scan the sheet. doPost busts the cache on a successful write.
 */
function getDashboardCached_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('dashboard_v1');
  if (cached) return JSON.parse(cached);
  const data = buildDashboard_();
  try { cache.put('dashboard_v1', JSON.stringify(data), 30); } catch (e) { /* non-fatal */ }
  return data;
}

function buildDashboard_() {
  const rows = readFilledRows_();
  const tz = Session.getScriptTimeZone();
  const thisMonth = Utilities.formatDate(new Date(), tz, 'yyyy-MM');

  let totalUnpaidPKR = 0;
  let totalReceivedUSDThisMonth = 0;
  let overdueCount = 0;
  let pendingReceiptsCount = 0;

  const buckets = {};   // 'YYYY-MM' → month aggregate
  const alerts = [];    // entries needing attention

  for (const r of rows) {
    const roeSet   = isNumeric_(r.roe) && r.roe > 0;
    const isPaid   = r.paidStatus === 'Paid';
    const isUnpaid = r.paidStatus === 'Unpaid';
    const usdForBucket = isNumeric_(r.actualUsdAmount) ? r.actualUsdAmount : r.usdAmount;

    // Top-of-app summary metrics
    if (isUnpaid && roeSet && isNumeric_(r.finalPKR)) totalUnpaidPKR += r.finalPKR;
    if (isUnpaid && roeSet && isNumeric_(r.daysSince) && r.daysSince > 10) overdueCount += 1;
    if (r.receipt === 'Pending') pendingReceiptsCount += 1;

    if (r.paymentDate instanceof Date) {
      const ym = Utilities.formatDate(r.paymentDate, tz, 'yyyy-MM');
      if (ym === thisMonth && isNumeric_(usdForBucket)) {
        totalReceivedUSDThisMonth += usdForBucket;
      }

      // Per-month bucket
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

    // Worklist
    if (r.receipt !== 'Confirmed' || !isPaid) alerts.push(r);
  }

  // Order alerts and allEntries by payment date desc; entry date as tiebreaker.
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

  // Months: newest first.
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

/**
 * Group every Paid entry by batch ref. Empty batch ref → single
 * "(no batch)" bucket. Sorted by latest paid date desc.
 */
function buildPayouts_(rows) {
  const tz = Session.getScriptTimeZone();
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
        paidDates: {},     // 'yyyy-MM-dd' set
        latestPaid: null,  // Date
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

  // Latest paid date first; batches with no paid date sink to the bottom.
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
 * Common entry shape used by recent + entries. Includes every column the
 * dashboard's expanded detail view needs.
 */
function serializeEntry_(r) {
  const tz = Session.getScriptTimeZone();
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
    roe: isNumeric_(r.roe) ? r.roe : ''
  };
}

function round2_(n) {
  return Math.round(n * 100) / 100;
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
// SIMPLE TRIGGERS
// ============================================

/**
 * Watches column I (Paid status) of "Payments Log".
 *
 *   set to "Paid"  → stamp today's date into column P (Paid date),
 *                    only if P is empty (don't clobber a manual fill)
 *   anything else  → clear column P
 *
 * Also busts the dashboard CacheService entry so the change is visible
 * on the next phone open without waiting 30s for the cache to expire.
 *
 * Runs as a SIMPLE trigger (no installation needed) — Apps Script wires
 * any function literally named `onEdit` automatically.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const startCol = e.range.getColumn();
  const endCol = startCol + e.range.getNumColumns() - 1;
  // Only react when the edit overlaps column I (9) — Paid status
  if (startCol > 9 || endCol < 9) return;

  const startRow = e.range.getRow();
  const numRows = e.range.getNumRows();
  const today = new Date();

  for (let i = 0; i < numRows; i++) {
    const row = startRow + i;
    if (row < 2) continue; // skip header
    const status = sheet.getRange(row, 9).getValue();
    const paidCell = sheet.getRange(row, 16);
    const existing = paidCell.getValue();
    if (status === 'Paid') {
      if (!(existing instanceof Date)) {
        paidCell.setValue(today);
        paidCell.setNumberFormat('yyyy-mm-dd');
      }
    } else if (existing) {
      paidCell.clearContent();
    }
  }

  try { CacheService.getScriptCache().remove('dashboard_v1'); } catch (err) { /* non-fatal */ }
}
