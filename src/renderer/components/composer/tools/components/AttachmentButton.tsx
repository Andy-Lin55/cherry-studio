import type { Dispatch, FC, SetStateAction } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getQuickPanelSearchAliases } from '@renderer/components/composer/quickPanel'
import { ATTACHMENT_TOOLBAR_MANIFEST } from '@renderer/components/composer/tools/toolbarManifests'
import type { ToolLauncherApi } from '@renderer/components/composer/tools/types'
import { toast } from '@renderer/services/toast'
import { filterSupportedFiles } from '@renderer/utils/file'
import { type ComposerAttachment, toComposerAttachments } from '@renderer/utils/message/composerAttachment'

interface Props {
  launcher: ToolLauncherApi
  couldAddImageFile: boolean
  extensions: string[]
  files: ComposerAttachment[]
  setFiles: Dispatch<SetStateAction<ComposerAttachment[]>>
  disabled?: boolean
}

const useAttachmentToolController = ({ launcher, couldAddImageFile, extensions, setFiles, disabled }: Props) => {
  const { t } = useTranslation()
  const [selecting, setSelecting] = useState<boolean>(false)

  const openFileSelectDialog = useCallback(
    async (restoreFocus?: () => void) => {
      if (selecting) {
        return
      }
      const hasWildcard = extensions.includes('*') || extensions.includes('.*')
      const useAllFiles = extensions.length > 20 || hasWildcard || extensions.length === 0

      const validExts = extensions
        .map((i) => i.replace(/^\./, '').trim())
        .filter((i) => i.length > 0 && i !== '*')

      const dialogFilters =
        !useAllFiles && validExts.length > 0
          ? [
              {
                name: 'Files',
                extensions: validExts
              }
            ]
          : undefined

      setSelecting(true)
      const _files = await window.api.file.select({
        properties: ['openFile', 'multiSelections'],
        ...(dialogFilters ? { filters: dialogFilters } : {})
      })
      setSelecting(false)
      window.requestAnimationFrame(() => restoreFocus?.())

      if (_files) {
        if (!useAllFiles || hasWildcard) {
          setFiles((currentFiles) => [...currentFiles, ...toComposerAttachments(_files)])
          return
        }
        const supportedFiles = await filterSupportedFiles(_files, extensions)
        if (supportedFiles.length > 0) {
          setFiles((currentFiles) => [...currentFiles, ...toComposerAttachments(supportedFiles)])
        }

        if (supportedFiles.length !== _files.length) {
          toast.info(
            t('chat.input.file_not_supported_count', {
              count: _files.length - supportedFiles.length
            })
          )
        }
      }
    },
    [extensions, selecting, setFiles, t]
  )

  useEffect(() => {
    const isDocumentOnly = !couldAddImageFile
    const disposeLauncher = launcher.registerLaunchers([
      {
        ...ATTACHMENT_TOOLBAR_MANIFEST.toolbar,
        sources: ['popover'],
        label: t('chat.input.upload.attachment'),
        description: '',
        searchAliases: getQuickPanelSearchAliases(t, 'chat.input.upload.attachment', ['upload attachment']),
        tooltip: isDocumentOnly ? t('chat.input.upload.image_not_supported') : undefined,
        suffix: isDocumentOnly ? t('chat.input.upload.document_only') : undefined,
        disabled,
        action: ({ inputAdapter }) => {
          void openFileSelectDialog(inputAdapter?.focus)
        }
      }
    ])

    return () => {
      disposeLauncher()
    }
  }, [couldAddImageFile, disabled, launcher, openFileSelectDialog, t])
}

export const AttachmentToolRuntime: FC<Props> = (props) => {
  useAttachmentToolController(props)
  return null
}
