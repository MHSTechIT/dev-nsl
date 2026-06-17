/* Shared "LeadOpportunity (crm.lead)" CSV layout for lead exports. Maps a row
   from /api/admin/sales-performance/leads-export to the standard column order
   used across the business. */

const CSV_STATUS = {
  completed: 'Completed', follow_up: 'Follow Up', not_interested: 'Not Interested',
  not_picked: 'Not Picked', auto_paused: 'Not Picked', incomplete: 'Incomplete',
};
const CSV_SUGAR = {
  '250+': 'Above 250', '150-250': '150 - 250', '200-250': '200 - 250',
  '100-200': '100 - 200', 'no_diabetes': 'No Diabetes',
};
const csvYesNo = (v) => {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase();
  if (s === 'yes' || v === true || s === 'true') return 'Yes';
  if (s === 'no'  || v === false || s === 'false') return 'No';
  return v;
};
const csvCreated = (ts) => ts
  ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
  : '';

export const LEAD_EXPORT_HEADER = [
  'Opportunity', 'Call Status', 'Email', 'Salesperson', 'Batch Code', 'Age',
  'Gender', 'Lead Source', 'Location', 'Sugar Level', 'Whatsapp No.',
  'Webinar Attended', 'Remarks', 'Occupation', 'Occupation Remarks',
  'Language', 'Created on', 'Available for Webinar', 'Phone',
];

export function leadToExportRow(l) {
  return [
    l.full_name,
    l.next_batch_parked
      ? 'Next Batch'
      : l.last_note_outcome ? (CSV_STATUS[l.last_note_outcome] || l.last_note_outcome) : 'New',
    l.email,
    l.assigned_to_name,
    l.webinar_name,
    l.note_age || l.age_group,
    '',                                       // Gender — not captured in the CRM
    l.utm_source || l.source,
    l.note_location,
    CSV_SUGAR[l.sugar_level] || l.sugar_level,
    l.whatsapp_number,
    csvYesNo(l.note_webinar_attended),
    l.note_text,
    l.note_occupation || l.occupation,
    '',                                       // Occupation Remarks — not captured
    l.language_pref,
    csvCreated(l.created_at),
    csvYesNo(l.note_available),
    l.whatsapp_number,
  ];
}

export function leadsToExportCsv(leads) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [LEAD_EXPORT_HEADER, ...leads.map(leadToExportRow)]
    .map(row => row.map(esc).join(',')).join('\n');
}
