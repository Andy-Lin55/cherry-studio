import type { AppEdition } from '@shared/types/appEdition'
import type { AppBuildInfo } from '@shared/utils/buildInfo'

declare global {
  const __APP_EDITION__: AppEdition
  const __APP_BUILD_INFO__: AppBuildInfo | null

  interface ImportMetaEnv {
    readonly MAIN_VITE_CHERRYAI_CLIENT_SECRET: string
    readonly MAIN_VITE_CHERRY_CLOUD_CLIENT_SECRET?: string
    readonly MAIN_VITE_CHERRY_CLOUD_API_ORIGIN?: string
  }
}
