// 동감 세무회계 직원 전용 서버 (구글 Apps Script, 무료)
// - 직원 이름 + 비밀번호 확인 후 12시간짜리 접속 토큰 발급 (토큰에 이름이 들어 있어 저장 기록에 남는다)
// - 업체별 기장 자료는 이 스크립트가 붙어 있는 구글 시트의 "업체", "업체자료", "수정이력" 탭에 저장
// - 안내문 템플릿·공지는 같은 시트의 탭에 저장 (BOARDS). 휴가 신청은 기존 구글 폼으로 연결 (LEAVE_FORM_URL)
//
// 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값:
//   SESSION_SECRET  아무 긴 문자열(30자 이상)
//   STAFF_PASSWORD  모두가 같이 쓰는 비밀번호 (STAFF_USERS가 없을 때만 쓰임)
//   STAFF_USERS     직원별 비밀번호. 한 줄에 "이름:비밀번호" (예: 홍길동:abc123). 직원마다 서로 다른 비밀번호여야 한다.
//                  로그인 화면에는 이름 칸이 없다: 비밀번호만 입력하면 그 비밀번호의 주인으로 들어간다.
// 이 파일에는 비밀 값을 적지 마세요.

const TOKEN_HOURS = 12;
// 직원 이름은 이 파일(공개 저장소)에 적지 않는다. 스크립트 속성 STAFF_USERS의 이름들이 곧 직원 명단이며, 요청마다 route()에서 채운다.
let PEOPLE = [];
const TZ = "Asia/Seoul";

// ── 입구 ─────────────────────────────────────────────────────

