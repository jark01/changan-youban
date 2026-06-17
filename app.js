
// ===== 支付状态管理 =====
let isPaid = false;
let _pendingAction = null;
try { isPaid = localStorage.getItem('changan_paid_v3') === 'true'; } catch(e) { isPaid = false; }

function checkPayStatus() {
  return isPaid;
}

function showPayModal(action) {
  _pendingAction = action || 'form';
  // 设置二维码：优先用本地 qrcode.png，否则用API生成
  const qrImg = document.getElementById('pay-qrcode-img');
  if (qrImg) {
    // 尝试加载本地收款码图片
    const localQR = 'qrcode.png?' + Date.now();
    const fallbackQR = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=07C160&data=' + encodeURIComponent('向长安游伴支付¥9.90旅行规划费');
    qrImg.src = localQR;
    // 如果本地图片加载失败（onerror），自动切换成API生成的二维码
    qrImg.onerror = function() {
      if (this.src.indexOf('api.qrserver.com') === -1) {
        this.src = fallbackQR;
        this.onerror = null; // 防止无限循环
      }
    };
  }
  document.getElementById('pay-overlay').classList.add('show');
}

function closePayModal() {
  document.getElementById('pay-overlay').classList.remove('show');
}

function startPay() {
  // 模拟微信支付成功（实际应接入微信支付SDK）
  const btn = document.getElementById('pay-btn');
  btn.classList.add('disabled');
  btn.innerHTML = '⏳ 正在确认支付…';
  
  setTimeout(() => {
    isPaid = true;
    localStorage.setItem('changan_paid_v3', 'true');
    closePayModal();
    alert('✅ 支付成功！正在为您生成行程…');
    
    // 执行待执行的操作
    if (_pendingAction === 'form') {
      // 支付成功，重新提交表单（此时 isPaid=true，会通过检查）
      submitForm();
    } else if (_pendingAction === 'chat') {
      openAIChat();
    }
    _pendingAction = null;
  }, 1500);
}

// ===== 全局错误捕获 =====
window.onerror = function(msg, src, line, col, err) {
  const panel = document.getElementById('debug-panel');
  if (panel) {
    panel.style.display = 'block';
    panel.innerHTML += '[JS错误] ' + msg + '\n位置: ' + (src||'') + ':' + (line||'') + '\n' + (err&&err.stack||'') + '\n\n';
    panel.scrollTop = panel.scrollHeight;
  }
  console.error('[全局捕获]', msg, err);
};
window.addEventListener('unhandledrejection', function(e) {
  const panel = document.getElementById('debug-panel');
  if (panel) {
    panel.style.display = 'block';
    panel.innerHTML += '[Promise未捕获] ' + (e.reason&&e.reason.message||e.reason) + '\n' + (e.reason&&e.reason.stack||'') + '\n\n';
    panel.scrollTop = panel.scrollHeight;
  }
});

// ===== 检测是否用 file:// 打开 =====
(function(){
  if (location.protocol === 'file:') {
    document.addEventListener('DOMContentLoaded', function(){
      document.body.innerHTML = '<div style="padding:40px;font-size:16px;color:#333;">' +
        '<h2>⚠️ 请把页面通过代理打开</h2>' +
        '<p>不能直接双击 HTML 文件打开（会导致 API 调用失败）。</p>' +
        '<p style="margin-top:20px;">✅ 正确方式：</p>' +
        '<ol style="text-align:left;display:inline-block;">' +
        '<li>双击 <b>启动.bat</b></li>' +
        '<li>或浏览器访问 <code>http://localhost:3457</code></li>' +
        '</ol></div>';
    });
  }
})();

// ===== STATE =====
const AMAP_KEY = 'bb7f0c78ad5530def46192c141edf568';
const AMAP_BASE = 'https://restapi.amap.com/v3';
const state = {
  from:'', depart:'', return:'', transport:'公共交通',
  who:'', count:2, budget:'', hotelBudget:'200-400', hotelType:'舒适型',
  foodTaboo:'无忌讳', pace:'适中(4-5个地方)', note:'',
  styles:[], mustSee:[], foodPref:[], foodWant:[], specials:[]
};

// ===== NAV =====
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  window.scrollTo(0,0);
}
function goToForm() {
  document.getElementById('f-depart').value = '';
  document.getElementById('f-return').value = '';
  showPage('form');
}

// ===== CHIP SELECTION =====
function selChip(key, val, el) {
  el.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state[key] = val;
}

// ===== COUNT =====
function adjCount(d) { 
  state.count = Math.max(1, Math.min(10, state.count + d)); 
  document.getElementById('count-num').textContent = state.count; 
}

// ===== DATE =====
function onDateChange() {
  state.depart = document.getElementById('f-depart').value;
  state.return = document.getElementById('f-return').value;
}

// ===== QUICK FILL =====
function quickFill(note) { state._quickNote = note; goToForm(); }

// ===== COLLECT MULTI-SELECT =====
function collectMulti(key, parentSelector) {
  const chips = document.querySelectorAll(parentSelector+' .multi.selected');
  return Array.from(chips).map(c => c.textContent.trim().replace(/^[^\s]+\s/,''));
}

// ===== VALIDATE & SUBMIT =====
function submitForm() {
  state.from = document.getElementById('f-from').value.trim();
  state.depart = document.getElementById('f-depart').value;
  state.return = document.getElementById('f-return').value;
  state.note = document.getElementById('f-note').value.trim();
  
  state.styles = collectMulti('style','.sec-play:last-of-type');
  state.mustSee = collectMulti('must','.sec-play:last-of-type');
  state.foodPref = collectMulti('food','.sec-food');
  state.foodWant = collectMulti('food','.sec-food');
  state.specials = collectMulti('special','.sec-note');
  
  if (!state.from) return toast('请填写出发城市');
  if (!state.who) return toast('请选择出行同伴');
  if (!state.budget) return toast('请选择人均预算');
  
  const days = calcDays();
  if (days < 1) return toast('请选择出行日期（出发和返回）');
  state._days = days;
  
  // 检查支付状态
  if (!checkPayStatus()) {
    // 保存表单数据到全局变量
    window._pendingFormData = { ...state };
    showPayModal('form');
    return;
  }
  
  showPage('loading');
  startLoadingAnim();
  callDeepSeek();
}

// ===== LOADING ANIMATION =====
let _loadTimer = null;
let _loadSafetyTimer = null;
function startLoadingAnim() {
  const tips = document.querySelectorAll('#page-loading .load-tips span');
  const bar = document.querySelector('#page-loading .load-bar');
  const sub = document.querySelector('#page-loading .load-sub');
  let idx = 0;
  let w = 0;
  tips.forEach(t => t.style.display = 'none');
  if (tips.length > 0) tips[0].style.display = 'inline-block';
  _loadTimer = setInterval(() => {
    idx = (idx + 1) % tips.length;
    tips.forEach((t, i) => t.style.display = i === idx ? 'inline-block' : 'none');
    w = Math.min(100, w + (100 - w) * 0.08 + Math.random() * 3);
    bar.style.width = w + '%';
    if (idx === 0 && w > 60) sub.textContent = '内容较多，AI正在仔细规划中\u2026';
    if (idx === 1 && w > 75) sub.textContent = '快完成了，请稍等\u2026';
  }, 1800);

  _loadSafetyTimer = setTimeout(() => {
    stopLoadingAnim();
    document.getElementById('result-body').innerHTML = `
      <div class="err-box">
        <p>\u23F0 AI响应超时（已超过50秒）</p>
        <p style="font-size:13px;color:#999;margin-top:8px;">
          可能原因：<br>
          1. DeepSeek API 响应慢，请稍后重试<br>
          2. 网络不稳定，请检查连接<br>
          3. 代理服务器未正常运行
        </p>
        <button class="btn-retry" onclick="showPage('hero')">重新填写</button>
      </div>`;
    showPage('result');
  }, 50000);
}
function stopLoadingAnim() {
  if (_loadTimer) { clearInterval(_loadTimer); _loadTimer = null; }
  if (_loadSafetyTimer) { clearTimeout(_loadSafetyTimer); _loadSafetyTimer = null; }
  const bar = document.querySelector('#page-loading .load-bar');
  if (bar) bar.style.width = '100%';
}

function calcDays() {
  const d = document.getElementById('f-depart').value;
  const r = document.getElementById('f-return').value;
  if (!d || !r) return 0;
  const dd = new Date(d), rd = new Date(r);
  return Math.max(1, Math.round((rd - dd) / 86400000) + 1);
}

// ===== DEEPSEEK API =====
const PROXY_URL = '/api/chat';

async function callDeepSeek() {
  const prompt = buildPrompt();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000);

  try {
    const resp = await fetch(PROXY_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat', max_tokens: 2500, temperature: 0.85,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ]
      })
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const ed = await resp.json().catch(()=>({}));
      if (resp.status===401) throw new Error('API Key无效');
      throw new Error(ed.message||ed.error||('服务器错误 '+resp.status));
    }
    const data = await resp.json();
    stopLoadingAnim();
    renderResult(data.choices[0].message.content);
  } catch(e) {
    clearTimeout(timeout);
    stopLoadingAnim();
    let msg = e.message;
    if (e.name==='AbortError') msg = 'AI响应超时，请重试';
    else if (msg==='Failed to fetch') msg = '代理未启动，请先运行 proxy.js';
    renderError(msg);
  }
}

function buildPrompt() {
  const days = state._days || calcDays();
  const parts = [
    `\u51FA\u53D1\u57CE\u5E02\uFF1A${state.from}`,
    `\u51FA\u884C\u65E5\u671F\uFF1A${state.depart||'\u672A\u6307\u5B9A'} \u81F3 ${state.return||'\u672A\u6307\u5B9A'}\uFF0C\u5171${days}\u5929`,
    `\u51FA\u884C\u540C\u4F34\uFF1A${state.who||'\u672A\u9009'}\uFF0C\u5171${state.count}\u4EBA`,
    `\u4EBA\u5747\u603B\u9884\u7B97\uFF1A${state.budget||'\u672A\u9009'}`,
    `\u4F4F\u5BBF\u6BCF\u665A\uFF1A${state.hotelBudget||'200-400'}\uFF0C\u7C7B\u578B\uFF1A${state.hotelType||'\u8212\u9002\u578B'}`,
    `\u4EA4\u901A\u65B9\u5F0F\uFF1A${state.transport||'\u516C\u5171\u4EA4\u901A'}`,
    `\u53E3\u5473\u504F\u597D\uFF1A${state.foodPref.join('\u3001')||'\u4E0D\u9650'}`,
    `\u60F3\u5403\uFF1A${state.foodWant.join('\u3001')||'\u4E0D\u9650'}`,
    `\u996E\u98DF\u7981\u5FCC\uFF1A${state.foodTaboo||'\u65E0'}`,
    `\u65C5\u884C\u98CE\u683C\uFF1A${state.styles.join('\u3001')||'\u7EFC\u5408\u4F53\u9A8C'}`,
    `\u5FC5\u53BB\u666F\u70B9\uFF1A${state.mustSee.join('\u3001')||'\u65E0\u7279\u522B\u6307\u5B9A'}`,
    `\u8282\u594F\uFF1A${state.pace||'\u9002\u4E2D'}`,
    `\u7279\u6B8A\u9700\u6C42\uFF1A${state.specials.join('\u3001')||'\u65E0'}`,
  ];
  if (state.note) parts.push(`\u8865\u5145\u8BF4\u660E\uFF1A${state.note}`);
  if (state._quickNote) parts.push(`\u5FEB\u6377\u5907\u6CE8\uFF1A${state._quickNote}`);
  return `\u8BF7\u6839\u636E\u4EE5\u4E0B\u4FE1\u606F\u5236\u5B9A${days}\u5929\u897F\u5B89\u65C5\u884C\u8DEF\u7EBF\uFF08\u5305\u542B\u9AD8\u5FB7\u5730\u56FE\u5750\u6807\uFF09\uFF1A\n\n`+parts.join('\n');
}

const SYSTEM_PROMPT = `你是"小长安"，西安14年土著向导，陕西腔（额代替我），热情直爽。输出纯JSON（不含任何其他文字）：
{
  "title":"一行路线标题",
  "xiaoba_say":"小长安开场白（100字内，有烟火气）",
  "days":[{
    "day":1,"theme":"当日主题",
    "spots":[{"time":"08:00-10:00","name":"景点","tip":"小长安建议1-2句陕西话","coord":"lng,lat"}]
  }],
  "foods":[{"name":"美食","area":"区域","tip":"一句话","coord":"lng,lat"}],
  "hotel":{"area":"推荐住宿区域","reason":"理由","budget":"价位"},
  "budget":{"transport":"交通","tickets":"门票","food":"餐饮","hotel":"住宿","total":"合计"},
  "tips":["避坑1","避坑2","避坑3"],
  "car_suggest":true
}

坐标格式：西安兵马俑coord为"109.285,34.385"，大雁塔为"108.963,34.225"，钟楼为"108.948,34.267"，城墙南门为"108.948,34.254"，回民街为"108.944,34.270"，大唐不夜城为"108.967,34.217"，华山为"110.091,34.490"，陕历博为"108.955,34.225"，骊山为"109.214,34.366"。
只输出JSON，字数精简。`;

