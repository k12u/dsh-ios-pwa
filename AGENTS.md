# Project instructions

- Keep all Harness API names, events, endpoint arguments and compatibility checks under `gateway/src/adapters/`. `vendor/` and isolated upstream tests are reference material.
- PWA imports only the shared Mobile Protocol and stable domain; never a Harness runtime package.
- Do not add raw RPC, remote terminal, long-lived browser-readable credentials, or conversation/tool-output persistence.
- Keep write controls disabled until authoritative reconnect sync finishes.
- Acknowledgements do not resolve approval/question state. Use authoritative events or snapshots.
- Build Gateway and PWA together. Run `npm run build`, `npm test`, and `npm run test:upstream` for changes to these boundaries.
- Run `npm run test:network` where TCP is permitted. Do not describe fixture tests as a successful live Harness or mobile-device validation.
- Apply the user-wide nix-darwin/Home Manager policy to machine/tool installation. Project-local dependency installation does not change that system configuration.
