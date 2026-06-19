# 🕸 spider-kiosk

거미줄 낙서장 + 포토 방명록 키오스크.

| 페이지 | 설명 |
|---|---|
| `index.html` | 메인 메뉴 |
| `doodle.html` | 거미줄 낙서장 (모바일/키오스크 겸용) |
| `guestbook.html` | 포토 방명록 — 촬영 → 거미줄 펜 꾸미기 → QR 전송 |
| `triangle.html` | 삼각형 모자익 — 사진을 클릭/드래그하면 그 영역이 로우폴리 삼각형 셀로 변환 |
| `admin.html` | 방명록 기록 관리 (비밀번호는 파일 상단 `ADMIN_PIN`에서 설정) |

## 기록 저장 방식

- 촬영하는 즉시 **원본 화질로 IndexedDB에 저장**됩니다. 보내기 전에 이탈해도 기록이 남고, 개수 제한이 없습니다.
- `admin.html`에서 전체 보기 / 다운로드 / 삭제 / 전체 다운로드를 할 수 있습니다.

## Firebase 동기화 (선택)

여러 기기 간 동기화가 필요하면 `firebase-config.js` 파일 상단의 안내에 따라
Firebase 프로젝트의 `firebaseConfig` 값을 넣으면 Firestore로 자동 동기화됩니다.
설정하지 않아도 각 기기 로컬에는 정상 저장됩니다.

## 카메라 권한 주의

`getUserMedia`(카메라)는 **https 또는 localhost**에서만 동작합니다.
파일을 직접 열지 말고 간단한 로컬 서버(`npx serve` 등)나 GitHub Pages로 띄우세요.
