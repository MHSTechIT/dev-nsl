/**
 * Meta Marketing API — fetches landing_page_view counts per day.
 *
 * Aggregates across every ad account listed in META_AD_ACCOUNTS. Cached in
 * memory for 30 minutes per (account, fromYmd, toYmd) so Meta's rate limits
 * don't get hammered.
 *
 * "landing_page_view" = people who clicked an ad AND whose browser loaded
 * the destination page (Meta waits for the Pixel on the landing page to
 * fire). It is exactly the "ad click → page arrived" metric.
 */

const API_VERSION = 'v23.0';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const cache = new Map(); // key → { ts, value }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { ts: Date.now(), value });
}

/** Wipe every Meta-related cache entry. Call after the admin saves a new
 *  campaign selection so the next dashboard fetch hits Meta fresh and
 *  shows the new filter immediately. */
function clearMetaCache() {
  cache.clear();
}

function getAccounts() {
  const raw = (process.env.META_AD_ACCOUNTS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Resolve the right access token for a given ad account id. Meta System
 * Users are scoped to a single business portfolio, so if your ad accounts
 * are spread across multiple portfolios you need a separate token per
 * portfolio. Pattern:
 *
 *   META_ACCESS_TOKEN                       — default fallback
 *   META_ACCESS_TOKEN_<account_id>          — per-account override
 *
 * The per-account override wins when both are set.
 */
function getTokenForAccount(accountId) {
  const override = process.env[`META_ACCESS_TOKEN_${accountId}`];
  if (override && override.trim()) return override.trim();
  return (process.env.META_ACCESS_TOKEN || '').trim();
}

function getDefaultToken() {
  return (process.env.META_ACCESS_TOKEN || '').trim();
}

/**
 * Resolve the access token for reading ONE Page's lead-gen forms. Meta's
 * /<page_id>/leadgen_forms requires a token authorized on THAT page — a token
 * for a different page returns "(#10) insufficient privileges". So a page the
 * default token can't read needs its own Page Access Token, supplied as:
 *
 *   META_PAGE_TOKEN_<page_id>     — e.g. META_PAGE_TOKEN_355327027658692
 *
 * When set, it wins for that page; otherwise we fall back to the default token.
 */
function getTokenForPage(pageId) {
  const override = process.env[`META_PAGE_TOKEN_${pageId}`];
  if (override && override.trim()) return override.trim();
  return getDefaultToken();
}

/* Every distinct token that might be authorized to read a form's leads: the
   default token plus every configured per-page token (META_PAGE_TOKEN_*). The
   lead pull only has a form id (not its page id), so it tries each in turn. */
function getAllLeadTokens() {
  const out = [];
  const def = getDefaultToken();
  if (def) out.push(def);
  for (const [k, v] of Object.entries(process.env)) {
    if (/^META_PAGE_TOKEN_/.test(k) && v && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

/**
 * Fetches daily Meta metrics for one ad account.
 *
 * Returns two parallel maps:
 *   - landing_page_view (lossy, Pixel-dependent — matches Ads Manager
 *     "Landing Page Views" column)
 *   - link_click (100% accurate, Meta-server-side — matches Ads Manager
 *     "Link Clicks" column)
 *
 * Attribution: full Meta default (1d_view + 7d_click + 28d_click).
 * Date range: bounded only by the `fromYmd` / `toYmd` parameters.
 *
 * Returns { lpv: { 'YYYY-MM-DD': count }, clicks: { 'YYYY-MM-DD': count } }.
 */
async function fetchAccountDaily(accountId, fromYmd, toYmd) {
  const token = getTokenForAccount(accountId);
  if (!token || !accountId) return { lpv: {}, clicks: {} };

  const cacheKey = `${accountId}|${fromYmd}|${toYmd}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(`https://graph.facebook.com/${API_VERSION}/act_${accountId}/insights`);
  url.searchParams.set('level', 'account');
  url.searchParams.set('fields', 'actions,inline_link_clicks');
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('time_range', JSON.stringify({ since: fromYmd, until: toYmd }));
  // Use each campaign's OWN attribution setting (matches Ads Manager UI
  // exactly) instead of forcing a single window. Different campaigns use
  // different settings (incremental, 7d_click, etc.) and Ads Manager
  // respects the per-campaign value.
  url.searchParams.set('use_unified_attribution_setting', 'true');
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[metaInsights] account ${accountId} ${res.status}: ${txt.slice(0, 200)}`);
      return { lpv: {}, clicks: {} };
    }
    const json = await res.json();
    const lpvMap = {};
    const clickMap = {};
    for (const row of (json.data || [])) {
      const day = row.date_start; // YYYY-MM-DD
      const lpv = (row.actions || []).find(a => a.action_type === 'landing_page_view');
      if (lpv) lpvMap[day] = (lpvMap[day] || 0) + (parseInt(lpv.value, 10) || 0);
      // Prefer top-level `inline_link_clicks` (= "Link Clicks" in Ads Manager).
      let clicks = 0;
      if (row.inline_link_clicks != null) {
        clicks = parseInt(row.inline_link_clicks, 10) || 0;
      } else {
        const lc = (row.actions || []).find(a => a.action_type === 'link_click');
        if (lc) clicks = parseInt(lc.value, 10) || 0;
      }
      if (clicks > 0) clickMap[day] = (clickMap[day] || 0) + clicks;
    }
    const result = { lpv: lpvMap, clicks: clickMap };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[metaInsights] account ${accountId} fetch error:`, err.message);
    return { lpv: {}, clicks: {} };
  }
}

/**
 * Sums landing_page_view AND link_click across all configured ad accounts.
 * Returns { lpv: { 'YYYY-MM-DD': count }, clicks: { 'YYYY-MM-DD': count } }.
 */
async function fetchLandingViewsByDay(fromYmd, toYmd) {
  const accounts = getAccounts();
  if (accounts.length === 0) return { lpv: {}, clicks: {} };

  const perAccount = await Promise.all(
    accounts.map(acc => fetchAccountDaily(acc, fromYmd, toYmd))
  );

  const lpv = {};
  const clicks = {};
  for (const daily of perAccount) {
    for (const [day, count] of Object.entries(daily.lpv || {})) {
      lpv[day] = (lpv[day] || 0) + count;
    }
    for (const [day, count] of Object.entries(daily.clicks || {})) {
      clicks[day] = (clicks[day] || 0) + count;
    }
  }
  return { lpv, clicks };
}

/**
 * Attributes daily landing views to webinars based on each webinar's
 * registration deadline (`date_time`). A view that happened on day D is
 * credited to the first webinar whose `date_time` is on or after D — i.e.
 * the webinar that was "currently being promoted" when that ad was seen.
 *
 * Returns { [webinar_id]: landing_views }.
 */
function attributeViewsToWebinars(dailyViews, webinars) {
  // Sort webinars ascending by date_time so we can walk forward.
  const sorted = [...webinars]
    .filter(w => w.date_time)
    .sort((a, b) => new Date(a.date_time) - new Date(b.date_time));

  const result = {};
  for (const w of sorted) result[w.webinar_id] = 0;

  for (const [dayYmd, count] of Object.entries(dailyViews)) {
    const dayDate = new Date(`${dayYmd}T12:00:00+05:30`); // noon IST inside the day
    const target = sorted.find(w => new Date(w.date_time) >= dayDate);
    if (target) {
      result[target.webinar_id] += count;
    } else {
      // Day is after the last known webinar deadline — credit it to the latest one.
      const last = sorted[sorted.length - 1];
      if (last) result[last.webinar_id] += count;
    }
  }
  return result;
}

function metaConfigured() {
  // Configured if at least one account has any token (default or override).
  const accounts = getAccounts();
  if (accounts.length === 0) return false;
  return accounts.some(id => !!getTokenForAccount(id));
}

/**
 * Lists campaigns for one ad account. Cached 30 min.
 * Returns [{ id, name, status, account_id }].
 */
async function fetchAccountCampaigns(accountId) {
  const token = getTokenForAccount(accountId);
  if (!token || !accountId) return [];

  const cacheKey = `campaigns|${accountId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(`https://graph.facebook.com/${API_VERSION}/act_${accountId}/campaigns`);
  url.searchParams.set('fields', 'id,name,status,effective_status');
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[metaInsights] campaigns ${accountId} ${res.status}: ${txt.slice(0, 200)}`);
      return [];
    }
    const json = await res.json();
    const list = (json.data || []).map(c => ({
      id: c.id,
      name: c.name,
      status: c.effective_status || c.status,
      account_id: accountId,
    }));
    cacheSet(cacheKey, list);
    return list;
  } catch (err) {
    console.error(`[metaInsights] campaigns ${accountId} fetch error:`, err.message);
    return [];
  }
}

/**
 * Lists campaigns across every configured ad account.
 * Returns [{ id, name, status, account_id }].
 */
async function fetchAllCampaigns() {
  const accounts = getAccounts();
  if (accounts.length === 0) return [];
  const lists = await Promise.all(accounts.map(fetchAccountCampaigns));
  return lists.flat();
}

/**
 * Lists the Meta Pages promotable from one ad account. Cached 30 min.
 *
 * NOTE: our META_ACCESS_TOKEN is a System-User token scoped to ad accounts,
 * so /me/accounts and /me/businesses both fail with "(#100) nonexisting
 * field". The act_<id>/promote_pages edge DOES work and returns the pages
 * connected to / promotable by that ad account — exactly the set the
 * NSM-Caller webinar batch should choose from.
 *
 * Returns [{ id, name }].
 */
async function fetchAccountPromotePages(accountId) {
  const token = getTokenForAccount(accountId);
  if (!token || !accountId) return [];

  const cacheKey = `promote_pages|${accountId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(`https://graph.facebook.com/${API_VERSION}/act_${accountId}/promote_pages`);
  url.searchParams.set('fields', 'id,name');
  url.searchParams.set('limit', '200');
  url.searchParams.set('access_token', token);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[metaInsights] promote_pages ${accountId} ${res.status}: ${txt.slice(0, 200)}`);
      return [];
    }
    const json = await res.json();
    const list = (json.data || []).map(p => ({ id: String(p.id), name: p.name || String(p.id) }));
    cacheSet(cacheKey, list);
    return list;
  } catch (err) {
    console.error(`[metaInsights] promote_pages ${accountId} fetch error:`, err.message);
    return [];
  }
}

/**
 * Union of promotable Meta Pages across every configured ad account,
 * deduped by page id and sorted by name. Returns [{ id, name }].
 */
async function fetchAllPromotePages() {
  const accounts = getAccounts();
  if (accounts.length === 0) return [];
  const lists = await Promise.all(accounts.map(fetchAccountPromotePages));
  const byId = new Map();
  for (const list of lists) {
    for (const p of list) {
      if (!byId.has(p.id)) byId.set(p.id, p);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lists the Meta Lead Gen Forms on one page (follows paging). Pages the
 * System-User token has no rights on return "(#10) insufficient privileges"
 * — expected, skipped quietly. Returns [{ id, name, status, page_name }].
 */
async function fetchPageLeadgenForms(pageId, pageName) {
  const token = getTokenForPage(pageId);  // per-page override (META_PAGE_TOKEN_<id>) → default
  if (!token || !pageId) return [];

  const first = new URL(`https://graph.facebook.com/${API_VERSION}/${pageId}/leadgen_forms`);
  first.searchParams.set('fields', 'id,name,status');
  first.searchParams.set('limit', '200');
  first.searchParams.set('access_token', token);

  const out = [];
  let next = first.toString();
  let guard = 0;
  while (next && guard < 8) {
    guard++;
    let res;
    try { res = await fetch(next); }
    catch (e) { console.error(`[metaInsights] leadgen_forms ${pageId} fetch error:`, e.message); break; }
    if (!res.ok) {
      if (guard === 1) {
        const txt = await res.text().catch(() => '');
        console.warn(`[metaInsights] leadgen_forms ${pageId} (${pageName}) ${res.status}: ${txt.slice(0, 120)}`);
      }
      break;
    }
    const json = await res.json();
    for (const f of (json.data || [])) {
      out.push({ id: String(f.id), name: f.name || String(f.id), status: f.status || null, page_name: pageName });
    }
    next = json.paging && json.paging.next ? json.paging.next : null;
  }
  return out;
}

/**
 * Pages we hold an explicit Page token for (META_PAGE_TOKEN_<id>). These are
 * ALWAYS included in the form enumeration — even when promote_pages doesn't
 * surface them (e.g. the ad-account tokens can't see the page). Each page's
 * name is fetched via its own token. Returns [{ id, name }].
 */
async function fetchExplicitTokenPages() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^META_PAGE_TOKEN_(\d+)$/.exec(k);
    if (!m || !v || !v.trim()) continue;
    const pageId = m[1];
    let name = pageId;
    try {
      const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${pageId}?fields=name&access_token=${v.trim()}`);
      const j = await r.json();
      if (r.ok && j.name) name = j.name;
    } catch { /* fall back to id as name */ }
    out.push({ id: pageId, name });
  }
  return out;
}

/**
 * Union of Meta Lead Gen Forms across every page promotable from the
 * configured ad accounts PLUS every page we hold an explicit token for.
 * Deduped by form id. Cached 30 min. Returns [{ id, name, status, page_name }].
 */
async function fetchAllLeadgenForms(force = false) {
  const cacheKey = 'leadgen_forms|all';
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const [promote, explicit] = await Promise.all([fetchAllPromotePages(), fetchExplicitTokenPages()]);
  const byPageId = new Map();
  for (const p of [...promote, ...explicit]) if (!byPageId.has(p.id)) byPageId.set(p.id, p);
  const pages = Array.from(byPageId.values()); // [{ id, name }]
  if (pages.length === 0) return [];

  const lists = await Promise.all(pages.map(p => fetchPageLeadgenForms(p.id, p.name)));
  const byId = new Map();
  for (const list of lists) {
    for (const f of list) {
      if (!byId.has(f.id)) byId.set(f.id, f);
    }
  }
  const result = Array.from(byId.values());
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Reads lead records for one Lead Gen form within an optional time window.
 * `sinceUnix` / `untilUnix` are UNIX seconds (UTC). Follows paging up to
 * maxPages (×100 leads). NOT cached — the sync job owns freshness.
 * Returns { leads:[{ id, created_time, field_data:[{name,values}] }], capped, error }.
 */
async function fetchFormLeads(formId, sinceUnix, untilUnix, maxPages = 200) {
  const tokens = getAllLeadTokens();
  if (tokens.length === 0 || !formId) return { leads: [], capped: false, error: 'no token/form' };

  const filters = [];
  if (sinceUnix) filters.push({ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix });
  if (untilUnix) filters.push({ field: 'time_created', operator: 'LESS_THAN', value: untilUnix });

  const buildFirst = (token) => {
    const u = new URL(`https://graph.facebook.com/${API_VERSION}/${formId}/leads`);
    u.searchParams.set('fields', 'id,created_time,field_data');
    u.searchParams.set('limit', '100');
    if (filters.length) u.searchParams.set('filtering', JSON.stringify(filters));
    u.searchParams.set('access_token', token);
    return u.toString();
  };

  // Try each candidate token; the first whose page hosts this form succeeds.
  // A token not authorized on the form's page returns 4xx → try the next.
  let lastError = null;
  for (const token of tokens) {
    const leads = [];
    let next = buildFirst(token);
    let guard = 0;
    let ok = true;
    while (next && guard < maxPages) {
      guard++;
      let res;
      try { res = await fetch(next); }
      catch (e) { lastError = e.message; ok = false; break; }
      if (!res.ok) {
        lastError = (await res.text().catch(() => '')).slice(0, 160);
        ok = false;
        break; // permission/auth failure for this token → try the next one
      }
      const json = await res.json();
      for (const l of (json.data || [])) leads.push(l);
      next = json.paging && json.paging.next ? json.paging.next : null;
    }
    if (ok) return { leads, capped: guard >= maxPages && !!next, error: null };
  }
  console.warn(`[metaInsights] form leads ${formId} — no authorized token (${lastError || ''})`);
  return { leads: [], capped: false, error: lastError };
}

/**
 * Same as fetchLandingViewsByDay but restricted to the given campaign-id
 * list (across all configured accounts). If `campaignIds` is empty or
 * undefined, behaves identically to the unfiltered version.
 */
async function fetchAccountDailyFiltered(accountId, fromYmd, toYmd, campaignIds) {
  const token = getTokenForAccount(accountId);
  if (!token || !accountId) return { lpv: {}, clicks: {} };

  // Cache key includes the selected campaign ids so different selections
  // never collide.
  const cacheKey = `${accountId}|${fromYmd}|${toYmd}|${(campaignIds || []).slice().sort().join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL(`https://graph.facebook.com/${API_VERSION}/act_${accountId}/insights`);
  url.searchParams.set('level', 'account');
  url.searchParams.set('fields', 'actions,inline_link_clicks');
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('time_range', JSON.stringify({ since: fromYmd, until: toYmd }));
  // Match Ads Manager exactly — use each campaign's own attribution setting.
  url.searchParams.set('use_unified_attribution_setting', 'true');
  url.searchParams.set('limit', '500');
  if (campaignIds && campaignIds.length > 0) {
    url.searchParams.set('filtering', JSON.stringify([{
      field: 'campaign.id',
      operator: 'IN',
      value: campaignIds,
    }]));
  }
  url.searchParams.set('access_token', token);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error(`[metaInsights] filtered account ${accountId} ${res.status}: ${txt.slice(0, 200)}`);
      return { lpv: {}, clicks: {} };
    }
    const json = await res.json();
    const lpvMap = {};
    const clickMap = {};
    for (const row of (json.data || [])) {
      const day = row.date_start;
      const lpv = (row.actions || []).find(a => a.action_type === 'landing_page_view');
      if (lpv) lpvMap[day] = (lpvMap[day] || 0) + (parseInt(lpv.value, 10) || 0);
      let clicks = 0;
      if (row.inline_link_clicks != null) {
        clicks = parseInt(row.inline_link_clicks, 10) || 0;
      } else {
        const lc = (row.actions || []).find(a => a.action_type === 'link_click');
        if (lc) clicks = parseInt(lc.value, 10) || 0;
      }
      if (clicks > 0) clickMap[day] = (clickMap[day] || 0) + clicks;
    }
    const result = { lpv: lpvMap, clicks: clickMap };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[metaInsights] filtered account ${accountId} fetch error:`, err.message);
    return { lpv: {}, clicks: {} };
  }
}

async function fetchLandingViewsByDayFiltered(fromYmd, toYmd, campaignIds) {
  const accounts = getAccounts();
  if (accounts.length === 0) return { lpv: {}, clicks: {} };

  // Skip empty filter → fall through to unfiltered path (different cache key).
  if (!campaignIds || campaignIds.length === 0) {
    return fetchLandingViewsByDay(fromYmd, toYmd);
  }

  const perAccount = await Promise.all(
    accounts.map(acc => fetchAccountDailyFiltered(acc, fromYmd, toYmd, campaignIds))
  );

  const lpv = {};
  const clicks = {};
  for (const daily of perAccount) {
    for (const [day, count] of Object.entries(daily.lpv || {})) {
      lpv[day] = (lpv[day] || 0) + count;
    }
    for (const [day, count] of Object.entries(daily.clicks || {})) {
      clicks[day] = (clicks[day] || 0) + count;
    }
  }
  return { lpv, clicks };
}

module.exports = {
  fetchLandingViewsByDay,
  fetchLandingViewsByDayFiltered,
  attributeViewsToWebinars,
  metaConfigured,
  fetchAllCampaigns,
  fetchAllPromotePages,
  fetchAllLeadgenForms,
  fetchFormLeads,
  clearMetaCache,
};
