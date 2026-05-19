/**
 * RemoraHQ - Core MeshCentral plugin.
 *
 * MeshCentral loads this file via pluginHandler.js as:
 *     require('<pluginPath>/remoraCore/remoraCore.js').remoraCore(parent);
 *
 * The shortName is a clean camelCase JS identifier (no hyphens) — Mesh injects
 * `obj.<shortName>` into client-side JS via dot-notation, so any hyphen in
 * shortName produces a SyntaxError that breaks the entire frontend.
 *
 * Wire protocol (RemoraHQ ↔ Mesh ↔ this plugin):
 *   client → server: { action:'plugin', plugin:'remoraCore',
 *                      pluginaction:'<verb>', tag:'<correlation>',
 *                      responseid:'<correlation>', ...payload }
 *   server → client: { action:'plugin', plugin:'remoraCore',
 *                      pluginaction:'<verb>', tag, responseid,
 *                      result:'ok'|'error', ...data }
 *
 * The RemoraHQ MeshCentralTransport matches responses purely by `tag`/`responseid`,
 * so action/pluginaction echo is informational. We still echo both to keep traces
 * readable in DevTools.
 *
 * Server startup also runs a Mesh-patch verifier: if any of the three RemoraHQ
 * patches in .meshcentral/modificate/patches/ has been undone (typically by a
 * Mesh upgrade), the plugin dispatches a Critical event that surfaces in the
 * RemoraHQ Alerts feed (event.ts mapper registers `remora-mesh-patch-missing`
 * as a critical alert action). See verify-mesh-patches.ps1 for the standalone
 * companion ops can run manually after every Mesh upgrade.
 */

'use strict';

var fs = require('fs');
var path = require('path');

var PLUGIN_SHORT_NAME = 'remoraCore';
var PLUGIN_VERSION = '0.2.0';

/** Patches we expect to find present in the deployed Mesh install. */
var REMORA_PATCHES = [
    {
        name: 'webserver-spa-remorahq',
        module: 'meshcentral/webserver.js',
        marker: '// [REMORAHQ-PATCH webserver-spa-remorahq v1.0.0 BEGIN]',
        hint: 'Re-run .meshcentral/modificate/patches/webserver-spa-remorahq.ps1'
    },
    {
        name: 'pluginhandler-getpluginpermissions-guard',
        module: 'meshcentral/pluginHandler.js',
        marker: '// [REMORAHQ-PATCH pluginhandler-getpluginpermissions-guard v1.0.0 BEGIN]',
        hint: 'Re-run .meshcentral/modificate/patches/pluginhandler-getpluginpermissions-guard.ps1'
    },
    {
        name: 'db-changestream-delete',
        module: 'meshcentral/db.js',
        marker: 'MODIFIED FOR REMORAHQ',
        hint: 'Copy .meshcentral/modificate/db.js over node_modules/meshcentral/db.js'
    }
];

/**
 * Resolve the on-disk path of a Mesh module from the plugin's process. Returns
 * null if the module can't be located — caller treats null as "patch missing".
 */
function resolveModulePath(moduleName) {
    try {
        return require.resolve(moduleName);
    } catch (_e) {
        return null;
    }
}

/**
 * Read each patch target and check for the expected marker. Returns an object
 * { ok: boolean, missing: Array<{name, hint, reason}>, present: string[] }.
 * The check never throws — anything we can't verify is reported as missing,
 * so a stale Mesh install doesn't silently boot in degraded mode.
 */
function verifyMeshPatches() {
    var missing = [];
    var present = [];
    for (var i = 0; i < REMORA_PATCHES.length; i++) {
        var patch = REMORA_PATCHES[i];
        var modulePath = resolveModulePath(patch.module);
        if (!modulePath) {
            missing.push({ name: patch.name, hint: patch.hint, reason: 'module-not-resolved' });
            continue;
        }
        try {
            var content = fs.readFileSync(modulePath, 'utf8');
            if (content.indexOf(patch.marker) !== -1) {
                present.push(patch.name);
            } else {
                missing.push({ name: patch.name, hint: patch.hint, reason: 'marker-missing', path: modulePath });
            }
        } catch (e) {
            missing.push({ name: patch.name, hint: patch.hint, reason: 'read-error: ' + (e && e.message), path: modulePath });
        }
    }
    return { ok: missing.length === 0, missing: missing, present: present };
}

module.exports.remoraCore = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;

    obj.exports = ['serveraction'];

    /**
     * On startup, verify that all RemoraHQ Mesh patches are still applied.
     * If any are missing (typical scenario: Mesh was upgraded and the patches
     * were not re-applied), dispatch a Critical event so the RemoraHQ Alerts
     * page shows it within ~30 seconds of server start.
     */
    obj.server_startup = function () {
        console.log('[remoraCore] v' + PLUGIN_VERSION + ' loaded.');
        var report = verifyMeshPatches();
        if (report.ok) {
            console.log('[remoraCore] Mesh patches verified: ' + report.present.join(', '));
            return;
        }
        var missingNames = report.missing.map(function (m) { return m.name; }).join(', ');
        var hints = report.missing.map(function (m) { return '  - ' + m.name + ': ' + m.hint; }).join('\n');
        console.warn('[remoraCore] Mesh patches MISSING: ' + missingNames + '\n' + hints);

        if (!obj.meshServer || typeof obj.meshServer.DispatchEvent !== 'function') {
            console.warn('[remoraCore] DispatchEvent unavailable — alert NOT published.');
            return;
        }
        try {
            obj.meshServer.DispatchEvent(['*', 'server-users'], obj, {
                etype: 'server',
                action: 'remora-mesh-patch-missing',
                msg: 'RemoraHQ Mesh patches missing: ' + missingNames + '. Re-apply patches from .meshcentral/modificate/patches/ and restart Mesh. See server log for fix hints.',
                msgArgs: report.missing,
                time: new Date().toISOString()
            });
        } catch (e) {
            console.warn('[remoraCore] DispatchEvent failed: ' + (e && e.message));
        }
    };

    /**
     * MeshCentral routes all `{action:'plugin', plugin:'<shortName>', ...}` WS
     * messages here. We dispatch on `command.pluginaction`.
     */
    obj.serveraction = function (command, dbGet, ws) {
        var session = dbGet || ws;
        if (!session || typeof session.send !== 'function') {
            return;
        }

        var pluginAction = String(command.pluginaction || '');
        var tag = command.tag;
        var responseid = command.responseid || tag;

        switch (pluginAction) {
            case 'ping': {
                session.send({
                    action: 'plugin',
                    plugin: PLUGIN_SHORT_NAME,
                    pluginaction: 'ping',
                    tag: tag,
                    responseid: responseid,
                    result: 'ok',
                    pong: true,
                    version: PLUGIN_VERSION,
                    server_time: new Date().toISOString()
                });
                return;
            }
            case 'verifyMeshPatches': {
                var report = verifyMeshPatches();
                session.send({
                    action: 'plugin',
                    plugin: PLUGIN_SHORT_NAME,
                    pluginaction: 'verifyMeshPatches',
                    tag: tag,
                    responseid: responseid,
                    result: 'ok',
                    report: report
                });
                return;
            }
            default: {
                session.send({
                    action: 'plugin',
                    plugin: PLUGIN_SHORT_NAME,
                    pluginaction: pluginAction || 'unknown',
                    tag: tag,
                    responseid: responseid,
                    result: 'error',
                    error: 'unknown_pluginaction'
                });
                return;
            }
        }
    };

    return obj;
};
