// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
// ❌ removed: import fetch from "node-fetch";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

// face-api (tfjs-node)
import * as faceapi from "@vladmandic/face-api";
import * as tf from "@tensorflow/tfjs-node"; // enable tfjs-node backend
import canvas from "canvas";
const { Canvas, Image, ImageData } = canvas;

// Make sure face-api has canvas + fetch in Node
faceapi.env.monkeyPatch({
    Canvas,
    Image,
    ImageData,
    fetch: (...args) => fetch(...args), // use Node's built-in fetch (Node >= 18)
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: true }));
const upload = multer({ storage: multer.memoryStorage() });

// ----------- 1) Models -----------
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
async function loadModels() {
    // ssdMobilenetv1 is robust; you can switch to tinyFaceDetector on low-memory plans
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
}

// ----------- 2) Celebrity reference set -----------
// Helper builds a stable Wikimedia URL that won’t 404 if the hash path changes.
function wm(fileName, width = 512) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}?width=${width}`;
}

const CELEBS = [
    { name: "Tom Cruise", url: wm("Tom_Cruise_by_Gage_Skidmore_2.jpg") },
    { name: "Angelina Jolie", url: wm("Angelina_Jolie_2_June_2014 (cropped).jpg") },
    { name: "Scarlett Johansson", url: wm("Scarlett_Johansson_in_Kuwait_01b-tweaked.jpg") },
    { name: "Keanu Reeves", url: wm("Keanu_Reeves_2019.jpg") },
    { name: "Dwayne Johnson", url: wm("Dwayne_Johnson_2014.jpg") },
    { name: "Emma Watson", url: wm("Emma_Watson_2013.jpg") },
    { name: "Chris Hemsworth", url: wm("Chris_Hemsworth_by_Gage_Skidmore_2.jpg") },
    { name: "Zendaya", url: wm("Zendaya_2018.png") },
    { name: "Robert Downey Jr.", url: wm("Robert_Downey_Jr_2014_Comic_Con (cropped).jpg") },
    { name: "Gal Gadot", url: wm("Gal_Gadot_by_Gage_Skidmore_2.jpg")  },
];

// Cache ref images on the ephemeral disk and precompute descriptors
const REF_DIR = path.join(__dirname, "ref_cache");

function safeName(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function ensureRefImages() {
    await fs.mkdir(REF_DIR, { recursive: true });
    for (const c of CELEBS) {
        const ext = ".jpg"; // Special:FilePath may drop extensions; just use .jpg
        const fn = safeName(c.name) + ext;
        const p = path.join(REF_DIR, fn);
        c.localPath = p;
        try {
            await fs.access(p); // already downloaded
        } catch {
            const res = await fetch(c.url, { redirect: "follow" });
            if (!res.ok) throw new Error(`Failed to fetch ${c.url} (${res.status})`);
            const buf = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(p, buf);
        }
    }
}

async function loadImageFromBuffer(buf) {
    return await canvas.loadImage(buf);
}
async function loadImageFromFile(p) {
    return await canvas.loadImage(p);
}

async function getDescriptorFromImage(img) {
    const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();
    if (!detection) return null;
    return detection.descriptor;
}

let gallery = []; // [{ name, imageUrl, descriptor }]

async function buildGallery() {
    const out = [];
    for (const c of CELEBS) {
        try {
            const img = await loadImageFromFile(c.localPath);
            const descriptor = await getDescriptorFromImage(img);
            if (descriptor) {
                out.push({
                    name: c.name,
                    imageUrl: c.url, // return public URL for preview
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

// Cosine similarity → 0–100 “confidence-like”
function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function similarityToConfidence(sim) {
    const pct = Math.max(0, Math.min(1, sim)) * 100;
    return Number(pct.toFixed(2));
}

// ----------- 3) Routes -----------
app.get("/", (_req, res) => {
    res.type("text/plain").send("API is up. POST /api/celebs  •  GET /health");
});

app.get("/health", (_req, res) => res.json({ ok: true, gallery: gallery.length }));

app.post("/api/celebs", upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "no_image" });

        const img = await loadImageFromBuffer(req.file.buffer);
        const descriptor = await getDescriptorFromImage(img);

        if (!descriptor) {
            // No face found; still return a fun pick
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

        // Find nearest celebrity
        let best = null;
        for (const g of gallery) {
            const sim = cosineSimilarity(descriptor, g.descriptor);
            if (!best || sim > best.sim) best = { ...g, sim };
        }

        const confidence = similarityToConfidence(best.sim);
        return res.json({
            celebrities: [{
                name: best.name,
                confidence,
                imageUrl: best.imageUrl,
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
    app.listen(PORT, () => console.log("Server on :" + PORT));
})();