function doGet() {
  return out({ ok: true }); // 직원 수 등 내부 정보는 알려주지 않는다
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
  PEOPLE = Object.keys(parseUsers(p.STAFF_USERS));
  const action = String(req.action || "");
  if (action === "login") {
    if (!p.SESSION_SECRET) throw fail("서버 비밀번호가 아직 설정되지 않았습니다.", 503);
    const pw = typeof req.password === "string" ? req.password : "";
    const found = pw ? pwMatches(pw, p) : [];
    if (found.length !== 1) {
      loginDelay();
      if (found.length > 1) throw fail("같은 비밀번호를 쓰는 직원이 있어 구분할 수 없습니다. 관리자에게 문의하세요.", 409);
      throw fail("비밀번호가 맞지 않습니다.", 401);
    }
    const who = found[0];
    return { token: signToken(p.SESSION_SECRET, who), hours: TOKEN_HOURS, user: who, people: PEOPLE };
  }
  if (action === "guide.list") return guideList(req, p); // 고객용 비밀 링크: 로그인 없이 키만 맞으면 공개 글만 내려준다
  const session = checkToken(req.token, p.SESSION_SECRET);
  if (!session) throw fail("다시 로그인해 주세요.", 401);
  const who = session.user;

  switch (action) {
    case "config": return staffConfig(p);
    case "password.change": return passwordChange(req, who, p);
    case "board.list": return boardList(req);
    case "board.save": return boardSave(req, who);
    case "board.delete": return boardDelete(req);
    case "guide.upload": return guideUpload(req, who);
    case "progress.lists": return progressLists();
    case "progress.listSave": return progressListSave(req);
    case "progress.listDelete": return progressListDelete(req);
    case "progress.get": return progressGet(req);
    case "progress.save": return progressSave(req);
    case "progress.add": return progressAdd(req);
    case "progress.remove": return progressRemove(req);
    case "progress.import": return progressImport(req);
    case "progress.sync": return progressSync(req);
    case "leave.status": return leaveStatus(p);
    case "clients.load": return clientsLoad(req);
    case "template.save": return templateSave(req, who);
    case "clients.get": return clientsGet(req);
    case "clients.getMany": return clientsGetMany(req);
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
  guide: { sheet: "고객안내", fields: [["category", "분류", 20], ["title", "제목", 200], ["body", "내용", 20000], ["pub", "공개", 5], ["order", "순서", 6], ["pinned", "필독", 5], ["author", "작성자", 20]] },
  notice: { sheet: "공지매뉴얼", fields: [["type", "종류", 10], ["title", "제목", 200], ["body", "내용", 20000], ["pinned", "상단고정", 5], ["author", "작성자", 20]] },
};
// 로그인한 직원에게만 주는 설정. 휴가 신청 폼 주소는 공개 저장소에 두지 않고 스크립트 속성(LEAVE_FORM_URL)에 둔다.
function leaveSheetId(p) {
  const raw = String(p.LEAVE_SHEET_ID || "").trim(), m = raw.match(/\/d\/([A-Za-z0-9_-]+)/), id = m ? m[1] : raw;
  return /^[A-Za-z0-9_-]{20,}$/.test(id) ? id : "";
}
function staffConfig(p) {
  const u = String(p.LEAVE_FORM_URL || "").trim(), sid = leaveSheetId(p);
  return {
    guideKey: guideKeyOf(p), // 고객용 링크 주소 끝에 붙는 비밀 키(스크립트 속성 GUIDE_KEY)
    people: PEOPLE, // 직원 명단은 로그인한 사람에게만 알려준다(공개 소스에는 없음)
    leaveFormUrl: /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/.test(u) ? u : "",
    leaveSheetUrl: sid ? "https://docs.google.com/spreadsheets/d/" + sid + "/edit" : "", // 휴가대장 엑셀(구글 시트) 열기
  };
}
// 휴가 현황: 휴가대장 스프레드시트(스크립트 속성 LEAVE_SHEET_ID)의 '연차현황' 탭을 읽어 보여준다. 읽기만 한다.
function leaveStatus(p) {
  const id = leaveSheetId(p);
  if (!id) return { configured: false };
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
// ── 진도체크: 신고 종류별 신고리스트(예: 2026년 2기 예정 부가세)와 업체별 진행 기록 ──────────
// 시트 '진도목록' = 신고리스트 정의, 시트 '진도체크' = (리스트ID, 업체ID, 진행 기록 JSON). 업체명·구분·담당자는 업체 시트에서 화면이 실시간으로 가져온다.
const PL_SHEET = "진도목록", PR_SHEET = "진도체크";
const PR_FIELDS = { done: 1, prio: 1, diff: 1, work: 1, file: 1, appr: 1, deliv: 1, note: 1, mail: 1, fee: 1, paid: 1, tinv: 1 };
const PR_DATES = { work: 1, file: 1, appr: 1, deliv: 1, mail: 1, paid: 1, tinv: 1 };
function progSheet(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw fail("이 스크립트는 구글 시트의 확장 프로그램 → Apps Script에서 만들어야 합니다.", 503);
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(head); sh.setFrozenRows(1); }
  return sh;
}
function plSheet() { return progSheet(PL_SHEET, ["id", "제목", "종류", "연도", "기", "구분", "생성일시"]); }
function prSheet() { return progSheet(PR_SHEET, ["목록ID", "업체ID", "진행기록", "수정일시"]); }
function todayKst() { return Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd"); }
function plRows() {
  const sh = plSheet(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 7).getValues().filter(r => r[0]).map(r => ({ id: String(r[0]), title: String(r[1]), kind: String(r[2]), year: Number(r[3]) || 0, ki: Number(r[4]) || 0, sub: String(r[5] || "") }));
}
function plTitle(kind, year, ki, sub) {
  if (kind === "vat") return year + "년 " + ki + "기 " + sub + " 부가세 신고리스트";
  if (kind === "corp") return year + "년 법인세 신고리스트";
  return year + "년 종합소득세 신고리스트";
}
function progressLists() {
  const lists = plRows(), sh = prSheet(), last = sh.getLastRow(), cnt = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).getValues().forEach(r => {
    const id = String(r[0]); if (!id) return;
    const c = cnt[id] || (cnt[id] = { n: 0, work: 0, appr: 0, deliv: 0 });
    let d = {}; try { d = JSON.parse(String(r[2] || "{}")); } catch (e) {}
    c.n++; if (d.work) c.work++; if (d.appr) c.appr++; if (d.deliv) c.deliv++;
  });
  return { lists: lists.map(l => Object.assign(l, cnt[l.id] || { n: 0, work: 0, appr: 0, deliv: 0 })) };
}
function progressListSave(req) {
  const kind = String(req.kind || ""), year = Math.round(Number(req.year)), ki = Math.round(Number(req.ki) || 0), sub = String(req.sub || "");
  if (!/^(vat|corp|inc)$/.test(kind)) throw fail("신고 종류가 올바르지 않습니다.");
  if (!(year >= 2000 && year <= 2100)) throw fail("연도를 확인하세요.");
  if (kind === "vat" && !((ki === 1 || ki === 2) && /^(예정|확정)$/.test(sub))) throw fail("부가세는 1기/2기와 예정/확정을 고르세요.");
  return withLock(() => {
    const dup = plRows().filter(l => l.kind === kind && l.year === year && l.ki === (kind === "vat" ? ki : 0) && l.sub === (kind === "vat" ? sub : ""))[0];
    if (dup) throw fail("이미 있는 신고리스트입니다: " + dup.title);
    const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const k2 = kind === "vat" ? ki : 0, s2 = kind === "vat" ? sub : "";
    plSheet().appendRow([id, plTitle(kind, year, k2, s2), kind, year, k2, s2, new Date().toISOString()]);
    return { id: id, title: plTitle(kind, year, k2, s2), kind: kind, year: year, ki: k2, sub: s2 };
  });
}
function progressListDelete(req) {
  const id = String(req.id || "");
  return withLock(() => {
    const sh = plSheet(), row = findRow(sh, id);
    if (row) sh.deleteRow(row);
    const pr = prSheet(), last = pr.getLastRow();
    if (last >= 2) { const ids = pr.getRange(2, 1, last - 1, 1).getValues(); for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === id) pr.deleteRow(i + 2); }
    return { ok: true };
  });
}
function progressGet(req) {
  const id = String(req.list || ""), sh = prSheet(), last = sh.getLastRow(), rows = [];
  if (last >= 2) sh.getRange(2, 1, last - 1, 4).getValues().forEach(r => {
    if (String(r[0]) !== id) return;
    let d = {}; try { d = JSON.parse(String(r[2] || "{}")); } catch (e) {}
    rows.push({ clientId: Number(r[1]), data: d });
  });
  return { rows: rows };
}
function prFind(sh, listId, clientId) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const v = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < v.length; i++) if (String(v[i][0]) === listId && Number(v[i][1]) === clientId) return i + 2;
  return 0;
}
function prClean(patch) {
  const out = {};
  Object.keys(patch || {}).forEach(k => {
    if (!PR_FIELDS[k]) return;
    let v = String(patch[k] == null ? "" : patch[k]).slice(0, 500);
    if (PR_DATES[k] && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw fail("날짜 형식이 올바르지 않습니다.");
    out[k] = v; // JSON 문자열 안에 저장되므로(셀이 { 로 시작) 수식으로 해석되지 않는다
  });
  return out;
}
function prUpsert(listId, clientId, patch) {
  const sh = prSheet(), row = prFind(sh, listId, clientId), now = new Date().toISOString();
  if (!row) { const d = {}; Object.keys(patch).forEach(k => { if (patch[k] !== "") d[k] = patch[k]; }); sh.appendRow([listId, clientId, JSON.stringify(d), now]); return d; }
  let d = {}; try { d = JSON.parse(String(sh.getRange(row, 3, 1, 1).getValues()[0][0] || "{}")); } catch (e) {}
  Object.keys(patch).forEach(k => { if (patch[k] === "") delete d[k]; else d[k] = patch[k]; });
  sh.getRange(row, 3, 1, 2).setValues([[JSON.stringify(d), now]]);
  return d;
}
function prCheckList(id) { if (!plRows().some(l => l.id === id)) throw fail("없는 신고리스트입니다. 새로고침해 주세요.", 404); }
function progressSave(req) {
  const id = String(req.list || ""), cid = Math.round(Number(req.clientId));
  if (!(cid > 0)) throw fail("업체를 확인하세요.");
  const patch = prClean(req.patch);
  return withLock(() => { prCheckList(id); return { data: prUpsert(id, cid, patch) }; });
}
function progressAdd(req) {
  const id = String(req.list || ""), ids = (Array.isArray(req.ids) ? req.ids : []).slice(0, 1000).map(Number).filter(n => n > 0);
  return withLock(() => {
    prCheckList(id);
    const sh = prSheet(), last = sh.getLastRow(), have = {};
    if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(r => { if (String(r[0]) === id) have[Number(r[1])] = 1; });
    const add = ids.filter((n, i) => !have[n] && ids.indexOf(n) === i).map(n => [id, n, "{}", new Date().toISOString()]);
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add);
    return { added: add.length };
  });
}
function progressRemove(req) {
  const id = String(req.list || ""), cid = Math.round(Number(req.clientId));
  return withLock(() => { const sh = prSheet(), row = prFind(sh, id, cid); if (row) sh.deleteRow(row); return { ok: true }; });
}
function progressImport(req) {
  const id = String(req.list || ""), items = (Array.isArray(req.items) ? req.items : []).slice(0, 500);
  return withLock(() => {
    prCheckList(id);
    let n = 0;
    items.forEach(it => { const cid = Math.round(Number(it && it.clientId)); if (cid > 0) { prUpsert(id, cid, prClean(it.data)); n++; } });
    return { saved: n };
  });
}
// 업체별 기장의 신고 체크리스트(부가세) 결재란을 체크하면 같은 기수의 신고리스트에 날짜가 찍힌다.
// 작성자 결재 → 작업일, 대표세무사 결재 → 결재완료. 체크를 풀면 날짜도 지운다. 맞는 신고리스트가 없으면 아무것도 하지 않는다.
function progressSync(req) {
  const kind = String(req.kind || "vat"), year = Math.round(Number(req.year)), ki = Math.round(Number(req.ki) || 0), sub = String(req.sub || "");
  const cid = Math.round(Number(req.clientId)), field = req.which === "appr" ? "appr" : req.which === "work" ? "work" : "";
  if (!field || !(cid > 0)) throw fail("요청이 올바르지 않습니다.");
  return withLock(() => {
    const l = plRows().filter(x => x.kind === kind && x.year === year && x.ki === (kind === "vat" ? ki : 0) && x.sub === (kind === "vat" ? sub : ""))[0];
    if (!l) return { matched: false };
    const d = {}; d[field] = req.on ? todayKst() : "";
    return { matched: true, list: l.title, data: prUpsert(l.id, cid, d) };
  });
}

