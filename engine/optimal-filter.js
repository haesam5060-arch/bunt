/**
 * 번트: 최적 필터 탐색 v2 — 속도 최적화
 * ────────────────────────────────────────
 * 최적화:
 *   1. 상한가 체결률: 랜덤 대신 수익 50% 할인으로 결정론적 처리
 *   2. composite 정렬: 2차 탐색에서만 (1차 changeRate로 TOP 후보 확보)
 *   3. 조합 수 최적화: 불필요 구간 제거
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');

const COST = 0.0118; // 1.18% (한투 수수료 0.5%×2 + 매도세 0.18%)
const INIT_CAPITAL = 5000000;
const MIN_STOCKS = 2;
const MAX_STOCKS = 10;

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

      let c60 = 0;
      for (let j = i - 59; j <= i; j++) c60 += data[j].close;
      const ma60 = c60 / 60;

      let atrSum = 0;
      for (let j = i - 13; j <= i; j++) {
        const h = data[j].high, l = data[j].low, pc = data[j - 1].close;
        atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }

      // 상한가: 수익 50% 할인 (체결 불확실성 반영)
      const adjOvernight = isLimitUp ? overnight * 0.5 : overnight;

      if (!dateMap[d.date]) dateMap[d.date] = [];
      dateMap[d.date].push({
        overnight: adjOvernight,
        rawOvernight: overnight,
        changeRate,
        isLimitUp,
        volPrice: d.volume * d.close,
        volRatio5: avgV5 > 0 ? d.volume / avgV5 : 0,
        lowerWick: range > 0 ? (Math.min(d.close, d.open) - d.low) / range : 0,
        upperWick: range > 0 ? (d.high - Math.max(d.close, d.open)) / range : 0,
        gapUp: (d.open - prev.close) / prev.close,
        ma60Dist: (d.close - ma60) / ma60,
        atrPct: d.close > 0 ? (atrSum / 14) / d.close : 0,
        rangePct: d.close > 0 ? range / d.close : 0,
        bodyRatio: range > 0 ? (d.close - d.open) / range : 0,
        closeVsHigh: d.high > 0 ? d.close / d.high : 0,
      });
    }
  }

  return { dateMap, sortedDates: Object.keys(dateMap).sort() };
}

function generateCombos() {
  const defs = {
    minVolPrice:   [0, 5e8, 2e9, 5e9, 10e9, 50e9],       // 6
    minChangeRate: [-1, 0, 0.02, 0.03, 0.05, 0.07, 0.10], // 7
    minAtrPct:     [0, 0.03, 0.05],                         // 3
    minUpperWick:  [0, 0.1, 0.2],                            // 3
    minGapUp:      [-1, 0, 0.01],                            // 3
    minVolRatio5:  [0, 1.0, 1.5, 2.0],                      // 4
    maxLowerWick:  [1.0, 0.3, 0.15],                         // 3
  };

  const keys = Object.keys(defs);
  const total = keys.reduce((p, k) => p * defs[k].length, 1);
  console.log(`[GRID] 조합: ${total.toLocaleString()}개`);

  const combos = [];
  function gen(idx, cur) {
    if (idx === keys.length) { combos.push({...cur}); return; }
    for (const v of defs[keys[idx]]) { cur[keys[idx]] = v; gen(idx+1, cur); }
  }
  gen(0, {});
  return combos;
}

function simulate(dateMap, sortedDates, combo, sortKey = 'changeRate') {
  let capital = INIT_CAPITAL;
  let tradeDays = 0, totalTrades = 0, winTrades = 0;
  let maxCap = INIT_CAPITAL, maxDD = 0;
  let retSum = 0, retSqSum = 0;

  const { minVolPrice, minChangeRate, minAtrPct, minUpperWick, minGapUp, minVolRatio5, maxLowerWick } = combo;

  for (const date of sortedDates) {
    const bars = dateMap[date];
    const cands = [];

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (b.volPrice < minVolPrice) continue;
      if (minChangeRate > -1 && b.changeRate < minChangeRate) continue;
      if (b.atrPct < minAtrPct) continue;
      if (b.upperWick < minUpperWick) continue;
      if (minGapUp > -1 && b.gapUp < minGapUp) continue;
      if (b.volRatio5 < minVolRatio5) continue;
      if (b.lowerWick > maxLowerWick) continue;
      cands.push(b);
    }

    if (cands.length < MIN_STOCKS) continue;
    tradeDays++;

    cands.sort((a, b) => b[sortKey] - a[sortKey]);
    const sel = cands.length > MAX_STOCKS ? cands.slice(0, MAX_STOCKS) : cands;
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
  const variance = tradeDays > 1 ? (retSqSum / tradeDays - avgDaily * avgDaily) : 0;
  const std = Math.sqrt(Math.max(0, variance));

  return {
    capital, avgDaily,
    winRate: totalTrades > 0 ? winTrades / totalTrades : 0,
    maxDD, sharpe: std > 0 ? (avgDaily / std) * Math.sqrt(250) : 0,
    calmar: maxDD > 0 ? (avgDaily * 250) / maxDD : 0,
    tradeDays, totalTrades,
    avgStocks: tradeDays > 0 ? totalTrades / tradeDays : 0,
  };
}

function fmtCombo(c) {
  return [
    c.minVolPrice > 0 ? `거래대금≥${(c.minVolPrice/1e8).toFixed(0)}억` : null,
    c.minChangeRate > -1 ? `등락≥${(c.minChangeRate*100).toFixed(0)}%` : null,
    c.minAtrPct > 0 ? `ATR≥${(c.minAtrPct*100)}%` : null,
    c.minUpperWick > 0 ? `윗꼬리≥${(c.minUpperWick*100)}%` : null,
    c.minGapUp > -1 ? `갭≥${(c.minGapUp*100).toFixed(1)}%` : null,
    c.minVolRatio5 > 0 ? `거래량≥${c.minVolRatio5}x` : null,
    c.maxLowerWick < 1 ? `아꼬≤${(c.maxLowerWick*100)}%` : null,
  ].filter(Boolean).join(' ');
}

function printTable(label, arr, limit = 25) {
  console.log(`\n${'═'.repeat(85)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(85));
  if (!arr.length) { console.log('  ⚠️ 없음'); return; }
  console.log(`  ${'#'.padStart(3)} ${'승률'.padStart(6)} ${'일수익'.padStart(7)} ${'500만→'.padStart(10)} ${'MDD'.padStart(6)} ${'샤프'.padStart(5)} ${'칼마'.padStart(6)} ${'일'.padStart(4)} ${'종/일'.padStart(4)} ${'정렬'.padStart(6)} | 필터`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(6)} + ${'─'.repeat(35)}`);
  for (let i = 0; i < Math.min(limit, arr.length); i++) {
    const r = arr[i];
    const fin = r.capital >= 1e12 ? (r.capital/1e12).toFixed(0)+'조' :
                r.capital >= 1e8 ? (r.capital/1e8).toFixed(1)+'억' :
                (r.capital/1e4).toFixed(0)+'만';
    console.log(`  ${String(i+1).padStart(3)} ${(r.winRate*100).toFixed(1).padStart(5)}% ${(r.avgDaily*100).toFixed(2).padStart(6)}% ${fin.padStart(10)} ${(r.maxDD*100).toFixed(1).padStart(5)}% ${r.sharpe.toFixed(1).padStart(5)} ${r.calmar.toFixed(1).padStart(6)} ${String(r.tradeDays).padStart(4)} ${r.avgStocks.toFixed(1).padStart(4)} ${r.sortKey.padStart(6)} | ${fmtCombo(r.combo)}`);
  }
}

function main() {
  console.log('═'.repeat(85));
  console.log('  번트 최적 필터 탐색 v2');
  console.log('═'.repeat(85));

  // ── Phase 1: 전체 기간 ─────────────────────────────────
  console.log('\n[Phase 1] 전체 기간 그리드서치 (2025-03 ~ 2026-03)');
  const full = loadData('2025-03-17', '2026-03-17');
  console.log(`  ${full.sortedDates.length}거래일\n`);

  const combos = generateCombos();
  const results = [];
  const t0 = Date.now();

  // 2가지 선택 방식
  for (const sortKey of ['changeRate', 'volPrice']) {
    const st = Date.now();
    for (const combo of combos) {
      const sim = simulate(full.dateMap, full.sortedDates, combo, sortKey);
      if (sim.tradeDays >= 30 && sim.avgDaily > 0 && sim.totalTrades >= 60) {
        results.push({ ...sim, combo, sortKey });
      }
    }
    console.log(`  [${sortKey}] ${((Date.now()-st)/1000).toFixed(0)}s`);
  }

  console.log(`\n[Phase 1] 완료: ${results.length}개 실행가능 / ${combos.length*2}개 (${((Date.now()-t0)/1000).toFixed(0)}s)`);

  // ── 다양한 기준으로 TOP 추출 ───────────────────────────
  const byCalmar = [...results].sort((a,b) => b.calmar - a.calmar);
  printTable('칼마비율 TOP 25 (수익÷MDD 최적)', byCalmar, 25);

  const bySharpe = [...results].sort((a,b) => b.sharpe - a.sharpe);
  printTable('샤프비율 TOP 25', bySharpe, 25);

  const byReturn = [...results].sort((a,b) => b.avgDaily - a.avgDaily);
  printTable('일평균 수익 TOP 25', byReturn, 25);

  const lowDD = results.filter(r => r.maxDD <= 0.12);
  lowDD.sort((a,b) => b.avgDaily - a.avgDaily);
  printTable(`MDD 12% 이하 수익 TOP 25 (${lowDD.length}개)`, lowDD, 25);

  const vLowDD = results.filter(r => r.maxDD <= 0.08);
  vLowDD.sort((a,b) => b.avgDaily - a.avgDaily);
  printTable(`MDD 8% 이하 수익 TOP 20 (${vLowDD.length}개)`, vLowDD, 20);

  // ── Phase 2: Walk-Forward (TOP 30 후보) ────────────────
  console.log(`\n${'═'.repeat(85)}`);
  console.log('  [Phase 2] Walk-Forward 검증 (과적합 판별)');
  console.log('═'.repeat(85));

  // 후보: 칼마 TOP 15 + 샤프 TOP 10 + 수익 TOP 10 + 저MDD TOP 10 (중복 제거)
  const wfPool = new Map();
  const addCands = (arr, n) => {
    for (const r of arr.slice(0, n)) {
      const key = JSON.stringify(r.combo) + r.sortKey;
      if (!wfPool.has(key)) wfPool.set(key, r);
    }
  };
  addCands(byCalmar, 15);
  addCands(bySharpe, 10);
  addCands(byReturn, 10);
  addCands(lowDD, 10);
  addCands(vLowDD, 10);

  console.log(`  WF 후보: ${wfPool.size}개\n`);

  // 3개 기간 슬라이딩 WF
  const wfPeriods = [
    { train: ['2025-03-17','2025-09-30'], test: ['2025-10-01','2026-01-31'] },
    { train: ['2025-05-01','2025-12-31'], test: ['2026-01-01','2026-03-17'] },
    { train: ['2025-03-17','2025-10-31'], test: ['2025-11-01','2026-03-17'] },
  ];

  console.log('  WF 기간:');
  wfPeriods.forEach((p,i) => console.log(`    ${i+1}. 학습 ${p.train[0]}~${p.train[1]} → 검증 ${p.test[0]}~${p.test[1]}`));

  const wfDataSets = wfPeriods.map(p => ({
    train: loadData(p.train[0], p.train[1]),
    test: loadData(p.test[0], p.test[1]),
  }));

  const wfResults = [];
  for (const [key, r] of wfPool) {
    let sumTrainAvg = 0, sumTestAvg = 0, sumTrainDD = 0, sumTestDD = 0;
    let passCount = 0;

    for (const ds of wfDataSets) {
      const tr = simulate(ds.train.dateMap, ds.train.sortedDates, r.combo, r.sortKey);
      const te = simulate(ds.test.dateMap, ds.test.sortedDates, r.combo, r.sortKey);
      sumTrainAvg += tr.avgDaily;
      sumTestAvg += te.avgDaily;
      sumTrainDD += tr.maxDD;
      sumTestDD += te.maxDD;
      if (te.avgDaily > 0) passCount++;
    }

    const nP = wfPeriods.length;
    const trainAvg = sumTrainAvg / nP, testAvg = sumTestAvg / nP;
    const wfEff = trainAvg > 0 ? testAvg / trainAvg : 0;

    wfResults.push({
      combo: r.combo, sortKey: r.sortKey,
      trainAvg, testAvg,
      trainDD: sumTrainDD / nP, testDD: sumTestDD / nP,
      wfEff, passCount,
      fullPeriod: r,
    });
  }

  // WF 효율 × 검증수익 기준 정렬
  wfResults.sort((a,b) => {
    // 3기간 모두 양수 우선
    if (a.passCount !== b.passCount) return b.passCount - a.passCount;
    // WF 효율
    return b.testAvg - a.testAvg;
  });

  console.log(`\n  ${'#'.padStart(3)} ${'학습'.padStart(7)} ${'검증'.padStart(7)} ${'WF효율'.padStart(7)} ${'학MDD'.padStart(6)} ${'검MDD'.padStart(6)} ${'통과'.padStart(4)} ${'판정'.padEnd(8)} | 필터`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(4)} ${'─'.repeat(8)} + ${'─'.repeat(40)}`);

  for (let i = 0; i < wfResults.length; i++) {
    const r = wfResults[i];
    const verdict = r.passCount === 3 && r.wfEff >= 0.5 ? '✅ PASS' :
                    r.passCount >= 2 && r.testAvg > 0 ? '⚠️ 주의' : '❌ FAIL';
    console.log(`  ${String(i+1).padStart(3)} ${(r.trainAvg*100).toFixed(2).padStart(6)}% ${(r.testAvg*100).toFixed(2).padStart(6)}% ${r.wfEff.toFixed(2).padStart(7)} ${(r.trainDD*100).toFixed(1).padStart(5)}% ${(r.testDD*100).toFixed(1).padStart(5)}% ${(r.passCount+'/3').padStart(4)} ${verdict} | ${fmtCombo(r.combo)}${r.sortKey!=='changeRate'?' ['+r.sortKey+']':''}`);
  }

  // ── Phase 3: 최종 추천 ────────────────────────────────
  const passed = wfResults.filter(r => r.passCount >= 2 && r.testAvg > 0);
  passed.sort((a,b) => b.testAvg - a.testAvg);

  console.log(`\n${'═'.repeat(85)}`);
  console.log(`  [Phase 3] 최종 추천 (WF 통과 ${passed.length}개 중 TOP 5)`);
  console.log('═'.repeat(85));

  for (let i = 0; i < Math.min(5, passed.length); i++) {
    const r = passed[i];
    const fp = r.fullPeriod;
    const fin = fp.capital >= 1e12 ? (fp.capital/1e12).toFixed(0)+'조' :
                fp.capital >= 1e8 ? (fp.capital/1e8).toFixed(1)+'억' :
                (fp.capital/1e4).toFixed(0)+'만';
    const ann = (Math.pow(1+fp.avgDaily,250)-1)*100;

    console.log(`\n  🏆 ${i+1}위`);
    console.log(`  ┌──────────────────────────────────────────────────────┐`);
    console.log(`  │ 필터: ${fmtCombo(r.combo)}`.padEnd(57) + '│');
    if (r.sortKey !== 'changeRate') console.log(`  │ 정렬: ${r.sortKey}`.padEnd(57) + '│');
    console.log(`  │──────────────────────────────────────────────────────│`);
    console.log(`  │ 전체기간: 일평균 +${(fp.avgDaily*100).toFixed(2)}%  연환산 +${ann.toFixed(0)}%`.padEnd(57) + '│');
    console.log(`  │           승률 ${(fp.winRate*100).toFixed(1)}%  MDD ${(fp.maxDD*100).toFixed(1)}%  샤프 ${fp.sharpe.toFixed(1)}`.padEnd(57) + '│');
    console.log(`  │           500만→${fin}  거래일 ${fp.tradeDays}일  종목/일 ${fp.avgStocks.toFixed(1)}`.padEnd(57) + '│');
    console.log(`  │──────────────────────────────────────────────────────│`);
    console.log(`  │ WF 검증: 학습 +${(r.trainAvg*100).toFixed(2)}%  검증 +${(r.testAvg*100).toFixed(2)}%  효율 ${(r.wfEff*100).toFixed(0)}%`.padEnd(57) + '│');
    console.log(`  │          ${r.passCount}/3 기간 통과${r.passCount===3 ? ' ✅ 과적합 아님' : ' ⚠️'}`.padEnd(57) + '│');
    console.log(`  └──────────────────────────────────────────────────────┘`);

    const c = r.combo;
    console.log(`  상세 필터 조건:`);
    if (c.minVolPrice > 0) console.log(`    • 거래대금 ≥ ${(c.minVolPrice/1e8).toFixed(0)}억원`);
    if (c.minChangeRate > -1) console.log(`    • 등락률   ≥ ${(c.minChangeRate*100).toFixed(0)}%`);
    if (c.minAtrPct > 0) console.log(`    • ATR%     ≥ ${(c.minAtrPct*100).toFixed(0)}%`);
    if (c.minUpperWick > 0) console.log(`    • 윗꼬리   ≥ ${(c.minUpperWick*100).toFixed(0)}%`);
    if (c.minGapUp > -1) console.log(`    • 갭상승   ≥ ${(c.minGapUp*100).toFixed(1)}%`);
    if (c.minVolRatio5 > 0) console.log(`    • 거래량/5일 ≥ ${c.minVolRatio5.toFixed(1)}배`);
    if (c.maxLowerWick < 1) console.log(`    • 아래꼬리 ≤ ${(c.maxLowerWick*100).toFixed(0)}%`);
    console.log(`    • 선택: 상위 ${MAX_STOCKS}개 (${r.sortKey}순)`);
  }

  // 저장
  const savePath = path.join(__dirname, '..', 'results', 'optimal-filter.json');
  fs.writeFileSync(savePath, JSON.stringify({
    meta: { combos: combos.length, viable: results.length, wfCandidates: wfPool.size },
    calmar_top25: byCalmar.slice(0,25).map(r => ({combo:r.combo,sortKey:r.sortKey,avgDaily:+r.avgDaily.toFixed(6),winRate:+r.winRate.toFixed(4),maxDD:+r.maxDD.toFixed(4),sharpe:+r.sharpe.toFixed(2),calmar:+r.calmar.toFixed(2),capital:Math.round(r.capital),tradeDays:r.tradeDays})),
    walkForward: wfResults.map(r => ({combo:r.combo,sortKey:r.sortKey,trainAvg:+r.trainAvg.toFixed(6),testAvg:+r.testAvg.toFixed(6),wfEff:+r.wfEff.toFixed(3),passCount:r.passCount})),
    recommended: passed.slice(0,5).map(r => ({combo:r.combo,sortKey:r.sortKey,testAvg:+r.testAvg.toFixed(6),wfEff:+r.wfEff.toFixed(3),passCount:r.passCount,fullAvgDaily:+r.fullPeriod.avgDaily.toFixed(6),fullMDD:+r.fullPeriod.maxDD.toFixed(4)})),
  }, null, 2));
  console.log(`\n💾 ${savePath}`);
}

main();
