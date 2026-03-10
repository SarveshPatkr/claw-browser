function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") {
    return;
  }
  
  // Ignore if it's already in a window by itself or pinned
  if (tab.windowId === chrome.windows.WINDOW_ID_NONE || tab.pinned) {
    return;
  }

  await delay(150); // Slight delay to let the tab settle

  try {
    const allInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    if (allInWindow.length <= 1) {
      return;
    }

    const current = await chrome.tabs.get(tab.id);
    if (!current || current.pinned) {
      return;
    }

    // Create a new window of type 'popup' for the tab. 
    // 'popup' windows do not have the address bar or tab strip.
    await chrome.windows.create({ 
      tabId: tab.id, 
      focused: true,
      type: "popup",
      state: "maximized"
    });
  } catch (e) {
    console.error("Tab to Window Error:", e);
  }
});
