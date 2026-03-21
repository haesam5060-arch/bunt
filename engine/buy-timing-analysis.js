#!/usr/bin/env node
/**
 * 번트 매수 타이밍 분석 — 종가 매수 vs 시가 매수 수익률 비교
 * ──────────────────────────────────────────────────────────
 *
 * 분석 목적: 현재 16:25 매수(장종료 후) vs 장마감 전 종가 매수의 수익 차이
 *
 * 분석 항목:
 *  1. 종가 매수 → 익일 시가 매도 (오버나잇 수익)
 *  2. 시가 매수 → 당일 종가 매도 (16:25 주문이 익일 시가 체결되는 경우)
 *  3. 오버나잇 갭(종가→익일시가) 분포 분석
 *  4. 시간대별 체결 시나리오 비교
 *  5. 동시호가 영향 추정 (종가 위치 분석)
 *
 * 데이터: /data/ohlcv/*.json (일봉 OHLCV)
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const COMMISSION = 0.005;
const TAX = 0.0018;
const ROUND_TRIP = COMMISSION * 2 + TAX; // 1.18%
const MAX_PICKS = 10;
const DATE_FROM = '2025-03-20';
const DATE_TO = '2026-03-20';

// ─── 데이터 로드 ───
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

// ─── 프리셋 필터 (config.json과 동일) ───
const PRESETS = {
  aggressive: {
    label: '공격형(20%+,종가=고가)',
    filter: (bar) =>
      bar.changeRate >= 0.20 &&
      bar.closeHighRatio >= 1.0 &&
      bar.gapUp >= 0,
    sort: (a, b) => b.changeRate - a.changeRate,
  },
  balanced: {
    label: '균형형(10%+,종가≥98%고가)',
    filter: (bar) =>
      bar.changeRate >= 0.10 &&
      bar.closeHighRatio >= 0.98 &&
      bar.gapUp >= 0,
    sort: (a, b) => b.changeRate - a.changeRate,
  },
  stable: {
    label: '안정형(10%+,아꼬≤5%,거래대금≥10억)',
    filter: (bar) =>
      bar.changeRate >= 0.10 &&
      bar.lowerWick <= 0.05 &&
      bar.gapUp >= 0 &&
      bar.tradingValue >= 1_000_000_000,
    sort: (a, b) => b.changeRate - a.changeRate,
  },
};

// ─── 날짜별 전종목 바 데이터 (D, D+1, D+2까지 필요) ───
function buildDailyBars(allOHLCV) {
  const dailyBars = {};

  for (const [code, { data, dateMap }] of Object.entries(allOHLCV)) {
    for (let i = 10; i < data.length - 2; i++) {  // -2: D+1, D+2 필요
      const d = data[i];
      const prev = data[i - 1];
      const next = data[i + 1];       // D+1
      const next2 = data[i + 2];      // D+2
      if (!d.date || d.date < DATE_FROM || d.date > DATE_TO) continue;
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) continue;
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;
      if (!next.close || next.close <= 0 || !next2 || !next2.open || next2.open <= 0) continue;

      const changeRate = (d.close - prev.close) / prev.close;
      if (Math.abs(changeRate) > 0.30) continue; // 신규상장/이상치 제외

      const range = d.high - d.low;
      const tradingValue = d.close * d.volume;
      if (tradingValue < 1_000_000) continue;

      const gapUp = (d.open - prev.close) / prev.close;
      const bodyTop = Math.max(d.close, d.open);
      const bodyBot = Math.min(d.close, d.open);
      const upperWick = range > 0 ? (d.high - bodyTop) / range : 0;
      const lowerWick = range > 0 ? (bodyBot - d.low) / range : 0;
      const closeHighRatio = d.high > 0 ? d.close / d.high : 0;

      const bar = {
        code, changeRate, tradingValue, gapUp, upperWick, lowerWick, closeHighRatio,
        close: d.close, open: d.open, high: d.high, low: d.low, volume: d.volume,
        // D+1 데이터
        nextOpen: next.open,
        nextClose: next.close,
        nextHigh: next.high,
        nextLow: next.low,
        // D+2 데이터
        next2Open: next2.open,
      };

      if (!dailyBars[d.date]) dailyBars[d.date] = [];
      dailyBars[d.date].push(bar);
    }
  }
  return dailyBars;
}

// ═══════════════════════════════════════════════════════════════
// 분석 1: 매수 타이밍별 수익률 시뮬레이션
// ═══════════════════════════════════════════════════════════════
function analyzeTimingScenarios(dailyBars, dates, preset) {
  const { filter, sort, label } = preset;

  // 시나리오 정의
  const scenarios = {
    // 시나리오 A: 종가 매수 → 익일 시가 매도 (정상 오버나잇)
    'A_종가매수_익일시가매도': (bar) => ({
      buyPrice: bar.close,
      sellPrice: bar.nextOpen,
      ret: (bar.nextOpen - bar.close) / bar.close - ROUND_TRIP,
    }),
    // 시나리오 B: 익일 시가 매수 → 익일 시가 매도 (16:25 주문 = 다음날 시가 체결 시)
    // → 수익 0% - 수수료 = 확정 손실
    'B_익일시가매수_익일시가매도': (bar) => ({
      buyPrice: bar.nextOpen,
      sellPrice: bar.nextOpen,
      ret: 0 - ROUND_TRIP,
    }),
    // 시나리오 C: 익일 시가 매수 → 익일 종가 매도 (16:25가 다음날 시가, 매도도 다음날)
    'C_익일시가매수_익일종가매도': (bar) => ({
      buyPrice: bar.nextOpen,
      sellPrice: bar.nextClose,
      ret: (bar.nextClose - bar.nextOpen) / bar.nextOpen - ROUND_TRIP,
    }),
    // 시나리오 D: 시간외종가매수(=종가) → 익일 시가 매도 (15:40~16:00 체결)
    // → 종가와 동일하므로 시나리오 A와 같음
    'D_시간외종가매수_익일시가매도': (bar) => ({
      buyPrice: bar.close,
      sellPrice: bar.nextOpen,
      ret: (bar.nextOpen - bar.close) / bar.close - ROUND_TRIP,
    }),
    // 시나리오 E: 동시호가 전 매수(종가의 99% 추정) → 익일 시가 매도
    // 15:19 정규장 마지막 = 종가보다 약간 낮은 가격 추정
    'E_동시호가전매수(99%)_익일시가매도': (bar) => ({
      buyPrice: bar.close * 0.99,
      sellPrice: bar.nextOpen,
      ret: (bar.nextOpen - bar.close * 0.99) / (bar.close * 0.99) - ROUND_TRIP,
    }),
    // 시나리오 F: 동시호가 전 매수(종가의 98% 추정) → 익일 시가 매도
    'F_동시호가전매수(98%)_익일시가매도': (bar) => ({
      buyPrice: bar.close * 0.98,
      sellPrice: bar.nextOpen,
      ret: (bar.nextOpen - bar.close * 0.98) / (bar.close * 0.98) - ROUND_TRIP,
    }),
  };

  const results = {};

  for (const [name, calcFn] of Object.entries(scenarios)) {
    const trades = [];
    let capital = 500_000;

    for (const date of dates) {
      const bars = dailyBars[date];
      if (!bars) continue;

      const candidates = bars.filter(filter);
      if (candidates.length === 0) continue;

      candidates.sort(sort);
      const picks = candidates.slice(0, MAX_PICKS);
      const perStock = capital / picks.length;

      for (const bar of picks) {
        const { buyPrice, sellPrice, ret } = calcFn(bar);
        const qty = Math.floor(perStock / buyPrice);
        if (qty <= 0) continue;

        const pnl = qty * (sellPrice - buyPrice)
                     - qty * buyPrice * COMMISSION
                     - qty * sellPrice * (COMMISSION + TAX);
        capital += pnl;

        trades.push({
          date, code: bar.code,
          buyPrice, sellPrice,
          ret, pnl,
        });
      }
    }

    const wins = trades.filter(t => t.ret > 0).length;
    const avgRet = trades.length > 0 ? trades.reduce((s, t) => s + t.ret, 0) / trades.length : 0;

    // MDD 계산
    let peak = 500_000, mdd = 0, runCap = 500_000;
    for (const t of trades) {
      runCap += t.pnl;
      if (runCap > peak) peak = runCap;
      const dd = (peak - runCap) / peak;
      if (dd > mdd) mdd = dd;
    }

    results[name] = {
      trades: trades.length,
      wins,
      winRate: trades.length > 0 ? (wins / trades.length * 100).toFixed(1) + '%' : 'N/A',
      avgReturn: (avgRet * 100).toFixed(3) + '%',
      totalPnL: Math.round(capital - 500_000),
      finalCapital: Math.round(capital),
      mdd: (mdd * 100).toFixed(1) + '%',
    };
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// 분석 2: 오버나잇 갭 분포 (종가 → 익일 시가)
// ═══════════════════════════════════════════════════════════════
function analyzeOvernightGap(dailyBars, dates, preset) {
  const { filter, sort } = preset;
  const gaps = [];

  for (const date of dates) {
    const bars = dailyBars[date];
    if (!bars) continue;

    const candidates = bars.filter(filter);
    if (candidates.length === 0) continue;

    candidates.sort(sort);
    const picks = candidates.slice(0, MAX_PICKS);

    for (const bar of picks) {
      const gap = (bar.nextOpen - bar.close) / bar.close;
      gaps.push(gap);
    }
  }

  if (gaps.length === 0) return null;

  gaps.sort((a, b) => a - b);
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const median = gaps[Math.floor(gaps.length / 2)];
  const positive = gaps.filter(g => g > 0).length;
  const p25 = gaps[Math.floor(gaps.length * 0.25)];
  const p75 = gaps[Math.floor(gaps.length * 0.75)];

  // 분포 히스토그램
  const bins = {};
  for (const g of gaps) {
    const pct = Math.round(g * 100);
    const binKey = pct < -5 ? '≤-5%' : pct > 10 ? '≥+10%' : `${pct >= 0 ? '+' : ''}${pct}%`;
    bins[binKey] = (bins[binKey] || 0) + 1;
  }

  return {
    count: gaps.length,
    avg: (avg * 100).toFixed(3) + '%',
    median: (median * 100).toFixed(3) + '%',
    p25: (p25 * 100).toFixed(3) + '%',
    p75: (p75 * 100).toFixed(3) + '%',
    positiveRate: (positive / gaps.length * 100).toFixed(1) + '%',
    min: (gaps[0] * 100).toFixed(2) + '%',
    max: (gaps[gaps.length - 1] * 100).toFixed(2) + '%',
    distribution: bins,
  };
}

// ═══════════════════════════════════════════════════════════════
// 분석 3: 동시호가 영향 추정 (종가의 일중 위치)
// ═══════════════════════════════════════════════════════════════
function analyzeDongsihoga(dailyBars, dates, preset) {
  const { filter, sort } = preset;
  const stats = {
    closeIsHigh: 0,        // 종가 = 고가 (동시호가가 최고가를 만든 케이스)
    closeNearHigh: 0,      // 종가 ≥ 고가*98%
    closeAboveVWAP: 0,     // 종가 > (open+high+low+close)/4 (= 대략적 평균가)
    avgClosePosition: 0,   // 종가의 일중 위치 (0=저가, 1=고가)
    total: 0,
    // 동시호가 전 추정가 = 종가보다 낮을 확률 추정
    // close=high인 종목에서, 장중 움직임 기반 추정
    closeHighDiffPcts: [],
  };

  for (const date of dates) {
    const bars = dailyBars[date];
    if (!bars) continue;

    const candidates = bars.filter(filter);
    if (candidates.length === 0) continue;

    candidates.sort(sort);
    const picks = candidates.slice(0, MAX_PICKS);

    for (const bar of picks) {
      stats.total++;
      const range = bar.high - bar.low;
      if (range <= 0) continue;

      const closePos = (bar.close - bar.low) / range;  // 0~1
      stats.avgClosePosition += closePos;

      if (bar.close >= bar.high) stats.closeIsHigh++;
      if (bar.close >= bar.high * 0.98) stats.closeNearHigh++;

      const vwapProxy = (bar.open + bar.high + bar.low + bar.close) / 4;
      if (bar.close > vwapProxy) stats.closeAboveVWAP++;

      // 종가=고가인 경우, 시가대비 얼마나 올랐는지 → 동시호가 전 가격 추정의 근거
      if (bar.close >= bar.high * 0.99) {
        const runUp = (bar.close - bar.open) / bar.open;
        stats.closeHighDiffPcts.push(runUp);
      }
    }
  }

  if (stats.total === 0) return null;

  stats.avgClosePosition = (stats.avgClosePosition / stats.total).toFixed(3);

  // 동시호가 전 가격 추정
  // 급등주(20%+)에서 종가=고가인 경우, 동시호가가 추가로 올리는 비율 추정
  let dongsihogaEffect = 'N/A';
  if (stats.closeHighDiffPcts.length > 10) {
    const pcts = stats.closeHighDiffPcts.sort((a, b) => a - b);
    const med = pcts[Math.floor(pcts.length / 2)];
    dongsihogaEffect = (med * 100).toFixed(2) + '%';
  }

  return {
    total: stats.total,
    closeIsHigh: stats.closeIsHigh,
    closeIsHighPct: (stats.closeIsHigh / stats.total * 100).toFixed(1) + '%',
    closeNearHighPct: (stats.closeNearHigh / stats.total * 100).toFixed(1) + '%',
    closeAboveVWAPPct: (stats.closeAboveVWAP / stats.total * 100).toFixed(1) + '%',
    avgClosePosition: stats.avgClosePosition + ' (0=저가, 1=고가)',
    dongsihogaEstimatedRunup: dongsihogaEffect,
    interpretation: stats.closeIsHigh / stats.total > 0.5
      ? '종가=고가 비율 높음 → 동시호가에서 추가 상승 가능성 ↑ → 동시호가 전 매수가 유리'
      : '종가=고가 비율 낮음 → 동시호가 영향 제한적',
  };
}

// ═══════════════════════════════════════════════════════════════
// 분석 4: 슬리피지 시뮬레이션 (매수가가 종가 대비 X% 다를 때)
// ═══════════════════════════════════════════════════════════════
function analyzeSlippage(dailyBars, dates, preset) {
  const { filter, sort } = preset;
  const slippages = [
    { name: '종가 정확 체결 (동시호가/시간외)', slip: 0 },
    { name: '종가 -0.5% (15:19 정규장)', slip: -0.005 },
    { name: '종가 -1.0% (15:15 정규장)', slip: -0.01 },
    { name: '종가 -2.0% (15:10 정규장)', slip: -0.02 },
    { name: '종가 +1.0% (다음날 갭업 체결)', slip: 0.01 },
    { name: '종가 +2.0% (다음날 갭업 체결)', slip: 0.02 },
    { name: '종가 +3.0% (다음날 갭업 체결)', slip: 0.03 },
  ];

  const results = [];

  for (const { name, slip } of slippages) {
    const trades = [];
    let capital = 500_000;

    for (const date of dates) {
      const bars = dailyBars[date];
      if (!bars) continue;

      const candidates = bars.filter(filter);
      if (candidates.length === 0) continue;

      candidates.sort(sort);
      const picks = candidates.slice(0, MAX_PICKS);
      const perStock = capital / picks.length;

      for (const bar of picks) {
        const buyPrice = bar.close * (1 + slip);
        const sellPrice = bar.nextOpen;
        const ret = (sellPrice - buyPrice) / buyPrice - ROUND_TRIP;
        const qty = Math.floor(perStock / buyPrice);
        if (qty <= 0) continue;

        const pnl = qty * (sellPrice - buyPrice)
                     - qty * buyPrice * COMMISSION
                     - qty * sellPrice * (COMMISSION + TAX);
        capital += pnl;
        trades.push({ ret, pnl });
      }
    }

    const wins = trades.filter(t => t.ret > 0).length;
    const avgRet = trades.length > 0 ? trades.reduce((s, t) => s + t.ret, 0) / trades.length : 0;

    results.push({
      scenario: name,
      slippage: (slip * 100).toFixed(1) + '%',
      trades: trades.length,
      winRate: trades.length > 0 ? (wins / trades.length * 100).toFixed(1) + '%' : 'N/A',
      avgReturn: (avgRet * 100).toFixed(3) + '%',
      totalPnL: Math.round(capital - 500_000),
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// 분석 5: 시간대별 체결 가능성 (시장 구조 기반)
// ═══════════════════════════════════════════════════════════════
function marketStructureAnalysis() {
  return {
    '15:10_정규장': {
      체결방식: '즉시 체결 (연속매매)',
      체결가격: '현재 호가에 즉시 체결',
      종가대비: '종가보다 1~3% 낮을 가능성 (급등주는 마지막에 더 오르는 경향)',
      체결확률: '높음 (호가창 두꺼움)',
      리스크: '종가까지 추가 상승분을 놓침',
      적합성: '★★★☆☆',
    },
    '15:19_정규장마지막': {
      체결방식: '즉시 체결 (연속매매 마지막)',
      체결가격: '종가에 매우 근접 (±0.5%)',
      종가대비: '종가보다 0~1% 낮을 가능성',
      체결확률: '높음',
      리스크: '동시호가 추가 상승분 놓침 (종가=고가 종목)',
      적합성: '★★★★☆',
    },
    '15:20~29_동시호가': {
      체결방식: '15:30 일괄 체결 (종가 확정)',
      체결가격: '종가와 동일 (정의상)',
      종가대비: '0% (종가 = 동시호가 체결가)',
      체결확률: '보통 (급등주는 매도물량 부족할 수 있음)',
      리스크: '종가가 예상보다 높게 확정될 수 있음',
      적합성: '★★★★★',
    },
    '15:40~16:00_시간외종가': {
      체결방식: '종가로 거래 (시간외 단일가)',
      체결가격: '종가와 동일',
      종가대비: '0%',
      체결확률: '낮음 (급등주는 매도호가 없음, 시간외 거래량 극소)',
      리스크: '미체결 위험 높음',
      적합성: '★★☆☆☆',
    },
    '16:25_현재설정': {
      체결방식: '❌ 장종료 후 → 예약주문 → 익일 시가 체결',
      체결가격: '익일 시가 (당일 종가 아님!)',
      종가대비: '오버나잇 갭만큼 불리 (+2~5% 높은 가격에 매수)',
      체결확률: '높음 (시가는 대부분 체결)',
      리스크: '오버나잇 수익을 매수가에 선반영 → 수익 소멸',
      적합성: '★☆☆☆☆ (치명적 문제)',
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// 메인 실행
// ═══════════════════════════════════════════════════════════════
function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  번트 매수 타이밍 분석 — 종가 매수 vs 시가 매수');
  console.log(`  분석 기간: ${DATE_FROM} ~ ${DATE_TO}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('[1/5] OHLCV 데이터 로드...');
  const allOHLCV = loadAllOHLCV();
  console.log(`  → ${Object.keys(allOHLCV).length}개 종목 로드 완료`);

  console.log('[2/5] 일별 바 데이터 구축...');
  const dailyBars = buildDailyBars(allOHLCV);
  const dates = Object.keys(dailyBars).sort();
  console.log(`  → ${dates.length}개 거래일 구축 완료\n`);

  // ─── 프리셋별 분석 ───
  for (const [presetName, preset] of Object.entries(PRESETS)) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  프리셋: ${preset.label}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 분석 1: 시나리오별 수익률
    console.log('【분석 1】 매수 타이밍별 수익률 시뮬레이션');
    console.log('─────────────────────────────────────────');
    const scenarioResults = analyzeTimingScenarios(dailyBars, dates, preset);
    for (const [name, r] of Object.entries(scenarioResults)) {
      console.log(`\n  📌 ${name}`);
      console.log(`     거래수: ${r.trades}건 | 승률: ${r.winRate} | 건당 EV: ${r.avgReturn}`);
      console.log(`     총손익: ${r.totalPnL > 0 ? '+' : ''}${r.totalPnL.toLocaleString()}원 | 최종자본: ${r.finalCapital.toLocaleString()}원 | MDD: ${r.mdd}`);
    }

    // 분석 2: 오버나잇 갭 분포
    console.log('\n\n【분석 2】 오버나잇 갭 분포 (종가 → 익일 시가)');
    console.log('─────────────────────────────────────────');
    const gapResult = analyzeOvernightGap(dailyBars, dates, preset);
    if (gapResult) {
      console.log(`  표본: ${gapResult.count}건`);
      console.log(`  평균 갭: ${gapResult.avg} | 중앙값: ${gapResult.median}`);
      console.log(`  25%ile: ${gapResult.p25} | 75%ile: ${gapResult.p75}`);
      console.log(`  최소: ${gapResult.min} | 최대: ${gapResult.max}`);
      console.log(`  양의 갭(갭업) 비율: ${gapResult.positiveRate}`);
      console.log(`  분포:`);
      const sortedBins = Object.entries(gapResult.distribution)
        .sort((a, b) => {
          const numA = parseInt(a[0].replace(/[^-\d]/g, '')) || 0;
          const numB = parseInt(b[0].replace(/[^-\d]/g, '')) || 0;
          return numA - numB;
        });
      for (const [bin, count] of sortedBins) {
        const bar = '█'.repeat(Math.min(50, Math.round(count / gapResult.count * 100)));
        console.log(`    ${bin.padStart(6)}: ${bar} (${count}건, ${(count/gapResult.count*100).toFixed(1)}%)`);
      }
    }

    // 분석 3: 동시호가 영향
    console.log('\n\n【분석 3】 동시호가 영향 추정');
    console.log('─────────────────────────────────────────');
    const dongsiResult = analyzeDongsihoga(dailyBars, dates, preset);
    if (dongsiResult) {
      console.log(`  총 표본: ${dongsiResult.total}건`);
      console.log(`  종가=고가 비율: ${dongsiResult.closeIsHighPct}`);
      console.log(`  종가≥98%고가: ${dongsiResult.closeNearHighPct}`);
      console.log(`  종가>VWAP: ${dongsiResult.closeAboveVWAPPct}`);
      console.log(`  종가의 일중 위치: ${dongsiResult.avgClosePosition}`);
      console.log(`  종가=고가 종목의 시가대비 상승폭(중앙값): ${dongsiResult.dongsihogaEstimatedRunup}`);
      console.log(`  → 해석: ${dongsiResult.interpretation}`);
    }

    // 분석 4: 슬리피지 시뮬레이션
    console.log('\n\n【분석 4】 매수가 슬리피지별 수익률 변화');
    console.log('─────────────────────────────────────────');
    const slipResults = analyzeSlippage(dailyBars, dates, preset);
    console.log('  ' + '시나리오'.padEnd(35) + '슬리피지'.padEnd(10) + '거래수'.padEnd(8) + '승률'.padEnd(8) + 'EV'.padEnd(10) + '총손익');
    console.log('  ' + '─'.repeat(85));
    for (const r of slipResults) {
      const pnlStr = (r.totalPnL > 0 ? '+' : '') + r.totalPnL.toLocaleString() + '원';
      console.log(`  ${r.scenario.padEnd(33)} ${r.slippage.padEnd(10)}${String(r.trades).padEnd(8)}${r.winRate.padEnd(8)}${r.avgReturn.padEnd(10)}${pnlStr}`);
    }

    console.log('\n');
  }

  // 분석 5: 시장 구조 분석
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('【분석 5】 시간대별 체결 방식 & 적합성 (시장 구조)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const marketResult = marketStructureAnalysis();
  for (const [time, info] of Object.entries(marketResult)) {
    console.log(`  ⏰ ${time}`);
    for (const [key, val] of Object.entries(info)) {
      console.log(`     ${key}: ${val}`);
    }
    console.log();
  }

  // ─── 최종 결론 ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  최종 결론');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('  1. 현재 16:25 설정은 장종료 후 → 오버나잇 수익을 포기하는 구조');
  console.log('  2. 종가 매수(=동시호가 참여)가 오버나잇 전략의 핵심');
  console.log('  3. 추천 매수 시간:');
  console.log('     [1순위] 15:25 — 동시호가 참여 (15:30 종가로 체결, 가장 정확)');
  console.log('     [2순위] 15:19 — 정규장 마지막 (종가 근사치, 즉시 체결)');
  console.log('     [비추천] 15:40~16:00 — 시간외 종가 (체결률 낮음)');
  console.log('     [금지]   16:25 — 장종료 후 (오버나잇 수익 소멸)\n');
  console.log('  4. 스캔 시간도 조정 필요:');
  console.log('     현재 16:20 → 15:15~15:20으로 변경 권장\n');

  // ─── 결과 저장 ───
  const output = {
    analysisDate: new Date().toISOString(),
    period: { from: DATE_FROM, to: DATE_TO },
    presets: {},
    marketStructure: marketResult,
  };

  for (const [presetName, preset] of Object.entries(PRESETS)) {
    output.presets[presetName] = {
      label: preset.label,
      scenarios: analyzeTimingScenarios(dailyBars, dates, preset),
      overnightGap: analyzeOvernightGap(dailyBars, dates, preset),
      dongsihoga: analyzeDongsihoga(dailyBars, dates, preset),
      slippage: analyzeSlippage(dailyBars, dates, preset),
    };
  }

  const outPath = path.join(__dirname, '..', 'results', 'buy-timing-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`결과 저장: ${outPath}`);
}

main();