// ===== RENDER RESULT =====
function renderResult(content) {
  let plan;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    plan = JSON.parse(m?m[0]:content);
  } catch(e) { plan = { title:'路线已生成', xiaoba_say:content.substring(0,400), days:[], foods:[], tips:['详细内容请截图'], budget:null, hotel:null, car_suggest:false }; }

  document.getElementById('res-title').textContent = plan.title||'你的专属西安路线';
  document.getElementById('res-meta').innerHTML = `
    <span>\uD83D\uDCC5 ${state._days||calcDays()}\u5929</span>
    <span>\uD83D\uDC64 ${state.count}\u4EBA</span>
    <span>\uD83D\uDCB0 ${state.budget||'\u2014'}</span>
    <span>${state.transport||'\u516C\u5171\u4EA4\u901A'}</span>
  `;
  let h = '';

  if (plan.xiaoba_say) h += `<div class="rcard"><div class="xb-bubble">
    <div class="xb-bub-head"><div class="xb-bub-avatar">🏯</div><span class="xb-bub-name">小长安说</span></div>
    <div class="xb-bub-text">${plan.xiaoba_say}</div></div></div>`;

  // 每日行程（带高德导航）
  if (plan.days && plan.days.length) {
    plan.days.forEach(d => {
      const coords = (d.spots||[]).filter(s=>s.coord).map(s=>s.coord).join('|');
      const navUrl = coords ? `https://uri.amap.com/navigation?to=${(d.spots[0]||{}).name||''}` : '#';

      h += `<div class="rcard">
        <div class="day-block">
          <div class="day-head">
            <div class="day-num">D${d.day}</div>
          <div class="day-theme">${d.theme||'第'+d.day+'天'}</div>
            <div class="day-nav">
              <button class="btn-nav" onclick="openAmapDay('${encodeURIComponent(JSON.stringify((d.spots||[]).map(s=>({name:s.name,coord:s.coord}))))}')">\uD83E\uDDED \u9AD8\u5FB7\u5BFC\u822A</button>
            </div>
          </div>
        </div>
        <div class="tl">`;
      (d.spots||[]).forEach(s => {
        const navLink = s.coord ? `https://uri.amap.com/navigation?to=${encodeURIComponent(s.name)}` : '#';
        h += `<div class="tl-item">
          <div class="tl-dot"></div><div class="tl-info">
            <div class="tl-time">${s.time||''}</div>
            <div class="tl-name">${s.name||''}</div>
            ${s.tip?`<div class="tl-tip">${s.tip}</div>`:''}
            <div class="tl-nav">
              <a href="${navLink}" target="_blank">&#x1F9ED; &#x4e00;&#x952e;&#x5bfc;&#x822a;</a>
              <button class="tl-guide-btn" onclick="openGuide('${s.name}')">&#x1F4F8; &#x653b;&#x7565;</button>
            </div>
          </div></div>`;
      });
      h += `</div></div>`;
    });
  }

  // 美食
  if (plan.foods && plan.foods.length) {
    h += `<div class="rcard"><div class="rcard-title">小长安私房美食单</div><div class="food-grid">`;
    plan.foods.forEach(f => {
      h += `<div class="food-card">
        <div class="food-name">\uD83C\uDF5C ${f.name||''}</div>
        <div class="food-area">\uD83D\uDCCD ${f.area||''}</div>
        <div class="food-tip">${f.tip||''}</div>
      </div>`;
    });
    h += `</div></div>`;
  }

  // 住宿
  if (plan.hotel) {
    h += `<div class="rcard"><div class="rcard-title">住宿推荐</div>
      <div class="hotel-card"><div class="hotel-emoji">\uD83C\uDFE8</div><div class="hotel-info">
        <div class="hotel-name">${plan.hotel.area||'推荐区域'}</div>
        <div class="hotel-meta">${plan.hotel.reason||''}</div>
        <div class="hotel-price"><span class="price-now">${plan.hotel.budget||''}</span><span class="rebate-tag">小长安专享</span></div>
      </div></div></div>`;
  }

  // 预算
  if (plan.budget) {
    h += `<div class="rcard"><div class="rcard-title">预算参考（人均）</div>
      <div class="budget-grid">
        <div class="bg-item"><div class="bg-label">\uD83D\uDE8C 交通</div><div class="bg-val">${plan.budget.transport||'\u2014'}</div></div>
        <div class="bg-item"><div class="bg-label">\uD83C\uDFAB 门票</div><div class="bg-val">${plan.budget.tickets||'\u2014'}</div></div>
        <div class="bg-item"><div class="bg-label">\uD83C\uDF5C 餐饮</div><div class="bg-val">${plan.budget.food||'\u2014'}</div></div>
        <div class="bg-item"><div class="bg-label">\uD83C\uDFE8 住宿</div><div class="bg-val">${plan.budget.hotel||'\u2014'}</div></div>
      </div>
      <div class="bg-total"><span class="bg-total-label">合计（人均）</span><span class="bg-total-val">${plan.budget.total||'\u2014'}</span></div></div>`;
  }

  // 专车
  if (plan.car_suggest || state.transport==='专车+司机') {
    h += `<div class="rcard"><div class="rcard-title">一人一车 · 全程托管</div>
      <div class="car-card">
        <div class="car-title">西安本地司机+车辆 · 不绕路不宰客</div>
        <div class="car-price">\u00A5400 <s>\u00A5600</s> /天</div>
        <div class="car-tags"><span class="car-tag">8h/200km</span><span class="car-tag">接送站</span><span class="car-tag">随时等候</span><span class="car-tag">私房美食带路</span><span class="car-tag">行李随车</span></div>
        <button class="car-book" onclick="openDriverService()">\uD83D\uDCF1 预约专车</button>
      </div></div>`;
  }

  // 避坑
  if (plan.tips && plan.tips.length) {
    h += `<div class="rcard"><div class="rcard-title">\u26A0\uFE0F 避坑指南</div><div class="tips-list">`;
    plan.tips.forEach(t => h += `<div class="tips-item">${t}</div>`);
    h += `</div></div>`;
  }

  document.getElementById('result-body').innerHTML = h;
  showPage('result');
}

// 高德地图：打开当日全部景点导航
function openAmapDay(spotsJson) {
  try {
    const spots = JSON.parse(decodeURIComponent(spotsJson));
    if (!spots.length) return toast('暂无导航信息');
    if (spots.length === 1) {
      window.open(`https://uri.amap.com/navigation?to=${encodeURIComponent(spots[0].name)}`, '_blank');
    } else {
      const names = spots.map(s => s.name).join(' \u2192 ');
      toast('路线：' + names + '\n请逐个点击各站"一键导航"');
    }
  } catch(e) { toast('导航信息解析失败'); }
}

function renderError(msg) {
  let hint = '';
  if (msg.includes('API Key')) hint = '在 proxy.js 中填入 DeepSeek API Key';
  else if (msg.includes('代理') || msg.includes('fetch')) hint = '终端运行：node proxy.js';
  document.getElementById('result-body').innerHTML = `<div class="err-box">
    <p>\uD83D\uDE14 ${msg}</p><div class="hint">${hint}</div>
    <button class="btn-retry" onclick="showPage('hero')">重新填写</button></div>`;
  showPage('result');
}

function shareResult() {
  if (navigator.share) navigator.share({ title:'我用AI规划了西安路线', text:'小长安帮我规划的，超详细！', url:location.href });
  else toast('截图分享给朋友吧！');
}

