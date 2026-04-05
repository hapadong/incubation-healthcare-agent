import type { Command } from '../../commands.js'

const teamReview = {
  type: 'local-jsx',
  name: 'team-review',
  description: 'Select clinical specialists to review the current patient case as a team',
  argumentHint: '',
  load: () => import('./teamReview.js'),
} satisfies Command

export default teamReview
