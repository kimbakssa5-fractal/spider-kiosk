/* ==========================================================================
   89_camera_delay — 딜레이 카메라 (당구 자세 확인용 지연 리플레이)

   원리
     · MSE 모드(기본): MediaRecorder 가 0.5초 단위로 webm 조각을 뱉고,
       MediaSource SourceBuffer 에 이어붙인다. 재생 헤드를 buffered 끝에서
       delay 초 뒤에 두면 "N초 전 화면"이 된다. 압축이라 120초도 수십 MB 수준.
     · 프레임 모드(폴백): MSE/webm 미지원(구형 iOS 등)이면 JPEG 링버퍼.
       10fps × 축소 해상도라 메모리 안전, 대신 화질/부드러움 손해.

   폰 사용 전제
     · getUserMedia 는 HTTPS(또는 localhost)에서만 열린다 → 실사용은 배포 URL로.
     · 화면 꺼짐 방지: Wake Lock. 탭 복귀 시 재획득.
     · 카메라 점유/일시 오류: 8초 간격 자동 재시도(권한 거부만 중단).
   ========================================================================== */
'use strict';

/* ================= 상태 ================= */
var S = {
  delay: 10,               // 초 (1~120)
  facing: 'user',          // 기본 셀피(전면) — 당구대 앞 삼각대 거치 기준 (2026-08-27 지시)
  mirror: true,            // 기본 ON — 거울처럼 보여야 오른손 자세가 오른손으로 보인다 (2026-08-27 지시)
  fit: 'contain',
  orient: '90',            // auto | 0 | 90 | 180 | 270 — 기본 가로(90°) (2026-08-27 지시)
  autoRec: true,           // 상시 자동 녹화 — 폰 용량 아끼려면 버튼으로 끌 수 있다
  frozen: false,
  mode: null,              // 'mse' | 'frames'
  running: false
};
try{
  var saved = JSON.parse(localStorage.getItem('cd_settings') || '{}');
  if(saved.delay >= 1 && saved.delay <= 120) S.delay = saved.delay;
  /* v3 미만 저장값의 facing/orient 는 무시 — "셀피 + 가로 90° 기본" 1회 마이그레이션 */
  if(saved.v >= 3 && saved.facing) S.facing = saved.facing;
  if(saved.v >= 3 && ['auto','0','90','180','270'].indexOf(saved.orient) >= 0) S.orient = saved.orient;
  /* v2 미만 저장값의 mirror 는 무시 — "미러 기본 ON" 1회 마이그레이션 */
  if(saved.v >= 2 && typeof saved.mirror === 'boolean') S.mirror = saved.mirror;
  if(saved.fit) S.fit = saved.fit;
  if(typeof saved.autoRec === 'boolean') S.autoRec = saved.autoRec;
}catch(e){}
function persist(){
  try{ localStorage.setItem('cd_settings', JSON.stringify({
    v:3, delay:S.delay, facing:S.facing, mirror:S.mirror, fit:S.fit,
    orient:S.orient, autoRec:S.autoRec })); }catch(e){}
}
function orientAngle(){ return (S.orient === 'auto') ? 0 : +S.orient; }

/* ================= DOM ================= */
var $ = function(id){ return document.getElementById(id); };
var elDelayed = $('delayed'), elCanvas = $('delayCanvas'), elLive = $('live');
var elFill = $('fill'), elFillBar = $('fillBar'), elFillNow = $('fillNow'), elFillMax = $('fillMax');
var elErr = $('err'), elErrTitle = $('errTitle'), elErrMsg = $('errMsg');
var elBadgeNum = $('delayBadgeNum'), elStatus = $('statusLine');
var ctx2d = elCanvas.getContext('2d');

/* ================= 미디어 엔진 ================= */
var stream = null;
var recorder = null;
var msrc = null, sbuf = null, sbQueue = [], sbPumping = false, msURL = null;
var tickTimer = null, capTimer = null, drawTimer = null;
var retryTimer = null;
var frames = [];            // 프레임 모드 링버퍼 [{t, blob}]
var lastDrawnT = 0, decoding = false;
var engineGen = 0;          // 재시작 세대 — 늦게 도착한 콜백 무시용

function pickMime(){
  if(!window.MediaSource || !window.MediaRecorder) return null;
  var cands = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  for(var i = 0; i < cands.length; i++){
    try{
      if(MediaRecorder.isTypeSupported(cands[i]) && MediaSource.isTypeSupported(cands[i]))
        return cands[i];
    }catch(e){}
  }
  return null;
}

