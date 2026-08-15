/* 39_game_billiards — 캐롬 당구 물리 엔진 (DOM 비의존, 워커에서도 그대로 쓴다)
 *
 * 좌표계: x = 긴 변, y = 짧은 변, z = 위. 오른손 좌표계(화면은 y를 뒤집어 그린다).
 * 단위: m, kg, s, rad.
 *
 * 모델 요약
 *  - 공은 미끄러짐(sliding) 구간과 구름(rolling) 구간을 구분해 적분한다.
 *    접촉점 속도 u = v - R(ω × ẑ) 가 0이 되는 순간이 구름 시작이며, 그 시각을 해석적으로 구해
 *    한 스텝 안에서 정확히 갈아탄다(고정 감쇠를 쓰면 굴러가는 공이 미세하게 떨린다).
 *  - 세로축 스핀(ωz)은 별도 스핀 마찰로 감쇠한다.
 *  - 공-공 충돌: 중심선 반발 + 접선 마찰 임펄스(스로/스핀 전달). 접선 정지 임펄스는 M|vt|/7.
 *  - 쿠션 충돌: 접점이 중심보다 0.27R 위(쿠션 코 높이 = 공 지름의 63.5%)라는 사실을 넣어
 *    옆회전이 반발각을 바꾸고, 반발이 다시 회전을 바꾸도록 했다.
 */
