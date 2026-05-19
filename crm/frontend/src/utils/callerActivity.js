/* Caller activity-state emitter.
   Fire-and-forget helper around POST /api/caller/state. Used by the caller
   workspace (CallerShell + modules) to record granular UI transitions for
   the admin Activity Log drawer: page navigation, viewing a lead, filling
   the after-call form, reason pickers, break pickers, etc.

   All emissions are best-effort — network failures are swallowed so a logging
   blip can never break the call/form/break flow. The server-side tag validation
   ensures only known tags get written.

   Action contract:
     - 'start'   → open `tag` (idempotent — duplicate start is a no-op)
     - 'end'     → close `tag` (stamps duration + optional context patch)
     - 'replace' → close `end_tag` (or every other page/modal tag) and open `tag`.
                   This is the most common — use it for clean A → B transitions
                   so the admin sees two consecutive rows, not overlapping ones.
*/

export async function emitCallerState(jwt, { action, tag, context, end_tag }) {
  if (!jwt || !action || !tag) return;
  try {
    await fetch('/api/caller/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ action, tag, context: context || null, end_tag: end_tag || null }),
    });
  } catch {
    /* Network blips are non-fatal — the next transition will reset state. */
  }
}

// Page-id → activity tag. Mirrors the PAGES array in CallerShell.jsx.
export const PAGE_TAG_BY_ID = {
  call:         'ON_PAGE_CALL',
  assigned:     'ON_PAGE_ASSIGNED',
  completed:    'ON_PAGE_COMPLETED',
  not_picked:   'ON_PAGE_NOT_PICKED',
  missed_calls: 'ON_PAGE_MISSED_CALLS',
  untouched:    'ON_PAGE_UNTOUCHED',
  next_batch:   'ON_PAGE_NEXT_BATCH',
};
