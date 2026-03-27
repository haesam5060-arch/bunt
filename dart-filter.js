/**
 * DART 악재 사전 필터 — 매수 전 종목 리스크 체크
 *
 * 체크 항목:
 * 1. 최근 공시 중 악재 키워드 (부도, 영업정지, 회생절차, 감자 등)
 * 2. 연속 적자 여부 (최근 2~3기 재무제표)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DART_API_KEY = '2f3d397660dc024828a5a11be8e69adeae669a74';
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'dart-cache.json');
const CORP_MAP_FILE = path.join(DATA_DIR, 'dart-corp-map.json');

// 악재 키워드
const ADVERSE_KEYWORDS = [
  '부도', '영업정지', '회생절차', '해산', '감자', '상장폐지',
  '횡령', '배임', '과징금', '검찰', '기소', '분식',
  '감사의견거절', '의견거절', '한정', '부적정',
  '관리종목', '투자주의', '투자경고', '투자위험',
  '자본잠식', '채무불이행'
];

// ── 캐시 ──────────────────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (data.date === today) return data.results || {};
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveCache(results) {
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ date: today, results }, null, 2), 'utf8');
}

// ── corp_code 매핑 (stock_code → corp_code) ──────────────────
function loadCorpMap() {
  try {
    if (fs.existsSync(CORP_MAP_FILE)) {
      const stat = fs.statSync(CORP_MAP_FILE);
      const ageMs = Date.now() - stat.mtimeMs;
      // 30일 이내면 재사용
      if (ageMs < 30 * 86400000) {
        return JSON.parse(fs.readFileSync(CORP_MAP_FILE, 'utf8'));
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function refreshCorpMap() {
  try {
    const zipPath = path.join(DATA_DIR, '_corpCode.zip');
    const tmpDir = path.join(DATA_DIR, '_corpCode_tmp');

    // 1. ZIP 다운로드
    execSync(`curl -s -o "${zipPath}" "https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}"`, { timeout: 30000 });
    // 2. 압축 해제
    execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { timeout: 10000 });
    // 3. XML 파싱
    const xml = fs.readFileSync(path.join(tmpDir, 'CORPCODE.xml'), 'utf8');
    const map = {};
    const regex = /<list>[\s\S]*?<corp_code>(\d+)<\/corp_code>[\s\S]*?<stock_code>([^<]*)<\/stock_code>[\s\S]*?<\/list>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const [_, corpCode, stockCode] = match;
      if (stockCode && stockCode.trim()) map[stockCode.trim()] = corpCode;
    }
    fs.writeFileSync(CORP_MAP_FILE, JSON.stringify(map), 'utf8');
    // 4. 정리
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);
    return map;
  } catch (e) {
    return null;
  }
}

function getCorpCode(stockCode) {
  let map = loadCorpMap();
  if (!map) map = refreshCorpMap();
  return map ? (map[stockCode] || null) : null;
}

// ── DART API 호출 ────────────────────────────────────────────
function dartApi(endpoint, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ crtfc_key: DART_API_KEY, ...params }).toString();
    const urlStr = `https://opendart.fss.or.kr/api/${endpoint}?${qs}`;
    const urlObj = new URL(urlStr);
    const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };
    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('DART API 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('DART API 타임아웃')); });
  });
}

// ── 최근 악재 공시 체크 (90일) ───────────────────────────────
async function checkAdverseDisclosures(corpCode) {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86400000);
  const bgn = start.toISOString().slice(0, 10).replace(/-/g, '');
  const end_de = end.toISOString().slice(0, 10).replace(/-/g, '');
  const risks = [];

  for (const [code, label] of [['B', '주요사항'], ['F', '감사관련'], ['I', '거래소공시']]) {
    try {
      const res = await dartApi('list.json', { corp_code: corpCode, bgn_de: bgn, end_de: end_de, pblntf_ty: code });
      if (res.status === '000' && res.list) {
        for (const item of res.list) {
          const title = item.report_nm || '';
          const matched = ADVERSE_KEYWORDS.filter(kw => title.includes(kw));
          if (matched.length > 0) {
            risks.push({ date: item.rcept_dt, title, keywords: matched, type: label });
          }
        }
      }
    } catch (e) { /* 개별 타입 실패 무시 */ }
  }
  return risks;
}

// ── 연속 적자 체크 ───────────────────────────────────────────
async function checkConsecutiveLoss(corpCode) {
  const currentYear = new Date().getFullYear();
  const losses = [];

  for (let yr = currentYear - 1; yr >= currentYear - 3; yr--) {
    try {
      const res = await dartApi('fnlttSinglAcnt.json', {
        corp_code: corpCode,
        bsns_year: String(yr),
        reprt_code: '11011',
        fs_div: 'OFS'
      });
      if (res.status === '000' && res.list) {
        const netIncome = res.list.find(item =>
          (item.account_nm || '').includes('당기순이익') || (item.account_nm || '').includes('당기순손익')
        );
        if (netIncome) {
          const amount = parseInt((netIncome.thstrm_amount || '0').replace(/,/g, ''));
          if (amount < 0) losses.push({ year: yr, amount });
        }
      }
    } catch (e) { /* skip */ }
  }
  return losses;
}

// ── 메인: 종목 악재 체크 ─────────────────────────────────────
async function checkStockRisk(stockCode, stockName) {
  const cache = loadCache();
  if (cache[stockCode]) return cache[stockCode];

  const result = { pass: true, risks: [], summary: '' };

  try {
    const corpCode = getCorpCode(stockCode);
    if (!corpCode) {
      result.summary = 'DART 미등록';
      cache[stockCode] = result;
      saveCache(cache);
      return result;
    }

    // 1. 적자 체크: 최근 3기 중 2기 이상 적자 시 차단, 직전기 대규모 적자 시 경고
    const losses = await checkConsecutiveLoss(corpCode);
    if (losses.length >= 2) {
      result.pass = false;
      result.risks.push(`최근 3기 중 ${losses.length}기 적자: ${losses.map(l => `${l.year}년 ${(l.amount / 100000000).toFixed(1)}억`).join(', ')}`);
    } else if (losses.length === 1 && losses[0].amount < -5000000000) {
      result.risks.push(`직전기 대규모 적자: ${losses[0].year}년 ${(losses[0].amount / 100000000).toFixed(1)}억 (주의)`);
    }

    // 2. 악재 공시 체크
    const disclosures = await checkAdverseDisclosures(corpCode);
    if (disclosures.length > 0) {
      result.pass = false;
      result.risks.push(...disclosures.map(d => `[${d.date}] ${d.type}: ${d.title}`));
    }

    result.summary = result.pass ? '악재 미발견' : `악재 ${result.risks.length}건 발견`;
  } catch (e) {
    result.summary = `DART 조회 실패: ${e.message}`;
  }

  cache[stockCode] = result;
  saveCache(cache);
  return result;
}

// ── 스캔 결과 필터링 ─────────────────────────────────────────
async function filterByRisk(stocks, logFn = console.log) {
  const passed = [];
  const filtered = [];

  for (const stock of stocks) {
    try {
      const result = await checkStockRisk(stock.code, stock.name);
      if (result.pass) {
        passed.push(stock);
      } else {
        filtered.push({ ...stock, risks: result.risks, summary: result.summary });
        logFn(`🚫 악재 필터: ${stock.name}(${stock.code}) 제외 — ${result.summary}`);
        for (const r of result.risks) logFn(`   └ ${r}`);
      }
    } catch (e) {
      passed.push(stock);
    }
  }

  return { passed, filtered };
}

module.exports = { checkStockRisk, filterByRisk };
