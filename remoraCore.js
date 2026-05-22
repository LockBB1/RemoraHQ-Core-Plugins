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
var PLUGIN_VERSION = '0.4.3';

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

function getDomainIds(meshServer) {
    var domains = meshServer && meshServer.config && meshServer.config.domains;
    if (!domains || typeof domains !== 'object') return [''];

    var domainIds = Object.keys(domains);
    if (domainIds.length === 0) return [''];
    return domainIds;
}

function dispatchMissingPatchAlert(obj, report, missingNames) {
    var domainIds = getDomainIds(obj.meshServer);
    for (var i = 0; i < domainIds.length; i++) {
        obj.meshServer.DispatchEvent(['*', 'server-users'], obj, {
            etype: 'server',
            action: 'remora-mesh-patch-missing',
            msg: 'RemoraHQ Mesh patches missing: ' + missingNames + '. Re-apply patches from .meshcentral/modificate/patches/ and restart Mesh. See server log for fix hints.',
            msgArgs: report.missing,
            domain: domainIds[i]
        });
    }
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
            dispatchMissingPatchAlert(obj, report, missingNames);
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
            case 'verifyOwnTotp': {
                // v0.4.0 (RC-13.4): re-verify the signed-in user's currently
                // enrolled TOTP code. Used as the second factor in the gate
                // before disable / regenerate / clear backup codes.
                // Reads the stored otpsecret from the user record and runs
                // otplib.authenticator.check — same logic Mesh uses in the
                // login flow (meshuser.js:3772).
                var sessionObj = dbGet;
                var token = typeof command.token === 'string' ? command.token : '';
                var failTotp = {
                    action: 'plugin',
                    plugin: PLUGIN_SHORT_NAME,
                    pluginaction: 'verifyOwnTotp',
                    tag: tag,
                    responseid: responseid,
                    result: 'ok',
                    valid: false
                };
                if (!/^\d{6}$/.test(token)) { session.send(failTotp); return; }
                var u = sessionObj && sessionObj.user;
                if (!u || typeof u.otpsecret !== 'string') { session.send(failTotp); return; }
                var otplib = null;
                try { otplib = require('otplib'); } catch (e) { otplib = null; }
                if (otplib == null) { session.send(failTotp); return; }
                try {
                    otplib.authenticator.options = { window: 2 };
                    var ok = otplib.authenticator.check(token, u.otpsecret) === true;
                    session.send({
                        action: 'plugin',
                        plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'verifyOwnTotp',
                        tag: tag,
                        responseid: responseid,
                        result: 'ok',
                        valid: ok
                    });
                } catch (e) {
                    session.send(failTotp);
                }
                return;
            }
            case 'verifyAccountPassword': {
                // v0.4.2 (RC-13.4.2): adds `pluginVersion` to every reply +
                // structured console logging so we can tell from one HAR
                // (a) which build of the plugin is actually loaded and
                // (b) why a re-auth attempt failed. Never logs the password.
                var sessionObj = dbGet;
                var webserver = ws;
                var password = typeof command.password === 'string' ? command.password : '';
                // Captured before we hand off to `authenticate` so the failure
                // reply can echo *what we tried* without leaking the password.
                var diag = { authMode: null, usernameLen: 0, usernameHasDot: false, usernameHasAt: false, domainId: null };
                function sendVerifyReply(valid, reason) {
                    session.send({
                        action: 'plugin',
                        plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'verifyAccountPassword',
                        tag: tag,
                        responseid: responseid,
                        result: 'ok',
                        valid: valid === true,
                        // Diagnostic-only fields (HAR + Mesh log). Safe to ship:
                        // never includes the password and only mirrors public
                        // identifiers / shape hints — no PII beyond what's
                        // already visible in the user's own session.
                        pluginVersion: PLUGIN_VERSION,
                        reason: reason,
                        diag: diag
                    });
                }
                if (!password) { sendVerifyReply(false, 'empty-password'); return; }
                if (!webserver) { sendVerifyReply(false, 'no-webserver'); return; }
                if (typeof webserver.authenticate !== 'function') { sendVerifyReply(false, 'no-authenticate-fn'); return; }
                var user = sessionObj && sessionObj.user;
                if (!user) { sendVerifyReply(false, 'no-session-user'); return; }
                var domainId = user.domain;
                var domain = null;
                try {
                    domain = webserver.parent && webserver.parent.config && webserver.parent.config.domains
                        ? webserver.parent.config.domains[domainId]
                        : null;
                } catch (e) { /* leave null */ }
                if (!domain) { sendVerifyReply(false, 'no-domain'); return; }
                try {
                    var username = user.name || (user._id ? user._id.split('/').pop() : '');
                    var authMode = (domain.auth || 'default');
                    diag.authMode = authMode;
                    diag.domainId = String(domainId);
                    diag.usernameLen = username ? username.length : 0;
                    diag.usernameHasDot = username.indexOf('.') >= 0;
                    diag.usernameHasAt = username.indexOf('@') >= 0;
                    console.log('[remoraCore] verifyAccountPassword: user=' + user._id + ', auth=' + authMode + ', username=' + username);
                    webserver.authenticate(username, password, domain, function (err, returnedUserid) {
                        if (err) {
                            var errStr = (typeof err === 'string') ? err : (err && err.message) || 'auth-error';
                            console.log('[remoraCore] verifyAccountPassword FAIL: ' + errStr);
                            sendVerifyReply(false, 'auth-error:' + errStr);
                            return;
                        }
                        if (typeof returnedUserid !== 'string') {
                            console.log('[remoraCore] verifyAccountPassword FAIL: no-userid (auth=' + authMode + ')');
                            sendVerifyReply(false, 'no-returned-userid');
                            return;
                        }
                        if (returnedUserid !== user._id) {
                            console.log('[remoraCore] verifyAccountPassword FAIL: id-mismatch session=' + user._id + ' returned=' + returnedUserid);
                            sendVerifyReply(false, 'id-mismatch');
                            return;
                        }
                        console.log('[remoraCore] verifyAccountPassword OK');
                        sendVerifyReply(true, 'ok');
                    });
                } catch (e) {
                    console.log('[remoraCore] verifyAccountPassword EXCEPTION: ' + (e && e.message));
                    sendVerifyReply(false, 'exception');
                }
                return;
            }
            case 'getMeshVersion': {
                // v0.3.0 (RC-13.2): expose `meshServer.currentVer` to the frontend
                // so the RemoraHQ version-gate banner can decide supported / unsupported
                // without requiring SITERIGHT_UPDATESRV (Mesh's native `serverversion`
                // action is admin-gated). All callers are read-only — no side effects.
                var meshVersion = null;
                try {
                    if (obj.meshServer && typeof obj.meshServer.currentVer === 'string') {
                        meshVersion = obj.meshServer.currentVer;
                    }
                } catch (e) { /* ignore — return null */ }
                session.send({
                    action: 'plugin',
                    plugin: PLUGIN_SHORT_NAME,
                    pluginaction: 'getMeshVersion',
                    tag: tag,
                    responseid: responseid,
                    result: 'ok',
                    version: meshVersion
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
