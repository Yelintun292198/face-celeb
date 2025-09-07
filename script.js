// ---- DOM refs ----
const video = document.getElementById('cam');
const canvas = document.getElementById('overlay');
const statusEl = document.getElementById('status');

let stream = null;
let detectTimer = null;

// ---- Helpers ----
function setStatus(msg, color = 'green') {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color;
}

function getTopExpression(expressions) {
    // expressions: { happy:0.82, neutral:0.10, ... }
    let top = 'unknown';
    let prob = 0;
    for (const [k, v] of Object.entries(expressions || {})) {
        if (v > prob) { prob = v; top = k; }
    }
    return { top, prob };
}

// ---- Core flow ----
async function loadModels() {
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';
    setStatus('Loading models... Please wait', 'blue');

    await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);

    setStatus('Models loaded. Starting camera...', 'green');
}


async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = stream;

        // Wait for video to have dimensions
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth || 640;
                canvas.height = video.videoHeight || 480;
                resolve();
            };
        });
    } catch (err) {
        setStatus(`Camera error: ${err.message}`, 'red');
        throw err;
    }
}

function drawBoxAndLabel(ctx, box, label) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#00FF88';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = '16px Arial';

    // Rectangle
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    // Label background
    const pad = 4;
    const textWidth = ctx.measureText(label).width;
    const textHeight = 16;
    ctx.fillRect(box.x - 1, box.y - textHeight - pad * 2, textWidth + pad * 2, textHeight + pad * 2);

    // Label text
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(label, box.x + pad, box.y - pad);
}

async function startDetectionLoop() {
    const ctx = canvas.getContext('2d');

    const detectorOpts = new faceapi.TinyFaceDetectorOptions({
        inputSize: 320,      // 160/224/320/416/512
        scoreThreshold: 0.5
    });

    setStatus('Camera running. Detecting...', 'green');

    // ~4 FPS detection is enough for demo
    detectTimer = setInterval(async () => {
        if (video.readyState < 2) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const results = await faceapi
            .detectAllFaces(video, detectorOpts)
            .withFaceLandmarks()
            .withFaceExpressions();

        if (!results.length) {
            setStatus('No face detected', 'orange');
            return;
        }
        setStatus('Detecting...', 'green');

        for (const r of results) {
            const { box } = r.detection;
            const { top, prob } = getTopExpression(r.expressions);
            const confidence = (prob * 100).toFixed(0);
            const label = prob >= 0.6 ? `${top} (${confidence}%)` : `unknown (${confidence}%)`;
            drawBoxAndLabel(ctx, box, label);
        }
    }, 250);
}

function stopEverything() {
    if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

// ---- Boot ----
(async function main() {
    try {
        await loadModels();
        await startCamera();
        await startDetectionLoop();
    } catch (e) {
        setStatus(`Error: ${e.message}`, 'red');
        console.error(e);
    }
})();

window.addEventListener('beforeunload', stopEverything);
