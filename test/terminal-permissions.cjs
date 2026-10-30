'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { remoraCore } = require('../remoraCore.js');
const actor = 'user//fixture';
function fixture() {
    const doc = { _id: 'remoraPermissions', grants: { [actor]: { canUseSystemTerminal: true, canRemoteInstall: false, canManageDeviceSessions: true } }, roleDefaults: { operator: { canUseSystemTerminal: true, canRemoteInstall: true } }, unrelated: 'preserve' };
    const writes = [];
    const plugin = remoraCore({ parent: { db: { Get(_id, cb) { cb(null, [doc]); }, Set(value, cb) { writes.push(JSON.parse(JSON.stringify(value))); if (cb) cb(null); } }, DispatchEvent() {} } });
    function request(action, args = {}, admin = true) {
        let reply;
        plugin.serveraction({ pluginaction: action, ...args }, { user: { _id: actor, siteadmin: admin ? 0xFFFFFFFF : 0 }, send(value) { reply = JSON.parse(JSON.stringify(value)); } });
        assert(reply); return reply;
    }
    return { request, doc, writes };
}
test('no permission read or implicit super-admin grant exposes Terminal System', () => {
    const f = fixture();
    for (const response of [f.request('permissionsSelf'), f.request('permissionsSelf', {}, false), f.request('permissionsList')]) {
        assert.equal(JSON.stringify(response).includes('canUseSystemTerminal'), false);
    }
    assert.equal(f.doc.grants[actor].canUseSystemTerminal, true); assert.equal(f.writes.length, 0);
});
test('both direct setters reject the removed flag without writing policy', () => {
    const f = fixture();
    for (const [action, args] of [
        ['permissionsSetFlag', { targetUser: actor, flag: 'canUseSystemTerminal', value: true }],
        ['permissionsSetRoleDefault', { role: 'operator', flag: 'canUseSystemTerminal', value: true }],
    ]) assert.equal(f.request(action, args).result, 'error');
    assert.equal(f.writes.length, 0);
});
test('remaining permissions preserve override/default semantics and stored legacy data', () => {
    const f = fixture();
    const own = f.request('permissionsSelf', {}, false);
    assert.equal(own.flags.canRemoteInstall, false); assert.equal(own.flags.canManageDeviceSessions, true);
    assert.equal(own.roleDefaults.operator.canRemoteInstall, true);
    const changed = f.request('permissionsSetFlag', { targetUser: actor, flag: 'canRemoteInstall', value: true });
    assert.equal(changed.result, 'ok'); assert.equal(JSON.stringify(changed).includes('canUseSystemTerminal'), false);
    assert.equal(f.writes.length, 1); assert.equal(f.doc.unrelated, 'preserve');
    assert.equal(f.doc.grants[actor].canUseSystemTerminal, true); assert.equal(f.doc.grants[actor].canManageDeviceSessions, true);
});
