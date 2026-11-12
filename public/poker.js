// Kerbside poker: no-limit hold'em and race side bets with friends in a hangout, for chips with no cash
// value. The hangout server deals and keeps the chips; this file draws the table in the casino garage,
// handles hands and controllers in the headset, and shows a poker panel on flat screens.
// Loaded on demand by index.html.
(function () {
'use strict';
const KB = window.KB, THREE = KB.THREE, App = KB.App, toast = KB.toast, renderer = KB.renderer;
const POKER_BUILD = 8;
const SEATS = 6;
const P = {
  state: null, bets: [], hole: null, hand: 0, mySeat: -1, bal: 0, rebuys: 0, top: null,
  open: false, tab: 'table', raiseTo: 0, betAmt: 500, betPick: {}, settled: new Set(), prevPit: new Map(),
  pending: 0, pendingChips: [], xrTab: 'act'
};
const send = m => { if (window.KBHang && KBHang.active()) KBHang.send(m); else toast('Join a hangout to play poker.'); };
const fmt = n => Math.round(n || 0).toLocaleString();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------------- Hand names for your own cards (the server decides who wins) ---------------- */
const RANKS = '23456789TJQKA';
const RN = ['', '', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];
const R1 = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];
function straightHigh(vals) { const h = new Set(vals); if (h.has(14)) h.add(1); for (let t = 14; t >= 5; t--) { let ok = true; for (let k = 0; k < 5; k++) if (!h.has(t - k)) { ok = false; break; } if (ok) return t; } return 0; }
function handLabel(cards) {
  if (!cards || cards.length < 2) return '';
  const vals = cards.map(c => RANKS.indexOf(c[0]) + 2), suits = {}; cards.forEach((c, i) => (suits[c[1]] = suits[c[1]] || []).push(vals[i]));
  const fl = Object.values(suits).find(v => v.length >= 5); if (fl && straightHigh(fl)) return straightHigh(fl) === 14 ? 'Royal flush' : 'Straight flush';
  const cnt = {}; vals.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
  const g = Object.entries(cnt).map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (g[0][0] === 4) return 'Four ' + RN[g[0][1]];
  if (g[0][0] === 3 && g[1] && g[1][0] >= 2) return 'Full house';
  if (fl) return 'Flush';
  if (straightHigh(vals)) return 'Straight';
  if (g[0][0] === 3) return 'Three ' + RN[g[0][1]];
  if (g[0][0] === 2 && g[1] && g[1][0] === 2) return `Two pair, ${RN[g[0][1]]} and ${RN[g[1][1]]}`;
  if (g[0][0] === 2) return 'Pair of ' + RN[g[0][1]];
  const hi = Math.max(...vals); return R1[hi][0].toUpperCase() + R1[hi].slice(1) + ' high';
}
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }, RED = { h: 1, d: 1 };
const rankTxt = r => r === 'T' ? '10' : r;

/* ---------------- Messages from the hangout ---------------- */
function onMsg(m) {
  if (m.a === 'state') {
    const prev = P.state; P.state = m.s; P.bets = m.bets || [];
    if (!prev || prev.hand !== m.s.hand || prev.toAct !== m.s.toAct) { P.pending = 0; P.pendingChips = []; P.raiseTo = 0; }
    if (m.s.toAct >= 0 && m.s.toAct === P.mySeat && (!prev || prev.toAct !== m.s.toAct)) myTurn();
  } else if (m.a === 'hole') {
    P.hole = m.hole; P.hand = m.hand; P.bal = m.bal; P.rebuys = m.rebuys; P.gotMe = true;
    if (m.seat !== P.mySeat) { P.mySeat = m.seat; placeMe(); seatedNow(); }
  } else if (m.a === 'me') { P.gotMe = true; P.bal = m.bal; P.rebuys = m.rebuys; if (m.seat !== P.mySeat) { P.mySeat = m.seat; placeMe(); seatedNow(); } }
  else if (m.a === 'err') toast(m.msg, 4000);
  else if (m.a === 'top') P.top = m.top;
  P.dirty = true;
}
// Practice: bots fill the empty seats once you've sat down.
const botsAtTable = () => (P.state ? P.state.seats.filter(s => s && /^bot-/.test(s.pid)).length : 0);
const addBots = n => send({ t: 'pk', a: 'bots', n });
const removeBots = () => send({ t: 'pk', a: 'bots', n: 0 });
function practice() { if (P.mySeat >= 0) addBots(3); else { P.wantBots = 3; const s = P.state; const free = s ? s.seats.findIndex(x => !x) : 0; sit(free < 0 ? 0 : free); } }
function seatedNow() { if (P.mySeat >= 0 && P.wantBots) { const n = P.wantBots; P.wantBots = 0; addBots(n); toast('Bots joined the table: a hand starts in a few seconds.', 4000); } }
function myTurn() {
  if (renderer.xr.isPresenting) buzz(0.5, 60); else if (!P.open) toast('♠ Your turn at the poker table.', 3000);
}
function placeMe() { // in the casino garage, sitting down moves you to your chair; standing up brings you back
  if (!window.KBGarage || !KBGarage.seatAt) return;
  if (P.mySeat >= 0 && App.env === 'garage' && App.garageLook === 'casino') KBGarage.seatAt(P.mySeat);
  else if (KBGarage.seated() >= 0) KBGarage.seatAt(-1);
}
function lookChanged() { placeMe(); P.dirty = true; }
// Place here: stand (or sit) where you want your seat to be in your real room, facing the way you want
// to face the table, and press it. The table is re-placed around you.
function placeHere() { if (P.mySeat >= 0 && window.KBGarage) { KBGarage.seatAt(P.mySeat, true); buzz(0.4, 30); toast('Your seat is where you are now.', 2500); } }

/* ---------------- Actions ---------------- */
const act = (a, amount) => send({ t: 'pk', a: 'act', act: a, amount });
function opts() { const s = P.state; return s && s.toAct === P.mySeat && P.mySeat >= 0 ? s.options : null; }
function potSize() { const s = P.state; return s ? s.pot + s.seats.reduce((a, x) => a + (x ? x.bet : 0), 0) : 0; }
function clampRaise(v) { const o = opts(); if (!o) return v; return Math.max(o.minTo, Math.min(o.maxTo, Math.round(v / 50) * 50 || o.minTo)); }
function doRaise(to) { const o = opts(); if (!o) return; to = to >= o.maxTo ? o.maxTo : clampRaise(to); if (to >= o.maxTo) act('allin'); else act('raise', to); }
function sit(i) { if (P.bal < 100) { toast('You’re out of chips: top up first.'); return; } send({ t: 'pk', a: 'sit', seat: i }); }
const me = () => (P.state && P.mySeat >= 0 ? P.state.seats[P.mySeat] : null);