function stopEngine(){
  engineGen++;
  S.running = false;
  clearInterval(tickTimer); clearInterval(capTimer); clearInterval(drawTimer);
  clearTimeout(retryTimer);
  try{ if(recorder && recorder.state !== 'inactive') recorder.stop(); }catch(e){}
  recorder = null;
  try{ if(stream) stream.getTracks().forEach(function(t){ t.stop(); }); }catch(e){}
  stream = null;
  try{ if(msrc && msrc.readyState === 'open') msrc.endOfStream(); }catch(e){}
  msrc = null; sbuf = null; sbQueue = []; sbPumping = false;
  if(msURL){ try{ URL.revokeObjectURL(msURL); }catch(e){} msURL = null; }
  elDelayed.removeAttribute('src'); try{ elDelayed.load(); }catch(e){}
  frames = []; lastDrawnT = 0; decoding = false;
}

function showErr(title, msg, canRetry){
  elErrTitle.textContent = title;
  elErrMsg.textContent = msg || '';
  elErr.classList.remove('hide');
  elFill.classList.add('hide');
  if(canRetry){
    clearTimeout(retryTimer);
    retryTimer = setTimeout(startEngine, 8000);   // 점유 해제 대기 무한 재시도
  }
}
function hideErr(){ elErr.classList.add('hide'); }

function startEngine(){
  if(rec) stopRec();          // 카메라 교체/재시작 중엔 녹화를 끊고 지금까지 분량을 저장
  stopEngine();
  var gen = engineGen;
  hideErr();
  elFill.classList.remove('hide');
  setFillUI(0);

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    if(location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'){
      showErr('HTTPS가 필요합니다', '카메라는 https 주소(배포 페이지)나 localhost에서만 열립니다.', false);
    }else{
      showErr('이 브라우저는 카메라를 지원하지 않습니다', '', false);
    }
    return;
  }

  var wantMs = navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: S.facing,
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: false
  });
  /* 웹캠 점유 시 getUserMedia 가 영원히 pending 인 케이스 대비 */
  var timeout = new Promise(function(_, rej){
    setTimeout(function(){ rej(new DOMException('timeout', 'TimeoutError')); }, 12000);
  });

  Promise.race([wantMs, timeout]).then(function(ms){
    if(gen !== engineGen){ ms.getTracks().forEach(function(t){ t.stop(); }); return; }
    stream = ms;
    elLive.srcObject = ms;
    var p = elLive.play(); if(p && p.catch) p.catch(function(){});

    var forceFrames = false;
    try{ forceFrames = new URLSearchParams(location.search).get('mode') === 'frames'; }catch(e){}
    var mime = forceFrames ? null : pickMime();
    if(mime) startMSE(mime, gen);
    else startFrames(gen);
    S.running = true;
  }).catch(function(err){
    if(gen !== engineGen) return;
    var name = (err && err.name) || '';
    if(name === 'NotAllowedError' || name === 'SecurityError'){
      showErr('카메라 권한이 거부되었습니다',
              '브라우저 설정에서 이 페이지의 카메라 권한을 허용해 주세요.', false);
    }else if(name === 'NotFoundError' || name === 'OverconstrainedError'){
      /* 요청한 방향 카메라가 없다 — 반대편으로 한 번 더 */
      if(!startEngine._flippedOnce){
        startEngine._flippedOnce = true;
        S.facing = (S.facing === 'user') ? 'environment' : 'user';
        startEngine();
        return;
      }
      showErr('카메라를 찾을 수 없습니다', '연결된 카메라가 없습니다.', true);
    }else{
      showErr('카메라를 열 수 없습니다',
              '다른 앱이 카메라를 사용 중일 수 있습니다. 8초 후 자동 재시도합니다. (' + name + ')', true);
    }
  });
}

/* ---------------- MSE 모드 ---------------- */
function startMSE(mime, gen){
  S.mode = 'mse';
  elCanvas.classList.add('hide');
  elDelayed.classList.remove('hide');

  msrc = new MediaSource();
  msURL = URL.createObjectURL(msrc);
  elDelayed.src = msURL;

  msrc.addEventListener('sourceopen', function(){
    if(gen !== engineGen) return;
    if(sbuf) return;
    try{
      sbuf = msrc.addSourceBuffer(mime);
    }catch(e){
      /* MSE가 말로만 지원 — 프레임 모드로 후퇴 */
      startFrames(gen);
      return;
    }
    sbuf.addEventListener('updateend', pump);
    sbuf.addEventListener('error', function(){
      if(gen !== engineGen) return;
      startEngine();   // 스트림 깨짐 — 엔진 통째로 재시작
    });

    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
    recorder.ondataavailable = function(e){
      if(gen !== engineGen || !e.data || !e.data.size) return;
      e.data.arrayBuffer().then(function(ab){
        if(gen !== engineGen) return;
        sbQueue.push(ab);
        pump();
      });
    };
    recorder.onerror = function(){ if(gen === engineGen) startEngine(); };
    recorder.start(500);   // 0.5초 조각

    tickTimer = setInterval(mseTick, 300);
  });
}

