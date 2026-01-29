/**
 * Generator module for creating cron wrapper workflow files.
 * 
 * This module generates cron scheduler workflows that:
 * 1. Sleep until the next cron trigger time using cronSleep()
 * 2. Call start() directly from a step to create a new workflow run
 * 
 * This architecture ensures each cron trigger creates a SEPARATE workflow run
 * with its own runId, enabling proper auditing and visibility.
 * 
 * The step calls start() directly (no HTTP request needed) because steps
 * run in Node.js, not the workflow sandbox.
 */

import { mkdir, writeFile, rm } from "node:fs/promises"
import { join, dirname, relative, resolve } from "node:path"
import { existsSync } from "node:fs"
import type { CronStartCall } from "./scanner.js"
import {
    readTsconfigPaths,
    absolutePathToAlias,
    isPathAlias,
    type TsconfigPaths
} from "./scanner.js"

/** 
 * Directory name where generated wrappers are stored.
 * Note: We use "cron-wrappers" without underscore because Next.js
 * treats _folders as private (excluded from routing).
 */
export const CRON_WRAPPER_DIR_NAME = "cron-wrappers"

/**
 * Get the path to the cron wrapper directory.
 * Places it inside src/app/cron-wrappers as a route directory.
 */
export function getCronWrapperDir(workingDir: string): string {
    const srcAppDir = join(workingDir, "src", "app")
    if (existsSync(srcAppDir)) {
        return join(srcAppDir, CRON_WRAPPER_DIR_NAME)
    }

    const appDir = join(workingDir, "app")
    if (existsSync(appDir)) {
        return join(appDir, CRON_WRAPPER_DIR_NAME)
    }

    return join(srcAppDir, CRON_WRAPPER_DIR_NAME)
}

/**
 * Result of generating wrapper files
 */
export interface GeneratorResult {
    /** Absolute paths to all generated workflow files */
    generatedFiles: string[]

    /** Mapping of original workflow names to wrapper function names */
    wrapperMap: Map<string, string>
}

/**
 * Info about a generated wrapper
 */
interface WrapperInfo {
    wrapperName: string       // Function name: __cron__testWorkflow
    triggerDirName: string    // Directory name: trigger-testWorkflow
    workflowFilePath: string  // Path to workflow.ts
}

/**
 * Generate wrapper files for all cronStart() calls.
 * 
 * Creates a directory structure:
 * cron-wrappers/
 *   ├── trigger-myWorkflow/
 *   │   └── workflow.ts   # Cron scheduler workflow with step that calls start()
 *   ├── manifest.json
 *   └── route.ts          # Discovery route for SDK
 * 
 * @param calls - Array of CronStartCall objects from the scanner
 * @param workingDir - The working directory (project root)
 * @returns GeneratorResult with paths to generated files and wrapper mapping
 */
export async function generateWrapperFiles(
    calls: CronStartCall[],
    workingDir: string
): Promise<GeneratorResult> {
    const cronDir = getCronWrapperDir(workingDir)

    // Read tsconfig paths for alias resolution
    const tsconfigPaths = await readTsconfigPaths(workingDir)

    // Clean up previous generated files
    try {
        await rm(cronDir, { recursive: true, force: true })
    } catch {
        // Directory might not exist, that's fine
    }

    // Create the directory
    await mkdir(cronDir, { recursive: true })

    // Write gitignore to exclude generated files from version control
    await writeFile(join(cronDir, ".gitignore"), "*\n")

    const generatedFiles: string[] = []
    const wrapperMap = new Map<string, string>()
    const wrapperInfos: WrapperInfo[] = []

    // Group calls by workflow function name to avoid duplicates
    const uniqueWorkflows = new Map<string, CronStartCall>()
    for (const call of calls) {
        const key = `${call.workflowFunctionName}:${call.importPath}`
        if (!uniqueWorkflows.has(key)) {
            uniqueWorkflows.set(key, call)
        }
    }

    // Generate wrapper directory for each unique workflow
    for (const [, call] of uniqueWorkflows) {
        const result = await generateWrapperDirectory(call, cronDir, workingDir, tsconfigPaths)
        generatedFiles.push(result.workflowFilePath)
        wrapperMap.set(call.workflowFunctionName, result.wrapperName)
        wrapperInfos.push(result)
    }

    // Generate manifest and discovery route
    await generateManifest(wrapperInfos, cronDir)
    await generateDiscoveryRoute(wrapperInfos, cronDir)

    return { generatedFiles, wrapperMap }
}