/* ---------------- Race side bets ---------------- */
function lapNow() { const m = /Lap (\d+)/.exec(App.lapText || ''); return m ? +m[1] : null; }
function driverOptions(filter) {
  return (App.board || []).filter(filter || (() => true)).map(r => ({ k: String(r.num), label: r.tla || String(r.num) }));
}
function openMarket(kind) {
  if (!(App.board || []).length) { toast('Start a replay or go live first: race bets follow the race on the host’s screen.', 6000); return; }
  let options;
  if (kind === 'pit') options = driverOptions(r => !r.pit);
  else if (kind === 'leader') options = driverOptions().slice(0, 12);
  else options = [{ k: 'yes', label: 'Yes' }, { k: 'no', label: 'No' }];
  const lap = lapNow();
  if ((kind === 'leader' || kind === 'sc') && lap == null) { toast('This race has no lap count yet, so that bet can’t be settled.', 5000); return; }
  send({ t: 'bet', a: 'open', kind, options, info: { lap } });
}
function placeBet(id, opt, amt) { send({ t: 'bet', a: 'place', id, opt, amt: Math.floor(amt) }); }
// The host's app watches its own race view and reports results.
function hostSettle() {
  if (!window.KBHang || !KBHang.isHost()) return;
  const board = App.board || [], now = Date.now(), lap = lapNow();
  const risen = [];
  for (const r of board) { const was = P.prevPit.get(r.num); if (r.pit && was === false) risen.push(String(r.num)); P.prevPit.set(r.num, !!r.pit); }
  for (const m of P.bets) {
    if ((m.status !== 'open' && m.status !== 'closed') || P.settled.has(m.id) || now < m.closes) continue;
    let win = null;
    if (m.kind === 'pit' && risen.length) win = risen[0];
    else if (m.kind === 'leader' && lap != null && m.info.lap != null && lap >= m.info.lap + 3 && board[0]) win = String(board[0].num);
    else if (m.kind === 'sc') {
      if (/SAFETY CAR|\bSC\b|VSC/i.test((App.flag && App.flag.text) || '')) win = 'yes';
      else if (lap != null && m.info.lap != null && lap >= m.info.lap + 10) win = 'no';
    }
    if (win != null) { P.settled.add(m.id); send({ t: 'bet', a: 'settle', id: m.id, winner: win }); }
  }
}
const optLabel = (m, k) => (m.options.find(o => o.k === k) || { label: k }).label;