function pump(){
  if(!sbuf || sbuf.updating || !sbQueue.length) return;
  if(msrc.readyState !== 'open') return;
  var ab = sbQueue.shift();
  try{
    sbuf.appendBuffer(ab);
  }catch(e){
    if(e.name === 'QuotaExceededError'){
      /* 저장 공간 초과 — 오래된 구간을 잘라내고 되돌려 넣는다 */
      sbQueue.unshift(ab);
      evict(true);
    }
  }
}

function buffered(){
  try{
    var b = elDelayed.buffered;
    if(b.length) return { start: b.start(0), end: b.end(b.length - 1) };
  }catch(e){}
  return null;
}

function evict(force){
  if(!sbuf || sbuf.updating) return;
  var b = buffered();
  if(!b) return;
  var keep = S.delay + 15;                       // 지연 + 여유
  var cut = b.end - keep;
  if(force) cut = Math.max(cut, b.start + 10);   // 공간 초과면 최소 10초라도 잘라낸다
  if(cut > b.start + 5){
    try{ sbuf.remove(0, cut); }catch(e){}
  }
}

function mseTick(){
  var b = buffered();
  if(!b){ setFillUI(0); return; }
  var have = b.end - b.start;
  var target = b.end - S.delay;

  if(target < b.start + 0.1){
    /* 아직 delay 초만큼 안 쌓였다 */
    elFill.classList.remove('hide');
    setFillUI(have);
    if(!elDelayed.paused) elDelayed.pause();
    return;
  }
  elFill.classList.add('hide');

  if(S.frozen){
    if(!elDelayed.paused) elDelayed.pause();
  }else{
    if(elDelayed.paused){
      elDelayed.currentTime = target;
      var p = elDelayed.play(); if(p && p.catch) p.catch(function(){});
    }else{
      var drift = target - elDelayed.currentTime;
      if(Math.abs(drift) > 1.0) elDelayed.currentTime = target;   // 밀리면 스냅
    }
  }
  evict(false);
  setStatus('MSE · 버퍼 ' + have.toFixed(0) + '초 · ' +
    (stream && stream.getVideoTracks()[0] ? trackLabel() : ''));
}

function trackLabel(){
  try{
    var st = stream.getVideoTracks()[0].getSettings();
    return (st.width || '?') + '×' + (st.height || '?');
  }catch(e){ return ''; }
}

/* ---------------- 프레임 모드 (폴백) ---------------- */
var capCanvas = document.createElement('canvas');
var capCtx = capCanvas.getContext('2d');
var CAP_FPS = 10, CAP_LONG = 640;

function startFrames(gen){
  S.mode = 'frames';
  elDelayed.classList.add('hide');
  elCanvas.classList.remove('hide');
  try{ if(recorder && recorder.state !== 'inactive') recorder.stop(); }catch(e){}
  recorder = null;
  clearInterval(tickTimer);

  capTimer = setInterval(function(){
    if(gen !== engineGen || !stream) return;
    var vw = elLive.videoWidth, vh = elLive.videoHeight;
    if(!vw || !vh) return;
    var sc = Math.min(1, CAP_LONG / Math.max(vw, vh));
    var w = Math.round(vw * sc), h = Math.round(vh * sc);
    if(capCanvas.width !== w){ capCanvas.width = w; capCanvas.height = h; }
    capCtx.drawImage(elLive, 0, 0, w, h);
    capCanvas.toBlob(function(blob){
      if(gen !== engineGen || !blob) return;
      var now = performance.now();
      frames.push({ t: now, blob: blob });
      var minT = now - (S.delay + 6) * 1000;
      while(frames.length && frames[0].t < minT) frames.shift();
    }, 'image/jpeg', 0.75);
  }, 1000 / CAP_FPS);

  drawTimer = setInterval(function(){
    if(gen !== engineGen) return;
    var now = performance.now();
    var cut = now - S.delay * 1000;
    var have = frames.length ? (now - frames[0].t) / 1000 : 0;

    /* cut 이전의 가장 최신 프레임 */
    var pick = null;
    for(var i = frames.length - 1; i >= 0; i--){
      if(frames[i].t <= cut){ pick = frames[i]; break; }
    }
    if(!pick){
      elFill.classList.remove('hide');
      setFillUI(have);
      return;
    }
    elFill.classList.add('hide');
    if(S.frozen || decoding || pick.t === lastDrawnT) return;
    decoding = true;
    createImageBitmap(pick.blob).then(function(bmp){
      decoding = false;
      if(gen !== engineGen){ bmp.close(); return; }
      if(elCanvas.width !== bmp.width){ elCanvas.width = bmp.width; elCanvas.height = bmp.height; }
      ctx2d.drawImage(bmp, 0, 0);
      bmp.close();
      lastDrawnT = pick.t;
    }).catch(function(){ decoding = false; });
    setStatus('프레임 모드 · 버퍼 ' + have.toFixed(0) + '초 · ' + CAP_FPS + 'fps');
  }, 1000 / 15);
}

