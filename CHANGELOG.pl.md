# Historia zmian – RemoteFlow

🇬🇧 [English version](CHANGELOG.md)

Numer wersji: `MAJOR.MINOR.PATCH`. Każda zmiana podnosi co najmniej numer PATCH.
Wersja jest zapisana w trzech plikach, które muszą być zgodne (pilnuje tego test `version_tests` w `src-tauri/src/lib.rs`):
`package.json` (wyświetlana w aplikacji), `src-tauri/tauri.conf.json` (instalator) i `src-tauri/Cargo.toml`.

Każde wydanie ma sekcję dla tej samej wersji (`## X.Y.Z – …`) w tym pliku i w angielskim `CHANGELOG.md`; obie trafiają do opisu
wydania, a okienko aktualizacji w programie pokazuje tę w języku interfejsu.

## 1.16.1 – ostry obraz RDP przy skalowaniu ekranu
- **Poprawka: rozmyty obraz RDP przy skalowaniu ekranu** (np. ekrany 4K, skalowanie Windows 150–200%). W trybie „Dopasuj do okna (Auto)” program prosił serwer o pulpit w pikselach po skalowaniu (ok. 1920 × 1080 na ekranie 4K przy 200%) i rozciągał go na ekran. Teraz pulpit ma pełną rozdzielczość ekranu, a serwer dostaje współczynnik skalowania (Display Control) – tekst ma tę samą wielkość, ale jest ostry, jak w kliencie Microsoft. Obraz jest też wyświetlany piksel w piksel przy każdym skalowaniu (także 100%): wcześniej był rozciągany o ułamek procenta, żeby wypełnić obszar, co rozmywało tekst. Przełącznik „Dopasuj / 100%” to teraz dwa przyciski z zaznaczonym aktywnym trybem (wcześniej jeden przycisk pokazywał bieżący tryb i łatwo go było wziąć za akcję) i jest widoczny tylko przy stałej rozdzielczości (w trybie Auto oba wyglądały tak samo). „Dopasuj” skaluje pulpit do okna, także w górę (mniejsza rozdzielczość była tylko wyśrodkowana); „100% (1:1)” to jeden piksel zdalny na jeden piksel ekranu (przy 200% był dwukrotnie powiększony). Przeniesienie okna na monitor z innym skalowaniem aktualizuje pulpit. Stałe rozdzielczości z listy bez zmian.

