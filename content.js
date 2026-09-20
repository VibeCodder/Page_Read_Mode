(async function () {
  const STATE_KEY = "__readerModeState__";

  function restoreOriginal() {
    const state = window[STATE_KEY];
    if (!state) return;
    document.documentElement.innerHTML = state.originalHTML;
    document.title = state.originalTitle;
    window[STATE_KEY] = { active: false };
    notifyState(false);
  }

  async function activateReaderMode() {
    const originalHTML = document.documentElement.innerHTML;
    const originalTitle = document.title;

    let settings = { removeFootnotes: false };
    try {
      settings = await chrome.storage.sync.get({ removeFootnotes: false });
    } catch (err) {
      // storage unavailable for some reason; fall back to defaults
    }

    const { title, content } = extractReadableContent(settings);

    const readerHTML = buildReaderHTML(title, content);

    document.documentElement.innerHTML = readerHTML;
    document.title = title || originalTitle;

    window[STATE_KEY] = {
      active: true,
      originalHTML,
      originalTitle
    };
    notifyState(true);

    const closeBtn = document.getElementById("__reader_close_btn__");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        restoreOriginal();
      });
    }
  }

  function notifyState(active) {
    try {
      chrome.runtime.sendMessage({ type: "READER_STATE", active });
    } catch (err) {
      // Extension context may be gone (e.g. page navigating away); ignore.
    }
  }

  // Tags whose direct text content should never be treated as boilerplate junk.
  const JUNK_SELECTORS = [
    "script", "style", "noscript", "iframe", "svg", "canvas",
    "form", "input", "button", "select", "textarea",
    "nav", "header", "footer", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
    "video", "audio", "picture", "img", "figure",
    ".ad", ".ads", ".advert", ".advertisement", ".banner",
    ".cookie", ".cookies", ".newsletter", ".popup", ".modal",
    ".share", ".social", ".comments", ".comment", ".related",
    ".sidebar", ".menu", ".breadcrumbs", ".pagination", ".tags",
    // Image galleries: captions get concatenated without separators once
    // detached from the live DOM, and a gallery is visual content anyway.
    ".wikia-gallery", "[class*='gallery']",
    // Accessibility "skip to content" / screen-reader-only links: useful
    // for a11y but meaningless once flattened into plain reading text.
    ".skip-link", ".skip-to-content", ".mw-jump-link", "#jump-to-content",
    ".sr-only", ".visually-hidden", ".visuallyhidden", ".screen-reader-text",
    "a[href='#content']", "a[href='#main']", "a[href='#main-content']", "a[href='#mw-head']"
  ];

  function extractReadableContent(settings) {
    const bodyClone = document.body.cloneNode(true);

    // Remove obvious junk / boilerplate
    JUNK_SELECTORS.forEach((sel) => {
      bodyClone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Remove elements whose id/class strongly suggest boilerplate, by regex
    const junkPattern = /(nav|menu|sidebar|footer|header|comment|social|share|banner|ad-|-ad|advert|cookie|popup|modal|newsletter|related|widget|breadcrumb|gallery)/i;
    bodyClone.querySelectorAll("*").forEach((el) => {
      const idClass = (el.id || "") + " " + (el.className && el.className.toString ? el.className.toString() : "");
      if (junkPattern.test(idClass)) {
        el.remove();
      }
    });

    // Remove bracketed link clusters like Wikipedia's "[edit | edit source]"
    // section links: any element whose whole text is wrapped in [...] and
    // contains a link. Checked innermost-first so we don't nuke a large
    // ancestor before finding the actual small bracket element inside it.
    Array.from(bodyClone.querySelectorAll("*")).forEach((el) => {
      if (!bodyClone.contains(el)) return; // already removed as part of a bigger match
      const text = (el.textContent || "").trim();
      if (!/^\[.*\]$/.test(text) || !el.querySelector("a")) return;
      const inner = text.slice(1, -1).replace(/[\d\s.,]/g, "");
      if (inner.length === 0 && !settings.removeFootnotes) return; // pure numeric footnote marker like "[5]", keep unless the user opted in to stripping it
      el.remove();
    });

    // Optionally also strip bare (non-bracketed) numeric footnote links,
    // e.g. a superscript "9" that links to a citation, since these use the
    // same pattern as "[9]" just without the brackets.
    if (settings.removeFootnotes) {
      Array.from(bodyClone.querySelectorAll("a")).forEach((a) => {
        if (!bodyClone.contains(a)) return;
        const text = (a.textContent || "").trim();
        if (!/^\d{1,4}$/.test(text)) return;
        // Remove the smallest sensible wrapper (e.g. <sup>) rather than
        // just the link, so no empty brackets/punctuation are left behind.
        const wrapper = a.closest("sup, sub") || a;
        if (bodyClone.contains(wrapper)) wrapper.remove();
      });
    }

    // Candidate containers: article, main, or divs/sections with substantial text
    let candidates = Array.from(bodyClone.querySelectorAll("article, main, section, div"));
    if (candidates.length === 0) candidates = [bodyClone];

    let best = bodyClone;
    let bestScore = -Infinity;

    candidates.forEach((el) => {
      const score = scoreElement(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });

    const title = cleanTitle(document.title);
    const content = buildContentBlocks(best);

    return { title, content };
  }

  // Trims common "Article Name | Site Name" / "Article Name - Site Name"
  // suffixes so the reader title isn't cluttered with the site's branding.
  function cleanTitle(rawTitle) {
    const title = (rawTitle || "").trim();
    const parts = title.split(/\s+[|\-–—]\s+/);
    if (parts.length > 1 && parts[0].trim().length >= 4) {
      return parts[0].trim();
    }
    return title;
  }

  function scoreElement(el) {
    const text = el.innerText || el.textContent || "";
    const textLength = text.trim().length;
    if (textLength < 40) return -Infinity;

    const paragraphCount = el.querySelectorAll("p").length;
    const linkText = Array.from(el.querySelectorAll("a"))
      .reduce((sum, a) => sum + (a.innerText || "").length, 0);
    const linkDensity = textLength > 0 ? linkText / textLength : 0;

    let score = textLength * 0.7 + paragraphCount * 25;
    score -= linkDensity * textLength * 0.9; // penalize link-heavy blocks (menus, related lists)
    return score;
  }

  const ALLOWED_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "STRONG", "EM", "B", "I"
  ]);

  // Common accessibility/navigation boilerplate phrases that sometimes have
  // no distinguishing class name, so they're filtered by text as a fallback.
  const BOILERPLATE_TEXT = /^(skip to (main )?content|skip navigation|jump to (content|navigation)|back to top)$/i;

  function buildContentBlocks(container) {
    const blocks = [];
    const seenText = new Set();

    function walk(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;

      if (ALLOWED_TAGS.has(tag) && ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"].includes(tag)) {
        const text = (node.innerText || node.textContent || "").trim();
        if (text.length > 1 && !seenText.has(text) && !BOILERPLATE_TEXT.test(text)) {
          seenText.add(text);
          blocks.push({ tag, text: escapeHTML(text) });
        }
        return; // don't descend further into a captured block
      }

      if (tag === "UL" || tag === "OL") {
        const items = Array.from(node.children)
          .filter((c) => c.tagName === "LI")
          .map((li) => (li.innerText || li.textContent || "").trim())
          .filter((t) => t.length > 0);
        if (items.length > 0) {
          const key = items.join("|");
          if (!seenText.has(key)) {
            seenText.add(key);
            blocks.push({ tag, items: items.map(escapeHTML) });
          }
          return;
        }
      }

      // This node isn't itself a recognized block. If none of its
      // descendants are either (e.g. text sitting only inside inline
      // wrappers like <span>/<i>/<dd>, as in custom "quote" widgets),
      // recursing further would silently lose that text. Capture it here
      // as a plain paragraph instead of dropping it.
      const hasBlockDescendant = node.querySelector(
        "p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre"
      );
      if (!hasBlockDescendant) {
        const text = (node.innerText || node.textContent || "").trim();
        if (text.length > 1 && !seenText.has(text) && !BOILERPLATE_TEXT.test(text)) {
          seenText.add(text);
          blocks.push({ tag: "P", text: escapeHTML(text) });
        }
        return;
      }

      // Recurse into children for containers that aren't directly a text block
      Array.from(node.children).forEach(walk);
    }

    walk(container);

    // Fallback: if nothing structured was found, just dump plain text split by lines
    if (blocks.length === 0) {
      const rawText = (container.innerText || container.textContent || "").trim();
      rawText.split(/\n{2,}/).forEach((chunk) => {
        const t = chunk.trim();
        if (t.length > 0) blocks.push({ tag: "P", text: escapeHTML(t) });
      });
    }

    return blocks;
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderBlock(block) {
    if (block.tag === "UL" || block.tag === "OL") {
      const items = block.items.map((i) => `<li>${i}</li>`).join("");
      return `<${block.tag.toLowerCase()}>${items}</${block.tag.toLowerCase()}>`;
    }
    return `<${block.tag.toLowerCase()}>${block.text}</${block.tag.toLowerCase()}>`;
  }

  function buildReaderHTML(title, blocks) {
    const bodyContent = blocks.map(renderBlock).join("\n");
    const wordCount = blocks
      .map((b) => (b.text || (b.items ? b.items.join(" ") : "")))
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length;
    const readingMinutes = Math.max(1, Math.round(wordCount / 200));

    return `
<head>
<meta charset="UTF-8">
<title>${escapeHTML(title)}</title>
<style>
  :root {
    color-scheme: light dark;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: #fbfaf7;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #2a2a28;
    line-height: 1.7;
    font-size: 19px;
  }
  .__reader_wrapper__ {
    max-width: 700px;
    margin: 0 auto;
    padding: 56px 24px 96px;
  }
  .__reader_meta__ {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #8a8a86;
    font-size: 14px;
    margin-bottom: 8px;
    letter-spacing: 0.02em;
  }
  h1 {
    font-size: 34px;
    line-height: 1.25;
    margin: 4px 0 24px;
  }
  h2 { font-size: 26px; margin-top: 40px; }
  h3 { font-size: 21px; margin-top: 32px; }
  p, li, blockquote { margin: 0 0 20px; }
  blockquote {
    border-left: 3px solid #d8d5cc;
    padding-left: 18px;
    color: #55534c;
    font-style: italic;
  }
  ul, ol { padding-left: 28px; }
  pre {
    background: #f0efe9;
    padding: 14px;
    overflow-x: auto;
    font-family: Consolas, Menlo, monospace;
    font-size: 15px;
  }
  #__reader_close_btn__ {
    position: fixed;
    top: 18px;
    right: 18px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    background: #2a2a28;
    color: #fbfaf7;
    border: none;
    border-radius: 20px;
    padding: 9px 16px;
    cursor: pointer;
    opacity: 0.85;
  }
  #__reader_close_btn__:hover { opacity: 1; }

  @media (prefers-color-scheme: dark) {
    html, body { background: #1b1b19; }
    body { color: #e7e5dd; }
    .__reader_meta__ { color: #8f8d85; }
    blockquote { border-left-color: #3a3a36; color: #b0aea5; }
    pre { background: #262622; color: #e7e5dd; }
    #__reader_close_btn__ { background: #e7e5dd; color: #1b1b19; }
  }
</style>
</head>
<body>
  <button id="__reader_close_btn__" title="Turn off reader mode">Original view</button>
  <div class="__reader_wrapper__">
    <div class="__reader_meta__">Reader mode · ${wordCount} words · ~${readingMinutes} min read</div>
    <h1>${escapeHTML(title)}</h1>
    ${bodyContent}
  </div>
</body>
`;
  }

  // ---- Entry point: run after all functions/consts above are defined ----
  if (window[STATE_KEY] && window[STATE_KEY].active) {
    restoreOriginal();
  } else {
    await activateReaderMode();
  }
})();
