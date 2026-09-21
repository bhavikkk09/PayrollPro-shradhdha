// Pure helpers for the compliance calendar.
export const DUE_SOON_DAYS = 7;
export type TaskStatus = 'UPCOMING' | 'DUE_SOON' | 'PENDING' | 'COMPLETED' | 'OVERDUE';

const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => new Date(day(s) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * OVERDUE: past due and not completed. DUE_SOON: due within DUE_SOON_DAYS.
 * PENDING: the period has ended and it is due later. UPCOMING: the period is still running.
 */
export function computeStatus(today: string, dueDate: string, periodYear: number, periodMonth: number | null, completed: boolean): TaskStatus {
  if (completed) return 'COMPLETED';
  if (dueDate < today) return 'OVERDUE';
  if (dueDate <= addDays(today, DUE_SOON_DAYS)) return 'DUE_SOON';
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const ended = periodYear < ty || (periodYear === ty && (periodMonth ?? 12) < tm);
  return ended ? 'PENDING' : 'UPCOMING';
}

/** Due date = `dueDay` of the month `offset` months after the period month, clamped to that month's length. */
export function dueDateFor(year: number, month: number, dueDay: number, offset: number): string {
  const idx = year * 12 + (month - 1) + offset;
  const y = Math.floor(idx / 12), m = (idx % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(dueDay, last)).padStart(2, '0')}`;
}
