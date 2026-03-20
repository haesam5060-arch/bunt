#!/usr/bin/env node
/**
 * 번트 엔진 — 1년 풀 백테스트 (2025-03-20 ~ 2026-03-20)
 * 공격형 필터: 등락률≥20% + 종가=고가(100%) + 갭업≥0%
 * 종가매수 → 익일 시가매도, 50만원 시드, 수수료 반영
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
  // 아무 종목이나 하나 골라서 날짜 리스트 추출
  const dateSet = new Set();
  for (const [code, { data }] of Object.entries(allOHLCV)) {
    for (const d of data) {
      if (d.date >= DATE_FROM && d.date <= DATE_TO) dateSet.add(d.date);
    }
    if (dateSet.size > 200) break; // 하나만으로 충분
  }
  return [...dateSet].sort();
}

// ─── 필터 적용 ───
function filterStocks(allOHLCV, buyDate) {
  const results = [];
  for (const [code, { data, dateMap }] of Object.entries(allOHLCV)) {
    const idx = dateMap[buyDate];
    if (idx === undefined || idx < 1) continue;

    const today = data[idx];
    const prev = data[idx - 1];
    if (!today || !prev) continue;

    const { open, high, low, close, volume } = today;
    const prevClose = prev.close;
    if (prevClose <= 0 || high <= 0 || close <= 0) continue;

    const changeRate = (close - prevClose) / prevClose;
    const closeHighRatio = close / high;
    const gapUp = (open - prevClose) / prevClose;

    // 공격형 필터
    if (changeRate < 0.20) continue;
    if (closeHighRatio < 1.0) continue;
    if (gapUp < 0) continue;

    // 신규상장 제외 (30% 초과)
    if (changeRate > 0.30) continue;

    results.push({ code, changeRate, close, open, high, low, volume, prevClose });
  }

  results.sort((a, b) => b.changeRate - a.changeRate);
  return results.slice(0, MAX_PICKS);
}

// ─── 메인 ───
function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  번트 엔진 1년 풀 백테스트');
  console.log(`  기간: ${DATE_FROM} ~ ${DATE_TO}`);
  console.log(`  시드: ${SEED.toLocaleString()}원 | 수수료: ${(ROUND_TRIP * 100).toFixed(2)}%`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const allOHLCV = loadAllOHLCV();
  const nameMap = loadNameMap();
  console.log(`로드 완료: ${Object.keys(allOHLCV).length}개 종목\n`);

  const tradingDates = getTradingDates(allOHLCV);
  console.log(`거래일: ${tradingDates.length}일 (${tradingDates[0]} ~ ${tradingDates[tradingDates.length - 1]})\n`);

  let capital = SEED;
  let totalTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalReturnSum = 0;
  const dailyResults = [];
  const monthlyPnl = {};
  let peakCapital = SEED;
  let maxDD = 0;

  // 월별 헤더
  let currentMonth = '';

  for (let di = 0; di < tradingDates.length - 1; di++) {
    const buyDate = tradingDates[di];
    const sellDate = tradingDates[di + 1];

    // 월 변경 시 구분선
    const month = buyDate.slice(0, 7);
    if (month !== currentMonth) {
      if (currentMonth) {
        const mp = monthlyPnl[currentMonth];
        console.log(`  ── ${currentMonth} 소계: ${mp.trades}건, 승률 ${mp.wins}/${mp.trades} (${mp.trades > 0 ? (mp.wins/mp.trades*100).toFixed(0) : 0}%), 자본 ${Math.round(mp.endCapital).toLocaleString()}원 ──\n`);
      }
      currentMonth = month;
      monthlyPnl[month] = { trades: 0, wins: 0, losses: 0, pnlSum: 0, endCapital: capital };
    }

    const picks = filterStocks(allOHLCV, buyDate);

    if (picks.length === 0) {
      dailyResults.push({ date: buyDate, count: 0, wins: 0, losses: 0, pnl: 0, capitalReturn: 0 });
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
      dailyResults.push({ date: buyDate, count: 0, wins: 0, losses: 0, pnl: 0, capitalReturn: 0 });
      monthlyPnl[month].endCapital = capital;
      continue;
    }

    // 균등 배분
    const perStock = capital / trades.length;
    let dayPnl = 0;
    let dayWins = 0;
    let dayLosses = 0;

    for (const t of trades) {
      const pnl = perStock * t.netReturn;
      dayPnl += pnl;
      if (t.netReturn > 0) dayWins++;
      else dayLosses++;
    }

    const dayReturn = dayPnl / capital;
    capital += dayPnl;

    // MDD
    if (capital > peakCapital) peakCapital = capital;
    const dd = (peakCapital - capital) / peakCapital;
    if (dd > maxDD) maxDD = dd;

    totalTrades += trades.length;
    totalWins += dayWins;
    totalLosses += dayLosses;
    totalReturnSum += trades.reduce((s, t) => s + t.netReturn, 0);

    monthlyPnl[month].trades += trades.length;
    monthlyPnl[month].wins += dayWins;
    monthlyPnl[month].losses += dayLosses;
    monthlyPnl[month].pnlSum += dayPnl;
    monthlyPnl[month].endCapital = capital;

    // 일별 상세 출력
    const emoji = dayPnl >= 0 ? '🟢' : '🔴';
    const wl = `${dayWins}승${dayLosses}패`;
    console.log(`\n${emoji} ${buyDate} → ${sellDate}  필터통과 ${picks.length}종목 → 매매 ${trades.length}종목  ${wl}  일수익 ${dayPnl >= 0 ? '+' : ''}${Math.round(dayPnl).toLocaleString()}원 (${(dayReturn * 100).toFixed(2)}%)  자본 ${Math.round(capital).toLocaleString()}원`);
    console.log(`   ${'종목명'.padEnd(12)}${'매수가'.padStart(10)}${'매도가'.padStart(10)}${'등락률'.padStart(8)}${'수익률'.padStart(8)}  결과`);
    for (const t of trades) {
      const winLoss = t.netReturn > 0 ? '✅익절' : '❌손절';
      const name = (t.name || t.code).slice(0, 8);
      console.log(`   ${pad(name, 12)}${comma(t.buyPrice).padStart(10)}${comma(t.sellPrice).padStart(10)}${pct(t.changeRate).padStart(8)}${pct(t.netReturn).padStart(8)}  ${winLoss}`);
    }

    dailyResults.push({ date: buyDate, count: trades.length, wins: dayWins, losses: dayLosses, pnl: dayPnl, capitalReturn: dayReturn });
  }

  // 마지막 월 소계
  if (currentMonth && monthlyPnl[currentMonth]) {
    const mp = monthlyPnl[currentMonth];
    console.log(`  ── ${currentMonth} 소계: ${mp.trades}건, 승률 ${mp.wins}/${mp.trades} (${mp.trades > 0 ? (mp.wins/mp.trades*100).toFixed(0) : 0}%), 자본 ${Math.round(mp.endCapital).toLocaleString()}원 ──\n`);
  }

  // ═══ 종합 리포트 ═══
  const tradingDaysWithTrades = dailyResults.filter(d => d.count > 0);
  const winDays = tradingDaysWithTrades.filter(d => d.pnl > 0).length;
  const lossDays = tradingDaysWithTrades.filter(d => d.pnl <= 0).length;

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    1년 종합 리포트');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`기간: ${DATE_FROM} ~ ${DATE_TO} (${tradingDates.length} 거래일)`);
  console.log(`시그널 발생일: ${tradingDaysWithTrades.length}일 (${(tradingDaysWithTrades.length/tradingDates.length*100).toFixed(1)}%)`);
  console.log(`미거래일: ${tradingDates.length - tradingDaysWithTrades.length}일\n`);

  console.log(`총 거래: ${totalTrades}건`);
  console.log(`승/패: ${totalWins}승 ${totalLosses}패`);
  console.log(`건당 승률: ${(totalWins / totalTrades * 100).toFixed(1)}%`);
  console.log(`일단위 승률: ${winDays}일 / ${tradingDaysWithTrades.length}일 (${(winDays/tradingDaysWithTrades.length*100).toFixed(1)}%)`);
  console.log(`평균 건당 수익률: ${(totalReturnSum / totalTrades * 100).toFixed(2)}% (수수료 차감 후)\n`);

  const totalReturn = (capital - SEED) / SEED;
  console.log(`시드: ${SEED.toLocaleString()}원`);
  console.log(`최종: ${Math.round(capital).toLocaleString()}원`);
  console.log(`손익: ${capital >= SEED ? '+' : ''}${Math.round(capital - SEED).toLocaleString()}원 (${(totalReturn * 100).toFixed(1)}%)`);
  console.log(`MDD: ${(maxDD * 100).toFixed(2)}%`);
  const avgPicksPerSignalDay = tradingDaysWithTrades.length > 0
    ? (totalTrades / tradingDaysWithTrades.length).toFixed(1) : '0';
  console.log(`시그널일 평균 종목수: ${avgPicksPerSignalDay}개\n`);

  // 월별 요약
  console.log('── 월별 요약 ──');
  for (const [month, mp] of Object.entries(monthlyPnl)) {
    const wr = mp.trades > 0 ? (mp.wins / mp.trades * 100).toFixed(0) : '-';
    console.log(`  ${month}: ${mp.trades.toString().padStart(3)}건  승률 ${wr.padStart(3)}%  PnL ${mp.pnlSum >= 0 ? '+' : ''}${Math.round(mp.pnlSum).toLocaleString().padStart(10)}원  자본 ${Math.round(mp.endCapital).toLocaleString()}원`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
