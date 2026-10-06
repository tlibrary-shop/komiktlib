const cheerio = require("cheerio");
const {
  BASE_URL,
  fetchHtml,
  getAbsoluteUrl,
  normalizeText,
  cleanTitle,
  getImageUrl,
  extractMangaSlug,
  extractChapterNumber,
  extractChapterSlug,
  logEmptyParse,
} = require("./scraperUtils");

function getChapterApiLink(chapterLink) {
  const chapterSlug = extractChapterSlug(chapterLink);
  const chapterNumber = extractChapterNumber(chapterLink);
  return chapterSlug && chapterNumber
    ? `/baca-chapter/${chapterSlug}/${chapterNumber}`
    : null;
}

function parseChapterLink($, linkElement) {
  const originalLink = getAbsoluteUrl(linkElement.attr("href"));
  const title =
    normalizeText(linkElement.find("span").last().text()) ||
    normalizeText(linkElement.text()) ||
    normalizeText(linkElement.attr("title"));

  return {
    title,
    originalLink,
    apiLink: getChapterApiLink(originalLink),
    chapterNumber: extractChapterNumber(originalLink),
  };
}

function findLabeledChapterLink($, label) {
  const candidates = $("#Judul div, section#Informasi div")
    .toArray()
    .filter((el) => normalizeText($(el).text()).startsWith(label))
    .sort(
      (a, b) => normalizeText($(a).text()).length - normalizeText($(b).text()).length
    );

  return candidates.length
    ? $(candidates[0]).find('a[href*="chapter"]').first()
    : $();
}

