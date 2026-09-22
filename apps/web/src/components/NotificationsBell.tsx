import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '../api';

interface N { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }

const timeAgo = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/** Polls unread count in the background; the dropdown itself loads on demand. */
export default function NotificationsBell({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<N[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const pollCount = () => api<{ count: number }>('/notifications/unread-count').then((r) => setCount(r.count)).catch(() => undefined);
  useEffect(() => {
    pollCount();
    const t = setInterval(pollCount, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const toggle = () => {
    const next = !open; setOpen(next);
    if (next) { setLoading(true); api<{ items: N[] }>('/notifications?pageSize=20').then((r) => setItems(r.items)).catch(() => setItems([])).finally(() => setLoading(false)); }
  };
  const click = async (n: N) => {
    if (!n.readAt) { try { await api(`/notifications/${n.id}/read`, { method: 'POST' }); } catch { /* not fatal */ } }
    setOpen(false); pollCount();
    if (n.link) onNavigate(n.link);
  };
  const readAll = async () => {
    try { await api('/notifications/read-all', { method: 'POST' }); setItems((r) => r.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))); setCount(0); } catch { /* not fatal */ }
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={toggle} className="relative flex items-center text-slate-600 hover:text-slate-900" aria-label="Notifications">
        <Bell size={18} />
        {count > 0 && <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-white text-[10px] leading-none rounded-full min-w-[16px] h-4 px-1 grid place-items-center">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-xl shadow-lg z-40 max-h-96 overflow-y-auto">
          <div className="flex items-center px-3 py-2 border-b"><span className="text-sm font-medium">Notifications</span>{count > 0 && <button onClick={readAll} className="ml-auto text-xs text-slate-500 hover:text-slate-800">Mark all read</button>}</div>
          {loading && <div className="px-3 py-6 text-sm text-slate-500 text-center">Loading…</div>}
          {!loading && items.length === 0 && <div className="px-3 py-6 text-sm text-slate-500 text-center">Nothing yet.</div>}
          {!loading && items.map((n) => (
            <button key={n.id} onClick={() => click(n)} className={`block w-full text-left px-3 py-2 border-b text-sm hover:bg-slate-50 ${n.readAt ? '' : 'bg-sky-50'}`}>
              <div className="flex items-start gap-2">
                {!n.readAt && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-sky-600 shrink-0" />}
                <div className="min-w-0">
                  <div className="text-slate-800 leading-snug">{n.title}</div>
                  {n.body && <div className="text-xs text-slate-500 mt-0.5">{n.body}</div>}
                  <div className="text-[11px] text-slate-400 mt-0.5">{timeAgo(n.createdAt)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
