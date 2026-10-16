// 동감 세무회계 직원 전용 서버 (구글 Apps Script, 무료)
// - 직원 이름 + 비밀번호 확인 후 12시간짜리 접속 토큰 발급 (토큰에 이름이 들어 있어 저장 기록에 남는다)
// - 업체별 기장 자료는 이 스크립트가 붙어 있는 구글 시트의 "업체", "업체자료", "수정이력" 탭에 저장
// - 안내문 템플릿·공지는 같은 시트의 탭에 저장 (BOARDS). 휴가 신청은 기존 구글 폼으로 연결 (LEAVE_FORM_URL)
//
// 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값:
//   SESSION_SECRET  아무 긴 문자열(30자 이상)
//   STAFF_PASSWORD  모두가 같이 쓰는 비밀번호 (STAFF_USERS가 없을 때만 쓰임)
//   STAFF_USERS     직원별 비밀번호. 한 줄에 "이름:비밀번호" (예: 이동희:abc123). 있으면 이 방식만 허용
// 이 파일에는 비밀 값을 적지 마세요.

const TOKEN_HOURS = 12;
const PEOPLE = ["이동희", "김혜빈", "김유리", "이연서"];
const TZ = "Asia/Seoul";

// ── 입구 ─────────────────────────────────────────────────────