function setFillUI(have){
  elFillMax.textContent = S.delay;
  elFillNow.textContent = Math.min(S.delay, have).toFixed(0);
  elFillBar.style.width = Math.min(100, have / S.delay * 100) + '%';
}

/* ================= UI ================= */
function applyView(){
  elBadgeNum.textContent = S.delay;
  $('delayNum').firstElementChild.textContent = S.delay;
  $('delayRange').value = S.delay;
  document.body.classList.toggle('mirror', S.mirror);
  document.body.classList.toggle('fit-cover', S.fit === 'cover');
  $('btnMirror').classList.toggle('on', S.mirror);
  $('btnFit').classList.toggle('on', S.fit === 'cover');
  $('btnFit').textContent = S.fit === 'cover' ? '⛶ 맞추기' : '⛶ 채우기';
  var chips = document.querySelectorAll('#presets .chip');
  for(var i = 0; i < chips.length; i++)
    chips[i].classList.toggle('on', +chips[i].getAttribute('data-d') === S.delay);
}

function setDelay(d){
  S.delay = Math.max(1, Math.min(120, Math.round(d)));
  persist(); applyView();
}

$('delayRange').addEventListener('input', function(){ setDelay(+this.value); });
document.querySelectorAll('#presets .chip').forEach(function(c){
  c.addEventListener('click', function(){ setDelay(+this.getAttribute('data-d')); });
});

$('btnFreeze').addEventListener('click', function(){
  S.frozen = !S.frozen;
  this.classList.toggle('on', S.frozen);
  this.textContent = S.frozen ? '▶ 재개' : '⏸ 정지';
  $('frozenBadge').classList.toggle('hide', !S.frozen);
});

$('btnFlip').addEventListener('click', function(){
  S.facing = (S.facing === 'user') ? 'environment' : 'user';
  persist(); applyView();     // 미러 설정은 사용자가 정한 대로 유지
  startEngine();
});

$('btnMirror').addEventListener('click', function(){
  S.mirror = !S.mirror; persist(); applyView();
});

$('btnFit').addEventListener('click', function(){
  S.fit = (S.fit === 'cover') ? 'contain' : 'cover'; persist(); applyView();
});

/* ---- 화면 방향: 자동 → 세로 → 가로 3단 토글 ----
   APK 는 네이티브 브리지(AndroidOrient)로 확실히 잠그고,
   웹은 screen.orientation.lock (풀스크린에서만 먹으므로 fullscreenchange 마다 재적용). */
/* 각도 → UI 직접 회전. 0°=세로, 90°=가로, 180°=세로 뒤집힘, 270°=가로 반대편.
   OS 방향 잠금(setRequestedOrientation·orientation.lock)은 기기/전체화면 여부에 따라
   안 먹는 경우가 있어(실폰에서 "안 돈다" 확인) — 앱이 #rot 를 CSS 로 직접 돌린다.
   각도 모드에선 OS 회전을 세로로 못박아(이중 회전 방지) 항상 앱 회전만 유효하게 한다. */
function layoutRot(){
  var a = orientAngle();
  document.body.classList.toggle('rot90',  a === 90);
  document.body.classList.toggle('rot180', a === 180);
  document.body.classList.toggle('rot270', a === 270);
  var r = $('rot');
  if(a === 90 || a === 270){
    r.style.width  = window.innerHeight + 'px';   // vh/vw 는 주소창 유무에 흔들려 px 로 박는다
    r.style.height = window.innerWidth + 'px';
  }else{
    r.style.width = ''; r.style.height = '';
  }
}
window.addEventListener('resize', layoutRot);

function applyOrientation(){
  var m = S.orient;
  var btn = $('btnOrient');
  btn.textContent = (m === 'auto') ? '📱 자동' : '📱 ' + m + '°';
  btn.classList.toggle('on', m !== 'auto');
  layoutRot();
  if(window.AndroidOrient && AndroidOrient.set){
    try{ AndroidOrient.set(m === 'auto' ? 'auto' : 'pin'); }catch(e){}
  }else{
    try{
      if(screen.orientation){
        if(m === 'auto'){ screen.orientation.unlock(); }
        else{
          var p = screen.orientation.lock('portrait-primary');   // 이중 회전 방지용 고정
          if(p && p.catch) p.catch(function(){});
        }
      }
    }catch(e){}
  }
}
document.addEventListener('fullscreenchange', function(){
  if(S.orient !== 'auto') applyOrientation();
});
$('btnOrient').addEventListener('click', function(){
  var cyc = ['auto', '0', '90', '180', '270'];
  S.orient = cyc[(cyc.indexOf(S.orient) + 1) % cyc.length];
  if(rec) stopRec();      // 각도가 바뀌면 녹화 캔버스 치수도 바뀐다 — 트리밍 저장 후 재개
  persist(); applyOrientation();
});

