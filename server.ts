import express, { Request, Response } from 'express';
import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import * as fs from 'fs';
import path from 'path';
import { initializeGoogleSheets, appendMessageToSheet, appendBatchToSheet, ensureSheetExists, getGoogleSheetsStatus } from './googleSheets';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static('public'));
app.use(express.json());

let client: Client | null = null;
let qrCodeData: string | null = null;
let isAuthenticated = false;
let isReading = false;
let currentGroupName = 'GP read'; // Default group name
let availableGroups: string[] = [];
let cachedChats: any[] = []; // Cache chats to avoid timeout issues

// Google Sheets configuration
let googleSheetsSpreadsheetId: string = '';
let googleSheetsSheetName: string = 'WhatsApp Messages';

// Function to append message to file
const appendToLog = (text: string) => {
    console.log('Writing message to file: ' + text);
    fs.appendFileSync('GP_read_history.txt', text + '\n');
};

// Initialize WhatsApp client
const initializeClient = () => {
    console.log('Initializing WhatsApp Client...');

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            protocolTimeout: 300000 // 5 minutes timeout
        }
    });

    client.on('qr', (qr: string) => {
        console.log('QR RECEIVED');
        qrCodeData = qr;
        isAuthenticated = false;
    });

    client.on('ready', async () => {
        console.log('Client is ready!');
        isAuthenticated = true;
        qrCodeData = null;

        // Wait for WhatsApp to fully sync before fetching chats
        console.log('Waiting 10s for WhatsApp to sync...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Fetch and cache available groups with retries
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`Fetching all chats (attempt ${attempt}/3)...`);
                cachedChats = await client!.getChats();
                console.log('Chats cached successfully! Total:', cachedChats.length);

                availableGroups = cachedChats
                    .filter(chat => chat.isGroup)
                    .map(chat => chat.name);
                console.log('Available groups:', availableGroups);
                break;
            } catch (err) {
                console.error(`Attempt ${attempt} failed:`, err);
                cachedChats = [];
                if (attempt < 3) {
                    console.log('Retrying in 15s...');
                    await new Promise(resolve => setTimeout(resolve, 15000));
                }
            }
        }
    });

    client.on('auth_failure', (msg: string) => {
        console.error('AUTHENTICATION FAILURE', msg);
        isAuthenticated = false;
    });

    client.on('message', async (msg: Message) => {
        try {
            const chat = await msg.getChat();

            // Only log messages from the specific group if real-time logging is enabled
            if (chat.isGroup && chat.name === currentGroupName) {
                const contact = await msg.getContact();
                const logMsg = `[${new Date(msg.timestamp * 1000).toLocaleString()}] ${contact.pushname || contact.number}: ${msg.body}`;
                console.log('New message:', logMsg);
                appendToLog(logMsg);
            }
        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    client.initialize();
};

// Fetch and optionally delete messages
const BATCH_SIZE = 5;

const fetchGroupMessages = async (groupName: string, shouldDelete: boolean = false, messageLimit: number = 10) => {
    console.log('=== fetchGroupMessages START ===');
    console.log('Group name:', groupName);
    console.log('Message limit:', messageLimit);
    console.log('Should delete:', shouldDelete);

    if (!client || !isAuthenticated) {
        throw new Error('WhatsApp client is not authenticated');
    }

    // If chats aren't cached yet, try fetching them directly
    if (cachedChats.length === 0) {
        console.log('No cached chats, fetching now...');
        try {
            cachedChats = await client!.getChats();
            availableGroups = cachedChats
                .filter(chat => chat.isGroup)
                .map(chat => chat.name);
            console.log('Chats fetched successfully! Total:', cachedChats.length);
        } catch (err) {
            console.error('Failed to fetch chats:', err);
            throw new Error('Unable to load chats. WhatsApp may still be syncing — please wait a moment and try again.');
        }
    }

    console.log('Using chats. Total:', cachedChats.length);

    if (cachedChats.length === 0) {
        throw new Error('No chats available. WhatsApp may still be syncing — please wait a moment and try again.');
    }

    const targetGroup = cachedChats.find(chat => chat.isGroup && chat.name === groupName);
    console.log('Target group found:', !!targetGroup);

    if (!targetGroup) {
        const groupNames = availableGroups.join(', ');
        console.log('Available groups:', groupNames);
        throw new Error(`Group '${groupName}' not found. Available groups: ${groupNames}`);
    }

    console.log('Fetching messages from group:', targetGroup.name);
    const messages = await targetGroup.fetchMessages({ limit: messageLimit });
    console.log('Messages fetched:', messages.length);

    const result = [];

    const header = `\n--- Session Start: ${new Date().toLocaleString()} ---`;
    appendToLog(header);

    // Process messages in batches
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} messages)...`);

        // Read batch: extract message data
        const batchData = [];
        for (const msg of batch) {
            const contact = await msg.getContact();
            batchData.push({
                msg,
                contact,
                timestamp: new Date(msg.timestamp * 1000).toLocaleString(),
                sender: contact.pushname || contact.number,
                body: msg.body
            });
        }

        // Write batch: log to file and collect rows for Google Sheets
        const sheetRows: string[][] = [];
        for (const { msg, timestamp, sender, body } of batchData) {
            const logMsg = `[${timestamp}] ${sender}: ${body}`;

            result.push({ timestamp, sender, message: body });
            appendToLog(logMsg);
            sheetRows.push([timestamp, groupName, sender, body]);

            if (shouldDelete) {
                try {
                    if (msg.fromMe) {
                        await msg.delete(true);
                        console.log('🗑️  Message deleted (for everyone)');
                    } else {
                        await msg.delete(true);
                        console.log('🗑️  Message deleted');
                    }
                } catch (deleteErr) {
                    console.error(`❌ Failed to delete message:`, deleteErr);
                    try {
                        await msg.delete();
                        console.log('🗑️  Message deleted (for me only - fallback)');
                    } catch (fallbackErr) {
                        console.error('❌ Fallback delete also failed.');
                    }
                }
            }
        }

        // Write entire batch to Google Sheets in one API call
        if (googleSheetsSpreadsheetId && sheetRows.length > 0) {
            await appendBatchToSheet(googleSheetsSpreadsheetId, googleSheetsSheetName, sheetRows);
        }

        console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} complete.`);
    }

    console.log('=== fetchGroupMessages END ===');
    console.log('Returning', result.length, 'messages');
    return result;
};

