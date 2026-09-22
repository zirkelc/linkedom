/**
 * Cases for the linkedom perf campaign.
 *
 * Two workloads:
 * - A scraper pipeline that mirrors a production content extractor: parse a full e-commerce page
 *   (Shopify storefronts), find the main element through skip links and `main` selectors, clone
 *   Shopify template sections on `/pages/*` URLs, remove many elements by selector, and serialize
 *   the rest with `outerHTML` (the Markdown converter re-parses that string).
 * - The phases of `test/benchmark/content.js`: parse, normalize, crawl, clone, query, remove,
 *   serialize and the `innerHTML` round trip, on the repo's own benchmark pages.
 *
 * Fixtures are real storefront pages in `perf/fixtures/` (untracked, see `fetch-fixtures.sh`).
 * All inputs are fixed files, so every run is deterministic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type PerfCase, fnv1a } from "./harness.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "perf", "fixtures");
const BENCH = path.join(ROOT, "test", "benchmark");

interface Page {
  name: string;
  url: string;
  html: string;
}

const readPages = (): Array<Page> => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort();
  if (files.length === 0) throw new Error(`No fixtures in ${FIXTURES}. Run perf/fetch-fixtures.sh.`);
  return files.map((file) => {
    const name = file.replace(/\.html$/, "");
    const [host, ...rest] = name.split("_");
    return { name, url: `https://${host}/${rest.join("/")}`, html: fs.readFileSync(path.join(FIXTURES, file), "utf8") };
  });
};

const PAGES = readPages();
const SHOPIFY_PAGES_REGEX = /\/pages\//i;
const PAGES_URLS = PAGES.filter((p) => SHOPIFY_PAGES_REGEX.test(p.url));
const OTHER_URLS = PAGES.filter((p) => !SHOPIFY_PAGES_REGEX.test(p.url));
const W3C = fs.readFileSync(path.join(BENCH, "w3c.html"), "utf8");
const DOM = fs.readFileSync(path.join(BENCH, "dom.html"), "utf8");

/** Node.DOCUMENT_POSITION_FOLLOWING */
const DOCUMENT_POSITION_FOLLOWING = 4;

/** Selector lists copied from the production extractor. */
const SEL = {
  skipLinks: [
    'a[href^="#"][class*="skip-to-content" i]',
    'a[href^="#"][class*="skip-link" i]',
    'a[href^="#"][class*="skip-to-content-link" i]',
  ].join(","),
  main: ["main", 'div[role="main"]'].join(","),
  accessibility: [".icon__fallback-text", "button > .visually-hidden", "a > .visually-hidden"].join(","),
  scripts: ["script", "noscript", "style", "link"].join(","),
  shopify: [
    "#shopify-section-header, #shopify-section-footer",
    'section[data-section-type="header"], section[data-section-type="footer"]',
    ".shopify-section-group-header-group, .shopify-section-group-footer-group",
    ".shopify-section--header, .shopify-section--footer",
    '.shopify-section [class*="quantity"][class*="form"], .shopify-section [id*="quantity"][id*="form"]',
    '.shopify-section[class*="announcement-bar"], .shopify-section[id*="announcement-bar"], .shopify-section [class*="announcement-bar"], .shopify-section [id*="announcement-bar"]',
    '.shopify-section[class*="popular-products"], .shopify-section[id*="popular-products"], .shopify-section [class*="popular-products"], .shopify-section [id*="popular-products"]',
    '.shopify-section[class*="featured-products"], .shopify-section[id*="featured-products"], .shopify-section [class*="featured-products"], .shopify-section [id*="featured-products"]',
    '.shopify-section[class*="related-products"], .shopify-section[id*="related-products"], .shopify-section [class*="related-products"], .shopify-section [id*="related-products"]',
    '.shopify-section[class*="more-products"], .shopify-section[id*="more-products"], .shopify-section [class*="more-products"], .shopify-section [id*="more-products"]',
    '.shopify-section[class*="recommendations"], .shopify-section[id*="recommendations"], .shopify-section [class*="recommendations"], .shopify-section [id*="recommendations"]',
    '.shopify-section[class*="recently-viewed"], .shopify-section[id*="recently-viewed"], .shopify-section [class*="recently-viewed"], .shopify-section [id*="recently-viewed"]',
    '.shopify-section[class*="trending"], .shopify-section[id*="trending"], .shopify-section [class*="trending"], .shopify-section [id*="trending"]',
    '.shopify-section[class*="scrolling-promotion"], .shopify-section[id*="scrolling-promotion"], .shopify-section [class*="scrolling-promotion"], .shopify-section [id*="scrolling-promotion"]',
    '[class*="shopify-pc"],[id*="shopify-pc"]',
    ".jdgm-widget",
    "#looxReviews",
    ".loox-widget",
    ".loox-rating",
    '.shopify-block [style*="display:none"], .shopify-block [style*="display: none"]',
    '.shopify-app-block [style*="display:none"], .shopify-app-block [style*="display: none"]',
    '[class*="button--prev"], [class*="button--next"]',
    '[class*="announcement"]',
    '[class*="cart-drawer"], [id*="cart-drawer"]',
    "media-gallery, media-gallery-mobile",
    "cart-drawer",
    "product-gallery",
    "product-images",
    "product-form",
    "product-recommendations",
    "product-modal",
    "recently-viewed-products",
    "pickup-availability",
    "modal-opener",
  ].join(","),
  inputs: [
    "input",
    "textarea",
    "select",
    "option",
    "optgroup",
    "hidden",
    "form button",
    "form label",
    'form a[href="#"]',
    'form [style*="display:none"], form [style*="display: none"]',
  ].join(","),
  navigation: ["header:first-of-type", "sticky-header", "aside", "nav", "footer", "hr"].join(","),
  media: ["img", "picture", "video", "audio", "object", "embed", "canvas", "svg", "rss", "iframe"].join(","),
  dialogs: ["dialog", 'div[role="dialog"]', 'div[aria-modal="true"]'].join(","),
  templates: "template",
  sections: '[id*="shopify-section-template"]',
};

