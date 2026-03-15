import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import * as fs from 'fs';

console.log('Initializing WhatsApp Client...');

// Function to append message to file
const appendToLog = (text: string) => {
    console.log('Writing message to file:' + text);
    fs.appendFileSync('GP_read_history.txt', text + '\n');
};

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

client.on('qr', (qr: string) => {
    console.log('QR RECEIVED. Scan this with your WhatsApp app:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');

    // Check if the specific group exists
    client.getChats().then(async chats => {
        // Corrected group name based on your output: "GP read" (lowercase 'r')
        const targetGroup = chats.find(chat => chat.isGroup && chat.name === 'GP read');

        if (targetGroup) {
            console.log("✅ Connected to group: 'GP read'");

            // Fetch the last 10 messages
            try {
                const messages = await targetGroup.fetchMessages({ limit: 10 });
                console.log('\n--- Last 10 Messages ---');

                const header = `\n--- Session Start: ${new Date().toLocaleString()} ---`;
                appendToLog(header);

                for (const msg of messages) {
                    const contact = await msg.getContact();
                    const logMsg = `[${new Date(msg.timestamp * 1000).toLocaleString()}] ${contact.pushname || contact.number}: ${msg.body}`;
                    console.log(logMsg);
                    appendToLog(logMsg);

                    // Delete the message from the chat after archiving
                    try {
                        // Check if message is from me
                        if (msg.fromMe) {
                            await msg.delete(true);
                            console.log('🗑️  Message deleted (for everyone)');
                        } else {
                            await msg.delete(true);
                            console.log('🗑️  Message deleted');
                        }
                    } catch (deleteErr) {
                        console.error(`❌ Failed to delete message from ${msg.from}:`, deleteErr);

                        // Fallback
                        try {
                            await msg.delete();
                            console.log('🗑️  Message deleted (for me only - fallback)');
                        } catch (fallbackErr) {
                            console.error('❌ Fallback delete also failed.');
                        }
                    }
                }
                console.log('--- End of History ---\n');
            } catch (err) {
                console.error("Error fetching history:", err);
            }

        } else {
            console.log("⚠️  WARNING: Group 'GP read' not found. Please check the name exactly.");
            console.log('Available groups:');
            chats.filter(c => c.isGroup).forEach(g => console.log(`- ${g.name}`));
        }
    }).catch(err => {
        console.error('Error fetching chats:', err);
    });
});

client.on('message', async (msg: Message) => {
    try {
        const chat = await msg.getChat();

        // Only log messages from the specific group
        if (chat.isGroup && chat.name === 'GP read') {
            const contact = await msg.getContact();
            const logMsg = `[${new Date(msg.timestamp * 1000).toLocaleString()}] ${contact.pushname || contact.number}: ${msg.body}`;
            console.log(logMsg);
            appendToLog(logMsg);

            // Delete the message from the chat after archiving
            try {
                // Check if message is from me (required for delete-for-everyone usually, unless admin)
                if (msg.fromMe) {
                    await msg.delete(true);
                    console.log('🗑️  Message deleted (for everyone)');
                } else {
                    // If not from me, we can't delete-for-everyone unless admin, and libraries struggle with this.
                    // We will try deleting "for me" if "for everyone" is not applicable.
                    await msg.delete(true); // Attempt strict delete first
                    console.log('🗑️  Message deleted');
                }
            } catch (deleteErr) {
                console.error(`❌ Failed to delete message from ${msg.from}:`);
                console.error(deleteErr);

                // Fallback: Try deleting just for me if the above failed
                try {
                    await msg.delete();
                    console.log('🗑️  Message deleted (for me only - fallback)');
                } catch (fallbackErr) {
                    console.error('❌ Fallback delete also failed.');
                }
            }
        }
    } catch (err) {
        console.error('Error processing message:', err);
    }
});

client.on('auth_failure', (msg: string) => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.initialize();
