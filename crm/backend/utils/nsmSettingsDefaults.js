/**
 * Default NSM-Caller settings — the WhatsApp reminder cadence from the client
 * doc, seeded as editable templates. The Settings page lets the admin edit
 * every field; mergeNsmSettings() overlays saved edits on top of these so new
 * code-added templates still appear and saved edits persist.
 *
 * offset_minutes: signed minutes relative to the batch's webinar_at
 *   (negative = before the webinar, 0 = at start).
 * type: 'text' | 'image' | 'video' | 'poll'
 * Placeholders filled at send time: {batch_name} {webinar_date} {webinar_time}
 *   {webinar_link} {meeting_id}
 */

const TEMPLATES = [
  {
    key: '1day_casestudy',
    label: '1 Day To Go — Case Study',
    enabled: true,
    type: 'video',
    offset_minutes: -1440,
    media_url: '',
    content:
`🎥 "நானும் இதே நிலைல தான் இருந்தேன்…"

Real People…. Real Transformation….

இந்த testimonial-ல பாருங்க, ஒரு சாதாரண மனிதர் எப்படி diabetes-ஐ control பண்ண ஆரம்பிச்சார் 👇👉 இது possible-ன்னு prove பண்ணுற ஒரு story

நீங்களும் இதே மாதிரி change வேண்டும்னு நினைத்தீங்கனா…

📅 Date: {webinar_date}
⏰ Time: {webinar_time}

Limited Spots Available!

🎯 Masterclass-ல முழு method-ஐ explain பண்ணப்போறோம்.`,
    poll: { title: '', options: [] },
  },
  {
    key: '1day_poll',
    label: '1 Day To Go — Poll',
    enabled: true,
    type: 'poll',
    offset_minutes: -1080,
    media_url: '',
    content:
`🚨 இன்னும் 1 நாள் மட்டுமே மீதம்! 🚨
🎁 உங்களுக்கான இலவச பரிசு! 🎁
நீங்கள் சக்கரை நோய் அபாயத்தில் இருக்கிறீர்களா? 🤔 இலவச சக்கரை நோய் மதிப்பீடு செய்யுங்கள் & உடனே அறியுங்கள்! 📊
✅ தனிப்பட்ட ஆரோக்கிய மதிப்பீடு பெறுங்கள்
✅ உங்கள் அபாய நிலையை அறியுங்கள்
Bonus: https://bit.ly/Findyourdiabetesscore
📅 Masterclass Date: {webinar_date}
⏰ Time: {webinar_time}
🩺 Don't Miss This Chance to Reverse Diabetes Naturally!`,
    poll: {
      title: 'நாளைக்கு Diabetes Reversal Masterclass-ல join பண்ண ready-ஆ இருக்கீங்களா?',
      options: ['✅ ஆமா — கண்டிப்பா join பண்றேன்!', '🤔 Maybe — try பண்றேன்', '❌ இல்ல — இந்த week முடியல'],
    },
  },
  {
    key: 'liveday_announce',
    label: 'Live Day — Announcement',
    enabled: true,
    type: 'video',
    offset_minutes: -600,
    media_url: '',
    content:
`🌟 Today is the Day! 🌟
🚀 உங்கள் ஆரோக்கியம் உங்கள் கையில் – இன்று நம்முடைய சக்கரை நோய் மாற்றம் வெபினார்! 🚀
📢 Dr. Prabhakar Raj உடன் இணைந்து இயற்கையாக சக்கரை நோயை கட்டுப்படுத்த தயாராக இருக்கவும்!
📅 தேதி: {webinar_date}
⏰ நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
💡 Join us LIVE & take the first step towards a diabetes-free life!`,
    poll: { title: '', options: [] },
  },
  {
    key: '8h',
    label: '8 Hours To Go',
    enabled: true,
    type: 'image',
    offset_minutes: -480,
    media_url: '',
    content:
`⏳ Only 8 Hours Left! Don't Miss Out!
🚀 இன்று சக்கரை நோய் மாற்றம் வெபினார் நடைபெற உள்ளது! 🚀
⏳ இன்னும் 8 மணி நேரத்தில், Dr. Prabhakar Raj பகிர இருக்கிறார்:
✅ சக்கரை நோயின் உண்மையான காரணம் என்ன?
✅ உங்கள் மருத்துவர் சொல்லாத மறைக்கப்பட்ட உண்மை!
📅 தேதி: {webinar_date}
🕕 நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
💥 Only 1000 Seats are available!`,
    poll: { title: '', options: [] },
  },
  {
    key: '5h',
    label: '5 Hours To Go',
    enabled: true,
    type: 'image',
    offset_minutes: -300,
    media_url: '',
    content:
`⏳ இன்னும் 5 மணி நேரம் மட்டுமே! நேரம் விரைந்து ஓடுகிறது!
🚀 Your LAST CHANCE to Join the Diabetes Reversal Webinar! 🚀
In just 5 hours, Dr. Prabhakar Raj will reveal:
✅ The root cause of diabetes – what no one talks about!
📅 தேதி: {webinar_date}
🕔 நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
⚠️ இடங்கள் மிக குறைவாக உள்ளன!`,
    poll: { title: '', options: [] },
  },
  {
    key: '3h',
    label: '3 Hours To Go',
    enabled: true,
    type: 'image',
    offset_minutes: -180,
    media_url: '',
    content:
`⏳ இன்னும் 3 மணி நேரத்தில் வாழ்க்கையை மாற்றும் வெபினார்!
🔥 சக்கரை நோய் மாற்றும் வெபினார் மிக விரைவில் தொடங்குகிறது! 🔥
📅 தேதி: {webinar_date}
⏰ நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
⚠️ This is your FINAL CALL!`,
    poll: { title: '', options: [] },
  },
  {
    key: '1h',
    label: '1 Hour To Go',
    enabled: true,
    type: 'image',
    offset_minutes: -60,
    media_url: '',
    content:
`⏳ Only 1 Hour Left! Join the Diabetes Reversal Webinar NOW!
🚨 இன்னும் 1 மணி நேரத்தில் வெபினார் தொடங்கவுள்ளது!
📅 தேதி: {webinar_date}
⏰ நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
👉 Click the link & enter the webinar NOW!`,
    poll: { title: '', options: [] },
  },
  {
    key: '30m',
    label: '30 Minutes To Go',
    enabled: true,
    type: 'image',
    offset_minutes: -30,
    media_url: '',
    content:
`⏳ Only 30 Minutes Left! Join the Diabetes Reversal Webinar NOW!
🚀 நாங்கள் LIVE ஆக போகிறோம்! வெபினார் தவற விடாதீர்கள்!
📅 தேதி: {webinar_date}
⏰ நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
⏳ இன்னும் 30 நிமிடங்கள் மட்டுமே – உடனே இணையுங்கள்!`,
    poll: { title: '', options: [] },
  },
  {
    key: 'i_am_live',
    label: 'I Am Live',
    enabled: true,
    type: 'image',
    offset_minutes: 0,
    media_url: '',
    content:
`🚀 I AM LIVE Now!
🚀 நாங்கள் இப்போது நேரலையில்! உடனே இணையுங்கள்!
🎥 Dr. Prabhakar Raj இப்போது LIVE-ல்!
📅 தேதி: {webinar_date}
⏰ நேரம்: {webinar_time}
🔗 வெபினார் லிங்க்: {webinar_link}
🆔 Meeting ID: {meeting_id}
Only few seats are available!`,
    poll: { title: '', options: [] },
  },
];

