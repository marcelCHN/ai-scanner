/**
 * Pad 文档扫描器（A4 自动识别 + 透视无失真 + 自动正向 + 等比输出为纵向A4）
 * 方向判定：对 0/90/180/270 综合评分（投影方差 + 形态响应 + Hough 连续性），选“最可读”的方向
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

// 可选：手动兜底
const rotateLeftBtn = document.getElementById('rotateLeftBtn');
const rotateRightBtn = document.getElementById('rotateRightBtn');
const rotate180Btn = document.getElementById('rotate180Btn');

let stream = null;
let processing = false;
let a4StableCounter = 0;
let lastQuad = null;
let latestResultCanvas = null;

const A4_RATIO_W2H = 1 / Math.sqrt(2); // ≈0.707

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
  statusEl.textContent = 'OpenCV 就绪。点击“启动相机”或上传图片。';
  snapBtn.disabled = false;
}).catch(err => {
  console.error(err);
  statusEl.textContent = 'OpenCV 加载失败，请检查路径与CSP。';
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
    // 处理上限，避免超大图占用内存
    const maxSide = 3000;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const quad = detectQuad(canvas);
    await processAndRender(canvas, quad, '图片上传');
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const octx = overlay.getContext('2d');
    octx.clearRect(0, 0, overlay.width, overlay.height);
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

/** 主流程：透视（无失真） + 增强 + 自动正向 + 输出A4纵向 + 渲染 */
async function processAndRender(canvas, quad, sourceLabel='') {
  if (!quad) statusEl.textContent = `未检测到 A4 四边形（${sourceLabel}），已增强原图。`;
  else statusEl.textContent = `已生成扫描件（${sourceLabel}）。`;

  const enhancedMat = enhanceAndWarp(canvas, quad);        // 1) 透视矫正（真实宽高）+ 增强
  const uprightCanvas = autoChooseUpright(enhancedMat);    // 2) 自动选择最可读方向 + 强制纵向
  const finalCanvas    = fitToA4Portrait(uprightCanvas);   // 3) 等比缩放，白底居中，纵向A4

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
    // 真实宽高，避免错认长/短边导致压缩
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

/**
 * 自动选择正向（不依赖OCR）：
 * - 对 0/90/180/270：OTSU二值 → 行/列投影方差 → 形态响应（横/竖核） → HoughLinesP 水平线连续性
 * - 评分：score = w1*max(rowVar,colVar) + w2*(horizResp - vertResp) + w3*houghHoriz
 * - 选 score 最大角度；最后强制纵向（宽>高则逆时针90）
 */
function autoChooseUpright(enhancedMat) {
  const candidates = [0, 90, 180, 270];
  let bestDeg = 0, bestScore = -Infinity;

  const w1 = 1.0, w2 = 0.6, w3 = 0.8;

  for (const deg of candidates) {
    const rotated = rotateMat(enhancedMat, deg);

    // 二值与投影
    const gray = new cv.Mat(); cv.cvtColor(rotated, gray, cv.COLOR_RGBA2GRAY);
    const bw   = new cv.Mat(); cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    const { rowVar, colVar } = projectionVars(bw);
    const projScore = Math.max(rowVar, colVar);

    // 形态响应：横/竖结构核，统计闭运算后的黑像素提升量
    const horizK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(15, Math.floor(bw.cols/80)), 1));
    const vertK  = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(15, Math.floor(bw.rows/80))));
    const hc = new cv.Mat(); const vc = new cv.Mat();
    cv.morphologyEx(bw, hc, cv.MORPH_CLOSE, horizK);
    cv.morphologyEx(bw, vc, cv.MORPH_CLOSE, vertK);
    const horizResp = blackGain(hc, bw); const vertResp = blackGain(vc, bw);
    horizK.delete(); vertK.delete(); hc.delete(); vc.delete();

    // HoughLinesP：统计近水平线的长度总和（越长越规整）
    const edges = new cv.Mat(); cv.Canny(bw, edges, 60, 180);
    const lines = new cv.Mat(); cv.HoughLinesP(edges, lines, 1, Math.PI/180, 80, Math.max(30, Math.floor(bw.cols/50)), 10);
    let houghHoriz = 0;
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.intPtr(i,0)[0], y1 = lines.intPtr(i,0)[1];
      const x2 = lines.intPtr(i,0)[2], y2 = lines.intPtr(i,0)[3];
      const dx = x2 - x1, dy = y2 - y1;
      const angle = Math.abs(Math.atan2(dy, dx)) * 180 / Math.PI;
      if (angle < 10 || Math.abs(angle-180) < 10) houghHoriz += Math.hypot(dx, dy);
    }
    edges.delete(); lines.delete();

    const score = w1*projScore + w2*(horizResp - vertResp) + w3*houghHoriz;
    if (score > bestScore) { bestScore = score; bestDeg = deg; }

    rotated.delete(); gray.delete(); bw.delete();
  }

  let canvas = matToCanvas(rotateMat(enhancedMat, bestDeg));
  if (canvas.width > canvas.height) canvas = rotateCanvas(canvas, 270); // 强制纵向
  return canvas;
}

/** 投影方差 */
function projectionVars(bw) {
  const rows = bw.rows, cols = bw.cols;
  const rowSums = new Float64Array(rows), colSums = new Float64Array(cols);
  for (let r = 0; r < rows; r++) { let s=0; for (let c = 0; c < cols; c++) if (bw.ucharPtr(r,c)[0]===0) s++; rowSums[r]=s; }
  for (let c = 0; c < cols; c++) { let s=0; for (let r = 0; r < rows; r++) if (bw.ucharPtr(r,c)[0]===0) s++; colSums[c]=s; }
  return { rowVar: variance(rowSums), colVar: variance(colSums) };
}
function blackGain(closed, orig) {
  // 形态闭运算后黑像素提升量比例，衡量结构核匹配度
  let gain = 0, base = 0;
  for (let r=0; r<orig.rows; r++) for (let c=0; c<orig.cols; c++) {
    const o = orig.ucharPtr(r,c)[0], k = closed.ucharPtr(r,c)[0];
    if (o===0) base++; if (o===255 && k===0) gain++; // 新增黑像素
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

/** Mat 旋转（0/90/180/270） */
function rotateMat(mat, deg) {
  let out = new cv.Mat();
  if (deg===0) out = mat.clone();
  else if (deg===90) cv.rotate(mat, out, cv.ROTATE_90_CLOCKWISE);
  else if (deg===180) cv.rotate(mat, out, cv.ROTATE_180);
  else if (deg===270) cv.rotate(mat, out, cv.ROTATE_90_COUNTERCLOCKWISE);
  else out = mat.clone();
  return out;
}
/** Mat -> Canvas */
function matToCanvas(mat) { const c=document.createElement('canvas'); cv.imshow(c, mat); return c; }
/** Canvas 旋转（0/90/180/270） */
function rotateCanvas(inputCanvas, deg) {
  const rad = deg * Math.PI / 180;
  let outW=inputCanvas.width, outH=inputCanvas.height;
  if (deg===90||deg===270){ outW=inputCanvas.height; outH=inputCanvas.width; }
  const out=document.createElement('canvas'); out.width=outW; out.height=outH;
  const ctx=out.getContext('2d'); ctx.translate(outW/2, outH/2); ctx.rotate(rad);
  ctx.drawImage(inputCanvas, -inputCanvas.width/2, -inputCanvas.height/2);
  return out;
}

/** 四边形检测 */
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
