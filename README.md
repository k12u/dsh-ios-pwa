# DSH Mobile

[English](README.md) | 日本語

A React / TypeScript PWA for operating DeepSeek Harness from a smartphone, plus a thin Gateway served from the same origin.

**Verified against a real Harness RC.1: startup, HTTPS/WSS initial sync, and real model responses to text prompts. Acceptance testing — including browser operation, iPhone / Android, and Push delivery — is not yet complete.** Target APIs were cross-checked against the official Harness 0.1.2-rc.1 distribution and the reference Gateway 0.7.1. Current limitations and open verification items are recorded in [docs/acceptance.md](docs/acceptance.md).

## Local preview

Runs on Node.js 22.12 or later (CI uses 24).

```sh
npm ci
npm run build
npm run dev
```

Open the `http://localhost:8787/pair?t=...` link from the console within 5 minutes. The preview Agent is a demo and runs no models or shells. You can verify Inbox approvals and questions, Sessions, conversation streaming, and image attachments. Restarting resets the demo state and device authentication.

`localhost` and `127.0.0.1` are different origins. In a browser, use the localhost link exactly as displayed. The HTTP exception is for loopback development only. To serve to a smartphone, use a Harness plugin configured with an HTTPS origin.

On a Mac, if Node.js / pnpm themselves are not installed yet, manage them through your user nix-darwin / Home Manager configuration. This project does not modify system or shell settings.

## Using as a Harness plugin

1. Place this repository on the host where the official `dsh web` runs, then install dependencies and build.
2. Change `publicOrigin` in `gateway/cordis.patch.yml` to the actual HTTPS origin of the PWA.
3. Add the plugin and restart Harness.

```sh
dsh plugin --profile web add link:/absolute/path/dsh-ios-pwa/gateway
dsh web
```

Example:

```yaml
- insert:
    - id: mobile-pwa
      name: dsh-plugin-mobile-pwa
      config:
        publicOrigin: https://your-host.example
        port: 8787
        pushSubject: mailto:operator@example.com
```

If `pushSubject` is omitted, the Push capability is not advertised. VAPID keys, hashes of authenticated devices, and Push subscriptions are stored in `~/.local/state/dsh-mobile/` with mode 0600. The storage location can be changed with `dataDir` or the `DSH_MOBILE_DATA_DIR` environment variable (`dataDir` takes precedence). Compatibility smoke tests use an isolated temporary directory. Do not commit this data to Git.

The Gateway listens only on `127.0.0.1:8787`. Point Tailscale Serve or your HTTPS reverse proxy at this port. Only the Gateway port is forwarded externally. Do not forward the Harness Web UI port or the raw Remote API. The Gateway serves `/`, `/api/*`, `/ws/mobile`, and `/push/*` together.

Opening `http://localhost:<Harness port>/mobile-pwa` on the Harness host lets you issue a pairing QR code / link that is valid for 5 minutes and one use only. Scan it with your phone's standard camera to connect. On first startup, the link also appears in the console. Authenticated devices can be revoked from the PWA's Settings.

This local admin page does not currently add a link to the sidebar; open the URL above directly. The browser never receives a long-lived token; instead an `HttpOnly; Secure; SameSite=Strict; Path=/` Cookie is set.

## Architecture and boundaries

```text
Official Harness (external runtime)
  → gateway/src/adapters/
  → gateway/src/normalization/adapter.ts
  → packages/protocol/ (Zod + TypeScript)
  → packages/domain/
  → web/src/state/ + projections/
  → React UI
```

- `packages/protocol`: a self-contained Mobile Protocol v1, a separate contract from the reference native client's wire protocol. Strips unknown fields and ignores unknown events.
- `gateway/src/adapters`: normalizes the Host API, raw events, the HITL waterfall, and task / goal projections. The PWA never knows the Harness version.
- `gateway/src/auth`: one-time pairing, expiring cookies, revocation, rate limiting.
- `gateway/src/push`: RFC 8291 encryption and RFC 8292 VAPID using Node crypto / fetch. Notification bodies never contain tool arguments or conversation content.
- `web`: Inbox / Tasks / Sessions, Conversation / Activity / Files, a generic approval / question renderer, reconnection, and the PWA shell.
- `vendor/mobile-gateway`: saved sources and contract tests of the reference Gateway. Not part of the distribution. Only the reused Host Adapter is placed in `gateway/src/adapters/upstream`.

