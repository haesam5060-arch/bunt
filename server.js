// ═══════════════════════════════════════════════════════════════
// 번트(BUNT) — 코스닥 오버나잇 자동매매 엔진
// 전략: 장마감 10분전 코스닥 스캔 → 필터 → 매수 → 익일 시가 매도
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const cron    = require('node-cron');

const { runScanPipeline, scanAllKosdaq, fetchStockDetails, applyFilter, updateBlacklist } = require('./scanner');
const {
  getToken, getBalance, orderBuy, orderSell, getOrders, getOrderLog, getCurrentPrice
} = require('./account-service');
const emailService = require('./email-service');

// ── 설정/상태 파일 (모드별 분리) ─────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const DATA_DIR    = path.join(__dirname, 'data');

function stateFile(mode)    { return path.join(DATA_DIR, `state-${mode}.json`); }
function tradeLogFile(mode) { return path.join(DATA_DIR, `trade-log-${mode}.json`); }

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function emptyState() {
  return { positions: [], history: [], dailyPnl: [], lastScan: null, lastBuy: null, lastSell: null, totalPnl: 0, tradingDays: 0 };
}

function loadState(mode) {
  try { return JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')); }
  catch { return emptyState(); }
}

function saveState(st, mode) {
  fs.writeFileSync(stateFile(mode), JSON.stringify(st, null, 2), 'utf8');
}

function appendTradeLog(entry, mode) {
  const file = tradeLogFile(mode);
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  logs.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (logs.length > 2000) logs = logs.slice(0, 2000);
  fs.writeFileSync(file, JSON.stringify(logs, null, 2), 'utf8');
}

function loadTradeLog(mode) {
  try { return JSON.parse(fs.readFileSync(tradeLogFile(mode), 'utf8')); }
  catch { return []; }
}

// ── 글로벌 상태 (듀얼모드: 모의+실전 동시 운영) ────────────────
let config = loadConfig();
emailService.init(config);

// 모의/실전 각각 별도 상태
let paperState = loadState('paper');
let realState  = loadState('real');
let lastScanResult = paperState.lastScanResult || null;
let engineLog = [];     // 최근 100개 엔진 로그

// 현재 대시보드 뷰모드 (어떤 모드의 데이터를 보여줄지)
// config.viewMode: 'paper' | 'real'
// 하위 호환: 기존 config.tradingMode → viewMode로 매핑
if (!config.viewMode) config.viewMode = config.tradingMode || 'paper';
if (config.realAutoTrading === undefined) config.realAutoTrading = false;

// state 헬퍼: viewMode에 따라 state 리턴
function getState(mode) { return mode === 'real' ? realState : paperState; }
function setStateByMode(mode, st) { if (mode === 'real') realState = st; else paperState = st; }

// 하위 호환용 (기존 코드에서 state 참조하던 부분을 위해)
let state = getState(config.viewMode);

function kstNow() {
  return new Date(Date.now() + 9 * 3600000);
}

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg, level = 'info') {
  const ts = kstNow().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  engineLog.unshift({ ts, level, msg });
  if (engineLog.length > 200) engineLog = engineLog.slice(0, 200);

  // 파일 로그 (일별 로테이션)
  const dateStr = kstNow().toISOString().slice(0, 10);
  const logFile = path.join(LOG_DIR, `bunt-${dateStr}.log`);
  try { fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch {}
}

// ── KIS 토큰 관리 (모드별 분리) ──────────────────────────────
let kisTokenPaper = null;
let kisTokenReal  = null;
let sellRetryTimerPaper = null;
let sellRetryTimerReal  = null;
let sellRetryCountPaper = 0;
let sellRetryCountReal  = 0;
const SELL_RETRY_MAX = 10;
const SELL_RETRY_INTERVAL = 60_000;

function tokenFile(mode) { return path.join(__dirname, 'data', `token-${mode}.json`); }

async function ensureToken(mode = 'paper', forceRefresh = false) {
  const isReal = mode === 'real';
  let token = isReal ? kisTokenReal : kisTokenPaper;

  // 강제 검증: 실전 매수/매도 직전에 사용
  // KIS API는 토큰 발급 1분당 1회 제한이므로 무조건 재발급하면 안 됨
  // 대신: 토큰으로 현재가 조회(가벼운 API)를 시도하여 유효성 실제 검증
  if (forceRefresh) {
    log(`[${isReal ? '실전' : '모의'}] 🔑 토큰 유효성 실제 검증 (매매 직전 안전장치)`);
    if (token) {
      try {
        // 삼성전자(005930) 현재가 조회로 토큰 유효성 실검
        await getCurrentPrice(token, config.appKey, config.appSecret, '005930', mode);
        log(`[${isReal ? '실전' : '모의'}] ✅ 토큰 유효 확인됨`);
        return token;
      } catch (e) {
        log(`[${isReal ? '실전' : '모의'}] ⚠️ 토큰 무효 — 재발급 시도: ${e.message}`, 'warn');
        token = null;
        if (isReal) kisTokenReal = null; else kisTokenPaper = null;
      }
    }
    // 토큰이 없거나 무효한 경우에만 재발급
    token = await getToken(config.appKey, config.appSecret, mode, { forceRefresh: true });
    if (isReal) kisTokenReal = token; else kisTokenPaper = token;
    return token;
  }

  if (!token) {
    token = await getToken(config.appKey, config.appSecret, mode);
    if (isReal) kisTokenReal = token; else kisTokenPaper = token;
    log(`[${isReal ? '실전' : '모의'}] KIS 토큰 발급 완료`);
  } else {
    try {
      const tf = tokenFile(mode);
      // 기존 token.json 호환 + 모드별 분리
      const tPath = fs.existsSync(tf) ? tf : path.join(__dirname, 'data', 'token.json');
      const tokenData = JSON.parse(fs.readFileSync(tPath, 'utf8'));
      const TOKEN_MARGIN_MS = 5 * 60 * 1000; // 만료 5분 전에 미리 재발급
      if (!tokenData.expires || new Date(tokenData.expires) <= new Date(Date.now() + TOKEN_MARGIN_MS)) {
        log(`[${isReal ? '실전' : '모의'}] KIS 토큰 만료 감지 — 재발급`, 'warn');
        token = null;
        token = await getToken(config.appKey, config.appSecret, mode);
        if (isReal) kisTokenReal = token; else kisTokenPaper = token;
        log(`[${isReal ? '실전' : '모의'}] KIS 토큰 재발급 완료`);
      }
    } catch {
      token = null;
      token = await getToken(config.appKey, config.appSecret, mode);
      if (isReal) kisTokenReal = token; else kisTokenPaper = token;
    }
  }
  return token;
}

// ── 매수 재시도 (DNS/네트워크 에러 대응) ──────────────────────
async function executeBuyWithRetry(mode = 'paper', maxRetry = 3) {
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      await executeBuyPipeline(mode);
      return; // 성공 시 종료
    } catch (e) {
      const isNetErr = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(e.message);
      if (isNetErr && attempt < maxRetry) {
        const wait = attempt * 10_000; // 10초, 20초, 30초
        log(`${modeTag} ⚠️ 네트워크 에러 (${attempt}/${maxRetry}): ${e.message} — ${wait/1000}초 후 재시도`, 'warn');
        await sleep(wait);
      } else {
        throw e; // 네트워크 에러가 아니거나 최대 재시도 초과
      }
    }
  }
}

