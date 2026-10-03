#!/usr/bin/env bun
import { existsSync, mkdirSync, rmdirSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

type TestCase = { id: string; protects: string; prompt: string; pass: string }
type Result = {
  id: string; protects: string; pass: boolean; why: string; answer: string
  cost_usd: number; judge_cost_usd: number; ms: number; error?: string
}

const judgeSchema = JSON.stringify({
  type: 'object',
  properties: { pass: { type: 'boolean' }, why: { type: 'string' } },
  required: ['pass', 'why'],
})
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  key !== 'CLAUDECODE' && !key.startsWith('CLAUDE_CODE_')))
const activeChildren = new Set<{ kill(signal?: string | number): void }>()
let interrupted = false

const usage = `usage: bun run.ts [--repo <git dir>] [--cases <file>] [--ref <commit>] [--only id,id]
  [--sparse dir,dir] [--model <answer model>] [--judge-model <model>] [--concurrency N] [--out <dir>] [--keep]`

function options() {
  let repo = process.cwd()
  let cases = ''
  let ref = 'HEAD'
  let only: Set<string> | undefined
  let sparse: string[] = []
  let model = 'claude-opus-5-5'
  let judgeModel = 'haiku'
  let out = ''
  let concurrency = 4
  let keep = false
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0) }
    if (arg === '--keep') { keep = true; continue }
    if (['--repo', '--cases', '--ref', '--only', '--sparse', '--model', '--judge-model', '--out', '--concurrency'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      if (arg === '--repo') repo = resolve(value)
      if (arg === '--cases') cases = resolve(value)
      if (arg === '--ref') ref = value
      if (arg === '--sparse') sparse = value.split(',').map(p => p.trim()).filter(Boolean)
      if (arg === '--model') model = value
      if (arg === '--judge-model') judgeModel = value
      if (arg === '--out') out = resolve(value)
      if (arg === '--only') only = new Set(value.split(',').map(id => id.trim()).filter(Boolean))
      if (arg === '--concurrency') {
        concurrency = Number(value)
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
      }
      continue
    }
    throw new Error(`unknown argument: ${arg}\n${usage}`)
  }
  if (only?.size === 0) throw new Error('--only needs at least one id')
  return {
    repo, ref, only, sparse, model, judgeModel, concurrency, keep,
    cases: cases || join(repo, 'evals/cases.jsonl'),
    out: out || join(repo, 'evals/results'),
  }
}