function toast(m) {
  const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// =============================================
// SPOT GUIDE DATA
// =============================================
const SPOT_GUIDES = {
  "钟楼": {
    intro: "西安钟楼建于明洪武十七年（1384年），是中国现存规模最大、保存最完整的钟楼。位于古城中心，四条大街以它为轴心放射展开。登楼可俯瞰东西南北四条大街，金色琉璃顶在夕阳下熠熠生辉。",
    image: "https://pixabay.com/get/g30566490cf940b751205246088fd6af46623b01ac78a0a815e774e8e46575542ca6e2523cc494f0f17fedaebd734dfae_1920.jpg",
    photos: [
      { emoji: "🌅", title: "东南角黄昏侧光", desc: "下午4-5点从钟楼东南角拍摄，金色阳光打在楼体侧面，琉璃瓦反光极美。手机用2x变焦压缩透视" },
      { emoji: "🌃", title: "十字路口夜景对称", desc: "日落后30分钟蓝调时刻，站在钟楼环岛东南角斑马线处，等红灯车流作前景，对称构图绝佳" },
      { emoji: "📐", title: "南大街纵深透视", desc: "站在钟楼南侧地下通道出口，用南大街作引导线，钟楼居中。广角模式拍出街道延伸感" },
      { emoji: "🎯", title: "二楼斗拱特写", desc: "登钟楼二楼，用3x长焦拍斗拱与彩绘细节，逆光时剪影效果充满古韵" }
    ],
    tips: [
      "🎫门票30元，开放9:00-21:30，最晚入场21:00",
      "📸最佳时段：傍晚6-7点金色阳光+日落后蓝调双拍",
      "🏮钟楼+鼓楼联票50元更划算，步行3分钟即到",
      "👗穿汉服上钟楼拍照超有氛围，附近有多家汉服租赁"
    ]
  },
  "鼓楼": {
    intro: "鼓楼建于明洪武十三年（1380年），比钟楼还早4年。楼上悬挂着全国最大的鼓，每天有仿唐乐舞表演。登楼可北望回民街的烟火气，南眺钟楼的巍峨身姿。",
    image: "https://pixabay.com/get/ga6d3376f1181975920c4b3a1c855fa1cb28b116f60f4fb3acf4ee7406b8ab070438772249d643e5d57985b9d458e13d8_1920.jpg",
    photos: [
      { emoji: "🏮", title: "鼓楼北面红灯笼", desc: "从鼓楼北侧广场拍摄，红灯笼为前景，鼓楼居中。下午3-5点顺光拍摄色彩最鲜艳" },
      { emoji: "↔️", title: "钟鼓同框经典位", desc: "站在钟楼与鼓楼之间的广场正中，两楼左右对称入镜，广角0.5x双楼同框" },
      { emoji: "🌙", title: "南面夜景长曝光", desc: "晚上8点后从南侧拍鼓楼，'文武盛地'牌匾发金光，手机夜景模式3秒手持即可" },
      { emoji: "🥁", title: "鼓乐表演抓拍", desc: "整点鼓乐表演时，在二楼栏杆处俯拍，鼓手与二十四节气鼓同框，动感十足" }
    ],
    tips: [
      "🎫门票30元，鼓乐表演整点演出，值得等一场",
      "🍜鼓楼北面就是回民街，逛完直接去吃",
      "📷钟鼓楼夜景是西安明信片级画面，必拍"
    ]
  },
  "大雁塔": {
    intro: "大雁塔是西安最著名的地标，建于唐永徽三年（652年），玄奘法师为保存天竺经卷而建。七层方塔高64.5米，北广场有亚洲最大矩阵音乐喷泉，夜景尤为壮观。",
    image: "https://pixabay.com/get/ged47591e8734c409ddd0ef343fc3695f45fe6c3cc8b43d17039227873ef32acfd8a14040896787c7c0c8b2196a7f5e9f_1920.jpg",
    photos: [
      { emoji: "🔭", title: "北广场喷泉倒影", desc: "北广场喷泉池边低机位拍摄，利用水面倒影拍出塔身对称镜像。喷泉表演时更有层次感" },
      { emoji: "📸", title: "大慈恩寺正门框景", desc: "站在大慈恩寺南门内，用门洞做框取景大雁塔，形成天然画框构图" },
      { emoji: "🌄", title: "西南角黄昏剪影", desc: "日落时分在大雁塔西南角，让塔身形成漂亮剪影，天空橙蓝渐变作背景" },
      { emoji: "✨", title: "大唐不夜城远眺", desc: "从大雁塔南广场向大唐不夜城方向拍，塔身与步行街灯光呼应，夜景绝美" }
    ],
    tips: [
      "🎫大慈恩寺门票40元（登塔另加25元），北广场免费",
      "⛲喷泉时间：12:00/16:00/19:00/21:00，周末加场",
      "🌙建议下午4点到，先拍白天再等喷泉夜景，一气呵成",
      "🚇地铁3号线大雁塔站C口出即到"
    ]
  },
  "兵马俑": {
    intro: "兵马俑是世界第八大奇迹，秦始皇陵的大型陪葬坑，1974年被农民打井时意外发现。已出土陶俑8000余件，每个俑面部表情各异、千人千面。1987年列入世界文化遗产。",
    image: "https://pixabay.com/get/g6ea267a95b57410d71c8252778715b6626cf6e0a7add702b1889110ade779340667244df966bb9d714d8fb3a38a39398_1920.jpg",
    photos: [
      { emoji: "🏟️", title: "一号坑东南角全景", desc: "进门后走右侧通道到东南角高台，这是拍一号坑最经典的角度，俯拍千军万马的震撼" },
      { emoji: "🔍", title: "前排陶俑面部特写", desc: "在一号坑前排栏杆处，用3x-5x长焦拍陶俑面部细节，找表情独特的俑更有故事感" },
      { emoji: "⚔️", title: "二号坑将军俑", desc: "二号坑展柜光线较好，将军俑铠甲纹理清晰，侧面拍展现战袍飘逸感" },
      { emoji: "🏺", title: "铜车马展馆细节", desc: "铜车马展厅光线较暗，手机夜景模式拍铜车马的精细纹饰，金色细节非常震撼" }
    ],
    tips: [
      "🎫门票120元，旺季建议提前网上购票，游览需3-4小时",
      "🚌西安火车站东广场坐游5/306路直达，约1小时",
      "📸博物馆内禁止闪光灯和三脚架，手机拍摄完全OK",
      "🎧强烈建议请导游或租讲解器，了解背后故事体验翻倍"
    ]
  },
  "华山": {
    intro: "华山是五岳之西岳，以险峻闻名天下。'奇险天下第一山'，南峰海拔2154.9米为五岳最高。'长空栈道''鹞子翻身'等险关考验胆量。也是道教圣山，云雾缭绕时如临仙境。",
    image: "https://pixabay.com/get/g62e97ab7e5cb9ca391ce735557a2a67cfd0774671a2d0f57a616b70d9811ef119e88c80bd25183fd183beb1f24ed1e15_1920.jpg",
    photos: [
      { emoji: "🌄", title: "东峰观日台日出", desc: "凌晨4:30从北峰出发，5:30前到达东峰观日台。日出前30分钟蓝调拍云海，日出时拍金光穿云" },
      { emoji: "⛰️", title: "苍龙岭脊背航拍感", desc: "在苍龙岭中段找安全位置，手机举高俯拍山脊步道，人在山脊上如行画中" },
      { emoji: "🧗", title: "长空栈道极限视角", desc: "系好安全带后，让人在栈道上走，从入口平台侧拍，悬崖+人的对比张力满格" },
      { emoji: "🏯", title: "西峰莲花峰道观", desc: "西峰顶道观与云海同框，下午2-4点云海出现概率最高，用全景模式拍出壮阔" }
    ],
    tips: [
      "🎫门票180元，西峰索道140元，北上西下最经典",
      "🧥山顶温差大，带冲锋衣，凌晨山顶可能低于10度",
      "🥾穿防滑登山鞋！华山台阶陡峭安全第一",
      "📱山顶信号不稳定，提前下载离线地图"
    ]
  },
  "回民街": {
    intro: "回民街由北院门、西羊市、大皮院等多条古街组成，已有上千年历史。白天古朴安静，夜晚灯火通明、摩肩接踵。数百种清真小吃荟萃于此，是西安的美食心脏。",
    image: "https://pixabay.com/get/g2bf415f15e7724c701c9a8ee1616494dd47c66b565439b95382f22e3a51fb3a551ec4a62f2e5d903ebdfda61843cede6_1920.jpg",
    photos: [
      { emoji: "🏮", title: "北院门牌坊夜景", desc: "晚7点亮灯后站在北院门入口牌坊前，低角度仰拍牌坊+灯笼阵列，人物居中走拍更有烟火气" },
      { emoji: "🍢", title: "西羊市美食摊位", desc: "西羊市中段最热闹，站到摊位侧面用1x拍食物特写，让店主操作的手入镜增加生动感" },
      { emoji: "🎎", title: "大皮院古巷人文", desc: "大皮院上午人少，青砖灰瓦+老人在门口晒太阳，用黑白滤镜拍出老西安的静谧时光" },
      { emoji: "🎪", title: "化觉巷清真大寺", desc: "隐藏在回坊深处的明代清真寺，融合中式建筑风格，庭院对称构图+光影斑驳极出片" }
    ],
    tips: [
      "🕐最佳时间：下午4-7点光线好、人不太挤",
      "🍜必吃：老米家泡馍、定家小酥肉、东南亚甑糕",
      "⚠️注意：街口揽客的毛笔酥店大多是坑，往里走找老店"
    ]
  },
  "西安城墙": {
    intro: "西安城墙是中国现存规模最大、保存最完整的古代城垣，全长13.74公里。建于明洪武年间，距今600余年。城墙上可以骑行、跑步，俯瞰古城内外截然不同的风貌。",
    image: "https://pixabay.com/get/g4005597eecfab5f09c13960db6b81ee063aa60231241ba6696974e2cadd20c7cbf3fe639a5ae4480dcab297a6f9a45af_1920.jpg",
    photos: [
      { emoji: "🚲", title: "永宁门城楼骑行位", desc: "在南门（永宁门）段租自行车，让同伴在城楼前骑行，用追焦模式拍出动态感" },
      { emoji: "🌇", title: "南门日落全景", desc: "傍晚在永宁门西侧城墙上，拍夕阳下的钟楼+南大街天际线，城市新旧同框" },
      { emoji: "🏮", title: "城墙新春灯会", desc: "春节期间城墙有大型灯会，红灯笼+城墙夜拍，从南门外广场长焦拍城楼+灯组" },
      { emoji: "📐", title: "城墙角楼对称", desc: "城墙四角角楼飞檐翘角，站护城河对岸用广角拍角楼倒映水中的对称画面" }
    ],
    tips: [
      "🎫门票54元，学生半价，多个城门可登城",
      "🚲租自行车单人45元/双人90元，骑行一圈约1.5小时",
      "🌅推荐南门（永宁门）登城，下午4点上去拍日落",
      "👟建议从南门骑到西门段，人少风景好"
    ]
  },
  "华清宫": {
    intro: "华清宫背靠骊山，建于唐玄宗时期，是杨贵妃沐浴的皇家温泉行宫。'春寒赐浴华清池，温泉水滑洗凝脂'说的就是这里。园内亭台楼阁依山而建，温泉雾气氤氲。",
    image: "https://pixabay.com/get/gc6676050a5842d71722745aeb227a1b7ebf32b9f2eb4f5c77539244d7cf0875679923b6415f23abfb9ed3b1d0a78a3ec_1920.jpg",
    photos: [
      { emoji: "🏯", title: "九龙湖贵妃出浴雕像", desc: "九龙湖畔杨贵妃雕像前的荷花池，清晨薄雾+雕像倒影，手机用人像模式虚化背景" },
      { emoji: "🌿", title: "芙蓉园汤池遗址", desc: "海棠汤（贵妃池）遗址，从高处俯拍温泉池的莲花形轮廓，光影交错有历史穿越感" },
      { emoji: "⛰️", title: "骊山晚照全景", desc: "登上骊山半山腰，下午5点拍'骊山晚照'——夕阳把山体染成金色，山脚华清宫尽收眼底" },
      { emoji: "🏮", title: "长生殿夜拍", desc: "晚上华清宫有《长恨歌》实景演出，长生殿灯光亮起时以骊山为背景，恢弘大气" }
    ],
    tips: [
      "🎫门票120元，《长恨歌》演出另购票（约300元起）",
      "🚌西安火车站东广场坐游5路直达，与兵马俑一条线",
      "🌅建议上午去兵马俑，下午华清宫，傍晚看骊山晚照",
      "♨️景区内有温泉体验区，可以真正泡一次皇家温泉"
    ]
  },
  "大唐不夜城": {
    intro: "大唐不夜城是以盛唐文化为主题的步行街，北起大雁塔南广场，全长2.1公里。华灯初上时，仿唐建筑金碧辉煌。不倒翁小姐姐、石头人、盛唐密盒等街头表演让这里成为夜西安的顶流。",
    image: "https://pixabay.com/get/gdd79b39ac19a82832196f7a04184b8c183fe6d97a265371156be1df5f04409d316275598e94194a601635b64b8fbcf2b_1920.jpg",
    photos: [
      { emoji: "🌃", title: "中轴线对称全景", desc: "在大唐不夜城中段，站路中央安全岛拍南北对称轴线，两侧仿唐建筑+灯笼阵列纵深极强" },
      { emoji: "🎭", title: "不倒翁小姐姐互动", desc: "演出时段（约晚7-9点），用连拍模式抓拍小姐姐与观众牵手瞬间，侧45度角动感最佳" },
      { emoji: "🏛️", title: "贞观广场李世民像", desc: "从广场入口拍唐太宗骑马雕塑与远处大雁塔同框，广角仰拍增强气势" },
      { emoji: "💡", title: "芙蓉园灯组色彩", desc: "靠近各主题灯组用1x拍色彩斑斓的装置细节，夜间色彩溢出效果极佳" }
    ],
    tips: [
      "🌙晚上7点亮灯后才精彩，白天不要去！",
      "🚇地铁3/4号线大雁塔站B口出，近北入口",
      "👀必看：不倒翁、盛唐密盒、石头人（晚7-9点轮演）",
      "👘沿街有汉服变装店，穿唐装逛不夜城出片率200%"
    ]
  },
  "陕西历史博物馆": {
    intro: "陕西历史博物馆被誉为「古都明珠，华夏宝库」，馆藏文物171万余件。商周青铜器、汉唐金银器、历代陶俑等举世闻名。基本陈列免费但需预约，是了解西安千年历史的最佳入口。",
    image: "https://pixabay.com/get/gc7dd800f39ae014fb789785d2c6e860eea6c758641487adbc476b4262510a5678d0cdccc8f69228ca592f42e1cef99a7_1920.jpg",
    photos: [
      { emoji: "🏛️", title: "博物馆正门对称构图", desc: "陕博建筑本身是仿唐风格，正门前广场低角度广角拍摄，蓝天白云下气势恢宏" },
      { emoji: "🏺", title: "何家村窖藏金银器", desc: "在何家村遗宝展厅，用3x拍金银器细节，展柜光线足，手机也能拍出金属质感" },
      { emoji: "🐎", title: "唐三彩载乐骆驼", desc: "唐代展厅的镇馆之宝，从展柜侧面拍骆驼+乐俑全貌，避开反光是关键" },
      { emoji: "🗿", title: "秦代兵马俑展厅", desc: "陕博也有兵马俑精品，展柜光线比兵马俑博物馆好，适合拍细节" }
    ],
    tips: [
      "🎫免费但需提前预约！（微信搜'陕西历史博物馆'预约）",
      "⏰火爆！建议提前3-7天预约，节假日尤其紧张",
      "📷馆内可拍照但禁止闪光灯，手机静音拍摄",
      "🎧租讲解器30元或下载三毛游APP自助导览"
    ]
  },
  "小雁塔": {
    intro: "小雁塔建于唐景龙年间（707年），比大雁塔晚55年。现存13层，因地震塔顶塌落两层面形成独特的残缺美感。园内古木参天，环境清幽，是游客较少的小众宝藏景点。",
    image: "https://pixabay.com/get/gcdfe30989f7858ec2b8538a4ab3510cd0266653ea871f40f2e7c0f53bef03a138e34b9d3673fb177a67461027ca0bb0d_1920.jpg",
    photos: [
      { emoji: "🌳", title: "古槐掩映塔身", desc: "小雁塔东南侧有几棵千年古槐，用树叶作前景框架拍塔身，春夏绿意葱茏、秋冬色彩斑斓" },
      { emoji: "🔔", title: "雁塔晨钟意境", desc: "园内有'关中八景'之一的雁塔晨钟，上午9点前光线柔和，古钟+塔同框意境悠远" },
      { emoji: "🏚️", title: "塔顶残缺特写", desc: "从西南角仰拍塔顶断截面，逆光时残缺轮廓极具历史沧桑感" },
      { emoji: "🌸", title: "春日樱花拱门", desc: "每年3月底-4月初园内樱花盛开，以樱花枝为前景拍塔身，小清新风格满分" }
    ],
    tips: [
      "🎫免费！凭身份证领票，人比大雁塔少很多",
      "🌸春天樱花季是最佳拍摄时间，游客少花又多",
      "🏛️隔壁就是西安博物院，一并游览大约2小时",
      "🚇地铁2号线南稍门站步行5分钟"
    ]
  },
  "大明宫国家遗址公园": {
    intro: "大明宫曾是唐代最宏伟的宫殿建筑群，面积是北京故宫的4.5倍。'九天阊阖开宫殿，万国衣冠拜冕旒'描绘的就是这里的盛况。如今遗址公园绿草如茵，微缩景观复原了当年的壮丽。",
    image: "https://pixabay.com/get/g2932a587f15bbd3081aae15e19ee38ba87eda329983ad56c731775de25b9de08f43383f37e4a5dbc1da60b686bb00a26_1920.jpg",
    photos: [
      { emoji: "🏛️", title: "丹凤门遗址剪影", desc: "从丹凤门正面低角度仰拍，以天空为背景拍城门轮廓剪影，日落时分尤其壮美" },
      { emoji: "🌿", title: "含元殿遗址草坪", desc: "含元殿遗址前的巨大草坪，用超广角拍人物走在草地上，与远处微缩宫殿呼应" },
      { emoji: "🏗️", title: "微缩景观俯拍", desc: "大明宫微缩景观区，手机举高俯拍1:15的唐代宫殿模型，像无人机航拍大片" },
      { emoji: "🌅", title: "太液池日落倒影", desc: "太液池边拍含凉殿倒影，黄昏时刻水面如镜，落日余晖染红宫殿轮廓" }
    ],
    tips: [
      "🎫遗址公园免费，核心区+微缩景观60元",
      "🚇地铁4号线含元殿站B口出即到丹凤门",
      "🚲公园超大！建议租电瓶车或自行车游览",
      "🌿适合野餐+拍照，带块野餐布在含元殿前草坪躺平"
    ]
  }
};

// Fallback guide for unknown spots
function getSpotGuide(name) {
  if (SPOT_GUIDES[name]) return SPOT_GUIDES[name];
  for (const key of Object.keys(SPOT_GUIDES)) {
    if (name.includes(key) || key.includes(name)) return SPOT_GUIDES[key];
  }
  // 尝试从高德缓存获取照片
  let amapImg = '';
  if (_cachedSpots) {
    const match = _cachedSpots.find(s => s.name === name || name.includes(s.name) || s.name.includes(name));
    if (match && match.photo && match.photo.length > 0) amapImg = match.photo[0];
  }
  return {
    intro: name + '是西安值得一游的地方，无论是拍照打卡还是深度游览，都能感受到古城独有的魅力。建议提前做好攻略，合理安排时间。',
    image: amapImg || '',
    photos: [
      { emoji: "\uD83D\uDCF8", title: "全景构图", desc: "站在景点正前方取全景，低角度仰拍能增加建筑的气势感，广角模式更出片" },
      { emoji: "\uD83C\uDF05", title: "黄金时刻", desc: "日出后1小时或日落前1小时拍摄，光线最柔和，色彩最丰富，阴影也有层次" },
      { emoji: "\uD83D\uDD0D", title: "细节特写", desc: "找有特色的纹理、图案或角落单独构图，一组细节照能大大丰富图集的可看性" },
      { emoji: "\uD83D\uDC65", title: "人文互动", desc: "加入当地人的生活画面或自己的旅行身影，让照片有故事感而不是简单的打卡照" }
    ],
    tips: [
      "\u5C0F\u516B\u5EFA\u8BAE\uFF1A\u65E9\u53BB\u4EBA\u5C11\uFF0C\u62CD\u7167\u4E0D\u6324\u8FD8\u5B89\u9759",
      "\u8DDF\u7740\u5C0F\u516B\u7684\u653B\u7565\u670D\u52A1\uFF0C\u53D1\u73B0\u66F4\u591A\u9690\u85CF\u7F8E\u666F\u548C\u7F8E\u98DF",
      "\u62CD\u5B8C\u8BB0\u5F97\u628A\u7167\u7247\u4E0A\u4F20\u5230\u56FE\u96C6\uFF0C\u4E00\u952E\u751F\u6210\u65C5\u884C\u6D77\u62A5"
    ]
  };
}

// =============================================
// GUIDE MODAL
// =============================================
function openGuide(name) {
  const guide = getSpotGuide(name);
  document.getElementById('guide-title').textContent = name + ' · 打卡攻略';

  var heroImg = document.getElementById('guide-hero-img');
  if (guide.image) { heroImg.src = guide.image; heroImg.style.display = 'block'; } else { heroImg.style.display = 'none'; }
  document.getElementById('guide-intro-text').textContent = guide.intro || '';

  var grid = document.getElementById('guide-photo-grid');
  grid.innerHTML = guide.photos.map(function(p) {
    return '<div class="guide-photo-card"><div class="p-emoji">' + p.emoji + '</div><div class="p-title">' + p.title + '</div><div class="p-desc">' + p.desc + '</div></div>';
  }).join('');
  
  const tipSec = document.getElementById('guide-tip-section');
  tipSec.innerHTML = '<h4>\uD83D\uDCA1 \u5C0F\u516B\u7279\u522B\u63D0\u793A</h4>' + 
    guide.tips.map((t, i) => `
    <div class="guide-tip-item">
      <div class="t-num">${i+1}</div>
      <div>${t}</div>
    </div>`).join('') +
    `<div style="margin:16px 20px;padding:14px;background:#FFF8F0;border-radius:10px;font-size:12px;color:#666;">
      <strong style="color:var(--primary);">\uD83D\uDCF7 \u62CD\u5B8C\u7167\u4E0A\u4F20\u5230\u56FE\u96C6</strong><br>
      \u70B9\u4E0B\u65B9\u300C\u56FE\u96C6\u300D\u6309\u94AE\uFF0C\u628A\u4F60\u5728${name}\u62CD\u7684\u7167\u7247\u6DFB\u52A0\u8FDB\u6765\uFF0C\u6700\u540E\u751F\u6210\u4E13\u5C5E\u65C5\u884C\u6D77\u62A5\u5206\u4EAB\u670B\u53CB\u5708\uFF01
    </div>`;
  
  document.getElementById('guide-overlay').classList.add('show');
}

function closeGuide(e) {
  if (!e || e.target === document.getElementById('guide-overlay')) {
    document.getElementById('guide-overlay').classList.remove('show');
  }
}

// =============================================
// GALLERY (local-only, saves to localStorage)
// =============================================
let galleryPhotos = JSON.parse(localStorage.getItem('xiaoba_gallery') || '[]');

function openGallery() {
  renderGalleryGrid();
  document.getElementById('gallery-overlay').classList.add('show');
}

function closeGallery() {
  document.getElementById('gallery-overlay').classList.remove('show');
}

function renderGalleryGrid() {
  const grid = document.getElementById('gallery-grid');
  let html = '';
  
  if (galleryPhotos.length === 0) {
    html += '<div class="gallery-empty">\uD83D\uDCF7<br>\u8FD8\u6CA1\u6709\u7167\u7247<br>\u70B9\u51FB + \u4E0A\u4F20\u65C5\u884C\u7167\u7247</div>';
  } else {
    galleryPhotos.forEach((photo, i) => {
      html += `<div class="gallery-item" id="gitem-${i}">
        <img src="${photo.dataUrl}" alt="${photo.name||''}">
        <button class="del-btn" onclick="deletePhoto(${i})">\u2715</button>
      </div>`;
    });
  }
  html += `<div class="gallery-upload" onclick="triggerPhotoUpload()">
    <div class="plus">+</div>
    <div>\u6DFB\u52A0\u7167\u7247</div>
  </div>`;
  
  grid.innerHTML = html;
}

function triggerPhotoUpload() {
  document.getElementById('photo-input').click();
}

function handlePhotoUpload(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  
  let loaded = 0;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      galleryPhotos.push({
        dataUrl: e.target.result,
        name: file.name,
        spot: '\u65C5\u9014\u4E2D',
        time: new Date().toLocaleString('zh-CN')
      });
      loaded++;
      if (loaded === files.length) {
        localStorage.setItem('xiaoba_gallery', JSON.stringify(galleryPhotos));
        renderGalleryGrid();
        toast('\u5DF2\u6DFB\u52A0 ' + loaded + ' \u5F20\u7167\u7247');
      }
    };
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function deletePhoto(idx) {
  galleryPhotos.splice(idx, 1);
  localStorage.setItem('xiaoba_gallery', JSON.stringify(galleryPhotos));
  renderGalleryGrid();
}

// =============================================
// SHARE POSTER (Canvas)
// =============================================
function genSharePoster() {
  if (galleryPhotos.length === 0) {
    toast('\u8BF7\u5148\u6DFB\u52A0\u7167\u7247\uFF01');
    return;
  }
  const canvas = document.getElementById('poster-canvas');
  const ctx = canvas.getContext('2d');
  const W = 340, H = 500;
  canvas.width = W; canvas.height = H;
  
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0, '#1A0A06');
  grad.addColorStop(1, '#4A2218');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  
  ctx.fillStyle = '#FFD700';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('\u5C0F\u516B\u5E26\u6211\u6E38\u897F\u5B89', W/2, 36);
  
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '12px sans-serif';
  const planTitle = document.getElementById('res-title') ? document.getElementById('res-title').textContent : '\u4E13\u5C5E\u8DEF\u7EBF';
  ctx.fillText(planTitle, W/2, 56);
  
  const photos = galleryPhotos.slice(0, 4);
  const drawPhotos = () => {
    const gridW = W - 32;
    const cols = photos.length >= 2 ? 2 : 1;
    const rows = Math.ceil(photos.length / cols);
    const cellW = gridW / cols;
    const cellH = 180 / rows;
    
    let loaded = 0;
    photos.forEach((p, i) => {
      const img = new Image();
      img.onload = () => {
        const col = i % cols, row = Math.floor(i / cols);
        const x = 16 + col * cellW, y = 72 + row * cellH;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x+2, y+2, cellW-4, cellH-4, 6);
        ctx.clip();
        const scale = Math.max(cellW/img.width, cellH/img.height);
        const dw = img.width*scale, dh = img.height*scale;
        ctx.drawImage(img, x + (cellW-dw)/2, y + (cellH-dh)/2, dw, dh);
        ctx.restore();
        loaded++;
        if (loaded === photos.length) drawPosterBottom();
      };
      img.onerror = () => { loaded++; if (loaded === photos.length) drawPosterBottom(); };
      img.src = p.dataUrl;
    });
  };
  
  const drawPosterBottom = () => {
    const yBase = 270;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.roundRect(16, yBase, W-32, 110, 10);
    ctx.fill();
    
    ctx.fillStyle = '#FFD700';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('\uD83D\uDDD3 \u884C\u7A0B\u4EAE\u70B9', 30, yBase+22);
    
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '11px sans-serif';
    const metaEl = document.getElementById('res-meta');
    const metaText = metaEl ? metaEl.innerText.replace(/\n/g, '  ') : '';
    ctx.fillText(metaText.substring(0,40), 30, yBase+40);
    
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('\uD83D\uDCF7 \u5171 ' + galleryPhotos.length + ' \u5F20\u65C5\u884C\u7167\u7247', 30, yBase+60);
    
    ctx.fillText('\uD83D\uDCC5 ' + new Date().toLocaleDateString('zh-CN'), 30, yBase+80);
    
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.roundRect(W-80, yBase+5, 60, 60, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('\u626B\u7801', W-50, yBase+35);
    ctx.fillText('\u89C4\u5212\u8DEF\u7EBF', W-50, yBase+50);
    
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('\u5C0F\u516B\u4F34\u6E38 \u00B7 \u897F\u5B8914\u5E74\u571F\u8457 \u00B7 AI\u4E13\u5C5E\u8DEF\u7EBF\u89C4\u5212', W/2, H-20);
    
    ctx.strokeStyle = 'rgba(255,215,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(16, H-35);
    ctx.lineTo(W-16, H-35);
    ctx.stroke();
    
    document.getElementById('poster-overlay').classList.add('show');
  };
  
  drawPhotos();
}

