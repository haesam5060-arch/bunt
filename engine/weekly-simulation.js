#!/usr/bin/env node
/**
 * 번트 엔진 — 주간 시뮬레이션 (2026-03-16 ~ 2026-03-20)
 * 공격형 필터: 상한가 종가매수 → 익일 시가매도
 */

const fs = require('fs');
const path = require('path');

// ─── 설정 ───
const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const KOSDAQ_FILE = path.join(__dirname, '..', 'data', 'kosdaq-codes.json');
const TRADE_COST = 0.0118; // 1.18% (한투 수수료 0.5%×2 + 매도세 0.18%)
const SEED = 5_000_000;
const MAX_PICKS = 10;

// 매매 일정: [매수일, 매도일]
const SCHEDULE = [
  { buyDate: '2026-03-16', sellDate: '2026-03-17', label: '3/16(월) 종가매수 → 3/17(화) 시가매도' },
  { buyDate: '2026-03-17', sellDate: '2026-03-18', label: '3/17(화) 종가매수 → 3/18(수) 시가매도' },
  { buyDate: '2026-03-18', sellDate: '2026-03-19', label: '3/18(수) 종가매수 → 3/19(목) 시가매도' },
  { buyDate: '2026-03-19', sellDate: '2026-03-20', label: '3/19(목) 종가매수 → 3/20(금) 시가매도' },
];

// ─── 종목명 로드 (ranking-cache에서) ───
function loadNameMap() {
  const map = {};
  try {
    const rc = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '모의투자', 'data', 'ranking-cache.json'), 'utf8'
    ));
    if (rc.results) rc.results.forEach(r => { map[r.code] = r.name; });
  } catch(e) {}
  // state.json에서도 추가 로드
  try {
    const st = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '모의투자', 'data', 'state.json'), 'utf8'
    ));
    if (st.positions) st.positions.forEach(p => { if (p.code && p.name) map[p.code] = p.name; });
  } catch(e) {}
  return map;
}

// ─── OHLCV 전체 로드 ───
function loadAllOHLCV(codes) {
  const all = {};
  for (const code of codes) {
    const fp = path.join(OHLCV_DIR, `${code}.json`);
    if (!fs.existsSync(fp)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (Array.isArray(data) && data.length > 10) {
        // dateIndex for quick lookup
        const dateMap = {};
        data.forEach((d, i) => { dateMap[d.date] = i; });
        all[code] = { data, dateMap };
      }
    } catch(e) {}
  }
  return all;
}

// ─── 필터 적용 ───
function filterStocks(allOHLCV, buyDate) {
  const results = [];

  for (const [code, { data, dateMap }] of Object.entries(allOHLCV)) {
    const idx = dateMap[buyDate];
    if (idx === undefined || idx < 1) continue;

    const today = data[idx];
    const prev = data[idx - 1];

    // 날짜 연속성 체크 (전일이 같은 주이거나 직전 거래일)
    if (!today || !prev) continue;

    const { open, high, low, close, volume } = today;
    const prevClose = prev.close;

    if (prevClose <= 0 || high <= 0 || close <= 0) continue;

    // 등락률 (전일종가 대비 당일종가)
    const changeRate = (close - prevClose) / prevClose;

    // 종/고 비율
    const closeHighRatio = close / high;

    // 갭업 = (당일시가 - 전일종가) / 전일종가
    const gapUp = (open - prevClose) / prevClose;

    // ─── 공격형 필터 ───
    // 등락률 >= 20%
    if (changeRate < 0.20) continue;

    // 종가 = 고가 (close/high >= 1.0)
    if (closeHighRatio < 1.0) continue;

    // 갭업 >= 0%
    if (gapUp < 0) continue;

    results.push({
      code,
      changeRate,
      closeHighRatio,
      gapUp,
      close,
      open: today.open,
      high,
      low,
      volume,
      prevClose,
      prevDate: prev.date,
    });
  }

  // 등락률 내림차순 정렬
  results.sort((a, b) => b.changeRate - a.changeRate);

  // 최대 10개
  return results.slice(0, MAX_PICKS);
}