/* ---------------- Flat-screen panel ---------------- */
let el = null;
function buildUI() {
  if (el) return;
  const css = document.createElement('style');
  css.textContent = `
#pk { position: fixed; right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(76px + env(safe-area-inset-bottom, 0px)); z-index: 8; width: min(420px, calc(100% - 24px));
  max-height: calc(100% - 150px); overflow: auto; background: rgba(24,14,18,.96); border: 1px solid #6b2b3a; border-radius: 12px; padding: 12px; font: 400 14px/1.35 var(--body); color: var(--chalk); }
#pk h3 { margin: 0 0 8px; font: 700 20px/1 var(--cond); display: flex; align-items: center; gap: 8px; }
#pk h3 .x { margin-left: auto; background: none; border: 1px solid #6b2b3a; color: var(--muted); border-radius: 6px; padding: 4px 10px; font: 600 14px var(--cond); }
#pk .tabs { display: flex; gap: 4px; margin-bottom: 10px; } #pk .tabs button { flex: 1; background: none; border: 1px solid #6b2b3a; border-radius: 6px; color: var(--muted); padding: 7px 0; font: 600 15px/1 var(--cond); }
#pk .tabs button.on { background: #6b2b3a; color: var(--chalk); }
#pk .felt { position: relative; height: 230px; margin: 26px 0 26px; border-radius: 120px; background: radial-gradient(ellipse at center, #13814a 0%, #0c5a33 70%); border: 8px solid #1c0f12; box-shadow: inset 0 0 0 2px #c9a13b55; }
#pk .seat { position: absolute; transform: translate(-50%, -50%); min-width: 84px; text-align: center; background: rgba(15,10,12,.88); border: 1px solid #3a2a2e; border-radius: 8px; padding: 3px 6px; font-size: 12px; }
#pk .seat.turn { border-color: #f2b233; box-shadow: 0 0 0 2px #f2b23377; } #pk .seat.out { opacity: .5; } #pk .seat.me { border-color: #c9a13b; }
#pk .seat b { display: block; font: 700 14px/1.1 var(--cond); } #pk .seat .bet { color: #f2b233; } #pk .seat .tm { height: 3px; background: #f2b233; border-radius: 2px; margin-top: 2px; }
#pk .seat button { background: #c9a13b; color: #1c0f12; border: 0; border-radius: 5px; padding: 4px 8px; font: 700 13px var(--cond); }
#pk .db { display: inline-block; width: 16px; height: 16px; line-height: 16px; border-radius: 50%; background: #fff; color: #111; font: 700 11px var(--cond); margin-left: 3px; }
#pk .mid { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); text-align: center; }
#pk .card { display: inline-block; width: 30px; height: 42px; line-height: 42px; margin: 0 1px; background: #fbfaf6; color: #111; border-radius: 4px; font: 700 16px/42px var(--cond); text-align: center; vertical-align: middle; }
#pk .card.r { color: #c8102e; } #pk .card.bk { background: repeating-linear-gradient(45deg, #8e1b2c 0 4px, #6b1422 4px 8px); border: 2px solid #fbfaf6; }
#pk .card.sm { width: 20px; height: 28px; line-height: 28px; font-size: 12px; }
#pk .card.big { width: 52px; height: 72px; line-height: 72px; font-size: 26px; }
#pk .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
#pk .b { flex: 1; min-width: 70px; background: #2a1b20; border: 1px solid #6b2b3a; color: var(--chalk); border-radius: 7px; padding: 9px 6px; font: 600 16px/1 var(--cond); }
#pk .b.go { background: #c9a13b; color: #1c0f12; border-color: #c9a13b; } #pk .b.no { background: #4a1420; } #pk .b:disabled { opacity: .4; }
#pk input[type=range] { width: 100%; } #pk .sub { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
#pk .mk { border: 1px solid #3a2a2e; border-radius: 8px; padding: 8px; margin-top: 8px; } #pk .mk h4 { margin: 0 0 4px; font: 700 16px var(--cond); }
#pk .opts { display: flex; flex-wrap: wrap; gap: 4px; } #pk .opts button { background: #2a1b20; border: 1px solid #6b2b3a; color: var(--chalk); border-radius: 5px; padding: 5px 7px; font: 600 13px var(--cond); }
#pk .opts button.on { background: #c9a13b; color: #1c0f12; } #pk .opts small { color: var(--muted); margin-left: 3px; }
#pk ol { margin: 0; padding-left: 20px; } #pk li { margin: 3px 0; }
@media (max-width: 760px) { #pk { left: calc(8px + env(safe-area-inset-left, 0px)); right: calc(8px + env(safe-area-inset-right, 0px)); width: auto; top: calc(56px + env(safe-area-inset-top, 0px)); bottom: auto; max-height: calc(100% - 200px); } }`;
  document.head.appendChild(css);
  el = document.createElement('div'); el.id = 'pk'; el.hidden = true; document.body.appendChild(el);
  el.addEventListener('click', e => { const b = e.target.closest('[data-pk]'); if (b) uiAct(b.dataset.pk, b); });
  el.addEventListener('input', e => {
    if (e.target.id === 'pkRaise') { P.raiseTo = +e.target.value; const l = el.querySelector('#pkRaiseLbl'); if (l) l.textContent = fmt(P.raiseTo); }
    if (e.target.id === 'pkBetAmt') P.betAmt = Math.max(1, Math.floor(+e.target.value || 0));
  });
}
function uiAct(a, b) {
  const o = opts();
  switch (a) {
    case 'close': P.open = false; el.hidden = true; return;
    case 'tab': P.tab = b.dataset.t; if (P.tab === 'top') send({ t: 'pk', a: 'top' }); break;
    case 'sit': sit(+b.dataset.s); break;
    case 'stand': send({ t: 'pk', a: 'stand' }); break;
    case 'sitout': send({ t: 'pk', a: 'sitout', on: !(me() && me().sitOut) }); break;
    case 'topup': send({ t: 'pk', a: 'topup' }); break;
    case 'practice': practice(); break;
    case 'addbot': addBots(1); break;
    case 'fillbots': addBots(5); break;
    case 'nobots': removeBots(); break;
    case 'fold': act('fold'); break;
    case 'check': act(o && o.canCheck ? 'check' : 'call'); break;
    case 'raise': doRaise(P.raiseTo || (o && o.minTo)); break;
    case 'half': P.raiseTo = clampRaise((P.state.curBet || 0) + potSize() / 2); break;
    case 'pot': P.raiseTo = clampRaise((P.state.curBet || 0) + potSize()); break;
    case 'allin': act('allin'); break;
    case 'open': openMarket(b.dataset.k); break;
    case 'pick': P.betPick[b.dataset.m] = b.dataset.o; break;
    case 'bet': { const id = +b.dataset.m, pick = P.betPick[id]; if (!pick) { toast('Pick who you’re backing first.'); return; } placeBet(id, pick, P.betAmt); break; }
    case 'void': send({ t: 'bet', a: 'void', id: +b.dataset.m }); break;
  }
  P.dirty = true; render();
}
function cardHtml(c, cls = '') { return c ? `<span class="card ${RED[c[1]] ? 'r' : ''} ${cls}">${rankTxt(c[0])}${SUIT[c[1]]}</span>` : `<span class="card bk ${cls}"></span>`; }
const POS = [[50, 86], [9, 68], [9, 30], [50, 13], [91, 30], [91, 68]]; // % across and down the felt
function render() {
  if (!el || el.hidden) return;
  const ae = document.activeElement; if (ae && el.contains(ae) && ae.tagName === 'INPUT') return; // don't redraw under your finger
  const s = P.state, inRoom = window.KBHang && KBHang.active();
  let h = `<h3>♠ Poker <span class="sub" style="margin:0">blinds 50/100 · chips have no cash value</span><button class="x" data-pk="close">Close</button></h3>`;
  h += `<div class="tabs">${[['table', 'Table'], ['bets', 'Race bets'], ['top', 'Leaders']].map(([k, l]) => `<button data-pk="tab" data-t="${k}" class="${P.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (!inRoom) h += `<p>Join or start a hangout to play with friends.</p>`;
  else if (P.tab === 'table') h += tableHtml(s);
  else if (P.tab === 'bets') h += betsHtml();
  else h += `<ol>${(P.top || []).map(r => `<li><b>${esc(r.name)}</b> ${fmt(r.bal)}<span class="sub"> · best ${fmt(r.best)}${r.rebuys ? ' · ' + r.rebuys + ' top-up' + (r.rebuys > 1 ? 's' : '') : ''}</span></li>`).join('') || '<p class="sub">Loading…</p>'}</ol>`;
  h += `<p class="sub">Your chips: <b>${fmt(P.bal)}</b>${P.rebuys ? ` · ${P.rebuys} top-up${P.rebuys > 1 ? 's' : ''}` : ''} · Poker build ${POKER_BUILD}</p>`;
  el.innerHTML = h;
}
function tableHtml(s) {
  if (!s) return '<p class="sub">Connecting to the table…</p>';
  const mine = P.mySeat, rot = mine >= 0 ? mine : 0, now = Date.now();
  let h = '<div class="felt">';
  for (let i = 0; i < SEATS; i++) {
    const st = s.seats[i], [x, y] = POS[(i - rot + SEATS) % SEATS];
    if (!st) { h += `<div class="seat" style="left:${x}%;top:${y}%">${mine < 0 ? `<button data-pk="sit" data-s="${i}">Sit here</button>` : '<span class="sub">open</span>'}</div>`; continue; }
    const turn = s.toAct === i, left = turn ? Math.max(0, (s.deadline - now) / 40000) : 0;
    const cards = st.shown ? st.shown.map(c => cardHtml(c, 'sm')).join('') : st.cards ? cardHtml(null, 'sm') + cardHtml(null, 'sm') : '';
    h += `<div class="seat ${turn ? 'turn' : ''} ${st.folded || st.sitOut ? 'out' : ''} ${i === mine ? 'me' : ''}" style="left:${x}%;top:${y}%">
      <b>${esc(st.name)}${s.button === i ? '<span class="db">D</span>' : ''}</b>${fmt(st.stack)}${st.allIn ? ' · all in' : st.sitOut ? ' · away' : st.folded ? ' · fold' : ''}
      ${st.bet ? `<div class="bet">${fmt(st.bet)}</div>` : ''}<div>${cards}</div>${turn ? `<div class="tm" style="width:${Math.round(left * 100)}%"></div>` : ''}</div>`;
  }
  h += `<div class="mid">${s.board.map(c => cardHtml(c)).join('') || '<span class="sub">' + (s.phase === 'idle' ? 'Waiting for two players' : '') + '</span>'}<div style="margin-top:4px">Pot <b>${fmt(potSize())}</b></div></div></div>`;
  if (s.result && s.phase === 'done') h += `<p><b>${s.result.winners.map(w => `${esc(w.name)} wins ${fmt(w.amount)}${w.hand ? ' with ' + esc(w.hand) : ''}`).join(' · ')}</b></p>`;
  if (mine < 0) return h + `<p class="sub">Pick a seat to play, or practise against bots. ${P.bal < 100 ? '<button class="b" data-pk="topup">Top up to 10,000</button>' : ''}</p><div class="row"><button class="b go" data-pk="practice">Practise with bots</button></div>`;
  const st = s.seats[mine];
  if (P.hole) h += `<div class="row">${P.hole.map(c => cardHtml(c, 'big')).join('')}<span style="margin-left:8px">${esc(handLabel([...P.hole, ...s.board]))}</span></div>`;
  const o = opts();
  if (o) {
    if (!P.raiseTo || P.raiseTo < o.minTo) P.raiseTo = o.minTo;
    h += `<div class="row"><button class="b no" data-pk="fold">Fold</button><button class="b" data-pk="check">${o.canCheck ? 'Check' : 'Call ' + fmt(o.call)}</button>${o.canRaise ? `<button class="b go" data-pk="raise">${s.curBet ? 'Raise' : 'Bet'} <span id="pkRaiseLbl">${fmt(P.raiseTo)}</span></button>` : ''}</div>`;
    if (o.canRaise && o.maxTo > o.minTo) h += `<div class="row"><input type="range" id="pkRaise" min="${o.minTo}" max="${o.maxTo}" step="50" value="${P.raiseTo}"></div><div class="row"><button class="b" data-pk="half">½ pot</button><button class="b" data-pk="pot">Pot</button><button class="b" data-pk="allin">All in</button></div>`;
  } else if (s.toAct >= 0 && s.seats[s.toAct]) h += `<p class="sub">Waiting for ${esc(s.seats[s.toAct].name)}…</p>`;
  h += `<div class="row"><button class="b" data-pk="addbot" ${s.seats.every(Boolean) ? 'disabled' : ''}>+ Bot</button><button class="b" data-pk="fillbots" ${s.seats.every(Boolean) ? 'disabled' : ''}>Fill with bots</button>${botsAtTable() ? '<button class="b" data-pk="nobots">Remove bots</button>' : ''}</div>`;
  h += `<div class="row"><button class="b" data-pk="sitout">${st && st.sitOut ? 'I’m back' : 'Sit out'}</button><button class="b" data-pk="stand">Leave table</button>${st && st.stack < 100 && !(st.inHand && s.phase !== 'done' && s.phase !== 'idle') ? '<button class="b go" data-pk="topup">Top up</button>' : ''}</div>`;
  return h;
}
function betsHtml() {
  const host = window.KBHang && KBHang.isHost(), now = Date.now();
  let h = '<p class="sub">Pool bets on the race: winners share everything staked, in proportion to their stake. The host’s screen settles them.</p>';
  if (host) {
    const running = k => P.bets.some(m => m.kind === k && (m.status === 'open' || m.status === 'closed'));
    h += `<div class="row">${[['pit', 'Next to pit'], ['leader', 'Leader in 3 laps'], ['sc', 'Safety car in 10 laps?']].map(([k, l]) => `<button class="b" data-pk="open" data-k="${k}" ${running(k) ? 'disabled' : ''}>${l}</button>`).join('')}</div>`;
  }
  const list = P.bets.slice().reverse();
  if (!list.length) h += `<p class="sub">${host ? 'Open a bet above.' : 'No bets yet: the host opens them.'}</p>`;
  for (const m of list) {
    const left = Math.max(0, Math.ceil((m.closes - now) / 1000)), mineStake = m.bets.filter(b => b.pid === (KBHang.pid && KBHang.pid())).reduce((a, b) => a + b.amt, 0);
    h += `<div class="mk"><h4>${esc(m.label)}</h4><div class="sub">${m.status === 'open' ? `Open · ${left}s left` : m.status === 'closed' ? 'Betting closed · waiting for the result' : m.status === 'settled' ? (m.refunded ? `Result: ${esc(optLabel(m, m.winner))} · nobody picked it, stakes returned` : `Result: <b>${esc(optLabel(m, m.winner))}</b>`) : 'Called off · stakes returned'} · pool ${fmt(m.pool)}${mineStake ? ` · your stake ${fmt(mineStake)}` : ''}</div>`;
    if (m.status === 'open') {
      h += `<div class="opts" style="margin-top:6px">${m.options.map((o, i) => `<button data-pk="pick" data-m="${m.id}" data-o="${esc(o.k)}" class="${P.betPick[m.id] === o.k ? 'on' : ''}">${esc(o.label)}${m.byOpt[i] ? `<small>${fmt(m.byOpt[i])}</small>` : ''}</button>`).join('')}</div>`;
      h += `<div class="row"><input type="number" id="pkBetAmt" min="1" step="100" value="${P.betAmt}" style="flex:1;min-width:0"><button class="b go" data-pk="bet" data-m="${m.id}">Bet</button></div>`;
    }
    if (m.payouts && m.status === 'settled' && !m.refunded) h += `<div class="sub">Paid: ${m.payouts.map(x => `${esc(x.name || '')} ${fmt(x.amt)}`).join(', ')}</div>`;
    if ((host || (m.opener && m.opener === KBHang.pid())) && (m.status === 'open' || m.status === 'closed')) h += `<div class="row"><button class="b" data-pk="void" data-m="${m.id}">Call it off</button></div>`;
    h += '</div>';
  }
  return h;
}
// From the headset menu: show the poker panel at the table (the table itself is in the casino garage).
function openXR() { P.xrOpen = true; P.xrTab = 'act'; send({ t: 'pk', a: 'state' }); if (T3) T3.bar.sig = ''; }
function openUI() { buildUI(); P.open = true; el.hidden = false; send({ t: 'pk', a: 'state' }); P.dirty = true; render(); }

