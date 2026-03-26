#!/usr/bin/env node
/**
 * 갭업 예측 지표 분석 백테스트
 * ──────────────────────────────────────────────────────────
 * 목적: 상한가 근처(+20%↑) 종목 중, 익일 갭업 vs 보합/갭다운을
 *       사전에 구별할 수 있는 지표가 있는지 검증
 *
 * 분석 지표:
 *  1. 거래대금 (tradingValue)
 *  2. 아래꼬리 비율 (lowerWick%)
 *  3. 거래량 비율 (당일 / 20일 평균)
 *  4. 상한가 고정 여부 (open=high=close = 종일 상한가 고정)
 *  5. 당일 시가→종가 움직임 (open vs close 갭)
 *  6. 등락률 구간별 (20~25%, 25~29%, 29~30%)
 *  7. 장중 변동성 (high-low)/close
 *  8. 전일 대비 거래량 변화
 */

const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const DATE_FROM = '2025-01-01';
const DATE_TO = '2026-03-26';
const COST_PCT = 0.00231 * 2 + 0.0018; // 왕복 수수료+세금 ≈ 0.64% (실제론 ~1.18% 사용)

// ── 데이터 로드 ──
function loadAllOHLCV() {
  const files = fs.readdirSync(OHLCV_DIR).filter(f => f.endsWith('.json'));
  const all = {};
  for (const f of files) {
    const code = f.replace('.json', '');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, f), 'utf8'));
      if (Array.isArray(data) && data.length > 30) {
        all[code] = data;
      }
    } catch(e) {}
  }
  return all;
}

// ── 메인 분석 ──
console.log('데이터 로딩...');
const allOHLCV = loadAllOHLCV();
console.log(`${Object.keys(allOHLCV).length}개 종목 로드\n`);

const trades = []; // 모든 매수 후보

for (const [code, data] of Object.entries(allOHLCV)) {
  for (let i = 20; i < data.length - 1; i++) {
    const d = data[i];
    const prev = data[i - 1];
    const next = data[i + 1];

    if (!d.date || d.date < DATE_FROM || d.date > DATE_TO) continue;
    if (!d.close || !d.open || !d.high || !d.low || d.close <= 0) continue;
    if (!prev.close || prev.close <= 0 || !next.open || next.open <= 0) continue;

    const changeRate = (d.close - prev.close) / prev.close;
    if (changeRate < 0.20 || changeRate > 0.32) continue; // 20%~32%

    // 종가=고가 필터 (현행 조건)
    const closeHighPct = d.close / d.high;
    if (closeHighPct < 0.999) continue; // 종가≈고가

    // 갭업 필터
    const gapUp = (d.open - prev.close) / prev.close;
    if (gapUp < 0) continue;

    // ── 지표 계산 ──
    const tradingValue = d.close * d.volume;
    const lowerWickPct = d.high > d.low ? (Math.min(d.open, d.close) - d.low) / (d.high - d.low) : 0;

    // 거래량 비율 (20일 평균 대비)
    let volSum = 0, volCount = 0;
    for (let j = i - 20; j < i; j++) {
      if (j >= 0 && data[j].volume > 0) { volSum += data[j].volume; volCount++; }
    }
    const avgVol20 = volCount > 0 ? volSum / volCount : 1;
    const volRatio = d.volume / avgVol20;

    // 전일 거래량 대비
    const prevVolRatio = prev.volume > 0 ? d.volume / prev.volume : 1;

    // 상한가 고정 여부 (시가=고가=종가 → 종일 상한가에 묶임)
    const isLockedLimit = (d.open === d.high && d.high === d.close);

    // 장중 변동성
    const intradayRange = (d.high - d.low) / d.close;

    // 시가 갭 (전일 종가 → 당일 시가)
    const openGap = (d.open - prev.close) / prev.close;

    // 시가 대비 종가 상승폭
    const openToClose = (d.close - d.open) / d.open;

    // ── 익일 결과 ──
    const overnightGap = (next.open - d.close) / d.close;
    const netReturn = overnightGap - 0.0118; // 수수료+세금 약 1.18%

    trades.push({
      code, date: d.date,
      changeRate, tradingValue, lowerWickPct, volRatio, prevVolRatio,
      isLockedLimit, intradayRange, openGap, openToClose,
      overnightGap, netReturn,
      close: d.close, volume: d.volume,
    });
  }
}

