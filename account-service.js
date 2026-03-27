// ═══════════════════════════════════════════════════════════════
// 번트 KIS API 서비스 — 주문, 잔고, 토큰 관리
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR    = path.join(__dirname, 'data');
const TOKEN_FILE  = path.join(DATA_DIR, 'token.json');

function orderLogFile(mode) { return path.join(DATA_DIR, `order-log-${mode || 'paper'}.json`); }

// ── TR ID 매핑 (실전/모의투자) ────────────────────────────────
function getTrIds(tradingMode) {
  if (tradingMode === 'real') {
    return {
      balance:  'TTTC8434R',
      buy:      'TTTC0802U',
      sell:     'TTTC0801U',
      orders:   'TTTC8001R',
      hostname: 'openapi.koreainvestment.com',
      port:     9443,
    };
  }
  return {
    balance:  'VTTC8434R',
    buy:      'VTTC0802U',
    sell:     'VTTC0801U',
    orders:   'VTTC8001R',
    hostname: 'openapivts.koreainvestment.com',
    port:     29443,
  };
}

// ── KIS API 요청 헬퍼 ────────────────────────────────────────
function kisRequest(method, apiPath, params, { token, appKey, appSecret, trId, body: reqBody, tradingMode } = {}) {
  return new Promise((resolve, reject) => {
    const query = method === 'GET' && params ? '?' + new URLSearchParams(params).toString() : '';
    const bodyStr = method === 'POST' && reqBody ? JSON.stringify(reqBody) : null;
    const hdrs = {
      'content-type': 'application/json; charset=utf-8',
      'authorization': `Bearer ${token}`,
      'appkey': appKey,
      'appsecret': appSecret,
      'tr_id': trId,
    };
    if (bodyStr) hdrs['content-length'] = Buffer.byteLength(bodyStr);

    const trIds = getTrIds(tradingMode || 'paper');
    const req = https.request({
      hostname: trIds.hostname,
      port: trIds.port,
      path: apiPath + query,
      method,
      headers: hdrs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('KIS API 타임아웃')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── 토큰 발급/갱신 ──────────────────────────────────────────
async function getToken(appKey, appSecret, tradingMode = 'paper', { forceRefresh = false } = {}) {
  const tokenFilePath = path.join(DATA_DIR, `token-${tradingMode}.json`);
  // 기존 token.json 호환: 모드별 파일 없으면 공용 파일 사용
  const tPath = fs.existsSync(tokenFilePath) ? tokenFilePath : TOKEN_FILE;

  // 캐시된 토큰 확인 (강제 재발급이면 스킵)
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(tPath, 'utf8'));
      if (cached.token && cached.expires && new Date(cached.expires) > new Date()) {
        return cached.token;
      }
    } catch {}
  }

  // 새 토큰 발급
  const trIds = getTrIds(tradingMode);
  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret });
    const req = https.request({
      hostname: trIds.hostname,
      port: trIds.port,
      path: '/oauth2/tokenP',
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('토큰 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (!result.access_token) throw new Error(result.message || '토큰 발급 실패');

  // 캐시 저장 (만료 23시간 후, 모드별 분리)
  const expires = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(tokenFilePath, JSON.stringify({ token: result.access_token, expires }, null, 2), 'utf8');

  return result.access_token;
}

// ── 주문 로그 (모드별 분리) ──────────────────────────────────
function logOrder(entry, mode) {
  const file = orderLogFile(mode);
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  logs.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (logs.length > 500) logs = logs.slice(0, 500);
  fs.writeFileSync(file, JSON.stringify(logs, null, 2), 'utf8');
}

function getOrderLog(mode) {
  try { return JSON.parse(fs.readFileSync(orderLogFile(mode), 'utf8')); } catch { return []; }
}

// ── 잔고 조회 ────────────────────────────────────────────────
async function getBalance(token, appKey, appSecret, cano, tradingMode = 'paper') {
  const trIds = getTrIds(tradingMode);
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/trading/inquire-balance',
    {
      CANO: cano, ACNT_PRDT_CD: '01',
      AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02',
      UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '01',
      CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    },
    { token, appKey, appSecret, trId: trIds.balance, tradingMode }
  );
  if (result.rt_cd !== '0') throw new Error(result.msg1 || '잔고 조회 실패');

  const holdings = (result.output1 || [])
    .filter(h => parseInt(h.hldg_qty) > 0)
    .map(h => ({
      code:     h.pdno,
      name:     h.prdt_name,
      qty:      parseInt(h.hldg_qty) || 0,
      avgPrice: parseInt(h.pchs_avg_pric) || 0,
      curPrice: parseInt(h.prpr) || 0,
      evalAmt:  parseInt(h.evlu_amt) || 0,
      pnlAmt:   parseInt(h.evlu_pfls_amt) || 0,
      pnlPct:   parseFloat(h.evlu_pfls_rt) || 0,
    }));

  const summary = result.output2?.[0] || {};
  return {
    holdings,
    deposit:     parseInt(summary.dnca_tot_amt) || 0,
    evalTotal:   parseInt(summary.tot_evlu_amt) || 0,
    pnlTotal:    parseInt(summary.evlu_pfls_smtl_amt) || 0,
    purchaseAmt: parseInt(summary.pchs_amt_smtl_amt) || 0,
  };
}

// ── 매수 주문 ────────────────────────────────────────────────
async function orderBuy(token, appKey, appSecret, cano, { code, qty, price, orderType }, tradingMode = 'paper') {
  const trIds = getTrIds(tradingMode);
  const ordDvsn = orderType === 'market' ? '01' : '00';
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-cash',
    null,
    {
      token, appKey, appSecret, trId: trIds.buy, tradingMode,
      body: {
        CANO: cano, ACNT_PRDT_CD: '01',
        PDNO: code, ORD_DVSN: ordDvsn,
        ORD_QTY: String(qty),
        ORD_UNPR: orderType === 'market' ? '0' : String(price),
      }
    }
  );
  const success = result.rt_cd === '0';
  logOrder({ type: 'BUY', code, qty, price, orderType, success, msg: result.msg1, ordNo: result.output?.ODNO }, tradingMode);
  if (!success) throw new Error(result.msg1 || '매수 주문 실패');
  return { ok: true, ordNo: result.output?.ODNO, msg: result.msg1 };
}

// ── 매도 주문 ────────────────────────────────────────────────
async function orderSell(token, appKey, appSecret, cano, { code, qty, price, orderType }, tradingMode = 'paper') {
  const trIds = getTrIds(tradingMode);
  const ordDvsn = orderType === 'market' ? '01' : '00';
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-cash',
    null,
    {
      token, appKey, appSecret, trId: trIds.sell, tradingMode,
      body: {
        CANO: cano, ACNT_PRDT_CD: '01',
        PDNO: code, ORD_DVSN: ordDvsn,
        ORD_QTY: String(qty),
        ORD_UNPR: orderType === 'market' ? '0' : String(price),
      }
    }
  );
  const success = result.rt_cd === '0';
  logOrder({ type: 'SELL', code, qty, price, orderType, success, msg: result.msg1, ordNo: result.output?.ODNO }, tradingMode);
  if (!success) throw new Error(result.msg1 || '매도 주문 실패');
  return { ok: true, ordNo: result.output?.ODNO, msg: result.msg1 };
}