function closePoster() {
  document.getElementById('poster-overlay').classList.remove('show');
}

// ===== GPS定位 + Haversine距离 + 高德API实时数据 =====
let _userPosition = null;

function getUserPosition() {
  return new Promise((resolve) => {
    if (_userPosition) { resolve(_userPosition); return; }
    if (!navigator.geolocation) {
      _userPosition = { lat: 34.2594, lng: 108.9480 }; // 默认钟楼
      resolve(_userPosition);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _userPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        resolve(_userPosition);
      },
      () => {
        _userPosition = { lat: 34.2594, lng: 108.9480 };
        resolve(_userPosition);
      },
      { timeout: 5000, enableHighAccuracy: true }
    );
  });
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(km) {
  if (km < 1) return Math.round(km * 1000) + 'm';
  if (km < 10) return km.toFixed(1) + 'km';
  return Math.round(km) + 'km';
}

// ===== 高德天气API =====
async function fetchWeather() {
  try {
    const widget = document.getElementById('weather-widget');
    if (!widget) return;
    
    // 先用预报(all)获取4天数据
    let resp = await fetch(`${AMAP_BASE}/weather/weatherInfo?key=${AMAP_KEY}&city=610100&extensions=all`);
    let data = await resp.json();
    
    if (data.status === '1' && data.forecasts && data.forecasts.length && data.forecasts[0].casts.length) {
      const f = data.forecasts[0];
      const today = f.casts[0];
      const weatherIcon = {
        '晴': '☀️', '少云': '🌤️', '晴间多云': '⛅', '多云': '☁️',
        '阴': '☁️', '小雨': '🌧️', '中雨': '🌧️', '大雨': '⛈️', '暴雨': '⛈️',
        '小雪': '🌨️', '中雪': '🌨️', '大雪': '❄️', '雨夹雪': '🌨️',
        '雾': '🌫️', '霾': '🌫️', '风': '💨', '扬沙': '💨'
      };
      const icon = weatherIcon[today.dayweather] || '🌤️';
      let fcHtml = '';
      f.casts.slice(0, 4).forEach(d => {
        fcHtml += `<div class="wf-day"><span class="wf-icon">${weatherIcon[d.dayweather]||'🌤️'}</span><span class="wf-temp">${d.nighttemp}~${d.daytemp}°</span>${d.date===today.date?'今天':d.week}</div>`;
      });
      widget.innerHTML = `
        <div class="weather-main">
          <span class="weather-icon">${icon}</span>
          <div>
            <span class="weather-temp">${today.daytemp}°</span>
            <span class="weather-desc">${today.dayweather}转${today.nightweather} · ${today.daypower}级风</span>
            <div class="weather-info">📍 ${f.province}${f.city} · 发布: ${(f.reporttime||'').split(' ')[1] || ''}</div>
          </div>
        </div>
        <div class="weather-forecast">${fcHtml}</div>`;
      return;
    }
    
    // 降级到实时天气(base)
    resp = await fetch(`${AMAP_BASE}/weather/weatherInfo?key=${AMAP_KEY}&city=610100&extensions=base`);
    data = await resp.json();
    if (data.status === '1' && data.lives && data.lives.length) {
      const w = data.lives[0];
      const weatherIcon = { '晴': '☀️', '少云': '🌤️', '多云': '☁️', '阴': '☁️', '雨': '🌧️', '雪': '❄️' };
      let icon = '🌤️';
      for (const [k, v] of Object.entries(weatherIcon)) { if (w.weather.includes(k)) { icon = v; break; } }
      widget.innerHTML = `
        <div class="weather-main">
          <span class="weather-icon">${icon}</span>
          <div>
            <span class="weather-temp">${w.temperature}°</span>
            <span class="weather-desc">${w.weather} · ${w.winddirection}风${w.windpower}级</span>
            <div class="weather-info">📍 ${w.province}${w.city} · 💧 ${w.humidity}% · 实时</div>
          </div>
        </div>`;
    }
  } catch (e) { /* 静默 */ }
}

