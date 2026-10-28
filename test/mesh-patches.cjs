'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { remoraCore } = require('../remoraCore.js');

const [overlay, upstream] = process.argv.slice(2);
assert(overlay && upstream, 'Pass the verified overlay files directory and upstream Git checkout.');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'remora-core-patches-'));
const meshServer = { webPublicPath: path.join(fixture, 'public') };
const plugin = remoraCore({ parent: meshServer });
let checks = 0;

function report() {
    let response;
    plugin.serveraction({ pluginaction: 'verifyMeshPatches', tag: 'fixture', responseid: 'fixture-response' }, {
        send(value) { response = value; }
    });
    assert.equal(response.result, 'ok');
    assert.equal(response.tag, 'fixture');
    assert.equal(response.responseid, 'fixture-response');
    return response.report;
}

function missing(result, name, reason) {
    assert.equal(result.ok, false);
    assert(result.missing.some(item => item.name === name && item.reason === reason), name);
    assert(!result.present.includes(name), name);
    assert(!JSON.stringify(result).includes(fixture), 'Never expose resolved filesystem paths.');
    checks++;
}

function withSource(file, source, check) {
    const target = path.join(fixture, file);
    const before = fs.readFileSync(target);
    try { fs.writeFileSync(target, source); check(report()); }
    finally { fs.writeFileSync(target, before); }
}

try {
    for (const file of ['db.js', 'pluginHandler.js', 'meshuser.js', 'webserver.js', 'meshrelay.js', 'agents/meshcore.js']) {
        const target = path.join(fixture, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(path.resolve(overlay), file), target);
    }
    assert.equal(report().ok, true, 'The final overlay must satisfy the source requirements.');

    // Real pristine files are the negative control: a generic Remora comment cannot satisfy a capability.
    for (const [file, name] of [
        ['meshuser.js', 'meshuser-session-security-stepup'],
        ['webserver.js', 'webserver-stepup-persist'],
        ['agents/meshcore.js', 'meshcore-chat-protocol11'],
        ['meshrelay.js', 'meshrelay-desktop-local-end']
    ]) {
        const pristine = execFileSync('git', ['-C', path.resolve(upstream), 'show', '1.3.1:' + file], { maxBuffer: 4 * 1024 * 1024 });
        withSource(file, Buffer.concat([pristine, Buffer.from('\n// MODIFIED FOR REMORAHQ\n')]), result => missing(result, name, 'marker-missing'));
    }

    // The remora.1 Event Log handler existed but failed on MeshAgent's native Buffer implementation.
    const core = fs.readFileSync(path.join(fixture, 'agents/meshcore.js'), 'utf8');
    const oldBuffer = core.replace('Buffer.concat([chunk])', 'Buffer.from(chunk)');
    assert.notEqual(oldBuffer, core);
    withSource('agents/meshcore.js', oldBuffer, result => missing(result, 'meshcore-eventlog-native-buffer', 'marker-missing'));

    const coreTarget = path.join(fixture, 'agents/meshcore.js');
    const savedCore = path.join(fixture, 'agents/saved-core.js');
    fs.renameSync(coreTarget, savedCore);
    fs.mkdirSync(coreTarget);
    try {
        const result = report();
        missing(result, 'meshcore-eventlog', 'read-error: EISDIR');
        missing(result, 'meshcore-desktop-local-end', 'read-error: EISDIR');
    } finally { fs.rmdirSync(coreTarget); fs.renameSync(savedCore, coreTarget); }

    meshServer.db = { remoraDbDeleteEventsRequired: true, remoraDbDeleteEventsReady: false };
    missing(report(), 'db-changestream-delete-runtime', 'pre-images-unavailable');
    meshServer.db.remoraDbDeleteEventsReady = true;
    assert.equal(report().ok, true);
    meshServer.db.remoraDbDeleteEventsRequired = false;
    meshServer.db.remoraDbDeleteEventsReady = false;
    assert.equal(report().ok, true, 'Do not require MongoDB prerequisites for other databases.');
    console.log('PASS ' + checks + ' public patch diagnostics checks; final sources, pristine/partial/unreadable files and conditional DB readiness.');
} finally {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith('remora-core-patches-'));
    fs.rmSync(fixture, { recursive: true, force: true });
}
