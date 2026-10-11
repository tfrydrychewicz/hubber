# PRD: Hubber — hub pracy Engineering Managera / Dyrektora

| | |
|---|---|
| **Status** | Wersja robocza 0.1 |
| **Data** | 2026-10-09 |
| **Nazwa robocza** | Hubber |

## 1. Streszczenie

Hubber to lokalna aplikacja webowa dla jednego użytkownika: engineering managera lub dyrektora. Trzyma w jednym miejscu jego własne zadania, projekty zespołu, osoby, z którymi pracuje, i notatki ze spotkań.

Użytkownik wrzuca do aplikacji surowy materiał: polecenia, notatki, zrzuty ekranu i treść wiadomości, dokumenty. Agent AI rozpoznaje, których projektów, zadań i osób materiał dotyczy, i proponuje konkretne zmiany. Z agentem można też rozmawiać o dowolnym projekcie, zadaniu lub osobie.

Produkt ma odpowiadać na pytania, na które dziś odpowiada pamięć menedżera: co wymaga uwagi, na co i od kogo czekam, co obiecałem, co się zmieniło, o czym rozmawiałem z daną osobą.

Trzy decyzje definiują produkt:

- **Wrzucenie materiału kosztuje sekundy i nie blokuje pracy.** Analiza odbywa się w tle.
- **Agent proponuje typowane, cofalne zmiany ze wskazaniem źródła.** Nie przepisuje treści po cichu.
- **Dane strukturalne żyją w bazie, a edytor służy do treści pisanej.** Status, osoby, terminy i powiązania są polami, po których można filtrować.

## 2. Problem i kontekst

Menedżer prowadzi równolegle kilkadziesiąt wątków: własne zadania, projekty zespołu, sprawy osobowe, prośby interesariuszy. Każdy wątek posuwa się naprzód we fragmentach rozsianych po komunikatorze, poczcie, spotkaniach i dokumentach. Skutki:

- **Zgubione zobowiązania.** Własne i cudze; nikt nie pilnuje „miałeś mi odpisać".
- **Koszt odtwarzania kontekstu.** Przed spotkaniem trzeba od nowa ustalić, gdzie jesteśmy.
- **Ręczna synteza statusu.** Raport w górę powstaje z pamięci i przeszukiwania kanałów.
- **Brak pamięci relacji.** Ustalenia ze spotkań nie łączą się z projektami, których dotyczyły.

Tracker zespołu (np. Jira lub Linear) pozostaje źródłem prawdy o zadaniach zespołu. Hubber go nie zastępuje: przechowuje warstwę menedżerską, czyli kontekst, zobowiązania, decyzje, ryzyka, interesariuszy i notatki, a do trackera odsyła odnośnikiem.

## 3. Cele i nie-cele

### Cele

1. Jedno miejsce dla warstwy menedżerskiej: własne zadania, projekty zespołu, osoby, notatki.
2. Wrzucenie dowolnego materiału w kilka sekund, bez decydowania, gdzie ma trafić.
3. Automatyczne rozpoznanie, czego i kogo materiał dotyczy, przy zachowaniu kontroli użytkownika nad zmianami.
4. Pamięć relacji: każda osoba ma historię notatek, spraw otwartych w obie strony i projektów, w których występuje.
5. Odpowiedzi na pytania z rozdziału 5 szybciej, niż da się je odtworzyć z pamięci i kanałów.
6. Działanie na bezpośrednim API Anthropic oraz na firmowym Model Routerze, bez mieszania danych między nimi.

### Nie-cele

- Praca wielu użytkowników, współdzielenie, konta i uprawnienia.
- Hosting poza komputerem użytkownika; aplikacja mobilna.
- Zastąpienie trackera zespołu; synchronizacja dwukierunkowa.
- Automatyczne pobieranie danych z komunikatora, poczty i kalendarza w etapach M1–M2.
- Wysyłanie czegokolwiek w imieniu użytkownika: agent przygotowuje szkice, nie wysyła.
- Nagrywanie i transkrypcja spotkań; notatki wpisuje lub wkleja użytkownik.
- Oceny okresowe i procesy HR.

## 4. Użytkownik

Jeden użytkownik: engineering manager lub dyrektor prowadzący kilka zespołów. Cechy istotne dla produktu:

- Pracuje w ciągłych przełączeniach kontekstu; na zapisanie czegoś między spotkaniami ma kilkanaście sekund.
- Większość informacji dociera do niego jako fragmenty cudzej komunikacji, nie jako uporządkowane dokumenty.
- Jego praca przebiega przez ludzi: spotkania 1:1, rozmowy z interesariuszami, delegowanie.
- Pisze i czyta po polsku i po angielsku, często w jednym materiale.
- Przetwarza dane wrażliwe, w tym notatki o ludziach; kontrola nad tym, dokąd trafiają, jest warunkiem użycia.

## 5. Pytania, na które hub odpowiada

Wymagania w rozdziale 8 wynikają z tej listy. Funkcja, która nie pomaga odpowiedzieć na żadne z pytań, nie należy do produktu.

| # | Pytanie | Gdzie jest odpowiedź | Priorytet |
|---|---|---|---|
| Q1 | Co dziś wymaga mojej uwagi? | widok „Dziś" | P0 |
| Q2 | Na co czekam, od kogo i jak długo? | widok „Dziś", strona osoby | P0 |
| Q3 | Co i komu obiecałem, na kiedy? | widok „Dziś", strona osoby | P0 |
| Q4 | Które projekty są zagrożone i dlaczego? | widok „Dziś", ryzyka na stronie projektu | P0 |
| Q5 | Co się zmieniło w projekcie X od dnia Y? | oś czasu, rozmowa z agentem | P0 |
| Q6 | O czym ostatnio rozmawiałem z osobą Z i co mam z nią poruszyć? | strona osoby; przygotowanie do spotkania | P0 (historia), P1 (przygotowanie) |
| Q7 | Kto jest interesariuszem X i czego oczekuje? | strona projektu | P0 |
| Q8 | Jakie decyzje zapadły w X, kiedy i na jakiej podstawie? | decyzje na stronie projektu | P0 |
| Q9 | Czego dawno nie ruszałem? | widok „Dziś" | P0 |
| Q10 | Jaki status mam zaraportować w górę? | szkic statusu | P1 |

## 6. Zasady produktu

