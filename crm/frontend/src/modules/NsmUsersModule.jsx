import UsersModule from './UsersModule';

/* NSM-Caller › Users
   ------------------
   The exact same staff-directory UI + logic as the Meta Users module, but
   pointed at the independent nsm_users table via /api/admin/nsm/users. Shares
   zero data with Meta's crm_users — its own callers, managers, team leaders.
   (UsersModule takes an apiBase prop; the default keeps Meta unchanged.) */
export default function NsmUsersModule({ token }) {
  return <UsersModule token={token} apiBase="/api/admin/nsm/users" />;
}
