// ============================================================
// PPT Generator - AI演讲PPT生成工具
// ============================================================

// ---- State Management ----
const STATE_KEY = 'ppt_generator_state';

const DEFAULT_DESIGN_LANG = `视觉关键词
- 深蓝色科技感
- TED风极简
- 高级留白
- 大标题 + 一句金句 + 单视觉中心
- 少字、强视觉、强节奏

全局设计规范
背景
- 主背景：#07111F（深海军蓝）
- 辅助渐变：#0B1F38 → #081018
- 局部光晕：青蓝色霓虹粒子

字体建议
- 中文标题：HarmonyOS Sans SC Bold / 思源黑体 Heavy
- 英文标题：SF Pro Display / Inter
- 正文：思源黑体 Regular

配色
- 主色：科技蓝 #4DA3FF
- 强调色：青色 #67E8F9
- 次强调：紫蓝 #7C5CFF
- 文本：#FFFFFF / #C8D4E3

页面结构
- 一页一个核心概念
- 每页最多一句核心金句
- 一张主视觉图 + 少量结构元素
- 不做复杂表格`;

// ---- 参考图内存备份（防异步时序问题）----
let __charRefImagesBackup = [];
let __refImagesBackup = [];
let __promptEditorOpen = new Set();  // 已展开的提示词编辑器

let __stepTransitioning = false;  // 步骤切换中标志，阻止 oninput 干扰

let state = {
  currentStep: 1,
  draft: {
    content: '',
    source: '',
    fileName: '',
    refImages: [],
    notes: '',
    fileContent: '',   // 附件底稿内容（用于切换）
    textContent: '',   // 粘贴文本内容（用于切换）
    activeSource: '',  // 'file' | 'text' | ''
  },
  script: {
    blocks: [],
    generated: false,
  },
  design: {
    designLanguage: DEFAULT_DESIGN_LANG,
    blocks: [],
    generated: false,
  },
  images: {
    items: [],  // { id, pageNumber, imageUrl, imageBase64, prompt, confirmed }
    generated: false,
  },
  characterRefImages: [],  // Character reference images for consistent character generation
  config: {
    textApi: { baseUrl: '', apiKey: '', model: '', apiFormat: 'openai' },
    imageApi: { baseUrl: '', apiKey: '', model: '', apiType: 'chat' },
  },
};

const IMAGES_DB_NAME = 'ppt_gen_db';
const IMAGES_STORE = 'images';

// IndexedDB helper for large image data
function openImagesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMAGES_DB_NAME, 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('ref_images')) {
        db.createObjectStore('ref_images', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveImageToDB(item) {
  try {
    const db = await openImagesDB();
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    tx.objectStore(IMAGES_STORE).put(item);
  } catch (e) {
    console.warn('Failed to save image to IndexedDB:', e);
  }
}

async function saveAllImagesToDB() {
  try {
    const db = await openImagesDB();
    const tx = db.transaction(IMAGES_STORE, 'readwrite');
    const store = tx.objectStore(IMAGES_STORE);
    state.images.items.forEach(item => store.put(item));
  } catch (e) {
    console.warn('Failed to save images to IndexedDB:', e);
  }
}

// ---- Reference images IndexedDB (人物参考图 + 参考图片) ----
async function saveRefImagesToDB() {
  try {
    const db = await openImagesDB();
    const tx = db.transaction('ref_images', 'readwrite');
    const store = tx.objectStore('ref_images');
    store.put({ key: 'char_refs', data: state.characterRefImages });
    store.put({ key: 'draft_refs', data: state.draft.refImages });
  } catch (e) {
    console.warn('Failed to save ref images to IndexedDB:', e);
  }
}

async function loadRefImagesFromDB() {
  try {
    const db = await openImagesDB();
    const tx = db.transaction('ref_images', 'readonly');
    const store = tx.objectStore('ref_images');
    const charData = await new Promise((resolve) => {
      const req = store.get('char_refs');
      req.onsuccess = () => resolve(req.result?.data || []);
      req.onerror = () => resolve([]);
    });
    const draftData = await new Promise((resolve) => {
      const req = store.get('draft_refs');
      req.onsuccess = () => resolve(req.result?.data || []);
      req.onerror = () => resolve([]);
    });
    return { characterRefImages: charData, refImages: draftData };
  } catch (e) {
    console.warn('Failed to load ref images from IndexedDB:', e);
    return { characterRefImages: [], refImages: [] };
  }
}

async function loadImagesFromDB() {
  try {
    const db = await openImagesDB();
    const tx = db.transaction(IMAGES_STORE, 'readonly');
    const store = tx.objectStore(IMAGES_STORE);
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    console.warn('Failed to load images from IndexedDB:', e);
    return [];
  }
}

function loadState() {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Deep merge to avoid losing nested properties (e.g. design.designLanguage)
      // Shallow merge would replace state.design entirely if parsed.design exists,
      // potentially dropping designLanguage if it wasn't persisted
      const mergedDesign = parsed.design
        ? { ...state.design, ...parsed.design }
        : state.design;
      state = { ...state, ...parsed };
      // Ensure designLanguage is never lost
      state.design = mergedDesign;
      if (!state.design.designLanguage) {
        state.design.designLanguage = DEFAULT_DESIGN_LANG;
      }
    }
  } catch (e) {
    console.warn('Failed to load state:', e);
  }
}

function saveState() {
  try {
    // Save state WITHOUT large base64 image data in localStorage
    const stateCopy = { ...state };
    stateCopy.images = {
      items: state.images.items.map(item => ({
        ...item,
        imageBase64: '', // Don't store base64 in localStorage (too large)
      })),
      generated: state.images.generated,
    };
    localStorage.setItem(STATE_KEY, JSON.stringify(stateCopy));
  } catch (e) {
    console.warn('Failed to save state:', e);
  }
  // 备份参考图到内存（同步，绕开 IndexedDB 异步时序问题）
  __charRefImagesBackup = state.characterRefImages.map(img => ({ name: img.name, data: img.data }));
  __refImagesBackup = state.draft.refImages.map(img => ({ name: img.name, data: img.data }));
  // Save images with base64 to IndexedDB (async, fire-and-forget)
  saveAllImagesToDB();
  saveRefImagesToDB();
}

function clearAfterStep(step) {
  if (step < 2) {
    state.script = { blocks: [], generated: false };
  }
  if (step < 3) {
    const lang = state.design.designLanguage || DEFAULT_DESIGN_LANG;
    state.design = { designLanguage: lang, blocks: [], generated: false };
  }
  if (step < 4) {
    state.images = { items: [], generated: false };
  }
  saveState();
}

// ---- Toast ----
let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-lg text-sm font-medium shadow-lg transition-opacity';
  if (type === 'error') t.classList.add('bg-[#DC2626]', 'text-white');
  else if (type === 'success') t.classList.add('bg-[#16A34A]', 'text-white');
  else t.classList.add('bg-[#0A0A0A]', 'text-white');
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ---- Step Navigation ----
function renderStepNav() {
  const steps = ['演讲底稿', '脚本拆分', '设计稿', '图片生成', '导出下载'];
  const nav = document.getElementById('stepNav');
  const navM = document.getElementById('stepNavMobile');
  const renderItems = (container, isMobile) => {
    container.innerHTML = '';
    steps.forEach((label, i) => {
      const stepNum = i + 1;
      const isDone = stepNum < state.currentStep;
      const isCurrent = stepNum === state.currentStep;
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'w-6 h-px ' + (isDone ? 'bg-[#0A0A0A]' : 'bg-[#D4D4D4]');
        container.appendChild(sep);
      }
      const item = document.createElement('button');
      item.className = 'flex items-center gap-1.5 px-2 py-1 rounded-full transition-colors ' +
        (isCurrent ? 'bg-[#0A0A0A] text-white' : isDone ? 'text-[#0A0A0A]' : 'text-[#A3A3A3]');
      item.innerHTML = `<span class="w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium ${isCurrent ? 'bg-white text-[#0A0A0A]' : isDone ? 'bg-[#0A0A0A] text-white' : 'border border-[#D4D4D4]'}">${isDone ? '✓' : stepNum}</span>` +
        (!isMobile ? `<span>${label}</span>` : `<span>${label}</span>`);
      item.onclick = () => { if (stepNum <= state.currentStep) goToStep(stepNum); };
      container.appendChild(item);
    });
  };
  renderItems(nav, false);
  renderItems(navM, true);
}

function goToStep(step) {
  if (step > 1 && !state.draft.content) {
    showToast('请先上传演讲底稿', 'error');
    return;
  }
  if (step > 2 && !state.script.generated) {
    showToast('请先生成脚本', 'error');
    return;
  }
  if (step > 3 && !state.design.generated) {
    showToast('请先生成设计稿', 'error');
    return;
  }
  if (step > 4 && !state.images.generated) {
    showToast('请先生成图片', 'error');
    return;
  }
  state.currentStep = step;
  __stepTransitioning = true;
  saveState();
  
  // 兜底：回到演讲底稿页时，如果人物参考图数据有数组但缺少内容，刷新页面恢复
  if (step === 1 && state.characterRefImages.length > 0 && !state.characterRefImages[0].data && __charRefImagesBackup.length > 0) {
    location.reload();
    return;
  }
  
  renderCurrentStep();
  setTimeout(function() { __stepTransitioning = false; }, 200);
}

function renderCurrentStep() {
  document.querySelectorAll('.step-content').forEach(el => el.classList.add('hidden'));
  const stepEl = document.getElementById('step' + state.currentStep);
  if (stepEl) stepEl.classList.remove('hidden');
  renderStepNav();
  if (state.currentStep === 1) renderStep1();
  if (state.currentStep === 2) renderStep2();
  if (state.currentStep === 3) renderStep3();
  if (state.currentStep === 4) renderStep4();
  if (state.currentStep === 5) renderStep5();
  window.scrollTo(0, 0);
}

// ---- Step 1: Upload ----
async function renderStep1() {
  // 先从内存备份恢复（同步，最快路径）
  if (state.characterRefImages.length > 0 && !state.characterRefImages[0].data && __charRefImagesBackup.length > 0) {
    state.characterRefImages = __charRefImagesBackup.map(img => ({ name: img.name, data: img.data }));
  }
  if (state.draft.refImages.length > 0 && !state.draft.refImages[0].data && __refImagesBackup.length > 0) {
    state.draft.refImages = __refImagesBackup.map(img => ({ name: img.name, data: img.data }));
  }
  // 再从 IndexedDB 恢复（兜底）
  try {
    const refData = await loadRefImagesFromDB();
    if (refData.characterRefImages.length > 0 && (!state.characterRefImages[0] || !state.characterRefImages[0].data)) {
      state.characterRefImages = refData.characterRefImages;
    }
    if (refData.refImages.length > 0 && (!state.draft.refImages[0] || !state.draft.refImages[0].data)) {
      state.draft.refImages = refData.refImages;
    }
  } catch (e) {
    console.warn('Failed to restore ref images in renderStep1:', e);
  }

  const nextBtn = document.getElementById('step1Next');
  nextBtn.disabled = !state.draft.content;

  // 附件区域
  if (state.draft.fileName) {
    document.getElementById('uploadedFile').classList.remove('hidden');
    document.getElementById('fileName').textContent = state.draft.fileName;
    document.getElementById('uploadArea').classList.add('hidden');
  } else {
    document.getElementById('uploadedFile').classList.add('hidden');
    document.getElementById('uploadArea').classList.remove('hidden');
  }

  // 来源切换按钮（仅当附件和粘贴文本都存在时显示）
  updateDraftSourceToggle();

  // 设置文本域内容：附件和粘贴文本独立
  const textarea = document.getElementById('draftText');
  if (state.draft.activeSource === 'text') {
    // 文本模式：显示粘贴的内容
    textarea.value = state.draft.textContent || state.draft.content || '';
  } else if (state.draft.fileName && !state.draft.activeSource) {
    // 刚上传附件、未选择来源时：显示文件内容作为默认
    textarea.value = state.draft.fileContent;
  } else if (state.draft.fileName) {
    // 附件模式：文本域留空，供用户另行粘贴
    textarea.value = state.draft.textContent || '';
  } else {
    textarea.value = state.draft.content || '';
  }
  renderRefImages();
  renderCharacterRefs();
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  processFile(file);
}

function handleFileDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('border-[#0A0A0A]');
  const file = event.dataTransfer.files[0];
  if (!file) return;
  processFile(file);
}

async function processFile(file) {
  const name = file.name.toLowerCase();
  try {
    let text = '';
    if (name.endsWith('.docx')) {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      text = result.value;
    } else if (name.endsWith('.xmind')) {
      const arrayBuffer = await file.arrayBuffer();
      text = await parseXmind(arrayBuffer);
    } else {
      showToast('不支持的文件格式', 'error');
      return;
    }
    state.draft.fileContent = text;
    state.draft.fileName = file.name;
    state.draft.activeSource = 'file';
    state.draft.source = 'file';
    state.draft.content = text;
    clearAfterStep(1);
    saveState();
    renderStep1();
    showToast('文件解析成功', 'success');
  } catch (e) {
    console.error('File parse error:', e);
    showToast('文件解析失败: ' + e.message, 'error');
  }
}

async function parseXmind(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  let contentJson = null;
  // xmind 8 format: content.json
  const contentFile = zip.file('content.json');
  if (contentFile) {
    const raw = await contentFile.async('string');
    contentJson = JSON.parse(raw);
  } else {
    // xmind zen format: metadata.json + content.json in subdir
    for (const [path, file] of Object.entries(zip.files)) {
      if (path.endsWith('content.json') && !file.dir) {
        const raw = await file.async('string');
        contentJson = JSON.parse(raw);
        break;
      }
    }
  }
  if (!contentJson) throw new Error('无法解析XMind文件');
  return xmindToText(contentJson);
}

function xmindToText(data) {
  const lines = [];
  function walk(node, level) {
    const indent = '  '.repeat(level);
    const title = node.title || '';
    lines.push(indent + '- ' + title);
    if (node.children && node.children.attached) {
      node.children.attached.forEach(child => walk(child, level + 1));
    }
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => walk(child, level + 1));
    }
  }
  if (Array.isArray(data)) {
    data.forEach(sheet => {
      if (sheet.rootTopic) walk(sheet.rootTopic, 0);
      else walk(sheet, 0);
    });
  } else if (data.rootTopic) {
    walk(data.rootTopic, 0);
  } else {
    walk(data, 0);
  }
  return lines.join('\n');
}

function removeFile() {
  state.draft.fileContent = '';
  state.draft.fileName = '';
  state.draft.source = '';
  if (state.draft.textContent) {
    state.draft.activeSource = 'text';
    state.draft.content = state.draft.textContent;
  } else {
    state.draft.content = '';
    state.draft.activeSource = '';
  }
  clearAfterStep(1);
  saveState();
  document.getElementById('fileInput').value = '';
  renderStep1();
}

function usePastedText() {
  const text = document.getElementById('draftText').value.trim();
  if (!text) {
    showToast('请输入演讲底稿内容', 'error');
    return;
  }
  state.draft.textContent = text;
  state.draft.activeSource = 'text';
  state.draft.source = 'text';
  state.draft.content = text;
  clearAfterStep(1);
  saveState();
  renderStep1();
  showToast('已使用粘贴内容', 'success');
}

// ---- 来源切换与自动保存 ----
function autoSaveDraftText() {
  if (__stepTransitioning) return;  // 步骤切换中忽略 oninput
  const text = document.getElementById('draftText').value;
  state.draft.textContent = text;
  state.draft.content = text;  // 始终同步到内容（无论附件/粘贴）
  if (text) {
    clearAfterStep(1);  // 内容变化时清除下游步骤
  }
  if (state.draft.activeSource === 'text' || !state.draft.fileName) {
    state.draft.source = state.draft.fileName ? 'text' : 'text';
    state.draft.activeSource = 'text';
  }
  saveState();
  updateDraftSourceToggle();
  const nextBtn = document.getElementById('step1Next');
  if (nextBtn) nextBtn.disabled = !state.draft.content;
}

function updateDraftSourceToggle() {
  var toggleEl = document.getElementById('sourceToggle');
  if (!toggleEl) return;
  var hasBoth = state.draft.fileName && state.draft.textContent;
  if (hasBoth) {
    toggleEl.classList.remove('hidden');
    var active = state.draft.activeSource || 'file';
    var fileBtn = document.getElementById('srcToggleFile');
    var textBtn = document.getElementById('srcToggleText');
    if (fileBtn) fileBtn.className = 'px-3 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ' + (active === 'file' ? 'bg-[#0A0A0A] text-white' : 'text-[#737373] hover:text-[#0A0A0A]');
    if (textBtn) textBtn.className = 'px-3 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ' + (active === 'text' ? 'bg-[#0A0A0A] text-white' : 'text-[#737373] hover:text-[#0A0A0A]');
  } else {
    toggleEl.classList.add('hidden');
  }
}

function switchDraftSource(source) {
  state.draft.activeSource = source;
  if (source === 'file' && state.draft.fileContent) {
    state.draft.content = state.draft.fileContent;
    state.draft.source = 'file';
  } else if (source === 'text' && state.draft.textContent) {
    state.draft.content = state.draft.textContent;
    state.draft.source = 'text';
  }
  clearAfterStep(1);
  saveState();
  renderStep1();
}

// Reference images
function handleRefImageSelect(event) {
  const files = Array.from(event.target.files);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.draft.refImages.push({ name: file.name, data: e.target.result });
      saveState();
      renderRefImages();
    };
    reader.readAsDataURL(file);
  });
}

function renderRefImages() {
  const container = document.getElementById('refImageContainer');
  const addBtn = container.querySelector('div');
  // Remove old images
  container.querySelectorAll('.ref-img-item').forEach(el => el.remove());
  state.draft.refImages.forEach((img, idx) => {
    const div = document.createElement('div');
    div.className = 'ref-img-item relative w-20 h-20 rounded-lg overflow-hidden border border-[#E5E5E5]';
    div.innerHTML = `<img src="${img.data}" class="w-full h-full object-cover" /><button onclick="removeRefImage(${idx})" class="absolute top-0.5 right-0.5 w-4 h-4 bg-[#DC2626] text-white rounded-full text-xs flex items-center justify-center">&times;</button>`;
    container.insertBefore(div, addBtn);
  });
}

function removeRefImage(idx) {
  state.draft.refImages.splice(idx, 1);
  saveState();
  renderRefImages();
}

// Character reference images for consistent character generation
function handleCharacterRefSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    // 只保留一张参考图
    state.characterRefImages = [{ name: file.name, data: e.target.result }];
    saveState();
    renderCharacterRefs();
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function renderCharacterRefs() {
  const container = document.getElementById('characterRefContainer');
  if (!container) return;
  
  // 移除旧的图片
  container.querySelectorAll('.char-ref-item').forEach(function(el) { el.remove(); });
  
  // 定位添加按钮，上传后隐藏它（单张限制）
  var addBtn = container.querySelector('div');
  if (state.characterRefImages.length > 0) {
    addBtn.style.display = 'none';
  } else {
    addBtn.style.display = '';
  }
  
  // 在 addButton 之前插入图片
  state.characterRefImages.forEach(function(img, idx) {
    var div = document.createElement('div');
    div.className = 'char-ref-item relative w-20 h-20 rounded-lg overflow-hidden border border-[#E5E5E5]';
    div.innerHTML = '<img src="' + img.data + '" class="w-full h-full object-cover" /><button onclick="removeCharacterRef(' + idx + ')" class="absolute top-0.5 right-0.5 w-4 h-4 bg-[#DC2626] text-white rounded-full text-xs flex items-center justify-center">&times;</button>';
    container.insertBefore(div, addBtn);
  });
}

function removeCharacterRef(idx) {
  state.characterRefImages.splice(idx, 1);
  saveState();
  renderCharacterRefs();
}

// ---- API Calls ----
function getConfig() {
  return state.config;
}

// ---- Proxy Fetch (bypass CORS) ----
// Sends API requests through local proxy server to avoid CORS issues
// 检测是否在代理模式（Node.js服务器）下运行
let _proxyAvailable = null; // null=未检测, true=可用, false=不可用
function isProxyMode() {
  if (_proxyAvailable !== null) return _proxyAvailable;
  // file:// 协议肯定没有代理
  if (window.location.protocol === 'file:') { _proxyAvailable = false; return false; }
  // 其他情况在 init 时异步检测
  return false; // 默认 false，init 检测后更新
}

// 双模式 fetch：纯静态模式直接请求，CORS 失败时提示用户；代理模式走 /api/proxy
async function proxyFetch(targetUrl, options = {}) {
  const { method = 'POST', headers = {}, body = null } = options;

  // 代理模式：通过 /api/proxy 转发（规避CORS）
  if (isProxyMode()) {
    try {
      const resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, method, headers, body: body ? JSON.parse(body) : null }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        let errMsg = errText;
        try { const e = JSON.parse(errText); errMsg = e.error || errText; } catch(_) {}
        throw new Error('API请求失败(' + resp.status + '): ' + errMsg.substring(0, 300));
      }
      return resp;
    } catch (err) {
      if (err.message.startsWith('API请求失败')) throw err;
      throw new Error('网络请求失败: ' + err.message);
    }
  }

  // 纯静态模式：直接请求（依赖API本身支持CORS）
  try {
    const fetchOptions = { method, headers: { ...headers } };
    if (body && method !== 'GET') {
      fetchOptions.body = body;
    }
    const resp = await fetch(targetUrl, fetchOptions);
    if (!resp.ok) {
      const errText = await resp.text();
      let errMsg = errText;
      try { const e = JSON.parse(errText); errMsg = e.error || errText; } catch(_) {}
      throw new Error('API请求失败(' + resp.status + '): ' + errMsg.substring(0, 300));
    }
    return resp;
  } catch (err) {
    if (err.message.startsWith('API请求失败')) throw err;
    // CORS 失败的典型表现是 TypeError
    if (err instanceof TypeError) {
      throw new Error('网络请求失败（可能是CORS跨域限制）。建议：1)确保API支持跨域访问；2)或使用 "node server.js" 启动代理模式运行');
    }
    throw new Error('网络请求失败: ' + err.message);
  }
}