function doGet() {
  const p = props();
  return out({ ok: true, password: !!p.STAFF_PASSWORD, users: Object.keys(parseUsers(p.STAFF_USERS)).length, secret: !!p.SESSION_SECRET });
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

// "이름:비밀번호" 줄 → { 이름: 비밀번호 }
function parseUsers(text) {
  const users = {};
  String(text || "").split(/\r?\n|,/).forEach(line => {
    const i = line.indexOf(":");
    if (i > 0) { const n = line.slice(0, i).trim(), pw = line.slice(i + 1).trim(); if (n && pw) users[n] = pw; }
  });
  return users;
}

function route(req) {
  const p = props();
  const action = String(req.action || "");
  if (action === "login") {
    if (!p.SESSION_SECRET) throw fail("서버 비밀번호가 아직 설정되지 않았습니다.", 503);
    const users = parseUsers(p.STAFF_USERS), names = Object.keys(users);
    const name = String(req.user || "").trim();
    const pw = typeof req.password === "string" ? req.password : "";
    let who = "";
    if (names.length) {
      // 직원별 비밀번호: 이름과 비밀번호가 둘 다 맞아야 한다
      const ok = names.indexOf(name) >= 0 && safeEqual(pw, users[name]);
      if (!ok) { Utilities.sleep(1000); throw fail("이름 또는 비밀번호가 맞지 않습니다.", 401); }
      who = name;
    } else {
      // 공용 비밀번호: 고른 이름은 기록용으로만 쓴다
      if (!p.STAFF_PASSWORD) throw fail("서버 비밀번호가 아직 설정되지 않았습니다.", 503);
      if (!safeEqual(pw, p.STAFF_PASSWORD)) { Utilities.sleep(1000); throw fail("비밀번호가 맞지 않습니다.", 401); }
      who = PEOPLE.indexOf(name) >= 0 ? name : "";
    }
    return { token: signToken(p.SESSION_SECRET, who), hours: TOKEN_HOURS, user: who };
  }
  const session = checkToken(req.token, p.SESSION_SECRET);
  if (!session) throw fail("다시 로그인해 주세요.", 401);
  const who = session.user;

  switch (action) {
    case "config": return staffConfig(p);
    case "board.list": return boardList(req);
    case "board.save": return boardSave(req, who);
    case "board.delete": return boardDelete(req);
    case "leave.status": return leaveStatus(p);
    case "clients.load": return clientsLoad(req);
    case "template.save": return templateSave(req, who);
    case "clients.get": return clientsGet(req);
    case "clients.save": return clientsSave(req, who);
    case "clients.add": return clientsAdd(req, who);
    case "clients.import": return clientsImport(req, who);
    case "clients.delete": return clientsDelete(req, who);
  }
  throw fail("없는 요청입니다.", 404);
}

function out(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function props() { return PropertiesService.getScriptProperties().getProperties(); }
function fail(msg, status) { const e = new Error(msg); e.publicMessage = msg; e.status = status || 400; return e; }
function iso(v) { return v instanceof Date ? v.toISOString() : String(v || ""); }

// ── 시트 공통 ────────────────────────────────────────────────

function findRow(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return 0;
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}


// ── 게시판: 자주 묻는 질문·안내문 템플릿·공지·휴가 신청 (구글 시트 탭) ──────────

const BOARDS = {
  tpl: { sheet: "안내문템플릿", fields: [["category", "분류", 40], ["title", "제목", 200], ["body", "내용", 8000], ["author", "작성자", 20]] },
  notice: { sheet: "공지매뉴얼", fields: [["type", "종류", 10], ["title", "제목", 200], ["body", "내용", 20000], ["pinned", "상단고정", 5], ["author", "작성자", 20]] },
};
// 로그인한 직원에게만 주는 설정. 휴가 신청 폼 주소는 공개 저장소에 두지 않고 스크립트 속성(LEAVE_FORM_URL)에 둔다.
function staffConfig(p) {
  const u = String(p.LEAVE_FORM_URL || "").trim();
  return { leaveFormUrl: /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/.test(u) ? u : "" };
}
// 휴가 현황: 휴가대장 스프레드시트(스크립트 속성 LEAVE_SHEET_ID)의 '연차현황' 탭을 읽어 보여준다. 읽기만 한다.
function leaveStatus(p) {
  const raw = String(p.LEAVE_SHEET_ID || "").trim(), m = raw.match(/\/d\/([A-Za-z0-9_-]+)/), id = m ? m[1] : raw;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return { configured: false };
  let ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) { throw fail("휴가대장 시트를 열지 못했습니다. 스크립트 소유자 계정에 그 시트의 접근 권한이 있는지 확인하세요.", 502); }
  const sh = ss.getSheetByName("연차현황");
  if (!sh) throw fail("휴가대장 시트에 '연차현황' 탭이 없습니다.", 502);
  const vals = sh.getDataRange().getDisplayValues();
  let hi = -1, asof = "";
  vals.forEach((r, i) => { if (r[0] === "기준일" && !asof) asof = String(r[1] || ""); if (hi < 0 && r[0] === "이름") hi = i; });
  if (hi < 0) throw fail("'연차현황' 탭에서 '이름' 머리글 줄을 찾지 못했습니다.", 502);
  const head = vals[hi].map(String), rows = [];
  for (let i = hi + 1; i < vals.length && String(vals[i][0]).trim() !== ""; i++) rows.push(vals[i].map(String));
  return { configured: true, asof: asof, head: head, rows: rows };
}
function boardOf(req) {
  const b = BOARDS[String(req.board || "")];
  if (!b) throw fail("없는 메뉴입니다.");
  return b;
}
function boardSheet(b, key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw fail("이 스크립트는 구글 시트의 확장 프로그램 → Apps Script에서 만들어야 합니다.", 503);
  let sh = ss.getSheetByName(b.sheet);
  if (!sh) {
    sh = ss.insertSheet(b.sheet);
    sh.appendRow(["id"].concat(b.fields.map(f => f[1]), ["작성일시", "수정일시"]));
    sh.setFrozenRows(1);
    if (key === "tpl") seedTemplates(sh);
  }
  return sh;
}
function boardRowToItem(b, r) {
  const it = { id: String(r[0]) };
  b.fields.forEach((f, i) => { it[f[0]] = r[i + 1] instanceof Date ? Utilities.formatDate(r[i + 1], "Asia/Seoul", "yyyy-MM-dd") : String(r[i + 1] == null ? "" : r[i + 1]); });
  const iso = v => v instanceof Date ? v.toISOString() : String(v || "");
  it.createdAt = iso(r[b.fields.length + 1]); it.updatedAt = iso(r[b.fields.length + 2]);
  return it;
}
function boardList(req) {
  const b = boardOf(req), sh = boardSheet(b, req.board);
  const last = sh.getLastRow();
  if (last < 2) return { items: [] };
  const rows = sh.getRange(2, 1, last - 1, b.fields.length + 3).getValues();
  const items = rows.filter(r => r[0]).map(r => boardRowToItem(b, r));
  return { items: req.board === "tpl" ? items : items.reverse() }; // 템플릿은 시트 순서대로, 나머지는 최신 글이 위로
}
function boardSave(req, who) {
  const b = boardOf(req), key = String(req.board);
  const src = req.item || {};
  const t = (v, n) => { const x = String(v == null ? "" : v).slice(0, n); return /^[=+\-@]/.test(x) ? "'" + x : x; };
  return withLock(() => {
    const sh = boardSheet(b, key);
    const id = String(src.id || "");
    const row = id ? findRow(sh, id) : 0;
    if (id && !row) throw fail("없는 글입니다. 새로고침해 주세요.", 404);
    const cur = row ? boardRowToItem(b, sh.getRange(row, 1, 1, b.fields.length + 3).getValues()[0]) : {};
    const it = { id: id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
    b.fields.forEach(f => { it[f[0]] = t(f[0] in src ? src[f[0]] : cur[f[0]], f[2]); });
    if (b.fields.some(f => f[0] === "author") && !it.author) it.author = who || "";
    if (!String(it[b.fields[1][0]]).trim()) throw fail("내용을 입력하세요.");
    const now = new Date().toISOString();
    const values = [it.id].concat(b.fields.map(f => it[f[0]]), [row ? cur.createdAt : now, row ? now : ""]);
    const at = row || sh.getLastRow() + 1;
    sh.getRange(at, 1, 1, values.length).setValues([values]);
    return boardRowToItem(b, values);
  });
}
function boardDelete(req) {
  const b = boardOf(req), key = String(req.board);
  withLock(() => {
    const sh = boardSheet(b, key);
    const row = findRow(sh, String(req.id || ""));
    if (!row) return;
    sh.deleteRow(row);
  });
  return { ok: true };
}

// 처음 탭을 만들 때 넣는 안내문 초안 (사무소에 맞게 고쳐 쓰세요)
function seedTemplates(sh) {
  const now = new Date().toISOString();
  const T = [
    ["부가가치세", "부가세 신고 자료 요청", "안녕하세요, 동감 세무회계입니다.\n[기간] 부가가치세 신고를 위해 아래 자료를 [마감일]까지 보내 주세요.\n\n1. 홈택스 미발행분 매출 내역(현금 매출, 기타 매출)\n2. 종이 세금계산서·계산서 (매출·매입)\n3. 사업용 신용카드 외 카드 사용 내역 중 사업 관련분\n4. 현금영수증(지출증빙) 미등록분\n5. 수출 실적이 있으면 수출신고필증·외화입금 내역\n6. 고정자산 취득 내역(차량·기계 등)\n\n자료는 이메일이나 카카오톡으로 보내 주시면 됩니다. 감사합니다."],
    ["종합소득세", "종합소득세 신고 자료 요청", "안녕하세요, 동감 세무회계입니다.\n[연도] 귀속 종합소득세 신고를 위해 아래 자료를 [마감일]까지 보내 주세요.\n\n1. 사업소득 외 소득(근로·연금·기타·금융소득) 자료\n2. 사업용 경비 증빙(세금계산서·카드 외 지출, 인건비 지급 내역)\n3. 차량 관련 비용·운행 내역\n4. 기부금·보험료·의료비 등 공제 자료(해당 시)\n5. 가족 변동 사항(결혼·출생·부양가족)\n\n궁금한 점은 담당자에게 편하게 연락 주세요."],
    ["법인세", "법인세 결산 자료 요청", "안녕하세요, 동감 세무회계입니다.\n[사업연도] 법인세 결산을 위해 아래 자료를 [마감일]까지 보내 주세요.\n\n1. 연말 기준 통장 잔액 증명(전 계좌)\n2. 차입금 잔액·이자 내역\n3. 재고자산 명세(기말 재고)\n4. 미수금·미지급금 내역\n5. 가지급금·가수금 발생 내역\n6. 주주 변동 내역(양도·증자 등)\n7. 고정자산 취득·처분 내역\n\n감사합니다."],
    ["원천세·4대보험", "신규 직원 입사 자료 요청", "안녕하세요, 동감 세무회계입니다.\n신규 직원 입사 처리를 위해 아래 내용을 보내 주세요.\n\n1. 성명, 주민등록번호, 입사일\n2. 월 급여(비과세 항목 포함), 근무 형태(정규·일용·프리랜서)\n3. 주 소정근로시간\n4. 근로계약서 사본\n\n4대보험 취득신고 기한이 있어 [회신 기한]까지 보내 주시면 감사하겠습니다."],
    ["원천세·4대보험", "직원 퇴사 자료 요청", "안녕하세요, 동감 세무회계입니다.\n직원 퇴사 처리를 위해 아래 내용을 보내 주세요.\n\n1. 성명, 퇴사일, 퇴사 사유\n2. 마지막 달 급여, 퇴직금 지급액·지급일\n\n감사합니다."],
    ["공통", "자료 수신 확인", "안녕하세요, 동감 세무회계입니다.\n보내 주신 자료 잘 받았습니다. 검토 후 추가로 필요한 자료가 있으면 다시 연락드리겠습니다. 감사합니다."],
    ["공통", "세액 안내", "안녕하세요, 동감 세무회계입니다.\n[세목] 신고가 완료되었습니다.\n\n납부할 세액: [금액]원\n납부 기한: [기한]\n가상계좌: [계좌]\n\n기한 안에 납부하지 않으면 납부지연가산세가 붙으니 꼭 확인 부탁드립니다. 감사합니다."],
  ];
  T.forEach((r, i) => sh.appendRow(["seed" + i, r[0], r[1], r[2], "", now, ""]));
}

// ── 업체별 기장 자료 (구글 시트 탭) ───────────────────────────
// 업체       : 업체 한 곳당 한 줄 (이름·구분·담당·기장/신고·상태·기간 목록)
// 업체자료   : 업체 × 그룹(기본정보, 부가세 회차별, 소득세 연도별, …) 한 줄, 내용은 JSON
// 수정이력   : 저장할 때마다 누가·언제·무엇을 고쳤는지 한 줄씩

const CL_SHEET = "업체", CD_SHEET = "업체자료", LOG_SHEET = "수정이력";
const CL_COLS = ["id", "업체명", "구분", "담당", "기장신고", "상태", "사유", "비고", "기간", "수정자", "수정일시"];
const CD_COLS = ["업체id", "그룹", "내용", "수정자", "수정일시"];
const LOG_COLS = ["일시", "수정자", "업체id", "업체명", "내용"];
const STATUS = ["거래중", "폐업", "이탈"];
const TPL_SHEET = "양식", TPL_COLS = ["종류", "내용", "수정자", "수정일시"];
const TPL_KINDS = ["vat", "inc", "corp"];
const GROUP_RE = /^(info|etc|(vat|inc|corp|tax)\|[A-Za-z0-9_-]{1,20})$/;
const CELL_MAX = 45000; // 구글 시트 셀 한도(5만 자)보다 조금 작게

function clSheet(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw fail("이 스크립트는 구글 시트의 확장 프로그램 → Apps Script에서 만들어야 합니다.", 503);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
    // 글자로만 저장해서 = + - 로 시작하는 내용이 수식으로 바뀌지 않게 한다
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat("@");
  }
  return sh;
}
function clAll(sh, n) {
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, n).getValues();
}
function clRowToItem(r) {
  let periods = {};
  try { periods = JSON.parse(r[8] || "{}"); } catch (e) {}
  return { id: Number(r[0]), name: String(r[1] || ""), type: String(r[2] || "개인"), owner: String(r[3] || ""), svc: String(r[4] || "기장"), status: String(r[5] || "거래중"), reason: String(r[6] || ""), tier: String(r[7] || ""), periods: periods, by: String(r[9] || ""), at: iso(r[10]) };
}
function clMeta(m, cur) {
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const m2 = Object.assign({}, cur || {}, m || {});
  const o = {
    name: s(m2.name, 100).trim(), type: m2.type === "법인" ? "법인" : "개인",
    owner: PEOPLE.indexOf(m2.owner) >= 0 ? m2.owner : "", svc: m2.svc === "신고" ? "신고" : "기장",
    status: STATUS.indexOf(m2.status) >= 0 ? m2.status : "거래중", reason: s(m2.reason, 200), tier: s(m2.tier, 40),
  };
  const per = m2.periods || {}, list = k => (Array.isArray(per[k]) ? per[k] : []).slice(0, 60).map(x => ({ id: s(x && x.id, 20).replace(/[^A-Za-z0-9_-]/g, ""), name: s(x && x.name, 60) })).filter(x => x.id);
  o.periods = { vps: list("vps"), ips: list("ips"), cps: list("cps"), tps: list("tps"), tf: per.tf ? 1 : 0, rep: s(per.rep, 40).trim() }; // tf: 면세사업자 표시
  if (!o.name) throw fail("업체명을 입력하세요.");
  return o;
}
function clRow(id, o, who, now) {
  return [id, o.name, o.type, o.owner, o.svc, o.status, o.reason, o.tier, JSON.stringify(o.periods), who, now];
}
function clLog(who, id, name, text) {
  const sh = clSheet(LOG_SHEET, LOG_COLS);
  sh.getRange(sh.getLastRow() + 1, 1, 1, LOG_COLS.length).setValues([[new Date().toISOString(), who, id, name, text]]);
}
function groupLabel(g) {
  if (g === "info") return "기본정보";
  const k = g.split("|");
  return ({ vat: "부가세", inc: "소득세", corp: "법인세", tax: "세금예측" }[k[0]] || "기타") + (k[1] ? "(" + k[1] + ")" : "");
}

