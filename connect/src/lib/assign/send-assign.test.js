import { describe, test } from 'node:test'
import * as assert from 'node:assert'

import { createLogger } from '../../logger.js'
import { sendAssignWith } from './send-assign.js'

const logger = createLogger('assign')

describe('send-assign', () => {
  test('send an assignment to the MU', async () => {
    const sendAssign = sendAssignWith({
      deployAssign: async ({ process, message }) => {
        assert.ok(process)
        assert.ok(message)
        assert.equal(process, 'process-1')
        assert.equal(message, 'message-1')

        return { assignmentId: 'assignment-1' }
      },
      logger
    })

    await sendAssign({
      process: 'process-1',
      message: 'message-1'
    }).toPromise()
      .then(res => assert.equal(res.assignmentId, 'assignment-1'))
  })
})