async function callTextAPI(messages) {
  const cfg = getConfig().textApi;
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error('请先在设置中配置文字生成API');
  }
  const format = cfg.apiFormat || 'openai';

  if (format === 'anthropic') {
    // Anthropic format: /v1/messages
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/messages';
    // Convert messages: system must be separate, content must be string
    let systemMsg = '';
    const convertedMsgs = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMsg += (systemMsg ? '\n' : '') + msg.content;
      } else {
        convertedMsgs.push({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
      }
    }
    const body = {
      model: cfg.model,
      messages: convertedMsgs,
      max_tokens: 16384,
    };
    if (systemMsg) body.system = systemMsg;
    let resp;
    try {
      resp = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
    } catch (fetchErr) {
      throw new Error('文字API请求失败: ' + fetchErr.message);
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('API请求失败: ' + resp.status + ' ' + errText.substring(0, 300));
    }
    const data = await resp.json();
    // Anthropic response: { content: [{ type: "text", text: "..." }] }
    const content = data.content;
    if (Array.isArray(content)) {
      return content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    return typeof content === 'string' ? content : JSON.stringify(content);
  } else {
    // OpenAI compatible format: /v1/chat/completions
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    let resp;
    try {
      resp = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.7,
          max_tokens: 16384,
        }),
      });
    } catch (fetchErr) {
      throw new Error('文字API请求失败: ' + fetchErr.message);
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('API请求失败: ' + resp.status + ' ' + errText.substring(0, 300));
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

async function callImageAPI(prompt, refImages = [], currentImage = null) {
  const cfg = getConfig().imageApi;
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error('请先在设置中配置图片生成API');
  }

  if (cfg.apiType === 'chat') {
    // Use chat completions endpoint for image generation
    let baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    // Remove trailing /v1 or /v1/chat/completions if user included it
    baseUrl = baseUrl.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '');
    const url = baseUrl + '/v1/chat/completions';
    
    // Build message content - support reference images for consistent character generation
    let messageContent;
    if (refImages && refImages.length > 0 || currentImage) {
      // Multi-modal content with images + text
      messageContent = [];
      // Text prompt FIRST (per API docs: text before images)
      messageContent.push({
        type: 'text',
        text: prompt
      });
      // Add current image (if editing) for targeted modification
      if (currentImage) {
        messageContent.push({
          type: 'image_url',
          image_url: { url: currentImage }
        });
      }
      // Add character reference images
      if (refImages && refImages.length > 0) {
        for (const refImg of refImages) {
          const imgData = refImg.data || refImg;
          if (imgData.startsWith('data:')) {
            messageContent.push({
              type: 'image_url',
              image_url: { url: imgData }
            });
          } else if (imgData.startsWith('http')) {
            messageContent.push({
              type: 'image_url',
              image_url: { url: imgData }
            });
          }
        }
      }
    } else {
      // Text-only content (must be array for gpt-image-2)
      messageContent = [{ type: 'text', text: prompt }];
    }
    
    // 为 gpt-image-2 添加固定后缀，确保返回干净结果
    if (messageContent.length > 0) {
      var lastItem = messageContent[messageContent.length - 1];
      if (lastItem.type === 'text') {
        lastItem.text = lastItem.text + '\n\nGenerate exactly one image asset. Return only the image result.';
      }
    }
    
    let resp;
    try {
      resp = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: messageContent }],
          size: '1536x1024',
        }),
      });
    } catch (fetchErr) {
      throw new Error('图片API请求失败: ' + fetchErr.message);
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('图片API请求失败(' + resp.status + '): ' + errText.substring(0, 200));
    }
    const d = await resp.json();
    // 标准返回格式（文档推荐优先读取）：data[].url
    if (d.data && Array.isArray(d.data) && d.data.length > 0 && d.data[0].url) {
      return d.data[0].url;
    }
    const msgContent = d.choices?.[0]?.message?.content;
    
    // gpt-image style: content is an array with image objects
    if (Array.isArray(msgContent)) {
      for (const item of msgContent) {
        if (item.type === 'image_url' && item.image_url?.url) return item.image_url.url;
        if (item.type === 'input_image' && item.input_image?.url) return item.input_image.url;
        if (item.type === 'input_image' && item.input_image?.base64) return 'data:image/png;base64,' + item.input_image.base64;
        // Some APIs return base64 directly
        if (item.type === 'image' && item.image?.url) return item.image.url;
        if (item.type === 'image' && item.image?.base64) return 'data:image/png;base64,' + item.image.base64;
      }
      // Try to find any URL in the array items
      for (const item of msgContent) {
        if (typeof item === 'object') {
          const vals = Object.values(item);
          for (const v of vals) {
            if (typeof v === 'string' && v.startsWith('data:image')) return v;
            if (typeof v === 'string' && v.startsWith('http') && /\.(png|jpg|jpeg|webp)/i.test(v)) return v;
          }
          // Nested objects
          if (typeof item === 'object' && item !== null) {
            for (const nested of Object.values(item)) {
              if (typeof nested === 'string' && nested.startsWith('data:image')) return nested;
              if (typeof nested === 'string' && nested.startsWith('http') && /\.(png|jpg|jpeg|webp)/i.test(nested)) return nested;
            }
          }
        }
      }
    }
    
    // Text content - try to extract image URL/base64 from text
    if (typeof msgContent === 'string') {
      // Check for base64 data URL
      const b64Match = msgContent.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
      if (b64Match) return b64Match[0];
      // Check for URL
      const urlMatch = msgContent.match(/https?:\/\/[^\s"')\]]+\.(png|jpg|jpeg|webp)/i);
      if (urlMatch) return urlMatch[0];
      // Check for markdown image
      const mdMatch = msgContent.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      if (mdMatch) return mdMatch[1];
      // Maybe the whole content is a URL
      if (msgContent.trim().startsWith('http')) return msgContent.trim();
    }
    throw new Error('无法从响应中提取图片，响应结构: ' + JSON.stringify(d).substring(0, 800));
  } else {
    // Use images/generations endpoint
    let baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    baseUrl = baseUrl.replace(/\/v1\/images\/generations\/?$/, '').replace(/\/v1\/?$/, '');
    const url = baseUrl + '/v1/images/generations';
    let resp;
    try {
      resp = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey,
        },
        body: JSON.stringify({
          model: cfg.model,
          prompt,
          n: 1,
          size: '1792x1024',
          response_format: 'b64_json',
        }),
      });
    } catch (fetchErr) {
      throw new Error('图片API请求失败: ' + fetchErr.message);
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('图片API请求失败(' + resp.status + '): ' + errText.substring(0, 200));
    }
    const data = await resp.json();
    const imgData = data.data?.[0];
    if (imgData?.b64_json) return 'data:image/png;base64,' + imgData.b64_json;
    if (imgData?.url) return imgData.url;
    throw new Error('无法从响应中提取图片，响应结构: ' + JSON.stringify(data).substring(0, 500));
  }
}

// ---- JSON Extraction from AI Response ----
function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    console.error('extractJSON: raw is not a string:', typeof raw, raw);
    return null;
  }

  console.log('extractJSON: raw length =', raw.length);
  console.log('extractJSON: first 300 chars =', raw.substring(0, 300));
  console.log('extractJSON: last 300 chars =', raw.substring(raw.length - 300));

  // Method 1: ```json code block (greedy match)
  const jsonBlockMatch = raw.match(/```json\s*([\s\S]*)\s*```/);
  if (jsonBlockMatch) {
    const parsed = tryParseWithFix(jsonBlockMatch[1].trim());
    if (parsed !== null) {
      console.log('extractJSON: Method 1 (json code block) succeeded');
      return parsed;
    }
    console.warn('extractJSON: Method 1 (json code block) all fix attempts failed');
  }

  // Method 2: ``` code block starting with [ (greedy match)
  const codeBlockMatch = raw.match(/```\s*([\s\S]*)\s*```/);
  if (codeBlockMatch && codeBlockMatch[1].trim().startsWith('[')) {
    const parsed = tryParseWithFix(codeBlockMatch[1].trim());
    if (parsed !== null) {
      console.log('extractJSON: Method 2 (code block) succeeded');
      return parsed;
    }
    console.warn('extractJSON: Method 2 (code block) all fix attempts failed');
  }

  // Method 3: Find [ ... ] directly using bracket counting
  const startIdx = raw.indexOf('[');
  if (startIdx !== -1) {
    let depth = 0;
    let endIdx = -1;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (depth === 0) { endIdx = i; break; }
    }
    if (endIdx > startIdx) {
      const parsed = tryParseWithFix(raw.substring(startIdx, endIdx + 1));
      if (parsed !== null) {
        console.log('extractJSON: Method 3 (bracket counting) succeeded');
        return parsed;
      }
    }
    // Fallback: lastIndexOf
    const lastEnd = raw.lastIndexOf(']');
    if (lastEnd > startIdx) {
      const parsed = tryParseWithFix(raw.substring(startIdx, lastEnd + 1));
      if (parsed !== null) {
        console.log('extractJSON: Method 3 fallback (lastIndexOf) succeeded');
        return parsed;
      }
    }
  }

  // Method 4: Find { ... } for object
  const objStart = raw.indexOf('{');
  if (objStart !== -1) {
    let depth = 0;
    let endIdx = -1;
    let inString = false;
    let escape = false;
    for (let i = objStart; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (depth === 0) { endIdx = i; break; }
    }
    if (endIdx > objStart) {
      const parsed = tryParseWithFix(raw.substring(objStart, endIdx + 1));
      if (parsed !== null) {
        console.log('extractJSON: Method 4 (bracket counting object) succeeded');
        return parsed;
      }
    }
  }

  // Method 5: Last resort - try to find any JSON array from the raw text
  const arrayStart = raw.indexOf('[');
  if (arrayStart !== -1) {
    const parsed = tryParseWithFix(raw.substring(arrayStart));
    if (parsed !== null) {
      console.log('extractJSON: Method 5 (raw tail) succeeded');
      return parsed;
    }
  }

  console.error('extractJSON: All methods failed');
  return null;
}

// Try parsing JSON with multiple fix strategies
function tryParseWithFix(jsonStr) {
  // Attempt 1: Direct parse
  try {
    return JSON.parse(jsonStr);
  } catch(e) {}

  // Attempt 2: Close unclosed brackets
  let fixed = closeUnclosedBrackets(jsonStr);
  try {
    return JSON.parse(fixed);
  } catch(e) {}

  // Attempt 3: Fix unterminated strings - truncate at last complete value
  fixed = fixUnterminatedStrings(jsonStr);
  try {
    return JSON.parse(fixed);
  } catch(e) {}

  // Attempt 4: Combine both fixes
  fixed = fixUnterminatedStrings(jsonStr);
  fixed = closeUnclosedBrackets(fixed);
  try {
    return JSON.parse(fixed);
  } catch(e) {}

  return null;
}

// Close unclosed [ and { brackets
function closeUnclosedBrackets(jsonStr) {
  let depth = 0;
  let inString = false;
  let escape = false;
  const stack = [];
  
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') { depth++; stack.push(']'); }
    if (ch === '{') { depth++; stack.push('}'); }
    if (ch === ']' || ch === '}') {
      depth--;
      stack.pop();
    }
  }
  
  let result = jsonStr;
  while (stack.length > 0) {
    result += stack.pop();
  }
  return result;
}

// Fix unterminated strings by truncating at the last complete element
function fixUnterminatedStrings(jsonStr) {
  // Strategy: find the last complete top-level array element
  // by tracking bracket depth relative to the top-level array
  
  const topStart = jsonStr.indexOf('[');
  if (topStart === -1) return jsonStr;
  
  let depth = 0;       // relative to top-level array
  let inString = false;
  let escape = false;
  let lastCompleteElementEnd = -1;  // position right after last complete element at depth=1
  
  for (let i = topStart; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    
    if (ch === '[' || ch === '{') {
      depth++;
    }
    if (ch === ']' || ch === '}') {
      depth--;
      // depth=0 means we closed the top-level array
      // depth=1 means we just closed an element inside the top-level array
      if (depth === 1) {
        // Just finished a top-level element
        let j = i + 1;
        // Skip whitespace
        while (j < jsonStr.length && ' \n\r\t'.includes(jsonStr[j])) j++;
        if (j < jsonStr.length && jsonStr[j] === ',') {
          lastCompleteElementEnd = j + 1;  // include the comma
        } else {
          lastCompleteElementEnd = i + 1;  // just after the closing bracket
        }
      }
    }
  }
  
  // If no unterminated string and brackets are balanced, return as-is
  if (!inString && depth === 0) return jsonStr;
  
  // If we found at least one complete element, truncate there and close the top-level array
  if (lastCompleteElementEnd > 0) {
    let result = jsonStr.substring(0, lastCompleteElementEnd);
    // Remove trailing comma if present
    result = result.replace(/,\s*$/, '');
    result += ']';
    return result;
  }
  
  // Fallback: no complete elements found, can't salvage
  return jsonStr;
}

// ---- Selection State ----
const selectionState = {
  step2: new Set(),  // script block indices
  step3: new Set(),  // design block indices
  step4: new Set(),  // image item indices
};

