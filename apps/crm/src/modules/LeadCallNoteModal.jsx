import { useState, useEffect } from 'react';
import DateTimePicker from '../admin/DateTimePicker';

/* ──────────────────────────────────────────────────────────────────────────
   Lead Call Note Modal — opens when caller clicks the pencil icon on a lead.
   Captures the post-call form, then either:
     • Complete Call → marks lead completed, moves to Completed Leads
     • Follow Up + Date/Time → moves to Completed Leads with a follow-up tag,
       reappears in Assigned at the scheduled time
   ────────────────────────────────────────────────────────────────────────── */

const RANGES = [
  { value: '250+',         label: '250+' },
  { value: '200-250',      label: '200–250' },
  { value: '100-200',      label: '100–200' },
  { value: 'no_diabetes',  label: 'No Diabetes' },
];

const AGE_BUCKETS = [
  { value: '0-18',     label: '0–18' },
  { value: '19-24',    label: '19–24' },
  { value: '25-34',    label: '25–34' },
  { value: '35-44',    label: '35–44' },
  { value: '45-54',    label: '45–54' },
  { value: 'above-54', label: 'Above 54' },
];

const RANGE_FOR  = [{ value: 'personal', label: 'Personal' }, { value: 'family', label: 'For Family' }];
const DIET       = [{ value: 'yes', label: 'Yes' }, { value: 'not_interested', label: 'Not Interested' }];
const MEDICINE   = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];

