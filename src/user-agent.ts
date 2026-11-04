// Minimal user-agent summarizer for the session list: browser + version,
// OS, and a coarse device class. Deliberately small and dependency-free;
// unknown parts come back null and the UI simply omits them.

export interface ClientInfo {
  browser: string | null;
  os: string | null;
  device: string | null;
}

const WINDOWS_NAMES: Record<string, string> = {
  "10.0": "Windows 10/11",
  "6.3": "Windows 8.1",
  "6.2": "Windows 8",
  "6.1": "Windows 7",
};

export function parseUserAgent(ua: string | null | undefined): ClientInfo {
  const s = (ua ?? "").trim();
  if (!s) return { browser: null, os: null, device: null };

  let device: string;
  if (/iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) {
    device = "平板";
  } else if (/iPhone|iPod|Mobile|Windows Phone/i.test(s)) {
    device = "手机";
  } else {
    device = "桌面设备";
  }

  let os: string | null = null;
  let match: RegExpExecArray | null;
  if ((match = /Windows NT ([\d.]+)/.exec(s))) {
    os = WINDOWS_NAMES[match[1]] ?? "Windows";
  } else if (/iPhone|iPad|iPod/.test(s) && (match = /OS (\d+)[_.]/.exec(s))) {
    os = `iOS ${match[1]}`;
  } else if ((match = /Android (\d+)/.exec(s))) {
    os = `Android ${match[1]}`;
  } else if ((match = /Mac OS X (\d+)[_.](\d+)/.exec(s))) {
    os = `macOS ${match[1]}.${match[2]}`;
  } else if (/Linux/.test(s)) {
    os = "Linux";
  }

  let browser: string | null = null;
  if ((match = /Edg\/(\d+)/.exec(s))) {
    browser = `Edge ${match[1]}`;
  } else if ((match = /OPR\/(\d+)/.exec(s))) {
    browser = `Opera ${match[1]}`;
  } else if ((match = /SamsungBrowser\/(\d+)/.exec(s))) {
    browser = `Samsung Internet ${match[1]}`;
  } else if ((match = /CriOS\/(\d+)/.exec(s)) || (match = /Chrome\/(\d+)/.exec(s))) {
    browser = `Chrome ${match[1]}`;
  } else if ((match = /FxiOS\/(\d+)/.exec(s)) || (match = /Firefox\/(\d+)/.exec(s))) {
    browser = `Firefox ${match[1]}`;
  } else if (/Safari\//.test(s) && (match = /Version\/(\d+)/.exec(s))) {
    browser = `Safari ${match[1]}`;
  }

  return { browser, os, device };
}
