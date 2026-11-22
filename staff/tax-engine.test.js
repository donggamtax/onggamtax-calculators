// 실행: node staff/tax-engine.test.js  (세금예측 최저한세·농특세 계산 검증 예시)
var E = require("./tax-engine.js"), assert = require("assert");
function item(name, amt, isSME) { var d = E.defaults(name, isSME !== false); return { name: name, amt: amt, kind: d.kind, min: d.min, nong: d.nong } }
var n = 0; function t(label, fn) { fn(); n++; console.log("ok -", label) }

t("분류: 통합고용=최저O·농특O, 창업·중기특별=최저O·농특X, 사회보험료=농특X, 중소기업 R&D=최저X", function () {
  var a = E.defaults("통합고용세액공제", true), b = E.defaults("창업감면", true), c = E.defaults("중소기업특별세액감면", true);
  assert.deepStrictEqual([a.kind, a.min, a.nong], ["공제", true, true]);
  assert.deepStrictEqual([b.kind, b.min, b.nong], ["감면", true, false]);
  assert.deepStrictEqual([c.kind, c.min, c.nong], ["감면", true, false]);
  assert.strictEqual(E.defaults("사회보험료 세액공제", true).nong, false);
  assert.strictEqual(E.defaults("연구인력개발비 세액공제", true).min, false);
  assert.strictEqual(E.defaults("연구인력개발비 세액공제", false).min, true);
});

t("최저한세율: 개인 35%/45%, 법인 중소 7%·일반 10/12/17%", function () {
  assert.strictEqual(Math.round(E.indMinTax(19560000)), 6846000);
  assert.strictEqual(E.indMinTax(40000000), 3e7 * 0.35 + 1e7 * 0.45);
  assert.strictEqual(Math.round(E.corpMinTax(3e8, "sme")), 21000000);
  assert.strictEqual(Math.round(E.corpMinTax(2e11, "gen")), 1e9 + 9e10 * 0.12 + 1e11 * 0.17);
});

t("예시1 개인: 과표 1억, 통합고용 1,500만 + 중기특별감면 300만", function () {
  var r = E.compute({ isCorp: false, tax: 19560000, items: [item("통합고용세액공제", 15e6), item("중소기업특별세액감면", 3e6)] });
  assert.strictEqual(r.minTax, 6846000);
  assert.strictEqual(r.minCut, 5286000);           // 통합고용에서 먼저 배제(공제 → 감면 순)
  assert.strictEqual(r.items[0].allowed, 9714000);
  assert.strictEqual(r.items[1].allowed, 3000000);
  assert.strictEqual(r.dec, 6846000);
  assert.strictEqual(r.nong, 1942800);             // 9,714,000 × 20%
  assert.strictEqual(r.carry, 5286000);
});

t("예시2 법인(중소): 과표 3억(산출 4,000만), 창업감면 50% 2,000만 + 통합고용 1,000만", function () {
  var r = E.compute({ isCorp: true, tax: 4e7, base: 3e8, sme: "sme", items: [item("창업감면", 2e7), item("통합고용세액공제", 1e7)] });
  assert.strictEqual(r.minTax, 21e6);
  assert.strictEqual(r.minCut, 11e6);
  assert.strictEqual(r.items[1].allowed, 0);       // 통합고용 전액 배제 → 이월
  assert.strictEqual(r.items[0].allowed, 19e6);    // 창업감면 100만 배제
  assert.strictEqual(r.dec, 21e6);
  assert.strictEqual(r.nong, 0);
  assert.strictEqual(r.carry, 10e6);
  assert.strictEqual(E.warnings([{ name: "창업감면", amt: 1 }, { name: "통합고용세액공제", amt: 1 }]).length, 1);
});

t("예시3 법인: 창업감면 100%(최저한세 제외) 4,000만 + 통합고용 500만 → 감면 먼저, 공제는 이월", function () {
  var a = item("창업감면", 4e7); a.min = false;
  var r = E.compute({ isCorp: true, tax: 4e7, base: 3e8, items: [a, item("통합고용세액공제", 5e6)] });
  assert.strictEqual(r.items[0].allowed, 4e7);
  assert.strictEqual(r.items[1].allowed, 0);
  assert.strictEqual(r.dec, 0);
  assert.strictEqual(r.nong, 0);
  assert.strictEqual(r.carry, 5e6);
});

t("예시4 개인: 다른 종합소득이 있으면 사업소득분 산출세액만 최저한세 기준(소득세과-716)", function () {
  // 산출세액 2,000만, 사업소득 비율 60% → 사업소득분 1,200만 → 최저한세 420만
  var r = E.compute({ isCorp: false, tax: 2e7, bizShare: 0.6, items: [item("통합고용세액공제", 1e7)] });
  assert.strictEqual(r.bizTax, 12e6);
  assert.strictEqual(r.minTax, 4.2e6);
  assert.strictEqual(r.items[0].allowed, 7.8e6);
  assert.strictEqual(r.dec, 12.2e6);
  assert.strictEqual(r.nong, 1560000);
});

t("최저한세 미달 없음: 공제가 작으면 전액 적용", function () {
  var r = E.compute({ isCorp: true, tax: 4e7, base: 3e8, items: [item("통합고용세액공제", 5e6)] });
  assert.strictEqual(r.minCut, 0); assert.strictEqual(r.dec, 35e6); assert.strictEqual(r.nong, 1e6);
});
console.log(n + "개 통과");
