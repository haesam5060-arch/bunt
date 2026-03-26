// ═══════════════════════════════════════════════════════════════
// 번트 스캐너 — 네이버 모바일 API 기반 코스닥 전종목 실시간 스캔
// ═══════════════════════════════════════════════════════════════
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const MARKET_VALUE_URL = 'https://m.stock.naver.com/api/stocks/marketValue/KOSDAQ';
const PRICE_URL       = 'https://m.stock.naver.com/api/stock';
const PAGE_SIZE       = 100;
const BLACKLIST_FILE  = path.join(__dirname, 'data', 'blacklist.json');

// 쉼표 포함 숫자 파싱 ("152,100" → 152100)
function parseNum(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  return parseInt(String(val).replace(/,/g, '')) || 0;
}

// ── HTTP GET 헬퍼 ──────────────────────────────────────────────
function fetchJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${url}`)), timeout);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`Parse error: ${url}`)); }
      });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── 1단계: 코스닥 전종목 시가총액 리스트 (등락률 포함) ────────
async function scanAllKosdaq() {
  // 1차: 첫 페이지로 총 종목 수 파악
  const first = await fetchJson(`${MARKET_VALUE_URL}?page=1&pageSize=${PAGE_SIZE}`);
  const totalCount = first.totalCount || 1800;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // 병렬 fetch (모든 페이지)
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    pages.push(fetchJson(`${MARKET_VALUE_URL}?page=${p}&pageSize=${PAGE_SIZE}`));
  }
  const results = await Promise.allSettled(pages);

  const stocks = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.stocks) continue;
    for (const s of r.value.stocks) {
      const code = s.itemCode || s.stockCode;
      const name = s.stockName || s.itemName;
      const close = parseNum(s.closePrice);
      const changeRate = parseFloat(s.fluctuationsRatio) / 100 || 0;  // % → 소수
      const marketCap = parseNum(s.marketValue);
      const volume = parseNum(s.accumulatedTradingVolume);
      const tradingValue = parseNum(s.accumulatedTradingValue) * 1000000; // 백만원 → 원

      if (close <= 0) continue;
      stocks.push({ code, name, close, changeRate, marketCap, volume, tradingValue });
    }
  }

  return stocks;
}

// ── 2단계: 개별 종목 OHLC 상세 조회 ──────────────────────────
async function fetchStockDetail(code) {
  // price API: 배열, [0] = 오늘 데이터 (OHLCV 포함)
  const data = await fetchJson(`${PRICE_URL}/${code}/price`);
  const today = Array.isArray(data) ? data[0] : data;
  if (!today) return { code, open: 0, high: 0, low: 0, close: 0, prevClose: 0, volume: 0 };

  const close = parseNum(today.closePrice);
  const compareTo = parseNum(today.compareToPreviousClosePrice);
  const prevClose = close - compareTo;

  return {
    code,
    open:      parseNum(today.openPrice),
    high:      parseNum(today.highPrice),
    low:       parseNum(today.lowPrice),
    close,
    prevClose,
    volume:    parseNum(today.accumulatedTradingVolume),
  };
}

// ── 2단계 병렬: 여러 종목 동시 조회 ──────────────────────────
async function fetchStockDetails(codes, concurrency = 10) {
  const results = [];
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(code => fetchStockDetail(code))
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }
  return results;
}

// ── 3단계: 필터 적용 ─────────────────────────────────────────
function applyFilter(stocks, details, preset) {
  // 블랙리스트 로드
  const bl = loadBlacklist();
  const blacklistSet = new Set(bl.codes || []);

  // details를 code로 인덱싱
  const detailMap = {};
  for (const d of details) detailMap[d.code] = d;

  const filtered = [];
  for (const s of stocks) {
    const d = detailMap[s.code];
    if (!d || d.close <= 0 || d.high <= 0 || d.open <= 0) continue;

    // 신규상장 제외 (등락률 30% 초과 = 가격제한폭 밖 = 신규상장 첫날)
    if (s.changeRate > 0.30) continue;

    // 관리종목/정리매매 제외
    if (blacklistSet.has(s.code)) continue;

    // 고정 상한가 제외 (시가=고가=종가 → 종일 상한가 고정, 실전 체결 불가)
    if (d.open === d.high && d.high === d.close && d.open === d.close) continue;

    // 등락률 필터
    if (preset.minChangeRate != null && s.changeRate < preset.minChangeRate) continue;

    // 종가=고가 필터 (close/high ≥ 98%)
    if (preset.closeIsHigh) {
      const ratio = d.close / d.high;
      if (ratio < (preset.closeIsHighPct || 0.98)) continue;
    }

    // 갭업 필터 (open > prevClose)
    if (preset.minGapUp != null) {
      const gapUp = d.prevClose > 0 ? (d.open - d.prevClose) / d.prevClose : 0;
      if (gapUp < preset.minGapUp) continue;
    }

    // 아래꼬리 필터 (low-open)/range ≤ maxLowerWick
    if (preset.maxLowerWick != null) {
      const range = d.high - d.low;
      if (range > 0) {
        const lowerWick = (Math.min(d.open, d.close) - d.low) / range;
        if (lowerWick > preset.maxLowerWick) continue;
      }
    }

    // 거래대금 필터
    if (preset.minTradingValue != null && s.tradingValue < preset.minTradingValue) continue;

    // 거래량 비율 필터
    if (preset.minVolRatio != null) {
      // 네이버 스캔에서는 5일평균 거래량 미제공 → skip (상세에서 별도 처리 가능)
    }

    filtered.push({
      ...s,
      open: d.open,
      high: d.high,
      low: d.low,
      prevClose: d.prevClose,
      closeIsHighPct: d.high > 0 ? d.close / d.high : 0,
      lowerWickPct: (d.high - d.low) > 0
        ? (Math.min(d.open, d.close) - d.low) / (d.high - d.low) : 0,
    });
  }

  // 등락률 내림차순 정렬
  filtered.sort((a, b) => b.changeRate - a.changeRate);

  // maxStocks 제한
  const maxStocks = preset.maxStocks || 10;
  return filtered.slice(0, maxStocks);
}

// ── 블랙리스트: 관리종목/정리매매 ────────────────────────────
function fetchHtml(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function updateBlacklist() {
  try {
    const html = await fetchHtml('https://finance.naver.com/sise/management.naver');
    const codes = [...html.matchAll(/code=(\d{6})/g)].map(m => m[1]);
    const unique = [...new Set(codes)];
    const data = { updatedAt: new Date().toISOString(), count: unique.length, codes: unique };
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2), 'utf8');
    return data;
  } catch (e) {
    console.error('블랙리스트 갱신 실패:', e.message);
    return loadBlacklist();
  }
}

function loadBlacklist() {
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  } catch {
    return { codes: [] };
  }
}

// ── 통합 스캔 파이프라인 ─────────────────────────────────────
async function runScanPipeline(preset) {
  const t0 = Date.now();

  // 1단계: 전종목 스캔
  const allStocks = await scanAllKosdaq();
  const t1 = Date.now();

  // 1차 필터: 등락률 기준 TOP 30 선별 (상세 조회 대상)
  const preFiltered = allStocks
    .filter(s => preset.minChangeRate != null ? s.changeRate >= preset.minChangeRate * 0.8 : true)
    .sort((a, b) => b.changeRate - a.changeRate)
    .slice(0, 30);

  // 2단계: TOP 30 상세 OHLC 조회
  const details = await fetchStockDetails(preFiltered.map(s => s.code));
  const t2 = Date.now();

  // 3단계: 정밀 필터 적용
  const selected = applyFilter(preFiltered, details, preset);
  const t3 = Date.now();

  return {
    totalScanned: allStocks.length,
    preFiltered: preFiltered.length,
    selected,
    timing: {
      scan: t1 - t0,
      detail: t2 - t1,
      filter: t3 - t2,
      total: t3 - t0,
    },
  };
}

module.exports = {
  scanAllKosdaq,
  fetchStockDetail,
  fetchStockDetails,
  applyFilter,
  runScanPipeline,
  updateBlacklist,
  loadBlacklist,
};
