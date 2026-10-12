export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  // BOM so Excel opens UTF-8 (names in Indian scripts, emoji) correctly.
  const blob = new Blob([type.startsWith('text/csv') ? '﻿' : '', text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fmtDate = (t?: number) => (t ? new Date(t).toLocaleString() : '—');
export const fmtNum = (n: number) => n.toLocaleString();