/**
 * Generate a wrapper directory containing workflow.ts
 */
async function generateWrapperDirectory(
    call: CronStartCall,
    cronDir: string,
    workingDir: string,
    tsconfigPaths: TsconfigPaths
): Promise<WrapperInfo> {
    const { workflowFunctionName, importPath, sourceFile } = call

    const wrapperName = `__cron__${workflowFunctionName}`
    // Use a simpler directory name (no double underscores)
    const triggerDirName = `trigger-${workflowFunctionName}`
    const wrapperDir = join(cronDir, triggerDirName)

    // Create the wrapper subdirectory
    await mkdir(wrapperDir, { recursive: true })

    // Calculate import path for the workflow file
    const workflowFilePath = join(wrapperDir, "workflow.ts")

    const relativeImportPath = calculateRelativeImport(
        workflowFilePath,
        importPath,
        sourceFile,
        workingDir,
        tsconfigPaths
    )

    // Generate cron scheduler workflow (workflow.ts)
    // The step inside will call start() directly on the target workflow
    const workflowContent = generateCronWorkflowContent(
        wrapperName,
        workflowFunctionName,
        relativeImportPath
    )
    await writeFile(workflowFilePath, workflowContent, "utf-8")

    return { wrapperName, triggerDirName, workflowFilePath }
}

/**
 * Calculate the import path for generated files using a hybrid approach:
 * 
 * 1. If original import is an alias (e.g., @/lib/workflow) → preserve it as-is
 * 2. If original import is relative → try to convert to an alias
 * 3. If no alias covers the path → fall back to relative path calculation
 * 
 * This hybrid approach avoids Turbopack path validation issues in monorepos
 * by preferring alias imports over complex relative paths.
 */
function calculateRelativeImport(
    generatedFilePath: string,
    originalImportPath: string,
    sourceFile: string,
    workingDir: string,
    tsconfigPaths: TsconfigPaths
): string {
    const generatedDir = dirname(generatedFilePath)

    // CASE 1: Original import is already an alias - preserve it as-is
    // This avoids converting @/lib/workflow to ../../../lib/workflow
    if (isPathAlias(originalImportPath, tsconfigPaths)) {
        return originalImportPath
    }

    // CASE 2: Relative import - try to convert to an alias first
    if (originalImportPath.startsWith(".")) {
        const sourceDir = dirname(sourceFile)
        const absoluteTarget = resolve(sourceDir, originalImportPath)

        // Try to convert the absolute path to an alias
        const aliasImport = absolutePathToAlias(absoluteTarget, workingDir, tsconfigPaths)
        if (aliasImport) {
            return aliasImport
        }

        // Fall back to calculating relative path from generated file
        let relativePath = relative(generatedDir, absoluteTarget).replace(/\\/g, "/")
        if (!relativePath.startsWith(".")) {
            relativePath = "./" + relativePath
        }
        return relativePath
    }

    // CASE 3: Other imports (bare package names, etc.) - return as-is
    return originalImportPath
}

/**
 * Generate the cron scheduler workflow content (workflow.ts).
 * This workflow sleeps until the next cron trigger, then calls start() directly.
 */
