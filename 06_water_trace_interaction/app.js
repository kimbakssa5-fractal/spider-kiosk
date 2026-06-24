// 물결 Trace — 원본 ConvolutionFilterExample_1080.fla(AS3)의 로직을 그대로 재현 + 황금 잉어.
//
// 원본 알고리즘 (프레임 스크립트 분석 결과):
//   late = 8                       시뮬레이션 해상도 = 무대 / 8
//   bd1, bd2 : 저해상도 파동 버퍼   (conv(bd1) - bd2 반복 → 물결 확산)
//     expandFilter = ConvolutionFilter(3,3,[0.5,1,0.5,1,0,1,0.5,1,0.5],3)
//   bd_filter : 풀해상도 높이맵      (bd2 를 8배 확대 + 128 오프셋 → 0x7f 중심 회색)
//   displacementFilter = DisplacementMapFilter(bd_filter, BLUE→x, BLUE→y, scale 60, "wrap")
//     → 배경 mc 를 굴절(displace) 시킴   ← 실제 물 굴절 효과
//   bitmap(bd_filter).blendMode = MULTIPLY  → 높이맵 회색을 multiply 로 덧씌움 (음영)
//   draw() : 마우스다운/이동 시 흰색 원(Res_mc, 반경 16px)을 bd1 에 1/8 스케일로 스탬프
//
// === 06: 황금 잉어 추가 ===
//   원본의 비활성 Fish_Mv 를 되살린 것. 렌더는 3패스로 재구성:
//     ① 배경을 오프스크린 FBO(scene) 에 cover-fit 으로 그림
//     ② 잉어 스프라이트(koi-atlas.png, 알파)를 scene 위에 합성 → 물고기가 "물 속"에 있게 됨
//     ③ 물 셰이더가 scene(배경+물고기)을 높이맵으로 굴절 + 음영 → 잉어도 물결에 굴절/일렁임
//   잉어는 천천히 배회(wander)하며 헤엄치고, 꼬리 쪽에 아주 약한 잔물결(wake)을 남긴다.

