import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { listen } from '@tauri-apps/api/event';
import {
  FolderUp,
  ClipboardPaste,
  Copy,
  Check,
  Upload,
  Eraser,
  Loader2,
  ArrowRightLeft,
  AlertTriangle,
} from 'lucide-react';
import { api, isTauri } from '../../services/api';
import { SessionInfo } from '../../types';
import { getOscCwd, rememberOscCwd } from '../../utils/terminalCwd';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  onTerminalScrollbackChange,
  TERMINAL_LEAVE_ALTERNATE_SCREEN,
  TERMINAL_RESTORE_AFTER_DISCONNECT,
  terminalScrollback,
} from '../../utils/terminalSettings';
import { SftpManager, SftpTransferInfo } from './SftpManager';
import { formatBytes } from '../../utils/formatBytes';
import { tn, useT } from '../../i18n';
import { useLightTerminal } from '../../theme';
import { useMenuPosition } from '../../utils/useMenuPosition';
import { TunnelsMenu } from './TunnelsMenu';

// Full 16-colour palettes. The dark one is the original RemoteFlow terminal; the light one is used
// with the light application theme (unless "keep the terminal dark" is set in Settings).
const TERMINAL_DARK = {
  background: '#090d16',
  foreground: '#d4d8e0',
  cursor: '#38bdf8',
  cursorAccent: '#090d16',
  selectionBackground: '#33415580',
  black: '#151b26',
  red: '#c94444',
  green: '#4c9f53',
  yellow: '#c6a02b',
  blue: '#2f5ea8',
  magenta: '#9b55c2',
  cyan: '#2f97ad',
  white: '#c5cad3',
  brightBlack: '#5f6878',
  brightRed: '#ef6b6b',
  brightGreen: '#72d27a',
  brightYellow: '#f0d566',
  brightBlue: '#6593e3',
  brightMagenta: '#c48ae3',
  brightCyan: '#62cfe4',
  brightWhite: '#f3f5f9',
};
const TERMINAL_LIGHT = {
  background: '#fbfcfd',
  foreground: '#1f2937',
  cursor: '#0891b2',
  cursorAccent: '#fbfcfd',
  selectionBackground: '#94a3b866',
  black: '#1f2430',
  red: '#c0362c',
  green: '#2f8a3a',
  yellow: '#986f0b',
  blue: '#2f5ea8',
  magenta: '#9b3fb5',
  cyan: '#1d8aa0',
  white: '#b8bec9',
  brightBlack: '#6b7280',
  brightRed: '#e05555',
  brightGreen: '#3c9e4a',
  brightYellow: '#b8920f',
  brightBlue: '#4677d0',
  brightMagenta: '#b45ccc',
  brightCyan: '#2aa3b8',
  brightWhite: '#e5e7eb',
};

interface Props {
  session: SessionInfo;
  isActive: boolean;
  /** True when the workspace is split into several panes: the SFTP manager then fills the whole pane. */
  splitLayout?: boolean;
}

