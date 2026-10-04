import React from 'react';

/**
 * Lightweight inline-SVG icon set (no external dependency). Every icon inherits the current
 * text color via `currentColor` and is sized with the `size` prop (default 18px). These are
 * purely presentational — used for the professional UI shell (brand mark, section headers,
 * status chips, and the published-dashboard empty state).
 */
export interface IconProps {
  size?: number;
  className?: string;
  'aria-hidden'?: boolean;
}

function svgProps(size: number, className?: string): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    'aria-hidden': true,
    focusable: false,
  };
}

/** Brand logo mark — a small analytics "spark" tile (filled, uses currentColor). */
export function LogoMark({ size = 26, className }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden
      focusable={false}
    >
      <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" opacity="0.12" />
      <rect x="6" y="12" width="2.8" height="6" rx="1.2" fill="currentColor" />
      <rect x="10.6" y="8.5" width="2.8" height="9.5" rx="1.2" fill="currentColor" />
      <rect x="15.2" y="6" width="2.8" height="12" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function Lock({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Database({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
      <path d="M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6" />
    </svg>
  );
}

export function Document({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 15.5h6M9 8.5h2" />
    </svg>
  );
}

export function User({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </svg>
  );
}

export function Check({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function CheckCircle({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.2l2.6 2.6L16 9.5" />
    </svg>
  );
}

export function ExternalLink({ size = 16, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-10A1.5 1.5 0 0 1 5 18.5v-10A1.5 1.5 0 0 1 6.5 7H11" />
    </svg>
  );
}

export function BarChart({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 20h16" />
      <rect x="6" y="11" width="3" height="6" rx="1" fill="currentColor" stroke="none" />
      <rect x="11" y="7" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
      <rect x="16" y="13" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Shield({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3l7 3v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function Eye({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOff({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.6A9.3 9.3 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.6" />
      <path d="M6.5 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9.2 9.2 0 0 0 3.4-.6" />
      <path d="M9.5 9.6a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

export function Clock({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function Cloud({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M7 18h10a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.6 9.4 3.8 3.8 0 0 0 7 18z" />
    </svg>
  );
}

export function Sparkles({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
      <path d="M18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

export function UserPlus({ size = 18, className }: IconProps): React.ReactElement {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="9.5" cy="8" r="3.3" />
      <path d="M3.5 20c0-3.4 2.9-5.6 6-5.6 1.2 0 2.3.3 3.2.9" />
      <path d="M17.5 13.5v5M15 16h5" />
    </svg>
  );
}

export function Quote({ size = 28, className }: IconProps): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden focusable={false}>
      <path d="M9.3 6.5c-2.9 1.1-4.8 3.7-4.8 6.9 0 2.5 1.5 4.1 3.6 4.1 1.8 0 3.2-1.3 3.2-3.1 0-1.7-1.2-3-2.9-3-.3 0-.7 0-.9.1.3-1.3 1.6-2.7 3.3-3.4zm8.4 0c-2.9 1.1-4.8 3.7-4.8 6.9 0 2.5 1.5 4.1 3.6 4.1 1.8 0 3.2-1.3 3.2-3.1 0-1.7-1.2-3-2.9-3-.3 0-.7 0-.9.1.3-1.3 1.6-2.7 3.3-3.4z" />
    </svg>
  );
}

/**
 * Hero illustration for the login page: a stylized browser window with a bar + line chart and
 * a small analytics mark. Uses currentColor so it tints with `--brand`. (Generic chart motif —
 * not the Tableau trademark.)
 */
export function HeroIllustration({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 360 240" className={className} fill="none" aria-hidden focusable={false}>
      <defs>
        <linearGradient id="heroWin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.03" />
        </linearGradient>
      </defs>
      {/* window */}
      <rect x="40" y="36" width="280" height="168" rx="16" fill="#fff" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <rect x="40" y="36" width="280" height="30" rx="16" fill="url(#heroWin)" />
      <circle cx="58" cy="51" r="4" fill="currentColor" opacity="0.5" />
      <circle cx="72" cy="51" r="4" fill="currentColor" opacity="0.32" />
      <circle cx="86" cy="51" r="4" fill="currentColor" opacity="0.2" />
      {/* analytics mark */}
      <g transform="translate(120 92)">
        <rect x="-6" y="-6" width="52" height="52" rx="10" fill="currentColor" opacity="0.08" />
        <rect x="4" y="22" width="6" height="14" rx="2" fill="currentColor" />
        <rect x="17" y="12" width="6" height="24" rx="2" fill="currentColor" opacity="0.75" />
        <rect x="30" y="18" width="6" height="18" rx="2" fill="currentColor" opacity="0.55" />
      </g>
      {/* bars */}
      <rect x="196" y="150" width="14" height="30" rx="3" fill="currentColor" opacity="0.5" />
      <rect x="216" y="130" width="14" height="50" rx="3" fill="currentColor" opacity="0.7" />
      <rect x="236" y="158" width="14" height="22" rx="3" fill="currentColor" opacity="0.5" />
      <rect x="256" y="116" width="14" height="64" rx="3" fill="currentColor" />
      {/* trend line */}
      <path d="M196 120 L223 104 L250 112 L277 86" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx="277" cy="86" r="3.5" fill="currentColor" />
      {/* left lines */}
      <rect x="196" y="92" width="74" height="7" rx="3.5" fill="currentColor" opacity="0.14" />
      <rect x="196" y="104" width="52" height="7" rx="3.5" fill="currentColor" opacity="0.1" />
    </svg>
  );
}

/**
 * Empty-state illustration for the published-dashboard pane: a stylized browser window with
 * a small bar + line chart. Uses currentColor so it tints with `--brand`.
 */
export function EmptyDashboard({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 320 200"
      className={className}
      fill="none"
      aria-hidden
      focusable={false}
    >
      <rect x="8" y="8" width="304" height="184" rx="14" fill="currentColor" opacity="0.06" />
      <rect x="8.75" y="8.75" width="302.5" height="182.5" rx="13.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      {/* window chrome */}
      <path d="M8 30h304" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <circle cx="26" cy="19" r="3.5" fill="currentColor" opacity="0.45" />
      <circle cx="38" cy="19" r="3.5" fill="currentColor" opacity="0.3" />
      <circle cx="50" cy="19" r="3.5" fill="currentColor" opacity="0.2" />
      {/* left text lines */}
      <rect x="28" y="52" width="86" height="8" rx="4" fill="currentColor" opacity="0.18" />
      <rect x="28" y="70" width="64" height="8" rx="4" fill="currentColor" opacity="0.12" />
      <rect x="28" y="104" width="86" height="56" rx="8" fill="currentColor" opacity="0.1" />
      {/* bars */}
      <rect x="150" y="120" width="16" height="40" rx="3" fill="currentColor" opacity="0.5" />
      <rect x="174" y="100" width="16" height="60" rx="3" fill="currentColor" opacity="0.7" />
      <rect x="198" y="128" width="16" height="32" rx="3" fill="currentColor" opacity="0.5" />
      <rect x="222" y="86" width="16" height="74" rx="3" fill="currentColor" />
      {/* trend line */}
      <path d="M150 92 L178 74 L206 84 L234 58 L266 66" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
      <circle cx="266" cy="66" r="3.5" fill="currentColor" />
    </svg>
  );
}
