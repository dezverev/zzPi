# zzPi

Public export of project-local Pi extensions/plugins.

This repository is generated. Do not edit generated `pi-plugs/` artifacts directly; regenerate this repo from the source checkout instead.

## Install

From a cloned checkout of this repo:

```bash
./install.sh --select
```

From the public git repo raw files:

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install.sh | bash -s -- --select
```

Useful options:

```bash
./install.sh --list
./install.sh --all
./install.sh --plugins git-status,readsubagent,explorationsubagent
./install.sh --dry-run --select
```

The installer writes project-local files under `./.pi/` in the directory where you run it.

## Repository layout

- `install.sh` — public installer script.
- `pi-plugs/manifest.json` — generated plugin manifest.
- `pi-plugs/pi-plugs.tar.gz` — generated plugin archive consumed by the installer.
- `pi-plugs/files/` — exported source files used to build the archive.
- `pi-plugs/files/README.md` — exported plugin catalog documentation.
- `pi-plugs/files/WORKFLOWMODE.md` — exported workflow mode documentation.

## Related docs

- [Plugin source README](pi-plugs/files/README.md)
- [Workflow mode guide](pi-plugs/files/WORKFLOWMODE.md)
