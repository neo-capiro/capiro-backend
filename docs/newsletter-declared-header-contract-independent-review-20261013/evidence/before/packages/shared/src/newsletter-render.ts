import {
  newsletterBlockVisible,
  newsletterDesignFonts,
  newsletterSocialPlatform,
  newsletterSocialSettings,
  type NewsletterSocialDevice,
  type NewsletterBlock,
  type NewsletterCampaignConfig,
  type NewsletterDesign,
  type NewsletterRecipient,
  type NewsletterStyle,
  type NewsletterFont,
} from './newsletter.js';
import {
  newsletterCatalogStyle,
  newsletterDesignFontRequests,
  newsletterWebFontUrls,
} from './newsletter-fonts.js';
import { newsletterSocialShareItems } from './newsletter-social-share.js';
export {
  newsletterSocialShareTarget,
  newsletterSocialShareUrl,
  newsletterSocialShareItems,
} from './newsletter-social-share.js';

export interface NewsletterRenderOptions {
  recipient?: NewsletterRecipient;
  liveMergeTags?: boolean;
  publicUrl?: string;
  archiveUrl?: string;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  sanitizeHtml?: (html: string) => string;
  rewriteLink?: (url: string, blockId: string) => string;
  surveyUrl?: (blockId: string, answer: string) => string;
  savedSurveyUrl?: (blockId: string) => string;
  editor?: boolean;
}
export function newsletterFontCss(fonts: NewsletterFont[]): string {
  return fonts
    .filter(
      (font) =>
        /^CapiroFont-[a-f\d-]{36}$/i.test(font.family) &&
        ['truetype', 'opentype', 'woff', 'woff2'].includes(font.format) &&
        /^https?:\/\//i.test(newsletterSafeUrl(font.url, true)),
    )
    .map(
      (font) =>
        `@font-face{font-family:'${font.family}';src:url('${newsletterCssUrl(font.url)}') format('${font.format}');font-display:swap;}`,
    )
    .join('');
}
export function newsletterEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
export function newsletterSafeUrl(raw: string, allowImage = false): string {
  const value = String(raw ?? '').trim();
  if (!allowImage && /^\*\|(?:ARCHIVE|UNSUB|UPDATE_PROFILE)\|\*$/.test(value)) return value;
  if ((!allowImage && /^#[a-z0-9_-]+$/i.test(value)) || /^\/newsletter\/[a-z0-9._-]+$/i.test(value))
    return value;
  if (allowImage && /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value))
    return value;
  if ((allowImage ? /^https?:\/\//i : /^(https?:\/\/|mailto:|tel:)/i).test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return '';
      return url.href;
    } catch {
      return '';
    }
  }
  return '';
}
export function newsletterStyleCss(style: NewsletterStyle): string {
  const css: string[] = [];
  const cornerNames = {
    radiusTopLeft: 'border-top-left-radius',
    radiusTopRight: 'border-top-right-radius',
    radiusBottomRight: 'border-bottom-right-radius',
    radiusBottomLeft: 'border-bottom-left-radius',
  } as const;
  const font = style.fontFamily ? newsletterCatalogStyle(style.fontFamily) : undefined;
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null) continue;
    if (key in cornerNames) continue;
    const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (
      ['background', 'color', 'borderColor'].includes(key) &&
      /^(#[a-f0-9]{3,8}|transparent)$/i.test(String(value))
    )
      css.push(`${name}:${value}`);
    else if (key === 'fontFamily' && /^[a-z0-9 ,'-]{1,100}$/i.test(String(value)))
      css.push(`font-family:${font?.fontFamily ?? value}`);
    else if (
      [
        'fontSize',
        'letterSpacing',
        'paragraphSpacing',
        'paddingTop',
        'paddingBottom',
        'paddingLeft',
        'paddingRight',
        'margin',
        'borderWidth',
        'radius',
        'height',
      ].includes(key) &&
      typeof value === 'number' &&
      Number.isFinite(value)
    )
      css.push(
        `${key === 'radius' ? 'border-radius' : key === 'paragraphSpacing' ? 'margin-bottom' : name}:${Math.max(0, Math.min(1000, value))}px`,
      );
    else if (key === 'width' && typeof value === 'number' && Number.isFinite(value))
      css.push(`width:${Math.max(1, Math.min(100, value))}%`);
    else if (key === 'lineHeight' && typeof value === 'number' && Number.isFinite(value))
      css.push(`line-height:${Math.max(0.5, Math.min(4, value))}`);
    else if (key === 'bold' || key === 'italic' || key === 'fontWeight') continue;
    else if (key === 'underline' || key === 'strike')
      css.push(
        `text-decoration:${value ? (key === 'strike' ? 'line-through' : 'underline') : 'none'}`,
      );
    else if (key === 'align' && ['left', 'center', 'right'].includes(String(value)))
      css.push(`text-align:${value}`);
    else if (key === 'direction' && ['ltr', 'rtl'].includes(String(value)))
      css.push(`direction:${value}`);
    else if (
      key === 'borderStyle' &&
      [
        'none',
        'solid',
        'dashed',
        'dotted',
        'double',
        'inset',
        'outset',
        'groove',
        'ridge',
      ].includes(String(value))
    )
      css.push(`border-style:${value}`);
  }
  for (const [key, name] of Object.entries(cornerNames)) {
    const value = style[key as keyof typeof cornerNames];
    if (typeof value === 'number' && Number.isFinite(value))
      css.push(`${name}:${Math.max(0, Math.min(1000, value))}px`);
  }
  const weight =
    typeof style.fontWeight === 'number' && Number.isFinite(style.fontWeight)
      ? Math.max(100, Math.min(900, Math.round(style.fontWeight)))
      : undefined;
  if (weight !== undefined || font || style.bold !== undefined)
    css.push(
      `font-weight:${weight ?? (style.bold === undefined ? font!.fontWeight : style.bold ? 700 : 400)}`,
    );
  if (font || style.italic !== undefined)
    css.push(
      `font-style:${style.italic === undefined ? font!.fontStyle : style.italic ? 'italic' : 'normal'}`,
    );
  return css.join(';');
}
export function newsletterBundledImageUrl(url: string) {
  return url.replace(
    /^\/newsletter\/(capitol|policy-desk|newsroom|social-update)\.svg$/,
    '/newsletter/$1.png',
  );
}
function newsletterCssUrl(raw: string) {
  return newsletterSafeUrl(raw, true).replace(
    /[()'"\\]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
export function newsletterMergeText(
  value: string,
  config: NewsletterCampaignConfig,
  options: NewsletterRenderOptions = {},
): string {
  if (!options.liveMergeTags) return value;
  const recipient = options.recipient;
  const fields: Record<string, string> = {
    FNAME: recipient?.firstName ?? 'Client',
    LNAME: recipient?.lastName ?? '',
    EMAIL: recipient?.email ?? 'client@example.com',
    COMPANY: recipient?.company ?? '',
    'LIST:COMPANY': config.company || config.fromName || 'Your firm',
    'HTML:LIST_ADDRESS': config.mailingAddress || 'Add your firm mailing address',
    'LIST:DESCRIPTION': config.permissionReminder,
    CURRENT_YEAR: String(new Date().getFullYear()),
    'MC:SUBJECT': config.subject,
    ARCHIVE: options.archiveUrl ?? '#archive',
    UNSUB: options.unsubscribeUrl ?? '#unsubscribe',
    UPDATE_PROFILE: options.preferencesUrl ?? '#preferences',
  };
  return value.replace(/\*\|([^|]+)\|\*/g, (match, field: string) => fields[field] ?? match);
}
export function newsletterSocialIconSize(size: NewsletterSocialDevice['size']) {
  return size === 'small' ? 24 : size === 'medium' ? 32 : 40;
}
function socialItemLayout(device: NewsletterSocialDevice, align: NewsletterStyle['align']) {
  return device.layout === 'horizontal'
    ? `display:inline-table;margin:0 ${device.spacing}px 0 0;vertical-align:middle`
    : `display:table;margin:0 ${align === 'right' ? '0' : 'auto'} ${device.spacing}px ${align === 'left' ? '0' : 'auto'};vertical-align:middle`;
}
function socialTextStyle(style: NewsletterStyle): NewsletterStyle {
  return Object.fromEntries(
    Object.entries(style).filter(([key]) =>
      [
        'color',
        'fontFamily',
        'fontSize',
        'fontWeight',
        'bold',
        'italic',
        'underline',
        'strike',
        'lineHeight',
        'letterSpacing',
        'direction',
      ].includes(key),
    ),
  );
}
export function renderNewsletterBlock(
  block: NewsletterBlock,
  design: NewsletterDesign,
  config: NewsletterCampaignConfig,
  options: NewsletterRenderOptions = {},
): string {
  if (!options.editor && !newsletterBlockVisible(block, options.recipient)) return '';
  const button = block.kind === 'button' || (block.kind === 'survey' && !!block.survey);
  const defaults =
    block.kind === 'heading'
      ? design.styles.text[`h${block.headingLevel}`]
      : block.kind === 'paragraph' ||
          block.kind === 'apps' ||
          block.kind === 'code' ||
          block.kind === 'footer'
        ? design.styles.text.p
        : button
          ? design.styles.button
          : block.kind === 'divider'
            ? design.styles.divider
            : block.kind === 'logo'
              ? design.styles.logo
              : block.kind === 'image'
                ? design.styles.image
                : {};
  const style = { ...defaults, ...block.style };
  const innerStyle = { ...style };
  if (!button) {
    delete innerStyle.paddingTop;
    delete innerStyle.paddingBottom;
    delete innerStyle.paddingLeft;
    delete innerStyle.paddingRight;
    delete innerStyle.margin;
  }
  const css = newsletterStyleCss(innerStyle);
  const text = (value: string) =>
    newsletterEscape(newsletterMergeText(value, config, options)).replace(/\n/g, '<br>');
  const link = (value: string) => {
    let url = newsletterSafeUrl(newsletterMergeText(value, config, options));
    if (url.startsWith('/newsletter/') && options.publicUrl)
      url = `${options.publicUrl.replace(/\/$/, '')}${url}`;
    return newsletterEscape(url ? (options.rewriteLink?.(url, block.id) ?? url) : '#');
  };
  const rich = (html: string) => {
    const merged = options.liveMergeTags
      ? html.replace(/\*\|[^|]+\|\*/g, (tag) =>
          newsletterEscape(newsletterMergeText(tag, config, options)),
        )
      : html;
    const safe = options.sanitizeHtml?.(merged) ?? text(merged);
    // Apply global link styling even in sanitized custom/rich-text fragments.
    return safe.replace(/<a\b([^>]*)>/gi, (_tag, attrs: string) => {
      const withoutStyle = attrs.replace(/\sstyle="[^"]*"/gi, '');
      return `<a${withoutStyle} style="${newsletterStyleCss(design.styles.link)}">`;
    });
  };
  const image = (url: string, alt: string, extra = '', wrapLink = true) => {
    let safe = newsletterBundledImageUrl(newsletterSafeUrl(url, true));
    if (safe.startsWith('/newsletter/') && options.publicUrl)
      safe = `${options.publicUrl.replace(/\/$/, '')}${safe}`;
    if (!safe)
      return `<div style="background:#eee;color:#666;padding:48px 12px;text-align:center;font-family:Arial">Add an image</div>`;
    const width =
      block.imageSize === 'scale'
        ? Math.max(1, Math.min(100, block.imageScale))
        : block.imageSize === 'original'
          ? 'auto'
          : 100;
    const crop = block.crop
      ? `object-fit:cover;object-position:${block.crop.x}% ${block.crop.y}%;aspect-ratio:${block.crop.width}/${block.crop.height};`
      : '';
    const alignment =
      style.align === 'center'
        ? 'margin-left:auto;margin-right:auto;'
        : style.align === 'right'
          ? 'margin-left:auto;margin-right:0;'
          : 'margin-left:0;margin-right:auto;';
    // Content sizing owns image width; inherited style.width must not override Scale or Original.
    const imageCss = newsletterStyleCss({ ...innerStyle, width: undefined });
    const result = `<img src="${newsletterEscape(safe)}" alt="${newsletterEscape(alt)}" style="max-width:100%;width:${width === 'auto' ? 'auto' : `${width}%`};display:block;border:0;${imageCss};${alignment}${crop}${extra}">`;
    return block.url && wrapLink
      ? `<a href="${link(block.url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ''}>${result}</a>`
      : result;
  };
  let content = '';
  switch (block.kind) {
    case 'heading':
      content = `<h${block.headingLevel} style="margin:0;${css}">${block.html ? rich(block.html) : text(block.text)}</h${block.headingLevel}>`;
      break;
    case 'paragraph':
      content = `<div style="${css}">${block.html ? rich(block.html) : text(block.text)}</div>`;
      break;
    case 'apps': {
      const app = block.app;
      if (!app?.sourceUrl || !app.title) {
        content = options.editor
          ? '<div style="padding:36px 16px;background:#f3f4f6;color:#374151;text-align:center;font-family:Arial">Select an app to add content</div>'
          : '';
        break;
      }
      const maxWidth = app.size === 'small' ? '240px' : app.size === 'medium' ? '400px' : '100%';
      const foreground =
        block.style.color || (app.showBackground ? '#1f2937' : style.color || '#1f2937');
      const cardCss = newsletterStyleCss({ ...innerStyle, color: foreground });
      const thumbnail =
        app.showImage && newsletterSafeUrl(app.imageUrl, true)
          ? `<img src="${newsletterEscape(newsletterSafeUrl(app.imageUrl, true))}" alt="${newsletterEscape(app.title)}" width="${app.size === 'small' ? 240 : app.size === 'medium' ? 400 : design.styles.width}" style="display:block;width:100%;max-width:100%;height:auto;border:0;margin:0 0 12px">`
          : '';
      content = `<a href="${newsletterEscape(newsletterSafeUrl(app.sourceUrl))}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ''} style="display:block;width:100%;max-width:${maxWidth};box-sizing:border-box;text-decoration:none;${cardCss};${app.showBackground ? `background:${block.style.background || '#f3f4f6'};padding:16px;` : ''}">${thumbnail}<div style="font-weight:bold;font-size:18px;line-height:1.4">${newsletterEscape(app.title)}</div>${app.showDescription && app.description ? `<p style="margin:8px 0 0;font-size:14px;line-height:1.5">${newsletterEscape(app.description)}</p>` : ''}</a>`;
      break;
    }
    case 'code':
      content = options.sanitizeHtml
        ? rich(block.html || block.text)
        : `<pre style="white-space:pre-wrap;${css}">${text(block.html || block.text)}</pre>`;
      break;
    case 'image':
      content = image(block.imageUrl, block.alt);
      break;
    case 'logo':
      content = block.imageUrl
        ? image(block.imageUrl, block.alt)
        : `<div style="${css}">${text(block.text || 'Your logo')}</div>`;
      break;
    case 'button':
      content = `<div style="text-align:${style.align ?? 'left'}"><a href="${link(block.url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ''} style="display:inline-block;text-decoration:none;${css}">${text(block.text)}</a></div>`;
      break;
    case 'divider':
      content = `<div style="border-top:${style.borderWidth ?? 1}px ${style.borderStyle ?? 'solid'} ${style.borderColor ?? '#777'};height:0"></div>`;
      break;
    case 'spacer':
      content = `<div style="height:${Math.max(0, Math.min(500, style.height ?? 24))}px;line-height:1px" aria-hidden="true">&nbsp;</div>`;
      break;
    case 'video':
      content = `<div style="${newsletterStyleCss({ background: style.background, align: style.align })}"><a href="${link(block.url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ''} style="display:block;color:${design.styles.link.color ?? '#fff'}">${block.imageUrl ? image(block.imageUrl, block.alt || 'Watch video', '', false) : `<div style="padding:36px;background:#333;text-align:center;font-size:36px" aria-label="Add video URL">&#9654;</div>`}${!block.video && block.text ? `<span>${text(block.text)}</span>` : ''}</a></div>`;
      break;
    case 'social':
      if (!block.social) {
        content = `<div style="${css}">${block.items.map((item) => `<a href="${link(item.url)}" style="color:${style.color ?? design.styles.link.color};display:inline-block;margin:0 12px">${text(item.label)}</a>`).join('')}</div>`;
        break;
      }
      {
        const settings = newsletterSocialSettings(block),
          size = newsletterSocialIconSize(settings.desktop.size);
        const share = settings.mode === 'share';
        const items = share ? newsletterSocialShareItems(block) : block.items;
        content = `<div style="${css};text-align:${style.align || 'center'}">${items
          .map((item, index) => {
            const platform = share
              ? item.platform || 'website'
              : newsletterSocialPlatform(item as NewsletterBlock['items'][number]);
            const iconUrl = `${options.publicUrl?.replace(/\/$/, '') || ''}/newsletter/social-${platform}-${settings.iconStyle}.png`;
            const target = block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : '';
            const icon =
              settings.display !== 'text'
                ? `<img class="nl-social-icon" src="${newsletterEscape(iconUrl)}" alt="${settings.display === 'icon' ? newsletterEscape(item.label || platform) : ''}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;width:${size}px;height:${size}px;border:0">`
                : '';
            const label =
              settings.display !== 'icon'
                ? `<span class="nl-social-label" style="padding-left:${icon ? 8 : 0}px;vertical-align:middle">${text(item.label || platform)}</span>`
                : '';
            const last = index === items.length - 1;
            const tag = share && !item.url ? 'span' : 'a';
            const destination =
              tag === 'a' ? ` href="${link(item.url)}"${target}` : ' aria-disabled="true"';
            return `<table role="presentation" cellpadding="0" cellspacing="0" class="nl-social-item${last ? ' nl-social-last' : ''}" style="${socialItemLayout(last ? { ...settings.desktop, spacing: 0 } : settings.desktop, style.align || 'center')}"><tr><td style="padding:0;vertical-align:middle"><${tag}${destination} style="${newsletterStyleCss(socialTextStyle(style))};color:${style.color || design.styles.link.color};text-decoration:none">${icon}${label}</${tag}></td></tr></table>`;
          })
          .join('')}</div>`;
      }
      break;
    case 'survey':
      if (block.survey) {
        const url = block.survey.saved
          ? newsletterSafeUrl(options.savedSurveyUrl?.(block.id) || '')
          : '';
        const tag = url ? 'a' : 'span';
        content = `<div style="text-align:${style.align || 'center'};padding:12px 0;${block.survey.blockBackground ? `background:${block.survey.blockBackground};` : ''}"><${tag}${url ? ` href="${link(url)}"${block.openNewTab ? ' target="_blank" rel="noopener noreferrer"' : ''}` : ' aria-disabled="true"'} style="display:inline-block;text-decoration:none;${css}">${text(block.text || 'Start Survey')}</${tag}></div>`;
        break;
      }
      content = `<div style="${css}"><p>${text(block.question)}</p>${block.options.map((answer) => `<a href="${newsletterEscape(options.surveyUrl?.(block.id, answer) ?? (newsletterSafeUrl(block.url) || '#'))}" style="display:block;padding:10px;margin:6px 0;border:1px solid #777;color:inherit">${text(answer)}</a>`).join('')}</div>`;
      break;
    case 'product':
    case 'product-rec':
      content = `<table role="presentation" width="100%"><tr>${block.items.map((item) => `<td valign="top" style="padding:8px;width:${100 / Math.max(1, block.items.length)}%;${css}">${item.imageUrl ? image(item.imageUrl, item.label) : ''}<h3>${text(item.label)}</h3><p>${text(item.description ?? '')}</p><p>${text(item.price ?? '')}</p><a href="${link(item.url)}" style="color:inherit">${text(block.text || 'Learn more')}</a></td>`).join('')}</tr></table>`;
      break;
    case 'columns': {
      const ratio = block.ratio.includes(':')
        ? block.ratio.split(':').map(Number)
        : block.columns.map(() => 1);
      const sum = ratio.reduce((a, b) => a + b, 0) || block.columns.length;
      content = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${block.columns.map((column, index) => `<td class="${block.mobileOrientation === 'stacked' ? 'nl-column' : ''}" valign="top" width="${((ratio[index] ?? 1) / sum) * 100}%" style="padding:${index ? '0 0 0 16px' : '0 16px 0 0'};${css}">${column.map((child) => renderNewsletterBlock(child, design, config, options)).join('')}</td>`).join('')}</tr></table>`;
      break;
    }
    case 'footer':
      content = `<div style="${css}"><p>Copyright &copy; ${new Date().getFullYear()} ${text(config.company || '*|LIST:COMPANY|*')}. All rights reserved.</p><p>${text(config.permissionReminder)}</p><p>Our mailing address is:<br>${text(config.mailingAddress || '*|HTML:LIST_ADDRESS|*')}</p><p>Want to change how you receive these emails?</p><p>You can <a href="${link(options.preferencesUrl ?? '*|UPDATE_PROFILE|*')}" style="color:inherit">update your preferences</a> or <a href="${link(options.unsubscribeUrl ?? '*|UNSUB|*')}" style="color:inherit">unsubscribe</a>.</p></div>`;
      break;
  }
  // Button padding belongs inside the clickable shape. Other blocks apply
  // padding once on their wrapper, including global image/divider spacing.
  const spacing = button ? {} : style;
  const savedSurvey = block.kind === 'survey' && !!block.survey;
  return `<div id="${newsletterEscape(block.id)}" class="nl-block-${newsletterEscape(block.id)}" style="padding:${savedSurvey ? 0 : (spacing.paddingTop ?? 12)}px ${spacing.paddingRight ?? 0}px ${savedSurvey ? 0 : (spacing.paddingBottom ?? 12)}px ${spacing.paddingLeft ?? 0}px;${spacing.margin ? `margin:${spacing.margin}px;` : ''}${block.visibility.mode === 'custom' && options.editor ? 'opacity:.65;' : ''}">${content}</div>`;
}
export function renderNewsletterDesign(
  design: NewsletterDesign,
  config: NewsletterCampaignConfig,
  options: NewsletterRenderOptions = {},
): string {
  const styles = design.styles;
  const mobileRules: string[] = [];
  const important = (style: NewsletterStyle) =>
    newsletterStyleCss(style)
      .split(';')
      .filter(Boolean)
      .map((rule) => `${rule}!important`)
      .join(';');
  const walk = (blocks: NewsletterBlock[]) => {
    for (const block of blocks) {
      const button = block.kind === 'button' || (block.kind === 'survey' && !!block.survey);
      if (block.kind === 'social' && block.social && !block.linkedStyles) {
        const device = block.social.mobile,
          size = newsletterSocialIconSize(device.size);
        const alignment = block.mobileStyle.align || block.style.align || 'center';
        const css = socialItemLayout(device, alignment)
          .split(';')
          .filter(Boolean)
          .map((value) => `${value}!important`)
          .join(';');
        mobileRules.push(
          `.nl-block-${block.id} .nl-social-item{${css}}.nl-block-${block.id} .nl-social-last{${device.layout === 'horizontal' ? 'margin-right:0' : 'margin-bottom:0'}!important}.nl-block-${block.id} .nl-social-icon{width:${size}px!important;height:${size}px!important}`,
        );
        const textCss = important(socialTextStyle(block.mobileStyle));
        if (textCss) mobileRules.push(`.nl-block-${block.id} .nl-social-item a{${textCss}}`);
      }
      const key =
        block.kind === 'heading'
          ? (`h${block.headingLevel}` as 'h1')
          : ['paragraph', 'apps', 'code', 'footer'].includes(block.kind)
            ? 'p'
            : null;
      const global = !styles.linkedStyles
        ? key
          ? styles.mobileText[key]
          : button
            ? styles.mobileButton
            : block.kind === 'divider'
              ? styles.mobileDivider
              : block.kind === 'image'
                ? styles.mobileImage
                : block.kind === 'logo'
                  ? styles.mobileLogo
                  : {}
        : {};
      const mobile = { ...global, ...(!block.linkedStyles ? block.mobileStyle : {}) };
      if (block.kind === 'apps' && block.app?.showBackground && mobile.color) {
        mobile.color =
          (!block.linkedStyles && block.mobileStyle.color) || block.style.color || '#1f2937';
      }
      if (Object.keys(mobile).length) {
        const inner = { ...mobile };
        if (['image', 'logo', 'video'].includes(block.kind)) delete inner.width;
        const spacing: NewsletterStyle = {};
        if (!button) {
          for (const key of [
            'paddingTop',
            'paddingBottom',
            'paddingLeft',
            'paddingRight',
            'margin',
          ] as const) {
            if (inner[key] !== undefined) spacing[key] = inner[key];
            delete inner[key];
          }
        }
        if (Object.keys(spacing).length)
          mobileRules.push(`.nl-block-${block.id}{${important(spacing)}}`);
        let declarations = important(inner);
        if (block.kind === 'divider')
          declarations = declarations.replace(/border-(width|style|color):/g, 'border-top-$1:');
        const selector =
          block.kind === 'survey' && block.survey
            ? `.nl-block-${block.id}>div>a,.nl-block-${block.id}>div>span`
            : button
              ? `.nl-block-${block.id}>div>a`
              : block.kind === 'image'
                ? `.nl-block-${block.id} img`
                : `.nl-block-${block.id}>*`;
        if (declarations) mobileRules.push(`${selector}{${declarations}}`);
        if (block.kind === 'survey' && block.survey && mobile.align)
          mobileRules.push(`.nl-block-${block.id}>div{text-align:${mobile.align}!important}`);
        if (['image', 'logo'].includes(block.kind) && mobile.align) {
          const alignment =
            mobile.align === 'center'
              ? 'margin-left:auto!important;margin-right:auto!important'
              : mobile.align === 'right'
                ? 'margin-left:auto!important;margin-right:0!important'
                : 'margin-left:0!important;margin-right:auto!important';
          mobileRules.push(`.nl-block-${block.id} img{${alignment}}`);
        }
      }
      for (const column of block.columns) walk(column);
    }
  };
  design.sections.forEach((section) => walk(section.blocks));
  const webFonts = newsletterWebFontUrls(newsletterDesignFontRequests(design))
    .map(
      (url) =>
        `<link rel="stylesheet" href="${newsletterEscape(url)}" referrerpolicy="no-referrer">`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${newsletterEscape(config.subject || 'Weekly newsletter')}</title>${webFonts}<style>${newsletterFontCss(newsletterDesignFonts(design))}body{margin:0}table{border-collapse:collapse}a{color:${styles.link.color ?? '#fff'}}p{margin:0 0 12px}@media(max-width:600px){.nl-shell{width:100%!important}.nl-padding{padding:${styles.mobilePadding}px!important}.nl-column{display:block!important;width:100%!important;padding:0!important}h1{font-size:32px!important}h2{font-size:26px!important}${mobileRules.join('')}}</style></head><body style="background:${styles.background};${styles.backgroundImage ? `background-image:url('${newsletterEscape(newsletterCssUrl(styles.backgroundImage))}');` : ''}"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${newsletterEscape(config.previewText)}</div><table role="presentation" width="100%"><tr><td align="center"><table class="nl-shell" role="presentation" width="${styles.width}" style="width:${styles.width}px;max-width:100%;background:${styles.content}"><tr><td class="nl-padding" style="padding:24px">${design.sections.map((section) => `<section id="${newsletterEscape(section.id)}" style="${newsletterStyleCss(section.style)}">${section.blocks.map((block) => renderNewsletterBlock(block, design, config, options)).join('')}</section>`).join('')}</td></tr></table></td></tr></table></body></html>`;
}
export function newsletterPlainText(
  design: NewsletterDesign,
  config: NewsletterCampaignConfig,
  options: NewsletterRenderOptions = {},
): string {
  const paragraphs: string[] = [];
  const push = (value: string, literal = false) =>
    paragraphs.push(literal ? value : newsletterMergeText(value, config, options));
  const walk = (blocks: NewsletterBlock[]) => {
    for (const block of blocks) {
      if (!newsletterBlockVisible(block, options.recipient)) continue;
      if (block.kind === 'columns') block.columns.forEach(walk);
      else if (block.kind === 'footer')
        push(
          `${config.company}\n${config.permissionReminder}\n${config.mailingAddress}\nUpdate preferences: ${options.preferencesUrl ?? '*|UPDATE_PROFILE|*'}\nUnsubscribe: ${options.unsubscribeUrl ?? '*|UNSUB|*'}`,
        );
      else if (block.kind === 'apps' && block.app?.sourceUrl) {
        push(
          `${block.app.title}${block.app.showDescription ? `\n${block.app.description}` : ''}\n${block.app.sourceUrl}`,
          true,
        );
      } else if (block.kind === 'social' && block.social?.mode === 'share') {
        for (const item of newsletterSocialShareItems(block))
          if (item.url) push(`${item.label || 'Share'}\n${item.url}`);
      } else if (block.kind === 'video' && block.video) {
        push(`${block.alt || 'Watch video'}${block.url ? `\n${block.url}` : ''}`);
      } else if (block.kind === 'survey' && block.survey) {
        const url = block.survey.saved
          ? newsletterSafeUrl(options.savedSurveyUrl?.(block.id) || '')
          : '';
        push(`${block.text || 'Start Survey'}${url ? `\n${url}` : ''}`);
      } else {
        const text = block.html
          ? block.html
              .replace(/<[^>]*>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
          : block.text;
        if (text) push(text + (block.url ? `\n${block.url}` : ''));
        for (const item of block.items)
          push(`${item.label}\n${item.description ?? ''}\n${item.url}`);
      }
    }
  };
  design.sections.forEach((section) => walk(section.blocks));
  return paragraphs.join('\n\n');
}
