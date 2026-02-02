/**
 * Pad 文档扫描器（A4 自动识别 + 透视无失真 + 自动正向 + 等比输出为纵向A4）
 * - 透视阶段：以检测到的四边形真实宽高做矫正（避免长短边错配导致压缩/拉伸）
 * - 方向判断：对 0/90/180/270 进行投影方差评分，选可读性最佳方向；最后强制纵向（portrait）
 * - 最终输出：等比缩放到 A4 纵向目标尺寸并居中（白底），不拉伸
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

// 手动兜底按钮（若 index.html 已有）
const rotateLeftBtn = document.getElementById('rotateLeftBtn');
const rotateRightBtn = document.getElementById('rotateRightBtn');
const rotate180Btn = document.getElementById('rotate180Btn');

let stream = null;
let processing = false;
let a4StableCounter = 0;
let lastQuad = null;

// 便于手动旋转：保存最近一次结果为 Canvas
let latestResultCanvas = null;

// A4 纵向宽高比（width:height）约 0.707（= 1 / sqrt(2)）
const A4_RATIO_W2H = 1 / Math.sqrt(2);

// 等待 OpenCV 就绪
function waitCvReady() {
  return new Promise((resolve, reject) => {
    if (typeof cv !== 'undefined' && cv['onRuntimeInitialized']) {
      cv['onRuntimeInitialized'] = () => resolve();
      return;
    }
    const start = Date.now();
    const check = () => {
      if (typeof cv !== 'undefined') {
        if (cv['onRuntimeInitialized']) {
          cv['onRuntimeInitialized'] = () => resolve();
        } else {
          resolve();
        }
        return;
      }
      if (Date.now() - start > 15000) {
        reject(new Error('OpenCV 未就绪'));
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

waitCvReady().then(() => {
  statusEl.textContent = 'OpenCV 就绪。点击“启动相机”或上传图片。';
  snapBtn.disabled = false;
}).catch(err => {
  console.error(err);
  statusEl.textContent = 'OpenCV 加载失败，请使用 HTTP/HTTPS 访问并检查路径（或放宽 CSP）。';
});

startBtn.addEventListener('click', async () => {
  try {
    if (stream) {
      statusEl.textContent = '相机已启动';
      return;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();

    overlay.width = videoEl.videoWidth;
    overlay.height = videoEl.videoHeight;

    statusEl.textContent = '检测中…';
    snapBtn.disabled = false;

    requestAnimationFrame(processFrame);
  } catch (err) {
    console.error(err);
    statusEl.textContent = '无法启动相机：' + err.message;
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
    const maxSide = 2400;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const quad = detectQuad(canvas);
    await processAndRender(canvas, quad, '图片上传');

    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const overlayCtx = overlay.getContext('2d');
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  };
  img.onerror = () => {
    statusEl.textContent = '图片读取失败，请更换文件。';
  };
  img.src = URL.createObjectURL(file);
});

autoCaptureEl?.addEventListener('change', () => {
  a4StableCounter = 0;
});

downloadPngBtn.addEventListener('click', () => {
  const url = resultCanvas.toDataURL('image/png');
  downloadDataUrl(url, 'scan.png');
});
downloadJpgBtn.addEventListener('click', () => {
  const url = resultCanvas.toDataURL('image/jpeg', 0.95);
  downloadDataUrl(url, 'scan.jpg');
});

// 手动旋转（如有）
rotateLeftBtn?.addEventListener('click', () => {
  if (!latestResultCanvas) return;
  latestResultCanvas = rotateCanvas(latestResultCanvas, 270); // 左转90
  const mat = cv.imread(latestResultCanvas);
  cv.imshow(resultCanvas, mat);
  mat.delete();
});
rotateRightBtn?.addEventListener('click', () => {
  if (!latestResultCanvas) return;
  latestResultCanvas = rotateCanvas(latestResultCanvas, 90);
  const mat = cv.imread(latestResultCanvas);
  cv.imshow(resultCanvas, mat);
  mat.delete();
});
rotate180Btn?.addEventListener('click', () => {
  if (!latestResultCanvas) return;
  latestResultCanvas = rotateCanvas(latestResultCanvas, 180);
  const mat = cv.imread(latestResultCanvas);
  cv.imshow(resultCanvas, mat);
  mat.delete();
});

function downloadDataUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function captureFrame() {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvas;
}

function processFrame() {
  if (!stream) return;
  if (processing) {
    requestAnimationFrame(processFrame);
    return;
  }
  processing = true;

  const frameCanvas = captureFrame();
  const quad = detectQuad(frameCanvas);
  drawOverlay(quad);

  if (quad) {
    lastQuad = quad;
    statusEl.textContent = '已检测到疑似 A4（稳定度 ' + a4StableCounter + '/10）';
    a4StableCounter = Math.min(a4StableCounter + 1, 10);
    if (autoCaptureEl?.checked && a4StableCounter >= 8) {
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

  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, overlay.width - 20, overlay.height - 20);

  if (!quad) return;

  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < quad.length; i++) {
    ctx.lineTo(quad[i].x, quad[i].y);
  }
  ctx.closePath();
  ctx.stroke();
}

/** 主流程：透视 + 增强 + 自动正向 + 输出A4纵向 + 渲染 */
async function processAndRender(canvas, quad, sourceLabel='') {
  if (!quad) statusEl.textContent = `未检测到 A4 四边形（${sourceLabel}），已增强原图。`;
  else statusEl.textContent = `已生成扫描件（${sourceLabel}）。`;

  // 1) 透视无失真 + 增强
  const enhancedMat = enhanceAndWarp(canvas, quad);

  // 2) 自动选取 0/90/180/270 的最佳阅读方向 + 强制纵向
  const uprightCanvas = autoChooseUpright(enhancedMat);

  // 3) 输出到 A4 纵向目标（等比缩放居中，避免压缩）
  const finalCanvas = fitToA4Portrait(uprightCanvas);

  // 渲染与缓存
  latestResultCanvas = finalCanvas;
  const mat = cv.imread(finalCanvas);
  cv.imshow(resultCanvas, mat);
  mat.delete();
  enhancedMat.delete();

  downloadPngBtn.disabled = false;
  downloadJpgBtn.disabled = false;
}

