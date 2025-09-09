// public/script.js
const video = document.getElementById('video');
const toggleCam = document.getElementById('toggleCam');
const snap = document.getElementById('snap');
const fileInput = document.getElementById('fileInput');
const sendFile = document.getElementById('sendFile');
const preview = document.getElementById('preview');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const genderSel = document.getElementById('gender');
const thresholdRange = document.getElementById('threshold');
const thVal = document.getElementById('thVal');

let stream = null;

// If you ever open the page via Live Server (5500), hard-point the API to 5177:
const API_BASE = window.location.origin;


thresholdRange.addEventListener('input', () => thVal.textContent = thresholdRange.value);

// ===== Camera ON/OFF =====
async function startCamera() {
    if (stream) return;
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    video.srcObject = stream;
    // Wait until metadata is ready so videoWidth/videoHeight are set
    await new Promise((resolve) => {
        if (video.readyState >= 1) return resolve();
        video.onloadedmetadata = () => resolve();
    });
    toggleCam.textContent = '🛑 カメラ停止';
    statusEl.textContent = 'カメラ起動中…';
}
function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    toggleCam.textContent = '📷 カメラ開始';
    statusEl.textContent = 'カメラ停止中';
}
toggleCam.addEventListener('click', async () => {
    try {
        if (stream) stopCamera(); else await startCamera();
    } catch (e) {
        console.error(e);
        statusEl.textContent = 'カメラにアクセスできません（権限を許可してください）';
    }
});

// ===== Helpers =====
function mirroredJPEGFromVideo(el) {
    const w = el.videoWidth || 640;
    const h = el.videoHeight || 480;
    if (!w || !h) return null; // camera not ready yet
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(el, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.92);
}

async function postImage(formData, opts) {
    const query = new URLSearchParams(opts).toString();
    const res = await fetch(`${API_BASE}/api/detect-celebs?${query}`, {
        method: "POST",
        body: formData,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `Server error: ${res.status}`);
    return body;
}

function setBusy(msg = '判定中…') {
    statusEl.innerHTML = `<span class="loader"></span>${msg}`;
    snap.disabled = true; sendFile.disabled = true; toggleCam.disabled = true;
}
function clearBusy(msg = '完了') {
    statusEl.textContent = msg;
    snap.disabled = false; sendFile.disabled = false; toggleCam.disabled = false;
}
///
// Get a small portrait from Wikipedia by page title (name)
async function fetchThumbFromWikipediaName(name) {
    try {
        // REST summary returns a nice thumbnail if page exists
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return data?.thumbnail?.source || null;
    } catch { return null; }
}

// Extract QID like "Q317521" from a URL or string
function extractQid(str = "") {
    const m = String(str).match(/Q\d+/i);
    return m ? m[0] : null;
}

// From a Wikidata QID, fetch P18 (image filename), then build a Commons thumb URL
async function fetchThumbFromWikidata(qid) {
    try {
        const api = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
        const res = await fetch(api);
        if (!res.ok) return null;
        const data = await res.json();
        const entity = data?.entities?.[qid];
        const p18 = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value; // filename like "Cristiano Ronaldo 2018.jpg"
        if (!p18) return null;
        // Redirecting file path gives an actual image; width=160 is small thumbnail
        return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(p18)}?width=160`;
    } catch { return null; }
}

// Decide best thumbnail for a candidate:
// 1) Try Wikipedia by name
// 2) Try Wikidata P18 if any c.urls contains a QID
async function pickCandidateThumb(candidate) {
    // Try by name first
    const byName = await fetchThumbFromWikipediaName(candidate.name);
    if (byName) return byName;

    // Try Wikidata if available
    const qid =
        extractQid((candidate.urls || []).join(" ")) ||
        extractQid(candidate.name); // last resort
    if (qid) {
        const byQid = await fetchThumbFromWikidata(qid);
        if (byQid) return byQid;
    }

    return null; // no thumb found
}



async function renderResults(payload) {
    resultsEl.innerHTML = '';
    const { candidates = [], usedGender, threshold } = payload || {};
    if (!candidates.length) {
        statusEl.textContent = `該当なし（性別: ${usedGender} / しきい値: ${threshold}%）。ゆるめにすると当たりやすいです。`;
        return;
    }
    statusEl.textContent = `候補が見つかりました！（上から順に似てそう）`;

    for (const c of candidates) {
        const conf = Number(c.confidence || 0).toFixed(1);
        const mood = conf >= 70 ? 'かなり似てるかも！' : conf >= 50 ? 'けっこう似てるかも' : 'たぶん…？';
        const links = (c.urls || []).slice(0, 3)
            // .map(u => `<a href="${u}" target="_blank" rel="noopener">リンク</a>`)
            .join(' / ') || '—';
        const imgSearch = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(c.name)}`;

        const card = document.createElement('div');
        card.className = 'result';
        card.innerHTML = `
      <img class="thumb" alt="${c.name}" />
      <div>
        <div><span class="badge">${mood}</span></div>
        <div><strong>${c.name}</strong>（信頼度: ${conf}%） ${c.gender ? '・性別: ' + c.gender : ''}</div>
        <div class="muted">参考: ${links} / <a href="${imgSearch}" target="_blank" rel="noopener">画像検索</a></div>
      </div>
    `;
        resultsEl.appendChild(card);

        // Load a real image URL (not the info-page URL)
        try {
            const thumbUrl = await pickCandidateThumb(c);
            const img = card.querySelector('.thumb');
            if (thumbUrl) {
                img.src = thumbUrl;
            } else {
                // subtle fallback background if we can't find a thumbnail
                img.style.background = 'linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02))';
            }
        } catch {
            // ignore thumb errors; keep the card text
        }
    }
}

