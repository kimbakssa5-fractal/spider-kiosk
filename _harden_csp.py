# -*- coding: utf-8 -*-
"""
spider-kiosk 공개 페이지 일괄 보안 잠금.
- 각 페이지에 맞춤 CSP(Content-Security-Policy) meta 삽입(자기 폴더 'self'만 기본,
  꼭 필요한 외부 도메인만 화이트리스트 — 나머지 전부 차단).
- 죽은 cdnjs QR 폴백(document.write) 무력화.
멱등(이미 CSP 있으면 건너뜀). 실행: python _harden_csp.py
"""
import os, re, sys
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(os.path.abspath(__file__))

TAIL = "img-src 'self' data: blob:{IMG}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

def csp(script="'self' 'unsafe-inline'", connect="'self'", img="", extra=""):
    return ("default-src 'self'; "
            f"script-src {script}; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            f"connect-src {connect}; "
            + (extra + " " if extra else "")
            + TAIL.format(IMG=img))

# 프로파일
A = csp()                                                                   # 엄격: self + 폰트만
B = csp(connect="'self' https://litterbox.catbox.moe https://tmpfiles.org", # QR+사진업로드
        img=" https:")
C = csp(script="'self' 'unsafe-inline' https://www.gstatic.com",            # Firebase
        connect="'self' https://*.googleapis.com https://*.firebaseio.com https://litterbox.catbox.moe https://tmpfiles.org",
        img=" https:")
D = csp(script="'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",  # MediaPipe
        connect="'self' https://cdn.jsdelivr.net https://storage.googleapis.com",
        extra="worker-src 'self' blob:; child-src blob:;")
E = csp(script="'self' 'unsafe-inline' 'wasm-unsafe-eval'",                            # MediaPipe 자체호스팅(vendor)
        extra="worker-src 'self' blob:; child-src blob:;")

PROFILE = {
    "index.html": A, "index-cards.html": A, "doodle.html": A,
    "05_water_trace/index.html": A, "06_water_trace_interaction/index.html": A,
    "07_water_trace_goldfish/index.html": A,
    "08_water_wave/index.html": A, "10_dot_mosaic/index.html": A,
    "31_memory_game/index.html": A, "32_game_hall/index.html": A, "33_game_pinball/index.html": A,
    "39_game_billiards/index.html": A,
    "21_database_cell/index.html": A,
    "fractal.html": B, "triangle.html": B,
    "guestbook.html": C, "admin.html": C,
    "11_pose_skeleton/index.html": D, "12_face_off/index.html": D, "13_window/index.html": D,
    "34_game_run/index.html": E,
}

CHARSET = re.compile(r'(<meta\s+charset=["\']?[\w-]+["\']?\s*/?>)', re.I)
CDNJS_FALLBACK = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"

def harden(rel, policy):
    path = os.path.join(HERE, rel.replace("/", os.sep))
    if not os.path.exists(path):
        print("  ! 없음:", rel); return
    html = open(path, encoding="utf-8").read()
    changed = []
    # 1) CSP 삽입(없을 때만)
    if "Content-Security-Policy" not in html:
        meta = f'<meta http-equiv="Content-Security-Policy" content="{policy}">'
        m = CHARSET.search(html)
        if m:
            html = html[:m.end()] + "\n" + meta + html[m.end():]
        else:
            html = re.sub(r'(<head[^>]*>)', r'\1\n' + meta, html, count=1, flags=re.I)
        changed.append("CSP")
    # 2) 죽은 cdnjs QR 폴백 무력화
    if CDNJS_FALLBACK in html:
        html = html.replace(CDNJS_FALLBACK, "")   # document.write 대상 URL 제거 → 외부 로드 경로 소멸
        changed.append("QR폴백제거")
    if changed:
        open(path, "w", encoding="utf-8").write(html)
        print(f"  ✓ {rel:42s} [{', '.join(changed)}]")
    else:
        print(f"  · {rel:42s} (이미 적용됨)")

if __name__ == "__main__":
    print("spider-kiosk 보안 잠금 적용:")
    for rel, pol in PROFILE.items():
        harden(rel, pol)
    print("완료.")
