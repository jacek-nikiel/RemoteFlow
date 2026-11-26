# RemoteFlow

[English](README.md) | **Polski**

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/nikieljacek)

RemoteFlow to desktopowy **menedżer połączeń SSH, SFTP i RDP dla systemów Windows i Linux**, inspirowany mRemoteNG. Łączy zdalne terminale, pulpity, przesyłanie plików i tunele SSH w jednym obszarze roboczym z zakładkami i podziałem ekranu.

Pozwala organizować hosty w zagnieżdżone grupy, korzystać ze wspólnych profili poświadczeń i przełączać aktywne sesje bez otwierania osobnych okien klientów. Konfiguracje połączeń, hasła i zapisane klucze prywatne są przechowywane w lokalnym, zaszyfrowanym sejfie chronionym hasłem głównym (Master Password).

Aplikacja wykorzystuje **Tauri 2 i Rust** jako natywny backend, **React 19 i TypeScript** do budowy interfejsu, **xterm.js** do terminali SSH oraz **IronRDP/WebAssembly** jako wbudowanego klienta RDP. Na Linuksie obsługuje również osadzony, natywny klient FreeRDP.

![RemoteFlow – okno główne](docs/screenshots/main.png)

## Funkcje

### Połączenia i obszar roboczy
- Interfejs po polsku i angielsku – zmiana języka w nagłówku, na ekranie logowania lub w Ustawieniach (działa od razu).
- Ciemny lub jasny motyw (Ustawienia), opcjonalnie z ciemnym terminalem w jasnym motywie.
- Drzewo połączeń z zagnieżdżonymi grupami, kolorami, wyszukiwaniem (nazwa, host, IP, tagi) i przeciąganiem. Stan rozwinięcia grup i sortowanie A–Z w wybranych grupach są zapamiętywane po restarcie.
- **Paleta poleceń** (Ctrl+K, w sesji Ctrl+Shift+K): rozmyte wyszukiwanie połączeń (nazwa, host, użytkownik, tagi, folder); Enter łączy. **Szybkie połączenie** – wpisz `ssh root@10.0.0.15:2222` albo `rdp admin@srv01`, aby połączyć się bez zapisywania (hasło zostaje tylko w pamięci); z menu karty można je potem zapisać w sejfie.
- Opcjonalne **przywracanie poprzednich sesji** po odblokowaniu (karty, układ i panele; domyślnie wyłączone).
- Menu kontekstowe grup: połączenie z hostami w grupie, dodawanie hostów i podgrup, sortowanie, edycja, usuwanie oraz rozwijanie i zwijanie wszystkich grup.
- Klonowanie zapisanej konfiguracji połączenia (po potwierdzeniu) lub otwieranie kolejnej sesji tego samego połączenia.
- Zakładki i podział ekranu: pojedynczy, poziomy, pionowy, 3 kolumny i siatka 2×2. Zmiana kolejności zakładek przeciąganiem lub z menu zakładki (na początek/koniec, w lewo/w prawo) bez przerywania połączenia; przeciąganie zakładek między panelami i wybór sesji dla każdego panelu.
- Przyciski przewijania zakładek i przeszukiwalna lista otwartych sesji ze ścieżką grupy, danymi hosta i stanem połączenia. Długie etykiety przewijają się, odsłaniając zawartość.
- Wspólne profile poświadczeń używane przez wiele połączeń.
- Przy logowaniu hasłem, jeśli hasło jest puste, wybór między próbą połączenia bez hasła a wprowadzeniem i zapisaniem hasła dla danego połączenia.
- Małe okna potwierdzenia przy wskazanym połączeniu lub zakładce; pytania o zamknięcie sesji i programu można wyłączyć w Ustawieniach.