// ── 고객 안내 페이지(비밀 링크) ──────────────────────────────
const GUIDE_CACHE_KEY = "guide_v2";
function guideKeyOf(p) { const k = String(p.GUIDE_KEY || "").trim(); return /^[A-Za-z0-9_-]{16,64}$/.test(k) ? k : ""; }
function guideCacheClear() { try { CacheService.getScriptCache().remove(GUIDE_CACHE_KEY); } catch (e) {} }
function guideList(req, p) {
  const gk = guideKeyOf(p), k = typeof req.key === "string" ? req.key : "";
  if (!gk || !safeEqual(k, gk)) { loginDelay(); throw fail("링크가 올바르지 않습니다. 동감 세무회계로 문의해 주세요.", 403); }
  try { const hit = CacheService.getScriptCache().get(GUIDE_CACHE_KEY); if (hit) return JSON.parse(hit); } catch (e) {}
  const b = BOARDS.guide, sh = boardSheet(b, "guide"), last = sh.getLastRow();
  let items = [];
  if (last >= 2) {
    items = sh.getRange(2, 1, last - 1, b.fields.length + 3).getValues().filter(r => r[0]).map(r => boardRowToItem(b, r))
      .filter(it => it.pub === "Y")
      .map((it, i) => ({ id: it.id, category: it.category, title: it.title, body: it.body, updatedAt: it.updatedAt || it.createdAt, pinned: it.pinned === "Y" ? "Y" : "", o: Number(it.order) || 0, i: i }));
    items.sort((a, c) => ((c.pinned === "Y") - (a.pinned === "Y")) || (a.o - c.o) || (a.i - c.i));
    items.forEach(it => { delete it.o; delete it.i; });
  }
  const res = { items: items };
  try { const j = JSON.stringify(res); if (j.length < 90000) CacheService.getScriptCache().put(GUIDE_CACHE_KEY, j, 21600); } catch (e) {}
  return res;
}
// 그림 첨부: 직원 화면에서 줄여 보낸 JPEG/PNG를 구글 드라이브 폴더에 저장하고(링크를 아는 사람만 보기), 글 본문에는 [그림:파일ID]로 적는다.
// 드라이브 권한이 필요하므로 이 함수를 처음 쓸 때 스크립트 소유자가 권한을 한 번 허용해야 한다.
function guideFolder() {
  const sp = PropertiesService.getScriptProperties(), id = sp.getProperty("GUIDE_FOLDER");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName("동감_고객안내_그림"), f = it.hasNext() ? it.next() : DriveApp.createFolder("동감_고객안내_그림");
  sp.setProperty("GUIDE_FOLDER", f.getId());
  return f;
}
function guideUpload(req, who) {
  const mime = String(req.mime || "");
  if (!/^image\/(jpeg|png)$/.test(mime)) throw fail("JPG 또는 PNG 그림만 올릴 수 있습니다.");
  const b64 = typeof req.data === "string" ? req.data : "";
  if (!b64 || b64.length > 2200000) throw fail("그림이 너무 큽니다. 더 작은 그림을 올려 주세요.");
  const bytes = Utilities.base64Decode(b64);
  if (!bytes.length || bytes.length > 1600000) throw fail("그림이 너무 큽니다. 더 작은 그림을 올려 주세요.");
  const ext = mime === "image/png" ? "png" : "jpg";
  const file = guideFolder().createFile(Utilities.newBlob(bytes, mime, "guide-" + Date.now() + "." + ext));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: file.getId() };
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
  return { items: (req.board === "tpl" || req.board === "guide") ? items : items.reverse() }; // 템플릿은 시트 순서대로, 나머지는 최신 글이 위로
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
    if (key === "guide") guideCacheClear();
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
    if (key === "guide") guideCacheClear();
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
  o.periods.hist = histClean(cur && cur.periods && cur.periods.hist); // 수정 이력은 서버가 쌓은 것만 이어받는다(화면에서 보낸 값은 쓰지 않음)
  return o;
}
// 업체별 최근 수정 이력 5개: {at 시각, by 이름, t 내용}. 같은 사람이 10분 안에 이어서 고치면 한 줄로 합친다(자동 저장이 이력을 도배하지 않게)
const HIST_MAX = 5;
function histClean(h) {
  return (Array.isArray(h) ? h : []).slice(0, HIST_MAX).map(x => ({ at: String(x && x.at || "").slice(0, 30), by: String(x && x.by || "").slice(0, 20), t: String(x && x.t || "").slice(0, 120) })).filter(x => x.at);
}
function histPush(h, who, now, labels) {
  const list = histClean(h), text = labels.filter((v, i) => v && labels.indexOf(v) === i).join(", ") || "저장", top = list[0];
  if (top && top.by === who && new Date(now) - new Date(top.at) < 10 * 60e3) {
    const merged = (top.t ? top.t.split(", ") : []).concat(text.split(", ")).filter((v, i, a) => v && a.indexOf(v) === i).join(", ");
    list[0] = { at: now, by: who, t: merged.slice(0, 120) };
  } else list.unshift({ at: now, by: who, t: text.slice(0, 120) });
  return list.slice(0, HIST_MAX);
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

// 업체 목록·양식은 자주 읽고 드물게 바뀌므로 6시간 캐시한다. 업체/양식을 바꾸는 저장은 clCacheClear()로 비운다.
const CL_CACHE_KEY = "cl_light_v1";
function clCacheClear() { try { CacheService.getScriptCache().remove(CL_CACHE_KEY); } catch (e) {} }
function clientsLoad(req) {
  const light = !!(req && req.light);
  if (light) {
    try { const hit = CacheService.getScriptCache().get(CL_CACHE_KEY); if (hit) { const r = JSON.parse(hit); r.people = PEOPLE; return r; } } catch (e) {}
  }
  const res = clientsLoadRaw(req);
  if (light) { try { const j = JSON.stringify(res); if (j.length < 90000) CacheService.getScriptCache().put(CL_CACHE_KEY, j, 21600); } catch (e) {} }
  res.people = PEOPLE;
  return res;
}
function clientsLoadRaw(req) {
  const clients = clAll(clSheet(CL_SHEET, CL_COLS), CL_COLS.length).filter(r => r[0] !== "").map(clRowToItem);
  clients.forEach(c => { delete c.periods.hist; }); // 수정 이력은 업체를 열 때(get) 받는다: 목록을 가볍게
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
    clCacheClear();
    clLog(who, "", "기본 양식", "양식 수정: " + ({ vat: "부가세", inc: "소득세", corp: "법인세" })[kind]);
    return { ok: true, tpl: tpl };
  });
}
// 업체자료에서 한 업체의 줄만 읽는다(전체 내용을 읽지 않는다)
// 업체 자료 행 읽기: id 열만 먼저 읽고, 연속된 행은 한 번에 읽는다(행마다 따로 읽으면 느리다)
function clDataRowsFor(cd, idSet) {
  const last = cd.getLastRow();
  if (last < 2) return [];
  const keys = cd.getRange(2, 1, last - 1, 1).getValues(), runs = [];
  keys.forEach((k, i) => {
    if (!idSet[Number(k[0])]) return;
    const r = runs[runs.length - 1];
    if (r && r[1] === i + 1) r[1] = i + 2; else runs.push([i + 2, i + 2]);
  });
  let rows = [];
  runs.forEach(r => { rows = rows.concat(cd.getRange(r[0], 1, r[1] - r[0] + 1, CD_COLS.length).getValues()); });
  return rows;
}
function clDataItem(r) {
  let v = {}; try { v = JSON.parse(r[2] || "{}"); } catch (e) {}
  return { id: Number(r[0]), g: String(r[1]), v: v, by: String(r[3] || ""), at: iso(r[4]) };
}
function clDataRows(cd, id) { const m = {}; m[id] = 1; return clDataRowsFor(cd, m); }
function clientsGet(req) {
  const id = Number(req.id);
  const c = clAll(clSheet(CL_SHEET, CL_COLS), CL_COLS.length).filter(r => Number(r[0]) === id).map(clRowToItem)[0];
  if (!c) throw fail("없는 업체입니다.", 404);
  return { client: c, data: clDataRows(clSheet(CD_SHEET, CD_COLS), id).map(clDataItem) };
}
// 여러 업체를 한 번에: 화면이 열린 뒤 뒤에서 조금씩 받아 두어, 업체를 열 때 기다리지 않게 한다
function clientsGetMany(req) {
  const ids = (Array.isArray(req.ids) ? req.ids : []).slice(0, 40).map(Number).filter(n => n > 0), set = {};
  ids.forEach(i => { set[i] = 1; });
  const items = {}, cl = clAll(clSheet(CL_SHEET, CL_COLS), CL_COLS.length).filter(r => set[Number(r[0])]).map(clRowToItem);
  cl.forEach(c => { items[c.id] = { client: c, data: [] }; });
  clDataRowsFor(clSheet(CD_SHEET, CD_COLS), set).map(clDataItem).forEach(d => { if (items[d.id]) items[d.id].data.push(d); });
  return { items: Object.keys(items).map(k => items[k]) };
}