fetchWeather();

async function fetchAmapPOIs(keywords, type, city, offset, needPhotos) {
  const ext = needPhotos ? 'all' : 'base';
  const kw = encodeURIComponent(keywords);
  const ct = encodeURIComponent(city || '西安');
  const apiUrl = `${AMAP_BASE}/place/text?key=${AMAP_KEY}&keywords=${kw}&city=${ct}&offset=${offset||15}&extensions=${ext}`;
  if (type) apiUrl += '&types=' + encodeURIComponent(type);
  
  try {
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    if (data.status === '1' && data.pois && data.pois.length > 0) return data.pois;
    return [];
  } catch (e) {
    console.error('高德API请求失败:', e);
    return [];
  }
}

async function fetchAmapAround(keywords, type, lat, lng, radius, offset, needPhotos) {
  const ext = needPhotos ? 'all' : 'base';
  const kw = encodeURIComponent(keywords);
  const loc = `${lng},${lat}`;
  let apiUrl = `${AMAP_BASE}/place/around?key=${AMAP_KEY}&keywords=${kw}&location=${loc}&radius=${radius||3000}&offset=${offset||20}&extensions=${ext}`;
  if (type) apiUrl += '&types=' + encodeURIComponent(type);
  
  try {
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    if (data.status === '1' && data.pois && data.pois.length > 0) return data.pois;
    return [];
  } catch (e) {
    console.error('高德周边搜索失败:', e);
    return [];
  }
}

function amapPoiToFoodItem(poi, userLat, userLng) {
  const dist = haversineDistance(userLat, userLng, parseFloat(poi.location.split(',')[1]), parseFloat(poi.location.split(',')[0]));
  const biz = poi.biz_ext || {};
  return {
    name: poi.name || '未知美食',
    area: poi.address || poi.business_area || '附近',
    desc: biz.recommend || poi.type || '高德推荐',
    price: biz.cost ? '¥' + biz.cost + '/人' : '¥—',
    coord: poi.location || '',
    cat: typeNameToCat(poi.type || ''),
    dist: formatDistance(dist),
    amapId: poi.id || '',
    rating: biz.rating || '',
    photos: (poi.photos && poi.photos.length) ? poi.photos.map(p => p.url) : [],
    tel: poi.tel || '',
    openTime: biz.opentime2 || '',
    website: safeWebsite(poi.website),
    keytag: poi.keytag || '',
    businessArea: poi.business_area || '',
    recommend: poi.recommend || '',
    discountNum: poi.discount_num || '0',
    groupbuyNum: poi.groupbuy_num || '0',
    cityname: poi.cityname || '',
    adname: poi.adname || ''
  };
}

function amapPoiToSpotItem(poi, userLat, userLng) {
  const dist = haversineDistance(userLat, userLng, parseFloat(poi.location.split(',')[1]), parseFloat(poi.location.split(',')[0]));
  const biz = poi.biz_ext || {};
  return {
    name: poi.name || '未知景点',
    dist: formatDistance(dist),
    desc: biz.introduction || poi.address || '高德推荐景点',
    coord: poi.location || '',
    gaodeUid: poi.id || '',
    amapId: poi.id || '',
    rating: biz.rating || '',
    tel: poi.tel || '',
    photos: (poi.photos && poi.photos.length) ? poi.photos.map(p => p.url) : [],
    address: poi.address || '',
    openTime: biz.opentime2 || '',
    ticketOrdering: biz.ticket_ordering || '0',
    website: safeWebsite(poi.website),
    keytag: poi.keytag || '',
    businessArea: poi.business_area || '',
    recommend: poi.recommend || '',
    discountNum: poi.discount_num || '0',
    groupbuyNum: poi.groupbuy_num || '0',
    cityname: poi.cityname || '',
    adname: poi.adname || '',
    bizType: poi.biz_type || '',
    alias: poi.alias || ''
  };
}

function amapPoiToHotelItem(poi, userLat, userLng) {
  const dist = haversineDistance(userLat, userLng, parseFloat(poi.location.split(',')[1]), parseFloat(poi.location.split(',')[0]));
  const biz = poi.biz_ext || {};
  const cat = hotelTypeFromStar(biz.star || '');
  return {
    name: poi.name || '未知酒店',
    dist: formatDistance(dist),
    desc: poi.address || '高德推荐酒店',
    price: hotelPriceFromStar(biz.star || ''),
    origPrice: hotelOrigPriceFromStar(biz.star || ''),
    coord: poi.location || '',
    cat: cat,
    amapId: poi.id || '',
    rating: biz.rating || '',
    tel: poi.tel || '',
    photos: (poi.photos && poi.photos.length) ? poi.photos.map(p => p.url) : [],
    link: `https://uri.amap.com/detail?poiid=${poi.id || ''}`,
    address: poi.address || '',
    website: safeWebsite(poi.website),
    keytag: poi.keytag || '',
    businessArea: poi.business_area || '',
    recommend: poi.recommend || '',
    discountNum: poi.discount_num || '0',
    groupbuyNum: poi.groupbuy_num || '0',
    openTime: biz.opentime2 || '',
    star: biz.star || '',
    cityname: poi.cityname || '',
    adname: poi.adname || ''
  };
}

// 安全提取website字段（高德API可能返回数组或字符串）
function safeWebsite(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0] || '';
  return '';
}

// ===== 统一多图渲染辅助 =====
function renderPhotoGallery(photos, fallbackSvg, name) {
  if (!photos || photos.length === 0) return `<img src="${fallbackSvg}" alt="${name}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy" onerror="this.src='${fallbackSvg}'">`;
  if (photos.length === 1) return `<img src="${photos[0]}" alt="${name}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy" onerror="this.src='${fallbackSvg}'">`;
  // 多图：点选轮播
  let dots = '', imgs = '';
  photos.forEach((url, i) => {
    const display = i === 0 ? 'block' : 'none';
    imgs += `<img src="${url}" alt="${name}(${i+1})" class="gallery-img" data-idx="${i}" style="width:100%;height:100%;object-fit:cover;display:${display};position:absolute;top:0;left:0;" loading="lazy" onerror="this.style.display='none';this.parentElement.querySelector('.gallery-dot:nth-child(${i+1})')&&(this.parentElement.querySelector('.gallery-dot:nth-child(${i+1})').style.display='none')">`;
    dots += `<span class="gallery-dot" data-idx="${i}" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${i===0?'#fff':'rgba(255,255,255,0.5)'};margin:0 2px;cursor:pointer;" onclick="switchGalleryPhoto(this,${i},'${name}')"></span>`;
  });
  return `<div style="position:relative;width:100%;height:100%;">${imgs}<div style="position:absolute;bottom:5px;left:0;right:0;text-align:center;z-index:2;">${dots}</div></div>`;
}

function switchGalleryPhoto(dot, idx, name) {
  const container = dot.parentElement.parentElement;
  const imgs = container.querySelectorAll('.gallery-img');
  const dots = container.querySelectorAll('.gallery-dot');
  imgs.forEach((img, i) => { img.style.display = i === idx ? 'block' : 'none'; });
  dots.forEach((d, i) => { d.style.background = i === idx ? '#fff' : 'rgba(255,255,255,0.5)'; });
}

function typeNameToCat(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('中餐') || t.includes('火锅') || t.includes('川菜') || t.includes('湘菜') || t.includes('粤菜') || t.includes('东北') || t.includes('西北') || t.includes('清真'))
    return '陕菜经典';
  if (t.includes('小吃') || t.includes('快餐') || t.includes('面食') || t.includes('米线') || t.includes('包子') || t.includes('饺子'))
    return '回坊小吃';
  if (t.includes('面包') || t.includes('咖啡') || t.includes('茶') || t.includes('甜点') || t.includes('糕点'))
    return '面食天堂';
  if (t.includes('烧烤') || t.includes('烤肉') || t.includes('串') || t.includes('夜市') || t.includes('大排档'))
    return '夜市烧烤';
  return '回坊小吃';
}

function hotelTypeFromStar(star) {
  if (!star || star === '') return '经济连锁';
  const s = parseInt(star) || 0;
  if (s >= 5) return '高档型';
  if (s >= 4) return '高档型';
  if (s >= 3) return '舒适型';
  return '经济连锁';
}

function hotelPriceFromStar(star) {
  const prices = { '5': '688', '4': '388', '3': '258', '2': '168', '1': '128', '': '198' };
  return prices[star] || '198';
}

function hotelOrigPriceFromStar(star) {
  const prices = { '5': '1288', '4': '688', '3': '388', '2': '258', '1': '198', '': '288' };
  return prices[star] || '288';
}

function fallbackFoodSVG(name) {
  return foodSVG('回坊小吃');
}

function spotFallbackSVG(name) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs><linearGradient id="sfg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E8453C"/><stop offset="100%" stop-color="#F09080"/></linearGradient></defs>
  <rect width="200" height="200" rx="12" fill="url(#sfg)"/>
  <text x="100" y="95" text-anchor="middle" font-size="52">🏛️</text>
  <text x="100" y="150" text-anchor="middle" font-size="18" fill="white" font-weight="bold" style="text-shadow:0 1px 3px rgba(0,0,0,.3)">${name}</text>
</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function photoCellHtml(poi, fallbackSvg) {
  const photoUrl = poi.photos && poi.photos.length ? poi.photos[0].url : null;
  if (photoUrl) {
    return `<img src="${photoUrl}" alt="${poi.name}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><div class="photo-fallback" style="display:none;width:100%;height:100%"><img src="${fallbackSvg}" style="width:100%;height:100%;object-fit:cover"></div>`;
  }
  return `<img src="${fallbackSvg}" style="width:100%;height:100%;object-fit:cover">`;
}

// ===== 本地人美食弹窗（分类图片）=====
const FOOD_CAT_STYLE = {
  '陕菜经典': { icon:'🍲', c1:'#D4782F', c2:'#F0C080', emoji:'🥢' },
  '回坊小吃': { icon:'🥙', c1:'#C84B31', c2:'#F09080', emoji:'🍢' },
  '面食天堂': { icon:'🍜', c1:'#B8860B', c2:'#F0D878', emoji:'🫓' },
  '夜市烧烤': { icon:'🍖', c1:'#5D4037', c2:'#A08070', emoji:'🔥' }
};

function foodSVG(cat) {
  const s = FOOD_CAT_STYLE[cat] || { icon:'🍴', c1:'#9E9E9E', c2:'#E0E0E0', emoji:'🍽️' };
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="fg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${s.c1}"/><stop offset="100%" stop-color="${s.c2}"/></linearGradient></defs><rect width="200" height="200" rx="12" fill="url(#fg)"/><text x="100" y="95" text-anchor="middle" font-size="52">${s.emoji}</text><text x="100" y="150" text-anchor="middle" font-size="20" fill="white" font-weight="bold" style="text-shadow:0 1px 3px rgba(0,0,0,.3)">${cat}</text></svg>`)}`;
}

