// 동감 세무회계 직원 전용 법령 검색 서버 (Cloudflare Workers 무료 요금제)
// - 직원 비밀번호 확인 후 12시간짜리 접속 토큰 발급
// - 법제처 Open API(국가법령정보센터) 검색·본문 조회 중계 (인증값 OC는 서버에만 보관)
// - 질문 내역 저장(KV): 질문자(직원)별 분류, 메모
//
// 필요한 비밀 값(wrangler secret): STAFF_PASSWORD, SESSION_SECRET, LAW_OC
// 필요한 KV 바인딩: HISTORY

const LAW_API = "https://www.law.go.kr/DRF";
const TOKEN_HOURS = 12;
const PEOPLE = ["이동희", "김혜빈", "김유리", "이연서"];

// 검색 대상. key는 화면에서 쓰는 이름, target은 법제처 Open API의 target 값.
const TARGETS = {
  law:   { target: "law",           label: "법령" },
  nts:   { target: "ntsCgmExpc",    label: "국세청 해석" },
  moef:  { target: "moefCgmExpc",   label: "기획재정부 해석" },
  tt:    { target: "ttSpecialDecc", label: "조세심판원" },
  expc:  { target: "expc",          label: "법제처 해석례" },
  prec:  { target: "prec",          label: "판례" },
};

const ALLOWED_ORIGINS = ["https://taxdg.com", "https://www.taxdg.com", "https://donggamtax.github.io"];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });

    try {
      if (url.pathname === "/api/login" && req.method === "POST") {
        const { password } = await req.json().catch(() => ({}));
        if (!env.STAFF_PASSWORD || !env.SESSION_SECRET) return json({ error: "서버 비밀번호가 아직 설정되지 않았습니다." }, 503);
        if (typeof password !== "string" || !(await safeEqual(password, env.STAFF_PASSWORD))) {
          await new Promise(r => setTimeout(r, 800)); // 연속 대입 늦추기
          return json({ error: "비밀번호가 맞지 않습니다." }, 401);
        }
        return json({ token: await signToken(env.SESSION_SECRET), hours: TOKEN_HOURS });
      }

      if (url.pathname === "/api/health") return json({ ok: true, oc: !!env.LAW_OC, kv: !!env.HISTORY });

      if (!(await checkToken(req, env))) return json({ error: "다시 로그인해 주세요." }, 401);

      if (url.pathname === "/api/search" && req.method === "GET") return json(await search(url, env));
      if (url.pathname === "/api/detail" && req.method === "GET") return json(await detail(url, env));

      if (url.pathname === "/api/history") {
        if (req.method === "GET") return json(await listHistory(env));
        if (req.method === "POST") return json(await saveHistory(env, await req.json()));
      }
      const m = url.pathname.match(/^\/api\/history\/([\w-]+)$/);
      if (m) {
        if (req.method === "PATCH") return json(await updateHistory(env, m[1], await req.json()));
        if (req.method === "DELETE") { await env.HISTORY.delete("q:" + m[1]); return json({ ok: true }); }
      }
      return json({ error: "없는 주소입니다." }, 404);
    } catch (e) {
      return json({ error: e.publicMessage || "처리 중 오류가 났습니다. 잠시 후 다시 시도하세요.", detail: String(e.message || e) }, e.status || 500);
    }
  },
};

// ── 법제처 Open API ──────────────────────────────────────────

function fail(msg, status = 400) { const e = new Error(msg); e.publicMessage = msg; e.status = status; return e; }

async function lawFetch(path, params, env) {
  if (!env.LAW_OC) throw fail("법제처 인증값(LAW_OC)이 아직 설정되지 않았습니다.", 503);
  const qs = new URLSearchParams({ OC: env.LAW_OC, type: "JSON", ...params });
  const res = await fetch(`${LAW_API}/${path}?${qs}`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  const text = await res.text();
  if (!res.ok) throw fail(`법제처 응답 오류(${res.status})`, 502);
  try { return JSON.parse(text); }
  catch { throw fail("법제처에서 알 수 없는 형식으로 응답했습니다. 인증값(OC)과 사용 신청한 API 종류를 확인하세요.", 502); }
}

// 응답 안에서 첫 번째 '객체 배열'을 찾는다 (대상마다 감싸는 키 이름이 달라서)
function findItems(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // 결과가 1건이면 배열이 아니라 객체 하나로 오는 경우가 있다
      const keys = Object.keys(v);
      if (keys.some(k => /일련번호|ID$/.test(k)) && depth > 0) return [v];
      const r = findItems(v, depth + 1); if (r) return r;
    }
  }
  return null;
}
function findTotal(obj) {
  for (const v of Object.values(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && v.totalCnt != null) return Number(v.totalCnt);
  }
  return null;
}
const pick = (o, re) => { const k = Object.keys(o).find(k => re.test(k)); return k ? String(o[k] ?? "").trim() : ""; };

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

