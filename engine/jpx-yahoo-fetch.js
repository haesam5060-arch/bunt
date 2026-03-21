#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'jpx-ohlcv');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 일본 주요 종목 코드 (시총 상위 + 중소형 포함)
// Prime: 대형주, Standard: 중형, Growth: 소형 (코스닥 유사)
const codes = [
  // 시총 상위 50 (Prime)
  7203,8306,6501,9984,8058,8316,9983,6758,8035,8031,
  4519,6857,7011,8411,6861,6902,6367,4063,7741,9432,
  6098,9433,2914,4661,6594,8766,3382,6723,4543,6981,
  7974,8015,2802,4568,5108,6273,7267,9434,6301,3407,
  8801,2801,4901,7751,6702,9101,8830,6326,7269,4502,
  // 中型 (Standard/Prime 중하위)
  6920,3659,6526,4385,7342,6532,3923,4478,6560,7157,
  4480,3697,6095,7747,6055,4689,2413,6200,3038,6035,
  4911,6988,3436,5803,6753,4755,6752,5201,4452,7309,
  5332,6361,2503,3289,6504,7012,4204,6503,6506,5411,
  3405,5020,9104,9107,7731,5713,6471,5802,4042,3861,
  // Growth市場 (旧マザーズ) - 小型成長株
  4194,4485,4393,4434,4488,4431,4565,4592,4593,4168,
  4449,4441,4443,4563,4169,4882,4387,4446,4174,4570,
  4571,5765,7095,4011,9552,5765,4444,4176,4057,4175,
  2158,3993,4477,3491,6027,4483,4173,4167,6544,4172,
  3479,4436,6580,3966,4478,4180,4490,4192,4058,4484,
  // 追加 Growth
  7071,4053,6521,4056,4054,7072,4055,4059,4060,7073,
  4061,4062,4064,4065,4066,4067,4068,4069,4070,4071,
  7370,7371,7372,7373,7374,7375,7376,7377,7378,7379,
  5765,6523,4478,9560,7806,4477,6558,4592,7094,4198,
  4071,4072,4073,4074,4075,4076,4077,4078,4079,4080,
];

// 중복 제거
const uniqueCodes = [...new Set(codes)];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  const now = Math.floor(Date.now()/1000);
  const yearAgo = now - 365*24*3600;
  let done = 0, saved = 0;
  const total = uniqueCodes.length;
  
  for (const code of uniqueCodes) {
    const outFile = path.join(OUT_DIR, code + '.json');
    if (fs.existsSync(outFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        if (existing.length > 200) { done++; saved++; continue; }
      } catch(e) {}
    }
    
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?period1=${yearAgo}&period2=${now}&interval=1d`;
    try {
      const raw = await fetch(url);
      const json = JSON.parse(raw);
      const result = json.chart?.result?.[0];
      if (result?.timestamp) {
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
    if (done % 10 === 0) process.stdout.write(`\r${done}/${total} saved:${saved}`);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n완료: ${done}개 처리, ${saved}개 저장`);
})();