/** 透视矫正（以实际四边形宽高为目标） + 基础增强（不强行套A4比） */
function enhanceAndWarp(canvas, quad) {
  const src = cv.imread(canvas);
  let warped = new cv.Mat();

  if (quad) {
    // 计算真实目标宽高（避免错认长短边造成压缩）
    const widthA  = dist(quad[2], quad[3]); // BR-BL
    const widthB  = dist(quad[1], quad[0]); // TR-TL
    const heightA = dist(quad[1], quad[2]); // TR-BR
    const heightB = dist(quad[0], quad[3]); // TL-BL

    const dstW = Math.max(Math.round(widthA),  Math.round(widthB));
    const dstH = Math.max(Math.round(heightA), Math.round(heightB));

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x, quad[0].y, // TL
      quad[1].x, quad[1].y, // TR
      quad[2].x, quad[2].y, // BR
      quad[3].x, quad[3].y  // BL
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      dstW - 1, 0,
      dstW - 1, dstH - 1,
      0, dstH - 1
    ]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, warped, M, new cv.Size(dstW, dstH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    srcTri.delete(); dstTri.delete(); M.delete();
  } else {
    warped = src.clone();
  }

  // 增强
  let enhanced = enhanceImage(warped, enhanceModeEl.value);

  src.delete(); warped.delete();
  return enhanced; // Mat
}

