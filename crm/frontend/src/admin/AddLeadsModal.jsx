import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';

/* AddLeadsModal — "Add Leads" upload flow for the Meta Temp Lead Registry.
   Upload a CSV/Excel sheet → parse → preview rows EXCLUDING any whose phone
   already exists in the current batch (existingPhones) → confirm to bulk-insert
   into the Meta Temp leads (POST /api/admin/leads/import).

   Required per row: Name + a 10-digit phone. Optional: Email, Sugar Level,
   Duration, Ad Source. Duplicates (phone already in the current batch or
   repeated within the file) and invalid rows are counted but not shown. */

const PURPLE = '#5B21B6';

// Header matching — case-insensitive "contains". Order matters (first hit wins).
const COLS = {
  name:     ['full name', 'lead name', 'name'],
  phone:    ['whatsapp', 'phone', 'mobile', 'contact', 'number'],
  email:    ['email', 'mail'],
  sugar:    ['sugar'],
  duration: ['duration'],
  ad:       ['ad source', 'ad_source', 'adsource', 'utm', 'campaign', 'source'],
};

function findIdx(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex(h => h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

function mapSugar(raw) {
  const v = String(raw || '').toLowerCase().replace(/\s/g, '');
  if (!v) return null;
  if (v.includes('250+') || v === '250' || v.includes('>250') || v.includes('250plus')) return '250+';
  if (v.includes('150') || v.includes('200') || v.includes('100-200')) return '150-250';
  return null;
}
function mapDuration(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (['new', 'mid', 'long', 'pre'].includes(v)) return v;
  if (v.includes('pre')) return 'pre';
  if (v.includes('new') || v.includes('recent')) return 'new';
  if (v.includes('long')) return 'long';
  if (v.includes('mid')) return 'mid';
  return null;
}

export default function AddLeadsModal({ token, source = 'metatemp', existingPhones, onClose, onImported }) {
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing]   = useState(false);
  const [parseErr, setParseErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const [resultMsg, setResultMsg] = useState('');
  // Parsed buckets
  const [rows, setRows]         = useState([]);   // valid + non-duplicate (shown)
  const [dupCount, setDupCount] = useState(0);
  const [invalidCount, setInvalidCount] = useState(0);

  const existing = useMemo(
    () => (existingPhones instanceof Set ? existingPhones : new Set(existingPhones || [])),
    [existingPhones]
  );

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseErr(''); setResultMsg(''); setRows([]); setDupCount(0); setInvalidCount(0);
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const wb  = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
      if (!aoa.length) { setParseErr('The file looks empty.'); setParsing(false); return; }

      const headers = (aoa[0] || []).map(h => String(h).toLowerCase().trim());
      const iName = findIdx(headers, COLS.name);
      const iPhone = findIdx(headers, COLS.phone);
      const iEmail = findIdx(headers, COLS.email);
      const iSugar = findIdx(headers, COLS.sugar);
      const iDur = findIdx(headers, COLS.duration);
      const iAd = findIdx(headers, COLS.ad);
      if (iName === -1 || iPhone === -1) {
        setParseErr('Could not find a Name and Phone column in the header row.');
        setParsing(false);
        return;
      }

      const seenInFile = new Set();
      const good = [];
      let dup = 0, invalid = 0;
      for (let r = 1; r < aoa.length; r++) {
        const row = aoa[r] || [];
        const full_name = String(row[iName] ?? '').trim();
        const phone = String(row[iPhone] ?? '').replace(/\D/g, '').slice(-10);
        if (full_name.length < 1 || !/^\d{10}$/.test(phone)) { invalid++; continue; }
        if (existing.has(phone) || seenInFile.has(phone)) { dup++; continue; }
        seenInFile.add(phone);
        good.push({
          full_name,
          whatsapp_number: phone,
          email: iEmail !== -1 ? String(row[iEmail] ?? '').trim() : '',
          sugar_level: iSugar !== -1 ? mapSugar(row[iSugar]) : null,
          diabetes_duration: iDur !== -1 ? mapDuration(row[iDur]) : null,
          utm_source: iAd !== -1 ? String(row[iAd] ?? '').trim() : '',
        });
      }
      setRows(good); setDupCount(dup); setInvalidCount(invalid);
      if (!good.length) setParseErr(dup || invalid ? 'No new leads to add (all rows were duplicates or invalid).' : 'No rows found.');
    } catch (err) {
      setParseErr('Could not read the file. Make sure it is a valid CSV or Excel file.');
    } finally {
      setParsing(false);
    }
  }

  async function handleUpload() {
    if (!rows.length || uploading) return;
    setUploading(true); setResultMsg('');
    try {
      const res = await fetch(`/api/admin/leads/import?source=${encodeURIComponent(source)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, leads: rows }),
      });
      const data = await res.json();
      if (!res.ok) { setResultMsg(data.error || `Upload failed (${res.status}).`); setUploading(false); return; }
      if (typeof onImported === 'function') onImported(data);
      onClose();
    } catch {
      setResultMsg('Network error during upload.');
      setUploading(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(59,7,100,0.35)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        fontFamily: 'Outfit, sans-serif',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(720px, 96vw)', maxHeight: '88vh', overflow: 'hidden',
          background: '#fff', borderRadius: 20, display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 70px rgba(91,33,182,0.30)',
        }}
      >
        {/* Header */}
        <div style={{ padding: '18px 22px', borderBottom: '1px solid rgba(209,196,240,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontWeight: 800, fontSize: '1.1rem', color: '#3B0764' }}>Add Leads</h3>
            <p style={{ margin: '3px 0 0', fontSize: '0.8rem', color: 'rgba(91,33,182,0.55)' }}>
              Upload a CSV or Excel sheet · current-batch duplicates are removed automatically
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'rgba(91,33,182,0.08)', color: PURPLE, width: 34, height: 34, borderRadius: 10, cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: 22, overflowY: 'auto' }}>
          {/* Upload dropzone */}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={{
              width: '100%', border: '2px dashed rgba(124,58,237,0.40)', borderRadius: 14,
              background: 'rgba(124,58,237,0.04)', padding: '26px 18px', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={PURPLE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span style={{ fontWeight: 700, color: '#3B0764', fontSize: '0.92rem' }}>
              {fileName || 'Click to choose a CSV / Excel file'}
            </span>
            <span style={{ fontSize: '0.74rem', color: 'rgba(91,33,182,0.55)' }}>
              Required columns: <b>Name</b> &amp; <b>Phone</b> · optional: Email, Sugar Level, Duration, Ad Source
            </span>
          </button>
          <input
            ref={fileRef} type="file" accept=".csv,.xlsx,.xls"
            onChange={handleFile} style={{ display: 'none' }}
          />

          {parsing && <p style={{ marginTop: 14, color: PURPLE, fontWeight: 600, fontSize: '0.85rem' }}>Reading file…</p>}
          {parseErr && <p style={{ marginTop: 14, color: '#DC2626', fontWeight: 600, fontSize: '0.85rem' }}>{parseErr}</p>}

          {/* Summary chips */}
          {(rows.length > 0 || dupCount > 0 || invalidCount > 0) && (
            <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Chip bg="rgba(5,150,105,0.10)" fg="#059669" label={`${rows.length} new to add`} />
              {dupCount > 0 && <Chip bg="rgba(217,119,6,0.10)" fg="#D97706" label={`${dupCount} duplicate${dupCount === 1 ? '' : 's'} skipped`} />}
              {invalidCount > 0 && <Chip bg="rgba(220,38,38,0.10)" fg="#DC2626" label={`${invalidCount} invalid skipped`} />}
            </div>
          )}

          {/* Preview sheet — new leads only (duplicates excluded) */}
          {rows.length > 0 && (
            <div style={{ marginTop: 16, border: '1px solid rgba(209,196,240,0.6)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ background: 'rgba(124,58,237,0.06)', position: 'sticky', top: 0 }}>
                      {['Name', 'Phone', 'Email', 'Sugar', 'Duration', 'Ad Source'].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '9px 12px', color: PURPLE, fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(209,196,240,0.4)' }}>
                        <td style={{ padding: '8px 12px', color: '#3B0764', fontWeight: 600 }}>{r.full_name}</td>
                        <td style={{ padding: '8px 12px', color: '#3B0764' }}>{r.whatsapp_number}</td>
                        <td style={{ padding: '8px 12px', color: 'rgba(59,7,100,0.75)' }}>{r.email || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'rgba(59,7,100,0.75)' }}>{r.sugar_level || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'rgba(59,7,100,0.75)' }}>{r.diabetes_duration || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'rgba(59,7,100,0.75)' }}>{r.utm_source || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {resultMsg && <p style={{ marginTop: 14, color: '#DC2626', fontWeight: 600, fontSize: '0.85rem' }}>{resultMsg}</p>}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 22px', borderTop: '1px solid rgba(209,196,240,0.5)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={onClose}
            style={{ height: '2.6rem', padding: '0 18px', borderRadius: 50, border: '1.5px solid rgba(139,92,246,0.30)', background: 'rgba(237,234,248,0.7)', color: PURPLE, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleUpload}
            disabled={!rows.length || uploading}
            style={{
              height: '2.6rem', padding: '0 22px', borderRadius: 50, border: 'none',
              background: rows.length && !uploading ? 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)' : 'rgba(91,33,182,0.30)',
              color: '#fff', fontWeight: 800, fontSize: '0.85rem',
              cursor: rows.length && !uploading ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            {uploading ? 'Uploading…' : `Upload ${rows.length || ''} lead${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Chip({ bg, fg, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 12px', borderRadius: 50, background: bg, color: fg, fontWeight: 700, fontSize: '0.78rem' }}>
      {label}
    </span>
  );
}
