export function getCountdownParts(targetISO) {
  if (!targetISO) return { days: 0, hrs: 0, min: 0, sec: 0, isNearStart: false, isDuringSession: false };

  const now = Date.now();
  const target = new Date(targetISO).getTime();
  const diff = target - now;
  const sessionDuration = 3 * 60 * 60 * 1000; // 3 hours

  const isDuringSession = diff < 0 && Math.abs(diff) < sessionDuration;
  const isNearStart = diff > 0 && diff < 2 * 60 * 60 * 1000;
  const isUrgent = diff > 0 && diff < 24 * 60 * 60 * 1000;

  if (diff <= 0 && !isDuringSession) {
    return { days: 0, hrs: 0, min: 0, sec: 0, isNearStart: false, isUrgent: false, isDuringSession: false };
  }

  const totalSec = Math.max(0, Math.floor(diff / 1000));
  const days = Math.floor(totalSec / 86400);
  const hrs = Math.floor((totalSec % 86400) / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;

  return { days, hrs, min, sec, isNearStart, isUrgent, isDuringSession };
}

export function isCurrentDayMonOrTue() {
  const day = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  return day === 'Mon' || day === 'Tue';
}

export function formatISTDateTime(isoString) {
  if (!isoString) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(isoString));
}

export function pad(n) {
  return String(n).padStart(2, '0');
}
