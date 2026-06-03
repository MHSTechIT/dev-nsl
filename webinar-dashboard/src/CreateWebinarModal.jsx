import { useState, useEffect } from 'react';
import DateTimePicker from './DateTimePicker';
import { api } from './api';

/* CreateWebinarModal — the "+" dialog, modelled on Zoom's "Schedule a Webinar"
   form. Collects the webinar details + Zoom options and POSTs to /api/webinars,
   which creates the Zoom webinar with these settings. */

const VIOLET = '#5B21B6';
const VIOLET_DARK = '#3B0764';
const INK = '#3B0764';

const TIMEZONES = [
  { v: 'Asia/Kolkata', l: '(GMT+5:30) India' },
  { v: 'UTC', l: '(GMT+0:00) UTC' },
  { v: 'Asia/Dubai', l: '(GMT+4:00) Dubai' },
  { v: 'Asia/Singapore', l: '(GMT+8:00) Singapore' },
  { v: 'Europe/London', l: '(GMT) London' },
  { v: 'America/New_York', l: '(GMT-5:00) US Eastern' },
  { v: 'America/Los_Angeles', l: '(GMT-8:00) US Pacific' },
];

const genPasscode = () => String(Math.floor(100000 + Math.random() * 900000));

export default function CreateWebinarModal({ onClose, onCreated }) {
  // basics
  const [name, setName]         = useState('');
  const [agenda, setAgenda]     = useState('');
  // schedule
  const [startAt, setStartAt]   = useState('');
  const [durHr, setDurHr]       = useState(1);
  const [durMin, setDurMin]     = useState(0);
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  // batch / host
  const [batch, setBatch]       = useState('');
  const [category, setCategory] = useState('');
  const [hostId, setHostId]     = useState('');
  const [hosts, setHosts]       = useState([]);
  const [zoomReady, setZoomReady] = useState(false);
  // registration & security
  const [registration, setRegistration] = useState(true);
  const [passcodeOn, setPasscodeOn] = useState(true);
  const [passcode, setPasscode] = useState(genPasscode());
  // options
  const [qAndA, setQAndA]               = useState(true);
  const [practiceSession, setPractice]  = useState(false);
  const [hd, setHd]                     = useState(false);
  const [emailInReport, setEmailInReport] = useState(false);
  const [autoRecording, setAutoRecording] = useState('none');
  const [hostVideo, setHostVideo]       = useState(false);
  const [panelistsVideo, setPanelVideo] = useState(false);
  const [audio, setAudio]               = useState('both');
  const [altHosts, setAltHosts]         = useState('');
  // submit
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState('');

  useEffect(() => {
    api('/api/webinars/hosts').then((r) => r.json()).then((d) => {
      setHosts(d.hosts || []); setZoomReady(!!d.configured);
      if (d.hosts?.[0]) setHostId(d.hosts[0].hostId);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError('Webinar name is required.');
    if (!startAt)     return setError('Date & time is required.');
    setSubmitting(true);
    try {
      const res = await api('/api/webinars', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), start_at: startAt, batch_name: batch.trim() || null, category: category.trim() || null, host_id: hostId || null,
          duration_min: Number(durHr) * 60 + Number(durMin), timezone, agenda: agenda.trim() || null,
          registration, passcode: passcodeOn ? passcode : '',
          q_and_a: qAndA, practice_session: practiceSession, hd_video: hd, email_in_attendee_report: emailInReport,
          auto_recording: autoRecording, host_video: hostVideo, panelists_video: panelistsVideo, audio,
          alternative_hosts: altHosts.trim() || '',
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to create webinar.');
      onCreated?.(d.webinar);
      onClose?.();
    } catch (e2) { setError(e2.message || 'Something went wrong.'); }
    finally { setSubmitting(false); }
  }

  return (
    <div onMouseDown={onClose} style={overlay}>
      <div onMouseDown={(e) => e.stopPropagation()} style={card}>
        <div style={header}>
          <h2 style={{ margin: 0, fontFamily: 'Outfit, sans-serif', fontWeight: 800, fontSize: '1.1rem' }}>Schedule a Webinar</h2>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>✕</button>
        </div>

        <form onSubmit={submit} style={{ padding: '18px 24px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Section title="Webinar details">
            <Field label="Webinar name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My Webinar" style={inp} /></Field>
            <Field label="Description"><textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="Add a description (optional)" rows={2} style={{ ...inp, resize: 'vertical' }} /></Field>
          </Section>

          <Section title="Schedule">
            <Field label="Date & time"><DateTimePicker value={startAt} onChange={setStartAt} /></Field>
            <Row>
              <Field label="Duration" style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={durHr} onChange={(e) => setDurHr(+e.target.value)} style={inp}>{Array.from({ length: 25 }, (_, i) => i).map((h) => <option key={h} value={h}>{h} hr</option>)}</select>
                  <select value={durMin} onChange={(e) => setDurMin(+e.target.value)} style={inp}>{[0, 15, 30, 45].map((m) => <option key={m} value={m}>{m} min</option>)}</select>
                </div>
              </Field>
              <Field label="Time zone" style={{ flex: 1 }}>
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)} style={inp}>{TIMEZONES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select>
              </Field>
            </Row>
          </Section>

          <Section title="Batch & host">
            <Row>
              <Field label="Batch name" style={{ flex: 1 }}><input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="e.g. AWS-111" style={inp} /></Field>
              <Field label="Category" style={{ flex: 1 }}><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Meta" style={inp} /></Field>
            </Row>
            {hosts.length > 0 && (
              <Field label="Host account"><select value={hostId} onChange={(e) => setHostId(e.target.value)} style={inp}>{hosts.map((h) => <option key={h.key} value={h.hostId}>{h.label}</option>)}</select></Field>
            )}
          </Section>

          <Section title="Registration & security">
            <Check checked={registration} onChange={setRegistration}>Registration required <Muted>— needed to capture attendee name + phone</Muted></Check>
            <Check checked={passcodeOn} onChange={setPasscodeOn}>Require webinar passcode</Check>
            {passcodeOn && <input value={passcode} onChange={(e) => setPasscode(e.target.value)} style={{ ...inp, maxWidth: 180 }} />}
          </Section>

          <Section title="Options">
            <Check checked={qAndA} onChange={setQAndA}>Q&amp;A</Check>
            <Check checked={practiceSession} onChange={setPractice}>Practice session</Check>
            <Check checked={hd} onChange={setHd}>HD video (1080p)</Check>
            <Check checked={emailInReport} onChange={setEmailInReport}>Include email address in attendee report</Check>
            <Field label="Automatically record">
              <select value={autoRecording} onChange={(e) => setAutoRecording(e.target.value)} style={{ ...inp, maxWidth: 280 }}>
                <option value="none">Off</option>
                <option value="cloud">Cloud — enables chat capture</option>
                <option value="local">Local</option>
              </select>
            </Field>
            <Row>
              <Field label="Host video" style={{ flex: 1 }}><OnOff value={hostVideo} onChange={setHostVideo} /></Field>
              <Field label="Panelists video" style={{ flex: 1 }}><OnOff value={panelistsVideo} onChange={setPanelVideo} /></Field>
            </Row>
            <Field label="Audio">
              <select value={audio} onChange={(e) => setAudio(e.target.value)} style={{ ...inp, maxWidth: 220 }}>
                <option value="both">Both</option>
                <option value="telephony">Telephone</option>
                <option value="voip">Computer audio</option>
              </select>
            </Field>
          </Section>

          <Section title="Hosts">
            <Field label="Alternative hosts"><input value={altHosts} onChange={(e) => setAltHosts(e.target.value)} placeholder="email1@org.com, email2@org.com" style={inp} /></Field>
          </Section>

          {!zoomReady && (
            <div style={{ background: '#FEF6E7', border: '1px solid #F6D98A', borderRadius: 10, padding: '9px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.78rem', color: '#8A5A00' }}>
              Zoom isn’t connected — this saves the webinar with a <strong>“Zoom pending”</strong> status.
            </div>
          )}
          {error && <div style={{ color: '#B91C1C', fontFamily: 'Outfit, sans-serif', fontSize: '0.82rem' }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={{ ...btn, background: '#F3F0FD', color: VIOLET }}>Cancel</button>
            <button type="submit" disabled={submitting} style={{ ...btn, background: `linear-gradient(135deg, ${VIOLET}, ${VIOLET_DARK})`, color: '#fff', opacity: submitting ? 0.6 : 1 }}>
              {submitting ? 'Scheduling…' : 'Schedule webinar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── small helpers ──────────────────────────────────────────────────────── */
function Section({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: VIOLET, borderBottom: '1px solid rgba(124,58,237,0.15)', paddingBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
function Field({ label, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, ...style }}>
      <span style={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.72rem', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'rgba(91,33,182,0.7)' }}>{label}</span>
      {children}
    </label>
  );
}
const Row = ({ children }) => <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{children}</div>;
const Muted = ({ children }) => <span style={{ color: 'rgba(91,33,182,0.5)', fontWeight: 400 }}>{children}</span>;
function Check({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontSize: '0.86rem', color: INK }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: VIOLET, cursor: 'pointer', flexShrink: 0 }} />
      <span>{children}</span>
    </label>
  );
}
function OnOff({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', background: '#F3F0FD', borderRadius: 9, padding: 3, width: 'fit-content' }}>
      {[['On', true], ['Off', false]].map(([lbl, val]) => (
        <button key={lbl} type="button" onClick={() => onChange(val)} style={{ border: 'none', cursor: 'pointer', borderRadius: 7, padding: '5px 16px', fontFamily: 'Outfit, sans-serif', fontWeight: 600, fontSize: '0.8rem', background: value === val ? VIOLET : 'transparent', color: value === val ? '#fff' : 'rgba(91,33,182,0.6)' }}>{lbl}</button>
      ))}
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────────────────────── */
const overlay = { position: 'fixed', inset: 0, background: 'rgba(30,8,60,0.45)', zIndex: 90, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 16px', overflowY: 'auto' };
const card = { width: 'min(600px, 96vw)', background: '#fff', borderRadius: 18, boxShadow: '0 24px 60px rgba(30,8,60,0.35)' };
const header = { background: `linear-gradient(120deg, ${VIOLET_DARK}, ${VIOLET})`, color: '#fff', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: '18px 18px 0 0' };
const closeBtn = { border: 'none', background: 'rgba(255,255,255,0.18)', color: '#fff', width: 32, height: 32, borderRadius: 9, cursor: 'pointer', fontSize: '1rem', fontWeight: 800 };
const inp = { width: '100%', boxSizing: 'border-box', border: '1px solid rgba(124,58,237,0.3)', borderRadius: 10, padding: '10px 12px', fontFamily: 'Outfit, sans-serif', fontSize: '0.88rem', color: INK, outline: 'none', background: '#fff' };
const btn = { border: 'none', borderRadius: 10, padding: '11px 18px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: '0.88rem' };
