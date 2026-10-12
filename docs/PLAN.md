# Plan wykonania: Hubber

| | |
|---|---|
| **Status** | Wersja robocza 0.1 |
| **Data** | 2026-10-12 |
| **Dokument nadrzędny** | [PRD.md](PRD.md) |

## 1. Cel i sposób użycia

Plan rozkłada wymagania z [PRD](PRD.md) na pakiety pracy ułożone w kolejności wykonania. Każdy pakiet ma identyfikator (np. `M1a-5`), listę wymagań PRD, które realizuje, zadania i warunek ukończenia. Pakiet jest pomyślany jako jedna jednostka zlecenia: da się go wykonać i odebrać samodzielnie.

Każde wymaganie z PRD jest przypisane do co najmniej jednego pakietu; identyfikator wymagania można wyszukać w tym dokumencie.

Plan nie podaje dat. Tempo zależy od czasu właściciela, a sztywne są tylko tygodnie używania, które zamykają każdy przyrost. Rozmiary pakietów są względne: **S** = 1 punkt, **M** = 2 punkty, **L** = 4 punkty.

## 2. Decyzje techniczne

Decyzje doprecyzowują rozdział 11 PRD. Zmiana którejkolwiek wymaga aktualizacji tego dokumentu.

| Obszar | Decyzja | Uzasadnienie |
|---|---|---|
| Repozytorium | Jeden pakiet TypeScript z katalogami `src/shared`, `src/server`, `src/web`, `evals`, `scripts`, `e2e` (testy Playwright). | Jeden użytkownik i jeden proces; podział na pakiety nic nie daje. |
| Środowisko | Node 26 (`.nvmrc`). Serwer i skrypty uruchamia sam `node`, bez `tsx` i bez kompilacji. Nowa wersja Node wchodzi do użytku dopiero wtedy, gdy przejdzie na niej `npm run check`. | Aktualne wersje Vite i Vitest wymagają Node 22.12 lub nowszego; Node 26 wykonuje pliki TypeScript bezpośrednio. Kod po stronie Node musi używać wyłącznie składni usuwalnej (`erasableSyntaxOnly`). Kontrola połączeń przy starcie i obserwator połączeń w testach czytają wewnętrzne struktury Node (sprawdzone na 26.5); testy, które uruchamiają prawdziwe procesy, zawodzą, gdy Node je zmieni. |
| Serwer | Hono na własnym `http.Server`, nasłuch na 127.0.0.1. Serwer wczytuje zbudowany interfejs raz, przy starcie, więc nową wersję pokazuje dopiero po restarcie. | Zwykły HTTP i SSE, łatwe do sprawdzenia narzędziem `curl`. Gotowe `serve()` z adaptera bez podanego hosta nasłuchuje na wszystkich interfejsach i wywraca proces przy zajętym porcie. Budowanie przepisuje katalog `dist/web` w miejscu; serwer czytający pliki przy każdym żądaniu odpowiadałby w tym czasie błędem 404, a potem podawał interfejs nowszy niż własny kod. Pliki interfejsu idą z pamięci bez obsługi żądań `Range`, co nabierze znaczenia, gdy znajdzie się wśród nich dźwięk lub wideo. |
| Ochrona lokalnego API | Strażnik nagłówków `Host` i `Origin` na każdej ścieżce, nagłówki bezpieczeństwa z Content-Security-Policy, żadnych nagłówków CORS. | Nasłuch na 127.0.0.1 nie chroni przed stronami otwartymi w tej samej przeglądarce (DNS rebinding, CSRF). Strażnik nie jest uwierzytelnieniem: procesy na tym komputerze nadal mogą wołać API. |
| Tryb deweloperski | Dwa procesy uruchamiane jednym skryptem: `node --watch` dla serwera i Vite dla interfejsu. Proxy Vite przekazuje serwerowi tylko `/api` i ścieżki poniżej. Skrypt zatrzymuje oba, gdy kończy pracę, także po sygnale `SIGQUIT`; gdy sam zostanie zabity sygnałem `SIGKILL`, robi to za niego proces-strażnik, którego skrypt po sobie zostawia. | Warianty jednoprocesowe po każdym przeładowaniu dokładały pętlę w tle albo kładły całą stronę przy błędzie serwera. Oba serwery działają we własnych grupach procesów, więc po zabitym skrypcie zostawałyby z zajętymi portami i otwartym workspace'em. |
| Linter i formatowanie | Biome w przypiętej wersji. | `typescript-eslint` nie uruchamia się z TypeScript 7. |
| Interfejs | React, Vite, TanStack Query, Tailwind, TipTap. | Zgodnie z PRD; TipTap wymusza środowisko przeglądarkowe. |
| Wykres Gantta i kalendarz | Własne komponenty na siatce CSS: kolumna na dzień, wiersze jako podsiatki, pasek umieszczony przez `grid-column`. Nazwy dni i miesięcy z `Intl` przez jeden moduł, arytmetyka dni na liczbach całkowitych w `src/shared/time.ts`. Bez biblioteki wykresów, kalendarza i dat; globalnego `Temporal` kod nie używa. | Daty harmonogramu to dni bez godzin, stref czasowych i powtórzeń, więc z gotowej biblioteki potrzebna byłaby mała część, a każda przynosi własny system stylów. Położenie paska jest daną, którą sprawdza test komponentu bez przeglądarki; układ i przyklejone nagłówki sprawdza test w przeglądarce. Sprawdzone: Node 26.5 z Homebrew nie ma `Temporal`. Do ponownej oceny, gdy w zakres wejdą godziny albo powtórzenia; o tym, czy przeciąganie powstaje na własnym mechanizmie, czy na gotowej bibliotece, rozstrzyga próba na początku `M2-11`. |
| Baza | SQLite przez `better-sqlite3`. Schemat bazy to pisane ręcznie migracje SQL w `src/server/db/migrations`; wykonuje je własny moduł `src/server/db/migrate.ts`, a tabele deklaruje dla zapytań i typów Drizzle (`drizzle-orm`, `src/server/db/schema`). Generatora `drizzle-kit` i migratora Drizzle nie używamy. Test porównuje zmigrowaną bazę z deklaracją Drizzle, a odcisk schematu (skrót z `sqlite_schema`) jest sprawdzany po każdej migracji i przy każdym starcie. Plik pracuje w trybie WAL; jedyne połączenie otwiera `src/server/workspace/database.ts`, po sprawdzeniu przypięcia workspace'u do endpointu, a Drizzle nakłada na nie wyłącznie `src/server/db/handle.ts`. Każde zatwierdzenie czeka, aż dysk utrwali dane: połączenie dostaje przy tworzeniu bazy i przy każdym otwarciu `synchronous = FULL`, `fullfsync = ON` i `checkpoint_fullfsync = ON`, a także `secure_delete = ON`. Żaden klucz obcy nie ma akcji `ON DELETE` ani `ON UPDATE`. | Jeden plik, wbudowane FTS5, migracje w repozytorium. Przy działającej aplikacji obok bazy leżą pliki `-wal` i `-shm`; po czystym zamknięciu zostaje jeden plik, więc kopia katalogu zrobiona przy zatrzymanej aplikacji jest pełną kopią zapasową. Na macOS samo `synchronous = FULL` oddaje dane dyskowi i na niego nie czeka; zmierzone: z oboma ustawieniami `fullfsync` zatwierdzenie trwa około 3 ms, bez nich 0,05 ms. Zmierzone w `M1a-4`: schemat używa tabel `STRICT` i `WITHOUT ROWID`, 69 wyzwalaczy i kolumny generowanej w kluczu obcym, czego `drizzle-kit` 0.31 nie zapisuje, a przebudowę tabeli generuje z błędami. Migrator Drizzle wykonał przebudowę tabeli przy włączonych kluczach obcych bez błędu i usunął wiersze tabel zależnych; nie wykrywa bazy nowszej niż kod ani zmienionej migracji. Przebudowa tabeli po cichu usuwa jej wyzwalacze i indeksy, czego `integrity_check` i `foreign_key_check` nie widzą, a odcisk schematu widzi. Załadowanie `drizzle-orm` kosztuje proces około 0,2 s, więc nic, co tworzy albo otwiera workspace, go nie ładuje. Z `secure_delete` treść usuniętych wierszy nie zostaje w wolnych stronach pliku. |
| Workspace | Katalog z plikiem `workspace.json` (nazwa i profil LLM, bez sekretów), bazą `hubber.sqlite` i katalogiem `files/`; przy pierwszej migracji bazy dochodzi katalog `backups/` z kopiami sprzed migracji. Adres endpointu jest zapisany w konfiguracji i w bazie; aplikacja otwiera workspace tylko wtedy, gdy oba zapisy są zgodne ze sobą i z adresem w `ANTHROPIC_BASE_URL`, jeśli ta zmienna jest ustawiona. Poświadczenia leżą poza workspace'em i są przypisane do adresu endpointu. | CFG-1, CFG-4, NFR-2, NFR-8. Skopiowany lub ręcznie zmieniony workspace nie wyśle danych ani poświadczeń pod inny adres. |
| Wyjście do sieci | Klienta SDK aplikacji buduje wyłącznie `src/server/llm/client.ts`: adres i poświadczenie bierze z otwartego workspace'u, zatrzymuje każde żądanie spoza przypiętego endpointu i nie podąża za przekierowaniami. Połączenia otwiera sam, przez własnych agentów `node:http` i `node:https`: nie sięgają ich ustawienia proxy Node'a ani zmienna `NODE_TLS_REJECT_UNAUTHORIZED`, a certyfikat endpointu jest zawsze sprawdzany. Proxy nie jest obsługiwane, a start z włączoną obsługą proxy Node'a jest odrzucany. Wyjątkiem jest diagnostyka endpointu (`scripts/diagnose.ts`, `src/server/llm/diagnostics`), która buduje własnego klienta dla adresu ze środowiska i używa `fetch`. Pozostały kod serwera, kod współdzielony i skrypty nie używają `fetch`, `WebSocket` ani `EventSource`, a poza skryptem, który przygotowuje workspace testów end-to-end, nie importują testów ani ich modułów pomocniczych; pilnuje tego linter. Moduły Node'a prowadzące do sieci i do uruchamiania programów (`node:http`, `node:net`, `node:child_process` i pokrewne) wolno importować tylko plikom wymienionym w `scripts/lint-boundaries.test.ts`. | NFR-1 i NFR-2. Zmierzone: zwykły `fetch` po odpowiedzi 307 lub 308 wysyła treść żądania pod wskazany adres, razem z nagłówkiem `x-api-key`; dlatego za przekierowaniami nie podąża też diagnostyka. Zmierzone: przy włączonej obsłudze proxy Node'a przez proxy idą `fetch` i agenci globalni, a agent utworzony bez ustawień proxy łączy się bezpośrednio. Test połączeń sprawdza tylko ścieżki, które sam przechodzi; granice w linterze obejmują także kod, do którego żaden test nie dociera. |
| Schematy | Zod jako jedno źródło: walidacja API, walidacja operacji i JSON Schema dla narzędzi modelu. Pliki czytane przy starcie (`workspace.json`, plik poświadczeń) mają własne walidatory. | Model, serwer i interfejs nie mogą się rozjechać. Komunikat o błędzie w pliku poświadczeń nie może zacytować jego treści, a walidator konfiguracji zgłasza wszystkie błędy naraz i odrzuca nieznane pola. |
| Mutacje | Każda zmiana danych, także ręczna edycja użytkownika, przechodzi przez framework operacji. Dotyczy to także daty zdarzenia wrzutki: ustala ją operacja. | Jedna historia zmian dla osi czasu, dziennika i cofania. |
| Zatwierdzanie | Operacje przebiegu agenta są najpierw odkładane, a stosowane dopiero po operacji `finish`. | Nieudany przebieg nie zostawia połowy zmian; ponowienie nie tworzy duplikatów. |
| Zależności operacji | Operacja może zależeć od innej (np. zadanie od nowej osoby). Akceptacja i odrzucenie działają kaskadowo. | Propozycje często odwołują się do obiektów, które same czekają na decyzję. |
| Pętla agenta | Własna pętla na `client.messages.stream()` i `finalMessage()`, bez helperów beta. | Router ma wyłączone funkcje przedpremierowe. |
| Historia rozmowy | Tylko dopisywanie: `system`, `tools` i wcześniejsze wiadomości są niezmienne w obrębie przebiegu i rozmowy. | Bloki rozumowania są związane z rozmową; edycja historii kończy się błędem 400 i utratą cache. |
| Rozdział wejść | Wejście z dołączonym materiałem uruchamia osobny przebieg w tle. Wejście z samym tekstem wpisanym jest turą rozmowy. | Reguła deterministyczna, bez dodatkowego wywołania modelu na klasyfikację. |
| Kolejka | Tabela zadań w SQLite i jeden worker w procesie serwera. | Przeżywa restart bez zewnętrznych usług. |
| Fragmenty notatek | Jednostką podziału jest zdanie (`Intl.Segmenter`); fragment to ciągły zakres zdań oznaczony znacznikiem w treści TipTap. | Model wskazuje indeksy zdań, a nie pozycje znaków; znacznik przesuwa się razem z tekstem. |
| Treść notatki | Operacja `create_note` wskazuje zakres tekstu źródłowego; treści nie generuje model. | Gwarantuje wierność treści wymaganą przez NOT-3. |
| Aktualizacje na żywo | Jeden strumień SSE z powiadomieniami o zmianach; interfejs odświeża zapytania. | Wystarcza dla jednego użytkownika. |

### Reguły warstwy LLM

Obowiązują we wszystkich pakietach, które wywołują model.

- Narzędzia mają tylko pola `name`, `description`, `input_schema`. Bez `strict` i bez `eager_input_streaming`.
- `tool_choice` pozostaje `auto`. Kod sprawdza, czy wywołanie nastąpiło; przebieg kończy operacja `finish`.
- Pola `thinking` nie wysyłamy. `effort` i `cache_control` wysyłamy tylko wtedy, gdy diagnostyka je potwierdziła; `effort` ustawiamy wtedy jawnie dla każdej roli.
- `max_tokens` uwzględnia rozumowanie: 64000 dla wywołań strumieniowanych.
- Odpowiedź czytamy po typie bloku. Bloki `thinking` wracają do historii bez zmian.
- Indeks itemów i osób jest migawką z początku przebiegu lub rozmowy. Nowe informacje dopisujemy jako kolejną wiadomość.
- Przy błędzie 400 z komunikatem o bloku związanym z inną rozmową usuwamy z historii bloki `thinking` i `redacted_thinking`, ponawiamy raz i zapisujemy zdarzenie w logu.
- `stop_reason` obsługujemy przed odczytem treści: przy `max_tokens` i `refusal` nie wykonujemy narzędzi z tej tury; przebieg dostaje stan błędu z możliwością ponowienia.
- Błędy rozróżniamy typami wyjątków SDK, nie treścią komunikatu, poza przypadkiem z poprzedniego punktu.
- Serwerowy fallback po odmowie jest funkcją beta: w profilu routera wyłączony, w profilu Anthropic opcjonalny.

## 3. Zasady wykonania

### Definicja ukończenia pakietu

