# RemoraHQ - Core

Infrastructure plugin for the RemoraHQ 2.0 admin UI. First member of the
`RemoraHQ - *` plugin family on MeshCentral.

## Purpose

Provide the **plugin channel** between the RemoraHQ web UI and MeshCentral.
Subsequent RemoraHQ plugins (Alert State, Auditor Role, Reports, Terminal
Bridge) extend the same wire format.

The plugin provides the RemoraHQ command channel, including `ping` and
MeshCentral patch verification. At startup it checks twelve required source
anchors and, when MongoDB change streams are enabled, checks whether delete
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
  "version": "0.16.1",
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
current MeshCentral 1.3.1 overlay and exact-profile procedure are in
`../../.setup/modules/meshcentral-overlay/README.md`. Preserve Device Policy
enforcement and use its matching procedure: the base installer refuses policy
profiles. Older full-file copies must not replace upstream files.
MongoDB delete events require MongoDB 6.0+ with
`changeStreamPreAndPostImages` enabled on the main collection. Other local
databases do not use that MongoDB condition.

## Patch diagnostics

Core 0.16.1 retains the five existing guards and adds seven source checks used
by the current SPA: the step-up command and HTTP persistence route, Chat protocol
11 bridge, Event Logs handler and native Buffer repair, and Desktop local-end
signal in both MeshCore and relay. All seven are included unconditionally in
the ordinary eight-file `meshcentral-overlay / 1.3.1-remora.3` release. They are
requirements of those functions, not additional optional modules. Agent U identity,
Windows license fields, legacy orgcfg/jobs/pssnapshot, native frontend UTF-8 helper
and separate Device Policy/LAB modules are outside this required set.

`present` means the expected fragment was found in the resolved on-disk source.
`missing` distinguishes an absent fragment, unresolved module or read error;
an unreadable source is unverified, not proof that the patch is absent. This
compatible report does not prove complete file hashes, executing code, endpoint
delivery, Windows runtime, or installation time. MongoDB readiness remains a
separate conditional runtime prerequisite; it is not required for other databases.
The current SPA already displays this report without a fixed patch inventory.

Run the public plugin action check from the workspace root, using source-only
fixtures and the local upstream Git tag (no server or database access):

```powershell
node .plugins/RemoraHQ-Core-Plugins/test/mesh-patches.cjs .setup/modules/meshcentral-overlay/files .тесты/MeshCentral
```

This standalone source change reaches the setup only after a separate reviewed
snapshot of its committed public files and updated version/provenance/hashes in
`modules/plugin-remoraCore`. Existing pinned setup assets are not updated by
editing this repository. Local archive creation does not publish or activate Core;
the owner performs the native manager update and readback.

## License

Apache-2.0 (matches MeshCentral). See `LICENSE`.
