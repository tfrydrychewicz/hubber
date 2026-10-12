# Hubber

Lokalny hub pracy engineering managera: własne zadania, projekty zespołu, osoby i notatki ze spotkań w jednym miejscu, z agentem AI, który porządkuje wrzucany materiał. Projekt jest we wczesnej fazie budowy.

- [docs/PRD.md](docs/PRD.md): wymagania produktu
- [docs/PLAN.md](docs/PLAN.md): plan wykonania i stan prac

## Wymagania

- macOS
- Node 26 (wersję wskazuje plik `.nvmrc`; przełącza ją `nvm use`)

## Uruchomienie

```bash
npm install
npm start
```

Aplikacja działa pod adresem http://127.0.0.1:4477 i jest dostępna wyłącznie z tego komputera. Port zmienia zmienna `HUBBER_PORT`. Przed pierwszym uruchomieniem trzeba utworzyć workspace.

## Workspace

Hubber trzyma dane w workspace'ie: jednym katalogu przypiętym do jednego endpointu LLM. Tworzy się go raz na każdym komputerze:

```bash
# bezpośrednie API Anthropic
npm run workspace:create -- --name "Dev" --kind anthropic

# firmowy router: adres, model i potwierdzone funkcje pochodzą z raportu diagnostyki
npm run diagnose
npm run workspace:create -- --name "Praca" --kind router --diagnostics diagnostics/<raport>.json
```

Domyślny katalog to `~/Library/Application Support/Hubber/workspaces/default`. Inny wskazuje zmienna `HUBBER_WORKSPACE` (pełna ścieżka) albo opcja `--dir`. W katalogu są: `workspace.json` (nazwa i profil LLM, bez poświadczeń), `hubber.sqlite` (baza) i `files/` (pliki). Modele i wynik diagnostyki zmienia się w pliku `workspace.json`; adres endpointu jest stały.

Po aktualizacji aplikacji, która zmienia schemat bazy, pierwszy start aktualizuje bazę. Najpierw zapisuje w katalogu `backups/` workspace'u kopię bazy sprzed zmiany (`before-<migracja>-<czas>.sqlite`) i wypisuje jej ścieżkę; zostawia pięć najnowszych kopii. Zatrzymaj wcześniej działającą aplikację: start, który musi zaktualizować bazę, odmawia, gdy workspace jest otwarty w innym procesie. Ctrl-C w trakcie aktualizacji zadziała dopiero po jej zakończeniu; pod `npm run dev` drugie Ctrl-C, naciśnięte co najmniej pół sekundy po pierwszym, przerywa aktualizację, a baza zostaje wtedy w stanie sprzed uruchomienia. Aplikacja nie otworzy bazy zaktualizowanej przez nowszą wersję kodu; wyjątkiem jest wersja sprzed pierwszej aktualizacji, która czyta z bazy tylko przypięcie.

Żeby wrócić do stanu sprzed aktualizacji, zatrzymaj aplikację i przenieś poza katalog workspace'u plik `hubber.sqlite`, a razem z nim pliki `hubber.sqlite-wal` i `hubber.sqlite-shm`, jeśli leżą obok (zostają po aplikacji, która nie zamknęła się poprawnie, a na dysku bez wolnego miejsca także po poprawnym zamknięciu; pozostawione przy odtworzonej bazie uszkodzą ją). Potem skopiuj na miejsce `hubber.sqlite` kopię wskazaną w komunikacie „Baza zaktualizowana. Kopia sprzed aktualizacji: …": plik `before-<migracja>-<czas>.sqlite` w `backups/` o nazwie z tego komunikatu, zwykle najnowszy. Taką bazę otworzy wersja aplikacji sprzed aktualizacji, a nowsza zaktualizuje ją ponownie i zrobi przy tym nową kopię. Zmiany zapisane po aktualizacji zostają tylko w przeniesionych plikach.

Workspace otwiera się tylko z endpointem, do którego został przypięty. Gdy zmienna `ANTHROPIC_BASE_URL` wskazuje inny adres, aplikacja kończy pracę z kodem 3 i niczego nie otwiera.

