# RemoteFlow

**English** | [Polski](README.pl.md)

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/nikieljacek)

RemoteFlow is a desktop **SSH, SFTP and RDP connection manager for Windows and Linux**, inspired by mRemoteNG. It brings remote terminals, remote desktops, file transfers and SSH tunnels into one tabbed workspace with split-screen layouts.

Organise hosts into nested groups, reuse credential profiles and switch between active sessions without opening separate client windows. Connection settings, passwords and stored private keys are kept in a local encrypted vault protected by a Master Password.

The application uses **Tauri 2 and Rust** for the native backend, **React 19 and TypeScript** for the interface, **xterm.js** for SSH terminals and **IronRDP/WebAssembly** for the embedded RDP client. Linux also supports an embedded native FreeRDP client.

![RemoteFlow – main window](docs/screenshots/main-en.png)

## Features

### Connections and workspace
- Polish and English user interface – switch the language in the header, on the login screen or in Settings (applied instantly).
- Dark or light theme (Settings), optionally with a dark terminal in the light theme.
- Connection tree with nested groups, colours, search (name, host, IP, tags) and drag & drop. Group expansion and per-group A–Z sorting are remembered between launches.
- Group context menus: connect to a group, add hosts or subgroups, sort, edit, delete, and expand or collapse all groups.
- Clone a saved connection configuration (after confirmation) or open another session using the same connection.
- Tabs and split-screen layouts: single, horizontal, vertical, 3 columns and 2×2 grid. Reorder tabs by dragging or from the tab menu (move to the beginning/end, left/right) without interrupting the connection; drag tabs between panes and choose a session for each pane.
- Tab scroll buttons and a searchable list of open sessions with group paths, host details and connection status. Long labels scroll to reveal their contents.
- Reusable credential profiles shared by many connections.
- Before password-based login with an empty password, choose to continue without one or enter and save a password for that connection.
- Compact confirmations beside the affected connection or tab, with optional prompts before closing sessions and the application.

### SSH
- Built-in terminal (xterm.js) with a full 16-colour palette – `mc`, `htop` and similar tools render correctly. Adjustable history buffer (Settings → SSH terminal, default 10,000 lines), scrollable also after the connection ends.
- Authentication with password, private key (with optional passphrase prompt), OpenSSH certificate or SSH agent. Keys in the OpenSSH format (Ed25519, ECDSA, RSA – the default of current `ssh-keygen`), also passphrase-protected, work on Windows and Linux; PuTTY `.ppk` keys must be exported to the OpenSSH format. The key and the certificate can be chosen as a file (read at every connection, so a renewed short-lived certificate is used automatically) or pasted. The method chosen in the connection is used without falling back to others; a connection without its own secret follows the method of its credential profile.
- Port forwarding: local, remote and dynamic (SOCKS5).
- Copy/paste from the context menu and keyboard, middle-click paste of the terminal selection.
- Server host keys verified on first use (TOFU) – the password is sent only to a trusted server.

