// ═══════════════════════════════════════════════════════════════
// 번트(BUNT) — 코스닥 오버나잇 자동매매 엔진
// 전략: 장마감 10분전 코스닥 스캔 → 필터 → 매수 → 익일 시가 매도
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');

const { runScanPipeline, scanAllKosdaq, fetchStockDetails, applyFilter } = require('./scanner');
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

// ── 글로벌 상태 ──────────────────────────────────────────────
let config = loadConfig();
emailService.init(config);
let state  = loadState(config.tradingMode);
let lastScanResult = state.lastScanResult || null;
let engineLog = [];     // 최근 100개 엔진 로그

function log(msg, level = 'info') {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  engineLog.unshift({ ts, level, msg });
  if (engineLog.length > 100) engineLog = engineLog.slice(0, 100);
}

// ── KIS 토큰 관리 ────────────────────────────────────────────
let kisToken = null;

async function ensureToken() {
  if (!kisToken) {
    kisToken = await getToken(config.appKey, config.appSecret, config.tradingMode);
    log('KIS 토큰 발급 완료');
  }
  return kisToken;
}

// ── 핵심 로직: 스캔 + 매수 ──────────────────────────────────
async function executeBuyPipeline() {
  const preset = config.presets[config.preset];
  if (!preset) { log(`프리셋 '${config.preset}' 없음`, 'error'); return; }

  log(`=== 매수 파이프라인 시작 (${preset.label}) ===`);

  // 1. 네이버 스캔
  let scanResult;
  try {
    scanResult = await runScanPipeline(preset);
    lastScanResult = scanResult;
    state.lastScanResult = scanResult;
    log(`스캔 완료: ${scanResult.totalScanned}종목 → ${scanResult.preFiltered}개 사전필터 → ${scanResult.selected.length}개 선정 (${scanResult.timing.total}ms)`);
  } catch (e) {
    log(`스캔 실패: ${e.message}`, 'error');
    return;
  }

  if (scanResult.selected.length === 0) {
    log('필터 통과 종목 없음 — 오늘 매수 스킵');
    state.lastScan = new Date().toISOString();
    saveState(state, config.tradingMode);
    return;
  }

  // 2. 잔고 확인
  const token = await ensureToken();
  let balance;
  try {
    balance = await getBalance(token, config.appKey, config.appSecret, config.cano, config.tradingMode);
    log(`예수금: ${balance.deposit.toLocaleString()}원`);
  } catch (e) {
    log(`잔고 조회 실패: ${e.message}`, 'error');
    return;
  }

  const availCash = balance.deposit;
  if (availCash < 10000) {
    log('예수금 부족 (1만원 미만) — 매수 스킵', 'warn');
    return;
  }

  // 3. 종목별 투자금 균등 배분 (원금 / 종목수)
  const selected = scanResult.selected;
  const perStock = Math.floor(availCash / selected.length);

  log(`${selected.length}종목 선정, 종목당 ${perStock.toLocaleString()}원 배분`);

  // 4. 매수 주문 실행 (순차 — KIS 모의투자 초당 5건 제한)
  const buyResults = [];
  for (const stock of selected) {
    const qty = Math.floor(perStock / stock.close);
    if (qty <= 0) {
      log(`${stock.name}(${stock.code}): 단가 ${stock.close}원 > 배분금 → 스킵`, 'warn');
      continue;
    }

    try {
      // 지정가 매수 (종가 기준)
      const result = await orderBuy(
        token, config.appKey, config.appSecret, config.cano,
        { code: stock.code, qty, price: stock.close, orderType: 'limit' },
        config.tradingMode
      );
      log(`✅ 매수: ${stock.name}(${stock.code}) ${qty}주 × ${stock.close.toLocaleString()}원 = ${(qty * stock.close).toLocaleString()}원`);
      buyResults.push({ ...stock, qty, ordNo: result.ordNo });

      appendTradeLog({
        action: 'BUY', code: stock.code, name: stock.name,
        qty, price: stock.close, changeRate: stock.changeRate,
        preset: config.preset,
      }, config.tradingMode);

      // API 호출 간격 (초당 5건 제한)
      await sleep(250);
    } catch (e) {
      log(`❌ 매수실패: ${stock.name}(${stock.code}) — ${e.message}`, 'error');
    }
  }

  // 5. 상태 업데이트
  state.positions = buyResults.map(s => ({
    code: s.code, name: s.name, qty: s.qty,
    buyPrice: s.close, buyDate: new Date().toISOString().slice(0, 10),
    changeRate: s.changeRate, ordNo: s.ordNo,
  }));
  state.lastBuy = new Date().toISOString();
  state.lastScan = new Date().toISOString();
  saveState(state, config.tradingMode);

  log(`=== 매수 완료: ${buyResults.length}종목 ===`);

  // 이메일 발송
  emailService.sendBuyReport(buyResults, config.tradingMode, preset.label).catch(() => {});
}

