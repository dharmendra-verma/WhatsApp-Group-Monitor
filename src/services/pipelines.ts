/**
 * Pipelines — route messages from configured WhatsApp groups to downstream
 * consumers without anyone clicking "Read Messages".
 *
 * Each pipeline watches one group and can do any combination of:
 *   - media:   download attachments (receipts, PDFs, photos) into a folder,
 *              with a JSONL manifest carrying caption / sender / timestamp
 *   - sheet:   append a row to the Google Sheet (A:G incl. message id + status)
 *   - queue:   hand the message to a downstream processor — one JSON file per
 *              message in <dir>/pending/ (the processor moves it to processed/),
 *              or, legacy, a line in a JSONL file
 *   - results: read a JSONL file written BY the downstream processor and sync
 *              each entry's status/output back to the sheet row (matched on id)
 *   - deleteAfterCapture: delete the WhatsApp message once it has been captured
 *              durably (file saved / queued / sheet row written) — never before
 *   - outbox:  send replies BACK to the group — drop a .json file in <dir>/outbox/
 *              and it is posted, then moved to outbox/sent/
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
import { Client, Message, MessageMedia } from 'whatsapp-web.js';
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
    dir?: string;                      // PREFERRED: one JSON file per message in <dir>/pending/;
                                       // the processor moves each file to <dir>/processed/ when done
    file?: string;                     // legacy: one JSONL file (append-only). Ignored when dir is set.
    onlyWithUrls?: boolean;            // queue only messages containing a link (default false)
}

export interface OutboxConfig {
    dir: string;                       // <dir>/outbox/*.json are sent, then moved to <dir>/outbox/sent/
    chunkChars?: number;               // split long text into messages of this size (default 3500)
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
    outbox?: OutboxConfig;
    // Delete the WhatsApp message after it was captured durably:
    //   'me'       — delete for me (clean: no "This message was deleted" bubble; syncs to your linked devices)
    //   'everyone' — revoke for all members where WhatsApp allows it (own message, within its time
    //                limit); otherwise WhatsApp falls back to delete-for-me. Leaves a placeholder bubble.
    //   omitted / false — keep messages (default)
    deleteAfterCapture?: false | 'me' | 'everyone';
}

export interface PipelinesFile {
    pollIntervalMinutes?: number;      // default 5
    fetchLimit?: number;               // messages fetched per poll per group, default 50
    backfillHours?: number;            // on first ever run, how far back to go, default 24
    timeZone?: string;                 // for file names, default Asia/Kolkata
    stateFile?: string;                // default /app/data/pipeline-state.json
    pipelines: PipelineConfig[];
}

export interface PipelineState {
    lastTs: number;                    // unix seconds of newest processed message
    seen: string[];                    // recent message ids (bounded)
    deletable?: string[];              // captured durably, still to delete in WhatsApp
    deleteFailures?: Record<string, number>;
    deletedTotal?: number;
    deleteSeeded?: boolean;            // backlog of already-seen messages checked once for deletion
    sendFailures?: Record<string, number>;
    sentTotal?: number;
    sentMsgIds?: string[];             // ids of messages WE sent — never queue our own replies back
}

interface StateFile {
    pipelines: Record<string, PipelineState>;
    resultsOffsets: Record<string, number>;   // bytes of each results file already synced
}

const SEEN_CAP = 1000;
const DELETE_MAX_ATTEMPTS = 3;
const SEND_MAX_ATTEMPTS = 3;
const SENT_IDS_CAP = 200;
const DEFAULT_CHUNK = 3500;
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

/**
 * The unique part of a WhatsApp message id, for file names.
 * Ids look like  true_<chat>@g.us_<MESSAGE-KEY>_<author>@lid ; the tail (<author>@lid)
 * is the same for every message you send, so the key is what tells messages apart.
 */
export const shortMsgId = (id: string, len = 10): string => {
    const parts = (id || '').split('_');
    const key = parts.length >= 3 ? parts[2] : parts[parts.length - 1] || id;
    return slug(key, 64).slice(-len) || 'unknown';
};

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

