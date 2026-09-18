// oxlint-disable-next-line import/no-namespace -- The named bench export only exists in Vitest 4.
import * as vitest from 'vite-plus/test';

type Benchmark = () => void | Promise<void>;

const bench = (name: string, fn: Benchmark) => {
  // Vitest 4 registers benchmarks at module scope; Vitest 5 runs them as test fixtures.
  if ('bench' in vitest && typeof vitest.bench === 'function') {
    vitest.bench(name, fn);
  } else {
    vitest.test(name, async (context) => {
      const { bench } = context as typeof context & {
        bench: (name: string, fn: Benchmark) => { run: () => Promise<unknown> };
      };
      await bench(name, fn).run();
    });
  }
};

export default bench;