(function (g) {
  'use strict';

  var P = {};

  /* ---------- 상수 (국제 캐롬 규격) ---------- */
  P.R = 0.0615 / 2;      // 공 반지름 61.5mm
  P.M = 0.21;            // 공 질량 210g
  P.G = 9.81;
  P.MU_SLIDE = 0.20;     // 천 위 미끄럼 마찰
  P.MU_ROLL = 0.010;     // 구름 저항
  P.MU_SPIN = 0.044;     // 제자리 회전 마찰
  P.E_BALL = 0.95;       // 공-공 반발계수
  P.MU_BALL = 0.06;      // 공-공 마찰
  P.MU_CUSH = 0.16;      // 쿠션 마찰
  P.CUSH_H = 0.27;       // 쿠션 접점 높이 (중심 기준, R 단위)
  P.CUSH_E_SCALE = 1;    // 쿠션 반발 보정 배율 (설정 패널)
  P.STOP_V = 0.0045;     // 정지 판정 속도
  P.STOP_W = 0.45;       // 정지 판정 각속도

  // 국제식 대대 유효 면적 2.84 x 1.42 m
  P.TABLE_W = 2.84;
  P.TABLE_H = 1.42;

  var I_INV = 1 / (0.4 * P.M * P.R * P.R);   // 1/I
  var RAILS = ['left', 'right', 'bottom', 'top'];

  /* ---------- 상태 ---------- */
  P.makeBall = function (id, x, y) {
    return {
      id: id, x: x, y: y,
      vx: 0, vy: 0,
      wx: 0, wy: 0, wz: 0,
      live: true, moving: false,
      // 렌더용 자세 행렬 (열 우선 아님, 행 우선 3x3)
      rot: [1, 0, 0, 0, 1, 0, 0, 0, 1]
    };
  };

  P.makeState = function (W, H) {
    return {
      W: W || P.TABLE_W,
      H: H || P.TABLE_H,
      balls: [],
      t: 0,
      visual: false          // true면 렌더용 자세 행렬을 적분한다
    };
  };

  P.cloneState = function (st) {
    var s = { W: st.W, H: st.H, t: 0, visual: false, balls: [] };
    for (var i = 0; i < st.balls.length; i++) {
      var b = st.balls[i];
      s.balls.push({
        id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy,
        wx: b.wx, wy: b.wy, wz: b.wz, live: b.live, moving: b.moving,
        rot: null
      });
    }
    return s;
  };

  P.isMoving = function (st) {
    for (var i = 0; i < st.balls.length; i++) {
      var b = st.balls[i];
      if (!b.live) continue;
      if (b.vx * b.vx + b.vy * b.vy > 1e-9) return true;
      if (Math.abs(b.wz) > 1e-3) return true;
      if (b.wx * b.wx + b.wy * b.wy > 1e-6) return true;
    }
    return false;
  };

  /* ---------- 큐 타격 ----------
   * dir   : 진행 방향 (rad)
   * speed : 초기 속도 (m/s)
   * tipX  : 큐 팁의 좌우 오프셋. 슈터 시점 기준 오른쪽이 +, R 대비 비율(-0.5~0.5)
   * tipY  : 위(탑스핀)가 +, R 대비 비율
   */
  P.strike = function (b, dir, speed, tipX, tipY) {
    var lim = 0.5;                                   // 미스큐 한계 (반지름의 절반)
    var m = Math.hypot(tipX, tipY);
    if (m > lim) { tipX *= lim / m; tipY *= lim / m; }

    var dx = Math.cos(dir), dy = Math.sin(dir);
    // ŝ = ẑ × d̂ (진행 방향 기준 왼쪽)
    var sx = -dy, sy = dx;

    b.vx = speed * dx;
    b.vy = speed * dy;

    // Δω = (5|Δv| / 2R) * ( tipY * ŝ  +  tipX * ẑ )
    var k = 5 * speed / (2 * P.R);
    b.wx = k * tipY * sx;
    b.wy = k * tipY * sy;
    b.wz = k * tipX;
    b.moving = true;
  };

  /* ---------- 적분 ---------- */

  // 한 공의 자유 운동 (마찰만)
  function integrateBall(b, h) {
    var R = P.R;
    var vx = b.vx, vy = b.vy;
    var ux = vx - R * b.wy;          // 접촉점 속도
    var uy = vy + R * b.wx;
    var us = Math.hypot(ux, uy);

    var rest = h;
    if (us > 1e-6) {
      var a = P.MU_SLIDE * P.G;
      var tRoll = us / (3.5 * a);     // |u|는 3.5a 로 감소한다
      var tau = Math.min(h, tRoll);
      var uhx = ux / us, uhy = uy / us;

      // 위치는 등가속도 적분
      b.x += vx * tau - 0.5 * a * uhx * tau * tau;
      b.y += vy * tau - 0.5 * a * uhy * tau * tau;
      b.vx = vx - a * uhx * tau;
      b.vy = vy - a * uhy * tau;

      var kw = (5 * a) / (2 * R) * tau;   // dω/dt = (5a/2R)(ẑ × û)
      b.wx += kw * (-uhy);
      b.wy += kw * (uhx);

      rest = h - tau;
      if (rest > 0) {                      // 이 스텝 안에서 구름으로 전환
        b.wx = -b.vy / R;
        b.wy = b.vx / R;
      }
    }

    if (rest > 0) {                        // 구름 구간
      var sp = Math.hypot(b.vx, b.vy);
      if (sp > 1e-9) {
        var ar = P.MU_ROLL * P.G;
        var dv = ar * rest;
        if (dv >= sp) {
          b.x += b.vx * (sp / ar) * 0.5;
          b.y += b.vy * (sp / ar) * 0.5;
          b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0;
        } else {
          var nx = b.vx / sp, ny = b.vy / sp;
          b.x += b.vx * rest - 0.5 * ar * nx * rest * rest;
          b.y += b.vy * rest - 0.5 * ar * ny * rest * rest;
          b.vx -= ar * nx * rest;
          b.vy -= ar * ny * rest;
          b.wx = -b.vy / R;
          b.wy = b.vx / R;
        }
      }
    }

    // 세로축 스핀 감쇠
    if (b.wz !== 0) {
      var dwz = (5 * P.MU_SPIN * P.G) / (2 * R) * h;
      if (Math.abs(b.wz) <= dwz) b.wz = 0;
      else b.wz -= Math.sign(b.wz) * dwz;
    }

    // 정지 판정
    var v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 < P.STOP_V * P.STOP_V && Math.abs(b.wz) < P.STOP_W) {
      b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
      b.moving = false;
    } else {
      b.moving = true;
    }
  }

  /* ---------- 공-공 충돌 ---------- */
  function ballBall(a, b, ev, t) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var d2 = dx * dx + dy * dy;
    var D = 2 * P.R;
    if (d2 >= D * D || d2 < 1e-12) return;

    var d = Math.sqrt(d2);
    var nx = dx / d, ny = dy / d;

    // 겹침 제거
    var pen = D - d;
    a.x -= nx * pen * 0.5; a.y -= ny * pen * 0.5;
    b.x += nx * pen * 0.5; b.y += ny * pen * 0.5;

    var vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (vn <= 0) return;                       // 멀어지는 중

    var R = P.R, M = P.M;

    // 접촉점 표면 속도 (3D)
    var s1x = a.vx + (-a.wz * R * ny);
    var s1y = a.vy + (a.wz * R * nx);
    var s1z = R * (a.wx * ny - a.wy * nx);
    var s2x = b.vx + (b.wz * R * ny);
    var s2y = b.vy + (-b.wz * R * nx);
    var s2z = -R * (b.wx * ny - b.wy * nx);

    var rx = s1x - s2x, ry = s1y - s2y, rz = s1z - s2z;
    var rn = rx * nx + ry * ny;
    var tx = rx - rn * nx, ty = ry - rn * ny, tz = rz;
    var tm = Math.sqrt(tx * tx + ty * ty + tz * tz);

    var Jn = 0.5 * M * (1 + P.E_BALL) * vn;
    a.vx -= (Jn / M) * nx; a.vy -= (Jn / M) * ny;
    b.vx += (Jn / M) * nx; b.vy += (Jn / M) * ny;

    if (tm > 1e-7) {
      var Jt = Math.min(P.MU_BALL * Jn, M * tm / 7);
      var ex = tx / tm, ey = ty / tm, ez = tz / tm;
      // a 에는 -Jt ê, b 에는 +Jt ê
      var fx = -Jt * ex, fy = -Jt * ey, fz = -Jt * ez;
      a.vx += fx / M; a.vy += fy / M;
      // c1 = R n  →  c1 × F
      a.wx += (R * ny * fz - 0) * I_INV;
      a.wy += (0 - R * nx * fz) * I_INV;
      a.wz += (R * nx * fy - R * ny * fx) * I_INV;

      b.vx -= fx / M; b.vy -= fy / M;
      // c2 = -R n,  F' = -F
      b.wx += (-R * ny * (-fz) - 0) * I_INV;
      b.wy += (0 - (-R * nx) * (-fz)) * I_INV;
      b.wz += ((-R * nx) * (-fy) - (-R * ny) * (-fx)) * I_INV;
    }

    a.moving = true; b.moving = true;
    if (ev) ev.push({ type: 'ball', a: a.id, b: b.id, imp: Jn, t: t, x: a.x + nx * R, y: a.y + ny * R });
  }

  /* ---------- 쿠션 충돌 ---------- */
  function cushion(b, st, ev, t) {
    var R = P.R;
    var hit = null, nx = 0, ny = 0;

    if (b.x < R) { hit = 'left'; nx = 1; ny = 0; b.x = R; }
    else if (b.x > st.W - R) { hit = 'right'; nx = -1; ny = 0; b.x = st.W - R; }
    if (hit) applyCushion(b, nx, ny, hit, ev, t);

    hit = null;
    if (b.y < R) { hit = 'bottom'; nx = 0; ny = 1; b.y = R; }
    else if (b.y > st.H - R) { hit = 'top'; nx = 0; ny = -1; b.y = st.H - R; }
    if (hit) applyCushion(b, nx, ny, hit, ev, t);
  }

  function applyCushion(b, nx, ny, rail, ev, t) {
    var vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return;                        // 이미 빠져나가는 중

    var R = P.R, M = P.M;
    var h = P.CUSH_H;                            // 접점 높이 (R 단위)
    var cz = h * R;
    var cr = R * Math.sqrt(1 - h * h);           // 수평 성분 길이
    var cx = -nx * cr, cy = -ny * cr;

    var sp = -vn;
    var e = (0.88 - 0.06 * sp) * P.CUSH_E_SCALE;
    if (e < 0.4) e = 0.4; else if (e > 0.95) e = 0.95;

    var Jn = M * (1 + e) * sp;

    // 접촉점 표면 속도 u = v + ω × c
    var ux = b.vx + (b.wy * cz - b.wz * cy);
    var uy = b.vy + (b.wz * cx - b.wx * cz);
    var uz = (b.wx * cy - b.wy * cx);

    var un = ux * nx + uy * ny;
    var tx = ux - un * nx, ty = uy - un * ny, tz = uz;
    var tm = Math.sqrt(tx * tx + ty * ty + tz * tz);

    var Jx = Jn * nx, Jy = Jn * ny, Jz = 0;
    if (tm > 1e-7) {
      var Jt = Math.min(P.MU_CUSH * Jn, (2 * M * tm) / 7);
      Jx -= Jt * tx / tm;
      Jy -= Jt * ty / tm;
      Jz -= Jt * tz / tm;
    }

    b.vx += Jx / M;
    b.vy += Jy / M;
    // ω += (c × J)/I
    b.wx += (cy * Jz - cz * Jy) * I_INV;
    b.wy += (cz * Jx - cx * Jz) * I_INV;
    b.wz += (cx * Jy - cy * Jx) * I_INV;

    b.moving = true;
    if (ev) ev.push({ type: 'cushion', ball: b.id, rail: rail, imp: Jn, t: t, x: b.x, y: b.y });
  }

  /* ---------- 자세(회전) 적분 : 렌더 전용 ---------- */
  function spinMatrix(b, dt) {
    var w = Math.sqrt(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
    if (w < 1e-6 || !b.rot) return;
    var ang = w * dt;
    var ax = b.wx / w, ay = b.wy / w, az = b.wz / w;
    var c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
    var r = [
      c + ax * ax * C, ax * ay * C - az * s, ax * az * C + ay * s,
      ay * ax * C + az * s, c + ay * ay * C, ay * az * C - ax * s,
      az * ax * C - ay * s, az * ay * C + ax * s, c + az * az * C
    ];
    var m = b.rot, o = new Array(9);
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        o[i * 3 + j] = r[i * 3] * m[j] + r[i * 3 + 1] * m[3 + j] + r[i * 3 + 2] * m[6 + j];
      }
    }
    b.rot = o;
  }

  /* ---------- 한 프레임 진행 ---------- */
  P.advance = function (st, dt, ev) {
    var balls = st.balls, i, j;

    var vmax = 0;
    for (i = 0; i < balls.length; i++) {
      if (!balls[i].live) continue;
      var s = Math.hypot(balls[i].vx, balls[i].vy);
      if (s > vmax) vmax = s;
    }
    if (vmax === 0 && !P.isMoving(st)) return false;

    var n = 1;
    if (vmax > 0) n = Math.ceil(vmax * dt / (0.16 * P.R));
    if (n < 1) n = 1;
    if (n > 400) n = 400;
    var h = dt / n;

    for (var k = 0; k < n; k++) {
      for (i = 0; i < balls.length; i++) {
        if (balls[i].live) integrateBall(balls[i], h);
      }
      for (i = 0; i < balls.length; i++) {
        if (!balls[i].live) continue;
        cushion(balls[i], st, ev, st.t);
        for (j = i + 1; j < balls.length; j++) {
          if (balls[j].live) ballBall(balls[i], balls[j], ev, st.t);
        }
      }
      st.t += h;
    }

    if (st.visual) {
      for (i = 0; i < balls.length; i++) if (balls[i].live) spinMatrix(balls[i], dt);
    }
    return P.isMoving(st);
  };

  /* ---------- 규칙 판정 ----------
   * 캐롬(3구): 내 공이 두 개의 목적구를 모두 맞히되,
   *            두 번째 목적구에 닿기 전 쿠션을 required 회 이상 거쳐야 한다.
   * 같은 쿠션에 연속으로 여러 번 닿는 것은 1회로 센다(코너의 두 쿠션은 각각 인정).
   */
  P.judge = function (events, cueId, required) {
    var cush = 0, lastRail = null, lastRailT = -1;
    var first = null, second = null, firstAt = -1, secondAt = -1;
    var cushBeforeSecond = 0;
    var hits = [];

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'cushion') {
        if (e.ball !== cueId) continue;
        if (e.rail === lastRail && e.t - lastRailT < 0.03) continue;   // 같은 쿠션 재접촉
        lastRail = e.rail; lastRailT = e.t;
        cush++;
      } else if (e.type === 'ball') {
        var other = (e.a === cueId) ? e.b : (e.b === cueId ? e.a : null);
        if (other === null) continue;
        hits.push({ id: other, t: e.t, cush: cush });
        if (first === null) { first = other; firstAt = e.t; }
        else if (second === null && other !== first) {
          second = other; secondAt = e.t; cushBeforeSecond = cush;
        }
      }
    }

    var ok = (first !== null && second !== null && cushBeforeSecond >= required);
    return {
      score: ok,
      first: first, second: second,
      cushions: cush,
      cushionsBeforeSecond: second === null ? cush : cushBeforeSecond,
      firstAt: firstAt, secondAt: secondAt,
      hits: hits
    };
  };

  /* ---------- 헤드리스 시뮬레이션 (AI·예측용) ---------- */
  P.simulate = function (st, opts) {
    opts = opts || {};
    var maxT = opts.maxT || 14;
    var dt = opts.dt || (1 / 240);
    var ev = [];
    st.t = 0;
    var guard = Math.ceil(maxT / dt) + 10;
    while (guard-- > 0 && st.t < maxT) {
      if (!P.advance(st, dt, ev)) break;
      if (opts.stopWhen && opts.stopWhen(st, ev)) break;
    }
    return ev;
  };

  P.RAILS = RAILS;
  g.Phys = P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof self !== 'undefined' ? self : this);