// ─── 메인 ───
function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  번트 엔진 주간 시뮬레이션 (2026-03-16 ~ 2026-03-20)');
  console.log('  공격형: 상한가 종가매수 → 익일 시가매도');
  console.log('  시드: ' + SEED.toLocaleString() + '원 | 거래비용: 0.231%');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 코스닥 코드 로드
  const kosdaqCodes = JSON.parse(fs.readFileSync(KOSDAQ_FILE, 'utf8'));
  // OHLCV 디렉토리의 모든 종목 사용 (코스닥 + 코스피)
  const allFiles = fs.readdirSync(OHLCV_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

  console.log(`종목 수: OHLCV ${allFiles.length}개 (코스닥 ${kosdaqCodes.length}개 포함)\n`);

  const nameMap = loadNameMap();
  const allOHLCV = loadAllOHLCV(allFiles);
  console.log(`로드 완료: ${Object.keys(allOHLCV).length}개 종목\n`);

  let totalTrades = 0;
  let totalWins = 0;
  let totalReturnSum = 0;
  const dailyReturns = [];
  let capital = SEED;

  for (const { buyDate, sellDate, label } of SCHEDULE) {
    console.log(`═══ ${label} ═══`);

    // 필터 적용
    const picks = filterStocks(allOHLCV, buyDate);

    if (picks.length === 0) {
      console.log('필터 통과: 0종목\n');
      dailyReturns.push({ label, avgReturn: 0, count: 0, winRate: 0 });
      continue;
    }

    // 익일 시가 확인
    const trades = [];
    for (const p of picks) {
      const { data, dateMap } = allOHLCV[p.code];
      const sellIdx = dateMap[sellDate];
      if (sellIdx === undefined) continue;

      const sellDay = data[sellIdx];
      const overnightReturn = (sellDay.open - p.close) / p.close;
      const netReturn = overnightReturn - TRADE_COST;

      trades.push({
        ...p,
        sellOpen: sellDay.open,
        overnightReturn,
        netReturn,
        name: nameMap[p.code] || '-',
      });
    }

    if (trades.length === 0) {
      console.log(`필터 통과: ${picks.length}종목 (익일 데이터 없음)\n`);
      dailyReturns.push({ label, avgReturn: 0, count: 0, winRate: 0 });
      continue;
    }

    console.log(`필터 통과: ${trades.length}종목\n`);

    // 헤더
    const hdr = [
      pad('종목명', 14),
      pad('코드', 8),
      pad('등락률', 8),
      pad('종/고', 8),
      pad('갭업', 8),
      pad('종가', 10),
      pad('익일시가', 10),
      pad('수익률', 8),
    ].join('');
    console.log(hdr);
    console.log('━'.repeat(74));

    let dayWins = 0;
    let dayReturnSum = 0;

    for (const t of trades) {
      const isWin = t.netReturn > 0;
      if (isWin) dayWins++;
      dayReturnSum += t.netReturn;

      console.log([
        pad(t.name, 14),
        pad(t.code, 8),
        pad(pct(t.changeRate), 8),
        pad(pct(t.closeHighRatio, 1), 8),
        pad(pct(t.gapUp), 8),
        pad(comma(t.close), 10),
        pad(comma(t.sellOpen), 10),
        pad(pct(t.netReturn), 8),
      ].join(''));
    }

    const avgReturn = dayReturnSum / trades.length;
    const winRate = dayWins / trades.length;

    console.log('');
    console.log(`일일 합계: 평균수익 ${pct(avgReturn)}, 승률 ${dayWins}/${trades.length} (${(winRate * 100).toFixed(0)}%)`);

    // 복리 적용 (균등배분)
    // 각 종목에 capital / N 배분, 수익률 적용 후 합산
    const perStock = capital / trades.length;
    let dayCapital = 0;
    for (const t of trades) {
      dayCapital += perStock * (1 + t.netReturn);
    }
    const dayCapitalReturn = (dayCapital - capital) / capital;
    console.log(`자본 변동: ${comma(Math.round(capital))} → ${comma(Math.round(dayCapital))} (${pct(dayCapitalReturn)})`);
    capital = dayCapital;
    console.log('');

    totalTrades += trades.length;
    totalWins += dayWins;
    totalReturnSum += dayReturnSum;
    dailyReturns.push({ label, avgReturn, count: trades.length, winRate, capitalReturn: dayCapitalReturn });
  }

  // ─── 주간 종합 ───
  console.log('═══════════════════════════════════════════════════════');
  console.log('                    주간 종합 리포트');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log(`총 거래 건수: ${totalTrades}건`);
  console.log(`전체 승률: ${totalWins}/${totalTrades} (${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : 0}%)`);
  console.log(`평균 건당 수익률: ${totalTrades > 0 ? pct(totalReturnSum / totalTrades) : '0%'}`);
  console.log('');

  console.log('일별 수익률:');
  for (const d of dailyReturns) {
    const countStr = d.count > 0 ? `${d.count}종목` : '거래없음';
    const retStr = d.count > 0 ? pct(d.avgReturn) : '-';
    const capStr = d.capitalReturn !== undefined ? pct(d.capitalReturn) : '-';
    console.log(`  ${d.label.split('→')[0].trim()}: ${countStr}, 평균 ${retStr}, 자본수익 ${capStr}`);
  }

  console.log('');
  const totalPnL = capital - SEED;
  const totalReturn = (capital - SEED) / SEED;
  console.log(`500만원 시드 기준:`);
  console.log(`  시작: ${comma(SEED)}원`);
  console.log(`  종료: ${comma(Math.round(capital))}원`);
  console.log(`  손익: ${totalPnL >= 0 ? '+' : ''}${comma(Math.round(totalPnL))}원 (${pct(totalReturn)})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ─── 유틸 ───
function pct(v, mult = 100) {
  if (mult === 1) return (v * 100).toFixed(1) + '%';
  const val = v * 100;
  return (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
}

function comma(n) {
  return Number(n).toLocaleString('ko-KR');
}

function pad(s, len) {
  // 한글은 2바이트 계산
  const sLen = [...s].reduce((acc, c) => acc + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  const diff = len - sLen;
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

main();
