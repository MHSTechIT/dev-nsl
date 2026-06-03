/* Auth session + fetch helper. Stores the JWT in sessionStorage, attaches it as
   a Bearer header, and traps 401s (clears the session and notifies App so it
   bounces back to the login page). */

const TOKEN_KEY = 'wd_token';
const USER_KEY  = 'wd_user';

export const getToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
export const getUser = () => {
  try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
};
export const setSession = (token, user) => {
  sessionStorage.setItem(TOKEN_KEY, token);
  if (user) sessionStorage.setItem(USER_KEY, JSON.stringify(user));
};
export const clearSession = () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
};

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    clearSession();
    onUnauthorized && onUnauthorized();
  }
  return res;
}