function clientsLoad(req) {
  const clients = clAll(clSheet(CL_SHEET, CL_COLS), CL_COLS.length).filter(r => r[0] !== "").map(clRowToItem);
  // light: 업체 목록과 양식만(빠름). 업체별 자료는 업체를 열 때 clients.get으로 받는다.
  const data = (req && req.light) ? [] : clAll(clSheet(CD_SHEET, CD_COLS), CD_COLS.length).filter(r => r[0] !== "").map(r => {
    let v = {}; try { v = JSON.parse(r[2] || "{}"); } catch (e) {}
    return { id: Number(r[0]), g: String(r[1]), v: v, by: String(r[3] || ""), at: iso(r[4]) };
  });
  const templates = {};
  clAll(clSheet(TPL_SHEET, TPL_COLS), TPL_COLS.length).forEach(r => {
    if (TPL_KINDS.indexOf(String(r[0])) < 0) return;
    try { templates[String(r[0])] = JSON.parse(r[1] || "null"); } catch (e) {}
  });
  return { clients: clients, data: data, templates: templates };
}

// 기본 양식(체크리스트 항목) 저장: 모든 업체의 해당 양식이 한 번에 바뀐다
function tplClean(kind, t) {
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const id = v => s(v, 20).replace(/[^A-Za-z0-9_-]/g, "");
  if (!Array.isArray(t) || t.length > 200) throw fail("양식 형식이 올바르지 않습니다.");
  if (kind === "vat") {
    return t.map(x => ({ id: id(x && x.id), t: s(x && x.t, 300), h: s(x && x.h, 200), ph: s(x && x.ph, 40), k: ["deemed", "limit"].indexOf(x && x.k) >= 0 ? x.k : "" })).filter(x => x.id && x.t);
  }
  return t.map(g => ({
    g: s(g && g.g, 40),
    rows: (Array.isArray(g && g.rows) ? g.rows : []).slice(0, 200).map(r => ({ id: id(r && r.id), t: s(r && r.t, 300), n: s(r && r.n, 300) })).filter(r => r.id && r.t),
  })).filter(g => g.g && g.rows.length);
}
function templateSave(req, who) {
  const kind = String(req.kind || "");
  if (TPL_KINDS.indexOf(kind) < 0) throw fail("알 수 없는 양식입니다.");
  const tpl = tplClean(kind, req.tpl);
  if (!tpl.length) throw fail("항목이 하나도 없습니다.");
  const json = JSON.stringify(tpl);
  if (json.length > CELL_MAX) throw fail("양식이 너무 깁니다.");
  return withLock(() => {
    const sh = clSheet(TPL_SHEET, TPL_COLS), now = new Date().toISOString();
    const rows = clAll(sh, TPL_COLS.length);
    let at = -1;
    rows.forEach((r, i) => { if (String(r[0]) === kind) at = i; });
    const row = [kind, json, who, now];
    if (at >= 0) sh.getRange(at + 2, 1, 1, TPL_COLS.length).setValues([row]);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, TPL_COLS.length).setValues([row]);
    clLog(who, "", "기본 양식", "양식 수정: " + ({ vat: "부가세", inc: "소득세", corp: "법인세" })[kind]);
    return { ok: true, tpl: tpl };
  });
}
function clientsGet(req) {
  const id = Number(req.id);
  const c = clAll(clSheet(CL_SHEET, CL_COLS), CL_COLS.length).filter(r => Number(r[0]) === id).map(clRowToItem)[0];
  if (!c) throw fail("없는 업체입니다.", 404);
  const data = clAll(clSheet(CD_SHEET, CD_COLS), CD_COLS.length).filter(r => Number(r[0]) === id).map(r => {
    let v = {}; try { v = JSON.parse(r[2] || "{}"); } catch (e) {}
    return { id: id, g: String(r[1]), v: v, by: String(r[3] || ""), at: iso(r[4]) };
  });
  return { client: c, data: data };
}

