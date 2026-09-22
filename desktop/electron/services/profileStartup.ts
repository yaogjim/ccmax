/**
 * Testable startup seam: prepare the active userData profile, point Electron at
 * it, then acquire the single-instance lock. Callers must not touch profile
 * consumers before this sequence completes.
 */
export type PreparedUserDataProfile = {
  activePath: string
}

export type ProfileStartupDeps = {
  prepareProfile: () => Promise<PreparedUserDataProfile>
  setUserDataPath: (activePath: string) => void
  acquireSingleInstanceLock: () => boolean
}

export type ProfileStartupResult = {
  activePath: string
  hasLock: boolean
}

export async function runProfileStartup(
  deps: ProfileStartupDeps,
): Promise<ProfileStartupResult> {
  const prepared = await deps.prepareProfile()
  deps.setUserDataPath(prepared.activePath)
  const hasLock = deps.acquireSingleInstanceLock()
  return {
    activePath: prepared.activePath,
    hasLock,
  }
}