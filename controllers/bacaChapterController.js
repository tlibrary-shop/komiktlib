const cheerio = require("cheerio");
const {
  BASE_URL,
  fetchHtml,
  getAbsoluteUrl,
  normalizeText,
  getImageUrl,
  extractMangaSlug,
  extractChapterNumber,
  extractChapterSlug,
  logEmptyParse,
} = require("./scraperUtils");

function extractSlugAndChapter(url) {
  const absoluteUrl = getAbsoluteUrl(url);
  return {
    slug: extractChapterSlug(absoluteUrl),
    chapter: extractChapterNumber(absoluteUrl),
  };
}

function getChapterInfo(link, currentSlug = "") {
  if (!link) return null;

  const originalLink = getAbsoluteUrl(link);
  const slug = extractChapterSlug(originalLink) || currentSlug;
  const chapter = extractChapterNumber(originalLink);

  return slug && chapter
    ? {
        originalLink,
        apiLink: `/baca-chapter/${slug}/${chapter}`,
        slug,
        chapter,
      }
    : null;
}

function getDescription($) {
  const descriptionText = normalizeText($("#Description").first().text());
  if (descriptionText) return descriptionText;

  return normalizeText(
    $("p")
      .filter((_, el) => /Baca online|update di Komiku/i.test($(el).text()))
      .first()
      .text()
  );
}

function chapterSortValue(chapter) {
  const normalized = String(chapter || "").replace(/-/g, ".");
  const value = parseFloat(normalized);
  return Number.isNaN(value) ? 0 : value;
}

function getChapterUrlCandidates(slug, chapter) {
  const rawChapter = String(chapter || "").trim();
  const normalizedChapter = rawChapter.replace(/\./g, "-");
  const isNumeric = /^\d+$/.test(normalizedChapter);
  const unpaddedChapter = isNumeric
    ? String(parseInt(normalizedChapter, 10))
    : normalizedChapter;
  const paddedChapter = isNumeric && unpaddedChapter.length === 1
    ? unpaddedChapter.padStart(2, "0")
    : normalizedChapter;

  const chapterCandidates = [rawChapter, normalizedChapter, paddedChapter, unpaddedChapter]
    .filter(Boolean)
    .filter((value, index, allValues) => allValues.indexOf(value) === index);

  const cleanSlug = String(slug || "").trim().toLowerCase();
  const slugCandidates = [
    cleanSlug,
    cleanSlug.replace(/^komik-/i, ""),
    cleanSlug.replace(/-indo$/i, ""),
    cleanSlug.replace(/^komik-/i, "").replace(/-indo$/i, ""),
  ].filter(Boolean).filter((value, index, allValues) => allValues.indexOf(value) === index);

  const candidates = [];
  for (const s of slugCandidates) {
    for (const c of chapterCandidates) {
      candidates.push({
        chapterValue: c,
        url: `${BASE_URL}/${s}-chapter-${c}/`,
      });
    }
  }

  return candidates;
}