/* ---- 회전 재동기화 (교통정리 2026-08-27) ----
   getUserMedia 트랙의 회전값은 캡처 시작 시점 기준이라, 화면이 돌면(특히 웹뷰는
   액티비티 재생성 없이 도니까) 영상이 눕거나 뒤집힌 채 남는다.
   → 화면 방향이 바뀌면 엔진을 재시작해 카메라를 새 방향으로 다시 연다.
   잠금 상태에선 방향이 안 바뀌므로 이 재시작도 일어나지 않는다(안정). */
var rotT = null;
function onRotate(){
  clearTimeout(rotT);
  rotT = setTimeout(function(){
    if(S.running){
      flashStatus('화면 회전 — 카메라를 새 방향으로 다시 엽니다');
      startEngine();
    }
  }, 700);   // 회전 애니메이션이 끝난 뒤 1회만
}
try{ screen.orientation.addEventListener('change', onRotate); }
catch(e){ window.addEventListener('orientationchange', onRotate); }

$('errRetry').addEventListener('click', function(){ startEngine(); });

/* 화면 탭 → 컨트롤 토글 (6초 뒤 자동 숨김) */
var hideT = null;
function showControls(){
  $('controls').classList.remove('hidden');
  clearTimeout(hideT);
  hideT = setTimeout(function(){ $('controls').classList.add('hidden'); }, 6000);
}
$('stage').addEventListener('pointerdown', function(){
  if($('controls').classList.contains('hidden')) showControls();
  else { clearTimeout(hideT); $('controls').classList.add('hidden'); }
});
$('controls').addEventListener('pointerdown', function(){
  clearTimeout(hideT);
  hideT = setTimeout(function(){ $('controls').classList.add('hidden'); }, 6000);
});

/* PiP 탭 → 실시간 미니 화면 접기/펴기 */
$('pip').addEventListener('pointerdown', function(e){
  e.stopPropagation();
  this.classList.toggle('off');
});

/* ================= 저장 — 스냅샷(JPG) / 리플레이 녹화(webm) ================= */
/* 상태줄을 잠깐 빌려 안내를 띄운다. mseTick 이 300ms 마다 덮어쓰므로 홀드 시각을 둔다. */
var statusHoldUntil = 0;
function setStatus(msg){
  if(Date.now() < statusHoldUntil) return;
  elStatus.textContent = msg;
}
function flashStatus(msg){
  statusHoldUntil = Date.now() + 2500;
  elStatus.textContent = msg;
  showControls();
}

function stamp(){
  var d = new Date();
  function z(n){ return String(n).padStart(2, '0'); }
  return '' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) +
         '_' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}

function saveBlob(blob, name){
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  /* 바탕화면 shim(showSaveFilePicker)은 대화상자가 닫힌 **뒤에야** blob 을 fetch 한다 —
     그 전에 revoke 하면 0바이트 파일이 된다. 피커가 없는 환경(폰)에서만 지연 revoke. */
  if(!window.showSaveFilePicker){
    setTimeout(function(){ try{ URL.revokeObjectURL(url); }catch(e){} }, 60000);
  }
}

/* --- 스냅샷: 지금 보이는 지연 화면 1장을 JPG 로 --- */
$('btnShot').addEventListener('click', function(){
  var src, w, h;
  if(S.mode === 'frames'){ src = elCanvas; w = elCanvas.width; h = elCanvas.height; }
  else { src = elDelayed; w = elDelayed.videoWidth; h = elDelayed.videoHeight; }
  if(!w || !h){ flashStatus('아직 지연 화면이 없습니다 — 버퍼가 차면 저장할 수 있어요'); return; }
  var a = orientAngle();
  var cw = (a === 90 || a === 270) ? h : w, ch = (a === 90 || a === 270) ? w : h;
  var c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  var cx = c.getContext('2d');
  /* 화면에 보이는 그대로: 회전(#rot) → 미러 순서를 캔버스에서 재현 */
  cx.translate(cw / 2, ch / 2);
  cx.rotate(a * Math.PI / 180);
  if(S.mirror) cx.scale(-1, 1);
  cx.drawImage(src, -w / 2, -h / 2, w, h);
  c.toBlob(function(b){
    if(!b){ flashStatus('스냅샷 실패'); return; }
    saveBlob(b, 'delay_shot_' + stamp() + '.jpg');
    flashStatus('📸 스냅샷 저장');
  }, 'image/jpeg', 0.92);
});

