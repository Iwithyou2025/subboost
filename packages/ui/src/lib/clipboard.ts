function copyTextWithExecCommand(text: string): boolean {
  const document = globalThis.document;
  if (!document?.body || typeof document.execCommand !== "function") {
    return false;
  }

  let textarea: HTMLTextAreaElement | null = null;

  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");

    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";

    document.body.appendChild(textarea);

    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}

export async function copyTextToClipboard(
    text: string
): Promise<boolean> {
  // HTTP 局域网地址不是 secure context，
  // 直接使用同步 fallback，避免先调用 Clipboard API 后丢失用户点击权限。
  if (globalThis.isSecureContext === false) {
    return copyTextWithExecCommand(text);
  }

  try {
    const clipboard = globalThis.navigator?.clipboard;

    if (typeof clipboard?.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API 被浏览器拒绝时继续 fallback
  }

  return copyTextWithExecCommand(text);
}