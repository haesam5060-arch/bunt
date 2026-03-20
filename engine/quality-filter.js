/**
 * 번트: 2차 품질 필터 — TOP 30에서 진짜 좋은 놈만 고르기
 * ─────────────────────────────────────────────────────────
 * 1차: 등락률 TOP 30 선정
 * 2차: 추가 필터 조합으로 2~10개 압축
 * 목표: 종목 수는 적어도 되니, 건당 수익률 극대화
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');
const COST = 0.00231;
const INIT_CAPITAL = 5000000;

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
      const range = d.high - d.low;
      const isLimitUp = changeRate >= 0.29;

      let v5 = 0;
      for (let j = i - 5; j < i; j++) v5 += (data[j]?.volume || 0);
      const avgV5 = v5 / 5;

      const adjOvernight = isLimitUp ? overnight * 0.5 : overnight;

      if (!dateMap[d.date]) dateMap[d.date] = [];
      dateMap[d.date].push({
        overnight: adjOvernight,
        changeRate,
        isLimitUp,
        volPrice: d.volume * d.close,
        volRatio5: avgV5 > 0 ? d.volume / avgV5 : 0,
        lowerWick: range > 0 ? (Math.min(d.close, d.open) - d.low) / range : 0,
        upperWick: range > 0 ? (d.high - Math.max(d.close, d.open)) / range : 0,
        gapUp: (d.open - prev.close) / prev.close,
        bodyRatio: range > 0 ? (d.close - d.open) / range : 0,
        closeVsHigh: d.high > 0 ? d.close / d.high : 0,
        rangePct: d.close > 0 ? range / d.close : 0,
      });
    }
  }
  return { dateMap, sortedDates: Object.keys(dateMap).sort() };
}

function simulate(dateMap, sortedDates, secondaryFilter, minStocks = 2, maxStocks = 10) {
  let capital = INIT_CAPITAL;
  let tradeDays = 0, totalTrades = 0, winTrades = 0;
  let maxCap = INIT_CAPITAL, maxDD = 0;
  let retSum = 0, retSqSum = 0;
  let skipDays = 0;

  for (const date of sortedDates) {
    const bars = dateMap[date];

    // 1차: 등락률 TOP 30
    const sorted = [...bars].sort((a, b) => b.changeRate - a.changeRate).slice(0, 30);

    // 2차: 품질 필터
    const filtered = sorted.filter(b => secondaryFilter(b));

    if (filtered.length < minStocks) { skipDays++; continue; }
    tradeDays++;

    const sel = filtered.slice(0, maxStocks);
    const n = sel.length;

    let dayRet = 0;
    for (const s of sel) {
      const net = s.overnight - COST;
      dayRet += net / n;
      totalTrades++;
      if (net > 0) winTrades++;
    }

    capital *= (1 + dayRet);
    retSum += dayRet;
    retSqSum += dayRet * dayRet;
    if (capital > maxCap) maxCap = capital;
    const dd = (maxCap - capital) / maxCap;
    if (dd > maxDD) maxDD = dd;
  }

  const avgDaily = tradeDays > 0 ? retSum / tradeDays : 0;
  const avgPerTrade = totalTrades > 0 ? retSum / totalTrades : 0;
  const variance = tradeDays > 1 ? (retSqSum / tradeDays - avgDaily * avgDaily) : 0;
  const std = Math.sqrt(Math.max(0, variance));
  const sharpe = std > 0 ? (avgDaily / std) * Math.sqrt(250) : 0;

  return {
    capital, avgDaily, avgPerTrade,
    winRate: totalTrades > 0 ? winTrades / totalTrades : 0,
    maxDD, sharpe, tradeDays, totalTrades, skipDays,
    avgStocks: tradeDays > 0 ? totalTrades / tradeDays : 0,
  };
}

function main() {
  console.log('═'.repeat(85));
  console.log('  번트: 2차 품질 필터 탐색 — TOP 30에서 진짜 좋은 놈만 고르기');
  console.log('═'.repeat(85));

  const { dateMap, sortedDates } = loadData('2025-03-17', '2026-03-17');
  console.log(`  ${sortedDates.length}거래일\n`);

  // ── 2차 필터 조합 ─────────────────────────────────────
  const filters = [
    // 기준선: 필터 없음 (TOP 10만)
    { name: '기준선: TOP 10 (필터없음)', fn: () => true },
    { name: '기준선: 아꼬≤15%', fn: b => b.lowerWick <= 0.15 },

    // 단일 필터
    { name: '거래대금≥5억', fn: b => b.volPrice >= 5e8 },
    { name: '거래대금≥10억', fn: b => b.volPrice >= 10e8 },
    { name: '거래대금≥20억', fn: b => b.volPrice >= 20e8 },
    { name: '거래대금≥50억', fn: b => b.volPrice >= 50e8 },
    { name: '거래량≥1.5x', fn: b => b.volRatio5 >= 1.5 },
    { name: '거래량≥2x', fn: b => b.volRatio5 >= 2.0 },
    { name: '거래량≥3x', fn: b => b.volRatio5 >= 3.0 },
    { name: '갭업≥0%', fn: b => b.gapUp >= 0 },
    { name: '갭업≥1%', fn: b => b.gapUp >= 0.01 },
    { name: '갭업≥2%', fn: b => b.gapUp >= 0.02 },
    { name: '아꼬≤10%', fn: b => b.lowerWick <= 0.10 },
    { name: '아꼬≤5%', fn: b => b.lowerWick <= 0.05 },
    { name: '아꼬=0%(꼬리없음)', fn: b => b.lowerWick <= 0.01 },
    { name: '종가=고가(98%+)', fn: b => b.closeVsHigh >= 0.98 },
    { name: '종가=고가(95%+)', fn: b => b.closeVsHigh >= 0.95 },
    { name: '양봉(bodyRatio>0)', fn: b => b.bodyRatio > 0 },
    { name: '강한양봉(body>50%)', fn: b => b.bodyRatio > 0.5 },
    { name: '등락≥5%', fn: b => b.changeRate >= 0.05 },
    { name: '등락≥10%', fn: b => b.changeRate >= 0.10 },
    { name: '등락≥15%', fn: b => b.changeRate >= 0.15 },
    { name: '등락≥20%', fn: b => b.changeRate >= 0.20 },

    // 복합 필터 (2개 조합)
    { name: '아꼬≤15% + 거래대금≥20억', fn: b => b.lowerWick <= 0.15 && b.volPrice >= 20e8 },
    { name: '아꼬≤15% + 거래량≥2x', fn: b => b.lowerWick <= 0.15 && b.volRatio5 >= 2.0 },
    { name: '아꼬≤15% + 갭업≥0%', fn: b => b.lowerWick <= 0.15 && b.gapUp >= 0 },
    { name: '아꼬≤15% + 갭업≥1%', fn: b => b.lowerWick <= 0.15 && b.gapUp >= 0.01 },
    { name: '아꼬≤15% + 종가=고가', fn: b => b.lowerWick <= 0.15 && b.closeVsHigh >= 0.98 },
    { name: '아꼬≤5% + 갭업≥0%', fn: b => b.lowerWick <= 0.05 && b.gapUp >= 0 },
    { name: '아꼬≤5% + 거래대금≥20억', fn: b => b.lowerWick <= 0.05 && b.volPrice >= 20e8 },
    { name: '종가=고가 + 거래대금≥20억', fn: b => b.closeVsHigh >= 0.98 && b.volPrice >= 20e8 },
    { name: '종가=고가 + 갭업≥0%', fn: b => b.closeVsHigh >= 0.98 && b.gapUp >= 0 },
    { name: '종가=고가 + 거래량≥2x', fn: b => b.closeVsHigh >= 0.98 && b.volRatio5 >= 2.0 },
    { name: '등락≥10% + 아꼬≤15%', fn: b => b.changeRate >= 0.10 && b.lowerWick <= 0.15 },
    { name: '등락≥10% + 아꼬≤5%', fn: b => b.changeRate >= 0.10 && b.lowerWick <= 0.05 },
    { name: '등락≥10% + 종가=고가', fn: b => b.changeRate >= 0.10 && b.closeVsHigh >= 0.98 },
    { name: '등락≥15% + 아꼬≤15%', fn: b => b.changeRate >= 0.15 && b.lowerWick <= 0.15 },
    { name: '등락≥20% + 아꼬≤15%', fn: b => b.changeRate >= 0.20 && b.lowerWick <= 0.15 },

    // 3중 필터
    { name: '아꼬≤15% + 갭업≥0% + 거래대금≥20억', fn: b => b.lowerWick <= 0.15 && b.gapUp >= 0 && b.volPrice >= 20e8 },
    { name: '아꼬≤15% + 갭업≥1% + 거래량≥2x', fn: b => b.lowerWick <= 0.15 && b.gapUp >= 0.01 && b.volRatio5 >= 2.0 },
    { name: '아꼬≤5% + 갭업≥0% + 거래대금≥20억', fn: b => b.lowerWick <= 0.05 && b.gapUp >= 0 && b.volPrice >= 20e8 },
    { name: '아꼬≤5% + 갭업≥1% + 거래대금≥10억', fn: b => b.lowerWick <= 0.05 && b.gapUp >= 0.01 && b.volPrice >= 10e8 },
    { name: '종가=고가 + 갭업≥0% + 거래대금≥20억', fn: b => b.closeVsHigh >= 0.98 && b.gapUp >= 0 && b.volPrice >= 20e8 },
    { name: '종가=고가 + 아꼬≤5% + 거래량≥2x', fn: b => b.closeVsHigh >= 0.98 && b.lowerWick <= 0.05 && b.volRatio5 >= 2.0 },
    { name: '등락≥10% + 아꼬≤10% + 갭업≥0%', fn: b => b.changeRate >= 0.10 && b.lowerWick <= 0.10 && b.gapUp >= 0 },
    { name: '등락≥10% + 아꼬≤5% + 갭업≥0%', fn: b => b.changeRate >= 0.10 && b.lowerWick <= 0.05 && b.gapUp >= 0 },
    { name: '등락≥10% + 종가=고가 + 갭업≥0%', fn: b => b.changeRate >= 0.10 && b.closeVsHigh >= 0.98 && b.gapUp >= 0 },
    { name: '등락≥15% + 아꼬≤10% + 거래대금≥10억', fn: b => b.changeRate >= 0.15 && b.lowerWick <= 0.10 && b.volPrice >= 10e8 },
    { name: '등락≥15% + 종가=고가 + 갭업≥0%', fn: b => b.changeRate >= 0.15 && b.closeVsHigh >= 0.98 && b.gapUp >= 0 },
    { name: '등락≥20% + 아꼬≤10%', fn: b => b.changeRate >= 0.20 && b.lowerWick <= 0.10 },
    { name: '등락≥20% + 종가=고가', fn: b => b.changeRate >= 0.20 && b.closeVsHigh >= 0.98 },

    // 4중 필터
    { name: '등락≥10% + 아꼬≤5% + 갭업≥0% + 거래대금≥10억', fn: b => b.changeRate >= 0.10 && b.lowerWick <= 0.05 && b.gapUp >= 0 && b.volPrice >= 10e8 },
    { name: '등락≥10% + 종가=고가 + 갭업≥0% + 거래량≥2x', fn: b => b.changeRate >= 0.10 && b.closeVsHigh >= 0.98 && b.gapUp >= 0 && b.volRatio5 >= 2.0 },
    { name: '등락≥15% + 아꼬≤10% + 갭업≥0% + 거래량≥1.5x', fn: b => b.changeRate >= 0.15 && b.lowerWick <= 0.10 && b.gapUp >= 0 && b.volRatio5 >= 1.5 },
  ];

  const results = [];

  for (const f of filters) {
    const sim = simulate(dateMap, sortedDates, f.fn, 2, 10);
    results.push({ name: f.name, ...sim });
  }

  // ── 건당 수익률 순 ────────────────────────────────────
  results.sort((a, b) => b.avgPerTrade - a.avgPerTrade);

  console.log('═'.repeat(85));
  console.log('  건당 수익률 순위 (적은 종목, 높은 수익률)');
  console.log('═'.repeat(85));
  console.log(`  ${'#'.padStart(3)} ${'건당수익'.padStart(7)} ${'일수익'.padStart(7)} ${'승률'.padStart(6)} ${'500만→'.padStart(10)} ${'MDD'.padStart(6)} ${'일'.padStart(4)} ${'종/일'.padStart(5)} ${'미거래'.padStart(4)} | 필터`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(4)} + ${'─'.repeat(38)}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const fin = r.capital >= 1e12 ? (r.capital/1e12).toFixed(0)+'조' :
                r.capital >= 1e8 ? (r.capital/1e8).toFixed(1)+'억' :
                (r.capital/1e4).toFixed(0)+'만';
    console.log(`  ${String(i+1).padStart(3)} ${(r.avgPerTrade*100).toFixed(2).padStart(6)}% ${(r.avgDaily*100).toFixed(2).padStart(6)}% ${(r.winRate*100).toFixed(1).padStart(5)}% ${fin.padStart(10)} ${(r.maxDD*100).toFixed(1).padStart(5)}% ${String(r.tradeDays).padStart(4)} ${r.avgStocks.toFixed(1).padStart(5)} ${String(r.skipDays).padStart(4)} | ${r.name}`);
  }

  // ── 일평균 수익 순 ────────────────────────────────────
  const byDaily = [...results].sort((a, b) => b.avgDaily - a.avgDaily);

  console.log(`\n${'═'.repeat(85)}`);
  console.log('  일평균 수익 순위 (복리 효과 포함)');
  console.log('═'.repeat(85));
  console.log(`  ${'#'.padStart(3)} ${'건당수익'.padStart(7)} ${'일수익'.padStart(7)} ${'승률'.padStart(6)} ${'500만→'.padStart(10)} ${'MDD'.padStart(6)} ${'일'.padStart(4)} ${'종/일'.padStart(5)} ${'미거래'.padStart(4)} | 필터`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(4)} + ${'─'.repeat(38)}`);

  for (let i = 0; i < byDaily.length; i++) {
    const r = byDaily[i];
    const fin = r.capital >= 1e12 ? (r.capital/1e12).toFixed(0)+'조' :
                r.capital >= 1e8 ? (r.capital/1e8).toFixed(1)+'억' :
                (r.capital/1e4).toFixed(0)+'만';
    console.log(`  ${String(i+1).padStart(3)} ${(r.avgPerTrade*100).toFixed(2).padStart(6)}% ${(r.avgDaily*100).toFixed(2).padStart(6)}% ${(r.winRate*100).toFixed(1).padStart(5)}% ${fin.padStart(10)} ${(r.maxDD*100).toFixed(1).padStart(5)}% ${String(r.tradeDays).padStart(4)} ${r.avgStocks.toFixed(1).padStart(5)} ${String(r.skipDays).padStart(4)} | ${r.name}`);
  }

  // ── 칼마(수익/MDD) 순 ─────────────────────────────────
  const byCalmar = [...results].filter(r => r.maxDD > 0).map(r => ({
    ...r, calmar: (r.avgDaily * 250) / r.maxDD
  }));
  byCalmar.sort((a, b) => b.calmar - a.calmar);

  console.log(`\n${'═'.repeat(85)}`);
  console.log('  칼마비율 TOP 20 (수익 대비 리스크 최적)');
  console.log('═'.repeat(85));
  console.log(`  ${'#'.padStart(3)} ${'건당수익'.padStart(7)} ${'일수익'.padStart(7)} ${'승률'.padStart(6)} ${'500만→'.padStart(10)} ${'MDD'.padStart(6)} ${'칼마'.padStart(6)} ${'일'.padStart(4)} ${'종/일'.padStart(5)} | 필터`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(4)} ${'─'.repeat(5)} + ${'─'.repeat(38)}`);

  for (let i = 0; i < Math.min(20, byCalmar.length); i++) {
    const r = byCalmar[i];
    const fin = r.capital >= 1e12 ? (r.capital/1e12).toFixed(0)+'조' :
                r.capital >= 1e8 ? (r.capital/1e8).toFixed(1)+'억' :
                (r.capital/1e4).toFixed(0)+'만';
    console.log(`  ${String(i+1).padStart(3)} ${(r.avgPerTrade*100).toFixed(2).padStart(6)}% ${(r.avgDaily*100).toFixed(2).padStart(6)}% ${(r.winRate*100).toFixed(1).padStart(5)}% ${fin.padStart(10)} ${(r.maxDD*100).toFixed(1).padStart(5)}% ${r.calmar.toFixed(1).padStart(6)} ${String(r.tradeDays).padStart(4)} ${r.avgStocks.toFixed(1).padStart(5)} | ${r.name}`);
  }

  // 저장
  const savePath = path.join(__dirname, '..', 'results', 'quality-filter.json');
  fs.writeFileSync(savePath, JSON.stringify({
    byPerTrade: results.slice(0, 20).map(r => ({ name: r.name, avgPerTrade: +r.avgPerTrade.toFixed(6), avgDaily: +r.avgDaily.toFixed(6), winRate: +r.winRate.toFixed(4), maxDD: +r.maxDD.toFixed(4), capital: Math.round(r.capital), tradeDays: r.tradeDays, avgStocks: +r.avgStocks.toFixed(1), skipDays: r.skipDays })),
    byDaily: byDaily.slice(0, 20).map(r => ({ name: r.name, avgPerTrade: +r.avgPerTrade.toFixed(6), avgDaily: +r.avgDaily.toFixed(6), winRate: +r.winRate.toFixed(4), maxDD: +r.maxDD.toFixed(4), capital: Math.round(r.capital), tradeDays: r.tradeDays, avgStocks: +r.avgStocks.toFixed(1) })),
  }, null, 2));
  console.log(`\n💾 ${savePath}`);
}

main();
