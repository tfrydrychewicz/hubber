import type { Endpoint } from "../endpoint.ts";
import type { Secret } from "./secret.ts";

/** How the credential travels: the profile says it, the sources only supply the value. */
export const AUTH_SCHEMES = ["x-api-key", "bearer"] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export interface CredentialTarget {
  /** The endpoint the workspace is pinned to. */
  endpoint: Endpoint;
  scheme: AuthScheme;
}

/** What the terminal and the interface may know about the credential. Never the value. */
export type CredentialStatus =
  | { available: true; source: "env"; variable: string }
  | { available: true; source: "file"; file: string }
  | { available: true; source: "helper"; file: string; program: string }
  | { available: false; message: string };

/** A credential that could not be obtained. The message is written for the user and holds no secret. */
export class CredentialError extends Error {
  override name = "CredentialError";
}

export interface CredentialProvider {
  readonly target: CredentialTarget;
  /** Which source serves this endpoint, or why none can. Reads the file, never runs the command. */
  status(): CredentialStatus;
  /**
   * The credential to send now. Runs the helper command when nothing is cached or the cached
   * value is past its lifetime; callers that arrive meanwhile wait for the same run.
   * Rejects with CredentialError.
   */
  get(): Promise<Secret>;
  /**
   * After the endpoint answered 401 to `rejected`: a different credential, or null when the
   * source has nothing newer. Two requests rejected with the same value cause one helper run.
   */
  renew(rejected: Secret): Promise<Secret | null>;
  /** Replaces every credential this provider has handed out. For everything that is stored or shown. */
  redact(text: string): string;
  /** Ends a helper command that is still running. */
  close(): void;
}
