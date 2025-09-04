// 默认配置
const DEFAULT_CONFIG = {
  volumeSize: 100,
  batchSize: 50,
  requestDelay: 150,
  downloadPath: "",
  cleanEmptyLines: true,
};

// DOM 元素
const volumeSizeInput = document.getElementById("volumeSize");
const batchSizeInput = document.getElementById("batchSize");
const requestDelayInput = document.getElementById("requestDelay");
const downloadPathInput = document.getElementById("downloadPath");
const cleanEmptyLinesInput = document.getElementById("cleanEmptyLines");
const clearPathBtn = document.getElementById("clearPathBtn");
const chooseDirBtn = document.getElementById("chooseDirBtn");
const clearDirBtn = document.getElementById("clearDirBtn");
const dirStatus = document.getElementById("dirStatus");
const dirPath = document.getElementById("dirPath");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const statusDiv = document.getElementById("status");

// 显示状态消息
function showStatus(message, isError = false) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${isError ? "error" : "success"}`;
  statusDiv.style.display = "block";

  // 3秒后自动隐藏
  setTimeout(() => {
    statusDiv.style.display = "none";
  }, 3000);
}

// 加载配置
async function loadConfig() {
  try {
    const result = await chrome.storage.sync.get(["scrapeConfig"]);
    const config = { ...DEFAULT_CONFIG, ...result.scrapeConfig };

    volumeSizeInput.value = config.volumeSize;
    batchSizeInput.value = config.batchSize;
    requestDelayInput.value = config.requestDelay;
    downloadPathInput.value = config.downloadPath;
    cleanEmptyLinesInput.checked = config.cleanEmptyLines;
  } catch (error) {
    console.error("加载配置失败:", error);
    showStatus("加载配置失败", true);
  }
}

// 保存配置
async function saveConfig() {
  try {
    const config = {
      volumeSize: parseInt(volumeSizeInput.value) || DEFAULT_CONFIG.volumeSize,
      batchSize: parseInt(batchSizeInput.value) || DEFAULT_CONFIG.batchSize,
      requestDelay:
        parseInt(requestDelayInput.value) || DEFAULT_CONFIG.requestDelay,
      downloadPath: downloadPathInput.value.trim(),
      cleanEmptyLines: cleanEmptyLinesInput.checked,
    };

    // 验证配置值
    if (config.volumeSize < 1 || config.volumeSize > 1000) {
      showStatus("每卷章节数必须在1-1000之间", true);
      return;
    }

    if (config.batchSize < 1 || config.batchSize > 100) {
      showStatus("批量抓取大小必须在1-100之间", true);
      return;
    }

    if (config.requestDelay < 50 || config.requestDelay > 5000) {
      showStatus("请求间隔必须在50-5000毫秒之间", true);
      return;
    }

    await chrome.storage.sync.set({ scrapeConfig: config });
    showStatus("设置已保存");
  } catch (error) {
    console.error("保存配置失败:", error);
    showStatus("保存配置失败", true);
  }
}

// 重置为默认配置
function resetConfig() {
  volumeSizeInput.value = DEFAULT_CONFIG.volumeSize;
  batchSizeInput.value = DEFAULT_CONFIG.batchSize;
  requestDelayInput.value = DEFAULT_CONFIG.requestDelay;
  downloadPathInput.value = DEFAULT_CONFIG.downloadPath;
  cleanEmptyLinesInput.checked = DEFAULT_CONFIG.cleanEmptyLines;
  showStatus('已恢复默认设置，请点击"保存设置"确认');
}

function clearPath() {
  downloadPathInput.value = "";
  showStatus("路径已清空");
}

async function ensureOffscreen() {
  // Create offscreen document if not exists and verify it's alive
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification:
        "Write files to user-chosen absolute directory using the File System Access API",
    });
  } catch (e) {
    // ignore if already exists
  }
  // ping to ensure offscreen is responsive
  try {
    const res = await chrome.runtime.sendMessage({
      scope: "offscreen",
      type: "ping",
    });
    return !!res?.success;
  } catch (e) {
    return false;
  }
}

async function refreshDirStatus() {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      scope: "offscreen",
      type: "hasDirectory",
    });
    const ok = !!res?.success;
    dirStatus.textContent = ok ? "已授权" : "未授权";
    dirStatus.style.color = ok ? "#155724" : "#888";
    dirPath.textContent = ok && res?.name ? `已选目录：${res.name}` : "";
    // 失败时确保清空
    if (!ok) dirPath.textContent = "";
  } catch (e) {
    dirStatus.textContent = "未授权";
    dirPath.textContent = "";
  }
}

async function chooseDirectory() {
  // 目录选择必须由用户手势触发，并且需要在拥有 DOM 的页面中调用
  // 直接使用 options 页的 window.showDirectoryPicker 获取句柄
  try {
    const handle = await window.showDirectoryPicker();
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      scope: "offscreen",
      type: "setDirectoryHandle",
      handle,
    });
    showStatus("目录授权成功");
    refreshDirStatus();
  } catch (e) {
    if (e && e.name === "AbortError") return; // 用户取消
    showStatus("目录授权失败: " + (e?.message || "未知错误"), true);
  }
}

async function clearDirectory() {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    scope: "offscreen",
    type: "clearDirectory",
  });
  // 就近提示（按钮旁）
  const hint = document.createElement("span");
  hint.textContent = "已取消授权";
  hint.style.marginLeft = "8px";
  hint.style.color = "#856404";
  clearDirBtn.insertAdjacentElement("afterend", hint);
  setTimeout(() => hint.remove(), 2000);
  showStatus("已取消授权");
  refreshDirStatus();
}

// 事件监听器
saveBtn.addEventListener("click", saveConfig);
resetBtn.addEventListener("click", resetConfig);
clearPathBtn.addEventListener("click", clearPath);
chooseDirBtn.addEventListener("click", chooseDirectory);
clearDirBtn.addEventListener("click", clearDirectory);

// 页面加载时加载配置
document.addEventListener("DOMContentLoaded", () => {
  loadConfig();
  refreshDirStatus();
});

// 输入验证
volumeSizeInput.addEventListener("input", function () {
  const value = parseInt(this.value);
  if (value < 1) this.value = 1;
  if (value > 1000) this.value = 1000;
});

batchSizeInput.addEventListener("input", function () {
  const value = parseInt(this.value);
  if (value < 1) this.value = 1;
  if (value > 100) this.value = 100;
});

requestDelayInput.addEventListener("input", function () {
  const value = parseInt(this.value);
  if (value < 50) this.value = 50;
  if (value > 5000) this.value = 5000;
});