export default function LeadCallNoteModal({ jwt, lead, onClose, onSaved }) {
  const [fullName, setFullName]                   = useState(lead.full_name || '');
  const [confirmedRange, setConfirmedRange]       = useState('');
  const [rangeFor, setRangeFor]                   = useState('personal');
  const [patientAge, setPatientAge]               = useState('');
  const [dietStatus, setDietStatus]               = useState('');
  const [takesMedicine, setTakesMedicine]         = useState('');
  const [note, setNote]                           = useState('');
  const [interested, setInterested]               = useState('');   // '' | 'yes' | 'no'
  const [wantsFollowUp, setWantsFollowUp]         = useState(false);
  const [followUpAtLocal, setFollowUpAtLocal]     = useState(''); // 'YYYY-MM-DDTHH:mm:ss' (local time, from DateTimePicker)
  const [error, setError]                         = useState('');
  const [saving, setSaving]                       = useState(false);
  const [recalling, setRecalling]                 = useState(false);
  const [recallToast, setRecallToast]             = useState('');

  async function handleRecall() {
    if (recalling) return;
    setRecalling(true);
    setRecallToast('');
    try {
      const res = await fetch('/api/caller/calls/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ lead_id: lead.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to start call');
      setRecallToast('Calling…');
      setTimeout(() => setRecallToast(''), 2500);
    } catch (e) {
      setRecallToast(e.message || 'Recall failed');
      setTimeout(() => setRecallToast(''), 3500);
    } finally {
      setRecalling(false);
    }
  }

  /* Derived submission outcome:
     follow-up wins if checked; otherwise interested choice maps to completed/not_interested. */
  const derivedOutcome = wantsFollowUp
    ? 'follow_up'
    : interested === 'yes'
      ? 'completed'
      : interested === 'no'
        ? 'not_interested'
        : '';

  /* Validation mode is determined by selections:
       1. Interested = NO        → nothing is mandatory (caller may submit minimal info)
       2. Follow Up   = ON       → Note + Date + Time mandatory; others optional
       3. Default                → Confirm Range, "value for", Age, Diet, Medicine mandatory; Note optional
     Submit always requires at least one of Interested or Follow Up to be selected. */
  const noOverride        = interested === 'no';
  const followUpOnly      = !noOverride && wantsFollowUp;
  const detailsMandatory  = !noOverride && !wantsFollowUp;   // default mode

  function validate() {
    if (!fullName.trim()) return 'Name cannot be empty.';
    // Interested choice is ALWAYS required — no other selection can override this.
    if (interested !== 'yes' && interested !== 'no') {
      return 'Pick Interested — Yes or No.';
    }

    if (noOverride) {
      // NO mode: only Name (already validated above) and Note are mandatory
      if (!note.trim())  return 'Add a brief note about the not-interested reason.';
      return null;
    }

    if (followUpOnly) {
      if (!note.trim())                   return 'Please add a note about the follow-up.';
      if (!followUpAtLocal)               return 'Pick a follow-up date and time.';
      return null;
    }
    // detailsMandatory — full default form
    if (!confirmedRange) return 'Pick the patient’s confirmed sugar range.';
    if (!rangeFor)       return 'Pick whether the value is for personal or family use.';
    if (!patientAge)     return 'Pick the patient age range.';
    if (!dietStatus)     return 'Select diet preference.';
    if (!takesMedicine)  return 'Pick whether the patient takes medicine.';
    return null;
  }

  async function submitDnp() {
    if (!confirm('Are you sure to move this lead to not picked calls?')) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name: fullName.trim() || null,
          outcome:   'not_picked',
          call_id:   lead.last_call_id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save.');
      // Hang up whatever call is currently active for this lead (handles the
      // Recall case where lead.last_call_id is the old, already-ended call).
      fetch(`/api/caller/leads/${lead.id}/hangup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
      }).catch(() => {});
      onSaved?.('not_picked');
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    const v = validate();
    if (v) { setError(v); return; }

    let followUpAt = null;
    if (wantsFollowUp && followUpAtLocal) {
      // DateTimePicker emits a local datetime string ('YYYY-MM-DDTHH:mm:ss').
      // Parse it as local time → ISO UTC for storage.
      const [date, time] = followUpAtLocal.split('T');
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm, ss = 0] = (time || '').split(':').map(Number);
      const local = new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
      followUpAt = local.toISOString();
    }

    setSaving(true);
    setError('');
    try {
      // Derive sugar_confirmation from the comparison so legacy display logic still works
      const sugarConfirmation = confirmedRange === lead.sugar_level ? 'same' : 'different';
      const res = await fetch(`/api/caller/leads/${lead.id}/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({
          full_name:          fullName.trim(),
          sugar_confirmation: sugarConfirmation,
          confirmed_range:    confirmedRange || null,
          range_for:          rangeFor,
          patient_age:        patientAge,
          diet_status:        dietStatus,
          takes_medicine:     takesMedicine || null,
          note:               note.trim() || null,
          outcome:            derivedOutcome,
          follow_up_at:       followUpAt,
          call_id:            lead.last_call_id || null,
          interested:         interested || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save.');

      // Best-effort hang up whatever call is currently active for this lead.
      // Targeting the lead (not a stale call_id) means a Recall-then-Complete
      // sequence still terminates the new call, not the old one.
      fetch(`/api/caller/leads/${lead.id}/hangup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
      }).catch(() => { /* ignore — user already moved on */ });

      onSaved?.(derivedOutcome);
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(15,0,40,0.45)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
        animation: 'fadeIn 200ms ease',
      }}
    >
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      `}</style>

      <div style={{
        width: '100%', maxWidth: 560, maxHeight: '92vh',
        background: 'rgba(255,255,255,0.97)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 22,
        border: '1px solid rgba(147,51,234,0.18)',
        boxShadow: '0 24px 64px rgba(91,33,182,0.30)',
        padding: '24px 22px 18px',
        fontFamily: 'Outfit, sans-serif',
        animation: 'scaleIn 200ms ease',
        // Whole modal scrolls as one unit — header + form + Complete Call button
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10 }}>
          <div>
            <h2 style={{ fontWeight: 700, fontSize: '1.05rem', color: '#3B0764', margin: 0 }}>Fill up call details</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={handleRecall} disabled={recalling} aria-label="Recall lead"
              title={recalling ? 'Calling…' : 'Call this lead again'}
              style={{
                height: 30, padding: '0 12px', borderRadius: 8, border: 'none',
                background: recalling ? 'rgba(22,163,74,0.50)' : 'linear-gradient(135deg,#16A34A,#15803D)',
                color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.78rem',
                cursor: recalling ? 'wait' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 5,
                boxShadow: recalling ? 'none' : '0 2px 8px rgba(22,163,74,0.35)',
                whiteSpace: 'nowrap',
              }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
              {recalling ? 'Calling…' : 'Recall'}
            </button>
            <button onClick={onClose} aria-label="Close"
              style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'rgba(91,33,182,0.08)', color: '#5B21B6', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        {recallToast && (
          <div style={{
            margin: '-6px 0 12px', padding: '8px 12px', borderRadius: 8,
            background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.30)',
            color: '#15803D', fontSize: '0.80rem', fontWeight: 600,
          }}>{recallToast}</div>
        )}

        <div>
          {/* Lead name — pre-filled, editable */}
          <FieldRow label="1. Name" mandatory>
            <input
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="Patient name"
              style={inputStyle}
              maxLength={120}
            />
          </FieldRow>

          {/* Mandatory confirmed range — registered value shown inline as a hint */}
          <FieldRow
            label={
              <>
                2. Confirm Range{' '}
                <span style={{ fontWeight: 500, color: 'rgba(91,33,182,0.65)', fontStyle: 'italic' }}>
                  (registered as <span style={{ fontWeight: 700, color: '#3B0764' }}>{lead.sugar_level || '—'}</span>)
                </span>
              </>
            }
            mandatory={detailsMandatory}
          >
            <RadioRow options={RANGES} value={confirmedRange} onChange={setConfirmedRange} wrap />
          </FieldRow>

          {/* Range purpose */}
          <FieldRow label="3. This value is for" mandatory={detailsMandatory}>
            <RadioRow options={RANGE_FOR} value={rangeFor} onChange={setRangeFor} />
          </FieldRow>

          {/* Patient age */}
          <FieldRow label="4. Patient Age" mandatory={detailsMandatory}>
            <RadioRow options={AGE_BUCKETS} value={patientAge} onChange={setPatientAge} wrap />
          </FieldRow>

          {/* Diet */}
          <FieldRow label="5. Diet" mandatory={detailsMandatory}>
            <RadioRow options={DIET} value={dietStatus} onChange={setDietStatus} />
          </FieldRow>

          {/* Medicine */}
          <FieldRow label="6. Medicine" mandatory={detailsMandatory} hint={detailsMandatory ? null : '(optional)'}>
            <RadioRow options={MEDICINE} value={takesMedicine} onChange={setTakesMedicine} />
          </FieldRow>

          {/* Note */}
          <FieldRow label="7. Note" mandatory={followUpOnly || noOverride} hint={(followUpOnly || noOverride) ? null : '(optional)'}>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Anything noteworthy from the conversation…"
              rows={3}
              style={{
                width: '100%', padding: '10px 12px',
                borderRadius: 10, border: '1px solid rgba(209,196,240,0.7)',
                background: 'rgba(237,234,248,0.30)',
                fontFamily: 'Outfit,sans-serif', fontSize: '0.86rem', color: '#3B0764',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box',
              }}
            />
          </FieldRow>

          {/* Follow-up schedule — appears only after the caller toggles "Follow Up" on */}
          {wantsFollowUp && (
            <FieldRow label="8. Follow-up schedule" mandatory>
              <DateTimePicker
                value={followUpAtLocal}
                onChange={setFollowUpAtLocal}
                placeholder="Pick the callback date & time"
              />
            </FieldRow>
          )}

          {error && (
            <div style={{ background: 'rgba(254,242,242,0.95)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 10, padding: '8px 12px', marginTop: 6 }}>
              <p style={{ fontSize: '0.80rem', color: '#DC2626', margin: 0 }}>⚠ {error}</p>
            </div>
          )}

          {/* Two independent dimensions:
                - INTERESTED — yes / no / unset (one-of)
                - FOLLOW UP  — toggle (can combine with either YES or NO)        */}
          <div style={{ marginTop: 18, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {/* Interested YES / NO segmented toggle */}
            <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.74rem',
                color: '#3B0764', letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>
                Interested <span style={{ color: '#DC2626', marginLeft: 2 }}>*</span>
              </span>
              <div style={{
                display: 'flex',
                background: 'rgba(237,234,248,0.50)',
                border: '1px solid rgba(209,196,240,0.7)',
                borderRadius: 14, padding: 4, gap: 4,
              }}>
                <button
                  type="button"
                  onClick={() => setInterested(interested === 'yes' ? '' : 'yes')}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 10, border: 'none',
                    background: interested === 'yes' ? '#10B981' : 'transparent',
                    color: interested === 'yes' ? '#fff' : 'rgba(91,33,182,0.65)',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                    cursor: 'pointer',
                    boxShadow: interested === 'yes' ? '0 4px 12px rgba(16,185,129,0.30)' : 'none',
                    transition: 'all 150ms',
                  }}
                >
                  YES
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const turningOn = interested !== 'no';
                    setInterested(turningOn ? 'no' : '');
                    // NO and Follow Up are mutually exclusive
                    if (turningOn) setWantsFollowUp(false);
                  }}
                  style={{
                    flex: 1, padding: '10px 14px', borderRadius: 10, border: 'none',
                    background: interested === 'no' ? '#DC2626' : 'transparent',
                    color: interested === 'no' ? '#fff' : 'rgba(91,33,182,0.65)',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.86rem',
                    cursor: 'pointer',
                    boxShadow: interested === 'no' ? '0 4px 12px rgba(220,38,38,0.30)' : 'none',
                    transition: 'all 150ms',
                  }}
                >
                  NO
                </button>
              </div>
            </div>

            {/* Follow Up — independent toggle; auto-sets Interested = YES when turned on */}
            <button
              type="button"
              onClick={() => {
                setWantsFollowUp(v => {
                  const next = !v;
                  if (next) {
                    // Turning Follow Up on → default Interested to YES if it isn't already
                    // (NO is mutually exclusive with Follow Up, so override that case too)
                    if (interested !== 'yes') setInterested('yes');
                  }
                  return next;
                });
              }}
              style={{
                flex: '1 1 200px',
                alignSelf: 'flex-end',
                height: '2.85rem',
                padding: '0 18px', borderRadius: 14, border: 'none',
                background: wantsFollowUp ? '#F59E0B' : 'rgba(245,158,11,0.10)',
                color: wantsFollowUp ? '#fff' : '#B45309',
                fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.92rem',
                cursor: 'pointer',
                boxShadow: wantsFollowUp ? '0 4px 16px rgba(245,158,11,0.35)' : 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'all 150ms',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              Follow Up
            </button>
          </div>

        </div>

        {/* Submit */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(209,196,240,0.40)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            type="button"
            onClick={submitDnp}
            disabled={saving}
            title="Lead didn't pick up — move to Not Picked"
            style={{ width: '100%', height: '2.5rem', borderRadius: 50,
                     border: '1.5px solid #B45309',
                     background: saving ? 'rgba(245,158,11,0.20)' : 'rgba(245,158,11,0.10)',
                     color: '#B45309', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.86rem',
                     cursor: saving ? 'not-allowed' : 'pointer',
                     letterSpacing: '0.04em' }}
          >
            DNP — Did Not Pick
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !(interested === 'yes' || interested === 'no')}
            style={{ width: '100%', height: '2.8rem', borderRadius: 50, border: 'none',
                     background: saving ? 'rgba(5,150,105,0.55)' : '#059669',
                     color: '#fff', fontFamily: 'Outfit,sans-serif', fontWeight: 700, fontSize: '0.92rem',
                     cursor: saving ? 'not-allowed' : 'pointer',
                     boxShadow: '0 4px 16px rgba(5,150,105,0.35)',
                     opacity: (interested === 'yes' || interested === 'no') ? 1 : 0.6 }}
          >
            {saving ? 'Saving…' : 'Complete Call'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Subcomponents ── */

function FieldRow({ label, mandatory, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={fieldLabelStyle}>{label}</span>
        {mandatory && <span style={{ color: '#DC2626', fontSize: '0.70rem' }}>*</span>}
        {hint && <span style={{ color: 'rgba(91,33,182,0.45)', fontSize: '0.70rem', fontWeight: 500 }}>{hint}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function RadioRow({ options, value, onChange, wrap }) {
  return (
    <div style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 6 }}>
      {options.map(opt => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              padding: '7px 14px', borderRadius: 10,
              border: selected ? 'none' : '1px solid rgba(91,33,182,0.20)',
              background: selected ? '#5B21B6' : '#fff',
              color: selected ? '#fff' : 'rgba(91,33,182,0.75)',
              fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.78rem',
              cursor: 'pointer', whiteSpace: 'nowrap',
              boxShadow: selected ? '0 2px 8px rgba(91,33,182,0.25)' : 'none',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ReadonlyChip({ value, captured }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 12px', borderRadius: 50,
      background: 'rgba(5,150,105,0.10)', color: '#047857',
      fontSize: '0.84rem', fontWeight: 600,
      alignSelf: 'flex-start',
    }}>
      {value}
      {captured && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      )}
    </span>
  );
}

const fieldLabelStyle = {
  fontSize: '0.80rem',
  fontWeight: 700,
  color: '#3B0764',
};

const inputStyle = {
  width: '100%', height: '2.6rem', padding: '0 12px',
  borderRadius: 10,
  border: '1px solid rgba(209,196,240,0.8)',
  background: 'rgba(237,234,248,0.30)',
  fontFamily: 'Outfit,sans-serif', fontSize: '0.88rem',
  color: '#3B0764', outline: 'none', boxSizing: 'border-box',
};
