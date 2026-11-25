/**
 * Application updates from GitHub Releases (tauri-plugin-updater).
 *
 * The release workflow (.github/workflows/release.yml) publishes the installers together with
 * `latest.json` and a signature of every package. The application downloads only a package
 * signed with the private key whose public half is in tauri.conf.json (plugins.updater.pubkey).
 *
 * Automatic checks run at start-up and once a day (can be switched off in Settings); the
 * preference is stored per computer in localStorage.
 */
import { isTauri } from '../services/api';

/** Release page – portable copies download the new version from here. */
export const RELEASES_URL = 'https://github.com/jacek-nikiel/RemoteFlow/releases/latest';

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
  /**
   * The update can be installed from the notice. False for a portable copy when the release has no
   * portable build for this system, and for a pacman package (Arch Linux) – then the notice links
   * to the releases page.
   */
  canSelfUpdate: boolean;
  /** Portable copy: the program file itself is replaced (no installer). */
  portable: boolean;
  /** Installed from a pacman package (.pkg.tar.zst / AUR): updated with pacman, not by the program. */
  pacman: boolean;
  /** Downloads, verifies and installs; `onProgress(downloaded, total)` while downloading. */
  install: (onProgress: (downloaded: number, total: number | null) => void) => Promise<void>;
}

const AUTO_KEY = 'remoteflow.updates.autoCheck';
const SKIP_KEY = 'remoteflow.updates.skipVersion';
export const UPDATE_EVENT = 'remoteflow-update-available';

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setAutoCheckEnabled(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'true' : 'false');
  } catch {
    // ignore (storage unavailable)
  }
}

export function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

export function skipVersion(version: string | null): void {
  try {
    if (version) localStorage.setItem(SKIP_KEY, version);
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    // ignore
  }
}

interface InstallInfo {
  canSelfUpdate: boolean;
  kind: 'nsis' | 'msi' | 'appimage' | 'package' | 'pacman' | 'portable';
}

interface PortableUpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string | null;
}

/**
 * Checks GitHub Releases. Null = no newer version (or not running in the desktop app).
 *
 * Installed copies use the updater plugin (installer / AppImage / package). A portable copy asks
 * for the portable build of the release (backend: install.rs) and replaces its own program file;
 * when the release has no portable build for this system, the notice only links to the releases page.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null;
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  const info = await invoke<InstallInfo>('app_install_info').catch(() => null);

  if (info?.kind === 'portable') {
    const portable = await invoke<PortableUpdateInfo | null>('portable_update_check').catch(() => null);
    if (portable) {
      return {
        version: portable.version,
        currentVersion: portable.currentVersion,
        notes: portable.notes,
        date: portable.date ?? undefined,
        canSelfUpdate: true,
        portable: true,
        pacman: false,
        install: async (onProgress) => {
          const channel = new Channel<{ downloaded: number; total: number | null }>();
          channel.onmessage = (p) => onProgress(p.downloaded, p.total);
          // On success the backend starts the new version and closes this one
          await invoke('portable_update_install', { onProgress: channel });
        },
      };
    }
  }

  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 20_000 });
  if (!update) return null;
  const canSelfUpdate = info ? info.canSelfUpdate : false;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? '',
    date: update.date,
    canSelfUpdate,
    portable: info?.kind === 'portable',
    pacman: info?.kind === 'pacman',
    install: async (onProgress) => {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          onProgress(0, total);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress(downloaded, total);
        }
      });
      // Windows: the installer closes the application itself; elsewhere restart into the new version
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}

/** Opens the release page in the default browser (portable copies). */
export async function openReleasesPage(): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(RELEASES_URL);
}

/**
 * Release notes in one language. From 1.16.0 the notes hold an English and a Polish part, each
 * after a `<!-- lang:xx -->` marker (scripts/release-notes.mjs); the part in `lang` is returned,
 * else the English one. Notes without markers (older releases) are returned whole.
 */
export function localizedNotes(notes: string, lang: string): string {
  const parts = notes.split(/<!--\s*lang:([a-z]{2})\s*-->/);
  if (parts.length < 3) return notes.trim();
  const byLang = new Map<string, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) {
    byLang.set(parts[i], parts[i + 1].replace(/\n-{3,}\s*$/, '').trim());
  }
  return byLang.get(lang) ?? byLang.get('en') ?? [...byLang.values()][0] ?? notes.trim();
}

/** Shows the update notice (UpdateNotice) – used by the manual check in Settings. */
export function announceUpdate(update: AvailableUpdate): void {
  window.dispatchEvent(new CustomEvent<AvailableUpdate>(UPDATE_EVENT, { detail: update }));
}
