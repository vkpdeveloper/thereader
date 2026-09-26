import type { DownloadState, LibraryEntry } from './types';

/** "12 KB", "3.4 MB", like the mobile `formatBytes`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "3 h 12 min", "12 min", "Under a minute", or "No reading time yet". */
export function formatReadingTime(milliseconds: number): string {
  if (milliseconds <= 0) return 'No reading time yet';
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return 'Under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "YYYY-MM-DD" in local time. */
export function formatDate(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return String(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Just now", "4 min ago", "2 h ago", "Yesterday", or a short date. */
export function formatRelativeTime(at: Date | string, now: Date = new Date()): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const seconds = (now.getTime() - d.getTime()) / 1000;
  if (seconds < 45) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'Yesterday';
  return formatDate(d);
}

export function isDownloadReady(d: DownloadState): boolean {
  return d.status === 'ready' && d.path != null;
}

export function isDownloadActive(d: DownloadState): boolean {
  return d.status === 'queued' || d.status === 'downloading' || d.status === 'verifying';
}

/** 0..1, or null when the total is unknown. */
export function downloadFraction(d: DownloadState): number | null {
  const total = d.totalBytes;
  if (total == null || total <= 0) return null;
  return Math.min(1, Math.max(0, d.receivedBytes / total));
}

/** Reading progress 0..1, or null when never opened. */
export function entryPercent(entry: LibraryEntry): number | null {
  const p = entry.progress;
  if (!p) return null;
  return Math.min(1, Math.max(0, p.locator.totalProgression ?? 0));
}

export const emptyDownload: DownloadState = {
  status: 'none',
  receivedBytes: 0,
  totalBytes: null,
  path: null,
  error: null,
};
