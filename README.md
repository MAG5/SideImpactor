# Side Impactor

Browser-based IPA signing and installation. Pair an iOS device over WebUSB, sign with your Apple Developer account, and install — all from a single web page.

## Quick Start

```bash
bun install --ignore-scripts
bun run dev
```

Open `http://localhost:5173`.

## Remote IPA links

Open the page with a fragment and the IPA is fetched automatically:

| Link | Behavior |
|---|---|
| `#ipa=https://host/App.ipa` | Downloads directly. The host must send `Access-Control-Allow-Origin`. |
| `#gh=<owner>/<repo>` | Resolves the latest GitHub release and picks its `.ipa` asset. |
| `#gh=<owner>/<repo>@<tag>` | Same, for a specific release tag. |

After the download, **Install Now** signs and installs in one step (prompting for
login and device pairing when needed).

Completed downloads are kept in Cache Storage (`sideimpactor-ipa-v1`) keyed by the
resolved asset URL, so reloading the page reuses the IPA instead of downloading it
again; the card shows a **Cached** badge and a **Re-download** action. Verification
is still enforced: a cached copy that fails the GitHub `sha256` digest is dropped
and fetched again. Clearing site data removes the cache. Without Cache Storage
(insecure context or private mode) it falls back to downloading normally.

GitHub's release CDN does not allow cross-origin reads, so `#gh=` falls back to the
public `https://gh-proxy.com/` mirror. The mirror is only used when GitHub reports a
`sha256` digest for the asset, and the downloaded bytes are verified against it.
Override with `localStorage.setItem('webmuxd:ipa-proxy', 'https://your-mirror/')`
(`{url}` template supported) or disable it with `'off'`; `VITE_IPA_PROXY` sets the
build-time default.

## Anisette

Apple's GSA endpoints need anisette headers (machine ID + one-time password) for
every login request. They are fetched over HTTP from the relay's `/anisette`
route, which forwards to a Mac-side anisette server. The Worker is not an open
proxy: the upstream list is fixed to `new.ani.sidestore.io` (preferred) with
`mac-ani.jkcoxson.com` as fallback, and a response missing the required
`X-Apple-*` headers is rejected before it reaches the browser. Both are
third-party services — they receive Apple's lookup request but never your Apple
ID password, and the password is only sent to Apple over the WISP connection.

The browser always requests a fresh header set (OTPs are single-use). The device
identity sent to Apple comes from the browser, not the upstream: it claims
`<MacBookPro18,3> <macOS;26.6;25F84>` and pairs the SRP calls with AuthKit's
`AuthKit/1 (Macintosh; OS X 26.6) (com.apple.dt.Xcode/26.0)` user agent. GSA
correlates the two, so mixing an old client-info with a newer user agent (or
vice versa) fails with -22410. Every value can be overridden for debugging:

```js
localStorage.setItem('webmuxd:anisette-url', 'https://your-relay.example/anisette');
localStorage.setItem('webmuxd:anisette-client-info', '<MacBookPro18,3> <macOS;26.6;25F84> ...');
```

The relay also sets `x-anisette-upstream` on `/anisette` responses so you can see
which server minted the headers.

`VITE_ANISETTE_URL` sets the build-time endpoint; otherwise it is derived from
`VITE_WISP_URL` (same host, path `/anisette`). Self-hosted relays must implement
the route: `GET /anisette` returns the anisette JSON headers with
`Access-Control-Allow-Origin`, and `OPTIONS` answers 204.

## Project Structure

| Path | Purpose |
|---|---|
| `frontend/` | React + Tailwind SPA (Vite) |
| `backend/` | Cloudflare Workers relay |
| `dependencies/webmuxd/` | WebUSB usbmux/lockdown protocol library |
| `wasm/openssl/` | OpenSSL WASM (TLS + pair record generation) |
| `wasm/libcurl-wasm/` | libcurl WASM (Apple API HTTP via WISP proxy) |
| `wasm/zsign-wasm/` | zsign WASM (IPA re-signing) |
| `scripts/` | WASM native build scripts (Rust + Emscripten) |

## Build

```bash
# WASM dist bundles (copies pre-built src→dist, no compiler needed)
bun run build:wasm:dist

# Frontend production build (runs wasm:dist automatically)
bun run build:frontend

# Full WASM recompile from source (requires Rust, Emscripten, precompiled OpenSSL)
bun run build:wasm
```

Hosting is Worker-only: the Cloudflare Worker serves the built SPA from
`frontend/dist`, plus `/wisp/` and `/anisette` on the same origin, so no
`VITE_BASE` or `VITE_WISP_URL` is needed. Build, then deploy:

```bash
bun run build:frontend
cd backend && bun run deploy
```

## Docker

```bash
bun run build:wasm:dist   # ensure WASM dists exist
docker build -t sideload-web .
docker run -p 3000:3000 sideload-web
```

## Cloudflare

```bash
cd backend
bun run deploy
```

## Test

```bash
bun run test            # webmuxd unit tests
bun run test:frontend   # frontend vitest suite
```

## Credits

Projects referenced:
- [libimobiledevice](https://github.com/libimobiledevice/libimobiledevice)
- [webmuxd](https://github.com/hack-different/webmuxd)
- [zsign](https://github.com/nicehash/zsign)
- [AltSign](https://github.com/rileytestut/AltSign/)
- [AltStore](https://github.com/altstoreio/AltStore)
- [openssl-wasm](https://github.com/nicehash/openssl-wasm)
- [anisette-js](https://github.com/lbr77/anisette-js)
- [unicorn](https://github.com/lbr77/unicorn/tree/tci-emscripten)

Friends helped with feedback:
- [@Lakr233](https://github.com/Lakr233)

