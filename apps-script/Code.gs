// 동감 세무회계 직원 전용 법령 검색 서버 (구글 Apps Script, 무료)
// - 직원 비밀번호 확인 후 12시간짜리 접속 토큰 발급
// - 법제처 Open API(국가법령정보센터) 검색·본문 조회 중계 (인증값 OC는 이 서버에만 보관)
// - 질문 내역은 이 스크립트가 붙어 있는 구글 시트의 "질문내역" 탭에 저장
//
// - 검색된 자료 원문을 구글 Gemini에 넘겨 결론·근거를 정리 (선택)
//
// 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값: LAW_OC, STAFF_PASSWORD, SESSION_SECRET
// AI 정리를 쓰려면 GEMINI_API_KEY 추가 (정리 모델은 기본 gemini-pro-latest, 바꾸려면 GEMINI_MODEL)
// 안내문 템플릿·공지는 이 시트의 탭에 저장된다 (BOARDS). 휴가 신청은 기존 구글 폼으로 연결 (LEAVE_FORM_URL)
// 이 파일에는 비밀 값을 적지 마세요.

const LAW_API = "https://www.law.go.kr/DRF";
const NTS_API = "https://taxlaw.nts.go.kr/action.do";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models/";
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
  return out({ ok: true, oc: !!p.LAW_OC, password: !!p.STAFF_PASSWORD, secret: !!p.SESSION_SECRET, gemini: !!p.GEMINI_API_KEY });
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
    case "summarize": return summarize(req, p);
    case "config": return staffConfig(p);
    case "board.list": return boardList(req);
    case "board.save": return boardSave(req);
    case "board.delete": return boardDelete(req);
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
    // 국세청 해석은 법제처가 본문을 주지 않아 국세법령정보시스템 문서 ID를 따로 챙긴다
    nid: ntsDocId(it),
    // 상세링크에는 인증값(OC)이 들어 있어 화면으로 보내지 않는다
  };
}
function ntsDocId(it) {
  for (const k of Object.keys(it)) {
    const m = String(it[k] == null ? "" : it[k]).match(/ntstDcmId=([\w-]+)/);
    if (m) return m[1];
  }
  return "";
}