/** 增强：光照均衡 + 阈值 + 去噪（或彩色增强） */
function enhanceImage(mat, mode='auto') {
  let rgb = new cv.Mat();
  cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);

  let gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

  let bg = new cv.Mat();
  cv.GaussianBlur(gray, bg, new cv.Size(0, 0), 35);
  let norm = new cv.Mat();
  cv.subtract(gray, bg, norm);
  cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);

  let bw = new cv.Mat();
  cv.adaptiveThreshold(norm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 10);

  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2,2));
  cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel);

  let out = new cv.Mat();
  if (mode === 'binarize') {
    out = bw.clone();
  } else if (mode === 'color') {
    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    let channels = new cv.MatVector();
    cv.split(lab, channels);
    cv.equalizeHist(channels.get(0), channels.get(0)); // L 通道均衡
    cv.merge(channels, lab);
    cv.cvtColor(lab, out, cv.COLOR_Lab2RGB);
    channels.delete(); lab.delete();
  } else {
    const mean = new cv.Mat();
    const stddev = new cv.Mat();
    cv.meanStdDev(norm, mean, stddev);
    const contrast = stddev.doubleAt(0,0);
    if (contrast > 30) {
      out = bw.clone();
    } else {
      out = new cv.Mat();
      cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
    }
    mean.delete(); stddev.delete();
  }

  rgb.delete(); gray.delete(); bg.delete(); norm.delete(); kernel.delete();
  return out;
}

/**
 * 自动选择正向（不依赖OCR）：
 * - 对 0/90/180/270 分别：OTSU二值 → 行/列投影方差 → score = max(rowVar, colVar)
 * - 选 score 最大的角度
 * - 最后强制纵向：若宽>高 → 逆时针旋转90°
 */
function autoChooseUpright(enhancedMat) {
  const candidates = [0, 90, 180, 270];
  let bestDeg = 0, bestScore = -Infinity;

  for (const deg of candidates) {
    const rotated = rotateMat(enhancedMat, deg);
    const { rowVar, colVar } = readabilityScore(rotated);
    const score = Math.max(rowVar, colVar);
    if (score > bestScore) { bestScore = score; bestDeg = deg; }
    rotated.delete();
  }

  // 应用最佳旋转
  let canvas = matToCanvas(rotateMat(enhancedMat, bestDeg));

  // 强制纵向（portrait）
  if (canvas.width > canvas.height) {
    canvas = rotateCanvas(canvas, 270); // CCW 90°
  }

  return canvas;
}

/** 计算可读性评分：行/列投影方差 */
function readabilityScore(mat) {
  const bw = new cv.Mat();
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

  const rows = bw.rows, cols = bw.cols;
  const rowSums = new Float64Array(rows);
  const colSums = new Float64Array(cols);

  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = 0; c < cols; c++) {
      if (bw.ucharPtr(r, c)[0] === 0) sum++; // 黑像素计数
    }
    rowSums[r] = sum;
  }
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) {
      if (bw.ucharPtr(r, c)[0] === 0) sum++;
    }
    colSums[c] = sum;
  }

  const rowVar = variance(rowSums);
  const colVar = variance(colSums);

  bw.delete(); gray.delete();
  return { rowVar, colVar };
}

