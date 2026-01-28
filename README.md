# workflow-cron-start

Schedule workflows to run on a cron schedule with the [Workflow DevKit](https://workflow.dev/).

## What This Does

Provides a simple API for creating recurring cron-scheduled workflows:

- **`cronStart()`** - Start a workflow on a cron schedule
- **`cronEnd()`** - Cancel a running cron workflow

Each cron trigger creates a **separate workflow run** with its own `runId`, enabling proper auditing and visibility.

## Installation

```bash
npm install workflow-cron-start
```

> Note: `workflow-cron-sleep` is included as a dependency and doesn't need to be installed separately.

## Setup

### Configure Next.js

Use `withCronWorkflow` in your `next.config.ts` (this wraps the standard `withWorkflow`):

```typescript
// next.config.ts
import { withCronWorkflow } from "workflow-cron-start/next"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // your config
}

export default withCronWorkflow(nextConfig)
```

### Monorepo Setup (pnpm/yarn workspaces)

The package automatically sets `outputFileTracingRoot` to the Next.js project directory, which works for most setups. If you have shared packages outside the Next.js app that need to be traced, you may need to override it to point to your monorepo root:

```typescript
// next.config.ts
import { withCronWorkflow } from "workflow-cron-start/next"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const nextConfig = {
  // Only needed if you have shared packages outside the Next.js app
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
}

export default withCronWorkflow(nextConfig)
```

## Quick Start

### 1. Define your workflow

```typescript
// src/lib/my-workflow.ts
export async function sendReport(email: string) {
    "use workflow"
    
    console.log(`Sending report to ${email}`)
    // Your workflow logic here
    
    return { success: true, email }
}
```

### 2. Start the cron workflow

```typescript
// src/app/api/start-cron/route.ts
import { cronStart } from "workflow-cron-start"
import { sendReport } from "@/lib/my-workflow"

export async function POST() {
    const run = await cronStart(sendReport, ["user@example.com"], {
        cron: "0 9 * * *",        // Every day at 9 AM
        timezone: "America/New_York"
    })
    
    // Save this runId to cancel the cron later
    return Response.json({ runId: run.runId })
}
```

### 3. Cancel the cron workflow

```typescript
// src/app/api/stop-cron/route.ts
import { cronEnd } from "workflow-cron-start"

export async function POST(request: Request) {
    const { runId } = await request.json()
    
    await cronEnd(runId)
    
    return Response.json({ cancelled: true })
}
```

## API Reference

### `cronStart(workflow, args, options)`

Start a workflow on a cron schedule.

```typescript
import { cronStart } from "workflow-cron-start"

const run = await cronStart(myWorkflow, [arg1, arg2], {
    cron: "0 9 * * *",
    timezone: "America/New_York",
    onError: "continue"
})

console.log(run.runId) // Save this to cancel later
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflow` | `Function` | The workflow function to schedule |
| `args` | `Array` | Arguments to pass to the workflow on each execution |
| `options` | `CronOptions` | Scheduling options (see below) |

**Returns:** `Promise<{ runId: string }>`

### `cronEnd(runId)`

Cancel a running cron workflow.

```typescript
import { cronEnd } from "workflow-cron-start"

await cronEnd("wrun_01ABC123...")
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `runId` | `string` | The run ID returned from `cronStart()` |

**Returns:** `Promise<{ runId: string, cancelled: boolean }>`

**Throws:** Error if the run ID does not correspond to a cron workflow.

### `CronOptions`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `cron` | `string` | Yes | Cron expression (e.g., `"0 9 * * *"`) |
| `timezone` | `string` | No | IANA timezone (e.g., `"America/New_York"`, `"UTC"`) |
| `onError` | `"continue"` \| `"stop"` | No | Error handling behavior (default: `"continue"`) |

### `withCronWorkflow(nextConfig, options?)`

Next.js config wrapper. Use this instead of `withWorkflow` from the Workflow Dev Kit.

```typescript
import { withCronWorkflow } from "workflow-cron-start/next"

export default withCronWorkflow({
  // your Next.js config
})
```

## Timezone Behavior

**Important:** When no timezone is specified, the cron expression uses the **server's local timezone**, which varies by deployment region.

For predictable behavior, **always specify a timezone**:

```typescript
await cronStart(myWorkflow, [args], {
    cron: "0 9 * * *",
    timezone: "America/New_York"  // Always specify this
})
```

## Error Handling

| `onError` | Behavior |
|-----------|----------|
| `"continue"` (default) | Log the error, continue to next scheduled run |
| `"stop"` | Stop the cron loop and propagate the error |

## Cron Expression Reference

| Expression | Description |
|------------|-------------|
| `* * * * *` | Every minute |
| `0 9 * * *` | Every day at 9:00 AM |
| `30 8 * * 1` | Every Monday at 8:30 AM |
| `0 0 1 * *` | First day of every month at midnight |
| `0 */2 * * *` | Every 2 hours |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│           Cron Scheduler Workflow (runs forever)         │
│                                                          │
│  ┌─────────────┐                                         │
│  │ cronSleep() │  ← Waits until next cron trigger        │
│  └──────┬──────┘                                         │
│         │                                                │
│         ▼                                                │
│  ┌─────────────────┐      ┌─────────────────────────┐    │
│  │ Trigger Step    │ ───► │ New Workflow Run        │    │
│  │ (HTTP request)  │      │ (wrun_xxx - separate!)  │    │
│  └─────────────────┘      └─────────────────────────┘    │
│         │                                                │
│         └────────────────────┐                           │
│                              │                           │
│         ┌────────────────────┘                           │
│         │                                                │
│         ▼                                                │
│      (repeat)                                            │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Each cron trigger creates a **separate workflow run** with its own `runId`, making it easy to:
- Track individual executions
- Debug specific runs
- View execution history

## Requirements

- Next.js >= 13 (App Router)
- `workflow` package (Workflow Dev Kit) >= 4.0.0

## Limitations

This package currently only supports **Next.js**. It uses:
- Next.js build tooling (Turbopack/Webpack loaders)
- App Router file conventions (`src/app/`)
- `withCronWorkflow` which wraps `workflow/next`

Support for other frameworks may be added in future versions.

## License

MIT
