const { app, BrowserWindow, BrowserView, ipcMain, safeStorage, Menu, MenuItem, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

const PORTAL_URL = 'https://fukuchiyama-web.campusplan.jp/portal/Account/Login?ReturnUrl=%2Fportal%2F';
const TOOLBAR_HEIGHT = 44;
const CRED_PATH = path.join(app.getPath('userData'), 'credentials.dat');
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
const MAX_AUTO_LOGIN_ATTEMPTS = 3;
const MAX_HISTORY_ENTRIES = 500;

let mainWindow = null;
let credWindow = null;
let historyWindow = null;
let aboutWindow = null;
let history = [];

// タブ管理（1つのウィンドウに複数のBrowserViewを持たせ、表示中のものだけ
// mainWindow.setBrowserView() で切り替える方式）
const tabs = new Map(); // id -> { id, view, title, closable }
let activeTabId = null;
let portalTabId = null;
let tabCounter = 0;

let autoLoginAttempts = 0;
let lastAutoLoginAt = 0;

// ---------- 資格情報の保存・読み込み（OSレベルの暗号化を利用） ----------

function loadCredentials() {
  try {
    if (!fs.existsSync(CRED_PATH)) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('この環境では資格情報の暗号化が利用できません。');
      return null;
    }
    const encrypted = fs.readFileSync(CRED_PATH);
    const json = safeStorage.decryptString(encrypted);
    return JSON.parse(json);
  } catch (err) {
    console.error('資格情報の読み込みに失敗しました:', err);
    return null;
  }
}

function saveCredentials(loginId, password) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('この環境では資格情報を安全に保存できません。');
  }
  const json = JSON.stringify({ loginId, password });
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(CRED_PATH, encrypted);
}

function clearCredentials() {
  if (fs.existsSync(CRED_PATH)) fs.unlinkSync(CRED_PATH);
}

// ---------- ウィンドウアイコン ----------

// OSに応じたアイコンファイルを assets/ から探す。存在しない場合はundefinedを返し、
// Electron既定のアイコンにフォールバックする。
function resolveIconPath() {
  const candidates = {
    win32: 'icon.ico',
    darwin: 'icon.icns',
    linux: 'icon.png',
  };
  const fileName = candidates[process.platform] || 'icon.png';
  const fullPath = path.join(__dirname, 'assets', fileName);
  return fs.existsSync(fullPath) ? fullPath : undefined;
}

// ---------- 閲覧履歴 ----------

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('履歴の読み込みに失敗しました:', err);
    return [];
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  } catch (err) {
    console.error('履歴の保存に失敗しました:', err);
  }
}

function broadcastHistory() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send('history-updated', history);
  }
}

// ログインページや空白ページは履歴に残さない。直前と同じURLの場合は
// タイトル・時刻だけ更新し、新しいエントリは追加しない。
function addHistoryEntry(url, title) {
  if (!url || url.startsWith('about:') || url.includes('/Account/Login')) return;

  if (history.length > 0 && history[0].url === url) {
    history[0].title = title || history[0].title;
    history[0].timestamp = Date.now();
  } else {
    history.unshift({ url, title: title || url, timestamp: Date.now() });
    if (history.length > MAX_HISTORY_ENTRIES) history.length = MAX_HISTORY_ENTRIES;
  }
  saveHistory();
  broadcastHistory();
}

// ---------- このアプリについて ----------

function createAboutWindow() {
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 420,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'このアプリについて',
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-about.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aboutWindow.setMenuBarVisibility(false);
  aboutWindow.loadFile(path.join(__dirname, 'renderer', 'about.html'));
  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });
}

ipcMain.handle('get-app-info', () => ({
  name: '福知山公立大学ポータルアプリ',
  version: app.getVersion(),
}));

