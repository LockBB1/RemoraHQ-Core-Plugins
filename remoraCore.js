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
var PLUGIN_VERSION = '0.12.6';

// RC-13.17 — Mesh-native default for event TTL (.meshcentral/origin/meshcentral/db.js:51).
// Mirrored here so we can report a meaningful retention value when the admin
// has not set `dbexpire.events` in config.json.
var DEFAULT_EVENTS_EXPIRE_DAYS = 20;

// Cap on per-user notifications history. FIFO — oldest items are dropped on
// append. Mesh DB stores the whole array under a single doc so we keep it
// small enough to read/write cheaply on every change.
var NOTIFICATIONS_CAP = 100;

// v0.8.0 (RC-14.24). Cap on per-user client-error history. Frontend
// ErrorBoundary fires reportClientError on operator request; we FIFO-cap
// to keep the DB doc small while still preserving recent triage info.
var CLIENT_ERRORS_CAP = 50;

function clientErrorsDocId(userid) { return 'remoraClientErrors:' + userid; }

// v0.10.0 (RC-14.26). Per-user saved-filter cap. Each entry is small
// (name + scope + flat params record) so the cap is mostly to keep
// the dropdown UI usable rather than to bound DB size.
var SAVED_FILTERS_CAP = 30;

function savedFiltersDocId(userid) { return 'remoraSavedFilters:' + userid; }

// v0.12.0 (RC-14.29). RemoraHQ permission model — a thin RBAC layer ON TOP of
// Mesh siteadmin/per-mesh rights for RemoraHQ-specific capabilities Mesh has no
// notion of. A super-admin (siteadmin === full) grants individual flags to
// individual users. Stored in ONE site-wide doc (not per-user): grants is a map
// `{ <userid>: { <flag>: true } }`. Super-admins implicitly hold every flag and
// are never stored. The whitelist below is the authoritative flag set — the
// frontend mirror lives in src/lib/contracts/remoraPermissions.ts. First
// consumer: canUseSystemTerminal gates the SYSTEM terminal option (was an
// interim role check in TerminalToolbar). NOTE: this is UI-authority only for
// now; true server-enforce of the SYSTEM shell (meshcore) is slot 14.14.
//   v0.12.6 (RC-15.13) — second flag canRemoteInstall gates the Remote Install
//   (WAC-style push) feature. Server-enforced in remoraTerminalBridge.serveraction
//   (the privileged plugin that runs the WinRM push), mirroring the
//   canUseSystemTerminal enforce point. Registering it here makes it appear in
//   permissionsSelf / permissionsList / the Access Policy UI automatically.
var REMORA_PERMISSIONS_DOC_ID = 'remoraPermissions';
var REMORA_PERMISSION_FLAGS = ['canUseSystemTerminal', 'canRemoteInstall'];
function isSuperAdminUser(u) { return !!u && u.siteadmin === 0xFFFFFFFF; }

// v0.9.0 (RC-14.23). CSV cell escape — wraps in quotes and doubles inner
// quotes when the value contains a delimiter, quote or newline. Numbers
// and bools pass through as their string form, null/undefined → "".
function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = (typeof v === 'string') ? v : String(v);
    if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// RC-13.8.1 — msgid for "Signed in from new IP" notification, mirrors
// `REMORA_NOTIFICATION_LOGIN_NEW_IP` on the frontend side.
var NOTIFICATION_LOGIN_NEW_IP_MSGID = 9102;

// Cap on per-user stored login-IP set. Old entries are dropped FIFO when a
// fresh IP pushes the list over the limit, so a user who legitimately roams
// between many networks doesn't bloat their record indefinitely.
var LOGIN_IPS_CAP = 20;

// v0.12.3 (RC-14.8). Rate-limit for verifyAccountPassword. Without it an
// authenticated session can spam re-auth attempts → LDAP saturation + a
// timing oracle on the user's own password (pentest MED-1, CVSS 4.2). Keyed
// by user._id (the action only ever verifies the session user's OWN password,
// so per-user is the right granularity). In-memory only; resets on restart.
var VERIFY_PW_MAX = 5;
var VERIFY_PW_WINDOW_MS = 60000;
var verifyPwAttempts = {}; // userid -> { count, resetAt }

