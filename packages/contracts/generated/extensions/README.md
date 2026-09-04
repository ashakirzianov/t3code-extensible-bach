# Extension protocol, generated

Generated from `packages/contracts/src/extensions.ts`. **Do not edit.** Regenerate with
`pnpm --filter @t3tools/contracts generate:extensions`; a test fails on any diff.

- `protocol.schema.json` — JSON Schema (draft 2020-12) for the manifest and every
  protocol message, plus an `x-methods` map from method name to schema. Read this if your
  extension is not written in TypeScript.
- `protocol.d.ts` — the same shapes as plain TypeScript declarations, with no
  dependencies. Copy it into a TypeScript extension.

Prose lives in `docs/internals/extensions/protocol.md`.
