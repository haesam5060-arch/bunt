/**
 * 번트: 역방향 분석 — "익일 시가가 오른 종목의 공통점은?"
 * ────────────────────────────────────────────────────────
 * 최근 1년 코스닥 전종목 대상.
 * overnight return > 0 인 케이스 vs <= 0 인 케이스를 비교.
 * 각 변수별로 "이기는 쪽"과 "지는 쪽"의 분포 차이를 정량화.
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');

const COST = 0.00231; // 수수료+세금+슬리피지

// 최근 1년 기준 (2025-03-17 ~ 2026-03-17)
const DATE_FROM = '2025-03-17';
const DATE_TO = '2026-03-17';

function loadData() {
  const kosdaqCodes = new Set(JSON.parse(fs.readFileSync(KOSDAQ_FILE, 'utf8')));
  const files = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.json') && kosdaqCodes.has(f.replace('.json', '')));

  console.log(`[DATA] ${files.length}개 코스닥 종목 로딩 (${DATE_FROM} ~ ${DATE_TO})...`);

  const wins = [];   // overnight > COST (비용 차감 후 양수)
  const losses = [];  // overnight <= COST
  let skipped = 0, total = 0;

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, file), 'utf8'));
      if (!Array.isArray(data) || data.length < 65) continue;
    } catch { continue; }

    for (let i = 60; i < data.length - 1; i++) {
      const d = data[i], prev = data[i - 1], next = data[i + 1];
      if (!d.date || d.date < DATE_FROM || d.date > DATE_TO) continue;
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) { skipped++; continue; }
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) { skipped++; continue; }

      const changeRate = (d.close - prev.close) / prev.close;
      if (Math.abs(changeRate) >= 0.29) continue; // 상한가/하한가 제외

      const range = d.high - d.low;
      const overnight = (next.open - d.close) / d.close;

      // ── 30개+ 특성 변수 계산 ─────────────────────────
      // 거래량 관련
      let v5 = 0, v10 = 0, v20 = 0;
      for (let j = i - 5; j < i; j++) v5 += (data[j]?.volume || 0);
      for (let j = i - 10; j < i; j++) v10 += (data[j]?.volume || 0);
      for (let j = i - 20; j < i; j++) v20 += (data[j]?.volume || 0);
      const avgV5 = v5 / 5, avgV10 = v10 / 10, avgV20 = v20 / 20;

      // MA 관련
      let c5 = 0, c10 = 0, c20 = 0, c60 = 0;
      for (let j = i - 4; j <= i; j++) c5 += data[j].close;
      for (let j = i - 9; j <= i; j++) c10 += data[j].close;
      for (let j = i - 19; j <= i; j++) c20 += data[j].close;
      for (let j = i - 59; j <= i; j++) c60 += data[j].close;
      const ma5 = c5 / 5, ma10 = c10 / 10, ma20 = c20 / 20, ma60 = c60 / 60;

      // RSI 14
      let gain = 0, loss = 0;
      for (let j = i - 13; j <= i; j++) {
        const diff = data[j].close - data[j - 1].close;
        if (diff > 0) gain += diff; else loss += Math.abs(diff);
      }
      const ag = gain / 14, al = loss / 14;
      const rsi14 = al === 0 ? 100 : 100 - (100 / (1 + ag / al));

      // ATR 14
      let atrSum = 0;
      for (let j = i - 13; j <= i; j++) {
        const h = data[j].high, l = data[j].low, pc = data[j - 1].close;
        atrSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const atr14 = atrSum / 14;

      // 연속 상승/하락
      let consecUp = 0, consecDown = 0;
      for (let j = i; j > 0 && j > i - 20; j--) {
        if (data[j].close > data[j - 1].close) consecUp++;
        else break;
      }
      for (let j = i; j > 0 && j > i - 20; j--) {
        if (data[j].close < data[j - 1].close) consecDown++;
        else break;
      }

      // 과거 N일 수익률
      const ret3d = data[i - 3]?.close > 0 ? (d.close - data[i - 3].close) / data[i - 3].close : 0;
      const ret5d = data[i - 5]?.close > 0 ? (d.close - data[i - 5].close) / data[i - 5].close : 0;
      const ret10d = data[i - 10]?.close > 0 ? (d.close - data[i - 10].close) / data[i - 10].close : 0;
      const ret20d = data[i - 20]?.close > 0 ? (d.close - data[i - 20].close) / data[i - 20].close : 0;

      // 20일 최고가/최저가 대비
      let high20 = 0, low20 = Infinity;
      for (let j = i - 19; j <= i; j++) {
        if (data[j].high > high20) high20 = data[j].high;
        if (data[j].low < low20) low20 = data[j].low;
      }

      // 전일 패턴
      const prevChange = (prev.close - (data[i - 2]?.close || prev.open)) / (data[i - 2]?.close || prev.open);
      const prevRange = prev.high - prev.low;
      const prevUpperWick = prevRange > 0 ? (prev.high - Math.max(prev.close, prev.open)) / prevRange : 0;

      const features = {
        // 당일 캔들
        changeRate,
        absChangeRate: Math.abs(changeRate),
        bodyRatio: range > 0 ? (d.close - d.open) / range : 0,
        upperWick: range > 0 ? (d.high - Math.max(d.close, d.open)) / range : 0,
        lowerWick: range > 0 ? (Math.min(d.close, d.open) - d.low) / range : 0,
        closeVsHigh: d.high > 0 ? d.close / d.high : 0,
        lowVsOpen: d.open > 0 ? d.low / d.open : 0,
        rangePct: d.close > 0 ? range / d.close : 0,
        gapUp: (d.open - prev.close) / prev.close,

        // 거래량
        volRatio5: avgV5 > 0 ? d.volume / avgV5 : 0,
        volRatio10: avgV10 > 0 ? d.volume / avgV10 : 0,
        volRatio20: avgV20 > 0 ? d.volume / avgV20 : 0,
        volPrice: d.volume * d.close,

        // 이동평균 위치
        ma5Dist: ma5 > 0 ? (d.close - ma5) / ma5 : 0,
        ma10Dist: ma10 > 0 ? (d.close - ma10) / ma10 : 0,
        ma20Dist: ma20 > 0 ? (d.close - ma20) / ma20 : 0,
        ma60Dist: ma60 > 0 ? (d.close - ma60) / ma60 : 0,
        ma5_20cross: ma20 > 0 ? (ma5 - ma20) / ma20 : 0,

        // 보조지표
        rsi14,
        atrPct: d.close > 0 ? atr14 / d.close : 0,

        // 모멘텀
        consecUp,
        consecDown,
        ret3d,
        ret5d,
        ret10d,
        ret20d,

        // 위치
        highDist20: high20 > 0 ? (d.close - high20) / high20 : 0,  // 20일 고점 대비 (음수=조정중)
        lowDist20: low20 > 0 ? (d.close - low20) / low20 : 0,      // 20일 저점 대비 (양수=반등중)

        // 전일 패턴
        prevChange,
        prevUpperWick,
      };

      total++;
      if (overnight > COST) {
        wins.push(features);
      } else {
        losses.push(features);
      }
    }
  }

  console.log(`[DATA] 총 ${total.toLocaleString()}건 (승: ${wins.length.toLocaleString()}, 패: ${losses.length.toLocaleString()}, 승률: ${(wins.length / total * 100).toFixed(1)}%)`);
  return { wins, losses, total };
}

// ── 분석: 각 변수별 승/패 분포 비교 ─────────────────────────
function analyzeFeatures(wins, losses) {
  const featureNames = Object.keys(wins[0]);
  const results = [];

  for (const feat of featureNames) {
    const wVals = wins.map(w => w[feat]).filter(v => isFinite(v));
    const lVals = losses.map(l => l[feat]).filter(v => isFinite(v));

    if (wVals.length < 100 || lVals.length < 100) continue;

    // 평균, 중앙값
    wVals.sort((a, b) => a - b);
    lVals.sort((a, b) => a - b);

    const wMean = wVals.reduce((a, b) => a + b, 0) / wVals.length;
    const lMean = lVals.reduce((a, b) => a + b, 0) / lVals.length;
    const wMedian = wVals[Math.floor(wVals.length / 2)];
    const lMedian = lVals[Math.floor(lVals.length / 2)];

    // 표준편차
    const wStd = Math.sqrt(wVals.reduce((s, v) => s + (v - wMean) ** 2, 0) / wVals.length);
    const lStd = Math.sqrt(lVals.reduce((s, v) => s + (v - lMean) ** 2, 0) / lVals.length);

    // Cohen's d (효과크기)
    const pooledStd = Math.sqrt((wStd ** 2 + lStd ** 2) / 2);
    const cohensD = pooledStd > 0 ? (wMean - lMean) / pooledStd : 0;

    // t-test (독립 표본)
    const se = Math.sqrt((wStd ** 2 / wVals.length) + (lStd ** 2 / lVals.length));
    const tStat = se > 0 ? (wMean - lMean) / se : 0;

    // 5분위 분석: 해당 변수 상위 20%에서의 승률
    const allVals = [...wVals.map(v => ({ v, w: 1 })), ...lVals.map(v => ({ v, w: 0 }))];
    allVals.sort((a, b) => a.v - b.v);
    const q5 = Math.floor(allVals.length / 5);
    const topQuintile = allVals.slice(q5 * 4);
    const botQuintile = allVals.slice(0, q5);
    const topWR = topQuintile.reduce((s, x) => s + x.w, 0) / topQuintile.length;
    const botWR = botQuintile.reduce((s, x) => s + x.w, 0) / botQuintile.length;

    results.push({
      feature: feat,
      winMean: wMean,
      lossMean: lMean,
      winMedian: wMedian,
      lossMedian: lMedian,
      cohensD,
      tStat,
      topQuintileWR: topWR,
      botQuintileWR: botWR,
      quintileSpread: topWR - botWR,  // 양수면 높을수록 좋음, 음수면 낮을수록 좋음
      direction: wMean > lMean ? '높을수록↑' : '낮을수록↓',
    });
  }

  // 효과크기 절대값 기준 정렬
  results.sort((a, b) => Math.abs(b.cohensD) - Math.abs(a.cohensD));
  return results;
}

// ── 구간별 승률 상세 분석 (TOP 변수) ─────────────────────────
function detailedBucketAnalysis(wins, losses, topFeatures) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  주요 변수별 구간 승률 상세');
  console.log('═'.repeat(70));

  for (const feat of topFeatures) {
    const all = [
      ...wins.map(w => ({ v: w[feat], overnight: 1 })),
      ...losses.map(l => ({ v: l[feat], overnight: 0 }))
    ].filter(x => isFinite(x.v));

    all.sort((a, b) => a.v - b.v);

    // 10분위
    const deciles = [];
    const dSize = Math.floor(all.length / 10);
    for (let d = 0; d < 10; d++) {
      const slice = all.slice(d * dSize, d === 9 ? all.length : (d + 1) * dSize);
      const wr = slice.reduce((s, x) => s + x.overnight, 0) / slice.length;
      const minV = slice[0].v;
      const maxV = slice[slice.length - 1].v;
      deciles.push({ decile: d + 1, minV, maxV, wr, count: slice.length });
    }

    console.log(`\n  📊 ${feat}`);
    console.log(`  ${'분위'.padEnd(4)} ${'범위'.padEnd(28)} ${'승률'.padStart(6)} ${'건수'.padStart(6)} ${'바 차트'.padStart(4)}`);
    console.log(`  ${'─'.repeat(4)} ${'─'.repeat(28)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(25)}`);

    for (const d of deciles) {
      const bar = '█'.repeat(Math.round(d.wr * 30));
      const rangeStr = `${d.minV >= 100 ? d.minV.toFixed(0) : d.minV.toFixed(4)} ~ ${d.maxV >= 100 ? d.maxV.toFixed(0) : d.maxV.toFixed(4)}`;
      const marker = d.wr >= 0.50 ? ' ✓' : '';
      console.log(`  D${String(d.decile).padStart(2)}  ${rangeStr.padEnd(28)} ${(d.wr * 100).toFixed(1).padStart(5)}% ${String(d.count).padStart(6)} ${bar}${marker}`);
    }
  }
}

// ── 조합 탐색 (TOP 변수 기반) ────────────────────────────────
function findBestCombinations(wins, losses, topResults) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  조합 탐색: 상위 변수 임계값 조합별 승률');
  console.log('═'.repeat(70));

  const all = [
    ...wins.map(w => ({ ...w, isWin: 1 })),
    ...losses.map(l => ({ ...l, isWin: 0 }))
  ];

  // 상위 변수 중 양의 방향(높을수록 좋음)인 것들의 임계값 후보
  const posFeats = topResults.filter(r => r.cohensD > 0).slice(0, 6);
  const negFeats = topResults.filter(r => r.cohensD < 0).slice(0, 4);

  // 각 변수별 백분위 계산
  function getPercentiles(feat) {
    const vals = all.map(x => x[feat]).filter(v => isFinite(v)).sort((a, b) => a - b);
    return {
      p50: vals[Math.floor(vals.length * 0.5)],
      p60: vals[Math.floor(vals.length * 0.6)],
      p70: vals[Math.floor(vals.length * 0.7)],
      p75: vals[Math.floor(vals.length * 0.75)],
      p80: vals[Math.floor(vals.length * 0.8)],
      p90: vals[Math.floor(vals.length * 0.9)],
    };
  }

  // 상위 3개 양의 변수 조합
  if (posFeats.length >= 2) {
    const f1 = posFeats[0].feature, f2 = posFeats[1].feature;
    const f3 = posFeats.length >= 3 ? posFeats[2].feature : null;
    const p1 = getPercentiles(f1), p2 = getPercentiles(f2);
    const p3 = f3 ? getPercentiles(f3) : null;

    const thresholds = ['p50', 'p60', 'p70', 'p75', 'p80', 'p90'];
    const combResults = [];

    for (const t1 of thresholds) {
      for (const t2 of thresholds) {
        if (f3 && p3) {
          for (const t3 of thresholds) {
            const filtered = all.filter(x =>
              isFinite(x[f1]) && x[f1] >= p1[t1] &&
              isFinite(x[f2]) && x[f2] >= p2[t2] &&
              isFinite(x[f3]) && x[f3] >= p3[t3]
            );
            if (filtered.length >= 50) {
              const wr = filtered.reduce((s, x) => s + x.isWin, 0) / filtered.length;
              combResults.push({ f1, t1, f2, t2, f3, t3, wr, count: filtered.length });
            }
          }
        } else {
          const filtered = all.filter(x =>
            isFinite(x[f1]) && x[f1] >= p1[t1] &&
            isFinite(x[f2]) && x[f2] >= p2[t2]
          );
          if (filtered.length >= 50) {
            const wr = filtered.reduce((s, x) => s + x.isWin, 0) / filtered.length;
            combResults.push({ f1, t1, f2, t2, wr, count: filtered.length });
          }
        }
      }
    }

    combResults.sort((a, b) => b.wr - a.wr);

    console.log(`\n  양의 변수 조합 (${f1} × ${f2}${f3 ? ' × ' + f3 : ''}):`);
    console.log(`  ${'#'.padStart(3)} ${'승률'.padStart(6)} ${'건수'.padStart(7)} | 조건`);
    console.log(`  ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(7)} + ${'─'.repeat(45)}`);

    for (let i = 0; i < Math.min(15, combResults.length); i++) {
      const r = combResults[i];
      const cond = r.f3
        ? `${r.f1}≥${r.t1} & ${r.f2}≥${r.t2} & ${r.f3}≥${r.t3}`
        : `${r.f1}≥${r.t1} & ${r.f2}≥${r.t2}`;
      console.log(`  ${String(i + 1).padStart(3)} ${(r.wr * 100).toFixed(1).padStart(5)}% ${String(r.count).padStart(7)} | ${cond}`);
    }

    // 승률 55%+ 중 건수 많은 순
    const wr55 = combResults.filter(r => r.wr >= 0.55);
    wr55.sort((a, b) => b.count - a.count);
    console.log(`\n  승률 55%+ 중 건수 TOP 10:`);
    for (let i = 0; i < Math.min(10, wr55.length); i++) {
      const r = wr55[i];
      const cond = r.f3
        ? `${r.f1}≥${r.t1} & ${r.f2}≥${r.t2} & ${r.f3}≥${r.t3}`
        : `${r.f1}≥${r.t1} & ${r.f2}≥${r.t2}`;
      console.log(`  ${String(i + 1).padStart(3)} ${(r.wr * 100).toFixed(1).padStart(5)}% ${String(r.count).padStart(7)} | ${cond}`);
    }
  }

  // 음의 변수(낮을수록 좋음) + 양의 변수 혼합
  if (negFeats.length >= 1 && posFeats.length >= 1) {
    const nf = negFeats[0].feature;
    const pf = posFeats[0].feature;
    const np = getPercentiles(nf), pp = getPercentiles(pf);

    const thresholds = ['p50', 'p60', 'p70', 'p75', 'p80', 'p90'];
    const mixResults = [];

    for (const tp of thresholds) {
      for (const tn of thresholds) {
        // nf는 낮을수록 좋음 → 백분위 이하로 필터
        const nThresh = np[tn]; // 이 이하
        const pThresh = pp[tp]; // 이 이상
        const filtered = all.filter(x =>
          isFinite(x[pf]) && x[pf] >= pThresh &&
          isFinite(x[nf]) && x[nf] <= nThresh
        );
        if (filtered.length >= 50) {
          const wr = filtered.reduce((s, x) => s + x.isWin, 0) / filtered.length;
          mixResults.push({ pf, tp, nf, tn, wr, count: filtered.length, pThresh, nThresh });
        }
      }
    }

    mixResults.sort((a, b) => b.wr - a.wr);
    console.log(`\n  혼합 조합 (${pf}↑ × ${nf}↓):`);
    console.log(`  ${'#'.padStart(3)} ${'승률'.padStart(6)} ${'건수'.padStart(7)} | 조건`);
    console.log(`  ${'─'.repeat(3)} ${'─'.repeat(6)} ${'─'.repeat(7)} + ${'─'.repeat(45)}`);
    for (let i = 0; i < Math.min(15, mixResults.length); i++) {
      const r = mixResults[i];
      console.log(`  ${String(i + 1).padStart(3)} ${(r.wr * 100).toFixed(1).padStart(5)}% ${String(r.count).padStart(7)} | ${r.pf}≥${r.tp}(${r.pThresh.toFixed(4)}) & ${r.nf}≤${r.tn}(${r.nThresh.toFixed(4)})`);
    }
  }
}

// ── 메인 ──────────────────────────────────────────────────────
function main() {
  console.log('═'.repeat(70));
  console.log('  번트 역방향 분석: 익일 시가 수익 종목의 DNA');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO} (최근 1년)`);
  console.log('═'.repeat(70));

  const { wins, losses, total } = loadData();
  const baseWR = wins.length / total;
  console.log(`\n  베이스라인 승률: ${(baseWR * 100).toFixed(1)}% (비용 ${(COST * 100).toFixed(2)}% 차감 후)\n`);

  const results = analyzeFeatures(wins, losses);

  // ── 변수별 효과크기 순위 ───────────────────────────────
  console.log('═'.repeat(70));
  console.log('  변수별 예측력 순위 (Cohen\'s d, 효과크기)');
  console.log('═'.repeat(70));
  console.log(`  ${'#'.padStart(3)} ${'변수'.padEnd(18)} ${'방향'.padEnd(8)} ${'승평균'.padStart(9)} ${'패평균'.padStart(9)} ${'효과크기'.padStart(8)} ${'t값'.padStart(8)} ${'상위20%승률'.padStart(10)} ${'하위20%승률'.padStart(10)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const fmtV = (v) => Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(4);
    console.log(`  ${String(i + 1).padStart(3)} ${r.feature.padEnd(18)} ${r.direction.padEnd(8)} ${fmtV(r.winMean).padStart(9)} ${fmtV(r.lossMean).padStart(9)} ${r.cohensD.toFixed(4).padStart(8)} ${r.tStat.toFixed(1).padStart(8)} ${(r.topQuintileWR * 100).toFixed(1).padStart(9)}% ${(r.botQuintileWR * 100).toFixed(1).padStart(9)}%`);
  }

  // ── 핵심 발견 요약 ────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  핵심 발견 (효과크기 |d| > 0.02)');
  console.log('═'.repeat(70));

  const significant = results.filter(r => Math.abs(r.cohensD) >= 0.02);
  for (const r of significant) {
    const arrow = r.cohensD > 0 ? '▲ 높을수록 유리' : '▼ 낮을수록 유리';
    console.log(`  • ${r.feature}: ${arrow} (d=${r.cohensD.toFixed(3)}, 상위20% 승률 ${(r.topQuintileWR * 100).toFixed(1)}%, 하위20% 승률 ${(r.botQuintileWR * 100).toFixed(1)}%)`);
  }

  // ── 구간 상세 ──────────────────────────────────────────
  const topFeats = results.slice(0, 8).map(r => r.feature);
  detailedBucketAnalysis(wins, losses, topFeats);

  // ── 조합 탐색 ──────────────────────────────────────────
  findBestCombinations(wins, losses, results);

  // ── 결과 저장 ──────────────────────────────────────────
  const savePath = path.join(__dirname, '..', 'results', 'reverse-analysis.json');
  fs.writeFileSync(savePath, JSON.stringify({
    period: { from: DATE_FROM, to: DATE_TO },
    baseWinRate: baseWR,
    totalSamples: wins.length + losses.length,
    winSamples: wins.length,
    features: results.map(r => ({
      feature: r.feature,
      direction: r.direction,
      cohensD: +r.cohensD.toFixed(4),
      tStat: +r.tStat.toFixed(2),
      winMean: +r.winMean.toFixed(6),
      lossMean: +r.lossMean.toFixed(6),
      topQuintileWR: +r.topQuintileWR.toFixed(4),
      botQuintileWR: +r.botQuintileWR.toFixed(4),
    }))
  }, null, 2));
  console.log(`\n💾 저장: ${savePath}`);
}

main();
