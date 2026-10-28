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
  "version": "0.17.0",
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

## User history pages (Core 0.17.0 pilot)

`ping` advertises `capabilities.userEventsPage: 1`. This means protocol support,
not database readiness. Only the MongoDB native backend (`databaseType: 3`)
is supported; other backends return `unsupported-db`. No indexes, collections,
validators, secrets or data are created by this action.

Request: `action: 'plugin'`, `plugin: 'remoraCore'`,
`pluginaction: 'userEventsPage'`, `targetUser: 'user//fixture'`,
optional `filter: 'agentlog' | 'relaylog'`, `pageSize: 50`, and optional `cursor`.
Use `targetUser`: MeshCentral overwrites `command.userid` with the caller.
The authenticated caller must have native ManageUsers in the same domain;
the query preserves native `domain AND (ids includes target OR actor is target)`.
Rights are checked before and after asynchronous reads, including the current
server user map when available. Client roles never authorize the query.

Success echoes `protocol: 1`, `targetUser`, normalized `filter` (null for All),
`tag`/`responseid`, `events`, `nextCursor`, and `previousCursor`. There is no
invented total. Up to 50 original stored rows are returned in descending
`(time, ObjectId)` order; peer copies and identical real events are retained.
The projection preserves all fields used by the SPA audit mapper, including
msgid/msgArgs and account name/role context. Irrelevant account fields are not
returned. Text/arguments exceeding display limits are explicitly marked
`payloadTruncated`; the row and cursor remain, so oversized data never traps
navigation. This is a bounded viewer, not a lossless raw-payload export.
Serialized event arrays are capped at 512 KiB (the full reply stays below 1 MiB),
so a page may contain fewer than 50 rows and still have a continuation.
The reader streams with driver batchSize(1), sanitizes each row immediately,
retains only bounded display events and small cursor tuples, and closes the
cursor in finally. It does not retain 51 raw documents. The response budget is
not a whole-process heap budget: one raw BSON document can still reach 16 MiB,
with additional driver/JavaScript/string-serialization overhead and concurrent
requests. A real-Mongo fixture traverses 60 one-MiB raw messages. Heap peaks and
concurrent maximum-size documents have not been benchmarked.

Opaque AES-GCM cursors bind actor, domain, target, filter, upper time and
last `(time, ObjectId)` plus direction, with a 30-minute traversal lifetime.
The encryption key exists only in the current Core instance. Restart, another
peer, expiry, changed scope or tampering returns `invalid-cursor`; Refresh
starts a new traversal. No key is persisted or shared across peers. Both
navigation directions use keyset queries; the SPA retains only its current
page rather than accumulating full history or a cursor stack.

Opening/refreshing an unfiltered or filtered traversal checks scoped historical
key types once. Non-Date timestamps or non-ObjectId keys return
`unsupported-history` instead of silently excluding historical rows. This
admission check scans the matching history and is not free. Native event keys
must remain immutable during traversal. Each MongoDB query has maxTimeMS 5000;
query failures/timeouts return `history-query-failed` without DB details.
The fixed upper time hides later arrivals until Refresh, but TTL/deletion and
late historical writes can affect subsequent/backward reads. This is a retained
history traversal, not a point-in-time snapshot or an archival guarantee.

### Performance prerequisite and pilot limitation

Native indexes lack the explicit `_id` sort tie-breaker. Synthetic MongoDB 7
measurements confirmed full scan/sort with native indexes on every page;
bounded payload alone does **not** reduce total database load. On isolated
250k mixed actor-only/ids-only records, two additional candidate indexes
`{domain:1, ids:1, time:-1, _id:-1}` and
`{domain:1, userid:1, time:-1, _id:-1}` enabled bounded SORT_MERGE reads on both
branches (51-52 examined documents for first/early/deep pages). They increased
index storage and indexed-field update cost. These are measured candidates,
not an automatic migration or production readiness claim. Index adoption and
production plans/size/write-budget validation require the owner's decision.
Without that prerequisite the pilot remains useful for protocol validation,
but must not be promoted as a database-load optimization.

Old Core keeps native 60/120/250 and an explicitly selected Unlimited with its
existing warning. The SPA never automatically falls back from a failed or
unsupported paged action to an unbounded request. It renegotiates capability
on reconnect, discards pending responses for the old connection/scope, resets
legacy Unlimited to 60 after reconnect, and shows errors without stale rows.

The independent contract fixture uses actual MongoDB and the official driver
installed in a separate test runtime. Supply a disposable random-port localhost
MongoDB and the runtime root; the test refuses the default DB port and creates
only a uniquely named `remora_activity_fixture_*` database, removed afterward:

```powershell
node test/user-events-page.cjs mongodb://127.0.0.1:49152/ <test-runtime-root>
```

An optional third path records synthetic 100k/250k query measurements. Do not
point this fixture at application settings or a working database. No server
or live database was used to validate this pilot outside the disposable test
container. Package/npm version 0.12.6 remains the historical package identity;
runtime/config plugin version is 0.17.0, following the existing release layout.
