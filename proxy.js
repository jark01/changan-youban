/**
 * 长安游伴 · API代理 + Token验证服务器
 * 用途：静态文件服务 + DeepSeek API代理 + 一次性Token验证
 * 
 * 启动方式：node proxy.js
 * 默认端口：3457
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ============================================
// 🔑 配置区
// ============================================
const DEEPSEEK_API_KEY = 'sk-2061c4530730466589b025bd975a7bed';
const AMAP_WEB_KEY = 'bb7f0c78ad5530def46192c141edf568'; // 高德Web服务API Key（已更新 2026-06-17）
const AMAP_JS_KEY  = 'bb7f0c78ad5530def46192c141edf568'; // 高德JS API Key（前端用，同Web服务Key）
const PORT = 3457;
const ADMIN_KEY = 'changan2026'; // 管理密钥：用于创建token
const TOKENS_FILE = path.join(os.tmpdir(), 'changan-tokens.json');

// ============================================
// 📸 截图验证支付配置（百度OCR — 印刷体识别准确率>99%）
// ============================================
// 获取方式：https://console.bce.baidu.com/ai/#/ai/ocr/overview/index → 创建"通用文字识别"应用
// 免费额度：500次/天，完全够用
const BAIDU_OCR_API_KEY = 'VcUVY5QxeQ9Dn1aTKZybcz8k';     // 填入百度OCR API Key
const BAIDU_OCR_SECRET_KEY = '7H1UqJPJkYA6phiCVzDzMzUkRni6yPZA';  // 填入百度OCR Secret Key
const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');

// ============================================
// 🔧 XorPay 配置（已废弃，保留备查）
// ============================================
const XORPAY_AID = '';
const XORPAY_SECRET = '';
const PAYMENTS_FILE = path.join(__dirname, 'data', 'payments.json');

const STATIC_EXTS = ['.html', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.txt'];

// ============================================
// 内部工具函数（供 enrich-poi 使用）
// ============================================
function fetchJSONInternal(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON解析失败: ' + e.message + ' | raw: ' + data.substring(0, 200))); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('高德API超时')); });
  });
}

function callDeepSeekInternal(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 600
    });
    const options = {
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 30000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) resolve(json.choices[0].message.content);
          else reject(new Error('DeepSeek返回异常: ' + data.substring(0, 200)));
        } catch(e) { reject(new Error('DeepSeek解析失败: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek请求超时')); });
    req.write(payload);
    req.end();
  });
}

// ============================================
// Token 管理
// ============================================
function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
  } catch (e) { console.error('读取tokens.json失败:', e.message); }
  return {};
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
}

function createToken() {
  const tokens = loadTokens();
  const token = 'cayb_' + crypto.randomBytes(12).toString('hex');
  tokens[token] = { used: false, created_at: new Date().toISOString(), used_at: null };
  saveTokens(tokens);
  return token;
}

function verifyToken(token) {
  const tokens = loadTokens();
  const info = tokens[token];
  if (!info) return { valid: false, reason: '无效的访问码' };
  if (info.used) return { valid: false, reason: '此访问码已被使用' };
  return { valid: true, info };
}

function useToken(token) {
  const tokens = loadTokens();
  if (!tokens[token] || tokens[token].used) return false;
  tokens[token].used = true;
  tokens[token].used_at = new Date().toISOString();
  saveTokens(tokens);
  return true;
}

// ============================================
// 订单管理（截图验证支付）
// ============================================
function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
    }
  } catch(e) { console.error('读取orders.json失败:', e.message); }
  return {};
}

function saveOrders(orders) {
  const dir = path.dirname(ORDERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');
}

// 金额池：9.90 ~ 9.99 共10个，不够往上加
function allocateAmount(orders) {
  var base = 990; // 分
  var max = 999;
  for (var i = base; i <= max + 50; i++) {
    var amt = (i / 100).toFixed(2);
    var occupied = Object.values(orders).some(function(o) {
      return o.status === 'pending' && o.expected_amount === amt;
    });
    if (!occupied) return amt;
  }
  return '10.00'; // fallback
}

// 生成订单
function createOrder() {
  var orders = loadOrders();
  var orderId = 'ord_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
  var amount = allocateAmount(orders);
  orders[orderId] = {
    status: 'pending',
    expected_amount: amount,
    created_at: new Date().toISOString(),
    verified_at: null,
    paid_time: null,
    paid_amount: null,
    token: null,
    screenshot_saved: false,
    attempts: 0
  };
  saveOrders(orders);
  console.log('📝 创建订单:', orderId, '金额:', amount);
  return { order_id: orderId, amount: amount };
}

// ============================================
// 百度OCR — 通用文字识别（每天500次免费）
//   微信/支付宝支付截图是系统生成的印刷体高清图片，
//   百度OCR对印刷体识别准确率>99%，秒杀Tesseract.js
// ============================================
async function baiduOCR(imageBase64) {
  if (!BAIDU_OCR_API_KEY || !BAIDU_OCR_SECRET_KEY) {
    throw new Error('百度OCR未配置API密钥');
  }
  
  // 1. 获取 access_token（有效期30天，但每次请求都重新获取确保不过期）
  var tokenUrl = 'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials' +
    '&client_id=' + encodeURIComponent(BAIDU_OCR_API_KEY) +
    '&client_secret=' + encodeURIComponent(BAIDU_OCR_SECRET_KEY);
  
  var tokenResp = await fetchJSONInternal(tokenUrl);
  if (!tokenResp.access_token) {
    throw new Error('百度OCR认证失败: ' + JSON.stringify(tokenResp));
  }
  
  // 2. 调用通用文字识别（高精度版）
  var ocrUrl = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=' + tokenResp.access_token;
  
  return new Promise(function(resolve, reject) {
    var imgData = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    var postData = 'image=' + encodeURIComponent(imgData) + '&language_type=CHN_ENG&detect_direction=true';
    var urlObj = new URL(ocrUrl);
    
    var options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    };
    
    var req = https.request(options, function(apiRes) {
      var data = '';
      apiRes.on('data', function(chunk) { data += chunk; });
      apiRes.on('end', function() {
        try {
          var json = JSON.parse(data);
          if (json.error_code) {
            reject(new Error('百度OCR错误: ' + (json.error_msg || json.error_code)));
          } else {
            resolve(json);
          }
        } catch(e) {
          reject(new Error('百度OCR响应解析失败'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('百度OCR请求超时')); });
    req.write(postData);
    req.end();
  });
}

// 从OCR结果中提取：收款方、金额、时间、交易单号
function parseOCRResult(ocrData) {
  var texts = [];
  if (ocrData.words_result && Array.isArray(ocrData.words_result)) {
    texts = ocrData.words_result.map(function(w) { return w.words; });
  }
  
  var fullText = texts.join('\n');
  console.log('🔍 OCR识别文本:\n' + fullText.substring(0, 500));
  
  var payee = null;
  var amount = null;
  var payTime = null;
  var txnId = null;
  
  // 1. 提取收款方：多重策略匹配
  // 策略A：直接搜索"郭杰"（最可靠，即使OCR识别有些偏差也要尝试）
  if (fullText.includes('郭杰')) {
    payee = '郭杰';
  }
  // 策略B：搜索"郭"+"杰"（允许中间有空格或OCR噪声）
  if (!payee && /郭\s*杰/.test(fullText)) {
    payee = '郭杰';
  }
  // 策略C：找到"郭"字后再取后面1-2个中文字符
  if (!payee) {
    var guoMatch = fullText.match(/郭([\u4e00-\u9fa5]{1,2})/);
    if (guoMatch) payee = '郭' + guoMatch[1];
  }
  // 策略D：扫二维码付款-给XXX 模式
  if (!payee) {
    var payeeMatch = fullText.match(/给\s*([\u4e00-\u9fa5]{1,4})/);
    if (payeeMatch) payee = payeeMatch[1];
  }
  // 策略E：付款-给/至 XXX
  if (!payee) {
    var payeeMatch2 = fullText.match(/付款[-\s]*[给至]\s*([\u4e00-\u9fa5]{1,4})/);
    if (payeeMatch2) payee = payeeMatch2[1];
  }
  
  // 2. 提取金额：¥9.90, ￥9.90, -9.90, 9.90
  //    OCR可能把"-"识别成 —、–、−、一 等各种符号，必须全部覆盖
  //    按优先级从上到下尝试，匹配到一个就停止
  var amt = null;
  // A: 标准减号/人民币符号 + 数字  （如 -9.90, ¥9.90, ￥9.90）
  amt = fullText.match(/[\-\u2012\u2013\u2014\u2015\u2212\uFF0D\u4E00\u002D¥￥]\s*(\d+[\.．,，]\d{1,2})/);
  // B: 支出/付款/消费 后跟数字
  if (!amt) amt = fullText.match(/(?:支出|付款|消费|扣款|转账)\s*[：:]?\s*(\d+[\.．,，]\d{1,2})/);
  // C: 直接搜 9.90 / 9,90 （最宽松兜底）
  if (!amt) amt = fullText.match(/\b(9[\.．,，]9\d?)/);
  // D: 搜索"负"字 + 数字
  if (!amt) amt = fullText.match(/负\s*(\d+[\.．,，]\d{1,2})/);
  // E: 全局兜底：全文搜任何 X.XX 格式的金额
  if (!amt) amt = fullText.match(/(\d{1,3}[\.．,，]\d{2})(?!\d)/);
  
  if (amt) {
    amount = parseFloat(amt[1].replace(/[．,，]/g, '.'));
    console.log('💰 金额识别: 原始匹配="' + amt[0] + '", 解析值=' + amount);
  } else {
    console.log('⚠️ 金额未识别，原文前300字: ' + fullText.substring(0, 300));
  }
  
  // 3. 提取时间
  // 格式1: 2026年6月18日 16:21:56
  var timeMatch = fullText.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    var y = timeMatch[1];
    var m = timeMatch[2].padStart(2, '0');
    var d = timeMatch[3].padStart(2, '0');
    var h = timeMatch[4].padStart(2, '0');
    var min = timeMatch[5];
    var s = timeMatch[6] || '00';
    payTime = y + '-' + m + '-' + d + ' ' + h + ':' + min + ':' + s;
  }
  // 格式2: 2026-06-18 16:21:56
  if (!timeMatch) {
    var timeMatch2 = fullText.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?)/);
    if (timeMatch2) { payTime = timeMatch2[1].replace(/\//g, '-'); if (payTime.split(':').length === 2) payTime += ':00'; }
  }
  
  // 4. 提取交易单号（20位以上的纯数字）
  var txnMatches = fullText.match(/\b(\d{20,})\b/g);
  if (txnMatches) {
    // 取最长的那个作为交易单号
    txnId = txnMatches.reduce(function(a, b) { return a.length >= b.length ? a : b; });
  }
  // 也尝试"交易单号"、"商户单号"等关键字匹配
  var txnLabelMatch = fullText.match(/(?:交易|商户|订单)[单号][：:]\s*(\d{20,})/);
  if (txnLabelMatch) txnId = txnLabelMatch[1];
  
  console.log('📋 OCR解析: payee=' + payee + ', amount=' + amount + ', time=' + payTime + ', txnId=' + (txnId || 'N/A'));
  
  return { payee: payee, amount: amount, pay_time: payTime, txn_id: txnId, full_text: fullText };
}

// 严格核验：收款方 + 金额 + 单号去重（三关）
function strictVerifyAndMatch(ocrInfo) {
  // ===== 第1关：收款方必须包含"郭"（容错OCR乱码）=====
  // OCR可能把"郭杰"识别为"郭洁"/"郭倢"/"郭"等，只要收款方包含"郭"就通过
  // 优先检查OCR全文中是否有"给郭"或"付款给郭"等关键模式
  var fullText = ocrInfo.full_text || '';
  var hasGuoInPayee = ocrInfo.payee && ocrInfo.payee.indexOf('郭') !== -1;
  var hasGuoInText = /给.{0,2}郭/.test(fullText) || /付款.*郭/.test(fullText) || /郭杰|郭潔|郭洁/.test(fullText);
  
  if (!hasGuoInPayee && !hasGuoInText) {
    return { error: '收款方验证失败：未识别到"郭杰"，OCR识别到"' + (ocrInfo.payee || '未识别') + '"，请确认是给郭杰的付款截图。\nOCR全文片段：' + fullText.substring(0, 100) };
  }
  console.log('✅ 第1关通过：收款方=' + ocrInfo.payee);
  
  // ===== 第2关：金额必须是 9.90 =====
  if (!ocrInfo.amount || Math.abs(ocrInfo.amount - 9.90) > 0.01) {
    return { error: '金额验证失败：识别到 ¥' + (ocrInfo.amount || '未识别') + '，应为 ¥9.90。请确认支付了正确金额。' };
  }
  console.log('✅ 第2关通过：金额=' + ocrInfo.amount);
  
  // ===== 第3关：交易单号不能重复 =====
  if (!ocrInfo.txn_id) {
    return { error: '未识别到交易单号，请确认截图中包含完整的支付详情（含20位以上数字单号）。' };
  }
  
  var orders = loadOrders();
  
  // 检查所有订单中是否已存在该交易单号
  var duplicate = Object.entries(orders).find(function(entry) {
    return entry[1].txn_id === ocrInfo.txn_id;
  });
  if (duplicate) {
    // 如果已核验过且有token，直接返回成功（允许继续生成规划）
    if (duplicate[1].status === 'paid' && duplicate[1].token) {
      console.log('⚠️ 重复单号，但已有token，直接放行：' + duplicate[0]);
      return {
        ok: true,
        token: duplicate[1].token,
        order_id: duplicate[0],
        matched_amount: parseFloat(duplicate[1].paid_amount || '9.90'),
        payee: duplicate[1].payee || '郭杰',
        txn_id: ocrInfo.txn_id,
        already_verified: true,
        verify_steps: {
          payee: '✅ 收款方：' + (duplicate[1].payee || '郭杰'),
          amount: '✅ 金额：¥' + (duplicate[1].paid_amount || '9.90'),
          txn_unique: '✅ 已核验（首次通过）',
          record_saved: '📋 微信 已核查-已生成'
        },
        verified_record: '微信 已核查-已生成'
      };
    }
    return { error: '该交易单号已被使用过（订单：' + duplicate[0].substring(0, 16) + '...），请勿重复使用同一张支付截图。' };
  }
  console.log('✅ 第3关通过：交易单号无重复=' + ocrInfo.txn_id);
  
  // ===== 全部通过，匹配订单 =====
  // 找最近的 pending 订单
  var candidates = Object.entries(orders).filter(function(entry) {
    return entry[1].status === 'pending';
  });
  
  if (candidates.length === 0) {
    return { error: '没有待支付的订单。请刷新页面重新生成订单。' };
  }
  
  // 选最早创建的（最合理的匹配）
  candidates.sort(function(a, b) {
    return new Date(a[1].created_at) - new Date(b[1].created_at);
  });
  
  var matched = candidates[0];
  var orderId = matched[0];
  var order = matched[1];
  
  // 更新订单状态
  order.status = 'paid';
  order.verified_at = new Date().toISOString();
  order.paid_time = ocrInfo.pay_time || order.verified_at;
  order.paid_amount = String(ocrInfo.amount);
  order.txn_id = ocrInfo.txn_id;            // 保存交易单号防止重复使用
  order.payee = ocrInfo.payee;              // 保存收款方名字
  order.verify_details = {                  // 保存验证详情
    payee_ok: true,
    amount_ok: true,
    txn_unique: true
  };
  
  // 生成解锁令牌
  if (!order.token) {
    order.token = 'unlock_' + crypto.randomBytes(16).toString('hex');
  }
  
  saveOrders(orders);
  
  // ===== 保存核查记录到总表 =====
  var excelRecord = saveVerifiedRecord({
    category: detectPaySource(fullText),
    payee: ocrInfo.payee || '郭杰',
    amount: ocrInfo.amount,
    txn_id: ocrInfo.txn_id,
    pay_time: ocrInfo.pay_time || new Date().toISOString(),
    ocr_text: fullText,
    note: '支付截图验证通过',
    verify_passed: true,
    plan_generated: false
  });
  
  console.log('🎉 三关核验全部通过！订单:', orderId, '收款方:', ocrInfo.payee, '金额:', ocrInfo.amount, '单号:', ocrInfo.txn_id);
  console.log('📋 核查记录已保存: ' + excelRecord);
  
  return {
    ok: true,
    token: order.token,
    order_id: orderId,
    matched_amount: ocrInfo.amount,
    payee: ocrInfo.payee,
    txn_id: ocrInfo.txn_id,
    verify_steps: {
      payee: '✅ 收款方：' + ocrInfo.payee,
      amount: '✅ 金额：¥' + ocrInfo.amount,
      txn_unique: '✅ 交易单号验证通过',
      record_saved: '📋 微信 | ' + (ocrInfo.txn_id || '---') + ' | 已核查-已生成'
    },
    verified_record: '微信 | ' + ocrInfo.txn_id + ' | 已核查-已生成',
    excel_file: excelRecord
  };
}

// ============================================
// ============================================
// Excel 核查总表（只看这一个表）
//   字段：序号 | 类别(微信/支付宝) | 名称(收款方) | 金额 | 时间(支付) | 核验时间(百度OCR) | 订单号 | 备注 | 核验结果 | 生成状态
// ============================================
var XLSX_PATH = path.join(__dirname, 'node_modules');
var VERIFIED_XLSX = path.join(__dirname, 'data', 'verified-records.xlsx');

// 检测支付类别（微信/支付宝）
function detectPaySource(ocrText) {
  if (!ocrText) return '微信';
  var t = ocrText.toLowerCase();
  if (t.indexOf('支付宝') !== -1 || t.indexOf('alipay') !== -1 || t.indexOf('吱') !== -1) return '支付宝';
  if (t.indexOf('微信') !== -1 || t.indexOf('wechat') !== -1 || t.indexOf('扫二维码付款') !== -1) return '微信';
  // 默认微信（大部分情况）
  return '微信';
}

// 保存核查记录到总表
function saveVerifiedRecord(record) {
  try {
    var XLSX = require(XLSX_PATH + '/xlsx');
    var filePath = VERIFIED_XLSX;
    
    // 读取已有记录
    var wsData = [];
    if (fs.existsSync(filePath)) {
      var wb = XLSX.readFile(filePath);
      var ws = wb.Sheets[wb.SheetNames[0]];
      wsData = XLSX.utils.sheet_to_json(ws, { header: 1 });
    }
    
    var now = new Date();
    var dateStr = now.getFullYear() + '-' + 
      String(now.getMonth() + 1).padStart(2, '0') + '-' + 
      String(now.getDate()).padStart(2, '0');
    var timeStr = dateStr + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0');
    
    var category = detectPaySource(record.ocr_text || '');
    var payTime = record.pay_time || dateStr;          // 支付时间（OCR识别）
    var verifyTime = timeStr;                            // 核验时间（百度OCR识别当前时刻）
    var verifyResult = record.verify_passed ? '✅ 核验成功' : '❌ 核验失败';
    var genStatus = record.plan_generated ? '✅ 已生成' : '⏳ 待生成';
    
    // 新记录：序号|类别|名称|金额|时间(支付)|核验时间|订单号|备注|核验结果|生成状态
    var newRow = [
      wsData.length + 1,              // 序号
      category,                        // 类别（微信/支付宝）
      record.payee || '郭杰',          // 名称（收款方）
      '¥' + (record.amount || '9.90'), // 金额
      payTime,                         // 时间（支付时间）
      verifyTime,                      // 核验时间（百度OCR）
      record.txn_id || '',             // 订单号
      record.note || '',               // 备注
      verifyResult,                    // 核验结果
      genStatus                        // 生成状态
    ];
    
    wsData.push(newRow);
    
    // 重建Excel
    var ws2 = XLSX.utils.aoa_to_sheet(wsData);
    // 如果只有数据行（没有表头），插入表头
    var headers = ['序号', '类别', '名称', '金额', '时间(支付)', '核验时间', '订单号', '备注', '核验结果', '生成状态'];
    XLSX.utils.sheet_add_aoa(ws2, [headers], { origin: 'A1' });
    
    // 样式：表头加粗
    ws2['!cols'] = [
      {wch: 6}, {wch: 8}, {wch: 8}, {wch: 10},
      {wch: 18}, {wch: 18}, {wch: 35},
      {wch: 20}, {wch: 14}, {wch: 12}
    ];
    
    // 添加汇总 Sheet
    var summaryRows = [];
    var wxCount = 0, aliCount = 0, wxAmount = 0, aliAmount = 0;
    var successCount = 0, failCount = 0, generatedCount = 0;
    
    wsData.forEach(function(row) {
      if (row[1] === '微信') { wxCount++; wxAmount += parseFloat(String(row[3]).replace('¥','')) || 0; }
      if (row[1] === '支付宝') { aliCount++; aliAmount += parseFloat(String(row[3]).replace('¥','')) || 0; }
      if (String(row[8]).indexOf('成功') !== -1) successCount++;
      else failCount++;
      if (String(row[9]).indexOf('已生成') !== -1) generatedCount++;
    });
    
    summaryRows.push(['汇总统计', '', '', '', '', '', '', '', '']);
    summaryRows.push(['', '', '', '', '', '', '', '', '']);
    summaryRows.push(['类别', '单数', '总金额', '', '', '', '', '', '']);
    summaryRows.push(['微信', wxCount + '单', '¥' + wxAmount.toFixed(2), '', '', '', '', '', '']);
    summaryRows.push(['支付宝', aliCount + '单', '¥' + aliAmount.toFixed(2), '', '', '', '', '', '']);
    summaryRows.push(['合计', (wxCount + aliCount) + '单', '¥' + (wxAmount + aliAmount).toFixed(2), '', '', '', '', '', '']);
    summaryRows.push(['', '', '', '', '', '', '', '', '']);
    summaryRows.push(['核验成功', successCount + '单', '核验失败', failCount + '单', '', '', '', '', '']);
    summaryRows.push(['已生成规划', generatedCount + '单', '未生成', (wsData.length - generatedCount) + '单', '', '', '', '', '']);
    
    var wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{wch: 14}, {wch: 10}, {wch: 12}, {wch: 14}, {wch: 10}, {wch: 10}, {wch: 10}, {wch: 10}, {wch: 10}];
    
    var wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, ws2, '核查总表');
    XLSX.utils.book_append_sheet(wb2, wsSummary, '汇总统计');
    
    XLSX.writeFile(wb2, filePath);
    console.log('📋 核查总表已更新: ' + filePath + ' (第' + wsData.length + '条, 微信' + wxCount + '单/支付宝' + aliCount + '单)');
    return filePath;
  } catch(e) {
    console.error('❌ 保存Excel失败:', e.message);
    return null;
  }
}

// 更新生成状态（旅行规划生成后调用）
function updatePlanStatus(orderId, generated) {
  try {
    var XLSX = require(XLSX_PATH + '/xlsx');
    var filePath = VERIFIED_XLSX;
    if (!fs.existsSync(filePath)) return;
    
    var wb = XLSX.readFile(filePath);
    var ws = wb.Sheets['核查总表'];
    if (!ws) return;
    var wsData = XLSX.utils.sheet_to_json(ws, { header: 1 });
    
    // 找对应行并更新生成状态
    var updated = false;
    wsData.forEach(function(row) {
      if (row[5] && row[5].indexOf(orderId) !== -1) {
        row[8] = generated ? '✅ 已生成' : '⏳ 待生成';
        updated = true;
      }
    });
    
    if (updated) {
      var newWs = XLSX.utils.aoa_to_sheet(wsData);
      newWs['!cols'] = ws['!cols'];
      wb.Sheets['核查总表'] = newWs;
      XLSX.writeFile(wb, filePath);
      console.log('📋 生成状态已更新: ' + orderId + ' → ' + (generated ? '已生成' : '待生成'));
    }
  } catch(e) {
    console.error('❌ 更新生成状态失败:', e.message);
  }
}

// 生成OCR扫描明细Excel（从上到下所有字段）
function generateOCRDetailExcel(ocrData, orderId) {
  try {
    var XLSX = require(XLSX_PATH + '/xlsx');
    var filePath = path.join(__dirname, 'data', 'ocr-detail-' + (orderId || Date.now()) + '.xlsx');
    
    var rows = [['序号', '字段名', '识别内容', '行号']];
    
    if (ocrData.words_result && Array.isArray(ocrData.words_result)) {
      ocrData.words_result.forEach(function(item, idx) {
        rows.push([idx + 1, 'OCR行' + (idx + 1), item.words || '', idx + 1]);
      });
    }
    
    // 额外添加关键字段提取结果
    rows.push(['---', '---', '---', '---']);
    rows.push(['提取结果', '', '', '']);
    
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch: 6}, {wch: 15}, {wch: 80}, {wch: 8}];
    
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'OCR扫描明细');
    XLSX.writeFile(wb, filePath);
    
    console.log('📋 OCR明细已保存: ' + filePath);
    return filePath;
  } catch(e) {
    console.error('❌ 生成OCR明细失败:', e.message);
    return null;
  }
}

// 旧的兼容函数（保留）
function matchOrder(ocrInfo) {
  return strictVerifyAndMatch(ocrInfo);
}

// 管理员手动验证订单
function manualVerifyOrder(orderId) {
  var orders = loadOrders();
  var order = orders[orderId];
  
  if (!order) return { error: '订单不存在' };
  if (order.status === 'paid') return { error: '订单已验证' };
  
  order.status = 'paid';
  order.verified_at = new Date().toISOString();
  order.paid_time = order.verified_at;
  order.paid_amount = order.expected_amount;
  order.manual_verified = true;
  
  if (!order.token) {
    order.token = 'unlock_' + crypto.randomBytes(16).toString('hex');
  }
  
  saveOrders(orders);
  
  console.log('👤 管理员手动验证:', orderId, '令牌:', order.token.substring(0, 20) + '...');
  
  return { ok: true, token: order.token, order_id: orderId };
}

// ============================================
// HTTP 服务器
// ============================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // 绕过 localtunnel 的"Click to Continue"拦截页面
  res.setHeader('bypass-tunnel-reminder', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const urlPath = url.pathname;

  // ===== 获取公网 URL =====
  if (req.method === 'GET' && urlPath === '/api/public-url') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: publicUrl || '', status: publicUrl ? 'connected' : 'connecting' }));
    return;
  }

  // ===== Token API =====
  if (urlPath === '/api/token') {
    const action = url.searchParams.get('action');
    const token = url.searchParams.get('token');
    const adminKey = url.searchParams.get('key');

    if (action === 'verify' && token) {
      const result = verifyToken(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (action === 'create' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.key !== ADMIN_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '管理密钥错误' }));
            return;
          }
          const count = parseInt(data.count) || 1;
          if (count === 1) {
            const token = createToken();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ token, count: 1 }));
          } else {
            const tokens = [];
            for (let i = 0; i < count; i++) {
              tokens.push(createToken());
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tokens, count }));
          }
        } catch (e) {
          console.error('create token error:', e.message, 'body:', body);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请求格式错误: ' + e.message }));
        }
      });
      return;
    }

    if (action === 'list' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.key !== ADMIN_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '管理密钥错误' }));
            return;
          }
          const tokens = loadTokens();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tokens }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请求格式错误' }));
        }
      });
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无效的操作，支持: verify, create, list' }));
    return;
  }

  // ===== 订单：创建（替代XorPay）=====
  if (req.method === 'POST' && urlPath === '/api/order/create') {
    var result = createOrder();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  // ===== 订单：截图验证（OCR识别支付信息）=====
  if (req.method === 'POST' && urlPath === '/api/order/verify') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', async function() {
      try {
        var params = JSON.parse(body || '{}');
        var imageBase64 = params.image;
        var orderId = params.order_id;
        
        if (!imageBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '请上传支付截图' }));
          return;
        }
        
        // 保存截图到本地（备查）
        try {
          var screenshotsDir = path.join(__dirname, 'data', 'screenshots');
          if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
          var imgData = imageBase64.replace(/^data:image\/\w+;base64,/, '');
          var filename = (orderId || 'unknown') + '_' + Date.now() + '.png';
          fs.writeFileSync(path.join(screenshotsDir, filename), Buffer.from(imgData, 'base64'));
          
          if (orderId) {
            var ordersTmp = loadOrders();
            if (ordersTmp[orderId]) {
              ordersTmp[orderId].screenshot_saved = true;
              ordersTmp[orderId].screenshot_file = filename;
              saveOrders(ordersTmp);
            }
          }
          console.log('📸 截图已保存:', filename);
        } catch(e) { console.error('保存截图失败:', e.message); }
        
        // 百度OCR识别（印刷体准确率>99%）
        try {
          var ocrData = await baiduOCR(imageBase64);
          
          // 生成OCR扫描明细Excel（从上到下所有字段）
          var excelPath = generateOCRDetailExcel(ocrData, orderId);
          
          var ocrInfo = parseOCRResult(ocrData);
          var matchResult = matchOrder(ocrInfo);
          
          if (matchResult.error) {
            // 保存失败记录到总表
            saveVerifiedRecord({
              payee: ocrInfo.payee || '未识别',
              amount: ocrInfo.amount || 0,
              txn_id: ocrInfo.txn_id || '',
              pay_time: ocrInfo.pay_time || new Date().toISOString(),
              ocr_text: ocrData.raw_text || '',
              note: matchResult.error,
              verify_passed: false,
              plan_generated: false
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ 
              ok: false, 
              error: matchResult.error,
              ocr: { amount: ocrInfo.amount, time: ocrInfo.pay_time, payee: ocrInfo.payee },
              ocr_detail_excel: excelPath,
              need_manual: true
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(matchResult));
          }
        } catch(ocrErr) {
          console.error('❌ OCR识别失败:', ocrErr.message);
          // OCR失败 → 保存截图，等待管理员手动验证
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ 
            ok: false, 
            error: 'OCR识别失败，截图已保存，请等待管理员验证 (' + ocrErr.message + ')',
            need_manual: true,
            order_id: orderId
          }));
        }
        
      } catch(e) {
        console.error('❌ 截图验证失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '验证失败: ' + e.message, need_manual: true }));
      }
    });
    return;
  }

  // ===== 订单：轮询状态 =====
  if (req.method === 'GET' && urlPath === '/api/order/status') {
    var orderId = url.searchParams.get('order_id');
    if (!orderId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少order_id' }));
      return;
    }
    
    var orders = loadOrders();
    var order = orders[orderId];
    
    if (!order) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: order.status,
      token: order.status === 'paid' ? order.token : null,
      expected_amount: order.expected_amount,
      created_at: order.created_at,
      verified_at: order.verified_at
    }));
    return;
  }

  // ===== 订单：管理员手动验证 =====
  if (req.method === 'POST' && urlPath === '/api/order/manual-verify') {
    var body2 = '';
    req.on('data', function(chunk) { body2 += chunk; });
    req.on('end', function() {
      try {
        var params = JSON.parse(body2 || '{}');
        var key = params.key;
        var orderId = params.order_id;
        
        if (key !== ADMIN_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '管理密钥错误' }));
          return;
        }
        
        var result = manualVerifyOrder(orderId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ===== 订单：获取待处理列表（管理员用）=====
  if (req.method === 'POST' && urlPath === '/api/order/list') {
    var body3 = '';
    req.on('data', function(chunk) { body3 += chunk; });
    req.on('end', function() {
      try {
        var params = JSON.parse(body3 || '{}');
        if (params.key !== ADMIN_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '管理密钥错误' }));
          return;
        }
        
        var orders = loadOrders();
        // 返回最近100条
        var entries = Object.entries(orders)
          .sort(function(a, b) { return new Date(b[1].created_at) - new Date(a[1].created_at); })
          .slice(0, 100);
        
        var list = entries.map(function(entry) {
          return {
            order_id: entry[0],
            status: entry[1].status,
            expected_amount: entry[1].expected_amount,
            paid_amount: entry[1].paid_amount || '',
            created_at: entry[1].created_at,
            verified_at: entry[1].verified_at,
            paid_time: entry[1].paid_time,
            screenshot_saved: entry[1].screenshot_saved || false,
            screenshot_file: entry[1].screenshot_file || '',
            manual_verified: entry[1].manual_verified || false,
            attempts: entry[1].attempts || 0
          };
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ orders: list, total: entries.length }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ===== 更新旅行规划生成状态 =====
  if (req.method === 'POST' && urlPath === '/api/order/plan-status') {
    var bodyUpdate = '';
    req.on('data', function(chunk) { bodyUpdate += chunk; });
    req.on('end', function() {
      try {
        var params = JSON.parse(bodyUpdate || '{}');
        if (params.order_id) {
          updatePlanStatus(params.order_id, params.generated === true);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ===== API代理：/api/chat（免费开放，但X-Unlock-Token需要时验证）=====
  if (req.method === 'POST' && urlPath === '/api/chat') {
    // 检查是否需要支付令牌（同时兼容旧payments和新orders）
    var unlockToken = req.headers['x-unlock-token'];
    if (unlockToken) {
      // 先查 orders
      var orders = loadOrders();
      var foundOrder = Object.entries(orders).find(function(entry) { return entry[1].token === unlockToken; });
      
      if (!foundOrder) {
        // 再查旧 payments（向下兼容）
        var payments = loadPayments();
        var foundPay = Object.entries(payments).find(function(entry) { return entry[1].token === unlockToken; });
        if (!foundPay) {
          res.writeHead(402, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '支付验证失败：无效的解锁令牌', code: 'INVALID_TOKEN' }));
          return;
        }
        // 旧 payments 中的 token — 核验通过后永久有效
        console.log('✅ 令牌验证通过(旧):', foundPay[0]);
      } else {
        // orders 中的 token — 核验通过后永久有效
        console.log('✅ 令牌验证通过(新):', foundOrder[0]);
      }
    }
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'YOUR_DEEPSEEK_API_KEY') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API Key未配置', code: 'NO_API_KEY' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('📤 转发请求到 DeepSeek...');

      const options = {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 60000
      };

      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          console.log('✅ DeepSeek 响应: HTTP ' + apiRes.statusCode);
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('error', (err) => {
        console.error('❌ 请求失败:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '代理请求失败', message: err.message }));
      });

      apiReq.on('timeout', () => {
        apiReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请求超时' }));
      });

      apiReq.write(body);
      apiReq.end();
    });
    return;
  }

  // ===== API代理：/api/deepseek（不消耗Token，用于预览数据）=====
  if (req.method === 'POST' && urlPath === '/api/deepseek') {
    // 免费开放，不验证Token
    if (!DEEPSEEK_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API Key未配置' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('📤 [预览] 转发请求到 DeepSeek...');

      const options = {
        hostname: 'api.deepseek.com',
        path: '/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 30000
      };

      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('timeout', () => { apiReq.destroy(); res.writeHead(504); res.end(JSON.stringify({ error: '请求超时' })); });
      apiReq.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
      apiReq.write(body);
      apiReq.end();
    });
    return;
  }

  // ===== 攻略生成端点：/api/guide?name=xxx =====
  if (req.method === 'GET' && urlPath === '/api/guide') {
    const name = url.searchParams.get('name');
    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少景点名称' }));
      return;
    }

    const fs = require('fs');
    const path = require('path');
    const guidesDir = path.join(__dirname, 'guides');
    const cacheFile = path.join(guidesDir, name + '.json');

    // 1. 检查缓存
    if (fs.existsSync(cacheFile)) {
      console.log('📋 攻略缓存命中:', name);
      const cached = fs.readFileSync(cacheFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(cached);
      return;
    }

    // 2. 调用DeepSeek生成
    if (!DEEPSEEK_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API Key未配置' }));
      return;
    }

    console.log('📸 生成攻略:', name);

    const prompt = `请为西安景点"${name}"生成以下内容（简洁实用，每条不超过30字）：

1. 游玩攻略：最佳游玩时间、推荐路线、必看景点、附近美食
2. 避坑指南：常见陷阱、省钱技巧、注意事项

格式严格如下（不要多余解释）：
攻略：
- 最佳时间：...
- 路线：...
- 必看：...
- 美食：...

避坑：
- ...
- ...`;

    const requestBody = JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 800,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.deepseek.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 30000
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices[0].message.content;

          // 解析content
          const guideMatch = content.match(/攻略：([\s\S]*?)避坑：/);
          const pitfallsMatch = content.match(/避坑：([\s\S]*)/);

          const guide = guideMatch ? guideMatch[1].trim() : '暂无攻略';
          const pitfalls = pitfallsMatch ? pitfallsMatch[1].trim() : '暂无避坑指南';

          const result = { guide, pitfalls };

          // 保存到缓存
          if (!fs.existsSync(guidesDir)) {
            fs.mkdirSync(guidesDir, { recursive: true });
          }
          fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
          console.log('✅ 攻略已缓存:', name);

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error('❌ 解析DeepSeek响应失败:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '解析响应失败: ' + e.message }));
        }
      });
    });

    apiReq.on('error', (err) => {
      console.error('❌ DeepSeek请求失败:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DeepSeek请求失败', message: err.message }));
    });

    apiReq.on('timeout', () => {
      apiReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请求超时' }));
    });

    apiReq.write(requestBody);
    apiReq.end();
    return;
  }

  // ===== 自增长数据库：当AI推荐的POI在本地DB不存在时，自动从高德+DeepSeek抓取并保存 =====
  if (req.method === 'POST' && urlPath === '/api/enrich-poi') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { name, type } = JSON.parse(body); // type: attractions|foods|hotels|experience
        if (!name || !type) { res.writeHead(400); res.end(JSON.stringify({ error: 'name和type必填' })); return; }

        const dbFile = path.join(__dirname, 'data', type + '.json');
        let db = [];
        try { db = JSON.parse(fs.readFileSync(dbFile, 'utf-8')); } catch(e) { db = []; }

        // 已存在则直接返回（宽松匹配：双向 includes 或前3字相同）
        const shortName = name.length >= 3 ? name.substring(0, 3) : name;
        const existing = db.find(item => item.name && (
          item.name.includes(name) || name.includes(item.name) ||
          (shortName.length >= 3 && item.name.startsWith(shortName))
        ));
        if (existing) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, item: existing, source: 'cache' }));
          return;
        }

        console.log(`🔍 DB未命中，从高德抓取: [${type}] ${name}`);

        // 1. 高德POI搜索（精准搜索+extensions=all）
        const typeMap = { attractions: '风景名胜|科教文化服务', foods: '餐饮服务', hotels: '住宿服务', experience: '休闲娱乐|购物服务' };
        const amapSearchUrl = `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent(name)}&city=西安&citylimit=true&types=${encodeURIComponent(typeMap[type]||'')}&extensions=all&output=JSON&key=${AMAP_WEB_KEY}`;

        const amapData = await fetchJSONInternal(amapSearchUrl);
        const pois = (amapData && amapData.pois) ? amapData.pois : [];
        const poi = pois[0]; // 取第一个最相关结果

        if (!poi) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '高德未找到该POI: ' + name }));
          return;
        }

        // 2. 提取图片
        let images = [];
        if (poi.photos && Array.isArray(poi.photos)) {
          images = poi.photos.slice(0, 6).map(p => typeof p === 'string' ? p : (p.url || '')).filter(Boolean);
        }

        // 3. 解析坐标
        let lat = null, lng = null;
        if (poi.location) {
          const parts = poi.location.split(',');
          lng = parseFloat(parts[0]);
          lat = parseFloat(parts[1]);
        }

        // 4. 提取字段
        const safeStr = v => (typeof v === 'string' ? v : (Array.isArray(v) ? v.join(',') : String(v||'')));
        const biz = poi.biz_ext || {};
        const rating = parseFloat(biz.rating) || parseFloat(poi.biz_type) || null;
        const tel = safeStr(poi.tel);
        const address = safeStr(poi.address);
        const adname = safeStr(poi.adname);
        const openTime = safeStr(biz.open_time || poi.business_area || '');
        const tag = safeStr(poi.tag);
        const desc = (poi.biz_ext && poi.biz_ext.intro) ? safeStr(poi.biz_ext.intro) : (tag ? tag.split(';')[0] : '');
        const catMap = { attractions: '景点', foods: '美食', hotels: '酒店', experience: '体验' };

        // 5. 模板化攻略（不调DeepSeek，省积分！核心AI规划只调一次）
        const catLabel = catMap[type] || type;
        const templateGuide = {
          attractions: `${name}是西安标志性景点，建议预留2-3小时游览，深入感受千年古都的历史底蕴。`,
          foods: `${name}是西安地道美食，老西安人都知道的好味道，来西安必尝的经典。`,
          hotels: `${name}地处西安核心区域，交通便利，周边餐饮购物方便，是旅居西安的理想之选。`,
          experience: `${name}是西安特色文化体验，沉浸式感受古都魅力，值得专门安排时间前往。`
        };
        const guide = templateGuide[type] || `${name}是西安值得一去的${catLabel}。`;
        const pitfalls = desc ? `${desc}。建议提前查询营业时间，节假日人多建议错峰。` : '建议提前查询营业时间，节假日人多建议错峰出行。';
        const mustSee = `${name}——来西安不可错过。`;

        // 6. 构建新条目
        const newItem = {
          id: poi.id || ('ai_' + Date.now()),
          name: poi.name || name,
          cat: catMap[type] || type,
          desc: desc || mustSee,
          address: address,
          adname: adname,
          lat: lat,
          lng: lng,
          coord: (lng && lat) ? (lng + ',' + lat) : '',
          rating: rating,
          tel: tel,
          openTime: openTime,
          images: images,
          guide: guide,
          pitfalls: pitfalls,
          mustSee: mustSee,
          tag: tag,
          source: 'amap_enrich',
          createdAt: new Date().toISOString()
        };

        // 7. 不再保存到本地数据库（避免污染DB文件，仅当前会话使用）
        // db.push(newItem);
        // fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf-8');
        console.log(`✅ 临时富化: [${type}] ${newItem.name}（不写入DB）`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, item: newItem, source: 'amap_fresh' }));

      } catch(e) {
        console.error('❌ enrich-poi失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ===== 意见反馈 API =====
  if (req.method === 'POST' && urlPath === '/api/feedback') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const feedbackFile = path.join(__dirname, 'data', 'feedback.json');
        let list = [];
        try { list = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8')); } catch(e) {}
        list.unshift({ ...data, id: Date.now(), ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '' });
        if (list.length > 500) list = list.slice(0, 500);
        fs.writeFileSync(feedbackFile, JSON.stringify(list, null, 2), 'utf-8');
        console.log('📝 收到反馈:', data.type, '—', data.content.substring(0, 50));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        console.error('❌ 反馈保存失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ===== 高德API代理：附近POI搜索 =====
  if (req.method === 'GET' && urlPath.startsWith('/api/amap/')) {
    const apiPath = urlPath.replace('/api/amap/', '');
    const amapUrl = new URL('https://restapi.amap.com/' + apiPath);
    // 把前端传来的参数转发，并注入 Key
    url.searchParams.forEach((v, k) => amapUrl.searchParams.set(k, v));
    amapUrl.searchParams.set('key', AMAP_WEB_KEY);

    console.log('📍 高德API:', apiPath, amapUrl.searchParams.toString().substring(0, 80));

    const options = {
      hostname: 'restapi.amap.com',
      path: amapUrl.pathname + amapUrl.search,
      method: 'GET',
      timeout: 10000
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });

    apiReq.on('error', (err) => {
      console.error('❌ 高德API错误:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '高德API请求失败', message: err.message }));
    });

    apiReq.on('timeout', () => {
      apiReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '高德API请求超时' }));
    });

    apiReq.end();
    return;
  }

  // ===== 静态文件服务 =====
  if (req.method === 'GET') {
    let filePath = urlPath;
    if (filePath === '/') filePath = '/index.html';

    const ext = path.extname(filePath).toLowerCase();
    if (STATIC_EXTS.includes(ext)) {
      const fullPath = path.join(__dirname, filePath);
      if (!fullPath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        '.txt': 'text/plain; charset=utf-8'
      };

      fs.readFile(fullPath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🏮 长安游伴 · 服务器已启动            ║');
  console.log('║   地址: http://localhost:' + PORT + '              ║');
  console.log('║   管理: http://localhost:' + PORT + '/admin.html     ║');
  console.log('║   📸 截图验证(三关) | 百度OCR · 零配置即用 ║');
  console.log('║   🔍 百度OCR | 三关：收款方+金额+单号  ║');
  console.log('╚══════════════════════════════════════════╝');
  
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'YOUR_DEEPSEEK_API_KEY') {
    console.warn('⚠️  API Key 尚未配置！');
  } else {
    console.log('✅  API Key 已配置');
  }
  console.log('✅  Token管理已启用 (管理密钥: ' + ADMIN_KEY + ')');
  
  // ===== 自动开启内网穿透 =====
  startLocaltunnel();
});

// 内网穿透（localtunnel）
const NODE_MODULES_PATH = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules';
let publicUrl = '';

async function startLocaltunnel() {
  try {
    // 尝试 require localtunnel
    let lt;
    try {
      lt = require(NODE_MODULES_PATH + '/localtunnel');
    } catch(e) {
      console.log('⚠️  localtunnel 未安装，跳过内网穿透');
      console.log('   手动启动穿透: node tunnel.js');
      return;
    }
    
    console.log('\n🌐 正在启动内网穿透...');
    
    let tunnel;
    try {
      tunnel = await lt({ port: PORT, subdomain: 'changan-youban' });
    } catch(e) {
      // 子域名被占用，用随机域名
      tunnel = await lt({ port: PORT });
    }
    
    publicUrl = tunnel.url;
    
    // 保存到文件（用 os.tmpdir 避免权限问题）
    const urlFile1 = path.join(os.tmpdir(), 'changan-tunnel-url.txt');
    const urlFile2 = path.join(__dirname, 'tunnel-url.txt');
    try { fs.writeFileSync(urlFile1, publicUrl); } catch(e) {}
    try { fs.writeFileSync(urlFile2, publicUrl); } catch(e) { /* Desktop 目录可能无写权限 */ }
    
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║  🌐 内网穿透成功！公网地址：                      ║');
    console.log('║  ' + publicUrl.padEnd(51) + '║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('  📱 管理后台: ' + publicUrl + '/admin.html');
    console.log('  🔗 买家链接: ' + publicUrl + '/index.html?token=TOKEN\n');
    
    tunnel.on('close', () => {
      console.log('\n⚠️  隧道断开，3秒后重连...');
      setTimeout(() => startLocaltunnel(), 3000);
    });
    
    tunnel.on('error', (err) => {
      console.error('隧道错误:', err.message);
    });
    
  } catch(err) {
    console.error('⚠️  内网穿透失败:', err.message);
    console.log('   服务器本地可正常使用，公网访问需手动配置');
  }
}
