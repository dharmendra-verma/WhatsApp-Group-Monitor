import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    extractUrls, extensionFor, stampFor, slug, mediaTypeAllowed,
    processMessage, readNewResultLines, PipelineConfig,
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
    await processMessage(p, { id: 'false_123@g.us_ABCDEF1234567890', timestamp: ts, sender: 'Dharmendra verma', body: 'HDFC Regalia paid', hasMedia: true },
        async () => ({ mimetype: 'image/jpeg', data: Buffer.from('JPEGDATA').toString('base64'), filename: null }), 'Asia/Kolkata');
    await processMessage(p, { id: 'false_123@g.us_TEXTONLY00000001', timestamp: ts + 60, sender: 'Dharmendra verma', body: 'Paid gas Rs 561 cash', hasMedia: false },
        async () => undefined, 'Asia/Kolkata');

    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['WA_2026-09-20_140005_Dharmendra-verma_34567890.jpg', '_whatsapp-manifest.jsonl']);
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