// ── 매도 재시도 (DNS/네트워크 에러 대응) ──────────────────────
async function executeSellWithRetry(mode = 'paper', maxRetry = 3) {
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      await executeSellPipeline(mode);
      return;
    } catch (e) {
      const isNetErr = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(e.message);
      if (isNetErr && attempt < maxRetry) {
        const wait = attempt * 10_000;
        log(`${modeTag} ⚠️ 매도 네트워크 에러 (${attempt}/${maxRetry}): ${e.message} — ${wait/1000}초 후 재시도`, 'warn');
        await sleep(wait);
      } else {
        throw e;
      }
    }
  }
}

// ── 핵심 로직: 스캔 + 매수 ──────────────────────────────────
async function executeBuyPipeline(mode = 'paper') {
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';
  const st = getState(mode);
  const preset = config.presets[config.preset];
  if (!preset) { log(`${modeTag} 프리셋 '${config.preset}' 없음`, 'error'); return; }

  log(`${modeTag} === 매수 파이프라인 시작 (${preset.label}) ===`);

  // 1. 네이버 스캔
  let scanResult;
  try {
    scanResult = await runScanPipeline(preset);
    lastScanResult = scanResult;
    st.lastScanResult = scanResult;
    log(`${modeTag} 스캔 완료: ${scanResult.totalScanned}종목 → ${scanResult.preFiltered}개 사전필터 → ${scanResult.selected.length}개 선정 (${scanResult.timing.total}ms)`);
  } catch (e) {
    log(`${modeTag} 스캔 실패: ${e.message}`, 'error');
    return;
  }

  if (scanResult.selected.length === 0) {
    log(`${modeTag} 필터 통과 종목 없음 — 오늘 매수 스킵`);
    st.lastScan = new Date().toISOString();
    saveState(st, mode);
    return;
  }

  // 1-b. 연속 상한가 재진입 필터: 전일 매수한 종목은 제외
  const yesterdayBuyCodes = new Set();
  const tradeLog = loadTradeLog(mode);
  const today = new Date().toISOString().slice(0, 10);
  let prevDate = null;
  for (const t of tradeLog) {
    if (t.action !== 'BUY') continue;
    const tDate = (t.timestamp || '').slice(0, 10);
    if (tDate >= today) continue;
    if (!prevDate) prevDate = tDate;
    if (tDate === prevDate) {
      yesterdayBuyCodes.add(t.code);
    } else {
      break;
    }
  }

  if (yesterdayBuyCodes.size > 0) {
    const before = scanResult.selected.length;
    scanResult.selected = scanResult.selected.filter(s => !yesterdayBuyCodes.has(s.code));
    const filtered = before - scanResult.selected.length;
    if (filtered > 0) {
      log(`${modeTag} 🔄 연속 상한가 재진입 필터: ${filtered}종목 제외 (전일 매수: ${[...yesterdayBuyCodes].join(',')})`);
    }
    if (scanResult.selected.length === 0) {
      log(`${modeTag} 재진입 필터 후 종목 없음 — 매수 스킵`);
      st.lastScan = new Date().toISOString();
      saveState(st, mode);
      return;
    }
  }

  // 2. 잔고 확인 (실전: 매매 직전 토큰 강제 재발급)
  let availCash;
  const token = await ensureToken(mode, mode === 'real');
  const seedCapital = mode === 'real' ? (config.realInitialCapital || 100000) : config.initialCapital;

  if (mode === 'paper') {
    const holdingValue = (st.positions || []).reduce((s, p) => s + (p.buyPrice || 0) * (p.qty || 0), 0);
    availCash = (seedCapital + (st.totalPnl || 0)) - holdingValue;
    log(`${modeTag} 예수금: ${availCash.toLocaleString()}원 (시드 ${seedCapital.toLocaleString()} + PnL ${(st.totalPnl || 0).toLocaleString()} - 보유 ${holdingValue.toLocaleString()})`);
  } else {
    let balance;
    try {
      balance = await getBalance(token, config.appKey, config.appSecret, config.cano, mode);
      log(`${modeTag} 예수금: ${balance.deposit.toLocaleString()}원`);
    } catch (e) {
      const errMsg = e.message || '';
      if (errMsg.includes('토큰') || errMsg.includes('token') || errMsg.includes('접근토큰') || errMsg.includes('만료')) {
        log(`${modeTag} 잔고 조회 토큰 만료 감지 — 재발급 후 재시도`, 'warn');
        if (mode === 'real') kisTokenReal = null; else kisTokenPaper = null;
        try {
          const newToken = await ensureToken(mode);
          balance = await getBalance(newToken, config.appKey, config.appSecret, config.cano, mode);
          log(`${modeTag} 예수금(재시도 성공): ${balance.deposit.toLocaleString()}원`);
        } catch (e2) {
          log(`${modeTag} 잔고 조회 재시도 실패: ${e2.message}`, 'error');
          return;
        }
      } else {
        log(`${modeTag} 잔고 조회 실패: ${errMsg}`, 'error');
        return;
      }
    }
    availCash = balance.deposit;
  }
  if (availCash < 10000) {
    log(`${modeTag} 예수금 부족 (1만원 미만) — 매수 스킵`, 'warn');
    return;
  }

  // 3. 종목별 투자금 균등 배분
  const selected = scanResult.selected;
  const perStock = Math.floor(availCash / selected.length);
  log(`${modeTag} ${selected.length}종목 선정, 종목당 ${perStock.toLocaleString()}원 배분`);

  // 4. 매수 주문 실행
  const buyResults = [];
  for (const stock of selected) {
    const qty = Math.floor(perStock / stock.close);
    if (qty <= 0) {
      log(`${modeTag} ${stock.name}(${stock.code}): 단가 ${stock.close}원 > 배분금 → 스킵`, 'warn');
      continue;
    }

    if (mode === 'paper') {
      log(`${modeTag} ✅ 매수: ${stock.name}(${stock.code}) ${qty}주 × ${stock.close.toLocaleString()}원 = ${(qty * stock.close).toLocaleString()}원`);
      buyResults.push({ ...stock, qty, ordNo: `PAPER-${Date.now()}` });
      appendTradeLog({ action: 'BUY', code: stock.code, name: stock.name, qty, price: stock.close, changeRate: stock.changeRate, preset: config.preset }, mode);
    } else {
      let buyToken = token;
      let buySuccess = false;
      for (let tryIdx = 0; tryIdx < 2 && !buySuccess; tryIdx++) {
        try {
          const result = await orderBuy(buyToken, config.appKey, config.appSecret, config.cano, { code: stock.code, qty, price: stock.close, orderType: 'market' }, mode);
          log(`${modeTag} ✅ 매수: ${stock.name}(${stock.code}) ${qty}주 × ${stock.close.toLocaleString()}원 = ${(qty * stock.close).toLocaleString()}원`);
          buyResults.push({ ...stock, qty, ordNo: result.ordNo });
          appendTradeLog({ action: 'BUY', code: stock.code, name: stock.name, qty, price: stock.close, changeRate: stock.changeRate, preset: config.preset }, mode);
          buySuccess = true;
          await sleep(250);
        } catch (e) {
          const errMsg = e.message || '';
          if (tryIdx === 0 && (errMsg.includes('토큰') || errMsg.includes('token') || errMsg.includes('접근토큰') || errMsg.includes('만료'))) {
            log(`${modeTag} 매수 토큰 만료 감지 — 재발급 후 재시도: ${stock.name}(${stock.code})`, 'warn');
            if (mode === 'real') kisTokenReal = null; else kisTokenPaper = null;
            try { buyToken = await ensureToken(mode); } catch { break; }
          } else {
            log(`${modeTag} ❌ 매수실패: ${stock.name}(${stock.code}) — ${errMsg}`, 'error');
            break;
          }
        }
      }
    }
  }

  // 5. 상태 업데이트
  st.positions = buyResults.map(s => ({
    code: s.code, name: s.name, qty: s.qty,
    buyPrice: s.close, buyDate: new Date().toISOString().slice(0, 10),
    changeRate: s.changeRate, ordNo: s.ordNo,
  }));
  st.lastBuy = new Date().toISOString();
  st.lastScan = new Date().toISOString();
  saveState(st, mode);
  setStateByMode(mode, st);

  log(`${modeTag} === 매수 완료: ${buyResults.length}종목 ===`);
  emailService.sendBuyReport(buyResults, mode, preset.label).catch(() => {});
}