/* --- webm 길이 패치 ---
   MediaRecorder 는 스트리밍이라 Duration 을 파일에 안 쓴다 → 재생기가 총 길이를 몰라
   타임바가 0 에 붙는다(시간은 흐르는데 바가 제자리). Segment→Info 에 Duration(0x4489)을
   써 넣어 고친다. 실패하면 원본 그대로 저장(회귀 없음). */
function fixWebmDuration(blob, durationMs, cb){
  var HEAD = 4096;                       // Info 는 파일 맨 앞에 있다
  var fr = new FileReader();
  fr.onload = function(){
    var out = null;
    try{ out = _webmPatch(new Uint8Array(fr.result), durationMs); }catch(e){}
    if(out) cb(new Blob([out, blob.slice(Math.min(HEAD, blob.size))], { type: blob.type }));
    else cb(blob);
  };
  fr.onerror = function(){ cb(blob); };
  fr.readAsArrayBuffer(blob.slice(0, HEAD));
}

function _webmVint(u8, p){               // EBML 가변 정수 (크기 필드)
  var b = u8[p], len = 1, mask = 0x80;
  while(len <= 8 && !(b & mask)){ mask >>= 1; len++; }
  if(len > 8 || p + len > u8.length) return null;
  var value = b & (mask - 1), allOnes = (b & (mask - 1)) === (mask - 1);
  for(var i = 1; i < len; i++){
    value = value * 256 + u8[p + i];
    if(u8[p + i] !== 0xFF) allOnes = false;
  }
  return { len: len, value: value, unknown: allOnes };
}
function _webmId(u8, p){                 // 엘리먼트 ID (마커 비트 포함)
  var b = u8[p], len = 1, mask = 0x80;
  while(len <= 4 && !(b & mask)){ mask >>= 1; len++; }
  if(len > 4 || p + len > u8.length) return null;
  var id = 0;
  for(var i = 0; i < len; i++) id = id * 256 + u8[p + i];
  return { len: len, id: id };
}
function _webmPatch(u8, durationMs){
  var p = 0, id = _webmId(u8, p);
  if(!id || id.id !== 0x1A45DFA3) return null;             // EBML 헤더
  p += id.len;
  var sz = _webmVint(u8, p);
  p += sz.len + sz.value;
  id = _webmId(u8, p);
  if(!id || id.id !== 0x18538067) return null;             // Segment
  p += id.len;
  sz = _webmVint(u8, p);
  p += sz.len;                                             // 크기는 대개 미지(스트리밍) — 지나감
  while(p < u8.length){
    id = _webmId(u8, p);
    if(!id) return null;
    var idPos = p; p += id.len;
    sz = _webmVint(u8, p);
    if(!sz) return null;
    var dataPos = p + sz.len;
    if(id.id === 0x1549A966){                              // Info
      if(sz.unknown || dataPos + sz.value > u8.length) return null;
      return _webmPatchInfo(u8, idPos, id.len, sz, dataPos, durationMs);
    }
    if(sz.unknown || id.id === 0x1F43B675) return null;    // Cluster까지 왔으면 포기
    p = dataPos + sz.value;
  }
  return null;
}
function _webmPatchInfo(u8, idPos, idLen, sz, dataPos, durationMs){
  var scale = 1000000, durPos = -1, durLen = 0;
  var q = dataPos, end = dataPos + sz.value;
  while(q < end){
    var cid = _webmId(u8, q); if(!cid) return null;
    var csz = _webmVint(u8, q + cid.len); if(!csz) return null;
    var cdata = q + cid.len + csz.len;
    if(cid.id === 0x2AD7B1){                               // TimecodeScale(ns)
      scale = 0;
      for(var i = 0; i < csz.value; i++) scale = scale * 256 + u8[cdata + i];
    }
    if(cid.id === 0x4489){ durPos = cdata; durLen = csz.value; }
    q = cdata + csz.value;
  }
  var ticks = durationMs * 1000000 / scale;                // scale 기본 1ms/틱
  if(durPos >= 0){                                         // 이미 있으면 값만 교체
    var dv = new DataView(u8.buffer, u8.byteOffset);
    if(durLen === 8) dv.setFloat64(durPos, ticks);
    else if(durLen === 4) dv.setFloat32(durPos, ticks);
    else return null;
    return u8;
  }
  /* 없으면 Info 끝에 11바이트(0x4489, 크기 8, float64) 삽입 — Info 크기 필드는
     길이가 변하지 않게 8바이트 고정 vint 로 다시 쓴다 */
  var ins = new Uint8Array(11);
  ins[0] = 0x44; ins[1] = 0x89; ins[2] = 0x88;
  new DataView(ins.buffer).setFloat64(3, ticks);
  var newSize = sz.value + ins.length;
  var szBytes = new Uint8Array(8);
  szBytes[0] = 0x01;                                       // 8바이트 vint 마커
  for(var k = 7; k >= 1; k--){ szBytes[k] = newSize & 0xFF; newSize = Math.floor(newSize / 256); }
  var head = new Uint8Array(u8.length - sz.len + 8 + ins.length);
  var o = 0;
  head.set(u8.subarray(0, idPos + idLen), o); o += idPos + idLen;
  head.set(szBytes, o); o += 8;
  head.set(u8.subarray(dataPos, end), o); o += end - dataPos;
  head.set(ins, o); o += ins.length;
  head.set(u8.subarray(end), o);
  return head;
}

