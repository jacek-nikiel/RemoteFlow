import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  KeyRound,
  Download,
  ShieldCheck,
  Volume2,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Maximize2,
  Minimize2,
  AlertTriangle,
  Loader2,
  ZoomIn,
  Clipboard,
  ClipboardPaste,
  Tv,
  FolderSync,
  FolderOpen,
  Send,
  FileUp,
  X,
  Folder,
  File,
  Upload,
  ArrowUp,
  HardDrive,
  Trash2,
  Keyboard,
  ChevronDown,
  Activity,
} from 'lucide-react';
import '@devolutions/iron-remote-desktop';
import { ConfigBuilder, UserInteraction } from '@devolutions/iron-remote-desktop';
import {
  Backend,
  init as initRdpWasm,
  enableCredssp,
  displayControl,
  RdpFileTransferProvider,
  DroppedFile,
  FileInfo,
} from '@devolutions/iron-remote-desktop-rdp';
import { SessionInfo, SftpFileEntry } from '../../types';
import { api, isTauri, isWindowsHost } from '../../services/api';
import { explainRdpError } from '../../utils/rdpErrors';
import { listen } from '@tauri-apps/api/event';
import { useT } from '../../i18n';
import { installRdpCanvasBatching } from '../../utils/rdpCanvasBatching';
import { rdpPixelRatio, rdpScaleFactor, screenScale } from '../../utils/rdpDisplay';
import { installNumLockModifierFix, numLockFromEvent, trackNumLock } from '../../utils/rdpLockKeys';
import { installRdpStats } from '../../utils/rdpStats';
import { RdpStatsPanel } from './RdpStatsPanel';

let rdpWasmInitPromise: Promise<void> | null = null;
/** "host:port" with brackets around IPv6 literals ("[::1]:3389"), like the backend. */
const hostPort = (host: string, port: number): string => {
  const h = host.trim().replace(/^\[(.*)\]$/, '$1');
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
};

/** WebKit engines (WebKitGTK on Linux, WKWebView on macOS) – not Chromium-based WebView2. */
const isWebKitEngine = (): boolean => {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
};

function ensureRdpInitialized(): Promise<void> {
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

const RESOLUTION_PRESETS = [
  { label: 'Dopasuj do okna (Auto)', value: 'auto', width: 0, height: 0 },
  { label: '1920 × 1080 (Full HD)', value: '1920x1080', width: 1920, height: 1080 },
  { label: '2560 × 1440 (2K QHD)', value: '2560x1440', width: 2560, height: 1440 },
  { label: '1600 × 900 (HD+)', value: '1600x900', width: 1600, height: 900 },
  { label: '1366 × 768 (Laptop)', value: '1366x768', width: 1366, height: 768 },
  { label: '1280 × 720 (HD 720p)', value: '1280x720', width: 1280, height: 720 },
];

/** Remote -> local clipboard copies above this size are not downloaded automatically. */
const REMOTE_CLIP_AUTO_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GiB

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const SCANCODE_OPTIONS: { label: string; code: number; group: string }[] = [
  // Klawisze funkcyjne
  { label: 'F1', code: 0x003b, group: 'Klawisze funkcyjne' },
  { label: 'F2', code: 0x003c, group: 'Klawisze funkcyjne' },
  { label: 'F3', code: 0x003d, group: 'Klawisze funkcyjne' },
  { label: 'F4', code: 0x003e, group: 'Klawisze funkcyjne' },
  { label: 'F5', code: 0x003f, group: 'Klawisze funkcyjne' },
  { label: 'F6', code: 0x0040, group: 'Klawisze funkcyjne' },
  { label: 'F7', code: 0x0041, group: 'Klawisze funkcyjne' },
  { label: 'F8', code: 0x0042, group: 'Klawisze funkcyjne' },
  { label: 'F9', code: 0x0043, group: 'Klawisze funkcyjne' },
  { label: 'F10', code: 0x0044, group: 'Klawisze funkcyjne' },
  { label: 'F11', code: 0x0057, group: 'Klawisze funkcyjne' },
  { label: 'F12', code: 0x0058, group: 'Klawisze funkcyjne' },

  // Klawisze specjalne
  { label: 'Delete (Del)', code: 0xe053, group: 'Klawisze specjalne' },
  { label: 'Escape (Esc)', code: 0x0001, group: 'Klawisze specjalne' },
  { label: 'Tab', code: 0x000f, group: 'Klawisze specjalne' },
  { label: 'Enter', code: 0x001c, group: 'Klawisze specjalne' },
  { label: 'Backspace', code: 0x000e, group: 'Klawisze specjalne' },
  { label: 'Spacja (Space)', code: 0x0039, group: 'Klawisze specjalne' },
  { label: 'Insert (Ins)', code: 0xe052, group: 'Klawisze specjalne' },
  { label: 'Home', code: 0xe047, group: 'Klawisze specjalne' },
  { label: 'End', code: 0xe04f, group: 'Klawisze specjalne' },
  { label: 'Page Up', code: 0xe049, group: 'Klawisze specjalne' },
  { label: 'Page Down', code: 0xe051, group: 'Klawisze specjalne' },
  { label: 'Print Screen (PrtScn)', code: 0xe037, group: 'Klawisze specjalne' },

  // Nawigacja / Strzałki
  { label: 'Strzałka w górę (Up)', code: 0xe048, group: 'Nawigacja' },
  { label: 'Strzałka w dół (Down)', code: 0xe050, group: 'Nawigacja' },
  { label: 'Strzałka w lewo (Left)', code: 0xe04b, group: 'Nawigacja' },
  { label: 'Strzałka w prawo (Right)', code: 0xe04d, group: 'Nawigacja' },

  // Litery
  ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'].map((char) => ({
    label: char,
    code: ({
      A: 0x001e, B: 0x0030, C: 0x002e, D: 0x0020, E: 0x0012, F: 0x0021, G: 0x0022, H: 0x0023,
      I: 0x0017, J: 0x0024, K: 0x0025, L: 0x0026, M: 0x0032, N: 0x0031, O: 0x0018, P: 0x0019,
      Q: 0x0010, R: 0x0013, S: 0x001f, T: 0x0014, U: 0x0016, V: 0x002f, W: 0x0011, X: 0x002d,
      Y: 0x0015, Z: 0x002c,
    } as Record<string, number>)[char],
    group: 'Litery',
  })),

  // Cyfry
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => ({
    label: num,
    code: ({
      '1': 0x0002, '2': 0x0003, '3': 0x0004, '4': 0x0005, '5': 0x0006,
      '6': 0x0007, '7': 0x0008, '8': 0x0009, '9': 0x000a, '0': 0x000b,
    } as Record<string, number>)[num],
    group: 'Cyfry',
  })),
];

/**
 * Remote desktop size that exactly fills the viewer area ("Auto" mode). `ratio` = device pixels
 * per CSS pixel (rdpDisplay.ts): on a high-DPI screen the desktop is requested in device pixels,
 * so the canvas is shown 1:1 on the screen instead of being stretched (blurry).
 */
function autoSizeFromArea(width: number, height: number, ratio = 1): { width: number; height: number } | null {
  if (width <= 300 || height <= 200) return null; // hidden tab / not laid out yet
  let w = Math.min(8192, Math.max(640, Math.round(width * ratio)));
  let h = Math.min(8192, Math.max(480, Math.round(height * ratio)));
  w = w - (w % 4);
  h = h - (h % 4);
  return { width: w, height: h };
}

