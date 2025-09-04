const $ = (id) => document.getElementById(id);

// 进度监听相关
let progressPort = null;
let isScrapingInProgress = false;

// 章节范围解析函数
function parseChapterRange(rangeStr) {
  if (!rangeStr || !rangeStr.trim()) {
    throw new Error("请输入章节范围");
  }

  const chapters = new Set();
  const parts = rangeStr.split(",").map((s) => s.trim());

  for (const part of parts) {
    if (part.includes("-")) {
      // 处理范围，如 "2-10"
      const [start, end] = part.split("-").map((s) => parseInt(s.trim()));
      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        throw new Error(`无效的章节范围: ${part}`);
      }
      for (let i = start; i <= end; i++) {
        chapters.add(i);
      }
    } else {
      // 处理单个章节，如 "2"
      const chapter = parseInt(part);
      if (isNaN(chapter) || chapter < 1) {
        throw new Error(`无效的章节号: ${part}`);
      }
      chapters.add(chapter);
    }
  }

  return Array.from(chapters).sort((a, b) => a - b);
}

$("scrapeBtn").addEventListener("click", async () => {
  $("preview").value = "抓取中...";
  $("saveBtn").disabled = true;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.id) throw new Error("未找到活动标签页");

    // 先获取用户配置
    const configResult = await chrome.storage.sync.get(["scrapeConfig"]);
    const config = configResult.scrapeConfig || {};
    const shouldClean = config.cleanEmptyLines !== false; // 默认为true

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (shouldClean) => {
        // 在页面上下文中运行：尝试提取标题和内容
        let title =
          document.querySelector("h1")?.innerText ||
          document
            .querySelector('meta[property="og:title"]')
            ?.getAttribute("content") ||
          document.title ||
          "";

        // 常见正文选择器
        const selectors = [
          "#content",
          ".content",
          ".article",
          ".chapter-content",
          ".read-content",
          ".novel-content",
          "article",
          "div[id*=content]",
          "div[class*=content]",
        ];

        let contentEl = null;
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.length > 200) {
            contentEl = el;
            break;
          }
        }

        // fallback: 全页抓取但剔除脚本/样式
        let content = "";
        if (contentEl) {
          content = contentEl.innerText.trim();
        } else {
          // 尝试聚合多段 <p>
          const ps = Array.from(document.querySelectorAll("p"))
            .map((p) => p.innerText.trim())
            .filter((t) => t.length > 20);
          if (ps.length > 0) content = ps.join("\n\n");
          else content = document.body.innerText.trim().slice(0, 20000);
        }

        // 文本清理函数（与service_worker保持一致）
        function cleanText(text) {
          if (!text) return text;

          // 1. 统一换行符
          text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

          // 2. 清理每行首尾空白
          text = text
            .split("\n")
            .map((line) => line.trim())
            .join("\n");

          // 3. 清理多余空行（保留段落间的单个空行）
          text = text.replace(/\n{3,}/g, "\n\n");

          // 4. 清理开头和结尾的空行
          text = text.trim();

          return text;
        }

        // 根据配置决定是否清理文本
        if (shouldClean) {
          content = cleanText(content);
          title = cleanText(title);
        }

        return { title: title || "未命名", content, url: location.href };
      },
      args: [shouldClean],
    });

    const payload = results?.[0]?.result;
    if (!payload || !payload.content) throw new Error("未能提取文章内容");

    const filename = sanitizeFilename((payload.title || "novel") + ".txt");
    $("filename").value = filename;
    $("preview").value =
      payload.title + "\n\n" + payload.url + "\n\n" + payload.content;
    $("saveBtn").disabled = false;
  } catch (err) {
    $("preview").value = "抓取失败：" + (err.message || err);
    console.error(err);
  }
});

$("saveBtn").addEventListener("click", async () => {
  const text = $("preview").value;
  let filename = $("filename").value.trim();
  if (!filename) filename = "novel.txt";
  if (!filename.toLowerCase().endsWith(".txt")) filename += ".txt";

  // 发送给后台下载
  chrome.runtime.sendMessage(
    { action: "download", filename, text },
    (_resp) => {
      // 可选回调
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        alert("请求发送失败：" + chrome.runtime.lastError.message);
      } else {
        alert("保存请求已发出，下载可能已在后台开始。");
      }
    }
  );
});

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_");
}

// 开始指定章节抓取流程
async function startRangeScrapingProcess(chapters) {
  if (isScrapingInProgress) {
    alert("已有抓取任务在进行中，请等待完成或先终止当前任务");
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.id) throw new Error("未找到活动标签页");

    // 显示进度界面
    showProgress();
    $("progressTitle").textContent = `指定章节抓取进度 (${chapters.length}章)`;

    isScrapingInProgress = true;

    // 发送抓取请求到后台
    chrome.runtime.sendMessage(
      {
        action: "scrapeRange",
        tabId: tab.id,
        chapters: chapters,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("发送消息失败:", chrome.runtime.lastError);
          alert("启动抓取失败: " + chrome.runtime.lastError.message);
          hideProgress();
          isScrapingInProgress = false;
        } else if (!response || !response.success) {
          alert("启动抓取失败: " + (response?.error || "未知错误"));
          hideProgress();
          isScrapingInProgress = false;
        }
        // 成功的话，进度会通过port更新
      }
    );
  } catch (error) {
    console.error("启动抓取失败:", error);
    alert("启动抓取失败: " + error.message);
    hideProgress();
    isScrapingInProgress = false;
  }
}