const LOCAL_FOODS = [
  // 陕菜经典
  { cat:'陕菜经典', name:'德发长饺子宴', area:'钟楼附近', desc:'百年老字号，饺子花样上百种，本地人招待贵客首选', price:'¥60/人', coord:'108.948,34.261' },
  { cat:'陕菜经典', name:'西安饭庄', area:'东大街', desc:'陕菜头牌，葫芦鸡一绝，周恩来总理曾在此宴请外宾', price:'¥90/人', coord:'108.957,34.260' },
  { cat:'回坊小吃', name:'回坊老赵家腊牛肉夹馍', area:'回民街深处', desc:'肉多得往外掉，肥瘦相间，汁水多到滴一手，本地人排队常态', price:'¥18/人', coord:'108.946,34.265' },
  { cat:'回坊小吃', name:'马家灌汤包子', area:'大皮院', desc:'皮薄汤多，先咬一小口吸汤再吃，烫嘴也舍不得停', price:'¥22/人', coord:'108.943,34.264' },
  { cat:'回坊小吃', name:'杨家粉蒸肉', area:'北院门', desc:'牛肉裹粉蒸得软糯入味，夹在荷叶饼里一口闷，香得很', price:'¥20/人', coord:'108.942,34.267' },
  { cat:'回坊小吃', name:'花奶奶酸梅汤', area:'回民街主街', desc:'熬出来的酸梅汤和冲调的不是一回事，加醪糟更是一绝', price:'¥8/人', coord:'108.945,34.263' },
  { cat:'面食天堂', name:'老马家肉丸胡辣汤', area:'洒金桥', desc:'手打牛肉丸Q弹，麻辣味儿正，配上锅盔绝了，大清早就排长队', price:'¥12/人', coord:'108.940,34.268' },
  { cat:'面食天堂', name:'秦镇米皮老店', area:'高新区秦镇', desc:'米皮薄如纸，红油辣子香而不燥，夏天来一碗爽翻', price:'¥10/人', coord:'108.845,34.196' },
  { cat:'面食天堂', name:'刘记水盆羊肉', area:'南稍门', desc:'汤清肉烂，月牙饼掰碎了泡进去，再来瓣蒜，额能连吃三碗', price:'¥28/人', coord:'108.939,34.248' },
  { cat:'夜市烧烤', name:'小东门梆梆肉', area:'朝阳门里', desc:'熏制大肠和猪肚，铁锅柴火熏得焦香四溢，配啤酒一绝', price:'¥35/人', coord:'108.960,34.266' },
  { cat:'夜市烧烤', name:'马峰烤肉', area:'小南门', desc:'只在晚上出摊，羊肉串嫩到不行，排队半小时也值', price:'¥40/人', coord:'108.937,34.258' },
];

const FOOD_CATEGORIES = ['全部', '陕菜经典', '回坊小吃', '面食天堂', '夜市烧烤'];
let foodActiveCat = '全部';

function openLocalFood() {
  // 免费功能：无需支付即可浏览
  // 渲染分类标签
  let catHtml = '';
  FOOD_CATEGORIES.forEach(c => {
    catHtml += `<div class="cat-tab${c===foodActiveCat?' active':''}" onclick="filterFoodCat('${c}')">${c}</div>`;
  });
  document.getElementById('food-cat-tabs').innerHTML = catHtml;
  renderFoodList();
  document.getElementById('food-overlay').classList.add('show');
}

function filterFoodCat(cat) {
  foodActiveCat = cat;
  document.querySelectorAll('#food-cat-tabs .cat-tab').forEach(t => {
    t.classList.toggle('active', t.textContent === cat);
  });
  renderFoodList();
}

let _cachedFoods = null;

async function renderFoodList() {
  const list = document.getElementById('food-list');
  list.innerHTML = '<p style="text-align:center;color:#999;padding:30px;">📡 正在从高德获取附近真实美食...</p>';
  
  try {
    if (!_cachedFoods) {
      const pos = await getUserPosition();
      const rawPois = await fetchAmapAround('美食|小吃|陕菜|羊肉泡馍|肉夹馍', '餐饮服务', pos.lat, pos.lng, 5000, 30, true);
      _cachedFoods = rawPois.map(p => amapPoiToFoodItem(p, pos.lat, pos.lng));
    }
  } catch (e) { /* fallback to static */ }
  
  const sourceData = (_cachedFoods && _cachedFoods.length > 0) ? _cachedFoods : LOCAL_FOODS;
  const filtered = foodActiveCat === '全部' ? sourceData : sourceData.filter(f => f.cat === foodActiveCat);
  
  if (filtered.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#999;padding:20px;">暂无该分类美食</p>';
    return;
  }
  
  let h = '';
  filtered.forEach((f, i) => {
    const fallbackSvg = foodSVG(f.cat);
    const isAmapData = f.photos !== undefined; // 高德数据有photos数组
    const photoGallery = isAmapData ? renderPhotoGallery(f.photos, fallbackSvg, f.name) : `<img src="${f.photo || f.img || fallbackSvg}" alt="${f.name}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" onerror="this.src='${fallbackSvg}'">`;
    const descText = f.desc || '';
    const ratingHtml = f.rating ? `<span style="color:#FF9800;">⭐${f.rating}</span>` : '';
    const distHtml = f.dist ? ` · 📏 ${f.dist}` : '';
    const telHtml = f.tel ? `<span style="font-size:11px;color:#888;"> · 📞 ${f.tel}</span>` : '';
    const openHtml = f.openTime ? `<div style="font-size:11px;color:#888;margin-top:2px;">🕐 ${f.openTime}</div>` : '';
    const tagsHtml = [];
    if (f.cat) tagsHtml.push(`<span class="list-tag">${f.cat}</span>`);
    if (f.keytag) tagsHtml.push(`<span class="list-tag" style="background:#FFF3E0;color:#E65100;">${f.keytag}</span>`);
    if (parseInt(f.discountNum) > 0) tagsHtml.push(`<span class="list-tag" style="background:#FFF8E1;color:#FF6F00;">🎫 ${f.discountNum}优惠</span>`);
    if (parseInt(f.groupbuyNum) > 0) tagsHtml.push(`<span class="list-tag" style="background:#EDE7F6;color:#4527A0;">🛒 ${f.groupbuyNum}团购</span>`);
    const bizAreaHtml = f.businessArea ? ` · 🏘️ ${f.businessArea}` : '';
    h += `<div class="list-item">
      <div class="list-photo" style="overflow:hidden;flex-shrink:0;">${photoGallery}</div>
      <div class="list-info">
        <div class="list-name">${f.name} <span class="list-price">${f.price || ''}</span>${ratingHtml}</div>
        <div class="list-addr">📍 ${f.area || ''}${bizAreaHtml}${distHtml}${telHtml}</div>
        <div class="list-desc">${descText}</div>
        ${openHtml}
        <div class="list-tags">${tagsHtml.join('')}</div>
        <div class="list-btn-row">
          <a class="list-nav" href="https://uri.amap.com/navigation?to=${f.coord}&mode=car&callnative=1" target="_blank">🧭 导航</a>
          <a class="list-nav blue" href="https://uri.amap.com/detail?poiid=${f.amapId || ''}" target="_blank">📋 详情</a>
          ${f.website ? `<a class="list-nav" href="${f.website.startsWith('http')?f.website:'https://'+f.website}" target="_blank" style="background:#f5f5f5;color:#333;">🌐 官网</a>` : ''}
        </div>
      </div>
    </div>`;
  });
  list.innerHTML = h;
}

function closeFoodModal(e) {
  if (!e || e.target === document.getElementById('food-overlay')) {
    document.getElementById('food-overlay').classList.remove('show');
  }
}

// ===== 西安周边景点（按距离排序+内嵌SVG插图）=====
const NEARBY_SPOTS = [
  { name:'钟楼', dist:'0km', desc:'西安正中心，600年历史，登楼俯瞰四条大街，建议傍晚去看亮灯。始建于明洪武十七年（1384年），是中国现存钟楼中形制最大、保存最完整的一座。', icon:'🔔', c1:'#C62828', c2:'#E53935', rank:1, coord:'108.9480,34.2608', gaodeUid:'B001B0K5VE', photo:'https://data.travelchinaguide.com/photo/xian-bell-tower-s.jpg' },
  { name:'鼓楼', dist:'0.2km', desc:'和钟楼隔广场相望，上面有全国最大的鼓，整点敲鼓很震撼。建于明洪武十三年（1380年），比钟楼早4年。', icon:'🥁', c1:'#AD1457', c2:'#E91E63', rank:2, coord:'108.9470,34.2618', gaodeUid:'B001B0K5VF', photo:'https://data.travelchinaguide.com/photo/xian-drum-tower-s.jpg' },
  { name:'回民街', dist:'0.3km', desc:'西安最火的美食街，主街热闹，巷子里才是本地人的正确打开方式。北院门、西羊市、大皮院三条主巷各有特色。', icon:'🏮', c1:'#E65100', c2:'#FF9800', rank:3, coord:'108.9430,34.2640', gaodeUid:'B001B0K5V2', photo:'https://data.travelchinaguide.com/photo/2019/08300014s.jpg' },
  { name:'碑林博物馆', dist:'1.5km', desc:'中国四大碑林之首，颜真卿柳公权真迹都在，书法爱好者必去。收藏碑石墓志4000余方，被誉为"书法艺术的殿堂"。', icon:'📜', c1:'#4E342E', c2:'#795548', rank:4, coord:'108.9550,34.2530', gaodeUid:'B001B0K5VG', photo:'https://data.travelchinaguide.com/photo/xian-stone-steles-museum-s.jpg' },
  { name:'城墙(南门)', dist:'1.8km', desc:'全世界最完整的古城墙，周长13.74公里，租辆自行车骑一圈约2小时，夜景绝美。永宁门（南门）是最雄伟的城门。', icon:'🏰', c1:'#37474F', c2:'#607D8B', rank:5, coord:'108.9520,34.2470', gaodeUid:'B001B0K5V3', photo:'https://data.travelchinaguide.com/photo/2010/12020022.jpg' },
  { name:'小雁塔', dist:'2.5km', desc:'比大雁塔更清静古朴，免费入园，适合慢慢逛拍照。建于唐中宗景龙年间（707年），是唐代佛教建筑艺术遗产。', icon:'🛕', c1:'#827717', c2:'#9E9D24', rank:6, coord:'108.9420,34.2390', gaodeUid:'B001B0K5V4', photo:'https://data.travelchinaguide.com/photo/xian-small-goose-pagoda-s.jpg' },
  { name:'大雁塔', dist:'5km', desc:'玄奘取经归来建塔，北广场音乐喷泉亚洲最大，晚上必看。塔高64.5米，七层，内藏贝叶经等珍贵文物。', icon:'🗼', c1:'#F57F17', c2:'#FFB300', rank:7, coord:'108.9640,34.2190', gaodeUid:'B001B0K5V5', photo:'https://data.travelchinaguide.com/photo/2008/03170234.jpg' },
  { name:'大唐不夜城', dist:'5.5km', desc:'晚上来！穿汉服拍照美哭，「不倒翁小姐姐」和「盛唐密盒」都在这里。全长2100米，以盛唐文化为背景的步行街。', icon:'🎭', c1:'#4A148C', c2:'#7B1FA2', rank:8, coord:'108.9660,34.2150', gaodeUid:'B001B0K5V6', photo:'https://data.travelchinaguide.com/photo/xian-tang-paradise-s.jpg' },
  { name:'陕西历史博物馆', dist:'5.8km', desc:'全中国最牛的省博之一，免费但需预约，珍宝多到逛不完。馆藏文物171万余件，其中一级文物762件。', icon:'🏛️', c1:'#BF360C', c2:'#E64A19', rank:9, coord:'108.9570,34.2130', gaodeUid:'B001B0K5V7', photo:'https://data.travelchinaguide.com/photo/tang-dynasty-relics.jpg' },
  { name:'华清宫', dist:'30km', desc:'杨贵妃泡温泉的地方，冬天来看「长恨歌」实景演出震撼到哭。骊山脚下，唐代帝王游幸的离宫别苑。', icon:'♨️', c1:'#00695C', c2:'#26A69A', rank:10, coord:'109.2110,34.3670', gaodeUid:'B001B0K5V8', photo:'https://data.travelchinaguide.com/photo/xian-huaqing-hotspring-s.jpg' },
  { name:'兵马俑', dist:'35km', desc:'世界第八大奇迹不用多说了吧？来西安不去兵马俑等于没来。秦始皇陵陪葬坑，已出土陶俑8000余件。', icon:'🗿', c1:'#D84315', c2:'#FF7043', rank:11, coord:'109.2750,34.3840', gaodeUid:'B001B0K5V9', photo:'https://data.travelchinaguide.com/photo/terracotta-chariots-horses.jpg' },
  { name:'华山', dist:'120km', desc:'五岳最险，鹞子翻身和长空栈道够胆才上，建议单独安排一天。南峰海拔2154.9米，是五岳最高峰。', icon:'⛰️', c1:'#01579B', c2:'#29B6F6', rank:12, coord:'110.0870,34.4760', gaodeUid:'B001B0K5VA', photo:'https://data.travelchinaguide.com/photo/2014/06050026.jpg' },
];