(function () {
  "use strict";

  // ---- 상수 / 런타임 조정 파라미터 ----
  const LATE = 8;                                  // 시뮬레이션 다운스케일
  const KERNEL = [0.5, 1, 0.5, 1, 0, 1, 0.5, 1, 0.5];
  const KERNEL_DIVISOR = 3;
  // 화면 방향별 기본 배경: PC(가로) = 가로형(트리 90° 회전), 폰(세로) = 세로형
  const ASSET_VER = "2";
  const DEFAULT_BG_LANDSCAPE = "assets/fractal-tree-land.jpg?v=" + ASSET_VER;
  const DEFAULT_BG_PORTRAIT  = "assets/fractal-tree.jpg?v=" + ASSET_VER;

  // 키보드로 실시간 미세조정 (1/2 DAMPING, 3/4 DISP_SCALE, 5/6 SPLASH_RADIUS, 7/8 FPS)
  let SPLASH_RADIUS_PX = 18;
  let DISP_SCALE = 60;
  let FPS = 40;
  let STEP_MS = 1000 / FPS;
  let DAMPING = 0.992;

  // ---- 황금 잉어 파라미터 ----
  let FISH_COUNT = 6;                 // 동시에 헤엄치는 잉어 수 (9/0 키로 가감)
  const FISH_LEN_MIN = 0.12, FISH_LEN_MAX = 0.18;  // 화면 짧은변 대비 몸길이 비율
  const FISH_SPEED_MIN = 0.035, FISH_SPEED_MAX = 0.060; // 화면 짧은변/초 (유유히)
  const FISH_WAKE_PEAK = 26;          // 잉어가 남기는 잔물결 진폭(아주 약하게)

  const canvas = document.getElementById("scene");
  const ambient = document.getElementById("ambient");
  const bgInput = document.getElementById("bgInput");
  const soundBtn = document.getElementById("soundBtn");
  const hideBtn = document.getElementById("hideBtn");
  const fsBtn = document.getElementById("fsBtn");
  const toolbar = document.getElementById("toolbar");
  const fpsEl = document.getElementById("fps");

  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true })
          || canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
  if (!gl) {
    document.body.insertAdjacentHTML("beforeend",
      '<div style="color:#fff;font:16px sans-serif;position:fixed;top:40%;width:100%;text-align:center">이 브라우저는 WebGL을 지원하지 않습니다.</div>');
    return;
  }

  // ---------------------------------------------------------------
  // 셰이더 (3패스)
  // ---------------------------------------------------------------
  // 풀스크린 정점 셰이더 (vUv = top-down, (0,0)=좌상단)
  const VS_FULL = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  // ① 배경 패스: cover-fit 배경을 scene FBO 에 그림
  const FS_BG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uBg;
    uniform vec2 uBgScale;
    uniform vec2 uBgOffset;
    void main() {
      vec2 imgUv = vUv * uBgScale + uBgOffset;
      gl_FragColor = vec4(texture2D(uBg, clamp(imgUv, 0.0, 1.0)).rgb, 1.0);
    }`;

  // ② 잉어 패스: 클립공간 정점 + 아틀라스 UV, 알파 블렌딩으로 scene 위 합성
  const VS_FISH = `
    attribute vec2 aClip;
    attribute vec2 aUv;
    varying vec2 vUvF;
    void main() {
      vUvF = aUv;
      gl_Position = vec4(aClip, 0.0, 1.0);
    }`;
  const FS_FISH = `
    precision highp float;
    varying vec2 vUvF;
    uniform sampler2D uKoi;
    void main() {
      vec4 c = texture2D(uKoi, vUvF);
      if (c.a < 0.01) discard;
      gl_FragColor = c;
    }`;

  // ③ 물 패스: scene(배경+잉어) 을 높이맵으로 굴절 + 회색 multiply 음영 → 화면
  //    scene 은 FBO(bottom-up) 라 세로를 뒤집어 샘플(1.0 - y). disp 부호는 원본과 동일.
  const FS_WATER = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uScene;
    uniform sampler2D uHeight;
    uniform vec2 uDispUv;
    void main() {
      float h = texture2D(uHeight, vUv).r;        // 0.502 .. 1.0
      vec2 disp = (h - 0.5) * uDispUv;
      vec2 suv = vec2(vUv.x + disp.x, 1.0 - vUv.y - disp.y);
      vec3 scene = texture2D(uScene, clamp(suv, 0.0, 1.0)).rgb;
      gl_FragColor = vec4(scene * h, 1.0);
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function makeProg(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  const progBg = makeProg(VS_FULL, FS_BG);
  const progFish = makeProg(VS_FISH, FS_FISH);
  const progWater = makeProg(VS_FULL, FS_WATER);

  // 풀스크린 삼각형 스트립
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // 프로그램별 attribute/uniform 위치
  const locBg = {
    aPos: gl.getAttribLocation(progBg, "aPos"),
    uBg: gl.getUniformLocation(progBg, "uBg"),
    uBgScale: gl.getUniformLocation(progBg, "uBgScale"),
    uBgOffset: gl.getUniformLocation(progBg, "uBgOffset"),
  };
  const locFish = {
    aClip: gl.getAttribLocation(progFish, "aClip"),
    aUv: gl.getAttribLocation(progFish, "aUv"),
    uKoi: gl.getUniformLocation(progFish, "uKoi"),
  };
  const locWater = {
    aPos: gl.getAttribLocation(progWater, "aPos"),
    uScene: gl.getUniformLocation(progWater, "uScene"),
    uHeight: gl.getUniformLocation(progWater, "uHeight"),
    uDispUv: gl.getUniformLocation(progWater, "uDispUv"),
  };
  gl.useProgram(progBg);    gl.uniform1i(locBg.uBg, 0);
  gl.useProgram(progFish);  gl.uniform1i(locFish.uKoi, 2);
  gl.useProgram(progWater); gl.uniform1i(locWater.uScene, 3); gl.uniform1i(locWater.uHeight, 1);

  // ---------------------------------------------------------------
  // 텍스처: 배경(0) · 높이맵(1) · 잉어아틀라스(2) · scene FBO(3)
  // ---------------------------------------------------------------
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  function makeTex(unit, wrap, filter) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return t;
  }

  const bgTex = makeTex(0, gl.CLAMP_TO_EDGE, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 30, 20, 255]));
  const heightTex = makeTex(1, gl.CLAMP_TO_EDGE, gl.LINEAR);
  const koiTex = makeTex(2, gl.CLAMP_TO_EDGE, gl.LINEAR);
  const sceneTex = makeTex(3, gl.CLAMP_TO_EDGE, gl.LINEAR);

  // scene FBO
  const fbo = gl.createFramebuffer();
  function resizeSceneTex() {
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvasW, canvasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------------------------------------------------------------
  // 배경 로딩 / 교체
  // ---------------------------------------------------------------
  let bgImage = null, bgW = 1, bgH = 1, bgReady = false;
  let usingDefaultBg = true;
  let currentDefaultSrc = null;
  function loadBackground(src) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      bgImage = img; bgW = img.width; bgH = img.height; bgReady = true;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      updateBgCover();
    };
    img.src = src;
  }
  function applyDefaultBg() {
    const landscape = window.innerWidth >= window.innerHeight;
    const src = landscape ? DEFAULT_BG_LANDSCAPE : DEFAULT_BG_PORTRAIT;
    if (src === currentDefaultSrc) return;
    currentDefaultSrc = src;
    loadBackground(src);
  }
  function useCustomBg(dataUrl) {
    usingDefaultBg = false;
    loadBackground(dataUrl);
  }

  bgInput.addEventListener("change", function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) { useCustomBg(ev.target.result); };
    reader.readAsDataURL(file);
  });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && /^image\//.test(file.type)) {
      const reader = new FileReader();
      reader.onload = function (ev) { useCustomBg(ev.target.result); };
      reader.readAsDataURL(file);
    }
  });

  // ---------------------------------------------------------------
  // 잉어 아틀라스 로딩 + 개체 생성
  // ---------------------------------------------------------------
  let koiAtlas = null, koiReady = false;   // {atlasW, atlasH, fish:[{x,y,w,h}]}
  let fishes = [];
  function loadKoi() {
    fetch("assets/koi-atlas.json").then(function (r) { return r.json(); }).then(function (meta) {
      const img = new Image();
      img.onload = function () {
        koiAtlas = meta;
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, koiTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        koiReady = true;
        spawnFishes();
      };
      img.src = "assets/koi-atlas.png";
    }).catch(function () { /* 잉어 없이도 물결은 동작 */ });
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function makeFish() {
    const n = koiAtlas.fish.length;
    const sprite = (Math.random() * n) | 0;
    return {
      sprite: sprite,
      nx: Math.random(), ny: Math.random(),        // 위치(정규화 top-down 0..1)
      heading: Math.random() * Math.PI * 2,
      lenFrac: rand(FISH_LEN_MIN, FISH_LEN_MAX),
      speedFrac: rand(FISH_SPEED_MIN, FISH_SPEED_MAX),
      turnFreq: rand(0.08, 0.22), turnPhase: Math.random() * 6.28, turnAmp: rand(0.25, 0.55),
      swimFreq: rand(5.0, 7.0), swimPhase: Math.random() * 6.28, swimAmp: rand(0.06, 0.13),
      rip: rand(0, 0.4), ripEvery: rand(0.28, 0.45),
    };
  }
  function spawnFishes() {
    fishes = [];
    for (let i = 0; i < FISH_COUNT; i++) fishes.push(makeFish());
    fishVerts = new Float32Array(FISH_COUNT * 6 * 4);
  }

  let fishBuf = gl.createBuffer();
  let fishVerts = new Float32Array(0);

  // ---------------------------------------------------------------
  // 크기 / 시뮬레이션 그리드
  // ---------------------------------------------------------------
  let canvasW = 0, canvasH = 0, gridW = 0, gridH = 0;
  let bufA = null, bufB = null;
  let heightData = null;

  function updateBgCover() {
    if (!bgReady) return;
    const scale = Math.max(canvasW / bgW, canvasH / bgH);
    const dw = bgW * scale, dh = bgH * scale;
    const dx = (canvasW - dw) / 2, dy = (canvasH - dh) / 2;
    gl.useProgram(progBg);
    gl.uniform2f(locBg.uBgScale, canvasW / dw, canvasH / dh);
    gl.uniform2f(locBg.uBgOffset, -dx / dw, -dy / dh);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasW = Math.round(window.innerWidth * dpr);
    canvasH = Math.round(window.innerHeight * dpr);
    canvas.width = canvasW;
    canvas.height = canvasH;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    gl.viewport(0, 0, canvasW, canvasH);

    gridW = Math.max(1, Math.round(canvasW / LATE));
    gridH = Math.max(1, Math.round(canvasH / LATE));
    bufA = new Float32Array(gridW * gridH);
    bufB = new Float32Array(gridW * gridH);
    heightData = new Uint8Array(gridW * gridH * 4);
    for (let i = 3; i < heightData.length; i += 4) heightData[i] = 255;

    resizeSceneTex();
    applyDispScale();
    updateBgCover();
    if (usingDefaultBg) applyDefaultBg();
  }
  function applyDispScale() {
    gl.useProgram(progWater);
    gl.uniform2f(locWater.uDispUv, DISP_SCALE / canvasW, DISP_SCALE / canvasH);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  document.addEventListener("fullscreenchange", resize);
  document.addEventListener("webkitfullscreenchange", resize);

  // ---------------------------------------------------------------
  // 파동 발생 (Res_mc 흰 원 스탬프)
  // ---------------------------------------------------------------
  function splash(cssX, cssY, peak) {
    const amp = peak == null ? 255 : peak;
    const dpr = canvasW / (window.innerWidth || canvasW);
    const gx = (cssX * dpr) / LATE;
    const gy = (cssY * dpr) / LATE;
    const r = Math.max(1.5, (SPLASH_RADIUS_PX * dpr) / LATE);
    const minX = Math.max(0, Math.floor(gx - r)), maxX = Math.min(gridW - 1, Math.ceil(gx + r));
    const minY = Math.max(0, Math.floor(gy - r)), maxY = Math.min(gridH - 1, Math.ceil(gy + r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - gx, dy = y - gy;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d <= 1) {
          const v = amp * (0.5 + 0.5 * Math.cos(Math.PI * d));
          const i = y * gridW + x;
          if (v > bufA[i]) bufA[i] = v;
        }
      }
    }
  }

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", function (e) {
    splash(e.clientX, e.clientY);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener("pointermove", function (e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) splash(ev.clientX, ev.clientY);
  });

  // ---------------------------------------------------------------
  // 파동 시뮬레이션
  // ---------------------------------------------------------------
  function clampIdx(v, max) { return v < 0 ? 0 : (v > max ? max : v); }
  function step() {
    const w = gridW, h = gridH, A = bufA, B = bufB, hd = heightData;
    for (let y = 0; y < h; y++) {
      const y0 = clampIdx(y - 1, h - 1) * w, y1 = y * w, y2 = clampIdx(y + 1, h - 1) * w;
      for (let x = 0; x < w; x++) {
        const x0 = clampIdx(x - 1, w - 1), x2 = clampIdx(x + 1, w - 1);
        const sum =
          KERNEL[0] * A[y0 + x0] + KERNEL[1] * A[y0 + x] + KERNEL[2] * A[y0 + x2] +
          KERNEL[3] * A[y1 + x0] + KERNEL[4] * A[y1 + x] + KERNEL[5] * A[y1 + x2] +
          KERNEL[6] * A[y2 + x0] + KERNEL[7] * A[y2 + x] + KERNEL[8] * A[y2 + x2];
        let v = (sum / KERNEL_DIVISOR - B[y1 + x]) * DAMPING;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        B[y1 + x] = v;
        const g = (v + 128) | 0;
        const di = (y1 + x) * 4;
        const gg = g > 255 ? 255 : g;
        hd[di] = gg; hd[di + 1] = gg; hd[di + 2] = gg;
      }
    }
    bufA = B; bufB = A;
  }

  // ---------------------------------------------------------------
  // 잉어 업데이트 + 정점 빌드
  //   위치/회전 계산은 top-down(화면) px 공간에서 → 정규화 → 클립으로 매핑.
  //   클립 y 는 1-2*ny (물 패스의 세로 뒤집힘과 정합 → 화면에 바르게 나옴).
  // ---------------------------------------------------------------
  function updateFishes(dtSec, tSec, W, H) {
    if (!koiReady || !fishes.length) return 0;
    if (W == null) W = window.innerWidth;
    if (H == null) H = window.innerHeight;
    const minDim = Math.min(W, H);
    let vi = 0;
    for (let k = 0; k < fishes.length; k++) {
      const f = fishes[k];
      // 천천히 배회: heading 에 느린 사인 흔들림
      f.heading += Math.sin(tSec * f.turnFreq * 6.2831 + f.turnPhase) * f.turnAmp * dtSec;
      const lenPx = f.lenFrac * minDim;
      const speedPx = f.speedFrac * minDim;
      // 이동(heading 방향). 정규화 좌표로 누적(축별 px→정규화).
      f.nx += Math.cos(f.heading) * speedPx * dtSec / W;
      f.ny += Math.sin(f.heading) * speedPx * dtSec / H;
      // 화면 밖으로 완전히 나가면 반대편에서 재등장
      const mx = lenPx / W, my = lenPx / H;
      if (f.nx < -mx) f.nx = 1 + mx; else if (f.nx > 1 + mx) f.nx = -mx;
      if (f.ny < -my) f.ny = 1 + my; else if (f.ny > 1 + my) f.ny = -my;

      // 헤엄치는 요(yaw) 흔들림 — 몸이 좌우로 살랑이는 느낌
      const drawH = f.heading + Math.sin(tSec * f.swimFreq + f.swimPhase) * f.swimAmp;
      const fwdx = Math.cos(drawH), fwdy = Math.sin(drawH);
      const sidx = -Math.sin(drawH), sidy = Math.cos(drawH);

      const m = koiAtlas.fish[f.sprite];
      const aspect = m.h / m.w;
      const hl = lenPx * 0.5, hw = hl * aspect;
      const cx = f.nx * W, cy = f.ny * H;   // 중심(px, top-down)

      const u0 = m.x / koiAtlas.atlasW, u1 = (m.x + m.w) / koiAtlas.atlasW;
      const v0 = m.y / koiAtlas.atlasH, v1 = (m.y + m.h) / koiAtlas.atlasH;

      // 네 모서리(px) → 클립. A:head-top B:head-bot C:tail-top D:tail-bot
      const Ax = cx + fwdx * hl - sidx * hw, Ay = cy + fwdy * hl - sidy * hw;
      const Bx = cx + fwdx * hl + sidx * hw, By = cy + fwdy * hl + sidy * hw;
      const Cx = cx - fwdx * hl - sidx * hw, Cy = cy - fwdy * hl - sidy * hw;
      const Dx = cx - fwdx * hl + sidx * hw, Dy = cy - fwdy * hl + sidy * hw;
      function px2clip(out, oi, X, Y, u, v) {
        out[oi] = (X / W) * 2 - 1; out[oi + 1] = 1 - (Y / H) * 2;
        out[oi + 2] = u; out[oi + 3] = v;
      }
      px2clip(fishVerts, vi, Ax, Ay, u1, v0); vi += 4;
      px2clip(fishVerts, vi, Bx, By, u1, v1); vi += 4;
      px2clip(fishVerts, vi, Cx, Cy, u0, v0); vi += 4;
      px2clip(fishVerts, vi, Cx, Cy, u0, v0); vi += 4;
      px2clip(fishVerts, vi, Bx, By, u1, v1); vi += 4;
      px2clip(fishVerts, vi, Dx, Dy, u0, v1); vi += 4;

      // 꼬리 쪽에 아주 약한 잔물결(wake)
      f.rip -= dtSec;
      if (f.rip <= 0) {
        f.rip = f.ripEvery;
        splash(cx - fwdx * hl, cy - fwdy * hl, FISH_WAKE_PEAK);
      }
    }
    return vi / 4; // 정점 수
  }

  // ---------------------------------------------------------------
  // 렌더 (3패스)
  // ---------------------------------------------------------------
  function renderScene(fishVertCount) {
    // 높이맵 업로드
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridW, gridH, 0, gl.RGBA, gl.UNSIGNED_BYTE, heightData);

    // ① 배경 → scene FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(progBg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(locBg.aPos);
    gl.vertexAttribPointer(locBg.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ② 잉어 → scene FBO (알파 블렌딩)
    if (fishVertCount > 0) {
      gl.useProgram(progFish);
      gl.bindBuffer(gl.ARRAY_BUFFER, fishBuf);
      gl.bufferData(gl.ARRAY_BUFFER, fishVerts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(locFish.aClip);
      gl.vertexAttribPointer(locFish.aClip, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(locFish.aUv);
      gl.vertexAttribPointer(locFish.aUv, 2, gl.FLOAT, false, 16, 8);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, fishVertCount);
      gl.disable(gl.BLEND);
    }

    // ③ 물 패스 → 화면
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(progWater);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(locWater.aPos);
    gl.vertexAttribPointer(locWater.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 고정 40fps 타임스텝(물 시뮬), 렌더/잉어는 매 프레임.
  let acc = 0, last = performance.now(), startT = last;
  let fpsFrames = 0, fpsLast = last;
  function loop(now) {
    let dt = now - last; last = now;
    if (dt > 250) dt = 250;
    acc += dt;
    let n = 0;
    while (acc >= STEP_MS && n < 4) { step(); acc -= STEP_MS; n++; }

    const dtSec = dt / 1000, tSec = (now - startT) / 1000;
    const fishVertCount = updateFishes(dtSec, tSec);
    renderScene(fishVertCount);

    fpsFrames++;
    if (now - fpsLast >= 500) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsLast));
      fpsEl.textContent = "FPS " + fps + " (target " + FPS + ")";
      fpsFrames = 0; fpsLast = now;
    }
    requestAnimationFrame(loop);
  }

  resize();
  loadKoi();
  requestAnimationFrame(loop);

  // ---------------------------------------------------------------
  // UI: 소리 / 메뉴 숨기기 / 전체화면
  // ---------------------------------------------------------------
  let soundOn = false;
  function trySound() {
    ambient.play().then(function () { soundOn = true; })
                  .catch(function () { soundOn = false; });
  }
  window.addEventListener("pointerdown", function once() {
    trySound(); window.removeEventListener("pointerdown", once);
  });

  function openBgPicker() { bgInput.click(); }
  function toggleSound() {
    if (soundOn) { ambient.pause(); soundOn = false; }
    else trySound();
  }
  function toggleFullscreen() {
    if (!document.fullscreenElement) { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); }
    else if (document.exitFullscreen) document.exitFullscreen();
  }
  function toggleMenu() {
    const hide = toolbar.classList.toggle("hidden");
    fpsEl.classList.toggle("hidden", hide);
  }

  soundBtn.addEventListener("click", toggleSound);
  hideBtn.addEventListener("click", toggleMenu);
  fsBtn.addEventListener("click", toggleFullscreen);

  // ---------------------------------------------------------------
  // 실시간 미세조정 + HUD
  // ---------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  const hud = document.createElement("div");
  hud.id = "hud";
  document.body.appendChild(hud);
  let hudTimer = null;
  function showHud(text) {
    hud.textContent = text;
    hud.classList.add("show");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { hud.classList.remove("show"); }, 1400);
  }
  function setFishCount(dir) {
    FISH_COUNT = clamp(FISH_COUNT + dir, 0, 14);
    if (koiReady) spawnFishes();
    showHud("FISH  " + FISH_COUNT);
  }
  function adjust(param, dir) {
    switch (param) {
      case "DAMPING":
        DAMPING = clamp(Math.round((DAMPING + dir * 0.002) * 1000) / 1000, 0.900, 1.000);
        showHud("DAMPING  " + DAMPING.toFixed(3)); break;
      case "DISP":
        DISP_SCALE = clamp(DISP_SCALE + dir * 5, 0, 240); applyDispScale();
        showHud("DISP_SCALE  " + DISP_SCALE); break;
      case "SPLASH":
        SPLASH_RADIUS_PX = clamp(SPLASH_RADIUS_PX + dir * 2, 2, 80);
        showHud("SPLASH_RADIUS  " + SPLASH_RADIUS_PX); break;
      case "FPS":
        FPS = clamp(FPS + dir * 5, 10, 120); STEP_MS = 1000 / FPS;
        showHud("FPS  " + FPS); break;
    }
  }

  // 키보드 — 물리 키 기준(e.code). 토글 B/S/F/M · 미세조정 1~8 · 잉어수 0(▲)/9(▼)
  window.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.code) {
      case "KeyB": if (e.repeat) return; e.preventDefault(); openBgPicker(); break;
      case "KeyS": if (e.repeat) return; e.preventDefault(); toggleSound(); break;
      case "KeyF": if (e.repeat) return; e.preventDefault(); toggleFullscreen(); break;
      case "KeyM": if (e.repeat) return; e.preventDefault(); toggleMenu(); break;
      case "Digit1": case "Numpad1": e.preventDefault(); adjust("DAMPING", +1); break;
      case "Digit2": case "Numpad2": e.preventDefault(); adjust("DAMPING", -1); break;
      case "Digit3": case "Numpad3": e.preventDefault(); adjust("DISP", +1); break;
      case "Digit4": case "Numpad4": e.preventDefault(); adjust("DISP", -1); break;
      case "Digit5": case "Numpad5": e.preventDefault(); adjust("SPLASH", +1); break;
      case "Digit6": case "Numpad6": e.preventDefault(); adjust("SPLASH", -1); break;
      case "Digit7": case "Numpad7": e.preventDefault(); adjust("FPS", +1); break;
      case "Digit8": case "Numpad8": e.preventDefault(); adjust("FPS", -1); break;
      case "Digit0": case "Numpad0": if (e.repeat) return; e.preventDefault(); setFishCount(+1); break;
      case "Digit9": case "Numpad9": if (e.repeat) return; e.preventDefault(); setFishCount(-1); break;
    }
  });

  // ---------------------------------------------------------------
  // 중앙 'Touch here' 유도
  // ---------------------------------------------------------------
  const hint = document.getElementById("hint");
  const IDLE_MS = 7000;
  const ATTRACT_MS = 1150;
  let attractOn = false, attractTimer = null, idleTimer = null;

  function attractStart() {
    if (attractOn) return;
    attractOn = true;
    if (hint) hint.classList.remove("hidden");
    attractTimer = setInterval(function () {
      if (document.hidden) return;
      const jx = (Math.random() * 2 - 1) * 10, jy = (Math.random() * 2 - 1) * 10;
      splash(window.innerWidth / 2 + jx, window.innerHeight / 2 + jy, 150);
    }, ATTRACT_MS);
  }
  function attractStop() {
    if (!attractOn) return;
    attractOn = false;
    if (hint) hint.classList.add("hidden");
    clearInterval(attractTimer); attractTimer = null;
  }
  function onUserActivity(e) {
    if (e.type === "pointerdown" || e.pointerType === "touch") attractStop();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(attractStart, IDLE_MS);
  }
  canvas.addEventListener("pointerdown", onUserActivity);
  canvas.addEventListener("pointermove", onUserActivity);
  attractStart();
})();
