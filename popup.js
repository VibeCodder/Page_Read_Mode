const btn = document.getElementById("toggleBtn");
const btnLabel = document.getElementById("btnLabel");
const btnIcon = document.getElementById("btnIcon");
const errorMsg = document.getElementById("errorMsg");
const removeFootnotesToggle = document.getElementById("removeFootnotesToggle");

const ICON_ON = `<path d="M12 2v8"/><path d="M6.3 6.3a9 9 0 1 0 11.4 0"/>`;
const ICON_OFF = `<path d="M18 6 6 18"/><path d="M6 6l12 12"/>`;

let activeTabId = null;
let isActive = false;

function render() {
  btn.classList.toggle("is-on", isActive);
  btnLabel.textContent = isActive ? "Turn off" : "Turn on";
  btnIcon.innerHTML = isActive ? ICON_OFF : ICON_ON;
}

async function init() {
  const settingsPromise = chrome.storage.sync.get({ removeFootnotes: false }).then((settings) => {
    removeFootnotesToggle.checked = settings.removeFootnotes;
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    await settingsPromise;
    return;
  }
  activeTabId = tab.id;

  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    btn.disabled = true;
    errorMsg.textContent = "Can't run on this page.";
    errorMsg.style.display = "block";
    await settingsPromise;
    return;
  }

  const stored = await chrome.storage.session.get(`reader_${activeTabId}`);
  isActive = !!stored[`reader_${activeTabId}`];
  render();

  await settingsPromise;
}

removeFootnotesToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ removeFootnotes: removeFootnotesToggle.checked });
});

btn.addEventListener("click", async () => {
  if (activeTabId == null) return;
  errorMsg.style.display = "none";

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"]
    });
    isActive = !isActive;
    render();
  } catch (err) {
    console.error("Reader mode: injection failed", err);
    errorMsg.textContent = "Something went wrong. Try reloading the page.";
    errorMsg.style.display = "block";
  }
});

init();