function createHistoryWindow() {
  if (historyWindow) {
    historyWindow.focus();
    return;
  }
  historyWindow = new BrowserWindow({
    width: 480,
    height: 600,
    title: '履歴',
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-history.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  historyWindow.setMenuBarVisibility(false);
  historyWindow.loadFile(path.join(__dirname, 'renderer', 'history.html'));
  historyWindow.on('closed', () => {
    historyWindow = null;
  });
}

ipcMain.handle('get-history', () => history);
ipcMain.on('open-history-url', (event, url) => {
  const view = getActiveView();
  if (view && url) view.webContents.loadURL(url);
});
ipcMain.on('clear-history', () => {
  history = [];
  saveHistory();
  broadcastHistory();
});

// ---------- 資格情報入力ウィンドウ（初回起動時） ----------

function createCredentialsWindow() {
  credWindow = new BrowserWindow({
    width: 420,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '福知山公立大学ポータルアプリ - ログイン情報の設定',
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload-credentials.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  credWindow.setMenuBarVisibility(false);
  credWindow.loadFile(path.join(__dirname, 'renderer', 'credentials.html'));

  credWindow.on('closed', () => {
    credWindow = null;
  });
}

ipcMain.handle('save-credentials', (event, { loginId, password }) => {
  try {
    saveCredentials(loginId, password);
    if (credWindow) {
      credWindow.close();
    }
    createMainWindow();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// ---------- タブ（BrowserView）管理 ----------

function getActiveView() {
  const tab = tabs.get(activeTabId);
  return tab ? tab.view : null;
}

function updateViewBounds() {
  if (!mainWindow) return;
  const view = getActiveView();
  if (!view) return;
  const bounds = mainWindow.getContentBounds();
  view.setBounds({
    x: 0,
    y: TOOLBAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - TOOLBAR_HEIGHT),
  });
}

function updateNavState() {
  const view = getActiveView();
  if (!mainWindow || !view || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('nav-state', {
    canGoBack: view.webContents.canGoBack(),
    canGoForward: view.webContents.canGoForward(),
  });
}

function updateTabTitle(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const t = tab.view.webContents.getTitle();
  if (t && t.trim()) tab.title = t.trim();
}

function broadcastTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const list = Array.from(tabs.values()).map((t) => ({
    id: t.id,
    title: t.title,
    active: t.id === activeTabId,
    closable: t.closable,
  }));
  mainWindow.webContents.send('tabs-state', list);
}

function setActiveTab(id) {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return;
  activeTabId = id;
  mainWindow.setBrowserView(tab.view);
  updateViewBounds();
  updateNavState();
  broadcastTabs();
}

// url: 開くページ / opts.title: 初期タイトル / opts.closable: タブを閉じられるか
function createTab(url, opts = {}) {
  const id = ++tabCounter;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  tabs.set(id, {
    id,
    view,
    title: opts.title || '読み込み中...',
    closable: opts.closable !== undefined ? opts.closable : true,
  });

  // 別ウィンドウ（ポップアップ）として開こうとする遷移を、新しいタブとして開き
  // そちらへ切り替える処理に置き換える。WebClass等もポップアップにならず
  // 新しいタブとして表示される。
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    const newTabId = createTab(popupUrl, { title: 'WebClass' });
    setActiveTab(newTabId);
    return { action: 'deny' };
  });

  view.webContents.on('did-finish-load', () => {
    if (id === portalTabId) tryAutoLogin(view);
    updateTabTitle(id);
    addHistoryEntry(view.webContents.getURL(), view.webContents.getTitle());
    if (id === activeTabId) updateNavState();
    broadcastTabs();
  });
  view.webContents.on('page-title-updated', () => {
    updateTabTitle(id);
    broadcastTabs();
  });
  view.webContents.on('did-navigate', () => {
    if (id === activeTabId) updateNavState();
  });
  view.webContents.on('did-navigate-in-page', () => {
    if (id === activeTabId) updateNavState();
  });
  view.webContents.on('did-fail-load', (event, code, description) => {
    if (code !== -3) {
      console.error(`読み込みに失敗しました（タブ${id}）:`, code, description);
    }
  });
  view.webContents.on('context-menu', (event, params) => {
    const menu = buildContextMenu(view, params);
    menu.popup({ window: mainWindow });
  });
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isReloadShortcut =
      input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (isReloadShortcut) {
      event.preventDefault();
      view.webContents.reload();
    }
  });

  view.webContents.loadURL(url);
  broadcastTabs();
  return id;
}

// 指定したタブと同じURLを新しいタブとして開き、複製として切り替える
function duplicateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const url = tab.view.webContents.getURL();
  const newId = createTab(url, { title: tab.title, closable: true });
  setActiveTab(newId);
}

// 指定したタブと同じURLで、新しい（閉じられる）タブを開いてそちらへ切り替える
function duplicateTab(id) {
  const source = tabs.get(id);
  if (!source) return;
  const url = source.view.webContents.getURL() || PORTAL_URL;
  const newId = createTab(url, { title: source.title, closable: true });
  setActiveTab(newId);
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab || !tab.closable) return; // ポータルタブなど閉じられないタブは無視
  const wasActive = activeTabId === id;

  tabs.delete(id);
  if (mainWindow && mainWindow.getBrowserView() === tab.view) {
    mainWindow.setBrowserView(null);
  }
  try {
    tab.view.webContents.close();
  } catch (err) {
    // 破棄済みの場合は無視
  }

  if (wasActive) {
    const remaining = Array.from(tabs.keys());
    if (remaining.length > 0) {
      setActiveTab(remaining[remaining.length - 1]);
    }
  }
  broadcastTabs();
}

