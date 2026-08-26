// PawShop 客服工单弹窗:注入到任何引入本文件的页面
// 顾客提交 → 站长邮箱(FormSubmit) + 微信推送(Server酱)双通道
(function () {
  if (document.getElementById('psSupportModal')) return;

  const zh = (localStorage.getItem('pawshop_lang') || 'en') === 'zh';
  const T = zh ? {
    title: '联系客服',
    sub: '订单问题、退换、任何疑问,提交后我们会邮件回复你。',
    email: '你的邮箱 *',
    order: '订单号(选填)',
    msg: '问题描述 *',
    send: '提交',
    ok: '已收到!我们会尽快邮件回复你。',
    invalid: '请填写邮箱和问题描述',
    cancel: '取消',
  } : {
    title: 'Customer Support',
    sub: 'Order issues, returns, any question. We reply by email.',
    email: 'Your email *',
    order: 'Order number (optional)',
    msg: 'How can we help? *',
    send: 'Submit',
    ok: "Got it! We'll reply to your email shortly.",
    invalid: 'Please fill in your email and message',
    cancel: 'Cancel',
  };

  const modal = document.createElement('div');
  modal.id = 'psSupportModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;padding:1rem;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:24rem;width:100%;padding:2rem;">
      <h2 style="font-size:1.05rem;font-weight:700;margin-bottom:.25rem;">${T.title}</h2>
      <p style="font-size:.75rem;color:#94a3b8;margin-bottom:1.25rem;">${T.sub}</p>
      <input id="supEmail" type="email" placeholder="${T.email}" style="width:100%;padding:.65rem .75rem;border:1px solid #e2e8f0;border-radius:.5rem;font-size:.875rem;margin-bottom:.6rem;">
      <input id="supOrder" placeholder="${T.order}" style="width:100%;padding:.65rem .75rem;border:1px solid #e2e8f0;border-radius:.5rem;font-size:.875rem;margin-bottom:.6rem;font-family:monospace;">
      <textarea id="supMsg" rows="3" placeholder="${T.msg}" style="width:100%;padding:.65rem .75rem;border:1px solid #e2e8f0;border-radius:.5rem;font-size:.875rem;margin-bottom:1rem;"></textarea>
      <button id="supSend" style="width:100%;padding:.7rem;background:#0f172a;color:#fff;border-radius:.5rem;font-size:.875rem;border:0;cursor:pointer;">${T.send}</button>
      <button id="supCancel" style="width:100%;padding:.5rem;color:#94a3b8;font-size:.75rem;background:none;border:0;cursor:pointer;margin-top:.25rem;">${T.cancel}</button>
    </div>`;
  document.body.appendChild(modal);

  window.openSupport = function (orderNo) {
    if (orderNo) document.getElementById('supOrder').value = orderNo;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('supEmail').focus(), 50);
  };
  const close = () => { modal.style.display = 'none'; document.body.style.overflow = ''; };
  document.getElementById('supCancel').onclick = close;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display === 'flex') close(); });
  modal.onclick = e => { if (e.target === modal) close(); };

  document.getElementById('supSend').onclick = function () {
    const email = document.getElementById('supEmail').value.trim();
    const msg = document.getElementById('supMsg').value.trim();
    const orderNo = document.getElementById('supOrder').value.trim();
    if (!email.includes('@') || !msg) { alert(T.invalid); return; }

    const page = location.pathname.split('/').pop() || 'store';
    const body = `顾客: ${email}\n订单: ${orderNo || '-'}\n页面: ${page}\n\n${msg}`;

    try {
      const cfgE = (typeof WAITLIST_NOTIFY_EMAIL !== 'undefined') && WAITLIST_NOTIFY_EMAIL;
      if (cfgE) {
        fetch('https://formsubmit.co/ajax/' + cfgE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ _subject: 'Customer support - PawShop', _template: 'table', Message: body.replace(/\n/g, '<br>') }),
        }).catch(() => {});
      }
      const cfgK = (typeof SERVERCHAN_SEND_KEY !== 'undefined') && SERVERCHAN_SEND_KEY;
      if (cfgK) {
        fetch('https://sctapi.ftqq.com/' + cfgK + '.send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'title=' + encodeURIComponent('PawShop 客服工单') + '&desp=' + encodeURIComponent(body),
        }).catch(() => {});
      }
    } catch (e) {}

    close();
    alert(T.ok);
  };
})();
