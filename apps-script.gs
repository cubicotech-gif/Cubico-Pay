/**
 * CUBICO PAY — APPS SCRIPT BACKEND (Phase 2)
 * ============================================
 *
 * Receives POST requests from the Cubico Pay PWA, validates the shared
 * secret, and writes the payment entry directly into the "Payments Log"
 * tab. Returns JSON with {ok: true|false, ...}.
 *
 * Deployment: see step-by-step instructions in the chat.
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
// ENDPOINTS
// ============================================

/**
 * Health check. Visit the deployment URL in a browser to confirm it works.
 * Should return: {"ok":true,"status":"Cubico Pay backend is live"}
 */
function doGet(e) {
  return jsonResponse({
    ok: true,
    status: 'Cubico Pay backend is live',
    timestamp: new Date().toISOString()
  });
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
// HELPERS
// ============================================

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
