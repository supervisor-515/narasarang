(function () {
  'use strict';

  const { BANKS, CARDS, SECTORS, BENEFITS, UPDATED } = window.DATA;
  const CARD = Object.fromEntries(CARDS.map((c) => [c.id, c]));
  const SECTOR = Object.fromEntries(SECTORS.map((s) => [s.id, s]));
  const BANK = Object.fromEntries(BANKS.map((b) => [b.id, b]));

  const SPEND_OPTIONS = [
    [null, '모름'], [0, '8만원 미만'], [80000, '8만원 이상'], [100000, '10만원 이상'], [200000, '20만원 이상'],
    [250000, '25만원 이상'], [300000, '30만원 이상'], [500000, '50만원 이상'], [700000, '70만원 이상'], [1000000, '100만원 이상'],
  ];
  const QUICK = ['PX', '편의점', '스타벅스', '택시', '배달의민족', 'KTX', 'CGV', '지하철', '놀이공원', '넷플릭스', '쿠팡', '아웃백'];

  // ───────── 저장소 ─────────
  const KEY = 'narasarang.settings.v1';
  const defaults = () => ({ cards: [], salary: null, savings: [], spend: {}, showAll: false, onboarded: false });
  function load() {
    try { return Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return defaults(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* 저장 불가 환경 */ }
  }
  let S = load();

  // 결제 기록: 확정한 결제를 쌓아 월·일 한도와 횟수를 차감
  const LEDGER_KEY = 'narasarang.ledger.v1';
  function loadLedger() {
    try {
      const cut = Date.now() - 400 * 864e5; // 연 횟수 계산용으로 13개월치만 보관
      return (JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]') || []).filter((e) => e && e.ts > cut);
    } catch (e) { return []; }
  }
  function saveLedger() {
    try { localStorage.setItem(LEDGER_KEY, JSON.stringify(LEDGER)); } catch (e) { /* 저장 불가 환경 */ }
  }
  let LEDGER = loadLedger();

  const ui = { tab: S.onboarded ? 'home' : 'settings', q: '', amount: 0, sector: 'px', card: null, open: new Set() };
  const BENEFIT = Object.fromEntries(BENEFITS.map((b) => [b.id, b]));

  // ───────── 유틸 ─────────
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
  const man = (n) => (n >= 10000 ? (n / 10000).toLocaleString('ko-KR') + '만원' : won(n));
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s·,()/._\-]/g, '');
  const cardVars = (c) => `--c1:${c.color};--c2:${c.color2};--ct:${c.text}`;
  const owned = (id) => S.cards.includes(id);
  const visibleCards = () => (S.showAll || S.cards.length === 0 ? CARDS.map((c) => c.id) : S.cards);
  const resolve = (v) => (typeof v === 'function' ? v(S) : v);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const thisMonth = () => ymd(Date.now()).slice(0, 7);
  const monthEntries = () => { const m = thisMonth(); return LEDGER.filter((e) => ymd(e.ts).startsWith(m)); };

  // ───────── 한도 차감 ─────────
  const inBand = (r, amt) => !(r.under && !(amt < r.under)) && !(r.over && !(amt >= r.over));

  function usage(key, rule) {
    const today = ymd(Date.now());
    const u = { mSum: 0, mCnt: 0, dSum: 0, dCnt: 0, yCnt: 0 };
    const year = today.slice(0, 4);
    const month = today.slice(0, 7);
    LEDGER.forEach((e) => {
      if (e.k !== key || (rule && !inBand(rule, e.amt))) return;
      const d = ymd(e.ts);
      if (d.startsWith(year)) u.yCnt++;
      if (d.startsWith(month)) { u.mSum += e.v; u.mCnt++; }
      if (d === today) { u.dSum += e.v; u.dCnt++; }
    });
    return u;
  }

  function pooledUsed(cardId) {
    return monthEntries().filter((e) => e.card === cardId && e.pooled).reduce((a, e) => a + e.v, 0);
  }

  // amt가 null이면 금액 구간과 무관한 한도만 확인
  function remaining(b, amt) {
    let rem = Infinity;
    let why = '';
    const key = b.limKey || b.id;
    (b.lim || []).forEach((r) => {
      const banded = r.under || r.over;
      if (banded && (amt == null || !inBand(r, amt))) return;
      const u = usage(key, banded ? r : null);
      const m = resolve(r.month); const d = resolve(r.day);
      const mc = resolve(r.monthCount); const dc = resolve(r.dayCount); const yc = resolve(r.yearCount);
      const band = r.under ? `${man(r.under)} 미만 ` : r.over ? `${man(r.over)} 이상 ` : '';
      if (m != null && m - u.mSum < rem) { rem = Math.max(0, m - u.mSum); if (!rem) why = `${band}이번 달 한도 소진`; }
      if (d != null && d - u.dSum < rem) { rem = Math.max(0, d - u.dSum); if (!rem) why = `${band}오늘 한도 소진`; }
      if (mc != null && u.mCnt >= mc) { rem = 0; why = `${band}이번 달 ${mc}회 모두 사용`; }
      if (dc != null && u.dCnt >= dc) { rem = 0; why = `${band}오늘 ${dc}회 모두 사용`; }
      if (yc != null && u.yCnt >= yc) { rem = 0; why = `${band}올해 ${yc}회 모두 사용`; }
    });
    if (b.req && b.req.pooled) {
      const lim = tierLimit(CARD[b.card], S.spend[b.card]);
      if (lim != null && lim - pooledUsed(b.card) < rem) {
        rem = Math.max(0, lim - pooledUsed(b.card));
        if (!rem) why = '통합한도 소진';
      }
    }
    return { rem, why };
  }

  // ───────── 조건 판정 ─────────
  function evaluate(b, amt = ui.amount || null) {
    const r = b.req || {};
    const why = [];
    let status = 'ok';
    if (r.salary && S.salary !== r.salary) {
      status = 'no';
      why.push(`${BANK[r.salary].name} 급여이체 필요`);
    }
    if (r.spend) {
      if (r.waiveSalary && S.salary === r.waiveSalary) {
        why.push('급여이체로 실적 면제');
      } else {
        const sp = S.spend[b.card];
        if (sp == null) {
          if (status === 'ok') status = 'check';
          why.push(`전월 ${man(r.spend)} 이상`);
        } else if (sp < r.spend) {
          status = 'no';
          why.push(`전월 ${man(r.spend)} 필요`);
        }
      }
    }
    if (b.until && new Date(b.until + 'T23:59:59') < new Date()) {
      status = 'no';
      why.push('종료된 프로모션');
    }
    if (!owned(b.card) && S.cards.length) {
      return { status: 'none', why: ['미보유 카드'] };
    }
    if (status !== 'no' && (b.lim || (b.req && b.req.pooled))) {
      const left = remaining(b, amt);
      if (left.rem === 0 && status !== 'no') { status = 'no'; why.unshift(left.why); }
    }
    return { status, why };
  }

  function estimate(b, amt) {
    const c = b.calc;
    if (!c || !amt) return null;
    if (c.min && amt < c.min) return { v: 0, note: `${man(c.min)} 이상 결제 시` };
    if (c.steps) {
      let v = 0;
      c.steps.forEach(([m, p]) => { if (amt >= m) v = p; });
      return limitBy(b, amt, { v, note: v ? 'P 적립' : `${man(c.steps[0][0])} 이상 시` });
    }
    if (c.fixed) return limitBy(b, amt, { v: c.fixed });
    let rate = 0;
    (c.tiers || []).forEach(([m, p]) => { if (amt >= m) rate = p; });
    const base = c.upto ? Math.min(amt, c.upto) : amt;
    let v = (base * rate) / 100;
    if (c.cap) v = Math.min(v, c.cap);
    if (c.capUnder && amt < c.capUnder[0]) v = Math.min(v, c.capUnder[1]);
    return limitBy(b, amt, { v: Math.floor(v), rate });
  }

  function limitBy(b, amt, x) {
    const left = remaining(b, amt);
    if (left.rem < x.v) {
      x.v = left.rem;
      x.note = left.rem ? '남은 한도까지만' : left.why;
      x.partial = true;
    }
    return x;
  }

  function tierLimit(card, spend) {
    if (spend == null) return null;
    let lim = 0;
    card.tiers.forEach(([m, l]) => { if (spend >= m) lim = l; });
    return lim;
  }

  const ORDER = { ok: 0, check: 1, no: 2, none: 3 };
  function ranked(list) {
    return list
      .filter((b) => visibleCards().includes(b.card))
      .map((b) => ({ b, e: evaluate(b), x: estimate(b, ui.amount) }))
      .sort((p, q) => (ORDER[p.e.status] - ORDER[q.e.status])
        || (ui.amount ? ((q.x ? q.x.v : -1) - (p.x ? p.x.v : -1)) : 0)
        || (q.b.rate - p.b.rate));
  }

  function search(q) {
    const tokens = q.trim().split(/\s+/).map(norm).filter(Boolean);
    if (!tokens.length) return [];
    return BENEFITS.filter((b) => {
      const sec = SECTOR[b.sector];
      const hay = norm([b.title, b.where, b.kw, sec.name, sec.kw, CARD[b.card].short, CARD[b.card].name, b.group].join(' '));
      return tokens.every((t) => hay.includes(t));
    });
  }

  // ───────── 렌더링 조각 ─────────
  function logo(c) {
    return `<div class="logo" style="${cardVars(c)}">${esc(c.short)}</div>`;
  }

  function statusPill(e) {
    if (e.status === 'ok') return `<span class="pill ok">✓ 받을 수 있어요</span>`;
    if (e.status === 'check') return `<span class="pill check">실적 확인 · ${esc(e.why.join(' · '))}</span>`;
    if (e.status === 'none') return `<span class="pill no">미보유 카드</span>`;
    return `<span class="pill no">${esc(e.why.join(' · '))}</span>`;
  }

  function item({ b, e, x }) {
    const c = CARD[b.card];
    const open = ui.open.has(b.id);
    let val = `<b>${esc(b.value)}</b><i>${esc(b.type)}</i>`;
    if (x) {
      val = x.v > 0
        ? `<b class="est">${b.calc.steps ? x.v.toLocaleString('ko-KR') + 'P' : '−' + won(x.v)}</b><i>${esc(b.value)} ${esc(b.type)}</i>`
        : `<b>${esc(b.value)}</b><i>${esc(x.note || b.type)}</i>`;
    }
    const personal = b.personal ? b.personal(S) : '';
    const used = usage(b.limKey || b.id, null);
    const canConfirm = x && x.v > 0 && ui.amount && (e.status === 'ok' || e.status === 'check');
    const extra = e.why.filter((w) => w.includes('면제')).map((w) => `<span class="pill ok">${esc(w)}</span>`).join('');
    return `
      <div role="button" tabindex="0" class="item ${e.status === 'none' || e.status === 'no' ? 'dim' : ''} ${open ? 'open' : ''}" data-id="${b.id}">
        <div class="row">
          ${logo(c)}
          <div class="body">
            <div class="title">${esc(b.title)}</div>
            <div class="where">${esc(b.where)}</div>
          </div>
          <div class="val">${val}</div>
        </div>
        <div class="meta">
          ${statusPill(e)}${extra}
          ${b.until ? `<span class="pill until">~${esc(b.until.slice(2).replace(/-/g, '.'))}</span>` : ''}
          ${b.req && b.req.pooled ? '<span class="pill tag">통합한도</span>' : ''}
          ${used.mCnt ? `<span class="pill used">이번 달 ${used.mSum ? won(used.mSum) + ' · ' : ''}${used.mCnt}회</span>` : ''}
        </div>
        ${canConfirm ? confirmBtn(b, x) : ''}
        <div class="detail">
          <p><b>${esc(c.name)}</b> · ${esc(b.group)}</p>
          ${b.limit ? `<p>한도 · ${esc(b.limit)}</p>` : ''}
          ${personal ? `<p class="me">${esc(personal)}</p>` : ''}
          ${b.notes && b.notes.length ? `<ul>${b.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>`;
  }

  function confirmBtn(b, x) {
    const amtTxt = b.calc.steps ? x.v.toLocaleString('ko-KR') + 'P' : won(x.v);
    return `<button class="confirm" data-confirm="${esc(b.id)}">${esc(won(ui.amount))} 결제 확정 · ${esc(amtTxt)} 기록</button>`;
  }

  function list(rows, head) {
    if (!rows.length) return '';
    return `<div class="list">${head ? `<div class="list-head">${head}</div>` : ''}${rows.map(item).join('')}</div>`;
  }

  function best(rows, label) {
    const top = rows.find((r) => r.e.status === 'ok' && (!ui.amount || !r.x || r.x.v > 0));
    if (!top) {
      const spent = rows.filter((r) => r.e.why && /소진|모두 사용/.test(r.e.why[0] || ''));
      return spent.length ? `<div class="section"><b>쓸 수 있는 한도를 다 썼어요</b>${spent.map((r) => `<div class="muted">${esc(CARD[r.b.card].short + ' ' + r.b.title)} · ${esc(r.e.why[0])}</div>`).join('')}</div>` : '';
    }
    const c = CARD[top.b.card];
    const v = top.x && top.x.v > 0 ? (top.b.calc.steps ? top.x.v.toLocaleString('ko-KR') + 'P 적립' : won(top.x.v) + ' 아껴요') : top.b.value;
    return `
      <div class="best ${c.id === 'kb' ? 'dark-text' : ''}" style="${cardVars(c)}">
        <div class="k">${esc(label)} 가장 좋은 혜택</div>
        <div class="t">${esc(c.name)}로 결제하세요</div>
        <div class="v">${esc(v)}</div>
        <div class="s">${esc(top.b.title)}${top.b.limit ? ' · ' + esc(top.b.limit) : ''}</div>
        ${top.x && top.x.partial && top.x.v > 0 ? '<div class="s">⚠️ 남은 한도까지만 적용돼요</div>' : ''}
        ${top.x && top.x.v > 0 && ui.amount ? `<button class="best-confirm" data-confirm="${esc(top.b.id)}">이 카드로 결제 확정</button>` : ''}
      </div>`;
  }

  function searchBar() {
    return `
      <div class="search-wrap">
        <label class="search ${ui.q ? 'has-value' : ''}">
          <span aria-hidden="true">🔍</span>
          <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="어디서 결제하나요? (예: 스타벅스, PX)" value="${esc(ui.q)}">
          <button class="clear" id="clear" type="button" aria-label="지우기">✕</button>
        </label>
        <div class="amount">
          <label for="amt">결제 금액</label>
          <input id="amt" inputmode="numeric" placeholder="선택 입력" value="${ui.amount ? ui.amount.toLocaleString('ko-KR') : ''}">
          <span>원</span>
        </div>
      </div>`;
  }

  // ───────── 화면: 찾기 ─────────
  function viewHome() {
    let html = searchBar();
    if (ui.q.trim()) {
      const rows = ranked(search(ui.q));
      html += `<div id="results">${resultsHTML(rows)}</div>`;
      return html;
    }
    const salary = S.salary ? BANK[S.salary].name : '미설정';
    html += `
      <div class="hello">
        <h1>결제하기 전에<br>혜택부터 확인해요</h1>
        <p>${S.cards.length ? `내 카드 ${S.cards.map((id) => CARD[id].short).join('·')} · 급여 ${esc(salary)}` : '설정에서 내 카드를 고르면 맞춤으로 보여드려요'}</p>
      </div>`;
    if (!S.cards.length) {
      html += `<div class="section cta"><div><b>내 나라사랑카드를 골라주세요</b><div class="muted">지금은 4개 카드 혜택을 모두 보여줘요</div></div><button data-go="settings">설정</button></div>`;
    }
    html += `<div class="chips" style="margin:4px -16px 8px">${QUICK.map((k) => `<button class="chip" data-q="${esc(k)}">${esc(k)}</button>`).join('')}</div>`;

    html += `<div class="section"><h2>섹터별 혜택 <small>받을 수 있는 혜택 수</small></h2><div class="grid">`;
    SECTORS.forEach((s) => {
      const n = BENEFITS.filter((b) => b.sector === s.id && visibleCards().includes(b.card) && evaluate(b).status === 'ok').length;
      html += `<button class="cell" data-sector="${s.id}"><span class="ico">${s.icon}</span><span class="lbl">${esc(s.name)}</span>${n ? `<span class="badge">${n}</span>` : ''}</button>`;
    });
    html += `</div></div>`;

    html += monthSummary();

    const ending = ranked(BENEFITS.filter((b) => b.until)).filter((r) => r.e.status !== 'none').slice(0, 4);
    if (ending.length) html += list(ending, `기간 한정 혜택 <small>~${ending[0].b.until.replace(/-/g, '.')}</small>`);

    const pending = ranked(BENEFITS).filter((r) => r.e.status === 'check');
    if (pending.length) {
      html += `<div class="section cta"><div><b>실적 조건 혜택 ${pending.length}개</b><div class="muted">지난달 사용액을 입력하면 정확히 알려드려요</div></div><button data-go="settings">입력</button></div>`;
    }
    return html;
  }

  function resultsHTML(rows) {
    if (!rows.length) {
      return `<div class="empty"><div class="big">🤔</div><p>‘${esc(ui.q)}’ 관련 혜택을 찾지 못했어요<br><span class="muted">가맹점 이름이나 업종으로 검색해보세요</span></p></div>`;
    }
    const okN = rows.filter((r) => r.e.status === 'ok').length;
    return best(rows, `‘${ui.q.trim()}’에서`) + list(rows, `검색 결과 ${rows.length}개 <small>받을 수 있는 혜택 ${okN}개</small>`);
  }

  function monthSummary() {
    const es = monthEntries();
    if (!es.length) return '';
    const total = es.reduce((a, e) => a + e.v, 0);
    const byCard = CARDS.map((c) => [c, es.filter((e) => e.card === c.id).reduce((a, e) => a + e.v, 0)]).filter(([, v]) => v);
    return `<div class="section"><h2>이번 달 받은 혜택 <small>${es.length}건 기록</small></h2>
      <div class="saved">${won(total)}</div>
      <div class="opts" style="margin-top:10px">${byCard.map(([c, v]) => `<button class="opt" data-card="${c.id}" data-goto="cards">${esc(c.short)} ${won(v)}</button>`).join('')}</div>
    </div>`;
  }

  function ledgerSection(c) {
    const es = monthEntries().filter((e) => e.card === c.id).sort((a, b) => b.ts - a.ts);
    const lim = tierLimit(c, S.spend[c.id]);
    const pooled = pooledUsed(c.id);
    const total = es.reduce((a, e) => a + e.v, 0);
    let html = `<div class="section"><h2>이번 달 기록 <small>${thisMonth().replace('-', '.')}</small></h2>
      <div class="kv"><span>받은 혜택 합계</span><b>${won(total)}</b></div>`;
    if (lim) {
      const pct = Math.min(100, Math.round((pooled / lim) * 100));
      html += `<div class="kv"><span>통합한도 사용</span><b>${won(pooled)} / ${won(lim)}</b></div>
        <div class="meter"><div style="width:${pct}%"></div></div>`;
    }
    if (!es.length) {
      html += `<p class="hint">검색 화면에서 결제 금액을 넣고 ‘결제 확정’을 누르면 여기 쌓여요. 한도를 다 쓰면 다른 카드를 추천해드려요.</p>`;
    }
    es.forEach((e) => {
      const b = BENEFIT[e.b];
      const d = new Date(e.ts);
      html += `<div class="led"><div><b>${esc(b ? b.title : e.title)}</b><div class="muted">${d.getMonth() + 1}.${d.getDate()} · ${won(e.amt)} 결제</div></div>
        <div class="led-v">−${won(e.v)}<button data-del="${e.id}" aria-label="기록 삭제">✕</button></div></div>`;
    });
    return html + '</div>';
  }

  // ───────── 화면: 섹터 ─────────
  function viewSector() {
    const s = SECTOR[ui.sector];
    const rows = ranked(BENEFITS.filter((b) => b.sector === s.id));
    let html = `<div class="search-wrap" style="padding-bottom:6px"><div class="chips">${SECTORS.map((x) =>
      `<button class="chip ${x.id === s.id ? 'on' : ''}" data-sector="${x.id}">${x.icon} ${esc(x.name)}</button>`).join('')}</div>
      <div class="amount"><label for="amt">결제 금액</label><input id="amt" inputmode="numeric" placeholder="선택 입력" value="${ui.amount ? ui.amount.toLocaleString('ko-KR') : ''}"><span>원</span></div></div>`;
    html += `<h1 class="page-title">${s.icon} ${esc(s.name)}</h1>`;
    html += `<div id="results">${best(rows, `${s.name}에서`)}${list(rows, `혜택 ${rows.length}개 <small>좋은 순</small>`) || '<div class="empty"><div class="big">📭</div><p>이 섹터에 해당하는 혜택이 없어요</p></div>'}</div>`;
    return html;
  }

  // ───────── 화면: 내 카드 ─────────
  function viewCards() {
    const ids = S.cards.length ? S.cards : CARDS.map((c) => c.id);
    if (!ids.includes(ui.card)) ui.card = ids[0];
    const c = CARD[ui.card];
    const sp = S.spend[c.id];
    const lim = tierLimit(c, sp);
    const tierIdx = sp == null ? -1 : c.tiers.filter(([m]) => sp >= m).length - 1;

    let html = `<h1 class="page-title">${S.cards.length ? '내 카드' : '카드 둘러보기'}</h1>`;
    html += `<div class="seg">${ids.map((id) => `<button class="${id === c.id ? 'on' : ''}" data-card="${id}">${esc(CARD[id].short)}</button>`).join('')}</div>`;
    html += `
      <div class="cardart" style="${cardVars(c)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start"><span class="brand">${esc(c.short)}</span><span class="nm">CHECK</span></div>
        <div class="chip-ic"></div>
        <div class="nm">${esc(c.name)}</div>
      </div>`;
    html += ledgerSection(c);
    html += `
      <div class="section">
        <div class="kv"><span>지난달 사용액</span>
          <select class="sel" data-spend="${c.id}">${SPEND_OPTIONS.map(([v, l]) => `<option value="${v}" ${String(sp ?? null) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
        <div class="kv"><span>${esc(c.tierLabel)}</span><b>${lim == null ? '사용액을 골라주세요' : lim ? won(lim) : '구간 미달'}</b></div>
        <div class="tierbar">${c.tiers.map((t, i) => `<div class="${i <= tierIdx ? 'on' : ''}"></div>`).join('')}</div>
        <div class="tierlbl">${c.tiers.map(([m]) => `<span>${man(m)}</span>`).join('')}</div>
        <div class="kv" style="margin-top:8px"><span>결제계좌</span><b style="font-size:13px">${esc(c.account)}</b></div>
        <div class="kv"><span>고객센터</span><b>${esc(c.contact)}</b></div>
        <p class="hint">💡 ${esc(c.firstUse)}</p>
        <p class="hint">실적 제외: ${esc(c.excluded)}</p>
      </div>`;


    const rows = BENEFITS.filter((b) => b.card === c.id).map((b) => ({ b, e: evaluate(b, null), x: null }));
    const groups = [];
    rows.forEach((r) => {
      let g = groups.find((x) => x.name === r.b.group);
      if (!g) groups.push((g = { name: r.b.group, rows: [] }));
      g.rows.push(r);
    });
    groups.forEach((g) => {
      const okN = g.rows.filter((r) => r.e.status === 'ok').length;
      html += list(g.rows, `${esc(g.name)} <small>${okN}/${g.rows.length}</small>`);
    });
    return html;
  }

  // ───────── 화면: 설정 ─────────
  function viewSettings() {
    let html = '';
    if (!S.onboarded) {
      html += `<div class="welcome"><h2>반가워요! 👋</h2><p>가진 카드와 은행을 알려주면 지금 받을 수 있는 혜택만 골라서 보여드릴게요.</p></div>`;
    } else {
      html += `<h1 class="page-title">설정</h1>`;
    }
    html += `<div class="section"><h2>내 나라사랑카드 <small>여러 개 선택</small></h2><div class="pick">`;
    CARDS.forEach((c) => {
      html += `<button class="pick-card ${owned(c.id) ? 'on' : ''}" data-own="${c.id}" style="${cardVars(c)}"><span class="ck">${owned(c.id) ? '✓' : ''}</span><b>${esc(c.short)}</b><small>${esc(c.name)}</small></button>`;
    });
    html += `</div></div>`;

    html += `<div class="section"><h2>급여 받는 은행 <small>하나만 선택</small></h2><div class="opts">`;
    BANKS.forEach((b) => { html += `<button class="opt ${S.salary === b.id ? 'on' : ''}" data-salary="${b.id}">${esc(b.name)}</button>`; });
    html += `</div><p class="hint">국군재정관리단 급여이체 은행이에요. 하나(Desire·휴대폰케어), IBK(나라·사랑 실적 면제, PX 횟수↑, 급여이체 프로모션), KB(금융수수료 면제) 혜택에 반영돼요.</p></div>`;

    html += `<div class="section"><h2>적금 든 은행 <small>여러 개 선택</small></h2><div class="opts">`;
    BANKS.forEach((b) => { html += `<button class="opt ${S.savings.includes(b.id) ? 'on' : ''}" data-saving="${b.id}">${esc(b.name)}</button>`; });
    html += `</div><p class="hint">장병내일준비적금 가입 은행이에요. IBK 적금이 있으면 IBK PX 할인에서 별도 증빙 없이 현역병으로 인정돼요.</p></div>`;

    const ids = S.cards.length ? S.cards : [];
    html += `<div class="section"><h2>지난달 카드 사용액 <small>실적 조건 판정용</small></h2>`;
    if (!ids.length) html += `<p class="muted">카드를 먼저 선택해주세요</p>`;
    ids.forEach((id) => {
      const c = CARD[id];
      const sp = S.spend[id];
      html += `<div class="spend-row"><div class="who">${logo(c)}${esc(c.short)}</div>
        <select class="sel" data-spend="${id}">${SPEND_OPTIONS.map(([v, l]) => `<option value="${v}" ${String(sp ?? null) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    });
    html += `<p class="hint">일시불·할부 이용금액 기준 (세금·공과금 등 제외). 매달 초에 한 번 바꿔주세요.</p></div>`;

    html += `<div class="section"><label class="switch"><span><b>없는 카드 혜택도 보기</b><br><span class="muted">다른 카드와 비교할 때 켜세요</span></span><input type="checkbox" id="showAll" ${S.showAll ? 'checked' : ''}></label></div>`;

    if (!S.onboarded) {
      html += `<button class="btn" id="done">시작하기</button>`;
    } else {
      html += `
        <div class="section"><h2>홈 화면에 추가하기</h2>
          <p class="muted" style="margin:0">iPhone: Safari 공유 버튼 → ‘홈 화면에 추가’<br>Android: Chrome 메뉴(⋮) → ‘앱 설치’ 또는 ‘홈 화면에 추가’</p>
        </div>
        <p class="notice">혜택 정보는 각 카드사 상품설명서(${esc(UPDATED)} 기준 정리)를 바탕으로 했어요. 가맹점 업종 분류, 간편결제(PG) 경유, 입점 매장 여부에 따라 적용되지 않을 수 있으니 정확한 내용은 카드사에 확인해주세요.</p>
        <button class="btn ghost" id="reset">설정 초기화</button>`;
    }
    return html;
  }

  // ───────── 렌더 & 이벤트 ─────────
  const VIEWS = { home: viewHome, sector: viewSector, cards: viewCards, settings: viewSettings };

  function render(keepScroll) {
    const y = window.scrollY;
    $('#view').innerHTML = VIEWS[ui.tab]();
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === ui.tab));
    if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }

  // 검색 입력은 입력창을 다시 그리지 않고 결과만 갱신 (IME 조합 유지)
  function refreshResults() {
    const res = $('#results');
    if (ui.tab === 'home') {
      if (!ui.q.trim() || !res) { render(true); focusEnd('#q'); return; }
      res.innerHTML = resultsHTML(ranked(search(ui.q)));
      $('.search').classList.toggle('has-value', !!ui.q);
    } else if (ui.tab === 'sector' && res) {
      const rows = ranked(BENEFITS.filter((b) => b.sector === ui.sector));
      res.innerHTML = best(rows, `${SECTOR[ui.sector].name}에서`) + list(rows, `혜택 ${rows.length}개 <small>좋은 순</small>`);
    }
  }

  function focusEnd(sel) {
    const el = $(sel);
    if (!el) return;
    el.focus();
    const n = el.value.length;
    try { el.setSelectionRange(n, n); } catch (e) { /* type=search 일부 브라우저 */ }
  }

  function go(tab) { ui.tab = tab; render(); }

  function confirmPay(id) {
    const b = BENEFIT[id];
    const x = b && estimate(b, ui.amount);
    if (!x || !(x.v > 0)) return;
    const c = CARD[b.card];
    LEDGER.push({
      id: Date.now(), ts: Date.now(), b: b.id, k: b.limKey || b.id, card: b.card,
      title: b.title, amt: ui.amount, v: x.v, pooled: !!(b.req && b.req.pooled),
    });
    saveLedger();
    const left = remaining(b, ui.amount);
    ui.amount = 0;
    render(true);
    toast(`${c.short} ${won(x.v)} 혜택 기록${left.rem === 0 ? ` · ${left.why}` : isFinite(left.rem) ? ` · 남은 한도 ${won(left.rem)}` : ''}`);
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, [data-id]');
    if (!t) return;
    const d = t.dataset;
    if (d.confirm) { confirmPay(d.confirm); return; }
    if (d.del) {
      const e = LEDGER.find((x) => String(x.id) === d.del);
      if (e && confirm(`${won(e.amt)} 결제 기록을 지울까요?`)) { LEDGER = LEDGER.filter((x) => x !== e); saveLedger(); render(true); }
      return;
    }
    if (d.goto) { ui.card = d.card; go(d.goto); return; }
    if (d.tab) { if (d.tab === ui.tab && ui.tab === 'home') { ui.q = ''; } go(d.tab); return; }
    if (d.go) { go(d.go); return; }
    if (d.q) { ui.q = d.q; render(); return; }
    if (d.sector) { ui.sector = d.sector; ui.tab = 'sector'; render(); return; }
    if (d.card) { ui.card = d.card; render(true); return; }
    if (d.id) { ui.open.has(d.id) ? ui.open.delete(d.id) : ui.open.add(d.id); t.classList.toggle('open'); return; }
    if (d.own) {
      S.cards = owned(d.own) ? S.cards.filter((x) => x !== d.own) : CARDS.map((c) => c.id).filter((id) => id === d.own || owned(id));
      save(); render(true); return;
    }
    if (d.salary) { S.salary = S.salary === d.salary ? null : d.salary; save(); render(true); return; }
    if (d.saving) {
      S.savings = S.savings.includes(d.saving) ? S.savings.filter((x) => x !== d.saving) : [...S.savings, d.saving];
      save(); render(true); return;
    }
    if (t.id === 'clear') { ui.q = ''; render(); focusEnd('#q'); return; }
    if (t.id === 'done') {
      S.onboarded = true; save(); go('home');
      toast(S.cards.length ? '맞춤 혜택을 준비했어요' : '카드는 나중에 설정에서 고를 수 있어요');
      return;
    }
    if (t.id === 'reset') {
      if (confirm('설정을 모두 지울까요?')) { S = defaults(); save(); ui.tab = 'settings'; render(); }
    }
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'q') { ui.q = el.value; refreshResults(); }
    if (el.id === 'amt') {
      const n = parseInt(el.value.replace(/[^0-9]/g, ''), 10) || 0;
      ui.amount = Math.min(n, 100000000);
      el.value = ui.amount ? ui.amount.toLocaleString('ko-KR') : '';
      refreshResults();
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.spend) {
      const v = el.value === 'null' ? null : Number(el.value);
      if (v == null) delete S.spend[el.dataset.spend]; else S.spend[el.dataset.spend] = v;
      save(); render(true);
    }
    if (el.id === 'showAll') { S.showAll = el.checked; save(); }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'q' && ev.key === 'Enter') ev.target.blur();
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.dataset && ev.target.dataset.id) { ev.preventDefault(); ev.target.click(); }
  });

  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
})();
