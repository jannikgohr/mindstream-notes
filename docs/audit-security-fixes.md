# Security audit fixes

This change resolves C5, H7, L2, and L7 from `docs/audit-2026-09.md`.

## C5: authenticate the preview proxy

The preview service now uses one app lifetime loopback gateway. Each data and
control route has a random 128 bit token in its URL path. The gateway rejects
missing, incorrect, and expired tokens before it connects to a plugin process.
It also requires the exact gateway `Host` and accepts only the app, gateway, or
opaque sandbox origin. Stopping a preview removes both route tokens.

The proxy passes the client's `Origin` to the upstream WebSocket service. It no
longer replaces a foreign origin with a trusted loopback origin.

## H7: restrict webview network access

The packaged CSP no longer grants `http:`, `https:`, `ws:`, or `wss:` as broad
`connect-src` sources, and `frame-src` no longer grants every loopback port.
Before the main webview loads, Rust reads the saved account and adds only that
server's HTTP and WebSocket origins. It also adds the preview gateway's exact
loopback origin to `connect-src` and `frame-src`.

Sign-in and sign-out await all registered editor saves, update the native
session, and reload the document. The new document receives the CSP for the new
session, so an old account origin cannot remain authorized after an account
change. Preview documents restrict connections to their own authenticated
gateway origin.

## L2: bound Luau native tool time

Luau scripts now have an absolute invocation deadline in addition to their
script execution allowance. Time spent in a native tool can still be credited
back to Luau execution, but repeated native tool calls cannot move the absolute
deadline. Each process timeout is capped by the remaining invocation time.

## L7: validate WebSocket handshakes

The gateway parses one complete HTTP/1.1 request head, rejects duplicate or
malformed headers and body-bearing requests, and verifies the WebSocket upgrade,
connection token, version 13, and a base64 key that decodes to 16 bytes. It
constructs a new upstream handshake from a small allowlist, so cookies,
authorization headers, forwarding headers, and the session token are not sent
to the plugin process.

## Validation

- `cargo fmt -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- focused frontend auth and editor flush tests
- frontend type checking