### SFTP – two-pane file manager
- Local files on the left, server files on the right (WinSCP / FileZilla style); takes half of the pane, or the whole pane in split layouts.
- Multi-selection (click, Ctrl, Shift, Ctrl+A) and one-click upload / download of files and whole folders.
- Keyboard: Ctrl+R refreshes the pane in use (both panes when the focus is elsewhere in the window), Backspace goes up, Enter opens a folder, Delete deletes (permanently on the server, to the trash on this computer), Esc closes the window.
- Drag & drop between the panes, onto folders and from the system file manager.
- Filtering and recursive search on both sides, creating and deleting files and folders on both sides (a new empty file opens straight in the editor). Local files go to the Recycle Bin (Windows) / desktop trash (Linux); when there is no trash (e.g. a network drive), the program asks before deleting permanently.
- Transfer progress (files and data transferred) with a **Stop** button. Files are written to a temporary file next to the target (`.name.rf-part`) and replace an existing file only when complete – in both directions – so a stopped or failed transfer never leaves a truncated file and an existing file keeps its previous content (and permissions on the server). Overwrite confirmation and right-click context menus. Server deletion shows the current path and selected-item counter, followed by a result or error; folders are deleted recursively.
- **File preview and editing** on both sides – as in Total Commander: **F3** views (read-only, the "Edit" button unlocks changes, F3 again closes), **F4** edits; also the eye icon and the context menu: text with line numbers, search (Ctrl+F) and a choice of encoding (UTF-8, Windows-1250, ISO-8859-2, Latin-1, UTF-16), a **HEX** view for files of any size (read in chunks, with go-to-offset) and images. Text files up to 5 MB can be edited and saved (Ctrl+S) – the encoding, BOM, line endings (LF/CRLF) and permissions are kept, and saving through a temporary file never leaves a truncated file. If the file changed since it was opened, the program asks before overwriting. Server files are read over the same SFTP connection, without saving them to disk.
- Start folders saved per connection (local and server); by default the home folders are opened.
- "Directory from the terminal" button: the server pane jumps to the directory you are in in the SSH terminal (also in a nested shell or while a program runs; nothing is typed into the terminal). Linux servers (`/proc`); other systems use the directory reported by the shell (OSC 7), if any.

### RDP
- Embedded RDP client (IronRDP compiled to WebAssembly) through a local proxy – the resolution automatically follows the window size.
- TLS with certificate pinning; automatic fallback to the system TLS stack (Schannel / OpenSSL) for older servers such as Windows Server 2012.
- Domain accounts: `user` + domain field, `DOMAIN\user`, UPN `user@domain.local` or `.\account` for a local account – normalised the same way for the embedded client, FreeRDP and mstsc.
- Text clipboard in both directions. On Windows, files copied in the remote session can be pasted directly in Explorer (and vice versa); on Linux files are exchanged through a shared folder. The clipboard can be switched off per connection (applies to the embedded client, FreeRDP and mstsc). Local drives and the home folder are never shared with the server – FreeRDP shares only the dedicated `~/RemoteFlow_Shared` exchange folder.
- Linux: optional **FreeRDP inside the app window** (Settings → RDP client) – the native client (multi-threaded, H.264) draws the session in the RemoteFlow tab; requires X11 (on Wayland the app then runs through XWayland) and `xfreerdp3`.
- Performance statistics panel in the RDP view (data rate, screen updates, drawing time, main-thread load).
- Optional launch of the system client (`mstsc` on Windows, FreeRDP on Linux – started with the graphics pipeline `/gfx` and `/network:auto`; faster than the embedded client for video or heavy scrolling).

### Security
- Vault encrypted with **AES-256-GCM**, key derived from the Master Password with **Argon2id**.
- Format v3 also encrypts connection names, addresses, users, notes, groups and trusted server identities. The authenticated public header retains unlock, interface and backup settings. Older vaults are backed up and migrated after a successful unlock; existing backups keep their original format. Use version 1.6.1 or newer to open a v3 vault.
- **HMAC-SHA256** integrity check of the whole vault file – modifications made outside the app are detected.
- Quick unlock with a PIN (the master key wrapped by the PIN exists only in memory).
- Automatic lock after inactivity and when the operating system is locked (Windows, Linux logind / ScreenSaver).
- Unfinished connection edits survive a lock and can be saved after unlocking with PIN or Master Password.
- Periodic vault backups, restore from Settings.
- Password-protected `.rfvault` export / import of all connections or selected groups, including subgroups and relevant credential profiles. Connections outside groups can be included separately. Optional plaintext JSON export requires explicit confirmation.
- FreeRDP is pinned to the server certificate stored in the vault (remembered on the first connection, shared with the embedded client). Certificate conflicts show the current SHA-256 fingerprint for verification and explicit approval. Reconnecting uses that exact fingerprint without disabling certificate checks or deleting the shared FreeRDP certificate cache.

<img src="docs/screenshots/login-en.png" alt="RemoteFlow – login screen" width="600">

### Import from mRemoteNG
- Imports `confCons.xml` together with folders and **passwords** (AES-GCM and legacy AES-CBC, also fully encrypted files).
  Passwords are decrypted only in the Rust backend and immediately re-encrypted with the vault key.

