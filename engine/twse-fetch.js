#!/usr/bin/env node
/**
 * 대만 TWSE 전종목 OHLCV 수집 (1년치)
 * API: https://www.twse.com.tw/rwd/en/afterTrading/STOCK_DAY
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'twse-ohlcv');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 12개월 (2025-04 ~ 2026-03)
const months = [];
for (let y = 2025, m = 4; ; ) {
  months.push(`${y}${String(m).padStart(2,'0')}01`);
  m++;
  if (m > 12) { m = 1; y++; }
  if (y === 2026 && m > 3) break;
}

const codes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'twse-codes.json'), 'utf8'));
// 거래대금 상위 300개만 (유동성 확보)
const targetCodes = codes.slice(0, 300);

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseNumber(s) {
  if (!s || s === '--' || s === 'X') return null;
  return parseFloat(String(s).replace(/,/g, ''));
}

(async () => {
  let done = 0;
  const total = targetCodes.length;
  
  for (const code of targetCodes) {
    const ohlcvFile = path.join(OUT_DIR, `${code}.json`);
    
    // 이미 수집된 파일 스킵
    if (fs.existsSync(ohlcvFile)) {
      const existing = JSON.parse(fs.readFileSync(ohlcvFile, 'utf8'));
      if (existing.length > 100) {
        done++;
        continue;
      }
    }
    
    const allData = [];
    
    for (const dateStr of months) {
      const url = `https://www.twse.com.tw/rwd/en/afterTrading/STOCK_DAY?date=${dateStr}&stockNo=${code}&response=json`;
      try {
        const raw = await fetch(url);
        const json = JSON.parse(raw);
        
        if (json.stat === 'OK' && json.data) {
          for (const row of json.data) {
            // row: [Date, TradeVolume, TradeValue, Open, High, Low, Close, Change, Transaction]
            const dateStr2 = row[0]; // e.g. "2025/04/01"
            const open = parseNumber(row[3]);
            const high = parseNumber(row[4]);
            const low = parseNumber(row[5]);
            const close = parseNumber(row[6]);
            const volume = parseNumber(row[1]);
            
            if (open && high && low && close && volume) {
              allData.push({ date: dateStr2.replace(/\//g, '-'), open, high, low, close, volume });
            }
          }
        }
      } catch(e) {
        // skip
      }
      await sleep(350); // rate limit
    }
    
    if (allData.length > 0) {
      allData.sort((a, b) => a.date.localeCompare(b.date));
      fs.writeFileSync(ohlcvFile, JSON.stringify(allData));
    }
    
    done++;
    if (done % 10 === 0) process.stdout.write(`\r${done}/${total} (${(done/total*100).toFixed(0)}%)`);
    
    await sleep(200);
  }
  
  console.log(`\n완료: ${done}개 종목 수집`);
})();
