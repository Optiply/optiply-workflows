import type { Db } from '@ow/db'
import type { Config } from '../../config'
import { type DeployResult, type DeployTrigger, requestGitDeploy, runGitDeploy } from './deploy'

interface DeployerLogger {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

/**
 * Deploys from Git in this process: every `pollMs` (workers; the first check soon after start), and when asked
 * (the API's push webhook). Every `retryMs` the last deploy's problem objects are re-checked without a new commit
 * (M22), the branch not read: with polling off, new commits still wait for a webhook or Deploy now. Every process may poll; the lease in `git_settings` lets one deploy at a time.
 */
export class GitDeployer {
  private timer: NodeJS.Timeout | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private first: NodeJS.Timeout | undefined
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly opts: {
      db: Db
      config: Pick<
        Config,
        'keyring' | 'GIT_CACHE_DIR' | 'GIT_ALLOW_INSECURE_URLS' | 'GOOGLE_SERVER_IDENTITY' | 'PUBLIC_URL'
      >
      log?: DeployerLogger
      /** 0: don't poll. */
      pollMs: number
      firstPollMs?: number
      /** 0 or left out: no timed retries (a marked change is still picked up by the next poll). */
      retryMs?: number
    },
  ) {}

  start(): void {
    const retryMs = this.opts.retryMs ?? 0
    if (retryMs > 0 && !this.retryTimer) {
      const retry = () =>
        void this.track(
          runGitDeploy(this.opts.db, this.opts.config, {
            trigger: 'poll',
            retryOnly: true,
            log: this.opts.log,
          }),
        )
      this.retryTimer = setInterval(retry, retryMs)
      this.retryTimer.unref()
    }
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
    clearInterval(this.retryTimer)
    this.timer = undefined
    this.retryTimer = undefined
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
