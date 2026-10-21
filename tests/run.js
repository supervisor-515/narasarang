/*
 * 계산 엔진 회귀 테스트 + 데이터·아이콘 검증 (의존성 없음)
 * 실행: node tests/run.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8'), sandbox);
const DATA = sandbox.window.DATA;
const Engine = require(path.join(ROOT, 'js/engine.js'));

let failed = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}

// 날짜·설정·기록을 고정한 엔진
function setup({ s = {}, ledger = [], date = '2026-10-15T12:00:00', tickets = 1, route = {} } = {}) {
  const st = { now: new Date(date).getTime(), tickets, route };
  const S = Object.assign({ cards: [], salary: null, savings: [], spend: {}, spendAt: {}, firstUse: {}, soldier: null, checks: {} }, s);
  Object.keys(S.spend).forEach((k) => { if (!S.spendAt[k]) S.spendAt[k] = date.slice(0, 7); });
  const E = Engine.create(DATA, { getS: () => S, getLedger: () => ledger, now: () => st.now, getInput: () => ({ tickets: st.tickets }), getRoute: () => st.route });
  return { E, S, ledger, setDate: (d) => { st.now = new Date(d).getTime(); }, setTickets: (n) => { st.tickets = n; }, setRoute: (r) => { st.route = r; } };
}
const B = (id) => { const b = DATA.BENEFITS.find((x) => x.id === id); assert(b, 'no benefit ' + id); return b; };
const tx = (date, card, amt, items) => ({ id: 't' + date + card + amt, ts: new Date(date).getTime(), card, amt, items });

console.log('추천 정확도');

test('일반 GS25 검색에 PX(해군마트) 혜택이 섞이지 않는다', () => {
  const { E } = setup({ s: { spend: { shinhan: 200000 } } });
  const found = E.search('GS25');
  assert(found.length > 0);
  assert(!found.some((b) => b.sector === 'px'), found.filter((b) => b.sector === 'px').map((b) => b.id).join());
  const best = E.bestOf(E.rank(found, 30000), 30000);
  assert(best && best.b.sector !== 'px');
});

test('‘해군마트’·‘PX’ 검색에는 PX 혜택이 나온다', () => {
  const { E } = setup();
  assert(E.search('해군마트').some((b) => b.id === 'shinhan-px'));
  assert(E.search('PX').some((b) => b.id === 'ibk-px-basic'));
});

test('IBK PX: 현역병 인정 정보가 없으면 확인 필요, 추천하지 않음', () => {
  const { E } = setup({ s: { cards: ['ibk'] } });
  const rows = E.rank(E.search('PX'), 200000);
  assert.strictEqual(rows.find((r) => r.b.id === 'ibk-px-basic').e.status, 'check');
  assert.strictEqual(E.bestOf(rows, 200000), null);
});

test('IBK PX: 현역병 아님이면 받을 수 없음', () => {
  const { E } = setup({ s: { cards: ['ibk'], soldier: false } });
  assert.strictEqual(E.evaluate(B('ibk-px-basic'), 200000).status, 'no');
});

test('IBK PX: IBK 적금 보유 시 인정, 20만원 → 기본 5만 + 특별 5만', () => {
  const { E } = setup({ s: { cards: ['ibk'], savings: ['ibk'] } });
  assert.strictEqual(E.evaluate(B('ibk-px-basic'), 200000).status, 'ok');
  const x = E.estimate(B('ibk-px-basic'), 200000);
  assert.strictEqual(x.v, 100000);
  assert.strictEqual(x.extra.v, 50000);
});

test('IBK PX: 기본 한도 소진이어도 특별할인이 남으면 사용 가능', () => {
  const ledger = [tx('2026-10-02T10:00:00', 'ibk', 100000, [{ b: 'ibk-px-basic', k: 'ibk-px-basic', v: 50000 }])];
  const { E } = setup({ s: { cards: ['ibk'], savings: ['ibk'] }, ledger });
  const e = E.evaluate(B('ibk-px-basic'), 200000);
  assert.strictEqual(e.status, 'ok', e.why.join());
  assert.strictEqual(E.estimate(B('ibk-px-basic'), 200000).v, 50000);
});

test('마이태그 미등록 쿠폰은 확인 필요', () => {
  const { E, S } = setup({ s: { cards: ['ibk'], savings: ['ibk'] } });
  assert.strictEqual(E.evaluate(B('ibk-coupon-kakaot'), 10000).status, 'check');
  S.checks['mytag-kakaot'] = true;
  assert.strictEqual(E.evaluate(B('ibk-coupon-kakaot'), 10000).status, 'ok');
});

test('캐리비안베이 5만원 → 신한 30% 15,000원 (놀이공원 50%와 분리)', () => {
  const { E } = setup({ s: { cards: ['shinhan'], spend: { shinhan: 300000 } } });
  assert.strictEqual(E.estimate(B('shinhan-caribbean'), 50000).v, 15000);
  assert(!E.search('캐리비안베이').some((b) => b.id === 'shinhan-park'));
});

test('하나 CU: 월 할인 5만원을 쓰면 더 할인하지 않음', () => {
  const ledger = [tx('2026-10-05T10:00:00', 'hana', 500000, [{ b: 'hana-cu', k: 'hana-cu', v: 50000 }])];
  const { E } = setup({ s: { cards: ['hana'] }, ledger });
  assert.strictEqual(E.evaluate(B('hana-cu'), 10000).status, 'no');
});

test('하나 CU: 국군의날은 30%', () => {
  const { E } = setup({ s: { cards: ['hana'] }, date: '2026-10-01T12:00:00' });
  assert.strictEqual(E.estimate(B('hana-cu'), 10000).v, 3000);
});

test('신한 CGV 10,000원짜리 2매(20,000원) → 8,000원 절감 (매수 입력)', () => {
  const { E } = setup({ s: { spend: { shinhan: 100000 } }, tickets: 2 });
  assert.strictEqual(E.estimate(B('shinhan-cgv'), 20000).v, 8000);
  assert.strictEqual(E.estimate(B('ibk-cgv'), 20000).v, 3000);
});

test('신한 CGV 6,000원 관람: 1매 15,000원 → 9,000원 절감, KB 35%보다 앞', () => {
  const { E } = setup({ s: { spend: { shinhan: 100000, kb: 100000 } } });
  assert.strictEqual(E.estimate(B('shinhan-cgv'), 15000).v, 9000);
  const rows = E.rank(E.search('CGV'), 15000);
  assert.strictEqual(E.bestOf(rows, 15000).b.id, 'shinhan-cgv');
});

test('메가커피: 계산 시점 요일로 평일 20%·주말 30%', () => {
  const env = setup({ s: { cards: ['ibk'] }, date: '2026-10-11T12:00:00' }); // 일요일
  assert.strictEqual(env.E.estimate(B('ibk-mega'), 10000).v, 3000);
  env.setDate('2026-10-12T12:00:00'); // 월요일
  assert.strictEqual(env.E.estimate(B('ibk-mega'), 10000).v, 2000);
});

test('신한 PX 매월 10일: 3만원 미만 50%, 일 1회 최대 1천원 (기본 PX와 같은 한도)', () => {
  const env = setup({ s: { cards: ['shinhan'] }, date: '2026-10-10T12:00:00' });
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 1000).v, 500);
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 2000).v, 1000);
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 20000).v, 1000);
  assert.strictEqual(env.E.evaluate(B('shinhan-px'), 2000).status, 'ok');
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 50000).v, 10000); // 3만원 이상은 10일에도 20%
  env.setDate('2026-10-11T12:00:00');
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 2000).v, 400);
});

test('IBK PX 급여이체자 횟수는 급여이체 시작 다음 달부터 (이번 달 시작이면 현역병 횟수)', () => {
  const ledger = [1, 2].map((d) => tx(`2026-10-0${d}T12:00:00`, 'ibk', 50000, [{ b: 'ibk-px-basic', k: 'ibk-px-basic', v: 5000 }]));
  const now = setup({ s: { cards: ['ibk'], salary: 'ibk', since: { salary: '2026-10' } }, ledger });
  assert.strictEqual(now.E.evaluate(B('ibk-px-basic'), 50000).status, 'no'); // 월 2회 다 씀
  const before = setup({ s: { cards: ['ibk'], salary: 'ibk', since: { salary: '2026-09' } }, ledger });
  assert.strictEqual(before.E.evaluate(B('ibk-px-basic'), 50000).status, 'ok'); // 횟수 제한 없음
});

test('PX 3만원 경계: 하나 29,999원 → 일 5천 한도, 30,000원 → 20%', () => {
  const { E } = setup({ s: { cards: ['hana'] } });
  assert.strictEqual(E.estimate(B('hana-px'), 29999).v, 5000);
  assert.strictEqual(E.estimate(B('hana-px'), 30000).v, 6000);
});

test('남은 한도: 일 한도와 월 한도를 따로 계산 (하나 PX 12,990원·65,760원 결제 후)', () => {
  const ledger = [
    tx('2026-10-15T09:00:00', 'hana', 12990, [{ b: 'hana-px', k: 'hana-px', v: 3897 }]),
    tx('2026-10-15T10:00:00', 'hana', 65760, [{ b: 'hana-px', k: 'hana-px', v: 13152 }]),
  ];
  const { E } = setup({ s: { cards: ['hana'] }, ledger });
  const under = E.remaining(B('hana-px'), 29999);
  assert.deepStrictEqual([under.dRem, under.mRem], [1103, 6103]);
  const over = E.remaining(B('hana-px'), 30000);
  assert.deepStrictEqual([over.dRem, over.mRem], [6848, 86848]);
});

test('IBK 전월 25만원 이상이면 나라 편의점·사랑 교통 대신 All in One', () => {
  const { E } = setup({ s: { cards: ['ibk'], spend: { ibk: 300000 } } });
  assert.strictEqual(E.evaluate(B('ibk-store-nara'), 5000).status, 'no');
  assert.strictEqual(E.evaluate(B('ibk-transit-sarang'), 5000).status, 'no');
  assert.strictEqual(E.evaluate(B('ibk-aio-store'), 5000).status, 'ok');
  const low = setup({ s: { cards: ['ibk'], spend: { ibk: 200000 } } });
  assert.strictEqual(low.E.evaluate(B('ibk-store-nara'), 5000).status, 'ok');
});

test('IBK All in One 카페: 같은 날 두 번째는 불가', () => {
  const ledger = [tx('2026-10-15T09:00:00', 'ibk', 5000, [{ b: 'ibk-aio-cafe', k: 'ibk-aio-cafe', v: 500, pooled: true }])];
  const { E } = setup({ s: { cards: ['ibk'], spend: { ibk: 300000 } }, ledger });
  assert.strictEqual(E.evaluate(B('ibk-aio-cafe'), 5000).status, 'no');
});

test('IBK 맘스터치 쿠폰: 분기 1회', () => {
  const ledger = [tx('2026-10-02T09:00:00', 'ibk', 12000, [{ b: 'ibk-coupon-moms', k: 'ibk-coupon-moms', v: 1000 }])];
  const { E } = setup({ s: { cards: ['ibk'], savings: ['ibk'], checks: { 'mytag-moms': true } }, ledger });
  assert.strictEqual(E.estimate(B('ibk-coupon-moms'), 12000).v, 0);
  const next = setup({ s: { cards: ['ibk'], savings: ['ibk'], checks: { 'mytag-moms': true } }, ledger, date: '2027-01-05T12:00:00' });
  assert.strictEqual(next.E.estimate(B('ibk-coupon-moms'), 12000).v, 1000); // 다음 분기에는 다시 가능
});

test('IBK Npay: 2027년에는 기본 월 5회로 돌아감', () => {
  const items = (d) => [{ b: 'ibk-npay', k: 'ibk-npay', v: 1000, unit: 'point' }];
  const ledger = [1, 2, 3, 4, 5].map((d) => tx(`2027-01-0${d}T09:00:00`, 'ibk', 10000, items(d)));
  const { E } = setup({ s: { cards: ['ibk'], spend: { ibk: 1000000 } }, ledger, date: '2027-01-10T12:00:00' });
  assert.strictEqual(E.evaluate(B('ibk-npay'), 10000).status, 'no');
  const y26 = setup({ s: { cards: ['ibk'], spend: { ibk: 1000000 } }, ledger: [1, 2, 3, 4, 5].map((d) => tx(`2026-10-0${d}T09:00:00`, 'ibk', 10000, items(d))) });
  assert.strictEqual(y26.E.evaluate(B('ibk-npay'), 10000).status, 'ok');
});

test('신한 LG 연 10만P를 다 쓰면 더 적립 안 함', () => {
  const ledger = [tx('2026-03-01T09:00:00', 'shinhan', 10000000, [{ b: 'shinhan-lg', k: 'shinhan-lg', v: 100000, unit: 'point' }])];
  const { E } = setup({ s: { cards: ['shinhan'] }, ledger });
  assert.strictEqual(E.estimate(B('shinhan-lg'), 100000).v, 0);
});

test('신한 테마파크: 에버랜드 3회 써도 롯데월드는 가능', () => {
  const ledger = ['03', '05', '07'].map((m) => tx(`2026-${m}-01T10:00:00`, 'shinhan', 60000, [{ b: 'shinhan-park', k: 'shinhan-park', v: 30000 }]));
  const { E } = setup({ s: { cards: ['shinhan'], spend: { shinhan: 300000 } }, ledger });
  assert.strictEqual(E.evaluate(B('shinhan-park'), 60000).status, 'no');
  assert.strictEqual(E.evaluate(B('shinhan-park-lotte'), 60000).status, 'ok');
});

test('신한 CU 행사상품 5,000원 매장 결제: 500원 즉시할인 + 남은 4,500원의 20% 900원 = 1,400원', () => {
  // 기대값 유지, 조건만 명시: Life 편의점 캐시백은 오프라인 매장 결제만 (신한 상품설명서)
  const { E } = setup({ s: { cards: ['shinhan'], spend: { shinhan: 200000 } }, route: { channel: 'offline', promo: 'all' } });
  const x = E.estimate(B('shinhan-cu'), 5000);
  assert.strictEqual(x.v, 1400);
  assert.strictEqual(x.extra.v, 900);
  const best = E.bestOf(E.rank(E.search('CU'), 5000), 5000);
  assert.strictEqual(best.b.id, 'shinhan-cu');
});

test('신한 CU: 결제 경로를 모르면 Life 캐시백을 합산하지 않고 조건부로 분리, 포켓CU(앱)면 제외', () => {
  const env = setup({ s: { cards: ['shinhan'], spend: { shinhan: 200000 } } });
  let x = env.E.estimate(B('shinhan-cu'), 5000);
  assert.strictEqual(x.v, 500);
  assert.strictEqual(x.condExtra.v, 900);
  assert.deepStrictEqual(env.E.evaluate(B('shinhan-cu'), 5000).route.sort(), ['channel', 'promo']);
  env.setRoute({ channel: 'app', promo: 'all' }); // 포켓CU 결제
  x = env.E.estimate(B('shinhan-cu'), 5000);
  assert.strictEqual(x.v, 500);
  assert(!x.extra && !x.condExtra);
  assert.strictEqual(env.E.evaluate(B('shinhan-store'), 5000).status, 'no');
  env.setRoute({ promo: 'none' });
  assert.strictEqual(env.E.evaluate(B('shinhan-cu'), 5000).status, 'no');
  assert.strictEqual(setup({ route: { promo: 'none' } }).E.evaluate(B('hana-cu'), 5000).status, 'no');
});

test('급여이체는 이번 달 시작이면 다음 달부터 인정', () => {
  const { E } = setup({ s: { cards: ['hana'], salary: 'hana', since: { salary: '2026-10' } } });
  assert.strictEqual(E.evaluate(B('hana-taxi'), 10000).status, 'no');
  const prev = setup({ s: { cards: ['hana'], salary: 'hana', since: { salary: '2026-09' } } });
  assert.strictEqual(prev.E.evaluate(B('hana-taxi'), 10000).status, 'ok');
});

test('IBK 복무확인서는 제출 다음 달부터 현역병 인정', () => {
  const { E } = setup({ s: { cards: ['ibk'], checks: { 'ibk-proof': true }, since: { 'ibk-proof': '2026-10' } } });
  assert.strictEqual(E.evaluate(B('ibk-px-basic'), 20000).status, 'check');
  const prev = setup({ s: { cards: ['ibk'], checks: { 'ibk-proof': true }, since: { 'ibk-proof': '2026-09' } } });
  assert.strictEqual(prev.E.evaluate(B('ibk-px-basic'), 20000).status, 'ok');
});

test('포인트를 할인과 비교하지 않는 설정이면 포인트 혜택은 뒤로', () => {
  const { E, S } = setup({ s: { cards: ['ibk', 'shinhan'], spend: { ibk: 300000, shinhan: 200000 } } });
  S.pointValue = 0;
  const rows = E.rank([B('ibk-npay'), B('shinhan-coffee')], 10000);
  assert.strictEqual(rows[0].b.id, 'shinhan-coffee');
});

test('IBK 쇼핑·배달 월 2회 공유', () => {
  const ledger = [
    tx('2026-10-03T10:00:00', 'ibk', 20000, [{ b: 'ibk-aio-shop', k: 'ibk-aio-shop', v: 1000, pooled: true }]),
    tx('2026-10-04T10:00:00', 'ibk', 20000, [{ b: 'ibk-aio-delivery', k: 'ibk-aio-shop', v: 1000, pooled: true }]),
  ];
  const { E } = setup({ s: { cards: ['ibk'], spend: { ibk: 250000 } }, ledger });
  assert.strictEqual(E.evaluate(B('ibk-aio-delivery'), 20000).status, 'no');
});

test('통합한도가 남은 만큼만 할인', () => {
  const ledger = [tx('2026-10-03T10:00:00', 'hana', 50000, [{ b: 'hana-transit', k: 'hana-transit', v: 4000, pooled: true }])];
  const { E } = setup({ s: { cards: ['hana'], spend: { hana: 100000 } }, ledger });
  const x = E.estimate(B('hana-starbucks'), 20000); // 20% = 4,000원, 통합한도 5,000 중 1,000 남음
  assert.strictEqual(x.v, 1000);
});

test('결제 기록 취소(거래 삭제) 시 묶인 혜택 사용량이 함께 돌아온다', () => {
  const ledger = [tx('2026-10-02T10:00:00', 'ibk', 200000, [
    { b: 'ibk-px-basic', k: 'ibk-px-basic', v: 50000 }, { b: 'ibk-px-special', k: 'ibk-px-special', v: 50000 },
  ])];
  const { E } = setup({ s: { cards: ['ibk'], savings: ['ibk'] }, ledger });
  assert.strictEqual(E.estimate(B('ibk-px-basic'), 200000).v, 0);
  ledger.length = 0;
  assert.strictEqual(E.estimate(B('ibk-px-basic'), 200000).v, 100000);
});

test('신규 발급: IBK 첫 달은 실적 없이 All in One (통합한도 1만원)', () => {
  const { E } = setup({ s: { cards: ['ibk'], firstUse: { ibk: '2026-10' } } });
  assert.strictEqual(E.evaluate(B('ibk-aio-cafe'), 5000).status, 'ok');
  assert.strictEqual(E.cardLimit('ibk'), 10000);
});

test('신규 발급: KB는 통합한도 1만원, 대중교통은 제외', () => {
  const { E } = setup({ s: { cards: ['kb'], firstUse: { kb: '2026-09' } } });
  assert.strictEqual(E.evaluate(B('kb-starbucks'), 20000).status, 'ok');
  assert.strictEqual(E.cardLimit('kb'), 10000);
  assert.strictEqual(E.evaluate(B('kb-transit'), 20000).status, 'check');
});

test('지난달 사용액은 입력한 달이 지나면 무효', () => {
  const { E } = setup({ s: { cards: ['hana'], spend: { hana: 300000 }, spendAt: { hana: '2026-09' } } });
  assert.strictEqual(E.spendOf('hana'), null);
  assert(E.spendStale('hana'));
  assert.strictEqual(E.evaluate(B('hana-starbucks'), 20000).status, 'check');
});

test('월간 리포트: 아낀 돈·평균 절약률·카드 한 장만 썼을 때 비교', () => {
  const S = { cards: ['hana', 'shinhan'], spend: { hana: 100000, shinhan: 100000 }, spendAt: {}, firstUse: {}, since: {}, checks: {}, savings: [], pointValue: 1 };
  const txs = [
    tx('2026-10-15T09:00:00', 'hana', 25000, [{ b: 'hana-px', k: 'hana-px', v: 5000, unit: 'won' }]),
    Object.assign(tx('2026-10-15T12:00:00', 'hana', 12000, [{ b: 'hana-starbucks', k: 'hana-starbucks', v: 2400, pooled: true, unit: 'won' }]), { place: '스타벅스' }),
  ];
  const r = Engine.monthReport(DATA, S, txs, ['hana', 'shinhan']);
  assert.strictEqual(r.spent, 37000);
  assert.strictEqual(r.worth, 7400);
  assert.strictEqual(r.pct.toFixed(1), '20.0');
  const sh = r.single.find((x) => x.card === 'shinhan');
  assert.strictEqual(sh.won, 1600); // PX 3만원 미만 20% → 건당 1천원, 스타벅스 커피 5% 600원
  assert.strictEqual(sh.diff, 5800);
  assert.strictEqual(r.single.find((x) => x.card === 'hana').won, 7400);
});

test('월간 리포트: 한 장만 쓰면 한도가 차는 것까지 반영', () => {
  const S = { cards: ['hana', 'ibk'], spend: {}, spendAt: {}, firstUse: {}, since: {}, checks: {}, savings: ['ibk'], pointValue: 1 };
  // 하나 PX 3만원 미만은 일 5천원 한도 → 같은 날 두 번이면 두 번째는 0원
  const txs = [
    tx('2026-10-16T09:00:00', 'hana', 20000, [{ b: 'hana-px', k: 'hana-px', v: 5000, unit: 'won' }]),
    tx('2026-10-16T10:00:00', 'ibk', 20000, [{ b: 'ibk-px-basic', k: 'ibk-px-basic', v: 3000, unit: 'won' }]),
  ];
  const r = Engine.monthReport(DATA, S, txs, ['hana', 'ibk']);
  assert.strictEqual(r.single.find((x) => x.card === 'hana').won, 5000);
  assert.strictEqual(r.single.find((x) => x.card === 'ibk').won, 6000);
  assert.strictEqual(r.worth, 8000);
});

test('백업 가져오기: 결제한 곳·섹터·경로를 유지하고 잘못된 값은 버림', () => {
  const t = { id: 'p1', ts: new Date('2026-10-01T10:00:00').getTime(), card: 'hana', amt: 25000, place: 'PX', sec: 'px', route: { px: 'navy', bad: 'x' }, items: [{ b: 'hana-px', k: 'hana-px', v: 5000, unit: 'won' }] };
  const bad = Object.assign({}, t, { id: 'p2', place: 'x'.repeat(40), sec: 'nope', route: { px: 'zzz' } });
  const r = Engine.cleanImportTx(DATA, [t, bad], (x) => x);
  assert.strictEqual(r.tx[0].place, 'PX');
  assert.strictEqual(r.tx[0].sec, 'px');
  assert.strictEqual(JSON.stringify(r.tx[0].route), '{"px":"navy"}');
  assert.strictEqual(r.tx[1].place, undefined);
  assert.strictEqual(r.tx[1].sec, undefined);
  assert.strictEqual(r.tx[1].route, undefined);
});

console.log('데이터 검증');

test('혜택 id가 고유하고 필수 필드가 있다', () => {
  const ids = new Set();
  const cards = new Set(DATA.CARDS.map((c) => c.id));
  const sectors = new Set(DATA.SECTORS.map((s) => s.id));
  DATA.BENEFITS.forEach((b) => {
    assert(/^[a-z0-9-]+$/.test(b.id), 'id 형식: ' + b.id);
    assert(!ids.has(b.id), '중복 id: ' + b.id);
    ids.add(b.id);
    ['card', 'sector', 'group', 'title', 'where', 'value', 'type'].forEach((f) => assert(b[f] != null && b[f] !== '', `${b.id}.${f} 없음`));
    assert(cards.has(b.card), b.id + ' 카드');
    assert(sectors.has(b.sector), b.id + ' 섹터');
    assert(typeof b.rate === 'number', b.id + ' rate');
    if (b.extra) assert(DATA.BENEFITS.some((x) => x.id === b.extra), b.id + ' extra 대상 없음');
    (b.need || []).forEach((k) => assert(Engine.NEEDS[k], `${b.id} need ${k}`));
    (b.ctx || []).forEach((t) => assert(typeof t === 'string' && t, b.id + ' ctx'));
    if (b.until) assert(/^\d{4}-\d{2}-\d{2}$/.test(b.until), b.id + ' until');
  });
});

test('예전 id 대응표가 모두 존재하는 혜택을 가리킨다', () => {
  const ids = new Set(DATA.BENEFITS.map((b) => b.id));
  Object.entries(DATA.LEGACY_IDS).forEach(([o, n]) => assert(ids.has(n), `${o} → ${n}`));
});

test('카드마다 출처·신규 발급 규칙이 있다', () => {
  DATA.CARDS.forEach((c) => {
    assert(c.source && /^https:\/\//.test(c.source.url) && /^\d{4}-\d{2}$/.test(c.source.date), c.id + ' source');
    assert(c.first && c.first.spend > 0 && c.first.groups.length, c.id + ' first');
  });
});

test('PX 섹터 혜택은 모두 PX 검색어로 찾을 수 있다', () => {
  const { E } = setup();
  const found = new Set(E.search('PX').map((b) => b.id));
  DATA.BENEFITS.filter((b) => b.sector === 'px').forEach((b) => assert(found.has(b.id), b.id));
});

test('설정 검증: 잘못된 값(spend:null 등)은 기본값으로', () => {
  const r = Engine.sanitizeSettings(DATA, { cards: ['ibk', 'nope'], spend: null, spendAt: { ibk: 'x' }, salary: 'zz', soldier: 'yes', pointValue: 5 });
  assert.strictEqual(JSON.stringify(r.cards), '["ibk"]');
  assert.strictEqual(JSON.stringify(r.spend), '{}');
  assert.strictEqual(JSON.stringify(r.spendAt), '{}');
  assert.strictEqual(r.salary, null);
  assert.strictEqual(r.soldier, null);
  assert.strictEqual(r.pointValue, 1);
  assert.strictEqual(Engine.sanitizeSettings(DATA, null).cards.length, 0);
});

test('기록 검증: 음수·빈 항목·모르는 카드는 거부', () => {
  const ok = { id: 'a', ts: 1, card: 'ibk', amt: 1000, items: [{ b: 'ibk-npay', k: 'ibk-npay', v: 10 }] };
  assert(Engine.isTx(DATA, ok));
  assert(!Engine.isTx(DATA, Object.assign({}, ok, { card: 'x' })));
  assert(!Engine.isTx(DATA, Object.assign({}, ok, { items: [] })));
  assert(!Engine.isTx(DATA, Object.assign({}, ok, { items: [{ b: 'ibk-npay', k: 'ibk-npay', v: -5 }] })));
});

console.log('검색·경로');

const ids_ = (list) => list.map((b) => b.id);
test('업종 검색: ‘카페’는 카드별 커피 혜택과 IBK 메가커피까지 모두', () => {
  const { E } = setup();
  const r = ids_(E.search('카페'));
  ['ibk-aio-cafe', 'hana-starbucks', 'kb-starbucks', 'shinhan-coffee', 'ibk-mega'].forEach((id) => assert(r.includes(id), id));
  assert.deepStrictEqual(ids_(E.search('커피')).sort(), r.sort());
});

test('업종 검색: ‘편의점’은 CU 행사상품 혜택까지, PX는 제외', () => {
  const { E } = setup();
  const r = ids_(E.search('편의점'));
  ['hana-cu', 'shinhan-cu', 'shinhan-store', 'ibk-store-nara', 'ibk-gs25-extra'].forEach((id) => assert(r.includes(id), id));
  assert(!E.search('편의점').some((b) => b.sector === 'px'));
});

test('‘해군마트’·‘GS25 해군마트’ 검색에 하나 PX 포함 (하나는 해군·해병대 군마트 포함)', () => {
  const { E } = setup();
  ['해군마트', 'GS25 해군마트', 'PX'].forEach((q) => {
    const r = ids_(E.search(q));
    ['hana-px', 'ibk-px-basic', 'shinhan-px', 'kb-px'].forEach((id) => assert(r.includes(id), q + ' ' + id));
  });
});

test('특정 가맹점 검색: 스타벅스에는 메가커피 전용 혜택이 섞이지 않음, 일반 GS25엔 PX 없음', () => {
  const { E } = setup();
  const r = ids_(E.search('스타벅스'));
  assert(r.includes('hana-starbucks') && r.includes('shinhan-coffee'));
  assert(!r.includes('ibk-mega'));
  assert(!E.search('GS25').some((b) => b.sector === 'px'));
  assert(ids_(E.search('메가커피')).includes('ibk-mega'));
});

test('보유 카드를 먼저 거르고 검색: 신한만 있으면 ‘스타벅스’에 신한 커피 혜택', () => {
  const { E } = setup({ s: { cards: ['shinhan'] } });
  assert.deepStrictEqual(ids_(E.search('스타벅스', ['shinhan'])), ['shinhan-coffee']);
  assert(ids_(E.search('하나 스타벅스')).every((id) => id.startsWith('hana')));
});

test('신한 GS25 해군마트: 같은 날 1만원(PX 1천원) 후 6천원은 Life 편의점 20% 1천원 (공식 예시)', () => {
  const ledger = [];
  const env = setup({ s: { cards: ['shinhan'], spend: { shinhan: 200000 } }, ledger, route: { px: 'navy' } });
  const x1 = env.E.estimate(B('shinhan-px'), 10000);
  assert.strictEqual(x1.v, 1000);
  ledger.push({ id: 'a', ts: new Date('2026-10-15T10:00:00').getTime(), card: 'shinhan', amt: 10000, items: env.E.txItems(B('shinhan-px'), x1) });
  const x2 = env.E.estimate(B('shinhan-px'), 6000);
  assert.strictEqual(x2.v, 1000);
  assert.strictEqual(x2.fallback.id, 'shinhan-store');
  assert.strictEqual(env.E.evaluate(B('shinhan-px'), 6000).status, 'ok');
  const items = env.E.txItems(B('shinhan-px'), x2);
  assert.deepStrictEqual(items.map((i) => [i.b, i.k, i.pooled]), [['shinhan-store', 'shinhan-store', true]]);
});

test('신한 해군마트 대체: 일반 PX·경로 모름·Life 실적 미달이면 대체 안 함, 한 결제의 1천원 초과분엔 안 붙음', () => {
  const ledger = [tx('2026-10-15T10:00:00', 'shinhan', 10000, [{ b: 'shinhan-px', k: 'shinhan-px', v: 1000 }])];
  const env = setup({ s: { cards: ['shinhan'], spend: { shinhan: 200000 } }, ledger, route: { px: 'general' } });
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 6000).v, 0);
  assert.strictEqual(env.E.evaluate(B('shinhan-px'), 6000).status, 'no');
  env.setRoute({});
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 6000).v, 0);
  const low = setup({ s: { cards: ['shinhan'], spend: { shinhan: 50000 } }, ledger, route: { px: 'navy' } });
  assert.strictEqual(low.E.estimate(B('shinhan-px'), 6000).v, 0);
  const fresh = setup({ s: { cards: ['shinhan'], spend: { shinhan: 200000 } }, route: { px: 'navy' } });
  const x = fresh.E.estimate(B('shinhan-px'), 20000); // 20% 4천원이지만 1회 1천원 — 초과분에 Life 추가 없음
  assert.strictEqual(x.v, 1000);
  assert(!x.fallback && !x.extra);
});

test('추천 이유: 다른 카드가 횟수를 다 썼으면 이유로 표시, 차선 카드 제시', () => {
  const ledger = [tx('2026-10-15T09:00:00', 'kb', 10000, [{ b: 'kb-px', k: 'kb-px', v: 1000 }]), tx('2026-10-14T09:00:00', 'kb', 10000, [{ b: 'kb-px', k: 'kb-px', v: 1000 }])];
  const { E } = setup({ s: { soldier: true }, ledger });
  const rows = E.rank(E.search('PX'), 20000);
  const ex = E.explain(rows, 20000);
  assert.strictEqual(ex.top.b.id, 'hana-px');
  assert(/오늘 남은 한도/.test(ex.lines[0]), ex.lines[0]);
  assert(ex.lines.some((l) => /KB는 .*2회 모두 사용/.test(l)), ex.lines.join('|'));
  assert(ex.alt && ex.alt.b.card !== 'hana');
});

console.log('남은 한도 직접 맞추기');

test('통합한도 맞추기: 맞춘 시점 이전 기록은 다시 빼지 않고, 이후 기록만 차감, 이후 기록 취소는 복원', () => {
  const at = new Date('2026-10-15T10:00:00').getTime();
  const ledger = [tx('2026-10-14T09:00:00', 'hana', 30000, [{ b: 'hana-starbucks', k: 'hana-starbucks', v: 3000, pooled: true }])];
  const s = { cards: ['hana'], spend: { hana: 300000 }, adjust: [{ id: 'a1', card: 'hana', key: 'pooled', ri: -1, kind: 'month', left: 10000, at }] };
  const env = setup({ s, ledger });
  assert.strictEqual(env.E.pooledState('hana', 20000).left, 10000); // 3,000원 이전 기록을 또 빼지 않음
  ledger.push(tx('2026-10-15T11:00:00', 'hana', 20000, [{ b: 'hana-starbucks', k: 'hana-starbucks', v: 2000, pooled: true }]));
  assert.strictEqual(env.E.pooledState('hana', 20000).left, 8000);
  assert.strictEqual(env.E.remaining(B('hana-family'), 50000).rem, 8000);
  ledger.pop(); // 이후 기록 취소 → 정확히 복원
  assert.strictEqual(env.E.pooledState('hana', 20000).left, 10000);
  env.setDate('2026-11-02T12:00:00'); // 달이 바뀌면 맞춘 값 효력 없음
  assert.strictEqual(env.E.pooledState('hana', 20000).left, 20000);
});

test('혜택별 횟수 맞추기: IBK PX 3만원 미만 남은 1회 → 이후 1회 쓰면 소진, 통합한도와 독립', () => {
  const at = new Date('2026-10-15T10:00:00').getTime();
  const ledger = [];
  const s = { cards: ['ibk'], savings: ['ibk'], adjust: [{ id: 'a2', card: 'ibk', key: 'ibk-px-basic', ri: 0, kind: 'monthCount', left: 1, at }] };
  const env = setup({ s, ledger });
  assert.strictEqual(env.E.evaluate(B('ibk-px-basic'), 20000).status, 'ok');
  ledger.push(tx('2026-10-15T11:00:00', 'ibk', 20000, [{ b: 'ibk-px-basic', k: 'ibk-px-basic', v: 3000 }]));
  assert.strictEqual(env.E.evaluate(B('ibk-px-basic'), 20000).status, 'no');
  assert.strictEqual(env.E.evaluate(B('ibk-px-basic'), 50000).status, 'ok'); // 3만원 이상 구간은 따로
  const g = env.E.limitBreakdown(B('ibk-px-basic')).find((x) => x.label.includes('미만')).items.find((i) => i.kind === 'monthCount');
  assert.strictEqual(g.used, g.limit);
  assert(g.adj);
});

test('일 한도 맞추기는 다음 날 효력 없음, 금액 맞추기는 남은 금액까지만 할인', () => {
  const at = new Date('2026-10-15T09:00:00').getTime();
  const s = { cards: ['hana'], adjust: [{ id: 'a3', card: 'hana', key: 'hana-px', ri: 0, kind: 'day', left: 1000, at }] };
  const env = setup({ s });
  assert.strictEqual(env.E.estimate(B('hana-px'), 10000).v, 1000);
  env.setDate('2026-10-16T12:00:00');
  assert.strictEqual(env.E.estimate(B('hana-px'), 10000).v, 3000);
});

test('잘못된 맞추기 값은 설정 불러오기에서 걸러냄', () => {
  const r = Engine.sanitizeSettings(DATA, { adjust: [{ id: 'x', card: 'hana', key: 'pooled', ri: -1, kind: 'month', left: -5, at: 1 }, { id: 'y', card: 'zzz', key: 'pooled', ri: -1, kind: 'month', left: 5, at: 1 }, { id: 'z', card: 'kb', key: 'pooled', ri: -1, kind: 'month', left: 5, at: 10 }] });
  assert.deepStrictEqual(r.adjust.map((a) => a.id), ['z']);
});

test('조사: 받침에 맞게 (신한으로·하나로·IBK로·KB로, 신한은·IBK는, 사용이라·소진이라)', () => {
  const j = Engine.josa;
  assert.deepStrictEqual(['신한', '하나', 'IBK', 'KB', '하나 나라사랑카드', '서울'].map((w) => j(w, '으로/로')), ['신한으로', '하나로', 'IBK로', 'KB로', '하나 나라사랑카드로', '서울로']);
  assert.deepStrictEqual(['신한', '하나', 'IBK', 'KB'].map((w) => j(w, '은/는')), ['신한은', '하나는', 'IBK는', 'KB는']);
  assert.strictEqual(j('이번 달 2회 모두 사용', '이라/라'), '이번 달 2회 모두 사용이라');
  assert.strictEqual(j('통합한도 소진', '이라/라'), '통합한도 소진이라');
  assert.strictEqual(j('5,000원', '을/를'), '5,000원을');
});

console.log('결제 계획');

const PX_ALL = { soldier: true, savings: ['ibk'], spend: { hana: 300000, ibk: 300000, shinhan: 300000, kb: 300000 } };
const ids = (p) => p.pays.map((x) => (x.b ? x.b.id : '-') + ':' + x.amt).join(' ');

test('PX 5만원: 하나 한 번(1만원)보다 3만원 미만 + 나머지로 나누면 11,660원', () => {
  const { E } = setup({ s: PX_ALL });
  const p = E.plan(E.search('PX'), 50000);
  assert.strictEqual(p.single.w, 10000);
  assert.strictEqual(p.saved, 11660, ids(p));
  assert(p.pays.some((x) => x.b && x.b.id === 'hana-px' && x.amt < 30000), ids(p));
  assert.strictEqual(p.pays.reduce((s, x) => s + x.amt, 0), 50000);
});

test('PX 20만원: IBK 한 번(기본 5만 + 특별 5만)이 최선이라 나누지 않음', () => {
  const { E } = setup({ s: PX_ALL });
  const p = E.plan(E.search('PX'), 200000);
  assert.strictEqual(p.pays.length, 1, ids(p));
  assert.strictEqual(p.pays[0].b.id, 'ibk-px-basic');
  assert.strictEqual(p.saved, 100000);
});

test('PX 25만원: IBK 20만원(특별할인 조건)에 맞추고 나머지를 하나로', () => {
  const { E } = setup({ s: PX_ALL });
  const p = E.plan(E.search('PX'), 250000);
  assert(p.pays.some((x) => x.b && x.b.id === 'ibk-px-basic' && x.amt === 200000), ids(p));
  assert.strictEqual(p.saved, 111660, ids(p));
});

test('결제 계획: 한 번에(max 1)는 카드 하나 추천과 같다', () => {
  const { E } = setup({ s: PX_ALL });
  const p = E.plan(E.search('PX'), 50000, 1);
  assert.strictEqual(p.pays.length, 1);
  assert.strictEqual(p.saved, 10000);
  assert.strictEqual(p.gain, 0);
});

test('결제 계획: 이미 쓴 한도를 반영 (하나 3만원 미만 일 5천 소진 후)', () => {
  const ledger = [tx('2026-10-15T09:00:00', 'hana', 16700, [{ b: 'hana-px', k: 'hana-px', v: 5000 }])];
  const { E } = setup({ s: PX_ALL, ledger });
  const p = E.plan(E.search('PX'), 50000);
  assert(!p.pays.some((x) => x.b && x.b.id === 'hana-px' && x.amt < 30000), ids(p));
  assert.strictEqual(ledger.length, 1, '가상 결제가 실제 기록에 남으면 안 됨');
});

test('결제 계획: 조건 확인이 필요한 혜택은 쓰지 않음', () => {
  const { E } = setup({ s: { spend: { hana: 300000 } } });
  const p = E.plan(E.search('PX'), 200000);
  assert(!p.pays.some((x) => x.b && x.b.id.startsWith('ibk-px')), ids(p));
});

test('나눠 결제 기준: 1회 더 나눌 때 660원 더 아끼는 PX 2만원 — 500원 기준이면 나누고 1,000원이면 한 번에', () => {
  const { E } = setup({ s: PX_ALL });
  const list = E.search('PX');
  assert.strictEqual(E.plan(list, 20000, { max: 3, gain: 500 }).pays.length, 2);
  const one = E.plan(list, 20000, { max: 3, gain: 1000 });
  assert.strictEqual(one.pays.length, 1);
  assert.strictEqual(one.saved, 5000);
  // 추가 절약이 기준과 딱 같으면 나눔 (기준 '이상')
  assert.strictEqual(E.plan(list, 20000, { max: 3, gain: 660 }).pays.length, 2);
  assert.strictEqual(E.plan(list, 20000, { max: 3, gain: 661 }).pays.length, 1);
});

test('나눠 결제 횟수 제한: 간단하게(최대 2회)·최대 절약(3회)·한 번에(1회)', () => {
  const { E } = setup({ s: PX_ALL });
  const list = E.search('PX');
  const two = E.plan(list, 250000, { max: 2, gain: 500 });
  const three = E.plan(list, 250000, { max: 3, gain: 500 });
  assert(two.pays.length <= 2 && three.pays.length <= 3);
  assert(three.saved >= two.saved);
  assert.strictEqual(E.plan(list, 250000, { max: 1 }).pays.length, 1);
});

test('나눠 결제: 절약액이 같으면 결제 횟수가 적은 조합', () => {
  const { E } = setup({ s: PX_ALL });
  const p = E.plan(E.search('PX'), 200000, { max: 3, gain: 0 });
  assert.strictEqual(p.pays.length, 1, ids(p));
});

test('나눠 결제 계획: 총액 보존, 계획 순서대로 실제 기록해도 같은 혜택 (일·월·연 한도 초과 없음)', () => {
  [20000, 50000, 80000, 150000, 250000, 400000].forEach((amt) => {
    const ledger = [tx('2026-10-15T08:00:00', 'hana', 16700, [{ b: 'hana-px', k: 'hana-px', v: 4000 }])];
    const { E } = setup({ s: Object.assign({ salary: 'ibk', since: { salary: '2026-08' } }, PX_ALL), ledger, date: '2026-10-15T12:00:00' });
    const p = E.plan(E.search('PX'), amt, { max: 3, gain: 100 });
    assert.strictEqual(p.pays.reduce((a, x) => a + x.amt, 0), amt, amt + ' 총액');
    assert.strictEqual(ledger.length, 1, '가상 결제가 실제 기록에 남으면 안 됨');
    p.pays.forEach((x, i) => {
      if (!x.b) return;
      const now = E.estimate(x.b, x.amt);
      assert.strictEqual(now.v, x.x.v, `${amt} ${i}번째 ${x.b.id}`);
      ledger.push({ id: 'p' + i, ts: new Date('2026-10-15T12:00:00').getTime(), card: x.b.card, amt: x.amt, items: E.txItems(x.b, now) });
    });
    // 기록 후 각 혜택 한도가 음수가 되지 않음
    ['hana-px', 'ibk-px-basic', 'shinhan-px', 'kb-px'].forEach((id) => {
      E.limitBreakdown(B(id)).forEach((g) => g.items.forEach((it) => assert(it.used <= it.limit, `${amt} ${id} ${it.kind} ${it.used}/${it.limit}`)));
    });
  });
});

test('IBK 급여이체 이번 달 시작: 계산(현역병 횟수)과 안내 문구가 같은 기준, 다음 달부터 우대', () => {
  const s = { cards: ['ibk'], salary: 'ibk', savings: ['ibk'], since: { salary: '2026-10' } };
  const b = B('ibk-px-basic');
  const oct = new Date('2026-10-15T12:00:00').getTime();
  const nov = new Date('2026-11-02T12:00:00').getTime();
  assert(!/급여이체자 →/.test(b.personal(s, oct)), b.personal(s, oct));
  assert(/다음 달부터/.test(b.personal(s, oct)));
  assert(/급여이체자 →/.test(b.personal(s, nov)));
  const env = setup({ s, date: '2026-10-15T12:00:00' });
  assert.strictEqual(env.E.limitBreakdown(b).find((g) => g.label.includes('미만')).items.find((i) => i.kind === 'monthCount').limit, 3);
  env.setDate('2026-11-02T12:00:00');
  assert.strictEqual(env.E.limitBreakdown(b).find((g) => g.label.includes('미만')).items.find((i) => i.kind === 'monthCount').limit, 6);
});

console.log('백업·저장 데이터');

const fixId = (x) => DATA.LEGACY_IDS[x] || x;
test('백업 가져오기: 카드가 안 맞는 혜택·중복 id·잘못된 단위는 제외, 한도 키는 혜택 기준으로 정리, 금액은 그대로', () => {
  const t0 = new Date('2026-10-01T12:00:00').getTime();
  const list = [
    { id: 'ok1', ts: t0, card: 'ibk', amt: 50000, items: [{ b: 'ibk-park', k: 'wrong-key', v: 12345, pooled: false, unit: 'won' }], edited: true, plan: 'p1' },
    { id: 'ok1', ts: t0, card: 'ibk', amt: 50000, items: [{ b: 'ibk-park', k: 'ibk-park', v: 1, unit: 'won' }] }, // 중복 id
    { id: 'bad1', ts: t0, card: 'hana', amt: 10000, items: [{ b: 'ibk-park', k: 'ibk-park', v: 100, unit: 'won' }] }, // 카드 불일치
    { id: 'bad2', ts: t0, card: 'hana', amt: 10000, items: [{ b: 'hana-px', k: 'hana-px', v: 100, unit: 'usd' }] },
    { id: 'bad3', ts: t0, card: 'hana', amt: 10000, items: [{ b: 'hana-px', k: 'hana-px', v: 100, pooled: 'yes' }] },
    { id: 'old', ts: t0, card: 'hana', amt: 10000, items: [{ b: 'hana:Easy:군마트(PX) 캐시백', k: 'hana:Easy:군마트(PX) 캐시백', v: 3000 }] }, // 예전 id
  ];
  const r = Engine.cleanImportTx(DATA, list, fixId);
  assert.deepStrictEqual(r.tx.map((t) => t.id), ['ok1', 'old']);
  assert.strictEqual(r.dropped, 4);
  assert.strictEqual(r.tx[0].items[0].k, 'ibk-park');
  assert.strictEqual(r.tx[0].items[0].v, 12345); // 기록 당시 금액 유지
  assert.strictEqual(r.tx[0].edited, true);
  assert.strictEqual(r.tx[1].items[0].b, 'hana-px');
});

test('새 설정 항목(즐겨찾기·맞춘 한도·나눠 결제 기준) 왕복, 옛 설정은 기본값', () => {
  const S1 = Engine.sanitizeSettings(DATA, { favs: [{ q: 'CU', route: { channel: 'offline', promo: 'maybe' } }, { q: 'cu' }, { q: '' }], splitGain: 1000 });
  assert.strictEqual(JSON.stringify(S1.favs), JSON.stringify([{ q: 'CU', route: { channel: 'offline' } }]));
  assert.strictEqual(S1.splitGain, 1000);
  const S2 = Engine.sanitizeSettings(DATA, JSON.parse(JSON.stringify(S1)));
  assert.strictEqual(JSON.stringify(S2), JSON.stringify(S1));
  const old = Engine.sanitizeSettings(DATA, { cards: ['hana'], spend: { hana: 100000 } });
  assert.strictEqual(JSON.stringify([old.favs, old.adjust, old.splitGain]), '[[],[],500]');
});

test('달·연 경계와 행사 종료: 같은 엔진에서 날짜가 바뀌면 다시 판정 (사용액 재입력·프로모션 종료)', () => {
  const env = setup({ s: { cards: ['ibk', 'hana'], spend: { hana: 300000 } }, date: '2026-12-31T23:00:00' });
  assert.strictEqual(env.E.evaluate(B('ibk-emart24'), 5000).status, 'ok');
  assert.strictEqual(env.E.evaluate(B('hana-starbucks'), 20000).status, 'ok');
  env.setDate('2027-01-01T09:00:00');
  assert.strictEqual(env.E.evaluate(B('ibk-emart24'), 5000).status, 'no');
  const st = env.E.evaluate(B('hana-starbucks'), 20000);
  assert.strictEqual(st.status, 'check');
  assert(/다시 입력/.test(st.why.join()));
});

console.log('배포 파일 검증');

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', file + ' PNG 아님');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('아이콘 크기가 규격과 맞다', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  manifest.icons.forEach((i) => {
    const [w, h] = pngSize(i.src);
    assert.strictEqual(`${w}x${h}`, i.sizes, i.src);
  });
  assert.deepStrictEqual(pngSize('icons/apple-touch-icon.png'), [180, 180]);
  assert.deepStrictEqual(pngSize('icons/favicon-32.png'), [32, 32]);
});

test('서비스워커가 앱 파일을 모두 캐시하고, 자기 캐시만 지운다', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  [...html.matchAll(/src="(js\/[^"]+)"/g)].forEach((m) => assert(sw.includes(`'${m[1]}'`), m[1] + ' 캐시 목록에 없음'));
  assert(/k\.startsWith\(PREFIX\)/.test(sw), '캐시 삭제 범위 제한 없음');
  // 앱 파일은 같은 버전 캐시에서만 응답 (일부 최신·일부 구버전 혼합 방지)
  assert(/SHELL_URLS\.has/.test(sw) && /c\.match\(url\.href\)/.test(sw), '앱 파일 버전 고정 응답 없음');
  ['css/style.css', 'index.html', 'privacy.html'].forEach((f) => assert(sw.includes(`'${f}'`), f));
  assert(!/cdn\.jsdelivr|fonts\.googleapis/.test(html), '외부 글꼴 요청');
});

console.log(`\n${passed}개 통과, ${failed}개 실패`);
process.exit(failed ? 1 : 0);
