/**
 * Compile-harness for the public-only Telegram sidecar path.
 *
 * bun test does not load this file. compile-sidecar.test.ts builds it so the
 * production `import('./dedicated.js')` literal is packed, then evaluates the
 * launcher with no dedicated token and without starting polling.
 */
const home = process.env.CC_TG_COMPILE_HOME
if (!home) throw new Error('CC_TG_COMPILE_HOME required')

process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
process.env.XDG_CONFIG_HOME = `${home}/xdg`
process.env.TMPDIR = `${home}/tmp`
delete process.env.TELEGRAM_BOT_TOKEN
process.env.ADAPTER_SERVER_URL = 'ws://127.0.0.1:1'
process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = home
process.env.ADAPTER_DEFAULT_PROJECT_DIR = `${home}/repo`
process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = `${home}/repo`

await import('../../index.ts')
console.log('compiled-public-only-ok')
process.exit(0)