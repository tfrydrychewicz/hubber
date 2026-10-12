// The word banks of the synthetic world. Everything here is invented: the given names and the
// surnames are common ones and are paired at random, the teams and the projects do not exist,
// and every address is under the reserved name ".example". No name comes from a real directory.
// A given name and a surname that chance pairs can still be the name of a person who exists,
// and among the five hundred persons of the largest world some are: nothing else about such a
// person is in the data.
// The texts are templates: they give the database its volume, and are no material for judging
// what the agent makes of a text.
import type { FactType } from "../../../shared/vocabulary.ts";

/** A given name in the case forms that a chat or a note uses, with its everyday short form. */
export interface GivenName {
  /** Nominative, genitive, dative, accusative, instrumental. */
  forms: readonly [string, string, string, string, string];
  /** The short form in the same five cases, for a name that has one in common use. */
  short?: readonly [string, string, string, string, string];
  lang: "pl" | "en";
  feminine: boolean;
}

type Forms = readonly [string, string, string, string, string];

const pl = (feminine: boolean, forms: Forms, short?: Forms): GivenName =>
  short === undefined ? { forms, lang: "pl", feminine } : { forms, short, lang: "pl", feminine };
const en = (name: string, feminine: boolean): GivenName => ({
  forms: [name, name, name, name, name],
  lang: "en",
  feminine,
});

