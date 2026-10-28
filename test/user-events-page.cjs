'use strict';
// Only an explicitly supplied, disposable localhost MongoDB is allowed; never use application settings.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const [uri, driverRoot, output] = process.argv.slice(2);
assert(/^mongodb:\/\/127\.0\.0\.1:\d{4,5}\/$/.test(uri || ''), 'Pass an isolated random-port localhost MongoDB URI.');
assert(!uri.endsWith(':27017/'), 'The default MongoDB port is forbidden for this fixture.');
const requireDriver = createRequire(path.resolve(driverRoot, 'package.json'));
const { MongoClient, ObjectId } = requireDriver('mongodb');
const { remoraCore } = require('../remoraCore.js');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
const dbName = 'remora_activity_fixture_' + randomUUID().replaceAll('-', '');
const target = 'user//fixture', actor = 'user//operator';
const command = { pluginaction: 'userEventsPage', targetUser: target, tag: 'fixture-tag', responseid: 'fixture-response', pageSize: 50 };
let db, collection, queries = 0;
const server = { webPublicPath: path.resolve(driverRoot, 'public') };
const plugin = remoraCore({ parent: server });
const principal = { _id: actor, domain: '', siteadmin: 2 };
function request(input = command, who = principal, instance = plugin) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Plugin action did not respond')), 12000);
        instance.serveraction(input, { user: who, send(value) { clearTimeout(timer); resolve(value); } });
    });
}
function success(page) {
    assert.equal(page.result, 'ok', JSON.stringify(page));
    assert.equal(page.protocol, 1); assert.equal(page.targetUser, target);
    assert.equal(page.tag, command.tag); assert.equal(page.responseid, command.responseid);
    assert(page.events.length <= 50); assert(Buffer.byteLength(JSON.stringify(page)) < 1048576);
    assert(!page.events.some(event => event._id || event.domain || event.ids));
    return page;
}
async function run() {
    await client.connect(); db = client.db(dbName); collection = db.collection('events');
    server.db = { databaseType: 3, eventsfile: { find(...args) { queries++; return collection.find(...args); } } };
    const base = Date.now() - 10000;
    const events = Array.from({ length: 131 }, (_, i) => ({ _id: new ObjectId(i.toString(16).padStart(24, '0')), time: new Date(base), domain: '', ids: i % 2 ? [target] : [], userid: i % 2 ? 'user//other' : target, action: i % 3 ? 'relaylog' : 'agentlog', etype: 'relay', msg: 'row ' + i, msgid: i, msgArgs: ['session-' + i, 7, { protocol: 2 }], account: { realname: 'Fixture User', siteadmin: 2, privateData: 'must-not-leak' } }));
    await collection.insertMany([...events, { _id: new ObjectId(), time: new Date(base), domain: 'other', ids: [target], userid: target, msg: 'foreign-domain' }, { _id: new ObjectId(), time: new Date(base), domain: '', userid: 'user//unrelated', ids: [], msg: 'unrelated' }]);
    const advertised = await request({ pluginaction: 'ping' }); assert.equal(advertised.capabilities.userEventsPage, 1);
    const first = success(await request()); assert.equal(first.events.length, 50); assert.equal(first.events[0].msg, 'row 130'); assert.equal(first.previousCursor, null);
    assert.deepEqual(first.events[0].msgArgs, ['session-130', 7, { protocol: 2 }]); assert.equal(first.events[0].msgid, 130); assert.equal(first.events[0].account.realname, 'Fixture User'); assert.equal(first.events[0].account.privateData, undefined);
    const seen = first.events.map(event => event.msg); let next = first.nextCursor;
    const second = success(await request({ ...command, cursor: next })); seen.push(...second.events.map(event => event.msg));
    assert.deepEqual(success(await request({ ...command, cursor: second.previousCursor })).events, first.events, 'Previous must reproduce the prior equal-timestamp page.');
    next = second.nextCursor;
    while (next) { const page = success(await request({ ...command, cursor: next })); seen.push(...page.events.map(event => event.msg)); next = page.nextCursor; }
    assert.deepEqual(seen, events.toReversed().map(event => event.msg), 'Every authorized raw row is reachable exactly once, including equal timestamps and ids OR actor.');
    assert.equal((await request(command, { ...principal, siteadmin: 0 })).error, 'forbidden');
    for (const badTarget of [42, { $ne: null }, 'user/other/fixture', 'node//fixture', 'user//']) assert.equal((await request({ ...command, targetUser: badTarget })).error, 'invalid-target');
    assert.equal((await request({ ...command, filter: 'login' })).error, 'invalid-filter');
    for (const change of [{ targetUser: 'user//other' }, { filter: 'relaylog' }]) assert.equal((await request({ ...command, cursor: first.nextCursor, ...change })).error, 'invalid-cursor');
    assert.equal((await request({ ...command, cursor: first.nextCursor }, { ...principal, _id: 'user//another-admin' })).error, 'invalid-cursor');
    assert.equal((await request({ ...command, cursor: first.nextCursor.slice(0, -4) + 'AAAA' })).error, 'invalid-cursor');
    assert.equal((await request({ ...command, cursor: first.nextCursor }, principal, remoraCore({ parent: server }))).error, 'invalid-cursor');
    const originalNow = Date.now;
    try { Date.now = () => originalNow() + 1800001; assert.equal((await request({ ...command, cursor: first.nextCursor })).error, 'invalid-cursor'); }
    finally { Date.now = originalNow; }
    const filtered = success(await request({ ...command, filter: 'agentlog' })); assert(filtered.events.every(event => event.action === 'agentlog'));
    const newEvent = { _id: new ObjectId(), domain: '', userid: target, time: new Date(Date.now() + 60000), msg: 'new after upper' };
    await collection.insertOne(newEvent);
    assert(!success(await request({ ...command, cursor: first.nextCursor })).events.some(event => event.msg === newEvent.msg));
    try { Date.now = () => originalNow() + 61000; assert.equal(success(await request()).events[0].msg, newEvent.msg); }
    finally { Date.now = originalNow; }
    await collection.deleteOne({ _id: events[80]._id }); assert(!success(await request({ ...command, cursor: first.nextCursor })).events.some(event => event.msg === 'row 80'));
    for (const invalid of [{ _id: 'legacy-id', time: new Date(base) }, { _id: new ObjectId(), time: 'legacy-time' }, { _id: new ObjectId() }]) {
        await collection.insertOne({ ...invalid, domain: '', userid: target });
        assert.equal((await request()).error, 'unsupported-history');
        await collection.deleteOne({ _id: invalid._id });
    }
    const originalEventsFile = server.db.eventsfile;
    server.db.eventsfile = { find() { throw Error('private database error'); } };
    assert.equal((await request()).error, 'history-query-failed'); server.db.eventsfile = originalEventsFile;
    for (const type of [1, 2, 4, 5, 6, 7, 8]) { server.db.databaseType = type; assert.equal((await request()).error, 'unsupported-db'); }
    server.db.databaseType = 3;
    const revoked = { ...principal };
    server.db.eventsfile = { find(...args) { const cursor = collection.find(...args); const toArray = cursor.toArray.bind(cursor); cursor.toArray = async () => { const docs = await toArray(); revoked.siteadmin = 0; return docs; }; return cursor; } };
    assert.equal((await request(command, revoked)).error, 'forbidden'); server.db.eventsfile = originalEventsFile;
    const revokedOnPage = { ...principal }; let completedQueries = 0;
    server.db.eventsfile = { find(...args) { const cursor = collection.find(...args); const toArray = cursor.toArray.bind(cursor), next = cursor.next.bind(cursor); cursor.toArray = async () => { const docs = await toArray(); completedQueries = 1; return docs; }; cursor.next = async () => { const doc = await next(); if (++completedQueries === 2) revokedOnPage.siteadmin = 0; return doc; }; return cursor; } };
    assert.equal((await request(command, revokedOnPage)).error, 'forbidden'); server.db.eventsfile = originalEventsFile;
    server.webserver = { users: { [actor]: { ...principal, siteadmin: 0 } } };
    assert.equal((await request()).error, 'forbidden'); delete server.webserver;
    await collection.updateMany({ userid: target }, { $set: { msg: '\u0000'.repeat(20000), msgArgs: ['x'.repeat(6000)], account: { name: 'x'.repeat(1000) } } });
    let oversize = success(await request()), traversed = 0, forward = [];
    assert(oversize.events.some(event => event.payloadTruncated));
    while (true) { traversed += oversize.events.length; forward.push(...oversize.events.map(event => event.msgid)); if (!oversize.nextCursor) break; oversize = success(await request({ ...command, cursor: oversize.nextCursor })); }
    assert.equal(traversed, 130, 'Oversized payloads must retain rows and keep making progress.');
    const reverseIds = [];
    while (true) { reverseIds.push(...oversize.events.toReversed().map(event => event.msgid)); if (!oversize.previousCursor) break; oversize = success(await request({ ...command, cursor: oversize.previousCursor })); }
    assert.deepEqual(reverseIds, forward.toReversed(), 'Bidirectional byte-budget trimming must preserve every row exactly once.');
    await collection.deleteMany({});
    await collection.insertMany(Array.from({ length: 60 }, (_, i) => ({ domain: '', userid: target, time: new Date(base + i), msg: 'x'.repeat(1024 * 1024), msgid: i })));
    const largeIds = []; let largePage = success(await request());
    while (true) { largeIds.push(...largePage.events.map(event => event.msgid)); assert(largePage.events.every(event => event.payloadTruncated)); if (!largePage.nextCursor) break; largePage = success(await request({ ...command, cursor: largePage.nextCursor })); }
    assert.deepEqual(largeIds, Array.from({ length: 60 }, (_, i) => 59 - i), 'Dozens of oversized raw documents must traverse without retaining whole raw pages.');
    console.log('PASS real-Mongo userEventsPage: equal-time completeness, bidirectional paging, scope/rights/revocation, filters, old-peer/expiry, retention/refresh, malformed keys, errors, unsupported DB, bounded oversized payloads.');
    if (output) await benchmark(output);
}
async function benchmark(output) {
    const report = { mongodb: (await db.admin().serverInfo()).version, driver: requireDriver('mongodb/package.json').version, rows: [], note: 'Disposable Docker mongo:7, 2CPU/2GiB limit/tmpfs; 1 warmup + 5samples each. No production DB/indexes touched.' };
    for (const count of [100000, 250000]) {
        await collection.deleteMany({});
        for (let offset = 0; offset < count; offset += 5000) await collection.insertMany(Array.from({ length: Math.min(5000, count - offset) }, (_, i) => ({ domain: '', userid: target, ids: [target], time: new Date(1700000000000 + offset + i), action: 'relaylog', etype: 'relay', msg: 'synthetic ' + (offset + i) + ' x'.repeat(80) })));
        for (const indexed of [false, true]) {
            await collection.dropIndexes();
            if (indexed) { await collection.createIndex({ domain: 1, ids: 1, time: -1 }); await collection.createIndex({ domain: 1, userid: 1, time: -1 }, { sparse: true }); }
            const samples = [];
            for (let run = -1; run < 5; run++) {
                const start = performance.now(), page = success(await request()), firstMs = performance.now() - start;
                const following = performance.now(); success(await request({ ...command, cursor: page.nextCursor })); const nextMs = performance.now() - following;
                if (run >= 0) samples.push({ firstMs, nextMs, bytes: Buffer.byteLength(JSON.stringify(page)) });
            }
            const scope = { domain: '', $or: [{ ids: { $in: [target] } }, { userid: target }] };
            const admission = await collection.find({ $and: [scope, { $or: [{ time: { $not: { $type: 'date' } } }, { _id: { $not: { $type: 'objectId' } } }] }] }).project({ _id: 1 }).sort({ _id: 1 }).limit(1).maxTimeMS(5000).explain('executionStats');
            const pagePlan = await collection.find({ $and: [scope, { time: { $lte: new Date() } }] }).sort({ time: -1, _id: -1 }).limit(51).maxTimeMS(5000).explain('executionStats');
            const stats = (plan) => ({ executionTimeMillis: plan.executionStats.executionTimeMillis, totalDocsExamined: plan.executionStats.totalDocsExamined, totalKeysExamined: plan.executionStats.totalKeysExamined, winningPlan: plan.queryPlanner.winningPlan });
            report.rows.push({ count, indexed, samples, admission: stats(admission), firstPage: stats(pagePlan) });
            fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ count, indexed, samples, admission: stats(admission), firstPage: stats(pagePlan) }));
        }
    }
}
run().finally(async () => { if (db) { assert(db.databaseName.startsWith('remora_activity_fixture_')); await db.dropDatabase(); } await client.close(); }).catch(error => { console.error(error); process.exitCode = 1; });
