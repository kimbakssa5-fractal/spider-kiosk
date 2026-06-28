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
  const ASSET_VER = "5";
  const DEFAULT_BG_LANDSCAPE = "assets/fractal-tree-land.jpg?v=" + ASSET_VER;
  const DEFAULT_BG_PORTRAIT  = "assets/fractal-tree.jpg?v=" + ASSET_VER;

  // 키보드로 실시간 미세조정 (1/2 DAMPING, 3/4 DISP_SCALE, 5/6 SPLASH_RADIUS, 7/8 FPS)
  let SPLASH_RADIUS_PX = 18;
  let DISP_SCALE = 60;
  let FPS = 40;
  let STEP_MS = 1000 / FPS;
  let DAMPING = 0.992;

  // ---- 황금 잉어 파라미터 ----
  //   fish01 헤엄 사이클(73프레임, 머리=위) 프레임 애니메이션 사용 → 몸이 자연스럽게 일렁임.
  let FISH_COUNT = 6;                 // 동시에 헤엄치는 잉어 수 (9/0 키로 가감)
  const FISH_LEN_MIN = 0.22, FISH_LEN_MAX = 0.34;  // 화면 짧은변 대비 몸길이 비율 (크게)
  const FISH_SPEED_MIN = 0.040, FISH_SPEED_MAX = 0.075; // 화면 짧은변/초 (유유히)
  const FISH_WAKE_PEAK = 28;          // 잉어가 남기는 잔물결 진폭(아주 약하게)
  // 도망 상호작용: 마우스/터치/카메라모션이 가까이 오면 반대로 빠르게 헤엄쳐 달아남
  const FLEE_RADIUS_FRAC = 0.32;      // 도망 반경(화면 짧은변 대비) — 더 멀리서 반응
  const FLEE_BOOST = 5.5;             // 패닉 시 속도 배수(+) — 더 빠른 대시
  const FLEE_TURN = 17.0;             // 패닉 시 방향 전환 속도(rad/s 가중) — 더 민첩
  const PANIC_GAIN = 1.8;             // 근접 강도 → 패닉 증폭(예민하게)
  const PANIC_DECAY = 0.85;           // 패닉 감쇠 시간상수(초)
  const POINTER_TTL = 0.45;           // 포인터가 멈춘 뒤 이만큼 지나면 진정(초)
  // 몸 휨(도망 방향으로 C자): 선회 각속도+패닉에 비례
  const FISH_SEG = 7;                 // 몸 분절 수
  const BEND_GAIN = 0.055;            // 각속도(rad/s) → 휨
  const BEND_MAX = 1.5;               // 최대 휨(라디안, 몸 전체 분배)
  const BEND_SMOOTH = 13.0;           // 휨 추종 속도

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

  // ① 배경 패스: cover-fit 배경을 scene FBO 에 그림 (alpha=0 → "물고기 아님" 마스크)
  const FS_BG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uBg;
    uniform vec2 uBgScale;
    uniform vec2 uBgOffset;
    void main() {
      vec2 imgUv = vUv * uBgScale + uBgOffset;
      gl_FragColor = vec4(texture2D(uBg, clamp(imgUv, 0.0, 1.0)).rgb, 0.0);
    }`;

  // ② 잉어 패스: 클립공간 정점 + 아틀라스 UV, 알파 블렌딩으로 scene 위 합성.
  //   색·무늬는 아틀라스 변종(홍백/주황/삼색/황금) 그대로 사용 → 텍스처 색을 그대로 출력.
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
  //    scene.a = 물고기 마스크 → 물고기는 음영(h)을 덜 먹여 선명하게(흰 몸이 회색으로 가라앉지 않게).
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
      vec4 scene = texture2D(uScene, clamp(suv, 0.0, 1.0));
      float fish = scene.a;                        // 물고기 마스크(0=배경,1=물고기)
      float shade = mix(h, mix(h, 1.0, 0.72), fish); // 물고기는 음영 완화 → 색이 살아남
      vec3 col = scene.rgb;
      // 물고기는 채도 부스트 → 흰 바탕은 그대로, 빨강/주황/금색 무늬가 선명해짐
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(l), col, 1.0 + fish * 0.9);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0) * shade, 1.0);
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
  // 잉어 헤엄 아틀라스 로딩 + 개체 생성
  //   koi-swim.png: fish01 헤엄 사이클을 셀 그리드로 팩(머리=셀 위쪽).
  //   meta: {cellW,cellH,cols,rows,count,fps,atlasW,atlasH}
  // ---------------------------------------------------------------
  let koiAtlas = null, koiReady = false;
  let fishes = [];
  function loadKoi() {
    fetch("assets/koi-swim.json?v=" + ASSET_VER).then(function (r) { return r.json(); }).then(function (meta) {
      const img = new Image();
      img.onload = function () {
        koiAtlas = meta;
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, koiTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        koiReady = true;
        spawnFishes();
      };
      img.src = "assets/koi-swim.png?v=" + ASSET_VER;
    }).catch(function () { /* 잉어 없이도 물결은 동작 */ });
  }

  function rand(a, b) { return a + Math.random() * (b - a); }
  function makeFish() {
    // 색·무늬 변종(홍백/주황/삼색/황금)을 랜덤 배정 → 여러 색이 섞여 헤엄
    const vs = koiAtlas.variants;
    const variant = vs[(Math.random() * vs.length) | 0];
    return {
      variant: variant,
      nx: Math.random(), ny: Math.random(),        // 위치(정규화 top-down 0..1)
      heading: Math.random() * Math.PI * 2,
      lenFrac: rand(FISH_LEN_MIN, FISH_LEN_MAX),
      speedFrac: rand(FISH_SPEED_MIN, FISH_SPEED_MAX),
      turnFreq: rand(0.06, 0.16), turnPhase: Math.random() * 6.28, turnAmp: rand(0.18, 0.40),
      frame: Math.random() * variant.count,         // 헤엄 사이클 위상(프레임)
      animFps: koiAtlas.fps * rand(0.8, 1.12),
      rip: rand(0, 0.4), ripEvery: rand(0.28, 0.45),
      panic: 0,                                       // 도망 흥분도(0~1+), 시간에 따라 감쇠
      bend: 0, prevHeading: 0,                        // 몸 휨(라디안), 직전 heading
    };
  }
  function spawnFishes() {
    fishes = [];
    for (let i = 0; i < FISH_COUNT; i++) fishes.push(makeFish());
    fishVerts = new Float32Array(FISH_COUNT * FISH_SEG * 6 * 4);  // 분절당 2삼각형
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

  // 활성 포인터 추적 (도망 상호작용용). 마우스는 hover, 터치는 접촉 중 위치.
  //   POINTER_TTL 동안 움직임이 없으면 비활성 → 물고기 진정.
  const pointers = new Map();   // id -> {x, y, t(sec)}
  let motionPoints = [];        // 카메라 모션 점 [{x,y,w}] (CSS px) — 매 모션틱 갱신
  function nowSec() { return performance.now() / 1000; }
  function notePointer(id, x, y) { pointers.set(id, { x: x, y: y, t: nowSec() }); }
  function dropPointer(id) { pointers.delete(id); }

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", function (e) {
    splash(e.clientX, e.clientY);
    notePointer(e.pointerId, e.clientX, e.clientY);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener("pointermove", function (e) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) splash(ev.clientX, ev.clientY);
    notePointer(e.pointerId, e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerup", function (e) { dropPointer(e.pointerId); });
  canvas.addEventListener("pointercancel", function (e) { dropPointer(e.pointerId); });
  // 마우스가 창 밖으로 나가면 그 포인터 제거(물고기 진정)
  window.addEventListener("pointerout", function (e) { if (e.pointerType === "mouse") dropPointer(e.pointerId); });
  window.addEventListener("blur", function () { pointers.clear(); });

  // ---------------------------------------------------------------
  // 카메라(웹캠 C920) 모션 반응 + X레이 투영
  //   영상을 작은 격자에 그려 프레임 차분 → 움직이는 블록을 도망 점(motionPoints)으로.
  //   거울처럼 좌우 반전 매핑. 권한 필요 → 버튼/C 키로 켠다(키오스크는 1회 탭).
  //   X 키: 카메라 화면을 전체에 X레이처럼 투영(반전+시안 틴트, screen 블렌드).
  // ---------------------------------------------------------------
  const MW = 80, MH = 45;              // 모션 샘플 격자
  const MBX = 8, MBY = 5;              // 도망 점 블록 격자
  const MOTION_MS = 66;                // 모션 검사 주기
  const MOTION_DIFF_T = 12;            // 셀 휘도 변화 임계(민감)
  const MOTION_BLOCK_T = 0.05;         // 블록 strength 임계(이상이면 도망 점 생성)
  const MOTION_FLEE_MULT = 2.0;        // 모션 점 도망 반경 배수(사람은 넓게)
  const MOTION_SPLASH_MS = 80;         // 모션 물결 주기
  const MOTION_SPLASH_N = 5;           // 한 틱에 찍는 물결 수(움직인 셀에서 무작위 추출)
  const CAM_MIRROR = false;            // 좌우 반전(거울 끔) — 모션 매핑
  let camOn = false, xrayOn = false, camStream = null, camVideo = null;
  let mctx = null, prevLuma = null, motionAcc = 0, motionSplashAcc = 0, motionTotal = 0;
  let motionCells = [];                // 이번 틱에 움직인 미세 셀들 {x,y,d} (MW×MH 좌표) — 물결 발생용

  function updateMotion() {
    if (!camOn || !camVideo || camVideo.readyState < 2 || !camVideo.videoWidth) return;
    if (CAM_MIRROR) { mctx.save(); mctx.scale(-1, 1); mctx.drawImage(camVideo, -MW, 0, MW, MH); mctx.restore(); }
    else mctx.drawImage(camVideo, 0, 0, MW, MH);
    const data = mctx.getImageData(0, 0, MW, MH).data;
    const luma = new Float32Array(MW * MH);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4)
      luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    if (prevLuma) {
      const W = window.innerWidth, H = window.innerHeight;
      const blocks = new Float32Array(MBX * MBY);
      const cells = [];
      let total = 0;
      for (let y = 0; y < MH; y++) {
        const row = y * MW, by = (y * MBY / MH) | 0;
        for (let x = 0; x < MW; x++) {
          const d = Math.abs(luma[row + x] - prevLuma[row + x]);
          if (d > MOTION_DIFF_T) {
            blocks[by * MBX + (x * MBX / MW | 0)] += d;
            total += d;
            cells.push({ x: x, y: y, d: d });        // 실제 움직인 미세 셀(연속 위치원)
          }
        }
      }
      motionTotal = total;
      motionCells = cells;
      // 물고기 도망용 = 코어스 블록 점(시각적 격자 무관)
      const cellsPerBlock = (MW / MBX) * (MH / MBY);
      const pts = [];
      for (let by = 0; by < MBY; by++) {
        for (let bx = 0; bx < MBX; bx++) {
          const strength = Math.min(1, blocks[by * MBX + bx] / (cellsPerBlock * 70));
          if (strength > MOTION_BLOCK_T) {
            // 도망 힘: 마우스(w=1)에 준하도록 높은 바닥값+게인 — 움직임 감지되면 강하게 민다
            const w = Math.min(1, 0.55 + strength * 2.5);
            pts.push({ x: ((bx + 0.5) / MBX) * W, y: ((by + 0.5) / MBY) * H, w: w, r: MOTION_FLEE_MULT });
          }
        }
      }
      motionPoints = pts;
    }
    prevLuma = luma;
  }

  // 물결은 '실제 움직인 미세 셀'에서 발생 + 셀 내부 랜덤 지터 → 격자 정렬 없이 사람 움직임을 따라감.
  function motionSplashes() {
    const cells = motionCells;
    if (!cells.length) return;
    const W = window.innerWidth, H = window.innerHeight;
    const n = Math.min(MOTION_SPLASH_N, cells.length);
    for (let i = 0; i < n; i++) {
      const c = cells[(Math.random() * cells.length) | 0];   // 강한 영역일수록 셀이 많아 더 자주 뽑힘
      const sx = ((c.x + Math.random()) / MW) * W;            // 셀 내부 지터(연속 위치)
      const sy = ((c.y + Math.random()) / MH) * H;
      splash(sx, sy, 70 + 90 * Math.min(1, c.d / 100));       // 작은 물결 다수 → 자연스러운 교란
    }
  }

  function applyCamClass() {
    if (!camVideo) return;
    camVideo.className = xrayOn ? "xray" : "preview";
  }
  function onCamStream(stream, cb) {
    camStream = stream;
    camVideo = document.createElement("video");
    camVideo.id = "camVideo";
    camVideo.autoplay = true; camVideo.playsInline = true; camVideo.muted = true;
    camVideo.srcObject = stream;
    document.body.appendChild(camVideo);   // DOM 에 붙여야 프레임이 안정적으로 디코드됨
    camVideo.play().catch(function () {});
    const mc = document.createElement("canvas"); mc.width = MW; mc.height = MH;
    mctx = mc.getContext("2d", { willReadFrequently: true });
    prevLuma = null; motionPoints = []; camOn = true;
    applyCamClass();
    showHud("CAMERA on");
    if (cb) cb();
  }
  let camStarting = false;
  function startCamera(cb) {
    if (camOn) { if (cb) cb(); return; }
    if (camStarting) return;
    if (!window.isSecureContext) { showHud("HTTPS(보안 연결) 필요"); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showHud("이 브라우저는 카메라 미지원"); return; }
    camStarting = true;
    showHud("카메라 요청…");
    function fail(err) {
      camStarting = false;
      const name = (err && err.name) || "?";
      console.warn("getUserMedia 실패:", name, err && err.message);
      let msg = "카메라 실패: " + name;
      if (name === "NotAllowedError") msg = "카메라 권한 거부됨 — 주소창 카메라 아이콘에서 허용";
      else if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
        msg = "카메라 사용 중 — 다른 탭/줌/Logitech/윈도우 카메라 닫고 C 다시";
      else if (name === "NotFoundError" || name === "OverconstrainedError") msg = "카메라 장치를 못 찾음";
      showHud(msg);
    }
    function ok(stream) { camStarting = false; onCamStream(stream, cb); }
    // NotReadable(점유)면 잠깐 뒤 자동 재시도(최대 3회) — 점유가 짧으면 통과
    let tries = 0;
    function attempt() {
      tries++;
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        .then(ok)
        .catch(function (err) {
          const n = err && err.name;
          if (n === "OverconstrainedError" || n === "NotFoundError") {
            navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(ok).catch(fail);
          } else if ((n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") && tries < 3) {
            showHud("카메라 잡는 중… (" + tries + "/3)");
            setTimeout(attempt, 700);
          } else fail(err);
        });
    }
    attempt();
  }
  function stopCamera() {
    if (!camOn) return;
    camOn = false; xrayOn = false; motionPoints = []; prevLuma = null;
    if (camStream) camStream.getTracks().forEach(function (t) { t.stop(); });
    camStream = null; mctx = null;
    if (camVideo) { camVideo.remove(); camVideo = null; }
    showHud("CAMERA off");
  }
  function toggleCamera() { camOn ? stopCamera() : startCamera(); }
  function toggleXray() {
    if (!camOn) { startCamera(function () { xrayOn = true; applyCamClass(); showHud("X-RAY on"); }); return; }
    xrayOn = !xrayOn; applyCamClass(); showHud(xrayOn ? "X-RAY on" : "X-RAY off");
  }

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
    // 도망 소스 = 활성 포인터(마우스/터치, 가중 1) + 카메라 모션 점(가중 strength)
    const tnow = nowSec();
    const active = [];
    pointers.forEach(function (p, id) {
      if (tnow - p.t > POINTER_TTL) pointers.delete(id);
      else active.push({ x: p.x, y: p.y, w: 1, r: 1 });
    });
    for (let mi = 0; mi < motionPoints.length; mi++) active.push(motionPoints[mi]);
    const fleeR = FLEE_RADIUS_FRAC * minDim;
    let vi = 0;
    for (let k = 0; k < fishes.length; k++) {
      const f = fishes[k];
      const lenPx = f.lenFrac * minDim;
      const hl = lenPx * 0.5;
      const fx = f.nx * W, fy = f.ny * H;            // 현재 중심(px)
      const oldHeading = f.heading;
      // 머리(회전 피벗) 위치 — 도망 시 이 점을 고정하고 몸이 회전
      const headX = fx + Math.cos(oldHeading) * hl;
      const headY = fy + Math.sin(oldHeading) * hl;

      // --- 도망: 가까운 포인터(들)로부터 멀어지는 방향으로 빠르게 선회 ---
      let ax = 0, ay = 0, maxS = 0;
      for (let pi = 0; pi < active.length; pi++) {
        const a = active[pi];
        const rad = fleeR * (a.r || 1);
        const dx = fx - a.x, dy = fy - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < rad) {
          const s = (1 - dist / rad) * a.w;          // 0~1, 모션 점은 strength 가중
          const inv = s / (dist || 1);
          ax += dx * inv; ay += dy * inv;            // 멀어지는 방향(가중)
          if (s > maxS) maxS = s;
        }
      }
      if (maxS > 0 && (ax || ay)) {
        const desired = Math.atan2(ay, ax);
        let diff = desired - f.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // [-π,π]
        f.heading += diff * Math.min(1, FLEE_TURN * (0.3 + maxS) * dtSec);
        const tgt = Math.min(1.2, maxS * PANIC_GAIN); // 근접 강도 증폭 → 더 예민
        if (tgt > f.panic) f.panic = tgt;            // 흥분도 상승
      }
      // 패닉 감쇠
      f.panic *= Math.exp(-dtSec / PANIC_DECAY);
      if (f.panic < 0.003) f.panic = 0;

      // 천천히 배회: heading 에 느린 사인 흔들림 (패닉 시엔 약화, 몸통 일렁임은 프레임 애니메이션 담당)
      f.heading += Math.sin(tSec * f.turnFreq * 6.2831 + f.turnPhase) * f.turnAmp * dtSec * (1 - Math.min(1, f.panic));
      f.frame += f.animFps * (1 + f.panic * 1.8) * dtSec;   // 패닉 시 꼬리짓 빨라짐

      // 회전축: 평상시엔 몸 중앙, 도망(패닉)할수록 머리로 → 머리 고정하고 몸·꼬리가 휙 돈다
      const pivotW = Math.min(1, f.panic * 1.3);
      const headPivotCx = headX - Math.cos(f.heading) * hl;
      const headPivotCy = headY - Math.sin(f.heading) * hl;
      let cxC = fx + (headPivotCx - fx) * pivotW;
      let cyC = fy + (headPivotCy - fy) * pivotW;

      // 전진(heading 방향)
      const speedPx = f.speedFrac * minDim * (1 + f.panic * FLEE_BOOST);  // 패닉 시 가속
      cxC += Math.cos(f.heading) * speedPx * dtSec;
      cyC += Math.sin(f.heading) * speedPx * dtSec;
      f.nx = cxC / W; f.ny = cyC / H;
      // 화면 밖으로 완전히 나가면 반대편에서 재등장
      const mx = lenPx / W, my = lenPx / H;
      if (f.nx < -mx) f.nx = 1 + mx; else if (f.nx > 1 + mx) f.nx = -mx;
      if (f.ny < -my) f.ny = 1 + my; else if (f.ny > 1 + my) f.ny = -my;

      const fwdx = Math.cos(f.heading), fwdy = Math.sin(f.heading);   // 머리 방향
      const cellW = koiAtlas.cellW, cellH = koiAtlas.cellH;
      const aspect = cellW / cellH;                  // 몸 폭/길이
      const hw = hl * aspect;
      const cx = f.nx * W, cy = f.ny * H;             // 중심(px, top-down)

      // 현재 프레임 셀 → UV (변종 셀범위 내에서 사이클, 머리=셀 위 v0, 꼬리=셀 아래 v1)
      const vcount = f.variant.count;
      const local = (((f.frame | 0) % vcount) + vcount) % vcount;
      const fi = f.variant.start + local;
      const col = fi % koiAtlas.cols, row = (fi / koiAtlas.cols) | 0;
      const u0 = (col * cellW) / koiAtlas.atlasW, u1 = (col * cellW + cellW) / koiAtlas.atlasW;
      const v0 = (row * cellH) / koiAtlas.atlasH, v1 = (row * cellH + cellH) / koiAtlas.atlasH;

      // === 몸 휨: 선회 각속도 × (1+패닉) 에 비례해 도망 방향으로 C자 ===
      let dH = f.heading - f.prevHeading;
      dH = Math.atan2(Math.sin(dH), Math.cos(dH));
      f.prevHeading = f.heading;
      let targetBend = (dH / dtSec) * BEND_GAIN * (1 + f.panic * 1.5);
      if (targetBend > BEND_MAX) targetBend = BEND_MAX; else if (targetBend < -BEND_MAX) targetBend = -BEND_MAX;
      f.bend += (targetBend - f.bend) * Math.min(1, BEND_SMOOTH * dtSec);

      function px2clip(out, oi, X, Y, u, v) {
        out[oi] = (X / W) * 2 - 1; out[oi + 1] = 1 - (Y / H) * 2;
        out[oi + 2] = u; out[oi + 3] = v;
      }
      // 머리에서 꼬리로 척추를 걸으며 분절 스트립 생성. 뒤 방향 = (heading+π) - bend*t → 꼬리가 휜다.
      const headWX = cx + fwdx * hl, headWY = cy + fwdy * hl;
      const stepLen = lenPx / FISH_SEG, baseBack = f.heading + Math.PI;
      let spx = headWX, spy = headWY;
      let pLx = 0, pLy = 0, pRx = 0, pRy = 0, pV = v0;
      for (let sgi = 0; sgi <= FISH_SEG; sgi++) {
        const t = sgi / FISH_SEG;
        const backAng = baseBack - f.bend * t;
        const fwdAng = backAng + Math.PI;
        const perpx = -Math.sin(fwdAng), perpy = Math.cos(fwdAng);
        const lx = spx + perpx * hw, ly = spy + perpy * hw;   // 좌 → u0
        const rx = spx - perpx * hw, ry = spy - perpy * hw;   // 우 → u1
        const vv = v0 + (v1 - v0) * t;
        if (sgi > 0) {
          px2clip(fishVerts, vi, pLx, pLy, u0, pV); vi += 4;
          px2clip(fishVerts, vi, pRx, pRy, u1, pV); vi += 4;
          px2clip(fishVerts, vi, lx, ly, u0, vv); vi += 4;
          px2clip(fishVerts, vi, lx, ly, u0, vv); vi += 4;
          px2clip(fishVerts, vi, pRx, pRy, u1, pV); vi += 4;
          px2clip(fishVerts, vi, rx, ry, u1, vv); vi += 4;
        }
        pLx = lx; pLy = ly; pRx = rx; pRy = ry; pV = vv;
        if (sgi < FISH_SEG) { spx += Math.cos(backAng) * stepLen; spy += Math.sin(backAng) * stepLen; }
      }

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
      // 색은 일반 over-블렌딩, 알파(마스크)는 누적 over → scene.a = 물고기 커버리지
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, fishVertCount);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
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
    // 카메라 모션 검사(주기적) + 모션 물결
    if (camOn) {
      motionAcc += dt; if (motionAcc >= MOTION_MS) { motionAcc = 0; updateMotion(); }
      motionSplashAcc += dt; if (motionSplashAcc >= MOTION_SPLASH_MS) { motionSplashAcc = 0; motionSplashes(); }
    }
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
  const camBtn = document.getElementById("camBtn");
  if (camBtn) camBtn.addEventListener("click", toggleCamera);

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
      case "KeyC": if (e.repeat) return; e.preventDefault(); toggleCamera(); break;
      case "KeyX": if (e.repeat) return; e.preventDefault(); toggleXray(); break;
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