console.log(`분석 대상: ${trades.length}건 (20%↑ + 종가=고가 + 갭업≥0)\n`);

// ── 분석 함수 ──
function analyzeGroup(name, group) {
  if (group.length === 0) return null;
  const wins = group.filter(t => t.netReturn > 0);
  const avgGap = group.reduce((s, t) => s + t.overnightGap, 0) / group.length;
  const avgNet = group.reduce((s, t) => s + t.netReturn, 0) / group.length;
  const medianGap = [...group].sort((a, b) => a.overnightGap - b.overnightGap)[Math.floor(group.length / 2)].overnightGap;
  return {
    name, count: group.length,
    winRate: (wins.length / group.length * 100).toFixed(1),
    avgGap: (avgGap * 100).toFixed(2),
    medianGap: (medianGap * 100).toFixed(2),
    avgNet: (avgNet * 100).toFixed(2),
  };
}

function printTable(title, rows) {
  console.log(`\n${'═'.repeat(90)}`);
  console.log(` ${title}`);
  console.log(`${'═'.repeat(90)}`);
  console.log('그룹                          | 건수  | 승률   | 평균갭%  | 중간갭% | 순수익%');
  console.log('─'.repeat(90));
  for (const r of rows) {
    if (!r) continue;
    const pad = (s, n) => String(s).padStart(n);
    console.log(
      `${r.name.padEnd(30)}| ${pad(r.count, 5)} | ${pad(r.winRate + '%', 6)} | ${pad(r.avgGap + '%', 7)} | ${pad(r.medianGap + '%', 6)} | ${pad(r.avgNet + '%', 6)}`
    );
  }
}

// ══════════════════════════════════════════════════════════
// 1. 등락률 구간별
// ══════════════════════════════════════════════════════════
printTable('1. 등락률 구간별', [
  analyzeGroup('20~25%', trades.filter(t => t.changeRate >= 0.20 && t.changeRate < 0.25)),
  analyzeGroup('25~29%', trades.filter(t => t.changeRate >= 0.25 && t.changeRate < 0.29)),
  analyzeGroup('29~30% (상한가 근접)', trades.filter(t => t.changeRate >= 0.29 && t.changeRate < 0.30)),
  analyzeGroup('30%+ (상한가)', trades.filter(t => t.changeRate >= 0.30)),
  analyzeGroup('전체', trades),
]);

// ══════════════════════════════════════════════════════════
// 2. 상한가 고정 여부 (시가=고가=종가)
// ══════════════════════════════════════════════════════════
printTable('2. 상한가 고정 여부 (시가=고가=종가 = 종일 묶임)', [
  analyzeGroup('고정 상한가 (시=고=종)', trades.filter(t => t.isLockedLimit)),
  analyzeGroup('비고정 (장중 풀렸다 재도달)', trades.filter(t => !t.isLockedLimit)),
]);

// ══════════════════════════════════════════════════════════
// 3. 거래대금 구간별
// ══════════════════════════════════════════════════════════
printTable('3. 거래대금 구간별', [
  analyzeGroup('~10억', trades.filter(t => t.tradingValue < 1e9)),
  analyzeGroup('10~50억', trades.filter(t => t.tradingValue >= 1e9 && t.tradingValue < 5e9)),
  analyzeGroup('50~100억', trades.filter(t => t.tradingValue >= 5e9 && t.tradingValue < 10e9)),
  analyzeGroup('100~500억', trades.filter(t => t.tradingValue >= 10e9 && t.tradingValue < 50e9)),
  analyzeGroup('500억+', trades.filter(t => t.tradingValue >= 50e9)),
]);

// ══════════════════════════════════════════════════════════
// 4. 아래꼬리 비율
// ══════════════════════════════════════════════════════════
printTable('4. 아래꼬리(하위꼬리) 비율', [
  analyzeGroup('꼬리 0% (없음)', trades.filter(t => t.lowerWickPct === 0)),
  analyzeGroup('꼬리 0~5%', trades.filter(t => t.lowerWickPct > 0 && t.lowerWickPct <= 0.05)),
  analyzeGroup('꼬리 5~15%', trades.filter(t => t.lowerWickPct > 0.05 && t.lowerWickPct <= 0.15)),
  analyzeGroup('꼬리 15~30%', trades.filter(t => t.lowerWickPct > 0.15 && t.lowerWickPct <= 0.30)),
  analyzeGroup('꼬리 30%+', trades.filter(t => t.lowerWickPct > 0.30)),
]);