1. **Wrzucenie nie blokuje.** Zapis materiału jest natychmiastowy, analiza odbywa się w tle.
2. **Źródło jest nienaruszalne.** Surowy materiał jest przechowywany w oryginale; wszystko inne jest z niego wyprowadzone.
3. **Agent proponuje operacje, nie przepisuje treści.** Każda zmiana jest typowaną operacją, którą można przejrzeć i cofnąć.
4. **Każdy fakt ma źródło.** Decyzja, wymaganie czy ryzyko wskazuje materiał i cytat, z którego pochodzi.
5. **Historia zamiast nadpisywania.** Stan bieżący wynika z historii zmian, więc pytanie „co się zmieniło" zawsze ma odpowiedź.
6. **Struktura w bazie, proza w edytorze.** To, po czym się filtruje i agreguje, jest polem, a nie fragmentem dokumentu.
7. **Deterministycznie, gdzie się da.** Listy „zaległe", „czekam" i „bez aktywności" to zapytania do danych, a nie wynik modelu.
8. **Tożsamości się nie zgaduje.** Niejednoznaczną osobę lub projekt system rozstrzyga pytaniem.
9. **Treść użytkownika należy do użytkownika.** Agent nie zmienia słów napisanych przez użytkownika bez jego akceptacji.

## 7. Model pojęciowy

| Pojęcie | Definicja |
|---|---|
| **Wrzutka** | Surowy materiał dostarczony przez użytkownika: tekst, obraz lub plik. Niezmienna po zapisaniu. |
| **Notatka** | Dokument użytkownika, np. ze spotkania, z datą, rodzajem, uczestnikami i treścią. Edytowalna. |
| **Fragment** | Ciągły zakres treści notatki dotyczący jednego tematu. Jednostka wiązania notatki z itemami. |
| **Źródło** | Miejsce, z którego pochodzi informacja: wrzutka, fragment notatki, dokument albo polecenie użytkownika. |
| **Item** | Projekt albo zadanie. Projekty zawierają zadania, zadania mogą mieć podzadania. |
| **Osoba** | Człowiek występujący w materiałach; ma aliasy, rolę i relację do użytkownika. Użytkownik też jest osobą. |
| **Wzmianka** | Wystąpienie osoby w źródle, powiązane z osobą z katalogu albo nierozstrzygnięte. |
| **Fakt** | Wyodrębniona informacja o itemie: decyzja, wymaganie, ryzyko, informacja lub pytanie. Zawsze ma źródło i cytat. |
| **Propozycja** | Operacja przygotowana przez agenta, która czeka na decyzję użytkownika. |
| **Zmiana** | Zapis wykonanej operacji w dzienniku: stan przed i po, źródło, sposób zatwierdzenia. |
| **Workspace** | Katalog danych połączony z jednym profilem LLM (endpoint, uwierzytelnienie, modele). |

Relacje:

- Wrzutka i fragment notatki mogą być powiązane z dowolną liczbą itemów, także z żadnym.
- Notatka ma dowolną liczbę uczestników; osoba może być uczestnikiem wielu notatek.
- Osoba pełni w itemie rolę: właściciel, zleceniodawca, interesariusz, wykonawca lub informowany.
- Zobowiązanie jest zadaniem. „Ktoś jest mi coś winien" to zadanie z moją rolą `czekam` i właścicielem. „Ja jestem coś winien" to zadanie z moją rolą `robię` i zleceniodawcą.
- Fakt należy do jednego itemu i wskazuje jedno źródło. Ten sam cytat może dać fakty w kilku itemach.

## 8. Wymagania funkcjonalne

Priorytety: **P0** wchodzi do M1 (MVP), **P1** do M2, **P2** do M3 lub później.

### 8.1 Wprowadzanie materiału

| ID | Wymaganie | Priorytet |
|---|---|---|
| CAP-1 | Jedno pole wejściowe, dostępne z każdego ekranu, przyjmuje tekst wpisany, tekst wklejony, obrazy ze schowka i przeciągnięte pliki. | P0 |
| CAP-2 | Wysłanie wejścia nie blokuje pola: kolejne wejście można wysłać od razu. Każde wejście jest natychmiast zapisane i widoczne ze stanem: w kolejce, przetwarzane, gotowe, błąd. | P0 |
| CAP-3 | Dłuższy wklejony tekst, obrazy i pliki są dołączane jako materiał, wizualnie oddzielony od tekstu wpisanego. Polecenia i pytania system rozpoznaje wyłącznie w tekście wpisanym przez użytkownika; treść dołączonego materiału nigdy nie jest poleceniem. | P0 |
| CAP-4 | Jedno wejście może łączyć materiał i polecenie, np. zrzut ekranu i „dodaj zadanie: odpisać do piątku". Polecenie użytkownika ma pierwszeństwo przed wnioskami agenta. | P0 |
| CAP-5 | Wrzutka jest zapisywana w oryginale przed jakimkolwiek przetwarzaniem. Nie można jej edytować; można ją trwale usunąć. | P0 |
| CAP-6 | Dla obrazów system tworzy transkrypcję (uczestnicy, znaczniki czasu, treść) i przechowuje ją obok oryginału. | P0 |
| CAP-7 | Wrzutka ma datę dodania i datę zdarzenia. Daty względne w treści („jutro", „w piątek") są liczone od daty zdarzenia. Gdy daty zdarzenia nie da się ustalić, system przyjmuje datę dodania i oznacza ją jako przybliżoną. | P0 |
| CAP-8 | Zasilenie początkowe: użytkownik wkleja listę osób i projektów, a system proponuje ich utworzenie do zbiorczej akceptacji. | P0 |
| CAP-9 | Transkrypcję obrazu można poprawić ręcznie. | P1 |
| CAP-10 | Skrót klawiszowy otwiera pole wejściowe z dowolnego ekranu; można wrzucić wiele plików naraz. | P1 |
| CAP-11 | Wrzutka spoza aplikacji: obserwowany folder lub polecenie w terminalu. | P2 |

### 8.2 Przetwarzanie materiału