function clientsAdd(req, who) {
  return withLock(() => {
    const sh = clSheet(CL_SHEET, CL_COLS);
    const o = clMeta(req.meta);
    const ids = clAll(sh, 1).map(r => Number(r[0]) || 0);
    const id = (ids.length ? Math.max.apply(null, ids) : 0) + 1;
    const now = new Date().toISOString();
    o.periods.hist = [{ at: now, by: who, t: "업체 추가" }];
    sh.getRange(sh.getLastRow() + 1, 1, 1, CL_COLS.length).setValues([clRow(id, o, who, now)]);
    clLog(who, id, o.name, "업체 추가");
    clCacheClear();
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
    clCacheClear();
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
    const cdLast = cd.getLastRow();
    const cdRows = cdLast < 2 ? [] : cd.getRange(2, 1, cdLast - 1, 2).getValues(); // 업체id, 그룹만 읽는다
    const where = {}; cdRows.forEach((r, i) => { where[r[0] + "|" + r[1]] = i + 2; });
    const logs = [];
    let metaChanged = false;
    const append = [], del = [], hist = {};
    items.forEach(it => {
      const id = Number(it.id), ci = clRows.findIndex(r => Number(r[0]) === id);
      if (ci < 0) throw fail("없는 업체입니다. 새로고침해 주세요.", 404);
      const cur = clRowToItem(clRows[ci]);
      const changed = [];
      const o = clMeta(it.meta, cur);
      if (it.meta) { changed.push("업체 정보"); metaChanged = true; }
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
      o.periods.hist = histPush(o.periods.hist, who, now, changed.length ? changed : ["저장"]);
      hist[id] = o.periods.hist;
      cl.getRange(ci + 2, 1, 1, CL_COLS.length).setValues([clRow(id, o, who, now)]);
      clRows[ci] = clRow(id, o, who, now);
      logs.push([now, who, id, o.name, changed.join(", ") || "저장"]);
    });
    if (logs.length) { const ls = clSheet(LOG_SHEET, LOG_COLS); ls.getRange(ls.getLastRow() + 1, 1, logs.length, LOG_COLS.length).setValues(logs); }
    if (metaChanged) clCacheClear();
    if (append.length) cd.getRange(cd.getLastRow() + 1, 1, append.length, CD_COLS.length).setValues(append);
    del.sort((a, b) => b - a).forEach(r => cd.deleteRow(r));
    return { ok: true, by: who, at: now, hist: hist };
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
    clCacheClear();
    return { ok: true };
  });
}

