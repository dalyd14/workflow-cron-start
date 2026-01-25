/**
 * Transform module for converting cronStart() calls.
 * 
 * This module transforms cronStart() calls in source files to use
 * the pre-generated wrapper workflows. The transformation:
 * 
 * Before:
 *   import { cronStart } from "workflow-cron-start"
 *   import { myWorkflow } from "./workflow"
 *   await cronStart(myWorkflow, ["arg"], { cron: "* * * * *" })
 * 
 * After:
 *   import { start } from "workflow/api"
 *   import { __cron_myWorkflow__ } from ".workflow-cron/__cron_myWorkflow__"
 *   await start(__cron_myWorkflow__, [{ args: ["arg"], cron: "* * * * *" }])
 */

export interface TransformResult {
    code: string
    transformed: boolean
}

interface CronStartCall {
    workflowName: string
    argsNode: string
    optionsNode: string
    originalCall: string
}

/**
 * Transform cronStart() calls to use generated wrappers.
 * 
 * @param source - The source code to transform
 * @param filename - The source file path (for debugging)
 * @returns The transformed code and whether any transforms were applied
 */
export async function transformCronStartCalls(
    source: string,
    filename: string
): Promise<TransformResult> {
    // Quick check - skip if no cronStart
    if (!source.includes("cronStart")) {
        return { code: source, transformed: false }
    }

    // Check if this file imports cronStart from our package
    const cronStartImportRegex = /import\s*\{[^}]*cronStart[^}]*\}\s*from\s*["']workflow-cron-start["']/
    if (!cronStartImportRegex.test(source)) {
        return { code: source, transformed: false }
    }

    // Find all cronStart calls and extract their info
    const cronStartCalls = extractCronStartCalls(source)
    
    if (cronStartCalls.length === 0) {
        return { code: source, transformed: false }
    }

    // Generate the transformed code
    let transformedSource = source

    // 1. Remove cronStart import and add required imports
    transformedSource = updateImports(transformedSource, cronStartCalls)

    // 2. Replace cronStart calls with start calls using generated wrappers
    transformedSource = replaceCronStartCalls(transformedSource, cronStartCalls)

    return { code: transformedSource, transformed: true }
}

/**
 * Extract all cronStart() calls from the source.
 * 
 * Handles patterns like:
 *   cronStart(myWorkflow, ["arg"], { cron: "* * * * *" })
 *   cronStart(myWorkflow, [arg1, arg2], { cron, timezone: "UTC" })
 */
function extractCronStartCalls(source: string): CronStartCall[] {
    const calls: CronStartCall[] = []
    
    // Match cronStart with balanced brackets/braces
    // This is a simplified pattern that handles common cases
    const cronStartPattern = /cronStart\s*\(\s*(\w+)\s*,\s*(\[[^\]]*\]|\w+)\s*,\s*(\{[^}]*\}|\w+)\s*\)/g
    
    let match
    while ((match = cronStartPattern.exec(source)) !== null) {
        calls.push({
            workflowName: match[1],
            argsNode: match[2],
            optionsNode: match[3],
            originalCall: match[0]
        })
    }

    return calls
}

/**
 * Update imports: remove cronStart, add start and wrapper imports.
 */