// ── 거래 비용 (한투 수수료) ───────────────────────────────────
const COMMISSION_RATE = 0.005;   // 편도 0.5% (한투 50만원 기준)
const SELL_TAX_RATE   = 0.0018;  // 매도세 0.18% (코스닥)

function calcNetPnl(buyPrice, sellPrice, qty) {
  const buyCost  = buyPrice * qty * COMMISSION_RATE;   // 매수 수수료
  const sellCost = sellPrice * qty * COMMISSION_RATE;  // 매도 수수료
  const sellTax  = sellPrice * qty * SELL_TAX_RATE;    // 매도세
  const grossPnl = (sellPrice - buyPrice) * qty;
  return { pnl: Math.round(grossPnl - buyCost - sellCost - sellTax), pnlPct: buyPrice > 0 ? (sellPrice - buyPrice) / buyPrice - COMMISSION_RATE * 2 - SELL_TAX_RATE : 0 };
}

// ── 핵심 로직: 익일 시가 매도 ────────────────────────────────
const _sellLock = { paper: false, real: false };

async function executeSellPipeline(mode = 'paper') {
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';

  if (_sellLock[mode]) {
    log(`${modeTag} 매도 이미 진행 중 — 중복 실행 방지`);
    return;
  }
  _sellLock[mode] = true;

  try {
    await _executeSellPipelineInner(mode);
  } finally {
    _sellLock[mode] = false;
  }
}

