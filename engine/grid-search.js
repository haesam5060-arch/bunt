/**
 * 번트 Step 3: 그리드서치 — 최적 필터 조합 탐색 (최적화 버전)
 * ──────────────────────────────────────────────────────────────
 * 핵심 최적화: 날짜별로 모든 종목 바를 사전 인덱싱.
 * 조합별 시뮬레이션 시 종목 루프 불필요 → 필터만 적용.
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');

const COMMISSION = 0.00015;
const TAX = 0.0018;
const SLIPPAGE = 0.001;
const TOTAL_COST = COMMISSION * 2 + TAX + SLIPPAGE; // 0.231%

const MIN_STOCKS = 2;
const MAX_STOCKS = 10;
const INIT_CAPITAL = 5000000;

// ── 보조 ──────────────────────────────────────────────────────
function sma(arr, n) {
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function calcRSI(closes, period = 14) {
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

// ── 데이터 로드 → 날짜별 인덱스 (핵심 최적화) ────────────────
function loadAndIndex() {
  const kosdaqCodes = new Set(JSON.parse(fs.readFileSync(KOSDAQ_FILE, 'utf8')));
  const files = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.json') && kosdaqCodes.has(f.replace('.json', '')));

  console.log(`[DATA] ${files.length}개 코스닥 OHLCV 로딩...`);
  const t0 = Date.now();

  // dateMap: { date: [ { ...bar indicators, overnight } ] }
  const dateMap = {};
  let loaded = 0, totalBars = 0;

  for (const file of files) {
    const code = file.replace('.json', '');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, file), 'utf8'));
      if (!Array.isArray(data) || data.length < 65) continue;
    } catch { continue; }
    loaded++;

    for (let i = 60; i < data.length - 1; i++) {
      const d = data[i], prev = data[i - 1], next = data[i + 1];
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) continue;
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;

      const changeRate = (d.close - prev.close) / prev.close;
      if (changeRate >= 0.29 || changeRate <= -0.29) continue;

      const range = d.high - d.low;
      const overnight = (next.open - d.close) / d.close;

      // 거래량 비율
      let v5 = 0;
      for (let j = i - 5; j < i; j++) v5 += data[j].volume;
      const volRatio5 = (v5 / 5) > 0 ? d.volume / (v5 / 5) : 0;

      // MA5
      let c5sum = 0;
      for (let j = i - 4; j <= i; j++) c5sum += data[j].close;
      const ma5 = c5sum / 5;

      // 연속 상승
      let consec = 0;
      for (let j = i; j > i - 10 && j > 0; j--) {
        if (data[j].close > data[j - 1].close) consec++;
        else break;
      }

      const bar = {
        overnight,
        changeRate,
        volPrice: d.volume * d.close,
        volRatio5,
        consecUp: consec,
        lowerWick: range > 0 ? (Math.min(d.close, d.open) - d.low) / range : 0,
        gapUp: (d.open - prev.close) / prev.close,
        ma5Dist: (d.close - ma5) / ma5,
      };

      if (!dateMap[d.date]) dateMap[d.date] = [];
      dateMap[d.date].push(bar);
      totalBars++;
    }
  }

  const sortedDates = Object.keys(dateMap).sort();
  console.log(`[DATA] ${loaded}개 종목, ${sortedDates.length}거래일, ${totalBars.toLocaleString()}바 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  return { dateMap, sortedDates };
}

// ── 단일 조합 시뮬레이션 (최적화: dateMap 직접 순회) ─────────
function simulate(dateMap, sortedDates, combo) {
  const { minVolPrice, minConsecUp, maxLowerWick, minChangeRate, maxChangeRate, minGapUp, minMa5Dist } = combo;

  let capital = INIT_CAPITAL;
  let totalTrades = 0, wins = 0;
  let tradingDays = 0;
  let maxCapital = INIT_CAPITAL, maxDD = 0;
  let returnSum = 0;
  let returnSqSum = 0;

  for (let di = 0; di < sortedDates.length; di++) {
    const bars = dateMap[sortedDates[di]];

    // 빠른 필터 (인라인)
    const candidates = [];
    for (let bi = 0; bi < bars.length; bi++) {
      const b = bars[bi];
      if (b.volPrice < minVolPrice) continue;
      if (b.consecUp < minConsecUp) continue;
      if (b.lowerWick > maxLowerWick) continue;
      if (b.changeRate < minChangeRate) continue;
      if (b.changeRate > maxChangeRate) continue;
      if (b.gapUp < minGapUp) continue;
      if (b.ma5Dist < minMa5Dist) continue;
      candidates.push(b);
    }

    if (candidates.length < MIN_STOCKS) continue;

    tradingDays++;

    // 등락률 상위 정렬 → 최대 MAX_STOCKS
    if (candidates.length > MAX_STOCKS) {
      candidates.sort((a, b) => b.changeRate - a.changeRate);
      candidates.length = MAX_STOCKS;
    }

    const n = candidates.length;
    let dayReturn = 0;

    for (let ci = 0; ci < n; ci++) {
      const net = candidates[ci].overnight - TOTAL_COST;
      dayReturn += net / n;
      totalTrades++;
      if (net > 0) wins++;
    }

    capital *= (1 + dayReturn);
    returnSum += dayReturn;
    returnSqSum += dayReturn * dayReturn;

    if (capital > maxCapital) maxCapital = capital;
    const dd = (maxCapital - capital) / maxCapital;
    if (dd > maxDD) maxDD = dd;
  }

  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const avgDaily = tradingDays > 0 ? returnSum / tradingDays : 0;
  const variance = tradingDays > 1 ? (returnSqSum / tradingDays - avgDaily * avgDaily) : 0;
  const std = Math.sqrt(Math.max(0, variance));
  const sharpe = std > 0 ? (avgDaily / std) * Math.sqrt(250) : 0;

  return { totalTrades, tradingDays, winRate, avgDaily, finalCapital: capital, maxDD, sharpe, avgStocksPerDay: tradingDays > 0 ? totalTrades / tradingDays : 0 };
}

// ── 그리드 생성 ──────────────────────────────────────────────
function generateCombos() {
  const defs = {
    minVolPrice:   [5e8, 10e8, 20e8, 50e8, 100e8],
    minConsecUp:   [0, 1, 2, 3],
    maxLowerWick:  [1.0, 0.3, 0.2, 0.1],
    minChangeRate: [0, 0.01, 0.02, 0.03, 0.05],
    maxChangeRate: [0.29, 0.15, 0.10],
    minGapUp:      [-1, 0, 0.005, 0.01],
    minMa5Dist:    [-1, 0, 0.01, 0.02],
  };

  const keys = Object.keys(defs);
  const combos = [];
  function gen(idx, cur) {
    if (idx === keys.length) { combos.push({ ...cur }); return; }
    for (const v of defs[keys[idx]]) { cur[keys[idx]] = v; gen(idx + 1, cur); }
  }
  gen(0, {});
  return combos;
}

// ── 메인 ──────────────────────────────────────────────────────
function main() {
  console.log('═'.repeat(70));
  console.log('  번트 Step 3: 그리드서치 (최적화 버전)');
  console.log('═'.repeat(70));

  const { dateMap, sortedDates } = loadAndIndex();
  const combos = generateCombos();
  console.log(`[GRID] ${combos.length.toLocaleString()}개 조합 시뮬레이션 시작...\n`);

  const t0 = Date.now();
  const results = [];

  for (let ci = 0; ci < combos.length; ci++) {
    const sim = simulate(dateMap, sortedDates, combos[ci]);
    results.push({ combo: combos[ci], ...sim });

    if ((ci + 1) % 2000 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${ci + 1}/${combos.length}] ${el}s (${((ci + 1) / parseFloat(el)).toFixed(0)}/s)`);
    }
  }

  const totalEl = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[GRID] 완료: ${combos.length.toLocaleString()}개 (${totalEl}s)`);

  // ── 필터 ───────────────────────────────────────────────
  const viable = results.filter(r =>
    r.tradingDays >= 50 &&
    r.totalTrades >= 100 &&
    r.winRate >= 0.48 &&
    r.avgDaily > 0
  );
  console.log(`[GRID] 실행 가능 조합: ${viable.length}개 / ${results.length}개`);

  // ── TOP 20 (샤프비율) ──────────────────────────────────
  viable.sort((a, b) => b.sharpe - a.sharpe);

  function fmtCombo(c) {
    return [
      `거래대금≥${(c.minVolPrice / 1e8).toFixed(0)}억`,
      c.minConsecUp > 0 ? `연상${c.minConsecUp}+` : null,
      c.maxLowerWick < 1 ? `아꼬≤${(c.maxLowerWick * 100).toFixed(0)}%` : null,
      c.minChangeRate > 0 ? `등락≥${(c.minChangeRate * 100).toFixed(0)}%` : null,
      c.maxChangeRate < 0.29 ? `등락≤${(c.maxChangeRate * 100).toFixed(0)}%` : null,
      c.minGapUp > -1 ? `갭≥${(c.minGapUp * 100).toFixed(1)}%` : null,
      c.minMa5Dist > -1 ? `MA5↑${(c.minMa5Dist * 100).toFixed(0)}%` : null,
    ].filter(Boolean).join(' ');
  }

  function printTable(label, arr, limit = 20) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${label}`);
    console.log('═'.repeat(70));
    if (arr.length === 0) { console.log('  ⚠️ 해당 조합 없음'); return; }
    console.log(`  ${'#'.padStart(3)} ${'승률'.padStart(6)} ${'일평균'.padStart(8)} ${'500만→'.padStart(10)} ${'MDD'.padStart(6)} ${'샤프'.padStart(6)} ${'거래일'.padStart(6)} ${'종/일'.padStart(5)} | 필터`);
    console.log(`  ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(5)} + ${'─'.repeat(35)}`);
    for (let i = 0; i < Math.min(limit, arr.length); i++) {
      const r = arr[i];
      const fin = r.finalCapital >= 1e8 ? (r.finalCapital / 1e8).toFixed(1) + '억' :
                  r.finalCapital >= 1e6 ? (r.finalCapital / 1e4).toFixed(0) + '만' :
                  (r.finalCapital / 1e4).toFixed(1) + '만';
      console.log(`  ${String(i + 1).padStart(3)} ${(r.winRate * 100).toFixed(1).padStart(5)}% ${(r.avgDaily * 100).toFixed(2).padStart(7)}% ${fin.padStart(10)} ${(r.maxDD * 100).toFixed(1).padStart(5)}% ${r.sharpe.toFixed(2).padStart(6)} ${String(r.tradingDays).padStart(6)} ${r.avgStocksPerDay.toFixed(1).padStart(5)} | ${fmtCombo(r.combo)}`);
    }
  }

  printTable('TOP 20 (샤프비율 순)', viable.slice(0, 20));

  // 승률 55%+
  const wr55 = viable.filter(r => r.winRate >= 0.55);
  wr55.sort((a, b) => b.avgDaily - a.avgDaily);
  printTable(`승률 55%+ (${wr55.length}개, 일평균수익 순)`, wr55);

  // 승률 60%+
  const wr60 = viable.filter(r => r.winRate >= 0.60);
  wr60.sort((a, b) => b.avgDaily - a.avgDaily);
  printTable(`승률 60%+ (${wr60.length}개, 일평균수익 순)`, wr60);

  // 밸런스 스코어
  const balanced = viable.filter(r => r.maxDD > 0.001).map(r => ({
    ...r, score: r.avgDaily * r.winRate / r.maxDD
  }));
  balanced.sort((a, b) => b.score - a.score);
  printTable('밸런스 TOP 10 (수익×승률/MDD)', balanced, 10);

  // ── BEST 조합 상세 ─────────────────────────────────────
  if (viable.length > 0) {
    // 종합 1위: 밸런스 기준
    const best = balanced[0] || viable[0];
    const c = best.combo;
    console.log(`\n${'═'.repeat(70)}`);
    console.log('  BEST 조합 상세');
    console.log('═'.repeat(70));
    console.log(`  필터 조건:`);
    console.log(`    거래대금 ≥ ${(c.minVolPrice / 1e8).toFixed(0)}억`);
    console.log(`    연속상승 ≥ ${c.minConsecUp}일`);
    console.log(`    아래꼬리 ≤ ${(c.maxLowerWick * 100).toFixed(0)}%`);
    console.log(`    등락률   : ${(c.minChangeRate * 100).toFixed(0)}% ~ ${(c.maxChangeRate * 100).toFixed(0)}%`);
    console.log(`    갭상승   ≥ ${(c.minGapUp * 100).toFixed(1)}%`);
    console.log(`    MA5 거리 ≥ ${(c.minMa5Dist * 100).toFixed(0)}%`);
    console.log(`\n  성과 (${sortedDates[0]} ~ ${sortedDates[sortedDates.length - 1]}):`);
    console.log(`    총 거래일   : ${best.tradingDays}일 / ${sortedDates.length}일`);
    console.log(`    총 거래건수 : ${best.totalTrades}건`);
    console.log(`    일평균 종목 : ${best.avgStocksPerDay.toFixed(1)}개`);
    console.log(`    승률        : ${(best.winRate * 100).toFixed(1)}%`);
    console.log(`    일평균 수익 : ${(best.avgDaily * 100).toFixed(3)}%`);
    console.log(`    연환산 수익 : ${((Math.pow(1 + best.avgDaily, 250) - 1) * 100).toFixed(1)}%`);
    console.log(`    최대낙폭    : ${(best.maxDD * 100).toFixed(1)}%`);
    console.log(`    샤프비율    : ${best.sharpe.toFixed(2)}`);
    const finalStr = best.finalCapital >= 1e8 ? (best.finalCapital / 1e8).toFixed(2) + '억' : (best.finalCapital / 1e4).toFixed(0) + '만';
    console.log(`    500만 → ${finalStr}원 (${((best.finalCapital / INIT_CAPITAL - 1) * 100).toFixed(0)}%)`);
  }

  // ── 저장 ───────────────────────────────────────────────
  const savePath = path.join(__dirname, '..', 'results', 'grid-search.json');
  fs.writeFileSync(savePath, JSON.stringify({
    meta: { totalCombos: combos.length, viable: viable.length, costs: TOTAL_COST, period: `${sortedDates[0]}~${sortedDates[sortedDates.length - 1]}` },
    top20_sharpe: viable.slice(0, 20).map(r => ({ combo: r.combo, winRate: +r.winRate.toFixed(4), avgDaily: +r.avgDaily.toFixed(6), maxDD: +r.maxDD.toFixed(4), sharpe: +r.sharpe.toFixed(2), tradingDays: r.tradingDays, totalTrades: r.totalTrades, finalCapital: Math.round(r.finalCapital), avgStocksPerDay: +r.avgStocksPerDay.toFixed(1) })),
    top20_wr55: wr55.slice(0, 20).map(r => ({ combo: r.combo, winRate: +r.winRate.toFixed(4), avgDaily: +r.avgDaily.toFixed(6), maxDD: +r.maxDD.toFixed(4), sharpe: +r.sharpe.toFixed(2), tradingDays: r.tradingDays, totalTrades: r.totalTrades, finalCapital: Math.round(r.finalCapital), avgStocksPerDay: +r.avgStocksPerDay.toFixed(1) })),
    top10_balanced: balanced.slice(0, 10).map(r => ({ combo: r.combo, winRate: +r.winRate.toFixed(4), avgDaily: +r.avgDaily.toFixed(6), maxDD: +r.maxDD.toFixed(4), sharpe: +r.sharpe.toFixed(2), tradingDays: r.tradingDays, totalTrades: r.totalTrades, finalCapital: Math.round(r.finalCapital), avgStocksPerDay: +r.avgStocksPerDay.toFixed(1), score: +r.score.toFixed(6) })),
  }, null, 2));
  console.log(`\n💾 결과 저장: ${savePath}`);
}

main();
