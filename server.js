const express = require("express");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");
const zlib = require("zlib");

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
// FUNGSI UTAMA: Rewrite semua URL di HTML content
// ============================================================
function rewriteHtml(html, mirrorDomain) {
  const sourceDomain = CONFIG.SOURCE_DOMAIN;
  const sourceOrigin = CONFIG.SOURCE_ORIGIN;
  const mirrorOrigin = `https://${mirrorDomain}`;

  let modified = html;

  // 1. Rewrite absolute URLs (https://jurnas.com -> https://yourmirror.com)
  //    Covers: href, src, action, canonical, og:url, sitemap references, etc.
  modified = modified.replace(
    new RegExp(`https?://(www\\.)?${escapeRegex(sourceDomain)}`, "gi"),
    mirrorOrigin
  );

  // 2. Rewrite protocol-relative URLs (//jurnas.com -> //yourmirror.com)
  modified = modified.replace(
    new RegExp(`//(www\\.)?${escapeRegex(sourceDomain)}`, "gi"),
    `//${mirrorDomain}`
  );

  // 3. Fix canonical tag - pastikan hanya ada SATU dan mengarah ke mirror
  //    Hapus semua canonical yang ada, lalu sisipkan yang benar
  modified = fixCanonicalTag(modified, mirrorOrigin);

  // 4. Fix/Add meta robots - pastikan halaman bisa di-index
  modified = fixMetaRobots(modified);

  // 5. Remove/rewrite any base tag that points to source
  modified = modified.replace(
    new RegExp(
      `<base\\s+href=["']https?://(www\\.)?${escapeRegex(sourceDomain)}[^"']*["']`,
      "gi"
    ),
    `<base href="${mirrorOrigin}/"`
  );

  // 6. Rewrite inline JSON-LD structured data
  modified = rewriteJsonLd(modified, sourceDomain, mirrorDomain);

  // 7. Rewrite srcset attributes
  modified = modified.replace(
    new RegExp(
      `(srcset=["'][^"']*)https?://(www\\.)?${escapeRegex(sourceDomain)}`,
      "gi"
    ),
    `$1${mirrorOrigin}`
  );

  // 8. Rewrite CSS url() references
  modified = modified.replace(
    new RegExp(
      `(url\\(["']?)https?://(www\\.)?${escapeRegex(sourceDomain)}`,
      "gi"
    ),
    `$1${mirrorOrigin}`
  );

  // 9. Rewrite JavaScript string references (careful, broad match)
  //    Target common patterns like window.location assignments
  modified = modified.replace(
    new RegExp(
      `(["'\`])https?://(www\\.)?${escapeRegex(sourceDomain)}`,
      "gi"
    ),
    `$1${mirrorOrigin}`
  );

  return modified;
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

  // Kita akan inject canonical di </head>
  // Canonical URL = mirrorOrigin + path dari halaman saat ini
  // Ini akan di-set per-request di responseInterceptor
  // Untuk sekarang, tambahkan placeholder
  modified = modified.replace(
    /<\/head>/i,
    `  <link rel="canonical" href="%%CANONICAL_URL%%" />\n</head>`
  );

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
    modified = modified.replace(
      /<\/head>/i,
      `  <meta name="robots" content="index, follow" />\n</head>`
    );
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
function rewriteXml(xml, mirrorDomain) {
  const sourceDomain = CONFIG.SOURCE_DOMAIN;
  const mirrorOrigin = `https://${mirrorDomain}`;

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
  const mirrorOrigin = `https://${mirrorDomain}`;

  return css.replace(
    new RegExp(
      `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}`,
      "gi"
    ),
    mirrorOrigin
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
      // Modifikasi response sebelum dikirim ke client
      // --------------------------------------------------------
      proxyRes: async (proxyRes, req, res) => {
        const mirrorDomain =
          CONFIG.MIRROR_DOMAIN || req.headers.host || "localhost";
        const mirrorOrigin = `https://${mirrorDomain}`;
        const requestPath = req.originalUrl || req.url;
        const canonicalUrl = `${mirrorOrigin}${requestPath}`;

        // Collect response body
        const chunks = [];
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
              html = rewriteHtml(html, mirrorDomain);
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
              // === JavaScript: Rewrite domain references ===
              let js = body.toString("utf-8");
              js = js.replace(
                new RegExp(
                  `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}`,
                  "gi"
                ),
                mirrorOrigin
              );
              finalBody = Buffer.from(js, "utf-8");
            } else if (contentType.includes("application/json")) {
              // === JSON: Rewrite domain references ===
              let json = body.toString("utf-8");
              json = json.replace(
                new RegExp(
                  `https?://(www\\.)?${escapeRegex(CONFIG.SOURCE_DOMAIN)}`,
                  "gi"
                ),
                mirrorOrigin
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