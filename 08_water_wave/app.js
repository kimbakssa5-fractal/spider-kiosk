"use strict";

/* =========================================================================
   Surface Waves — cmiscm "fff / Surface Waves" (2012.12) 재현
   화면을 위아래로 드래그하면 원형 창(porthole) 안의 수평선이
   물결(스프링 기반 워터라인 시뮬레이션)로 출렁인다.
   ========================================================================= */

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");

let W = 0, H = 0, DPR = 1;
let cx = 0, cy = 0, radius = 0;   // 원형 창
let surfaceY = 0;                  // 수면 기준선(절대 y)
let bandGap = 0;                   // 레이어 간 수직 간격

/* ---- 워터라인 스프링 시뮬레이션 ---- */
const COL_SPACING = 6;            // 컬럼 간 픽셀 간격(작을수록 부드럽다)
let N = 0;                         // 컬럼 수
let height = [];                   // 변위(아래쪽이 +)
let speed = [];                    // 속도
const K = 0.018;                  // 스프링 상수(복원력)
const DAMP = 0.972;               // 감쇠
const SPREAD = 0.18;              // 이웃으로의 전파율
const MAX_DISP = 1.0;            // 변위 한계(반지름 대비)

/* ---- 색상 모드 ---- */
// 앞(수면, m=0)이 가장 밝고, 뒤로 갈수록 깊고 어둡다. 반투명으로 겹쳐 수채화처럼 보인다.
const PALETTES = {
  blue: [
    "rgba(150, 222, 245, 0.85)",
    "rgba(60, 190, 232, 0.85)",
    "rgba(0, 160, 215, 0.85)",
    "rgba(0, 126, 190, 0.9)",
    "rgba(0, 92, 156, 0.92)",
  ],
  rainbow: [
    "rgba(255, 224, 70, 0.78)",
    "rgba(247, 152, 0, 0.78)",
    "rgba(240, 70, 70, 0.78)",
    "rgba(80, 200, 120, 0.8)",
    "rgba(0, 150, 210, 0.82)",
  ],
};
let mode = "blue";
const LAYERS = 5;

/* 레이어별 정적 파라미터(잔물결을 위한 잔잔한 사인파) */
const layerCfg = [];
for (let m = 0; m < LAYERS; m++) {
  layerCfg.push({
    amp: 1 - m * 0.05,                 // 앞 레이어가 드래그에 가장 크게 반응
    a1: 7 - m * 0.6,                   // 잔물결 진폭1
    a2: 4 + m * 0.4,                   // 잔물결 진폭2
    f1: 0.9 + m * 0.15,                // 공간 주파수1
    f2: 1.7 + m * 0.1,                 // 공간 주파수2
    s1: 0.6 + m * 0.05,                // 시간 속도1
    s2: 0.9 - m * 0.04,                // 시간 속도2
    phase: m * 1.3,
  });
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  cx = W / 2;
  cy = H / 2;
  radius = Math.min(W, H) * 0.42;
  surfaceY = cy;                       // 수면은 원 중앙 근처
  bandGap = radius * 0.12;

  const newN = Math.max(8, Math.ceil(W / COL_SPACING) + 1);
  if (newN !== N) {
    N = newN;
    height = new Array(N).fill(0);
    speed = new Array(N).fill(0);
  }
}
window.addEventListener("resize", resize);
resize();

/* index ↔ 화면 x 변환 */
const colX = (i) => (i / (N - 1)) * W;
const xToCol = (x) => Math.round((x / W) * (N - 1));

/* ---- 시뮬레이션 한 스텝 ---- */
function stepSim() {
  const limit = radius * MAX_DISP;
  for (let i = 0; i < N; i++) {
    let v = speed[i];
    v += -K * height[i];     // 복원력
    v *= DAMP;               // 감쇠
    speed[i] = v;
    height[i] += v;
    if (height[i] > limit) { height[i] = limit; speed[i] = 0; }
    else if (height[i] < -limit) { height[i] = -limit; speed[i] = 0; }
  }
  // 이웃으로 전파(2-패스)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      if (i > 0) {
        const d = SPREAD * (height[i] - height[i - 1]);
        speed[i - 1] += d;
      }
      if (i < N - 1) {
        const d = SPREAD * (height[i] - height[i + 1]);
        speed[i + 1] += d;
      }
    }
  }
}

/* 특정 x 위치에 물결 발생(드래그 dy에 비례) */
function splash(x, dy) {
  const i = xToCol(x);
  if (i < 0 || i >= N) return;
  let v = dy * 0.9;
  if (v > 220) v = 220;
  if (v < -220) v = -220;
  speed[i] += v;
  // 양옆으로 넓고 부드럽게 번지게(가우시안형 falloff) → 발생부터 완만한 파형
  const R = 7;
  for (let d = 1; d <= R; d++) {
    const f = Math.exp(-(d * d) / (2 * 3.2 * 3.2)) * 0.85;
    if (i - d >= 0) speed[i - d] += v * f;
    if (i + d < N) speed[i + d] += v * f;
  }
}

