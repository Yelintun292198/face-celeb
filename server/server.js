// server/server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
    RekognitionClient,
    RecognizeCelebritiesCommand,
} from "@aws-sdk/client-rekognition";

dotenv.config(); // reads work11/.env

const app = express();
const upload = multer();
app.use(cors());

// __dirname helpers (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve ../public (one level up from /server)
const publicPath = path.resolve(__dirname, "../public");
app.use(express.static(publicPath));

// Env sanity logs
console.log("AWS_REGION:", process.env.AWS_REGION || "(missing)");
console.log("AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID ? "OK" : "(missing)");

// AWS client
const client = new RekognitionClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// API: POST /api/detect-celebs
app.post("/api/detect-celebs", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ detail: "No image uploaded" });

        const { mimetype, size } = req.file;
        console.log("Upload:", mimetype, size, "bytes");

        // Accept only JPEG/PNG, size 5KB–15MB
        if (!/^image\/(jpe?g|png)$/i.test(mimetype)) {
            return res.status(400).json({
                detail: "Only JPEG/PNG supported. Please upload a JPG/PNG (not HEIC/WEBP/GIF).",
            });
        }
        if (size < 5000) return res.status(400).json({ detail: "Image too small (<5KB)" });
        if (size > 15 * 1024 * 1024) {
            return res.status(400).json({ detail: "Image too large (>15MB)" });
        }

        const command = new RecognizeCelebritiesCommand({
            Image: { Bytes: req.file.buffer },
        });
        const data = await client.send(command);

        // Map to frontend format
        const candidates = (data.CelebrityFaces || []).map((c) => ({
            name: c.Name,
            confidence: c.MatchConfidence,
            gender: c.Gender?.Value,
            urls: c.Urls,
        }));

        const usedGender = (req.query.gender || "any").toString();
        const threshold = Number(req.query.threshold || 50);

        let filtered = candidates;
        if (usedGender !== "any") {
            filtered = filtered.filter(
                (x) => x.gender && x.gender.toLowerCase() === usedGender.toLowerCase()
            );
        }
        filtered = filtered.filter((x) => Number(x.confidence || 0) >= threshold);

        res.json({ candidates: filtered, usedGender, threshold });
    } catch (err) {
        console.error("Rekognition error:", err);
        if (
            String(err?.message || "").toLowerCase().includes("missing") ||
            String(err?.name || "").toLowerCase().includes("config")
        ) {
            return res.status(500).json({
                detail:
                    "AWS configuration problem. Check AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env",
            });
        }
        res.status(500).json({ detail: err.message || "Server error" });
    }
});

// SPA fallback → always serve index.html
app.get("*", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});

// Start
const PORT = process.env.PORT || 5177;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});