function toggleSelect(step, idx) {
  const sel = selectionState[step];
  if (sel.has(idx)) sel.delete(idx); else sel.add(idx);
  updateSelectToolbar(step);
  updateCheckboxes(step);
}

function selectAll(step) {
  const sel = selectionState[step];
  sel.clear();
  const count = step === 'step2' ? state.script.blocks.length
    : step === 'step3' ? state.design.blocks.length
    : state.images.items.length;
  for (let i = 0; i < count; i++) sel.add(i);
  updateSelectToolbar(step);
  updateCheckboxes(step);
}

function invertSelect(step) {
  const sel = selectionState[step];
  const count = step === 'step2' ? state.script.blocks.length
    : step === 'step3' ? state.design.blocks.length
    : state.images.items.length;
  const newSel = new Set();
  for (let i = 0; i < count; i++) {
    if (!sel.has(i)) newSel.add(i);
  }
  selectionState[step] = newSel;
  updateSelectToolbar(step);
  updateCheckboxes(step);
}

function deselectAll(step) {
  selectionState[step].clear();
  updateSelectToolbar(step);
  updateCheckboxes(step);
}

function updateCheckboxes(step) {
  const sel = selectionState[step];
  const prefix = step + '-chk-';
  document.querySelectorAll(`[id^="${prefix}"]`).forEach(cb => {
    const idx = parseInt(cb.id.substring(prefix.length));
    cb.checked = sel.has(idx);
  });
  // Also update the "select all" checkbox state
  const allCb = document.getElementById(step + '-chk-all');
  if (allCb) {
    const count = step === 'step2' ? state.script.blocks.length
      : step === 'step3' ? state.design.blocks.length
      : state.images.items.length;
    allCb.checked = count > 0 && sel.size === count;
    allCb.indeterminate = sel.size > 0 && sel.size < count;
  }
}

function updateSelectToolbar(step) {
  const sel = selectionState[step];
  const bar = document.getElementById(step + '-select-bar');
  if (!bar) return;
  const count = step === 'step2' ? state.script.blocks.length
    : step === 'step3' ? state.design.blocks.length
    : state.images.items.length;
  // Show toolbar when there are blocks
  bar.style.display = count > 0 ? 'flex' : 'none';
  const countEl = document.getElementById(step + '-select-count');
  if (countEl) countEl.textContent = sel.size > 0 ? '已选 ' + sel.size + ' 项' : '';
}

function toggleSelectAll(step) {
  const sel = selectionState[step];
  const count = step === 'step2' ? state.script.blocks.length
    : step === 'step3' ? state.design.blocks.length
    : state.images.items.length;
  if (sel.size === count) {
    deselectAll(step);
  } else {
    selectAll(step);
  }
}

// Batch delete for script blocks
function batchDeleteScriptBlocks() {
  const sel = selectionState.step2;
  if (sel.size === 0) return;
  if (!confirm('确认删除选中的 ' + sel.size + ' 个页面？')) return;
  const indices = Array.from(sel).sort((a, b) => b - a);
  for (const idx of indices) {
    state.script.blocks.splice(idx, 1);
  }
  clearAfterStep(2);
  sel.clear();
  saveState();
  renderStep2();
}

// Batch delete for design blocks
function batchDeleteDesignBlocks() {
  const sel = selectionState.step3;
  if (sel.size === 0) return;
  if (!confirm('确认删除选中的 ' + sel.size + ' 个页面？')) return;
  const indices = Array.from(sel).sort((a, b) => b - a);
  for (const idx of indices) {
    state.design.blocks.splice(idx, 1);
  }
  state.images = { items: [], generated: false };
  sel.clear();
  saveState();
  renderStep3();
}

// Batch generate for images
async function batchGenerateImages() {
  const sel = selectionState.step4;
  if (sel.size === 0) return;
  const indices = Array.from(sel).sort((a, b) => a - b);
  const status = document.getElementById('imageGenStatus');
  
  for (let i = 0; i < indices.length; i++) {
    status.textContent = `正在生成选中 ${i + 1}/${indices.length}...`;
    await generateSingleImage(indices[i]);
  }
  
  status.textContent = '选中页面生成完成';
  sel.clear();
  updateSelectToolbar('step4');
  updateCheckboxes('step4');
}

// Batch confirm for images

function clearImageItem(idx) {
  state.images.items[idx].imageUrl = '';
  state.images.items[idx].imageBase64 = '';
  state.images.generated = state.images.items.every(function(it) { return it.imageBase64 || it.imageUrl; });
  saveState();
  renderImageBlocks();
  
  // Update next button
  var nextBtn = document.getElementById('step4Next');
  if (nextBtn) nextBtn.disabled = !state.images.generated;
}

function deleteImageItem(idx) {
  if (!confirm('确定删除这一页图片吗？')) return;
  state.images.items.splice(idx, 1);
  selectionState.step4.clear();
  saveState();
  renderStep4();
}

function batchDeleteImages() {
  const sel = selectionState.step4;
  if (sel.size === 0) return;
  if (!confirm(`确定删除选中的 ${sel.size} 页图片吗？`)) return;
  const indices = Array.from(sel).sort((a, b) => b - a);
  for (const idx of indices) {
    state.images.items.splice(idx, 1);
  }
  sel.clear();
  saveState();
  renderStep4();
}

// ---- Step 2: Script ----
function renderStep2() {
  const blocksContainer = document.getElementById('scriptBlocks');
  const addArea = document.getElementById('addBlockArea');
  const nextBtn = document.getElementById('step2Next');
  const genArea = document.getElementById('scriptGenArea');

  nextBtn.disabled = !state.script.generated;
  addArea.classList.toggle('hidden', !state.script.generated);
  document.getElementById('scriptGenStatus').textContent = '';

  if (!state.script.generated) {
    blocksContainer.innerHTML = '<div class="text-center py-12 text-[#737373]"><p>点击下方按钮生成演讲脚本拆分</p></div>';
    document.getElementById('genScriptBtn').textContent = '生成脚本';
    return;
  }

  document.getElementById('genScriptBtn').textContent = '重新生成脚本';

  renderScriptBlocks();
}