async function _executeSellPipelineInner(mode = 'paper') {
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';
  const st = getState(mode);

  if (!st.positions || st.positions.length === 0) {
    log(`${modeTag} 보유 종목 없음 — 매도 스킵`);
    return;
  }

  log(`${modeTag} === 매도 파이프라인 시작 (${st.positions.length}종목) ===`);

  if (mode === 'paper') {
    const sellResults = [];
    for (const pos of st.positions) {
      try {
        let token = await ensureToken('paper');
        let cur;
        try {
          cur = await getCurrentPrice(token, config.appKey, config.appSecret, pos.code, 'paper');
        } catch (te) {
          const tMsg = te.message || '';
          if (tMsg.includes('토큰') || tMsg.includes('token') || tMsg.includes('접근토큰') || tMsg.includes('만료')) {
            kisTokenPaper = null;
            token = await ensureToken('paper');
            cur = await getCurrentPrice(token, config.appKey, config.appSecret, pos.code, 'paper');
          } else { throw te; }
        }
        const sellPrice = cur.price || pos.buyPrice;
        const { pnl, pnlPct } = calcNetPnl(pos.buyPrice, sellPrice, pos.qty);
        log(`${modeTag} ✅ 매도: ${pos.name}(${pos.code}) ${pos.qty}주 — 매수 ${pos.buyPrice.toLocaleString()} → 매도 ${sellPrice.toLocaleString()} (${(pnlPct * 100).toFixed(2)}%, ${pnl > 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}원)`);
        appendTradeLog({ action: 'SELL', code: pos.code, name: pos.name, qty: pos.qty, buyPrice: pos.buyPrice, sellPrice, pnl, pnlPct: +(pnlPct * 100).toFixed(2), preset: config.preset }, mode);
        sellResults.push({ ...pos, sellPrice, pnl, pnlPct: +(pnlPct * 100).toFixed(2) });
        await sleep(250);
      } catch (e) {
        log(`${modeTag} ❌ 매도 현재가 조회 실패: ${pos.name}(${pos.code}) — ${e.message}`, 'error');
        sellResults.push({ ...pos, sellPrice: pos.buyPrice, pnl: 0, pnlPct: 0 });
      }
    }
    const dailyPnl = sellResults.reduce((s, r) => s + r.pnl, 0);
    const buyTotal = sellResults.reduce((s, r) => s + (r.buyPrice * r.qty), 0);
    st.dailyPnl.unshift({ date: kstNow().toISOString().slice(0, 10), pnl: dailyPnl, stocks: sellResults.length, buyTotal });
    if (st.dailyPnl.length > 365) st.dailyPnl = st.dailyPnl.slice(0, 365);
    st.totalPnl += dailyPnl;
    st.tradingDays++;
    st.positions = [];
    st.lastSell = new Date().toISOString();
    saveState(st, mode);
    setStateByMode(mode, st);
    log(`${modeTag} 📈 오늘 PnL: ${dailyPnl > 0 ? '+' : ''}${dailyPnl.toLocaleString()}원 | 누적: ${st.totalPnl > 0 ? '+' : ''}${st.totalPnl.toLocaleString()}원`);
    log(`${modeTag} === 매도 완료: ${sellResults.length}종목 ===`);
    emailService.sendSellReport(sellResults, dailyPnl, mode, config.presets[config.preset]?.label || '').catch(() => {});
    return;
  }

  // 실전투자: KIS API 실제 매도 (매도 직전 토큰 강제 재발급)
  let token = await ensureToken('real', true);
  const sellResults = [];
  const failedPositions = [];

  for (const pos of st.positions) {
    let sellSuccess = false;
    for (let tryIdx = 0; tryIdx < 2 && !sellSuccess; tryIdx++) {
      try {
        token = await ensureToken('real');
        const result = await orderSell(token, config.appKey, config.appSecret, config.cano, { code: pos.code, qty: pos.qty, orderType: 'market' }, 'real');
        log(`${modeTag} ✅ 매도: ${pos.name}(${pos.code}) ${pos.qty}주 시장가 (주문번호: ${result.ordNo})`);
        sellResults.push({ ...pos, ordNo: result.ordNo });
        appendTradeLog({ action: 'SELL', code: pos.code, name: pos.name, qty: pos.qty, buyPrice: pos.buyPrice, preset: config.preset }, 'real');
        sellSuccess = true;
        await sleep(250);
      } catch (e) {
        const errMsg = e.message || '';
        if (errMsg.includes('거래정지') || errMsg.includes('매매거래제한')) {
          log(`${modeTag} 🚫 매도불가(거래정지): ${pos.name}(${pos.code}) — 스킵`, 'error');
          failedPositions.push({ ...pos, _suspended: true });
          break;
        } else if (tryIdx === 0 && (errMsg.includes('토큰') || errMsg.includes('token') || errMsg.includes('접근토큰') || errMsg.includes('만료'))) {
          log(`${modeTag} 🔑 토큰 만료 감지 — 재발급 후 재시도: ${pos.name}(${pos.code})`, 'warn');
          kisTokenReal = null;
        } else {
          log(`${modeTag} ❌ 매도실패: ${pos.name}(${pos.code}) — ${errMsg}`, 'error');
          failedPositions.push(pos);
          break;
        }
      }
    }
  }

  const retryable = failedPositions.filter(p => !p._suspended);
  const suspended = failedPositions.filter(p => p._suspended);
  if (suspended.length > 0) log(`${modeTag} 🚫 거래정지 ${suspended.length}종목 — 수동 확인 필요: ${suspended.map(p => p.name).join(', ')}`, 'warn');

  if (retryable.length > 0) {
    st.positions = retryable.map(p => { const { _suspended, ...rest } = p; return rest; });
    log(`${modeTag} ⚠️ 매도 실패 ${retryable.length}종목 — 1분 간격 리트라이 예정`, 'warn');
  } else {
    st.positions = [];
  }
  st.lastSell = new Date().toISOString();
  saveState(st, 'real');
  setStateByMode('real', st);

  if (sellResults.length > 0) {
    log(`${modeTag} 30초 후 체결 확인 예정...`);
    setTimeout(async () => {
      try { await checkSellExecutions(sellResults, 'real'); }
      catch (e) {
        log(`${modeTag} 체결 확인 1차 실패: ${e.message} — 60초 후 재시도`, 'error');
        setTimeout(async () => {
          try { await checkSellExecutions(sellResults, 'real'); }
          catch (e2) { log(`${modeTag} 체결 확인 2차 실패: ${e2.message}`, 'error'); }
        }, 60000);
      }
    }, 30000);
  }
  log(`${modeTag} === 매도 완료: ${sellResults.length}종목 ===`);
}

