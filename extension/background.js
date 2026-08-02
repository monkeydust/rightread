/*
 * rightread browser extension — MV3 service worker.
 *
 * Three ways to save, all funnelling into save():
 *   - toolbar button        → current tab
 *   - Ctrl+Shift+S          → current tab
 *   - right-click a link    → that link
 *
 * Config (server URL + capture token) lives in chrome.storage.sync, set on the
 * options page. Works unchanged in Edge and Chrome.
 */

const CONTEXT_MENU_ID = "rightread-save-link";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Save to rightread",
    contexts: ["link", "page"],
  });
});

async function getConfig() {
  const { serverUrl, token } = await chrome.storage.sync.get([
    "serverUrl",
    "token",
  ]);
  return { serverUrl: (serverUrl || "").replace(/\/+$/, ""), token: token || "" };
}

/** Transient feedback on the toolbar icon — cheaper than a notification. */
async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message,
  });
}

async function save(url) {
  const { serverUrl, token } = await getConfig();

  if (!serverUrl || !token) {
    notify("rightread not set up", "Open the extension options and add your server address and capture token.");
    chrome.runtime.openOptionsPage();
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    await flashBadge("—", "#8a8a8a");
    notify("Can't save this page", "Only http and https pages can be saved.");
    return;
  }

  try {
    const res = await fetch(`${serverUrl}/api/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url }),
    });

    if (res.status === 401) {
      await flashBadge("!", "#d93025");
      notify("rightread rejected the token", "Create a new capture token in Settings and update the options page.");
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await flashBadge("!", "#d93025");
      notify("Couldn't save", data.error || `Server returned ${res.status}`);
      return;
    }

    const data = await res.json();
    await flashBadge(data.alreadySaved ? "•" : "✓", "#1a7f37");
  } catch (err) {
    await flashBadge("!", "#d93025");
    notify("Couldn't reach rightread", String(err.message || err));
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.url) void save(tab.url);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "save-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) void save(tab.url);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (url) void save(url);
});