// ══════════════════════════════════════════════════════════
// 5. 거래량 비율 (20일 평균 대비)
// ══════════════════════════════════════════════════════════
printTable('5. 거래량 비율 (20일 평균 대비)', [
  analyzeGroup('~3배', trades.filter(t => t.volRatio < 3)),
  analyzeGroup('3~10배', trades.filter(t => t.volRatio >= 3 && t.volRatio < 10)),
  analyzeGroup('10~30배', trades.filter(t => t.volRatio >= 10 && t.volRatio < 30)),
  analyzeGroup('30~100배', trades.filter(t => t.volRatio >= 30 && t.volRatio < 100)),
  analyzeGroup('100배+', trades.filter(t => t.volRatio >= 100)),
]);

// ══════════════════════════════════════════════════════════
// 6. 시가 갭 (전일종가→당일시가)
// ══════════════════════════════════════════════════════════
printTable('6. 당일 시가 갭업 크기', [
  analyzeGroup('갭 0% (보합 출발)', trades.filter(t => t.openGap <= 0.01)),
  analyzeGroup('갭 1~5%', trades.filter(t => t.openGap > 0.01 && t.openGap <= 0.05)),
  analyzeGroup('갭 5~15%', trades.filter(t => t.openGap > 0.05 && t.openGap <= 0.15)),
  analyzeGroup('갭 15~25%', trades.filter(t => t.openGap > 0.15 && t.openGap <= 0.25)),
  analyzeGroup('갭 25%+ (시가부터 상한가)', trades.filter(t => t.openGap > 0.25)),
]);

// ══════════════════════════════════════════════════════════
// 7. 장중 변동성 (고-저)/종가
// ══════════════════════════════════════════════════════════
printTable('7. 장중 변동성 (고가-저가)/종가', [
  analyzeGroup('~5% (좁음)', trades.filter(t => t.intradayRange < 0.05)),
  analyzeGroup('5~15%', trades.filter(t => t.intradayRange >= 0.05 && t.intradayRange < 0.15)),
  analyzeGroup('15~25%', trades.filter(t => t.intradayRange >= 0.15 && t.intradayRange < 0.25)),
  analyzeGroup('25%+ (넓음)', trades.filter(t => t.intradayRange >= 0.25)),
]);

// ══════════════════════════════════════════════════════════
// 8. 복합 조건 탐색 — 가장 유망한 조합 찾기
// ══════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(90)}`);
console.log(' 8. 복합 조건 탐색 — 수익률 높은 조합');
console.log(`${'═'.repeat(90)}`);

const combos = [
  { name: '현행 그대로', filter: t => true },
  { name: '비고정 상한가만', filter: t => !t.isLockedLimit },
  { name: '거래대금 50억+', filter: t => t.tradingValue >= 5e9 },
  { name: '거래대금 100억+', filter: t => t.tradingValue >= 10e9 },
  { name: '꼬리 5%이하', filter: t => t.lowerWickPct <= 0.05 },
  { name: '비고정 + 거래대금50억+', filter: t => !t.isLockedLimit && t.tradingValue >= 5e9 },
  { name: '비고정 + 거래대금100억+', filter: t => !t.isLockedLimit && t.tradingValue >= 10e9 },
  { name: '비고정 + 꼬리5%이하', filter: t => !t.isLockedLimit && t.lowerWickPct <= 0.05 },
  { name: '비고정 + 볼륨10배+', filter: t => !t.isLockedLimit && t.volRatio >= 10 },
  { name: '고정상한가 + 거래대금100억+', filter: t => t.isLockedLimit && t.tradingValue >= 10e9 },
  { name: '갭25%+ (시가부터 상한가)', filter: t => t.openGap > 0.25 },
  { name: '29%+ + 비고정', filter: t => t.changeRate >= 0.29 && !t.isLockedLimit },
  { name: '29%+ + 비고정 + 거래대금50억+', filter: t => t.changeRate >= 0.29 && !t.isLockedLimit && t.tradingValue >= 5e9 },
  { name: '29%+ + 비고정 + 꼬리5%이하', filter: t => t.changeRate >= 0.29 && !t.isLockedLimit && t.lowerWickPct <= 0.05 },
  { name: '20~29% (상한가 미만만)', filter: t => t.changeRate >= 0.20 && t.changeRate < 0.29 },
  { name: '변동성 15%+ (장중 활발)', filter: t => t.intradayRange >= 0.15 },
  { name: '변동성 15%+ + 비고정', filter: t => t.intradayRange >= 0.15 && !t.isLockedLimit },
  { name: '시가갭 0~5% + 29%+', filter: t => t.openGap <= 0.05 && t.changeRate >= 0.29 },
  { name: '시가갭 0~5% + 비고정', filter: t => t.openGap <= 0.05 && !t.isLockedLimit },
];

