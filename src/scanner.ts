/**
 * Scanner module for finding cronStart() calls in source files.
 * 
 * This module scans source files to find cronStart() calls and extracts
 * information about the workflow functions being scheduled.
 */

import { readFile } from "node:fs/promises"
import { relative, dirname, resolve } from "node:path"

/**
 * Information about a cronStart() call found in source code
 */
export interface CronStartCall {
    /** Name of the workflow function being scheduled (e.g., "sendReport") */
    workflowFunctionName: string
    
    /** Import path for the workflow (e.g., "@/lib/workflow" or "./workflow") */
    importPath: string
    
    /** Absolute path to the source file containing the cronStart() call */
    sourceFile: string
}

/**
 * Scan source files for cronStart() calls and extract workflow information.
 * 
 * @param files - Array of absolute file paths to scan
 * @param workingDir - The working directory for resolving relative paths
 * @returns Array of CronStartCall objects describing found calls
 */
export async function scanForCronStartCalls(
    files: string[],
    workingDir: string
): Promise<CronStartCall[]> {
    const calls: CronStartCall[] = []
    
    for (const file of files) {
        try {
            const content = await readFile(file, "utf-8")
            const fileCalls = extractCronStartCallsFromSource(content, file)
            calls.push(...fileCalls)
        } catch (error) {
            // Skip files that can't be read (e.g., binary files, permission issues)
            continue
        }
    }
    
    return deduplicateCalls(calls)
}

/**
 * Extract cronStart() calls from a single source file's content.
 */
function extractCronStartCallsFromSource(
    source: string,
    sourceFile: string
): CronStartCall[] {
    const calls: CronStartCall[] = []
    
    // Quick check - skip if no cronStart
    if (!source.includes("cronStart")) {
        return calls
    }
    
    // Check if this file imports cronStart from our package
    const cronStartImportRegex = /import\s*\{[^}]*cronStart[^}]*\}\s*from\s*["']workflow-cron-start["']/
    if (!cronStartImportRegex.test(source)) {
        return calls
    }
    
    // Find all import statements to build a map of imported identifiers to their sources
    const importMap = buildImportMap(source)
    
    // Find all cronStart() calls and extract the workflow function name
    // Pattern: cronStart(workflowFn, args, options)
    const cronStartPattern = /cronStart\s*\(\s*(\w+)\s*,/g
    
    let match
    while ((match = cronStartPattern.exec(source)) !== null) {
        const workflowFunctionName = match[1]
        
        // Look up the import path for this workflow function
        const importPath = importMap.get(workflowFunctionName)
        
        if (importPath) {
            calls.push({
                workflowFunctionName,
                importPath,
                sourceFile,
            })
        } else {
            // Workflow function is defined in the same file or imported with a different pattern
            // We'll generate a relative import from the wrapper to this file
            calls.push({
                workflowFunctionName,
                importPath: `./${relative(dirname(sourceFile), sourceFile).replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, "")}`,
                sourceFile,
            })
        }
    }
    
    return calls
}

/**
 * Build a map of imported identifiers to their import paths.
 */
function buildImportMap(source: string): Map<string, string> {
    const importMap = new Map<string, string>()
    
    // Match various import patterns:
    // import { foo } from "path"
    // import { foo, bar } from "path"
    // import { foo as bar } from "path"
    // import foo from "path"
    
    // Named imports: import { x, y } from "path"
    const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g
    let match
    
    while ((match = namedImportRegex.exec(source)) !== null) {
        const imports = match[1]
        const importPath = match[2]
        
        // Parse individual imports (handle "as" aliases)
        const importParts = imports.split(",").map(s => s.trim())
        for (const part of importParts) {
            if (!part) continue
            
            // Handle "foo as bar" syntax
            const asMatch = part.match(/(\w+)\s+as\s+(\w+)/)
            if (asMatch) {
                // Use the alias (what's used in code)
                importMap.set(asMatch[2], importPath)
            } else {
                // Simple import
                const cleanName = part.trim()
                if (cleanName) {
                    importMap.set(cleanName, importPath)
                }
            }
        }
    }
    
    // Default imports: import foo from "path"
    const defaultImportRegex = /import\s+(\w+)\s+from\s*["']([^"']+)["']/g
    while ((match = defaultImportRegex.exec(source)) !== null) {
        // Skip if this looks like a named import (has braces)
        const fullMatch = match[0]
        if (fullMatch.includes("{")) continue
        
        const importName = match[1]
        const importPath = match[2]
        importMap.set(importName, importPath)
    }
    
    return importMap
}

/**
 * Remove duplicate calls (same workflow function from same source).
 */
function deduplicateCalls(calls: CronStartCall[]): CronStartCall[] {
    const seen = new Set<string>()
    const result: CronStartCall[] = []
    
    for (const call of calls) {
        // Create a unique key combining workflow name and import path
        const key = `${call.workflowFunctionName}:${call.importPath}`
        
        if (!seen.has(key)) {
            seen.add(key)
            result.push(call)
        }
    }
    
    return result
}

/**
 * Resolve an import path to an absolute file path.
 * Handles relative imports and path aliases.
 */
export function resolveImportPath(
    importPath: string,
    fromFile: string,
    workingDir: string
): string {
    // Handle relative imports
    if (importPath.startsWith(".")) {
        const fromDir = dirname(fromFile)
        return resolve(fromDir, importPath)
    }
    
    // Handle @/ alias (common Next.js pattern)
    if (importPath.startsWith("@/")) {
        // @/ typically maps to src/ or the project root
        const withoutAlias = importPath.slice(2)
        
        // Try src/ first
        const srcPath = resolve(workingDir, "src", withoutAlias)
        const rootPath = resolve(workingDir, withoutAlias)
        
        // We'll return the src path as that's the most common pattern
        // The generator will need to handle file extension resolution
        return srcPath
    }
    
    // For other paths (node_modules, etc.), return as-is
    return importPath
}
