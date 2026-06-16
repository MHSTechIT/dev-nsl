import { createContext } from 'react';

/* PreviewSelectionContext — lets the admin "Caller page" preview drawer add a
   checkbox column to the shared CallerLeadsTable WITHOUT every caller module
   having to thread selection props through. The drawer provides the value; the
   table consumes it. The caller's own login (no provider) gets `null` here, so
   the checkboxes never render for the caller.

   value shape: {
     selectable:  true,
     selectedIds: Set<leadId>,
     toggle:      (id) => void,
     toggleAll:   (idsOnPage: string[]) => void,
   } */
export const PreviewSelectionContext = createContext(null);
