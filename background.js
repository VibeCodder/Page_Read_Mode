// Injects the reader-mode content script on the active tab.
// (Icon clicks are handled by popup.js — the action has a default_popup,
// so chrome.action.onClicked never fires. This listener only covers the
// keyboard shortcut, which bypasses the popup.)

async function toggleReaderOnTab(tab) {
  if (!tab || !tab.id) return;
  // Don't try to run on chrome:// or extension pages etc.
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (err) {
    console.error("Reader mode: injection failed", err);
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-reader") {
    toggleReaderOnTab(tab);
  }
});

// ---- Track per-tab reader state, so the popup can show Turn on/Turn off ----

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "READER_STATE" && sender.tab && sender.tab.id != null) {
    chrome.storage.session.set({ [`reader_${sender.tab.id}`]: !!message.active });
  }
});

// Reader mode always resets on reload/navigation (it's rebuilt from the live
// DOM), so drop any stale "on" state as soon as the tab starts loading again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.storage.session.remove(`reader_${tabId}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`reader_${tabId}`);
});
