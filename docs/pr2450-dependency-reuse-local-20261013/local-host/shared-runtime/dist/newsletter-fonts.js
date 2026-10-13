"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWSLETTER_FONT_CATALOG = void 0;
exports.newsletterCatalogFont = newsletterCatalogFont;
exports.newsletterCatalogStyle = newsletterCatalogStyle;
exports.newsletterWebFontUrls = newsletterWebFontUrls;
exports.newsletterDesignFontRequests = newsletterDesignFontRequests;
const newsletter_fonts_catalog_js_1 = require("./newsletter-fonts.catalog.js");
/** The two default Brand Kit selections are retained alongside the rendered catalog. */
exports.NEWSLETTER_FONT_CATALOG = [
    ...newsletter_fonts_catalog_js_1.NEWSLETTER_FONT_RECORDS.map(([label, family, weight, italic]) => ({
        label,
        family,
        weight,
        italic,
    })),
    { label: 'DM Sans', family: 'DM Sans', weight: 400, italic: false },
    { label: 'Instrument Serif', family: 'Instrument Serif', weight: 400, italic: false },
];
const byLabel = new Map(exports.NEWSLETTER_FONT_CATALOG.map((font) => [font.label.toLowerCase(), font]));
const byFamily = new Map();
for (const font of exports.NEWSLETTER_FONT_CATALOG) {
    const key = font.family.toLowerCase(), current = byFamily.get(key);
    if (!current || (font.weight === 400 && !font.italic))
        byFamily.set(key, font);
}
function newsletterCatalogFont(value) {
    const label = value
        .split(',')[0]
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase();
    return byLabel.get(label) ?? byFamily.get(label);
}
function newsletterCatalogStyle(value) {
    const font = newsletterCatalogFont(value);
    return font
        ? {
            fontFamily: `'${font.family}', Arial, sans-serif`,
            fontWeight: font.weight,
            fontStyle: font.italic ? 'italic' : 'normal',
        }
        : undefined;
}
const systemFonts = new Set([
    'Arial',
    'Arial Black',
    'Comic Sans MS',
    'Courier',
    'Courier New',
    'Georgia',
    'Helvetica',
    'Impact',
    'Lucida Console',
    'Lucida Grande',
    'Lucida Sans Unicode',
    'Palatino Linotype',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
].map((name) => name.toLowerCase()));
/** Only known catalog families are sent to a fixed public stylesheet origin. */
function newsletterWebFontUrls(requests) {
    const groups = new Map();
    for (const request of requests) {
        const font = newsletterCatalogFont(request.value);
        if (!font || systemFonts.has(font.family.toLowerCase()))
            continue;
        const requestedWeight = request.weight ?? (request.bold === undefined ? font.weight : request.bold ? 700 : 400);
        const requestedItalic = request.italic ?? font.italic;
        // Use a real available face; the browser can synthesize unsupported emphasis.
        const variants = exports.NEWSLETTER_FONT_CATALOG.filter((item) => item.family === font.family);
        const face = variants.find((item) => item.weight === requestedWeight && item.italic === requestedItalic) ??
            font;
        const group = groups.get(font.family) ?? new Set();
        group.add(`${face.italic ? 1 : 0},${face.weight}`);
        groups.set(font.family, group);
    }
    return [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([family, faces]) => {
        const pairs = [...faces].sort((a, b) => {
            const [ai, aw] = a.split(',').map(Number), [bi, bw] = b.split(',').map(Number);
            return ai - bi || aw - bw;
        });
        const italic = pairs.some((pair) => pair.startsWith('1,'));
        const styles = italic ? pairs.join(';') : pairs.map((pair) => pair.split(',')[1]).join(';');
        return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${italic ? 'ital,wght' : 'wght'}@${styles}&display=swap`;
    });
}
/** Extract font settings, including inline rich text, without exposing message text. */
function newsletterDesignFontRequests(design) {
    const requests = [];
    const style = (value) => {
        if (value.fontFamily)
            requests.push({
                value: value.fontFamily,
                bold: value.bold,
                italic: value.italic,
                weight: value.fontWeight,
            });
    };
    const html = (markup) => {
        for (const match of markup.matchAll(/\bstyle="([^"]*)"/gi)) {
            const css = match[1].replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'");
            const family = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(css)?.[1];
            if (!family)
                continue;
            const weight = /(?:^|;)\s*font-weight\s*:\s*(\d+|bold|normal)/i.exec(css)?.[1];
            const italic = /(?:^|;)\s*font-style\s*:\s*(italic|normal)/i.exec(css)?.[1];
            requests.push({
                value: family,
                ...(weight
                    ? { weight: weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number(weight) }
                    : {}),
                ...(italic ? { italic: italic === 'italic' } : {}),
            });
        }
    };
    for (const value of Object.values(design.styles)) {
        if (value && typeof value === 'object') {
            if ('fontFamily' in value)
                style(value);
            else
                for (const nested of Object.values(value))
                    if (nested && typeof nested === 'object')
                        style(nested);
        }
    }
    const blocks = (items) => {
        for (const block of items) {
            style(block.style);
            style(block.mobileStyle);
            html(block.html);
            for (const column of block.columns)
                blocks(column);
        }
    };
    for (const section of design.sections) {
        style(section.style);
        blocks(section.blocks);
    }
    return requests;
}
//# sourceMappingURL=newsletter-fonts.js.map