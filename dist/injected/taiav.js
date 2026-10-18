"use strict";
(() => {
  // src/bridges/taiav.ts
  var thumbnail;
  for (const script of document.querySelectorAll("head script[type='application/ld+json']")) {
    const match = script.textContent?.match(/["']thumbnail(?:url|_url)["']\s*:\s*["']([^"'\\\n\r]+)["']/i);
    if (match?.[1]) thumbnail = match[1];
  }
  if (thumbnail) {
    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:image");
    meta.setAttribute("content", thumbnail);
    document.head.appendChild(meta);
  }
})();