// ── 매도 리트라이 (모드별 독립) ──────────────────────────────
function startSellRetry(mode = 'paper') {
  stopSellRetry(mode);
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';
  if (mode === 'real') sellRetryCountReal = 0; else sellRetryCountPaper = 0;

  const timer = setInterval(async () => {
    const count = mode === 'real' ? ++sellRetryCountReal : ++sellRetryCountPaper;
    const st = getState(mode);

    if (!st.positions || st.positions.length === 0) {
      log(`${modeTag} ✅ 매도 리트라이 종료 — 전량 청산 완료 (${count}회차)`);
      stopSellRetry(mode);
      return;
    }
    if (count > SELL_RETRY_MAX) {
      log(`${modeTag} 🚨 매도 리트라이 ${SELL_RETRY_MAX}회 초과 — 잔여 ${st.positions.length}종목 수동 확인 필요`, 'error');
      stopSellRetry(mode);
      return;
    }
    try {
      config = loadConfig();
      try { await ensureToken(mode); } catch (te) {
        log(`${modeTag} 리트라이 토큰 갱신 실패 — 강제 재발급`, 'warn');
        if (mode === 'real') kisTokenReal = null; else kisTokenPaper = null;
        await ensureToken(mode);
      }
      log(`${modeTag} 🔄 매도 리트라이 ${count}/${SELL_RETRY_MAX} — 잔여 ${st.positions.length}종목`, 'warn');
      await executeSellPipeline(mode);
      const stAfter = getState(mode);
      if (!stAfter.positions || stAfter.positions.length === 0) {
        log(`${modeTag} ✅ 매도 리트라이 ${count}회차 — 전량 청산 완료`);
        stopSellRetry(mode);
      }
    } catch (e) {
      log(`${modeTag} 매도 리트라이 ${count}회차 에러: ${e.message}`, 'error');
    }
  }, SELL_RETRY_INTERVAL);

  if (mode === 'real') sellRetryTimerReal = timer; else sellRetryTimerPaper = timer;
  log(`${modeTag} 📋 매도 리트라이 시작 — 1분 간격, 최대 ${SELL_RETRY_MAX}회`);
}

function stopSellRetry(mode = 'paper') {
  if (mode === 'real') {
    if (sellRetryTimerReal) { clearInterval(sellRetryTimerReal); sellRetryTimerReal = null; }
    sellRetryCountReal = 0;
  } else {
    if (sellRetryTimerPaper) { clearInterval(sellRetryTimerPaper); sellRetryTimerPaper = null; }
    sellRetryCountPaper = 0;
  }
}

// ── 체결 확인 & PnL 계산 ─────────────────────────────────────
async function checkSellExecutions(sellResults, mode = 'real') {
  const modeTag = mode === 'real' ? '[실전]' : '[모의]';
  const st = getState(mode);
  let token = await ensureToken(mode);
  const today = kstNow().toISOString().slice(0, 10).replace(/-/g, '');
  let orders;
  try {
    orders = await getOrders(token, config.appKey, config.appSecret, config.cano, { startDate: today }, mode);
  } catch (e) {
    const errMsg = e.message || '';
    if (errMsg.includes('토큰') || errMsg.includes('token') || errMsg.includes('접근토큰') || errMsg.includes('만료')) {
      log(`${modeTag} 체결 조회 토큰 만료 감지 — 재발급 후 재시도`, 'warn');
      if (mode === 'real') kisTokenReal = null; else kisTokenPaper = null;
      token = await ensureToken(mode);
      orders = await getOrders(token, config.appKey, config.appSecret, config.cano, { startDate: today }, mode);
    } else {
      throw e;
    }
  }

  let dailyPnl = 0;
  let filledCount = 0;
  let pendingCount = 0;
  const settleDetails = [];

  for (const pos of sellResults) {
    const filled = orders.find(o => o.code === pos.code && o.side === 'SELL' && o.filledQty > 0);
    if (filled) {
      filledCount++;
      const sellPrice = filled.avgPrice || filled.ordPrice;
      const net = calcNetPnl(pos.buyPrice, sellPrice, pos.qty);
      dailyPnl += net.pnl;
      log(`${modeTag} 📊 ${pos.name}: 매수 ${pos.buyPrice.toLocaleString()} → 매도 ${sellPrice.toLocaleString()} (${(net.pnlPct * 100).toFixed(2)}%, ${net.pnl > 0 ? '+' : ''}${Math.round(net.pnl).toLocaleString()}원)`);
      appendTradeLog({ action: 'SETTLE', code: pos.code, name: pos.name, buyPrice: pos.buyPrice, sellPrice, qty: pos.qty, pnl: net.pnl, pnlPct: +(net.pnlPct * 100).toFixed(2) }, mode);
      settleDetails.push({ ...pos, sellPrice, pnl: net.pnl, pnlPct: +(net.pnlPct * 100).toFixed(2) });
    } else {
      pendingCount++;
      log(`${modeTag} ⏳ ${pos.name}(${pos.code}): 아직 미체결`, 'warn');
    }
  }
  if (pendingCount > 0) log(`${modeTag} ⚠️ 체결확인: ${filledCount}건 완료, ${pendingCount}건 미체결`, 'warn');

  if (filledCount > 0) {
    const buyTotal = settleDetails.reduce((s, r) => s + (r.buyPrice * r.qty), 0);
    st.dailyPnl.unshift({ date: kstNow().toISOString().slice(0, 10), pnl: dailyPnl, stocks: filledCount, buyTotal });
    if (st.dailyPnl.length > 365) st.dailyPnl = st.dailyPnl.slice(0, 365);
    st.totalPnl += dailyPnl;
    st.tradingDays++;
    saveState(st, mode);
    setStateByMode(mode, st);
    log(`${modeTag} 📈 오늘 PnL: ${dailyPnl > 0 ? '+' : ''}${Math.round(dailyPnl).toLocaleString()}원 | 누적: ${st.totalPnl > 0 ? '+' : ''}${Math.round(st.totalPnl).toLocaleString()}원`);
  }
  if (settleDetails.length > 0) {
    const preset = config.presets[config.preset];
    emailService.sendSellReport(settleDetails, dailyPnl, mode, preset?.label || '').catch(() => {});
  }
}

