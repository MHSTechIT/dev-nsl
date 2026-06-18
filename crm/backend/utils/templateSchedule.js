/*
 * templateSchedule — turn a template's (day_offset, send_time) into the absolute
 * instant it should be sent, relative to the current webinar's date/time (IST).
 *
 * Two offset kinds:
 *   • DAY      ("3 Days To Go", "webinar_day", "1_before", …) → shift the webinar
 *              DATE by N days and use send_time (HH:MM IST) for the time of day.
 *   • RELATIVE ("8 Hours To Go", "30 Minutes To Go", "I Am Live") → webinar
 *              datetime minus N hours/minutes; send_time is ignored (the offset
 *              already pins the exact moment).
 *
 * All clock math is IST (UTC+5:30) so it matches what the admin sees.
 */
const IST_MS = (5 * 60 + 30) * 60 * 1000;

/* Classify a day_offset string → { kind:'relative', minutes } or { kind:'day', days }. */
function resolveOffset(dayOffset) {
  const s = String(dayOffset || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/(\d+)\s*hours?\s*to\s*go/)))            return { kind: 'relative', minutes: -Number(m[1]) * 60 };
  if ((m = s.match(/(\d+)\s*min(?:ute)?s?\s*to\s*go/)))     return { kind: 'relative', minutes: -Number(m[1]) };
  if (/i\s*am\s*live/.test(s))                              return { kind: 'relative', minutes: 0 };
  if ((m = s.match(/(\d+)\s*days?\s*to\s*go/)))             return { kind: 'day', days: -Number(m[1]) };
  if (s === 'webinar_day' || s === 'webinar day')          return { kind: 'day', days: 0 };
  if ((m = s.match(/^(\d+)_before$/)))                      return { kind: 'day', days: -Number(m[1]) };
  if ((m = s.match(/^(\d+)_after$/)))                       return { kind: 'day', days:  Number(m[1]) };
  return { kind: 'day', days: 0 };   // default: webinar day
}

/* Parse a send_time string → { hh, mm } in 24h IST, or null. Handles
   "01:00 pm", "11:00 am", "13:00", and messy prefixes like
   "22 February, 1:00 pm" / "5:45, 06:00, 06:15 PM" (takes the first time). */
function parseSendTime(sendTime) {
  if (!sendTime) return null;
  const s = String(sendTime);
  let m = s.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m/i);
  if (m) { let hh = Number(m[1]) % 12; if (/p/i.test(m[3])) hh += 12; return { hh, mm: Number(m[2]) }; }
  m = s.match(/(\d{1,2}):(\d{2})/);              // 24h
  if (m) { const hh = Number(m[1]), mm = Number(m[2]); if (hh < 24 && mm < 60) return { hh, mm }; }
  return null;
}

/* IST calendar parts of an instant. */
function istParts(date) {
  const ist = new Date(date.getTime() + IST_MS);
  return { y: ist.getUTCFullYear(), mo: ist.getUTCMonth(), d: ist.getUTCDate(), hh: ist.getUTCHours(), mm: ist.getUTCMinutes() };
}

/* Build a UTC Date from IST y/mo/d hh:mm (overflowing days roll over correctly). */
function istToUtc(y, mo, d, hh, mm) {
  return new Date(Date.UTC(y, mo, d, hh, mm) - IST_MS);
}

/* The absolute instant a template should be sent for a given webinar datetime.
   @param webinarDatetime ISO string / Date — the webinar start.
   @returns Date, or null if the webinar datetime is invalid. */
function computeSendAt(webinarDatetime, dayOffset, sendTime) {
  const w = new Date(webinarDatetime);
  if (isNaN(w.getTime())) return null;
  const off = resolveOffset(dayOffset);
  if (off.kind === 'relative') {
    return new Date(w.getTime() + off.minutes * 60 * 1000);
  }
  const p = istParts(w);
  const t = parseSendTime(sendTime) || { hh: p.hh, mm: p.mm };   // fall back to webinar time of day
  return istToUtc(p.y, p.mo, p.d + off.days, t.hh, t.mm);
}

module.exports = { resolveOffset, parseSendTime, computeSendAt };
