export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; email: string; type: string; roles: string[]; permissions: string[]; mustChangePassword?: boolean };
}

const KEY = 'lcp.session';
export const getSession = (): Session | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
};
export const setSession = (s: Session | null) => {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage blocked */ }
};

export class ApiError extends Error {
  constructor(message: string, public status: number, public errorId?: string) { super(message); }
}

async function raw(path: string, init: RequestInit, token?: string) {
  return fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
}

/** fetch with the access token; on 401 tries one refresh, then signs out. */
async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  let s = getSession();
  let res = await raw(path, init, s?.accessToken);
  if (res.status === 401 && s) {
    const r = await raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) });
    if (r.ok) { s = await r.json(); setSession(s); res = await raw(path, init, s!.accessToken); }
    else { setSession(null); location.reload(); }
  }
  return res;
}

async function fail(res: Response): Promise<never> {
  const b = await res.json().catch(() => ({}));
  const msg = Array.isArray(b.message) ? b.message.join(', ') : b.message ?? 'Request failed';
  throw new ApiError(b.errorId ? `${msg} (ref ${b.errorId})` : msg, res.status, b.errorId);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authed(path, init);
  if (!res.ok) await fail(res);
  return res.json();
}

/** Downloads a file response (PDF, Excel, CSV) through the authenticated API. */
export async function download(path: string) {
  const res = await authed(path, { headers: { Accept: '*/*' } });
  if (!res.ok) await fail(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Fetches an image through the authenticated API and returns a local object URL to put in an <img src>, or null if there is none. */
export async function fetchImageUrl(path: string): Promise<string | null> {
  const res = await authed(path, { headers: { Accept: 'image/*' } });
  if (res.status === 404) return null;
  if (!res.ok) await fail(res);
  return URL.createObjectURL(await res.blob());
}

/** Opens a viewable file (PDF, image) in a new tab, still going through the authenticated API. */
export async function previewFile(path: string) {
  const res = await authed(path + (path.includes('?') ? '&' : '?') + 'inline=true', { headers: { Accept: '*/*' } });
  if (!res.ok) await fail(res);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Multipart upload (file + optional fields). Never sets Content-Type manually: the browser adds the multipart boundary. */
export async function uploadFile<T>(path: string, file: File, fields: Record<string, string | number | undefined> = {}): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') fd.append(k, String(v));
  let s = getSession();
  let res = await fetch(`/api/v1${path}`, { method: 'POST', body: fd, headers: s ? { Authorization: `Bearer ${s.accessToken}` } : {} });
  if (res.status === 401 && s) {
    const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
    if (r.ok) { s = await r.json(); setSession(s); res = await fetch(`/api/v1${path}`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${s!.accessToken}` } }); }
    else { setSession(null); location.reload(); }
  }
  if (!res.ok) await fail(res);
  return res.json();
}

export const login = async (email: string, password: string) => {
  const res = await raw('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(b.message ?? 'Login failed', res.status);
  setSession(b);
  return b as Session;
};

/** Replaces the password (also used to swap an admin-issued temporary one). Returns a fresh session. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<Session> {
  const res = await authed('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
  if (!res.ok) await fail(res);
  const s: Session = await res.json();
  setSession(s);
  return s;
}
