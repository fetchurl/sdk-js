/**
 * Fetchurl SDK for JavaScript.
 *
 * Protocol-level client for fetchurl content-addressable cache servers.
 * Uses Web Crypto API — works in Node.js 19+, Deno, Bun, and browsers.
 * Pass any spec-compliant `fetch` function for dependency injection.
 *
 * @example
 * import { fetchurl, parseFetchurlServer } from './fetchurl.js';
 *
 * const servers = parseFetchurlServer(process.env.FETCHURL_SERVER ?? '');
 * const data = await fetchurl({
 *   fetch,
 *   servers,
 *   algo: 'sha256',
 *   hash: 'e3b0c44...',
 *   sourceUrls: ['https://cdn.example.com/file.tar.gz'],
 * });
 * // data is Uint8Array, hash-verified
 *
 * @module fetchurl
 */

// --- Errors ---

export class FetchUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FetchUrlError';
  }
}

export class UnsupportedAlgorithmError extends FetchUrlError {
  constructor(algo) {
    super(`unsupported algorithm: ${algo}`);
    this.name = 'UnsupportedAlgorithmError';
    this.algo = algo;
  }
}

export class HashMismatchError extends FetchUrlError {
  constructor(expected, actual) {
    super(`hash mismatch: expected ${expected}, got ${actual}`);
    this.name = 'HashMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class AllSourcesFailedError extends FetchUrlError {
  constructor(lastError = null) {
    super('all sources failed');
    this.name = 'AllSourcesFailedError';
    this.lastError = lastError;
  }
}

export class PartialWriteError extends FetchUrlError {
  constructor(cause) {
    super(`partial write: ${cause?.message ?? cause}`);
    this.name = 'PartialWriteError';
    this.cause = cause;
  }
}

export class MissingSourceUrlsError extends FetchUrlError {
  constructor() {
    super('sourceUrls is required');
    this.name = 'MissingSourceUrlsError';
  }
}

// --- Algorithm helpers ---

/** Map from normalized algo name to Web Crypto algorithm identifier. */
const WEBCRYPTO_ALGOS = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha512: 'SHA-512',
};

/** Full digest length in hex characters for each supported algorithm. */
const DIGEST_HEX_LEN = {
  sha1: 40,
  sha256: 64,
  sha512: 128,
};

/**
 * Normalize algorithm name per spec: lowercase, only [a-z0-9].
 * @param {string} name
 * @returns {string}
 */
export function normalizeAlgo(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Check if a hash algorithm is supported.
 * @param {string} algo
 * @returns {boolean}
 */
export function isSupported(algo) {
  return normalizeAlgo(algo) in WEBCRYPTO_ALGOS;
}

/**
 * Expected hex length of a full digest for *algo*.
 * @param {string} algo
 * @returns {number}
 * @throws {UnsupportedAlgorithmError}
 */
export function expectedHexLength(algo) {
  const key = normalizeAlgo(algo);
  if (!(key in DIGEST_HEX_LEN)) {
    throw new UnsupportedAlgorithmError(key);
  }
  return DIGEST_HEX_LEN[key];
}

/**
 * Normalize a content hash per the fetchurl spec: full-length lowercase hex.
 *
 * Rejects null, blank, non-hex, and wrong-length values before any network I/O.
 * Mixed-case hex is accepted and returned lowercased.
 *
 * @param {string} algo - Hash algorithm (normalized or not).
 * @param {string | null | undefined} hash
 * @returns {string} Lowercase hex of the correct length for *algo*.
 * @throws {FetchUrlError|UnsupportedAlgorithmError}
 */
export function normalizeContentHash(algo, hash) {
  if (hash == null || !String(hash).trim()) {
    throw new FetchUrlError('hash is required');
  }
  const key = normalizeAlgo(algo);
  const expectedLen = expectedHexLength(key);
  const lower = String(hash).toLowerCase();
  if (lower.length !== expectedLen) {
    throw new FetchUrlError(
      `hash must be ${expectedLen} hex characters for ${key} (got ${lower.length})`,
    );
  }
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57; // 0-9
    const isHexLetter = c >= 97 && c <= 102; // a-f
    if (!isDigit && !isHexLetter) {
      throw new FetchUrlError('hash must be hexadecimal');
    }
  }
  return lower;
}

// --- SFV helpers (RFC 8941 string lists) ---

/**
 * Encode URLs as an RFC 8941 string list for the X-Source-Urls header.
 * @param {string[]} urls
 * @returns {string}
 */
