/* =========================
 * Config
 * ========================= */

// If you have a backend, set it here. We’ll try the server first,
// then fall back to the local celeb gallery.
const API_BASE = "https://face-celeb.onrender.com"; // e.g., "https://your-app.onrender.com"

// Face-API models
const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
const TINY_OPTS = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });

/* =========================
 * DOM + state
 * ========================= */
const videoEl = document.getElementById("cam");
const overlay = document.getElementById("overlay");
const statusEl = document.getElementById("status");
const celebsEl = document.getElementById("celebs");
const btnCeleb = document.getElementById("btnCeleb");
const filePick = document.getElementById("filePick");
const mirrorChk = document.getElementById("mirrorToggle");

// hidden snapshot canvas (never mirrored to server)
const cap = document.createElement("canvas");
const capCtx = cap.getContext("2d", { willReadFrequently: true });

// overlay state
let overlayImg = null;    // HTMLImageElement
let overlayName = null;

/* =========================
 * URL helpers & CORS-safe loader
 * ========================= */

// Stable Wikimedia redirect link for the exact file title
function wm(fileName, width = 512) {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}?width=${width}`;
}

// For non-Wikimedia hosts, use a proxy. Wikimedia already sends CORS.
function corsSafe(url) {
    try {
        const u = new URL(url);
        if (u.host.endsWith("wikimedia.org") || u.host.endsWith("wikipedia.org")) return url;
        return `https://images.weserv.nl/?url=${u.host}${u.pathname}${u.search || ""}`;
    } catch {
        return `https://images.weserv.nl/?url=${encodeURIComponent(url)}`;
    }
}

// Try direct, then proxy
async function loadRemoteImage(url) {
    const direct = await tryLoad(url);
    if (direct) return direct;
    const viaProxy = await tryLoad(corsSafe(url));
    if (viaProxy) return viaProxy;
    throw new Error("Image failed via direct & proxy: " + url);

    function tryLoad(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.referrerPolicy = "no-referrer";
            img.decoding = "async";
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }
}

/* =========================
 * Client celeb gallery (real photos via Special:FilePath)
 * ========================= */

const CELEB_GALLERY = [
    { name: "Tom Cruise", url: wm("Tom_Cruise_by_Gage_Skidmore_2.jpg") },
    { name: "Angelina Jolie", url: wm("Angelina_Jolie_2_June_2014 (cropped).jpg") },
    { name: "Scarlett Johansson", url: wm("Scarlett_Johansson_in_Kuwait_01b-tweaked.jpg") },
    { name: "Keanu Reeves", url: wm("Keanu_Reeves_2019.jpg") },
    { name: "Dwayne Johnson", url: wm("Dwayne_Johnson_2014.jpg") },
    { name: "Emma Watson", url: wm("Emma_Watson_2013.jpg") },
    { name: "Rihanna", url: wm("Rihanna_2018.jpg") }, // alternate stable file
    { name: "Chris Hemsworth", url: wm("Chris_Hemsworth_by_Gage_Skidmore_2.jpg") },
    { name: "Zendaya", url: wm("Zendaya_2018.png") },
    { name: "Robert Downey Jr.", url: wm("Robert_Downey_Jr_2014_Comic_Con (cropped).jpg") },
    { name: "Gal Gadot", url: wm("Gal_Gadot_by_Gage_Skidmore_2.jpg") },
    { name: "Will Smith", url: wm("Will_Smith_2019_by_Glenn_Francis.jpg") },
    { name: "Brad Pitt", url: wm("Brad_Pitt_2019_by_Glenn_Francis.jpg") },
    { name: "Leonardo DiCaprio", url: wm("Leonardo_DiCaprio_2014.jpg") },
    { name: "Jennifer Lawrence", url: wm("Jennifer_Lawrence_at_the_83rd_Academy_Awards.jpg") },
    { name: "Margot Robbie", url: wm("Margot_Robbie_2019_by_Glenn_Francis.jpg") },
    { name: "Idris Elba", url: wm("Idris_Elba-4581 (cropped).jpg") },
    { name: "Ariana Grande", url: wm("Ariana_Grande_2019.jpg") },
];

