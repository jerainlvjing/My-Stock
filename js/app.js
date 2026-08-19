/* ============================================================
 * A股主力资金流向
 * 数据源：东方财富公开行情接口（免鉴权）
 * 约定：涨=红，跌=绿（中国习惯）
 * ============================================================ */

// 主域名被限流/不可用时，自动切换备用域名（数据源一致）
const API_HOSTS = ['https://push2.eastmoney.com', 'https://push2delay.eastmoney.com'];
const PATH_CLIST = '/api/qt/clist/get';
const PATH_ULIST = '/api/qt/ulist.np/get';
const PATH_FFLOW = '/api/qt/stock/fflow/kline/get'; // 板块/个股当日分时资金流
const UT = 'bd1d9ddb04089700cf9c27f6f7426281';
const UT_FLOW = 'b2884a393a59ad64002292a3e90d46a5';

// 板块/个股类型 -> fs 参数
const FS_MAP = {
  industry: 'm:90+t:2+f:!50', // 行业板块
  concept:  'm:90+t:3+f:!50', // 概念板块
  stock:    'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', // 全市场个股（沪深A股）
};

// 大盘指数（卡片显示用；成交额用深证综指 0.399106 不在卡片里展示）
const INDICES = [
  { secid: '1.000001', name: '上证指数' },
  { secid: '0.399006', name: '创业板指' },
  { secid: '1.000688', name: '科创50' },
];

const state = {
  type: 'industry',       // 当前板块类型
  sortField: 'f62',       // 排序字段
  sortOrder: 1,           // 1 降序 / 0 升序
  autoRefresh: true,
  intervalSec: 5,
  showAll: false,         // 是否加载全部
  boardData: [],          // 当前板块数据
  totalCount: 0,
  timer: null,
  loading: false,
};

// 盘中实时曲线：每个板块当日完整分时资金流（fflow/kline），流入/流出各取前 N
const FLOW_N = 10;
const IN_PALETTE = ['#d93a2b', '#e08a00', '#db2777', '#7c3aed', '#c2410c', '#be123c', '#a16207', '#9d174d', '#b91c1c', '#ea580c'];
const OUT_PALETTE = ['#0f9d58', '#0891b2', '#2563eb', '#059669', '#0e7490', '#1d4ed8', '#047857', '#155e75', '#15803d', '#1e40af'];
const chartState = {
  type: 'industry',
  flows: {},              // { code: { name, times: [], values: [], color, group } }
  echarts: null,
  timer: null,
  loading: false,
  hoverGroup: null,       // 当前悬停的组：'in' 流入 / 'out' 流出 / null
  hoveredIndex: -1,       // 当前悬停的 seriesIndex（用于 tooltip 行高亮）
};

// 个股下钻列表排序状态
const stockState = {
  list: [],
  sortField: 'f62',
  sortOrder: 1,
};

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);

function fmtYi(yuan) {
  if (yuan == null || isNaN(yuan)) return '--';
  const yi = yuan / 1e8;
  const sign = yi > 0 ? '+' : '';
  const abs = Math.abs(yi);
  if (abs >= 10000) return `${sign}${(yi / 1e4).toFixed(2)}万亿`;
  if (abs >= 1) return `${sign}${yi.toFixed(2)}亿`;
  return `${sign}${(yi * 1e4).toFixed(0)}万`;
}

// 曲线图专用：统一以「亿」为单位，精确到两位小数
function fmtYi2(yuan) {
  if (yuan == null || isNaN(yuan)) return '--';
  const yi = yuan / 1e8;
  const sign = yi > 0 ? '+' : '';
  return `${sign}${yi.toFixed(2)}亿`;
}