/* ---------------- The table in the casino garage ---------------- */
// Real-size cards (6.3 x 8.8 cm) and chips lie on the felt; name plates float over each chair.
const CW = 0.063, CH = 0.088;
const cardTex = new Map();
function cardTexture(code) {
  const key = code || 'back'; if (cardTex.has(key)) return cardTex.get(key);
  const cv = document.createElement('canvas'); cv.width = 126; cv.height = 176; const c = cv.getContext('2d');
  KB.rr(c, 2, 2, 122, 172, 12); c.fillStyle = '#fbfaf6'; c.fill();
  if (!code) { KB.rr(c, 10, 10, 106, 156, 8); c.fillStyle = '#8e1b2c'; c.fill(); c.strokeStyle = '#c9a13b'; c.lineWidth = 4; c.stroke(); c.fillStyle = '#c9a13b'; c.font = '700 44px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('K', 63, 90); }
  else {
    c.fillStyle = RED[code[1]] ? '#c8102e' : '#141414'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '700 46px "Barlow Condensed", sans-serif'; c.fillText(rankTxt(code[0]), 30, 34); c.font = '36px sans-serif'; c.fillText(SUIT[code[1]], 30, 76);
    c.font = '78px sans-serif'; c.fillText(SUIT[code[1]], 74, 118);
  }
  const t = new THREE.CanvasTexture(cv); cardTex.set(key, t); return t;
}
const cardGeo = new THREE.PlaneGeometry(CW, CH);
const CARD_T = 0.003, CARD_Y = 0.004; // thickness, and how high a card's centre sits above the table
const cardSlab = new THREE.BoxGeometry(CW, CH, CARD_T), cardEdge = new THREE.MeshBasicMaterial({ color: 0xd9d4c8 });
function makeCard() {
  const g = new THREE.Group();
  const face = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: cardTexture('back') }));
  const back = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: cardTexture(null) })); back.rotation.y = Math.PI;
  // a 3 mm slab between the two faces: cards have real thickness and sit clear of the felt, so they don't flicker
  const slab = new THREE.Mesh(cardSlab, cardEdge); face.position.z = CARD_T / 2 + 0.0002; back.position.z = -CARD_T / 2 - 0.0002;
  g.add(slab, face, back); g.userData = { face, back, code: undefined };
  return g;
}
function setCard(g, code, faceUp) { // lying on the felt: face up shows the card, face down shows the back
  if (g.userData.code !== code) { g.userData.code = code; g.userData.face.material.map = cardTexture(code || null); g.userData.face.material.needsUpdate = true; }
  g.userData.faceUp = faceUp;
}
const DENOMS = [[5000, 0xf28a1e], [1000, 0xe8c33a], [500, 0x8e5bd6], [100, 0x222428], [25, 0x2f8f4e]];
const chipGeo = new THREE.CylinderGeometry(0.019, 0.019, 0.0034, 18), chipMats = new Map();
const chipMat = d => { if (!chipMats.has(d)) { const m = KBMat({ color: DENOMS.find(x => x[0] === d)[1] }, 'plastic'); chipMats.set(d, m); } return chipMats.get(d); };
function chipsFor(amount) { const out = []; let left = Math.round(amount); for (const [d] of DENOMS) { let n = Math.floor(left / d); left -= n * d; if (n) out.push([d, n]); } if (left > 0) out.push([25, 1]); return out; }
function buildStack(group, amount) { // chip towers, one per colour, capped so a big stack still looks tidy
  if (group.userData.amount === amount) return; group.userData.amount = amount;
  while (group.children.length) group.remove(group.children[0]);
  chipsFor(amount).slice(0, 4).forEach(([d, n], k) => {
    for (let j = 0; j < Math.min(n, 16); j++) { const m = new THREE.Mesh(chipGeo, chipMat(d)); m.position.set((k % 2) * 0.042, 0.0017 + j * 0.0035, Math.floor(k / 2) * 0.042); group.add(m); }
  });
}
function plate(w = 256, h = 96) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const tex = new THREE.CanvasTexture(cv); const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true })); sp.userData = { cv, tex, sig: '' }; return sp; }
function drawPlate(sp, sig, draw) { if (sp.userData.sig === sig) return; sp.userData.sig = sig; const c = sp.userData.cv.getContext('2d'); c.clearRect(0, 0, sp.userData.cv.width, sp.userData.cv.height); draw(c, sp.userData.cv.width, sp.userData.cv.height); sp.userData.tex.needsUpdate = true; }
let T3 = null;
function build3D(anchor) {
  const g = new THREE.Group(); anchor.add(g);
  const seats = [];
  const geo = KBGarage.pokerGeo;
  for (let i = 0; i < SEATS; i++) {
    const sp = KBGarage.seatSpot(i, 1, 1); // unit direction from the centre towards seat i
    const dx = sp.x - geo.x, dz = sp.z - geo.z, n = Math.hypot(dx / geo.rx, dz / geo.rz) || 1;
    const at = f => new THREE.Vector3(dx / n * f, 0, dz / n * f); // f = 1 at the felt edge
    const side = new THREE.Vector3(-dz, 0, dx).normalize();
    const s = { dir: new THREE.Vector3(dx, 0, dz).normalize(), side, yaw: sp.yaw,
      cards: [makeCard(), makeCard()], stack: new THREE.Group(), bet: new THREE.Group(), pend: new THREE.Group(), plate: plate(),
      cardAt: at(0.8), stackAt: at(0.86).addScaledVector(side, 0.17), betAt: at(0.55), pendAt: at(0.68), btnAt: at(0.72).addScaledVector(side, -0.15) };
    s.cards.forEach((c, k) => { c.position.copy(s.cardAt).addScaledVector(side, (k - 0.5) * 0.07); c.position.y = CARD_Y; c.rotation.set(-Math.PI / 2, 0, -s.yaw + Math.PI); g.add(c); c.userData.home = c.position.clone(); c.userData.homeRot = c.rotation.clone(); c.userData.seat = i; c.userData.k = k; });
    s.stack.position.copy(s.stackAt); s.bet.position.copy(s.betAt); s.pend.position.copy(s.pendAt);
    s.plate.position.copy(at(1.45)); s.plate.position.y = 0.5; s.plate.scale.set(0.42, 0.16, 1);
    g.add(s.stack, s.bet, s.pend, s.plate);
    // the drop circle where you put chips you're about to bet
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.085, 32), new THREE.MeshBasicMaterial({ color: 0xc9a13b, transparent: true, opacity: 0.55 }));
    ring.rotation.x = -Math.PI / 2; ring.position.copy(s.pendAt); ring.position.y = 0.0015; g.add(ring); s.ring = ring;
    // chip trays at your place: pick a chip up from here
    s.trays = [100, 500, 1000].map((d, k) => { const t = new THREE.Group(); t.position.copy(at(0.9)).addScaledVector(side, -0.1 - k * 0.07); for (let j = 0; j < 6; j++) { const m = new THREE.Mesh(chipGeo, chipMat(d)); m.position.y = 0.0017 + j * 0.0035; t.add(m); } t.userData.denom = d; g.add(t); return t; });
    seats.push(s);
  }
  const board = [0, 1, 2, 3, 4].map(k => { const c = makeCard(); c.position.set((k - 2) * 0.075, CARD_Y, -0.02); c.rotation.set(-Math.PI / 2, 0, 0); g.add(c); return c; });
  const pot = new THREE.Group(); pot.position.set(-0.03, 0, 0.1); g.add(pot);
  const potPlate = plate(320, 72); potPlate.position.set(0, 0.16, 0.1); potPlate.scale.set(0.3, 0.068, 1); g.add(potPlate);
  const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.008, 20), KBMat({ color: 0xffffff }, 'plastic')); g.add(btn);
  // the action bar floats over the felt in front of you (headset)
  const bar = { cv: document.createElement('canvas') }; bar.cv.width = 1024; bar.cv.height = 400; bar.tex = new THREE.CanvasTexture(bar.cv);
  bar.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.242), new THREE.MeshBasicMaterial({ map: bar.tex, transparent: true, side: THREE.DoubleSide }));
  bar.mesh.visible = false; g.add(bar.mesh); bar.hits = [];
  g.traverse(o => { if (o.material && KBGarage.stencil) [].concat(o.material).forEach(m => { if (!m.isSpriteMaterial) KBGarage.stencil(m); }); });
  return { g, seats, board, pot, potPlate, btn, bar, anchor };
}
const vT = new THREE.Vector3();
function update3D() {
  const anchor = window.KBGarage && KBGarage.pokerAnchor && KBGarage.pokerAnchor();
  const show = !!anchor && App.env === 'garage' && App.garageLook === 'casino' && window.KBHang && KBHang.active();
  if (!show) { if (T3) T3.g.visible = false; return; }
  if (!T3 || T3.anchor !== anchor) T3 = build3D(anchor);
  T3.g.visible = true;
  const s = P.state, now = Date.now();
  for (let i = 0; i < SEATS; i++) {
    const S = T3.seats[i], st = s && s.seats[i], mine = i === P.mySeat;
    const showCards = st && st.cards > 0;
    S.cards.forEach((c, k) => {
      c.visible = !!showCards || c === held.obj;
      if (!c.visible || c === held.obj) return;
      const code = st.shown ? st.shown[k] : mine && P.hole ? P.hole[k] : null;
      setCard(c, code, !!st.shown);
      c.position.copy(c.userData.home); c.rotation.copy(c.userData.homeRot);
      if (!st.shown) c.rotation.x = Math.PI / 2; // face down
    });
    buildStack(S.stack, st ? st.stack : 0); buildStack(S.bet, st ? st.bet : 0);
    buildStack(S.pend, mine ? P.pending : 0);
    S.ring.visible = mine; S.trays.forEach(t => t.visible = mine && !!opts());
    const turn = s && s.toAct === i, left = turn ? Math.max(0, (s.deadline - now) / 40000) : 0;
    const sig = st ? `${st.name}|${st.stack}|${st.folded}|${st.allIn}|${st.sitOut}|${turn}|${Math.round(left * 20)}|${mine}` : `open|${P.mySeat}`;
    drawPlate(S.plate, sig, (c, w, h) => {
      KB.rr(c, 4, 4, w - 8, h - 8, 14); c.fillStyle = turn ? 'rgba(242,178,51,.95)' : 'rgba(24,14,18,.85)'; c.fill();
      c.strokeStyle = mine ? '#c9a13b' : '#6b2b3a'; c.lineWidth = 4; c.stroke();
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = turn ? '#1c0f12' : '#E9E6DF';
      if (!st) { c.font = '600 30px "Barlow Condensed", sans-serif'; c.fillText(P.mySeat < 0 ? 'Sit here' : 'Open seat', w / 2, h / 2); return; }
      c.font = '700 32px "Barlow Condensed", sans-serif'; c.fillText(st.name, w / 2, 32);
      c.font = '500 26px Barlow, sans-serif'; c.fillText(fmt(st.stack) + (st.allIn ? ' · all in' : st.sitOut ? ' · away' : st.folded ? ' · fold' : ''), w / 2, 66);
      if (turn) { c.fillStyle = '#1c0f12'; c.fillRect(20, h - 14, (w - 40) * left, 6); }
    });
    S.plate.userData.seat = i; S.plate.userData.empty = !st;
  }
  if (s) {
    T3.board.forEach((c, k) => { c.visible = k < s.board.length; if (c.visible) setCard(c, s.board[k], true); });
    buildStack(T3.pot, s.pot);
    drawPlate(T3.potPlate, `${s.pot}|${s.phase}|${s.result ? s.hand : ''}`, (c, w, h) => {
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = '700 34px "Barlow Condensed", sans-serif'; c.fillStyle = '#E9E6DF';
      c.shadowColor = '#000'; c.shadowBlur = 6;
      const r = s.phase === 'done' && s.result ? s.result.winners.map(x => `${x.name} +${fmt(x.amount)}`).join(' · ') : s.pot ? 'Pot ' + fmt(s.pot) : s.phase === 'idle' ? 'Waiting for players' : '';
      c.fillText(r, w / 2, h / 2);
    });
    if (s.button >= 0) { T3.btn.visible = true; T3.btn.position.copy(T3.seats[s.button].btnAt); T3.btn.position.y = 0.004; } else T3.btn.visible = false;
  }
  updateBar();
}

