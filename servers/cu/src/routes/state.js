import { always, compose } from 'ramda'
import { z } from 'zod'

import { withMiddleware } from './middleware/index.js'

const inputSchema = z.object({
  processId: z.string().min(1, 'an ao process id is required'),
  to: z.string().optional()
})

export const withStateRoutes = (app) => {
  // readState
  app.get(
    '/state/:processId',
    compose(
      withMiddleware,
      always(async (req, res) => {
        const {
          params: { processId },
          query: { to },
          domain: { apis: { readState } }
        } = req

        const input = inputSchema.parse({ processId, to })
        return res.send(await readState(input).toPromise())
      })
    )()
  )

  return app
}
