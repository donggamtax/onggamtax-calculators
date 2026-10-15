// 동감 세무회계 직원 전용 법령 검색 서버 (구글 Apps Script, 무료)
// - 직원 비밀번호 확인 후 12시간짜리 접속 토큰 발급
// - 법제처 Open API(국가법령정보센터) 검색·본문 조회 중계 (인증값 OC는 이 서버에만 보관)
// - 질문 내역은 이 스크립트가 붙어 있는 구글 시트의 "질문내역" 탭에 저장
//
// - 검색된 자료 원문을 구글 Gemini에 넘겨 결론·근거를 정리 (선택)
//
// 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값: LAW_OC, STAFF_PASSWORD, SESSION_SECRET
// AI 정리를 쓰려면 GEMINI_API_KEY 추가 (모델을 바꾸려면 GEMINI_MODEL, 기본 gemini-flash-latest)
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
      const res = UrlFetchApp.fetch(GEMINI_API + encodeURIComponent(p.GEMINI_MODEL || "gemini-flash-latest") + ":generateContent", {
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
function fetchDoc(item, p) {
  const key = String(item.kind || ""), id = String(item.id || "");
  if (key === "nts" && item.nid) return ntsDoc(String(item.nid));
  needOc(p);
  const params = { target: TARGETS[key].target };
  if (key === "law") {
    params.MST = id;
    if (/^\d{8}$/.test(String(item.efYd || ""))) { params.target = "eflaw"; params.efYd = item.efYd; }
  } else {
    params.ID = id;
  }
  const res = UrlFetchApp.fetch(lawUrl("lawService.do", params, p), { muteHttpExceptions: true });
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

function summarize(req, p) {
  if (!p.GEMINI_API_KEY) throw fail("AI 정리를 쓰려면 스크립트 속성에 GEMINI_API_KEY를 넣어 주세요.", 503);
  const question = String(req.question || "").trim().slice(0, 500);
  if (!question) throw fail("질문을 입력하세요.");
  const year = /^\d{4}$/.test(String(req.year || "")) ? String(req.year) : String(new Date().getFullYear());
  const items = (Array.isArray(req.items) ? req.items : []).filter(it => TARGETS[it.kind] && it.id).slice(0, 8);
  if (!items.length) throw fail("정리할 자료가 없습니다. 먼저 검색하세요.");

  const words = keywords(question);
  const docs = items.map((it, i) => {
    let text = "";
    try {
      const data = fetchDoc(Object.assign({}, it, { efYd: it.kind === "law" ? year + "1231" : "" }), p);
      text = it.kind === "law" ? lawExcerpt(data, words) : flatText(data).slice(0, 7000);
    } catch (e) { text = ""; }
    return { ref: i + 1, kind: it.kind, label: TARGETS[it.kind].label, title: String(it.title || ""), number: String(it.number || ""), text: text };
  });
  const usable = docs.filter(d => d.text);
  if (!usable.length) throw fail("자료 원문을 불러오지 못해 정리할 수 없습니다.", 502);

  const material = usable.map(d => "[자료 " + d.ref + "] " + d.label + " · " + d.title + (d.number ? " (" + d.number + ")" : "") + "\n" + d.text).join("\n\n----\n\n");
  const system = [
    "너는 동감 세무회계 직원의 세법 검토를 돕는 보조자다.",
    "반드시 아래 [자료]에 적힌 내용만 근거로 답한다. 자료에 없는 조문·예규·결정례·판례를 지어내거나 기억으로 보태지 않는다.",
    "자료로 판단할 수 없는 부분은 '확인된 근거 없음'이라고 쓴다.",
    "조문은 법령명과 조·항·호를, 해석·결정례·판례는 문서번호와 일자를 밝힌다.",
    "귀속연도 " + year + "년 기준으로 판단한다. 한국어로, 결론을 먼저 쓴다.",
  ].join("\n");
  const schema = {
    type: "OBJECT",
    properties: {
      conclusion: { type: "STRING", description: "결론 한두 문장" },
      explanation: { type: "STRING", description: "근거를 들어 설명" },
      checks: { type: "ARRAY", items: { type: "STRING" }, description: "실무에서 추가로 확인할 점" },
      sources: { type: "ARRAY", items: { type: "OBJECT", properties: { ref: { type: "INTEGER" }, point: { type: "STRING" } }, required: ["ref", "point"] }, description: "근거로 쓴 자료 번호와 그 자료에서 쓴 내용" },
    },
    required: ["conclusion", "explanation", "checks", "sources"],
  };
  const model = p.GEMINI_MODEL || "gemini-flash-latest";
  const res = UrlFetchApp.fetch(GEMINI_API + encodeURIComponent(model) + ":generateContent", {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": p.GEMINI_API_KEY },
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: "[질문]\n" + question + "\n\n[자료]\n" + material }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema },
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let body = {};
  try { body = JSON.parse(res.getContentText("UTF-8")); } catch (e) {}
  if (code !== 200) {
    const msg = (body.error && body.error.message) || "";
    throw fail("Gemini 응답 오류(" + code + ")" + (msg ? ": " + msg.slice(0, 160) : ""), 502);
  }
  const text = (((body.candidates || [])[0] || {}).content || { parts: [] }).parts.map(x => x.text || "").join("");
  let ans;
  try { ans = JSON.parse(text); } catch (e) { throw fail("AI 답변을 읽지 못했습니다. 다시 시도해 주세요.", 502); }
  const byRef = {}; docs.forEach(d => byRef[d.ref] = d);
  return {
    question: question,
    year: year,
    conclusion: String(ans.conclusion || ""),
    explanation: String(ans.explanation || ""),
    checks: (ans.checks || []).map(String),
    sources: (ans.sources || []).filter(x => byRef[x.ref]).map(x => ({ ref: x.ref, point: String(x.point || ""), kind: byRef[x.ref].kind, label: byRef[x.ref].label, title: byRef[x.ref].title, number: byRef[x.ref].number })),
    used: docs.map(d => ({ ref: d.ref, label: d.label, title: d.title, number: d.number, ok: !!d.text })),
    model: model,
  };
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
