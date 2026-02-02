/**
 * 显式 Worker 版（OCR 优先 + 兜底评分 + 强制纵向 + A4 等比输出）
 * 目录要求（与本文件同级的 index.html 一起使用）：
 * - ./opencv.js
 * - ./tesseract/tesseract.min.js
 * - ./tesseract/tesseract.worker.min.js
 * - ./tesseract/tesseract-core.wasm.js   ← 注意是 .wasm.js
 * - ./tesseract/tesseract-core.wasm
 * - ./tesseract/lang-data/osd.traineddata.gz ← 注意是 .gz
 */

const videoEl = document.getElementById('video');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const snapBtn = document.getElementById('snapBtn');
const autoCaptureEl = document.getElementById('autoCapture');
const resultCanvas = document.getElementById('resultCanvas');
const downloadPngBtn = document.getElementById('downloadPng');
const downloadJpgBtn = document.getElementById('downloadJpg');
const enhanceModeEl = document.getElementById('enhanceMode');
const outputSizeEl = document.getElementById('outputSize');
const fileInput = document.getElementById('fileInput');
const rotateLeftBtn = document.getElementById('rotateLeftBtn');
const rotateRightBtn = document.getElementById('rotateRightBtn');
const rotate180Btn = document.getElementById('rotate180Btn');

let stream = null;
let processing = false;
let a4StableCounter = 0;
let lastQuad = null;
let latestResultCanvas = null;

const A4_RATIO_W2H = 1 / Math.sqrt(2); // ≈0.707

// 安全兜底：若 enhanceAndWarp 未定义，提供一个最小实现避免流程失败
if (typeof enhanceAndWarp !== 'function') {
  function enhanceAndWarp(canvas, quad) {
    // 简化版本：不做透视，直接增强输入画面
    const src = cv.imread(canvas);
    let out = enhanceImage(src, (typeof enhanceModeEl !== 'undefined' ? enhanceModeEl.value : 'auto'));
    src.delete();
    return out; // Mat
  }
}


// 计算站点基路径，例如 https://marcelchn.github.io/ai-scanner
const BASE = (() => {
  const u = new URL(location.href);
  const path = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^/]*$/, '/');
  return `${u.origin}${path.replace(/\/$/, '')}`;
})();

// Tesseract 绝对路径配置（避免 Worker 相对路径解析失败）
const TESSERACT_CONFIG = {
  workerPath: `${BASE}/tesseract/tesseract.worker.min.js`,
  corePath:   `${BASE}/tesseract/tesseract-core.wasm.js`, // 必须 .wasm.js
  langPath:   `${BASE}/tesseract/lang-data`,              // OSD 请求 osd.traineddata.gz
  workerBlobURL: false                                     // 禁用 Blob Worker
};

console.log('[scanner] app.js loaded, BASE=', BASE);

