import { useState } from 'react';
import DateTimePicker from '../admin/DateTimePicker';
import {
  RANGES, AGE_BUCKETS, RANGE_FOR, MEDICINE, YES_NO, HBA1C,
  WORKING_PROFESSIONAL, LOCATIONS,
} from './LeadCallNoteModal';

/* ────────────────────────────────────────────────────────────────────────
   Edit-only modal for a completed lead's call note. Pre-fills with the
   stored `last_note_*` values from the parent lead row, lets the caller
   change any field, then POSTs to /api/caller/leads/:id/note. The endpoint
   already inserts a new note row each call — so an "edit" is just a fresh
   row that becomes the latest via LATERAL JOIN. History is preserved.

   Intentionally slim: no auto-call state machine, no Tata recall, no
   timers — this is purely a data-editor for after-the-fact corrections.
   ──────────────────────────────────────────────────────────────────────── */

function toLocalDatetime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

export default function EditCallNoteModal({ jwt, lead, onClose, onSaved }) {
  const initialOutcome  = lead.last_note_outcome === 'follow_up' ? 'follow_up'
                        : lead.last_note_outcome === 'not_interested' ? 'not_interested'
                        : 'completed';
  const initialInterested = lead.last_note_interested_in_note || lead.last_note_interested || '';
  const initialFollowUp   = lead.last_note_follow_up_at || lead.follow_up_at || '';

  const [fullName, setFullName]                       = useState(lead.full_name || '');
  const [confirmedRange, setConfirmedRange]           = useState(lead.last_note_confirmed_range || '');
  const [rangeFor, setRangeFor]                       = useState(lead.last_note_range_for || 'personal');
  const [patientAge, setPatientAge]                   = useState(lead.last_note_patient_age || '');
  const [takesMedicine, setTakesMedicine]             = useState(lead.last_note_takes_medicine || '');
  const [hba1c, setHba1c]                             = useState(lead.last_note_hba1c || '');
  const [otherLanguages, setOtherLanguages]           = useState(lead.last_note_other_languages || '');
  const [workingProfessional, setWorkingProfessional] = useState(lead.last_note_working_professional || '');
  const [location, setLocation]                       = useState(lead.last_note_location || '');
  const [alreadyPaid, setAlreadyPaid]                 = useState(lead.last_note_already_paid || '');
  const [webinarAttended, setWebinarAttended]         = useState(lead.last_note_webinar_attended || '');
  const [availableForWebinar, setAvailableForWebinar] = useState(lead.last_note_available_for_webinar || '');
  const [nextBatchJoining, setNextBatchJoining]       = useState(lead.last_note_next_batch_joining || '');
  const [note, setNote]                               = useState(lead.last_note_text || '');
  const [interested, setInterested]                   = useState(initialInterested);
  const [outcome, setOutcome]                         = useState(initialOutcome);
  const [followUpAtLocal, setFollowUpAtLocal]         = useState(toLocalDatetime(initialFollowUp));
  const [saving, setSaving]                           = useState(false);
  const [error, setError]                             = useState('');

  async function handleSubmit() {
    setError('');
    if (interested !== 'yes' && interested !== 'no') {
      setError('Please pick whether the lead is interested.');
      return;
    }
    if (outcome === 'follow_up' && !followUpAtLocal) {
      setError('Pick a follow-up date and time.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name:             fullName,
          sugar_confirmation:    lead.last_note_sugar_confirmation || null,
          confirmed_range:       confirmedRange || null,
          range_for:             rangeFor || null,
          patient_age:           patientAge || null,
          takes_medicine:        takesMedicine || null,
          hba1c:                 hba1c || null,
          other_languages:       otherLanguages || null,
          working_professional:  workingProfessional || null,
          location:              location || null,
          already_paid:          alreadyPaid || null,
          webinar_attended:      webinarAttended || null,
          available_for_webinar: availableForWebinar || null,
          next_batch_joining:    nextBatchJoining || null,
          note:                  note || null,
          outcome,
          follow_up_at:          outcome === 'follow_up' && followUpAtLocal
                                   ? new Date(followUpAtLocal).toISOString() : null,
          call_id:               null, // edit isn't tied to a new call
          interested,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(e.message || 'Network error');
      setSaving(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontWeight: 700, fontSize: '1.05rem', color: '#3B0764' }}>Edit call details</h2>
          <button onClick={onClose} aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: 6, border: 'none', background: 'rgba(91,33,182,0.08)', color: '#5B21B6', cursor: 'pointer' }}>
            ✕
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <Field label="1. Name" wide>
            <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} style={inputStyle} maxLength={120} />
          </Field>

          <Field label="2. Phone Number" wide>
            <input type="text" value={lead.whatsapp_number ? '+91 ' + lead.whatsapp_number : '—'} readOnly
              style={{ ...inputStyle, background: 'rgba(237,234,248,0.50)', cursor: 'default' }} />
          </Field>

          <Field label="3. Confirm Range">
            <Pills options={RANGES} value={confirmedRange} onChange={setConfirmedRange} />
          </Field>

          <Field label="4. This value is for">
            <Pills options={RANGE_FOR} value={rangeFor} onChange={setRangeFor} />
          </Field>

          <Field label="5. Patient Age">
            <Pills options={AGE_BUCKETS} value={patientAge} onChange={setPatientAge} />
          </Field>

          <Field label="6. HbA1c">
            <Pills options={HBA1C} value={hba1c} onChange={setHba1c} />
          </Field>

          <Field label="7. Medicine">
            <Pills options={MEDICINE} value={takesMedicine} onChange={setTakesMedicine} />
          </Field>

          <Field label="8. Other Languages">
            <Pills options={YES_NO} value={otherLanguages} onChange={setOtherLanguages} />
          </Field>

          <Field label="9. Working Professional">
            <Select value={workingProfessional} onChange={setWorkingProfessional} options={WORKING_PROFESSIONAL} placeholder="Select occupation…" />
          </Field>

          <Field label="10. Location">
            <Select value={location} onChange={setLocation} options={LOCATIONS} placeholder="Select location…" />
          </Field>

          <Field label="11. Already Paid">
            <Pills options={YES_NO} value={alreadyPaid} onChange={setAlreadyPaid} />
          </Field>

          <Field label="12. Webinar Attended">
            <Pills options={YES_NO} value={webinarAttended} onChange={setWebinarAttended} />
          </Field>

          <Field label="13. Available for Webinar">
            <Pills options={YES_NO} value={availableForWebinar} onChange={setAvailableForWebinar} />
          </Field>

          <Field label="14. Next Batch Joining">
            <Pills options={YES_NO} value={nextBatchJoining} onChange={setNextBatchJoining} />
          </Field>

          <Field label="15. Note" wide>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              placeholder="Anything noteworthy from the conversation…"
              style={{ ...inputStyle, height: 'auto', padding: '10px 12px', resize: 'vertical' }} />
          </Field>
        </div>

        {/* Interested + Follow-up controls */}
        <div style={{ marginTop: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <div style={fieldLabel}>Interested *</div>
            <div style={{ display: 'flex', gap: 4, background: 'rgba(237,234,248,0.50)', border: '1px solid rgba(209,196,240,0.7)', borderRadius: 8, padding: 4 }}>
              <button type="button" onClick={() => { setInterested('yes'); if (outcome === 'not_interested') setOutcome('completed'); }}
                style={pillBtn(interested === 'yes', '#10B981')}>YES</button>
              <button type="button" onClick={() => { setInterested('no'); setOutcome('not_interested'); }}
                style={pillBtn(interested === 'no', '#DC2626')}>NO</button>
            </div>
          </div>

          <button type="button"
            onClick={() => setOutcome(outcome === 'follow_up' ? 'completed' : 'follow_up')}
            style={{
              flex: '1 1 200px', height: '2.85rem', padding: '0 18px', borderRadius: 8, border: 'none',
              background: outcome === 'follow_up' ? '#F59E0B' : 'rgba(245,158,11,0.10)',
              color: outcome === 'follow_up' ? '#fff' : '#B45309',
              fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.92rem', cursor: 'pointer',
            }}>
            Follow Up
          </button>
        </div>

        {outcome === 'follow_up' && (
          <div style={{ marginTop: 12 }}>
            <div style={fieldLabel}>Follow-up schedule *</div>
            <DateTimePicker value={followUpAtLocal} onChange={setFollowUpAtLocal} placeholder="Pick the callback date & time" />
          </div>
        )}

        {error && (
          <div style={{ marginTop: 14, padding: '8px 12px', background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 6 }}>
            <p style={{ margin: 0, fontSize: '0.80rem', color: '#DC2626' }}>⚠ {error}</p>
          </div>
        )}

        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.40)', display: 'flex', gap: 10 }}>
          <button onClick={onClose} disabled={saving}
            style={{ flex: 1, height: '2.6rem', borderRadius: 6, border: '1px solid rgba(91,33,182,0.25)', background: 'rgba(237,234,248,0.50)', color: '#5B21B6', fontFamily: 'Outfit,sans-serif', fontWeight: 700, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving}
            style={{ flex: 2, height: '2.6rem', borderRadius: 6, border: 'none', background: saving ? 'rgba(5,150,105,0.55)' : '#059669', color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, cursor: saving ? 'wait' : 'pointer', boxShadow: '0 4px 12px rgba(5,150,105,0.30)' }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Subcomponents ── */
function Field({ label, wide, children }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : undefined }}>
      <div style={fieldLabel}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Pills({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {options.map(opt => {
        const sel = value === opt.value;
        return (
          <button key={opt.value} type="button" onClick={() => onChange(opt.value)}
            style={{
              padding: '5px 10px', borderRadius: 5,
              border: sel ? 'none' : '1px solid rgba(91,33,182,0.20)',
              background: sel ? '#5B21B6' : '#fff',
              color: sel ? '#fff' : 'rgba(91,33,182,0.75)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.72rem',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}>{opt.label}</button>
        );
      })}
    </div>
  );
}

function Select({ value, onChange, options, placeholder }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? '#3B0764' : 'rgba(91,33,182,0.50)', cursor: 'pointer' }}>
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function pillBtn(active, activeColor) {
  return {
    flex: 1, padding: '10px 14px', borderRadius: 6, border: 'none',
    background: active ? activeColor : 'transparent',
    color: active ? '#fff' : 'rgba(91,33,182,0.65)',
    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
    cursor: 'pointer',
  };
}

/* ── Styles ── */
const overlayStyle = {
  position: 'fixed', inset: 0, zIndex: 100,
  background: 'rgba(15,0,40,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 20, overflowY: 'auto',
};

const modalStyle = {
  width: '100%', maxWidth: 920, maxHeight: '92vh',
  background: '#fff', borderRadius: 12,
  border: '1px solid rgba(147,51,234,0.18)',
  boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
  padding: '24px 22px 18px',
  fontFamily: 'Outfit, sans-serif',
  overflowY: 'auto',
};

const inputStyle = {
  width: '100%', height: '2.6rem', padding: '0 12px',
  borderRadius: 6,
  border: '1px solid rgba(209,196,240,0.8)',
  background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem',
  color: '#3B0764', outline: 'none', boxSizing: 'border-box',
};

const fieldLabel = {
  fontFamily: 'Outfit, sans-serif',
  fontSize: '0.74rem',
  fontWeight: 700,
  color: '#3B0764',
  marginBottom: 6,
  letterSpacing: '0.02em',
};