// ── 유틸 ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isWeekday() {
  const dow = new Date().getDay();
  return dow >= 1 && dow <= 5;
}

// ── 크론 스케줄러 (듀얼모드: 모의 항상 + 실전 조건부) ────────
function setupCron() {
  const [buyH, buyM] = config.schedule.buyTime.split(':');
  const [sellH, sellM] = config.schedule.sellTime.split(':');

  // ─ 모의투자 매수 크론 (항상 동작) ─
  cron.schedule(`${buyM} ${buyH} * * 1-5`, async () => {
    log('[모의] 매수 크론 트리거됨');
    try {
      config = loadConfig();
      log('[모의] 매수 크론 시작');
      await executeBuyWithRetry('paper', 3);
    } catch (e) {
      log(`[모의] 매수 크론 에러: ${e.message}`, 'error');
    }
  }, { timezone: 'Asia/Seoul' });

  // ─ 실전투자 매수 크론 (realAutoTrading일 때만) ─
  // 모의와 시간을 1분 분리하여 동시 실행 충돌 방지
  const realBuyM = String(Number(buyM) + 1).padStart(2, '0');
  cron.schedule(`${realBuyM} ${buyH} * * 1-5`, async () => {
    log('[실전] 매수 크론 트리거됨');
    try {
      config = loadConfig();
      if (!config.realAutoTrading) {
        log('[실전] 자동매매 OFF — 매수 스킵');
        return;
      }
      log('[실전] 매수 크론 시작');
      await executeBuyWithRetry('real', 3);
    } catch (e) {
      log(`[실전] 매수 크론 에러: ${e.message}`, 'error');
      emailService.sendError('[실전] 매수 크론 실패', e.message).catch(() => {});
    }
  }, { timezone: 'Asia/Seoul' });

  // ─ 모의투자 매도 크론 (09:01 — 장 시작 후 시가 반영) ─
  cron.schedule('1 9 * * 1-5', async () => {
    log('[모의] 매도 크론 트리거됨');
    try {
      config = loadConfig();
      log('[모의] 매도 크론 시작');
      await executeSellWithRetry('paper', 3);
      const st = getState('paper');
      if (st.positions && st.positions.length > 0) {
        log(`[모의] ⚠️ 잔여 ${st.positions.length}종목 — 리트라이 시작`, 'warn');
        startSellRetry('paper');
      }
    } catch (e) {
      log(`[모의] 매도 크론 에러: ${e.message}`, 'error');
      const st = getState('paper');
      if (st.positions && st.positions.length > 0) startSellRetry('paper');
    }
  }, { timezone: 'Asia/Seoul' });

  // ─ 실전투자 매도 크론 (realAutoTrading일 때만) ─
  cron.schedule(`${sellM} ${sellH} * * 1-5`, async () => {
    log('[실전] 매도 크론 트리거됨');
    try {
      config = loadConfig();
      if (!config.realAutoTrading) {
        // 실전 OFF여도 보유종목 있으면 매도는 실행 (안전장치)
        const st = getState('real');
        if (st.positions && st.positions.length > 0) {
          log('[실전] 자동매매 OFF이지만 보유종목 존재 — 안전 매도 실행', 'warn');
          await executeSellWithRetry('real', 3);
        } else {
          log('[실전] 자동매매 OFF + 보유종목 없음 — 매도 스킵');
        }
        return;
      }
      log('[실전] 매도 크론 시작');
      await executeSellWithRetry('real', 3);
      const st = getState('real');
      if (st.positions && st.positions.length > 0) {
        log(`[실전] ⚠️ 잔여 ${st.positions.length}종목 — 리트라이 시작`, 'warn');
        startSellRetry('real');
      }
    } catch (e) {
      log(`[실전] 매도 크론 에러: ${e.message}`, 'error');
      emailService.sendError('[실전] 매도 크론 실패', e.message).catch(() => {});
      const st = getState('real');
      if (st.positions && st.positions.length > 0) startSellRetry('real');
    }
  }, { timezone: 'Asia/Seoul' });

  // ─ 토큰 갱신 + 블랙리스트: 매일 07:00 ─
  cron.schedule('0 7 * * 1-5', async () => {
    try {
      kisTokenPaper = null; kisTokenReal = null;
      await ensureToken('paper');
      log('[모의] KIS 토큰 갱신 완료');
      if (config.realAutoTrading) {
        await ensureToken('real');
        log('[실전] KIS 토큰 갱신 완료');
      }
    } catch (e) {
      log(`토큰 갱신 실패: ${e.message}`, 'error');
    }
    try {
      const bl = await updateBlacklist();
      log(`블랙리스트 갱신: 관리종목 ${bl.count}개`);
    } catch (e) {
      log(`블랙리스트 갱신 실패: ${e.message}`, 'error');
    }
  }, { timezone: 'Asia/Seoul' });

  log(`크론 등록: 모의매수 ${config.schedule.buyTime}, 실전매수 ${buyH}:${realBuyM}, 매도 모의=09:01/실전=${config.schedule.sellTime} (실전: ${config.realAutoTrading ? 'ON' : 'OFF'})`);
  log(`크론 등록: 네트워크 에러 시 최대 3회 재시도 (10초 간격 증가)`);
}

