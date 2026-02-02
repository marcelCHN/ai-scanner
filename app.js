/**
 * 本地化 Tesseract 配置最终版 app.js（OCR 优先 + 兜底评分 + 强制纵向 + A4 等比输出）
 * 目录要求：
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

// 计算站点基路径（确保绝对路径正确）：例如 https://marcelchn.github.io/ai-scanner
const BASE = (function () {
  const u = new URL(location.href);
  // pathname 形如 /ai-scanner/ 或 /ai-scanner/index.html → 取目录
  const path = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/\/[^/]*$/, '/');
  return `${u.origin}${path.replace(/\/$/, '')}`;
})();

// 本地化 Tesseract 的绝对路径配置（避免 Worker 相对路径解析失败）
const TESSERACT_CONFIG = {
  workerPath: `${BASE}/tesseract/tesseract.worker.min.js`,
  corePath:   `${BASE}/tesseract/tesseract-core.wasm.js`, // 关键：必须是 .wasm.js
  langPath:   `${BASE}/tesseract/lang-data`,              // OSD 会请求 osd.traineddata.gz
  workerBlobURL: false                                     // 关键：禁用 Blob Worker
};

// 显示脚本加载日志
console.log('[scanner] app.js loaded, BASE=', BASE);
if (statusEl) statusEl.textContent = '脚本已加载，等待 OpenCV 初始化…';

function waitCvReady() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv['onRuntimeInitialized']) {
      cv['onRuntimeInitialized'] = () => resolve();
      return;
    }
    const t0 = Date.now();
    const tick = () => {
      if (typeof cv !== 'undefined') {
        if (cv['onRuntimeInitialized']) cv['onRuntimeInitialized'] = () => resolve();
        else resolve();
        return;
      }
      if (Date.now() - t0 > 15000) return reject(new Error('OpenCV 未就绪'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

waitCvReady().then(() => {
  console.log('[scanner] OpenCV ready');
  statusEl.textContent = 'OpenCV 就绪。点击“启动相机”或上传图片。';
  snapBtn.disabled = false;
}).catch(err => {
  console.error(err);
  statusEl.textContent = 'OpenCV 加载失败，请检查路径。';
});

// 捕获全局错误到状态栏
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
function redrawRotated(deg){ if(!latestResultCanvas) return; latestResultCanvas=rotateCanvas(latestResultCanvas,deg); const m=cv.imread(latestResultCanvas); cv.imshow(resultCanvas,m); m.delete(); }

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
    if (autoCaptureEl?.checked && a4StableCounter >= 8) { processAndRender(frameCanvas, quad, '自动抓拍'); a4StableCounter = 0; }
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

/** 主流程：透视（无失真） + 增强 + OCR优先的正向 + 输出A4纵向 + 渲染 */
async function processAndRender(canvas, quad, sourceLabel='') {
  if (!quad) statusEl.textContent = `未检测到 A4 四边形（${sourceLabel}），已增强原图。`;
  else statusEl.textContent = `已生成扫描件（${sourceLabel}）。`;

  const enhancedMat = enhanceAndWarp(canvas, quad);     // 1) 透视矫正 + 增强
  const uprightCanvas = await autoUprightOCRFirst(enhancedMat); // 2) OCR优先自动正向（失败则兜底评分）
  const finalCanvas    = fitToA4Portrait(uprightCanvas);        // 3) 等比缩放，白底居中，纵向A4

  latestResultCanvas = finalCanvas;
  const mat = cv.imread(finalCanvas); cv.imshow(resultCanvas, mat); mat.delete();
  enhancedMat.delete();
  downloadPngBtn.disabled = false; downloadJpgBtn.disabled = false;
}

/** 透视矫正（以实际四边形宽高为目标） + 基础增强（不强行套A4比） */
function enhanceAndWarp(canvas, quad) {
  const src = cv.imread(canvas);
  let warped = new cv.Mat();

  if (quad) {
    const widthA  = dist(quad[2], quad[3]); // BR-BL
    const widthB  = dist(quad[1], quad[0]); // TR-TL
    const heightA = dist(quad[1], quad[2]); // TR-BR
    const heightB = dist(quad[0], quad[3]); // TL-BL
    const dstW = Math.max(Math.round(widthA),  Math.round(widthB));
    const dstH = Math.max(Math.round(heightA), Math.round(heightB));

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x, quad[0].y,  // TL
      quad[1].x, quad[1].y,  // TR
      quad[2].x, quad[2].y,  // BR
      quad[3].x, quad[3].y   // BL
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, dstW - 1, 0, dstW - 1, dstH - 1, 0, dstH - 1
    ]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    srcTri.delete(); dstTri.delete(); M.delete();
  } else {
    warped = src.clone();
  }

  let enhanced = enhanceImage(warped, enhanceModeEl.value);
  src.delete(); warped.delete();
  return enhanced; // Mat
}

