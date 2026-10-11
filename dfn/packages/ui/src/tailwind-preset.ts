/**
 * Design tokens of Diaspora Trust. Minimal, premium, reassuring.
 * Primary: deep teal (trust) — Accent: warm gold (diaspora / value) — Neutrals: warm greys.
 */
export const dfnTailwindPreset = {
  darkMode: 'class' as const,
  theme: {
    container: { center: true, padding: '1.5rem', screens: { '2xl': '1280px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        success: { DEFAULT: 'hsl(var(--success))', foreground: 'hsl(var(--success-foreground))' },
        warning: { DEFAULT: 'hsl(var(--warning))', foreground: 'hsl(var(--warning-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        sandbox: { DEFAULT: 'hsl(var(--sandbox))', foreground: 'hsl(var(--sandbox-foreground))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
      },
      fontFamily: { sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      boxShadow: { soft: '0 1px 2px rgba(16, 24, 40, 0.04), 0 8px 24px -12px rgba(16, 24, 40, 0.12)' },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: { 'fade-in': 'fade-in 0.25s ease-out' },
    },
  },
};

export const dfnCssVariables = `
:root {
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --background: 40 20% 98%;
  --foreground: 200 30% 12%;
  --card: 0 0% 100%;
  --card-foreground: 200 30% 12%;
  --popover: 0 0% 100%;
  --popover-foreground: 200 30% 12%;
  --primary: 188 68% 24%;
  --primary-foreground: 0 0% 100%;
  --secondary: 40 25% 94%;
  --secondary-foreground: 200 30% 18%;
  --accent: 38 85% 52%;
  --accent-foreground: 30 40% 12%;
  --muted: 40 15% 94%;
  --muted-foreground: 200 10% 42%;
  --destructive: 0 72% 46%;
  --destructive-foreground: 0 0% 100%;
  --success: 152 55% 34%;
  --success-foreground: 0 0% 100%;
  --warning: 32 92% 46%;
  --warning-foreground: 0 0% 100%;
  --sandbox: 262 60% 40%;
  --sandbox-foreground: 0 0% 100%;
  --border: 40 15% 88%;
  --input: 40 15% 86%;
  --ring: 188 68% 32%;
  --radius: 0.75rem;
}
.dark {
  --background: 200 30% 7%;
  --foreground: 40 20% 96%;
  --card: 200 28% 10%;
  --card-foreground: 40 20% 96%;
  --popover: 200 28% 10%;
  --popover-foreground: 40 20% 96%;
  --primary: 180 55% 45%;
  --primary-foreground: 200 30% 8%;
  --secondary: 200 20% 16%;
  --secondary-foreground: 40 20% 96%;
  --accent: 38 85% 56%;
  --accent-foreground: 30 40% 10%;
  --muted: 200 20% 16%;
  --muted-foreground: 200 10% 65%;
  --destructive: 0 62% 50%;
  --destructive-foreground: 0 0% 100%;
  --success: 152 50% 42%;
  --success-foreground: 0 0% 100%;
  --warning: 32 90% 55%;
  --warning-foreground: 0 0% 0%;
  --sandbox: 262 60% 60%;
  --sandbox-foreground: 0 0% 100%;
  --border: 200 20% 20%;
  --input: 200 20% 22%;
  --ring: 180 55% 45%;
}
`;
