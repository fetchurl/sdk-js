/**
 * Type declarations for the fetchurl JavaScript SDK.
 * Runtime lives in fetchurl.js (ESM).
 */

/** Base error for all SDK failures. */
export class FetchUrlError extends Error {
  name: string;
  constructor(message: string);
}

/** Thrown when the hash algorithm is not supported. */
export class UnsupportedAlgorithmError extends FetchUrlError {
  algo: string;
  constructor(algo: string);
}

/** Thrown when downloaded content does not match the expected hash. */
export class HashMismatchError extends FetchUrlError {
  expected: string;
  actual: string;
  constructor(expected: string, actual: string);
}

/** Thrown when every server and source attempt failed. */
export class AllSourcesFailedError extends FetchUrlError {
  lastError: unknown;
  constructor(lastError?: unknown);
}

/** Thrown when bytes were written before a failure (no further attempts). */
export class PartialWriteError extends FetchUrlError {
  cause: unknown;
  constructor(cause?: unknown);
}

/** Thrown when sourceUrls is missing or empty. */
export class MissingSourceUrlsError extends FetchUrlError {
  constructor();
}

/** One GET the session wants the caller (or fetchurl) to perform. */
export interface FetchAttempt {
  url: string;
  headers: Record<string, string>;
}

/** Incremental hasher used while streaming a response body. */
export interface Hasher {
  update(chunk: Uint8Array): void;
  finish(): Promise<string>;
}

/**
 * Normalize algorithm name per spec: lowercase, only [a-z0-9].
 */
export function normalizeAlgo(name: string): string;

/**
 * Whether the algorithm is supported (sha1, sha256, sha512 after normalize).
 */
export function isSupported(algo: string): boolean;

/**
 * Expected hex length of a full digest for algo.
 * @throws {UnsupportedAlgorithmError}
 */
export function expectedHexLength(algo: string): number;

/**
 * Normalize a content hash: full-length lowercase hex for algo.
 * Rejects null, blank, non-hex, and wrong-length values.
 * @throws {FetchUrlError|UnsupportedAlgorithmError}
 */
export function normalizeContentHash(
  algo: string,
  hash: string | null | undefined,
): string;

/**
 * Encode URLs as an RFC 8941 string list for the X-Source-Urls header.
 */
export function encodeSourceUrls(urls: string[]): string;

/**
 * Parse FETCHURL_SERVER (RFC 8941 string list, or a single unquoted URL).
 */
export function parseFetchurlServer(value: string): string[];

/**
 * Create an incremental hasher (node:crypto when available, else Web Crypto).
 */
export function createHasher(algo: string): Hasher;

/**
 * Hash data and return lowercase hex.
 */
export function hashData(algo: string, data: Uint8Array): Promise<string>;

/**
 * Verify data matches expectedHash.
 * @throws {HashMismatchError}
 */
export function verifyHash(
  algo: string,
  expectedHash: string,
  data: Uint8Array,
): Promise<void>;

export interface FetchSessionOptions {
  /** Cache server base URLs. Empty/omitted falls back to FETCHURL_SERVER. */
  servers?: string[];
  /** Hash algorithm name (sha1, sha256, sha512; normalized). */
  algo: string;
  /** Expected content hash (full-length hex; mixed case accepted). */
  hash: string;
  /** Direct source URLs (required, non-empty). */
  sourceUrls?: string[];
}

/**
 * State machine: servers first (with X-Source-Urls), then shuffled sources.
 */
export class FetchSession {
  constructor(options: FetchSessionOptions);

  /** Normalized algorithm name. */
  readonly algo: string;

  /** Normalized expected hash (lowercase hex). */
  readonly hash: string;

  /**
   * Next attempt, or null when finished.
   * On failure with no bytes written, call again for the next attempt.
   */
  nextAttempt(): FetchAttempt | null;

  /** Mark success; stops further attempts. */
  reportSuccess(): void;

  /** Bytes were written before failure; stops further attempts. */
  reportPartial(): void;

  /** Whether reportSuccess was called. */
  succeeded(): boolean;
}

/**
 * Best-effort cancel of a fetch response body stream.
 * Errors from cancel are swallowed so they do not override the real outcome.
 */
export function cancelBody(
  body: { cancel?: ((reason?: unknown) => void | Promise<void>) | undefined } | null | undefined,
): Promise<void>;

export interface FetchurlOptions {
  /** Spec-compliant fetch (injected for portability / tests). */
  fetch: typeof globalThis.fetch;
  /** Cache server base URLs. Empty/omitted falls back to FETCHURL_SERVER. */
  servers?: string[];
  /** Hash algorithm (sha1, sha256, sha512). */
  algo: string;
  /** Expected hex content hash. */
  hash: string;
  /** Direct source URLs (required, non-empty). */
  sourceUrls?: string[];
}

/**
 * Fetch and hash-verify content from fetchurl servers or direct sources.
 * @throws {AllSourcesFailedError|PartialWriteError|UnsupportedAlgorithmError|MissingSourceUrlsError|FetchUrlError}
 */
export function fetchurl(options: FetchurlOptions): Promise<Uint8Array>;
