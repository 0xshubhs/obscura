/**
 * cron-job.org one-shot scheduler — server-only.
 *
 * When a new auction is created, we POST to cron-job.org's REST API to
 * register a single job that fires shortly after `endTime`. The job pings our
 * own `/api/cron/finalize?auctionId=N` route, which then drives the chain
 * state machine forward (endAuction → finalize). The chain itself remains
 * the source of truth — the scheduler is just a precise alarm clock.
 *
 * cron-job.org schedule semantics:
 *   - all of {months, mdays, hours, minutes} must match for the job to fire
 *   - `wdays: [-1]` means any weekday (don't filter on it for one-shots)
 *   - `expiresAt` is a yyyymmddhhmmss INT — set a few minutes past the fire
 *     time so the job auto-deletes after firing instead of squatting a slot
 *
 * The free tier caps each account at 50 active jobs. Auto-expiry keeps us
 * under that cap as auctions finalize.
 *
 * Docs: https://docs.cron-job.org/rest-api.html
 */

const CRONJOB_API_BASE = "https://api.cron-job.org"

// All values UTC. cron-job.org also accepts other tz strings but UTC matches
// chain `block.timestamp` semantics so we always reason in one clock.
type CronJobSchedule = {
  timezone: "UTC"
  expiresAt: number
  hours: number[]
  mdays: number[]
  minutes: number[]
  months: number[]
  wdays: number[]
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

// yyyymmddhhmmss as a single integer — cron-job.org's documented expiresAt
// format. Avoid scientific notation: 14-digit values fit in Number (~9e15
// safe-int ceiling).
function toExpiresAt(d: Date): number {
  const s =
    `${d.getUTCFullYear()}` +
    `${pad2(d.getUTCMonth() + 1)}` +
    `${pad2(d.getUTCDate())}` +
    `${pad2(d.getUTCHours())}` +
    `${pad2(d.getUTCMinutes())}` +
    `${pad2(d.getUTCSeconds())}`
  return Number(s)
}

function fireDateToSchedule(fire: Date): CronJobSchedule {
  // Auto-delete the job 10 minutes after the fire window so a slot frees up
  // even if cron-job.org's first attempt 5xx'd and they retried later.
  const expires = new Date(fire.getTime() + 10 * 60 * 1000)
  return {
    timezone: "UTC",
    expiresAt: toExpiresAt(expires),
    hours: [fire.getUTCHours()],
    mdays: [fire.getUTCDate()],
    minutes: [fire.getUTCMinutes()],
    months: [fire.getUTCMonth() + 1],
    wdays: [-1],
  }
}

export type ScheduleResult = {
  endJobId: number
  finalizeJobId: number
  endFireAt: string
  finalizeFireAt: string
  url: string
}

async function createOneShot(opts: {
  url: string
  title: string
  fireAt: Date
  cronSecret: string
  apiKey: string
}): Promise<number> {
  const payload = {
    job: {
      url: opts.url,
      enabled: true,
      saveResponses: true,
      title: opts.title,
      requestMethod: 0, // 0 = GET
      schedule: fireDateToSchedule(opts.fireAt),
      extendedData: {
        headers: { Authorization: `Bearer ${opts.cronSecret}` },
      },
    },
  }
  const res = await fetch(`${CRONJOB_API_BASE}/jobs`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cron-job.org PUT /jobs ${res.status}: ${body.slice(0, 240)}`)
  }
  const data = (await res.json()) as { jobId?: number }
  if (typeof data.jobId !== "number") {
    throw new Error("cron-job.org response missing jobId")
  }
  return data.jobId
}

export async function scheduleAuctionFinalize(opts: {
  auctionId: bigint
  endTimeUnix: bigint
  baseUrl: string
  cronSecret: string
  apiKey: string
}): Promise<ScheduleResult> {
  const { auctionId, endTimeUnix, baseUrl, cronSecret, apiKey } = opts

  // Vercel Hobby caps function duration at 60s. Doing endAuction + 30s
  // relayer wait + finalize in a single invocation runs ~57s — uncomfortably
  // close to the cap. So we split into TWO one-shots and let the route's
  // state machine run a single transition per call (~15-20s each):
  //
  //   endTime + 30s   → fires endAuction
  //   endTime + 90s   → fires finalize (~60s gap; tight but workable —
  //                     endAuction takes ~15s to mine, then the Zama relayer
  //                     needs ~24-30s to index the makePubliclyDecryptable
  //                     event and produce KMS signatures)
  //
  // If the relayer is briefly slow and finalize 404s, the GH Actions
  // safety-net cron (*/30) catches up. The route is idempotent on chain
  // state, so duplicates and out-of-order delivery are harmless.
  const baseClean = baseUrl.replace(/\/$/, "")
  const url = `${baseClean}/api/cron/finalize?auctionId=${auctionId}`

  const endFireAt = new Date((Number(endTimeUnix) + 30) * 1000)
  const finalizeFireAt = new Date((Number(endTimeUnix) + 90) * 1000)

  // Sequential, not parallel — cron-job.org's API rate-limits bursts.
  const endJobId = await createOneShot({
    url,
    title: `obscura-end-${auctionId}`,
    fireAt: endFireAt,
    cronSecret,
    apiKey,
  })
  const finalizeJobId = await createOneShot({
    url,
    title: `obscura-finalize-${auctionId}`,
    fireAt: finalizeFireAt,
    cronSecret,
    apiKey,
  })

  return {
    endJobId,
    finalizeJobId,
    endFireAt: endFireAt.toISOString(),
    finalizeFireAt: finalizeFireAt.toISOString(),
    url,
  }
}
