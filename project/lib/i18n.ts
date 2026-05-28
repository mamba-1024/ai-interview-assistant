/**
 * i18n 工具函数
 *
 * 封装 chrome.i18n.getMessage()，提供类型安全的国际化支持。
 * 自动检测浏览器语言，fallback 到英文。
 */

/** 获取国际化消息 */
export function t(key: string, ...substitutions: string[]): string {
  try {
    const msg = chrome.i18n.getMessage(key, substitutions);
    return msg || key;
  } catch {
    return key;
  }
}

/** 获取当前 UI 语言 (en / zh_CN) */
export function getUILanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return "en";
  }
}

/** 判断当前是否为中文环境 */
export function isChinese(): boolean {
  const lang = getUILanguage();
  return lang.startsWith("zh");
}