// ── 핵심 로직: 익일 시가 매도 ────────────────────────────────
async function executeSellPipeline() {
  if (!state.positions || state.positions.length === 0) {
    log('보유 종목 없음 — 매도 스킵');
    return;
  }

  log(`=== 매도 파이프라인 시작 (${state.positions.length}종목) ===`);

  const token = await ensureToken();
  const sellResults = [];

  for (const pos of state.positions) {
    try {
      // 시장가 매도 (장 시작 직후)
      const result = await orderSell(
        token, config.appKey, config.appSecret, config.cano,
        { code: pos.code, qty: pos.qty, orderType: 'market' },
        config.tradingMode
      );
      log(`✅ 매도: ${pos.name}(${pos.code}) ${pos.qty}주 시장가`);
      sellResults.push({ ...pos, ordNo: result.ordNo });

      appendTradeLog({
        action: 'SELL', code: pos.code, name: pos.name,
        qty: pos.qty, buyPrice: pos.buyPrice,
        preset: config.preset,
      }, config.tradingMode);

      await sleep(250);
    } catch (e) {
      log(`❌ 매도실패: ${pos.name}(${pos.code}) — ${e.message}`, 'error');
    }
  }

  // 체결 확인 (30초 후)
  if (sellResults.length > 0) {
    log('30초 후 체결 확인 예정...');
    setTimeout(async () => {
      try {
        await checkSellExecutions(sellResults);
      } catch (e) {
        log(`체결 확인 실패: ${e.message}`, 'error');
      }
    }, 30000);
  }

  state.positions = [];
  state.lastSell = new Date().toISOString();
  saveState(state, config.tradingMode);

  log(`=== 매도 완료: ${sellResults.length}종목 ===`);
}

// ── 체결 확인 & PnL 계산 ─────────────────────────────────────
async function checkSellExecutions(sellResults) {
  const token = await ensureToken();
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const orders = await getOrders(token, config.appKey, config.appSecret, config.cano, { startDate: today }, config.tradingMode);

  let dailyPnl = 0;
  for (const pos of sellResults) {
    const filled = orders.find(o => o.code === pos.code && o.side === 'SELL' && o.filledQty > 0);
    if (filled) {
      const sellPrice = filled.avgPrice || filled.ordPrice;
      const pnl = (sellPrice - pos.buyPrice) * pos.qty;
      const pnlPct = pos.buyPrice > 0 ? (sellPrice - pos.buyPrice) / pos.buyPrice : 0;
      dailyPnl += pnl;
      log(`📊 ${pos.name}: 매수 ${pos.buyPrice.toLocaleString()} → 매도 ${sellPrice.toLocaleString()} (${(pnlPct * 100).toFixed(2)}%, ${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}원)`);

      appendTradeLog({
        action: 'SETTLE', code: pos.code, name: pos.name,
        buyPrice: pos.buyPrice, sellPrice, qty: pos.qty,
        pnl, pnlPct: +(pnlPct * 100).toFixed(2),
      }, config.tradingMode);
    }
  }

  // 일별 PnL 기록
  state.dailyPnl.unshift({
    date: new Date().toISOString().slice(0, 10),
    pnl: dailyPnl,
    stocks: sellResults.length,
  });
  if (state.dailyPnl.length > 365) state.dailyPnl = state.dailyPnl.slice(0, 365);
  state.totalPnl += dailyPnl;
  state.tradingDays++;
  saveState(state, config.tradingMode);

  log(`📈 오늘 PnL: ${dailyPnl > 0 ? '+' : ''}${dailyPnl.toLocaleString()}원 | 누적: ${state.totalPnl > 0 ? '+' : ''}${state.totalPnl.toLocaleString()}원`);

  // 이메일 발송 — 정산 결과
  const settleResults = sellResults.map(s => {
    const pos = state.history?.find(h => h.code === s.code) || s;
    return { ...s, buyPrice: pos.buyPrice, sellPrice: pos.sellPrice, pnl: pos.pnl, pnlPct: pos.pnlPct };
  });
  const preset = config.presets[config.preset];
  emailService.sendSellReport(settleResults, dailyPnl, config.tradingMode, preset?.label || '').catch(() => {});
}

