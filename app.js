/*
 * AI Scanner — app.js (完整替换版)
 * 功能：多图上传、背景鲁棒文档检测、透视矫正、增强、自动正向、A4 输出、稳定渲染
 * 说明：不依赖 OCR；几何 + 纹理评分；上下密度校正 0/180；避免使用 cv.imshow
 */

(function(){
  const A4_W = 1240; // 约 150DPI 的 A4 尺寸（宽）
  const A4_H = 1754; // 约 150DPI 的 A4 尺寸（高）
  const statusBar = document.getElementById('statusBar');
  const fileInput = document.getElementById('fileInput');
  const resultCanvas = document.getElementById('resultCanvas');
  const thumbList = document.getElementById('thumbList');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const rctx = resultCanvas.getContext('2d');

  const scans = []; // {canvas: HTMLCanvasElement, name: string, meta: {...}}
  let currentIndex = -1;

  function setStatus(msg){ statusBar.textContent = msg; }

  function clearList(){ thumbList.innerHTML = ''; }

  function addScanResult(canvas, name){
    scans.push({canvas, name});
    const idx = scans.length - 1;
    const li = document.createElement('li');
    li.className = 'thumb-item';
    const tCanvas = document.createElement('canvas');
    tCanvas.width = 160; tCanvas.height = 200;
    tCanvas.getContext('2d').drawImage(canvas, 0, 0, tCanvas.width, tCanvas.height);
    li.appendChild(tCanvas);
    li.title = name;
    li.addEventListener('click', ()=>{ showScanByIndex(idx); });
    thumbList.appendChild(li);
    setStatus(`已生成扫描件 (${idx+1}/${scans.length})`);
  }

  function showScanByIndex(idx){
    if(idx<0 || idx>=scans.length) return;
    currentIndex = idx;
    const c = scans[idx].canvas;
    // 统一 A4 画布尺寸
    rctx.clearRect(0,0,resultCanvas.width,resultCanvas.height);
    rctx.drawImage(c, 0, 0, resultCanvas.width, resultCanvas.height);
    setStatus(`浏览 ${idx+1}/${scans.length}: ${scans[idx].name}`);
  }

  prevBtn.addEventListener('click', ()=>{
    if(scans.length===0) return;
    let idx = currentIndex<=0 ? 0 : currentIndex-1;
    showScanByIndex(idx);
  });
  nextBtn.addEventListener('click', ()=>{
    if(scans.length===0) return;
    let idx = currentIndex>=scans.length-1 ? scans.length-1 : currentIndex+1;
    showScanByIndex(idx);
  });

  fileInput.addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files||[]);
    if(files.length===0) return;
    clearList(); scans.splice(0, scans.length); currentIndex = -1;
    setStatus('初始化中...');
    await processAndRender(files);
  });

  async function processAndRender(files){
    for(const f of files){
      setStatus(`加载 ${f.name}...`);
      const img = await readImageFile(f);
      setStatus(`处理 ${f.name}...`);
      const srcCanvas = imageToCanvas(img);
      ensureOpenCVReady();
      let src = cv.imread(srcCanvas);
      let finalCanvas = pipelineToFinalCanvas(src);
      src.delete();
      addScanResult(finalCanvas, f.name);
      if(currentIndex===-1) showScanByIndex(0);
    }
    setStatus('全部处理完成');
  }

  function readImageFile(file){
    return new Promise((resolve,reject)=>{
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }
  function imageToCanvas(img){
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }
  function ensureOpenCVReady(){
    if(typeof cv!=='object' || !cv.Mat) throw new Error('OpenCV.js 未就绪');
  }

  // 主管线：Detect -> Warp -> Enhance -> Auto-Upright -> Fit A4
  function pipelineToFinalCanvas(src){
    // 1) 背景鲁棒文档区域检测
    const quad = detectPaperRegion(src) || fallbackByEdges(src);

    // 2) 透视矫正到近似 A4 尺寸（矫正阶段用中等分辨率）
    const warped = warpToA4(src, quad, A4_W, A4_H);

    // 3) 增强（CLAHE + 轻度降噪 + 自适应阈值可选）
    const enhanced = enhanceMat(warped);
    warped.delete();

    // 4) 自动正向（0/90/180/270 评分 + 0/180 上下密度修正）
    const upright = autoUprightByScoring(enhanced);
    const fixed = autoFix180ByTopBottom(upright);

    // 5) 输出到 A4 画布（统一分辨率）
    const outCanvas = matToCanvas(fixed, A4_W, A4_H);
    fixed.delete(); enhanced.delete();
    return outCanvas;
  }

  // ===== 背景鲁棒检测 =====
  function detectPaperRegion(src){
    try{
      // 转换到 Lab / HSV
      const lab = new cv.Mat(); cv.cvtColor(src, lab, cv.COLOR_RGBA2Lab);
      const hsv = new cv.Mat(); cv.cvtColor(src, hsv, cv.COLOR_RGBA2HSV);

      const labSplit = new cv.MatVector(); cv.split(lab, labSplit);
      const L = labSplit.get(0);
      const hsvSplit = new cv.MatVector(); cv.split(hsv, hsvSplit);
      const S = hsvSplit.get(1);

      const Lth = percentileThreshold(L, 70);
      const Sth = percentileThreshold(S, 35);
      const maskL = threshGreater(L, Lth);
      const maskS = threshLess(S, Sth);
      const mask = new cv.Mat(); cv.bitwise_and(maskL, maskS, mask);

      // 去噪 + 闭操作
      cv.medianBlur(mask, mask, 5);
      const kernel = cv.Mat.ones(5,5,cv.CV_8U);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);

      // 轮廓
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      let bestQuad = null; let bestScore = -1;
      for(let i=0;i<contours.size();i++){
        const c = contours.get(i);
        const peri = cv.arcLength(c, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, 0.02*peri, true);
        const quad = getQuadOrMinRect(approx, c);
        const score = scoreCandidate(quad, src);
        if(score>bestScore){ bestScore=score; bestQuad=quad; }
        approx.delete(); c.delete();
      }

      // 清理
      lab.delete(); hsv.delete(); labSplit.delete(); hsvSplit.delete();
      L.delete(); S.delete(); maskL.delete(); maskS.delete(); mask.delete();
      contours.delete(); hierarchy.delete(); kernel.delete();

      return bestQuad;
    }catch(err){
      console.warn('detectPaperRegion error', err);
      return null;
    }
  }

  function percentileThreshold(mat, p){
    // 近似分位数阈值：采样像素并排序取百分位
    const data = mat.data; const n = data.length; const step = Math.max(1, Math.floor(n/5000));
    const arr = [];
    for(let i=0;i<n;i+=step){ arr.push(data[i]); }
    arr.sort((a,b)=>a-b);
    const idx = Math.min(arr.length-1, Math.floor((p/100)*arr.length));
    return arr[idx];
  }
  function threshGreater(mat, th){
    const out = new cv.Mat();
    cv.threshold(mat, out, th, 255, cv.THRESH_BINARY);
    return out;
  }
  function threshLess(mat, th){
    const out = new cv.Mat();
    cv.threshold(mat, out, th, 255, cv.THRESH_BINARY_INV);
    return out;
  }

  function getQuadOrMinRect(approx, contour){
    // 若逼近有4点，直接用；否则用 minAreaRect 的 boxPoints
    let points = [];
    if(approx.rows===4){
      for(let i=0;i<4;i++){
        points.push({
          x: approx.intPtr(i,0)[0],
          y: approx.intPtr(i,0)[1]
        });
      }
    }else{
      const rect = cv.minAreaRect(contour);
      const box = new cv.Mat();
      cv.boxPoints(rect, box);
      for(let i=0;i<4;i++){
        points.push({ x: box.floatAt(i,0), y: box.floatAt(i,1) });
      }
      box.delete();
    }
    // 排序为一致的顺序（tl,tr,br,bl）
    return orderQuad(points);
  }

  function orderQuad(pts){
    // 根据 x+y 最小为 tl，x+y 最大为 br，x-y 最大为 tr，x-y 最小为 bl
    const s = pts.map(p=>({p, s:p.x+p.y}));
    const d = pts.map(p=>({p, d:p.x-p.y}));
    const tl = s.reduce((a,b)=>a.s<b.s?a:b).p;
    const br = s.reduce((a,b)=>a.s>b.s?a:b).p;
    const tr = d.reduce((a,b)=>a.d>b.d?a:b).p;
    const bl = d.reduce((a,b)=>a.d<b.d?a:b).p;
    return [tl,tr,br,bl];
  }

  function scoreCandidate(quad, src){
    if(!quad) return -1;
    // 几何评分：长宽比接近 A4、面积占比、边缘长度/直线性
    const w1 = dist(quad[0], quad[1]);
    const w2 = dist(quad[3], quad[2]);
    const h1 = dist(quad[0], quad[3]);
    const h2 = dist(quad[1], quad[2]);
    const w = (w1+w2)/2; const h = (h1+h2)/2;
    const ratio = w>h ? w/h : h/w; // 统一>1
    const target = 1.414; // A4 理想比
    const geomRatioScore = Math.exp(-Math.abs(ratio-target));

    const area = polygonArea(quad);
    const imgArea = src.cols*src.rows;
    const areaScore = Math.min(1, area/(imgArea*0.8));

    // 纹理评分：将候选轻微仿射到小画布，做投影方差与Hough水平线密度
    const sample = warpToA4(src, quad, 480, 680);
    const textureScore = textureScoreByProjections(sample);
    sample.delete();

    // 综合
    return 0.6*geomRatioScore + 0.4*textureScore + 0.2*areaScore;
  }

  function textureScoreByProjections(mat){
    try{
      const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
      // CLAHE 增强
      const clahe = new cv.CLAHE(2.0, new cv.Size(8,8));
      const eq = new cv.Mat(); clahe.apply(gray, eq);
      clahe.delete(); gray.delete();
      // 垂直投影（沿行），计算方差
      const h = eq.rows, w = eq.cols;
      let rowMeans = new Float32Array(h);
      for(let y=0;y<h;y++){
        let sum=0; for(let x=0;x<w;x++){ sum += eq.ucharPtr(y,x)[0]; }
        rowMeans[y] = sum/w;
      }
      const mean = rowMeans.reduce((a,b)=>a+b,0)/h;
      const variance = rowMeans.reduce((a,b)=>a+(b-mean)*(b-mean),0)/h;
      eq.delete();
      // 归一化评分
      const score = Math.min(1, variance/800);
      return score;
    }catch(e){ return 0.2; }
  }

  function dist(a,b){
    const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy);
  }
  function polygonArea(pts){
    let s=0; for(let i=0;i<pts.length;i++){
      const j=(i+1)%pts.length; s += pts[i].x*pts[j].y - pts[j].x*pts[i].y;
    } return Math.abs(s/2);
  }

  // 兜底：传统边缘/轮廓最大四边形
  function fallbackByEdges(src){
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blurred = new cv.Mat(); cv.GaussianBlur(gray, blurred, new cv.Size(5,5), 0);
    const edges = new cv.Mat(); cv.Canny(blurred, edges, 50, 150);
    const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best=null; let bestArea=0;
    for(let i=0;i<contours.size();i++){
      const c = contours.get(i);
      const peri = cv.arcLength(c,true);
      const approx = new cv.Mat(); cv.approxPolyDP(c, approx, 0.02*peri, true);
      if(approx.rows>=4){
        const quad = getQuadOrMinRect(approx, c);
        const a = polygonArea(quad);
        if(a>bestArea){ bestArea=a; best=quad; }
      }
      approx.delete(); c.delete();
    }
    gray.delete(); blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete();
    return best;
  }

  function warpToA4(src, quad, outW, outH){
    const srcPts = cv.matFromArray(4,1,cv.CV_32FC2, [
      quad[0].x, quad[0].y,
      quad[1].x, quad[1].y,
      quad[2].x, quad[2].y,
      quad[3].x, quad[3].y,
    ]);
    const dstPts = cv.matFromArray(4,1,cv.CV_32FC2, [
      0,0, outW,0, outW,outH, 0,outH
    ]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(outW,outH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
    M.delete(); srcPts.delete(); dstPts.delete();
    return dst;
  }

  function enhanceMat(mat){
    const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    const clahe = new cv.CLAHE(2.0, new cv.Size(8,8));
    const eq = new cv.Mat(); clahe.apply(gray, eq);
    clahe.delete(); gray.delete();
    const denoise = new cv.Mat(); cv.bilateralFilter(eq, denoise, 7, 50, 50);
    eq.delete();
    const out = new cv.Mat(); cv.cvtColor(denoise, out, cv.COLOR_GRAY2RGBA);
    denoise.delete();
    return out;
  }

  function autoUprightByScoring(mat){
    // 0/90/180/270 评分：投影方差 + 水平线估计
    let best=null; let bestScore=-1; let bestAngle=0;
    const angles=[0,90,180,270];
    for(const ang of angles){
      const rotated = rotateMat(mat, ang);
      const score = uprightScore(rotated);
      if(score>bestScore){ bestScore=score; best=rotated; bestAngle=ang; } else { rotated.delete(); }
    }
    setStatus(`自动正向角度：${bestAngle}° (score=${bestScore.toFixed(3)})`);
    return best;
  }

  function uprightScore(mat){
    try{
      const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
      const h=gray.rows, w=gray.cols;
      // 水平线近似评分：Sobel X 的行内能量
      const sobelX = new cv.Mat(); cv.Sobel(gray, sobelX, cv.CV_16S, 1, 0, 3);
      const absX = new cv.Mat(); cv.convertScaleAbs(sobelX, absX);
      let rowMeans = new Float32Array(h);
      for(let y=0;y<h;y++){
        let sum=0; for(let x=0;x<w;x++){ sum += absX.ucharPtr(y,x)[0]; }
        rowMeans[y] = sum/w;
      }
      const mean = rowMeans.reduce((a,b)=>a+b,0)/h;
      const variance = rowMeans.reduce((a,b)=>a+(b-mean)*(b-mean),0)/h;
      gray.delete(); sobelX.delete(); absX.delete();
      return Math.min(1, variance/1200);
    }catch(e){ return 0.3; }
  }

  function rotateMat(mat, deg){
    if(deg===0) return mat.clone();
    const dst = new cv.Mat();
    const center = new cv.Point(mat.cols/2, mat.rows/2);
    const M = cv.getRotationMatrix2D(center, deg, 1);
    const bbox = new cv.Size(mat.cols, mat.rows);
    cv.warpAffine(mat, dst, M, bbox, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255,255,255,255));
    M.delete();
    return dst;
  }

  function autoFix180ByTopBottom(mat){
    // 上下密度对比：顶部常比底部空白多；若相反则翻转
    const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    const h=gray.rows, w=gray.cols;
    const top = gray.roi(new cv.Rect(0,0,w,Math.floor(h*0.2)));
    const bottom = gray.roi(new cv.Rect(0,Math.floor(h*0.8),w,Math.floor(h*0.2)));
    const topMean = meanUchar(top), bottomMean = meanUchar(bottom);
    top.delete(); bottom.delete(); gray.delete();
    // 亮度高意味着更空白，若底部更空白则倒置，需旋转 180
    if(bottomMean - topMean > 8){ // 阈值可微调
      const flipped = rotateMat(mat, 180);
      mat.delete();
      setStatus('180° 修正：已翻正');
      return flipped;
    }
    return mat;
  }
  function meanUchar(mat){
    const h=mat.rows, w=mat.cols; let sum=0;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) sum += mat.ucharPtr(y,x)[0];
    return sum/(h*w);
  }

  function matToCanvas(mat, outW, outH){
    const c = document.createElement('canvas'); c.width=outW; c.height=outH;
    const rgba = new cv.Mat();
    if(mat.type()!==cv.CV_8UC4){ cv.cvtColor(mat, rgba, cv.COLOR_RGBA2RGBA); } else { rgba=mat.clone(); }
    const imgData = new ImageData(outW, outH);
    // 将 mat 尺寸适配 outW/outH
    const resized = new cv.Mat(); cv.resize(rgba, resized, new cv.Size(outW,outH), 0,0, cv.INTER_AREA);
    // 拷贝像素
    const bytes = resized.data; imgData.data.set(bytes);
    const ctx = c.getContext('2d'); ctx.putImageData(imgData, 0, 0);
    resized.delete(); rgba.delete();
    return c;
  }

})();