### SSH
- Wbudowany terminal (xterm.js) z pełną paletą 16 kolorów – `mc`, `htop` i podobne narzędzia wyświetlają się poprawnie. Regulowany bufor historii (Ustawienia → Terminal SSH, domyślnie 10 000 linii), przewijany także po zakończeniu połączenia.
- Uwierzytelnianie hasłem, kluczem prywatnym (z opcjonalnym pytaniem o hasło klucza), certyfikatem OpenSSH lub agentem SSH. Klucze w formacie OpenSSH (Ed25519, ECDSA, RSA – domyślny format obecnego `ssh-keygen`), także chronione hasłem, działają na Windows i Linuksie; klucze PuTTY `.ppk` trzeba wyeksportować do formatu OpenSSH. Klucz i certyfikat można wskazać jako plik (odczytywany przy każdym połączeniu – odnowiony, krótkoterminowy certyfikat jest używany automatycznie) lub wkleić. Używana jest metoda wybrana w połączeniu, bez przechodzenia do innych; połączenie bez własnego hasła/klucza korzysta z metody swojego profilu poświadczeń.
- Przekierowanie portów: lokalne, zdalne i dynamiczne (SOCKS5), z listą tuneli w każdej zakładce (stan, błędy, otwarte połączenia).
- Kopiowanie i wklejanie z menu kontekstowego i klawiatury, wklejanie zaznaczenia środkowym przyciskiem myszy.
- Przeciągnięcie plików lub katalogów na terminal (albo wklejenie skopiowanych plików Ctrl+V) wysyła je do bieżącego katalogu powłoki; postęp widać na przycisku Pliki (SFTP).
- Ctrl+L, Ctrl+B, Ctrl+R i F5 trafiają do zdalnego systemu w sesjach SSH i RDP; Ctrl+Shift+L blokuje sejf, a Ctrl+Shift+B pokazuje/ukrywa pasek boczny wszędzie.
- Weryfikacja klucza serwera przy pierwszym połączeniu (TOFU) – hasło jest wysyłane tylko do zaufanego serwera.

### SFTP – dwupanelowy menedżer plików
- Pliki lokalne po lewej, pliki serwera po prawej (jak w WinSCP / FileZilla); okno zajmuje połowę panelu, a przy podzielonym ekranie cały panel.
- Zaznaczanie wielu elementów (klik, Ctrl, Shift, Ctrl+A) i wysyłanie / pobieranie plików oraz całych katalogów jednym kliknięciem.
- Klawiatura: Ctrl+R odświeża używany panel (oba, gdy fokus jest w innym miejscu okna), Backspace – katalog nadrzędny, Enter – otwarcie katalogu, **F2 – zmiana nazwy**, Delete – usunięcie (na serwerze trwale, na tym komputerze do kosza), Esc – zamknięcie okna.
- **Przenoszenie** plików i katalogów do innego katalogu (okno albo przeciągnięcie na katalog w tym samym panelu) oraz zmiana **uprawnień (chmod)** na serwerze – pola wyboru albo zapis ósemkowy, opcjonalnie rekurencyjnie (wszystko / tylko pliki / tylko katalogi). Istniejące pliki nigdy nie są nadpisywane.
- Przeciąganie między panelami, na katalogi oraz z systemowego menedżera plików.
- Filtrowanie i wyszukiwanie w podkatalogach po obu stronach, tworzenie i usuwanie katalogów i plików po obu stronach (nowy pusty plik otwiera się od razu w edytorze). Pliki lokalne trafiają do Kosza (Windows) / kosza pulpitu (Linux); gdy kosz jest niedostępny (np. dysk sieciowy), program pyta o trwałe usunięcie.
- Postęp transferów (pliki i ilość przesłanych danych) z przyciskiem **Przerwij**. Pliki są zapisywane do pliku tymczasowego obok docelowego (`.nazwa.rf-part`) i zastępują istniejący plik dopiero po przesłaniu w całości – w obie strony – więc przerwany lub nieudany transfer nigdy nie zostawia uciętego pliku, a istniejący plik zachowuje poprzednią zawartość (i uprawnienia na serwerze). Pytanie o nadpisanie i menu kontekstowe. Usuwanie z serwera pokazuje aktualną ścieżkę i licznik zaznaczonych pozycji, a następnie wynik lub błąd; katalogi są usuwane wraz z zawartością.
- **Podgląd i edycja plików** po obu stronach – jak w Total Commanderze: **F3** podgląd (tylko do odczytu, przycisk „Edytuj” odblokowuje zmiany, ponowne F3 zamyka), **F4** edycja; także ikona oka i menu kontekstowe: tekst z numerami wierszy, wyszukiwaniem (Ctrl+F) i wyborem kodowania (UTF-8, Windows-1250, ISO-8859-2, Latin-1, UTF-16), widok **HEX** dla plików dowolnej wielkości (wczytywanych fragmentami, z przejściem do offsetu) oraz obrazy. Pliki tekstowe do 5 MB można edytować i zapisać (Ctrl+S) – kodowanie, BOM, końce wierszy (LF/CRLF) i uprawnienia zostają zachowane, a zapis przez plik tymczasowy nie zostawia uciętego pliku. Jeśli plik zmienił się od otwarcia, program pyta przed nadpisaniem. Pliki z serwera są czytane przez to samo połączenie SFTP, bez zapisywania na dysku.
- Katalogi startowe zapamiętywane osobno dla każdego połączenia (lokalny i na serwerze); domyślnie otwierane są katalogi domowe.
- Przycisk „katalog z terminala”: panel serwera przechodzi do katalogu, w którym jesteś w terminalu SSH (także w zagnieżdżonej powłoce i gdy działa w niej program; nic nie jest wpisywane do terminala). Serwery Linux (`/proc`); na innych systemach używany jest katalog zgłaszany przez powłokę (OSC 7), jeśli jest dostępny.