async function scrapeKomikDetail(url) {
  const data = await fetchHtml(url);
  const $ = cheerio.load(data);

  const title =
    normalizeText($("h1 [itemprop='name']").first().text()) ||
    normalizeText($("h1").first().text()) ||
    normalizeText($("[itemprop='name']").first().text()) ||
    normalizeText($(".entry-title, .post-title, article h1, main h1").first().text());
  const alternativeTitle = normalizeText($("p.j2").first().text());
  const description = normalizeText($("p.desc").first().text());
  const sinopsis =
    normalizeText($("section#Sinopsis p").first().text()) ||
    normalizeText(
      $("section")
        .filter((_, el) => /sinopsis/i.test(normalizeText($(el).text())))
        .find("p")
        .first()
        .text()
    );

  const thumbnail =
    getImageUrl($, $("section#Informasi img").first()) ||
    getAbsoluteUrl($("meta[itemprop='image']").attr("content")) ||
    getImageUrl($, $("article img").first());

  const infoTable = {};
  $("section#Informasi table tr, section#Informasi .inftable tr").each(
    (_, el) => {
      const cells = $(el).find("td, th");
      const key = normalizeText(cells.first().text()).replace(/:$/, "");
      const value = normalizeText(cells.last().text());
      if (key && value && key !== value) infoTable[key] = value;
    }
  );

  const genres = [
    ...new Set(
      [
        ...$("section#Informasi a[href*='/genre/'], section#Informasi ul.genre li")
          .toArray()
          .map((el) => normalizeText($(el).text())),
        ...$("meta[itemprop='genre']")
          .toArray()
          .map((el) => normalizeText($(el).attr("content"))),
      ].filter(Boolean)
    ),
  ];

  const komikSlug = extractMangaSlug(url);
  // const firstChapterElement = findLabeledChapterLink($, "Awal:");
  // const latestChapterElement = findLabeledChapterLink($, "Terbaru:");

  // const firstChapter = parseChapterLink($, firstChapterElement);
  // const latestChapter = parseChapterLink($, latestChapterElement);

  const chapters = [];
  const chapterRows = $("section#Chapter table tr, table#Daftar_Chapter tr")
    .toArray()
    .filter((el) => $(el).find('a[href*="chapter"], a[href*="/ch/"]').length);

  chapterRows.forEach((el) => {
    const row = $(el);
    const chapterLinkElement = row.find('a[href*="chapter"]').first();
    const chapter = parseChapterLink($, chapterLinkElement);
    const cells = row.find("td");
    chapters.push({
      ...chapter,
      views: normalizeText(row.find(".pembaca, td.pembaca, i").first().text()),
      date:
        normalizeText(row.find(".tanggalseries").first().text()) ||
        normalizeText(cells.last().text()),
    });
  });

  if (!chapters.length) {
    $('a[href*="chapter"], a[href*="/ch/"]').each((_, el) => {
      const chapter = parseChapterLink($, $(el));
      if (chapter.originalLink && chapter.title) {
        chapters.push({ ...chapter, views: "", date: "" });
      }
    });
  }

  const similarKomik = [];
  $("section#Spoiler, section")
    .filter((_, el) => /Komik Serupa/i.test(normalizeText($(el).text())))
    .find('a[href*="/manga/"]')
    .each((_, el) => {
      const linkElement = $(el);
      const card = linkElement.closest("article, li, div");
      const originalLink = getAbsoluteUrl(linkElement.attr("href"));
      const slug = extractMangaSlug(originalLink);
      const img = card.find("img").first();
      const type =
        normalizeText(card.find("strong, b").first().text()) ||
        normalizeText(card.find("[itemprop='additionalType']").attr("content"));

      const item = {
        title:
          cleanTitle(card.find(".h4, h3, h4").first().text()) ||
          cleanTitle(linkElement.attr("title")) ||
          cleanTitle(img.attr("alt")),
        originalLink,
        apiLink: slug ? `/detail-komik/${slug}` : null,
        thumbnail: getImageUrl($, img),
        type,
        genres: normalizeText(card.find(".tpe1_inf").text()).replace(type, "").trim(),
        synopsis: normalizeText(card.find("p").first().text()),
        views: normalizeText(card.find(".vw").first().text()),
        slug,
      };

      if (
        item.title &&
        item.originalLink &&
        !similarKomik.some((komik) => komik.slug === item.slug)
      ) {
        similarKomik.push(item);
      }
    });

  if (!title || !thumbnail || !chapters.length) {
    logEmptyParse("GET /detail-komik", data, {
      target: url,
      titleFound: !!title,
      thumbnailFound: !!thumbnail,
      chaptersFound: chapters.length,
      selectors:
        "h1, section#Informasi img, section#Chapter a[href*='chapter']",
    });
  }

  return {
    title,
    alternativeTitle,
    description,
    sinopsis,
    thumbnail,
    info: infoTable,
    genres,
    slug: komikSlug,
    sourceUrl: url,
    // firstChapter,
    // latestChapter,
    chapters,
    similarKomik,
  };
}

