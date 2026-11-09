import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { toast } from '@renderer/services/toast'
import type { FileMetadata } from '@renderer/types/file'
import { filterSupportedFiles } from '@renderer/utils/file'

type Props = {
  /** 支持选择的扩展名 */
  extensions?: string[]
}

export const useFiles = (props?: Props) => {
  const { t } = useTranslation()

  const [files, setFiles] = useState<FileMetadata[]>([])
  const [selecting, setSelecting] = useState<boolean>(false)

  const extensions = useMemo(() => {
    if (props?.extensions) {
      return props.extensions
    } else {
      return ['*']
    }
  }, [props?.extensions])

  /**
   * 选择文件的回调函数
   * @param multipleSelections - 是否允许多选文件，默认为 true
   * @returns 返回选中的文件元数据数组
   * @description
   * 1. 打开系统文件选择对话框
   * 2. 根据扩展名过滤文件
   * 3. 更新内部文件状态
   * 4. 当选择了不支持的文件类型时，会显示提示信息
   */
  const onSelectFile = useCallback(
    async ({ multipleSelections = true }: { multipleSelections?: boolean }): Promise<FileMetadata[]> => {
      if (selecting) {
        return []
      }

      const selectProps: Electron.OpenDialogOptions['properties'] = multipleSelections
        ? ['openFile', 'multiSelections']
        : ['openFile']

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
        properties: selectProps,
        ...(dialogFilters ? { filters: dialogFilters } : {})
      })
      setSelecting(false)

      if (_files) {
        if (!useAllFiles || hasWildcard) {
          setFiles((currentFiles) => [...currentFiles, ..._files])
          return _files
        }
        const supportedFiles = await filterSupportedFiles(_files, extensions)
        if (supportedFiles.length > 0) {
          setFiles((currentFiles) => [...currentFiles, ...supportedFiles])
        }

        if (supportedFiles.length !== _files.length) {
          toast.info(
            t('chat.input.file_not_supported_count', {
              count: _files.length - supportedFiles.length
            })
          )
        }
        return supportedFiles
      } else {
        return []
      }
    },
    [extensions, selecting, t]
  )

  const clearFiles = useCallback(() => {
    setFiles([])
  }, [])

  return {
    files,
    selecting,
    setFiles,
    onSelectFile,
    clearFiles
  }
}
