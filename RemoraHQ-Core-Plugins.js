/**
 * RemoraHQ - Core MeshCentral plugin.
 *
 * MeshCentral loads this file via pluginHandler.js as:
 *     require('<pluginPath>/RemoraHQ-Core-Plugins/RemoraHQ-Core-Plugins.js')['RemoraHQ-Core-Plugins'](parent);
 *
 * The bracket-notation export is required because the shortName carries
 * hyphens (matching the upstream repo folder name).
 *
 * Wire protocol (RemoraHQ ↔ Mesh ↔ this plugin):
 *   client → server: { action:'plugin', plugin:'RemoraHQ-Core-Plugins',
 *                      pluginaction:'<verb>', tag:'<correlation>', responseid:'<correlation>',
 *                      ...payload }
 *   server → client: { action:'plugin', plugin:'RemoraHQ-Core-Plugins',
 *                      pluginaction:'<verb>', tag, responseid, result:'ok'|'error', ...data }
 *
 * The RemoraHQ MeshCentralTransport matches responses purely by `tag`/`responseid`,
 * so action/pluginaction echo is informational. We still echo both to keep traces
 * readable in DevTools.
 */

'use strict';

var PLUGIN_SHORT_NAME = 'RemoraHQ-Core-Plugins';
var PLUGIN_VERSION = '0.1.0';

module.exports[PLUGIN_SHORT_NAME] = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;

    obj.exports = ['serveraction'];

    obj.server_startup = function () {
        console.log('[RemoraHQ-Core-Plugins] v' + PLUGIN_VERSION + ' loaded.');
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