/** True if <dir>/processed/<any subfolder>/<name> exists. */
const alreadyProcessed = (dir: string, name: string): boolean => {
    const root = path.join(dir, 'processed');
    if (!fs.existsSync(root)) return false;
    if (fs.existsSync(path.join(root, name))) return true;
    return fs.readdirSync(root, { withFileTypes: true })
        .some(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, name)));
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
): Promise<boolean> => {
    const urls = extractUrls(facts.body);
    let captured = false;              // true once the message exists somewhere durable

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
                const name = `WA_${stampFor(facts.timestamp, timeZone)}_${slug(facts.sender, 20)}_${shortMsgId(facts.id)}`;
                const target = uniquePath(p.media.dir, name, ext);
                writeFileAtomic(target, Buffer.from(media.data, 'base64'));
                appendLine(manifest, {
                    ...base,
                    file: path.basename(target),
                    mimetype: media.mimetype,
                    originalFilename: media.filename || null,
                });
                console.log(`📥 [${p.id}] saved ${path.basename(target)}`);
                captured = true;
            } else {
                // Not a type we save: log it, but do NOT count it captured (the attachment itself is not kept).
                appendLine(manifest, { ...base, file: null, skipped: `mimetype ${media.mimetype} not in types` });
            }
        } else if (p.media.includeTextOnly !== false && facts.body.trim()) {
            appendLine(manifest, { ...base, file: null });
            captured = true;
        }
    }

    // 2) queue line (before the sheet: the processor must never miss an item)
    if (p.queue && (!p.queue.onlyWithUrls || urls.length)) {
        const item = {
            msgId: facts.id,
            group: p.group,
            sender: facts.sender,
            timestamp: isoFor(facts.timestamp),
            text: facts.body,
            urls,
        };
        if (p.queue.dir) {
            const name = `${stampFor(facts.timestamp, timeZone)}_${shortMsgId(facts.id)}`;
            const pending = path.join(p.queue.dir, 'pending');
            const target = path.join(pending, `${name}.json`);
            // Retried after a crash? The file may already be in pending/ or processed/ — never write a twin.
            if (!fs.existsSync(target) && !alreadyProcessed(p.queue.dir, `${name}.json`)) {
                writeFileAtomic(target, JSON.stringify(item, null, 2) + '\n');
            }
            captured = true;
        } else if (p.queue.file) {
            appendLine(p.queue.file, item);
            captured = true;
        } else {
            throw new Error(`pipeline ${p.id}: queue needs "dir" or "file"`);
        }
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
        else captured = true;
    }
    return captured;
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
// Delete-after-capture
// ---------------------------------------------------------------------------

export interface DeletableMsg {
    type?: string;
    delete: (everyone?: boolean) => Promise<unknown>;
}

/** Is there durable evidence on disk that this message was captured? Used only for the one-time backlog. */
export const verifyCapturedOnDisk = (p: PipelineConfig, id: string): boolean => {
    if (p.media) {
        const manifest = path.join(p.media.dir, p.media.manifest || '_whatsapp-manifest.jsonl');
        const archivedLedger = path.join(p.media.dir, 'archived', '_processed.jsonl');
        for (const f of [manifest, archivedLedger]) {
            if (!fs.existsSync(f)) continue;
            for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!line.includes(id)) continue;
                try {
                    const o = JSON.parse(line);
                    if (o.msgId === id && !o.skipped) return true;
                } catch { /* ignore */ }
            }
        }
    }
    if (p.queue?.dir) {
        const suffix = `_${shortMsgId(id)}.json`;
        const roots = [path.join(p.queue.dir, 'pending'), path.join(p.queue.dir, 'processed')];
        const walk = (d: string): boolean => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true })
            .some(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(suffix));
        if (roots.some(walk)) return true;
    }
    return false;
};

/** First run with deleteAfterCapture: queue for deletion the already-seen messages that are provably on disk. */
export const seedDeletionBacklog = (p: PipelineConfig, ps: PipelineState): number => {
    if (!p.deleteAfterCapture || ps.deleteSeeded) return 0;
    const add = ps.seen.filter(id => !(ps.deletable || []).includes(id) && verifyCapturedOnDisk(p, id));
    ps.deletable = [...(ps.deletable || []), ...add];
    ps.deleteSeeded = true;
    return add.length;
};

