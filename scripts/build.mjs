#!/usr/bin/env node
/**
 * build.mjs — Best-effort build of Claude Code v2.1.88 from source
 *
 * ⚠️  IMPORTANT: A complete rebuild requires the Bun runtime's compile-time
 *     intrinsics (feature(), MACRO, bun:bundle). This script provides a
 *     best-effort build using esbuild. See KNOWN_ISSUES.md for details.
 *
 * What this script does:
 *   1. Copy src/ → build-src/ (original untouched)
 *   2. Replace `feature('X')` → `false`  (compile-time → runtime)
 *   3. Replace `MACRO.VERSION` etc → string literals
 *   4. Replace `import from 'bun:bundle'` → stub
 *   5. Create stubs for missing feature-gated modules
 *   6. Bundle with esbuild → dist/cli.js
 *
 * Requirements: Node.js >= 18, npm
 * Usage:       node scripts/build.mjs
 */

import { readdir, readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const VERSION = '2.1.88'
const BUILD = join(ROOT, 'build-src')
const ENTRY = join(BUILD, 'entry.ts')

// ── Helpers ────────────────────────────────────────────────────────────────

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory() && e.name !== 'node_modules') yield* walk(p)
    else yield p
  }
}

async function exists(p) { try { await stat(p); return true } catch { return false } }

