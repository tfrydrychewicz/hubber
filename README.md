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

Aplikacja działa pod adresem http://127.0.0.1:4477 i jest dostępna wyłącznie z tego komputera. Port zmienia zmienna `HUBBER_PORT`.

## Praca nad kodem

| Polecenie | Co robi |
|---|---|
| `npm run dev` | Serwer API restartowany po zmianach oraz Vite z odświeżaniem na żywo, pod adresem http://127.0.0.1:5173. |
| `npm run check` | Linter, kontrola typów i testy. |
| `npm run format` | Formatowanie i automatyczne poprawki. |
| `npm run test:e2e` | Testy end-to-end w Chromium i WebKit; nie wchodzą w skład `npm run check`. Przed pierwszym uruchomieniem: `npm run test:e2e:install`. Z `HUBBER_E2E_CHROME=1` także w zainstalowanym Google Chrome. Port testów zmienia zmienna `HUBBER_E2E_PORT` (domyślnie 4478). |
| `npm run diagnose -- --help` | Diagnostyka endpointu LLM. |

Kontrolę typów uruchamia `npm run typecheck`, także w ramach `npm run check`. Samo `npx tsc --noEmit` niczego tu nie sprawdza, bo główny `tsconfig.json` zawiera tylko odwołania do projektów.
