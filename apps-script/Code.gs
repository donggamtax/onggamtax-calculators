// 동감 세무회계 직원 전용 법령 검색 서버 (구글 Apps Script, 무료)
// - 직원 비밀번호 확인 후 12시간짜리 접속 토큰 발급
// - 법제처 Open API(국가법령정보센터) 검색·본문 조회 중계 (인증값 OC는 이 서버에만 보관)
// - 질문 내역은 이 스크립트가 붙어 있는 구글 시트의 "질문내역" 탭에 저장
//
// 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값: LAW_OC, STAFF_PASSWORD, SESSION_SECRET
// 이 파일에는 비밀 값을 적지 마세요.

const LAW_API = "https://www.law.go.kr/DRF";
const TOKEN_HOURS = 12;
const PEOPLE = ["이동희", "김혜빈", "김유리", "이연서"];
const SHEET_NAME = "질문내역";
const COLUMNS = ["id", "작성일시", "질문", "질문자", "메모", "담은 자료", "수정일시"];

// 검색 대상. key는 화면에서 쓰는 이름, target은 법제처 Open API의 target 값.
const TARGETS = {
  law:  { target: "law",           label: "법령" },
  nts:  { target: "ntsCgmExpc",    label: "국세청 해석" },
  moef: { target: "moefCgmExpc",   label: "기획재정부 해석" },
  tt:   { target: "ttSpecialDecc", label: "조세심판원" },
  expc: { target: "expc",          label: "법제처 해석례" },
  prec: { target: "prec",          label: "판례" },
};

// ── 입구 ─────────────────────────────────────────────────────

function doGet() {
  const p = props();
  return out({ ok: true, oc: !!p.LAW_OC, password: !!p.STAFF_PASSWORD, secret: !!p.SESSION_SECRET });
}

// 화면은 모든 요청을 text/plain POST 한 번으로 보낸다 (브라우저 사전 확인 요청을 피하려고)
function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) {}
  try {
    return out(route(req));
  } catch (err) {
    return out({ error: err.publicMessage || "처리 중 오류가 났습니다. 잠시 후 다시 시도하세요.", status: err.status || 500 });
  }
}

function route(req) {
  const p = props();
  const action = String(req.action || "");
  if (action === "login") {
    if (!p.STAFF_PASSWORD || !p.SESSION_SECRET) throw fail("서버 비밀번호가 아직 설정되지 않았습니다.", 503);
    if (typeof req.password !== "string" || !safeEqual(req.password, p.STAFF_PASSWORD)) {
      Utilities.sleep(1000); // 연속 대입 늦추기
      throw fail("비밀번호가 맞지 않습니다.", 401);
    }
    return { token: signToken(p.SESSION_SECRET), hours: TOKEN_HOURS };
  }
  if (!checkToken(req.token, p.SESSION_SECRET)) throw fail("다시 로그인해 주세요.", 401);

  switch (action) {
    case "search": return search(req, p);
    case "detail": return detail(req, p);
    case "history.list": return listHistory();
    case "history.save": return saveHistory(req);
    case "history.update": return updateHistory(req);
    case "history.delete": return deleteHistory(req);
  }
  throw fail("없는 요청입니다.", 404);
}