- Testy jednostkowe i integracyjne pakietu przechodzą; kompilacja w trybie `strict` bez błędów.
- Zmiana schematu ma migrację, a przed migracją powstaje kopia bazy.
- Jeśli pakiet zmienia schemat albo zapytanie widoku, wynik `npm run perf` został zapisany.
- Jeśli pakiet dotyka promptów, operacji lub modelu, zestaw regresyjny został uruchomiony i wynik zapisany.
- Ścieżkę użytkownika pakietu da się pokazać w działającej aplikacji.
- Wymagania PRD wymienione w pakiecie są spełnione albo odstępstwo jest zapisane w tym dokumencie.

### Poziomy testów

| Poziom | Zakres | Narzędzie |
|---|---|---|
| Jednostkowe | Polityka stosowania, walidacje, operacje (zastosuj i cofnij), segmentacja zdań, zapytania widoku „Dziś", arytmetyka dni, geometria wykresu Gantta i kalendarza. | Vitest |
| Integracyjne | Pętla agenta, kolejka i API na bazie w pamięci (`createTestDatabase()`), ze skryptowanym modelem zamiast prawdziwego. | Vitest, model skryptowany |
| End-to-end | Scenariusze 9.1–9.4 z PRD w przeglądarce, ze skryptowanym modelem. | Playwright |
| Regresja | Jakość przetwarzania i rozmowy na prawdziwym modelu. | `evals/` |
| Wydajność | Czasy zapisu, zapytań, kopii i migracji na danych syntetycznych w skali z NFR-6. | `npm run perf` |

### Dane i środowiska

- Workspace deweloperski używa bezpośredniego API Anthropic i wyłącznie danych syntetycznych.
- Workspace służbowy używa routera i istnieje tylko na maszynie służbowej.
- Pomiar wydajności (`npm run perf`) wykonuje się na słabszej z maszyn, na których działa aplikacja. Dziś jest nią maszyna prywatna z workspace'em deweloperskim (Apple M2 Pro, 16 GB RAM); maszyna służbowa (Apple M5 Pro, 48 GB RAM) jest mocniejsza i osobnego pomiaru nie wymaga.
- Od pierwszego tygodnia używania baza zawiera prawdziwe dane. Każda późniejsza zmiana schematu jest migracją w przód.
- Katalogi workspace'ów i pliki z poświadczeniami leżą poza repozytorium. Workspace leży domyślnie w `~/Library/Application Support/Hubber/workspaces/default`, a inny katalog wskazuje zmienna `HUBBER_WORKSPACE`. Plik poświadczeń leży domyślnie w `~/.config/hubber/credentials.json`, a inny wskazuje zmienna `HUBBER_CREDENTIALS_FILE`.
- Testy i sesje agentów nie uruchamiają aplikacji na workspace'ie właściciela. Testy tworzą własne workspace'y w katalogu tymczasowym; proces bez zmiennych `HUBBER_WORKSPACE` i `HOME` nie ma workspace'u domyślnego. Dla sesji agentów jest to reguła zapisana w `CLAUDE.md`: każde polecenie samo niesie zmienną `HUBBER_WORKSPACE` z jednorazowym katalogiem, bo powłoka agenta nie przenosi zmiennych między poleceniami. Na wypadek pominięcia zmiennej kod odmawia takiej sesji workspace'u domyślnego: gdy środowisko wskazuje sesję agenta (zmienna `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` albo `AI_AGENT`), `npm start`, `npm run dev` i `npm run workspace:create` bez zmiennej kończą się kodem 2. Workspace wskazany wprost otwiera się także w sesji agenta, więc tu obowiązuje sama reguła.
- Projekt wymaga Node 26. Na starszej wersji `npm install` kończy się błędem, a `npm start`, `npm run dev`, `npm run build`, `npm test`, `npm run test:watch`, `npm run check`, `npm run diagnose`, `npm run workspace:create`, `npm run synthetic`, `npm run perf` i `npm run db:fixture` wypisują komunikat po polsku, zanim cokolwiek uruchomią.

### Prompty

Prompty są plikami w repozytorium. Każdy przebieg zapisuje identyfikator wersji promptu i modelu, żeby wynik regresji dało się przypisać do konkretnej zmiany.

## 4. Mapa milestone'ów

| Etap | Cel | Pakiety | Punkty | Zamknięcie |
|---|---|---|---|---|
| **M0** | Sprawdzić nawyk i zebrać prawdziwy materiał | 4 | 5 | Przegląd po dwóch tygodniach |
| **M1a** | Rdzeń pętli: wrzutka, propozycje, projekty i zadania, harmonogram, wykres Gantta ze zmianami ręcznymi i kalendarz projektu | 21 | 52 | Scenariusze 9.1 i 9.4 oraz tydzień użycia |
| **M1b** | Osoby i notatki powiązane z projektami | 9 | 22 | Scenariusz 9.2 i tydzień użycia |
| **M1c** | Rozmowa, widok „Dziś", wyszukiwanie, dokumenty | 8 | 17 | Scenariusz 9.3, tydzień użycia, zamknięcie M1 |
| **M2** | Proaktywność i wiedza (wymagania P1) | 13 | 29 | Metryki z PRD przez dwa tygodnie |
| **M3** | Integracje i rozszerzenia (wymagania P2) | 5 | do wyceny | Do określenia po M2 |

M0 może biec równolegle z M1a. Pakiet `M1a-1` warto wykonać jako pierwszy, bo rozstrzyga dwa otwarte pytania PRD.

## 5. M0 — walidacja bez interfejsu

**Cel:** sprawdzić, czy codzienne wrzucanie materiału się utrzymuje, i zebrać dane do zestawu regresyjnego. Etap jest zalecany, nie obowiązkowy.

**Warunek wejścia:** Claude Code działa przez router na maszynie służbowej.

### M0-1 Katalog i reguły (S)

- Założyć lokalny katalog poza repozytorium Hubbera: `inbox/` (surowe wrzutki z datą), `items/`, `people/`, `notes/`, `questions.md`.
- Spisać reguły dla agenta: nie przeredagowuj notatek, każdy fakt z cytatem i źródłem, przy niejednoznaczności pytaj, jedna wrzutka może dotyczyć wielu projektów.
- **Gotowe, gdy:** wrzucenie wiadomości i notatki ze spotkania daje poprawnie uzupełnione pliki projektu i osoby.

### M0-2 Dwa tygodnie codziennego użycia (M)

- Wrzucać materiał na bieżąco; raz dziennie przejrzeć zmiany agenta.
- Każde pytanie zadane hubowi zapisać w `questions.md` z oceną, czy odpowiedź była użyteczna.
- **Gotowe, gdy:** minęło dziesięć dni roboczych.

### M0-3 Korpus rzeczywisty (S)

- Wybrać 30–50 wrzutek i dla każdej zapisać oczekiwany wynik: projekty, osoby, zadania, fakty, daty i kamienie milowe.
- **Gotowe, gdy:** korpus leży w katalogu workspace'u służbowego w formacie przyjętym w `M1a-15`.

### M0-4 Przegląd i decyzje (S)

- Porównać zebrane pytania z rozdziałem 5 PRD.
- Rozstrzygnąć otwarte pytania PRD o słowniki statusów, ważności i ról, o reguły dat oraz o progi braku aktywności.
- **Gotowe, gdy:** PRD jest zaktualizowany, a decyzja o kontynuacji zapisana.

## 6. M1a — rdzeń pętli

**Cel:** wrzucam materiał, akceptuję propozycje, widzę projekty i zadania z osią czasu i źródłami oraz na wykresie Gantta, dodaję i zmieniam daty na wykresie i widzę projekt w kalendarzu.

**Warunek zamknięcia:** scenariusze 9.1 i 9.4 przechodzą end-to-end na zestawie syntetycznym; tydzień codziennego użycia w workspace służbowym bez utraty danych.

| ID | Pakiet | Rozmiar | Zależy od |
|---|---|---|---|
| M1a-1 | Diagnostyka endpointu | M | — |
| M1a-2 | Szkielet projektu | M | — |
| M1a-3 | Workspace i profile LLM | M | M1a-2 |
| M1a-4 | Schemat danych i migracje | M | M1a-3 |
| M1a-5 | Framework operacji | L | M1a-4 |
| M1a-6 | Warstwa LLM i pętla agenta | L | M1a-1, M1a-3, M1a-5 |
| M1a-7 | Kolejka i przetwarzanie wrzutek | L | M1a-6 |
| M1a-8 | API i zdarzenia na żywo | M | M1a-5 |
| M1a-9 | Powłoka aplikacji i pole wejściowe | M | M1a-8 |
| M1a-10 | Inbox | L | M1a-7, M1a-9 |
| M1a-11 | Projekty i zadania | L | M1a-8, M1a-9 |
| M1a-12 | Podsumowanie stanu | S | M1a-6, M1a-11 |
| M1a-13 | Podstawowy katalog osób i zasilenie początkowe | M | M1a-10 |
| M1a-14 | Dziennik zmian i usuwanie | M | M1a-10, M1a-11 |
| M1a-15 | Zestaw regresyjny syntetyczny | M | M1a-7 |
| M1a-16 | Harmonogram: pola i operacje | M | M1a-6, M1a-11 |
| M1a-17 | Harmonogram: wyodrębnianie i propozycje | L | M1a-10, M1a-15, M1a-16 |
| M1a-18 | Wykres Gantta | M | M1a-16 |
| M1a-19 | Wykres Gantta: zmiany ręczne | S | M1a-18 |
| M1a-20 | Kalendarz projektu | M | M1a-18, M1a-19 |
| M1a-21 | Domknięcie i tydzień użycia | M | wszystkie |

### M1a-1 Diagnostyka endpointu (M)

**Wymagania:** CFG-5.

**Stan:** kod i testy gotowe (`npm run diagnose`, moduł w `src/server/llm/diagnostics`). Do zamknięcia pakietu brakuje uruchomienia na obu endpointach.

- Skrypt uruchamiany z terminala, korzystający z `ANTHROPIC_BASE_URL` i poświadczeń ze środowiska albo z pliku ustawień Claude Code (`--claude-settings`).
- Testy rdzenia: zwykła wiadomość, strumieniowanie, wywołanie narzędzia z odesłaniem wyniku, wynik narzędzia z `is_error`, wejście obrazowe.
- Testy opcjonalne: `cache_control` (drugie żądanie ma `cache_read_input_tokens` większe od zera), `effort`, `thinking`, blok PDF.
- Testy informacyjne: `strict`, `output_config.format` i lista modeli endpointu. Wynik nie wpływa na projekt.
- Wynik jako plik JSON z listą potwierdzonych funkcji, czasami odpowiedzi i treścią błędów.
- **Gotowe, gdy:** skrypt wykonany na obu endpointach; otwarte pytania PRD o funkcje opcjonalne i o sposób wydawania poświadczeń mają odpowiedź.

### M1a-2 Szkielet projektu (M)

**Wymagania:** NFR-3, NFR-10, NFR-12.

**Stan:** kod i testy gotowe (`npm start`, `npm run dev`, `npm run check`, `npm run test:e2e`). `npm run check` przechodzi: 410 testów jednostkowych w 24 plikach. Testy end-to-end sprawdzają zbudowaną aplikację w Chromium i w silniku WebKit: z 32 testów przechodzi 31, a jeden, test DNS rebinding, jest w WebKit celowo pomijany, bo nie da się go tam przeprowadzić. Z `HUBBER_E2E_CHROME=1` dochodzi zainstalowany Google Chrome, uruchamiany bez okna: z 48 testów przechodzi 47, a pominięty jest ten sam jeden.

- `git init`, `.gitignore` obejmujący katalogi workspace'ów i pliki środowiskowe.
- TypeScript w trybie `strict`, linter, Vitest, Playwright.
- Serwer Hono nasłuchujący wyłącznie na 127.0.0.1; aplikacja React serwowana przez ten sam proces w trybie produkcyjnym.
- Strażnik nagłówków `Host` i `Origin` oraz nagłówki bezpieczeństwa na każdej odpowiedzi, sprawdzane także testami w przeglądarce. Nagłówki mają również odpowiedzi, których Node albo adapter HTTP udziela bez pytania aplikacji: 400 przy braku nagłówka `Host` albo przy nagłówku lub adresie żądania, z których nie da się złożyć adresu, 417 przy nieznanym `Expect` oraz 500 i 504, gdy aplikacja zawiedzie.
- Jedno polecenie instaluje zależności (`npm install`) i jedno uruchamia aplikację (`npm start`); `npm run dev` uruchamia tryb deweloperski.
- **Gotowe, gdy:** pusta aplikacja startuje jednym poleceniem na macOS w Chrome, a test sprawdza, że serwer nie nasłuchuje na innym interfejsie.

### M1a-3 Workspace i profile LLM (M)

**Wymagania:** CFG-1, CFG-2, CFG-3, CFG-4, CFG-6, NFR-1, NFR-2.

**Stan:** kod i testy gotowe (`npm run workspace:create`; moduły w `src/server/workspace` i `src/server/llm/credentials`). `npm run check` przechodzi: 1717 testów jednostkowych w 54 plikach. Testy end-to-end uruchamiają aplikację na jednorazowym workspace'ie, który każdy przebieg tworzy od nowa w katalogu tymczasowym, i pod obserwatorem połączeń, którego zapis przebieg sprawdza na końcu: z 44 testów w Chromium i w silniku WebKit przechodzi 43, a pomijany jest ten sam jeden co w `M1a-2`, test DNS rebinding w WebKit. Z `HUBBER_E2E_CHROME=1` dochodzi Google Chrome: z 66 testów przechodzi 65, a pominięty jest ten sam jeden. Do zamknięcia pakietu brakuje utworzenia workspace'u na maszynie służbowej.

- Polecenie tworzące workspace (`npm run workspace:create`): katalog, plik konfiguracji, pusta baza, katalog plików. Tworzy wyłącznie nowy katalog, z niczym się nie łączy i nie czyta poświadczeń.
- Konfiguracja przechowuje nazwę, adres endpointu, rodzaj profilu, sposób uwierzytelnienia, identyfikatory modeli dla ról i werdykty diagnostyki wzięte z raportu `npm run diagnose`. Nie przechowuje sekretów.
- Przypięcie: adres endpointu zapisany w konfiguracji i w bazie. Aktywny endpoint to adres ze zmiennej `ANTHROPIC_BASE_URL`: gdy jest ustawiona i wskazuje inny adres, aplikacja odmawia otwarcia workspace'u (kod wyjścia 3); tak samo, gdy konfiguracja i baza podają różne adresy. Bez tej zmiennej workspace się otwiera, a poświadczenia ze zmiennych środowiskowych należą wtedy wyłącznie do `https://api.anthropic.com`.
- Poświadczenia w kolejności: zmienne środowiskowe, plik lokalny poza repozytorium, polecenie pomocnicze z pamięcią podręczną i odświeżaniem. Każde źródło wydaje poświadczenie tylko dla adresu, do którego je przypisano. Polecenie pomocnicze konfiguruje się w pliku poświadczeń, nie w workspace'ie.
- Punkt API `GET /api/workspace` zwracający nazwę workspace'u i origin przypiętego endpointu (schemat, host, port). Ścieżka adresu nie trafia do przeglądarki; pełny adres wypisuje serwer przy starcie.
- Test sprawdzający, że aplikacja nie wykonuje połączeń poza skonfigurowany endpoint: proces serwera i klient SDK pod obserwatorem połączeń (`src/server/egress.test.ts`). Pod tym samym obserwatorem działa serwer testów end-to-end, a przebieg kończy się błędem, jeśli serwer zrobił cokolwiek poza otwarciem swojego portu albo obserwatora w nim nie było (`e2e/egress.ts`).
- `better-sqlite3` wchodzi w tym pakiecie, bo to on pierwszy otwiera bazę: wersja dokładna, z gotowymi binariami. Wpis `allowScripts` w `package.json` odmawia mu skryptu instalacyjnego, dzięki czemu czysta instalacja nie potrzebuje Pythona ani kompilatora.
- **Gotowe, gdy:** workspace utworzony dla jednego endpointu nie otwiera się z innym; sekretu nie ma w bazie ani w katalogu workspace'u.

