/**
 * CUBICO PAY — APPS SCRIPT BACKEND
 * ============================================
 * Last modified: 2026-05-02
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
 *   ?action=summary&token=…   → aggregated metrics for the dashboard
 *   ?action=recent&token=…    → latest entries by Entry Date desc
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
    if (action === 'summary') return jsonResponse({ ok: true, summary: buildSummary() });

    if (action === 'recent') {
      const rawLimit = parseInt(e.parameter.limit, 10);
      const limit = isNaN(rawLimit) ? 10 : Math.max(1, Math.min(50, rawLimit));
      return jsonResponse({ ok: true, entries: buildRecent(limit) });
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

    // ---- Find next empty row by scanning column A (Payment Received Date) ----
    // Column A is empty for unfilled rows even though F/H/J have formulas,
    // because formulas there return "" when their inputs are empty.
    const maxRows = sheet.getMaxRows();
    const colA = sheet.getRange(2, 1, maxRows - 1, 1).getValues();
    let nextRow = -1;
    for (let i = 0; i < colA.length; i++) {
      const v = colA[i][0];
      if (v === '' || v === null || v === undefined) {
        nextRow = i + 2;
        break;
      }
    }
    if (nextRow === -1) {
      return jsonResponse({
        ok: false,
        error: 'Payments Log is full. Extend the row range in your sheet.'
      });
    }

    // ---- Write the entry ----
    // Columns:
    //   A = Payment Received Date  (from form)
    //   B = Client / Sender Name   (from form)
    //   C = USD Amount             (from form)
    //   D = Account                (from form)
    //   E = Receipt Confirmation   (from form)
    //   F = PKR Amount             (formula — pre-existing)
    //   G = Transaction Fee %      (default 4% — pre-existing)
    //   H = Final PKR to Pay       (formula — pre-existing)
    //   I = Paid Status            (manual, later)
    //   J = Days Since Received    (formula — pre-existing)
    //   K = Disbursement Batch Ref (manual, later)
    //   L = ROE PKR per USD        (manual, later)
    //   M = Entry Date             (auto-stamped now)
    sheet.getRange(nextRow, 1, 1, 5).setValues([[
      paymentDate, clientName, usdAmount, data.account, data.receipt
    ]]);
    sheet.getRange(nextRow, 13).setValue(new Date());

    // ---- Format the cells we just wrote ----
    sheet.getRange(nextRow, 1).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(nextRow, 3).setNumberFormat('$#,##0.00');
    sheet.getRange(nextRow, 13).setNumberFormat('yyyy-mm-dd');

    return jsonResponse({
      ok: true,
      row: nextRow,
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

  const values = sheet.getRange(2, 1, maxRows - 1, 13).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const a = r[0];
    if (a === '' || a === null || a === undefined) continue;
    rows.push({
      row:          i + 2,
      paymentDate:  r[0],   // Date | ''
      clientName:   r[1],
      usdAmount:    r[2],
      account:      r[3],
      receipt:      r[4],
      pkrAmount:    r[5],   // formula or ''
      feePct:       r[6],
      finalPKR:     r[7],   // formula or ''
      paidStatus:   r[8],
      daysSince:    r[9],   // formula or ''
      batchRef:     r[10],
      roe:          r[11],  // number or ''
      entryDate:    r[12]   // Date | ''
    });
  }
  return rows;
}

function isNumeric_(v) {
  return typeof v === 'number' && !isNaN(v);
}

function buildSummary() {
  const rows = readFilledRows_();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const thisMonth = Utilities.formatDate(now, tz, 'yyyy-MM');

  let totalUnpaidPKR = 0;
  let totalReceivedUSDThisMonth = 0;
  let overdueCount = 0;
  let pendingReceiptsCount = 0;

  for (const r of rows) {
    const roeSet = isNumeric_(r.roe) && r.roe > 0;
    const isUnpaid = r.paidStatus === 'Unpaid';

    if (isUnpaid && roeSet && isNumeric_(r.finalPKR)) {
      totalUnpaidPKR += r.finalPKR;
    }

    if (isUnpaid && roeSet && isNumeric_(r.daysSince) && r.daysSince > 10) {
      overdueCount += 1;
    }

    if (r.receipt === 'Pending') pendingReceiptsCount += 1;

    if (r.paymentDate instanceof Date && isNumeric_(r.usdAmount)) {
      const ym = Utilities.formatDate(r.paymentDate, tz, 'yyyy-MM');
      if (ym === thisMonth) totalReceivedUSDThisMonth += r.usdAmount;
    }
  }

  return {
    totalUnpaidPKR: round2_(totalUnpaidPKR),
    totalReceivedUSDThisMonth: round2_(totalReceivedUSDThisMonth),
    overdueCount: overdueCount,
    pendingReceiptsCount: pendingReceiptsCount,
    totalEntries: rows.length
  };
}

function buildRecent(limit) {
  const rows = readFilledRows_();
  const tz = Session.getScriptTimeZone();

  // Sort by Entry Date desc; rows without an entry date sink to the bottom.
  rows.sort((a, b) => {
    const ta = a.entryDate instanceof Date ? a.entryDate.getTime() : -Infinity;
    const tb = b.entryDate instanceof Date ? b.entryDate.getTime() : -Infinity;
    return tb - ta;
  });

  return rows.slice(0, limit).map((r) => ({
    row: r.row,
    paymentDate: r.paymentDate instanceof Date
      ? Utilities.formatDate(r.paymentDate, tz, 'yyyy-MM-dd') : '',
    clientName: r.clientName || '',
    usdAmount: isNumeric_(r.usdAmount) ? round2_(r.usdAmount) : '',
    account: r.account || '',
    receipt: r.receipt || '',
    paidStatus: r.paidStatus || '',
    daysSince: isNumeric_(r.daysSince) ? r.daysSince : '',
    finalPKR: isNumeric_(r.finalPKR) ? round2_(r.finalPKR) : '',
    roe: isNumeric_(r.roe) ? r.roe : ''
  }));
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