function fmtPct(v) {
  if (v == null || v === '-' || isNaN(v)) return '--';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function cls(v) {
  const n = Number(v);
  if (isNaN(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

function isTradingTime() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const h = now.getHours();
  const m = now.getMinutes();
  const t = h * 60 + m;
  return (t >= 570 && t <= 690) || (t >= 780 && t <= 900); // 9:30-11:30 / 13:00-15:00
}

/* ---------- API ---------- */
async function fetchJSON(path, hosts = API_HOSTS, timeout = 6000) {
  let lastErr;
  for (const host of hosts) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(host + path, { headers: { 'Referer': 'https://quote.eastmoney.com/' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) throw new Error('empty response');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('all hosts failed');
}

// 主力资金流排行
async function fetchBoardList(type, { page = 1, size = 50, sortField = 'f62', sortOrder = 1 } = {}) {
  const path = `${PATH_CLIST}?pn=${page}&pz=${size}&po=${sortOrder}&np=1&fltt=2&invt=2&fid=${sortField}&fs=${FS_MAP[type]}&fields=f12,f14,f2,f3,f62,f184&ut=${UT}`;
  const json = await fetchJSON(path);
  if (!json || !json.data) return { total: 0, list: [] };
  return { total: json.data.total || 0, list: json.data.diff || [] };
}

// 板块成分股（个股资金流下钻，含总市值/流通市值）
async function fetchBoardStocks(boardCode, size = 100) {
  const path = `${PATH_CLIST}?pn=1&pz=${size}&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:${boardCode}&fields=f12,f14,f2,f3,f62,f184,f20,f21&ut=${UT}`;
  const json = await fetchJSON(path);
  if (!json || !json.data) return { total: 0, list: [] };
  return { total: json.data.total || 0, list: json.data.diff || [] };
}

// 大盘指数资金流（含成交额 f6；额外取深证综指用于沪深成交额合计）
async function fetchIndices() {
  const secids = [...INDICES.map((i) => i.secid), '0.399106'].join(',');
  const path = `${PATH_ULIST}?fltt=2&invt=2&secids=${secids}&fields=f2,f3,f6,f12,f14,f62,f184&ut=${UT}`;
  const json = await fetchJSON(path);
  if (!json || !json.data) return [];
  return json.data.diff || [];
}

/* ---------- 渲染：大盘概览 ---------- */
function renderOverview(indices, boardList) {
  const map = {};
  indices.forEach((it) => { map[it.f12] = it; });

  // 沪深两市主力净流入 = 上证 + 深证综指（全深市口径）
  const sh = map['000001'];
  const sz = map['399106'];
  let totalNet = null;
  if (sh && sz && sh.f62 != null && sz.f62 != null) totalNet = sh.f62 + sz.f62;

  const totalEl = $('#totalNet');
  totalEl.textContent = totalNet == null ? '--' : fmtYi(totalNet);
  totalEl.className = 'ov-value ' + (totalNet == null ? 'flat' : cls(totalNet));

  // 涨跌家数（来自当前板块列表；加载全部时即为全市场口径）
  const upCount = boardList.filter((b) => Number(b.f3) > 0).length;
  const downCount = boardList.filter((b) => Number(b.f3) < 0).length;
  const scope = state.showAll ? '全市场' : '榜单内';
  $('#totalBreadth').innerHTML =
    `${scope} 上涨 <span class="up">${upCount}</span> · 下跌 <span class="down">${downCount}</span>`;

  // 沪深两市成交额（上证 + 深证综指）
  let totalAmount = null;
  if (sh && sz && sh.f6 != null && sz.f6 != null) totalAmount = sh.f6 + sz.f6;
  const amtEl = $('#totalAmount');
  amtEl.textContent = totalAmount == null ? '--' : fmtYi(totalAmount);

  // 指数卡（按 INDICES 顺序：上证 / 创业板 / 科创50）
  $('#indexCards').innerHTML = INDICES.map((def) => {
    const it = map[def.secid.slice(def.secid.indexOf('.') + 1)] || map[def.name] || {};
    const pct = it.f3 ?? null;
    const flow = it.f62 ?? null;
    return `
      <div class="idx-card">
        <div class="idx-name">${def.name}</div>
        <div class="idx-point ${cls(pct)}">${it.f2 != null ? it.f2.toFixed(2) : '--'}</div>
        <div class="idx-change ${cls(pct)}">${fmtPct(pct)}</div>
        <div class="idx-flow">主力 ${flow == null ? '--' : fmtYi(flow)}</div>
      </div>`;
  }).join('');
}

/* ---------- 渲染：板块排行 ---------- */
function renderBoard(list) {
  const body = $('#boardBody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
    return;
  }

  // 找出最大绝对值用于条形图
  let maxAbs = 0;
  list.forEach((b) => { const v = Number(b.f62) || 0; if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v); });

  body.innerHTML = list.map((b, i) => {
    const pct = b.f3;
    const flow = b.f62;
    const ratio = b.f184;
    const pctCls = cls(pct);
    const flowCls = cls(flow);
    const rankCls = i < 3 ? 'rank-top' : '';
    const barW = maxAbs ? (Math.abs(Number(flow) || 0) / maxAbs * 50) : 0;
    const barHtml = `
      <div class="bar-track">
        <div class="bar-center"></div>
        ${flow < 0 ? `<div class="bar-fill out" style="width:${barW}%"></div>`
                  : `<div class="bar-fill in" style="width:${barW}%"></div>`}
      </div>`;
    return `
      <tr data-code="${b.f12}" data-name="${b.f14}">
        <td class="col-rank ${rankCls}">${i + 1}</td>
        <td class="col-name"><span class="bd-name">${b.f14}</span><span class="bd-code">${b.f12}</span></td>
        <td class="col-pct num ${pctCls}">${fmtPct(pct)}</td>
        <td class="col-flow num ${flowCls}">${fmtYi(flow)}</td>
        <td class="col-bar">${barHtml}</td>
        <td class="col-ratio num ${flowCls}">${ratio == null || ratio === '-' ? '--' : fmtPct(ratio)}</td>
      </tr>`;
  }).join('');
}

/* ---------- 渲染：个股下钻 ---------- */
function renderStocks(list) {
  const body = $('#stockBody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">暂无数据</td></tr>';
    return;
  }
  // 按当前排序字段/方向排序
  const sorted = [...list].sort((a, b) => {
    const va = Number(a[stockState.sortField]) || 0;
    const vb = Number(b[stockState.sortField]) || 0;
    return stockState.sortOrder === 1 ? vb - va : va - vb;
  });
  body.innerHTML = sorted.map((s, i) => {
    const pct = s.f3;
    const flow = s.f62;
    const ratio = s.f184;
    const totalCap = s.f20;
    const floatCap = s.f21;
    const pctCls = cls(pct);
    const flowCls = cls(flow);
    return `
      <tr>
        <td class="num" style="color:var(--text-sub)">${i + 1}</td>
        <td>${s.f12}</td>
        <td>${s.f14}</td>
        <td class="num ${pctCls}">${fmtPct(pct)}</td>
        <td class="num ${flowCls}">${fmtYi(flow)}</td>
        <td class="num ${flowCls}">${ratio == null || ratio === '-' ? '--' : fmtPct(ratio)}</td>
        <td class="num">${totalCap == null || totalCap === '-' ? '--' : fmtYi(totalCap)}</td>
        <td class="num">${floatCap == null || floatCap === '-' ? '--' : fmtYi(floatCap)}</td>
      </tr>`;
  }).join('');
}

/* ---------- 主流程 ---------- */
async function loadAll() {
  if (state.loading) return;
  state.loading = true;

  try {
    const size = state.showAll ? 100 : 50;

    // 板块列表（加载全部时分页）
    let boardList;
    if (state.showAll) {
      const first = await fetchBoardList(state.type, { page: 1, size, sortField: state.sortField, sortOrder: state.sortOrder });
      let totalPages = Math.ceil(first.total / size);
      // 个股数量多（5000+），加载全部最多取前 500，避免请求过多触发限流
      if (state.type === 'stock') totalPages = Math.min(totalPages, 5);
      const pages = [];
      for (let p = 2; p <= totalPages; p++) {
        pages.push(fetchBoardList(state.type, { page: p, size, sortField: state.sortField, sortOrder: state.sortOrder }));
      }
      const rest = await Promise.all(pages);
      boardList = first.list.concat(...rest.map((r) => r.list));
      state.totalCount = first.total;
    } else {
      const r = await fetchBoardList(state.type, { page: 1, size, sortField: state.sortField, sortOrder: state.sortOrder });
      boardList = r.list;
      state.totalCount = r.total;
    }

    state.boardData = boardList;

    // 大盘指数
    const indices = await fetchIndices();

    renderOverview(indices, boardList);
    renderBoard(boardList);

    $('#updateTime').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    updateStatus();
  } catch (e) {
    console.error('加载失败', e);
    $('#updateTime').textContent = '加载失败，稍后自动重试';
  } finally {
    state.loading = false;
  }
}

function updateStatus() {
  const el = $('#marketStatus');
  if (isTradingTime()) {
    el.textContent = '交易中';
    el.className = 'badge open';
  } else {
    el.textContent = '已收盘';
    el.className = 'badge closed';
  }
}

/* ---------- 下钻抽屉 ---------- */
async function openDrawer(code, name) {
  $('#drawerTitle').textContent = name;
  $('#drawerSub').textContent = `${code} · 成分股主力资金排行`;
  $('#stockBody').innerHTML = '<tr><td colspan="8" class="empty">加载中…</td></tr>';
  $('#drawer').classList.add('show');
  $('#drawerMask').classList.add('show');
  try {
    const r = await fetchBoardStocks(code);
    stockState.list = r.list;
    updateStockSortHeader();
    renderStocks(r.list);
  } catch (e) {
    $('#stockBody').innerHTML = '<tr><td colspan="8" class="empty">加载失败，请重试</td></tr>';
  }
}

function closeDrawer() {
  $('#drawer').classList.remove('show');
  $('#drawerMask').classList.remove('show');
}

/* ---------- 盘中实时资金流向曲线 ---------- */
function initChart() {
  const el = document.getElementById('chart');
  if (!el || typeof echarts === 'undefined') return;
  chartState.echarts = echarts.init(el, null, { renderer: 'canvas' });
  // 禁用 canvas 右键菜单（避免浏览器弹出"保存图片"）
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => {
    if (chartState.echarts) chartState.echarts.resize();
    renderChartSide();
  });
  // flex 布局完成后确保拿到正确尺寸
  setTimeout(() => {
    if (chartState.echarts) chartState.echarts.resize();
    renderChartSide();
  }, 50);

  // 点击曲线/端点圆点 → 打开板块成分股详情（个股不下钻）
  chartState.echarts.on('click', (params) => {
    if (chartState.type === 'stock') return;
    const code = chartState.seriesOrder && chartState.seriesOrder[params.seriesIndex];
    if (code) openDrawer(code, params.seriesName);
  });

  // 悬停线 → 记录悬停的组和 seriesIndex（tooltip 按组过滤 + 对应行高亮）
  chartState.echarts.on('mouseover', (params) => {
    if (params.seriesIndex == null) return;
    chartState.hoveredIndex = params.seriesIndex;
    const code = chartState.seriesOrder && chartState.seriesOrder[params.seriesIndex];
    const flow = code && chartState.flows[code];
    chartState.hoverGroup = flow ? flow.group : null;
  });
  // 鼠标离开图表 → 重置悬停状态
  chartState.echarts.on('globalout', () => {
    chartState.hoveredIndex = -1;
    chartState.hoverGroup = null;
  });

  renderChart();
}

// 个股代码转 secid（6 开头沪市/688 科创，0/3 开头深市）
function secidOf(code) {
  return (code.startsWith('6') ? '1.' : '0.') + code;
}

// 获取单个板块/个股当日分时资金流（f51 时间 / f52 累计主力净流入）
async function fetchBoardFlow(secid) {
  const path = `${PATH_FFLOW}?secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=1&lmt=241&end=20500101&ut=${UT_FLOW}`;
  const json = await fetchJSON(path);
  if (!json || !json.data || !json.data.klines || !json.data.klines.length) return null;
  return json.data.klines.map((line) => {
    const p = line.split(',');
    return { time: p[0].slice(11), value: parseFloat(p[1]) };
  });
}

// 加载曲线：流入 Top N + 流出 Top N，各拉当日分时
async function loadChartData() {
  if (!chartState.echarts || chartState.loading) return;
  chartState.loading = true;
  try {
    const isStock = chartState.type === 'stock';
    // 个股流入/流出各 20，板块各 10
    const flowN = isStock ? 20 : FLOW_N;
    const [inflow, outflow] = await Promise.all([
      fetchBoardList(chartState.type, { page: 1, size: flowN, sortField: 'f62', sortOrder: 1 }),
      fetchBoardList(chartState.type, { page: 1, size: flowN, sortField: 'f62', sortOrder: 0 }),
    ]);
    const seen = new Set();
    const tasks = [];
    inflow.list.forEach((b, i) => {
      if (seen.has(b.f12)) return;
      seen.add(b.f12);
      const secid = isStock ? secidOf(b.f12) : '90.' + b.f12;
      tasks.push(fetchBoardFlow(secid).then((flow) => ({ code: b.f12, name: b.f14, flow, color: IN_PALETTE[i % IN_PALETTE.length], group: 'in' })));
    });
    outflow.list.forEach((b, i) => {
      if (seen.has(b.f12)) return;
      seen.add(b.f12);
      const secid = isStock ? secidOf(b.f12) : '90.' + b.f12;
      tasks.push(fetchBoardFlow(secid).then((flow) => ({ code: b.f12, name: b.f14, flow, color: OUT_PALETTE[i % OUT_PALETTE.length], group: 'out' })));
    });
    const results = await Promise.all(tasks);
    const flows = {};
    results.forEach((item) => {
      if (!item.flow) return;
      // 在数据前后插入虚拟点，让 X 轴显示 09:30 / 13:00 这两个边界刻度
      const flowTimes = item.flow.map((d) => d.time);
      const flowValues = item.flow.map((d) => d.value);
      const idx1130 = flowTimes.indexOf('11:30');
      let times, values;
      if (idx1130 >= 0) {
        const v1130 = flowValues[idx1130];
        times = ['09:30', ...flowTimes.slice(0, idx1130 + 1), '13:00', ...flowTimes.slice(idx1130 + 1)];
        values = [null, ...flowValues.slice(0, idx1130 + 1), v1130, ...flowValues.slice(idx1130 + 1)];
      } else {
        times = ['09:30', ...flowTimes];
        values = [null, ...flowValues];
      }
      flows[item.code] = {
        name: item.name,
        times,
        values,
        color: item.color,
        group: item.group,
      };
    });
    chartState.flows = flows;
    renderChart();
  } catch (e) {
    console.error('曲线加载失败', e);
  } finally {
    chartState.loading = false;
  }
}

function clearChart() {
  chartState.flows = {};
  renderChart();
}

function setupChartTimer() {
  if (chartState.timer) { clearInterval(chartState.timer); chartState.timer = null; }
  if (isTradingTime()) {
    // 分时数据每分钟才更新一个点，盘中 30 秒刷新一次足够
    chartState.timer = setInterval(() => { if (!document.hidden) loadChartData(); }, 30 * 1000);
  }
}

function buildChartOption() {
  const items = Object.entries(chartState.flows)
    .map(([code, f]) => {
      const current = f.values.length ? f.values[f.values.length - 1] : 0;
      return { code, name: f.name, times: f.times, values: f.values, current, color: f.color };
    })
    .filter((it) => it.values.length > 0);
  items.sort((a, b) => b.current - a.current);
  // 保存 series 顺序对应的 code，供点击下钻反查
  chartState.seriesOrder = items.map((it) => it.code);

  // X 轴时间标签：以第一条曲线的时间轴为准（各板块同一交易日分钟一致）
  const timeLabels = items.length ? items[0].times : [];
  const KEY_TIMES = new Set(['09:30', '10:30', '11:30', '14:00', '15:00']);

  // Y 轴范围：不对称坐标，正负分别计算（流入向上取整、流出向下取整到步长）
  let maxInflow = 0;   // 最大净流入（正）
  let maxOutflow = 0;  // 最大净流出（负的绝对值）
  items.forEach((it) => it.values.forEach((v) => {
    if (v != null) {
      if (v > maxInflow) maxInflow = v;
      if (-v > maxOutflow) maxOutflow = -v;
    }
  }));
  const stepYi = chartState.type === 'stock' ? 5 : 50; // 个股 5 亿步长，行业/概念 50 亿步长
  const maxYi = Math.max(stepYi, Math.ceil((maxInflow / 1e8) / stepYi) * stepYi);
  const minYi = -Math.max(stepYi, Math.ceil((maxOutflow / 1e8) / stepYi) * stepYi);
  // 刻度间隔自适应：跨度大时翻倍，避免标签过密（目标 ≤ 10 个刻度）
  let intervalYi = stepYi;
  while ((maxYi - minYi) / intervalYi > 10) {
    intervalYi *= 2;
  }

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      confine: true,
      appendToBody: true,
      axisPointer: {
        type: 'cross',
        label: {
          backgroundColor: '#555',
          formatter: (params) => {
            // Y 轴悬浮：以亿元为单位，精确到两位小数
            if (params.axisDimension === 'y') return `${(params.value / 1e8).toFixed(2)}亿`;
            return params.value;
          },
        },
      },
      formatter: (params) => {
        if (!params || !params.length) return '';
        // 个股 Tab：按悬停的组过滤，只显示流入组或流出组（避免 20 条显示不开）
        let list = params;
        if (chartState.type === 'stock' && chartState.hoverGroup) {
          const filtered = params.filter((p) => {
            const code = chartState.seriesOrder[p.seriesIndex];
            const flow = code && chartState.flows[code];
            return flow && flow.group === chartState.hoverGroup;
          });
          if (filtered.length) list = filtered;
        }
        const t = params[0].axisValue;
        let html = `<div style="font-size:12px;margin-bottom:4px">${t}</div>`;
        list.slice().sort((a, b) => b.value - a.value).forEach((p) => {
          const v = p.value;
          const c = v > 0 ? '#e03e2d' : v < 0 ? '#0f9d58' : '#8a919f';
          const isHovered = p.seriesIndex === chartState.hoveredIndex;
          const rowStyle = isHovered ? `background:${p.color}1f;box-shadow:inset 3px 0 0 ${p.color};font-weight:700;` : '';
          html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;margin:2px 0;padding:2px 4px;border-radius:4px;${rowStyle}">
            <span style="${isHovered ? 'font-weight:700' : ''}"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>
            <span style="color:${c};font-weight:${isHovered ? 700 : 600}">${fmtYi2(v)}</span>
          </div>`;
        });
        return html;
      },
    },
    grid: { left: 56, right: 130, top: 16, bottom: 30 },
    xAxis: {
      type: 'category',
      data: timeLabels,
      boundaryGap: false,
      axisLabel: {
        color: '#8a919f', fontSize: 11, interval: 0,
        formatter: (v) => (KEY_TIMES.has(v) ? v : ''),
      },
      axisLine: { lineStyle: { color: '#d4d7dc' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      name: '主力净流入',
      min: minYi * 1e8,
      max: maxYi * 1e8,
      interval: intervalYi * 1e8,
      nameTextStyle: { color: '#8a919f', fontSize: 11 },
      axisLabel: {
        color: '#8a919f', fontSize: 11,
        formatter: (v) => `${Math.round(v / 1e8)}亿`,
      },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#f0f1f3' } },
    },
    series: items.map((it) => ({
      name: it.name,
      type: 'line',
      showSymbol: false,
      symbol: 'circle',
      symbolSize: 7,
      // 最后一个数据点显示实心圆点，作为可点击的落点
      data: it.values.map((v, i, arr) => (i === arr.length - 1 ? { value: v, symbol: 'circle', symbolSize: 8 } : v)),
      itemStyle: { color: it.color },
      lineStyle: { width: 1.5, color: it.color },
      emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
      blur: { lineStyle: { opacity: 0.15, width: 1 } },
      smooth: false,
    })),
  };
}

function renderChart() {
  if (!chartState.echarts) return;
  chartState.echarts.setOption(buildChartOption(), true);
  renderChartSide();
}

// 右侧固定列表：按当前累计值排序，颜色与线条对应，可点击下钻、悬停高亮
function renderChartSide() {
  const container = document.getElementById('chartSide');
  if (!container) return;
  const codes = chartState.seriesOrder || [];
  const items = [];
  codes.forEach((code, seriesIndex) => {
    const flow = chartState.flows[code];
    if (!flow || !flow.values.length) return;
    const current = flow.values[flow.values.length - 1];
    if (current == null) return;
    items.push({ code, name: flow.name, current, color: flow.color, seriesIndex });
  });
  items.sort((a, b) => b.current - a.current);
  container.innerHTML = items.map((it) => `
    <div class="chart-side-item" data-code="${it.code}" data-name="${it.name}" data-index="${it.seriesIndex}">
      <span class="chart-side-dot" style="background:${it.color}"></span>
      <span class="chart-side-name">${it.name}</span>
      <span class="chart-side-val ${cls(it.current)}">${fmtYi2(it.current)}</span>
    </div>
  `).join('');
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // Tab 切换
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.type = tab.dataset.type;
    chartState.type = state.type;
    syncOtherTabs('tabs');
    state.showAll = false;
    $('#loadAllBtn').textContent = '加载全部';
    loadAll();
    loadChartData();
  });

  // 板块表格列头排序
  $('#boardTable thead').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const field = th.dataset.field;
    if (state.sortField === field) {
      state.sortOrder = state.sortOrder === 1 ? 0 : 1;
    } else {
      state.sortField = field;
      state.sortOrder = 1;
    }
    updateSortHeader();
    loadAll();
  });

  // 个股下钻表格列头排序
  $('#stockTable thead').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    const field = th.dataset.field;
    if (stockState.sortField === field) {
      stockState.sortOrder = stockState.sortOrder === 1 ? 0 : 1;
    } else {
      stockState.sortField = field;
      stockState.sortOrder = 1;
    }
    updateStockSortHeader();
    renderStocks(stockState.list);
  });

  // 板块点击 -> 下钻（个股资金 Tab 不下钻）
  $('#boardBody').addEventListener('click', (e) => {
    if (state.type === 'stock') return;
    const tr = e.target.closest('tr[data-code]');
    if (!tr) return;
    openDrawer(tr.dataset.code, tr.dataset.name);
  });

  // 抽屉关闭
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // 加载全部
  $('#loadAllBtn').addEventListener('click', () => {
    state.showAll = !state.showAll;
    $('#loadAllBtn').textContent = state.showAll ? '只看前50' : '加载全部';
    $('#intervalLabel').textContent = currentInterval();
    setupTimer();
    loadAll();
  });

  // 自动刷新
  $('#autoRefresh').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    setupTimer();
  });

  // 手动刷新
  $('#refreshBtn').addEventListener('click', () => loadAll());

  // 图表 Tab 切换
  $('#chartTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || tab.classList.contains('active')) return;
    document.querySelectorAll('#chartTabs .tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    chartState.type = tab.dataset.type;
    state.type = chartState.type;
    syncOtherTabs('chartTabs');
    loadChartData();
    loadAll();
  });

  // 图表刷新
  $('#chartClearBtn').addEventListener('click', loadChartData);

  // 右侧列表项点击 → 打开板块成分股详情
  $('#chartSide').addEventListener('click', (e) => {
    const item = e.target.closest('.chart-side-item');
    if (!item || chartState.type === 'stock') return;
    const code = item.dataset.code;
    const name = item.dataset.name;
    if (code) openDrawer(code, name);
  });

  // 鼠标悬停列表项 → 高亮对应曲线（其他曲线半透明），移出恢复
  const highlightSeries = (e) => {
    const item = e.target.closest('.chart-side-item');
    if (!item || !chartState.echarts) return;
    const idx = parseInt(item.dataset.index, 10);
    if (!isNaN(idx)) chartState.echarts.dispatchAction({ type: 'highlight', seriesIndex: idx });
  };
  const downplaySeries = (e) => {
    const item = e.target.closest('.chart-side-item');
    if (!item || !chartState.echarts) return;
    const idx = parseInt(item.dataset.index, 10);
    if (!isNaN(idx)) chartState.echarts.dispatchAction({ type: 'downplay', seriesIndex: idx });
  };
  $('#chartSide').addEventListener('mouseover', highlightSeries);
  $('#chartSide').addEventListener('mouseout', downplaySeries);
}

// 联动同步另一个 Tab 组的高亮
function syncOtherTabs(sourceId) {
  const targetId = sourceId === 'tabs' ? 'chartTabs' : 'tabs';
  const src = document.querySelector(`#${sourceId} .tab.active`);
  if (!src) return;
  const type = src.dataset.type;
  document.querySelectorAll(`#${targetId} .tab`).forEach((t) => t.classList.remove('active'));
  const tgt = document.querySelector(`#${targetId} .tab[data-type="${type}"]`);
  if (tgt) tgt.classList.add('active');
}

// 更新板块表格排序列头的高亮与箭头
function updateSortHeader() {
  document.querySelectorAll('#boardTable th.sortable').forEach((th) => {
    th.classList.remove('active', 'asc', 'desc');
    if (th.dataset.field === state.sortField) {
      th.classList.add('active', state.sortOrder === 1 ? 'desc' : 'asc');
    }
  });
}

// 更新个股表格排序列头的高亮与箭头
function updateStockSortHeader() {
  document.querySelectorAll('#stockTable th.sortable').forEach((th) => {
    th.classList.remove('active', 'asc', 'desc');
    if (th.dataset.field === stockState.sortField) {
      th.classList.add('active', stockState.sortOrder === 1 ? 'desc' : 'asc');
    }
  });
}

function currentInterval() {
  // 加载全部时请求量大，自动降频到 15 秒，避免触发接口限流
  return state.showAll ? 15 : state.intervalSec;
}

function setupTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.autoRefresh) {
    state.timer = setInterval(() => {
      if (!document.hidden) loadAll();
    }, currentInterval() * 1000);
  }
}

/* ---------- 启动 ---------- */
function init() {
  $('#intervalLabel').textContent = state.intervalSec;
  initChart();
  bindEvents();
  updateSortHeader();
  loadAll();
  loadChartData();
  setupTimer();
  setupChartTimer();
  // 每分钟刷新一次交易状态
  setInterval(updateStatus, 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
