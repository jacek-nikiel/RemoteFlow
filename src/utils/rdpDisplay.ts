/**
 * Sharp remote desktop on high-DPI screens (Windows scaling 150 %, 200 %…, 4K displays).
 *
 * In the "Auto" resolution mode the remote desktop fills the viewer. Measured in CSS pixels, that
 * gives e.g. 1920 × 1080 on a 4K screen at 200 % – the picture is then stretched 2× and blurry.
 * So the desktop is requested in device pixels (3840 × 2160) and the server gets the scaling
 * factor (200 %): Windows draws text at the same size, but sharp – as the Microsoft client does.
 */

/** Screen scaling of this window (device pixels per CSS pixel), e.g. 2 at 200 %. */
export function screenScale(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** Device pixels per CSS pixel used for the remote desktop in Auto mode (1 = no scaling). */
export function rdpPixelRatio(): number {
  return Math.min(4, Math.max(1, screenScale()));
}

/** Desktop scale factor sent to the server, in percent (Display Control allows 100–500). */
export function rdpScaleFactor(ratio: number): number {
  return Math.min(500, Math.max(100, Math.round(ratio * 100)));
}