## 1.16.0 – paczka Arch Linux, poprawka zapisu ustawień, F3 zamyka podgląd
- **Poprawka: nie dało się zapisać ustawień z domyślnym buforem historii terminala.** Pole przyjmowało tylko wartości typu 9100 lub 10 100 (krok 1000 liczony od minimum 100), więc domyślne 10 000 blokowało przycisk Zapisz komunikatem „wprowadź prawidłową wartość”. Teraz krok wynosi 100.
- **SFTP: ponowne F3 zamyka podgląd** (jak w listerze Total Commandera) – dla pliku otwartego tylko do odczytu (F3, ikona oka). Podczas edycji F3 nic nie robi; Esc nadal zamyka w obu przypadkach.
- **Paczka Arch Linux** (`remoteflow-X.Y.Z-1-x86_64.pkg.tar.zst`) w wydaniach, instalowana poleceniem `sudo pacman -U`. Buduje ją workflow wydań z tego samego programu co pozostałe paczki Linux (`scripts/build-arch-pkg.sh`, także w budowaniu przez Dockera), w kroku bez dostępu do klucza podpisującego. Program rozpoznaje instalację z pacmana (także paczkę z AUR) i nie aktualizuje się sam – okienko aktualizacji otwiera stronę wydań zamiast próbować instalacji .deb/.rpm. Pomysł: [9M2PJU](https://github.com/9M2PJU).
- Trzy pozostałe teksty PL/EN zapisane na sztywno (nazwa kopii, błąd zakresu eksportu, anulowane połączenie) idą teraz przez tłumaczenia – dzięki [9M2PJU](https://github.com/9M2PJU).
- **Opis aktualizacji w Twoim języku:** opis wydania zawiera część angielską i polską, a okienko aktualizacji pokazuje tę w języku interfejsu (gdy jej brak – angielską). Wersje do 1.15.1 przy aktualizacji do tej wersji pokażą jeszcze obie części.
- Workflow wydań: akcje GitHub zaktualizowane do wersji działających na Node.js 24 (checkout v5, setup-node v5, github-script v8).

## 1.15.1 – SFTP: F3 podgląd, F4 edycja; poprawka Ctrl+Z w edytorze
- **SFTP: F3 – podgląd, F4 – edycja** (jak w Total Commanderze / Midnight Commanderze). F3 i ikona oka otwierają plik tylko do odczytu – przypadkowe naciśnięcie klawisza nic nie zmieni; przycisk **Edytuj** (albo F4) w podglądzie odblokowuje zmiany bez ponownego otwierania pliku. F4 otwiera plik od razu do edycji z kursorem w tekście. Menu kontekstowe ma osobne pozycje „Podgląd (F3)” i „Edytuj (F4)”; nowy plik otwiera się do edycji. Wcześniej oba klawisze robiły to samo.
- **Poprawka: Ctrl+Z w edytorze nie cofa już wczytania pliku.** Kilkukrotne Ctrl+Z po otwarciu pliku mogło wyczyścić cały tekst (cofnięcie „wczytania”), a zapis zapisałby pusty plik.

## 1.15.0 – SFTP: podgląd i edycja plików, nowy plik, usuwanie lokalne do Kosza
- **SFTP: nowy plik** – przycisk w pasku panelu i pozycja „Nowy plik” w menu kontekstowym, po obu stronach (na serwerze i na tym komputerze). Tworzy pusty plik (nigdy nie nadpisuje istniejącego) i od razu otwiera go w edytorze.
- **SFTP: podgląd i edycja plików** po obu stronach – **F3**/**F4**, ikona oka w pasku panelu albo „Podgląd i edycja” w menu kontekstowym (podwójne kliknięcie nadal przesyła plik).
  - **Tekst:** edytor CodeMirror z numerami wierszy, wyszukiwaniem i zamianą (Ctrl+F), cofaniem, zawijaniem wierszy; kodowanie rozpoznawane automatycznie (UTF-8, BOM, UTF-16, w pozostałych przypadkach Windows-1250) i do zmiany ręcznie (także ISO-8859-2, Windows-1252).
  - **Edycja i zapis (Ctrl+S)** plików tekstowych do 5 MB: kodowanie, BOM, końce wierszy (LF/CRLF/CR) i uprawnienia zostają; zapis przez plik tymczasowy zastępujący oryginał dopiero w całości (na serwerze ten sam kod co wysyłanie, lokalnie z zachowaniem dowiązań); program sprawdza, czy plik nie zmienił się od otwarcia (rozmiar i czas modyfikacji) i pyta przed nadpisaniem; znak spoza kodowania pliku blokuje zapis z komunikatem; zamknięcie z niezapisanymi zmianami pyta o zapis.
  - Większe pliki tekstowe – tylko podgląd, wczytywane po 1 MB.
  - Przyciski w nagłówku podglądu nie przesuwają się przy przełączaniu Tekst / HEX / Obraz.
  - **HEX:** offset, 16 bajtów w wierszu, kolumna ASCII; pliki dowolnej wielkości czytane fragmentami po 64 KB podczas przewijania, przejście do offsetu, podgląd wartości bajtu.
  - **Obrazy** (PNG, JPG, GIF, WebP, BMP, ICO, SVG do 20 MB; SVG w `<img>`, bez uruchamiania skryptów).
  - Backend: polecenia `preview_stat`, `preview_read` (surowe bajty, maks. 4 MB na fragment), `preview_save` (treść jako surowe ciało żądania). Edytor ładuje się dopiero przy pierwszym użyciu.
  - Testy: odczyt fragmentów, zapis z zachowaniem uprawnień i dowiązania, wykrywanie zmian (lokalnie i – test e2e – na serwerze SFTP).
- **SFTP: usuwanie plików i katalogów na tym komputerze.** Lewy panel ma przycisk kosza, obsługuje klawisz **Delete** i pozycję „Przenieś do kosza” w menu kontekstowym (wcześniej tylko po stronie serwera). Pliki trafiają do Kosza systemu Windows / kosza pulpitu na Linuksie (freedesktop), więc można je przywrócić. Na Windows przeniesienie do Kosza wykonuje systemowy PowerShell (API powłoki Windows), a nie sam program – wykonane bezpośrednio przez nowy, niepodpisany program było blokowane przez antywirusy behawioralne jako zachowanie ransomware (F-Secure DeepGuard: *CryptoRansomwareBehavior*). Kosz jest używany tylko na dyskach stałych – na dysku sieciowym czy wymiennym program pyta o trwałe usunięcie. Gdy kosz jest niedostępny (np. dysk sieciowy lub nośnik bez kosza), program pyta osobno o trwałe usunięcie pozostałych elementów. Dowiązanie symboliczne jest usuwane samo – jego cel nigdy. Folderu domowego, katalogu głównego ani ścieżek względnych nie da się usunąć.
- Test: trwałe usuwanie (z dowiązaniem do folderu poza usuwanym katalogiem) i blokada folderu domowego / katalogu głównego.

## 1.14.0 – wersja przenośna w wydaniach i jej samodzielna aktualizacja, odmiana liczebników
- **Wersja przenośna w wydaniach i jej aktualizacja.** Workflow wydań publikuje także sam plik programu bez instalatora: `remoteflow_X.Y.Z_x64-portable.exe` (Windows) i `remoteflow_X.Y.Z_amd64-portable` (Linux), podpisane kluczem aktualizacji i dopisane do `latest.json` (`windows-x86_64-portable`, `linux-x86_64-portable`). Kopia przenośna pobiera tę wersję zamiast instalatora, sprawdza podpis, zastępuje swój plik w tym samym folderze (Windows: stary plik zostaje jako `remoteflow.exe.old` i jest usuwany przy następnym uruchomieniu) i uruchamia się ponownie. Gdy folder jest tylko do odczytu albo wydanie nie ma wersji przenośnej, okienko odsyła do strony wydań. Kopia przenośna 1.13.3 widzi już tę wersję na stronie wydań; samodzielna podmiana działa od tej wersji.
- AppImage z plikiem `remoteflow.portable` obok jest aktualizowany jak zwykły AppImage (podmiana pliku `.AppImage`).
- Testy: rozpoznawanie sposobu instalacji, podmiana pliku programu (z zachowaniem prawa wykonywania).
- **Poprawna odmiana liczebników po polsku.** Liczniki i komunikaty z liczbą używały zawsze formy „5 elementów” – także „1 elementów” czy „4 elementów”. Teraz program dobiera formę do liczby (1 element, 2–4 elementy, 5 elementów, 22 elementy, 12 elementów). Dotyczy stopki i komunikatów menedżera SFTP, przesyłania plików przez terminal, licznika hostów, folderów i tuneli w drzewie połączeń, listy połączeń na ekranie powitalnym, importu i eksportu oraz pytań o zamknięcie kart. Po angielsku: „1 item” zamiast „1 items”.
- Nowa funkcja `tn(liczba, [forma1, forma2–4, forma5+])` w `src/i18n`; `scripts/check-i18n.mjs` sprawdza też tłumaczenia wszystkich form.
- Nowe zrzuty ekranu w README i wiki (wersja 1.13.3).

## 1.13.3 – potwierdzenie klonowania, aktualizacje kopii przenośnych
- Pierwsze wydanie dostarczane przez wbudowany aktualizator (z wersji 1.13.2) – sprawdzenie całego łańcucha: wykrycie nowej wersji, pobranie, weryfikacja podpisu, instalacja i ponowne uruchomienie.
- **Kopie przenośne nie uruchamiają instalatora.** Aktualizator instalował nową wersję instalatorem także wtedy, gdy program działał jako luźny plik `remoteflow.exe` (np. z pendrive’a) – na Windows powstawała wtedy druga, osobna kopia w folderze instalacji, a uruchamiany plik zostawał stary. Teraz program rozpoznaje sposób instalacji: instalator NSIS (`uninstall.exe` obok programu), MSI (folder Program Files), AppImage, pakiet `.deb`/`.rpm` (`/usr/`). Pozostałe kopie – oraz każda ze znacznikiem `remoteflow.portable` – dostają w okienku aktualizacji przycisk „Pobierz nową wersję” (strona wydań w przeglądarce) i wskazówkę, by zastąpić plik programu. Uwaga: dotyczy to kopii od wersji 1.13.3 – w przenośnej 1.13.2 nie używaj „Zainstaluj”.
- **Potwierdzenie przy klonowaniu połączenia.** „Klonuj połączenie” w menu połączenia pokazuje przy nim okienko z nazwą i adresem połączenia oraz informacją, że kopia obejmie zapisane dane logowania i tunele; kopia powstaje dopiero po „Klonuj”.
- `.gitignore`: folder `Claude outputs/` (pliki zapisywane przez aplikację Claude) nie trafia do repozytorium.
- README: sekcja „Wsparcie projektu” z linkiem do Buy Me a Coffee.

## 1.13.2 – sejf w katalogu konfiguracji użytkownika
- **Nowy sejf jest zawsze tworzony w katalogu konfiguracji użytkownika** (`%APPDATA%\remoteflow` na Windows, `~/.config/remoteflow` na Linuksie). Wcześniej powstawał obok pliku programu, jeśli ten folder był zapisywalny – przy instalatorze Windows „dla bieżącego użytkownika” był to katalog instalacji programu.
- **Tryb przenośny na życzenie:** pusty plik `remoteflow.portable` obok pliku programu (dla AppImage – obok pliku `.AppImage`) sprawia, że nowy sejf powstaje w tym folderze.
- **Istniejące sejfy się nie przenoszą:** `vault.json` leżący obok pliku programu (tryb przenośny albo utworzony przez wcześniejsze wersje) jest nadal używany, podobnie sejf w katalogu konfiguracji. Kolejność: obok programu → katalog konfiguracji → katalog roboczy (najstarsze wersje).
- AppImage: „obok programu” oznacza folder z plikiem `.AppImage` (sam program działa z zamontowanego obrazu tylko do odczytu).
- Test: reguły wyboru miejsca sejfu (nowy sejf, istniejący obok programu, w katalogu konfiguracji, w katalogu roboczym, znacznik trybu przenośnego).

## 1.13.1 – przegląd bezpieczeństwa przed publikacją kodu
- **RDP przez FreeRDP nie udostępnia już katalogu domowego.** Do sesji przekazywana była opcja `+home-drive`, która dawała serwerowi zdalnemu (czyli każdemu serwerowi, z którym się łączysz) dostęp do odczytu i zapisu całego katalogu domowego – kluczy SSH, sejfu, dokumentów. Teraz udostępniany jest tylko wydzielony folder wymiany `~/RemoteFlow_Shared`.
- **Plik `.rdp` do pobrania (dla mstsc) nie udostępnia dysków lokalnych** (`redirectdrives:i:0`; wcześniej `1` – wszystkie dyski komputera były widoczne na serwerze). Plik tymczasowy dla mstsc uruchamianego z programu ma to samo ustawienie.
- **Opcja „Schowek” w ustawieniach RDP połączenia działa.** Wcześniej była zapisywana, ale nigdzie nie stosowana – schowek (tekst i pliki) był zawsze współdzielony. Teraz jej wyłączenie wyłącza schowek we wbudowanym kliencie (bez kanału schowka, przycisk „Pliki i schowek” nieaktywny), w FreeRDP (`-clipboard`) i w mstsc (`redirectclipboard:i:0`).
- **Sejf z katalogu roboczego** (zgodność z bardzo starymi wersjami) jest brany pod uwagę dopiero po katalogu konfiguracji użytkownika – plik `vault.json` w folderze, z którego akurat uruchomiono program (np. Pobrane), nie może zastąpić sejfu użytkownika.
- **„Otwórz folder wymiany”** otwiera wyłącznie katalogi – ścieżka do pliku nie jest przekazywana do Eksploratora / `xdg-open` (które uruchomiłyby plik wykonywalny lub skrypt).
- **Linux: katalog tymczasowy schowka plików RDP** w katalogu podręcznym użytkownika (`~/.cache/RemoteFlow`) zamiast współdzielonego `/tmp`, w którym inny użytkownik komputera mógł utworzyć go wcześniej i czytać kopiowane pliki.
- **Zależności:** aktualizacja `rustls-webpki` 0.103.17 (RUSTSEC-2026-0382 – weryfikacja certyfikatów), `libz-sys` 1.1.33 (RUSTSEC-2026-0544, RUSTSEC-2026-0418), `rustix` 1.1.6, `clipboard-win` 5.4.3 i `async-executor` 1.14.1 (wycofane wersje). `npm audit`: 0 podatności.
- **README:** dokładniejszy opis miejsca przechowywania danych (kolejność wyszukiwania sejfu, kopie, pliki niezaszyfrowane), schowka i udostępniania folderów w RDP, uzupełniony stos technologiczny; w `docs/LINUX*.md` pakiety do kopiowania do schowka (`wl-clipboard` / `xclip`).

## 1.13.0 – aktualizacje z GitHub Releases, przygotowanie do publikacji kodu
- **Automatyczne aktualizacje.** Program sprawdza wydania projektu na GitHubie przy uruchomieniu i raz dziennie. Gdy jest nowsza wersja, w prawym dolnym rogu pojawia się okienko z listą zmian (sekcja CHANGELOG) i przyciskami „Zainstaluj i uruchom ponownie”, „Później”, „Pomiń tę wersję”. Przy aktywnych połączeniach okienko ostrzega, że instalacja je zamknie. W *Ustawieniach → Aktualizacje*: wyłączenie automatycznego sprawdzania i „Sprawdź teraz”.
- **Podpisane paczki.** Instalowana jest wyłącznie paczka podpisana kluczem projektu (klucz publiczny w `tauri.conf.json`, `plugins.updater.pubkey`); paczka podmieniona na serwerze jest odrzucana („The signature verification failed”). Windows (NSIS/MSI) i AppImage aktualizują się na miejscu, `.deb`/`.rpm` przez `pkexec`.
- **Wydania z GitHub Actions** (`.github/workflows/release.yml`): tag `vX.Y.Z` → budowanie Windows i Linux na serwerach GitHuba, podpis paczek, szkic wydania z instalatorami, `latest.json` i opisem z CHANGELOG; po kliknięciu *Publish* aktualizacja trafia do użytkowników. Workflow sprawdza zgodność tagu z wersją i uruchamia testy. Opis w README („Wydania”).
- Klucz publiczny aktualizacji projektu: minisign `20074AF8B1577214`.
- `SECURITY.md` – zasady zgłaszania podatności; `.gitignore` chroni przed dodaniem klucza prywatnego.
- Testy w aplikacji: lokalny serwer z `latest.json` (wersja 9.9.9) – okienko z listą zmian, pobieranie z postępem, poprawny podpis przyjęty, podmieniona paczka odrzucona.

## 1.12.1 – SFTP: plik zastępowany dopiero po przesłaniu w całości
- **Wysyłanie na serwer:** plik jest zapisywany do pliku tymczasowego obok docelowego (`.nazwa.rf-part`) i dopiero po przesłaniu w całości zastępuje plik na serwerze. Wcześniej istniejący plik był od razu nadpisywany – przerwanie (przycisk „Przerwij”, zerwane połączenie, błąd) zostawiało plik ucięty albo usunięty. Teraz poprzednia wersja pozostaje nienaruszona do końca przesyłania, a po przerwaniu usuwany jest tylko plik tymczasowy.
- Zastępowany plik zachowuje swoje uprawnienia (np. wykonywalne skrypty). Serwery SFTP w wersji 3 (OpenSSH) nie pozwalają nadpisać pliku przez zmianę nazwy, więc stary plik jest na chwilę odsuwany (`.nazwa.rf-old`), nowy wstawiany na jego miejsce, a stary usuwany; gdy coś się nie uda, stary plik wraca na miejsce. Dowiązanie symboliczne na serwerze nie jest zamieniane na zwykły plik – aktualizowany jest plik, na który wskazuje.
- To samo dotyczy przeciągania plików do terminala SSH i wklejania ich ze schowka.
- **Pobieranie** działało już w ten sposób (plik tymczasowy `.nazwa.rf-part` w katalogu docelowym, podmiana po pobraniu w całości) – bez zmian.
- Testy z OpenSSH: przerwane wysyłanie nad istniejącym plikiem (stara zawartość bez zmian), pełne wysłanie (zawartość zastąpiona, uprawnienia 750 zachowane), wysłanie pod nazwą dowiązania, brak plików tymczasowych.

## 1.12.0 – SFTP: przerywanie wysyłania i pobierania
- **Przycisk „Przerwij”** na pasku stanu okna SFTP podczas wysyłania i pobierania plików i katalogów. Transfer zatrzymuje się po bieżącym bloku danych (128 KB); pliki przesłane wcześniej pozostają, a komunikat podaje, ile plików zdążyło się przesłać.
- **Bez częściowych plików:** przerwane pobieranie nie zapisuje niedokończonego pliku – plik o tej samej nazwie w katalogu lokalnym pozostaje nienaruszony (pobieranie i tak szło do pliku tymczasowego). Przy wysyłaniu niedokończony plik jest usuwany z serwera. Uwaga: jeśli wysyłany plik zastępował plik na serwerze, poprzednia wersja jest już nadpisana – po przerwaniu na serwerze nie ma tego pliku.
- Pasek stanu pokazuje też ilość przesłanych danych (np. „138.9 MB”), nie tylko liczbę plików.
- Testy: przerwanie wysyłania i pobierania w trakcie dużego pliku (brak pliku na serwerze, stary plik lokalny bez zmian, brak `.rf-part`), przerwanie przed startem; w aplikacji – wysyłanie i pobieranie pliku 3 GB przerwane przyciskiem.

## 1.11.3 – tunele SSH: zajęty port lokalny
- **Ponowne połączenie nie blokuje już własnych portów.** Porty lokalne tuneli (-L, -D) były zwalniane dopiero wtedy, gdy wątek tuneli zauważył zamknięcie sesji – a gdy akurat łączył się z serwerem, mogło to trwać nawet kilkadziesiąt sekund. „Połącz ponownie” (lub zamknięcie i ponowne otwarcie karty) kończyło się wtedy błędem „Tylko jedno użycie każdego adresu gniazda… (os error 10048)”. Teraz zamknięcie sesji od razu zamyka porty lokalne, a zajęty port jest przez chwilę (1,5 s) ponawiany, zanim pojawi się błąd.
- **Czytelny komunikat zamiast błędu systemu:** jeśli port używa tunel innej otwartej karty – nazwa tej karty; jeśli inny program na komputerze – informacja o tym i polecenie, którym można go znaleźć (`netstat -ano | findstr :PORT` na Windows, `ss -ltnp | grep :PORT` na Linuksie).
- Testy: zwolnienie portu od razu po zamknięciu sesji (także gdy tunele wciąż łączą się z serwerem), komunikat o porcie zajętym przez inną kartę i przez inny program; test tuneli -L/-D/-R z serwerem OpenSSH.

## 1.11.2 – SSH: klucze w formacie OpenSSH na Windows
- **Przyczyna:** wersja Windows korzysta z biblioteki libssh2 zbudowanej z kryptografią systemu Windows (WinCNG), która odczytuje tylko klucze RSA w starym formacie PEM (`BEGIN RSA PRIVATE KEY`). Klucze w formacie OpenSSH (`BEGIN OPENSSH PRIVATE KEY` – domyślny format `ssh-keygen` na Windows i Linuksie, dla RSA, Ed25519 i ECDSA) nie działały – połączenie z takim kluczem, zwłaszcza chronionym hasłem, wisiało albo kończyło się niejasnym błędem logowania.
- **Poprawka:** klucze w formacie OpenSSH są odczytywane i odszyfrowywane w RemoteFlow (bcrypt-pbkdf + AES, w pamięci, nic nie jest zapisywane na dysku). Klucz RSA jest przekazywany do libssh2 w formie, którą obsługuje każda wersja (podpis rsa-sha2-256/512); dla Ed25519 i ECDSA (P-256/384/521) podpis wykonuje RemoteFlow, a libssh2 tylko go przesyła. Działa także logowanie certyfikatem SSH z takim kluczem. Ta sama ścieżka jest używana na Linuksie.
- **Jasne komunikaty:** „Nieprawidłowe hasło klucza prywatnego (passphrase)”, brak hasła dla zaszyfrowanego klucza, klucz PuTTY `.ppk` (z instrukcją eksportu w PuTTYgen) – zamiast ogólnego „Niepowodzenie logowania”.
- **Bez zawieszania:** próba połączenia ma łączny limit czasu (50 s); jeśli logowanie nie zakończy się w tym czasie, karta pokazuje błąd zamiast wiecznego „Nawiązywanie połączenia…”.
- Testy z OpenSSH: Ed25519, RSA (OpenSSH, PEM, PKCS#8), ECDSA P-256 i P-384 chronione hasłem – poprawne i błędne hasło; certyfikat SSH z kluczem Ed25519 chronionym hasłem.
- Nadal w wersji Windows (kryptografia Windows): po stronie serwera wymagany jest klucz hosta RSA i wymiana kluczy Diffie-Hellman – patrz diagnoza z 1.11.1.

## 1.11.1 – SSH: diagnoza błędu „Unable to exchange encryption keys”
- Gdy negocjacja SSH kończy się błędem `[Session(-5)] Unable to exchange encryption keys` (serwer i RemoteFlow nie mają wspólnego algorytmu), RemoteFlow odczytuje listy algorytmów oferowanych przez serwer (osobne krótkie połączenie, tylko jawny pakiet KEXINIT przed szyfrowaniem) i dopisuje do komunikatu, w której kategorii brakuje wspólnego algorytmu – wymiana kluczy, klucz hosta, szyfr lub MAC – z listą algorytmów serwera i obsługiwanych przez RemoteFlow. Wcześniej komunikat nie mówił, czego brakuje.
- Wielowierszowe komunikaty błędów SSH wyświetlają się w terminalu poprawnie (CR+LF).
- Testy: parser KEXINIT, odczyt z serwera testowego (z liniami tekstu przed banerem) oraz test z OpenSSH ograniczonym do `KexAlgorithms sntrup761x25519-sha512@openssh.com`.

## 1.11.0 – terminal SSH: historia po rozłączeniu, regulowany bufor
- **Przewijanie historii po rozłączeniu.** Gdy połączenie kończyło się (zerwanie, zamknięcie przez serwer) w trakcie działania programu pełnoekranowego (`mc`, `vim`, `less`, `htop`, `tmux`…), terminal zostawał na ekranie alternatywnym, który nie ma historii, często z włączonym raportowaniem myszy – kółko myszy było wysyłane do zakończonej sesji zamiast przewijać. Teraz po rozłączeniu terminal wraca do zwykłego ekranu z wcześniejszą historią, raportowanie myszy i tryby programu są wyłączane, a w terminalu pojawia się informacja o zakończeniu połączenia.
- **Rozmiar bufora historii do ustawienia:** Ustawienia → Terminal SSH → „Bufor historii (liczba linii)”, od 100 do 200 000, domyślnie **10 000** (wcześniej stałe 1000 – domyślna wartość xterm.js). Zmiana działa od razu także w otwartych terminalach (zmniejszenie usuwa najstarsze linie). Ustawienie jest zapisywane w sejfie; sejfy zapisane wcześniej nie zmieniają postaci, dopóki wartość jest domyślna.
- Sprawdzone w aplikacji: `seq 1 300`, program na ekranie alternatywnym z raportowaniem myszy, zerwanie połączenia po stronie serwera → kółkiem myszy widać linie 1–300 i komunikat o zakończeniu; zmiana bufora na 100 linii od razu skraca historię otwartego terminala.

## 1.10.0 – zakładki: „Zamknij karty po prawej”
- **Nowa pozycja w menu zakładki (prawy przycisk): „Zamknij karty po prawej (N)”** – rozłącza i zamyka wszystkie zakładki na prawo od wskazanej (w bieżącej kolejności zakładek). Przy włączonym potwierdzaniu zamykania sesji pyta o zgodę z liczbą sesji; dla ostatniej zakładki pozycja jest nieaktywna. Jeśli aktywna zakładka zostaje zamknięta, aktywna staje się wskazana zakładka.
- Sprawdzone w aplikacji: 5 sesji SSH, „Zamknij karty po prawej” na drugiej → pozostają 2 sesje (2 połączenia TCP), pozostałe zakładki działają.

## 1.9.0 – certyfikat SSH CA: plik lub wklejona treść
- **Certyfikat SSH w definicji połączenia** można teraz, tak jak klucz prywatny, wskazać jako plik z dysku („Przeglądaj…” lub wpisana ścieżka, np. `~/.ssh/id_ed25519-cert.pub`) albo wkleić jego treść („Załaduj z pliku…” wypełnia pole treścią pliku).
- Plik certyfikatu jest odczytywany przy każdym połączeniu – certyfikat odnowiony przez CA (np. ważny kilka godzin) jest używany bez edycji połączenia. Jeśli pliku zabraknie, używana jest treść zapisana przy jego wyborze; gdy nie ma żadnej, połączenie kończy się komunikatem ze ścieżką pliku. Kolejność: plik połączenia → treść w połączeniu → plik profilu poświadczeń → treść w profilu.
- Okno wyboru przyjmuje tylko certyfikaty OpenSSH (`…-cert-v01@openssh.com AAAA…`, do 64 KB).
- **Poprawka (klucz prywatny i certyfikat):** ścieżka pliku jest zapisywana tylko przy wybranej opcji „Wskaż plik z dysku”. Wcześniej po przełączeniu na „Wklej treść klucza” pozostawała stara ścieżka i przy łączeniu nadal używany był plik zamiast wklejonego klucza.
- Testy: odczyt pliku przy łączeniu, odnowiony certyfikat w tym samym pliku, brak pliku / plik niebędący certyfikatem; w aplikacji: logowanie certyfikatem z pliku do serwera z `TrustedUserCAKeys`, ponowne połączenie po odnowieniu certyfikatu (nowy numer seryjny) i komunikat przy braku pliku.

## 1.8.1 – budowanie wersji Linux w Dockerze: narzędzia AppImage
- `docker/Dockerfile.linux` pobiera narzędzia AppImage (AppRun, linuxdeploy, wtyczka appimage) raz, z ponawianiem prób, do katalogu podręcznego Tauri (`~/.cache/tauri`) w osobnej warstwie obrazu. Wcześniej `tauri build` pobierał je z GitHuba przy każdym budowaniu i chwilowy błąd GitHuba (`http status: 504`) przerywał całe budowanie po skompilowaniu aplikacji.

## 1.8.0 – zakładki: zmiana kolejności bez przerywania połączeń
- **Przenoszenie zakładek połączeń.** Zakładkę można przeciągnąć w inne miejsce paska (przy krawędzi pasek sam się przewija, Esc anuluje) albo użyć menu zakładki (prawy przycisk): „Przenieś na początek”, „Przenieś w lewo”, „Przenieś w prawo”, „Przenieś na koniec”. Np. 10. zakładkę z 10 otwartych przenosi się na pozycję 1 jednym kliknięciem.
- **Połączenia nie są przerywane.** Zmienia się tylko kolejność zakładek; okna sesji (terminal, RDP, FreeRDP w oknie) pozostają zamontowane w kolejności otwarcia, więc ich elementy strony nie są przenoszone ani tworzone od nowa. Sprawdzone w aplikacji (Linux): po przeniesieniu sesji SSH zachowują zawartość terminala, sesja RDP (wbudowana i FreeRDP w oknie) – to samo połączenie TCP i ten sam proces.
- Przeciąganie zakładek działa na zdarzeniach wskaźnika zamiast HTML drag & drop – w oknie Windows (WebView2) przeciąganie między elementami strony nie działało, bo okno obsługuje upuszczanie plików z systemu (SFTP). Upuszczenie zakładki na obszar roboczy działa jak dotąd: na panel w widoku podzielonym (zamiana/przeniesienie) lub na prawą/dolną krawędź w widoku pojedynczym (podział ekranu).
- Usunięto przycisk „Podziel ekran obok siebie” z zakładek. Podział ekranu jest dostępny w menu zakładki i przyciskami układu po prawej stronie paska.

## 1.7.5 – Linux: kopiowanie do schowka
- **Kopiowanie hasła (i innych tekstów) do schowka na Linuksie** korzystało tylko ze schowka GTK okna aplikacji. W części środowisk to nie wystarcza: w sesji Wayland kompozytor może odrzucić ustawienie schowka, okno działające przez XWayland (`GDK_BACKEND=x11`, np. przy FreeRDP w oknie) zależy od synchronizacji schowka X11 przez kompozytor, a menedżer schowka może podmienić zawartość. Teraz po ustawieniu schowka GTK tekst jest dodatkowo przekazywany do systemowego narzędzia: `wl-copy` w sesji Wayland, `xclip` lub `xsel` w X11 (jeśli są zainstalowane). Odczyt schowka korzysta w razie potrzeby z `wl-paste`/`xclip`/`xsel`.
- **Bezpieczeństwo:** usunięto wywołanie `qdbus6 … klipper setClipboardContents <tekst>` – hasło trafiało do argumentów procesu i było widoczne dla innych procesów (`ps`, `/proc/PID/cmdline`). Narzędzia otrzymują tekst wyłącznie przez standardowe wejście.
- Zalecane pakiety: `wl-clipboard` (Wayland) lub `xclip` (X11). Test: zapis i odczyt przez `xclip` (X11) oraz `wl-copy`/`wl-paste` (Wayland, sway).

## 1.7.4 – RDP (wbudowany klient, Linux): klawiatura numeryczna
- **Przyczyna:** IronRDP przekazuje serwerowi stan NumLock/CapsLock/ScrollLock z `KeyboardEvent.getModifierState()` przy każdym naciśnięciu klawisza blokady. WebKitGTK (Linux) nie obsługuje modyfikatora „NumLock” i zawsze zwraca `false` (sprawdzone w WebKitGTK 2.52) – każde naciśnięcie NumLock lub CapsLock wyłączało NumLock na serwerze, a klawiatura numeryczna wysyłała Home/End/strzałki zamiast cyfr.
- **Poprawka:** stan NumLock jest odczytywany z samych zdarzeń klawiatury numerycznej (`Numpad1` → „1” = włączony, „End” = wyłączony; z Shift pomijane), przełączany klawiszem NumLock i zwracany przez `getModifierState('NumLock')` w WebKit. Przed wysłaniem klawisza numerycznego serwer jest synchronizowany, jeśli jego stan się różni (pierwszy klawisz po połączeniu zawsze synchronizuje). Na Windows (WebView2) działa tak samo, wcześniejsze zachowanie nie jest zmieniane.

## 1.7.3 – SFTP: aktualna lista po ponownym otwarciu
- **Ponowne otwarcie okna SFTP odczytuje listy plików od nowa.** Okno zachowywało zawartość z pierwszego otwarcia – zmiany wprowadzone w międzyczasie (np. w terminalu) były widoczne dopiero po ręcznym odświeżeniu. Teraz oba panele pozostają w ostatnio otwartych katalogach, a ich zawartość jest wczytywana przy każdym otwarciu okna; jeśli katalog w międzyczasie usunięto, otwierany jest katalog domowy.
- Sprawdzone w aplikacji: SFTP → zamknięcie → `touch` w terminalu → ponowne otwarcie pokazuje nowy plik.

## 1.7.2 – potwierdzenie zamknięcia nad ekranem blokady
- **Pytanie „Zamknąć RemoteFlow?” przy zablokowanej aplikacji** (PIN lub Master Password) z aktywnymi połączeniami otwierało się pod ekranem blokady (warstwa z-70 pod warstwą blokady z-200) – nie było go widać ani nie dało się go kliknąć. Teraz jest wyświetlane nad ekranem blokady (`aboveLockScreen`); po „Anuluj” fokus wraca do pola PIN / hasła. Sprawdzone w aplikacji dla blokady PIN i Master Password.
- Podpowiedź pola PIN na ekranie blokady jest tłumaczona („Enter PIN…”).

## 1.7.1 – SFTP: Ctrl+R odświeża listę
- **Ctrl+R w oknie SFTP** odświeża listę plików i katalogów w panelu, w którym pracujesz (lokalny lub serwer); gdy fokus jest poza panelami (np. w nagłówku okna) – oba panele. Działa także w polu ścieżki i filtra.
- W oknie SFTP skrót nie wykonuje już globalnego Ctrl+R (ponowne połączenie sesji) – zdarzenie jest zatrzymywane w oknie SFTP. Poza SFTP Ctrl+R/F5 działa jak dotąd.
- Podpowiedź przycisku „Odśwież” pokazuje skrót.

## 1.7.0 – SFTP: katalog z terminala
- **Nowy przycisk w panelu serwera okna SFTP** (ikona terminala obok „Katalog domowy”): przechodzi do katalogu, w którym jesteś w terminalu SSH tej karty. Zapisane katalogi startowe się nie zmieniają – żeby otwierać ten katalog domyślnie, użyj „Zapamiętaj katalogi”.
- Jak to działa: połączenie terminala otwiera krótki dodatkowy kanał i uruchamia skrypt `sh`, który wśród procesów tego samego połączenia SSH (dzieci procesu `sshd`/`sshd-session`/`dropbear`) znajduje najgłębszą powłokę i odczytuje `/proc/PID/cwd`. Nic nie jest wpisywane do terminala, działa też w zagnieżdżonej powłoce i gdy w terminalu działa program (np. `mc`, `less`). Inne sesje tego samego użytkownika nie są brane pod uwagę. Czas: ok. 0,1 s.
- Po `sudo -i`/`su` (powłoka innego użytkownika) używany jest katalog Twojej powłoki z informacją w pasku stanu. Serwery bez `/proc` (np. BSD): używany jest katalog zgłaszany przez powłokę sekwencją OSC 7, jeśli powłoka ją wysyła.
- Testy: parser wyniku, skrypt uruchamiany lokalnie oraz test e2e z serwerem SSH (zmiana katalogu, zagnieżdżona powłoka z działającym programem, dwa równoległe połączenia, brak wpisów w terminalu).

## 1.6.18 – FreeRDP w oknie: bez prześwitywania poprzedniej karty
- **Przyczyna (odtworzona w teście z przechwytywaniem klatek co ~130 ms):** natywne okno FreeRDP pojawiało się, zanim widok aplikacji zdążył narysować nową kartę RDP – przez ułamek sekundy nad wciąż widoczną kartą SSH (pasek kart i terminal) leżał pusty prostokąt, a w środowiskach z kompozytorem także jego niewyczyszczona zawartość. Poprawka 1.6.16 tylko ustawiała tło kontenera (a czyszczenie przed jego pokazaniem nie działało), nie zmieniała kolejności.
- Kontener jest teraz pokazywany dopiero gdy: (1) widok narysował kartę RDP (dwie klatki animacji + 50 ms po pokazaniu karty – także przy przełączaniu z innej karty) i (2) w kontenerze istnieje już okno FreeRDP tej sesji (rozpoznawane po `_NET_WM_PID`, bo po ponownym połączeniu X11 potrafi nadać nowemu oknu ten sam identyfikator co poprzedniemu). Do tego czasu widać planszę „Uruchamianie FreeRDP…”; gdy połączenie się nie uda, kontener w ogóle się nie pojawia.
- Tło kontenera jest ustawiane bezpośrednio w X11 (czarne), niezależnie od GDK.
- Osadzony FreeRDP kończy się razem z RemoteFlow także po awarii lub zabiciu programu (`PR_SET_PDEATHSIG`) – wcześniej zostawał osierocony proces.

## 1.6.17 – poprawki z audytu kodu
- **SSH – metoda logowania zgodna z profilem poświadczeń.** Połączenie bez własnego hasła lub klucza używa metody swojego profilu (wcześniej typ był kopiowany tylko przy wyborze profilu, więc późniejsza zmiana profilu np. na klucz psuła logowanie). Własne hasło/klucz połączenia i wybór „Agent SSH” mają pierwszeństwo. Tę samą regułę stosują backend, monit o puste hasło i pytanie o hasło klucza.
- **Agent SSH do wyboru w połączeniu** (ssh-agent, Pageant, KeePassXC/1Password). Od 1.6.1 SSH nie przechodzi już niejawnie do agenta, a tej metody nie dało się wybrać. Import z mRemoteNG ustawia agenta dla połączeń SSH bez zapisanego hasła (klucze PuTTY/Pageant).
- **FreeRDP w oknie nie zasłania wyskakujących elementów.** Sesja jest chowana, gdy na jej obszar nachodzi dowolne menu, okno dialogowe, lista lub powiadomienie (np. menu kontekstowe zakładki) – wcześniej tylko lista sesji i elementy zasłaniające ≥25% obszaru.
- **Zwykłe zakończenie sesji FreeRDP nie jest błędem.** Kody wyjścia wylogowania/rozłączenia (0–5, 11, 12) dają „Sesja RDP zakończona”; błędy (np. 131 połączenie, 132 logowanie, 143 TLS/certyfikat) – „Błąd połączenia”.
- **Nieudana kopia przed migracją do v3 nie blokuje odblokowania.** Sejf v2 otwiera się z ostrzeżeniem i jest konwertowany przy pierwszym zapisie, który ponawia kopię (bez kopii zapis jest odrzucany z czytelnym komunikatem). Test: folder kopii zablokowany plikiem.
- **Certyfikat RDP w sejfie od pierwszego połączenia FreeRDP.** Przed uruchomieniem FreeRDP certyfikat serwera jest odczytywany i zapamiętywany (TOFU, wspólne z wbudowanym klientem), więc FreeRDP jest od razu przypięty do odcisku zamiast korzystać z własnego magazynu. Gdy serwer nie odpowiada, FreeRDP sprawdza certyfikat sam.
- Komunikaty backendu przy zaufaniu certyfikatu RDP, błędnym odcisku i certyfikacie SSH są tłumaczone (PL/EN).

## 1.6.16 – tło podczas nawiązywania RDP na Linuksie
- Natywny kontener FreeRDP otrzymuje nieprzezroczyste, ciemne tło i jest czyszczony przed pokazaniem, również przy ponownym użyciu. Eliminuje to pozostawione piksele poprzedniej sesji SSH podczas inicjalizacji okna.
- Osłony ładowania RDP i obszar pulpitu mają pełne tło zgodne z motywem; wyłączono animowanie widoczności paneli podczas przełączania kart.

## 1.6.15 – wymagania uruchomieniowe Linuksa
- Dodano polską i angielską instrukcję instalacji bibliotek dla Ubuntu 22.04/24.04/26.04 i CachyOS/Arch, opartą na zależnościach gotowej binarki.
- Rozdzielono biblioteki obowiązkowe, narzędzia wybranych funkcji (FreeRDP, wybór plików, agent SSH, AppImage) oraz zależności do kompilacji. Dodano diagnostykę brakujących bibliotek.

## 1.6.14 – aktualna dokumentacja i porządki w kodzie
- Uaktualniono polski i angielski opis aplikacji, funkcji, technologii oraz wymagań i poleceń weryfikacji.
- Usunięto nieużywane zależności `clsx` i `tailwind-merge`, metodę i polecenie `session_list`, frontendowy typ `ExportPayload`, hook `useTheme`, zbędny znacznik czasu aktywności i dziewięć nieaktualnych tłumaczeń.
- Dekoder URI schowka jest kompilowany tylko na Linuksie, gdzie jest używany.

## 1.6.13 – pozycja potwierdzenia usuwania
- Potwierdzenie usunięcia połączenia pojawia się obok jego wiersza w drzewie, zamiast obok pozycji w menu kontekstowym. Analogicznie poprawiono usuwanie grup.

## 1.6.12 – menu kontekstowe grup
- Akcje grup przeniesiono z przycisków do menu pod prawym przyciskiem myszy, w stylu menu połączeń. Menu zawiera także rozwinięcie i zwinięcie wszystkich grup; usunięto te przyciski z nagłówka drzewa.
- Lewy przycisk nadal zwija i rozwija grupę. Menu obsługuje klawiaturę (Shift+F10, strzałki, Enter, Escape) oraz mieści się w granicach okna.

## 1.6.11 – wznowienie edycji po blokadzie sejfu
- Ekrany blokady PIN i Master Password są nad formularzami, a zablokowany interfejs nie przyjmuje kliknięć ani klawiatury.
- Niedokończona edycja pozostaje w pamięci podczas blokady także bez aktywnych sesji. Po odblokowaniu można ją dokończyć i zapisać; reset sejfu zamyka formularze.
- Zapis połączenia sprawdza aktualny stan sejfu i przy blokadzie przywraca ekran odblokowania bez porzucania edycji.

## 1.6.10 – sterowanie grupami i status usuwania SFTP
- Każda grupa ma zapamiętywaną opcję sortowania połączeń A–Z; wyłączenie przywraca pierwotną kolejność. Nagłówek drzewa pozwala zwinąć lub rozwinąć wszystkie grupy wraz z podgrupami.
- Usuwanie z serwera SFTP pokazuje aktualną ścieżkę i numer pozycji, blokuje kolejne transfery/usuwanie do zakończenia i odświeża widok także po błędzie. Licznik dotyczy zaznaczonych pozycji; katalogi są usuwane wraz z zawartością.

## 1.6.9 – ikona wersji portable na Linuksie
- Paczka linuksowa zawiera skrypt rejestrujący skrót i ikonę wersji portable dla bieżącego użytkownika, także dla AppImage.
- Duża ikona PNG jest pierwszą ikoną osadzaną w oknie i trafia do pakietów systemowych.

## 1.6.8 – kompaktowe menu połączeń
- W podzielonym widoku wybór sesji korzysta z kompaktowej listy z wyszukiwaniem, przewijaniem i informacją o grupie zamiast systemowej listy rozwijanej.
- W strukturze połączeń pozostają szybkie akcje połączenia i nowej karty. Menu „⋯” udostępnia pozostałe opcje; przyciski nie zasłaniają nazw ani liczników tuneli.

## 1.6.7 – lokalne potwierdzenie zamknięcia sesji
- Potwierdzenie rozłączenia ma formę małego okienka pod zamykaną zakładką lub przyciskiem połączenia, bez przyciemniania i rozmywania całego ekranu.
- Lokalna pozycja obejmuje zamknięcie karty, połączenia w podzielonym widoku, pozostałych sesji i wszystkich kart. Okienko mieści się w granicach okna; działanie przycisków i klawiszy Enter/Escape pozostaje zachowane.

## 1.6.6 – zakres eksportu połączeń
- Eksport obejmuje wszystkie połączenia albo zaznaczone grupy wraz z podgrupami. Można osobno dołączyć połączenia bez grupy; formularz pokazuje liczbę eksportowanych połączeń i folderów.
- Eksport podgrupy zachowuje foldery nadrzędne potrzebne do odtworzenia ścieżki, bez eksportowania innych połączeń nadrzędnych i sąsiednich grup. Do eksportu częściowego trafiają tylko używane profile poświadczeń.
- Wybór zakresu działa dla szyfrowanych plików `.rfvault` i jawnych plików JSON. Pusty lub nieaktualny wybór grup nie przełącza eksportu na całą bazę.

## 1.6.5 – klonowanie połączeń
- „Klonuj połączenie” w strukturze połączeń (przycisk przy wpisie i menu pod prawym przyciskiem myszy) tworzy zapisany wpis obok oryginału, w tej samej grupie, z nowym identyfikatorem i dopiskiem „(kopia)”. Kolejne kopie mają numer, np. „(kopia 2)”.
- Kopia zachowuje konfigurację, tunele, tagi, notatki, ustawienia RDP i SFTP oraz zaszyfrowane hasła i klucze. Współdzielony profil poświadczeń pozostaje powiązany. Oryginał nie jest zmieniany; klonowanie nie uruchamia sesji.

## 1.6.4 – grupy i pełny tekst na liście sesji
- Lista otwartych sesji pokazuje grupę połączenia, wraz z pełną ścieżką zagnieżdżonych folderów. Połączenia poza grupami są oznaczone „Bez grupy”. Wyszukiwanie uwzględnia także nazwy grup.
- Nazwa sesji, dane hosta i ścieżka grupy przewijają się automatycznie, gdy przekraczają szerokość wiersza. Krótki tekst pozostaje nieruchomy; przy ograniczeniu animacji w ustawieniach systemu tekst można przewijać ręcznie.

## 1.6.3 – nawigacja między wieloma sesjami
- Pasek zakładek ma przyciski przewijania w lewo i w prawo. Nieaktywny przycisk sygnalizuje początek lub koniec paska.
- Przycisk z liczbą otwartych sesji pokazuje wszystkie zakładki, ich hosty, użytkowników, protokoły oraz stan połączenia. Wyszukiwarka i obsługa klawiatury ułatwiają odnalezienie i wybranie sesji, również w podzielonym widoku.
- Wybrana zakładka jest automatycznie odsłaniana na pasku. Rozmiar paska i dostępność przewijania aktualizują się po zmianie rozmiaru okna, otwarciu, zamknięciu i przestawieniu zakładek.

## 1.6.2 – monit o puste hasło
- Przed logowaniem hasłem aplikacja sprawdza w backendzie efektywne hasło połączenia, uwzględniając profil poświadczeń i zaszyfrowany pusty ciąg. Brak hasła otwiera monit z wyborem: próba bez hasła, zapis nowego hasła i połączenie lub anulowanie.
- Nowe hasło jest szyfrowane i zapisywane wyłącznie w wybranym połączeniu, bez zmiany współdzielonego profilu ani pozostałych ustawień. Wybór pustego hasła dotyczy bieżącej sesji; kolejna nowa sesja wymaga ponownego wyboru.
- Monit obejmuje SSH z logowaniem hasłem oraz RDP (IronRDP, FreeRDP wbudowany i osobny). SSH używające klucza, certyfikatu lub agenta nie wymaga takiego monitu. Przy połączeniach grupowych monity są obsługiwane kolejno; blokada aplikacji anuluje oczekujące próby.

## 1.6.1 – poprawki bezpieczeństwa i połączeń
- Struktura połączeń zapamiętuje zwinięte grupy po ponownym uruchomieniu. Wyszukiwanie nie zmienia tego ustawienia.
- FreeRDP: błąd niezaufanego lub zmienionego certyfikatu otwiera komunikat z aktualnym odciskiem SHA-256. Po zweryfikowaniu go u administratora można jawnie zaufać certyfikatowi i połączyć się ponownie. Odcisk jest ponownie sprawdzany przed zapisaniem w sejfie, a FreeRDP dostaje konkretny zaakceptowany odcisk zamiast ignorowania błędów certyfikatów. Dotyczy okna wbudowanego i osobnego.
- SFTP: zmiana hosta, portu, użytkownika, metody uwierzytelnienia lub poświadczeń unieważnia sesję z puli. Klucz wpisany w połączeniu ma pierwszeństwo przed kluczem profilu poświadczeń.
- SSH respektuje wybraną metodę uwierzytelnienia, bez niejawnego przechodzenia do hasła lub agenta. Certyfikat OpenSSH jest przekazywany do libssh2 wraz z kluczem prywatnym. Tunele mają włączony keepalive SSH.
- Zamykanie proxy RDP anuluje również aktywnych klientów; negocjacja WebSocket ma limit czasu, a liczba klientów jest ograniczona.
- Sejf v3 szyfruje także nazwy, hosty, użytkowników, notatki, grupy i listę zaufanych serwerów. Migracja starszego sejfu po poprawnym odblokowaniu wymaga utworzenia kopii. Publiczny nagłówek z ustawieniami odblokowania, interfejsu i kopii nadal jest objęty HMAC. Starsze kopie zachowują dotychczasowy format; sejfu v3 nie należy otwierać starszą wersją aplikacji.
- Test kontroli tłumaczeń działa na Windows. Dodano testy regresji oraz etap `verify` w obrazie Docker dla Linuksa.

## 1.6.0 – FreeRDP w oknie aplikacji (Linux)
- **Nowa opcja: Ustawienia → Klient RDP (Linux) → „FreeRDP w oknie”.** Sesja RDP jest wtedy rysowana przez natywnego klienta FreeRDP (wiele wątków, H.264 przez `/gfx`) w zakładce RemoteFlow – nie w osobnym oknie. Jest dużo szybszy od wbudowanego klienta (IronRDP/WebAssembly) przy zmianie okien, wideo i przewijaniu. Domyślnie nadal działa klient wbudowany; zmiana obowiązuje po ponownym uruchomieniu programu.
- Jak to działa: nad obszarem sesji umieszczane jest natywne okno potomne (X11), do którego FreeRDP rysuje (`/parent-window`). Okno podąża za układem (podział ekranu, zmiana rozmiaru) i jest chowane, gdy zakładka nie jest widoczna albo obszar zasłania okno dialogowe. Klawiatura trafia do sesji, gdy kursor znajdzie się nad obrazem; kliknięcie w interfejs RemoteFlow oddaje ją z powrotem. Schowek i dysk `RemoteFlow` (`~/RemoteFlow_Shared`) obsługuje FreeRDP. Pasek sesji: ponowne połączenie, otwarcie w osobnym oknie, po rozłączeniu – ostatnie komunikaty FreeRDP.
- Wymaga X11 i klienta `xfreerdp3`/`xfreerdp` (np. `sudo apt install freerdp3-x11`). W sesji Wayland RemoteFlow uruchamia się przy włączonej opcji przez XWayland (`GDK_BACKEND=x11`, tylko gdy dostępny jest serwer X i zmienna nie jest ustawiona ręcznie).
- Okna-kontenery nie są niszczone po zamknięciu sesji, tylko ukrywane i używane ponownie – zniszczenie okna, w którym było okno FreeRDP, powodowało błąd GDK (segfault) kilka sekund później. Wywołania X11 ustawiające fokus używają osobnego połączenia z serwerem X.

## 1.5.4 – statystyki wydajności RDP
- **Statystyki w oknie RDP** (przycisk z ikoną wykresu na pasku narzędzi): dane z serwera (MB/s), aktualizacje ekranu (regiony/s, Mpx/s), czas rysowania, obciążenie wątku głównego (sonda co 10 ms) i podsumowanie dużych zmian ekranu (np. przełączenie okna): czas, dane, czas zajętości wątku. Przycisk „Kopiuj” kopiuje wyniki jako tekst. Pomiar działa tylko przy otwartym panelu.
- **Wynik pomiarów (serwer RemoteFX `freerdp-shadow`, 1600×900):** wątek główny zajęty ~95% czasu zarówno w WebKitGTK, jak i w Chromium, rysowanie zajmuje ~1% – ograniczeniem jest dekodowanie RemoteFX w IronRDP (WebAssembly, jeden wątek; moduł jest już skompilowany z SIMD), a nie sposób rysowania. Koszt dekodowania rośnie z liczbą pikseli – mniejsza rozdzielczość pulpitu zdalnego lub FreeRDP (H.264, wiele wątków) dają płynniejszy obraz.
- **Poprawka do 1.5.3:** wstrzymywanie obrazu dotyczy tylko aktualizacji złożonych z wielu części. Gdy dekodowanie zajmuje wątek, każda klatka przychodzi jako jeden region – wcześniej mogła być niepotrzebnie wstrzymana do 150 ms.

## 1.5.3 – RDP na Linuksie: obraz bez „doczytywania”
- **Wbudowany klient RDP (WebKitGTK):** duża aktualizacja ekranu (np. przełączenie okna na zdalnym pulpicie) przychodzi w wielu pakietach i była rysowana co klatkę, więc było widać, jak obraz się doczytuje. Teraz, dopóki napływa seria aktualizacji, obraz jest wstrzymywany (maks. 34 ms dla małych zmian, 150 ms dla zmian obejmujących ≥10% ekranu) i pokazywany w całości. Pojedyncze małe zmiany (pisanie, kursor) pojawiają się w kolejnej klatce jak dotąd.
- **FreeRDP (przycisk „Otwórz w FreeRDP” / klient systemowy na Linuksie):** uruchamiany z `/gfx` (potok graficzny – RemoteFX progressive / H.264, jeśli serwer i kompilacja FreeRDP go obsługują) i `/network:auto`. Wbudowany klient (IronRDP w WebAssembly) nie obsługuje GFX/H.264 i dekoduje obraz w jednym wątku, dlatego przy dynamicznej zawartości (wideo, przewijanie dużych okien) FreeRDP pozostaje szybszy.

## 1.5.2 – poprawki z przeglądu kodu
- **Testy nie dotykają prawdziwego sejfu.** Testy jednostkowe używały zwykłego wyszukiwania lokalizacji sejfu (obok programu, katalog roboczy, `~/.config/remoteflow`) i usuwały `vault.json` oraz `backups` – uruchomione na komputerze z prawdziwym sejfem mogły go skasować. Teraz w testach sejf jest zawsze w osobnym katalogu tymczasowym (`remoteflow-test-<pid>`); pilnuje tego test.
- **Zaufane hosty przy zablokowanym sejfie:** odtwarzany tunel nie czyta już listy z niezweryfikowanego pliku. Używana jest lista zapamiętana w pamięci przy ostatnim odczycie zweryfikowanym kluczem (odblokowanie, połączenie, Ustawienia). Wpis podmieniony w pliku podczas blokady jest ignorowany (test). Reset sejfu i przywrócenie kopii czyszczą tę listę.
- **SFTP – pobieranie nie zapisuje przez dowiązania symboliczne.** Gdy w katalogu docelowym istnieje dowiązanie o nazwie pobieranego pliku/katalogu, element jest pomijany z komunikatem (wcześniej `File::create` nadpisałby cel dowiązania, także poza wybranym katalogiem). Plik jest zapisywany do tymczasowego `.<nazwa>.rf-part` (utworzonego z `create_new`) i podmieniany przez zmianę nazwy dopiero po pobraniu – przerwane pobieranie nie niszczy też starej wersji pliku.
- **Terminal SSH nie gubi wysyłanych danych.** Dane z klawiatury i wklejania trafiają do kolejki i są wysyłane w takim tempie, w jakim przyjmuje je kanał; wcześniej `write_all` z 30-ms limitem czasu porzucał resztę, gdy okno kanału było pełne (np. wklejenie dużego tekstu, wolne łącze). Test: 3 MB wklejone do programu, który zaczyna czytać po sekundzie – dawna wersja gubiła dane za każdym razem, nowa przesyła całość.
- **Limit czasu negocjacji SSH (20 s)** obejmuje handshake, sprawdzenie klucza hosta i logowanie – serwer, który przyjmie TCP i nie odpowiada, nie blokuje już wątku na zawsze.
- **Stan sesji SSH zgodny z rzeczywistością:** zakładka jest „łączenie” do zalogowania, potem „połączono”; błąd logowania lub utrata połączenia ustawia „błąd”, zakończenie sesji przez serwer – „rozłączono” (szara kropka). Stan wysyła wątek sesji zdarzeniem `session-status`.
- **Adresy IPv6:** host i port są przekazywane do resolvera osobno, a tam gdzie potrzebny jest napis – w formie `[::1]:22` (SSH, proxy RDP, FreeRDP `/v:`, plik `.rdp`, cel klienta RDP). Wcześniej `::1` dawało błędne `::1:22`.
- Tunele SOCKS5: przy więcej niż 32 jednoczesnych nowych połączeniach kolejne czekają na wolny wątek negocjacji zamiast być odrzucane (test: 100 równoległych połączeń).

## 1.5.1
- **RDP na Linuksie rysuje się kilka razy szybciej.** Przyczyna (zmierzona w WebKitGTK 2.52 z serwerem xrdp): wbudowany klient IronRDP rysuje każdy zmieniony fragment ekranu osobnym wywołaniem `putImageData` – pełnoekranowe zdjęcie to ok. 180 pasków 1600×5 px. W WebView2 (Windows) to łącznie ~2 ms, ale w WebKitGTK każde wywołanie kosztuje stałe ~2 ms, więc obraz 1600×900 rysował się 340–480 ms i było widać, jak ładuje się pasami. Teraz fragmenty trafiają do bufora w pamięci, a ekran jest odświeżany jednym wywołaniem na klatkę: 11–23 ms rysowania, cały obraz pojawia się w 2–3 krokach (`src/utils/rdpCanvasBatching.ts`, włączane tylko w silnikach WebKit).
- Proxy RDP: wyłączony algorytm Nagle'a na lokalnym połączeniu WebSocket (mniej opóźnień przy wielu małych aktualizacjach ekranu).

## 1.5.0 – tunele SSH, terminal, SFTP i poprawki z przeglądu kodu
- **Tunele SSH na nowo (`session/tunnels.rs`).** Wszystkie tunele połączenia (-L, -D, -R) używają jednej wspólnej sesji SSH; każde połączenie TCP to tylko nowy kanał w tej sesji. Wcześniej każde połączenie przez tunel lokalny lub SOCKS5 zestawiało osobne połączenie SSH z pełnym logowaniem – przeglądarka otwierająca kilkadziesiąt połączeń naraz trafiała na limit `MaxStartups` serwera (zrywane połączenia, timeouty). Test: 60 równoległych połączeń SOCKS5 = 1 logowanie na serwerze.
- Tunele obsługują półzamknięcie TCP (half-close): gdy klient skończy wysyłać (np. zapytanie HTTP/SQL), odpowiedź serwera jest dalej przekazywana do końca – wcześniej kanał był zamykany i odpowiedź ucinana. Działa w obu kierunkach.
- Jeden wątek obsługuje wszystkie przekierowane połączenia sesji (tryb nieblokujący); limity: 256 jednoczesnych połączeń, 32 wątki pomocnicze (negocjacja SOCKS, łączenie celu -R). Skaner portów nie wyczerpie już wątków i deskryptorów. Po utracie łączności tunele łączą się ponownie przy następnym połączeniu.
- Terminal SSH: usunięto sztywne odpowiedzi backendu na zapytania terminala (DA, pozycja kursora, kolor tła) – odpowiada na nie xterm.js. Wcześniej serwer dostawał dwie odpowiedzi (druga pojawiała się jako przypadkowe znaki, np. `1;2c`), a kolor tła zawsze był „ciemny”, także w jasnym motywie. Polskie znaki rozdzielone między dwa odczyty z kanału nie zamieniają się już w `�`.
- Okno połączenia → Tunele: dla tunelu zdalnego (-R) pola opisane są „Port na serwerze” i „Cel na tym komputerze” (wcześniej mylące „Port lokalny” / „Zdalny”); podpowiedzi wyjaśniają kierunek każdego typu. Opis tuneli na zakładce pokazuje typ (`-L`, `-R`, `-D`).
- SFTP: dowiązania symboliczne są widoczne na liście (ikona łańcucha, kursywa, typ i rozmiar celu) – lokalnie i na serwerze. Przy kopiowaniu dowiązanie do pliku jest kopiowane z zawartością; dowiązanie do katalogu jest śledzone, gdy zaznaczysz je bezpośrednio, a wewnątrz kopiowanego katalogu jest pomijane (pętle) i liczone w podsumowaniu („pominięto dowiązań do katalogów”). Uszkodzone dowiązania są zgłaszane jako błąd. Na Windows ukryte elementy systemowe (stare skróty-junction w profilu, np. „Application Data”) nie są pokazywane.
- Import z mRemoteNG: połączenia VNC, Telnet, HTTP i inne nieobsługiwane protokoły są pomijane z komunikatem (np. „VNC × 3”) – wcześniej VNC stawało się połączeniem RDP na porcie 5900.
- Hasło RDP nie jest już przechowywane w danych sesji (`session_list`). Wbudowany klient pobiera je z sejfu w chwili łączenia (`session_rdp_password`), więc po zablokowaniu sejfu nie da się go odczytać.
- Menu kontekstowe otwierane w nowym miejscu nie miga już przez chwilę w poprzednim.

## 1.4.4
- Linux: domyślnie znów szybkie renderowanie przez GPU (DMA-BUF). Tryb zgodny (wolniejszy, bez błędu `DRM_IOCTL_MODE_CREATE_DUMB` / `GBM buffer`) wybiera się w Ustawieniach → Motyw kolorystyczny → „Renderowanie okna (Linux)”; działa po ponownym uruchomieniu. Wybór jest zapisany w `display.json` obok `vault.json` (musi być znany przed otwarciem okna, więc nie jest w zaszyfrowanym sejfie). Jednorazowo można go wymusić zmienną `REMOTEFLOW_SAFE_RENDERING=1` – przydatne, gdy okno w ogóle się nie rysuje.

## 1.4.3
- Linux (Ubuntu): błąd `KMS: DRM_IOCTL_MODE_CREATE_DUMB failed: Brak dostępu` / `Failed to create GBM buffer` (pusty lub migający ekran). WebKitGTK 2.42+ próbuje rysować przez bufory DMA-BUF karty graficznej, co nie działa m.in. ze sterownikami NVIDIA, w maszynach wirtualnych i bez dostępu do `/dev/dri`. Aplikacja wyłącza teraz ten tryb przy starcie (`WEBKIT_DISABLE_DMABUF_RENDERER=1`), chyba że zmienna jest już ustawiona. Kto chce wrócić do renderowania przez GPU, uruchamia program z `REMOTEFLOW_WEBKIT_DMABUF=1`.

## 1.4.2
- Menu kontekstowe (prawy przycisk myszy) mieszczą się zawsze w oknie: gdy pod kursorem brakuje miejsca, menu otwiera się nad kursorem, a przy prawej krawędzi – na lewo od niego. Dotyczy drzewa „Struktura połączeń” (np. połączenie na samym dole listy), zakładek, terminala SSH i okna SFTP (wspólny hook `src/utils/useMenuPosition.ts`).

## 1.4.1
- Jasny motyw z ciemnym terminalem: przyciski nad terminalem („Pliki (SFTP)”, „Tunele”, powiadomienia) były prawie niewidoczne (ciemny tekst na ciemnym terminalu). Pasek nad terminalem używa teraz kolorów terminalu – ciemnych, gdy terminal jest ciemny, i jasnych przy jasnym terminalu. Przycisk „Pliki (SFTP)” ma też własne tło (wcześniej przezroczyste).
- Blok kolorów jasnego motywu w `src/index.css` jest generowany skryptem `scripts/gen-theme-css.py`; nowa klasa `rf-dark` przywraca ciemną paletę wewnątrz jasnego motywu.

## 1.4.0
- **Jasny motyw.** W Ustawieniach → „Motyw kolorystyczny” można wybrać wygląd Ciemny (domyślny) lub Jasny; zmiana działa od razu, bez restartu, także na ekranie logowania, a pasek tytułu okna (Windows/Linux) przyjmuje ten sam motyw. Wybór jest zapamiętywany na komputerze, podobnie jak język.
- Terminal SSH w jasnym motywie dostaje jasną paletę 16 kolorów (przełączaną na żywo, bez ponownego łączenia). Opcja „Ciemny terminal SSH w jasnym motywie” zostawia ciemny terminal przy jasnej reszcie aplikacji.
- Technicznie: jasny motyw przemapowuje paletę Tailwind (zmienne CSS `--color-*`) pod klasą `html.light` w `src/index.css`; kolory panelu połączeń i obszaru RDP są nazwanymi tokenami (`side-*`, `rdp-bg`) zamiast stałych `#hex`. Logika w `src/theme/`.
- SFTP: szersza kolumna czasu modyfikacji (pełna godzina bez obcinania).

## 1.3.1
- SFTP: kolumna „Zmodyfikowano” (data i godzina modyfikacji) jest widoczna zawsze, także gdy okno SFTP zajmuje połowę panelu – wcześniej pokazywała się tylko w szerokim panelu. Format skrócony (np. `23.10.26, 14:05`), pełna data z sekundami w podpowiedzi; sortowanie po kliknięciu nagłówka.

## 1.3.0
- **Własna ikona aplikacji** (znak zachęty terminala `>` i fala „flow” na kafelku w kolorach aplikacji) zamiast domyślnej ikony Tauri – w pasku zadań, pliku `.exe`, instalatorach i pakietach Linux. Ten sam znak jest logo w nagłówku i na ekranie logowania oraz ikoną karty w trybie przeglądarkowym. Źródło: `src-tauri/icons/icon.svg` (pozostałe rozmiary: `npx tauri icon`).
- SFTP: na początku listy plików jest wpis `..` prowadzący do katalogu nadrzędnego (dwuklik), tak jak w FileZilli i WinSCP – po obu stronach. Można też na niego upuścić pliki, aby skopiować je do katalogu nadrzędnego.

## 1.2.0
- **Katalogi startowe SFTP są właściwością połączenia.** W oknie SFTP przycisk „Zapamiętaj katalogi” (pinezka w nagłówku lub menu pod prawym przyciskiem) zapisuje bieżący katalog lokalny i katalog na serwerze dla tego połączenia; obok jest przycisk, który je zapomina. Oba katalogi można też wpisać w oknie edycji połączenia SSH („Katalogi startowe SFTP”). Bez konfiguracji SFTP otwiera katalog domowy na komputerze i katalog domowy użytkownika połączenia na serwerze; zapamiętany katalog, który już nie istnieje, również kończy się katalogiem domowym. Folder przypięty we wcześniejszych wersjach jest nadal używany jako katalog lokalny.
- Usunięto globalną opcję „Globalny katalog pobierania plików (SFTP)” z Ustawień i z okna połączenia. Dla połączeń RDP pozostaje własny „Folder wymiany plików (RDP)” (domyślnie systemowy folder Pobrane).
- Naprawiono ścieżki na serwerze w SFTP na Windows: po wejściu do podkatalogu ścieżka wyglądała jak `/etc\apport` (Windows łączył ścieżki znakiem `\`). Ścieżki zdalne zawsze używają `/`, także w komunikatach błędów.
- Wklejanie tekstu do terminala SSH zamienia windowsowe końce linii (CRLF) na pojedynczy Enter i używa trybu „bracketed paste”, jeśli program na serwerze go włączył (vim, nano, bash). Wcześniej tekst skopiowany na Windows wklejał się z dodatkowymi pustymi liniami.

## 1.1.3
- Naprawiono kompilację na Windows: logowanie kluczem SSH z pamięci używa bezpośrednio funkcji libssh2 (`libssh2_userauth_publickey_frommemory`), bo biblioteka `ssh2` udostępnia ją na Windows tylko z backendem OpenSSL. Zachowanie bez zmian względem 1.1.2.

## 1.1.2 – poprawki bezpieczeństwa
- **FreeRDP: hasło nie trafia już do linii poleceń.** Zamiast `/p:hasło` (widoczne dla każdego użytkownika przez `ps`, `top`, `/proc/<pid>/cmdline`) używane jest `/from-stdin:force`, a hasło jest przekazywane przez potok stdin. Sprawdzone z FreeRDP 2.11 i 3.32 na serwerze xrdp (logowanie udane, hasło nieobecne w `/proc/<pid>/cmdline`).
- **Uprawnienia plików sejfu na Linux/macOS:** `vault.json`, pliki tymczasowe zapisu i kopie zapasowe są tworzone z prawami `0600`, nowe katalogi (konfiguracja, `backups`) z `0700`. Istniejące pliki z luźniejszymi prawami (np. `0644`) są zawężane przy starcie i przy tworzeniu kopii.
- **Klucze SSH bez plików tymczasowych:** klucz z sejfu jest używany z pamięci na wszystkich systemach (na Windows WinCNG z crypt32), klucz wskazany jako plik na dysku jest czytany bezpośrednio przez libssh2 – bez kopii. Jedyny wyjątek: na Windows klucz PEM zabezpieczony hasłem (WinCNG nie odszyfruje go z pamięci) – wtedy powstaje krótkotrwały plik w prywatnym katalogu użytkownika (`%LOCALAPPDATA%\RemoteFlow\ssh-tmp`), nadpisywany zerami i usuwany zaraz po logowaniu; pozostałości po awarii (także stare pliki `rf_ssh_*.tmp` z `%TEMP%`) są usuwane przy starcie.
- **Usunięto komendę `read_local_text_file(path)`**, która pozwalała warstwie WWW odczytać dowolny plik. Klucz prywatny wybiera się teraz w oknie systemowym, a backend czyta wyłącznie wybrany plik i tylko jeśli wygląda na klucz prywatny (maks. 64 KB).

## 1.1.1
- Nowy wygląd wyboru języka: zamiast systemowej listy rozwijanej (jasnej na Windows) przycisk `PL`/`EN` w stylu nagłówka i ciemne menu jak pozostałe menu aplikacji; w Ustawieniach przełącznik dwuprzyciskowy Polski / English.

## 1.1.0
- Angielska wersja językowa interfejsu. Wybór języka (Polski / English) w nagłówku aplikacji, na ekranie logowania i w Ustawieniach; zmiana działa od razu, bez restartu i bez zamykania sesji. Wybór jest zapamiętywany, a przy pierwszym uruchomieniu ustawiany według języka systemu.
- Komunikaty backendu (błędy, statusy połączeń, okna systemowe) są również tłumaczone (`tr!` w `src-tauri/src/i18n.rs`, komenda `app_set_language`).
- Słownik tłumaczeń: `src/i18n/en.json` (kluczem jest tekst polski). Skrypt `node scripts/check-i18n.mjs` sprawdza, czy każdy tekst z `t('…')` ma tłumaczenie.

## 1.0.4
- Błąd połączenia RDP można zaznaczyć i skopiować (przycisk „Kopiuj treść błędu”).
- Kody odmowy logowania Windows (np. `STATUS_LOGON_FAILURE 0xc000006d`, zablokowane/wyłączone konto, wygasłe hasło, brak prawa do Pulpitu zdalnego) są wyjaśniane po polsku, razem z loginem wysłanym do serwera.
- Ekran łączenia i pobierany plik `.rdp` pokazują login z domeną (`DOMENA\użytkownik`).

## 1.0.3
- Poprawna obsługa domeny w połączeniach RDP. Login można podać jako `jan` + pole „Domena”, `DOMENA\jan`, `jan@domena.local` (UPN) lub `.\konto` (konto lokalne). Wcześniej wpisanie domeny jednocześnie w nazwie użytkownika i w polu „Domena” (typowe po imporcie z mRemoteNG) albo UPN z wypełnioną domeną kończyło się błędem „invalid username” w IronRDP.
- Ta sama normalizacja dla FreeRDP (`/u:` i `/d:`); dla `mstsc` login `DOMENA\użytkownik` jest podpowiadany w oknie logowania (tymczasowy plik .rdp bez hasła).
- Pole „Domena Windows” przeniesione obok nazwy użytkownika i hasła, z podglądem „Logowanie jako: …”.

## 1.0.2
- Przygotowanie do publikacji na GitHubie: opis aplikacji po angielsku (`README.md`) i polsku (`README.pl.md`), licencja MIT, zrzuty ekranu, metadane projektu (opis, autor, licencja, repozytorium) w `package.json`, `Cargo.toml` i `tauri.conf.json`.
- Usunięto nieużywane pliki: stara szuflada SFTP (`SftpDrawer.tsx`) wraz z obsługującymi ją komendami backendu, pliki z szablonu Tauri/Vite (`App.css`, `react.svg`, `vite.svg`, `tauri.svg`), nieaktualna `INSTRUKCJA_WINDOWS.md` (zastąpiona przez README), tymczasowe archiwum `_rf_tmp/` oraz niedziałające skrypty `build:windows` / `build:linux` z `package.json`.

## 1.0.1
- Wprowadzono wersjonowanie aplikacji. Numer wersji jest widoczny obok logo w nagłówku, na ekranie logowania i na ekranie blokady PIN.

## 1.0.0
- Wersja bazowa: sejf v2 (HMAC), PIN, TOFU dla SSH/RDP, RDP na Windows (fallback TLS dla starszych serwerów), schowek plików RDP, import haseł z mRemoteNG, kopie zapasowe sejfu, automatyczna blokada, nowa struktura połączeń, dwupanelowy menedżer SFTP z menu kontekstowym, potwierdzenia zamykania połączeń i programu (konfigurowalne), potwierdzenia usuwania przy elemencie.
