#!/usr/bin/env node
/**
 * 번트 역발상 백테스트 — 하락빔 종가매수 → 익일 시가매도
 * ──────────────────────────────────────────────────────
 * 급락한 종목을 장마감에 사서, 다음날 시가에 파는 전략.
 * 데드캣 바운스(기술적 반등) 효과를 검증한다.
 *
 * 4가지 하락 구간을 동시에 테스트:
 *   A: -5% 이하  (소폭 하락)
 *   B: -10% 이하 (중폭 하락)
 *   C: -15% 이하 (급락)
 *   D: -20% 이하 (하락빔)
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const COMMISSION = 0.005;    // 편도 0.5% (한투)
const TAX = 0.0018;          // 매도세 0.18%
const ROUND_TRIP = COMMISSION * 2 + TAX; // 1.18%
const SEED = 500_000;
const MAX_PICKS = 10;
const DATE_FROM = '2025-03-20';
const DATE_TO = '2026-03-20';

// 테스트할 하락 구간들
const SCENARIOS = [
  { label: 'A: -5% 이하',  minDrop: -0.29, maxDrop: -0.05 },
  { label: 'B: -10% 이하', minDrop: -0.29, maxDrop: -0.10 },
  { label: 'C: -15% 이하', minDrop: -0.29, maxDrop: -0.15 },
  { label: 'D: -20% 이하', minDrop: -0.29, maxDrop: -0.20 },
];

// ─── OHLCV 전체 로드 ───
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

// ─── 종목명 로드 ───
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

// ─── 거래일 리스트 추출 ───
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

// ─── 하락 종목 필터 ───
function filterDipStocks(allOHLCV, buyDate, minDrop, maxDrop) {
  const results = [];
  for (const [code, { data, dateMap }] of Object.entries(allOHLCV)) {
    const idx = dateMap[buyDate];
    if (idx === undefined || idx < 1) continue;

    const today = data[idx];
    const prev = data[idx - 1];
    if (!today || !prev) continue;

    const { open, high, low, close, volume } = today;
    const prevClose = prev.close;
    if (prevClose <= 0 || close <= 0) continue;

    const changeRate = (close - prevClose) / prevClose;

    // 하락 필터: minDrop ≤ changeRate ≤ maxDrop (둘 다 음수)
    if (changeRate > maxDrop) continue;   // 하락 부족
    if (changeRate < minDrop) continue;   // 하한가 제외

    // 거래대금 100만원 이상 (유동성 확보)
    const tradingValue = close * volume;
    if (tradingValue < 1_000_000) continue;

    results.push({ code, changeRate, close, open, high, low, volume, prevClose, tradingValue });
  }

  // 하락률 큰 순(더 많이 빠진 것 우선)
  results.sort((a, b) => a.changeRate - b.changeRate);
  return results.slice(0, MAX_PICKS);
}

// ─── 시나리오별 시뮬레이션 ───
function runScenario(allOHLCV, nameMap, tradingDates, scenario, verbose) {
  const { label, minDrop, maxDrop } = scenario;
  let capital = SEED;
  let totalTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalReturnSum = 0;
  let totalGrossReturnSum = 0;
  const monthlyPnl = {};
  let peakCapital = SEED;
  let maxDD = 0;
  let signalDays = 0;
  let winDays = 0;

  // 건별 수익률 저장 (분포 분석용)
  const allReturns = [];

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    const sellDate = tradingDates[di + 1];
    const month = buyDate.slice(0, 7);

    if (!monthlyPnl[month]) {
      monthlyPnl[month] = { trades: 0, wins: 0, losses: 0, pnlSum: 0, endCapital: capital };
    }

    const picks = filterDipStocks(allOHLCV, buyDate, minDrop, maxDrop);
    if (picks.length === 0) {
      monthlyPnl[month].endCapital = capital;
      continue;
    }

    // 익일 시가로 매도
    const trades = [];
    for (const p of picks) {
      const { data, dateMap } = allOHLCV[p.code];
      const sellIdx = dateMap[sellDate];
      if (sellIdx === undefined) continue;

      const sellDay = data[sellIdx];
      const grossReturn = (sellDay.open - p.close) / p.close;
      const netReturn = grossReturn - ROUND_TRIP;

      trades.push({
        code: p.code,
        name: nameMap[p.code] || p.code,
        buyPrice: p.close,
        sellPrice: sellDay.open,
        changeRate: p.changeRate,
        grossReturn,
        netReturn,
      });
    }

    if (trades.length === 0) {
      monthlyPnl[month].endCapital = capital;
      continue;
    }

    signalDays++;
    const perStock = capital / trades.length;
    let dayPnl = 0;
    let dayWins = 0;
    let dayLosses = 0;

    for (const t of trades) {
      const pnl = perStock * t.netReturn;
      dayPnl += pnl;
      if (t.netReturn > 0) dayWins++;
      else dayLosses++;
      allReturns.push(t.netReturn);
    }

    const dayReturn = dayPnl / capital;
    capital += dayPnl;

    if (capital > peakCapital) peakCapital = capital;
    const dd = (peakCapital - capital) / peakCapital;
    if (dd > maxDD) maxDD = dd;

    if (dayPnl > 0) winDays++;

    totalTrades += trades.length;
    totalWins += dayWins;
    totalLosses += dayLosses;
    totalReturnSum += trades.reduce((s, t) => s + t.netReturn, 0);
    totalGrossReturnSum += trades.reduce((s, t) => s + t.grossReturn, 0);

    monthlyPnl[month].trades += trades.length;
    monthlyPnl[month].wins += dayWins;
    monthlyPnl[month].losses += dayLosses;
    monthlyPnl[month].pnlSum += dayPnl;
    monthlyPnl[month].endCapital = capital;

    // 상세 출력 (verbose 모드)
    if (verbose) {
      const emoji = dayPnl >= 0 ? '+' : '-';
      const wl = `${dayWins}W${dayLosses}L`;
      console.log(`  ${buyDate} -> ${sellDate}  ${picks.length}종목  ${wl}  ${emoji}${Math.abs(Math.round(dayPnl)).toLocaleString()}원 (${(dayReturn * 100).toFixed(2)}%)  자본 ${Math.round(capital).toLocaleString()}원`);
      for (const t of trades) {
        const mark = t.netReturn > 0 ? 'O' : 'X';
        const name = (t.name || t.code).slice(0, 8);
        console.log(`    [${mark}] ${pad(name, 10)} ${pct(t.changeRate)} -> 익일시가 ${pct(t.grossReturn)} (순 ${pct(t.netReturn)})`);
      }
    }
  }

  // 수익률 분포 분석
  allReturns.sort((a, b) => a - b);
  const median = allReturns.length > 0 ? allReturns[Math.floor(allReturns.length / 2)] : 0;
  const bigWins = allReturns.filter(r => r > 0.05).length;   // +5% 이상
  const bigLosses = allReturns.filter(r => r < -0.05).length; // -5% 이하
  const p10 = allReturns[Math.floor(allReturns.length * 0.1)] || 0;
  const p90 = allReturns[Math.floor(allReturns.length * 0.9)] || 0;

  return {
    label, capital, totalTrades, totalWins, totalLosses,
    totalReturnSum, totalGrossReturnSum,
    monthlyPnl, maxDD, signalDays, winDays,
    allReturns, median, bigWins, bigLosses, p10, p90,
  };
}

// ─── 메인 ───
function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  역발상 백테스트: 하락빔 종가매수 -> 익일 시가매도');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO} | 시드: ${SEED.toLocaleString()}원 | 수수료: ${(ROUND_TRIP * 100).toFixed(2)}%`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const allOHLCV = loadAllOHLCV();
  const nameMap = loadNameMap();
  console.log(`로드 완료: ${Object.keys(allOHLCV).length}개 종목\n`);

  const tradingDates = getTradingDates(allOHLCV);
  console.log(`거래일: ${tradingDates.length}일 (${tradingDates[0]} ~ ${tradingDates[tradingDates.length - 1]})\n`);

  // ═══ 4개 시나리오 동시 실행 ═══
  const results = [];
  for (const sc of SCENARIOS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  시나리오 ${sc.label} 실행 중...`);
    console.log('─'.repeat(60));
    const r = runScenario(allOHLCV, nameMap, tradingDates, sc, false);
    results.push(r);
  }

  // ═══ 비교 리포트 ═══
  console.log('\n\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('                    하락빔 역발상 — 시나리오 비교');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 헤더
  console.log(`  ${'시나리오'.padEnd(16)} ${'거래건'.padStart(6)} ${'승률'.padStart(6)} ${'일승률'.padStart(6)} ${'평균수익'.padStart(8)} ${'평균총수익'.padStart(8)} ${'중앙값'.padStart(8)} ${'최종자본'.padStart(12)} ${'총수익률'.padStart(8)} ${'MDD'.padStart(7)}`);
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(8)} ${'─'.repeat(7)}`);

  for (const r of results) {
    const wr = r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : '-';
    const dwr = r.signalDays > 0 ? (r.winDays / r.signalDays * 100).toFixed(1) : '-';
    const avgNet = r.totalTrades > 0 ? (r.totalReturnSum / r.totalTrades * 100).toFixed(2) : '-';
    const avgGross = r.totalTrades > 0 ? (r.totalGrossReturnSum / r.totalTrades * 100).toFixed(2) : '-';
    const medianPct = (r.median * 100).toFixed(2);
    const totalRet = ((r.capital - SEED) / SEED * 100).toFixed(1);
    const mdd = (r.maxDD * 100).toFixed(1);

    console.log(`  ${r.label.padEnd(16)} ${String(r.totalTrades).padStart(6)} ${(wr + '%').padStart(6)} ${(dwr + '%').padStart(6)} ${(avgNet + '%').padStart(8)} ${(avgGross + '%').padStart(8)} ${(medianPct + '%').padStart(8)} ${Math.round(r.capital).toLocaleString().padStart(12)} ${(totalRet + '%').padStart(8)} ${(mdd + '%').padStart(7)}`);
  }

  // ═══ 각 시나리오 상세 ═══
  for (const r of results) {
    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`  ${r.label} 상세`);
    console.log('═'.repeat(60));

    console.log(`\n  총 거래: ${r.totalTrades}건 (${r.signalDays}일 시그널)`);
    console.log(`  승/패: ${r.totalWins}승 ${r.totalLosses}패`);
    console.log(`  건당 승률: ${r.totalTrades > 0 ? (r.totalWins / r.totalTrades * 100).toFixed(1) : 0}%`);
    console.log(`  일단위 승률: ${r.winDays}/${r.signalDays}일 (${r.signalDays > 0 ? (r.winDays / r.signalDays * 100).toFixed(1) : 0}%)`);

    const avgNet = r.totalTrades > 0 ? r.totalReturnSum / r.totalTrades : 0;
    const avgGross = r.totalTrades > 0 ? r.totalGrossReturnSum / r.totalTrades : 0;
    console.log(`\n  평균 수익률(총): ${pct(avgGross)}`);
    console.log(`  평균 수익률(순): ${pct(avgNet)}`);
    console.log(`  수익률 중앙값: ${pct(r.median)}`);
    console.log(`  P10~P90: ${pct(r.p10)} ~ ${pct(r.p90)}`);
    console.log(`  대박(+5%+): ${r.bigWins}건 (${r.totalTrades > 0 ? (r.bigWins / r.totalTrades * 100).toFixed(1) : 0}%)`);
    console.log(`  폭망(-5%-): ${r.bigLosses}건 (${r.totalTrades > 0 ? (r.bigLosses / r.totalTrades * 100).toFixed(1) : 0}%)`);

    console.log(`\n  시드: ${SEED.toLocaleString()}원`);
    console.log(`  최종: ${Math.round(r.capital).toLocaleString()}원`);
    console.log(`  손익: ${r.capital >= SEED ? '+' : ''}${Math.round(r.capital - SEED).toLocaleString()}원 (${((r.capital - SEED) / SEED * 100).toFixed(1)}%)`);
    console.log(`  MDD: ${(r.maxDD * 100).toFixed(1)}%`);

    // 월별 요약
    console.log(`\n  -- 월별 --`);
    for (const [month, mp] of Object.entries(r.monthlyPnl)) {
      if (mp.trades === 0) continue;
      const wr = (mp.wins / mp.trades * 100).toFixed(0);
      console.log(`  ${month}: ${String(mp.trades).padStart(4)}건  승률 ${wr.padStart(3)}%  PnL ${mp.pnlSum >= 0 ? '+' : ''}${Math.round(mp.pnlSum).toLocaleString().padStart(10)}원  자본 ${Math.round(mp.endCapital).toLocaleString()}원`);
    }
  }

  // ═══ 가장 많이 떨어진 종목 상세 (D 시나리오) ═══
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('  보너스: -20% 이하 급락 종목 상세 (최근 20건)');
  console.log('═'.repeat(60));

  // D 시나리오를 verbose로 재실행 (최근 20일만)
  const recentDates = tradingDates.slice(-21);
  for (let di = 0; di < recentDates.length - 1; di++) {
    const buyDate = recentDates[di];
    const sellDate = recentDates[di + 1];
    const picks = filterDipStocks(allOHLCV, buyDate, -0.29, -0.20);
    if (picks.length === 0) continue;

    for (const p of picks) {
      const { data, dateMap } = allOHLCV[p.code];
      const sellIdx = dateMap[sellDate];
      if (sellIdx === undefined) continue;
      const sellDay = data[sellIdx];
      const grossReturn = (sellDay.open - p.close) / p.close;
      const netReturn = grossReturn - ROUND_TRIP;
      const mark = netReturn > 0 ? 'O' : 'X';
      const name = (nameMap[p.code] || p.code).slice(0, 10);
      console.log(`  ${buyDate} [${mark}] ${pad(name, 12)} 전일대비 ${pct(p.changeRate)}  종가 ${comma(p.close)} -> 익일시가 ${comma(sellDay.open)}  수익 ${pct(netReturn)}`);
    }
  }

  // ═══ 결론 ═══
  console.log(`\n\n${'━'.repeat(60)}`);
  console.log('  결론');
  console.log('━'.repeat(60));

  const best = results.reduce((a, b) =>
    (a.totalTrades > 0 ? a.totalReturnSum / a.totalTrades : -1) >
    (b.totalTrades > 0 ? b.totalReturnSum / b.totalTrades : -1) ? a : b
  );
  const bestAvg = best.totalTrades > 0 ? (best.totalReturnSum / best.totalTrades * 100).toFixed(2) : 0;
  const bestWR = best.totalTrades > 0 ? (best.totalWins / best.totalTrades * 100).toFixed(1) : 0;

  console.log(`\n  최고 성과 시나리오: ${best.label}`);
  console.log(`  건당 평균 수익률: ${bestAvg}% | 승률: ${bestWR}% | MDD: ${(best.maxDD * 100).toFixed(1)}%`);

  const baseline = results[0]; // A: -5%
  const baseAvg = baseline.totalTrades > 0 ? (baseline.totalReturnSum / baseline.totalTrades * 100).toFixed(2) : 0;

  if (parseFloat(bestAvg) > 0) {
    console.log(`\n  -> 하락빔 역발상 전략은 수수료 차감 후에도 양의 기대값!`);
    console.log(`     데드캣 바운스 효과가 통계적으로 존재함.`);
  } else if (parseFloat(baseAvg) > -0.5) {
    console.log(`\n  -> 수수료 차감 후 미미한 손실. 수수료가 낮으면 가능성 있음.`);
  } else {
    console.log(`\n  -> 하락빔 종가매수는 수수료 차감 후 음의 기대값.`);
    console.log(`     "떨어지는 칼날 잡기"는 역시 위험.`);
  }

  // 결과 저장
  const savePath = path.join(__dirname, '..', 'results', 'dip-backtest.json');
  fs.writeFileSync(savePath, JSON.stringify({
    period: { from: DATE_FROM, to: DATE_TO },
    scenarios: results.map(r => ({
      label: r.label,
      trades: r.totalTrades,
      wins: r.totalWins,
      losses: r.totalLosses,
      winRate: r.totalTrades > 0 ? +(r.totalWins / r.totalTrades).toFixed(4) : 0,
      avgNetReturn: r.totalTrades > 0 ? +(r.totalReturnSum / r.totalTrades).toFixed(6) : 0,
      avgGrossReturn: r.totalTrades > 0 ? +(r.totalGrossReturnSum / r.totalTrades).toFixed(6) : 0,
      medianReturn: +r.median.toFixed(6),
      finalCapital: Math.round(r.capital),
      totalReturn: +((r.capital - SEED) / SEED).toFixed(4),
      maxDD: +r.maxDD.toFixed(4),
      signalDays: r.signalDays,
    }))
  }, null, 2));
  console.log(`\n  결과 저장: ${savePath}`);
  console.log('━'.repeat(60));
}

// ─── 유틸 ───
function pct(v) {
  const val = v * 100;
  return (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
}
function comma(n) {
  return Number(n).toLocaleString('ko-KR');
}
function pad(s, len) {
  const sLen = [...s].reduce((acc, c) => acc + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  const diff = len - sLen;
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

main();
