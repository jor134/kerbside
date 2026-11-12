// Kerbside poker: no-limit Texas hold'em and race side bets for the hangout, played for chips with no
// cash value. The hangout server (HangRoom) owns the table, so hole cards only ever go to the player
// they belong to. Pure logic, no network or storage: time and randomness are passed in so it can be tested.

export const SEATS = 6;
export const BLINDS = { sb: 50, bb: 100 };
export const START = 10000; // starting stack, and what a top-up brings you back to
export const ACT_MS = 40000; // time to act before you're checked or folded automatically
const NEXT_MS = 5000, SHOW_MS = 8000, RUNOUT_MS = 1600;
const RANKS = '23456789TJQKA', SUITS = 'shdc';
const RANK_NAME = ['', '', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings', 'aces'];
const ONE = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'jack', 'queen', 'king', 'ace'];

export function newDeck(rng) {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

/* ---------------- Hand ranking ---------------- */
// Best five of five to seven cards. Returns [category, ...tie-breakers]: compare arrays left to right.
// Categories: 8 straight flush, 7 four of a kind, 6 full house, 5 flush, 4 straight, 3 three of a kind,
// 2 two pair, 1 pair, 0 high card.
function straightHigh(vals) {
  const has = new Set(vals); if (has.has(14)) has.add(1);
  for (let h = 14; h >= 5; h--) { let ok = true; for (let k = 0; k < 5; k++) if (!has.has(h - k)) { ok = false; break; } if (ok) return h; }
  return 0;
}
export function evalHand(cards) {
  const vals = cards.map(c => RANKS.indexOf(c[0]) + 2), bySuit = {};
  cards.forEach((c, i) => (bySuit[c[1]] = bySuit[c[1]] || []).push(vals[i]));
  const flush = Object.values(bySuit).find(v => v.length >= 5);
  if (flush) { const sf = straightHigh(flush); if (sf) return [8, sf]; }
  const count = {}; for (const v of vals) count[v] = (count[v] || 0) + 1;
  const groups = Object.entries(count).map(([v, n]) => [n, +v]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const desc = [...vals].sort((a, b) => b - a), others = ex => desc.filter(v => !ex.includes(v));
  if (groups[0][0] === 4) return [7, groups[0][1], others([groups[0][1]])[0]];
  if (groups[0][0] === 3 && groups[1] && groups[1][0] >= 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...flush.sort((a, b) => b - a).slice(0, 5)];
  const st = straightHigh(vals); if (st) return [4, st];
  if (groups[0][0] === 3) return [3, groups[0][1], ...others([groups[0][1]]).slice(0, 2)];
  if (groups[0][0] === 2 && groups[1] && groups[1][0] === 2) return [2, groups[0][1], groups[1][1], others([groups[0][1], groups[1][1]])[0]];
  if (groups[0][0] === 2) return [1, groups[0][1], ...others([groups[0][1]]).slice(0, 3)];
  return [0, ...desc.slice(0, 5)];
}
export function cmpHand(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }
export function handName(r) {
  switch (r[0]) {
    case 8: return r[1] === 14 ? 'Royal flush' : `Straight flush, ${ONE[r[1]]} high`;
    case 7: return `Four ${RANK_NAME[r[1]]}`;
    case 6: return `Full house, ${RANK_NAME[r[1]]} over ${RANK_NAME[r[2]]}`;
    case 5: return `Flush, ${ONE[r[1]]} high`;
    case 4: return `Straight, ${ONE[r[1]]} high`;
    case 3: return `Three ${RANK_NAME[r[1]]}`;
    case 2: return `Two pair, ${RANK_NAME[r[1]]} and ${RANK_NAME[r[2]]}`;
    case 1: return `Pair of ${RANK_NAME[r[1]]}`;
    default: return `${ONE[r[1]][0].toUpperCase() + ONE[r[1]].slice(1)} high`;
  }
}

/* ---------------- The table ---------------- */
export class PokerTable {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random; this.now = opts.now || Date.now;
    this.seats = Array(SEATS).fill(null);
    this.button = -1; this.phase = 'idle'; this.board = []; this.deck = [];
    this.hand = 0; this.toAct = -1; this.curBet = 0; this.minRaise = BLINDS.bb; this.deadline = 0;
    this.nextAt = 0; this.runAt = 0; this.result = null; this.last = null;
    this.saves = []; // seats whose stacks changed and should be saved: drained by the server
    this.blindsBB = BLINDS.bb;
  }
  seatOf(pid) { return this.seats.findIndex(s => s && s.pid === pid); }
  betting() { return this.phase === 'preflop' || this.phase === 'flop' || this.phase === 'turn' || this.phase === 'river'; }
  live() { return this.seats.map((s, i) => [s, i]).filter(([s]) => s && s.inHand && !s.folded); }
  next(i, pred) { for (let k = 1; k <= SEATS; k++) { const j = (i + k + SEATS) % SEATS, s = this.seats[j]; if (s && pred(s, j)) return j; } return -1; }

  sit(i, p) {
    if (i < 0 || i >= SEATS || this.seats[i] || this.seatOf(p.pid) >= 0) return 'That seat is taken.';
    this.seats[i] = { pid: p.pid, peer: p.peer, name: p.name, stack: Math.max(0, Math.floor(p.bal)), hole: null, inHand: false, folded: false, allIn: false, bet: 0, total: 0, acted: false, sitOut: false, shown: null, leaving: false };
    if (this.phase === 'idle') this.nextAt = this.now() + 2500;
    return null;
  }
  // Leaving mid-hand folds you; your seat (and the chips you've put in) stay until the hand ends.
  stand(i) {
    const s = this.seats[i]; if (!s) return null;
    if (this.betting() && s.inHand && !s.folded) {
      if (this.toAct === i) this.act(i, 'fold'); else { s.folded = true; this.after(); }
    }
    if (this.betting() || (this.phase === 'done' && s.inHand && this.runAt)) { s.leaving = true; return s.stack; }
    this.seats[i] = null; return s.stack;
  }
  setSitOut(i, on) { const s = this.seats[i]; if (s) { s.sitOut = !!on; if (!on && this.phase === 'idle') this.nextAt = this.now() + 1500; } }

  start() {
    for (let i = 0; i < SEATS; i++) if (this.seats[i] && this.seats[i].leaving) this.seats[i] = null;
    const ok = s => s.stack > 0 && !s.sitOut;
    const players = this.seats.filter(s => s && ok(s));
    this.result = null; this.last = null; this.board = [];
    for (const s of this.seats) if (s) Object.assign(s, { hole: null, inHand: false, folded: false, allIn: false, bet: 0, total: 0, acted: false, shown: null });
    if (players.length < 2) { this.phase = 'idle'; this.toAct = -1; return false; }
    this.hand++;
    this.button = this.next(this.button < 0 ? -1 : this.button, ok);
    this.deck = newDeck(this.rng);
    for (const s of this.seats) if (s && ok(s)) { s.inHand = true; s.hole = [this.deck.pop(), this.deck.pop()]; }
    const heads = players.length === 2;
    const sb = heads ? this.button : this.next(this.button, s => s.inHand);
    const bb = this.next(sb, s => s.inHand);
    this.post(sb, BLINDS.sb); this.post(bb, BLINDS.bb);
    this.curBet = BLINDS.bb; this.minRaise = BLINDS.bb; this.phase = 'preflop';
    this.sb = sb; this.bb = bb;
    this.toAct = this.next(bb, s => s.inHand && !s.folded && !s.allIn);
    if (this.toAct < 0 || this.roundDone()) { this.toAct = -1; this.endRound(); } else this.deadline = this.now() + ACT_MS;
    return true;
  }
  post(i, amt) { const s = this.seats[i], x = Math.min(amt, s.stack); s.stack -= x; s.bet += x; s.total += x; if (!s.stack) s.allIn = true; return x; }
  toCall(i) { const s = this.seats[i]; return s ? Math.max(0, this.curBet - s.bet) : 0; }
  // What the player in seat i may do right now (for the buttons).
  options(i) {
    const s = this.seats[i]; if (!s || i !== this.toAct || !this.betting()) return null;
    const call = Math.min(this.toCall(i), s.stack), max = s.bet + s.stack;
    const minTo = Math.min(max, this.curBet + this.minRaise);
    return { call, canCheck: call === 0, minTo, maxTo: max, canRaise: max > this.curBet };
  }
  act(i, a, amount) {
    if (!this.betting() || i !== this.toAct) return 'Not your turn.';
    const s = this.seats[i], call = this.toCall(i);
    if (a === 'allin') { amount = s.bet + s.stack; a = amount > this.curBet ? 'raise' : 'call'; }
    if (a === 'bet') a = 'raise';
    if (a === 'fold') { s.folded = true; }
    else if (a === 'check') { if (call > 0) return 'You can’t check: there’s a bet to call.'; }
    else if (a === 'call') { this.post(i, call); }
    else if (a === 'raise') {
      const max = s.bet + s.stack; amount = Math.floor(+amount || 0);
      if (amount > max) amount = max;
      if (amount <= this.curBet) { if (call > 0) { this.post(i, call); a = 'call'; } else a = 'check'; }
      else {
        if (amount < this.curBet + this.minRaise && amount < max) return `The smallest raise is to ${this.curBet + this.minRaise}.`;
        const size = amount - this.curBet;
        if (size >= this.minRaise) { this.minRaise = size; for (const o of this.seats) if (o && o !== s) o.acted = false; }
        else for (const o of this.seats) if (o && o !== s && o.bet < amount) o.acted = false; // short all-in: others still have to call it
        this.post(i, amount - s.bet); this.curBet = amount;
      }
    } else return 'Unknown action.';
    s.acted = true;
    this.last = { seat: i, a, amount: a === 'raise' ? this.curBet : a === 'call' ? call : 0 };
    this.after(i);
    return null;
  }
  roundDone() {
    const canAct = this.live().filter(([s]) => !s.allIn);
    if (!canAct.length) return true;
    if (canAct.length === 1 && canAct[0][0].bet >= this.curBet && this.live().length > 1) return canAct[0][0].acted || canAct[0][0].bet >= this.curBet;
    return canAct.every(([s]) => s.acted && s.bet === this.curBet);
  }
  after(from) {
    if (this.live().length === 1) return this.finish();
    if (!this.roundDone()) {
      this.toAct = this.next(from != null ? from : this.toAct, s => s.inHand && !s.folded && !s.allIn && !(s.acted && s.bet === this.curBet));
      this.deadline = this.now() + ACT_MS;
      return;
    }
    this.endRound();
  }
  endRound() {
    for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; }
    this.curBet = 0; this.minRaise = BLINDS.bb; this.toAct = -1;
    if (this.phase === 'river') return this.finish();
    const canAct = this.live().filter(([s]) => !s.allIn);
    if (canAct.length <= 1) { this.runAt = this.now() + RUNOUT_MS; this.showLive(); return; } // all in: deal the rest out with everyone's cards up
    this.deal();
  }
  deal() {
    this.deck.pop(); // burn
    if (this.phase === 'preflop') { this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); this.phase = 'flop'; }
    else if (this.phase === 'flop') { this.board.push(this.deck.pop()); this.phase = 'turn'; }
    else if (this.phase === 'turn') { this.board.push(this.deck.pop()); this.phase = 'river'; }
    if (this.runAt) return;
    this.toAct = this.next(this.button, s => s.inHand && !s.folded && !s.allIn);
    this.deadline = this.now() + ACT_MS;
    if (this.toAct < 0 || this.roundDone()) this.endRound();
  }
  showLive() { for (const [s] of this.live()) s.shown = s.hole; }
  pots() { // main pot and side pots from what everyone put in, folded players included
    const contrib = this.seats.map((s, i) => [s, i]).filter(([s]) => s && s.total > 0);
    const levels = [...new Set(contrib.map(([s]) => s.total))].sort((a, b) => a - b);
    const pots = []; let prev = 0;
    for (const lvl of levels) {
      let amt = 0; for (const [s] of contrib) amt += Math.max(0, Math.min(s.total, lvl) - prev);
      const elig = contrib.filter(([s]) => !s.folded && s.inHand && s.total >= lvl).map(([, i]) => i);
      prev = lvl;
      const top = pots[pots.length - 1];
      if (!elig.length && top) top.amount += amt;
      else if (top && top.elig.join() === elig.join()) top.amount += amt;
      else pots.push({ amount: amt, elig });
    }
    return pots.filter(p => p.amount > 0);
  }
  finish() {
    const live = this.live(), wins = new Map(), names = {};
    if (live.length === 1) {
      const [s, i] = live[0], total = this.seats.reduce((a, o) => a + (o ? o.total : 0), 0);
      wins.set(i, total);
    } else {
      this.showLive();
      while (this.board.length < 5) { this.deck.pop(); this.board.push(this.deck.pop()); }
      const rank = new Map(live.map(([s, i]) => { const r = evalHand([...s.hole, ...this.board]); names[i] = handName(r); return [i, r]; }));
      for (const pot of this.pots()) {
        const contenders = pot.elig.filter(i => rank.has(i)); if (!contenders.length) continue;
        let best = [contenders[0]];
        for (const i of contenders.slice(1)) { const d = cmpHand(rank.get(i), rank.get(best[0])); if (d > 0) best = [i]; else if (d === 0) best.push(i); }
        const share = Math.floor(pot.amount / best.length); let odd = pot.amount - share * best.length;
        // odd chips go to the first winners clockwise from the button
        best.sort((a, b) => ((a - this.button + SEATS) % SEATS) - ((b - this.button + SEATS) % SEATS));
        for (const i of best) { wins.set(i, (wins.get(i) || 0) + share + (odd > 0 ? 1 : 0)); odd--; }
      }
    }
    for (const [i, amt] of wins) this.seats[i].stack += amt;
    this.result = { winners: [...wins].map(([seat, amount]) => ({ seat, name: this.seats[seat].name, amount, hand: names[seat] || null })), showdown: live.length > 1 };
    this.phase = 'done'; this.toAct = -1; this.runAt = 0;
    this.nextAt = this.now() + (live.length > 1 ? SHOW_MS : NEXT_MS);
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.saves.push(i);
  }
  // Call about once a second: runs the clock, deals out all-in hands and starts the next hand.
  tick() {
    const now = this.now();
    if (this.runAt && now >= this.runAt) {
      if (this.phase === 'river') { this.runAt = 0; this.finish(); }
      else { this.deal(); this.runAt = this.phase === 'river' ? now + RUNOUT_MS : now + RUNOUT_MS; }
      return true;
    }
    if (this.betting() && this.toAct >= 0 && now > this.deadline) {
      const i = this.toAct; this.act(i, this.toCall(i) === 0 ? 'check' : 'fold');
      const s = this.seats[i]; if (s && this.last && this.last.a === 'fold') s.sitOut = true; // timed out: sit them out until they're back
      return true;
    }
    if ((this.phase === 'done' || this.phase === 'idle') && this.nextAt && now >= this.nextAt) { this.nextAt = 0; this.start(); return true; }
    return false;
  }
  active() { return this.seats.some(Boolean); }
  publicState() {
    const pot = this.seats.reduce((a, s) => a + (s ? s.total - s.bet : 0), 0);
    return {
      seats: this.seats.map(s => s && { pid: s.pid, name: s.name, stack: s.stack, bet: s.bet, inHand: s.inHand, folded: s.folded, allIn: s.allIn, sitOut: s.sitOut, cards: s.inHand && !s.folded ? 2 : 0, shown: s.shown }),
      phase: this.phase, board: this.board, pot, curBet: this.curBet, minRaise: this.minRaise, toAct: this.toAct,
      deadline: this.deadline, button: this.button, hand: this.hand, result: this.result, last: this.last, blinds: BLINDS,
      options: this.toAct >= 0 ? this.options(this.toAct) : null
    };
  }
}

