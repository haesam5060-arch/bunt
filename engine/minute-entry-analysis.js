#!/usr/bin/env node
/**
 * 분봉 매수 타이밍 분석
 * ──────────────────────────────────────────────────────────
 * 목적: 15:00~15:15 정규장 매수 vs 15:20 동시호가 매수
 *       어느 시점이 더 싼 가격에 매수 가능한지 검증
 *
 * 분석 대상: OHLCV에서 29%+ 상한가 근접 종목들의 분봉 데이터
 * 비교 시나리오:
 *   A) 종가 매수 (현행 — 15:30 체결가)
 *   B) 15:00 시점 매수
 *   C) 15:00~15:15 최저가 매수 (눌림 구간 저점)
 *   D) 15:00~15:15 평균가 매수 (분할매수 시뮬)
 *   E) 15:10~15:19 최저가 매수
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), 10000);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// OHLCV에서 최근 분봉 조회 가능한 날짜의 29%+ 종목 찾기
const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');

async function findTargetStocks() {
  const files = fs.readdirSync(OHLCV_DIR).filter(f => f.endsWith('.json'));
  const targets = []; // { code, date, changeRate, close, prevClose }

  for (const f of files) {
    const code = f.replace('.json', '');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, f), 'utf8'));
      if (!Array.isArray(data) || data.length < 10) continue;

      for (let i = 1; i < data.length; i++) {
        const d = data[i], prev = data[i - 1];
        if (!d.date || !d.close || !prev.close || prev.close <= 0) continue;
        // 최근 6거래일만 (분봉 조회 가능 범위)
        if (d.date < '2026-03-20' || d.date > '2026-03-26') continue;

        const cr = (d.close - prev.close) / prev.close;
        if (cr < 0.29 || cr > 0.32) continue;

        const chp = d.high > 0 ? d.close / d.high : 0;
        if (chp < 0.999) continue; // 종가=고가

        // 고정 상한가 제외 (시=고=종)
        if (d.open === d.high && d.high === d.close) continue;

        const nextDay = i + 1 < data.length ? data[i + 1] : null;

        targets.push({
          code, date: d.date,
          changeRate: cr,
          open: d.open, high: d.high, low: d.low, close: d.close,
          prevClose: prev.close,
          nextOpen: nextDay ? nextDay.open : null,
          volume: d.volume,
        });
      }
    } catch (e) {}
  }
  return targets;
}

async function getMinuteData(code, date) {
  // date: '2026-03-20' → '20260320'
  const dt = date.replace(/-/g, '');
  const url = `https://api.stock.naver.com/chart/domestic/item/${code}/minute?startDateTime=${dt}090000&endDateTime=${dt}153000`;
  try {
    const data = await fetchJson(url);
    if (!Array.isArray(data)) return [];
    // 해당 날짜만 필터
    return data.filter(d => d.localDateTime && d.localDateTime.startsWith(dt));
  } catch (e) {
    return [];
  }
}

async function main() {
  console.log('1. 대상 종목 탐색 (OHLCV에서 29%+ 비고정 상한가)...');
  const targets = await findTargetStocks();
  console.log(`   ${targets.length}건 발견\n`);

  if (targets.length === 0) {
    console.log('대상 없음');
    return;
  }

  // 날짜별로 그룹핑
  const byDate = {};
  for (const t of targets) {
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  }

  console.log('날짜별 종목 수:');
  for (const [date, items] of Object.entries(byDate).sort()) {
    console.log(`  ${date}: ${items.length}종목`);
  }
  console.log('');

  console.log('2. 분봉 데이터 수집 + 분석...\n');

  const results = [];

  for (const t of targets) {
    await sleep(200); // rate limit 방지
    const minutes = await getMinuteData(t.code, t.date);
    if (minutes.length < 10) {
      continue;
    }

    // 시간대별 가격 추출
    const getPrice = (hhmm) => {
      const target = t.date.replace(/-/g, '') + hhmm + '00';
      const m = minutes.find(d => d.localDateTime === target);
      return m ? m.currentPrice : null;
    };

    // 15:00~15:15 범위의 분봉들
    const dt = t.date.replace(/-/g, '');
    const afternoon = minutes.filter(d => {
      const hhmm = d.localDateTime.slice(8, 12);
      return hhmm >= '1500' && hhmm <= '1515';
    });

    const afternoon2 = minutes.filter(d => {
      const hhmm = d.localDateTime.slice(8, 12);
      return hhmm >= '1510' && hhmm <= '1519';
    });

    if (afternoon.length === 0) continue;

    const price1500 = getPrice('1500');
    const price1520 = getPrice('1520');
    const closingPrice = t.close; // 15:30 종가

    // 15:00~15:15 최저가 (눌림 저점)
    const lowPrices = afternoon.map(d => d.lowPrice).filter(p => p > 0);
    const minPrice1500_1515 = Math.min(...lowPrices);

    // 15:00~15:15 평균 종가 (분할매수 시뮬)
    const avgPrice1500_1515 = afternoon.reduce((s, d) => s + d.currentPrice, 0) / afternoon.length;

    // 15:10~15:19 최저가
    const lowPrices2 = afternoon2.map(d => d.lowPrice).filter(p => p > 0);
    const minPrice1510_1519 = lowPrices2.length > 0 ? Math.min(...lowPrices2) : null;

    // 09:00~09:10 시가 (다음날 매도가 대용 — 당일 시가로 대체)
    const morningOpen = minutes.find(d => d.localDateTime.slice(8, 12) === '0901');
    const openPrice = morningOpen ? morningOpen.openPrice : t.open;

    // 익일 시가 (실제 매도가)
    const nextOpen = t.nextOpen;

    const entry = {
      code: t.code, date: t.date,
      changeRate: t.changeRate,
      closingPrice, // 15:30 종가 (현행 매수가)
      price1500: price1500,
      minPrice1500_1515: minPrice1500_1515,
      avgPrice1500_1515: Math.round(avgPrice1500_1515),
      minPrice1510_1519: minPrice1510_1519,
      nextOpen: nextOpen,
      // 할인율 (종가 대비 얼마나 싸게 살 수 있는지)
      discount1500: price1500 ? ((closingPrice - price1500) / closingPrice * 100).toFixed(2) : null,
      discountMin: ((closingPrice - minPrice1500_1515) / closingPrice * 100).toFixed(2),
      discountAvg: ((closingPrice - avgPrice1500_1515) / closingPrice * 100).toFixed(2),
      discountMin1510: minPrice1510_1519 ? ((closingPrice - minPrice1510_1519) / closingPrice * 100).toFixed(2) : null,
      // 수익률 비교 (익일 시가 기준)
      returnClosing: nextOpen ? ((nextOpen - closingPrice) / closingPrice * 100).toFixed(2) : null,
      returnMin: nextOpen ? ((nextOpen - minPrice1500_1515) / minPrice1500_1515 * 100).toFixed(2) : null,
      returnAvg: nextOpen ? ((nextOpen - avgPrice1500_1515) / avgPrice1500_1515 * 100).toFixed(2) : null,
    };

    results.push(entry);
    const name = t.code.padEnd(8);
    console.log(`  ${t.date} ${name} 종가:${closingPrice} 15시:${price1500||'N/A'} 눌림저점:${minPrice1500_1515} 할인:${entry.discountMin}% 익일수익:${entry.returnClosing||'N/A'}%→${entry.returnMin||'N/A'}%`);
  }

  console.log(`\n${'═'.repeat(90)}`);
  console.log(' 매수 타이밍별 성과 비교');
  console.log(`${'═'.repeat(90)}`);

  // 익일 시가 있는 것만
  const withNext = results.filter(r => r.nextOpen);

  if (withNext.length === 0) {
    console.log('익일 데이터 없음 (오늘 매수한 종목만 있을 수 있음)');
    // 할인율만이라도 출력
    console.log('\n할인율 분석 (종가 대비 얼마나 싸게 살 수 있는지):');
    const allDisc = results.map(r => parseFloat(r.discountMin)).filter(d => !isNaN(d));
    const allDiscAvg = results.map(r => parseFloat(r.discountAvg)).filter(d => !isNaN(d));
    if (allDisc.length > 0) {
      console.log(`  15:00~15:15 저점 매수 시 평균 할인: ${(allDisc.reduce((a,b)=>a+b,0)/allDisc.length).toFixed(2)}%`);
      console.log(`  15:00~15:15 분할매수 시 평균 할인: ${(allDiscAvg.reduce((a,b)=>a+b,0)/allDiscAvg.length).toFixed(2)}%`);
    }
    // 결과 저장
    fs.writeFileSync(
      path.join(__dirname, '..', 'results', 'minute-entry-analysis.json'),
      JSON.stringify(results, null, 2), 'utf8'
    );
    console.log('\n결과 저장: results/minute-entry-analysis.json');
    return;
  }

  function avg(arr) { return arr.length > 0 ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }

  const retClosing = withNext.map(r => parseFloat(r.returnClosing));
  const retMin = withNext.map(r => parseFloat(r.returnMin));
  const retAvg = withNext.map(r => parseFloat(r.returnAvg));

  console.log(`\n분석 대상: ${withNext.length}건 (익일 시가 있는 종목)\n`);

  console.log('매수 시점                    | 평균 수익률 | 중간값    | 승률');
  console.log('─'.repeat(70));

  const median = arr => { const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
  const winRate = arr => (arr.filter(v => v > 0).length / arr.length * 100).toFixed(1);

  console.log(`A) 종가 매수 (현행 15:30)     | ${avg(retClosing).toFixed(2)}%     | ${median(retClosing).toFixed(2)}%   | ${winRate(retClosing)}%`);
  console.log(`B) 15:00~15:15 저점 매수      | ${avg(retMin).toFixed(2)}%     | ${median(retMin).toFixed(2)}%   | ${winRate(retMin)}%`);
  console.log(`C) 15:00~15:15 분할매수(평균)  | ${avg(retAvg).toFixed(2)}%     | ${median(retAvg).toFixed(2)}%   | ${winRate(retAvg)}%`);

  // 할인율 분석
  const discMin = results.map(r => parseFloat(r.discountMin)).filter(d => !isNaN(d));
  const discAvg = results.map(r => parseFloat(r.discountAvg)).filter(d => !isNaN(d));
  const disc1500 = results.map(r => parseFloat(r.discount1500)).filter(d => !isNaN(d));

  console.log(`\n${'═'.repeat(90)}`);
  console.log(' 할인율 (종가 대비 얼마나 싸게 매수 가능한지)');
  console.log(`${'═'.repeat(90)}`);
  console.log(`  15:00 시점 매수:         평균 ${avg(disc1500).toFixed(2)}% 할인`);
  console.log(`  15:00~15:15 저점 매수:   평균 ${avg(discMin).toFixed(2)}% 할인`);
  console.log(`  15:00~15:15 분할매수:    평균 ${avg(discAvg).toFixed(2)}% 할인`);

  // 결과 저장
  fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'results', 'minute-entry-analysis.json'),
    JSON.stringify(results, null, 2), 'utf8'
  );
  console.log('\n결과 저장: results/minute-entry-analysis.json');
}

main().catch(e => console.error(e));