/* 변위 배열을 가볍게 평활화(이항 블러 1패스) → 날카로운 꺾임 완화 */
function smoothHeights() {
  const out = new Array(N);
  out[0] = height[0];
  out[N - 1] = height[N - 1];
  for (let i = 1; i < N - 1; i++) {
    out[i] = (height[i - 1] + 2 * height[i] + height[i + 1]) * 0.25;
  }
  return out;
}

/* 점 배열의 윗변을 quadratic 중점 보간으로 부드럽게 이어 붙인다.
   isStroke=true면 stroke용으로 moveTo부터 시작, 아니면 채움 경로에 이어 그린다. */
function strokeSmoothTop(ys, isStroke) {
  if (isStroke) ctx.moveTo(colX(0), ys[0]);
  else {
    ctx.lineTo(-2, ys[0]);
    ctx.lineTo(colX(0), ys[0]);
  }
  let i;
  for (i = 1; i < N - 2; i++) {
    const xc = (colX(i) + colX(i + 1)) / 2;
    const yc = (ys[i] + ys[i + 1]) / 2;
    ctx.quadraticCurveTo(colX(i), ys[i], xc, yc);
  }
  // 마지막 두 점
  ctx.quadraticCurveTo(colX(N - 2), ys[N - 2], colX(N - 1), ys[N - 1]);
  if (!isStroke) ctx.lineTo(W + 2, ys[N - 1]);
}

/* ---- 렌더 ---- */
let t = 0;
function render() {
  t += 0.016;

  // 배경
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#2399b5";
  ctx.fillRect(0, 0, W, H);

  // 원형 클립 + 하늘(흰색)
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  const pal = PALETTES[mode];
  const bottom = cy + radius + 2;

  // 변위 배열을 렌더 직전에 가볍게 평활화 → 날카로운 꺾임 완화
  const hs = smoothHeights();

  // 앞(밝은 수면) → 뒤(깊고 어두움) 순서로 그린다.
  // 각 레이어는 자신의 윗변(물결치는 선)부터 원 바닥까지 채운다.
  for (let m = 0; m < LAYERS; m++) {
    const cfg = layerCfg[m];
    const ys = new Array(N);
    for (let i = 0; i < N; i++) {
      const ripple =
        cfg.a1 * Math.sin(i * 0.12 * cfg.f1 + t * cfg.s1 + cfg.phase) +
        cfg.a2 * Math.sin(i * 0.07 * cfg.f2 - t * cfg.s2 + cfg.phase * 1.7);
      ys[i] = surfaceY + bandGap * m + hs[i] * cfg.amp + ripple;
    }
    ctx.beginPath();
    ctx.moveTo(-2, bottom);
    strokeSmoothTop(ys);          // 윗변을 부드러운 곡선으로
    ctx.lineTo(W + 2, bottom);
    ctx.closePath();
    ctx.fillStyle = pal[m];
    ctx.fill();
  }

  // 수면 거품(밝은 캡) — 맨 앞 레이어 윗선에 얇은 하이라이트
  {
    const cfg = layerCfg[0];
    const ys = new Array(N);
    for (let i = 0; i < N; i++) {
      const ripple =
        cfg.a1 * Math.sin(i * 0.12 * cfg.f1 + t * cfg.s1) +
        cfg.a2 * Math.sin(i * 0.07 * cfg.f2 - t * cfg.s2);
      ys[i] = surfaceY + hs[i] * cfg.amp + ripple;
    }
    ctx.beginPath();
    strokeSmoothTop(ys, true);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  ctx.restore();
}

function loop() {
  stepSim();
  render();
  requestAnimationFrame(loop);
}
loop();

/* =========================================================================
   포인터 입력 (마우스 + 터치, 멀티터치 지원)
   ========================================================================= */
const pointers = new Map();   // id -> {x, y}

function onDown(e) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  hideHint();
}
function onMove(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dy = e.clientY - p.y;
  if (dy !== 0) splash(e.clientX, dy);
  p.x = e.clientX;
  p.y = e.clientY;
}
function onUp(e) {
  pointers.delete(e.pointerId);
}

canvas.addEventListener("pointerdown", onDown);
window.addEventListener("pointermove", onMove);
window.addEventListener("pointerup", onUp);
window.addEventListener("pointercancel", onUp);

/* 안내 문구 숨기기 */
const hintEl = document.getElementById("hint");
let hintHidden = false;
function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl.classList.add("hidden");
}
setTimeout(hideHint, 5000);

/* =========================================================================
   UI — 색상 모드 / 전체화면
   ========================================================================= */
const btnBlue = document.getElementById("modeBlue");
const btnRainbow = document.getElementById("modeRainbow");

function setMode(next) {
  mode = next;
  btnBlue.classList.toggle("is-active", next === "blue");
  btnRainbow.classList.toggle("is-active", next === "rainbow");
}
btnBlue.addEventListener("click", () => setMode("blue"));
btnRainbow.addEventListener("click", () => setMode("rainbow"));

document.getElementById("fsBtn").addEventListener("click", () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
});
