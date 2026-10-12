// Identifiers of the objects the application creates. The application assigns them, not the
// database, so that an operation can name the object it creates before anything is stored.
//
// An id is a three-letter prefix that says what kind of object it is, an underscore, and twelve
// random characters: itm_7k3m9x2p4q8w. The database checks the prefix and the character set of
// every id column, not the length.

/** The prefix of every kind of object that has an id of this form. */
export const ID_PREFIXES = {
  capture: "cap",
  capturePart: "prt",
  capturePartText: "ptx",
  person: "per",
  personAlias: "pal",
  item: "itm",
  itemDescription: "ide",
  itemAlias: "ial",
  itemPerson: "itp",
  mention: "mnt",
  fact: "fct",
  factPerson: "fcp",
  sourceLink: "lnk",
  job: "job",
  run: "run",
  operation: "opr",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type Id<K extends IdKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

export type CaptureId = Id<"capture">;
export type CapturePartId = Id<"capturePart">;
export type CapturePartTextId = Id<"capturePartText">;
export type PersonId = Id<"person">;
export type PersonAliasId = Id<"personAlias">;
export type ItemId = Id<"item">;
export type ItemDescriptionId = Id<"itemDescription">;
export type ItemAliasId = Id<"itemAlias">;
export type ItemPersonId = Id<"itemPerson">;
export type MentionId = Id<"mention">;
export type FactId = Id<"fact">;
export type FactPersonId = Id<"factPerson">;
export type SourceLinkId = Id<"sourceLink">;
export type JobId = Id<"job">;
export type RunId = Id<"run">;
export type OperationId = Id<"operation">;
/** A source has the id of the row in its kind's own table. Widens when notes, documents and messages become sources. */
export type SourceId = CaptureId;

// Crockford's base32 in lower case: no i, l, o or u, so an id read aloud or retyped is not
// mistaken for another one. 32 characters, five bits each.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** Twelve characters of five bits: 60 random bits. */
const RANDOM_LENGTH = 12;

const KINDS = Object.keys(ID_PREFIXES) as IdKind[];
const SHAPES = Object.fromEntries(
  KINDS.map((kind) => [kind, new RegExp(`^${ID_PREFIXES[kind]}_[${ALPHABET}]{${RANDOM_LENGTH}}$`)]),
) as Record<IdKind, RegExp>;
// What the database accepts in the id column of each kind: the prefix, the underscore, and one
// or more lower-case letters, digits and underscores.
const STORABLE = Object.fromEntries(
  KINDS.map((kind) => [kind, new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-z_]+$`)]),
) as Record<IdKind, RegExp>;

/** A new id of the given kind. */
export function newId<K extends IdKind>(kind: K): Id<K> {
  // A byte holds 256 values and 256 is a multiple of 32, so the low five bits of a random byte
  // are a random character: every character is as likely as every other.
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  let random = "";
  for (const byte of bytes) random += ALPHABET.charAt(byte & 31);
  return `${ID_PREFIXES[kind]}_${random}`;
}

/**
 * Whether a value is an id of the given kind, exactly as newId() writes one. For what arrives
 * from outside: a request, a tool call of the model. The database itself is less strict.
 */
export function isId<K extends IdKind>(kind: K, value: unknown): value is Id<K> {
  return typeof value === "string" && SHAPES[kind].test(value);
}

/**
 * The kind of object that an id names, read off its prefix, or undefined for a text that the
 * database would store as the id of no kind. For ids that the application holds already: it
 * goes by the rule of the database, which is why it also reads the short ids that tests write.
 * It is no check of what arrives from outside; that is isId().
 */
export function idKindOf(value: string): IdKind | undefined {
  return KINDS.find((kind) => STORABLE[kind].test(value));
}