/**
 * Delete every message in ps.deletable. Runs every poll, so a failed delete is retried
 * (up to DELETE_MAX_ATTEMPTS) and a backlog drains on its own. Only ids that were captured
 * durably ever enter ps.deletable, so nothing is deleted that exists nowhere else.
 */
export const sweepDeletions = async (
    p: PipelineConfig,
    ps: PipelineState,
    lookup: (id: string) => Promise<DeletableMsg | null | undefined>,
    errors: string[],
): Promise<number> => {
    if (!p.deleteAfterCapture || !ps.deletable?.length) return 0;
    ps.deleteFailures = ps.deleteFailures || {};
    let deleted = 0;
    for (const id of [...ps.deletable]) {
        const drop = () => {
            ps.deletable = (ps.deletable || []).filter(x => x !== id);
            delete ps.deleteFailures![id];
        };
        try {
            const msg = await lookup(id);
            if (!msg || msg.type === 'revoked') { drop(); continue; }          // already gone
            await msg.delete(p.deleteAfterCapture === 'everyone');
            drop();
            deleted++;
        } catch (err: any) {
            const n = (ps.deleteFailures[id] || 0) + 1;
            ps.deleteFailures[id] = n;
            if (n >= DELETE_MAX_ATTEMPTS) {
                errors.push(`${p.id}: gave up deleting ${id} after ${n} attempts: ${err?.message || err}`);
                drop();
            }
        }
    }
    ps.deletedTotal = (ps.deletedTotal || 0) + deleted;
    if (deleted) console.log(`🗑️  [${p.id}] deleted ${deleted} captured message(s) from "${p.group}"`);
    return deleted;
};

// ---------------------------------------------------------------------------
// Outbox — replies going back to the group
// ---------------------------------------------------------------------------

export interface OutboxItem {
    text?: string;                     // message body (split into chunks if long)
    file?: string;                     // absolute path of a file to attach
    caption?: string;                  // caption for the attachment
    replyToMsgId?: string;             // quote this message in the reply
}

/** Split on paragraph/line boundaries so a reply never breaks mid-sentence. */
export const chunkText = (text: string, max = DEFAULT_CHUNK): string[] => {
    const src = (text || '').trim();
    if (!src) return [];
    if (src.length <= max) return [src];
    const out: string[] = [];
    let rest = src;
    while (rest.length > max) {
        const window = rest.slice(0, max);
        let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
        if (cut < max * 0.5) cut = window.lastIndexOf(' ');
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.map((t, i) => (out.length > 1 ? `(${i + 1}/${out.length}) ${t}` : t));
};

export const readOutboxItem = (file: string): OutboxItem | null => {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const item = JSON.parse(raw) as OutboxItem;
        if (!item || (!item.text && !item.file)) return null;
        return item;
    } catch {
        return null;                    // half-written or invalid: try again next poll
    }
};

export interface Sendable {
    sendMessage: (content: any, options?: any) => Promise<unknown>;
}

/** Remember an id of a message we sent, so the next poll does not treat it as an incoming question. */
export const rememberSent = (ps: PipelineState, sent: unknown) => {
    const id = (sent as any)?.id?._serialized ?? (sent as any)?.id?.$1;
    if (typeof id !== 'string' || !id) return;
    ps.sentMsgIds = [...(ps.sentMsgIds || []), id].slice(-SENT_IDS_CAP);
};

/**
 * Send everything waiting in <dir>/outbox/. One .json file = one reply.
 * A sent file moves to outbox/sent/; a file that fails SEND_MAX_ATTEMPTS times moves to
 * outbox/failed/ and is reported — a reply is never silently dropped and never sent twice.
 */
