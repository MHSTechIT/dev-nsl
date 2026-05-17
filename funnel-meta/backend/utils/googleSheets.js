const { google } = require('googleapis');

function getAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var not set');
  const key = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/**
 * Writes all leads to the configured Google Sheet.
 * Clears Sheet1 first, then writes header + all rows.
 * Returns the number of lead rows written.
 */
async function writeLeadsToSheet(leads) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID env var not set');

  const auth  = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const HEADERS = [
    'S.No',
    'Name',
    'WhatsApp Number',
    'Email',
    'Sugar Level',
    'Diabetes Duration',
    'Language',
    'Lead Score',
    'WA Clicked',
    'UTM Source',
    'UTM Campaign',
    'UTM Content',
    'FB Click ID',
    'Registered At (IST)',
  ];

  const rows = leads.map((lead, i) => [
    i + 1,
    lead.full_name        || '',
    lead.whatsapp_number  || '',
    lead.email            || '',
    lead.sugar_level      || '',
    lead.diabetes_duration|| '',
    lead.language_pref    || '',
    lead.lead_score       ?? '',
    lead.wa_clicked ? 'Yes' : 'No',
    lead.utm_source       || '',
    lead.utm_campaign     || '',
    lead.utm_content      || '',
    lead.fbclid           || '',
    lead.created_at
      ? new Date(lead.created_at).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true,
        })
      : '',
  ]);

  // 1. Clear the whole sheet
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Sheet1',
  });

  // 2. Write header + data in one shot
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS, ...rows] },
  });

  // 3. Bold + freeze the header row
  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheetGid = meta.sheets[0].properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Bold header
        {
          repeatCell: {
            range: { sheetId: sheetGid, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        // Freeze header row
        {
          updateSheetProperties: {
            properties: { sheetId: sheetGid, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
      ],
    },
  });

  return rows.length;
}

module.exports = { writeLeadsToSheet };