let gallery = []; // [{ name, url, safeUrl, img, descriptor }]

/* =========================
 * Init
 * ========================= */
(async () => {
    await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL), // embeddings
    ]);

    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    videoEl.srcObject = stream; await videoEl.play();

    videoEl.addEventListener("loadedmetadata", () => {
        overlay.width = videoEl.videoWidth;
        overlay.height = videoEl.videoHeight;
    }, { once: true });

    // Build gallery in background
    prepareGallery().catch(console.warn);

    // UI
    mirrorChk.addEventListener("change", () => {
        const m = mirrorChk.checked ? "add" : "remove";
        videoEl.classList[m]("mirrored");
        overlay.classList[m]("mirrored");
    });
    btnCeleb.addEventListener("click", fromWebcam);
    filePick.addEventListener("change", fromFile);

    statusEl.textContent = "Ready.";
    requestAnimationFrame(loop);
})();

/* =========================
 * Render loop
 * ========================= */
async function loop() {
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const det = await faceapi
        .detectSingleFace(videoEl, TINY_OPTS)
        .withFaceLandmarks()
        .withFaceExpressions();

    if (det) {
        const b = det.detection.box;
        ctx.save(); ctx.strokeStyle = "rgba(0,176,255,.9)"; ctx.lineWidth = 2;
        ctx.strokeRect(b.x, b.y, b.width, b.height); ctx.restore();

        if (overlayImg) drawOverlay(ctx, det);
    }
    requestAnimationFrame(loop);
}

function drawOverlay(ctx, det) {
    if (!overlayImg) return;
    const box = det.detection.box;
    const left = det.landmarks.getLeftEye();
    const right = det.landmarks.getRightEye();
    let angle = 0;
    if (left.length && right.length) {
        const l = left.reduce((a, p) => p.x < a.x ? p : a, left[0]);
        const r = right.reduce((a, p) => p.x > a.x ? p : a, right[0]);
        angle = Math.atan2(r.y - l.y, r.x - l.x);
    }
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const w = box.width * 1.35, h = w * (overlayImg.naturalHeight / overlayImg.naturalWidth);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle); ctx.globalAlpha = .95;
    ctx.drawImage(overlayImg, -w / 2, -h / 2, w, h); ctx.restore();

    if (overlayName) {
        ctx.save();
        ctx.font = "600 14px system-ui"; const label = overlayName;
        const mw = ctx.measureText(label).width + 12;
        ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(box.x, box.y - 24, mw, 20);
        ctx.fillStyle = "#fff"; ctx.fillText(label, box.x + 6, box.y - 9); ctx.restore();
    }
}

/* =========================
 * Controls
 * ========================= */
function playShutter() { const a = document.getElementById("shutter"); try { a.currentTime = 0; a.play(); } catch { } }
function flash() { const c = overlay.getContext("2d"); c.save(); c.globalAlpha = .25; c.fillStyle = "#fff"; c.fillRect(0, 0, overlay.width, overlay.height); c.restore(); }

async function snapshot() {
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    cap.width = w; cap.height = h;
    capCtx.setTransform(1, 0, 0, 1, 0, 0); // never mirror to server
    capCtx.drawImage(videoEl, 0, 0, w, h);
    return new Promise(r => cap.toBlob(r, "image/jpeg", .92));
}

