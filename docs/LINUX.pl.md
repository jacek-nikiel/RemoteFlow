# Wymagania uruchomieniowe na Linuksie

[English](LINUX.md) | **Polski** | [README](../README.pl.md)

Instrukcja dotyczy uruchamiania skompilowanej aplikacji, a nie jej budowania. Node.js, npm, Rust, kompilator i pakiety `-dev` nie są potrzebne. Dostarczane wersje linuksowe są przeznaczone dla x86_64; kompilacja w Dockerze wykorzystuje Ubuntu 22.04 jako bazę zgodności. Aplikację należy uruchamiać w graficznej sesji pulpitu.

## Wymagane biblioteki

Gotowa binarka ELF jest połączona z następującymi rodzinami bibliotek:

| Składnik | Zastosowanie |
|---|---|
| WebKitGTK **4.1**, JavaScriptCoreGTK 4.1 i libsoup 3 | Widok interfejsu i wbudowany klient RDP WebAssembly |
| GTK **3**, GLib/GIO, GDK-Pixbuf i Cairo | Natywne okno i rysowanie |
| OpenSSL **3** (`libssl.so.3`, `libcrypto.so.3`) | TLS i zależności kryptograficzne SSH |
| X11 (`libX11.so.6`), D-Bus i zlib | Biblioteki systemowe; X11 jest dołączone także wtedy, gdy pulpit działa na Waylandzie |
| glibc i biblioteka wykonawcza GCC | Środowisko uruchomieniowe dostarczane przez dystrybucję |

Menedżer pakietów instaluje większość tych bibliotek jako zależności WebKitGTK i GTK. Samo WebKitGTK 4.0/6.0 lub GTK 4 nie zastępuje wymaganych wersji. Pakiet `ca-certificates` dostarcza systemowe urzędy certyfikacji, a `xdg-utils` umożliwia otwieranie katalogów w systemowym menedżerze plików.

## Ubuntu 22.04

Zainstaluj biblioteki uruchomieniowe i pakiety integracji z pulpitem:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libssl3 libx11-6 libdbus-1-3 zlib1g ca-certificates xdg-utils
```

## Ubuntu 24.04 / 26.04

Pakiety GTK i OpenSSL mają nazwy z przyrostkiem `t64`:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0t64 libssl3t64 libx11-6 libdbus-1-3 zlib1g ca-certificates xdg-utils
```

## CachyOS / Arch Linux

```bash
sudo pacman -Syu --needed webkit2gtk-4.1 gtk3 openssl libx11 dbus zlib ca-certificates xdg-utils
```

## Pakiety potrzebne do wybranych funkcji

| Funkcja | Ubuntu | CachyOS / Arch |
|---|---|---|
| Systemowe okno wyboru plików i katalogów | `zenity` albo `kdialog` | `zenity` albo `kdialog` |
| Natywny klient FreeRDP | 24.04/26.04: `freerdp3-x11`; 22.04: `freerdp2-x11` | `freerdp` i `which` |
| FreeRDP osadzony w aplikacji na Waylandzie | `xwayland` | `xorg-xwayland` |
| Uwierzytelnianie przez agenta SSH | `openssh-client` i uruchomiony agent | `openssh` i uruchomiony agent |
| Niezawodne kopiowanie do schowka systemowego (np. haseł) | Wayland: `wl-clipboard`; X11: `xclip` | Wayland: `wl-clipboard`; X11: `xclip` |
| AppImage zgłaszający brak `libfuse.so.2` | 22.04: `libfuse2`; 24.04/26.04: `libfuse2t64` | `fuse2` |

FreeRDP jest opcjonalny: SSH, SFTP i wbudowany klient RDP WebAssembly nie wymagają zewnętrznego programu SSH/RDP. Osadzony, natywny RDP potrzebuje `xfreerdp3` albo `xfreerdp` i sesji X11 (XWayland na Waylandzie); po włączeniu tego trybu uruchom RemoteFlow ponownie. Do trybu natywnego, w tym akceptacji certyfikatów i ponawiania połączenia, zalecany jest FreeRDP 3. FreeRDP 2 z Ubuntu 22.04 jest wariantem zgodności i może różnić się obsługiwanymi opcjami.

Przykład instalacji okna wyboru plików:

```bash
# Ubuntu
sudo apt install zenity
# CachyOS / Arch
sudo pacman -S --needed zenity
```

Natywny RDP na Ubuntu 24.04/26.04:

```bash
sudo apt install freerdp3-x11 xwayland
```

Natywny RDP na CachyOS / Arch:

```bash
sudo pacman -S --needed freerdp xorg-xwayland which
```

## Pakiety i wersja portable

- Pakiet `.deb` instaluj poleceniem `sudo apt install ./remoteflow_WERSJA_amd64.deb`, aby APT mógł dobrać zadeklarowane zależności. Nazwy pakietów różnią się między dystrybucjami; powyższe listy obejmują również binarkę portable.
- Na CachyOS / Arch Linux zainstaluj paczkę z wydania poleceniem `sudo pacman -U ./remoteflow-WERSJA-1-x86_64.pkg.tar.zst` – pacman doinstaluje wymagane biblioteki; RDP, okna wyboru plików i obsługa schowka to zależności opcjonalne (`pacman -Qi remoteflow`, pakiety wymienione wyżej). Nową wersję instaluje się tak samo; program tylko o niej informuje.
- Dla wersji portable wykonaj `chmod +x ./remoteflow`, a następnie `./remoteflow`. Skrót w menu i ikonę dodaj według [instrukcji integracji portable z pulpitem](../README.pl.md#ikona-i-skrót-dla-wersji-portable-na-linuksie).
- AppImage zawiera wiele bibliotek, ale nadal korzysta ze stosu graficznego systemu i wymaga zgodnego glibc. Jeżeli zgłasza błąd FUSE 2, doinstaluj odpowiedni pakiet z tabeli. Jeśli dana paczka to obsługuje, alternatywą jest `./RemoteFlow.AppImage --appimage-extract-and-run`.

## Diagnostyka

Dla zaufanej binarki RemoteFlow sprawdź brakujące biblioteki:

```bash
ldd ./remoteflow
```

Wpis `not found` wskazuje brakującą bibliotekę. Dostępność natywnego klienta RDP sprawdzisz poleceniem `command -v xfreerdp3 || command -v xfreerdp`.

Jeśli okno jest puste lub miga z powodu renderowania GPU, spróbuj:

```bash
REMOTEFLOW_SAFE_RENDERING=1 ./remoteflow
```

## Źródła nazw pakietów

- [Ubuntu: WebKitGTK 4.1](https://packages.ubuntu.com/jammy/libwebkit2gtk-4.1-0)
- [Ubuntu: GTK 3 t64](https://packages.ubuntu.com/noble/libgtk-3-0t64) i [OpenSSL 3 t64](https://packages.ubuntu.com/libssl3t64)
- [Ubuntu: pakiety FreeRDP 3](https://packages.ubuntu.com/freerdp3-x11) i [FreeRDP 2 na Ubuntu 22.04](https://packages.ubuntu.com/jammy/freerdp2-x11)
- [Arch: WebKitGTK 4.1](https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/) i [FreeRDP](https://archlinux.org/packages/extra/x86_64/freerdp/)
- [AppImage: wymagania FUSE](https://github.com/AppImage/AppImageKit/wiki/FUSE)
