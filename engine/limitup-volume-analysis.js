#!/usr/bin/env node
/**
 * 번트 — 상한가 종목 거래대금별 체결 가능성 분석
 * ──────────────────────────────────────────────
 * 핵심 질문: "상한가라도 거래량이 크면 살 수 있지 않나?"
 *
 * 거래대금이 크다 = 장중 상한가 붙었다 풀렸다 반복 = 매도 물량 풍부
 * 거래대금이 작다 = 아침에 붙고 안 풀림 = 매도 물량 없음
 *
 * 분석:
 *   1. 상한가 종목의 거래대금 분포
 *   2. 거래대금 구간별 EV/승률
 *   3. "체결 가능 상한가"만으로 복리 시뮬레이션
 *   4. 번트 전체(상한가+비상한가)에서 거래대금 필터 적용 시 성과
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const COMMISSION = 0.005;
const TAX = 0.0018;
const ROUND_TRIP = COMMISSION * 2 + TAX;
const SEED = 500_000;
const MAX_PICKS = 10;
const DATE_FROM = '2025-03-20';
const DATE_TO = '2026-03-20';

function loadAllOHLCV() {
  const allFiles = fs.readdirSync(OHLCV_DIR).filter(f => f.endsWith('.json'));
  const all = {};
  for (const f of allFiles) {
    const code = f.replace('.json', '');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, f), 'utf8'));
      if (Array.isArray(data) && data.length > 10) {
        const dateMap = {};
        data.forEach((d, i) => { dateMap[d.date] = i; });
        all[code] = { data, dateMap };
      }
    } catch(e) {}
  }
  return all;
}

function loadNameMap() {
  const map = {};
  try {
    const rc = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '모의투자', 'data', 'ranking-cache.json'), 'utf8'
    ));
    if (rc.results) rc.results.forEach(r => { map[r.code] = r.name; });
  } catch(e) {}
  return map;
}

function getTradingDates(allOHLCV) {
  const dateSet = new Set();
  for (const [code, { data }] of Object.entries(allOHLCV)) {
    for (const d of data) {
      if (d.date >= DATE_FROM && d.date <= DATE_TO) dateSet.add(d.date);
    }
    if (dateSet.size > 200) break;
  }
  return [...dateSet].sort();
}

// ─── 번트 필터 + 상세 정보 ───
function collectAllSignals(allOHLCV, tradingDates, nameMap) {
  const signals = [];  // 건별 기록
  const dailyPicks = {}; // 날짜별 picks

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    const sellDate = tradingDates[di + 1];
    const dayPicks = [];

    for (const [code, { data, dateMap }] of Object.entries(allOHLCV)) {
      const idx = dateMap[buyDate];
      if (idx === undefined || idx < 1) continue;

      const today = data[idx];
      const prev = data[idx - 1];
      if (!today || !prev) continue;

      const { open, high, low, close, volume } = today;
      const prevClose = prev.close;
      if (prevClose <= 0 || high <= 0 || close <= 0) continue;

      const changeRate = (close - prevClose) / prevClose;
      const closeHighRatio = close / high;
      const gapUp = (open - prevClose) / prevClose;

      // 번트 필터
      if (changeRate < 0.20 || changeRate > 0.30) continue;
      if (closeHighRatio < 1.0) continue;
      if (gapUp < 0) continue;

      const tradingValue = close * volume;
      const isLimitUp = changeRate >= 0.29;

      // 익일 시가
      const sellIdx = dateMap[sellDate];
      if (sellIdx === undefined) continue;
      const sellOpen = data[sellIdx].open;
      const grossReturn = (sellOpen - close) / close;
      const netReturn = grossReturn - ROUND_TRIP;

      const sig = {
        date: buyDate, code, name: nameMap[code] || code,
        changeRate, close, volume, tradingValue, isLimitUp,
        sellOpen, grossReturn, netReturn,
      };

      signals.push(sig);
      dayPicks.push(sig);
    }

    // 등락률 내림차순 정렬
    dayPicks.sort((a, b) => b.changeRate - a.changeRate);
    dailyPicks[buyDate] = dayPicks;
  }

  return { signals, dailyPicks };
}

// ─── 복리 시뮬레이션 ───
function simulate(dailyPicks, tradingDates, filterFn) {
  let capital = SEED;
  let peak = SEED, maxDD = 0;
  let trades = 0, wins = 0;
  let signalDays = 0, winDays = 0;

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    let picks = dailyPicks[buyDate] || [];
    if (filterFn) picks = picks.filter(filterFn);
    picks = picks.slice(0, MAX_PICKS);
    if (picks.length === 0) continue;

    signalDays++;
    const perStock = capital / picks.length;
    let dayPnl = 0;

    for (const p of picks) {
      dayPnl += perStock * p.netReturn;
      trades++;
      if (p.netReturn > 0) wins++;
    }

    capital += dayPnl;
    if (dayPnl > 0) winDays++;
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return { capital, trades, wins, signalDays, winDays, maxDD,
    winRate: trades > 0 ? wins / trades : 0,
    totalReturn: (capital - SEED) / SEED,
  };
}

// ─── 메인 ───
function main() {
  console.log('━'.repeat(72));
  console.log('  상한가 종목 거래대금별 체결 가능성 분석');
  console.log('  "상한가라도 거래량이 크면 살 수 있지 않나?"');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO} | 수수료: ${(ROUND_TRIP * 100).toFixed(2)}%`);
  console.log('━'.repeat(72));

  const allOHLCV = loadAllOHLCV();
  const nameMap = loadNameMap();
  const tradingDates = getTradingDates(allOHLCV);
  console.log(`\n  ${Object.keys(allOHLCV).length}종목 | ${tradingDates.length}거래일\n`);

  const { signals, dailyPicks } = collectAllSignals(allOHLCV, tradingDates, nameMap);
  const limitUps = signals.filter(s => s.isLimitUp);
  const nonLimits = signals.filter(s => !s.isLimitUp);

  console.log(`  번트 필터 통과: ${signals.length}건 (상한가 ${limitUps.length}건 + 비상한가 ${nonLimits.length}건)\n`);

  // ═══ 1. 상한가 종목의 거래대금 분포 ═══
  console.log('═'.repeat(72));
  console.log('  [1] 상한가 종목의 거래대금 분포');
  console.log('═'.repeat(72));

  const tvValues = limitUps.map(s => s.tradingValue).sort((a, b) => a - b);
  const p10 = tvValues[Math.floor(tvValues.length * 0.1)];
  const p25 = tvValues[Math.floor(tvValues.length * 0.25)];
  const p50 = tvValues[Math.floor(tvValues.length * 0.5)];
  const p75 = tvValues[Math.floor(tvValues.length * 0.75)];
  const p90 = tvValues[Math.floor(tvValues.length * 0.9)];

  console.log(`\n  상한가 ${limitUps.length}건 거래대금 분포:`);
  console.log(`    P10: ${fmtWon(p10)}`);
  console.log(`    P25: ${fmtWon(p25)}`);
  console.log(`    P50(중앙): ${fmtWon(p50)}`);
  console.log(`    P75: ${fmtWon(p75)}`);
  console.log(`    P90: ${fmtWon(p90)}`);

  // ═══ 2. 거래대금 구간별 EV/승률 (상한가만) ═══
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  [2] 상한가 종목 — 거래대금 구간별 성과');
  console.log('═'.repeat(72));

  const volumeBuckets = [
    { label: '1억 미만',     min: 0,     max: 1e8 },
    { label: '1~5억',       min: 1e8,   max: 5e8 },
    { label: '5~10억',      min: 5e8,   max: 10e8 },
    { label: '10~50억',     min: 10e8,  max: 50e8 },
    { label: '50~100억',    min: 50e8,  max: 100e8 },
    { label: '100억 이상',   min: 100e8, max: Infinity },
  ];

  console.log(`\n  ${'거래대금'.padEnd(14)} ${'건수'.padStart(6)} ${'승률'.padStart(7)} ${'EV(순)'.padStart(9)} ${'EV(총)'.padStart(9)} ${'중앙값'.padStart(9)} ${'체결판정'.padStart(8)}`);
  console.log(`  ${'─'.repeat(14)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(8)}`);

  for (const b of volumeBuckets) {
    const bucket = limitUps.filter(s => s.tradingValue >= b.min && s.tradingValue < b.max);
    if (bucket.length === 0) {
      console.log(`  ${pad(b.label, 14)} ${String(0).padStart(6)}       -         -         -         -        -`);
      continue;
    }
    const w = bucket.filter(s => s.netReturn > 0).length;
    const wr = w / bucket.length;
    const avgNet = bucket.reduce((s, x) => s + x.netReturn, 0) / bucket.length;
    const avgGross = bucket.reduce((s, x) => s + x.grossReturn, 0) / bucket.length;
    const rets = bucket.map(s => s.netReturn).sort((a, b) => a - b);
    const med = rets[Math.floor(rets.length / 2)];

    // 체결 판정: 거래대금 높을수록 체결 가능
    let verdict = '';
    if (b.min >= 50e8) verdict = 'O 확실';
    else if (b.min >= 10e8) verdict = 'O 높음';
    else if (b.min >= 5e8) verdict = '? 보통';
    else if (b.min >= 1e8) verdict = '? 낮음';
    else verdict = 'X 어려움';

    console.log(`  ${pad(b.label, 14)} ${String(bucket.length).padStart(6)} ${(wr * 100).toFixed(1).padStart(6)}% ${fmtPct(avgNet).padStart(9)} ${fmtPct(avgGross).padStart(9)} ${fmtPct(med).padStart(9)} ${verdict.padStart(8)}`);
  }

  // ═══ 3. 체결 가능 상한가 기준별 복리 시뮬레이션 ═══
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  [3] 거래대금 기준별 복리 시뮬레이션 (50만원 시드)');
  console.log('═'.repeat(72));

  const tvThresholds = [
    { label: '전체 (기준 없음)',  minTV: 0 },
    { label: '거래대금 1억+',    minTV: 1e8 },
    { label: '거래대금 5억+',    minTV: 5e8 },
    { label: '거래대금 10억+',   minTV: 10e8 },
    { label: '거래대금 50억+',   minTV: 50e8 },
    { label: '거래대금 100억+',  minTV: 100e8 },
  ];

  console.log(`\n  [상한가만]`);
  console.log(`  ${'기준'.padEnd(22)} ${'거래'.padStart(5)} ${'승률'.padStart(7)} ${'시그널일'.padStart(6)} ${'최종자본'.padStart(14)} ${'수익률'.padStart(10)} ${'MDD'.padStart(7)}`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(7)}`);

  for (const t of tvThresholds) {
    const sim = simulate(dailyPicks, tradingDates,
      s => s.isLimitUp && s.tradingValue >= t.minTV);
    console.log(`  ${pad(t.label, 22)} ${String(sim.trades).padStart(5)} ${(sim.winRate * 100).toFixed(1).padStart(6)}% ${String(sim.signalDays).padStart(6)} ${Math.round(sim.capital).toLocaleString().padStart(14)}원 ${fmtPct(sim.totalReturn).padStart(10)} ${fmtPct(sim.maxDD).padStart(7)}`);
  }

  console.log(`\n  [전체 (상한가+비상한가)]`);
  console.log(`  ${'기준'.padEnd(22)} ${'거래'.padStart(5)} ${'승률'.padStart(7)} ${'시그널일'.padStart(6)} ${'최종자본'.padStart(14)} ${'수익률'.padStart(10)} ${'MDD'.padStart(7)}`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(14)} ${'─'.repeat(10)} ${'─'.repeat(7)}`);

  for (const t of tvThresholds) {
    const sim = simulate(dailyPicks, tradingDates,
      s => s.tradingValue >= t.minTV);
    console.log(`  ${pad(t.label, 22)} ${String(sim.trades).padStart(5)} ${(sim.winRate * 100).toFixed(1).padStart(6)}% ${String(sim.signalDays).padStart(6)} ${Math.round(sim.capital).toLocaleString().padStart(14)}원 ${fmtPct(sim.totalReturn).padStart(10)} ${fmtPct(sim.maxDD).padStart(7)}`);
  }

  // ═══ 4. 실전 시나리오: 부분 체결 가정 ═══
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  [4] 실전 시나리오: 상한가 부분 체결 가정');
  console.log('═'.repeat(72));
  console.log(`\n  상한가에서 내가 체결될 확률을 X%로 가정.`);
  console.log(`  체결 안 된 종목은 매수 못한 것으로 처리 (해당 자금 유휴).\n`);

  // 확률적 시뮬레이션 (100회 몬테카를로)
  const fillRates = [1.0, 0.7, 0.5, 0.3, 0.1];
  const MC_RUNS = 200;

  console.log(`  ${'체결확률'.padEnd(10)} ${'평균수익률'.padStart(12)} ${'중앙수익률'.padStart(12)} ${'최악'.padStart(12)} ${'최선'.padStart(12)} ${'MDD평균'.padStart(8)}`);
  console.log(`  ${'─'.repeat(10)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(8)}`);

  for (const fillRate of fillRates) {
    const mcResults = [];

    for (let run = 0; run < MC_RUNS; run++) {
      let capital = SEED;
      let peak = SEED, maxDD = 0;

      for (let di = 0; di < tradingDates.length - 1; di++) {
        const buyDate = tradingDates[di];
        let picks = (dailyPicks[buyDate] || []).slice(0, MAX_PICKS);
        if (picks.length === 0) continue;

        // 상한가 종목은 fillRate 확률로 체결
        const executed = [];
        for (const p of picks) {
          if (!p.isLimitUp) {
            executed.push(p); // 비상한가는 100% 체결
          } else if (Math.random() < fillRate) {
            executed.push(p); // 상한가는 확률적 체결
          }
        }

        if (executed.length === 0) continue;

        // 전체 자금을 원래 picks 수로 나눔 (미체결분은 유휴)
        const perStock = capital / picks.length;
        let dayPnl = 0;
        for (const p of executed) {
          dayPnl += perStock * p.netReturn;
        }

        capital += dayPnl;
        if (capital > peak) peak = capital;
        const dd = (peak - capital) / peak;
        if (dd > maxDD) maxDD = dd;
      }

      mcResults.push({ totalReturn: (capital - SEED) / SEED, maxDD });
    }

    mcResults.sort((a, b) => a.totalReturn - b.totalReturn);
    const avg = mcResults.reduce((s, r) => s + r.totalReturn, 0) / MC_RUNS;
    const med = mcResults[Math.floor(MC_RUNS / 2)].totalReturn;
    const worst = mcResults[0].totalReturn;
    const best = mcResults[MC_RUNS - 1].totalReturn;
    const avgDD = mcResults.reduce((s, r) => s + r.maxDD, 0) / MC_RUNS;

    const label = fillRate === 1.0 ? '100% (이론)' : `${(fillRate * 100).toFixed(0)}%`;
    console.log(`  ${pad(label, 10)} ${fmtPct(avg).padStart(12)} ${fmtPct(med).padStart(12)} ${fmtPct(worst).padStart(12)} ${fmtPct(best).padStart(12)} ${fmtPct(avgDD).padStart(8)}`);
  }

  // ═══ 결론 ═══
  console.log(`\n\n${'━'.repeat(72)}`);
  console.log('  결론');
  console.log('━'.repeat(72));

  // 10억+ 상한가 EV 계산
  const bigLimitUps = limitUps.filter(s => s.tradingValue >= 10e8);
  const bigLimitUpEV = bigLimitUps.length > 0
    ? bigLimitUps.reduce((s, x) => s + x.netReturn, 0) / bigLimitUps.length : 0;
  const bigLimitUpWR = bigLimitUps.length > 0
    ? bigLimitUps.filter(s => s.netReturn > 0).length / bigLimitUps.length : 0;

  const sim10B = simulate(dailyPicks, tradingDates,
    s => s.tradingValue >= 10e8);

  console.log(`\n  1. 상한가 중 거래대금 10억+ 종목:`);
  console.log(`     - ${bigLimitUps.length}건 (상한가의 ${(bigLimitUps.length / limitUps.length * 100).toFixed(1)}%)`);
  console.log(`     - 승률 ${(bigLimitUpWR * 100).toFixed(1)}% | EV ${fmtPct(bigLimitUpEV)}`);
  console.log(`     - 거래대금 큼 = 장중 호가 움직임 많음 = 동시호가 체결 가능성 높음`);

  console.log(`\n  2. 거래대금 10억+ 필터 적용 시 (상한가+비상한가):`);
  console.log(`     - ${sim10B.trades}건, ${sim10B.signalDays}일 시그널`);
  console.log(`     - 승률 ${(sim10B.winRate * 100).toFixed(1)}% | 수익률 ${fmtPct(sim10B.totalReturn)} | MDD ${fmtPct(sim10B.maxDD)}`);

  console.log(`\n  3. 체결 확률 50%만 돼도:`);
  // 50% 체결 시뮬레이션 결과 (위에서 계산된 것)
  console.log(`     - 상한가에서 2번에 1번만 체결되어도 전략 유효한지 위 몬테카를로 참조`);

  console.log(`\n  4. 최종 판정:`);
  if (sim10B.totalReturn > 0 && bigLimitUpEV > 0) {
    console.log(`     거래대금 10억+ 종목만 걸러도 EV ${fmtPct(bigLimitUpEV)}, 승률 ${(bigLimitUpWR * 100).toFixed(1)}%`);
    console.log(`     이 정도 거래대금이면 동시호가에서 익절 물량 충분히 나옴.`);
    console.log(`     --> 체결 걱정은 거래대금 필터로 해결 가능.`);
  } else {
    console.log(`     거래대금 높은 상한가로 한정하면 성과가 달라질 수 있음.`);
  }

  console.log('\n' + '━'.repeat(72));

  // 저장
  const savePath = path.join(__dirname, '..', 'results', 'limitup-volume-analysis.json');
  fs.writeFileSync(savePath, JSON.stringify({
    period: { from: DATE_FROM, to: DATE_TO },
    totalSignals: signals.length,
    limitUpCount: limitUps.length,
    nonLimitCount: nonLimits.length,
    limitUpTradingValueDistribution: { p10, p25, p50, p75, p90 },
    bigLimitUps: {
      count: bigLimitUps.length,
      ev: +bigLimitUpEV.toFixed(6),
      winRate: +bigLimitUpWR.toFixed(4),
    },
  }, null, 2));
  console.log(`\n  결과 저장: ${savePath}`);
}

// ─── 유틸 ───
function fmtPct(v) {
  const val = v * 100;
  return (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
}
function fmtWon(v) {
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '억원';
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '만원';
  return v.toLocaleString() + '원';
}
function pad(s, len) {
  const sLen = [...s].reduce((acc, c) => acc + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  const diff = len - sLen;
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

main();
