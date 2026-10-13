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
  const PX_TERMS = ['px', '군마트', '해군마트', '해군', '충성마트', '영외마트', '군매점', '군부대'];
  // 결제 경로 선택지 (결과에 영향을 줄 때만 화면에 물어봄, null = 모름)
  const ROUTES = {
    px: { label: '어디 PX인가요?', opts: [['general', '일반 PX·군마트'], ['navy', 'GS25 해군마트']] },
    channel: { label: '어떻게 결제하나요?', opts: [['offline', '매장에서 카드로'], ['app', '공식 앱·웹'], ['pay', '간편결제(페이)']] },
    promo: { label: '행사상품인가요?', opts: [['all', '전부 행사상품'], ['none', '행사상품 아님']] },
  };

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const md = (t) => ymd(t).slice(5);
  const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
  const man = (n) => (n >= 10000 ? (n / 10000).toLocaleString('ko-KR') + '만원' : won(n));
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s·,()/._\-‘’'"]/g, '');
  // 받침에 맞는 조사: josa('신한', '으로/로') → '신한으로', josa('IBK', '은/는') → 'IBK는'
  // 영문·숫자는 읽는 소리 기준 (L·M·N·R, 0·1·3·6·7·8은 받침, 1·7·8·L·R은 ㄹ받침)
  function josa(word, pair) {
    const w = String(word ?? '');
    const [withB, noB] = pair.split('/');
    const ch = w.trim().slice(-1);
    const code = ch.charCodeAt(0);
    let batchim = false;
    let rieul = false;
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const jong = (code - 0xAC00) % 28;
      batchim = jong !== 0;
      rieul = jong === 8;
    } else if (/[0-9]/.test(ch)) {
      batchim = '013678'.includes(ch);
      rieul = '178'.includes(ch);
    } else if (/[a-z]/i.test(ch)) {
      batchim = 'LMNR'.includes(ch.toUpperCase());
      rieul = 'LR'.includes(ch.toUpperCase());
    }
    if (withB === '으로') return w + (batchim && !rieul ? '으로' : '로');
    return w + (batchim ? withB : noB);
  }
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

    function usage(key, rule, after) {
      const t = now();
      const today = ymd(t);
      const month = today.slice(0, 7);
      const year = today.slice(0, 4);
      const quarter = Math.floor(new Date(t).getMonth() / 3);
      const u = { mSum: 0, mCnt: 0, dSum: 0, dCnt: 0, yCnt: 0, ySum: 0, qCnt: 0 };
      eachItem((it, tx) => {
        if (it.k !== key) return;
        if (after != null && !(tx.ts > after)) return;
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

    function pooledUsed(cardId, month = thisMonth(), after) {
      let sum = 0;
      eachItem((it, tx) => { if (tx.card === cardId && it.pooled && ymd(tx.ts).startsWith(month) && (after == null || tx.ts > after)) sum += it.v; });
      return sum;
    }

    // ───── 남은 한도 직접 맞추기 ─────
    // 설정 adjust: [{ id, card, key, ri, kind, left, at }] — '카드사 앱에서 at 시점에 본 남은 양 = left'
    //  · 가짜 거래로 저장하지 않음. 그 기간의 사용량 = (한도 − left) + at 이후 기록 사용량 → at 이전 기록은 다시 빼지 않음
    //  · 기간(일·월·분기·연)이 바뀌면 효력 없음. at 이후 기록을 취소하면 그만큼 자동 복원
    //  · 통합한도는 key 'pooled', ri −1 (혜택별 한도와 따로 적용)
    const ADJ_FIELD = { month: 'mSum', day: 'dSum', year: 'ySum', monthCount: 'mCnt', dayCount: 'dCnt', quarterCount: 'qCnt', yearCount: 'yCnt' };
    function samePeriod(kind, a, b) {
      const da = new Date(a); const db = new Date(b);
      if (kind === 'day' || kind === 'dayCount') return ymd(a) === ymd(b);
      if (kind === 'year' || kind === 'yearCount') return da.getFullYear() === db.getFullYear();
      if (kind === 'quarterCount') return da.getFullYear() === db.getFullYear() && Math.floor(da.getMonth() / 3) === Math.floor(db.getMonth() / 3);
      return ymd(a).slice(0, 7) === ymd(b).slice(0, 7); // month, monthCount, pooled
    }
    function adjFor(card, key, ri, kind) {
      const t = now();
      let hit = null;
      (S().adjust || []).forEach((a) => {
        if (a.card === card && a.key === key && a.ri === ri && a.kind === kind && a.at <= t && samePeriod(kind, a.at, t) && (!hit || a.at > hit.at)) hit = a;
      });
      return hit;
    }
    // 규칙별 사용량에 맞춘 값을 반영 (한도가 정의된 항목만)
    function adjUsage(b, ri, r, u) {
      const out = Object.assign({}, u);
      const key = keyOf(b);
      Object.keys(ADJ_FIELD).forEach((kind) => {
        const L = resolve(r[kind]);
        if (L == null || !isFinite(L)) return;
        const a = adjFor(b.card, key, ri, kind);
        if (!a) return;
        const after = usage(key, r.under || r.over || r.days || r.notDays ? r : null, a.at);
        const f = ADJ_FIELD[kind];
        out[f] = L - Math.max(0, a.left - after[f]);
        out.adj = out.adj || {};
        out.adj[kind] = a;
      });
      return out;
    }
    // 통합한도: { lim, used, left, adj } — 맞춘 값이 있으면 lim을 몰라도 left를 앎
    function pooledState(cardId, lim) {
      const a = adjFor(cardId, 'pooled', -1, 'month');
      if (a) {
        const left = Math.max(0, a.left - pooledUsed(cardId, thisMonth(), a.at));
        return { lim, left, used: lim != null ? Math.max(0, lim - left) : null, adj: a };
      }
      if (lim == null) return { lim, left: null, used: pooledUsed(cardId), adj: null };
      const used = pooledUsed(cardId);
      return { lim, left: Math.max(0, lim - used), used, adj: null };
    }

    // amt가 null이면 금액 구간과 무관한 한도만 확인
    function remaining(b, amt) {
      let rem = Infinity;
      let why = '';
      let mRem = Infinity; // 금액 한도만 따로: 이번 달 / 오늘
      let dRem = Infinity;
      const t = now();
      (b.lim || []).forEach((r, ri) => {
        const banded = r.under || r.over;
        if (banded && (amt == null || !inBand(r, amt))) return;
        if (!dayOk(r, t)) return;
        const u = adjUsage(b, ri, r, usage(keyOf(b), banded || r.days || r.notDays ? r : null));
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
        const ps = pooledState(b.card, pooledLimit(b));
        if (ps.left != null && ps.left < rem) {
          rem = ps.left;
          if (!rem) why = '통합한도 소진';
        }
      }
      return { rem, why, mRem, dRem };
    }

    // 화면용: 한도 규칙별 사용량·한도 (금액 구간마다 묶음)
    function limitBreakdown(b) {
      const t = now();
      const groups = [];
      (b.lim || []).forEach((r, ri) => {
        if (!dayOk(r, t)) return;
        const banded = r.under || r.over;
        const u = adjUsage(b, ri, r, usage(keyOf(b), banded || r.days || r.notDays ? r : null));
        const items = [];
        const add = (kind, lim, used) => { const L = resolve(lim); if (L != null && isFinite(L)) items.push({ kind, limit: L, used: Math.max(0, used), ri, adj: (u.adj || {})[kind] || null }); };
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

    // ───── 결제 경로 ─────
    const route = () => (ctx.getRoute && ctx.getRoute()) || {};
    // ok: 경로가 맞음 / unknown: 사용자가 아직 모름 / no: 경로가 달라 적용 안 됨
    function routeCheck(b) {
      const r = b.route;
      if (!r) return { st: 'ok', keys: [] };
      const cur = route();
      const keys = [];
      let why = '';
      if (r.channel) {
        if (cur.channel == null) keys.push('channel');
        else if (!r.channel.includes(cur.channel)) why = r.channel.length === 1 && r.channel[0] === 'offline' ? '매장 카드 결제만 적용' : '이 결제 방법은 적용 안 돼요';
      }
      if (r.promo) {
        if (cur.promo == null) keys.push('promo');
        else if (cur.promo === 'none') why = why || '행사상품만 적용';
      }
      if (why) return { st: 'no', keys, why };
      return { st: keys.length ? 'unknown' : 'ok', keys };
    }
    // 이 혜택 목록에서 결과가 달라지는 경로 질문만 (모든 검색에서 다 묻지 않음)
    // 대체 혜택(fallbackIf)은 원래 혜택의 횟수·한도를 다 썼을 때만 물어봄
    function routeKeys(list, amt) {
      const keys = new Set();
      list.forEach((b) => {
        Object.keys(b.route || {}).forEach((k) => keys.add(k));
        const eb = b.extra && BENEFIT[b.extra];
        Object.keys((eb && eb.route) || {}).forEach((k) => keys.add(k));
        if (b.fallback && remaining(b, amt || null).rem === 0) Object.keys(b.fallbackIf || {}).forEach((k) => keys.add(k));
      });
      return Object.keys(ROUTES).filter((k) => keys.has(k));
    }
    // 신한 GS25 해군마트: PX 횟수·한도를 다 쓴 결제는 Life 편의점으로 (한 결제의 1천원 초과분에 덧붙이지 않음)
    function fallbackOf(b, amt) {
      const fb = b.fallback && BENEFIT[b.fallback];
      if (!fb || !amt) return null;
      const cur = route();
      if (!Object.entries(b.fallbackIf || {}).every(([k, v]) => cur[k] === v)) return null;
      if (remaining(b, amt).rem !== 0) return null;
      if (evaluate(fb, amt, true).status !== 'ok') return null;
      const x = estimate(fb, amt);
      return x && x.v > 0 ? { b: fb, x } : null;
    }

    // status: ok(받을 수 있음) / check(조건 확인 필요) / no(못 받음) / none(미보유)
    // inStore: 대체 혜택 판정용 — 해군마트 매장 결제이므로 결제 경로 조건은 이미 충족
    function evaluate(b, amt, inStore) {
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
      const rc = inStore ? { st: 'ok', keys: [] } : routeCheck(b);
      if (rc.st === 'no') { down('no'); why.push(rc.why); }
      if (b.excludeFrom) {
        const sp = effSpend(b).sp;
        if (sp != null && sp >= b.excludeFrom) { down('no'); why.push(`전월 ${man(b.excludeFrom)} 이상은 All in One으로 대체`); }
        else if (sp == null) { down('check'); why.push(`전월 ${man(b.excludeFrom)} 미만일 때만`); }
      }
      if (status !== 'no' && (b.lim || (r.pooled))) {
        const left = remaining(b, amt == null ? null : amt);
        if (left.rem === 0) {
          const ex = extraUsable(b, amt);
          const fb = fallbackOf(b, amt);
          if (ex) good.push(`${left.why} · ${ex.b.title.replace(/.*\) ?/, '')}만 적용`);
          else if (fb) good.push(`${left.why} · ${CARD[fb.b.card].short} ${fb.b.title} 적용`);
          else {
            status = 'no';
            why.unshift(left.why);
            if (b.fallback && route().px == null) why.push('GS25 해군마트면 편의점 혜택 가능');
          }
        }
      }
      return { status, why, good, missing, route: rc.keys };
    }

    // extraAfter: 기본 혜택(현장할인)을 뺀 금액에 추가 혜택(캐시백)을 계산
    function extraUsable(b, amt, baseV = 0) {
      const eb = b.extra && BENEFIT[b.extra];
      if (!eb || !amt) return null;
      const amt2 = b.extraAfter ? amt - baseV : amt;
      if (amt2 <= 0 || evaluate(eb, amt2).status !== 'ok') return null;
      const ex = estimate(eb, amt2);
      if (!ex || !(ex.v > 0)) return null;
      // 추가 혜택의 경로를 모르면 확정 합산하지 않고 '조건 충족 시'로 분리
      return { b: eb, v: ex.v, amt: amt2, cond: routeCheck(eb).st === 'unknown' };
    }

    // ───── 예상 혜택 계산 ─────
    function estimate(b, amt) {
      const x = estimateOwn(b, amt);
      if (x && !(x.v > 0) && b.fallback) {
        const fb = fallbackOf(b, amt);
        if (fb) return Object.assign({}, fb.x, { fallback: fb.b, note: `${b.title.replace(/ \(.*/, '')} 횟수·한도 소진 → ${fb.b.title}` });
      }
      return x;
    }
    function estimateOwn(b, amt) {
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
      if (x.fallback) b = x.fallback;
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
      if (ex && ex.cond) x.condExtra = ex;
      else if (ex) { x.extra = ex; x.v += ex.v; }
      return x;
    }

    // ───── 검색·정렬 ─────
    // 업종 검색(카페·편의점·PX…)은 그 업종 혜택 전체, 그 밖의 말은 특정 가맹점으로 보고 그 가맹점 혜택만
    // visible: 보여줄 카드 — 카드를 먼저 거른 뒤 후보를 정해서 보유 카드 혜택이 잘려 나가지 않게
    const CARD_WORDS = Object.fromEntries(DATA.CARDS.flatMap((c) => [[norm(c.short), c.id], [norm(c.short + '카드'), c.id]]).concat([['국민', 'kb'], ['기업', 'ibk'], ['기업은행', 'ibk']]));
    function searchIntent(q) {
      const words = q.trim().split(/\s+/).map(norm).filter(Boolean).map((t) => norm(ALIAS[t] || t));
      const cards = words.filter((t) => CARD_WORDS[t]).map((t) => CARD_WORDS[t]);
      const tokens = words.filter((t) => !CARD_WORDS[t]);
      const whole = tokens.join('');
      const sectorOf = (t) => DATA.SECTORS.find((s) => (s.terms || []).includes(t));
      let sec = whole ? sectorOf(norm(ALIAS[whole] || whole)) : null;
      if (!sec && tokens.length) {
        const ss = tokens.map(sectorOf);
        if (ss.every((x) => x && x === ss[0])) sec = ss[0];
      }
      return { tokens, cards, sector: sec ? sec.id : null };
    }
    function search(q, visible) {
      const it = searchIntent(q);
      if (!it.tokens.length && !it.cards.length) return [];
      const pool = DATA.BENEFITS.filter((b) => (!visible || visible.includes(b.card)) && (!it.cards.length || it.cards.includes(b.card)));
      if (it.sector) return pool.filter((b) => b.sector === it.sector);
      if (!it.tokens.length) return pool.filter((b) => b.sector !== 'px');
      const pxQuery = it.tokens.some((t) => PX_TERMS.some((p) => t.includes(p)));
      const strong = [];
      const weak = [];
      pool.forEach((b) => {
        if (b.sector === 'px' && !pxQuery) return;
        const sec = SECTOR[b.sector];
        const own = norm([b.title, b.where, b.kw, b.group].join(' '));
        const all = own + norm(sec.name + sec.kw);
        if (it.tokens.every((t) => own.includes(t))) strong.push(b);
        else if (it.tokens.every((t) => all.includes(t))) weak.push(b);
      });
      return strong.length ? strong : weak;
    }

    // 추천 이유 한두 줄과 차선 — 엔진 판정 결과로 만듦
    function explain(rows, amt) {
      const top = bestOf(rows, amt);
      if (!top) return null;
      const lines = [];
      const x = top.x;
      if (x && x.fallback) lines.push('PX 횟수·한도를 다 써서 Life 편의점 20%가 대신 적용돼요');
      else if (x && x.partial) lines.push(`남은 한도까지만 적용돼요 (${won(x.v)})`);
      else if (amt) {
        const left = remaining(top.b, amt);
        const v = x ? x.base != null ? x.base : x.v : 0;
        const fit = (when, r) => (v >= r ? `이번 결제로 ${when} 남은 한도 ${won(r)}을 다 써요` : `${when} 남은 한도 ${won(r)} 안에서 적용돼요`);
        if (isFinite(left.dRem) && left.dRem <= left.mRem) lines.push(fit('오늘', left.dRem));
        else if (isFinite(left.mRem)) lines.push(fit('이번 달', left.mRem));
        else if (isFinite(left.rem)) lines.push(`남은 한도 ${won(left.rem)} 안에서 적용돼요`);
        else lines.push('이 금액에서 할인이 가장 커요');
      }
      const others = rows.filter((r) => r.b.card !== top.b.card && !r.b.addon);
      const spent = others.find((r) => r.e.status === 'no' && /소진|모두 사용/.test(r.e.why[0] || ''));
      const check = others.find((r) => r.e.status === 'check' && !r.b.verify);
      if (spent) lines.push(`${josa(CARD[spent.b.card].short, '은/는')} ${josa(spent.e.why[0], '이라/라')} 제외했어요`);
      else if (check) lines.push(`${josa(CARD[check.b.card].short, '은/는')} 조건 확인이 필요해 추천에서 뺐어요`);
      if (x && x.condExtra) lines.push(`${ROUTE_HINT(top.b)} ${won(x.condExtra.v)} 추가 가능해요`);
      else if (top.e.route && top.e.route.length) lines.push('결제 방법·대상 조건을 고르면 더 정확해져요');
      const alt = rows.find((r) => r !== top && r.e.status === 'ok' && !r.b.addon && !r.b.verify && (!amt || (r.x && worth(r.x) > 0)) && r.b.card !== top.b.card)
        || rows.find((r) => r !== top && r.e.status === 'ok' && !r.b.addon && !r.b.verify && (!amt || (r.x && worth(r.x) > 0)));
      return { top, lines: lines.slice(0, 2), alt: alt || null };
    }
    function ROUTE_HINT(b) {
      const eb = b.extra && BENEFIT[b.extra];
      const ch = eb && eb.route && eb.route.channel;
      return ch && ch.length === 1 && ch[0] === 'offline' ? '매장에서 카드로 결제하면' : '조건을 확인하면';
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
    const PLAN_GAIN = 500; // 기본: 한 번 더 나눌 때마다 500원 이상 더 아껴야 나눔
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

    // opts: { max: 최대 결제 횟수(1~3), gain: 결제를 1회 더 늘릴 때마다 필요한 추가 절약액 }
    // 고르는 순서: (절약액 − gain × 추가 횟수)가 큰 것 → 같으면 절약액이 큰 것(추가 절약이 기준과 딱 같으면 나눔)
    //             → 그래도 같으면 결제 횟수가 적은 것. 후보 금액만 살펴보는 탐색이라 '최대 N회 기준 추천 조합'
    function plan(list, total, opts) {
      const o = typeof opts === 'number' ? { max: opts } : (opts || {});
      const max = Math.max(1, Math.min(3, o.max || 3));
      const GAIN = o.gain == null ? PLAN_GAIN : o.gain;
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
        const score = w - GAIN * (pays.length - 1);
        if (!best || score > best.score || (score === best.score && (w > best.w || (w === best.w && pays.length < best.pays.length)))) best = { pays, w, score };
      };
      const hold = (p) => virtual.push({ id: 'plan', ts: t, card: p.b.card, amt: p.amt, items: txItems(p.b, p.x) });
      const prev = virtual;
      virtual = [];
      let single;
      let depthMax = max;
      try {
        single = bestFor(total);
        // 후보가 너무 많으면(넓은 검색어) 계산량을 줄이려고 2번까지만 나눔
        const size = pool.reduce((s, b) => s + planCands(b, total).length, 0);
        if (size > 60) depthMax = Math.min(max, 2);
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
      return { total, pays: best.pays, saved: best.w, single, gain: best.w - single.w, max, rule: GAIN, limited: depthMax < max };
    }

    return {
      CARD, SECTOR, BANK, BENEFIT, NEEDS, TICKET_PRICE,
      ymd, thisMonth, addMonth, won, man, norm, josa,
      spendOf, spendStale, firstActive, cardLimit, pooledUsed, usage, remaining,
      needStatus, evaluate, estimate, search, searchIntent, rank, bestOf, explain, keyOf, effective, limitBreakdown, routeKeys, routeCheck, ROUTES,
      txItems, unitOf, plan, worth, PLAN_GAIN, pooledState, adjFor, samePeriod, pooledLimitOf: (id) => cardLimit(id),
    };
  }

  // ───── 저장 데이터 검증 (불러오기·백업 복원 공용) ─────
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const MONTH = /^\d{4}-\d{2}$/;
  const ADJ_KINDS = ['month', 'day', 'year', 'monthCount', 'dayCount', 'quarterCount', 'yearCount'];
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
      splitGain: [100, 500, 1000].includes(r.splitGain) ? r.splitGain : 500,
      favs: favList(r.favs),
      adjust: (Array.isArray(r.adjust) ? r.adjust : []).filter((a) => isObj(a) && typeof a.id === 'string' && cards.has(a.card) && typeof a.key === 'string'
        && Number.isInteger(a.ri) && a.ri >= -1 && ADJ_KINDS.includes(a.kind) && Number.isFinite(a.left) && a.left >= 0 && Number.isFinite(a.at) && a.at > 0).slice(-200)
        .map((a) => ({ id: a.id, card: a.card, key: a.key, ri: a.ri, kind: a.kind, left: a.left, at: a.at })),
      showAll: r.showAll === true,
      onboarded: r.onboarded === true,
    };
  }
  // 즐겨찾기: [{ q, route }] — route는 저장할 때 고른 결제 경로 (null = 모름)
  const ROUTE_VALS = { px: ['general', 'navy'], channel: ['offline', 'app', 'pay'], promo: ['all', 'none'] };
  function favList(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : []).filter((f) => isObj(f) && typeof f.q === 'string' && f.q.trim() && f.q.length <= 30)
      .filter((f) => { const k = f.q.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 20)
      .map((f) => ({ q: f.q.trim(), route: Object.fromEntries(Object.entries(isObj(f.route) ? f.route : {}).filter(([k, v]) => (ROUTE_VALS[k] || []).includes(v))) }));
  }
  function isTx(DATA, t) {
    const cards = new Set(DATA.CARDS.map((c) => c.id));
    return isObj(t) && typeof t.id === 'string' && Number.isFinite(t.ts) && t.ts > 0 && cards.has(t.card)
      && Number.isFinite(t.amt) && t.amt >= 0 && Array.isArray(t.items) && t.items.length > 0
      && t.items.every((i) => isObj(i) && typeof i.b === 'string' && typeof i.k === 'string' && Number.isFinite(i.v) && i.v >= 0);
  }

  // 백업 가져오기용 엄격 검증: 혜택이 있고 카드가 맞는지, 한도 키·단위·boolean, 중복 id
  // 과거 금액(v)은 그 당시 계산이라 현재 약관으로 다시 계산해 덮어쓰지 않음
  function cleanImportTx(DATA, list, fixId) {
    const BEN = Object.fromEntries(DATA.BENEFITS.map((b) => [b.id, b]));
    const seen = new Set();
    const out = [];
    let dropped = 0;
    (Array.isArray(list) ? list : []).forEach((t) => {
      const fixed = isObj(t) && Array.isArray(t.items) ? Object.assign({}, t, { items: t.items.map((i) => (isObj(i) ? Object.assign({}, i, { b: fixId(i.b), k: fixId(i.k) }) : i)) }) : t;
      const ok = isTx(DATA, fixed) && !seen.has(fixed.id) && fixed.ts <= Date.now() + 864e5
        && fixed.items.every((i) => BEN[i.b] && BEN[i.b].card === fixed.card && ['won', 'point', 'use'].includes(i.unit || 'won') && (i.pooled == null || typeof i.pooled === 'boolean'));
      if (!ok) { dropped++; return; }
      seen.add(fixed.id);
      const tx = { id: fixed.id, ts: fixed.ts, card: fixed.card, amt: fixed.amt,
        items: fixed.items.map((i) => ({ b: i.b, k: BEN[i.b].limKey || BEN[i.b].id, v: i.v, pooled: !!i.pooled, unit: i.unit || 'won' })) };
      if (fixed.edited === true) tx.edited = true;
      if (typeof fixed.plan === 'string') tx.plan = fixed.plan;
      out.push(tx);
    });
    return { tx: out, dropped };
  }

  return { create, NEEDS, sanitizeSettings, isTx, cleanImportTx, josa };
}));
