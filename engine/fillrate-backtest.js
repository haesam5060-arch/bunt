#!/usr/bin/env node
/**
 * 번트 체결률 개선 백테스트
 * ──────────────────────────────────────────────────────────
 * 상한가(30%) 종목은 실전에서 체결 불가 → 필터 조건별 수익률 비교
 *
 * 비교 시나리오:
 * [A] 현행: 등락≥20%, 종/고=100%, 갭업≥0%
 * [B] 상한가 제외: 등락 20~29%, 종/고=100%, 갭업≥0%
 * [C] 종/고 완화: 등락≥20%, 종/고≥98%, 갭업≥0%
 * [D] 둘 다: 등락 20~29%, 종/고≥98%, 갭업≥0%
 * [E] 15~29%: 등락 15~29%, 종/고=100%, 갭업≥0%
 * [F] 15~29% + 종/고완화: 등락 15~29%, 종/고≥98%, 갭업≥0%
 * [G] 10~29%: 등락 10~29%, 종/고=100%, 갭업≥0%
 * [H] 10~29% + 종/고완화: 등락 10~29%, 종/고≥98%, 갭업≥0%
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const COMMISSION = 0.005;
const TAX = 0.0018;
const ROUND_TRIP = COMMISSION * 2 + TAX;
const SEED = 5_000_000;
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

function buildDailyBars(allOHLCV) {
  const dailyBars = {};
  for (const [code, { data }] of Object.entries(allOHLCV)) {
    for (let i = 5; i < data.length - 1; i++) {
      const d = data[i];
      const prev = data[i - 1];
      const next = data[i + 1];
      if (!d.date || d.date < DATE_FROM || d.date > DATE_TO) continue;
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) continue;
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;

      const changeRate = (d.close - prev.close) / prev.close;
      if (changeRate > 0.32 || changeRate < -0.32) continue; // 신규상장 제외

      const tradingValue = d.close * d.volume;
      if (tradingValue < 1_000_000) continue;

      const closeHighPct = d.high > 0 ? d.close / d.high : 0;
      const gapUp = (d.open - prev.close) / prev.close;
      const overnight = (next.open - d.close) / d.close;
      const isLimitUp = changeRate >= 0.29; // 상한가 여부

      if (!dailyBars[d.date]) dailyBars[d.date] = [];
      dailyBars[d.date].push({
        code, changeRate, closeHighPct, gapUp, overnight,
        tradingValue, isLimitUp,
        close: d.close, high: d.high,
      });
    }
  }
  return dailyBars;
}

// 시나리오 정의
const scenarios = {
  'A_현행(20%+,종고100%)': { minCR: 0.20, maxCR: 1.0,  minCHP: 1.00, minGap: 0 },
  'B_상한제외(20-29%)':     { minCR: 0.20, maxCR: 0.29, minCHP: 1.00, minGap: 0 },
  'C_종고완화(20%+,98%)':  { minCR: 0.20, maxCR: 1.0,  minCHP: 0.98, minGap: 0 },
  'D_둘다(20-29%,98%)':    { minCR: 0.20, maxCR: 0.29, minCHP: 0.98, minGap: 0 },
  'E_15-29%_종고100%':     { minCR: 0.15, maxCR: 0.29, minCHP: 1.00, minGap: 0 },
  'F_15-29%_종고98%':      { minCR: 0.15, maxCR: 0.29, minCHP: 0.98, minGap: 0 },
  'G_10-29%_종고100%':     { minCR: 0.10, maxCR: 0.29, minCHP: 1.00, minGap: 0 },
  'H_10-29%_종고98%':      { minCR: 0.10, maxCR: 0.29, minCHP: 0.98, minGap: 0 },
};

function runScenario(name, params, dailyBars, dates) {
  let capital = SEED;
  let wins = 0, losses = 0;
  let totalReturn = 0;
  let maxCapital = SEED, maxDD = 0;
  let tradingDays = 0;
  let limitUpCount = 0;
  let totalPicks = 0;

  for (const date of dates) {
    const bars = dailyBars[date];
    if (!bars) continue;

    // 필터
    let candidates = bars.filter(b =>
      b.changeRate >= params.minCR &&
      b.changeRate < params.maxCR &&
      b.closeHighPct >= params.minCHP &&
      b.gapUp >= params.minGap
    );

    if (candidates.length === 0) continue;

    // 등락률 내림차순 정렬 + 최대 10개
    candidates.sort((a, b) => b.changeRate - a.changeRate);
    candidates = candidates.slice(0, MAX_PICKS);

    tradingDays++;
    totalPicks += candidates.length;
    limitUpCount += candidates.filter(c => c.isLimitUp).length;

    const perStock = capital / candidates.length;

    for (const c of candidates) {
      const qty = Math.floor(perStock / c.close);
      if (qty <= 0) continue;
      const invested = qty * c.close;
      const returnAmt = qty * c.close * c.overnight;
      const cost = invested * ROUND_TRIP;
      const net = returnAmt - cost;
      capital += net;
      totalReturn += net;
      if (net > 0) wins++; else losses++;
    }

    if (capital > maxCapital) maxCapital = capital;
    const dd = (maxCapital - capital) / maxCapital;
    if (dd > maxDD) maxDD = dd;
  }

  const total = wins + losses;
  return {
    name,
    trades: total,
    tradingDays,
    avgPicksPerDay: tradingDays > 0 ? +(totalPicks / tradingDays).toFixed(1) : 0,
    wins, losses,
    winRate: total > 0 ? +(wins / total * 100).toFixed(1) : 0,
    avgReturn: total > 0 ? +(totalReturn / total).toFixed(0) : 0,
    ev: total > 0 ? +((totalReturn / total) / (SEED / MAX_PICKS) * 100).toFixed(2) : 0,
    totalReturn: Math.round(totalReturn),
    finalCapital: Math.round(capital),
    capitalPct: +((capital - SEED) / SEED * 100).toFixed(1),
    maxDD: +(maxDD * 100).toFixed(1),
    limitUpPct: totalPicks > 0 ? +(limitUpCount / totalPicks * 100).toFixed(1) : 0,
  };
}

// ── 실행 ──
console.log('데이터 로딩...');
const allOHLCV = loadAllOHLCV();
console.log(`${Object.keys(allOHLCV).length}개 종목 로드`);

const dates = getTradingDates(allOHLCV);
console.log(`거래일: ${dates.length}일 (${DATE_FROM} ~ ${DATE_TO})\n`);

const dailyBars = buildDailyBars(allOHLCV);

console.log('═══════════════════════════════════════════════════════════════');
console.log(' 체결률 개선 백테스트 — 시나리오별 비교');
console.log('═══════════════════════════════════════════════════════════════');

const results = [];
for (const [name, params] of Object.entries(scenarios)) {
  const r = runScenario(name, params, dailyBars, dates);
  results.push(r);
}

// 표 출력
console.log('\n시나리오               | 거래수 | 일평균 | 승률   | 건당EV  | 총수익       | 수익률  | MDD   | 상한가%');
console.log('─────────────────────────────────────────────────────────────────────────────────────────────────────');
for (const r of results) {
  const pad = (s, n) => String(s).padStart(n);
  console.log(
    `${r.name.padEnd(22)} | ${pad(r.trades, 5)} | ${pad(r.avgPicksPerDay, 5)} | ${pad(r.winRate + '%', 5)} | ${pad(r.ev + '%', 6)} | ${pad(r.totalReturn.toLocaleString() + '원', 12)} | ${pad(r.capitalPct + '%', 6)} | ${pad(r.maxDD + '%', 5)} | ${pad(r.limitUpPct + '%', 5)}`
  );
}

// 결과 저장
fs.writeFileSync(
  path.join(__dirname, '..', 'results', 'fillrate-backtest.json'),
  JSON.stringify(results, null, 2), 'utf8'
);
console.log('\n결과 저장: results/fillrate-backtest.json');