### M1a-4 Schemat danych i migracje (M)

**Wymagania:** model danych dla ITM-1 do ITM-6, ITM-13, SCH-1 i SCH-2, NFR-6.

**Stan:** kod i testy gotowe (`npm run synthetic`, `npm run perf`, `npm run db:fixture`; moduły w `src/server/db` i `src/shared`). `npm run check` przechodzi: 4895 testów jednostkowych w 80 plikach. Testy end-to-end: z 44 testów w Chromium i w silniku WebKit przechodzi 43, a pomijany jest ten sam jeden co w `M1a-2`; z `HUBBER_E2E_CHROME=1` z 66 testów przechodzi 65. `npm run perf` na danych syntetycznych z trzech lat (1,9 mln wierszy, 743 MB) mieści się we wszystkich budżetach: zapis wrzutki p95 6,0 ms, zatwierdzenie przebiegu z siedmioma operacjami p95 8,3 ms, wiersze wykresu Gantta największego drzewa (2287 itemów) 4,9 ms, kopia bazy 2,9 s, start z migracją przebudowującą tabelę operacji 7,9 s, generowanie danych 92 s. Najbliżej budżetu jest odczyt kosztów z ostatnich 30 dni: 16,6 ms przy budżecie 20 ms, bo czyta cały log wywołań modelu; indeks dla niego to jedna instrukcja w kolejnej migracji.

- Tabele: rejestr źródeł, wrzutki, ich części i tekst pochodny części, pliki, itemy, opisy itemów, aliasy itemów, osoby, aliasy osób, role osób w itemach, wzmianki, fakty i osoby faktów, powiązania źródeł, zadania kolejki, przebiegi, log wywołań modelu, operacje, ich zależności i skutki, siedem słowników (statusy, kondycja, ważność, moja rola, role osób, typy faktów, relacje) i trzy listy stanów (operacji, przebiegów, zadań). Pełny DDL: `src/server/db/migrations/0001_init.sql`.
- Identyfikatory nadaje aplikacja (`src/shared/ids.ts`): tekst z trzyliterowym przedrostkiem rodzaju i dwunastoma losowymi znakami, żeby operacje mogły wskazać obiekt przed jego zapisem. Wyjątki: pliki (skrót treści) oraz skutki operacji i wywołania modelu (liczby).
- Chwile są tekstem UTC w zapisie `toISOString()`, dni tekstem `RRRR-MM-DD`; baza odrzuca każdy inny zapis.
- Hierarchia itemów to dwie kolumny tabeli itemów: typ (`kind`: `project` albo `task`) i item nadrzędny (`parent_id`). Podzadanie nie jest typem: to zadanie, którego item nadrzędny jest zadaniem. Baza pilnuje, że item nadrzędny istnieje, że item nie trafia bezpośrednio pod item scalony, że projekt nie ma itemu nadrzędnego i że żaden item nie jest własnym przodkiem, czyli nie leży pod samym sobą na żadnym poziomie; głębokości drzewa baza nie ogranicza, limit należy do walidacji operacji (`M1a-5`). Lista typów jest ograniczeniem `CHECK`, istnienia itemu nadrzędnego pilnuje klucz obcy, a pozostałe reguły hierarchii są wyzwalaczami (`items_hierarchy_insert` i `items_hierarchy_update` oraz dwa wyzwalacze scalonego itemu nadrzędnego), żeby zmiana reguły (np. projekt pod projektem albo limit głębokości) nie wymagała przebudowy tabeli itemów. Przeniesienie itemu ze wszystkim, co zawiera, to jedno `UPDATE` kolumny `parent_id` jednego wiersza. Sprawdzenie cyklu idzie od nowego itemu nadrzędnego w górę drzewa po kluczu głównym i kosztuje tyle, ile poziomów jest nad tym itemem (zmierzone: 0,007 ms na ósmym poziomie, 0,03 ms na pięćdziesiątym). Cyklu w hierarchii nie widzą `integrity_check` ani `foreign_key_check`: pilnują go tylko te wyzwalacze, a ich obecności pilnuje odcisk schematu. Generator danych syntetycznych i test migracji sprawdzają jednym zapytaniem, że żaden projekt nie ma itemu nadrzędnego, że każdy item prowadzi do szczytu drzewa i że żaden nie leży bezpośrednio pod itemem scalonym.
- Harmonogram itemu to pięć kolumn tabeli itemów: data rozpoczęcia (`start_on`), termin (`due_on`), dokładność każdej z tych dat (`start_on_precision`, `due_on_precision`) i oznaczenie kamienia milowego (`is_milestone`). Brak dokładności oznacza datę znaną co do dnia, `approximate` datę przybliżoną, a `week`, `month`, `quarter`, `half` i `year` okres, którego granicą jest zapisany dzień: pierwszym dniem dla daty rozpoczęcia, ostatnim dla terminu. Listę dokładności prowadzi `src/shared/vocabulary.ts`, a granice okresów liczy `src/shared/time.ts`. Baza pilnuje, że dokładność dotyczy ustawionej daty oraz że kamień milowy nie ma daty rozpoczęcia i nie jest projektem. Kolejności daty rozpoczęcia i terminu baza nie pilnuje: praca może zacząć się po terminie, a widoki to oznaczają. Te reguły są wyzwalaczami, a nie ograniczeniami `CHECK`, żeby ich zmiana nie wymagała przebudowy tabeli itemów; wyzwalacze patrzą tylko na zapisywany wiersz, więc migracja, która zaostrza regułę, w tym samym kroku naprawia wiersze, które ją łamią. Wykres Gantta i kalendarz projektu są zapytaniami do tych kolumn i nie mają własnych tabel ani indeksów.
- Skutki operacji (`operation_effects`) zapisują, co zmiana zrobiła: wiersz, pole, wartość przed i po. Cofnięcie jest odwrotnością tych wierszy, a oś czasu, filtry dziennika i data ostatniej aktywności czytają te same dane.
- Data ostatniej aktywności itemu to chwila najnowszej obowiązującej operacji, która go dotyczyła; utrzymują ją wyzwalacze. Zmiana cofnięta i samo cofnięcie się nie liczą.
- Reguły, których baza pilnuje sama: surowy materiał i fakty nie są edytowane; operacje przechodzą tylko dozwolone stany; operacje przebiegu są odkładane i ruszają dopiero po jego zatwierdzeniu, a przebieg zakończony inaczej usuwa to, co odłożył; zależności nie tworzą cyklu; scalony item ani scalona osoba nie przyjmują nowych wierszy. Kod dostaje wtedy błąd SQLite z nazwą reguły.
- Migracje to pisane ręcznie pliki SQL w `src/server/db/migrations`, z listą w `manifest.json` (znacznik, skrót pliku, odcisk schematu po migracji). Wykonuje je `src/server/db/migrate.ts`: przy tworzeniu workspace'u (bez kopii, bo baza jest pusta) i przy każdym otwarciu, po sprawdzeniu przypięcia. Zaległe migracje idą w jednej transakcji, przy bazie zajętej na wyłączność, z wyłączonymi kluczami obcymi oraz z `PRAGMA foreign_key_check` i porównaniem odcisku schematu przed zatwierdzeniem. Ewidencję prowadzi tabela `schema_migrations`. Migracji, która trafiła do `main`, się nie zmienia.
- Kopia przed migracją to migawka `VACUUM INTO` w katalogu `backups/` workspace'u (katalog 0700, plik 0600): jedna na start, który ma cokolwiek do wykonania; zostaje pięć najnowszych. Start bez zaległych migracji niczego nie kopiuje i niczego nie zapisuje.
- Start odmawia otwarcia bazy nowszej niż kod, bazy o innej historii migracji, bazy o schemacie innym niż ten, który zostawiają migracje, oraz bazy wymagającej migracji, gdy workspace jest otwarty w innym procesie.
- Przebudowa tabeli (zmiana CHECK, klucza albo NOT NULL) ma jedną procedurę: migracja usuwa wszystkie wyzwalacze, których tekst wymienia tabelę, także te na innych tabelach, a po zmianie nazwy odtwarza je razem z indeksami. Odcisk schematu po takiej migracji musi się zgadzać z zapisanym.
- Obsługa sygnałów jest rejestrowana przed zajęciem portu. Otwarcie bazy i migracja są synchroniczne, więc sygnał, który przyjdzie w ich trakcie, czeka do końca migracji; potem serwer zamyka bazę i kończy pracę z kodem 0, nie wypisując adresu. `SIGKILL` w trakcie migracji zostawia bazę w stanie sprzed startu.
- Uchwyt Drizzle (`Db`) powstaje w `src/server/db/handle.ts` z połączenia, które oddaje `openWorkspaceDatabase()`; innej drogi do bazy nie ma (linter). Tabel `workspace_pin` i `schema_migrations` nie deklaruje się w schemacie Drizzle, a `PRAGMA user_version` należy do warstwy workspace'u.
- Każde zatwierdzenie na tym połączeniu czeka na dysk i trwa około 3 ms, więc zapisy, które należą do siebie, idą w jednej transakcji.
- Stan nazwany w indeksie częściowym zapisuje się w zapytaniu tekstem SQL, nie parametrem: z parametrami licznik Inboxu czyta całą tabelę operacji (zmierzone: 129 ms zamiast 0,2 ms). Gotowe warunki są w `src/server/db/schema/predicates.ts`.
- Testy zapytań i operacji dostają bazę w pamięci z `createTestDatabase()`, zbudowaną przez te same migracje; testy pliku bazy, migracji z kopią i startu serwera używają workspace'u w katalogu tymczasowym.
- Generator danych syntetycznych w skali z NFR-6 (`src/server/db/synthetic`, `npm run synthetic`) i pomiar wydajności (`npm run perf`, poza `npm run check`). W `npm test` sprawdzane są plany zapytań i liczba zatwierdzeń, bez zegara.
- Generator nadaje części itemów datę rozpoczęcia i termin, części dat dokładność, części zadań oznaczenie kamienia milowego i zapisuje zmiany dat w dzienniku; zadania układa w drzewa różnej głębokości, do ośmiu poziomów pod szczytem, a część zadań przenosi później pod inny item, z jednym skutkiem w dzienniku. Kondycję ma większość projektów i mniej więcej co dziesiąte zadanie, także podzadanie i kamień milowy; części ocenionych zadań generator nadaje ją albo zmienia dopiero później, osobną operacją z jednym skutkiem w dzienniku. Odczyty wierszy wykresu Gantta, miesiąca kalendarza projektu, kamieni milowych widoku „Dziś" i listy według terminu mają testy planów. Odczyt obejmujący item ze wszystkim, co zawiera, jest rekurencyjny: zaczyna od jednego itemu i schodzi po `parent_id` przez indeks `items_by_parent`, poziom po poziomie, a z resztą zapytania łączy się tak, żeby drzewo było liczone najpierw (`CROSS JOIN` z drzewem na pierwszym miejscu albo `WHERE id IN (SELECT id FROM tree)`). Rekurencyjne drzewo złączone zwykłym `JOIN` planista zamienia na przejście całej tabeli (zmierzone dla drzewa pięciu wierszy: 0,46 ms zamiast 0,007 ms przy 8,5 tys. itemów i 0,76 ms przy 14 tys.). Ścieżkę itemów nadrzędnych jednego itemu odczyt wyznacza w górę, po kluczu głównym; dla listy jedno zapytanie zbiera itemy stojące nad jej wierszami, każdy raz, a ścieżki składa z nich kod, bo przejście w górę osobno dla każdego wiersza kosztuje tyle, ile wynosi suma głębokości wierszy. Zapytanie to zaczyna od warunków indeksu aktywnych itemów, bez warunku na `parent_id`: z nim planista wybiera indeks `items_by_parent` i czyta wszystkie itemy, które mają item nadrzędny. Testy planów dopuszczają przejście całej tabeli tylko tam, gdzie odczyt je deklaruje: itemy zamknięte w ostatnich 30 dniach, osoby do indeksu agenta i log wywołań modelu.
- Dla późniejszych pakietów: lista `READS` w `src/server/db/perf/reads.ts` zawiera zapytania widoków, każde z pakietem, który je zbuduje, i z testem planu; pakiety biorą zapytania stamtąd albo poddają własne temu samemu testowi. Wypełnioną bazę do testów daje `createSyntheticTestDatabase()` (`src/server/db/synthetic/testing.ts`), a `checkInvariants()` sprawdza na dowolnej bazie reguły, których nie pilnuje żadne ograniczenie, w tym zgodność skutków operacji z tabelami stanu. `npm run db:fixture` zapisuje małą wypełnioną bazę bieżącej wersji schematu w `src/server/db/fixtures`; test migracji doprowadza każdą taką bazę do bieżącego schematu i sprawdza liczby wierszy, klucze obce oraz reguły harmonogramu i hierarchii. Plik powstaje raz, dopóki jego wersja jest najnowsza.
- **Gotowe, gdy:** migracja na pustej i na wypełnionej bazie przechodzi, a kopia powstaje przed każdym startem, który migruje.

### M1a-5 Framework operacji (L)

**Wymagania:** ING-5, ING-6, ING-7, ING-8, AUD-1, AUD-2.