async function search(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) throw fail("검색어를 입력하세요.");
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const kinds = (url.searchParams.get("kinds") || Object.keys(TARGETS).join(",")).split(",").filter(k => TARGETS[k]);
  const display = kinds.length === 1 ? 30 : 10;
  const groups = await Promise.all(kinds.map(async key => {
    try {
      const data = await lawFetch("lawSearch.do", { target: TARGETS[key].target, query: q, display: String(display), page: String(page) }, env);
      const items = (findItems(data) || []).map(it => normalize(key, it));
      return { kind: key, label: TARGETS[key].label, total: findTotal(data) ?? items.length, items };
    } catch (e) {
      return { kind: key, label: TARGETS[key].label, total: 0, items: [], error: e.publicMessage || "조회 실패" };
    }
  }));
  return { q, page, groups };
}

async function detail(url, env) {
  const key = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  if (!TARGETS[key] || !id) throw fail("잘못된 요청입니다.");
  const params = { target: TARGETS[key].target };
  if (key === "law") {
    params.MST = id;
    const ef = url.searchParams.get("efYd");
    if (ef && /^\d{8}$/.test(ef)) { params.target = "eflaw"; params.efYd = ef; }
    const jo = url.searchParams.get("jo");
    if (jo) params.JO = joCode(jo);
  } else {
    params.ID = id;
  }
  const data = await lawFetch("lawService.do", params, env);
  // 응답 안의 링크에 인증값이 섞여 나오지 않도록 가린다
  const safe = JSON.parse(JSON.stringify(data).split("OC=" + env.LAW_OC).join("OC=***"));
  return { kind: key, label: TARGETS[key].label, data: safe };
}

// "제89조", "89", "제10조의2" → 법제처 6자리 조문 코드(001002)
function joCode(s) {
  const m = String(s).match(/(\d+)\s*조?(?:\s*의\s*(\d+))?/);
  if (!m) return "";
  return m[1].padStart(4, "0") + (m[2] || "0").padStart(2, "0");
}

// ── 질문 내역 (KV) ───────────────────────────────────────────

function cleanRecord(b) {
  const s = (v, n) => String(v ?? "").slice(0, n);
  return {
    query: s(b.query, 300),
    person: PEOPLE.includes(b.person) ? b.person : "",
    note: s(b.note, 4000),
    picks: Array.isArray(b.picks) ? b.picks.slice(0, 20).map(p => ({ kind: s(p.kind, 10), id: s(p.id, 40), title: s(p.title, 200), number: s(p.number, 80) })) : [],
  };
}
async function saveHistory(env, body) {
  if (!env.HISTORY) throw fail("질문 내역 저장소(KV)가 연결되지 않았습니다.", 503);
  const rec = cleanRecord(body);
  if (!rec.query) throw fail("질문 내용이 비어 있습니다.");
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const item = { id, createdAt: new Date().toISOString(), ...rec };
  await env.HISTORY.put("q:" + id, JSON.stringify(item), { metadata: { createdAt: item.createdAt } });
  return item;
}
async function updateHistory(env, id, body) {
  const cur = await env.HISTORY.get("q:" + id, "json");
  if (!cur) throw fail("없는 질문입니다.", 404);
  const patch = cleanRecord({ ...cur, ...body });
  const item = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await env.HISTORY.put("q:" + id, JSON.stringify(item), { metadata: { createdAt: item.createdAt } });
  return item;
}
async function listHistory(env) {
  if (!env.HISTORY) return { items: [], warning: "질문 내역 저장소(KV)가 연결되지 않았습니다." };
  const keys = [];
  let cursor;
  do {
    const r = await env.HISTORY.list({ prefix: "q:", cursor, limit: 1000 });
    keys.push(...r.keys.map(k => k.name));
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor && keys.length < 2000);
  const items = (await Promise.all(keys.slice(-500).map(k => env.HISTORY.get(k, "json")))).filter(Boolean);
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return { items };
}

// ── 접속 토큰 (HMAC 서명) ─────────────────────────────────────

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([hmac("cmp", a), hmac("cmp", b)]);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
async function signToken(secret) {
  const exp = Date.now() + TOKEN_HOURS * 3600e3;
  return `${exp}.${await hmac(secret, String(exp))}`;
}
async function checkToken(req, env) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now() || !env.SESSION_SECRET) return false;
  return safeEqual(sig, await hmac(env.SESSION_SECRET, exp));
}
