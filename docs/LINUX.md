# Linux runtime requirements

**English** | [Polski](LINUX.pl.md) | [README](../README.md)

These instructions are for running a compiled RemoteFlow binary, not building it. Node.js, npm, Rust, a compiler and `-dev` packages are not required. The supplied Linux builds are x86_64; the Docker build uses Ubuntu 22.04 as its compatibility baseline. Run the application in a graphical desktop session.

## Required libraries

The exported ELF binary links to these library families:

| Component | Purpose |
|---|---|
| WebKitGTK **4.1**, JavaScriptCoreGTK 4.1 and libsoup 3 | Application web view and embedded WebAssembly RDP client |
| GTK **3**, GLib/GIO, GDK-Pixbuf and Cairo | Native window and drawing |
| OpenSSL **3** (`libssl.so.3`, `libcrypto.so.3`) | TLS and SSH cryptographic dependencies |
| X11 (`libX11.so.6`), D-Bus and zlib | Linked system libraries; X11 is linked even when the desktop uses Wayland |
| glibc and the GCC runtime | Linux runtime, supplied by the distribution |

The package manager installs most of these transitively with WebKitGTK and GTK. WebKitGTK 4.0/6.0 or GTK 4 alone do not replace the required versions. `ca-certificates` supplies system certificate authorities; `xdg-utils` enables opening folders through the desktop file manager.

## Ubuntu 22.04

Install the runtime and desktop integration packages:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libssl3 libx11-6 libdbus-1-3 zlib1g ca-certificates xdg-utils
```

## Ubuntu 24.04 / 26.04

GTK and OpenSSL packages use the `t64` names:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0t64 libssl3t64 libx11-6 libdbus-1-3 zlib1g ca-certificates xdg-utils
```

## CachyOS / Arch Linux

```bash
sudo pacman -Syu --needed webkit2gtk-4.1 gtk3 openssl libx11 dbus zlib ca-certificates xdg-utils
```

## Feature-specific packages

| Feature | Ubuntu | CachyOS / Arch |
|---|---|---|
| Native file/folder picker | `zenity` or `kdialog` | `zenity` or `kdialog` |
| Native FreeRDP client | 24.04/26.04: `freerdp3-x11`; 22.04: `freerdp2-x11` | `freerdp` and `which` |
| FreeRDP embedded in the app on Wayland | `xwayland` | `xorg-xwayland` |
| SSH agent authentication | `openssh-client` and a running agent | `openssh` and a running agent |
| Reliable copying to the system clipboard (e.g. passwords) | Wayland: `wl-clipboard`; X11: `xclip` | Wayland: `wl-clipboard`; X11: `xclip` |
| AppImage reporting missing `libfuse.so.2` | 22.04: `libfuse2`; 24.04/26.04: `libfuse2t64` | `fuse2` |

FreeRDP is optional: SSH, SFTP and the WebAssembly RDP client do not need an external SSH/RDP executable. Embedded native RDP needs `xfreerdp3` or `xfreerdp` and an X11 display (XWayland under Wayland); restart RemoteFlow after enabling that mode. FreeRDP 3 is recommended for the native mode, including certificate approval/retry. Ubuntu 22.04's FreeRDP 2 is a compatibility option and may differ in supported flags.

Install a file picker, for example:

```bash
# Ubuntu
sudo apt install zenity
# CachyOS / Arch
sudo pacman -S --needed zenity
```

For native RDP on Ubuntu 24.04/26.04:

```bash
sudo apt install freerdp3-x11 xwayland
```

For native RDP on CachyOS / Arch:

```bash
sudo pacman -S --needed freerdp xorg-xwayland which
```

## Packages and portable builds

- Install a `.deb` with `sudo apt install ./remoteflow_VERSION_amd64.deb` so APT can resolve its declared dependencies. Package names vary between distributions; the lists above also cover the portable binary.
- On CachyOS / Arch Linux install the release package with `sudo pacman -U ./remoteflow-VERSION-1-x86_64.pkg.tar.zst` – pacman installs the required libraries; RDP, file pickers and clipboard helpers are optional dependencies (`pacman -Qi remoteflow`, packages listed above). A new version is installed the same way; the program only announces it.
- For the portable binary, run `chmod +x ./remoteflow`, then `./remoteflow`. Add its menu entry and icon using the [portable desktop integration instructions](../README.md#linux-portable-desktop-icon).
- AppImage bundles many libraries, but still depends on the host's graphics stack and compatible glibc. If it reports a FUSE 2 error, install the appropriate package from the table. If supported by that AppImage, `./RemoteFlow.AppImage --appimage-extract-and-run` is an alternative.

## Diagnostics

For a trusted RemoteFlow binary, inspect missing shared libraries with:

```bash
ldd ./remoteflow
```

An entry marked `not found` identifies a missing library. Check native RDP availability with `command -v xfreerdp3 || command -v xfreerdp`.

If the window is blank or flickers due to GPU rendering, try:

```bash
REMOTEFLOW_SAFE_RENDERING=1 ./remoteflow
```

## Package references

- [Ubuntu WebKitGTK 4.1](https://packages.ubuntu.com/jammy/libwebkit2gtk-4.1-0)
- [Ubuntu GTK 3 t64](https://packages.ubuntu.com/noble/libgtk-3-0t64) and [OpenSSL 3 t64](https://packages.ubuntu.com/libssl3t64)
- [Ubuntu FreeRDP 3 packages](https://packages.ubuntu.com/freerdp3-x11) and [FreeRDP 2 on Ubuntu 22.04](https://packages.ubuntu.com/jammy/freerdp2-x11)
- [Arch WebKitGTK 4.1](https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/) and [FreeRDP](https://archlinux.org/packages/extra/x86_64/freerdp/)
- [AppImage FUSE requirements](https://github.com/AppImage/AppImageKit/wiki/FUSE)