### RDP
- Wbudowany klient RDP (IronRDP skompilowany do WebAssembly) działający przez lokalne proxy – rozdzielczość automatycznie dopasowuje się do okna, ostro także przy skalowaniu ekranu (4K, 150–200%: pełna rozdzielczość i współczynnik skalowania dla serwera, jak w kliencie Microsoft).
- TLS z przypinaniem certyfikatu; automatyczne przejście na systemowy stos TLS (Schannel / OpenSSL) dla starszych serwerów, np. Windows Server 2012.
- Konta domenowe: `użytkownik` + pole „Domena”, `DOMENA\użytkownik`, UPN `użytkownik@domena.local` lub `.\konto` dla konta lokalnego – tak samo dla wbudowanego klienta, FreeRDP i mstsc.
- Schowek tekstowy w obie strony. Na Windows pliki skopiowane w sesji zdalnej można od razu wkleić w Eksploratorze (i odwrotnie); na Linuksie pliki są wymieniane przez folder współdzielony. Schowek można wyłączyć dla wybranego połączenia (dotyczy wbudowanego klienta, FreeRDP i mstsc). Dyski lokalne i katalog domowy nigdy nie są udostępniane serwerowi – FreeRDP udostępnia tylko wydzielony folder wymiany `~/RemoteFlow_Shared`.
- Linux: opcjonalnie **FreeRDP w oknie aplikacji** (Ustawienia → Klient RDP) – natywny klient (wiele wątków, H.264) rysuje sesję w zakładce RemoteFlow; wymaga X11 (na Wayland program uruchamia się wtedy przez XWayland) i `xfreerdp3`.
- Panel statystyk wydajności w oknie RDP (przepustowość, aktualizacje ekranu, czas rysowania, obciążenie wątku głównego).
- Opcjonalne uruchomienie systemowego klienta (`mstsc` na Windows, FreeRDP na Linuksie – z potokiem graficznym `/gfx` i `/network:auto`; szybszy od wbudowanego klienta przy wideo lub intensywnym przewijaniu).

