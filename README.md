# RemoraHQ - Core

Infrastructure plugin for the RemoraHQ 2.0 admin UI. First member of the
`RemoraHQ - *` plugin family on MeshCentral.

## Purpose

Provide the **plugin channel** between the RemoraHQ web UI and MeshCentral.
Subsequent RemoraHQ plugins (Alert State, Auditor Role, Reports, Terminal
Bridge) extend the same wire format.

This release ships a single `ping` action — a round-trip used by the
RemoraHQ UI to verify the channel works end-to-end before layering real
business logic.

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
  "version": "0.1.1",
  "server_time": "2026-05-15T14:00:00.000Z"
}
```

MeshCentral routes by `command.plugin` to `obj.serveraction(command, dbGet, ws)`.
Correlation is purely by `tag` / `responseid` on the RemoraHQ side.

## Install (development)

MeshCentral picks up plugins from `meshcentral/plugins/<shortName>/`. The
folder name **must** match `config.json::shortName` — i.e. `remoraCore` here,
not the repo folder name. Symlink under the correct name:

```powershell
# from MeshCentral root
New-Item -ItemType SymbolicLink `
  -Path .\plugins\remoraCore `
  -Target "D:\…\RemoraHQ-Core-Plugins"
```

Enable the plugin runtime in `meshcentral-data/config.json`:

```jsonc
{ "settings": { "plugins": { "enabled": true } } }
```

Restart MeshCentral. The plugin should appear under `Admin → Plugins` in
the upstream MeshCentral UI and in the RemoraHQ admin UI.

## License

Apache-2.0 (matches MeshCentral). See `LICENSE`.