export function encodeSourceUrls(urls) {
  return urls
    .map((url) => `"${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(', ');
}

/**
 * Parse FETCHURL_SERVER env var (RFC 8941 string list).
 * @param {string} value
 * @returns {string[]}
 */
export function parseFetchurlServer(value) {
  value = value.trim();
  if (value === '') return [];
  if (!value.startsWith('"')) {
    return [value];
  }
  const results = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (value[i] === ' ' || value[i] === '\t')) i++;
    if (i >= value.length) break;

    if (value[i] !== '"') {
      while (i < value.length && value[i] !== ',') i++;
      if (i < value.length) i++;
      continue;
    }
    i++;

    let s = '';
    while (i < value.length) {
      if (value[i] === '\\' && i + 1 < value.length) {
        s += value[i + 1];
        i += 2;
      } else if (value[i] === '"') {
        i++;
        break;
      } else {
        s += value[i];
        i++;
      }
    }
    results.push(s);

    while (i < value.length && value[i] !== ',') i++;
    if (i < value.length) i++;
  }
  return results;
}

// --- Hashing ---

/**
 * Try to import node:crypto for incremental hashing (Node/Deno/Bun).
 * Falls back to Web Crypto (buffers entire content) in browsers.
 */
let _nodeCrypto = null;
try {
  _nodeCrypto = await import('node:crypto');
} catch {
  // Not available (browser) — will use Web Crypto fallback
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Create an incremental hasher.
 *
 * Uses node:crypto when available (streaming, no buffering).
 * Falls back to Web Crypto (must call finish() with full data).
 *
 * @param {string} algo - Normalized algo name.
 * @returns {{ update(chunk: Uint8Array): void, finish(): Promise<string> }}
 */
export function createHasher(algo) {
  if (_nodeCrypto) {
    const h = _nodeCrypto.createHash(algo);
    return {
      update(chunk) {
        h.update(chunk);
      },
      async finish() {
        return h.digest('hex');
      },
    };
  }
  // Web Crypto fallback — accumulate and hash at the end
  const chunks = [];
  let totalLen = 0;
  return {
    update(chunk) {
      chunks.push(new Uint8Array(chunk));
      totalLen += chunk.byteLength;
    },
    async finish() {
      const full = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        full.set(c, offset);
        offset += c.byteLength;
      }
      const webAlgo = WEBCRYPTO_ALGOS[algo];
      return toHex(await crypto.subtle.digest(webAlgo, full));
    },
  };
}

/**
 * Hash data and return hex string.
 * @param {string} algo - Normalized algo name (sha1, sha256, sha512).
 * @param {Uint8Array} data
 * @returns {Promise<string>} Hex hash.
 */
export async function hashData(algo, data) {
  const h = createHasher(algo);
  h.update(data);
  return h.finish();
}

/**
 * Verify that data matches the expected hash.
 * @param {string} algo - Normalized algo name.
 * @param {string} expectedHash - Expected hex hash.
 * @param {Uint8Array} data
 * @returns {Promise<void>}
 * @throws {HashMismatchError}
 */
export async function verifyHash(algo, expectedHash, data) {
  const expected = normalizeContentHash(algo, expectedHash);
  const actual = await hashData(normalizeAlgo(algo), data);
  if (actual !== expected) {
    throw new HashMismatchError(expected, actual);
  }
}

// --- FetchAttempt ---

/**
 * @typedef {Object} FetchAttempt
 * @property {string} url - The URL to GET.
 * @property {Record<string, string>} headers - Headers to include.
 */

// --- FetchSession ---

/**
 * State machine driving the fetchurl client protocol.
 *
 * Servers are tried first (with X-Source-Urls), then direct
 * source URLs in random order per spec.
 */
export class FetchSession {
  #attempts = [];
  #current = 0;
  #algo;
  #hash;
  #done = false;
  #success = false;

  /**
   * @param {Object} options
   * @param {string[]} options.servers - Cache server base URLs.
   * @param {string} options.algo - Hash algorithm name.
   * @param {string} options.hash - Expected hex hash.
   * @param {string[]} options.sourceUrls - Direct source URLs.
   */
  constructor({ servers, algo, hash, sourceUrls = [] }) {
    if (!servers || servers.length === 0) {
      if (typeof process !== 'undefined' && process.env) {
        servers = parseFetchurlServer(process.env.FETCHURL_SERVER || '');
      } else {
        servers = [];
      }
    }

    if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) {
      throw new MissingSourceUrlsError();
    }

    this.#algo = normalizeAlgo(algo);
    if (!isSupported(this.#algo)) {
      throw new UnsupportedAlgorithmError(this.#algo);
    }
    // Spec: hashes MUST be lowercase hex of the full digest. Fail early on garbage.
    this.#hash = normalizeContentHash(this.#algo, hash);

    // sourceUrls is non-empty (validated above); always send X-Source-Urls on server attempts.
    const sourceHeader = encodeSourceUrls(sourceUrls);

    for (const server of servers) {
      const base = server.replace(/\/+$/, '');
      const url = `${base}/${this.#algo}/${this.#hash}`;
      this.#attempts.push({
        url,
        headers: { 'X-Source-Urls': sourceHeader },
      });
    }

    const shuffled = [...sourceUrls];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const url of shuffled) {
      this.#attempts.push({ url, headers: {} });
    }
  }

  /** Algorithm used (normalized). */
  get algo() {
    return this.#algo;
  }

  /** Expected hash. */
  get hash() {
    return this.#hash;
  }

  /**
   * Get the next attempt, or null if session is finished.
   * If an attempt fails without writing bytes, just call nextAttempt() again.
   * @returns {FetchAttempt | null}
   */
  nextAttempt() {
    if (this.#done || this.#current >= this.#attempts.length) return null;
    return this.#attempts[this.#current++];
  }

  /** Mark session as successful. */
  reportSuccess() {
    this.#done = true;
    this.#success = true;
  }

  /** Mark that bytes were written before failure. Stops further attempts. */
  reportPartial() {
    this.#done = true;
  }

  /** @returns {boolean} */
  succeeded() {
    return this.#success;
  }
}