function spotSVG(name, icon, c1, c2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
  <rect width="200" height="200" rx="12" fill="url(#sg)"/>
  <text x="100" y="105" text-anchor="middle" font-size="64">${icon}</text>
  <text x="100" y="155" text-anchor="middle" font-size="22" fill="white" font-weight="bold" style="text-shadow:0 1px 3px rgba(0,0,0,.3)">${name}</text>
</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

let _cachedSpots = null;

async function openSpotsNearby() {
  // 免费功能：无需支付即可浏览
  const list = document.getElementById('spots-list');
  list.innerHTML = '<p style="text-align:center;color:#999;padding:30px;">📡 正在从高德获取西安真实景点...</p>';
  document.getElementById('spots-overlay').classList.add('show');
  
  try {
    if (!_cachedSpots) {
      const pos = await getUserPosition();
      const rawPois = await fetchAmapPOIs('景点|博物馆|寺庙|遗址|公园', '风景名胜|科教文化服务|公园广场', '西安', 30, true);
      _cachedSpots = rawPois.map(p => amapPoiToSpotItem(p, pos.lat, pos.lng));
    }
  } catch (e) { /* fallback */ }
  
  const sourceData = (_cachedSpots && _cachedSpots.length > 0) ? _cachedSpots : NEARBY_SPOTS;
  const isAmapData = _cachedSpots && _cachedSpots.length > 0;
  
  let h = '';
  let rank = 0;
  sourceData.forEach(s => {
    rank++;
    const rcClass = rank === 1 ? ' gold' : rank === 2 ? ' silver' : rank === 3 ? ' bronze' : ' normal';
    const rcIcon = rank === 1 ? '👑' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
    const distLabel = s.dist || '—';
    
    if (isAmapData) {
      const fallbackSvg = spotFallbackSVG(s.name);
      const photoGallery = renderPhotoGallery(s.photos, fallbackSvg, s.name);
      const ticketHtml = s.ticketOrdering === '1' ? '<span class="list-tag" style="background:#FFF3E0;color:#E65100;">🎫 可购票</span>' : '';
      const ratingHtml = s.rating ? `<span>⭐${s.rating}</span>` : '';
      const telHtml = s.tel ? `<span style="font-size:11px;color:#888;">📞 ${s.tel}</span>` : '';
      const keytagHtml = s.keytag ? `<span class="list-tag" style="background:#FFF3E0;color:#E65100;">${s.keytag}</span>` : '';
      const bizAreaHtml = s.businessArea ? `<span style="font-size:11px;color:#888;">🏘️ ${s.businessArea}</span>` : '';
      const recHtml = s.recommend ? `<span style="font-size:10px;color:#4CAF50;">👍 推荐度${s.recommend}/5</span>` : '';
      const aliasHtml = s.alias ? `<span style="font-size:11px;color:#888;">(又名: ${s.alias})</span>` : '';
      const discHtml = parseInt(s.discountNum) > 0 ? `<span class="list-tag" style="background:#FFF8E1;color:#FF6F00;">🎫 ${s.discountNum}优惠</span>` : '';
      const grpHtml = parseInt(s.groupbuyNum) > 0 ? `<span class="list-tag" style="background:#EDE7F6;color:#4527A0;">🛒 ${s.groupbuyNum}团购</span>` : '';
      h += `<div class="list-item">
        <div class="list-photo" style="border-radius:10px;overflow:hidden;flex-shrink:0;background:#f5f5f5;position:relative;">${photoGallery}<div class="photo-tag">${distLabel}</div></div>
        <div class="list-info">
          <div class="list-name">${s.name} <span class="spot-rank-badge${rcClass}">${rcIcon}</span>${ratingHtml}${aliasHtml}</div>
          <div class="list-addr">📍 ${s.address || ''} · 📏 ${distLabel} · ${s.adname || '西安'}${telHtml}</div>
          <div class="list-desc">${s.desc || ''}${recHtml}</div>
          ${s.openTime ? `<div style="font-size:11px;color:#888;margin:2px 0;">🕐 ${s.openTime}</div>` : ''}
          <div class="list-tags">${keytagHtml}${ticketHtml}${discHtml}${grpHtml}</div>
          <div class="list-btn-row">
            <a class="list-nav" href="https://uri.amap.com/navigation?to=${s.coord},${encodeURIComponent(s.name)}&mode=car&callnative=1" target="_blank">🧭 一键导航</a>
            <a class="list-nav blue" href="https://uri.amap.com/detail?poiid=${s.amapId || ''}" target="_blank">📋 高德详情</a>
            <span class="list-nav blue" onclick="openGuide('${s.name}')" style="cursor:pointer;">📸 攻略</span>
            ${s.website ? `<a class="list-nav" href="${s.website.startsWith('http')?s.website:'https://'+s.website}" target="_blank" style="background:#f5f5f5;color:#333;">🌐 官网</a>` : ''}
          </div>
        </div>
      </div>`;
    } else {
      // Fallback to static data
      const fallbackSvg = spotSVG(s.name, s.icon, s.c1, s.c2);
      const imgSrc = s.photo || fallbackSvg;
      h += `<div class="list-item">
        <div class="list-photo" style="border-radius:10px;overflow:hidden;flex-shrink:0;background:#f5f5f5;"><img src="${imgSrc}" alt="${s.name}" style="width:100%;height:100%;object-fit:cover;display:block;" loading="lazy" onerror="this.src='${fallbackSvg}'"><div class="photo-tag">${s.dist}</div></div>
        <div class="list-info">
          <div class="list-name">${s.name} <span class="spot-rank-badge${rcClass}">${rcIcon}</span></div>
          <div class="list-addr">📏 距钟楼约 ${s.dist}</div>
          <div class="list-desc">${s.desc}</div>
          <div class="list-btn-row">
            <a class="list-nav" href="https://uri.amap.com/navigation?to=${s.gaodeUid},${s.name}&mode=car&callnative=1" target="_blank">🧭 一键导航</a>
            <span class="list-nav blue" onclick="openGuide('${s.name}')" style="cursor:pointer;">📸 拍照攻略</span>
          </div>
        </div>
      </div>`;
    }
  });
  list.innerHTML = h;
  document.getElementById('spots-overlay').classList.add('show');
}

function closeSpotsModal(e) {
  if (!e || e.target === document.getElementById('spots-overlay')) {
    document.getElementById('spots-overlay').classList.remove('show');
  }
}

// ===== 一人一车 · 司机弹窗（含免责条款）=====
const DRIVERS = [
  { name:'老王', avatar:'👨‍🦰', age:42, stars:4.9, tags:['土著14年','摄影爱好者'], car:'大众迈腾', color:'黑色', seat:5, plate:'陕A·8X21K', wx:'请通过客服匹配真实司机', phone:'请通过客服匹配', desc:'（示例）当过兵，开车稳，车上备热水和充电线，还免费帮拍照' },
  { name:'张哥', avatar:'👨', age:38, stars:4.8, tags:['回民街长大','美食通'], car:'丰田凯美瑞', color:'白色', seat:5, plate:'陕A·3M56Y', wx:'请通过客服匹配真实司机', phone:'请通过客服匹配', desc:'（示例）回坊土著，坐他的车等于带了个美食导游' },
  { name:'小李', avatar:'👦', age:29, stars:4.7, tags:['95后','英语流利'], car:'比亚迪汉', color:'红色', seat:5, plate:'陕A·9H78L', wx:'请通过客服匹配真实司机', phone:'请通过客服匹配', desc:'（示例）英语专业毕业，带过很多外国游客，车内有Wi-Fi和翻译机' },
];

function openDriverService() {
  const list = document.getElementById('driver-list');
  let h = '<div class="disclaimer-box"><strong>⚠️ 重要提示</strong><br>以下为示例司机画像，真实司机需通过客服匹配合规营运车辆。页面内微信号和手机号为占位信息，请勿直接拨打。<br><span style="color:#1A8A7D;font-weight:700;">预约请添加客服微信，我们为您一对一匹配。</span></div>';
  h += '<p style="text-align:center;color:#1A8A7D;font-weight:700;margin-bottom:12px;"><span style="font-size:22px;">¥400</span><span style="font-size:13px;color:#666;"> /天 · 8小时 · 200公里 · 5座轿车</span></p>';
  h += '<p style="font-size:11px;color:#999;text-align:center;margin-bottom:16px;">超时¥60/h，超里程¥2/km · 请私下联系司机沟通行程</p>';
  DRIVERS.forEach(d => {
    h += `<div class="driver-card">
      <div class="driver-header">
        <div class="driver-avatar">${d.avatar}</div>
        <div>
          <div class="driver-name">${d.name} <span class="driver-stars">★ ${d.stars}</span>${d.tags.map(t => '<span class="driver-tag">'+t+'</span>').join('')}</div>
          <div style="font-size:11px;color:#999;">${d.age}岁 · ${d.desc}</div>
        </div>
      </div>
      <div class="driver-info-row">
        <span>🚗 ${d.car}</span><span>🎨 ${d.color}</span><span>🪑 ${d.seat}座</span><span>🚘 ${d.plate}</span>
      </div>
      <div class="driver-contact">
        <button class="driver-wx-btn" onclick="toast('请添加客服微信预约真实司机匹配服务')">💬 预约匹配服务</button>
        <button class="driver-call-btn" onclick="toast('请添加客服微信预约真实司机匹配服务')">📞 预约匹配服务</button>
      </div>
    </div>`;
  });
  list.innerHTML = h;
  document.getElementById('driver-overlay').classList.add('show');
}

function closeDriverModal(e) {
  if (!e || e.target === document.getElementById('driver-overlay')) {
    document.getElementById('driver-overlay').classList.remove('show');
  }
}

function copyWx(wxid) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(wxid).then(() => toast('微信号已复制：' + wxid));
  } else {
    const ta = document.createElement('textarea');
    ta.value = wxid; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    toast('微信号已复制：' + wxid);
  }
}

// ===== 附近酒店 =====
const HOTEL_CAT_STYLE = {
  '经济连锁': { icon:'🏨', c1:'#FF8F00', c2:'#FFB74D', emoji:'💰' },
  '舒适型':    { icon:'🏨', c1:'#1565C0', c2:'#64B5F6', emoji:'🛏️' },
  '高档型':    { icon:'🏨', c1:'#4E342E', c2:'#8D6E63', emoji:'✨' },
  '特色民宿':  { icon:'🏨', c1:'#00695C', c2:'#80CBC4', emoji:'🏡' }
};

