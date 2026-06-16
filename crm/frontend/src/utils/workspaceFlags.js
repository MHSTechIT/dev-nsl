/* Workspace feature flags.

   "Meta Temp-like" workspaces share the same admin surface: Funnel + Page
   Performance hidden, the Whapi tab shown, the Meta lead-form Timer layout,
   the permanent WhatsApp link, bulk Add-Leads, templates, etc. TagMango is a
   clone of Meta Temp, so it gets the exact same behaviour. Add future clones
   here in one place instead of scattering `source === 'metatemp'` checks. */
export const META_TEMP_LIKE = new Set(['metatemp', 'tagmango']);

export const isMetaTempLike = (source) => META_TEMP_LIKE.has(source);

import { useState, useEffect } from 'react';

/* ── Canonical workspace list ──────────────────────────────────────────────
   The single source of truth for "which workspaces exist" across the CRM.
   The Settings → Workspace card renders a toggle per entry; the various
   workspace switchers (Marketing, Web Reminder, Users) filter their options
   down to the enabled ones. Add a new workspace here and it shows up
   everywhere (enabled by default). */
export const ALL_WORKSPACES = [
  { id: 'meta',     label: 'Meta'      },
  { id: 'yt',       label: 'YT'        },
  { id: 'meta2',    label: 'Meta 2.0'  },
  { id: 'metatemp', label: 'Meta Temp' },
  { id: 'tagmango', label: 'TagMango'  },
];

/* Enabled-by-default semantics: a workspace is OFF only when its flag is
   explicitly `false`. A missing key (or a brand-new workspace) is ON. */
export const isWorkspaceEnabled = (flags, id) => !flags || flags[id] !== false;

/* Fetch the persisted on/off map from the backend. Returns {} on any failure
   so callers fall back to "everything enabled" rather than hiding workspaces. */
export async function fetchWorkspaceFlags(token) {
  try {
    const res = await fetch('/api/admin/workspace-flags', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return {};
    const data = await res.json();
    return data.flags || {};
  } catch {
    return {};
  }
}

/* React hook: live set of enabled workspace ids for filtering switchers.
   Defaults to ALL enabled until the fetch resolves (and on error), so a
   slow/missing endpoint never makes workspaces vanish unexpectedly.

   Returns { flags, enabledIds: Set, isEnabled(id) }. */
export function useEnabledWorkspaces(token) {
  const [flags, setFlags] = useState(null); // null → not loaded yet (treat as all-on)

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetchWorkspaceFlags(token).then((f) => { if (alive) setFlags(f); });
    return () => { alive = false; };
  }, [token]);

  const enabledIds = new Set(
    ALL_WORKSPACES.filter((w) => isWorkspaceEnabled(flags, w.id)).map((w) => w.id)
  );
  return { flags, enabledIds, isEnabled: (id) => isWorkspaceEnabled(flags, id) };
}