function updateImports(source: string, calls: CronStartCall[]): string {
    let result = source

    // Remove cronStart from the import
    // Handle: import { cronStart } from "workflow-cron-start"
    result = result.replace(
        /import\s*\{\s*cronStart\s*\}\s*from\s*["']workflow-cron-start["']\s*;?\n?/g,
        ""
    )

    // Handle: import { cronStart, otherThing } from "workflow-cron-start"
    result = result.replace(
        /import\s*\{([^}]*),\s*cronStart\s*,([^}]*)\}\s*from\s*["']workflow-cron-start["']/g,
        'import {$1,$2} from "workflow-cron-start"'
    )
    result = result.replace(
        /import\s*\{([^}]*),\s*cronStart\s*\}\s*from\s*["']workflow-cron-start["']/g,
        'import {$1} from "workflow-cron-start"'
    )
    result = result.replace(
        /import\s*\{\s*cronStart\s*,([^}]*)\}\s*from\s*["']workflow-cron-start["']/g,
        'import {$1} from "workflow-cron-start"'
    )

    // Clean up empty imports
    result = result.replace(/import\s*\{\s*\}\s*from\s*["']workflow-cron-start["']\s*;?\n?/g, "")

    // Build the new imports we need to add
    const newImports: string[] = []
    
    // Add start import from workflow/api
    newImports.push('import { start } from "workflow/api"')
    
    // Add imports for each unique wrapper
    const seenWrappers = new Set<string>()
    for (const call of calls) {
        const wrapperName = `__cron_${call.workflowName}__`
        if (!seenWrappers.has(wrapperName)) {
            seenWrappers.add(wrapperName)
            // Import from the generated wrapper file in .workflow-cron/
            newImports.push(
                `import { ${wrapperName} } from ".workflow-cron/${wrapperName}"`
            )
        }
    }

    const newImportsStr = newImports.join("\n") + "\n"

    // Find the last import statement and insert after it
    const lastImportMatch = result.match(/^import\s+.+from\s+["'][^"']+["'];?\s*$/gm)
    if (lastImportMatch) {
        const lastImport = lastImportMatch[lastImportMatch.length - 1]
        const lastImportIndex = result.lastIndexOf(lastImport)
        const insertPosition = lastImportIndex + lastImport.length
        result = result.slice(0, insertPosition) + "\n" + newImportsStr + result.slice(insertPosition)
    } else {
        // No imports found, add at the beginning
        result = newImportsStr + result
    }

    return result
}

/**
 * Replace cronStart() calls with start() calls using the wrapper.
 * 
 * Transforms:
 *   cronStart(myWorkflow, ["arg"], { cron: "..." })
 * To:
 *   start(__cron_myWorkflow__, [{ args: ["arg"], cron: "..." }])
 */
function replaceCronStartCalls(source: string, calls: CronStartCall[]): string {
    let result = source

    for (const call of calls) {
        const wrapperName = `__cron_${call.workflowName}__`
        
        // Parse the options object to merge with args
        // The wrapper expects: { args, cron, timezone?, onError? }
        let mergedOptions: string
        
        if (call.optionsNode.startsWith("{")) {
            // It's an object literal - merge args into it
            const optionsContent = call.optionsNode.slice(1, -1).trim()
            mergedOptions = `{ args: ${call.argsNode}, ${optionsContent} }`
        } else {
            // It's a variable - spread it
            mergedOptions = `{ args: ${call.argsNode}, ...${call.optionsNode} }`
        }
        
        const replacement = `start(${wrapperName}, [${mergedOptions}])`
        result = result.replace(call.originalCall, replacement)
    }

    return result
}

/**
 * Transform source code synchronously (for use in CommonJS loader).
 */
export function transformCronStartCallsSync(
    source: string,
    filename: string
): TransformResult {
    // Quick check - skip if no cronStart
    if (!source.includes("cronStart")) {
        return { code: source, transformed: false }
    }

    // Check if this file imports cronStart from our package
    const cronStartImportRegex = /import\s*\{[^}]*cronStart[^}]*\}\s*from\s*["']workflow-cron-start["']/
    if (!cronStartImportRegex.test(source)) {
        return { code: source, transformed: false }
    }

    // Find all cronStart calls and extract their info
    const cronStartCalls = extractCronStartCalls(source)
    
    if (cronStartCalls.length === 0) {
        return { code: source, transformed: false }
    }

    // Generate the transformed code
    let transformedSource = source

    // 1. Remove cronStart import and add required imports
    transformedSource = updateImports(transformedSource, cronStartCalls)

    // 2. Replace cronStart calls with start calls using generated wrappers
    transformedSource = replaceCronStartCalls(transformedSource, cronStartCalls)

    return { code: transformedSource, transformed: true }
}
