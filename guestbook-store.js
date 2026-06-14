// ═══════════════════════════════════════════════════════════════
//  포토 방명록 저장소
//  - 로컬: IndexedDB (원본 화질, 무제한 — 기록이 사라지지 않음)
//  - 원격: Firebase Firestore (firebase-config.js 설정 시 자동 동기화)
//  guestbook.html / admin.html 에서 공용으로 사용
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const DB_NAME = 'spider_kiosk_db';
  const STORE = 'guestbook';
  const COLL = 'guestbook';        // Firestore 컬렉션명
  const TOMB_KEY = 'gb_deleted_ids'; // 오프라인 중 삭제한 항목의 원격 삭제 대기 목록

  // ── IndexedDB ──────────────────────────────────────────────
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains(STORE)) {
          rq.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return dbPromise;
  }
  async function store(mode) {
    const db = await openDB();
    return db.transaction(STORE, mode).objectStore(STORE);
  }
  function req(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  // ── 삭제 대기 목록(tombstone) ─────────────────────────────
  function getTombs() {
    try { return JSON.parse(localStorage.getItem(TOMB_KEY) || '[]'); } catch (e) { return []; }
  }
  function setTombs(arr) {
    try { localStorage.setItem(TOMB_KEY, JSON.stringify(arr.slice(-500))); } catch (e) {}
  }

  // ── Firebase 설정 ──────────────────────────────────────────
  // 우선순위: firebase-config.js 의 window.FIREBASE_CONFIG(파일)
  //          → 관리 페이지(admin.html) UI에서 저장한 localStorage 값
  const CFG_KEY = 'gb_firebase_config';
  function getConfig() {
    if (window.FIREBASE_CONFIG) return window.FIREBASE_CONFIG;
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { return null; }
  }
  function configSource() {
    if (window.FIREBASE_CONFIG) return 'file';
    return getConfig() ? 'ui' : null;
  }
  async function resetApp() {
    fdb = null;
    fstorage = null;
    if (typeof firebase !== 'undefined' && firebase.apps.length) {
      try { await firebase.app().delete(); } catch (e) {}
    }
  }
  async function saveConfig(obj) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(obj)); } catch (e) {}
    await resetApp();
  }
  async function clearConfig() {
    try { localStorage.removeItem(CFG_KEY); } catch (e) {}
    await resetApp();
  }

  // ── Firebase ───────────────────────────────────────────────
  let fdb = null, fstorage = null;
  function fb() {
    if (fdb) return fdb;
    const cfg = getConfig();
    if (!cfg || typeof firebase === 'undefined') return null;
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      fdb = firebase.firestore();
    } catch (e) {
      console.warn('Firebase 초기화 실패:', e);
    }
    return fdb;
  }

  // Firebase Storage (선택) — storageBucket이 설정돼 있고 SDK가 로드된 경우에만 동작
  function storage() {
    if (fstorage) return fstorage;
    const cfg = getConfig();
    if (!cfg || !cfg.storageBucket) return null;
    if (typeof firebase === 'undefined' || typeof firebase.storage !== 'function') return null;
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      fstorage = firebase.storage();
    } catch (e) {
      console.warn('Firebase Storage 초기화 실패:', e);
    }
    return fstorage;
  }

  // 이미지(blob)를 Storage에 올리고 공개 다운로드 URL 반환. 미설정/실패 시 null.
  async function uploadImage(blob, filename) {
    const st = storage();
    if (!st) return null;
    try {
      const ref = st.ref().child('guestbook_share/' + filename);
      const snap = await ref.put(blob, { contentType: 'image/jpeg' });
      return await snap.ref.getDownloadURL();
    } catch (e) {
      console.warn('Storage 업로드 실패:', e);
      return null;
    }
  }

  // ── 공개 API ───────────────────────────────────────────────
  // entry: { id, t(ISO 문자열), label(표시용, 선택), d(원본 dataURL), th(썸네일 dataURL), synced }

  function newId() {
    return 'e' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function add(entry) {
    entry.synced = false;
    const s = await store('readwrite');
    await req(s.put(entry));
    syncUp(entry); // 백그라운드 업로드 (실패해도 로컬엔 남음)
    return entry.id;
  }

  async function update(id, patch) {
    const s = await store('readwrite');
    const cur = await req(s.get(id));
    if (!cur) return;
    const next = Object.assign(cur, patch, { synced: false });
    const s2 = await store('readwrite');
    await req(s2.put(next));
    syncUp(next);
  }

  async function get(id) {
    const s = await store('readonly');
    return req(s.get(id));
  }

  async function list() {
    const s = await store('readonly');
    const all = await req(s.getAll());
    return all.sort((a, b) => (a.t < b.t ? 1 : -1)); // 최신순
  }

  async function remove(id) {
    const s = await store('readwrite');
    await req(s.delete(id));
    const tombs = getTombs();
    if (!tombs.includes(id)) { tombs.push(id); setTombs(tombs); }
    const d = fb();
    if (d) {
      try {
        await d.collection(COLL).doc(id).delete();
        setTombs(getTombs().filter(x => x !== id));
      } catch (e) { /* 오프라인 — 다음 syncAll에서 재시도 */ }
    }
  }

  async function markSynced(id) {
    const s = await store('readwrite');
    const cur = await req(s.get(id));
    if (!cur) return;
    cur.synced = true;
    const s2 = await store('readwrite');
    await req(s2.put(cur));
  }

  async function syncUp(entry) {
    const d = fb();
    if (!d) return false;
    try {
      await d.collection(COLL).doc(entry.id).set({
        t: entry.t,
        label: entry.label || '',
        d: entry.d,
        th: entry.th || ''
      });
      await markSynced(entry.id);
      return true;
    } catch (e) {
      return false;
    }
  }

  // 전체 동기화: 미업로드분 올리기 → 삭제 대기 처리 → 원격 신규분 내려받기
  async function syncAll() {
    const d = fb();
    if (!d) {
      return { ok: false, reason: getConfig() ? 'Firebase SDK 로드 실패(인터넷 확인)' : 'Firebase 미설정 (관리 페이지의 연동 설정 또는 firebase-config.js)' };
    }
    try {
      let up = 0, down = 0;
      const local = await list();

      for (const en of local) {
        if (!en.synced && await syncUp(en)) up++;
      }
      for (const id of getTombs()) {
        try {
          await d.collection(COLL).doc(id).delete();
          setTombs(getTombs().filter(x => x !== id));
        } catch (e) {}
      }
      const snap = await d.collection(COLL).get();
      const tombs = getTombs();
      const localIds = new Set(local.map(e => e.id));
      for (const doc of snap.docs) {
        if (localIds.has(doc.id) || tombs.includes(doc.id)) continue;
        const v = doc.data();
        const s = await store('readwrite');
        await req(s.put({ id: doc.id, t: v.t, label: v.label || '', d: v.d, th: v.th || '', synced: true }));
        down++;
      }
      return { ok: true, up, down };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // 구버전(localStorage 썸네일 12장) 기록을 IndexedDB로 1회 이전
  async function migrateLegacy() {
    let raw = null;
    try { raw = localStorage.getItem('guestbook_entries'); } catch (e) {}
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      const base = Date.now() - arr.length * 60000;
      for (let i = 0; i < arr.length; i++) {
        const en = arr[i];
        await add({
          id: 'legacy_' + i + '_' + base,
          t: new Date(base + i * 60000).toISOString(),
          label: en.t || '',
          d: en.d,
          th: en.d
        });
      }
      localStorage.removeItem('guestbook_entries');
    } catch (e) {}
  }

  window.GuestbookStore = {
    newId, add, update, get, list, remove, syncAll, migrateLegacy,
    saveConfig, clearConfig, configSource, uploadImage,
    hasFirebaseConfig: () => !!getConfig(),
    isSyncReady: () => !!fb(),
    isStorageReady: () => !!storage()
  };
})();