async function ensureEsbuild() {
  try { execSync('npx esbuild --version', { stdio: 'pipe' }) }
  catch {
    console.log('📦 Installing esbuild...')
    execSync('npm install --save-dev esbuild', { cwd: ROOT, stdio: 'inherit' })
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1: Copy source
// ══════════════════════════════════════════════════════════════════════════════

await rm(BUILD, { recursive: true, force: true })
await mkdir(BUILD, { recursive: true })
await cp(join(ROOT, 'src'), join(BUILD, 'src'), { recursive: true })
// Also copy stubs/ so that relative imports like '../stubs/bun-bundle.js'
// from build-src/src/ can be resolved at build-src/stubs/
await cp(join(ROOT, 'stubs'), join(BUILD, 'stubs'), { recursive: true })
console.log('✅ Phase 1: Copied src/ → build-src/ and stubs/ → build-src/stubs/')

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2: Transform source
// ══════════════════════════════════════════════════════════════════════════════

let transformCount = 0

// MACRO replacements
const MACROS = {
  'MACRO.VERSION': `'${VERSION}'`,
  'MACRO.BUILD_TIME': `''`,
  'MACRO.FEEDBACK_CHANNEL': `'https://github.com/anthropics/claude-code/issues'`,
  'MACRO.ISSUES_EXPLAINER': `'https://github.com/anthropics/claude-code/issues/new/choose'`,
  'MACRO.FEEDBACK_CHANNEL_URL': `'https://github.com/anthropics/claude-code/issues'`,
  'MACRO.ISSUES_EXPLAINER_URL': `'https://github.com/anthropics/claude-code/issues/new/choose'`,
  'MACRO.NATIVE_PACKAGE_URL': `'@anthropic-ai/claude-code'`,
  'MACRO.PACKAGE_URL': `'@anthropic-ai/claude-code'`,
  'MACRO.VERSION_CHANGELOG': `''`,
}

for await (const file of walk(join(BUILD, 'src'))) {
  if (!file.match(/\.[tj]sx?$/)) continue

  let src = await readFile(file, 'utf8')
  let changed = false

  // 2a. feature('X') → false
  if (/\bfeature\s*\(\s*['"][A-Z_]+['"]\s*\)/.test(src)) {
    src = src.replace(/\bfeature\s*\(\s*['"][A-Z_]+['"]\s*\)/g, 'false')
    changed = true
  }

  // 2b. MACRO.X → literals
  for (const [k, v] of Object.entries(MACROS)) {
    if (src.includes(k)) {
      src = src.replaceAll(k, v)
      changed = true
    }
  }

  // 2c. Remove bun:bundle import (feature() is already replaced)
  if (src.includes("from 'bun:bundle'") || src.includes('from "bun:bundle"')) {
    src = src.replace(/import\s*\{\s*feature\s*\}\s*from\s*['"]bun:bundle['"];?\n?/g, '// feature() replaced with false at build time\n')
    changed = true
  }

  // 2d. Remove type-only import of global.d.ts
  if (src.includes("import '../global.d.ts'") || src.includes("import './global.d.ts'")) {
    src = src.replace(/import\s*['"][.\/]*global\.d\.ts['"];?\n?/g, '')
    changed = true
  }

  if (changed) {
    await writeFile(file, src, 'utf8')
    transformCount++
  }
}
console.log(`✅ Phase 2: Transformed ${transformCount} files`)

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Create entry wrapper
// ══════════════════════════════════════════════════════════════════════════════

await writeFile(ENTRY, `// Claude Code v${VERSION} — built from source
// Copyright (c) Anthropic PBC. All rights reserved.
import './src/entrypoints/cli.tsx'
`, 'utf8')
console.log('✅ Phase 3: Created entry wrapper')

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Iterative stub + bundle
// ══════════════════════════════════════════════════════════════════════════════

await ensureEsbuild()

const OUT_DIR = join(ROOT, 'dist')
await mkdir(OUT_DIR, { recursive: true })
const OUT_FILE = join(OUT_DIR, 'cli.cjs')

// Run up to 5 rounds of: esbuild → collect missing → create stubs → retry
const MAX_ROUNDS = 15
let succeeded = false

for (let round = 1; round <= MAX_ROUNDS; round++) {
  console.log(`\n🔨 Phase 4 round ${round}/${MAX_ROUNDS}: Bundling...`)

  let esbuildOutput = ''
  try {
    esbuildOutput = execSync([
      'npx esbuild',
      `"${ENTRY}"`,
      '--bundle',
      '--platform=node',
      '--target=node18',
      '--format=cjs',
      `--outfile="${OUT_FILE}"`,
      `--banner:js=$'#!/usr/bin/env node\\n// Claude Code v${VERSION} (built from source)\\n// Copyright (c) Anthropic PBC. All rights reserved.\\nconst __import_meta_url = require("url").pathToFileURL(__filename).href;\\n'`,
      `--define:import.meta.url=__import_meta_url`,
      '--external:bun:*',
      '--external:fsevents',
      '--external:@azure/identity',
      '--external:@anthropic-ai/vertex-sdk',
      '--external:@aws-sdk/client-bedrock',
      '--external:@aws-sdk/credential-providers',
      '--external:@ant/claude-for-chrome-mcp',
      '--external:modifiers-napi',
      '--external:color-diff-napi',
      '--external:sharp',
      '--loader:.md=text',
      '--loader:.txt=text',
      // Resolve the 'src/*' path alias to build-src/src/* (tsconfig paths)
      `--alias:src=${join(BUILD, 'src')}`,
      '--allow-overwrite',
      '--log-level=error',
      '--log-limit=0',
      '--sourcemap',
    ].join(' '), {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    }).stderr?.toString() || ''
    succeeded = true
    break
  } catch (e) {
    esbuildOutput = (e.stderr?.toString() || '') + (e.stdout?.toString() || '')
  }

  // Parse missing modules with their importer context
  // esbuild error format:
  //   ✘ [ERROR] Could not resolve "./foo.js"
  //   ✘ [ERROR] Could not resolve "/abs/path.js" (originally "src/foo.js")
  //   ✘ [ERROR] No matching export in "build-src/src/foo.js" for import "bar"
  const missingAbsPaths = new Set()
  const missingWithImporters = []
  // Map from absolute file path → Set of export names needed
  const missingExports = new Map()
  const errorBlocks = esbuildOutput.split(/\n(?=✘ \[ERROR\])/)
  for (const block of errorBlocks) {
    // Handle "No matching export" errors
    const exportMatch = block.match(/No matching export in "([^"]+)" for import "([^"]+)"/)
    if (exportMatch) {
      const filePath = exportMatch[1]
      const exportName = exportMatch[2]
      // Only handle files in build-src/
      if (filePath.startsWith('build-src/') || filePath.startsWith(BUILD)) {
        const absPath = filePath.startsWith('/') ? filePath : resolve(ROOT, filePath)
        if (!missingExports.has(absPath)) missingExports.set(absPath, new Set())
        missingExports.get(absPath).add(exportName)
      }
      continue
    }

    const resolveMatch = block.match(/Could not resolve "([^"]+)"/)
    if (!resolveMatch) continue
    const mod = resolveMatch[1]
    if (mod.startsWith('node:') || mod.startsWith('bun:')) continue

    // Handle absolute paths (from --alias resolution)
    if (mod.startsWith('/')) {
      if (!await exists(mod)) missingAbsPaths.add(mod)
      continue
    }

    // Extract importer path (first indented file path after the error line)
    const importerMatch = block.match(/\n\s+((?:build-src|src)[^\s:]+):\d+:\d+:/)
    const importer = importerMatch ? importerMatch[1] : null
    missingWithImporters.push({ mod, importer })
  }

  const missing = new Set(missingWithImporters.map(x => x.mod))

  if (missing.size === 0 && missingAbsPaths.size === 0 && missingExports.size === 0) {
    // No more missing modules but still errors — check what
    const errLines = esbuildOutput.split('\n').filter(l => l.includes('ERROR')).slice(0, 5)
    console.log('❌ Unrecoverable errors:')
    errLines.forEach(l => console.log('   ' + l))
    break
  }

  console.log(`   Found ${missing.size + missingAbsPaths.size} missing modules, ${missingExports.size} stubs needing exports, creating stubs...`)

  // Create stubs
  let stubCount = 0

  // Handle absolute paths first (from --alias src= resolution)
  for (const absPath of missingAbsPaths) {
    const isText = /\.(txt|md)$/.test(absPath)
    await mkdir(dirname(absPath), { recursive: true }).catch(() => {})
    if (!await exists(absPath)) {
      if (isText) {
        await writeFile(absPath, '', 'utf8')
      } else {
        await writeFile(absPath, `// Auto-generated stub\nexport default {}\nexport const __stub = true\n`, 'utf8')
      }
      stubCount++
    }
  }

  for (const { mod, importer } of missingWithImporters) {
    const isText = /\.(txt|md)$/.test(mod)
    const isCode = /\.[tj]sx?$/.test(mod) || mod.endsWith('.js')

    // Determine absolute stub paths to create
    const stubPaths = []

    if (mod.startsWith('./') || mod.startsWith('../')) {
      // Relative import — resolve relative to importer if known
      if (importer) {
        const importerAbs = resolve(ROOT, importer)
        const resolved = resolve(dirname(importerAbs), mod)
        stubPaths.push(resolved)
      } else {
        // Fallback: try from build-src/src
        stubPaths.push(resolve(BUILD, 'src', mod))
      }
    } else {
      // Bare module — skip (handled by --packages=external)
      continue
    }

    for (const p of stubPaths) {
      await mkdir(dirname(p), { recursive: true }).catch(() => {})
      if (!await exists(p)) {
        if (isText) {
          await writeFile(p, '', 'utf8')
        } else if (isCode) {
          await writeFile(p, `// Auto-generated stub\nexport default {}\nexport const __stub = true\n`, 'utf8')
        }
        stubCount++
      }
    }
  }
  // Fix stubs with missing named exports
  for (const [absPath, exportNames] of missingExports) {
    try {
      let content = await readFile(absPath, 'utf8').catch(() => '// Auto-generated stub\nexport default {}\nexport const __stub = true\n')
      let changed = false
      for (const name of exportNames) {
        // Check if export already exists
        // Use word boundary check to avoid false positives (e.g. getLatestVersion inside getLatestVersionFromGcs)
        const alreadyExported = new RegExp(`\\bexport\\b[^{]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content)
        if (!alreadyExported) {
          const safeName = name.replace(/[^a-zA-Z0-9_$]/g, '_')
          content += `export const ${safeName} = (..._a) => {}\n`
          if (safeName !== name) {
            // Use export rename for names with special chars
            content += `export { ${safeName} as ${JSON.stringify(name).slice(1,-1)} }\n`.replace(/"/g, '')
          }
          changed = true
        }
      }
      if (changed) {
        await mkdir(dirname(absPath), { recursive: true }).catch(() => {})
        await writeFile(absPath, content, 'utf8')
        stubCount++
      }
    } catch (e) {
      // ignore
    }
  }

  console.log(`   Created/updated ${stubCount} stubs`)
}

if (succeeded) {
  const size = (await stat(OUT_FILE)).size
  console.log(`\n✅ Build succeeded: ${OUT_FILE}`)
  console.log(`   Size: ${(size / 1024 / 1024).toFixed(1)}MB`)
  console.log(`\n   Usage:  node ${OUT_FILE} --version`)
  console.log(`           node ${OUT_FILE} -p "Hello"`)
} else {
  console.error('\n❌ Build failed after all rounds.')
  console.error('   The transformed source is in build-src/ for inspection.')
  console.error('\n   To fix manually:')
  console.error('   1. Check build-src/ for the transformed files')
  console.error('   2. Create missing stubs in build-src/src/')
  console.error('   3. Re-run: node scripts/build.mjs')
  process.exit(1)
}
