/**
 * Generator module for creating cron wrapper workflow files.
 * 
 * This module generates:
 * 1. A trigger route (route.ts) that calls start() on the actual workflow
 * 2. A cron scheduler workflow (workflow.ts) that uses a step to call the trigger
 * 
 * This architecture ensures each cron trigger creates a SEPARATE workflow run
 * with its own runId, enabling proper auditing and visibility.
 */

import { mkdir, writeFile, rm } from "node:fs/promises"
import { join, dirname, relative } from "node:path"
import { existsSync } from "node:fs"
import type { CronStartCall } from "./scanner.js"

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
 *   │   ├── route.ts      # Trigger endpoint
 *   │   └── workflow.ts   # Cron scheduler workflow
 *   ├── manifest.json
 *   └── route.ts          # Discovery route
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
        const result = await generateWrapperDirectory(call, cronDir, workingDir)
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
 * Generate a wrapper directory containing route.ts and workflow.ts
 */
async function generateWrapperDirectory(
    call: CronStartCall,
    cronDir: string,
    workingDir: string
): Promise<WrapperInfo> {
    const { workflowFunctionName, importPath, sourceFile } = call
    
    const wrapperName = `__cron__${workflowFunctionName}`
    // Use a simpler directory name (no double underscores) for the route
    const triggerDirName = `trigger-${workflowFunctionName}`
    const wrapperDir = join(cronDir, triggerDirName)
    
    // Create the wrapper subdirectory
    await mkdir(wrapperDir, { recursive: true })
    
    // Calculate import paths
    const routeFilePath = join(wrapperDir, "route.ts")
    const workflowFilePath = join(wrapperDir, "workflow.ts")
    
    const relativeImportPath = calculateRelativeImport(
        routeFilePath,
        importPath,
        sourceFile,
        workingDir
    )
    
    // Generate trigger route (route.ts)
    const routeContent = generateTriggerRouteContent(
        workflowFunctionName,
        relativeImportPath
    )
    await writeFile(routeFilePath, routeContent, "utf-8")
    
    // Generate cron scheduler workflow (workflow.ts)
    const workflowContent = generateCronWorkflowContent(
        wrapperName,
        workflowFunctionName,
        triggerDirName
    )
    await writeFile(workflowFilePath, workflowContent, "utf-8")
    
    return { wrapperName, triggerDirName, workflowFilePath }
}

/**
 * Calculate the relative import path from the generated file to the original workflow.
 */
function calculateRelativeImport(
    generatedFilePath: string,
    originalImportPath: string,
    sourceFile: string,
    workingDir: string
): string {
    if (originalImportPath.startsWith(".")) {
        const sourceDir = dirname(sourceFile)
        const absoluteTarget = join(sourceDir, originalImportPath)
        const generatedDir = dirname(generatedFilePath)
        let relativePath = relative(generatedDir, absoluteTarget).replace(/\\/g, "/")
        
        if (!relativePath.startsWith(".")) {
            relativePath = "./" + relativePath
        }
        return relativePath
    }
    
    if (originalImportPath.startsWith("@/")) {
        const pathWithoutAlias = originalImportPath.slice(2)
        const srcPath = join(workingDir, "src", pathWithoutAlias)
        const generatedDir = dirname(generatedFilePath)
        let relativePath = relative(generatedDir, srcPath).replace(/\\/g, "/")
        
        if (!relativePath.startsWith(".")) {
            relativePath = "./" + relativePath
        }
        return relativePath
    }
    
    return originalImportPath
}

/**
 * Generate the trigger route content (route.ts).
 * This endpoint receives HTTP requests and calls start() on the actual workflow.
 */
