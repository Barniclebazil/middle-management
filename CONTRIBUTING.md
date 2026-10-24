# Contributing

## Code conventions

- Relative imports use explicit `.ts` extensions (`import { x } from './paths.ts'`). Tests run under Node's native type stripping, which needs real file extensions. esbuild and tsc (`allowImportingTsExtensions`) both accept this.
- Only erasable TypeScript syntax: no enums, no namespaces, no parameter properties (`erasableSyntaxOnly`).
- Use `import type` for type-only imports (`verbatimModuleSyntax`).
- Modules under `src/claude/`, `src/model/` and `src/shared/` must never import `vscode`. They are unit-tested with plain Node.
- Two TypeScript projects: root `tsconfig.json` covers `src/` and `test/` (ES2022, node + vscode types, no DOM); `webview/tsconfig.json` covers `webview/` (ES2022 + DOM, no node types). Both may import `src/shared/protocol.ts`.
- No runtime dependencies; everything is bundled by esbuild.

## Commands

- `npm run build` / `npm run watch` - dev bundles with sourcemaps
- `npm run typecheck` - both TypeScript projects
- `npm test` - `node --test` on `test/**/*.test.ts`
- `npm run package` - production build and `.vsix`
