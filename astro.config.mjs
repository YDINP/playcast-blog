import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://virtual-in-playing.vercel.app',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/dashboard'),
    }),
  ],
  output: 'static',
  server: {
    host: '0.0.0.0',
  },
  build: {
    format: 'directory',
  },
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
    },
  },
});
