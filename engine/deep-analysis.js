/**
 * 번트: 딥 분석 — "평균 수익률"을 극대화하는 필터 탐색
 * ──────────────────────────────────────────────────────
 * 이전 분석의 실수:
 *   1. 승률(win rate)에 집착 → 수익률 분포/크기 무시
 *   2. 상한가 종목 제외 → 핵심 수익원 누락
 *
 * 이번 분석:
 *   - 상한가 포함 (동시호가 매수 가능)
 *   - IC(정보계수): 변수와 overnight return의 상관계수
 *   - 5분위 평균 수익률 (승률 아닌 수익률 기준)
 *   - 실제 포트폴리오 시뮬레이션 (5~10종목, 복리)
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');

const COST = 0.0118; // 1.18% (한투 수수료 0.5%×2 + 매도세 0.18%)
const DATE_FROM = '2025-03-17';
const DATE_TO = '2026-03-17';

function loadData() {
  const kosdaqCodes = new Set(JSON.parse(fs.readFileSync(KOSDAQ_FILE, 'utf8')));
  const files = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.json') && kosdaqCodes.has(f.replace('.json', '')));

  console.log(`[DATA] ${files.length}개 코스닥 종목 (상한가 포함, ${DATE_FROM}~${DATE_TO})...\n`);

  // 날짜별 인덱스: { date: [{features, overnight, code}] }
  const dateMap = {};
  let total = 0;

  for (const file of files) {
    const code = file.replace('.json', '');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, file), 'utf8'));
      if (!Array.isArray(data) || data.length < 65) continue;
    } catch { continue; }

    for (let i = 60; i < data.length - 1; i++) {
      const d = data[i], prev = data[i - 1], next = data[i + 1];
      if (!d.date || d.date < DATE_FROM || d.date > DATE_TO) continue;
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) continue;
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;

      const changeRate = (d.close - prev.close) / prev.close;
      const overnight = (next.open - d.close) / d.close;
      const range = d.high - d.low;

      // 거래량 관련
      let v5 = 0, v10 = 0, v20 = 0;
      for (let j = i - 5; j < i; j++) v5 += (data[j]?.volume || 0);
      for (let j = i - 10; j < i; j++) v10 += (data[j]?.volume || 0);
      for (let j = i - 20; j < i; j++) v20 += (data[j]?.volume || 0);

      // MA
      let c5 = 0, c10 = 0, c20 = 0, c60 = 0;
      for (let j = i - 4; j <= i; j++) c5 += data[j].close;
      for (let j = i - 9; j <= i; j++) c10 += data[j].close;
      for (let j = i - 19; j <= i; j++) c20 += data[j].close;
      for (let j = i - 59; j <= i; j++) c60 += data[j].close;
      const ma5 = c5 / 5, ma10 = c10 / 10, ma20 = c20 / 20, ma60 = c60 / 60;

      // RSI
      let gain = 0, loss = 0;
      for (let j = i - 13; j <= i; j++) {
        const diff = data[j].close - data[j - 1].close;
        if (diff > 0) gain += diff; else loss += Math.abs(diff);
      }
      const ag = gain / 14, al = loss / 14;
      const rsi14 = al === 0 ? 100 : 100 - (100 / (1 + ag / al));

      // ATR
      let atrSum = 0;
      for (let j = i - 13; j <= i; j++) {
        const h = data[j].high, l = data[j].low, pc = data[j - 1].close;
        atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const atr14 = atrSum / 14;

      // 연속 상승
      let consecUp = 0;
      for (let j = i; j > 0 && j > i - 20; j--) {
        if (data[j].close > data[j - 1].close) consecUp++;
        else break;
      }

      // N일 수익률
      const ret3d = data[i - 3]?.close > 0 ? (d.close - data[i - 3].close) / data[i - 3].close : 0;
      const ret5d = data[i - 5]?.close > 0 ? (d.close - data[i - 5].close) / data[i - 5].close : 0;

      // 20일 고저
      let high20 = 0, low20 = Infinity;
      for (let j = i - 19; j <= i; j++) {
        if (data[j].high > high20) high20 = data[j].high;
        if (data[j].low < low20) low20 = data[j].low;
      }

      // 상한가 여부
      const isLimitUp = changeRate >= 0.29;

      const avgV5 = v5 / 5, avgV20 = v20 / 20;

      const features = {
        // 당일 캔들
        changeRate,
        absChangeRate: Math.abs(changeRate),
        isPositive: changeRate > 0 ? 1 : 0,
        bodyRatio: range > 0 ? (d.close - d.open) / range : 0,
        upperWick: range > 0 ? (d.high - Math.max(d.close, d.open)) / range : 0,
        lowerWick: range > 0 ? (Math.min(d.close, d.open) - d.low) / range : 0,
        closeVsHigh: d.high > 0 ? d.close / d.high : 0,
        rangePct: d.close > 0 ? range / d.close : 0,
        gapUp: (d.open - prev.close) / prev.close,

        // 거래량
        volRatio5: avgV5 > 0 ? d.volume / avgV5 : 0,
        volRatio20: avgV20 > 0 ? d.volume / avgV20 : 0,
        volPrice: d.volume * d.close,
        logVolPrice: Math.log10(Math.max(1, d.volume * d.close)),

        // MA 위치
        ma5Dist: ma5 > 0 ? (d.close - ma5) / ma5 : 0,
        ma20Dist: ma20 > 0 ? (d.close - ma20) / ma20 : 0,
        ma60Dist: ma60 > 0 ? (d.close - ma60) / ma60 : 0,
        ma5Above20: ma5 > ma20 ? 1 : 0,

        // 보조지표
        rsi14,
        atrPct: d.close > 0 ? atr14 / d.close : 0,

        // 모멘텀
        consecUp,
        ret3d,
        ret5d,

        // 위치
        highDist20: high20 > 0 ? (d.close - high20) / high20 : 0,
        lowDist20: low20 > 0 ? (d.close - low20) / low20 : 0,

        // 상한가
        isLimitUp: isLimitUp ? 1 : 0,

        // 복합 (사장님 원래 필터 요소)
        closeEqHigh: d.close >= d.high * 0.98 ? 1 : 0,  // 종가=고가 (2% 이내)
        strongUp5pct: changeRate >= 0.05 ? 1 : 0,        // 5% 이상 상승
        volSpike1_5: (avgV5 > 0 && d.volume >= avgV5 * 1.5) ? 1 : 0,  // 거래량 1.5배+
      };

      if (!dateMap[d.date]) dateMap[d.date] = [];
      dateMap[d.date].push({ features, overnight, code });
      total++;
    }
  }

  const sortedDates = Object.keys(dateMap).sort();
  console.log(`[DATA] ${total.toLocaleString()}건 로드 (${sortedDates.length}거래일)\n`);
  return { dateMap, sortedDates, total };
}

// ── IC 분석 (변수 vs overnight return 상관계수) ──────────────
function icAnalysis(dateMap, sortedDates) {
  // 날짜별 IC 계산 후 평균 (Fama-MacBeth 스타일)
  const featureNames = Object.keys(Object.values(dateMap)[0][0].features);
  const icResults = {};
  for (const feat of featureNames) icResults[feat] = { ics: [], avgReturns: {} };

  for (const date of sortedDates) {
    const bars = dateMap[date];
    if (bars.length < 30) continue;

    for (const feat of featureNames) {
      const pairs = bars
        .filter(b => isFinite(b.features[feat]) && isFinite(b.overnight))
        .map(b => [b.features[feat], b.overnight]);

      if (pairs.length < 20) continue;

      // Spearman rank correlation (more robust)
      const ranked = pairs.map(([x, y]) => [x, y]).sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < ranked.length; i++) ranked[i].push(i + 1); // x rank
      ranked.sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < ranked.length; i++) ranked[i].push(i + 1); // y rank

      const n = ranked.length;
      let d2sum = 0;
      for (const r of ranked) d2sum += (r[2] - r[3]) ** 2;
      const rho = 1 - (6 * d2sum) / (n * (n * n - 1));

      icResults[feat].ics.push(rho);
    }
  }

  // 집계
  const results = [];
  for (const feat of featureNames) {
    const ics = icResults[feat].ics;
    if (ics.length < 30) continue;

    const meanIC = ics.reduce((a, b) => a + b, 0) / ics.length;
    const icStd = Math.sqrt(ics.reduce((s, v) => s + (v - meanIC) ** 2, 0) / ics.length);
    const icIR = icStd > 0 ? meanIC / icStd : 0;  // IC_IR: IC의 안정성
    const hitRate = ics.filter(ic => ic > 0).length / ics.length; // IC가 양수인 비율

    results.push({ feature: feat, meanIC, icStd, icIR, hitRate, nDays: ics.length });
  }

  results.sort((a, b) => Math.abs(b.meanIC) - Math.abs(a.meanIC));
  return results;
}

// ── 5분위 수익률 분석 ────────────────────────────────────────
function quintileReturns(dateMap, sortedDates) {
  const featureNames = Object.keys(Object.values(dateMap)[0][0].features);
  const results = {};

  // 모든 데이터 flat
  const allBars = [];
  for (const date of sortedDates) {
    for (const bar of dateMap[date]) allBars.push(bar);
  }

  for (const feat of featureNames) {
    const valid = allBars.filter(b => isFinite(b.features[feat]) && isFinite(b.overnight));
    valid.sort((a, b) => a.features[feat] - b.features[feat]);

    const qSize = Math.floor(valid.length / 5);
    const quintiles = [];

    for (let q = 0; q < 5; q++) {
      const slice = valid.slice(q * qSize, q === 4 ? valid.length : (q + 1) * qSize);
      const avgReturn = slice.reduce((s, b) => s + b.overnight, 0) / slice.length;
      const avgNetReturn = avgReturn - COST;
      const winRate = slice.filter(b => b.overnight > COST).length / slice.length;
      const minV = slice[0].features[feat];
      const maxV = slice[slice.length - 1].features[feat];

      // 평균 이익/손실 크기 분리
      const wins = slice.filter(b => b.overnight > COST);
      const losses = slice.filter(b => b.overnight <= COST);
      const avgWin = wins.length > 0 ? wins.reduce((s, b) => s + b.overnight, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s, b) => s + b.overnight, 0) / losses.length : 0;

      quintiles.push({ q: q + 1, avgReturn, avgNetReturn, winRate, count: slice.length, minV, maxV, avgWin, avgLoss });
    }

    // Q5 - Q1 스프레드
    const spread = quintiles[4].avgReturn - quintiles[0].avgReturn;
    results[feat] = { quintiles, spread };
  }

  return results;
}

// ── 조합별 포트폴리오 시뮬레이션 (복리) ─────────────────────
function portfolioSim(dateMap, sortedDates, filterFn, label, topN = 10) {
  let capital = 5000000;
  let totalDays = 0, tradeDays = 0;
  let dailyReturns = [];
  let maxCap = capital, maxDD = 0;
  let totalTrades = 0, winTrades = 0;
  let monthlyReturns = {};

  for (const date of sortedDates) {
    totalDays++;
    const bars = dateMap[date];

    // 필터 적용
    const candidates = bars.filter(b => filterFn(b.features));
    if (candidates.length < 2) { dailyReturns.push(0); continue; }

    tradeDays++;

    // 상위 N개 선택 (등락률 순)
    candidates.sort((a, b) => b.features.changeRate - a.features.changeRate);
    const selected = candidates.slice(0, topN);
    const n = selected.length;

    let dayReturn = 0;
    for (const s of selected) {
      const net = s.overnight - COST;
      dayReturn += net / n;
      totalTrades++;
      if (net > 0) winTrades++;
    }

    dailyReturns.push(dayReturn);
    capital *= (1 + dayReturn);

    if (capital > maxCap) maxCap = capital;
    const dd = (maxCap - capital) / maxCap;
    if (dd > maxDD) maxDD = dd;

    // 월별
    const month = date.substring(0, 7);
    if (!monthlyReturns[month]) monthlyReturns[month] = [];
    monthlyReturns[month].push(dayReturn);
  }

  const avgDaily = tradeDays > 0 ? dailyReturns.filter(r => r !== 0).reduce((a, b) => a + b, 0) / tradeDays : 0;
  const winRate = totalTrades > 0 ? winTrades / totalTrades : 0;

  // 월별 수익률
  const months = Object.keys(monthlyReturns).sort();
  const monthlyStats = months.map(m => {
    const rets = monthlyReturns[m];
    const monthRet = rets.reduce((p, r) => p * (1 + r), 1) - 1;
    const trades = rets.filter(r => r !== 0).length;
    return { month: m, return: monthRet, tradeDays: trades };
  });

  return { label, capital, avgDaily, winRate, maxDD, tradeDays, totalDays, totalTrades, avgStocksPerDay: tradeDays > 0 ? totalTrades / tradeDays : 0, monthlyStats };
}

// ── 메인 ──────────────────────────────────────────────────────
function main() {
  console.log('═'.repeat(70));
  console.log('  번트 딥 분석: 수익률 극대화 필터 탐색');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO} | 상한가 포함 | 복리 시뮬`);
  console.log('═'.repeat(70));

  const { dateMap, sortedDates, total } = loadData();

  // ── 1. IC 분석 ──────────────────────────────────────────
  console.log('═'.repeat(70));
  console.log('  [1] IC 분석 (변수 → 수익률 예측력)');
  console.log('═'.repeat(70));

  const icResults = icAnalysis(dateMap, sortedDates);

  console.log(`  ${'#'.padStart(3)} ${'변수'.padEnd(18)} ${'평균IC'.padStart(8)} ${'IC_IR'.padStart(6)} ${'IC양수율'.padStart(7)} ${'방향'.padEnd(12)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(12)}`);

  for (let i = 0; i < icResults.length; i++) {
    const r = icResults[i];
    const dir = r.meanIC > 0 ? '▲ 높을수록 유리' : '▼ 낮을수록 유리';
    const star = Math.abs(r.meanIC) >= 0.03 ? ' ★★★' : Math.abs(r.meanIC) >= 0.02 ? ' ★★' : Math.abs(r.meanIC) >= 0.01 ? ' ★' : '';
    console.log(`  ${String(i + 1).padStart(3)} ${r.feature.padEnd(18)} ${r.meanIC.toFixed(4).padStart(8)} ${r.icIR.toFixed(2).padStart(6)} ${(r.hitRate * 100).toFixed(0).padStart(6)}% ${dir}${star}`);
  }

  // ── 2. 5분위 수익률 ────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  [2] 주요 변수 5분위 평균 수익률 (비용 차감 전)');
  console.log('═'.repeat(70));

  const qResults = quintileReturns(dateMap, sortedDates);

  // IC 상위 10개 변수만 상세 출력
  const topFeatures = icResults.slice(0, 12).map(r => r.feature);

  for (const feat of topFeatures) {
    const qr = qResults[feat];
    if (!qr) continue;

    const icR = icResults.find(r => r.feature === feat);
    console.log(`\n  📊 ${feat} (IC=${icR.meanIC.toFixed(4)}, 스프레드=${(qr.spread * 100).toFixed(2)}%)`);
    console.log(`  ${'분위'.padEnd(4)} ${'범위'.padEnd(26)} ${'평균수익'.padStart(8)} ${'순수익'.padStart(8)} ${'승률'.padStart(6)} ${'평균이익'.padStart(8)} ${'평균손실'.padStart(8)} ${'바'.padStart(2)}`);
    console.log(`  ${'─'.repeat(4)} ${'─'.repeat(26)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(20)}`);

    for (const q of qr.quintiles) {
      const bar = q.avgReturn > 0
        ? '█'.repeat(Math.min(30, Math.round(q.avgReturn * 500)))
        : '▒'.repeat(Math.min(30, Math.round(Math.abs(q.avgReturn) * 500)));
      const sign = q.avgNetReturn > 0 ? '+' : '';
      const rangeStr = `${q.minV >= 100 ? q.minV.toFixed(0) : q.minV.toFixed(4)} ~ ${q.maxV >= 100 ? q.maxV.toFixed(0) : q.maxV.toFixed(4)}`;
      console.log(`  Q${q.q}   ${rangeStr.padEnd(26)} ${(q.avgReturn * 100).toFixed(2).padStart(7)}% ${(sign + (q.avgNetReturn * 100).toFixed(2)).padStart(7)}% ${(q.winRate * 100).toFixed(1).padStart(5)}% ${(q.avgWin * 100).toFixed(2).padStart(7)}% ${(q.avgLoss * 100).toFixed(2).padStart(7)}% ${bar}`);
    }
  }

  // ── 3. 포트폴리오 시뮬레이션 ───────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  [3] 필터별 포트폴리오 시뮬레이션 (원금 500만, 복리)');
  console.log('═'.repeat(70));

  const strategies = [
    {
      label: '기본: 등락률 5%+',
      filter: f => f.changeRate >= 0.05,
    },
    {
      label: '사장님 원래 필터 (거래량1.5x+등락5%+종가=고가+거래대금5억+)',
      filter: f => f.volSpike1_5 && f.strongUp5pct && f.closeEqHigh && f.volPrice >= 5e8,
    },
    {
      label: '거래대금 100억+ & 등락5%+',
      filter: f => f.volPrice >= 10e9 && f.changeRate >= 0.05,
    },
    {
      label: '거래대금 100억+ & 등락5%+ & 상한가 포함',
      filter: f => f.volPrice >= 10e9 && f.absChangeRate >= 0.05,
    },
    {
      label: '거래대금 50억+ & 등락3%+',
      filter: f => f.volPrice >= 5e9 && f.changeRate >= 0.03,
    },
    {
      label: '등락5%+ & MA60 위 & 거래량1.5x+',
      filter: f => f.changeRate >= 0.05 && f.ma60Dist > 0 && f.volRatio5 >= 1.5,
    },
    {
      label: '상한가만',
      filter: f => f.isLimitUp,
    },
    {
      label: '등락10%~29%',
      filter: f => f.changeRate >= 0.10 && f.changeRate < 0.29,
    },
    {
      label: '등락5%+ & 종가≠고가(고가에서 밀림) & 거래대금50억+',
      filter: f => f.changeRate >= 0.05 && f.closeVsHigh < 0.97 && f.volPrice >= 5e9,
    },
    {
      label: '등락5%+ & 종가=고가 & 거래대금50억+',
      filter: f => f.changeRate >= 0.05 && f.closeEqHigh && f.volPrice >= 5e9,
    },
    {
      label: '등락5%+ & 아래꼬리 없음 & 거래대금50억+',
      filter: f => f.changeRate >= 0.05 && f.lowerWick < 0.1 && f.volPrice >= 5e9,
    },
    {
      label: '등락5%+ & 연속상승2일+ & 거래대금50억+',
      filter: f => f.changeRate >= 0.05 && f.consecUp >= 2 && f.volPrice >= 5e9,
    },
    {
      label: '등락5%+ & RSI>60 & 거래대금50억+',
      filter: f => f.changeRate >= 0.05 && f.rsi14 > 60 && f.volPrice >= 5e9,
    },
    {
      label: '등락5%+ & 20일신고가 근접(-5%이내) & 거래대금50억+',
      filter: f => f.changeRate >= 0.05 && f.highDist20 > -0.05 && f.volPrice >= 5e9,
    },
    {
      label: '등락률 3~10% & 거래대금20억+ & MA5위',
      filter: f => f.changeRate >= 0.03 && f.changeRate < 0.10 && f.volPrice >= 2e9 && f.ma5Dist > 0,
    },
    {
      label: '등락률 7%+ & 갭업1%+ & 거래대금20억+',
      filter: f => f.changeRate >= 0.07 && f.gapUp >= 0.01 && f.volPrice >= 2e9,
    },
    {
      label: '음봉 + 거래폭발 + 거래대금50억+ (역발상)',
      filter: f => f.changeRate < 0 && f.absChangeRate >= 0.03 && f.volRatio5 >= 3 && f.volPrice >= 5e9,
    },
  ];

  // 등락률 순으로 상위 5~10개 선택
  const simResults = strategies.map(s => portfolioSim(dateMap, sortedDates, s.filter, s.label, 10));

  // 정렬: 최종 자본 순
  simResults.sort((a, b) => b.capital - a.capital);

  console.log(`\n  ${'#'.padStart(3)} ${'승률'.padStart(6)} ${'일평균'.padStart(8)} ${'500만→'.padStart(12)} ${'MDD'.padStart(6)} ${'거래일'.padStart(5)} ${'종/일'.padStart(5)} | 전략`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)} + ${'─'.repeat(50)}`);

  for (let i = 0; i < simResults.length; i++) {
    const r = simResults[i];
    const fin = r.capital >= 1e8 ? (r.capital / 1e8).toFixed(1) + '억' :
                r.capital >= 1e6 ? (r.capital / 1e4).toFixed(0) + '만' :
                (r.capital / 1e4).toFixed(1) + '만';
    console.log(`  ${String(i + 1).padStart(3)} ${(r.winRate * 100).toFixed(1).padStart(5)}% ${(r.avgDaily * 100).toFixed(2).padStart(7)}% ${fin.padStart(12)} ${(r.maxDD * 100).toFixed(1).padStart(5)}% ${String(r.tradeDays).padStart(5)} ${r.avgStocksPerDay.toFixed(1).padStart(5)} | ${r.label}`);
  }

  // ── TOP 3 월별 수익률 상세 ─────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  [4] TOP 3 전략 월별 수익률');
  console.log('═'.repeat(70));

  for (let si = 0; si < Math.min(3, simResults.length); si++) {
    const r = simResults[si];
    console.log(`\n  📈 ${r.label}`);
    console.log(`  ${'월'.padEnd(8)} ${'수익률'.padStart(8)} ${'거래일'.padStart(5)} ${'바'.padStart(2)}`);
    console.log(`  ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(25)}`);

    let cumCap = 5000000;
    for (const m of r.monthlyStats) {
      cumCap *= (1 + m.return);
      const bar = m.return > 0
        ? '█'.repeat(Math.min(25, Math.round(m.return * 100)))
        : '▒'.repeat(Math.min(25, Math.round(Math.abs(m.return) * 100)));
      console.log(`  ${m.month.padEnd(8)} ${(m.return * 100).toFixed(1).padStart(7)}% ${String(m.tradeDays).padStart(5)} ${m.return > 0 ? bar : '-' + bar}`);
    }
    console.log(`  ${'─'.repeat(50)}`);
    const fin = cumCap >= 1e8 ? (cumCap / 1e8).toFixed(2) + '억' : (cumCap / 1e4).toFixed(0) + '만';
    console.log(`  최종 자본: ${fin}원`);
  }

  // ── 5. 핵심 인사이트 도출 ──────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  [5] 종합 인사이트');
  console.log('═'.repeat(70));

  // 어떤 전략이 비용 차감 후에도 양수인가?
  const profitable = simResults.filter(r => r.avgDaily > 0);
  console.log(`\n  비용 차감 후 양수 전략: ${profitable.length}개 / ${simResults.length}개`);
  for (const r of profitable) {
    const annualized = (Math.pow(1 + r.avgDaily, 250) - 1) * 100;
    console.log(`    ✅ ${r.label}`);
    console.log(`       일평균 +${(r.avgDaily * 100).toFixed(2)}%, 연환산 +${annualized.toFixed(0)}%, MDD ${(r.maxDD * 100).toFixed(1)}%`);
  }

  // 저장
  const savePath = path.join(__dirname, '..', 'results', 'deep-analysis.json');
  fs.writeFileSync(savePath, JSON.stringify({
    period: { from: DATE_FROM, to: DATE_TO },
    ic: icResults.map(r => ({ feature: r.feature, meanIC: +r.meanIC.toFixed(4), icIR: +r.icIR.toFixed(2), hitRate: +r.hitRate.toFixed(2) })),
    strategies: simResults.map(r => ({ label: r.label, capital: Math.round(r.capital), avgDaily: +r.avgDaily.toFixed(6), winRate: +r.winRate.toFixed(4), maxDD: +r.maxDD.toFixed(4), tradeDays: r.tradeDays, totalTrades: r.totalTrades })),
  }, null, 2));
  console.log(`\n💾 저장: ${savePath}`);
}

main();
