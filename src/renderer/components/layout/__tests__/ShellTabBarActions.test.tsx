// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'

const { mocks, updateState } = vi.hoisted(() => ({
  mocks: {
    checkForUpdate: vi.fn().mockResolvedValue(undefined),
    openSettingsTab: vi.fn(),
    showSearchPopup: vi.fn(),
    showUpdatePopup: vi.fn()
  },
  updateState: {
    available: false,
    downloading: false,
    downloaded: false,
    downloadProgress: 0,
    info: null as { version: string; releaseName?: string } | null
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn()
    })
  }
}))

vi.unmock('@cherrystudio/ui')
vi.unmock('@data/hooks/useCache')

vi.mock('@renderer/hooks/useAppUpdateState', () => ({
  useAppUpdateState: () => ({
    appUpdateState: updateState,
    updateAppUpdateState: vi.fn(),
    checkForUpdate: mocks.checkForUpdate
  })
}))

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openSettingsTab: mocks.openSettingsTab
}))

vi.mock('@renderer/components/GlobalSearch/GlobalSearchPopup', () => ({
  default: {
    show: mocks.showSearchPopup
  }
}))

vi.mock('@renderer/components/UpdateDialogPopup', () => ({
  default: {
    show: mocks.showUpdatePopup
  }
}))

vi.mock('@renderer/components/command', () => ({
  CommandTooltip: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'globalSearch.open': 'Open global search',
        'settings.about.checkUpdate.available': 'Update available',
        'settings.about.downloading': 'Downloading update',
        'settings.about.updateAvailable': 'Found new version',
        'settings.title': 'Settings',
        'sidebar.account_menu': 'Account menu'
      })[key] ?? key
  })
}))

vi.mock('../../WindowControls', () => ({
  WindowControls: () => null
}))

import { AppUpdateButton, ShellTabBarActions } from '../ShellTabBarActions'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
  updateState.available = false
  updateState.downloading = false
  updateState.downloaded = false
  updateState.downloadProgress = 0
  updateState.info = null
})

describe('ShellTabBarActions', () => {
  it('does not duplicate the notification bell while the sidebar is visible', () => {
    render(<ShellTabBarActions />)
    expect(screen.queryByRole('button', { name: 'Notification center' })).not.toBeInTheDocument()
  })
  it('opens global search from the action area', async () => {
    const user = userEvent.setup()

    render(<ShellTabBarActions />)

    await user.click(screen.getByRole('button', { name: 'Open global search' }))

    expect(mocks.showSearchPopup).toHaveBeenCalledTimes(1)
  })

  it('shows a ready update and opens its dialog directly', async () => {
    const user = userEvent.setup()
    updateState.available = true
    updateState.downloaded = true
    updateState.info = { version: '2.0.0' }

    render(<AppUpdateButton />)

    const updateButton = screen.getByRole('button', { name: 'Found new version' })

    await user.click(updateButton)

    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.showUpdatePopup).toHaveBeenCalledWith({ releaseInfo: updateState.info })
    })
  })

  it('shows available updates immediately and starts download + dialog on one click', async () => {
    const user = userEvent.setup()
    updateState.available = true
    updateState.downloaded = false
    updateState.info = { version: '2.1.10', releaseName: '2.1.10 (abc1234)' }

    render(<AppUpdateButton showLabel />)

    const updateButton = screen.getByRole('button', { name: /Found new version/i })
    expect(updateButton).toHaveTextContent('Update available')

    await user.click(updateButton)

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(mocks.showUpdatePopup).toHaveBeenCalledWith({ releaseInfo: updateState.info })
    })
  })

  it('shows download progress percentage and skips duplicate download calls while downloading', async () => {
    const user = userEvent.setup()
    updateState.available = true
    updateState.downloading = true
    updateState.downloaded = false
    updateState.downloadProgress = 42.4
    updateState.info = { version: '2.1.10', releaseName: '2.1.10 (abc1234)' }

    render(<AppUpdateButton showLabel />)

    const updateButton = screen.getByRole('button', { name: /Downloading update/i })
    expect(updateButton).toHaveTextContent('42%')

    await user.click(updateButton)

    expect(mocks.checkForUpdate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.showUpdatePopup).toHaveBeenCalledWith({ releaseInfo: updateState.info })
    })
  })

  it('shows the update button in the top-right tab bar across full and icon sidebar layouts', () => {
    updateState.available = true
    updateState.downloaded = true
    updateState.info = { version: '2.0.0' }

    cacheService.setPersist('ui.sidebar.width', 180)
    const { rerender } = render(<ShellTabBarActions />)
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Found new version',
      'Open global search'
    ])

    cacheService.setPersist('ui.sidebar.width', 50)
    rerender(<ShellTabBarActions />)
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Found new version',
      'Open global search'
    ])
  })

  it('keeps the update action at the left of the hidden-sidebar action group', () => {
    cacheService.setPersist('ui.sidebar.width', 0)
    updateState.available = true
    updateState.downloaded = true
    updateState.info = { version: '2.0.0' }

    render(<ShellTabBarActions />)

    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Found new version',
      'Open global search',
      'Settings'
    ])
  })

  it.each([50, 180])('keeps standalone settings out of the tab bar at width %ipx', (width) => {
    cacheService.setPersist('ui.sidebar.width', width)
    render(<ShellTabBarActions />)

    expect(screen.queryByRole('button', { name: 'Light' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument()
  })

  it('opens settings from the right action area when the sidebar is hidden', async () => {
    cacheService.setPersist('ui.sidebar.width', 0)
    const user = userEvent.setup()
    render(<ShellTabBarActions />)

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(mocks.openSettingsTab).toHaveBeenCalledWith()
    expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument()
  })
})
