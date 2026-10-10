# Plan wykonania: Hubber

| | |
|---|---|
| **Status** | Wersja robocza 0.1 |
| **Data** | 2026-10-09 |
| **Dokument nadrzędny** | [PRD.md](PRD.md) |

## 1. Cel i sposób użycia

Plan rozkłada wymagania z [PRD](PRD.md) na pakiety pracy ułożone w kolejności wykonania. Każdy pakiet ma identyfikator (np. `M1a-5`), listę wymagań PRD, które realizuje, zadania i warunek ukończenia. Pakiet jest pomyślany jako jedna jednostka zlecenia: da się go wykonać i odebrać samodzielnie.

Każde wymaganie z PRD jest przypisane do co najmniej jednego pakietu; identyfikator wymagania można wyszukać w tym dokumencie.

Plan nie podaje dat. Tempo zależy od czasu właściciela, a sztywne są tylko tygodnie używania, które zamykają każdy przyrost. Rozmiary pakietów są względne: **S** = 1 punkt, **M** = 2 punkty, **L** = 4 punkty.

## 2. Decyzje techniczne

Decyzje doprecyzowują rozdział 11 PRD. Zmiana którejkolwiek wymaga aktualizacji tego dokumentu.

| Obszar | Decyzja | Uzasadnienie |
|---|---|---|
| Repozytorium | Jeden pakiet TypeScript z katalogami `src/shared`, `src/server`, `src/web`, `evals`, `scripts`. | Jeden użytkownik i jeden proces; podział na pakiety nic nie daje. |
| Serwer | Node.js, Hono, nasłuch na 127.0.0.1. | Zwykły HTTP i SSE, łatwe do sprawdzenia narzędziem `curl`. |
| Interfejs | React, Vite, TanStack Query, Tailwind, TipTap. | Zgodnie z PRD; TipTap wymusza środowisko przeglądarkowe. |
| Baza | SQLite przez `better-sqlite3`, schemat i migracje w Drizzle. | Jeden plik, wbudowane FTS5, migracje w repozytorium. |
| Schematy | Zod jako jedno źródło: walidacja API, walidacja operacji i JSON Schema dla narzędzi modelu. | Model, serwer i interfejs nie mogą się rozjechać. |
| Mutacje | Każda zmiana danych, także ręczna edycja użytkownika, przechodzi przez framework operacji. | Jedna historia zmian dla osi czasu, dziennika i cofania. |
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
- Zmiana schematu ma migrację, a migracja wykonuje kopię pliku bazy przed uruchomieniem.
- Jeśli pakiet dotyka promptów, operacji lub modelu, zestaw regresyjny został uruchomiony i wynik zapisany.
- Ścieżkę użytkownika pakietu da się pokazać w działającej aplikacji.
- Wymagania PRD wymienione w pakiecie są spełnione albo odstępstwo jest zapisane w tym dokumencie.

### Poziomy testów

| Poziom | Zakres | Narzędzie |
|---|---|---|
| Jednostkowe | Polityka stosowania, walidacje, operacje (zastosuj i cofnij), segmentacja zdań, zapytania widoku „Dziś". | Vitest |
| Integracyjne | Pętla agenta, kolejka i API na bazie tymczasowej, ze skryptowanym modelem zamiast prawdziwego. | Vitest, model skryptowany |
| End-to-end | Scenariusze 9.1–9.3 z PRD w przeglądarce, ze skryptowanym modelem. | Playwright |
| Regresja | Jakość przetwarzania i rozmowy na prawdziwym modelu. | `evals/` |

### Dane i środowiska

- Workspace deweloperski używa bezpośredniego API Anthropic i wyłącznie danych syntetycznych.
- Workspace służbowy używa routera i istnieje tylko na maszynie służbowej.
- Od pierwszego tygodnia używania baza zawiera prawdziwe dane. Każda późniejsza zmiana schematu jest migracją w przód.
- Katalogi workspace'ów i pliki z poświadczeniami leżą poza repozytorium.