async function fromWebcam() {
    playShutter(); flash();

    // Try server first
    try {
        if (!API_BASE) throw new Error("API_BASE empty (using local gallery)");
        const blob = await snapshot();
        const fd = new FormData(); fd.append("image", blob, "frame.jpg");

        statusEl.textContent = "Checking (server)…";
        let res;
        try { res = await fetch(`${API_BASE}/api/celebs`, { method: "POST", body: fd, mode: "cors" }); }
        catch (netErr) { throw new Error(`Network/CORS error: ${netErr.message}`); }

        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${res.statusText} — ${txt.slice(0, 200)}`);
        }
        let json;
        try { json = await res.json(); }
        catch { const txt = await res.text().catch(() => ""); throw new Error(`Non-JSON response: ${txt.slice(0, 200)}`); }

        const choice = pickFromServer(json);
        if (choice) { await showChoice(choice); statusEl.textContent = "Done."; return; }
        celebsEl.innerHTML = `<div>No candidates from server (empty list).</div>`;
    } catch (e) {
        celebsEl.innerHTML = `
      <div style="color:#fca5a5;font-weight:700">Server step failed</div>
      <pre class="err">${escapeHtml(e.message)}</pre>
    `;
    }

    // Fallback: local gallery (always returns 1)
    statusEl.textContent = "Checking (local gallery)…";
    const choice2 = await clientTop1FromCanvas(cap);
    await showChoice(choice2);
    statusEl.textContent = "Done.";
}

async function fromFile(e) {
    const f = e.target.files?.[0]; if (!f) return;
    const img = await fileToImage(f);
    cap.width = img.naturalWidth; cap.height = img.naturalHeight;
    capCtx.drawImage(img, 0, 0);
    playShutter(); flash();

    try {
        if (!API_BASE) throw new Error("API_BASE empty (using local gallery)");
        const blob = await new Promise(r => cap.toBlob(r, "image/jpeg", .92));
        const fd = new FormData(); fd.append("image", blob, f.name || "image.jpg");

        statusEl.textContent = "Checking (server)…";
        let res;
        try { res = await fetch(`${API_BASE}/api/celebs`, { method: "POST", body: fd, mode: "cors" }); }
        catch (netErr) { throw new Error(`Network/CORS error: ${netErr.message}`); }

        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${res.statusText} — ${txt.slice(0, 200)}`);
        }
        let json;
        try { json = await res.json(); }
        catch { const txt = await res.text().catch(() => ""); throw new Error(`Non-JSON response: ${txt.slice(0, 200)}`); }

        const choice = pickFromServer(json);
        if (choice) { await showChoice(choice); statusEl.textContent = "Done."; filePick.value = ""; return; }
        celebsEl.innerHTML = `<div>No candidates from server (empty list).</div>`;
    } catch (e) {
        celebsEl.innerHTML = `
      <div style="color:#fca5a5;font-weight:700">Server step failed</div>
      <pre class="err">${escapeHtml(e.message)}</pre>
    `;
    }

    statusEl.textContent = "Checking (local gallery)…";
    const choice2 = await clientTop1FromCanvas(cap);
    await showChoice(choice2);
    statusEl.textContent = "Done."; filePick.value = "";
}

function fileToImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file); const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = reject; img.crossOrigin = "anonymous"; img.src = url;
    });
}

/* =========================
 * Server parsing
 * ========================= */
function pickFromServer(json) {
    try {
        if (Array.isArray(json?.celebrities) && json.celebrities.length) {
            const top = json.celebrities
                .map(c => ({
                    name: c.name || c.title || "Unknown",
                    confidence: Number(c.confidence ?? c.score ?? 0) || 0,
                    imageUrl: c.imageUrl || c.image_url || c.url || c.photo || null,
                }))
                .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
            if (!top) return null;
            // Accept even tiny confidence
            return { name: top.name, confidence: top.confidence, imageUrl: top.imageUrl ? corsSafe(top.imageUrl) : null, source: "server" };
        }
        if (Array.isArray(json?.matches) && json.matches.length) {
            const top = json.matches
                .map(m => ({
                    name: m.name || m.title || "Unknown",
                    confidence: Number(m.confidence ?? m.similarity ?? m.score ?? 0) || 0,
                    imageUrl: m.imageUrl || m.image_url || m.url || m.photo || null,
                }))
                .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
            if (!top) return null;
            return { name: top.name, confidence: top.confidence, imageUrl: top.imageUrl ? corsSafe(top.imageUrl) : null, source: "server" };
        }
        return null;
    } catch (e) { console.error(e); return null; }
}

/* =========================
 * Local gallery building & matching
 * ========================= */