// ── 유틸 ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isWeekday() {
  const dow = new Date().getDay();
  return dow >= 1 && dow <= 5;
}

// ── 크론 스케줄러 ────────────────────────────────────────────
function setupCron() {
  // 매수: 평일 16:25 (장마감 5분 전)
  const [buyH, buyM] = config.schedule.buyTime.split(':');
  cron.schedule(`${buyM} ${buyH} * * 1-5`, async () => {
    try {
      config = loadConfig();  // 최신 설정 리로드
      log(`[${config.tradingMode === 'real' ? '실전' : '모의'}] 매수 크론 시작`);
      await executeBuyPipeline();
    } catch (e) {
      log(`매수 크론 에러: ${e.message}`, 'error');
    }
  }, { timezone: 'Asia/Seoul' });

  // 매도: 평일 08:50 (장 시작 10분 전 → 시장가 예약)
  const [sellH, sellM] = config.schedule.sellTime.split(':');
  cron.schedule(`${sellM} ${sellH} * * 1-5`, async () => {
    try {
      config = loadConfig();
      log(`[${config.tradingMode === 'real' ? '실전' : '모의'}] 매도 크론 시작`);
      await executeSellPipeline();
    } catch (e) {
      log(`매도 크론 에러: ${e.message}`, 'error');
    }
  }, { timezone: 'Asia/Seoul' });

  // 토큰 갱신: 매일 07:00
  cron.schedule('0 7 * * 1-5', async () => {
    try {
      kisToken = null;
      await ensureToken();
      log('KIS 토큰 갱신 완료');
    } catch (e) {
      log(`토큰 갱신 실패: ${e.message}`, 'error');
    }
  }, { timezone: 'Asia/Seoul' });

  log(`크론 등록: 매수 ${config.schedule.buyTime}, 매도 ${config.schedule.sellTime}`);
}

// ═══════════════════════════════════════════════════════════════
// Express 서버 + API
// ═══════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 대시보드 API ─────────────────────────────────────────────

// 상태 조회
app.get('/api/status', (req, res) => {
  res.json({
    preset: config.preset,
    presetLabel: config.presets[config.preset]?.label || config.preset,
    presetDesc: config.presets[config.preset]?.description || '',
    positions: state.positions || [],
    lastScan: state.lastScan,
    lastBuy: state.lastBuy,
    lastSell: state.lastSell,
    totalPnl: state.totalPnl || 0,
    tradingDays: state.tradingDays || 0,
    dailyPnl: (state.dailyPnl || []).slice(0, 30),
    lastScanResult: lastScanResult ? {
      totalScanned: lastScanResult.totalScanned,
      selected: Array.isArray(lastScanResult.selected) ? lastScanResult.selected.length : (lastScanResult.selected || 0),
      timing: lastScanResult.timing,
      stocks: Array.isArray(lastScanResult.selected) ? lastScanResult.selected : (lastScanResult.stocks || []),
    } : null,
    schedule: config.schedule,
    tradingMode: config.tradingMode,
  });
});

// 엔진 로그
app.get('/api/logs', (req, res) => {
  res.json(engineLog);
});

