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
  getApiChapterLink,
  logEmptyParse,
  findHtmxUrl,
} = require("./scraperUtils");

function parseType(...values) {
  const text = values.map(normalizeText).join(" ");
  const match = text.match(/\b(Manga|Manhwa|Manhua)\b/i);
  if (!match) return "";
  const type = match[1].toLowerCase();
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function parseKomikCard($, el) {
  const card = $(el);
  const mangaLinkElement =
    card.find('h3 a[href*="/manga/"], h4 a[href*="/manga/"], h2 a[href*="/manga/"]').first().length
      ? card.find('h3 a[href*="/manga/"], h4 a[href*="/manga/"], h2 a[href*="/manga/"]').first()
      : card.find('a[href*="/manga/"]').first();
  const originalLink = getAbsoluteUrl(mangaLinkElement.attr("href"));
  const mangaSlug = extractMangaSlug(originalLink);
  const img = card.find('a[href*="/manga/"] img, img').first();
  const infoText = normalizeText(
    card.find("span, p, small").filter((_, node) => /views?|pembaca|·/i.test($(node).text())).first().text()
  );
  const infoParts = infoText.split(/\s*[·|]\s*/).map(normalizeText).filter(Boolean);
  const genre =
    infoParts.find((part) => !/views?|pembaca/i.test(part)) ||
    normalizeText(card.find(".ls2t, .ls4s").first().text()) ||
    "";
  const readers = infoParts.find((part) => /views?|pembaca/i.test(part)) || "";
  const latestChapterElement = card.find('a[href*="chapter"], a.ls2l').last();
  const originalChapterLink = getAbsoluteUrl(latestChapterElement.attr("href"));
  const latestChapter =
    normalizeText(latestChapterElement.text()) ||
    normalizeText(latestChapterElement.attr("title"));
  const chapterNumber =
    extractChapterNumber(originalChapterLink) ||
    latestChapter.match(/Chapter\s*([\d.]+)/i)?.[1] ||
    "";
  const explicitType = card.attr("data-tipe") || "";

  const rawTitleCandidates = [
    mangaLinkElement.attr("title"),
    img.attr("alt"),
    mangaLinkElement.text(),
  ].map(cleanTitle).filter(Boolean);

  const title =
    rawTitleCandidates
      .map((value) =>
        value
          .replace(/^(?:Manga|Manhwa|Manhua)\s+/i, "")
          .replace(/\s+Up\s*\d+$/i, "")
          .replace(/\s+Chapter\s+[\d.]+$/i, "")
          .trim()
      )
      .find(Boolean) || "Judul Tidak Tersedia";

  return {
    title,
    originalLink,
    apiDetailLink: mangaSlug ? `/detail-komik/${mangaSlug}` : null,
    thumbnail: getImageUrl($, img),
    genre,
    readers,
    latestChapter,
    originalChapterLink,
    apiChapterLink: getApiChapterLink(originalChapterLink, mangaSlug),
    mangaSlug,
    chapterNumber,
    type: explicitType || parseType(mangaLinkElement.attr("title"), img.attr("alt"), card.text()),
  };
}

function scrapeKomikSection($, sectionSelector, fallbackTitle, typeFilter = "") {
  let cardElements;

  if (typeFilter && $(`article[data-tipe="${typeFilter}"]`).length) {
    cardElements = $(`article[data-tipe="${typeFilter}"]`);
  } else {
    const sectionElement = $(sectionSelector).length
      ? $(sectionSelector)
      : $("section")
          .filter((_, el) => /Komik Populer|Populer Update|Peringkat|Baru Ditambahkan/i.test($(el).text()))
          .first();
    cardElements = sectionElement.find('.bge:has(a[href*="/manga/"])').length
      ? sectionElement.find('.bge:has(a[href*="/manga/"])')
      : sectionElement.find('article:has(a[href*="/manga/"])').length
        ? sectionElement.find('article:has(a[href*="/manga/"])')
        : sectionElement.find('li:has(a[href*="/manga/"]), div:has(> a[href*="/manga/"])');
  }

  const seen = new Set();
  const items = cardElements
    .toArray()
    .map((el) => parseKomikCard($, el))
    .filter((item) => {
      if (
        !item.title ||
        !item.originalLink ||
        !item.thumbnail ||
        seen.has(item.mangaSlug)
      ) {
        return false;
      }

      if (typeFilter && item.type.toLowerCase() !== typeFilter.toLowerCase()) return false;
      seen.add(item.mangaSlug);
      return true;
    })
    .map(({ type, ...item }) => item);

  return { title: fallbackTitle, items };
}

async function loadPopularPage(page = 1, typeFilter = "") {
  const validPage = Math.max(1, parseInt(page, 10) || 1);
  const typeQuery = typeFilter ? `&tipe=${encodeURIComponent(typeFilter.toLowerCase())}` : "";
  const pageUrl = `${BASE_URL}/pustaka/page/${validPage}/?orderby=meta_value_num&sorttime=all${typeQuery}`;

  // Komiku memuat isi pustaka lewat HTMX. Ambil fragment yang berisi kartu,
  // bukan HTML shell-nya.
  const shellHtml = await fetchHtml(pageUrl);
  const shell$ = cheerio.load(shellHtml);
  const htmxUrl = findHtmxUrl(shell$);
  const data = htmxUrl
    ? await fetchHtml(htmxUrl, {
        headers: {
          "HX-Request": "true",
          Referer: pageUrl,
        },
      })
    : shellHtml;

  return { data, $: cheerio.load(data), page: validPage };
}

function ensureItems(context, data, result) {
  if (!result.items.length) {
    logEmptyParse(context, data, {
      target: BASE_URL,
      selector: '#Komik_Populer a[href*="/manga/"], a[href*="chapter"], img',
    });
  }
}

const komikPopuler = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [mangaCtx, manhwaCtx, manhuaCtx] = await Promise.all([
      loadPopularPage(page, "Manga"),
      loadPopularPage(page, "Manhwa"),
      loadPopularPage(page, "Manhua"),
    ]);
    const mangaPopuler = scrapeKomikSection(mangaCtx.$, "body", "Manga Populer", "Manga");
    const manhwaPopuler = scrapeKomikSection(manhwaCtx.$, "body", "Manhwa Populer", "Manhwa");
    const manhuaPopuler = scrapeKomikSection(manhuaCtx.$, "body", "Manhua Populer", "Manhua");

    res.json({
      page,
      manga: { ...mangaPopuler, hasNextPage: mangaPopuler.items.length >= 10 },
      manhwa: { ...manhwaPopuler, hasNextPage: manhwaPopuler.items.length >= 10 },
      manhua: { ...manhuaPopuler, hasNextPage: manhuaPopuler.items.length >= 10 },
    });
  } catch (err) {
    console.error("Error scraping semua komik populer:", err);
    res.status(500).json({
      error: "Gagal mengambil data komik populer",
      detail: err.message,
    });
  }
};