function renderScriptBlocks() {
  const container = document.getElementById('scriptBlocks');
  container.innerHTML = '';
  state.script.blocks.forEach((block, idx) => {
    const typeLabels = { cover: '主题页', speaker: '嘉宾页', toc: '目录页', chapter: '章节首页', content: '内容页' };
    const div = document.createElement('div');
    div.className = 'script-block p-4 border border-[#E5E5E5] rounded-lg bg-white hover:shadow-sm transition-shadow';
    div.dataset.id = block.id;
    const checked = selectionState.step2.has(idx) ? 'checked' : '';
    div.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <input type="checkbox" id="step2-chk-${idx}" ${checked} onchange="toggleSelect('step2', ${idx})" class="w-4 h-4 rounded border-[#D4D4D4] cursor-pointer" />
          <span class="inline-flex items-center justify-center w-8 h-6 bg-[#0A0A0A] text-white text-xs font-mono rounded">P${idx + 1}</span>
          <span class="text-xs text-[#737373] bg-[#F5F5F5] px-2 py-0.5 rounded">${typeLabels[block.type] || block.type}</span>
          <span class="text-sm font-medium">${escapeHtml(block.title)}</span>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="editScriptBlock(${idx})" class="text-xs text-[#2563EB] hover:underline">编辑</button>
          <button onclick="deleteScriptBlock(${idx})" class="text-xs text-[#DC2626] hover:underline">删除</button>
        </div>
      </div>
      <div class="text-sm text-[#525252] line-clamp-3">${escapeHtml(block.content)}</div>
    `;
    container.appendChild(div);
  });

  // Init sortable
  if (typeof Sortable !== 'undefined') {
    new Sortable(container, {
      animation: 150,
      handle: '.script-block',
      onEnd: (evt) => {
        const moved = state.script.blocks.splice(evt.oldIndex, 1)[0];
        state.script.blocks.splice(evt.newIndex, 0, moved);
        saveState();
        selectionState.step2.clear();
        renderScriptBlocks();
      },
    });
  }

  updateSelectToolbar('step2');
  updateCheckboxes('step2');
}

function editScriptBlock(idx) {
  const block = state.script.blocks[idx];
  const modal = document.getElementById('scriptEditModal');
  const textarea = document.getElementById('scriptEditTextarea');
  document.getElementById('scriptEditTitle').textContent = 'P' + (idx + 1) + ': ' + block.title;
  textarea.value = block.content;
  modal.dataset.idx = idx;
  modal.classList.remove('hidden');
  textarea.focus();
}

function saveScriptEdit() {
  const modal = document.getElementById('scriptEditModal');
  const idx = parseInt(modal.dataset.idx);
  const textarea = document.getElementById('scriptEditTextarea');
  state.script.blocks[idx].content = textarea.value;
  saveState();
  modal.classList.add('hidden');
  renderScriptBlocks();
}

function cancelScriptEdit() {
  document.getElementById('scriptEditModal').classList.add('hidden');
}

function deleteScriptBlock(idx) {
  if (!confirm('确定删除 P' + (idx + 1) + '？')) return;
  state.script.blocks.splice(idx, 1);
  saveState();
  renderScriptBlocks();
}

function addScriptBlock() {
  const title = prompt('新页面标题:');
  if (!title) return;
  state.script.blocks.push({
    id: 'block-' + Date.now(),
    type: 'content',
    title,
    content: '',
    chapterId: '',
    chapterTitle: '',
  });
  saveState();
  renderScriptBlocks();
}

// Design edit modal functions
function openDesignEditModal(idx) {
  const modal = document.getElementById('designEditModal');
  const textarea = document.getElementById('designEditTextarea');
  const block = state.design.blocks[idx];
  modal.dataset.idx = idx;
  document.getElementById('designEditTitle').textContent = '编辑 P' + (idx + 1) + ' - ' + (block.title || '');
  // Format all fields into one text area for editing
  let text = '';
  text += '【标题】\n' + (block.title || '') + '\n\n';
  text += '【核心金句】\n' + (block.goldenSentence || '') + '\n\n';
  text += '【视觉设计】\n' + (block.visualDesign || '') + '\n\n';
  text += '【配图Prompt】\n' + (block.imagePrompt || '');
  textarea.value = text;
  modal.classList.remove('hidden');
  textarea.focus();
}

function saveDesignEdit() {
  const modal = document.getElementById('designEditModal');
  const idx = parseInt(modal.dataset.idx);
  const textarea = document.getElementById('designEditTextarea');
  const text = textarea.value;
  
  // Validate idx
  if (isNaN(idx) || !state.design.blocks[idx]) {
    console.error('saveDesignEdit: invalid idx', idx, 'blocks length:', state.design.blocks.length);
    modal.classList.add('hidden');
    return;
  }
  
  // Parse fields from text using section markers
  const sections = {};
  const sectionRegex = /【([^】]+)】\s*\n/g;
  let match;
  const positions = [];
  while ((match = sectionRegex.exec(text)) !== null) {
    positions.push({ label: match[1], start: match.index + match[0].length });
  }
  
  // Extract content between each section marker
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].label.length - 3 : text.length;
    const content = text.substring(start, end).trim();
    sections[positions[i].label] = content;
  }
  
  console.log('saveDesignEdit: parsed sections', sections);
  
  // Map section names to block fields
  const block = state.design.blocks[idx];
  if (sections['标题'] !== undefined) block.title = sections['标题'];
  if (sections['核心金句'] !== undefined) block.goldenSentence = sections['核心金句'];
  if (sections['视觉设计'] !== undefined) block.visualDesign = sections['视觉设计'];
  if (sections['配图Prompt'] !== undefined) block.imagePrompt = sections['配图Prompt'];
  
  saveState();
  modal.classList.add('hidden');
  renderDesignBlocks();
}

function cancelDesignEdit() {
  document.getElementById('designEditModal').classList.add('hidden');
}

// ---- Import Design ----
function openImportDesignModal() {
  const modal = document.getElementById('importDesignModal');
  // 预填充当前设计语言
  document.getElementById('importDesignLang').value = state.design.designLanguage || '';
  document.getElementById('importDesignContent').value = '';
  modal.classList.remove('hidden');
}

function closeImportDesignModal() {
  document.getElementById('importDesignModal').classList.add('hidden');
}

async function importDesignBlocks() {
  const modal = document.getElementById('importDesignModal');
  const designLang = document.getElementById('importDesignLang').value.trim();
  const content = document.getElementById('importDesignContent').value.trim();
  
  if (!content) {
    showToast('请粘贴设计稿内容', 'error');
    return;
  }
  
  // 关闭弹窗
  modal.classList.add('hidden');
  
  const btn = document.getElementById('genDesignBtn');
  const status = document.getElementById('designGenStatus');
  btn.disabled = true;
  btn.textContent = '导入中...';
  status.textContent = '正在调用AI拆分设计稿...';
  
  try {
    // 保存设计语言
    const savedDesignLang = designLang || state.design.designLanguage || DEFAULT_DESIGN_LANG;
    state.design = { designLanguage: savedDesignLang, blocks: [], generated: false };
    state.images = { items: [], generated: false };
    saveState();
    
    const prompt = `你是一个内容提取工具，只做提取工作，不做任何生成或改写。

以下是需要提取的完整设计稿内容：
${content}

【核心原则】原封不动提取，不添加、不修改、不发挥、不美化！

请按以下JSON数组格式返回提取结果（直接返回JSON，不要任何其他文字）：
[
  {
    "pageNumber": 页码数字,
    "title": "提取的标题",
    "goldenSentence": "提取的文字/金句内容",
    "visualDesign": "提取的插画/视觉描述",
    "imagePrompt": "提取的英文Prompt"
  }
]

提取规则（严格遵守）：
1. 识别分页：通过"PX"、"第X页"、"Page X"、数字编号加空行等方式识别每页开始
2. 提取标题：通常是PX后面的文字，或明确标注的"标题：xxx"
3. 提取文字/金句：找"文字"、"金句"、"内容"等标签后的段落，原封不动复制
4. 提取视觉/插画描述：找"插画"、"视觉"、"描述"等标签后的段落，原封不动复制
5. 提取Prompt：找"Prompt"、"配图"、"提示词"等标签后的英文内容，原封不动复制
6. 【重要】找不到的字段留空字符串""，绝对不要自己生成内容！
7. 【重要】提取的内容必须是原文中已有的，一字不改地复制过来！

示例输入：
P7 烟雨江南
文字
雨天还会把世界变得特别美。
亭子、长廊、荷花池，
都像画里一样。
插画
江南园林。雨雾中的亭台。荷花池。
Prompt
Misty Jiangnan garden in rain, pavilion, covered corridor, lotus pond, poetic watercolor illustration

示例输出：
[
  {
    "pageNumber": 7,
    "title": "烟雨江南",
    "goldenSentence": "雨天还会把世界变得特别美。亭子、长廊、荷花池，都像画里一样。",
    "visualDesign": "江南园林。雨雾中的亭台。荷花池。",
    "imagePrompt": "Misty Jiangnan garden in rain, pavilion, covered corridor, lotus pond, poetic watercolor illustration"
  }
]

注意：上面示例中的内容都是原封不动从输入提取的，没有添加任何新内容！`;

    const raw = await callTextAPI([{ role: 'user', content: prompt }]);
    console.log('Import design response length:', raw.length);
    
    const blocks = extractJSON(raw);
    if (!blocks || !Array.isArray(blocks)) {
      const debugEl = document.getElementById('designDebugArea');
      if (debugEl) {
        debugEl.style.display = 'block';
        debugEl.querySelector('pre').textContent = raw.substring(0, 2000) + (raw.length > 2000 ? '\n...(truncated)' : '');
      }
      throw new Error('AI返回的内容无法解析为JSON数组');
    }
    
    state.design.blocks = blocks.map((b, i) => ({
      id: 'design-' + Date.now() + '-' + i,
      pageNumber: b.pageNumber || i + 1,
      title: b.title || '未命名',
      goldenSentence: b.goldenSentence || '',
      visualDesign: b.visualDesign || '',
      imagePrompt: b.imagePrompt || '',
      scriptBlockId: state.script.blocks[i]?.id || '',
    }));
    state.design.generated = true;
    
    // 确保 designLanguage 被保留
    if (!state.design.designLanguage) {
      state.design.designLanguage = savedDesignLang;
    }
    
    saveState();
    renderStep3();
    status.textContent = '';
    showToast('设计稿导入成功！共 ' + state.design.blocks.length + ' 页', 'success');
  } catch (e) {
    console.error('Import design error:', e);
    showToast('设计稿导入失败: ' + e.message, 'error');
    status.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = state.design.generated ? '重新生成设计稿' : '生成设计稿';
  }
}

async function generateScript() {
  // 重新生成时清除当前及后续步骤数据，但保留设计语言
  const savedDesignLang = state.design.designLanguage || DEFAULT_DESIGN_LANG;
  state.script = { blocks: [], generated: false };
  state.design = { designLanguage: savedDesignLang, blocks: [], generated: false };
  state.images = { items: [], generated: false };
  saveState();

  const btn = document.getElementById('genScriptBtn');
  const status = document.getElementById('scriptGenStatus');
  btn.disabled = true;
  btn.textContent = '生成中...';
  status.textContent = '正在调用AI生成脚本...';

  try {
    const prompt = `你是一个专业的演讲PPT脚本生成专家。请根据以下演讲底稿，生成演讲PPT的脚本拆分。

规则：
1. 第一页是主题页（type: "cover"），包含演讲主题
2. 第二页是演讲嘉宾资料页（type: "speaker"）
3. 第三页是目录页（type: "toc"），列出所有一级要点
4. 每个一级要点有一个章节首页（type: "chapter"），包含chapterId和chapterTitle（如果只有一级要点，就不需要章节页了，直接显示具体的内容页）
5. 每个二级要点是一页内容页（type: "content"），包含详细演讲内容
6. 脚本必须保留详细的演讲内容，不要省略

⚠️ JSON格式要求（极其重要，必须严格遵守）：
- 直接返回JSON数组，以 [ 开头，以 ] 结尾
- 不要包含markdown代码块标记（\`\`\`）
- 字符串值中的换行必须用 \\n 转义，禁止出现裸换行
- 每个字符串值必须用双引号正确关闭
- 确保JSON完整输出，不要被截断
- 每个字段值尽量精简，避免过长的字符串

格式示例：
[
  {
    "type": "cover",
    "title": "演讲主题",
    "content": "演讲主题描述",
    "chapterId": "",
    "chapterTitle": ""
  }
]

演讲底稿：
${state.draft.content}`;

    const raw = await callTextAPI([{ role: 'user', content: prompt }]);
    console.log('Script generation response length:', raw.length);
    console.log('First 500 chars:', raw.substring(0, 500));

    const blocks = extractJSON(raw);
    if (!blocks || !Array.isArray(blocks)) {
      // Show raw response in a debug area for user to see
      const debugEl = document.getElementById('scriptDebugArea');
      if (debugEl) {
        debugEl.style.display = 'block';
        debugEl.querySelector('pre').textContent = raw.substring(0, 2000) + (raw.length > 2000 ? '\n...(truncated)' : '');
      }
      throw new Error('AI返回的内容无法解析为JSON数组。可能是AI输出被截断，请尝试缩短底稿内容后重试，或调整API的max_tokens参数。（原始响应已显示在页面中）');
    }

    if (blocks.length < 3) {
      console.warn('Script blocks seem incomplete, only got', blocks.length, 'blocks');
    }

    state.script.blocks = blocks.map((b, i) => ({
      id: 'block-' + Date.now() + '-' + i,
      type: b.type || 'content',
      title: b.title || '未命名',
      content: b.content || '',
      chapterId: b.chapterId || '',
      chapterTitle: b.chapterTitle || '',
    }));
    state.script.generated = true;
    clearAfterStep(2);
    saveState();
    renderStep2();
    status.textContent = '';
    showToast('脚本生成成功！共 ' + state.script.blocks.length + ' 页', 'success');
  } catch (e) {
    console.error('Script generation error:', e);
    showToast('脚本生成失败: ' + e.message, 'error');
    status.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = state.script.generated ? '重新生成脚本' : '生成脚本';
  }
}

// ---- Step 3: Design ----
function renderStep3() {
  console.log('[renderStep3] 开始 - designLanguage:', state.design.designLanguage?.substring(0, 100));
  const nextBtn = document.getElementById('step3Next');
  nextBtn.disabled = !state.design.generated;
  const langValue = state.design.designLanguage || DEFAULT_DESIGN_LANG;
  console.log('[renderStep3] langValue:', langValue.substring(0, 100));
  if (!state.design.designLanguage) {
    console.log('[renderStep3] designLanguage 为空，设置为 langValue');
    state.design.designLanguage = langValue;
  }
  document.getElementById('designLangView').textContent = langValue;
  document.getElementById('designLangEdit').value = langValue;
  // Ensure edit mode is closed (in case user was editing before regeneration)
  document.getElementById('designLangEdit').classList.add('hidden');
  document.getElementById('designLangView').classList.remove('hidden');
  document.getElementById('designLangEditBtn').textContent = '编辑';
  document.getElementById('designGenStatus').textContent = '';

  if (!state.design.generated) {
    document.getElementById('designBlocks').innerHTML = '<div class="text-center py-12 text-[#737373]"><p>点击下方按钮生成设计稿</p></div>';
    document.getElementById('genDesignBtn').textContent = '生成设计稿';
  } else {
    document.getElementById('genDesignBtn').textContent = '重新生成设计稿';
    renderDesignBlocks();
  }
}

function toggleDesignLangEdit() {
  const view = document.getElementById('designLangView');
  const edit = document.getElementById('designLangEdit');
  const btn = document.getElementById('designLangEditBtn');
  if (edit.classList.contains('hidden')) {
    edit.classList.remove('hidden');
    view.classList.add('hidden');
    btn.textContent = '保存';
  } else {
    console.log('[toggleDesignLangEdit] 保存前 designLanguage:', state.design.designLanguage?.substring(0, 100));
    state.design.designLanguage = edit.value;
    saveState();
    console.log('[toggleDesignLangEdit] 保存后 designLanguage:', state.design.designLanguage?.substring(0, 100));
    edit.classList.add('hidden');
    view.classList.remove('hidden');
    btn.textContent = '编辑';
    view.textContent = edit.value;
    showToast('设计语言已保存', 'success');
  }
}

function renderDesignBlocks() {
  const container = document.getElementById('designBlocks');
  container.innerHTML = '';
  state.design.blocks.forEach((block, idx) => {
    const div = document.createElement('div');
    div.className = 'p-4 border border-[#E5E5E5] rounded-lg bg-white cursor-grab active:cursor-grabbing';
    div.setAttribute('data-idx', idx);
    const checked = selectionState.step3.has(idx) ? 'checked' : '';
    div.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <input type="checkbox" id="step3-chk-${idx}" ${checked} onchange="toggleSelect('step3', ${idx})" class="w-4 h-4 rounded border-[#D4D4D4] cursor-pointer" onclick="event.stopPropagation()" />
          <span class="inline-flex items-center justify-center w-8 h-6 bg-[#0A0A0A] text-white text-xs font-mono rounded">P${idx + 1}</span>
          <span class="text-sm font-medium">${escapeHtml(block.title || '未命名')}</span>
        </div>
        <div class="flex items-center gap-3">
          <button onclick="openDesignEditModal(${idx})" class="text-xs text-[#2563EB] hover:underline">编辑</button>
          <button onclick="deleteDesignBlock(${idx})" class="text-xs text-[#DC2626] hover:underline">删除</button>
        </div>
      </div>
      <div class="space-y-2 text-sm">
        <div><span class="text-[#737373]">核心金句：</span>${escapeHtml(block.goldenSentence || '-')}</div>
        <div><span class="text-[#737373]">视觉设计：</span>${escapeHtml(block.visualDesign || '-')}</div>
        <div><span class="text-[#737373]">配图Prompt：</span><span class="text-xs text-[#525252]">${escapeHtml((block.imagePrompt || '-').substring(0, 150))}${(block.imagePrompt || '').length > 150 ? '...' : ''}</span></div>
      </div>
    `;
    container.appendChild(div);
  });
  // Init sortable
  if (window.Sortable && container.children.length > 0) {
    new Sortable(container, {
      animation: 150,
      handle: 'div',
      ghostClass: 'opacity-30',
      onEnd: (evt) => {
        const { oldIndex, newIndex } = evt;
        if (oldIndex !== newIndex) {
          const moved = state.design.blocks.splice(oldIndex, 1)[0];
          state.design.blocks.splice(newIndex, 0, moved);
          selectionState.step3.clear();
          saveState();
          renderDesignBlocks();
        }
      }
    });
  }
  updateSelectToolbar('step3');
  updateCheckboxes('step3');
}

function deleteDesignBlock(idx) {
  if (!confirm('确认删除 P' + (idx + 1) + ': ' + state.design.blocks[idx].title + '？')) return;
  state.design.blocks.splice(idx, 1);
  // 不清空images，renderStep4会根据designBlockId智能同步
  selectionState.step3.clear();
  saveState();
  renderDesignBlocks();
}

// editDesignBlock, saveDesignEdit, cancelDesignEdit, deleteDesignBlock are defined above

// ============ 生成整体设计语言（AI根据内容生成） ============
async function generateDesignLanguage() {
  const status = document.getElementById('designLangGenStatus');
  const btn = document.getElementById('genDesignLangBtn');
  
  if (!state.script.blocks || state.script.blocks.length === 0) {
    showToast('请先生成脚本', 'error');
    return;
  }
  
  btn.disabled = true;
  btn.textContent = '生成中...';
  status.textContent = '正在生成整体设计语言...';
  
  try {
    const scriptSummary = state.script.blocks.map((b, i) =>
      'P' + (i+1) + ' [' + b.type + '] ' + (b.title || '') + ': ' + (b.content ? b.content.substring(0, 100) : '')
    ).join('\n');
    
    const prompt = '你是一个专业的PPT设计专家。请根据以下演讲脚本内容，生成一套完整的整体设计语言。\n\n' +
      '请严格按照以下模板结构生成：【视觉关键词】【背景】【字体】【配色】这些字段必须根据PPT内容和主题由AI生成（不要用默认的深蓝色科技感），【页面结构】保持默认值。\n\n' +
      '模板结构：\n' +
      '视觉关键词\n' +
      '- （根据PPT内容生成3-5个视觉关键词，如风格、氛围、构图特点等）\n\n' +
      '全局设计规范\n' +
      '背景\n' +
      '- 主背景：（根据内容主题生成配色）\n' +
      '- 辅助渐变：（可选生成）\n' +
      '- 局部效果：（可选生成）\n\n' +
      '字体建议\n' +
      '- 中文标题：（推荐合适的字体）\n' +
      '- 英文标题：（推荐合适的字体）\n' +
      '- 正文：（推荐合适的字体）\n\n' +
      '配色\n' +
      '- 主色：（根据主题生成主色 HEXX代码）\n' +
      '- 强调色：（生成强调色 HEXX代码）\n' +
      '- 次强调：（生成辅色 HEXX代码）\n' +
      '- 文本：（生成文本色 HEXX代码）\n\n' +
      '页面结构\n' +
      '- 一页一个核心概念\n' +
      '- 每页最多一句核心金句\n' +
      '- 一张主视觉图 + 少量结构元素\n' +
      '- 不做复杂表格\n\n' +
      '【重要】\n' +
      '1. 视觉关键词、背景、字体、配色必须根据演讲内容生成，不能使用默认的深蓝色科技感\n' +
      '2. 页面结构保持默认\n' +
      '3. 整体风格要与PPT主题和内容贴合\n' +
      '4. 返回完整的整体设计语言文本\n\n' +
      '演讲脚本概览：\n' + scriptSummary + '\n\n' +
      '演讲底稿片段：\n' + (state.draft.content ? state.draft.content.substring(0, 500) : '(无)');

    const raw = await callTextAPI([{ role: 'user', content: prompt }]);
    
    state.design.designLanguage = raw;
    saveState();
    
    document.getElementById('designLangView').textContent = raw;
    document.getElementById('designLangEdit').value = raw;
    
    status.textContent = '设计语言已生成';
    showToast('设计语言生成成功', 'success');
  } catch (e) {
    console.error('Design language generation error:', e);
    status.textContent = '生成失败';
    showToast('设计语言生成失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '生成设计语言';
  }
}

function resetDesignLanguage() {
  state.design.designLanguage = DEFAULT_DESIGN_LANG;
  saveState();
  document.getElementById('designLangView').textContent = DEFAULT_DESIGN_LANG;
  document.getElementById('designLangEdit').value = DEFAULT_DESIGN_LANG;
  showToast('已重置为参考模板', 'info');
}

async function generateDesign() {
  // 检查是否有未保存的设计语言编辑
  const designLangEdit = document.getElementById('designLangEdit');
  const designLangView = document.getElementById('designLangView');
  if (!designLangEdit.classList.contains('hidden')) {
    // 编辑模式开启，用户可能修改了内容但没保存，先保存
    const editValue = designLangEdit.value;
    if (editValue && editValue.trim()) {
      console.log('[generateDesign] 检测到未保存的设计语言编辑，自动保存');
      state.design.designLanguage = editValue;
      saveState();
    }
  }
  
  // 重新生成时清除当前及后续步骤数据，但保留设计语言
  console.log('[generateDesign] 开始 - 当前 designLanguage:', state.design.designLanguage?.substring(0, 100));
  const savedDesignLang = state.design.designLanguage || DEFAULT_DESIGN_LANG;
  console.log('[generateDesign] 保存的 designLanguage:', savedDesignLang.substring(0, 100));
  state.design = { designLanguage: savedDesignLang, blocks: [], generated: false };
  state.images = { items: [], generated: false };
  saveState();
  console.log('[generateDesign] 重置后 designLanguage:', state.design.designLanguage?.substring(0, 100));

  const btn = document.getElementById('genDesignBtn');
  const status = document.getElementById('designGenStatus');
  btn.disabled = true;
  btn.textContent = '生成中...';
  status.textContent = '正在调用AI生成设计稿...';

  try {
    const scriptSummary = state.script.blocks.map((b, i) =>
      `P${i+1} [${b.type}] ${b.title}: ${b.content.substring(0, 100)}...`
    ).join('\n');

        const prompt = `你是一个专业的PPT设计专家。请根据以下演讲脚本和整体设计语言，为每一页生成设计思路。

【整体设计语言】
${state.design.designLanguage}

演讲脚本概览：
${scriptSummary}

【核心原则】
1. **每页必须包含全部4个字段**：title、goldenSentence、visualDesign、imagePrompt
2. 视觉风格、配色、字体必须严格遵循整体设计语言
3. 即使设计语言强调极简，title和goldenSentence也必须有值（图片生成阶段会自行判断是否渲染）

请严格按JSON数组格式返回，不要包含任何其他文字：
[
  {
    "pageNumber": 1,
    "title": "页面标题（必须）",
    "goldenSentence": "核心金句（必须）",
    "visualDesign": "视觉设计描述（必须）",
    "imagePrompt": "配图提示词，英文（必须）"
  }
]

【示例】：
{
  "pageNumber": 1,
  "title": "主题标题",
  "goldenSentence": "核心观点",
  "visualDesign": "专业的商务风格，蓝灰色系，左右布局...",
  "imagePrompt": "professional business style, blue-gray color scheme, left-right layout..."
}

【注意事项】
1. visualDesign用中文，详细描述视觉概念、布局、元素、色彩、氛围
2. imagePrompt用英文，包含画面内容、风格、色调、构图、16:9比例
3. 每页必须包含title、goldenSentence、visualDesign、imagePrompt全部4个字段
4. 配色严格遵循整体设计语言，不要用默认的蓝色（除非设计语言要求）`;

    const raw = await callTextAPI([{ role: 'user', content: prompt }]);
    console.log('Design generation response length:', raw.length);
    console.log('Design generation raw response (first 500):', raw.substring(0, 500));

    const blocks = extractJSON(raw);
    if (!blocks || !Array.isArray(blocks)) {
      const debugEl = document.getElementById('designDebugArea');
      if (debugEl) {
        debugEl.style.display = 'block';
        debugEl.querySelector('pre').textContent = raw.substring(0, 2000) + (raw.length > 2000 ? '\n...(truncated)' : '');
      }
      throw new Error('AI返回的内容无法解析为JSON数组（原始响应已显示在页面中）');
    }

    state.design.blocks = blocks.map((b, i) => ({
      id: 'design-' + Date.now() + '-' + i,
      pageNumber: b.pageNumber || i + 1,
      title: b.title || '未命名',
      goldenSentence: b.goldenSentence || '',
      visualDesign: b.visualDesign || '',
      imagePrompt: b.imagePrompt || '',
      scriptBlockId: state.script.blocks[i]?.id || '', // Link to corresponding script block
    }));
    state.design.generated = true;
    console.log('[generateDesign] AI生成完成 - 当前 designLanguage:', state.design.designLanguage?.substring(0, 100));
    console.log('[generateDesign] savedDesignLang:', savedDesignLang.substring(0, 100));
    // Ensure designLanguage is preserved after clearAfterStep
    if (!state.design.designLanguage) {
      console.log('[generateDesign] designLanguage 为空，恢复为 savedDesignLang');
      state.design.designLanguage = savedDesignLang;
    }
    clearAfterStep(3);
    console.log('[generateDesign] clearAfterStep后 - designLanguage:', state.design.designLanguage?.substring(0, 100));
    // Double-check designLanguage after clearAfterStep
    if (!state.design.designLanguage) {
      console.log('[generateDesign] designLanguage 在 clearAfterStep 后为空，恢复为 savedDesignLang');
      state.design.designLanguage = savedDesignLang;
    }
    saveState();
    renderStep3();
    status.textContent = '';
    showToast('设计稿生成成功！', 'success');
  } catch (e) {
    console.error('Design generation error:', e);
    showToast('设计稿生成失败: ' + e.message, 'error');
    status.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = state.design.generated ? '重新生成设计稿' : '生成设计稿';
  }
}

// ---- Step 4: Image Generation ----
let currentEditIdx = -1;
let tempImageUrl = '';

// Build a complete PPT page prompt from design block info
// Extract only visual style info from design language (avoid leaking specific product content)
function extractVisualStyle(designLang) {
  if (!designLang) return '';
  // Only keep lines related to visual style, skip lines with specific product names/quotes
  const styleKeywords = ['背景', '字体', '配色', '颜色', '主色', '强调色', '文本色', '页面结构', '视觉', '背景色', '渐变', '光晕', '圆角', '阴影', '科技', '极简', '留白', 'Background', 'Font', 'Color', 'Layout', 'Visual', '#', 'rgb', 'hsl'];
  const lines = designLang.split('\n');
  const styleLines = [];
  let inStyleSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('-') && trimmed.length < 3) continue;
    // Check if this line belongs to a style section
    const isStyleLine = styleKeywords.some(kw => trimmed.toLowerCase().includes(kw.toLowerCase()));
    if (isStyleLine) inStyleSection = true;
    // Reset on section headers that are NOT style-related
    if (trimmed.match(/^[^\s\-#]/) && !isStyleLine) inStyleSection = false;
    if (isStyleLine || (inStyleSection && trimmed.startsWith('-'))) {
      styleLines.push(line);
    }
  }
  return styleLines.join('\n').trim();
}

function buildSlidePrompt(designBlock, scriptBlock) {
  const parts = [];
  // 检查设计语言中是否有"不要标题"的指示
  const designLangFull = state.design.designLanguage || '';
  const noTitleKw = ['不要标题', '不需要标题', '不需要显示标题', 'no title', 'no titles', '无标题', '没有标题'];
  const suppressTitle = noTitleKw.some(function(kw) { return designLangFull.includes(kw); });
  
  // Core instruction: generate based on design spec, respect content type
  parts.push(`Generate a complete, fully rendered presentation slide image (16:9 aspect ratio).

【核心原则】
1. 严格按照下方【视觉设计】和【配图提示词】生成图片
2. 如果下方有标题/金句等文字内容，必须在图片中渲染出来；如果没有，就不要添加
3. 所有文字使用中文渲染（如果原文是中文）
4. 生成的是完整的PPT页面，不是只有背景
5. 如果是绘本/插画风格，按设计稿风格生成；如果是商务风格，按商务风格生成
6. 不要添加设计稿中没有的元素，也不要遗漏设计稿中指定的元素
7. 特别注意：如果整体设计语言说"不要标题"，图片中就不要出现标题`);
  
  // Design language - only visual style, NOT specific product content
  const designLang = extractVisualStyle(state.design.designLanguage);
  if (designLang) {
    parts.push('\n\n【视觉风格/整体设计语言】\n' + designLang);
  }
  
  // Title - only if exists in designBlock AND design language allows it
  const title = designBlock?.title;
  if (title && !suppressTitle) {
    parts.push('\n\nSlide Title (render this as the main heading): ' + title);
  }
  
  // Golden sentence - only if exists
  if (designBlock?.goldenSentence) {
    parts.push('\nKey Quote/Golden Sentence (render this prominently on the slide): ' + designBlock.goldenSentence);
  }
  
  // Visual design approach (required)
  if (designBlock?.visualDesign) {
    parts.push('\n【视觉设计】\n' + designBlock.visualDesign);
  }
  
  // Image prompt (required)
  if (designBlock?.imagePrompt) {
    parts.push('\n【配图提示词】\n' + designBlock.imagePrompt);
  }
  
  
  parts.push('\n\n【最终检查】\n1. 是否严格遵循了【视觉设计】和【配图提示词】？\n2. 如果有标题/金句，是否正确渲染了中文文字？\n3. 如果设计语言说"不要标题"，图片中是否没有标题？\n4. 这是一张完整的PPT页面，不是只有背景\n5. 只包含本页内容，不要混入其他页面的内容');
  
  return parts.join('');
}

function renderStep4() {
  // Clear loading status when re-entering step 4
  const imgStatus = document.getElementById('imageGenStatus');
  if (imgStatus && state.images.generated) imgStatus.textContent = '';
  
  // 根据实际图片数据同步生成状态
  if (state.images.items.length > 0) {
    state.images.generated = state.images.items.every(function(item) { return item.imageBase64 || item.imageUrl; });
  }
  
  const nextBtn = document.getElementById('step4Next');
  nextBtn.disabled = !state.images.generated;

  // Sync image items with current design blocks by ID
  const designBlocks = state.design.blocks;
  const oldItems = state.images.items;
  
  // Build a map of existing items by designBlockId for reliable matching
  const existingMap = new Map();
  oldItems.forEach(item => {
    if (item.designBlockId) {
      existingMap.set(item.designBlockId, item);
    }
  });
  
  // Rebuild items from design blocks, preserving existing data by ID
  const needsRebuild = designBlocks.length !== oldItems.length || 
    designBlocks.some((b, i) => !oldItems[i] || oldItems[i].designBlockId !== b.id);
  
  if (needsRebuild) {
    state.images.items = designBlocks.map((b, i) => {
      const existing = existingMap.get(b.id);
      if (existing && (existing.imageBase64 || existing.imageUrl)) {
        // Preserve existing item with its generated image
        // Ensure scriptBlockId is up-to-date from designBlock
        if (!existing.scriptBlockId && b.scriptBlockId) {
          existing.scriptBlockId = b.scriptBlockId;
        }
        return existing;
      }
      // Find script block via designBlock's scriptBlockId (saved during design generation)
      const scriptBlock = b.scriptBlockId
        ? state.script.blocks.find(sb => sb.id === b.scriptBlockId)
        : state.script.blocks[i];
      return {
        id: 'img-' + Date.now() + '-' + i,
        pageNumber: i + 1,
        designBlockId: b.id || '',
        scriptBlockId: b.scriptBlockId || scriptBlock?.id || '',
        imageUrl: '',
        imageBase64: '',
        prompt: buildSlidePrompt(b, scriptBlock),
        error: '',
      };
    });
    state.images.generated = state.images.items.length > 0 && state.images.items.every(item => item.imageBase64 || item.imageUrl);
    saveState();
  }

  renderImageBlocks();

  // Update button text based on whether images have been generated
  const hasAnyImage = state.images.items.some(item => item.imageBase64 || item.imageUrl);
  document.getElementById('genImagesBtn').textContent = hasAnyImage ? '重新生成全部图片' : '生成全部图片';
}

function renderImageBlocks() {
  const container = document.getElementById('imageBlocks');
  container.innerHTML = '';
  state.images.items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'p-4 border border-[#E5E5E5] rounded-lg bg-white';
    const scriptBlock = state.script.blocks[idx];
    const designBlock = state.design.blocks[idx];
    const imgSrc = item.imageBase64 || item.imageUrl;
    const checked = selectionState.step4.has(idx) ? 'checked' : '';

    div.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <input type="checkbox" id="step4-chk-${idx}" ${checked} onchange="toggleSelect('step4', ${idx})" class="w-4 h-4 rounded border-[#D4D4D4] cursor-pointer" />
          <span class="inline-flex items-center justify-center w-8 h-6 bg-[#0A0A0A] text-white text-xs font-mono rounded">P${idx + 1}</span>
          <span class="text-sm font-medium">${escapeHtml(designBlock?.title || scriptBlock?.title || '未命名')}</span>
          ${imgSrc ? '<span class="text-xs text-[#16A34A]">已生成</span>' : ''}
        </div>
        <div class="flex items-center gap-2">
          <button onclick="generateSingleImage(${idx})" class="text-xs px-3 py-1 border border-[#E5E5E5] rounded hover:bg-[#F5F5F5] transition-colors">${imgSrc ? '重新生成' : '生成'}</button>
          ${imgSrc ? `<button onclick="openImageEdit(${idx})" class="text-xs text-[#2563EB] hover:underline">编辑</button>` : ''}
          ${imgSrc ? `<button onclick="clearImageItem(${idx})" class="text-xs text-[#737373] hover:underline">清空</button>` : ''}
          <button onclick="deleteImageItem(${idx})" class="text-xs text-[#DC2626] hover:underline">删除此页</button>
        </div>
      </div>
      ${imgSrc ? `
        <div class="border border-[#E5E5E5] rounded-lg overflow-hidden bg-[#F5F5F5] mb-2">
          <img src="${imgSrc}" class="w-full" alt="P${idx + 1}" />
        </div>
      ` : `
        <div class="h-32 border border-dashed border-[#D4D4D4] rounded-lg flex items-center justify-center text-[#A3A3A3] text-sm">
          ${item.error ? '<span class="text-[#DC2626]">' + escapeHtml(item.error) + '</span>' : '未生成'}
        </div>
      `}
      <div class="mt-2">
        <button onclick="togglePromptEditor(${idx})" id="prompt-btn-${idx}" class="text-xs text-[#2563EB] hover:underline">▸ 展开提示词</button>
      </div>
      <div id="prompt-editor-${idx}" class="hidden mt-2">
        <textarea id="prompt-textarea-${idx}" class="w-full h-32 p-2 border border-[#E5E5E5] rounded text-xs font-mono resize-y focus:outline-none focus:border-[#0A0A0A] bg-white">${escapeHtml(item.prompt || '')}</textarea>
        <div class="flex items-center gap-2 mt-2">
          <button onclick="updateImagePrompt(${idx})" class="px-3 py-1 bg-[#0A0A0A] text-white rounded text-xs hover:bg-[#262626] transition-colors">更新</button>
          <button onclick="resetImagePrompt(${idx})" class="px-3 py-1 border border-[#E5E5E5] rounded text-xs hover:bg-[#F5F5F5] transition-colors">重置为设计稿</button>
        </div>
      </div>
      <div class="text-xs text-[#737373] mt-1">
        <span class="font-medium">标题:</span> ${escapeHtml(designBlock?.title || '-')}
        ${designBlock?.goldenSentence ? ' &middot; <span class="font-medium">金句:</span> ' + escapeHtml(designBlock.goldenSentence.substring(0, 60)) : ''}
        ${designBlock?.imagePrompt ? ' &middot; <span class="font-medium">配图:</span> ' + escapeHtml(designBlock.imagePrompt.substring(0, 60)) + (designBlock.imagePrompt.length > 60 ? '...' : '') : ''}
      </div>
    `;
    container.appendChild(div);
  });
  updateSelectToolbar('step4');
  updateCheckboxes('step4');
}

// Build a complete PPT page prompt from design block info
async function generateSingleImage(idx) {
  const item = state.images.items[idx];
  
  // 首次生成或重置后才重建提示词；用户手动更新过则保留
  if (!item.prompt) {
    const designBlock = state.design.blocks[idx];
    const scriptBlock = state.script.blocks[idx];
    item.prompt = buildSlidePrompt(designBlock, scriptBlock);
  }
  
  item.error = '';
  renderImageBlocks();

  try {
    var promptToUse = item.prompt || buildSlidePrompt(state.design.blocks[idx], state.script.blocks[idx]);
    let imageUrl = await callImageAPI(promptToUse, state.characterRefImages);
    // Immediately convert remote URL to base64 for reliable PPTX export
    if (!imageUrl.startsWith('data:')) {
      try {
        if (isProxyMode()) {
          // 代理模式：通过服务端下载图片转base64
          const dlResp = await fetch('/api/download-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl }),
          });
          if (dlResp.ok) {
            const dlData = await dlResp.json();
            if (dlData.dataUrl) {
              imageUrl = dlData.dataUrl;
            }
          }
        } else {
          // 纯静态模式：直接fetch图片（需要API支持CORS）
          const resp = await fetch(imageUrl);
          const blob = await resp.blob();
          imageUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      } catch (e) {
        console.warn('Failed to convert image URL to base64:', e);
      }
    }
    if (imageUrl.startsWith('data:')) {
      item.imageBase64 = imageUrl;
      item.imageUrl = '';
    } else {
      item.imageUrl = imageUrl;
      item.imageBase64 = '';
    }
    state.images.generated = state.images.items.every(function(it) { return it.imageBase64 || it.imageUrl; });
    saveState();
    renderImageBlocks();
    
    // Update next button
    var nextBtn = document.getElementById('step4Next');
    if (nextBtn) nextBtn.disabled = !state.images.generated;
    
    showToast('P' + (idx + 1) + ' 图片生成成功', 'success');
  } catch (e) {
    item.error = e.message;
    saveState();
    renderImageBlocks();
    showToast('图片生成失败: ' + e.message, 'error');
  }
}

async function generateAllImages() {
  // 重新生成时清除图片数据
  state.images.items.forEach(function(item) { item.imageUrl = ''; item.imageBase64 = ''; });
  saveState();

  const btn = document.getElementById('genImagesBtn');
  const status = document.getElementById('imageGenStatus');
  btn.disabled = true;
  btn.textContent = '生成中...';

  try {
    for (let i = 0; i < state.images.items.length; i++) {
      status.textContent = `正在生成 P${i + 1}/${state.images.items.length}...`;
      await generateSingleImage(i);
    }

    state.images.generated = state.images.items.every(item => item.imageBase64 || item.imageUrl);
    saveState();
    status.textContent = state.images.generated ? '全部生成完成' : '';
    renderStep4();
  } catch (e) {
    console.error('Image generation error:', e);
    showToast('图片生成失败: ' + e.message, 'error');
    status.textContent = '';
  } finally {
    btn.disabled = false;
    const hasAnyImage = state.images.items.some(item => item.imageBase64 || item.imageUrl);
    btn.textContent = hasAnyImage ? '重新生成全部图片' : '生成全部图片';
  }
}

// ---- 提示词编辑（图片生成环节）----
function togglePromptEditor(idx) {
  var el = document.getElementById('prompt-editor-' + idx);
  var btn = document.getElementById('prompt-btn-' + idx);
  if (!el || !btn) return;
  if (el.classList.contains('hidden')) {
    el.classList.remove('hidden');
    __promptEditorOpen.add(idx);
    btn.textContent = '▖ 收起提示词';
    // 同步最新的 prompt 到文本框
    var ta = document.getElementById('prompt-textarea-' + idx);
    if (ta) ta.value = state.images.items[idx]?.prompt || '';
  } else {
    el.classList.add('hidden');
    __promptEditorOpen.delete(idx);
    btn.textContent = '▸ 展开提示词';
  }
}

function updateImagePrompt(idx) {
  var ta = document.getElementById('prompt-textarea-' + idx);
  if (!ta) return;
  state.images.items[idx].prompt = ta.value;
  saveState();
  showToast('提示词已更新', 'success');
}

function resetImagePrompt(idx) {
  var item = state.images.items[idx];
  var designBlock = state.design.blocks[idx];
  var scriptBlock = state.script.blocks[idx];
  if (!designBlock) return;
  item.prompt = buildSlidePrompt(designBlock, scriptBlock);
  saveState();
  // 同步刷新文本域
  var ta = document.getElementById('prompt-textarea-' + idx);
  if (ta) ta.value = item.prompt;
  showToast('已重置为设计稿版本', 'info');
}



function openImageEdit(idx) {
  currentEditIdx = idx;
  const item = state.images.items[idx];
  const designBlock = state.design.blocks[idx];
  const scriptBlock = state.script.blocks[idx];
  document.getElementById('imageEditTitle').textContent = 'P' + (idx + 1) + ' ' + (designBlock?.title || scriptBlock?.title || '');
  document.getElementById('imageEditPreview').src = item.imageBase64 || item.imageUrl;
  tempImageUrl = item.imageBase64 || item.imageUrl;

  const chat = document.getElementById('imageEditChat');
  chat.innerHTML = '<div class="text-[#737373]">输入调整要求来重新生成图片</div>';
  document.getElementById('imageEditInput').value = '';
  document.getElementById('imageEditModal').classList.remove('hidden');
}

function closeImageEdit() {
  document.getElementById('imageEditModal').classList.add('hidden');
  currentEditIdx = -1;
}

async function regenerateImage() {
  if (currentEditIdx < 0) return;
  const input = document.getElementById('imageEditInput');
  const chat = document.getElementById('imageEditChat');
  const userMsg = input.value.trim();
  if (!userMsg) return;

  chat.innerHTML += `<div class="text-right"><span class="inline-block bg-[#0A0A0A] text-white px-3 py-1.5 rounded-lg text-xs">${escapeHtml(userMsg)}</span></div>`;
  input.value = '';

  const item = state.images.items[currentEditIdx];
  const designBlock = state.design.blocks[currentEditIdx];
  const scriptBlock = state.script.blocks[currentEditIdx];
  const basePrompt = buildSlidePrompt(designBlock, scriptBlock);
  // 编辑模式下：提供原图作为参考，要求 AI 在原图基础上局部修改
  const newPrompt = userMsg + '\n\nModify the provided image as instructed above. Keep all other elements including layout, colors, and any existing text completely unchanged.';

  var _statusEl = document.createElement('div');
  _statusEl.className = 'text-[#737373]';
  _statusEl.textContent = '生成中...';
  chat.appendChild(_statusEl);
  chat.scrollTop = chat.scrollHeight;

  try {
    var imageUrl = await callImageAPI(newPrompt, state.characterRefImages, tempImageUrl);
    // Convert remote URL to base64 via proxy for reliable preview & export
    if (!imageUrl.startsWith('data:')) {
      try {
        var dlResp = await fetch('/api/download-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl }),
        });
        if (dlResp.ok) {
          var dlData = await dlResp.json();
          if (dlData.dataUrl) imageUrl = dlData.dataUrl;
        }
      } catch (_) {}
    }
    tempImageUrl = imageUrl;
    document.getElementById('imageEditPreview').src = tempImageUrl;
    _statusEl.className = 'text-[#16A34A]';
    _statusEl.textContent = '图片已生成，请确认或继续调整';
    item.prompt = newPrompt;
  } catch (e) {
    _statusEl.className = 'text-[#DC2626]';
    _statusEl.textContent = '生成失败: ' + escapeHtml(e.message);
  }
  chat.scrollTop = chat.scrollHeight;
}

