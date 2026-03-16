import { Router, Request, Response } from 'express';
import { getStatus } from '../services/whatsapp';
import { getGoogleSheetsStatus, initializeGoogleSheets, ensureSheetExists } from '../services/googleSheets';
import { setGoogleSheetsConfig, getGoogleSheetsConfig } from '../services/whatsapp';

const router = Router();

router.get('/status', (req: Request, res: Response) => {
    res.json(getStatus());
});

router.post('/configure-sheets', async (req: Request, res: Response) => {
    try {
        const { credentialsPath, spreadsheetId, sheetName } = req.body;

        if (!credentialsPath || !spreadsheetId) {
            return res.status(400).json({ error: 'credentialsPath and spreadsheetId are required' });
        }

        const result = await initializeGoogleSheets(credentialsPath, spreadsheetId);

        if (result.success) {
            const finalSheetName = sheetName || 'WhatsApp Messages';
            setGoogleSheetsConfig(spreadsheetId, finalSheetName);

            await ensureSheetExists(spreadsheetId, finalSheetName);

            res.json({
                success: true,
                message: 'Google Sheets configured successfully',
                spreadsheetId,
                sheetName: finalSheetName
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

router.get('/sheets-status', (req: Request, res: Response) => {
    const status = getGoogleSheetsStatus();
    const config = getGoogleSheetsConfig();
    res.json({
        ...status,
        spreadsheetId: config.spreadsheetId,
        sheetName: config.sheetName
    });
});

export default router;
