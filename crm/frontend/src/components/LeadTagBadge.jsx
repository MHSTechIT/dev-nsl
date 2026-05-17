import { classifyLeadTag, TAG_STYLES } from '../utils/leadTagging';

/* Tag pill — live HOT / WARM / COLD / JUNK classification based on the
   set of fields a caller has filled so far. Renders nothing-yet "—" when
   the form is empty. */
export default function LeadTagBadge({ fields, size = 'md' }) {
  const tag = classifyLeadTag(fields);

  if (!tag) {
    return (
      <span style={pillStyle({ bg: 'rgba(91,33,182,0.08)', fg: 'rgba(91,33,182,0.55)' }, size)}>
        <span style={{ marginRight: 6, opacity: 0.6 }}>—</span>
        Not classified yet
      </span>
    );
  }

  const s = TAG_STYLES[tag];
  return (
    <span style={pillStyle(s, size)}>
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: s.dot, marginRight: 7,
        boxShadow: `0 0 0 3px ${s.bg}`,
      }} />
      {s.label}
    </span>
  );
}

function pillStyle(s, size) {
  const pad   = size === 'sm' ? '3px 9px'  : '5px 12px';
  const font  = size === 'sm' ? '0.68rem'  : '0.78rem';
  return {
    display: 'inline-flex', alignItems: 'center',
    padding: pad, borderRadius: 50,
    background: s.bg, color: s.fg,
    fontWeight: 800, fontSize: font,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    fontFamily: 'Outfit, sans-serif',
  };
}