export const GIVEN_NAMES: readonly GivenName[] = [
  pl(
    true,
    ["Katarzyna", "Katarzyny", "Katarzynie", "Katarzynę", "Katarzyną"],
    ["Kasia", "Kasi", "Kasi", "Kasię", "Kasią"],
  ),
  pl(true, ["Anna", "Anny", "Annie", "Annę", "Anną"], ["Ania", "Ani", "Ani", "Anię", "Anią"]),
  pl(
    false,
    ["Piotr", "Piotra", "Piotrowi", "Piotra", "Piotrem"],
    ["Piotrek", "Piotrka", "Piotrkowi", "Piotrka", "Piotrkiem"],
  ),
  pl(false, ["Marek", "Marka", "Markowi", "Marka", "Markiem"]),
  pl(
    true,
    ["Magdalena", "Magdaleny", "Magdalenie", "Magdalenę", "Magdaleną"],
    ["Magda", "Magdy", "Magdzie", "Magdę", "Magdą"],
  ),
  pl(
    false,
    ["Tomasz", "Tomasza", "Tomaszowi", "Tomasza", "Tomaszem"],
    ["Tomek", "Tomka", "Tomkowi", "Tomka", "Tomkiem"],
  ),
  pl(true, ["Agnieszka", "Agnieszki", "Agnieszce", "Agnieszkę", "Agnieszką"], ["Aga", "Agi", "Adze", "Agę", "Agą"]),
  pl(false, ["Michał", "Michała", "Michałowi", "Michała", "Michałem"]),
  pl(false, ["Paweł", "Pawła", "Pawłowi", "Pawła", "Pawłem"]),
  pl(true, ["Joanna", "Joanny", "Joannie", "Joannę", "Joanną"], ["Asia", "Asi", "Asi", "Asię", "Asią"]),
  pl(
    false,
    ["Krzysztof", "Krzysztofa", "Krzysztofowi", "Krzysztofa", "Krzysztofem"],
    ["Krzysiek", "Krzyśka", "Krzyśkowi", "Krzyśka", "Krzyśkiem"],
  ),
  pl(true, ["Monika", "Moniki", "Monice", "Monikę", "Moniką"]),
  pl(false, ["Łukasz", "Łukasza", "Łukaszowi", "Łukasza", "Łukaszem"]),
  pl(true, ["Ewa", "Ewy", "Ewie", "Ewę", "Ewą"]),
  pl(false, ["Jakub", "Jakuba", "Jakubowi", "Jakuba", "Jakubem"], ["Kuba", "Kuby", "Kubie", "Kubę", "Kubą"]),
  pl(true, ["Karolina", "Karoliny", "Karolinie", "Karolinę", "Karoliną"]),
  pl(false, ["Marcin", "Marcina", "Marcinowi", "Marcina", "Marcinem"]),
  pl(
    true,
    ["Aleksandra", "Aleksandry", "Aleksandrze", "Aleksandrę", "Aleksandrą"],
    ["Ola", "Oli", "Oli", "Olę", "Olą"],
  ),
  pl(false, ["Adam", "Adama", "Adamowi", "Adama", "Adamem"]),
  pl(true, ["Natalia", "Natalii", "Natalii", "Natalię", "Natalią"]),
  pl(
    false,
    ["Grzegorz", "Grzegorza", "Grzegorzowi", "Grzegorza", "Grzegorzem"],
    ["Grzesiek", "Grześka", "Grześkowi", "Grześka", "Grześkiem"],
  ),
  pl(true, ["Zofia", "Zofii", "Zofii", "Zofię", "Zofią"], ["Zosia", "Zosi", "Zosi", "Zosię", "Zosią"]),
  pl(
    false,
    ["Wojciech", "Wojciecha", "Wojciechowi", "Wojciecha", "Wojciechem"],
    ["Wojtek", "Wojtka", "Wojtkowi", "Wojtka", "Wojtkiem"],
  ),
  pl(true, ["Dorota", "Doroty", "Dorocie", "Dorotę", "Dorotą"]),
  pl(false, ["Rafał", "Rafała", "Rafałowi", "Rafała", "Rafałem"]),
  pl(true, ["Beata", "Beaty", "Beacie", "Beatę", "Beatą"]),
  pl(false, ["Kamil", "Kamila", "Kamilowi", "Kamila", "Kamilem"]),
  pl(true, ["Iwona", "Iwony", "Iwonie", "Iwonę", "Iwoną"]),
  pl(
    false,
    ["Bartosz", "Bartosza", "Bartoszowi", "Bartosza", "Bartoszem"],
    ["Bartek", "Bartka", "Bartkowi", "Bartka", "Bartkiem"],
  ),
  pl(true, ["Sylwia", "Sylwii", "Sylwii", "Sylwię", "Sylwią"]),
  pl(false, ["Dawid", "Dawida", "Dawidowi", "Dawida", "Dawidem"]),
  pl(true, ["Justyna", "Justyny", "Justynie", "Justynę", "Justyną"]),
  pl(false, ["Mateusz", "Mateusza", "Mateuszowi", "Mateusza", "Mateuszem"]),
  pl(
    true,
    ["Małgorzata", "Małgorzaty", "Małgorzacie", "Małgorzatę", "Małgorzatą"],
    ["Gosia", "Gosi", "Gosi", "Gosię", "Gosią"],
  ),
  pl(false, ["Andrzej", "Andrzeja", "Andrzejowi", "Andrzeja", "Andrzejem"]),
  pl(true, ["Barbara", "Barbary", "Barbarze", "Barbarę", "Barbarą"], ["Basia", "Basi", "Basi", "Basię", "Basią"]),
  pl(false, ["Jan", "Jana", "Janowi", "Jana", "Janem"], ["Janek", "Janka", "Jankowi", "Janka", "Jankiem"]),
  pl(true, ["Maria", "Marii", "Marii", "Marię", "Marią"], ["Marysia", "Marysi", "Marysi", "Marysię", "Marysią"]),
  pl(
    false,
    ["Stanisław", "Stanisława", "Stanisławowi", "Stanisława", "Stanisławem"],
    ["Staszek", "Staszka", "Staszkowi", "Staszka", "Staszkiem"],
  ),
  pl(true, ["Paulina", "Pauliny", "Paulinie", "Paulinę", "Pauliną"]),
  en("Emma", true),
  en("Oliver", false),
  en("Sarah", true),
  en("James", false),
  en("Laura", true),
  en("Daniel", false),
  en("Sophie", true),
  en("Michael", false),
  en("Hannah", true),
  en("David", false),
  en("Emily", true),
  en("Robert", false),
  en("Julia", true),
  en("Thomas", false),
  en("Alice", true),
  en("Simon", false),
];

