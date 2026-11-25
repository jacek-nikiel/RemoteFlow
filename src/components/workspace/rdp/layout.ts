/**
 * Size of the remote desktop and how its canvas is shown: resolution presets, the Auto size for
 * the viewer area (in device pixels on high-DPI screens), Display Control resizes and the CSS
 * that makes the canvas pixel-exact.
 */
import type { UserInteraction } from '@devolutions/iron-remote-desktop';
import { rdpPixelRatio, rdpScaleFactor, screenScale } from '../../../utils/rdpDisplay';

export const RESOLUTION_PRESETS = [
  { label: 'Dopasuj do okna (Auto)', value: 'auto', width: 0, height: 0 },
  { label: '1920 × 1080 (Full HD)', value: '1920x1080', width: 1920, height: 1080 },
  { label: '2560 × 1440 (2K QHD)', value: '2560x1440', width: 2560, height: 1440 },
  { label: '1600 × 900 (HD+)', value: '1600x900', width: 1600, height: 900 },
  { label: '1366 × 768 (Laptop)', value: '1366x768', width: 1366, height: 768 },
  { label: '1280 × 720 (HD 720p)', value: '1280x720', width: 1280, height: 720 },
];

/**
 * Remote desktop size that exactly fills the viewer area ("Auto" mode). `ratio` = device pixels
 * per CSS pixel (rdpDisplay.ts): on a high-DPI screen the desktop is requested in device pixels,
 * so the canvas is shown 1:1 on the screen instead of being stretched (blurry).
 */
export function autoSizeFromArea(width: number, height: number, ratio = 1): { width: number; height: number } | null {
  if (width <= 300 || height <= 200) return null; // hidden tab / not laid out yet
  let w = Math.min(8192, Math.max(640, Math.round(width * ratio)));
  let h = Math.min(8192, Math.max(480, Math.round(height * ratio)));
  w = w - (w % 4);
  h = h - (h % 4);
  return { width: w, height: h };
}

export function getDimensionsForPreset(
  preset: string,
  container: HTMLElement | null,
  rdpSettings?: { width: number; height: number } | null
): { width: number; height: number } {
  const found = RESOLUTION_PRESETS.find((p) => p.value === preset);
  if (found && found.width > 0 && found.height > 0) {
    return { width: found.width, height: found.height };
  }

  // "Auto": always follow the size of the viewer area (saved connection size is ignored).
  if (container) {
    const rect = container.getBoundingClientRect();
    const auto = autoSizeFromArea(rect.width, rect.height);
    if (auto) return auto;
  }

  if (rdpSettings?.width && rdpSettings?.height && rdpSettings.width > 0 && rdpSettings.height > 0) {
    return { width: rdpSettings.width, height: rdpSettings.height };
  }

  return { width: 1920, height: 1080 };
}

/** Remote desktop size plus the device-pixel ratio it was computed for (1 = CSS pixels). */
export interface RemoteSize {
  width: number;
  height: number;
  ratio: number;
}

/** Size to request for a resolution preset; only "Auto" follows the screen scaling (rdpDisplay.ts). */
export function remoteDesktopSize(
  preset: string,
  container: HTMLElement | null,
  rdpSettings?: { width: number; height: number } | null
): RemoteSize {
  const fixed = RESOLUTION_PRESETS.some((p) => p.value === preset && p.width > 0);
  if (!fixed && container) {
    const rect = container.getBoundingClientRect();
    const ratio = rdpPixelRatio();
    const auto = autoSizeFromArea(rect.width, rect.height, ratio);
    if (auto) return { ...auto, ratio };
  }
  // A fixed resolution, or the area is not laid out yet: the size as it is, not scaled
  return { ...getDimensionsForPreset(preset, fixed ? container : null, rdpSettings), ratio: 1 };
}

/** Display Control resize with the matching desktop scale factor (also 100 % – resets a previous one). */
export function sendRemoteSize(ui: UserInteraction, size: RemoteSize) {
  noteRequestedSize(size);
  ui.resize(size.width, size.height, rdpScaleFactor(size.ratio));
}

/** How the remote desktop is shown right now – for the statistics panel (diagnosing blur). */
export interface RdpDisplayInfo {
  /** Size asked of the server and the desktop scale factor sent with it (percent). */
  requested: { width: number; height: number; scale: number } | null;
  /** Size of the desktop the server actually sends (canvas). */
  desktop: { width: number; height: number };
  /** Viewer area in screen (device) pixels. */
  area: { width: number; height: number };
  /** Screen scaling of this window, percent. */
  screen: number;
  /** Screen pixels per remote pixel (1 = sharp 1:1). */
  scale: number;
}

let requestedSize: RdpDisplayInfo['requested'] = null;
let displayInfo: RdpDisplayInfo | null = null;

/** Remembers the size requested at connection or by a resize. */
export function noteRequestedSize(size: RemoteSize) {
  requestedSize = { width: size.width, height: size.height, scale: rdpScaleFactor(size.ratio) };
}

export function getRdpDisplayInfo(): RdpDisplayInfo | null {
  return displayInfo;
}

