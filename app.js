/**
 * 本地算法自动正向（不依赖 Tesseract/OSD）
 * - 透视无失真 → 增强
 * - 强制纵向（横拍先旋90）
 * - 0/90/180/270 综合评分选最可读
 * - 0°/180°再做上下密度+页眉/脚注特征判定，必要时自动+180°
 * - 2D drawImage 稳定渲染到 resultCanvas
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

console.log('[scanner] app.js loaded');

function waitCvReady() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv['onRuntimeInitialized']) {
      cv['onRuntimeInitialized'] = () => resolve();
      setTimeout(() => { if (typeof cv !== 'undefined') resolve(); }, 1500);
      return;
    }
    const t0 = Date.now();
    const tick = () => {
      if (typeof cv !== 'undefined') { resolve(); return; }
      if (Date.now() - t0 > 15000) {
        const msg = 'OpenCV 未就绪（检查路径/缓存/CSP）';
        statusEl.textContent = msg; reject(new Error(msg)); return;
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
  img.onerror = () => { statusEl.textContent = '图片读取失败，请更换文件。'; };
  img.src = URL.createObjectURL(file);
});

autoCaptureEl?.addEventListener('change', () => { a4StableCounter = 0; });

downloadPngBtn.addEventListener('click', () => {
  const url = resultCanvas.toDataURL('image/png');
  downloadDataUrl(url, 'scan.png');
});
downloadJpgBtn.addEventListener('click', () => {
  const url = resultCanvas.toDataURL('image/jpeg', 0.95);
  downloadDataUrl(url, 'scan.jpg');
});

// 手动旋转按钮
rotateLeftBtn?.addEventListener('click', () => {
  if (!latestResultCanvas) return;
  latestResultCanvas = rotateCanvas(latestResultCanvas, 270);
  const ctx = resultCanvas.getContext('2d');
  resultCanvas.width = latestResultCanvas.width;
  resultCanvas.height = latestResultCanvas.height;
  ctx.drawImage(latestResultCanvas, 0, 0);
});
rotateRightBtn?.addEventListener('click', () => {
  if (!latestResultCanvas) return;
  latestResultCanvas = rotateCanvas(latestResultCanvas, 90);
  const ctx = resultCanvas.getContext('2d');
  resultCanvas.width = latestResultCanvas.width;
  resultCanvas.height = latestResultCanvas.height;
  ctx.drawImage(latestResultCanvas, 0, 0);
});
rotate180Btn?.addEventListener('click', () => {
  if (!latestResultCanvas) return;
  latestResultCanvas = rotateCanvas(latestResultCanvas, 180);
  const ctx = resultCanvas.getContext('2d');
  resultCanvas.width = latestResultCanvas.width;
  resultCanvas.height = latestResultCanvas.height;
  ctx.drawImage(latestResultCanvas, 0, 0);
});

function downloadDataUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function captureFrame() {
  const w = videoEl.videoWidth, h = videoEl.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
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
    statusEl.textContent = `已检测到疑似 A4（稳定度 ${a4StableCounter}/10）`;
    a4StableCounter = Math.min(a4StableCounter + 1, 10);
    if (autoCaptureEl.checked && a4StableCounter >= 8) {
      processAndRender(frameCanvas, quad, '自动抓拍');
      a4StableCounter = 0;
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
  ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath(); ctx.stroke();
}

/** 主流程：透视 + 增强 + 本地算法自动正向 + A4纵向输出 + 稳定渲染 */
async function processAndRender(canvas, quad, sourceLabel='') {
  statusEl.textContent = quad ? `已生成扫描件（${sourceLabel}）。` : `未检测到 A4（${sourceLabel}，已增强原图）`;

  const enhancedMat = enhanceAndWarp(canvas, quad);
  let uprightCanvas = matToCanvas(enhancedMat);

  // A. 强制纵向（横拍先旋90）
  if (uprightCanvas.width > uprightCanvas.height) {
    uprightCanvas = rotateCanvas(uprightCanvas, 270);
  }

  // B. 0/90/180/270 综合评分选最可读
  uprightCanvas = autoUprightByScoring(uprightCanvas);

  // C. 对 0°/180°做上下密度 + 页眉/脚注特征判定（必要时 +180°）
  uprightCanvas = autoFix180ByTopBottom(uprightCanvas);

  // D. 等比缩放到 A4 纵向白底居中
  const finalCanvas = fitToA4Portrait(uprightCanvas);

  // E. 2D 稳定渲染到结果画布
  latestResultCanvas = finalCanvas;
  resultCanvas.width  = finalCanvas.width;
  resultCanvas.height = finalCanvas.height;
  const dstCtx = resultCanvas.getContext('2d');
  dstCtx.clearRect(0, 0, resultCanvas.width, resultCanvas.height);
  dstCtx.drawImage(finalCanvas, 0, 0);
  console.log('[scanner] render result', { resultCanvasSize: [resultCanvas.width, resultCanvas.height], finalCanvasSize: [finalCanvas.width, finalCanvas.height] });

  // 启用下载
  downloadPngBtn.disabled = false;
  downloadJpgBtn.disabled = false;

  enhancedMat.delete();
}