// Returns { allowed, retryAfterSec }. Counts the attempt when allowed.
function checkVerifyPwRateLimit(userid) {
    var now = Date.now();
    var e = verifyPwAttempts[userid];
    if (!e || now >= e.resetAt) {
        verifyPwAttempts[userid] = { count: 1, resetAt: now + VERIFY_PW_WINDOW_MS };
        return { allowed: true, retryAfterSec: 0 };
    }
    if (e.count >= VERIFY_PW_MAX) {
        return { allowed: false, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
    }
    e.count++;
    return { allowed: true, retryAfterSec: 0 };
}

function notificationsDocId(userId) {
    return 'remoraNotifications:' + String(userId);
}

function loginIpsDocId(userId) {
    return 'remoraLoginIps:' + String(userId);
}

function generateNotificationId() {
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Strip the `::ffff:` IPv4-in-IPv6 prefix that Node.js attaches to dual-stack
 * sockets. Mirrors meshuser.js::cleanRemoteAddr so the IP we persist matches
 * what Mesh displays elsewhere in the UI.
 */
function cleanRemoteAddr(addr) {
    if (typeof addr !== 'string') return '';
    if (addr.indexOf('::ffff:') === 0) return addr.substring(7);
    return addr;
}

/**
 * RC-13.8.1 — append a single notification straight to the DB doc.
 * Mirrors the `notificationsAppend` pluginaction handler but skips the WS
 * round-trip — useful from server-side hooks where there is no `session.send`.
 */
function appendNotificationDirect(obj, userId, msgid, kind, payload, cb) {
    var docId = notificationsDocId(userId);
    obj.meshServer.db.Get(docId, function (err, docs) {
        var items = [];
        if (!err && docs && docs.length > 0 && Array.isArray(docs[0].items)) {
            items = docs[0].items;
        }
        items.unshift({
            id: generateNotificationId(),
            msgid: msgid,
            kind: kind,
            ts: Date.now(),
            payload: payload || null,
            read: false
        });
        if (items.length > NOTIFICATIONS_CAP) items = items.slice(0, NOTIFICATIONS_CAP);
        obj.meshServer.db.Set({
            _id: docId,
            type: 'remoraNotifications',
            userid: userId,
            items: items
        }, function () { if (typeof cb === 'function') cb(null); });
    });
}

/**
 * Patches we expect to find present in the deployed Mesh install.
 * RETIRED 2026-06-02 (RC-15): webserver-spa-remorahq dropped — RemoraHQ now runs
 * behind nginx serving the SPA static from disk (try_files), so the Mesh SPA mount
 * is shadowed and no longer a dependency. Patch file kept for rollback. See
 * .documentation/RemoraHQ 2/INFRA/NGINX-SETUP.md.
 */
var REMORA_PATCHES = [
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
    },
    {
        name: 'meshuser-addplugin-allowlist',
        module: 'meshcentral/meshuser.js',
        marker: '// [REMORAHQ-PATCH meshuser-addplugin-allowlist v1.0.0 BEGIN]',
        hint: 'Re-run .meshcentral/modificate/patches/meshuser-addplugin-allowlist.ps1'
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
                missing.push({ name: patch.name, hint: patch.hint, reason: 'marker-missing' });
            }
        } catch (e) {
            // v0.12.2 (RC-14.7): never expose the resolved filesystem path in the
            // response/alert — it leaks server FS structure to any viewer. Report
            // only the error code (ENOENT/EACCES/...), no path, no raw message.
            missing.push({ name: patch.name, hint: patch.hint, reason: 'read-error: ' + (e && e.code ? e.code : 'unknown') });
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
     * RC-13.8.1 — fires on every successful WebSocket login (meshuser.js:688).
     * We pull the user's source IP from the freshly-registered ws session,
     * compare with the stored set in `remoraLoginIps:<userid>`, and append a
     * notification if this IP is new. The very first login for a user
     * (no doc yet) is treated as initial registration — silent.
     */
    obj.hook_userLoggedIn = function (user) {
        try {
            if (!user || typeof user._id !== 'string') return;
            if (!obj.meshServer || !obj.meshServer.webserver || !obj.meshServer.db) return;
            var sessions = obj.meshServer.webserver.wssessions
                ? obj.meshServer.webserver.wssessions[user._id]
                : null;
            if (!Array.isArray(sessions) || sessions.length === 0) return;
            // Last entry is the ws that just connected (meshuser.js:407 pushes
            // before the callHook). `ws.clientIp` is stamped at line 399.
            var freshWs = sessions[sessions.length - 1];
            var ip = cleanRemoteAddr(freshWs && freshWs.clientIp);
            if (!ip) return;

            var docId = loginIpsDocId(user._id);
            obj.meshServer.db.Get(docId, function (err, docs) {
                var existing = (!err && docs && docs.length > 0 && Array.isArray(docs[0].ips))
                    ? docs[0].ips : null;
                var isFirstEver = existing === null;
                var ips = existing || [];
                var alreadyKnown = ips.indexOf(ip) >= 0;
                if (alreadyKnown) {
                    // Touch lastSeenAt only — no notification, no list mutation.
                    obj.meshServer.db.Set({
                        _id: docId, type: 'remoraLoginIps', userid: user._id,
                        ips: ips, lastIp: ip, lastSeenAt: Date.now()
                    }, function () {});
                    return;
                }
                // Append IP. Trim FIFO if we exceed the cap.
                ips.push(ip);
                if (ips.length > LOGIN_IPS_CAP) ips = ips.slice(ips.length - LOGIN_IPS_CAP);
                obj.meshServer.db.Set({
                    _id: docId, type: 'remoraLoginIps', userid: user._id,
                    ips: ips, lastIp: ip, lastSeenAt: Date.now()
                }, function () {
                    // First-ever login for this user — silent registration so
                    // existing accounts don't get a "new IP" notification on
                    // their very next login after plugin install.
                    if (isFirstEver) return;
                    appendNotificationDirect(
                        obj, user._id,
                        NOTIFICATION_LOGIN_NEW_IP_MSGID, 'login',
                        { ip: ip }
                    );
                });
            });
        } catch (e) {
            console.warn('[remoraCore] hook_userLoggedIn failed: ' + (e && e.message));
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
                // v0.12.3 (RC-14.8): dropped authMode/domainId from the reply —
                // they exposed the domain's auth backend + id to the client.
                // Kept server-side only (console.log below). The remaining
                // fields are username shape-hints, no PII beyond the caller's
                // own session.
                var diag = { usernameLen: 0, usernameHasDot: false, usernameHasAt: false, usernameSource: null };
                function sendVerifyReply(valid, reason, extra) {
                    var reply = {
                        action: 'plugin',
                        plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'verifyAccountPassword',
                        tag: tag,
                        responseid: responseid,
                        result: 'ok',
                        valid: valid === true,
                        pluginVersion: PLUGIN_VERSION,
                        reason: reason,
                        diag: diag
                    };
                    if (extra && typeof extra === 'object') {
                        for (var k in extra) { if (extra.hasOwnProperty(k)) reply[k] = extra[k]; }
                    }
                    session.send(reply);
                }
                if (!password) { sendVerifyReply(false, 'empty-password'); return; }
                if (!webserver) { sendVerifyReply(false, 'no-webserver'); return; }
                if (typeof webserver.authenticate !== 'function') { sendVerifyReply(false, 'no-authenticate-fn'); return; }
                var user = sessionObj && sessionObj.user;
                if (!user) { sendVerifyReply(false, 'no-session-user'); return; }
                // RC-14.8 rate-limit: 5 attempts / 60s per user. Checked before
                // the (expensive) LDAP bind to blunt brute-force + LDAP saturation.
                var rl = checkVerifyPwRateLimit(user._id);
                if (!rl.allowed) {
                    console.log('[remoraCore] verifyAccountPassword RATE-LIMITED: ' + user._id + ' retryAfter=' + rl.retryAfterSec + 's');
                    sendVerifyReply(false, 'rate-limited', { retryAfterSec: rl.retryAfterSec });
                    return;
                }
                var domainId = user.domain;
                var domain = null;
                try {
                    domain = webserver.parent && webserver.parent.config && webserver.parent.config.domains
                        ? webserver.parent.config.domains[domainId]
                        : null;
                } catch (e) { /* leave null */ }
                if (!domain) { sendVerifyReply(false, 'no-domain'); return; }
                try {
                    // v0.4.5 (RC-13.4.4): derive the LDAP bind handle from
                    // `user.email`. Rationale: LDAP-only Mesh deployments
                    // store user records keyed by opaque SID hex, so neither
                    // `user._id`'s shortname nor `user.name` (= display name
                    // from LDAP) is a valid bind handle. But the email
                    // address is mirrored from AD where the local-part is
                    // identical to sAMAccountName (corporate convention).
                    // Fallbacks (in order):
                    //   1) `user.email.split('@')[0]`   — primary path.
                    //   2) `user._id.split('/').pop()`  — legacy local accounts.
                    //   3) `user.name`                  — last-ditch.
                    var username = '';
                    var usernameSource = 'none';
                    if (typeof user.email === 'string' && user.email.indexOf('@') > 0) {
                        username = user.email.split('@')[0];
                        usernameSource = 'email-localpart';
                    } else if (user._id && user._id.indexOf('/') >= 0) {
                        username = user._id.split('/').pop();
                        usernameSource = 'id-shortname';
                    } else if (typeof user.name === 'string' && user.name) {
                        username = user.name;
                        usernameSource = 'user.name';
                    }
                    var authMode = (domain.auth || 'default'); // server-side log only
                    diag.usernameLen = username.length;
                    diag.usernameHasDot = username.indexOf('.') >= 0;
                    diag.usernameHasAt = username.indexOf('@') >= 0;
                    diag.usernameSource = usernameSource;
                    if (!username) { sendVerifyReply(false, 'no-username-source'); return; }
                    console.log('[remoraCore] verifyAccountPassword: sessionUser=' + user._id + ', auth=' + authMode + ', usernameSource=' + usernameSource + ', usernameLen=' + username.length);
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
            case 'auditRetentionInfo': {
                // v0.7.0 (RC-13.17, P.8). Surfaces Mesh's `dbexpire.events`
                // retention policy so the RemoraHQ /audit page can warn the
                // admin when events older than N days are auto-purged.
                // Read-only, site-admin only — non-admin silently gets a
                // permission-denied reply so the banner can hide itself.
                var sessionObj2 = dbGet;
                var adminU = sessionObj2 && sessionObj2.user;
                if (!adminU || adminU.siteadmin !== 0xFFFFFFFF) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'auditRetentionInfo',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'forbidden'
                    });
                    return;
                }
                var args = (obj.meshServer && obj.meshServer.args) || {};
                var dbexpire = args.dbexpire || {};
                var rawEvents = (typeof dbexpire.events === 'number') ? dbexpire.events : null;
                var rawPower = (typeof dbexpire.powerevents === 'number') ? dbexpire.powerevents : null;
                var eventsExpireDays = (rawEvents != null) ? (rawEvents / 86400) : DEFAULT_EVENTS_EXPIRE_DAYS;
                var powerExpireDays = (rawPower != null) ? (rawPower / 86400) : 10;
                var dbType = 'unknown';
                try {
                    if (obj.meshServer && obj.meshServer.db && typeof obj.meshServer.db.databaseType === 'number') {
                        // 1=NeDB, 2=MongoDB, 3=MongoJS, 4=SQLite, 5=MariaDB, 6=PostgreSQL, 7=AceBase, 8=MySQL
                        var typeMap = { 1: 'nedb', 2: 'mongo', 3: 'mongojs', 4: 'sqlite', 5: 'mariadb', 6: 'postgres', 7: 'acebase', 8: 'mysql' };
                        dbType = typeMap[obj.meshServer.db.databaseType] || 'unknown';
                    }
                } catch (e) { /* ignore */ }
                session.send({
                    action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                    pluginaction: 'auditRetentionInfo',
                    tag: tag, responseid: responseid,
                    result: 'ok',
                    eventsExpireDays: eventsExpireDays,
                    powerExpireDays: powerExpireDays,
                    configuredExplicitly: (rawEvents != null),
                    dbType: dbType
                });
                return;
            }
            case 'savedFiltersList': {
                // v0.10.0 (RC-14.26). Per-user named filter snapshots for
                // /audit and /agents. Keyed by user._id so any signed-in
                // user gets their own list with no extra privilege check.
                var sfListCtx = dbGet;
                var sfListUser = sfListCtx && sfListCtx.user;
                if (!sfListUser || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersList',
                        tag: tag, responseid: responseid,
                        result: 'ok', items: []
                    });
                    return;
                }
                obj.meshServer.db.Get(savedFiltersDocId(sfListUser._id), function (err, docs) {
                    var items = [];
                    if (!err && docs && docs.length > 0 && Array.isArray(docs[0].items)) {
                        items = docs[0].items;
                    }
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersList',
                        tag: tag, responseid: responseid,
                        result: 'ok', items: items
                    });
                });
                return;
            }
            case 'savedFiltersSave': {
                var sfSaveCtx = dbGet;
                var sfSaveUser = sfSaveCtx && sfSaveCtx.user;
                if (!sfSaveUser || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersSave',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'no-session'
                    });
                    return;
                }
                var rawScope = String(command.scope || '');
                var rawName = String(command.name || '').trim();
                var rawParams = (command.params && typeof command.params === 'object') ? command.params : {};
                if (rawScope !== 'audit' && rawScope !== 'agents') {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersSave',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'invalid-scope'
                    });
                    return;
                }
                if (rawName.length === 0 || rawName.length > 80) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersSave',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'invalid-name'
                    });
                    return;
                }
                var sfDocId = savedFiltersDocId(sfSaveUser._id);
                obj.meshServer.db.Get(sfDocId, function (gerr, gdocs) {
                    var items = [];
                    if (!gerr && gdocs && gdocs.length > 0 && Array.isArray(gdocs[0].items)) {
                        items = gdocs[0].items;
                    }
                    // Flatten params to string-only key/value pairs — saved
                    // filters live in the URL / local-state world, no
                    // structured payloads.
                    var sanitized = {};
                    var paramKeys = Object.keys(rawParams);
                    for (var pk = 0; pk < paramKeys.length && pk < 40; pk++) {
                        var k = paramKeys[pk];
                        if (typeof k !== 'string' || k.length === 0 || k.length > 64) continue;
                        var v = rawParams[k];
                        if (v === null || v === undefined) continue;
                        sanitized[k] = (typeof v === 'string') ? v.slice(0, 256) : String(v).slice(0, 256);
                    }
                    var item = {
                        id: 'sf_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
                        scope: rawScope,
                        name: rawName.slice(0, 80),
                        params: sanitized,
                        createdAt: Date.now()
                    };
                    items.push(item);
                    if (items.length > SAVED_FILTERS_CAP) items = items.slice(-SAVED_FILTERS_CAP);
                    var sfDoc = (gdocs && gdocs.length > 0) ? gdocs[0] : { _id: sfDocId, type: 'remoraSavedFilters', userid: sfSaveUser._id };
                    sfDoc.items = items;
                    obj.meshServer.db.Set(sfDoc, function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'savedFiltersSave',
                            tag: tag, responseid: responseid,
                            result: 'ok', item: item, total: items.length
                        });
                    });
                });
                return;
            }
            case 'savedFiltersDelete': {
                var sfDelCtx = dbGet;
                var sfDelUser = sfDelCtx && sfDelCtx.user;
                if (!sfDelUser || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersDelete',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'no-session'
                    });
                    return;
                }
                var delId = String(command.id || '');
                if (!delId) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersDelete',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'invalid-id'
                    });
                    return;
                }
                var delDocId = savedFiltersDocId(sfDelUser._id);
                obj.meshServer.db.Get(delDocId, function (gerr, gdocs) {
                    if (gerr || !gdocs || gdocs.length === 0 || !Array.isArray(gdocs[0].items)) {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'savedFiltersDelete',
                            tag: tag, responseid: responseid,
                            result: 'ok', items: [], total: 0
                        });
                        return;
                    }
                    var keep = [];
                    for (var di = 0; di < gdocs[0].items.length; di++) {
                        if (gdocs[0].items[di].id !== delId) keep.push(gdocs[0].items[di]);
                    }
                    gdocs[0].items = keep;
                    obj.meshServer.db.Set(gdocs[0], function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'savedFiltersDelete',
                            tag: tag, responseid: responseid,
                            result: 'ok', items: keep, total: keep.length
                        });
                    });
                });
                return;
            }
            case 'savedFiltersRename': {
                var sfRenCtx = dbGet;
                var sfRenUser = sfRenCtx && sfRenCtx.user;
                if (!sfRenUser || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersRename',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'no-session'
                    });
                    return;
                }
                var renId = String(command.id || '');
                var renName = String(command.name || '').trim();
                if (!renId || renName.length === 0 || renName.length > 80) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'savedFiltersRename',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'invalid-input'
                    });
                    return;
                }
                var renDocId = savedFiltersDocId(sfRenUser._id);
                obj.meshServer.db.Get(renDocId, function (gerr, gdocs) {
                    if (gerr || !gdocs || gdocs.length === 0 || !Array.isArray(gdocs[0].items)) {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'savedFiltersRename',
                            tag: tag, responseid: responseid,
                            result: 'error', error: 'not-found'
                        });
                        return;
                    }
                    var renItem = null;
                    for (var ri = 0; ri < gdocs[0].items.length; ri++) {
                        if (gdocs[0].items[ri].id === renId) {
                            gdocs[0].items[ri].name = renName.slice(0, 80);
                            renItem = gdocs[0].items[ri];
                            break;
                        }
                    }
                    if (!renItem) {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'savedFiltersRename',
                            tag: tag, responseid: responseid,
                            result: 'error', error: 'not-found'
                        });
                        return;
                    }
                    obj.meshServer.db.Set(gdocs[0], function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'savedFiltersRename',
                            tag: tag, responseid: responseid,
                            result: 'ok', item: renItem
                        });
                    });
                });
                return;
            }
            case 'auditExport': {
                // v0.9.0 (RC-14.23). Site-admin-only audit export. Streams the
                // Mesh native `events` collection in CSV or JSONL between
                // `from` and `to` ISO timestamps. Single-shot reply by design
                // — pre-beta volumes fit in memory; if real deployments hit
                // the WS frame limit we'll split into chunk-stream in 14.23.1.
                var auditAdminCtx = dbGet;
                var auditAdmin = auditAdminCtx && auditAdminCtx.user;
                if (!auditAdmin || auditAdmin.siteadmin !== 0xFFFFFFFF) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'auditExport',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'forbidden'
                    });
                    return;
                }
                var fromMs = Date.parse(String(command.from || ''));
                var toMs = Date.parse(String(command.to || ''));
                if (!isFinite(fromMs) || !isFinite(toMs) || toMs < fromMs) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'auditExport',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'invalid-range'
                    });
                    return;
                }
                var format = (command.format === 'csv') ? 'csv' : 'jsonl';
                var domain = (auditAdmin.domain || '') + '';
                var fromDate = new Date(fromMs);
                var toDate = new Date(toMs);
                try {
                    // v0.9.1 — upstream `GetEventsTimeRange` requires a non-null
                    // msgid filter array (`msgid: { $in: msgids }`), which makes
                    // the "all events" use case impossible on NeDB / MongoDB /
                    // MongoJS backends. SQL backends special-case `ids === '*'`
                    // and ignore msgids, but those are the minority. Go direct
                    // to `eventsfile` and run the time-range query ourselves.
                    var db = obj.meshServer.db;
                    var dbType = (db && typeof db.databaseType === 'number') ? db.databaseType : 0;
                    var query = { domain: domain, time: { $gte: fromDate, $lte: toDate } };
                    var onDocs = function (err, docs) {
                        if (err || !Array.isArray(docs)) {
                            session.send({
                                action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                                pluginaction: 'auditExport',
                                tag: tag, responseid: responseid,
                                result: 'error', error: 'db-error:' + (err && err.message ? err.message : 'no-docs')
                            });
                            return;
                        }
                        var text;
                        if (format === 'csv') {
                            var rows = ['time,action,userid,nodeid,msgid,ip,msg'];
                            for (var i = 0; i < docs.length; i++) {
                                var d = docs[i] || {};
                                rows.push([
                                    csvCell(d.time ? new Date(d.time).toISOString() : ''),
                                    csvCell(d.action),
                                    csvCell(d.userid),
                                    csvCell(d.nodeid),
                                    csvCell(d.msgid),
                                    csvCell(d.ip),
                                    csvCell(d.msg)
                                ].join(','));
                            }
                            text = rows.join('\n') + '\n';
                        } else {
                            var lines = [];
                            for (var j = 0; j < docs.length; j++) {
                                try { lines.push(JSON.stringify(docs[j])); } catch (e) { /* skip cycles */ }
                            }
                            text = lines.join('\n') + '\n';
                        }
                        var fnameFrom = fromDate.toISOString().slice(0, 10);
                        var fnameTo = toDate.toISOString().slice(0, 10);
                        var filename = 'audit-' + fnameFrom + '_' + fnameTo + '.' + (format === 'csv' ? 'csv' : 'jsonl');
                        // Audit the export itself so a compromised admin can't
                        // silently exfiltrate the journal — the action lands
                        // in the same Mesh events stream we just emitted.
                        try {
                            if (obj.meshServer && obj.meshServer.DispatchEvent) {
                                obj.meshServer.DispatchEvent(['*'], obj, {
                                    etype: 'system',
                                    action: 'remora-audit-export',
                                    userid: auditAdmin._id,
                                    domain: domain,
                                    msgid: 9201,
                                    msgArgs: [filename, docs.length],
                                    msg: 'Audit export: ' + filename + ' (' + docs.length + ' events)',
                                    nolog: 0
                                });
                            }
                        } catch (e) { /* never fail the export on audit-emit */ }
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'auditExport',
                            tag: tag, responseid: responseid,
                            result: 'ok',
                            count: docs.length,
                            format: format,
                            filename: filename,
                            text: text
                        });
                    };
                    // Backend-specific query path. NeDB (1) + MongoJS (2) +
                    // MongoDB (3) all share a `find(query).sort().exec/toArray`
                    // shape but differ in cursor terminator. SQL backends
                    // (4-6, 8) fall back to GetEventsTimeRange's SQL path —
                    // that one IS special-cased on `ids = ['*']` upstream.
                    if (dbType === 1 || dbType === 2) {
                        // NeDB / MongoJS
                        db.eventsfile.find(query).sort({ time: 1 }).exec(onDocs);
                    } else if (dbType === 3) {
                        // MongoDB native driver
                        db.eventsfile.find(query).sort({ time: 1 }).toArray(onDocs);
                    } else if (dbType === 4 || dbType === 5 || dbType === 6 || dbType === 8) {
                        // SQL backends: native helper works (ids='*' shortcut).
                        db.GetEventsTimeRange(['*'], domain, null, fromDate, toDate, onDocs);
                    } else {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'auditExport',
                            tag: tag, responseid: responseid,
                            result: 'error', error: 'unsupported-db-type:' + dbType
                        });
                    }
                } catch (e) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'auditExport',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'exception:' + (e && e.message ? e.message : String(e))
                    });
                }
                return;
            }
            case 'reportClientError': {
                // v0.8.0 (RC-14.24). Frontend ErrorBoundary posts a captured
                // render-time error here. Any signed-in user may call so the
                // server keeps a per-user FIFO list under
                // `remoraClientErrors:<userid>`, capped at CLIENT_ERRORS_CAP.
                // No PII is stripped at this layer — operators submit their
                // own errors and the doc is keyed by their own userid.
                var sessionUser = dbGet;
                var reportingUser = sessionUser && sessionUser.user;
                if (!reportingUser || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'reportClientError',
                        tag: tag, responseid: responseid,
                        result: 'ok', stored: false
                    });
                    return;
                }
                var docId = clientErrorsDocId(reportingUser._id);
                obj.meshServer.db.Get(docId, function (gerr, gdocs) {
                    var items = [];
                    if (!gerr && gdocs && gdocs.length > 0 && Array.isArray(gdocs[0].items)) {
                        items = gdocs[0].items;
                    }
                    items.push({
                        at: Date.now(),
                        userid: reportingUser._id,
                        message: typeof command.message === 'string' ? command.message.slice(0, 4000) : '',
                        stack: typeof command.stack === 'string' ? command.stack.slice(0, 8000) : '',
                        componentStack: typeof command.componentStack === 'string' ? command.componentStack.slice(0, 8000) : '',
                        version: typeof command.version === 'string' ? command.version.slice(0, 64) : '',
                        buildNumber: typeof command.buildNumber === 'number' ? command.buildNumber : 0,
                        userAgent: typeof command.userAgent === 'string' ? command.userAgent.slice(0, 512) : '',
                        href: typeof command.href === 'string' ? command.href.slice(0, 512) : ''
                    });
                    if (items.length > CLIENT_ERRORS_CAP) items = items.slice(-CLIENT_ERRORS_CAP);
                    var doc = (gdocs && gdocs.length > 0) ? gdocs[0] : { _id: docId, type: 'remoraClientErrors', userid: reportingUser._id };
                    doc.items = items;
                    obj.meshServer.db.Set(doc, function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'reportClientError',
                            tag: tag, responseid: responseid,
                            result: 'ok', stored: true
                        });
                    });
                });
                return;
            }
            case 'notificationsList': {
                // v0.5.0 (RC-13.7.3). Returns the persistent notifications
                // history for the signed-in user. Storage: a single doc in
                // the main Mesh DB collection keyed by `remoraNotifications:<userid>`.
                // The same KV API is used by Mesh itself for every doc type,
                // so no extra DB infrastructure is required.
                var sessionObj = dbGet;
                var u = sessionObj && sessionObj.user;
                if (!u || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'notificationsList',
                        tag: tag, responseid: responseid,
                        result: 'ok', items: []
                    });
                    return;
                }
                obj.meshServer.db.Get(notificationsDocId(u._id), function (err, docs) {
                    var items = [];
                    if (!err && docs && docs.length > 0 && Array.isArray(docs[0].items)) {
                        items = docs[0].items;
                    }
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'notificationsList',
                        tag: tag, responseid: responseid,
                        result: 'ok', items: items
                    });
                });
                return;
            }
            case 'notificationsAppend': {
                // v0.5.0. Adds a new notification at the head of the list
                // and trims to NOTIFICATIONS_CAP. Server stamps `ts` and
                // generates `id` — client supplies `msgid`, `kind`, and
                // optional `payload`. msgid is the Mesh i18n key (numeric);
                // kind is a free-form category string ('security', 'login',
                // 'system') the client uses for icon/severity routing.
                var sessionObj = dbGet;
                var u = sessionObj && sessionObj.user;
                if (!u || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'notificationsAppend',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'no-session-or-db'
                    });
                    return;
                }
                var item = {
                    id: generateNotificationId(),
                    msgid: (typeof command.msgid === 'number') ? command.msgid : 0,
                    kind: (typeof command.kind === 'string' && command.kind) ? command.kind : 'security',
                    ts: Date.now(),
                    payload: (command.payload && typeof command.payload === 'object') ? command.payload : null,
                    read: false
                };
                var docId = notificationsDocId(u._id);
                obj.meshServer.db.Get(docId, function (err, docs) {
                    var items = [];
                    if (!err && docs && docs.length > 0 && Array.isArray(docs[0].items)) {
                        items = docs[0].items;
                    }
                    items.unshift(item);
                    if (items.length > NOTIFICATIONS_CAP) items = items.slice(0, NOTIFICATIONS_CAP);
                    obj.meshServer.db.Set({
                        _id: docId,
                        type: 'remoraNotifications',
                        userid: u._id,
                        items: items
                    }, function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'notificationsAppend',
                            tag: tag, responseid: responseid,
                            result: 'ok', item: item, total: items.length
                        });
                    });
                });
                return;
            }
            case 'notificationsMarkRead': {
                // v0.5.0. Flips `read:true` on the given ids — or on every
                // item when `ids === 'all'`. Idempotent. Returns the updated
                // items so the caller can avoid a follow-up list call.
                var sessionObj = dbGet;
                var u = sessionObj && sessionObj.user;
                if (!u || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'notificationsMarkRead',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'no-session-or-db'
                    });
                    return;
                }
                var rawIds = command.ids;
                var markAll = (rawIds === 'all' || rawIds === '*');
                var idSet = {};
                if (Array.isArray(rawIds)) {
                    for (var k = 0; k < rawIds.length; k++) idSet[String(rawIds[k])] = true;
                }
                var docId2 = notificationsDocId(u._id);
                obj.meshServer.db.Get(docId2, function (err, docs) {
                    var items = [];
                    if (!err && docs && docs.length > 0 && Array.isArray(docs[0].items)) {
                        items = docs[0].items;
                    }
                    for (var j = 0; j < items.length; j++) {
                        if (markAll || idSet[String(items[j].id)]) items[j].read = true;
                    }
                    obj.meshServer.db.Set({
                        _id: docId2,
                        type: 'remoraNotifications',
                        userid: u._id,
                        items: items
                    }, function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'notificationsMarkRead',
                            tag: tag, responseid: responseid,
                            result: 'ok', items: items
                        });
                    });
                });
                return;
            }
            case 'healthSummary': {
                // v0.11.0 (RC-14.25). Site-admin-only aggregate for the Health
                // Dashboard. Server-computed metrics the frontend cannot derive
                // on its own: live WS session count, event volume buckets, the
                // failed-login count, and the cross-user client-error count.
                // Everything else on the dashboard (agents online/total, pending
                // plugin updates, unread notifications) the client already has.
                var hsCtx = dbGet;
                var hsAdmin = hsCtx && hsCtx.user;
                if (!hsAdmin || hsAdmin.siteadmin !== 0xFFFFFFFF) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'healthSummary',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'forbidden'
                    });
                    return;
                }
                var now = Date.now();
                var ms24h = 24 * 60 * 60 * 1000;
                var ms7d = 7 * ms24h;
                var ms30d = 30 * ms24h;

                // Live WS sessions. wssessions maps userId -> array of sockets.
                var activeSessions = 0;
                var activeUsers = 0;
                try {
                    var wss = obj.meshServer && obj.meshServer.webserver
                        ? obj.meshServer.webserver.wssessions : null;
                    if (wss && typeof wss === 'object') {
                        var keys = Object.keys(wss);
                        activeUsers = keys.length;
                        for (var k = 0; k < keys.length; k++) {
                            var arr = wss[keys[k]];
                            if (Array.isArray(arr)) activeSessions += arr.length;
                        }
                    }
                } catch (e) { /* leave zeros */ }

                var hsDomain = (hsAdmin.domain || '') + '';

                // Step 2: count client errors in the last 24h across all users.
                var finishHealth = function (events, failedLogins24h) {
                    var clientErrors24h = 0;
                    var sendHealth = function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'healthSummary',
                            tag: tag, responseid: responseid,
                            result: 'ok',
                            activeSessions: activeSessions,
                            activeUsers: activeUsers,
                            events: events,
                            failedLogins24h: failedLogins24h,
                            clientErrors24h: clientErrors24h,
                            serverTime: new Date().toISOString()
                        });
                    };
                    try {
                        obj.meshServer.db.GetAllType('remoraClientErrors', function (cerr, cdocs) {
                            if (!cerr && Array.isArray(cdocs)) {
                                for (var ci = 0; ci < cdocs.length; ci++) {
                                    var citems = cdocs[ci] && cdocs[ci].items;
                                    if (!Array.isArray(citems)) continue;
                                    for (var cj = 0; cj < citems.length; cj++) {
                                        var at = citems[cj] && citems[cj].at;
                                        if (typeof at === 'number' && (now - at) <= ms24h) clientErrors24h++;
                                    }
                                }
                            }
                            sendHealth();
                        });
                    } catch (e) { sendHealth(); }
                };

                // Step 1: one event scan over the last 30 days, bucketed locally.
                try {
                    var db = obj.meshServer.db;
                    var dbType = (db && typeof db.databaseType === 'number') ? db.databaseType : 0;
                    var fromDate = new Date(now - ms30d);
                    var query = { domain: hsDomain, time: { $gte: fromDate } };
                    var onEvents = function (err, docs) {
                        var events = { h24: 0, d7: 0, d30: 0 };
                        var failed = 0;
                        if (!err && Array.isArray(docs)) {
                            // Peer-replication dedup. In a multi-server peered
                            // cluster (mongoDbChangeStream) every peer re-stores
                            // each forwarded event, so an N-peer cluster writes
                            // N rows per real event. We collapse them with the
                            // SAME fingerprint the frontend Audit page uses
                            // (lib/transport/mappers/event.ts::dedupMeshEvents):
                            // (action, msgid, msgArgs[0]) with a 5s-bucket +
                            // userid + nodeid fallback when msgArgs is empty —
                            // so the dashboard counts match the Audit list.
                            var seen = Object.create(null);
                            for (var i = 0; i < docs.length; i++) {
                                var d = docs[i] || {};
                                var tms = d.time ? new Date(d.time).getTime() : 0;
                                if (!isFinite(tms) || tms === 0) continue;
                                var margs = Array.isArray(d.msgArgs) ? d.msgArgs : [];
                                var primary = margs.length > 0 ? String(margs[0] == null ? '' : margs[0]) : '';
                                // 5s time bucket is mandatory: for login/authfail
                                // msgArgs[0] is the client IP (not unique), so two
                                // genuine same-IP events must stay distinct while
                                // the near-simultaneous peer replicas collapse.
                                var bucket = Math.floor(tms / 5000);
                                var fp;
                                if (primary) {
                                    fp = (d.action || '') + '|' + (d.msgid == null ? '' : d.msgid) + '|' + primary + '|t' + bucket;
                                } else {
                                    fp = (d.action || '') + '|' + (d.msgid == null ? '' : d.msgid) + '|t' + bucket + '|' + (d.userid || '') + '|' + (d.nodeid || '');
                                }
                                if (seen[fp]) continue;
                                seen[fp] = true;
                                var age = now - tms;
                                if (age <= ms30d) events.d30++;
                                if (age <= ms7d) events.d7++;
                                if (age <= ms24h) {
                                    events.h24++;
                                    if (d.action === 'authfail') failed++;
                                }
                            }
                        }
                        finishHealth(events, failed);
                    };
                    if (dbType === 1 || dbType === 2) {
                        db.eventsfile.find(query).exec(onEvents);
                    } else if (dbType === 3) {
                        db.eventsfile.find(query).toArray(onEvents);
                    } else if (dbType === 4 || dbType === 5 || dbType === 6 || dbType === 8) {
                        db.GetEventsTimeRange(['*'], hsDomain, null, fromDate, new Date(now), onEvents);
                    } else {
                        finishHealth({ h24: 0, d7: 0, d30: 0 }, 0);
                    }
                } catch (e) {
                    finishHealth({ h24: 0, d7: 0, d30: 0 }, 0);
                }
                return;
            }
            case 'permissionsSelf': {
                // v0.12.0 (RC-14.29). Any signed-in user fetches their OWN
                // effective RemoraHQ flags — the UI gates on these (default
                // deny while loading). Super-admins get every flag true without
                // a DB read.
                var psUser = dbGet && dbGet.user;
                if (!psUser || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'permissionsSelf',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'no-session'
                    });
                    return;
                }
                var sendSelf = function (flags) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'permissionsSelf',
                        tag: tag, responseid: responseid,
                        result: 'ok', flags: flags
                    });
                };
                if (isSuperAdminUser(psUser)) {
                    var allFlags = {};
                    for (var sfI = 0; sfI < REMORA_PERMISSION_FLAGS.length; sfI++) allFlags[REMORA_PERMISSION_FLAGS[sfI]] = true;
                    sendSelf(allFlags);
                    return;
                }
                obj.meshServer.db.Get(REMORA_PERMISSIONS_DOC_ID, function (err, docs) {
                    var grants = (!err && docs && docs.length > 0 && docs[0].grants && typeof docs[0].grants === 'object') ? docs[0].grants : {};
                    var mine = grants[psUser._id] || {};
                    var flags = {};
                    for (var fi = 0; fi < REMORA_PERMISSION_FLAGS.length; fi++) {
                        var fname = REMORA_PERMISSION_FLAGS[fi];
                        flags[fname] = mine[fname] === true;
                    }
                    sendSelf(flags);
                });
                return;
            }
            case 'permissionsList': {
                // v0.12.0 (RC-14.29). Super-admin-only: the full grants map for
                // the management UI. Frontend joins it with the Mesh user list.
                var plUser = dbGet && dbGet.user;
                if (!isSuperAdminUser(plUser) || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'permissionsList',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'forbidden'
                    });
                    return;
                }
                obj.meshServer.db.Get(REMORA_PERMISSIONS_DOC_ID, function (err, docs) {
                    var grants = (!err && docs && docs.length > 0 && docs[0].grants && typeof docs[0].grants === 'object') ? docs[0].grants : {};
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'permissionsList',
                        tag: tag, responseid: responseid,
                        result: 'ok', flags: REMORA_PERMISSION_FLAGS, grants: grants
                    });
                });
                return;
            }
            case 'permissionsSetFlag': {
                // v0.12.0 (RC-14.29). Super-admin-only: grant/revoke one
                // whitelisted flag for one user. Returns the updated full map.
                var psfUser = dbGet && dbGet.user;
                if (!isSuperAdminUser(psfUser) || !obj.meshServer || !obj.meshServer.db) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'permissionsSetFlag',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'forbidden'
                    });
                    return;
                }
                // NOTE: the wire field is `targetUser`, NOT `userid` — Mesh's
                // command router overwrites `command.userid` with the REQUESTING
                // user's _id before serveraction runs, so a `userid` payload
                // would always resolve to the caller (super-admin), never the
                // target. (HAR-confirmed, RC-14.29.2.)
                var targetUserid = String(command.targetUser || '');
                var targetFlag = String(command.flag || '');
                var targetValue = command.value === true;
                if (!targetUserid || REMORA_PERMISSION_FLAGS.indexOf(targetFlag) < 0) {
                    session.send({
                        action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                        pluginaction: 'permissionsSetFlag',
                        tag: tag, responseid: responseid,
                        result: 'error', error: 'invalid-input'
                    });
                    return;
                }
                obj.meshServer.db.Get(REMORA_PERMISSIONS_DOC_ID, function (gerr, gdocs) {
                    var doc = (!gerr && gdocs && gdocs.length > 0) ? gdocs[0] : { _id: REMORA_PERMISSIONS_DOC_ID, type: 'remoraPermissions' };
                    if (!doc.grants || typeof doc.grants !== 'object') doc.grants = {};
                    if (targetValue) {
                        if (!doc.grants[targetUserid] || typeof doc.grants[targetUserid] !== 'object') doc.grants[targetUserid] = {};
                        doc.grants[targetUserid][targetFlag] = true;
                    } else if (doc.grants[targetUserid]) {
                        delete doc.grants[targetUserid][targetFlag];
                        if (Object.keys(doc.grants[targetUserid]).length === 0) delete doc.grants[targetUserid];
                    }
                    obj.meshServer.db.Set(doc, function () {
                        session.send({
                            action: 'plugin', plugin: PLUGIN_SHORT_NAME,
                            pluginaction: 'permissionsSetFlag',
                            tag: tag, responseid: responseid,
                            result: 'ok', flags: REMORA_PERMISSION_FLAGS, grants: doc.grants
                        });
                    });
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
