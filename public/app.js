// ═══════════════════════════════════════════════════════════════
// 번트(BUNT) 대시보드 프론트엔드
// ═══════════════════════════════════════════════════════════════

const API = '';
let refreshInterval = null;
let countdown = 30;

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

  // 모드 전환 — 전체 테마 변경
  const isReal = data.tradingMode === 'real';
  document.body.className = isReal ? 'mode-real' : '';
  document.title = isReal
    ? '🔴 [실전] 번트 BUNT'
    : '번트(BUNT) - 오버나잇 자동매매';

  // 토글 버튼
  const btn = document.getElementById('toggleBtn');
  btn.textContent = isReal ? 'ON 실전' : 'OFF 모의';
  btn.className = `toggle-btn ${isReal ? 'on' : 'off'}`;

  // 모드 라벨
  const modeLabel = document.getElementById('modeLabel');
  modeLabel.textContent = isReal ? 'REAL 실전투자' : 'PAPER 모의투자';
  modeLabel.className = `mode-label ${isReal ? 'real' : 'paper'}`;

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
    posBody.innerHTML = positions.map(p => `
      <tr>
        <td>${p.name}<br><span style="color:var(--dim)">${p.code}</span></td>
        <td>${p.qty}</td>
        <td>${(p.buyPrice || 0).toLocaleString()}</td>
        <td class="${p.changeRate >= 0 ? 'pnl-pos' : 'pnl-neg'}">${(p.changeRate * 100).toFixed(1)}%</td>
      </tr>
    `).join('');
  } else {
    posBody.innerHTML = '<tr><td colspan="4" class="empty-msg">보유 종목 없음</td></tr>';
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
          <td>${s.name}<br><span style="color:var(--dim)">${s.code}</span></td>
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

  // 일별 PnL
  const pnlBody = document.getElementById('pnlTable');
  const dailyPnl = data.dailyPnl || [];
  if (dailyPnl.length > 0) {
    pnlBody.innerHTML = dailyPnl.map(p => `
      <tr>
        <td>${p.date}</td>
        <td>${p.stocks}</td>
        <td class="${p.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${p.pnl > 0 ? '+' : ''}${p.pnl.toLocaleString()}원</td>
      </tr>
    `).join('');
  } else {
    pnlBody.innerHTML = '<tr><td colspan="3" class="empty-msg">아직 거래 내역 없음</td></tr>';
  }

  // 누적 PnL
  const totalPnl = data.totalPnl || 0;
  const pnlEl = document.getElementById('totalPnl');
  pnlEl.textContent = `${totalPnl > 0 ? '+' : ''}${totalPnl.toLocaleString()}원`;
  pnlEl.className = `stat-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : ''}`;
}

async function refreshStats() {
  const data = await api('/api/stats');
  if (!data) return;

  document.getElementById('winRate').textContent = `${data.winRate}%`;
  document.getElementById('tradingDays').textContent = `${data.totalDays}일`;
  document.getElementById('maxDD').textContent = `${data.maxDD}%`;
}

async function refreshBalance() {
  const data = await api('/api/balance');
  if (data && !data.error) {
    document.getElementById('deposit').textContent = `${data.deposit.toLocaleString()}원`;
  } else {
    document.getElementById('deposit').textContent = '--';
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

// ── 액션 ─────────────────────────────────────────────────────
async function toggleEngine() {
  const btn = document.getElementById('toggleBtn');
  const isCurrentlyPaper = btn.textContent.includes('모의');
  if (isCurrentlyPaper) {
    if (!confirm('⚠️ 실전투자(REAL) 모드로 전환합니다.\n실제 자금으로 매매가 실행됩니다.\n\n정말 전환하시겠습니까?')) return;
    if (!confirm('🔴 최종 확인: 실전투자 모드 ON?')) return;
  }
  await api('/api/toggle', { method: 'POST' });
  showToast(isCurrentlyPaper ? '🔴 실전투자 모드 ON' : '🟢 모의투자 모드로 전환');
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

// ── 초기화 ───────────────────────────────────────────────────
refreshAll();
startAutoRefresh();