- Rejestr operacji z Załącznika A PRD. Każda ma schemat, walidację kontekstową, zastosowanie i cofnięcie.
- Uchwyt bazy (`Db`) powstaje raz, w `run-server.ts`, przez `createDb(opened.database)`, i jest przekazywany jako argument. Zapytania przyjmują `Db`, zastosowanie i cofnięcie operacji `Tx`; transakcja jest synchroniczna i nie obejmuje wywołania modelu. Od tego pakietu serwer ładuje `drizzle-orm`, co wydłuża każdy start procesu w testach o około 0,2 s.
- Cykl życia: odłożona, zaproponowana, zastosowana, odrzucona, cofnięta, niepoprawna.
- Cyklu życia operacji pilnują wyzwalacze z `M1a-4`, a framework zamienia ich błąd (`SQLITE_CONSTRAINT_TRIGGER`) na własny. Operacja przebiegu jest wstawiana jako odłożona przy działającym przebiegu, operacja bez przebiegu jako zastosowana; cofnięcia nie da się cofnąć, a cofniętej operacji zastosować ponownie; krawędzie zależności dodaje się i usuwa tylko przy operacji nierozstrzygniętej.
- Zatwierdzenie przebiegu: po `finish` każda odłożona operacja jest stosowana albo trafia do Inboxu zgodnie z polityką.
- Polityka stosowania jako czysta funkcja odwzorowująca tabelę z PRD, pokryta testami dla każdej komórki.
- Zabezpieczenie pochodzenia: operacja może mieć pochodzenie „polecenie" tylko wtedy, gdy wskazany cytat polecenia występuje w tekście wpisanym przez użytkownika.
- Zabezpieczenie pewności: pewność `wysoka` zostaje utrzymana tylko wtedy, gdy cytat zawiera nazwę lub alias celu i alias jest jednoznaczny w katalogu. W przeciwnym razie kod obniża ją do `niska`.
- Sprawdzenia deterministyczne: cytat występuje w źródle po normalizacji białych znaków i cudzysłowów; wskazane obiekty istnieją albo są odłożone w tym samym przebiegu; daty są poprawne; hierarchia pozostaje poprawna: item nadrzędny nie jest scalony, projekt nie dostaje itemu nadrzędnego, zadanie nie trafia pod siebie ani pod item, który zawiera, a po operacji żaden item nie leży głębiej niż `MAX_ITEM_DEPTH` poziomów pod szczytem drzewa (stałą, równą 32, ten pakiet dodaje w `src/shared/vocabulary.ts`; przy przeniesieniu liczy się także to, co item zawiera; baza tego limitu nie pilnuje).
- Zależności między operacjami z kaskadową akceptacją i odrzuceniem.
- Cofanie: w odwrotnej kolejności zawsze; poza kolejnością wtedy, gdy późniejsze operacje nie dotknęły tych samych pól. W pozostałych przypadkach jedno działanie cofa cały łańcuch zależnych zmian.
- Odwrotność skutków jednej operacji na jednym wierszu to jedno `UPDATE`, a odwrotność łańcucha operacji na jednym wierszu też jest jednym poleceniem: każde pole dostaje wartość sprzed najstarszego skutku w łańcuchu, wartości pośrednich się nie zapisuje, a wiersz utworzony w łańcuchu jest usuwany. Kolumny związane ograniczeniem liczą się przy cofaniu poza kolejnością jako jedno pole: `status` z `closed_at`; `kind` z `parent_id`; `my_role` z `my_role_set_on`; `external_system` z `external_key`; w harmonogramie itemu, parami, a nie jako jedna grupa: `start_on` ze `start_on_precision`, `due_on` z `due_on_precision` oraz `is_milestone` ze `start_on` i z `kind`; w faktach `outdated_at` z `superseded_by_fact_id`; we wzmiankach `person_id` ze `skipped_at`. Łańcuch wyznacza się na podstawie skutków, przed pierwszym poleceniem cofnięcia: operacji, po której obowiązuje późniejsza zmiana tego samego albo związanego pola, nie cofa się pojedynczo, także wtedy, gdy baza przyjęłaby samą jej odwrotność. Błąd ograniczenia `CHECK` albo wyzwalacza, który dotyczy kolumn jednego wiersza, oznacza podczas cofania brak pary na tej liście: całe cofnięcie jest wycofywane i zgłaszane, a łańcucha nie poszerza się metodą prób.
- Hierarchia wiąże miejsce itemu z miejscami innych itemów i nie jest parą z tej listy. Cofnięcie, które zapisuje więcej niż jeden wiersz tabeli itemów, zapisuje je w kolejności drzewa, które przywraca: najpierw polecenia `UPDATE`, od wierszy położonych najpłycej w przywracanym drzewie, a na końcu polecenia `DELETE` cofanych utworzeń, od itemów położonych najgłębiej. Baza sprawdza cykl przy każdym zapisywanym wierszu, więc w innej kolejności odrzuca także cofnięcie, którego wynik jest poprawnym drzewem; z tego samego powodu jedno `UPDATE` nie zmienia itemu nadrzędnego kilku itemów leżących jeden nad drugim. Cofnięcie, które przywraca itemowi dawny item nadrzędny, baza odrzuca, gdy ten item nadrzędny leży teraz pod cofanym itemem, został scalony albo nie istnieje; cofnięcie utworzenia itemu odrzuca, dopóki coś pod nim leży. Te odmowy nie oznaczają brakującej pary. Framework wykrywa je na przywracanym drzewie przed pierwszym poleceniem: cofnięcie jest odrzucane w całości, a właściciel dowiaduje się, które obowiązujące operacje stoją na przeszkodzie (przeniesienia itemów leżących między dawnym itemem nadrzędnym a cofanym itemem, scalenie, operacja, która umieściła item pod nieistniejącym itemem nadrzędnym, operacje, które umieściły coś pod itemem, którego utworzenie jest cofane), i może cofnąć je razem z wybraną operacją tym samym działaniem; pokazuje je podgląd łańcucha. Cofnięcie nigdy nie zostawia cyklu.
- Wartości skutków nie zawierają kolumn pochodnych (`*_norm`, `last_activity_at`, `source_kind`); wiersz odtwarzany ze skutku dostaje `*_norm` z bieżącej funkcji `foldName()`. Scalanie przenosi wiersze, a `merged_into_id` ustawia na końcu; jego cofnięcie zdejmuje to oznaczenie najpierw. Test odtwarza skutki w kolejności identyfikatorów i porównuje wynik z tabelami stanu.
- Ręczne edycje użytkownika jako operacje z pochodzeniem „użytkownik".
- Baza odmawia nowych i przenoszonych wierszy scalonego itemu i scalonej osoby, ale przyjmuje zmianę pól samego scalonego wiersza. Framework sam sprawdza `merged_into_id` celu operacji `update_item`, `update_person` i zmiany opisu, zanim ją zastosuje, i kieruje operację do itemu albo osoby, z którymi cel scalono.
- Zanim powstanie pierwszy wiersz z nazwą: wersja reguł zwijania nazw (`FOLD_VERSION`) jest zapisywana w bazie przy jej tworzeniu i porównywana przy otwarciu. Zmiana reguł to migracja danych napisana w kodzie, która przelicza kolumny `*_norm` i rozstrzyga kolizje w unikalnych indeksach aliasów; pakiet ustala, gdzie taka migracja jest uruchamiana.
- Zapytanie zbudowane przez Drizzle i niewykonane (bez `.run()`, `.all()`, `.get()` albo `.values()`) niczego nie zapisuje i nie zgłasza błędu, a linter ani kontrola typów tego nie widzą. Test każdej operacji odczytuje więc zapisany wiersz. Zapytanie zakończone metodą `.execute()` albo poprzedzone `await` zgłasza błąd w miejscu wywołania i wymienia cztery dozwolone zakończenia: odmowę nakłada `src/server/db/handle.ts`, bo bez niej `.execute()` zwraca na tym sterowniku obietnicę, więc odmowa bazy nie jest zgłaszana w miejscu wywołania, a zapis może się wykonać po zakończeniu transakcji.
- Operacja `create_item` zawsze zapisuje ważność: gdy propozycja jej nie podaje, kod wstawia `DEFAULT_ITEM_IMPORTANCE` z `src/shared/vocabulary.ts`, bo kolumna nie ma wartości domyślnej w bazie. Zmiana ważności jest polem operacji `update_item`.
- Item nadrzędny jest polem operacji `create_item` i `update_item`. Przeniesienie zapisuje tylko `parent_id` przenoszonego itemu i ma jeden skutek; to, co item zawiera, przenosi się razem z nim bez własnych skutków. Typ itemu (`project` albo `task`) nadaje `create_item`; żadna operacja M1 nie zmienia typu istniejącego itemu.
- Operacja `create_item` zawsze zapisuje `is_milestone` (0, gdy propozycja go nie podaje), bo kolumna nie ma wartości domyślnej w bazie. Termin jest w operacjach `create_item` i `update_item` od początku obiektem z dniem, który pakiet `M1a-16` rozszerza o dokładność, formy względne i przesunięcie.
- **Gotowe, gdy:** dla każdej operacji test „zastosuj, potem cofnij" przywraca stan wyjściowy, a przerwany przebieg nie zostawia żadnej zmiany.

### M1a-6 Warstwa LLM i pętla agenta (L)

**Wymagania:** ING-9; podstawa dla NFR-11.

- Klienta SDK buduje wyłącznie `createLlmClient()` z `M1a-3`. Model roli podaje `modelFor()`, a funkcje opcjonalne `capabilitiesOf()`; funkcja opcjonalna jest włączana tylko dla roli, której model jest tym, dla którego wykonano diagnostykę.
- Definicje narzędzi generowane ze schematów operacji.
- Pętla zgodna z regułami warstwy LLM z rozdziału 2: strumieniowanie, walidacja wejścia każdego narzędzia, błąd walidacji odsyłany jako wynik z `is_error`, limit iteracji i czasu.
- Protokół zakończenia: gdy model kończy turę bez `finish`, dostaje jedno przypomnienie; kolejny brak kończy przebieg błędem.
- Pętla rozróżnia błędy spoza SDK: `CredentialError` (nie udało się zdobyć poświadczenia; komunikat jest dla użytkownika), status 300–399 (endpoint przekierowuje, czyli adres jest błędny) i `EndpointPinError` (błąd w kodzie, bez ponowień). Test `src/server/egress.test.ts` dostaje ścieżkę użytkownika z wywołaniem modelu, a sprawdzenie na końcu testów end-to-end (`e2e/egress.ts`) zaczyna dopuszczać połączenia z endpointem workspace'u.
- Każdy tekst błędu, który jest zapisywany albo pokazywany, przechodzi przez `redact()` dostawcy poświadczeń. Klient sam czyści treść i nagłówki odpowiedzi z błędem, także z poświadczenia zapisanego sekwencjami JSON lub URL; nie czyści odpowiedzi udanych ani zdarzenia `error` wewnątrz strumienia o statusie 200. Postaci, które zmieniają wartość w całości (base64, skrót, fragment), nie są rozpoznawane.
- Do `client.withOptions()` ani do pojedynczego żądania nie przekazuje się `fetch` ani `middleware`: `fetch` wywołującego zastąpiłby ten przypięty do endpointu.
- Klient otwiera jedno połączenie na wywołanie, prosi o odpowiedź bez kompresji i odrzuca skompresowaną; router, który kompresuje mimo to, wymaga dopisania dekompresji.
- Prompt systemowy: rola, zasady PRD, definicja pewności, obowiązek cytatu, traktowanie materiału jako danych.
- Budowa kontekstu: stały prompt, migawka indeksu aktywnych itemów i osób, bieżąca data w wiadomości użytkownika. Materiał jest wyraźnie oddzielony od tekstu wpisanego. Indeks podaje dla każdego itemu typ i item nadrzędny jako osobne pola. Zamknięte itemy nadrzędne aktywnych itemów, aż do szczytu drzewa, też są w indeksie, z tytułem i statusem, żeby ścieżka każdego aktywnego itemu była w nim cała.
- Log każdego wywołania: model, tokeny, odczyty cache, czas, `stop_reason`, błąd.
- Model skryptowany dla testów: odtwarza zadane sekwencje odpowiedzi i wywołań narzędzi.
- Test odporności: materiał zawierający instrukcję nie powoduje operacji z pochodzeniem „polecenie".
- **Gotowe, gdy:** przebieg na prawdziwym modelu przez oba endpointy kończy się operacją `finish`, a kolejne żądania w przebiegu mają identyczny prefiks.

### M1a-7 Kolejka i przetwarzanie wrzutek (L)

**Wymagania:** CAP-5, CAP-6, CAP-7, ING-1, ING-2, ING-3, ING-4, ING-10, ING-11, NFR-7; uzupełnia ITM-4 o miejsce nowego zadania w hierarchii.

- Kolejka: dzierżawa zadania, ponowienia z rosnącym odstępem, wznowienie po restarcie, limit równoległości.
- Kolejka zakłada jeden proces na workspace. Dwa serwery na różnych portach mogą dziś otworzyć ten sam workspace; pakiet rozstrzyga, czy baza ma być otwierana na wyłączność (`PRAGMA locking_mode = EXCLUSIVE`), co odbiera dostęp narzędziom działającym w osobnym procesie.
- Zadanie wraca do stanu `queued` z licznikiem prób większym od zera; licznik rośnie w chwili podjęcia zadania, a reguła „jedno oczekujące zadanie na klucz" obejmuje tylko zadania jeszcze niepodjęte. Zadanie ma najwyżej jeden przebieg w toku: podjęcie zadania najpierw kończy przebieg zostawiony przez wcześniejszą próbę.
- Zapis wrzutki w oryginale przed jakimkolwiek przetwarzaniem; pliki adresowane skrótem treści.
- Transkrypcja obrazu osobnym wywołaniem: uczestnicy, znaczniki czasu, treść, widoczna data. Wynik zapisany jako tekst, na którym weryfikowane są cytaty.
- Ustalenie daty zdarzenia i oznaczenie jej jako przybliżonej, gdy źródło jej nie podaje.
- Datę zdarzenia wrzutki ustala operacja `set_capture_date` (Załącznik A PRD), ze skutkiem rodzaju `capture`; `M1a-5` dopisuje ją do `OPERATION_KINDS`. Transkrypcja zapisuje identyfikator swojego wywołania modelu (`capture_part_texts.model_call_id`), a wywołanie wersję promptu (`model_calls.prompt_version`). Zapis idempotentny najpierw sprawdza, czy wiersz istnieje: `INSERT OR IGNORE` i `ON CONFLICT DO NOTHING` na źródłach, częściach wrzutki, tekście pochodnym, faktach, przebiegach, operacjach i skutkach operacji kończą się błędem wyzwalacza.
- Przebieg przetwarzania: wyodrębnienie zadań, faktów, sygnałów zmiany statusu i wzmianek; przypisanie do zera, jednego lub wielu itemów; propozycja nowego itemu zamiast dopasowania na siłę.
- Agent proponuje ważność tylko wtedy, gdy wynika ona z materiału; w pozostałych przypadkach nowy item dostaje ważność normalną.
- Miejsce nowego zadania w hierarchii wskazuje agent: projekt, zadanie na dowolnym poziomie albo brak itemu nadrzędnego. Zachowuje poziomy, które podaje materiał, i nie zagnieżdża głębiej, niż z materiału wynika: gdy materiał nie mówi, pod którym zadaniem praca się mieści, nowe zadanie trafia bezpośrednio do projektu albo zostaje samodzielne.
- Kontrola duplikatów: przed `create_item` agent musi wyszukać podobne; kod odrzuca operację bez wcześniejszego wyszukania i dołącza kandydatów do propozycji. Wyniki wyszukiwania podają dla każdego itemu typ i item nadrzędny jako osobne pola, tak jak indeks (`M1a-6`).
- Ponowne przetworzenie: porównanie nowych operacji z już zastosowanymi po typie, celu i znormalizowanym cytacie; do Inboxu trafia tylko różnica.
- **Gotowe, gdy:** zabicie procesu w trakcie przetwarzania nie gubi wrzutki ani nie tworzy duplikatów po wznowieniu.