/** The masculine and the feminine form of a surname; one text when both are the same. */
export const SURNAMES_PL: readonly (readonly [string, string] | string)[] = [
  "Nowak",
  ["Kowalski", "Kowalska"],
  ["Wiśniewski", "Wiśniewska"],
  "Wójcik",
  "Kowalczyk",
  ["Kamiński", "Kamińska"],
  ["Lewandowski", "Lewandowska"],
  ["Zieliński", "Zielińska"],
  ["Szymański", "Szymańska"],
  "Woźniak",
  ["Dąbrowski", "Dąbrowska"],
  ["Kozłowski", "Kozłowska"],
  ["Jankowski", "Jankowska"],
  "Mazur",
  ["Wojciechowski", "Wojciechowska"],
  ["Kwiatkowski", "Kwiatkowska"],
  "Krawczyk",
  "Kaczmarek",
  ["Piotrowski", "Piotrowska"],
  ["Grabowski", "Grabowska"],
  "Zając",
  ["Pawłowski", "Pawłowska"],
  ["Michalski", "Michalska"],
  "Król",
  "Wieczorek",
  ["Jabłoński", "Jabłońska"],
  "Wróbel",
  ["Nowakowski", "Nowakowska"],
  ["Majewski", "Majewska"],
  ["Olszewski", "Olszewska"],
  "Stępień",
  ["Malinowski", "Malinowska"],
  ["Jaworski", "Jaworska"],
  "Adamczyk",
  "Dudek",
  ["Nowicki", "Nowicka"],
  "Pawlak",
  ["Górski", "Górska"],
  ["Witkowski", "Witkowska"],
  "Walczak",
  "Sikora",
  "Baran",
  ["Rutkowski", "Rutkowska"],
  "Michalak",
  "Szewczyk",
  ["Ostrowski", "Ostrowska"],
  ["Tomaszewski", "Tomaszewska"],
  "Pietrzak",
  ["Zalewski", "Zalewska"],
  ["Wróblewski", "Wróblewska"],
];
export const SURNAMES_EN: readonly string[] = [
  "Smith",
  "Taylor",
  "Brown",
  "Wilson",
  "Clark",
  "Walker",
  "Hall",
  "Young",
  "King",
  "Wright",
  "Green",
  "Baker",
  "Hill",
  "Scott",
  "Adams",
  "Turner",
  "Parker",
  "Collins",
  "Morris",
  "Cook",
];

export interface Team {
  name: string;
  /** The prefix of its keys in the tracker. */
  key: string;
}
export const TEAMS: readonly Team[] = [
  { name: "Płatności", key: "PAY" },
  { name: "Platforma", key: "PLT" },
  { name: "Mobile", key: "MOB" },
  { name: "Dane", key: "DAT" },
  { name: "Bezpieczeństwo", key: "SEC" },
  { name: "Web", key: "WEB" },
  { name: "Infrastruktura", key: "OPS" },
  { name: "CRM", key: "CRM" },
  { name: "Rozliczenia", key: "BIL" },
  { name: "Wyszukiwarka", key: "SRCH" },
  { name: "Checkout", key: "CHK" },
  { name: "Onboarding", key: "ONB" },
  { name: "Analityka", key: "ANL" },
  { name: "QA", key: "QA" },
  { name: "Design", key: "DSN" },
  { name: "Produkt", key: "PRD" },
  { name: "Wsparcie", key: "SUP" },
  { name: "Finanse", key: "FIN" },
  { name: "Prawny", key: "LEG" },
  { name: "Sprzedaż", key: "SAL" },
  { name: "Partnerzy", key: "PAR" },
  { name: "IT", key: "IT" },
];

export const JOB_TITLES: readonly string[] = [
  "Engineering Manager",
  "Staff Engineer",
  "Senior Engineer",
  "Software Engineer",
  "Product Manager",
  "Designer",
  "QA Engineer",
  "Data Analyst",
  "Tech Lead",
  "Director of Engineering",
  "Scrum Master",
  "Security Engineer",
  "SRE",
  "Kierownik projektu",
  "Analityk biznesowy",
  "Prawnik",
  "Opiekun klienta",
];

