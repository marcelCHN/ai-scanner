/**
 * Pad 文档扫描器（A4 自动识别 + 透视与角度校正 + 去杂物 + 高清增强 + 文字方向矫正）
 * 依赖：OpenCV.js（本地）、浏览器 getUserMedia、Tesseract.js（OSD）
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
const textOrientationFixEl = document.getElementById('textOrientationFix');

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
  await processAndRender(frame, quad, '拍摄');
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  statusEl.textContent = '正在读取图片…';

  const img = new Image();
  img.onload = async () => {
    const canvas = document.createElement('canvas');
    const maxSide = 2000;
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

/** 高层流程：透视矫正 + 增强 + 文字方向矫正 + 渲染 */
async function processAndRender(canvas, quad, sourceLabel='') {
  if (!quad) {
    statusEl.textContent = `未检测到 A4 四边形（${sourceLabel}），已增强原图。`;
  } else {
    statusEl.textContent = `已生成扫描件（${sourceLabel}）。`;
  }

  const warpedMat = enhanceAndWarp(canvas, quad); // Mat（增强前的透视已做）
  const orientedCanvas = await ensureUprightByText(warpedMat); // Canvas
  cv.imshow(resultCanvas, cv.imread(orientedCanvas));
  warpedMat.delete();

  downloadPngBtn.disabled = false;
  downloadJpgBtn.disabled = false;
}

/**
 * 透视矫正 + 角度校正（确保纵向输出）+ 基础增强
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

  // 增强
  let enhanced = enhanceImage(warped, enhanceModeEl.value);
  src.delete(); warped.delete();
  return enhanced; // Mat
}

/** 基础增强：光照均衡 + 阈值 + 去噪（或彩色增强） */
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
 * 文字方向矫正：优先使用 Tesseract.detect（OSD），失败则备用 Hough 估计
 * 输入：增强后的 Mat
 * 输出：Canvas（正向）
 */
async function ensureUprightByText(enhancedMat) {
  // 把 Mat 显示到临时 canvas 供识别
  const tmpCanvas = document.createElement('canvas');
  cv.imshow(tmpCanvas, enhancedMat);

  // 若未启用或 Tesseract 不存在，走备用估计
  if (!textOrientationFixEl.checked || typeof Tesseract === 'undefined') {
    const deg = estimateQuarterRotationByHough(tmpCanvas);
    return rotateCanvas(tmpCanvas, deg);
  }

  try {
    // 使用 OSD（Orientation and Script Detection）
    const detection = await Tesseract.detect(tmpCanvas);
    // 新版返回可能为 detection.data 或 detection 中的 orientation，做兼容：
    const data = detection.data || detection;
    const deg = (data.orientation && data.orientation.degrees) || data.degrees || 0;

    // 仅接受 0/90/180/270，非这几种则走备用估计
    const allowed = new Set([0, 90, 180, 270]);
    if (!allowed.has(deg)) {
      const fallbackDeg = estimateQuarterRotationByHough(tmpCanvas);
      return rotateCanvas(tmpCanvas, fallbackDeg);
    }
    return rotateCanvas(tmpCanvas, deg);
  } catch (e) {
    console.warn('Tesseract OSD 失败，改用备用估计：', e);
    const deg = estimateQuarterRotationByHough(tmpCanvas);
    return rotateCanvas(tmpCanvas, deg);
  }
}

/** 备用估计：通过 Hough 线倾角，粗判 0/90（无法可靠判 180） */
function estimateQuarterRotationByHough(canvas) {
  try {
    const src = cv.imread(canvas);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    let edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150);

    let lines = new cv.Mat();
    cv.HoughLines(edges, lines, 1, Math.PI/180, 120); // 参数可调

    // 统计角度聚类，判断是否接近竖排（~90°）或横排（~0°）
    let countNear0 = 0;
    let countNear90 = 0;
    for (let i = 0; i < lines.rows; i++) {
      const rho = lines.data32F[i*2];
      const theta = lines.data32F[i*2 + 1];
      // 以度计算
      const deg = theta * 180 / Math.PI;
      // 接近 0°（或 180°）记入横排
      if (Math.min(Math.abs(deg - 0), Math.abs(deg - 180)) < 10) countNear0++;
      // 接近 90°记入竖排
      if (Math.abs(deg - 90) < 10) countNear90++;
    }
    src.delete(); gray.delete(); edges.delete(); lines.delete();

    // 若竖线占优，旋转 90；否则保持 0（无法区分 180）
    if (countNear90 > countNear0 * 1.5) return 90;
    return 0;
  } catch (e) {
    console.warn('Hough 估计失败：', e);
    return 0;
  }
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
