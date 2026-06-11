# Publishing to npm (optional — for `npm i -g pairwave` discovery)

The GitHub one-liner install does NOT need npm. Publishing is purely so people can also do
`npm install -g pairwave`. It requires YOUR npm account (the maintainer's) — it cannot be done for
you because it needs your login.

## One-time
1. Create a free account at https://www.npmjs.com if you don't have one.
2. `npm login` (in this repo's folder).
3. Check the names are free / yours:
   - `npm view pairwave` (the CLI) — if taken, change `name` in `packages/cli/package.json`.
   - `@pairwave/*` scope — create the org/scope on npm (free) or rename to an available scope.

## Each release
```bash
npm run verify            # must be green
npm publish -w @pairwave/protocol  --access public
npm publish -w @pairwave/relay     --access public
npm publish -w @pairwave/companion --access public
npm publish -w pairwave            --access public
```
(Bump versions in the package.json files first; keep them in lockstep.)

That's it — nothing else about the product depends on npm.