async function prepareGallery() {
    if (gallery.length) return gallery;
    console.log("[gallery] preparing…");

    const tasks = CELEB_GALLERY.map(async (c) => {
        try {
            // Load via Wikimedia directly; fallback proxy happens inside loader
            const img = await loadRemoteImage(c.url);
            const det = await faceapi
                .detectSingleFace(img, TINY_OPTS)
                .withFaceLandmarks()
                .withFaceDescriptor();
            if (det?.descriptor) {
                gallery.push({ name: c.name, url: c.url, safeUrl: c.url, img, descriptor: det.descriptor });
                console.log("[gallery] ok:", c.name);
            } else {
                console.warn("[gallery] no face in:", c.name);
            }
        } catch (e) {
            console.warn("[gallery] load failed:", c.name, e.message);
        }
    });

    await Promise.allSettled(tasks);
    console.log(`[gallery] ready: ${gallery.length}/${CELEB_GALLERY.length}`);
    return gallery;
}

function pickRandomFromGallery(tag = "client-gallery(random)") {
    const base = gallery.length ? gallery : CELEB_GALLERY.map(c => ({ name: c.name, url: c.url }));
    const r = base[Math.floor(Math.random() * base.length)];
    const imageUrl = r.safeUrl ? r.safeUrl : corsSafe(r.url);
    return { name: r.name, confidence: 0, imageUrl, source: tag };
}

async function clientTop1FromCanvas(canv) {
    if (!gallery.length) await prepareGallery();
    if (!gallery.length) return pickRandomFromGallery("client-gallery(random-empty)");

    const det = await faceapi
        .detectSingleFace(canv, TINY_OPTS)
        .withFaceLandmarks()
        .withFaceDescriptor();

    if (!det?.descriptor) return pickRandomFromGallery("client-gallery(random-no-face)");

    const userDesc = det.descriptor;
    let best = null;
    for (const g of gallery) {
        if (!g.descriptor) continue;
        const d = euclidean(userDesc, g.descriptor);
        if (!best || d < best.d) best = { g, d };
    }
    if (!best) return pickRandomFromGallery("client-gallery(random-fallback)");

    const conf = Math.max(0, 100 - (best.d * 160)); // playful scale
    return { name: best.g.name, confidence: Number(conf.toFixed(2)), imageUrl: best.g.safeUrl || corsSafe(best.g.url), source: "client-gallery" };
}

function euclidean(a, b) {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    const n = Math.min(a.length || 0, b.length || 0);
    if (!n) return Number.POSITIVE_INFINITY;
    let s = 0; for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
}

/* =========================
 * Show result (panel + overlay)
 * ========================= */
async function showChoice(choice) {
    if (!choice) { celebsEl.innerHTML = `<div>No candidates.</div>`; overlayImg = null; overlayName = null; return; }

    const safe = choice.imageUrl || ""; // Wikimedia direct is already CORS-ok
    const conf = choice.confidence?.toFixed ? choice.confidence.toFixed(2) : String(choice.confidence || 0);
    const badge = choice.source === "server" ? "Server match" : "Local gallery match";

    celebsEl.innerHTML = `
    <div style="display:flex; gap:20px; align-items:center;">
      <img src="${safe}" alt="${choice.name}" referrerpolicy="no-referrer"
           style="width:220px;height:220px;object-fit:cover;border-radius:18px;
                  border:2px solid #1f2937; box-shadow:0 8px 20px rgba(0,0,0,.25);" />
      <div>
        <div style="font-weight:800; font-size:22px">${choice.name}</div>
        <div style="opacity:.85">${badge} • Confidence: ${conf}%</div>
        <div class="small" style="margin-top:8px;opacity:.7">Image: <a href="${safe}" target="_blank" rel="noreferrer">open</a></div>
      </div>
    </div>
  `;

    overlayName = choice.name || null;
    overlayImg = await loadRemoteImage(safe).catch((err) => {
        console.warn("overlay image failed:", err.message);
        return null;
    });
}

/* =========================
 * Utils
 * ========================= */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m])) }