function hotelSVG(cat) {
  const s = HOTEL_CAT_STYLE[cat] || { icon:'🏨', c1:'#9E9E9E', c2:'#E0E0E0', emoji:'🏨' };
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${s.c1}"/><stop offset="100%" stop-color="${s.c2}"/></linearGradient></defs><rect width="200" height="200" rx="12" fill="url(#hg)"/><text x="100" y="100" text-anchor="middle" font-size="52">${s.emoji}</text><text x="100" y="150" text-anchor="middle" font-size="22" fill="white" font-weight="bold" style="text-shadow:0 1px 3px rgba(0,0,0,.3)">${cat}</text></svg>`)}`;
}

const HOTELS = [
  { name:'钟楼饭店', dist:'0.3km', desc:'老牌四星，钟楼旁位置绝佳，俯瞰钟楼夜景', price:'388', origPrice:'588', photo:'https://dimg04.c-ctrip.com/images/1mc0m12000amb30aeA2BA_W_1280_853_R5_Q70.jpg', link:'https://hotels.ctrip.com/hotel/375609.html', coord:'108.947,34.260', cat:'高档型' },
  { name:'西安美居酒店(钟楼店)', dist:'0.5km', desc:'法式风格，地铁口零距离，性价比超高', price:'258', origPrice:'398', photo:'https://dimg04.c-ctrip.com/images/200d14000000vwonq3B33_W_1280_853_R5_Q70.jpg', link:'https://hotels.ctrip.com/hotel/435167.html', coord:'108.952,34.263', cat:'舒适型' },
  { name:'汉庭酒店(钟楼东大街店)', dist:'0.8km', desc:'经济实惠，干净卫生，连锁品牌有保障', price:'168', origPrice:'258', photo:'https://dimg04.c-ctrip.com/images/200k11000000qfcid5959_C_360_360_Q50.jpg', link:'https://hotels.ctrip.com/hotel/153210.html', coord:'108.957,34.262', cat:'经济连锁' },
  { name:'西安索菲特传奇酒店', dist:'1.2km', desc:'人民大厦内，法式奢华，带行政酒廊', price:'988', origPrice:'1588', photo:'https://dimg04.c-ctrip.com/images/20060k000000b971iEA9A_C_360_360_Q50.jpg', link:'https://hotels.ctrip.com/hotel/435608.html', coord:'108.955,34.270', cat:'高档型' },
  { name:'西安W酒店', dist:'3.5km', desc:'网红潮牌酒店，曲江池畔，设计感炸裂', price:'1288', origPrice:'1888', photo:'https://dimg04.c-ctrip.com/images/0222o12000cfl2yy2186E_R_960_660_R5_D.jpg', link:'https://hotels.ctrip.com/hotel/6892125.html', coord:'108.980,34.208', cat:'高档型' },
  { name:'全季酒店(大雁塔店)', dist:'4.8km', desc:'新中式风格，距大雁塔步行10分钟', price:'298', origPrice:'428', photo:'https://dimg04.c-ctrip.com/images//1mc6a12000rye09u4001B_R_1080_808_Q90.jpg', link:'https://hotels.ctrip.com/hotel/298713.html', coord:'108.960,34.222', cat:'舒适型' },
  { name:'如家精选(回民街店)', dist:'0.4km', desc:'就在回民街口，下楼就开吃，吃货首选', price:'188', origPrice:'288', photo:'https://dimg04.c-ctrip.com/images/1mc2a12000sferil0B2ED_W_1280_853_R5_Q70.jpg', link:'https://hotels.ctrip.com/hotel/852361.html', coord:'108.945,34.266', cat:'经济连锁' },
  { name:'花间堂·与鹿(诗经里)', dist:'21km', desc:'诗经里景区内，温泉私汤，唐风庭院园林', price:'598', origPrice:'898', photo:'https://dimg04.c-ctrip.com/images/1mc2p12000ntca9bmD529_W_1280_853_R5_Q70.jpg', link:'https://hotels.ctrip.com/hotel/54895140.html', coord:'108.764,34.215', cat:'特色民宿' },
];

const HOTEL_CATEGORIES = ['全部', '经济连锁', '舒适型', '高档型', '特色民宿'];
let hotelActiveCat = '全部';

let _cachedHotels = null;

function openHotelsNearby() {
  // 免费功能：无需支付即可浏览
  let catHtml = '';
  HOTEL_CATEGORIES.forEach(c => {
    catHtml += `<div class="cat-tab${c===hotelActiveCat?' active':''}" onclick="filterHotelCat('${c}')">${c}</div>`;
  });
  document.getElementById('hotel-cat-tabs').innerHTML = catHtml;
  renderHotelList();
  document.getElementById('hotel-overlay').classList.add('show');
}

function filterHotelCat(cat) {
  hotelActiveCat = cat;
  document.querySelectorAll('#hotel-cat-tabs .cat-tab').forEach(t => {
    t.classList.toggle('active', t.textContent === cat);
  });
  renderHotelList();
}

async function renderHotelList() {
  const list = document.getElementById('hotel-list');
  list.innerHTML = '<p style="text-align:center;color:#999;padding:30px;">📡 正在从高德获取附近真实酒店...</p>';
  
  try {
    if (!_cachedHotels) {
      const pos = await getUserPosition();
      // 搜索多种类型的酒店
      const rawPois1 = await fetchAmapAround('酒店', '住宿服务', pos.lat, pos.lng, 10000, 15, true);
      const rawPois2 = await fetchAmapAround('宾馆|旅馆|民宿|客栈', '住宿服务', pos.lat, pos.lng, 10000, 15, true);
      const allRaw = [...rawPois1];
      // 合并去重
      const seen = new Set(rawPois1.map(p => p.id));
      rawPois2.forEach(p => { if (!seen.has(p.id)) { allRaw.push(p); seen.add(p.id); } });
      _cachedHotels = allRaw.map(p => amapPoiToHotelItem(p, pos.lat, pos.lng));
    }
  } catch (e) { /* fallback */ }
  
  const sourceData = (_cachedHotels && _cachedHotels.length > 0) ? _cachedHotels : HOTELS;
  const isAmapData = _cachedHotels && _cachedHotels.length > 0;
  const filtered = hotelActiveCat === '全部' ? sourceData : sourceData.filter(h => h.cat === hotelActiveCat);
  
  if (filtered.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#999;padding:20px;">暂无该类型酒店</p>';
    return;
  }
  
  let h = '';
  filtered.forEach(hotel => {
    if (isAmapData) {
      const fallbackSvg = hotelSVG(hotel.cat);
      const photoGallery = renderPhotoGallery(hotel.photos, fallbackSvg, hotel.name);
      const ratingHtml = hotel.rating ? `<span style="color:#FF9800;"> ⭐${hotel.rating}</span>` : '';
      const keytagHtml = hotel.keytag ? `<span class="list-tag" style="background:#EDE7F6;color:#4527A0;">${hotel.keytag}</span>` : '';
      const starHtml = hotel.star ? `<span style="font-size:11px;color:#FF9800;">${'⭐'.repeat(Math.min(5, hotel.star.length))}</span>` : '';
      const bizAreaHtml = hotel.businessArea ? `<span style="font-size:11px;color:#888;"> · 🏘️ ${hotel.businessArea}</span>` : '';
      const telHtml = hotel.tel ? `<span style="font-size:11px;color:#888;"> · 📞 ${hotel.tel}</span>` : '';
      const openHtml = hotel.openTime ? `<div style="font-size:11px;color:#888;margin-top:2px;">🕐 ${hotel.openTime}</div>` : '';
      const discHtml = parseInt(hotel.discountNum) > 0 ? `<span class="list-tag" style="background:#FFF8E1;color:#FF6F00;">🎫 ${hotel.discountNum}优惠</span>` : '';
      const grpHtml = parseInt(hotel.groupbuyNum) > 0 ? `<span class="list-tag" style="background:#EDE7F6;color:#4527A0;">🛒 ${hotel.groupbuyNum}团购</span>` : '';
      h += `<div class="hotel-list-item">
        <div class="hotel-photo" style="overflow:hidden;">${photoGallery}</div>
        <div class="hotel-detail">
          <div class="h-name">${hotel.name}${ratingHtml}${starHtml}</div>
          <div class="h-dist">📍 ${hotel.dist} · ${hotel.cat} · ${hotel.adname || '西安'}${bizAreaHtml}${telHtml}</div>
          <div class="h-price-row"><span class="h-price">¥${hotel.price}<s>¥${hotel.origPrice}</s></span><span class="h-rebate">参考价</span></div>
          <div class="list-desc">${hotel.address || hotel.desc || ''}</div>
          ${openHtml}
          <div class="list-tags" style="margin:4px 0;">${keytagHtml}${discHtml}${grpHtml}</div>
          <div class="hotel-btn-row">
            <a class="hotel-btn buy" href="${hotel.link}" target="_blank">📋 高德详情</a>
            <a class="hotel-btn nav" href="https://uri.amap.com/navigation?to=${hotel.coord}&mode=car" target="_blank">🧭 导航</a>
            ${hotel.website ? `<a class="hotel-btn" href="${hotel.website.startsWith('http')?hotel.website:'https://'+hotel.website}" target="_blank" style="background:#f5f5f5;color:#333;">🌐 官网</a>` : ''}
          </div>
        </div>
      </div>`;
    } else {
      // Fallback
      h += `<div class="hotel-list-item">
        <div class="hotel-photo"><img src="${hotel.photo || hotelSVG(hotel.cat)}" alt="${hotel.name}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" onerror="this.src='${hotelSVG(hotel.cat)}'"></div>
        <div class="hotel-detail">
          <div class="h-name">${hotel.name}</div>
          <div class="h-dist">📍 距钟楼约 ${hotel.dist} · ${hotel.cat}</div>
          <div class="h-price-row"><span class="h-price">¥${hotel.price}<s>¥${hotel.origPrice}</s></span><span class="h-rebate">小长安专享</span></div>
          <div class="list-desc">${hotel.desc}</div>
          <div class="hotel-btn-row">
            <a class="hotel-btn buy" href="${hotel.link}" target="_blank">🛒 去团购</a>
            <a class="hotel-btn nav" href="https://uri.amap.com/navigation?to=${hotel.coord}&mode=car" target="_blank">🧭 导航</a>
          </div>
        </div>
      </div>`;
    }
  });
  list.innerHTML = h;
}

function closeHotelModal(e) {
  if (!e || e.target === document.getElementById('hotel-overlay')) {
    document.getElementById('hotel-overlay').classList.remove('show');
  }
}

// ===== AI 智能体对话 =====
const CHAT_SYSTEM_PROMPT = `你是"小长安"，西安14年土著导游，陕西口音（用"额"代替"我"），性格热情直爽、幽默风趣。你是西安旅行专家，能回答关于西安的任何问题：景点、美食、交通、住宿、历史、文化、天气、路线规划等。

回复要求：
1. 用口语化的、接地气的方式回答，陕西味十足
2. 如果用户问行程规划，给出具体的天数和路线安排
3. 如果是美食推荐，给店名、位置、人均价格
4. 如果是景点问题，给门票、开放时间、攻略建议
5. 保持高情商，让游客感觉在和西安本地老朋友聊天
6. 回答控制在200-400字，除非需要详细行程规划
7. 安全第一，不推荐危险行为
8. 如果用户问非西安旅行相关的问题，友好地把话题引回西安旅行

你是长安伴游的AI智能体，要为游客提供最优质、最准确、最高情商的旅行服务。`;

let chatMessages = [];

function openAIChat() {
  if (chatMessages.length === 0) {
    chatMessages.push({ role:'bot', text:'嘿！额是小长安，西安土著活了14年！\\n\\n你想问啥都行——景点、美食、住宿、路线，额都能给你安排得明明白白的。\\n\\n来，说说你有啥需求？带娃？情侣？还是一个人独闯长安城？', time:getTimeStr() });
  }
  renderChatMessages();
  document.getElementById('chat-overlay').classList.add('show');
  setTimeout(() => document.getElementById('chat-input').focus(), 400);
}

function getTimeStr() {
  const now = new Date();
  return now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
}

function renderChatMessages() {
  const body = document.getElementById('chat-body');
  let h = '';
  chatMessages.forEach(m => {
    if (m.role === 'bot') {
      h += `<div class="chat-msg bot">${m.text.replace(/\\n/g,'<br>')}<div class="msg-time">${m.time||''}</div></div>`;
    } else {
      h += `<div class="chat-msg user">${m.text}<div class="msg-time">${m.time||''}</div></div>`;
    }
  });
  body.innerHTML = h;
  body.scrollTop = body.scrollHeight;
}

function addTyping() {
  const body = document.getElementById('chat-body');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chat-typing';
  typingDiv.id = 'typing-indicator';
  typingDiv.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(typingDiv);
  body.scrollTop = body.scrollHeight;
}

function removeTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function sendChatMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatMessages.push({ role:'user', text, time:getTimeStr() });
  renderChatMessages();
  addTyping();
  
  // Call DeepSeek API
  (async () => {
    try {
      const resp = await fetch(PROXY_URL, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model:'deepseek-chat',
          max_tokens:800,
          temperature:0.9,
          messages:[
            {role:'system',content:CHAT_SYSTEM_PROMPT},
            {role:'user',content:text}
          ]
        })
      });
      if (!resp.ok) throw new Error('API错误');
      const data = await resp.json();
      removeTyping();
      chatMessages.push({ role:'bot', text:data.choices[0].message.content, time:getTimeStr() });
      renderChatMessages();
    } catch(e) {
      removeTyping();
      // Fallback response if API fails
      const fallback = getFallbackResponse(text);
      chatMessages.push({ role:'bot', text:fallback, time:getTimeStr() });
      renderChatMessages();
    }
  })();
}

function getFallbackResponse(q) {
  const ql = q.toLowerCase();
  if (ql.includes('兵马俑') || ql.includes('门票')) return '兵马俑门票120元/人，学生半价60元。旺季（3月-11月）8:30-17:00，淡季8:30-16:30。建议提前网上购票，现场排队太费劲。额建议找个导游讲解，比自己瞎看强多了！';
  if (ql.includes('住') || ql.includes('酒店') || ql.includes('住宿')) return '住的话额推荐钟楼附近，去哪都方便。经济型168起，舒适型258起，高档型388起。打开"附近酒店"标签能看到详细列表，还有团购链接！';
  if (ql.includes('吃') || ql.includes('美食') || ql.includes('推荐')) return '额私藏的美食单在"本地人美食"标签里，分成了陕菜经典、回坊小吃、面食天堂、夜市烧烤四个分类。回民街的灌汤包子和肉夹馍是必吃的，别去主街，钻进巷子里找老店！';
  if (ql.includes('行程') || ql.includes('路线') || ql.includes('规划') || ql.includes('天')) return '想要定制行程的话，回到首页点"开始规划我的西安之旅"，告诉额你的天数、人数、偏好，额用AI给你生成详细到每小时的路线，连导航都配好了！';
  return '这个问题额得查一下最新信息，不过关于西安的景点、美食、住宿、路线这些事儿，你尽管问！或者试试快捷提问，额都能给你安排得妥妥的。';
}

function askQuick(q) {
  document.getElementById('chat-input').value = q;
  sendChatMsg();
}

function closeAIChat(e) {
  if (!e || e.target === document.getElementById('chat-overlay')) {
    document.getElementById('chat-overlay').classList.remove('show');
  }
}

// ===== 语音播报（首次登录自报家门）=====
let voicePlayed = false;

function toggleVoiceIntro() {
  const btn = document.getElementById('voice-btn');
  if (btn.classList.contains('playing')) {
    stopVoice();
    return;
  }
  playVoiceIntro();
}

function playVoiceIntro() {
  if (!('speechSynthesis' in window)) {
    toast('你的浏览器不支持语音播报');
    return;
  }
  const btn = document.getElementById('voice-btn');
  btn.classList.add('playing');
  btn.textContent = '🔊 正在播报…';

  const text = '嘿！你好！额是小长安，你在西安的土著老朋友。额在西安活了14年，比任何一个攻略APP都懂这座城。额能帮你规划旅行路线、推荐本地人私藏的美食、陪你聊天解答任何关于西安的问题。想规划行程就点下面的按钮，想找好吃的、找酒店、找景点导航，上面四个标签都有。有任何问题随时点开AI智能体问额！祝你在西安耍得开心！';

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.95;
  utterance.pitch = 1.05;

  // Try to find a female Chinese voice
  const voices = speechSynthesis.getVoices();
  const zhVoice = voices.find(v => v.lang.startsWith('zh')) || voices.find(v => v.lang.includes('Chinese'));
  if (zhVoice) utterance.voice = zhVoice;

  utterance.onend = () => {
    btn.classList.remove('playing');
    btn.textContent = '🔊 听小长安自报家门';
    voicePlayed = true;
  };
  utterance.onerror = () => {
    btn.classList.remove('playing');
    btn.textContent = '🔊 听小长安自报家门';
  };

  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function stopVoice() {
  speechSynthesis.cancel();
  const btn = document.getElementById('voice-btn');
  btn.classList.remove('playing');
  btn.textContent = '🔊 听小长安自报家门';
}

// 预加载语音列表
if ('speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}