function search(req, p) {
  needOc(p);
  const q = String(req.q || "").trim();
  if (!q) throw fail("검색어를 입력하세요.");
  const page = Math.max(1, Number(req.page) || 1);
  const kinds = String(req.kinds || Object.keys(TARGETS).join(",")).split(",").filter(k => TARGETS[k]);
  const display = kinds.length === 1 ? 30 : 10;
  // body=true면 법령을 법령명이 아니라 조문 내용에서 찾는다 (search=2)
  const params = (key, query, n, body) => Object.assign({ target: TARGETS[key].target, query: query, display: n, page: page }, key === "law" && body ? { search: 2 } : {});
  const responses = UrlFetchApp.fetchAll(kinds.map(key => ({ url: lawUrl("lawSearch.do", params(key, q, display), p), muteHttpExceptions: true })));
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

  // 법제처 검색은 입력한 글자를 통째로 찾기 때문에 문장으로 물으면 0건이 된다.
  // 0건인 종류는 질문에서 핵심어를 뽑아 하나씩 다시 찾고 합친다.
  const empty = groups.filter(g => !g.error && !g.items.length);
  let terms = [];
  if (page === 1 && empty.length && /\s/.test(q)) {
    const plan = searchPlan(q, p);
    terms = plan.terms;
    const fetchList = list => UrlFetchApp.fetchAll(list.map(j => ({ url: lawUrl("lawSearch.do", j.params, p), muteHttpExceptions: true })))
      .map((r, i) => { try { return (findItems(parseLaw(r)) || []).map(it => normalize(list[i].kind, it)); } catch (e) { return []; } });

    // 1차: 법령은 관련 법령 이름으로, 나머지는 가장 구체적인 핵심어 하나로 찾는다
    const first = [];
    empty.forEach(g => {
      if (g.kind === "law") {
        plan.laws.forEach(name => first.push({ g: g, kind: "law", name: name, params: params("law", name, 10, false) }));
        if (!plan.laws.length && terms[0]) first.push({ g: g, kind: "law", params: params("law", terms[0], 10, true) });
      } else if (terms[0]) {
        first.push({ g: g, kind: g.kind, params: params(g.kind, terms[0], display, false) });
      }
    });
    fetchList(first).forEach((items, i) => {
      const j = first[i];
      // 법령 이름 검색은 "법인세법" → 법인세법·시행령·시행규칙만 남긴다
      if (j.name) items = items.filter(it => it.title.replace(/\s/g, "").indexOf(j.name.replace(/\s/g, "")) === 0);
      items.forEach(it => { if (!j.g.items.some(x => x.id === it.id)) j.g.items.push(it); });
    });

    // 2차: 결과가 적은 종류만 다음 핵심어를 더한다
    const second = [];
    empty.forEach(g => {
      if (g.kind !== "law" && g.items.length < 5) terms.slice(1).forEach(t => second.push({ g: g, kind: g.kind, params: params(g.kind, t, display, false) }));
    });
    if (second.length) fetchList(second).forEach((items, i) => {
      const j = second[i];
      // 1차에서 찾은 게 있으면 흔한 단어로 딸려 온 엉뚱한 자료는 빼고, 가장 구체적인 핵심어가 제목에 있는 것만 더한다
      if (j.g.items.length) items = items.filter(it => it.title.indexOf(terms[0]) >= 0);
      items.forEach(it => { if (!j.g.items.some(x => x.id === it.id)) j.g.items.push(it); });
    });

    // 제목에 핵심어가 많이 들어간 자료를 위로 (같으면 원래 순서)
    empty.forEach(g => {
      if (g.kind !== "law") {
        const score = it => terms.reduce((n, t, k) => n + (it.title.indexOf(t) >= 0 ? (terms.length - k) * 2 : 0), 0);
        g.items = g.items.map((it, i) => ({ it: it, s: score(it), i: i })).sort((x, y) => y.s - x.s || x.i - y.i).map(x => x.it);
      }
      g.items = g.items.slice(0, display);
      g.total = g.items.length;
      if (g.items.length) g.note = "핵심어로 찾은 결과";
    });
    terms = plan.laws.concat(terms);
  }
  return { q: q, page: page, groups: groups, terms: terms };
}

