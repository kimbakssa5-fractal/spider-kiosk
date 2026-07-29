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
  const ASSET_VER = "35";
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
  try { const _fq = parseInt(new URLSearchParams(location.search).get("fish"), 10);
        if (Number.isFinite(_fq)) FISH_COUNT = Math.max(0, Math.min(24, _fq)); } catch (e) {}  // ?fish=N 시작수 지정(exe 런처용)
  const FISH_LEN_MIN = 0.22, FISH_LEN_MAX = 0.34;  // 화면 짧은변 대비 몸길이 비율 (크게)
  const FISH_SPEED_MIN = 0.040, FISH_SPEED_MAX = 0.075; // 화면 짧은변/초 (유유히)
  // 자발적 질주(dash): 평소엔 느리게, 이따금 한두 마리가 몇 초간 빠르게 치고 나감(동시 ~1~2마리)
  const DASH_PEAK_MIN = 2.2, DASH_PEAK_MAX = 3.6;   // 순간 속도 배수(전진)
  const DASH_DUR_MIN = 1.0,  DASH_DUR_MAX = 2.4;    // 질주 지속(초)
  const DASH_GAP_MIN = 14,   DASH_GAP_MAX = 34;     // 질주와 질주 사이 간격(초) — 크게=동시에 덜 겹침(≈한두 마리)
  // 사람 쪽으로 모임(gather, 하이브리드): 잔잔한 반응엔 다가가고(호기심), 급격/강한 움직임엔 흩어짐(도망)
  let GATHER_ON = true;                              // J 토글: ON=몰려들기(흩어지기+모임) / OFF=기존 흩어지기만
  let GATHER_RESP = 1.0;                             // 몰려드는 속도/민감도(0.3~2.5) — Q/Z 조절, 선회·접근속도·반응즉시성 동시 배율
  const ATTRACT_RADIUS_FRAC = 0.85;                 // 모임 감지 반경(도망보다 넓게 — 멀리서부터 다가옴)
  const ATTRACT_GAP_FRAC    = 0.03;                 // 주둥이가 포인트에 남기는 여백(몸 절반+이 여백에서 정지 → 관통 방지)
  const ATTRACT_BAND_FRAC   = 0.14;                 // 링 오차 정규화 폭(radial 힘이 최대가 되는 거리 스케일)
  const ATTRACT_RADIAL      = 1.0;                  // 링(standoff)으로 다가감/밀려남 세기
  const ATTRACT_TANG        = 0.55;                 // 링 근처에서 접선(주위를 도는) 세기
  const ATTRACT_TURN        = 2.0;                  // 모임 선회 속도(느긋 — 살살엔 천천히 반응, 도망 FLEE_TURN만 빠름). 각속도 상한이 홱틂은 따로 차단
  const ATTRACT_SPEED_BOOST = 0.55;                 // 모임 다가갈 때 전진 가속(×(1+boost)) — 속도 완만추종이 튐은 따로 막음
  const SPEED_SMOOTH_RATE   = 1.5;                  // 평상시 속도 변화율(1/초, 낮을수록 완만) — 도망 때만 즉각
  const ALOOF_FRAC = 0.13;                          // 사람에게 무관심한 개체 비율(모임 무시하고 제 갈 길) — 도망은 함
  const ALOOF_MIN = 15, ALOOF_MAX = 45;             // 관심/무관심이 바뀌는 주기(초) — 고정 아님, 서서히 교대
  const SEP_FRAC            = 0.13;                  // 분리 '소프트' 반경 — 이 안이면 서서히 비켜 조향
  const SEP_HARD_FRAC       = 0.075;                 // 분리 '하드' 반경 — 진짜 겹칠 때만 위치를 직접 벌림(잦은 밀어냄=안절부절 방지)
  const SEP_POS_FRAC        = 0.18;                  // 하드 겹침 시 벌리는 비율(작게=부드럽게 해소, 진동 없음)
  const SEP_GAIN_GATHER     = 0.32;                  // 모임 중 분리 조향 세기(과하면 서로 피하느라 안절부절)
  const SEP_GAIN_IDLE       = 0.35;                 // 평상시 분리 조향(약하게 — 자연 군영 유지)
  const ROAM_PACK_FRAC      = 0.33;                  // 배회 존 자동 확장 계수: √(마릿수)×몸길이×이 값 이상으로 존 확보(밀집 충돌 방지)
  const TURN_RATE_MAX       = 1.55;                  // 도망 아닐 때 각속도 상한(rad/s ≈89°/s) — 홱 트는 동작 차단(도망은 제한 없음)
  const GATHER_FLEE_LO = 0.60, GATHER_FLEE_HI = 0.92; // 자극 강도 이 구간에서 attract→flee 전환
  const WOB_AMP = 0.5;                              // 개체별 헤딩 지터 세기(저주파·약하게 → 빠른 떨림 없이 부드러운 배회)
  const ANCHOR_TAU  = 1.8;                          // 관심 중심 저주파 시정수(초) — 클수록 다리 진동 더 걸러냄
  const ANCHOR_RISE = 0.6, ANCHOR_FALL = 2.5;       // 앵커 활성 상승/하강(초)
  const MAX_ANCHORS = 3;                            // 동시 모임 지점 최대 수(여러 사람 → 무리 분리)
  const CLUSTER_DIST_FRAC = 0.28;                   // 자극점 이 거리 밖이면 다른 사람(다른 클러스터)으로 분리
  const ANCHOR_MATCH_FRAC = 0.32;                   // 프레임 간 클러스터↔기존 앵커 매칭 최대 거리
  const ROAM_RADIUS_FRAC = 0.17;                    // 배회 존 반경 — 이 안에선 자유 배회, 벗어나면 복귀(작을수록 바짝 모임)
  const ROAM_KEEP_FRAC   = 0.07;                    // 앵커(사람) 바로 위는 이 반경만큼 비워 배회(관통/올라탐 방지)
  const WANDER_GATHER    = 1.05;                    // 모임 중 배회 흔들림 배수 — 존이 넓어 정체가 없으므로 평상시와 비슷하게(과하면 안절부절)
  // 모션 도망 surge 게이트: 살살(지속) 모션엔 도망 억제, 갑작스런 급변에만 도망 허용
  const MENV_ATK = 0.07, MENV_REL = 0.5;           // 포락 상승(빠름 70ms)/하강(느림 500ms)
  const MBASE_TAU = 1.6;                            // 기준선 시정수(초) — 지속 모션은 여기에 흡수됨
  const SURGE_MARGIN = 0.10;                        // 이만큼 기준선 초과해야 도망 시작(살살은 못 넘음)
  const SURGE_SCALE  = 0.55;                        // surge 정규화(이만큼 초과 시 도망 full)
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
    uniform sampler2D uEmblem; // 골드 엠블럼(물 밑 가라앉음) — E 키
    uniform float uEmblemOn;
    uniform vec2 uEmbFit;      // contain-fit 스케일(<=1)
    uniform float uTime;
    void main() {
      vec2 imgUv = vUv * uBgScale + uBgOffset;
      vec3 col = texture2D(uBg, clamp(imgUv, 0.0, 1.0)).rgb * uBgBright;
      if (uEmblemOn > 0.0) {
        vec2 euv = (vUv - 0.5) / uEmbFit + 0.5;
        if (euv.x > 0.0 && euv.x < 1.0 && euv.y > 0.0 && euv.y < 1.0) {
          vec4 em = texture2D(uEmblem, euv);
          vec3 emc = em.rgb * 0.66;                          // 물 밑 깊이감(어둡게)
          // 대각 스캔 광(좌하→우상)이 훑고 지나가며 골드 반사
          float diag = euv.x * 0.60 + (1.0 - euv.y) * 0.40;
          float phase = fract(uTime * 0.11) * 1.4 - 0.2;
          float dd = abs(diag - phase);
          float band = smoothstep(0.035, 0.0, dd) * 1.4      // 밝은 코어
                     + 0.55 * smoothstep(0.20, 0.0, dd);     // 넓은 글로우
          emc += vec3(1.0, 0.95, 0.68) * band * em.a * 3.4;  // 반사 스윕(강)
          col = mix(col, emc, clamp(em.a * 0.85 + band * em.a * 0.4, 0.0, 1.0));
        }
      }
      gl_FragColor = vec4(col, 0.0);
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
    uniform float uSunset;    // 노을 모드(0=주간, 1=노을) — N 키
    uniform float uNight;     // 별빛 밤하늘 모드(0=주간, 1=밤) — U 키
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
        // 노을 모드: 윤슬을 금빛으로 + 살짝 강하게(태양 반사길 느낌)
        vec3 gcol = mix(vec3(glint), glint * vec3(1.45, 0.82, 0.38) * 1.35, uSunset);
        gcol = mix(gcol, vec3(glint) * vec3(0.70, 0.82, 1.25) * 1.25, uNight);   // 밤=은청 반짝임
        outc += gcol * (1.0 - 0.5 * fish);                    // 물고기 위는 살짝 약하게
        // 별빛 반사(밤 전용): 물이 잔잔해도 보이는 별.
        //  ⚠ sin-해시는 셀좌표가 크면 GPU 정밀도 한계로 격자무늬(돗자리) 발생 → Hoskins 해시 사용.
        if (uNight > 0.0) {
          vec2 gpS = vUv * vec2(240.0, 158.0);
          vec2 cidS = floor(gpS); vec2 cfS = fract(gpS) - 0.5;
          vec2 hS = fract(cidS * vec2(0.1031, 0.1030));
          hS += dot(hS, hS.yx + 33.33);
          float sR1 = fract((hS.x + hS.y) * hS.x);
          float sR2 = fract((hS.x + hS.y) * hS.y);
          float sPulse = 0.55 + 0.45 * sin(uTime * (0.6 + 1.8 * sR2) + sR1 * 6.2831);
          float star = pow(sPulse, 3.0) * smoothstep(0.30, 0.02, length(cfS)) * step(0.993, sR1);
          outc += vec3(0.62, 0.74, 1.0) * star * 0.95 * uNight * (1.0 - 0.6 * fish);
          // 미세 별가루(2차 레이어, 동일 해시 — cTw 재사용 금지: 그 격자가 돗자리 원인)
          vec2 gpT = vUv * vec2(520.0, 342.0);
          vec2 cidT = floor(gpT); vec2 cfT = fract(gpT) - 0.5;
          vec2 hT = fract(cidT * vec2(0.1131, 0.0973));
          hT += dot(hT, hT.yx + 19.19);
          float tR1 = fract((hT.x + hT.y) * hT.x);
          float tR2 = fract((hT.x + hT.y) * hT.y);
          float tPulse = 0.5 + 0.5 * sin(uTime * (1.0 + 2.4 * tR2) + tR1 * 6.2831);
          float dust = pow(tPulse, 4.0) * smoothstep(0.34, 0.04, length(cfT)) * step(0.972, tR1);
          outc += vec3(0.55, 0.68, 1.0) * dust * 0.5 * uNight * (1.0 - 0.6 * fish);
        }
      }
      // 노을 틴트(N 키): 어두운 물=진한 적갈, 밝은 부분=금빛 — 사진의 석양 반사 톤
      if (uSunset > 0.0) {
        float lum = dot(outc, vec3(0.299, 0.587, 0.114));
        vec3 grade = outc * mix(vec3(1.14, 0.50, 0.22), vec3(1.36, 0.86, 0.48), smoothstep(0.08, 0.80, lum));
        grade += vec3(0.075, 0.028, 0.004);                     // 은은한 주황 앰비언트
        outc = mix(outc, grade, uSunset);
      }
      // 별빛 밤하늘 틴트(U 키): 깊은 울트라마린 — 어두운 물=남색, 밝은 부분=청백
      if (uNight > 0.0) {
        float lum2 = dot(outc, vec3(0.299, 0.587, 0.114));
        vec3 ngrade = outc * mix(vec3(0.14, 0.20, 0.52), vec3(0.60, 0.74, 1.18), smoothstep(0.06, 0.85, lum2));
        ngrade += vec3(0.006, 0.014, 0.055);
        outc = mix(outc, ngrade, uNight);
      }
      gl_FragColor = vec4(min(outc, 1.0), 1.0);
    }`;

  // ④ 프로젝터 엣지블렌딩 패스: wallTex(유효폭 연속 렌더) → 데스크톱.
  //   겹침 구간을 양쪽에 복제(wallU 접힘) + Paul Bourke 커브(γ) + 디스플레이 γ 역보정 → 이음새·경계밝기 균일.
  //   uN=1 이면 통과(wallU=vUv.x, w=1). uGrid=정렬 격자.
  const FS_BLEND = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uWall;
    uniform float uN;         // 프로젝터 수(1=off)
    uniform float uOverlap;   // 겹침 비율(0~0.49)
    uniform float uGrid;      // 정렬 그리드(0/1)
    uniform float uCurveG;    // 블렌드 커브 γ(Paul Bourke)
    uniform float uDispG;     // 디스플레이 γ 역보정
    // 빛 세기 분율 b∈[0,1] (반대편 프로젝터와 b+ (1-b)=1 로 합=1). t=램프 위치.
    float blendFrac(float t, float g) {
      t = clamp(t, 0.0, 1.0);
      if (t < 0.5) return 0.5 * pow(2.0 * t, g);
      return 1.0 - 0.5 * pow(2.0 * (1.0 - t), g);
    }
    void main() {
      float N = max(uN, 1.0);
      float f = clamp(uOverlap, 0.0, 0.49);
      float px = clamp(vUv.x, 0.0, 0.999999) * N;      // 프로젝터폭 단위 [0,N)
      float p = floor(px);
      float lx = px - p;                                // 프로젝터 내 [0,1)
      float wallU = (p * (1.0 - f) + lx) / (N - (N - 1.0) * f);
      vec3 col = texture2D(uWall, vec2(clamp(wallU, 0.0, 1.0), 1.0 - vUv.y)).rgb;
      // b = 이 프로젝터가 내야 할 빛 분율(커브 γ). 반대편과 빛 공간에서 합=1.
      float b = 1.0;
      if (p < N - 1.0 && lx > 1.0 - f) { float x = (lx - (1.0 - f)) / f; b = blendFrac(1.0 - x, uCurveG); }
      if (p > 0.5 && lx < f)           { float x = lx / f;               b = blendFrac(x,       uCurveG); }
      // 디스플레이 γ 역보정: 실제 광량=신호^γ 이므로 신호=b^(1/γ) → 광량 합이 정확히 1(밝은 장면도 거뭇함 없음).
      float w = pow(clamp(b, 0.0, 1.0), 1.0 / max(uDispG, 0.1));
      col *= w;
      if (uGrid > 0.5) {
        float lw = 0.0016 * N;
        if (p < N - 1.0 && abs(lx - (1.0 - f)) < lw) col = vec3(1.0, 0.0, 1.0);   // 겹침 경계(마젠타)
        if (p > 0.5 && abs(lx - f) < lw)             col = vec3(1.0, 0.0, 1.0);
        float edge = min(fract(px), 1.0 - fract(px));
        if (edge < lw) col = vec3(0.0, 1.0, 1.0);                                  // 프로젝터 경계(시안)
        float gv = min(abs(lx - 0.3333), abs(lx - 0.6667));
        float gh = min(abs(vUv.y - 0.3333), abs(vUv.y - 0.6667));
        if (gv < 0.0011 * N || gh < 0.0011) col = mix(col, vec3(1.0), 0.45);       // 3분할 격자
      }
      gl_FragColor = vec4(col, 1.0);
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
  const progBlend = makeProg(VS_FULL, FS_BLEND);

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
    uEmblem: gl.getUniformLocation(progBg, "uEmblem"),
    uEmblemOn: gl.getUniformLocation(progBg, "uEmblemOn"),
    uEmbFit: gl.getUniformLocation(progBg, "uEmbFit"),
    uTime: gl.getUniformLocation(progBg, "uTime"),
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
    uSunset: gl.getUniformLocation(progWater, "uSunset"),
    uNight: gl.getUniformLocation(progWater, "uNight"),
    uTime: gl.getUniformLocation(progWater, "uTime"),
    uHTexel: gl.getUniformLocation(progWater, "uHTexel"),
  };
  const locBlend = {
    aPos: gl.getAttribLocation(progBlend, "aPos"),
    uWall: gl.getUniformLocation(progBlend, "uWall"),
    uN: gl.getUniformLocation(progBlend, "uN"),
    uOverlap: gl.getUniformLocation(progBlend, "uOverlap"),
    uGrid: gl.getUniformLocation(progBlend, "uGrid"),
    uCurveG: gl.getUniformLocation(progBlend, "uCurveG"),
    uDispG: gl.getUniformLocation(progBlend, "uDispG"),
  };
  gl.useProgram(progBg);    gl.uniform1i(locBg.uBg, 0); gl.uniform1f(locBg.uBgBright, 1.0);
  gl.useProgram(progFish);  gl.uniform1i(locFish.uKoi, 2);
  gl.useProgram(progWater); gl.uniform1i(locWater.uScene, 3); gl.uniform1i(locWater.uHeight, 1); gl.uniform1f(locWater.uSunset, 0.0); gl.uniform1f(locWater.uNight, 0.0);
  gl.useProgram(progBlend); gl.uniform1i(locBlend.uWall, 5);

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
  const emblemTex = makeTex(4, gl.CLAMP_TO_EDGE, gl.LINEAR);
  // 골드 엠블럼(hillstate) 로드 + contain-fit 계산
  let EMBLEM_ON = false, embW = 1, embH = 1;
  const embImg = new Image();
  embImg.onload = function () {
    embW = embImg.naturalWidth; embH = embImg.naturalHeight;
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, emblemTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, embImg);
    embFit();
  };
  embImg.src = "assets/emblem.png?v=" + ASSET_VER;
  let embFitX = 0.9, embFitY = 0.5;
  function embFit() {
    const ea = embW / embH, ca = canvasW / Math.max(1, canvasH);
    if (ea >= ca) { embFitX = 0.94; embFitY = 0.94 * ca / ea; }
    else { embFitY = 0.94; embFitX = 0.94 * ea / ca; }
  }

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
  // wall FBO(유효폭 렌더 → 엣지블렌딩 입력). canvasW=유효폭, outW=데스크톱.
  const wallTex = makeTex(5, gl.CLAMP_TO_EDGE, gl.LINEAR);
  const wallFBO = gl.createFramebuffer();
  function resizeWallTex() {
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, wallTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvasW, canvasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, wallFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, wallTex, 0);
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
      spd: 0,                                         // 현재 전진 속도(px/s, 완만 추종 — 0=최초 프레임에 목표로 초기화)
      aloof: Math.random() < ALOOF_FRAC,              // 사람에게 무관심(모임 무시) — 주기적으로 재추첨되어 교대
      aloofT: rand(ALOOF_MIN, ALOOF_MAX),             // 관심/무관심 전환까지 남은 시간(초)
      dash: 0, dashT: 0,                              // 질주 강도(0~1, 램프)·남은 질주 시간(초)
      dashPeak: rand(DASH_PEAK_MIN, DASH_PEAK_MAX),   // 이 물고기의 질주 속도 배수
      nextDash: rand(2, DASH_GAP_MAX),                // 첫 질주까지 대기(스태거)
      orbitDir: Math.random() < 0.5 ? -1 : 1,         // 모임 시 포인트 주위를 도는 방향(시계/반시계)
      orbitRad: rand(0.7, 1.45),                      // 개인별 링 반경 배수(균일 링 방지)
      orbitSpd: rand(0.55, 1.35),                     // 개인별 접선 속도 배수(맴도는 속도 제각각)
      jf1: rand(0.2, 0.6), jf2: rand(0.5, 1.1),       // 헤딩 지터 주파수 2종(저주파 — 느린 meander, 빠른 떨림 없음)
      jp1: Math.random() * 6.28, jp2: Math.random() * 6.28,
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
  // 멀티프로젝터 엣지블렌딩(1PC 넓은창, 겹침 소프트블렌딩) — 07과 동일, 61_edge 감마 방식.
  // 설치 현장 키: O=대수 G=정렬격자 ;'=겹침 -=+블렌드커브γ ,.=디스플레이γ역보정.
  let PROJ_N = 1, PROJ_OVERLAP = 0.12, BLEND_CURVE_GAMMA = 2.0, DISP_GAMMA = 2.2, ALIGN_GRID = false;
  let outW = 0, outH = 0;            // 데스크톱(출력) 픽셀 — canvasW/H 는 유효 벽폭(렌더)
  try {
    const _sp = new URLSearchParams(location.search);
    const _pn = parseInt(_sp.get("proj"), 10);
    if ([1, 2, 3].indexOf(_pn) >= 0) PROJ_N = _pn;
    else { const _ls = parseInt(localStorage.getItem("proj_n"), 10); if ([1, 2, 3].indexOf(_ls) >= 0) PROJ_N = _ls; }
    const _ov = parseFloat(_sp.get("overlap"));
    if (Number.isFinite(_ov)) PROJ_OVERLAP = Math.max(0, Math.min(0.45, _ov));
    else { const _lo = parseFloat(localStorage.getItem("proj_overlap")); if (Number.isFinite(_lo)) PROJ_OVERLAP = Math.max(0, Math.min(0.45, _lo)); }
    const _cg = parseFloat(localStorage.getItem("proj_curvegamma")); if (Number.isFinite(_cg)) BLEND_CURVE_GAMMA = Math.max(1.0, Math.min(4.0, _cg));
    const _dg = parseFloat(localStorage.getItem("proj_dispgamma")); if (Number.isFinite(_dg)) DISP_GAMMA = Math.max(1.0, Math.min(3.0, _dg));
  } catch (e) {}
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
    outW = Math.round(window.innerWidth * dpr);        // 데스크톱(N개 프로젝터 폭 합)
    outH = Math.round(window.innerHeight * dpr);
    canvas.width = outW;
    canvas.height = outH;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    // 유효 벽폭(Weff): 겹침 접힘. 1대면 = 데스크톱. 씬/물은 canvasW(=Weff)로 렌더.
    const eff = (PROJ_N > 1) ? (PROJ_N - (PROJ_N - 1) * PROJ_OVERLAP) / PROJ_N : 1;
    canvasW = Math.max(1, Math.round(outW * eff));
    canvasH = outH;
    gl.viewport(0, 0, canvasW, canvasH);

    gridW = Math.max(1, Math.round(canvasW / LATE));
    gridH = Math.max(1, Math.round(canvasH / LATE));
    bufA = new Float32Array(gridW * gridH);
    bufB = new Float32Array(gridW * gridH);
    heightData = new Uint8Array(gridW * gridH * 4);
    for (let i = 3; i < heightData.length; i += 4) heightData[i] = 255;

    resizeSceneTex();
    resizeWallTex();
    applyDispScale();
    updateBgCover();
    embFit();                                          // 엠블럼 contain-fit 재계산
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
    // 멀티스크린: X=콘텐츠폭(gridW)·Y=콘텐츠높이(gridH) 로 분리 매핑.
    //   canvasW=Weff(겹침 접힘)라 dpr=canvasW/innerWidth 를 세로에도 쓰면 Y가 eff 만큼 압축되던 버그 수정.
    //   입력(cssX)은 콘텐츠-CSS px: Kinect/마우스=투영모서리 선형보정이라 데스크톱-UV≈콘텐츠-UV, 웹캠=카메라FOV=벽 직접.
    const sw = gridW / (window.innerWidth || gridW);
    const sh = gridH / (window.innerHeight || gridH);
    const gx = cssX * sw;
    const gy = cssY * sh;
    const r = Math.max(1.5, SPLASH_RADIUS_PX * sh);
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
  let gatherAnchors = [];  // 모임 관심 중심 배열(다중 — 여러 사람이면 무리가 나뉨). 각 {x,y,act}, 저주파 필터로 다리 진동 무시
  let motionEnv = 0, motionBase = 0;          // 모션 에너지 포락(빠른)·기준선(느린) → 둘의 차 = 갑작스러움(surge)
  // ── 입력 소스 자동 전환: Kinect(=OS 터치주입) 있으면 터치 우선, 없으면 웹캠 유지 ──
  let lastTouchT = -999;                       // 마지막 '터치'(Kinect 주입/터치스크린) 시각(초)
  const TOUCH_SUPPRESS_S = 6;                   // 터치 후 이 시간 동안 웹캠 모션 억제(Kinect 우선)
  function nowSec() { return performance.now() / 1000; }
  function touchActiveNow() { return (nowSec() - lastTouchT) < TOUCH_SUPPRESS_S; }
  function notePointer(id, x, y) {
    const t = nowSec(), prev = pointers.get(id);
    let spd = 0;                                     // px/초 — 느린 포인터=호기심(모임), 빠른 스와이프=놀람(도망)
    if (prev) { const dt = Math.max(1e-3, t - prev.t); spd = Math.hypot(x - prev.x, y - prev.y) / dt; }
    pointers.set(id, { x: x, y: y, t: t, spd: spd });
  }
  function dropPointer(id) { pointers.delete(id); }

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "touch") lastTouchT = nowSec();   // Kinect 주입/터치스크린 → 웹캠 억제
    splash(e.clientX, e.clientY);
    playSplash(1);                       // 접촉 파문 → 찰방
    notePointer(e.pointerId, e.clientX, e.clientY);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener("pointermove", function (e) {
    if (e.pointerType === "touch") lastTouchT = nowSec();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) splash(ev.clientX, ev.clientY);
    playSplash(0.4);                      // 이동/드래그 파문 → 잔잔한 찰방(버스트 제한)
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
      motionPoints = (fbCooldown || touchActiveNow()) ? [] : pts;   // 냉각 중 or 터치(Kinect) 활성 시 도망점 차단
    }
    prevLuma = luma;
  }

  // 물결은 '실제 움직인 미세 셀'에서 발생 + 셀 내부 랜덤 지터 → 격자 정렬 없이 사람 움직임을 따라감.
  function motionSplashes() {
    const cells = motionCells;
    if (!cells.length) return;
    if (fbCooldown) return;    // 되먹임 냉각 중(넓게 퍼진 일렁임 지속) — updateMotion 이 판정
    if (touchActiveNow()) return;   // 터치(Kinect) 활성 시 웹캠 물결 억제 → Kinect 우선
    const W = window.innerWidth, H = window.innerHeight;
    const n = Math.min(MOTION_SPLASH_N, cells.length);
    let maxd = 0;
    for (let i = 0; i < n; i++) {
      const c = cells[(Math.random() * cells.length) | 0];   // 강한 영역일수록 셀이 많아 더 자주 뽑힘
      const sx = ((c.x + Math.random()) / MW) * W;            // 셀 내부 지터(연속 위치)
      const sy = ((c.y + Math.random()) / MH) * H;
      splash(sx, sy, 70 + 90 * Math.min(1, c.d / 100));       // 작은 물결 다수 → 자연스러운 교란
      if (c.d > maxd) maxd = c.d;
    }
    playSplash(0.35 + 0.65 * Math.min(1, maxd / 100));         // 카메라 앞 사람 접근 → 찰방(세기 비례)
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
      // it = 자극 강도(0~1): 느린 포인터(<150px/s)=0.2 호기심 → 빠른 스와이프(>1400)=1.0 놀람
      else active.push({ x: p.x, y: p.y, w: 1, r: 1, it: 0.2 + 0.8 * Math.max(0, Math.min(1, ((p.spd || 0) - 150) / 1250)), src: 'p' });
    });
    // 모션 점: it = strength 가중 w (약한 모션=낮음=모임, 큰 모션=1=도망)
    let mNow = 0;
    for (let mi = 0; mi < motionPoints.length; mi++) { const m = motionPoints[mi]; active.push({ x: m.x, y: m.y, w: m.w, r: m.r, it: m.w, src: 'm' }); mNow += m.w; }
    // 모션 급변(surge) 게이트: 포락(빠름)−기준선(느림). 살살 지속 모션은 기준선에 흡수→gate≈0(도망 억제),
    //   갑작스런 급변만 포락이 튀어 gate↑(도망 허용). → 발을 살살 좌우로 저어도 틱틱 안 함, 확 움직이면 도망.
    motionEnv += (mNow - motionEnv) * (mNow > motionEnv ? (1 - Math.exp(-dtSec / MENV_ATK)) : (1 - Math.exp(-dtSec / MENV_REL)));
    motionBase += (mNow - motionBase) * (1 - Math.exp(-dtSec / MBASE_TAU));
    const fleeGate = Math.max(0, Math.min(1, (motionEnv - motionBase - SURGE_MARGIN) / SURGE_SCALE));
    const fleeR = FLEE_RADIUS_FRAC * minDim;
    // 모임 관심 중심(다중 anchor): 모임성 자극점들을 근접 클러스터로 묶어, 각 클러스터를 저주파로 추종.
    //   → 여러 사람이 떨어져 서 있으면 클러스터가 나뉘어 앵커도 여러 개 → 무리가 각자 가까운 앵커로 분산.
    //   → 각 앵커는 저역통과라 다리 좌우 진동은 걸러짐.
    {
      const cdist = CLUSTER_DIST_FRAC * minDim;
      const groups = [];   // 이번 프레임 클러스터: {sx,sy,sw,cx,cy}
      if (GATHER_ON) {
        for (let pi = 0; pi < active.length; pi++) {
          const a = active[pi];
          const it = (a.it != null ? a.it : a.w);
          let ft = (it - GATHER_FLEE_LO) / (GATHER_FLEE_HI - GATHER_FLEE_LO);
          ft = ft < 0 ? 0 : ft > 1 ? 1 : ft;
          const attract01 = 1 - ft * ft * (3 - 2 * ft);
          if (attract01 <= 0.2) continue;
          const wt = attract01 * a.w;
          let best = null, bd = cdist;
          for (let gi = 0; gi < groups.length; gi++) { const g = groups[gi]; const d = Math.hypot(g.cx - a.x, g.cy - a.y); if (d < bd) { bd = d; best = g; } }
          if (best) { best.sx += a.x * wt; best.sy += a.y * wt; best.sw += wt; best.cx = best.sx / best.sw; best.cy = best.sy / best.sw; }
          else groups.push({ sx: a.x * wt, sy: a.y * wt, sw: wt, cx: a.x, cy: a.y });
        }
      }
      // 클러스터 ↔ 기존 앵커 매칭(가까운 것끼리), 매칭된 앵커는 저주파로 이동
      const mdist = ANCHOR_MATCH_FRAC * minDim;
      const kk = 1 - Math.exp(-dtSec / ANCHOR_TAU);
      const usedA = [];
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]; let ai = -1, bd = mdist;
        for (let j = 0; j < gatherAnchors.length; j++) { if (usedA[j]) continue; const d = Math.hypot(gatherAnchors[j].x - g.cx, gatherAnchors[j].y - g.cy); if (d < bd) { bd = d; ai = j; } }
        if (ai >= 0) { const an = gatherAnchors[ai]; an.x += (g.cx - an.x) * kk; an.y += (g.cy - an.y) * kk; an.act = Math.min(1, an.act + dtSec / ANCHOR_RISE * GATHER_RESP); an._hit = true; usedA[ai] = true; }
        else if (gatherAnchors.length < MAX_ANCHORS) { gatherAnchors.push({ x: g.cx, y: g.cy, act: Math.min(1, dtSec / ANCHOR_RISE * GATHER_RESP), _hit: true }); }
      }
      // 매칭 안 된 앵커는 활성 감소, 소멸하면 제거
      for (let j = gatherAnchors.length - 1; j >= 0; j--) {
        if (!gatherAnchors[j]._hit) { gatherAnchors[j].act = Math.max(0, gatherAnchors[j].act - dtSec / ANCHOR_FALL); if (gatherAnchors[j].act <= 0.001) gatherAnchors.splice(j, 1); }
        else gatherAnchors[j]._hit = false;
      }
    }
    // 모임 밀집도: 관심 있는 마릿수를 활성 앵커 수로 나눔 → 배회 존을 그만큼 넓혀 서로 부대끼지 않게
    let nInterested = 0, nActiveAnchors = 0;
    for (let i = 0; i < fishes.length; i++) if (!fishes[i].aloof) nInterested++;
    for (let i = 0; i < gatherAnchors.length; i++) if (gatherAnchors[i].act > 0.05) nActiveAnchors++;
    const perAnchor = nActiveAnchors > 0 ? nInterested / nActiveAnchors : nInterested;
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

      // --- 하이브리드: 잔잔한 자극엔 다가가고(모임), 강한 자극엔 멀어짐(도망) ---
      //   자극 강도 it 로 flee01(0~1) 계산 → attract01=1-flee01. 도망은 좁은 반경/패닉, 모임은 넓은 반경/느긋.
      let ax = 0, ay = 0, maxS = 0;                  // 도망 누적(멀어지는 방향)
      for (let pi = 0; pi < active.length; pi++) {   // 도망만 자극별 즉각 반응(모임은 저주파 anchor 사용)
        const a = active[pi];
        const dx = fx - a.x, dy = fy - a.y;          // 자극→물고기
        const dist = Math.hypot(dx, dy) || 1;
        const it = (a.it != null ? a.it : a.w);
        // flee01: it 이 LO 이하=0(순수 모임) → HI 이상=1(순수 도망), 사이는 smoothstep
        let ft = (it - GATHER_FLEE_LO) / (GATHER_FLEE_HI - GATHER_FLEE_LO);
        ft = ft < 0 ? 0 : ft > 1 ? 1 : ft;
        // 모션은 surge 게이트 곱 → 살살 지속 모션은 도망 억제(틱틱 방지), 갑작스런 급변만 통과. 포인터(터치)는 즉각 유지.
        const flee01 = ft * ft * (3 - 2 * ft) * (a.src === 'm' ? fleeGate : 1);
        const rad = fleeR * (a.r || 1);
        if (flee01 > 0.01 && dist < rad) {
          const s = (1 - dist / rad) * a.w * flee01;
          const inv = s / dist;
          ax += dx * inv; ay += dy * inv;
          if (s > maxS) maxS = s;
        }
      }
      // 물고기끼리 분리(몸통 겹침 방지) — 근처 개체로부터 밀려남
      //   sepx/sepy = 헤딩 조향용 방향 / pushX/pushY = 겹친 만큼 직접 벌릴 px(확실한 간격 유지)
      let sepx = 0, sepy = 0, pushX = 0, pushY = 0;
      // 분리 반경은 '몸 크기' 기준(화면 기준이면 작은 물고기 다수일 때 과도하게 밀쳐 안절부절)
      const sepR = Math.max(SEP_FRAC * minDim * 0.38, lenPx * 0.45);
      const sepHard = Math.max(SEP_HARD_FRAC * minDim * 0.4, lenPx * 0.26);
      for (let j = 0; j < fishes.length; j++) {
        if (j === k) continue;
        const o = fishes[j];
        const ox = o.nx * W, oy = o.ny * H;
        const ddx = fx - ox, ddy = fy - oy;
        const dd = Math.hypot(ddx, ddy);
        if (dd > 0 && dd < sepR) {
          const push = (1 - dd / sepR) / dd; sepx += ddx * push; sepy += ddy * push;
          if (dd < sepHard) {                        // 진짜 겹칠 때만 위치를 직접 벌림(소프트 구간은 조향으로만)
            const overlap = sepHard - dd;
            pushX += (ddx / dd) * overlap; pushY += (ddy / dd) * overlap;
          }
        }
      }
      let gather01 = 0;                              // 이 프레임 모임 세기(전진 가속용)
      let wanderMul = 1;                             // 배회 흔들림 배수(모임 중 크게 → 제자리 정체 방지)
      let inGather = false;                          // 이 프레임 모임 상태(질주 억제 → 모여선 천천히 유영)
      // 관심/무관심 교대: 일정 시간마다 재추첨 → 항상 몇 마리는 사람에 무관심하게 제 갈 길(도망은 함)
      f.aloofT -= dtSec;
      if (f.aloofT <= 0) { f.aloof = Math.random() < ALOOF_FRAC; f.aloofT = rand(ALOOF_MIN, ALOOF_MAX); }
      if (maxS > 0 && (ax || ay)) {                  // 도망 우선(놀람)
        const desired = Math.atan2(ay, ax);
        let diff = desired - f.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // [-π,π]
        f.heading += diff * Math.min(1, FLEE_TURN * (0.3 + maxS) * dtSec);
        const tgt = Math.min(1.2, maxS * PANIC_GAIN); // 근접 강도 증폭 → 더 예민
        if (tgt > f.panic) f.panic = tgt;            // 흥분도 상승
      } else if (gatherAnchors.length > 0 && !f.aloof) {  // 도망 없고 관심 있을 때만: 가까운 anchor 주변 배회(무관심 개체는 아래 자유 유영)
        let an = null, ad = 1e9;
        for (let j = 0; j < gatherAnchors.length; j++) { const g = gatherAnchors[j]; if (g.act <= 0.05) continue; const d = Math.hypot(g.x - fx, g.y - fy); if (d < ad) { ad = d; an = g; } }
        if (an) {
        // 개인별 배회 존(orbitRad로 크기 제각각). 존 밖=복귀 / 앵커 바로 위=비켜남 / 존 안=자유 배회
        const px = an.x, py = an.y;
        const rdx = fx - px, rdy = fy - py;          // 앵커→물고기
        const rd = Math.hypot(rdx, rdy) || 1;
        // 존 반경: 기본값과 '√마릿수 × 몸길이' 중 큰 값 → 여러 마리여도 몸이 겹칠 만큼 좁아지지 않음
        const roam = Math.max(ROAM_RADIUS_FRAC * minDim, Math.sqrt(Math.max(1, perAnchor)) * lenPx * ROAM_PACK_FRAC) * f.orbitRad;
        const keep = ROAM_KEEP_FRAC * minDim;
        // 분리 힘을 0~1 스케일로 정규화(×sepR) → 아래에서 '힘 크기에 비례'해 조향(미약하면 거의 안 틂)
        let vx = sepx * sepR * SEP_GAIN_GATHER, vy = sepy * sepR * SEP_GAIN_GATHER;
        if (rd > roam) {                              // 존 밖 → 안쪽으로 복귀(주둥이 방향)
          const over = Math.min(1, (rd - roam) / (ATTRACT_BAND_FRAC * minDim));
          vx += -(rdx / rd) * over * ATTRACT_RADIAL; vy += -(rdy / rd) * over * ATTRACT_RADIAL;
          gather01 = an.act * over;                   // 복귀 시에만 살짝 가속
        } else if (rd < keep) {                       // 앵커(사람) 바로 위 → 밖으로 비켜 배회(관통/올라탐 방지)
          const near = (keep - rd) / keep;
          vx += (rdx / rd) * near * ATTRACT_RADIAL; vy += (rdy / rd) * near * ATTRACT_RADIAL;
        }
        // 존 안에서는 radial 0 → 자유 배회(아래 wander/jitter가 배회를 담당)
        //   조향은 '힘 크기에 비례'(vm) + 미약하면 무시(deadband) → 이웃이 조금 스칠 때마다 홱홱 트는 안절부절 방지
        const vm = Math.hypot(vx, vy);
        if (vm > 0.06) {
          const desired = Math.atan2(vy, vx);
          let diff = desired - f.heading;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          f.heading += diff * Math.min(1, ATTRACT_TURN * GATHER_RESP * Math.min(1, vm) * dtSec);
        }
        wanderMul = WANDER_GATHER;                    // 모여서도 계속 배회하도록 흔들림 강화
        inGather = true;                              // 모임 중 → 질주(dash) 억제, 속도 변화도 완만히
        }
      } else if (sepx || sepy) {                      // 평상시: 약한 분리만(자연 군영 유지, 힘 크기 비례)
        const sm = Math.hypot(sepx, sepy) * sepR;
        if (sm > 0.06) {
          const desired = Math.atan2(sepy, sepx);
          let diff = desired - f.heading;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          f.heading += diff * Math.min(1, ATTRACT_TURN * SEP_GAIN_IDLE * Math.min(1, sm) * dtSec);
        }
      }
      // 패닉 감쇠
      f.panic *= Math.exp(-dtSec / PANIC_DECAY);
      if (f.panic < 0.003) f.panic = 0;

      // --- 자발적 질주(dash): 고요할 때만(모임 중엔 금지 — 모여선 천천히 유영), 이따금 몇 초간 가속 ---
      if (f.panic < 0.05 && !inGather) {
        if (f.dashT > 0) {                                     // 질주 중 → 강도 램프업
          f.dashT -= dtSec;
          f.dash += (1 - f.dash) * Math.min(1, dtSec * 2.5);
        } else {
          f.nextDash -= dtSec;
          if (f.nextDash <= 0) {                               // 새 질주 시작
            f.dashT = rand(DASH_DUR_MIN, DASH_DUR_MAX);
            f.nextDash = rand(DASH_GAP_MIN, DASH_GAP_MAX);
            f.dashPeak = rand(DASH_PEAK_MIN, DASH_PEAK_MAX);
          }
          f.dash += (0 - f.dash) * Math.min(1, dtSec * 1.4);   // 질주 아니면 강도 램프다운
        }
      } else {                                                 // 도망/모임 중엔 질주 취소(모임은 부드럽게 감쇠)
        f.dashT = 0;
        f.dash += (0 - f.dash) * Math.min(1, dtSec * (inGather ? 1.2 : 2.5));
        if (inGather) f.nextDash = rand(DASH_GAP_MIN, DASH_GAP_MAX);  // 모임 해제 후 곧바로 튀지 않게 재장전
      }
      if (f.dash < 0.002) f.dash = 0;
      const dashMul = 1 + f.dash * (f.dashPeak - 1);           // 1 → dashPeak

      // 천천히 배회: heading 에 느린 사인 흔들림 (패닉 시엔 약화, 모임 중엔 wanderMul로 강화 → 제자리 정체 방지)
      f.heading += Math.sin(tSec * f.turnFreq * 6.2831 + f.turnPhase) * f.turnAmp * dtSec * (1 - Math.min(1, f.panic)) * wanderMul;
      // 개체별 불규칙 유영: 서로 다른 두 주파수의 부드러운 지터를 heading 에 더함 → 모여도 동기화된 몸짓 안 생김
      const jit = Math.sin(tSec * f.jf1 + f.jp1) * 0.62 + Math.sin(tSec * f.jf2 + f.jp2) * 0.38;
      f.heading += jit * WOB_AMP * dtSec * (1 - Math.min(1, f.panic)) * wanderMul;
      // 각속도 상한(도망 제외): 이 프레임 총 회전량을 제한 → 모여서도 홱 트는 동작 없이 부드럽게
      if (f.panic < 0.05) {
        let dh = f.heading - oldHeading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const maxDh = TURN_RATE_MAX * dtSec;
        if (dh > maxDh) f.heading = oldHeading + maxDh;
        else if (dh < -maxDh) f.heading = oldHeading - maxDh;
      }
      // 꼬리짓 박자도 개체별로 미세하게 출렁(±15%) → 몸 흔드는 리듬 제각각
      const beat = 1 + 0.15 * Math.sin(tSec * f.jf1 * 0.5 + f.jp2);
      f.frame += f.animFps * beat * (1 + f.panic * 1.8 + f.dash * 0.9) * dtSec;   // 패닉/질주 시 꼬리짓 빨라짐

      // 회전축: 평상시엔 몸 중앙, 도망(패닉)할수록 머리로 → 머리 고정하고 몸·꼬리가 휙 돈다
      const pivotW = Math.min(1, f.panic * 1.3);
      const headPivotCx = headX - Math.cos(f.heading) * hl;
      const headPivotCy = headY - Math.sin(f.heading) * hl;
      let cxC = fx + (headPivotCx - fx) * pivotW;
      let cyC = fy + (headPivotCy - fy) * pivotW;

      // 전진(heading 방향) — 목표속도(패닉·질주·모임 가속) → 완만히 추종(도망만 즉각) = 평소엔 튀지 않는 유영
      const speedTarget = f.speedFrac * minDim * (1 + f.panic * FLEE_BOOST) * dashMul * (1 + gather01 * ATTRACT_SPEED_BOOST * GATHER_RESP);
      if (!f.spd) f.spd = speedTarget;
      f.spd += (speedTarget - f.spd) * Math.min(1, dtSec * (f.panic > 0.05 ? 14 : SPEED_SMOOTH_RATE));
      const speedPx = f.spd;
      cxC += Math.cos(f.heading) * speedPx * dtSec;
      cyC += Math.sin(f.heading) * speedPx * dtSec;
      // 직접 위치 분리: 겹친 만큼의 절반을 이 프레임에 벌림(양쪽이 각자 처리 → 수렴) — 몸통 겹침 확실히 방지
      cxC += pushX * SEP_POS_FRAC; cyC += pushY * SEP_POS_FRAC;
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
    gl.uniform1i(locBg.uEmblem, 4);
    gl.uniform1f(locBg.uEmblemOn, EMBLEM_ON ? 1.0 : 0.0);
    gl.uniform2f(locBg.uEmbFit, embFitX, embFitY);
    gl.uniform1f(locBg.uTime, (performance.now() - startT) / 1000);
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

    // ③ 물 패스 → wallFBO (유효폭 연속 렌더)
    gl.bindFramebuffer(gl.FRAMEBUFFER, wallFBO);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(progWater);
    gl.uniform1f(locWater.uTime, (performance.now() - startT) / 1000);  // 윤슬 반짝임
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(locWater.aPos);
    gl.vertexAttribPointer(locWater.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ④ 엣지블렌딩 → 화면(데스크톱). PROJ_N=1 이면 통과.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(progBlend);
    gl.uniform1f(locBlend.uN, PROJ_N);
    gl.uniform1f(locBlend.uOverlap, PROJ_OVERLAP);
    gl.uniform1f(locBlend.uGrid, ALIGN_GRID ? 1.0 : 0.0);
    gl.uniform1f(locBlend.uCurveG, BLEND_CURVE_GAMMA);
    gl.uniform1f(locBlend.uDispG, DISP_GAMMA);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(locBlend.aPos);
    gl.vertexAttribPointer(locBlend.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
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

  // ---- 물 찰방 효과음 (실제 음원 assets/splash1~4.wav, WebAudio 버퍼) ----
  //   접근/터치로 파문이 생길 때 4종 랜덤 재생. 버스트 최대 2회(2번째 작게)+~1초 프리즈(따발총 방지).
  //   soundOn 연동, 세기 비례 음량, 물소리 볼륨(_splashVol) 슬라이더/[ ]키. 초기 10%.
  let _actx = null, _splashGain = null;
  let _splashBufs = [], _splashLoading = false;
  let _splashVol = 0.1;                          // 물소리 마스터 볼륨(0~1) — 슬라이더 / [ ] 키 (초기 10%)
  let _burstActive = false, _burstStartMs = 0, _chainUsed = false, _freezeUntil = 0;
  const SPLASH_2ND_MIN_MS = 70, SPLASH_CHAIN_MS = 260, SPLASH_FREEZE_MS = 1000, SPLASH_2ND_VOL = 0.5;
  const SPLASH_FILES = ["assets/splash1.wav", "assets/splash2.wav", "assets/splash3.wav", "assets/splash4.wav"];
  function ensureAudio() {
    if (_actx) return _actx;
    try {
      _actx = new (window.AudioContext || window.webkitAudioContext)();
      _splashGain = _actx.createGain();
      _splashGain.gain.value = _splashVol;
      _splashGain.connect(_actx.destination);
      loadSplashBuffers();
    } catch (e) { _actx = null; }
    return _actx;
  }
  function loadSplashBuffers() {
    if (_splashLoading || !_actx) return;
    _splashLoading = true;
    SPLASH_FILES.forEach(function (url, i) {
      fetch(url + "?v=" + ASSET_VER).then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) { return _actx.decodeAudioData(ab); })
        .then(function (buf) { _splashBufs[i] = buf; })
        .catch(function () {});
    });
  }
  function _emitSplash(ac, strength, rel) {
    const ready = _splashBufs.filter(Boolean);
    if (!ready.length) return;
    const s = Math.max(0.15, Math.min(1, strength == null ? 0.6 : strength));
    const src = ac.createBufferSource();
    src.buffer = ready[(Math.random() * ready.length) | 0];
    src.playbackRate.value = 0.92 + Math.random() * 0.18;
    const g = ac.createGain();
    g.gain.value = (0.28 + 0.72 * s) * rel;
    src.connect(g); g.connect(_splashGain);
    src.start();
  }
  function playSplash(strength) {
    if (!soundOn) return;
    const ac = ensureAudio();
    if (!ac) return;
    if (ac.state === "suspended") { try { ac.resume(); } catch (_) {} }
    const now = performance.now();
    if (_burstActive) {
      const dt = now - _burstStartMs;
      if (!_chainUsed && dt >= SPLASH_2ND_MIN_MS && dt <= SPLASH_CHAIN_MS) {
        _chainUsed = true;
        _emitSplash(ac, strength, SPLASH_2ND_VOL);
        _freezeUntil = now + SPLASH_FREEZE_MS;
        return;
      }
      if (now < _freezeUntil) return;
      _burstActive = false;
    }
    _burstActive = true; _chainUsed = false; _burstStartMs = now;
    _freezeUntil = now + SPLASH_FREEZE_MS;
    _emitSplash(ac, strength, 1.0);
  }
  function setSplashVol(v) {
    _splashVol = Math.max(0, Math.min(1, v));
    if (_splashGain) _splashGain.gain.value = _splashVol;
    const sl = document.getElementById("splashVolSlider");
    if (sl) sl.value = Math.round(_splashVol * 100);
    showHud("물소리 볼륨 " + Math.round(_splashVol * 100) + "%");
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
    ["KeyY", "윤슬 Y"], ["KeyN", "노을 N"], ["KeyU", "밤하늘 U"], ["KeyE", "엠블럼 E"], ["KeyJ", "흩어↔몰림 J"], ["KeyQ", "몰림속도+ Q"], ["KeyZ", "몰림속도- Z"], ["KeyR", "몰림리셋 R"], ["KeyI", "손숨김 I"], ["KeyM", "메뉴 M"], ["KeyF", "전체화면 F"], ["KeyH", "도움말 H"],
    ["KeyO", "프로젝터 O"], ["KeyG", "정렬격자 G"], ["Semicolon", "겹침- ;"], ["Quote", "겹침+ '"], ["Minus", "커브γ- -"], ["Equal", "커브γ+ ="], ["Comma", "화면γ- ,"], ["Period", "화면γ+ ."],
    ["Digit1", "감쇠+ 1"], ["Digit2", "감쇠- 2"], ["Digit3", "굴절+ 3"],
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

  // ── 단축키 모음 도움말 (H 키) ── VKEYS + 목록에 없는 키를 한 화면에.
  const helpEl = document.getElementById("help");
  const HELP_EXTRA = [["BracketLeft", "물소리- ["], ["BracketRight", "물소리+ ]"], ["KeyK", "가상키보드 K"]];
  if (helpEl) {
    const card = document.createElement("div"); card.className = "help-card";
    const h = document.createElement("div"); h.className = "help-title"; h.textContent = "⌨ 단축키 모음 — H 로 닫기";
    card.appendChild(h);
    const grid = document.createElement("div"); grid.className = "help-grid";
    VKEYS.concat(HELP_EXTRA).forEach(function (k) {
      const item = document.createElement("div"); item.className = "help-item"; item.textContent = k[1];
      grid.appendChild(item);
    });
    card.appendChild(grid);
    helpEl.appendChild(card);
    helpEl.addEventListener("click", function () { helpEl.classList.add("hidden"); });
  }
  function toggleHelp() {
    if (!helpEl) return;
    const open = !helpEl.classList.toggle("hidden");
    showHud(open ? "단축키 도움말 (H로 닫기)" : "");
  }

  // ── 멀티프로젝터 엣지블렌딩 조정(설치 현장, 07/61_edge 방식) ──
  function saveProjCfg() {
    try {
      localStorage.setItem("proj_n", String(PROJ_N));
      localStorage.setItem("proj_overlap", PROJ_OVERLAP.toFixed(3));
      localStorage.setItem("proj_curvegamma", BLEND_CURVE_GAMMA.toFixed(2));
      localStorage.setItem("proj_dispgamma", DISP_GAMMA.toFixed(2));
    } catch (e) {}
  }
  function setProjN(n) {
    PROJ_N = [1, 2, 3].indexOf(n) >= 0 ? n : 1;
    saveProjCfg(); resize();
    showHud(PROJ_N > 1 ? ("프로젝터 " + PROJ_N + "대 (겹침 " + Math.round(PROJ_OVERLAP * 100) + "%)") : "단일 화면");
  }
  function cycleProj() { setProjN(PROJ_N >= 3 ? 1 : PROJ_N + 1); }
  function setOverlap(delta) {
    PROJ_OVERLAP = Math.max(0, Math.min(0.45, PROJ_OVERLAP + delta));
    saveProjCfg(); resize();
    showHud(PROJ_N > 1 ? ("겹침 " + Math.round(PROJ_OVERLAP * 100) + "% (프로젝터 " + PROJ_N + "대)") : "겹침 " + Math.round(PROJ_OVERLAP * 100) + "% (프로젝터 1대라 미적용)");
  }
  function setCurveGamma(delta) {
    BLEND_CURVE_GAMMA = Math.max(1.0, Math.min(4.0, +(BLEND_CURVE_GAMMA + delta).toFixed(2)));
    saveProjCfg();
    showHud(PROJ_N > 1 ? ("블렌드 커브 γ  " + BLEND_CURVE_GAMMA.toFixed(1)) : ("커브 γ " + BLEND_CURVE_GAMMA.toFixed(1) + " (프로젝터 1대라 미적용)"));
  }
  function setDispGamma(delta) {
    DISP_GAMMA = Math.max(1.0, Math.min(3.0, +(DISP_GAMMA + delta).toFixed(2)));
    saveProjCfg();
    showHud(PROJ_N > 1 ? ("디스플레이 γ  " + DISP_GAMMA.toFixed(1) + " (경계 밝기 보정)") : ("디스플레이 γ " + DISP_GAMMA.toFixed(1) + " (프로젝터 1대라 미적용)"));
  }
  function toggleAlignGrid() { ALIGN_GRID = !ALIGN_GRID; showHud(ALIGN_GRID ? "정렬 그리드 ON (G)" : "정렬 그리드 OFF"); }
  function toggleGather() { GATHER_ON = !GATHER_ON; showHud(GATHER_ON ? "몰려들기 ON (J) — 흩어지기+모임" : "흩어지기만 (모임 OFF, J)"); }
  function setGatherResp(dir) { GATHER_RESP = clamp(Math.round((GATHER_RESP + dir * 0.15) * 100) / 100, 0.3, 2.5); showHud("몰려드는 속도  " + Math.round(GATHER_RESP * 100) + "%"); }
  function resetGatherResp() { GATHER_RESP = 1.0; showHud("몰려드는 속도  100% (기본)"); }

  const glitterBtn = document.getElementById("glitterBtn");
  const glitterSlider = document.getElementById("glitterSlider");
  function refreshGlitterUI() { if (glitterBtn) glitterBtn.textContent = GLITTER_ON ? "윤슬 ON (Y)" : "윤슬 OFF (Y)"; }
  // 노을 모드(N): 물 반사를 석양 톤(금빛 윤슬+주황 틴트)으로. 주간은 기존 그대로.
  let SUNSET_ON = false, NIGHT_ON = false;
  function applyTimeMode() {
    gl.useProgram(progWater);
    gl.uniform1f(locWater.uSunset, SUNSET_ON ? 1.0 : 0.0);
    gl.uniform1f(locWater.uNight, NIGHT_ON ? 1.0 : 0.0);
  }
  function toggleSunset() {
    SUNSET_ON = !SUNSET_ON; if (SUNSET_ON) NIGHT_ON = false;
    applyTimeMode(); showHud(SUNSET_ON ? "노을 모드" : "주간 모드");
  }
  function toggleNight() {
    NIGHT_ON = !NIGHT_ON; if (NIGHT_ON) SUNSET_ON = false;
    applyTimeMode(); showHud(NIGHT_ON ? "별빛 밤하늘 모드" : "주간 모드");
  }
  // 골드 엠블럼(hillstate): 물 밑에 가라앉은 로고 + 대각 스캔 반사. E 키.
  function toggleEmblem() {
    EMBLEM_ON = !EMBLEM_ON;
    showHud(EMBLEM_ON ? "엠블럼 ON" : "엠블럼 OFF");
  }

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
  // 물소리 볼륨 슬라이더(0~100) + [ / ] 키
  const splashVolSlider = document.getElementById("splashVolSlider");
  if (splashVolSlider) {
    _splashVol = (+splashVolSlider.value) / 100;
    if (_splashGain) _splashGain.gain.value = _splashVol;
    splashVolSlider.addEventListener("input", function () { setSplashVol((+this.value) / 100); });
  }
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
  // ── 원격 제어(폰↔릴레이) 적용부 ── 폰이 보낸 명령을 실제 설정에 반영.
  //   {k:"KeyC"} = 해당 단축키 그대로 실행(모든 토글·스텝 재사용)
  //   {set:"fish",v:20} 등 = 값 직접 지정.  __remoteState() = 현재 상태 스냅샷(폰 표시용).
  window.__remoteApply = function (m) {
    try {
      if (!m) return;
      if (m.k) { window.dispatchEvent(new KeyboardEvent("keydown", { code: m.k, bubbles: true })); return; }
      var v = +m.v;
      switch (m.set) {
        case "fish": FISH_COUNT = clamp(Math.round(v), 0, 24); spawnFishes(); showHud("FISH  " + FISH_COUNT); break;
        case "sens": if (sensSlider) { sensSlider.value = clamp(Math.round(v), 0, 100); applySens(+sensSlider.value); showHud("센싱 민감도  " + sensSlider.value); } break;
        case "glitter": GLITTER_ON = true; GLITTER_AMT = clamp(v, 0, 100) / 100; if (glitterSlider) glitterSlider.value = Math.round(v); applyGlitter(); refreshGlitterUI(); showHud("윤슬 강도  " + Math.round(v)); break;
        case "bright": BG_BRIGHT = clamp(v / 100, 0.1, 2); gl.useProgram(progBg); gl.uniform1f(locBg.uBgBright, BG_BRIGHT); showHud("배경 밝기  " + Math.round(BG_BRIGHT * 100) + "%"); break;
        case "slide": SLIDE_HOLD_MS = clamp(Math.round(v), 0, 60) * 1000; holdAcc = 0; showHud(SLIDE_HOLD_MS > 0 ? ("배경 전환 간격  " + (SLIDE_HOLD_MS / 1000) + "초") : "배경 슬라이드 정지 (0초)"); break;
        case "gather": GATHER_RESP = clamp(v / 100, 0.3, 2.5); showHud("몰려드는 속도  " + Math.round(GATHER_RESP * 100) + "%"); break;
      }
    } catch (e) {}
  };
  window.__remoteState = function () {
    return {
      fish: FISH_COUNT,
      sens: sensSlider ? +sensSlider.value : null,
      glitterOn: GLITTER_ON, glitter: Math.round(GLITTER_AMT * 100),
      bright: Math.round(BG_BRIGHT * 100),
      slide: SLIDE_HOLD_MS / 1000,
      gather: Math.round(GATHER_RESP * 100), gatherOn: GATHER_ON,
      group: activeGroup, cam: camOn, xray: xrayOn,
    };
  };

  // ── 원격 릴레이 연결(전시장 exe 전용) ── URL 에 rkey+room 있을 때만 접속(공개 웹은 미접속).
  //   폰이 'cmd' 발행 → 여기서 __remoteApply, 상태는 'state' 로 폰에 회신. 오프라인이면 조용히 무시.
  (function () {
    try {
      var rp = new URLSearchParams(location.search);
      var rkey = rp.get("rkey"), room = rp.get("room");
      if (!rkey || !room) return;
      var sc = document.createElement("script");
      sc.src = "https://cdn.ably.com/lib/ably.min-1.js";
      sc.onload = function () {
        try {
          var ably = new Ably.Realtime({ key: rkey, clientId: "kiosk" });
          var ch = ably.channels.get("koi-remote:" + room);
          function pubState() { try { ch.publish("state", window.__remoteState()); } catch (e) {} }
          ch.subscribe("cmd", function (m) { window.__remoteApply(m.data); setTimeout(pubState, 60); });
          ably.connection.on("connected", function () { pubState(); showHud("원격 연결됨"); });
          setInterval(pubState, 3000);
        } catch (e) {}
      };
      sc.onerror = function () {};
      document.head.appendChild(sc);
    } catch (e) {}
  })();

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
      case "KeyN": if (e.repeat) return; e.preventDefault(); toggleSunset(); break;
      case "KeyU": if (e.repeat) return; e.preventDefault(); toggleNight(); break;
      case "KeyE": if (e.repeat) return; e.preventDefault(); toggleEmblem(); break;
      case "KeyI": if (e.repeat) return; e.preventDefault(); toggleHintIcon(); break;
      case "KeyK": if (e.repeat) return; e.preventDefault(); toggleVkbd(); break;
      case "KeyH": if (e.repeat) return; e.preventDefault(); toggleHelp(); break;      // 단축키 모음 보기
      case "KeyO": if (e.repeat) return; e.preventDefault(); cycleProj(); break;      // 프로젝터 수 1→2→3
      case "KeyG": if (e.repeat) return; e.preventDefault(); toggleAlignGrid(); break; // 정렬 그리드
      case "KeyJ": if (e.repeat) return; e.preventDefault(); toggleGather(); break;    // 흩어지기 ↔ 몰려들기 토글
      case "KeyQ": e.preventDefault(); setGatherResp(+1); break;   // 몰려드는 속도 +
      case "KeyZ": e.preventDefault(); setGatherResp(-1); break;   // 몰려드는 속도 -
      case "KeyR": if (e.repeat) return; e.preventDefault(); resetGatherResp(); break; // 몰려드는 속도 기본값
      case "Semicolon": e.preventDefault(); setOverlap(-0.01); break;                  // 겹침 - (;)
      case "Quote": e.preventDefault(); setOverlap(+0.01); break;                      // 겹침 + (')
      case "Minus": e.preventDefault(); setCurveGamma(-0.1); break;                    // 블렌드 커브 γ - (61 동일)
      case "Equal": e.preventDefault(); setCurveGamma(+0.1); break;                    // 블렌드 커브 γ + (61 동일)
      case "Comma": e.preventDefault(); setDispGamma(-0.1); break;                     // 디스플레이 γ - (61 동일)
      case "Period": e.preventDefault(); setDispGamma(+0.1); break;                    // 디스플레이 γ + (61 동일)
      case "BracketRight": e.preventDefault(); setSplashVol(_splashVol + 0.1); break;   // 물소리 크게 ]
      case "BracketLeft": e.preventDefault(); setSplashVol(_splashVol - 0.1); break;    // 물소리 작게 [
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
  let hintIconHidden = true;   // 기본 숨김(index.html #hint 에 icon-off 클래스)
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