### Bezpieczeństwo
- Sejf szyfrowany **AES-256-GCM**, klucz wyprowadzany z Master Password algorytmem **Argon2id**.
- Format v3 szyfruje również nazwy i adresy połączeń, użytkowników, notatki, grupy oraz zaufane tożsamości serwerów. Publiczny nagłówek z ustawieniami odblokowania, interfejsu i kopii jest chroniony HMAC. Starszy sejf jest kopiowany i migrowany po poprawnym odblokowaniu; istniejące kopie zachowują swój format. Sejf v3 wymaga wersji aplikacji 1.6.1 lub nowszej.
- Kontrola integralności całego pliku sejfu **HMAC-SHA256** – zmiany wprowadzone poza aplikacją są wykrywane.
- Szybkie odblokowanie kodem PIN (klucz główny zabezpieczony PIN-em istnieje wyłącznie w pamięci).
- Automatyczna blokada po bezczynności i po zablokowaniu systemu operacyjnego (Windows, Linux logind / ScreenSaver).
- Niedokończona edycja połączenia zostaje zachowana podczas blokady i można ją zapisać po odblokowaniu PIN-em lub hasłem głównym.
- Okresowe kopie zapasowe sejfu i przywracanie z Ustawień.
- FreeRDP jest przypięty do certyfikatu serwera zapisanego w sejfie (zapamiętywanego przy pierwszym połączeniu, wspólnego z wbudowanym klientem). Konflikt certyfikatu FreeRDP otwiera komunikat z odciskiem SHA-256 do sprawdzenia u administratora. Po jawnej akceptacji można połączyć się ponownie z zaakceptowanym certyfikatem, bez wyłączania weryfikacji i usuwania wspólnego magazynu certyfikatów FreeRDP.
- Eksport i import chroniony hasłem w formacie `.rfvault`: wszystkie połączenia lub wybrane grupy wraz z podgrupami i odpowiednimi profilami poświadczeń. Połączenia bez grupy można dołączyć osobno. Opcjonalny eksport do jawnego JSON wymaga wyraźnego potwierdzenia.

<img src="docs/screenshots/login.png" alt="RemoteFlow – ekran logowania" width="600">

### Import z mRemoteNG
- Import pliku `confCons.xml` razem z folderami i **hasłami** (AES-GCM i starszy AES-CBC, także pliki w pełni zaszyfrowane).
  Hasła są odszyfrowywane wyłącznie w backendzie Rust i od razu szyfrowane kluczem sejfu.

## Pobieranie