const removeAll = (element: any, selectors: string) => {
  element.querySelectorAll(selectors).forEach((el: any) => el.remove());
};

const removeJavaScriptLinks = (element: any) => {
  element.querySelectorAll("a").forEach((link: any) => {
    const href = link.getAttribute("href")?.trim();
    if (href === "javascript:history.go(-1)" || href === "javascript:void(0)") {
      link.remove();
      return;
    }
    if (href?.startsWith("javascript:")) link.replaceWith(...link.childNodes);
  });
};

const isContentElement = (element: any) => ["MAIN", "ARTICLE", "DIV", "SECTION"].includes(element.tagName);

const findClosestCommonAncestor = (a: any, b: any) => {
  const ancestors = new Set<any>();
  for (let current = a; current; current = current.parentElement) ancestors.add(current);
  for (let current = b; current; current = current.parentElement) if (ancestors.has(current)) return current;
  return null;
};

const getSkipLinkTarget = (document: any) => {
  const skipLinks = document.body.querySelectorAll(SEL.skipLinks);
  if (!skipLinks || skipLinks.length === 0) return null;
  const targets: Array<any> = [];
  skipLinks.forEach((link: any) => {
    if (!link.href) return;
    const target = document.body.querySelector(link.href);
    if (target && !targets.includes(target)) targets.push(target);
  });
  if (targets.length === 0) return null;
  if (targets.length === 1) return targets[0];
  for (const target of targets) {
    if (targets.some((other) => other !== target && target.contains(other))) return target;
  }
  return targets.find((target) => target.getAttribute("href")?.includes("#")) ?? targets[0];
};

const getMainContent = (document: any) => {
  const elements = Array.from(document.querySelectorAll(SEL.main)) as Array<any>;
  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0];
  for (const element of elements) {
    if (elements.some((other) => other !== element && element.contains(other))) return element;
  }
  return elements.find((element) => element.id) ?? elements[0];
};

const findMainElement = (document: any) => {
  const skip = getSkipLinkTarget(document);
  const main = getMainContent(document);
  let element: any = null;
  if (skip && main) {
    if (skip === main) element = skip;
    else if (skip.contains(main)) element = isContentElement(skip) ? skip : main;
    else if (main.contains(skip)) element = main;
    else {
      const ancestor = findClosestCommonAncestor(main, skip);
      element = ancestor && isContentElement(ancestor) ? ancestor : main;
    }
  } else if (skip && !main) {
    element = isContentElement(skip) ? skip : null;
  } else if (!skip && main) {
    element = main;
  }
  return element ?? document.body;
};

