// Saving a Blob as a file, and the file names screen actions use.

/**
 * Hand `blob` to the browser as a download named `filename`: an object URL
 * on a detached <a download>, revoked once the click has been dispatched.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next task: the download has started from the click.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `YYYYmmdd-HHMMSS`. */
export function timestamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * A screen id as a file name stem: nested ids ("CBXFEL/Landing") join with
 * `_`, and characters file systems reject become `_`.
 */
export function fileStem(id: string): string {
  const printable = Array.from(id, (c) => (c.charCodeAt(0) < 0x20 ? '_' : c)).join('');
  const stem = printable
    .replace(/[/\\]+/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '');
  return stem || 'screen';
}
