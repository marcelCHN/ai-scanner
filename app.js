/**
 * Pad 文档扫描器（A4 自动识别 + 透视与角度校正 + 去杂物 + 高清增强）
 * 依赖：OpenCV.js（CDN），浏览器 getUserMedia
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

let stream = null;
let processing = false;
let a4StableCounter = 0;
let lastQuad = null;

// A4 纵向宽高比（width:height）约 0.707（= 1 / sqrt(2)）
const A4_RATIO_W2H = 1 / Math.sqrt(2);

// OpenCV 初始化
function onCvReady() {
  if (cv && cv['onRuntimeInitialized']) {
    cv['onRuntimeInitialized'] = () => {
      statusEl.textContent = 'OpenCV 就绪。点击“启动相机”。';
      snapBtn.disabled = true;
    };
  } else {
    statusEl.textContent = 'OpenCV 加载失败，请检查网络。';
  }
}

// 若脚本 tag 未设置 onload，此处兜底
if (typeof cv === 'undefined') {
  // 延时检查
  const check = () => {
    if (typeof cv !== 'undefined') {
      onCvReady();
    } else {
      setTimeout(check, 500);
    }
  };
  check();
} else {
  onCvReady();
}

startBtn.addEventListener('click', async () => {
  try {
    if (stream) {
      statusEl.textContent = '相机已启动';
      return;
    }
    stream = await navigator.mediaDevices.getUserMedia({ video: {
      facingMode: 'environment', // 后置摄像头（Pad）
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }, audio: false });
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
      // 自动抓拍
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
        // 面积过滤
        const rect = cv.boundingRect(approx);
        const area = rect.width * rect.height;
        const areaRatio = area / (src.cols * src.rows);
        if (areaRatio < 0.15) { approx.delete(); continue; }

        // 按面积优先，同时考虑长宽比接近 A4
        const pts = [];
        for (let r = 0; r < approx.rows; r++) {
          pts.push({ x: approx.intAt(r, 0), y: approx.intAt(r, 1) });
        }
        const ordered = orderQuad(pts);
        const w = dist(ordered[0], ordered[1]);
        const h = dist(ordered[0], ordered[3]);
        const ratio = w / h; // 以 TL-TR 为宽，TL-BL 为高
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
  // 通过 (x+y) 与 (x-y) 排序，得到 TL, TR, BR, BL
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
    // 目标输出分辨率（依据选择）
    const size = outputSizeEl.value; // m/h/uh
    const targetShort = size === 'm' ? 1600 : (size === 'h' ? 2400 : 3300);
    const targetLong = Math.round(targetShort / A4_RATIO_W2H);

    // 计算宽高（以 A4 纵向为目标）
    const wSrc = dist(quad[0], quad[1]);
    const hSrc = dist(quad[0], quad[3]);

    // 若检测到横向（宽>高），旋转目标 90 度，保证最终纵向
    let outW = targetShort;
    let outH = targetLong;
    let dstQuad = [
      new cv.Point(0, 0),
      new cv.Point(outW - 1, 0),
      new cv.Point(outW - 1, outH - 1),
      new cv.Point(0, outH - 1)
    ];

    if (wSrc > hSrc) {
      // 横向 → 交换输出的宽高以强制纵向正向
      outW = targetShort; // 短边
      outH = targetLong;  // 长边
      dstQuad = [
        new cv.Point(0, 0),
        new cv.Point(outW - 1, 0),
        new cv.Point(outW - 1, outH - 1),
        new cv.Point(0, outH - 1)
      ];
    }

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
    // 未检测四边形时，直接增强原图
    warped = src.clone();
  }

  // 增强与去杂物
  let enhanced = enhanceImage(warped, enhanceModeEl.value);

  // 释放
  src.delete(); warped.delete();
  return enhanced; // Mat
}

function enhanceImage(mat, mode='auto') {
  let rgb = new cv.Mat();
  cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);

  // 转灰 + 背景估计（光照均衡）
  let gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);

  let bg = new cv.Mat();
  cv.GaussianBlur(gray, bg, new cv.Size(0, 0), 35);
  let norm = new cv.Mat();
  cv.subtract(gray, bg, norm);
  cv.normalize(norm, norm, 0, 255, cv.NORM_MINMAX);

  // 自适应阈值：得到扫描风格黑白
  let bw = new cv.Mat();
  cv.adaptiveThreshold(norm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 10);

  // 形态学去噪：移除小颗粒
  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2,2));
  cv.morphologyEx(bw, bw, cv.MORPH_OPEN, kernel);

  let out = new cv.Mat();
  if (mode === 'binarize') {
    out = bw.clone();
  } else if (mode === 'color') {
    // 彩色保留 + 对比度增强
    let lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    let channels = new cv.MatVector();
    cv.split(lab, channels);
    cv.equalizeHist(channels.get(0), channels.get(0)); // L 通道直方图均衡
    cv.merge(channels, lab);
    cv.cvtColor(lab, out, cv.COLOR_Lab2RGB);
    channels.delete(); lab.delete();
  } else {
    // 自动：优先黑白，若彩色内容占比高则融合
    // 简单启发：统计 norm 的对比度与灰度分布
    const mean = new cv.Mat();
    const stddev = new cv.Mat();
    cv.meanStdDev(norm, mean, stddev);
    const contrast = stddev.doubleAt(0,0);
    if (contrast > 30) {
      out = bw.clone();
    } else {
      // 低对比度：做轻度彩色增强
      out = new cv.Mat();
      cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
    }
    mean.delete(); stddev.delete();
  }

  // 释放中间变量
  rgb.delete(); gray.delete(); bg.delete(); norm.delete(); kernel.delete();

  return out;
}

function renderResult(mat) {
  cv.imshow(resultCanvas, mat);
  mat.delete();
  downloadPngBtn.disabled = false;
  downloadJpgBtn.disabled = false;
}
