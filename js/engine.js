/*
 * 혜택 계산 엔진 — 화면과 무관한 순수 로직 (브라우저: window.Engine, Node: require)
 *
 * Engine.create(DATA, { getS, getLedger, now }) 로 만들고,
 *  getS()      : 사용자 설정
 *  getLedger() : 결제 기록 [{ id, ts, card, amt, items: [{ b, k, v, pooled, unit }] }]
 *  now()       : 현재 시각(ms) — 테스트에서 날짜를 고정할 때 사용
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICKET_PRICE = 15000; // 관람권 매수 추정 기준 (일반 2D 1매)

  // 자격 조건: 사용자가 확인해줘야 하는 것들
  const NEEDS = {
    soldier: { label: '현역 병사(의무복무) 여부', how: '설정 > 내 정보에서 선택해주세요' },
    ibkSoldier: {
      label: 'IBK 현역병 인정',
      how: '전월 말일 기준 IBK 장병내일준비적금 보유, 복무확인서·건강보험자격득실확인서 제출(제출 다음 달부터), 전월 IBK 병 급여 수령 중 하나',
    },
    'mytag-kakaot': { label: 'BC카드 ‘카카오T’ 마이태그 등록', flag: 'mytag-kakaot', flagLabel: '카카오T 마이태그 등록했어요' },
    'mytag-coupang': { label: 'BC카드 ‘쿠팡·다이소·올리브영’ 마이태그 등록', flag: 'mytag-coupang', flagLabel: '쿠팡·다이소·올리브영 마이태그 등록했어요' },
    'mytag-moms': { label: 'BC카드 ‘맘스터치’ 마이태그 등록', flag: 'mytag-moms', flagLabel: '맘스터치 마이태그 등록했어요' },
  };

  // 줄임말 → 가맹점 이름
  const ALIAS = {
    스벅: '스타벅스', 맥날: '맥도날드', 롯리: '롯데리아', 배민: '배달의민족', 넷플: '넷플릭스', 유튭: '유튜브',
    피엑스: 'px', 씨유: 'cu', 지에스: 'gs25', 지에스25: 'gs25', 빕스: 'vips', 올영: '올리브영',
    카택: '카카오t', 카카오택시: '카카오t', 롯월: '롯데월드', 에버: '에버랜드', 지마켓: 'g마켓', 캐비: '캐리비안베이',
  };
  // PX 혜택은 이 단어가 검색어에 있을 때만 (일반 GS25·편의점 검색에 섞이지 않게)
  const PX_TERMS = ['px', '군마트', '해군마트', '해군', '마트', '충성마트', '영외마트', '군매점', '군부대'];

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const md = (t) => ymd(t).slice(5);
  const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
  const man = (n) => (n >= 10000 ? (n / 10000).toLocaleString('ko-KR') + '만원' : won(n));
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s·,()/._\-‘’'"]/g, '');
  const addMonth = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

  function create(DATA, ctx) {
    const CARD = Object.fromEntries(DATA.CARDS.map((c) => [c.id, c]));
    const SECTOR = Object.fromEntries(DATA.SECTORS.map((s) => [s.id, s]));
    const BANK = Object.fromEntries(DATA.BANKS.map((b) => [b.id, b]));
    const BENEFIT = Object.fromEntries(DATA.BENEFITS.map((b) => [b.id, b]));
    const S = () => ctx.getS();
    const now = () => (ctx.now ? ctx.now() : Date.now());
    const thisMonth = () => ymd(now()).slice(0, 7);
    const resolve = (v) => (typeof v === 'function' ? v(S(), now()) : v);
    // 급여·적금·서류는 시작한 달의 다음 달부터 인정 (since 월 < 이번 달)
    const effective = (key) => { const m = (S().since || {})[key]; return !m || m < thisMonth(); };
    const pending = (key) => !effective(key);
    const salaryOk = (bank) => S().salary === bank && effective('salary');
    const savingOk = (bank) => (S().savings || []).includes(bank) && effective('saving-' + bank);
    const owned = (id) => (S().cards || []).includes(id);
    const keyOf = (b) => b.limKey || b.id;
    const unitOf = (b) => (b && (b.type === '적립' || (b.calc && b.calc.steps)) ? 'point' : 'won');

    // ───── 기록 순회 ─────
    // virtual: 결제 계획을 짤 때 아직 하지 않은 결제를 잠시 얹어 한도 차감을 미리 계산
    let virtual = [];
    function eachItem(fn) {
      (ctx.getLedger() || []).concat(virtual).forEach((tx) => (tx.items || []).forEach((it) => fn(it, tx)));
    }

    // ───── 전월 실적 ─────
    // 입력한 달이 지나면(다음 달) 오래된 값으로 보고 무시
    function spendOf(cardId) {
      const s = S();
      const v = (s.spend || {})[cardId];
      if (v == null) return null;
      const at = (s.spendAt || {})[cardId];
      return at && at !== thisMonth() ? null : v;
    }
    function spendStale(cardId) {
      const s = S();
      const at = (s.spendAt || {})[cardId];
      return (s.spend || {})[cardId] != null && !!at && at !== thisMonth();
    }
    // 첫 사용 등록 월 ~ 다음 달까지 신규 발급 실적 인정
    function firstActive(cardId) {
      const m = (S().firstUse || {})[cardId];
      return !!m && (m === thisMonth() || addMonth(m, 1) === thisMonth());
    }
    function firstApplies(b) {
      const f = CARD[b.card].first;
      return !!f && firstActive(b.card) && f.groups.some((g) => b.group.startsWith(g)) && !(f.except || []).includes(b.sector);
    }
    function effSpend(b) {
      const sp = spendOf(b.card);
      if (firstApplies(b)) return { sp: Math.max(sp || 0, CARD[b.card].first.spend), viaFirst: true };
      return { sp, viaFirst: false };
    }
    function tierOf(card, spend) {
      if (spend == null) return null;
      let lim = 0;
      card.tiers.forEach(([m, l]) => { if (spend >= m) lim = l; });
      return lim;
    }
    function pooledLimit(b) {
      const card = CARD[b.card];
      const e = effSpend(b);
      if (e.viaFirst && card.first.limit) return Math.max(card.first.limit, tierOf(card, spendOf(b.card) || 0));
      return tierOf(card, e.sp);
    }
    // 카드 화면용: 신규 발급 인정을 포함한 통합한도
    function cardLimit(cardId) {
      const card = CARD[cardId];
      const sp = spendOf(cardId);
      if (firstActive(cardId) && card.first) {
        return card.first.limit ? Math.max(card.first.limit, tierOf(card, sp || 0)) : tierOf(card, Math.max(sp || 0, card.first.spend));
      }
      return tierOf(card, sp);
    }

    // ───── 한도 차감 ─────
    const dayOk = (r, t) => !(r.days && !r.days.includes(md(t))) && !(r.notDays && r.notDays.includes(md(t)));
    const dayMatch = (d, t) => !!d && ((d.dates || []).includes(md(t)) || (d.dom || []).includes(new Date(t).getDate()));
    const inBand = (r, amt) => !(r.under && !(amt < r.under)) && !(r.over && !(amt >= r.over));

    function usage(key, rule) {
      const t = now();
      const today = ymd(t);
      const month = today.slice(0, 7);
      const year = today.slice(0, 4);
      const quarter = Math.floor(new Date(t).getMonth() / 3);
      const u = { mSum: 0, mCnt: 0, dSum: 0, dCnt: 0, yCnt: 0, ySum: 0, qCnt: 0 };
      eachItem((it, tx) => {
        if (it.k !== key) return;
        if (rule && (!inBand(rule, tx.amt) || !dayOk(rule, tx.ts))) return;
        const d = ymd(tx.ts);
        if (d.startsWith(year)) {
          u.yCnt++; u.ySum += it.v;
          if (Math.floor(new Date(tx.ts).getMonth() / 3) === quarter) u.qCnt++;
        }
        if (d.startsWith(month)) { u.mSum += it.v; u.mCnt++; }
        if (d === today) { u.dSum += it.v; u.dCnt++; }
      });
      return u;
    }

    function pooledUsed(cardId, month = thisMonth()) {
      let sum = 0;
      eachItem((it, tx) => { if (tx.card === cardId && it.pooled && ymd(tx.ts).startsWith(month)) sum += it.v; });
      return sum;
    }

    // amt가 null이면 금액 구간과 무관한 한도만 확인
    function remaining(b, amt) {
      let rem = Infinity;
      let why = '';
      let mRem = Infinity; // 금액 한도만 따로: 이번 달 / 오늘
      let dRem = Infinity;
      const t = now();
      (b.lim || []).forEach((r) => {
        const banded = r.under || r.over;
        if (banded && (amt == null || !inBand(r, amt))) return;
        if (!dayOk(r, t)) return;
        const u = usage(keyOf(b), banded || r.days || r.notDays ? r : null);
        const m = resolve(r.month); const d = resolve(r.day);
        const mc = resolve(r.monthCount); const dc = resolve(r.dayCount); const yc = resolve(r.yearCount);
        const qc = resolve(r.quarterCount); const y = resolve(r.year);
        const band = r.under ? `${man(r.under)} 미만 ` : r.over ? `${man(r.over)} 이상 ` : '';
        if (m != null) mRem = Math.min(mRem, Math.max(0, m - u.mSum));
        if (d != null) dRem = Math.min(dRem, Math.max(0, d - u.dSum));
        if (m != null && m - u.mSum < rem) { rem = Math.max(0, m - u.mSum); if (!rem) why = `${band}이번 달 한도 소진`; }
        if (d != null && d - u.dSum < rem) { rem = Math.max(0, d - u.dSum); if (!rem) why = `${band}오늘 한도 소진`; }
        if (mc != null && u.mCnt >= mc) { rem = 0; why = `${band}이번 달 ${mc}회 모두 사용`; }
        if (dc != null && u.dCnt >= dc) { rem = 0; why = `${band}오늘 ${dc}회 모두 사용`; }
        if (yc != null && u.yCnt >= yc) { rem = 0; why = `${band}올해 ${yc}회 모두 사용`; }
        if (qc != null && u.qCnt >= qc) { rem = 0; why = `${band}이번 분기 ${qc}회 모두 사용`; }
        if (y != null && y - u.ySum < rem) { rem = Math.max(0, y - u.ySum); if (!rem) why = '올해 한도 소진'; }
      });
      if (b.req && b.req.pooled) {
        const lim = pooledLimit(b);
        if (lim != null && lim - pooledUsed(b.card) < rem) {
          rem = Math.max(0, lim - pooledUsed(b.card));
          if (!rem) why = '통합한도 소진';
        }
      }
      return { rem, why, mRem, dRem };
    }

    // 화면용: 한도 규칙별 사용량·한도 (금액 구간마다 묶음)
    function limitBreakdown(b) {
      const t = now();
      const groups = [];
      (b.lim || []).forEach((r) => {
        if (!dayOk(r, t)) return;
        const banded = r.under || r.over;
        const u = usage(keyOf(b), banded || r.days || r.notDays ? r : null);
        const items = [];
        const add = (kind, lim, used) => { const L = resolve(lim); if (L != null && isFinite(L)) items.push({ kind, limit: L, used }); };
        add('month', r.month, u.mSum); add('day', r.day, u.dSum); add('year', r.year, u.ySum);
        add('monthCount', r.monthCount, u.mCnt); add('dayCount', r.dayCount, u.dCnt);
        add('quarterCount', r.quarterCount, u.qCnt); add('yearCount', r.yearCount, u.yCnt);
        if (!items.length) return;
        // 구간의 할인율 범위 (예: 3만원 이상 10~30%)
        let rate = '';
        const tiers = (b.calc && b.calc.tiers) || [];
        if (banded && tiers.length) {
          const lo = r.under ? 0 : r.over;
          const hi = r.under ? r.under : Infinity;
          const rs = tiers.filter(([m], i) => m < hi && (tiers[i + 1] ? tiers[i + 1][0] > lo : true)).map(([, p]) => p);
          if (rs.length) rate = Math.min(...rs) === Math.max(...rs) ? `${rs[0]}%` : `${Math.min(...rs)}~${Math.max(...rs)}%`;
        }
        groups.push({ label: r.under ? `${man(r.under)} 미만` : r.over ? `${man(r.over)} 이상` : '', rate, items });
      });
      return groups;
    }

    // ───── 자격 조건 ─────
    function needStatus(key) {
      const s = S();
      const checks = s.checks || {};
      if (key === 'soldier') return s.soldier == null ? null : !!s.soldier;
      if (key === 'ibkSoldier') {
        if (salaryOk('ibk') || savingOk('ibk') || (checks['ibk-proof'] && effective('ibk-proof'))) return true;
        return s.soldier === false ? false : null;
      }
      return checks[key] ? true : null;
    }

    // status: ok(받을 수 있음) / check(조건 확인 필요) / no(못 받음) / none(미보유)
    function evaluate(b, amt) {
      const s = S();
      const r = b.req || {};
      const why = [];
      const good = [];
      const missing = [];
      let status = 'ok';
      const down = (to) => { if (to === 'no' || status === 'ok') status = to; };

      if ((s.cards || []).length && !owned(b.card)) return { status: 'none', why: ['미보유 카드'], good, missing };
      if (b.verify) { down('check'); why.push('공식 확인 필요'); }
      if (b.until && new Date(b.until + 'T23:59:59').getTime() < now()) { down('no'); why.push('종료된 프로모션'); }
      if (r.salary && !salaryOk(r.salary)) {
        down('no');
        why.push(s.salary === r.salary ? '급여이체는 첫 급여 다음 달부터 인정' : `${BANK[r.salary].name} 급여이체 필요`);
      }
      (b.need || []).forEach((k) => {
        const st = needStatus(k);
        if (st === false) { down('no'); why.push(`${NEEDS[k].label} 필요`); }
        if (st == null) {
          down('check');
          const soon = k === 'ibkSoldier' && ((s.salary === 'ibk' && pending('salary')) || ((s.savings || []).includes('ibk') && pending('saving-ibk')) || ((s.checks || {})['ibk-proof'] && pending('ibk-proof')));
          why.push(soon ? `${NEEDS[k].label}: 다음 달부터` : `${NEEDS[k].label} 확인 필요`);
          missing.push(k);
        }
      });
      if (r.spend) {
        if (r.waiveSalary && salaryOk(r.waiveSalary)) {
          good.push('급여이체로 실적 면제');
        } else {
          const e = effSpend(b);
          if (e.sp == null) { down('check'); why.push(`전월 ${man(r.spend)} 이상${spendStale(b.card) ? ' (사용액 다시 입력)' : ''}`); }
          else if (e.sp < r.spend) { down('no'); why.push(`전월 ${man(r.spend)} 필요`); }
          else if (e.viaFirst) good.push('신규 발급 실적 인정');
        }
      }
      if (b.excludeFrom) {
        const sp = effSpend(b).sp;
        if (sp != null && sp >= b.excludeFrom) { down('no'); why.push(`전월 ${man(b.excludeFrom)} 이상은 All in One으로 대체`); }
        else if (sp == null) { down('check'); why.push(`전월 ${man(b.excludeFrom)} 미만일 때만`); }
      }
      if (status !== 'no' && (b.lim || (r.pooled))) {
        const left = remaining(b, amt == null ? null : amt);
        if (left.rem === 0) {
          const ex = extraUsable(b, amt);
          if (ex) good.push(`${left.why} · ${ex.b.title.replace(/.*\) ?/, '')}만 적용`);
          else { status = 'no'; why.unshift(left.why); }
        }
      }
      return { status, why, good, missing };
    }

    // extraAfter: 기본 혜택(현장할인)을 뺀 금액에 추가 혜택(캐시백)을 계산
    function extraUsable(b, amt, baseV = 0) {
      const eb = b.extra && BENEFIT[b.extra];
      if (!eb || !amt) return null;
      const amt2 = b.extraAfter ? amt - baseV : amt;
      if (amt2 <= 0 || evaluate(eb, amt2).status !== 'ok') return null;
      const ex = estimate(eb, amt2);
      return ex && ex.v > 0 ? { b: eb, v: ex.v, amt: amt2 } : null;
    }

    // ───── 예상 혜택 계산 ─────
    function estimate(b, amt) {
      const c = b.calc;
      if (!c || !amt) return null;
      const t = now();
      const unit = unitOf(b);
      if (c.below && amt >= c.below) return { v: 0, unit, note: `${man(c.below)} 미만만` };
      if (c.min && amt < c.min) return { v: 0, unit, note: `${man(c.min)} 이상 결제 시` };
      if (c.steps) {
        let v = 0;
        c.steps.forEach(([m, p]) => { if (amt >= m) v = p; });
        return limitBy(b, amt, { v, unit, note: v ? '' : `${man(c.steps[0][0])} 이상 시` });
      }
      if (c.ticket) {
        // 결제 총액을 입력한 매수로 나눠 1매 가격을 구함 (추정하지 않음)
        const total = Math.max(1, Number((ctx.getInput && ctx.getInput().tickets) || 1));
        const price = amt / total;
        const n = Math.min(c.ticket.max || 1, total);
        const each = c.ticket.pay != null ? Math.max(0, price - c.ticket.pay) : Math.min(price, c.ticket.off);
        return limitBy(b, amt, { v: Math.floor(n * each), unit, note: `${total}매 중 ${n}매 적용` });
      }
      if (c.fixed) return withExtra(b, amt, limitBy(b, amt, { v: c.fixed, unit }));
      let tiers = c.tiers || [];
      if (dayMatch(c.days, t)) tiers = c.days.tiers;
      let rate = 0;
      tiers.forEach(([m, p]) => { if (amt >= m) rate = p; });
      const wd = new Date(t).getDay();
      if (c.weekend && (wd === 0 || wd === 6)) rate = c.weekend;
      const base = c.upto ? Math.min(amt, c.upto) : amt;
      let v = (base * rate) / 100;
      if (c.cap) v = Math.min(v, c.cap);
      if (c.capUnder && amt < c.capUnder[0]) v = Math.min(v, c.capUnder[1]);
      return withExtra(b, amt, limitBy(b, amt, { v: Math.floor(v), rate, unit }));
    }

    // 결제 한 건의 기록 항목 (기본 + 중복 혜택)
    function txItems(b, x) {
      const items = [];
      const base = x.v - (x.extra ? x.extra.v : 0);
      if (base > 0) items.push({ b: b.id, k: keyOf(b), v: base, pooled: !!(b.req && b.req.pooled), unit: x.unit });
      if (x.extra) items.push({ b: x.extra.b.id, k: keyOf(x.extra.b), v: x.extra.v, pooled: !!(x.extra.b.req && x.extra.b.req.pooled), unit: unitOf(x.extra.b) });
      return items;
    }

    function limitBy(b, amt, x) {
      const left = remaining(b, amt);
      if (left.rem < x.v) {
        x.v = left.rem;
        x.note = left.rem ? '남은 한도까지만' : left.why;
        x.partial = true;
      }
      x.base = x.v;
      return x;
    }

    // 중복 적용 혜택(예: IBK PX 기본 + 특별할인) — 각자 한도로 따로 계산해서 합산
    function withExtra(b, amt, x) {
      const ex = extraUsable(b, amt, x.v);
      if (ex) { x.extra = ex; x.v += ex.v; }
      return x;
    }

    // ───── 검색·정렬 ─────
    function search(q) {
      const tokens = q.trim().split(/\s+/).map(norm).filter(Boolean).map((t) => norm(ALIAS[t] || t));
      if (!tokens.length) return [];
      const pxQuery = tokens.some((t) => PX_TERMS.some((p) => t.includes(p)));
      const strong = [];
      const weak = [];
      DATA.BENEFITS.forEach((b) => {
        if (b.sector === 'px' && !pxQuery) return;
        const sec = SECTOR[b.sector];
        const own = norm([b.title, b.where, b.kw, CARD[b.card].short, CARD[b.card].name, b.group].join(' '));
        const all = own + norm(sec.name + sec.kw);
        if (tokens.every((t) => own.includes(t))) strong.push(b);
        else if (tokens.every((t) => all.includes(t))) weak.push(b);
      });
      return strong.length ? strong : weak;
    }

    const ORDER = { ok: 0, check: 1, no: 2, none: 3 };
    function worth(x) {
      if (!x) return -1;
      const pv = S().pointValue == null ? 1 : S().pointValue;
      return x.unit === 'point' ? x.v * pv : x.v;
    }
    function rank(list, amt, visible) {
      return list
        .filter((b) => !visible || visible.includes(b.card))
        .map((b) => ({ b, e: evaluate(b, amt || null), x: estimate(b, amt) }))
        .sort((p, q) => (ORDER[p.e.status] - ORDER[q.e.status])
          || (amt ? worth(q.x) - worth(p.x) : 0)
          || (q.b.rate - p.b.rate));
    }

    // 추천은 조건이 모두 확인된 혜택만
    function bestOf(rows, amt) {
      return rows.find((r) => r.e.status === 'ok' && !r.b.addon && !r.b.verify && (!amt || !r.x || worth(r.x) > 0)) || null;
    }

    // ───── 결제 계획: 한 곳에서 쓸 금액을 여러 번(카드)으로 나눠 낼 때 가장 많이 아끼는 조합 ─────
    // 할인율 구간(3만원 미만 30% 등)·건당 최대·남은 한도를 보고 나눌 금액 후보를 만든 뒤,
    // 앞 결제를 가상으로 기록해가며 최대 max번까지 나눠 계산. 결제를 한 번 더 나누려면 PLAN_GAIN원 이상 더 아껴야 함
    const PLAN_STEP = 100;
    const PLAN_GAIN = 100;
    const up = (n) => Math.ceil(n / PLAN_STEP) * PLAN_STEP;
    function planCands(b, R) {
      const c = b.calc;
      const set = new Set([R]);
      const add = (a) => { if (a > 0 && a < R) set.add(Math.round(a)); };
      const tiers = (c.tiers || []).concat((c.days && c.days.tiers) || []);
      const marks = [...new Set([0, ...tiers.map(([m]) => m), ...(c.steps || []).map(([m]) => m)])];
      marks.forEach((m) => { add(m); add(m - PLAN_STEP); });
      if (c.min) add(c.min);
      const eb = b.extra && BENEFIT[b.extra];
      if (eb && eb.calc && eb.calc.min) add(eb.calc.min); // 중복 혜택 조건 금액 (IBK PX 특별할인 20만원)
      if (c.below) add(c.below - PLAN_STEP);
      if (c.capUnder) add(c.capUnder[0] - PLAN_STEP);
      (b.lim || []).forEach((r) => { if (r.under) add(r.under - PLAN_STEP); if (r.over) add(r.over); });
      // 건당 최대·남은 한도를 딱 채우는 금액 (그 이상은 더 내도 할인이 안 늘어남)
      marks.forEach((m) => {
        const at = Math.max(m, c.min || 0, PLAN_STEP);
        const rates = tiers.filter(([mm]) => mm <= at).map(([, p]) => p).concat(c.weekend || []).filter((p) => p > 0);
        let room = remaining(b, at).rem;
        if (c.cap) room = Math.min(room, c.cap);
        if (c.capUnder && at < c.capUnder[0]) room = Math.min(room, c.capUnder[1]);
        if (!isFinite(room)) return;
        rates.forEach((p) => add(up((room * 100) / p)));
      });
      return [...set].sort((a, b2) => b2 - a);
    }

    function plan(list, total, max = 3) {
      const pool = list.filter((b) => b.calc && !b.calc.ticket && !b.addon && !b.verify);
      const pay = (b, amt) => {
        if (evaluate(b, amt).status !== 'ok') return null;
        const x = estimate(b, amt);
        return x && x.v > 0 ? { b, amt, x, w: worth(x) } : null;
      };
      const bestFor = (R) => {
        let p = null;
        pool.forEach((b) => { const q = pay(b, R); if (q && (!p || q.w > p.w)) p = q; });
        return p || { b: null, amt: R, x: null, w: 0 };
      };
      if (!total || total <= 0) return null;
      const t = now();
      let best = null;
      const consider = (pays) => {
        const w = pays.reduce((s, p) => s + p.w, 0);
        const score = w - PLAN_GAIN * (pays.length - 1);
        if (!best || score > best.score) best = { pays, w, score };
      };
      const hold = (p) => virtual.push({ id: 'plan', ts: t, card: p.b.card, amt: p.amt, items: txItems(p.b, p.x) });
      const prev = virtual;
      virtual = [];
      let single;
      try {
        single = bestFor(total);
        // 후보가 너무 많으면(넓은 검색어) 계산량을 줄이려고 2번까지만 나눔
        const size = pool.reduce((s, b) => s + planCands(b, total).length, 0);
        const depthMax = size > 60 ? Math.min(max, 2) : max;
        const dfs = (R, pays, start) => {
          consider(pays.concat(bestFor(R)));
          if (pays.length + 1 >= depthMax) return;
          pool.forEach((b, i) => {
            if (i < start) return;
            planCands(b, R).forEach((a) => {
              if (a >= R) return;
              const p = pay(b, a);
              if (!p) return;
              hold(p);
              dfs(R - a, pays.concat(p), i);
              virtual.pop();
            });
          });
        };
        dfs(total, [], 0);
      } finally {
        virtual = prev;
      }
      return { total, pays: best.pays, saved: best.w, single, gain: best.w - single.w };
    }

    return {
      CARD, SECTOR, BANK, BENEFIT, NEEDS, TICKET_PRICE,
      ymd, thisMonth, addMonth, won, man, norm,
      spendOf, spendStale, firstActive, cardLimit, pooledUsed, usage, remaining,
      needStatus, evaluate, estimate, search, rank, bestOf, keyOf, effective, limitBreakdown,
      txItems, unitOf, plan, worth,
    };
  }

  // ───── 저장 데이터 검증 (불러오기·백업 복원 공용) ─────
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const MONTH = /^\d{4}-\d{2}$/;
  function sanitizeSettings(DATA, raw) {
    const cards = new Set(DATA.CARDS.map((c) => c.id));
    const banks = new Set(DATA.BANKS.map((b) => b.id));
    const r = isObj(raw) ? raw : {};
    const numMap = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([k, v]) => cards.has(k) && Number.isFinite(v) && v >= 0));
    const monthMap = (o, keys) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([k, v]) => (!keys || keys.has(k)) && MONTH.test(v)));
    return {
      cards: Array.isArray(r.cards) ? DATA.CARDS.map((c) => c.id).filter((id) => r.cards.includes(id)) : [],
      salary: banks.has(r.salary) ? r.salary : null,
      savings: Array.isArray(r.savings) ? r.savings.filter((b) => banks.has(b)) : [],
      spend: numMap(r.spend),
      spendAt: monthMap(r.spendAt, cards),
      firstUse: monthMap(r.firstUse, cards),
      since: monthMap(r.since),
      soldier: typeof r.soldier === 'boolean' ? r.soldier : null,
      checks: Object.fromEntries(Object.entries(isObj(r.checks) ? r.checks : {}).filter(([, v]) => v === true)),
      pointValue: r.pointValue === 0 ? 0 : 1,
      showAll: r.showAll === true,
      onboarded: r.onboarded === true,
    };
  }
  function isTx(DATA, t) {
    const cards = new Set(DATA.CARDS.map((c) => c.id));
    return isObj(t) && typeof t.id === 'string' && Number.isFinite(t.ts) && t.ts > 0 && cards.has(t.card)
      && Number.isFinite(t.amt) && t.amt >= 0 && Array.isArray(t.items) && t.items.length > 0
      && t.items.every((i) => isObj(i) && typeof i.b === 'string' && typeof i.k === 'string' && Number.isFinite(i.v) && i.v >= 0);
  }

  return { create, NEEDS, sanitizeSettings, isTx };
}));
