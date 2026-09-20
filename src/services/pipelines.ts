/**
 * Pipelines — route messages from configured WhatsApp groups to downstream
 * consumers without anyone clicking "Read Messages".
 *
 * Each pipeline watches one group and can do any combination of:
 *   - media:   download attachments (receipts, PDFs, photos) into a folder,
 *              with a JSONL manifest carrying caption / sender / timestamp
 *   - sheet:   append a row to the Google Sheet (A:G incl. message id + status)
 *   - queue:   append a JSON line to a queue file for a downstream processor
 *   - results: read a JSONL file written BY the downstream processor and sync
 *              each entry's status/output back to the sheet row (matched on id)
 *
 * The contract with downstream consumers is plain files on a mounted volume,
 * so the consumer never needs network access to this container.
 *
 * Delivery is at-least-once and idempotent per message id: a message is only
 * marked seen after its media/queue actions succeeded, so a crash or a failed
 * download is retried on the next poll instead of being lost. The sheet row is
 * best effort (a Sheets outage is reported in /pipelines-status but does not
 * stall the hand-off); consumers should de-duplicate on msgId.
 *
 * Configure with PIPELINES_CONFIG=/path/to/pipelines.json (see
 * pipelines.example.json). Without it, this module does nothing.
 */
import fs from 'fs';
import path from 'path';
import { Client, Message } from 'whatsapp-web.js';
import {
    appendRowsToSheet,
    ensureHeaderCells,
    readColumn,
    updateCells,
    isSheetsReady,
} from './googleSheets';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MediaConfig {
    dir: string;                       // where attachments are written
    types?: string[];                  // mimetype prefixes, default ['image/', 'application/pdf']
    manifest?: string;                 // manifest file name inside dir, default '_whatsapp-manifest.jsonl'
    includeTextOnly?: boolean;         // log text-only messages to the manifest too (default true)
}

export interface SheetConfig {
    name?: string;                     // sheet tab, default = GOOGLE_SHEETS_SHEET_NAME
}

export interface QueueConfig {
    file: string;                      // JSONL file the processor consumes
    onlyWithUrls?: boolean;            // queue only messages containing a link (default false)
}

export interface ResultsConfig {
    file: string;                      // JSONL written by the processor: {msgId,status,output?,note?}
}

export interface PipelineConfig {
    id: string;
    group: string;                     // exact WhatsApp group name
    enabled?: boolean;
    media?: MediaConfig;
    sheet?: SheetConfig;
    queue?: QueueConfig;
    results?: ResultsConfig;
}

export interface PipelinesFile {
    pollIntervalMinutes?: number;      // default 5
    fetchLimit?: number;               // messages fetched per poll per group, default 50
    backfillHours?: number;            // on first ever run, how far back to go, default 24
    timeZone?: string;                 // for file names, default Asia/Kolkata
    stateFile?: string;                // default /app/data/pipeline-state.json
    pipelines: PipelineConfig[];
}

interface PipelineState {
    lastTs: number;                    // unix seconds of newest processed message
    seen: string[];                    // recent message ids (bounded)
}

interface StateFile {
    pipelines: Record<string, PipelineState>;
    resultsOffsets: Record<string, number>;   // bytes of each results file already synced
}

const SEEN_CAP = 1000;
const TS_GRACE_SECONDS = 600;          // re-check a small window before lastTs (clock skew / late sync)

let cfg: PipelinesFile | null = null;
let state: StateFile = { pipelines: {}, resultsOffsets: {} };
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastRun: { at: string; processed: number; errors: string[] } | null = null;
let clientRef: Client | null = null;
let sheetErrors: string[] = [];
const chatIdByGroup: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

export const extractUrls = (text: string): string[] => {
    const found = (text || '').match(URL_RE) || [];
    const cleaned = found.map(u => u.replace(/[)\]}>.,;:!?*_]+$/, ''));
    return Array.from(new Set(cleaned));
};

export const slug = (s: string, max = 30): string =>
    (s || 'unknown')
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, max) || 'unknown';

const MIME_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
};

export const extensionFor = (mimetype: string, filename?: string | null): string => {
    const base = (mimetype || '').split(';')[0].trim().toLowerCase();
    if (MIME_EXT[base]) return MIME_EXT[base];
    const fromName = filename && path.extname(filename).replace('.', '').toLowerCase();
    if (fromName) return fromName;
    const sub = base.split('/')[1];
    return sub ? sub.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin' : 'bin';
};

