/**
 * 번트: 공격형 프리셋 필터 조합 비교 백테스트
 * ─────────────────────────────────────────────────────────
 * 기본 조건: 등락률≥20%, 종가=고가(98%+), 코스닥, 종가매수→익일시가매도
 * 12가지 필터 조합 × TOP 3/5/10 = 36 시뮬레이션
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');
const COST = 0.00231;       // 수수료+세금+슬리피지
const INIT_CAPITAL = 5000000;

// ── 데이터 로딩 ─────────────────────────────────────────
function loadData(dateFrom, dateTo) {
  const kosdaqCodes = new Set(JSON.parse(fs.readFileSync(KOSDAQ_FILE, 'utf8')));
  const files = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.json') && kosdaqCodes.has(f.replace('.json', '')));

  const dateMap = {};

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, file), 'utf8'));
      if (!Array.isArray(data) || data.length < 65) continue;
    } catch { continue; }

    for (let i = 60; i < data.length - 1; i++) {
      const d = data[i], prev = data[i - 1], next = data[i + 1];
      if (!d.date || d.date < dateFrom || d.date > dateTo) continue;
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) continue;
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;

      const changeRate = (d.close - prev.close) / prev.close;
      const overnight = (next.open - d.close) / d.close;
      const isLimitUp = changeRate >= 0.29;

      const adjOvernight = isLimitUp ? overnight * 0.5 : overnight;

      if (!dateMap[d.date]) dateMap[d.date] = [];
      dateMap[d.date].push({
        overnight: adjOvernight,
        changeRate,
        isLimitUp,
        volPrice: d.volume * d.close,
        gapUp: (d.open - prev.close) / prev.close,
        closeVsHigh: d.high > 0 ? d.close / d.high : 0,
      });
    }
  }
  return { dateMap, sortedDates: Object.keys(dateMap).sort() };
}

// ── 시뮬레이션 ──────────────────────────────────────────
function simulate(dateMap, sortedDates, filterFn, topN) {
  let capital = INIT_CAPITAL;
  let tradeDays = 0, totalTrades = 0, winTrades = 0;
  let maxCap = INIT_CAPITAL, maxDD = 0;
  let retSum = 0;
  let totalDates = sortedDates.length;
  let dailyStockSum = 0;

  for (const date of sortedDates) {
    const bars = dateMap[date];

    // 필터 적용 후 등락률 내림차순 정렬, TOP N 선택
    const filtered = bars.filter(b => filterFn(b))
      .sort((a, b) => b.changeRate - a.changeRate)
      .slice(0, topN);

    if (filtered.length === 0) continue;
    tradeDays++;
    dailyStockSum += filtered.length;

    const n = filtered.length;
    let dayRet = 0;
    for (const s of filtered) {
      const net = s.overnight - COST;
      dayRet += net / n;
      totalTrades++;
      if (net > 0) winTrades++;
    }

    capital *= (1 + dayRet);
    retSum += dayRet;
    if (capital > maxCap) maxCap = capital;
    const dd = (maxCap - capital) / maxCap;
    if (dd > maxDD) maxDD = dd;
  }

  const avgDaily = tradeDays > 0 ? retSum / tradeDays : 0;
  const avgPerTrade = totalTrades > 0 ? retSum / totalTrades : 0;
  const annualReturn = tradeDays > 0 ? (Math.pow(capital / INIT_CAPITAL, 250 / totalDates) - 1) : 0;
  const calmar = maxDD > 0 ? annualReturn / maxDD : 0;

  return {
    capital,
    avgPerTrade,
    winRate: totalTrades > 0 ? winTrades / totalTrades : 0,
    avgDaily,
    maxDD,
    calmar,
    totalTrades,
    tradeDays,
    avgStocksPerDay: tradeDays > 0 ? dailyStockSum / tradeDays : 0,
    annualReturn,
  };
}

// ── 메인 ────────────────────────────────────────────────
function main() {
  console.log('='.repeat(100));
  console.log('  번트: 공격형 프리셋 필터 조합 비교 백테스트');
  console.log('='.repeat(100));

  // 최근 1년치
  const dateTo = '2026-03-19';
  const dateFrom = '2025-03-19';

  console.log(`  기간: ${dateFrom} ~ ${dateTo}`);
  console.log('  데이터 로딩 중...');

  const { dateMap, sortedDates } = loadData(dateFrom, dateTo);
  console.log(`  ${sortedDates.length}거래일 로드 완료\n`);

  // ── 12가지 필터 조합 정의 ─────────────────────────────
  // 기본 조건: 등락률≥20%, 종가=고가(98%+), 코스닥
  const BASE = b => b.changeRate >= 0.20 && b.closeVsHigh >= 0.98;

  const combos = [
    { id: 1,  name: '기본 공격형 (등락≥20% + 종가=고가98%)',
      fn: b => BASE(b) },
    { id: 2,  name: '종가=고가 100%',
      fn: b => b.changeRate >= 0.20 && b.closeVsHigh >= 1.0 },
    { id: 3,  name: '기본 + 갭업≥0%',
      fn: b => BASE(b) && b.gapUp >= 0 },
    { id: 4,  name: '기본 + 거래대금≥10억',
      fn: b => BASE(b) && b.volPrice >= 10e8 },
    { id: 5,  name: '등락≥25% + 종가=고가98%',
      fn: b => b.changeRate >= 0.25 && b.closeVsHigh >= 0.98 },
    { id: 6,  name: '종가=고가100% + 갭업≥0%',
      fn: b => b.changeRate >= 0.20 && b.closeVsHigh >= 1.0 && b.gapUp >= 0 },
    { id: 7,  name: '종가=고가100% + 거래대금≥10억',
      fn: b => b.changeRate >= 0.20 && b.closeVsHigh >= 1.0 && b.volPrice >= 10e8 },
    { id: 8,  name: '기본 + 갭업≥0% + 거래대금≥10억',
      fn: b => BASE(b) && b.gapUp >= 0 && b.volPrice >= 10e8 },
    { id: 9,  name: '종가=고가100% + 갭업≥0% + 거래대금≥10억',
      fn: b => b.changeRate >= 0.20 && b.closeVsHigh >= 1.0 && b.gapUp >= 0 && b.volPrice >= 10e8 },
    { id: 10, name: '등락≥25% + 종가=고가100%',
      fn: b => b.changeRate >= 0.25 && b.closeVsHigh >= 1.0 },
    { id: 11, name: '등락≥25% + 종가=고가100% + 갭업≥0%',
      fn: b => b.changeRate >= 0.25 && b.closeVsHigh >= 1.0 && b.gapUp >= 0 },
    { id: 12, name: '등락≥25% + 거래대금≥10억',
      fn: b => b.changeRate >= 0.25 && b.closeVsHigh >= 0.98 && b.volPrice >= 10e8 },
  ];

  const topNs = [3, 5, 10];
  const allResults = [];

  for (const combo of combos) {
    for (const topN of topNs) {
      const sim = simulate(dateMap, sortedDates, combo.fn, topN);
      allResults.push({
        comboId: combo.id,
        comboName: combo.name,
        topN,
        label: `[#${combo.id}] ${combo.name} (TOP ${topN})`,
        avgPerTrade: +(sim.avgPerTrade * 100).toFixed(4),
        winRate: +(sim.winRate * 100).toFixed(2),
        avgDaily: +(sim.avgDaily * 100).toFixed(4),
        maxDD: +(sim.maxDD * 100).toFixed(2),
        calmar: +sim.calmar.toFixed(2),
        totalTrades: sim.totalTrades,
        avgStocksPerDay: +sim.avgStocksPerDay.toFixed(1),
        tradeDays: sim.tradeDays,
        capital: Math.round(sim.capital),
        annualReturn: +(sim.annualReturn * 100).toFixed(2),
      });
    }
  }

  // ── 건당 평균 수익률 순 정렬 ──────────────────────────
  const byReturn = [...allResults].sort((a, b) => b.avgPerTrade - a.avgPerTrade);

  console.log('='.repeat(130));
  console.log('  전체 결과 — 건당 평균 수익률 순');
  console.log('='.repeat(130));
  console.log(`  ${'#'.padStart(3)} ${'건당수익%'.padStart(8)} ${'승률%'.padStart(7)} ${'일수익%'.padStart(8)} ${'MDD%'.padStart(7)} ${'칼마'.padStart(7)} ${'거래건'.padStart(7)} ${'종/일'.padStart(5)} ${'거래일'.padStart(5)} ${'500만→'.padStart(10)} ${'연환산%'.padStart(8)} | 조합`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(10)} ${'─'.repeat(8)} + ${'─'.repeat(50)}`);

  for (let i = 0; i < byReturn.length; i++) {
    const r = byReturn[i];
    const fin = r.capital >= 1e12 ? (r.capital/1e12).toFixed(0)+'조' :
                r.capital >= 1e8 ? (r.capital/1e8).toFixed(1)+'억' :
                r.capital >= 1e6 ? (r.capital/1e6).toFixed(1)+'백만' :
                (r.capital/1e4).toFixed(0)+'만';
    console.log(`  ${String(i+1).padStart(3)} ${r.avgPerTrade.toFixed(2).padStart(7)}% ${r.winRate.toFixed(1).padStart(6)}% ${r.avgDaily.toFixed(2).padStart(7)}% ${r.maxDD.toFixed(1).padStart(6)}% ${r.calmar.toFixed(1).padStart(7)} ${String(r.totalTrades).padStart(7)} ${r.avgStocksPerDay.toFixed(1).padStart(5)} ${String(r.tradeDays).padStart(5)} ${fin.padStart(10)} ${r.annualReturn.toFixed(1).padStart(7)}% | ${r.label}`);
  }

  // ── TOP 5 수익률 조합 ─────────────────────────────────
  console.log(`\n${'='.repeat(100)}`);
  console.log('  ** 건당 평균 수익률 TOP 5 조합 **');
  console.log('='.repeat(100));
  for (let i = 0; i < Math.min(5, byReturn.length); i++) {
    const r = byReturn[i];
    const fin = r.capital >= 1e12 ? (r.capital/1e12).toFixed(0)+'조' :
                r.capital >= 1e8 ? (r.capital/1e8).toFixed(1)+'억' :
                r.capital >= 1e6 ? (r.capital/1e6).toFixed(1)+'백만' :
                (r.capital/1e4).toFixed(0)+'만';
    console.log(`  ${i+1}위: ${r.label}`);
    console.log(`       건당수익: ${r.avgPerTrade.toFixed(2)}% | 승률: ${r.winRate.toFixed(1)}% | 일수익: ${r.avgDaily.toFixed(2)}% | MDD: ${r.maxDD.toFixed(1)}% | 칼마: ${r.calmar.toFixed(1)} | 거래건: ${r.totalTrades} | 500만→${fin}`);
    console.log('');
  }

  // ── JSON 저장 ─────────────────────────────────────────
  const savePath = path.join(__dirname, '..', 'results', 'aggressive-filter-search.json');
  const saveData = {
    meta: {
      dateFrom, dateTo,
      tradingDays: sortedDates.length,
      cost: COST,
      initCapital: INIT_CAPITAL,
      baseCondition: '등락률≥20%, 종가=고가(98%+), 코스닥, 종가매수→익일시가매도',
      limitUpDiscount: '상한가(29%+) 수익률 50% 할인',
      generatedAt: new Date().toISOString(),
    },
    combos: combos.map(c => ({ id: c.id, name: c.name })),
    topNs,
    results: allResults,
    ranking: {
      byAvgPerTrade: byReturn.slice(0, 10).map(r => ({
        label: r.label, avgPerTrade: r.avgPerTrade, winRate: r.winRate,
        avgDaily: r.avgDaily, maxDD: r.maxDD, calmar: r.calmar,
        totalTrades: r.totalTrades, capital: r.capital,
      })),
    },
  };

  fs.writeFileSync(savePath, JSON.stringify(saveData, null, 2));
  console.log(`결과 저장: ${savePath}`);
}

main();
