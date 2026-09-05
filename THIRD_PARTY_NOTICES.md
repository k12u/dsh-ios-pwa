# Third-party notices

- **dsh-plugin-mobile-gateway 0.7.1**, Copyright (c) 2026 Clarklevis1995, MIT. Original reference files and tests are in `vendor/mobile-gateway/`; per-file Git blob IDs are recorded in `PROVENANCE.json`. `gateway/src/adapters/upstream/dsh-host-adapter.mjs` is an unchanged copy of its Host Adapter. The normalized event and HITL mappings were informed by that implementation. License: `vendor/mobile-gateway/LICENSE`. Source: https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway
- **Marked v16.2.1**, MIT. Unmodified TypeScript lexer/parser source in `vendor/marked/src/`, fetched from the version tag. Used as a GFM lexer, with a separate React token renderer. License: `vendor/marked/LICENSE.md`. Source: https://github.com/markedjs/marked/tree/v16.2.1
- **QR Code Generator**, Copyright (c) 2009 Kazuhiko Arase, MIT. `gateway/src/pairing/qrcode.cjs` is the upstream `js/dist/qrcode.js` retrieved 2026-09-05; only the filename changed. `web/src/pairing/qrcode.js` is the same copy converted to ESM (the CommonJS footer replaced with an `export default`). License: `gateway/src/pairing/LICENSE`. Source: https://github.com/kazuhikoarase/qrcode-generator
- **DefinitelyTyped ws declarations**, Microsoft Corporation, MIT. `gateway/src/types/ws/index.d.ts` was retrieved from `types/ws/index.d.ts` on 2026-09-05 and wrapped in an ambient module for local resolution. License: `gateway/src/types/ws/LICENSE`. Source: https://github.com/DefinitelyTyped/DefinitelyTyped
- **@speed-highlight/core 1.2.24**, CC0-1.0, installed through npm. Its tokenizer supplies escaped React fragments; its HTML rendering API is not used.
- React, React DOM, Vite, TypeScript, Zod, ws, tsx, esbuild and their transitive dependencies retain the licenses distributed in their npm packages.
- RFC 8291 public cryptographic test values are used solely for interoperability tests. Production keys are generated separately. No private operational credentials are included in this repository. Specification: https://www.rfc-editor.org/rfc/rfc8291

The direct dependency tarball URLs are intentional exact-version pins used to install from an existing offline npm cache in a restricted environment. `package-lock.json` records integrity hashes. These can be returned to ordinary semver pins during a network-enabled dependency update.

No DeepSeek Harness runtime source or binary is distributed in the Gateway package. No Swift / Kotlin / native UI source is used.
