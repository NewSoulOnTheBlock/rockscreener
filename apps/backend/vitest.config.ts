import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /*
     * Node, not jsdom. Everything under test here is a pure function over
     * already-gathered facts — the scoring pillars and the entry/exit rules —
     * and none of it has ever seen a DOM.
     */
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