// 질문 문장에서 관련 법령 이름과 검색 핵심어를 고른다. Gemini 키가 있으면 AI가, 없으면 단어 길이 순으로.
function searchPlan(q, p) {
  if (p.GEMINI_API_KEY) {
    try {
      // 검색어 고르기는 빠른 모델로 충분하다 (정리용 모델은 GEMINI_MODEL)
      const res = UrlFetchApp.fetch(GEMINI_API + encodeURIComponent(p.GEMINI_FAST_MODEL || "gemini-flash-latest") + ":generateContent", {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": p.GEMINI_API_KEY },
        payload: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: [
            "다음 세무 질문으로 국가법령정보센터를 검색하려고 한다.",
            "laws: 이 질문을 판단하는 데 직접 필요한 법률 이름 1~3개 (정식 명칭, 시행령·시행규칙 제외. 예: 법인세법, 국세기본법).",
            "terms: 국세청 해석·조세심판원 결정·판례 제목에 실제로 쓰일 검색어 1~3개. 가장 구체적인 것(서식명·제도명)을 먼저, '가산세'처럼 흔한 단어는 뒤에. 각 1~2단어.",
            "질문: " + q,
          ].join("\n") }] }],
          generationConfig: {
            temperature: 0, responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: { laws: { type: "ARRAY", items: { type: "STRING" } }, terms: { type: "ARRAY", items: { type: "STRING" } } }, required: ["laws", "terms"] },
          },
        }),
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() === 200) {
        const body = JSON.parse(res.getContentText("UTF-8"));
        const plan = JSON.parse(body.candidates[0].content.parts.map(x => x.text || "").join(""));
        const ok = a => (Array.isArray(a) ? a : []).map(t => String(t).trim()).filter(t => t.length >= 2 && t.length <= 30);
        const laws = ok(plan.laws).filter(t => /(법|령|규칙)$/.test(t)).slice(0, 3);
        const terms = ok(plan.terms).slice(0, 3);
        if (terms.length || laws.length) return { laws: laws, terms: terms };
      }
    } catch (e) {}
  }
  const stop = /^(리스크|위험|문제|경우|여부|관련|방법|어떻게|무엇|얼마|있는지|없는지|안하고|하고|했을|때|몇|년간|동안|방치|처리|법인|개인)$/;
  const verb = /(했|하|되|된|않|안|있|없)(을|는|고|때|면|서|다|지)|때$/;
  const seen = {};
  const terms = keywords(q).filter(w => !stop.test(w) && !verb.test(w) && !seen[w] && (seen[w] = 1)).sort((a, b) => b.length - a.length).slice(0, 3);
  // 질문에 법령 이름이 그대로 들어 있으면 그것을 쓴다
  const laws = keywords(q).filter(w => /[가-힣]{2,}(법|세법)$/.test(w)).slice(0, 2);
  return { laws: laws, terms: terms.filter(t => laws.indexOf(t) < 0) };
}

function detail(req, p) {
  const key = String(req.kind || "");
  if (!TARGETS[key] || !req.id) throw fail("잘못된 요청입니다.");
  return { kind: key, label: TARGETS[key].label, data: fetchDoc(req, p) };
}

// 자료 하나의 원문(JSON 객체)을 가져온다
// 법제처 원문 요청 변수 (국세청 해석은 별도 사이트라 null)
function docParams(item) {
  const key = String(item.kind || ""), id = String(item.id || "");
  if (key === "nts" && item.nid) return null;
  const params = { target: TARGETS[key].target };
  if (key === "law") {
    params.MST = id;
    if (/^\d{8}$/.test(String(item.efYd || ""))) { params.target = "eflaw"; params.efYd = item.efYd; }
  } else {
    params.ID = id;
  }
  return params;
}
// pre: 미리 동시에 받아 둔 응답 (없으면 여기서 받는다)
function fetchDoc(item, p, pre) {
  const key = String(item.kind || "");
  const params = docParams(item);
  if (!params) return ntsDoc(String(item.nid));
  needOc(p);
  const res = pre || UrlFetchApp.fetch(lawUrl("lawService.do", params, p), { muteHttpExceptions: true });
  let data;
  try { data = parseLaw(res); }
  catch (e) {
    // JSON을 주지 않는 자료는 XML로 한 번 더 받아 글자만 꺼낸다
    const xml = UrlFetchApp.fetch(lawUrl("lawService.do", Object.assign({}, params, { type: "XML" }), p), { muteHttpExceptions: true });
    const text = xml.getResponseCode() === 200 ? stripTags(xml.getContentText("UTF-8")) : "";
    if (!text || /<html|일치하는 (데이터|자료)가 없|인증|미신청/i.test(text.slice(0, 300))) {
      throw fail(key === "nts" ? "국세청 해석 원문을 불러오지 못했습니다. 국세법령정보시스템(taxlaw.nts.go.kr)에서 문서번호로 찾아보세요." : "이 자료는 법제처에서 원문을 제공하지 않습니다.", 502);
    }
    data = { 본문: text };
  }
  // 응답 안의 링크에 인증값이 섞여 나오지 않도록 가린다
  return JSON.parse(JSON.stringify(data).split("OC=" + p.LAW_OC).join("OC=***"));
}

