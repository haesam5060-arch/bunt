/**
 * 번트 Step 1+2: 코스닥 전종목 오버나잇 수익률 전수조사 + IC 분석
 * ────────────────────────────────────────────────────────────────
 *
 * 모든 종목의 모든 거래일에 대해:
 *   수익률 = (익일시가 - 당일종가) / 당일종가
 * 를 계산하고, 20+개 후보 변수의 예측력(IC)을 측정한다.
 *
 * IC (Information Coefficient) = rank correlation(변수, 수익률)
 *   |IC| > 0.02 → 약한 예측력
 *   |IC| > 0.03 → 유의미
 *   |IC| > 0.05 → 강력
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');

// ── 보조 함수 ────────────────────────────────────────────────
function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = sma(arr.slice(0, period), period);
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k);
  }
  return val;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(data, idx, period = 14) {
  if (idx < period) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const h = data[i].high, l = data[i].low, pc = data[i - 1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    sum += tr;
  }
  return sum / period;
}

function calcBollingerPos(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  if (std === 0) return 0;
  return (closes[closes.length - 1] - mean) / (2 * std); // -1 ~ +1 범위
}

// Spearman rank correlation
function rankCorrelation(x, y) {
  const n = x.length;
  if (n < 10) return null;

  function rank(arr) {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    for (let i = 0; i < n; i++) ranks[indexed[i].i] = i + 1;
    return ranks;
  }

  const rx = rank(x);
  const ry = rank(y);
  let d2sum = 0;
  for (let i = 0; i < n; i++) d2sum += Math.pow(rx[i] - ry[i], 2);
  return 1 - (6 * d2sum) / (n * (n * n - 1));
}

// ── 메인 ──────────────────────────────────────────────────────
function main() {
  console.log('═'.repeat(70));
  console.log('  번트 Step 1+2: 코스닥 오버나잇 전수조사 + IC 분석');
  console.log('═'.repeat(70));

  // 코스닥 코드 로드
  const kosdaqCodes = new Set(JSON.parse(fs.readFileSync(KOSDAQ_FILE, 'utf8')));
  const ohlcvFiles = fs.readdirSync(OHLCV_DIR)
    .filter(f => f.endsWith('.json') && kosdaqCodes.has(f.replace('.json', '')));
  console.log(`\n[DATA] 코스닥 OHLCV 파일: ${ohlcvFiles.length}개`);

  // 변수 정의
  const varNames = [
    'vol_ratio_5',      // 거래량/5일평균
    'vol_ratio_10',     // 거래량/10일평균
    'vol_ratio_20',     // 거래량/20일평균
    'change_rate',      // 등락률 (전일대비)
    'upper_wick',       // 윗꼬리 비율 (high-close)/(high-low)
    'lower_wick',       // 아래꼬리 비율 (open-low)/(high-low)
    'body_ratio',       // 몸통 비율 (close-open)/(high-low)
    'close_vs_high',    // 종가/고가
    'low_vs_open',      // 저가/시가
    'gap_up',           // 갭상승률 (시가-전일종가)/전일종가
    'rsi_14',           // RSI(14)
    'atr_pct',          // ATR(14)/종가 (변동성)
    'bb_pos',           // 볼린저밴드 위치 (-1~+1)
    'ma5_dist',         // 종가 vs MA5 거리%
    'ma20_dist',        // 종가 vs MA20 거리%
    'ma60_dist',        // 종가 vs MA60 거리%
    'ma5_slope',        // MA5 기울기 (5일전 대비 변화율)
    'ret_5d',           // 5일 누적 수익률
    'ret_10d',          // 10일 누적 수익률
    'ret_20d',          // 20일 누적 수익률
    'vol_price',        // 거래대금 (volume×close, 유동성 프록시)
    'consec_up',        // 연속 상승일 수
    'high_dist_20d',    // 20일 고점 대비 거리
    'range_pct',        // 일중 변동폭 (high-low)/close
  ];

  // 전체 데이터 수집
  const allSamples = []; // { vars: {}, overnight: float, date: string }
  let stockCount = 0;
  let sampleCount = 0;
  let skippedByData = 0;

  const startTime = Date.now();

  for (const file of ohlcvFiles) {
    const code = file.replace('.json', '');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, file), 'utf8'));
      if (!Array.isArray(data) || data.length < 65) { skippedByData++; continue; }
    } catch { skippedByData++; continue; }

    stockCount++;

    // 60일부터 시작 (MA60 필요), 마지막 날 제외 (익일 시가 필요)
    for (let i = 60; i < data.length - 1; i++) {
      const d = data[i];
      const prev = data[i - 1];
      const next = data[i + 1];

      // 기본 유효성
      if (!d.close || !d.open || !d.high || !d.low || !d.volume) continue;
      if (!prev.close || !next.open) continue;
      if (d.close <= 0 || d.open <= 0 || d.high <= 0 || d.low <= 0) continue;
      if (next.open <= 0) continue;

      // 상한가 제외 (29%+ = 실질 매수 불가)
      const changeRate = (d.close - prev.close) / prev.close;
      if (changeRate >= 0.29) continue;

      // 하한가 제외 (비정상)
      if (changeRate <= -0.29) continue;

      // 오버나잇 수익률 (타겟 변수)
      const overnight = (next.open - d.close) / d.close;

      // ── 후보 변수 계산 ──
      const range = d.high - d.low;
      const vars = {};

      // 거래량 비율
      for (const [key, period] of [['vol_ratio_5', 5], ['vol_ratio_10', 10], ['vol_ratio_20', 20]]) {
        let vsum = 0;
        for (let j = i - period; j < i; j++) vsum += data[j].volume;
        const vavg = vsum / period;
        vars[key] = vavg > 0 ? d.volume / vavg : 0;
      }

      // 등락률
      vars.change_rate = changeRate;

      // 캔들 구조
      if (range > 0) {
        vars.upper_wick = (d.high - Math.max(d.close, d.open)) / range;
        vars.lower_wick = (Math.min(d.close, d.open) - d.low) / range;
        vars.body_ratio = (d.close - d.open) / range;
      } else {
        vars.upper_wick = 0;
        vars.lower_wick = 0;
        vars.body_ratio = 0;
      }

      vars.close_vs_high = d.close / d.high;
      vars.low_vs_open = d.open > 0 ? d.low / d.open : 1;

      // 갭
      vars.gap_up = (d.open - prev.close) / prev.close;

      // RSI
      const closes = [];
      for (let j = i - 14; j <= i; j++) closes.push(data[j].close);
      vars.rsi_14 = calcRSI(closes) || 50;

      // ATR%
      const atr = calcATR(data, i);
      vars.atr_pct = atr ? atr / d.close : 0;

      // 볼린저밴드
      const closes20 = [];
      for (let j = i - 19; j <= i; j++) closes20.push(data[j].close);
      vars.bb_pos = calcBollingerPos(closes20) || 0;

      // MA 거리
      const c5 = [], c20 = [], c60 = [];
      for (let j = i - 4; j <= i; j++) c5.push(data[j].close);
      for (let j = i - 19; j <= i; j++) c20.push(data[j].close);
      for (let j = i - 59; j <= i; j++) c60.push(data[j].close);
      const ma5 = sma(c5, 5);
      const ma20 = sma(c20, 20);
      const ma60 = sma(c60, 60);
      vars.ma5_dist = ma5 ? (d.close - ma5) / ma5 : 0;
      vars.ma20_dist = ma20 ? (d.close - ma20) / ma20 : 0;
      vars.ma60_dist = ma60 ? (d.close - ma60) / ma60 : 0;

      // MA5 기울기
      const ma5_prev = sma(c5.slice(0, -1).concat([data[i - 5]?.close || c5[0]]).slice(-5), 5);
      vars.ma5_slope = ma5 && ma5_prev && ma5_prev > 0 ? (ma5 - ma5_prev) / ma5_prev : 0;

      // N일 수익률
      vars.ret_5d = data[i - 5]?.close > 0 ? (d.close - data[i - 5].close) / data[i - 5].close : 0;
      vars.ret_10d = data[i - 10]?.close > 0 ? (d.close - data[i - 10].close) / data[i - 10].close : 0;
      vars.ret_20d = data[i - 20]?.close > 0 ? (d.close - data[i - 20].close) / data[i - 20].close : 0;

      // 거래대금
      vars.vol_price = d.volume * d.close;

      // 연속 상승일
      let consec = 0;
      for (let j = i; j > i - 10 && j > 0; j--) {
        if (data[j].close > data[j - 1].close) consec++;
        else break;
      }
      vars.consec_up = consec;

      // 20일 고점 대비
      let high20 = 0;
      for (let j = i - 19; j <= i; j++) {
        if (data[j].high > high20) high20 = data[j].high;
      }
      vars.high_dist_20d = high20 > 0 ? d.close / high20 : 1;

      // 일중 변동폭
      vars.range_pct = d.close > 0 ? range / d.close : 0;

      allSamples.push({ vars, overnight, date: d.date, code });
      sampleCount++;
    }

    if (stockCount % 200 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [${stockCount}/${ohlcvFiles.length}] ${sampleCount.toLocaleString()}건 수집 (${elapsed}s)`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[DATA] 수집 완료: ${stockCount}개 종목, ${sampleCount.toLocaleString()}건 샘플 (${totalElapsed}s)`);
  console.log(`[DATA] 스킵: ${skippedByData}개 (데이터 부족)`);

  // ── 기본 통계 ────────────────────────────────────────────
  const overnights = allSamples.map(s => s.overnight);
  const avgON = overnights.reduce((a, b) => a + b, 0) / overnights.length;
  const posON = overnights.filter(v => v > 0).length;
  const sorted = [...overnights].sort((a, b) => a - b);
  const medianON = sorted[Math.floor(sorted.length / 2)];
  const stdON = Math.sqrt(overnights.reduce((s, v) => s + Math.pow(v - avgON, 2), 0) / overnights.length);

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  Step 1: 코스닥 오버나잇 수익률 기본 통계');
  console.log('═'.repeat(70));
  console.log(`  기간          : ${allSamples[0]?.date} ~ ${allSamples[allSamples.length - 1]?.date}`);
  console.log(`  총 샘플       : ${sampleCount.toLocaleString()}건`);
  console.log(`  양수 비율     : ${(posON / sampleCount * 100).toFixed(1)}% (${posON.toLocaleString()}건)`);
  console.log(`  평균 수익률   : ${(avgON * 100).toFixed(4)}%`);
  console.log(`  중앙값        : ${(medianON * 100).toFixed(4)}%`);
  console.log(`  표준편차      : ${(stdON * 100).toFixed(4)}%`);
  console.log(`  최대          : +${(sorted[sorted.length - 1] * 100).toFixed(2)}%`);
  console.log(`  최소          : ${(sorted[0] * 100).toFixed(2)}%`);

  // 수익률 분포
  console.log(`\n  [수익률 분포]`);
  const distBins = [[-Infinity,-5],[-5,-3],[-3,-1],[-1,0],[0,1],[1,3],[3,5],[5,Infinity]];
  for (const [lo, hi] of distBins) {
    const cnt = overnights.filter(v => v * 100 >= lo && v * 100 < hi).length;
    const pct = (cnt / sampleCount * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(cnt / sampleCount * 80));
    const label = hi === Infinity ? `${lo}%~` : lo === -Infinity ? `~${hi}%` : `${lo}%~${hi}%`;
    console.log(`  ${label.padEnd(10)} ${String(cnt).padStart(9)}건 (${pct.padStart(5)}%) ${bar}`);
  }

  // ── Step 2: IC 분석 ─────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  Step 2: 변수별 IC (Information Coefficient) 분석');
  console.log('═'.repeat(70));
  console.log('  IC = 변수와 오버나잇 수익률의 Spearman 순위상관계수');
  console.log('  |IC| > 0.02: 약한 예측력, > 0.03: 유의미, > 0.05: 강력\n');

  const overnightArr = allSamples.map(s => s.overnight);
  const icResults = [];

  for (const varName of varNames) {
    const varArr = allSamples.map(s => s.vars[varName]);

    // 전체 IC
    const ic = rankCorrelation(varArr, overnightArr);

    // 양수/음수 방향 분석
    // 변수 상위 20% vs 하위 20% 평균 수익률 비교
    const indexed = varArr.map((v, i) => ({ v, ret: overnightArr[i] }));
    indexed.sort((a, b) => a.v - b.v);
    const quintile = Math.floor(indexed.length / 5);
    const bottom20 = indexed.slice(0, quintile);
    const top20 = indexed.slice(-quintile);
    const avgBot = bottom20.reduce((s, x) => s + x.ret, 0) / bottom20.length;
    const avgTop = top20.reduce((s, x) => s + x.ret, 0) / top20.length;
    const wrBot = bottom20.filter(x => x.ret > 0).length / bottom20.length;
    const wrTop = top20.filter(x => x.ret > 0).length / top20.length;

    icResults.push({
      name: varName,
      ic: ic || 0,
      absIc: Math.abs(ic || 0),
      top20Avg: avgTop,
      bot20Avg: avgBot,
      top20WR: wrTop,
      bot20WR: wrBot,
      spread: avgTop - avgBot,
    });
  }

  // IC 절대값 기준 내림차순 정렬
  icResults.sort((a, b) => b.absIc - a.absIc);

  console.log(`  ${'변수'.padEnd(18)} ${'IC'.padStart(8)} ${'강도'.padStart(6)}  ${'하위20%수익'.padStart(11)} ${'상위20%수익'.padStart(11)} ${'스프레드'.padStart(10)}`);
  console.log(`  ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(6)}  ${'─'.repeat(11)} ${'─'.repeat(11)} ${'─'.repeat(10)}`);

  for (const r of icResults) {
    const strength = r.absIc >= 0.05 ? '★★★' : r.absIc >= 0.03 ? '★★ ' : r.absIc >= 0.02 ? '★  ' : '   ';
    const icStr = (r.ic >= 0 ? '+' : '') + r.ic.toFixed(4);
    const topStr = (r.top20Avg >= 0 ? '+' : '') + (r.top20Avg * 100).toFixed(3) + '%';
    const botStr = (r.bot20Avg >= 0 ? '+' : '') + (r.bot20Avg * 100).toFixed(3) + '%';
    const spreadStr = (r.spread >= 0 ? '+' : '') + (r.spread * 100).toFixed(3) + '%';
    console.log(`  ${r.name.padEnd(18)} ${icStr.padStart(8)} ${strength}   ${botStr.padStart(11)} ${topStr.padStart(11)} ${spreadStr.padStart(10)}`);
  }

  // ── 상위 10개 변수 상세 분석 ───────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  상위 예측 변수 상세 분석 (5분위 분석)');
  console.log('═'.repeat(70));

  const topVars = icResults.slice(0, 10);
  for (const tv of topVars) {
    console.log(`\n  📊 ${tv.name} (IC: ${tv.ic >= 0 ? '+' : ''}${tv.ic.toFixed(4)})`);
    const indexed = allSamples.map(s => ({ v: s.vars[tv.name], ret: s.overnight }));
    indexed.sort((a, b) => a.v - b.v);
    const q = Math.floor(indexed.length / 5);

    for (let qi = 0; qi < 5; qi++) {
      const slice = indexed.slice(qi * q, (qi + 1) * q);
      const avgR = slice.reduce((s, x) => s + x.ret, 0) / slice.length;
      const wr = slice.filter(x => x.ret > 0).length / slice.length;
      const minV = slice[0].v;
      const maxV = slice[slice.length - 1].v;
      const label = `Q${qi + 1}`;
      const bar = avgR >= 0 ? '🟢'.repeat(Math.min(5, Math.round(avgR * 100 * 2))) : '🔴'.repeat(Math.min(5, Math.round(Math.abs(avgR * 100) * 2)));
      console.log(`    ${label} [${minV.toFixed(3)}~${maxV.toFixed(3)}]: 수익 ${(avgR * 100).toFixed(3)}% 승률 ${(wr * 100).toFixed(1)}% ${bar}`);
    }
  }

  // ── 연도별 IC 안정성 ───────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  연도별 IC 안정성 (상위 5개 변수)');
  console.log('═'.repeat(70));

  const years = [...new Set(allSamples.map(s => s.date.substring(0, 4)))].sort();
  const top5Vars = icResults.slice(0, 5).map(r => r.name);

  console.log(`  ${'변수'.padEnd(18)} ${years.map(y => y.padStart(8)).join(' ')}`);
  console.log(`  ${'─'.repeat(18)} ${years.map(() => '─'.repeat(8)).join(' ')}`);

  for (const vn of top5Vars) {
    const yearICs = [];
    for (const yr of years) {
      const yrSamples = allSamples.filter(s => s.date.startsWith(yr));
      const varArr = yrSamples.map(s => s.vars[vn]);
      const retArr = yrSamples.map(s => s.overnight);
      const ic = rankCorrelation(varArr, retArr);
      yearICs.push(ic ? (ic >= 0 ? '+' : '') + ic.toFixed(3) : '  N/A');
    }
    console.log(`  ${vn.padEnd(18)} ${yearICs.map(v => v.padStart(8)).join(' ')}`);
  }

  // ── 결과 저장 ──────────────────────────────────────────────
  const resultPath = path.join(__dirname, '..', 'results', 'ic-analysis.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    meta: {
      stocks: stockCount,
      samples: sampleCount,
      period: `${allSamples[0]?.date} ~ ${allSamples[allSamples.length - 1]?.date}`,
      excludeUpperLimit: true,
      excludeLowerLimit: true,
    },
    baseStats: {
      avgOvernight: avgON,
      medianOvernight: medianON,
      stdOvernight: stdON,
      positiveRate: posON / sampleCount,
    },
    icResults: icResults.map(r => ({
      name: r.name,
      ic: +r.ic.toFixed(5),
      top20Avg: +(r.top20Avg * 100).toFixed(4),
      bot20Avg: +(r.bot20Avg * 100).toFixed(4),
      top20WR: +(r.top20WR * 100).toFixed(2),
      bot20WR: +(r.bot20WR * 100).toFixed(2),
      spread: +(r.spread * 100).toFixed(4),
    })),
  }, null, 2));
  console.log(`\n💾 결과 저장: ${resultPath}`);
}

main();
