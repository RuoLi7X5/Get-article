// 后台 service worker：接收下载请求并使用 downloads API 保存为文件

// 默认配置
const DEFAULT_CONFIG = {
  volumeSize: 100, // 每卷章节数
  batchSize: 50, // 批量抓取大小
  requestDelay: 150, // 批次间请求间隔(ms)
  downloadPath: "", // 下载路径
  cleanEmptyLines: true, // 清理空行
  // 新增：批次内并发与稳定性控制
  concurrency: 10, // 批次内并发抓取数
  timeoutMs: 15000, // 单请求超时
  retryTimes: 2, // 抓取失败重试次数
  jitterMin: 30, // 每次请求后的抖动最小值(ms)
  jitterMax: 80, // 每次请求后的抖动最大值(ms)
};

// 抓取状态管理
let scrapingState = {
  isRunning: false,
  isPaused: false,
  shouldStop: false,
  currentTask: null,
  progressPort: null,
  // 进度快照：用于新 popup 连接后立即恢复显示
  lastProgress: null,
};

// 获取用户配置
async function getConfig() {
  try {
    const result = await chrome.storage.sync.get(["scrapeConfig"]);
    return { ...DEFAULT_CONFIG, ...result.scrapeConfig };
  } catch (e) {
    console.warn("service_worker: 获取配置失败，使用默认配置", e);
    return DEFAULT_CONFIG;
  }
}

// 可复用的章节链接获取函数
function getChapterLinksScript(includeIndexAndChapterNum = true) {
  // 启发式查找章节链接并确保按章序排序（从第1章开始）
  const allAnchors = Array.from(document.querySelectorAll("a"));
  const candidate = allAnchors
    .filter(
      (a) =>
        a.href &&
        (/chapter|\/\d+\/.+/i.test(a.getAttribute("href") || "") ||
          /第\d+章/.test(a.innerText))
    )
    .map((a) => ({ href: a.href, text: a.innerText.trim() }));

  // 优先选取看起来像目录的容器
  const containerSelectors = [
    "#list",
    ".chapter-list",
    ".chapters",
    ".read-list",
    ".box_list",
    ".chapter_list",
    ".box",
  ];
  let containerLinks = [];
  for (const sel of containerSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const items = Array.from(el.querySelectorAll("a")).map((a) => ({
        href: a.href,
        text: a.innerText.trim(),
      }));
      if (items.length) {
        containerLinks = items;
        break;
      }
    }
  }

  const useLinks = containerLinks.length ? containerLinks : candidate;

  // 解析章号的辅助函数：优先匹配"第123章"，否则尝试 href 中的最后一段数字
  const parseNum = (s, href) => {
    if (!s && !href) return null;
    const m = (s || "").match(/第\s*(\d+)\s*章/);
    if (m) return parseInt(m[1], 10);
    const mh = (href || "").match(/(\d+)(?=[^\d]*$)/);
    if (mh) return parseInt(mh[1], 10);
    const m2 = (s || "").match(/(\d+)/g);
    if (m2 && m2.length) return parseInt(m2[m2.length - 1], 10);
    return null;
  };

  const enriched = useLinks.map((l) => ({
    href: l.href,
    text: l.text,
    num: parseNum(l.text, l.href),
  }));

  // 如果大部分项能解析出数字，则按数字升序排序
  const numCount = enriched.filter((x) => x.num !== null).length;
  if (numCount >= Math.max(3, Math.floor(enriched.length * 0.3))) {
    enriched.sort((a, b) => (a.num || 0) - (b.num || 0));
    return {
      title: bookTitle.trim(),
      links: enriched.map((x, index) => {
        const baseLink = { href: x.href, text: x.text };
        if (includeIndexAndChapterNum) {
          return { ...baseLink, index: index + 1, chapterNum: x.num };
        }
        return baseLink;
      }),
    };
  }

  // 否则尝试检测是否为最新在前（多数链接序号递减），若是则反转
  let descending = 0,
    ascending = 0;
  for (let i = 0; i < enriched.length - 1; i++) {
    const a = enriched[i].num,
      b = enriched[i + 1].num;
    if (a != null && b != null) {
      if (a > b) descending++;
      else if (a < b) ascending++;
    }
  }
  let final = enriched.map((x) => ({
    href: x.href,
    text: x.text,
    num: x.num,
  }));
  if (descending > ascending) final = final.reverse();

  return {
    title: bookTitle.trim(),
    links: final.map((x, index) => {
      const baseLink = { href: x.href, text: x.text };
      if (includeIndexAndChapterNum) {
        return { ...baseLink, index: index + 1, chapterNum: x.num };
      }
      return baseLink;
    }),
  };
}

