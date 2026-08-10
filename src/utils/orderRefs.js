/** Manual OMS refs: new `M-1000` style and legacy `MAN-…` codes. */
export function isManualOrderRef(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return /^M-\d+$/i.test(id) || /^MAN-/i.test(id);
}
