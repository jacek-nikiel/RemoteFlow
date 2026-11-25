/**
 * Keyboard of the RDP viewer: key combinations and typed text sent to Windows (key menu), F5
 * (button and the F5 key – the app itself must not reload), Ctrl+R blocked, and the NumLock
 * synchronisation before keypad keys. Moved out of RdpViewer.tsx as is.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import type { UserInteraction } from '@devolutions/iron-remote-desktop';
import { Backend } from '@devolutions/iron-remote-desktop-rdp';
import { useT } from '../../../i18n';
import { numLockFromEvent, trackNumLock } from '../../../utils/rdpLockKeys';

interface Params {
  isActive: boolean;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  showToast: (msg: string, duration?: number) => void;
  focusRdpCanvas: () => void;
  rdpWasmSessionRef: React.MutableRefObject<any>;
  userInteractionRef: React.MutableRefObject<UserInteraction | null>;
}

export function useRdpKeyboard({ isActive, status, showToast, focusRdpCanvas, rdpWasmSessionRef, userInteractionRef }: Params) {
  const t = useT();
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

  return { sendKeyCombination, sendTextSequence, sendF5ToRemote };
}
