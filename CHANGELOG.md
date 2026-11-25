# Changelog – RemoteFlow

🇵🇱 [Wersja polska](CHANGELOG.pl.md)

Version number: `MAJOR.MINOR.PATCH`. Every change bumps at least the PATCH number.
The version is kept in three files that must match (checked by the `version_tests` test in `src-tauri/src/lib.rs`):
`package.json` (shown in the app), `src-tauri/tauri.conf.json` (installer) and `src-tauri/Cargo.toml`.

Each release has a section for the same version (`## X.Y.Z – …`) in this file and in `CHANGELOG.pl.md`; both go into the
release notes, and the in-app update notice shows the one in the interface language.

## Unreleased
- **Fix: settings could not be saved with the default terminal history buffer.** The field accepted only values like 9,100 or 10,100 (steps of 1,000 counted from the minimum 100), so the default 10,000 blocked the Save button with "enter a valid value". It now goes in steps of 100.
- **SFTP: F3 again closes the viewer** (as in Total Commander's lister) – for a file opened read-only (F3, the eye icon). While editing, F3 does nothing; Esc still closes in both cases.
- **Arch Linux package** (`remoteflow-X.Y.Z-1-x86_64.pkg.tar.zst`) in releases, installed with `sudo pacman -U`. It is built by the release workflow from the same program as the other Linux packages (`scripts/build-arch-pkg.sh`, also in the Docker build), in a step without access to the signing key. The program recognises a pacman installation (also an AUR package) and does not update itself – the update notice links to the releases page instead of trying a .deb/.rpm install. Suggested by [9M2PJU](https://github.com/9M2PJU).
- Three remaining hard-coded PL/EN texts (copy name, export scope error, cancelled connection) now go through the translations – thanks to [9M2PJU](https://github.com/9M2PJU).
- Release workflow: GitHub actions updated to versions running on Node.js 24 (checkout v5, setup-node v5, github-script v8).

## 1.15.1 – SFTP: F3 view, F4 edit; Ctrl+Z fix in the editor
- **SFTP: F3 – view, F4 – edit** (as in Total Commander / Midnight Commander). F3 and the eye icon open a file read-only – an accidental key press changes nothing; the **Edit** button (or F4) in the viewer unlocks editing without reopening the file. F4 opens a file ready for editing with the cursor in the text. The context menu has separate "View (F3)" and "Edit (F4)" items; a new file opens for editing. Before, both keys did the same.
- **Fix: Ctrl+Z in the editor no longer undoes loading the file.** Pressing Ctrl+Z several times after opening a file could clear the whole text (undoing the "load"), and saving would then write an empty file.

## 1.15.0 – SFTP: file preview and editing, new file, local delete to the Recycle Bin
- **SFTP: new file** – a toolbar button and a "New file" context-menu item on both sides (server and this computer). Creates an empty file (never overwrites an existing one) and opens it in the editor right away.
- **SFTP: file preview and editing** on both sides – **F3**/**F4**, the eye icon in the toolbar or the context menu (double-click still transfers the file).
  - **Text:** CodeMirror editor with line numbers, find and replace (Ctrl+F), undo and line wrapping; the encoding is detected automatically (UTF-8, BOM, UTF-16, otherwise Windows-1250) and can be changed by hand (also ISO-8859-2, Windows-1252).
  - **Editing and saving (Ctrl+S)** of text files up to 5 MB: the encoding, BOM, line endings (LF/CRLF/CR) and permissions are kept; saving goes through a temporary file that replaces the original only when complete (on the server the same code as uploads, locally keeping symbolic links); the program checks whether the file changed since it was opened (size and modification time) and asks before overwriting; a character missing from the file's encoding blocks saving with a message; closing with unsaved changes asks to save.
  - Larger text files – view only, loaded 1 MB at a time.
  - The preview header buttons do not move when switching Text / HEX / Image.
  - **HEX:** offset, 16 bytes per row, ASCII column; files of any size read in 64 KB chunks while scrolling, go to offset, byte value.
  - **Images** (PNG, JPG, GIF, WebP, BMP, ICO, SVG up to 20 MB; SVG in `<img>`, no scripts run).
  - Backend: `preview_stat`, `preview_read` (raw bytes, max. 4 MB per chunk), `preview_save` (content as the raw request body). The editor is loaded on first use.
  - Tests: chunked reads, saving with permissions and links kept, change detection (locally and – e2e test – on an SFTP server).
- **SFTP: deleting files and folders on this computer.** The left pane has a trash button, the **Delete** key and a "Move to trash" context-menu item (before: server side only). Files go to the Windows Recycle Bin / the desktop trash on Linux (freedesktop), so they can be restored. On Windows the move to the Recycle Bin is done by the system PowerShell (Windows shell API), not by the program itself – done directly by a new, unsigned program it was blocked by behaviour-based antivirus as ransomware behaviour (F-Secure DeepGuard: *CryptoRansomwareBehavior*). The Recycle Bin is used on fixed drives only – on a network or removable drive the program asks before deleting permanently. When there is no trash, the program asks separately before deleting the remaining items permanently. A symbolic link is removed itself – never its target. The home folder, drive roots and relative paths cannot be deleted.
- Test: permanent delete (with a link to a folder outside the deleted folder) and refusing the home folder / drive roots.

## 1.14.0 – portable builds in releases with self-update, Polish plural forms
- **Portable builds in releases and their updates.** The release workflow also publishes the bare program without an installer: `remoteflow_X.Y.Z_x64-portable.exe` (Windows) and `remoteflow_X.Y.Z_amd64-portable` (Linux), signed with the update key and added to `latest.json` (`windows-x86_64-portable`, `linux-x86_64-portable`). A portable copy downloads this build instead of the installer, verifies the signature, replaces its own file in the same folder (Windows: the old file stays as `remoteflow.exe.old` and is removed at the next start) and restarts. When the folder is read-only or the release has no portable build, the notice links to the releases page.
- An AppImage with a `remoteflow.portable` file next to it is updated like a normal AppImage (the `.AppImage` file is replaced).
- Tests: installation type detection, replacing the program file (keeping the executable bit).
- **Correct Polish plural forms** in counters and messages (1 element, 2–4 elementy, 5 elementów…); in English "1 item" instead of "1 items". New `tn(count, [one, few, many])` helper in `src/i18n`; `scripts/check-i18n.mjs` also checks the translations of all forms.
- New screenshots in the README and wiki (version 1.13.3).

## Older versions
Versions 1.0.1 – 1.13.3 are described (in Polish) in [CHANGELOG.pl.md](CHANGELOG.pl.md#1133--potwierdzenie-klonowania-aktualizacje-kopii-przenośnych).
