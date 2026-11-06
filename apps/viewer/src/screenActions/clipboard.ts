// Copy text to the clipboard: the async Clipboard API first, then the legacy
// execCommand('copy') on a hidden textarea, which still works in frames whose
// host grants no clipboard-write permission.

export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Denied (permissions policy, no user activation): try the fallback.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  const previous = document.activeElement;
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('The browser refused to copy');
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