function getDimensionsForPreset(
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
interface RemoteSize {
  width: number;
  height: number;
  ratio: number;
}

/** Size to request for a resolution preset; only "Auto" follows the screen scaling (rdpDisplay.ts). */
function remoteDesktopSize(
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
function sendRemoteSize(ui: UserInteraction, size: RemoteSize) {
  ui.resize(size.width, size.height, rdpScaleFactor(size.ratio));
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
function applyCanvasStyle(shadowRoot: ShadowRoot | null | undefined, area: DOMRect | undefined, mode: 'fit' | 'real') {
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
function applyShadowRootScalingOverrides(shadowRoot: ShadowRoot | null) {
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

interface Props {
  session: SessionInfo;
  isActive: boolean;
}

export const RdpViewer: React.FC<Props> = ({ session, isActive }) => {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const userInteractionRef = useRef<UserInteraction | null>(null);
  const rdpWasmSessionRef = useRef<any>(null);
  const fileTransferProviderRef = useRef<RdpFileTransferProvider | null>(null);
  const lastSyncedTextRef = useRef<string>('');
  const lastSyncedFilesKeyRef = useRef<string>('');
  const hasStagedUploadRef = useRef<boolean>(false);
  const stagedDroppedFilesRef = useRef<DroppedFile[]>([]);
  const lastAppliedResRef = useRef<RemoteSize | null>(null);
  // Throttling of focus-triggered clipboard sync (each sync may reach the OS clipboard)
  const clipboardSyncInFlightRef = useRef<boolean>(false);
  // "Clipboard" in the connection's RDP settings: when off, nothing is exchanged with the remote
  // clipboard (text or files) in either direction.
  const clipboardAllowed = session.rdpSettings?.clipboard !== false;
  const clipboardAllowedRef = useRef(clipboardAllowed);
  clipboardAllowedRef.current = clipboardAllowed;
  const clipboardSyncPendingRef = useRef<boolean>(false);
  const lastClipboardSyncAtRef = useRef<number>(0);
  // Last error reported by the local Rust RDP proxy (more precise than the WASM client's error)
  const lastProxyErrorRef = useRef<string | null>(null);
  // Windows: local clipboard sequence number seen at the last sync (detects every new copy,
  // even of identical content, and ignores changes made by RemoteFlow itself)
  const lastLocalClipSeqRef = useRef<number | null>(null);
  const markOwnLocalClipboardWrite = useCallback(async () => {
    const seq = await api.clipboardSequence();
    if (seq != null) lastLocalClipSeqRef.current = seq;
  }, []);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');
  const [statusMessage, setStatusMessage] = useState<string>(t('Nawiązywanie połączenia RDP...'));
  const [errorCopied, setErrorCopied] = useState(false);
  // Login exactly as sent to the server (user name and domain are normalised by the backend)
  const rdpLogin = session.rdpDomain ? `${session.rdpDomain}\\${session.username}` : session.username;
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [clipboardFeedback, setClipboardFeedback] = useState<string | null>(null);
  const [isLaunchingExternal, setIsLaunchingExternal] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scaleMode, setScaleMode] = useState<'fit' | 'real'>('fit');
  const scaleModeRef = useRef(scaleMode);
  scaleModeRef.current = scaleMode;
  const canvasObserverRef = useRef<MutationObserver | null>(null);
  /** Re-applies the pixel-exact canvas size (high-DPI) after any change of sizes or mode. */
  const refreshCanvasStyle = useCallback(() => {
    applyCanvasStyle(elementRef.current?.shadowRoot, containerRef.current?.getBoundingClientRect(), scaleModeRef.current);
  }, []);
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  // Key Sequence / Combination menu
  const [isKeyMenuOpen, setIsKeyMenuOpen] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [keyMenuTab, setKeyMenuTab] = useState<'shortcuts' | 'custom' | 'text'>('shortcuts');
  const [customCtrl, setCustomCtrl] = useState(true);
  const [customAlt, setCustomAlt] = useState(true);
  const [customShift, setCustomShift] = useState(false);
  const [customWin, setCustomWin] = useState(false);
  const [customKey, setCustomKey] = useState<number>(0xe053); // Delete by default
  const [customTextInput, setCustomTextInput] = useState('');
  const keyMenuRef = useRef<HTMLDivElement>(null);

  // Unified Clipboard & File Transfer Drawer
  const [isClipboardDrawerOpen, setIsClipboardDrawerOpen] = useState(false);
  const [clipboardDraft, setClipboardDraft] = useState('');
  const [remoteClipboardText, setRemoteClipboardText] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSavingFiles, setIsSavingFiles] = useState(false);

  // Native RDP File Transfer states (CLIPRDR)
  const [stagedUploadNames, setStagedUploadNames] = useState<string[]>([]);
  const [uploadProgressText, setUploadProgressText] = useState<string | null>(null);
  const [remoteAvailableFiles, setRemoteAvailableFiles] = useState<FileInfo[]>([]);
  const [isDownloadingRemoteFiles, setIsDownloadingRemoteFiles] = useState(false);

  // Local folder/file browser inside RDP drawer for 1-click recursive folder sending
  const [isLocalBrowserOpen, setIsLocalBrowserOpen] = useState(false);
  const [localCurrentPath, setLocalCurrentPath] = useState<string>('');
  const [localEntries, setLocalEntries] = useState<SftpFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);

  const rdpFileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string, duration = 3000) => {
    setClipboardFeedback(msg);
    setTimeout(() => setClipboardFeedback(null), duration);
  }, []);

  const focusRdpCanvas = useCallback(() => {
    try {
      const canvas = elementRef.current?.shadowRoot?.querySelector('canvas#renderer') as HTMLElement | null;
      if (canvas) {
        canvas.focus({ preventScroll: true });
      }
    } catch {}
  }, []);

  // Load local directory for folder picker
  const loadLocalDirectory = async (targetPath: string = '') => {
    setLocalLoading(true);
    try {
      const res = await api.localListDir(targetPath);
      setLocalCurrentPath(res.currentPath);
      setLocalEntries(res.entries);
    } catch (err) {
      console.error('Błąd odczytu katalogu lokalnego:', err);
    } finally {
      setLocalLoading(false);
    }
  };

  const handleLocalNavigateUp = () => {
    if (!localCurrentPath || localCurrentPath === '/') return;
    const parts = localCurrentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    loadLocalDirectory(parentPath || '/');
  };

  // Send text directly to WASM RDP Session clipboard (bypasses broken browser navigator.clipboard.read)
  const handleSendCustomTextToRemote = useCallback(async (text: string, notify = true) => {
    if (!text) return false;
    try {
      const wasmSession = rdpWasmSessionRef.current;
      if (wasmSession && typeof wasmSession.onClipboardPaste === 'function') {
        const clipData = new Backend.ClipboardData();
        clipData.addText('text/plain', text);
        await wasmSession.onClipboardPaste(clipData);
        lastSyncedTextRef.current = text;
        hasStagedUploadRef.current = false;
        stagedDroppedFilesRef.current = [];
        setStagedUploadNames([]);
        if (notify) {
          showToast(t('Wysłano tekst do schowka Windows RDP'));
        }
        return true;
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd wysyłania tekstu do sesji RDP:', err);
    }
    return false;
  }, [showToast]);

  // Clear clipboard content, staged files, and draft text
  const handleClearClipboard = useCallback(async () => {
    setClipboardDraft('');
    setRemoteClipboardText('');
    lastSyncedTextRef.current = '';
    hasStagedUploadRef.current = false;
    stagedDroppedFilesRef.current = [];
    setStagedUploadNames([]);
    setRemoteAvailableFiles([]);

    const provider = fileTransferProviderRef.current;
    if (provider) {
      try {
        (provider as any).uploadState = undefined;
        (provider as any).retainedFiles = undefined;
      } catch {}
    }

    try {
      await api.clipboardWriteText('');
      await markOwnLocalClipboardWrite();
      const wasmSession = rdpWasmSessionRef.current;
      if (wasmSession && typeof wasmSession.onClipboardPaste === 'function') {
        await wasmSession.onClipboardPaste(new Backend.ClipboardData());
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd czyszczenia schowka:', err);
    }
    showToast(t('Wyczyszczono schowek RDP i listę plików'));
  }, [showToast]);

  // Stage DroppedFile[] into Windows RDP Clipboard via RdpFileTransferProvider
  const stageDroppedFilesToRdpClipboard = useCallback(async (droppedFiles: DroppedFile[]) => {
    if (!droppedFiles || droppedFiles.length === 0) return;
    const provider = fileTransferProviderRef.current;
    if (!provider) {
      showToast(t('Sesja RDP nie jest jeszcze gotowa do transferu plików'));
      return;
    }

    try {
      // Remember the local text present while staging, so the next focus-sync does not replace
      // the staged files with that (old) text.
      try {
        const currentText = await api.clipboardReadText();
        if (currentText) lastSyncedTextRef.current = currentText;
      } catch {}

      // Clear any previous unfinished upload state so re-staging never throws "Upload already in progress"
      (provider as any).uploadState = undefined;
      hasStagedUploadRef.current = true;
      stagedDroppedFilesRef.current = droppedFiles;

      const rootNames = Array.from(
        new Set(
          droppedFiles.map((df) => (df.path ? df.path.split('\\')[0] : df.name))
        )
      );
      setStagedUploadNames(rootNames);

      const { completion } = provider.uploadFiles(droppedFiles);
      focusRdpCanvas();
      showToast(
        t('Gotowe! Wciśnij Ctrl+V (lub prawy przycisk -> Wklej) w Windows, aby wkleić: {p0}', { p0: rootNames.slice(0, 2).join(', ') }),
        5500
      );

      completion
        .then(() => {
          setUploadProgressText(null);
          showToast(t('Zakończono wklejanie plików w systemie Windows!'), 3500);
        })
        .catch((err) => {
          console.warn('[RemoteFlow RDP] Upload completion warning:', err);
          setUploadProgressText(null);
        });
    } catch (err: any) {
      console.error('[RemoteFlow RDP] Błąd przygotowania plików w schowku RDP:', err);
      showToast(t('Błąd transferu: {p0}', { p0: err?.message || err }));
    }
  }, [focusRdpCanvas, showToast]);

  // Read local paths (files or entire folders recursively) via Rust and stage them into Windows RDP Clipboard + ~/RemoteFlow_Shared
  const stageLocalPathsToRdpClipboard = useCallback(async (localPaths: string[]) => {
    if (!localPaths || localPaths.length === 0) return;
    setIsSavingFiles(true);
    try {
      const entries = await api.readLocalPathsForRdpClipboard(localPaths);
      if (entries.length === 0) {
        showToast(t('Nie znaleziono plików do przesłania'));
        return;
      }

      const droppedFiles: DroppedFile[] = entries.map((ent) => {
        if (ent.isDirectory || !ent.contentBase64) {
          return {
            file: null,
            name: ent.name,
            size: 0,
            lastModified: ent.lastModified || Date.now(),
            path: ent.path || undefined,
            isDirectory: true,
          };
        }
        const binaryString = atob(ent.contentBase64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const fileObj = new window.File([bytes], ent.name, {
          lastModified: ent.lastModified || Date.now(),
        });
        return {
          file: fileObj,
          name: ent.name,
          size: ent.size,
          lastModified: ent.lastModified || Date.now(),
          path: ent.path || undefined,
          isDirectory: false,
        };
      });

      await stageDroppedFilesToRdpClipboard(droppedFiles);
      setIsLocalBrowserOpen(false);
    } catch (err: any) {
      console.error('[RemoteFlow RDP] Błąd odczytu ścieżek lokalnych:', err);
      showToast(t('Błąd odczytu plików: {p0}', { p0: err?.message || err }));
    } finally {
      setIsSavingFiles(false);
    }
  }, [stageDroppedFilesToRdpClipboard, showToast]);

  // Download files copied in Windows (Ctrl+C in Windows Explorer) to local shared/download folder (same as SSH & SFTP)
  const handleDownloadRemoteFiles = async () => {
    const provider = fileTransferProviderRef.current;
    if (!provider || remoteAvailableFiles.length === 0) return;

    setIsDownloadingRemoteFiles(true);
    let savedCount = 0;
    try {
      // Determine target exchange directory (matching SSH/SFTP and global settings)
      let exchangeDir: string | undefined = undefined;
      try {
        const vault = await api.getVaultData();
        const conn = vault.connections.find((c) => c.id === session.connectionId);
        if (conn?.defaultDownloadDir) {
          exchangeDir = conn.defaultDownloadDir;
        }
      } catch (err) {
        console.warn('Nie udało się pobrać konfiguracji katalogu wymiany:', err);
      }

      for (let i = 0; i < remoteAvailableFiles.length; i++) {
        const fileInfo = remoteAvailableFiles[i];
        if (fileInfo.isDirectory) continue;

        const { completion } = provider.downloadFile(fileInfo, i);
        const blob = await completion;
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let j = 0; j < bytes.byteLength; j++) {
          binary += String.fromCharCode(bytes[j]);
        }
        const b64 = btoa(binary);
        const relName = fileInfo.path ? `${fileInfo.path}\\${fileInfo.name}` : fileInfo.name;
        await api.saveDroppedFileToShared(relName, b64, session.connectionId);
        savedCount++;
      }

      const destLabel = exchangeDir || t('katalogu pobierania');
      showToast(t('Pobrano z Windows plików: {n}, zapisano w: {dest}', { n: savedCount, dest: destLabel }), 4500);
      setRemoteAvailableFiles([]);
    } catch (err: any) {
      console.error('[RemoteFlow RDP] Błąd pobierania plików z Windows:', err);
      showToast(t('Błąd pobierania plików z Windows: {p0}', { p0: err?.message || err }));
    } finally {
      setIsDownloadingRemoteFiles(false);
    }
  };

  // Open shared exchange folder locally
  const handleOpenSharedFolder = async () => {
    try {
      let exchangeDir: string | undefined = undefined;
      try {
        const vault = await api.getVaultData();
        const conn = vault.connections.find((c) => c.id === session.connectionId);
        exchangeDir = conn?.defaultDownloadDir || undefined;
      } catch {}
      const path = await api.openSharedFolder(exchangeDir);
      showToast(t('Otwarto folder lokalny: {path}', { path }), 3500);
    } catch (err: any) {
      console.error('Błąd otwierania folderu wymiany:', err);
    }
  };

  // Drag and Drop files or directories onto RDP viewer
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // 1. Check if local file/directory URIs were dropped from Linux file manager
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      const paths = uriList
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('file://'))
        .map((l) => decodeURIComponent(l.replace('file://', '')));
      if (paths.length > 0) {
        await stageLocalPathsToRdpClipboard(paths);
        return;
      }
    }

    // 2. Use RdpFileTransferProvider.handleDrop (supports webkitGetAsEntry recursive folders)
    const provider = fileTransferProviderRef.current;
    if (provider) {
      setIsSavingFiles(true);
      try {
        const dropped = await provider.handleDrop(e.nativeEvent);
        if (dropped.length > 0) {
          for (const df of dropped) {
            if (!df.isDirectory && df.file) {
              try {
                const buf = await df.file.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let j = 0; j < bytes.byteLength; j++) {
                  binary += String.fromCharCode(bytes[j]);
                }
                const rel = df.path ? `${df.path}\\${df.name}` : df.name;
                await api.saveDroppedFileToShared(rel, btoa(binary));
              } catch {}
            }
          }
          await stageDroppedFilesToRdpClipboard(dropped);
          setIsSavingFiles(false);
          return;
        }
      } catch (err) {
        console.warn('[RemoteFlow RDP] provider.handleDrop fallback:', err);
      } finally {
        setIsSavingFiles(false);
      }
    }
  };

  // Resolution always starts in "Auto" mode (fit to the tab); a fixed preset can still be chosen manually.
  const [selectedResolution, setSelectedResolution] = useState<string>('auto');

  // Synchronize local Linux clipboard -> Remote Windows session
  const syncLocalClipboardToRemote = useCallback(async (force = false) => {
    if (!clipboardAllowedRef.current) return;
    if (!force) {
      if (clipboardSyncInFlightRef.current) {
        // A sync is running – run once more afterwards so a copy made meanwhile is not missed.
        clipboardSyncPendingRef.current = true;
        return;
      }
      const now = Date.now();
      if (now - lastClipboardSyncAtRef.current < 300) return;
      lastClipboardSyncAtRef.current = now;
    }
    clipboardSyncInFlightRef.current = true;
    try {
      // 0. Windows: nothing new was copied locally since the last sync -> keep the remote clipboard
      //    as it is (e.g. files/text copied inside the remote session must not be overwritten).
      let localChanged = false;
      const seq = await api.clipboardSequence();
      if (seq != null) {
        if (!force && seq === lastLocalClipSeqRef.current) return;
        localChanged = seq !== lastLocalClipSeqRef.current;
        lastLocalClipSeqRef.current = seq;
      }

      // 1. Files/folders copied in the local file manager (Explorer / Dolphin / Nautilus)
      const clipFiles = await api.clipboardReadFiles();
      if (clipFiles.length > 0) {
        const filesKey = clipFiles.join('|');
        if (force || localChanged || filesKey !== lastSyncedFilesKeyRef.current) {
          lastSyncedFilesKeyRef.current = filesKey;
          await stageLocalPathsToRdpClipboard(clipFiles);
          // the local clipboard holds no text now – a later copy of any text must be sent
          lastSyncedTextRef.current = '';
        }
        // Same files as last time (already staged, or files we downloaded from Windows ourselves)
        return;
      }
      // No files on the local clipboard any more – copying the same files again later must re-stage them.
      lastSyncedFilesKeyRef.current = '';

      // 2. Text. Only a CHANGED local text replaces the remote clipboard, so a passive focus
      //    change never overwrites files staged via drag & drop, while newly copied text always wins.
      const text = await api.clipboardReadText();
      if (!text) return;

      if (force || localChanged || text !== lastSyncedTextRef.current) {
        await handleSendCustomTextToRemote(text, force);
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd synchronizacji schowka:', err);
    } finally {
      clipboardSyncInFlightRef.current = false;
      if (clipboardSyncPendingRef.current) {
        clipboardSyncPendingRef.current = false;
        setTimeout(() => syncLocalClipboardToRemoteRef.current(false), 0);
      }
    }
  }, [handleSendCustomTextToRemote, stageLocalPathsToRdpClipboard]);
  const syncLocalClipboardToRemoteRef = useRef(syncLocalClipboardToRemote);
  syncLocalClipboardToRemoteRef.current = syncLocalClipboardToRemote;

  // ---------------------------------------------------------------------------------------------
  // Remote -> local FILE clipboard (Windows host only)
  // Files copied in the remote session are downloaded over CLIPRDR right away into a private temp
  // folder and put on the local Windows clipboard, so Ctrl+V in Explorer pastes them.
  // ---------------------------------------------------------------------------------------------
  const remoteClipJobRef = useRef(0);
  const stageRemoteFilesToLocalClipboard = useCallback(
    async (provider: RdpFileTransferProvider, files: FileInfo[]) => {
      const job = ++remoteClipJobRef.current; // a newer copy in Windows cancels this one
      const totalBytes = files.reduce((sum, f) => sum + (f.isDirectory ? 0 : f.size || 0), 0);
      if (totalBytes > REMOTE_CLIP_AUTO_LIMIT) {
        showToast(
          t('Skopiowano w Windows {p0} – to za dużo na schowek. Użyj „Pobierz na komputer”.', { p0: formatBytes(totalBytes) }),
          6000
        );
        return;
      }

      const fileCount = files.filter((f) => !f.isDirectory).length;
      try {
        const stageDir = await api.rdpClipStageBegin();
        const topLevel = new Set<string>();
        let done = 0;

        for (let i = 0; i < files.length; i++) {
          if (job !== remoteClipJobRef.current) return;
          const f = files[i];
          const parent = (f.path || '').replace(/\//g, '\\');
          const rel = parent ? `${parent}\\${f.name}` : f.name;
          topLevel.add(rel.split('\\')[0]);

          if (f.isDirectory) {
            await api.rdpClipStageDir(stageDir, rel);
            continue;
          }
          setUploadProgressText(t('Kopiowanie z Windows do schowka: {name} ({p1}/{fileCount})', { name: f.name, p1: done + 1, fileCount }));
          const blob = await provider.downloadFile(f, i).completion;
          if (job !== remoteClipJobRef.current) return;
          await api.rdpClipStageFile(stageDir, rel, new Uint8Array(await blob.arrayBuffer()));
          done++;
        }

        if (job !== remoteClipJobRef.current) return;
        const localPaths = await api.rdpClipStageCommit(stageDir, Array.from(topLevel));
        // These files are now on the local clipboard – do not send them back to Windows on focus.
        lastSyncedFilesKeyRef.current = localPaths.join('|');
        lastSyncedTextRef.current = '';
        await markOwnLocalClipboardWrite();
        setUploadProgressText(null);
        showToast(
          t('Skopiowano z Windows do schowka plików: {n} – wklej Ctrl+V w Eksploratorze', { n: done }),
          4500
        );
      } catch (err: any) {
        if (job !== remoteClipJobRef.current) return;
        console.warn('[RemoteFlow RDP] Błąd kopiowania plików z Windows do schowka:', err);
        setUploadProgressText(null);
        showToast(t('Nie udało się skopiować plików z Windows: {p0}. Użyj „Pobierz na komputer”.', { p0: err?.message || err }), 6000);
      }
    },
    [showToast, markOwnLocalClipboardWrite]
  );
  const markOwnLocalClipboardWriteRef = useRef(markOwnLocalClipboardWrite);
  markOwnLocalClipboardWriteRef.current = markOwnLocalClipboardWrite;
  const stageRemoteFilesToLocalClipboardRef = useRef(stageRemoteFilesToLocalClipboard);
  stageRemoteFilesToLocalClipboardRef.current = stageRemoteFilesToLocalClipboard;

  // Errors reported by the local RDP proxy (connection refused, TLS failure, certificate change...)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>(`rdp-proxy-error-${session.sessionId}`, (event) => {
      lastProxyErrorRef.current = event.payload;
      setStatus('error');
      setStatusMessage(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [session.sessionId]);

  // Dynamic resolution application (Display Control PDU)
  const applyResolution = useCallback((resPreset: string) => {
    setSelectedResolution(resPreset);
    if (resPreset === 'auto') {
      // No "Fit / 100%" switch in Auto (the desktop has the size of the area)
      scaleModeRef.current = 'fit';
      setScaleMode('fit');
    }
    const ui = userInteractionRef.current;
    if (!ui) return;

    const target = remoteDesktopSize(resPreset, containerRef.current, session.rdpSettings);
    lastAppliedResRef.current = target;
    try {
      sendRemoteSize(ui, target);
      refreshCanvasStyle();
      showToast(
        target.ratio > 1
          ? t('Rozdzielczość: {width} × {height}, skalowanie {scale}%', { width: target.width, height: target.height, scale: rdpScaleFactor(target.ratio) })
          : t('Rozdzielczość: {width} × {height}', { width: target.width, height: target.height }),
        2000
      );
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 100);
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd dynamicznej zmiany rozdzielczości:', err);
    }
  }, [session.rdpSettings, showToast, refreshCanvasStyle]);

  // Initialize and mount the embedded IronRDP WebAssembly Canvas client
  useEffect(() => {
    let isSubscribed = true;
    let localEl: any = null;
    let localHandleReady: ((evt: any) => void) | null = null;
    const container = containerRef.current;
    if (!container) return;

    if (!session.rdpProxyPort) {
      setStatus('connecting');
      setStatusMessage(t('Oczekiwanie na inicjalizację lokalnego proxy RDP...'));
      return;
    }

    setStatus('connecting');
    setStatusMessage(t('Uruchamianie silnika RDP WebAssembly...'));
    lastProxyErrorRef.current = null;

    (async () => {
      try {
        await ensureRdpInitialized();
      } catch (err: any) {
        console.error('Błąd inicjalizacji WebAssembly IronRDP:', err);
        if (isSubscribed) {
          setStatus('error');
          setStatusMessage(t('Błąd inicjalizacji modułu WebAssembly RDP: ') + (err?.message || err));
        }
        return;
      }

      if (!isSubscribed || !containerRef.current) return;

      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      if (userInteractionRef.current) {
        try {
          userInteractionRef.current.shutdown();
        } catch (e) {
          console.warn('Error during previous session shutdown:', e);
        }
        userInteractionRef.current = null;
      }
      rdpWasmSessionRef.current = null;
      fileTransferProviderRef.current = null;

      // Respond to MS-RDPECLIP Monitor Ready PDU (forceClipboardUpdateCallback):
      // Must ALWAYS call wasmSession.onClipboardPaste(clipData) (even if empty) so CliprdrClient transitions from Initialization -> Ready!
      const handleForceClipboardUpdate = async () => {
        try {
          let wasmSession = rdpWasmSessionRef.current;
          for (let i = 0; i < 20 && !wasmSession && isSubscribed; i++) {
            await new Promise((r) => setTimeout(r, 50));
            wasmSession = rdpWasmSessionRef.current;
          }
          if (!wasmSession || !isSubscribed) return;

          const text = await api.clipboardReadText();
          const clipData = new Backend.ClipboardData();
          if (text && text.length > 0 && !hasStagedUploadRef.current) {
            clipData.addText('text/plain', text);
            lastSyncedTextRef.current = text;
          }

          await wasmSession.onClipboardPaste(clipData);

          // If files were staged before or during clipboard reset, re-advertise them once Cliprdr is in Ready state
          if (hasStagedUploadRef.current && stagedDroppedFilesRef.current.length > 0) {
            setTimeout(() => {
              const prov = fileTransferProviderRef.current;
              if (prov && isSubscribed) {
                (prov as any).uploadState = undefined;
                prov.uploadFiles(stagedDroppedFilesRef.current);
              }
            }, 150);
          }
        } catch (err) {
          console.warn('[RemoteFlow RDP] Błąd inicjalizacji kanału CLIPRDR:', err);
        }
      };

      // Custom SessionBuilder wrapper: guarantees CLIPRDR callbacks are registered BEFORE super.connect()
      const CustomSessionBuilder = class extends Backend.SessionBuilder {
        private _clipCallbacksRegistered = false;

        private _ensureClipCallbacks() {
          if (this._clipCallbacksRegistered) return;
          this._clipCallbacksRegistered = true;
          // Clipboard disabled for this connection: no CLIPRDR callbacks at all
          if (!clipboardAllowedRef.current) return;

          super.remoteClipboardChangedCallback((clipData: any) => {
            if (!isSubscribed) return;
            try {
              if (clipData && typeof clipData.items === 'function') {
                for (const item of clipData.items()) {
                  const mime = item.mimeType?.() || '';
                  if (mime.startsWith('text/')) {
                    const val = item.value?.();
                    if (val != null) {
                      const textVal = typeof val === 'string' ? val : new TextDecoder().decode(val);
                      if (textVal) {
                        lastSyncedTextRef.current = textVal;
                        api.clipboardWriteText(textVal).then(markOwnLocalClipboardWriteRef.current);
                        setRemoteClipboardText(textVal);
                        setClipboardDraft(textVal);
                        showToast(t('Skopiowano tekst z Windows do schowka'), 2500);
                        break;
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.warn('[RemoteFlow RDP] Błąd odbioru schowka z Windows:', e);
            }
          });

          super.forceClipboardUpdateCallback(() => {
            if (!isSubscribed) return;
            handleForceClipboardUpdate();
          });
        }

        override remoteClipboardChangedCallback(_cb: Function) {
          this._ensureClipCallbacks();
          return this;
        }

        override forceClipboardUpdateCallback(_cb: Function) {
          this._ensureClipCallbacks();
          return this;
        }

        override async connect() {
          this._ensureClipCallbacks();
          const wasmSession = await super.connect();
          rdpWasmSessionRef.current = wasmSession;
          return wasmSession;
        }
      };

      const customModule = {
        ...Backend,
        SessionBuilder: CustomSessionBuilder,
      };

      // Create the custom Web Component element with our enhanced WASM Backend
      const el = document.createElement('iron-remote-desktop') as any;
      el.module = customModule;
      el.scale = 'fit'; // both modes: applyCanvasStyle
      el.flexcenter = 'true';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.display = 'block';
      elementRef.current = el;
      localEl = el;

      const handleReady = async (evt: any) => {
        if (!isSubscribed) return;
        const ui: UserInteraction = evt.detail?.irgUserInteraction;
        userInteractionRef.current = ui;

        // Apply ShadowRoot scaling fixes once on component ready (safe, idempotent)
        applyShadowRootScalingOverrides(el.shadowRoot);
        // The canvas size follows the server (initial size, every resize): keep it pixel-exact
        if (el.shadowRoot) {
          canvasObserverRef.current?.disconnect();
          // Our own <style> changes are ignored (no feedback loop)
          canvasObserverRef.current = new MutationObserver((mutations) => {
            if (mutations.some((m) => !(m.target instanceof HTMLStyleElement) && m.target.parentNode?.nodeName !== 'STYLE')) {
              refreshCanvasStyle();
            }
          });
          canvasObserverRef.current.observe(el.shadowRoot, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['width', 'height'],
          });
        }

        // Enable clipboard, disable IronRDP's buggy browser-polling loop in favor of our native GTK/Wayland sync
        try {
          ui.setEnableClipboard(clipboardAllowedRef.current);
          ui.setEnableAutoClipboard(false);
        } catch (clipErr) {
          console.warn('[RemoteFlow RDP] Błąd konfiguracji schowka:', clipErr);
        }

        // Enable Native RDP File & Directory Transfer (CLIPRDR) – only with the clipboard enabled
        if (clipboardAllowedRef.current) try {
          const ftProvider = new RdpFileTransferProvider({ chunkSize: 64 * 1024 });
          const origSetSession = ftProvider.setSession.bind(ftProvider);
          ftProvider.setSession = (wasmSess: any) => {
            rdpWasmSessionRef.current = wasmSess;
            origSetSession(wasmSess);
          };

          ftProvider.on('files-available', (files) => {
            if (!isSubscribed) return;
            setRemoteAvailableFiles(files);
            if (files.length === 0) return;
            if (isTauri() && isWindowsHost()) {
              // Windows: copy straight into the local clipboard (paste with Ctrl+V in Explorer)
              stageRemoteFilesToLocalClipboardRef.current(ftProvider, files);
            } else {
              showToast(
                t('Wykryto skopiowane pliki w Windows ({length})! Kliknij „Pobierz na komputer”, aby je zapisać.', { length: files.length }),
                5000
              );
            }
          });

          ftProvider.on('upload-progress', (prog) => {
            if (!isSubscribed) return;
            setUploadProgressText(t('Wklejanie do Windows: {fileName} ({p1}%)', { fileName: prog.fileName, p1: Math.round(prog.percentage) }));
          });

          ftProvider.on('upload-complete', (file) => {
            if (!isSubscribed) return;
            setUploadProgressText(t('Przesłano do Windows: {name}', { name: file.name }));
            setTimeout(() => setUploadProgressText(null), 2500);
          });

          ftProvider.on('error', (err) => {
            console.warn('[RemoteFlow RDP FileTransfer] Ostrzeżenie:', err);
          });

          ui.enableFileTransfer(ftProvider as any);
          fileTransferProviderRef.current = ftProvider;
        } catch (ftErr) {
          console.warn('[RemoteFlow RDP] Błąd inicjalizacji RdpFileTransferProvider:', ftErr);
        }

        setStatus('connecting');
        setStatusMessage(t('Negocjowanie parametrów NLA / TLS z serwerem...'));

        const proxyPort = session.rdpProxyPort;
        if (!proxyPort) {
          setStatus('error');
          setStatusMessage(t('Brak aktywnego mostka WebSocket-to-TCP dla sesji RDP'));
          return;
        }

        try {
          // Read from the vault only now – the password is not kept in the session data
          const rdpPassword = await api.getRdpSessionPassword(session.sessionId, session.connectionId);
          if (!isSubscribed) return;
          const targetDimensions = remoteDesktopSize(selectedResolution, containerRef.current, session.rdpSettings);

          const configBuilder = new ConfigBuilder()
            .withDestination(hostPort(session.host, session.port))
            .withProxyAddress(`ws://127.0.0.1:${proxyPort}`)
            .withAuthToken(session.rdpProxyToken || '')
            .withUsername(session.username || '')
            .withPassword(rdpPassword)
            .withServerDomain(session.rdpDomain || '')
            .withDesktopSize({ width: targetDimensions.width, height: targetDimensions.height });

          try {
            configBuilder.withExtension(enableCredssp(true));
            configBuilder.withExtension(displayControl(true));
          } catch (extErr) {
            console.warn('[RemoteFlow RDP] Ostrzeżenie przy dodawaniu rozszerzenia:', extErr);
          }

          const config = configBuilder.build();

          setStatusMessage(
            t('Autoryzacja (CredSSP / NLA) i inicjalizacja pulpitu {width}x{height}...', { width: targetDimensions.width, height: targetDimensions.height })
          );

          const connectPromise = ui.connect(config);
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    t('Przekroczono limit czasu odpowiedzi serwera RDP (15s). Sprawdź czy host jest osiągalny, czy poświadczenia są poprawne lub skorzystaj z przycisku FreeRDP poniżej.')
                  )
                ),
              15000
            );
          });

          const newSession = await Promise.race([connectPromise, timeoutPromise]);
          if (!isSubscribed) return;

          ui.setVisibility(true);
          setStatus('connected');
          lastAppliedResRef.current = targetDimensions;
          refreshCanvasStyle();
          setStatusMessage(
            targetDimensions.ratio > 1
              ? t('Sesja RDP aktywna ({width} × {height}, skalowanie {scale}%)', {
                  width: targetDimensions.width,
                  height: targetDimensions.height,
                  scale: rdpScaleFactor(targetDimensions.ratio),
                })
              : t('Sesja RDP aktywna ({width} × {height})', { width: targetDimensions.width, height: targetDimensions.height })
          );
          // The connection itself cannot carry the scale factor (the web client has no such
          // option), so it follows over Display Control once the channel is up. Sent twice: a
          // request made before the server opened the channel is dropped; the same layout again
          // changes nothing.
          if (targetDimensions.ratio > 1) {
            for (const delay of [1000, 3000]) {
              setTimeout(() => {
                const current = lastAppliedResRef.current;
                if (isSubscribed && userInteractionRef.current && current === targetDimensions) {
                  try {
                    sendRemoteSize(userInteractionRef.current, current);
                  } catch (err) {
                    console.warn('[RemoteFlow RDP] Scale factor not applied:', err);
                  }
                }
              }, delay);
            }
          }

          setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            focusRdpCanvas();
          }, 150);

          const termInfo = await newSession.run();
          if (!isSubscribed) return;

          setStatus('disconnected');
          setStatusMessage(t('Sesja RDP została zakończona: {reason}', { reason: termInfo?.reason() || t('Rozłączono przez serwer') }));
        } catch (err: any) {
          if (!isSubscribed) return;
          console.error('[RemoteFlow RDP] Błąd nawiązywania połączenia:', err);
          setStatus('error');
          let msg = err?.message;
          if (!msg && typeof err?.backtrace === 'function') {
            msg = err.backtrace();
          }
          if (!msg && err) {
            msg = err.toString();
            if (msg === '[object Object]') {
              msg = t('Błąd silnika RDP: odmowa autoryzacji (CredSSP / NLA) lub rozłączenie przez serwer');
            }
          }
          setStatusMessage(
            lastProxyErrorRef.current || msg || t('Błąd połączenia RDP (sprawdź poświadczenia lub NLA)')
          );
        }
      };

      localHandleReady = handleReady;
      el.addEventListener('ready', handleReady);
      container.appendChild(el);
    })();

    return () => {
      isSubscribed = false;
      if (localEl && localHandleReady) {
        localEl.removeEventListener('ready', localHandleReady);
      }
      if (userInteractionRef.current) {
        try {
          userInteractionRef.current.shutdown();
        } catch (e) {
          console.warn('Error during RDP shutdown:', e);
        }
        userInteractionRef.current = null;
      }
      rdpWasmSessionRef.current = null;
      fileTransferProviderRef.current = null;
      canvasObserverRef.current?.disconnect();
      canvasObserverRef.current = null;
      if (localEl && localEl.parentNode) {
        localEl.parentNode.removeChild(localEl);
      }
      elementRef.current = null;
    };
  }, [session.sessionId, session.rdpProxyPort, connectionAttempts]);

  // Adjust scale when toggled ('fit' vs 'real')
  const handleSetScale = (nextMode: 'fit' | 'real') => {
    if (nextMode === scaleMode) return;
    setScaleMode(nextMode);
    // Both modes are done by applyCanvasStyle; the component always stays in "fit"
    if (elementRef.current) {
      (elementRef.current as any).scale = 'fit';
    }
    if (userInteractionRef.current) {
      userInteractionRef.current.setScale(1);
    }
    scaleModeRef.current = nextMode;
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refreshCanvasStyle();
    }, 50);
  };

  // Debounced ResizeObserver for 'auto' resolution mode
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timeoutId: any = null;
    const applyAutoSize = (width: number, height: number) => {
      if (selectedResolution !== 'auto' || !userInteractionRef.current || status !== 'connected') return;
      const ratio = rdpPixelRatio();
      const size = autoSizeFromArea(width, height, ratio);
      if (!size) return;
      const last = lastAppliedResRef.current;
      if (last?.width === size.width && last?.height === size.height && last.ratio === ratio) return;
      const next: RemoteSize = { ...size, ratio };
      lastAppliedResRef.current = next;
      sendRemoteSize(userInteractionRef.current, next);
      refreshCanvasStyle();
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // At once: a canvas that no longer fits must go back to scale-to-fit until the server resizes
        refreshCanvasStyle();
        if (width > 300 && height > 200) {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => applyAutoSize(width, height), 200);
        }
      }
    });
    observer.observe(container);

    // The screen scaling changed (window moved to another monitor, Windows setting changed):
    // same size in CSS pixels, different size in device pixels.
    const reapply = () => {
      refreshCanvasStyle();
      const rect = container.getBoundingClientRect();
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => applyAutoSize(rect.width, rect.height), 200);
    };
    let scaleQuery: MediaQueryList | null = null;
    const onScaleChange = () => {
      watchScale();
      reapply();
    };
    const watchScale = () => {
      scaleQuery?.removeEventListener('change', onScaleChange);
      scaleQuery = window.matchMedia(`(resolution: ${screenScale()}dppx)`);
      scaleQuery.addEventListener('change', onScaleChange);
    };
    watchScale();

    return () => {
      observer.disconnect();
      clearTimeout(timeoutId);
      scaleQuery?.removeEventListener('change', onScaleChange);
    };
  }, [selectedResolution, status, refreshCanvasStyle]);

  // Synchronize clipboard when window regains focus or tab is activated
  useEffect(() => {
    if (!isActive) return;

    const handleFocus = () => {
      syncLocalClipboardToRemote(false);
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [isActive, syncLocalClipboardToRemote]);


  // Close Key Sequence menu on outside click
  useEffect(() => {
    if (!isKeyMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (keyMenuRef.current && !keyMenuRef.current.contains(e.target as Node)) {
        setIsKeyMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isKeyMenuOpen]);

  // Send arbitrary key combination to remote Windows RDP
  const sendKeyCombination = useCallback(
    (scancodes: number[], label?: string, useSpecial?: 'ctrlAltDel' | 'metaKey') => {
      try {
        if (useSpecial === 'ctrlAltDel' && userInteractionRef.current?.ctrlAltDel) {
          userInteractionRef.current.ctrlAltDel();
          if (label) showToast(t('Wysłano: {label}', { label }), 2000);
          focusRdpCanvas();
          return true;
        }

        if (useSpecial === 'metaKey' && userInteractionRef.current?.metaKey) {
          userInteractionRef.current.metaKey();
          if (label) showToast(t('Wysłano: {label}', { label }), 2000);
          focusRdpCanvas();
          return true;
        }

        const wasmSess = rdpWasmSessionRef.current;
        if (wasmSess && Backend?.InputTransaction && Backend?.DeviceEvent) {
          const tx = new Backend.InputTransaction();
          for (const code of scancodes) {
            tx.addEvent(Backend.DeviceEvent.keyPressed(code));
          }
          for (let i = scancodes.length - 1; i >= 0; i--) {
            tx.addEvent(Backend.DeviceEvent.keyReleased(scancodes[i]));
          }
          wasmSess.applyInputs(tx);
          if (label) showToast(t('Wysłano: {label}', { label }), 2000);
          focusRdpCanvas();
          return true;
        }
      } catch (err: any) {
        console.error('[RemoteFlow RDP] Błąd przesyłania kombinacji klawiszy:', err);
        showToast(t('Błąd: {p0}', { p0: err?.message || err }), 3000);
      }
      return false;
    },
    [showToast, focusRdpCanvas]
  );

  // Send raw text as simulated unicode keystrokes
  const sendTextSequence = useCallback(
    (text: string) => {
      if (!text) return;
      try {
        const wasmSess = rdpWasmSessionRef.current;
        if (wasmSess && Backend?.InputTransaction && Backend?.DeviceEvent) {
          const tx = new Backend.InputTransaction();
          for (const char of text) {
            tx.addEvent(Backend.DeviceEvent.unicodePressed(char));
            tx.addEvent(Backend.DeviceEvent.unicodeReleased(char));
          }
          wasmSess.applyInputs(tx);
          showToast(t('Wysłano tekst do Windows ({length} zn.)', { length: text.length }), 2000);
          focusRdpCanvas();
          return true;
        }
      } catch (err: any) {
        console.error('[RemoteFlow RDP] Błąd przesyłania tekstu:', err);
        showToast(t('Błąd tekstu: {p0}', { p0: err?.message || err }), 3000);
      }
      return false;
    },
    [showToast, focusRdpCanvas]
  );

  // Send custom constructed key combination
  const handleSendCustomCombo = useCallback(() => {
    const scancodes: number[] = [];
    if (customCtrl) scancodes.push(0x001d);
    if (customAlt) scancodes.push(0x0038);
    if (customShift) scancodes.push(0x002a);
    if (customWin) scancodes.push(0xe05b);
    if (customKey) scancodes.push(customKey);

    if (scancodes.length === 0) {
      showToast(t('Wybierz przynajmniej jeden klawisz'), 2000);
      return;
    }

    const labelParts: string[] = [];
    if (customCtrl) labelParts.push('Ctrl');
    if (customAlt) labelParts.push('Alt');
    if (customShift) labelParts.push('Shift');
    if (customWin) labelParts.push('Win');
    const keyOption = SCANCODE_OPTIONS.find((o) => o.code === customKey);
    if (keyOption) labelParts.push(t(keyOption.label));

    const label = labelParts.join(' + ');
    sendKeyCombination(scancodes, label);
    setIsKeyMenuOpen(false);
  }, [customCtrl, customAlt, customShift, customWin, customKey, sendKeyCombination, showToast]);

  // Copy session password to clipboard & RDP
  const handleCopyPassword = async () => {
    try {
      const pwd = await api.revealPassword(session.connectionId);
      if (pwd) {
        await api.clipboardWriteSecret(pwd);
        await handleSendCustomTextToRemote(pwd, false);
        setCopiedPassword(true);
        showToast(t('Skopiowano hasło do schowka – zniknie z niego za 30 s.'), 2500);
        setTimeout(() => setCopiedPassword(false), 2000);
      } else {
        showToast(t('Brak zapisanego hasła dla tej sesji'), 2500);
      }
    } catch (err) {
      console.error('Błąd kopiowania hasła:', err);
      showToast(t('Nie udało się skopiować hasła'), 2500);
    }
  };

  // Pop-out / Launch native FreeRDP window
  const handleLaunchExternal = async () => {
    setIsLaunchingExternal(true);
    try {
      await api.launchExternalRdp(session);
      showToast(t('Uruchomiono zewnętrzne okno FreeRDP (z dyskiem Ten komputer -> RemoteFlow)'), 4000);
    } catch (err: any) {
      console.error('Błąd uruchamiania FreeRDP:', err);
      showToast(t('Błąd FreeRDP: {p0}', { p0: err?.message || err }));
    } finally {
      setIsLaunchingExternal(false);
    }
  };

  // Fullscreen container toggle
  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.parentElement?.requestFullscreen().then(() => {
        setIsFullscreen(true);
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 150);
      }).catch(console.error);
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 150);
      }).catch(console.error);
    }
  };

  // Download standard Microsoft .rdp file
  const handleDownloadRdp = () => {
    const dim = getDimensionsForPreset(selectedResolution, containerRef.current, session.rdpSettings);
    // Values come from the vault (possibly from an imported file): a line break would add
    // settings of its own to the .rdp file (e.g. drive redirection), so it is removed
    const clean = (v: string | undefined) => (v ?? '').replace(/[\r\n]/g, '');
    const login = session.rdpDomain ? `${clean(session.rdpDomain)}\\${clean(session.username)}` : clean(session.username);
    const rdpContent = [
      // IPv6 in brackets: [::1]:3389
      `full address:s:${hostPort(clean(session.host), session.port)}`,
      `username:s:${login}`,
      `screen mode id:i:2`,
      `use multimon:i:1`,
      `desktopwidth:i:${dim.width}`,
      `desktopheight:i:${dim.height}`,
      `session bpp:i:32`,
      `compression:i:1`,
      `keyboardhook:i:2`,
      `audiomode:i:${session.rdpSettings?.sound ? 0 : 2}`,
      `redirectclipboard:i:${clipboardAllowed ? 1 : 0}`,
      // Local drives are never shared with the server (it would get access to all local files)
      `redirectdrives:i:0`,
      `drivestoredirect:s:`,
      `redirectprinters:i:0`,
      `displayconnectionbar:i:1`,
      `autoreconnection enabled:i:1`,
      `authentication level:i:2`,
      `negotiate security layer:i:1`,
      `prompt for credentials:i:0`,
    ].join('\r\n');

    const blob = new Blob([rdpContent], { type: 'application/x-rdp' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.rdp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Handle tab visibility changes without unmounting
  useEffect(() => {
    if (!isActive) {
      // Do not keep keyboard focus (and IronRDP key capture) in a hidden session
      const host = elementRef.current as HTMLElement | null;
      if (host && (document.activeElement === host || host.contains(document.activeElement))) {
        host.blur();
      }
    }
    if (userInteractionRef.current) {
      userInteractionRef.current.setVisibility(isActive);
      if (isActive) {
        userInteractionRef.current.setScale(1); // both modes: applyCanvasStyle
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          refreshCanvasStyle();
          focusRdpCanvas();
        }, 50);
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 150);
      }
    }
  }, [isActive, scaleMode, focusRdpCanvas, refreshCanvasStyle]);

  // Send F5 refresh key (scancode 0x003F) directly to remote Windows session
  const sendF5ToRemote = useCallback(() => {
    try {
      const wasmSess = rdpWasmSessionRef.current;
      if (wasmSess && Backend?.InputTransaction && Backend?.DeviceEvent) {
        const tx = new Backend.InputTransaction();
        const f5Scancode = 0x003f;
        tx.addEvent(Backend.DeviceEvent.keyPressed(f5Scancode));
        tx.addEvent(Backend.DeviceEvent.keyReleased(f5Scancode));
        wasmSess.applyInputs(tx);
        showToast(t('Wysłano F5 (odświeżenie) do Windows'), 1500);
        return true;
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd przesyłania F5 do sesji zdalnej:', err);
    }
    return false;
  }, [showToast]);

  // NumLock: before a keypad key reaches the server, bring the server's NumLock to the state the
  // key event shows (see utils/rdpLockKeys). The server's state is unknown after connecting, so
  // the first keypad key always synchronises.
  const serverNumLockRef = useRef<boolean | null>(null);
  useEffect(() => {
    serverNumLockRef.current = null;
  }, [status]);
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      trackNumLock(e);
      if (e.type !== 'keydown' || status !== 'connected') return;
      if (e.code === 'NumLock' || e.code === 'CapsLock' || e.code === 'ScrollLock') {
        // IronRDP synchronises all lock keys on these – with the (fixed) NumLock state
        serverNumLockRef.current = null;
        return;
      }
      const wanted = numLockFromEvent(e);
      if (wanted === null || wanted === serverNumLockRef.current) return;
      const session = rdpWasmSessionRef.current as any;
      if (!session?.synchronizeLockKeys) return;
      try {
        session.synchronizeLockKeys(false, wanted, e.getModifierState('CapsLock'), false);
        serverNumLockRef.current = wanted;
      } catch (err) {
        console.warn('[RemoteFlow RDP] Synchronizacja NumLock nie powiodła się:', err);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKey, { capture: true });
    };
  }, [isActive, status]);

  // Intercept F5 and Ctrl+R to prevent app reload, and send F5 to remote desktop if active
  useEffect(() => {
    if (!isActive) return;

    const handleRdpKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        e.stopPropagation();
        if (status === 'connected') {
          sendF5ToRemote();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
        // Prevent accidental page reload
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleRdpKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleRdpKeyDown, { capture: true });
    };
  }, [isActive, status, sendF5ToRemote]);

  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';
  const isError = status === 'error';

  return (
    <div
      // Always laid out (visibility of inactive tabs is controlled by the Workspace pane):
      // display:none would discard the canvas contents on WebKitGTK and trigger remote resizes.
      className="flex h-full w-full flex-col bg-slate-950 select-none overflow-hidden font-sans"
    >
      {/* Top Action Toolbar */}
      <div className="flex h-11 items-center justify-between border-b border-slate-800 bg-slate-900/95 px-3 text-xs shrink-0 z-20 shadow-md">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-blue-400 font-semibold shrink-0">
            <Monitor className="h-4 w-4 shrink-0" />
            <span className="truncate max-w-[130px]">{session.title}</span>
          </div>
          <span className="text-slate-600">|</span>
          <span className="font-mono text-slate-300 text-[11px] truncate max-w-[160px]">
            {session.username}@{session.host}:{session.port}
          </span>
          <div className="flex items-center gap-1.5 ml-1 shrink-0">
            <span
              className={`h-2 w-2 rounded-full shrink-0 ${
                isConnected
                  ? 'bg-emerald-400 shadow-xs shadow-emerald-400/50'
                  : isConnecting
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400'
              }`}
            />
            <span
              className={`text-[11px] font-medium hidden sm:inline ${
                isConnected
                  ? 'text-emerald-400'
                  : isConnecting
                  ? 'text-amber-400'
                  : 'text-red-400'
              }`}
            >
              {isConnected
                ? t('Aktywny')
                : isConnecting
                ? t('Łączenie...')
                : isError
                ? t('Błąd połączenia')
                : t('Rozłączono')}
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-1.5 ml-2 border-l border-slate-800 pl-2 text-[10px] text-slate-400 shrink-0">
            <span className="flex items-center gap-1 text-emerald-400" title={t('Szyfrowanie TLS / NLA aktywne')}>
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>TLS</span>
            </span>
            {session.rdpSettings?.sound && (
              <span className="flex items-center gap-1 text-purple-400" title={t('Dźwięk zdalny włączony')}>
                <Volume2 className="h-3.5 w-3.5" />
              </span>
            )}
          </div>

          {/* Plik/katalog gotowy do wklejenia na pasku informacyjnym RDP obok TLS */}
          {stagedUploadNames.length > 0 && isConnected && (
            <div className="flex items-center gap-1.5 ml-2 rounded-full bg-emerald-950/90 border border-emerald-500/60 px-2.5 py-0.5 text-[10px] text-emerald-200 font-medium shadow-xs shrink-0 animate-in fade-in duration-150">
              <FileUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span className="truncate max-w-[180px] sm:max-w-[260px]">
                Gotowe: <strong className="text-white">{stagedUploadNames.join(', ')}</strong>
              </span>
              <button
                onClick={() => {
                  focusRdpCanvas();
                  userInteractionRef.current?.ctrlV();
                }}
                title={t('Wklej w sesji Windows (Ctrl+V)')}
                className="ml-1 rounded bg-emerald-600 hover:bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white transition-colors"
              >
                Ctrl+V
              </button>
              <button
                onClick={() => {
                  hasStagedUploadRef.current = false;
                  stagedDroppedFilesRef.current = [];
                  setStagedUploadNames([]);
                }}
                title={t('Anuluj')}
                className="text-emerald-300 hover:text-white p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Informacja o skopiowanych plikach w Windows na głównym pasku połączenia */}
          {remoteAvailableFiles.length > 0 && isConnected && (
            <div
              onClick={() => {
                if (!isDownloadingRemoteFiles) {
                  handleDownloadRemoteFiles();
                }
              }}
              title={t('Skopiowano pliki w sesji Windows. Kliknij, aby pobrać je od razu na komputer (do wspólnego katalogu wymiany).')}
              className="flex items-center gap-1.5 ml-2 rounded-full bg-cyan-950/90 border border-cyan-500/60 px-2.5 py-0.5 text-[10px] text-cyan-200 font-medium shadow-xs shrink-0 cursor-pointer hover:bg-cyan-900/90 hover:border-cyan-400 transition-all animate-in fade-in duration-150"
            >
              {isDownloadingRemoteFiles ? (
                <Loader2 className="h-3.5 w-3.5 text-cyan-400 animate-spin shrink-0" />
              ) : (
                <Download className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
              )}
              <span className="truncate max-w-[170px] sm:max-w-[260px]">
                {isDownloadingRemoteFiles ? (
                  <span>{t('Pobieranie plików na komputer...')}</span>
                ) : (
                  <>
                    {t('Pobierz z Windows ({n}):', { n: remoteAvailableFiles.length })}{' '}
                    <strong className="text-white">
                      {remoteAvailableFiles.slice(0, 2).map((f) => f.name).join(', ')}
                      {remoteAvailableFiles.length > 2 ? ` (+${remoteAvailableFiles.length - 2})` : ''}
                    </strong>
                  </>
                )}
              </span>
              {!isDownloadingRemoteFiles && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemoteAvailableFiles([]);
                  }}
                  title={t('Odrzuć powiadomienie')}
                  className="text-cyan-300 hover:text-white p-0.5 ml-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {/* Real-time Feedback Toast Badge */}
          {(clipboardFeedback || uploadProgressText) && (
            <div className="flex items-center gap-1 ml-2 rounded-full bg-cyan-950/90 border border-cyan-500/60 px-2.5 py-0.5 text-[10px] text-cyan-200 font-medium shadow-xs truncate max-w-[340px]">
              <Check className="h-3 w-3 text-cyan-400 shrink-0" />
              <span className="truncate">{uploadProgressText || clipboardFeedback}</span>
            </div>
          )}

          {/* Saving Files indicator */}
          {isSavingFiles && (
            <div className="flex items-center gap-1 ml-2 rounded-full bg-amber-950/90 border border-amber-500/60 px-2 py-0.5 text-[10px] text-amber-300 font-medium shadow-xs shrink-0">
              <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
              <span>{t('Przygotowywanie plików...')}</span>
            </div>
          )}
        </div>

        {/* Quick Toolbar Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Resolution Selector Dropdown */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-slate-200 hover:border-slate-600">
            <Tv className="h-3 w-3 text-cyan-400 shrink-0" />
            <select
              value={selectedResolution}
              onChange={(e) => applyResolution(e.target.value)}
              disabled={!isConnected}
              title={t('Zmień rozdzielczość pulpitu zdalnego w czasie rzeczywistym')}
              className="bg-transparent text-[11px] font-medium text-slate-200 outline-hidden cursor-pointer disabled:opacity-50"
            >
              {RESOLUTION_PRESETS.map((p) => (
                <option key={p.value} value={p.value} className="bg-slate-900 text-slate-200">
                  {t(p.label)}
                </option>
              ))}
            </select>
          </div>

          {/* Performance statistics of the embedded client */}
          <button
            onClick={() => setIsStatsOpen((v) => !v)}
            title={t('Statystyki wydajności RDP (dane, rysowanie, obciążenie)')}
            className={`flex items-center rounded-lg border px-2 py-1 text-xs transition-colors ${
              isStatsOpen
                ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-200 hover:bg-cyan-900/50'
                : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <Activity className="h-3 w-3 text-cyan-400" />
          </button>

          {/* Scale Switcher: Fit vs Real (100% 1:1) – only for a fixed resolution: in Auto the
              desktop always has the size of the area, so both would look the same */}
          {selectedResolution !== 'auto' && (
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800/60 p-0.5" role="group">
              <ZoomIn className="mx-1 h-3 w-3 text-amber-400" />
              {(
                [
                  ['fit', t('Dopasuj'), t('Dopasuj do okna')],
                  ['real', '100%', t('100% oryginał (1:1)')],
                ] as const
              ).map(([mode, label, title]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleSetScale(mode)}
                  title={title}
                  aria-pressed={scaleMode === mode}
                  className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                    scaleMode === mode ? 'bg-cyan-600 text-white' : 'text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Toggle Unified Files & Clipboard Drawer */}
          <button
            onClick={() => setIsClipboardDrawerOpen((v) => !v)}
            disabled={!clipboardAllowed}
            title={clipboardAllowed ? t('Transfer plików, katalogów i menedżer schowka RDP') : t('Schowek jest wyłączony w ustawieniach tego połączenia')}
            className={`relative flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              isClipboardDrawerOpen
                ? 'border-emerald-500 bg-emerald-950/60 text-emerald-200 shadow-xs'
                : remoteAvailableFiles.length > 0 || stagedUploadNames.length > 0
                ? 'border-cyan-500 bg-cyan-950/50 text-cyan-200'
                : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white'
            } disabled:cursor-default disabled:opacity-40`}
          >
            <FolderSync className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-[11px] font-medium hidden sm:inline">{t('Pliki i Schowek')}</span>
            {(remoteAvailableFiles.length > 0 || stagedUploadNames.length > 0) && (
              <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[9px] font-bold text-slate-950">
                {remoteAvailableFiles.length || stagedUploadNames.length}
              </span>
            )}
          </button>

          {/* Wyślij sekwencję klawiszy do Windows */}
          <div className="relative" ref={keyMenuRef}>
            <button
              onClick={() => setIsKeyMenuOpen((v) => !v)}
              disabled={!isConnected}
              title={t('Wyślij sekwencję lub kombinację klawiszy do systemu Windows (Ctrl+Alt+Del, Win+L, itp.)')}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 disabled:pointer-events-none ${
                isKeyMenuOpen
                  ? 'border-amber-500 bg-amber-950/70 text-amber-200 shadow-xs'
                  : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <Keyboard className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="text-[11px] font-medium hidden sm:inline">{t('Wyślij sekwencję klawiszy')}</span>
              <ChevronDown
                className={`h-3 w-3 text-slate-400 transition-transform ${isKeyMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isKeyMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-84 sm:w-96 max-h-[80vh] overflow-y-auto rounded-xl border border-slate-700/80 bg-slate-900/98 p-3 shadow-2xl backdrop-blur-md z-50 text-slate-200">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2.5">
                  <div className="flex items-center gap-1.5">
                    <Keyboard className="h-4 w-4 text-amber-400" />
                    <span className="text-xs font-bold text-white">{t('Sekwencja klawiszy Windows')}</span>
                  </div>
                  <button
                    onClick={() => setIsKeyMenuOpen(false)}
                    className="rounded-md p-1 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Tabs */}
                <div className="flex rounded-lg bg-slate-950 p-0.5 mb-3 border border-slate-800">
                  <button
                    onClick={() => setKeyMenuTab('shortcuts')}
                    className={`flex-1 rounded-md py-1 text-[11px] font-semibold transition-all ${
                      keyMenuTab === 'shortcuts'
                        ? 'bg-slate-800 text-cyan-300 shadow-xs'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t('Szybkie skróty')}
                  </button>
                  <button
                    onClick={() => setKeyMenuTab('custom')}
                    className={`flex-1 rounded-md py-1 text-[11px] font-semibold transition-all ${
                      keyMenuTab === 'custom'
                        ? 'bg-slate-800 text-cyan-300 shadow-xs'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t('Własna kombinacja')}
                  </button>
                  <button
                    onClick={() => setKeyMenuTab('text')}
                    className={`flex-1 rounded-md py-1 text-[11px] font-semibold transition-all ${
                      keyMenuTab === 'text'
                        ? 'bg-slate-800 text-cyan-300 shadow-xs'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t('Wpisz tekst')}
                  </button>
                </div>

                {/* Tab: Szybkie skróty */}
                {keyMenuTab === 'shortcuts' && (
                  <div className="space-y-3">
                    {/* System i Logowanie */}
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
                        <ShieldCheck className="h-3 w-3 text-cyan-400" />
                        <span>{t('System i Logowanie')}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => {
                            sendKeyCombination([0x001d, 0x0038, 0xe053], t('Ctrl + Alt + Del'), 'ctrlAltDel');
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-950/20 px-2.5 py-1.5 text-left hover:bg-amber-900/40 hover:border-amber-500/60 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-amber-300">Ctrl+Alt+Del</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Logowanie')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0x001d, 0x002a, 0x0001], t('Ctrl + Shift + Esc'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-cyan-300">Ctrl+Shift+Esc</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menedżer')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x0026], t('Win + L'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-blue-300">{t('Win + L')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Zablokuj')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b], t('Klawisz Windows'), 'metaKey');
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-blue-400">{t('Klawisz Win')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menu Start')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x0013], t('Win + R'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + R')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Uruchom')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x0012], t('Win + E'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + E')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Eksplorator')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x0020], t('Win + D'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + D')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Pulpit')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x002d], t('Win + X'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + X')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menu szybkie')}</span>
                        </button>
                      </div>
                    </div>

                    {/* Okna i Aplikacje */}
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
                        <Tv className="h-3 w-3 text-purple-400" />
                        <span>{t('Okna i Aplikacje')}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => {
                            sendKeyCombination([0x0038, 0x000f], t('Alt + Tab'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-purple-300">{t('Alt + Tab')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Przełącz okno')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0x0038, 0x003e], t('Alt + F4'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-950/20 px-2.5 py-1.5 text-left hover:bg-red-900/40 hover:border-red-500/50 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-red-300">{t('Alt + F4')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Zamknij okno')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0xe048], t('Win + Góra'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + ↑')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Maksymalizuj')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0xe050], t('Win + Dół'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + ↓')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Minimalizuj')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0x0038, 0x0039], t('Alt + Spacja'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Alt + Spacja')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menu okna')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x000f], t('Win + Tab'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + Tab')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Widok zadań')}</span>
                        </button>
                      </div>
                    </div>

                    {/* Narzędzia i Schowek */}
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
                        <Clipboard className="h-3 w-3 text-emerald-400" />
                        <span>{t('Narzędzia i Schowek')}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x002a, 0x001f], t('Win + Shift + S'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-emerald-300">Win+Shift+S</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Wycinanie')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe037], t('Print Screen'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Print Screen')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Zrzut ekranu')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendKeyCombination([0xe05b, 0x002f], t('Win + V'));
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-slate-200">{t('Win + V')}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Schowek Win')}</span>
                        </button>

                        <button
                          onClick={() => {
                            sendF5ToRemote();
                            setIsKeyMenuOpen(false);
                          }}
                          className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                        >
                          <span className="text-[11px] font-semibold text-amber-400">F5</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Odśwież')}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Tab: Własna kombinacja */}
                {keyMenuTab === 'custom' && (
                  <div className="space-y-3">
                    <div>
                      <span className="text-[11px] font-medium text-slate-300 block mb-1.5">
                        {t('Klawisze modyfikujące:')}
                      </span>
                      <div className="grid grid-cols-4 gap-1.5">
                        {[
                          { label: 'Ctrl', active: customCtrl, toggle: () => setCustomCtrl(!customCtrl) },
                          { label: 'Alt', active: customAlt, toggle: () => setCustomAlt(!customAlt) },
                          { label: 'Shift', active: customShift, toggle: () => setCustomShift(!customShift) },
                          { label: 'Win', active: customWin, toggle: () => setCustomWin(!customWin) },
                        ].map((mod) => (
                          <button
                            key={mod.label}
                            type="button"
                            onClick={mod.toggle}
                            className={`flex items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition-all ${
                              mod.active
                                ? 'border-cyan-500 bg-cyan-950/70 text-cyan-200 shadow-xs'
                                : 'border-slate-700 bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                            }`}
                          >
                            {mod.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <span className="text-[11px] font-medium text-slate-300 block mb-1.5">
                        {t('Klawisz główny:')}
                      </span>
                      <select
                        value={customKey}
                        onChange={(e) => setCustomKey(parseInt(e.target.value, 10))}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 focus:border-cyan-500 focus:outline-hidden"
                      >
                        {Object.entries(
                          SCANCODE_OPTIONS.reduce((acc, opt) => {
                            if (!acc[opt.group]) acc[opt.group] = [];
                            acc[opt.group].push(opt);
                            return acc;
                          }, {} as Record<string, typeof SCANCODE_OPTIONS>)
                        ).map(([group, opts]) => (
                          <optgroup key={group} label={t(group)} className="bg-slate-900 text-slate-300">
                            {opts.map((opt) => (
                              <option key={opt.label + opt.code} value={opt.code} className="bg-slate-800 text-slate-200">
                                {t(opt.label)}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>

                    {/* Preview and Send button */}
                    <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
                      <div className="flex-1 min-w-0 font-mono text-xs text-cyan-300 bg-slate-950 border border-slate-800 px-2.5 py-1.5 rounded-lg truncate text-center">
                        {[
                          customCtrl && 'Ctrl',
                          customAlt && 'Alt',
                          customShift && 'Shift',
                          customWin && 'Win',
                          t(SCANCODE_OPTIONS.find((o) => o.code === customKey)?.label || 'Klawisz'),
                        ]
                          .filter(Boolean)
                          .join(' + ')}
                      </div>
                      <button
                        onClick={handleSendCustomCombo}
                        className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition-colors shrink-0 shadow-xs"
                      >
                        <Send className="h-3 w-3" />
                        <span>{t('Wyślij')}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Tab: Wpisz tekst */}
                {keyMenuTab === 'text' && (
                  <div className="space-y-2">
                    <span className="text-[11px] text-slate-300 block">
                      {t('Wpisz tekst do wysłania jako sekwencję naciśnięć klawiszy do systemu Windows:')}
                    </span>
                    <textarea
                      value={customTextInput}
                      onChange={(e) => setCustomTextInput(e.target.value)}
                      placeholder={t('Wpisz lub wklej tekst do wysłania...')}
                      rows={3}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-hidden resize-none font-mono"
                    />
                    <div className="flex justify-end">
                      <button
                        onClick={() => {
                          sendTextSequence(customTextInput);
                          setCustomTextInput('');
                          setIsKeyMenuOpen(false);
                        }}
                        disabled={!customTextInput.trim()}
                        className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:pointer-events-none transition-colors shadow-xs"
                      >
                        <Send className="h-3 w-3" />
                        <span>{t('Wyślij tekst ({n} zn.)', { n: customTextInput.length })}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Send F5 (Odśwież) to Windows */}
          <button
            onClick={sendF5ToRemote}
            disabled={!isConnected}
            title={t('Wyślij klawisz F5 (Odśwież w systemie Windows) [F5]')}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            <span className="text-[11px] font-semibold text-amber-400">F5</span>
            <span className="text-[11px] hidden lg:inline text-slate-300">{t('Odśwież')}</span>
          </button>

          {/* Copy Password Button */}
          <button
            onClick={handleCopyPassword}
            title={t('Kopiuj hasło sesji do schowka (lokalnego i RDP)')}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
          >
            {copiedPassword ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <KeyRound className="h-3 w-3 text-cyan-400" />
            )}
            <span className="text-[11px] hidden md:inline">{copiedPassword ? t('Skopiowano!') : t('Hasło')}</span>
          </button>

          {/* Fullscreen Toggle */}
          <button
            onClick={handleToggleFullscreen}
            title={isFullscreen ? t('Opuść pełny ekran') : t('Pełny ekran')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5 text-cyan-400" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5 text-slate-400" />
            )}
          </button>

          {/* Reconnect Button */}
          <button
            onClick={() => setConnectionAttempts((c) => c + 1)}
            title={t('Połącz ponownie')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5 text-slate-400" />
          </button>
        </div>
      </div>

      {/* Main Canvas Container for IronRDP WebAssembly */}
      <div
        onMouseEnter={() => syncLocalClipboardToRemote(false)}
        onPointerDown={() => focusRdpCanvas()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative flex-1 min-h-0 min-w-0 w-full bg-rdp-bg flex items-center justify-center ${
          scaleMode === 'real' ? 'overflow-auto' : 'overflow-hidden'
        }`}
      >
        {/* Web Component mount point */}
        <div
          ref={containerRef}
          className="w-full h-full flex items-center justify-center overflow-hidden"
        />

        {/* Drag & Drop Files Overlay */}
        {isDragOver && (
          <div className="absolute inset-0 bg-cyan-950/85 border-2 border-dashed border-cyan-400 backdrop-blur-xs flex flex-col items-center justify-center z-30 pointer-events-none p-6 text-center animate-fadeIn">
            <FileUp className="h-12 w-12 text-cyan-400 mb-3 animate-bounce" />
            <h3 className="text-base font-bold text-white">{t('Upuść pliki lub katalogi do sesji Windows RDP')}</h3>
            <p className="text-xs text-cyan-200/90 mt-1 max-w-md">
              {t('Zostaną umieszczone bezpośrednio w schowku Windows RDP (wystarczy nacisnąć Ctrl+V lub wybrać „Wklej” w dowolnym folderze Windows) oraz zapisane w ~/RemoteFlow_Shared.')}
            </p>
          </div>
        )}

        {/* Unified Files & Clipboard Manager Drawer */}
        {isClipboardDrawerOpen && (
          <div className="absolute top-0 right-0 bottom-0 w-full sm:w-[440px] bg-slate-950/95 border-l border-slate-800 shadow-2xl backdrop-blur-md flex flex-col z-40 transition-all font-sans text-xs animate-in slide-in-from-right duration-200">
            <div className="flex h-11 items-center justify-between border-b border-slate-800 px-3 bg-slate-900/90 shrink-0">
              <div className="flex items-center gap-2">
                <FolderSync className="h-4 w-4 text-emerald-400" />
                <span className="font-semibold text-white">{t('Transfer Plików, Katalogów i Schowek RDP')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleClearClipboard}
                  title={t('Wyczyść schowek (usuń przygotowane pliki, tekst oraz zresetuj schowek RDP)')}
                  className="flex items-center gap-1 rounded bg-slate-800 hover:bg-rose-900/60 hover:border-rose-500/50 border border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-rose-200 transition-colors"
                >
                  <Trash2 className="h-3 w-3 text-rose-400" />
                  <span>{t('Wyczyść schowek')}</span>
                </button>
                <button
                  onClick={() => {
                    setIsClipboardDrawerOpen(false);
                    focusRdpCanvas();
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col gap-3.5 overflow-y-auto">
              {/* SECTION 1: Send Files & Directories to Windows */}
              <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Upload className="h-3.5 w-3.5 text-cyan-400" />
                    <span>{t('1. Wyślij pliki lub katalogi do Windows')}</span>
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  {t('Wybierz pliki lub cały katalog poniżej (albo przeciągnij je na ekran RDP). Po wybraniu przejdź do okna Windows (np. na Pulpit lub do Eksploratora plików) i naciśnij Ctrl+V (prawy przycisk myszy → „Wklej”).')}
                </p>

                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <button
                    onClick={() => rdpFileInputRef.current?.click()}
                    disabled={!isConnected || isSavingFiles}
                    className="flex items-center gap-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors"
                  >
                    <Upload className="h-3 w-3" />
                    <span>{t('Wybierz pliki...')}</span>
                  </button>
                  <input
                    ref={rdpFileInputRef}
                    type="file"
                    multiple
                    onChange={async (e) => {
                      const files = e.target.files ? Array.from(e.target.files) : [];
                      if (files.length > 0) {
                        const dropped: DroppedFile[] = files.map((f) => ({
                          file: f,
                          name: f.name,
                          size: f.size,
                          lastModified: f.lastModified,
                        }));
                        await stageDroppedFilesToRdpClipboard(dropped);
                      }
                      e.target.value = '';
                    }}
                    className="hidden"
                  />

                  <button
                    onClick={() => {
                      const next = !isLocalBrowserOpen;
                      setIsLocalBrowserOpen(next);
                      if (next) loadLocalDirectory(localCurrentPath || '');
                    }}
                    disabled={!isConnected || isSavingFiles}
                    className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                      isLocalBrowserOpen
                        ? 'border-amber-500 bg-amber-950/70 text-amber-200'
                        : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200'
                    }`}
                  >
                    <Folder className="h-3 w-3 text-amber-400" />
                    <span>{t('Wybierz katalog...')}</span>
                  </button>

                  <button
                    onClick={async () => {
                      const clipFiles = await api.clipboardReadFiles();
                      if (clipFiles.length > 0) {
                        await stageLocalPathsToRdpClipboard(clipFiles);
                      } else {
                        showToast(t('Brak skopiowanych plików/katalogów w schowku Linux (użyj Ctrl+C w menedżerze plików)'));
                      }
                    }}
                    disabled={!isConnected || isSavingFiles}
                    className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition-colors"
                    title={t('Jeśli skopiowałeś plik lub katalog w systemie Linux (Ctrl+C), kliknij tutaj aby przekazać go do schowka Windows')}
                  >
                    <ClipboardPaste className="h-3 w-3 text-emerald-400" />
                    <span>{t('Ze schowka Linux')}</span>
                  </button>
                </div>

                {/* Built-in Local Folder Browser for 1-click recursive directory selection */}
                {isLocalBrowserOpen && (
                  <div className="mt-2 rounded-lg border border-amber-500/40 bg-slate-950 p-2 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-amber-300 flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        <span>{t('Kliknij „Wyślij katalog” przy wybranym folderze:')}</span>
                      </span>
                      <button
                        onClick={async () => {
                          const dir = await api.pickLocalFolder();
                          if (dir) await stageLocalPathsToRdpClipboard([dir]);
                        }}
                        className="rounded border border-amber-500/40 bg-amber-950/60 hover:bg-amber-900 px-2 py-0.5 text-[10px] text-amber-200"
                      >
                        {t('Okno systemowe...')}
                      </button>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={handleLocalNavigateUp}
                        disabled={!localCurrentPath || localCurrentPath === '/' || localLoading}
                        className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <input
                        type="text"
                        value={localCurrentPath}
                        onChange={(e) => setLocalCurrentPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') loadLocalDirectory(localCurrentPath);
                        }}
                        className="flex-1 h-6 rounded border border-slate-700 bg-slate-900 px-2 font-mono text-[10px] text-slate-200"
                      />
                      {localCurrentPath.split('/').filter(Boolean).length > 2 && (
                        <button
                          onClick={() => stageLocalPathsToRdpClipboard([localCurrentPath])}
                          className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white shrink-0"
                        >
                          {t('Wyślij ten katalog')}
                        </button>
                      )}
                    </div>

                    <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/50 rounded border border-slate-800">
                      {localLoading ? (
                        <div className="flex items-center justify-center py-4 text-slate-400 gap-1.5">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
                          <span>Wczytywanie...</span>
                        </div>
                      ) : (
                        localEntries.map((item) => (
                          <div
                            key={item.path}
                            className="flex items-center justify-between px-2 py-1 hover:bg-slate-900"
                          >
                            <div
                              onClick={() => {
                                if (item.isDir) loadLocalDirectory(item.path);
                              }}
                              className={`flex items-center gap-1.5 min-w-0 flex-1 ${
                                item.isDir ? 'cursor-pointer text-amber-200 hover:text-amber-300' : 'text-slate-400'
                              }`}
                            >
                              {item.isDir ? (
                                <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                              ) : (
                                <File className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                              )}
                              <span className="truncate text-[11px]">{item.name}</span>
                            </div>
                            <button
                              onClick={() => stageLocalPathsToRdpClipboard([item.path])}
                              className={`ml-2 rounded px-2 py-0.5 text-[10px] font-medium shrink-0 ${
                                item.isDir
                                  ? 'bg-amber-600 hover:bg-amber-500 text-white'
                                  : 'bg-slate-800 hover:bg-cyan-600 text-slate-200'
                              }`}
                            >
                              {item.isDir ? t('Wyślij katalog') : t('Wyślij plik')}
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {/* Download files copied from Windows */}
                {remoteAvailableFiles.length > 0 ? (
                  <div className="mt-2 rounded-lg border border-cyan-500/60 bg-cyan-950/60 p-2.5 flex flex-col gap-2 shadow-sm animate-in fade-in duration-150">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-cyan-200 flex items-center gap-1.5">
                        <Download className="h-3.5 w-3.5 text-cyan-400" />
                        <span>{t('Skopiowano w sesji Windows ({n}):', { n: remoteAvailableFiles.length })}</span>
                      </span>
                      <button
                        onClick={() => setRemoteAvailableFiles([])}
                        className="text-slate-400 hover:text-white p-0.5"
                        title={t('Wyczyść listę')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="max-h-28 overflow-y-auto text-[10px] font-mono text-slate-300 space-y-1 rounded bg-slate-950/80 p-2 border border-slate-800">
                      {remoteAvailableFiles.map((f, idx) => (
                        <div key={idx} className="flex items-center justify-between truncate">
                          <span className="truncate">{f.path ? `${f.path}\\${f.name}` : f.name}</span>
                          <span className="text-slate-500 ml-2">{formatBytes(f.size)}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={handleDownloadRemoteFiles}
                      disabled={isDownloadingRemoteFiles}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 py-2 text-[11px] font-semibold text-white shadow-xs transition-colors"
                    >
                      {isDownloadingRemoteFiles ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      <span>{t('Pobierz na komputer (~/RemoteFlow_Shared)')}</span>
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 rounded border border-slate-800/80 bg-slate-950/40 p-2 text-[10px] text-slate-400 leading-relaxed">
                    <span className="text-slate-300 font-medium">{t('Kopiowanie z Windows na komputer:')}</span>{' '}
                    {t('zaznacz plik w sesji Windows i naciśnij Ctrl+C. Na głównym pasku połączenia pojawi się informacja, a w tym menu uaktywni się przycisk „Pobierz na komputer”.')}
                  </div>
                )}
              </div>

              {/* SECTION 2: Text Clipboard Sync */}
              <div className="flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Clipboard className="h-3.5 w-3.5 text-emerald-400" />
                    <span>{t('2. Schowek tekstowy (Linux ↔ Windows)')}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    {clipboardDraft && (
                      <button
                        onClick={() => setClipboardDraft('')}
                        className="text-[10px] text-slate-400 hover:text-rose-300 transition-colors"
                      >
                        {t('Wyczyść')}
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        const text = await api.clipboardReadText();
                        if (text) {
                          setClipboardDraft(text);
                          showToast(t('Wczytano tekst ze schowka systemowego'));
                        }
                      }}
                      className="text-[10px] text-cyan-400 hover:underline"
                    >
                      {t('Wczytaj ze schowka Linux')}
                    </button>
                  </div>
                </div>
                <textarea
                  value={clipboardDraft}
                  onChange={(e) => setClipboardDraft(e.target.value)}
                  placeholder={t('Wpisz lub wklej tekst, hasło lub polecenie PowerShell/CMD...')}
                  rows={3}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-cyan-500"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleSendCustomTextToRemote(clipboardDraft, true)}
                    disabled={!clipboardDraft}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 py-1.5 text-white font-medium shadow-xs transition-colors"
                  >
                    <Send className="h-3 w-3" />
                    <span>{t('Wyślij do schowka Windows')}</span>
                  </button>
                  <button
                    onClick={async () => {
                      await handleSendCustomTextToRemote(clipboardDraft, true);
                      setTimeout(() => {
                        userInteractionRef.current?.ctrlV();
                      }, 120);
                    }}
                    disabled={!clipboardDraft}
                    className="flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-3 py-1.5 text-white font-medium shadow-xs transition-colors"
                  >
                    <ClipboardPaste className="h-3 w-3" />
                    <span>{t('Wyślij i wklej (Ctrl+V)')}</span>
                  </button>
                </div>

                {/* Remote Clipboard Text Preview */}
                {remoteClipboardText && (
                  <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-slate-800">
                    <span className="font-medium text-slate-400 text-[10px]">
                      {t('Ostatnio skopiowano w sesji Windows (automatycznie w schowku Linux):')}
                    </span>
                    <div className="rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] text-slate-300 max-h-20 overflow-y-auto whitespace-pre-wrap select-all">
                      {remoteClipboardText}
                    </div>
                  </div>
                )}
              </div>

              {/* SECTION 3: Where to find shared folder in Windows */}
              <div className="mt-auto rounded-lg border border-cyan-500/30 bg-cyan-950/25 p-2.5 text-[11px] text-cyan-200 flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 font-semibold text-white">
                  <FolderSync className="h-4 w-4 text-cyan-400" />
                  <span>{t('Gdzie szukać plików w systemie Windows?')}</span>
                </div>
                <ul className="text-[10px] text-cyan-200/90 space-y-1 list-disc pl-4 leading-relaxed">
                  <li>
                    <strong>{t('W zakładce aplikacji (widok wbudowany):')}</strong>{' '}
                    {t('po wybraniu lub upuszczeniu pliku/katalogu użyj Ctrl+V (Wklej) w dowolnym folderze Eksploratora Windows lub na Pulpicie.')}
                  </li>
                  <li>
                    <strong>{t('W oknie zewnętrznym FreeRDP:')}</strong>{' '}
                    {t('folder ~/RemoteFlow_Shared jest widoczny w Eksploratorze plików w sekcji „Ten komputer” (a nie w „Sieć”) jako dysk RemoteFlow lub pod adresem \\\\tsclient\\RemoteFlow.')}
                  </li>
                </ul>
                <div className="flex items-center gap-1.5 mt-1">
                  <button
                    onClick={handleOpenSharedFolder}
                    className="flex-1 flex items-center justify-center gap-1 rounded border border-cyan-500/40 bg-cyan-900/50 hover:bg-cyan-800/60 py-1 text-[10px] font-medium text-cyan-100 transition-colors"
                  >
                    <FolderOpen className="h-3 w-3" />
                    <span>{t('Otwórz ~/RemoteFlow_Shared')}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleSendCustomTextToRemote('\\\\tsclient\\RemoteFlow', true);
                      api.clipboardWriteText('\\\\tsclient\\RemoteFlow');
                    }}
                    className="flex items-center justify-center gap-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[10px] font-mono text-slate-200 transition-colors"
                    title={t('Skopiuj ścieżkę \\\\tsclient\\RemoteFlow do schowka Windows')}
                  >
                    <Copy className="h-2.5 w-2.5" />
                    <span>\\tsclient\RemoteFlow</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isStatsOpen && isConnected && <RdpStatsPanel onClose={() => setIsStatsOpen(false)} />}

        {/* Loading / Connecting Overlay */}
        {isConnecting && (
          <div role="status" className="absolute inset-0 bg-rdp-bg flex flex-col items-center justify-center z-10 p-6 text-center">
            <div className="relative flex items-center justify-center mb-4">
              <div className="h-16 w-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shadow-xl shadow-blue-500/10">
                <Monitor className="h-8 w-8 animate-pulse" />
              </div>
              <Loader2 className="absolute -bottom-1 -right-1 h-6 w-6 text-cyan-400 animate-spin" />
            </div>
            <h3 className="text-base font-semibold text-white tracking-tight">{t('Łączenie z {title}', { title: session.title })}</h3>
            <p className="mt-1 font-mono text-xs text-slate-400">
              {rdpLogin}@{session.host}:{session.port}
            </p>
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-slate-900 border border-slate-800 px-3 py-1 text-[11px] text-cyan-300">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
              <span>{statusMessage}</span>
            </div>
          </div>
        )}

        {/* Error / Disconnected Overlay */}
        {(isError || status === 'disconnected') && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center z-10 p-6 text-center">
            <div className="h-14 w-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shadow-xl shadow-red-500/10 mb-4">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <h3 className="text-base font-bold text-white tracking-tight">
              {isError ? t('Błąd połączenia z sesją RDP') : t('Sesja RDP zakończona')}
            </h3>
            <div className="relative mt-1 max-w-md my-2">
              <p className="select-text cursor-text break-words text-xs text-slate-400 leading-relaxed font-mono bg-slate-900/80 border border-slate-800 p-2.5 pr-8 rounded-lg">
                {statusMessage}
              </p>
              <button
                type="button"
                title={t('Kopiuj treść błędu')}
                onClick={() => {
                  api.clipboardWriteText(statusMessage).catch(() => {});
                  setErrorCopied(true);
                  setTimeout(() => setErrorCopied(false), 1500);
                }}
                className="absolute right-1.5 top-1.5 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
              >
                {errorCopied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
            {isError && explainRdpError(statusMessage) && (
              <div className="max-w-md rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-left text-xs leading-relaxed text-amber-200">
                {explainRdpError(statusMessage)}
                <div className="mt-1.5 text-amber-300/80">
                  {t('Wysłany login:')} <span className="select-text font-mono text-amber-100">{rdpLogin}</span>
                </div>
              </div>
            )}
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => setConnectionAttempts((c) => c + 1)}
                className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 shadow-lg shadow-blue-600/20 transition-all"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{t('Połącz ponownie')}</span>
              </button>
              <button
                onClick={handleLaunchExternal}
                disabled={isLaunchingExternal}
                className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition-all"
              >
                <ExternalLink className="h-3.5 w-3.5 text-purple-400" />
                <span>{t('Otwórz w FreeRDP')}</span>
              </button>
              <button
                onClick={handleDownloadRdp}
                className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{t('Pobierz .rdp')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