| ID | Wymaganie | Priorytet |
|---|---|---|
| ING-1 | Z każdej wrzutki i notatki agent wyodrębnia: zadania (w tym zobowiązania w obie strony), fakty (decyzje, wymagania, ryzyka, informacje, pytania), sygnały zmiany statusu oraz wzmianki o osobach. | P0 |
| ING-2 | Każdy wyodrębniony element jest przypisywany do zera, jednego lub wielu itemów. Jedna wrzutka może dotyczyć wielu itemów. | P0 |
| ING-3 | Gdy element nie pasuje do istniejącego itemu, agent proponuje nowy item albo zostawia element nieprzypisany. Nie dopasowuje na siłę. | P0 |
| ING-4 | Przed zaproponowaniem nowego itemu lub osoby agent sprawdza podobne istniejące, także niedawno zamknięte, i pokazuje kandydatów na duplikat. | P0 |
| ING-5 | Wynikiem przetwarzania jest lista typowanych operacji (Załącznik A). Każda ma uzasadnienie, cytat ze źródła i poziom pewności. | P0 |
| ING-6 | Pewność jest `wysoka` tylko wtedy, gdy źródło wskazuje cel wprost (nazwa, alias, wzmianka) i dopasowanie jest jednoznaczne. W pozostałych przypadkach jest `niska`. | P0 |
| ING-7 | Operacje są stosowane zgodnie z polityką opisaną pod tabelą. | P0 |
| ING-8 | Przed zastosowaniem system sprawdza operację deterministycznie: cytat występuje w źródle, wskazane obiekty istnieją, daty są poprawne. Operacja, która nie przechodzi, wraca do agenta do poprawy; po wyczerpaniu prób trafia do Inboxu jako wymagająca ręcznej decyzji. | P0 |
| ING-9 | Treść materiału jest danymi, nie poleceniem: instrukcje zawarte we wklejonych wiadomościach i dokumentach nie zmieniają zachowania agenta. | P0 |
| ING-10 | Nieudane przetwarzanie nie gubi materiału: wrzutka zostaje w stanie „błąd" z możliwością ponowienia, a kolejka przetwarzania przeżywa restart aplikacji. | P0 |
| ING-11 | Wrzutkę lub notatkę można przetworzyć ponownie na żądanie; system proponuje tylko różnicę względem tego, co już zastosowano. | P0 |
| ING-12 | Poprawki użytkownika (przepięcia, odrzucenia, rozstrzygnięcia niejednoznaczności) są zapamiętywane i uwzględniane przy kolejnych przetwarzaniach. | P1 |

**Polityka stosowania operacji (ING-7)**

| Operacja | Polecenie użytkownika | Wniosek agenta, pewność wysoka | Wniosek agenta, pewność niska |
|---|---|---|---|
| Utworzenie notatki z materiału użytkownika | od razu | od razu | Inbox |
| Powiązanie źródła lub fragmentu z istniejącym itemem | od razu | od razu | Inbox |
| Dodanie faktu do istniejącego itemu | od razu | od razu | Inbox |
| Powiązanie wzmianki z istniejącą osobą | od razu | od razu | Inbox (pytanie) |
| Utworzenie itemu lub osoby | od razu | Inbox | Inbox |
| Zmiana statusu, kondycji, terminu, właściciela | od razu | Inbox | Inbox |
| Zamknięcie lub scalenie | od razu | Inbox | Inbox |
| Zmiana treści napisanej przez użytkownika | sugestia do akceptacji | nigdy | nigdy |
| Usunięcie | po potwierdzeniu | nigdy | nigdy |

Operacje zastosowane od razu są widoczne na karcie w Inboxie jako „zastosowane automatycznie" i można je cofnąć.

### 8.3 Inbox

| ID | Wymaganie | Priorytet |
|---|---|---|
| INB-1 | Inbox pokazuje jedną kartę na wrzutkę lub notatkę: źródło, operacje zastosowane automatycznie, propozycje do decyzji, pytania. | P0 |
| INB-2 | Dla każdej propozycji użytkownik może: zaakceptować, zmienić pola i zaakceptować, przepiąć do innego itemu, odrzucić. Dla całej karty: zaakceptować wszystko. | P0 |
| INB-3 | Pytania o niejednoznaczność (która osoba, który item, czy to duplikat) pokazują kandydatów oraz opcje „nowy" i „pomiń". | P0 |
| INB-4 | Licznik nierozstrzygniętych kart jest widoczny na każdym ekranie. Karta znika po rozstrzygnięciu wszystkich propozycji i pytań. | P0 |
| INB-5 | Materiał nie czeka na przegląd: wrzutka jest przeszukiwalna i widoczna od chwili zapisania, niezależnie od stanu karty. | P0 |
| INB-6 | Inbox da się w całości obsłużyć klawiaturą; karty można rozstrzygać wsadowo. | P1 |

### 8.4 Projekty i zadania

| ID | Wymaganie | Priorytet |
|---|---|---|
| ITM-1 | Item ma: typ (projekt, zadanie), tytuł, aliasy (nazwy potoczne, skróty, klucze), status, moją rolę, właściciela, termin, item nadrzędny, odnośnik zewnętrzny (system, klucz, adres) i opis. | P0 |
| ITM-2 | Statusy: `do zrobienia`, `w toku`, `zablokowane`, `zrobione`, `anulowane`. Projekt ma dodatkowo kondycję: `zielona`, `żółta`, `czerwona`. | P0 |
| ITM-3 | Moja rola: `robię` (wykonuję sam), `deleguję` (wykonuje ktoś z zespołu, odpowiadam ja), `czekam` (ktoś jest mi coś winien), `obserwuję`. | P0 |
| ITM-4 | Hierarchia ma trzy poziomy: projekt, zadanie, podzadanie. | P0 |
| ITM-5 | Osoba w itemie ma rolę (`właściciel`, `zleceniodawca`, `interesariusz`, `wykonawca`, `informowany`) i pole „oczekiwania". | P0 |
| ITM-6 | Fakt itemu ma typ (`decyzja`, `wymaganie`, `ryzyko`, `informacja`, `pytanie`), datę zdarzenia, powiązane osoby, źródło i cytat. Faktów się nie edytuje: nieaktualny fakt oznacza się jako nieaktualny i opcjonalnie wskazuje fakt, który go zastąpił. | P0 |
| ITM-7 | Oś czasu itemu pokazuje chronologicznie fakty, zmiany pól (status, kondycja, termin, właściciel) i powiązane źródła. Dla dowolnej daty da się odczytać, co zmieniło się od tego dnia. | P0 |
| ITM-8 | Strona itemu zawiera: nagłówek z polami, podsumowanie stanu, osoby i ich oczekiwania, wymagania, decyzje, ryzyka, otwarte pytania, podzadania, oś czasu, źródła (wrzutki, fragmenty notatek, dokumenty) oraz opis w edytorze. | P0 |
| ITM-9 | Podsumowanie stanu (kilka zdań) jest generowane z faktów i pól. Zawiera odnośniki do źródeł i datę wygenerowania, odświeża się po zmianach i na żądanie. Jest oznaczone jako wygenerowane i nie jest traktowane jako źródło faktów. | P0 |
| ITM-10 | Itemy można scalać, a fakty i źródła przenosić między itemami. | P0 |
| ITM-11 | Lista itemów ma filtry: typ, status, moja rola, osoba, kondycja, brak aktywności od N dni. | P0 |
| ITM-12 | Synchronizacja tylko do odczytu z zewnętrznym trackerem na podstawie odnośnika zewnętrznego. | P2 |