// ── 접속 토큰 (HMAC 서명, 이름 포함) ──────────────────────────

function hmac(secret, msg) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret, Utilities.Charset.UTF_8)).replace(/=+$/, "");
}
// ── 직원이 직접 정하는 비밀번호: "직원비밀번호" 탭에 솔트와 해시만 저장한다 (비밀번호 원문은 저장하지 않는다)
const PW_SHEET = "직원비밀번호", PW_COLS = ["이름", "솔트", "해시", "변경일시"];
function pwHash(salt, pw) {
  let h = String(pw);
  for (let i = 0; i < 300; i++) h = hmac(salt, h);
  return h;
}
function pwRecord(name) {
  if (!name) return null;
  const sh = clSheet(PW_SHEET, PW_COLS), last = sh.getLastRow();
  if (last < 2) return null;
  const rows = sh.getRange(2, 1, last - 1, 3).getValues();
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]) === name) return { row: i + 2, salt: String(rows[i][1]), hash: String(rows[i][2]) };
  return null;
}
function pwCheck(rec, pw) { return !!rec && safeEqual(pwHash(rec.salt, pw), rec.hash); }
// 이 비밀번호를 쓰는 직원들의 이름 목록(정상이면 한 명). 직원이 직접 정한 비밀번호(시트)가 있으면 그것만, 없으면 스크립트 속성의 것을 본다.
// 직원이 없고 공용 비밀번호(STAFF_PASSWORD)만 있으면 이름 없는 로그인("")이 된다.
function pwMatches(pw, p) {
  const users = parseUsers(p.STAFF_USERS), names = Object.keys(users), hit = [], rec = {};
  const sh = clSheet(PW_SHEET, PW_COLS), last = sh.getLastRow();
  (last < 2 ? [] : sh.getRange(2, 1, last - 1, 3).getValues()).forEach(r => {
    const n = String(r[0]);
    if (names.indexOf(n) < 0) return; // 명단에 없는 이름의 기록은 무시한다
    rec[n] = 1;
    if (safeEqual(pwHash(String(r[1]), pw), String(r[2]))) hit.push(n);
  });
  names.forEach(n => { if (!rec[n] && safeEqual(pw, users[n])) hit.push(n); });
  if (!names.length && p.STAFF_PASSWORD && safeEqual(pw, p.STAFF_PASSWORD)) hit.push("");
  return hit;
}
// 비밀번호만으로 들어오므로 틀릴 때마다 조금씩 더 기다리게 한다(10분 동안의 실패 횟수 기준, 최대 6초)
function loginDelay() {
  let n = 1;
  try { const c = CacheService.getScriptCache(); n = Number(c.get("lf") || 0) + 1; c.put("lf", String(n), 600); } catch (e) {}
  Utilities.sleep(Math.min(1000 + n * 300, 6000));
}
function pwCurrentOk(name, pw, p) { return pwMatches(pw, p).indexOf(name) >= 0; }
function passwordChange(req, who, p) {
  if (!who) throw fail("직원 이름으로 로그인한 경우에만 비밀번호를 바꿀 수 있습니다.");
  const cur = typeof req.current === "string" ? req.current : "", next = typeof req.next === "string" ? req.next : "";
  if (next.length < 8 || next.length > 64) throw fail("새 비밀번호는 8자 이상 64자 이하로 정해 주세요.");
  if (next === cur) throw fail("새 비밀번호가 현재 비밀번호와 같습니다.");
  if (!pwCurrentOk(who, cur, p)) { loginDelay(); throw fail("현재 비밀번호가 맞지 않습니다.", 400); }
  if (pwMatches(next, p).length) throw fail("다른 비밀번호로 정해 주세요. 이 비밀번호는 쓸 수 없습니다."); // 비밀번호만으로 로그인하므로 서로 달라야 한다
  return withLock(() => {
    const salt = Utilities.getUuid ? Utilities.getUuid() : String(Math.random()), hash = pwHash(salt, next), now = new Date().toISOString();
    const sh = clSheet(PW_SHEET, PW_COLS), rec = pwRecord(who), vals = [[who, salt, hash, now]];
    if (rec) sh.getRange(rec.row, 1, 1, PW_COLS.length).setValues(vals); else sh.getRange(sh.getLastRow() + 1, 1, 1, PW_COLS.length).setValues(vals);
    clLog(who, "", "", "비밀번호 변경");
    return { ok: true };
  });
}
function safeEqual(a, b) {
  const x = hmac("cmp", a), y = hmac("cmp", b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
// 토큰 모양: 만료시각.직원이름(URL 인코딩).서명  (직원 명단이 바뀌어 이름이 없어지면 그 토큰은 무효)
function signToken(secret, user) {
  const exp = String(Date.now() + TOKEN_HOURS * 3600e3), n = encodeURIComponent(user || "").replace(/\./g, "%2E");
  return exp + "." + n + "." + hmac(secret, exp + "." + n);
}
function checkToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !secret || Number(parts[0]) < Date.now()) return null;
  if (!safeEqual(parts[2], hmac(secret, parts[0] + "." + parts[1]))) return null;
  let name = "";
  try { name = decodeURIComponent(parts[1]); } catch (e) { return null; }
  if (name && PEOPLE.indexOf(name) < 0) return null;
  return { user: name };
}

// 스크립트 편집기에서 한 번 실행하면 시트 탭을 만들고 권한 승인 창을 띄운다
function setup() {
  clSheet(CL_SHEET, CL_COLS); clSheet(CD_SHEET, CD_COLS); clSheet(LOG_SHEET, LOG_COLS); clSheet(TPL_SHEET, TPL_COLS);
  const p = props();
  Logger.log("SESSION_SECRET: " + (p.SESSION_SECRET ? "있음" : "없음") + " / STAFF_PASSWORD: " + (p.STAFF_PASSWORD ? "있음" : "없음") + " / STAFF_USERS: " + Object.keys(parseUsers(p.STAFF_USERS)).length + "명");
}