/** The whole extraction for one page. Returns the serialized content and where it came from. */
const extract = (lib: any, page: Page) => {
  const { document } = lib.parseHTML(page.html);
  let element = findMainElement(document);
  const mainTag = `${element.tagName}#${element.id}`;

  if (element !== document.body && SHOPIFY_PAGES_REGEX.test(page.url)) {
    const sections = Array.from(document.body.querySelectorAll(SEL.sections)) as Array<any>;
    const wrapper = document.createElement("div");
    let added = false;
    for (const section of sections) {
      const mainInSection = section.contains(element);
      const sectionInMain = element.contains(section);
      const same = section === element;
      if (!added && section.compareDocumentPosition(element) & DOCUMENT_POSITION_FOLLOWING) {
        wrapper.appendChild(element.cloneNode(true));
        added = true;
      }
      if (mainInSection || same) {
        wrapper.appendChild(section.cloneNode(true));
        added = true;
      } else if (!sectionInMain) {
        wrapper.appendChild(section.cloneNode(true));
      }
    }
    if (!added) wrapper.appendChild(element.cloneNode(true));
    element = wrapper;
  }

  removeAll(element, SEL.skipLinks);
  removeAll(element, SEL.accessibility);
  removeJavaScriptLinks(element);
  removeAll(element, SEL.scripts);
  removeAll(element, SEL.shopify);
  removeAll(element, SEL.inputs);
  removeAll(element, SEL.navigation);
  removeAll(element, SEL.media);
  removeAll(element, SEL.dialogs);
  removeAll(element, SEL.templates);

  const html: string = element.outerHTML;
  return { mainTag, html };
};

const crawl = (element: any, kind: "childNodes" | "children"): number => {
  const nodes = element[kind];
  const { length } = nodes;
  let count = length;
  for (let i = 0; i < length; i++) count += crawl(nodes[i], kind);
  return count;
};

/** Identity of a matched element, for guard samples. */
const tag = (el: any) => `${el.localName}#${el.getAttribute("id") ?? ""}.${el.getAttribute("class") ?? ""}`;
const listHash = (list: ArrayLike<any>) => `${list.length}:${fnv1a(Array.from(list, tag).join("|"))}`;

/** The sequence of `test/benchmark/content.js`, on one page. Returns the numbers it prints. */
const benchSequence = (lib: any, html: string) => {
  const document = new lib.DOMParser().parseFromString(html, "text/html");
  const root = document.documentElement;
  root.normalize();
  const childNodes = crawl(root, "childNodes");
  const children = crawl(root, "children");
  const clone1 = root.cloneNode(true).outerHTML.length;
  const divs = root.querySelectorAll("div").length;
  const ps = root.getElementsByTagName("p").length;
  root.querySelectorAll("div").forEach((div: any) => div.remove());
  const divsAfter = root.getElementsByTagName("div").length;
  const psAfter = root.getElementsByTagName("p").length;
  const clone2 = root.cloneNode(true).outerHTML;
  root.innerHTML = root.innerHTML;
  return [childNodes, children, clone1, divs, ps, divsAfter, psAfter, clone2.length, fnv1a(clone2), fnv1a(root.outerHTML)];
};