// ═══════════════════════════════════════════════════════════════
// Express 서버 + API
// ═══════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ── 대시보드 API ─────────────────────────────────────────────

// 상태 조회 (viewMode에 따라 해당 모드의 상태 반환)
app.get('/api/status', (req, res) => {
  const mode = config.viewMode || 'paper';
  const st = getState(mode);
  res.json({
    preset: config.preset,
    presetLabel: config.presets[config.preset]?.label || config.preset,
    presetDesc: config.presets[config.preset]?.description || '',
    positions: st.positions || [],
    lastScan: st.lastScan,
    lastBuy: st.lastBuy,
    lastSell: st.lastSell,
    totalPnl: st.totalPnl || 0,
    tradingDays: st.tradingDays || 0,
    dailyPnl: (st.dailyPnl || []).slice(0, 30),
    lastScanResult: lastScanResult ? {
      totalScanned: lastScanResult.totalScanned,
      selected: Array.isArray(lastScanResult.selected) ? lastScanResult.selected.length : (lastScanResult.selected || 0),
      timing: lastScanResult.timing,
      stocks: Array.isArray(lastScanResult.selected) ? lastScanResult.selected : (lastScanResult.stocks || []),
    } : null,
    schedule: config.schedule,
    viewMode: mode,
    realAutoTrading: config.realAutoTrading || false,
  });
});

// 엔진 로그
app.get('/api/logs', (req, res) => {
  res.json(engineLog);
});

// 거래 내역 (뷰모드별)
app.get('/api/trades', (req, res) => {
  const logs = loadTradeLog(config.viewMode || 'paper');
  const date = req.query.date;
  if (date) {
    const filtered = logs.filter(t => t.timestamp && t.timestamp.startsWith(date.replace(/-/g, '-')));
    // KST 기준으로 필터 (UTC+9)
    const byDate = logs.filter(t => {
      if (!t.timestamp) return false;
      const kst = new Date(new Date(t.timestamp).getTime() + 9 * 3600000);
      return kst.toISOString().slice(0, 10) === date;
    });
    return res.json(byDate);
  }
  const limit = parseInt(req.query.limit) || 50;
  res.json(logs.slice(0, limit));
});

// 주문 로그
app.get('/api/orders', (req, res) => {
  res.json(getOrderLog(config.viewMode || 'paper').slice(0, 50));
});