### Prompty

Prompty są plikami w repozytorium. Każdy przebieg zapisuje identyfikator wersji promptu i modelu, żeby wynik regresji dało się przypisać do konkretnej zmiany.

## 4. Mapa milestone'ów

| Etap | Cel | Pakiety | Punkty | Zamknięcie |
|---|---|---|---|---|
| **M0** | Sprawdzić nawyk i zebrać prawdziwy materiał | 4 | 5 | Przegląd po dwóch tygodniach |
| **M1a** | Rdzeń pętli: wrzutka, propozycje, projekty i zadania | 16 | 41 | Scenariusz 9.1 i tydzień użycia |
| **M1b** | Osoby i notatki powiązane z projektami | 9 | 22 | Scenariusz 9.2 i tydzień użycia |
| **M1c** | Rozmowa, widok „Dziś", wyszukiwanie, dokumenty | 8 | 17 | Scenariusz 9.3, tydzień użycia, zamknięcie M1 |
| **M2** | Proaktywność i wiedza (wymagania P1) | 10 | 22 | Metryki z PRD przez dwa tygodnie |
| **M3** | Integracje i rozszerzenia (wymagania P2) | 4 | do wyceny | Do określenia po M2 |

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

- Wybrać 30–50 wrzutek i dla każdej zapisać oczekiwany wynik: projekty, osoby, zadania, fakty.
- **Gotowe, gdy:** korpus leży w katalogu workspace'u służbowego w formacie przyjętym w `M1a-15`.

### M0-4 Przegląd i decyzje (S)

- Porównać zebrane pytania z rozdziałem 5 PRD.
- Rozstrzygnąć otwarte pytania PRD o słowniki statusów i ról oraz o progi braku aktywności.
- **Gotowe, gdy:** PRD jest zaktualizowany, a decyzja o kontynuacji zapisana.

## 6. M1a — rdzeń pętli

**Cel:** wrzucam materiał, akceptuję propozycje, widzę projekty i zadania z osią czasu i źródłami.

**Warunek zamknięcia:** scenariusz 9.1 przechodzi end-to-end na zestawie syntetycznym; tydzień codziennego użycia w workspace służbowym bez utraty danych.

| ID | Pakiet | Rozmiar | Zależy od |
|---|---|---|---|
| M1a-1 | Diagnostyka endpointu | M | — |
| M1a-2 | Szkielet projektu | M | — |
| M1a-3 | Workspace i profile LLM | M | M1a-2 |
| M1a-4 | Schemat danych i migracje | M | M1a-2 |
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
| M1a-16 | Domknięcie i tydzień użycia | M | wszystkie |

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

- `git init`, `.gitignore` obejmujący katalogi workspace'ów i pliki środowiskowe.
- TypeScript w trybie `strict`, linter, Vitest, Playwright.
- Serwer Hono nasłuchujący wyłącznie na 127.0.0.1; aplikacja React serwowana przez ten sam proces w trybie produkcyjnym.
- Jedno polecenie instaluje zależności i jedno uruchamia aplikację.
- **Gotowe, gdy:** pusta aplikacja startuje jednym poleceniem na macOS w Chrome i Safari, a test sprawdza, że serwer nie nasłuchuje na innym interfejsie.

### M1a-3 Workspace i profile LLM (M)

**Wymagania:** CFG-1, CFG-2, CFG-3, CFG-4, CFG-6, NFR-1, NFR-2.