/**
 * How the canvas is shown (the component itself always stays in its "fit" mode – its own sizing
 * would fight these rules):
 * - "Fit": scaled to fill the area, up or down, keeping the aspect ratio, centred. When that is
 *   (almost) one remote pixel per screen pixel – the Auto desktop, requested for the area in
 *   device pixels – it is shown exactly 1:1: the requested size is a few pixels smaller than the
 *   area (even sizes), and stretching by that fraction of a percent blurred text.
 * - "100% (1:1)": one remote pixel per screen pixel (the component showed it at one remote pixel
 *   per CSS pixel – 2× enlarged on a 200 % screen), from the top left, the wrapper scrolls.
 * A 1:1 canvas starts at a whole device pixel (a layout at e.g. 150 % or a split pane can start
 * between two) and is drawn without smoothing.
 */
export function applyCanvasStyle(shadowRoot: ShadowRoot | null | undefined, area: DOMRect | undefined, mode: 'fit' | 'real') {
  if (!shadowRoot) return;
  const id = 'remoteflow-rdp-hidpi';
  let styleEl = shadowRoot.getElementById(id) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = id;
    shadowRoot.appendChild(styleEl);
  }
  // Written only when it changes: this function runs from a MutationObserver on the same tree
  const setCss = (css: string) => {
    if (styleEl!.textContent !== css) styleEl!.textContent = css;
  };
  const canvas = shadowRoot.querySelector('canvas#renderer') as HTMLCanvasElement | null;
  if (!canvas || !area || canvas.width <= 0 || canvas.height <= 0 || area.width <= 0 || area.height <= 0) {
    setCss('');
    return;
  }
  const dpr = screenScale();
  // Size in CSS pixels at one remote pixel per screen pixel
  const w1 = canvas.width / dpr;
  const h1 = canvas.height / dpr;
  let scale = 1;
  if (mode === 'fit') {
    scale = Math.min(area.width / w1, area.height / h1);
    if (scale >= 1 && scale < 1.02) scale = 1;
  }
  const w = w1 * scale;
  const h = h1 * scale;
  displayInfo = {
    requested: requestedSize,
    desktop: { width: canvas.width, height: canvas.height },
    area: { width: Math.round(area.width * dpr), height: Math.round(area.height * dpr) },
    screen: Math.round(dpr * 100),
    scale,
  };
  const align = mode === 'real' ? 'flex-start' : 'center';
  // Selectors doubled: they must outrank the generic overrides (applyShadowRootScalingOverrides,
  // e.g. ".screen-wrapper:not(.scale-real) canvas#renderer"), which are also !important
  const css = (dx: number, dy: number) => `
    :host, .svelte-1103xra.svelte-1103xra, .screen-wrapper.screen-wrapper.screen-wrapper, .screen-viewer.screen-viewer {
      justify-content: ${align} !important;
      align-items: ${align} !important;
    }
    .screen-wrapper.screen-wrapper.screen-wrapper {
      overflow: ${mode === 'real' ? 'auto' : 'hidden'} !important;
    }
    .screen-viewer.screen-viewer {
      width: auto !important;
      height: auto !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: none !important;
      max-height: none !important;
      flex: none !important;
    }
    canvas#renderer#renderer {
      width: ${w}px !important;
      height: ${h}px !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: none !important;
      max-height: none !important;
      transform: translate(${dx}px, ${dy}px) !important;
      image-rendering: ${scale === 1 ? 'pixelated' : 'auto'} !important;
    }`;
  setCss(css(0, 0));
  if (scale !== 1) return;
  const rect = canvas.getBoundingClientRect(); // layout without the shift
  const snap = (v: number) => (Math.round(v * dpr) - v * dpr) / dpr;
  setCss(css(snap(rect.left), snap(rect.top)));
}

// Inject CSS overrides into open ShadowRoot of <iron-remote-desktop> so canvas scales to fit without clipping or covering the Windows taskbar
export function applyShadowRootScalingOverrides(shadowRoot: ShadowRoot | null) {
  if (!shadowRoot) return;
  const styleId = 'remoteflow-rdp-scaling-fix';
  if (shadowRoot.getElementById(styleId)) {
    return;
  }

  const styleEl = document.createElement('style');
  styleEl.id = styleId;
  styleEl.textContent = `
    :host {
      display: flex !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      overflow: hidden !important;
      align-items: center !important;
      justify-content: center !important;
    }
    .svelte-1103xra {
      display: flex !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      overflow: hidden !important;
      align-items: center !important;
      justify-content: center !important;
    }
    .screen-wrapper {
      display: flex !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      overflow: hidden !important;
      align-items: center !important;
      justify-content: center !important;
    }
    .screen-wrapper.scale-real {
      overflow: auto !important;
      display: block !important;
    }
    .screen-viewer {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: 100% !important;
      max-height: 100% !important;
    }
    .screen-wrapper:not(.scale-real) canvas#renderer {
      display: block !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: 100% !important;
      max-height: 100% !important;
      width: auto !important;
      height: auto !important;
      object-fit: contain !important;
    }
  `;
  shadowRoot.appendChild(styleEl);
}
