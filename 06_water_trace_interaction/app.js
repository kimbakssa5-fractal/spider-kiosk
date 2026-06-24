// 물결 Trace — 원본 ConvolutionFilterExample_1080.fla(AS3)의 로직을 그대로 재현.
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
// 즉 최종 = (배경이미지를 높이맵으로 굴절) × (높이맵 회색 multiply).
// 풀해상도 픽셀 굴절은 Canvas2D 로는 너무 느려 WebGL 프래그먼트 셰이더로 재현한다.
// 파동 시뮬레이션 자체는 작은 그리드(무대/8)라 JS 로 충분.

(function () {
  "use strict";

  // ---- 상수 / 런타임 조정 파라미터 ----
  const LATE = 8;                                  // 시뮬레이션 다운스케일
  const KERNEL = [0.5, 1, 0.5, 1, 0, 1, 0.5, 1, 0.5];
  const KERNEL_DIVISOR = 3;
  // 화면 방향별 기본 배경: PC(가로) = 가로형(트리 90° 회전), 폰(세로) = 세로형
  // ?v=N 캐시버전: 이미지 내용 바뀌면 N 을 올려 브라우저 캐시 강제 갱신.
  const ASSET_VER = "2";
  const DEFAULT_BG_LANDSCAPE = "assets/fractal-tree-land.jpg?v=" + ASSET_VER;
  const DEFAULT_BG_PORTRAIT  = "assets/fractal-tree.jpg?v=" + ASSET_VER;

  // 키보드로 실시간 미세조정 (1/2 DAMPING, 3/4 DISP_SCALE, 5/6 SPLASH_RADIUS, 7/8 FPS)
  let SPLASH_RADIUS_PX = 18;                       // Res_mc 흰 원 반경(풀해상도 px) — 부드럽게 살짝 키움
  let DISP_SCALE = 60;                             // DisplacementMapFilter scaleX/Y (굴절 세기)
  let FPS = 40;                                    // 원본 무대 frameRate (고정 타임스텝)
  let STEP_MS = 1000 / FPS;
  let DAMPING = 0.992;                             // 잔물결이 부드럽게 잦아들도록 약한 감쇠

  // 부드러운 물결의 핵심:
  //  - 원본 브러시(Res_mc)는 안티앨리어싱된 흰 원 → 가장자리가 부드럽다. 하드한 255 원반을
  //    찍으면 격자 체커보드 모드(이 커널은 그 모드의 이득이 ~1.67 이라 증폭됨)가 튀어 거칠어진다.
  //    → 가장자리를 코사인으로 페더링한 soft splash 로 고주파 주입을 줄인다.
  //  - rAF 는 모니터 주사율(60/144Hz)이라 시뮬이 빨라지고 버석거린다 → 40fps 고정 타임스텝.
  //  - 약한 감쇠로 물결이 우아하게 잦아들게 한다.

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
  // 셰이더
  // ---------------------------------------------------------------
  const VS = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); // (0,0)=좌상단
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  const FS = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uBg;       // 배경 이미지 (cover-fit, 좌상단 (0,0))
    uniform sampler2D uHeight;   // 높이맵 (wave+128)/255, 좌상단 (0,0)
    uniform vec2 uBgScale;       // 화면uv -> 이미지uv (cover)
    uniform vec2 uBgOffset;
    uniform vec2 uDispUv;        // DISP_SCALE / (canvasW, canvasH)
    void main() {
      float h = texture2D(uHeight, vUv).r;        // 0.502 .. 1.0 (정지 시 0.502)
      vec2 disp = (h - 0.5) * uDispUv;            // 화면공간 굴절량
      vec2 imgUv = (vUv + disp) * uBgScale + uBgOffset;
      vec3 bg = texture2D(uBg, clamp(imgUv, 0.0, 1.0)).rgb;
      gl_FragColor = vec4(bg * h, 1.0);           // 굴절된 배경 × 회색 multiply
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  // 풀스크린 삼각형 2개
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uBg = gl.getUniformLocation(prog, "uBg");
  const uHeight = gl.getUniformLocation(prog, "uHeight");
  const uBgScale = gl.getUniformLocation(prog, "uBgScale");
  const uBgOffset = gl.getUniformLocation(prog, "uBgOffset");
  const uDispUv = gl.getUniformLocation(prog, "uDispUv");
  gl.uniform1i(uBg, 0);
  gl.uniform1i(uHeight, 1);

  // ---------------------------------------------------------------
  // 텍스처: 배경(0) + 높이맵(1)
  // ---------------------------------------------------------------
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // 배경/높이맵 모두 자연(top-down) 정렬로 통일

  const bgTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, bgTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // 로드 전 임시 1px
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 30, 20, 255]));

  const heightTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  let bgImage = null, bgW = 1, bgH = 1, bgReady = false;
  let usingDefaultBg = true;        // 사용자가 직접 교체하면 false → 방향 자동전환 멈춤
  let currentDefaultSrc = null;     // 현재 적용된 기본 배경 src (중복 로드 방지)
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
  // 화면 방향에 맞는 기본 배경 적용 (가로/세로). 이미 같은 것이면 다시 안 불러옴.
  function applyDefaultBg() {
    const landscape = window.innerWidth >= window.innerHeight;
    const src = landscape ? DEFAULT_BG_LANDSCAPE : DEFAULT_BG_PORTRAIT;
    if (src === currentDefaultSrc) return;
    currentDefaultSrc = src;
    loadBackground(src);
  }
  function useCustomBg(dataUrl) {   // 사용자 직접 교체
    usingDefaultBg = false;
    loadBackground(dataUrl);
  }

  // 배경 교체(향후 첨부) — 파일 선택
  bgInput.addEventListener("change", function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) { useCustomBg(ev.target.result); };
    reader.readAsDataURL(file);
  });
  // 드래그&드롭 교체도 지원
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
  // 크기 / 시뮬레이션 그리드
  // ---------------------------------------------------------------
  let canvasW = 0, canvasH = 0, gridW = 0, gridH = 0;
  let bufA = null, bufB = null;     // Float32 파동 버퍼
  let heightData = null;            // Uint8 (wave+128) 높이맵

  function updateBgCover() {
    if (!bgReady) return;
    const scale = Math.max(canvasW / bgW, canvasH / bgH);
    const dw = bgW * scale, dh = bgH * scale;
    const dx = (canvasW - dw) / 2, dy = (canvasH - dh) / 2;
    gl.useProgram(prog);
    gl.uniform2f(uBgScale, canvasW / dw, canvasH / dh);
    gl.uniform2f(uBgOffset, -dx / dw, -dy / dh);
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

    applyDispScale();
    updateBgCover();
    if (usingDefaultBg) applyDefaultBg();   // 방향 바뀌면 가로/세로 기본 배경 자동 전환
  }
  function applyDispScale() {
    gl.useProgram(prog);
    gl.uniform2f(uDispUv, DISP_SCALE / canvasW, DISP_SCALE / canvasH);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  // 전체화면 진입/이탈(특히 폰에서 가로 회전) 시에도 방향 재평가 → 가로/세로 배경 fit
  document.addEventListener("fullscreenchange", resize);
  document.addEventListener("webkitfullscreenchange", resize);

  // ---------------------------------------------------------------
  // 파동 발생 (Res_mc 흰 원 스탬프)
  //   원본 AS3: MOUSE_DOWN / MOUSE_MOVE 둘 다 draw() 호출 → 마우스는 hover 만 해도 파동.
  //   터치: pointermove 는 접촉 중에만 발생하므로 drag 시에만 파동(요구사항).
  //   포인터(마우스/터치/펜)별로 PointerEvent 가 독립 발생 → 멀티터치 자동 지원.
  // ---------------------------------------------------------------
  function splash(cssX, cssY, peak) {
    const amp = peak == null ? 255 : peak;            // 진폭(유도용 자동물결은 약하게)
    const dpr = canvasW / window.innerWidth;
    const gx = (cssX * dpr) / LATE;
    const gy = (cssY * dpr) / LATE;
    const r = Math.max(1.5, (SPLASH_RADIUS_PX * dpr) / LATE);
    const minX = Math.max(0, Math.floor(gx - r)), maxX = Math.min(gridW - 1, Math.ceil(gx + r));
    const minY = Math.max(0, Math.floor(gy - r)), maxY = Math.min(gridH - 1, Math.ceil(gy + r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - gx, dy = y - gy;
        const d = Math.sqrt(dx * dx + dy * dy) / r;   // 0(중심)~1(가장자리)
        if (d <= 1) {
          // 코사인 페더링: 중심 amp → 가장자리 0 으로 부드럽게 (안티앨리어싱 브러시 재현)
          const v = amp * (0.5 + 0.5 * Math.cos(Math.PI * d));
          const i = y * gridW + x;
          if (v > bufA[i]) bufA[i] = v;               // 겹쳐 찍어도 어두워지지 않게 max
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
    // 빠른 드래그/이동도 끊김 없이: 합쳐진 중간 이벤트까지 모두 스탬프.
    // 동시 터치는 pointerId 별로 이 핸들러가 각각 호출되어 멀티터치가 그대로 동작.
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) splash(ev.clientX, ev.clientY);
  });

  // ---------------------------------------------------------------
  // 파동 시뮬레이션:  newB = clamp(conv(A) - B);  swap(A,B)
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
        const g = (v + 128) | 0;                 // bd_filter = wave + 128 (8bit clamp)
        const di = (y1 + x) * 4;
        const gg = g > 255 ? 255 : g;
        hd[di] = gg; hd[di + 1] = gg; hd[di + 2] = gg;
      }
    }
    bufA = B; bufB = A;                          // swap
  }

  // ---------------------------------------------------------------
  // 렌더
  // ---------------------------------------------------------------
  function render() {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridW, gridH, 0, gl.RGBA, gl.UNSIGNED_BYTE, heightData);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // 고정 40fps 타임스텝: 모니터 주사율과 무관하게 원본과 같은 속도/부드러움 유지.
  // 시뮬은 40Hz 로만 갱신하고, 화면은 매 rAF 마다 그려 디스플레이는 매끈하게.
  let acc = 0, last = performance.now();
  let fpsFrames = 0, fpsLast = last;     // 실측 FPS 카운터(원본 FPSCheck 대응)
  function loop(now) {
    let dt = now - last; last = now;
    if (dt > 250) dt = 250;        // 탭 비활성 후 복귀 시 폭주 방지
    acc += dt;
    let n = 0;
    while (acc >= STEP_MS && n < 4) { step(); acc -= STEP_MS; n++; }
    render();

    // 실측 렌더 FPS 를 0.5초마다 갱신 (목표 시뮬 FPS 도 함께 표시)
    fpsFrames++;
    if (now - fpsLast >= 500) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsLast));
      fpsEl.textContent = "FPS " + fps + " (target " + FPS + ")";
      fpsFrames = 0; fpsLast = now;
    }
    requestAnimationFrame(loop);
  }

  resize();              // 내부에서 applyDefaultBg() 호출 → 방향에 맞는 기본 배경 로드
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

  // 동작 함수 (버튼/키보드 공용)
  function openBgPicker() { bgInput.click(); }                       // b
  function toggleSound() {                                            // s
    if (soundOn) { ambient.pause(); soundOn = false; }
    else trySound();
  }
  function toggleFullscreen() {                                       // f
    if (!document.fullscreenElement) { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); }
    else if (document.exitFullscreen) document.exitFullscreen();
  }
  function toggleMenu() {                                             // m
    const hide = toolbar.classList.toggle("hidden");
    fpsEl.classList.toggle("hidden", hide);
  }

  soundBtn.addEventListener("click", toggleSound);
  hideBtn.addEventListener("click", toggleMenu);
  fsBtn.addEventListener("click", toggleFullscreen);

  // ---------------------------------------------------------------
  // 실시간 미세조정 + HUD (현재 값 잠깐 표시)
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
  function adjust(param, dir) {
    switch (param) {
      case "DAMPING":   // 1↑ / 2↓  (0.900 ~ 1.000)
        DAMPING = clamp(Math.round((DAMPING + dir * 0.002) * 1000) / 1000, 0.900, 1.000);
        showHud("DAMPING  " + DAMPING.toFixed(3)); break;
      case "DISP":      // 3↑ / 4↓  (0 ~ 240) 굴절 세기
        DISP_SCALE = clamp(DISP_SCALE + dir * 5, 0, 240); applyDispScale();
        showHud("DISP_SCALE  " + DISP_SCALE); break;
      case "SPLASH":    // 5↑ / 6↓  (2 ~ 80) 물결 반경
        SPLASH_RADIUS_PX = clamp(SPLASH_RADIUS_PX + dir * 2, 2, 80);
        showHud("SPLASH_RADIUS  " + SPLASH_RADIUS_PX); break;
      case "FPS":       // 7↑ / 8↓  (10 ~ 120)
        FPS = clamp(FPS + dir * 5, 10, 120); STEP_MS = 1000 / FPS;
        showHud("FPS  " + FPS); break;
    }
  }

  // 키보드 — 물리 키 기준(e.code)이라 한/영 입력 상태와 무관하게 동작.
  //   토글: b 배경교체 · s 소리 · f 전체화면 · m 메뉴   (누르고 있어도 1회만)
  //   미세조정: 1/2 DAMPING · 3/4 DISP_SCALE · 5/6 SPLASH_RADIUS · 7/8 FPS  (누르고 있으면 연속)
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
    }
  });

  // ---------------------------------------------------------------
  // 중앙 'Touch here' 유도: 잔잔한 자동 물결 + 힌트, 입력 시 사라지고 무입력 시 재등장
  // ---------------------------------------------------------------
  const hint = document.getElementById("hint");
  const IDLE_MS = 7000;          // 무입력 7초 후 다시 유도
  const ATTRACT_MS = 1150;       // 자동 물결 주기
  let attractOn = false, attractTimer = null, idleTimer = null;

  function attractStart() {
    if (attractOn) return;
    attractOn = true;
    if (hint) hint.classList.remove("hidden");
    attractTimer = setInterval(function () {
      if (document.hidden) return;
      const jx = (Math.random() * 2 - 1) * 10, jy = (Math.random() * 2 - 1) * 10;
      splash(window.innerWidth / 2 + jx, window.innerHeight / 2 + jy, 150); // 잔잔하게
    }, ATTRACT_MS);
  }
  function attractStop() {
    if (!attractOn) return;
    attractOn = false;
    if (hint) hint.classList.add("hidden");
    clearInterval(attractTimer); attractTimer = null;
  }
  function onUserActivity(e) {
    // 실제 터치/클릭(또는 터치 드래그)일 때만 숨김 — 마우스가 살짝 지나가는 hover 로는 안 사라짐
    if (e.type === "pointerdown" || e.pointerType === "touch") attractStop();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(attractStart, IDLE_MS);   // 무입력 지속 시 다시 유도
  }
  canvas.addEventListener("pointerdown", onUserActivity);
  canvas.addEventListener("pointermove", onUserActivity);
  attractStart();
})();