// 거래 내역 (모드별)
app.get('/api/trades', (req, res) => {
  const logs = loadTradeLog(config.tradingMode);
  const limit = parseInt(req.query.limit) || 50;
  res.json(logs.slice(0, limit));
});

// 주문 로그
app.get('/api/orders', (req, res) => {
  res.json(getOrderLog(config.tradingMode).slice(0, 50));
});

// 잔고 조회
app.get('/api/balance', async (req, res) => {
  try {
    const token = await ensureToken();
    const bal = await getBalance(token, config.appKey, config.appSecret, config.cano, config.tradingMode);
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 모드 전환: OFF(모의투자) ↔ ON(실전투자)
app.post('/api/toggle', (req, res) => {
  const wasReal = config.tradingMode === 'real';
  config.tradingMode = wasReal ? 'paper' : 'real';
  kisToken = null;  // 토큰 재발급 필요 (모의/실전 서버 다름)
  state = loadState(config.tradingMode);  // 해당 모드의 상태 로드
  lastScanResult = state.lastScanResult || null;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  const modeLabel = config.tradingMode === 'real' ? '🔴 실전투자 ON' : '🟢 모의투자 (OFF)';
  log(`모드 전환: ${modeLabel}`);
  res.json({ tradingMode: config.tradingMode });
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
    const preset = config.presets[config.preset];
    const result = await runScanPipeline(preset);
    lastScanResult = result;
    state.lastScanResult = result;
    state.lastScan = new Date().toISOString();
    saveState(state, config.tradingMode);
    log(`수동 스캔 완료: ${result.selected.length}종목 (${result.timing.total}ms)`);
    res.json(result);
  } catch (e) {
    log(`수동 스캔 실패: ${e.message}`, 'error');
    res.status(500).json({ error: e.message });
  }
});

// 수동 매수 (테스트용)
app.post('/api/buy', async (req, res) => {
  try {
    config = loadConfig();
    await executeBuyPipeline();
    res.json({ ok: true, positions: state.positions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 수동 매도 (테스트용)
app.post('/api/sell', async (req, res) => {
  try {
    await executeSellPipeline();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// 일별 PnL 통계
app.get('/api/stats', (req, res) => {
  const pnls = state.dailyPnl || [];
  const wins = pnls.filter(p => p.pnl > 0).length;
  const losses = pnls.filter(p => p.pnl < 0).length;
  const totalDays = pnls.length;
  const avgPnl = totalDays > 0 ? pnls.reduce((s, p) => s + p.pnl, 0) / totalDays : 0;
  const maxPnl = totalDays > 0 ? Math.max(...pnls.map(p => p.pnl)) : 0;
  const minPnl = totalDays > 0 ? Math.min(...pnls.map(p => p.pnl)) : 0;

  // MDD 계산
  let peak = config.initialCapital;
  let maxDD = 0;
  let cumPnl = 0;
  for (let i = pnls.length - 1; i >= 0; i--) {
    cumPnl += pnls[i].pnl;
    const equity = config.initialCapital + cumPnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  res.json({
    totalDays, wins, losses, draws: totalDays - wins - losses,
    winRate: totalDays > 0 ? +(wins / totalDays * 100).toFixed(1) : 0,
    totalPnl: state.totalPnl || 0,
    avgPnl: Math.round(avgPnl),
    maxPnl, minPnl,
    maxDD: +(maxDD * 100).toFixed(2),
    initialCapital: config.initialCapital,
    currentCapital: config.initialCapital + (state.totalPnl || 0),
  });
});

// ── 서버 시작 ────────────────────────────────────────────────
const PORT = config.port || 3100;
app.listen(PORT, () => {
  log(`════════════════════════════════════════`);
  log(`  번트(BUNT) 오버나잇 엔진 v1.0`);
  log(`  포트: ${PORT} | 모드: ${config.tradingMode}`);
  log(`  프리셋: ${config.presets[config.preset]?.label}`);
  log(`  자동매매: 항상 가동 (크론 스케줄)`);
  log(`════════════════════════════════════════`);
  setupCron();
});
