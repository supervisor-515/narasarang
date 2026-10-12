(function () {
  'use strict';

  const DATA = window.DATA;
  const { BANKS, CARDS, SECTORS, BENEFITS, LEGACY_IDS } = DATA;

  const SPEND_OPTIONS = [
    [null, '모름'], [0, '8만원 미만'], [80000, '8만원 이상'], [100000, '10만원 이상'], [200000, '20만원 이상'],
    [250000, '25만원 이상'], [300000, '30만원 이상'], [500000, '50만원 이상'], [700000, '70만원 이상'], [1000000, '100만원 이상'],
  ];
  const QUICK = ['편의점', '스타벅스', '택시', '배달의민족', 'KTX', 'CGV', '지하철', '놀이공원', '넷플릭스', '쿠팡', '아웃백'];

  // ───────── 저장소 ─────────
  // 쓰기 후 다시 읽어 실제로 저장됐는지 확인
  function store(key, value) {
    try {
      const s = JSON.stringify(value);
      localStorage.setItem(key, s);
      return localStorage.getItem(key) === s;
    } catch (e) { return false; }
  }
  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  const KEY = 'narasarang.settings.v1';
  const LEDGER_KEY = 'narasarang.ledger.v2';
  const LEDGER_V1 = 'narasarang.ledger.v1';
  // 저장된 값은 항상 검증해서 씀 (잘못된 백업·옛 형식에도 앱이 멈추지 않게)
  const clean = (raw) => window.Engine.sanitizeSettings(DATA, raw);
  const defaults = () => clean({});
  let S = clean(read(KEY));
  let LEDGER = [];
  const input = { tickets: 1 };
  const E = window.Engine.create(DATA, { getS: () => S, getLedger: () => LEDGER, getInput: () => input });
  const { CARD, SECTOR, BANK, BENEFIT, NEEDS, won, man, ymd, thisMonth } = E;

  // 예전 설정: 사용액 입력 월이 없으면 이번 달로 간주
  Object.keys(S.spend).forEach((id) => { if (!S.spendAt[id]) S.spendAt[id] = thisMonth(); });

  function saveS() {
    const ok = store(KEY, S);
    if (!ok) toast('⚠️ 설정을 저장하지 못했어요. 개인정보 보호 모드인지 확인해주세요');
    return ok;
  }

  // ───────── 결제 기록 (거래 단위) ─────────
  // { id, ts, card, amt, items: [{ b, k, v, pooled, unit }] } — 한 번의 결제에 기본·추가 혜택을 묶음
  const isTx = (t) => window.Engine.isTx(DATA, t);
  const fixId = (x) => LEGACY_IDS[x] || x;
  const unitOf = (b) => (b && (b.type === '적립' || (b.calc && b.calc.steps)) ? 'point' : 'won');

  function loadLedger() {
    const cut = Date.now() - 400 * 864e5; // 연 횟수 계산용으로 13개월치 보관
    const v2 = read(LEDGER_KEY);
    if (v2 && v2.v === 2 && Array.isArray(v2.tx)) return v2.tx.filter(isTx).filter((t) => t.ts > cut);
    // v1(혜택별 한 줄) → 같은 시각·카드끼리 거래로 묶기
    const v1 = read(LEDGER_V1);
    if (!Array.isArray(v1)) return [];
    const map = new Map();
    v1.forEach((e) => {
      if (!e || !Number.isFinite(e.ts) || !Number.isFinite(e.v)) return;
      const b = fixId(e.b);
      const key = e.ts + '|' + e.card;
      if (!map.has(key)) map.set(key, { id: 't' + e.ts + '-' + e.card, ts: e.ts, card: e.card, amt: e.amt, items: [] });
      map.get(key).items.push({ b, k: fixId(e.k), v: e.v, pooled: !!e.pooled, unit: unitOf(BENEFIT[b]) });
    });
    const tx = [...map.values()].filter(isTx).filter((t) => t.ts > cut);
    if (store(LEDGER_KEY, { v: 2, tx })) { try { localStorage.removeItem(LEDGER_V1); } catch (e) { /* 무시 */ } }
    return tx;
  }
  const saveLedger = () => store(LEDGER_KEY, { v: 2, tx: LEDGER });
  LEDGER = loadLedger();

  const ui = {
    tab: S.onboarded ? 'home' : 'settings', q: '', amount: 0, sector: 'px', card: null,
    open: new Set(), txOpen: new Set(), month: thisMonth(),
  };

  // ───────── 유틸 ─────────
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cardVars = (c) => `--c1:${c.color};--c2:${c.color2};--ct:${c.text}`;
  const owned = (id) => S.cards.includes(id);
  const visibleCards = () => (S.showAll || S.cards.length === 0 ? CARDS.map((c) => c.id) : S.cards);
  const pressed = (on) => `aria-pressed="${on ? 'true' : 'false'}"`;
  const fmtV = (v, unit) => (unit === 'use' ? '사용 1회' : unit === 'point' ? v.toLocaleString('ko-KR') + 'P' : won(v));
  const txSums = (txs) => {
    const sum = { won: 0, point: 0 };
    txs.forEach((t) => t.items.forEach((i) => { if (i.unit !== 'use') sum[i.unit === 'point' ? 'point' : 'won'] += i.v; }));
    return sum;
  };
  const monthTx = (m, card) => LEDGER.filter((t) => ymd(t.ts).startsWith(m) && (!card || t.card === card));
  const ranked = (list) => E.rank(list, ui.amount, visibleCards());

  // ───────── 렌더링 조각 ─────────
  function logo(c) {
    return `<div class="logo" style="${cardVars(c)}">${esc(c.short)}</div>`;
  }

  function statusPill(e) {
    if (e.status === 'ok') return `<span class="pill ok">✓ 받을 수 있어요</span>`;
    if (e.status === 'check') return `<span class="pill check">확인 필요 · ${esc(e.why.join(' · '))}</span>`;
    if (e.status === 'none') return `<span class="pill no">미보유 카드</span>`;
    return `<span class="pill no">${esc(e.why.join(' · '))}</span>`;
  }

  function needButtons(e) {
    return e.missing.map((k) => {
      const n = NEEDS[k];
      if (n.flag) return `<button class="flag" data-flag="${esc(n.flag)}">✓ ${esc(n.flagLabel)}</button>`;
      if (k === 'soldier') return `<span class="flag-row">현역 병사인가요? <button class="flag" data-soldier="1">네</button><button class="flag ghost" data-soldier="0">아니요</button></span>`;
      if (k === 'ibkSoldier') return `<span class="flag-row">${esc(n.how)} <button class="flag" data-go="settings">설정에서 입력</button></span>`;
      return '';
    }).join('');
  }

  function item({ b, e, x }) {
    const c = CARD[b.card];
    const open = ui.open.has(b.id);
    let val = `<b>${esc(b.value)}</b><i>${esc(b.type)}</i>`;
    if (x) {
      val = x.v > 0
        ? `<b class="est">${x.unit === 'point' ? fmtV(x.v, 'point') : '−' + won(x.v)}</b><i>${x.extra ? `${esc(x.extra.b.title.replace(/.*\) ?/, ''))} ${won(x.extra.v)} 포함` : x.note ? esc(x.note) : `${esc(b.value)} ${esc(b.type)}`}</i>`
        : `<b>${esc(b.value)}</b><i>${esc(x.note || b.type)}</i>`;
    }
    const personal = b.personal ? b.personal(S) : '';
    const used = E.usage(E.keyOf(b), null);
    const canConfirm = !b.addon && !b.verify && x && x.v > 0 && ui.amount && (e.status === 'ok' || e.status === 'check');
    const src = c.source;
    return `
      <div role="button" tabindex="0" aria-expanded="${open}" class="item ${e.status === 'none' || e.status === 'no' ? 'dim' : ''} ${open ? 'open' : ''}" data-id="${esc(b.id)}">
        <div class="row">
          ${logo(c)}
          <div class="body">
            <div class="title">${esc(b.title)}</div>
            <div class="where">${esc(b.where)}</div>
          </div>
          <div class="val">${val}</div>
        </div>
        <div class="meta">
          ${statusPill(e)}${e.good.map((g) => `<span class="pill ok">${esc(g)}</span>`).join('')}
          ${b.ctx && b.ctx.length ? '<span class="pill tag">ⓘ 이용 조건</span>' : ''}
          ${b.until ? `<span class="pill until">~${esc(b.until.slice(2).replace(/-/g, '.'))}</span>` : ''}
          ${b.req && b.req.pooled ? '<span class="pill tag">통합한도</span>' : ''}
          ${used.mCnt ? `<span class="pill used">이번 달 ${used.mSum ? fmtV(used.mSum, unitOf(b)) + ' · ' : ''}${used.mCnt}회</span>` : ''}
        </div>
        ${canConfirm ? confirmBtn(b, x, e) : ''}
        ${!b.calc && b.lim && !b.addon && (e.status === 'ok' || e.status === 'check') ? `<button class="confirm ghost" data-use="${esc(b.id)}">사용했어요 · 횟수 기록</button>` : ''}
        <div class="detail">
          <p><b>${esc(c.name)}</b> · ${esc(b.group)}</p>
          ${b.limit ? `<p>한도 · ${esc(b.limit)}</p>` : ''}
          ${b.ctx && b.ctx.length ? `<p class="warn">결제 전 확인 · ${b.ctx.map(esc).join(' · ')}</p>` : ''}
          ${b.verify ? `<p class="warn">⚠️ ${esc(b.verify)}</p>` : ''}
          ${e.missing.length ? `<div class="flags">${needButtons(e)}</div>` : ''}
          ${personal ? `<p class="me">${esc(personal)}</p>` : ''}
          ${b.notes && b.notes.length ? `<ul>${b.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
          ${!ui.amount && b.calc && !b.addon && ui.tab !== 'cards' ? '<p class="me">위에 결제 금액을 넣으면 할인액 계산과 결제 기록을 할 수 있어요</p>' : ''}
          <p class="src">출처 · ${esc(src.doc)} (${esc(src.date)}) · 공식 페이지 대조 ${esc(src.checked)} · <a href="${esc(src.url)}" target="_blank" rel="noopener">공식 상품 페이지</a></p>
        </div>
      </div>`;
  }

  function confirmBtn(b, x, e) {
    const label = e.status === 'ok' ? '결제 기록' : '조건 충족 시 결제 기록';
    return `<button class="confirm" data-confirm="${esc(b.id)}">${esc(won(ui.amount))} ${label} · ${esc(fmtV(x.v, x.unit))}</button>`;
  }

  function list(rows, head) {
    if (!rows.length) return '';
    return `<div class="list">${head ? `<div class="list-head">${head}</div>` : ''}${rows.map(item).join('')}</div>`;
  }

  function best(rows, label) {
    const top = E.bestOf(rows, ui.amount);
    if (!top) {
      const spent = rows.filter((r) => r.e.status === 'no' && /소진|모두 사용/.test(r.e.why[0] || ''));
      if (spent.length) {
        return `<div class="section"><b>쓸 수 있는 한도를 다 썼어요</b>${spent.map((r) => `<div class="muted">${esc(CARD[r.b.card].short + ' ' + r.b.title)} · ${esc(r.e.why[0])}</div>`).join('')}</div>`;
      }
      const checks = rows.filter((r) => r.e.status === 'check');
      if (checks.length) {
        return `<div class="section"><b>조건 확인이 필요한 혜택만 있어요</b><div class="muted">아래 혜택을 눌러 조건을 확인하면 정확히 추천해드려요</div></div>`;
      }
      return '';
    }
    const c = CARD[top.b.card];
    const ctx = top.b.ctx || [];
    const v = top.x && top.x.v > 0 ? (top.x.unit === 'point' ? fmtV(top.x.v, 'point') + ' 적립' : won(top.x.v) + ' 아껴요') : top.b.value;
    return `
      <div class="best ${c.id === 'kb' ? 'dark-text' : ''}" style="${cardVars(c)}">
        <div class="k">${esc(label)} ${ctx.length ? '조건 충족 시 예상 혜택' : '추천'}</div>
        <div class="t">${esc(c.name)}로 결제하세요</div>
        <div class="v">${esc(v)}</div>
        <div class="s">${esc(top.b.title)}${top.x && top.x.extra ? ` + ${esc(top.x.extra.b.title)} ${won(top.x.extra.v)}` : top.b.limit ? ' · ' + esc(top.b.limit) : ''}</div>
        ${top.x && top.x.partial && top.x.base > 0 ? '<div class="s">⚠️ 남은 한도까지만 적용돼요</div>' : ''}
        ${ctx.length ? `<div class="best-ctx">결제 전 확인 · ${ctx.map(esc).join(' · ')}</div>` : ''}
        ${top.x && top.x.v > 0 && ui.amount ? `<button class="best-confirm" data-confirm="${esc(top.b.id)}">이 카드로 결제했어요 · 기록</button>` : ''}
      </div>`;
  }

  function searchBar() {
    return `
      <div class="search-wrap">
        <label class="search ${ui.q ? 'has-value' : ''}">
          <span aria-hidden="true">🔍</span>
          <input id="q" type="search" enterkeyhint="search" autocomplete="off" aria-label="가맹점 검색" placeholder="${ui.tab === 'home' && !ui.q ? '다른 곳 검색 (스타벅스, 편의점…)' : '어디서 결제하나요? (예: 스타벅스, PX)'}" value="${esc(ui.q)}">
          <button class="clear" id="clear" type="button" aria-label="검색어 지우기">✕</button>
        </label>
      </div>`;
  }

  // 토스 송금처럼 큰 숫자 + 빠른 금액 버튼
  function amountCard(where) {
    return `
      <div class="amt-card">
        <label for="amt" class="amt-label">${esc(where)} 얼마 결제하나요?</label>
        <div class="amt-field">
          <input id="amt" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" placeholder="금액 입력" value="${ui.amount ? ui.amount.toLocaleString('ko-KR') : ''}">
          <span class="amt-won ${ui.amount ? '' : 'off'}">원</span>
          <span class="amt-measure" aria-hidden="true"></span>
        </div>
        <div class="tickets" hidden>
          <span>티켓 매수 <small>정액 관람 혜택 계산용</small></span>
          <span class="stepper"><button data-tix="-1" aria-label="한 장 빼기">−</button><b id="tixN">${input.tickets}매</b><button data-tix="1" aria-label="한 장 더하기">+</button></span>
        </div>
        <div class="amt-add">
          <button data-add="1000">+1천</button><button data-add="10000">+1만</button><button data-add="50000">+5만</button><button data-add="100000">+10만</button>
          <button data-add="0" class="reset" aria-label="금액 지우기">지우기</button>
        </div>
      </div>`;
  }

  // ───────── 화면: 찾기 ─────────
  function viewHome() {
    let html = searchBar();
    if (ui.q.trim()) {
      const rows = ranked(E.search(ui.q));
      html += `<div class="amt-slot" ${rows.length ? '' : 'hidden'}>${amountCard(`‘${ui.q.trim()}’에서`)}</div>`;
      html += `<div id="results">${resultsHTML(rows)}</div>`;
      return html;
    }
    // 기본 화면 = PX (가장 자주 쓰는 곳): 금액만 넣으면 바로 카드 추천
    const salary = S.salary ? BANK[S.salary].name : '미설정';
    html += `
      <div class="px-home">
        <div class="px-title"><span aria-hidden="true">🪖</span> PX에서 결제할 때</div>
        <p class="px-sub">${S.cards.length ? `내 카드 ${S.cards.map((id) => CARD[id].short).join('·')} · 급여 ${esc(salary)}` : '설정에서 내 카드를 고르면 맞춤으로 보여드려요'}</p>
      </div>`;
    html += amountCard('PX에서');
    html += `<div id="results">${pxResults()}</div>`;
    if (!S.cards.length) {
      html += `<div class="section cta"><div><b>내 나라사랑카드를 골라주세요</b><div class="muted">지금은 4개 카드 혜택을 모두 보여줘요</div></div><button data-go="settings">설정</button></div>`;
    }
    const stale = S.cards.filter((id) => E.spendStale(id));
    if (stale.length) {
      html += `<div class="section cta"><div><b>달이 바뀌었어요</b><div class="muted">${stale.map((id) => CARD[id].short).join('·')} 지난달 사용액을 다시 입력해주세요</div></div><button data-go="settings">입력</button></div>`;
    }
    html += `<div class="chips-label">다른 곳에서 결제할 때 <span>누르면 바로 금액 입력</span></div>`;
    html += `<div class="chips" style="margin:0 -16px 8px">${QUICK.map((k) => `<button class="chip" data-q="${esc(k)}">${esc(k)}</button>`).join('')}</div>`;

    html += `<div class="section"><h2>섹터별 혜택 <small>받을 수 있는 혜택 수</small></h2><div class="grid">`;
    SECTORS.forEach((s) => {
      const n = BENEFITS.filter((b) => b.sector === s.id && visibleCards().includes(b.card) && E.evaluate(b, null).status === 'ok').length;
      html += `<button class="cell" data-sector="${s.id}"><span class="ico" aria-hidden="true">${s.icon}</span><span class="lbl">${esc(s.name)}</span>${n ? `<span class="badge" aria-label="${n}개">${n}</span>` : ''}</button>`;
    });
    html += `</div></div>`;

    html += monthSummary();

    const ending = ranked(BENEFITS.filter((b) => b.until)).filter((r) => r.e.status !== 'none').slice(0, 4);
    if (ending.length) html += list(ending, `기간 한정 혜택 <small>~${ending[0].b.until.replace(/-/g, '.')}</small>`);

    const pending = ranked(BENEFITS).filter((r) => r.e.status === 'check');
    if (pending.length) {
      html += `<div class="section cta"><div><b>확인이 필요한 혜택 ${pending.length}개</b><div class="muted">사용액·현역병 여부 등을 입력하면 정확히 알려드려요</div></div><button data-go="settings">입력</button></div>`;
    }
    return html;
  }

  function pxResults() {
    const rows = ranked(BENEFITS.filter((b) => b.sector === 'px'));
    const shown = rows.filter((r) => r.e.status !== 'none');
    return best(rows, 'PX') + list(shown, `PX 혜택 ${shown.length}개 <small>${ui.amount ? '할인 큰 순' : '좋은 순'}</small>`);
  }

  function resultsHTML(rows) {
    if (!rows.length) {
      return `<div class="empty"><div class="big">🤔</div><p>‘${esc(ui.q)}’ 관련 혜택을 찾지 못했어요<br><span class="muted">가맹점 이름이나 업종으로 검색해보세요. 군부대 매장은 ‘PX’, ‘해군마트’로 찾아요</span></p></div>`;
    }
    const okN = rows.filter((r) => r.e.status === 'ok').length;
    return best(rows, `‘${ui.q.trim()}’`) + list(rows, `검색 결과 ${rows.length}개 <small>받을 수 있는 혜택 ${okN}개</small>`);
  }

  function monthSummary() {
    const txs = monthTx(thisMonth());
    if (!txs.length) return '';
    const sum = txSums(txs);
    const byCard = CARDS.map((c) => [c, txSums(txs.filter((t) => t.card === c.id))]).filter(([, v]) => v.won || v.point);
    return `<div class="section"><h2>이번 달 기록한 예상 혜택 <small>결제 ${txs.length}건</small></h2>
      <div class="saved">${won(sum.won)}${sum.point ? ` <span class="pt">+ ${fmtV(sum.point, 'point')}</span>` : ''}</div>
      <p class="hint" style="margin-top:4px">직접 기록한 결제로 계산한 금액이에요. 실제 카드사 지급액과 다를 수 있어요.</p>
      <div class="opts" style="margin-top:10px">${byCard.map(([c, v]) => `<button class="opt" data-card="${c.id}" data-goto="cards">${esc(c.short)} ${won(v.won)}${v.point ? ' · ' + fmtV(v.point, 'point') : ''}</button>`).join('')}</div>
    </div>`;
  }

  // ───────── 화면: 섹터 ─────────
  function viewSector() {
    const s = SECTOR[ui.sector];
    const rows = ranked(BENEFITS.filter((b) => b.sector === s.id));
    let html = `<div class="search-wrap" style="padding-bottom:6px"><div class="chips" role="group" aria-label="섹터">${SECTORS.map((x) =>
      `<button class="chip ${x.id === s.id ? 'on' : ''}" ${pressed(x.id === s.id)} data-sector="${x.id}">${x.icon} ${esc(x.name)}</button>`).join('')}</div></div>`;
    html += `<h1 class="page-title">${s.icon} ${esc(s.name)}</h1>`;
    html += amountCard(`${s.name}에서`);
    html += `<div id="results">${sectorResults(rows)}</div>`;
    return html;
  }
  function sectorResults(rows) {
    const s = SECTOR[ui.sector];
    return best(rows, `${s.name}`) + (list(rows, `혜택 ${rows.length}개 <small>좋은 순</small>`) || '<div class="empty"><div class="big">📭</div><p>이 섹터에 해당하는 혜택이 없어요</p></div>');
  }

  // ───────── 화면: 내 카드 ─────────
  function viewCards() {
    const ids = S.cards.length ? S.cards : CARDS.map((c) => c.id);
    if (!ids.includes(ui.card)) ui.card = ids[0];
    const c = CARD[ui.card];
    const lim = E.cardLimit(c.id);
    const used = E.pooledUsed(c.id);

    let html = `<h1 class="page-title">${S.cards.length ? '내 카드' : '카드 둘러보기'}</h1>`;
    html += `<div class="seg" role="group" aria-label="카드 선택">${ids.map((id) => `<button class="${id === c.id ? 'on' : ''}" ${pressed(id === c.id)} data-card="${id}">${esc(CARD[id].short)}</button>`).join('')}</div>`;
    html += `
      <div class="cardbar ${c.id === 'kb' ? 'dark-text' : ''}" style="${cardVars(c)}">
        <div><b>${esc(c.name)}</b><div class="cb-sub">${esc(c.tierLabel)}</div></div>
        <div class="cb-lim">${lim == null ? '사용액 입력 필요' : lim ? `${won(Math.max(0, lim - used))} 남음` : '구간 미달'}${lim ? `<small>${won(used)} / ${won(lim)}</small>` : ''}</div>
      </div>`;
    if (lim) {
      const pct = Math.min(100, Math.round((used / lim) * 100));
      html += `<div class="meter" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="통합한도 사용률"><div style="width:${pct}%"></div></div>`;
    }
    html += remainSection(c);
    html += ledgerSection(c);
    html += cardInfoSection(c);

    const rows = BENEFITS.filter((b) => b.card === c.id).map((b) => ({ b, e: E.evaluate(b, null), x: null }));
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

  // 이번 달 쓴 혜택의 남은 한도·횟수 — 게이지 카드
  const KIND = {
    month: '이번 달 남음', day: '오늘 남음', year: '올해 남음',
    monthCount: '이번 달 횟수', dayCount: '오늘 횟수', quarterCount: '이번 분기 횟수', yearCount: '올해 횟수',
  };
  function gauge(it, unit) {
    const left = Math.max(0, it.limit - it.used);
    const pct = it.limit ? Math.min(100, (it.used / it.limit) * 100) : 100;
    const tone = left === 0 ? 'out' : left / it.limit <= 0.3 ? 'low' : 'ok';
    const fmt = (v) => (unit === 'point' ? v.toLocaleString('ko-KR') + 'P' : won(v));
    if (it.kind.endsWith('Count')) {
      // 횟수는 점으로: 쓴 만큼 채워짐 (10회 넘으면 숫자만)
      const pips = it.limit <= 10 ? `<span class="pips" aria-hidden="true">${Array.from({ length: it.limit }, (_, i) => `<i class="${i < it.used ? 'on' : ''}"></i>`).join('')}</span>` : '';
      return `<div class="g g-count ${tone}"><span class="g-k">${KIND[it.kind]}</span>
        <b class="g-left">${left ? `${left}회 남음` : '모두 사용'}</b>${pips}<span class="g-sub">${it.used} / ${it.limit}회 사용</span></div>`;
    }
    return `<div class="g ${tone}"><span class="g-k">${KIND[it.kind]}</span><b class="g-left">${left ? fmt(left) : '소진'}</b>
      <div class="g-bar" role="progressbar" aria-label="${KIND[it.kind]} 사용률" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
      <span class="g-sub">${fmt(it.used)} / ${fmt(it.limit)}</span></div>`;
  }
  function remainSection(c) {
    const seen = new Set();
    const cards = [];
    BENEFITS.filter((b) => b.card === c.id).forEach((b) => {
      const k = E.keyOf(b);
      if (seen.has(k)) return;
      const u = E.usage(k, null);
      if (!u.mCnt) return;
      seen.add(k);
      const groups = E.limitBreakdown(b);
      if (!groups.length) return;
      const unit = unitOf(b);
      cards.push(`<div class="lim-card">
        <div class="lim-head"><b>${esc(b.title)}</b><span>이번 달 ${unit === 'use' ? '' : fmtV(u.mSum, unit) + ' · '}${u.mCnt}회</span></div>
        ${groups.map((g) => `<div class="lim-group">
          ${g.label ? `<div class="lim-label">${esc(g.label)}${g.rate ? `<span class="lim-rate">${esc(g.rate)}</span>` : ''}</div>` : ''}
          <div class="g-grid">${g.items.map((it) => gauge(it, unit)).join('')}</div>
        </div>`).join('')}
      </div>`);
    });
    if (!cards.length) return '';
    return `<div class="section"><h2>남은 한도 <small>이번 달 사용 기준</small></h2>${cards.join('')}</div>`;
  }

  function ledgerSection(c) {
    const m = ui.month;
    const txs = monthTx(m, c.id).sort((a, b) => b.ts - a.ts);
    const sum = txSums(txs);
    let html = `<div class="section"><h2>결제 기록
      <span class="mnav"><button data-lm="-1" aria-label="이전 달">‹</button><span>${m.replace('-', '.')}</span><button data-lm="1" aria-label="다음 달" ${m >= thisMonth() ? 'disabled' : ''}>›</button></span></h2>
      <div class="kv"><span>기록한 예상 혜택</span><b>${won(sum.won)}${sum.point ? ' · ' + fmtV(sum.point, 'point') : ''}</b></div>`;
    if (!txs.length) {
      html += `<p class="hint">${m === thisMonth() ? '검색 화면에서 결제 금액을 넣고 ‘결제 기록’을 누르면 여기 쌓여요. 한도를 다 쓰면 다른 카드를 추천해드려요.' : '이 달에는 기록이 없어요.'}</p>`;
    }
    txs.forEach((t) => {
      const open = ui.txOpen.has(t.id);
      const d = new Date(t.ts);
      const names = t.items.map((i) => (BENEFIT[i.b] ? BENEFIT[i.b].title : '삭제된 혜택'));
      const s = txSums([t]);
      html += `<div class="led ${open ? 'open' : ''}" role="button" tabindex="0" aria-expanded="${open}" data-tx="${esc(t.id)}">
        <div class="led-main"><div><b>${esc(names.join(' + '))}</b><div class="muted">${d.getMonth() + 1}.${d.getDate()} · ${won(t.amt)} 결제</div></div>
          <div class="led-v">−${won(s.won)}${s.point ? `<small>${fmtV(s.point, 'point')}</small>` : ''}</div></div>
        <div class="led-detail">
          ${t.items.map((i) => `<div class="kv"><span>${esc(BENEFIT[i.b] ? BENEFIT[i.b].title : i.b)}</span><b>${fmtV(i.v, i.unit)}</b></div>`).join('')}
          <div class="kv"><span>결제 날짜</span><input type="date" class="sel" data-txdate="${esc(t.id)}" value="${ymd(t.ts)}" max="${ymd(Date.now())}"></div>
          <button class="btn ghost small" data-cancel="${esc(t.id)}">이 결제 기록 취소</button>
        </div>
      </div>`;
    });
    return html + '</div>';
  }

  function spendSelect(id) {
    const sp = E.spendOf(id);
    return `<select class="sel" data-spend="${id}" aria-label="${esc(CARD[id].short)} 지난달 사용액">${SPEND_OPTIONS.map(([v, l]) => `<option value="${v}" ${String(sp ?? null) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }
  function firstSelect(id) {
    const m = (S.firstUse || {})[id];
    const cur = !m ? '' : m === thisMonth() ? '0' : m === E.addMonth(thisMonth(), -1) ? '-1' : '';
    return `<select class="sel" data-first="${id}" aria-label="${esc(CARD[id].short)} 첫 사용 등록 월">
      <option value="" ${cur === '' ? 'selected' : ''}>해당 없음</option>
      <option value="0" ${cur === '0' ? 'selected' : ''}>이번 달 등록</option>
      <option value="-1" ${cur === '-1' ? 'selected' : ''}>지난달 등록</option></select>`;
  }

  function sinceSelect(key, label) {
    const m = S.since[key];
    const cur = m === thisMonth() ? '0' : '-1';
    return `<div class="kv"><span>${esc(label)}</span><select class="sel" data-since="${esc(key)}">
      <option value="-1" ${cur === '-1' ? 'selected' : ''}>지난달 이전부터</option>
      <option value="0" ${cur === '0' ? 'selected' : ''}>이번 달부터</option></select></div>`;
  }

  function cardInfoSection(c) {
    const lim = E.cardLimit(c.id);
    const sp = E.spendOf(c.id);
    const tierIdx = sp == null ? -1 : c.tiers.filter(([m]) => sp >= m).length - 1;
    return `
      <div class="section">
        <h2>카드 정보</h2>
        <div class="kv"><span>지난달 사용액</span>${spendSelect(c.id)}</div>
        <div class="kv"><span>신규 발급 (첫 사용 등록)</span>${firstSelect(c.id)}</div>
        <div class="kv"><span>${esc(c.tierLabel)}</span><b>${lim == null ? '사용액을 골라주세요' : lim ? won(lim) : '구간 미달'}${E.firstActive(c.id) ? ' (신규 발급 인정)' : ''}</b></div>
        <div class="tierbar">${c.tiers.map((t, i) => `<div class="${i <= tierIdx ? 'on' : ''}"></div>`).join('')}</div>
        <div class="tierlbl">${c.tiers.map(([m]) => `<span>${man(m)}</span>`).join('')}</div>
        <div class="kv" style="margin-top:8px"><span>결제계좌</span><b style="font-size:13px">${esc(c.account)}</b></div>
        <div class="kv"><span>고객센터</span><b>${esc(c.contact)}</b></div>
        <div class="kv"><span>출처</span><b style="font-size:13px"><a href="${esc(c.source.url)}" target="_blank" rel="noopener">${esc(c.source.doc)} (${esc(c.source.date)})</a> · ${esc(c.source.checked)} 대조</b></div>
        <p class="hint">💡 ${esc(c.firstUse)}</p>
        <p class="hint">실적 제외: ${esc(c.excluded)}</p>
      </div>`;
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
      html += `<button class="pick-card ${owned(c.id) ? 'on' : ''}" ${pressed(owned(c.id))} data-own="${c.id}" style="${cardVars(c)}"><span class="ck" aria-hidden="true">${owned(c.id) ? '✓' : ''}</span><b>${esc(c.short)}</b><small>${esc(c.name)}</small></button>`;
    });
    html += `</div></div>`;

    html += `<div class="section"><h2>내 정보</h2>
      <div class="switch"><span><b>현역 병사(의무복무) 중인가요?</b><br><span class="muted">현역병 전용 혜택 판정에 써요</span></span>
        <span class="opts"><button class="opt ${S.soldier === true ? 'on' : ''}" ${pressed(S.soldier === true)} data-soldier="1">네</button><button class="opt ${S.soldier === false ? 'on' : ''}" ${pressed(S.soldier === false)} data-soldier="0">아니요</button></span></div></div>`;

    html += `<div class="section"><h2>급여 받는 은행 <small>하나만 선택</small></h2><div class="opts" role="group" aria-label="급여 은행">`;
    BANKS.forEach((b) => { html += `<button class="opt ${S.salary === b.id ? 'on' : ''}" ${pressed(S.salary === b.id)} data-salary="${b.id}">${esc(b.name)}</button>`; });
    html += `</div>${S.salary ? sinceSelect('salary', '언제부터 이 은행으로 받았나요?') : ''}<p class="hint">국군재정관리단 급여이체 은행이에요. 첫 급여를 받은 다음 달부터 인정돼요. 하나(Desire·휴대폰케어), IBK(나라·사랑 실적 면제, PX 급여이체자 횟수, 급여이체 프로모션), KB(금융수수료 면제) 혜택에 반영돼요.</p></div>`;

    html += `<div class="section"><h2>적금 든 은행 <small>여러 개 선택</small></h2><div class="opts" role="group" aria-label="적금 은행">`;
    BANKS.forEach((b) => { html += `<button class="opt ${S.savings.includes(b.id) ? 'on' : ''}" ${pressed(S.savings.includes(b.id))} data-saving="${b.id}">${esc(b.name)}</button>`; });
    html += `</div>${S.savings.includes('ibk') ? sinceSelect('saving-ibk', 'IBK 적금은 언제 가입했나요?') : ''}<p class="hint">장병내일준비적금 가입 은행이에요. 전월 말일 기준 IBK 적금이 있으면 IBK PX 할인에서 별도 증빙 없이 현역병으로 인정돼요.</p></div>`;

    if (!S.cards.length || owned('ibk')) {
      const flags = Object.values(NEEDS).filter((n) => n.flag);
      const proof = !S.checks['ibk-proof'] ? '' : (S.since['ibk-proof'] === thisMonth() ? '0' : '-1');
      html += `<div class="section"><h2>IBK 추가 조건 <small>해당하면 켜기</small></h2>
        <div class="kv"><span>복무확인서·건강보험자격득실확인서 제출<br><small class="muted">제출한 다음 달부터 현역병 인정</small></span>
          <select class="sel" data-proof aria-label="IBK 서류 제출 시점">
            <option value="" ${proof === '' ? 'selected' : ''}>제출 안 함</option>
            <option value="-1" ${proof === '-1' ? 'selected' : ''}>지난달 이전 제출</option>
            <option value="0" ${proof === '0' ? 'selected' : ''}>이번 달 제출</option></select></div>
        ${flags.map((n) => `<label class="switch"><span>${esc(n.flagLabel)}</span><input type="checkbox" data-check="${esc(n.flag)}" ${S.checks[n.flag] ? 'checked' : ''}></label>`).join('')}
        <p class="hint">마이태그는 BC카드 앱·홈페이지에서 프로모션별로 등록해요. 등록하지 않으면 쿠폰 혜택은 ‘확인 필요’로 표시돼요.</p></div>`;
    }

    html += `<div class="section"><h2>카드별 실적 <small>${thisMonth().replace('-', '.')} 기준</small></h2>`;
    if (!S.cards.length) html += `<p class="muted">카드를 먼저 선택해주세요</p>`;
    S.cards.forEach((id) => {
      const c = CARD[id];
      html += `<div class="spend-row"><div class="who">${logo(c)}${esc(c.short)}</div><div class="spend-sel">
        <label><small>지난달 사용액</small>${spendSelect(id)}</label>
        <label><small>신규 발급</small>${firstSelect(id)}</label></div></div>`;
    });
    html += `<p class="hint">일시불·할부 이용금액 기준 (세금·공과금 등 제외). 달이 바뀌면 다시 입력해달라고 알려드려요. 첫 사용 등록 월과 다음 달은 신규 발급 실적이 인정돼요.</p></div>`;

    html += `<div class="section"><div class="kv"><span><b>포인트 비교 기준</b><br><span class="muted">추천 순위를 정할 때 포인트를 어떻게 셀까요?</span></span>
      <select class="sel" data-pv aria-label="포인트 비교 기준"><option value="1" ${S.pointValue === 1 ? 'selected' : ''}>1P = 1원</option><option value="0" ${S.pointValue === 0 ? 'selected' : ''}>할인 우선</option></select></div></div>`;

    html += `<div class="section"><label class="switch"><span><b>없는 카드 혜택도 보기</b><br><span class="muted">다른 카드와 비교할 때 켜세요</span></span><input type="checkbox" id="showAll" ${S.showAll ? 'checked' : ''}></label></div>`;

    if (!S.onboarded) {
      html += `<button class="btn" id="done">시작하기</button>`;
    } else {
      html += `
        <div class="section"><h2>기록 백업</h2>
          <p class="muted" style="margin:0 0 10px">설정과 결제 기록은 이 기기에만 저장돼요. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 내보내 두세요.</p>
          <div class="opts"><button class="opt" id="export">내보내기 (.json)</button><button class="opt" id="import">가져오기</button></div>
          <input type="file" id="importFile" accept="application/json,.json" hidden>
        </div>
        <div class="section"><h2>홈 화면에 추가하기</h2>
          <p class="muted" style="margin:0">iPhone: Safari 공유 버튼 → ‘홈 화면에 추가’<br>Android: Chrome 메뉴(⋮) → ‘앱 설치’ 또는 ‘홈 화면에 추가’</p>
        </div>
        <p class="notice">혜택 정보는 각 카드사 상품설명서를 바탕으로 정리했어요 (카드별 출처는 내 카드 화면). 가맹점 업종 분류, 간편결제(PG) 경유, 입점 매장 여부에 따라 적용되지 않을 수 있으니 정확한 내용은 카드사에 확인해주세요.</p>
        <button class="btn ghost" id="reset">설정 초기화 (기록은 유지)</button>`;
    }
    return html;
  }

  // ───────── 렌더 & 이벤트 ─────────
  const VIEWS = { home: viewHome, sector: viewSector, cards: viewCards, settings: viewSettings };

  function render(keepScroll) {
    const y = window.scrollY;
    $('#view').innerHTML = VIEWS[ui.tab]();
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === ui.tab;
      t.classList.toggle('on', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    fitAmount();
    if (ui.tab === 'home' && ui.q.trim()) showTickets(E.search(ui.q));
    if (ui.tab === 'sector') showTickets(BENEFITS.filter((b) => b.sector === ui.sector));
    if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }

  // 입력창은 다시 그리지 않고 결과만 갱신 (IME 조합·포커스 유지)
  function refreshResults() {
    const res = $('#results');
    if (ui.tab === 'home') {
      const pxHome = !!$('.px-home');
      if (!ui.q.trim()) {
        if (pxHome && res) { res.innerHTML = pxResults(); return; }
        render(true); focusEnd('#q'); return;
      }
      if (pxHome || !res) { render(true); focusEnd('#q'); return; }
      const rows = ranked(E.search(ui.q));
      const slot = $('.amt-slot');
      slot.hidden = !rows.length;
      $('.amt-label').textContent = `‘${ui.q.trim()}’에서 얼마 결제하나요?`;
      res.innerHTML = resultsHTML(rows);
      $('.search').classList.toggle('has-value', !!ui.q);
      showTickets(rows.map((r) => r.b));
    } else if (ui.tab === 'sector' && res) {
      res.innerHTML = sectorResults(ranked(BENEFITS.filter((b) => b.sector === ui.sector)));
    }
  }

  // 관람권처럼 매수에 따라 달라지는 혜택이 있을 때만 매수 입력을 보여줌
  function showTickets(list) {
    const el = $('.tickets');
    if (el) el.hidden = !list.some((b) => b.calc && b.calc.ticket);
  }

  function setAmount(n) {
    ui.amount = Math.min(Math.max(0, n), 100000000);
    const el = $('#amt');
    if (el) el.value = ui.amount ? ui.amount.toLocaleString('ko-KR') : '';
    const w = $('.amt-won');
    if (w) w.classList.toggle('off', !ui.amount);
    fitAmount();
    refreshResults();
  }

  function fitAmount() {
    const el = $('#amt');
    const m = $('.amt-measure');
    if (!el || !m) return;
    m.textContent = el.value || el.placeholder;
    el.style.width = m.offsetWidth + 6 + 'px';
  }

  function focusEnd(sel) {
    const el = $(sel);
    if (!el) return;
    el.focus();
    const n = el.value.length;
    try { el.setSelectionRange(n, n); } catch (e) { /* type=search 일부 브라우저 */ }
  }

  function go(tab) { ui.tab = tab; render(); }

  // 결제 한 건 = 거래 하나 (기본 + 중복 혜택을 묶어서 저장)
  function confirmPay(id) {
    const b = BENEFIT[id];
    const x = b && E.estimate(b, ui.amount);
    if (!x || !(x.v > 0)) return;
    const c = CARD[b.card];
    const ts = Date.now();
    const items = [];
    const base = x.v - (x.extra ? x.extra.v : 0);
    if (base > 0) items.push({ b: b.id, k: E.keyOf(b), v: base, pooled: !!(b.req && b.req.pooled), unit: x.unit });
    if (x.extra) items.push({ b: x.extra.b.id, k: E.keyOf(x.extra.b), v: x.extra.v, pooled: !!(x.extra.b.req && x.extra.b.req.pooled), unit: unitOf(x.extra.b) });
    const tx = { id: 't' + ts + '-' + Math.random().toString(36).slice(2, 7), ts, card: b.card, amt: ui.amount, items };
    LEDGER.push(tx);
    if (!saveLedger()) {
      LEDGER.pop();
      toast('⚠️ 기록을 저장하지 못했어요. 저장공간·개인정보 보호 모드를 확인한 뒤 다시 시도해주세요');
      return;
    }
    const left = E.remaining(b, ui.amount);
    ui.amount = 0;
    render(true);
    toast(`${c.short} ${fmtV(x.v, x.unit)} 예상 혜택을 기록했어요${left.rem === 0 ? ` · ${left.why}` : isFinite(left.rem) ? ` · 남은 한도 ${won(left.rem)}` : ''}`);
  }

  // 무료 혜택(팝콘·라운지 등)은 금액 없이 사용 횟수만 기록
  function confirmUse(id) {
    const b = BENEFIT[id];
    if (!b) return;
    const ts = Date.now();
    LEDGER.push({ id: 't' + ts + '-' + Math.random().toString(36).slice(2, 7), ts, card: b.card, amt: ui.amount || 0, items: [{ b: b.id, k: E.keyOf(b), v: 0, pooled: false, unit: 'use' }] });
    if (!saveLedger()) { LEDGER.pop(); toast('⚠️ 기록을 저장하지 못했어요'); return; }
    const left = E.remaining(b, null);
    render(true);
    toast(`${CARD[b.card].short} ${b.title} 사용을 기록했어요${left.rem === 0 ? ` · ${left.why}` : ''}`);
  }

  function cancelTx(id) {
    const t = LEDGER.find((x) => x.id === id);
    if (!t || !confirm(`${won(t.amt)} 결제 기록을 취소할까요?\n함께 기록된 혜택 ${t.items.length}개가 모두 되돌려져요.`)) return;
    const prev = LEDGER;
    LEDGER = LEDGER.filter((x) => x !== t);
    if (!saveLedger()) { LEDGER = prev; toast('⚠️ 취소를 저장하지 못했어요'); return; }
    ui.txOpen.delete(id);
    render(true);
    toast('결제 기록을 취소했어요');
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'narasarang', v: 2, exportedAt: new Date().toISOString(), settings: S, ledger: LEDGER }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `narasarang-backup-${ymd(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function importData(file) {
    const r = new FileReader();
    r.onload = () => {
      let d;
      try { d = JSON.parse(r.result); } catch (e) { toast('⚠️ 백업 파일을 읽지 못했어요'); return; }
      if (!d || d.app !== 'narasarang' || !d.settings || !Array.isArray(d.ledger)) { toast('⚠️ 나라사랑 혜택 백업 파일이 아니에요'); return; }
      const all = d.ledger.map((t) => (t && Array.isArray(t.items) ? Object.assign({}, t, { items: t.items.map((i) => Object.assign({}, i, { b: fixId(i && i.b), k: fixId(i && i.k) })) }) : t));
      // 알 수 없는 혜택·음수·형식 오류 기록은 제외
      const tx = all.filter(isTx).filter((t) => t.items.every((i) => BENEFIT[i.b]));
      const dropped = all.length - tx.length;
      if (!confirm(`설정과 결제 기록 ${tx.length}건으로 바꿀까요?${dropped ? ` (형식이 맞지 않는 ${dropped}건 제외)` : ''} 지금 기록은 덮어써져요.`)) return;
      const nextS = Object.assign(clean(d.settings), { onboarded: true });
      let raw;
      try { raw = [localStorage.getItem(KEY), localStorage.getItem(LEDGER_KEY)]; } catch (e) { raw = [null, null]; }
      const restore = () => {
        try {
          [[KEY, raw[0]], [LEDGER_KEY, raw[1]]].forEach(([k, v]) => { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); });
        } catch (e) { /* 원래 값으로 되돌리기 실패 — 아래 안내 */ }
      };
      if (!store(KEY, nextS) || !store(LEDGER_KEY, { v: 2, tx })) {
        restore();
        toast('⚠️ 가져온 내용을 저장하지 못해 원래 상태로 되돌렸어요');
        return;
      }
      S = nextS;
      LEDGER = tx;
      render(true);
      toast(`결제 기록 ${tx.length}건을 가져왔어요`);
    };
    r.readAsText(file);
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, [data-id], [data-tx]');
    if (!t || t.disabled) return;
    if (ev.target.closest('a, input, select')) return;
    const d = t.dataset;
    if (d.confirm) { confirmPay(d.confirm); return; }
    if (d.use) { confirmUse(d.use); return; }
    if (d.tix) {
      input.tickets = Math.min(10, Math.max(1, input.tickets + Number(d.tix)));
      $('#tixN').textContent = input.tickets + '매';
      refreshResults();
      return;
    }
    if (d.cancel) { cancelTx(d.cancel); return; }
    if (d.flag) { S.checks[d.flag] = true; saveS(); render(true); return; }
    if (d.soldier) { S.soldier = d.soldier === '1'; saveS(); render(true); return; }
    if (d.lm) { ui.month = E.addMonth(ui.month, Number(d.lm)); render(true); return; }
    if (d.add !== undefined) {
      const n = Number(d.add);
      setAmount(n ? ui.amount + n : 0);
      if (!n) $('#amt').focus();
      return;
    }
    if (d.goto) { ui.card = d.card; go(d.goto); return; }
    if (d.tab) { if (d.tab === ui.tab && ui.tab === 'home') { ui.q = ''; } go(d.tab); return; }
    if (d.go) { go(d.go); return; }
    if (d.q) { ui.q = d.q; render(); if ($('#amt')) $('#amt').focus(); return; }
    if (d.sector) { ui.sector = d.sector; ui.tab = 'sector'; render(); return; }
    if (d.card) { ui.card = d.card; render(true); return; }
    if (d.tx) { const o = ui.txOpen; o.has(d.tx) ? o.delete(d.tx) : o.add(d.tx); t.classList.toggle('open'); t.setAttribute('aria-expanded', o.has(d.tx)); return; }
    if (d.id) { const o = ui.open; o.has(d.id) ? o.delete(d.id) : o.add(d.id); t.classList.toggle('open'); t.setAttribute('aria-expanded', o.has(d.id)); return; }
    if (d.own) {
      S.cards = owned(d.own) ? S.cards.filter((x) => x !== d.own) : CARDS.map((c) => c.id).filter((id) => id === d.own || owned(id));
      saveS(); render(true); return;
    }
    if (d.salary) {
      S.salary = S.salary === d.salary ? null : d.salary;
      if (S.salary) S.since.salary = E.addMonth(thisMonth(), -1); else delete S.since.salary;
      saveS(); render(true); return;
    }
    if (d.saving) {
      S.savings = S.savings.includes(d.saving) ? S.savings.filter((x) => x !== d.saving) : [...S.savings, d.saving];
      if (S.savings.includes(d.saving)) S.since['saving-' + d.saving] = E.addMonth(thisMonth(), -1); else delete S.since['saving-' + d.saving];
      saveS(); render(true); return;
    }
    if (t.id === 'clear') { ui.q = ''; ui.amount = 0; render(); focusEnd('#q'); return; }
    if (t.id === 'export') { exportData(); return; }
    if (t.id === 'import') { $('#importFile').click(); return; }
    if (t.id === 'done') {
      S.onboarded = true; saveS(); go('home');
      toast(S.cards.length ? '맞춤 혜택을 준비했어요' : '카드는 나중에 설정에서 고를 수 있어요');
      return;
    }
    if (t.id === 'reset') {
      if (confirm('설정을 모두 지울까요? 결제 기록은 남아요.')) { S = defaults(); saveS(); ui.tab = 'settings'; render(); }
    }
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'q') { ui.q = el.value; refreshResults(); }
    if (el.id === 'amt') setAmount(parseInt(el.value.replace(/[^0-9]/g, ''), 10) || 0);
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    const d = el.dataset;
    if (d.spend) {
      const v = el.value === 'null' ? null : Number(el.value);
      if (v == null) { delete S.spend[d.spend]; delete S.spendAt[d.spend]; } else { S.spend[d.spend] = v; S.spendAt[d.spend] = thisMonth(); }
      saveS(); render(true);
    }
    if (d.first !== undefined) {
      if (el.value === '') delete S.firstUse[d.first]; else S.firstUse[d.first] = E.addMonth(thisMonth(), Number(el.value));
      saveS(); render(true);
    }
    if (d.check) { if (el.checked) S.checks[d.check] = true; else delete S.checks[d.check]; saveS(); render(true); }
    if (d.since) { S.since[d.since] = E.addMonth(thisMonth(), Number(el.value)); saveS(); render(true); }
    if (d.proof !== undefined) {
      if (el.value === '') { delete S.checks['ibk-proof']; delete S.since['ibk-proof']; } else { S.checks['ibk-proof'] = true; S.since['ibk-proof'] = E.addMonth(thisMonth(), Number(el.value)); }
      saveS(); render(true);
    }
    if (d.pv !== undefined) { S.pointValue = Number(el.value); saveS(); }
    if (d.txdate) {
      const t = LEDGER.find((x) => x.id === d.txdate);
      if (!t || !el.value) return;
      const old = t.ts;
      const [y, m, dd] = el.value.split('-').map(Number);
      const nd = new Date(t.ts); nd.setFullYear(y, m - 1, dd);
      if (nd.getTime() > Date.now()) { el.value = ymd(old); toast('미래 날짜로는 바꿀 수 없어요'); return; }
      t.ts = nd.getTime();
      if (!saveLedger()) { t.ts = old; toast('⚠️ 날짜를 저장하지 못했어요'); }
      render(true);
    }
    if (el.id === 'showAll') { S.showAll = el.checked; saveS(); }
    if (el.id === 'importFile' && el.files[0]) { importData(el.files[0]); el.value = ''; }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'q' && ev.key === 'Enter') { const a = $('#amt'); if (a && !$('.amt-slot').hidden) a.focus(); else ev.target.blur(); }
    if (ev.target.id === 'amt' && ev.key === 'Enter') ev.target.blur();
    const ds = ev.target.dataset || {};
    if ((ev.key === 'Enter' || ev.key === ' ') && (ds.id || ds.tx) && ev.target.getAttribute('role') === 'button') { ev.preventDefault(); ev.target.click(); }
  });

  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  window.addEventListener('storage', (ev) => {
    if (ev.key === KEY) { S = clean(read(KEY)); render(true); }
    if (ev.key === LEDGER_KEY) { LEDGER = loadLedger(); render(true); }
  });

  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // 새 버전이 설치되면 한 번 자동 새로고침해서 바로 반영
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // 홈 화면 앱은 오래 켜져 있으니 다시 볼 때마다 업데이트 확인
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      }).catch(() => {});
    });
  }
})();
