// ═══════════════════════════════════════════════════════════════
// 번트 이메일 서비스 — 매수/매도 결과 Gmail 발송
// ═══════════════════════════════════════════════════════════════
const nodemailer = require('nodemailer');

let _transporter = null;
let _config = { emailTo: '', emailAppPassword: '', emailEnabled: false };

function init(config) {
  _config = { ..._config, ...config };
  if (_config.emailAppPassword && _config.emailTo) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: _config.emailTo, pass: _config.emailAppPassword },
    });
  }
}

function isReady() {
  return !!_transporter && _config.emailEnabled;
}

async function send(subject, html) {
  if (!isReady()) return;
  try {
    await _transporter.sendMail({
      from: `BUNT 번트 <${_config.emailTo}>`,
      to: _config.emailTo,
      subject,
      html,
    });
  } catch (e) {
    console.error('[EMAIL] 발송 실패:', e.message);
  }
}

// ── 매수 결과 이메일 ─────────────────────────────────────────
async function sendBuyReport(stocks, mode, presetLabel) {
  if (!isReady() || stocks.length === 0) return;
  const modeTag = mode === 'real' ? '실전' : '모의';
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const totalAmt = stocks.reduce((s, t) => s + t.qty * t.close, 0);

  const rows = stocks.map(s => `
    <tr style="border-bottom:1px solid #222;">
      <td style="padding:8px;">${s.name}<br><span style="color:#888;font-size:11px;">${s.code}</span></td>
      <td style="padding:8px;text-align:right;">${s.qty}주</td>
      <td style="padding:8px;text-align:right;">${s.close.toLocaleString()}원</td>
      <td style="padding:8px;text-align:right;color:#4caf50;">${(s.changeRate * 100).toFixed(1)}%</td>
      <td style="padding:8px;text-align:right;">${(s.qty * s.close).toLocaleString()}원</td>
    </tr>
  `).join('');

  const html = `
    <div style="background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono',Consolas,monospace;padding:24px;max-width:600px;">
      <h2 style="color:#4fc3f7;margin:0 0 4px 0;">BUNT 매수 완료</h2>
      <p style="color:#888;font-size:12px;margin:0 0 16px 0;">${now} | ${modeTag} | ${presetLabel}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="border-bottom:2px solid #333;">
          <th style="padding:8px;text-align:left;color:#888;">종목</th>
          <th style="padding:8px;text-align:right;color:#888;">수량</th>
          <th style="padding:8px;text-align:right;color:#888;">매수가</th>
          <th style="padding:8px;text-align:right;color:#888;">등락률</th>
          <th style="padding:8px;text-align:right;color:#888;">금액</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="border-top:2px solid #333;">
          <td colspan="4" style="padding:8px;font-weight:700;">합계 ${stocks.length}종목</td>
          <td style="padding:8px;text-align:right;font-weight:700;color:#4fc3f7;">${totalAmt.toLocaleString()}원</td>
        </tr></tfoot>
      </table>
    </div>
  `;

  await send(`[주식] 🟡 매수 ${stocks.length}종목 — ${totalAmt.toLocaleString()}원${mode === 'real' ? ' (실전)' : ''}`, html);
}

// ── 매도/정산 결과 이메일 ────────────────────────────────────
async function sendSellReport(results, dailyPnl, mode, presetLabel) {
  if (!isReady() || results.length === 0) return;
  const modeTag = mode === 'real' ? '실전' : '모의';
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const rows = results.map(r => {
    const pnl = r.pnl || 0;
    const pnlPct = r.pnlPct || 0;
    const color = pnl >= 0 ? '#4caf50' : '#ef5350';
    return `
      <tr style="border-bottom:1px solid #222;">
        <td style="padding:8px;">${r.name}<br><span style="color:#888;font-size:11px;">${r.code}</span></td>
        <td style="padding:8px;text-align:right;">${r.qty}주</td>
        <td style="padding:8px;text-align:right;">${(r.buyPrice || 0).toLocaleString()}원</td>
        <td style="padding:8px;text-align:right;">${(r.sellPrice || 0).toLocaleString()}원</td>
        <td style="padding:8px;text-align:right;color:${color};">${pnl > 0 ? '+' : ''}${pnl.toLocaleString()}원 (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)</td>
      </tr>
    `;
  }).join('');

  const buyTotal = results.reduce((s, r) => s + (r.buyPrice || 0) * (r.qty || 0), 0);
  const dailyPnlPct = buyTotal > 0 ? (dailyPnl / buyTotal * 100).toFixed(2) : '0.00';
  const pnlColor = dailyPnl >= 0 ? '#4caf50' : '#ef5350';

  const html = `
    <div style="background:#0a0a0f;color:#e0e0e0;font-family:'SF Mono',Consolas,monospace;padding:24px;max-width:600px;">
      <h2 style="color:#4fc3f7;margin:0 0 4px 0;">BUNT 매도 정산</h2>
      <p style="color:#888;font-size:12px;margin:0 0 16px 0;">${now} | ${modeTag} | ${presetLabel}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="border-bottom:2px solid #333;">
          <th style="padding:8px;text-align:left;color:#888;">종목</th>
          <th style="padding:8px;text-align:right;color:#888;">수량</th>
          <th style="padding:8px;text-align:right;color:#888;">매수가</th>
          <th style="padding:8px;text-align:right;color:#888;">매도가</th>
          <th style="padding:8px;text-align:right;color:#888;">손익</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="border-top:2px solid #333;">
          <td colspan="4" style="padding:8px;font-weight:700;">일일 합계 (매수총액 ${buyTotal.toLocaleString()}원)</td>
          <td style="padding:8px;text-align:right;font-weight:700;color:${pnlColor};">${dailyPnl > 0 ? '+' : ''}${dailyPnl.toLocaleString()}원 (${dailyPnlPct}%)</td>
        </tr></tfoot>
      </table>
    </div>
  `;

  await send(`[주식] ${dailyPnl >= 0 ? '🟢' : '🔴'} 매도 정산 ${dailyPnl > 0 ? '+' : ''}${dailyPnl.toLocaleString()}원${mode === 'real' ? ' (실전)' : ''}`, html);
}

async function sendError(title, detail) {
  const html = `
    <div style="font-family:monospace;padding:20px;background:#1a1a2e;color:#ff6b6b;">
      <h2>${title}</h2>
      <pre style="color:#fff;background:#16213e;padding:15px;border-radius:8px;">${detail}</pre>
      <p style="color:#888;">${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
    </div>`;
  await send(`[주식] 🚨 ${title}`, html);
}

module.exports = { init, isReady, send, sendBuyReport, sendSellReport, sendError };
