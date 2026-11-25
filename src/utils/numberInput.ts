/**
 * Numeric fields limited to their range already while typing (the backend stores them as u16 /
 * u32, so e.g. a port 5559595959 used to fail on save with "expected u16").
 */

export const MAX_PORT = 65535;
/** Remote desktop size accepted by RDP servers (Display Control: 200–8192 pixels). */
export const MIN_RDP_SIZE = 200;
export const MAX_RDP_SIZE = 8192;

/** Typed text → number: digits only, never above `max`. Empty → 0 (checked when saving). */
export function clampTyped(raw: string, max: number): number {
  const digits = raw.replace(/\D/g, '').slice(0, String(max).length);
  return digits ? Math.min(max, Number(digits)) : 0;
}

export function isValidPort(port: number | undefined | null): boolean {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= MAX_PORT;
}

export function isValidRdpSize(size: number): boolean {
  return Number.isInteger(size) && size >= MIN_RDP_SIZE && size <= MAX_RDP_SIZE;
}