- Polecenie tworzące workspace: katalog, plik konfiguracji, pusta baza, katalog plików.
- Konfiguracja przechowuje nazwę, adres endpointu, rodzaj profilu, identyfikatory modeli dla ról i wynik diagnostyki. Nie przechowuje sekretów.
- Przypięcie: adres endpointu zapisany w konfiguracji i w bazie; przy starcie aplikacja porównuje go z aktywnym i odmawia otwarcia przy różnicy.
- Poświadczenia w kolejności: zmienne środowiskowe, plik lokalny poza repozytorium, polecenie pomocnicze z pamięcią podręczną i odświeżaniem.
- Punkt API zwracający nazwę workspace'u i endpoint dla interfejsu.
- Test sprawdzający, że aplikacja nie wykonuje połączeń poza skonfigurowany endpoint.
- **Gotowe, gdy:** workspace utworzony dla jednego endpointu nie otwiera się z innym; sekretu nie ma w bazie ani w katalogu workspace'u.

### M1a-4 Schemat danych i migracje (M)

**Wymagania:** model danych dla ITM-1 do ITM-6, NFR-6.

- Tabele: wrzutki i ich części, pliki, itemy, aliasy itemów, osoby, aliasy osób, role osób w itemach, wzmianki, fakty, powiązania źródeł, przebiegi, operacje, zadania kolejki, log wywołań modelu.
- Identyfikatory nadawane po stronie aplikacji, żeby operacje mogły się do nich odwoływać przed zapisem obiektu.
- Data ostatniej aktywności itemu utrzymywana przy każdej operacji.
- Migracje z automatyczną kopią pliku bazy.
- Generator danych syntetycznych w skali z NFR-6 do testów wydajności.
- **Gotowe, gdy:** migracja na pustej i na wypełnionej bazie przechodzi, a kopia powstaje przed każdą migracją.

### M1a-5 Framework operacji (L)

**Wymagania:** ING-5, ING-6, ING-7, ING-8, AUD-1, AUD-2.

- Rejestr operacji z Załącznika A PRD. Każda ma schemat, walidację kontekstową, zastosowanie i cofnięcie.
- Cykl życia: odłożona, zaproponowana, zastosowana, odrzucona, cofnięta, niepoprawna.
- Zatwierdzenie przebiegu: po `finish` każda odłożona operacja jest stosowana albo trafia do Inboxu zgodnie z polityką.
- Polityka stosowania jako czysta funkcja odwzorowująca tabelę z PRD, pokryta testami dla każdej komórki.
- Zabezpieczenie pochodzenia: operacja może mieć pochodzenie „polecenie" tylko wtedy, gdy wskazany cytat polecenia występuje w tekście wpisanym przez użytkownika.
- Zabezpieczenie pewności: pewność `wysoka` zostaje utrzymana tylko wtedy, gdy cytat zawiera nazwę lub alias celu i alias jest jednoznaczny w katalogu. W przeciwnym razie kod obniża ją do `niska`.
- Sprawdzenia deterministyczne: cytat występuje w źródle po normalizacji białych znaków i cudzysłowów; wskazane obiekty istnieją albo są odłożone w tym samym przebiegu; daty są poprawne.
- Zależności między operacjami z kaskadową akceptacją i odrzuceniem.
- Cofanie: w odwrotnej kolejności zawsze; poza kolejnością wtedy, gdy późniejsze operacje nie dotknęły tych samych pól. W pozostałych przypadkach jedno działanie cofa cały łańcuch zależnych zmian.
- Ręczne edycje użytkownika jako operacje z pochodzeniem „użytkownik".
- **Gotowe, gdy:** dla każdej operacji test „zastosuj, potem cofnij" przywraca stan wyjściowy, a przerwany przebieg nie zostawia żadnej zmiany.

### M1a-6 Warstwa LLM i pętla agenta (L)

**Wymagania:** ING-9; podstawa dla NFR-11.