async function fetchChapterHtml(slug, chapter, sourceUrl = "") {
  const targetChapter = String(chapter || "").trim();
  let lastError;

  // Jangan menebak URL chapter sebagai mekanisme utama.
  // Ambil halaman detail komik lalu gunakan URL chapter asli yang diberikan Komiku.
  try {
    const mangaUrl = sourceUrl || `${BASE_URL}/manga/${encodeURIComponent(slug)}/`;
    const mangaHtml = await fetchHtml(mangaUrl);
    const $ = cheerio.load(mangaHtml);

    const chapterLinks = $("a[href]")
      .toArray()
      .map((el) => {
        const link = getAbsoluteUrl($(el).attr("href"));
        const text = normalizeText($(el).text() || $(el).attr("title") || $(el).attr("aria-label"));
        const urlChapter = extractChapterNumber(link);
        const textMatch = text.match(/(?:chapter|ch\.?|episode|eps\.?)?\s*([0-9]+(?:[.-][0-9]+)*)\s*$/i);
        const textChapter = textMatch ? textMatch[1] : "";
        return {
          link,
          chapter: urlChapter || textChapter,
        };
      })
      .filter((item) => item.link && item.chapter);

    const exactChapterLink = chapterLinks.find((item) => {
      return item.chapter === targetChapter;
    })?.link;

    if (exactChapterLink) {
      const data = await fetchHtml(exactChapterLink);
      return {
        data,
        chapterUrl: exactChapterLink,
        chapterValue: extractChapterNumber(exactChapterLink) || targetChapter,
      };
    }
  } catch (error) {
    lastError = error;
    if (error.response && error.response.status !== 404) throw error;
  }

  // Fallback untuk kompatibilitas dengan URL chapter lama/pola standar.
  const sourceBase = (() => {
    try {
      return sourceUrl ? new URL(sourceUrl).origin : BASE_URL;
    } catch {
      return BASE_URL;
    }
  })();

  const candidates = getChapterUrlCandidates(slug, chapter).map((candidate) => ({
    ...candidate,
    url: candidate.url.replace(BASE_URL, sourceBase),
  }));

  for (const candidate of candidates) {
    try {
      const data = await fetchHtml(candidate.url);
      return { data, chapterUrl: candidate.url, chapterValue: candidate.chapterValue };
    } catch (error) {
      lastError = error;
      if (!error.response || error.response.status !== 404) throw error;
    }
  }

  throw lastError || new Error("Chapter tidak ditemukan");
}

