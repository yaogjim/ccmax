/** Credential gates used before the sidecar imports an adapter entrypoint. */

export function isTelegramAdapterConfigured(config: {
  telegram: {
    botToken?: string
    public?: { enabled?: boolean; botToken?: string }
  }
}): boolean {
  return Boolean(config.telegram.botToken)
    || Boolean(config.telegram.public?.enabled && config.telegram.public.botToken)
}