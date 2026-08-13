// B 站 Cookie 罐（内存）：解析、合并、匹配、序列化
const jar = new Map();

function parseSetCookie(str) {
  const parts = String(str || "").split(";");
  const first = (parts.shift() || "").trim();
  const eq = first.indexOf("=");
  const name = eq > 0 ? first.slice(0, eq).trim() : "";
  const value = eq >= 0 ? first.slice(eq + 1).trim() : "";
  let domain = "";
  let pathValue = "/";
  let expires = null;
  let secure = false;
  for (const p of parts) {
    const seg = p.trim();
    const idx = seg.indexOf("=");
    const key = (idx >= 0 ? seg.slice(0, idx) : seg).trim().toLowerCase();
    const val = idx >= 0 ? seg.slice(idx + 1).trim() : "";
    if (key === "domain") domain = val;
    else if (key === "path") pathValue = val || "/";
    else if (key === "expires") expires = Date.parse(val);
    else if (key === "max-age") expires = Date.now() + Number(val) * 1000;
    else if (key === "secure") secure = true;
  }
  return { name, value, domain, path: pathValue, expires, secure };
}

function mergeSetCookies(requestUrl, setCookieList) {
  const host = new URL(requestUrl).hostname;
  for (const raw of setCookieList || []) {
    const c = parseSetCookie(raw);
    if (!c.name) continue;
    if (!c.domain) c.domain = host;
    if (c.expires && c.expires <= Date.now()) {
      jar.delete(`${c.domain}|${c.path}|${c.name}`);
      continue;
    }
    jar.set(`${c.domain}|${c.path}|${c.name}`, c);
  }
}

function domainMatches(domain, host) {
  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  return host === d || host.endsWith("." + d);
}

function buildCookieHeader(requestUrl) {
  const u = new URL(requestUrl);
  const host = u.hostname;
  const pathName = u.pathname || "/";
  const parts = [];
  for (const c of jar.values()) {
    if (!domainMatches(c.domain, host)) continue;
    if (!pathName.startsWith(c.path)) continue;
    if (c.secure && u.protocol !== "https:") continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

function cookiesArray() {
  return Array.from(jar.values()).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    secure: c.secure,
  }));
}

function setCookiesArray(arr) {
  jar.clear();
  for (const c of Array.isArray(arr) ? arr : []) {
    if (c && c.name) {
      jar.set(
        `${c.domain || ""}|${c.path || "/"}|${c.name}`,
        {
          name: c.name,
          value: c.value || "",
          domain: c.domain || "",
          path: c.path || "/",
          expires: c.expires || null,
          secure: !!c.secure,
        }
      );
    }
  }
}

module.exports = {
  jar,
  mergeSetCookies,
  buildCookieHeader,
  cookiesArray,
  setCookiesArray,
};
