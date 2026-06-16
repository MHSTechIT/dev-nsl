/* CallerLeadsTable — the shared caller-facing leads table. Columns: Name
   (+email), Phone, Sugar, Tag, Outcome, Last activity. Rows are tappable —
   onRowClick(l) opens the lead (call / note). Each caller page renders this so
   every page shares one consistent UI.

   Admin preview only: when rendered inside the "Caller page" preview drawer, a
   PreviewSelectionContext provider is present and a leading checkbox column is
   shown (select-all in the header + a checkbox per row) so the admin can pick
   leads to move. The caller's own login has no provider, so NO checkbox ever
   renders for the caller.

   Props:
     leads        array of lead rows
     onRowClick   (lead) => void   — open the lead to call / add a note
     loading      boolean
     emptyText    string shown when there are no rows
     rowStyle     (lead) => styleObj   — optional per-row background (e.g. follow-up due)
     rowRef       (lead, el) => void   — optional ref callback (scroll-to-highlight) */

import { useContext } from 'react';
import { PreviewSelectionContext } from './PreviewSelectionContext';

const VIOLET = '#5B21B6';
const INK    = '#3B0764';

const fmtPhone = (p) => (p ? `+91 ${p}` : '—');
const fmtDate = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
};
const sugarStyle = (s) => s === '250+'
  ? { bg: '#FEE2E2', fg: '#B91C1C' }
  : s === '150-250' || s === '200-250'
  ? { bg: '#FEF3C7', fg: '#B45309' }
  : { bg: '#EDE9FE', fg: '#5B21B6' };

const thS = { padding: '9px 8px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.7rem', color: 'rgba(91,33,182,0.7)', textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(124,58,237,0.15)' };
const tdS = { padding: '10px 8px', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem', color: INK, textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(209,196,240,0.35)' };

export default function CallerLeadsTable({ leads = [], onRowClick, loading = false, emptyText = 'No leads in this page.', rowStyle, rowRef }) {
  // Present only inside the admin preview drawer; null for the caller's own login.
  const sel = useContext(PreviewSelectionContext);
  const selectable = !!sel?.selectable;
  // Admin preview only: narrow the rows to the chosen webinar batch (header filter).
  const webinarFilter = sel?.webinarFilter || '';
  const shownLeads = webinarFilter ? leads.filter((l) => String(l.webinar_id) === webinarFilter) : leads;
  const colCount = selectable ? 7 : 6;
  const allIds = shownLeads.map((l) => l.id);
  const allChecked = selectable && shownLeads.length > 0 && allIds.every((id) => sel.selectedIds?.has(id));

  return (
    <div style={{ overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, background: '#F8F5FF', zIndex: 1 }}>
            {selectable && (
              <th style={{ ...thS, width: 36 }}>
                <input type="checkbox" checked={allChecked} onChange={() => sel.toggleAll(allIds)} onClick={(e) => e.stopPropagation()} />
              </th>
            )}
            <th style={{ ...thS, textAlign: 'left' }}>Name</th>
            <th style={thS}>Phone</th>
            <th style={thS}>Sugar</th>
            <th style={thS}>Tag</th>
            <th style={thS}>Outcome</th>
            <th style={thS}>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={colCount} style={{ ...tdS, padding: 24, color: 'rgba(91,33,182,0.5)' }}>Loading…</td></tr>
          ) : !shownLeads.length ? (
            <tr><td colSpan={colCount} style={{ ...tdS, padding: 24, color: 'rgba(91,33,182,0.5)' }}>{webinarFilter ? 'No leads for this batch on this page.' : emptyText}</td></tr>
          ) : shownLeads.map((l) => {
            const ss = sugarStyle(l.sugar_level);
            const checked = selectable && (sel.selectedIds?.has(l.id) || false);
            return (
              <tr
                key={l.id}
                ref={rowRef ? (el) => rowRef(l, el) : undefined}
                onClick={() => { if (onRowClick) onRowClick(l); else if (selectable) sel.toggle(l.id); }}
                style={{ cursor: (selectable || onRowClick) ? 'pointer' : 'default', transition: 'background 800ms ease', ...(checked ? { background: '#F3EEFE' } : null), ...(rowStyle ? rowStyle(l) : null) }}
              >
                {selectable && (
                  <td style={tdS}>
                    <input type="checkbox" checked={checked} onChange={() => sel.toggle(l.id)} onClick={(e) => e.stopPropagation()} />
                  </td>
                )}
                <td style={{ ...tdS, textAlign: 'left' }}>
                  <div style={{ fontWeight: 700, color: INK }}>{l.full_name || '—'}</div>
                  {l.email && <div style={{ fontSize: '0.72rem', color: 'rgba(91,33,182,0.55)' }}>{l.email}</div>}
                </td>
                <td style={{ ...tdS, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}>{fmtPhone(l.whatsapp_number)}</td>
                <td style={tdS}>{l.sugar_level
                  ? <span style={{ background: ss.bg, color: ss.fg, borderRadius: 999, padding: '2px 9px', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.72rem' }}>{l.sugar_level}</span>
                  : '—'}</td>
                <td style={tdS}>{l.lead_tag || '—'}</td>
                <td style={tdS}>{l.last_note_outcome || '—'}</td>
                <td style={{ ...tdS, color: 'rgba(91,33,182,0.6)', fontSize: '0.76rem' }}>{fmtDate(l.last_note_at || l.assigned_at || l.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
