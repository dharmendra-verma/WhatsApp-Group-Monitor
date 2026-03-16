import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { getIsReading, setIsReading, getCurrentGroupName, setCurrentGroupName, fetchGroupMessages } from '../services/whatsapp';
import { getLogFilePath } from '../utils/logger';

const router = Router();

router.post('/read-messages', async (req: Request, res: Response) => {
    if (getIsReading()) {
        return res.status(400).json({ error: 'Already reading messages' });
    }

    try {
        setIsReading(true);
        const { deleteMessages, groupName, messageLimit, sinceDate } = req.body;

        const targetGroup = groupName || getCurrentGroupName();
        const limit = Math.min(Math.max(parseInt(messageLimit) || 10, 1), 100);

        const since = sinceDate ? new Date(sinceDate) : undefined;
        if (since && isNaN(since.getTime())) {
            return res.status(400).json({ error: 'Invalid sinceDate format' });
        }

        if (groupName) {
            setCurrentGroupName(groupName);
            console.log('Updated current group to:', groupName);
        }

        const messages = await fetchGroupMessages(targetGroup, deleteMessages || false, limit, since);

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
        setIsReading(false);
    }
});

router.get('/download-log', (req: Request, res: Response) => {
    const logPath = getLogFilePath();

    if (fs.existsSync(logPath)) {
        res.download(logPath);
    } else {
        res.status(404).json({ error: 'Log file not found' });
    }
});

export default router;