Kopia zapasowa to kopia całego katalogu wykonana przy zatrzymanej aplikacji. Przy działającej aplikacji obok bazy leżą pliki `hubber.sqlite-wal` i `hubber.sqlite-shm`, a kopia samego `hubber.sqlite` może nie zawierać ostatnich zapisów. Odtwarza się ją tak samo, w całości: przy zatrzymanej aplikacji usuń albo przenieś dotychczasowy katalog i wstaw kopię na jego miejsce. Nie kopiuj plików z kopii do istniejącego katalogu: jeśli zostały w nim pliki `hubber.sqlite-wal` i `hubber.sqlite-shm`, SQLite dopisze ich zawartość do odtworzonej bazy. Nie trzymaj workspace'u w katalogu synchronizowanym z chmurą (iCloud Drive, Dropbox) ani w repozytorium. Katalog `backups/` jest częścią workspace'u i trafia do kopii razem z resztą; kopie w nim zawierają także to, co później usunięto z bazy.

## Poświadczenia

Poświadczeń nie ma w workspace'ie ani w repozytorium. Aplikacja szuka ich po kolei w trzech miejscach i bierze pierwsze, które ma poświadczenie dla endpointu workspace'u:

1. Zmienne środowiskowe: `ANTHROPIC_API_KEY` (klucz w nagłówku `x-api-key`) albo `ANTHROPIC_AUTH_TOKEN` (token w nagłówku `Authorization`). Należą do adresu z `ANTHROPIC_BASE_URL`, a bez tej zmiennej do `https://api.anthropic.com`.
2. Plik `~/.config/hubber/credentials.json` (inny wskazuje zmienna `HUBBER_CREDENTIALS_FILE`), z wpisem dla adresu endpointu.
3. Polecenie pomocnicze zapisane w tym pliku, dla tokenów, które wygasają.

```bash
install -d -m 700 ~/.config/hubber
install -m 600 /dev/null ~/.config/hubber/credentials.json
```

```json
{
  "version": 1,
  "endpoints": {
    "https://api.anthropic.com": { "apiKey": "sk-ant-..." },
    "https://router.corp.example/llm": {
      "helper": { "command": ["/usr/local/bin/llm-token", "--audience", "llm"], "ttlSeconds": 900 }
    }
  }
}
```

Plik musi należeć do ciebie, mieć uprawnienia 600 i tylko jedną nazwę: plik z dowiązaniem twardym jest odrzucany, tak samo jak plik wskazany przez otwarty deskryptor (`/dev/stdin`) i plik leżący w repozytorium albo w katalogu workspace'u, jakkolwiek zapisać jego ścieżkę. Sprawdzane są właściciel i bity uprawnień; listy ACL (`chmod +a`) aplikacja nie widzi, a usuwa ją `chmod -N <plik>`. Wpis ma dokładnie jedno z pól: `apiKey`, `authToken` albo `helper`. Polecenie pomocnicze to lista: program z pełną ścieżką i jego argumenty. Jest uruchamiane bez powłoki i ma wypisać samo poświadczenie w jednej linii; potok zapisuje się jako `["/bin/sh", "-c", "..."]`. Aplikacja czeka tylko na samo polecenie: procesu, który ono zostawi w tle, nie zatrzymuje i na niego nie czeka. Wartość jest pamiętana przez `ttlSeconds` (domyślnie 300) i odnawiana wcześniej, gdy endpoint odpowie 401. Pliku `.env` aplikacja nie czyta.

## Połączenia wychodzące

Serwer łączy się wyłącznie z endpointem workspace'u: bezpośrednio, bez proxy i zawsze ze sprawdzeniem certyfikatu, nie podąża za przekierowaniami i nie wysyła telemetrii. Ani ustawienia proxy Node'a, ani zmienna `NODE_TLS_REJECT_UNAUTHORIZED` nie mają wpływu na te połączenia; własny urząd certyfikacji wskazuje zmienna `NODE_EXTRA_CA_CERTS`. Start jest mimo to odrzucany z kodem 2, gdy w procesie jest włączona obsługa proxy Node'a (zmienna `NODE_USE_ENV_PROXY=1` albo opcja `--use-env-proxy`, także w `NODE_OPTIONS` i w pliku konfiguracyjnym Node), gdy moduł wczytany przed aplikacją (`--require`, `--import`) podmienił domyślny mechanizm połączeń Node'a albo gdy przy endpoincie `https://` ustawiona jest zmienna `NODE_TLS_REJECT_UNAUTHORIZED=0`. Strona w przeglądarce łączy się tylko z własnym serwerem.

