export function trackEvent(eventName, webinarAt) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_name: eventName, webinar_at: webinarAt ?? null }),
  }).catch(() => {});
}
