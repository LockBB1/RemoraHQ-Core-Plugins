# RemoraHQ - Core

Infrastructure plugin for the RemoraHQ 2.0 admin UI. First member of the
`RemoraHQ - *` plugin family on MeshCentral.

## Purpose

Provide the **plugin channel** between the RemoraHQ web UI (`lian/`) and
MeshCentral. Subsequent RemoraHQ plugins (Alert State, Auditor Role, Reports,
Terminal Bridge) extend the same wire format.

For RC-11.3.16 this plugin ships a single `ping` action — a round-trip
smoke test that verifies the channel works end-to-end before we layer real
business logic.

## Wire protocol

Client → Server:

```jsonc
{
  "action": "plugin",
  "plugin": "RemoraHQ-Core-Plugins",
  "pluginaction": "ping",
  "tag": "<correlation-id>",
  "responseid": "<correlation-id>"
}
```

Server → Client:

```jsonc
{
  "action": "plugin",
  "plugin": "RemoraHQ-Core-Plugins",
  "pluginaction": "ping",
  "tag": "<correlation-id>",
  "responseid": "<correlation-id>",
  "result": "ok",
  "pong": true,
  "version": "0.1.0",
  "server_time": "2026-05-15T14:00:00.000Z"
}
```

MeshCentral routes by `command.plugin` to this module's `serveraction(command, dbGet, ws)`.
Correlation is purely by `tag` / `responseid` on the RemoraHQ side.

## Install (development)

MeshCentral picks up plugins from `meshcentral/plugins/<shortName>/`. The
folder name **must** match `config.json::shortName`. For dev, symlink the
checkout into the Mesh tree:

```powershell
# from MeshCentral root
New-Item -ItemType SymbolicLink `
  -Path .\plugins\RemoraHQ-Core-Plugins `
  -Target "D:\…\.RemoraHQ_main\.plugins\RemoraHQ-Core-Plugins"
```

Enable the plugin runtime in `meshcentral-data/config.json`:

```jsonc
{ "settings": { "plugins": { "enabled": true } } }
```

Restart MeshCentral. The plugin should appear on `Admin → Plugins` in
RemoraHQ and in the upstream MeshCentral plugin admin page.

## License

Apache-2.0 (matches MeshCentral). See `LICENSE`.