- Klient SDK budowany z profilu workspace'u; funkcje opcjonalne włączane według wyniku diagnostyki.
- Definicje narzędzi generowane ze schematów operacji.
- Pętla zgodna z regułami warstwy LLM z rozdziału 2: strumieniowanie, walidacja wejścia każdego narzędzia, błąd walidacji odsyłany jako wynik z `is_error`, limit iteracji i czasu.
- Protokół zakończenia: gdy model kończy turę bez `finish`, dostaje jedno przypomnienie; kolejny brak kończy przebieg błędem.
- Prompt systemowy: rola, zasady PRD, definicja pewności, obowiązek cytatu, traktowanie materiału jako danych.
- Budowa kontekstu: stały prompt, migawka indeksu aktywnych itemów i osób, bieżąca data w wiadomości użytkownika. Materiał jest wyraźnie oddzielony od tekstu wpisanego.
- Log każdego wywołania: model, tokeny, odczyty cache, czas, `stop_reason`, błąd.
- Model skryptowany dla testów: odtwarza zadane sekwencje odpowiedzi i wywołań narzędzi.
- Test odporności: materiał zawierający instrukcję nie powoduje operacji z pochodzeniem „polecenie".
- **Gotowe, gdy:** przebieg na prawdziwym modelu przez oba endpointy kończy się operacją `finish`, a kolejne żądania w przebiegu mają identyczny prefiks.

### M1a-7 Kolejka i przetwarzanie wrzutek (L)

**Wymagania:** CAP-5, CAP-6, CAP-7, ING-1, ING-2, ING-3, ING-4, ING-10, ING-11, NFR-7.

- Kolejka: dzierżawa zadania, ponowienia z rosnącym odstępem, wznowienie po restarcie, limit równoległości.
- Zapis wrzutki w oryginale przed jakimkolwiek przetwarzaniem; pliki adresowane skrótem treści.
- Transkrypcja obrazu osobnym wywołaniem: uczestnicy, znaczniki czasu, treść, widoczna data. Wynik zapisany jako tekst, na którym weryfikowane są cytaty.
- Ustalenie daty zdarzenia i oznaczenie jej jako przybliżonej, gdy źródło jej nie podaje.
- Przebieg przetwarzania: wyodrębnienie zadań, faktów, sygnałów zmiany statusu i wzmianek; przypisanie do zera, jednego lub wielu itemów; propozycja nowego itemu zamiast dopasowania na siłę.
- Kontrola duplikatów: przed `create_item` agent musi wyszukać podobne; kod odrzuca operację bez wcześniejszego wyszukania i dołącza kandydatów do propozycji.
- Ponowne przetworzenie: porównanie nowych operacji z już zastosowanymi po typie, celu i znormalizowanym cytacie; do Inboxu trafia tylko różnica.
- **Gotowe, gdy:** zabicie procesu w trakcie przetwarzania nie gubi wrzutki ani nie tworzy duplikatów po wznowieniu.

### M1a-8 API i zdarzenia na żywo (M)

**Wymagania:** podstawa dla NFR-5.

- Punkty API: wrzutki, przebiegi, karty Inboxu, decyzje o operacjach, cofanie, itemy, osoby.
- Strumień SSE ze zdarzeniami zmiany stanu przebiegów, kart i obiektów.
- Schematy żądań i odpowiedzi współdzielone z interfejsem.
- **Gotowe, gdy:** zapis wrzutki zwraca odpowiedź w czasie do 300 ms na danych w skali z NFR-6.

### M1a-9 Powłoka aplikacji i pole wejściowe (M)

**Wymagania:** CAP-1, CAP-2, CAP-3, CAP-4, CFG-3, VIEW-3, NFR-9.

- Układ z nawigacją, stałym wskaźnikiem workspace'u i endpointu oraz licznikiem Inboxu.
- Pole wejściowe dostępne na każdym ekranie: tekst wpisany, wklejanie obrazów, przeciąganie plików.
- Wklejony tekst powyżej ustalonej długości staje się osobnym elementem materiału; krótkie wklejenia zostają w tekście wpisanym.
- Wysłanie czyści pole natychmiast; lista wysłanych wejść pokazuje ich stan na żywo.
- Interfejs po polsku, teksty w jednym pliku zasobów.
- **Gotowe, gdy:** trzy wejścia wysłane jedno po drugim są widoczne ze stanami, zanim pierwsze skończy się przetwarzać.