function out(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function props() { return PropertiesService.getScriptProperties().getProperties(); }
function fail(msg, status) { const e = new Error(msg); e.publicMessage = msg; e.status = status || 400; return e; }

// ── 법제처 Open API ──────────────────────────────────────────

function lawUrl(path, params, p) {
  const all = Object.assign({ OC: p.LAW_OC, type: "JSON" }, params);
  return LAW_API + "/" + path + "?" + Object.keys(all).map(k => k + "=" + encodeURIComponent(all[k])).join("&");
}
function parseLaw(res) {
  const code = res.getResponseCode();
  if (code !== 200) throw fail("법제처 응답 오류(" + code + ")", 502);
  try { return JSON.parse(res.getContentText("UTF-8")); }
  catch (e) { throw fail("법제처에서 알 수 없는 형식으로 응답했습니다. 인증값(OC)과 사용 신청한 API 종류를 확인하세요.", 502); }
}
function needOc(p) { if (!p.LAW_OC) throw fail("법제처 인증값(LAW_OC)이 아직 설정되지 않았습니다.", 503); }

// 응답 안에서 첫 번째 '객체 배열'을 찾는다 (대상마다 감싸는 키 이름이 달라서)
function findItems(obj, depth) {
  depth = depth || 0;
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  const vals = Object.keys(obj).map(k => obj[k]);
  for (const v of vals) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  for (const v of vals) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // 결과가 1건이면 배열이 아니라 객체 하나로 오는 경우가 있다
      if (depth > 0 && Object.keys(v).some(k => /일련번호|ID$/.test(k))) return [v];
      const r = findItems(v, depth + 1); if (r) return r;
    }
  }
  return null;
}
function findTotal(obj) {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v) && v.totalCnt != null) return Number(v.totalCnt);
  }
  return null;
}
function pick(o, re) { const k = Object.keys(o).find(k => re.test(k)); return k ? String(o[k] == null ? "" : o[k]).trim() : ""; }

function normalize(key, it) {
  return {
    kind: key,
    label: TARGETS[key].label,
    id: pick(it, /^(법령일련번호|MST)$/) || pick(it, /일련번호$/) || pick(it, /^(ID|id)$/),
    lawId: pick(it, /^법령ID$/),
    title: pick(it, /^(법령명한글|사건명|안건명|제목|법령명)$/) || pick(it, /명$/),
    number: pick(it, /^(사건번호|청구번호|안건번호|해석례번호|법령구분명)$/),
    date: pick(it, /^(선고일자|의결일자|회신일자|해석일자|시행일자|공포일자)$/),
    org: pick(it, /^(법원명|해석기관명|재결청|소관부처명|질의기관명)$/),
    // 상세링크에는 인증값(OC)이 들어 있어 화면으로 보내지 않는다
  };
}

function search(req, p) {
  needOc(p);
  const q = String(req.q || "").trim();
  if (!q) throw fail("검색어를 입력하세요.");
  const page = Math.max(1, Number(req.page) || 1);
  const kinds = String(req.kinds || Object.keys(TARGETS).join(",")).split(",").filter(k => TARGETS[k]);
  const display = kinds.length === 1 ? 30 : 10;
  const responses = UrlFetchApp.fetchAll(kinds.map(key => ({
    url: lawUrl("lawSearch.do", { target: TARGETS[key].target, query: q, display: display, page: page }, p),
    muteHttpExceptions: true,
  })));
  const groups = kinds.map((key, i) => {
    try {
      const data = parseLaw(responses[i]);
      const items = (findItems(data) || []).map(it => normalize(key, it));
      const total = findTotal(data);
      return { kind: key, label: TARGETS[key].label, total: total == null ? items.length : total, items: items };
    } catch (e) {
      return { kind: key, label: TARGETS[key].label, total: 0, items: [], error: e.publicMessage || "조회 실패" };
    }
  });
  return { q: q, page: page, groups: groups };
}

function detail(req, p) {
  needOc(p);
  const key = String(req.kind || "");
  const id = String(req.id || "");
  if (!TARGETS[key] || !id) throw fail("잘못된 요청입니다.");
  const params = { target: TARGETS[key].target };
  if (key === "law") {
    params.MST = id;
    if (/^\d{8}$/.test(String(req.efYd || ""))) { params.target = "eflaw"; params.efYd = req.efYd; }
  } else {
    params.ID = id;
  }
  const data = parseLaw(UrlFetchApp.fetch(lawUrl("lawService.do", params, p), { muteHttpExceptions: true }));
  // 응답 안의 링크에 인증값이 섞여 나오지 않도록 가린다
  const safe = JSON.parse(JSON.stringify(data).split("OC=" + p.LAW_OC).join("OC=***"));
  return { kind: key, label: TARGETS[key].label, data: safe };
}

// ── 질문 내역 (구글 시트) ─────────────────────────────────────

