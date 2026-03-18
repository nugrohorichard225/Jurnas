const express = require("express");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const zlib = require("zlib");

// ============================================================
// GLOBAL ERROR HANDLING - Mencegah server crash
// ============================================================
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});

const app = express();

// ============================================================
// KONFIGURASI - Sesuaikan dengan kebutuhan Anda
// ============================================================
const CONFIG = {
  // Domain asli yang akan di-mirror
  SOURCE_DOMAIN: "jurnas.com",
  SOURCE_ORIGIN: "https://jurnas.com",

  // Domain mirror Anda (diisi otomatis dari request, atau hardcode di sini)
  // Kosongkan "" jika ingin otomatis detect dari request Host header
  MIRROR_DOMAIN: process.env.MIRROR_DOMAIN || "",

  // Port server
  PORT: process.env.PORT || 3000,

  // User agent untuk request ke source
  USER_AGENT:
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

// ============================================================
// MIDDLEWARE: Trust proxy (untuk Railway/Render di balik LB)
// ============================================================
app.set("trust proxy", true);

// ============================================================
// MIDDLEWARE: Health check
// ============================================================
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", mirror: CONFIG.SOURCE_DOMAIN });
});

// ============================================================
// MIDDLEWARE: Serve local logo.svg
// ============================================================
const path = require("path");
app.get("/logo.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.svg"));
});
app.get("/favicon.png", (req, res) => {
  res.sendFile(path.join(__dirname, "favicon.png"));
});
app.get("/favicon.ico", (req, res) => {
  res.type("image/png").sendFile(path.join(__dirname, "favicon.png"));
});
app.get("/googlec813ffdaf2222472.html", (req, res) => {
  res.sendFile(path.join(__dirname, "googlec813ffdaf2222472.html"));
});

// ============================================================
// MIDDLEWARE: Mobile device detection & redirect to /mobile/
// ============================================================
app.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  const accept = req.headers['accept'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua);
  const isPageRequest = accept.includes('text/html');
  const path = req.path;

  // Redirect mobile browsers to /mobile/ version (HTML pages only)
  if (isMobile && isPageRequest && !path.startsWith('/mobile') && !path.startsWith('/images') && !path.startsWith('/assets') && path !== '/health') {
    return res.redirect(302, '/mobile' + path);
  }

  next();
});