// 국세청 법령해석 본문: 국세법령정보시스템 화면이 쓰는 요청을 그대로 보낸다 (공식 Open API가 아니어서 바뀔 수 있음)
function ntsDoc(nid) {
  const res = UrlFetchApp.fetch(NTS_API, {
    method: "post",
    payload: { actionId: "ASIQTB002PR01", paramData: JSON.stringify({ dcmDVO: { ntstDcmId: nid } }) },
    headers: { Referer: "https://taxlaw.nts.go.kr/" },
    muteHttpExceptions: true,
  });
  let body = null;
  try { body = JSON.parse(res.getContentText("UTF-8")); } catch (e) {}
  const r = body && body.data && body.data.ASIQTB002PR01;
  if (!r) throw fail("국세청 해석 원문을 불러오지 못했습니다. 국세법령정보시스템(taxlaw.nts.go.kr)에서 문서번호로 찾아보세요.", 502);
  const out = {};
  const main = (r.dcmHwpEditorDVOList || []).map(x => stripTags(x && x.dcmFleByte)).filter(Boolean).join("\n\n");
  if (main) out["본문"] = main;
  // 본문 파일이 비어 있는 옛 자료는 요지·회신 같은 글자 항목을 대신 보여 준다
  const dvo = r.dcmDVO || {};
  Object.keys(dvo).forEach(k => {
    const v = dvo[k];
    if (typeof v === "string" && stripTags(v).length >= 30 && !main) out["내용 " + (Object.keys(out).length + 1)] = stripTags(v);
  });
  if (!Object.keys(out).length) throw fail("국세청 해석 본문이 비어 있습니다. 국세법령정보시스템에서 확인하세요.", 502);
  return out;
}