// 章节选择按钮
$("scrapeRangeBtn").addEventListener("click", () => {
  const container = $("chapterRangeContainer");
  if (container.style.display === "none") {
    container.style.display = "block";
    $("chapterRange").focus();
  } else {
    container.style.display = "none";
  }
});

// 关闭章节选择
$("closeRangeBtn").addEventListener("click", () => {
  $("chapterRangeContainer").style.display = "none";
});

// 确认章节范围抓取
$("confirmRangeBtn").addEventListener("click", async () => {
  const rangeStr = $("chapterRange").value.trim();

  try {
    const chapters = parseChapterRange(rangeStr);
    console.log("解析的章节:", chapters);

    // 隐藏章节选择区域
    $("chapterRangeContainer").style.display = "none";

    // 开始抓取指定章节
    await startRangeScrapingProcess(chapters);
  } catch (error) {
    alert("章节范围格式错误：" + error.message);
    $("chapterRange").focus();
  }
});

// 抓取整本：请求后台在当前标签页上解析章节列表并逐章抓取（后台执行 fetch）
document.getElementById("scrapeAllBtn").addEventListener("click", async () => {
  if (isScrapingInProgress) {
    alert("已有抓取任务在进行中，请等待完成或先终止当前任务");
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab || !tab.id) throw new Error("未找到活动标签页");

    // 建立进度监听连接
    setupProgressListener();

    // 向后台发送 scrapeBook 请求，后台会在目标页上提取章节链接并逐一抓取
    chrome.runtime.sendMessage(
      { action: "scrapeBook", tabId: tab.id },
      (resp) => {
        if (chrome.runtime.lastError) {
          alert("请求发送失败：" + chrome.runtime.lastError.message);
          hideProgress();
          return;
        }
        if (resp && resp.started) {
          showProgress();
          isScrapingInProgress = true;
          $("scrapeAllBtn").disabled = true;
          updateProgress(0, "开始抓取...", "正在解析章节列表");
        } else {
          alert("整本抓取失败：" + (resp && resp.error));
          hideProgress();
        }
      }
    );
  } catch (err) {
    alert("操作失败：" + (err.message || err));
    hideProgress();
  }
});

// 打开设置页面
document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// 进度显示和控制函数
function showProgress() {
  $("progressContainer").style.display = "block";
}

function hideProgress() {
  $("progressContainer").style.display = "none";
  isScrapingInProgress = false;
  $("scrapeAllBtn").disabled = false;
  if (progressPort) {
    progressPort.disconnect();
    progressPort = null;
  }
}

function updateProgress(percent, text, details = "") {
  $("progressFill").style.width = percent + "%";
  $("progressPercent").textContent = Math.round(percent) + "%";
  $("progressText").textContent = text;
  $("progressDetails").textContent = details;
}

function setupProgressListener() {
  // 建立与service worker的长连接以接收进度更新
  progressPort = chrome.runtime.connect({ name: "progress" });

  progressPort.onMessage.addListener((message) => {
    // 收到任何进度/快照消息都要确保进度UI可见
    showProgress();
    isScrapingInProgress = true;

    if (message.type === "progress") {
      const { current, total, status, details, bookTitle } = message;
      const percent = total > 0 ? (current / total) * 100 : 0;

      if (bookTitle) {
        $("progressTitle").textContent = `《${bookTitle}》抓取进度`;
      }

      updateProgress(percent, status, details);

      // 更新暂停/继续按钮状态
      if (message.paused) {
        $("pauseBtn").textContent = "继续";
      } else {
        $("pauseBtn").textContent = "暂停";
      }
    } else if (message.type === "complete") {
      updateProgress(100, "抓取完成", message.details || "所有章节已下载完成");
      setTimeout(hideProgress, 3000); // 3秒后自动隐藏
    } else if (message.type === "error") {
      updateProgress(0, "抓取失败", message.error || "发生未知错误");
      setTimeout(hideProgress, 5000); // 5秒后自动隐藏
    } else if (message.type === "stopped") {
      updateProgress(0, "已终止", "用户手动终止了抓取任务");
      setTimeout(hideProgress, 2000); // 2秒后自动隐藏
    }
  });

  progressPort.onDisconnect.addListener(() => {
    progressPort = null;
    // 不主动隐藏，让用户能重新打开popup继续观看
  });
}

// 暂停/继续按钮
$("pauseBtn").addEventListener("click", () => {
  if (progressPort) {
    progressPort.postMessage({ action: "togglePause" });
  }
});

// 终止按钮
$("stopBtn").addEventListener("click", () => {
  if (confirm("确定要终止当前的抓取任务吗？")) {
    if (progressPort) {
      progressPort.postMessage({ action: "stop" });
    }
    hideProgress();
  }
});

// 打开popup时就连接进度端口，便于恢复显示
(function initProgressOnLoad() {
  try {
    setupProgressListener();
  } catch (e) {
    console.warn("popup: setupProgressListener failed", e);
  }
})();