export const CODENAMES: readonly string[] = [
  "Atlas",
  "Orion",
  "Kormoran",
  "Bursztyn",
  "Latarnia",
  "Żuraw",
  "Meridian",
  "Kompas",
  "Halny",
  "Jantar",
  "Sokół",
  "Tatry",
  "Neptun",
  "Wega",
  "Rysy",
  "Bałtyk",
  "Polaris",
  "Zefir",
  "Mistral",
  "Kwarc",
  "Granit",
  "Bazalt",
  "Wrzos",
  "Jesion",
  "Modrzew",
  "Kasztan",
  "Perła",
  "Koral",
  "Szafir",
  "Rubin",
  "Topaz",
  "Onyks",
  "Helios",
  "Aurora",
  "Nimbus",
  "Cumulus",
  "Sirocco",
  "Pasat",
  "Monsun",
  "Kaskada",
  "Delta",
  "Fregata",
  "Galeon",
  "Horyzont",
  "Iskra",
  "Jutrzenka",
  "Kometa",
  "Lawina",
  "Mgławica",
  "Nurt",
];
export const DESCRIPTIVE_PROJECTS: readonly string[] = [
  "Migracja płatności",
  "Nowy onboarding",
  "Redesign koszyka",
  "Platforma danych 2.0",
  "SSO dla partnerów",
  "Obniżenie kosztów chmury",
  "Checkout v3",
  "Mobile offline mode",
  "Audit log",
  "Wyszukiwarka pełnotekstowa",
  "Rozliczenia B2B",
  "Panel administratora",
  "Self-service reporting",
  "Migracja do Kubernetes",
  "Program stażowy",
  "Rekrutacja Staff Engineer",
  "Przegląd bezpieczeństwa",
  "API publiczne v2",
  "Powiadomienia push",
  "Wersja dla tabletów",
  "Integracja z ERP",
  "Data retention policy",
  "Monitoring i alerty",
  "Feature flags platform",
  "Performance budget",
  "Faktury elektroniczne",
];
export const PROJECT_SUFFIXES: readonly string[] = [
  "",
  "",
  "",
  " 2",
  " Mobile",
  " API",
  " — faza 2",
  " Q3",
  " MVP",
  " Next",
];
/** What the owner puts in brackets behind a title when the item changes. */
export const TITLE_MARKS: readonly string[] = ["pilne", "wersja 2", "po zmianach", "nowy zakres"];

/** What a task is about, with the verb that makes its title. */
export const TASK_VERBS_PL: readonly string[] = [
  "Przygotować",
  "Sprawdzić",
  "Uzgodnić",
  "Wysłać",
  "Zaktualizować",
  "Zamknąć",
  "Opisać",
  "Zamówić",
  "Przejrzeć",
  "Dokończyć",
];
export const TASK_VERBS_EN: readonly string[] = ["Review", "Draft", "Ship", "Update", "Schedule", "Fix"];
/** Things a sentence can be about. The Polish ones in the accusative, where they mostly stand. */
export const THINGS_PL: readonly string[] = [
  "plan testów",
  "budżet",
  "raport z audytu",
  "umowę z dostawcą",
  "środowisko staging",
  "migrację danych",
  "dokumentację API",
  "przegląd bezpieczeństwa",
  "estymację",
  "harmonogram",
  "makiety",
  "wyniki testów obciążeniowych",
  "plan wdrożenia",
  "analizę kosztów",
  "listę wymagań",
  "decyzję architektoniczną",
  "dostępy dla zespołu",
  "konfigurację monitoringu",
  "retrospektywę",
  "aneks do umowy",
  "plan rekrutacji",
  "zakres MVP",
];
export const THINGS_EN: readonly string[] = [
  "the load test results",
  "the rollout plan",
  "the vendor contract",
  "the API docs",
  "the security review",
  "the capacity estimate",
  "the runbook",
  "the dashboard",
  "the feature flag",
  "the migration script",
  "the incident report",
  "the budget",
  "the hiring plan",
  "the design review",
  "the on-call rota",
  "the staging environment",
  "the data model",
  "the release notes",
];
/** What a milestone is called: an event or a state that is reached, not work that someone does. */
export const MILESTONES: readonly string[] = [
  "Release",
  "Code freeze",
  "Demo dla zarządu",
  "Podpisanie umowy",
  "Start pilotażu",
  "Przegląd bezpieczeństwa zakończony",
  "Go-live",
  "Komitet sterujący",
  "Budżet zatwierdzony",
  "Audit sign-off",
];
export const DUE_PL: readonly string[] = [
  "do piątku",
  "jutro",
  "w przyszłym tygodniu",
  "do końca miesiąca",
  "do środy",
  "na czwartek",
  "do końca tygodnia",
  "pojutrze",
];
export const DUE_EN: readonly string[] = [
  "by Friday",
  "tomorrow",
  "next week",
  "by end of month",
  "by EOD Wednesday",
  "by Thursday",
];