const comboResults = [];
for (const c of combos) {
  const group = trades.filter(c.filter);
  if (group.length < 10) continue;
  const r = analyzeGroup(c.name, group);
  comboResults.push(r);
}

comboResults.sort((a, b) => parseFloat(b.avgNet) - parseFloat(a.avgNet));

console.log('그룹                               | 건수  | 승률   | 평균갭%  | 순수익%');
console.log('─'.repeat(90));
for (const r of comboResults) {
  const pad = (s, n) => String(s).padStart(n);
  console.log(
    `${r.name.padEnd(35)}| ${pad(r.count, 5)} | ${pad(r.winRate + '%', 6)} | ${pad(r.avgGap + '%', 7)} | ${pad(r.avgNet + '%', 6)}`
  );
}

// ══════════════════════════════════════════════════════════
// 9. 실전 적용 가능성 — 고정 상한가 제외 시 시뮬레이션
// ══════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(90)}`);
console.log(' 9. 실전 시뮬레이션 — 고정 상한가 제외 효과');
console.log(`${'═'.repeat(90)}`);

function simulate(name, filterFn) {
  // 날짜별로 그룹핑
  const byDate = {};
  for (const t of trades) {
    if (!filterFn(t)) continue;
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  }

  const SEED = 5_000_000;
  const MAX = 10;
  let capital = SEED;
  let maxCap = SEED, maxDD = 0;
  let wins = 0, losses = 0, totalDays = 0;

  const dates = Object.keys(byDate).sort();
  for (const date of dates) {
    let picks = byDate[date].sort((a, b) => b.changeRate - a.changeRate).slice(0, MAX);
    if (picks.length === 0) continue;
    totalDays++;
    const per = capital / picks.length;

    for (const p of picks) {
      const qty = Math.floor(per / p.close);
      if (qty <= 0) continue;
      const invested = qty * p.close;
      const ret = invested * p.overnightGap;
      const cost = invested * 0.0118;
      capital += ret - cost;
      if (ret - cost > 0) wins++; else losses++;
    }

    if (capital > maxCap) maxCap = capital;
    const dd = (maxCap - capital) / maxCap;
    if (dd > maxDD) maxDD = dd;
  }

  const total = wins + losses;
  console.log(`\n[${name}]`);
  console.log(`  거래일: ${totalDays}일, 거래: ${total}건`);
  console.log(`  승률: ${(wins/total*100).toFixed(1)}%`);
  console.log(`  최종자본: ${Math.round(capital).toLocaleString()}원 (${((capital-SEED)/SEED*100).toFixed(1)}%)`);
  console.log(`  MDD: ${(maxDD*100).toFixed(1)}%`);
  console.log(`  건당 EV: ${((capital-SEED)/total).toFixed(0)}원`);
}

simulate('A. 현행 (전체)', t => true);
simulate('B. 고정상한가 제외', t => !t.isLockedLimit);
simulate('C. 비고정 + 거래대금50억+', t => !t.isLockedLimit && t.tradingValue >= 5e9);
simulate('D. 비고정 + 거래대금100억+', t => !t.isLockedLimit && t.tradingValue >= 10e9);
simulate('E. 비고정 + 꼬리5%이하', t => !t.isLockedLimit && t.lowerWickPct <= 0.05);
simulate('F. 비고정 + 변동성15%+', t => !t.isLockedLimit && t.intradayRange >= 0.15);
simulate('G. 29%+ + 비고정', t => t.changeRate >= 0.29 && !t.isLockedLimit);
simulate('H. 시가갭0~5% + 비고정', t => t.openGap <= 0.05 && !t.isLockedLimit);

console.log('\n✅ 분석 완료');