/* ---------------- Practice bots ---------------- */
// Computer players for practice. They play a simple, readable game: strong hands bet, medium hands call
// when the price is right, weak hands fold, with a little bluffing so they aren't trivial to read.
export const BOT_NAMES = ['Bot Ava', 'Bot Max', 'Bot Lin', 'Bot Raj', 'Bot Zoe', 'Bot Teo'];
export const isBot = pid => typeof pid === 'string' && pid.startsWith('bot-');
function preflopStrength(h) { // 0..1 from the two hole cards
  const v = h.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a), suited = h[0][1] === h[1][1], gap = v[0] - v[1];
  if (gap === 0) return Math.min(1, 0.55 + v[0] / 30);                 // pairs: 22 about 0.62, AA 1
  let s = (v[0] + v[1]) / 34;                                         // AK about 0.79, 72 about 0.26
  if (suited) s += 0.06; if (gap === 1) s += 0.04; else if (gap > 4) s -= 0.06;
  return Math.max(0, Math.min(0.95, s));
}
const MADE = [0.18, 0.5, 0.7, 0.78, 0.84, 0.88, 0.94, 0.98, 1];      // high card .. straight flush
export function botAction(T, i, rng = Math.random) {
  const s = T.seats[i], o = T.options(i); if (!s || !o) return null;
  const pot = T.seats.reduce((a, x) => a + (x ? x.total : 0), 0);
  let str = T.board.length ? MADE[evalHand([...s.hole, ...T.board])[0]] : preflopStrength(s.hole);
  if (T.board.length) { // a pair made only by the board isn't worth much
    const boardOnly = evalHand(T.board.length >= 5 ? T.board : [...T.board]), mine = evalHand([...s.hole, ...T.board]);
    if (T.board.length >= 2 && boardOnly[0] === mine[0] && mine[0] <= 2) str -= 0.25;
  }
  str += (rng() - 0.5) * 0.12; // a little unpredictability
  const call = o.call, odds = call / Math.max(1, pot + call), r = rng();
  const raiseTo = f => Math.min(o.maxTo, Math.max(o.minTo, Math.round((T.curBet + pot * f) / 50) * 50));
  if (o.canRaise && (str > 0.8 || (str > 0.62 && r < 0.25) || r < 0.04)) return { a: 'raise', amount: raiseTo(str > 0.9 ? 0.9 : 0.6) };
  if (call === 0) return o.canRaise && str > 0.55 && r < 0.4 ? { a: 'raise', amount: raiseTo(0.5) } : { a: 'check' };
  if (str >= odds + 0.15 || (call <= T.blindsBB && str > 0.3) || r < 0.06) return { a: 'call' };
  return { a: 'fold' };
}