function waitCvReady() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv['onRuntimeInitialized']) {
      cv['onRuntimeInitialized'] = () => {
        console.log('[scanner] cv.onRuntimeInitialized fired');
        resolve();
      };
      setTimeout(() => {
        if (typeof cv !== 'undefined') {
          console.log('[scanner] cv present without onRuntimeInitialized — continue');
          resolve();
        }
      }, 1500);
      return;
    }
    const t0 = Date.now();
    const tick = () => {
      if (typeof cv !== 'undefined') {
        console.log('[scanner] cv present (late) — continue');
        resolve();
        return;
      }
      if (Date.now() - t0 > 15000) {
        const msg = 'OpenCV 未就绪（可能脚本路径或缓存/CSP问题）';
        console.error('[scanner]', msg);
        statusEl.textContent = msg;
        reject(new Error(msg));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

waitCvReady().then(() => {
  statusEl.textContent = 'OpenCV 就绪。点击“启动相机”或上传图片。';
  snapBtn.disabled = false;
}).catch(err => {
  statusEl.textContent = 'OpenCV 加载失败：' + err.message;
});

window.addEventListener('error', (e) => {
  console.error('[scanner] window error', e.error || e.message);
  statusEl.textContent = `脚本错误：${e.error?.message || e.message}`;
});

startBtn.addEventListener('click', async () => {
  try {
    if (stream) { statusEl.textContent = '相机已启动'; return; }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    overlay.width = videoEl.videoWidth;
    overlay.height = videoEl.videoHeight;
    statusEl.textContent = '检测中…';
    snapBtn.disabled = false;
    requestAnimationFrame(processFrame);
  } catch (e) {
    console.error(e);
    statusEl.textContent = '无法启动相机：' + e.message;
  }
});

snapBtn.addEventListener('click', async () => {
  if (!stream) return;
  const frame = captureFrame();
  const quad = lastQuad || detectQuad(frame);
  await processAndRender(frame, quad, '拍摄');
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  statusEl.textContent = '正在读取图片…';
  const img = new Image();
  img.onload = async () => {
    const canvas = document.createElement('canvas');
    const maxSide = 3000;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const quad = detectQuad(canvas);
    await processAndRender(canvas, quad, '图片上传');
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  };
  img.onerror = () => { statusEl.textContent = '图片读取失败，请重试'; };
  img.src = URL.createObjectURL(file);
});

autoCaptureEl?.addEventListener('change', () => { a4StableCounter = 0; });

downloadPngBtn.addEventListener('click', () => {
  const url = resultCanvas.toDataURL('image/png'); downloadDataUrl(url, 'scan.png');
});
downloadJpgBtn.addEventListener('click', () => {
  const url = resultCanvas.toDataURL('image/jpeg', 0.95); downloadDataUrl(url, 'scan.jpg');
});

rotateLeftBtn?.addEventListener('click', () => redrawRotated(270));
rotateRightBtn?.addEventListener('click', () => redrawRotated(90));
rotate180Btn?.addEventListener('click', () => redrawRotated(180));
function redrawRotated(deg){ if(!latestResultCanvas) return; latestResultCanvas=rotateCanvas(latestResultCanvas,deg); const m=cv.imread(latestResultCanvas); cv.imshow(resultCanvas, m); m.delete(); }

function downloadDataUrl(url, filename) {
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function captureFrame() {
  const w = videoEl.videoWidth, h = videoEl.videoHeight;
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  return canvas;
}

function processFrame() {
  if (!stream) return;
  if (processing) { requestAnimationFrame(processFrame); return; }
  processing = true;
  const frameCanvas = captureFrame();
  const quad = detectQuad(frameCanvas);
  drawOverlay(quad);

  if (quad) {
    lastQuad = quad;
    statusEl.textContent = '已检测到疑似 A4（稳定度 ' + a4StableCounter + '/10）';
    a4StableCounter = Math.min(a4StableCounter + 1, 10);
    if (autoCaptureEl?.checked && a4StableCounter >= 8) {
      processAndRender(frameCanvas, quad, '自动抓拍'); a4StableCounter = 0;
    }
  } else {
    statusEl.textContent = '检测中…请将 A4 放置于画面中央';
    a4StableCounter = Math.max(a4StableCounter - 1, 0);
  }

  processing = false;
  requestAnimationFrame(processFrame);
}

function drawOverlay(quad) {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, overlay.width - 20, overlay.height - 20);
  if (!quad) return;
  ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y); for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath(); ctx.stroke();
}

/** 主流程：透视 + 增强 + OCR优先正向（显式 Worker） + A4纵向输出 */
async function processAndRender(canvas, quad, sourceLabel='') {
  if (!quad) statusEl.textContent = `未检测到 A4 四边形（${sourceLabel}），已增强原图。`;
  else statusEl.textContent = `已生成扫描件（${sourceLabel}）。`;

  const enhancedMat = enhanceAndWarp(canvas, quad);
  const uprightCanvas = await ensureUprightByOSD(enhancedMat); // 先试 OSD
  const finalCanvas    = fitToA4Portrait(uprightCanvas);

  // 使用 2D 直接绘制结果，避免某些环境下 cv.imshow 失效
  latestResultCanvas = finalCanvas;
  resultCanvas.width  = finalCanvas.width;
  resultCanvas.height = finalCanvas.height;
  const dstCtx = resultCanvas.getContext('2d');
  dstCtx.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
  dstCtx.drawImage(finalCanvas, 0, 0);
  console.log('[scanner] render result',
    { resultCanvasSize: [resultCanvas.width, resultCanvas.height],
      finalCanvasSize:  [finalCanvas.width, finalCanvas.height] });

  // 启用下载
  downloadPngBtn.disabled = false;
  downloadJpgBtn.disabled = false;

  enhancedMat.delete();
}

/** 显式 Worker：OSD 文字方向识别 */
async function ensureUprightByOSD(enhancedMat) {
  const canvas = matToCanvas(enhancedMat);
  try {
    if (typeof Tesseract === 'undefined') {
      statusEl.textContent = 'Tesseract 未定义（OSD不可用，采用兜底评分）';
      return autoChooseUprightByScoring(enhancedMat);
    }
    const worker = await Tesseract.createWorker({
      ...TESSERACT_CONFIG,
      logger: m => console.log('[tesseract]', m)
    });
    await worker.load();
    await worker.loadLanguage('osd');
    await worker.initialize('osd');
    const res = await worker.detect(canvas);
    await worker.terminate();

    const data = res.data || res;
    const rawDeg = (data.orientation && data.orientation.degrees) || data.degrees;
    const conf   = (data.orientation && data.orientation.confidence) || data.confidence || 0;

    if (typeof rawDeg !== 'number') {
      statusEl.textContent = 'OSD 返回无角度（rawDeg 非数字，采用兜底评分）';
      return autoChooseUprightByScoring(enhancedMat);
    }
    const deg = normalizeDeg(rawDeg);
    statusEl.textContent = `OSD: raw=${rawDeg}°, norm=${deg}°, conf=${conf.toFixed(2)} → 采用OSD旋转 ${deg}°`;

    if (conf < 1.0) {
      statusEl.textContent += '（置信度低，改用兜底评分）';
      return autoChooseUprightByScoring(enhancedMat);
    }

    let c = rotateCanvas(canvas, deg);
    if (c.width > c.height) c = rotateCanvas(c, 270); // 强制纵向
    return c;
  } catch (e) {
    console.warn('[scanner] OSD 失败：', e);
    statusEl.textContent = `OSD 检测失败：${e && e.message ? e.message : String(e)}（采用兜底评分）`;
    let c = autoChooseUprightByScoring(enhancedMat);
    if (c.width > c.height) c = rotateCanvas(c, 270);
    return c;
  }
}

function normalizeDeg(d){ const k=((d%360)+360)%360; if(k>=315||k<45) return 0; if(k<135) return 90; if(k<225) return 180; return 270; }

/** 兜底综合评分（不依赖 OCR） */
function autoChooseUprightByScoring(enhancedMat) {
  const candidates = [0, 90, 180, 270];
  let bestDeg = 0, bestScore = -Infinity;
  const w1 = 1.0, w2 = 0.6, w3 = 0.8;

  for (const deg of candidates) {
    const rotated = rotateMat(enhancedMat, deg);
    const gray = new cv.Mat(); cv.cvtColor(rotated, gray, cv.COLOR_RGBA2GRAY);
    const bw   = new cv.Mat(); cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    const { rowVar, colVar } = projectionVars(bw);
    const projScore = Math.max(rowVar, colVar);

    const horizK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(15, Math.floor(bw.cols/80)), 1));
    const vertK  = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(15, Math.floor(bw.rows/80))));
    const hc = new cv.Mat(); const vc = new cv.Mat();
    cv.morphologyEx(bw, hc, cv.MORPH_CLOSE, horizK);
    cv.morphologyEx(bw, vc, cv.MORPH_CLOSE, vertK);
    const horizResp = blackGain(hc, bw); const vertResp = blackGain(vc, bw);
    horizK.delete(); vertK.delete(); hc.delete(); vc.delete();

    const edges = new cv.Mat(); cv.Canny(bw, edges, 60, 180);
    const lines = new cv.Mat(); cv.HoughLinesP(edges, lines, 1, Math.PI/180, 80, Math.max(30, Math.floor(bw.cols/50)), 10);
    let houghHoriz = 0;
    for (let i = 0; i < lines.rows; i++) {
      const ptr = lines.intPtr(i,0);
      const x1 = ptr[0], y1 = ptr[1], x2 = ptr[2], y2 = ptr[3];
      const dx = x2 - x1, dy = y2 - y1;
      const angle = Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI;
      if (angle < 10 || Math.abs(angle-180) < 10) houghHoriz += Math.hypot(dx, dy);
    }
    edges.delete(); lines.delete();

    const score = w1*projScore + w2*(horizResp - vertResp) + w3*houghHoriz;
    if (score > bestScore) { bestScore = score; bestDeg = deg; }

    rotated.delete(); gray.delete(); bw.delete();
  }

  const c = matToCanvas(rotateMat(enhancedMat, bestDeg));
  return c;
}