// ポータルのログインページを検出し、保存済みの資格情報を自動入力・送信する
async function tryAutoLogin(view) {
  if (!view) return;
  const currentUrl = view.webContents.getURL();
  if (!currentUrl.includes('/Account/Login')) {
    autoLoginAttempts = 0; // ログインページ以外に遷移したら試行回数をリセット
    return;
  }

  const creds = loadCredentials();
  if (!creds) return;

  const now = Date.now();
  if (now - lastAutoLoginAt < 2500) return; // 短時間の重複実行を防止
  if (autoLoginAttempts >= MAX_AUTO_LOGIN_ATTEMPTS) return; // ID/パスワード誤りによる無限ループを防止

  lastAutoLoginAt = now;
  autoLoginAttempts += 1;

  const script = `
    (function() {
      try {
        var pwInput = document.querySelector('input[type="password"]');
        if (!pwInput) return 'no-password-field';
        var form = pwInput.closest('form') || document.querySelector('form');
        if (!form) return 'no-form';

        var idInput = form.querySelector('input[type="text"], input[type="email"]');
        if (!idInput) {
          var candidates = form.querySelectorAll('input');
          for (var i = 0; i < candidates.length; i++) {
            var t = (candidates[i].type || 'text').toLowerCase();
            if (['password', 'hidden', 'submit', 'button', 'checkbox', 'radio'].indexOf(t) === -1) {
              idInput = candidates[i];
              break;
            }
          }
        }
        if (!idInput) return 'no-id-field';

        var nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputSetter.call(idInput, ${JSON.stringify(creds.loginId)});
        idInput.dispatchEvent(new Event('input', { bubbles: true }));
        idInput.dispatchEvent(new Event('change', { bubbles: true }));

        nativeInputSetter.call(pwInput, ${JSON.stringify(creds.password)});
        pwInput.dispatchEvent(new Event('input', { bubbles: true }));
        pwInput.dispatchEvent(new Event('change', { bubbles: true }));

        var submitBtn = form.querySelector('input[type="submit"], button[type="submit"]') ||
          Array.prototype.find.call(form.querySelectorAll('button'), function (b) { return true; });
        if (submitBtn) {
          submitBtn.click();
        } else {
          form.submit();
        }
        return 'submitted';
      } catch (e) {
        return 'error:' + e.message;
      }
    })();
  `;

  try {
    const result = await view.webContents.executeJavaScript(script);
    console.log('自動ログイン処理結果:', result);
  } catch (err) {
    console.error('自動ログインスクリプトの実行に失敗しました:', err);
  }
}