/** 2026-09-20_143005 in the configured zone. */
export const stampFor = (unixSeconds: number, timeZone: string): string => {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(new Date(unixSeconds * 1000));
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}_${hour}${get('minute')}${get('second')}`;
};

export const isoFor = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

export const mediaTypeAllowed = (mimetype: string, types?: string[]): boolean => {
    const allowed = types && types.length ? types : ['image/', 'application/pdf'];
    const m = (mimetype || '').toLowerCase();
    return allowed.some(t => m.startsWith(t.toLowerCase()));
};

/** Write atomically so a consumer never picks up a half-written file. */
const writeFileAtomic = (target: string, data: Buffer | string) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.part`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
};

const appendLine = (file: string, obj: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
};

/** Pick a file name that does not already exist. */
const uniquePath = (dir: string, base: string, ext: string): string => {
    let candidate = path.join(dir, `${base}.${ext}`);
    let n = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base}-${n}.${ext}`);
        n++;
    }
    return candidate;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const stateFilePath = () => cfg?.stateFile || path.join(process.cwd(), 'data', 'pipeline-state.json');

const loadState = () => {
    try {
        const raw = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
        state = { pipelines: raw.pipelines || {}, resultsOffsets: raw.resultsOffsets || {} };
    } catch {
        state = { pipelines: {}, resultsOffsets: {} };
    }
};

const saveState = () => writeFileAtomic(stateFilePath(), JSON.stringify(state, null, 2));

const pipelineState = (id: string): PipelineState => {
    if (!state.pipelines[id]) {
        const backfill = (cfg?.backfillHours ?? 24) * 3600;
        state.pipelines[id] = { lastTs: Math.floor(Date.now() / 1000) - backfill, seen: [] };
    }
    return state.pipelines[id];
};

const markSeen = (ps: PipelineState, id: string, ts: number) => {
    ps.seen.push(id);
    if (ps.seen.length > SEEN_CAP) ps.seen = ps.seen.slice(-SEEN_CAP);
    if (ts > ps.lastTs) ps.lastTs = ts;
};

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

export interface MessageFacts {
    id: string;
    timestamp: number;
    sender: string;
    body: string;
    hasMedia: boolean;
}

const sheetName = (p: PipelineConfig) =>
    p.sheet?.name || process.env.GOOGLE_SHEETS_SHEET_NAME || 'WhatsApp Messages';

const spreadsheetId = () => process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';

export const processMessage = async (
    p: PipelineConfig,
    facts: MessageFacts,
    download: () => Promise<{ mimetype: string; data: string; filename?: string | null } | undefined>,
    timeZone: string,
): Promise<void> => {
    const urls = extractUrls(facts.body);

    // 1) media → folder + manifest
    if (p.media) {
        const manifest = path.join(p.media.dir, p.media.manifest || '_whatsapp-manifest.jsonl');
        const base = {
            msgId: facts.id,
            group: p.group,
            sender: facts.sender,
            timestamp: isoFor(facts.timestamp),
            caption: facts.body || '',
        };
        if (facts.hasMedia) {
            const media = await download();
            if (!media || !media.data) throw new Error('media download returned nothing');
            if (mediaTypeAllowed(media.mimetype, p.media.types)) {
                const ext = extensionFor(media.mimetype, media.filename);
                const name = `WA_${stampFor(facts.timestamp, timeZone)}_${slug(facts.sender, 20)}_${slug(facts.id.slice(-8), 8)}`;
                const target = uniquePath(p.media.dir, name, ext);
                writeFileAtomic(target, Buffer.from(media.data, 'base64'));
                appendLine(manifest, {
                    ...base,
                    file: path.basename(target),
                    mimetype: media.mimetype,
                    originalFilename: media.filename || null,
                });
                console.log(`📥 [${p.id}] saved ${path.basename(target)}`);
            } else {
                appendLine(manifest, { ...base, file: null, skipped: `mimetype ${media.mimetype} not in types` });
            }
        } else if (p.media.includeTextOnly !== false && facts.body.trim()) {
            appendLine(manifest, { ...base, file: null });
        }
    }

    // 2) queue line (before the sheet: the processor must never miss an item)
    if (p.queue && (!p.queue.onlyWithUrls || urls.length)) {
        appendLine(p.queue.file, {
            msgId: facts.id,
            group: p.group,
            sender: facts.sender,
            timestamp: isoFor(facts.timestamp),
            text: facts.body,
            urls,
        });
    }
    // 3) sheet row — best effort: a Sheets outage must not stall the folder/queue hand-off,
    //    so a failure is reported (sheetErrors) but does not block the message.
    if (p.sheet && spreadsheetId() && isSheetsReady()) {
        const res = await appendRowsToSheet(spreadsheetId(), sheetName(p), [[
            new Date(facts.timestamp * 1000).toLocaleString('en-IN', { timeZone }),
            p.group,
            facts.sender,
            facts.body,
            facts.id,
            p.queue && (!p.queue.onlyWithUrls || urls.length) ? 'NEW' : '',
            '',
        ]], 'A:G');
        if (!res.success) sheetErrors.push(`${p.id}: ${facts.id}: sheet append failed: ${res.error}`);
    }
};

// ---------------------------------------------------------------------------
// Results → sheet sync
// ---------------------------------------------------------------------------

export const readNewResultLines = (file: string, offset: number): { lines: any[]; newOffset: number } => {
    if (!fs.existsSync(file)) return { lines: [], newOffset: offset };
    const size = fs.statSync(file).size;
    if (size < offset) offset = 0;                    // file was rotated / truncated
    if (size === offset) return { lines: [], newOffset: offset };
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return { lines: [], newOffset: offset };   // wait for a complete line
    const complete = text.slice(0, lastNl);
    const lines = complete.split('\n').map(l => l.trim()).filter(Boolean).flatMap(l => {
        try { return [JSON.parse(l)]; } catch { return []; }
    });
    return { lines, newOffset: offset + Buffer.byteLength(complete, 'utf8') + 1 };
};

const syncResults = async (p: PipelineConfig) => {
    if (!p.results || !p.sheet || !spreadsheetId() || !isSheetsReady()) return;
    const key = p.results.file;
    const { lines, newOffset } = readNewResultLines(key, state.resultsOffsets[key] || 0);
    if (!lines.length) { state.resultsOffsets[key] = newOffset; return; }

    const ids = await readColumn(spreadsheetId(), sheetName(p), 'E');
    const updates: { range: string; values: string[][] }[] = [];
    for (const r of lines) {
        if (!r || !r.msgId) continue;
        const rowIdx = ids.lastIndexOf(r.msgId);
        if (rowIdx < 0) { console.warn(`[${p.id}] result for unknown msgId ${r.msgId}`); continue; }
        const row = rowIdx + 1;
        updates.push({
            range: `${sheetName(p)}!F${row}:G${row}`,
            values: [[String(r.status || '').toUpperCase(), String(r.output || r.note || '')]],
        });
    }
    if (updates.length) {
        const res = await updateCells(spreadsheetId(), updates);
        if (!res.success) throw new Error(`results sync failed: ${res.error}`);
        console.log(`🔁 [${p.id}] synced ${updates.length} result(s) to the sheet`);
    }
    state.resultsOffsets[key] = newOffset;
};

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

const findChat = async (client: Client, group: string) => {
    if (chatIdByGroup[group]) {
        try { return await client.getChatById(chatIdByGroup[group]); } catch { delete chatIdByGroup[group]; }
    }
    const chats = await client.getChats();
    const chat = chats.find((c: any) => c.isGroup && c.name === group);
    if (chat) chatIdByGroup[group] = (chat.id as any)._serialized;
    return chat;
};

const senderOf = async (msg: Message): Promise<string> => {
    try {
        const c = await msg.getContact();
        return c.pushname || c.name || c.number || 'unknown';
    } catch {
        return (msg as any).author || msg.from || 'unknown';
    }
};

const runPipeline = async (client: Client, p: PipelineConfig, errors: string[]): Promise<number> => {
    const chat = await findChat(client, p.group);
    if (!chat) { errors.push(`${p.id}: group "${p.group}" not found`); return 0; }

    const ps = pipelineState(p.id);
    const seen = new Set(ps.seen);
    const msgs: Message[] = await chat.fetchMessages({ limit: cfg?.fetchLimit ?? 50 });
    const fresh = msgs
        .filter(m => m.timestamp >= ps.lastTs - TS_GRACE_SECONDS)
        .filter(m => !seen.has(m.id._serialized))
        .filter(m => !['e2e_notification', 'notification_template', 'gp2', 'revoked', 'protocol'].includes(String(m.type)))
        .sort((a, b) => a.timestamp - b.timestamp);

    let done = 0;
    for (const msg of fresh) {
        const id = msg.id._serialized;
        try {
            await processMessage(p, {
                id,
                timestamp: msg.timestamp,
                sender: await senderOf(msg),
                body: msg.body || '',
                hasMedia: !!msg.hasMedia,
            }, async () => msg.downloadMedia() as any, cfg?.timeZone || 'Asia/Kolkata');
            markSeen(ps, id, msg.timestamp);
            saveState();
            done++;
        } catch (err: any) {
            // Stop this group at the first failure so ordering is kept and it is retried next poll.
            errors.push(`${p.id}: ${id}: ${err?.message || err}`);
            break;
        }
    }

    try { await syncResults(p); } catch (err: any) { errors.push(`${p.id}: ${err?.message || err}`); }
    saveState();
    return done;
};

export const runPipelinesOnce = async (): Promise<typeof lastRun> => {
    if (!cfg || !clientRef) return lastRun;
    if (running) return lastRun;
    running = true;
    const errors: string[] = [];
    sheetErrors = [];
    let processed = 0;
    try {
        for (const p of cfg.pipelines) {
            if (p.enabled === false) continue;
            try { processed += await runPipeline(clientRef, p, errors); }
            catch (err: any) { errors.push(`${p.id}: ${err?.message || err}`); }
        }
    } finally {
        running = false;
        errors.push(...sheetErrors);
        lastRun = { at: new Date().toISOString(), processed, errors };
        if (processed || errors.length) console.log('Pipelines run:', JSON.stringify(lastRun));
    }
    return lastRun;
};

export const loadPipelinesConfig = (): PipelinesFile | null => {
    const file = process.env.PIPELINES_CONFIG;
    if (!file) return null;
    try {
        const parsed: PipelinesFile = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed.pipelines)) throw new Error('"pipelines" must be an array');
        for (const p of parsed.pipelines) {
            if (!p.id || !p.group) throw new Error('every pipeline needs "id" and "group"');
        }
        return parsed;
    } catch (err: any) {
        console.error(`❌ Could not load PIPELINES_CONFIG ${file}: ${err.message}`);
        return null;
    }
};

/** Called once the WhatsApp client is ready and chats are cached. */
export const startPipelines = async (client: Client) => {
    cfg = loadPipelinesConfig();
    if (!cfg) { console.log('ℹ️  Pipelines not configured (set PIPELINES_CONFIG)'); return; }
    clientRef = client;
    loadState();
    for (const p of cfg.pipelines) {
        if (p.sheet && p.enabled !== false && spreadsheetId() && isSheetsReady()) {
            await ensureHeaderCells(spreadsheetId(), sheetName(p), 'E1:G1', ['Message ID', 'Status', 'Output']);
        }
    }
    const minutes = Math.max(1, cfg.pollIntervalMinutes ?? 5);
    console.log(`✅ Pipelines started: ${cfg.pipelines.filter(p => p.enabled !== false).map(p => `${p.id} ← "${p.group}"`).join(', ')} (every ${minutes} min)`);
    if (timer) clearInterval(timer);
    timer = setInterval(() => { runPipelinesOnce().catch(e => console.error('Pipelines error:', e)); }, minutes * 60 * 1000);
    await runPipelinesOnce();
};

export const stopPipelines = () => {
    if (timer) clearInterval(timer);
    timer = null;
    clientRef = null;
};

export const getPipelinesStatus = () => ({
    configured: !!cfg,
    running,
    pollIntervalMinutes: cfg?.pollIntervalMinutes ?? null,
    pipelines: (cfg?.pipelines || []).map(p => ({
        id: p.id,
        group: p.group,
        enabled: p.enabled !== false,
        lastTs: state.pipelines[p.id] ? isoFor(state.pipelines[p.id].lastTs) : null,
        seen: state.pipelines[p.id]?.seen.length ?? 0,
    })),
    lastRun,
});