// API Routes
app.get('/status', (req: Request, res: Response) => {
    res.json({
        authenticated: isAuthenticated,
        qrCode: qrCodeData,
        reading: isReading,
        currentGroupName,
        availableGroups
    });
});

app.post('/read-messages', async (req: Request, res: Response) => {
    if (isReading) {
        return res.status(400).json({ error: 'Already reading messages' });
    }

    try {
        isReading = true;
        const { deleteMessages, groupName, messageLimit } = req.body;

        // Use provided group name or default
        const targetGroup = groupName || currentGroupName;
        const limit = Math.min(Math.max(parseInt(messageLimit) || 10, 1), 100);

        // Update current group name if provided
        if (groupName) {
            currentGroupName = groupName;
            console.log('Updated current group to:', currentGroupName);
        }

        const messages = await fetchGroupMessages(targetGroup, deleteMessages || false, limit);

        res.json({
            success: true,
            count: messages.length,
            messages,
            groupName: targetGroup
        });
    } catch (error: any) {
        console.error('Error reading messages:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    } finally {
        isReading = false;
    }
});

app.get('/download-log', (req: Request, res: Response) => {
    const logPath = path.join(__dirname, 'GP_read_history.txt');

    if (fs.existsSync(logPath)) {
        res.download(logPath);
    } else {
        res.status(404).json({ error: 'Log file not found' });
    }
});

// Google Sheets configuration endpoints
app.post('/configure-sheets', async (req: Request, res: Response) => {
    try {
        const { credentialsPath, spreadsheetId, sheetName } = req.body;

        if (!credentialsPath || !spreadsheetId) {
            return res.status(400).json({ error: 'credentialsPath and spreadsheetId are required' });
        }

        const result = await initializeGoogleSheets(credentialsPath, spreadsheetId);

        if (result.success) {
            googleSheetsSpreadsheetId = spreadsheetId;
            googleSheetsSheetName = sheetName || 'WhatsApp Messages';

            // Ensure sheet exists with headers
            await ensureSheetExists(spreadsheetId, googleSheetsSheetName);

            res.json({
                success: true,
                message: 'Google Sheets configured successfully',
                spreadsheetId,
                sheetName: googleSheetsSheetName
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
    } catch (error: any) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/sheets-status', (req: Request, res: Response) => {
    const status = getGoogleSheetsStatus();
    res.json({
        ...status,
        spreadsheetId: googleSheetsSpreadsheetId,
        sheetName: googleSheetsSheetName
    });
});

// Start server
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Initialize Google Sheets from environment variables if configured
    const credentialsPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || 'WhatsApp Messages';

    if (credentialsPath && spreadsheetId) {
        console.log('🔧 Initializing Google Sheets from environment variables...');
        const result = await initializeGoogleSheets(credentialsPath, spreadsheetId);

        if (result.success) {
            googleSheetsSpreadsheetId = spreadsheetId;
            googleSheetsSheetName = sheetName;

            // Ensure sheet exists with headers
            await ensureSheetExists(spreadsheetId, sheetName);

            console.log(`✅ Google Sheets configured: Sheet "${sheetName}"`);
        } else {
            console.error(`❌ Failed to initialize Google Sheets: ${result.error}`);
        }
    } else {
        console.log('ℹ️  Google Sheets not configured (set GOOGLE_SHEETS_CREDENTIALS_PATH and GOOGLE_SHEETS_SPREADSHEET_ID in .env)');
    }

    initializeClient();
});
