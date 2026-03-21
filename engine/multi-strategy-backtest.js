#!/usr/bin/env node
/**
 * 번트 멀티 전략 백테스트 — 6가지 오버나잇 전략 동시 검증
 * ──────────────────────────────────────────────────────────
 * 모든 전략: 종가매수 → 익일 시가매도
 *
 * [2] 거래량 폭발 + 보합 (쥐어짜기)
 * [3] 실패한 갭업 (갭업 출발 → 음봉 마감)
 * [4] 연속 N일 상승/하락 (모멘텀 vs 평균회귀)
 * [5] 윗꼬리 긴 종목 (천장 신호?)
 * [6] 종가 = 저가 (바닥 다지기?)
 * [8] 상한가 따라잡기 (29%+)
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

// ─── 날짜별 전종목 바 데이터 사전 계산 (성능 최적화) ───
function buildDailyBars(allOHLCV) {
  const dailyBars = {};  // { date: [ { code, ...indicators } ] }

  for (const [code, { data, dateMap }] of Object.entries(allOHLCV)) {
    for (let i = 10; i < data.length - 1; i++) {
      const d = data[i];
      const prev = data[i - 1];
      const next = data[i + 1];
      if (!d.date || d.date < DATE_FROM || d.date > DATE_TO) continue;
      if (!d.close || !d.open || !d.high || !d.low || d.close <= 0 || d.open <= 0) continue;
      if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;

      const changeRate = (d.close - prev.close) / prev.close;
      if (Math.abs(changeRate) > 0.30) continue; // 신규상장 제외

      const range = d.high - d.low;
      const overnight = (next.open - d.close) / d.close;
      const tradingValue = d.close * d.volume;

      // 유동성 최소 필터
      if (tradingValue < 1_000_000) continue;

      // 거래량 5일 평균
      let v5 = 0;
      for (let j = i - 5; j < i; j++) v5 += (data[j]?.volume || 0);
      const avgV5 = v5 / 5;
      const volRatio5 = avgV5 > 0 ? d.volume / avgV5 : 0;

      // 갭업률
      const gapUp = (d.open - prev.close) / prev.close;

      // 캔들 구조
      const bodyTop = Math.max(d.close, d.open);
      const bodyBot = Math.min(d.close, d.open);
      const upperWick = range > 0 ? (d.high - bodyTop) / range : 0;
      const lowerWick = range > 0 ? (bodyBot - d.low) / range : 0;
      const closeLowRatio = d.low > 0 ? d.close / d.low : 1;
      const closeHighRatio = d.high > 0 ? d.close / d.high : 0;
      const isRedCandle = d.close < d.open;  // 음봉

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

      const bar = {
        code, overnight, changeRate, tradingValue, volRatio5,
        gapUp, upperWick, lowerWick, closeLowRatio, closeHighRatio,
        isRedCandle, consecUp, consecDown, range,
        close: d.close, open: d.open, high: d.high, low: d.low, volume: d.volume,
      };

      if (!dailyBars[d.date]) dailyBars[d.date] = [];
      dailyBars[d.date].push(bar);
    }
  }
  return dailyBars;
}

// ═══════════════════════════════════════════════════════════════
// 6개 전략 필터 정의
// ═══════════════════════════════════════════════════════════════

const STRATEGIES = [
  // ── [2] 거래량 폭발 + 보합 (쥐어짜기) ──
  {
    name: '거래량폭발+보합(2x)',
    desc: '거래량 5일평균 2배+, 등락률 -2%~+2%',
    filter: (bar) =>
      bar.volRatio5 >= 2.0 &&
      bar.changeRate >= -0.02 && bar.changeRate <= 0.02,
    sort: (a, b) => b.volRatio5 - a.volRatio5,
  },
  {
    name: '거래량폭발+보합(3x)',
    desc: '거래량 5일평균 3배+, 등락률 -2%~+2%',
    filter: (bar) =>
      bar.volRatio5 >= 3.0 &&
      bar.changeRate >= -0.02 && bar.changeRate <= 0.02,
    sort: (a, b) => b.volRatio5 - a.volRatio5,
  },

  // ── [3] 실패한 갭업 ──
  {
    name: '실패한 갭업(2%+)',
    desc: '시가>전일종가+2%, 음봉 마감',
    filter: (bar) =>
      bar.gapUp >= 0.02 &&
      bar.isRedCandle,
    sort: (a, b) => b.gapUp - a.gapUp,
  },
  {
    name: '실패한 갭업(3%+)',
    desc: '시가>전일종가+3%, 음봉 마감',
    filter: (bar) =>
      bar.gapUp >= 0.03 &&
      bar.isRedCandle,
    sort: (a, b) => b.gapUp - a.gapUp,
  },
  {
    name: '실패한 갭업(5%+)',
    desc: '시가>전일종가+5%, 음봉 마감',
    filter: (bar) =>
      bar.gapUp >= 0.05 &&
      bar.isRedCandle,
    sort: (a, b) => b.gapUp - a.gapUp,
  },

  // ── [4] 연속 상승 (모멘텀 관성) ──
  {
    name: '3일연속상승',
    desc: '3일 연속 양봉',
    filter: (bar) => bar.consecUp >= 3,
    sort: (a, b) => b.changeRate - a.changeRate,
  },
  {
    name: '5일연속상승',
    desc: '5일 연속 양봉',
    filter: (bar) => bar.consecUp >= 5,
    sort: (a, b) => b.changeRate - a.changeRate,
  },

  // ── [4] 연속 하락 (평균회귀) ──
  {
    name: '3일연속하락',
    desc: '3일 연속 음봉',
    filter: (bar) => bar.consecDown >= 3,
    sort: (a, b) => a.changeRate - b.changeRate,
  },
  {
    name: '5일연속하락',
    desc: '5일 연속 음봉',
    filter: (bar) => bar.consecDown >= 5,
    sort: (a, b) => a.changeRate - b.changeRate,
  },

  // ── [5] 윗꼬리 긴 종목 ──
  {
    name: '윗꼬리50%+상승3%',
    desc: '윗꼬리/범위>50%, 등락률 3%+',
    filter: (bar) =>
      bar.upperWick >= 0.50 &&
      bar.range > 0 &&
      bar.changeRate >= 0.03,
    sort: (a, b) => b.upperWick - a.upperWick,
  },
  {
    name: '윗꼬리60%+상승3%',
    desc: '윗꼬리/범위>60%, 등락률 3%+',
    filter: (bar) =>
      bar.upperWick >= 0.60 &&
      bar.range > 0 &&
      bar.changeRate >= 0.03,
    sort: (a, b) => b.upperWick - a.upperWick,
  },

  // ── [6] 종가 = 저가 (바닥권 마감) ──
  {
    name: '종가=저가(3%하락)',
    desc: '종가/저가 100%, 등락률 -3% 이하',
    filter: (bar) =>
      bar.closeLowRatio <= 1.005 &&
      bar.changeRate <= -0.03,
    sort: (a, b) => a.changeRate - b.changeRate,
  },
  {
    name: '종가=저가(5%하락)',
    desc: '종가/저가 100%, 등락률 -5% 이하',
    filter: (bar) =>
      bar.closeLowRatio <= 1.005 &&
      bar.changeRate <= -0.05,
    sort: (a, b) => a.changeRate - b.changeRate,
  },

  // ── [8] 상한가 따라잡기 ──
  {
    name: '상한가(29%+)',
    desc: '등락률 29%+ (상한가)',
    filter: (bar) => bar.changeRate >= 0.29,
    sort: (a, b) => b.changeRate - a.changeRate,
  },
  {
    name: '급등(15%+)',
    desc: '등락률 15%+ (급등)',
    filter: (bar) => bar.changeRate >= 0.15 && bar.changeRate < 0.29,
    sort: (a, b) => b.changeRate - a.changeRate,
  },

  // ── 기준선: 현재 번트 (비교용) ──
  {
    name: '번트현행(20%+고가)',
    desc: '등락률 20%+, 종가=고가, 갭업',
    filter: (bar) =>
      bar.changeRate >= 0.20 &&
      bar.changeRate <= 0.30 &&
      bar.closeHighRatio >= 1.0 &&
      bar.gapUp >= 0,
    sort: (a, b) => b.changeRate - a.changeRate,
  },
];

// ═══════════════════════════════════════════════════════════════
// 시뮬레이션 엔진 (공용)
// ═══════════════════════════════════════════════════════════════

function runStrategy(dailyBars, tradingDates, strategy) {
  let capital = SEED;
  let totalTrades = 0, totalWins = 0, totalLosses = 0;
  let totalNetSum = 0, totalGrossSum = 0;
  let peakCapital = SEED, maxDD = 0;
  let signalDays = 0, winDays = 0;
  const allReturns = [];
  const monthlyPnl = {};

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    const sellDate = tradingDates[di + 1];
    const month = buyDate.slice(0, 7);
    if (!monthlyPnl[month]) monthlyPnl[month] = { trades: 0, wins: 0, pnlSum: 0, endCapital: capital };

    const bars = dailyBars[buyDate];
    if (!bars) { monthlyPnl[month].endCapital = capital; continue; }

    // 필터 적용
    let picks = bars.filter(strategy.filter);
    if (picks.length === 0) { monthlyPnl[month].endCapital = capital; continue; }

    // 정렬 + MAX_PICKS 제한
    picks.sort(strategy.sort);
    picks = picks.slice(0, MAX_PICKS);

    signalDays++;
    const perStock = capital / picks.length;
    let dayPnl = 0, dayWins = 0, dayLosses = 0;

    for (const p of picks) {
      const grossReturn = p.overnight;
      const netReturn = grossReturn - ROUND_TRIP;
      const pnl = perStock * netReturn;
      dayPnl += pnl;
      if (netReturn > 0) dayWins++; else dayLosses++;
      allReturns.push({ net: netReturn, gross: grossReturn });
      totalNetSum += netReturn;
      totalGrossSum += grossReturn;
    }

    capital += dayPnl;
    totalTrades += picks.length;
    totalWins += dayWins;
    totalLosses += dayLosses;

    if (dayPnl > 0) winDays++;
    if (capital > peakCapital) peakCapital = capital;
    const dd = (peakCapital - capital) / peakCapital;
    if (dd > maxDD) maxDD = dd;

    monthlyPnl[month].trades += picks.length;
    monthlyPnl[month].wins += dayWins;
    monthlyPnl[month].pnlSum += dayPnl;
    monthlyPnl[month].endCapital = capital;
  }

  allReturns.sort((a, b) => a.net - b.net);
  const median = allReturns.length > 0 ? allReturns[Math.floor(allReturns.length / 2)].net : 0;
  const p10 = allReturns.length > 0 ? allReturns[Math.floor(allReturns.length * 0.1)].net : 0;
  const p90 = allReturns.length > 0 ? allReturns[Math.floor(allReturns.length * 0.9)].net : 0;
  const bigWins = allReturns.filter(r => r.net > 0.05).length;
  const bigLosses = allReturns.filter(r => r.net < -0.05).length;

  return {
    name: strategy.name,
    desc: strategy.desc,
    capital, totalTrades, totalWins, totalLosses,
    totalNetSum, totalGrossSum,
    maxDD, signalDays, winDays,
    median, p10, p90, bigWins, bigLosses,
    monthlyPnl,
  };
}

// ═══════════════════════════════════════════════════════════════
// 메인
// ═══════════════════════════════════════════════════════════════

function main() {
  console.log('━'.repeat(80));
  console.log('  번트 멀티 전략 백테스트 — 6가지 오버나잇 전략 동시 검증');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO} | 시드: ${SEED.toLocaleString()}원 | 수수료: ${(ROUND_TRIP * 100).toFixed(2)}%`);
  console.log('━'.repeat(80));

  const allOHLCV = loadAllOHLCV();
  const nameMap = loadNameMap();
  console.log(`\n  종목 로드: ${Object.keys(allOHLCV).length}개`);

  const tradingDates = getTradingDates(allOHLCV);
  console.log(`  거래일: ${tradingDates.length}일 (${tradingDates[0]} ~ ${tradingDates[tradingDates.length - 1]})`);

  console.log(`\n  날짜별 바 데이터 사전계산 중...`);
  const dailyBars = buildDailyBars(allOHLCV);
  const totalBars = Object.values(dailyBars).reduce((s, arr) => s + arr.length, 0);
  console.log(`  완료: ${Object.keys(dailyBars).length}일 × 평균 ${Math.round(totalBars / Object.keys(dailyBars).length)}종목 = ${totalBars.toLocaleString()}건\n`);

  // 전략별 실행
  const results = [];
  for (const st of STRATEGIES) {
    process.stdout.write(`  [실행] ${st.name.padEnd(20)} ... `);
    const r = runStrategy(dailyBars, tradingDates, st);
    results.push(r);
    const avgNet = r.totalTrades > 0 ? (r.totalNetSum / r.totalTrades * 100).toFixed(2) : '-';
    const wr = r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : '-';
    console.log(`${String(r.totalTrades).padStart(5)}건  승률 ${wr}%  EV ${avgNet}%`);
  }

  // ═══ 카테고리별 비교 리포트 ═══
  console.log(`\n\n${'━'.repeat(80)}`);
  console.log('                         전략 비교 종합 리포트');
  console.log('━'.repeat(80));

  // 전체 요약 테이블
  console.log(`\n  ${'전략'.padEnd(22)} ${'거래'.padStart(5)} ${'승률'.padStart(6)} ${'일승률'.padStart(6)} ${'EV(순)'.padStart(8)} ${'EV(총)'.padStart(8)} ${'중앙값'.padStart(8)} ${'최종자본'.padStart(12)} ${'수익률'.padStart(8)} ${'MDD'.padStart(7)} ${'시그널일'.padStart(6)}`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)}`);

  for (const r of results) {
    const wr = r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : '-';
    const dwr = r.signalDays > 0 ? (r.winDays / r.signalDays * 100).toFixed(1) : '-';
    const avgNet = r.totalTrades > 0 ? (r.totalNetSum / r.totalTrades * 100).toFixed(2) : '-';
    const avgGross = r.totalTrades > 0 ? (r.totalGrossSum / r.totalTrades * 100).toFixed(2) : '-';
    const medianPct = (r.median * 100).toFixed(2);
    const totalRet = ((r.capital - SEED) / SEED * 100).toFixed(1);
    const mdd = (r.maxDD * 100).toFixed(1);

    console.log(`  ${r.name.padEnd(22)} ${String(r.totalTrades).padStart(5)} ${(wr + '%').padStart(6)} ${(dwr + '%').padStart(6)} ${(avgNet + '%').padStart(8)} ${(avgGross + '%').padStart(8)} ${(medianPct + '%').padStart(8)} ${Math.round(r.capital).toLocaleString().padStart(12)} ${(totalRet + '%').padStart(8)} ${(mdd + '%').padStart(7)} ${String(r.signalDays).padStart(6)}`);
  }

  // ═══ 카테고리별 분석 ═══
  const categories = [
    { title: '[2] 거래량 폭발 + 보합 (쥐어짜기)', keys: ['거래량폭발+보합(2x)', '거래량폭발+보합(3x)'] },
    { title: '[3] 실패한 갭업', keys: ['실패한 갭업(2%+)', '실패한 갭업(3%+)', '실패한 갭업(5%+)'] },
    { title: '[4] 연속 상승 (모멘텀 관성)', keys: ['3일연속상승', '5일연속상승'] },
    { title: '[4] 연속 하락 (평균회귀)', keys: ['3일연속하락', '5일연속하락'] },
    { title: '[5] 윗꼬리 (천장 신호)', keys: ['윗꼬리50%+상승3%', '윗꼬리60%+상승3%'] },
    { title: '[6] 종가=저가 (바닥 다지기)', keys: ['종가=저가(3%하락)', '종가=저가(5%하락)'] },
    { title: '[8] 급등~상한가 vs 번트 현행', keys: ['급등(15%+)', '상한가(29%+)', '번트현행(20%+고가)'] },
  ];

  for (const cat of categories) {
    console.log(`\n  ${'═'.repeat(70)}`);
    console.log(`  ${cat.title}`);
    console.log(`  ${'═'.repeat(70)}`);

    for (const key of cat.keys) {
      const r = results.find(x => x.name === key);
      if (!r) continue;

      const wr = r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : 0;
      const avgNet = r.totalTrades > 0 ? (r.totalNetSum / r.totalTrades * 100).toFixed(2) : 0;
      const avgGross = r.totalTrades > 0 ? (r.totalGrossSum / r.totalTrades * 100).toFixed(2) : 0;
      const totalRet = ((r.capital - SEED) / SEED * 100).toFixed(1);

      console.log(`\n  ${r.name} — ${r.desc}`);
      console.log(`    거래: ${r.totalTrades}건 (${r.signalDays}일 시그널)`);
      console.log(`    승률: ${wr}% | 일승률: ${r.signalDays > 0 ? (r.winDays / r.signalDays * 100).toFixed(1) : 0}%`);
      console.log(`    EV(총): ${avgGross}% | EV(순): ${avgNet}% | 중앙값: ${(r.median * 100).toFixed(2)}%`);
      console.log(`    P10~P90: ${(r.p10 * 100).toFixed(2)}% ~ ${(r.p90 * 100).toFixed(2)}%`);
      console.log(`    대박(+5%+): ${r.bigWins}건 | 폭망(-5%-): ${r.bigLosses}건`);
      console.log(`    최종: ${Math.round(r.capital).toLocaleString()}원 (${totalRet}%) | MDD: ${(r.maxDD * 100).toFixed(1)}%`);
    }

    // 카테고리 판정
    const catResults = cat.keys.map(k => results.find(x => x.name === k)).filter(Boolean);
    const best = catResults.reduce((a, b) => {
      const aEV = a.totalTrades > 0 ? a.totalNetSum / a.totalTrades : -999;
      const bEV = b.totalTrades > 0 ? b.totalNetSum / b.totalTrades : -999;
      return aEV > bEV ? a : b;
    });
    const bestEV = best.totalTrades > 0 ? (best.totalNetSum / best.totalTrades * 100).toFixed(2) : 0;
    const bestGrossEV = best.totalTrades > 0 ? (best.totalGrossSum / best.totalTrades * 100).toFixed(2) : 0;

    console.log(`\n  >> 판정: ${best.name} (EV순 ${bestEV}%, EV총 ${bestGrossEV}%)`);
    if (parseFloat(bestEV) > 0) {
      console.log(`     수수료 차감 후 양의 기대값! 실전 검토 가치 있음.`);
    } else if (parseFloat(bestGrossEV) > 0.5) {
      console.log(`     수수료 전 양수. 수수료 최적화 시 가능성 있음.`);
    } else {
      console.log(`     수수료 차감 후 음의 기대값. 단독으로는 부적합.`);
    }
  }

  // ═══ 최종 랭킹 ═══
  console.log(`\n\n${'━'.repeat(80)}`);
  console.log('                    최종 EV 랭킹 (수수료 차감 후)');
  console.log('━'.repeat(80));

  const ranked = [...results]
    .map(r => ({
      ...r,
      ev: r.totalTrades > 0 ? r.totalNetSum / r.totalTrades : -999,
      evGross: r.totalTrades > 0 ? r.totalGrossSum / r.totalTrades : -999,
    }))
    .sort((a, b) => b.ev - a.ev);

  console.log(`\n  ${'#'.padStart(3)} ${'전략'.padEnd(22)} ${'EV(순)'.padStart(8)} ${'EV(총)'.padStart(8)} ${'승률'.padStart(6)} ${'거래'.padStart(5)} ${'MDD'.padStart(7)} ${'판정'.padStart(6)}`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(22)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(6)}`);

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const wr = r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : '-';
    const evPct = (r.ev * 100).toFixed(2);
    const evGPct = (r.evGross * 100).toFixed(2);
    const mdd = (r.maxDD * 100).toFixed(1);
    let verdict = '';
    if (r.ev > 0) verdict = 'GO';
    else if (r.evGross > 0.005) verdict = 'MAYBE';
    else verdict = 'NO-GO';

    const marker = verdict === 'GO' ? ' <<<' : verdict === 'MAYBE' ? ' ?' : '';
    console.log(`  ${String(i + 1).padStart(3)} ${r.name.padEnd(22)} ${(evPct + '%').padStart(8)} ${(evGPct + '%').padStart(8)} ${(wr + '%').padStart(6)} ${String(r.totalTrades).padStart(5)} ${(mdd + '%').padStart(7)} ${verdict.padStart(6)}${marker}`);
  }

  // ═══ 핵심 인사이트 ═══
  console.log(`\n\n${'━'.repeat(80)}`);
  console.log('                         핵심 인사이트');
  console.log('━'.repeat(80));

  const goStrategies = ranked.filter(r => r.ev > 0);
  const maybeStrategies = ranked.filter(r => r.ev <= 0 && r.evGross > 0.005);

  if (goStrategies.length > 0) {
    console.log(`\n  [양의 기대값 전략 ${goStrategies.length}개]`);
    for (const r of goStrategies) {
      console.log(`    - ${r.name}: EV ${(r.ev * 100).toFixed(2)}%, 승률 ${(r.totalWins / r.totalTrades * 100).toFixed(1)}%, ${r.totalTrades}건`);
    }
  } else {
    console.log(`\n  양의 기대값 전략 없음.`);
  }

  if (maybeStrategies.length > 0) {
    console.log(`\n  [수수료 줄이면 가능성 있는 전략 ${maybeStrategies.length}개]`);
    for (const r of maybeStrategies) {
      console.log(`    - ${r.name}: EV총 ${(r.evGross * 100).toFixed(2)}%, 손익분기 수수료 ${(r.evGross * 100).toFixed(2)}%`);
    }
  }

  // 번트 현행 vs 나머지 비교
  const bunt = results.find(r => r.name === '번트현행(20%+고가)');
  if (bunt) {
    const buntEV = bunt.totalTrades > 0 ? (bunt.totalNetSum / bunt.totalTrades * 100).toFixed(2) : 0;
    console.log(`\n  [번트 현행 기준선] EV ${buntEV}%, ${bunt.totalTrades}건`);
    const better = ranked.filter(r => r.name !== '번트현행(20%+고가)' && r.ev > (bunt.totalNetSum / bunt.totalTrades));
    if (better.length > 0) {
      console.log(`  번트보다 높은 EV: ${better.map(r => r.name).join(', ')}`);
    } else {
      console.log(`  번트 현행이 테스트한 전략 중 최고 성과.`);
    }
  }

  console.log('\n' + '━'.repeat(80));

  // 결과 저장
  const savePath = path.join(__dirname, '..', 'results', 'multi-strategy-backtest.json');
  fs.writeFileSync(savePath, JSON.stringify({
    period: { from: DATE_FROM, to: DATE_TO },
    cost: ROUND_TRIP,
    seed: SEED,
    strategies: ranked.map(r => ({
      name: r.name,
      desc: r.desc,
      trades: r.totalTrades,
      wins: r.totalWins,
      winRate: r.totalTrades > 0 ? +(r.totalWins / r.totalTrades).toFixed(4) : 0,
      evNet: +r.ev.toFixed(6),
      evGross: +r.evGross.toFixed(6),
      medianReturn: +r.median.toFixed(6),
      finalCapital: Math.round(r.capital),
      totalReturn: +((r.capital - SEED) / SEED).toFixed(4),
      maxDD: +r.maxDD.toFixed(4),
      signalDays: r.signalDays,
    }))
  }, null, 2));
  console.log(`\n  결과 저장: ${savePath}`);
}

main();