/* ---------------- Headset: action bar ---------------- */
function updateBar() {
  const bar = T3.bar, xr = renderer.xr.isPresenting, mine = P.mySeat >= 0;
  bar.mesh.visible = xr && (mine || P.xrOpen);
  if (!bar.mesh.visible) return;
  if (mine) {
    const S = T3.seats[P.mySeat];
    bar.mesh.position.copy(S.dir).multiplyScalar(0.62 * KBGarage.pokerGeo.rx); bar.mesh.position.y = 0.2;
    bar.mesh.rotation.set(-0.5, S.yaw + Math.PI, 0, 'YXZ');
  } else { // not seated yet: stand the panel up at the edge of the table nearest you, facing you
    const L = T3.anchor.worldToLocal(vT.copy(KB.xrHead())); let dx = L.x, dz = L.z; const n = Math.hypot(dx, dz) || 1; dx /= n; dz /= n;
    bar.mesh.position.set(dx * (KBGarage.pokerGeo.rx + 0.05), 0.42, dz * (KBGarage.pokerGeo.rz + 0.05));
    bar.mesh.rotation.set(-0.25, Math.atan2(-dx, -dz) + Math.PI, 0, 'YXZ');
  }
  const o = opts(), s = P.state, st = me(), now = Date.now();
  const sig = JSON.stringify([P.mySeat, s && s.seats.map(x => x && [x.name, x.stack]), P.xrTab, o, P.pending, P.raiseTo, st && st.sitOut, s && s.toAct, s && Math.round((s.deadline - now) / 1000), P.bets.map(m => [m.id, m.status, m.pool, Math.round((m.closes - now) / 1000)]), P.betPick, P.betAmt, P.hover, P.bal]);
  if (sig === bar.sig) return; bar.sig = sig;
  const c = bar.cv.getContext('2d'), W = 1024, H = 400, hits = bar.hits = [];
  c.clearRect(0, 0, W, H); KB.rr(c, 4, 4, W - 8, H - 8, 22); c.fillStyle = 'rgba(24,14,18,.92)'; c.fill(); c.strokeStyle = '#6b2b3a'; c.lineWidth = 4; c.stroke();
  const btn = (x, y, w, h, label, fn, kind) => {
    const hov = P.hover && P.hover.x >= x && P.hover.x <= x + w && P.hover.y >= y && P.hover.y <= y + h;
    KB.rr(c, x, y, w, h, 12); c.fillStyle = kind === 'go' ? '#c9a13b' : kind === 'no' ? '#4a1420' : kind === 'off' ? '#1c1418' : '#2a1b20'; c.fill();
    c.strokeStyle = hov ? '#f2b233' : '#6b2b3a'; c.lineWidth = hov ? 5 : 3; c.stroke();
    c.fillStyle = kind === 'go' ? '#1c0f12' : kind === 'off' ? '#6f6266' : '#E9E6DF'; c.font = '700 34px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h / 2 + 2); if (fn && kind !== 'off') hits.push({ x, y, w, h, fn });
  };
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  btn(24, 20, 150, 56, 'Table', () => P.xrTab = 'act', P.xrTab === 'act' ? 'go' : ''); btn(186, 20, 150, 56, 'Race bets', () => P.xrTab = 'bets', P.xrTab === 'bets' ? 'go' : '');
  c.textAlign = 'right'; c.font = '500 28px Barlow, sans-serif'; c.fillStyle = '#94A1A8'; c.fillText('Chips ' + fmt(P.bal), W - 28, 58); c.textAlign = 'left';
  if (P.xrTab === 'act' && !mine) { // the lobby: pick a seat
    c.font = '600 30px "Barlow Condensed", sans-serif'; c.fillStyle = '#E9E6DF';
    c.fillText(!s ? 'Connecting to the table…' : 'Pick a seat. A hand starts once two players are seated. Blinds 50/100.', 28, 124);
    for (let i = 0; i < SEATS; i++) {
      const st = s && s.seats[i], x = 24 + (i % 3) * 330, y = 146 + Math.floor(i / 3) * 72;
      if (st) btn(x, y, 316, 62, `${st.name.slice(0, 10)} · ${fmt(st.stack)}`, null, 'off');
      else btn(x, y, 316, 62, `Seat ${i + 1} · Sit here`, s ? () => sit(i) : null, s ? 'go' : 'off');
    }
    btn(24, 300, 220, 70, 'Close', () => { P.xrOpen = false; });
    if (P.bal < 100) btn(256, 300, 260, 70, 'Top up to 10,000', () => send({ t: 'pk', a: 'topup' }), 'go');
    else btn(256, 300, 260, 70, 'Practise with bots', s ? practice : null, s ? 'go' : 'off');
    c.font = '500 22px Barlow, sans-serif'; c.fillStyle = '#94A1A8'; c.fillText('Chips have no cash value.', 540, 344);
  } else if (P.xrTab === 'act') {
    c.font = '600 32px "Barlow Condensed", sans-serif'; c.fillStyle = '#E9E6DF';
    const info = o ? `Your turn · ${Math.max(0, Math.round((s.deadline - now) / 1000))}s${P.pending ? ' · chips in the circle: ' + fmt(P.pending) : ''}` : s && s.toAct >= 0 && s.seats[s.toAct] ? `Waiting for ${s.seats[s.toAct].name}` : s && s.phase === 'idle' ? 'Waiting for another player' : '';
    c.fillText(info, 28, 124);
    if (o) {
      if (!P.raiseTo || P.raiseTo < o.minTo) P.raiseTo = o.minTo;
      btn(24, 150, 170, 80, 'Fold', () => act('fold'), 'no');
      btn(206, 150, 230, 80, o.canCheck ? 'Check' : 'Call ' + fmt(o.call), () => act(o.canCheck ? 'check' : 'call'));
      btn(448, 150, 70, 80, '−', () => P.raiseTo = clampRaise(P.raiseTo - 100), o.canRaise ? '' : 'off');
      btn(530, 150, 260, 80, (s.curBet ? 'Raise to ' : 'Bet ') + fmt(P.pending ? Math.max(o.minTo, (me().bet || 0) + P.pending) : P.raiseTo), () => doRaise(P.pending ? (me().bet || 0) + P.pending : P.raiseTo), o.canRaise ? 'go' : 'off');
      btn(802, 150, 70, 80, '+', () => P.raiseTo = clampRaise(P.raiseTo + 100), o.canRaise ? '' : 'off');
      btn(884, 150, 116, 80, 'All in', () => act('allin'), o.canRaise ? '' : 'off');
    }
    c.font = '500 24px Barlow, sans-serif'; c.fillStyle = '#94A1A8';
    c.fillText('Pick up your cards to look · drop chips in the gold circle · knock the table to check · throw your cards in to fold', 28, 268);
    btn(24, 300, 220, 70, st && st.sitOut ? 'I’m back' : 'Sit out', () => send({ t: 'pk', a: 'sitout', on: !(st && st.sitOut) }));
    btn(256, 300, 220, 70, 'Leave table', () => send({ t: 'pk', a: 'stand' }));
    btn(488, 300, 220, 70, 'Place here', placeHere);
    if (st && st.stack < 100) btn(720, 300, 220, 70, 'Top up', () => send({ t: 'pk', a: 'topup' }), 'go');
    else if (botsAtTable()) btn(720, 300, 220, 70, 'Remove bots', removeBots);
    else btn(720, 300, 220, 70, 'Add bots', () => addBots(3), s && s.seats.every(Boolean) ? 'off' : '');
  } else {
    const live = P.bets.filter(m => m.status === 'open'), host = KBHang.isHost();
    let y = 100;
    if (host) { [['pit', 'Next to pit'], ['leader', 'Leader +3 laps'], ['sc', 'Safety car?']].forEach(([k, l], i) => btn(24 + i * 250, y, 236, 56, l, () => openMarket(k), P.bets.some(m => m.kind === k && (m.status === 'open' || m.status === 'closed')) ? 'off' : '')); y += 70; }
    const m = live[live.length - 1];
    if (!m) { c.font = '500 28px Barlow, sans-serif'; c.fillStyle = '#94A1A8'; c.fillText(host ? 'Open a bet above.' : 'No open bets: the host opens them.', 28, y + 40); return void (bar.tex.needsUpdate = true); }
    c.font = '600 30px "Barlow Condensed", sans-serif'; c.fillStyle = '#E9E6DF'; c.fillText(`${m.label} · ${Math.max(0, Math.round((m.closes - now) / 1000))}s · pool ${fmt(m.pool)}`, 28, y + 30); y += 44;
    m.options.slice(0, 12).forEach((op, i) => btn(24 + (i % 6) * 164, y + Math.floor(i / 6) * 58, 154, 50, op.label, () => P.betPick[m.id] = op.k, P.betPick[m.id] === op.k ? 'go' : ''));
    y += Math.ceil(Math.min(12, m.options.length) / 6) * 58 + 6;
    btn(24, y, 70, 56, '−', () => P.betAmt = Math.max(100, P.betAmt - 100)); btn(104, y, 200, 56, fmt(P.betAmt), null); btn(314, y, 70, 56, '+', () => P.betAmt += 100);
    btn(400, y, 220, 56, 'Place bet', () => P.betPick[m.id] ? placeBet(m.id, P.betPick[m.id], P.betAmt) : toast('Pick who you’re backing first.'), 'go');
  }
  bar.tex.needsUpdate = true;
}
function barHit(ray) {
  if (!T3 || !T3.bar.mesh.visible) return null;
  const h = ray.intersectObject(T3.bar.mesh, false)[0]; if (!h || !h.uv) return null;
  return { x: h.uv.x * 1024, y: (1 - h.uv.y) * 400 };
}
function onSelect(e) { // trigger (or pinch) while pointing: action bar buttons, and empty seats to sit down
  if (!T3 || !T3.g.visible) return false;
  KB.rayFrom(e.target); const ray = KB.raycaster; ray.camera = KB.camera;
  const p = barHit(ray);
  if (p) { const b = T3.bar.hits.find(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h); if (b) { b.fn(); T3.bar.sig = ''; buzz(0.3, 20); } return true; }
  if (P.mySeat < 0) {
    const h = ray.intersectObjects(T3.seats.map(s => s.plate), false)[0];
    if (h && h.object.userData.empty) { sit(h.object.userData.seat); return true; }
  }
  if (held.obj || nearSomething) return true; // a pinch used to grab something isn't also a click
  return false;
}

