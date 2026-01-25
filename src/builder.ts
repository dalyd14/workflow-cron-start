/**
 * Custom builder module that extends the Workflow SDK's builder.
 * 
 * This module creates a CronNextBuilder class that:
 * 1. Scans source files for cronStart() calls BEFORE discovery
 * 2. Generates wrapper files with "use workflow" directives
 * 3. Includes those wrappers in the input files for discovery
 * 
 * This ensures cron wrappers are discovered and bundled by the Workflow SDK.
 */

import { join } from "node:path"
import { glob } from "tinyglobby"
import { scanForCronStartCalls } from "./scanner.js"
import { generateWrapperFiles, getCronWrapperDir } from "./generator.js"

/**
 * Builder configuration matching the SDK's BaseBuilder config
 */
export interface CronBuilderConfig {
    /** Whether to watch for file changes */
    watch?: boolean
    
    /** Directories to scan for workflows (relative to workingDir) */
    dirs: string[]
    
    /** Working directory (project root) */
    workingDir: string
    
    /** Build target identifier */
    buildTarget: string
    
    /** Path for workflows bundle (not used in Next.js) */
    workflowsBundlePath?: string
    
    /** Path for steps bundle (not used in Next.js) */
    stepsBundlePath?: string
    
    /** Path for webhook bundle (not used in Next.js) */
    webhookBundlePath?: string
    
    /** Packages to externalize during bundling */
    externalPackages?: string[]
    
    /** Path for workflow manifest output */
    workflowManifestPath?: string
    
    /** Prefix for debug files */
    debugFilePrefix?: string
    
    /** Path for client bundle output */
    clientBundlePath?: string
}

// Cache for the builder class
let CachedCronNextBuilder: new (config: CronBuilderConfig) => {
    build(): Promise<void>
    config: CronBuilderConfig
}

/**
 * Get the CronNextBuilder class.
 * 
 * This dynamically imports the SDK's builder infrastructure and creates
 * an extended class that injects cron wrapper generation.
 * 
 * @returns The CronNextBuilder class constructor
 */
export async function getCronNextBuilder(): Promise<
    new (config: CronBuilderConfig) => {
        build(): Promise<void>
        config: CronBuilderConfig
    }
