import type { Command, LocalCommandCall } from '../types/command.js'
import { HA_VERSION } from '../constants/version.js'

const call: LocalCommandCall = async () => {
  return {
    type: 'text',
    value: '2026-04-01T06:30:25.799Z'
      ? `${HA_VERSION} (built ${'2026-04-01T06:30:25.799Z'})`
      : HA_VERSION,
  }
}

const version = {
  type: 'local',
  name: 'version',
  description:
    'Print the version this session is running (not what autoupdate downloaded)',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default version