const DEFAULTS = { whatsapp: { enabled: true, templates: TEMPLATES } };

/* Overlay saved settings on top of the code defaults. Saved templates override
   defaults by `key` (field-merged); new default templates still surface; extra
   saved-only templates are kept. */
function mergeNsmSettings(stored) {
  stored = stored && typeof stored === 'object' ? stored : {};
  const sw = stored.whatsapp || {};
  const storedTpls = Array.isArray(sw.templates) ? sw.templates : [];
  const byKey = {};
  for (const t of storedTpls) if (t && t.key) byKey[t.key] = t;

  const templates = DEFAULTS.whatsapp.templates.map(def => {
    const ov = byKey[def.key];
    if (!ov) return { ...def };
    return {
      ...def,
      ...ov,
      offset_minutes: ov.offset_minutes != null ? ov.offset_minutes : def.offset_minutes,
      poll: { ...(def.poll || {}), ...(ov.poll || {}) },
    };
  });
  for (const t of storedTpls) {
    if (t && t.key && !templates.find(x => x.key === t.key)) templates.push(t);
  }

  return {
    whatsapp: {
      enabled: sw.enabled != null ? !!sw.enabled : DEFAULTS.whatsapp.enabled,
      templates,
    },
  };
}

module.exports = { DEFAULTS, mergeNsmSettings };