export const SshTerminal: React.FC<Props> = ({ session, isActive, splitLayout = false }) => {
  const t = useT();
  const lightTerminal = useLightTerminal();
  const lightTerminalRef = useRef(lightTerminal);
  lightTerminalRef.current = lightTerminal;
  const containerRef = useRef<HTMLDivElement>(null);
  // xterm is mounted in a padding-free inner element: FitAddon measures the parent's CSS height
  // (border-box with Tailwind) but only subtracts the terminal's own padding, so a padded parent
  // made the terminal ~16 px taller/wider than the visible area (last line cut off).
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const [isSftpOpen, setIsSftpOpen] = useState(false);
  // Transfer of the SFTP window – it continues in the background when the window is closed
  const [sftpTransfer, setSftpTransfer] = useState<SftpTransferInfo | null>(null);
  // Result of a transfer that ended while the window was closed – shown on the button until the
  // window is opened (or for a while), so a finished background copy is not missed
  const [sftpResult, setSftpResult] = useState<{ text: string; ok: boolean } | null>(null);
  const isSftpOpenRef = useRef(isSftpOpen);
  isSftpOpenRef.current = isSftpOpen;
  const onSftpTransferDone = useCallback((text: string, ok: boolean) => {
    if (!isSftpOpenRef.current) setSftpResult({ text, ok });
  }, []);
  useEffect(() => {
    if (isSftpOpen) setSftpResult(null);
  }, [isSftpOpen]);
  useEffect(() => {
    if (!sftpResult) return;
    const id = setTimeout(() => setSftpResult(null), sftpResult.ok ? 30000 : 120000);
    return () => clearTimeout(id);
  }, [sftpResult]);
  const [isTunnelsOpen, setIsTunnelsOpen] = useState(false);
  const tunnelsButtonRef = useRef<HTMLButtonElement>(null);
  const closeTunnels = useCallback(() => {
    setIsTunnelsOpen(false);
    termRef.current?.focus();
  }, []);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useMenuPosition(menuRef, contextMenu);

  const showNotification = useCallback((msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2500);
  }, []);

  const triggerFitAndResize = useCallback(() => {
    if (!fitAddonRef.current || !termRef.current || !containerRef.current) return;
    const { offsetWidth, offsetHeight } = containerRef.current;
    if (offsetWidth === 0 || offsetHeight === 0) return;
    try {
      const term = termRef.current;
      fitAddonRef.current.fit();

      // With fractional display scaling (e.g. 2K monitor at 125%/150% on Windows) the rows are
      // rounded to whole device pixels and the real terminal height can exceed the space computed
      // by FitAddon by a few pixels – the last line was cut off. Shrink until it really fits.
      const host = termHostRef.current ?? containerRef.current;
      const style = window.getComputedStyle(host);
      const availH = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const availW = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
      for (let i = 0; screen && i < 3; i++) {
        const rect = screen.getBoundingClientRect();
        const tooTall = rect.height > availH + 0.5 && term.rows > 2;
        const tooWide = rect.width > availW + 0.5 && term.cols > 10;
        if (!tooTall && !tooWide) break;
        term.resize(tooWide ? term.cols - 1 : term.cols, tooTall ? term.rows - 1 : term.rows);
      }

      const cols = term.cols;
      const rows = term.rows;
      if (cols > 0 && rows > 0) {
        api.resizeSession(session.sessionId, cols, rows);
      }
    } catch {
      // Ignore fit error when container is hidden
    }
  }, [session.sessionId]);

  // Files and folders dropped on the terminal or pasted into it are uploaded by the SFTP window's
  // transfer (progress, Stop, indicator on the Files button – also with the window closed), to
  // the current directory of the shell (home folder when it cannot be read). Everything is sent:
  // also .git, node_modules, target… (the old upload skipped them silently).
  const [sftpUploadRequest, setSftpUploadRequest] = useState<{ id: number; paths: string[]; targetDir: string } | null>(null);
  const uploadToServer = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      let targetDir = '';
      try {
        const cwd = await Promise.race([
          api.terminalCwd(session.sessionId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        targetDir = cwd.path;
      } catch {
        targetDir = getOscCwd(session.sessionId) || '';
      }
      showNotification(
        tn(paths.length, ['Wysyłanie {n} elementu do {dir}', 'Wysyłanie {n} elementów do {dir}', 'Wysyłanie {n} elementów do {dir}'], {
          n: paths.length,
          dir: targetDir || t('katalogu domowego'),
        })
      );
      setSftpUploadRequest({ id: Date.now(), paths, targetDir });
    },
    [session.sessionId, showNotification]
  );

  // Paste text or files/folders into active terminal session
  const pasteInProgressRef = useRef(false);
  const handlePasteClipboard = useCallback(async () => {
    // Guard against overlapping pastes (e.g. shortcut + toolbar button in quick succession)
    if (pasteInProgressRef.current) return;
    pasteInProgressRef.current = true;
    try {
      // Check if files/directories were copied in the OS file manager
      const clipFiles = await api.clipboardReadFiles();
      if (clipFiles.length > 0) {
        await uploadToServer(clipFiles);
        return;
      }

      const text = await api.clipboardReadText();
      if (text) {
        const term = termRef.current;
        if (term) {
          // xterm's paste() turns CRLF / LF into CR (what a terminal sends for Enter) and wraps the
          // text in bracketed-paste markers when the remote program (vim, nano, bash) asked for
          // them. Sending raw Windows CRLF text produced an extra empty line after every line.
          term.paste(text);
        } else {
          api.sendInput(session.sessionId, text.replace(/\r\n?|\n/g, '\r'));
        }
        showNotification(t('Wklejono tekst ze schowka'));
      }
    } catch (err) {
      console.warn('Błąd odczytu schowka:', err);
    } finally {
      pasteInProgressRef.current = false;
    }
  }, [session.sessionId, showNotification, uploadToServer]);

  // Copy selected text to clipboard
  const handleCopySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      try {
        await api.clipboardWriteText(selection);
        showNotification(t('Skopiowano zaznaczenie do schowka'));
      } catch (err) {
        console.warn('Błąd zapisu do schowka:', err);
      }
    }
  }, [showNotification]);

  const handlePasteClipboardRef = useRef(handlePasteClipboard);
  handlePasteClipboardRef.current = handlePasteClipboard;

  const showNotificationRef = useRef(showNotification);
  showNotificationRef.current = showNotification;

  // Refit whenever the terminal area changes size (split panes, side panels, tab switch) and once
  // the web fonts are ready – cell metrics can change after the first fit, especially on Windows.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => triggerFitAndResize());
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    document.fonts?.ready.then(schedule).catch(() => {});
    // Display scaling change (e.g. window moved to another monitor)
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener?.('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mq.removeEventListener?.('change', schedule);
    };
  }, [triggerFitAndResize]);

  // Switch the terminal colours when the theme changes (no reconnect needed)
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = lightTerminal ? TERMINAL_LIGHT : TERMINAL_DARK;
  }, [lightTerminal]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      // History available with the mouse wheel / scroll bar (Settings → SSH terminal)
      scrollback: terminalScrollback(),
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      // Full 16-colour palette. Previously only the 8 base colours were set (and very light ones,
      // e.g. sky-blue as "blue"), while the bright variants fell back to xterm.js defaults – full-
      // screen apps such as Midnight Commander (blue panels, bright text) looked garish.
      theme: lightTerminalRef.current ? TERMINAL_LIGHT : TERMINAL_DARK,
    });

    // OSC 7: the shell reports its directory (used by SFTP "directory from the terminal")
    term.parser.registerOscHandler(7, (data) => {
      rememberOscCwd(session.sessionId, data);
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termHostRef.current ?? containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Advanced Keyboard Handling for Clipboard:
    // Ctrl+C with active selection -> Copy to clipboard (instead of SIGINT)
    // Ctrl+V or Ctrl+Shift+V -> Paste from clipboard (text or copied files/folders)
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;

      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Copy: Ctrl+C or Ctrl+Shift+C when text is selected
      if (isCtrlOrMeta && key === 'c' && (term.hasSelection() || e.shiftKey)) {
        const text = term.getSelection();
        if (text) {
          api.clipboardWriteText(text).then(() => {
            showNotificationRef.current(t('Skopiowano zaznaczenie'));
          });
        }
        return false; // Prevent sending ^C SIGINT to shell
      }

      // Paste: Ctrl+V or Ctrl+Shift+V
      if (isCtrlOrMeta && key === 'v') {
        // Returning false only stops xterm's own key handling. Without preventDefault() the
        // webview (WebKitGTK on Linux) still fires a native "paste" event on xterm's textarea,
        // which xterm forwards via onData – the text was pasted twice.
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          handlePasteClipboardRef.current();
        }
        return false;
      }

      return true;
    });

    setTimeout(() => {
      triggerFitAndResize();
    }, 100);

    let unlisten: (() => void) | undefined;
    let mockInputBuffer = '';
    const prompt = `${session.username}@${session.host}:~$ `;

    if (isTauri()) {
      // Real Tauri SSH live stream
      listen<string>(`ssh-data-${session.sessionId}`, (event) => {
        term.write(event.payload);
      }).then((unsub) => {
        unlisten = unsub;
      });

      // Send input from xterm to Tauri backend PTY
      const onDataDisposable = term.onData((data) => {
        api.sendInput(session.sessionId, data);
      });

      const handleResize = () => {
        triggerFitAndResize();
      };
      window.addEventListener('resize', handleResize);

      // Event listener for screen unlock & focus restoration
      const handleFocusEvent = () => {
        triggerFitAndResize();
        term.focus();
      };
      window.addEventListener('remoteflow-focus-terminal', handleFocusEvent);
      window.addEventListener('focus', handleFocusEvent);

      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('remoteflow-focus-terminal', handleFocusEvent);
        window.removeEventListener('focus', handleFocusEvent);
        onDataDisposable.dispose();
        if (unlisten) unlisten();
        term.dispose();
      };
    } else {
      // Interactive Web Mock Shell (when testing outside Tauri runtime)
      term.writeln('\x1b[1;36m=== RemoteFlow SSH Terminal (Web Mock Preview) ===\x1b[0m');
      term.writeln(`\x1b[32m✔ Połączono:\x1b[0m ${session.username}@${session.host}:${session.port}`);
      if (session.activePortForwards.length > 0) {
        term.writeln(`\x1b[33m⚡ ${t('Aktywne tunele portów: {list}', { list: session.activePortForwards.join(', ') })}\x1b[0m`);
      }
      term.writeln('\x1b[90mTyp sesji: xterm-256color | Obsługa schowka: Aktywna | Przeciągnij pliki: SFTP\x1b[0m\r\n');
      term.write(prompt);

      const onDataDisposable = term.onData((data) => {
        if (data === '\r') {
          term.writeln('');
          const cmd = mockInputBuffer.trim();
          mockInputBuffer = '';

          if (cmd === 'clear') {
            term.clear();
          } else if (cmd === 'ls' || cmd === 'ls -la' || cmd === 'ls -l') {
            term.writeln('total 48');
            term.writeln('drwxr-xr-x 5 ' + session.username + ' ' + session.username + ' 4096 Oct 17 09:00 .');
            term.writeln('drwxr-xr-x 3 root root 4096 Oct 10 12:00 ..');
            term.writeln('-rw------- 1 ' + session.username + ' ' + session.username + ' 1250 Oct 17 09:02 .bash_history');
            term.writeln('drwxr-xr-x 4 ' + session.username + ' ' + session.username + ' 4096 Oct 17 08:30 app');
            term.writeln('-rw-r--r-- 1 ' + session.username + ' ' + session.username + '  807 Oct 10 12:00 .profile');
          } else if (cmd === 'pwd') {
            term.writeln(`/home/${session.username}`);
          } else if (cmd === 'whoami') {
            term.writeln(session.username);
          } else if (cmd === 'date') {
            term.writeln(new Date().toUTCString());
          } else if (cmd === 'exit') {
            term.writeln('logout');
            term.writeln('\x1b[33m[Sesja zakończona]\x1b[0m');
            return;
          } else if (cmd) {
            term.writeln(`bash: ${cmd}: polecenie wykonane w symulacji`);
          }

          term.write(prompt);
        } else if (data === '\u007f' || data === '\b') {
          if (mockInputBuffer.length > 0) {
            mockInputBuffer = mockInputBuffer.slice(0, -1);
            term.write('\b \b');
          }
        } else if (data === '\u0003') {
          term.writeln('^C');
          mockInputBuffer = '';
          term.write(prompt);
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          mockInputBuffer += data;
          term.write(data);
        }
      });

      const handleResize = () => {
        triggerFitAndResize();
      };
      window.addEventListener('resize', handleResize);

      const handleFocusEvent = () => {
        triggerFitAndResize();
        term.focus();
      };
      window.addEventListener('remoteflow-focus-terminal', handleFocusEvent);
      window.addEventListener('focus', handleFocusEvent);

      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('remoteflow-focus-terminal', handleFocusEvent);
        window.removeEventListener('focus', handleFocusEvent);
        onDataDisposable.dispose();
        term.dispose();
      };
    }
  }, [session.sessionId, triggerFitAndResize]);

  // Scrollback size changed in the settings – applied to the open terminal
  useEffect(() => {
    return onTerminalScrollbackChange((lines) => {
      const term = termRef.current;
      if (term) term.options.scrollback = lines;
    });
  }, []);

  // After the connection ends the history must stay scrollable. A full-screen program that was
  // running (mc, vim, less, htop, tmux…) leaves the terminal in the alternate screen, which has no
  // history, and often with mouse reporting on – the wheel then went to the dead session instead
  // of scrolling. Return the terminal to the normal screen with the earlier output.
  const prevStatusRef = useRef(session.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = session.status;
    const ended = session.status === 'disconnected' || session.status === 'error';
    const wasEnded = prev === 'disconnected' || prev === 'error';
    const term = termRef.current;
    if (!term || !ended || wasEnded) return;
    const inAlternate = term.buffer.active.type === 'alternate';
    term.write((inAlternate ? TERMINAL_LEAVE_ALTERNATE_SCREEN : '') + TERMINAL_RESTORE_AFTER_DISCONNECT);
    if (inAlternate) {
      const reason = session.statusMessage ? ` ${session.statusMessage}` : '';
      term.write(
        `\r\n\x1b[33m[${t('Połączenie zakończone – zamknięto ekran programu pełnoekranowego, wcześniejszą historię można przewijać.')}${reason}]\x1b[0m\r\n`
      );
    }
    term.scrollToBottom();
  }, [session.status, session.statusMessage, t]);

  // Middle mouse button: paste the text selected in this terminal (X11 "primary selection" style).
  // The selection does not need to be copied first; the last selection is remembered even after
  // it is cleared. When a full-screen app has enabled mouse reporting (mc, vim, htop...), the
  // middle click goes to that app – hold Shift to paste instead (like other terminals).
  useEffect(() => {
    const term = termRef.current;
    const host = termHostRef.current ?? containerRef.current;
    if (!term || !host) return;

    let lastSelection = '';
    let suppressNativePasteUntil = 0;
    const selectionDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) lastSelection = sel;
    });

    const appWantsMouse = (e: MouseEvent) => term.modes.mouseTrackingMode !== 'none' && !e.shiftKey;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1 || appWantsMouse(e)) return;
      // Block the browser's own middle-click actions: Linux PRIMARY paste (would paste twice)
      // and the Windows auto-scroll cursor.
      e.preventDefault();
      e.stopPropagation();
      suppressNativePasteUntil = Date.now() + 600;
      const text = term.getSelection() || lastSelection;
      if (text) {
        term.paste(text); // handles bracketed-paste mode and line endings, sends via onData
        term.focus();
      }
    };
    const swallowMiddle = (e: MouseEvent) => {
      if (e.button !== 1 || appWantsMouse(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onNativePaste = (e: ClipboardEvent) => {
      if (Date.now() < suppressNativePasteUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    host.addEventListener('mousedown', onMouseDown, true);
    host.addEventListener('mouseup', swallowMiddle, true);
    host.addEventListener('auxclick', swallowMiddle, true);
    host.addEventListener('paste', onNativePaste, true);
    return () => {
      selectionDisposable.dispose();
      host.removeEventListener('mousedown', onMouseDown, true);
      host.removeEventListener('mouseup', swallowMiddle, true);
      host.removeEventListener('auxclick', swallowMiddle, true);
      host.removeEventListener('paste', onNativePaste, true);
    };
  }, [session.sessionId]);

  // When tab becomes active, re-fit terminal, refresh buffer lines and restore focus
  useEffect(() => {
    if (isActive && termRef.current) {
      const timer = setTimeout(() => {
        triggerFitAndResize();
        try {
          termRef.current?.refresh(0, termRef.current.rows - 1);
        } catch {
          // ignore
        }
        termRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, triggerFitAndResize]);

  /** Closes the context menu and gives the keyboard focus back to the terminal. */
  const closeMenu = useCallback(() => {
    setContextMenu(null);
    requestAnimationFrame(() => termRef.current?.focus());
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, []);

  // Drag and Drop handling for file transfers into the SSH terminal
  // Files dropped from the system file manager: the window receives them natively (Tauri) –
  // HTML drop events never carry them there, so dropping on the terminal did nothing before.
  useEffect(() => {
    if (!isTauri()) return;
    const inTerminal = (pos: { x: number; y: number }) => {
      const area = containerRef.current;
      if (!area) return false;
      const el = document.elementFromPoint(pos.x / window.devicePixelRatio, pos.y / window.devicePixelRatio);
      return !!el && area.contains(el); // not when the SFTP window or a dialog covers the point
    };
    let un: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter' || p.type === 'over') setIsDragOver(inTerminal(p.position));
        else if (p.type === 'leave') setIsDragOver(false);
        else if (p.type === 'drop') {
          setIsDragOver(false);
          if (inTerminal(p.position) && p.paths.length > 0) void uploadToServer(p.paths);
        }
      })
      .then((fn) => (cancelled ? fn() : (un = fn)))
      .catch(() => {});
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, [uploadToServer]);

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

    // Files from the system file manager arrive as a native drop (below); here only text.
    // (Kept for a uri-list from apps that send paths as text.)
    const uriList = e.dataTransfer.getData('text/uri-list');
    const uriPaths = uriList
      ? uriList
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('file://'))
          .map((l) => decodeURIComponent(l.replace(/^file:\/\/[^/]*/, '')))
      : [];
    if (uriPaths.length > 0) {
      await uploadToServer(uriPaths);
      return;
    }

    // Plain text dropped -> pasted like Ctrl+V: xterm turns line breaks into Enter
    //    and wraps the text in bracketed-paste markers when the shell asked for them, so a dropped
    //    multi-line text is not executed line by line right away.
    const text = e.dataTransfer.getData('text/plain');
    if (text) {
      const term = termRef.current;
      if (term) term.paste(text);
      else api.sendInput(session.sessionId, text.replace(/\r\n?|\n/g, '\r'));
      showNotification(t('Wklejono tekst ze schowka'));
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      className={`relative h-full w-full select-none ${isActive ? 'block' : 'hidden'}`}
      style={{ backgroundColor: (lightTerminal ? TERMINAL_LIGHT : TERMINAL_DARK).background }}
    >
      {/* Top Floating Action Toolbar – drawn over the terminal, so it uses the terminal's colours
          (dark palette when the terminal stays dark in the light theme) */}
      <div className={`absolute top-2 right-3 flex items-center gap-1.5 z-20 ${lightTerminal ? '' : 'rf-dark'}`}>
        {/* Real-time Feedback Toast */}
        {feedback && (
          <div className="flex items-center gap-1 rounded-full bg-cyan-950/90 border border-cyan-500/50 px-2.5 py-0.5 text-[11px] text-cyan-300 shadow-md animate-fadeIn">
            <Check className="h-3 w-3 text-cyan-400 shrink-0" />
            <span>{feedback}</span>
          </div>
        )}

        {/* Active Port Forwards Badge */}
        {session.activePortForwards && session.activePortForwards.length > 0 && (
          <button
            ref={tunnelsButtonRef}
            onClick={() => setIsTunnelsOpen((v) => !v)}
            aria-expanded={isTunnelsOpen}
            aria-haspopup="dialog"
            title={isTunnelsOpen ? undefined : t('Pokaż tunele SSH tego połączenia')}
            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-950/70 px-2 py-1 text-[11px] font-mono text-emerald-300 shadow-sm transition-colors hover:border-emerald-400 hover:bg-emerald-900/70 hover:text-emerald-200"
          >
            <ArrowRightLeft className="h-3 w-3 text-emerald-400 shrink-0" />
            <span>{t('Tunele ({n})', { n: session.activePortForwards.length })}</span>
          </button>
        )}

        {/* Toggle SFTP File Explorer Drawer */}
        <button
          onClick={() => setIsSftpOpen((v) => !v)}
          title={
            sftpTransfer
              ? [
                  sftpTransfer.cancelling ? t('Przerywanie… ') + sftpTransfer.label : sftpTransfer.label,
                  sftpTransfer.current ? t('Teraz: {current}', { current: sftpTransfer.current }) : '',
                  t('Przesłano: {size}, gotowych plików: {files}', {
                    size: formatBytes(sftpTransfer.bytes),
                    files: sftpTransfer.files,
                  }),
                  isSftpOpen ? '' : t('Kliknij, aby zobaczyć postęp lub przerwać.'),
                ]
                  .filter(Boolean)
                  .join('\n')
              : sftpResult
                ? sftpResult.text
                : t('Menedżer transferu plików i katalogów (SFTP)')
          }
          className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors shadow-sm ${
            sftpTransfer && !isSftpOpen
              ? 'border-amber-400 bg-amber-950/80 text-amber-100 shadow-amber-950/50 hover:bg-amber-900/80'
              : sftpResult
                ? sftpResult.ok
                  ? 'border-emerald-500 bg-emerald-950/80 text-emerald-100 hover:bg-emerald-900/80'
                  : 'border-red-500 bg-red-950/80 text-red-100 hover:bg-red-900/80'
                : isSftpOpen
                ? 'border-cyan-500 bg-cyan-950/80 text-cyan-200 shadow-cyan-950/50'
                : 'border-slate-700/80 bg-slate-900/90 text-slate-200 hover:bg-slate-700 hover:text-white'
          }`}
        >
          {sftpTransfer ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
          ) : sftpResult ? (
            sftpResult.ok ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
            )
          ) : (
            <FolderUp className="h-3.5 w-3.5 text-amber-400" />
          )}
          <span>{t('Pliki (SFTP)')}</span>
          {sftpTransfer && (
            <span className="font-mono text-[10px] text-amber-200/90">
              {sftpTransfer.bytes > 0 ? formatBytes(sftpTransfer.bytes) : t('trwa…')}
            </span>
          )}
        </button>
      </div>

      {/* Terminal Mount Point */}
      <div
        ref={containerRef}
        onMouseDown={() => termRef.current?.focus()}
        onClick={() => termRef.current?.focus()}
        className="h-full w-full p-2 cursor-text"
      >
        <div ref={termHostRef} className="h-full w-full overflow-hidden" />
      </div>

      {/* Drag & Drop Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-cyan-950/85 border-2 border-dashed border-cyan-400 backdrop-blur-xs flex flex-col items-center justify-center z-30 pointer-events-none p-6 text-center animate-fadeIn">
          <Upload className="h-12 w-12 text-cyan-400 mb-3 animate-bounce" />
          <h3 className="text-base font-bold text-white">{t('Upuść pliki lub katalogi tutaj')}</h3>
          <p className="text-xs text-cyan-200/90 mt-1 max-w-sm">
            {t('Zostaną przesłane przez SFTP do bieżącego katalogu terminala na serwerze')}{' '}
            <span className="font-mono font-semibold">{session.host}</span>.
          </p>
        </div>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          // Keep the keyboard focus in the terminal while a menu item is clicked
          onMouseDown={(e) => e.preventDefault()}
          style={menuStyle}
          className="fixed z-50 w-48 rounded-lg border border-slate-700 bg-slate-900/95 py-1 text-xs text-slate-200 shadow-xl backdrop-blur-md font-sans"
        >
          <button
            onClick={() => {
              handleCopySelection();
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-left transition-colors"
          >
            <Copy className="h-3.5 w-3.5 text-slate-400" />
            <span>{t('Kopiuj zaznaczenie')}</span>
          </button>
          <button
            onClick={() => {
              closeMenu();
              handlePasteClipboard().finally(() => termRef.current?.focus());
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-left transition-colors"
          >
            <ClipboardPaste className="h-3.5 w-3.5 text-cyan-400" />
            <span>{t('Wklej ze schowka')}</span>
          </button>
          <div className="my-1 border-t border-slate-800" />
          <button
            onClick={() => {
              setIsSftpOpen(true);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-left transition-colors"
          >
            <FolderUp className="h-3.5 w-3.5 text-amber-400" />
            <span>{t('Menedżer plików (SFTP)')}</span>
          </button>
          <button
            onClick={() => {
              termRef.current?.clear();
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-slate-800 text-left transition-colors"
          >
            <Eraser className="h-3.5 w-3.5 text-slate-400" />
            <span>{t('Wyczyść ekran')}</span>
          </button>
        </div>
      )}

      {/* Two-pane SFTP manager (local | server) */}
      <SftpManager
        isOpen={isSftpOpen}
        onClose={() => {
          setIsSftpOpen(false);
          termRef.current?.focus();
        }}
        connectionId={session.connectionId}
        connectionTitle={session.title}
        terminalSessionId={session.sessionId}
        onNotify={showNotification}
        fullWidth={splitLayout}
        onTransferChange={setSftpTransfer}
        onTransferDone={onSftpTransferDone}
        uploadRequest={sftpUploadRequest}
      />

      {isTunnelsOpen && (
        <TunnelsMenu
          sessionId={session.sessionId}
          fallback={session.activePortForwards}
          trigger={tunnelsButtonRef}
          onClose={closeTunnels}
        />
      )}
    </div>
  );
};
