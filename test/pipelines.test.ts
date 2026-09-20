import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    extractUrls, extensionFor, stampFor, slug, mediaTypeAllowed,
    processMessage, readNewResultLines, PipelineConfig, shortMsgId, sweepDeletions, PipelineState, seedDeletionBacklog,
} from '../src/services/pipelines';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
const readJsonl = (f: string) => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('extractUrls trims trailing punctuation and de-dupes', () => {
    const t = 'see https://x.com/a/status/1?s=48 and (https://example.com/post). again https://x.com/a/status/1?s=48';
    assert.deepEqual(extractUrls(t), ['https://x.com/a/status/1?s=48', 'https://example.com/post']);
    assert.deepEqual(extractUrls(''), []);
});

test('extension, slug, stamp, mediaType helpers', () => {
    assert.equal(extensionFor('image/jpeg'), 'jpg');
    assert.equal(extensionFor('application/pdf; charset=binary'), 'pdf');
    assert.equal(extensionFor('application/octet-stream', 'bill.XLSX'), 'xlsx');
    assert.equal(slug('Dharmendra verma'), 'Dharmendra-verma');
    assert.equal(slug('😀'), 'unknown');
    // 2026-09-20T08:30:05Z = 14:00:05 IST
    assert.equal(stampFor(Date.UTC(2026, 8, 20, 8, 30, 5) / 1000, 'Asia/Kolkata'), '2026-09-20_140005');
    assert.ok(mediaTypeAllowed('image/png'));
    assert.ok(mediaTypeAllowed('application/pdf'));
    assert.ok(!mediaTypeAllowed('video/mp4'));
    assert.ok(mediaTypeAllowed('video/mp4', ['video/']));
});

test('receipt pipeline: saves image + manifest, logs text-only notes', async () => {
    const dir = tmp();
    const p: PipelineConfig = { id: 'receipts', group: 'Bill & Receipt', media: { dir } };
    const ts = Date.UTC(2026, 8, 20, 8, 30, 5) / 1000;
    await processMessage(p, { id: 'false_123@g.us_ABCDEF1234567890_81312421531673@lid', timestamp: ts, sender: 'Dharmendra verma', body: 'HDFC Regalia paid', hasMedia: true },
        async () => ({ mimetype: 'image/jpeg', data: Buffer.from('JPEGDATA').toString('base64'), filename: null }), 'Asia/Kolkata');
    await processMessage(p, { id: 'false_123@g.us_TEXTONLY00000001', timestamp: ts + 60, sender: 'Dharmendra verma', body: 'Paid gas Rs 561 cash', hasMedia: false },
        async () => undefined, 'Asia/Kolkata');

    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['WA_2026-09-20_140005_Dharmendra-verma_1234567890.jpg', '_whatsapp-manifest.jsonl']);
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'JPEGDATA');
    const m = readJsonl(path.join(dir, '_whatsapp-manifest.jsonl'));
    assert.equal(m.length, 2);
    assert.equal(m[0].file, files[0]);
    assert.equal(m[0].caption, 'HDFC Regalia paid');
    assert.equal(m[1].file, null);
    assert.equal(m[1].caption, 'Paid gas Rs 561 cash');
    assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.part')));
});

test('receipt pipeline: same second twice does not overwrite', async () => {
    const dir = tmp();
    const p: PipelineConfig = { id: 'r', group: 'g', media: { dir } };
    const dl = async () => ({ mimetype: 'application/pdf', data: Buffer.from('x').toString('base64') });
    await processMessage(p, { id: 'AAAAAAAA', timestamp: 1, sender: 's', body: '', hasMedia: true }, dl, 'UTC');
    await processMessage(p, { id: 'AAAAAAAA', timestamp: 1, sender: 's', body: '', hasMedia: true }, dl, 'UTC');
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).length, 2);
});

test('receipt pipeline: failed download throws (so the message is retried)', async () => {
    const dir = tmp();
    const p: PipelineConfig = { id: 'r', group: 'g', media: { dir } };
    await assert.rejects(processMessage(p, { id: 'x', timestamp: 1, sender: 's', body: '', hasMedia: true }, async () => undefined, 'UTC'));
});