### M1a-8 API i zdarzenia na żywo (M)

**Wymagania:** podstawa dla NFR-5.

- Punkty API: wrzutki, przebiegi, karty Inboxu, decyzje o operacjach, cofanie, itemy, osoby.
- Strumień SSE ze zdarzeniami zmiany stanu przebiegów, kart i obiektów.
- Strumienie kończą się, gdy serwer zaczyna zamykanie. Otwarty strumień wstrzymuje dziś zamknięcie i każdy restart w trybie deweloperskim o pełny czas karencji (1 s).
- Stan połączenia strumienia może zastąpić w interfejsie odpytywanie `/api/health` co 5 s.
- W `scripts/dev.test.ts` jest już miejsce na test strumienia, który proxy trybu deweloperskiego zrywa, gdy serwer API pada w trakcie odpowiedzi: grupa, która uruchamia Vite z atrapą API.
- Odpowiedzi `/api` dostają domyślnie `Cache-Control: no-store`; trasa, która chce inaczej, ustawia nagłówek sama.
- Schematy żądań i odpowiedzi współdzielone z interfejsem.
- Kontrakty leżą w `src/shared` jako zwykłe typy i walidatory, importowane przez obie strony, tak jak dziś kontrakt `/api/health`. Typowany klient Hono odpada: wymaga importu typu aplikacji z `src/server`, a tego interfejsowi zabrania linter. Kontrakty `/api/health` i `/api/workspace` przechodzą na Zod razem z resztą. Origin endpointu w kontrakcie `/api/workspace` pozostaje przy tym wzorcem (wyrażeniem regularnym), bez `z.url()` i bez porównania przez `new URL`: serwer sprawdza swoją odpowiedź tym samym walidatorem co strona, a parsery adresów się różnią (Chromium zapisuje `*` w nazwie hosta jako `%2A`). Z tego samego powodu ścisła reguła nazwy workspace'u zostaje w walidatorze pliku konfiguracji, a kontrakt wymaga tylko nazwy niepustej: klasy znaków Unicode w wyrażeniach regularnych zależą od silnika.
- Content-Security-Policy nie zawiera `'unsafe-eval'`. Zod 4 (sprawdzone na 4.6.5) przy tworzeniu pierwszego schematu obiektu, czyli już podczas importu modułu ze schematami, sprawdza wywołaniem `new Function("")`, czy może generować kod. Przeglądarka blokuje to wywołanie i zgłasza zdarzenie `securitypolicyviolation`, ale niczego nie wypisuje w konsoli, więc dzisiejsze testy end-to-end tego nie zauważą. `z.config({ jitless: true })` musi się wykonać przed utworzeniem pierwszego schematu: w module `src/shared/zod.ts`, z którego wszystkie schematy biorą `z`; import `zod` z innego miejsca blokuje linter. Fixture testów end-to-end zgłasza każde zdarzenie `securitypolicyviolation`. `zod/mini` tej próby nie wykonuje wcale, a paczka jest z nim o około 50 kB mniejsza (14 kB po kompresji); wybór między nim a pełnym `zod` zapada razem ze schematami operacji.
- Testy planów zapytań (`EXPLAIN QUERY PLAN`) dla licznika i listy Inboxu oraz dla podjęcia zadania przez workera istnieją od `M1a-4`, dla zapytań z listy `READS` w `src/server/db/perf/reads.ts`. Pakiet bierze zapytania z tej listy albo poddaje własne temu samemu sprawdzeniu (`planProblems()`): plan nie może czytać całej tabeli operacji. Lista kart zaczyna od operacji (`CROSS JOIN` z przebiegami i źródłami); złączona zwykłym `JOIN` zaczyna od wszystkich przebiegów.
- **Gotowe, gdy:** zapis wrzutki zwraca odpowiedź w czasie do 300 ms na danych w skali z NFR-6.

### M1a-9 Powłoka aplikacji i pole wejściowe (M)

**Wymagania:** CAP-1, CAP-2, CAP-3, CAP-4, CFG-3, VIEW-3, NFR-9.

- Układ z nawigacją, stałym wskaźnikiem workspace'u i endpointu oraz licznikiem Inboxu.
- Wskaźnik workspace'u istnieje od `M1a-3` (`WorkspaceIndicator`); powłoka go przenosi. Powłoka i każdy późniejszy ekran czytają workspace przez hook `useWorkspace()` (`src/web/use-workspace.ts`), nie wprost z zapytania: hook zwraca stan oczekiwania, błąd albo potwierdzony workspace i to w nim mieszka reguła, że odpowiedź starsza niż nieudane sprawdzenie nie jest pokazywana. Gdy workspace zmieni się pod otwartą kartą (serwer uruchomiony ponownie z innym workspace'em), powłoka czyści dane i szkic wejścia poprzedniego workspace'u; workspace rozpoznaje po dacie utworzenia, którą `GET /api/workspace` zaczyna wtedy zwracać.
- Pole wejściowe dostępne na każdym ekranie: tekst wpisany, wklejanie obrazów, przeciąganie plików.
- Wklejony tekst powyżej ustalonej długości staje się osobnym elementem materiału; krótkie wklejenia zostają w tekście wpisanym.
- Wysłanie czyści pole natychmiast; lista wysłanych wejść pokazuje ich stan na żywo.
- Środowisko testów komponentów (jsdom) nie ma `EventSource`, więc testy listy słuchającej strumienia zdarzeń potrzebują jego atrapy.
- Interfejs po polsku, teksty w jednym pliku zasobów.
- **Gotowe, gdy:** trzy wejścia wysłane jedno po drugim są widoczne ze stanami, zanim pierwsze skończy się przetwarzać.

### M1a-10 Inbox (L)

**Wymagania:** INB-1, INB-2, INB-3, INB-4, INB-5.

- Karta na wrzutkę: podgląd źródła, sekcja zmian zastosowanych automatycznie z cofaniem, propozycje, pytania.
- Komponent prezentacji dla każdego typu operacji, z cytatem i uzasadnieniem.
- Propozycja nowego zadania pokazuje jego miejsce w hierarchii: ścieżkę itemów nadrzędnych, od szczytu drzewa do itemu, pod którym zadanie powstanie, albo informację, że zadanie będzie samodzielne. Przepięcie propozycji pozwala wskazać item nadrzędny na dowolnym poziomie.
- Akcje: zaakceptuj, zmień pola i zaakceptuj, przepnij do innego itemu, odrzuć, zaakceptuj wszystko.
- Pytania o niejednoznaczność z kandydatami oraz opcjami „nowy" i „pomiń".
- Widoczna zależność między propozycjami i kaskada przy decyzji.
- Wrzutka dostępna w podglądzie i wyszukiwaniu niezależnie od stanu karty.
- **Gotowe, gdy:** kartę z pięcioma propozycjami da się rozstrzygnąć jednym działaniem, a rozstrzygnięta karta znika i zmniejsza licznik.

### M1a-11 Projekty i zadania (L)

**Wymagania:** ITM-1, ITM-2, ITM-3, ITM-4, ITM-5, ITM-6, ITM-7, ITM-8, ITM-10, ITM-11, ITM-13, EDT-1, EDT-2, EDT-3, EDT-4.

- Lista z filtrami: typ, projekt, item nadrzędny, status, ważność, moja rola, osoba, kondycja, brak aktywności od N dni; listę można uporządkować według ważności. Filtr projektu obejmuje wszystko, co projekt zawiera, na każdej głębokości (odczyt rekurencyjny z `M1a-4`), a filtr itemu nadrzędnego itemy bezpośrednio pod nim; wiersz zadania, które ma item nadrzędny, pokazuje ścieżkę itemów nadrzędnych.
- Strona itemu: nagłówek z edycją pól, w tym statusu, kondycji (projektu i zadania) i ważności, i ze ścieżką itemów nadrzędnych, osoby i oczekiwania, sekcje faktów według typu, podzadania, oś czasu, źródła. Lista podzadań pokazuje itemy bezpośrednio podrzędne (na stronie projektu jego zadania), każdy z odnośnikiem do własnej strony, i pozwala dodać kolejny: tak powstaje podzadanie na dowolnym poziomie.
- Fakt pokazuje źródło i cytat; fakt można oznaczyć jako nieaktualny i wskazać następcę.
- Oś czasu łączy fakty, zmiany pól i źródła; filtr „od daty".
- Historia itemu jest czytana stronami: pełna historia największego itemu w danych z NFR-6 przekracza przy pierwszym odczycie 300 ms. Zapisy opisu z jednej sesji edycji łączą się w jedną operację.
- Edytor TipTap dla opisu: zakres z EDT-1, zapis automatyczny, wklejanie Markdownu i tabel.
- Środowisko testów komponentów (jsdom) nie ma funkcji układu, po które sięga TipTap, między innymi `Range.getClientRects` i `document.elementFromPoint`; testy edytora potrzebują ich zaślepek w `src/web/test/setup.ts`. jsdom nie liczy układu strony, więc to, co od niego zależy, sprawdza dopiero test w przeglądarce.
- Scalanie itemów oraz przenoszenie faktów i źródeł, z możliwością cofnięcia.
- Nagłówek strony zadania pozwala zmienić item nadrzędny: zmiana przenosi zadanie razem ze wszystkim, co zawiera, jedną operacją `update_item` (`M1a-5`). Wybór nowego itemu nadrzędnego nie obejmuje samego zadania ani itemów, które zawiera, a projekt nie ma tego pola. Scalenie przenosi itemy bezpośrednio podrzędne scalanego itemu pod item, z którym jest scalany; scalenie itemu z itemem, który sam zawiera, jest odrzucane z wyjaśnieniem.
- **Gotowe, gdy:** dla itemu ze zmianami w trzech różnych dniach filtr „od daty" pokazuje dokładnie zmiany od wskazanego dnia; podzadanie utworzone pod podzadaniem ma własną stronę ze ścieżką itemów nadrzędnych, a przeniesienie zadania do innego projektu przenosi wszystko, co zawiera, i cofa się jednym działaniem.

### M1a-12 Podsumowanie stanu (S)

**Wymagania:** ITM-9.

- Zadanie kolejki uruchamiane po zmianach itemu, z opóźnieniem łączącym serie zmian.
- Model zwraca tekst i identyfikatory faktów, na których się oparł; kod odrzuca nieistniejące identyfikatory.
- Oznaczenie „wygenerowane" z datą i ręczne odświeżenie.
- Podsumowanie nie jest przekazywane do przetwarzania jako źródło.
- **Gotowe, gdy:** każde zdanie podsumowania ma odnośnik do istniejącego faktu lub pola.

### M1a-13 Podstawowy katalog osób i zasilenie początkowe (M)

**Wymagania:** PER-4, PER-5, CAP-8.

- Lista osób i formularz: imię i nazwisko, aliasy, rola, zespół, relacja, notatka.
- Pierwsze uruchomienie tworzy osobę oznaczoną jako „ja".
- Atrybuty wywnioskowane przez agenta trafiają do Inboxu jako propozycje.
- Zasilenie: wklejona lista osób i projektów daje jedną kartę ze zbiorczą akceptacją.
- **Gotowe, gdy:** lista dwudziestu osób i dziesięciu projektów zostaje utworzona po jednej akceptacji, bez duplikatów.

### M1a-14 Dziennik zmian i usuwanie (M)

**Wymagania:** AUD-3, AUD-4, NFR-4.

- Widok dziennika z filtrami: data, item, osoba, rodzaj operacji, sposób zatwierdzenia.
- Cofanie z poziomu dziennika, z podglądem łańcucha zależnych zmian.
- Trwałe usunięcie wrzutki lub dokumentu razem z plikami, z pytaniem o los faktów pochodnych.
- Kopie sprzed migracji w `backups/` zawierają treść wrzutek usuniętych później: trwałe usunięcie (AUD-4) usuwa także te pliki, razem z niedokończonymi kopiami (`*.sqlite.partial` i ich pliki `-journal`), które zostają po przerwanym starcie. Procedura najpierw oznacza wiersz źródła jako usunięty, potem usuwa wszystko, co niesie jego tekst: cytaty faktów, wzmianki, wartości skutków jego operacji (`scrubbed`), teksty tych operacji (cytat, cytat polecenia, uzasadnienie, odpowiedź, adnotacje, problemy i obie treści, ze znacznikiem `scrubbed_at`), teksty jego przebiegów, tekst pochodny, części wrzutki, wrzutkę i plik, o ile nie używa go część innej wrzutki, a na końcu wykonuje punkt kontrolny dziennika WAL. Baza wymusza początek tej kolejności: cytat faktu, części wrzutki i tekst pochodny dają się usunąć dopiero po oznaczeniu źródła, plik dopiero wtedy, gdy nie używa go żadna część, a wiersze rejestru źródeł i przebiegów nie są usuwane nigdy.
- **Gotowe, gdy:** po usunięciu wrzutki jej treść i pliki nie występują w bazie, w katalogu plików, w kopiach w `backups/` ani w indeksie wyszukiwania.

### M1a-15 Zestaw regresyjny syntetyczny (M)

**Wymagania:** NFR-11.

- Format przypadku: stan początkowy, wejście, oczekiwane operacje, operacje niedozwolone.
- Od 25 do 40 przypadków: brak powiązania, jeden item, wiele itemów, nowy item, duplikat, niejednoznaczny cel, daty względne, zrzut ekranu bez daty, instrukcja ukryta w materiale, tekst mieszany polsko-angielski, nowe zadanie pod istniejącym podzadaniem, zadania, których materiał nie zagnieżdża.
- Program uruchamiający liczy: trafność i kompletność powiązań, liczbę błędnych operacji, liczbę błędnych zastosowań automatycznych, czas i tokeny.
- Ten sam program obsługuje korpus rzeczywisty z `M0-3` w workspace służbowym.
- Każdy plik `*.test.ts` poza `e2e/` uruchamia się w `npm test`, także w `evals/`; przypadki wołające prawdziwy model potrzebują więc innego przyrostka albo jawnego wykluczenia w `vitest.config.ts`. O tym, który projekt TypeScript sprawdza nowy plik, decyduje sama ścieżka: pliki w `evals/` obejmuje `tsconfig.node.json` bez żadnego wpisu.
- **Gotowe, gdy:** wynik bazowy jest zapisany dla obu endpointów.

### M1a-16 Harmonogram: pola i operacje (M)

**Wymagania:** SCH-1, SCH-2; uzupełnia ITM-1, ITM-7 i ITM-11 o pola harmonogramu.