/* ---------------- Race side bets ---------------- */
// Pool betting: everything staked on a market is shared by the people who picked the winner, in
// proportion to their stakes. No winner, or the market can't be settled: everyone gets their stake back.
// The host's app watches the race (live or replay, at its own delay) and reports the result.
export const MARKETS = {
  pit: { label: 'Next driver to pit', windowMs: 60000, expireMs: 20 * 60000 },
  leader: { label: 'Leader in 3 laps', windowMs: 60000, expireMs: 30 * 60000 },
  sc: { label: 'Safety car in the next 10 laps?', windowMs: 60000, expireMs: 45 * 60000 },
  race: { label: 'Friends’ race winner', windowMs: 3 * 60000, expireMs: 40 * 60000 } // opened and closed by whoever hosts the drive race
};
export class SideBets {
  constructor(opts = {}) { this.now = opts.now || Date.now; this.list = []; this.seq = 1; }
  open(kind, options, info) {
    const M = MARKETS[kind]; if (!M) return 'Unknown market.';
    if (this.list.some(m => m.kind === kind && (m.status === 'open' || m.status === 'closed'))) return 'That market is already running.';
    const opts = (Array.isArray(options) ? options : []).slice(0, 30).map(o => ({ k: String(o.k).slice(0, 12), label: String(o.label || o.k).slice(0, 24) }));
    if (opts.length < 2) return 'Not enough choices to bet on.';
    const t = this.now();
    this.list.push({ id: this.seq++, kind, label: M.label, options: opts, bets: [], status: 'open', opened: t, closes: t + M.windowMs, expires: t + M.expireMs, info: info || {}, winner: null, payouts: null });
    this.list = this.list.slice(-8);
    return null;
  }
  find(id) { return this.list.find(m => m.id === +id); }
  close(id) { const m = this.find(id); if (m && m.status === 'open') { m.status = 'closed'; m.closes = Math.min(m.closes, this.now()); } }
  place(id, pid, name, opt, amt) {
    const m = this.find(id); if (!m || m.status !== 'open' || this.now() >= m.closes) return 'Betting on that has closed.';
    if (!m.options.some(o => o.k === opt)) return 'Pick one of the choices.';
    amt = Math.floor(+amt || 0); if (amt < 1) return 'Bet at least 1 chip.';
    m.bets.push({ pid, name, opt, amt });
    return null;
  }
  // returns [{pid, amt}] to credit
  settle(id, winner) {
    const m = this.find(id); if (!m || (m.status !== 'open' && m.status !== 'closed')) return null;
    const pool = m.bets.reduce((a, b) => a + b.amt, 0), win = m.bets.filter(b => b.opt === String(winner)), stake = win.reduce((a, b) => a + b.amt, 0);
    m.status = 'settled'; m.winner = String(winner);
    const credit = new Map();
    if (!stake) { for (const b of m.bets) credit.set(b.pid, (credit.get(b.pid) || 0) + b.amt); m.refunded = true; }
    else { let left = pool; win.forEach((b, k) => { const x = k === win.length - 1 ? left : Math.floor(pool * b.amt / stake); left -= x; credit.set(b.pid, (credit.get(b.pid) || 0) + x); }); }
    m.payouts = [...credit].map(([pid, amt]) => ({ pid, amt, name: (m.bets.find(b => b.pid === pid) || {}).name }));
    return m.payouts;
  }
  void(id) {
    const m = this.find(id); if (!m || (m.status !== 'open' && m.status !== 'closed')) return null;
    const credit = new Map(); for (const b of m.bets) credit.set(b.pid, (credit.get(b.pid) || 0) + b.amt);
    m.status = 'void'; m.payouts = [...credit].map(([pid, amt]) => ({ pid, amt }));
    return m.payouts;
  }
  // returns [[id, payouts]] for markets that expired unsettled
  tick() {
    const now = this.now(), out = [];
    for (const m of this.list) {
      if (m.status === 'open' && now >= m.closes) m.status = 'closed';
      if ((m.status === 'open' || m.status === 'closed') && now >= m.expires) out.push([m.id, this.void(m.id)]);
    }
    return out;
  }
  publicState() {
    return this.list.map(m => ({ id: m.id, kind: m.kind, label: m.label, options: m.options, status: m.status, closes: m.closes, info: m.info, winner: m.winner, opener: m.opener || null,
      pool: m.bets.reduce((a, b) => a + b.amt, 0), byOpt: m.options.map(o => m.bets.filter(b => b.opt === o.k).reduce((a, b) => a + b.amt, 0)),
      bets: m.bets.map(b => ({ name: b.name, pid: b.pid, opt: b.opt, amt: b.amt })), payouts: m.payouts, refunded: !!m.refunded }));
  }
}