function generateTriggerRouteContent(
    workflowFunctionName: string,
    importPath: string
): string {
    return `/**
 * Auto-generated trigger route for ${workflowFunctionName}
 * DO NOT EDIT - This file is generated by workflow-cron-start
 * 
 * This endpoint is called by the cron scheduler workflow to start
 * a new run of the actual workflow. Each call creates a separate
 * workflow run with its own runId.
 */

import { start } from "workflow/api"
import { ${workflowFunctionName} } from "${importPath}"

const CRON_TRIGGER_HEADER = "x-workflow-cron-trigger"
const CRON_TRIGGER_SECRET = "workflow-cron-start-internal"

export async function POST(request: Request) {
    // Validate the request is from our cron scheduler
    const triggerHeader = request.headers.get(CRON_TRIGGER_HEADER)
    if (triggerHeader !== CRON_TRIGGER_SECRET) {
        return Response.json(
            { error: "Unauthorized" },
            { status: 401 }
        )
    }
    
    try {
        const { args } = await request.json()
        
        // Start a NEW workflow run
        const run = await start(${workflowFunctionName}, args)
        
        console.log(\`[workflow-cron-start] Started ${workflowFunctionName} run: \${run.runId}\`)
        
        return Response.json({
            runId: run.runId,
            status: "started",
            workflow: "${workflowFunctionName}"
        })
    } catch (error) {
        console.error("[workflow-cron-start] Failed to start workflow:", error)
        return Response.json(
            { error: String(error) },
            { status: 500 }
        )
    }
}

// Return 405 for other methods
export async function GET() {
    return Response.json({ error: "Method not allowed" }, { status: 405 })
}
`
}

/**
 * Generate the cron scheduler workflow content (workflow.ts).
 * This workflow sleeps until the next cron trigger, then calls the trigger endpoint.
 */
function generateCronWorkflowContent(
    wrapperName: string,
    workflowFunctionName: string,
    triggerDirName: string
): string {
    const triggerStepName = `__trigger_${workflowFunctionName}__`
    
    return `/**
 * Auto-generated cron scheduler for ${workflowFunctionName}
 * DO NOT EDIT - This file is generated by workflow-cron-start
 * 
 * This workflow runs in an infinite loop:
 * 1. Sleep until the next cron trigger time
 * 2. Call the trigger endpoint to start a new workflow run
 * 3. Repeat
 * 
 * Each trigger creates a SEPARATE workflow run with its own runId.
 */

import { cronSleep } from "workflow-cron-sleep"

const CRON_TRIGGER_HEADER = "x-workflow-cron-trigger"
const CRON_TRIGGER_SECRET = "workflow-cron-start-internal"

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
 * Step that triggers a new workflow run via HTTP.
 * Steps run in Node.js, so they can make external HTTP requests.
 */
async function ${triggerStepName}(
    triggerUrl: string,
    args: unknown[]
): Promise<{ runId: string; status: string }> {
    "use step"
    
    const response = await fetch(triggerUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            [CRON_TRIGGER_HEADER]: CRON_TRIGGER_SECRET
        },
        body: JSON.stringify({ args })
    })
    
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(\`Trigger failed (\${response.status}): \${errorText}\`)
    }
    
    return response.json()
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
    
    // Construct the trigger URL
    const baseUrl = process.env.VERCEL_URL
        ? \`https://\${process.env.VERCEL_URL}\`
        : \`http://localhost:\${process.env.PORT || 3000}\`
    const triggerUrl = \`\${baseUrl}/cron-wrappers/${triggerDirName}\`
    
    console.log(\`[workflow-cron-start] Cron scheduler started for ${workflowFunctionName}\`)
    console.log(\`[workflow-cron-start] Schedule: \${cron}, Timezone: \${timezone || "UTC"}\`)
    console.log(\`[workflow-cron-start] Trigger URL: \${triggerUrl}\`)
    
    while (true) {
        // Sleep until the next cron trigger
        await cronSleep(cron, { timezone })
        
        try {
            // Trigger a new workflow run
            const result = await ${triggerStepName}(triggerUrl, args)
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
    const manifest: Record<string, { wrapperName: string; triggerPath: string; triggerDir: string }> = {}
    
    for (const info of wrapperInfos) {
        // Extract the original workflow name from the wrapper name
        const workflowName = info.wrapperName.replace(/^__cron__/, '')
        manifest[workflowName] = {
            wrapperName: info.wrapperName,
            triggerDir: info.triggerDirName,
            triggerPath: `/cron-wrappers/${info.triggerDirName}`
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
): Promise<Record<string, { wrapperName: string; triggerPath: string; triggerDir: string }> | null> {
    const { readFile } = await import("node:fs/promises")
    const manifestPath = getManifestPath(workingDir)
    
    try {
        const content = await readFile(manifestPath, "utf-8")
        return JSON.parse(content)
    } catch {
        return null
    }
}
