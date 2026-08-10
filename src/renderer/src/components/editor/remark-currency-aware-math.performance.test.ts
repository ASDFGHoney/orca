import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { maskCurrencyDollars } from './remark-currency-aware-math'

type BenchmarkResult = { milliseconds: number; rssMegabytes: number }

const LOADER_SOURCE =
  "export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith('.'))return n(s+'.ts',c);throw e}}"
const CHILD_SOURCE = [
  "import { performance } from 'node:perf_hooks'",
  "import { unified } from 'unified'",
  "import remarkParse from 'remark-parse'",
  "import remarkGfm from 'remark-gfm'",
  "import { mathFromMarkdown } from 'mdast-util-math'",
  "import { math } from 'micromark-extension-math'",
  "import { remarkCurrencyAwareMath } from './src/renderer/src/components/editor/remark-currency-aware-math.ts'",
  'function stockMath(){const data=this.data();(data.micromarkExtensions??=[]).push(math());(data.fromMarkdownExtensions??=[]).push(mathFromMarkdown())}',
  "const plugin=process.env.BENCH_MODE==='candidate'?remarkCurrencyAwareMath:stockMath",
  'const parser=unified().use(remarkParse).use(remarkGfm).use(plugin).freeze()',
  'const size=Number(process.env.BENCH_SIZE)',
  "const chunk=process.env.BENCH_KIND==='hostile'?'cost $100 then $x$  ':'Math $1+2$ and $x$. '",
  'const source=chunk.repeat(Math.ceil(size/chunk.length)).slice(0,size)',
  'const start=performance.now()',
  'parser.runSync(parser.parse(source))',
  'process.stdout.write(JSON.stringify({milliseconds:performance.now()-start,rssMegabytes:process.memoryUsage().rss/1048576}))'
].join('\n')

function exactSize(chunk: string, size: number): string {
  return chunk.repeat(Math.ceil(size / chunk.length)).slice(0, size)
}

function benchmark(kind: string, mode: string, size: number): BenchmarkResult {
  const loader = `data:text/javascript,${encodeURIComponent(LOADER_SOURCE)}`
  const result = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-strip-types',
      `--experimental-loader=${loader}`,
      '--input-type=module',
      '-e',
      CHILD_SOURCE
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, BENCH_KIND: kind, BENCH_MODE: mode, BENCH_SIZE: String(size) },
      timeout: 10_000
    }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || `Benchmark exited with ${String(result.status)}`)
  }
  return JSON.parse(result.stdout) as BenchmarkResult
}

describe('currency-aware math performance', () => {
  it('keeps the mask linear across 80k, 160k, and 320k hostile inputs', () => {
    const chunk = 'cost $100 then $x$  '
    maskCurrencyDollars(chunk.repeat(100))
    const durations = [80_000, 160_000, 320_000].map((size) => {
      const source = exactSize(chunk, size)
      const start = performance.now()
      const masked = maskCurrencyDollars(source)
      const duration = performance.now() - start
      if (masked?.marker === null || masked?.marker === undefined) {
        throw new Error('Expected a private-use currency marker')
      }
      expect(masked.source).toHaveLength(source.length)
      expect(masked.source.match(new RegExp(masked.marker, 'gu'))).toHaveLength(size / 20)
      return duration
    })
    expect(durations[2]).toBeLessThan(durations[0] * 8 + 50)
    expect(durations[2]).toBeLessThan(500)
  })

  it('keeps full hostile and balanced parsing bounded against stock', { timeout: 30_000 }, () => {
    for (const kind of ['hostile', 'balanced']) {
      const candidate: BenchmarkResult[] = []
      const stock: BenchmarkResult[] = []
      for (const size of [80_000, 160_000, 320_000]) {
        candidate.push(benchmark(kind, 'candidate', size))
        stock.push(benchmark(kind, 'stock', size))
      }
      expect(candidate[2].milliseconds).toBeLessThan(candidate[0].milliseconds * 8 + 4_000)
      expect(candidate[2].milliseconds).toBeLessThan(stock[2].milliseconds * 3 + 500)
      expect(candidate[2].milliseconds).toBeLessThan(5_000)
      expect(candidate[2].rssMegabytes).toBeLessThan(600)
    }
  })
})