### 8.5 Osoby

| ID | Wymaganie | Priorytet |
|---|---|---|
| PER-1 | System wykrywa wzmianki o osobach we wrzutkach tekstowych, transkrypcjach obrazów i notatkach. W dokumentach rozpoznaje osoby już obecne w katalogu. | P0 |
| PER-2 | Wzmianka jest dopasowywana do osoby z uwzględnieniem odmiany („Kasi", „Kasią"), zdrobnień (Kasia i Katarzyna), inicjałów, pseudonimów, identyfikatorów z komunikatorów i adresów e-mail. | P0 |
| PER-3 | Gdy wzmianka pasuje do kilku osób albo do żadnej, system pyta w Inboxie: wskaż osobę, utwórz nową albo pomiń. Odpowiedź jest zapamiętywana jako alias, także z kontekstem (np. „Ania z płatności"). Do czasu odpowiedzi wzmianka pozostaje nierozstrzygnięta, a materiał nie jest tracony. | P0 |
| PER-4 | Katalog osób zawiera: imię i nazwisko, aliasy, rolę, zespół lub organizację, relację do mnie (`podwładny`, `przełożony`, `współpracownik`, `interesariusz`, `zewnętrzny`) i własną notatkę o osobie. Atrybuty wywnioskowane z materiału są propozycjami do akceptacji. | P0 |
| PER-5 | Użytkownik jest osobą w katalogu oznaczoną jako „ja". Zaimki pierwszej osoby w jego notatkach odnoszą się do niej. | P0 |
| PER-6 | Strona osoby pokazuje: profil; co ona jest mi winna (zadania, których jest właścicielem, a moja rola to `czekam` lub `deleguję`); co ja jestem jej winien (moje zadania, w których jest zleceniodawcą); itemy, w których występuje, z rolą; notatki z jej udziałem od najnowszej; wzmianki we wrzutkach. Z tej strony można utworzyć notatkę. | P0 |
| PER-7 | Osoby można scalać z przeniesieniem aliasów i powiązań. | P0 |
| PER-8 | Lista „Do poruszenia" przy osobie: tematy na następne spotkanie, dodawane ręcznie, poleceniem albo jako propozycja agenta. | P1 |
| PER-9 | „Przygotuj mnie do spotkania": zmiany od ostatniej notatki z tą osobą, sprawy otwarte w obie strony, ryzyka w jej itemach i lista „Do poruszenia". Każdy punkt ma odnośnik do źródła. | P1 |
| PER-10 | Nieznane osoby z dokumentu system zbiera w jedno zbiorcze pytanie zamiast wielu pojedynczych. | P1 |

### 8.6 Notatki

| ID | Wymaganie | Priorytet |
|---|---|---|
| NOT-1 | Notatka ma tytuł, datę zdarzenia, rodzaj (`spotkanie`, `1:1`, `rozmowa`, `własna`), uczestników i treść w edytorze. | P0 |
| NOT-2 | Notatkę można utworzyć: z pola wejściowego (system rozpoznaje, że materiał jest notatką, i wykrywa uczestników oraz datę); ze strony osoby (uczestnik ustawiony); ze strony itemu (powiązanie ustawione); z listy notatek. Wklejony transkrypt lub podsumowanie spotkania z innego narzędzia jest traktowany tak samo. | P0 |
| NOT-3 | Treść notatki pozostaje dokładnie taka, jak ją podał użytkownik. Formatowanie wklejonego tekstu jest przenoszone mechanicznie; agent nie przeredagowuje i nie streszcza treści w miejscu oryginału. Gdy notatka powstaje z pola wejściowego, pierwotny materiał jest zachowany jako wrzutka. | P0 |
| NOT-4 | Agent dzieli notatkę na fragmenty tematyczne i wiąże każdy fragment z zerem, jednym lub wieloma itemami. Notatka z jednego spotkania może dotyczyć wielu projektów. | P0 |
| NOT-5 | Fragment niepowiązany z żadnym itemem zostaje przy notatce i jej uczestnikach. Nie pojawia się na stronie żadnego itemu. | P0 |
| NOT-6 | Strona itemu pokazuje tylko powiązane z nim fragmenty, z datą, uczestnikami i odnośnikiem do całej notatki. Strona osoby pokazuje całe notatki z jej udziałem, z oznaczeniem, których itemów dotyczą poszczególne fragmenty. | P0 |
| NOT-7 | Z fragmentów agent wyodrębnia zadania i fakty na zasadach z rozdziału 8.2. Źródłem jest konkretny fragment. | P0 |
| NOT-8 | Użytkownik może ręcznie zmienić granice fragmentu, powiązania fragmentu z itemami i listę uczestników. | P0 |
| NOT-9 | Wzmianki `@osoba` i `#item` wstawione w treści są powiązaniami pewnymi i nie wymagają rozpoznawania. | P0 |
| NOT-10 | Powiązanie fragmentu z itemem przetrwa edycję otaczającej treści. Gdy treść fragmentu będącego źródłem faktu zostanie zmieniona lub usunięta, fakt jest oznaczany „źródło zmienione" do weryfikacji. | P0 |
| NOT-11 | Lista notatek ma filtry: osoba, item, rodzaj, zakres dat. | P0 |
| NOT-12 | Ponowna analiza (ING-11) uruchamia się automatycznie po zakończeniu edycji notatki. | P1 |
| NOT-13 | W notatce widać listę „Do poruszenia" jej uczestników; tematy można odhaczać. | P1 |
| NOT-14 | Notatkę lub fragment można oznaczyć jako poufne: treść jest wyłączona ze szkiców przeznaczonych dla innych osób. | P2 |

### 8.7 Rozmowa z agentem

| ID | Wymaganie | Priorytet |
|---|---|---|
| CHT-1 | Rozmowa jest dostępna z każdego ekranu. Agent zna otwarty widok (item, osoba, notatka) i traktuje go jako domyślny kontekst. | P0 |
| CHT-2 | Agent odpowiada na pytania o pojedyncze obiekty i o przekroje (np. „na co czekam od zespołu płatności", „co się zmieniło w Atlasie od poniedziałku") wyłącznie na podstawie danych huba. Odpowiedź zawiera odnośniki do itemów, notatek i źródeł. | P0 |
| CHT-3 | Agent wykonuje polecenia zmieniające dane (utwórz, zmień, zamknij, powiąż, scal, dodaj notatkę lub osobę) tymi samymi operacjami co przetwarzanie. Każda trafia do dziennika i jest cofalna. | P0 |
| CHT-4 | Gdy dane nie zawierają odpowiedzi, agent mówi to wprost. Własne wnioski oddziela od faktów zapisanych w hubie. | P0 |
| CHT-5 | Odpowiedzi są strumieniowane. Widać, co agent odczytał i co zmienił. | P0 |
| CHT-6 | Rozmowy są zapisywane i można do nich wrócić. | P1 |
| CHT-7 | Agent przygotowuje szkice (status projektu, podsumowanie tygodnia, wiadomość do interesariusza) jako tekst do skopiowania. | P1 |

### 8.8 Widoki i wyszukiwanie

| ID | Wymaganie | Priorytet |
|---|---|---|
| VIEW-1 | Widok „Dziś" pokazuje: moje zadania (rola `robię`) z terminem na dziś i zaległe; zadania `czekam` uporządkowane według czasu oczekiwania; projekty zablokowane lub z kondycją żółtą i czerwoną; itemy bez aktywności od N dni (domyślnie 14); liczbę kart w Inboxie; ostatnie notatki. | P0 |
| VIEW-2 | Listy widoku „Dziś" są wyliczane z danych, bez udziału modelu. | P0 |
| VIEW-3 | Nawigacja obejmuje: Dziś, Inbox, Projekty i zadania, Osoby, Notatki, Szukaj, Dziennik zmian, Ustawienia. | P0 |
| VIEW-4 | Wyszukiwanie pełnotekstowe obejmuje itemy, fakty, notatki, wrzutki z transkrypcjami, dokumenty i osoby. Wyszukanie osoby zwraca jej stronę i powiązane materiały niezależnie od formy, w jakiej imię wystąpiło w tekście. | P0 |
| VIEW-5 | Wyszukiwanie pełnotekstowe jest odporne na polską odmianę także dla zwykłych słów. | P1 |
| VIEW-6 | Widok „Co się zmieniło" dla wybranego zakresu dat, globalnie i dla pojedynczego itemu. | P1 |

### 8.9 Dokumenty i wiedza

| ID | Wymaganie | Priorytet |
|---|---|---|
| DOC-1 | Obsługiwane załączniki: PDF, DOCX, Markdown, tekst, obrazy. Oryginał jest zapisywany, a tekst wyodrębniany lokalnie. Dokument można przypiąć do itemu lub notatki. | P0 |
| DOC-2 | Treść dokumentów jest przeszukiwalna i dostępna dla agenta, który czyta potrzebne części na żądanie. | P0 |
| DOC-3 | Dla dokumentu agent tworzy streszczenie i listę kluczowych faktów z odnośnikiem do miejsca w dokumencie. Strona itemu ma sekcję „Wiedza". | P1 |
| DOC-4 | Wyszukiwanie semantyczne. | P2 |

### 8.10 Proaktywność

| ID | Wymaganie | Priorytet |
|---|---|---|
| PRO-1 | Poranny brief przy pierwszym otwarciu dnia lub na żądanie: co wymaga uwagi, z odnośnikami. | P1 |
| PRO-2 | Przegląd tygodniowy: itemy do uporządkowania (bez aktywności, bez właściciela, bez terminu) i szkic podsumowania tygodnia. | P1 |
| PRO-3 | Aplikacja wyróżnia zadania `czekam`, które przekroczyły ustawiony czas oczekiwania. | P1 |

### 8.11 Edytor

| ID | Wymaganie | Priorytet |
|---|---|---|
| EDT-1 | Edytor oparty na TipTap obsługuje: nagłówki, listy, listy kontrolne, tabele ze scalaniem komórek i zmianą szerokości kolumn, cytaty, bloki kodu, linki oraz wzmianki `@osoba` i `#item`. | P0 |
| EDT-2 | Edytor służy do treści pisanej: notatek i opisu itemu. Status, osoby, podzadania, fakty i oś czasu są elementami interfejsu opartymi na danych, a nie treścią dokumentu. | P0 |
| EDT-3 | Zapis jest automatyczny. | P0 |
| EDT-4 | Wklejany Markdown oraz tabele z arkuszy i stron zachowują strukturę. | P0 |
| EDT-5 | Notatka i opis mają historię wersji z możliwością przywrócenia. | P1 |
| EDT-6 | Agent proponuje zmiany w treści pisanej jako sugestie na poziomie bloków (wstaw, zamień, usuń), widoczne jako różnica do zaakceptowania. | P1 |

### 8.12 Dziennik zmian i usuwanie

| ID | Wymaganie | Priorytet |
|---|---|---|
| AUD-1 | Każda operacja agenta jest zapisana w dzienniku: rodzaj, stan przed i po, źródło, czas, sposób zatwierdzenia (polecenie, automatycznie, zaakceptowana propozycja). | P0 |
| AUD-2 | Każdą operację agenta można cofnąć jednym działaniem. Cofnięcie jest wpisem w dzienniku. | P0 |
| AUD-3 | Widok dziennika ma filtry: data, item, osoba, rodzaj operacji, sposób zatwierdzenia. | P0 |
| AUD-4 | Usunięcie wrzutki, notatki lub dokumentu przez użytkownika jest trwałe i obejmuje pliki. System pyta, co zrobić z faktami pochodnymi: usunąć czy zostawić oznaczone jako „bez źródła". | P0 |

### 8.13 Workspace i konfiguracja LLM

| ID | Wymaganie | Priorytet |
|---|---|---|
| CFG-1 | Workspace łączy katalog danych z jednym profilem LLM: adres endpointu, sposób uwierzytelnienia, identyfikatory modeli. Workspace jest przypięty do endpointu w chwili utworzenia; aplikacja odmawia otwarcia go z innym endpointem. | P0 |
| CFG-2 | Obsługiwane są dwa rodzaje profilu: bezpośrednie API Anthropic (klucz) oraz firmowy Model Router w formacie Anthropic Messages (własny adres i poświadczenia). | P0 |
| CFG-3 | Nazwa aktywnego workspace'u i endpoint są stale widoczne w interfejsie. | P0 |
| CFG-4 | Poświadczenia nie są zapisywane w bazie ani w repozytorium. Pochodzą ze zmiennych środowiskowych, z lokalnego pliku poza repozytorium albo z polecenia pomocniczego (dla tokenów rotowanych). | P0 |
| CFG-5 | Diagnostyka endpointu sprawdza: wywołania narzędzi, strumieniowanie, wejście obrazowe, `cache_control`, `effort`, `thinking` i wejście PDF. Wynik zapisuje się w profilu. Aplikacja używa tylko potwierdzonych funkcji i działa poprawnie bez opcjonalnych. | P0 |
| CFG-6 | Identyfikatory modeli ustawia się osobno dla ról: przetwarzanie, rozmowa, synteza. Domyślnie wszystkie role używają jednego modelu. | P0 |
| CFG-7 | Aplikacja pokazuje zużycie tokenów i szacunkowy koszt na dzień i na rolę. | P1 |

## 9. Kluczowe scenariusze i kryteria akceptacji

Stan początkowy wspólny dla scenariuszy: istnieją projekty „Atlas" i „Migracja płatności"; w katalogu są Piotr Nowak i Anna Kowalska (podwładna).

### 9.1 Zrzut wątku z komunikatora dotyczący dwóch projektów

Użytkownik wkleja zrzut ekranu wątku i wysyła go bez komentarza.

1. Wrzutka jest zapisana i widoczna w czasie do 300 ms; pole wejściowe jest od razu wolne.
2. Powstaje transkrypcja z autorami wypowiedzi. Gdy na zrzucie nie ma daty, data zdarzenia jest oznaczona jako przybliżona.
3. Karta w Inboxie zawiera: ryzyko dodane do „Atlasu" automatycznie, bo wątek wymienia projekt z nazwy; propozycję zadania z moją rolą `czekam` i właścicielem Piotr Nowak w „Migracji płatności"; pytanie o nierozpoznaną osobę „Magda".
4. Każda pozycja ma cytat, który występuje w transkrypcji.
5. Po akceptacji osie czasu obu projektów pokazują nowe wpisy z odnośnikiem do zrzutu.
6. Cofnięcie automatycznie dodanego ryzyka usuwa je z „Atlasu" i zostawia wpis w dzienniku.

### 9.2 Notatka z 1:1 obejmująca kilka projektów

Użytkownik wpisuje w pole wejściowe:

> 1:1 z Anią, wczoraj. Atlas: testy wydajnościowe opóźnione o tydzień, Ania przygotuje nowy plan do piątku. Migracja płatności: zdecydowaliśmy, że migrujemy bez okna serwisowego. Rozwój: chce w przyszłym roku prowadzić większy projekt.

1. Powstaje notatka rodzaju `1:1` z datą o dzień wcześniejszą niż data dodania i uczestniczką Anna Kowalska; forma „Anią" jest rozpoznana jako ta osoba.
2. Treść notatki jest identyczna z wpisaną.
3. Notatka ma trzy fragmenty: pierwszy powiązany z „Atlasem", drugi z „Migracją płatności", trzeci z żadnym itemem.
4. Automatycznie dodane: ryzyko w „Atlasie" (opóźnienie testów) i decyzja w „Migracji płatności". Do decyzji w Inboxie: zadanie „nowy plan testów" z moją rolą `czekam`, właścicielką Anna Kowalska i terminem w najbliższy piątek liczony od daty spotkania.
5. Strona „Atlasu" pokazuje tylko pierwszy fragment, strona „Migracji płatności" tylko drugi. Trzeci nie jest widoczny na stronie żadnego itemu.
6. Strona Anny Kowalskiej pokazuje całą notatkę z oznaczeniem projektów przy fragmentach, a po akceptacji nowe zadanie widnieje w części „co ona jest mi winna".
7. Gdyby do „Ani" pasowały dwie osoby z katalogu, notatka powstaje z nierozstrzygniętą uczestniczką, a Inbox pyta, o którą chodzi. Po odpowiedzi powiązania uzupełniają się bez ponownego wpisywania.

### 9.3 Pytanie przekrojowe

Użytkownik pyta: „Co mam omówić z Anią w czwartek?"

1. Odpowiedź wymienia sprawy otwarte w obie strony, zmiany w jej itemach od ostatniej notatki i otwarte ryzyka w tych itemach.
2. Każdy punkt ma odnośnik do itemu, notatki lub źródła.
3. Odpowiedź nie zawiera informacji, których nie ma w hubie. Gdy czegoś brakuje, agent to stwierdza.
4. Pytanie nie zmienia żadnych danych.

## 10. Wymagania niefunkcjonalne

| ID | Obszar | Wymaganie |
|---|---|---|
| NFR-1 | Prywatność | Dane nie opuszczają komputera poza wywołaniami skonfigurowanego endpointu LLM. Brak telemetrii i innych połączeń wychodzących. |
| NFR-2 | Izolacja danych | Dane workspace'u służbowego nie mogą trafić do endpointu innego niż przypięty (CFG-1). Dane testowe i zestawy regresyjne używane z bezpośrednim API Anthropic są syntetyczne lub zanonimizowane. |
| NFR-3 | Bezpieczeństwo | Serwer nasłuchuje wyłącznie na 127.0.0.1. Agent nie ma narzędzi działających poza hubem: nie wysyła wiadomości i nie wywołuje zewnętrznych usług. |
| NFR-4 | Dane wrażliwe | Zakłada się szyfrowanie dysku na poziomie systemu. Trwałe usuwanie działa zgodnie z AUD-4. |
| NFR-5 | Szybkość | Zapis wrzutki: do 300 ms. Widoki i wyszukiwanie: do 300 ms przy skali z NFR-6. Przetworzenie typowej wrzutki tekstowej: mediana do 30 s, 95. percentyl do 90 s. Początek odpowiedzi w rozmowie: do 5 s. Dwie ostatnie wartości zależą od endpointu i są celami, nie gwarancją. |
| NFR-6 | Skala | Jeden użytkownik; do 300 aktywnych itemów, 500 osób, 50 wrzutek i 10 notatek dziennie; historia z 3 lat. |
| NFR-7 | Niezawodność | Żadna wrzutka nie ginie. Kolejka przetwarzania przeżywa restart. Ponowienie przetwarzania nie tworzy duplikatów. |
| NFR-8 | Przenośność danych | Cały stan workspace'u mieści się w jednym katalogu; kopia zapasowa to kopia katalogu. Eksport wszystkich danych do Markdownu i JSON-u wchodzi do M2. |
| NFR-9 | Język | Treści po polsku i angielsku, także mieszane. Interfejs po polsku. |
| NFR-10 | Platforma | macOS, aktualna wersja Chrome, ekran komputera. |
| NFR-11 | Testowalność | Zestaw regresyjny przetwarzania ma dwa warianty: syntetyczny (uruchamiany na każdym endpoincie) i rzeczywisty (tylko w workspace służbowym). Jest uruchamiany przy każdej zmianie promptów lub modelu; wynikiem jest trafność powiązań i liczba błędnych operacji. |
| NFR-12 | Uruchomienie | Instalacja i start jednym poleceniem; żadnych usług zewnętrznych do postawienia. |

## 11. Ograniczenia i założenia techniczne

### 11.1 Warstwa LLM

- Jedyny protokół to Anthropic Messages, obsługiwany przez oficjalny SDK. Profile różnią się adresem endpointu, poświadczeniami i identyfikatorami modeli.
- Firmowy router ma wyłączone funkcje przedpremierowe (organizacja ustawia w Claude Code `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`). Rdzeń używa więc wyłącznie podzbioru stabilnego: wiadomości, strumieniowanie, wywołania narzędzi ze standardowymi polami (`name`, `description`, `input_schema`), wejście obrazowe.
- Rdzeń nie zależy od: structured outputs, `strict`, wymuszonego `tool_choice`, zarządzania kontekstem i kompakcji po stronie serwera, Files API, Batches, narzędzi serwerowych ani nagłówków beta.
- Dane strukturalne powstają jako wywołania narzędzi walidowane przez aplikację. Błąd walidacji wraca do modelu jako wynik narzędzia z oznaczeniem błędu.
- Przetwarzanie i rozmowa to ta sama pętla narzędziowa nad tym samym katalogiem operacji (Załącznik A). Przetwarzanie kończy się jawną operacją `finish`, co odróżnia „nic do zapisania" od przerwanej pracy.
- Kontekst rozmowy jest budowany z bazy dla każdej rozmowy; długa historia nie jest przenoszona.
- Funkcje opcjonalne (`cache_control`, `effort`, `thinking`, wejście PDF) są włączane dopiero po potwierdzeniu przez diagnostykę (CFG-5).
- Domyślny model profilu Anthropic to `claude-opus-5-5`; w profilu routera obowiązują identyfikatory routera.

### 11.2 Dane i wyszukiwanie

- SQLite (jeden plik) i katalog plików w obrębie workspace'u.
- Wyszukiwanie pełnotekstowe w SQLite; bez bazy wektorowej w M1–M2.
- Tekst z dokumentów jest wyodrębniany lokalnie, bez zależności od obsługi PDF po stronie modelu.
- Przy skali z NFR-6 agent dostaje zwarty indeks wszystkich aktywnych itemów i osób; starsze i zamknięte obiekty znajduje narzędziem wyszukiwania.

### 11.3 Aplikacja

- Rekomendowany stos: TypeScript po obu stronach, React i TipTap w przeglądarce, jeden proces serwera.
- Fragmenty notatek są zakotwiczone w treści tak, by przetrwały edycję, analogicznie do komentarzy w edytorach dokumentów.

## 12. Metryki sukcesu

Cele są wstępne i wymagają kalibracji po pierwszych tygodniach używania M1.

| Metryka | Cel | Pomiar |
|---|---|---|
| Dni robocze z co najmniej jedną wrzutką | ≥ 4 z 5 w tygodniu, od trzeciego tygodnia | dane huba |
| Propozycje powiązań zaakceptowane bez zmian | ≥ 90% | Inbox |
| Operacje automatyczne cofnięte przez użytkownika | ≤ 3% | dziennik zmian |
| Duplikaty itemów i osób wykryte po fakcie | ≤ 1 tygodniowo | scalenia w dzienniku |
| Czas rozstrzygnięcia karty w Inboxie | mediana ≤ 20 s | Inbox |
| Zaległość Inboxu | brak kart starszych niż 1 dzień roboczy | Inbox |
| Aktywne itemy z aktywnością w ostatnich 14 dniach | ≥ 80% | dane huba |
| Przygotowanie do 1:1 lub statusu | ≤ 5 min | ocena użytkownika |

**Kryterium zatrzymania.** Jeśli przez dwa kolejne tygodnie po M1 jest mniej niż 3 aktywne dni w tygodniu, prace nad M2 wstrzymuje się do przeglądu założeń.

## 13. Plan wydań

| Etap | Zakres | Kryterium zakończenia |
|---|---|---|
| **M0 — walidacja** (zalecana, bez interfejsu) | Katalog plików Markdown obsługiwany przez Claude Code według spisanych reguł; dwa tygodnie codziennego użycia. | Lista pytań z rozdziału 5 potwierdzona lub poprawiona; korpus 30–50 prawdziwych wrzutek do rzeczywistego zestawu regresyjnego; decyzja, czy nawyk się utrzymuje. |
| **M1 — MVP** | Wszystkie wymagania P0. | Scenariusze 9.1–9.3 spełnione na zestawie syntetycznym; diagnostyka potwierdza funkcje rdzenia na obu endpointach; tydzień codziennego użycia w workspace służbowym bez utraty danych. |
| **M2 — proaktywność i wiedza** | Wymagania P1. | Metryki z rozdziału 12 osiągają cele przez dwa kolejne tygodnie. |
| **M3 — integracje** | Wymagania P2, w tym odczyt z trackera. | Do określenia po M2. |

M1 obejmuje 78 wymagań P0, dlatego jest dostarczany w trzech przyrostach. Każdy jest używalny samodzielnie i kończy się tygodniem codziennego użycia.

| Przyrost | Zakres | Co daje użytkownikowi |
|---|---|---|
| **M1a — rdzeń pętli** | Workspace i diagnostyka (8.13); wprowadzanie materiału (8.1); przetwarzanie (8.2); Inbox (8.3); projekty i zadania (8.4); podstawowy katalog osób (PER-4, PER-5); dziennik zmian (8.12); edytor dla opisu itemu (EDT-1 do EDT-4). | Wrzucam materiał, akceptuję propozycje, widzę projekty i zadania z osią czasu i źródłami. |
| **M1b — osoby i notatki** | Pozostałe wymagania P0 z rozdziału 8.5; notatki (8.6). | Mam historię rozmów z każdą osobą, a notatki ze spotkań łączą się z projektami, których dotyczyły. |
| **M1c — rozmowa i przegląd** | Rozmowa z agentem (8.7); widok „Dziś" i wyszukiwanie (8.8); dokumenty (8.9). | Pytam o dowolny projekt lub osobę i zaczynam dzień od listy tego, co wymaga uwagi. |

## 14. Ryzyka

| Ryzyko | Skutek | Ograniczenie |
|---|---|---|
| Użytkownik przestaje zasilać hub w najbardziej obciążonych tygodniach | Dane się starzeją, zaufanie spada, produkt umiera | Zapis w sekundy i bez blokowania (CAP-2); M0 jako test nawyku; kryterium zatrzymania |
| Błędne powiązanie materiału z itemem lub osobą | Ciche zanieczyszczenie danych | Polityka stosowania (ING-7); pytania zamiast domysłów (PER-3); cofanie (AUD-2); zestaw regresyjny (NFR-11) |
| Duplikaty itemów i osób | Rozbita historia | Sprawdzanie podobnych przed utworzeniem (ING-4); scalanie (ITM-10, PER-7); zasilenie początkowe (CAP-8) |
| Zmyślone lub zniekształcone fakty | Błędne decyzje na podstawie huba | Cytat weryfikowany w źródle (ING-8); podsumowania oznaczone jako wygenerowane (ITM-9) |
| Przegląd Inboxu staje się obciążeniem | Zaległości, porzucenie | Automatyczne stosowanie bezpiecznych operacji; „zaakceptuj wszystko" (INB-2); metryka czasu karty |
| Router odrzuca funkcje API | Błędy lub utrata jakości | Podzbiór stabilny (11.1); diagnostyka (CFG-5) |
| Dane służbowe trafiają do niewłaściwego endpointu | Naruszenie zasad firmy | Przypięcie workspace'u (CFG-1); widoczny endpoint (CFG-3); syntetyczne dane testowe (NFR-2) |
| Edycja notatki unieważnia wyprowadzone fakty | Fakty bez pokrycia w źródle | Oznaczenie „źródło zmienione" (NOT-10); ponowna analiza (ING-11) |
| Zakres przerasta czas właściciela | Niedokończone narzędzie | Priorytety P0–P2; M1 dostarczany w trzech samodzielnie używalnych przyrostach (rozdział 13) |
| Czas przetwarzania i koszt modelu | Wolne karty, niechęć do wrzucania | Przetwarzanie w tle (CAP-2); pomiar zużycia (CFG-7) |

## 15. Otwarte pytania

1. Jaki jest wynik diagnostyki routera dla funkcji opcjonalnych: `cache_control`, `effort`, `thinking`, wejście PDF?
2. Jak router wydaje poświadczenia: stały token czy polecenie pomocnicze z rotacją?
3. Czy słowniki statusów, ról i typów faktów z rozdziału 8.4 odpowiadają sposobowi pracy użytkownika?
4. Jakie progi przyjąć dla braku aktywności (domyślnie 14 dni) i dla czasu oczekiwania w zadaniach `czekam`?
5. Czy interfejs ma być po polsku, jak zakłada NFR-9?
6. Czy oznaczanie poufności notatek (NOT-14) jest potrzebne wcześniej niż w M3?
7. Czy M0 będzie realizowane przed M1, czy równolegle?
8. Który tracker i jaki zakres odczytu w M3?

## Załącznik A. Katalog operacji agenta (M1)

Operacje odczytu: `search`, `get_item`, `get_person`, `get_note`, `list_items`, `read_source`, `read_document`.

Operacje zapisu:

| Operacja | Skutek |
|---|---|
| `create_item` | Nowy projekt, zadanie lub podzadanie. |
| `update_item` | Zmiana pól: status, kondycja, termin, właściciel, moja rola, tytuł, aliasy. |
| `link_source` | Powiązanie wrzutki, fragmentu lub dokumentu z itemem. |
| `add_fact` | Fakt w itemie, ze źródłem i cytatem. |
| `supersede_fact` | Oznaczenie faktu jako nieaktualnego, opcjonalnie ze wskazaniem następcy. |
| `set_item_person` | Rola osoby w itemie i jej oczekiwania. |
| `create_person` | Nowa osoba. |
| `update_person` | Atrybuty i aliasy osoby. |
| `resolve_mention` | Powiązanie wzmianki z osobą. |
| `create_note` | Notatka z datą, rodzajem i uczestnikami. |
| `set_fragments` | Podział notatki na fragmenty i ich powiązania z itemami. |
| `merge_items`, `merge_people` | Scalenie duplikatów. |
| `ask_user` | Pytanie o niejednoznaczność z listą kandydatów. |
| `finish` | Zakończenie przetwarzania ze zwięzłym podsumowaniem. |

Każda operacja zapisu niesie: źródło, cytat (gdy wynika z materiału), uzasadnienie i poziom pewności. Kolejne etapy rozszerzają katalog.

## Załącznik B. Odwzorowanie pomysłu wyjściowego

| Element pomysłu wyjściowego | Realizacja w PRD |
|---|---|
| Wejściem jest chat z agentem | Jedno pole wejściowe dla materiału, pytań i poleceń (8.1); przetwarzanie w tle z wynikiem w Inboxie (8.3); rozmowa (8.7) |
| Polecenia, notatki, zrzuty i treść wiadomości, dokumenty | Wrzutki (8.1), notatki (8.6), dokumenty (8.9) |
| Agent sprawdza, czy materiał dotyczy istniejącego zadania, czy trzeba stworzyć nowe | Przypisanie do zera, jednego lub wielu itemów i kontrola duplikatów (ING-2 do ING-4), z polityką stosowania (ING-7) |
| Wymagania | Fakty typu `wymaganie` ze źródłem (ITM-6) i sekcja na stronie itemu (ITM-8) |
| Stakeholderzy | Osoby z rolą i oczekiwaniami w itemie (ITM-5) |
| Status | Status i kondycja z historią (ITM-2, ITM-7) oraz generowane podsumowanie stanu (ITM-9) |
| Komunikacja | Źródła powiązane z itemem: wrzutki i fragmenty notatek (ITM-8) |
| Podzadania | Hierarchia itemów (ITM-4) |
| Knowledge base z dokumentów | Dokumenty i wiedza (8.9) |
| Elegancka prezentacja, TipTap, tabele | Edytor dla treści pisanej (8.11); dane strukturalne jako elementy interfejsu (EDT-2) |
| Rozmowa o dowolnym zadaniu i aktualizacje na prośbę | Rozmowa z agentem (CHT-2, CHT-3) |
| Uruchomienie lokalne | NFR-1, NFR-3, NFR-12 |
| Model Anthropic z kluczem oraz zewnętrzny Model Router | Workspace i profile LLM (8.13), ograniczenia warstwy LLM (11.1) |
| Wykrywanie osób i notatki ze spotkań powiązane z wieloma zadaniami | Osoby (8.5), notatki (8.6), scenariusz 9.2 |
