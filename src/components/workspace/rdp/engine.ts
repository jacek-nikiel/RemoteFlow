/**
 * IronRDP WebAssembly engine: one-time initialisation (with the WebKit workarounds and the
 * statistics hooks) and small helpers shared by the RDP viewer.
 */
import { init as initRdpWasm } from '@devolutions/iron-remote-desktop-rdp';
import { installRdpCanvasBatching } from '../../../utils/rdpCanvasBatching';
import { installNumLockModifierFix } from '../../../utils/rdpLockKeys';
import { installRdpStats } from '../../../utils/rdpStats';

let rdpWasmInitPromise: Promise<void> | null = null;
/** "host:port" with brackets around IPv6 literals ("[::1]:3389"), like the backend. */
export const hostPort = (host: string, port: number): string => {
  const h = host.trim().replace(/^\[(.*)\]$/, '$1');
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
};

/** WebKit engines (WebKitGTK on Linux, WKWebView on macOS) – not Chromium-based WebView2. */
export const isWebKitEngine = (): boolean => {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
};

export function ensureRdpInitialized(): Promise<void> {
  // Measuring hooks for the statistics panel (inactive until the panel is opened)
  installRdpStats();
  // WebKit draws each putImageData call slowly – batch the RDP screen updates (see the module)
  if (isWebKitEngine()) installRdpCanvasBatching();
  // WebKit always reports NumLock as off – IronRDP then switched it off on the server
  if (isWebKitEngine()) installNumLockModifierFix();
  if (!rdpWasmInitPromise) {
    rdpWasmInitPromise = initRdpWasm('info').catch((err) => {
      rdpWasmInitPromise = null;
      throw err;
    });
  }
  return rdpWasmInitPromise;
}
