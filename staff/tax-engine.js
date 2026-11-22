/* 동감 세무회계 · 세액공제·감면 → 최저한세·농어촌특별세 계산 엔진
 * 화면(DOM)과 무관한 순수 계산만 담는다. 세금예측 메뉴(staff/clients.html)와 앞으로 만들 소득세 상담 테이블이 같이 쓴다.
 * 브라우저: window.TaxEngine / Node: require("./tax-engine.js")
 *
 * 근거(2026.11 현행 조문 확인)
 *  - 최저한세: 조세특례제한법 §132①(법인: 감면 전 과세표준 × 7%·8%·9% / 일반 10%·12%·17%)
 *              §132②(거주자 사업소득: 감면 전 사업소득 산출세액 × 35%(3천만원 이하분)·45%(초과분))
 *              §132①4가·②4가(100% 감면 과세연도의 창업감면 등은 최저한세 제외), §132③(대상 감면을 먼저 적용)
 *  - 사업소득 산출세액 = 종합소득산출세액 × 사업소득금액/종합소득금액 (국세청 소득세과-716, 2022.5.31)
 *  - 배제 순서: 조특령 §126⑤(세액공제 → 세액감면, 같은 호 안에서는 조문순서). 이 순서는 경정 시 규정이며 신고 때도 기본값으로 쓴다
 *  - 못 받은 세액공제 이월: 조특법 §144①(10년)
 *  - 농특세: 농어촌특별세법 §5①1(감면세액 × 20%), §2①1(세액공제 포함), 비과세 §4·시행령 §4⑦
 *  - 창업감면(§6)과 고용증대(§29의7)·통합고용(§29의8) 동시 적용 불가: 조특법 §127④ 단서(2025.1.1 이후 창업분부터, 부칙 법률 제20617호 §2)
 */
