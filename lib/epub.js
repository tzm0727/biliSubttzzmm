// EPUB 生成器：将 Markdown 文本转换为带目录的 EPUB（zip 结构）
// 参考 EPUB 3 规范：mimetype + container.xml + content.opf + nav/toc + XHTML 章节
const zlib = require("zlib");

// ---------------- CRC32 ----------------
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

// ---------------- ZIP ----------------
function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = f.compress ? zlib.deflateRawSync(f.data) : f.data;
    const crc = crc32(f.data);
    const method = f.compress ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);
    ce.writeUInt16LE(20, 4);
    ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0, 8);
    ce.writeUInt16LE(method, 10);
    ce.writeUInt16LE(0, 12);
    ce.writeUInt16LE(0, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(data.length, 20);
    ce.writeUInt32LE(f.data.length, 24);
    ce.writeUInt16LE(nameBuf.length, 28);
    ce.writeUInt16LE(0, 30);
    ce.writeUInt16LE(0, 32);
    ce.writeUInt16LE(0, 34);
    ce.writeUInt16LE(0, 36);
    ce.writeUInt32LE(0, 38);
    ce.writeUInt32LE(offset, 42);
    central.push(ce, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, eocd]);
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------- Markdown 简单转 XHTML ----------------
function inlineMd(s) {
  return String(s || "")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
}

function blockToHtml(md) {
  const lines = String(md || "").split(/\r?\n/);
  const out = [];
  let listBuf = null;
  const flushList = () => {
    if (listBuf) {
      out.push("<ul>" + listBuf.map((l) => "<li>" + inlineMd(l) + "</li>").join("") + "</ul>");
      listBuf = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (/^###\s/.test(line)) {
      flushList();
      out.push("<h3>" + inlineMd(line.replace(/^###\s+/, "")) + "</h3>");
    } else if (/^##\s/.test(line)) {
      flushList();
      out.push("<h2>" + inlineMd(line.replace(/^##\s+/, "")) + "</h2>");
    } else if (/^#\s/.test(line)) {
      flushList();
      out.push("<h1>" + inlineMd(line.replace(/^#\s+/, "")) + "</h1>");
    } else if (/^[-*]\s/.test(line)) {
      if (!listBuf) listBuf = [];
      listBuf.push(line.replace(/^[-*]\s+/, ""));
    } else if (/^>\s?/.test(line)) {
      flushList();
      out.push("<blockquote>" + inlineMd(line.replace(/^>\s?/, "")) + "</blockquote>");
    } else if (/^---+$/.test(line)) {
      flushList();
      out.push("<hr/>");
    } else {
      flushList();
      out.push("<p>" + inlineMd(line) + "</p>");
    }
  }
  flushList();
  return out.join("\n");
}

// 按标题分章，返回 [{title, html}]
function markdownToChapters(md) {
  const lines = String(md || "").split(/\r?\n/);
  const chapters = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s/.test(line) || /^#\s/.test(line)) {
      if (current) chapters.push(current);
      current = { title: line.replace(/^#+\s+/, "").trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) chapters.push(current);
  if (!chapters.length) {
    chapters.push({ title: "正文", lines: lines });
  }
  return chapters.map((c) => ({ title: c.title || "正文", html: blockToHtml(c.lines.join("\n")) }));
}

// ---------------- EPUB 组装 ----------------
function buildEpub(opts) {
  const title = String(opts.title || "未命名").trim();
  const md = String(opts.content || "");
  const chapters = markdownToChapters(md);

  const idBase = "bilisub";
  const chapterFiles = chapters.map((c, i) => ({
    id: "ch" + (i + 1),
    name: "OEBPS/chapter" + (i + 1) + ".xhtml",
    title: c.title,
  }));

  // 章节 XHTML
  const files = [];
  files.push({
    name: "mimetype",
    data: Buffer.from("application/epub+zip", "utf8"),
    compress: false,
  });

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  files.push({ name: "META-INF/container.xml", data: Buffer.from(containerXml, "utf8"), compress: true });

  // 章节内容
  chapterFiles.forEach((cf, i) => {
    const ch = chapters[i];
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>${escapeXml(ch.title)}</title></head>
<body>
<h1>${escapeXml(ch.title)}</h1>
${ch.html}
</body>
</html>`;
    files.push({ name: cf.name, data: Buffer.from(xhtml, "utf8"), compress: true });
  });

  // content.opf
  const manifestItems = chapterFiles
    .map((cf) => `<item id="${cf.id}" href="${cf.name.split("/").pop()}" media-type="application/xhtml+xml"/>`)
    .join("\n    ");
  const spineItems = chapterFiles.map((cf) => `<itemref idref="${cf.id}"/>`).join("\n    ");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${idBase}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;
  files.push({ name: "OEBPS/content.opf", data: Buffer.from(opf, "utf8"), compress: true });

  // nav.xhtml（目录）
  const navItems = chapterFiles
    .map((cf) => `<li><a href="${cf.name.split("/").pop()}">${escapeXml(cf.title)}</a></li>`)
    .join("\n      ");
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
    ${navItems}
  </ol>
</nav>
</body>
</html>`;
  files.push({ name: "OEBPS/nav.xhtml", data: Buffer.from(nav, "utf8"), compress: true });

  // toc.ncx（兼容 EPUB2 阅读器）
  const navPoints = chapterFiles
    .map((cf, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(cf.title)}</text></navLabel><content src="${cf.name.split("/").pop()}"/></navPoint>`)
    .join("\n    ");
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${idBase}"/></head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;
  files.push({ name: "OEBPS/toc.ncx", data: Buffer.from(ncx, "utf8"), compress: true });

  return buildZip(files);
}

module.exports = { buildEpub };
