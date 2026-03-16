import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import { appendToLog } from '../utils/logger';
import { appendBatchToSheet } from './googleSheets';

let client: Client | null = null;
let qrCodeData: string | null = null;
let isAuthenticated = false;
let isReading = false;
let currentGroupName = 'GP read';
let availableGroups: string[] = [];
let cachedChats: any[] = [];

// Google Sheets config (set externally via configure functions)
let googleSheetsSpreadsheetId = '';
let googleSheetsSheetName = 'WhatsApp Messages';

export const setGoogleSheetsConfig = (spreadsheetId: string, sheetName: string) => {
    googleSheetsSpreadsheetId = spreadsheetId;
    googleSheetsSheetName = sheetName;
};

export const getGoogleSheetsConfig = () => ({
    spreadsheetId: googleSheetsSpreadsheetId,
    sheetName: googleSheetsSheetName,
});

export const getStatus = () => ({
    authenticated: isAuthenticated,
    qrCode: qrCodeData,
    reading: isReading,
    currentGroupName,
    availableGroups,
});

export const getIsReading = () => isReading;
export const setIsReading = (value: boolean) => { isReading = value; };
export const getCurrentGroupName = () => currentGroupName;
export const setCurrentGroupName = (name: string) => { currentGroupName = name; };

export const initializeClient = () => {
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
                '--disable-gpu'
            ],
            protocolTimeout: 300000
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

        console.log('Waiting 10s for WhatsApp to sync...');
        await new Promise(resolve => setTimeout(resolve, 10000));

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

    client.initialize().catch((err) => {
        console.error('❌ Failed to initialize WhatsApp client:', err.message);
        console.log('Server will stay running. Fix the issue and restart.');
        client = null;
    });
};

const BATCH_SIZE = 5;

export const fetchGroupMessages = async (
    groupName: string,
    shouldDelete: boolean = false,
    messageLimit: number = 10,
    sinceDate?: Date
) => {
    console.log('=== fetchGroupMessages START ===');
    console.log('Group name:', groupName);
    console.log('Message limit:', messageLimit);
    console.log('Should delete:', shouldDelete);

    if (!client || !isAuthenticated) {
        throw new Error('WhatsApp client is not authenticated');
    }

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
    if (sinceDate) {
        console.log('Filtering messages since:', sinceDate.toISOString());
    }
    const messages = await targetGroup.fetchMessages({ limit: messageLimit });
    console.log('Messages fetched:', messages.length);

    const filteredMessages = sinceDate
        ? messages.filter((msg: any) => new Date(msg.timestamp * 1000) >= sinceDate)
        : messages;
    console.log('Messages after date filter:', filteredMessages.length);

    const result = [];

    const header = `\n--- Session Start: ${new Date().toLocaleString()} ---`;
    appendToLog(header);

    for (let i = 0; i < filteredMessages.length; i += BATCH_SIZE) {
        const batch = filteredMessages.slice(i, i + BATCH_SIZE);
        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} messages)...`);

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

        if (googleSheetsSpreadsheetId && sheetRows.length > 0) {
            await appendBatchToSheet(googleSheetsSpreadsheetId, googleSheetsSheetName, sheetRows);
        }

        console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} complete.`);
    }

    console.log('=== fetchGroupMessages END ===');
    console.log('Returning', result.length, 'messages');
    return result;
};
