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
  // 배경 데이터 절대 경로 = fractal_capture 폴더 (bg_build.py 가 assets/bg/ 로 최적화 복사 +
  //   assets/bg-manifest.json 생성). 앱은 매니페스트의 모든 이미지를 이름순 크로스페이드 재생.
  //   동영상(manifest.videos)은 V 키로 영상 배경 토글.  bg 갱신 시 BG_VER 올려 캐시 무효화.
  const ASSET_VER = "26";
  const BG_VER = "4";
  let SLIDE_HOLD_MS = 0;               // 각 장면 추가 표시 시간(▲/▼ 방향키 ±1초, 기본 0초)
  const SLIDE_FADE_MS = 1600;          // 크로스페이드 시간

  // 키보드로 실시간 미세조정 (1/2 DAMPING, 3/4 DISP_SCALE, 5/6 SPLASH_RADIUS, 7/8 FPS)
  let SPLASH_RADIUS_PX = 18;
  let DISP_SCALE = 60;
  let FPS = 40;
  let STEP_MS = 1000 / FPS;
  let DAMPING = 0.992;

  // ---- 황금 잉어 파라미터 ----
  //   fish01 헤엄 사이클(73프레임, 머리=위) 프레임 애니메이션 사용 → 몸이 자연스럽게 일렁임.
  let FISH_COUNT = 12;                // 동시에 헤엄치는 잉어 수 (9/0 키로 가감, 0~24)
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
    uniform float uBgBright;   // 배경 밝기(d/b 키, 기본 1.0)
    void main() {
      vec2 imgUv = vUv * uBgScale + uBgOffset;
      gl_FragColor = vec4(texture2D(uBg, clamp(imgUv, 0.0, 1.0)).rgb * uBgBright, 0.0);
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
    uniform float uGlitter;   // 윤슬 강도(0=off)
    uniform float uTime;      // 반짝임 시간
    uniform vec2 uHTexel;     // 높이맵 텍셀 크기(1/gridW,1/gridH)
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
      vec3 outc = clamp(col, 0.0, 1.0) * shade;
      // 윤슬: 잔물결 경사 기반 스페큘러 × '흩뿌린 점형' 트윙클(미세 셀별 랜덤 위상 펄스+둥근 점)
      if (uGlitter > 0.0) {
        float hl = texture2D(uHeight, vUv - vec2(uHTexel.x, 0.0)).r;
        float hr = texture2D(uHeight, vUv + vec2(uHTexel.x, 0.0)).r;
        float hu = texture2D(uHeight, vUv - vec2(0.0, uHTexel.y)).r;
        float hd = texture2D(uHeight, vUv + vec2(0.0, uHTexel.y)).r;
        vec2 grad = vec2(hr - hl, hd - hu);
        float g = length(grad);
        vec3 n = normalize(vec3(-grad * 7.0, 1.0));
        vec3 Ld = normalize(vec3(0.55, -0.6, 0.55));
        float spec = pow(max(dot(n, Ld), 0.0), 40.0);        // 더 넓은 하이라이트
        float slope = smoothstep(0.0022, 0.030, g);           // 더 잔잔한 물결에도 점등
        // 흩뿌린 점형 유지하며 더 풍성하게 — 3중 격자(굵은 점+작은 점+미세 점)
        // 레이어 A: 굵은 점, 셀 대부분 점등
        vec2 gpA = vUv * vec2(720.0, 470.0);
        vec2 cidA = floor(gpA); vec2 cfA = fract(gpA) - 0.5;
        float aR1 = fract(sin(dot(cidA, vec2(127.1, 311.7))) * 43758.5453);
        float aR2 = fract(sin(dot(cidA, vec2(269.5, 183.3))) * 43758.5453);
        float aPulse = pow(0.5 + 0.5 * sin(uTime * (2.5 + 5.0 * aR2) + aR1 * 6.2831), 6.0);
        float aTw = aPulse * smoothstep(0.5, 0.06, length(cfA)) * step(0.10, aR1);  // 약 90% 셀
        // 레이어 B: 더 촘촘한 작은 점
        vec2 gpB = vUv * vec2(1120.0, 740.0);
        vec2 cidB = floor(gpB); vec2 cfB = fract(gpB) - 0.5;
        float bR1 = fract(sin(dot(cidB, vec2(74.7, 219.3))) * 27183.123);
        float bR2 = fract(sin(dot(cidB, vec2(311.3, 127.9))) * 27183.123);
        float bPulse = pow(0.5 + 0.5 * sin(uTime * (3.6 + 6.0 * bR2) + bR1 * 6.2831), 8.0);
        float bTw = bPulse * smoothstep(0.45, 0.05, length(cfB)) * step(0.24, bR1);
        // 레이어 C: 미세한 반짝 가루(아주 촘촘·빠름) → 풍성한 디테일
        vec2 gpC = vUv * vec2(1680.0, 1110.0);
        vec2 cidC = floor(gpC); vec2 cfC = fract(gpC) - 0.5;
        float cR1 = fract(sin(dot(cidC, vec2(201.5, 88.7))) * 15731.743);
        float cR2 = fract(sin(dot(cidC, vec2(96.3, 271.1))) * 15731.743);
        float cPulse = pow(0.5 + 0.5 * sin(uTime * (4.8 + 7.0 * cR2) + cR1 * 6.2831), 10.0);
        float cTw = cPulse * smoothstep(0.42, 0.04, length(cfC)) * step(0.42, cR1);
        float twDot = aTw + bTw * 0.85 + cTw * 0.7;
        float glint = spec * slope * twDot * uGlitter * 2.9;  // 세 레이어 합 → 더욱 풍부
        outc += vec3(glint) * (1.0 - 0.5 * fish);             // 물고기 위는 살짝 약하게
      }
      gl_FragColor = vec4(min(outc, 1.0), 1.0);
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
    uBgBright: gl.getUniformLocation(progBg, "uBgBright"),
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
    uGlitter: gl.getUniformLocation(progWater, "uGlitter"),
    uTime: gl.getUniformLocation(progWater, "uTime"),
    uHTexel: gl.getUniformLocation(progWater, "uHTexel"),
  };
  gl.useProgram(progBg);    gl.uniform1i(locBg.uBg, 0); gl.uniform1f(locBg.uBgBright, 1.0);
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
  // 2D 오프스크린 캔버스에 cover-fit 합성 → bgTex 업로드. 셰이더 cover 는 identity.
  //   전환(크로스페이드) 중에만 매 프레임 업로드 → 평상시 부하 0. 배경은 굴절되므로 1600px 로 캡.
  const bgCanvas = document.createElement("canvas");
  const bgCtx = bgCanvas.getContext("2d");
  let bgReady = false;
  let slides = [];                       // {img, loaded}
  let curImg = null, inImg = null;       // 현재/들어오는 이미지
  let slideIdx = 0, holdAcc = 0, fadeT = 0, transitioning = false;
  let usingSlideshow = true;             // 수동 배경 교체 시 false (슬라이드쇼 멈춤)
  let bgVideo = null, videoMode = false; // 동영상 배경(폴더의 manifest.videos)

  function sizeBgCanvas() {
    const aspect = canvasW / Math.max(1, canvasH), cap = 1600;
    let w = canvasW, h = canvasH;
    if (Math.max(w, h) > cap) { if (w >= h) { w = cap; h = Math.round(cap / aspect); } else { h = cap; w = Math.round(cap * aspect); } }
    bgCanvas.width = Math.max(2, w); bgCanvas.height = Math.max(2, h);
  }
  function coverDraw(img, alpha) {
    if (!img) return;
    const iw = img.videoWidth || img.naturalWidth || img.width;
    const ih = img.videoHeight || img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const cw = bgCanvas.width, ch = bgCanvas.height;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    bgCtx.globalAlpha = alpha;
    bgCtx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    bgCtx.globalAlpha = 1;
  }
  function composeUpload() {
    if (!curImg) return;
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
    coverDraw(curImg, 1);
    if (transitioning) coverDraw(inImg, Math.min(1, Math.max(0, fadeT)));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgCanvas);
    bgReady = true;
  }
  function startTransition(img) {
    if (!img || img === curImg) return;
    inImg = img; fadeT = 0; transitioning = true;
  }
  function nextLoadedSlide() {
    for (let k = 1; k <= slides.length; k++) {
      const idx = (slideIdx + k) % slides.length;
      if (slides[idx].loaded) { slideIdx = idx; return slides[idx].img; }
    }
    return null;
  }
  function updateBg(dtMs) {
    // 동영상 배경: 매 프레임 비디오 프레임을 bgCanvas 에 cover-fit → bgTex 업로드(굴절됨)
    if (videoMode && bgVideo && bgVideo.readyState >= 2 && bgVideo.videoWidth) {
      if (bgCanvas.width < 2) sizeBgCanvas();
      bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
      coverDraw(bgVideo, 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgCanvas);
      bgReady = true;
      return;
    }
    if (!bgReady) return;
    if (transitioning) {
      fadeT += dtMs / SLIDE_FADE_MS;
      if (fadeT >= 1) { curImg = inImg; inImg = null; transitioning = false; fadeT = 0; holdAcc = 0; }
      composeUpload();
    } else if (usingSlideshow && SLIDE_HOLD_MS > 0) {   // 0초면 정지(pause)
      holdAcc += dtMs;
      if (holdAcc >= SLIDE_HOLD_MS) {
        const nx = nextLoadedSlide();
        if (nx && nx !== curImg) startTransition(nx); else holdAcc = 0;
      }
    }
  }
  // 순차 프리로드: 한 장씩 이어 로드(부하 분산). 첫 장 로드되면 즉시 표시.
  function preloadFrom(i) {
    if (i >= slides.length) return;
    const it = slides[i];
    it.img.onload = function () {
      it.loaded = true;
      if (!curImg) { curImg = it.img; sizeBgCanvas(); composeUpload(); }
      preloadFrom(i + 1);
    };
    it.img.onerror = function () { preloadFrom(i + 1); };
    it.img.src = it.src;
  }
  // 매니페스트(폴더의 모든 이미지/동영상) 로드
  let bgManifest = { images: [], videos: [] };
  fetch("assets/bg-manifest.json?v=" + BG_VER).then(function (r) { return r.json(); }).then(function (m) {
    bgManifest = m;
    slides = (m.images || []).map(function (src) {
      const im = new Image(); im.crossOrigin = "anonymous";
      return { img: im, loaded: false, src: "assets/" + src + "?v=" + BG_VER };
    });
    if (slides.length) preloadFrom(0);
    if (m.videos && m.videos.length) {
      bgVideo = document.createElement("video");
      bgVideo.muted = true; bgVideo.loop = true; bgVideo.playsInline = true; bgVideo.preload = "auto";
      bgVideo.src = "assets/" + m.videos[0] + "?v=" + BG_VER;
    }
  }).catch(function () { /* 매니페스트 없으면 배경 없이도 동작 */ });

  function toggleVideoBg() {
    if (!bgVideo) { showHud("배경 동영상 없음"); return; }
    videoMode = !videoMode;
    if (videoMode) { usingSlideshow = false; bgVideo.play().catch(function () {}); showHud("배경 동영상 ON"); }
    else { bgVideo.pause(); usingSlideshow = true; holdAcc = 0; showHud("배경 슬라이드쇼"); if (curImg) composeUpload(); }
  }
  function useCustomBg(srcOrDataUrl) {
    usingSlideshow = false;              // 슬라이드쇼 멈추고 사용자 배경으로 크로스페이드
    if (videoMode && bgVideo) { videoMode = false; bgVideo.pause(); }
    const img = new Image(); img.crossOrigin = "anonymous";
    img.onload = function () { if (!curImg) { curImg = img; sizeBgCanvas(); composeUpload(); } else startTransition(img); };
    img.src = srcOrDataUrl;
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
  // 잉어 헤엄 아틀라스 로딩 + 개체 생성. 그룹 2종(t 키 전환):
  //   그룹1 = koi-swim-g1 (6색 솔리드), 그룹2 = koi-swim-g2 (얼룩무늬 백업)
  //   meta: {cellW,cellH,cols,rows,count,fps,atlasW,atlasH,variants}
  // ---------------------------------------------------------------
  let koiAtlas = null, koiReady = false;
  let fishes = [];
  const KOI_GROUPS = [
    { base: "koi-swim-g1", label: "1 (6색 솔리드)", meta: null, img: null },
    { base: "koi-swim-g2", label: "2 (얼룩무늬)", meta: null, img: null },
  ];
  let activeGroup = 1;                    // 기본 그룹2(얼룩무늬)
  function uploadGroup(i) {
    const G = KOI_GROUPS[i];
    if (!G.meta || !G.img) return;
    koiAtlas = G.meta;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, koiTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, G.img);
    koiReady = true;
    spawnFishes();
  }
  function loadKoi() {
    KOI_GROUPS.forEach(function (G, i) {
      fetch("assets/" + G.base + ".json?v=" + ASSET_VER).then(function (r) { return r.json(); }).then(function (meta) {
        const img = new Image();
        img.onload = function () { G.meta = meta; G.img = img; if (i === activeGroup) uploadGroup(i); };
        img.src = "assets/" + G.base + ".png?v=" + ASSET_VER;
      }).catch(function () { /* 한 그룹 실패해도 다른 그룹/물결은 동작 */ });
    });
  }
  function toggleKoiGroup() {
    const other = activeGroup ^ 1;
    if (!KOI_GROUPS[other].img) { showHud("그룹 로딩 중…"); return; }
    activeGroup = other;
    uploadGroup(activeGroup);
    showHud("물고기 그룹 " + KOI_GROUPS[activeGroup].label);
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
    // bgCanvas 가 이미 화면비로 cover-fit 되어 있으므로 셰이더 매핑은 identity.
    gl.useProgram(progBg);
    gl.uniform2f(locBg.uBgScale, 1, 1);
    gl.uniform2f(locBg.uBgOffset, 0, 0);
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
    if (curImg) { sizeBgCanvas(); composeUpload(); }   // 새 크기로 배경 재합성
  }
  function applyDispScale() {
    gl.useProgram(progWater);
    gl.uniform2f(locWater.uDispUv, DISP_SCALE / canvasW, DISP_SCALE / canvasH);
    gl.uniform2f(locWater.uHTexel, 1 / Math.max(1, gridW), 1 / Math.max(1, gridH));
  }
  // 윤슬(sun glitter): 잔물결 반짝임. 버튼 on/off + 강도 슬라이더.
  let GLITTER_ON = true, GLITTER_AMT = 0.5;   // 강도 0~1 (슬라이더)
  function applyGlitter() {
    gl.useProgram(progWater);
    gl.uniform1f(locWater.uGlitter, GLITTER_ON ? GLITTER_AMT * 1.8 : 0.0);
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
  let MOTION_DIFF_T = 30;             // 셀 휘도 변화 임계(클수록 둔감). 슬라이더로 조절
  const MOTION_BLOCK_T = 0.08;        // 블록 strength 임계(이상이면 도망 점 생성)
  const MOTION_FLEE_MULT = 1.0;        // 모션 점 도망 반경 배수(마우스와 동일 — 가까울 때만 도망)
  const MOTION_SPLASH_MS = 80;         // 모션 물결 주기
  const MOTION_SPLASH_N = 5;           // 한 틱에 찍는 물결 수(움직인 셀에서 무작위 추출)
  // ── 자기 화면 되먹임 억제(프로젝터 바닥투사를 천장 웹캠이 다시 보는 설치용) ──
  // 판정 = '움직임의 공간적 퍼짐'. 사람=국소 덩어리(블록 소수), 되먹임 일렁임=바닥 전체.
  // (횟수 기반 냉각은 관람객이 계속 놀 때도 끊겨서 폐기 — 퍼짐 기반은 사람에겐 안 걸림)
  const FB_GLOBAL_FRAC = 0.35;         // 변화 셀 비율이 이 이상 = 전역 변화(자기 화면) → 그 틱 무시
  const FB_WIDE_FRAC = 0.55;           // 움직임 블록 비율이 이 이상 = '넓게 퍼짐'(되먹임 의심)
  const FB_WIDE_MS = 1300;             // 넓게 퍼진 상태가 이 시간 지속되면 냉각 시작
  const FB_CALM_FRAC = 0.32;           // 이 미만으로 좁아진 상태가
  const FB_CALM_MS = 600;              //   이 시간 지속되면 냉각 해제(사람 상호작용 즉시 재개)
  let fbCooldown = false, fbWideAcc = 0, fbCalmAcc = 0, fbLastT = 0;
  let camFlip = false;                 // 카메라 좌우반전(a 키) — 화면표시+모션매핑 함께 뒤집음
  let camOn = false, xrayOn = false, camStream = null, camVideo = null;
  let camMonitorOn = false;              // 모니터링 미리보기 창(기본 꺼짐, W 토글)
  let mctx = null, prevLuma = null, motionAcc = 0, motionSplashAcc = 0, motionTotal = 0;
  let motionCells = [];                // 이번 틱에 움직인 미세 셀들 {x,y,d} (MW×MH 좌표) — 물결 발생용

  function updateMotion() {
    if (!camOn || !camVideo || camVideo.readyState < 2 || !camVideo.videoWidth) return;
    if (camFlip) { mctx.save(); mctx.scale(-1, 1); mctx.drawImage(camVideo, -MW, 0, MW, MH); mctx.restore(); }
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
      const now = performance.now();
      const fdt = fbLastT ? Math.min(200, now - fbLastT) : 0;
      fbLastT = now;
      // 되먹임 억제 ①: 화면 대부분이 동시에 변하면(슬라이드 전환·영상배경·전면 물결 일렁임이
      // 카메라에 되비침) 사람의 움직임이 아니므로 이번 틱을 통째로 무시
      if (cells.length > MW * MH * FB_GLOBAL_FRAC) {
        fbWideAcc += fdt; fbCalmAcc = 0;       // 전역 변화도 '넓게 퍼짐'으로 집계
        motionTotal = 0; motionCells = []; motionPoints = [];
        prevLuma = luma;
        return;
      }
      motionTotal = total;
      motionCells = cells;
      // 물고기 도망용 = 코어스 블록 점(시각적 격자 무관)
      const cellsPerBlock = (MW / MBX) * (MH / MBY);
      const pts = [];
      let activeBlocks = 0;
      for (let by = 0; by < MBY; by++) {
        for (let bx = 0; bx < MBX; bx++) {
          if (blocks[by * MBX + bx] > 0) activeBlocks++;
          const strength = Math.min(1, blocks[by * MBX + bx] / (cellsPerBlock * 70));
          if (strength > MOTION_BLOCK_T) {
            // 도망 힘: 마우스(w=1)에 준하도록 바닥값+게인 (가장자리 미세 움직임은 과하지 않게)
            const w = Math.min(1, 0.45 + strength * 2.5);
            pts.push({ x: ((bx + 0.5) / MBX) * W, y: ((by + 0.5) / MBY) * H, w: w, r: MOTION_FLEE_MULT });
          }
        }
      }
      // 되먹임 억제 ②: 움직임이 바닥 '전체에 넓게' 퍼진 상태가 지속될 때만 냉각(사람=국소라 안 걸림)
      const wideFrac = activeBlocks / (MBX * MBY);
      if (wideFrac > FB_WIDE_FRAC) { fbWideAcc += fdt; } else { fbWideAcc = 0; }
      if (!fbCooldown && fbWideAcc > FB_WIDE_MS) { fbCooldown = true; fbCalmAcc = 0; }
      if (fbCooldown) {
        if (wideFrac < FB_CALM_FRAC) {
          fbCalmAcc += fdt;
          if (fbCalmAcc > FB_CALM_MS) { fbCooldown = false; fbWideAcc = 0; }
        } else { fbCalmAcc = 0; }
      }
      motionPoints = fbCooldown ? [] : pts;   // 냉각 중엔 도망점도 차단
    }
    prevLuma = luma;
  }

  // 물결은 '실제 움직인 미세 셀'에서 발생 + 셀 내부 랜덤 지터 → 격자 정렬 없이 사람 움직임을 따라감.
  function motionSplashes() {
    const cells = motionCells;
    if (!cells.length) return;
    if (fbCooldown) return;    // 되먹임 냉각 중(넓게 퍼진 일렁임 지속) — updateMotion 이 판정
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
    // xray > 모니터링창(W) > 숨김(preview-off: opacity0 이지만 디코딩 유지→모션 계속 동작)
    camVideo.className = (xrayOn ? "xray" : (camMonitorOn ? "preview" : "preview-off")) + (camFlip ? " flip" : "");
  }
  function toggleCamMonitor() {
    camMonitorOn = !camMonitorOn;
    applyCamClass();
    showHud("모니터링 창 " + (camMonitorOn ? "ON" : "OFF") + (camOn ? "" : " (카메라 꺼짐)"));
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
  function toggleCamFlip() {
    camFlip = !camFlip; applyCamClass();
    showHud("카메라 좌우반전 " + (camFlip ? "ON" : "OFF"));
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
    gl.uniform1f(locWater.uTime, (performance.now() - startT) / 1000);  // 윤슬 반짝임
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
    updateBg(dt);                 // 배경 슬라이드쇼(전환 중에만 텍스처 갱신)
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
  applyGlitter();
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
  // 첫 사용자 제스처에 소리 시작 + 전체화면 진입(동기 호출이라야 허용됨).
  //   처음 켤 땐 비번 통과 시점에 전체화면(index 게이트에서 처리). 여기선 재방문(게이트 없음) 대비.
  window.addEventListener("pointerdown", function once() {
    trySound();
    if (!document.fullscreenElement) {
      const rq = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (rq) try { rq.call(document.documentElement); } catch (_) {}
    }
    window.removeEventListener("pointerdown", once);
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
  const menuHotspot = document.getElementById("menuHotspot");
  if (menuHotspot) menuHotspot.addEventListener("click", toggleMenu);  // 우상단 구석 빈곳
  const camBtn = document.getElementById("camBtn");
  if (camBtn) camBtn.addEventListener("click", toggleCamera);
  const videoBgBtn = document.getElementById("videoBgBtn");
  if (videoBgBtn) videoBgBtn.addEventListener("click", toggleVideoBg);
  const groupBtn = document.getElementById("groupBtn");
  if (groupBtn) groupBtn.addEventListener("click", toggleKoiGroup);

  // 가상 키보드: 버튼이 키 입력(keydown)을 동기 발생 → 모든 단축키를 터치로(전체화면도 동작)
  const vkbd = document.getElementById("vkbd");
  const kbdBtn = document.getElementById("kbdBtn");
  const VKEYS = [
    ["KeyB", "배경밝게 B"], ["KeyD", "배경어둡게 D"], ["KeyS", "소리 S"], ["KeyC", "카메라 C"], ["KeyW", "모니터 W"], ["KeyX", "엑스레이 X"], ["KeyA", "캠반전 A"], ["KeyP", "민감도+ P"], ["KeyL", "민감도- L"], ["KeyV", "영상 V"], ["KeyT", "물고기 T"],
    ["KeyY", "윤슬 Y"], ["KeyI", "손숨김 I"], ["KeyM", "메뉴 M"], ["KeyF", "전체화면 F"], ["Digit1", "감쇠+ 1"], ["Digit2", "감쇠- 2"], ["Digit3", "굴절+ 3"],
    ["Digit4", "굴절- 4"], ["Digit5", "물결+ 5"], ["Digit6", "물결- 6"], ["Digit7", "FPS+ 7"], ["Digit8", "FPS- 8"], ["Digit0", "물고기+ 0"], ["Digit9", "물고기- 9"],
    ["ArrowUp", "배경간격+ ▲"], ["ArrowDown", "배경간격- ▼"],
  ];
  function closeVkbd() {
    if (!vkbd || vkbd.classList.contains("hidden")) return;
    vkbd.classList.add("hidden");
    showHud("가상 키보드 숨김");
  }
  if (vkbd) {
    VKEYS.forEach(function (k) {
      const b = document.createElement("button");
      b.textContent = k[1];
      b.addEventListener("click", function () { window.dispatchEvent(new KeyboardEvent("keydown", { code: k[0], bubbles: true })); });
      vkbd.appendChild(b);
    });
    // 자판 끄기 버튼 (터치로 닫기) — 눈에 띄게
    const cb = document.createElement("button");
    cb.textContent = "✕ 자판 끄기 (K)";
    cb.className = "vk-close";
    cb.addEventListener("click", closeVkbd);
    vkbd.appendChild(cb);
  }
  function toggleVkbd() {
    if (!vkbd) return;
    const open = !vkbd.classList.toggle("hidden");
    showHud("가상 키보드 " + (open ? "표시" : "숨김"));
  }
  if (kbdBtn) kbdBtn.addEventListener("click", toggleVkbd);

  const glitterBtn = document.getElementById("glitterBtn");
  const glitterSlider = document.getElementById("glitterSlider");
  function refreshGlitterUI() { if (glitterBtn) glitterBtn.textContent = GLITTER_ON ? "윤슬 ON (Y)" : "윤슬 OFF (Y)"; }
  function toggleGlitter() { GLITTER_ON = !GLITTER_ON; applyGlitter(); refreshGlitterUI(); showHud("윤슬 " + (GLITTER_ON ? "ON" : "OFF")); }
  if (glitterBtn) glitterBtn.addEventListener("click", toggleGlitter);
  if (glitterSlider) {
    GLITTER_AMT = (+glitterSlider.value) / 100; applyGlitter();
    glitterSlider.addEventListener("input", function () {
      GLITTER_AMT = (+this.value) / 100;
      if (!GLITTER_ON) { GLITTER_ON = true; refreshGlitterUI(); }
      applyGlitter(); showHud("윤슬 강도  " + this.value);
    });
  }
  refreshGlitterUI();
  const fishPlusBtn = document.getElementById("fishPlusBtn");
  const fishMinusBtn = document.getElementById("fishMinusBtn");
  if (fishPlusBtn) fishPlusBtn.addEventListener("click", function () { setFishCount(+1); });
  if (fishMinusBtn) fishMinusBtn.addEventListener("click", function () { setFishCount(-1); });

  // 카메라 센싱 민감도 슬라이더: 값 0(매우 둔감)~100(매우 예민) → MOTION_DIFF_T 150~3 (클수록 둔감)
  //  프로젝터 바닥 투사처럼 화면 자체가 밝아 오작동하면 왼쪽으로 내려 크게 둔감화.
  const sensSlider = document.getElementById("sensSlider");
  function applySens(v) { MOTION_DIFF_T = Math.max(3, Math.round(150 - v * 1.47)); }
  if (sensSlider) {
    applySens(+sensSlider.value);
    sensSlider.addEventListener("input", function () {
      applySens(+this.value);
      showHud("센싱 민감도  " + this.value + "  (임계 " + MOTION_DIFF_T + ")");
    });
  }
  // 민감도 단축키: p=올리기 / l=내리기 (5씩, 슬라이더와 동기)
  function stepSens(dir) {
    const cur = sensSlider ? +sensSlider.value : 40;
    const v = clamp(cur + dir * 5, 0, 100);
    if (sensSlider) sensSlider.value = v;
    applySens(v);
    showHud("센싱 민감도  " + v + "  (임계 " + MOTION_DIFF_T + ")");
  }

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
    FISH_COUNT = clamp(FISH_COUNT + dir, 0, 24);
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

  // 배경 밝기(d=어둡게 / b=밝게, 10%씩). 1.0=원본
  let BG_BRIGHT = 1.0;
  function setBgBright(dir) {
    BG_BRIGHT = clamp(Math.round((BG_BRIGHT + dir * 0.1) * 100) / 100, 0.1, 2.0);
    gl.useProgram(progBg); gl.uniform1f(locBg.uBgBright, BG_BRIGHT);
    showHud("배경 밝기  " + Math.round(BG_BRIGHT * 100) + "%");
  }

  // 배경 슬라이드쇼 전환 간격(▲/▼): 기본 0초, ±1초
  function setSlideHold(dir) {
    SLIDE_HOLD_MS = clamp(SLIDE_HOLD_MS + dir * 1000, 0, 60000);
    holdAcc = 0;
    showHud(SLIDE_HOLD_MS > 0 ? ("배경 전환 간격  " + (SLIDE_HOLD_MS / 1000) + "초") : "배경 슬라이드 정지 (0초)");
  }

  // 키보드 — 물리 키 기준(e.code). 토글 B/S/F/M · 미세조정 1~8 · 잉어수 0(▲)/9(▼) · 배경간격 ↑/↓
  window.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.code) {
      case "ArrowUp": if (e.repeat) return; e.preventDefault(); setSlideHold(+1); break;
      case "ArrowDown": if (e.repeat) return; e.preventDefault(); setSlideHold(-1); break;
      case "KeyB": e.preventDefault(); setBgBright(+1); break;   // 배경 밝게 +10%
      case "KeyD": e.preventDefault(); setBgBright(-1); break;   // 배경 어둡게 -10%
      case "KeyS": if (e.repeat) return; e.preventDefault(); toggleSound(); break;
      case "KeyF": if (e.repeat) return; e.preventDefault(); toggleFullscreen(); break;
      case "KeyM": if (e.repeat) return; e.preventDefault(); toggleMenu(); break;
      case "KeyC": if (e.repeat) return; e.preventDefault(); toggleCamera(); break;
      case "KeyX": if (e.repeat) return; e.preventDefault(); toggleXray(); break;
      case "KeyA": if (e.repeat) return; e.preventDefault(); toggleCamFlip(); break;
      case "KeyP": e.preventDefault(); stepSens(+1); break;   // 캠 민감도 올리기
      case "KeyL": e.preventDefault(); stepSens(-1); break;   // 캠 민감도 내리기
      case "KeyV": if (e.repeat) return; e.preventDefault(); toggleVideoBg(); break;
      case "KeyW": if (e.repeat) return; e.preventDefault(); toggleCamMonitor(); break;
      case "KeyT": if (e.repeat) return; e.preventDefault(); toggleKoiGroup(); break;
      case "KeyY": if (e.repeat) return; e.preventDefault(); toggleGlitter(); break;
      case "KeyI": if (e.repeat) return; e.preventDefault(); toggleHintIcon(); break;
      case "KeyK": if (e.repeat) return; e.preventDefault(); toggleVkbd(); break;
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

  // I 키: 중앙 손가락 아이콘(힌트) 숨김 토글
  let hintIconHidden = false;
  function toggleHintIcon() {
    hintIconHidden = !hintIconHidden;
    if (hint) hint.classList.toggle("icon-off", hintIconHidden);
    showHud("손 아이콘 " + (hintIconHidden ? "숨김" : "표시"));
  }

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
