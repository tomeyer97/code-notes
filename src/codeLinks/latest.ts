// The newest request wins: a request that awaits (a file read, a show) checks it is still the newest before it acts.

/** One request: `current` while no newer one began (or the requests were cancelled). */
export interface Run { readonly current: boolean }

export class Latest {
  private n = 0

  /** A new request: older ones are no longer current. */
  begin(): Run { return this.run(++this.n) }

  /** The request in flight, joined (a follow-up that yields to newer requests without starting one). */
  join(): Run { return this.run(this.n) }

  /** No request is current any more. */
  cancel(): void { this.n++ }

  private run(mine: number): Run {
    const newest = () => this.n
    return { get current() { return mine === newest() } }
  }
}