Poza tą gwarancją są: `npm install` i pobieranie przeglądarek do testów, zapytanie DNS o nazwę hosta endpointu, twoje polecenie pomocnicze, sama przeglądarka i polecenie `npm run diagnose`. Diagnostyka łączy się z endpointem wskazanym w środowisku albo w pliku ustawień Claude Code, wysyła wyłącznie dane syntetyczne i tak jak aplikacja nie podąża za przekierowaniami, ale w powłoce z włączoną obsługą proxy Node'a jej żądania idą przez proxy. Powiadomienia npm o nowych wersjach wyłącza plik `.npmrc`.

## Praca nad kodem

| Polecenie | Co robi |
|---|---|
| `npm run dev` | Serwer API restartowany po zmianach oraz Vite z odświeżaniem na żywo, pod adresem http://127.0.0.1:5173. |
| `npm run check` | Linter, kontrola typów i testy. |
| `npm run format` | Formatowanie i automatyczne poprawki. |
| `npm run test:e2e` | Testy end-to-end w Chromium i WebKit; nie wchodzą w skład `npm run check`. Przed pierwszym uruchomieniem: `npm run test:e2e:install`. Z `HUBBER_E2E_CHROME=1` także w zainstalowanym Google Chrome. Port testów zmienia zmienna `HUBBER_E2E_PORT` (domyślnie 4478). Serwer tych testów działa pod obserwatorem połączeń: przebieg kończy się błędem, jeśli serwer połączył się z czymkolwiek albo uruchomił inny program. |
| `npm run diagnose -- --help` | Diagnostyka endpointu LLM. |
| `npm run workspace:create -- --help` | Tworzenie workspace'u. |
| `npm run synthetic -- --scale small` | Wypełnia danymi syntetycznymi pusty workspace wskazany zmienną `HUBBER_WORKSPACE` (skale: `tiny`, `small`, `full`). Domyślnego workspace'u nie wypełnia nigdy. |
| `npm run perf` | Pomiar czasów zapisu, zapytań, kopii i migracji na danych syntetycznych w skali trzech lat. Tworzy jednorazowy workspace w katalogu tymczasowym (około 4 GB wolnego miejsca) i usuwa go po pomiarze; nie wchodzi w skład `npm run check`. |
| `npm run db:fixture` | Po dodaniu migracji: zapisuje małą wypełnioną bazę bieżącej wersji schematu do testów kolejnych migracji. |

`npm run dev` otwiera ten sam workspace co `npm start`. Do pracy nad kodem i do prób używaj osobnego workspace'u, nie codziennego:

```bash
export HUBBER_WORKSPACE="$(mktemp -d)/workspace"
npm run workspace:create -- --name "Próbny" --kind anthropic
npm run dev
```

Start aplikacji aktualizuje bazę workspace'u, który otwiera. Kod ze zmienionym schematem uruchamiaj więc najpierw na workspace'ie próbnym. Aktualizację kodu pobieraj przy zatrzymanym `npm run dev`: działająca sesja przeładuje serwer, gdy tylko zmieni się plik, który serwer importuje, i wtedy od razu zaktualizuje swój workspace.

W sesji agenta kodującego (zmienna `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` albo `AI_AGENT`) nie ma workspace'u domyślnego: `npm start`, `npm run dev` i `npm run workspace:create` kończą się kodem 2, dopóki katalogu nie wskaże zmienna `HUBBER_WORKSPACE` (przy tworzeniu także opcja `--dir`). Polecenie, które agent uruchomi bez tej zmiennej, nie trafi więc na twój codzienny workspace.

Testy, także end-to-end, tworzą własne workspace'y w katalogu tymczasowym. Nie otwierają domyślnego ani wskazanego zmienną `HUBBER_WORKSPACE` i nie używają twoich poświadczeń. Uruchamiaj je w powłoce, która nie włącza obsługi proxy Node'a (`NODE_USE_ENV_PROXY`): z nią żądania testów do lokalnego serwera idą przez proxy i część testów zawodzi.

Kontrolę typów uruchamia `npm run typecheck`, także w ramach `npm run check`. Samo `npx tsc --noEmit` niczego tu nie sprawdza, bo główny `tsconfig.json` zawiera tylko odwołania do projektów.