Gotowe wersje są publikowane na stronie [Releases](https://github.com/jacek-nikiel/RemoteFlow/releases): instalator Windows (`.exe`, `.msi`), paczki Linux (`.AppImage`, `.deb`, `.rpm`, Arch Linux `.pkg.tar.zst`) oraz wersje przenośne bez instalatora: `remoteflow_X.Y.Z_x64-portable.exe` (Windows) i `remoteflow_X.Y.Z_amd64-portable` (Linux). Są budowane z tego repozytorium przez GitHub Actions ([workflow wydań](.github/workflows/release.yml)) – log budowania każdego wydania jest publiczny.

### Aktualizacje
Program sprawdza stronę wydań przy uruchomieniu i raz dziennie i proponuje nową wersję wraz z listą zmian (*Ustawienia → Aktualizacje*: wyłączenie automatycznego sprawdzania lub sprawdzenie od razu). Każda paczka aktualizacji jest podpisana; program instaluje tylko paczki podpisane kluczem projektu, którego część publiczna jest w [`tauri.conf.json`](src-tauri/tauri.conf.json) (`plugins.updater.pubkey`). Windows i AppImage aktualizują się na miejscu; `.deb` / `.rpm` są instalowane przez `pkexec` (pytanie o hasło administratora). Paczkę Arch Linux aktualizuje się przez pacman: program informuje o nowej wersji i otwiera stronę wydań (`sudo pacman -U ./remoteflow-X.Y.Z-1-x86_64.pkg.tar.zst`). Kopia przenośna (sam plik programu bez instalatora, np. na pendrivie, albo ze znacznikiem `remoteflow.portable`) nie uruchamia instalatora: pobiera podpisaną wersję przenośną, zastępuje nią swój plik w tym samym folderze i uruchamia się ponownie (od wersji 1.14.0; folder musi być zapisywalny).
Wymagania: Windows 10/11 x64 ze środowiskiem Microsoft Edge WebView2 Runtime lub Linux z WebKitGTK 4.1 i GTK 3. Osadzanie natywnego klienta RDP na Linuksie wymaga dodatkowo FreeRDP i X11/XWayland.

**Dla użytkowników Linuksa:** przygotowano [listę pakietów i polecenia instalacji](docs/LINUX.pl.md) dla Ubuntu i CachyOS/Arch, wraz z opcjonalnym FreeRDP, oknami wyboru plików i wymaganiami AppImage. To osobna lista od zależności do kompilacji opisanych poniżej.

Linux: jeśli okno miga, jest puste albo w konsoli pojawia się `DRM_IOCTL_MODE_CREATE_DUMB failed` / `Failed to create GBM buffer`, przełącz *Ustawienia → Motyw kolorystyczny → Renderowanie okna (Linux)* na *Zgodne* (albo uruchom raz `REMOTEFLOW_SAFE_RENDERING=1 remoteflow`).

## Budowanie ze źródeł

### Wymagania
- [Node.js](https://nodejs.org/) **20.19+ lub 22.12+** (wymagane przez Vite 8)
- [Rust](https://rustup.rs/) (stabilny, z obsługą edycji 2024)
- Windows: Visual Studio C++ Build Tools (instalator Rusta proponuje ich instalację)
- Linux (Debian/Ubuntu):
  ```bash
  sudo apt install build-essential pkg-config file patchelf libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
  ```
- Linux – zalecane w czasie działania: `wl-clipboard` (Wayland) lub `xclip` (X11) – niezawodne kopiowanie do schowka systemowego (np. haseł).

### Polecenia
```bash
npm ci
npm run tauri dev      # tryb deweloperski
npm run tauri build    # wersja produkcyjna + instalatory
```
Wynik:
- Windows – `src-tauri/target/release/remoteflow.exe`, instalatory w `src-tauri/target/release/bundle/nsis` i `bundle/msi`
- Linux – `src-tauri/target/release/remoteflow`, pakiety w `src-tauri/target/release/bundle/` (`.deb`, `.rpm`, `.AppImage`)

Na Windows można też użyć `run-windows.bat` (tryb deweloperski) i `build-windows.bat` (wersja produkcyjna).

### Wersja Linux w Dockerze (także z Windows)
```bash
docker build -f docker/Dockerfile.linux --target export --output type=local,dest=dist-linux .
```
albo po prostu uruchom `build-linux-docker.bat` na Windows. Pakiety trafią do folderu `dist-linux/`.

### Ikona i skrót dla wersji portable na Linuksie
Wersja portable nie dodaje automatycznie wpisu do menu systemowego. W paczce z Dockera znajdują się także `install-linux-desktop.sh` i `remoteflow.png`. Zachowaj je obok programu i uruchom bez `sudo`:
```bash
bash ./install-linux-desktop.sh
```
Dla AppImage lub programu w innym katalogu podaj jego ścieżkę:
```bash
bash ./install-linux-desktop.sh "/pełna/ścieżka/RemoteFlow.AppImage"
```
Plik programu musi mieć prawo wykonywania. Skrypt zapisuje skrót i ikonę w `${XDG_DATA_HOME:-$HOME/.local/share}`. Nie przenosi programu ani sejfu. Następnie uruchom RemoteFlow z menu aplikacji; stary przypięty skrót usuń i przypnij ponownie. Po przeniesieniu programu uruchom skrypt ponownie. Aby usunąć integrację, usuń pliki `applications/remoteflow.desktop` i `icons/hicolor/512x512/apps/remoteflow.png` z tego katalogu.

### Testy
```bash
node scripts/check-i18n.mjs   # każdy tekst interfejsu ma tłumaczenie angielskie
npm run build                # ścisła kontrola TypeScript i produkcyjna kompilacja interfejsu
python3 scripts/test-linux-desktop.py # integracja portable z pulpitem (Linux)
cd src-tauri
cargo check --all-targets     # diagnostyka kompilatora dla bieżącego systemu
cargo test --lib              # testy jednostkowe
cargo test --lib -- --ignored # testy integracyjne (wymagają lokalnych serwerów testowych SSH/RDP)
```
Kompilację i testy jednostkowe Linuksa można uruchomić także na Windows przez Docker:
```bash
docker build -f docker/Dockerfile.linux --target verify .
```

## Gdzie są moje dane?
Sejf (`vault.json`) jest przechowywany w katalogu konfiguracji użytkownika: `%APPDATA%\remoteflow` na Windows,
`~/.config/remoteflow` na Linuksie. Aktualizacja ani odinstalowanie programu go nie usuwa.

**Tryb przenośny** (np. na pendrive): umieść obok pliku programu pusty plik o nazwie `remoteflow.portable` (dla AppImage
– obok pliku `.AppImage`); nowy sejf powstanie wtedy w tym folderze. Plik `vault.json`, który już leży obok pliku
programu, jest zawsze używany – także utworzony tam przez wersje sprzed 1.13.2.
Kopie zapasowe trafiają do folderu `backups` obok sejfu albo do innego folderu wybranego w *Ustawienia → Kopie zapasowe sejfu*.
Poza zaszyfrowanym sejfem bez szyfrowania zapisywane są tylko ustawienia niezawierające poufnych danych: opcje
renderowania okna (`display.json` obok sejfu) i preferencje interfejsu, np. język, motyw, szerokość panelu i rozwinięte
grupy (pamięć przeglądarki wbudowanej). Pliki wymieniane z sesjami RDP na Linuksie trafiają do `~/RemoteFlow_Shared`.

## Stos technologiczny
| Warstwa | Technologie |
|---|---|
| Powłoka aplikacji | Tauri 2, WebView2 (Windows) / WebKitGTK (Linux) |
| Backend | Rust 2024, tokio, ssh2 (libssh2), ssh-key, rustls + native-tls, tokio-tungstenite, ironrdp-rdcleanpath, tauri-plugin-updater |
| Kryptografia | argon2, aes-gcm, hmac + sha2, zeroize |
| Interfejs | React 19, TypeScript, Vite 8, Tailwind CSS 4, lucide-react |
| Terminal / RDP | xterm.js 6, IronRDP (WebAssembly), opcjonalnie FreeRDP na Linuksie i systemowe klienty RDP |
| Zależne od systemu | clipboard-win (Windows), zbus / GTK (Linux) |

## Wersjonowanie
Projekt stosuje [wersjonowanie semantyczne](https://semver.org/lang/pl/). Każda zmiana podnosi co najmniej numer poprawki –
zobacz [CHANGELOG.pl.md](CHANGELOG.pl.md) (po angielsku: [CHANGELOG.md](CHANGELOG.md)). Wersja jest zapisana w `package.json`, `src-tauri/tauri.conf.json` i
`src-tauri/Cargo.toml` (test jednostkowy sprawdza ich zgodność) i jest wyświetlana obok logo oraz na ekranie logowania.

## Wydania (dla opiekuna projektu)
Jednorazowo:
1. Wygeneruj klucz podpisu aktualizacji na swoim komputerze (klucza prywatnego nigdy nie dodawaj do repozytorium):
   ```bash
   npx tauri signer generate -w ~/.tauri/remoteflow.key        # Windows: -w %USERPROFILE%\.tauri\remoteflow.key
   ```
2. Treść pliku `remoteflow.key.pub` wpisz do `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
3. W GitHubie → *Settings → Secrets and variables → Actions* dodaj `TAURI_SIGNING_PRIVATE_KEY` (treść pliku `remoteflow.key`) i `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Każde wydanie:
```bash
git tag v1.2.3            # musi odpowiadać wersji w package.json; CHANGELOG.md i CHANGELOG.pl.md muszą mieć sekcję „## 1.2.3 – …”
git push origin v1.2.3
```
GitHub Actions buduje wersje Windows i Linux, podpisuje paczki aktualizacji i tworzy **szkic** wydania z opisem z obu plików CHANGELOG (angielskim i polskim; okienko aktualizacji w programie pokazuje część w języku interfejsu). Sprawdź go i kliknij *Publish* – od tej chwili program proponuje aktualizację.
Utrata klucza prywatnego oznacza, że zainstalowane kopie nie zweryfikują nowych aktualizacji (użytkownicy musieliby ręcznie zainstalować nową wersję) – zrób kopię zapasową klucza.

## Bezpieczeństwo
Zgłaszanie podatności: zobacz [SECURITY.md](SECURITY.md).

## Wsparcie projektu
RemoteFlow jest darmowy i ma otwarty kod, rozwijany po godzinach. Jeśli oszczędza Ci czas, możesz wesprzeć dalszy rozwój:
**[buymeacoffee.com/nikieljacek](https://buymeacoffee.com/nikieljacek)** – dziękuję! Zgłoszenia błędów i pomysły w [Issues](https://github.com/jacek-nikiel/RemoteFlow/issues) pomagają równie mocno.

## Licencja
[MIT](LICENSE) © 2026 Jacek Nikiel