// --- High-level fetch ---

/**
 * Best-effort cancel of a fetch response body stream.
 *
 * Undici/fetch keep the connection checked out until the body is cancelled or
 * fully consumed. Parity with sdk-python `_close_body` / sdk-java `closeQuietly`:
 * errors from cancel must not override the real fetch outcome or abort fallback.
 *
 * @param {ReadableStream | null | undefined} body
 * @returns {Promise<void>}
 */
export async function cancelBody(body) {
  if (body == null) return;
  const cancel = body.cancel;
  if (typeof cancel !== 'function') return;
  try {
    await cancel.call(body);
  } catch {
    // ignore
  }
}

/**
 * Fetch and verify a file from fetchurl servers or direct sources.
 *
 * @param {Object} options
 * @param {typeof globalThis.fetch} options.fetch - The fetch function (DI).
 * @param {string[]} [options.servers] - Cache server base URLs.
 * @param {string} options.algo - Hash algorithm (sha1, sha256, sha512).
 * @param {string} options.hash - Expected hex hash.
 * @param {string[]} [options.sourceUrls] - Direct source URLs.
 * @returns {Promise<Uint8Array>} Hash-verified content.
 * @throws {AllSourcesFailedError|PartialWriteError|UnsupportedAlgorithmError}
 */
export async function fetchurl({
  fetch: fetchFn,
  servers = [],
  algo,
  hash,
  sourceUrls = [],
}) {
  const session = new FetchSession({ servers, algo, hash, sourceUrls });
  let lastError = null;
  let attempt;

  while ((attempt = session.nextAttempt())) {
    let resp;
    try {
      resp = await fetchFn(attempt.url, { headers: attempt.headers });
    } catch (e) {
      lastError = e;
      continue;
    }

    // Only HTTP 200 is a content response (parity with sdk-python / sdk-java /
    // sdk-rust). Response.ok would also accept other 2xx (201, 204, …).
    if (resp.status !== 200) {
      lastError = new FetchUrlError(`unexpected status ${resp.status}`);
      await cancelBody(resp.body);
      continue;
    }

    const hasher = createHasher(session.algo);
    const chunks = [];
    let bytesRead = 0;
    try {
      // fetch may return null body (e.g. some 204/empty responses). Treat as empty stream.
      if (resp.body) {
        for await (const chunk of resp.body) {
          hasher.update(chunk);
          chunks.push(new Uint8Array(chunk));
          bytesRead += chunk.byteLength;
        }
      }
      const actualHash = await hasher.finish();
      if (actualHash !== session.hash) {
        throw new HashMismatchError(session.hash, actualHash);
      }
      const result = new Uint8Array(bytesRead);
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.byteLength;
      }
      session.reportSuccess();
      return result;
    } catch (e) {
      lastError = e;
      if (bytesRead > 0) {
        session.reportPartial();
        throw new PartialWriteError(e);
      }
    } finally {
      // Full success returns above (body already consumed). Failed attempts —
      // including PartialWriteError — still free the body so fallback / the
      // process can reuse sockets (undici keeps connections until cancel).
      if (!session.succeeded()) {
        await cancelBody(resp.body);
      }
    }
  }

  throw new AllSourcesFailedError(lastError);
}
