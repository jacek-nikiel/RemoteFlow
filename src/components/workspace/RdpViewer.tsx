import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FileUp } from 'lucide-react';
import '@devolutions/iron-remote-desktop';
import { ConfigBuilder, UserInteraction } from '@devolutions/iron-remote-desktop';
import {
  Backend,
  enableCredssp,
  displayControl,
  RdpFileTransferProvider,
} from '@devolutions/iron-remote-desktop-rdp';
import { SessionInfo } from '../../types';
import { api, isTauri, isWindowsHost } from '../../services/api';
import { listen } from '@tauri-apps/api/event';
import { useT } from '../../i18n';
import { rdpPixelRatio, rdpScaleFactor, screenScale } from '../../utils/rdpDisplay';
import { RdpStatsPanel } from './RdpStatsPanel';
import { ensureRdpInitialized, hostPort } from './rdp/engine';
import { FilesClipboardDrawer } from './rdp/FilesClipboardDrawer';
import { RdpSessionStatus, RdpToolbarActions } from './rdp/RdpToolbar';
import { RdpConnectingOverlay, RdpErrorOverlay } from './rdp/RdpOverlays';
import { useRdpClipboard } from './rdp/useRdpClipboard';
import { useRdpKeyboard } from './rdp/useRdpKeyboard';
import {
  applyCanvasStyle,
  applyShadowRootScalingOverrides,
  getDimensionsForPreset,
  RemoteSize,
  noteRequestedSize,
  remoteDesktopSize,
  sendRemoteSize,
  autoSizeFromArea,
} from './rdp/layout';



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
  const lastAppliedResRef = useRef<RemoteSize | null>(null);
  // Last error reported by the local Rust RDP proxy (more precise than the WASM client's error)
  const lastProxyErrorRef = useRef<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');
  const [statusMessage, setStatusMessage] = useState<string>(t('Nawiązywanie połączenia RDP...'));
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

  const [isStatsOpen, setIsStatsOpen] = useState(false);

  // Unified Clipboard & File Transfer Drawer
  const [isClipboardDrawerOpen, setIsClipboardDrawerOpen] = useState(false);
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

  const {
    lastSyncedTextRef,
    hasStagedUploadRef,
    stagedDroppedFilesRef,
    clipboardAllowed,
    clipboardAllowedRef,
    clipboardDraft,
    setClipboardDraft,
    remoteClipboardText,
    setRemoteClipboardText,
    isDragOver,
    isSavingFiles,
    stagedUploadNames,
    setStagedUploadNames,
    uploadProgressText,
    setUploadProgressText,
    remoteAvailableFiles,
    setRemoteAvailableFiles,
    isDownloadingRemoteFiles,
    isLocalBrowserOpen,
    setIsLocalBrowserOpen,
    localPathRef,
    handleSendCustomTextToRemote,
    handleClearClipboard,
    stageDroppedFilesToRdpClipboard,
    stageLocalPathsToRdpClipboard,
    handleDownloadRemoteFiles,
    handleOpenSharedFolder,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    syncLocalClipboardToRemote,
    markOwnLocalClipboardWriteRef,
    stageRemoteFilesToLocalClipboardRef,
  } = useRdpClipboard({ session, showToast, focusRdpCanvas, rdpWasmSessionRef, fileTransferProviderRef });

  // Resolution always starts in "Auto" mode (fit to the tab); a fixed preset can still be chosen manually.
  const [selectedResolution, setSelectedResolution] = useState<string>('auto');

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
          noteRequestedSize(targetDimensions);

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


  const { sendKeyCombination, sendTextSequence, sendF5ToRemote } = useRdpKeyboard({
    isActive,
    status,
    showToast,
    focusRdpCanvas,
    rdpWasmSessionRef,
    userInteractionRef,
  });

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

    api
      .saveFileAs(`${session.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.rdp`, rdpContent, t('Plik połączenia pulpitu zdalnego'), 'rdp')
      .then((path) => {
        if (path) showToast(t('Zapisano plik .rdp: {path}', { path }), 4000);
      })
      .catch((err: any) => showToast(t('Nie udało się zapisać pliku .rdp: {p0}', { p0: err?.message || err }), 5000));
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
        <RdpSessionStatus
          session={session}
          isConnected={isConnected}
          isConnecting={isConnecting}
          isError={isError}
          stagedUploadNames={stagedUploadNames}
          onPasteStaged={() => {
            focusRdpCanvas();
            userInteractionRef.current?.ctrlV();
          }}
          onCancelStaged={() => {
            hasStagedUploadRef.current = false;
            stagedDroppedFilesRef.current = [];
            setStagedUploadNames([]);
          }}
          remoteAvailableFiles={remoteAvailableFiles}
          setRemoteAvailableFiles={setRemoteAvailableFiles}
          isDownloadingRemoteFiles={isDownloadingRemoteFiles}
          handleDownloadRemoteFiles={handleDownloadRemoteFiles}
          clipboardFeedback={clipboardFeedback}
          uploadProgressText={uploadProgressText}
          isSavingFiles={isSavingFiles}
        />

        {/* Quick Toolbar Actions */}
        <RdpToolbarActions
          isConnected={isConnected}
          selectedResolution={selectedResolution}
          applyResolution={applyResolution}
          isStatsOpen={isStatsOpen}
          onToggleStats={() => setIsStatsOpen((v) => !v)}
          scaleMode={scaleMode}
          handleSetScale={handleSetScale}
          isClipboardDrawerOpen={isClipboardDrawerOpen}
          onToggleDrawer={() => setIsClipboardDrawerOpen((v) => !v)}
          clipboardAllowed={clipboardAllowed}
          fileBadge={remoteAvailableFiles.length || stagedUploadNames.length}
          sendKeyCombination={sendKeyCombination}
          sendTextSequence={sendTextSequence}
          sendF5ToRemote={sendF5ToRemote}
          showToast={showToast}
          handleCopyPassword={handleCopyPassword}
          copiedPassword={copiedPassword}
          isFullscreen={isFullscreen}
          handleToggleFullscreen={handleToggleFullscreen}
          onReconnect={() => setConnectionAttempts((c) => c + 1)}
        />
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
          <FilesClipboardDrawer
            onClose={() => {
              setIsClipboardDrawerOpen(false);
              focusRdpCanvas();
            }}
            handleClearClipboard={handleClearClipboard}
            isConnected={isConnected}
            isSavingFiles={isSavingFiles}
            stageDroppedFilesToRdpClipboard={stageDroppedFilesToRdpClipboard}
            stageLocalPathsToRdpClipboard={stageLocalPathsToRdpClipboard}
            isLocalBrowserOpen={isLocalBrowserOpen}
            setIsLocalBrowserOpen={setIsLocalBrowserOpen}
            localPathRef={localPathRef}
            remoteAvailableFiles={remoteAvailableFiles}
            setRemoteAvailableFiles={setRemoteAvailableFiles}
            handleDownloadRemoteFiles={handleDownloadRemoteFiles}
            isDownloadingRemoteFiles={isDownloadingRemoteFiles}
            clipboardDraft={clipboardDraft}
            setClipboardDraft={setClipboardDraft}
            handleSendCustomTextToRemote={handleSendCustomTextToRemote}
            pasteToRemote={() => userInteractionRef.current?.ctrlV()}
            remoteClipboardText={remoteClipboardText}
            handleOpenSharedFolder={handleOpenSharedFolder}
            showToast={showToast}
          />
        )}

        {isStatsOpen && isConnected && <RdpStatsPanel onClose={() => setIsStatsOpen(false)} />}

        {/* Loading / Connecting Overlay */}
        {isConnecting && <RdpConnectingOverlay session={session} rdpLogin={rdpLogin} statusMessage={statusMessage} />}

        {/* Error / Disconnected Overlay */}
        {(isError || status === 'disconnected') && (
          <RdpErrorOverlay
            isError={isError}
            statusMessage={statusMessage}
            rdpLogin={rdpLogin}
            onReconnect={() => setConnectionAttempts((c) => c + 1)}
            handleLaunchExternal={handleLaunchExternal}
            isLaunchingExternal={isLaunchingExternal}
            handleDownloadRdp={handleDownloadRdp}
          />
        )}
      </div>
    </div>
  );
};