// 文本清理函数
function cleanText(text, shouldClean = true) {
  if (!text || !shouldClean) return text;

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

// 生成下载文件名（包含子文件夹）
function generateFilename(baseName, config) {
  const safeName = baseName.replace(/[\\/:*?"<>|]+/g, "_");
  if (config.downloadPath && config.downloadPath.trim()) {
    // 只使用文件夹名称，替换非法字符
    const safePath = config.downloadPath.trim().replace(/[\\/:*?"<>|]+/g, "_");
    return `${safePath}/${safeName}`;
  }
  return safeName;
}

// 通过 offscreen 文档写入文本（绝对路径）
async function writeTextViaOffscreen(filename, text) {
  try {
    // 确保 offscreen 文档存在
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification:
          "Write files to user-chosen absolute directory using the File System Access API",
      });
    } catch (e) {}
    // ping 检测 offscreen 是否就绪
    try {
      const ping = await chrome.runtime.sendMessage({
        scope: "offscreen",
        type: "ping",
      });
      if (!ping?.success) throw new Error("offscreen not responding");
    } catch (_) {}

    const res = await chrome.runtime.sendMessage({
      scope: "offscreen",
      type: "writeText",
      filename,
      text,
    });
    return res; // return full response for error handling
  } catch (e) {
    console.warn("service_worker: writeTextViaOffscreen failed", e);
    return { success: false, error: String(e) };
  }
}

// 进度报告函数
function reportProgress(current, total, status, details = "", bookTitle = "") {
  // 更新快照
  scrapingState.lastProgress = {
    type: "progress",
    current,
    total,
    status,
    details,
    bookTitle,
    paused: scrapingState.isPaused,
  };
  if (scrapingState.progressPort) {
    try {
      scrapingState.progressPort.postMessage(scrapingState.lastProgress);
    } catch (e) {
      console.warn("service_worker: 发送进度消息失败", e);
    }
  }
}

function reportComplete(details = "") {
  scrapingState.lastProgress = { type: "complete", details };
  if (scrapingState.progressPort) {
    try {
      scrapingState.progressPort.postMessage(scrapingState.lastProgress);
    } catch (e) {
      console.warn("service_worker: 发送完成消息失败", e);
    }
  }
  resetScrapingState();
}

function reportError(error) {
  scrapingState.lastProgress = { type: "error", error };
  if (scrapingState.progressPort) {
    try {
      scrapingState.progressPort.postMessage(scrapingState.lastProgress);
    } catch (e) {
      console.warn("service_worker: 发送错误消息失败", e);
    }
  }
  resetScrapingState();
}

function reportStopped() {
  scrapingState.lastProgress = { type: "stopped" };
  if (scrapingState.progressPort) {
    try {
      scrapingState.progressPort.postMessage(scrapingState.lastProgress);
    } catch (e) {
      console.warn("service_worker: 发送停止消息失败", e);
    }
  }
  resetScrapingState();
}

function resetScrapingState() {
  scrapingState.isRunning = false;
  scrapingState.isPaused = false;
  scrapingState.shouldStop = false;
  scrapingState.currentTask = null;
  // 不重置 progressPort，让它自然断开
}

// 等待函数（支持暂停和停止检查）
async function waitWithControl(ms) {
  const startTime = Date.now();
  while (Date.now() - startTime < ms) {
    if (scrapingState.shouldStop) {
      throw new Error("STOPPED");
    }
    if (scrapingState.isPaused) {
      await new Promise((resolve) => {
        const checkResume = () => {
          if (scrapingState.shouldStop) {
            throw new Error("STOPPED");
          }
          if (!scrapingState.isPaused) {
            resolve();
          } else {
            setTimeout(checkResume, 100);
          }
        };
        checkResume();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// 处理长连接（用于进度通信）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "progress") {
    scrapingState.progressPort = port;

    // 新连接立即推送一次快照，便于 popup 恢复进度
    if (scrapingState.lastProgress) {
      try {
        port.postMessage(scrapingState.lastProgress);
      } catch (e) {
        console.warn("service_worker: 推送快照失败", e);
      }
    }

    port.onMessage.addListener((message) => {
      if (message.action === "togglePause") {
        scrapingState.isPaused = !scrapingState.isPaused;
        console.log("service_worker: 暂停状态切换为", scrapingState.isPaused);
      } else if (message.action === "stop") {
        scrapingState.shouldStop = true;
        console.log("service_worker: 收到停止指令");
      }
    });

    port.onDisconnect.addListener(() => {
      console.log("service_worker: 进度连接断开");
      scrapingState.progressPort = null;
    });
  }
});

// HTML实体解码函数
function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

// 改进的HTML内容提取函数
function extractContentFromHtml(html, titleFallback = "未命名章节") {
  let title = titleFallback;
  let content = "";

  // 提取标题 - 尝试多种标题选择器
  const titleSelectors = [
    /<h1[^>]*>(.*?)<\/h1>/i,
    /<h2[^>]*>(.*?)<\/h2>/i,
    /<h3[^>]*>(.*?)<\/h3>/i,
    /<title[^>]*>(.*?)<\/title>/i,
    /<[^>]*class="[^"]*title[^"]*"[^>]*>(.*?)<\/[^>]*>/i,
    /<[^>]*class="[^"]*chapter[^"]*"[^>]*>(.*?)<\/[^>]*>/i,
  ];

  for (const regex of titleSelectors) {
    const match = html.match(regex);
    if (match) {
      const extractedTitle = match[1].replace(/<[^>]*>/g, "").trim();
      if (
        extractedTitle &&
        extractedTitle.length > 0 &&
        extractedTitle.length < 200
      ) {
        title = extractedTitle;
        break;
      }
    }
  }

  // 提取内容 - 更全面的选择器列表
  const contentPatterns = [
    // 常见的内容ID和类名
    /<[^>]*id="content"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*content[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*id="chapter-content"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*chapter-content[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*novel-content[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*id="novel-content"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*text-content[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*id="text-content"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*chapter[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*id="chapter"[^>]*>(.*?)<\/[^>]*>/is,
    /<main[^>]*>(.*?)<\/main>/is,
    /<article[^>]*>(.*?)<\/article>/is,
    /<section[^>]*>(.*?)<\/section>/is,

    // 特定网站的选择器
    /<[^>]*class="[^"]*txt[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*id="txt"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*read[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*id="read"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*book[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
    /<[^>]*class="[^"]*story[^"]*"[^>]*>(.*?)<\/[^>]*>/is,
  ];

  for (const regex of contentPatterns) {
    const match = html.match(regex);
    if (match) {
      const extractedContent = match[1].replace(/<[^>]*>/g, "").trim();
      // 过滤掉版权声明等无关内容
      if (
        extractedContent &&
        extractedContent.length > 100 &&
        !extractedContent.includes("Copyright") &&
        !extractedContent.includes("版权") &&
        !extractedContent.includes("www.") &&
        !extractedContent.includes("http") &&
        !extractedContent.includes("All Rights Reserved")
      ) {
        content = extractedContent;
        break;
      }
    }
  }

  // 如果还是没有找到合适的内容，尝试智能段落提取
  if (!content || content.length < 100) {
    const pMatches = html.match(/<p[^>]*>(.*?)<\/p>/gi);
    if (pMatches) {
      const paragraphs = pMatches
        .map((p) => p.replace(/<[^>]*>/g, "").trim())
        .filter(
          (text) =>
            text.length > 20 &&
            !text.includes("Copyright") &&
            !text.includes("版权") &&
            !text.includes("www.") &&
            !text.includes("http") &&
            !text.includes("All Rights Reserved") &&
            !text.includes("网站地址")
        );

      if (paragraphs.length > 3) {
        content = paragraphs.join("\n\n");
      }
    }
  }

  // 如果仍然没有内容，尝试提取div中的文本
  if (!content || content.length < 100) {
    const divMatches = html.match(/<div[^>]*>(.*?)<\/div>/gi);
    if (divMatches) {
      let longestDiv = "";
      for (const div of divMatches) {
        const text = div.replace(/<[^>]*>/g, "").trim();
        if (
          text.length > longestDiv.length &&
          text.length > 200 &&
          !text.includes("Copyright") &&
          !text.includes("版权") &&
          !text.includes("www.") &&
          !text.includes("http")
        ) {
          longestDiv = text;
        }
      }
      if (longestDiv) {
        content = longestDiv;
      }
    }
  }

  // 解码HTML实体
  title = decodeHtmlEntities(title);
  content = decodeHtmlEntities(content);

  return { title, content };
}

// 格式化章节范围显示
function formatChapterRange(chapters) {
  if (chapters.length === 0) return "";
  if (chapters.length === 1) return chapters[0].toString();

  const ranges = [];
  let start = chapters[0];
  let end = chapters[0];

  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i] === end + 1) {
      end = chapters[i];
    } else {
      if (start === end) {
        ranges.push(start.toString());
      } else {
        ranges.push(`${start}-${end}`);
      }
      start = end = chapters[i];
    }
  }

  if (start === end) {
    ranges.push(start.toString());
  } else {
    ranges.push(`${start}-${end}`);
  }

  return ranges.join(",");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // 处理指定章节抓取请求
  if (
    message &&
    message.action === "scrapeRange" &&
    message.tabId &&
    message.chapters
  ) {
    (async () => {
      try {
        if (scrapingState.isRunning) {
          sendResponse({ success: false, error: "已有抓取任务在运行" });
          return;
        }

        scrapingState.isRunning = true;
        scrapingState.currentTask = "scrapeRange";

        const tabId = message.tabId;
        const targetChapters = message.chapters; // 要抓取的章节号数组

        console.log("service_worker: 开始指定章节抓取", targetChapters);

        // 使用可复用的章节链接获取函数
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: getChapterLinksScript,
          args: [true],
        });

        const payload = results?.[0]?.result;
        if (!payload || !payload.links || payload.links.length === 0) {
          throw new Error("未找到章节链接");
        }

        const bookTitle = payload.title || "book";
        const allLinks = payload.links;

        // 过滤出要抓取的章节（优先按真实章节号匹配，如果没有则按位置匹配）
        const selectedLinks = allLinks.filter((link) => {
          // 如果有真实章节号，优先按章节号匹配
          if (link.chapterNum !== null && link.chapterNum !== undefined) {
            return targetChapters.includes(link.chapterNum);
          }
          // 否则按位置匹配
          return targetChapters.includes(link.index);
        });

        if (selectedLinks.length === 0) {
          // 提供更详细的错误信息
          const chapterNums = allLinks
            .filter(
              (link) =>
                link.chapterNum !== null && link.chapterNum !== undefined
            )
            .map((link) => link.chapterNum)
            .sort((a, b) => a - b);

          const errorMsg =
            chapterNums.length > 0
              ? `没有找到指定的章节。可用章节号: ${chapterNums
                  .slice(0, 10)
                  .join(", ")}${chapterNums.length > 10 ? "..." : ""} (共${
                  chapterNums.length
                }章)`
              : `没有找到指定的章节。总共有 ${allLinks.length} 个章节，请检查章节号是否正确。`;

          throw new Error(errorMsg);
        }

        console.log(`service_worker: 找到 ${selectedLinks.length} 个指定章节`);

        // 获取用户配置
        const config = await getConfig();
        const { batchSize, requestDelay, cleanEmptyLines } = config;

        // 报告初始进度
        reportProgress(
          0,
          selectedLinks.length,
          "开始抓取指定章节",
          `准备抓取 ${selectedLinks.length} 个章节`,
          bookTitle
        );

        // 开始抓取选定的章节
        let allChapterTexts = [];
        let chapterCounter = 0;

        for (let start = 0; start < selectedLinks.length; start += batchSize) {
          if (!scrapingState.isRunning) {
            throw new Error("STOPPED");
          }

          const batch = selectedLinks.slice(start, start + batchSize);
          console.log(
            `service_worker: 抓取批次 ${start + 1}-${start + batch.length}`
          );

          reportProgress(
            chapterCounter,
            selectedLinks.length,
            `抓取批次 ${Math.floor(start / batchSize) + 1}`,
            `正在抓取第 ${start + 1}-${start + batch.length} 章`,
            bookTitle
          );

          // 使用与整本抓取相同的逻辑，在当前标签页上下文中执行fetch
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (hrefs) => {
              return (async () => {
                const out = [];
                for (const href of hrefs) {
                  try {
                    const resp = await fetch(href, { method: "GET" });
                    const html = await resp.text();
                    const doc = new DOMParser().parseFromString(
                      html,
                      "text/html"
                    );

                    // 提取标题
                    let title = "";
                    const titleSelectors = [
                      "h1",
                      "h2",
                      ".chapter-title",
                      ".title",
                      "title",
                    ];
                    for (const selector of titleSelectors) {
                      const el = doc.querySelector(selector);
                      if (el && el.innerText && el.innerText.trim()) {
                        title = el.innerText.trim();
                        break;
                      }
                    }

                    // 提取内容
                    const selectors = [
                      "#content",
                      ".content",
                      ".read-content",
                      ".chapter-content",
                      ".novel-content",
                      ".txt",
                      ".article",
                      "main",
                      ".main",
                      "#chapter",
                      ".chapter",
                      ".book-content",
                      ".story-content",
                    ];
                    let text = "";
                    for (const s of selectors) {
                      const el = doc.querySelector(s);
                      if (el && el.innerText && el.innerText.length > 50) {
                        text = el.innerText.trim();
                        break;
                      }
                    }

                    // 如果没有找到合适的内容，尝试段落聚合
                    if (!text || text.length < 100) {
                      const paragraphs = Array.from(doc.querySelectorAll("p"))
                        .map((p) => (p.innerText ? p.innerText.trim() : ""))
                        .filter(
                          (t) =>
                            t.length > 20 &&
                            !t.includes("Copyright") &&
                            !t.includes("版权") &&
                            !t.includes("网站地址")
                        );

                      if (paragraphs.length > 3) {
                        text = paragraphs.join("\n\n");
                      }
                    }

                    out.push({
                      href,
                      title: title || "未命名章节",
                      content: text || "[无法获取内容]",
                    });
                  } catch (err) {
                    console.error(`抓取失败 ${href}:`, err);
                    out.push({
                      href,
                      title: "抓取失败",
                      content: `[抓取失败: ${err.message}]`,
                    });
                  }
                }
                return out;
              })();
            },
            args: [batch.map((link) => link.href)],
          });

          const fetchResults = results?.[0]?.result || [];

          // 处理批次结果，转换为期望的格式
          const batchPromises = fetchResults.map((result, index) => {
            const orig = batch[index];

            return {
              title: cleanText(result.title || orig.text, cleanEmptyLines),
              text: cleanText(result.content, cleanEmptyLines),
              chapterNumber: orig.index,
              success: result.content && result.content !== "[无法获取内容]",
            };
          });

          const batchResults = batchPromises;

          // 按章节号排序并添加到结果中
          batchResults.sort((a, b) => a.chapterNumber - b.chapterNumber);
          allChapterTexts.push(...batchResults);

          chapterCounter += batch.length;

          reportProgress(
            chapterCounter,
            selectedLinks.length,
            `已完成 ${chapterCounter}/${selectedLinks.length} 章`,
            `批次完成，准备下一批次...`,
            bookTitle
          );

          // 轻微延时以降低并发压力
          await waitWithControl(requestDelay);
        }

        // 生成合并文件
        const chapterNumbers = targetChapters.sort((a, b) => a - b);
        const rangeStr = formatChapterRange(chapterNumbers);
        const filename = generateFilename(
          `${bookTitle}_第${rangeStr}章.txt`,
          config
        );

        // 合并所有章节内容
        let mergedContent = `${bookTitle}\n\n`;
        allChapterTexts.forEach((chapter) => {
          mergedContent += `${chapter.title}\n\n${chapter.text}\n\n`;
        });

        // 最终清理整个文本
        const finalText = cleanText(mergedContent, cleanEmptyLines);
        const blobUrl =
          "data:text/plain;charset=utf-8," + encodeURIComponent(finalText);

        reportProgress(
          selectedLinks.length,
          selectedLinks.length,
          "下载合并文件",
          `正在下载: ${filename}`,
          bookTitle
        );

        const res = await writeTextViaOffscreen(filename, finalText);
        if (!res?.success) {
          if (res?.error === "NO_DIR" || res?.error === "NO_PERMISSION") {
            reportError("授权已失效或未授权，请在设置页重新授权保存目录");
            // 已在入口处 sendResponse，长任务期间不再调用 sendResponse
            return;
          }
          // 其他错误回退到下载目录
          chrome.downloads.download(
            { url: blobUrl, filename: filename, conflictAction: "uniquify" },
            (id) => {
              if (chrome.runtime.lastError) {
                console.error(
                  "service_worker: 下载失败：",
                  chrome.runtime.lastError
                );
                reportError("下载失败: " + chrome.runtime.lastError.message);
                return;
              }
              console.log("service_worker: 回退至 downloads API，id=", id);
            }
          );
        } else {
          console.log("service_worker: 已通过 offscreen 文档写入: ", filename);
        }
        reportComplete(
          `《${bookTitle}》指定章节抓取完成，共 ${selectedLinks.length} 章已合并下载`
        );

        sendResponse({ success: true });
      } catch (err) {
        console.error("service_worker: 指定章节抓取失败", err);
        if (err.message === "STOPPED") {
          reportError("抓取已被用户终止");
        } else {
          reportError("抓取失败: " + err.message);
        }
        sendResponse({ success: false, error: err.message });
      } finally {
        scrapingState.isRunning = false;
        scrapingState.currentTask = null;
      }
    })();

    return true; // 异步响应
  }

  // 处理整本抓取请求
  if (message && message.action === "scrapeBook" && message.tabId) {
    // 检查是否已有任务在运行
    if (scrapingState.isRunning) {
      sendResponse({ success: false, error: "已有抓取任务在进行中" });
      return false;
    }
    const tabId = message.tabId;

    // 初始化抓取状态
    scrapingState.isRunning = true;
    scrapingState.isPaused = false;
    scrapingState.shouldStop = false;

    // 立即响应：告知调用方任务已开始（避免后续消息通道关闭错误）
    console.log("service_worker: scrapeBook received for tabId=", tabId);
    try {
      sendResponse({ success: true, started: true });
    } catch (e) {
      console.warn("service_worker: sendResponse immediate failed", e);
    }

    // 在目标标签页上下文执行脚本以获取章节列表（href 和 text）以及书名
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          // 启发式查找章节链接并确保按章序排序（从第1章开始）
          const allAnchors = Array.from(document.querySelectorAll("a"));
          const candidate = allAnchors
            .filter(
              (a) =>
                a.href &&
                (/chapter|\/\d+\/.+/i.test(a.getAttribute("href") || "") ||
                  /第\d+章/.test(a.innerText))
            )
            .map((a) => ({ href: a.href, text: a.innerText.trim() }));

          // 优先选取看起来像目录的容器
          const containerSelectors = [
            "#list",
            ".chapter-list",
            ".chapters",
            ".read-list",
            ".box_list",
            ".chapter_list",
            ".box",
          ];
          let containerLinks = [];
          for (const sel of containerSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const items = Array.from(el.querySelectorAll("a")).map((a) => ({
                href: a.href,
                text: a.innerText.trim(),
              }));
              if (items.length) {
                containerLinks = items;
                break;
              }
            }
          }

          const useLinks = containerLinks.length ? containerLinks : candidate;

          // 解析章号的辅助函数：优先匹配“第123章”，否则尝试 href 中的最后一段数字
          const parseNum = (s, href) => {
            if (!s && !href) return null;
            const m = (s || "").match(/第\s*(\d+)\s*章/);
            if (m) return parseInt(m[1], 10);
            const mh = (href || "").match(/(\d+)(?=[^\d]*$)/);
            if (mh) return parseInt(mh[1], 10);
            const m2 = (s || "").match(/(\d+)/g);
            if (m2 && m2.length) return parseInt(m2[m2.length - 1], 10);
            return null;
          };

          const enriched = useLinks.map((l) => ({
            href: l.href,
            text: l.text,
            num: parseNum(l.text, l.href),
          }));

          // 如果大部分项能解析出数字，则按数字升序排序
          const numCount = enriched.filter((x) => x.num !== null).length;
          if (numCount >= Math.max(3, Math.floor(enriched.length * 0.3))) {
            enriched.sort((a, b) => (a.num || 0) - (b.num || 0));
            return {
              title:
                document.querySelector("h1")?.innerText ||
                document.title ||
                "book",
              links: enriched.map((x) => ({ href: x.href, text: x.text })),
            };
          }

          // 否则尝试检测是否为最新在前（多数链接序号递减），若是则反转
          let descending = 0,
            ascending = 0;
          for (let i = 0; i < enriched.length - 1; i++) {
            const a = enriched[i].num,
              b = enriched[i + 1].num;
            if (a != null && b != null) {
              if (a > b) descending++;
              else if (a < b) ascending++;
            }
          }
          let final = enriched.map((x) => ({ href: x.href, text: x.text }));
          if (descending > ascending) final = final.reverse();

          return {
            title:
              document.querySelector("h1")?.innerText ||
              document.title ||
              "book",
            links: final,
          };
        },
      },
      async (res) => {
        try {
          console.log("service_worker: executeScript result:", res);
          const payload = res?.[0]?.result;
          if (!payload || !payload.links || payload.links.length === 0) {
            console.error("service_worker: 未能在页面上找到章节列表", payload);
            reportError("未能在页面上找到章节列表");
            return; // Stop processing on failure
          }

          console.log(
            "service_worker: 发现章节数=",
            payload.links.length,
            "bookTitle=",
            payload.title
          );

          const bookTitle = payload.title || "book";
          const links = payload.links;

          // 获取用户配置
          const config = await getConfig();
          const {
            volumeSize,
            batchSize,
            requestDelay,
            downloadPath,
            cleanEmptyLines,
          } = config;
          const total = links.length;
          console.log(
            "service_worker: total chapters to fetch=",
            total,
            "batchSize=",
            batchSize,
            "volumeSize=",
            volumeSize,
            "requestDelay=",
            requestDelay,
            "downloadPath=",
            downloadPath,
            "cleanEmptyLines=",
            cleanEmptyLines
          );

          // 报告初始进度
          reportProgress(
            0,
            total,
            "开始抓取",
            `共发现 ${total} 章节`,
            bookTitle
          );

          let currentPartText = "";
          let partStartChapter = 1;
          let chapterGlobalCounter = 0;

          for (let start = 0; start < total; start += batchSize) {
            // 检查是否应该停止
            if (scrapingState.shouldStop) {
              reportStopped();
              return;
            }

            const batch = links.slice(start, start + batchSize);
            const hrefs = batch.map((x) => x.href);
            const batchNum = Math.floor(start / batchSize) + 1;
            const totalBatches = Math.ceil(total / batchSize);

            console.log(
              "service_worker: processing batch",
              batchNum,
              "of",
              totalBatches,
              "size=",
              hrefs.length
            );

            reportProgress(
              start,
              total,
              `抓取批次 ${batchNum}/${totalBatches}`,
              `正在抓取第 ${start + 1}-${Math.min(
                start + batchSize,
                total
              )} 章`,
              bookTitle
            );

            const results = await new Promise((resolve) => {
              chrome.scripting.executeScript(
                {
                  target: { tabId },
                  func: (hrefs) => {
                    return (async () => {
                      const out = [];
                      for (const href of hrefs) {
                        try {
                          const resp = await fetch(href, { method: "GET" });
                          const html = await resp.text();
                          const doc = new DOMParser().parseFromString(
                            html,
                            "text/html"
                          );
                          const selectors = [
                            "#content",
                            ".content",
                            ".read-content",
                            ".chapter-content",
                            ".novel-content",
                            ".txt",
                            ".article",
                          ];
                          let text = "";
                          for (const s of selectors) {
                            const el = doc.querySelector(s);
                            if (
                              el &&
                              el.innerText &&
                              el.innerText.length > 50
                            ) {
                              text = el.innerText.trim();
                              break;
                            }
                          }
                          if (!text) {
                            const ps = Array.from(doc.querySelectorAll("p"))
                              .map((p) => p.innerText.trim())
                              .filter((t) => t.length > 20);
                            if (ps.length) text = ps.join("\n\n");
                            else text = doc.body.innerText.trim().slice(0, 20000);
                          }
                          const title =
                            doc.querySelector("h1")?.innerText || "";
                          out.push({ success: true, title, text, href });
                        } catch (err) {
                          out.push({
                            success: false,
                            error: String(err),
                            href,
                          });
                        }
                      }
                      return out;
                    })();
                  },
                  args: [hrefs],
                },
                (res) => {
                  resolve(res?.[0]?.result || []);
                }
              );
            });

            for (let i = 0; i < results.length; i++) {
              // 检查是否应该停止
              if (scrapingState.shouldStop) {
                reportStopped();
                return;
              }

              const r = results[i];
              const globalIndex = start + i;
              const orig = links[globalIndex];
              chapterGlobalCounter = globalIndex + 1;

              // 更新详细进度
              reportProgress(
                globalIndex + 1,
                total,
                `处理章节 ${globalIndex + 1}/${total}`,
                `正在处理: ${orig.text || "第" + (globalIndex + 1) + "章"}`,
                bookTitle
              );

              if (!r || !r.success) {
                console.error(
                  "service_worker: chapter parse failed for",
                  orig?.href,
                  r
                );
                if (!currentPartText) {
                  currentPartText += (bookTitle || "book") + "\n\n";
                  partStartChapter = globalIndex + 1;
                }
                currentPartText +=
                  "第" + (globalIndex + 1) + "章 - 抓取失败\n\n";
              } else {
                const chapterTitle =
                  r.title || orig.text || "第" + (globalIndex + 1) + "章";

                // 清理章节内容
                const cleanedText = cleanText(r.text, cleanEmptyLines);
                const cleanedTitle = cleanText(chapterTitle, cleanEmptyLines);

                console.log(
                  "service_worker: parsed chapter",
                  globalIndex + 1,
                  "title=",
                  cleanedTitle,
                  "originalLength=",
                  r.text.length,
                  "cleanedLength=",
                  cleanedText.length
                );

                if (!currentPartText) {
                  currentPartText += (bookTitle || "book") + "\n\n";
                  partStartChapter = globalIndex + 1;
                }
                currentPartText += cleanedTitle + "\n\n" + cleanedText + "\n\n";
              }

              // 判断是否应当导出当前分卷
              const partCount = globalIndex + 1 - partStartChapter + 1;
              if (partCount >= volumeSize) {
                const partEnd = globalIndex + 1;
                const baseName = `${bookTitle}${partStartChapter}-${partEnd}.txt`;
                const filename = generateFilename(baseName, config);

                // 最终清理整个分卷文本
                const finalText = cleanText(currentPartText, cleanEmptyLines);
                const blobUrl =
                  "data:text/plain;charset=utf-8," +
                  encodeURIComponent(finalText);

                reportProgress(
                  globalIndex + 1,
                  total,
                  `下载分卷 ${partStartChapter}-${partEnd}`,
                  `正在下载: ${filename}`,
                  bookTitle
                );

                // 优先通过 offscreen 写入授权目录
                const writeRes = await writeTextViaOffscreen(
                  filename,
                  finalText
                );
                if (!writeRes?.success) {
                  if (
                    writeRes?.error === "NO_DIR" ||
                    writeRes?.error === "NO_PERMISSION"
                  ) {
                    reportError(
                      "授权已失效或未授权，请在设置页重新授权保存目录"
                    );
                    // 已在入口处 sendResponse，长任务期间不再调用 sendResponse
                    return;
                  }
                  // 仅在其它错误时回退浏览器下载目录
                  chrome.downloads.download(
                    {
                      url: blobUrl,
                      filename: filename,
                      conflictAction: "uniquify",
                    },
                    (id) => {
                      if (chrome.runtime.lastError)
                        console.error(
                          "service_worker: 下载失败：",
                          chrome.runtime.lastError
                        );
                      else
                        console.log(
                          "service_worker: 分卷下载已启动，id=",
                          id,
                          "filename=",
                          filename
                        );
                    }
                  );
                  currentPartText = "";
                  partStartChapter = globalIndex + 2;
                  // 小延时
                  await waitWithControl(200);
                } else {
                  // 分卷写入成功后，同样需要清空缓存并推进起始章节
                  currentPartText = "";
                  partStartChapter = globalIndex + 2;
                  // 小延时
                  await waitWithControl(200);
                }
              }
              // 轻微延时以降低并发压力
              await waitWithControl(requestDelay);
            }

            // 导出最后一卷（若有未导出内容）
            // 仅在最后一个批次时导出最后一卷（若有未导出内容）
            if (start + batchSize < total) {
              // 非最后一批，跳过导出最后一卷
            } else if (currentPartText) {
              const partEnd = chapterGlobalCounter;
              const baseName = `${bookTitle}${partStartChapter}-${partEnd}.txt`;
              const filename = generateFilename(baseName, config);

              // 最终清理整个分卷文本
              const finalText = cleanText(currentPartText, cleanEmptyLines);
              const blobUrl =
                "data:text/plain;charset=utf-8," +
                encodeURIComponent(finalText);

              reportProgress(
                total,
                total,
                "下载最后一卷",
                `正在下载: ${filename}`,
                bookTitle
              );

              const writeRes = await writeTextViaOffscreen(filename, finalText);
              if (!writeRes?.success) {
                if (
                  writeRes?.error === "NO_DIR" ||
                  writeRes?.error === "NO_PERMISSION"
                ) {
                  reportError("授权已失效或未授权，请在设置页重新授权保存目录");
                  // 已在入口处 sendResponse，长任务期间不再调用 sendResponse
                  return;
                }
                chrome.downloads.download(
                  {
                    url: blobUrl,
                    filename: filename,
                    conflictAction: "uniquify",
                  },
                  (id) => {
                    if (chrome.runtime.lastError) {
                      console.error(
                        "service_worker: 最后一卷下载失败：",
                        chrome.runtime.lastError
                      );
                      reportError(
                        "最后一卷下载失败: " + chrome.runtime.lastError.message
                      );
                    } else {
                      console.log(
                        "service_worker: 最后一卷回退 downloads API，id=",
                        id
                      );
                      reportComplete(
                        `《${bookTitle}》抓取完成，共 ${total} 章节已分卷下载`
                      );
                    }
                  }
                );
              } else {
                reportComplete(
                  `《${bookTitle}》抓取完成，共 ${total} 章节已分卷下载`
                );
              }
            } else {
              reportComplete(
                `《${bookTitle}》抓取完成，共 ${total} 章节已分卷下载`
              );
            }
          }
        } catch (err) {
          console.error(err);
          console.error("抓取过程中发生错误：", err);
          if (err.message === "STOPPED") {
            reportStopped();
          } else {
            reportError("抓取过程中发生错误: " + (err.message || err));
          }
        }
      }
    );

    // 已同步响应，后续不再使用 sendResponse
    return false;
  }
  if (message && message.action === "download" && message.text) {
    // 获取配置并应用下载路径
    getConfig()
      .then(async (config) => {
        const originalFilename = message.filename || "novel.txt";
        const filename = generateFilename(originalFilename, config);

        // 应用文本清理
        const text = cleanText(message.text, config.cleanEmptyLines);

        // 优先通过 offscreen 写入授权目录
        try {
          const res = await writeTextViaOffscreen(filename, text);
          if (res?.success) {
            sendResponse({ success: true, via: "offscreen" });
            return;
          }
          if (res?.error === "NO_DIR" || res?.error === "NO_PERMISSION") {
            // 无授权：回退到浏览器下载目录
          } else {
            // 其它错误也回退
          }
        } catch (_) {}

        const blobUrl =
          "data:text/plain;charset=utf-8," + encodeURIComponent(text);
        chrome.downloads.download(
          { url: blobUrl, filename: filename, conflictAction: "uniquify" },
          (id) => {
            if (chrome.runtime.lastError) {
              console.error("下载失败：", chrome.runtime.lastError);
              sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            } else {
              sendResponse({ success: true, id });
            }
          }
        );
      })
      .catch((error) => {
        console.error("获取配置失败：", error);
        // 降级处理：使用原始文件名
        const filename = message.filename || "novel.txt";
        const text = message.text;
        const blobUrl =
          "data:text/plain;charset=utf-8," + encodeURIComponent(text);

        chrome.downloads.download(
          { url: blobUrl, filename: filename, conflictAction: "uniquify" },
          (id) => {
            if (chrome.runtime.lastError) {
              console.error("下载失败：", chrome.runtime.lastError);
              sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
            } else {
              sendResponse({ success: true, id });
            }
          }
        );
      });
    return true; // 异步响应：download 分支
  }
});
