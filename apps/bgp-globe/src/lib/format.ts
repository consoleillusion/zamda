// Small display helpers.

export function prefixText(addr: number, len: number): string {
  // Purpose: dotted-quad CIDR text
  return `${addr >>> 24}.${(addr >>> 16) & 255}.${(addr >>> 8) & 255}.${addr & 255}/${len}`;
}

export function parseIp(text: string): number | null {
  // Purpose: a dotted-quad IPv4 address as a number, or null
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(text);
  if (m === null) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some(v => v > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

export function compact(n: number): string {
  // Purpose: 1234567 as "1.23 M"
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)} k`;
  return Math.round(n).toLocaleString('en');
}

export function ms(value: number): string {
  // Purpose: a duration in milliseconds, with the precision it deserves
  return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;
}

export function clock(seconds: number): string {
  // Purpose: seconds as m:ss or h:mm:ss
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function utc(seconds: number): string {
  // Purpose: Unix seconds as "HH:MM:SS UTC"
  return `${new Date(seconds * 1000).toISOString().slice(11, 19)} UTC`;
}

export function flag(iso: string): string {
  // Purpose: the flag emoji of an ISO 3166 alpha-2 code
  if (!/^[A-Z]{2}$/.test(iso)) return '🏳️';
  return String.fromCodePoint(...[...iso].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function num(value: unknown): number {
  // Purpose: a result cell as a number (sums of integer columns come back as bigint)
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}
