#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'twse-ohlcv');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const codes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'twse-codes.json'), 'utf8'));
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

(async () => {
  const now = Math.floor(Date.now()/1000);
  const yearAgo = now - 365*24*3600;
  let done = 0, saved = 0;
  
  for (const code of targetCodes) {
    const outFile = path.join(OUT_DIR, code + '.json');
    
    // 이미 Yahoo 데이터 있으면 스킵 (200건 이상)
    if (fs.existsSync(outFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        if (existing.length > 200) { done++; saved++; continue; }
      } catch(e) {}
    }
    
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.TW?period1=${yearAgo}&period2=${now}&interval=1d`;
    
    try {
      const raw = await fetch(url);
      const json = JSON.parse(raw);
      const result = json.chart?.result?.[0];
      
      if (result && result.timestamp) {
        const ts = result.timestamp;
        const q = result.indicators.quote[0];
        const ohlcv = [];
        
        for (let i = 0; i < ts.length; i++) {
          if (q.open[i] && q.high[i] && q.low[i] && q.close[i] && q.volume[i]) {
            ohlcv.push({
              date: new Date(ts[i]*1000).toISOString().split('T')[0],
              open: parseFloat(q.open[i].toFixed(2)),
              high: parseFloat(q.high[i].toFixed(2)),
              low: parseFloat(q.low[i].toFixed(2)),
              close: parseFloat(q.close[i].toFixed(2)),
              volume: q.volume[i]
            });
          }
        }
        
        if (ohlcv.length > 100) {
          fs.writeFileSync(outFile, JSON.stringify(ohlcv));
          saved++;
        }
      }
    } catch(e) {}
    
    done++;
    if (done % 10 === 0) process.stdout.write(`\r${done}/${targetCodes.length} saved:${saved}`);
    await sleep(300);
  }
  
  console.log(`\n완료: ${done}개 처리, ${saved}개 저장`);
})();
