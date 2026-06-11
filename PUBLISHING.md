# Publishing to npm (optional — for `npm i -g pairwave` discovery)

The GitHub one-liner install does NOT need npm. Publishing only adds `npm install -g pairwave` as a
second way in. It requires YOUR npm login — it can't be done for you (npm needs your credentials/2FA).

Good news: as of this writing the names **`pairwave`** and the **`@pairwave/*`** scope are FREE on
npm, so they're yours to claim.

## One-time
1. Free account at https://www.npmjs.com.
2. `npm login` (in this repo folder).
3. Create the `@pairwave` org/scope on npm (free) so the scoped packages can publish.

## Publish (each release)
```bash
npm run verify            # must be green (build + 95 tests)
npm publish -w @pairwave/protocol  --access public
npm publish -w @pairwave/relay     --access public
npm publish -w @pairwave/companion --access public
npm publish -w pairwave            --access public
```
Bump the versions in the four package.json files first; keep them in lockstep.

That's it — nothing else about the product depends on npm.
