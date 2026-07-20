# fetchurl JavaScript SDK

Protocol-level client for [fetchurl](https://github.com/fetchurl/spec) content-addressable cache servers.

Uses the Web Crypto API — works in Node.js 19+, Deno, Bun, and browsers. Pass any spec-compliant `fetch` for dependency injection.

## Install

```bash
npm install fetchurl-sdk
```

## Protocol

Normative behavior: **[fetchurl/spec](https://github.com/fetchurl/spec)** (`SPEC.md`).

Reference server: **[fetchurl/fetchurl](https://github.com/fetchurl/fetchurl)**.

## Usage

```js
import { fetchurl, parseFetchurlServer } from 'fetchurl-sdk';

const servers = parseFetchurlServer(process.env.FETCHURL_SERVER ?? '');
const data = await fetchurl({
  fetch,
  servers,
  algo: 'sha256',
  hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sourceUrls: ['https://cdn.example.com/file.tar.gz'],
});
// data is Uint8Array, hash-verified
```

Clients **must** treat the server as untrusted and verify the hash (this SDK does that for you).

## Environment

| Variable | Meaning |
|----------|---------|
| `FETCHURL_SERVER` | Server base URL(s) per the [spec](https://github.com/fetchurl/spec/blob/main/SPEC.md) (RFC 8941 list or a single URL). Empty/absent disables server use. |

## Development

```bash
npm install
npm test
# Integration tests (needs Docker + fetchurl image):
# FETCHURL_TEST_IMAGE=fetchurl:local npm run test:integration
```
