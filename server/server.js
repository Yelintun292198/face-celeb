// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

// face-api (tfjs-node)
import * as faceapi from "@vladmandic/face-api";
import * as tf from "@tensorflow/tfjs-node"; // IMPORTANT: enable tfjs-node backend
import canvas from "canvas";
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: true }));
const upload = multer({ storage: multer.memoryStorage() });

// ----------- 1) Models -----------
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
async function loadModels() {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);     // robust detector
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL); // embeddings
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
}

// ----------- 2) Celebrity reference set -----------
const CELEBS = [
    { name: "Tom Cruise", url: "https://upload.wikimedia.org/wikipedia/commons/8/8f/Tom_Cruise_by_Gage_Skidmore_2.jpg" },
    { name: "Angelina Jolie", url: "https://upload.wikimedia.org/wikipedia/commons/1/1b/Angelina_Jolie_2_June_2014_%28cropped%29.jpg" },
    { name: "Scarlett Johansson", url: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Scarlett_Johansson_in_Kuwait_01b-tweaked.jpg" },
    { name: "Keanu Reeves", url: "https://upload.wikimedia.org/wikipedia/commons/1/1d/Keanu_Reeves_2019.jpg" },
    { name: "Dwayne Johnson", url: "https://upload.wikimedia.org/wikipedia/commons/2/2f/Dwayne_Johnson_2014.jpg" },
    { name: "Emma Watson", url: "https://upload.wikimedia.org/wikipedia/commons/9/90/Emma_Watson_2013.jpg" },
    { name: "Rihanna", url: "https://upload.wikimedia.org/wikipedia/commons/5/5e/Rihanna_standing.jpg" },
    { name: "Chris Hemsworth", url: "https://upload.wikimedia.org/wikipedia/commons/7/78/Chris_Hemsworth_by_Gage_Skidmore_2.jpg" },
    { name: "Zendaya", url: "https://upload.wikimedia.org/wikipedia/commons/4/41/Zendaya_2018.png" },
    { name: "Robert Downey Jr.", url: "https://upload.wikimedia.org/wikipedia/commons/1/1e/Robert_Downey_Jr_2014_Comic_Con_%28cropped%29.jpg" },
    { name: "Gal Gadot", url: "https://upload.wikimedia.org/wikipedia/commons/2/21/Gal_Gadot_by_Gage_Skidmore_2.jpg" },
    { name: "Will Smith", url: "https://upload.wikimedia.org/wikipedia/commons/1/1f/Will_Smith_2019_by_Glenn_Francis.jpg" },
];

// Download images to disk and precompute descriptors
const REF_DIR = path.join(__dirname, "ref_cache");
async function ensureRefImages() {
    await fs.mkdir(REF_DIR, { recursive: true });
    for (const c of CELEBS) {
        const fn = safeName(c.name) + path.extname(new URL(c.url).pathname || ".jpg");
        const p = path.join(REF_DIR, fn);
        c.localPath = p;
        try {
            await fs.access(p);
        } catch {
            const res = await fetch(c.url);
            if (!res.ok) throw new Error(`Failed to fetch ${c.url}`);
            const buf = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(p, buf);
        }
    }
}

function safeName(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function loadImageFromBuffer(buf) {
    return await canvas.loadImage(buf);
}
async function loadImageFromFile(p) {
    return await canvas.loadImage(p);
}

async function getDescriptorFromImage(img) {
    // detect + compute descriptor (returns 128-d vector)
    const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();
    if (!detection) return null;
    return detection.descriptor;
}

let gallery = []; // [{ name, imageUrl, descriptor(Float32Array) }]

async function buildGallery() {
    const out = [];
    for (const c of CELEBS) {
        try {
            const img = await loadImageFromFile(c.localPath);
            const descriptor = await getDescriptorFromImage(img);
            if (descriptor) {
                out.push({
                    name: c.name,
                    imageUrl: c.url, // return public URL as the preview
                    descriptor,
                });
            } else {
                console.warn("No face found in ref:", c.name);
            }
        } catch (e) {
            console.warn("Failed ref:", c.name, e.message);
        }
    }
    gallery = out;
    if (!gallery.length) throw new Error("Gallery is empty (no reference descriptors).");
}

// Cosine similarity to “confidence-like” score (0–100)
function similarityToConfidence(sim) {
    // sim ~ cosine similarity in [0..1]; scale to %
    const pct = Math.max(0, Math.min(1, sim)) * 100;
    return Number(pct.toFixed(2));
}

function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ----------- 3) Routes -----------
app.get("/health", (req, res) => res.json({ ok: true, gallery: gallery.length }));

app.post("/api/celebs", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No image" });

        const img = await loadImageFromBuffer(req.file.buffer);
        const descriptor = await getDescriptorFromImage(img);

        if (!descriptor) {
            // No face found; still return a (deterministic) “closest” celeb by random choice
            const pick = CELEBS[Math.floor(Math.random() * CELEBS.length)];
            return res.json({
                celebrities: [{
                    name: pick.name,
                    confidence: 0.0,
                    imageUrl: pick.url,
                    note: "No face detected; random fun pick."
                }]
            });
        }

        // Find nearest celebrity in gallery
        let best = null;
        for (const g of gallery) {
            const sim = cosineSimilarity(descriptor, g.descriptor);
            if (!best || sim > best.sim) {
                best = { ...g, sim };
            }
        }

        const confidence = similarityToConfidence(best.sim);

        return res.json({
            celebrities: [{
                name: best.name,
                confidence,
                imageUrl: best.imageUrl
            }]
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "server_error", message: e.message });
    }
});

// ----------- 4) Bootstrap -----------
const PORT = process.env.PORT || 3000;

(async () => {
    await loadModels();
    await ensureRefImages();
    await buildGallery();
    app.listen(PORT, () => console.log("Server on http://localhost:" + PORT));
})();