test('reading pipeline: queues only messages with links when onlyWithUrls', async () => {
    const dir = tmp();
    const q = path.join(dir, 'queue.jsonl');
    const p: PipelineConfig = { id: 'reading', group: 'GP read', queue: { file: q, onlyWithUrls: true } };
    await processMessage(p, { id: 'm1', timestamp: 1, sender: 's', body: 'https://x.com/u/status/9?s=48 \n\nHarness engineering', hasMedia: false }, async () => undefined, 'UTC');
    await processMessage(p, { id: 'm2', timestamp: 2, sender: 's', body: 'just a note', hasMedia: false }, async () => undefined, 'UTC');
    const rows = readJsonl(q);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msgId, 'm1');
    assert.deepEqual(rows[0].urls, ['https://x.com/u/status/9?s=48']);
});

test('results reader: incremental, waits for a complete line, survives truncation', () => {
    const f = path.join(tmp(), 'results.jsonl');
    fs.writeFileSync(f, '{"msgId":"a","status":"done"}\n{"msgId":"b"');
    let r = readNewResultLines(f, 0);
    assert.deepEqual(r.lines.map(l => l.msgId), ['a']);
    fs.appendFileSync(f, ',"status":"failed"}\nnot json\n');
    r = readNewResultLines(f, r.newOffset);
    assert.deepEqual(r.lines.map(l => l.msgId), ['b']);
    const again = readNewResultLines(f, r.newOffset);
    assert.equal(again.lines.length, 0);
    fs.writeFileSync(f, '{"msgId":"c"}\n');           // rotated
    assert.deepEqual(readNewResultLines(f, r.newOffset).lines.map(l => l.msgId), ['c']);
    assert.equal(readNewResultLines(path.join(tmp(), 'missing'), 5).newOffset, 5);
});

test('shortMsgId uses the message key, not the shared author tail', () => {
    const a = 'true_919910161170-1569293439@g.us_3A7ED02E703B66525358_81312421531673@lid';
    const b = 'true_919910161170-1569293439@g.us_3EB0A2E5C937467796EA64_81312421531673@lid';
    assert.equal(shortMsgId(a), '703B66525358'.slice(-10));
    assert.notEqual(shortMsgId(a), shortMsgId(b));
    assert.equal(shortMsgId('plain'), 'plain');
});

test('reading pipeline (dir mode): one file per message in pending/, no twin on retry or after processing', async () => {
    const dir = tmp();
    const p: PipelineConfig = { id: 'reading', group: 'GP read', queue: { dir, onlyWithUrls: true } };
    const id = 'true_1@g.us_3EB0A2E5C937467796EA64_81312421531673@lid';
    const ts = Date.UTC(2026, 8, 20, 12, 26, 47) / 1000;
    const facts = { id, timestamp: ts, sender: 's', body: 'https://x.com/a/status/1?s=20 read this', hasMedia: false };
    await processMessage(p, facts, async () => undefined, 'Asia/Kolkata');
    await processMessage(p, facts, async () => undefined, 'Asia/Kolkata');          // at-least-once retry
    const pend = path.join(dir, 'pending');
    const files = fs.readdirSync(pend);
    assert.deepEqual(files, ['2026-09-20_175647_937467796EA64'.replace('937467796EA64', shortMsgId(id)) + '.json']);
    const item = JSON.parse(fs.readFileSync(path.join(pend, files[0]), 'utf8'));
    assert.equal(item.msgId, id);
    assert.deepEqual(item.urls, ['https://x.com/a/status/1?s=20']);
    // processor moves it away; a late retry must not resurrect it
    fs.mkdirSync(path.join(dir, 'processed', '2026-09'), { recursive: true });
    fs.renameSync(path.join(pend, files[0]), path.join(dir, 'processed', '2026-09', files[0]));
    await processMessage(p, facts, async () => undefined, 'Asia/Kolkata');
    assert.deepEqual(fs.readdirSync(pend), []);
    // no link -> nothing queued
    await processMessage(p, { ...facts, id: 'x_y_OTHERKEY0001_z', body: 'no link' }, async () => undefined, 'UTC');
    assert.deepEqual(fs.readdirSync(pend), []);
});

