// ═══════════════════════════════════════════════════════════════
// 번트(BUNT) 대시보드 프론트엔드
// ═══════════════════════════════════════════════════════════════

const API = '';
let refreshInterval = null;
let countdown = 30;
let currentMode = 'paper';       // 현재 뷰 모드
let realAutoTrading = false;     // 실전 자동매매 상태

// ── API 호출 ─────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return await res.json();
  } catch (e) {
    console.error(`API 에러 [${path}]:`, e);
    return null;
  }
}

// ── 토스트 알림 ──────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── 버튼 로딩 상태 ──────────────────────────────────────────
function setLoading(btn, loading) {
  if (loading) {
    btn._origText = btn.textContent;
    btn.classList.add('loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('loading');
    btn.textContent = btn._origText || btn.textContent;
    btn.disabled = false;
  }
}

// ── 상태 업데이트 ────────────────────────────────────────────
async function refreshStatus() {
  const data = await api('/api/status');
  if (!data) return;

  window._lastStatusData = data;  // 수익 곡선용
  // 뷰 모드 반영
  const isReal = data.viewMode === 'real';
  currentMode = data.viewMode || 'paper';
  realAutoTrading = data.realAutoTrading || false;
  document.body.className = isReal ? 'mode-real' : '';
  document.title = isReal
    ? (realAutoTrading ? '🔴 [실전 ON] 번트' : '⬜ [실전 OFF] 번트')
    : '번트(BUNT) - 오버나잇 자동매매';

  // 탭 활성화
  const tabPaper = document.getElementById('tabPaper');
  const tabReal = document.getElementById('tabReal');
  tabPaper.className = `view-tab ${isReal ? '' : 'active'}`;
  tabReal.className = `view-tab ${isReal ? 'active-real' : ''}`;

  // 실전 자동매매 버튼 (실전 탭에서만 표시)
  const realBtn = document.getElementById('realTradingBtn');
  if (isReal) {
    realBtn.style.display = 'inline-block';
    realBtn.textContent = realAutoTrading ? '🔴 실전 ON' : '⬜ 실전 OFF';
    realBtn.className = `toggle-btn ${realAutoTrading ? 'on' : 'off'}`;
  } else {
    realBtn.style.display = 'none';
  }

  // 프리셋
  document.getElementById('presetSelect').value = data.preset;

  // 프리셋 설명
  document.getElementById('presetDesc').textContent = data.presetDesc || '';

  // 스케줄 시간
  if (data.schedule) {
    document.getElementById('nextBuy').textContent = data.schedule.buyTime;
    document.getElementById('nextSell').textContent = data.schedule.sellTime;
  }

  // 보유 종목
  const positions = data.positions || [];
  document.getElementById('positionCount').textContent = `${positions.length}종목`;
  const posBody = document.getElementById('positionsTable');
  if (positions.length > 0) {
    let totalBuyAmt = 0;
    const rows = positions.map(p => {
      const amt = (p.buyPrice || 0) * (p.qty || 0);
      totalBuyAmt += amt;
      return `
      <tr>
        <td><span class="stock-link" data-code="${p.code}" data-name="${p.name}">${p.name}</span><br><span style="color:var(--dim)">${p.code}</span></td>
        <td>${p.qty}</td>
        <td>${(p.buyPrice || 0).toLocaleString()}</td>
        <td>${amt.toLocaleString()}원</td>
        <td class="${p.changeRate >= 0 ? 'pnl-pos' : 'pnl-neg'}">${(p.changeRate * 100).toFixed(1)}%</td>
      </tr>`;
    }).join('');
    posBody.innerHTML = rows + `
      <tr style="border-top:2px solid var(--border);font-weight:700;">
        <td colspan="3" style="text-align:right;color:var(--dim);">합계</td>
        <td>${totalBuyAmt.toLocaleString()}원</td>
        <td></td>
      </tr>`;
  } else {
    posBody.innerHTML = '<tr><td colspan="5" class="empty-msg">보유 종목 없음</td></tr>';
  }

  // 스캔 결과
  const scanBody = document.getElementById('scanTable');
  if (data.lastScanResult) {
    const sr = data.lastScanResult;
    document.getElementById('scanTiming').textContent =
      `${sr.totalScanned}종목 → ${sr.selected}개 (${sr.timing.total}ms)`;
    if (sr.stocks && sr.stocks.length > 0) {
      scanBody.innerHTML = sr.stocks.map(s => `
        <tr>
          <td><span class="stock-link" data-code="${s.code}" data-name="${s.name}">${s.name}</span><br><span style="color:var(--dim)">${s.code}</span></td>
          <td>${(s.close || 0).toLocaleString()}</td>
          <td class="pnl-pos">${(s.changeRate * 100).toFixed(1)}%</td>
          <td>${s.closeIsHighPct ? (s.closeIsHighPct * 100).toFixed(1) + '%' : '-'}</td>
        </tr>
      `).join('');
    } else {
      scanBody.innerHTML = '<tr><td colspan="4" class="empty-msg">필터 통과 종목 없음</td></tr>';
    }
  } else {
    scanBody.innerHTML = '<tr><td colspan="4" class="empty-msg">스캔 버튼을 눌러 종목을 검색하세요</td></tr>';
  }

  // 일별 PnL (수익률 + 누적 추가)
  const pnlBody = document.getElementById('pnlTable');
  const dailyPnl = data.dailyPnl || [];
  if (dailyPnl.length > 0) {
    // 누적손익 계산 (최신순이므로 역순 누적)
    let cumPnl = data.totalPnl || 0;
    const cumPnls = [];
    for (let i = 0; i < dailyPnl.length; i++) {
      cumPnls.push(cumPnl);
      cumPnl -= dailyPnl[i].pnl;
    }
    pnlBody.innerHTML = dailyPnl.map((p, i) => {
      const cum = cumPnls[i];
      return `
      <tr>
        <td>${p.date}</td>
        <td>${p.stocks}</td>
        <td class="${p.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${p.pnl > 0 ? '+' : ''}${p.pnl.toLocaleString()}원</td>
        <td class="${cum >= 0 ? 'pnl-pos' : 'pnl-neg'}" style="font-size:11px;">${cum > 0 ? '+' : ''}${cum.toLocaleString()}원</td>
      </tr>`;
    }).join('');
  } else {
    pnlBody.innerHTML = '<tr><td colspan="4" class="empty-msg">아직 거래 내역 없음</td></tr>';
  }

  // 누적 PnL + 수익률
  const totalPnl = data.totalPnl || 0;
  const pnlEl = document.getElementById('totalPnl');
  pnlEl.className = `stat-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : ''}`;
  const pnlPctEl = document.getElementById('totalPnlPct');
  // refreshStats에서 initialCapital 가져온 후 계산
  if (pnlPctEl && pnlPctEl._initialCapital) {
    const pct = (totalPnl / pnlPctEl._initialCapital * 100).toFixed(2);
    pnlEl.innerHTML = `${totalPnl > 0 ? '+' : ''}${totalPnl.toLocaleString()}원<br><span style="font-size:11px;color:var(--dim);">(${pct > 0 ? '+' : ''}${pct}%)</span>`;
  } else {
    pnlEl.textContent = `${totalPnl > 0 ? '+' : ''}${totalPnl.toLocaleString()}원`;
  }
}

async function refreshStats() {
  const data = await api('/api/stats');
  if (!data) return;

  document.getElementById('winRate').textContent = `${data.winRate}%`;
  document.getElementById('tradingDays').textContent = `${data.totalDays}일`;
  document.getElementById('maxDD').textContent = `${data.maxDD}%`;

  // initialCapital 저장 (누적 손익 수익률 계산용)
  const pnlPctEl = document.getElementById('totalPnlPct');
  if (pnlPctEl) pnlPctEl._initialCapital = data.initialCapital;

  // 평균 건당 수익
  const avgEl = document.getElementById('avgPnl');
  if (avgEl) {
    avgEl.textContent = data.totalDays > 0 ? `${data.avgPnl > 0 ? '+' : ''}${data.avgPnl.toLocaleString()}원` : '--';
    avgEl.className = `stat-value ${data.avgPnl > 0 ? 'positive' : data.avgPnl < 0 ? 'negative' : ''}`;
  }

  // 수익 곡선 차트 렌더링
  renderEquityCurve(data);
}

async function refreshBalance() {
  const data = await api('/api/balance');
  if (data && !data.error) {
    document.getElementById('deposit').textContent = `${data.deposit.toLocaleString()}원`;
  } else {
    document.getElementById('deposit').textContent = '--';
  }

  // 실전 모드: 실제 증권 잔고 표시
  const realSection = document.getElementById('realHoldingsSection');
  if (!realSection) return;

  if (currentMode === 'real' && data && data.holdings && data.holdings.length > 0) {
    realSection.style.display = 'block';
    const h = data.holdings;
    let totalEval = 0;
    let totalPnl = 0;
    const rows = h.map(s => {
      totalEval += s.evalAmt || 0;
      totalPnl += s.pnlAmt || 0;
      const pnlClass = s.pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg';
      return `
        <tr>
          <td><span class="stock-link" data-code="${s.code}" data-name="${s.name}">${s.name}</span><br><span style="color:var(--dim)">${s.code}</span></td>
          <td>${s.qty}</td>
          <td>${(s.avgPrice || 0).toLocaleString()}</td>
          <td>${(s.curPrice || 0).toLocaleString()}</td>
          <td>${(s.evalAmt || 0).toLocaleString()}원</td>
          <td class="${pnlClass}">${s.pnlPct >= 0 ? '+' : ''}${(s.pnlPct || 0).toFixed(2)}%<br><span style="font-size:11px">${s.pnlAmt >= 0 ? '+' : ''}${(s.pnlAmt || 0).toLocaleString()}원</span></td>
        </tr>`;
    }).join('');
    const totalPnlPct = totalEval > 0 ? ((totalPnl / (totalEval - totalPnl)) * 100) : 0;
    const totalClass = totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    document.getElementById('realHoldingsTable').innerHTML = rows + `
      <tr style="border-top:2px solid var(--border);font-weight:700;">
        <td colspan="4" style="text-align:right;color:var(--dim);">합계</td>
        <td>${totalEval.toLocaleString()}원</td>
        <td class="${totalClass}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}원</td>
      </tr>`;
    document.getElementById('realHoldingsCount').textContent = `${h.length}종목`;

    // 총 평가금액 + 예수금
    if (data.evalTotal != null) {
      document.getElementById('realTotalEval').textContent = `평가: ${data.evalTotal.toLocaleString()}원`;
    }
  } else {
    realSection.style.display = 'none';
  }
}

async function refreshLogs() {
  const logs = await api('/api/logs');
  if (!logs) return;

  const box = document.getElementById('logBox');
  box.innerHTML = logs.map(l =>
    `<div class="log-${l.level}">[${l.ts}] ${l.msg}</div>`
  ).join('');
}

async function refreshAll() {
  countdown = 30;  // 수동 새로고침 시 카운트다운 리셋
  await Promise.all([refreshStatus(), refreshStats(), refreshLogs()]);
  refreshBalance();  // 별도 (KIS API 호출이라 느릴 수 있음)
}

function toggleInfo() {
  const panel = document.getElementById('infoPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// ── 뷰 전환 (탭 클릭) ────────────────────────────────────────
async function switchView(mode) {
  await api('/api/view-mode', { method: 'POST', body: { mode } });
  showToast(mode === 'real' ? '실전투자 대시보드' : '모의투자 대시보드');
  refreshAll();
}

// ── 실전 자동매매 ON/OFF ──────────────────────────────────────
async function toggleRealTrading() {
  if (!realAutoTrading) {
    // OFF → ON
    if (!confirm('⚠️ 실전 자동매매를 시작합니다.\n실제 자금으로 매매가 실행됩니다.\n\n정말 시작하시겠습니까?')) return;
    if (!confirm('🔴 최종 확인: 실전 자동매매 ON?')) return;
    await api('/api/toggle-real-trading', { method: 'POST', body: { enable: true } });
    showToast('🔴 실전 자동매매 ON');
  } else {
    // ON → OFF (즉시, 확인 없이)
    await api('/api/toggle-real-trading', { method: 'POST', body: { enable: false } });
    showToast('⬜ 실전 자동매매 OFF');
  }
  refreshAll();
}

document.getElementById('presetSelect').addEventListener('change', async (e) => {
  await api('/api/preset', { method: 'POST', body: { preset: e.target.value } });
  showToast(`프리셋 변경: ${e.target.options[e.target.selectedIndex].text}`);
  refreshAll();
});

async function manualScan(btn) {
  setLoading(btn, true);
  const result = await api('/api/scan', { method: 'POST' });
  setLoading(btn, false);
  if (result) {
    showToast(`스캔 완료: ${result.selected.length}종목 (${result.timing.total}ms)`);
  } else {
    showToast('스캔 실패');
  }
  refreshAll();
}

async function manualBuy(btn) {
  if (!confirm('수동 매수를 실행하시겠습니까?\n(스캔 → 필터 → 매수 전체 파이프라인 실행)')) return;
  setLoading(btn, true);
  const result = await api('/api/buy', { method: 'POST' });
  setLoading(btn, false);
  if (result && result.ok) {
    showToast(`매수 완료: ${(result.positions || []).length}종목`);
  } else {
    showToast('매수 실패: ' + (result?.error || '알 수 없는 오류'));
  }
  refreshAll();
}

async function manualSell(btn) {
  if (!confirm('보유 종목을 전량 시장가 매도합니까?')) return;
  setLoading(btn, true);
  const result = await api('/api/sell', { method: 'POST' });
  setLoading(btn, false);
  if (result && result.ok) {
    showToast('매도 완료');
  } else {
    showToast('매도 실패: ' + (result?.error || '알 수 없는 오류'));
  }
  refreshAll();
}

// ── 수익 곡선 차트 ──────────────────────────────────────────
let _equityChart = null;
let _equityResizeObs = null;

function renderEquityCurve(statsData) {
  const container = document.getElementById('equityChartWrap');
  if (!container || typeof LightweightCharts === 'undefined') return;
  if (!statsData || statsData.totalDays === 0) {
    container.innerHTML = '<div style="color:var(--dim);text-align:center;padding:30px;font-size:12px;">매매 기록이 쌓이면 수익 곡선이 표시됩니다</div>';
    return;
  }

  // 기존 차트 정리
  if (_equityResizeObs) { _equityResizeObs.disconnect(); _equityResizeObs = null; }
  if (_equityChart) { try { _equityChart.remove(); } catch(e){} _equityChart = null; }
  container.innerHTML = '';

  // dailyPnl에서 자산 추이 데이터 구성 (역순 → 시간순)
  const status = window._lastStatusData;
  const dailyPnl = (status && status.dailyPnl) ? [...status.dailyPnl].reverse() : [];
  if (dailyPnl.length === 0) return;

  const seed = statsData.initialCapital;
  let cumPnl = 0;
  const equityData = [];
  const pnlBarData = [];

  for (const p of dailyPnl) {
    cumPnl += p.pnl;
    equityData.push({ time: p.date, value: seed + cumPnl });
    pnlBarData.push({
      time: p.date, value: p.pnl,
      color: p.pnl >= 0 ? 'rgba(76,175,80,0.7)' : 'rgba(239,83,80,0.7)',
    });
  }

  _equityChart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: 200,
    layout: { background: { color: '#141413' }, textColor: '#7A7470', fontSize: 11 },
    grid: { vertLines: { color: '#1E1D1B' }, horzLines: { color: '#1E1D1B' } },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#252320' },
    leftPriceScale: { visible: true, borderColor: '#252320' },
    timeScale: { borderColor: '#252320', timeVisible: false },
  });

  // 자산 추이 라인
  const equitySeries = _equityChart.addLineSeries({
    color: '#4fc3f7', lineWidth: 2,
    priceLineVisible: false, lastValueVisible: true,
  });
  equitySeries.setData(equityData);

  // 시드 기준선
  equitySeries.createPriceLine({
    price: seed, color: '#555', lineWidth: 1, lineStyle: 2,
    axisLabelVisible: true, title: '시드',
  });

  // 일별 PnL 막대 (좌측 축)
  const barSeries = _equityChart.addHistogramSeries({
    priceScaleId: 'left',
    priceLineVisible: false, lastValueVisible: false,
  });
  barSeries.setData(pnlBarData);

  _equityChart.timeScale().fitContent();

  // 반응형
  _equityResizeObs = new ResizeObserver(() => {
    if (_equityChart && container.clientWidth > 0) _equityChart.applyOptions({ width: container.clientWidth });
  });
  _equityResizeObs.observe(container);
}

// ── 차트 모달 (lightweight-charts 캔들차트) ──────────────────
let _modalChart = null;
let _modalVolChart = null;
let _modalResizeObs = null;

async function openChart(code, name) {
  document.getElementById('chartTitle').innerHTML = `${name} <span style="color:var(--dim);font-size:12px;font-weight:400;margin-left:8px;">${code}</span>`;
  document.getElementById('chartLinkNaver').href = `https://finance.naver.com/item/main.naver?code=${code}`;
  document.getElementById('chartLinkMobile').href = `https://m.stock.naver.com/domestic/stock/${code}/total`;

  // 모달 열기
  document.getElementById('chartOverlay').classList.add('active');
  document.getElementById('chartLoading').style.display = 'block';

  // 기존 차트 정리
  destroyModalChart();

  // OHLCV 데이터 fetch
  const result = await api(`/api/chart/${code}`);
  document.getElementById('chartLoading').style.display = 'none';

  if (!result || !result.ok || !result.data || result.data.length === 0) {
    document.getElementById('chartCandleWrap').innerHTML = '<div style="color:var(--dim);text-align:center;padding:40px;">차트 데이터 없음</div>';
    return;
  }

  const data = result.data;
  const candleContainer = document.getElementById('chartCandleWrap');
  const volContainer = document.getElementById('chartVolumeWrap');

  // MA 계산
  function calcMA(arr, period) {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      if (i < period - 1) { out.push(null); continue; }
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += arr[j].close;
      out.push(+(sum / period).toFixed(0));
    }
    return out;
  }
  const ma20 = calcMA(data, 20);
  const ma60 = calcMA(data, 60);

  // ── 메인 캔들 차트 ──
  const candleHeight = candleContainer.clientHeight || (candleContainer.parentElement.clientHeight - 120);
  _modalChart = LightweightCharts.createChart(candleContainer, {
    width: candleContainer.clientWidth,
    height: candleHeight,
    layout: { background: { color: '#141413' }, textColor: '#7A7470', fontSize: 11 },
    grid: { vertLines: { color: '#1E1D1B' }, horzLines: { color: '#1E1D1B' } },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#252320' },
    timeScale: { borderColor: '#252320', timeVisible: false },
  });

  const candles = data.map(d => ({ time: d.date, open: d.open, high: d.high, low: d.low, close: d.close }));
  const candleSeries = _modalChart.addCandlestickSeries({
    upColor: '#ef5350', downColor: '#2962FF',
    borderUpColor: '#ef5350', borderDownColor: '#2962FF',
    wickUpColor: '#ef5350', wickDownColor: '#2962FF',
  });
  candleSeries.setData(candles);

  // MA20 라인
  const ma20Data = ma20.map((v, i) => v !== null ? { time: data[i].date, value: v } : null).filter(Boolean);
  if (ma20Data.length) {
    const ma20Series = _modalChart.addLineSeries({ color: '#4a9eff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ma20Series.setData(ma20Data);
  }

  // MA60 라인
  const ma60Data = ma60.map((v, i) => v !== null ? { time: data[i].date, value: v } : null).filter(Boolean);
  if (ma60Data.length) {
    const ma60Series = _modalChart.addLineSeries({ color: '#e040fb', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ma60Series.setData(ma60Data);
  }

  // 초기 범위: 최근 120일
  if (candles.length > 120) {
    _modalChart.timeScale().setVisibleLogicalRange({ from: candles.length - 120, to: candles.length });
  } else {
    _modalChart.timeScale().fitContent();
  }

  // ── 거래량 차트 (80px) ──
  _modalVolChart = LightweightCharts.createChart(volContainer, {
    width: volContainer.clientWidth, height: 80,
    layout: { background: { color: '#141413' }, textColor: '#7A7470', fontSize: 10 },
    grid: { vertLines: { color: '#1A1918' }, horzLines: { color: '#1A1918' } },
    timeScale: { borderColor: '#252320', timeVisible: false, visible: false },
    rightPriceScale: { borderColor: '#252320' },
  });

  const volSeries = _modalVolChart.addHistogramSeries({ priceFormat: { type: 'volume' } });
  volSeries.setData(data.map(d => ({
    time: d.date, value: d.volume,
    color: d.close >= d.open ? 'rgba(239,83,80,0.4)' : 'rgba(41,98,255,0.4)',
  })));

  // 시간축 동기화
  _modalChart.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (r && _modalVolChart) _modalVolChart.timeScale().setVisibleLogicalRange(r);
  });
  _modalVolChart.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (r && _modalChart) _modalChart.timeScale().setVisibleLogicalRange(r);
  });

  // 반응형
  _modalResizeObs = new ResizeObserver(() => {
    if (_modalChart && candleContainer.clientWidth > 0) _modalChart.applyOptions({ width: candleContainer.clientWidth });
    if (_modalVolChart && volContainer.clientWidth > 0) _modalVolChart.applyOptions({ width: volContainer.clientWidth });
  });
  _modalResizeObs.observe(candleContainer);
}

function destroyModalChart() {
  if (_modalResizeObs) { _modalResizeObs.disconnect(); _modalResizeObs = null; }
  if (_modalChart) { try { _modalChart.remove(); } catch(e){} _modalChart = null; }
  if (_modalVolChart) { try { _modalVolChart.remove(); } catch(e){} _modalVolChart = null; }
}

function closeChart(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('chartOverlay').classList.remove('active');
  destroyModalChart();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChart();
});

// ── 자동 새로고침 (30초) ─────────────────────────────────────
function startAutoRefresh() {
  countdown = 30;
  refreshInterval = setInterval(() => {
    countdown--;
    document.getElementById('refreshTimer').textContent = `${countdown}s`;
    if (countdown <= 0) {
      countdown = 30;
      refreshAll();
    }
  }, 1000);
}

// ── 이벤트 위임: stock-link 클릭 → 차트 모달 ────────────────
document.addEventListener('click', (e) => {
  const link = e.target.closest('.stock-link');
  if (link) {
    const code = link.dataset.code;
    const name = link.dataset.name;
    if (code && name) openChart(code, name);
  }
});

// ── 초기화 ───────────────────────────────────────────────────
refreshAll();
startAutoRefresh();