> {
    if (CachedCronNextBuilder) {
        return CachedCronNextBuilder
    }
    
    // Dynamically import the SDK's builders package
    // We use eval to prevent TypeScript from transpiling to require()
    // biome-ignore lint/security/noGlobalEval: Need to use eval here to avoid TypeScript transpiling
    const builders = (await eval('import("@workflow/builders")')) as {
        BaseBuilder: new (config: CronBuilderConfig) => {
            config: CronBuilderConfig
            findTsConfigPath(): Promise<string | undefined>
            getInputFiles(): Promise<string[]>
            discoverEntries(
                inputs: string[],
                outdir: string
            ): Promise<{
                discoveredSteps: string[]
                discoveredWorkflows: string[]
            }>
            createStepsBundle(options: unknown): Promise<unknown>
            createWorkflowsBundle(options: unknown): Promise<unknown>
            createWebhookBundle(options: unknown): Promise<void>
            createManifest(options: unknown): Promise<void>
            writeDebugFile(outfile: string, data: unknown, merge?: boolean): Promise<void>
        }
        STEP_QUEUE_TRIGGER: unknown
        WORKFLOW_QUEUE_TRIGGER: unknown
    }
    
    // Also need to import the Next.js builder to get its full implementation
    // biome-ignore lint/security/noGlobalEval: Need to use eval here
    const nextBuilder = (await eval('import("@workflow/next/dist/builder.js")')) as {
        getNextBuilder: () => Promise<
            new (config: CronBuilderConfig) => {
                config: CronBuilderConfig
                build(): Promise<void>
                getInputFiles(): Promise<string[]>
            }
        >
    }
    
    // Get the SDK's NextBuilder class
    const NextBuilder = await nextBuilder.getNextBuilder()
    
    /**
     * Extended builder that generates cron wrappers before discovery.
     */
    class CronNextBuilder extends NextBuilder {
        private cronWrapperDir: string | null = null
        private cronWrapperFiles: string[] = []
        
        constructor(config: CronBuilderConfig) {
            super(config)
        }
        
        /**
         * Override build() to generate wrappers before the SDK build.
         */
        async build(): Promise<void> {
            console.log("[workflow-cron-start] Starting cron wrapper generation...")
            
            // Get the input files BEFORE the build to scan for cronStart()
            // We call the parent's getInputFiles to get the base set
            const originalGetInputFiles = Object.getPrototypeOf(
                Object.getPrototypeOf(this)
            ).getInputFiles.bind(this)
            const inputFiles = await originalGetInputFiles()
            
            // Scan for cronStart() calls in all input files
            const cronCalls = await scanForCronStartCalls(
                inputFiles,
                this.config.workingDir
            )
            
            if (cronCalls.length > 0) {
                console.log(
                    `[workflow-cron-start] Found ${cronCalls.length} cronStart() call(s):`,
                    cronCalls.map(c => c.workflowFunctionName).join(", ")
                )
                
                // Generate wrapper files
                const { generatedFiles } = await generateWrapperFiles(
                    cronCalls,
                    this.config.workingDir
                )
                
                this.cronWrapperDir = getCronWrapperDir(this.config.workingDir)
                this.cronWrapperFiles = generatedFiles
                
                console.log(
                    `[workflow-cron-start] Generated ${generatedFiles.length} wrapper file(s)`
                )
            } else {
                console.log("[workflow-cron-start] No cronStart() calls found")
            }
            
            // Now run the original build - our wrappers will be included
            // via the overridden getInputFiles()
            await super.build()
        }
        
        /**
         * Override getInputFiles() to include generated cron wrappers.
         */
        async getInputFiles(): Promise<string[]> {
            // Get the original input files from NextBuilder
            const files = await super.getInputFiles()
            
            // If we have generated wrapper files, include them
            if (this.cronWrapperDir && this.cronWrapperFiles.length > 0) {
                // Get all TypeScript files from the wrapper directory
                const wrapperFiles = await glob(
                    [`${this.cronWrapperDir}/**/*.ts`],
                    {
                        ignore: ["**/manifest.json", "**/.gitignore"],
                        absolute: true,
                    }
                )
                
                console.log(
                    `[workflow-cron-start] Including ${wrapperFiles.length} wrapper file(s) in build`
                )
                
                return [...files, ...wrapperFiles]
            }
            
            return files
        }
    }
    
    CachedCronNextBuilder = CronNextBuilder
    return CronNextBuilder
}

/**
 * Pre-generate cron wrappers without running the full build.
 * 
 * This is useful for ensuring wrappers exist before the SDK build starts,
 * in case the builder override doesn't work correctly.
 * 
 * @param workingDir - The project root directory
 * @param dirs - Directories to scan for source files
 * @returns The generated wrapper file paths
 */
export async function pregenerateCronWrappers(
    workingDir: string,
    dirs: string[] = ["pages", "app", "src/pages", "src/app"]
): Promise<string[]> {
    // biome-ignore lint/security/noGlobalEval: Need to use eval here
    const { glob } = (await eval('import("tinyglobby")')) as {
        glob: (patterns: string[], options?: { ignore?: string[]; absolute?: boolean }) => Promise<string[]>
    }
    
    // Find all source files in the specified directories
    const patterns = dirs.map(dir => {
        const normalizedDir = join(workingDir, dir).replace(/\\/g, "/")
        return `${normalizedDir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`
    })
    
    const files = await glob(patterns, {
        ignore: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.next/**",
            "**/.workflow-cron/**",
            "**/.well-known/workflow/**",
        ],
        absolute: true,
    })
    
    // Scan for cronStart() calls
    const cronCalls = await scanForCronStartCalls(files, workingDir)
    
    if (cronCalls.length === 0) {
        console.log("[workflow-cron-start] No cronStart() calls found during pre-generation")
        return []
    }
    
    // Generate wrapper files
    const { generatedFiles } = await generateWrapperFiles(cronCalls, workingDir)
    
    console.log(
        `[workflow-cron-start] Pre-generated ${generatedFiles.length} wrapper file(s)`
    )
    
    return generatedFiles
}
