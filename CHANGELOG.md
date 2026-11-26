# Changelog – RemoteFlow

🇵🇱 [Wersja polska](CHANGELOG.pl.md)

Version number: `MAJOR.MINOR.PATCH`. Every change bumps at least the PATCH number.
The version is kept in three files that must match (checked by the `version_tests` test in `src-tauri/src/lib.rs`):
`package.json` (shown in the app), `src-tauri/tauri.conf.json` (installer) and `src-tauri/Cargo.toml`.

Each release has a section for the same version (`## X.Y.Z – …`) in this file and in `CHANGELOG.pl.md`; both go into the
release notes, and the in-app update notice shows the one in the interface language.

## Unreleased

### Fixed
- **Folders:** a folder can no longer be placed inside its own subfolder (this used to hang the sidebar). Existing cycles are repaired when the vault opens. Deleting a folder moves its subfolders one level up instead of hiding them.
- **Shortcuts in sessions:** Ctrl+L, Ctrl+B, Ctrl+R and F5 now reach the RDP session (Ctrl+L used to lock RemoteFlow). New **Ctrl+Shift+L** (lock) and **Ctrl+Shift+B** (sidebar) work everywhere, also inside a session.
- **Credentials:** the form has the same key options as the connection form: key file path, ask for the passphrase at connect, SSH certificate (file or text) and SSH agent. Editing a credential no longer clears fields that were not shown.
- **PIN:** 4–12 digits everywhere; the dots follow the typed digits; an empty PIN is refused with a message.
- **Lock with FreeRDP:** embedded FreeRDP windows are hidden as soon as the vault locks (also on Windows lock / sleep), so nothing shows over the lock screen.
- **RDP folder browser:** "up" and "Send this folder" work on Windows paths too.

### Changed
- **Dropping files works on Windows:** drag files or folders onto the SSH terminal or the RDP picture (native drops). In the terminal they go to the shell's current folder with the same transfer as the SFTP window (progress on the Files button, Stop in the window). Ctrl+V of copied files in the terminal does the same.
- **Nothing is skipped:** folders like `.git`, `node_modules` or `target` are sent too – for example to a build server.
- **Faster and lighter RDP file staging:** files are copied by path and sent as raw bytes, without Base64. Limits: 5000 files, 1 GB per file; you get a message about skipped files.

## 1.17.0 – SSH tunnels list, background SFTP transfers, sharp RDP Auto picture, security hardening
- **Embedded RDP client updated** to IronRDP 0.8 / iron-remote-desktop 0.12.
- **RDP picture in 32-bit color.** The embedded client now asks for the color depth of the connection settings (32-bit); IronRDP's own default was 16-bit, which spoiled anti-aliased text (ClearType) on colored backgrounds. The RDP statistics panel shows the graphics mode and color depth.
- **Fix: broken letters in the RDP "Auto" mode** (single rows or columns of pixels missing, e.g. "Ten" shown as "Ien"; Full HD at 100% was fine). The 1:1 picture was centred in the viewer at half pixels (the area is a pixel or two larger than the desktop) and moved back onto whole pixels with a transform, which made the browser resample it. It is now placed with margins exactly on screen pixels, without a transform. Also: the desktop size is rounded down, a desktop at most 2 screen pixels larger than the area is shown 1:1 instead of slightly scaled down (blurred), the placement is checked again every second, and the statistics panel shows a 1:1 picture that is not aligned to screen pixels.
- **SFTP transfer visible with the window closed.** A transfer keeps running when the SFTP window is closed; the **Files (SFTP)** button of the terminal now shows it: amber with a spinner and the amount transferred so far (the tooltip has the current file and the number of files done; a click opens the window with the progress and the Stop button). When the transfer ends with the window closed, the button stays green (done) or red (error or cancelled, with the summary in the tooltip) until the window is opened – for 30 seconds or 2 minutes after an error.
- **SSH tunnels list.** The **Tunnels (N)** button of an SSH tab now opens a compact list of the tab's tunnels right under the button, like "Open connections" (before, it only had a tooltip). Each tunnel shows where it listens and where it leads, whether it works – active, an error with the reason (e.g. a busy local port, a remote port the server refused) or a remote tunnel waiting for the server connection – and how many connections go through it now. The address of a local or SOCKS5 tunnel can be copied, and a local tunnel opened in the browser. The list also shows whether the SSH connection that carries the tunnels is up.
- **RDP statistics: picture row.** The RDP statistics panel shows the size of the remote desktop, the size and scaling requested from the server, the viewer area in screen pixels and whether the picture is shown 1:1 or scaled – to find the cause of a blurry picture.
- Translations: the send button of the key sequence menu read "Upload" in English (now "Send keys"); "Ready:" next to a file prepared for Windows, "Loading…" in the folder browser of the RDP files window and the list of active tunnels in the SSH terminal were in Polish in the English interface.
- **Export and .rdp file: "Save as" dialog.** The vault export (`.rfvault` / `.json`) and the `.rdp` file of an RDP session are saved where you choose in the system "Save as" dialog, and the message shows the full path. Before, they went silently to the downloads folder (also a plain export with passwords in clear text). On Unix the file is owner-only; the program's own data cannot be overwritten this way. Linux without zenity/kdialog: saved in the downloads folder (or the home folder) under a free name.
- **Connection editor: numbers limited to their range.** A port (also of SSH tunnels) cannot be typed above 65535, the RDP width/height above 8192; an empty or too small value is reported when saving instead of an error about "u16". Before, e.g. port 5559595959 failed with a technical message.
- Settings → vault backups: the number of kept backups ("10 ostatnich") was shown in Polish in the English interface.