// 잔고 조회
app.get('/api/balance', async (req, res) => {
  try {
    const mode = config.viewMode || 'paper';
    const st = getState(mode);
    if (mode === 'paper') {
      const seedCapital = config.initialCapital;
      const holdingValue = (st.positions || []).reduce((s, p) => s + (p.buyPrice || 0) * (p.qty || 0), 0);
      const deposit = (seedCapital + (st.totalPnl || 0)) - holdingValue;
      res.json({ deposit, holdings: st.positions || [] });
    } else {
      let token = await ensureToken('real');
      try {
        const bal = await getBalance(token, config.appKey, config.appSecret, config.cano, 'real');
        res.json(bal);
      } catch (e) {
        const errMsg = e.message || '';
        if (errMsg.includes('토큰') || errMsg.includes('token') || errMsg.includes('접근토큰') || errMsg.includes('만료')) {
          kisTokenReal = null;
          token = await ensureToken('real');
          const bal = await getBalance(token, config.appKey, config.appSecret, config.cano, 'real');
          res.json(bal);
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 뷰 모드 전환 (보기 전환, 실행에 영향 없음)
app.post('/api/view-mode', (req, res) => {
  const { mode } = req.body;
  if (mode !== 'paper' && mode !== 'real') return res.status(400).json({ error: '잘못된 모드' });
  config.viewMode = mode;
  state = getState(mode);
  lastScanResult = state.lastScanResult || null;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  log(`뷰 모드 전환: ${mode === 'real' ? '실전' : '모의'} 대시보드`);
  res.json({ viewMode: mode });
});

// 실전 자동매매 ON/OFF
app.post('/api/toggle-real-trading', (req, res) => {
  const { enable } = req.body;
  config.realAutoTrading = !!enable;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  const label = config.realAutoTrading ? '🔴 실전 자동매매 ON' : '⬜ 실전 자동매매 OFF';
  log(label);
  res.json({ realAutoTrading: config.realAutoTrading });
});

// 하위 호환: 기존 /api/toggle → view-mode 전환으로 리다이렉트
app.post('/api/toggle', (req, res) => {
  const wasReal = config.viewMode === 'real';
  config.viewMode = wasReal ? 'paper' : 'real';
  state = getState(config.viewMode);
  lastScanResult = state.lastScanResult || null;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  log(`뷰 모드 전환: ${config.viewMode === 'real' ? '실전' : '모의'}`);
  res.json({ viewMode: config.viewMode });
});

// 프리셋 변경
app.post('/api/preset', (req, res) => {
  const { preset } = req.body;
  if (!config.presets[preset]) return res.status(400).json({ error: '잘못된 프리셋' });
  config.preset = preset;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  log(`프리셋 변경: ${config.presets[preset].label}`);
  res.json({ preset, label: config.presets[preset].label });
});

// 수동 스캔 (테스트용)
app.post('/api/scan', async (req, res) => {
  try {
    const mode = config.viewMode || 'paper';
    const st = getState(mode);
    const preset = config.presets[config.preset];
    const result = await runScanPipeline(preset);
    lastScanResult = result;
    st.lastScanResult = result;
    st.lastScan = new Date().toISOString();
    saveState(st, mode);
    log(`수동 스캔 완료: ${result.selected.length}종목 (${result.timing.total}ms)`);
    res.json(result);
  } catch (e) {
    log(`수동 스캔 실패: ${e.message}`, 'error');
    res.status(500).json({ error: e.message });
  }
});

// 수동 매수 (현재 viewMode 기준)
app.post('/api/buy', async (req, res) => {
  try {
    config = loadConfig();
    const mode = config.viewMode || 'paper';
    await executeBuyPipeline(mode);
    const st = getState(mode);
    res.json({ ok: true, positions: st.positions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 수동 매도 (현재 viewMode 기준)
app.post('/api/sell', async (req, res) => {
  try {
    const mode = config.viewMode || 'paper';
    await executeSellPipeline(mode);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 차트 데이터 (네이버 OHLCV)
const _chartCache = new Map();

function fetchNaverOhlcv(code) {
  return new Promise((resolve, reject) => {
    const url = `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=20240101&endTime=20301231&timeframe=day`;
    const req = https.get(url, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        try {
          let raw = Buffer.concat(ch).toString().trim();
          raw = raw.replace(/'/g, '"');
          const parsed = JSON.parse(raw);
          const rows = parsed
            .filter(r => Array.isArray(r) && r.length >= 6 && /^\d{8}$/.test(String(r[0]).replace(/"/g, '').trim()))
            .map(r => {
              const ds = String(r[0]).replace(/"/g, '').trim();
              return {
                date: `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`,
                open: parseInt(r[1]) || 0,
                high: parseInt(r[2]) || 0,
                low: parseInt(r[3]) || 0,
                close: parseInt(r[4]) || 0,
                volume: parseInt(r[5]) || 0,
              };
            })
            .filter(d => d.close > 0);
          rows.sort((a, b) => a.date.localeCompare(b.date));
          resolve(rows);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('OHLCV 타임아웃')); });
  });
}

app.get('/api/chart/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '잘못된 종목코드' });

    // 캐시 (1시간)
    const cached = _chartCache.get(code);
    if (cached && Date.now() - cached.ts < 3600000) {
      return res.json({ ok: true, data: cached.data });
    }

    const rows = await fetchNaverOhlcv(code);
    if (rows.length > 0) _chartCache.set(code, { data: rows, ts: Date.now() });
    res.json({ ok: true, data: rows });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 설정 조회/변경
app.get('/api/config', (req, res) => {
  // 민감정보 제외
  const safe = { ...config };
  delete safe.appKey;
  delete safe.appSecret;
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const updates = req.body;
  // 민감정보 덮어쓰기 방지
  delete updates.appKey;
  delete updates.appSecret;
  Object.assign(config, updates);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  log(`설정 업데이트: ${Object.keys(updates).join(', ')}`);
  res.json({ ok: true });
});

// 일별 PnL 통계 (viewMode별)
app.get('/api/stats', (req, res) => {
  const mode = config.viewMode || 'paper';
  const st = getState(mode);
  const seedCapital = mode === 'real' ? (config.realInitialCapital || 100000) : config.initialCapital;
  const pnls = st.dailyPnl || [];
  const wins = pnls.filter(p => p.pnl > 0).length;
  const losses = pnls.filter(p => p.pnl < 0).length;
  const totalDays = pnls.length;
  const avgPnl = totalDays > 0 ? pnls.reduce((s, p) => s + p.pnl, 0) / totalDays : 0;
  const maxPnl = totalDays > 0 ? Math.max(...pnls.map(p => p.pnl)) : 0;
  const minPnl = totalDays > 0 ? Math.min(...pnls.map(p => p.pnl)) : 0;

  let peak = seedCapital;
  let maxDD = 0;
  let cumPnl = 0;
  for (let i = pnls.length - 1; i >= 0; i--) {
    cumPnl += pnls[i].pnl;
    const equity = seedCapital + cumPnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  res.json({
    totalDays, wins, losses, draws: totalDays - wins - losses,
    winRate: totalDays > 0 ? +(wins / totalDays * 100).toFixed(1) : 0,
    totalPnl: st.totalPnl || 0,
    avgPnl: Math.round(avgPnl),
    maxPnl, minPnl,
    maxDD: +(maxDD * 100).toFixed(2),
    initialCapital: seedCapital,
    currentCapital: seedCapital + (st.totalPnl || 0),
  });
});

// ── 서버 시작 ────────────────────────────────────────────────
const PORT = config.port || 3100;
app.listen(PORT, () => {
  log(`════════════════════════════════════════`);
  log(`  번트(BUNT) 오버나잇 엔진 v2.0`);
  log(`  포트: ${PORT} | 듀얼모드`);
  log(`  모의투자: 항상 ON`);
  log(`  실전투자: ${config.realAutoTrading ? '🔴 ON' : '⬜ OFF'} (시드 ${(config.realInitialCapital || 100000).toLocaleString()}원)`);
  log(`  프리셋: ${config.presets[config.preset]?.label}`);
  log(`════════════════════════════════════════`);
  setupCron();

  // 시작 시 블랙리스트 갱신
  updateBlacklist().then(bl => {
    log(`블랙리스트 로드: 관리종목 ${bl.count}개`);
  }).catch(() => {});
});