(function (root) {
  "use strict";

  // 이름으로 알아보는 감면·공제 목록. min: 최저한세 대상, nong: 농특세 과세 대상, art: 배제 순서용 조문번호
  // min === "nonSME" 이면 중소기업이 아닐 때만 최저한세 대상(§132①3 "제10조(중소기업이 아닌 자만 해당한다. 이하 이 조에서 같다)")
  var CATALOG = [
    { re: /통합\s*고용/, label: "통합고용세액공제", law: "조특법 §29의8", art: 29.08, kind: "공제", min: true, nong: true },
    { re: /고용\s*증대/, label: "고용증대세액공제", law: "조특법 §29의7", art: 29.07, kind: "공제", min: true, nong: true },
    { re: /사회\s*보험료/, label: "중소기업 사회보험료 세액공제", law: "조특법 §30의4", art: 30.04, kind: "공제", min: true, nong: false },
    { re: /창업/, label: "창업중소기업 등 세액감면", law: "조특법 §6", art: 6, kind: "감면", min: true, nong: false,
      note: "100% 감면받는 과세연도와 §6⑦ 추가감면분은 최저한세 제외(§132①4가·나, ②4가·나)" },
    { re: /중소기업\s*특별|특별\s*세액\s*감면/, label: "중소기업 특별세액감면", law: "조특법 §7", art: 7, kind: "감면", min: true, nong: false },
    { re: /연구|인력\s*개발|R&D/i, label: "연구·인력개발비 세액공제", law: "조특법 §10", art: 10, kind: "공제", min: "nonSME", nong: false },
    { re: /통합\s*투자/, label: "통합투자세액공제", law: "조특법 §24", art: 24, kind: "공제", min: true, nong: true },
    { re: /전자\s*신고/, label: "전자신고 세액공제", law: "조특법 §104의8", art: 104.08, kind: "공제", min: true, nong: false },
    { re: /성실\s*신고/, label: "성실신고확인비용 세액공제", law: "조특법 §126의6", art: 126.06, kind: "공제", min: false, nong: false },
    { re: /기장\s*세액/, label: "기장세액공제", law: "소득세법 §56의2", art: null, kind: "공제", min: false, nong: false },
    { re: /외국\s*납부/, label: "외국납부세액공제", law: "소득세법 §57 / 법인세법 §57", art: null, kind: "공제", min: false, nong: false },
    { re: /근로\s*소득|자녀|연금\s*계좌|특별\s*세액|표준\s*세액|혼인|월세|기부금\s*세액/, label: "소득세법상 세액공제", law: "소득세법 §59~§59의4", art: null, kind: "공제", min: false, nong: false }
  ];

  function won(v) { return Math.floor(v + 1e-6) } // 원 미만 버림(부동소수 오차 보정)

  function classify(name) {
    var s = String(name || "");
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].re.test(s)) return CATALOG[i];
    return null;
  }

  // 항목의 기본 성격(사용자가 체크로 바꾸지 않았을 때)
  function defaults(name, isSME) {
    var c = classify(name);
    if (!c) return { kind: /감면|면제/.test(String(name || "")) ? "감면" : "공제", min: false, nong: false, known: false, law: "", note: "" };
    return { kind: c.kind, min: c.min === "nonSME" ? !isSME : !!c.min, nong: !!c.nong, known: true, law: c.law, note: c.note || "", art: c.art };
  }

  // 법인세 최저한세율(§132①). sme: "sme"(중소기업 7%) | "g1"(졸업 후 3년 이내 8%) | "g2"(그 다음 2년 9%) | "gen"(일반)
  function corpMinTax(base, sme) {
    if (!(base > 0)) return 0;
    if (sme === "g1") return base * 0.08;
    if (sme === "g2") return base * 0.09;
    if (sme === "gen") {
      var t = Math.min(base, 1e10) * 0.10;
      if (base > 1e10) t += (Math.min(base, 1e11) - 1e10) * 0.12;
      if (base > 1e11) t += (base - 1e11) * 0.17;
      return t;
    }
    return base * 0.07;
  }
  // 소득세 최저한세(§132②): 사업소득 산출세액 3천만원 이하분 35%, 초과분 45%
  function indMinTax(bizTax) {
    if (!(bizTax > 0)) return 0;
    return Math.min(bizTax, 3e7) * 0.35 + Math.max(0, bizTax - 3e7) * 0.45;
  }

  /**
   * o = {
   *   isCorp, tax(산출세액), base(과세표준, 법인 최저한세용), bizShare(개인: 사업소득금액/종합소득금액, 기본 1),
   *   sme("sme"|"g1"|"g2"|"gen", 법인만), minOverride(최저한세액을 직접 적은 값, 없으면 null),
   *   items: [{ name, amt, kind:"감면"|"공제", min:bool, nong:bool, art(선택) }]
   * }
   */
  function compute(o) {
    var T = Math.max(0, +o.tax || 0), items = (o.items || []).map(function (it, i) {
      var x = { i: i, name: it.name || "", amt: Math.max(0, +it.amt || 0), kind: it.kind === "감면" ? "감면" : "공제", min: !!it.min, nong: !!it.nong,
        art: it.art != null ? it.art : (classify(it.name) || {}).art, allowed: 0, excluded: 0 };
      var c = classify(it.name);
      // 조특법 §144① 이월공제 대상 세액공제: 이름으로 알아본 조특법 공제이거나, 최저한세 대상 공제(§132 열거 공제는 모두 §144① 대상)
      x.carryable = x.kind === "공제" && ((c && /^조특법/.test(c.law)) || x.min);
      return x;
    });
    var share = o.isCorp ? 1 : (o.bizShare == null ? 1 : Math.max(0, Math.min(1, +o.bizShare || 0)));
    var bizTax = o.isCorp ? T : won(T * share);
    var minAuto = won(o.isCorp ? corpMinTax(+o.base || 0, o.sme || "sme") : indMinTax(bizTax));
    var minTax = o.minOverride != null ? Math.max(0, +o.minOverride) : minAuto;

    var subj = items.filter(function (x) { return x.min && x.amt > 0 });
    var subjSum = subj.reduce(function (s, x) { return s + x.amt }, 0);
    // 대상 감면 등은 감면 후 세액이 최저한세액 이상이 되는 만큼만 (개인은 사업소득분 산출세액 기준)
    var room = Math.max(0, Math.min(T, bizTax - minTax));
    var subjAllowed = Math.min(subjSum, room), cut = subjSum - subjAllowed;
    // 배제 순서: 세액공제 먼저, 다음 세액감면 / 같은 종류 안에서는 조문순서(모르면 입력 순서 뒤)
    var order = subj.slice().sort(function (a, b) {
      var ka = a.kind === "공제" ? 0 : 1, kb = b.kind === "공제" ? 0 : 1;
      if (ka !== kb) return ka - kb;
      var aa = a.art == null ? 1e9 + a.i : a.art, bb = b.art == null ? 1e9 + b.i : b.art;
      return aa - bb;
    });
    order.forEach(function (x) { var e = Math.min(x.amt, cut); x.excluded = e; x.allowed = x.amt - e; cut -= e });

    // 산출세액을 넘는 부분 정리: 감면 → 이월공제 안 되는 세액공제 → 이월공제 되는 세액공제 순으로 적용(법인세법 §59①, 소득세법 §60①)
    // 이월공제 되는 공제(조특법 §144①)를 맨 뒤에 두어 세액이 모자라면 그 공제가 먼저 다음 해로 넘어간다
    var left = T, rank = function (x) { return x.kind === "감면" ? 0 : x.carryable ? 2 : 1 };
    items.forEach(function (x) { if (!x.min) x.allowed = x.amt });
    items.filter(function (x) { return x.allowed > 0 }).sort(function (a, b) { return rank(a) - rank(b) || a.i - b.i })
      .forEach(function (x) { var a = Math.min(x.allowed, Math.max(0, left)); x.excluded += x.allowed - a; x.allowed = a; left -= a });

    var allowed = items.reduce(function (s, x) { return s + x.allowed }, 0);
    var nongBase = items.reduce(function (s, x) { return s + (x.nong ? x.allowed : 0) }, 0);
    var carry = items.reduce(function (s, x) { return s + (x.carryable ? x.excluded : 0) }, 0); // §144① 다음 해로 넘길 수 있는 공제
    return {
      bizTax: bizTax, share: share, minTax: minTax, minAuto: minAuto,
      subjSum: subjSum, subjAllowed: subjAllowed, minCut: subjSum - subjAllowed,
      allowed: allowed, dec: Math.max(0, T - allowed),
      nongBase: nongBase, nong: Math.floor(nongBase * 0.2),
      shortCut: items.reduce(function (s, x) { return s + x.excluded }, 0) - (subjSum - subjAllowed), // 세액이 모자라 못 받는 금액
      carry: carry, items: items
    };
  }

  // 창업감면 + 고용증대/통합고용 동시 입력 경고(§127④ 단서)
  function warnings(items) {
    var w = [], has = function (re) { return (items || []).some(function (x) { return re.test(x.name || "") && (+x.amt || 0) > 0 }) };
    if (has(/창업/) && has(/통합\s*고용|고용\s*증대/))
      w.push("창업감면(조특법 §6)과 고용증대·통합고용세액공제(§29의7·§29의8)를 함께 넣었습니다. 2025.1.1 이후 창업한 경우에는 동시에 받을 수 없습니다(§127④ 단서, 부칙 법률 제20617호 §2).");
    return w;
  }

  var api = { CATALOG: CATALOG, classify: classify, defaults: defaults, corpMinTax: corpMinTax, indMinTax: indMinTax, compute: compute, warnings: warnings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TaxEngine = api;
})(this);
