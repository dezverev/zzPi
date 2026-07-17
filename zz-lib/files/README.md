# zz-lib

`zz-lib` is the shared runtime for project-local Pi applications. It installs
common helpers under `.pi/extensions/zz-lib/` and records ownership in
`.pi/zz-lib-manifest.json`. Consumer bundles declare a `sharedDeps` requirement
and import helpers from `./zz-lib/...`.

The public zzPi installer resolves and installs `zz-lib` automatically whenever
a selected plug requires it. Public runtime files, the manifest, and the archive
are generated from the maintained `zzHostWebsite/clients/zz-lib` source.

## Maintainer documentation

The architecture and authoring documentation lives in the source repository:

- [zz-lib overview](https://github.com/dezverev/zzHostWebsite/blob/master/docs/zz-lib/README.md)
- [Architecture and ownership](https://github.com/dezverev/zzHostWebsite/blob/master/docs/zz-lib/architecture.md)
- [Consumer app guide](https://github.com/dezverev/zzHostWebsite/blob/master/docs/zz-lib/consumer-apps.md)
- [Authoring shared APIs](https://github.com/dezverev/zzHostWebsite/blob/master/docs/zz-lib/authoring.md)

Those maintainer docs and source build tools are not duplicated into the public
runtime archive. Change the canonical source and use the zzPi export workflow;
do not edit generated `zz-lib/files/`, manifest, or archive content directly.