function clientsAdd(req, who) {
  return withLock(() => {
    const sh = clSheet(CL_SHEET, CL_COLS);
    const o = clMeta(req.meta);
    const ids = clAll(sh, 1).map(r => Number(r[0]) || 0);
    const id = (ids.length ? Math.max.apply(null, ids) : 0) + 1;
    const now = new Date().toISOString();
    sh.getRange(sh.getLastRow() + 1, 1, 1, CL_COLS.length).setValues([clRow(id, o, who, now)]);
    clLog(who, id, o.name, "업체 추가");
    return { id: id, by: who, at: now };
  });
}

// 업체 여러 곳을 한꺼번에 넣는다. 이미 있는 업체명은 건너뛴다.
function clientsImport(req, who) {
  const items = Array.isArray(req.items) ? req.items.slice(0, 1000) : [];
  return withLock(() => {
    const sh = clSheet(CL_SHEET, CL_COLS);
    const rows = clAll(sh, CL_COLS.length);
    const names = {}; rows.forEach(r => { names[String(r[1]).trim()] = true; });
    let id = rows.reduce((m, r) => Math.max(m, Number(r[0]) || 0), 0);
    const now = new Date().toISOString(), add = [];
    let skipped = 0;
    items.forEach(m => {
      const o = clMeta(m);
      if (names[o.name]) { skipped++; return; }
      names[o.name] = true; id++;
      add.push(clRow(id, o, who, now));
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, CL_COLS.length).setValues(add);
    clLog(who, "", "", "업체 " + add.length + "곳 불러오기" + (skipped ? " (중복 " + skipped + "곳 건너뜀)" : ""));
    return { added: add.length, skipped: skipped };
  });
}

// items: [{ id, meta?, groups?: { 그룹: {키:값} 또는 null(삭제) } }]
function clientsSave(req, who) {
  const items = Array.isArray(req.items) ? req.items.slice(0, 20) : [];
  if (!items.length) return { ok: true };
  return withLock(() => {
    const cl = clSheet(CL_SHEET, CL_COLS), cd = clSheet(CD_SHEET, CD_COLS);
    const now = new Date().toISOString();
    const clRows = clAll(cl, CL_COLS.length);
    const cdRows = clAll(cd, CD_COLS.length);
    const where = {}; cdRows.forEach((r, i) => { where[r[0] + "|" + r[1]] = i + 2; });
    const append = [], del = [];
    items.forEach(it => {
      const id = Number(it.id), ci = clRows.findIndex(r => Number(r[0]) === id);
      if (ci < 0) throw fail("없는 업체입니다. 새로고침해 주세요.", 404);
      const cur = clRowToItem(clRows[ci]);
      const changed = [];
      const o = clMeta(it.meta, cur);
      if (it.meta) changed.push("업체 정보");
      Object.keys(it.groups || {}).forEach(g => {
        if (!GROUP_RE.test(g)) throw fail("저장할 수 없는 항목입니다.");
        const val = it.groups[g], key = id + "|" + g, row = where[key];
        if (val === null || (val && !Object.keys(val).length)) { if (row) del.push(row); delete where[key]; changed.push(groupLabel(g) + " 삭제"); return; }
        const clean = {};
        Object.keys(val || {}).slice(0, 500).forEach(k => { const v = String(val[k] == null ? "" : val[k]); if (v !== "") clean[String(k).slice(0, 80)] = v.slice(0, 20000); });
        const json = JSON.stringify(clean);
        if (json.length > CELL_MAX) throw fail("한 화면에 적은 내용이 너무 깁니다. 메모를 나눠 적거나 줄여 주세요. (" + groupLabel(g) + ")");
        const values = [id, g, json, who, now];
        if (row) cd.getRange(row, 1, 1, CD_COLS.length).setValues([values]); else append.push(values);
        changed.push(groupLabel(g));
      });
      cl.getRange(ci + 2, 1, 1, CL_COLS.length).setValues([clRow(id, o, who, now)]);
      clRows[ci] = clRow(id, o, who, now);
      clLog(who, id, o.name, changed.join(", ") || "저장");
    });
    if (append.length) cd.getRange(cd.getLastRow() + 1, 1, append.length, CD_COLS.length).setValues(append);
    del.sort((a, b) => b - a).forEach(r => cd.deleteRow(r));
    return { ok: true, by: who, at: now };
  });
}

function clientsDelete(req, who) {
  const id = Number(req.id);
  return withLock(() => {
    const cl = clSheet(CL_SHEET, CL_COLS), cd = clSheet(CD_SHEET, CD_COLS);
    const rows = clAll(cl, CL_COLS.length), i = rows.findIndex(r => Number(r[0]) === id);
    if (i < 0) return { ok: true };
    const name = String(rows[i][1] || "");
    cl.deleteRow(i + 2);
    const dr = clAll(cd, CD_COLS.length);
    for (let j = dr.length - 1; j >= 0; j--) if (Number(dr[j][0]) === id) cd.deleteRow(j + 2);
    clLog(who, id, name, "업체 삭제");
    return { ok: true };
  });
}

// ── 접속 토큰 (HMAC 서명, 이름 포함) ──────────────────────────

function hmac(secret, msg) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret, Utilities.Charset.UTF_8)).replace(/=+$/, "");
}
function safeEqual(a, b) {
  const x = hmac("cmp", a), y = hmac("cmp", b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
// 토큰 모양: 만료시각.직원번호.서명 (직원번호는 PEOPLE 순서, 모르면 x)
function signToken(secret, user) {
  const exp = String(Date.now() + TOKEN_HOURS * 3600e3), n = PEOPLE.indexOf(user) >= 0 ? String(PEOPLE.indexOf(user)) : "x";
  return exp + "." + n + "." + hmac(secret, exp + "." + n);
}
function checkToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !secret || Number(parts[0]) < Date.now()) return null;
  if (!safeEqual(parts[2], hmac(secret, parts[0] + "." + parts[1]))) return null;
  return { user: PEOPLE[Number(parts[1])] || "" };
}

// 스크립트 편집기에서 한 번 실행하면 시트 탭을 만들고 권한 승인 창을 띄운다
function setup() {
  clSheet(CL_SHEET, CL_COLS); clSheet(CD_SHEET, CD_COLS); clSheet(LOG_SHEET, LOG_COLS); clSheet(TPL_SHEET, TPL_COLS);
  const p = props();
  Logger.log("SESSION_SECRET: " + (p.SESSION_SECRET ? "있음" : "없음") + " / STAFF_PASSWORD: " + (p.STAFF_PASSWORD ? "있음" : "없음") + " / STAFF_USERS: " + Object.keys(parseUsers(p.STAFF_USERS)).length + "명");
}