// ── 체결 내역 조회 ───────────────────────────────────────────
async function getOrders(token, appKey, appSecret, cano, { startDate, endDate } = {}, tradingMode = 'paper') {
  const trIds = getTrIds(tradingMode);
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
    {
      CANO: cano, ACNT_PRDT_CD: '01',
      INQR_STRT_DT: startDate || today, INQR_END_DT: endDate || today,
      SLL_BUY_DVSN_CD: '00', INQR_DVSN: '00',
      PDNO: '', CCLD_DVSN: '00',
      ORD_GNO_BRNO: '', ODNO: '',
      INQR_DVSN_3: '00', INQR_DVSN_1: '',
      CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    },
    { token, appKey, appSecret, trId: trIds.orders, tradingMode }
  );
  if (result.rt_cd !== '0') throw new Error(result.msg1 || '체결 내역 조회 실패');

  const orders = (result.output1 || []).map(o => ({
    ordNo:     o.odno,
    code:      o.pdno,
    name:      o.prdt_name,
    side:      o.sll_buy_dvsn_cd === '02' ? 'BUY' : 'SELL',
    ordQty:    parseInt(o.ord_qty) || 0,
    filledQty: parseInt(o.tot_ccld_qty) || 0,
    ordPrice:  parseInt(o.ord_unpr) || 0,
    avgPrice:  parseInt(o.avg_prvs) || 0,
    filledAmt: parseInt(o.tot_ccld_amt) || 0,   // 총체결금액
    ordTime:   o.ord_tmd,
    status:    parseInt(o.tot_ccld_qty) > 0 ? 'FILLED' : 'PENDING',
  }));

  // output2: 매도/매수 합산 수수료·세금·정산 (일별 합계)
  const s = result.output2 || {};
  const summary = {
    sellAmt:        parseInt(s.tot_sll_amt) || 0,       // 매도금액합계
    sellFee:        parseInt(s.sll_fee_smtl) || 0,      // 매도수수료합계
    sellTax:        parseInt(s.sll_tax_smtl) || 0,      // 매도제세금합계
    sellSettleAmt:  parseInt(s.sll_stlm_amt) || 0,      // 매도정산금액합계
    buyAmt:         parseInt(s.tot_buy_amt) || 0,       // 매수금액합계
    buyFee:         parseInt(s.buy_fee_smtl) || 0,      // 매수수수료합계
    _raw: s,  // 디버깅용 원본 (필드명 확인)
  };

  orders._summary = summary;
  return orders;
}

// ── 현재가 조회 (주문 전 실시간 가격 확인용) ─────────────────
async function getCurrentPrice(token, appKey, appSecret, code, tradingMode = 'paper') {
  const trIds = getTrIds(tradingMode);
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
    { token, appKey, appSecret, trId: 'FHKST01010100', tradingMode }
  );
  if (result.rt_cd !== '0') throw new Error(result.msg1 || '현재가 조회 실패');
  const o = result.output;
  return {
    code,
    price:      parseInt(o.stck_prpr) || 0,
    open:       parseInt(o.stck_oprc) || 0,
    prevClose:  parseInt(o.stck_sdpr) || 0,
    changeRate: parseFloat(o.prdy_ctrt) / 100 || 0,
    volume:     parseInt(o.acml_vol) || 0,
    high:       parseInt(o.stck_hgpr) || 0,
    low:        parseInt(o.stck_lwpr) || 0,
  };
}

module.exports = {
  getToken,
  getBalance,
  orderBuy,
  orderSell,
  getOrders,
  getOrderLog,
  getCurrentPrice,
  getTrIds,
};
