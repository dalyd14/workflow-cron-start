/**
 * Next.js configuration wrapper for workflow-cron-start.
 * 
 * This module provides `withCronWorkflow`, a drop-in replacement for
 * the Workflow SDK's `withWorkflow` that adds cron scheduling support.
 * 
 * It uses a custom builder that:
 * 1. Scans for cronStart() calls before the build
 * 2. Generates wrapper workflows with "use workflow" directives
 * 3. Includes those wrappers in the Workflow SDK's discovery phase
 */

import type { NextConfig } from "next"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import { pregenerateCronWrappers } from "./builder.js"
import { getCronWrapperDir } from "./generator.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

/**
 * Options for withCronWorkflow
 */
export interface CronWorkflowOptions {
    workflows?: {
        local?: {
            /** Port for the local workflow server */
            port?: number
            /** Directory for local workflow data */
            dataDir?: string
        }
    }
}

/**
 * Wraps your Next.js config to enable cron workflow support.
 *
 * This is a drop-in replacement for `withWorkflow` from `workflow/next`.
 * It extends the workflow configuration to:
 * 1. Pre-generate cron wrapper files before the SDK build
 * 2. Include the .workflow-cron directory in workflow discovery
 * 3. Register a loader to transform cronStart() calls
 *
 * @example
 * ```typescript
 * // next.config.ts
 * import { withCronWorkflow } from "workflow-cron-start/next"
 * import type { NextConfig } from "next"
 *
 * const nextConfig: NextConfig = {
 *   // your config
 * }
 *
 * export default withCronWorkflow(nextConfig)
 * ```
 */
