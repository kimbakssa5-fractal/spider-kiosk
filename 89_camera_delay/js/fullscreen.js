/* ==========================================================================
   자동 풀스크린 (전 프로젝트 공통 규칙)
   브라우저는 사용자 제스처 없이 requestFullscreen()을 허용하지 않는다.
     · 런처(run_*.bat)로 띄우면 Chrome --kiosk 라 이미 전체화면 → 아무것도 하지 않는다.
     · 주소창으로 그냥 열었을 때는 로드 직후 한 번 시도하고, 실패하면 **조용히** 기다렸다가
       어떤 상호작용이든 생기면 그때 전환한다.

   ★ 풀스크린이 풀리면 다시 돌아간다 (2026-08-09 추가).
     파일 저장/열기 대화상자(showSaveFilePicker·<input type=file>), 인쇄, 권한 팝업 등은
     크롬이 **풀스크린을 강제로 해제**한다. 대화상자를 닫아도 저절로 돌아오지 않아서
     "스냅샷 누르면 창모드로 떨어진 채 그대로"가 된다.
     → 풀스크린이 풀리면 즉시 재진입을 시도하고, 제스처가 필요하면 다음 입력에서 돌아간다.

   ⚠ 단, 사용자가 **Esc 로 직접 나간 경우는 존중한다.** 그때까지 되돌리면 빠져나갈 수가 없다.
     Esc 후 10초 동안은 자동 복귀를 하지 않는다.

   🚫 관람객에게 "화면을 한 번 누르세요" 같은 안내 문구를 띄우지 않는다 (2026-08-07 지시).
      전시장에 온 사람에게 할 일을 시키는 문구는 금지. 필요한 제스처는 런처가 대신 만든다.
   끄려면 ?nofs
   ========================================================================== */
(function(){
'use strict';
if(new URLSearchParams(location.search).has('nofs')) return;

function isFs(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}
/* 키오스크(--kiosk / --start-fullscreen)면 창이 이미 화면 전체를 덮고 있다 */
function kioskLike(){
  return Math.abs(window.innerHeight - screen.height) <= 2 &&
         Math.abs(window.innerWidth  - screen.width)  <= 2;
}
function request(){
  var el = document.documentElement;
  var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if(!fn) return;
  try{
    var p = fn.call(el, {navigationUI:'hide'});
    if(p && p.catch) p.catch(function(){});
  }catch(e){}
}

var wanted = false;        // 한 번이라도 풀스크린에 들어갔다 = 앞으로도 풀스크린이 정상 상태
var userExited = 0;        // Esc 로 직접 나간 시각 (이 뒤 10초는 자동 복귀 안 함)
var armed = false;

var events = ['pointerdown','touchstart','keydown','click'];
function onGesture(){
  if(isFs() || kioskLike()){ off(); return; }
  if(Date.now() - userExited < 10000) return;   // 사용자가 방금 Esc 로 나갔다 — 존중
  request();
  setTimeout(function(){ if(isFs()) off(); }, 300);
}
function on(){
  if(armed) return;
  armed = true;
  events.forEach(function(ev){ window.addEventListener(ev, onGesture, {passive:true}); });
}
function off(){
  if(!armed) return;
  armed = false;
  events.forEach(function(ev){ window.removeEventListener(ev, onGesture); });
}

/* 밖에서 부를 수 있게 열어 둔다 — 저장/열기 대화상자를 닫은 직후 등.
   ⚠ 한 번만 시도하면 거의 실패한다(2026-08-27 실측). 대화상자가 떠 있는 동안엔
     페이지에 포커스가 없어 requestFullscreen 이 무조건 막히고, 사람이 폴더를 뒤지는
     몇 초 사이에 타이머가 다 지나가 버린다. → 포커스가 돌아온 뒤로 몇 번 더 두드린다. */
var retryTimer = 0;
function reenter(){
  if(kioskLike() || isFs()) return;
  if(Date.now() - userExited < 10000) return;
  clearTimeout(retryTimer);
  var tries = 0;
  (function loop(){
    if(isFs() || kioskLike()) return;
    if(Date.now() - userExited < 10000) return;
    if(document.hasFocus()) request();          // 포커스 없을 땐 시도해도 헛수고
    if(++tries < 10) retryTimer = setTimeout(loop, 250);
  })();
  on();                                          // 병행: 아무 입력이나 오면 그때 즉시
}
window.__enterFullscreen = reenter;

/* 대화상자가 닫히면 포커스가 돌아온다 — 복귀의 진짜 신호는 이쪽이다 */
window.addEventListener('focus', function(){ if(wanted) setTimeout(reenter, 60); });
document.addEventListener('visibilitychange', function(){
  if(wanted && !document.hidden) setTimeout(reenter, 60);
});

/* --kiosk 로 띄운 경우엔 API 풀스크린이 아니라서 fullscreenchange 가 아예 안 온다.
   창이 화면을 꽉 채우다가 줄어든 것을 크기로 감지해 복구한다. */
var wasFull = false;
setInterval(function(){
  if(isFs() || kioskLike()){ wasFull = true; wanted = true; return; }
  if(wasFull && wanted){ wasFull = false; reenter(); }   // 전이 1회만 — 이후엔 제스처 대기
}, 700);

/* Esc 는 크롬이 풀스크린 해제로 먹어 버려 keydown 이 안 올 수도 있다.
   capture 로 먼저 받아 "사용자가 직접 나가려 한다"를 기록한다. */
window.addEventListener('keydown', function(e){
  if(e.key === 'Escape' || e.keyCode === 27) userExited = Date.now();
}, true);

document.addEventListener('fullscreenchange', function(){
  if(isFs()){ wanted = true; off(); return; }
  /* 풀스크린이 풀렸다 */
  if(!wanted) return;
  if(Date.now() - userExited < 10000) return;         // Esc 로 나갔으면 그대로 둔다
  reenter();   // 안에서 포커스 확인 + 재시도까지 한다
});

function boot(){
  if(kioskLike()){ wanted = true; return; }   // 런처로 띄운 경우 — 이미 전체화면
  request();                                  // 제스처 없이 한 번 시도(허용되는 환경도 있다)
  setTimeout(function(){
    if(isFs() || kioskLike()){ wanted = true; return; }
    /* 안내는 하지 않는다. 사람이 뭘 만지든 그 순간 전환된다. */
    on();
  }, 600);
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