export const sweepOutbox = async (
    p: PipelineConfig,
    ps: PipelineState,
    chat: Sendable,
    errors: string[],
    mediaFromPath?: (file: string) => any,
): Promise<number> => {
    if (!p.outbox) return 0;
    const dir = path.join(p.outbox.dir, 'outbox');
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    if (!files.length) return 0;
    ps.sendFailures = ps.sendFailures || {};
    let sent = 0;
    for (const name of files) {
        const full = path.join(dir, name);
        const item = readOutboxItem(full);
        if (!item) continue;
        try {
            if (item.file) {
                if (!fs.existsSync(item.file)) throw new Error(`attachment not found: ${item.file}`);
                const media = mediaFromPath ? mediaFromPath(item.file) : null;
                if (!media) throw new Error('no media loader available');
                rememberSent(ps, await chat.sendMessage(media, { caption: item.caption || item.text || undefined }));
            } else {
                for (const part of chunkText(item.text || '', p.outbox.chunkChars || DEFAULT_CHUNK)) {
                    rememberSent(ps, await chat.sendMessage(part,
                        item.replyToMsgId ? { quotedMessageId: item.replyToMsgId } : undefined));
                }
            }
            const sentDir = path.join(dir, 'sent');
            fs.mkdirSync(sentDir, { recursive: true });
            fs.renameSync(full, path.join(sentDir, name));
            delete ps.sendFailures[name];
            sent++;
        } catch (err: any) {
            const n = (ps.sendFailures[name] || 0) + 1;
            ps.sendFailures[name] = n;
            if (n >= SEND_MAX_ATTEMPTS) {
                const failedDir = path.join(dir, 'failed');
                fs.mkdirSync(failedDir, { recursive: true });
                try { fs.renameSync(full, path.join(failedDir, name)); } catch { /* keep it */ }
                delete ps.sendFailures[name];
                errors.push(`${p.id}: gave up sending ${name} after ${n} attempts: ${err?.message || err}`);
            }
        }
    }
    ps.sentTotal = (ps.sentTotal || 0) + sent;
    if (sent) console.log(`📤 [${p.id}] sent ${sent} reply/replies to "${p.group}"`);
    return sent;
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
        .filter(m => !(ps.sentMsgIds || []).includes(m.id._serialized))   // our own replies are not questions
        .filter(m => !['e2e_notification', 'notification_template', 'gp2', 'revoked', 'protocol'].includes(String(m.type)))
        .sort((a, b) => a.timestamp - b.timestamp);

    let done = 0;
    for (const msg of fresh) {
        const id = msg.id._serialized;
        try {
            const captured = await processMessage(p, {
                id,
                timestamp: msg.timestamp,
                sender: await senderOf(msg),
                body: msg.body || '',
                hasMedia: !!msg.hasMedia,
            }, async () => msg.downloadMedia() as any, cfg?.timeZone || 'Asia/Kolkata');
            markSeen(ps, id, msg.timestamp);
            if (captured && p.deleteAfterCapture) (ps.deletable = ps.deletable || []).push(id);
            saveState();
            done++;
        } catch (err: any) {
            // Stop this group at the first failure so ordering is kept and it is retried next poll.
            errors.push(`${p.id}: ${id}: ${err?.message || err}`);
            break;
        }
    }

    try {
        const seeded = seedDeletionBacklog(p, ps);
        if (seeded) console.log(`🗑️  [${p.id}] ${seeded} earlier message(s) verified on disk, queued for deletion`);
        const byId = new Map(msgs.map(m => [m.id._serialized, m]));
        await sweepDeletions(p, ps, async id =>
            (byId.get(id) as any) ?? ((await client.getMessageById(id).catch(() => null)) as any), errors);
    } catch (err: any) { errors.push(`${p.id}: delete sweep: ${err?.message || err}`); }
    saveState();

    try {
        await sweepOutbox(p, ps, chat as any, errors, (f: string) => MessageMedia.fromFilePath(f));
    } catch (err: any) { errors.push(`${p.id}: outbox: ${err?.message || err}`); }
    saveState();

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
        deleteAfterCapture: p.deleteAfterCapture || false,
        awaitingDelete: state.pipelines[p.id]?.deletable?.length ?? 0,
        deletedTotal: state.pipelines[p.id]?.deletedTotal ?? 0,
        outbox: p.outbox ? path.join(p.outbox.dir, 'outbox') : false,
        sentTotal: state.pipelines[p.id]?.sentTotal ?? 0,
    })),
    lastRun,
});