## Download

Ready-made builds are published on the [Releases](https://github.com/jacek-nikiel/RemoteFlow/releases) page: Windows installer (`.exe`, `.msi`), Linux packages (`.AppImage`, `.deb`, `.rpm`, Arch Linux `.pkg.tar.zst`) and portable builds without an installer: `remoteflow_X.Y.Z_x64-portable.exe` (Windows) and `remoteflow_X.Y.Z_amd64-portable` (Linux). They are built from this repository by GitHub Actions ([release workflow](.github/workflows/release.yml)) – the build log of every release is public.

### Updates
The application checks the Releases page at start-up and once a day and offers a new version with its release notes (*Settings → Updates*: switch off automatic checks or check now). Every update package is signed; the application installs only packages signed with the project key whose public part is in [`tauri.conf.json`](src-tauri/tauri.conf.json) (`plugins.updater.pubkey`). Windows and AppImage update in place; `.deb` / `.rpm` are installed with `pkexec` (administrator password prompt). The Arch Linux package is updated with pacman: the program announces the new version and links to the releases page (`sudo pacman -U ./remoteflow-X.Y.Z-1-x86_64.pkg.tar.zst`). A portable copy (the bare executable without an installer, e.g. on a USB drive, or one with the `remoteflow.portable` marker) does not run an installer: it downloads the signed portable build, replaces its own file in the same folder and restarts (from version 1.14.0; the folder must be writable).
Requirements: Windows 10/11 x64 with the Microsoft Edge WebView2 Runtime, or Linux with WebKitGTK 4.1 and GTK 3. Embedding the native Linux RDP client additionally requires FreeRDP and X11/XWayland.

**Linux users:** see [runtime packages and installation commands](docs/LINUX.md) for Ubuntu and CachyOS/Arch, including optional FreeRDP, file pickers and AppImage requirements. This list is separate from the build dependencies below.

Linux: if the window flickers, stays blank or the console shows `DRM_IOCTL_MODE_CREATE_DUMB failed` / `Failed to create GBM buffer`, switch *Settings → Colour theme → Window rendering (Linux)* to *Compatible* (or start once with `REMOTEFLOW_SAFE_RENDERING=1 remoteflow`).

## Building from source

### Requirements
- [Node.js](https://nodejs.org/) **20.19+ or 22.12+** (required by Vite 8)
- [Rust](https://rustup.rs/) (stable, edition 2024 support)
- Windows: Visual Studio C++ Build Tools (offered by the Rust installer)
- Linux (Debian/Ubuntu):
  ```bash
  sudo apt install build-essential pkg-config file patchelf libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
  ```
- Linux runtime (recommended): `wl-clipboard` (Wayland) or `xclip` (X11) – used for reliable copying to the system clipboard (e.g. passwords).

### Commands
```bash
npm ci
npm run tauri dev      # development mode
npm run tauri build    # release build + installers
```
Output:
- Windows – `src-tauri/target/release/remoteflow.exe`, installers in `src-tauri/target/release/bundle/nsis` and `bundle/msi`
- Linux – `src-tauri/target/release/remoteflow`, packages in `src-tauri/target/release/bundle/` (`.deb`, `.rpm`, `.AppImage`)

On Windows you can also use `run-windows.bat` (development mode) and `build-windows.bat` (release build).

### Linux build in Docker (also from Windows)
```bash
docker build -f docker/Dockerfile.linux --target export --output type=local,dest=dist-linux .
```
or simply run `build-linux-docker.bat` on Windows. The packages land in `dist-linux/`.

### Linux portable desktop icon
The portable build does not automatically create an application menu entry. Keep `install-linux-desktop.sh` and `remoteflow.png` from the Docker output beside the executable, then run `bash ./install-linux-desktop.sh` without sudo. For an AppImage or another location, pass its executable path as the first argument. Launch RemoteFlow from the application menu and re-pin any old dock shortcut. Run the script again after moving the executable. It only creates `applications/remoteflow.desktop` and `icons/hicolor/512x512/apps/remoteflow.png` under `${XDG_DATA_HOME:-$HOME/.local/share}`; removing these two files removes the integration.

### Tests
```bash
node scripts/check-i18n.mjs   # every UI text has an English translation
npm run build                # strict TypeScript checks and production UI build
python3 scripts/test-linux-desktop.py # portable desktop integration (Linux)
cd src-tauri
cargo check --all-targets     # compiler diagnostics for the current platform
cargo test --lib              # unit tests
cargo test --lib -- --ignored # integration tests (require local SSH/RDP test servers)
```
Linux compilation and unit tests can also run on Windows through Docker:
```bash
docker build -f docker/Dockerfile.linux --target verify .
```

## Where is my data?
The vault (`vault.json`) is kept in the user configuration directory: `%APPDATA%\remoteflow` on Windows,
`~/.config/remoteflow` on Linux. Updating or uninstalling the application does not delete it.

**Portable mode** (e.g. on a USB drive): put an empty file named `remoteflow.portable` next to the executable (for an
AppImage – next to the `.AppImage` file); a new vault is then created in that folder. A `vault.json` that already lies
next to the executable is always used – also one created there by versions before 1.13.2.
Backups are kept in the `backups` folder next to the vault, or in another folder chosen in *Settings → Vault backups*.
Besides the encrypted vault, only non-sensitive settings are stored unencrypted: window rendering options
(`display.json` next to the vault) and interface preferences such as language, theme, panel width and expanded groups
(web view storage). Files you exchange with RDP sessions on Linux are kept in `~/RemoteFlow_Shared`.

## Technology stack
| Layer | Technologies |
|---|---|
| Application shell | Tauri 2, WebView2 (Windows) / WebKitGTK (Linux) |
| Backend | Rust 2024, tokio, ssh2 (libssh2), ssh-key, rustls + native-tls, tokio-tungstenite, ironrdp-rdcleanpath, tauri-plugin-updater |
| Cryptography | argon2, aes-gcm, hmac + sha2, zeroize |
| UI | React 19, TypeScript, Vite 8, Tailwind CSS 4, lucide-react |
| Terminal / RDP | xterm.js 6, IronRDP (WebAssembly), optional FreeRDP on Linux and system RDP clients |
| Platform | clipboard-win (Windows), zbus / GTK (Linux) |

## Versioning
The project uses [semantic versioning](https://semver.org/). Every change increases at least the patch number –
see [CHANGELOG.md](CHANGELOG.md) (Polish: [CHANGELOG.pl.md](CHANGELOG.pl.md)). The version is kept in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml` (a unit test checks that they match) and is shown next to the logo and on the login screen.

## Releases (maintainers)
One-time setup:
1. Generate the updater signing key on your computer (never commit the private key):
   ```bash
   npx tauri signer generate -w ~/.tauri/remoteflow.key        # Windows: -w %USERPROFILE%\.tauri\remoteflow.key
   ```
2. Put the content of `remoteflow.key.pub` into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
3. In GitHub → *Settings → Secrets and variables → Actions* add `TAURI_SIGNING_PRIVATE_KEY` (content of `remoteflow.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Each release:
```bash
git tag v1.2.3            # must match the version in package.json; CHANGELOG.md and CHANGELOG.pl.md need a "## 1.2.3 – …" section
git push origin v1.2.3
```
GitHub Actions builds Windows and Linux, signs the update packages and creates a **draft** release with notes from both changelogs (English and Polish; the in-app update notice shows the part in the interface language). Check it and press *Publish* – from then on the application offers the update.
Losing the private key means existing installations cannot verify new updates (users would have to install a new version manually) – keep a backup.

## Security
See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Support the project
RemoteFlow is free and open source, developed after hours. If it saves you time, you can support further development:
**[buymeacoffee.com/nikieljacek](https://buymeacoffee.com/nikieljacek)** – thank you! Bug reports and ideas in [Issues](https://github.com/jacek-nikiel/RemoteFlow/issues) help just as much.

## License
[MIT](LICENSE) © 2026 Jacek Nikiel