/**
 * What a sentence gives the agent to do: a fact of an item, a new task, another status, another
 * due day, the closing of an item, a person nobody has heard of yet.
 */
export type Signal = "fact" | "task" | "status" | "date" | "done" | "person";

/**
 * A sentence of a thread or a note. Slots: {item} the name or an alias of the item, {pn} a person
 * in the nominative, {pg} in the genitive, {pd} in the dative, {pi} in the instrumental, {thing},
 * {due}, {team}, {key} a key of the tracker, {new} the full name of a person who is new.
 */
export interface Sentence {
  lang: "pl" | "en";
  signal: Signal;
  /** The type of the fact, for a sentence that states one. */
  type: FactType;
  text: string;
}
const s = (lang: "pl" | "en", signal: Signal, type: FactType, text: string): Sentence => ({
  lang,
  signal,
  type,
  text,
});
export const SENTENCES: readonly Sentence[] = [
  s("pl", "fact", "decision", "Zdecydowaliśmy, że {item} wdrażamy bez okna serwisowego."),
  s("pl", "fact", "decision", "Ustalone z {pi}: {item} wchodzi na produkcję {due}."),
  s("pl", "fact", "decision", "Decyzja: w {item} odkładamy {thing} na kolejny kwartał."),
  s("pl", "fact", "decision", "{pn} zatwierdza {thing} dla {item}, nie czekamy na zespół {team}."),
  s("pl", "fact", "risk", "Testy wydajnościowe w {item} opóźnione o tydzień."),
  s("pl", "fact", "risk", "Ryzyko: {item} może nie zdążyć {due}, wciąż brakuje nam {thing}."),
  s("pl", "fact", "risk", "{item} stoi przez zespół {team}, tzn. nie mamy środowiska ({key})."),
  s("pl", "fact", "risk", "Jeśli {pn} odejdzie z projektu, {item} zostaje bez właściciela po stronie {team}."),
  s("pl", "fact", "requirement", "Wymaganie od {pg}: {item} musi obsłużyć {thing} już w pierwszej wersji."),
  s("pl", "fact", "requirement", "{item} ma działać także dla klientów zespołu {team}, np. w trybie tylko do odczytu."),
  s("pl", "fact", "requirement", "Dla {item} potrzebujemy zgody zespołu {team} na {thing}."),
  s("pl", "fact", "info", "{pn} potwierdza, że mamy już {thing} dla {item}."),
  s("pl", "fact", "info", "W {item} zamknęliśmy {key}, zostaje {thing}."),
  s("pl", "fact", "info", "Rozmawiałem z {pi} o {item}: budżet bez zmian."),
  s("pl", "fact", "question", "Kto po naszej stronie odpowiada za {thing} w {item}?"),
  s("pl", "fact", "question", "Czy {item} wymaga zgody zespołu {team}?"),
  s("pl", "task", "info", "{pn} przygotuje {thing} dla {item} {due}."),
  s("pl", "task", "info", "Muszę odpisać {pd} w sprawie {item} {due}."),
  s("pl", "task", "info", "{pn} ma wysłać {thing} ({item}) {due}."),
  s("pl", "task", "info", "Czekam na {thing} od {pg}, {item}, termin {due}."),
  s("pl", "status", "info", "{item} zablokowane, czekamy na zespół {team}."),
  s("pl", "status", "info", "{item} znowu w toku, {pn} wraca do tego od jutra."),
  s("pl", "date", "info", "Termin dla {item} się przesuwa, nowa data {due}."),
  s("pl", "done", "info", "{item} zrobione, {pn} zamyka {key}."),
  s("pl", "person", "info", "Do zespołu {team} dołącza {new}, od przyszłego tygodnia pracuje nad {item}."),
  s("en", "fact", "decision", "We decided to ship {item} without a maintenance window."),
  s("en", "fact", "decision", "Agreed with {pn}: {item} goes live {due}."),
  s("en", "fact", "decision", "Decision: we drop {thing} from {item} for now."),
  s("en", "fact", "risk", "Risk: {item} may slip, {thing} is still missing."),
  s("en", "fact", "risk", "{item} is blocked on {team}, see {key}."),
  s("en", "fact", "requirement", "Requirement from {pn}: {item} must support {thing} from day one."),
  s("en", "fact", "requirement", "{item} needs sign-off from {team} before we touch {thing}."),
  s("en", "fact", "info", "FYI {thing} for {item} is done."),
  s("en", "fact", "info", "{pn} confirmed {thing} for {item}, no budget change."),
  s("en", "fact", "question", "Open question: who owns {thing} for {item}?"),
  s("en", "task", "info", "{pn} will send {thing} for {item} {due}."),
  s("en", "task", "info", "I owe {pn} an answer on {item} {due}."),
  s("en", "status", "info", "{item} is blocked again, waiting for {team}."),
  s("en", "date", "info", "{item} slips, the new date is {due}."),
  s("en", "done", "info", "{item} is done, {pn} is closing {key}."),
  s("en", "person", "info", "{new} is joining {team} and will pick up {item}."),
];

