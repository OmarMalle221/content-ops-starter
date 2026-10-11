import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';
import { dfnTailwindPreset } from '@dfn/ui/src/tailwind-preset';

export default {
  presets: [dfnTailwindPreset as Partial<Config>],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  plugins: [animate],
} satisfies Config;