/* ---------------- Headset: hands and controllers ---------------- */
// Grab with a pinch (hands) or the grip button (controllers). Your cards: lift them to look, let go over the
// middle of the table to fold. Chips: take one from your trays and let go over the gold circle to add it to
// your bet; take chips back out of the circle the same way. Knock on the felt to check (or to confirm the
// chips in the circle as your bet or call).
const held = { obj: null, src: null, kind: null, denom: 0 };
let nearSomething = false;
const hands = new Map(); // inputSource -> { pos (anchor-local), grab, wasGrab, prevY, t }
const hW = new THREE.Vector3(), hL = new THREE.Vector3();
let heldChip = null;
function buzz(v, ms) {
  const session = renderer.xr.getSession(); if (!session) return;
  for (const src of session.inputSources) { const a = src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0]; if (a && a.pulse) try { a.pulse(v, ms); } catch (e) {} }
}
function readHands(frame) {
  const session = renderer.xr.getSession(), ref = renderer.xr.getReferenceSpace(), out = [];
  if (!session || !frame || !ref) return out;
  for (const src of session.inputSources) {
    let pos = null, grab = false;
    if (src.hand && frame.getJointPose) {
      const th = src.hand.get('thumb-tip'), ix = src.hand.get('index-finger-tip');
      const a = th && frame.getJointPose(th, ref), b = ix && frame.getJointPose(ix, ref);
      if (a && b) {
        const pa = a.transform.position, pb = b.transform.position, d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
        pos = hW.set((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2).clone();
        const prev = hands.get(src); grab = prev && prev.grab ? d < 0.04 : d < 0.022; // a little stickier once pinched
      }
    } else if (src.gripSpace) {
      const g = frame.getPose(src.gripSpace, ref);
      if (g) { const p = g.transform.position; pos = new THREE.Vector3(p.x, p.y, p.z); }
      grab = !!(src.gamepad && src.gamepad.buttons[1] && src.gamepad.buttons[1].pressed);
    }
    if (pos) out.push({ src, pos, grab });
  }
  return out;
}
function handsFrame(dt, frame) {
  nearSomething = false;
  if (!T3 || !T3.g.visible || !renderer.xr.isPresenting || P.mySeat < 0) { dropHeld(true); return; }
  const S = T3.seats[P.mySeat], s = P.state, st = me(), o = opts();
  const now = performance.now();
  for (const h of readHands(frame)) {
    const local = T3.anchor.worldToLocal(hL.copy(h.pos));
    const st0 = hands.get(h.src) || { grab: false, prevY: local.y, t: now };
    const vy = (local.y - st0.prevY) / Math.max(dt, 1e-3);
    // near something you can pick up?
    const myCards = st && st.cards > 0 && !st.folded && P.hole;
    const near = (p, r) => Math.hypot(local.x - p.x, local.y - (p.y || 0), local.z - p.z) < r;
    const cardNear = myCards ? S.cards.find(c => near(c.userData.home, 0.08)) : null;
    let trayNear = null, td = 0.06; // the closest tray within reach
    if (o) for (const t of S.trays) { const d = Math.hypot(local.x - t.position.x, local.y - t.position.y, local.z - t.position.z); if (d < td) { td = d; trayNear = t; } }
    const pendNear = o && P.pending > 0 && near(S.pendAt, 0.08);
    if (cardNear || trayNear || pendNear) nearSomething = true;
    // knock: a quick tap on the felt at your place, down and straight back up. Reaching down to pick
    // something up doesn't count: that hand stays low, or pinches.
    const atMine = Math.hypot(local.x - S.cardAt.x, local.z - S.cardAt.z) < 0.32;
    if (atMine && !h.grab && !held.obj && !nearSomething && st0.prevY > 0.03 && local.y <= 0.03 && vy < -0.5) st0.tap = now;
    if (st0.tap && (h.grab || now - st0.tap > 400)) st0.tap = 0;
    if (st0.tap && local.y > 0.05 && now - (P.lastKnock || 0) > 700) { st0.tap = 0; P.lastKnock = now; knock(); }
    if (h.grab && !st0.grab && !held.obj) { // grab starts
      if (cardNear) { held.obj = cardNear; held.kind = 'card'; held.src = h.src; buzz(0.4, 25); }
      else if (trayNear) { held.kind = 'chip'; held.denom = trayNear.userData.denom; held.src = h.src; heldChip = heldChip || new THREE.Mesh(chipGeo, chipMat(100)); heldChip.material = chipMat(held.denom); T3.g.add(heldChip); held.obj = heldChip; buzz(0.3, 20); }
      else if (pendNear) { const d = P.pendingChips.pop(); P.pending -= d; held.kind = 'chip'; held.denom = d; held.src = h.src; heldChip = heldChip || new THREE.Mesh(chipGeo, chipMat(d)); heldChip.material = chipMat(d); T3.g.add(heldChip); held.obj = heldChip; buzz(0.3, 20); }
    }
    if (held.obj && held.src === h.src) {
      if (h.grab) { // follow the hand; a card turns to face you
        held.obj.position.copy(local);
        if (held.kind === 'card') {
          setCard(held.obj, P.hole[held.obj.userData.k], true);
          held.obj.lookAt(vT.copy(KB.xrHead())); // turn the face towards your eyes
        }
      } else { // let go
        const centre = Math.hypot(local.x / KBGarage.pokerGeo.rx, local.z / KBGarage.pokerGeo.rz) < 0.42 && local.y < 0.3;
        if (held.kind === 'card' && centre && o) { act('fold'); buzz(0.6, 40); }
        else if (held.kind === 'card' && centre) toast('You can fold when it’s your turn.', 2500);
        if (held.kind === 'chip' && near(S.pendAt, 0.12) && o) {
          const room = (st.stack || 0) - P.pending;
          if (room > 0) { const d = Math.min(held.denom, room); P.pending += d; P.pendingChips.push(d); buzz(0.2, 15); }
        }
        dropHeld();
      }
    }
    st0.grab = h.grab; st0.prevY = local.y; st0.t = now; hands.set(h.src, st0);
  }
  if (held.obj && ![...hands.keys()].includes(held.src)) dropHeld();
}
function dropHeld(silent) {
  if (!held.obj) return;
  if (held.kind === 'chip' && heldChip && heldChip.parent) heldChip.parent.remove(heldChip);
  held.obj = null; held.src = null; held.kind = null;
}
function knock() { // check, or confirm the chips in the circle as a call or a bet
  const o = opts(); if (!o) return;
  const st = me(), put = P.pending;
  buzz(0.5, 30);
  if (!put) { if (o.canCheck) act('check'); else toast(`Knocking checks, but there’s ${fmt(o.call)} to call. Put chips in the circle, or use the buttons.`, 4000); return; }
  const to = (st.bet || 0) + put;
  if (put >= st.stack) act('allin');
  else if (put <= o.call) act('call');
  else if (to < o.minTo) toast(`The smallest raise is to ${fmt(o.minTo)}: add more chips.`, 3500);
  else act('raise', to);
}

/* ---------------- Every frame ---------------- */
let uiT = 0, wasActive = false;
function frame(dt, xrFrame) {
  const active = window.KBHang && KBHang.active();
  if (!active) { if (wasActive) { P.state = null; P.mySeat = -1; P.hole = null; placeMe(); if (el) el.hidden = true; } wasActive = false; if (T3) T3.g.visible = false; return; }
  if (!wasActive) { wasActive = true; send({ t: 'pk', a: 'state' }); }
  if (P.state) hostSettle();
  update3D();
  if (renderer.xr.isPresenting && T3 && T3.bar.mesh.visible) { // hover highlight on the action bar
    let hp = null; for (const c of KB.controllers) { KB.rayFrom(c); const p = barHit(KB.raycaster); if (p) hp = p; }
    const k = hp ? T3.bar.hits.findIndex(b => hp.x >= b.x && hp.x <= b.x + b.w && hp.y >= b.y && hp.y <= b.y + b.h) : -1;
    if (k !== P.hoverK) { P.hoverK = k; P.hover = hp; T3.bar.sig = ''; }
  }
  handsFrame(dt, xrFrame);
  if ((uiT += dt) > 0.5 || P.dirty) { uiT = 0; P.dirty = false; render(); }
}

// For drive mode: bets on a race between friends, run by whoever hosts that race.
const raceMarket = () => P.bets.slice().reverse().find(m => m.kind === 'race' && (m.status === 'open' || m.status === 'closed')) || null;
const Race = {
  market: raceMarket,
  mine() { const m = raceMarket(); return m && m.opener === KBHang.pid() ? m : null; },
  open(options) { send({ t: 'bet', a: 'open', kind: 'race', options, info: {} }); },
  close() { const m = this.mine(); if (m && m.status === 'open') send({ t: 'bet', a: 'close', id: m.id }); },
  settle(winner) { const m = this.mine(); if (m) send({ t: 'bet', a: 'settle', id: m.id, winner: String(winner) }); },
  void() { const m = this.mine(); if (m) send({ t: 'bet', a: 'void', id: m.id }); },
  bet(opt, amt) { const m = raceMarket(); if (m && m.status === 'open') placeBet(m.id, String(opt), amt); },
  staked(opt) { const m = raceMarket(); return m ? m.bets.filter(b => b.pid === KBHang.pid() && (opt == null || b.opt === String(opt))).reduce((a, b) => a + b.amt, 0) : 0; }
};
// For the glowing seats in the casino: who's in seat i, and sitting down from there.
const ready = () => !!(P.state && P.gotMe);
const seatName = i => { const st = P.state && P.state.seats[i]; return st ? st.name : null; };
window.KBPoker = { onMsg, frame, onSelect, placeHere, openXR, ready, seatName, sitAt: i => sit(i), wantBots: n => { P.wantBots = n; }, seat: () => P.mySeat, open: openUI, lookChanged, build: POKER_BUILD, race: Race, bal: () => P.bal, _P: P, _hand: handLabel, _T: () => T3, _held: () => ({ kind: held.kind, denom: held.denom, near: nearSomething, hands: [...hands.values()] }) };
})();