test('processMessage reports whether the message was captured durably', async () => {
    const dir = tmp();
    const r: PipelineConfig = { id: 'r', group: 'g', media: { dir } };
    const dl = async () => ({ mimetype: 'image/png', data: Buffer.from('x').toString('base64') });
    assert.equal(await processMessage(r, { id: 'a_b_K1_c', timestamp: 1, sender: 's', body: '', hasMedia: true }, dl, 'UTC'), true);
    assert.equal(await processMessage(r, { id: 'a_b_K2_c', timestamp: 1, sender: 's', body: 'paid gas 561', hasMedia: false }, dl, 'UTC'), true);
    // a video in a receipts group: logged, but NOT kept -> must not be deleted
    const vid = async () => ({ mimetype: 'video/mp4', data: Buffer.from('x').toString('base64') });
    assert.equal(await processMessage(r, { id: 'a_b_K3_c', timestamp: 1, sender: 's', body: '', hasMedia: true }, vid, 'UTC'), false);
    const q: PipelineConfig = { id: 'q', group: 'g', queue: { dir, onlyWithUrls: true } };
    assert.equal(await processMessage(q, { id: 'a_b_K4_c', timestamp: 1, sender: 's', body: 'https://e.com/x', hasMedia: false }, dl, 'UTC'), true);
    // chatter without a link, no sheet configured -> exists nowhere -> not captured
    assert.equal(await processMessage(q, { id: 'a_b_K5_c', timestamp: 1, sender: 's', body: 'hello', hasMedia: false }, dl, 'UTC'), false);
});

test('sweepDeletions: deletes captured messages, retries failures, gives up after 3, skips gone ones', async () => {
    const calls: string[] = [];
    const ok = (id: string) => ({ delete: async (everyone?: boolean) => { calls.push(`${id}:${everyone}`); } });
    const bad = { delete: async () => { throw new Error('boom'); } };
    const ps: PipelineState = { lastTs: 0, seen: [], deletable: ['m1', 'm2', 'gone', 'revoked'] };
    const p: PipelineConfig = { id: 'p', group: 'g', deleteAfterCapture: 'me' };
    const lookup = async (id: string) =>
        id === 'm1' ? ok('m1') : id === 'm2' ? bad : id === 'revoked' ? { type: 'revoked', delete: async () => {} } : null;
    const errors: string[] = [];
    assert.equal(await sweepDeletions(p, ps, lookup, errors), 1);
    assert.deepEqual(calls, ['m1:false']);
    assert.deepEqual(ps.deletable, ['m2']);                     // only the failing one stays
    await sweepDeletions(p, ps, lookup, errors);
    assert.deepEqual(ps.deletable, ['m2']);
    assert.equal(errors.length, 0);
    await sweepDeletions(p, ps, lookup, errors);                // 3rd failure -> give up, report
    assert.deepEqual(ps.deletable, []);
    assert.equal(errors.length, 1);
    assert.equal(ps.deletedTotal, 1);
    // 'everyone' passes true; disabled pipeline deletes nothing
    const ps2: PipelineState = { lastTs: 0, seen: [], deletable: ['x'] };
    await sweepDeletions({ ...p, deleteAfterCapture: 'everyone' }, ps2, async () => ok('x'), []);
    assert.deepEqual(calls.slice(-1), ['x:true']);
    const ps3: PipelineState = { lastTs: 0, seen: [], deletable: ['y'] };
    assert.equal(await sweepDeletions({ ...p, deleteAfterCapture: false }, ps3, async () => ok('y'), []), 0);
    assert.deepEqual(ps3.deletable, ['y']);
});

test('seedDeletionBacklog: only messages provably on disk, only once', async () => {
    const dir = tmp();
    const rp: PipelineConfig = { id: 'r', group: 'g', media: { dir }, deleteAfterCapture: 'me' };
    await processMessage(rp, { id: 't_g_SAVED00001_a', timestamp: 1, sender: 's', body: '', hasMedia: true },
        async () => ({ mimetype: 'application/pdf', data: 'eA==' }), 'UTC');
    const ps: PipelineState = { lastTs: 0, seen: ['t_g_SAVED00001_a', 't_g_NOTONDISK1_a'] };
    assert.equal(seedDeletionBacklog(rp, ps), 1);
    assert.deepEqual(ps.deletable, ['t_g_SAVED00001_a']);
    assert.equal(seedDeletionBacklog(rp, ps), 0);                // once only
    const qdir = tmp();
    const qp: PipelineConfig = { id: 'q', group: 'g', queue: { dir: qdir }, deleteAfterCapture: 'me' };
    const id = 'true_1@g.us_3A7ED02E703B66525358_8131@lid';
    fs.mkdirSync(path.join(qdir, 'processed', '2026-09'), { recursive: true });
    fs.writeFileSync(path.join(qdir, 'processed', '2026-09', `2026-09-19_214936_${shortMsgId(id)}.json`), '{}');
    const qs: PipelineState = { lastTs: 0, seen: [id, 'x_y_OTHER00000_z'] };
    assert.equal(seedDeletionBacklog(qp, qs), 1);
    assert.deepEqual(qs.deletable, [id]);
});