/** 增强：光照均衡 + 阈值 + 去噪（或彩色增强） */
function enhanceImage(mat, mode='auto') {
  let rgb = new cv.Mat(); cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
  let gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  let bg = new cv.Mat();   cv.GaussianBlur(gray, bg, new cv.Size(0, 0), 35);
  let norm = new cv.Mat(); cv.subtract(gray, bg, norm); cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);
  let bw = new cv.Mat();   cv.adaptiveThreshold(norm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 10);
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2,2)); cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel);

  let out = new cv.Mat();
  if (mode === 'binarize') { out = bw.clone(); }
  else if (mode === 'color') {
    let lab = new cv.Mat(); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    let channels = new cv.MatVector(); cv.split(lab, channels);
    cv.equalizeHist(channels.get(0), channels.get(0)); cv.merge(channels, lab);
    cv.cvtColor(lab, out, cv.COLOR_Lab2RGB); channels.delete(); lab.delete();
  } else {
    const mean = new cv.Mat(), stddev = new cv.Mat(); cv.meanStdDev(norm, mean, stddev);
    const contrast = stddev.doubleAt(0,0);
    if (contrast > 30) out = bw.clone(); else { out = new cv.Mat(); cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA); }
    mean.delete(); stddev.delete();
  }

  rgb.delete(); gray.delete(); bg.delete(); norm.delete(); kernel.delete();
  return out;
}

/** OCR 优先的自动正向，失败则落回综合评分 */
async function autoUprightOCRFirst(enhancedMat) {
  let canvas = matToCanvas(enhancedMat);

  const osd = await getOrientationByOSD(canvas);
  if (osd && typeof osd.deg === 'number') {
    statusEl.textContent += ` → 采用OSD旋转 ${osd.deg}°`;
    canvas = rotateCanvas(canvas, osd.deg);
  } else {
    statusEl.textContent += ` → OSD不可用，采用兜底评分`;
    canvas = autoChooseUprightByScoring(enhancedMat);
  }

  if (canvas.width > canvas.height) canvas = rotateCanvas(canvas, 270); // 强制纵向
  return canvas;
}

/** 使用本地化配置的 OSD 检测方向；返回 {deg, conf}；失败返回 null（含临时日志） */
async function getOrientationByOSD(canvas) {
  try {
    if (typeof Tesseract === 'undefined') {
      statusEl.textContent = 'OSD 未加载（Tesseract 未定义）';
      return null;
    }
    const res = await Tesseract.detect(canvas, TESSERACT_CONFIG);
    const data = res.data || res;

    const rawDeg = (data.orientation && data.orientation.degrees) || data.degrees;
    const conf   = (data.orientation && data.orientation.confidence) || data.confidence || 0;

    if (typeof rawDeg !== 'number') {
      statusEl.textContent = 'OSD 返回无角度（rawDeg 非数字）';
      return null;
    }

    const deg = normalizeDeg(rawDeg);

    statusEl.textContent = `OSD: raw=${rawDeg}°, norm=${deg}°, conf=${conf.toFixed(2)}`;
    if (conf < 1.0) {
      statusEl.textContent += '（置信度低，启用兜底评分）';
      return null;
    }
    return { deg, conf };
  } catch (e) {
    console.warn('OSD 检测失败（将回退评分法）：', e);
    statusEl.textContent = `OSD 检测失败：${e && e.message ? e.message : String(e)}（启用兜底评分）`;
    return null;
  }
}
function normalizeDeg(d){ let k=((d%360)+360)%360; if(k>=315||k<45) return 0; if(k<135) return 90; if(k<225) return 180; return 270; }

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

  return matToCanvas(rotateMat(enhancedMat, bestDeg));
}

/** 计算投影方差 / 形态辅助评分 */
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
  const size = outputSizeEl.value; // m/h/uh
  const targetShort = size === 'm' ? 1600 : (size === 'h' ? 2400 : 3300);
  const targetLong  = Math.round(targetShort / A4_RATIO_W2H); // ≈ short/0.707
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

/** Mat 旋转（0/90/180/270） / Mat->Canvas / Canvas旋转 */
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
