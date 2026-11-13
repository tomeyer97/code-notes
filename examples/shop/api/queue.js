// The job queue: charge jobs waiting for the worker. In memory, first in first out, with a size limit.
// Jobs live in this process only: restarting the API drops the ones still waiting.
import { config } from '../config/load.js'

export class JobQueue {
  constructor(maxJobs) {
    this.maxJobs = maxJobs
    this.waiting = []
  }

  get size() {
    return this.waiting.length
  }

  isFull() {
    return this.waiting.length >= this.maxJobs
  }

  // Adds a job at the end. Returns false, and adds nothing, when the queue is full.
  push(job) {
    if (this.isFull()) return false
    this.waiting.push(job)
    return true
  }

  // Removes and returns the oldest job, or null when none is waiting.
  take() {
    return this.waiting.shift() ?? null
  }
}

export const jobs = new JobQueue(config.queue.maxJobs)
