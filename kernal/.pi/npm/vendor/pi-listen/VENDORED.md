# Vendored: pi-listen

Kernal's fork of [`@codexstar/pi-listen`](https://github.com/codexstar69/pi-listen) 7.2.2 (MIT, © its
authors; `LICENSE` is theirs and stays). Upstream has been unmaintained since 2026-05-01. The owner's
decision (#250) was to vendor it and improve it here, rather than switch to a young fork.

- **Loaded:** as a local package, `./npm/vendor/pi-listen` in `kernal/.pi/settings.json`. It lives
  under `.pi/npm` so its dynamic `import("sherpa-onnx-node")` resolves from `.pi/npm/node_modules`,
  where `sherpa-onnx-node` is an optional dependency of `.pi/npm/package.json`.
- **Version:** `7.2.2-kernal.N`, where N counts kernal's changes.
- **Changes from upstream:** the first commit is upstream 7.2.2 verbatim. Kernal's changes are listed
  below; each is marked `// kernal:` in the code.
- **Tests:** `kernal/tests/pi-listen-vendored.test.ts`.

## Kernal's changes

(none yet)