function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw fail("이 스크립트는 구글 시트의 확장 프로그램 → Apps Script에서 만들어야 합니다.", 503);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(COLUMNS);
    sh.setFrozenRows(1);
  }
  return sh;
}
function rowToItem(r) {
  let picks = [];
  try { picks = JSON.parse(r[5] || "[]"); } catch (e) {}
  const iso = v => v instanceof Date ? v.toISOString() : String(v || "");
  return { id: String(r[0]), createdAt: iso(r[1]), query: String(r[2] || ""), person: String(r[3] || ""), note: String(r[4] || ""), picks: picks, updatedAt: iso(r[6]) };
}
function itemToRow(it) {
  return [it.id, it.createdAt, it.query, it.person, it.note, JSON.stringify(it.picks || []), it.updatedAt || ""];
}
function findRow(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}
function cleanRecord(b) {
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  // 셀 안에서 수식으로 읽히지 않도록 = + - @ 로 시작하면 앞에 작은따옴표를 붙인다
  const t = (v, n) => { const x = s(v, n); return /^[=+\-@]/.test(x) ? "'" + x : x; };
  return {
    query: t(b.query, 300),
    person: PEOPLE.indexOf(b.person) >= 0 ? b.person : "",
    note: t(b.note, 4000),
    picks: Array.isArray(b.picks) ? b.picks.slice(0, 20).map(x => ({ kind: s(x.kind, 10), id: s(x.id, 40), title: s(x.title, 200), number: s(x.number, 80) })) : [],
  };
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function listHistory() {
  const sh = sheet();
  const last = sh.getLastRow();
  if (last < 2) return { items: [] };
  const start = Math.max(2, last - 499);
  const rows = sh.getRange(start, 1, last - start + 1, COLUMNS.length).getValues();
  const items = rows.filter(r => r[0]).map(rowToItem);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: items };
}
function saveHistory(req) {
  const rec = cleanRecord(req);
  if (!rec.query) throw fail("질문 내용이 비어 있습니다.");
  const item = Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() }, rec);
  withLock(() => {
    const sh = sheet();
    sh.getRange(sh.getLastRow() + 1, 1, 1, COLUMNS.length).setValues([itemToRow(item)]);
  });
  return item;
}
function updateHistory(req) {
  const id = String(req.id || "");
  return withLock(() => {
    const sh = sheet();
    const row = findRow(sh, id);
    if (!row) throw fail("없는 질문입니다.", 404);
    const cur = rowToItem(sh.getRange(row, 1, 1, COLUMNS.length).getValues()[0]);
    const patch = {};
    ["query", "person", "note", "picks"].forEach(k => { if (k in req) patch[k] = req[k]; });
    const item = Object.assign({}, cur, cleanRecord(Object.assign({}, cur, patch)), { updatedAt: new Date().toISOString() });
    sh.getRange(row, 1, 1, COLUMNS.length).setValues([itemToRow(item)]);
    return item;
  });
}
function deleteHistory(req) {
  const id = String(req.id || "");
  withLock(() => {
    const sh = sheet();
    const row = findRow(sh, id);
    if (row) sh.deleteRow(row);
  });
  return { ok: true };
}

// ── 접속 토큰 (HMAC 서명) ─────────────────────────────────────

function hmac(secret, msg) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret, Utilities.Charset.UTF_8)).replace(/=+$/, "");
}
function safeEqual(a, b) {
  const x = hmac("cmp", a), y = hmac("cmp", b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
function signToken(secret) {
  const exp = String(Date.now() + TOKEN_HOURS * 3600e3);
  return exp + "." + hmac(secret, exp);
}
function checkToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !secret || Number(parts[0]) < Date.now()) return false;
  return safeEqual(parts[1], hmac(secret, parts[0]));
}

// 스크립트 편집기에서 한 번 실행하면 시트 탭을 만들고 권한 승인 창을 띄운다
function setup() {
  sheet();
  UrlFetchApp.fetch("https://www.law.go.kr", { muteHttpExceptions: true });
  const p = props();
  Logger.log("LAW_OC: " + (p.LAW_OC ? "있음" : "없음") + " / STAFF_PASSWORD: " + (p.STAFF_PASSWORD ? "있음" : "없음") + " / SESSION_SECRET: " + (p.SESSION_SECRET ? "있음" : "없음"));
}
