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
 */

'use strict';

var PLUGIN_SHORT_NAME = 'remoraCore';
var PLUGIN_VERSION = '0.1.1';

module.exports.remoraCore = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;

    obj.exports = ['serveraction'];

    obj.server_startup = function () {
        console.log('[remoraCore] v' + PLUGIN_VERSION + ' loaded.');
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