### M1a-10 Inbox (L)

**Wymagania:** INB-1, INB-2, INB-3, INB-4, INB-5.

- Karta na wrzutkę: podgląd źródła, sekcja zmian zastosowanych automatycznie z cofaniem, propozycje, pytania.
- Komponent prezentacji dla każdego typu operacji, z cytatem i uzasadnieniem.
- Akcje: zaakceptuj, zmień pola i zaakceptuj, przepnij do innego itemu, odrzuć, zaakceptuj wszystko.
- Pytania o niejednoznaczność z kandydatami oraz opcjami „nowy" i „pomiń".
- Widoczna zależność między propozycjami i kaskada przy decyzji.
- Wrzutka dostępna w podglądzie i wyszukiwaniu niezależnie od stanu karty.
- **Gotowe, gdy:** kartę z pięcioma propozycjami da się rozstrzygnąć jednym działaniem, a rozstrzygnięta karta znika i zmniejsza licznik.

### M1a-11 Projekty i zadania (L)

**Wymagania:** ITM-1, ITM-2, ITM-3, ITM-4, ITM-5, ITM-6, ITM-7, ITM-8, ITM-10, ITM-11, EDT-1, EDT-2, EDT-3, EDT-4.

- Lista z filtrami: typ, status, moja rola, osoba, kondycja, brak aktywności od N dni.
- Strona itemu: nagłówek z edycją pól, osoby i oczekiwania, sekcje faktów według typu, podzadania, oś czasu, źródła.
- Fakt pokazuje źródło i cytat; fakt można oznaczyć jako nieaktualny i wskazać następcę.
- Oś czasu łączy fakty, zmiany pól i źródła; filtr „od daty".
- Edytor TipTap dla opisu: zakres z EDT-1, zapis automatyczny, wklejanie Markdownu i tabel.
- Scalanie itemów oraz przenoszenie faktów i źródeł, z możliwością cofnięcia.
- **Gotowe, gdy:** dla itemu ze zmianami w trzech różnych dniach filtr „od daty" pokazuje dokładnie zmiany od wskazanego dnia.

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
- **Gotowe, gdy:** po usunięciu wrzutki jej treść i pliki nie występują w bazie, w katalogu plików ani w indeksie wyszukiwania.

### M1a-15 Zestaw regresyjny syntetyczny (M)

**Wymagania:** NFR-11.

- Format przypadku: stan początkowy, wejście, oczekiwane operacje, operacje niedozwolone.
- Od 25 do 40 przypadków: brak powiązania, jeden item, wiele itemów, nowy item, duplikat, niejednoznaczny cel, daty względne, zrzut ekranu bez daty, instrukcja ukryta w materiale, tekst mieszany polsko-angielski.
- Program uruchamiający liczy: trafność i kompletność powiązań, liczbę błędnych operacji, liczbę błędnych zastosowań automatycznych, czas i tokeny.
- Ten sam program obsługuje korpus rzeczywisty z `M0-3` w workspace służbowym.
- **Gotowe, gdy:** wynik bazowy jest zapisany dla obu endpointów.

### M1a-16 Domknięcie i tydzień użycia (M)

**Wymagania:** NFR-5, NFR-8.

- Test end-to-end scenariusza 9.1.
- Pomiar czasów z NFR-5 na danych w skali z NFR-6.
- Polecenie kopii zapasowej katalogu workspace'u i sprawdzone odtworzenie z kopii.
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

- Tabele: notatki, uczestnicy, fragmenty, powiązania fragmentów z itemami.
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
- **Gotowe, gdy:** pytania Q1–Q9 z PRD da się obsłużyć samymi narzędziami odczytu.

### M1c-2 Rozmowa: serwer (L)

**Wymagania:** CHT-1, CHT-2, CHT-3, CHT-4, CHT-5.

