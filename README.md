# Bundlewhys

A static site reporting browser bundle sizes of front-end npm packages.

- Type any package on the home page to bundle it in the browser (esbuild-wasm, straight from the npm registry).
- `npm run measure` records the sample packages in `packages.json` (or only those passed as arguments) to `src/_data/sizes.json` using the same code in `lib/measure.js`.
- `npm start` serves the site locally; `npm run build` writes it to `_site/`.