// ============================================================
// FUNGSI UTAMA: Rewrite semua URL di HTML content
// ============================================================
function rewriteHtml(html, mirrorDomain, mirrorProtocol) {
  const sourceDomain = CONFIG.SOURCE_DOMAIN;
  const mirrorOrigin = `${mirrorProtocol}//${mirrorDomain}`;

  let modified = html;

  // 1. Rewrite absolute URLs to RELATIVE paths
  //    https://jurnas.com/path -> /path  |  https://www.jurnas.com/path -> /path
  //    This ensures resources load from the same origin the page was served from
  modified = modified.replace(
    new RegExp(`https?://(www\\.)?${escapeRegex(sourceDomain)}/`, "gi"),
    "/"
  );
  // Handle bare domain without trailing slash (e.g. href="https://jurnas.com")
  modified = modified.replace(
    new RegExp(`https?://(www\\.)?${escapeRegex(sourceDomain)}(?=["'\`\s>])`, "gi"),
    "/"
  );

  // 2. Rewrite protocol-relative URLs (//jurnas.com/path -> /path)
  modified = modified.replace(
    new RegExp(`//(www\\.)?${escapeRegex(sourceDomain)}/`, "gi"),
    "/"
  );
  modified = modified.replace(
    new RegExp(`//(www\\.)?${escapeRegex(sourceDomain)}(?=["'\`\s>])`, "gi"),
    "/"
  );

  // 3. Fix canonical tag - use absolute mirror URL for canonical
  modified = fixCanonicalTag(modified, mirrorOrigin);

  // 3b. Hapus Google AdSense & iklan-iklan
  modified = removeAds(modified);

  // 4. Fix/Add meta robots - pastikan halaman bisa di-index
  modified = fixMetaRobots(modified);

  // 5. Remove/rewrite any base tag that points to source
  modified = modified.replace(
    new RegExp(
      `<base\\s+href=["']https?://(www\\.)?${escapeRegex(sourceDomain)}[^"']*["']`,
      "gi"
    ),
    `<base href="/"`
  );

  // 6. Rewrite inline JSON-LD structured data (keep absolute for SEO)
  modified = rewriteJsonLd(modified, sourceDomain, mirrorDomain);

  // 7. Rewrite srcset attributes to relative
  modified = modified.replace(
    new RegExp(
      `https?://(www\\.)?${escapeRegex(sourceDomain)}/`,
      "gi"
    ),
    "/"
  );

  // 8. Rebrand: jurnas.com -> jurnas.news
  modified = rebrandSite(modified);

  // 9. Inject modern UI CSS override
  modified = injectModernUI(modified);

  // 10. Clean up footer spam links
  modified = cleanFooter(modified);

  // 11. Inject viewport meta for responsive mobile
  if (!/name=["']viewport["']/i.test(modified)) {
    const vpIdx = modified.lastIndexOf('</head>');
    if (vpIdx !== -1) {
      modified = modified.slice(0, vpIdx) +
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        modified.slice(vpIdx);
    }
  }

  return modified;
}

// ============================================================
// HELPER: Remove ads (AdSense, GPT, third-party ad scripts)
// ============================================================
function removeAds(html) {
  let modified = html;

  // Hapus Google AdSense script tags
  modified = modified.replace(/<script[^>]*src=["'][^"']*googlesyndication\.com[^"']*["'][^>]*>\s*<\/script>/gi, '');
  modified = modified.replace(/<script[^>]*src=["'][^"']*googleadservices\.com[^"']*["'][^>]*>\s*<\/script>/gi, '');
  modified = modified.replace(/<script[^>]*src=["'][^"']*securepubads\.g\.doubleclick\.net[^"']*["'][^>]*>\s*<\/script>/gi, '');
  modified = modified.replace(/<script[^>]*src=["'][^"']*googletagmanager\.com[^"']*["'][^>]*>\s*<\/script>/gi, '');
  modified = modified.replace(/<script[^>]*src=["'][^"']*anymind360\.com[^"']*["'][^>]*>\s*<\/script>/gi, '');

  // Hapus inline ad scripts (googletag, adsbygoogle, GPT)
  // Use a safe approach: find each <script>...</script> block individually,
  // then check if it contains ad-related code
  modified = modified.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, content) => {
    // Remove scripts that contain ad-related code
    if (/googletag\s*\.|adsbygoogle|gpt\.js|defineSlot|enableServices/.test(content)) {
      return '';
    }
    return match;
  });

  // Hapus ad div containers (div-gpt-ad-*)
  modified = modified.replace(/<div[^>]*id=["']div-gpt-ad-[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

  // Hapus ins.adsbygoogle elements
  modified = modified.replace(/<ins\s+class=["']adsbygoogle["'][\s\S]*?<\/ins>/gi, '');

  return modified;
}

// ============================================================
// HELPER: Rebrand site title & references
// ============================================================
function rebrandSite(html) {
  let modified = html;

  // Title tag
  modified = modified.replace(/<title>[^<]*<\/title>/i, '<title>jurnas.news - Berita Terkini</title>');

  // Meta description
  modified = modified.replace(
    /(<meta\s+name=["']description["']\s+content=["'])[^"']*["']/i,
    '$1Berita Terkini | Jujur dan Bernas | jurnas.news"'
  );

  // Text content "jurnas.com" -> "jurnas.news" (case insensitive)
  modified = modified.replace(/jurnas\.com/gi, 'jurnas.news');

  // Search placeholder
  modified = modified.replace(/Search Jurnas\.news/gi, 'Cari berita...');

  // Replace old logo image with logo.svg (desktop & mobile versions)
  modified = modified.replace(/<a\s+href=["'][^"']*["']\s*>\s*<img\s+src=["'][^"']*conf-[Jj]urnas[^"']*["'][^>]*>\s*<\/a>/gi,
    '<a href="/"><img src="/logo.svg" alt="jurnas.news" style="height:42px;width:auto;display:block"></a>');

  // Replace favicon
  modified = modified.replace(/<link\s+rel=["'](?:shortcut icon|icon)["'][^>]*>/gi,
    '');
  const faviconTags = '  <link rel="icon" type="image/png" href="/favicon.png">\n  <link rel="shortcut icon" type="image/png" href="/favicon.png">\n';
  const headIdx = modified.lastIndexOf('</head>');
  if (headIdx !== -1) {
    modified = modified.slice(0, headIdx) + faviconTags + modified.slice(headIdx);
  }

  return modified;
}

// ============================================================
// HELPER: Clean up footer spam & hidden links
// ============================================================
function cleanFooter(html) {
  let modified = html;

  // Remove hidden spam links (display:none)
  modified = modified.replace(/<a\s+style=["']display:\s*none;?["'][^>]*>[\s\S]*?<\/a>/gi, '');

  // Remove Google Analytics inline scripts (safe per-block approach)
  modified = modified.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, content) => {
    if (/GoogleAnalyticsObject|google-analytics\.com|ga\s*\(\s*['"]create['"]/.test(content)) {
      return '';
    }
    return match;
  });

  return modified;
}

// ============================================================
// HELPER: Inject modern UI CSS & HTML overrides
// ============================================================
function injectModernUI(html) {
  const modernCSS = `
<style id="jurnas-modern-ui">
/* ========== RESET & BASE ========== */
* { box-sizing: border-box; }
body {
  font-family: 'Poppins', 'Source Sans Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
  background: #f0f2f5 !important;
  color: #1a1a2e !important;
  margin: 0; padding: 0;
  -webkit-font-smoothing: antialiased;
}

/* ========== HEADER / TOP BAR ========== */
body > div#wrapper > div:first-child,
div[style*="height:155px"],
div[style*="height: 155px"] {
  background: #ffffff !important;
  border-bottom: none !important;
  height: auto !important;
  margin-bottom: 0 !important;
  padding: 0 !important;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

div[style*="width: 1220px"],
div[style*="width:1220px"] {
  width: 100% !important;
  max-width: 1280px !important;
  margin: 0 auto !important;
  padding: 0 24px !important;
}

/* Logo area */
div[style*="padding-top:15px"],
div[style*="padding-top: 15px"] {
  padding: 16px 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
}
div[style*="padding-top:15px"] img,
div[style*="padding-top: 15px"] img {
  height: 40px !important;
  width: auto !important;
}

/* Date display */
div[style*="float:right"][style*="color:#b00"][style*="font-size:15px"],
div[style*="float: right"][style*="color: rgb(187, 0, 0)"] {
  color: #64748b !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  padding: 0 !important;
  float: none !important;
}

/* ========== NAVIGATION BAR ========== */
#floatbar {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%) !important;
  height: auto !important;
  min-height: 52px !important;
  width: 100% !important;
  max-width: 100% !important;
  position: sticky !important;
  top: 0 !important;
  left: 0 !important;
  z-index: 99999 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15) !important;
  padding: 0 24px !important;
  border-radius: 0 !important;
}

#menu {
  float: none !important;
  margin: 0 !important;
  display: flex !important;
  align-items: center !important;
}

#menu ul {
  list-style: none !important;
  display: flex !important;
  gap: 4px !important;
  margin: 0 !important;
  padding: 0 !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
}

#menu ul li a {
  font-size: 14px !important;
  font-weight: 500 !important;
  color: #e2e8f0 !important;
  text-decoration: none !important;
  padding: 8px 16px !important;
  border-radius: 8px !important;
  transition: all 0.2s ease !important;
  display: block !important;
  letter-spacing: 0.01em !important;
}

#menu ul li a:hover {
  background: rgba(255,255,255,0.12) !important;
  color: #ffffff !important;
}

/* Hide search bar & social icons in nav (will be simplified) */
#floatbar > div[style*="float:right"],
#floatbar > div[style*="float: right"] {
  display: none !important;
}

/* ========== MAIN CONTENT AREA ========== */
#doc {
  max-width: 1280px !important;
  margin: 0 auto !important;
  padding: 24px !important;
  display: flex !important;
  gap: 32px !important;
}

#col {
  width: 100% !important;
}

/* ========== HEADLINE / HERO SECTION ========== */
.area1 {
  margin-bottom: 24px !important;
}

.area1 .container {
  background: #ffffff !important;
  border-radius: 16px !important;
  overflow: hidden !important;
  box-shadow: none !important;
  border: none !important;
}

/* Main hero headline (first one) - dark bg + white text */
.area1 > .container > .content > .headline_new {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%) !important;
  border-radius: 16px !important;
  padding: 24px !important;
  position: relative !important;
  border: none !important;
}
.area1 > .container > .content > .headline_new .desc h1 {
  color: #ffffff !important;
  font-size: 22px !important;
}
.area1 > .container > .content > .headline_new .desc h1:hover {
  color: #fca5a5 !important;
}
.area1 > .container > .content > .headline_new .desc .subdesc {
  color: #cbd5e1 !important;
}
.area1 > .container > .content > .headline_new .desc a {
  color: #ffffff !important;
}
.area1 > .container > .content > .headline_new .desc .subjudul {
  color: #f87171 !important;
}

/* Remove all gray borders in area1 */
.area1, .area1 *,
.area1 .container, .area1 .content,
.area1 .headline_new, .area1 .bu_area,
.area1 .show_bu, .area1 .isi,
.area1 .fotox, .area1 .desc,
.area1 .clearfix, .area1 .clearfik,
.area1 .linebu {
  border-color: #ffffff !important;
  outline: none !important;
}

.headline_new {
  display: flex !important;
  gap: 20px !important;
  padding: 20px !important;
  align-items: flex-start !important;
}

.headline_new .fotox {
  flex-shrink: 0 !important;
  width: 280px !important;
  border-radius: 12px !important;
  overflow: hidden !important;
}

.headline_new .fotox img {
  width: 100% !important;
  height: 180px !important;
  object-fit: cover !important;
  display: block !important;
  transition: transform 0.3s ease !important;
}

.headline_new .fotox img:hover {
  transform: scale(1.03) !important;
}

.headline_new .desc {
  flex: 1 !important;
}

.headline_new .desc h1 {
  font-size: 18px !important;
  font-weight: 700 !important;
  line-height: 1.4 !important;
  color: #0f172a !important;
  margin: 0 0 8px 0 !important;
}

.headline_new .desc h1:hover {
  color: #dc2626 !important;
}

.headline_new .subdesc {
  font-size: 14px !important;
  color: #64748b !important;
  line-height: 1.6 !important;
}

.bu_area .show_bu > .isi {
  border-bottom: 1px solid #ffffff !important;
}

.bu_area .show_bu > .isi:last-child {
  border-bottom: none !important;
}

/* ========== JURNAS VIDEO SECTION ========== */
#big-top {
  background: #ffffff !important;
  border-radius: 16px !important;
  padding: 20px !important;
  margin-bottom: 24px !important;
  border-top: 3px solid #dc2626 !important;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06) !important;
}

#big-top .top-stories {
  display: flex !important;
  gap: 16px !important;
  flex-wrap: wrap !important;
}

#big-top .top-stories .m {
  flex: 1 !important;
  min-width: 200px !important;
  margin: 0 !important;
  border-radius: 12px !important;
  overflow: hidden !important;
  float: none !important;
  width: auto !important;
}

#big-top .top-stories .m div[style*="height:170px"],
#big-top .top-stories .m div[style*="height: 170px"] {
  height: 160px !important;
  border-radius: 12px !important;
  overflow: hidden !important;
}

#big-top .top-stories .m img {
  width: 100% !important;
  height: 100% !important;
  object-fit: cover !important;
  transition: transform 0.3s ease !important;
}

#big-top .top-stories .m img:hover {
  transform: scale(1.05) !important;
}

#big-top h5 {
  font-size: 14px !important;
  font-weight: 600 !important;
  line-height: 1.4 !important;
  margin-top: 10px !important;
}

/* ========== TERKINI (Latest News List) ========== */
.jbox {
  width: 100% !important;
  float: none !important;
  margin: 0 !important;
}

.jbox header h2,
.jbox > h2,
div.jbox + header h2 {
  font-size: 20px !important;
  font-weight: 700 !important;
  color: #0f172a !important;
}

#mkts {
  background: #ffffff !important;
  border-radius: 12px !important;
  padding: 16px !important;
  margin-bottom: 12px !important;
  height: auto !important;
  border-bottom: none !important;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04) !important;
  transition: box-shadow 0.2s ease !important;
  display: flex !important;
  align-items: flex-start !important;
  gap: 16px !important;
}

#mkts:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08) !important;
}

.mkts {
  flex-shrink: 0 !important;
  width: 160px !important;
  height: 100px !important;
  border-radius: 10px !important;
  overflow: hidden !important;
  float: none !important;
  margin: 0 !important;
}

.mkts img,
#mkts .mkts img {
  width: 160px !important;
  height: 100px !important;
  object-fit: cover !important;
  border-radius: 10px !important;
  display: block !important;
}

#mkts h3 {
  font-size: 16px !important;
  font-weight: 600 !important;
  line-height: 1.5 !important;
  color: #1e293b !important;
  margin: 0 !important;
}

#mkts a:hover h3 {
  color: #dc2626 !important;
}

/* Category badge */
#mkts div[style*="color:#fd0001"],
#mkts div[style*="color: rgb(253, 0, 1)"] {
  color: #dc2626 !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  text-transform: uppercase !important;
  letter-spacing: 0.05em !important;
  margin-bottom: 4px !important;
  padding: 0 !important;
}

/* ========== SIDEBAR / RAIL ========== */
.rail {
  width: 380px !important;
  min-width: 380px !important;
}

.rail section {
  background: #ffffff !important;
  border-radius: 16px !important;
  padding: 20px !important;
  margin-bottom: 20px !important;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06) !important;
  border-top: 3px solid #dc2626 !important;
}

.rail section h2 {
  font-size: 18px !important;
  font-weight: 700 !important;
  color: #0f172a !important;
  margin: 0 0 16px 0 !important;
  padding: 0 !important;
}

/* Popular articles in sidebar */
.rail .jbox > div[style*="border-bottom"] {
  border-bottom: 1px solid #f1f5f9 !important;
  padding: 12px 0 !important;
  height: auto !important;
}

.rail .jbox h1 {
  color: #dc2626 !important;
  font-size: 24px !important;
}

.rail .jbox h3 {
  font-size: 14px !important;
  font-weight: 500 !important;
  line-height: 1.5 !important;
  padding: 0 8px !important;
}

/* Sidebar section lists */
.rail section ul {
  list-style: none !important;
  padding: 0 !important;
  margin: 0 !important;
}

.rail section ul li {
  margin-bottom: 16px !important;
  padding-bottom: 16px !important;
  border-bottom: 1px solid #f1f5f9 !important;
}

.rail section ul li:last-child {
  border-bottom: none !important;
  margin-bottom: 0 !important;
  padding-bottom: 0 !important;
}

.rail section ul li .m {
  border-radius: 10px !important;
  overflow: hidden !important;
}

.rail section ul li h3 {
  font-size: 14px !important;
  font-weight: 600 !important;
  line-height: 1.4 !important;
}

/* Sidebar category articles */
.rail .advert {
  padding: 12px 0 !important;
  border-bottom: 1px solid #f1f5f9 !important;
}

.rail .advert:last-child {
  border-bottom: none !important;
}

.rail .advert img.img_ad {
  border-radius: 8px !important;
  width: 100px !important;
  height: 68px !important;
  object-fit: cover !important;
}

.rail .advert h3,
.rail .advert h4 {
  font-size: 14px !important;
  font-weight: 500 !important;
  line-height: 1.4 !important;
}

/* Section headers in sidebar */
.rail section > div[style*="font-size:20px"],
.rail section > div[style*="font-size: 20px"] {
  font-size: 18px !important;
  font-weight: 700 !important;
  color: #0f172a !important;
  margin-bottom: 12px !important;
  float: none !important;
}

/* ========== SECTION HEADERS ========== */
div[style*="font-size:20px"][style*="font-weight:bold"] {
  font-size: 20px !important;
  font-weight: 700 !important;
  color: #0f172a !important;
}

section[style*="border-top:red"] {
  border-top: 3px solid #dc2626 !important;
  border-radius: 0 !important;
  margin-top: 8px !important;
  padding-top: 4px !important;
}

/* ========== LINKS ========== */
a {
  color: #1e293b !important;
  text-decoration: none !important;
  transition: color 0.2s ease !important;
}

a:hover {
  color: #dc2626 !important;
}

/* "+ INDEKS" links */
a[href*="indeks"],
div[style*="float:right"] a {
  color: #dc2626 !important;
  font-weight: 600 !important;
  font-size: 13px !important;
}

/* ========== FOOTER ========== */
footer.fn {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%) !important;
  padding: 40px 24px !important;
  margin-top: 40px !important;
}

footer.fn .legal {
  max-width: 1280px !important;
  margin: 0 auto !important;
  display: flex !important;
  flex-wrap: wrap !important;
  gap: 24px !important;
  align-items: flex-start !important;
}

footer.fn .legal img {
  height: 40px !important;
  width: auto !important;
}

footer.fn .legal table {
  font-size: 13px !important;
  color: #cbd5e1 !important;
}

footer.fn .legal a {
  color: #94a3b8 !important;
  font-size: 13px !important;
}

footer.fn .legal a:hover {
  color: #ffffff !important;
}

/* AMSI & Trust badges */
center img[src*="amsi"],
center img[src*="trust"] {
  height: 80px !important;
  padding: 20px !important;
  opacity: 0.8 !important;
  transition: opacity 0.2s !important;
}

center img[src*="amsi"]:hover,
center img[src*="trust"]:hover {
  opacity: 1 !important;
}

/* ========== HIDE JUNK ========== */
.icon_article,
div[id*="div-gpt"],
ins.adsbygoogle,
div[style*="display:none"],
a[style*="display:none"],
.modalDialog {
  display: none !important;
}

/* ========== LINE SEPARATOR ========== */
.linebu {
  height: 2px !important;
  background: linear-gradient(90deg, #dc2626, transparent) !important;
  margin: 16px 0 !important;
  border: none !important;
}

/* ========== RESPONSIVE ========== */
@media (max-width: 1024px) {
  #doc {
    flex-direction: column !important;
    padding: 16px !important;
  }
  .rail {
    width: 100% !important;
    min-width: 100% !important;
  }
  .jbox {
    width: 100% !important;
  }
}

@media (max-width: 768px) {
  #floatbar {
    padding: 8px 12px !important;
  }
  #menu ul {
    gap: 2px !important;
  }
  #menu ul li a {
    font-size: 12px !important;
    padding: 6px 10px !important;
  }
  .headline_new {
    flex-direction: column !important;
    padding: 12px !important;
  }
  .headline_new .fotox {
    width: 100% !important;
  }
  .headline_new .fotox img {
    height: 200px !important;
  }
  #big-top .top-stories .m {
    min-width: 100% !important;
  }
  #mkts {
    padding: 12px !important;
  }
  .mkts {
    width: 120px !important;
    height: 80px !important;
  }
  .mkts img, #mkts .mkts img {
    width: 120px !important;
    height: 80px !important;
  }
}

/* ========== SCROLLBAR ========== */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: #f1f5f9; }
::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #64748b; }

/* ========== FORCE LIGHT MODE ON ALL SECTIONS ========== */
.alt, .alt > div, #big-top.alt,
#col, #col > div, .content, .isi,
.bu_area, .show_bu, .top-stories, .top-stories .m {
  background-color: #ffffff !important;
  background-image: none !important;
}

#big-top.alt {
  border-top: 3px solid #dc2626 !important;
}

/* Force text visibility in all sections */
.alt h1, .alt h2, .alt h3, .alt h5, .alt a, .alt p, .alt span,
#big-top > div, #big-top h5, #big-top h5 a, #big-top a,
#col h1, #col h2, #col h3, #col h5, #col a, #col p,
.show_bu h1, .show_bu a, .show_bu .subdesc,
.jbox h1, .jbox h2, .jbox h3, .jbox a, .jbox > div {
  color: #1a1a2e !important;
}

.alt a:hover, #big-top a:hover, #col a:hover, .jbox a:hover {
  color: #dc2626 !important;
}

/* Category badges stay red */
div[style*="color:#fd0001"], div[style*="color:#AF0000"],
div[style*="color: rgb(253, 0, 1)"] {
  color: #dc2626 !important;
}

/* JURNAS VIDEO section title fix */
#big-top > div[style*="font-size:20px"],
#big-top > div[style*="font-size: 20px"] {
  color: #0f172a !important;
  float: none !important;
  display: inline-block !important;
  margin: 0 0 12px 0 !important;
}

/* TERKINI section header */
.jbox {
  background: transparent !important;
}

.jbox header h2 {
  border-bottom: 3px solid #dc2626 !important;
  display: inline-block !important;
  padding-bottom: 6px !important;
}

/* Override fixed widths */
div[style*="width:800px"],
div[style*="width: 800px"] {
  width: 100% !important;
  float: none !important;
  margin: 10px 0 !important;
}

/* Fix #mkts forced height */
#mkts {
  height: auto !important;
  overflow: visible !important;
}

/* ========== ENHANCED MOBILE (small screens) ========== */
@media (max-width: 480px) {
  body { font-size: 14px !important; }
  div[style*="width:1220px"], div[style*="width: 1220px"],
  div[style*="width:800px"], div[style*="width: 800px"] {
    width: 100% !important;
    padding: 0 12px !important;
    float: none !important;
    margin: 0 !important;
  }
  .headline_new .desc h1 { font-size: 16px !important; }
  .headline_new .subdesc { font-size: 13px !important; }
  #big-top .top-stories .m {
    width: 100% !important;
    min-width: 100% !important;
    float: none !important;
    margin: 0 0 12px 0 !important;
  }
  div[style*="width:260px"], div[style*="width: 260px"] {
    width: 100% !important;
    float: none !important;
    margin: 0 0 12px 0 !important;
  }
  #mkts h3 { font-size: 14px !important; }
  .mkts, .mkts img, #mkts .mkts img {
    width: 100px !important;
    height: 70px !important;
  }
  #floatbar { position: relative !important; }
  #menu ul li a { font-size: 11px !important; padding: 4px 8px !important; }
  #doc { padding: 12px !important; gap: 16px !important; }
}
</style>
`;

  // Inject main CSS before </head>
  let result = html;
  const headCloseIdx = result.lastIndexOf('</head>');
  if (headCloseIdx !== -1) {
    result = result.slice(0, headCloseIdx) + modernCSS + result.slice(headCloseIdx);
  }

  // Inject critical dark-fix overrides before </body> (last position = guaranteed cascade win)
  const darkFixCSS = `<style id="jurnas-dark-fix">
.alt,.alt>*,#big-top.alt{background:#fff!important;background-color:#fff!important}
#big-top.alt{border-top:3px solid #dc2626!important}
.alt h1,.alt h3,.alt h5,.alt a,.alt p,.alt div,.alt span,
#big-top h5,#big-top h5 a,#big-top a,
#col h1,#col h3,#col a,#col p,#col div,
.jbox h1,.jbox h2,.jbox h3,.jbox a,.jbox p,.jbox div,
.show_bu h1,.show_bu a,.show_bu .subdesc,
#mkts h3,#mkts a,#mkts div{color:#1a1a2e!important}
.bu_area .content h1,.bu_area .content a,.bu_area .content .subdesc,
.bu_area .show_bu h1,.bu_area .show_bu a,.bu_area .show_bu .subdesc{color:#1a1a2e!important}
.alt a:hover,#col a:hover,.jbox a:hover,#mkts a:hover,
#big-top a:hover,#big-top h5 a:hover{color:#dc2626!important}
div[style*="color:#fd0001"],div[style*="color:#AF0000"]{color:#dc2626!important}
.jbox{background:transparent!important}
div[style*="width:800px"]{width:100%!important;float:none!important;margin:10px 0!important}
#mkts{height:auto!important;overflow:visible!important}
/* Hero headline: dark bg + white text override */
.area1>.container>.content>.headline_new{background:linear-gradient(135deg,#0f172a,#1e293b)!important}
.area1>.container>.content>.headline_new h1,
.area1>.container>.content>.headline_new a,
.area1>.container>.content>.headline_new .desc h1,
.area1>.container>.content>.headline_new .desc a,
.area1>.container>.content>.headline_new .desc a h1{color:#fff!important}
.area1>.container>.content>.headline_new .subdesc,
.area1>.container>.content>.headline_new .desc .subdesc{color:#cbd5e1!important}
.area1>.container>.content>.headline_new a:hover h1{color:#fca5a5!important}
.area1>.container>.content>.headline_new .desc .subdesc{color:#cbd5e1!important}
.area1>.container>.content>.headline_new .desc a:hover h1{color:#fca5a5!important}
</style>\n`;

  const bodyCloseIdx = result.lastIndexOf('</body>');
  if (bodyCloseIdx !== -1) {
    result = result.slice(0, bodyCloseIdx) + darkFixCSS + result.slice(bodyCloseIdx);
  }

  return result;
}

// ============================================================
// HELPER: Fix canonical tag
// ============================================================
function fixCanonicalTag(html, mirrorOrigin) {
  // Hapus semua existing canonical
  let modified = html.replace(
    /<link\s+[^>]*rel=["']canonical["'][^>]*\/?>/gi,
    ""
  );

  // Inject canonical before the LAST </head> tag (the real one)
  // because the first </head> may be inside an HTML comment
  const headCloseIdx = modified.lastIndexOf('</head>');
  if (headCloseIdx === -1) {
    // fallback: try case-insensitive
    const lowerIdx = modified.toLowerCase().lastIndexOf('</head>');
    if (lowerIdx !== -1) {
      modified = modified.slice(0, lowerIdx) +
        `  <link rel="canonical" href="%%CANONICAL_URL%%" />\n` +
        modified.slice(lowerIdx);
    }
  } else {
    modified = modified.slice(0, headCloseIdx) +
      `  <link rel="canonical" href="%%CANONICAL_URL%%" />\n` +
      modified.slice(headCloseIdx);
  }

  return modified;
}

// ============================================================
// HELPER: Fix meta robots
// ============================================================
function fixMetaRobots(html) {
  // Hapus meta robots noindex jika ada
  let modified = html.replace(
    /<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex[^"']*["'][^>]*\/?>/gi,
    ""
  );
  modified = modified.replace(
    /<meta\s+[^>]*content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["'][^>]*\/?>/gi,
    ""
  );

  // Tambahkan meta robots yang benar jika belum ada
  if (!/<meta\s+[^>]*name=["']robots["']/i.test(modified)) {
    // Inject before the LAST </head> tag
    const headCloseIdx = modified.lastIndexOf('</head>');
    if (headCloseIdx !== -1) {
      modified = modified.slice(0, headCloseIdx) +
        `  <meta name="robots" content="index, follow" />\n` +
        modified.slice(headCloseIdx);
    }
  }

  return modified;
}

// ============================================================
// HELPER: Rewrite JSON-LD structured data
// ============================================================
function rewriteJsonLd(html, sourceDomain, mirrorDomain) {
  return html.replace(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (match, jsonContent) => {
      try {
        let rewritten = jsonContent.replace(
          new RegExp(
            `https?://(www\\.)?${escapeRegex(sourceDomain)}`,
            "gi"
          ),
          `https://${mirrorDomain}`
        );
        return match.replace(jsonContent, rewritten);
      } catch {
        return match;
      }
    }
  );
}

// ============================================================
// HELPER: Rewrite XML content (sitemap, RSS feeds)
// ============================================================
function rewriteXml(xml, mirrorDomain, mirrorProtocol) {
  const sourceDomain = CONFIG.SOURCE_DOMAIN;
  const mirrorOrigin = `${mirrorProtocol || 'https:'}//${mirrorDomain}`;

  let modified = xml;

  modified = modified.replace(
    new RegExp(`https?://(www\\.)?${escapeRegex(sourceDomain)}`, "gi"),
    mirrorOrigin
  );

  modified = modified.replace(
    new RegExp(`//(www\\.)?${escapeRegex(sourceDomain)}`, "gi"),
    `//${mirrorDomain}`
  );

  return modified;
}

// ============================================================
// HELPER: Rewrite CSS content
// ============================================================
function rewriteCss(css, mirrorDomain) {
  // Rewrite CSS url() references to relative paths
  return css.replace(
    new RegExp(
      `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}/`,
      "gi"
    ),
    "/"
  );
}

// ============================================================
// HELPER: Escape regex special chars
// ============================================================
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// HELPER: Decompress response body
// ============================================================
function decompressBody(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip") {
      zlib.gunzip(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "deflate") {
      zlib.inflate(buffer, (err, result) => (err ? reject(err) : resolve(result)));
    } else if (encoding === "br") {
      zlib.brotliDecompress(buffer, (err, result) =>
        err ? reject(err) : resolve(result)
      );
    } else {
      resolve(buffer);
    }
  });
}

// ============================================================
// PROXY UTAMA
// ============================================================
app.use(
  "/",
  createProxyMiddleware({
    target: CONFIG.SOURCE_ORIGIN,
    changeOrigin: true,
    selfHandleResponse: true, // Kita handle response sendiri untuk rewrite

    on: {
      // --------------------------------------------------------
      // Modifikasi request sebelum dikirim ke source
      // --------------------------------------------------------
      proxyReq: (proxyReq, req, res) => {
        // Set Host header ke source domain
        proxyReq.setHeader("Host", CONFIG.SOURCE_DOMAIN);

        // Set User-Agent
        proxyReq.setHeader("User-Agent", CONFIG.USER_AGENT);

        // Hapus header yang bisa menyebabkan masalah
        proxyReq.removeHeader("accept-encoding"); // Supaya response tidak compressed
        proxyReq.removeHeader("if-none-match");
        proxyReq.removeHeader("if-modified-since");

        // Accept all content types
        proxyReq.setHeader(
          "Accept",
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        );
      },

      // --------------------------------------------------------
      // Handle proxy errors
      // --------------------------------------------------------
      error: (err, req, res) => {
        console.error("[PROXY ERROR]", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
        }
        res.end("Proxy error: " + err.message);
      },

      // --------------------------------------------------------
      // Modifikasi response sebelum dikirim ke client
      // --------------------------------------------------------
      proxyRes: async (proxyRes, req, res) => {
        const mirrorDomain =
          CONFIG.MIRROR_DOMAIN || req.headers.host || "localhost";
        // Detect protocol: behind proxy (Codespace/Railway) use https, else http
        const mirrorProtocol = req.headers["x-forwarded-proto"]
          ? req.headers["x-forwarded-proto"] + ":"
          : "https:";
        const mirrorOrigin = `${mirrorProtocol}//${mirrorDomain}`;
        const requestPath = req.originalUrl || req.url;
        const canonicalUrl = `${mirrorOrigin}${requestPath}`;

        // Collect response body
        const chunks = [];
        proxyRes.on("error", (err) => {
          console.error("[PROXY RES ERROR]", err.message);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
          }
          res.end("Upstream error");
        });
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", async () => {
          try {
            let body = Buffer.concat(chunks);

            // Decompress jika perlu
            const contentEncoding = proxyRes.headers["content-encoding"];
            if (contentEncoding) {
              body = await decompressBody(body, contentEncoding);
            }

            const contentType = proxyRes.headers["content-type"] || "";

            // ---- Copy response headers ----
            const excludeHeaders = [
              "content-encoding",
              "content-length",
              "transfer-encoding",
              "connection",
              "x-frame-options",
              "content-security-policy",
              "strict-transport-security",
              "x-content-type-options",
            ];

            Object.keys(proxyRes.headers).forEach((key) => {
              if (!excludeHeaders.includes(key.toLowerCase())) {
                let value = proxyRes.headers[key];
                // Rewrite Location header untuk redirect
                if (key.toLowerCase() === "location" && typeof value === "string") {
                  value = value.replace(
                    new RegExp(
                      `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}`,
                      "gi"
                    ),
                    mirrorOrigin
                  );
                  // Juga handle redirect ke domain mirror yang salah protokol
                  value = value.replace(/^http:/, mirrorProtocol);
                }
                // Rewrite Set-Cookie domain
                if (key.toLowerCase() === "set-cookie") {
                  if (Array.isArray(value)) {
                    value = value.map((v) =>
                      v.replace(
                        new RegExp(escapeRegex(CONFIG.SOURCE_DOMAIN), "gi"),
                        mirrorDomain
                      )
                    );
                  } else if (typeof value === "string") {
                    value = value.replace(
                      new RegExp(escapeRegex(CONFIG.SOURCE_DOMAIN), "gi"),
                      mirrorDomain
                    );
                  }
                }
                res.setHeader(key, value);
              }
            });

            // ---- SEO Headers ----
            res.setHeader("X-Robots-Tag", "index, follow");

            // ---- Process body berdasarkan content type ----
            let finalBody;

            if (contentType.includes("text/html")) {
              // === HTML: Full rewrite ===
              let html = body.toString("utf-8");
              html = rewriteHtml(html, mirrorDomain, mirrorProtocol);
              // Replace canonical placeholder dengan URL aktual
              html = html.replace("%%CANONICAL_URL%%", canonicalUrl);
              finalBody = Buffer.from(html, "utf-8");
            } else if (
              contentType.includes("text/xml") ||
              contentType.includes("application/xml") ||
              contentType.includes("application/rss+xml") ||
              contentType.includes("application/atom+xml") ||
              requestPath.includes("sitemap") ||
              requestPath.endsWith(".xml")
            ) {
              // === XML/Sitemap/RSS: Rewrite URLs ===
              let xml = body.toString("utf-8");
              xml = rewriteXml(xml, mirrorDomain);
              finalBody = Buffer.from(xml, "utf-8");
            } else if (contentType.includes("text/css")) {
              // === CSS: Rewrite url() references ===
              let css = body.toString("utf-8");
              css = rewriteCss(css, mirrorDomain);
              finalBody = Buffer.from(css, "utf-8");
            } else if (
              contentType.includes("application/javascript") ||
              contentType.includes("text/javascript")
            ) {
              // === JavaScript: Rewrite domain references to relative ===
              let js = body.toString("utf-8");
              js = js.replace(
                new RegExp(
                  `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}/`,
                  "gi"
                ),
                "/"
              );
              finalBody = Buffer.from(js, "utf-8");
            } else if (contentType.includes("application/json")) {
              // === JSON: Rewrite domain references to relative ===
              let json = body.toString("utf-8");
              json = json.replace(
                new RegExp(
                  `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}/`,
                  "gi"
                ),
                "/"
              );
              finalBody = Buffer.from(json, "utf-8");
            } else {
              // === Binary/Other: Pass through ===
              finalBody = body;
            }

            // Set content length yang benar
            res.setHeader("Content-Length", finalBody.length);

            // Send response
            res.statusCode = proxyRes.statusCode;
            res.end(finalBody);
          } catch (error) {
            console.error("Proxy response error:", error);
            res.statusCode = 502;
            res.end("Mirror proxy error");
          }
        });
      },
    },
  })
);

// ============================================================
// START SERVER
// ============================================================
app.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         WEBSITE MIRROR PROXY - RUNNING              ║
╠══════════════════════════════════════════════════════╣
║  Port     : ${String(CONFIG.PORT).padEnd(40)}║
║  Source   : ${CONFIG.SOURCE_ORIGIN.padEnd(40)}║
║  Mirror   : ${(CONFIG.MIRROR_DOMAIN || "(auto-detect)").padEnd(40)}║
╚══════════════════════════════════════════════════════╝
  `);
});