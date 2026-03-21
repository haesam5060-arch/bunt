#!/usr/bin/env node
/**
 * 번트 엔진 — 매수 체결 가능성 분석
 * 핵심 질문: "종가=고가인 20%+ 급등주를 장마감에 실제로 살 수 있는가?"
 *
 * 분석 항목:
 *   1. 상한가(29%+) vs 비상한가(20~29%) 구분 분석
 *   2. 거래대금 구간별 체결 가능성 추정
 *   3. 슬리피지 시뮬레이션 (0%, 0.5%, 1%, 2%)
 *   4. 상한가 제외 시 성과
 *   5. 종합 판정
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const COMMISSION = 0.005;
const TAX = 0.0018;
const ROUND_TRIP = COMMISSION * 2 + TAX; // 1.18%
const SEED = 500_000;
const MAX_PICKS = 10;
const DATE_FROM = '2025-03-20';
const DATE_TO = '2026-03-20';

// 상한가 기준 (코스닥 30% 상한가이나, 가격대별 호가단위 때문에 29%+로 판정)
const LIMIT_UP_THRESHOLD = 0.29;

// 거래대금 구간 (원)
const VOLUME_BUCKETS = [
  { label: '1억 미만', min: 0, max: 1e8 },
  { label: '1~5억', min: 1e8, max: 5e8 },
  { label: '5~10억', min: 5e8, max: 10e8 },
  { label: '10억 이상', min: 10e8, max: Infinity },
];

// 슬리피지 시나리오
const SLIPPAGE_SCENARIOS = [0, 0.005, 0.01, 0.02];

// ─── OHLCV 전체 로드 ───
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

// ─── 종목명 로드 ───
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

// ─── 거래일 리스트 추출 ───
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

// ─── 필터 적용 (번트 현행 필터, MAX_PICKS 제한 없이 전수 반환) ───
function filterAllStocks(allOHLCV, buyDate) {
  const results = [];
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

    // 번트 현행 필터
    if (changeRate < 0.20) continue;
    if (closeHighRatio < 1.0) continue;
    if (gapUp < 0) continue;
    if (changeRate > 0.30) continue;

    // 거래대금 = 평균가(≈close) × 거래량 (근사)
    const tradingValue = close * volume;

    results.push({
      code, changeRate, close, open, high, low, volume, prevClose,
      gapUp, tradingValue,
      isLimitUp: changeRate >= LIMIT_UP_THRESHOLD,
    });
  }

  results.sort((a, b) => b.changeRate - a.changeRate);
  return results;
}

// ─── 개별 매매 수익률 계산 ───
function calcReturn(allOHLCV, code, buyDate, sellDate, buyPrice, slippage) {
  const { data, dateMap } = allOHLCV[code];
  const sellIdx = dateMap[sellDate];
  if (sellIdx === undefined) return null;

  const sellDay = data[sellIdx];
  const adjustedBuyPrice = buyPrice * (1 + slippage);
  const grossReturn = (sellDay.open - adjustedBuyPrice) / adjustedBuyPrice;
  const netReturn = grossReturn - ROUND_TRIP;
  return { sellPrice: sellDay.open, grossReturn, netReturn };
}

// ─── 통계 헬퍼 ───
function calcStats(trades) {
  if (trades.length === 0) return { count: 0, wins: 0, winRate: 0, avgReturn: 0, ev: 0, totalReturn: 0 };
  const wins = trades.filter(t => t.netReturn > 0).length;
  const avgReturn = trades.reduce((s, t) => s + t.netReturn, 0) / trades.length;
  return {
    count: trades.length,
    wins,
    winRate: wins / trades.length,
    avgReturn,
    ev: avgReturn,
    totalReturn: trades.reduce((s, t) => s + t.netReturn, 0),
  };
}

// ─── 자본 시뮬레이션 (MAX_PICKS 제한 적용) ───
function simulateCapital(allOHLCV, tradingDates, allDailyPicks, slippage, filterFn) {
  let capital = SEED;
  let peakCapital = SEED;
  let maxDD = 0;
  let totalTrades = 0;
  let totalWins = 0;

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    const sellDate = tradingDates[di + 1];
    let picks = allDailyPicks[buyDate] || [];

    if (filterFn) picks = picks.filter(filterFn);
    picks = picks.slice(0, MAX_PICKS);
    if (picks.length === 0) continue;

    const trades = [];
    for (const p of picks) {
      const result = calcReturn(allOHLCV, p.code, buyDate, sellDate, p.close, slippage);
      if (result) trades.push(result);
    }

    if (trades.length === 0) continue;

    const perStock = capital / trades.length;
    let dayPnl = 0;
    for (const t of trades) {
      dayPnl += perStock * t.netReturn;
      totalTrades++;
      if (t.netReturn > 0) totalWins++;
    }

    capital += dayPnl;
    if (capital > peakCapital) peakCapital = capital;
    const dd = (peakCapital - capital) / peakCapital;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    finalCapital: capital,
    totalReturn: (capital - SEED) / SEED,
    maxDD,
    totalTrades,
    totalWins,
    winRate: totalTrades > 0 ? totalWins / totalTrades : 0,
  };
}

// ─── 메인 ───
function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  번트 엔진 — 매수 체결 가능성 분석');
  console.log('  "종가=고가인 20%+ 급등주를 장마감에 실제로 살 수 있는가?"');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO} | 수수료: ${(ROUND_TRIP * 100).toFixed(2)}%`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const allOHLCV = loadAllOHLCV();
  const nameMap = loadNameMap();
  console.log(`로드 완료: ${Object.keys(allOHLCV).length}개 종목\n`);

  const tradingDates = getTradingDates(allOHLCV);
  console.log(`거래일: ${tradingDates.length}일 (${tradingDates[0]} ~ ${tradingDates[tradingDates.length - 1]})\n`);

  // ─── 전 거래일 필터 통과 종목 수집 ───
  const allDailyPicks = {};
  const allTrades = [];       // 전체 (슬리피지 0 기준)
  const limitUpTrades = [];   // 상한가 (29%+)
  const nonLimitTrades = [];  // 비상한가 (20~29%)

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    const sellDate = tradingDates[di + 1];

    const picks = filterAllStocks(allOHLCV, buyDate);
    allDailyPicks[buyDate] = picks;

    // 전수 수익률 (MAX_PICKS 제한 없이, 분석 목적)
    for (const p of picks) {
      const result = calcReturn(allOHLCV, p.code, buyDate, sellDate, p.close, 0);
      if (!result) continue;

      const trade = {
        date: buyDate,
        code: p.code,
        name: nameMap[p.code] || p.code,
        changeRate: p.changeRate,
        tradingValue: p.tradingValue,
        isLimitUp: p.isLimitUp,
        ...result,
      };

      allTrades.push(trade);
      if (p.isLimitUp) limitUpTrades.push(trade);
      else nonLimitTrades.push(trade);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 1. 상한가 vs 비상한가 구분 분석
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  [1] 상한가(29%+) vs 비상한가(20~29%) 구분 분석');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const allStats = calcStats(allTrades);
  const limitStats = calcStats(limitUpTrades);
  const nonLimitStats = calcStats(nonLimitTrades);

  console.log(`  ${'구분'.padEnd(16)} ${'건수'.padStart(6)} ${'비중'.padStart(8)} ${'승률'.padStart(8)} ${'평균수익률'.padStart(10)} ${'EV(건당)'.padStart(10)}`);
  console.log('  ' + '─'.repeat(62));

  const rows = [
    ['전체 (20~30%)', allStats],
    ['상한가 (29%+)', limitStats],
    ['비상한가 (20~29%)', nonLimitStats],
  ];

  for (const [label, s] of rows) {
    const pct = allStats.count > 0 ? (s.count / allStats.count * 100).toFixed(1) + '%' : '-';
    console.log(`  ${pad(label, 16)} ${s.count.toString().padStart(6)} ${pct.padStart(8)} ${(s.winRate * 100).toFixed(1).padStart(7)}% ${fmtPct(s.avgReturn).padStart(10)} ${fmtPct(s.ev).padStart(10)}`);
  }

  console.log(`\n  * 상한가 종목은 매도호가 없이 매수 불가능할 가능성 높음`);
  console.log(`  * 비상한가 종목은 종가=고가여도 거래 가능 (장마감 동시호가 체결)\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // 2. 거래대금 구간별 분석
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  [2] 거래대금 구간별 체결 가능성 분석');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log(`  ${'거래대금'.padEnd(14)} ${'건수'.padStart(6)} ${'비중'.padStart(8)} ${'승률'.padStart(8)} ${'EV'.padStart(10)} ${'상한가비중'.padStart(10)}`);
  console.log('  ' + '─'.repeat(60));

  for (const bucket of VOLUME_BUCKETS) {
    const bucketTrades = allTrades.filter(t => t.tradingValue >= bucket.min && t.tradingValue < bucket.max);
    const bucketLimitUp = bucketTrades.filter(t => t.isLimitUp);
    const stats = calcStats(bucketTrades);
    const pct = allStats.count > 0 ? (stats.count / allStats.count * 100).toFixed(1) + '%' : '-';
    const limitPct = bucketTrades.length > 0 ? (bucketLimitUp.length / bucketTrades.length * 100).toFixed(1) + '%' : '-';
    console.log(`  ${pad(bucket.label, 14)} ${stats.count.toString().padStart(6)} ${pct.padStart(8)} ${(stats.winRate * 100).toFixed(1).padStart(7)}% ${fmtPct(stats.ev).padStart(10)} ${limitPct.padStart(10)}`);
  }

  // 비상한가만 거래대금 분석
  console.log(`\n  [비상한가(20~29%)만 거래대금 분석]`);
  console.log(`  ${'거래대금'.padEnd(14)} ${'건수'.padStart(6)} ${'승률'.padStart(8)} ${'EV'.padStart(10)}`);
  console.log('  ' + '─'.repeat(42));

  for (const bucket of VOLUME_BUCKETS) {
    const bucketTrades = nonLimitTrades.filter(t => t.tradingValue >= bucket.min && t.tradingValue < bucket.max);
    const stats = calcStats(bucketTrades);
    console.log(`  ${pad(bucket.label, 14)} ${stats.count.toString().padStart(6)} ${(stats.winRate * 100).toFixed(1).padStart(7)}% ${fmtPct(stats.ev).padStart(10)}`);
  }

  console.log(`\n  * 거래대금이 클수록 장마감 동시호가 체결 확률 높음`);
  console.log(`  * 1억 미만은 유동성 부족으로 체결 불확실\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // 3. 슬리피지 시뮬레이션
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  [3] 슬리피지 시뮬레이션 (종가 대비 불리하게 매수)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log('  [전체 종목 기준 (MAX_PICKS=10 적용)]');
  console.log(`  ${'슬리피지'.padEnd(10)} ${'총거래'.padStart(6)} ${'승률'.padStart(8)} ${'최종자본'.padStart(14)} ${'총수익률'.padStart(10)} ${'MDD'.padStart(8)}`);
  console.log('  ' + '─'.repeat(60));

  for (const slip of SLIPPAGE_SCENARIOS) {
    const sim = simulateCapital(allOHLCV, tradingDates, allDailyPicks, slip, null);
    console.log(`  ${pad(fmtPct(slip), 10)} ${sim.totalTrades.toString().padStart(6)} ${(sim.winRate * 100).toFixed(1).padStart(7)}% ${Math.round(sim.finalCapital).toLocaleString().padStart(14)}원 ${fmtPct(sim.totalReturn).padStart(10)} ${fmtPct(sim.maxDD).padStart(8)}`);
  }

  console.log('\n  [비상한가만 (29% 미만, MAX_PICKS=10 적용)]');
  console.log(`  ${'슬리피지'.padEnd(10)} ${'총거래'.padStart(6)} ${'승률'.padStart(8)} ${'최종자본'.padStart(14)} ${'총수익률'.padStart(10)} ${'MDD'.padStart(8)}`);
  console.log('  ' + '─'.repeat(60));

  for (const slip of SLIPPAGE_SCENARIOS) {
    const sim = simulateCapital(allOHLCV, tradingDates, allDailyPicks, slip, p => !p.isLimitUp);
    console.log(`  ${pad(fmtPct(slip), 10)} ${sim.totalTrades.toString().padStart(6)} ${(sim.winRate * 100).toFixed(1).padStart(7)}% ${Math.round(sim.finalCapital).toLocaleString().padStart(14)}원 ${fmtPct(sim.totalReturn).padStart(10)} ${fmtPct(sim.maxDD).padStart(8)}`);
  }

  console.log(`\n  * 슬리피지 = 종가보다 비싸게 매수하는 비용 (체결 경쟁)`);
  console.log(`  * 0.5% = 1만원 종목에서 50원 높게 매수\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // 4. 상한가 제외 시 성과
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  [4] 상한가 제외 시 전략 성과 (현실적 시나리오)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // 기준: 슬리피지 0%
  const simAll = simulateCapital(allOHLCV, tradingDates, allDailyPicks, 0, null);
  const simNoLimit = simulateCapital(allOHLCV, tradingDates, allDailyPicks, 0, p => !p.isLimitUp);
  const simNoLimitSlip05 = simulateCapital(allOHLCV, tradingDates, allDailyPicks, 0.005, p => !p.isLimitUp);
  const simNoLimitSlip1 = simulateCapital(allOHLCV, tradingDates, allDailyPicks, 0.01, p => !p.isLimitUp);

  console.log(`  ${'시나리오'.padEnd(30)} ${'거래수'.padStart(6)} ${'승률'.padStart(8)} ${'최종자본'.padStart(14)} ${'총수익률'.padStart(10)} ${'MDD'.padStart(8)}`);
  console.log('  ' + '─'.repeat(78));

  const scenarios = [
    ['기본 (상한가 포함, 슬립0%)', simAll],
    ['상한가 제외, 슬립 0%', simNoLimit],
    ['상한가 제외, 슬립 0.5%', simNoLimitSlip05],
    ['상한가 제외, 슬립 1.0%', simNoLimitSlip1],
  ];

  for (const [label, sim] of scenarios) {
    console.log(`  ${pad(label, 30)} ${sim.totalTrades.toString().padStart(6)} ${(sim.winRate * 100).toFixed(1).padStart(7)}% ${Math.round(sim.finalCapital).toLocaleString().padStart(14)}원 ${fmtPct(sim.totalReturn).padStart(10)} ${fmtPct(sim.maxDD).padStart(8)}`);
  }

  // ─── 등락률 세분화 분석 ───
  console.log('\n  [등락률 구간별 세분화]');
  console.log(`  ${'구간'.padEnd(14)} ${'건수'.padStart(6)} ${'승률'.padStart(8)} ${'EV'.padStart(10)} ${'체결가능성'.padStart(10)}`);
  console.log('  ' + '─'.repeat(52));

  const changeBuckets = [
    { label: '20~22%', min: 0.20, max: 0.22, feasibility: '높음' },
    { label: '22~25%', min: 0.22, max: 0.25, feasibility: '높음' },
    { label: '25~27%', min: 0.25, max: 0.27, feasibility: '보통' },
    { label: '27~29%', min: 0.27, max: 0.29, feasibility: '낮음' },
    { label: '29~30%', min: 0.29, max: 0.30, feasibility: '매우낮음' },
  ];

  for (const b of changeBuckets) {
    const bTrades = allTrades.filter(t => t.changeRate >= b.min && t.changeRate < b.max);
    const s = calcStats(bTrades);
    console.log(`  ${pad(b.label, 14)} ${s.count.toString().padStart(6)} ${(s.winRate * 100).toFixed(1).padStart(7)}% ${fmtPct(s.ev).padStart(10)} ${b.feasibility.padStart(10)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5. 종합 결론
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  [결론] 매수 체결 가능성 종합 판정');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const limitPct = allStats.count > 0 ? (limitStats.count / allStats.count * 100).toFixed(1) : '0';
  console.log(`  1. 상한가(29%+) 비중: ${limitStats.count}건 / ${allStats.count}건 (${limitPct}%)`);
  console.log(`     - 상한가 EV: ${fmtPct(limitStats.ev)} | 비상한가 EV: ${fmtPct(nonLimitStats.ev)}`);

  const noLimitOk = simNoLimit.totalReturn > 0;
  console.log(`\n  2. 상한가 빼도 전략 유효한가?`);
  console.log(`     - 상한가 제외 수익률: ${fmtPct(simNoLimit.totalReturn)} (${noLimitOk ? 'YES - 유효' : 'NO - 무효'})`);
  console.log(`     - 상한가 포함 수익률: ${fmtPct(simAll.totalReturn)} (비교 기준)`);

  // 슬리피지 한계점 찾기
  let maxTolerableSlip = 0;
  for (const slip of [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03]) {
    const sim = simulateCapital(allOHLCV, tradingDates, allDailyPicks, slip, p => !p.isLimitUp);
    if (sim.totalReturn > 0) maxTolerableSlip = slip;
    else break;
  }

  console.log(`\n  3. 슬리피지 허용 한계 (비상한가 기준):`);
  console.log(`     - 최대 ${fmtPct(maxTolerableSlip)}까지 슬리피지를 견디고도 수익`);
  if (maxTolerableSlip >= 0.01) {
    console.log(`     - 1% 이상 견딤 → 체결 비용 감당 가능`);
  } else if (maxTolerableSlip >= 0.005) {
    console.log(`     - 0.5~1% 수준 → 빠듯하지만 가능`);
  } else {
    console.log(`     - 0.5% 미만 → 슬리피지에 취약, 체결 비용에 민감`);
  }

  console.log(`\n  4. 최종 판정:`);

  if (nonLimitStats.count === 0) {
    console.log(`     !! 비상한가 데이터가 없어 판정 불가`);
  } else {
    const limitRatio = limitStats.count / allStats.count;
    const nonLimitEv = nonLimitStats.ev;
    const isViable = simNoLimitSlip05.totalReturn > 0;

    console.log(`     - 전체 시그널 중 상한가 비중: ${(limitRatio * 100).toFixed(1)}%`);

    if (limitRatio < 0.2) {
      console.log(`     - 상한가 비중 낮음 (${(limitRatio * 100).toFixed(1)}%) → 대부분 체결 가능한 종목`);
    } else if (limitRatio < 0.5) {
      console.log(`     - 상한가 비중 보통 (${(limitRatio * 100).toFixed(1)}%) → 절반 이상은 체결 가능`);
    } else {
      console.log(`     - 상한가 비중 높음 (${(limitRatio * 100).toFixed(1)}%) → 상당수 체결 불가 위험`);
    }

    if (isViable) {
      console.log(`\n     >>> 판정: 체결 걱정은 과도함`);
      console.log(`         상한가를 빼고 슬리피지 0.5%를 감안해도 수익률 ${fmtPct(simNoLimitSlip05.totalReturn)}`);
      console.log(`         20~29% 비상한가 종목만으로 전략 충분히 유효`);
    } else if (simNoLimit.totalReturn > 0) {
      console.log(`\n     >>> 판정: 체결 걱정 일부 유효`);
      console.log(`         상한가 빼면 수익이나, 슬리피지 0.5% 감안 시 손익분기 근처`);
      console.log(`         체결가 관리(지정가 주문 등)가 중요`);
    } else {
      console.log(`\n     >>> 판정: 체결 걱정이 현실적임`);
      console.log(`         상한가를 빼면 전략 자체가 수익 미달`);
      console.log(`         상한가 종목의 수익이 전략 핵심 → 체결 불가 시 전략 무효화 위험`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─── 유틸 ───
function fmtPct(v) {
  if (v === undefined || v === null || isNaN(v)) return '-';
  const val = v * 100;
  return (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
}

function pad(s, len) {
  const sLen = [...s].reduce((acc, c) => acc + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  const diff = len - sLen;
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

main();