const getDetail = async (req, res) => {
  try {
    const { slug } = req.params;
    const requestedUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
    let komikUrl = `${BASE_URL}/manga/${slug}/`;

    if (requestedUrl) {
      try {
        const parsed = new URL(requestedUrl, BASE_URL);
        if (parsed.hostname === new URL(BASE_URL).hostname) komikUrl = parsed.toString();
      } catch {}
    }

    let komikDetail;
    try {
      komikDetail = await scrapeKomikDetail(komikUrl);
    } catch (error) {
      if (!error.response || error.response.status !== 404) throw error;
    }

    if (!komikDetail || !komikDetail.title || !komikDetail.chapters.length) {
      const searchUrl = `${BASE_URL}/?post_type=manga&s=${encodeURIComponent(slug)}`;

      try {
        const searchHtml = await fetchHtml(searchUrl);
        const search$ = cheerio.load(searchHtml);
        const normalizedSlug = normalizeText(slug)
          .toLowerCase()
          .replace(/[-_]+/g, " ")
          .trim();

        const candidates = search$("a[href]")
          .toArray()
          .map((el) => {
            const href = getAbsoluteUrl(search$(el).attr("href"));
            const text = normalizeText(
              search$(el).attr("title") ||
                search$(el).find("h1,h2,h3,h4,.h4,.title").first().text() ||
                search$(el).text()
            ).toLowerCase();
            const hrefSlug = extractMangaSlug(href).toLowerCase();
            const hrefPath = (() => {
              try {
                return new URL(href).pathname.toLowerCase();
              } catch {
                return "";
              }
            })();

            let score = 0;
            if (hrefSlug === slug.toLowerCase()) score += 100;
            if (hrefSlug === normalizedSlug.replace(/\s+/g, "-")) score += 80;
            if (text === normalizedSlug) score += 60;
            if (text.includes(normalizedSlug)) score += 20;
            if (hrefPath === `/${slug.toLowerCase()}/`) score += 90;

            return { href, score };
          })
          .filter((item) => {
            if (!item.href || item.score <= 0) return false;
            try {
              const parsed = new URL(item.href);
              return (
                parsed.hostname === new URL(BASE_URL).hostname &&
                !/chapter|search|genre|page=|post_type=manga/i.test(parsed.pathname + parsed.search)
              );
            } catch {
              return false;
            }
          })
          .sort((a, b) => b.score - a.score);

        for (const candidate of candidates) {
          try {
            const detail = await scrapeKomikDetail(candidate.href);
            if (detail.title && detail.chapters.length) {
              komikDetail = detail;
              break;
            }
          } catch (error) {
            if (!error.response || error.response.status !== 404) {
              console.warn("Gagal mencoba kandidat detail Komiku:", candidate.href, error.message);
            }
          }
        }
      } catch (error) {
        if (!error.response || error.response.status !== 404) throw error;
      }
    }

    // Fallback terakhir: beberapa permalink Komiku.org bisa 404 meskipun\n    // komiknya masih ada di daftar/chapter. Komiku Plus memakai pola URL\n    // yang sama untuk detail: /komik/{slug}.\n    if (!komikDetail || !komikDetail.title || !komikDetail.chapters.length) {\n      const plusUrl = `https://komiku.plus/komik/${encodeURIComponent(slug)}`;\n      try {\n        const plusDetail = await scrapeKomikDetail(plusUrl);\n        if (plusDetail.title && plusDetail.chapters.length) {\n          komikDetail = {\n            ...plusDetail,\n            sourceUrl: plusUrl,\n          };\n          console.log("Fallback detail berhasil dari Komiku Plus:", plusUrl);\n        }\n      } catch (error) {\n        if (!error.response || error.response.status !== 404) {\n          console.warn("Gagal mencoba fallback Komiku Plus:", plusUrl, error.message);\n        }\n      }\n    }\n\n    // Fallback otomatis ke Komiku Plus jika detail Komiku.org gagal/404/kosong.
    // Komiku Plus memakai pola URL /komik/{slug}.
    if (!komikDetail || !komikDetail.title || !komikDetail.chapters.length) {
      const plusUrl = "https://komiku.plus/komik/" + encodeURIComponent(slug);
      try {
        const plusDetail = await scrapeKomikDetail(plusUrl);
        if (plusDetail.title && plusDetail.chapters.length) {
          komikDetail = {
            ...plusDetail,
            slug,
            sourceUrl: plusUrl,
          };
        }
      } catch (error) {
        console.warn("Gagal mencoba fallback Komiku Plus:", plusUrl, error.message);
      }
    }
    if (!komikDetail || !komikDetail.title || !komikDetail.chapters.length) {
      return res.status(502).json({
        error: "Gagal parsing detail komik dari Komiku.",
        detail:
          "Struktur HTML detail komik kemungkinan berubah atau data chapter kosong.",
      });
    }

    res.json(komikDetail);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        error: "Komik tidak ditemukan",
        detail: "Komik dengan slug tersebut tidak ditemukan di situs Komiku.",
      });
    }
    console.error("Error fetching komik detail:", err);
    res.status(500).json({
      error: "Gagal mengambil detail komik",
      detail: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

module.exports = { getDetail };