/* --- 자동 녹화: 지연 화면을 **항상** 5분 단위로 끊어 저장 (2026-08-27 지시) ---
   · 버튼을 안 눌러도 재생이 시작되면 알아서 녹화 — 5분마다 파일 마감 후 곧장 다음 구간.
   · ⏹(버튼)을 누르면 그 구간을 지금까지로 저장(트리밍)하고, 워치독이 새 구간을 연다.
   · CSS 미러는 captureStream 에 안 찍히므로, 미러까지 화면에 보이는 그대로 담기 위해
     오프스크린 캔버스에 30fps 로 옮겨 그리고 그 캔버스를 녹화한다. */
var rec = null, recChunks = [], recT0 = 0, recTimer = null, recDraw = null;
var SEG_MS = 5 * 60 * 1000;
var recCanvas = document.createElement('canvas');
var recCtx = recCanvas.getContext('2d');

function recMime(){
  if(!window.MediaRecorder) return null;
  var cands = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
  for(var i = 0; i < cands.length; i++){
    try{ if(MediaRecorder.isTypeSupported(cands[i])) return cands[i]; }catch(e){}
  }
  return null;
}

function recReady(){
  if(!S.running) return false;
  if(S.mode === 'mse') return !!elDelayed.videoWidth && !elDelayed.paused;
  if(S.mode === 'frames') return lastDrawnT > 0;
  return false;
}

