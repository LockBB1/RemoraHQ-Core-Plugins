# RemoraHQ - Core

Infrastructure plugin for the RemoraHQ 2.0 admin UI. First member of the
`RemoraHQ - *` plugin family on MeshCentral.

## Purpose

Provide the **plugin channel** between the RemoraHQ web UI and MeshCentral.
Subsequent RemoraHQ plugins (Alert State, Auditor Role, Reports, Terminal
Bridge) extend the same wire format.

The plugin provides the RemoraHQ command channel, including `ping` and
MeshCentral patch verification. At startup it checks five required source
markers and, when MongoDB change streams are enabled, checks whether delete
pre-images are available. Missing requirements produce a domain-scoped
critical event. The `verifyMeshPatches` plugin action returns the same report.

## Identity

| Field | Value |
|-------|-------|
| Display name | `RemoraHQ - Core` |
| Short name (Mesh shortName) | `remoraCore` |
| Entry file | `remoraCore.js` |
| Source repo folder | `RemoraHQ-Core-Plugins` |

`shortName` is a clean camelCase JS identifier without hyphens — MeshCentral
injects `obj.<shortName>` into client-side JS via dot-notation, so a shortName
with hyphens would produce a SyntaxError that breaks the entire Mesh frontend.

## Wire protocol

Client → Server:

```jsonc
{
  "action": "plugin",
  "plugin": "remoraCore",
  "pluginaction": "ping",
  "tag": "<correlation-id>",
  "responseid": "<correlation-id>"
}
```

Server → Client:

```jsonc
{
  "action": "plugin",
  "plugin": "remoraCore",
  "pluginaction": "ping",
  "tag": "<correlation-id>",
  "responseid": "<correlation-id>",
  "result": "ok",
  "pong": true,
  "version": "0.16.0",
  "server_time": "2026-05-15T14:00:00.000Z"
}
```

MeshCentral routes by `command.plugin` to `obj.serveraction(command, dbGet, ws)`.
Correlation is purely by `tag` / `responseid` on the RemoraHQ side.

## Install (development)

MeshCentral picks up plugins from `<datapath>/plugins/<shortName>/`. The folder
name **must** match `config.json::shortName` — `remoraCore` here, not the repo
folder name. For a local Git checkout, use a directory junction under the
explicit test datapath:

```powershell
# Example: both paths must be chosen for the local test environment.
New-Item -ItemType Junction `
  -Path '<datapath>\plugins\remoraCore' `
  -Target '<workspace>\.plugins\RemoraHQ-Core-Plugins'
```

Enable the plugin runtime in `<datapath>/config.json`:

```jsonc
{ "settings": { "plugins": { "enabled": true, "list": ["remoraCore"] } } }
```

Restart MeshCentral. With `settings.plugins.list`, MeshCentral loads the
plugin from the local folder at startup. Core resolves patch targets from
the running MeshCentral source tree, including a direct Git checkout. The
MeshCentral 1.2.6 overlay and reapply procedure are in
`../../.utils/patches/README.md`; older full-file copies must not replace
upstream files. MongoDB delete events require MongoDB 6.0+ with
`changeStreamPreAndPostImages` enabled on the main collection. Other local
databases do not use that MongoDB condition.

## License

Apache-2.0 (matches MeshCentral). See `LICENSE`.