No fork, bundling, or native wrapper of Harness itself. No GitHub forks or public repositories have been created. An acceptance-testing Gateway is deployed inside the dsh1 tailnet.

The boundary that keeps raw APIs out of React is protected by tests that inspect import resolution and by HTTP contract tests that feed extra internal fields into the Adapters. History, snapshots, session creation results, and realtime events pass through shared Zod schemas before being sent. For example, `assistant/chunk` is converted to `message.delta` in the Adapter, and the PWA never interprets `turn` / `step` / `chunk`. Arguments and results shown in Activity are also normalized string previews.

## Sync and operation

The connection order is hello → authoritative snapshot → events buffered while that snapshot was being fetched. History for the selected session is re-fetched as well, and writes stay disabled until it completes. Display state is never restored by WebSocket reconnection alone.

History and live events produce the same IDs / seqs in the Adapter. Delayed history pages are accepted too, with message completion bodies treated as authoritative. HITL is not settled by a receipt; it settles on a formal resolved event or on a snapshot after reconnect. A repeated prompt request ID prevents duplicate execution for 24 hours within a single Gateway process. The browser never auto-resends.

The app does not assume the socket survives backgrounding; it resyncs on visibility / pageshow / online. A 401 stops retries and returns to the pairing screen; a stopped Gateway results in retry intervals capped at about 30 seconds.

Images are limited client-side to PNG / JPEG / WebP / GIF, 3.5 MB each, up to 4 images. Actual image validation and session membership checks are handled by the official Harness. Images are fetched through a dedicated Cookie-protected route. There is no API for reading arbitrary paths. General file transfer, SHA-256 download verification, and Web Share are Phase 2.

## PWA and updates

Includes a manifest, 192/512px icons, standalone display, and safe-area support. The Service Worker handles only the public shell / hashed assets and Push. APIs, pairing, conversations, and credentials are never stored in the Cache API.

IndexedDB stores up to 50 workspace / session / task summaries each, for at most 7 days. Conversations, images, tool results, and unresolved approvals / questions are never stored. Offline, the last fetched information is shown and writes are disabled.

Updates are applied when the user explicitly reloads via the update banner. The app never auto-reloads the Agent or the UI mid-use.

For iPhone Push, add the app to the Home Screen, open it from there, and grant notification permission in Settings. Browsers without the subscription API show an explanation. Push providers are limited to the designated Apple / FCM / Mozilla / Windows hosts; there is no capability to fetch arbitrary external URLs.

## Verification

```sh
npm run build
npm test
npm run test:upstream
npm run test:network
```

Run `npm test` after building. It verifies HTTP handlers, in-memory forwarding of real WebSocket frames, concurrent snapshot / events, Origin / Cookie / revoke, request idempotency, history merging, HITL, XSS, PWA assets, and Push against published RFC vectors.

`test:network` is for environments where TCP is available. It additionally verifies pairing / streaming / reconnect over real sockets. `test:upstream` runs contract tests against the saved original Host Adapter; it does not claim that all tests of the original Gateway have been run.

```sh
DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:harness
```

The Harness smoke test uses a temporary `DSH_HOME` and verifies official runtime + plugin startup, static serving, pairing, host/workspace/session snapshots, and WebSocket hello / snapshot initial sync. The full prompt / HITL / image paths that use a model require separate verification over a real connection.

CI includes build / contracts / network smoke plus weekly and manual Harness boot matrices against the latest public stable / RC / alpha releases. **CI has not been run yet, and compatibility across all channels is not guaranteed.**

Static layout documentation can also be generated:

```sh
npm run preview:static
```

`test-results/preview.html` is an on-screen preview with no communication.

## Single-package distribution

```sh
npm run build
npm pack --workspace gateway
```

The tarball contains the Gateway, the compiled shared contracts, and the PWA assets. Runtime dependencies are only ws and zod; Harness remains external. When changing the Protocol, update this distribution unit as well.

See also: [Mobile Gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway), [native mobile client](https://github.com/Clarklevis1995/dsh-mobile), [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292). For provenance and licensing, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