function startSegment(){
  var mime = recMime();
  var w = (S.mode === 'frames') ? elCanvas.width : elDelayed.videoWidth;
  var h = (S.mode === 'frames') ? elCanvas.height : elDelayed.videoHeight;
  if(!mime || !w || !h || !recCanvas.captureStream) return;
  var a = orientAngle();
  var cw = (a === 90 || a === 270) ? h : w, ch = (a === 90 || a === 270) ? w : h;
  recCanvas.width = cw; recCanvas.height = ch;

  recDraw = setInterval(function(){
    var src = (S.mode === 'frames') ? elCanvas : elDelayed;
    recCtx.save();
    /* 화면과 동일: 회전 → 미러 순서 */
    recCtx.translate(cw / 2, ch / 2);
    recCtx.rotate(a * Math.PI / 180);
    if(S.mirror) recCtx.scale(-1, 1);
    try{ recCtx.drawImage(src, -w / 2, -h / 2, w, h); }catch(e){}
    recCtx.restore();
  }, 1000 / 30);

  recChunks = [];
  try{ rec = new MediaRecorder(recCanvas.captureStream(30),
                               { mimeType: mime, videoBitsPerSecond: 2500000 }); }
  catch(e){
    try{ rec = new MediaRecorder(recCanvas.captureStream(30)); }
    catch(e2){ clearInterval(recDraw); recDraw = null; return; }
  }
  rec.ondataavailable = function(e){ if(e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = function(){
    var type = (rec && rec.mimeType) || 'video/webm';
    var ext = /mp4/.test(type) ? '.mp4' : '.webm';
    var elapsed = Date.now() - recT0;
    var b = new Blob(recChunks, { type: type });
    rec = null; recChunks = [];
    updateRecUI();
    if(elapsed < 2000) return;   // 회전·카메라 전환 재시작이 만드는 부스러기 구간은 버린다
    if(b.size > 0){
      var name = 'delay_replay_' + stamp() + ext;
      var done = function(fixed){
        saveBlob(fixed, name);
        flashStatus('🎬 저장 (' + (fixed.size / 1048576).toFixed(1) + 'MB)' +
                    (S.autoRec ? ' — 다음 구간 자동 녹화' : ''));
      };
      if(ext === '.webm') fixWebmDuration(b, elapsed, done);   // 타임바 고정 문제 방지
      else done(b);
    }
  };
  rec.onerror = function(){ stopRec(); };
  rec.start(1000);
  recT0 = Date.now();
  updateRecUI();
  recTimer = setInterval(function(){
    updateRecUI();
    if(Date.now() - recT0 >= SEG_MS) stopRec();   // 5분 마감 — 워치독이 다음 구간을 연다
  }, 500);
}

function stopRec(){
  clearInterval(recTimer); recTimer = null;
  clearInterval(recDraw); recDraw = null;
  try{
    if(rec && rec.state !== 'inactive') rec.stop();   // onstop 에서 저장
    else { rec = null; updateRecUI(); }
  }catch(e){ rec = null; updateRecUI(); }
}

function updateRecUI(){
  var b = $('btnRec');
  if(rec){
    var s = Math.floor((Date.now() - recT0) / 1000);
    b.classList.add('on');
    b.textContent = '⏹ 저장 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }else{
    b.classList.remove('on');
    b.textContent = '⏺ 대기';
  }
}

$('btnRec').addEventListener('click', function(){
  if(rec) stopRec();                       // 여기까지 저장(트리밍) — 새 구간은 워치독이 연다
  else if(recReady()) startSegment();      // 자동녹화를 꺼 둔 상태의 수동 녹화
});

/* ---- 자동녹화 ON/OFF — 폰 용량이 없을 때 끌 수 있다 (기본 ON) ---- */
function updateAutoUI(){
  var b = $('btnAuto');
  b.classList.toggle('on', S.autoRec);
  b.textContent = S.autoRec ? '🔴 자동녹화 ON' : '⚪ 자동녹화 OFF';
}
$('btnAuto').addEventListener('click', function(){
  S.autoRec = !S.autoRec;
  persist(); updateAutoUI();
  if(!S.autoRec){
    if(rec) stopRec();                     // 진행 중 구간은 여기까지 저장하고 멈춘다
    flashStatus('자동녹화 끔 — ⏺ 버튼으로 수동 녹화는 가능');
  }else{
    flashStatus('자동녹화 켬 — 5분 단위로 저장');
  }
});
updateAutoUI();

/* 워치독 — 재생이 살아 있으면 녹화도 살아 있게 (최초 시작·카메라 전환·구간 마감 뒤 재개) */
setInterval(function(){ if(S.autoRec && !rec && recReady()) startSegment(); }, 1000);

/* ================= Wake Lock (화면 꺼짐 방지) ================= */
var wlock = null;
function grabLock(){
  if(!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then(function(l){ wlock = l; }).catch(function(){});
}
document.addEventListener('visibilitychange', function(){
  if(!document.hidden){ grabLock(); }
});

/* ================= 게이트 ================= */
(function(){
  function _todayStr(){var d=new Date();return ''+d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');} function _dayCode(){var d=new Date();var m=String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');return m.split('').map(function(c){return(+c+1)%10;}).join('');} function _instantOK(){try{return new URLSearchParams(location.search).get('g')==='ins';}catch(e){return false;}}
  var KEY = "kiosk_daily";
  var gate = document.getElementById("gate");
  var isLocal = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:');
  function enter(){
    applyView(); applyOrientation(); showControls(); grabLock(); startEngine();
  }
  if(localStorage.getItem(KEY) || _instantOK() || isLocal){ gate.remove(); enter(); return; }
  var entry = "";
  var dots = gate.querySelectorAll(".gate-dots span");
  var msg = gate.querySelector(".gate-msg");
  function render(){ for(var i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < entry.length); }
  function check(){
    if(entry.length < 4) return;
    if(entry === _dayCode()){
      try{ localStorage.setItem(KEY, _todayStr()); }catch(e){}
      gate.classList.add("ok");
      try{
        var el = document.documentElement;
        var p = (el.requestFullscreen || el.webkitRequestFullscreen || function(){}).call(el);
        if(p && p.catch) p.catch(function(){});
      }catch(e){}
      setTimeout(function(){ if(gate.parentNode) gate.remove(); }, 350);
      enter();
    }else{
      gate.classList.add("err"); msg.textContent = "비밀번호가 틀렸습니다";
      setTimeout(function(){ gate.classList.remove("err"); msg.textContent = ""; entry = ""; render(); }, 550);
    }
  }
  function press(k){
    if(k === "del") entry = entry.slice(0, -1);
    else if(entry.length < 4) entry += k;
    render(); check();
  }
  var keys = gate.querySelectorAll(".gate-keys button");
  for(var i = 0; i < keys.length; i++){
    keys[i].addEventListener("click", function(){ press(this.getAttribute("data-k")); });
  }
  window.addEventListener("keydown", function(e){
    if(!gate.parentNode) return;
    if(/^[0-9]$/.test(e.key)) press(e.key);
    else if(e.key === "Backspace") press("del");
  });
  render();
})();