// ——增强与透视（完整定义）——
function enhanceImage(mat, mode='auto') {
  let rgb = new cv.Mat(); cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
  let gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  let bg = new cv.Mat();   cv.GaussianBlur(gray, bg, new cv.Size(0, 0), 35);
  let norm = new cv.Mat(); cv.subtract(gray, bg, norm); cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);
  let bw = new cv.Mat();   cv.adaptiveThreshold(norm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 10);
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2,2));
  cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel);

  let out = new cv.Mat();
  if (mode === 'binarize') {
    out = bw.clone();
  } else if (mode === 'color') {
    let lab = new cv.Mat(); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    let channels = new cv.MatVector(); cv.split(lab, channels);
    cv.equalizeHist(channels.get(0), channels.get(0)); cv.merge(channels, lab);
    cv.cvtColor(lab, out, cv.COLOR_Lab2RGB);
    channels.delete(); lab.delete();
  } else {
    const mean = new cv.Mat(), stddev = new cv.Mat(); cv.meanStdDev(norm, mean, stddev);
    const contrast = stddev.doubleAt(0,0);
    if (contrast > 30) out = bw.clone();
    else { out = new cv.Mat(); cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA); }
    mean.delete(); stddev.delete();
  }
  rgb.delete(); gray.delete(); bg.delete(); norm.delete(); kernel.delete();
  return out;
}

function enhanceAndWarp(canvas, quad) {
  const src = cv.imread(canvas);
  let warped = new cv.Mat();

  if (quad) {
    const widthA  = dist(quad[2], quad[3]);
    const widthB  = dist(quad[1], quad[0]);
    const heightA = dist(quad[1], quad[2]);
    const heightB = dist(quad[0], quad[3]);
    const dstW = Math.max(Math.round(widthA),  Math.round(widthB));
    const dstH = Math.max(Math.round(heightA), Math.round(heightB));

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x, quad[0].y,
      quad[1].x, quad[1].y,
      quad[2].x, quad[2].y,
      quad[3].x, quad[3].y
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [ 0,0, dstW-1,0, dstW-1,dstH-1, 0,dstH-1 ]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    srcTri.delete(); dstTri.delete(); M.delete();
  } else {
    warped = src.clone();
  }

  const out = enhanceImage(warped, (typeof enhanceModeEl !== 'undefined' ? enhanceModeEl.value : 'auto'));
  src.delete(); warped.delete();
  return out;
}

// ——0/90/180/270 评分（同前）——
function autoUprightByScoring(canvas) {
  const degs = [0, 90, 180, 270];
  let bestDeg = 0, bestScore = -Infinity;
  degs.forEach(deg => {
    const c = rotateCanvas(canvas, deg);
    const score = readabilityScoreCanvas(c);
    if (score > bestScore) { bestScore = score; bestDeg = deg; }
  });
  return rotateCanvas(canvas, bestDeg);
}

function readabilityScoreCanvas(canvas) {
  const mat = cv.imread(canvas);
  const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const bw = new cv.Mat(); cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

  const { rowVar, colVar } = projectionVars(bw);
  let score = Math.max(rowVar, colVar);

  const edges = new cv.Mat(); cv.Canny(bw, edges, 60, 180);
  const lines = new cv.Mat(); cv.HoughLinesP(edges, lines, 1, Math.PI/180, 80, Math.max(30, Math.floor(bw.cols/50)), 10);
  let houghHoriz = 0;
  for (let i = 0; i < lines.rows; i++) {
    const p = lines.intPtr(i,0);
    const dx = p[2]-p[0], dy = p[3]-p[1];
    const angle = Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI;
    if (angle < 10 || Math.abs(angle-180) < 10) houghHoriz += Math.hypot(dx, dy);
  }
  score += 0.8 * houghHoriz;

  mat.delete(); gray.delete(); bw.delete(); edges.delete(); lines.delete();
  return score;
}

// ——0/180 增强判定（上下密度 + 页眉脚注特征）——
function autoFix180ByTopBottom(canvas) {
  const mat = cv.imread(canvas);
  const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  const bw = new cv.Mat(); cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

  const h = bw.rows, w = bw.cols;
  const band = Math.max( Math.floor(h * 0.12), 40 ); // 上下带宽
  let topBlack = 0, bottomBlack = 0;

  for (let r = 0; r < band; r++) {
    for (let c = 0; c < w; c++) { if (bw.ucharPtr(r,c)[0] === 0) topBlack++; }
  }
  for (let r = h-band; r < h; r++) {
    for (let c = 0; c < w; c++) { if (bw.ucharPtr(r,c)[0] === 0) bottomBlack++; }
  }

  // 页眉通常较干净，脚注/签名/底部表格更密；若顶部更“脏”，可能倒置
  const ratio = topBlack / (bottomBlack + 1);
  mat.delete(); gray.delete(); bw.delete();

  if (ratio > 1.25) { // 阈值可微调
    return rotateCanvas(canvas, 180);
  }
  return canvas;
}

// ——投影方差工具——
function projectionVars(bw) {
  const rows = bw.rows, cols = bw.cols;
  const rowSums = new Float64Array(rows), colSums = new Float64Array(cols);
  for (let r = 0; r < rows; r++) { let s=0; for (let c = 0; c < cols; c++) if (bw.ucharPtr(r,c)[0]===0) s++; rowSums[r]=s; }
  for (let c = 0; c < cols; c++) { let s=0; for (let r = 0; r < rows; r++) if (bw.ucharPtr(r,c)[0]===0) s++; colSums[c]=s; }
  return { rowVar: variance(rowSums), colVar: variance(colSums) };
}
function variance(arr) {
  let n = arr.length; if (n===0) return 0;
  let mean=0; for (let i=0;i<n;i++) mean+=arr[i]; mean/=n;
  let v=0; for (let i=0;i<n;i++){const d=arr[i]-mean; v+=d*d;} return v/n;
}

/** A4 等比输出（白底居中） */
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

/** A4候选检测（同前） */
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