function generateCronWorkflowContent(
    wrapperName: string,
    workflowFunctionName: string,
    importPath: string
): string {
    const triggerStepName = `__trigger_${workflowFunctionName}__`

    return `/**
 * Auto-generated cron scheduler for ${workflowFunctionName}
 * DO NOT EDIT - This file is generated by workflow-cron-start
 * 
 * This workflow runs in an infinite loop:
 * 1. Sleep until the next cron trigger time
 * 2. Call start() directly from a step to create a new workflow run
 * 3. Repeat
 * 
 * Each trigger creates a SEPARATE workflow run with its own runId.
 */

import { cronSleep } from "workflow-cron-sleep"

/**
 * Cron configuration passed to the scheduler workflow
 */
interface CronSchedulerConfig {
    args: unknown[]
    cron: string
    timezone?: string
    onError?: "continue" | "stop"
}

/**
 * Step that starts a new workflow run directly.
 * Steps run in Node.js (not the workflow sandbox), so they can call start().
 */
async function ${triggerStepName}(
    args: unknown[]
): Promise<{ runId: string }> {
    "use step"
    
    // Dynamic imports inside step to avoid sandbox restrictions
    const { start } = await import("workflow/api")
    const { ${workflowFunctionName} } = await import("${importPath}")
    
    // Start a NEW workflow run
    const run = await start(${workflowFunctionName}, args)
    
    console.log(\`[workflow-cron-start] Started ${workflowFunctionName} run: \${run.runId}\`)
    
    return { runId: run.runId }
}

/**
 * Cron scheduler workflow for ${workflowFunctionName}
 * 
 * This workflow runs forever, sleeping until each cron trigger
 * and then starting a new run of the actual workflow.
 */
export async function ${wrapperName}(config: CronSchedulerConfig) {
    "use workflow"
    
    const { args, cron, timezone, onError = "continue" } = config
    
    console.log(\`[workflow-cron-start] Cron scheduler started for ${workflowFunctionName}\`)
    console.log(\`[workflow-cron-start] Schedule: \${cron}, Timezone: \${timezone || "UTC"}\`)
    
    while (true) {
        // Sleep until the next cron trigger
        await cronSleep(cron, { timezone })
        
        try {
            // Start a new workflow run directly from the step
            const result = await ${triggerStepName}(args)
            console.log(\`[workflow-cron-start] Triggered ${workflowFunctionName}: \${result.runId}\`)
        } catch (error) {
            if (onError === "stop") {
                console.error("[workflow-cron-start] Trigger failed, stopping:", error)
                throw error
            }
            console.error("[workflow-cron-start] Trigger failed, continuing:", error)
        }
    }
}
`
}

/**
 * Generate a manifest file mapping workflow names to wrapper info.
 */
async function generateManifest(
    wrapperInfos: WrapperInfo[],
    cronDir: string
): Promise<void> {
    const manifest: Record<string, { wrapperName: string; triggerDir: string }> = {}

    for (const info of wrapperInfos) {
        // Extract the original workflow name from the wrapper name
        const workflowName = info.wrapperName.replace(/^__cron__/, '')
        manifest[workflowName] = {
            wrapperName: info.wrapperName,
            triggerDir: info.triggerDirName
        }
    }

    const manifestPath = join(cronDir, "manifest.json")
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
}

/**
 * Generate the discovery route that imports all workflow files.
 * This ensures the SDK's NextBuilder discovers the cron schedulers.
 */
async function generateDiscoveryRoute(
    wrapperInfos: WrapperInfo[],
    cronDir: string
): Promise<void> {
    const imports: string[] = []
    const exports: string[] = []

    for (const info of wrapperInfos) {
        imports.push(`import { ${info.wrapperName} } from "./${info.triggerDirName}/workflow"`)
        exports.push(info.wrapperName)
    }

    const routeContent = `/**
 * Auto-generated discovery route for workflow-cron-start
 * DO NOT EDIT - This file is generated by workflow-cron-start
 * 
 * This file imports all cron scheduler workflows so the Workflow SDK
 * discovers them during the build phase.
 */

${imports.join("\n")}

// Re-export schedulers for SDK discovery
export { ${exports.join(", ")} }

// Discovery endpoint
export async function GET() {
    return Response.json({
        message: "workflow-cron-start discovery endpoint",
        schedulers: [${exports.map(e => `"${e}"`).join(", ")}]
    })
}
`

    const routePath = join(cronDir, "route.ts")
    await writeFile(routePath, routeContent, "utf-8")
}

/**
 * Get the path to the manifest file.
 */
export function getManifestPath(workingDir: string): string {
    return join(getCronWrapperDir(workingDir), "manifest.json")
}

/**
 * Load the manifest file if it exists.
 */
export async function loadManifest(
    workingDir: string
): Promise<Record<string, { wrapperName: string; triggerDir: string }> | null> {
    const { readFile } = await import("node:fs/promises")
    const manifestPath = getManifestPath(workingDir)

    try {
        const content = await readFile(manifestPath, "utf-8")
        return JSON.parse(content)
    } catch {
        return null
    }
}