function confirmImageEdit() {
  if (currentEditIdx < 0) return;
  const item = state.images.items[currentEditIdx];
  if (tempImageUrl.startsWith('data:')) {
    item.imageBase64 = tempImageUrl;
    item.imageUrl = '';
  } else {
    item.imageUrl = tempImageUrl;
    item.imageBase64 = '';
  }
  state.images.generated = state.images.items.every(function(i) { return i.imageBase64 || i.imageUrl; });
  saveState();
  closeImageEdit();
  renderImageBlocks();
  document.getElementById('step4Next').disabled = !state.images.generated;
}

// ---- Step 5: Export ----
function renderStep5() {
  document.getElementById('exportStatus').textContent = '';
}

async function exportPPTX(withNotes) {
  const statusEl = document.getElementById('exportStatus');
  const btnId = withNotes ? 'exportWithNotes' : 'exportNoNotes';
  const btn = document.getElementById(btnId);
  btn.disabled = true;
  statusEl.textContent = '正在生成PPTX文件...';

  try {
    // pptxgen.min.js declares var PptxGenJS in global scope
    const PptxGen = window.PptxGenJS;
    if (typeof PptxGen !== 'function') {
      throw new Error('PptxGenJS库未正确加载，请刷新页面重试');
    }
    const pptx = new PptxGen();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5

    for (let i = 0; i < state.images.items.length; i++) {
      const item = state.images.items[i];
      const designBlock = item.designBlockId
        ? state.design.blocks.find(b => b.id === item.designBlockId)
        : state.design.blocks[i];
      // Find matching scriptBlock by ID (not by index, since design blocks may have been deleted/reordered)
      const scriptBlock = item.scriptBlockId
        ? state.script.blocks.find(b => b.id === item.scriptBlockId)
        : state.script.blocks[i];
      const slide = pptx.addSlide();

      // Add image - should be base64 already
      let imgData = item.imageBase64 || item.imageUrl;

      // If still a remote URL (shouldn't happen), try proxy download
      if (imgData && !imgData.startsWith('data:')) {
        try {
          statusEl.textContent = `正在下载第 ${i+1}/${state.images.items.length} 页图片...`;
          const dlResp = await fetch('/api/download-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageUrl: imgData }),
          });
          if (dlResp.ok) {
            const dlData = await dlResp.json();
            if (dlData.dataUrl) {
              imgData = dlData.dataUrl;
              item.imageBase64 = imgData;
              item.imageUrl = '';
            }
          }
        } catch (e) {
          console.warn('Failed to download image via proxy:', e);
        }
      }

      if (imgData) {
        slide.addImage({ data: imgData, x: 0, y: 0, w: 13.33, h: 7.5 });
      }

      // Add speaker notes - build from design + script info for this specific page
      if (withNotes) {
        if (scriptBlock?.content) {
          slide.addNotes(scriptBlock.content);
        }
      }
    }

    const filename = 'presentation' + (withNotes ? '-with-notes' : '') + '.pptx';
    await pptx.writeFile({ fileName: filename });
    statusEl.textContent = 'PPTX文件已生成！';
    showToast('导出成功！', 'success');
  } catch (e) {
    console.error('Export error:', e);
    statusEl.textContent = '导出失败: ' + e.message;
    showToast('导出失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}



// ---- Settings ----
function openSettings() {
  const cfg = state.config;
  document.getElementById('cfgTextApiFormat').value = cfg.textApi.apiFormat || 'openai';
  document.getElementById('cfgTextBaseUrl').value = cfg.textApi.baseUrl || '';
  document.getElementById('cfgTextApiKey').value = cfg.textApi.apiKey || '';
  document.getElementById('cfgTextModel').value = cfg.textApi.model || '';
  document.getElementById('cfgImageApiType').value = cfg.imageApi.apiType || 'chat';
  document.getElementById('cfgImageBaseUrl').value = cfg.imageApi.baseUrl || '';
  document.getElementById('cfgImageApiKey').value = cfg.imageApi.apiKey || '';
  document.getElementById('cfgImageModel').value = cfg.imageApi.model || '';
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function saveSettings() {
  state.config.textApi = {
    baseUrl: document.getElementById('cfgTextBaseUrl').value.trim(),
    apiKey: document.getElementById('cfgTextApiKey').value.trim(),
    model: document.getElementById('cfgTextModel').value.trim(),
    apiFormat: document.getElementById('cfgTextApiFormat').value,
  };
  state.config.imageApi = {
    baseUrl: document.getElementById('cfgImageBaseUrl').value.trim(),
    apiKey: document.getElementById('cfgImageApiKey').value.trim(),
    model: document.getElementById('cfgImageModel').value.trim(),
    apiType: document.getElementById('cfgImageApiType').value,
  };
  saveState();
  closeSettings();
  showToast('设置已保存', 'success');
}

// ---- Utility ----
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Init ----
async function init() {
  loadState();
  
  // Detect proxy availability (async)
  if (window.location.protocol !== 'file:') {
    try {
      const resp = await fetch('/api/proxy', { method: 'OPTIONS' });
      _proxyAvailable = resp.ok || resp.status === 204;
    } catch (e) {
      _proxyAvailable = false;
    }
  } else {
    _proxyAvailable = false;
  }
  
  // Update mode indicator in settings
  const modeEl = document.getElementById('modeIndicator');
  if (modeEl) {
    modeEl.innerHTML = _proxyAvailable
      ? '<span class="text-green-600 font-medium">代理模式</span> — API请求通过本地代理转发，无CORS限制'
      : '<span class="text-orange-600 font-medium">直连模式</span> — 直接调用API，需API支持CORS。如遇跨域问题，请用 <code>node server.js</code> 启动代理';
  }
  
  // Restore image base64 data from IndexedDB
  try {
    const dbImages = await loadImagesFromDB();
    if (dbImages.length > 0) {
      const dbMap = new Map(dbImages.map(img => [img.id, img]));
      state.images.items = state.images.items.map(item => {
        const dbItem = dbMap.get(item.id);
        if (dbItem && (dbItem.imageBase64 || dbItem.imageUrl)) {
          return { ...item, imageBase64: dbItem.imageBase64, imageUrl: dbItem.imageUrl };
        }
        return item;
      });
    }
  } catch (e) {
    console.warn('Failed to restore images from IndexedDB:', e);
  }
  
  // Restore ref images from IndexedDB
  try {
    const refData = await loadRefImagesFromDB();
    if (refData.characterRefImages.length > 0) {
      state.characterRefImages = refData.characterRefImages;
    }
    if (refData.refImages.length > 0) {
      state.draft.refImages = refData.refImages;
    }
  } catch (e) {
    console.warn('Failed to restore ref images from IndexedDB:', e);
  }
  
  renderCurrentStep();

  // Show settings hint if not configured
  if (!state.config.textApi.baseUrl) {
    setTimeout(() => showToast('请先点击右上角"设置"配置API', 'info'), 500);
  }
}

document.addEventListener('DOMContentLoaded', init);