// ---------- 右クリックメニュー ----------

function truncateForLabel(text, max = 20) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

function sanitizeFileName(name) {
  return (name || 'page').replace(/[\\/:*?"<>|]/g, '_').trim() || 'page';
}

async function savePageAs(view) {
  if (!mainWindow) return;
  const wc = view.webContents;
  const defaultName = sanitizeFileName(wc.getTitle());
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '名前を付けて保存',
    defaultPath: defaultName + '.html',
    filters: [
      { name: 'ウェブページ (完全)', extensions: ['html', 'htm'] },
      { name: 'ウェブページ (MHTML、単一ファイル)', extensions: ['mhtml'] },
    ],
  });
  if (canceled || !filePath) return;
  const saveType = filePath.toLowerCase().endsWith('.mhtml') ? 'MHTML' : 'HTMLComplete';
  try {
    await wc.savePage(filePath, saveType);
  } catch (err) {
    console.error('ページの保存に失敗しました:', err);
    dialog.showErrorBox('保存エラー', 'ページの保存に失敗しました。');
  }
}

function buildContextMenu(view, params) {
  const wc = view.webContents;
  const menu = new Menu();
  const hasSelection = !!(params.selectionText && params.selectionText.trim().length > 0);

  if (hasSelection) {
    menu.append(new MenuItem({ label: 'コピー', click: () => wc.copy() }));
    if (params.isEditable && params.editFlags.canCut) {
      menu.append(new MenuItem({ label: '切り取り', click: () => wc.cut() }));
    }
    if (params.isEditable && params.editFlags.canPaste) {
      menu.append(new MenuItem({ label: '貼り付け', click: () => wc.paste() }));
    }
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({
      label: `「${truncateForLabel(params.selectionText)}」をGoogleで検索`,
      click: () => {
        const query = encodeURIComponent(params.selectionText.trim());
        shell.openExternal(`https://www.google.com/search?q=${query}`);
      },
    }));
    return menu;
  }

  if (params.isEditable) {
    menu.append(new MenuItem({
      label: '貼り付け',
      enabled: params.editFlags.canPaste,
      click: () => wc.paste(),
    }));
    return menu;
  }

  menu.append(new MenuItem({ label: '戻る', enabled: wc.canGoBack(), click: () => wc.goBack() }));
  menu.append(new MenuItem({ label: '進む', enabled: wc.canGoForward(), click: () => wc.goForward() }));
  menu.append(new MenuItem({ label: '再読み込み', click: () => wc.reload() }));
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: '名前を付けて保存...', click: () => savePageAs(view) }));
  return menu;
}

// ---------- アップデート確認（electron-updater） ----------

let updaterInitialized = false;

function setupAutoUpdater() {
  if (updaterInitialized) return;
  updaterInitialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'アップデートがあります',
        message: `新しいバージョン ${info.version} が利用可能です。ダウンロードしますか？`,
        buttons: ['ダウンロード', '後で'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.downloadUpdate();
      });
  });

  autoUpdater.on('update-downloaded', () => {
    if (!mainWindow) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'アップデートの準備ができました',
        message: 'ダウンロードが完了しました。今すぐ再起動してインストールしますか？',
        buttons: ['今すぐ再起動', '後で'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('アップデート確認中にエラーが発生しました:', err);
  });
}

function checkForUpdates(showResultDialog) {
  if (!app.isPackaged) {
    if (showResultDialog && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'アップデート確認',
        message: '開発モードのためアップデート確認はスキップされました（配布用にビルドしたアプリでのみ動作します）。',
      });
    }
    return;
  }

  setupAutoUpdater();

  if (showResultDialog) {
    const cleanup = () => {
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onNotAvailable = () => {
      cleanup();
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'アップデート確認',
          message: 'お使いのバージョンは最新です。',
        });
      }
    };
    const onAvailable = () => {
      cleanup(); // update-available用のダイアログはsetupAutoUpdater側で別途表示される
    };
    const onError = (err) => {
      cleanup();
      console.error('アップデート確認に失敗しました:', err);
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'アップデート確認でエラーが発生しました',
          message: (err && err.message) ? err.message : String(err),
        });
      }
    };
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('error', onError);
  }

  autoUpdater.checkForUpdates().catch((err) => {
    // 上のonErrorで既に表示されるため、ここではログのみ
    console.error('アップデート確認に失敗しました:', err);
  });
}

