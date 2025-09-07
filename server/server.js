// server/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { RekognitionClient, RecognizeCelebritiesCommand } from '@aws-sdk/client-rekognition';

const app = express();
app.use(cors()); // during dev allow all origins; you can restrict later

// accept up to 5MB images
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

const rekognition = new RekognitionClient({
    region: process.env.AWS_REGION
});

// health check for your frontend
app.get('/health', (_, res) => res.send('ok'));

// main endpoint
app.post('/api/celebs', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

        const cmd = new RecognizeCelebritiesCommand({
            Image: { Bytes: req.file.buffer }
        });

        const out = await rekognition.send(cmd);

        const celebs = (out.CelebrityFaces || [])
            .sort((a, b) => (b.MatchConfidence || 0) - (a.MatchConfidence || 0))
            .slice(0, 3)
            .map(c => ({
                name: c.Name,
                confidence: c.MatchConfidence,
                urls: c.Urls || []
            }));

        res.json({
            celebrities: celebs,
            unrecognizedCount: (out.UnrecognizedFaces || []).length
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

const port = process.env.PORT || 5177;
app.listen(port, () => {
    console.log(`API running on http://localhost:${port}`);
});