- Pakiet zaczyna się od próby na prawdziwym modelu: przypadki harmonogramu z danymi syntetycznymi, na endpoincie Anthropic, w dwóch kształtach wejścia daty: dzień wyliczony przez model, z dniem tygodnia do sprawdzenia, oraz forma względna, którą rozwiązuje kod. Wynik próby jest zapisany obok przypadków; kształt wejścia operacji i potwierdzenie reguł dat przez właściciela zapadają po niej.
- Operacje `create_item` i `update_item` przyjmują datę rozpoczęcia, termin, dokładność każdej z dat i oznaczenie kamienia milowego. Oznaczenie jest w obu operacjach osobnym polem (tak albo nie), a nie częścią tytułu ani typu itemu. Operacja, która zmienia kilka z tych pól jednego itemu, zapisuje je jednym `UPDATE`; datę zapisuje zawsze razem z jej dokładnością. Nadanie oznaczenia kamienia milowego usuwa datę rozpoczęcia itemu w tym samym `UPDATE`, z osobnym skutkiem.
- Arytmetykę dat wykonuje kod. Dla dokładności do okresu wystarczy dowolny dzień tego okresu: kod zamienia go na pierwszy dzień okresu dla daty rozpoczęcia albo ostatni dla terminu (`periodStart()` i `periodEnd()` z `src/shared/time.ts`; tydzień zaczyna się w poniedziałek i kończy w piątek). Kształt domyślny, do potwierdzenia w próbie: dzień tygodnia („w piątek", „w przyszły czwartek") i liczbę dni („jutro", „za 3 dni") agent podaje jako formę względną, a kod liczy dzień od dnia odniesienia, który sam wybiera według pochodzenia operacji: datę dodania dla polecenia, datę zdarzenia źródła dla materiału. Przesunięcie agent podaje w dniach, tygodniach albo miesiącach; nową datę liczy kod od wartości zapisanej w itemie, a operacja zapisuje dzień wynikowy, podaną formę i dzień, od którego liczono. Przesunięcie daty znanej z dokładnością do okresu oraz przesunięcie o miesiące dają datę przybliżoną. Operacja nie zawiera słów źródła: wyrażenie daty jest w cytacie.
- Sprawdzenie „daty są poprawne" (ING-8) obejmuje: datę rozpoczęcia nie późniejszą niż termin, gdy operacja agenta sama podaje obie daty (ręczną zmianę obu dat w tej kolejności aplikacja zapisuje z ostrzeżeniem); brak daty rozpoczęcia przy kamieniu milowym; brak oznaczenia kamienia milowego w projekcie; formę względną z materiału dopiero po ustaleniu daty zdarzenia w tym samym przebiegu; jedną zmianę danego pola daty danego itemu na przebieg. Zmiana, która nie zmienia żadnej wartości, jest odrzucana. Przesunięcie daty, której item nie ma, jest odrzucane z wyjaśnieniem: zamiast daty agent zapisuje w itemie fakt typu `ryzyko` z cytatem. Data rozpoczęcia późniejsza niż termin zapisany w itemie nie jest błędem: operacja dostaje oznaczenie (SCH-4).
- Wynik odłożenia operacji z datą podaje modelowi zapisany dzień każdej daty razem z dniem tygodnia.
- Operacja zmieniająca datę pamięta wartości, które zastała. Gdy przy stosowaniu zapisane wartości są inne, ręczna zmiana jest odrzucana, a propozycja agenta dostaje oznaczenie.
- Ręczna zmiana kilku pól itemu w jednym działaniu, np. obu dat, jest jedną operacją z pochodzeniem „użytkownik", ze skutkiem dla każdego zmienionego pola.
- Uzupełnienie `src/shared/time.ts` o przesunięcie o miesiące, dni robocze i dni tygodnia względem dnia odniesienia. Reguła zaległości (termin przybliżony dopiero po trzech dniach roboczych) jest jedną funkcją w `src/shared`. Daty z dokładnością wypisuje jeden moduł etykiet (np. „ok. 15.11.2026", „listopad 2026", „Q1 2027").
- Strona itemu: nagłówek z edycją daty rozpoczęcia i terminu z ich dokładnością oraz oznaczenia kamienia milowego; ostrzeżenie o dacie rozpoczęcia późniejszej niż termin nie blokuje zapisu. Oś czasu pokazuje zmiany daty rozpoczęcia, terminu i oznaczenia kamienia milowego z obiema wartościami. Kamień milowy ma przy tytule znak kamienia milowego: w nagłówku strony i na liście podzadań.
- Lista itemów: filtry „kamienie milowe" i „termin w zakresie dat" oraz porządek według terminu; kamień milowy ma na liście ten sam znak co na stronie itemu.
- **Gotowe, gdy:** ręczna zmiana obu dat jest jednym wpisem dziennika i jednym cofnięciem; nadanie oznaczenia kamienia milowego zadaniu z okresem usuwa datę rozpoczęcia, a cofnięcie ją przywraca; termin podany jako dowolny dzień listopada z dokładnością do miesiąca jest zapisany jako 30 listopada; lista z filtrem terminu pokazuje dokładnie itemy z terminem w zadanym zakresie.

### M1a-17 Harmonogram: wyodrębnianie i propozycje (L)

**Wymagania:** SCH-3, SCH-4; uzupełnia ING-1 i CAP-7 oraz SCH-2 o oznaczenie w indeksie i na karcie propozycji.

- Wiadomość z materiałem podaje datę dodania z dniem tygodnia i wykaz dni ośmiu tygodni wokół niej, a zapisaną datę zdarzenia źródła tylko wtedy, gdy ustaliło ją wcześniejsze przetwarzanie. Datę zdarzenia nowej wrzutki ustala operacja tego samego przebiegu (`M1a-7`); od niej liczone są daty względne z materiału, a wynik jej odłożenia podaje jej dzień tygodnia. Indeks aktywnych itemów zawiera datę rozpoczęcia, termin, ich dokładność i oznaczenie kamienia milowego jako osobne pole każdego itemu. To samo pole mają itemy w wynikach wyszukiwania podobnych (`M1a-7`). Prompt systemowy zawiera reguły dat z PRD (SCH-3).
- Wyodrębnianie elementów harmonogramu: termin, data rozpoczęcia, okres, kamień milowy, przesunięcie. Okres agent podaje jako dowolny jego dzień z dokładnością, a nie jako samodzielnie wyliczoną granicę.
- Kamieniem milowym jest zdarzenie albo stan do osiągnięcia, a nie praca do wykonania; w razie wątpliwości element harmonogramu jest zadaniem. Wyrażenie bez dnia i bez okresu oraz zależność od innej pracy nie dają daty; zależność jest faktem itemu, który czeka, a gdy takiego itemu nie ma, agent proponuje go bez dat. Agent nie proponuje dat dla itemów, o których materiał nie mówi, ani nie przelicza itemów zależnych.
- Gdy materiał podaje dla tej samej daty itemu różne dni, agent proponuje dzień uzgodniony w rozmowie albo zapisuje fakt typu `pytanie` z oboma dniami.
- Kontrola duplikatów: przed utworzeniem kamienia milowego kod dołącza do kandydatów na duplikat wszystkie otwarte kamienie milowe tego samego drzewa, czyli projektu albo samodzielnego zadania ze wszystkim, co zawiera, niezależnie od tytułu.
- Ponowne przetworzenie: dla zmian dat porównanie z operacjami tego samego źródła obejmuje, oprócz typu, celu i znormalizowanego cytatu, także wyliczony dzień i jego dokładność, więc po zmianie daty zdarzenia wrzutki do Inboxu trafiają zmienione daty jako różnica. Materiał, który powtarza zapisaną datę, nie daje operacji.
- Przesunięcie daty dostaje oznaczenie możliwego powtórzenia, gdy to samo źródło zmieniło już to pole tego itemu albo gdy w ostatnich 14 dniach zastosowano przesunięcie tego samego pola tego itemu o tyle samo.
- Propozycja z datą ma postać jednego wiersza: pole, wartość obecna, wartość nowa z dniem tygodnia, różnica w dniach i cytat. Pochodzenie obecnej wartości (źródło i jego data zdarzenia albo ręczna zmiana z dniem) i dzień, od którego liczono, karta pokazuje po rozwinięciu oraz zawsze wtedy, gdy datę wyliczono (data względna, przesunięcie) albo propozycja ma oznaczenie. Pochodzenie to najnowszy obowiązujący skutek tego pola w `operation_effects`, a gdy pole nie było zmieniane, skutek utworzenia itemu. Dla określenia „przyszły" z dniem tygodnia karta pokazuje także najbliższy taki dzień. Wiersz propozycji, która tworzy kamień milowy albo go dotyczy, ma znak kamienia milowego.
- Oznaczenia propozycji: materiał starszy niż najnowszy fakt itemu albo niż ustalenie, z którego pochodzi obecna wartość; wartość wyjściowa zmieniona od chwili powstania propozycji; możliwe powtórzenie przesunięcia; data rozpoczęcia późniejsza niż termin. Oznaczonej propozycji nie obejmuje „zaakceptuj wszystko". Przy akceptacji można zmienić daty, ich dokładność i oznaczenie kamienia milowego.
- Gdy data zdarzenia źródła jest przybliżona, karta z datami liczonymi od niej zaczyna się pytaniem o datę zdarzenia. Odpowiedź ustala datę zdarzenia operacją użytkownika, a kod przelicza daty czekających propozycji tego źródła; propozycja, która po przeliczeniu niczego nie zmienia, znika.
- Wklejony plan (lista lub tabela z datami) daje jedną kartę ze zbiorczą akceptacją. Agent zachowuje poziomy planu (ITM-4): item z wiersza podrzędnego powstaje pod itemem z wiersza, pod którym stoi, a jego utworzenie zależy od utworzenia tamtego.
- Zestaw regresyjny (`M1a-15`) dostaje przypadki harmonogramu: termin względny; okres nazwany (tydzień, miesiąc, kwartał, półrocze); kamień milowy; przesunięcie liczone od zapisanej daty; przesunięcie itemu bez daty; data przybliżona; przybliżona data zdarzenia; zależność bez daty i data zależna od spotkania bez daty; polecenie z materiałem o innej dacie; materiał starszy od zapisanej wartości i starszy plan po nowszym przesunięciu; data rozpoczęcia późniejsza niż zapisany termin; powtórzone przesunięcie; dwie różne daty tego samego terminu w jednym wątku; data bez roku na przełomie roku; dzień tygodnia podany w ten sam dzień tygodnia; wklejony plan z pięcioma wierszami, z czterema poziomami, które agent zachowuje, i z czterdziestoma wierszami; dwa przypadki spoza projektów informatycznych. Program liczy osobno trafność dat (dzień i dokładność), a dla wklejonego planu czas, tokeny i liczbę propozycji.
- **Gotowe, gdy:** wątek ze scenariusza 9.4 przetworzony prawdziwym modelem daje propozycje z dniami 16 października, 1 grudnia i 20 listopada 2026 i żadnej daty dla zdania o migracji danych; akceptacja każdej propozycji jest jednym wpisem dziennika, który da się cofnąć; karta zmiany terminu pokazuje wartość obecną, wartość nową z dniem tygodnia i różnicę w dniach; wklejony plan z czterema poziomami daje po zbiorczej akceptacji drzewo o tych samych czterech poziomach; na przypadkach harmonogramu trafność dat wynosi co najmniej 90%, a żadna operacja niedozwolona nie została zastosowana automatycznie.

### M1a-18 Wykres Gantta (M)

**Wymagania:** SCH-5, VIEW-2.

- Punkt API harmonogramu itemu: item i wszystko, co zawiera, na każdej głębokości, z itemem nadrzędnym, poziomem, oznaczeniem kamienia milowego, kondycją i właścicielem każdego wiersza, bez udziału modelu. Jedno rekurencyjne zapytanie (`M1a-4`) obsługuje wykres projektu, wykres zadania i kalendarz i zwraca wszystkie wiersze: drzewo 2440 wierszy na ośmiu poziomach odczytuje w około 4 ms, a typowy projekt, 89 wierszy, w 0,14 ms (zmierzone w pamięci).
- Uzupełnienie `src/shared/time.ts` o funkcje widoków (początek i koniec tygodnia i miesiąca, siatka miesiąca, numer tygodnia) oraz modułu etykiet o nazwy dni i miesięcy. Moduł etykiet pozostaje jedynym miejscem wywołań `Intl`, a zakresy dat składa kod, bez `formatRange`. Reguła lintera zabrania globalnego `Temporal` w `src/shared` i `src/web`.
- Widok na stronie projektu i zadania: zwykła tabela (tytuł, data rozpoczęcia, termin) i siatka dni obok. Pierwszym wierszem jest sam item, a kolejnymi wszystko, co zawiera, jako drzewo: wiersz stoi pod swoim itemem nadrzędnym, a jego tytuł ma wcięcie według głębokości. Okres jest paskiem, sam termin i sama data rozpoczęcia znacznikiem, kamień milowy punktem, a kondycja itemu znakiem przy tytule wiersza; okres, którego oba końce pochodzą z jednego nazwanego okresu, jest jaśniejszym pasmem z nazwą okresu; data rozpoczęcia późniejsza niż termin to dwa znaczniki z oznaczeniem sprzeczności. Linia dnia dzisiejszego; trzy wyglądy statusu (otwarte, zrobione, zablokowane); wyróżnienie itemów zaległych i dat przybliżonych. Stanów nie oznacza sam kolor, a tytuł i daty są czytelne bez najechania.
- Wykres obejmuje itemy otwarte oraz zrobione, których dzień mieści się w zakresie wykresu; itemu anulowanego nie pokazuje, chyba że stoi nad wierszem wykresu. Item nadrzędny każdego wiersza też jest wierszem, aż do itemu wykresu: gdy sam nie ma dat, jest anulowany albo zamknięty poza zakresem wykresu, wiersz ma sam tytuł, bez paska i znacznika. Sekcja „Bez dat" pod wykresem wymienia pozostałe otwarte itemy bez dat, każdy z cytatem jego najnowszego faktu. Kamień milowy ma przy tytule ten sam znak co na liście itemów (`M1a-16`), w tabeli wykresu i w sekcji „Bez dat", więc widać go także wtedy, gdy nie ma jeszcze terminu.
- Skale wykresu: tygodnie, miesiące i dopasowanie do szerokości; przewijanie z przyklejonym nagłówkiem, przycisk „Dziś", zwijanie i rozwijanie każdej gałęzi drzewa. Pasek i znacznik są przyciskami z opisem słownym; Enter albo kliknięcie tytułu otwiera item.
- Geometria (dzień na kolumnę, zakres dni, kolejność wierszy, poziomy nagłówka) to czyste funkcje testowane bez przeglądarki; położenie paska sprawdza test komponentu, a układ i przyklejone nagłówki test w przeglądarce, bo jsdom ich nie liczy.
- **Gotowe, gdy:** na wykresie projektu pasek zadania z okresem 19–30 października 2026 zajmuje kolumny od 19 do 30 października włącznie, zadanie z samym terminem ma znacznik w kolumnie terminu, kamień milowy z datą przybliżoną punkt w swoim dniu, zadanie bez dat, które nie zawiera itemu z datą, stoi w „Bez dat", a linia dnia dzisiejszego w kolumnie dzisiejszej daty; wykres zadania pokazuje w ten sam sposób wszystko, co zadanie zawiera; zadanie z czwartego poziomu hierarchii jest wierszem pod swoim itemem nadrzędnym, a zwinięcie gałęzi ukrywa wszystkie wiersze pod nią; wykres największego projektu z danych syntetycznych ładuje się w czasie z NFR-5.

### M1a-19 Wykres Gantta: zmiany ręczne (S)

**Wymagania:** SCH-6.

- Okno dialogowe itemu na harmonogramie (natywny `<dialog>` z polami daty i wyborem dokładności): dodanie zadania pod itemem wykresu albo pod dowolnym jego wierszem, czyli także podzadania na każdym poziomie, z oznaczeniem kamienia milowego jako osobnym polem okna; ustawienie, zmiana i usunięcie daty rozpoczęcia i terminu z ich dokładnością. Otwiera się z wiersza, z pustego miejsca wykresu i z sekcji „Bez dat". Formularz dat jest tym samym komponentem co w nagłówku strony itemu (`M1a-16`).
- Każde zatwierdzenie okna to jedna operacja użytkownika (`create_item` albo `update_item`) z wartościami, które okno zastało; odpowiedź o datach zmienionych w międzyczasie odświeża widok. Po zmianie komunikat z przyciskiem „Cofnij".
- Przeciąganie pasków należy do `M2-11`.
- **Gotowe, gdy:** kamień milowy dodany na wykresie jest w dzienniku i znika po cofnięciu; zmiana obu dat zadania jest jednym wpisem dziennika; zadanie z okresem dodane na wykresie pojawia się jako pasek bez przeładowania strony; podzadanie dodane z wiersza podzadania pojawia się pod tym wierszem.

### M1a-20 Kalendarz projektu (M)

**Wymagania:** SCH-7, VIEW-2.

- Widok miesiąca na stronie projektu: tydzień od poniedziałku, dzień dzisiejszy wyróżniony, weekendy przyciemnione; w dniu terminy, daty rozpoczęcia i kamienie milowe projektu oraz wszystkiego, co projekt zawiera, na każdej głębokości. Pozycja kamienia milowego ma własny znak, inny niż termin i data rozpoczęcia. Okres jest widoczny jako dwa końce, nie jako pas. Nadmiar pozycji pod „+N więcej"; poprzedni i następny miesiąc, przycisk „Dziś".
- Pozycje z dokładnością do miesiąca lub dłuższego okresu stoją w pasku „Bez dnia" nad siatką miesiąca, w którym leży ich zapisany dzień, a nie w komórce tego dnia. Data przybliżona i data znana co do tygodnia stoją w swoim dniu z etykietą.
- Kalendarz korzysta z punktu API i etykiet z `M1a-18` i wybiera pozycje, których data rozpoczęcia albo termin leży w miesiącu. Z pozycji można otworzyć item.
- **Gotowe, gdy:** termin, data rozpoczęcia i kamień milowy z jednego miesiąca są widoczne w swoich dniach, termin znany co do miesiąca stoi w pasku „Bez dnia", a kamień milowy dodany na wykresie Gantta pojawia się w kalendarzu bez przeładowania strony.

### M1a-21 Domknięcie i tydzień użycia (M)

**Wymagania:** NFR-5, NFR-8.

- Test end-to-end scenariusza 9.1.
- Test end-to-end scenariusza 9.4.
- Wszystkie projekty Playwrighta (Chromium, WebKit i opcjonalny Google Chrome) korzystają z jednej instancji serwera i jej danych, więc test zapisujący dane zobaczy też to, co ten sam test zapisał w innej przeglądarce.
- Pomiar czasów z NFR-5 na danych w skali z NFR-6.
- Polecenie kopii zapasowej katalogu workspace'u i sprawdzone odtworzenie z kopii.
- Polecenie kopii robi migawkę przez SQLite (`VACUUM INTO` albo API kopii), nie kopię plików: kopia samego `hubber.sqlite` wykonana przy działającej aplikacji może nie zawierać ostatnich zapisów.
- Odtworzenie wstawia kopię w miejsce całego katalogu workspace'u i nigdy nie kopiuje plików do istniejącego. Obok odtworzonego `hubber.sqlite` nie mogą zostać pliki `hubber.sqlite-wal` i `hubber.sqlite-shm` poprzedniego stanu: SQLite stosuje taki dziennik do odtworzonej bazy przy pierwszym otwarciu (sprawdzone: wraca wtedy zapis zrobiony po wykonaniu kopii, a aplikacja startuje bez słowa).
- Polecenie kopii korzysta z `snapshotWorkspaceDatabase()` z `src/server/workspace/database.ts` i pomija katalog `backups/`; polecenie odtworzenia przyjmuje także migawki sprzed migracji.
- Tydzień codziennego użycia w workspace służbowym; lista błędów i tarć.
- **Gotowe, gdy:** warunek zamknięcia M1a jest spełniony, a błędy blokujące poprawione.

## 7. M1b — osoby i notatki

**Cel:** mam historię rozmów z każdą osobą, a notatki ze spotkań łączą się z projektami, których dotyczyły.

**Warunek zamknięcia:** scenariusz 9.2 przechodzi end-to-end; tydzień codziennego użycia.

| ID | Pakiet | Rozmiar | Zależy od |
|---|---|---|---|
| M1b-1 | Próba techniczna: zakotwiczenie fragmentów | S | M1a-11 |
| M1b-2 | Rozpoznawanie osób | L | M1a-13 |
| M1b-3 | Strona osoby i scalanie | M | M1b-2 |
| M1b-4 | Model notatki i edytor | L | M1b-1 |
| M1b-5 | Notatka z pola wejściowego | M | M1b-4 |
| M1b-6 | Fragmenty | L | M1b-4 |
| M1b-7 | Ekstrakcja z notatek i ponowna analiza | M | M1b-6 |
| M1b-8 | Notatki na stronach itemu i osoby | S | M1b-6, M1b-3 |
| M1b-9 | Regresja notatek i tydzień użycia | M | wszystkie |

### M1b-1 Próba techniczna: zakotwiczenie fragmentów (S)

- Prototyp znacznika fragmentu w TipTap: zakres obejmujący kilka akapitów, edycja wewnątrz i obok, dzielenie akapitu, wklejanie, cofanie w edytorze.
- Prototyp segmentacji zdań z regułą dla polskich skrótów („np.", „tzn.", „godz.").
- **Gotowe, gdy:** jest decyzja, czy znacznik w treści wystarcza, zapisana w rozdziale 2 tego dokumentu.

### M1b-2 Rozpoznawanie osób (L)

**Wymagania:** PER-1, PER-2, PER-3.

- Model podaje dla każdej wzmianki formę podstawową i proponowaną osobę; kod sprawdza jednoznaczność aliasu w katalogu.
- Aliasy z kontekstem; przy tworzeniu osoby agent proponuje zdrobnienia jako aliasy.
- Pytanie w Inboxie przy wielu lub zerze kandydatów; odpowiedź zapisywana jako alias; „pomiń" jednorazowo albo zawsze.
- Wzmianka nierozstrzygnięta jako tymczasowe odwołanie w operacjach. Po rozstrzygnięciu zależne operacje uzupełniają się same.
- **Gotowe, gdy:** formy „Kasi", „Kasią" i „@knowak" trafiają do tej samej osoby, a dwie osoby o tym samym imieniu zawsze dają pytanie.

### M1b-3 Strona osoby i scalanie (M)

**Wymagania:** PER-6, PER-7.

- Sekcje: profil, co ona jest mi winna, co ja jestem jej winien, itemy z rolą, notatki, wzmianki we wrzutkach.
- Obie listy spraw otwartych jako zapytania według definicji z PER-6.
- Scalanie osób z przeniesieniem aliasów i powiązań, z możliwością cofnięcia.
- **Gotowe, gdy:** po scaleniu dwóch osób wszystkie ich notatki, role i wzmianki są pod jedną, a cofnięcie przywraca stan sprzed scalenia.

### M1b-4 Model notatki i edytor (L)

**Wymagania:** NOT-1, NOT-2, NOT-9, NOT-11.

- Tabele: notatki, uczestnicy, fragmenty. Notatka i fragment są też wierszami rejestru źródeł (`sources`), a powiązanie fragmentu z itemem jest wierszem powiązań źródeł (`source_links`), nie osobną tabelą.
- Edytor notatki z polami: tytuł, data zdarzenia, rodzaj, uczestnicy.
- Wzmianki `@osoba` i `#item` jako węzły z identyfikatorem. Wzmianka osoby tworzy rozstrzygnięte powiązanie, a wzmianka itemu wiąże otaczający blok z itemem.
- Tworzenie notatki ze strony osoby, ze strony itemu i z listy notatek, z ustawionymi powiązaniami.
- Lista notatek z filtrami: osoba, item, rodzaj, zakres dat.
- **Gotowe, gdy:** notatka utworzona ze strony osoby ma ją jako uczestnika bez udziału modelu.

### M1b-5 Notatka z pola wejściowego (M)

**Wymagania:** NOT-2, NOT-3.

- Operacja `create_note` przyjmuje metadane i zakres tekstu źródłowego; treść przenosi kod, konwertując Markdown mechanicznie.
- Pierwotny materiał zostaje jako wrzutka powiązana z notatką.
- Wklejony transkrypt lub podsumowanie spotkania przechodzi tą samą ścieżką.
- **Gotowe, gdy:** test porównujący tekst notatki z tekstem wejścia przechodzi znak po znaku.

### M1b-6 Fragmenty (L)

**Wymagania:** NOT-4, NOT-5, NOT-8, NOT-10.

- Segmentacja notatki na zdania z indeksami przekazywanymi modelowi.
- Operacja `set_fragments`: zakresy zdań i powiązane itemy; kod nakłada znaczniki i zapisuje migawkę tekstu fragmentu.
- Prezentacja w edytorze: oznaczenie zakresu i etykiety powiązanych itemów.
- Ręczna zmiana: utworzenie fragmentu z zaznaczenia, zmiana zakresu, dodanie i usunięcie itemu.
- Przy zapisie porównanie tekstu fragmentu z migawką; zmiana lub zniknięcie fragmentu oznacza fakty pochodne jako „źródło zmienione".
- Wklejanie usuwa znaczniki fragmentów z wklejanej treści.
- **Gotowe, gdy:** akapit z trzema tematami zostaje podzielony na trzy fragmenty, a edycja jednego nie zmienia powiązań pozostałych.

### M1b-7 Ekstrakcja z notatek i ponowna analiza (M)

**Wymagania:** NOT-7, ING-11.

- Przetwarzanie notatki wyodrębnia zadania i fakty ze źródłem ustawionym na konkretny fragment.
- Daty względne liczone od daty zdarzenia notatki.
- Elementy harmonogramu z fragmentów notatek są wyodrębniane według tych samych reguł dat (SCH-3).
- Ponowna analiza na żądanie proponuje tylko nowe fragmenty, powiązania i fakty.
- **Gotowe, gdy:** dopisanie akapitu do przeanalizowanej notatki i ponowna analiza dają propozycje wyłącznie dla nowego akapitu.

### M1b-8 Notatki na stronach itemu i osoby (S)

**Wymagania:** NOT-5, NOT-6.

- Strona itemu pokazuje tylko powiązane fragmenty, z datą, uczestnikami i odnośnikiem do notatki.
- Strona osoby pokazuje całe notatki z etykietami itemów przy fragmentach.
- **Gotowe, gdy:** fragment bez powiązania nie pojawia się w odpowiedzi API żadnej strony itemu.

### M1b-9 Regresja notatek i tydzień użycia (M)

- Przypadki regresyjne: notatka o kilku projektach, fragment bez projektu, niejednoznaczny uczestnik, daty względne, transkrypt z innego narzędzia.
- Test end-to-end scenariusza 9.2, w tym wariant z dwiema pasującymi osobami.
- Tydzień użycia: notatka po każdym spotkaniu 1:1.
- **Gotowe, gdy:** warunek zamknięcia M1b jest spełniony.

## 8. M1c — rozmowa i przegląd

**Cel:** pytam o dowolny projekt lub osobę i zaczynam dzień od listy tego, co wymaga uwagi.

**Warunek zamknięcia:** scenariusz 9.3 przechodzi end-to-end; kryteria zakończenia M1 z PRD są spełnione.

| ID | Pakiet | Rozmiar | Zależy od |
|---|---|---|---|
| M1c-1 | Narzędzia odczytu | M | M1b |
| M1c-2 | Rozmowa: serwer | L | M1c-1 |
| M1c-3 | Rozmowa: interfejs | M | M1c-2 |
| M1c-4 | Widok „Dziś" | M | M1b |
| M1c-5 | Wyszukiwanie | M | M1b |
| M1c-6 | Dokumenty | M | M1c-5 |
| M1c-7 | Pomiar metryk | S | M1a-14 |
| M1c-8 | Regresja rozmowy i zamknięcie M1 | M | wszystkie |

### M1c-1 Narzędzia odczytu (M)

- Narzędzia z Załącznika A PRD: `search`, `get_item`, `get_person`, `get_note`, `list_items`, `read_source`, `read_document`.
- Zwarte wyniki ze stronicowaniem; każdy element niesie identyfikator do odnośnika.
- Przekroje przez parametry: filtr po osobie, zespole, roli, statusie; zmiany od wskazanej daty.
- `list_items` przyjmuje item nadrzędny (itemy bezpośrednio pod nim) albo item z całym jego drzewem, zakres dat (data rozpoczęcia lub termin w zakresie) i filtr kamieni milowych; `get_item` zwraca item ze ścieżką itemów nadrzędnych oraz itemy bezpośrednio pod nim z ich datami. Każdy item w wynikach narzędzi ma osobne pola: typ, item nadrzędny i oznaczenie kamienia milowego.
- **Gotowe, gdy:** pytania Q1–Q9 i Q11 z PRD da się obsłużyć samymi narzędziami odczytu.

### M1c-2 Rozmowa: serwer (L)

**Wymagania:** CHT-1, CHT-2, CHT-3, CHT-4, CHT-5.

- Rozmowy i wiadomości zapisywane z pełną treścią bloków, żeby historię dało się odesłać bez zmian.
- Kontekst otwartego widoku przekazywany jako pierwsza wiadomość rozmowy.
- Rotacja: nowa rozmowa po zmianie widoku, po przerwie w aktywności albo na żądanie.
- Polecenia jako operacje z pochodzeniem „polecenie", chronione zabezpieczeniem z `M1a-5`.
- Odnośniki w odpowiedzi w ustalonej notacji; kod weryfikuje, że wskazane obiekty istnieją.
- Notacja odnośników obejmuje widoki itemu: wykres Gantta i kalendarz. Na prośbę o harmonogram agent odpowiada zestawieniem z narzędzi odczytu i odnośnikiem do widoku; wykresu nie rysuje.
- Reguła w prompcie i test: przy braku danych agent to stwierdza i oddziela wnioski od faktów.
- Strumień zdarzeń: tekst, odczyty narzędzi, wykonane operacje.
- **Gotowe, gdy:** pytanie nie tworzy żadnej operacji zapisu, a polecenie tworzy operację widoczną w dzienniku.

### M1c-3 Rozmowa: interfejs (M)

**Wymagania:** CHT-1, CHT-5.

- Panel rozmowy na każdym ekranie, połączony z polem wejściowym.
- Odpowiedź strumieniowana; lista odczytów i zmian w trakcie; odnośniki jako klikalne etykiety.
- Wynik polecenia jako karta z możliwością cofnięcia.
- **Gotowe, gdy:** otwarcie strony projektu i pytanie „co tu się zmieniło w tym tygodniu" daje odpowiedź o tym projekcie bez podawania nazwy.

### M1c-4 Widok „Dziś" (M)

**Wymagania:** VIEW-1, VIEW-2.

- Zapytania: moje zadania na dziś i zaległe, najpierw o wyższej ważności; kamienie milowe z terminem na dziś i zaległe; zadania `czekam` według czasu oczekiwania; projekty zablokowane oraz projekty i zadania z kondycją żółtą lub czerwoną; itemy bez aktywności, z wyjątkiem itemów, których data rozpoczęcia jeszcze nie nadeszła, i kamieni milowych przed terminem; ostatnie notatki. Termin przybliżony jest oznaczany jako zaległy dopiero po trzech dniach roboczych.
- Próg braku aktywności w ustawieniach, domyślnie 14 dni.
- **Gotowe, gdy:** testy jednostkowe pokrywają każdą listę, a widok ładuje się w czasie z NFR-5.

### M1c-5 Wyszukiwanie (M)

**Wymagania:** VIEW-4.

- Jeden indeks pełnotekstowy dla itemów, faktów, notatek, wrzutek z transkrypcjami, dokumentów i osób, aktualizowany przy zapisie.
- Wyszukanie osoby przez aliasy zwraca jej stronę i materiały powiązane przez wzmianki.
- Strona wyników z podziałem na typy i szybkie przejście z klawiatury.
- **Gotowe, gdy:** zapytanie o imię w mianowniku znajduje notatkę, w której imię wystąpiło w narzędniku.

### M1c-6 Dokumenty (M)

**Wymagania:** DOC-1, DOC-2, PER-1.

- Przyjmowanie plików PDF, DOCX, Markdown, tekstowych i obrazów; oryginał w katalogu plików.
- Lokalne wyodrębnianie tekstu z podziałem na strony lub sekcje.
- Przypinanie dokumentu do itemu lub notatki; indeksowanie w wyszukiwaniu.
- Content-Security-Policy nie pozwala osadzić podglądu PDF (`object-src 'none'`) ani pokazać odpowiedzi aplikacji w ramce, także na własnej stronie (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), a `fetch()` adresów `blob:` i `data:` blokuje `connect-src 'self'`. Podgląd dokumentu musi się zmieścić w tych granicach albo wymaga zmiany decyzji z rozdziału 2.
- Narzędzie `read_document` czytające wskazany zakres.
- Rozpoznawanie w dokumencie osób obecnych w katalogu.
- **Gotowe, gdy:** agent odpowiada na pytanie o treść trzydziestostronicowego dokumentu, czytając tylko potrzebne strony.

### M1c-7 Pomiar metryk (S)

- Zapytania liczące metryki z rozdziału 12 PRD na podstawie tabel operacji, wrzutek i itemów.
- Metryka dat: udział zaakceptowanych propozycji z datą, w których dzień i dokładność pozostały takie, jak zaproponował agent (porównanie `payload` z `proposed_payload`); przeliczenie dat przez kod po ustaleniu daty zdarzenia nie jest zmianą właściciela.
- Prosty widok lub polecenie w terminalu pokazujące wartości dla wybranego tygodnia.
- **Gotowe, gdy:** wartości dla tygodni użycia M1a i M1b są policzone.

### M1c-8 Regresja rozmowy i zamknięcie M1 (M)

- Przypadki regresyjne: pytanie o obiekt, pytanie przekrojowe, pytanie bez odpowiedzi w danych, polecenie, polecenie ukryte w materiale.
- Test end-to-end scenariusza 9.3.
- Przypadki regresyjne harmonogramu w rozmowie: prośba o harmonogram projektu, pytanie o najbliższy tydzień, polecenie przesunięcia daty.
- Diagnostyka na obu endpointach i tydzień codziennego użycia.
- Przegląd: metryki, lista odstępstw od PRD, decyzja o M2 według kryterium zatrzymania.
- **Gotowe, gdy:** kryteria zakończenia M1 z PRD są spełnione.

## 9. M2 — proaktywność i wiedza

**Cel:** hub sam podpowiada, co wymaga uwagi, i przygotowuje do spotkań.

**Warunek wejścia:** M1 zamknięte i kryterium zatrzymania z PRD niespełnione.

**Warunek zamknięcia:** metryki z rozdziału 12 PRD osiągają cele przez dwa kolejne tygodnie.

Kolejność pakietów ustala się po przeglądzie M1 na podstawie listy tarć z tygodni użycia.

| ID | Pakiet | Wymagania | Rozmiar |
|---|---|---|---|
| M2-1 | Ergonomia wprowadzania i Inboxu | CAP-9, CAP-10, INB-6 | M |
| M2-2 | Pamięć korekt | ING-12 | M |
| M2-3 | Przygotowanie do spotkań | PER-8, PER-9, NOT-13 | L |
| M2-4 | Notatki: automatyczna analiza i wersje | NOT-12, EDT-5 | M |
| M2-5 | Sugestie agenta w treści | EDT-6 | L |
| M2-6 | Wiedza z dokumentów | DOC-3, PER-10 | M |
| M2-7 | Brief, przegląd tygodniowy, zmiany | PRO-1, PRO-2, PRO-3, VIEW-6 | M |
| M2-8 | Rozmowa: historia i szkice | CHT-6, CHT-7 | M |
| M2-9 | Wyszukiwanie odporne na odmianę | VIEW-5 | S |
| M2-10 | Eksploatacja: koszty i eksport | CFG-7, NFR-8 | S |
| M2-11 | Wykres Gantta: przeciąganie, przesuwanie z itemami podrzędnymi, przegląd projektów | SCH-8, SCH-10 | L |
| M2-12 | Zależności między itemami | SCH-9 | M |
| M2-13 | Kalendarz wszystkich projektów | SCH-11 | S |

### Zakres pakietów

- **M2-1:** ręczna poprawa transkrypcji z ponownym przetworzeniem; skrót otwierający pole wejściowe; wiele plików naraz; skróty klawiszowe i decyzje wsadowe w Inboxie.
- **M2-2:** zapis poprawek użytkownika jako przykładów i aliasów; dołączanie najbliższych przykładów do kontekstu przetwarzania; pomiar wpływu na zestawie regresyjnym.
- **M2-3:** lista „Do poruszenia" przy osobie; odhaczanie tematów w notatce; zestawienie przed spotkaniem zbudowane z zapytań i zredagowane przez model, z odnośnikiem przy każdym punkcie.
- **M2-4:** ponowna analiza po zakończeniu edycji, z opóźnieniem; historia wersji notatki i opisu z przywracaniem.
- **M2-5:** operacje wstawienia, zamiany i usunięcia bloku jako sugestie; widok różnicy; akceptacja pojedyncza i zbiorcza.
- **M2-6:** streszczenie i kluczowe fakty dokumentu z odnośnikiem do strony; sekcja „Wiedza" na stronie itemu; zbiorcze pytanie o nieznane osoby z dokumentu.
- **M2-7:** poranny brief i przegląd tygodniowy zbudowane z zapytań widoku „Dziś"; wyróżnienie przeterminowanych zadań `czekam`; widok „Co się zmieniło" dla zakresu dat.
- **M2-8:** lista zapisanych rozmów; szkice statusu, podsumowania tygodnia i wiadomości jako tekst do skopiowania.
- **M2-9:** dopasowanie form odmienionych dla zwykłych słów; ocena na liście zapytań zebranych w tygodniach użycia.
- **M2-10:** zużycie tokenów i koszt na dzień i rolę z logu wywołań; eksport całego workspace'u do Markdownu i JSON-u.
- **M2-11:** pakiet zaczyna się od jednodniowej próby, która rozstrzyga, czy gesty powstają na własnym mechanizmie, czy na gotowej bibliotece wykresu Gantta; przeciąganie i rozciąganie pasków oraz przenoszenie pozycji kalendarza, także z klawiatury, każde jako jedna operacja; dodawanie z dnia kalendarza i zmiana dat z pozycji; operacja `shift_item_dates`, która przesuwa item razem z itemami podrzędnymi na każdej głębokości jednym wpisem dziennika i z jednym cofnięciem; przegląd wszystkich aktywnych projektów na jednym wykresie; udogodnienia pominięte w M1: skala kwartałów, przechodzenie strzałkami między itemami, itemy anulowane i dawno zamknięte.
- **M2-12:** tabela zależności i operacja `set_item_dependency`; propozycje agenta z wyrażeń typu „po wdrożeniu płatności"; strzałki na wykresie; oznaczenie sprzeczności dat z zależnością i z terminem itemu nadrzędnego; aplikacja nie przesuwa dat sama.
- **M2-13:** kalendarz wszystkich aktywnych itemów, także tych bez projektu, z filtrem projektu i mojej roli oraz pozycją w nawigacji.

## 10. M3 — integracje i rozszerzenia

**Cel:** ograniczyć ręczne zasilanie tam, gdzie to bezpieczne.

Zakres i wycena powstają po M2. Każdy pakiet zaczyna się od rozpoznania.

| ID | Pakiet | Wymagania | Do rozpoznania przed wyceną |
|---|---|---|---|
| M3-1 | Odczyt z trackera | ITM-12 | Który tracker, dostęp do API, zakres pól, zasady firmy. |
| M3-2 | Wrzutka spoza aplikacji | CAP-11 | Obserwowany folder czy polecenie w terminalu; obsługa plików w trakcie zapisu. |
| M3-3 | Poufność notatek | NOT-14 | Które funkcje generują treść dla innych osób i jak wykluczać fragmenty. |
| M3-4 | Wyszukiwanie semantyczne | DOC-4 | Czy router udostępnia model osadzeń; czy wyszukiwanie pełnotekstowe faktycznie nie wystarcza. |
| M3-5 | Harmonogram: poślizg, widok tygodnia i historia, kopia i wydruk | SCH-12, SCH-13, SCH-14 | Których z tych funkcji brakuje po tygodniach użycia wykresu i kalendarza; czy obraz wykresu da się zrobić w przeglądarce, bez połączeń sieciowych. |

Zasada dla `M3-1`: synchronizacja jest jednokierunkowa, zmiany z trackera są operacjami z pochodzeniem „synchronizacja" i nie nadpisują faktów ani opisu.

## 11. Ryzyka wykonawcze

| Ryzyko | Kiedy się ujawni | Ograniczenie |
|---|---|---|
| Router odrzuca funkcję, na której opiera się rdzeń | M1a-1 | Diagnostyka jako pierwszy pakiet; rdzeń używa tylko funkcji, których wymaga Claude Code. |
| Router modyfikuje treść żądań i unieważnia bloki rozumowania | M1a-6 | Jednorazowe ponowienie bez bloków rozumowania; zdarzenie w logu; licznik w diagnostyce. |
| Cofanie zależnych operacji okazuje się zbyt złożone | M1a-5 | Reguła łańcucha z rozdziału 2; test „zastosuj, potem cofnij" dla każdej operacji. |
| Znacznik fragmentu nie przetrwa edycji w TipTap | M1b-1 | Próba techniczna przed budową notatek. |
| Przetwarzanie jest zbyt wolne, by Inbox był użyteczny | M1a-7 | Pomiar w `M1a-15`; niższy `effort` dla roli przetwarzania, jeśli diagnostyka go potwierdziła. |
| Jakość powiązań poniżej celu | M1a-15 | Zestaw regresyjny od M1a; poprawki promptu mierzone, nie oceniane na oko. |
| Migracja uszkadza prawdziwe dane | Od tygodnia użycia M1a | Kopia przed każdym startem, który migruje; sprawdzone odtworzenie w `M1a-21`. |
| Tydzień użycia się nie odbywa | Koniec każdego przyrostu | Tydzień jest warunkiem zamknięcia, nie zaleceniem; bez niego kolejny przyrost nie startuje. |
| Agent błędnie liczy daty | M1a-17 | Dni tygodnia, granice okresów i przesunięcia liczy kod; daty z wniosków agenta zawsze przez Inbox; próba na prawdziwym modelu przed ustaleniem kształtu wejścia (`M1a-16`); trafność dat mierzona osobno w zestawie regresyjnym. |
| Agent zagnieżdża zadania inaczej, niż wynika z materiału | M1a-7, M1a-17 | Przypadki regresyjne: plan z czterema poziomami, nowe zadanie pod istniejącym podzadaniem, zadania, których materiał nie zagnieżdża; nowy item z wniosku agenta zawsze przez Inbox, a propozycja pokazuje ścieżkę itemów nadrzędnych; walidacja operacji odrzuca drzewo głębsze niż `MAX_ITEM_DEPTH` poziomów (`M1a-5`); przeniesienie zadania jest jedną operacją, którą można cofnąć. |
| Harmonogram wydłuża pierwszy przyrost | M1a-16 do M1a-20 | Pięć pakietów to 11 z 52 punktów M1a i zależą tylko od pakietów M1a; gdy tydzień użycia M1a ma przyjść wcześniej, powstają po nim, a materiał z tego tygodnia jest przetwarzany ponownie. |
| Wykres dużego projektu jest zbyt wolny albo nieczytelny | M1a-18 | Pomiar na największym projekcie z danych syntetycznych; gałęzie drzewa zwinięte; rysowanie tylko widocznych wierszy, jeśli pomiar tego wymaga. |
| Gesty przeciągania przerastają wycenę | M2-11 | Okno dialogowe z `M1a-19` pozostaje pełną drogą bez przeciągania; próba na początku pakietu; każdy gest ma test w przeglądarce. |

## 12. Działania właściciela

Te kroki wymagają właściciela i nie da się ich zlecić.

| Kiedy | Działanie |
|---|---|
| Przed M1a-6 | Uruchomić diagnostykę z `M1a-1` na maszynie służbowej i przekazać plik wyniku. |
| Przed M1a-3 | Ustalić, jak router wydaje poświadczenia: stały token czy polecenie pomocnicze. |
| Po M1a-3 | Utworzyć workspace na maszynie służbowej (`npm run workspace:create`) z raportem diagnostyki. Sprawdzić tam, czy start nie jest odrzucany z powodu włączonej obsługi proxy Node'a (`NODE_USE_ENV_PROXY`, `--use-env-proxy`), czy w tamtejszej powłoce przechodzi `npm run check` (z obsługą proxy część testów zawodzi, a diagnostyka łączy się przez proxy, inaczej niż aplikacja) i czy katalog `~/Library/Application Support` nie jest objęty firmową synchronizacją lub kopią. |
| W trakcie M0 lub przed M1a-11 | Potwierdzić słowniki statusów, ważności, ról i typów faktów. |
| Po próbie z `M1a-16`, przed `M1a-17` | Potwierdzić reguły dat z PRD (rozdział 8.14) na podstawie wyniku próby: tydzień pracy od poniedziałku do piątku, „przyszły czwartek" jako czwartek następnego tygodnia, połowa miesiąca jako 15. dzień, czas trwania w tygodniach jako termin przybliżony, kwartały i półrocza według roku kalendarzowego, termin przybliżony zaległy po trzech dniach roboczych. |
| Koniec M1a, M1b, M1c | Tydzień codziennego użycia w workspace służbowym; lista błędów i tarć. |
| Koniec M1c | Przegląd metryk i decyzja o M2. |
| Przed M3 | Wybór trackera i sprawdzenie zasad firmy dla integracji. |
