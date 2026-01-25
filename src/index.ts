/**
 * workflow-cron-start
 * 
 * Start workflows on a cron schedule with the Workflow Dev Kit.
 * 
 * This package provides a simple API for scheduling workflows to run
 * on a cron schedule. It uses a pre-build step to generate wrapper
 * workflows that handle the cron loop.
 * 
 * @example
 * ```typescript
 * // Define your workflow
 * export async function sendReport(email: string) {
 *     "use workflow"
 *     // ... workflow logic
 * }
 * 
 * // Schedule it to run every day at 9am
 * import { cronStart } from "workflow-cron-start"
 * import { sendReport } from "./workflow"
 * 
 * const run = await cronStart(sendReport, ["user@example.com"], {
 *     cron: "0 9 * * *",
 *     timezone: "America/New_York"
 * })
 * 
 * console.log(`Started cron job: ${run.runId}`)
 * ```
 */

// Re-export cronSleep for use in generated wrappers
export { cronSleep } from "workflow-cron-sleep"
export type { CronSleepOptions } from "workflow-cron-sleep"

/**
 * Options for scheduling a cron workflow
 */
export interface CronOptions {
    /**
     * Cron expression defining when to run.
     * 
     * Standard 5-field cron format: minute hour day-of-month month day-of-week
     * 
     * @example "0 9 * * *" - Every day at 9:00 AM
     * @example "0 0 1 * *" - First day of each month at midnight
     * @example "30 14 * * 1-5" - Weekdays at 2:30 PM
     * @example "0/15 * * * *" - Every 15 minutes
     */
    cron: string

    /**
     * IANA timezone for interpreting the cron expression.
     * If not specified, UTC is used.
     * 
     * @example "America/New_York"
     * @example "Europe/London"
     * @example "Asia/Tokyo"
     * @example "UTC"
     */
    timezone?: string

    /**
     * What to do if the workflow throws an error.
     * 
     * - "continue" (default): Log the error and continue to the next scheduled run
     * - "stop": Stop the cron loop and propagate the error
     */
    onError?: "continue" | "stop"
}

/**
 * Result of starting a cron workflow
 */
export interface CronStartResult {
    /** The unique run ID for the cron workflow */
    runId: string
}

/**
 * Start a workflow on a cron schedule.
 * 
 * This function is transformed at build time to use a pre-generated
 * wrapper workflow. The wrapper handles the cron loop, sleeping until
 * the next scheduled time and then executing the workflow.
 * 
 * @param workflow - The workflow function to schedule
 * @param args - Arguments to pass to the workflow on each execution
 * @param options - Cron scheduling options
 * @returns A promise that resolves to the run details
 * 
 * @example
 * ```typescript
 * import { cronStart } from "workflow-cron-start"
 * import { processData } from "./workflows"
 * 
 * // Run every hour
 * const run = await cronStart(processData, ["input"], {
 *     cron: "0 * * * *"
 * })
 * 
 * console.log(`Cron workflow started: ${run.runId}`)
 * ```
 * 
 * @remarks
 * This function must be transformed at build time. If you see a runtime
 * error about transformation, ensure you're using `withCronWorkflow` in
 * your `next.config.ts`:
 * 
 * ```typescript
 * import { withCronWorkflow } from "workflow-cron-start/next"
 * export default withCronWorkflow({ ... })
 * ```
 */
export function cronStart<TArgs extends unknown[]>(
    workflow: (...args: TArgs) => Promise<unknown>,
    args: TArgs,
    options: CronOptions
): Promise<CronStartResult> {
    // This function should never be called at runtime.
    // It should be transformed at build time to use the generated wrapper.
    throw new Error(
        "[workflow-cron-start] cronStart() was not transformed at build time.\n\n" +
        "This usually means one of the following:\n" +
        "1. You're not using withCronWorkflow in your next.config.ts\n" +
        "2. The build hasn't run yet (try restarting the dev server)\n" +
        "3. The loader didn't process this file\n\n" +
        "Make sure your next.config.ts looks like:\n\n" +
        "  import { withCronWorkflow } from 'workflow-cron-start/next'\n" +
        "  export default withCronWorkflow({ ... })"
    )
}

/**
 * Configuration passed to generated wrapper workflows.
 * This is an internal type used by the generated code.
 */
export interface CronWrapperConfig<TArgs extends unknown[] = unknown[]> {
    /** Arguments to pass to the wrapped workflow */
    args: TArgs
    
    /** Cron expression */
    cron: string
    
    /** Timezone for the cron expression */
    timezone?: string
    
    /** Error handling behavior */
    onError?: "continue" | "stop"
}

/**
 * Legacy type alias for backwards compatibility.
 * @deprecated Use CronWrapperConfig instead
 */
export type CronConfig<TArgs extends unknown[] = unknown[]> = CronWrapperConfig<TArgs>

/**
 * Result of stopping a cron workflow
 */
export interface CronEndResult {
    /** The run ID that was cancelled */
    runId: string
    /** Whether the cancellation was successful */
    cancelled: boolean
}

/**
 * Stop a running cron workflow.
 * 
 * This function cancels a cron workflow that was started with `cronStart()`.
 * It validates that the run ID corresponds to a cron scheduler workflow
 * before cancelling.
 * 
 * @param runId - The run ID returned from `cronStart()`
 * @returns A promise that resolves when the workflow is cancelled
 * 
 * @example
 * ```typescript
 * import { cronStart, cronEnd } from "workflow-cron-start"
 * import { sendReport } from "./workflows"
 * 
 * // Start a cron job
 * const run = await cronStart(sendReport, ["user@example.com"], {
 *     cron: "0 9 * * *"
 * })
 * 
 * // Later, stop it
 * await cronEnd(run.runId)
 * ```
 * 
 * @throws Error if the run ID does not correspond to a cron workflow
 */
export async function cronEnd(runId: string): Promise<CronEndResult> {
    const { getRun } = await import("workflow/api")
    
    // Get the run - this returns a Run instance directly
    const run = getRun(runId)
    
    // workflowName is a getter that returns a Promise
    const workflowName = await run.workflowName
    
    // Check if this is a cron scheduler workflow
    // The full workflow name includes the file path, e.g.:
    // "workflow//src/app/cron-wrappers/trigger-X/workflow.ts//__cron__X"
    if (!workflowName.includes("__cron__")) {
        throw new Error(
            `[workflow-cron-start] Run ${runId} is not a cron workflow.\n` +
            `Workflow name "${workflowName}" does not contain "__cron__".\n` +
            `Use run.cancel() from "workflow/api" directly to cancel non-cron workflows.`
        )
    }
    
    // Cancel the workflow using the Run instance method
    await run.cancel()
    
    return {
        runId,
        cancelled: true
    }
}