const getBacaChapter = async (req, res) => {
  try {
    const { slug, chapter } = req.params;
    const sourceUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
    const { data, chapterUrl, chapterValue } = await fetchChapterHtml(slug, chapter, sourceUrl);
    const $ = cheerio.load(data);

    const title =
      normalizeText($("#Judul h1").first().text()) ||
      normalizeText($("h1").first().text()) ||
      normalizeText($("meta[itemprop='name']").attr("content"));
    const mangaTitleElement = $(
      '#Judul a[href*="/manga/"], #Judul a[href*="/komik/"], a[href*="/manga/"], a[href*="/komik/"]'
    ).first();
    const mangaTitle =
      normalizeText(mangaTitleElement.find("b").first().text()) ||
      normalizeText(mangaTitleElement.text()) ||
      normalizeText(mangaTitleElement.attr("title"));
    const mangaLink = getAbsoluteUrl(mangaTitleElement.attr("href"));
    const mangaSlug = extractMangaSlug(mangaLink);

    const chapterInfo = {};
    $("#Judul table tr, table.tbl tr").each((_, el) => {
      const cells = $(el).find("td, th");
      const key = normalizeText(cells.first().text()).replace(/:$/, "");
      const value = normalizeText(cells.last().text());
      if (key && value && key !== value) chapterInfo[key] = value;
    });

    const images = [];
    const isKomikuPlus = /komiku\.plus/i.test(chapterUrl);

    $("#Baca_Komik img, img.ww, img[id], article img, main img").each((_, el) => {
      const img = $(el);
      const src = getImageUrl($, img);
      const id = normalizeText(img.attr("id"));
      const alt = normalizeText(img.attr("alt"));
      const isLikelyPageImage =
        /\.(?:jpe?g|png|webp|avif)(?:\?|$)/i.test(src || "") ||
        /(?:uploads?\d*|chapter|comic|manga)/i.test(src || "") ||
        /^\d+$/.test(id);

      const isAllowedKomikuImage =
        src &&
        /(?:[\w-]+\.)?komiku\.(?:org|to|plus)\//i.test(src);

      if (
        src &&
        isAllowedKomikuImage &&
        (isKomikuPlus ? isLikelyPageImage : /(?:uploads?\d*|chapter|comic|manga)/i.test(src || "") || /^\d+$/.test(id))
      ) {
        images.push({
          src,
          alt,
          id,
          fallbackSrc: src
            .replace("cdn.komiku.org", "img.komiku.org")
            .replace("cdn.komiku.plus", "img.komiku.plus"),
        });
      }
    });

    const uniqueImages = images.filter(
      (image, index, allImages) =>
        image.src && allImages.findIndex((item) => item.src === image.src) === index
    );

    const navigationLinks = $("#Judul")
      .parent()
      .find('a[href*="chapter"], a[href*="/ch/"]')
      .toArray()
      .map((el) => getAbsoluteUrl($(el).attr("href")))
      .filter(Boolean);

    const currentChapterNumber = chapterSortValue(chapterValue);
    const chapterCandidates = [
      ...new Set(
        navigationLinks.filter(
          (link) =>
            extractChapterSlug(link) === slug &&
            extractChapterNumber(link) !== String(chapterValue)
        )
      ),
    ];

    const prevLink =
      chapterCandidates
        .filter((link) => chapterSortValue(extractChapterNumber(link)) < currentChapterNumber)
        .sort(
          (a, b) =>
            chapterSortValue(extractChapterNumber(b)) -
            chapterSortValue(extractChapterNumber(a))
        )[0] || "";
    const nextLink =
      chapterCandidates
        .filter((link) => chapterSortValue(extractChapterNumber(link)) > currentChapterNumber)
        .sort(
          (a, b) =>
            chapterSortValue(extractChapterNumber(a)) -
            chapterSortValue(extractChapterNumber(b))
        )[0] || "";

    const chapterValueInfo =
      extractChapterNumber(chapterUrl) ||
      $(".chapterInfo").attr("valuechapter") ||
      normalizeText($("#Judul h1").first().text()).match(/(?:chapter|ch\.?|episode|eps\.?)\s*([0-9]+(?:[.-][0-9]+)*)/i)?.[1] ||
      chapterValue;
    const totalImages =
      $(".chapterInfo").attr("valuegambar") || uniqueImages.length.toString();
    const viewAnalyticsUrl = $(".chapterInfo").attr("valueview") || "";
    const additionalDescription = normalizeText($("#Komentar p").first().text());
    const publishDate =
      $("time[property='datePublished']").attr("datetime") ||
      $("meta[itemprop='datePublished']").attr("content") ||
      normalizeText($("time").first().text());

    if (!title || !uniqueImages.length) {
      logEmptyParse("GET /baca-chapter", data, {
        target: chapterUrl,
        titleFound: !!title,
        imagesFound: uniqueImages.length,
        selectors: "#Judul h1, #Baca_Komik img, img.ww",
      });

      return res.status(502).json({
        error: "Gagal parsing data chapter komik dari Komiku.",
        detail:
          "Struktur HTML chapter kemungkinan berubah atau gambar chapter kosong.",
      });
    }

    res.json({
      title,
      mangaInfo: {
        title: mangaTitle,
        originalLink: mangaLink,
        apiLink: mangaSlug ? `/detail-komik/${mangaSlug}` : null,
        slug: mangaSlug,
      },
      description: getDescription($),
      chapterInfo,
      images: uniqueImages,
      meta: {
        chapterNumber: chapterValueInfo,
        totalImages: parseInt(totalImages, 10) || 0,
        publishDate,
        viewAnalyticsUrl,
        slug,
      },
      navigation: {
        prevChapter: getChapterInfo(prevLink, slug),
        nextChapter: getChapterInfo(nextLink, slug),
        allChapters: mangaSlug ? `/detail-komik/${mangaSlug}` : null,
      },
      additionalDescription,
    });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        error: "Chapter tidak ditemukan",
        detail: "Chapter komik tersebut tidak ditemukan di situs Komiku.",
      });
    }
    console.error("Error fetching chapter:", err);
    res.status(500).json({
      error: "Gagal mengambil data chapter komik",
      detail: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

module.exports = { getBacaChapter, extractSlugAndChapter };

