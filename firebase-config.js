// ═══════════════════════════════════════════════════════════════
//  Firebase 연동 설정 (선택 사항)
// ═══════════════════════════════════════════════════════════════
//  ※ 이 파일을 직접 수정하지 않아도, 관리 페이지(admin.html)의
//     "⚙ 연동 설정" 버튼에서 firebaseConfig를 붙여넣어 설정할 수
//     있습니다. (이 파일에 값을 넣으면 그 값이 UI 설정보다 우선)
//
//  연동하지 않아도 방명록은 이 기기(브라우저)의 IndexedDB에
//  원본 화질로 전부 저장됩니다.
//  여러 기기(키오스크 ↔ 사무실 PC 등) 간 동기화가 필요할 때만
//  설정하세요.
//
//  ── 설정 절차 ──────────────────────────────────────────────
//  1. https://console.firebase.google.com 접속 → 프로젝트 만들기
//  2. 프로젝트 개요 > 웹 앱 추가(</> 아이콘) → firebaseConfig 값 복사
//  3. 빌드 > Firestore Database > 데이터베이스 만들기
//     (위치: asia-northeast3(서울) 권장, 모드: 테스트 모드로 시작)
//  4. 아래 `window.FIREBASE_CONFIG = null;` 을 지우고
//     복사한 값으로 교체 (예시 참고)
//
//  ── Firestore 보안 규칙 (테스트 모드 만료 후) ─────────────
//  guestbook 컬렉션만 읽기/쓰기 허용:
//    rules_version = '2';
//    service cloud.firestore {
//      match /databases/{database}/documents {
//        match /guestbook/{id} {
//          allow read, write: if true;
//        }
//      }
//    }
//  ※ 누구나 접근 가능한 규칙이므로 행사용 임시 운영에만 사용하고,
//     장기 운영 시 Firebase Auth 도입을 권장합니다.
// ═══════════════════════════════════════════════════════════════

window.FIREBASE_CONFIG = null;

// 예시 — 발급받은 값으로 교체:
// window.FIREBASE_CONFIG = {
//   apiKey: "AIzaSy...",
//   authDomain: "spider-kiosk.firebaseapp.com",
//   projectId: "spider-kiosk",
//   storageBucket: "spider-kiosk.appspot.com",
//   messagingSenderId: "123456789",
//   appId: "1:123456789:web:abcdef"
// };
