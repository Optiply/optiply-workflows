import type { Db } from '@ow/db'
import type { Config } from '../../config'
import { type DeployResult, type DeployTrigger, requestGitDeploy, runGitDeploy } from './deploy'

interface DeployerLogger {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/**
 * Deploys from Git in this process: every `pollMs` (workers; the first check soon after start), and when asked
 * (the API's push webhook). Every process may poll; the lease in `git_settings` lets one deploy at a time.
 */
export class GitDeployer {
  private timer: NodeJS.Timeout | undefined
  private first: NodeJS.Timeout | undefined
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly opts: {
      db: Db
      config: Pick<Config, 'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GOOGLE_SERVER_IDENTITY'>
      log?: DeployerLogger
      /** 0: don't poll. */
      pollMs: number
      firstPollMs?: number
    },
  ) {}

  start(): void {
    if (this.opts.pollMs <= 0 || this.timer) return
    const poll = () =>
      void this.track(runGitDeploy(this.opts.db, this.opts.config, { trigger: 'poll', log: this.opts.log }))
    this.first = setTimeout(poll, this.opts.firstPollMs ?? 5_000)
    this.timer = setInterval(poll, this.opts.pollMs)
    this.first.unref()
    this.timer.unref()
  }

  /** Asks for a deploy now (it runs here, or in the process already deploying, right after). */
  request(trigger: DeployTrigger): Promise<DeployResult | undefined> {
    return this.track(requestGitDeploy(this.opts.db, this.opts.config, { trigger, log: this.opts.log }))
  }

  async stop(): Promise<void> {
    clearTimeout(this.first)
    clearInterval(this.timer)
    this.timer = undefined
    await Promise.allSettled([...this.inFlight])
  }

  private track(run: Promise<DeployResult>): Promise<DeployResult | undefined> {
    const tracked = run.catch((err) => {
      this.opts.log?.error({ err }, 'git deploy failed')
      return undefined
    })
    this.inFlight.add(tracked)
    void tracked.finally(() => this.inFlight.delete(tracked))
    return tracked
  }
}