async function command(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${args.join(' ')}: ${stderr.trim() || stdout.trim() || `exit ${code}`}`)
  return stdout.trim()
}

async function claude(args: string[], cwd: string) {
  const proc = Bun.spawn(args, { cwd, env: childEnv, stdout: 'pipe', stderr: 'pipe' })
  activeChildren.add(proc)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, 240_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ])
    if (timedOut) throw new Error('claude timed out after 240s')
    if (code !== 0) throw new Error(`claude exited ${code}: ${(stderr || stdout).trim().slice(-500)}`)
    let envelope: any
    try { envelope = JSON.parse(stdout) }
    catch { throw new Error(`invalid claude JSON: ${stdout.trim().slice(0, 300)}`) }
    if (envelope.is_error) throw new Error(`claude error: ${String(envelope.result ?? stderr).slice(0, 500)}`)
    return envelope
  } finally {
    clearTimeout(timer)
    activeChildren.delete(proc)
  }
}

function cost(envelope: any): number {
  const value = Number(envelope?.total_cost_usd)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

async function runCase(test: TestCase, worktree: string, model: string, judgeModel: string): Promise<Result> {
  const started = performance.now()
  let answer = ''
  let answerCost = 0
  let judgeCost = 0
  try {
    const response = await claude([
      'claude', '-p', '--model', model, '--output-format', 'json',
      '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence',
      `${test.prompt}\n\nAnswer in at most 4 lines. You may read files but take no other action.`,
    ], worktree)
    if (typeof response.result !== 'string') throw new Error('answer envelope has no result string')
    answer = response.result
    answerCost = cost(response)

    const judgePrompt = `You grade an AI assistant's answer against a pass criterion. Be strict about the criterion's key facts, lenient about wording. Question: ${test.prompt}\nPass criterion: ${test.pass}\nAnswer: ${answer}\nReturn pass and a one-sentence why.`
    const verdict = await claude([
      'claude', '-p', '--model', judgeModel, '--output-format', 'json', '--tools', '',
      '--strict-mcp-config', '--no-session-persistence', '--json-schema', judgeSchema,
      judgePrompt,
    ], tmpdir())
    judgeCost = cost(verdict)
    let grade = verdict.structured_output
    if (typeof grade?.pass !== 'boolean') {
      try { grade = JSON.parse(verdict.result) } catch { /* handled below */ }
    }
    if (typeof grade?.pass !== 'boolean') throw new Error('judge returned no boolean pass')
    return {
      id: test.id, protects: test.protects, pass: grade.pass,
      why: typeof grade.why === 'string' ? grade.why : 'Judge gave no reason',
      answer, cost_usd: answerCost, judge_cost_usd: judgeCost,
      ms: Math.round(performance.now() - started),
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    return {
      id: test.id, protects: test.protects, pass: false, why: error, answer,
      cost_usd: answerCost, judge_cost_usd: judgeCost,
      ms: Math.round(performance.now() - started), error,
    }
  }
}

async function main() {
  const { repo, cases: casesPath, out: resultsDir, ref, only, sparse, model, judgeModel, concurrency, keep } = options()
  const root = await command(['git', 'rev-parse', '--show-toplevel'], repo)
  const sha = await command(['git', 'rev-parse', '--verify', `${ref}^{commit}`], root)
  const short = sha.slice(0, 12)
  const base = join(tmpdir(), 'instruction-evals')
  const worktree = join(base, short)
  const seen = new Set<string>()
  const cases = (await Bun.file(casesPath).text())
    .split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return []
      let test: any
      try { test = JSON.parse(line) }
      catch { throw new Error(`${casesPath}:${index + 1}: invalid JSON`) }
      if (!test || ['id', 'protects', 'prompt', 'pass'].some(key => typeof test[key] !== 'string' || !test[key].trim())) {
        throw new Error(`${casesPath}:${index + 1}: id, protects, prompt, and pass must be nonempty strings`)
      }
      if (seen.has(test.id)) throw new Error(`${casesPath}:${index + 1}: duplicate id ${test.id}`)
      seen.add(test.id)
      return [test as TestCase]
    }).filter(test => !only || only.has(test.id))
  if (only) {
    const found = new Set(cases.map(test => test.id))
    const missing = [...only].filter(id => !found.has(id))
    if (missing.length) throw new Error(`unknown case id: ${missing.join(', ')}`)
  }
  if (!cases.length) throw new Error('no cases selected')

  // The fixed path can be reused after a completed run, but not by two runs at once.
  const lock = `${worktree}.lock`
  mkdirSync(base, { recursive: true })
  mkdirSync(lock)
  const priorWorktreeConfig = await command(['git', 'config', '--local', '--get', 'extensions.worktreeConfig'], root).catch(() => '')
  const onInterrupt = (signal: 'SIGINT' | 'SIGTERM') => {
    interrupted = true
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    for (const child of activeChildren) child.kill('SIGKILL')
  }
  const onSigint = () => onInterrupt('SIGINT')
  const onSigterm = () => onInterrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  let ready = false
  try {
    if (!existsSync(worktree)) {
      await command(['git', 'worktree', 'add', '--detach', '--no-checkout', worktree, sha], root)
    } else {
      const actual = await command(['git', 'rev-parse', 'HEAD'], worktree)
      if (actual !== sha) throw new Error(`existing worktree ${worktree} has ${actual}, expected ${sha}`)
    }
    ready = true
    // --sparse checks out root files plus the listed dirs, for large repos; default is the full tree.
    if (sparse.length) {
      await command(['git', 'sparse-checkout', 'init', '--cone'], worktree)
      await command(['git', 'sparse-checkout', 'set', ...sparse], worktree)
    }
    await command(['git', 'checkout', '--detach', sha], worktree)
    // The answering model can read files, so it must never see the pass criteria or past results.
    for (const hidden of [casesPath, resultsDir]) {
      const rel = relative(root, hidden)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(join(worktree, rel), { recursive: true, force: true })
    }

    const rows: Result[] = Array(cases.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (!interrupted && next < cases.length) {
        const index = next++
        const row = await runCase(cases[index], worktree, model, judgeModel)
        rows[index] = row
        console.log(`${row.error ? 'ERROR' : row.pass ? 'PASS' : 'FAIL'} ${row.id}  ${row.why.replace(/\s+/g, ' ')}`)
      }
    }))
    if (interrupted) return

    mkdirSync(resultsDir, { recursive: true })
    const now = new Date()
    let resultsPath = ''
    for (let minute = 0; ; minute++) {
      const date = new Date(now.getTime() + minute * 60_000)
      const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
      const candidate = join(resultsDir, `${stamp}-${short}.jsonl`)
      try {
        const file = await open(candidate, 'wx')
        try { await file.writeFile(rows.map(row => JSON.stringify(row)).join('\n') + '\n') }
        finally { await file.close() }
        resultsPath = candidate
        break
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    const errors = rows.filter(row => row.error).length
    const passes = rows.filter(row => row.pass).length
    const fails = rows.length - passes - errors
    const totalCost = rows.reduce((sum, row) => sum + row.cost_usd + row.judge_cost_usd, 0)
    console.log(`ref=${short} pass=${passes}/${rows.length} fail=${fails} error=${errors} cost=$${totalCost.toFixed(3)} results=${resultsPath}`)
    if (fails || errors) process.exitCode = 1
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    try {
      if (ready && !keep) await command(['git', 'worktree', 'remove', '--force', worktree], root)
    } catch (error) {
      console.error(`worktree cleanup: ${error instanceof Error ? error.message : error}`)
      process.exitCode = 1
    } finally {
      // sparse-checkout init enables this shared Git extension; restore its old value.
      const current = await command(['git', 'config', '--local', '--get', 'extensions.worktreeConfig'], root).catch(() => '')
      if (current !== priorWorktreeConfig) {
        if (priorWorktreeConfig) await command(['git', 'config', '--local', 'extensions.worktreeConfig', priorWorktreeConfig], root)
        else await command(['git', 'config', '--local', '--unset', 'extensions.worktreeConfig'], root)
      }
      rmdirSync(lock)
    }
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