function variance(arr) {
  let n = arr.length;
  if (n === 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += arr[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    let d = arr[i] - mean;
    v += d * d;
  }
  return v / n;
}

/** Mat 旋转为指定角度（0/90/180/270） */
function rotateMat(mat, deg) {
  let out = new cv.Mat();
  if (deg === 0) {
    out = mat.clone();
  } else if (deg === 90) {
    cv.rotate(mat, out, cv.ROTATE_90_CLOCKWISE);
  } else if (deg === 180) {
    cv.rotate(mat, out, cv.ROTATE_180);
  } else if (deg === 270) {
    cv.rotate(mat, out, cv.ROTATE_90_COUNTERCLOCKWISE);
  } else {
    out = mat.clone();
  }
  return out;
}

/** Mat -> Canvas */
function matToCanvas(mat) {
  const c = document.createElement('canvas');
  cv.imshow(c, mat);
  return c;
}

/** 旋转 Canvas 到指定角度（0/90/180/270） */
function rotateCanvas(inputCanvas, deg) {
  const rad = deg * Math.PI / 180;
  let outW = inputCanvas.width;
  let outH = inputCanvas.height;
  if (deg === 90 || deg === 270) {
    outW = inputCanvas.height;
    outH = inputCanvas.width;
  }
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx = out.getContext('2d');

  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.drawImage(inputCanvas, -inputCanvas.width / 2, -inputCanvas.height / 2);
  return out;
}

/**
 * 将纵向的结果Canvas按A4纵向目标等比缩放，居中放置（白底），避免拉伸压缩
 * targetShort: 1600/2400/3300（短边），targetLong=short/0.707（长边）
 */
function fitToA4Portrait(uprightCanvas) {
  const size = outputSizeEl.value; // m/h/uh
  const targetShort = size === 'm' ? 1600 : (size === 'h' ? 2400 : 3300);
  const targetLong  = Math.round(targetShort / A4_RATIO_W2H); // ≈ short/0.707
  const outW = targetShort, outH = targetLong;

  // 计算等比缩放
  const scale = Math.min(outW / uprightCanvas.width, outH / uprightCanvas.height);
  const newW = Math.round(uprightCanvas.width  * scale);
  const newH = Math.round(uprightCanvas.height * scale);

  // 绘制到白底目标画布，居中
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);

  const dx = Math.floor((outW - newW) / 2);
  const dy = Math.floor((outH - newH) / 2);
  ctx.drawImage(uprightCanvas, 0, 0, uprightCanvas.width, uprightCanvas.height, dx, dy, newW, newH);

  return out;
}

function detectQuad(canvas) {
  const src = cv.imread(canvas);
  try {
    let dst = new cv.Mat();
    cv.cvtColor(src, src, cv.COLOR_RGBA2RGB);
    cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);

    let bg = new cv.Mat();
    cv.GaussianBlur(dst, bg, new cv.Size(0, 0), 25);
    let norm = new cv.Mat();
    cv.subtract(dst, bg, norm);
    cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);

    let edges = new cv.Mat();
    cv.Canny(norm, edges, 50, 150);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let best = null;
    let bestScore = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4) {
        const rect = cv.boundingRect(approx);
        const area = rect.width * rect.height;
        const areaRatio = area / (src.cols * src.rows);
        if (areaRatio < 0.15) { approx.delete(); continue; }

        const pts = [];
        for (let r = 0; r < approx.rows; r++) {
          pts.push({ x: approx.intAt(r, 0), y: approx.intAt(r, 1) });
        }
        const ordered = orderQuad(pts);
        const w = dist(ordered[0], ordered[1]);
        const h = dist(ordered[0], ordered[3]);
        const ratio = w / h;
        const rDiff = Math.abs(ratio - A4_RATIO_W2H);
        const score = areaRatio * (1 - rDiff);
        if (score > bestScore) {
          bestScore = score;
          best = ordered;
        }
        approx.delete();
      } else {
        approx.delete();
      }
    }

    edges.delete(); contours.delete(); hierarchy.delete(); dst.delete(); bg.delete(); norm.delete();

    if (!best) { src.delete(); return null; }
    src.delete();
    return best;
  } catch (e) {
    console.error(e);
    src.delete();
    return null;
  }
}

function orderQuad(points) {
  const pts = points.slice();
  const sumSort = [...pts].sort((a,b)=> (a.x + a.y) - (b.x + b.y));
  const diffSort = [...pts].sort((a,b)=> (a.x - a.y) - (b.x - b.y));
  const tl = sumSort[0];
  const br = sumSort[sumSort.length - 1];
  const tr = diffSort[diffSort.length - 1];
  const bl = diffSort[0];
  return [tl, tr, br, bl];
}
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx + dy*dy); }