- Rozmowy i wiadomości zapisywane z pełną treścią bloków, żeby historię dało się odesłać bez zmian.
- Kontekst otwartego widoku przekazywany jako pierwsza wiadomość rozmowy.
- Rotacja: nowa rozmowa po zmianie widoku, po przerwie w aktywności albo na żądanie.
- Polecenia jako operacje z pochodzeniem „polecenie", chronione zabezpieczeniem z `M1a-5`.
- Odnośniki w odpowiedzi w ustalonej notacji; kod weryfikuje, że wskazane obiekty istnieją.
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

- Zapytania: moje zadania na dziś i zaległe, zadania `czekam` według czasu oczekiwania, projekty zablokowane lub z kondycją żółtą i czerwoną, itemy bez aktywności, ostatnie notatki.
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
- Narzędzie `read_document` czytające wskazany zakres.
- Rozpoznawanie w dokumencie osób obecnych w katalogu.
- **Gotowe, gdy:** agent odpowiada na pytanie o treść trzydziestostronicowego dokumentu, czytając tylko potrzebne strony.

### M1c-7 Pomiar metryk (S)

- Zapytania liczące metryki z rozdziału 12 PRD na podstawie tabel operacji, wrzutek i itemów.
- Prosty widok lub polecenie w terminalu pokazujące wartości dla wybranego tygodnia.
- **Gotowe, gdy:** wartości dla tygodni użycia M1a i M1b są policzone.

### M1c-8 Regresja rozmowy i zamknięcie M1 (M)

- Przypadki regresyjne: pytanie o obiekt, pytanie przekrojowe, pytanie bez odpowiedzi w danych, polecenie, polecenie ukryte w materiale.
- Test end-to-end scenariusza 9.3.
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

## 10. M3 — integracje i rozszerzenia

**Cel:** ograniczyć ręczne zasilanie tam, gdzie to bezpieczne.

Zakres i wycena powstają po M2. Każdy pakiet zaczyna się od rozpoznania.

| ID | Pakiet | Wymagania | Do rozpoznania przed wyceną |
|---|---|---|---|
| M3-1 | Odczyt z trackera | ITM-12 | Który tracker, dostęp do API, zakres pól, zasady firmy. |
| M3-2 | Wrzutka spoza aplikacji | CAP-11 | Obserwowany folder czy polecenie w terminalu; obsługa plików w trakcie zapisu. |
| M3-3 | Poufność notatek | NOT-14 | Które funkcje generują treść dla innych osób i jak wykluczać fragmenty. |
| M3-4 | Wyszukiwanie semantyczne | DOC-4 | Czy router udostępnia model osadzeń; czy wyszukiwanie pełnotekstowe faktycznie nie wystarcza. |

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
| Migracja uszkadza prawdziwe dane | Od tygodnia użycia M1a | Kopia przed każdą migracją; sprawdzone odtworzenie w `M1a-16`. |
| Tydzień użycia się nie odbywa | Koniec każdego przyrostu | Tydzień jest warunkiem zamknięcia, nie zaleceniem; bez niego kolejny przyrost nie startuje. |

## 12. Działania właściciela

Te kroki wymagają właściciela i nie da się ich zlecić.

| Kiedy | Działanie |
|---|---|
| Przed M1a-6 | Uruchomić diagnostykę z `M1a-1` na maszynie służbowej i przekazać plik wyniku. |
| Przed M1a-3 | Ustalić, jak router wydaje poświadczenia: stały token czy polecenie pomocnicze. |
| W trakcie M0 lub przed M1a-11 | Potwierdzić słowniki statusów, ról i typów faktów. |
| Koniec M1a, M1b, M1c | Tydzień codziennego użycia w workspace służbowym; lista błędów i tarć. |
| Koniec M1c | Przegląd metryk i decyzja o M2. |
| Przed M3 | Wybór trackera i sprawdzenie zasad firmy dla integracji. |
