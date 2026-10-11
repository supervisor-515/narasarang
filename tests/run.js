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
function setup({ s = {}, ledger = [], date = '2026-10-15T12:00:00', tickets = 1 } = {}) {
  const st = { now: new Date(date).getTime(), tickets };
  const S = Object.assign({ cards: [], salary: null, savings: [], spend: {}, spendAt: {}, firstUse: {}, soldier: null, checks: {} }, s);
  Object.keys(S.spend).forEach((k) => { if (!S.spendAt[k]) S.spendAt[k] = date.slice(0, 7); });
  const E = Engine.create(DATA, { getS: () => S, getLedger: () => ledger, now: () => st.now, getInput: () => ({ tickets: st.tickets }) });
  return { E, S, ledger, setDate: (d) => { st.now = new Date(d).getTime(); }, setTickets: (n) => { st.tickets = n; } };
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
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 2000).v, 1000);
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 20000).v, 1000);
  assert.strictEqual(env.E.evaluate(B('shinhan-px'), 2000).status, 'ok');
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 50000).v, 10000); // 3만원 이상은 10일에도 20%
  env.setDate('2026-10-11T12:00:00');
  assert.strictEqual(env.E.estimate(B('shinhan-px'), 2000).v, 400);
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

test('신한 CU 행사상품 5,000원: 500원 즉시할인 + 남은 4,500원의 20% 900원 = 1,400원', () => {
  const { E } = setup({ s: { cards: ['shinhan'], spend: { shinhan: 200000 } } });
  const x = E.estimate(B('shinhan-cu'), 5000);
  assert.strictEqual(x.v, 1400);
  assert.strictEqual(x.extra.v, 900);
  const best = E.bestOf(E.rank(E.search('CU'), 5000), 5000);
  assert.strictEqual(best.b.id, 'shinhan-cu');
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
});

console.log(`\n${passed}개 통과, ${failed}개 실패`);
process.exit(failed ? 1 : 0);
