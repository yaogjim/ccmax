export type CliEntrypoint = {
  main: () => Promise<void>
}

export async function runCli(
  loadCli: () => Promise<CliEntrypoint> = () => import('../../src/entrypoints/cli.tsx'),
): Promise<void> {
  const { main } = await loadCli()
  await main()
}