function projectionVars(bw) {
  const rows = bw.rows, cols = bw.cols;
  const rowSums = new Float64Array(rows), colSums = new Float64Array(cols);
  for (let r = 0; r < rows; r++) { let s=0; for (let c = 0; c < cols; c++) if (bw.ucharPtr(r,c)[0]===0) s++; rowSums[r]=s; }
  for (let c = 0; c < cols; c++) { let s=0; for (let r = 0; r < rows; r++) if (bw.ucharPtr(r,c)[0]===0) s++; colSums[c]=s; }
  return { rowVar: variance(rowSums), colVar: variance(colSums) };
}
function blackGain(closed, orig) {
  let gain = 0, base = 0;
  for (let r=0; r<orig.rows; r++) for (let c=0; c<orig.cols; c++) {
    const o = orig.ucharPtr(r,c)[0], k = closed.ucharPtr(r,c)[0];
    if (o===0) base++; if (o===255 && k===0) gain++;
  }
  return base>0 ? gain/base : gain;
}
function variance(arr) {
  let n = arr.length; if (n===0) return 0;
  let mean=0; for (let i=0;i<n;i++) mean+=arr[i]; mean/=n;
  let v=0; for (let i=0;i<n;i++){const d=arr[i]-mean; v+=d*d;} return v/n;
}

