/**
 * 번트: 공격형 + 시총/거래대금 필터 조합 백테스트
 * ─────────────────────────────────────────────────────────
 * 기본 조건: 등락률≥20%, 종가=고가(100%), 갭업≥0%, 코스닥
 *           종가매수 → 익일시가매도, 상한가 50% 할인
 *
 * 시총 데이터가 OHLCV에 없으므로 거래대금(volume×close)을 프록시로 사용.
 * 일반적으로 시총 300억 종목의 20%+ 급등일 거래대금은 ~30억+ 수준이므로
 * 시총 프록시 매핑:
 *   시총≥300억  → 거래대금≥5억  (소형주 급등시 회전율 높음)
 *   시총≥500억  → 거래대금≥10억
 *   시총≥1000억 → 거래대금≥20억
 *   시총≥2000억 → 거래대금≥50억
 *
 * 필터 통과 종목 전부 매수 (최대 10개 캡), 복리 적용
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');
const COST = 0.0118; // 1.18% (한투 수수료 0.5%×2 + 매도세 0.18%)
const INIT_CAPITAL = 5000000;
const MAX_STOCKS = 10;

// ── 데이터 로딩 ─────────────────────────────────────────
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
      const isLimitUp = changeRate >= 0.29;
      const adjOvernight = isLimitUp ? overnight * 0.5 : overnight;
      const volPrice = d.volume * d.close;

      if (!dateMap[d.date]) dateMap[d.date] = [];
      dateMap[d.date].push({
        overnight: adjOvernight,
        changeRate,
        isLimitUp,
        volPrice,
        gapUp: (d.open - prev.close) / prev.close,
        closeVsHigh: d.high > 0 ? d.close / d.high : 0,
      });
    }
  }
  return { dateMap, sortedDates: Object.keys(dateMap).sort() };
}

// ── 시뮬레이션 (전부 매수, 최대 MAX_STOCKS 캡) ─────────
function simulate(dateMap, sortedDates, filterFn) {
  let capital = INIT_CAPITAL;
  let tradeDays = 0, totalTrades = 0, winTrades = 0;
  let maxCap = INIT_CAPITAL, maxDD = 0;
  let retSum = 0;
  const totalDates = sortedDates.length;
  let dailyStockSum = 0;

  for (const date of sortedDates) {
    const bars = dateMap[date];

    // 필터 적용 → 등락률 내림차순 → 최대 MAX_STOCKS
    const filtered = bars.filter(b => filterFn(b))
      .sort((a, b) => b.changeRate - a.changeRate)
      .slice(0, MAX_STOCKS);

    if (filtered.length === 0) continue;
    tradeDays++;
    dailyStockSum += filtered.length;

    const n = filtered.length;
    let dayRet = 0;
    for (const s of filtered) {
      const net = s.overnight - COST;
      dayRet += net / n;
      totalTrades++;
      if (net > 0) winTrades++;
    }

    capital *= (1 + dayRet);
    retSum += dayRet;
    if (capital > maxCap) maxCap = capital;
    const dd = (maxCap - capital) / maxCap;
    if (dd > maxDD) maxDD = dd;
  }

  const avgDaily = tradeDays > 0 ? retSum / tradeDays : 0;
  const avgPerTrade = totalTrades > 0 ? retSum / totalTrades : 0;
  const annualReturn = tradeDays > 0 ? (Math.pow(capital / INIT_CAPITAL, 250 / totalDates) - 1) : 0;
  const calmar = maxDD > 0 ? annualReturn / maxDD : 0;

  return {
    capital,
    avgPerTrade,
    winRate: totalTrades > 0 ? winTrades / totalTrades : 0,
    avgDaily,
    maxDD,
    calmar,
    totalTrades,
    tradeDays,
    avgStocksPerDay: tradeDays > 0 ? dailyStockSum / tradeDays : 0,
    annualReturn,
  };
}

// ── 메인 ────────────────────────────────────────────────
function main() {
  console.log('='.repeat(110));
  console.log('  번트: 공격형 + 시총/거래대금 필터 조합 백테스트');
  console.log('='.repeat(110));

  const dateTo = '2026-03-19';
  const dateFrom = '2025-03-19';

  console.log(`  기간: ${dateFrom} ~ ${dateTo}`);
  console.log(`  기본조건: 등락률≥20%, 종가=고가(100%), 갭업≥0%`);
  console.log(`  매매: 종가매수→익일시가매도, 비용 0.231%, 상한가 50% 할인`);
  console.log(`  방식: 필터 통과 종목 전부 매수 (최대 ${MAX_STOCKS}개 캡), 복리`);
  console.log('');
  console.log('  ※ 시총 데이터 미보유 → 거래대금(volume×close) 프록시 사용');
  console.log('     시총≥300억→거래대금≥5억, 500억→10억, 1000억→20억, 2000억→50억');
  console.log('  데이터 로딩 중...');

  const { dateMap, sortedDates } = loadData(dateFrom, dateTo);
  console.log(`  ${sortedDates.length}거래일 로드 완료\n`);

  // ── 기본 조건 ───────────────────────────────────────────
  const BASE = b => b.changeRate >= 0.20 && b.closeVsHigh >= 1.0 && b.gapUp >= 0;

  // ── 15가지 필터 조합 정의 ─────────────────────────────
  // 시총 프록시 (거래대금 기반): 급등일 회전율 감안
  const MK300  = b => b.volPrice >= 5e8;    // 시총≥300억 프록시
  const MK500  = b => b.volPrice >= 10e8;   // 시총≥500억 프록시
  const MK1000 = b => b.volPrice >= 20e8;   // 시총≥1000억 프록시
  const MK2000 = b => b.volPrice >= 50e8;   // 시총≥2000억 프록시

  // 거래대금 직접 필터
  const VP10  = b => b.volPrice >= 10e8;
  const VP30  = b => b.volPrice >= 30e8;
  const VP50  = b => b.volPrice >= 50e8;
  const VP100 = b => b.volPrice >= 100e8;

  const combos = [
    { id: 1,  name: '기본만 (베이스라인)',
      fn: b => BASE(b) },
    { id: 2,  name: '시총≥300억 (거래대금≥5억 프록시)',
      fn: b => BASE(b) && MK300(b) },
    { id: 3,  name: '시총≥500억 (거래대금≥10억 프록시)',
      fn: b => BASE(b) && MK500(b) },
    { id: 4,  name: '시총≥1000억 (거래대금≥20억 프록시)',
      fn: b => BASE(b) && MK1000(b) },
    { id: 5,  name: '시총≥2000억 (거래대금≥50억 프록시)',
      fn: b => BASE(b) && MK2000(b) },
    { id: 6,  name: '거래대금≥10억',
      fn: b => BASE(b) && VP10(b) },
    { id: 7,  name: '거래대금≥30억',
      fn: b => BASE(b) && VP30(b) },
    { id: 8,  name: '거래대금≥50억',
      fn: b => BASE(b) && VP50(b) },
    { id: 9,  name: '거래대금≥100억',
      fn: b => BASE(b) && VP100(b) },
    { id: 10, name: '시총≥500억 + 거래대금≥10억',
      fn: b => BASE(b) && MK500(b) && VP10(b) },
    { id: 11, name: '시총≥500억 + 거래대금≥30억',
      fn: b => BASE(b) && MK500(b) && VP30(b) },
    { id: 12, name: '시총≥500억 + 거래대금≥50억',
      fn: b => BASE(b) && MK500(b) && VP50(b) },
    { id: 13, name: '시총≥1000억 + 거래대금≥30억',
      fn: b => BASE(b) && MK1000(b) && VP30(b) },
    { id: 14, name: '시총≥1000억 + 거래대금≥50억',
      fn: b => BASE(b) && MK1000(b) && VP50(b) },
    { id: 15, name: '시총≥2000억 + 거래대금≥50억',
      fn: b => BASE(b) && MK2000(b) && VP50(b) },
  ];

  const allResults = [];

  for (const combo of combos) {
    const sim = simulate(dateMap, sortedDates, combo.fn);
    allResults.push({
      comboId: combo.id,
      comboName: combo.name,
      label: `[#${combo.id}] ${combo.name}`,
      avgPerTrade: +(sim.avgPerTrade * 100).toFixed(4),
      winRate: +(sim.winRate * 100).toFixed(2),
      avgDaily: +(sim.avgDaily * 100).toFixed(4),
      avgStocksPerDay: +sim.avgStocksPerDay.toFixed(1),
      maxDD: +(sim.maxDD * 100).toFixed(2),
      calmar: +sim.calmar.toFixed(2),
      totalTrades: sim.totalTrades,
      tradeDays: sim.tradeDays,
      capital: Math.round(sim.capital),
      annualReturn: +(sim.annualReturn * 100).toFixed(2),
    });
  }

  // ── 전체 결과 출력 (수익률 순) ──────────────────────────
  const byReturn = [...allResults].sort((a, b) => b.avgPerTrade - a.avgPerTrade);
  const byCalmar = [...allResults].sort((a, b) => b.calmar - a.calmar);

  console.log('='.repeat(140));
  console.log('  전체 결과 — 건당 평균 수익률 순');
  console.log('='.repeat(140));
  console.log(`  ${'#'.padStart(3)} ${'건당수익%'.padStart(8)} ${'승률%'.padStart(7)} ${'일수익%'.padStart(8)} ${'종/일'.padStart(5)} ${'MDD%'.padStart(7)} ${'칼마'.padStart(7)} ${'거래건'.padStart(7)} ${'거래일'.padStart(5)} ${'500만→'.padStart(12)} ${'연환산%'.padStart(8)} | 조합`);
  console.log(`  ${'─'.repeat(3)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(5)} ${'─'.repeat(12)} ${'─'.repeat(8)} + ${'─'.repeat(50)}`);

  for (let i = 0; i < byReturn.length; i++) {
    const r = byReturn[i];
    const fin = formatCapital(r.capital);
    console.log(`  ${String(i+1).padStart(3)} ${r.avgPerTrade.toFixed(2).padStart(7)}% ${r.winRate.toFixed(1).padStart(6)}% ${r.avgDaily.toFixed(2).padStart(7)}% ${r.avgStocksPerDay.toFixed(1).padStart(5)} ${r.maxDD.toFixed(1).padStart(6)}% ${r.calmar.toFixed(1).padStart(7)} ${String(r.totalTrades).padStart(7)} ${String(r.tradeDays).padStart(5)} ${fin.padStart(12)} ${r.annualReturn.toFixed(1).padStart(7)}% | ${r.label}`);
  }

  // ── TOP 5 수익률 ────────────────────────────────────────
  console.log(`\n${'='.repeat(100)}`);
  console.log('  ** 건당 평균 수익률 TOP 5 **');
  console.log('='.repeat(100));
  for (let i = 0; i < Math.min(5, byReturn.length); i++) {
    const r = byReturn[i];
    const fin = formatCapital(r.capital);
    console.log(`  ${i+1}위: ${r.label}`);
    console.log(`       건당수익: ${r.avgPerTrade.toFixed(2)}% | 승률: ${r.winRate.toFixed(1)}% | 일수익: ${r.avgDaily.toFixed(2)}% | 종/일: ${r.avgStocksPerDay.toFixed(1)} | MDD: ${r.maxDD.toFixed(1)}% | 칼마: ${r.calmar.toFixed(1)} | 거래건: ${r.totalTrades} | 500만→${fin}`);
    console.log('');
  }

  // ── TOP 5 칼마 ──────────────────────────────────────────
  console.log(`${'='.repeat(100)}`);
  console.log('  ** 칼마 비율 TOP 5 **');
  console.log('='.repeat(100));
  for (let i = 0; i < Math.min(5, byCalmar.length); i++) {
    const r = byCalmar[i];
    const fin = formatCapital(r.capital);
    console.log(`  ${i+1}위: ${r.label}`);
    console.log(`       건당수익: ${r.avgPerTrade.toFixed(2)}% | 승률: ${r.winRate.toFixed(1)}% | 일수익: ${r.avgDaily.toFixed(2)}% | 종/일: ${r.avgStocksPerDay.toFixed(1)} | MDD: ${r.maxDD.toFixed(1)}% | 칼마: ${r.calmar.toFixed(1)} | 거래건: ${r.totalTrades} | 500만→${fin}`);
    console.log('');
  }

  // ── JSON 저장 ─────────────────────────────────────────
  const savePath = path.join(__dirname, '..', 'results', 'fundamental-filter-search.json');
  const saveData = {
    meta: {
      dateFrom, dateTo,
      tradingDays: sortedDates.length,
      cost: COST,
      initCapital: INIT_CAPITAL,
      maxStocksPerDay: MAX_STOCKS,
      baseCondition: '등락률≥20%, 종가=고가(100%), 갭업≥0%, 코스닥, 종가매수→익일시가매도',
      limitUpDiscount: '상한가(29%+) 수익률 50% 할인',
      note: '시총 데이터 미보유 → 거래대금 프록시 사용 (시총300억→거래대금5억, 500억→10억, 1000억→20억, 2000억→50억)',
      simulationMode: '필터 통과 종목 전부 매수 (최대 10개 캡), 복리',
      generatedAt: new Date().toISOString(),
    },
    combos: combos.map(c => ({ id: c.id, name: c.name })),
    results: allResults,
    ranking: {
      byAvgPerTrade: byReturn.slice(0, 5).map(r => ({
        label: r.label, avgPerTrade: r.avgPerTrade, winRate: r.winRate,
        avgDaily: r.avgDaily, avgStocksPerDay: r.avgStocksPerDay,
        maxDD: r.maxDD, calmar: r.calmar, totalTrades: r.totalTrades,
        capital: r.capital, annualReturn: r.annualReturn,
      })),
      byCalmar: byCalmar.slice(0, 5).map(r => ({
        label: r.label, avgPerTrade: r.avgPerTrade, winRate: r.winRate,
        avgDaily: r.avgDaily, avgStocksPerDay: r.avgStocksPerDay,
        maxDD: r.maxDD, calmar: r.calmar, totalTrades: r.totalTrades,
        capital: r.capital, annualReturn: r.annualReturn,
      })),
    },
  };

  fs.writeFileSync(savePath, JSON.stringify(saveData, null, 2));
  console.log(`\n결과 저장: ${savePath}`);
}

function formatCapital(cap) {
  if (cap >= 1e12) return (cap / 1e12).toFixed(1) + '조';
  if (cap >= 1e8) return (cap / 1e8).toFixed(1) + '억';
  if (cap >= 1e6) return (cap / 1e6).toFixed(1) + '백만';
  if (cap >= 1e4) return (cap / 1e4).toFixed(0) + '만';
  return cap.toLocaleString() + '원';
}

main();