/** What the agent writes down as the fact, in its own words: the quote stays in the source. */
export const STATEMENTS: Readonly<Record<FactType, readonly string[]>> = {
  decision: ["Decyzja w sprawie {item}: {thing}.", "Decision recorded for {item}: {thing}."],
  requirement: ["{item}: wymagane jest {thing}.", "{item} requires {thing}."],
  risk: ["Ryzyko w {item}: {thing} może opóźnić prace.", "Risk for {item}: {thing} may delay the work."],
  info: ["{item}: {thing} potwierdzone.", "{item}: {thing} confirmed."],
  question: ["Pytanie otwarte w {item}: {thing}.", "Open question for {item}: {thing}."],
};

/** Talk of a thread that gives the agent nothing to do. */
export const FILLERS: readonly string[] = [
  "ok, dzięki",
  "daj znać, jak będziesz wiedzieć",
  "wrzucam na jutrzejsze daily",
  "jasne, biorę to",
  "możemy się zdzwonić po 15?",
  "nie mam tego w kalendarzu",
  "to nie jest pilne, ale nie chcę tego zgubić",
  "sounds good",
  "ack",
  "will check and get back to you",
  "can we sync tomorrow?",
  "let me look at the numbers first",
  "+1",
  "widziałem, odpiszę po spotkaniu",
  "przekażę dalej",
  "thanks, that helps",
];
/** The prose of a meeting note between the sentences that matter. */
export const NOTE_PROSE: readonly string[] = [
  "Omówiliśmy jeszcze plan urlopów na przyszły miesiąc i to, kto przejmuje dyżury, gdy połowa zespołu będzie na konferencji.",
  "Wróciliśmy do tematu retrospektywy: zespół prosi o mniej spotkań statusowych i jedno dłuższe planowanie zamiast dwóch krótkich.",
  "Rozwój: chce w przyszłym roku poprowadzić większy projekt, najlepiej taki, w którym będzie kontakt z klientem.",
  "We also talked about the on-call load, which has been uneven for the last two sprints, and agreed to revisit the rota next month.",
  "Krótko o rekrutacji: mamy trzech kandydatów po rozmowie technicznej, decyzja zapadnie po spotkaniu z zespołem.",
  "Nothing new on the budget side; finance will send the updated forecast after the quarter closes.",
  "Na koniec o atmosferze w zespole: po ostatniej reorganizacji jest spokojniej, ale dwie osoby nadal nie wiedzą, komu raportują.",
  "Side note: the offsite is confirmed, agenda to follow, and everyone should book travel before the end of the week.",
];
export const NOTE_HEADERS: readonly string[] = [
  "1:1 z {pi}",
  "Spotkanie statusowe {item}",
  "Sync z zespołem {team}",
  "Weekly {team}",
  "Rozmowa z {pi}",
  "Planning {item}",
];
export const NOTE_DAYS: readonly string[] = ["dzisiaj", "wczoraj", "w poniedziałek", "przedwczoraj"];
/** What the owner types beside a pasted thread or a screenshot. */
export const REMARKS: readonly string[] = ["zobacz, co z tym zrobić", "fyi", "pilne?", "do przejrzenia", "na później"];
export const EXPECTATIONS: readonly string[] = [
  "Chce cotygodniowego statusu mailem.",
  "Oczekuje decyzji przed końcem kwartału.",
  "Zależy mu na braku przestojów.",
  "Wants a demo before the steering committee.",
  "Needs the cost estimate split by team.",
  "Pilnuje zgodności z audytem.",
];
/** What the owner notes about a person for himself. */
export const PERSON_NOTES: readonly string[] = [
  "Woli krótkie wiadomości niż spotkania.",
  "Najlepiej łapać rano, po południu ma warsztaty.",
  "Zna historię poprzedniej migracji, warto pytać o kontekst.",
  "Prefers written proposals before a call.",
];
export const RATIONALES: readonly string[] = [
  "Wątek wymienia projekt z nazwy, a zdanie opisuje konkretne ustalenie.",
  "Cytat wskazuje właściciela i termin; alias jest jednoznaczny w katalogu.",
  "The thread names the item explicitly and the sentence states a commitment with a date.",
  "Autor wypowiedzi odnosi się do zadania przez klucz z trackera.",
  "Zdanie dotyczy tego samego tematu co poprzednie, ale nie wymienia projektu wprost.",
  "The alias matches two items, so this goes to the Inbox as a question.",
];
/** The sentences a description of an item and a summary of a run are made of. */
export const SUMMARY_SENTENCES: readonly string[] = [
  "Projekt jest w toku, a najbliższy kamień milowy to przegląd bezpieczeństwa.",
  "Główne ryzyko dotyczy opóźnionych testów wydajnościowych.",
  "Otwarte pozostaje pytanie o właściciela po stronie zespołu partnerskiego.",
  "Ostatnia decyzja: wdrożenie bez okna serwisowego.",
  "Two tasks are waiting on other teams; nothing is overdue.",
  "Budget is unchanged and the vendor contract is signed.",
];
/** What a model call that failed reports: the class of the error and its message. */
export const CALL_ERRORS: readonly (readonly [type: string, message: string, status: number | null])[] = [
  ["APIError", "overloaded_error: Overloaded", 529],
  ["APIConnectionTimeoutError", "Request timed out.", null],
  ["RateLimitError", "rate_limit_error: Number of requests has exceeded the limit", 429],
];
/** Why a run fails for good, and what it reports then. */
export const RUN_ERRORS: readonly (readonly [code: string, message: string])[] = [
  ["refusal", "The model declined to process this material."],
  ["max_tokens", "The answer was cut off before the run finished."],
  ["no_finish", "The run ended without a finish."],
];
/** The models of the synthetic endpoint. Their names are invented, like everything here. */
export const MODELS: readonly string[] = ["model-large", "model-large", "model-small"];