function stripTags(s) {
  return String(s || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── AI 정리 (구글 Gemini) ─────────────────────────────────────

// AI가 법제처 검색·원문 열람을 직접 여러 번 하면서 근거를 모은 뒤 답한다 (Gemini 함수 호출)
const AI_MAX_TURNS = 5;
const AI_TIME_LIMIT_MS = 4 * 60 * 1000; // Apps Script 한 번 실행 한도(6분) 안에서 끝낸다
const DEFAULT_ANSWER_MODEL = "gemini-pro-latest";
const DEFAULT_RESEARCH_MODEL = "gemini-flash-latest";
const ANSWER_CACHE_SECONDS = 6 * 3600;

function cacheGet(key) { try { const v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cachePut(key, obj) { try { const v = JSON.stringify(obj); if (v.length < 90000) CacheService.getScriptCache().put(key, v, ANSWER_CACHE_SECONDS); } catch (e) {} }

// 조사는 빠른 모델이 법제처를 직접 찾아 읽고, 모은 원문으로 최종 답은 정리용 모델(기본 Pro)이 한 번에 쓴다
function summarize(req, p) {
  if (!p.GEMINI_API_KEY) throw fail("AI 정리를 쓰려면 스크립트 속성에 GEMINI_API_KEY를 넣어 주세요.", 503);
  needOc(p);
  const question = String(req.question || "").trim().slice(0, 1000);
  if (!question) throw fail("질문을 입력하세요.");
  const year = /^\d{4}$/.test(String(req.year || "")) ? String(req.year) : String(new Date().getFullYear());
  const started = Date.now();
  const answerModel = p.GEMINI_MODEL || DEFAULT_ANSWER_MODEL;
  const researchModel = p.GEMINI_FAST_MODEL || DEFAULT_RESEARCH_MODEL;

  const picks = (Array.isArray(req.items) ? req.items : []).filter(it => TARGETS[it.kind] && it.id).slice(0, 8);
  const cacheKey = "ans:" + hmac(p.SESSION_SECRET || "k", [answerModel, year, question, picks.map(x => x.kind + x.id).join(",")].join("|"));
  if (!req.fresh) {
    const hit = cacheGet(cacheKey);
    if (hit) return Object.assign(hit, { cached: true });
  }

  // 자료 손잡이(h1, h2 …) ↔ 실제 자료
  const reg = {}; let seq = 0;
  const handleOf = it => {
    const key = it.kind + ":" + it.id;
    for (const h in reg) if (reg[h].kind + ":" + reg[h].id === key) return h;
    const h = "h" + (++seq);
    reg[h] = { kind: it.kind, id: String(it.id), nid: it.nid || "", title: String(it.title || ""), number: String(it.number || ""), date: String(it.date || ""), label: TARGETS[it.kind].label };
    return h;
  };
  const texts = {}; const searches = [];
  const pickLines = picks.map(it => handleOf(it) + " · " + TARGETS[it.kind].label + " · " + (it.number ? it.number + " " : "") + it.title);

  const tools = [{ functionDeclarations: [
    { name: "search", description: "국가법령정보센터에서 자료 목록을 찾는다. 검색은 단순 단어 일치라서 1~2단어 짧은 용어로 찾아야 한다(문장 금지). 결과가 0건이면 다른 용어로 다시 찾는다.",
      parameters: { type: "OBJECT", properties: {
        kind: { type: "STRING", enum: Object.keys(TARGETS), description: "law=법령, nts=국세청 해석, moef=기획재정부 해석, tt=조세심판원 결정, expc=법제처 해석례, prec=법원 판례" },
        query: { type: "STRING", description: "짧은 검색어. 법령 이름 찾기면 '법인세법'처럼 정식 명칭" },
        in_text: { type: "BOOLEAN", description: "law에서만: true면 법령 이름이 아니라 조문 본문에서 찾는다" },
      }, required: ["kind", "query"] } },
    { name: "read", description: "search 결과의 자료 원문을 읽는다. 법령은 article로 특정 조문(예: '제119조', '제75조의2')을 읽거나, focus 단어가 많이 든 조문을 골라 읽는다.",
      parameters: { type: "OBJECT", properties: {
        handle: { type: "STRING", description: "search 결과의 handle (예: h3)" },
        article: { type: "STRING", description: "법령에서 읽을 조문 번호" },
        focus: { type: "STRING", description: "법령에서 조문을 고를 때 쓸 단어들(공백 구분)" },
      }, required: ["handle"] } },
    { name: "finish", description: "필요한 원문을 충분히 읽었으면 조사를 끝낸다. 답은 다른 담당이 쓰므로 여기서 답을 쓰지 않는다.", parameters: { type: "OBJECT", properties: {} } },
  ] }];
  const researchSystem = [
    "너는 동감 세무회계 직원의 세법 질문에 필요한 근거 자료를 찾아 읽어 모으는 조사 담당이다. 답을 쓰지 말고 도구로 자료만 모은다.",
    "[순서] 1) 쟁점에 걸리는 법률을 search(kind=law, 정식 명칭)로 찾고 read로 핵심 조문(의무·가산세·벌칙 규정 등)을 읽는다. 조문 번호를 모르면 focus 단어로 읽는다.",
    "2) 국세청 해석(nts)·조세심판원(tt)·판례(prec)를 쟁점 용어로 찾아 제목을 보고 관련 있는 2~4건을 읽는다. 0건이면 용어를 바꿔 다시 찾는다.",
    "3) 서로 관계없는 search·read는 한 번에 여러 개를 함께 호출해 시간을 줄인다. 원문 4건 이상 읽었으면 finish를 호출한다.",
  ].join("\n");
  const contents = [{ role: "user", parts: [{ text: "[질문]\n" + question + "\n귀속연도: " + year + (pickLines.length ? "\n\n[직원이 미리 담은 자료 — 먼저 읽어 볼 것]\n" + pickLines.join("\n") : "") }] }];

  const doSearches = calls => {
    const reqs = calls.map(c => {
      const kind = TARGETS[c.args.kind] ? c.args.kind : "law";
      const query = String(c.args.query || "").trim().slice(0, 40);
      const prm = { target: TARGETS[kind].target, query: query, display: 10, page: 1 };
      if (kind === "law" && c.args.in_text) prm.search = 2;
      return { kind: kind, query: query, req: { url: lawUrl("lawSearch.do", prm, p), muteHttpExceptions: true } };
    });
    const live = reqs.filter(r => r.query);
    const res = live.length ? UrlFetchApp.fetchAll(live.map(r => r.req)) : [];
    return reqs.map(r => {
      if (!r.query) return { error: "검색어가 비었습니다." };
      let items;
      try { items = (findItems(parseLaw(res[live.indexOf(r)])) || []).map(it => normalize(r.kind, it)); }
      catch (e) { return { error: e.publicMessage || "검색 실패" }; }
      searches.push(TARGETS[r.kind].label + ": " + r.query + " (" + items.length + "건)");
      if (!items.length) return { count: 0, hint: "0건입니다. 더 짧거나 다른 용어로 찾아보세요." };
      return { count: items.length, results: items.map(it => ({ handle: handleOf(it), title: it.title, number: it.number, date: it.date })) };
    });
  };
  const doReads = calls => {
    const jobs = calls.map(c => {
      const a = c.args, h = String(a.handle || ""), it = reg[h];
      if (!it) return { err: "없는 handle입니다. search 결과의 handle을 쓰세요." };
      const item = Object.assign({}, it, { efYd: it.kind === "law" ? year + "1231" : "" });
      return { a: a, h: h, it: it, item: item, params: docParams(item) };
    });
    const web = jobs.filter(j => j.params);
    const pre = web.length ? UrlFetchApp.fetchAll(web.map(j => ({ url: lawUrl("lawService.do", j.params, p), muteHttpExceptions: true }))) : [];
    return jobs.map(j => {
      if (j.err) return { error: j.err };
      let text = "";
      try {
        const data = fetchDoc(j.item, p, j.params ? pre[web.indexOf(j)] : null);
        if (j.it.kind === "law") text = j.a.article ? lawArticle(data, String(j.a.article)) : lawExcerpt(data, keywords(question + " " + (j.a.focus || "")));
        else text = flatText(data).slice(0, 9000);
      } catch (e) { return { error: e.publicMessage || "원문을 불러오지 못했습니다." }; }
      if (!text) return { error: j.a.article ? "그 조문을 찾지 못했습니다. focus로 다시 읽어 보세요." : "관련 조문을 찾지 못했습니다. article이나 다른 focus로 읽어 보세요." };
      texts[j.h] = (texts[j.h] ? texts[j.h] + "\n\n" : "") + text.slice(0, 12000);
      return { handle: j.h, title: j.it.title, number: j.it.number, chars: text.length, text: text.slice(0, 6000) };
    });
  };

  let done = false;
  for (let turn = 0; turn < AI_MAX_TURNS && !done; turn++) {
    const last = turn === AI_MAX_TURNS - 1 || Date.now() - started > AI_TIME_LIMIT_MS;
    if (last && Object.keys(texts).length) break;
    const body = callGemini(p, researchModel, {
      systemInstruction: { parts: [{ text: researchSystem }] },
      contents: contents,
      tools: tools,
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
      generationConfig: { temperature: 0.2 },
    });
    const content = ((body.candidates || [])[0] || {}).content;
    if (!content || !content.parts) break;
    contents.push(content); // 생각 서명 등 모델이 준 그대로 돌려줘야 한다
    const calls = content.parts.filter(x => x.functionCall).map(x => ({ name: x.functionCall.name, args: x.functionCall.args || {} }));
    if (!calls.length) { contents.push({ role: "user", parts: [{ text: "도구를 써서 조사를 이어가거나 finish를 호출하세요." }] }); continue; }
    if (calls.some(c => c.name === "finish")) { done = true; break; }
    const searchCalls = calls.filter(c => c.name === "search"), readCalls = calls.filter(c => c.name === "read");
    const sRes = doSearches(searchCalls), rRes = doReads(readCalls);
    const responses = calls.map(c => ({ functionResponse: { name: c.name, response: c.name === "search" ? sRes[searchCalls.indexOf(c)] : c.name === "read" ? rRes[readCalls.indexOf(c)] : { error: "없는 도구입니다." } } }));
    contents.push({ role: "user", parts: responses });
  }

  const handles = Object.keys(texts);
  if (!handles.length) throw fail("관련 원문을 찾지 못했습니다. 질문에 쓰인 용어를 바꾸거나 더 구체적으로 적어 다시 시도해 주세요.", 502);
  let budget = 90000;
  const material = handles.map(h => {
    const it = reg[h], t = texts[h].slice(0, Math.max(3000, Math.floor(budget / handles.length)));
    return "[" + h + "] " + it.label + " · " + (it.number ? it.number + " " : "") + it.title + (it.date ? " (" + it.date + ")" : "") + "\n" + t;
  }).join("\n\n----\n\n");

  const writerSystem = [
    "너는 동감 세무회계 직원의 세법 검토를 돕는 보조자다.",
    "반드시 아래 [자료]에 적힌 내용만 근거로 답한다. 자료에 없는 조문·예규·결정례·판례를 지어내거나 기억으로 보태지 않는다.",
    "자료로 판단할 수 없는 부분은 '확인된 근거 없음'이라고 쓴다.",
    "조문은 '법인세법 제119조 제1항'처럼 법령명과 조·항·호를, 해석·결정례·판례는 문서번호와 일자를 밝힌다.",
    "귀속연도 " + year + "년 기준으로 판단한다. 한국어로, 결론을 먼저 쓴다. 가산세·제척기간처럼 금액·기간이 걸린 쟁점은 계산 방법까지 적는다.",
    "설명은 실무자가 바로 쓸 수 있게 구체적으로 쓴다. sources의 handle은 [자료] 앞의 번호(h1 등)를 쓴다.",
  ].join("\n");
  const schema = {
    type: "OBJECT",
    properties: {
      conclusion: { type: "STRING", description: "결론 1~3문장" },
      explanation: { type: "STRING", description: "근거 조문·해석을 들어 단계별로 설명" },
      checks: { type: "ARRAY", items: { type: "STRING" }, description: "추가로 확인할 사실관계·쟁점" },
      sources: { type: "ARRAY", items: { type: "OBJECT", properties: { handle: { type: "STRING" }, point: { type: "STRING", description: "이 자료에서 근거로 쓴 내용(조문 번호 포함)" } }, required: ["handle", "point"] } },
    },
    required: ["conclusion", "explanation", "checks", "sources"],
  };
  const wb = callGemini(p, answerModel, {
    systemInstruction: { parts: [{ text: writerSystem }] },
    contents: [{ role: "user", parts: [{ text: "[질문]\n" + question + "\n\n[자료]\n" + material }] }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema },
  });
  let answer;
  try { answer = JSON.parse((((wb.candidates || [])[0] || {}).content.parts || []).map(x => x.text || "").join("")); }
  catch (e) { throw fail("AI 답변을 읽지 못했습니다. 다시 시도해 주세요.", 502); }

  const src = (answer.sources || []).filter(x => reg[x.handle] && texts[x.handle]).map(x => Object.assign({ handle: x.handle, point: String(x.point || "") }, reg[x.handle]));
  const result = {
    question: question,
    year: year,
    conclusion: String(answer.conclusion || ""),
    explanation: String(answer.explanation || ""),
    checks: (answer.checks || []).map(String),
    sources: src,
    searches: searches,
    read: handles.map(h => reg[h]),
    model: answerModel,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  cachePut(cacheKey, result);
  return result;
}

function callGemini(p, model, payload) {
  const res = UrlFetchApp.fetch(GEMINI_API + encodeURIComponent(model) + ":generateContent", {
    method: "post", contentType: "application/json", headers: { "x-goog-api-key": p.GEMINI_API_KEY },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  let body = {};
  try { body = JSON.parse(res.getContentText("UTF-8")); } catch (e) {}
  if (res.getResponseCode() === 404 && model === DEFAULT_ANSWER_MODEL) return callGemini(p, "gemini-flash-latest", payload); // 기본 모델 이름이 바뀐 경우
  if (res.getResponseCode() !== 200) {
    const msg = (body.error && body.error.message) || "";
    throw fail("Gemini 응답 오류(" + res.getResponseCode() + ")" + (msg ? ": " + msg.slice(0, 160) : ""), 502);
  }
  return body;
}

// 법령에서 조문 하나("제119조", "75조의2")를 꺼낸다
function lawArticle(data, art) {
  const m = art.match(/(\d+)\s*조?\s*(?:의\s*(\d+))?/);
  if (!m) return "";
  const units = asArr(findKey(data, "조문단위"));
  const u = units.find(x => String(x["조문번호"]) === m[1] && String(x["조문가지번호"] || "") === String(m[2] || "") && x["조문여부"] !== "전문");
  if (!u) return "";
  const info = findKey(data, "기본정보") || {};
  return (info["법령명_한글"] || "") + "\n" + stripTags(flatText(u));
}

function keywords(q) {
  return String(q).replace(/[^\w가-힣\s]/g, " ").split(/\s+/)
    .map(w => w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|인지|인가요|인가|할까요|하나요|되나요|되는지|하는지|여부)$/, ""))
    .filter(w => w.length >= 2);
}
// 법령 전문은 너무 길어서 질문 단어가 많이 들어간 조문만 추린다
function lawExcerpt(data, words) {
  const units = asArr(findKey(data, "조문단위"));
  if (!units.length) return flatText(data).slice(0, 7000);
  const info = findKey(data, "기본정보") || {};
  const name = info["법령명_한글"] || info["법령명한글"] || "";
  const arts = units.map(u => {
    const no = u["조문번호"] ? "제" + u["조문번호"] + "조" + (u["조문가지번호"] ? "의" + u["조문가지번호"] : "") : "";
    const text = stripTags(flatText(u));
    const score = words.reduce((n, w) => n + (text.split(w).length - 1), 0);
    return { no: no, text: text, score: score };
  }).filter(a => a.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  if (!arts.length) return "";
  return name + " (시행일 " + (info["시행일자"] || "") + ")\n" + arts.map(a => a.text.slice(0, 2500)).join("\n\n");
}
function flatText(o) {
  const out = [];
  (function walk(v) {
    if (v == null) return;
    if (typeof v === "string" || typeof v === "number") { const t = stripTags(String(v)); if (t.length > 1) out.push(t); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") Object.keys(v).forEach(k => { if (!/일련번호|ID$|코드$|링크|Link/i.test(k)) walk(v[k]); });
  })(o);
  return out.join("\n");
}
function asArr(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function findKey(o, key, depth) {
  depth = depth || 0;
  if (!o || typeof o !== "object" || depth > 5) return undefined;
  if (key in o) return o[key];
  for (const k of Object.keys(o)) { const r = findKey(o[k], key, depth + 1); if (r !== undefined) return r; }
  return undefined;
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
    picks: Array.isArray(b.picks) ? b.picks.slice(0, 20).map(x => ({ kind: s(x.kind, 10), id: s(x.id, 40), nid: s(x.nid, 60), title: s(x.title, 200), number: s(x.number, 80) })) : [],
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
  const items = rows.filter(r => r[0]).map(rowToItem).reverse(); // 같은 시각이면 아래 줄(나중 저장)이 위로
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
function boardSave(req) {
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
