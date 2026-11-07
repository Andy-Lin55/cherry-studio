const { signAsync } = require('@electron/osx-sign')
const path = require('node:path')

const helperEntitlements = path.resolve(__dirname, '../..', 'build', 'entitlements.system-speech.plist')

function createOptionsForFile(appPath, originalOptionsForFile, isAdHoc = false) {
  const helperPath = path.join(appPath, 'Contents', 'Helpers', 'cherry-system-speech')

  return (filePath) => {
    const options = originalOptionsForFile?.(filePath)
    const adHocOverrides = isAdHoc && !options?.timestamp ? { timestamp: 'none' } : undefined
    if (filePath !== helperPath) {
      return adHocOverrides ? { ...options, ...adHocOverrides } : options
    }

    return { ...options, ...adHocOverrides, entitlements: helperEntitlements }
  }
}

async function signMacApp(configuration, signer = signAsync) {
  const isAdHoc = configuration.identity === '-'
  await signer({
    ...configuration,
    optionsForFile: createOptionsForFile(configuration.app, configuration.optionsForFile, isAdHoc)
  })
}

exports.createOptionsForFile = createOptionsForFile
exports.signMacApp = signMacApp
exports.default = async function (configuration) {
  await signMacApp(configuration)
}
