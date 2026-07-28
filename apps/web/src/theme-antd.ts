import { theme, type ThemeConfig } from 'antd';

/*
 * The app's antd theme, extracted from main.tsx so the Phase 7 visual-parity
 * harness (src/parity/main.tsx) mounts the Strategy Planner under the SAME
 * tokens production does. antd's tokens reach the ported inline styles through
 * inherited font-family and line-height, so a harness with its own theme would
 * measure a surface that does not exist in production.
 *
 * Values are unchanged from the inline literal they replaced.
 */

// Brand palette - Capiro Brand Book.
const CAPIRO_BLUE = '#1c2e4a';
const CAPIRO_BLUE_DEEP = '#111f33';
const SIGNAL_BLUE = '#1c2e4a';
const SOFT_WHITE = '#F4F6F8';
const COOL_GRAY = '#6B7280';
const TEXT_PRIMARY = '#111827';
export const APP_FONT =
  "'Public Sans', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: CAPIRO_BLUE,
    colorText: TEXT_PRIMARY,
    colorTextSecondary: COOL_GRAY,
    fontFamily: APP_FONT,
  },
};

export const ANTD_THEME: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: CAPIRO_BLUE,
    colorLink: SIGNAL_BLUE,
    colorLinkHover: CAPIRO_BLUE,
    colorTextSecondary: COOL_GRAY,
    colorText: TEXT_PRIMARY,
    colorBgLayout: SOFT_WHITE,
    borderRadius: 10,
    fontFamily: APP_FONT,
    fontFamilyCode: "'JetBrains Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },
  components: {
    Typography: {
      titleMarginBottom: 0.5,
    },
    Menu: {
      // Sider menu is rendered with theme="dark" + the Capiro Blue background.
      // These tokens make the selected/hover states visible against that anchor
      // color rather than blending in.
      darkItemBg: CAPIRO_BLUE,
      darkItemSelectedBg: CAPIRO_BLUE_DEEP,
      darkSubMenuItemBg: CAPIRO_BLUE,
      darkItemHoverBg: 'rgba(255,255,255,0.06)',
      darkItemColor: 'rgba(255,255,255,0.78)',
      darkItemSelectedColor: '#ffffff',
      itemHeight: 44,
      itemMarginInline: 8,
      itemBorderRadius: 8,
    },
    Layout: {
      siderBg: CAPIRO_BLUE,
      triggerBg: CAPIRO_BLUE_DEEP,
    },
    Card: {
      borderRadiusLG: 14,
    },
    Input: {
      borderRadius: 10,
    },
    Select: {
      borderRadius: 10,
    },
    Button: {
      borderRadius: 10,
      fontWeight: 600,
    },
  },
};
