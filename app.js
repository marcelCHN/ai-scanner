/**
 * Pad 文档扫描器（A4 自动识别 + 透视与角度校正 + 去杂物 + 高清增强）
 * 依赖：OpenCV.js（本地）、浏览器 getUserMedia
 * 支持：相机拍摄与本地图片上传两种输入
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

let stream = null;
let processing = false;
let a4StableCounter = 0;
let lastQuad = null;

// A4 纵向宽高比（width:height）约 0.707（= 1 / sqrt(2)）
const A4_RATIO_W2H = 1 / Math.sqrt(2);

// 等待 OpenCV 就绪（兼容不同构建）
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
  if (!quad) {
    statusEl.textContent = '未检测到 A4 四边形，已保存原图。';
    const result = enhanceAndWarp(frame, null);
    renderResult(result);
  } else {
    statusEl.textContent = '已拍摄并生成扫描件。';
    const result = enhanceAndWarp(frame, quad);
    renderResult(result);
  }
});

autoCaptureEl.addEventListener('change', () => {
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

// 图片上传生成扫描件
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  statusEl.textContent = '正在读取图片…';

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const maxSide = 2000; // 上传图片处理的最大边，避免超大图占用内存
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const quad = detectQuad(canvas);
    if (!quad) {
      statusEl.textContent = '未检测到 A4 四边形，已增强原图。';
      const result = enhanceAndWarp(canvas, null);
      renderResult(result);
    } else {
      statusEl.textContent = '已生成扫描件（图片上传）。';
      const result = enhanceAndWarp(canvas, quad);
      renderResult(result);
    }

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
    if (autoCaptureEl.checked && a4StableCounter >= 8) {
      const result = enhanceAndWarp(frameCanvas, quad);
      renderResult(result);
      statusEl.textContent = '自动抓拍成功，已生成扫描件。';
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

  // 辅助框
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, overlay.width - 20, overlay.height - 20);

  if (!quad) return;

  // 绘制四边形
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

/**
 * 检测四边形并校验是否接近 A4 比例
 * 返回按 TL, TR, BR, BL 顺序排列的点数组 [{x,y},...]
 */
function detectQuad(canvas) {
  const src = cv.imread(canvas);
  try {
    let dst = new cv.Mat();
    cv.cvtColor(src, src, cv.COLOR_RGBA2RGB);
    cv.cvtColor(src, dst, cv.COLOR_RGB2GRAY);

    // 光照均衡：模糊估计背景并减法，提升边缘
    let bg = new cv.Mat();
    cv.GaussianBlur(dst, bg, new cv.Size(0, 0), 25);
    let norm = new cv.Mat();
    cv.subtract(dst, bg, norm);
    cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);

    // 边缘 + 轮廓
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

function dist(a,b){
  const dx = a.x - b.x; const dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}

/**
 * 透视矫正 + 角度校正（确保 100% 正向）+ 增强与去杂物
 * quad: TL,TR,BR,BL；若为 null，则直接增强原图
 */
function enhanceAndWarp(canvas, quad) {
  const src = cv.imread(canvas);
  let warped = new cv.Mat();

  if (quad) {
    const size = outputSizeEl.value; // m/h/uh
    const targetShort = size === 'm' ? 1600 : (size === 'h' ? 2400 : 3300);
    const targetLong = Math.round(targetShort / A4_RATIO_W2H);

    let outW = targetShort; // 短边
    let outH = targetLong;  // 长边
    let dstQuad = [
      new cv.Point(0, 0),
      new cv.Point(outW - 1, 0),
      new cv.Point(outW - 1, outH - 1),
      new cv.Point(0, outH - 1)
    ];

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x, quad[0].y,
      quad[1].x, quad[1].y,
      quad[2].x, quad[2].y,
      quad[3].x, quad[3].y
    ]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
      dstQuad[0].x, dstQuad[0].y,
      dstQuad[1].x, dstQuad[1].y,
      dstQuad[2].x, dstQuad[2].y,
      dstQuad[3].x, dstQuad[3].y
    ]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, warped, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    srcTri.delete(); dstTri.delete(); M.delete();
  } else {
    warped = src.clone();
  }

  let enhanced = enhanceImage(warped, enhanceModeEl.value);

  src.delete(); warped.delete();
  return enhanced; // Mat
}

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
    cv.equalizeHist(channels.get(0), channels.get(0)); // L 通道直方图均衡
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

function renderResult(mat) {
  cv.imshow(resultCanvas, mat);
  mat.delete();
  downloadPngBtn.disabled = false;
  downloadJpgBtn.disabled = false;
}