const rekomendasiManga = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { data, $ } = await loadPopularPage(page, "Manga");
    const mangaPopuler = scrapeKomikSection($, "body", "Manga Populer", "Manga");
    ensureItems("GET /komik-populer/manga", data, mangaPopuler);
    res.json({ ...mangaPopuler, page, hasNextPage: mangaPopuler.items.length >= 10 });
  } catch (err) {
    console.error("Error scraping manga populer:", err);
    res.status(500).json({
      error: "Gagal mengambil data manga populer",
      detail: err.message,
    });
  }
};

const rekomendasiManhwa = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { data, $ } = await loadPopularPage(page, "Manhwa");
    const manhwaPopuler = scrapeKomikSection($, "body", "Manhwa Populer", "Manhwa");
    ensureItems("GET /komik-populer/manhwa", data, manhwaPopuler);
    res.json({ ...manhwaPopuler, page, hasNextPage: manhwaPopuler.items.length >= 10 });
  } catch (err) {
    console.error("Error scraping manhwa populer:", err);
    res.status(500).json({
      error: "Gagal mengambil data manhwa populer",
      detail: err.message,
    });
  }
};

const rekomendasiManhua = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { data, $ } = await loadPopularPage(page, "Manhua");
    const manhuaPopuler = scrapeKomikSection($, "body", "Manhua Populer", "Manhua");
    ensureItems("GET /komik-populer/manhua", data, manhuaPopuler);
    res.json({ ...manhuaPopuler, page, hasNextPage: manhuaPopuler.items.length >= 10 });
  } catch (err) {
    console.error("Error scraping manhua populer:", err);
    res.status(500).json({
      error: "Gagal mengambil data manhua populer",
      detail: err.message,
    });
  }
};

module.exports = {
  komikPopuler,
  rekomendasiManga,
  rekomendasiManhwa,
  rekomendasiManhua,
};
