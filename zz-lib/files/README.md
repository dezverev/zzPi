# zz-lib

Shared runtime helpers for project-local Pi applications.

`zz-lib` is the shared layer used by `zz-plugs`, `zz-refs`, and future app
bundles. It installs common files under `.pi/extensions/zz-lib/` and records
ownership in `.pi/zz-lib-manifest.json`. Consumer bundles declare a `sharedDeps`
requirement and import helpers from `./zz-lib/...`.

## Docs

Start with the documentation set in [`../../docs/zz-lib/`](../../docs/zz-lib/):

- [Overview](../../docs/zz-lib/README.md)
- [Architecture and ownership](../../docs/zz-lib/architecture.md)
- [Consumer app guide](../../docs/zz-lib/consumer-apps.md)
- [Authoring shared APIs](../../docs/zz-lib/authoring.md)

## Build locally

```bash
python3 tools/build-pi-plugs.py --src clients/zz-lib --catalog clients/zz-lib/zz-lib.catalog.jsonc --dest /tmp/test-zz-lib
```