export function withCronWorkflow(
    nextConfigOrFn:
        | NextConfig
        | ((
            phase: string,
            ctx: { defaultConfig: NextConfig }
        ) => Promise<NextConfig>),
    options: CronWorkflowOptions = {}
): (
    phase: string,
    ctx: { defaultConfig: NextConfig }
) => Promise<NextConfig> {
    return async function buildConfig(
        phase: string,
        ctx: { defaultConfig: NextConfig }
    ) {
        // Set up environment variables for the Workflow SDK
        if (!process.env.VERCEL_DEPLOYMENT_ID) {
            if (!process.env.WORKFLOW_TARGET_WORLD) {
                process.env.WORKFLOW_TARGET_WORLD = "local"
                process.env.WORKFLOW_LOCAL_DATA_DIR = ".next/workflow-data"
            }
            const maybePort = options.workflows?.local?.port
            if (maybePort) {
                process.env.PORT = maybePort.toString()
            }
        } else {
            if (!process.env.WORKFLOW_TARGET_WORLD) {
                process.env.WORKFLOW_TARGET_WORLD = "vercel"
            }
        }

        // Get the base config
        let nextConfig: NextConfig
        if (typeof nextConfigOrFn === "function") {
            nextConfig = await nextConfigOrFn(phase, ctx)
        } else {
            nextConfig = nextConfigOrFn
        }

        // Shallow clone to avoid read-only issues
        nextConfig = { ...nextConfig }

        // Find the workflow-cron-start package path for the loader
        let cronStartPath: string
        try {
            cronStartPath = path.dirname(
                require.resolve("workflow-cron-start/package.json")
            )
        } catch {
            cronStartPath = path.resolve(__dirname, "..")
        }

        // Path to our loader
        const loaderPath = path.join(cronStartPath, "loader.cjs")

        // Set outputFileTracingRoot if not already set.
        // We use the Next.js project directory (process.cwd()) as the default,
        // which works for both standalone apps and monorepos.
        // In monorepos, users may need to override this to point to the monorepo root.
        if (!nextConfig.outputFileTracingRoot) {
            nextConfig.outputFileTracingRoot = process.cwd()
        }

        // Pre-generate cron wrappers BEFORE the SDK build
        // This ensures the wrapper files exist and can be discovered
        if (
            !process.env.WORKFLOW_NEXT_PRIVATE_BUILT &&
            phase !== "phase-production-server"
        ) {
            console.log("[workflow-cron-start] Pre-generating cron wrappers...")

            try {
                await pregenerateCronWrappers(process.cwd())
            } catch (error) {
                console.error(
                    "[workflow-cron-start] Error pre-generating cron wrappers:",
                    error
                )
            }
        }

        // Set up turbopack rules - add cronStart condition and our loader
        if (!nextConfig.turbopack) {
            nextConfig.turbopack = {}
        }
        if (!nextConfig.turbopack.rules) {
            nextConfig.turbopack.rules = {}
        }

        // Get the next version to check for condition support
        const nextVersion = require("next/package.json").version
        // biome-ignore lint/security/noGlobalEval: Need dynamic import
        const semver = (await eval('import("semver")')).default
        const supportsTurboCondition = semver.gte(nextVersion, "v16.0.0")

        // Configure turbopack rules with our loader
        for (const ext of ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.mts"]) {
            const existingRule = nextConfig.turbopack.rules[ext]
            const existingConditionAny: unknown[] = []
            const existingLoaders: unknown[] = []

            if (existingRule && typeof existingRule === "object") {
                if ("condition" in existingRule) {
                    const condition = (
                        existingRule as { condition?: { any?: unknown[] } }
                    ).condition
                    if (condition && Array.isArray(condition.any)) {
                        existingConditionAny.push(...condition.any)
                    }
                }
                if ("loaders" in existingRule) {
                    const loaders = (existingRule as { loaders?: unknown[] })
                        .loaders
                    if (Array.isArray(loaders)) {
                        existingLoaders.push(...loaders)
                    }
                }
            }

            // Add our loader and cronStart condition
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            nextConfig.turbopack.rules[ext] = {
                ...(supportsTurboCondition
                    ? {
                        condition: {
                            any: [
                                ...existingConditionAny,
                                { content: /cronStart/ },
                                { content: /(use workflow|use step)/ },
                            ],
                        },
                    }
                    : {}),
                loaders: [...existingLoaders, loaderPath],
            } as any
        }

        // Import and call the SDK's withWorkflow
        // We use our pre-generated wrappers but still need the SDK's build
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const workflowNext = require("workflow/next") as {
            withWorkflow: (
                config: NextConfig,
                options?: CronWorkflowOptions
            ) => (
                phase: string,
                ctx: { defaultConfig: NextConfig }
            ) => Promise<NextConfig>
        }

        // Modify the dirs to include our generated wrapper directory
        // The SDK's builder will scan these directories for workflows
        const wrappedConfig = workflowNext.withWorkflow(nextConfig, {
            ...options,
        })

        // Get the final config from the SDK
        const finalConfig = await wrappedConfig(phase, ctx)

        // Ensure our loader runs FIRST (at the end of the array = runs first in chain)
        // The SDK's withWorkflow has added its loader, now we ensure ours is after it
        if (finalConfig.turbopack?.rules) {
            for (const ext of [
                "*.ts",
                "*.tsx",
                "*.js",
                "*.jsx",
                "*.mjs",
                "*.mts",
            ]) {
                const rule = finalConfig.turbopack.rules[ext]
                if (rule && typeof rule === "object" && "loaders" in rule) {
                    const loaders = (rule as { loaders?: unknown[] }).loaders
                    if (Array.isArray(loaders)) {
                        // Make sure our loader is at the end (runs first)
                        const ourLoaderIndex = loaders.indexOf(loaderPath)
                        if (ourLoaderIndex !== -1 && ourLoaderIndex !== loaders.length - 1) {
                            loaders.splice(ourLoaderIndex, 1)
                            loaders.push(loaderPath)
                        } else if (ourLoaderIndex === -1) {
                            loaders.push(loaderPath)
                        }
                    }
                }
            }
        }

        // Also ensure webpack has our loader
        const existingWebpack = finalConfig.webpack
        finalConfig.webpack = (config, webpackOptions) => {
            let modifiedConfig = config
            if (existingWebpack) {
                modifiedConfig = existingWebpack(config, webpackOptions)
            }

            if (!modifiedConfig.module) {
                modifiedConfig.module = {}
            }
            if (!modifiedConfig.module.rules) {
                modifiedConfig.module.rules = []
            }

            // Add our loader at the end (runs first in webpack's chain)
            modifiedConfig.module.rules.push({
                test: /\.(mjs|cjs|cts|mts|ts|tsx|js|jsx)$/,
                loader: loaderPath,
            })

            return modifiedConfig
        }

        return finalConfig
    }
}

export default withCronWorkflow