/** 最终等比缩放为 A4 纵向，白底居中 */
function fitToA4Portrait(uprightCanvas) {
  const size = outputSizeEl.value;
  const targetShort = size === 'm' ? 1600 : (size === 'h' ? 2400 : 3300);
  const targetLong  = Math.round(targetShort / A4_RATIO_W2H);
  const outW = targetShort, outH = targetLong;

  const scale = Math.min(outW / uprightCanvas.width, outH / uprightCanvas.height);
  const newW = Math.round(uprightCanvas.width  * scale);
  const newH = Math.round(uprightCanvas.height * scale);

  const out = document.createElement('canvas'); out.width = outW; out.height = outH;
  const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,outW,outH);
  const dx = Math.floor((outW - newW)/2), dy = Math.floor((outH - newH)/2);
  ctx.drawImage(uprightCanvas, 0, 0, uprightCanvas.width, uprightCanvas.height, dx, dy, newW, newH);
  return out;
}

/** Mat/Canvas 工具 */
function rotateMat(mat, deg) {
  let out = new cv.Mat();
  if (deg===0) out = mat.clone();
  else if (deg===90) cv.rotate(mat, out, cv.ROTATE_90_CLOCKWISE);
  else if (deg===180) cv.rotate(mat, out, cv.ROTATE_180);
  else if (deg===270) cv.rotate(mat, out, cv.ROTATE_90_COUNTERCLOCKWISE);
  else out = mat.clone();
  return out;
}
function matToCanvas(mat) { const c=document.createElement('canvas'); cv.imshow(c, mat); return c; }
function rotateCanvas(inputCanvas, deg) {
  const rad = deg * Math.PI / 180;
  let outW=inputCanvas.width, outH=inputCanvas.height;
  if (deg===90||deg===270){ outW=inputCanvas.height; outH=inputCanvas.width; }
  const out=document.createElement('canvas'); out.width=outW; out.height=outH;
  const ctx=out.getContext('2d'); ctx.translate(outW/2, outH/2); ctx.rotate(rad);
  ctx.drawImage(inputCanvas, -inputCanvas.width/2, -inputCanvas.height/2);
  return out;
}

/** 四边形检测（A4候选） */
function detectQuad(canvas) {
  const src = cv.imread(canvas);
  try {
    let dst = new cv.Mat(); cv.cvtColor(src, src, cv.COLOR_RGBA2RGB); cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);
    let bg = new cv.Mat(); cv.GaussianBlur(dst, bg, new cv.Size(0, 0), 25);
    let norm = new cv.Mat(); cv.subtract(dst, bg, norm); cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);
    let edges = new cv.Mat(); cv.Canny(norm, edges, 50, 150);
    let contours = new cv.MatVector(); let hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best=null, bestScore=0;
    for (let i=0;i<contours.size();i++){
      const cnt=contours.get(i); const peri=cv.arcLength(cnt,true);
      const approx=new cv.Mat(); cv.approxPolyDP(cnt, approx, 0.02*peri, true);
      if (approx.rows===4){
        const rect=cv.boundingRect(approx); const area=rect.width*rect.height;
        const areaRatio=area/(src.cols*src.rows); if (areaRatio<0.10){ approx.delete(); continue; }
        const pts=[]; for(let r=0;r<approx.rows;r++){ pts.push({ x: approx.intAt(r,0), y: approx.intAt(r,1) }); }
        const ordered=orderQuad(pts); const w=dist(ordered[0],ordered[1]); const h=dist(ordered[0],ordered[3]);
        const ratio=w/h; const rDiff=Math.abs(ratio - A4_RATIO_W2H); const score=areaRatio*(1 - rDiff);
        if (score>bestScore){ bestScore=score; best=ordered; }
        approx.delete();
      } else approx.delete();
    }

    edges.delete(); contours.delete(); hierarchy.delete(); dst.delete(); bg.delete(); norm.delete();
    if (!best) { src.delete(); return null; } src.delete(); return best;
  } catch (e) { console.error(e); src.delete(); return null; }
}
function orderQuad(points){
  const pts=points.slice();
  const sumSort=[...pts].sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  const diffSort=[...pts].sort((a,b)=>(a.x-a.y)-(b.x-b.y));
  const tl=sumSort[0], br=sumSort[sumSort.length-1], tr=diffSort[diffSort.length-1], bl=diffSort[0];
  return [tl,tr,br,bl];
}
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx + dy*dy); }