export function buildCases(lib: any): Array<PerfCase> {
  const cases: Array<PerfCase> = [];
  const parse = (html: string) => lib.parseHTML(html).document;

  /** Documents parsed once, for the cases that only read. */
  const shopDocs = PAGES.map((p) => parse(p.html));
  const domDoc = new lib.DOMParser().parseFromString(DOM, "text/html");
  const readDocs = [...shopDocs, domDoc];

  cases.push({
    name: "extract-pages",
    run: () => {
      for (const p of PAGES_URLS) extract(lib, p);
    },
    collect: () => PAGES_URLS.map((p) => {
      const r = extract(lib, p);
      return [p.name, r.mainTag, r.html.length, fnv1a(r.html)];
    }),
  });

  cases.push({
    name: "extract-products",
    run: () => {
      for (const p of OTHER_URLS) extract(lib, p);
    },
    collect: () => OTHER_URLS.map((p) => {
      const r = extract(lib, p);
      return [p.name, r.mainTag, r.html.length, fnv1a(r.html)];
    }),
  });

  cases.push({
    name: "parse-shop",
    run: () => {
      for (const p of PAGES) parse(p.html);
    },
    collect: () => PAGES.map((p) => {
      const out = parse(p.html).toString();
      return [p.name, out.length, fnv1a(out)];
    }),
  });

  cases.push({
    name: "parse-bench",
    run: () => {
      new lib.DOMParser().parseFromString(DOM, "text/html");
      new lib.DOMParser().parseFromString(W3C, "text/html");
    },
    collect: () => [DOM, W3C].map((h) => fnv1a(new lib.DOMParser().parseFromString(h, "text/html").toString())),
  });

  /** Every selector of the extractor, read-only, on the untouched documents. */
  const scraperQueries = [SEL.skipLinks, SEL.main, SEL.sections, SEL.accessibility, "a", SEL.scripts, SEL.shopify, SEL.inputs, SEL.navigation, SEL.media, SEL.dialogs, SEL.templates];
  cases.push({
    name: "query-scraper",
    run: () => {
      for (const d of shopDocs) for (const s of scraperQueries) d.body.querySelectorAll(s);
    },
    collect: () => shopDocs.map((d) => scraperQueries.map((s) => listHash(d.body.querySelectorAll(s)))),
  });

  cases.push({
    name: "query-first",
    run: () => {
      for (const d of shopDocs) {
        d.querySelector(SEL.main);
        d.querySelector("title");
        d.querySelector("rss, feed");
        d.querySelector('link[rel="stylesheet"], style');
        d.body.querySelector(".shopify-section");
      }
    },
    collect: () => shopDocs.map((d) => [SEL.main, "title", "rss, feed", 'link[rel="stylesheet"], style'].map((s) => {
      const el = d.querySelector(s);
      return el ? tag(el) : null;
    })),
  });

  cases.push({
    name: "query-simple",
    run: () => {
      for (const d of readDocs) {
        d.documentElement.querySelectorAll("div");
        d.documentElement.getElementsByTagName("p");
        d.documentElement.getElementsByClassName("shopify-section");
      }
    },
    collect: () => readDocs.map((d) => [
      listHash(d.documentElement.querySelectorAll("div")),
      listHash(d.documentElement.getElementsByTagName("p")),
      listHash(d.documentElement.getElementsByClassName("shopify-section")),
    ]),
  });

  /** Containment and document order between every template section and the main element. */
  const positionPairs = shopDocs.map((d) => ({
    main: findMainElement(d),
    sections: Array.from(d.body.querySelectorAll(SEL.sections)) as Array<any>,
    links: Array.from(d.body.querySelectorAll("a")) as Array<any>,
  }));
  cases.push({
    name: "contains-position",
    run: () => {
      for (const { main, sections, links } of positionPairs) {
        for (const s of sections) {
          s.contains(main);
          main.contains(s);
          s.compareDocumentPosition(main);
        }
        for (const a of links) {
          main.contains(a);
          a.compareDocumentPosition(main);
        }
      }
    },
    collect: () => positionPairs.map(({ main, sections, links }) => [
      sections.map((s) => [s.contains(main), main.contains(s), s.compareDocumentPosition(main)].join()).join("|"),
      fnv1a(links.map((a) => `${main.contains(a) ? 1 : 0}${a.compareDocumentPosition(main)}`).join()),
    ]),
  });

  cases.push({
    name: "clone-deep",
    run: () => {
      for (const d of readDocs) d.documentElement.cloneNode(true);
    },
    collect: () => readDocs.map((d) => fnv1a(d.documentElement.cloneNode(true).outerHTML)),
  });

  cases.push({
    name: "crawl",
    run: () => {
      for (const d of readDocs) {
        crawl(d.documentElement, "childNodes");
        crawl(d.documentElement, "children");
      }
    },
    collect: () => readDocs.map((d) => [crawl(d.documentElement, "childNodes"), crawl(d.documentElement, "children")]),
  });

  cases.push({
    name: "serialize",
    run: () => {
      for (const d of readDocs) d.documentElement.outerHTML;
    },
    collect: () => readDocs.map((d) => fnv1a(d.documentElement.outerHTML)),
  });

  cases.push({
    name: "text-content",
    run: () => {
      for (const d of shopDocs) {
        d.body.textContent;
        d.title;
      }
    },
    collect: () => shopDocs.map((d) => [fnv1a(d.body.textContent), d.title]),
  });

  cases.push({
    name: "bench-dom",
    run: () => {
      benchSequence(lib, DOM);
    },
    collect: () => benchSequence(lib, DOM),
  });

  cases.push({
    name: "bench-w3c",
    run: () => {
      benchSequence(lib, W3C);
    },
    collect: () => benchSequence(lib, W3C),
  });

  return cases;
}