Security hardening after an external code review (none of these could be used from outside without first running code inside the application window, which the content security policy prevents):
- **Local files only while unlocked, the program's own data protected.** The commands of the SFTP window, the file preview/editor and the RDP file exchange that work on this computer's files now require an unlocked vault. The vault file, its backups and `display.json` can no longer be previewed, edited, overwritten, deleted or sent to a server from these windows (also not through a symbolic link), and a folder containing them cannot be deleted. Other files – also `~/.ssh` – stay accessible as before.
- **RDP file exchange:** the target folder for files downloaded from a Windows session is taken from the connection in the vault, not from the window. `~/RemoteFlow_Shared` is owner-only on Linux (0700, also an existing folder); without a home folder there is no fallback to the world-writable `/tmp`.
- **Copied passwords** (tab menu, RDP session bar) are cleared from the clipboard after 30 seconds if they are still there; on Windows they are kept out of the clipboard history (Win+V) and cloud clipboard sync.
- **Text dropped onto the SSH terminal** is pasted like Ctrl+V (bracketed paste) – a dropped multi-line text is no longer executed line by line right away.
- **Downloaded .rdp file:** line breaks are removed from the host, user name and domain (an imported connection could otherwise add its own settings to the file), IPv6 addresses are written in brackets, no drive is shared.
- **Key files** set in a connection or credential (possibly from an imported file) are read only when they look like a private key and are at most 64 KB – the same checks as a key picked in the dialog.
- **Secrets in memory:** decrypted passwords and keys of SSH/RDP connections are wiped from memory when no longer needed (also after an encrypted export), and connection settings never print them in logs.
- **Vault reset:** the copy of the old vault gets a unique name (milliseconds, plus a counter), so two resets close together can never overwrite it. A custom backup folder is created owner-only and only after the vault is unlocked.

## 1.16.1 – Sharp RDP picture with display scaling
- **Fix: blurry RDP picture with display scaling** (e.g. 4K screens, Windows scaling 150–200%). In the "Fit to window (Auto)" mode the remote desktop was requested in scaled pixels (about 1920 × 1080 on a 4K screen at 200%) and stretched to the screen. It now gets the full screen resolution and the server receives the scaling factor (Display Control), so text keeps its size but is sharp – as in the Microsoft client. The picture is also shown pixel for pixel, on any display scaling (also 100%): before, it was stretched by a fraction of a percent to fill the area, which blurred text. The "Fit / 100%" switch is now two buttons showing the active mode (before, one button showed the current mode and was easy to read as the action), and only for a fixed resolution (in Auto both looked the same). "Fit" scales the desktop to the window, also up (a smaller resolution was only centred); "100% (1:1)" means one remote pixel per screen pixel (it was 2× enlarged at 200%). Moving the window to a monitor with different scaling updates the desktop. Fixed resolutions from the list are unchanged.

## 1.16.0 – Arch Linux package, settings save fix, F3 closes the viewer
- **Fix: settings could not be saved with the default terminal history buffer.** The field accepted only values like 9,100 or 10,100 (steps of 1,000 counted from the minimum 100), so the default 10,000 blocked the Save button with "enter a valid value". It now goes in steps of 100.
- **SFTP: F3 again closes the viewer** (as in Total Commander's lister) – for a file opened read-only (F3, the eye icon). While editing, F3 does nothing; Esc still closes in both cases.
- **Arch Linux package** (`remoteflow-X.Y.Z-1-x86_64.pkg.tar.zst`) in releases, installed with `sudo pacman -U`. It is built by the release workflow from the same program as the other Linux packages (`scripts/build-arch-pkg.sh`, also in the Docker build), in a step without access to the signing key. The program recognises a pacman installation (also an AUR package) and does not update itself – the update notice links to the releases page instead of trying a .deb/.rpm install. Suggested by [9M2PJU](https://github.com/9M2PJU).
- Three remaining hard-coded PL/EN texts (copy name, export scope error, cancelled connection) now go through the translations – thanks to [9M2PJU](https://github.com/9M2PJU).
- **Update notes in your language:** the release notes contain an English and a Polish part, and the update notice shows the one matching the interface language (English as fallback). Versions up to 1.15.1 still show both parts when updating to this version.
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