// Convert any non-JPEG/PNG into JPEG (when the browser can decode it)
async function fileToJpegBlob(file) {
    if (/^image\/(jpe?g|png)$/i.test(file.type)) return file; // already OK
    // Try to decode
    const img = document.createElement('img');
    const url = URL.createObjectURL(file);
    try {
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        return blob;
    } catch {
        return null; // browser couldn't decode (e.g., HEIC)
    } finally {
        URL.revokeObjectURL(url);
    }
}

// ===== Actions =====
snap.addEventListener('click', async () => {
    if (!stream) { statusEl.textContent = 'まず「カメラ開始」を押してください。'; return; }
    try {
        setBusy();
        const dataUrl = mirroredJPEGFromVideo(video);
        if (!dataUrl) throw new Error('カメラの準備中です。もう一度お試しください。');
        const blob = await (await fetch(dataUrl)).blob(); // image/jpeg
        if (!blob || blob.size < 5000) throw new Error('撮影画像が小さすぎます。もう一度撮影してください。');
        const fd = new FormData();
        fd.append('image', blob, 'camera.jpg');
        const opts = { gender: genderSel.value, threshold: thresholdRange.value };
        const json = await postImage(fd, opts);
        renderResults(json);
    } catch (e) {
        console.error(e); statusEl.textContent = 'エラー: ' + e.message;
    } finally {
        clearBusy('完了');
    }
});

fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) { preview.style.display = 'none'; return; }
    preview.src = URL.createObjectURL(f);
    preview.style.display = 'block';
});

sendFile.addEventListener('click', async () => {
    const f = fileInput.files?.[0];
    if (!f) { statusEl.textContent = '画像ファイルを選択してください。'; return; }
    try {
        setBusy();
        let toSend = f;
        if (!/^image\/(jpe?g|png)$/i.test(f.type)) {
            const converted = await fileToJpegBlob(f);
            if (!converted) {
                throw new Error('JPG/PNG をアップしてください（HEIC/WEBP は非対応です）');
            }
            toSend = converted;
        }
        if (toSend.size < 5000) throw new Error('画像が小さすぎます（<5KB）');
        if (toSend.size > 15 * 1024 * 1024) throw new Error('画像が大きすぎます（>15MB）');

        const fd = new FormData();
        fd.append('image', toSend, 'upload.jpg');
        const opts = { gender: genderSel.value, threshold: thresholdRange.value };
        const json = await postImage(fd, opts);
        renderResults(json);
    } catch (e) {
        console.error(e); statusEl.textContent = 'エラー: ' + e.message;
    } finally {
        clearBusy('完了');
    }
});

// optional autostart
// startCamera().catch(() => {});