// ---------- メインウィンドウ ----------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    title: '福知山公立大学ポータルアプリ',
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'toolbar.html'));

  mainWindow.on('resize', updateViewBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs.clear();
    activeTabId = null;
    portalTabId = null;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    broadcastTabs();
    updateNavState();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isReloadShortcut =
      input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (isReloadShortcut) {
      event.preventDefault();
      const view = getActiveView();
      if (view) view.webContents.reload();
    }
  });

  portalTabId = createTab(PORTAL_URL, { title: 'ポータル', closable: false });
  setActiveTab(portalTabId);

  buildAppMenu();
  checkForUpdates(false);
}

// ---------- ツールバーからの操作 ----------

ipcMain.on('nav-back', () => {
  const view = getActiveView();
  if (view && view.webContents.canGoBack()) view.webContents.goBack();
});
ipcMain.on('nav-forward', () => {
  const view = getActiveView();
  if (view && view.webContents.canGoForward()) view.webContents.goForward();
});
ipcMain.on('nav-reload', () => {
  const view = getActiveView();
  if (view) view.webContents.reload();
});
ipcMain.on('nav-home', () => {
  const portalTab = tabs.get(portalTabId);
  if (!portalTab) return;
  setActiveTab(portalTabId);
  portalTab.view.webContents.loadURL(PORTAL_URL);
});
ipcMain.on('switch-tab', (event, id) => setActiveTab(id));
ipcMain.on('close-tab', (event, id) => closeTab(id));
ipcMain.on('open-history-window', () => createHistoryWindow());
ipcMain.on('tab-context-menu', (event, id) => {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return;
  const menu = Menu.buildFromTemplate([
    { label: '複製', click: () => duplicateTab(id) },
    { type: 'separator' },
    { label: '閉じる', enabled: tab.closable, click: () => closeTab(id) },
  ]);
  menu.popup({ window: mainWindow });
});
ipcMain.on('tab-context-menu', (event, id) => {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return;
  const menu = Menu.buildFromTemplate([
    { label: '複製', click: () => duplicateTab(id) },
    { type: 'separator' },
    { label: '閉じる', enabled: tab.closable, click: () => closeTab(id) },
  ]);
  menu.popup({ window: mainWindow });
});

ipcMain.on('open-settings', () => {
  if (!mainWindow) return;
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['キャンセル', 'アップデートを確認', 'ログイン情報を再設定', 'このアプリについて'],
    defaultId: 0,
    cancelId: 0,
    title: '設定',
    message: '操作を選んでください。',
  });
  if (result === 1) {
    checkForUpdates(true);
  } else if (result === 2) {
    clearCredentials();
    mainWindow.close();
    createCredentialsWindow();
  } else if (result === 3) {
    createAboutWindow();
  }
});

// ---------- アプリメニュー（ログイン情報の再設定） ----------

function buildAppMenu() {
  const template = [
    {
      label: 'アカウント',
      submenu: [
        {
          label: 'ログイン情報を再設定',
          click: () => {
            clearCredentials();
            if (mainWindow) {
              mainWindow.close();
            }
            createCredentialsWindow();
          },
        },
        { type: 'separator' },
        {
          label: '終了',
          role: 'quit',
        },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'forceReload', label: '強制再読み込み' },
        { role: 'toggleDevTools', label: 'デベロッパーツール' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン切替' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- アプリのライフサイクル ----------

app.whenReady().then(() => {
  history = loadHistory();
  const creds = loadCredentials();
  if (creds) {
    createMainWindow();
  } else {
    createCredentialsWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const c = loadCredentials();
      if (c) createMainWindow();
      else createCredentialsWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
