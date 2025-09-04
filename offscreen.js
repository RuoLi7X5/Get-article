// Offscreen document for File System Access based writing
// It receives messages from service_worker and writes files to a
// previously granted directory using the File System Access API.

let dirHandle = null; // Persisted in IndexedDB; FileSystemHandle is structured clonable

// IndexedDB helpers
const DB_NAME = "novel_saver_fsa";
const STORE = "handles";
const KEY = "dir";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function restoreHandle() {
  try {
    const h = await idbGet(KEY);
    if (h) {
      dirHandle = h;
      return true;
    }
  } catch (e) {
    console.warn("offscreen: restoreHandle failed", e);
  }
  return false;
}

async function persistHandle(handle) {
  try {
    await idbSet(KEY, handle);
  } catch (e) {
    console.warn("offscreen: persistHandle failed", e);
  }
}

async function ensureDirectory() {
  if (dirHandle) return dirHandle;
  await restoreHandle();
  // 不在此处请求权限，避免无用户手势导致直接被拒
  return dirHandle;
}

async function chooseDirectory() {
  // Must be called from a user gesture; service worker will request offscreen to prompt
  dirHandle = await window.showDirectoryPicker();
  await persistHandle(dirHandle);
  return { success: true };
}

async function writeFile(filename, content) {
  const handle = await ensureDirectory();
  if (!handle) {
    return { success: false, error: "NO_DIR" };
  }
  // 权限确认：若不是 granted，尝试请求；若仍非 granted，则返回错误
  try {
    if (handle.queryPermission) {
      const q = await handle.queryPermission({ mode: "readwrite" });
      if (q !== "granted") {
        const r = await handle.requestPermission({ mode: "readwrite" });
        if (r !== "granted") {
          return { success: false, error: "NO_PERMISSION" };
        }
      }
    }
  } catch (e) {
    // 某些环境下 requestPermission 需要用户手势，这里直接返回需重新授权
    return { success: false, error: "NO_PERMISSION" };
  }

  try {
    // Create subfolders if path contains '/'
    const parts = filename.split("/").filter(Boolean);
    let current = handle;
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i], { create: true });
    }
    const fileHandle = await current.getFileHandle(parts[parts.length - 1], {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return { success: true };
  } catch (e) {
    console.error("offscreen: write failed", e);
    return { success: false, error: String(e && e.name ? e.name : e) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || message.scope !== "offscreen") return;
    try {
      if (message.type === "setDirectoryHandle" && message.handle) {
        dirHandle = message.handle;
        await persistHandle(dirHandle);
        sendResponse({ success: true });
      } else if (message.type === "chooseDirectory") {
        // Fallback: allow offscreen to prompt if UA grants activation (usually not)
        const res = await chooseDirectory();
        sendResponse(res);
      } else if (message.type === "writeText") {
        const res = await writeFile(message.filename, message.text);
        sendResponse(res);
      } else if (message.type === "hasDirectory") {
        const ok = await ensureDirectory();
        sendResponse({ success: !!ok, name: dirHandle?.name || null });
      } else if (message.type === "ping") {
        sendResponse({ success: true });
      } else if (message.type === "clearDirectory") {
        dirHandle = null;
        await idbDel(KEY);
        sendResponse({ success: true });
      }
    } catch (e) {
      console.error("offscreen: error handling message", e);
      sendResponse({ success: false, error: String(e) });
    }
  })();
  return true; // async
});
